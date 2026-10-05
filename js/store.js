/* UniChat Web settings: stored in this browser (localStorage). URL parameters can override them, which is how
   embeds work (e.g. overlay.html?twitch=name&tiktok=name&kick=name). Same shape as the desktop app's settings. */
(function () {
  'use strict';

  const KEY = 'unichat.web.settings';
  const PLATFORMS = ['twitch', 'tiktok', 'kick', 'velora', 'blaze', 'nimo', 'x'];

  function kind(sound, soundName, volume) {
    return { sound, soundName, volume, platforms: { twitch: true, tiktok: true, kick: true, velora: true, blaze: true, nimo: true, x: true } };
  }

  // This copy of UniChat opens on DalekCoffee's channels, so a new browser only needs the Euler key. A blank name means
  // "use the default"; each platform's switch in Settings turns it off.
  const DEFAULTS = {
    settingsVersion: 8, // bumped when a default changes in a way saved settings should follow (see migrate)
    twitch: { enabled: true, channel: 'dalekcoffee',
      catchUp: true }, // after a reconnect, fill in chat missed meanwhile (from recent-messages.robotty.de, see twitch.js)
    tikTok: { enabled: true, username: 'dalekcoffee', eulerKey: '', minGiftCoinsForSound: 0, showLikes: true, showShares: true, showJoins: true,
      joinsClearSec: 15, // "joined" lines leave the chat after this long (0 = keep them)
      ownKey: false }, // the relay's own username: connect with eulerKey instead of the relay (a backup for when it's down)
    kick: { enabled: true, channel: 'dalekcoffee', chatroomId: 0 }, // chatroomId: only when kick.com blocks the automatic lookup
    velora: { enabled: true, channel: 'dalek' },
    blaze: { enabled: true, channel: 'dalekcoffee' },
    // channel: a streamer's name, or the number from nimo.tv/live/<number>. roomId: the room picked in Settings → Find
    // (Nimo names aren't unique); it's only used while it belongs to that name. 0 = none picked.
    nimo: { enabled: true, channel: 'dalekcoffee', roomId: 1592342521 },
    // channel: a username, or a broadcast link kept as "i/broadcasts/<id>" (see normalizeX); read through the relay (x.js).
    // An empty field falls back to this name, like the other platforms (switch X off to stop it).
    x: { enabled: true, channel: 'dalekcoffee' },
    alerts: {
      // Settings → Alerts & voice → Volume: turns every sound and the voice up or down together, on top of each one's own
      // volume. 1 = as set (the slider shows 50%), 2 = twice as loud (100%). Separate from the voice's own volume (tts.volume).
      masterVolume: 1,
      kinds: {
        chat: kind(true, 'builtin:pop', 0.5),
        follow: kind(true, 'builtin:chime', 0.5),
        donation: kind(true, 'builtin:coins', 0.5),
        sub: kind(true, 'builtin:fanfare', 0.5),
        raid: kind(true, 'builtin:fanfare', 0.5),
      },
      chatSoundCooldownSec: 2,
      soundOnConnectionLost: true,
      connectionLostSound: 'builtin:error',
      connectionLostVolume: 0.5,
      soundOnConnectionStopped: true, // a platform ran out of reconnect tries (needs Reconnect)
      connectionStoppedSound: 'builtin:failed',
      connectionStoppedVolume: 0.5,
      // The first chat message after chat has been quiet for afterSec: vibrate the phone (where the browser can) and/or
      // play this sound instead of the usual chat sound, so it's harder to miss. Later messages are normal again.
      quietChat: { afterSec: 30, vibrate: true, sound: true, soundName: 'builtin:bell', volume: 0.5 },
    },
    filters: {
      hideCommands: true,
      hideBots: true,
      botNames: ['nightbot', 'streamelements', 'streamlabs', 'moobot', 'fossabot', 'wizebot', 'sery_bot', 'soundalerts',
        'blerp', 'streamerbot', 'own3d', 'pokemoncommunitygame', 'deepbot', 'phantombot', 'coebot', 'botisimo',
        'commanderroot', 'tangiabot', 'frostytoolsdotcom', 'restreambot', 'botrix', 'kicklet'],
      blockedUsers: [],
      blockedWords: [],
      hideSlurs: true, // the built-in list of the worst slurs (js/common.js SLURS), on top of blockedWords
    },
    highlights: { enabled: true, mentions: true, keywords: [], firstTimeChatters: true, sound: true, soundName: 'builtin:ding', volume: 0.5 },
    popup: { enabled: true, seconds: 18, kinds: { follow: false, donation: true, sub: true, raid: true } },
    // Stream preview button (chat page top bar): your stream in a popup, from Beam's player (beamstream.gg/<beam>/embed).
    // Loaded only while the popup is open. TikTok LIVE can't be shown inside other sites, so Beam is the one player.
    preview: { enabled: true, beam: 'dalek' },
    // volume: 0.9 is the usual level (the slider shows 50%), 1.8 twice as loud (100%).
    tts: { enabled: false, kinds: { follow: false, donation: true, sub: true, raid: false }, readNames: true, voice: 'kokoro:af_heart', rate: 1, volume: 0.9, maxChars: 200 },
    display: {
      fontSize: 16, showTimestamps: true, showAvatars: true, showPlatformIcons: true, showBadges: true,
      maxMessages: 300, theme: 'dark', overlayFadeSec: 30, overlayVoiceDelaySec: 6, alertsInChat: false, platformColors: true,
      panelLayout: 'auto', // alerts panel: 'auto' (right of chat; above it on narrow/portrait screens), 'side' or 'stacked' (the divider's ⇄ flips sides per device)
      removeDoneAfterSec: 30, // thanked alerts / answered questions leave the panel after this long (0 = keep them)
      keepAwake: false, // chat page: stop this device's screen from sleeping while the chat is showing
      showViewerCounts: false, // viewer counts next to each platform's status dot (off: never shown anywhere)
      thirdPartyEmotes: true, // 7TV, BetterTTV and FrankerFaceZ emotes in chat from every platform
      showGifs: true, // Twitch GIFs (GIPHY); off shows their caption instead and nothing is loaded from GIPHY
      missedHighlightSec: 15, // messages missed while away stay highlighted this long after they show (0 = until you leave again)
    },
  };

  // DalekCoffee's relay: a Cloudflare Worker that holds the Euler key for RELAY_TIKTOK_USER (so that TikTok needs no key in
  // the browser, and every screen shares one Euler connection) and passes a chat page's lines to the Resonite panel.
  // Built in rather than a setting, so a link or settings file can't point the page anywhere else. Empty = not set up
  // yet. It must also be listed in connect-src in index.html and overlay.html.
  const RELAY_URL = 'wss://unirelay.dalek.coffee';
  const RELAY_TIKTOK_USER = 'dalekcoffee'; // the only TikTok username the relay serves; anyone else uses their own Euler key
  const relayAddress = path => RELAY_URL.replace(/\/+$/, '') + path;
  /** True when the relay can serve this TikTok username (no Euler key needed). */
  const relayServes = username => !!RELAY_URL && normalizeTikTok(username).toLowerCase() === RELAY_TIKTOK_USER; // TikTok names ignore case
  /** True when these settings read TikTok through the relay: its username, unless "Use my own Euler key" is on. */
  const usesRelay = s => relayServes(s.tikTok.username || DEFAULTS.tikTok.username) && s.tikTok.ownKey !== true;

  // Resonite (Settings → Resonite): whether THIS device sends its chat to the relay, and the room it sends to. Kept apart
  // from the settings, so the room code never ends up in links, settings files or backups, and the other devices don't
  // send too. Room code: 16 characters picked at random in this browser (whoever has it may send to the room). Panel code:
  // 12 characters worked out from it, the one pasted into Resonite (it can only read). The relay works the panel code
  // out the same way (known answer: room K7MQ2ZPAXW4N8HRT → panel 8GCPKB5W995H).
  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I/L, so a code can be typed on another device
  const ROOM_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{16}$/;
  const RESONITE_KEY = 'unichat.web.resonite';
  const cleanRoom = v => (typeof v === 'string' ? v.replace(/[\s-]+/g, '').toUpperCase().slice(0, 40) : '');
  const resonite = {
    load() {
      let v = null;
      try { v = JSON.parse(localStorage.getItem(RESONITE_KEY) || 'null'); } catch { /* blocked or damaged */ }
      v = isObj(v) ? v : {};
      const room = cleanRoom(v.room);
      return { on: v.on === true, room: ROOM_CODE.test(room) ? room : '' };
    },
    save(v) {
      const room = cleanRoom(v.room);
      try { localStorage.setItem(RESONITE_KEY, JSON.stringify({ on: v.on === true, room: ROOM_CODE.test(room) ? room : '' })); }
      catch { throw new Error('This browser blocked saving (private mode?)'); }
    },
    STORAGE_KEY: RESONITE_KEY,
    cleanRoom,
    isRoom: v => ROOM_CODE.test(cleanRoom(v)),
    /** A new room code: 16 characters from CODE_CHARS, evenly random (bytes ≥ 248 are skipped, 248 = 8 × 31). An older
     *  8-character room no longer counts (it could be worked out from its panel code), so Settings makes a new one. */
    newRoom() {
      const out = [];
      const buf = new Uint8Array(32);
      while (out.length < 16) {
        crypto.getRandomValues(buf);
        for (const b of buf) if (b < 248 && out.length < 16) out.push(CODE_CHARS[b % CODE_CHARS.length]);
      }
      return out.join('');
    },
    /** The panel code for a room code: the first 12 bytes of SHA-256("unichat-panel:" + room), each modulo 31 into CODE_CHARS. */
    async panelCode(room) {
      const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`unichat-panel:${cleanRoom(room)}`)));
      let out = '';
      for (let i = 0; i < 12; i++) out += CODE_CHARS[h[i] % CODE_CHARS.length];
      return out;
    },
    /** The channels these settings read, as "platform:name". The relay keeps them only to tell a room's own streamer
     *  (same channels, another device) from someone else's page; it never sends them to anyone. */
    channels(s) {
      const out = [];
      const add = (p, on, name) => { if (on && name) out.push(`${p}:${String(name).toLowerCase()}`); };
      add('twitch', s.twitch.enabled, normalizeTwitch(s.twitch.channel || DEFAULTS.twitch.channel));
      add('tiktok', s.tikTok.enabled, normalizeTikTok(s.tikTok.username || DEFAULTS.tikTok.username));
      add('kick', s.kick.enabled, normalizeKick(s.kick.channel || DEFAULTS.kick.channel));
      add('velora', s.velora.enabled, normalizeVelora(s.velora.channel || DEFAULTS.velora.channel));
      add('blaze', s.blaze.enabled, normalizeBlaze(s.blaze.channel || DEFAULTS.blaze.channel));
      add('nimo', s.nimo.enabled, normalizeNimo(s.nimo.channel || DEFAULTS.nimo.channel));
      const x = normalizeX(s.x.channel || DEFAULTS.x.channel);
      add('x', s.x.enabled && /^[A-Za-z0-9_]{1,15}$/.test(x), x); // a username (a broadcast link isn't a channel)
      return out;
    },
  };

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

  /**
   * X: a username or a broadcast link. "https://x.com/SomeName" or "@SomeName" → "SomeName" (kept as typed: X names
   * ignore case); "https://twitter.com/i/broadcasts/1AbCdEfGhIjKl?s=20" → "i/broadcasts/1AbCdEfGhIjKl" (the ID is
   * case-sensitive). Any other x.com/i/… page (e.g. a Space) stays recognisably wrong, so the status says so (x.js).
   */
  function normalizeX(v) {
    const s = String(v || '').trim().replace(/^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:x|twitter)\.com(?:\/|$)/i, '').replace(/^@/, '');
    const [first, second = '', third = ''] = s.split(/[?#]/)[0].split('/');
    if (first.toLowerCase() !== 'i') return first.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40);
    return `i/${second.toLowerCase().replace(/[^a-z]/g, '')}/${third.replace(/[^A-Za-z0-9]/g, '')}`.slice(0, 60);
  }

  function normalize(s) {
    s.twitch.channel = normalizeTwitch(s.twitch.channel) || DEFAULTS.twitch.channel;
    s.tikTok.username = normalizeTikTok(s.tikTok.username) || DEFAULTS.tikTok.username;
    s.kick.channel = normalizeKick(s.kick.channel) || DEFAULTS.kick.channel;
    s.kick.chatroomId = Math.round(clamp(s.kick.chatroomId, 0, 1e12, 0));
    s.velora.channel = normalizeVelora(s.velora.channel) || DEFAULTS.velora.channel;
    s.blaze.channel = normalizeBlaze(s.blaze.channel) || DEFAULTS.blaze.channel;
    s.nimo.channel = normalizeNimo(s.nimo.channel) || DEFAULTS.nimo.channel;
    s.x.channel = normalizeX(s.x.channel) || DEFAULTS.x.channel;
    s.preview.beam = normalizeName(s.preview.beam, 'beamstream.gg') || DEFAULTS.preview.beam;
    s.nimo.roomId = Math.round(clamp(s.nimo.roomId, 0, 1e12, 0));
    s.tikTok.eulerKey = String(s.tikTok.eulerKey || '').trim();
    s.display.fontSize = Math.round(clamp(s.display.fontSize, 10, 48, 16));
    s.display.maxMessages = Math.round(clamp(s.display.maxMessages, 50, 2000, 300));
    s.display.overlayFadeSec = Math.round(clamp(s.display.overlayFadeSec, 0, 3600, 30));
    s.display.overlayVoiceDelaySec = Math.round(clamp(s.display.overlayVoiceDelaySec, 0, 120, 6));
    s.display.removeDoneAfterSec = Math.round(clamp(s.display.removeDoneAfterSec, 0, 3600, 30));
    s.display.missedHighlightSec = Math.round(clamp(s.display.missedHighlightSec, 0, 3600, 15));
    s.popup.seconds = Math.round(clamp(s.popup.seconds, 2, 60, 18));
    s.alerts.chatSoundCooldownSec = clamp(s.alerts.chatSoundCooldownSec, 0, 60, 2);
    s.alerts.quietChat.afterSec = Math.round(clamp(s.alerts.quietChat.afterSec, 5, 3600, 30));
    s.alerts.quietChat.volume = clamp(s.alerts.quietChat.volume, 0, 1, 0.6);
    s.alerts.masterVolume = clamp(s.alerts.masterVolume, 0, 2, 1);
    s.tts.volume = clamp(s.tts.volume, 0, 1.8, 0.9);
    s.tikTok.joinsClearSec = Math.round(clamp(s.tikTok.joinsClearSec, 0, 3600, 15));
    for (const k of KIND_KEYS.map(n => s.alerts.kinds[n])) {
      k.volume = clamp(k.volume, 0, 1, 0.7);
      for (const p of PLATFORMS) if (typeof k.platforms[p] !== 'boolean') k.platforms[p] = true;
    }
    for (const list of ['botNames', 'blockedUsers']) {
      s.filters[list] = [...new Set((s.filters[list] || []).map(x => String(x).trim().replace(/^@/, '').toLowerCase()).filter(Boolean))].slice(0, 500);
    }
    s.filters.blockedWords = [...new Set((s.filters.blockedWords || []).map(x => String(x).trim()).filter(Boolean))].slice(0, 500);
    s.highlights.keywords = [...new Set((s.highlights.keywords || []).map(x => String(x).trim()).filter(Boolean))].slice(0, 500);
    s.settingsVersion = DEFAULTS.settingsVersion;
    return sanitizeChoices(s);
  }

  /**
   * Saved settings (or a settings file) from before a default changed: values still at the old default move to the new
   * one; values someone picked stay. Saved settings store every value, so without this they'd keep the old default.
   */
  function migrate(s) {
    if (!isObj(s) || Number(s.settingsVersion) >= DEFAULTS.settingsVersion) return s;
    // v2 (0.0.15): the chat sound's default volume went from 45% to 80%.
    const chat = isObj(s.alerts) && isObj(s.alerts.kinds) && s.alerts.kinds.chat;
    if ((Number(s.settingsVersion) || 1) < 2 && isObj(chat) && chat.volume === 0.45) chat.volume = 0.8;
    // v3 (0.0.16): alerts show in the Alerts panel only, not in the chat too (Settings → Display turns them back on).
    if ((Number(s.settingsVersion) || 1) < 3 && isObj(s.display) && s.display.alertsInChat === true) s.display.alertsInChat = false;
    // v4 (0.0.17): alerts are read by Justin (StreamElements) unless another voice was picked.
    if ((Number(s.settingsVersion) || 1) < 4 && isObj(s.tts) && (s.tts.voice === '' || s.tts.voice === undefined)) s.tts.voice = 'se:Justin';
    // v5 (0.0.18): alert sounds got a louder base, so their default volumes moved to 50% (and the voice got quieter).
    if ((Number(s.settingsVersion) || 1) < 5 && isObj(s.alerts)) {
      const OLD = { chat: 0.8, follow: 0.7, donation: 0.8, sub: 0.8, raid: 0.8 };
      for (const [k, v] of Object.entries(OLD)) { const x = isObj(s.alerts.kinds) && s.alerts.kinds[k]; if (isObj(x) && x.volume === v) x.volume = 0.5; }
      if (s.alerts.connectionLostVolume === 0.6) s.alerts.connectionLostVolume = 0.5;
      if (s.alerts.connectionStoppedVolume === 0.7) s.alerts.connectionStoppedVolume = 0.5;
      if (isObj(s.alerts.quietChat) && s.alerts.quietChat.volume === 0.6) s.alerts.quietChat.volume = 0.5;
    }
    if ((Number(s.settingsVersion) || 1) < 5 && isObj(s.highlights) && s.highlights.volume === 0.6) s.highlights.volume = 0.5;
    // v6 (0.0.18): UniChat's own voice (Kokoro Heart) replaces the StreamElements voices, which now need a key.
    if ((Number(s.settingsVersion) || 1) < 6 && isObj(s.tts) && (s.tts.voice === '' || s.tts.voice === undefined || /^se:/.test(String(s.tts.voice)))) s.tts.voice = 'kokoro:af_heart';
    // v7 (0.0.20): sub messages are read aloud too ("Name says: …"), like donations.
    if ((Number(s.settingsVersion) || 1) < 7 && isObj(s.tts) && isObj(s.tts.kinds) && s.tts.kinds.sub === false) s.tts.kinds.sub = true;
    // v8 (0.0.32): TikTok joins and alert popups stay three times as long.
    if ((Number(s.settingsVersion) || 1) < 8 && isObj(s.tikTok) && s.tikTok.joinsClearSec === 5) s.tikTok.joinsClearSec = 15;
    if ((Number(s.settingsVersion) || 1) < 8 && isObj(s.popup) && s.popup.seconds === 6) s.popup.seconds = 18;
    return s;
  }

  function readSaved() {
    try { return migrate(JSON.parse(localStorage.getItem(KEY) || 'null')); } catch { return null; }
  }

  // ---------- Bookmarkable links ----------
  // Channel names go in the readable part (?twitch=…&tiktok=…&kick=…&velora=…&blaze=…&nimo=…&x=…). Every other setting you changed goes in a
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
   * Settings carried in the address bar: ?twitch=, ?tiktok=, ?kick=, ?velora=, ?blaze=, ?nimo=, ?x=, ?theme= and #s=<code>. The Euler key is only ever read
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
    if (q.has('x')) o.x = Object.assign(o.x || {}, { channel: q.get('x'), enabled: true });
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
    if (!validSound(s.alerts.connectionStoppedSound)) s.alerts.connectionStoppedSound = 'builtin:failed';
    if (!validSound(s.highlights.soundName)) s.highlights.soundName = 'builtin:ding';
    if (!validSound(s.alerts.quietChat.soundName)) s.alerts.quietChat.soundName = 'builtin:bell';
    s.tts.voice = typeof s.tts.voice === 'string' ? s.tts.voice.slice(0, 200) : '';
    return s;
  }

  function hasUrlConfig() {
    const q = new URLSearchParams(location.search);
    return ['twitch', 'tiktok', 'kick', 'velora', 'blaze', 'nimo', 'x', 'theme'].some(k => q.has(k)) || /(^#|&)s=/.test(location.hash);
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
    if (s.x.channel) q.set('x', s.x.channel);
    const rest = clone(s);
    delete rest.twitch.channel;
    delete rest.tikTok.username;
    delete rest.kick.channel;
    delete rest.velora.channel;
    delete rest.blaze.channel;
    delete rest.nimo.channel;
    delete rest.x.channel;
    if (includeKey && rest.tikTok.eulerKey && !usesRelay(s)) {
      // keep it (after the #, so it's never sent to the website); links that use the relay don't need it
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
    delete base.x.channel;
    const changed = diff(rest, base) || {};
    // The picked Nimo room always travels with the name (?nimo= alone means "search by name").
    if (s.nimo.roomId) changed.nimo = Object.assign(changed.nimo || {}, { roomId: s.nimo.roomId });
    const dir = location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '');
    const query = q.toString();
    return `${dir}${page}${query ? '?' + query : ''}${Object.keys(changed).length ? '#s=' + encode(changed) : ''}`;
  }

  /** Settings in effect on this page: defaults ← saved ← URL parameters. */
  function load() {
    const saved = merge(DEFAULTS, readSaved());
    const s = merge(saved, urlOverrides());
    // Hidden users add up: the list a link carries never un-hides someone hidden in this browser, so "Hide this user"
    // and the Resonite panel's hide also work on pages opened from a link.
    s.filters.blockedUsers = saved.filters.blockedUsers.concat(s.filters.blockedUsers);
    return normalize(s);
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
    if (!isObj(parsed) || !(isObj(parsed.twitch) || isObj(parsed.tikTok) || isObj(parsed.kick) || isObj(parsed.velora) || isObj(parsed.blaze) || isObj(parsed.nimo) || isObj(parsed.x) || isObj(parsed.display))) throw new Error('Not a UniChat settings file');
    return save(merge(loadSaved(), migrate(parsed)));
  }

  window.UniChatStore = { KEY, DEFAULTS, RELAY_URL, RELAY_TIKTOK_USER, relayAddress, relayServes, usesRelay, resonite, load, loadSaved, save, exportJson, importJson, normalizeTwitch, normalizeTikTok, normalizeKick, normalizeVelora, normalizeBlaze, normalizeNimo, normalizeX, shareUrl, hasUrlConfig };
})();
