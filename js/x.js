/* X (Twitter) live chat, read through UniChat's relay with no login. X has no chat feed a website can read, so the relay
   (address built in, see store.js) finds the live broadcast, reads its chat as a guest and passes it on here, with notes
   on what it's doing: looking for the broadcast, live, not live (it keeps checking by itself), no such account, or X
   turning it away for a while (it tries again by itself). Shows chat, and joins as a quiet line like TikTok's.
   Settings → X takes a username or a broadcast link (kept as "i/broadcasts/<id>", see store.js normalizeX). */
(function () {
  'use strict';
  const { hub, ConnectorError, registerConnector, watchResume } = window.UniChatHub;
  const Store = window.UniChatStore;

  const USER = /^[A-Za-z0-9_]{1,15}$/;
  const BROADCAST = /^i\/broadcasts\/([A-Za-z0-9]{8,24})$/;
  /** What Settings → X asks for: { user } or { broadcast } (its ID), or null when it's neither. */
  function target(channel) {
    const b = BROADCAST.exec(channel || '');
    if (b) return { broadcast: b[1] };
    return USER.test(channel || '') ? { user: channel } : null;
  }

  // The relay says something at least every 30 seconds (a heartbeat when there's nothing else), so this long without a
  // word means the link is gone.
  const SILENT_MS = 75000;
  // Joins are a quiet line, once per viewer every 10 minutes, that leaves the chat after this long (TikTok's default).
  const JOIN_CLEAR_MS = 15000;

  const str = v => (typeof v === 'string' ? v : '');
  /** The relay's text for a status line: no control characters (or ones that flip the text's direction), at most `max` long. */
  const clean = (v, max) => str(v).replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

  /** When the message was sent (ms), or undefined (= now) when the relay's time is implausible. */
  function sentAt(ts) {
    const t = Number(ts);
    return Number.isFinite(t) && t > Date.now() - 6 * 3600000 && t < Date.now() + 60000 ? t : undefined;
  }

  /** How long until the relay tries again by itself (retryAt, epoch ms): 15 seconds to 30 minutes, undefined if it didn't say. */
  function untilRetry(at) {
    const t = Number(at);
    return Number.isFinite(t) && t > 0 ? Math.min(1800000, Math.max(15000, t - Date.now() + 2000)) : undefined;
  }

  function userOf(u, t) {
    const login = str(u.user).trim().replace(/^@/, '').toLowerCase().slice(0, 40);
    return {
      name: str(u.name).trim() || str(u.user).trim() || 'Someone',
      login,
      avatar: str(u.avatar) || undefined,
      // Known by name only: a broadcast link doesn't say whose broadcast it is.
      roles: t.user && login === t.user.toLowerCase() ? ['broadcaster'] : [],
    };
  }

  let busy = 0;      // "too many connections" answers in a row (close code 4429): each one waits a minute longer
  let unhandled = 0; // relay messages this doesn't know: the first few are listed in Settings → Diagnostics
  function unknown(sample) {
    if (unhandled++ < 5) hub.diagnostic(`X: unhandled relay message ${sample.length > 300 ? sample.slice(0, 300) + '…' : sample}`);
  }

  registerConnector({
    id: 'x',
    label: 'X',
    platform: 'x',
    configKey: s => (s.x.enabled && Store.RELAY_URL && target(s.x.channel) ? `x|${s.x.channel}` : null),
    disabledReason: s => (!s.x.enabled ? 'Disabled' : !s.x.channel ? 'No X username or broadcast link set'
      : !Store.RELAY_URL ? "X chat comes through UniChat's relay, and this copy of UniChat has none"
        : "That isn't an X username (up to 15 letters, numbers or _) or broadcast link"),
    idleState: s => (s.x.enabled && s.x.channel ? 'setup' : null), // red dot: the name or link needs fixing

    run(s, ctx, signal) {
      const t = target(s.x.channel);
      const where = t.user ? `@${t.user}` : `x.com/i/broadcasts/${t.broadcast}`;
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(Store.relayAddress('/x') + (t.user ? `?user=${encodeURIComponent(t.user)}` : `?broadcast=${encodeURIComponent(t.broadcast)}`));
        let finished = false;
        let lastData = Date.now();
        const idleTimer = setInterval(() => {
          if (Date.now() - lastData > SILENT_MS) finish(new ConnectorError(`No word from the relay for ${SILENT_MS / 1000} seconds`));
        }, 15000);

        function finish(err) {
          if (finished) return;
          finished = true;
          clearInterval(idleTimer);
          try { ws.close(); } catch { /* already closed */ }
          if (err) reject(err); else resolve();
        }
        signal.addEventListener('abort', () => finish(), { once: true });
        // Back from the background: the relay says something every 30 seconds, so 35 seconds of silence means the
        // connection didn't survive.
        watchResume(ctx, { lastData: () => lastData, waitMs: 35000, fail: finish });

        ws.onmessage = ev => {
          lastData = Date.now();
          if (typeof ev.data !== 'string') { unknown('(binary data)'); return; }
          let m;
          try { m = JSON.parse(ev.data); } catch { unknown(ev.data); return; }
          const x = m && typeof m === 'object' ? m.x : null;
          if (!x || typeof x !== 'object') { unknown(ev.data); return; }
          busy = 0;
          if (typeof x.state === 'string') relayState(x);
          else if (x.chat && typeof x.chat === 'object') chat(x.chat);
          else if (x.join && typeof x.join === 'object') join(x.join);
          else if (!x.hb) unknown(ev.data);
        };

        /**
         * The relay's notes. searching: looking for the live broadcast or connecting to its chat (nothing to show yet).
         * live: reading its chat (title = the broadcast's). offline: not live; the relay looks again by itself, so this
         * stays connected, like TikTok when you're not live. notfound (no such account) and error (X turned the relay
         * away): shown like any other failed try, and this page comes back when the relay tries again (retryAt).
         */
        function relayState(r) {
          const reason = clean(r.reason, 200);
          switch (r.state) {
            case 'searching': break;
            case 'live': {
              const title = clean(r.title, 100);
              ctx.setLive(true);
              ctx.connected(`${where}${title ? ` · "${title}"` : ''} · via the relay`);
              break;
            }
            case 'offline':
              ctx.setLive(false);
              ctx.waiting(`${t.user ? `@${t.user}` : 'The broadcast'} isn't live right now (the relay keeps checking)`);
              break;
            case 'notfound':
              finish(new ConnectorError(reason || (t.user ? `X has no account called @${t.user}` : "X can't find that broadcast"),
                { config: true, retryAfterMs: untilRetry(r.retryAt) }));
              break;
            case 'error':
              finish(new ConnectorError(`The relay: ${reason || "X isn't letting it read chat right now"}`, { retryAfterMs: untilRetry(r.retryAt) }));
              break;
            default:
              unknown(JSON.stringify(r));
          }
        }

        function chat(c) {
          const text = str(c.text);
          if (!text.trim()) return;
          const id = str(c.id).slice(0, 80);
          hub.publish({ id: id ? `x:${id}` : undefined, ts: sentAt(c.ts), platform: 'x', kind: 'chat', user: userOf(c, t), parts: [{ t: 'text', v: text }] });
        }

        function join(j) { // a quiet line, never an alert
          const user = userOf(j, t);
          if (!user.login || hub.isDuplicate(`x-join:${user.login}`, 600000)) return; // once per viewer per 10 minutes
          hub.publish({ ts: sentAt(j.ts), platform: 'x', kind: 'chat', code: 'join', user, title: 'joined', silent: true,
            expiresAt: Date.now() + JOIN_CLEAR_MS });
        }

        ws.onerror = () => { /* onclose follows */ };
        ws.onclose = ev => {
          hub.diagnostic(`X: connection closed (code ${ev.code}${ev.reason ? ', ' + ev.reason : ''})`);
          // 4400: the relay can't use this name or link; 4403: it refused this page (another site). Trying again won't
          // help, so they show as needing you (retried slowly). 4429: too many pages connected: back a little later.
          const why = String(ev.reason || '').slice(0, 200);
          if (ev.code === 4400) finish(new ConnectorError(`The relay can't read ${t.user ? `@${t.user}` : 'that broadcast link'}${why ? ` (${why})` : ''}. Check it in Settings → X.`, { config: true }));
          else if (ev.code === 4403) finish(new ConnectorError(`The relay refused the connection${why ? ': ' + why : ''}`, { config: true }));
          else if (ev.code === 4429) {
            busy = Math.min(busy + 1, 5);
            finish(new ConnectorError(`The relay is busy${why ? ': ' + why : ''}`, { retryAfterMs: busy * 60000 }));
          } else finish(new ConnectorError(why || (ev.code === 1006 ? "Can't reach the relay" : `Relay connection closed (${ev.code})`)));
        };
      });
    },
  });

  window.UniChatX = { target, userOf }; // exposed for testing
})();
