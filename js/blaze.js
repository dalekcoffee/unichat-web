/* Blaze (blaze.stream) chat, read as a guest straight from this browser, the same way blaze.stream's own page does:
   look the channel up, open Blaze's Socket.IO feed, then ask Blaze to add this socket to the channel's rooms.
   No account or login: chat (with pictures and emotes), subs, gifted subs, tips, replies, deletions and the
   LIVE badge. Blaze's public developer API needs a registered app with a secret, so it isn't used.
   Event types this doesn't recognise are listed in Settings → Diagnostics. */
(function () {
  'use strict';
  const { hub, ConnectorError, registerConnector, runSocketIo } = window.UniChatHub;

  const API = 'https://blaze.stream/bapi';
  const SOCKET = 'wss://blaze.stream';
  const VISITOR_KEY = 'unichat.web.blazeVisitor';
  const EMOTE = /\[emote:([0-9a-f-]{8,40})\]/gi;

  const own = (table, key) => Object.prototype.hasOwnProperty.call(table, key);
  const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const str = v => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
  const num = v => { const n = Number(v); return v !== null && v !== '' && Number.isFinite(n) ? n : undefined; };
  /** Pictures and emotes only from Blaze's own servers. */
  const blazeUrl = u => (typeof u === 'string' && /^https:\/\/(?:[a-z0-9-]+\.)*blaze\.stream\/[\w./%-]+$/i.test(u) ? u : '');

  // randomUUID only exists on https pages; getRandomValues works everywhere.
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));

  /** Blaze's site sends an anonymous visitor ID with every request; this browser keeps one of its own. */
  function visitorId() {
    try {
      let v = localStorage.getItem(VISITOR_KEY);
      if (!v || !/^[0-9a-f-]{36}$/.test(v)) { v = uuid(); localStorage.setItem(VISITOR_KEY, v); }
      return v;
    } catch { return uuid(); }
  }
  const request = (path, init, signal) => fetch(API + path, Object.assign({ credentials: 'omit', signal }, init, {
    headers: Object.assign({ 'visitor-id': visitorId() }, init && init.headers),
  }));

  // ---------- Messages ----------
  /** "hi [emote:uuid]" + [{ id, name, imageUrl }] → text + emote parts. */
  function buildParts(message, emotes) {
    const text = str(message);
    const known = new Map((Array.isArray(emotes) ? emotes : []).map(e => [str(obj(e).id).toLowerCase(), obj(e)]));
    const parts = [];
    let pos = 0;
    for (const m of text.matchAll(EMOTE)) {
      if (m.index > pos) parts.push({ t: 'text', v: text.slice(pos, m.index) });
      const e = known.get(m[1].toLowerCase());
      const url = e && blazeUrl(e.imageUrl);
      parts.push(url ? { t: 'emote', v: str(e.name) || 'emote', url } : { t: 'text', v: e && e.name ? `:${str(e.name)}:` : '' });
      pos = m.index + m[0].length;
    }
    if (pos < text.length) parts.push({ t: 'text', v: text.slice(pos) });
    return parts.filter(p => p.t !== 'text' || p.v);
  }

  const ROLE = { owner: 'broadcaster', broadcaster: 'broadcaster', moderator: 'moderator', mod: 'moderator', vip: 'vip', og: 'vip', staff: 'staff', admin: 'staff' };

  function buildUser(sender, channelSlug) {
    const s = obj(sender);
    const name = str(s.displayName) || str(s.slug) || 'unknown';
    const login = (str(s.slug) || name).toLowerCase();
    const roles = [];
    if (s.isOwner === true || login === channelSlug) roles.push('broadcaster');
    for (const r of Array.isArray(s.roles) ? s.roles : []) {
      const role = own(ROLE, str(r).toLowerCase()) ? ROLE[str(r).toLowerCase()] : null;
      if (role && !roles.includes(role)) roles.push(role);
    }
    if (s.isSubscriber === true && !roles.includes('subscriber')) roles.push('subscriber');
    return { name, login, color: null, roles, avatar: blazeUrl(s.avatarUrl), isBot: s.isBot === true };
  }

  /** Someone named in a sub / gift / tip notice (these carry names in actionInfo). */
  function namedUser(displayName, slug, fallback = 'Someone') {
    const name = str(displayName) || str(slug);
    return name ? { name, login: (str(slug) || name).toLowerCase(), roles: [] } : { name: fallback, login: '', roles: [] };
  }

  const DELETES = new Set(['deletemessage', 'message_delete', 'message_deleted', 'channel_chat_message_delete']);
  const QUIET = new Set(['pin', 'unpin', 'gift_received', 'commerce_bid', 'auction_won', 'fulfilled', 'pinned_listing_updated']);

  function makeHandler(slug, channelId, ctx) {
    const reported = new Set();
    const report = (what, data) => {
      if (reported.has(what)) return;
      reported.add(what);
      const sample = JSON.stringify(data);
      hub.diagnostic(`Blaze: unhandled ${what} ${sample && sample.length > 300 ? sample.slice(0, 300) + '…' : sample}`);
    };
    const ts = d => Date.parse(d.createdAt) || Date.now();

    function chat(d) {
      const type = str(d.type || d.eventType).trim().toLowerCase().replace(/[\s.:-]+/g, '_') || 'text';
      const info = obj(d.actionInfo);
      const id = 'blaze:' + (str(d.id) || Math.random().toString(36).slice(2));
      if (DELETES.has(type)) {
        const ids = [d.messageId, info.messageId, d.targetMessageId, d.id].map(str).filter(Boolean).map(x => 'blaze:' + x);
        if (ids.length) hub.deleteMessages('blaze', ids);
        return;
      }
      switch (type) {
        case 'text': {
          const r = obj(d.replyTo);
          hub.publish({
            id, platform: 'blaze', kind: 'chat', ts: ts(d), user: buildUser(d.sender, slug), parts: buildParts(d.message, d.emotes),
            reply: d.replyTo ? { id: r.id ? 'blaze:' + str(r.id) : null, name: str(obj(r.sender).displayName), text: str(r.message).replace(EMOTE, '') } : null,
          });
          break;
        }
        case 'subscribed':
          // "subscribed for 3 months. Total is now 3 months, …": the first sentence is enough for an alert.
          hub.publish({ id, platform: 'blaze', kind: 'sub', ts: ts(d), user: namedUser(info.displayName, info.slug), title: str(d.message).split(/(?<=\.)\s/)[0] || 'subscribed' });
          break;
        case 'gift_sent': {
          const count = Math.max(1, Math.floor(num(info.amount) || 1));
          hub.publish({ id, platform: 'blaze', kind: 'sub', ts: ts(d), user: namedUser(info.senderDisplayName, info.senderSlug, 'Anonymous'),
            title: `gifted ${count} sub${count === 1 ? '' : 's'}`, value: count, unit: 'gifts' });
          break;
        }
        case 'thanks': { // a tip ("Thanks" on blaze.stream)
          const sender = d.sender ? buildUser(d.sender, slug) : namedUser(info.senderDisplayName, info.senderSlug);
          const amount = str(info.amount);
          hub.publish({ id, platform: 'blaze', kind: 'donation', ts: ts(d), user: sender, title: 'sent a tip', amount: amount || undefined,
            parts: d.message ? buildParts(d.message, d.emotes) : [] });
          break;
        }
        case 'vote': // "X is giving 50 Votes to Y." (Backstage votes): a quiet line
          hub.publish({ id, platform: 'blaze', kind: 'chat', ts: ts(d), user: namedUser(info.senderDisplayName, info.senderSlug), title: 'Votes', silent: true,
            parts: [{ t: 'text', v: str(d.message) }] });
          break;
        case 'raid': case 'raided': case 'incoming_raid': {
          const viewers = num(info.viewerCount) || num(info.viewers) || num(info.amount) || 0;
          hub.publish({ id, platform: 'blaze', kind: 'raid', ts: ts(d), user: namedUser(info.senderDisplayName || info.displayName, info.senderSlug || info.slug),
            title: viewers ? `is raiding with ${viewers} viewer${viewers === 1 ? '' : 's'}` : 'is raiding', value: viewers, unit: 'viewers' });
          break;
        }
        default:
          if (!QUIET.has(type)) report(`chat type "${type}"`, d);
      }
    }

    return function handle(name, data) {
      const d = obj(data);
      if (name === `channel_chat_${channelId}`) chat(d);
      else if (name === `channel_is_live_${channelId}`) { if (typeof d.isLive === 'boolean') ctx.setLive(d.isLive); }
      else if (name === `action_${channelId}`) {
        // This channel raiding someone else (blaze.stream sends its viewers there).
        if (d.type === 'raid' && d.channelName) {
          hub.publish({ platform: 'blaze', kind: 'system', level: 'info', code: 'raid-out', parts: [{ t: 'text', v: `Blaze: raiding ${str(d.channelName)}` }] });
        } else report(`action "${str(d.type)}"`, d);
      } else if (name === `channel_${channelId}` || name === 'eventsub') {
        // title / category updates and the connection welcome: nothing to show
      } else report(`event "${name.replace(channelId, '<id>')}"`, d);
    };
  }

  // ---------- Finding the channel ----------
  async function lookup(slug, signal) {
    let res;
    try { res = await request(`/channels/s/${encodeURIComponent(slug)}`, null, signal); }
    catch (err) { if (signal.aborted) throw err; throw new ConnectorError(`Couldn't reach blaze.stream (${err.message})`); }
    const body = obj(await res.json().catch(() => null));
    const data = obj(body.data);
    if (res.status === 404 || (res.ok && !data.channelId)) throw new ConnectorError(`Blaze channel '${slug}' not found (check the spelling)`, { config: true });
    if (!res.ok) throw new ConnectorError(`blaze.stream refused the channel lookup (HTTP ${res.status})`);
    const id = str(data.channelId);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ConnectorError("blaze.stream's answer had no usable channel ID");
    const since = Date.parse(str(data.streamStartedAt));
    return { id, live: typeof data.isLive === 'boolean' ? data.isLive : null, since: Number.isFinite(since) ? since : undefined };
  }

  registerConnector({
    id: 'blaze',
    label: 'Blaze',
    platform: 'blaze',
    configKey: s => (s.blaze.enabled && s.blaze.channel ? `blaze|${s.blaze.channel}` : null),
    disabledReason: s => (s.blaze.enabled ? 'No channel set' : 'Disabled'),

    async run(s, ctx, signal) {
      const slug = s.blaze.channel;
      const channel = await lookup(slug, signal);
      if (channel.live !== null) ctx.setLive(channel.live);
      if (channel.live) ctx.stats({ since: channel.since });
      const handle = makeHandler(slug, channel.id, ctx);
      await runSocketIo(SOCKET, '/', signal, {
        async connected({ sid }) {
          if (!sid) throw new ConnectorError('Blaze sent no session ID');
          const res = await request('/auth/socket/enter-room', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ socketId: sid, externalId: channel.id, rooms: ['channel', 'stream'] }),
          }, signal);
          if (!res.ok) throw new ConnectorError(`Blaze wouldn't let this page join the chat (HTTP ${res.status})`);
          ctx.connected(`blaze.stream/${slug}`);
        },
        event: handle,
      });
    },
  });

  window.UniChatBlaze = { buildParts, makeHandler }; // exposed for testing
})();
