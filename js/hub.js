/* UniChat Web hub: everything the desktop app's server did, running in this browser tab.
   - connects to each platform (connectors registered by twitch.js, tiktok.js, kick.js, velora.js, blaze.js and nimo.js) with forever-retry backoff
   - keeps chat history, alerts, questions, pins and "thanked" state (saved per browser)
   - speaks the same message protocol as the desktop server, so the dashboard/overlay code is shared. */
(function () {
  'use strict';

  const Store = window.UniChatStore;
  const HISTORY = 300, ALERTS = 200, QUESTIONS = 100, PINS = 50;
  const ALERT_KINDS = ['follow', 'donation', 'sub', 'raid', 'redemption', 'hype'];
  const PANEL_KEY = 'unichat.web.panel';
  const VIEWERS_KEY = 'unichat.web.viewers';
  const HISTORY_KEY = 'unichat.web.history'; // this tab's recent chat (sessionStorage: gone when the tab closes)
  const LEARNING_MS = 6 * 3600 * 1000;
  const BACKOFF = [2, 4, 8, 15, 30, 60];
  const RECONNECT_NOTE_MS = 5000; // "connection lost" + "reconnected" lines leave the chat this long after it's back

  const state = {
    settings: Store.load(),
    statuses: new Map(),
    history: [],
    alerts: [],
    questions: [],
    pins: [],
    done: new Map(),      // id → when the alert was thanked / the question answered
    users: new Map(),     // this session's per-viewer stats (viewer card)
    dedupe: new Map(),
  };
  const clients = new Set();
  const connectors = [];
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('unichat') : null;
  let started = false;
  let seq = 0;

  const now = () => Date.now();
  // What the chatter typed: text, plus 7TV/BTTV/FFZ emote names (they're words turned into pictures).
  const text = e => (e.parts || []).filter(p => p.t === 'text' || (p.t === 'emote' && p.typed)).map(p => p.v).join('');

  // ---------- Per-browser persistence (panel lists, first-seen memory) ----------
  function readJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; } catch { return fallback; }
  }
  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* full or blocked: not fatal */ }
  }
  // Saved lists come from this browser's storage: damaged entries are skipped and the rest tidied like live events,
  // so a bad entry can never stop UniChat from starting. (Runs once the tidying code below is ready.)
  const events = (list, max) => (Array.isArray(list) ? list : [])
    .filter(e => e && typeof e === 'object' && !Array.isArray(e) && typeof e.id === 'string' && typeof e.kind === 'string' && typeof e.platform === 'string')
    .slice(-max).map(tidyEvent);

  function restoreSaved() {
    const saved = readJson(PANEL_KEY, {}) || {};
    state.alerts = events(saved.alerts, ALERTS);
    state.questions = events(saved.questions, QUESTIONS);
    state.pins = events(saved.pins, PINS);
    for (const d of Array.isArray(saved.done) ? saved.done : []) {
      if (Array.isArray(d) && typeof d[0] === 'string' && Number.isFinite(d[1])) state.done.set(d[0], d[1]);
      else if (typeof d === 'string') state.done.set(d, now()); // saved before ticks had times
    }
  }

  // The chat page keeps its recent messages for as long as its tab is open, so a reload, or opening Settings in the
  // same tab, doesn't wipe the chat. Session storage is per tab and cleared when the tab closes. The overlay starts fresh.
  let keepHistory = false;
  let historyTimer = null;
  function restoreHistory() {
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(HISTORY_KEY) || 'null'); } catch { /* blocked or damaged: start empty */ }
    const known = new Set(state.history.map(e => e.id));
    state.history = events(saved, HISTORY).filter(e => !known.has(e.id)).concat(state.history).slice(-HISTORY);
  }
  function saveHistory() {
    clearTimeout(historyTimer);
    historyTimer = null;
    if (!keepHistory) return;
    try { sessionStorage.setItem(HISTORY_KEY, JSON.stringify(state.history)); } catch { /* full or blocked: not fatal */ }
  }
  function saveHistorySoon() { if (keepHistory && !historyTimer) historyTimer = setTimeout(saveHistory, 2000); }
  window.addEventListener('pagehide', saveHistory);

  let panelTimer = null;
  function savePanelSoon() {
    clearTimeout(panelTimer);
    panelTimer = setTimeout(() => {
      const ids = new Set([...state.alerts, ...state.questions].map(e => e.id));
      writeJson(PANEL_KEY, { alerts: state.alerts, questions: state.questions, pins: state.pins, done: [...state.done].filter(([id]) => ids.has(id)) });
    }, 1500);
  }

  // First-seen memory: platform → { since, users: { login: time } }. Damaged entries are dropped.
  const viewers = Object.create(null);
  for (const [p, mem] of Object.entries(readJson(VIEWERS_KEY, {}) || {})) {
    if (mem && typeof mem === 'object' && Number.isFinite(mem.since) && mem.users && typeof mem.users === 'object' && !Array.isArray(mem.users)) {
      viewers[p] = { since: mem.since, users: Object.assign(Object.create(null), mem.users) };
    }
  }
  let viewersDirty = false;
  setInterval(() => { if (viewersDirty) { viewersDirty = false; writeJson(VIEWERS_KEY, viewers); } }, 30000);
  window.addEventListener('pagehide', () => { if (viewersDirty) writeJson(VIEWERS_KEY, viewers); });

  /** Remembers who has chatted before; returns true for a first-ever message (after a learning period). */
  const viewerCounts = Object.create(null); // platform → how many are remembered (counted once, then kept up to date)
  function recordViewer(platform, login) {
    const mem = viewers[platform] || (viewers[platform] = { since: now(), users: Object.create(null) });
    if (mem.users[login]) return false;
    if (viewerCounts[platform] === undefined) viewerCounts[platform] = Object.keys(mem.users).length;
    if (viewerCounts[platform] >= 20000) return false;
    viewerCounts[platform]++;
    mem.users[login] = now();
    viewersDirty = true;
    return now() - mem.since >= LEARNING_MS;
  }

  // ---------- Fan-out to the page(s) in this tab ----------
  function broadcast(msg) {
    for (const c of clients) {
      try { c.handlers.onMessage(msg); } catch (err) { console.error('UniChat:', err); }
    }
  }

  function addCapped(list, e, max) {
    list.push(e);
    while (list.length > max) {
      const gone = list.shift();
      if (list !== state.history) state.done.delete(gone.id);
    }
  }

  /** Quiet one-line notes (likes, joins, shares, free gifts) aren't chatting: they don't count as messages or "seen chatting". */
  const isNote = e => e.kind === 'chat' && e.silent === true && !!e.title && !text(e).trim();

  function isQuestion(e) {
    if (e.kind !== 'chat' || (e.user && (e.user.roles || []).includes('broadcaster'))) return false;
    const t = text(e).trim();
    return t.length >= 8 && t.includes('?') && !t.startsWith('!');
  }

  function trackUser(e) {
    if (!e.user || !e.user.login || e.kind === 'hype') return;
    const key = `${e.platform}:${String(e.user.login).toLowerCase()}`;
    let u = state.users.get(key);
    if (!u) {
      if (state.users.size > 20000) state.users.delete(state.users.keys().next().value);
      u = { platform: e.platform, login: String(e.user.login).toLowerCase(), firstAt: e.ts, firstTimeChatter: false, recent: [],
        totals: { messages: 0, follows: 0, subs: 0, giftedSubs: 0, bits: 0, coins: 0, kicks: 0, diamonds: 0, raids: 0, raidViewers: 0, redemptions: 0, money: Object.create(null) } };
      state.users.set(key, u);
    }
    Object.assign(u, { name: e.user.name, avatar: e.user.avatar || u.avatar, color: e.user.color || u.color, roles: e.user.roles || [], lastAt: e.ts });
    const t = u.totals;
    const v = Number(e.value || 0);
    switch (e.kind) {
      case 'chat':
        if (isNote(e)) break;
        t.messages++;
        if (e.firstTime) u.firstTimeChatter = true;
        if (text(e).trim()) { u.recent.push({ ts: e.ts, text: text(e).slice(0, 300) }); if (u.recent.length > 20) u.recent.shift(); }
        break;
      case 'follow': t.follows++; break;
      case 'sub': if (e.unit === 'gifts') t.giftedSubs += v || 1; else t.subs++; break;
      case 'raid': t.raids++; t.raidViewers += v; break;
      case 'donation':
        if (e.unit === 'bits') t.bits += v;
        else if (e.unit === 'coins') t.coins += v;
        else if (e.unit === 'KICKs') t.kicks += v;
        else if (e.unit === 'diamonds') t.diamonds = (t.diamonds || 0) + v;
        else if (e.unit && v > 0) t.money[e.unit] = (t.money[e.unit] || 0) + v;
        break;
    }
  }

  // ---------- Tidy incoming text ----------
  // Chat is always shown as plain text; this also removes tricks that mess with how it looks: direction-override
  // characters (make text appear reversed or leak into the next line), towers of stacked accent marks ("Zalgo"),
  // walls of blank lines, and absurdly long text.
  const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;
  const MARK_PILES = /(\p{M}{4})\p{M}+/gu;
  const BLANK_LINES = /(\r?\n\s*){2,}/g;
  const tidy = (s, max) => String(s == null ? '' : s).replace(BIDI_CONTROLS, '').replace(MARK_PILES, '$1').replace(BLANK_LINES, '\n').slice(0, max);

  // Pictures and emotes may only come from each platform's own image servers, so a relay (like Euler for TikTok) or a
  // future bug can't make this page load images, such as tracking pixels, from anywhere else.
  const IMAGE_HOSTS = {
    twitch: ['static-cdn.jtvnw.net'],
    tiktok: ['tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com', 'ibyteimg.com', 'byteimg.com', 'tiktokv.com', 'muscdn.com', 'eulerstream.com'],
    kick: ['kick.com'],
    velora: ['velora.tv'],
    blaze: ['blaze.stream'],
    nimo: ['nimostatic.tv', 'nimo.tv'],
  };
  const reportedHosts = new Set();
  function imageFor(platform, url) {
    if (typeof url !== 'string' || !url) return '';
    let host;
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' || u.username || u.password || u.port) return '';
      host = u.hostname.toLowerCase();
    } catch { return ''; }
    const hosts = Object.prototype.hasOwnProperty.call(IMAGE_HOSTS, platform) ? IMAGE_HOSTS[platform] : [];
    if (hosts.some(h => host === h || host.endsWith('.' + h))) return url;
    if (hosts.length && !reportedHosts.has(host) && reportedHosts.size < 50) {
      reportedHosts.add(host);
      hub.diagnostic(`${platform}: skipped a picture from ${host} (not one of the platform's image servers)`);
    }
    return '';
  }

  // Twitch GIFs are GIPHY's, served from its media servers (media.giphy.com, media0–4.giphy.com, i.giphy.com). Twitch
  // requires their address to be used exactly as sent, so it's checked here but never changed. With GIFs turned off in
  // Settings they arrive as their caption text, and nothing is loaded from GIPHY.
  const GIF_HOST = /^(?:media\d{0,2}|i)\.giphy\.com$/;
  const gifsOn = () => !(state.settings && state.settings.display && state.settings.display.showGifs === false);
  function gifUrl(platform, url) {
    if (platform !== 'twitch' || typeof url !== 'string' || !url || url.length > 2000) return '';
    let host;
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' || u.username || u.password || u.port) return '';
      host = u.hostname.toLowerCase();
    } catch { return ''; }
    if (GIF_HOST.test(host)) return url;
    if (!reportedHosts.has(host) && reportedHosts.size < 50) {
      reportedHosts.add(host);
      hub.diagnostic(`${platform}: skipped a GIF from ${host} (not one of GIPHY's media servers)`);
    }
    return '';
  }

  // 7TV, BetterTTV and FrankerFaceZ emotes (emotes.js) can appear in any platform's chat. Their addresses are built from
  // the emote's ID, so only these exact shapes are accepted (e.g. from chat saved in this tab).
  const SHARED_EMOTE = /^https:\/\/(cdn\.7tv\.app\/emote\/[A-Za-z0-9]{1,40}\/1x\.webp|cdn\.betterttv\.net\/emote\/[A-Za-z0-9]{1,40}\/1x\.webp|cdn\.betterttv\.net\/frankerfacez_emote\/\d{1,12}\/1)$/;
  const sharedEmoteUrl = url => (typeof url === 'string' && SHARED_EMOTE.test(url) ? url : '');

  // Values that become part of a line's CSS classes (saved events can be edited in the browser's storage).
  const EVENT_PLATFORMS = ['twitch', 'tiktok', 'kick', 'velora', 'blaze', 'nimo', 'youtube', 'system'];
  const EVENT_KINDS = ['chat', 'system', ...ALERT_KINDS];
  const LEVELS = ['info', 'ok', 'warn', 'error'];

  function tidyEvent(e) {
    if (!EVENT_PLATFORMS.includes(e.platform)) e.platform = 'system';
    if (!EVENT_KINDS.includes(e.kind)) e.kind = 'chat';
    if (e.level !== undefined && !LEVELS.includes(e.level)) e.level = 'info';
    if (e.user && typeof e.user === 'object' && !Array.isArray(e.user)) {
      e.user.name = tidy(e.user.name, 60);
      e.user.login = tidy(e.user.login, 60);
      if (!Array.isArray(e.user.roles)) e.user.roles = [];
      if (e.user.avatar !== undefined) e.user.avatar = imageFor(e.platform, e.user.avatar);
    } else if (e.user !== undefined) {
      e.user = null;
    }
    e.ts = Number(e.ts) > 0 ? Number(e.ts) : now();
    e.parts = (Array.isArray(e.parts) ? e.parts : []).slice(0, 400)
      .filter(p => p && typeof p === 'object')
      .map(p => {
        const v = tidy(p.v, p.t === 'emote' ? 100 : 1000);
        if (p.t === 'gif') {
          const url = gifsOn() && gifUrl(e.platform, p.url);
          return url ? { t: 'gif', v, url } : { t: 'text', v }; // otherwise its caption, e.g. "[Yes GIF by …]"
        }
        if (p.t !== 'emote') return { ...p, v };
        const url = (p.typed && sharedEmoteUrl(p.url)) || imageFor(e.platform, p.url);
        return url ? { ...p, v, url } : { t: 'text', v }; // an emote from anywhere else shows as its name
      });
    if (e.title != null) e.title = tidy(e.title, 200);
    if (e.amount != null) e.amount = tidy(e.amount, 60);
    if (e.reply && typeof e.reply === 'object') { e.reply.name = tidy(e.reply.name, 60); e.reply.text = tidy(e.reply.text, 300); }
    return e;
  }

  // A reply's quote (who and what it answers) is filled in by the replying chatter's app on some platforms (Velora's
  // docs show it), so it could be made up. Twitch fills it in itself; everywhere else the quote is only shown when
  // the answered message is one this page saw, using that message's real name and text.
  function checkReply(e) {
    if (!e.reply || e.platform === 'twitch') return;
    const parent = typeof e.reply.id === 'string' && state.history.find(x => x.id === e.reply.id && x.platform === e.platform);
    e.reply = parent && parent.user ? { id: parent.id, name: parent.user.name, text: text(parent).slice(0, 300) } : null;
  }

  // ---------- Stream recap ----------
  // Every follow, sub, gift, tip, raid and redemption this stream, for thanking people at the end (the Recap tab).
  // Kept in this browser. A new recap starts when you go live after being offline for 30 minutes (keeping the last
  // 10 minutes, so pre-stream follows count), or when you press "New recap". Test alerts are left out.
  const RECAP_KEY = 'unichat.web.recap';
  const RECAP_KINDS = ['follow', 'donation', 'sub', 'raid', 'redemption'];
  const RECAP_GAP_MS = 30 * 60000, RECAP_KEEP_MS = 10 * 60000, RECAP_MAX = 3000;
  // Units the connectors use (plus currency codes such as USD for Twitch Hype Chats); anything else is dropped.
  const recapUnit = u => (typeof u === 'string' && /^(bits|coins|KICKs|diamonds|gifts|viewers|money|[A-Z]{3})$/.test(u) ? u : '');
  const recap = (function loadRecap() {
    const r = readJson(RECAP_KEY, {}) || {};
    const n = v => (Number.isFinite(v) ? v : 0);
    const items = (Array.isArray(r.items) ? r.items : [])
      .filter(i => i && typeof i === 'object' && RECAP_KINDS.includes(i.kind) && typeof i.platform === 'string' && Number.isFinite(i.ts))
      .slice(-RECAP_MAX)
      .map(i => ({ platform: tidy(i.platform, 20), kind: i.kind, name: tidy(i.name, 60), login: tidy(i.login, 60), title: tidy(i.title, 200),
        amount: tidy(i.amount, 60), unit: recapUnit(i.unit), value: n(i.value), ts: i.ts }));
    return { startedAt: n(r.startedAt) || now(), lastLiveAt: n(r.lastLiveAt), items };
  })();
  let recapTimer = null;
  function recapChanged() {
    if (!recapTimer) recapTimer = setTimeout(() => { recapTimer = null; writeJson(RECAP_KEY, recap); broadcast({ type: 'recap' }); }, 1000);
  }
  window.addEventListener('pagehide', () => { if (recapTimer) writeJson(RECAP_KEY, recap); });

  function addToRecap(e) {
    const u = e.user || {};
    recap.items.push({ platform: e.platform, kind: e.kind, name: u.name || u.login || 'Someone', login: String(u.login || '').toLowerCase(),
      title: e.title || '', amount: e.amount || '', unit: recapUnit(e.unit), value: Number(e.value) || 0, ts: e.ts });
    if (recap.items.length > RECAP_MAX) recap.items.splice(0, recap.items.length - RECAP_MAX);
    recapChanged();
  }
  function startRecap(keepRecent) {
    const t = now();
    recap.items = keepRecent ? recap.items.filter(i => i.ts >= t - RECAP_KEEP_MS) : [];
    recap.startedAt = t;
    recapChanged();
  }
  /** A platform says you're live (also checked every minute while you are). */
  function noteLive() {
    const t = now();
    if (!recap.lastLiveAt || t - recap.lastLiveAt > RECAP_GAP_MS) startRecap(true);
    recap.lastLiveAt = t;
    recapChanged();
  }
  setInterval(() => { if (connectors.some(c => c.live === true)) noteLive(); }, 60000);

  // ---------- Emote words (emotes.js) and settings listeners ----------
  let emoteMatcher = null;           // parts → parts with 7TV/BTTV/FFZ emote words turned into pictures
  const settingsListeners = [];

  // ---------- Hub API used by connectors ----------
  const hub = {
    get settings() { return state.settings; },

    publish(e) {
      if (!e.id) e.id = `${e.platform}:local-${now().toString(36)}-${++seq}`; // unique across reloads (panel lists are saved)
      if (!e.ts) e.ts = now();
      tidyEvent(e);
      checkReply(e);
      if (emoteMatcher && e.kind !== 'system') e.parts = emoteMatcher(e.parts);
      const real = e.kind !== 'system' && e.platform !== 'system' && e.code !== 'test';
      if (real && e.kind === 'chat' && !isNote(e) && e.user && e.user.login) {
        const first = recordViewer(e.platform, String(e.user.login).toLowerCase());
        if (e.platform !== 'twitch' && !e.historical) e.firstTime = first;
      }
      if (real && !e.historical) hub.lastActivity[e.platform] = now();

      addCapped(state.history, e, HISTORY);
      saveHistorySoon();
      if (ALERT_KINDS.includes(e.kind)) { addCapped(state.alerts, e, ALERTS); savePanelSoon(); }
      if (real && !e.historical && isQuestion(e)) { addCapped(state.questions, e, QUESTIONS); savePanelSoon(); }
      if (real && !e.historical) trackUser(e);
      if (real && !e.historical && RECAP_KINDS.includes(e.kind)) addToRecap(e);
      broadcast({ type: 'event', event: e });
    },

    lastActivity: {},

    deleteMessages(platform, ids) {
      const set = new Set(ids);
      state.history = state.history.filter(e => !set.has(e.id));
      state.questions = state.questions.filter(e => !set.has(e.id));
      saveHistorySoon();
      broadcast({ type: 'delete', platform, ids });
    },

    /** Take lines out of the chat on this page (dismissed, or old connection notes). Alerts and questions stay in the panel. */
    removeLines(ids) {
      const set = new Set((ids || []).filter(id => typeof id === 'string'));
      if (!set.size) return;
      state.history = state.history.filter(e => !set.has(e.id));
      saveHistorySoon();
      broadcast({ type: 'remove', ids: [...set] });
    },

    clearUser(platform, login) {
      const l = login ? String(login).toLowerCase() : null;
      const match = e => e.platform === platform && e.kind === 'chat' && (!l || String((e.user && e.user.login) || '').toLowerCase() === l);
      state.history = state.history.filter(e => !match(e));
      state.questions = state.questions.filter(e => !match(e));
      saveHistorySoon();
      broadcast({ type: 'clear', platform, login });
    },

    isDuplicate(key, windowMs) {
      const t = now();
      if (state.dedupe.size > 5000) for (const [k, v] of state.dedupe) if (t - v > 600000) state.dedupe.delete(k);
      const last = state.dedupe.get(key);
      if (last && t - last < windowMs) return true;
      state.dedupe.set(key, t);
      return false;
    },

    setStatus(status) {
      const prev = state.statuses.get(status.id);
      const same = prev && ['label', 'state', 'detail', 'attempt', 'nextRetryAt', 'live', 'viewers', 'liveSince'].every(k => prev[k] === status[k]);
      if (same) return;
      status.since = prev && prev.state === status.state ? prev.since : now();
      state.statuses.set(status.id, status);
      const list = statusList();
      broadcast({ type: 'status', status: list });
      if (channel) channel.postMessage({ type: 'status', status: list });
    },

    /** A profile picture looked up after the viewer's messages were shown (Twitch chat doesn't include them). */
    setAvatar(platform, login, url) {
      url = imageFor(platform, url);
      if (!url) return;
      const l = String(login || '').toLowerCase();
      const theirs = e => e.platform === platform && e.user && String(e.user.login || '').toLowerCase() === l;
      state.history.forEach(e => { if (theirs(e)) e.user.avatar = url; });
      saveHistorySoon();
      let panel = false;
      for (const list of [state.alerts, state.questions, state.pins]) for (const e of list) if (theirs(e)) { e.user.avatar = url; panel = true; }
      const u = state.users.get(`${platform}:${l}`);
      if (u) u.avatar = url;
      if (panel) savePanelSoon();
      broadcast({ type: 'avatar', platform, login: l, url });
    },

    /** Raw event names seen from a platform (shown in Settings → Diagnostics to help tune parsers). */
    diagnostic(line) {
      if (channel) channel.postMessage({ type: 'diag', line: `${new Date().toLocaleTimeString()} ${line}` });
      console.debug('UniChat:', line);
    },
  };

  // ---------- Profile pictures looked up by username (Twitch and Kick chat don't include them) ----------
  /**
   * Looks one platform's profile pictures up in the background, remembers them in this browser for a week (a day
   * when there was none) and swaps them in on open pages as they arrive. Nothing is looked up while
   * Settings → Display → "Show profile pictures" is off.
   * lookup(logins, signal) resolves to a Map of login → picture URL (names left out have no picture) and throws when
   * the service fails, which pauses lookups for 2, 4, 8… up to 30 minutes. clean(url) returns '' for unusable URLs.
   */
  function avatarLookup({ platform, login: LOGIN, clean, lookup, batch = 1, gapMs = 500 }) {
    const KEY = `unichat.web.avatars.${platform}`;
    const LABEL = platform[0].toUpperCase() + platform.slice(1);
    const FRESH_MS = 7 * 86400000, RETRY_MS = 86400000, MAX_QUEUE = 500, MAX_KEPT = 3000;
    const cache = new Map();         // login → { url, at }, oldest first ('' = no picture found)
    const queue = new Set();
    const inflight = new Set();
    let timer = null, saveTimer = null, busy = false, pausedUntil = 0, failures = 0;

    const saved = readJson(KEY, []);
    for (const x of Array.isArray(saved) ? saved : []) {
      if (Array.isArray(x) && LOGIN.test(x[0]) && (x[1] === '' || clean(x[1]) === x[1]) && Number.isFinite(x[2])) cache.set(x[0], { url: x[1], at: x[2] });
    }

    function save() {
      clearTimeout(saveTimer);
      saveTimer = null;
      writeJson(KEY, [...cache].map(([l, v]) => [l, v.url, v.at]));
    }
    window.addEventListener('pagehide', () => { if (saveTimer) save(); });

    function remember(l, url) {
      cache.delete(l);
      cache.set(l, { url, at: now() });
      while (cache.size > MAX_KEPT) cache.delete(cache.keys().next().value);
      if (!saveTimer) saveTimer = setTimeout(save, 10000);
    }

    async function flush() {
      timer = null;
      if (busy || !queue.size) return;
      if (now() < pausedUntil) { timer = setTimeout(flush, pausedUntil - now()); return; }
      const names = [...queue].slice(0, batch);
      names.forEach(l => { queue.delete(l); inflight.add(l); });
      busy = true;
      const ac = new AbortController();
      const giveUp = setTimeout(() => ac.abort(), 15000);
      try {
        const found = await lookup(names, ac.signal);
        for (const l of names) {
          const url = clean(found.get(l));
          const before = cache.get(l);
          remember(l, url);
          if (url && (!before || before.url !== url)) hub.setAvatar(platform, l, url);
        }
        failures = 0;
      } catch (err) {
        // Names in a failed lookup are tried again the next time they chat, once the pause is over.
        failures++;
        const mins = Math.min(30, 2 ** failures);
        pausedUntil = now() + mins * 60000;
        hub.diagnostic(`${LABEL} profile pictures: lookup failed (${err.name === 'AbortError' ? 'timed out' : err.message}), trying again in ${mins} min`);
      } finally {
        clearTimeout(giveUp);
        names.forEach(l => inflight.delete(l));
        busy = false;
        if (queue.size && !timer) timer = setTimeout(flush, gapMs);
      }
    }

    /** The picture remembered for a viewer ('' if none yet). Looks it up in the background when missing or old. */
    function get(login) {
      const l = String(login || '').toLowerCase();
      if (!LOGIN.test(l) || !state.settings.display.showAvatars) return '';
      const hit = cache.get(l);
      const stale = !hit || now() - hit.at > (hit.url ? FRESH_MS : RETRY_MS);
      if (stale && !inflight.has(l) && queue.size < MAX_QUEUE) {
        queue.add(l);
        if (!timer && !busy) timer = setTimeout(flush, 750); // let a few more names arrive first
      }
      return hit ? hit.url : '';
    }

    return { get };
  }

  // ---------- Socket.IO over the browser's own WebSocket (Velora and Blaze use it; no library needed) ----------
  /**
   * Runs one Socket.IO v4 connection (text events, one namespace) until it closes, then rejects with a ConnectorError
   * so the connector loop reconnects; resolves quietly when `signal` aborts.
   * hooks.connected({ sid, emit, fail }) runs once the namespace is joined (it may be async; a thrown error ends the
   * connection); hooks.event(name, data) runs for every event.
   * Protocol: engine packets 0 open · 1 close · 2 ping → 3 pong · 4 message; socket packets 0 connect · 1 disconnect
   * · 2 event · 4 connect error, then "/namespace," (omitted for "/"), an optional ack id, and JSON.
   */
  function runSocketIo(url, namespace, signal, hooks) {
    const nsp = namespace && namespace !== '/' ? namespace : '/';
    const prefix = nsp === '/' ? '' : nsp + ',';
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${url}/socket.io/?EIO=4&transport=websocket`);
      let finished = false;
      let lastData = now();
      let deadAfter = 100000; // updated from the server's ping settings
      const watchdog = setInterval(() => { if (now() - lastData > deadAfter) finish(new ConnectorError('No data for too long')); }, 10000);

      function finish(err) {
        if (finished) return;
        finished = true;
        clearInterval(watchdog);
        try { ws.close(); } catch { /* already closed */ }
        if (err) reject(err); else resolve();
      }
      signal.addEventListener('abort', () => finish(), { once: true });

      const emit = (name, data) => { if (ws.readyState === WebSocket.OPEN) ws.send('42' + prefix + JSON.stringify([name, data])); };
      const fail = err => finish(err instanceof ConnectorError ? err : new ConnectorError((err && err.message) || String(err)));

      /** "4" + socket packet → { type, nsp, data } */
      function parse(m) {
        let i = 2;
        let packetNsp = '/';
        if (m[i] === '/') {
          const comma = m.indexOf(',', i);
          packetNsp = comma < 0 ? m.slice(i) : m.slice(i, comma);
          i = comma < 0 ? m.length : comma + 1;
        }
        while (i < m.length && m[i] >= '0' && m[i] <= '9') i++; // ack id
        let data;
        try { data = i < m.length ? JSON.parse(m.slice(i)) : undefined; } catch { data = undefined; }
        return { type: m[1], nsp: packetNsp, data };
      }

      ws.onmessage = ev => {
        lastData = now();
        const m = typeof ev.data === 'string' ? ev.data : '';
        switch (m[0]) {
          case '0': { // engine open: join the namespace
            try { const o = JSON.parse(m.slice(1)); deadAfter = (Number(o.pingInterval) || 25000) + (Number(o.pingTimeout) || 20000) + 15000; } catch { /* keep default */ }
            ws.send('40' + prefix);
            return;
          }
          case '1': fail(new ConnectorError('The server closed the connection')); return;
          case '2': ws.send('3'); return;
          case '4': break;
          default: return;
        }
        const p = parse(m);
        if (p.nsp !== nsp) return;
        if (p.type === '0') {
          const sid = p.data && typeof p.data.sid === 'string' ? p.data.sid : '';
          Promise.resolve().then(() => hooks.connected({ sid, emit, fail })).catch(fail);
        } else if (p.type === '2' && Array.isArray(p.data) && typeof p.data[0] === 'string') {
          try { hooks.event(p.data[0], p.data[1]); } catch (err) { console.warn('UniChat: skipped a chat event', err); }
        } else if (p.type === '4') {
          fail(new ConnectorError(`The chat server refused the connection${p.data && p.data.message ? ': ' + String(p.data.message).slice(0, 120) : ''}`));
        } else if (p.type === '1') {
          fail(new ConnectorError('The chat server ended the session'));
        }
      };
      ws.onerror = () => { /* onclose follows with the details */ };
      ws.onclose = ev => fail(new ConnectorError(ev.reason || (ev.code === 1006 ? 'Connection dropped' : `Connection closed (${ev.code})`)));
    });
  }

  function statusList() {
    const order = ['twitch', 'tiktok', 'kick', 'velora', 'blaze', 'nimo', 'youtube'];
    return [...state.statuses.values()].sort((a, b) => order.indexOf(a.platform) - order.indexOf(b.platform));
  }

  // ---------- Thanked / answered / pins (commands from the dashboard) ----------
  function markDone(ids) {
    const known = new Set([...state.alerts, ...state.questions].map(e => e.id));
    const targets = ids || state.alerts.map(a => a.id);
    const changed = targets.filter(id => known.has(id) && !state.done.has(id));
    const at = now();
    changed.forEach(id => state.done.set(id, at));
    if (changed.length) { broadcast({ type: 'ack', ids: changed, at }); savePanelSoon(); scheduleCleanup(); }
  }

  /** Undo a tick (clicked by mistake), so the item stays in the panel. */
  function unmarkDone(ids) {
    const changed = ids.filter(id => state.done.has(id));
    changed.forEach(id => state.done.delete(id));
    if (changed.length) { broadcast({ type: 'unack', ids: changed }); savePanelSoon(); scheduleCleanup(); }
  }

  // Thanked alerts and answered questions leave the panel after Settings → Display → "Clear thanked & answered
  // after" (0 keeps them). They stay in the chat.
  let cleanupTimer = null;
  const keepDoneMs = () => Math.max(0, Number(state.settings.display.removeDoneAfterSec) || 0) * 1000;

  function scheduleCleanup() {
    clearTimeout(cleanupTimer);
    const ttl = keepDoneMs();
    if (!ttl || !state.done.size) return;
    const next = Math.min(...state.done.values()) + ttl;
    cleanupTimer = setTimeout(cleanup, Math.max(0, next - now()) + 50);
  }

  function cleanup() {
    const ttl = keepDoneMs();
    if (ttl) {
      const cutoff = now() - ttl;
      const gone = new Set([...state.done].filter(([, at]) => at <= cutoff).map(([id]) => id));
      if (gone.size) {
        state.alerts = state.alerts.filter(e => !gone.has(e.id));
        state.questions = state.questions.filter(e => !gone.has(e.id));
        gone.forEach(id => state.done.delete(id));
        broadcast({ type: 'dismiss', ids: [...gone] });
        savePanelSoon();
      }
    }
    scheduleCleanup();
  }
  restoreSaved();
  cleanup(); // ticks saved earlier that have run out while UniChat was closed

  function pin(id) {
    if (state.pins.some(p => p.id === id)) return;
    const e = [...state.history, ...state.questions, ...state.alerts].find(x => x.id === id);
    if (!e) return;
    state.pins.push(e);
    if (state.pins.length > PINS) state.pins.shift();
    broadcast({ type: 'pins', pins: state.pins.slice() });
    savePanelSoon();
  }

  function unpin(id) {
    const before = state.pins.length;
    state.pins = state.pins.filter(p => p.id !== id);
    if (state.pins.length !== before) { broadcast({ type: 'pins', pins: state.pins.slice() }); savePanelSoon(); }
  }

  function handleClientMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ack' && Array.isArray(msg.ids)) markDone(msg.ids.slice(0, 500));
    else if (msg.type === 'unack' && Array.isArray(msg.ids)) unmarkDone(msg.ids.slice(0, 500));
    else if (msg.type === 'ackAll') markDone(null);
    else if (msg.type === 'pin' && typeof msg.id === 'string') pin(msg.id);
    else if (msg.type === 'unpin' && typeof msg.id === 'string') unpin(msg.id);
    else if (msg.type === 'remove' && Array.isArray(msg.ids)) hub.removeLines(msg.ids.slice(0, 500));
    else if (msg.type === 'clearFeed') clearFeed();
    else if (msg.type === 'recapReset') startRecap(false);
  }

  // "Clear chat" empties this page's chat (the Alerts panel and recap stay).
  function clearFeed() {
    state.history = [];
    saveHistorySoon();
    broadcast({ type: 'history', history: [] });
  }

  // ---------- Settings changes (saved in another tab, or here) ----------
  function applySettings(next) {
    state.settings = next;
    broadcast({ type: 'settings', settings: next });
    connectors.forEach(c => c.settingsChanged());
    settingsListeners.forEach(fn => { try { fn(next); } catch (err) { console.error('UniChat:', err); } });
    cleanup(); // the "clear after" time may have changed
  }
  window.addEventListener('storage', e => { if (e.key === Store.KEY) applySettings(Store.load()); });

  // ---------- Connection loop (port of the desktop app's Connector) ----------
  class ConnectorError extends Error {
    constructor(message, opts = {}) {
      super(message);
      this.config = !!opts.config;       // user must fix something: retried slowly, shown as an error
      this.retryAfterMs = opts.retryAfterMs;
      this.waiting = !!opts.waiting;     // not a failure (e.g. not live): show "waiting", no alert
    }
  }

  /** Connection notes are only interesting while the problem lasts: once it's over, they leave the chat. */
  function clearNotesSoon(ids) {
    ids = ids.filter(Boolean);
    if (ids.length) setTimeout(() => hub.removeLines(ids), RECONNECT_NOTE_MS);
  }

  const sleep = (ms, signal) => new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

  function registerConnector(def) {
    const c = {
      def,
      activeKey: undefined,
      abort: null,
      live: null,
      announcedDown: false,
      downNoteId: null,   // the "connection lost" line in the chat, cleared once the connection is back
      everHealthy: false,
      status: { state: 'disabled', detail: '', attempt: 0, nextRetryAt: null },

      /** The problem is over (reconnected, turned off, or just not live): its note leaves the chat, with any extra note. */
      problemOver(...extra) {
        clearNotesSoon([this.downNoteId, ...extra]);
        this.downNoteId = null;
        this.announcedDown = false;
      },

      viewers: null,     // people watching, when the platform says (shown only if Settings → Display allows)
      liveSince: null,   // when the stream started (the platform's time, or when UniChat saw it start)

      setStatus(stateName, detail, attempt = 0, nextRetryAt = null) {
        this.status = { state: stateName, detail, attempt, nextRetryAt };
        hub.setStatus({ id: def.id, label: def.label, platform: def.platform, state: stateName, detail, attempt, nextRetryAt,
          live: this.live, viewers: this.live === false ? null : this.viewers, liveSince: this.live === true ? this.liveSince : null });
      },

      /** Viewer count and stream start from the platform; undefined leaves a value as it was. */
      stats({ viewers, since } = {}) {
        if (viewers !== undefined) this.viewers = Number.isFinite(viewers) && viewers >= 0 ? Math.floor(viewers) : null;
        if (since !== undefined) this.liveSince = Number.isFinite(since) && since > 0 && since < now() + 600000 ? since : null;
        this.setStatus(this.status.state, this.status.detail, this.status.attempt, this.status.nextRetryAt);
      },

      setLive(live) {
        if (live === true) noteLive();
        if (this.live === live) return;
        const previous = this.live;
        this.live = live;
        if (live !== true) { this.viewers = null; this.liveSince = null; }
        else if (previous === false && !this.liveSince) this.liveSince = now(); // seen starting
        if (previous !== null && live !== null) {
          hub.publish({ platform: def.platform, kind: 'system', level: live ? 'ok' : 'info', code: live ? 'live' : 'offline',
            parts: [{ t: 'text', v: live ? `🔴 ${def.label}: you're live!` : `⚫ ${def.label}: stream ended.` }] });
        }
        this.setStatus(this.status.state, this.status.detail, this.status.attempt, this.status.nextRetryAt);
      },

      healthy(stateName, detail) {
        if (this.announcedDown) {
          const back = { platform: def.platform, kind: 'system', level: 'ok', code: 'reconnected',
            parts: [{ t: 'text', v: this.everHealthy ? `${def.label}: reconnected.` : `${def.label}: connected.` }] };
          hub.publish(back);
          this.problemOver(back.id);
        }
        this.everHealthy = true;
        this.setStatus(stateName, detail);
      },

      restart() { if (this.abort) this.abort.abort(); },

      settingsChanged() {
        const key = def.configKey(state.settings);
        if (key !== this.activeKey || key === null) this.restart();
      },

      async loop() {
        let attempt = 0;
        let lastReason = '';
        let lastConfig = false;
        for (;;) {
          const s = state.settings;
          const key = def.configKey(s);
          this.activeKey = key;
          const ac = new AbortController();
          this.abort = ac;

          if (key === null) {
            attempt = 0;
            this.problemOver();
            this.everHealthy = false;
            this.live = null;
            this.viewers = null;
            this.liveSince = null;
            // "setup" (red dot) for half-set-up platforms so it's obvious what's missing; "disabled" hides the pill.
            this.setStatus((def.idleState && def.idleState(s)) || 'disabled', def.disabledReason(s));
            await sleep(1e9, ac.signal);
            continue;
          }

          if (attempt === 0) this.setStatus('connecting', 'Connecting…');
          else this.setStatus(lastConfig ? 'error' : 'reconnecting', lastReason, attempt);

          let healthySince = 0;
          const ctx = {
            connected: detail => { if (!healthySince) healthySince = now(); this.healthy('connected', detail); },
            waiting: detail => { if (!healthySince) healthySince = now(); this.healthy('waiting', detail); },
            setLive: live => this.setLive(live),
            stats: s => this.stats(s),
          };

          let reason = 'Connection closed';
          let err = null;
          try {
            await def.run(s, ctx, ac.signal);
          } catch (e) {
            err = e;
            reason = (e && e.message) || String(e);
          }
          if (ac.signal.aborted) { attempt = 0; continue; } // settings changed or restart requested

          const config = !!(err && err.config);
          if (err && err.waiting) {
            // Not a failure: e.g. TikTok says "not live". Check again later without alarms.
            attempt = 0;
            this.everHealthy = true;
            this.problemOver();
            this.setStatus('waiting', reason, 0, now() + err.retryAfterMs);
            await sleep(err.retryAfterMs, ac.signal);
            continue;
          }

          if (healthySince && now() - healthySince > 30000) attempt = 0;
          attempt++;
          const delay = (err && err.retryAfterMs) ||
            (config ? Math.min(60 * attempt, 300) * 1000
              : Math.min(60, BACKOFF[Math.min(attempt - 1, BACKOFF.length - 1)] * (0.85 + Math.random() * 0.3)) * 1000);
          this.setStatus(config ? 'error' : 'reconnecting', reason, attempt, now() + delay);
          lastReason = reason;
          lastConfig = config;

          if (!this.announcedDown) {
            this.announcedDown = true;
            const lost = { platform: def.platform, kind: 'system', level: config ? 'error' : 'warn', code: 'connection-lost',
              parts: [{ t: 'text', v: this.everHealthy
                ? `${def.label}: connection lost (${reason}). Reconnecting automatically…`
                : `${def.label}: can't connect (${reason}). Retrying automatically…` }] };
            hub.publish(lost);
            this.downNoteId = lost.id;
          }
          await sleep(delay, ac.signal);
          if (ac.signal.aborted) attempt = 0;
        }
      },
    };
    connectors.push(c);
    if (started) c.loop();
  }

  // ---------- Talk to the Settings page in this browser (status, test alerts) ----------
  const NAMES = ['TestViewer', 'CozyGamer42', 'NightOwl', 'PixelPanda', 'SirChatsALot'];
  function testEvent(platform, kind) {
    const name = NAMES[Math.floor(Math.random() * NAMES.length)];
    const LABELS = { twitch: 'Twitch', tiktok: 'TikTok', kick: 'Kick', velora: 'Velora', blaze: 'Blaze', nimo: 'Nimo TV' };
    const p = Object.prototype.hasOwnProperty.call(LABELS, platform) ? platform : 'twitch';
    const e = { platform: p, kind, code: 'test', user: { name, login: name.toLowerCase(), roles: [] }, parts: [] };
    const DONATIONS = {
      twitch: { title: 'cheered 500 bits', amount: '500 bits', value: 500, unit: 'bits' },
      tiktok: { title: 'sent Rose x5', amount: '5 coins', value: 5, unit: 'coins' },
      kick: { title: 'sent KICKs', amount: '100 KICKs', value: 100, unit: 'KICKs' },
      blaze: { title: 'sent a tip', amount: '320K' },
      velora: { kind: 'redemption', title: 'redeemed Hydrate', amount: '100 points' }, // Velora tips need a login; redemptions show in chat
      nimo: { title: 'sent Duck Rain Coat x2', amount: '598 diamonds', value: 598, unit: 'diamonds' },
    };
    switch (kind) {
      case 'follow': e.title = 'followed'; break;
      case 'donation':
        Object.assign(e, DONATIONS[p]);
        e.parts = [{ t: 'text', v: 'This is a test donation, keep it up!' }];
        break;
      case 'sub': e.title = 'subscribed for 3 months'; e.parts = [{ t: 'text', v: 'Test sub message' }]; break;
      case 'raid': e.title = 'is raiding with 42 viewers'; break;
      default: e.kind = 'chat'; e.parts = [{ t: 'text', v: `This is a test message from ${LABELS[p]} 👋` }];
    }
    return e;
  }
  if (channel) {
    channel.addEventListener('message', ev => {
      const m = ev.data || {};
      if (m.type === 'test') hub.publish(testEvent(m.platform, m.kind));
      else if (m.type === 'hello?' && started) channel.postMessage({ type: 'status', status: statusList() });
    });
  }

  // Reconnect everything right away when the device comes back online.
  window.addEventListener('online', () => connectors.forEach(c => c.restart()));

  function start() {
    if (started) return;
    started = true;
    connectors.forEach(c => c.loop());
  }

  // ---------- Page-facing API ----------
  window.UniChatHub = {
    hub,
    ConnectorError,
    registerConnector,
    avatarLookup,
    runSocketIo,

    /** Same shape as the desktop app's WebSocket client: handlers get hello/event/status/... messages. */
    connect(role, handlers) {
      const client = { role, handlers };
      clients.add(client);
      if (role === 'dashboard' && !keepHistory) { keepHistory = true; restoreHistory(); }
      queueMicrotask(() => {
        if (handlers.onOpen) handlers.onOpen();
        handlers.onMessage({
          type: 'hello',
          version: 'web',
          settings: state.settings,
          status: statusList(),
          history: state.history.slice(),
          alerts: state.alerts.slice(),
          questions: state.questions.slice(),
          pins: state.pins.slice(),
          acked: [...state.done.keys()],
          ackedAt: [...state.done],
        });
        start();
      });
      return { nextRetryAt: 0, send: handleClientMessage };
    },

    /** The few actions the shared page code performs (there's no server in the web version). */
    async api(method, url, body) {
      if (method === 'POST' && url === '/api/filters/block-user') {
        const s = Store.loadSaved();
        const login = String((body && body.login) || '').trim().replace(/^@/, '').toLowerCase();
        if (!login) throw new Error('No user given');
        if (!s.filters.blockedUsers.includes(login)) s.filters.blockedUsers.push(login);
        Store.save(s);
        applySettings(Store.load());
        return {};
      }
      throw new Error('Not available in the web version');
    },

    /** Data for the viewer card. */
    viewer(platform, login) {
      const l = String(login).toLowerCase();
      const u = state.users.get(`${platform}:${l}`);
      const mem = viewers[platform];
      const firstSeen = mem && mem.users[l] ? mem.users[l] : null;
      return {
        platform, login: l, firstSeen,
        firstSeenDuringLearning: !!(firstSeen && mem && firstSeen - mem.since < LEARNING_MS),
        stats: u ? JSON.parse(JSON.stringify(u)) : null,
      };
    },

    /** Test events from the settings "preview" buttons (same browser). */
    publishTest(e) { hub.publish(Object.assign({ code: 'test' }, e)); },

    /** Re-read the settings in effect (after this page's address changed to a new settings link). */
    reloadSettings() { applySettings(Store.load()); },

    /** This stream's recap: { startedAt, lastLiveAt, items: [{ platform, kind, name, login, title, amount, unit, value, ts }] }. */
    recap() { return JSON.parse(JSON.stringify(recap)); },

    /** emotes.js: fn(parts) → parts, or null to stop. */
    setEmoteMatcher(fn) { emoteMatcher = typeof fn === 'function' ? fn : null; },
    /** fn(settings) runs whenever the settings change. */
    onSettingsChange(fn) { settingsListeners.push(fn); },
    SHARED_EMOTE,
  };
})();
