/* Kick chat, read from Kick's public Pusher WebSocket (the same feed kick.com's own chat uses), straight from this
   browser. No account or login: chat, subs, gifted subs, KICKs, follows, deletions and bans, plus profile pictures.
   The channel's chatroom ID is looked up once on kick.com and remembered in this browser. Event types this doesn't
   recognise are listed in Settings → Diagnostics. */
(function () {
  'use strict';
  const { hub, ConnectorError, registerConnector, avatarLookup, watchResume } = window.UniChatHub;

  // Kick's public Pusher app key (the one kick.com's own chat page uses). If Kick ever changes it, update it here.
  const PUSHER_URL = 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false';
  const CHANNEL_API = slug => `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`;
  const EMOTE = /\[emote:(\d+):([^\]]*)\]/g;
  const IDS_KEY = 'unichat.web.kickIds';

  const own = (table, key) => Object.prototype.hasOwnProperty.call(table, key);
  const num = v => { const n = Number(v); return v !== null && v !== '' && Number.isFinite(n) ? n : undefined; };
  const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const slugOf = name => String(name || '').trim().toLowerCase().replace(/_/g, '-'); // Kick links use - for _

  // ---------- Profile pictures ----------
  // Kick chat doesn't include profile pictures; each chatter's public channel on kick.com has one. Looked up gently,
  // one name every 3 seconds (see avatarLookup in hub.js). Only pictures on Kick's own servers are used.
  const Avatars = avatarLookup({
    platform: 'kick',
    login: /^[a-z0-9-]{1,40}$/, // Kick's links never contain _
    gapMs: 3000,
    clean: url => (typeof url === 'string' && /^https:\/\/(?:[a-z0-9-]+\.)*kick\.com\/[\w./%-]+$/i.test(url) ? url : ''),
    async lookup([slug], signal) {
      const res = await fetch(CHANNEL_API(slug), { credentials: 'omit', signal });
      if (res.status === 404) return new Map();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = obj(await res.json());
      return new Map([[slug, obj(j.user).profile_pic]]);
    },
  });

  // ---------- Messages ----------
  /** "hi [emote:123:KEKW]" → text + emote parts. */
  function buildParts(content) {
    const text = String(content || '');
    const parts = [];
    let pos = 0;
    for (const m of text.matchAll(EMOTE)) {
      if (m.index > pos) parts.push({ t: 'text', v: text.slice(pos, m.index) });
      parts.push({ t: 'emote', v: m[2] || 'emote', url: `https://files.kick.com/emotes/${m[1]}/fullsize` });
      pos = m.index + m[0].length;
    }
    if (pos < text.length) parts.push({ t: 'text', v: text.slice(pos) });
    return parts;
  }
  const stripEmotes = s => String(s || '').replace(EMOTE, (_, id, name) => name);

  const ROLE = { broadcaster: 'broadcaster', moderator: 'moderator', vip: 'vip', og: 'vip', founder: 'founder',
    subscriber: 'subscriber', verified: 'verified', staff: 'staff' };

  function buildUser(sender, channelSlug) {
    const s = obj(sender);
    const identity = obj(s.identity);
    const name = String(s.username || 'unknown');
    const login = String(s.slug || slugOf(name)).toLowerCase();
    const roles = [];
    const badges = [].concat(Array.isArray(identity.badges) ? identity.badges : [], Array.isArray(identity.badges_v2) ? identity.badges_v2 : []);
    for (const b of badges) {
      const key = String(obj(b).type || obj(b).name || '');
      const role = own(ROLE, key) ? ROLE[key] : null;
      if (role && !roles.includes(role)) roles.push(role);
    }
    if (login === channelSlug && !roles.includes('broadcaster')) roles.push('broadcaster');
    return { name, login, color: identity.color || null, roles, avatar: Avatars.get(login) };
  }

  /** Someone named in a sub / gift / follow event (these carry a username only, or none for anonymous gifts). */
  function namedUser(name, color, fallback = 'Someone') {
    if (!name) return { name: fallback, login: '', roles: [] };
    const login = slugOf(name);
    return { name: String(name), login, color: color || null, roles: [], avatar: Avatars.get(login) };
  }

  function makeHandler(slug, ctx) {
    const reported = new Set();

    function follow(name) {
      if (hub.isDuplicate(`kick-follow:${slugOf(name)}`, 600000)) return;
      hub.publish({ platform: 'kick', kind: 'follow', user: namedUser(name), title: 'followed' });
    }

    function kicks(d) {
      const sender = obj(d.sender);
      const gift = obj(d.gift);
      const tx = d.gift_transaction_id;
      if (tx && hub.isDuplicate(`kick-kicks:${tx}`, 300000)) return;
      const amount = Math.max(0, num(gift.amount) || num(d.amount) || 0);
      hub.publish({
        platform: 'kick', kind: 'donation', user: namedUser(sender.username || d.username, sender.username_color),
        title: gift.name ? `sent ${gift.name}` : 'sent KICKs',
        amount: amount > 0 ? `${amount.toLocaleString()} KICK${amount === 1 ? '' : 's'}` : undefined,
        value: amount || undefined, unit: 'KICKs',
        parts: d.message ? buildParts(d.message) : [],
      });
    }

    /** missed: filled in after a reconnect (see catchUp). */
    return function handle(event, data, missed) {
      const name = String(event).replace(/^App\\Events\\/, '');
      const d = obj(data);
      switch (name) {
        case 'ChatMessageEvent': {
          let meta = d.metadata;
          if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } } // saved chat sends it as text
          meta = obj(meta);
          const original = obj(meta.original_message);
          const reply = d.type === 'reply' && meta.original_sender
            ? { id: original.id ? 'kick:' + original.id : null, name: String(obj(meta.original_sender).username || ''), text: stripEmotes(original.content) }
            : null;
          const ts = Date.parse(d.created_at) || Date.now();
          if (newest.slug === slug) newest.at = Math.max(newest.at, ts);
          const kid = typeof d.id === 'string' || typeof d.id === 'number' ? String(d.id).slice(0, 80) : '';
          hub.publish({
            id: 'kick:' + (kid || Math.random().toString(36).slice(2)),
            platform: 'kick', kind: 'chat', ts, missed: missed || undefined,
            user: buildUser(d.sender, slug), parts: buildParts(d.content), reply,
          });
          break;
        }
        case 'MessageDeletedEvent':
          if (obj(d.message).id) hub.deleteMessages('kick', ['kick:' + obj(d.message).id]);
          break;
        case 'UserBannedEvent': {
          const who = obj(d.user).slug || obj(d.user).username;
          if (who) hub.clearUser('kick', slugOf(who));
          break;
        }
        case 'ChatroomClearEvent':
          hub.clearUser('kick', null);
          break;
        case 'SubscriptionEvent': {
          const months = Math.max(1, Math.floor(num(d.months) || 1));
          if (hub.isDuplicate(`kick-sub:${slugOf(d.username)}:${months}`, 15000)) break; // can arrive on two channels
          hub.publish({ platform: 'kick', kind: 'sub', user: namedUser(d.username), title: months > 1 ? `subscribed for ${months} months` : 'subscribed' });
          break;
        }
        case 'GiftedSubscriptionsEvent': {
          const count = Math.max(1, Math.floor(Array.isArray(d.gifted_usernames) ? d.gifted_usernames.length : num(d.quantity) || 1));
          const who = d.gifter_username || d.username;
          if (hub.isDuplicate(`kick-gifts:${slugOf(who)}:${count}`, 15000)) break;
          hub.publish({ platform: 'kick', kind: 'sub', user: namedUser(who, null, 'Anonymous'), title: `gifted ${count} sub${count === 1 ? '' : 's'}`, value: count, unit: 'gifts' });
          break;
        }
        case 'FollowersUpdated':
          // Carries a username only for some follows; count-only updates are skipped.
          if (d.followed === true && d.username) follow(d.username);
          break;
        case 'NewActivityFeedEvent':
          if (/follow/i.test(String(d.type || '')) && d.username) follow(d.username);
          break;
        case 'StreamerIsLive':
          ctx.setLive(true);
          break;
        case 'StopStreamBroadcast':
          ctx.setLive(false);
          break;
        // Duplicates of events handled above, or noise that isn't shown.
        case 'ChatMessageSentEvent': case 'ChannelSubscriptionEvent': case 'NewSubscriberUpdatedEvent':
        case 'LuckyUsersWhoGotGiftSubscriptionsEvent': case 'PinnedMessageCreatedEvent': case 'PinnedMessageDeletedEvent':
        case 'ChatroomUpdatedEvent': case 'LivestreamUpdated': case 'PollUpdateEvent': case 'PollDeleteEvent':
          break;
        default:
          if (/kicks/i.test(name) && /gift/i.test(name)) kicks(d);
          else if (!reported.has(name)) {
            reported.add(name);
            const sample = JSON.stringify(data);
            hub.diagnostic(`Kick: unhandled "${name}" ${sample && sample.length > 300 ? sample.slice(0, 300) + '…' : sample}`);
          }
      }
    };
  }

  // ---------- Finding the channel's chatroom ----------
  function savedIds(slug) {
    try {
      const all = JSON.parse(localStorage.getItem(IDS_KEY) || '{}');
      const v = all && own(all, slug) ? all[slug] : null;
      return v && num(v.chatroom) > 0 ? { chatroom: num(v.chatroom), channel: num(v.channel) || null } : null;
    } catch { return null; }
  }
  function saveIds(slug, ids) {
    try {
      const all = JSON.parse(localStorage.getItem(IDS_KEY) || '{}') || {};
      const next = Object.create(null);
      for (const k of Object.keys(all).filter(k => k !== slug).slice(-19)) next[k] = all[k];
      next[slug] = ids;
      localStorage.setItem(IDS_KEY, JSON.stringify(next));
    } catch { /* full or blocked: looked up again next time */ }
  }

  const BLOCKED_HINT = "if it keeps happening, enter the channel's chatroom ID in Settings → Kick";

  /** { chatroom, channel, live } for a channel: from kick.com, or remembered / entered by hand if kick.com says no. */
  async function resolveIds(s, slug, signal) {
    const manual = num(s.kick.chatroomId) || 0;
    if (manual > 0) return { chatroom: manual, channel: null, live: null };
    const saved = savedIds(slug);
    let res;
    try {
      res = await fetch(CHANNEL_API(slug), { credentials: 'omit', signal });
    } catch (err) {
      if (signal.aborted) throw err;
      if (saved) return Object.assign({ live: null }, saved);
      throw new ConnectorError(`Couldn't look the channel up on kick.com (blocked or offline). Retrying; ${BLOCKED_HINT}`);
    }
    if (res.status === 404) throw new ConnectorError(`Kick channel '${slug}' not found (check the spelling)`, { config: true });
    if (!res.ok) {
      if (saved) return Object.assign({ live: null }, saved);
      throw new ConnectorError(`kick.com blocked the channel lookup (HTTP ${res.status}). Retrying; ${BLOCKED_HINT}`, { config: true });
    }
    const j = obj(await res.json());
    const chatroom = num(obj(j.chatroom).id);
    if (!(chatroom > 0)) throw new ConnectorError("kick.com's answer had no chatroom ID");
    const ids = { chatroom, channel: num(j.id) || null };
    saveIds(slug, ids);
    return Object.assign({ live: !!j.livestream, stats: streamStats(j.livestream) }, ids);
  }

  /** Viewer count and start time from kick.com's livestream info (its times are UTC without a zone). */
  function streamStats(ls) {
    const l = obj(ls);
    const t = String(l.start_time || l.created_at || '');
    const since = Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?$/.test(t) ? t.replace(' ', 'T') + 'Z' : t);
    const viewers = num(l.viewer_count);
    return { viewers: viewers >= 0 ? viewers : undefined, since: Number.isFinite(since) ? since : undefined };
  }

  /** Re-checks live status (and the viewer count) every 2 minutes, in case a start/stop event was missed. */
  async function checkLive(slug, ctx, signal) {
    try {
      const res = await fetch(CHANNEL_API(slug), { credentials: 'omit', signal });
      if (!res.ok) return;
      const j = obj(await res.json());
      ctx.setLive(!!j.livestream);
      if (j.livestream) ctx.stats(streamStats(j.livestream));
    } catch { /* next check will try again */ }
  }

  // ---------- Catching up after a reconnect ----------
  // Kick's feed doesn't resend chat you missed while disconnected, but kick.com shows a channel's last 25 messages, so
  // after reconnecting UniChat adds the ones newer than the newest it had (quietly: no sounds or popups). Messages it
  // already showed are skipped (hub.js ignores IDs it has seen).
  const newest = { slug: '', at: 0 }; // time of the newest message shown from this channel
  async function catchUp(slug, channelId, signal) {
    if (newest.slug !== slug) { newest.slug = slug; newest.at = hub.latest('kick'); } // after a reload: the saved chat
    const since = newest.at;
    if (!since || !channelId) return [];
    const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(channelId)}/messages`, { credentials: 'omit', signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.text();
    if (raw.length > 2000000) throw new Error('answer too big'); // 25 messages are ~25 KB
    const list = obj(obj(JSON.parse(raw)).data).messages;
    return (Array.isArray(list) ? list : []).map(obj)
      .filter(m => (Date.parse(m.created_at) || 0) > since && Date.now() - Date.parse(m.created_at) < 6 * 3600000)
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  }
  let catchUpReported = false;

  // Pusher close codes 4000–4099 mean "don't reconnect unchanged" (e.g. 4001: Kick changed its app key).
  const closeError = ev => (ev.code >= 4000 && ev.code < 4100
    ? new ConnectorError(`Kick's chat server refused the connection (${ev.code}${ev.reason ? ': ' + ev.reason : ''}). UniChat may need an update.`, { config: true })
    : new ConnectorError(ev.reason || (ev.code === 1006 ? 'Connection dropped' : `Connection closed (${ev.code})`)));

  registerConnector({
    id: 'kick',
    label: 'Kick',
    platform: 'kick',
    configKey: s => (s.kick.enabled && s.kick.channel ? `kick|${s.kick.channel}|${s.kick.chatroomId || ''}` : null),
    disabledReason: s => (s.kick.enabled ? 'No channel set' : 'Disabled'),

    async run(s, ctx, signal) {
      const slug = s.kick.channel;
      const ids = await resolveIds(s, slug, signal);
      if (ids.live !== null) ctx.setLive(ids.live);
      if (ids.live) ctx.stats(ids.stats);
      const handle = makeHandler(slug, ctx);

      return new Promise((resolve, reject) => {
        const ws = new WebSocket(PUSHER_URL);
        const chatChannel = `chatrooms.${ids.chatroom}.v2`;
        const channels = [chatChannel, `chatroom_${ids.chatroom}`];
        if (ids.channel) channels.push(`channel_${ids.channel}`, `channel.${ids.channel}`);
        let finished = false;
        let lastData = Date.now();
        let pingTimer = null;
        let held = null; // chat events waiting for the missed chat to be filled in first
        const liveTimer = setInterval(() => checkLive(slug, ctx, signal), 120000);

        function finish(err) {
          if (finished) return;
          finished = true;
          clearInterval(pingTimer);
          clearInterval(liveTimer);
          try { ws.close(); } catch { /* already closed */ }
          if (err) reject(err); else resolve();
        }
        signal.addEventListener('abort', () => finish(), { once: true });
        // Back from the background: Kick answers a ping at once if the connection survived.
        watchResume(ctx, { lastData: () => lastData, waitMs: 8000, fail: finish,
          ping: () => { if (ws.readyState === WebSocket.OPEN) ws.send('{"event":"pusher:ping","data":{}}'); } });

        ws.onmessage = ev => {
          lastData = Date.now();
          let msg;
          try { msg = JSON.parse(ev.data); } catch { return; }
          if (!msg || typeof msg.event !== 'string') return;
          let data = msg.data;
          if (typeof data === 'string') { try { data = data ? JSON.parse(data) : null; } catch { data = null; } } // Pusher double-encodes
          switch (msg.event) {
            case 'pusher:connection_established': {
              const activity = Math.max(30, num(obj(data).activity_timeout) || 120);
              for (const c of channels) ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: c } }));
              pingTimer = setInterval(() => {
                if (Date.now() - lastData > (activity + 60) * 1000) { finish(new ConnectorError(`No data from Kick for ${activity + 60}s`)); return; }
                if (ws.readyState === WebSocket.OPEN) ws.send('{"event":"pusher:ping","data":{}}');
              }, Math.min(60, Math.max(20, activity / 2)) * 1000);
              break;
            }
            case 'pusher_internal:subscription_succeeded':
              if (msg.channel === chatChannel) {
                ctx.connected(`kick.com/${slug}`);
                // New lines wait while the missed ones load (5 s at most), so everything shows in order.
                held = [];
                const give = new AbortController();
                const giveUp = setTimeout(() => give.abort(), 5000);
                signal.addEventListener('abort', () => give.abort(), { once: true });
                catchUp(slug, ids.channel, give.signal)
                  .then(list => { if (!finished) list.forEach(m => { try { handle('ChatMessageEvent', m, true); } catch (err) { console.warn('UniChat: skipped a missed Kick message', err); } }); })
                  .catch(err => {
                    if (finished || catchUpReported) return;
                    catchUpReported = true; // once per page
                    hub.diagnostic(`Kick: couldn't fill in missed chat (${err.name === 'AbortError' ? 'no answer in 5 s' : err.message})`);
                  })
                  .finally(() => {
                    clearTimeout(giveUp);
                    const waiting = held || [];
                    held = null;
                    if (!finished) waiting.forEach(([ev, data]) => { try { handle(ev, data); } catch (err) { console.warn('UniChat: skipped a Kick message', err); } });
                  });
              }
              break;
            case 'pusher:error':
              hub.diagnostic(`Kick: server said ${JSON.stringify(data)}`);
              break;
            case 'pusher:ping':
              ws.send('{"event":"pusher:pong","data":{}}');
              break;
            case 'pusher:pong':
              break;
            default:
              if (held) { held.push([msg.event, data]); break; } // missed chat is loading (see above)
              try { handle(msg.event, data); } catch (err) { console.warn('UniChat: skipped a Kick message', err); }
          }
        };
        ws.onerror = () => { /* onclose follows with the details */ };
        ws.onclose = ev => finish(closeError(ev));
      });
    },
  });

  window.UniChatKick = { buildParts, makeHandler }; // exposed for testing
})();
