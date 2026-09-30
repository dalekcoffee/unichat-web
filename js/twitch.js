/* Twitch chat, read anonymously ("justinfan" login) over Twitch's chat WebSocket, straight from this browser.
   No account or login: chat, bits, Hype Chat, subs, gift subs, raids, announcements, deletions and bans,
   plus profile pictures and live status (looked up separately, see below). */
(function () {
  'use strict';
  const { hub, ConnectorError, registerConnector, avatarLookup, watchResume } = window.UniChatHub;

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
    // In IRC the last parameter only needs the ":" when it has spaces: saved chat (see catchUp) sends one-word messages
    // as "PRIVMSG #channel LOL".
    if (m.trailing === null && m.params.length > 1) m.trailing = m.params[m.params.length - 1];
    return m;
  }

  // GIPHY GIFs, sent by Tier 2 and 3 subscribers: the "gifs" tag lists "<start>-<end>|<gifID>|<url>" entries, comma-
  // separated. The message text in that range is GIPHY's caption in brackets, e.g. "[Yes GIF by …]". A URL can contain
  // commas, so only a comma that starts the next "<n>-<n>|" entry splits. Twitch requires the URL to be used exactly as
  // sent (hub.js checks it's one of GIPHY's servers, but never changes it).
  function gifRanges(tag, length) {
    const out = [];
    for (const entry of String(tag || '').split(/,(?=\d+-\d+\|)/)) {
      const m = /^(\d+)-(\d+)\|[^|]*\|(\S+)$/.exec(entry);
      if (!m) continue;
      const a = Number(m[1]), b = Number(m[2]);
      if (b >= a && b < length) out.push([a, b, { t: 'gif', url: m[3] }]);
    }
    return out;
  }

  /** Split a message into text, emote and GIF parts. Twitch's positions count Unicode code points. */
  function buildParts(text, emotesTag, gifsTag) {
    if (!emotesTag && !gifsTag) return [{ t: 'text', v: text }];
    const chars = Array.from(text);
    const ranges = [];
    for (const emote of (emotesTag || '').split('/')) {
      const colon = emote.indexOf(':');
      if (colon <= 0) continue;
      const id = emote.slice(0, colon);
      for (const r of emote.slice(colon + 1).split(',')) {
        const [a, b] = r.split('-').map(Number);
        if (Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= a && b < chars.length) ranges.push([a, b, { t: 'emote', url: EMOTE_URL(id) }]);
      }
    }
    ranges.push(...gifRanges(gifsTag, chars.length));
    ranges.sort((x, y) => x[0] - y[0]);
    const parts = [];
    let pos = 0;
    for (const [a, b, part] of ranges) {
      if (a < pos) continue;
      if (a > pos) parts.push({ t: 'text', v: chars.slice(pos, a).join('') });
      parts.push({ ...part, v: chars.slice(a, b + 1).join('') });
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

  // ---------- Catching up after a reconnect ----------
  // Twitch doesn't resend chat you missed while disconnected (e.g. a phone that paused this page in the background).
  // recent-messages.robotty.de, a free service that Chatterino and other chat apps use, keeps each channel's recent chat,
  // so after reconnecting UniChat fills in what was said since the newest message it had. Messages already shown are
  // skipped (hub.js ignores IDs it has seen); missed ones arrive quietly (no sounds or popups) but still count for the
  // Alerts panel, Questions and the recap. Settings → Twitch turns this off.
  const CATCH_UP_URL = (channel, limit) => `https://recent-messages.robotty.de/api/v2/recent-messages/${encodeURIComponent(channel)}?limit=${limit}&hide_moderated_messages=true`;
  const CATCH_UP_MAX_AGE = 6 * 3600000;
  const newest = { channel: '', at: 0 }; // tmi-sent-ts of the newest message shown from this channel
  const noteNewest = (m, channel) => { if (newest.channel === channel) newest.at = Math.max(newest.at, ts(m)); };
  let catchUpReported = false;

  /** The time to catch up from: the newest message shown from this channel (0 = nothing to fill in). */
  function catchUpSince(channel) {
    if (newest.channel !== channel) {
      // First connection to this channel on this page: start from the newest message still in the chat (a reload keeps it).
      newest.channel = channel;
      newest.at = hub.latest('twitch');
    }
    return newest.at;
  }

  async function catchUp(channel, since, signal) {
    // Asked (for one message) even with nothing to fill in, so the service keeps recording this channel for next time.
    const res = await fetch(CATCH_UP_URL(channel, since ? 100 : 1), { credentials: 'omit', signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.text();
    if (raw.length > 2000000) throw new Error('answer too big'); // 100 lines are ~100 KB
    const body = JSON.parse(raw);
    const lines = body && Array.isArray(body.messages) ? body.messages.filter(l => typeof l === 'string').slice(-100) : [];
    if (!since) return;
    const oldest = Math.max(since, Date.now() - CATCH_UP_MAX_AGE);
    for (const line of lines) {
      if (signal.aborted) return;
      const m = parseIrc(line.slice(0, 20000));
      if (!m || (m.command !== 'PRIVMSG' && m.command !== 'USERNOTICE') || m.params[0] !== `#${channel}` || !(ts(m) > oldest)) continue;
      try { if (m.command === 'PRIVMSG') onPrivMsg(m, channel, true); else onUserNotice(m, channel, true); }
      catch (err) { console.warn('UniChat: skipped a missed Twitch message', err); }
    }
  }
  const stripName = (sys, name) => (name && sys.toLowerCase().startsWith(name.toLowerCase()) ? sys.slice(name.length).trim() : sys);

  /** A chat message; channel: the one being read (for catching up), missed: filled in after a reconnect. */
  function onPrivMsg(m, channel, missed) {
    noteNewest(m, channel);
    let text = m.trailing || '';
    if (text.startsWith('\u0001ACTION ') && text.endsWith('\u0001')) text = text.slice(8, -1);

    // Emote and GIF positions refer to the original text, so split first, then drop Twitch's "@name " reply prefix.
    // (GIFs only come in chat messages, never in sub/raid notices.)
    const parts = buildParts(text, m.tags.emotes, m.tags.gifs);
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
    if (missed) e.missed = true;
    hub.publish(e);
  }

  function onUserNotice(m, channel, missed) {
    noteNewest(m, channel);
    const msgId = m.tags['msg-id'] || '';
    const sys = m.tags['system-msg'] || '';
    const user = buildUser(m);
    const base = { id: 'twitch:' + (m.tags.id || Math.random().toString(36).slice(2)), platform: 'twitch', ts: ts(m), user,
      parts: m.trailing ? buildParts(m.trailing, m.tags.emotes) : [] };
    if (missed) base.missed = true;

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
        let held = null; // chat lines waiting for the missed chat to be filled in first
        function handle(m) {
          try {
            switch (m.command) {
              case 'PRIVMSG': onPrivMsg(m, channel); break;
              case 'USERNOTICE': onUserNotice(m, channel); break;
              case 'CLEARCHAT': hub.clearUser('twitch', m.trailing || null); break;
              case 'CLEARMSG': if (m.tags['target-msg-id']) hub.deleteMessages('twitch', ['twitch:' + m.tags['target-msg-id']]); break;
            }
          } catch (err) {
            console.warn('UniChat: skipped a Twitch message', err);
          }
        }
        let lastData = Date.now();
        let finished = false;
        // No channel after 15 s: Twitch answered but won't join it (misspelt), or never answered at all (e.g. a phone
        // waking up on a weak signal), which is just a failed try.
        const joinTimer = setTimeout(() => fail(ws.readyState === WebSocket.OPEN
          ? new ConnectorError(`Channel '${channel}' not found on Twitch (check the spelling)`, { config: true })
          : new ConnectorError("Couldn't reach Twitch chat")), 15000);
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
        // Back from the background: Twitch answers a PING at once if the connection survived.
        watchResume(ctx, { lastData: () => lastData, waitMs: 8000, fail, ping: () => { if (ws.readyState === WebSocket.OPEN) ws.send('PING :unichat'); } });

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
                    if (s.twitch.catchUp) {
                      // While the missed chat loads (5 s at most), new lines wait, so everything shows in order.
                      const since = catchUpSince(channel);
                      const give = new AbortController();
                      const giveUp = setTimeout(() => give.abort(), 5000);
                      liveAbort.signal.addEventListener('abort', () => give.abort(), { once: true });
                      if (since) held = [];
                      catchUp(channel, since, give.signal).catch(err => {
                        if (finished || catchUpReported) return;
                        catchUpReported = true; // once per page
                        hub.diagnostic(`Twitch: couldn't fill in missed chat from recent-messages.robotty.de (${err.name === 'AbortError' ? 'no answer in 5 s' : err.message})`);
                      }).finally(() => {
                        clearTimeout(giveUp);
                        const waiting = held || [];
                        held = null;
                        if (!finished) waiting.forEach(handle);
                      });
                    }
                  }
                  break;
                case 'NOTICE':
                  if (['msg_channel_suspended', 'msg_banned', 'tos_ban'].includes(m.tags['msg-id'])) {
                    fail(new ConnectorError(`Can't join #${channel}: ${m.trailing}`, { config: true }));
                    return;
                  }
                  break;
                case 'PRIVMSG': case 'USERNOTICE': case 'CLEARCHAT': case 'CLEARMSG':
                  if (held) held.push(m); else handle(m); // held while missed chat is filled in (see catchUp)
                  break;
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
