/* UniChat → Resonite: when Settings → Resonite is on for this device, the chat page sends its lines and alerts to the
   relay (address built in, see store.js), which passes them to your in-game panel. Only what this page shows is sent:
   chat the filters hide here isn't, an alert from a hidden viewer goes without its message, and quiet notes (joins,
   likes, shares) stay here. Missed and caught-up lines go without a sound. A new alert goes when this page plays it, so
   when it waits for its voice line the panel's banner and sound wait too. It sends to this browser's room (Settings →
   Resonite: the room code, kept here; panels read the panel code worked out from it). One device sends to a room at a
   time: the same channels on another device take over (this one stops until it's turned on again), and while this
   page sends, someone else's page is told the room is in use.
   v4 panels also show this page's Questions, Pinned and Recap, and can ask for a viewer card (answered from this page's
   viewer data, filters applied) or, for the panel's owner, hide a viewer (added to Settings → Filters, with a notice
   here so it can be undone). */
(function () {
  'use strict';
  const U = window.UniChat;
  const Store = window.UniChatStore;
  if (!Store || !Store.RELAY_URL || !window.UniChatHub) return;

  const ALERT_KINDS = ['follow', 'donation', 'sub', 'raid', 'redemption', 'hype'];
  const PLATFORMS = ['twitch', 'tiktok', 'kick', 'velora', 'blaze', 'nimo', 'x'];
  const BACKOFF = [2, 4, 8, 15, 30, 60];
  const SILENT_MS = 70000; // the relay says something every 25 s: this long without a word means the link is gone
  const HOLD_MS = 125000;  // the chat page gives up waiting for a voice line after 2 minutes
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('unichat') : null;

  let settings = Store.load();
  let history = [];  // what this page shows, newest last (from the hub)
  let statuses = [];
  let ws = null, authed = false, attempt = 0, retryTimer = null, lastHeard = 0;
  let halted = '';   // 'badroom' | 'inuse' | 'replaced' | 'refused': wait until Settings → Resonite changes
  let connectRun = 0; // a newer connect() makes an older one (still working out the panel code) give up
  let report = { state: 'off' };
  let sentTones = ''; // the status last sent (statuses change often without changing the dots)
  const held = new Map(); // id → { m, timer }: new alerts waiting until the chat page plays them
  const played = [];      // ids the chat page played before this script saw them (it can hear first)
  let questions = [];     // the hub's Questions list (events), and its pins
  let pins = [];
  let recapTimer = null;

  /** Tell Settings → Resonite (in this browser) and this page's Resonite pill (dashboard.js) how sending is going. */
  function tell(next) {
    report = next;
    if (channel) channel.postMessage(Object.assign({ type: 'resonite' }, next));
    window.dispatchEvent(new CustomEvent('unichat:resonite', { detail: next })); // this page only (not other tabs')
  }

  // "rgb(r, g, b)" (UniChat's readable name colour) → "#rrggbb", the only colour form the relay accepts.
  function hexColor(c) {
    if (/^#[0-9a-f]{6}$/i.test(c || '')) return c;
    const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(c || '');
    return m ? '#' + m.slice(1, 4).map(n => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('') : null;
  }

  /** A line or alert as the relay wants it, or null when it isn't sent. question: it's in the hub's Questions list. */
  function pack(e, question = false) {
    if (!e || !PLATFORMS.includes(e.platform)) return null;
    const alert = ALERT_KINDS.includes(e.kind);
    const join = e.kind === 'chat' && e.code === 'join'; // TikTok and X joins: a quiet "joined" line on the panel too
    if (!alert && !join && (e.kind !== 'chat' || e.silent === true)) return null;
    const cls = U.classify(e, settings);
    if (cls.hidden) return null;
    const u = e.user || {};
    const name = cls.maskName ? 'Someone' : String(u.name || u.login || '');
    return {
      id: e.id, k: join ? 'join' : e.kind, p: e.platform, n: name,
      c: name ? hexColor(U.userColor(u, 'dark')) : null,
      x: join ? '' : (U.shownParts(e, cls) || []).map(p => (p && p.v != null ? String(p.v) : '')).join('').trim(),
      ti: alert ? String(e.title || '') : '',
      a: alert ? String(e.amount || '') : '',
      q: e.missed === true || e.historical === true,
      h: cls.highlight || null,
      av: !cls.maskName && /^https:\/\/\S+$/.test(String(u.avatar || '')) ? String(u.avatar).slice(0, 500) : '', // the viewer's picture (not for hidden names)
      l: cls.maskName ? '' : String(u.login || '').toLowerCase().slice(0, 60), // for the viewer card (none for hidden names)
      tm: e.ts ? U.fmtTime(e.ts) : '',
      r: !cls.maskName && Array.isArray(u.roles) ? u.roles.slice(0, 8).map(String) : [],
      qn: question === true && e.kind === 'chat' && !join,
    };
  }

  const tones = () => statuses.filter(s => s && PLATFORMS.includes(s.platform)).map(s => ({ p: s.platform, tone: U.statusTone(s).tone }));

  /** Everything this page shows right now (after connecting, or when the filters change): no sounds for any of it. */
  function snapshot() {
    const chat = [], alerts = [];
    for (const e of history) {
      const m = held.has(e.id) ? null : pack(e); // a held alert goes later, with its sound
      if (m) (m.k === 'chat' || m.k === 'join' ? chat : alerts).push(Object.assign(m, { q: true }));
    }
    const status = tones();
    sentTones = JSON.stringify(status);
    return { t: 'snap', chat: chat.slice(-40), alerts: alerts.slice(-10), questions: packList(questions, true), pins: packList(pins), recap: recapNow(), status };
  }
  /** The hub's Questions or pins as the relay wants them (quiet; what the filters hide stays out). */
  const packList = (list, question = false) => list.map(e => pack(e, question)).filter(Boolean).map(m => Object.assign(m, { q: true })).slice(-20);

  // ---------- The Recap tab (the same summary as this page's Recap tab) ----------
  function recapNow() {
    let r;
    try { r = window.UniChatHub.recap(); } catch { return null; }
    const f = (settings && settings.filters) || {};
    const blocked = new Set((f.blockedUsers || []).map(x => String(x).toLowerCase().replace(/^@/, '')));
    // On stream: hidden viewers stay out, and a name the slur filter catches shows as "Someone".
    r.items = r.items.filter(i => !blocked.has(String(i.login || '').toLowerCase()))
      .map(i => (f.hideSlurs !== false && U.nameHasSlur(i.name) ? Object.assign({}, i, { name: 'Someone' }) : i));
    const sum = U.recapSummary(r);
    return {
      since: U.fmtTime(sum.start), chips: sum.chips, ns: sum.supporters.length, nf: sum.followers.length, nr: sum.raids.length,
      supporters: sum.supporters.slice(0, 40).map(x => ({ p: x.platform, n: x.name, what: x.what })),
      followers: sum.followers.slice(0, 80).map(x => ({ p: x.platform, n: x.name })),
      raids: sum.raids.slice(0, 20).map(x => ({ p: x.platform, n: x.name, what: x.value ? U.plural(x.value, 'viewer') : '' })),
    };
  }
  function sendRecapSoon() {
    clearTimeout(recapTimer);
    recapTimer = setTimeout(() => { const r = recapNow(); if (r) send(Object.assign({ t: 'recap' }, r)); }, 1500);
  }

  // ---------- Viewer cards for the panel (the same data as this page's viewer card) ----------
  function answerWho(w) {
    const p = String(w.p || ''), l = String(w.l || '').toLowerCase();
    if (!PLATFORMS.includes(p) || !l) return;
    let data = null;
    try { data = window.UniChatHub.viewer(p, l); } catch { /* answered with what the chat shows */ }
    const s = data && data.stats;
    const seen = history.slice().reverse().find(e => e.platform === p && e.user && String(e.user.login || '').toLowerCase() === l);
    const user = s ? { name: s.name, login: s.login, avatar: s.avatar, color: s.color, roles: s.roles } : (seen ? seen.user : { name: l, login: l });
    const reply = { t: 'who', r: w.r, p, l };
    // A viewer the filters hide (or whose name has a slur) stays hidden on stream too.
    if (U.classify({ kind: 'chat', platform: p, user, parts: [] }, settings).hidden) {
      send(Object.assign(reply, { n: 'Hidden viewer', seen: 'Hidden by your filters on the PC', chips: [], recent: [] }));
      return;
    }
    const day = ms => new Date(ms).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
    const first = data && data.firstSeen
      ? (data.firstSeenDuringLearning ? `Chatting since at least ${day(data.firstSeen)}` : `First seen ${day(data.firstSeen)}`)
      : 'Not seen chatting yet';
    const shown = text => !U.classify({ kind: 'chat', platform: p, user, parts: [{ t: 'text', v: String(text || '') }] }, settings).hidden;
    const recent = s && Array.isArray(s.recent) ? s.recent.slice().reverse().filter(m => m && shown(m.text)).slice(0, 8)
      .map(m => ({ t: U.fmtTime(m.ts), x: String(m.text || '').slice(0, 200) })) : [];
    // Twitch pictures are fetched small for chat; the card shows a bigger copy (as this page's card does).
    const big = typeof user.avatar === 'string' ? user.avatar.replace(/-70x70\.(png|jpe?g|gif|webp)$/i, '-150x150.$1') : '';
    send(Object.assign(reply, {
      n: String(user.name || user.login || l).slice(0, 60), c: hexColor(U.userColor(user, 'dark')),
      roles: Array.isArray(user.roles) ? user.roles.slice(0, 8).map(String) : [], first: !!(s && s.firstTimeChatter), seen: first,
      chips: U.supportChips(s && s.totals), recent, av: /^https:\/\/\S+$/.test(big) ? big.slice(0, 500) : '',
    }));
  }

  /** The panel's owner hid someone: the same as this page's "Hide this user" (Settings → Filters), with a notice. */
  async function hideFromPanel(w) {
    const p = String(w.p || ''), l = String(w.l || '').toLowerCase();
    if (!PLATFORMS.includes(p) || !/^[a-z0-9_.-]{1,60}$/.test(l)) return;
    const seen = history.slice().reverse().find(e => e.platform === p && e.user && String(e.user.login || '').toLowerCase() === l);
    const name = seen && seen.user && seen.user.name ? seen.user.name : l;
    try {
      await U.api('POST', '/api/filters/block-user', { login: l });
      window.UniChatHub.hub.diagnostic(`Resonite: the panel's owner hid ${p}:${l}`);
      window.dispatchEvent(new CustomEvent('unichat:toast', { detail: `${name} was hidden from Resonite. Undo in Settings → Filters.` }));
    } catch { /* the filters couldn't be saved; nothing changes */ }
  }

  // ---------- New alerts wait until the chat page plays them (see dashboard.js) ----------
  function release(id) {
    const h = held.get(id);
    if (!h) return;
    held.delete(id);
    clearTimeout(h.timer);
    send({ t: 'ev', e: h.m });
  }
  function drop(ids) {
    for (const id of ids) { const h = held.get(id); if (h) { clearTimeout(h.timer); held.delete(id); } }
  }
  // A finished voice line (see dashboard.js): the relay keeps it briefly and the panel plays it with the alert.
  window.addEventListener('unichat:alert-voice', ev => {
    const d = ev.detail || {};
    if (!d.wav || typeof d.wav.then !== 'function') return;
    d.wav.then(buf => {
      if (!buf || buf.byteLength > 900000) return; // about 18 s of voice: longer lines stay on this device
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      send({ t: 'voice', id: String(d.id || '').slice(0, 160), wav: btoa(bin) });
    }, () => {});
  });
  window.addEventListener('unichat:alert-go', ev => {
    const id = ev.detail;
    if (held.has(id)) { release(id); return; }
    played.push(id);
    if (played.length > 50) played.shift();
  });

  function send(obj) {
    if (!ws || !authed || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(obj)); } catch { /* closing: the reconnect resends everything */ }
  }

  // ---------- The link to the relay ----------
  function disconnect() {
    clearTimeout(retryTimer);
    retryTimer = null;
    authed = false;
    const old = ws;
    ws = null;
    if (old) { try { old.close(1000, 'Turned off'); } catch { /* already closed */ } }
  }

  async function connect() {
    disconnect();
    const run = ++connectRun;
    const cfg = Store.resonite.load();
    if (!cfg.on) { tell({ state: 'off' }); return; }
    if (!cfg.room) { tell({ state: 'noroom' }); return; }
    if (halted) { tell(report.state === halted ? report : { state: halted }); return; }
    tell({ state: 'connecting' });
    let code;
    try { code = await Store.resonite.panelCode(cfg.room); }
    catch { tell({ state: 'refused', reason: "this browser can't work out the panel code" }); return; }
    if (run !== connectRun) return;
    let sock;
    try { sock = new WebSocket(Store.relayAddress(`/panel/${code}/send`)); }
    catch (err) { retry(err.message); return; }
    ws = sock;
    lastHeard = Date.now();
    sock.onopen = () => {
      try { sock.send(JSON.stringify({ room: cfg.room, channels: Store.resonite.channels(settings) })); } catch { /* onclose follows */ }
    };
    sock.onmessage = ev => {
      if (ws !== sock) return;
      lastHeard = Date.now();
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      const b = m && typeof m === 'object' ? m.bridge : null;
      if (!b || typeof b !== 'object') return;
      if (b.who && typeof b.who === 'object' && authed) { answerWho(b.who); return; }      // a panel asked for a viewer card
      if (b.hide && typeof b.hide === 'object' && authed) { hideFromPanel(b.hide); return; } // the panel's owner hid a viewer
      const readers = Math.min(99, Math.max(0, Math.floor(Number(b.readers)) || 0)); // a count, never shown as more than 99
      if (b.state === 'ok') {
        authed = true;
        attempt = 0;
        send(snapshot());
        tell({ state: 'sending', readers });
      } else if (b.hb && authed) tell({ state: 'sending', readers });
    };
    sock.onerror = () => { /* onclose follows */ };
    sock.onclose = ev => {
      if (ws !== sock) return;
      ws = null;
      authed = false;
      const why = String(ev.reason || '').slice(0, 200);
      window.UniChatHub.hub.diagnostic(`Resonite: relay connection closed (code ${ev.code}${why ? ', ' + why : ''})`);
      if (ev.code === 4401) { halted = 'badroom'; tell({ state: 'badroom' }); }
      else if (ev.code === 4423) { halted = 'inuse'; tell({ state: 'inuse' }); }
      else if (ev.code === 4409) { halted = 'replaced'; tell({ state: 'replaced' }); }
      else if (ev.code === 4403 || ev.code === 4404) { halted = 'refused'; tell({ state: 'refused', reason: why }); }
      else retry(ev.code === 1006 ? "can't reach the relay" : why || `closed (${ev.code})`);
    };
  }

  function retry(reason) {
    const delay = BACKOFF[Math.min(attempt++, BACKOFF.length - 1)] * 1000;
    tell({ state: 'retrying', reason: String(reason || '').slice(0, 200), retryAt: Date.now() + delay });
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, delay);
  }

  // A link that went quiet (sleep, network change) is replaced; coming back online retries straight away.
  setInterval(() => {
    if (ws && Date.now() - lastHeard > SILENT_MS) { const s = ws; ws = null; try { s.close(4000, 'silent'); } catch { /* gone */ } retry('the relay went quiet'); }
  }, 15000);
  window.addEventListener('online', () => { if (retryTimer) { attempt = 0; connect(); } });
  // Settings → Resonite saved a change (another tab): start over with it.
  window.addEventListener('storage', e => { if (e.key === Store.resonite.STORAGE_KEY) { halted = ''; attempt = 0; connect(); } });
  if (channel) channel.addEventListener('message', ev => { if (ev.data && ev.data.type === 'resonite?') tell(report); });

  // ---------- What this page shows (the same messages the chat uses) ----------
  window.UniChatHub.connect('resonite', {
    onMessage(msg) {
      switch (msg.type) {
        case 'hello':
          if (msg.settings) settings = msg.settings;
          history = (msg.history || []).slice(-300);
          statuses = msg.status || [];
          questions = (msg.questions || []).slice(-20);
          pins = (msg.pins || []).slice(-20);
          send(snapshot());
          break;
        case 'event': {
          history.push(msg.event);
          if (history.length > 300) history.shift();
          if (msg.question) { questions.push(msg.event); if (questions.length > 20) questions.shift(); }
          const m = pack(msg.event, msg.question === true);
          if (!m) break;
          if (ALERT_KINDS.includes(m.k) && !m.q && !played.includes(m.id)) held.set(m.id, { m, timer: setTimeout(() => release(m.id), HOLD_MS) });
          else send({ t: 'ev', e: m });
          break;
        }
        case 'remove':
        case 'delete': {
          const ids = new Set(msg.ids || []);
          history = history.filter(e => !ids.has(e.id));
          // Deleted by a moderator: gone from the Questions too. Dismissed here: only out of the chat (lines: true).
          if (msg.type === 'delete') questions = questions.filter(e => !ids.has(e.id));
          drop(ids);
          if (ids.size) send(Object.assign({ t: 'rm', ids: [...ids] }, msg.type === 'remove' ? { lines: true } : {}));
          break;
        }
        case 'dismiss': { // ticked alerts and answered questions leave this page's panel after a while
          const ids = new Set(msg.ids || []);
          const before = questions.length;
          questions = questions.filter(e => !ids.has(e.id));
          if (questions.length !== before) send({ t: 'questions', questions: packList(questions, true) });
          break;
        }
        case 'pins':
          pins = (msg.pins || []).slice(-20);
          send({ t: 'pins', pins: packList(pins) });
          break;
        case 'recap':
          sendRecapSoon();
          break;
        case 'clear': { // a viewer's (or the whole platform's) chat cleared by a moderator
          const login = msg.login ? String(msg.login).toLowerCase() : null;
          const gone = history.filter(e => e.platform === msg.platform && e.kind === 'chat' &&
            (!login || String((e.user && e.user.login) || '').toLowerCase() === login)).map(e => e.id);
          history = history.filter(e => !gone.includes(e.id));
          if (gone.length) send({ t: 'rm', ids: gone });
          break;
        }
        case 'history': // the chat was cleared on this page
          history = Array.isArray(msg.history) ? msg.history.slice(-300) : [];
          if (history.length) send(snapshot()); else send({ t: 'clear' });
          break;
        case 'status': {
          statuses = msg.status || [];
          const status = tones();
          if (authed && JSON.stringify(status) !== sentTones) { sentTones = JSON.stringify(status); send({ t: 'st', status }); }
          break;
        }
        case 'settings': // the filters may have changed what shows
          if (msg.settings) settings = msg.settings;
          send(snapshot());
          break;
        default:
      }
    },
  });

  connect();
})();
