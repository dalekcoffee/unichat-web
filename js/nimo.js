/* Nimo TV chat, read as a guest straight from this browser, the same way nimo.tv's own page does. Nimo has no public
   chat API: its page talks to Nimo over one WebSocket in Huya's binary "Tars" format, so UniChat does the same. It
   finds the streamer through that socket (Nimo's ordinary web API only answers nimo.tv itself), loads the gift list,
   then subscribes to the room. No account or login, and guests like this don't show in the room.
   Shows chat, paid chat, gifts, follows, subs, bans, the LIVE badge and the viewer count.
   Nimo names aren't unique, so a name with several matches isn't guessed: Settings → Nimo TV → Find lists them and
   saves the room you pick. Message types this doesn't recognise are listed in Settings → Diagnostics.
   The Settings page loads this file too (without the hub) for that search. */
(function () {
  'use strict';
  const H = window.UniChatHub; // absent on the Settings page
  const hub = H ? H.hub : { diagnostic: line => console.debug('UniChat:', line) };
  const ConnectorError = H ? H.ConnectorError : class extends Error {
    constructor(message, opts = {}) { super(message); this.config = !!opts.config; }
  };

  const HOSTS = ['wss://wsapi.nimo.tv/', 'wss://wsapi-global.nimo.tv/']; // the second is Nimo's own backup
  const ROOMS_KEY = 'unichat.web.nimoRooms'; // name → room, for when the name lookup fails
  const LOCALE = { lang: '1033', country: 'US' };

  // Socket commands (WebSocketCommand.iCmdType) and message types (push "uri") used below.
  const CMD = { wupReq: 3, wupRsp: 4, push: 7, registerGroup: 16, registerGroupRsp: 17, heartbeat: 20, pushV2: 22 };
  const URI = {
    chat: 1400, payChat: 1419, ban: 1500, gift: 9, giftText: 9002, follow: 40045, followJson: 40015, sub: 40019,
    liveBegin: 8006, liveBeginNew: 8008, liveEnd: 8007, viewers: 8003,
  };
  // Seen in busy rooms and not worth showing: VIP bar, room entry effects, rankings, banners, gift animations
  // (the gift itself arrives separately), shares, fan-club and lottery effects, rich copies of paid chat.
  const QUIET = new Set([1403, 1404, 1410, 1416, 1427, 1428, 1515, 1516, 1531, 2009, 9001, 20005, 20007, 20008, 20015,
    40017, 40018, 40040, 40049, 1025305]);

  const own = (table, key) => Object.prototype.hasOwnProperty.call(table, key);
  const obj = v => (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array) ? v : {});
  const str = v => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const list = v => (Array.isArray(v) ? v : []);

  // ---------- Tars (JCE) encoding: just enough to write requests and safely read Nimo's answers ----------
  // Each field is a head byte (tag << 4 | type), then the value. Types: 0/1/2/3 int8/16/32/64, 4 float, 5 double,
  // 6 short string, 7 long string, 8 map, 9 list, 10 struct start, 11 struct end, 12 zero, 13 bytes.
  const utf8 = new TextEncoder();
  const fromUtf8 = new TextDecoder();

  class Out {
    constructor() { this.b = []; }
    head(tag, type) { if (tag < 15) this.b.push((tag << 4) | type); else this.b.push(0xf0 | type, tag); }
    int(tag, value) {
      const v = BigInt(value);
      if (v === 0n) return this.head(tag, 12);
      const size = v >= -128n && v < 128n ? 1 : v >= -32768n && v < 32768n ? 2 : v >= -2147483648n && v < 2147483648n ? 4 : 8;
      this.head(tag, { 1: 0, 2: 1, 4: 2, 8: 3 }[size]);
      for (let i = size - 1; i >= 0; i--) this.b.push(Number(BigInt.asUintN(8, v >> BigInt(i * 8))));
    }
    str(tag, s) {
      const u = utf8.encode(s);
      if (u.length < 256) { this.head(tag, 6); this.b.push(u.length); }
      else { this.head(tag, 7); this.b.push(u.length >>> 24, (u.length >>> 16) & 255, (u.length >>> 8) & 255, u.length & 255); }
      for (const x of u) this.b.push(x);
    }
    bytes(tag, u) { this.head(tag, 13); this.head(0, 0); this.int(0, u.length); for (const x of u) this.b.push(x); }
    struct(tag, write) { this.head(tag, 10); write(this); this.head(0, 11); }
    strList(tag, items) { this.head(tag, 9); this.int(0, items.length); items.forEach(s => this.str(0, s)); }
    /** map<string, bytes> */
    map(tag, entries) { this.head(tag, 8); this.int(0, entries.length); for (const [k, v] of entries) { this.str(0, k); this.bytes(1, v); } }
    done() { return Uint8Array.from(this.b); }
  }

  /**
   * Reads a struct's fields into { tag: value }. Structs become objects, lists arrays, maps [key, value] pairs, bytes
   * Uint8Arrays, 64-bit numbers plain numbers (all IDs Nimo uses fit). Anything malformed throws, and the caller drops
   * that frame, so a broken or hostile frame can't do more than go missing.
   */
  function decode(buf) {
    const r = { buf, view: new DataView(buf.buffer, buf.byteOffset, buf.byteLength), pos: 0, items: 0 };
    return fields(r, 0, false);
  }
  const MAX_DEPTH = 16;
  const MAX_ITEMS = 100000;
  function need(r, n) { if (n < 0 || r.pos + n > r.buf.length) throw new RangeError('Truncated message'); }
  function head(r) {
    need(r, 1);
    const h = r.buf[r.pos++];
    let tag = h >> 4;
    if (tag === 15) { need(r, 1); tag = r.buf[r.pos++]; }
    return [tag, h & 15];
  }
  function fields(r, depth, nested) {
    if (depth > MAX_DEPTH) throw new RangeError('Message nested too deeply');
    const out = {};
    while (r.pos < r.buf.length) {
      const [tag, type] = head(r);
      if (type === 11) { if (nested) return out; continue; }
      out[tag] = value(r, type, depth);
    }
    if (nested) throw new RangeError('Unfinished struct');
    return out;
  }
  /** A list/map/bytes length: an int field, which can't be more than the bytes left. */
  function count(r, depth) {
    const [, type] = head(r);
    const n = value(r, type, depth);
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > r.buf.length - r.pos) throw new RangeError('Bad length');
    return n;
  }
  function value(r, type, depth) {
    if (++r.items > MAX_ITEMS) throw new RangeError('Message too big');
    const { view } = r;
    let v;
    switch (type) {
      case 0: need(r, 1); v = view.getInt8(r.pos); r.pos += 1; return v;
      case 1: need(r, 2); v = view.getInt16(r.pos); r.pos += 2; return v;
      case 2: need(r, 4); v = view.getInt32(r.pos); r.pos += 4; return v;
      case 3: need(r, 8); v = Number(view.getBigInt64(r.pos)); r.pos += 8; return v;
      case 4: need(r, 4); v = view.getFloat32(r.pos); r.pos += 4; return v;
      case 5: need(r, 8); v = view.getFloat64(r.pos); r.pos += 8; return v;
      case 6: { need(r, 1); const n = r.buf[r.pos++]; need(r, n); v = fromUtf8.decode(r.buf.subarray(r.pos, r.pos + n)); r.pos += n; return v; }
      case 7: { need(r, 4); const n = view.getInt32(r.pos); r.pos += 4; need(r, n); v = fromUtf8.decode(r.buf.subarray(r.pos, r.pos + n)); r.pos += n; return v; }
      case 8: { const n = count(r, depth); v = []; for (let i = 0; i < n; i++) { v.push([one(r, depth), one(r, depth)]); } return v; }
      case 9: { const n = count(r, depth); v = []; for (let i = 0; i < n; i++) v.push(one(r, depth)); return v; }
      case 10: return fields(r, depth + 1, true);
      case 12: return 0;
      case 13: { head(r); const n = count(r, depth); v = r.buf.subarray(r.pos, r.pos + n); r.pos += n; return v; }
      default: throw new RangeError(`Unknown field type ${type}`);
    }
  }
  function one(r, depth) { const [, type] = head(r); return value(r, type, depth + 1); }
  const decodeBytes = v => (v instanceof Uint8Array ? decode(v) : {});

  /** WUP call packet (Tars RequestPacket v3): the request struct travels as map { "tReq": bytes }, length-prefixed. */
  function wupPacket(servant, func, requestId, writeReq) {
    const req = new Out(); req.struct(0, writeReq);
    const data = new Out(); data.map(0, [['tReq', req.done()]]);
    const p = new Out();
    p.int(1, 3); p.int(2, 0); p.int(3, 0); p.int(4, requestId); p.str(5, servant); p.str(6, func);
    p.bytes(7, data.done()); p.int(8, 0); p.map(9, []); p.map(10, []);
    const body = p.done();
    const out = new Uint8Array(body.length + 4);
    new DataView(out.buffer).setInt32(0, body.length + 4);
    out.set(body, 4);
    return out;
  }
  function command(type, data) { const o = new Out(); o.int(0, type); if (data) o.bytes(1, data); return o.done(); }

  // ---------- The socket ----------
  /**
   * Runs one connection until it closes, then rejects with a ConnectorError so the connector loop reconnects;
   * resolves quietly when `signal` aborts. hooks.open({ call, join }) runs once connected (a thrown error ends the
   * connection); hooks.push(uri, bytes) runs for every room message.
   */
  function runSocket(url, signal, hooks) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      let finished = false;
      let lastData = Date.now();
      let nextId = 1;
      const pending = new Map(); // request id → { resolve, reject, timer }
      const seen = new Set();    // message IDs (a message can arrive through both room groups)
      const beat = setInterval(() => send(command(CMD.heartbeat)), 30000);
      const watchdog = setInterval(() => { if (Date.now() - lastData > 100000) fail(new ConnectorError('No data for too long')); }, 10000);

      function finish(err) {
        if (finished) return;
        finished = true;
        clearInterval(beat);
        clearInterval(watchdog);
        for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err || new ConnectorError('Closed')); }
        pending.clear();
        try { ws.close(); } catch { /* already closed */ }
        if (err) reject(err); else resolve();
      }
      const fail = err => finish(err instanceof ConnectorError ? err : new ConnectorError((err && err.message) || String(err)));
      signal.addEventListener('abort', () => finish(), { once: true });

      function send(bytes) { if (ws.readyState === WebSocket.OPEN) ws.send(bytes); }

      /** One Tars call over the socket; resolves to the answer struct ("tRsp"). */
      function call(servant, func, writeReq) {
        return new Promise((res, rej) => {
          const id = nextId++;
          const timer = setTimeout(() => { pending.delete(id); rej(new ConnectorError(`Nimo didn't answer (${func})`)); }, 15000);
          pending.set(id, { resolve: res, reject: rej, timer });
          send(command(CMD.wupReq, wupPacket(servant, func, id, writeReq)));
        });
      }
      function join(groups) {
        const o = new Out();
        o.strList(0, groups);
        o.str(1, '');
        send(command(CMD.registerGroup, o.done()));
      }

      function answer(data) {
        if (!(data instanceof Uint8Array) || data.length < 5) return;
        const packet = decode(data.subarray(4));
        const p = pending.get(packet[4]);
        if (!p) return;
        pending.delete(packet[4]);
        clearTimeout(p.timer);
        const rsp = list(decodeBytes(packet[7])[0]).find(e => e[0] === 'tRsp');
        if (rsp) p.resolve(obj(decodeBytes(rsp[1])[0]));
        else p.reject(new ConnectorError(`Nimo refused the request (${str(packet[6])})`));
      }

      function deliver(uri, bytes, msgId) {
        if (msgId) {
          if (seen.has(msgId)) return;
          seen.add(msgId);
          if (seen.size > 500) seen.delete(seen.values().next().value);
        }
        try { hooks.push(uri, bytes); } catch (err) { console.warn('UniChat: skipped a Nimo message', err); }
      }

      ws.onopen = () => { Promise.resolve().then(() => hooks.open({ call, join })).catch(fail); };
      ws.onmessage = ev => {
        lastData = Date.now();
        if (!(ev.data instanceof ArrayBuffer) || !ev.data.byteLength) return; // Nimo also sends empty keep-alive frames
        let cmd;
        try { cmd = decode(new Uint8Array(ev.data)); } catch { return; }
        try {
          switch (cmd[0]) {
            case CMD.wupRsp: answer(cmd[1]); break;
            case CMD.push: { const m = decodeBytes(cmd[1]); deliver(num(m[1]), m[2], num(m[5])); break; }
            case CMD.pushV2: for (const item of list(decodeBytes(cmd[1])[1])) deliver(num(obj(item)[0]), obj(item)[1], num(obj(item)[2])); break;
            case CMD.registerGroupRsp: if (num(decodeBytes(cmd[1])[0]) !== 0) fail(new ConnectorError("Nimo wouldn't let this page join the room")); break;
            default: break; // heartbeat answers and the like
          }
        } catch { /* a damaged frame: skip it */ }
      };
      ws.onerror = () => { /* onclose follows with the details */ };
      ws.onclose = ev => fail(new ConnectorError(ev.reason || (ev.code === 1006 ? 'Connection dropped' : `Connection closed (${ev.code})`)));
    });
  }

  // ---------- Finding the room ----------
  const isRoom = v => /^\d{3,12}$/.test(v);
  // Names compare the way Settings stores them (same clean-up), ignoring letter case.
  const fold = s => (window.UniChatStore ? window.UniChatStore.normalizeNimo(str(s)) : str(s).normalize('NFKC').trim()).toLowerCase();
  /** Profile pictures in search results: only from Nimo's own image servers. */
  function nimoImage(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && !u.port && !u.username && /(^|\.)(nimostatic\.tv|nimo\.tv)$/i.test(u.hostname) ? u.href : '';
    } catch { return ''; }
  }

  function rememberRoom(name, room) {
    try {
      const all = JSON.parse(localStorage.getItem(ROOMS_KEY) || '{}');
      const saved = all && typeof all === 'object' && !Array.isArray(all) ? all : {};
      saved[fold(name)] = room;
      const keys = Object.keys(saved);
      if (keys.length > 20) delete saved[keys[0]];
      localStorage.setItem(ROOMS_KEY, JSON.stringify(saved));
    } catch { /* storage blocked: the lookup just runs every time */ }
  }
  function savedRoom(name) {
    try {
      const all = JSON.parse(localStorage.getItem(ROOMS_KEY) || '{}');
      const room = all && own(all, fold(name)) ? all[fold(name)] : null;
      return typeof room === 'object' && room && isRoom(str(room.room)) ? room : null;
    } catch { return null; }
  }

  /**
   * Nimo's own search (the same one its search page uses). Every result says whether it's an exact match: a name
   * matches a streamer's nickname or custom link in any letter case, a room number matches that room. Exact matches
   * come first (most followers first), then the rest in Nimo's order.
   */
  async function search(call, query) {
    const rsp = await call('xyzui', 'searchUser', o => {
      o.str(0, `cl=${LOCALE.lang}&at=2&al=${LOCALE.lang}&cc=${LOCALE.country}&region=${LOCALE.country}`);
      o.str(4, LOCALE.country);
      o.int(7, 0);
      o.struct(8, () => {});
      o.str(9, query);
    });
    if (num(rsp[0]) !== 0) throw new ConnectorError(`Nimo's search failed (${str(rsp[1]) || 'code ' + num(rsp[0])})`);
    const q = fold(query);
    const users = list(obj(rsp[2])[0]).map(obj).map(u => ({
      room: str(u[0]), anchor: num(u[1]) || Number(str(u[1])) || 0, name: str(u[2]), alias: str(u[7]),
      followers: Math.max(0, num(u[5])), live: num(u[6]) > 0 && !num(u[12]), avatar: nimoImage(str(u[4])),
    })).filter(u => isRoom(u.room));
    users.forEach(u => { u.exact = isRoom(query) ? u.room === query : fold(u.name) === q || (!!u.alias && fold(u.alias) === q); });
    return [...users.filter(u => u.exact).sort((a, b) => b.followers - a.followers), ...users.filter(u => !u.exact)];
  }

  const PICK = 'Pick yours in Settings → Nimo TV → Find';

  /**
   * The room to join. A room picked in Settings (nimo.roomId) is used while it still belongs to the name in the
   * channel box; otherwise the name must match exactly one streamer. Several matches, or none, stop with a message
   * pointing to Settings → Nimo TV → Find instead of guessing.
   */
  async function resolveRoom(call, wanted, pinned) {
    if (pinned) {
      const found = (await search(call, pinned)).find(u => u.room === pinned);
      if (found && (wanted === pinned || fold(found.name) === fold(wanted) || (found.alias && fold(found.alias) === fold(wanted)))) return found;
      hub.diagnostic(found
        ? `Nimo: the room picked in Settings (${pinned}) belongs to "${found.name}", not "${wanted}", so UniChat searched for "${wanted}" instead`
        : `Nimo: the room picked in Settings (${pinned}) wasn't found, so UniChat searched for "${wanted}" instead`);
    }
    const exact = (await search(call, wanted)).filter(u => u.exact);
    if (exact.length === 1) return exact[0];
    if (isRoom(wanted)) throw new ConnectorError(`Nimo room ${wanted} not found (check the number)`, { config: true });
    if (exact.length > 1) throw new ConnectorError(`${exact.length} Nimo streamers are called "${wanted}". ${PICK}`, { config: true });
    throw new ConnectorError(`No Nimo streamer called "${wanted}". ${PICK}`, { config: true });
  }

  /**
   * Settings → Nimo TV → Find: Nimo's results for a name or room number (exact matches first). Opens its own short
   * connection and closes it again.
   */
  function findStreamers(query) {
    return new Promise((resolve, reject) => {
      const ac = new AbortController();
      const timer = setTimeout(() => { ac.abort(); reject(new Error("Nimo didn't answer")); }, 20000);
      runSocket(HOSTS[0], ac.signal, {
        async open({ call }) {
          const found = await search(call, query);
          clearTimeout(timer);
          resolve(found);
          ac.abort();
        },
        push() {},
      }).catch(err => { clearTimeout(timer); reject(err); });
    });
  }

  /** Gift ID → { name, diamonds, coins, icon } for this room (Nimo's page loads the same list). */
  async function loadGifts(call, room) {
    const rsp = await call('nimoui', 'getGiftListByRoom', o => {
      o.struct(0, u => { u.int(0, 0); u.str(5, LOCALE.lang); u.str(8, LOCALE.country); });
      o.str(1, LOCALE.lang);
      o.str(2, '500'); // Nimo's code for its website
      o.int(4, 0);
      o.struct(5, a => { a.int(0, room.anchor || 0); a.str(1, LOCALE.lang); a.str(3, LOCALE.country); a.int(4, Number(room.room)); });
    });
    const gifts = new Map();
    for (const g of list(rsp[1]).map(obj)) {
      if (!num(g[0])) continue;
      gifts.set(num(g[0]), { name: str(g[1]), diamonds: Math.max(0, num(g[3])), coins: Math.max(0, num(g[4])), icon: str(obj(g[8])[0]) });
    }
    return gifts;
  }

  // ---------- Messages ----------
  function makeHandler(room, gifts, ctx) {
    const reported = new Set();
    const report = (what, data) => {
      if (reported.has(what) || reported.size > 40) return;
      reported.add(what);
      hub.diagnostic(`Nimo: unhandled ${what} ${preview(data)}`);
    };
    const thisRoom = v => !num(v) || String(num(v)) === room.room;
    const isAnchor = uid => !!room.anchor && num(uid) === room.anchor;
    let lastCount = 0;

    function viewer(uid, name, avatar, extra) {
      const id = num(uid) ? String(num(uid)) : '';
      return Object.assign({ name: str(name) || 'Someone', login: id, roles: isAnchor(uid) ? ['broadcaster'] : [], avatar: str(avatar) }, extra);
    }

    // MessageNotice: 0 sender { 0 uid, 1 name, 3 is streamer, 4 is room manager, 7 royal level, 8 is Nimo staff },
    // 1 room, 2 text, 11 picture, 14 VIP, 17 royal level. (Tars sends yes/no as 0/1.) Nimo's name colours are left
    // out: most viewers share one default colour, and UniChat's own per-viewer colours are easier to tell apart.
    function chat(m) {
      if (!thisRoom(m[1])) return;
      const s = obj(m[0]);
      const roles = [];
      if (num(s[3]) || isAnchor(s[0])) roles.push('broadcaster');
      if (num(s[4])) roles.push('moderator');
      if (num(s[8])) roles.push('staff');
      if (num(m[14]) || num(s[7]) || num(m[17])) roles.push('vip');
      const text = str(m[2]);
      if (!text.trim()) return;
      hub.publish({
        platform: 'nimo', kind: 'chat',
        user: { name: str(s[1]) || 'Someone', login: num(s[0]) ? String(num(s[0])) : '', roles, avatar: str(m[11]) },
        parts: [{ t: 'text', v: text }],
      });
    }

    // PayChatNotice: 0 streamer, 1 uid, 2 name, 3 picture, 4 text, 5 option { 1 price }.
    function payChat(m) {
      if (room.anchor && num(m[0]) && num(m[0]) !== room.anchor) return;
      report('paid chat (first one, to check the price)', m);
      const price = Math.max(0, num(obj(m[5])[1]));
      hub.publish({
        platform: 'nimo', kind: 'donation', user: viewer(m[1], m[2], m[3]), title: 'sent a paid message',
        amount: price ? `${price.toLocaleString()} diamonds` : undefined, value: price || undefined, unit: 'diamonds',
        parts: str(m[4]) ? [{ t: 'text', v: str(m[4]) }] : [],
      });
    }

    // SendItemSubBroadcastPacket: 0 gift, 1 count, 3 sender uid, 5 sender name, 6 room, 9 combo, 12 picture, 20 order ID.
    // Diamonds are bought with money; coins are earned by watching.
    function gift(m) {
      if (!thisRoom(m[6])) return;
      const id = num(m[0]);
      const count = Math.max(1, Math.floor(num(m[1])) || 1);
      const key = str(m[20]) || [num(m[3]), id, count, num(m[9])].join(':');
      if (hub.isDuplicate(`nimo-gift:${key}`, str(m[20]) ? 120000 : 5000)) return; // announced on two channels
      const info = gifts.get(id);
      const name = (info && info.name) || `gift #${id}`;
      const user = viewer(m[3], m[5], m[12]);
      const title = count > 1 ? `sent ${name} x${count}` : `sent ${name}`;
      const parts = info && info.icon ? [{ t: 'emote', v: name, url: info.icon }] : [];
      if (info && info.diamonds > 0) {
        const total = info.diamonds * count;
        hub.publish({ platform: 'nimo', kind: 'donation', user, title, amount: `${total.toLocaleString()} diamond${total === 1 ? '' : 's'}`, value: total, unit: 'diamonds', parts });
      } else {
        // Coin gifts cost nothing real: a quiet line in chat instead of an alert.
        if (!info) report(`gift ${id}`, m);
        hub.publish({ platform: 'nimo', kind: 'chat', user, title, silent: true, parts });
      }
    }

    function follow(uid, name, avatar) {
      if (hub.isDuplicate(`nimo-follow:${num(uid) || fold(name)}`, 600000)) return;
      hub.publish({ platform: 'nimo', kind: 'follow', user: viewer(uid, name, avatar), title: 'followed' });
    }

    /** Follows (sometimes) and subs arrive as JSON inside the Tars message; its field names aren't documented. */
    function json(uri, m) {
      let d;
      try { d = JSON.parse(str(m[1]).slice(0, 20000)); } catch { d = null; }
      d = obj(d);
      const inner = obj(d.data || d.body || d.msg);
      const pick = (...keys) => { for (const k of keys) for (const o of [d, inner]) if (own(o, k) && (typeof o[k] === 'string' || typeof o[k] === 'number') && o[k] !== '') return o[k]; return undefined; };
      const name = str(pick('nickName', 'nickname', 'userNick', 'userName', 'fansName', 'fanNick', 'senderNick', 'sNickName', 'name'));
      const uid = pick('uid', 'userId', 'udbUserId', 'fansId', 'fanId', 'senderUid', 'lUid');
      const avatar = str(pick('avatarUrl', 'avatar', 'fansAvatarUrl', 'headImg', 'sAvatarUrl'));
      report(`${uri === URI.sub ? 'sub' : 'follow'} notice "${str(m[0])}"`, d); // once, so the real field names can be checked
      if (!name) return;
      if (uri === URI.sub) {
        const months = Math.floor(Number(pick('months', 'month', 'subMonth', 'totalMonth', 'subscribeMonth', 'count')) || 0);
        if (hub.isDuplicate(`nimo-sub:${uid || name}:${months}`, 15000)) return;
        hub.publish({ platform: 'nimo', kind: 'sub', user: viewer(uid, name, avatar), title: months > 1 ? `subscribed for ${months} months` : 'subscribed' });
      } else follow(uid, name, avatar);
    }

    return function push(uri, bytes) {
      if (QUIET.has(uri)) return;
      const m = decodeBytes(bytes);
      switch (uri) {
        case URI.chat: chat(m); break;
        case URI.payChat: payChat(m); break;
        case URI.gift: case URI.giftText: gift(m); break;
        // TransDownUserFollow: 0 uid, 1 name, 2 picture, 8 streamer. ForbidUserMessageNotice: 0 uid, 1 room.
        case URI.follow: if (!room.anchor || !num(m[8]) || num(m[8]) === room.anchor) follow(m[0], m[1], m[2]); break;
        case URI.followJson: case URI.sub: json(uri, m); break;
        case URI.ban: if (thisRoom(m[1]) && num(m[0])) hub.clearUser('nimo', String(num(m[0]))); break;
        case URI.liveBegin: case URI.liveBeginNew: ctx.setLive(true); break;
        case URI.liveEnd: ctx.setLive(false); break;
        case URI.viewers:
          if (thisRoom(m[0]) && Date.now() - lastCount > 15000) {
            lastCount = Date.now();
            ctx.stats({ viewers: Math.max(0, num(m[1])) });
          }
          break;
        default: report(`message type ${uri}`, m);
      }
    };
  }

  /** A short, readable sample of a decoded message for Diagnostics. */
  function preview(v, depth = 0) {
    const text = (function show(x, d) {
      if (x instanceof Uint8Array) return `<${x.length} bytes>`;
      if (Array.isArray(x)) return d > 3 ? '[…]' : '[' + x.slice(0, 5).map(y => show(y, d + 1)).join(', ') + (x.length > 5 ? ', …' : '') + ']';
      if (x && typeof x === 'object') return d > 3 ? '{…}' : '{' + Object.entries(x).slice(0, 12).map(([k, y]) => `${k}:${show(y, d + 1)}`).join(', ') + '}';
      return typeof x === 'string' ? JSON.stringify(x.length > 40 ? x.slice(0, 40) + '…' : x) : String(x);
    })(v, depth);
    return text.length > 400 ? text.slice(0, 400) + '…' : text;
  }

  // ---------- Connector ----------
  let host = 0; // switches to Nimo's backup server after a failed connection

  if (H) H.registerConnector({
    id: 'nimo',
    label: 'Nimo TV',
    platform: 'nimo',
    configKey: s => (s.nimo.enabled && s.nimo.channel ? `nimo|${s.nimo.channel}|${s.nimo.roomId}` : null),
    disabledReason: s => (s.nimo.enabled ? 'No streamer set' : 'Disabled'),

    async run(s, ctx, signal) {
      const wanted = s.nimo.channel;
      const pinned = s.nimo.roomId ? String(s.nimo.roomId) : '';
      let handle = null;
      let liveTimer = null;
      try {
        await runSocket(HOSTS[host % HOSTS.length], signal, {
          async open({ call, join }) {
            let room;
            try {
              room = await resolveRoom(call, wanted, pinned);
              if (!isRoom(wanted)) rememberRoom(wanted, { room: room.room, anchor: room.anchor, name: room.name });
            } catch (err) {
              // Nimo's search is down: carry on with the picked room, or the one this name found last time.
              const saved = !err.config && (pinned ? { room: pinned } : !isRoom(wanted) && savedRoom(wanted));
              if (!saved) throw err;
              hub.diagnostic(`Nimo: search failed (${err.message}); using room ${saved.room}`);
              room = { room: str(saved.room), anchor: num(saved.anchor), name: str(saved.name) || wanted, live: null };
            }
            room.label = room.alias ? `nimo.tv/${room.alias}` : `nimo.tv/live/${room.room}`;
            let gifts = new Map();
            try { gifts = await loadGifts(call, room); }
            catch (err) { hub.diagnostic(`Nimo: couldn't load the gift list (${err.message}); gifts show by number`); }
            handle = makeHandler(room, gifts, ctx);
            join([`nimo:1_${room.room}`, `nimo:13_${room.room}_web`]);
            if (typeof room.live === 'boolean') ctx.setLive(room.live);
            ctx.connected(room.label);
            // The room's live notices can be missed (e.g. going live while this page reconnects), so Nimo's search is
            // asked again every 2 minutes.
            liveTimer = setInterval(() => {
              search(call, room.room)
                .then(found => { const me = found.find(u => u.room === room.room); if (me && !signal.aborted) ctx.setLive(me.live); })
                .catch(() => { /* try again next time */ });
            }, 120000);
          },
          push(uri, bytes) { if (handle) handle(uri, bytes); },
        });
      } catch (err) {
        if (!err.config) host++;
        throw err;
      } finally {
        clearInterval(liveTimer);
      }
    },
  });

  window.UniChatNimo = { findStreamers, Out, decode, makeHandler, preview }; // findStreamers: Settings; the rest: testing
})();
