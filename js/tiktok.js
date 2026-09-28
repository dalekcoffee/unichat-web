/* TikTok LIVE via Euler Stream's cloud WebSocket (free Community tier), straight from this browser.
   Chat, gifts (one alert per combo), follows and subs. Joins, likes and shares are optional quiet lines, never alerts.
   Euler doesn't publish exact field names, so every lookup below tries the common spellings, and anything
   unrecognised is listed in Settings → Diagnostics. */
(function () {
  'use strict';
  const { hub, ConnectorError, registerConnector } = window.UniChatHub;

  const first = v => (Array.isArray(v) ? v[0] : v);
  const pick = (...vals) => vals.find(v => v !== undefined && v !== null && v !== '');
  const num = v => {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const truthy = v => v === true || v === 1 || v === '1' || v === 'true';

  /** "WebcastChatMessage" / "chat" / "ChatMessage" → "chat" */
  function kindOf(m) {
    const raw = String(pick(m.type, m.method, m.event, m.name) || '');
    return raw.replace(/^Webcast/, '').replace(/Message$/, '').replace(/[^A-Za-z]/g, '').toLowerCase();
  }

  function imageUrl(img) {
    if (!img) return undefined;
    if (typeof img === 'string') return img;
    return pick(first(img.url), first(img.urls), first(img.urlList), first(img.url_list), img.giftPictureUrl);
  }

  function userOf(d, settings) {
    const u = d.user || d.userInfo || d;
    const uniqueId = String(pick(u.uniqueId, u.displayId, u.username, u.unique_id, u.userId, '') || '');
    const identity = d.userIdentity || u.userIdentity || {};
    const roles = [];
    if (settings.tikTok.username && uniqueId.toLowerCase() === settings.tikTok.username.toLowerCase()) roles.push('broadcaster');
    if (truthy(u.isModerator) || truthy(identity.isModeratorOfAnchor)) roles.push('moderator');
    if (truthy(u.isSubscriber) || truthy(identity.isSubscriberOfAnchor)) roles.push('subscriber');
    return {
      name: String(pick(u.nickname, u.nickName, uniqueId) || 'Someone'),
      login: uniqueId,
      avatar: pick(u.profilePictureUrl, imageUrl(u.profilePicture), imageUrl(u.avatarThumb), imageUrl(u.avatarMedium)),
      roles,
    };
  }

  function commentParts(d) {
    const comment = String(pick(d.comment, d.content, '') || '');
    const emotes = Array.isArray(d.emotes) ? d.emotes : [];
    const inserts = emotes
      .map(e => ({ pos: Number(pick(e.placeInComment, e.index, comment.length)), url: pick(e.emoteImageUrl, imageUrl(e.emote && e.emote.image), imageUrl(e.image)) }))
      .filter(e => e.url)
      .sort((a, b) => a.pos - b.pos);
    if (!inserts.length) return [{ t: 'text', v: comment }];
    const parts = [];
    let pos = 0;
    for (const { pos: p, url } of inserts) {
      const at = Math.min(Math.max(p, pos), comment.length);
      if (at > pos) parts.push({ t: 'text', v: comment.slice(pos, at) });
      parts.push({ t: 'emote', v: 'emote', url });
      pos = at;
    }
    if (pos < comment.length) parts.push({ t: 'text', v: comment.slice(pos) });
    return parts;
  }

  function makeHandler(settings, ctx) {
    const seenKinds = new Set();
    let lastViewers = 0;
    const markLive = () => ctx.setLive(true);

    return function handle(m) {
      const kind = kindOf(m);
      const d = m.data || m.payload || m;
      const s = settings;

      switch (kind) {
        case 'chat':
          markLive();
          hub.publish({ id: 'tiktok:' + (pick(d.msgId, d.common && d.common.msgId) || Math.random().toString(36).slice(2)),
            platform: 'tiktok', kind: 'chat', user: userOf(d, s), parts: commentParts(d) });
          break;

        case 'gift': {
          markLive();
          const details = d.giftDetails || d.gift || {};
          const giftType = num(pick(details.giftType, details.type, d.giftType));
          const repeatEnd = truthy(d.repeatEnd);
          // Streakable gifts (type 1) fire on every tap; only announce once the combo finishes.
          if (giftType === 1 && !repeatEnd) break;
          const count = Math.max(1, num(pick(d.repeatCount, d.comboCount, d.groupCount)) || 1);
          const diamonds = num(pick(details.diamondCount, d.diamondCount)) || 0;
          const coins = diamonds * count;
          const name = String(pick(details.giftName, details.name, d.giftName, 'a gift'));
          const picture = pick(imageUrl(details.giftImage), imageUrl(details.image), imageUrl(details.icon), d.giftPictureUrl);
          hub.publish({
            platform: 'tiktok', kind: 'donation', user: userOf(d, s),
            title: count > 1 ? `sent ${name} x${count}` : `sent ${name}`,
            amount: coins > 0 ? `${coins.toLocaleString()} coin${coins === 1 ? '' : 's'}` : undefined,
            value: coins || undefined, unit: 'coins',
            parts: picture ? [{ t: 'emote', v: name, url: picture }] : [],
            silent: coins < (s.tikTok.minGiftCoinsForSound || 0),
          });
          break;
        }

        case 'social': case 'follow': case 'share': {
          markLive();
          const label = String(pick(d.displayType, d.label, d.common && d.common.displayText && d.common.displayText.key, '') || '').toLowerCase();
          const action = num(d.action);
          const isFollow = kind === 'follow' || label.includes('follow') || action === 1;
          const isShare = kind === 'share' || label.includes('share') || action === 3;
          const user = userOf(d, s);
          if (isFollow) {
            if (hub.isDuplicate(`tiktok-follow:${user.login}`, 600000)) break;
            hub.publish({ platform: 'tiktok', kind: 'follow', user, title: 'followed' });
          } else if (isShare && s.tikTok.showShares) {
            hub.publish({ platform: 'tiktok', kind: 'chat', user, title: 'shared the LIVE', silent: true });
          }
          break;
        }

        case 'subnotify': case 'subscribe':
          markLive();
          hub.publish({ platform: 'tiktok', kind: 'sub', user: userOf(d, s), title: 'subscribed' });
          break;

        case 'like':
          markLive();
          if (s.tikTok.showLikes) hub.publish({ platform: 'tiktok', kind: 'chat', user: userOf(d, s), title: `liked the LIVE x${num(d.likeCount) || 1}`, silent: true });
          break;

        case 'member': { // someone joined: a quiet line when Settings → TikTok → "Show joins" is on, never an alert
          markLive();
          if (!s.tikTok.showJoins) break;
          const user = userOf(d, s);
          if (!user.login || hub.isDuplicate(`tiktok-join:${user.login}`, 600000)) break; // once per viewer per 10 minutes
          hub.publish({ platform: 'tiktok', kind: 'chat', user, title: 'joined', silent: true });
          break;
        }

        case 'roomuserseq': case 'roomuser': {
          markLive();
          const viewers = num(pick(d.viewerCount, d.total, d.totalUser));
          if (viewers !== undefined && Date.now() - lastViewers > 15000) {
            lastViewers = Date.now();
            ctx.stats({ viewers });
          }
          break;
        }

        case 'questionnew':
          hub.publish({ platform: 'tiktok', kind: 'chat', user: userOf(d, s), title: 'Question',
            parts: [{ t: 'text', v: String(pick(d.details && d.details.text, d.questionText, '') || '') }] });
          break;

        case 'emotechat': {
          const url = pick(d.emoteImageUrl, imageUrl(d.emote && d.emote.image), imageUrl(first(d.emoteList) && first(d.emoteList).image));
          if (url) hub.publish({ platform: 'tiktok', kind: 'chat', user: userOf(d, s), parts: [{ t: 'emote', v: 'sticker', url }] });
          break;
        }

        case 'control': case 'streamend':
          if (kind === 'streamend' || num(d.action) === 3) ctx.setLive(false);
          break;

        default:
          if (!seenKinds.has(kind)) {
            seenKinds.add(kind);
            const sample = JSON.stringify(d);
            hub.diagnostic(`TikTok: unhandled "${pick(m.type, m.method, m.event, kind)}" ${sample.length > 300 ? sample.slice(0, 300) + '…' : sample}`);
          }
      }
    };
  }

  const CLOSE = {
    4401: () => new ConnectorError('Euler Stream rejected the API key. Check it in Settings.', { config: true }),
    4403: () => new ConnectorError("Your Euler Stream plan doesn't allow this connection.", { config: true }),
    4429: () => new ConnectorError('Too many TikTok connections (free plan allows 25). Close other UniChat tabs.', { retryAfterMs: 60000 }),
  };

  let notLiveSince = 0;

  // How many Euler connections were opened today (UTC), by this browser or by your relay, so it can be compared with the
  // usage shown in your Euler dashboard. Settings → TikTok shows it.
  const COUNT_KEY = 'unichat.web.tiktokCount';
  const utcDay = () => new Date().toISOString().slice(0, 10);
  function countConnection(via, relayToday) {
    try {
      const saved = JSON.parse(localStorage.getItem(COUNT_KEY) || 'null') || {};
      const same = saved.day === utcDay() && saved.via === via;
      const n = via === 'relay' ? Math.max(0, Math.floor(Number(relayToday) || 0)) : (same ? Number(saved.n) || 0 : 0) + 1;
      localStorage.setItem(COUNT_KEY, JSON.stringify({ day: utcDay(), via, n }));
    } catch { /* storage blocked: no counter */ }
  }

  const RELAY_URL = (window.UniChatStore && window.UniChatStore.RELAY_URL) || '';
  const useRelay = s => s.tikTok.useRelay === true && !!RELAY_URL;

  registerConnector({
    id: 'tiktok',
    label: 'TikTok',
    platform: 'tiktok',
    configKey: s => (!s.tikTok.enabled || !s.tikTok.username ? null
      : useRelay(s) ? `tt|relay|${s.tikTok.username}`
        : s.tikTok.eulerKey ? `tt|${s.tikTok.username}|${s.tikTok.eulerKey}` : null),
    disabledReason: s => (!s.tikTok.enabled ? 'Disabled' : !s.tikTok.username ? 'No TikTok username set' : 'Needs your free Euler Stream API key (Settings → TikTok)'),
    idleState: s => (s.tikTok.enabled && s.tikTok.username && !useRelay(s) && !s.tikTok.eulerKey ? 'setup' : null), // red dot: needs the key

    run(s, ctx, signal) {
      const user = s.tikTok.username;
      const viaRelay = useRelay(s);
      return new Promise((resolve, reject) => {
        // Directly to Euler with the key saved in this browser, or (experimental) to your own relay, which holds the key
        // and shares one Euler connection between all your pages.
        const url = viaRelay
          ? `${RELAY_URL}?user=${encodeURIComponent(user)}`
          : `wss://ws.eulerstream.com?uniqueId=${encodeURIComponent(user)}&apiKey=${encodeURIComponent(s.tikTok.eulerKey)}`;
        if (!viaRelay) countConnection('browser');
        const ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';
        const handle = makeHandler(s, ctx);
        let finished = false;
        let gotData = false;
        let lastData = Date.now();
        let warnedBinary = false;
        const idleTimer = setInterval(() => {
          // A live TikTok sends viewer counts every few seconds; 3 minutes of silence means the link is stuck. The relay
          // also says hello every 30 seconds, so 90 seconds without a word from it means it's gone.
          if (viaRelay && Date.now() - lastData > 90000) finish(new ConnectorError('No word from your relay for 90 seconds'));
          else if (gotData && Date.now() - lastData > 180000) finish(new ConnectorError('No TikTok data for 3 minutes'));
        }, 30000);

        function finish(err) {
          if (finished) return;
          finished = true;
          clearInterval(idleTimer);
          try { ws.close(); } catch { /* already closed */ }
          if (err) reject(err); else resolve();
        }
        signal.addEventListener('abort', () => finish(), { once: true });

        ws.onmessage = ev => {
          lastData = Date.now();
          if (typeof ev.data !== 'string') {
            if (!warnedBinary) { warnedBinary = true; hub.diagnostic('TikTok: received binary data; only JSON messages are supported'); }
            return;
          }
          let payload;
          try { payload = JSON.parse(ev.data); } catch { return; }
          if (viaRelay && payload && typeof payload === 'object' && payload.relay && typeof payload.relay === 'object') { relayStatus(payload.relay); return; }
          if (!gotData) { gotData = true; notLiveSince = 0; ctx.connected(viaRelay ? `@${user} · via your relay` : `@${user}`); }
          const list = Array.isArray(payload && payload.messages) ? payload.messages : Array.isArray(payload) ? payload : [payload];
          for (const m of list) {
            if (!m || typeof m !== 'object') continue;
            try { handle(m); } catch (err) { console.warn('UniChat: skipped a TikTok message', err); }
          }
        };
        /**
         * The relay's own notes: { state: 'connecting' | 'open' | 'offline' | 'error' | 'paused', reason, retryAt, today }.
         * The relay keeps retrying Euler itself, so "not live" doesn't close this page's connection to it.
         */
        function relayStatus(r) {
          const reason = typeof r.reason === 'string' ? r.reason.slice(0, 200) : '';
          if (Number.isFinite(r.today)) countConnection('relay', r.today);
          switch (r.state) {
            case 'offline':
              ctx.setLive(false);
              gotData = false;
              ctx.waiting(`@${user} isn't live right now (your relay keeps checking)`);
              break;
            case 'open':
              ctx.connected(`@${user} · via your relay`);
              break;
            case 'error':
              finish(new ConnectorError(`Your relay: ${reason || 'Euler refused the connection'}`, { config: true }));
              break;
            case 'paused':
              finish(new ConnectorError(`Your relay: ${reason || 'paused for today to protect your Euler key'}`, { config: true, retryAfterMs: 1800000 }));
              break;
            default: // 'connecting', heartbeats: nothing to show
          }
        }

        ws.onerror = () => { /* onclose follows */ };
        ws.onclose = ev => {
          hub.diagnostic(`TikTok: connection closed (code ${ev.code}${ev.reason ? ', ' + ev.reason : ''})`);
          if (viaRelay) {
            // 4403: the relay refused this page (wrong username or site); 4429: too many pages connected.
            const why = String(ev.reason || '').slice(0, 200);
            if (ev.code === 4403) finish(new ConnectorError(`Your relay refused the connection${why ? ': ' + why : ''}`, { config: true }));
            else if (ev.code === 4429) finish(new ConnectorError(`Your relay is busy${why ? ': ' + why : ''}`, { retryAfterMs: 60000 }));
            else finish(new ConnectorError(why || (ev.code === 1006 ? "Can't reach your relay" : `Relay connection closed (${ev.code})`)));
            return;
          }
          if (ev.code === 4404 || ev.code === 4005) {
            // Not live (or stream just ended): keep checking quietly, less often after a while to save your free quota.
            ctx.setLive(false);
            if (!notLiveSince) notLiveSince = Date.now();
            const slow = Date.now() - notLiveSince > 20 * 60000;
            finish(new ConnectorError(`@${user} isn't live right now`, { waiting: true, retryAfterMs: slow ? 180000 : 90000 }));
            return;
          }
          const special = CLOSE[ev.code];
          finish(special ? special() : new ConnectorError(ev.reason || (ev.code === 1006 ? 'Connection dropped' : `Connection closed (${ev.code})`)));
        };
      });
    },
  });

  window.UniChatTikTok = { makeHandler, kindOf }; // exposed for testing
})();
