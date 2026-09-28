/* UniChat Web settings: stored in this browser (localStorage). URL parameters can override them, which is how
   embeds work (e.g. overlay.html?twitch=name&tiktok=name&kick=name). Same shape as the desktop app's settings. */
(function () {
  'use strict';

  const KEY = 'unichat.web.settings';
  const PLATFORMS = ['twitch', 'tiktok', 'kick', 'velora', 'blaze', 'nimo'];

  function kind(sound, soundName, volume) {
    return { sound, soundName, volume, platforms: { twitch: true, tiktok: true, kick: true, velora: true, blaze: true, nimo: true } };
  }

  // This copy of UniChat opens on DalekCoffee's channels, so a new browser only needs the Euler key. A blank name means
  // "use the default"; each platform's switch in Settings turns it off.
  const DEFAULTS = {
    twitch: { enabled: true, channel: 'dalekcoffee' },
    tikTok: { enabled: true, username: 'dalekcoffee', eulerKey: '', minGiftCoinsForSound: 0, showLikes: false, showShares: false, showJoins: false,
      useRelay: false }, // experimental: read TikTok through your own Cloudflare relay (RELAY_URL below) instead of from this browser
    kick: { enabled: true, channel: 'dalekcoffee', chatroomId: 0 }, // chatroomId: only when kick.com blocks the automatic lookup
    velora: { enabled: true, channel: 'dalek' },
    blaze: { enabled: true, channel: 'dalekcoffee' },
    // channel: a streamer's name, or the number from nimo.tv/live/<number>. roomId: the room picked in Settings → Find
    // (Nimo names aren't unique); it's only used while it belongs to that name. 0 = none picked.
    nimo: { enabled: true, channel: 'dalekcoffee', roomId: 1592342521 },
    alerts: {
      kinds: {
        chat: kind(true, 'builtin:pop', 0.45),
        follow: kind(true, 'builtin:chime', 0.7),
        donation: kind(true, 'builtin:coins', 0.8),
        sub: kind(true, 'builtin:fanfare', 0.8),
        raid: kind(true, 'builtin:fanfare', 0.8),
      },
      chatSoundCooldownSec: 2,
      soundOnConnectionLost: true,
      connectionLostSound: 'builtin:error',
      connectionLostVolume: 0.6,
    },
    filters: {
      hideCommands: true,
      hideBots: true,
      botNames: ['nightbot', 'streamelements', 'streamlabs', 'moobot', 'fossabot', 'wizebot', 'sery_bot', 'soundalerts',
        'blerp', 'streamerbot', 'own3d', 'pokemoncommunitygame', 'deepbot', 'phantombot', 'coebot', 'botisimo',
        'commanderroot', 'tangiabot', 'frostytoolsdotcom', 'restreambot', 'botrix', 'kicklet'],
      blockedUsers: [],
      blockedWords: [],
    },
    highlights: { enabled: true, mentions: true, keywords: [], firstTimeChatters: true, sound: true, soundName: 'builtin:ding', volume: 0.6 },
    popup: { enabled: true, seconds: 6, kinds: { follow: false, donation: true, sub: true, raid: true } },
    tts: { enabled: false, kinds: { donation: true, sub: false }, readNames: true, voice: '', rate: 1, volume: 0.9, maxChars: 200 },
    display: {
      fontSize: 16, showTimestamps: true, showAvatars: true, showPlatformIcons: true, showBadges: true,
      maxMessages: 300, theme: 'dark', overlayFadeSec: 30, alertsInChat: true, platformColors: true,
      panelLayout: 'auto', // alerts panel: 'auto' (right of chat; above it on narrow/portrait screens), 'side' or 'stacked' (the divider's ⇄ flips sides per device)
      removeDoneAfterSec: 30, // thanked alerts / answered questions leave the panel after this long (0 = keep them)
      keepAwake: false, // chat page: stop this device's screen from sleeping while the chat is showing
      showViewerCounts: false, // viewer counts next to each platform's status dot (off: never shown anywhere)
      thirdPartyEmotes: true, // 7TV, BetterTTV and FrankerFaceZ emotes in chat from every platform
      showGifs: true, // Twitch GIFs (GIPHY); off shows their caption instead and nothing is loaded from GIPHY
    },
  };

  // Experimental TikTok relay: a Cloudflare Worker that holds the Euler key and shares one Euler connection. Built in rather
  // than a setting, so a link or settings file can't point the page anywhere else. Empty = not set up yet. It must also be
  // listed in connect-src in index.html and overlay.html.
  const RELAY_URL = '';

  const KIND_KEYS = Object.keys(DEFAULTS.alerts.kinds);
  const clone = o => JSON.parse(JSON.stringify(o));
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

  // Keys that could tamper with JavaScript objects if they arrived in a crafted link or settings file.
  const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

  /** Deep-merge saved values over defaults so new settings always have a value. */
  function merge(base, over) {
    if (!isObj(over)) return clone(base);
    const out = clone(base);
    for (const [k, v] of Object.entries(over)) {
      if (UNSAFE_KEYS.has(k) || v === undefined) continue;
      // Only settings UniChat has: anything else in a link or file (e.g. an old desktop-app setting) is dropped, so it
      // can't reach code that expects a different type.
      if (!Object.prototype.hasOwnProperty.call(out, k)) continue;
      // Keep the shape of known settings: a group stays a group, a list stays a list, a value stays a value.
      const known = out[k];
      if (isObj(known)) { if (isObj(v)) out[k] = merge(known, v); continue; }
      if (Array.isArray(known) !== Array.isArray(v)) continue;
      if (known !== undefined && !Array.isArray(known) && typeof known !== typeof v) continue; // e.g. text where a number belongs
      out[k] = v;
    }
    return out;
  }

  const clamp = (n, lo, hi, d) => { n = Number(n); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

  function normalizeTwitch(v) {
    let s = String(v || '').trim();
    const i = s.toLowerCase().indexOf('twitch.tv/');
    if (i >= 0) s = s.slice(i + 10);
    s = s.replace(/^[#@]/, '').split(/[/?#]/)[0].toLowerCase().replace(/[^a-z0-9_]/g, '');
    return s.slice(0, 25);
  }

  function normalizeTikTok(v) {
    let s = String(v || '').trim();
    const i = s.toLowerCase().indexOf('tiktok.com/@');
    if (i >= 0) s = s.slice(i + 12);
    return s.replace(/^@/, '').split(/[/?#]/)[0].replace(/[^A-Za-z0-9._]/g, '').slice(0, 40);
  }

  /** "https://kick.com/Some_Name" → "some-name" (Kick's links use - where names have _). */
  function normalizeKick(v) {
    let s = String(v || '').trim();
    const i = s.toLowerCase().indexOf('kick.com/');
    if (i >= 0) s = s.slice(i + 9);
    s = s.replace(/^[@/]+/, '').split(/[/?#]/)[0].toLowerCase().replace(/_/g, '-');
    return s.replace(/[^a-z0-9-]/g, '').slice(0, 40);
  }

  /** "https://velora.tv/SomeName" or "https://blaze.stream/some_name" → the lowercase name. */
  function normalizeName(v, host) {
    let s = String(v || '').trim();
    const i = s.toLowerCase().indexOf(host + '/');
    if (i >= 0) s = s.slice(i + host.length + 1);
    return s.replace(/^[@/]+/, '').split(/[/?#]/)[0].toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  }
  const normalizeVelora = v => normalizeName(v, 'velora.tv');
  const normalizeBlaze = v => normalizeName(v, 'blaze.stream');

  /**
   * Nimo streamers are found by nickname (any letters, spaces allowed) or room number: "https://www.nimo.tv/live/123" → "123",
   * "nimo.tv/SomeName" → "SomeName".
   */
  function normalizeNimo(v) {
    let s = String(v || '').normalize('NFKC').trim();
    const i = s.toLowerCase().indexOf('nimo.tv/');
    if (i >= 0) s = s.slice(i + 8).replace(/^live\//i, '').split(/[/?#]/)[0];
    return s.replace(/^@/, '').replace(/[\p{C}<>"'`\\]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  }

  function normalize(s) {
    s.twitch.channel = normalizeTwitch(s.twitch.channel) || DEFAULTS.twitch.channel;
    s.tikTok.username = normalizeTikTok(s.tikTok.username) || DEFAULTS.tikTok.username;
    s.kick.channel = normalizeKick(s.kick.channel) || DEFAULTS.kick.channel;
    s.kick.chatroomId = Math.round(clamp(s.kick.chatroomId, 0, 1e12, 0));
    s.velora.channel = normalizeVelora(s.velora.channel) || DEFAULTS.velora.channel;
    s.blaze.channel = normalizeBlaze(s.blaze.channel) || DEFAULTS.blaze.channel;
    s.nimo.channel = normalizeNimo(s.nimo.channel) || DEFAULTS.nimo.channel;
    s.nimo.roomId = Math.round(clamp(s.nimo.roomId, 0, 1e12, 0));
    s.tikTok.eulerKey = String(s.tikTok.eulerKey || '').trim();
    s.display.fontSize = Math.round(clamp(s.display.fontSize, 10, 48, 16));
    s.display.maxMessages = Math.round(clamp(s.display.maxMessages, 50, 2000, 300));
    s.display.overlayFadeSec = Math.round(clamp(s.display.overlayFadeSec, 0, 3600, 30));
    s.display.removeDoneAfterSec = Math.round(clamp(s.display.removeDoneAfterSec, 0, 3600, 30));
    s.popup.seconds = Math.round(clamp(s.popup.seconds, 2, 60, 6));
    s.alerts.chatSoundCooldownSec = clamp(s.alerts.chatSoundCooldownSec, 0, 60, 2);
    for (const k of KIND_KEYS.map(n => s.alerts.kinds[n])) {
      k.volume = clamp(k.volume, 0, 1, 0.7);
      for (const p of PLATFORMS) if (typeof k.platforms[p] !== 'boolean') k.platforms[p] = true;
    }
    for (const list of ['botNames', 'blockedUsers']) {
      s.filters[list] = [...new Set((s.filters[list] || []).map(x => String(x).trim().replace(/^@/, '').toLowerCase()).filter(Boolean))].slice(0, 500);
    }
    s.filters.blockedWords = [...new Set((s.filters.blockedWords || []).map(x => String(x).trim()).filter(Boolean))].slice(0, 500);
    s.highlights.keywords = [...new Set((s.highlights.keywords || []).map(x => String(x).trim()).filter(Boolean))].slice(0, 500);
    return sanitizeChoices(s);
  }

  function readSaved() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
  }

  // ---------- Bookmarkable links ----------
  // Channel names go in the readable part (?twitch=…&tiktok=…&kick=…&velora=…&blaze=…&nimo=…). Every other setting you changed goes in a
  // compact code after "#s=". Browsers never send the part after "#" to the website, so it stays private.

  /** Only the values that differ from the defaults (keeps links short). */
  function diff(obj, base) {
    if (!isObj(obj) || !isObj(base)) return JSON.stringify(obj) === JSON.stringify(base) ? undefined : obj;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (UNSAFE_KEYS.has(k)) continue;
      const d = isObj(v) && isObj(base[k]) ? diff(v, base[k]) : (JSON.stringify(v) === JSON.stringify(base[k]) ? undefined : v);
      if (d !== undefined && !(isObj(d) && !Object.keys(d).length)) out[k] = d;
    }
    return Object.keys(out).length ? out : undefined;
  }

  function encode(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    let bin = '';
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function decode(str) {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
  }

  /**
   * Settings carried in the address bar: ?twitch=, ?tiktok=, ?kick=, ?velora=, ?blaze=, ?nimo=, ?theme= and #s=<code>. The Euler key is only ever read
   * from the #s= code: the part before # is sent to the web host (and can end up in its logs), the part after # isn't.
   */
  function urlOverrides() {
    const q = new URLSearchParams(location.search);
    const h = new URLSearchParams(location.hash.replace(/^#/, ''));
    let o = {};
    if (h.has('s')) {
      try { const decoded = decode(h.get('s')); if (isObj(decoded)) o = decoded; }
      catch { console.warn('UniChat: ignored an unreadable settings code in the link'); }
    }
    if (q.has('twitch')) o.twitch = Object.assign(o.twitch || {}, { channel: q.get('twitch'), enabled: true });
    if (q.has('tiktok')) o.tikTok = Object.assign(o.tikTok || {}, { username: q.get('tiktok'), enabled: true });
    if (q.has('kick')) o.kick = Object.assign(o.kick || {}, { channel: q.get('kick'), enabled: true });
    if (q.has('velora')) o.velora = Object.assign(o.velora || {}, { channel: q.get('velora'), enabled: true });
    if (q.has('blaze')) o.blaze = Object.assign(o.blaze || {}, { channel: q.get('blaze'), enabled: true });
    // A room picked for another name in this browser shouldn't follow a link to a different streamer.
    if (q.has('nimo')) o.nimo = Object.assign({ roomId: 0 }, o.nimo || {}, { channel: q.get('nimo'), enabled: true });
    if (q.get('theme') === 'light' || q.get('theme') === 'dark') o.display = Object.assign(o.display || {}, { theme: q.get('theme') });
    return o;
  }

  // Only known values for settings used in page styling/behaviour (a crafted link can't smuggle anything else in).
  function sanitizeChoices(s) {
    if (s.display.theme !== 'light') s.display.theme = 'dark';
    if (!['auto', 'side', 'stacked'].includes(s.display.panelLayout)) s.display.panelLayout = 'auto';
    const validSound = v => v === 'none' || (typeof v === 'string' && /^builtin:[a-z]{1,20}$/.test(v));
    for (const k of KIND_KEYS.map(n => s.alerts.kinds[n])) if (!validSound(k.soundName)) k.soundName = 'builtin:pop';
    if (!validSound(s.alerts.connectionLostSound)) s.alerts.connectionLostSound = 'builtin:error';
    if (!validSound(s.highlights.soundName)) s.highlights.soundName = 'builtin:ding';
    s.tts.voice = typeof s.tts.voice === 'string' ? s.tts.voice.slice(0, 200) : '';
    return s;
  }

  function hasUrlConfig() {
    const q = new URLSearchParams(location.search);
    return ['twitch', 'tiktok', 'kick', 'velora', 'blaze', 'nimo', 'theme'].some(k => q.has(k)) || /(^#|&)s=/.test(location.hash);
  }

  /**
   * A link that recreates these settings on any device: `page` is "index.html" or "overlay.html".
   * The Euler key is only included when asked (anyone with the link could use your free quota).
   */
  function shareUrl(settings, page, includeKey, extraQuery) {
    const s = normalize(merge(DEFAULTS, settings));
    const q = new URLSearchParams(extraQuery || '');
    if (s.twitch.channel) q.set('twitch', s.twitch.channel);
    if (s.tikTok.username) q.set('tiktok', s.tikTok.username);
    if (s.kick.channel) q.set('kick', s.kick.channel);
    if (s.velora.channel) q.set('velora', s.velora.channel);
    if (s.blaze.channel) q.set('blaze', s.blaze.channel);
    if (s.nimo.channel) q.set('nimo', s.nimo.channel);
    const rest = clone(s);
    delete rest.twitch.channel;
    delete rest.tikTok.username;
    delete rest.kick.channel;
    delete rest.velora.channel;
    delete rest.blaze.channel;
    delete rest.nimo.channel;
    if (includeKey && rest.tikTok.eulerKey) {
      // keep it (after the #, so it's never sent to the website)
    } else {
      delete rest.tikTok.eulerKey;
    }
    const base = clone(DEFAULTS);
    delete base.twitch.channel;
    delete base.tikTok.username;
    delete base.tikTok.eulerKey;
    delete base.kick.channel;
    delete base.velora.channel;
    delete base.blaze.channel;
    delete base.nimo.channel;
    const changed = diff(rest, base) || {};
    // The picked Nimo room always travels with the name (?nimo= alone means "search by name").
    if (s.nimo.roomId) changed.nimo = Object.assign(changed.nimo || {}, { roomId: s.nimo.roomId });
    const dir = location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '');
    const query = q.toString();
    return `${dir}${page}${query ? '?' + query : ''}${Object.keys(changed).length ? '#s=' + encode(changed) : ''}`;
  }

  /** Settings in effect on this page: defaults ← saved ← URL parameters. */
  function load() {
    return normalize(merge(merge(DEFAULTS, readSaved()), urlOverrides()));
  }

  /** Saved settings only (for the settings page; URL overrides not baked in). */
  function loadSaved() {
    return normalize(merge(DEFAULTS, readSaved()));
  }

  function save(settings) {
    const s = normalize(merge(DEFAULTS, settings));
    try { localStorage.setItem(KEY, JSON.stringify(s)); }
    catch { throw new Error('This browser blocked saving settings (private mode?)'); }
    return s;
  }

  /**
   * Settings as a backup file. Without the Euler key the field is left out entirely, so loading that file
   * later keeps whatever key is already saved in that browser.
   */
  function exportJson(settings, includeKey) {
    const s = normalize(merge(DEFAULTS, settings));
    if (!includeKey || !s.tikTok.eulerKey) delete s.tikTok.eulerKey;
    return JSON.stringify({ app: 'UniChat Web', exported: new Date().toISOString(), settings: s }, null, 2);
  }

  function importJson(text) {
    if (text.length > 2000000) throw new Error('File is too big to be UniChat settings');
    let parsed = JSON.parse(text);
    if (isObj(parsed) && isObj(parsed.settings)) parsed = parsed.settings; // current format (older files were the bare settings)
    if (!isObj(parsed) || !(isObj(parsed.twitch) || isObj(parsed.tikTok) || isObj(parsed.kick) || isObj(parsed.velora) || isObj(parsed.blaze) || isObj(parsed.nimo) || isObj(parsed.display))) throw new Error('Not a UniChat settings file');
    return save(merge(loadSaved(), parsed));
  }

  window.UniChatStore = { KEY, DEFAULTS, RELAY_URL, load, loadSaved, save, exportJson, importJson, normalizeTwitch, normalizeTikTok, normalizeKick, normalizeVelora, normalizeBlaze, normalizeNimo, shareUrl, hasUrlConfig };
})();
