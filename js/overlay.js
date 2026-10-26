/* OBS overlay: transparent background, newest on top going down (or at the bottom), messages fade out. */
(function () {
  'use strict';
  const U = window.UniChat;
  const feed = document.getElementById('feed');
  const q = new URLSearchParams(location.search);
  /** A number from the link, kept within sensible limits (a link can't make the text giant or keep lines forever). */
  const within = (name, lo, hi) => { const n = Number(q.get(name)); return q.has(name) && q.get(name) !== '' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };

  const opt = {
    fade: within('fade', 0, 3600),
    size: within('size', 8, 200),
    max: Math.round(within('max', 1, 500) || 30),
    chat: q.get('chat') !== '0',
    alerts: q.get('alerts') !== '0',
    sound: q.get('sound') === '1',
    ts: q.get('ts') === '1',
    system: q.get('system') === '1',
    platforms: q.has('platforms') ? new Set(q.get('platforms').split(',').map(s => s.trim().toLowerCase())) : null,
    embed: q.get('embed') === '1',
    fit: q.get('fit') === '1',
  };

  // &layout=landscape|vertical sets sensible defaults for that kind of scene; any option in the link still wins.
  const LAYOUTS = {
    landscape: { width: '420px', align: 'left', order: 'top' },
    vertical: { width: '100%', align: 'left', order: 'top', fit: true, pad: '6%,8%,24%,6%' },
  };
  const preset = LAYOUTS[q.get('layout')] || LAYOUTS.landscape;
  if (!q.has('fit') && preset.fit) opt.fit = true;
  // An embedded website chat keeps the plain full-width, newest-at-the-bottom look unless the link says otherwise.
  const plain = opt.embed && !q.has('layout');

  /** &width=… : how wide the chat is, a number with px or % (default 420px; narrower reads better on stream). */
  function parseWidth(raw) {
    const m = /^(\d{1,4}(?:\.\d{1,2})?)(px|%)?$/.exec((raw || '').trim());
    if (!m) return null;
    const n = Number(m[1]);
    return m[2] === '%' ? Math.min(100, Math.max(10, n)) + '%' : Math.min(4000, Math.max(120, n)) + 'px';
  }
  const width = parseWidth(q.get('width')) || (plain ? '100%' : preset.width);
  const alignRaw = q.get('align') || preset.align;
  const align = ['left', 'right', 'center'].includes(alignRaw) ? alignRaw : 'left';
  const orderRaw = q.get('order') || (plain ? 'bottom' : preset.order);
  const newestTop = orderRaw !== 'bottom';
  feed.style.setProperty('--ov-w', width);
  feed.style.setProperty('--ov-align', align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center');
  document.body.classList.toggle('order-top', newestTop);

  /** &pad=… : space kept clear around the chat, "all", or "top,right,bottom,left"; each a number with px or %, e.g. 5%,12%,20%,5%. */
  function parsePad(raw) {
    if (!raw) return null;
    const parts = raw.split(',').map(s => s.trim());
    if (parts.length !== 1 && parts.length !== 4) return null;
    const out = [];
    for (const p of parts) {
      const m = /^(\d{1,4}(?:\.\d{1,2})?)(px|%)?$/.exec(p);
      if (!m) return null;
      const n = Number(m[1]), pct = m[2] === '%';
      out.push(pct ? Math.min(40, n) + '%' : Math.min(1000, n) + 'px');
    }
    return out.join(' ');
  }
  const pad = parsePad(q.get('pad') || (plain ? '' : preset.pad));
  if (pad) feed.style.padding = pad;

  // &fit=1: the text grows and shrinks with the source, so one link reads the same in a landscape and a vertical scene.
  // Reference is a 480 px wide chat box; limited so a huge source doesn't get giant text nor a tiny one unreadable.
  function fitFactor() {
    if (!opt.fit) return 1;
    return Math.min(3, Math.max(0.75, window.innerWidth / 480));
  }
  function applySize() {
    const d = (settings && settings.display) || {};
    document.documentElement.style.setProperty('--fs', (opt.size || d.fontSize || 16) * fitFactor() + 'px');
    document.body.classList.toggle('narrow', window.innerWidth < 300 * (opt.fit ? fitFactor() : 1));
  }
  if (opt.fit) window.addEventListener('resize', applySize);

  // On a website (Settings → Copy embed adds embed=1): a quiet note while no message is showing, so a quiet chat doesn't
  // look broken to visitors (a new visitor has no history). Never in OBS, where it would show on stream.
  if (opt.embed) {
    const note = document.createElement('p');
    note.className = 'embed-note';
    note.textContent = 'No messages yet. Chat shows up here live as people talk.';
    document.body.appendChild(note);
    const update = () => note.classList.toggle('hidden', feed.children.length > 0);
    new MutationObserver(update).observe(feed, { childList: true });
    update();
  }

  let settings = null;

  function fadeSeconds() {
    if (opt.fade != null && !isNaN(opt.fade)) return opt.fade;
    return (settings && settings.display && settings.display.overlayFadeSec) || 0;
  }

  function wanted(e) {
    if (e.kind === 'system') return opt.system;
    if (opt.platforms && !opt.platforms.has(e.platform)) return false;
    if (e.kind === 'chat') return opt.chat;
    return opt.alerts;
  }

  // Alerts the chat page reads aloud appear there only once their voice is ready. The overlay (usually OBS, a separate
  // browser that can't see the chat page) can't know when that is, so it holds those alerts back a set time instead
  // (Settings → Display, 6 s by default) to land closer to the voice. It never speaks itself.
  const held = new Map(); // id → timer
  function holdSeconds(e) {
    if (!settings || e.missed || e.kind === 'chat' || e.kind === 'system') return 0;
    const sec = settings.display && settings.display.overlayVoiceDelaySec;
    if (!(sec > 0)) return 0;
    // "Read alerts aloud" may be off in the overlay's own link even when the chat page has it on, so only the kinds count.
    const s = Object.assign({}, settings, { tts: Object.assign({}, settings.tts, { enabled: true }) });
    return U.Speech.willRead(e, s) ? sec : 0;
  }

  function add(e, live) {
    if (!wanted(e)) return;
    const wait = live ? holdSeconds(e) : 0;
    if (wait) {
      if (held.has(e.id)) return;
      held.set(e.id, setTimeout(() => { held.delete(e.id); show(e, true); }, wait * 1000));
      return;
    }
    show(e, live);
  }

  function show(e, live) {
    // Only recent history on (re)load, so an old backlog doesn't flash up on stream.
    if (!live && fadeSeconds() > 0 && Date.now() - e.ts > fadeSeconds() * 1000) return;

    const cls = U.classify(e, settings);
    if (cls.hidden) return;
    const el = U.renderEvent(e, 'dark', cls);
    if (newestTop) {
      feed.prepend(el);
      // Older lines drop off the bottom once they no longer fit, or past the message limit.
      while (feed.children.length > opt.max) feed.lastElementChild.remove();
      while (feed.children.length > 1 && feed.scrollHeight > feed.clientHeight + 1) feed.lastElementChild.remove();
    } else {
      feed.appendChild(el);
      while (feed.children.length > opt.max) feed.firstElementChild.remove();
    }

    const fade = fadeSeconds();
    if (fade > 0) {
      const remaining = Math.max(1000, fade * 1000 - (live ? 0 : Date.now() - e.ts));
      setTimeout(() => { el.classList.add('gone'); setTimeout(() => el.remove(), 900); }, remaining);
    }
    if (live && opt.sound && !e.missed) U.Sound.forEvent(e, settings, cls); // missed ones (filled in after a reconnect) stay quiet

  }

  function applySettings(s) {
    settings = s;
    const d = s.display || {};
    applySize();
    document.body.classList.toggle('no-ts', !opt.ts);
    document.body.classList.toggle('no-pf', !d.showPlatformIcons);
    document.body.classList.toggle('no-badges', !d.showBadges);
    document.body.classList.toggle('no-avatars', !d.showAvatars);
    document.body.classList.toggle('no-platform-colors', d.platformColors === false);
    U.Sound.setMaster(s.alerts && s.alerts.masterVolume); // for ?sound=1
  }

  // OBS allows audio without a click, but try anyway in case it's opened in a normal browser.
  if (opt.sound) {
    U.Sound.unlock();
    document.addEventListener('pointerdown', () => U.Sound.unlock(), { passive: true });
  }

  U.connect('overlay', {
    onMessage(msg) {
      switch (msg.type) {
        case 'hello':
          applySettings(msg.settings);
          feed.innerHTML = '';
          held.forEach(clearTimeout);
          held.clear();
          (msg.history || []).forEach(e => add(e, false));
          break;
        case 'event':
          add(msg.event, true);
          break;
        case 'delete': case 'remove':
          (msg.ids || []).forEach(id => {
            if (held.has(id)) { clearTimeout(held.get(id)); held.delete(id); }
            const el = feed.querySelector(`.msg[data-id="${CSS.escape(id)}"]`);
            if (el) el.remove();
          });
          break;
        case 'clear': {
          let sel = `.msg.k-chat[data-platform="${CSS.escape(msg.platform)}"]`;
          if (msg.login) sel += `[data-user="${CSS.escape(String(msg.login).toLowerCase())}"]`;
          feed.querySelectorAll(sel).forEach(el => el.remove());
          break;
        }
        case 'settings':
          applySettings(msg.settings);
          break;
        case 'avatar':
          U.swapAvatar(msg.platform, msg.login, msg.url);
          break;
        case 'soundTest':
          if (opt.sound) U.Sound.play(msg.sound, msg.volume);
          break;
      }
    },
  });
})();
