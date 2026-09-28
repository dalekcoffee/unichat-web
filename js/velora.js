/* Velora (velora.tv) chat, read as a guest over Velora's documented chat socket, straight from this browser.
   No account or login: chat (with pictures, colours and roles), replies, raids, channel-point redemptions and
   moderation. Follows, subs and Volts tips are only sent to apps the streamer has logged in to, so they're not
   included, and emotes show as their :names: (Velora only lets its own site read the emote list).
   Unrecognised event and card types are listed in Settings → Diagnostics. */
(function () {
  'use strict';
  const { hub, ConnectorError, registerConnector, runSocketIo } = window.UniChatHub;

  const SOCKET = 'wss://api.velora.tv';

  const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const str = v => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
  const num = v => { const n = Number(v); return v !== null && v !== '' && Number.isFinite(n) ? n : undefined; };
  /** Pictures only from Velora's own servers. */
  const veloraUrl = u => (typeof u === 'string' && /^https:\/\/(?:[a-z0-9-]+\.)*velora\.tv\/[\w./%-]+$/i.test(u) ? u : '');

  // ---------- Messages ----------
  // Chat messages are flat ({ username, displayName, avatarUrl, message, … }); the docs also describe a
  // { sender, content } form, so both are accepted.
  function fieldOf(d) {
    const s = obj(d.sender);
    return k => (d[k] !== undefined && d[k] !== null && d[k] !== '' ? d[k] : s[k]);
  }

  const ROLE = { owner: 'broadcaster', broadcaster: 'broadcaster', moderator: 'moderator', mod: 'moderator', vip: 'vip',
    subscriber: 'subscriber', staff: 'staff', admin: 'staff', founder: 'founder' };

  function buildUser(d, channel) {
    const f = fieldOf(d);
    const username = str(f('username')) || 'unknown';
    const login = username.toLowerCase();
    const roles = [];
    const words = [str(f('role')), str(d.channelRole)]
      .concat(Array.isArray(d.userRoles) ? d.userRoles : [], Array.isArray(d.badges) ? d.badges : [])
      .map(w => str(w).toLowerCase());
    if (login === channel) words.push('broadcaster');
    if (f('isModerator') === true) words.push('moderator');
    if (f('isVip') === true) words.push('vip');
    if (f('isSubscriber') === true) words.push('subscriber');
    for (const w of words) {
      const role = Object.prototype.hasOwnProperty.call(ROLE, w) ? ROLE[w] : null;
      if (role && !roles.includes(role)) roles.push(role);
    }
    return {
      name: str(f('displayName')) || username, login, roles,
      color: str(f('accentColor')) || null, // anything but a hex colour is ignored when drawn
      avatar: veloraUrl(f('avatarUrl')),
      isBot: d.isBot === true || d.isBotMessage === true,
    };
  }

  /** Someone named in a raid or redemption card. */
  function cardUser(p) {
    const username = str(p.username) || str(p.displayName);
    return { name: str(p.displayName) || username || 'Someone', login: username.toLowerCase(), roles: [], avatar: veloraUrl(p.avatarUrl) };
  }

  const IGNORE = new Set(['userJoined', 'userLeft', 'channelRole', 'messagePinned', 'bannedViewerJoined', 'bannedViewerLeft',
    'moderationNotice', 'raidControlResult']);

  function makeHandler(channel, ctx) {
    const reported = new Set();
    const report = (what, data) => {
      if (reported.has(what)) return;
      reported.add(what);
      const sample = JSON.stringify(data);
      hub.diagnostic(`Velora: unhandled ${what} ${sample && sample.length > 300 ? sample.slice(0, 300) + '…' : sample}`);
    };
    let lastCount = 0;

    function message(d) {
      const id = 'velora:' + (str(d.id) || Math.random().toString(36).slice(2));
      if (d.id && hub.isDuplicate(id, 120000)) return; // Velora sometimes sends a message twice
      const ts = Date.parse(str(obj(d).timestamp)) || Date.now();
      const meta = obj(d.metadata);
      const raid = obj(d.raidAnnouncement || meta.raidAnnouncement);
      const card = obj(meta.card);
      const text = str(d.message !== undefined ? d.message : d.content);

      // Alerts only come from messages Velora itself marks as system messages, never from a chatter's message (even
      // one carrying raid or card fields), and they carry no text a chatter typed: just the name, the reward the
      // streamer set up, and numbers.
      if (d.isSystem === true) {
        if (Object.keys(raid).length) {
          const viewers = Math.max(0, Math.floor(num(raid.viewerCount) || 0));
          hub.publish({ id, platform: 'velora', kind: 'raid', ts, user: cardUser(raid),
            title: `is raiding with ${viewers} viewer${viewers === 1 ? '' : 's'}`, value: viewers, unit: 'viewers' });
          return;
        }
        if (card.type === 'points-celebration') {
          const p = obj(card.payload);
          const cost = num(p.cost);
          hub.publish({ id, platform: 'velora', kind: 'redemption', ts, user: cardUser(p),
            title: str(p.itemName) ? `redeemed ${str(p.itemName).slice(0, 60)}` : 'redeemed a reward',
            amount: cost ? `${cost.toLocaleString()} point${cost === 1 ? '' : 's'}` : undefined });
          return;
        }
        if (card.type) report(`card "${str(card.type)}"`, d);
        // Any other notice from Velora: a quiet line.
        hub.publish({ id, platform: 'velora', kind: 'chat', ts, user: buildUser(d, channel), title: 'Notice', silent: true, parts: [{ t: 'text', v: text }] });
        return;
      }

      const r = obj(d.replyTo);
      hub.publish({
        id, platform: 'velora', kind: 'chat', ts, user: buildUser(d, channel), parts: [{ t: 'text', v: text }],
        reply: d.replyTo ? { id: r.messageId ? 'velora:' + str(r.messageId) : null, name: str(r.displayName) || str(r.username), text: str(r.snippet || r.message) } : null,
      });
    }

    return function handle(name, data) {
      const d = obj(data);
      switch (name) {
        case 'newMessage':
          message(d);
          break;
        case 'channelRole': // Velora's reply once this page has joined the channel
          ctx.connected(`velora.tv/${channel}`);
          break;
        case 'viewer_count_update': {
          const count = num(d.count);
          if (count !== undefined && Date.now() - lastCount > 15000) { lastCount = Date.now(); ctx.stats({ viewers: count }); }
          break;
        }
        case 'commandResult':
          if (d.success === false && /not found/i.test(str(d.message))) throw new ConnectorError(`Velora channel '${channel}' not found (check the spelling)`, { config: true });
          if (d.success === false) hub.diagnostic(`Velora: ${str(d.message).slice(0, 200)}`);
          break;
        case 'userBanned': case 'userTimedOut': {
          const who = str(d.username) || str(obj(d.user).username);
          if (who) hub.clearUser('velora', who.toLowerCase()); else report(name, d);
          break;
        }
        case 'chatCleared':
          hub.clearUser('velora', null);
          break;
        case 'messageDeleted': case 'deleteMessage': case 'message_deleted': case 'messagesDeleted': {
          const ids = [].concat(d.messageId, d.id, Array.isArray(d.messageIds) ? d.messageIds : []).map(str).filter(Boolean);
          if (ids.length) hub.deleteMessages('velora', ids.map(x => 'velora:' + x)); else report(name, d);
          break;
        }
        default:
          if (!IGNORE.has(name)) report(`event "${name}"`, d);
      }
    };
  }

  registerConnector({
    id: 'velora',
    label: 'Velora',
    platform: 'velora',
    configKey: s => (s.velora.enabled && s.velora.channel ? `velora|${s.velora.channel}` : null),
    disabledReason: s => (s.velora.enabled ? 'No channel set' : 'Disabled'),

    run(s, ctx, signal) {
      const channel = s.velora.channel;
      const handle = makeHandler(channel, ctx);
      let fail = null;
      return runSocketIo(SOCKET, '/chat', signal, {
        connected(io) {
          fail = io.fail;
          io.emit('joinChannel', { channelId: channel });
        },
        event(name, data) {
          try { handle(name, data); } catch (err) { if (err instanceof ConnectorError && fail) fail(err); else throw err; }
        },
      });
    },
  });

  window.UniChatVelora = { makeHandler }; // exposed for testing
})();
