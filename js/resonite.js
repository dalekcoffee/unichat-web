/* UniChat → Resonite: when Settings → Resonite is on for this device, the chat page sends its lines and alerts to the
   relay (address built in, see store.js), which passes them to your in-game panel. Only what this page shows is sent:
   chat the filters hide here isn't, an alert from a hidden viewer goes without its message, and quiet notes (joins,
   likes, shares) stay here. Missed and caught-up lines go without a sound. A new alert goes when this page plays it, so
   when it waits for its voice line the panel's banner and sound wait too. It sends to this browser's room (Settings →
   Resonite: the room code, kept here; panels read the panel code worked out from it). One device sends to a room at a
   time: the same channels on another device take over (this one stops until it's turned on again), and while this
   page sends, someone else's page is told the room is in use. */
(function () {
  'use strict';
  const U = window.UniChat;
  const Store = window.UniChatStore;
  if (!Store || !Store.RELAY_URL || !window.UniChatHub) return;

  const ALERT_KINDS = ['follow', 'donation', 'sub', 'raid', 'redemption', 'hype'];
  const PLATFORMS = ['twitch', 'tiktok', 'kick', 'velora', 'blaze', 'nimo'];
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

  /** Tell Settings → Resonite (in this browser) how sending is going. */
  function tell(next) {
    report = next;
    if (channel) channel.postMessage(Object.assign({ type: 'resonite' }, next));
  }

  // "rgb(r, g, b)" (UniChat's readable name colour) → "#rrggbb", the only colour form the relay accepts.
  function hexColor(c) {
    if (/^#[0-9a-f]{6}$/i.test(c || '')) return c;
    const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(c || '');
    return m ? '#' + m.slice(1, 4).map(n => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('') : null;
  }

  /** A line or alert as the relay wants it, or null when it isn't sent. */
  function pack(e) {
    if (!e || !PLATFORMS.includes(e.platform)) return null;
    const alert = ALERT_KINDS.includes(e.kind);
    if (!alert && (e.kind !== 'chat' || e.silent === true)) return null;
    const cls = U.classify(e, settings);
    if (cls.hidden) return null;
    const u = e.user || {};
    const name = cls.maskName ? 'Someone' : String(u.name || u.login || '');
    return {
      id: e.id, k: e.kind, p: e.platform, n: name,
      c: name ? hexColor(U.userColor(u, 'dark')) : null,
      x: (U.shownParts(e, cls) || []).map(p => (p && p.v != null ? String(p.v) : '')).join('').trim(),
      ti: alert ? String(e.title || '') : '',
      a: alert ? String(e.amount || '') : '',
      q: e.missed === true || e.historical === true,
      h: cls.highlight || null,
    };
  }

  const tones = () => statuses.filter(s => s && PLATFORMS.includes(s.platform)).map(s => ({ p: s.platform, tone: U.statusTone(s).tone }));

  /** Everything this page shows right now (after connecting, or when the filters change): no sounds for any of it. */
  function snapshot() {
    const chat = [], alerts = [];
    for (const e of history) {
      const m = held.has(e.id) ? null : pack(e); // a held alert goes later, with its sound
      if (m) (m.k === 'chat' ? chat : alerts).push(Object.assign(m, { q: true }));
    }
    const status = tones();
    sentTones = JSON.stringify(status);
    return { t: 'snap', chat: chat.slice(-40), alerts: alerts.slice(-10), status };
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
          send(snapshot());
          break;
        case 'event': {
          history.push(msg.event);
          if (history.length > 300) history.shift();
          const m = pack(msg.event);
          if (!m) break;
          if (m.k !== 'chat' && !m.q && !played.includes(m.id)) held.set(m.id, { m, timer: setTimeout(() => release(m.id), HOLD_MS) });
          else send({ t: 'ev', e: m });
          break;
        }
        case 'remove':
        case 'delete': {
          const ids = new Set(msg.ids || []);
          history = history.filter(e => !ids.has(e.id));
          drop(ids);
          if (ids.size) send({ t: 'rm', ids: [...ids] });
          break;
        }
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
