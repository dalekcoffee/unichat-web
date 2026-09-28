/* UniChat Web dashboard: unified chat, connection status, side panel (alerts / questions / pins), popups,
   viewer cards, sounds and text-to-speech. Shared with the desktop app; the feed comes from hub.js. */
(function () {
  'use strict';
  // The chat page never runs inside another site's frame (overlay.html is the page meant for embedding).
  if (window.top !== window.self) {
    document.body.textContent = 'Open UniChat directly. To embed it, use the overlay link from Settings.';
    return;
  }
  const U = window.UniChat;
  const $ = s => document.querySelector(s);

  // Links to Settings keep the channels/options from this page's address (bookmarked links), and open Settings in its
  // own tab so this page stays connected and keeps its chat. Saved changes reach this page right away.
  function linkSettings() {
    document.querySelectorAll('a[data-keep-config]').forEach(a => {
      a.dataset.base = a.dataset.base || a.getAttribute('href');
      a.href = a.dataset.base + location.search + location.hash;
      a.target = 'unichat-settings';
    });
  }
  linkSettings();
  // A page opened from a link keeps that link's settings over the saved ones. When Settings (opened from this page's
  // link) saves, it sends the new link, and this page switches its address to it: no reload, nothing lost.
  if ('BroadcastChannel' in window) {
    new BroadcastChannel('unichat').addEventListener('message', ev => {
      const m = ev.data || {};
      if (m.type !== 'relink' || typeof m.from !== 'string' || typeof m.to !== 'string') return;
      if (m.from !== location.search + location.hash || m.to.length > 8000 || !/^(\?[^#\s]*)?(#\S*)?$/.test(m.to)) return;
      try { history.replaceState(null, '', location.pathname + m.to); } catch { return; }
      linkSettings();
      window.UniChatHub.reloadSettings();
    });
  }

  const feed = $('#feed');
  const empty = $('#empty');
  const jump = $('#jump');
  const pillsEl = $('#pills');
  const bannersEl = $('#banners');
  const soundBtn = $('#soundBtn');
  const alertsBtn = $('#alertsBtn');
  const alertsPanel = $('#alertsPanel');
  const panelList = $('#alertsList');
  const alertCount = $('#alertCount');
  const popupLayer = $('#popupLayer');
  const popupEl = $('#popup');
  const stopSpeech = $('#stopSpeech');
  const viewerLayer = $('#viewerLayer');
  const viewerCard = $('#viewerCard');
  const mainEl = $('#main');
  const splitter = $('#splitter');
  const splitHandle = $('#splitHandle');
  const splitGrip = $('#splitGrip');
  const splitFlip = $('#splitFlip');

  let settings = null;
  let statuses = [];
  let serverDown = null;
  let unseen = 0;
  let theme = 'dark';
  let conn = null;

  // Chat model: kept so filter/highlight/theme changes can re-render instantly.
  let events = [];
  // Side-panel models (sent separately by the server so busy chat can't push them out).
  let alerts = [];
  let questions = [];
  let pins = [];
  const done = new Map();      // id → when the alert was thanked / the question answered (shared across screens)

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  const savedHidden = store.get('unichat.hiddenPlatforms', []);
  const hidden = new Set(Array.isArray(savedHidden) ? savedHidden.filter(p => U.PLATFORMS.includes(p)) : []);
  let soundOn = store.get('unichat.sound', true) !== false;
  let panelOpen = store.get('unichat.alertsPanel', true) !== false;
  let panelTab = store.get('unichat.panelTab', 'alerts');
  if (!['alerts', 'questions', 'pins', 'recap'].includes(panelTab)) panelTab = 'alerts';

  const isAlert = e => U.ALERT_KINDS.includes(e.kind);
  const maxMessages = () => (settings && settings.display && settings.display.maxMessages) || 300;
  const byId = id => `[data-id="${CSS.escape(id)}"]`;

  /** Same rule the server uses to collect questions. */
  function isQuestion(e) {
    if (e.kind !== 'chat' || e.historical || e.code === 'test' || (e.user && (e.user.roles || []).includes('broadcaster'))) return false;
    const text = (e.parts || []).filter(p => p.t === 'text').map(p => p.v).join('').trim();
    return text.length >= 8 && text.includes('?') && !text.startsWith('!');
  }

  // ---------- Settings ----------
  function applySettings(s) {
    settings = s;
    const d = s.display || {};
    theme = d.theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.setProperty('--fs', (d.fontSize || 16) + 'px');
    document.body.classList.toggle('no-ts', !d.showTimestamps);
    document.body.classList.toggle('no-pf', !d.showPlatformIcons);
    document.body.classList.toggle('no-badges', !d.showBadges);
    document.body.classList.toggle('no-avatars', !d.showAvatars);
    document.body.classList.toggle('no-platform-colors', d.platformColors === false);
    applyLayout();
    updateWakeLock();
  }

  // ---------- Feed ----------
  const nearBottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
  const scrollToBottom = () => { feed.scrollTop = feed.scrollHeight; };

  /** The element to show for an event, or null if filters / settings hide it. */
  function feedElement(e, cls) {
    if (isAlert(e) && settings && settings.display && settings.display.alertsInChat === false) return null;
    if (cls.hidden) return null;
    const el = U.renderEvent(e, theme, cls);
    if (e.kind !== 'system' && hidden.has(e.platform)) el.classList.add('hidden');
    if (pins.some(p => p.id === e.id)) el.classList.add('pinned');
    return el;
  }

  function add(e, live) {
    events.push(e);
    if (events.length > maxMessages()) events.splice(0, events.length - maxMessages());
    if (live && isAlert(e)) addToPanelList(alerts, e, 'alerts');
    if (live && isQuestion(e)) addToPanelList(questions, e, 'questions');

    const cls = U.classify(e, settings);
    const el = feedElement(e, cls);
    if (el) queueLine(el, live);

    if (!live || cls.hidden) return;
    if (soundOn) U.Sound.forEvent(e, settings, cls);
    maybePopup(e);
    if (soundOn && U.Sound.unlocked()) U.Speech.forEvent(e, settings, cls);
  }

  // New lines join the chat in batches, once per screen frame: a flood of messages (e.g. a bot raid) then costs one
  // layout per frame instead of one per message, and lines that would scroll out of the kept history straight away are
  // never drawn. Anything that changes lines already shown (delete, clear, pins, hiding a platform) adds the waiting
  // batch first (flushLines), so it sees every line.
  let pendingLines = [];
  let flushQueued = false;
  function queueLine(el, live) {
    pendingLines.push({ el, live });
    if (pendingLines.length > maxMessages()) pendingLines.splice(0, pendingLines.length - maxMessages());
    if (flushQueued) return;
    flushQueued = true;
    // Animation frames pause in a background tab; a short timer keeps a hidden chat current.
    if (document.hidden) setTimeout(flushLines, 250); else requestAnimationFrame(flushLines);
  }
  function flushLines() {
    flushQueued = false;
    if (!pendingLines.length) return;
    const batch = pendingLines;
    pendingLines = [];
    const stick = followNewest || nearBottom();
    const frag = document.createDocumentFragment();
    let fresh = 0;
    for (const { el, live } of batch) {
      frag.appendChild(el);
      if (live && !el.classList.contains('hidden')) fresh++;
    }
    empty.classList.add('hidden');
    feed.appendChild(frag);
    trim();
    if (stick) scrollToBottom();
    else if (fresh) {
      unseen += fresh;
      jump.textContent = `↓ ${unseen} new message${unseen === 1 ? '' : 's'}`;
      jump.classList.remove('hidden');
    }
  }

  function trim() {
    const msgs = feed.getElementsByClassName('msg');
    let extra = msgs.length - maxMessages();
    if (extra <= 0) return;
    // Keep the reading position steady when old messages drop off while you're scrolled up.
    const keep = !(followNewest || nearBottom());
    let removed = 0;
    while (extra-- > 0) { removed += msgs[0].offsetHeight; msgs[0].remove(); }
    if (keep) feed.scrollTop -= removed;
  }

  function rerenderFeed() {
    pendingLines = []; // redrawn below from `events`, which already has them
    Array.from(feed.getElementsByClassName('msg')).forEach(m => m.remove());
    const frag = document.createDocumentFragment();
    for (const e of events) {
      const el = feedElement(e, U.classify(e, settings));
      if (el) frag.appendChild(el);
    }
    feed.appendChild(frag);
    empty.classList.toggle('hidden', feed.getElementsByClassName('msg').length > 0);
    trim();
    scrollToBottom();
  }

  // Remember whether you're reading the newest messages, so a resize (panel opened, window resized, phone
  // rotated) keeps them in view instead of leaving the latest lines cut off below the fold.
  // Only your own scrolling (wheel, touch, scrollbar, keys) stops the feed following new messages; layout
  // shifts from resizing never do.
  let followNewest = true;
  let userScrollAt = 0;
  const userScrolling = () => { userScrollAt = Date.now(); };
  ['wheel', 'touchmove', 'pointerdown'].forEach(t => feed.addEventListener(t, userScrolling, { passive: true }));
  document.addEventListener('keydown', userScrolling, { passive: true });
  feed.addEventListener('scroll', () => {
    if (nearBottom()) { followNewest = true; unseen = 0; jump.classList.add('hidden'); }
    else if (Date.now() - userScrollAt < 1500) followNewest = false;
  }, { passive: true });
  if ('ResizeObserver' in window) new ResizeObserver(() => { if (followNewest) scrollToBottom(); }).observe(feed);
  jump.addEventListener('click', () => { scrollToBottom(); unseen = 0; jump.classList.add('hidden'); });

  /** A line leaving the chat: it folds away when it's on screen; off screen it just goes, keeping your reading position. */
  function removeLine(el) {
    const r = el.getBoundingClientRect();
    const f = feed.getBoundingClientRect();
    const done = () => { el.remove(); empty.classList.toggle('hidden', feed.getElementsByClassName('msg').length > 0); };
    if (r.bottom <= f.top || r.top >= f.bottom || !el.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const above = r.bottom <= f.top;
      done();
      if (above) feed.scrollTop -= r.height;
      return;
    }
    const cs = getComputedStyle(el);
    el.style.pointerEvents = 'none';
    el.animate([
      { opacity: 1, height: `${r.height}px`, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, marginTop: cs.marginTop, marginBottom: cs.marginBottom },
      { opacity: 0, height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px' },
    ], { duration: 300, easing: 'ease-in-out' }).onfinish = done;
  }

  // Clicks inside the feed: dismiss and pin buttons, reply jumps, names (viewer card).
  document.addEventListener('click', e => {
    const xBtn = e.target.closest('#feed .msg .x-btn');
    if (xBtn) {
      if (conn) conn.send({ type: 'remove', ids: [xBtn.closest('.msg').dataset.id] });
      return;
    }
    const pinBtn = e.target.closest('.msg .pin-btn');
    if (pinBtn) {
      const id = pinBtn.closest('.msg').dataset.id;
      if (conn) conn.send({ type: pins.some(p => p.id === id) ? 'unpin' : 'pin', id });
      return;
    }
    const reply = e.target.closest('.msg .reply[data-reply-to]');
    if (reply) {
      const target = feed.querySelector(`.msg${byId(reply.dataset.replyTo)}`);
      if (target) {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target.classList.remove('flash');
        void target.offsetWidth; // restart the animation
        target.classList.add('flash');
      }
      return;
    }
    const name = e.target.closest('.name[data-viewer]');
    if (name) { openViewerCard(name.dataset.platform, name.dataset.login); return; }
    // Touch screens have no hover: tapping a message shows its 📌 and ✕ buttons.
    const msg = e.target.closest('#feed .msg');
    if (msg) {
      feed.querySelectorAll('.msg.tapped').forEach(m => { if (m !== msg) m.classList.remove('tapped'); });
      msg.classList.toggle('tapped');
    }
  });

  // ---------- Side panel: alerts / questions / pins ----------
  const PANEL_EMPTY = {
    alerts: 'Follows, donations, subs, raids and redemptions collect here so you can thank people.',
    questions: 'Chat messages with a question mark collect here. Tick them off as you answer.',
    pins: 'Hover a message and click 📌 to keep it here for later.',
  };

  const TICK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';
  const CROSS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4l5.6 5.6L5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z"/></svg>';

  function panelItem(e, tab) {
    const el = document.createElement('div');
    const kind = isAlert(e) ? e.kind : 'chat';
    el.className = `ap-item k-${kind}`;
    el.dataset.id = e.id;
    const label = isAlert(e) ? `${U.KIND_EMOJI[e.kind] || ''} ${U.esc(U.KIND_LABEL[e.kind] || e.kind)}` : (tab === 'questions' ? '❓ Question' : '💬 Chat');
    const body = U.partsHtml(U.shownParts(e, U.classify(e, settings)));
    const action = tab === 'pins'
      ? `<button class="ap-unpin" type="button" title="Unpin" aria-label="Unpin">${CROSS_ICON}</button>`
      : `<button class="ap-check" type="button">${TICK_ICON}</button>`;
    el.innerHTML =
      `<div class="body">
        <div class="meta">${U.icon(e.platform)}<span>${label}</span><span>${U.fmtTime(e.ts)}</span>${e.code === 'test' ? '<span class="chip">TEST</span>' : ''}${e.amount ? `<span class="amount">${U.esc(e.amount)}</span>` : ''}</div>
        <div>${U.nameHtml(e.user, theme, e.kind === 'hype' ? null : e.platform)} ${U.esc(e.title || '')}</div>${body ? `<div class="msgtext">${body}</div>` : ''}
      </div>${action}`;
    if (tab !== 'pins') paintDone(el, tab);
    return el;
  }

  const clearDoneAfterSec = () => Math.max(0, Number(settings && settings.display && settings.display.removeDoneAfterSec) || 0);

  /** Tick state of a panel item. A ticked item leaves the panel after the time set in Settings; the line along its bottom shows the time left. */
  function paintDone(el, tab) {
    const id = el.dataset.id;
    const isDone = done.has(id);
    const ttl = clearDoneAfterSec();
    el.classList.toggle('done', isDone);
    el.classList.toggle('expiring', isDone && ttl > 0);
    if (isDone && ttl > 0) {
      el.style.setProperty('--ttl', `${ttl}s`);
      el.style.setProperty('--ttl-delay', `-${Math.min(ttl, Math.max(0, (Date.now() - done.get(id)) / 1000)).toFixed(1)}s`);
    }
    const btn = el.querySelector('.ap-check');
    if (!btn) return;
    const what = tab === 'alerts' ? 'thanked' : 'answered';
    btn.title = isDone ? `Marked as ${what}. Click to undo` : `Mark as ${what}`;
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', String(isDone));
  }

  function listFor(tab) { return tab === 'alerts' ? alerts : tab === 'questions' ? questions : pins; }

  function renderPanel() {
    document.querySelectorAll('.panel-tabs [data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === panelTab));
    $('#ackAll').classList.toggle('hidden', panelTab === 'recap');
    if (panelTab === 'recap') { renderRecap(); updateCounts(); return; }
    const list =listFor(panelTab).filter(e => panelTab !== 'questions' || !U.classify(e, settings).hidden);
    panelList.innerHTML = list.length ? '' : `<div class="none">${PANEL_EMPTY[panelTab]}</div>`;
    const frag = document.createDocumentFragment();
    for (let i = list.length - 1; i >= 0; i--) frag.appendChild(panelItem(list[i], panelTab));
    panelList.appendChild(frag);
    $('#ackAll').textContent = panelTab === 'pins' ? '✕ All' : '✓ All';
    $('#ackAll').title = panelTab === 'pins' ? 'Unpin everything' : panelTab === 'alerts' ? 'Mark every alert as thanked' : 'Mark every question as answered';
    updateCounts();
  }

  function addToPanelList(list, e, tab) {
    list.push(e);
    if (list.length > 200) list.shift();
    if (tab === panelTab && !(tab === 'questions' && U.classify(e, settings).hidden)) {
      const placeholder = panelList.querySelector('.none');
      if (placeholder) placeholder.remove();
      panelList.prepend(panelItem(e, tab));
      while (panelList.children.length > 200) panelList.lastElementChild.remove();
    }
    updateCounts();
  }

  function markDone(ids, at) {
    ids.forEach(id => {
      if (done.has(id)) return;
      done.set(id, at || Date.now());
      const el = panelTab !== 'pins' && panelList.querySelector(`.ap-item${byId(id)}`);
      if (el) paintDone(el, panelTab);
    });
    updateCounts();
  }

  function unmarkDone(ids) {
    ids.forEach(id => {
      if (!done.delete(id)) return;
      const el = panelTab !== 'pins' && panelList.querySelector(`.ap-item${byId(id)}`);
      if (el) paintDone(el, panelTab);
    });
    updateCounts();
  }

  /** Items whose time is up leave the panel (they stay in the chat). */
  function dismiss(ids) {
    const gone = new Set(ids);
    alerts = alerts.filter(e => !gone.has(e.id));
    questions = questions.filter(e => !gone.has(e.id));
    gone.forEach(id => {
      done.delete(id);
      const el = panelTab !== 'pins' && panelList.querySelector(`.ap-item${byId(id)}`);
      if (el) fadeAway(el);
    });
    updateCounts();
  }

  function fadeAway(el) {
    const finish = () => {
      el.remove();
      if (!panelList.querySelector('.ap-item')) panelList.innerHTML = `<div class="none">${PANEL_EMPTY[panelTab]}</div>`;
    };
    if (!el.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) { finish(); return; }
    const cs = getComputedStyle(el);
    el.style.pointerEvents = 'none';
    el.animate([
      { opacity: cs.opacity, height: `${el.offsetHeight}px`, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, marginBottom: cs.marginBottom },
      { opacity: 0, height: '0px', paddingTop: '0px', paddingBottom: '0px', marginBottom: '0px' },
    ], { duration: 400, easing: 'ease-in-out' }).onfinish = finish;
  }

  function updateCounts() {
    const open = {
      alerts: alerts.filter(a => !done.has(a.id)).length,
      questions: questions.filter(q => !done.has(q.id) && !U.classify(q, settings).hidden).length,
      pins: pins.length,
    };
    for (const [tab, n] of Object.entries(open)) {
      const badge = document.querySelector(`[data-count="${tab}"]`);
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.classList.toggle('zero', n === 0);
    }
    const total = open.alerts + open.questions;
    alertCount.textContent = total > 99 ? '99+' : String(total);
    alertCount.classList.toggle('zero', total === 0);
  }

  function setPins(list) {
    pins = list || [];
    const ids = new Set(pins.map(p => p.id));
    feed.querySelectorAll('.msg').forEach(m => m.classList.toggle('pinned', ids.has(m.dataset.id)));
    if (panelTab === 'pins') renderPanel(); else updateCounts();
  }

  panelList.addEventListener('click', e => {
    const item = e.target.closest('.ap-item');
    if (!item) return;
    const id = item.dataset.id;
    if (e.target.closest('.ap-unpin')) { if (conn) conn.send({ type: 'unpin', id }); return; }
    if (e.target.closest('.ap-check')) {
      const undo = done.has(id);               // a second click takes the tick back
      if (undo) unmarkDone([id]); else markDone([id]);          // instant here…
      if (conn) conn.send({ type: undo ? 'unack' : 'ack', ids: [id] }); // …and on every other screen
      return;
    }
    const name = e.target.closest('.name[data-viewer]');
    if (name) openViewerCard(name.dataset.platform, name.dataset.login);
  });

  // ---------- Recap tab: this stream's supporters, followers and raids, for thanking people ----------
  const MONEY_LIKE = ['bits', 'coins', 'KICKs', 'diamonds'];
  const unitText = (unit, v) => (MONEY_LIKE.includes(unit) ? `${Math.round(v).toLocaleString()} ${unit}` : U.fmtMoney(unit === 'money' ? '' : unit, v));
  const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

  /** The recap grouped per person: { start, chips, supporters, followers, raids }. */
  function summarizeRecap(r) {
    const items = r.items;
    const money = new Map();
    let subs = 0, gifted = 0, tips = 0, redemptions = 0;
    const people = new Map();
    const followers = new Map();
    const raids = [];
    for (const i of items) {
      const key = `${i.platform}:${i.login || String(i.name).toLowerCase()}`;
      if (i.kind === 'follow') { if (!followers.has(key)) followers.set(key, i); continue; }
      if (i.kind === 'raid') { raids.push(i); continue; }
      if (i.kind === 'redemption') { redemptions++; continue; }
      let p = people.get(key);
      if (!p) people.set(key, p = { platform: i.platform, name: i.name, subs: 0, gifts: 0, money: new Map(), tips: [], actions: 0, last: 0 });
      p.actions++;
      p.last = Math.max(p.last, i.ts);
      if (i.kind === 'sub' && i.unit === 'gifts') { const n = Math.max(1, i.value || 1); p.gifts += n; gifted += n; }
      else if (i.kind === 'sub') { p.subs++; subs++; }
      else if (i.value > 0 && i.unit) { p.money.set(i.unit, (p.money.get(i.unit) || 0) + i.value); money.set(i.unit, (money.get(i.unit) || 0) + i.value); }
      else { p.tips.push(i.amount); tips++; }
    }
    const supporters = [...people.values()].sort((a, b) => b.actions - a.actions || b.last - a.last).map(p => ({
      platform: p.platform, name: p.name,
      what: [p.subs ? (p.subs > 1 ? plural(p.subs, 'sub') : 'subbed') : '', p.gifts ? `gifted ${plural(p.gifts, 'sub')}` : '',
        ...[...p.money].map(([u, v]) => unitText(u, v)), ...p.tips.map(a => (a ? `a ${a} tip` : 'a tip'))].filter(Boolean).join(', '),
    }));
    const chips = [
      followers.size ? `💙 ${plural(followers.size, 'follow')}` : '',
      subs ? `⭐ ${plural(subs, 'sub')}` : '',
      gifted ? `🎁 ${plural(gifted, 'gifted sub')}` : '',
      ...[...money].map(([u, v]) => `💰 ${unitText(u, v)}`),
      tips ? `💰 ${plural(tips, 'tip')}` : '',
      raids.length ? `🚀 ${plural(raids.length, 'raid')}` : '',
      redemptions ? `🎟️ ${plural(redemptions, 'redemption')}` : '',
    ].filter(Boolean);
    return { start: r.startedAt, chips, supporters, followers: [...followers.values()], raids };
  }

  function recapText(sum) {
    const lines = [`Stream recap, ${U.fmtTime(sum.start)} to ${U.fmtTime(Date.now())}`];
    if (sum.supporters.length) lines.push('Thank you for the support: ' + sum.supporters.map(p => `${p.name} (${p.what})`).join(', '));
    if (sum.followers.length) lines.push('Welcome, new followers: ' + sum.followers.map(f => f.name).join(', '));
    if (sum.raids.length) lines.push('Thanks for the raid: ' + sum.raids.map(r => (r.value ? `${r.name} (${plural(r.value, 'viewer')})` : r.name)).join(', '));
    if (lines.length === 1) lines.push('No follows, subs, gifts or raids yet.');
    return lines.join('\n');
  }

  function renderRecap() {
    const sum = summarizeRecap(window.UniChatHub.recap());
    const who = (platform, name) => `<span class="rc-name">${U.icon(platform)}${U.esc(name)}</span>`;
    const section = (title, n, body) => (n ? `<h4>${U.esc(title)} <span class="muted">${n}</span></h4>${body}` : '');
    const empty = !sum.chips.length;
    panelList.innerHTML =
      `<div class="recap">
        <div class="rc-head"><b>Since ${U.esc(U.fmtTime(sum.start))}</b> <span class="muted">· ${U.esc(U.fmtDuration(Date.now() - sum.start))}</span></div>
        ${empty ? '<div class="none">Follows, subs, gifts, tips and raids from this stream collect here, so you can thank everyone at the end. A new recap starts by itself when you go live.</div>'
          : `<div class="rc-chips">${sum.chips.map(c => `<span class="stat">${U.esc(c)}</span>`).join('')}</div>`}
        ${section('Supporters', sum.supporters.length, `<div class="rc-list">${sum.supporters.map(p => `<div class="rc-row">${who(p.platform, p.name)}<span class="rc-what">${U.esc(p.what)}</span></div>`).join('')}</div>`)}
        ${section('New followers', sum.followers.length, `<div class="rc-names">${sum.followers.map(f => who(f.platform, f.name)).join('')}</div>`)}
        ${section('Raids', sum.raids.length, `<div class="rc-list">${sum.raids.map(r => `<div class="rc-row">${who(r.platform, r.name)}<span class="rc-what">${r.value ? U.esc(plural(r.value, 'viewer')) : ''}</span></div>`).join('')}</div>`)}
        <div class="rc-actions">
          <button class="btn small" type="button" id="rcCopy" ${empty ? 'disabled' : ''} title="Copy a thank-you list to paste into chat or your notes">📋 Copy thank-yous</button>
          <button class="btn small" type="button" id="rcReset" title="Empty the recap and start counting from now">New recap</button>
        </div>
      </div>`;
    $('#rcCopy').addEventListener('click', () => copyText(recapText(sum)).then(() => showToast('Thank-you list copied'), () => showToast("Couldn't copy here")));
    $('#rcReset').addEventListener('click', () => {
      if (conn && confirm('Start a new recap? The current one is cleared (the Alerts panel keeps its alerts).')) conn.send({ type: 'recapReset' });
    });
  }
  setInterval(() => { if (panelTab === 'recap' && panelOpen) renderRecap(); }, 60000); // "· 1h 23m"

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok ? Promise.resolve() : Promise.reject(new Error('copy failed'));
  }

  $('#ackAll').addEventListener('click', () => {
    if (!conn || panelTab === 'recap') return;
    if (panelTab === 'pins') { pins.forEach(p => conn.send({ type: 'unpin', id: p.id })); return; }
    const ids = listFor(panelTab).map(x => x.id).filter(id => !done.has(id));
    markDone(ids);
    if (ids.length) conn.send({ type: 'ack', ids });
  });

  document.querySelectorAll('.panel-tabs [data-tab]').forEach(b => b.addEventListener('click', () => {
    panelTab = b.dataset.tab;
    store.set('unichat.panelTab', panelTab);
    renderPanel();
  }));

  function renderPanelToggle() {
    alertsPanel.classList.toggle('hidden', !panelOpen);
    splitter.classList.toggle('hidden', !panelOpen);
    splitHandle.classList.toggle('hidden', !panelOpen);
    alertsBtn.classList.toggle('active', panelOpen);
    alertsBtn.setAttribute('aria-expanded', String(panelOpen));
  }
  alertsBtn.addEventListener('click', () => {
    panelOpen = !panelOpen;
    store.set('unichat.alertsPanel', panelOpen);
    renderPanelToggle();
  });
  renderPanelToggle();

  // ---------- Layout: alerts panel right of the chat, or above it on narrow / portrait screens ----------
  const CHAT_MIN = 380;                              // narrowest comfortable chat column (px): below this + PANEL_MIN_W, stack
  // Resizing stops at the same size on both sides of the line (panel or chat), so flipping sides never moves the line.
  const PANEL_MIN_W = 240;                           // narrowest column beside the line (px)
  const PANEL_MIN_H = 110;                           // shortest row above / below the line (px; also in style.css)
  const SPLIT_DEFAULT = { side: 0.2, stacked: 0.2 }; // the panel's share of the width (beside) / height (above)
  const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Number(v) : lo));
  let split = Object.assign({}, SPLIT_DEFAULT, store.get('unichat.web.panelSplit', {}));
  let stacked = false;
  try { localStorage.removeItem('unichat.web.panelSize'); } catch { /* older size format, no longer used */ }
  // The ⇄ half of the divider's handle flips the layout in use: side by side the panel moves left of the chat, stacked
  // it moves below it. Each layout keeps its own choice, saved on this device (not in links), like the divider position.
  const savedFlip = store.get('unichat.web.panelFlip', null) || {};
  const flip = { side: savedFlip.side === true, stacked: savedFlip.stacked === true };

  function applyLayout() {
    const mode = (settings && settings.display && settings.display.panelLayout) || 'auto';
    const w = window.innerWidth;
    const h = window.innerHeight;
    // Automatic: above the chat when there isn't room for both side by side, or on a tall (portrait) screen.
    stacked = mode === 'stacked' || (mode === 'auto' && (w < CHAT_MIN + PANEL_MIN_W || h > w * 1.15));
    document.body.classList.toggle('stacked', stacked);
    document.body.classList.toggle('panel-flipped', stacked ? flip.stacked : flip.side);
    const mw = mainEl.clientWidth || w;
    const mh = mainEl.clientHeight || h;
    // The line itself is 1px. Same limits as the CSS, so --panel-w / --panel-h are the panel's real size (the handle is
    // placed with them).
    const width = Math.round(clampNum(split.side * mw, PANEL_MIN_W, Math.max(PANEL_MIN_W, mw - 1 - PANEL_MIN_W)));
    const height = Math.round(clampNum(split.stacked * mh, PANEL_MIN_H, Math.max(PANEL_MIN_H, mh - 1 - PANEL_MIN_H)));
    mainEl.style.setProperty('--panel-w', width + 'px');
    mainEl.style.setProperty('--panel-h', height + 'px');
    splitter.setAttribute('aria-orientation', stacked ? 'horizontal' : 'vertical');
    splitter.setAttribute('aria-valuenow', String(Math.round(stacked ? height / Math.max(1, mh) * 100 : width / Math.max(1, mw) * 100)));
    splitter.title = 'Drag to resize the panel · double-click to reset';
    const flipLabel = stacked ? (flip.stacked ? 'Move the alerts above the chat' : 'Move the alerts below the chat')
      : (flip.side ? 'Move the alerts to the right of the chat' : 'Move the alerts to the left of the chat');
    splitFlip.title = flipLabel;
    splitFlip.setAttribute('aria-label', flipLabel);
  }

  function saveSplit() { store.set('unichat.web.panelSplit', split); }

  // Flipping keeps the dividing line (and the handle under your pointer) where it is: the panel and the chat swap
  // places, each taking over the other's space.
  splitFlip.addEventListener('click', () => {
    if (stacked) {
      const mh = mainEl.clientHeight;
      if (mh) split.stacked = (mh - 1 - alertsPanel.offsetHeight) / mh;
      flip.stacked = !flip.stacked;
    } else {
      const mw = mainEl.clientWidth;
      if (mw) split.side = (mw - 1 - alertsPanel.offsetWidth) / mw;
      flip.side = !flip.side;
    }
    store.set('unichat.web.panelFlip', flip);
    saveSplit();
    applyLayout();
  });

  // Drag the line or the handle's grip. The line moves as far as the pointer does (no jump to the pointer when you
  // grab the grip beside the line).
  function startResize(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const from = stacked ? e.clientY : e.clientX;
    const size = stacked ? alertsPanel.offsetHeight : alertsPanel.offsetWidth;
    // Moving the pointer right / down grows a panel on the left / top and shrinks one on the right / bottom.
    const sign = stacked ? (flip.stacked ? -1 : 1) : (flip.side ? 1 : -1);
    const move = ev => {
      const r = mainEl.getBoundingClientRect();
      const px = size + sign * ((stacked ? ev.clientY : ev.clientX) - from);
      if (stacked) split.stacked = clampNum(px / r.height, PANEL_MIN_H / r.height, Math.max(PANEL_MIN_H, r.height - 1 - PANEL_MIN_H) / r.height);
      else split.side = clampNum(px / r.width, PANEL_MIN_W / r.width, Math.max(PANEL_MIN_W, r.width - 1 - PANEL_MIN_W) / r.width);
      applyLayout();
    };
    const end = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      document.body.classList.remove('resizing');
      saveSplit();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }
  const resetSplit = () => { split = Object.assign({}, SPLIT_DEFAULT); saveSplit(); applyLayout(); };
  [splitter, splitGrip].forEach(el => {
    el.addEventListener('pointerdown', startResize);
    el.addEventListener('dblclick', resetSplit);
  });
  splitter.addEventListener('keydown', e => {
    const step = (e.shiftKey ? 3 : 1) * 0.02;
    // Start from the panel's actual size (it may be held at its minimum), so every key press visibly changes it.
    const now = stacked ? alertsPanel.offsetHeight / Math.max(1, mainEl.clientHeight) : alertsPanel.offsetWidth / Math.max(1, mainEl.clientWidth);
    // The arrow pointing away from the panel moves the line that way and makes the panel bigger.
    const grow = stacked ? (flip.stacked ? 'ArrowUp' : 'ArrowDown') : (flip.side ? 'ArrowRight' : 'ArrowLeft');
    if (stacked && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) split.stacked = clampNum(now + (e.key === grow ? step : -step), 0.05, 0.95);
    else if (!stacked && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) split.side = clampNum(now + (e.key === grow ? step : -step), 0.05, 0.95);
    else if (e.key === 'Enter' || e.key === 'Home') split = Object.assign({}, SPLIT_DEFAULT);
    else return;
    e.preventDefault();
    saveSplit();
    applyLayout();
  });
  // Re-fit whenever the space changes: window resized, phone rotated, a warning banner appearing above the chat.
  window.addEventListener('resize', applyLayout);
  if ('ResizeObserver' in window) new ResizeObserver(() => applyLayout()).observe(mainEl);
  applyLayout();

  // ---------- Viewer card ----------
  function formatDate(ms) {
    return new Date(ms).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function supportChips(t) {
    if (!t) return [];
    const chips = [];
    if (t.messages) chips.push(`<b>${t.messages}</b> message${t.messages === 1 ? '' : 's'}`);
    if (t.follows) chips.push('followed');
    if (t.subs) chips.push(`<b>${t.subs}</b> sub${t.subs === 1 ? '' : 's'}`);
    if (t.giftedSubs) chips.push(`<b>${t.giftedSubs}</b> gifted`);
    if (t.bits) chips.push(`<b>${t.bits.toLocaleString()}</b> bits`);
    if (t.coins) chips.push(`<b>${t.coins.toLocaleString()}</b> coins`);
    if (t.kicks) chips.push(`<b>${t.kicks.toLocaleString()}</b> KICKs`);
    if (t.diamonds) chips.push(`<b>${Number(t.diamonds).toLocaleString()}</b> diamonds`);
    for (const [unit, v] of Object.entries(t.money || {})) chips.push(`<b>${U.esc(U.fmtMoney(unit, v))}</b>`);
    if (t.raids) chips.push(`raided with <b>${t.raidViewers}</b>`);
    if (t.redemptions) chips.push(`<b>${t.redemptions}</b> redemption${t.redemptions === 1 ? '' : 's'}`);
    return chips;
  }

  async function openViewerCard(platform, login) {
    if (!platform || !login) return;
    viewerCard.innerHTML = '<div class="help">Loading…</div>';
    viewerLayer.classList.remove('hidden');
    let data;
    try {
      data = window.UniChatHub.viewer(platform, login);
    } catch {
      viewerCard.innerHTML = '<div class="help">Couldn\'t load this viewer.</div>';
      return;
    }
    const s = data.stats;
    // Fall back to what's in the feed if they haven't done anything counted this stream.
    const seen = events.slice().reverse().find(e => e.platform === platform && e.user && String(e.user.login || '').toLowerCase() === login);
    const user = s ? { name: s.name, login: s.login, avatar: s.avatar, color: s.color, roles: s.roles } : (seen ? seen.user : { name: login, login });
    // Twitch pictures are fetched small for chat; the card shows a bigger copy.
    const big = typeof user.avatar === 'string' ? user.avatar.replace(/-70x70\.(png|jpe?g|gif|webp)$/i, '-150x150.$1') : user.avatar;
    const avatar = U.avatarHtml(Object.assign({}, user, { avatar: big }), platform, theme);
    const first = data.firstSeen
      ? (data.firstSeenDuringLearning ? `Chatting since at least ${formatDate(data.firstSeen)}` : `First seen ${formatDate(data.firstSeen)}`)
      : 'Not seen chatting yet';
    const chips = supportChips(s && s.totals);
    const recent = s && s.recent && s.recent.length
      ? s.recent.slice().reverse().map(r => `<div class="r"><span class="ts">${U.fmtTime(r.ts)}</span>${U.esc(r.text)}</div>`).join('')
      : '<div class="help">No messages this stream.</div>';
    viewerCard.innerHTML =
      `<div class="vc-head">${avatar}<div>
          <div class="vc-name" style="color:${U.userColor(user, theme)}">${U.esc(user.name || login)}</div>
          <div class="vc-sub">${U.icon(platform)} ${U.esc(U.NAMES[platform] || platform)}${s && s.firstTimeChatter ? ' · 👋 first-time chatter' : ''}</div>
          <div class="vc-sub">${U.esc(first)}</div>
        </div></div>
      <div class="vc-stats">${chips.length ? chips.map(c => `<span class="stat">${c}</span>`).join('') : '<span class="help">Nothing counted this stream yet.</span>'}</div>
      <div class="vc-recent">${recent}</div>
      <div class="vc-actions">
        <button class="btn danger" type="button" id="vcHide" title="Adds them to Settings → Filters → Always hide these users">Hide this user</button>
        <button class="btn" type="button" id="vcClose">Close</button>
      </div>`;
    $('#vcClose').addEventListener('click', closeViewerCard);
    $('#vcHide').addEventListener('click', async () => {
      if (!confirm(`Hide all messages from ${user.name || login}? You can undo this in Settings → Filters.`)) return;
      try {
        await U.api('POST', '/api/filters/block-user', { login });
        closeViewerCard();
        showToast(`${user.name || login} is now hidden`);
      } catch (err) {
        showToast(err.message);
      }
    });
  }
  function closeViewerCard() { viewerLayer.classList.add('hidden'); }
  viewerLayer.addEventListener('click', e => { if (e.target === viewerLayer) closeViewerCard(); });

  // ---------- About ----------
  const aboutLayer = $('#aboutLayer');
  const aboutBtn = $('#aboutBtn');
  $('#aboutVersion').textContent = `Version ${U.VERSION}`;
  $('#aboutPlats').innerHTML = ['twitch', 'tiktok', 'kick', 'velora', 'blaze', 'nimo'].map(p => `<span title="${U.NAMES[p]}">${U.icon(p)}</span>`).join('');
  function openAbout() { aboutLayer.classList.remove('hidden'); $('#aboutClose').focus(); }
  function closeAbout() {
    if (aboutLayer.classList.contains('hidden')) return;
    aboutLayer.classList.add('hidden');
    aboutBtn.focus();
  }
  aboutBtn.addEventListener('click', openAbout);
  $('#aboutClose').addEventListener('click', closeAbout);
  aboutLayer.addEventListener('click', e => { if (e.target === aboutLayer) closeAbout(); });

  // ---------- Profile pictures arriving after the message ----------
  function applyAvatar(platform, login, url) {
    const safe = U.safeUrl(url);
    if (!safe) return;
    const l = String(login).toLowerCase();
    for (const list of [events, alerts, questions, pins]) {
      for (const e of list) if (e.platform === platform && e.user && String(e.user.login || '').toLowerCase() === l) e.user.avatar = safe;
    }
    U.swapAvatar(platform, l, safe);
  }

  // ---------- Big alert popup ----------
  const popupQueue = [];
  let popupBusy = false;
  let popupTimer = null;

  function maybePopup(e) {
    const p = settings && settings.popup;
    if (!p || !p.enabled || e.silent || !isAlert(e) || !(p.kinds && p.kinds[e.kind])) return;
    if (popupQueue.length < 10) popupQueue.push(e);
    if (!popupBusy) showNextPopup();
  }

  function showNextPopup() {
    const e = popupQueue.shift();
    if (!e) { popupBusy = false; return; }
    popupBusy = true;
    popupEl.className = `popup k-${e.kind}`;
    const body = U.partsHtml(U.shownParts(e, U.classify(e, settings)));
    popupEl.innerHTML =
      `<div class="p-kind">${U.icon(e.platform)}${U.KIND_EMOJI[e.kind] || ''} ${U.KIND_LABEL[e.kind] || ''}</div>
       <div class="p-name">${U.nameHtml(e.user, theme)}</div>
       <div class="p-title">${U.esc(e.title || '')}</div>
       ${e.amount ? `<div class="p-amount">${U.esc(e.amount)}</div>` : ''}
       ${body ? `<div class="p-msg">${body}</div>` : ''}
       <div class="p-hint">Click to close${popupQueue.length ? ` · ${popupQueue.length} more` : ''}</div>`;
    popupLayer.classList.add('show');
    popupTimer = setTimeout(hidePopup, ((settings.popup && settings.popup.seconds) || 6) * 1000);
  }

  function hidePopup() {
    clearTimeout(popupTimer);
    if (!popupLayer.classList.contains('show')) return;
    popupLayer.classList.remove('show');
    setTimeout(showNextPopup, 350);
  }
  popupLayer.addEventListener('click', hidePopup);

  // ---------- Small notices (e.g. sound tests) ----------
  let toastTimer;
  function showToast(text) {
    let el = document.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 2500);
  }

  // ---------- Clear chat (this screen; the Alerts panel keeps everything) ----------
  $('#clearBtn').addEventListener('click', () => {
    if (conn && events.length) conn.send({ type: 'clearFeed' });
  });
  /** The chat was cleared. */
  function setHistory(list) {
    events = (list || []).slice(-maxMessages());
    unseen = 0;
    jump.classList.add('hidden');
    rerenderFeed();
  }

  // ---------- Text-to-speech stop button & keyboard ----------
  stopSpeech.addEventListener('click', () => U.Speech.stop());
  setInterval(() => stopSpeech.classList.toggle('hidden', !U.Speech.speaking()), 500);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { hidePopup(); closeViewerCard(); closeAbout(); closeSoundPrompt(); hideTip(); U.Speech.stop(); }
  });

  // ---------- Status pills & banners ----------
  // One pill per platform: its icon and a coloured dot (colours in U.statusTone). Hovering or focusing a pill shows its
  // name and a card with the details; clicking hides or shows that platform's messages. Touch screens have no hover,
  // so the first tap shows the card and a second tap hides or shows.
  const pillTip = document.createElement('div');
  pillTip.className = 'pill-tip hidden';
  pillTip.id = 'pillTip';
  pillTip.setAttribute('role', 'tooltip');
  document.body.appendChild(pillTip);
  let tipFor = null;          // status id the card is showing
  let lastPointer = 'mouse';  // how the last pill was pressed: 'mouse', 'pen', 'touch' or 'keyboard'

  const statusById = id => statuses.find(s => s.id === id);
  const showCounts = () => !!(settings && settings.display && settings.display.showViewerCounts);
  const pillFor = id => pillsEl.querySelector(`.pill[data-id="${CSS.escape(id)}"]`);

  function tipHtml(s) {
    const t = U.statusTone(s);
    const retry = s.state === 'stopped' ? `${U.attemptText(s)} · Reconnect is in the banner above the chat`
      : s.nextRetryAt ? [countdown(s.nextRetryAt, s.state === 'waiting' ? 'checking again' : 'retrying'), U.attemptText(s)].filter(Boolean).join(' · ') : '';
    const off = hidden.has(s.platform);
    const how = lastPointer === 'touch' ? 'Tap again' : 'Click';
    const stream = [
      s.live === true && s.liveSince ? `Live for ${U.fmtDuration(Date.now() - s.liveSince)}` : '',
      showCounts() && Number.isFinite(s.viewers) ? `${s.viewers.toLocaleString()} watching` : '',
    ].filter(Boolean).join(' · ');
    return `<div class="tip-head">${U.icon(s.platform)}<b>${U.esc(s.label)}</b></div>
      <div class="tip-state t-${t.tone}"><span class="dot"></span>${U.esc(t.text)}</div>
      ${stream ? `<div class="tip-line">${U.esc(stream)}</div>` : ''}
      ${s.detail ? `<div class="tip-line">${U.esc(s.detail)}</div>` : ''}
      ${retry ? `<div class="tip-line muted">${U.esc(retry)}</div>` : ''}
      ${t.note ? `<div class="tip-line muted">${U.esc(t.note)}</div>` : ''}
      ${off ? '<div class="tip-line warn">Its messages are hidden on this screen</div>' : ''}
      <div class="tip-hint">${how} to ${off ? 'show' : 'hide'} ${U.esc(s.label)} messages</div>`;
  }

  function showTip(pill) {
    const s = statusById(pill.dataset.id);
    if (!s) { hideTip(); return; }
    tipFor = s.id;
    pillTip.innerHTML = tipHtml(s);
    pillTip.classList.remove('hidden');
    // Lined up with the pill's left edge, which stays put while the pill widens to show its name.
    const r = pill.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - pillTip.offsetWidth - 8));
    pillTip.style.left = `${left}px`;
    pillTip.style.top = `${r.bottom + 8}px`;
    pillTip.style.setProperty('--arrow-x', `${Math.max(10, r.left - left + 15)}px`);
  }
  function hideTip() { tipFor = null; pillTip.classList.add('hidden'); }
  function refreshTip() {
    const pill = tipFor && pillFor(tipFor);
    if (pill) showTip(pill); else hideTip();
  }

  function toggleHidden(platform) {
    flushLines();
    if (hidden.has(platform)) hidden.delete(platform); else hidden.add(platform);
    store.set('unichat.hiddenPlatforms', Array.from(hidden));
    feed.querySelectorAll(`.msg[data-platform="${CSS.escape(platform)}"]:not(.sys)`).forEach(m => m.classList.toggle('hidden', hidden.has(platform)));
    renderPills();
  }

  function makePill(s) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.dataset.id = s.id;
    pill.dataset.platform = s.platform;
    pill.innerHTML = `${U.icon(s.platform)}<span class="pname">${U.esc(s.label)}</span><span class="pcount" hidden></span><span class="dot"></span>`;
    pill.addEventListener('pointerdown', e => { lastPointer = e.pointerType || 'mouse'; });
    pill.addEventListener('keydown', () => { lastPointer = 'keyboard'; });
    pill.addEventListener('pointerenter', e => { if (e.pointerType !== 'touch') showTip(pill); });
    pill.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch' && tipFor === pill.dataset.id) hideTip(); });
    pill.addEventListener('focus', () => { if (pill.matches(':focus-visible')) showTip(pill); });
    pill.addEventListener('blur', () => { if (tipFor === pill.dataset.id) hideTip(); });
    pill.addEventListener('click', () => {
      if (lastPointer === 'touch' && tipFor !== pill.dataset.id) { showTip(pill); return; } // first tap: details
      toggleHidden(pill.dataset.platform);
    });
    return pill;
  }

  function renderPills() {
    const visible = statuses.filter(s => s.state !== 'disabled');
    if (!visible.length) {
      pillsEl.innerHTML = '<span class="pill pills-none"><span class="dot"></span>No platforms set up yet</span>';
      hideTip();
      return;
    }
    const none = pillsEl.querySelector('.pills-none');
    if (none) none.remove();
    const ids = new Set(visible.map(s => s.id));
    pillsEl.querySelectorAll('.pill[data-id]').forEach(p => { if (!ids.has(p.dataset.id)) p.remove(); });
    // Pills are updated in place (not rebuilt), so hover, focus and the name animation aren't interrupted.
    visible.forEach((s, i) => {
      const pill = pillFor(s.id) || makePill(s);
      const t = U.statusTone(s);
      const off = hidden.has(s.platform);
      pill.className = `pill t-${t.tone}${s.state === 'stopped' ? ' failed' : ''}${off ? ' hidden-platform' : ''}`;
      // Viewer counts only when Settings → Display → "Show viewer counts" is on.
      const count = showCounts() && Number.isFinite(s.viewers) ? U.fmtCount(s.viewers) : '';
      const countEl = pill.querySelector('.pcount');
      if (countEl.textContent !== count) countEl.textContent = count;
      countEl.hidden = !count;
      pill.setAttribute('aria-label', `${s.label}: ${t.text}${count ? `, ${s.viewers} watching` : ''}${off ? '. Messages hidden' : ''}`);
      pill.setAttribute('aria-describedby', 'pillTip');
      if (pillsEl.children[i] !== pill) pillsEl.insertBefore(pill, pillsEl.children[i] || null);
    });
    refreshTip();
  }
  pillsEl.addEventListener('scroll', hideTip, { passive: true });
  window.addEventListener('resize', hideTip);
  document.addEventListener('pointerdown', e => { if (tipFor && !e.target.closest('.pill[data-id], .pill-tip')) hideTip(); }, { passive: true });
  // A pill that moved out from under a still mouse (another platform's pill appeared) never gets "pointer left".
  document.addEventListener('pointermove', e => {
    if (tipFor && e.pointerType === 'mouse' && !e.target.closest('.pill[data-id]') && !document.activeElement.matches('.pill:focus-visible')) hideTip();
  }, { passive: true });

  function countdown(at, verb = 'retrying') {
    if (!at) return '';
    const secs = Math.max(0, Math.round((at - Date.now()) / 1000));
    return secs > 0 ? `${verb} in ${secs}s` : `${verb} now…`;
  }

  const WARN_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h22L12 2 1 21Zm12-3h-2v-2h2v2Zm0-4h-2v-4h2v4Z"/></svg>';

  // Banners you close stay hidden until that connection recovers and fails again. Yellow while it quietly retries; red
  // (with the "can't reconnect" sound) once it keeps failing; a stopped one has a Reconnect button and can't be closed.
  const dismissed = {};
  const dismissKey = s => `${Number(s.since) || 0}:${s.alarm === true ? 'red' : ''}`; // turning red shows it again

  function renderBanners() {
    const rows = [];
    if (serverDown) {
      rows.push(`<div class="banner err">${WARN_ICON}<span><b>Lost connection to UniChat</b> on ${U.esc(location.host)} <span class="muted">· ${countdown(serverDown.nextRetryAt)} (attempt ${Number(serverDown.attempt) || 0})</span></span></div>`);
    } else {
      for (const s of statuses.filter(x => x.state === 'reconnecting' || x.state === 'error' || x.state === 'stopped')) {
        const stopped = s.state === 'stopped';
        if (!stopped && dismissed[s.id] === dismissKey(s)) continue;
        const extra = stopped ? U.attemptText(s) : [s.nextRetryAt ? countdown(s.nextRetryAt) : 'retrying now…', U.attemptText(s)].filter(Boolean).join(' · ');
        const button = stopped
          ? `<button class="btn small" type="button" data-reconnect="${U.esc(s.id)}">Reconnect</button>`
          : `<button class="x" type="button" data-dismiss="${U.esc(s.id)}" data-key="${U.esc(dismissKey(s))}" title="Hide until this changes (the status dot keeps showing it)">×</button>`;
        rows.push(`<div class="banner ${U.statusTone(s).tone === 'problem' ? 'err' : ''}">${U.icon(s.platform)}<span><b>${U.esc(s.label)}</b>: ${U.esc(s.detail)} <span class="muted">· ${U.esc(extra)}</span></span>${button}</div>`);
      }
    }
    bannersEl.innerHTML = rows.join('');
  }
  bannersEl.addEventListener('click', e => {
    const again = e.target.closest('[data-reconnect]');
    if (again) { if (conn) conn.send({ type: 'reconnect', id: again.dataset.reconnect }); return; }
    const b = e.target.closest('[data-dismiss]');
    if (!b) return;
    dismissed[b.dataset.dismiss] = b.dataset.key;
    renderBanners();
  });
  setInterval(() => {
    if (serverDown || statuses.some(s => s.nextRetryAt)) renderBanners();
    if (tipFor) refreshTip(); // its countdown
  }, 1000);

  // ---------- Sound toggle (browsers need one click before audio can play) ----------
  const SPEAKER_ON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3Zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4ZM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6Z"/></svg>';
  const SPEAKER_OFF = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12A4.5 4.5 0 0 0 14 8v2.2l2.5 2.5V12ZM19 12a7 7 0 0 1-.6 2.8l1.5 1.5A9 9 0 0 0 14 3.2v2.1a7 7 0 0 1 5 6.7ZM4.3 3 3 4.3 7.7 9H3v6h4l5 5v-6.7l4.3 4.2a7 7 0 0 1-2.3 1.2v2.1a9 9 0 0 0 3.7-1.8l2 2 1.3-1.3L4.3 3ZM12 4 9.9 6.1 12 8.2V4Z"/></svg>';

  // Until the first click the browser keeps the page silent, so a prompt in the middle of the screen asks for that
  // click. It waits a moment after loading (browsers that already allow sound here never show it). Clicking anywhere
  // turns sound on; Esc closes it for this visit (the speaker button keeps asking).
  const soundLayer = $('#soundLayer');
  let soundPromptReady = false;
  let soundPromptClosed = false;
  setTimeout(() => { soundPromptReady = true; renderSoundBtn(); }, 900);

  function renderSoundPrompt() {
    const show = soundPromptReady && !soundPromptClosed && soundOn && U.Sound.supported() && !U.Sound.unlocked();
    const wasShown = !soundLayer.classList.contains('hidden');
    soundLayer.classList.toggle('hidden', !show);
    if (show && !wasShown) $('#soundEnable').focus();
  }
  function closeSoundPrompt() {
    if (soundLayer.classList.contains('hidden')) return;
    soundPromptClosed = true;
    renderSoundPrompt();
  }
  $('#soundEnable').addEventListener('click', () => {
    soundOn = true;
    store.set('unichat.sound', true);
    U.Sound.unlock().then(renderSoundBtn, renderSoundBtn);
  });
  $('#soundMute').addEventListener('click', () => {
    soundOn = false;
    store.set('unichat.sound', false);
    U.Speech.stop();
    renderSoundBtn();
    showToast('Sound is off on this screen. The speaker button turns it back on.');
  });
  if (U.Sound.supported()) U.Sound.onState(renderSoundBtn);

  function renderSoundBtn() {
    renderSoundPrompt();
    soundBtn.classList.remove('attention');
    if (!soundOn) {
      soundBtn.innerHTML = `${SPEAKER_OFF}<span>Sound off</span>`;
      soundBtn.title = 'Sounds and voice are muted on this device. Click to turn on.';
    } else if (!U.Sound.unlocked()) {
      soundBtn.innerHTML = `${SPEAKER_ON}<span>Click to enable sound</span>`;
      soundBtn.title = 'Your browser needs one click before it can play sounds.';
      soundBtn.classList.add('attention');
    } else {
      soundBtn.innerHTML = `${SPEAKER_ON}<span>Sound on</span>`;
      soundBtn.title = 'Click to mute sounds and voice on this device.';
    }
  }

  soundBtn.addEventListener('click', ev => {
    ev.stopPropagation();
    if (soundOn && U.Sound.unlocked()) { soundOn = false; U.Speech.stop(); }
    else soundOn = true;
    store.set('unichat.sound', soundOn);
    U.Sound.unlock().then(renderSoundBtn, renderSoundBtn);
    renderSoundBtn();
  });
  // Any interaction with the page also unlocks audio.
  ['pointerdown', 'keydown'].forEach(t => document.addEventListener(t, () => {
    if (soundOn && !U.Sound.unlocked()) U.Sound.unlock().then(renderSoundBtn, renderSoundBtn);
  }, { passive: true }));
  renderSoundBtn();

  // ---------- Keep the screen awake (phone/tablet chat monitors) ----------
  let wakeLock = null;
  let requesting = false;

  function updateWakeLock() {
    const wanted = !!(settings && settings.display && settings.display.keepAwake && document.visibilityState === 'visible' && 'wakeLock' in navigator);
    if (wanted && !wakeLock && !requesting) {
      requesting = true;
      navigator.wakeLock.request('screen').then(lock => {
        requesting = false;
        wakeLock = lock;
        lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
        updateWakeLock(); // turned off (or tab hidden) while asking: let go again
      }).catch(() => { requesting = false; /* refused (e.g. battery saver): try again next time */ });
    } else if (!wanted && wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }
  // Browsers drop the lock when the tab is hidden, so it's re-requested when visible again.
  document.addEventListener('visibilitychange', updateWakeLock);

  // ---------- Live connection ----------
  conn = U.connect('dashboard', {
    onOpen() { serverDown = null; renderBanners(); },
    onClose(info) { serverDown = info; renderBanners(); },
    onMessage(msg) {
      if (msg.type !== 'event') flushLines(); // lines still waiting for the next frame join first (see queueLine)
      switch (msg.type) {
        case 'hello':
          applySettings(msg.settings);
          statuses = msg.status || [];
          pins = msg.pins || [];
          events = (msg.history || []).slice(-maxMessages());
          rerenderFeed();
          alerts = msg.alerts || [];
          questions = msg.questions || [];
          done.clear();
          (msg.ackedAt || []).forEach(p => { if (Array.isArray(p)) done.set(p[0], Number(p[1]) || Date.now()); });
          (msg.acked || []).forEach(id => { if (!done.has(id)) done.set(id, Date.now()); });
          renderPanel();
          renderPills();
          renderBanners();
          break;
        case 'event':
          add(msg.event, true);
          break;
        case 'delete': {
          const ids = new Set(msg.ids || []);
          events = events.filter(e => !ids.has(e.id));
          questions = questions.filter(e => !ids.has(e.id));
          ids.forEach(id => feed.querySelectorAll(byId(id)).forEach(el => el.remove()));
          if (panelTab === 'questions') renderPanel(); else updateCounts();
          break;
        }
        case 'history':
          setHistory(msg.history);
          break;
        case 'recap':
          if (panelTab === 'recap') renderPanel();
          break;
        case 'remove': { // dismissed lines, and connection notes once the connection is back (alerts stay in the panel)
          const ids = new Set(msg.ids || []);
          events = events.filter(e => !ids.has(e.id));
          ids.forEach(id => feed.querySelectorAll(`.msg${byId(id)}`).forEach(removeLine));
          break;
        }
        case 'clear': {
          const login = msg.login ? String(msg.login).toLowerCase() : null;
          const match = e => e.platform === msg.platform && e.kind === 'chat' &&
            (!login || String((e.user && e.user.login) || '').toLowerCase() === login);
          events = events.filter(e => !match(e));
          questions = questions.filter(e => !match(e));
          let sel = `.msg.k-chat[data-platform="${CSS.escape(msg.platform)}"]`;
          if (login) sel += `[data-user="${CSS.escape(login)}"]`;
          feed.querySelectorAll(sel).forEach(el => el.remove());
          if (panelTab === 'questions') renderPanel(); else updateCounts();
          break;
        }
        case 'ack':
          markDone(msg.ids || [], msg.at);
          break;
        case 'unack':
          unmarkDone(msg.ids || []);
          break;
        case 'dismiss':
          dismiss(msg.ids || []);
          break;
        case 'pins':
          setPins(msg.pins);
          break;
        case 'avatar':
          applyAvatar(msg.platform, msg.login, msg.url);
          break;
        case 'soundTest': {
          const pct = Math.round((msg.volume || 0) * 100);
          if (!soundOn) showToast(`🔇 Sound test (${pct}%): sound is off on this screen`);
          else if (!U.Sound.unlocked()) showToast(`🔈 Sound test (${pct}%): click anywhere on this page to allow sound`);
          else { U.Sound.play(msg.sound, msg.volume); showToast(`🔊 Sound test at ${pct}%`); }
          break;
        }
        case 'status':
          statuses = msg.status || [];
          renderPills();
          renderBanners();
          break;
        case 'settings':
          applySettings(msg.settings);
          rerenderFeed();
          renderPanel();
          renderPills();
          break;
      }
    },
  });
})();
