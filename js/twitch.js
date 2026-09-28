/* Twitch chat, read anonymously ("justinfan" login) over Twitch's chat WebSocket, straight from this browser.
   No account or login: chat, bits, Hype Chat, subs, gift subs, raids, announcements, deletions and bans,
   plus profile pictures and live status (looked up separately, see below). */
(function () {
  'use strict';
  const { hub, ConnectorError, registerConnector, avatarLookup } = window.UniChatHub;

  const EMOTE_URL = id => `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(id)}/default/dark/2.0`;

  function unescapeTag(v) {
    return v.replace(/\\(.)/g, (_, c) => ({ s: ' ', ':': ';', r: '\r', n: '\n', '\\': '\\' }[c] || c));
  }

  /** Minimal IRCv3 parser: { tags, prefix, command, params, trailing } */
  function parseIrc(line) {
    if (!line) return null;
    const m = { tags: {}, prefix: null, command: '', params: [], trailing: null };
    let i = 0;
    if (line[0] === '@') {
      const end = line.indexOf(' ');
      if (end < 0) return null;
      for (const tag of line.slice(1, end).split(';')) {
        const eq = tag.indexOf('=');
        if (eq < 0) m.tags[tag] = '';
        else m.tags[tag.slice(0, eq)] = unescapeTag(tag.slice(eq + 1));
      }
      i = end + 1;
    }
    if (line[i] === ':') {
      const end = line.indexOf(' ', i);
      if (end < 0) return null;
      m.prefix = line.slice(i + 1, end);
      i = end + 1;
    }
    const t = line.indexOf(' :', i);
    const head = t >= 0 ? line.slice(i, t) : line.slice(i);
    if (t >= 0) m.trailing = line.slice(t + 2);
    const pieces = head.split(' ').filter(Boolean);
    if (!pieces.length) return null;
    m.command = pieces[0];
    m.params = pieces.slice(1);
    return m;
  }

  /** Split a message into text + emote parts. Twitch's emote positions count Unicode code points. */
  function buildParts(text, emotesTag) {
    if (!emotesTag) return [{ t: 'text', v: text }];
    const chars = Array.from(text);
    const ranges = [];
    for (const emote of emotesTag.split('/')) {
      const colon = emote.indexOf(':');
      if (colon <= 0) continue;
      const id = emote.slice(0, colon);
      for (const r of emote.slice(colon + 1).split(',')) {
        const [a, b] = r.split('-').map(Number);
        if (Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= a && b < chars.length) ranges.push([a, b, id]);
      }
    }
    ranges.sort((x, y) => x[0] - y[0]);
    const parts = [];
    let pos = 0;
    for (const [a, b, id] of ranges) {
      if (a < pos) continue;
      if (a > pos) parts.push({ t: 'text', v: chars.slice(pos, a).join('') });
      parts.push({ t: 'emote', v: chars.slice(a, b + 1).join(''), url: EMOTE_URL(id) });
      pos = b + 1;
    }
    if (pos < chars.length) parts.push({ t: 'text', v: chars.slice(pos).join('') });
    return parts;
  }

  // ---------- Profile pictures ----------
  // Twitch chat doesn't include profile pictures, and Twitch's own API needs a login. So pictures are looked up by
  // username with IVR (api.ivr.fi), a free public API for Twitch data, 50 names per request (see avatarLookup in hub.js).
  // Only pictures on Twitch's own image server are used, at the size chat needs (the API gives 600×600).
  const Avatars = avatarLookup({
    platform: 'twitch',
    login: /^[a-z0-9][a-z0-9_]{0,24}$/, // Twitch's rule (IVR rejects a whole batch if one name breaks it)
    batch: 50,
    clean: url => (typeof url === 'string' && /^https:\/\/static-cdn\.jtvnw\.net\/[\w./-]+$/.test(url)
      ? url.replace(/-\d+x\d+\.(png|jpe?g|gif|webp)$/i, '-70x70.$1') : ''),
    async lookup(logins, signal) {
      const res = await fetch('https://api.ivr.fi/v2/twitch/user?login=' + logins.join(','), { credentials: 'omit', signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const users = await res.json();
      return new Map((Array.isArray(users) ? users : []).filter(u => u && typeof u.login === 'string').map(u => [u.login.toLowerCase(), u.logo]));
    },
  });

  // ---------- Live status ----------
  // Anonymous chat doesn't say whether the channel is live, so the same IVR API is asked about the one channel being
  // read, every 90 seconds while connected. Its "stream" is null when offline.
  const LIVE_CHECK_MS = 90000;
  async function checkLive(channel, signal) {
    const res = await fetch('https://api.ivr.fi/v2/twitch/user?login=' + encodeURIComponent(channel), { credentials: 'omit', signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const users = await res.json();
    const u = (Array.isArray(users) ? users : []).find(x => x && typeof x.login === 'string' && x.login.toLowerCase() === channel);
    if (!u) return null;
    const stream = u.stream && typeof u.stream === 'object' ? u.stream : null;
    const viewers = stream ? Number(stream.viewersCount) : NaN;
    const since = stream ? Date.parse(String(stream.createdAt || '')) : NaN;
    return { live: !!stream, viewers: Number.isFinite(viewers) ? viewers : null, since: Number.isFinite(since) ? since : null };
  }

  const ROLE = { broadcaster: 'broadcaster', moderator: 'moderator', vip: 'vip', subscriber: 'subscriber', founder: 'founder',
    partner: 'verified', staff: 'staff', admin: 'staff', global_mod: 'staff' };

  function buildUser(m) {
    const login = m.tags.login || (m.prefix ? m.prefix.split('!')[0] : '') || '';
    const display = m.tags['display-name'];
    const roles = [];
    for (const badge of (m.tags.badges || '').split(',')) {
      const key = badge.split('/')[0];
      const role = Object.prototype.hasOwnProperty.call(ROLE, key) ? ROLE[key] : null;
      if (role && !roles.includes(role)) roles.push(role);
    }
    return { name: display || login, login, color: m.tags.color || null, roles, avatar: Avatars.get(login) };
  }

  const ts = m => Number(m.tags['tmi-sent-ts']) || Date.now();
  const stripName = (sys, name) => (name && sys.toLowerCase().startsWith(name.toLowerCase()) ? sys.slice(name.length).trim() : sys);

  function onPrivMsg(m) {
    let text = m.trailing || '';
    if (text.startsWith('\u0001ACTION ') && text.endsWith('\u0001')) text = text.slice(8, -1);

    // Emote positions refer to the original text, so split first, then drop Twitch's "@name " reply prefix.
    const parts = buildParts(text, m.tags.emotes);
    let reply = null;
    const parent = m.tags['reply-parent-display-name'];
    if (parent) {
      reply = { id: m.tags['reply-parent-msg-id'] ? 'twitch:' + m.tags['reply-parent-msg-id'] : null, name: parent, text: m.tags['reply-parent-msg-body'] || '' };
      const login = m.tags['reply-parent-user-login'] || parent;
      if (parts.length && parts[0].t === 'text') {
        for (const prefix of ['@' + parent + ' ', '@' + login + ' ']) {
          if (parts[0].v.toLowerCase().startsWith(prefix.toLowerCase())) {
            parts[0].v = parts[0].v.slice(prefix.length);
            if (!parts[0].v) parts.shift();
            break;
          }
        }
      }
    }

    const e = {
      id: 'twitch:' + (m.tags.id || Math.random().toString(36).slice(2)),
      platform: 'twitch', kind: 'chat', ts: ts(m), user: buildUser(m), parts, reply,
      firstTime: m.tags['first-msg'] === '1',
    };
    const bits = Number(m.tags.bits);
    const paid = Number(m.tags['pinned-chat-paid-amount']);
    if (bits > 0) {
      Object.assign(e, { kind: 'donation', value: bits, unit: 'bits', amount: `${bits.toLocaleString()} bit${bits === 1 ? '' : 's'}` });
      e.title = `cheered ${e.amount}`;
    } else if (paid > 0) {
      const exp = Number(m.tags['pinned-chat-paid-exponent']) || 2;
      const currency = m.tags['pinned-chat-paid-currency'] || '';
      const value = paid / Math.pow(10, exp);
      Object.assign(e, { kind: 'donation', value, unit: currency || 'money', amount: `${value.toFixed(2)} ${currency}`.trim(), title: 'sent a Hype Chat' });
    }
    hub.publish(e);
  }

  function onUserNotice(m) {
    const msgId = m.tags['msg-id'] || '';
    const sys = m.tags['system-msg'] || '';
    const user = buildUser(m);
    const base = { id: 'twitch:' + (m.tags.id || Math.random().toString(36).slice(2)), platform: 'twitch', ts: ts(m), user,
      parts: m.trailing ? buildParts(m.trailing, m.tags.emotes) : [] };

    switch (msgId) {
      case 'submysterygift':
        hub.publish(Object.assign(base, { kind: 'sub', title: stripName(sys, user.name), value: Number(m.tags['msg-param-mass-gift-count']) || 1, unit: 'gifts' }));
        break;
      case 'sub': case 'resub': case 'giftpaidupgrade': case 'anongiftpaidupgrade': case 'primepaidupgrade':
      case 'standardpayforward': case 'communitypayforward':
        hub.publish(Object.assign(base, { kind: 'sub', title: stripName(sys, user.name) }));
        break;
      case 'subgift': case 'anonsubgift':
        // Gifts that belong to a "gifting N subs" bundle are summarised by submysterygift.
        if ('msg-param-community-gift-id' in m.tags) return;
        hub.publish(Object.assign(base, { kind: 'sub', title: stripName(sys, user.name), value: 1, unit: 'gifts' }));
        break;
      case 'raid': {
        const viewers = m.tags['msg-param-viewerCount'] || '?';
        const login = m.tags['msg-param-login'] || user.login;
        hub.publish(Object.assign(base, {
          kind: 'raid', parts: [], value: Number(viewers) || 0, unit: 'viewers',
          user: { name: m.tags['msg-param-displayName'] || user.name, login, color: user.color, roles: [], avatar: Avatars.get(login) },
          title: `is raiding with ${viewers} viewer${viewers === '1' ? '' : 's'}`,
        }));
        break;
      }
      case 'announcement':
        hub.publish(Object.assign(base, { kind: 'chat', title: 'Announcement' }));
        break;
      default:
        if (!sys && !base.parts.length) return;
        hub.publish(Object.assign(base, { kind: 'chat', title: stripName(sys, user.name), silent: true }));
    }
  }

  registerConnector({
    id: 'twitch',
    label: 'Twitch',
    platform: 'twitch',
    configKey: s => (s.twitch.enabled && s.twitch.channel ? `twitch|${s.twitch.channel}` : null),
    disabledReason: s => (s.twitch.enabled ? 'No channel set' : 'Disabled'),

    run(s, ctx, signal) {
      const channel = s.twitch.channel;
      return new Promise((resolve, reject) => {
        const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
        let joined = false;
        let lastData = Date.now();
        let finished = false;
        const joinTimer = setTimeout(() => fail(new ConnectorError(`Channel '${channel}' not found on Twitch (check the spelling)`, { config: true })), 15000);
        const pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send('PING :unichat');
          if (Date.now() - lastData > 100000) fail(new ConnectorError('No data for 100s'));
        }, 30000);
        const liveAbort = new AbortController();
        let liveTimer = null;
        let liveReported = false;
        async function updateLive() {
          try {
            const r = await checkLive(channel, liveAbort.signal);
            if (finished || !r) return;
            ctx.setLive(r.live);
            if (r.live) ctx.stats({ viewers: r.viewers, since: r.since });
          } catch (err) {
            if (finished || liveReported) return;
            liveReported = true; // once per connection; the status dot shows "can't tell" meanwhile
            hub.diagnostic(`Twitch: couldn't check whether #${channel} is live (${err.message})`);
          }
        }

        function finish(err) {
          if (finished) return;
          finished = true;
          clearTimeout(joinTimer);
          clearInterval(pingTimer);
          clearInterval(liveTimer);
          liveAbort.abort();
          try { ws.close(); } catch { /* already closed */ }
          if (err) reject(err); else resolve();
        }
        const fail = err => finish(err);
        signal.addEventListener('abort', () => finish(), { once: true });

        ws.onopen = () => {
          ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
          ws.send('PASS SCHMOOPIIE');
          ws.send(`NICK justinfan${10000 + Math.floor(Math.random() * 89999)}`);
          ws.send(`JOIN #${channel}`);
        };
        ws.onclose = ev => fail(new ConnectorError(ev.reason || (ev.code === 1006 ? 'Connection dropped' : `Connection closed (${ev.code})`)));
        ws.onerror = () => { /* onclose follows with the details */ };
        ws.onmessage = ev => {
          lastData = Date.now();
          for (const raw of String(ev.data).split('\r\n')) {
            const m = parseIrc(raw);
            if (!m) continue;
            try {
              switch (m.command) {
                case 'PING': ws.send(`PONG :${m.trailing || ''}`); break;
                case 'RECONNECT': fail(new ConnectorError('Twitch requested a reconnect', { retryAfterMs: 1000 })); return;
                case 'ROOMSTATE':
                  if (!joined) {
                    joined = true;
                    clearTimeout(joinTimer);
                    ctx.connected(`#${channel}`);
                    updateLive();
                    liveTimer = setInterval(updateLive, LIVE_CHECK_MS);
                  }
                  break;
                case 'NOTICE':
                  if (['msg_channel_suspended', 'msg_banned', 'tos_ban'].includes(m.tags['msg-id'])) {
                    fail(new ConnectorError(`Can't join #${channel}: ${m.trailing}`, { config: true }));
                    return;
                  }
                  break;
                case 'PRIVMSG': onPrivMsg(m); break;
                case 'USERNOTICE': onUserNotice(m); break;
                case 'CLEARCHAT': hub.clearUser('twitch', m.trailing || null); break;
                case 'CLEARMSG': if (m.tags['target-msg-id']) hub.deleteMessages('twitch', ['twitch:' + m.tags['target-msg-id']]); break;
              }
            } catch (err) {
              console.warn('UniChat: skipped a Twitch message', err);
            }
          }
        };
      });
    },
  });

  window.UniChatTwitch = { parseIrc, buildParts, onPrivMsg, onUserNotice }; // exposed for testing
})();
