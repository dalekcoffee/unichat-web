/* OBS overlay: transparent background, newest at the bottom, messages fade out. */
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
  };

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

  function add(e, live) {
    if (!wanted(e)) return;
    // Only recent history on (re)load, so an old backlog doesn't flash up on stream.
    if (!live && fadeSeconds() > 0 && Date.now() - e.ts > fadeSeconds() * 1000) return;

    const cls = U.classify(e, settings);
    if (cls.hidden) return;
    const el = U.renderEvent(e, 'dark', cls);
    feed.appendChild(el);
    while (feed.children.length > opt.max) feed.firstElementChild.remove();

    const fade = fadeSeconds();
    if (fade > 0) {
      const remaining = Math.max(1000, fade * 1000 - (live ? 0 : Date.now() - e.ts));
      setTimeout(() => { el.classList.add('gone'); setTimeout(() => el.remove(), 900); }, remaining);
    }
    if (live && opt.sound) U.Sound.forEvent(e, settings, cls);
  }

  function applySettings(s) {
    settings = s;
    const d = s.display || {};
    document.documentElement.style.setProperty('--fs', (opt.size || d.fontSize || 16) + 'px');
    document.body.classList.toggle('no-ts', !opt.ts);
    document.body.classList.toggle('no-pf', !d.showPlatformIcons);
    document.body.classList.toggle('no-badges', !d.showBadges);
    document.body.classList.toggle('no-avatars', !d.showAvatars);
    document.body.classList.toggle('no-platform-colors', d.platformColors === false);
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
          (msg.history || []).forEach(e => add(e, false));
          break;
        case 'event':
          add(msg.event, true);
          break;
        case 'delete': case 'remove':
          (msg.ids || []).forEach(id => {
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
