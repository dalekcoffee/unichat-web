/* 7TV, BetterTTV and FrankerFaceZ emotes, in chat from every platform (not only Twitch).
   Loads each service's global emotes plus the emotes set up for your Twitch channel (found by its Twitch ID via IVR),
   then turns matching words into pictures as messages arrive. Public APIs, no login or key. Picture addresses are
   built here from each emote's ID (never taken from the answers), so they can only point at the services' own image
   servers. Settings → Display turns this off. */
(function () {
  'use strict';
  const H = window.UniChatHub;
  if (!H) return;
  const { hub } = H;

  const REFRESH_MS = 3600000;          // new emotes added mid-stream show up within the hour
  const MAX_EMOTES = 6000;
  const ID = /^[A-Za-z0-9]{1,40}$/;
  const NAME = /^[^\s<>"'`&\\]{1,60}$/u;
  const CDN = {
    seventv: id => `https://cdn.7tv.app/emote/${id}/1x.webp`,
    bttv: id => `https://cdn.betterttv.net/emote/${id}/1x.webp`,
    ffz: id => `https://cdn.betterttv.net/frankerfacez_emote/${id}/1`, // FrankerFaceZ through BetterTTV's copy of it
  };

  let table = new Map();               // word → { url, zw } (zw: a 7TV "zero-width" emote drawn over the one before it)
  let activeKey = null;
  let timer = null;
  let loadId = 0;
  const reported = new Set();

  async function getJson(url, signal) {
    const res = await fetch(url, { credentials: 'omit', signal });
    if (res.status === 404) return null; // e.g. no 7TV account for this channel
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  const list = v => (Array.isArray(v) ? v : []);
  const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

  // Each reader returns [[word, { url, zw }], …] from one service's answer.
  const read = {
    seventv: set => list(obj(set).emotes).map(e => {
      const id = String(obj(e).id || ''), name = String(obj(e).name || '');
      return ID.test(id) && NAME.test(name) ? [name, { url: CDN.seventv(id), zw: (Number(e.flags) & 1) === 1 }] : null;
    }),
    bttv: arr => list(arr).map(e => {
      const id = String(obj(e).id || ''), code = String(obj(e).code || '');
      return ID.test(id) && NAME.test(code) && e.modifier !== true ? [code, { url: CDN.bttv(id), zw: false }] : null;
    }),
    ffz: arr => list(arr).map(e => {
      const id = String(obj(e).id || ''), code = String(obj(e).code || '');
      return /^\d{1,12}$/.test(id) && NAME.test(code) && e.modifier !== true ? [code, { url: CDN.ffz(id), zw: false }] : null;
    }),
  };

  async function twitchId(login, signal) {
    const users = await getJson('https://api.ivr.fi/v2/twitch/user?login=' + encodeURIComponent(login), signal);
    const u = list(users).find(x => x && typeof x.login === 'string' && x.login.toLowerCase() === login);
    return u && /^\d{1,20}$/.test(String(u.id)) ? String(u.id) : null;
  }

  /** Loads everything; a service that fails is skipped (noted once in Settings → Diagnostics). */
  async function load(channel) {
    const mine = ++loadId;
    const ac = new AbortController();
    const giveUp = setTimeout(() => ac.abort(), 20000);
    const attempt = async (what, fn) => {
      try { return await fn(); } catch (err) {
        if (!reported.has(what)) { reported.add(what); hub.diagnostic(`Emotes: couldn't load ${what} (${err.name === 'AbortError' ? 'timed out' : err.message})`); }
        return null;
      }
    };
    const id = channel ? await attempt('your Twitch channel ID', () => twitchId(channel, ac.signal)) : null;
    // Lowest priority first: later sets win a shared name (channel over global; 7TV over BTTV over FFZ).
    const sources = [
      ['FrankerFaceZ global emotes', () => getJson('https://api.betterttv.net/3/cached/frankerfacez/emotes/global', ac.signal), read.ffz],
      ['BetterTTV global emotes', () => getJson('https://api.betterttv.net/3/cached/emotes/global', ac.signal), read.bttv],
      ['7TV global emotes', () => getJson('https://7tv.io/v3/emote-sets/global', ac.signal), read.seventv],
    ];
    if (id) {
      sources.push(
        ['FrankerFaceZ channel emotes', () => getJson(`https://api.betterttv.net/3/cached/frankerfacez/users/twitch/${id}`, ac.signal), read.ffz],
        ['BetterTTV channel emotes', async () => { const j = obj(await getJson(`https://api.betterttv.net/3/cached/users/twitch/${id}`, ac.signal)); return list(j.channelEmotes).concat(list(j.sharedEmotes)); }, read.bttv],
        ['7TV channel emotes', async () => obj(await getJson(`https://7tv.io/v3/users/twitch/${id}`, ac.signal)).emote_set, read.seventv],
      );
    }
    const answers = await Promise.all(sources.map(([what, fetcher]) => attempt(what, fetcher)));
    clearTimeout(giveUp);
    if (mine !== loadId) return; // settings changed meanwhile
    const next = new Map();
    answers.forEach((answer, i) => {
      for (const pair of sources[i][2](answer)) if (pair && (next.has(pair[0]) || next.size < MAX_EMOTES)) next.set(pair[0], pair[1]);
    });
    if (next.size || !table.size) table = next; // a total failure keeps the emotes already loaded
  }

  /** Text parts → text and emote parts. Only whole words match, with exact capitals. */
  function match(parts) {
    if (!table.size) return parts;
    const out = [];
    for (const p of parts) {
      if (p.t !== 'text' || !p.v) { out.push(p); continue; }
      let buf = '';
      for (const word of p.v.split(/(\s+)/)) {
        const e = word && table.get(word);
        if (!e) { buf += word; continue; }
        if (buf) { out.push({ t: 'text', v: buf }); buf = ''; }
        out.push(e.zw ? { t: 'emote', v: word, url: e.url, typed: true, zw: true } : { t: 'emote', v: word, url: e.url, typed: true });
      }
      if (buf) out.push({ t: 'text', v: buf });
    }
    return out;
  }

  function apply(s) {
    const on = !(s.display && s.display.thirdPartyEmotes === false);
    // Your channel's emotes come from the Twitch channel in Settings; only the global emotes when Twitch is off.
    const channel = on && s.twitch && s.twitch.enabled && s.twitch.channel ? s.twitch.channel : '';
    const key = on ? `on|${channel}` : 'off';
    if (key === activeKey) return;
    activeKey = key;
    clearInterval(timer);
    loadId++;
    table = new Map();
    H.setEmoteMatcher(on ? match : null);
    if (!on) return;
    load(channel);
    timer = setInterval(() => load(channel), REFRESH_MS);
  }

  H.onSettingsChange(apply);
  apply(hub.settings);

  window.UniChatEmotes = { match, size: () => table.size }; // exposed for testing
})();
