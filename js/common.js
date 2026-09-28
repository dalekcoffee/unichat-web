/* UniChat Web shared code: rendering, filters, sounds and text-to-speech. The live feed comes from hub.js (all in this browser). */
(function () {
  'use strict';

  // ---------- Platform metadata & icons ----------
  const ICONS = {
    twitch: '<svg viewBox="0 0 24 24"><path fill="#9146ff" d="M4.3 2 3 5.4v14h4.7V22h2.6l2.6-2.6h3.9L22 14.2V2H4.3Zm15.9 11.3-3 3h-4.7l-2.6 2.6v-2.6H5.9V3.8h14.3v9.5ZM17.2 7.2h-1.8v5.2h1.8V7.2Zm-4.8 0h-1.8v5.2h1.8V7.2Z"/></svg>',
    tiktok: '<svg viewBox="0 0 24 24"><path transform="translate(-.9 -.7)" fill="#25f4ee" d="M16 3c.5 2.2 2 3.7 4 4v3c-1.5 0-2.9-.4-4-1.1V15a6 6 0 1 1-6-6v3.2a2.8 2.8 0 1 0 2.8 2.8V3H16z"/><path transform="translate(.9 .7)" fill="#fe2c55" d="M16 3c.5 2.2 2 3.7 4 4v3c-1.5 0-2.9-.4-4-1.1V15a6 6 0 1 1-6-6v3.2a2.8 2.8 0 1 0 2.8 2.8V3H16z"/><path style="fill:var(--tt-fg,#fff)" d="M16 3c.5 2.2 2 3.7 4 4v3c-1.5 0-2.9-.4-4-1.1V15a6 6 0 1 1-6-6v3.2a2.8 2.8 0 1 0 2.8 2.8V3H16z"/></svg>',
    kick: '<svg viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#53fc18"/><path fill="#0b0b0b" d="M6 5h4v4.5h1.5V8H13V6.5h1.5V5h4v4.5H17V11h-1.5v2H17v1.5h1.5V19h-4v-1.5H13V16h-1.5v-1.5H10V19H6z"/></svg>',
    youtube: '<svg viewBox="0 0 24 24"><path fill="#ff0033" d="M23 7.2a3 3 0 0 0-2.1-2.1C19 4.6 12 4.6 12 4.6s-7 0-8.9.5A3 3 0 0 0 1 7.2 31 31 0 0 0 .5 12 31 31 0 0 0 1 16.8a3 3 0 0 0 2.1 2.1c1.9.5 8.9.5 8.9.5s7 0 8.9-.5a3 3 0 0 0 2.1-2.1 31 31 0 0 0 .5-4.8 31 31 0 0 0-.5-4.8Z"/><path fill="#fff" d="m9.7 15.1 5.8-3.1-5.8-3.1v6.2Z"/></svg>',
    velora: '<svg viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#ffd700"/><path fill="#14110a" d="M5.2 6h3.3l3.5 8.4L15.5 6h3.3l-5.3 12h-3z"/></svg>',
    blaze: '<svg viewBox="0 0 24 24"><path fill="#ff7a00" d="M12.6 1.5c.6 3.3-.9 5.1-2.5 6.9C8.5 10.1 7 11.9 7 14.6a5 5 0 0 0 10 .2c0-2.4-1.1-4.1-2.3-5.5.1 1.7-.5 3-1.6 3.6.6-3.9-.5-8.1-.5-11.4Z"/><path fill="#ffd21f" d="M12 21.5a3.2 3.2 0 0 1-3.2-3.3c0-1.7 1-2.8 2-3.9.2 1.1.8 1.8 1.6 2 .1-1.4.5-2.4 1.3-3.5.6 1.4 1.5 2.6 1.5 4.6a3.2 3.2 0 0 1-3.2 4.1Z"/></svg>',
    nimo: '<svg viewBox="0 0 24 24"><path fill="#ffc83d" d="M11.8 6.6 15 1.9c.3-.4.9-.2.9.3l.2 4.4z"/><rect x="2" y="6" width="20" height="16" rx="5" fill="#6c5cff"/><circle cx="8.4" cy="13.8" r="1.9" fill="#fff"/><path fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" d="m16.7 11.5-2.9 2.3 2.9 2.3"/></svg>',
    system: '<svg viewBox="0 0 24 24"><path fill="#8b8fa3" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-6h2v6Zm0-8h-2V7h2v2Z"/></svg>',
  };
  const NAMES = { twitch: 'Twitch', tiktok: 'TikTok', kick: 'Kick', velora: 'Velora', blaze: 'Blaze', nimo: 'Nimo TV', youtube: 'YouTube', system: 'UniChat' };
  const PLATFORMS = ['twitch', 'tiktok', 'kick', 'velora', 'blaze', 'nimo', 'youtube'];

  const BADGES = {
    broadcaster: ['Streamer', '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h6A1.5 1.5 0 0 1 11 4.5v1.3l3-2V12l-3-2v1.5A1.5 1.5 0 0 1 9.5 13h-6A1.5 1.5 0 0 1 2 11.5z"/>'],
    moderator: ['Moderator', '<path d="M8 1 2.5 3v4.5c0 3.4 2.3 6.3 5.5 7.5 3.2-1.2 5.5-4.1 5.5-7.5V3z"/>'],
    vip: ['VIP', '<path d="M8 2 14 7l-6 7-6-7z"/>'],
    subscriber: ['Subscriber', '<path d="m8 1.5 2 4.2 4.5.6-3.3 3.1.8 4.5L8 11.7l-4 2.2.8-4.5L1.5 6.3 6 5.7z"/>'],
    member: ['Member', '<path d="m8 1.5 2 4.2 4.5.6-3.3 3.1.8 4.5L8 11.7l-4 2.2.8-4.5L1.5 6.3 6 5.7z"/>'],
    founder: ['Founder', '<path d="M2 5l3 2.5L8 3l3 4.5L14 5l-1.2 7H3.2z"/>'],
    verified: ['Verified', '<path d="M6.5 11.2 3.3 8l1.1-1.1 2.1 2.1 5.1-5.1 1.1 1.1z"/>'],
    staff: ['Staff', '<path d="M8 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm-5 11c0-2.2 2.2-4 5-4s5 1.8 5 4z"/>'],
  };

  const KIND_LABEL = { follow: 'Follow', donation: 'Donation', sub: 'Subscription', raid: 'Raid', redemption: 'Channel points', hype: 'Hype Train' };
  const KIND_EMOJI = { follow: '💙', donation: '💰', sub: '⭐', raid: '🚀', redemption: '🎁', hype: '🚂' };
  const ALERT_KINDS = Object.keys(KIND_LABEL);

  // Lookups keyed by outside data only match the table's own entries (never built-ins like "constructor").
  const own = (table, key) => Object.prototype.hasOwnProperty.call(table, key);
  function icon(platform) { return own(ICONS, platform) ? ICONS[platform] : ICONS.system; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Colours ----------
  const NAME_COLORS = ['#ff7f50', '#1e90ff', '#9acd32', '#ff69b4', '#daa520', '#00ced1', '#b28dff', '#ff6961', '#77dd77', '#f49ac2', '#84b6f4', '#fdfd96'];
  function hashColor(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return NAME_COLORS[Math.abs(h) % NAME_COLORS.length];
  }
  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  /** Keep user colours readable on the current theme. */
  function readable(hex, theme) {
    const rgb = hexToRgb(hex);
    if (!rgb) return hex;
    const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    let [r, g, b] = rgb;
    if (theme === 'light' && lum > 0.6) { const f = 0.6 / lum; r *= f; g *= f; b *= f; }
    if (theme !== 'light' && lum < 0.35) { const t = 0.45; r += (255 - r) * t; g += (255 - g) * t; b += (255 - b) * t; }
    return `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
  }

  // ---------- Filters & highlights (shared settings, applied in the browser) ----------
  function plainText(e) {
    return (e.parts || []).filter(p => p.t !== 'emote').map(p => p.v).join('');
  }
  /** What the chatter typed, including 7TV/BTTV/FFZ emote names (so filters and highlights still see those words). */
  function typedText(e) {
    return (e.parts || []).filter(p => p.t !== 'emote' || p.typed).map(p => p.v).join('');
  }

  function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // Compiled once per settings object.
  const compiled = new WeakMap();
  function rulesFor(s) {
    let r = compiled.get(s);
    if (r) return r;
    const f = s.filters || {};
    const h = s.highlights || {};
    const lower = list => new Set((list || []).map(x => String(x).toLowerCase().replace(/^@/, '')));
    const wordsRegex = list => {
      const words = (list || []).map(w => String(w).trim()).filter(Boolean);
      return words.length ? new RegExp('(^|[^\\p{L}\\p{N}_])(' + words.map(escapeRegex).join('|') + ')(?=$|[^\\p{L}\\p{N}_])', 'iu') : null;
    };
    const myNames = [];
    if (h.mentions) {
      if (s.twitch && s.twitch.channel) myNames.push(s.twitch.channel);
      if (s.kick && s.kick.channel) myNames.push(s.kick.channel.replace(/^.*kick\.com\//i, '').replace(/[/?#].*$/, ''));
      if (s.tikTok && s.tikTok.username) myNames.push(s.tikTok.username);
      if (s.velora && s.velora.channel) myNames.push(s.velora.channel);
      if (s.blaze && s.blaze.channel) myNames.push(s.blaze.channel);
      if (s.nimo && s.nimo.channel && !/^\d+$/.test(s.nimo.channel)) myNames.push(s.nimo.channel); // not a room number
    }
    r = {
      hideBots: !!f.hideBots,
      bots: f.hideBots ? lower(f.botNames) : new Set(),
      blockedUsers: lower(f.blockedUsers),
      blockedWords: wordsRegex(f.blockedWords),
      hideCommands: !!f.hideCommands,
      highlight: !!h.enabled,
      firstTimers: !!h.firstTimeChatters,
      keywords: wordsRegex(myNames.concat(h.keywords || [])),
    };
    compiled.set(s, r);
    return r;
  }

  /**
   * { hidden, highlight: 'first' | 'mention' | null, maskText, maskReply } for an event under the current settings.
   * Alerts are never hidden (they're real support), but a hidden user's message, or one with a blocked word, is left
   * out (maskText) so it isn't shown, popped up or read aloud. A quoted reply to such a message is left out too (maskReply).
   */
  function classify(e, s) {
    const out = { hidden: false, highlight: null, maskText: false, maskReply: false };
    if (!s || e.kind === 'system') return out;
    const r = rulesFor(s);
    const u = e.user || {};
    const norm = x => String(x).toLowerCase().replace(/^@/, '');
    const ids = [u.login, u.name].filter(Boolean).map(norm);
    const text = typedText(e);
    const blockedText = t => !!(r.blockedWords && r.blockedWords.test(t));
    if (e.reply && ((e.reply.name && r.blockedUsers.has(norm(e.reply.name))) || blockedText(String(e.reply.text || '')))) out.maskReply = true;
    if (e.kind !== 'chat') {
      out.maskText = ids.some(id => r.blockedUsers.has(id)) || blockedText(text);
      return out;
    }
    if (ids.some(id => r.bots.has(id) || r.blockedUsers.has(id)) || (r.hideBots && u.isBot === true)) out.hidden = true; // isBot: platforms that label bots
    else if (r.hideCommands && /^\s*!\S/.test(text)) out.hidden = true;
    else if (blockedText(text)) out.hidden = true;
    if (out.hidden || !r.highlight || (u.roles || []).includes('broadcaster')) return out;
    if (r.firstTimers && e.firstTime) out.highlight = 'first';
    else if (r.keywords && r.keywords.test(text)) out.highlight = 'mention';
    return out;
  }

  // ---------- Rendering ----------
  /** "$" + 5 → "$5.00"; "USD" + 5 → "5.00 USD". */
  function fmtMoney(unit, v) {
    const n = Number(v || 0).toFixed(2);
    return /^[A-Za-z]{2,4}$/.test(unit || '') ? `${n} ${unit}` : `${unit || ''}${n}`;
  }

  function fmtTime(ts) {
    const d = new Date(ts || Date.now());
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /** Only http(s) URLs may become image sources. */
  function safeUrl(u) {
    return typeof u === 'string' && /^https?:\/\//i.test(u) ? u : '';
  }

  /** Only real CSS hex colours are used in styles (platform data is never trusted as markup). */
  function safeColor(c) {
    return typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : null;
  }

  /** Message parts as HTML. A 7TV "zero-width" emote is drawn on top of the emote before it (e.g. rain over a face). */
  function partsHtml(parts) {
    const out = [];
    let stack = null; // the last emote, while only spaces follow it: { at, imgs }
    for (const p of parts || []) {
      if (p.t === 'gif' && safeUrl(p.url)) {
        // A Twitch (GIPHY) GIF on its own line; its caption (without the brackets) is the picture's description.
        const caption = String(p.v == null ? '' : p.v);
        const alt = caption.replace(/^\[([\s\S]*)\]$/, '$1');
        out.push(`<img class="chat-gif" src="${esc(p.url)}" alt="${esc(alt)}" title="${esc(alt)}" data-caption="${esc(caption)}" loading="lazy" referrerpolicy="no-referrer">`);
        stack = null;
        continue;
      }
      const url = p.t === 'emote' ? safeUrl(p.url) : '';
      if (!url) {
        out.push(esc(p.v));
        if (String(p.v == null ? '' : p.v).trim()) stack = null;
        continue;
      }
      const img = `<img class="emote" src="${esc(url)}" alt="${esc(p.v)}" title="${esc(p.v)}" loading="lazy" referrerpolicy="no-referrer">`;
      if (p.zw && stack) {
        out.length = stack.at + 1; // drop the spaces between them
        stack.imgs.push(img);
        out[stack.at] = `<span class="emote-stack">${stack.imgs.join('')}</span>`;
        continue;
      }
      stack = { at: out.length, imgs: [img] };
      out.push(img);
    }
    return out.join('');
  }

  /** 1234 → "1,234"; 12345 → "12.3K"; 1234567 → "1.2M". */
  function fmtCount(n) {
    n = Number(n) || 0;
    if (n < 10000) return n.toLocaleString();
    if (n < 1e6) return `${(n / 1000).toFixed(n < 100000 ? 1 : 0)}K`;
    return `${(n / 1e6).toFixed(1)}M`;
  }

  /** 83 minutes → "1h 23m". */
  function fmtDuration(ms) {
    const mins = Math.max(0, Math.floor(ms / 60000));
    return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
  }

  function badgesHtml(roles) {
    if (!roles || !roles.length) return '';
    return '<span class="badges">' + roles.filter(r => own(BADGES, r)).map(r =>
      `<span class="badge ${r}" title="${BADGES[r][0]}"><svg viewBox="0 0 16 16">${BADGES[r][1]}</svg></span>`).join('') + '</span>';
  }

  function userColor(user, theme) {
    return readable(safeColor(user.color) || hashColor(user.name || user.login || '?'), theme);
  }

  /** Profile picture, or a coloured initial when there's none (yet) or the picture won't load. */
  function avatarHtml(user, platform, theme) {
    const key = esc(`${platform}:${String(user.login || '').toLowerCase()}`);
    const letter = esc((String(user.name || user.login || '?').replace(/^@/, '').match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase());
    const bg = esc(userColor(user, 'dark'));
    const url = safeUrl(user.avatar);
    if (url) return `<img class="avatar" data-avatar-for="${key}" data-initial="${letter}" data-bg="${bg}" src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
    return `<span class="avatar initial" data-avatar-for="${key}" style="background:${bg}">${letter}</span>`;
  }

  /** Swap a viewer's coloured initials for their picture once it has been looked up (Twitch chat doesn't include it). */
  function swapAvatar(platform, login, url) {
    const safe = safeUrl(url);
    if (!safe) return;
    const key = `${platform}:${String(login || '').toLowerCase()}`;
    document.querySelectorAll(`.avatar.initial[data-avatar-for="${CSS.escape(key)}"]`).forEach(el => {
      const img = document.createElement('img');
      img.className = 'avatar';
      img.dataset.avatarFor = key;
      img.dataset.initial = el.textContent;
      img.dataset.bg = el.style.background;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.src = safe;
      el.replaceWith(img);
    });
  }

  // A picture that won't load (deleted, expired or blocked) turns back into the coloured initial, and a GIF into its caption.
  document.addEventListener('error', e => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    if (img.classList.contains('chat-gif')) { img.replaceWith(document.createTextNode(img.dataset.caption || img.alt || '')); return; }
    if (!img.classList.contains('avatar')) return;
    const span = document.createElement('span');
    span.className = 'avatar initial';
    span.dataset.avatarFor = img.dataset.avatarFor || '';
    span.style.background = img.dataset.bg || '#6c6c82';
    span.textContent = img.dataset.initial || '?';
    img.replaceWith(span);
  }, true);

  function nameHtml(user, theme, platform) {
    if (!user) return '';
    const login = esc(String(user.login || '').toLowerCase());
    const clickable = platform && user.login ? ` data-viewer="1" data-platform="${esc(platform)}" data-login="${login}" title="Show viewer card"` : '';
    return `${platform ? avatarHtml(user, platform, theme) : ''}${badgesHtml(user.roles)}<span class="name" style="color:${userColor(user, theme)}"${clickable}>${esc(user.name || user.login || 'Someone')}</span>`;
  }

  /** The parts of an event to show: only the emotes/gift pictures when filters leave its text out. */
  function shownParts(e, cls) {
    return cls && cls.maskText ? (e.parts || []).filter(p => p.t === 'emote' && !p.typed) : e.parts;
  }

  function replyHtml(reply, masked) {
    if (!reply || !reply.name) return '';
    if (masked) return '<div class="reply">↩ Replying to a hidden message</div>';
    const text = String(reply.text || '');
    const short = text.length > 110 ? text.slice(0, 110) + '…' : text;
    return `<div class="reply"${reply.id ? ` data-reply-to="${esc(reply.id)}"` : ''} title="Replying to this message">↩ <b>@${esc(reply.name)}</b> ${esc(short)}</div>`;
  }

  const PIN_BTN = '<button class="pin-btn" type="button" title="Pin this message" aria-label="Pin this message">📌</button>';
  const X_BTN = '<button class="x-btn" type="button" title="Dismiss this line" aria-label="Dismiss this line"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4l5.6 5.6L5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6z"/></svg></button>';
  /** Hover buttons on a chat line: pin (not on connection lines) and dismiss. */
  const lineActions = pin => `<span class="msg-actions">${pin ? PIN_BTN : ''}${X_BTN}</span>`;

  function renderEvent(e, theme, cls) {
    const el = document.createElement('div');
    el.dataset.id = e.id;
    el.dataset.platform = e.platform;
    if (e.user && e.user.login) el.dataset.user = String(e.user.login).toLowerCase();
    const pf = `<span class="pf" title="${own(NAMES, e.platform) ? NAMES[e.platform] : ''}">${icon(e.platform)}</span>`;
    const ts = `<span class="ts">${fmtTime(e.ts)}</span>`;

    if (e.kind === 'system') {
      el.className = `msg sys lvl-${e.level || 'info'} p-${e.platform}`;
      el.innerHTML = `${ts}${pf}<span class="text">${partsHtml(e.parts)}</span>${lineActions(false)}`;
      return el;
    }

    if (own(KIND_LABEL, e.kind)) {
      el.className = `msg alert k-${e.kind} p-${e.platform}`;
      const accent = safeColor(e.accent);
      if (accent) el.style.setProperty('--a', accent);
      const amount = e.amount ? `<span class="amount">${esc(e.amount)}</span>` : '';
      const body = partsHtml(shownParts(e, cls));
      el.innerHTML =
        `<div class="alert-head">${pf}<span class="kind">${KIND_EMOJI[e.kind]} ${KIND_LABEL[e.kind]}</span>${e.code === 'test' ? '<span class="chip">TEST</span>' : ''}${ts}${amount}</div>` +
        `<div class="alert-body">${nameHtml(e.user, theme, e.kind === 'hype' ? null : e.platform)} <span class="title">${esc(e.title || '')}</span></div>` +
        (body ? `<span class="text">${body}</span>` : '') + lineActions(true);
      return el;
    }

    const hl = cls && cls.highlight;
    el.className = `msg k-chat p-${e.platform}` + (e.silent && e.title ? ' silent-note' : '') + (hl ? ` hl hl-${hl}` : '');
    const hlChip = hl === 'first' ? '<span class="chip hl-chip">👋 First-time chatter</span>' : hl === 'mention' ? '<span class="chip hl-chip">🔔 Mention</span>' : '';
    const chip = hlChip + (e.title ? `<span class="chip">${esc(e.title)}</span>` : '');
    const body = partsHtml(e.parts);
    el.innerHTML = replyHtml(e.reply, cls && cls.maskReply) +
      `${ts}${pf}${nameHtml(e.user, theme, e.platform)}${body ? '<span class="sep">:</span>' : ' '}${chip}<span class="text">${body}</span>${lineActions(true)}`;
    return el;
  }

  // ---------- Connection status: one coloured dot per platform ----------
  // green = connected and you're live · blue = connected, not live · blue ring = connected, the platform doesn't say
  // whether you're live · yellow = connecting or retrying · red = needs you (or keeps failing) · grey = off.
  const TONE_TEXT = { live: 'Live', ready: 'Connected · not live', unknown: 'Connected', trying: 'Connecting…', problem: 'Needs attention', off: 'Off' };
  const LIVE_UNKNOWN = {
    velora: "Velora doesn't tell guest viewers whether you're live.",
    twitch: "Checking whether you're live…",
  };

  /** { tone, text, note } for a platform's status (see the colours above). Repeated failed reconnects turn red. */
  function statusTone(s) {
    const st = s && s.state;
    let tone, text;
    if (st === 'error') { tone = 'problem'; text = 'Needs attention'; }
    else if (st === 'setup') { tone = 'problem'; text = 'Needs setting up'; }
    else if (st === 'reconnecting') { tone = (Number(s.attempt) || 0) >= 4 ? 'problem' : 'trying'; text = tone === 'problem' ? "Can't reconnect, still trying" : 'Reconnecting…'; }
    else if (st === 'connecting') { tone = 'trying'; text = 'Connecting…'; }
    else if (st === 'connected' || st === 'waiting') {
      tone = s.live === true ? 'live' : s.live === false || st === 'waiting' ? 'ready' : 'unknown';
      text = TONE_TEXT[tone];
    } else if (st === 'disabled') { tone = 'off'; text = 'Off'; }
    else { tone = 'trying'; text = String(st || ''); }
    const note = tone === 'unknown' && own(LIVE_UNKNOWN, s.platform) ? LIVE_UNKNOWN[s.platform] : '';
    return { tone, text, note };
  }

  // ---------- Live feed: in the web version everything runs in this browser (see hub.js) ----------
  function connect(role, handlers) {
    return window.UniChatHub.connect(role, handlers);
  }

  // ---------- Sounds ----------
  const Sound = (function () {
    let ctx = null;
    const buffers = new Map();
    let lastChat = 0;
    const lastByKind = {};

    function context() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
      }
      return ctx;
    }

    function unlocked() { const c = context(); return !!c && c.state === 'running'; }
    function unlock() { const c = context(); if (c && c.state !== 'running') return c.resume(); return Promise.resolve(); }
    function supported() { return !!(window.AudioContext || window.webkitAudioContext); }
    /** Runs fn whenever the browser allows or blocks sound (e.g. after the first click on the page). */
    function onState(fn) { const c = context(); if (c) c.addEventListener('statechange', fn); }

    function tone(c, out, { freq, start = 0, dur = 0.2, type = 'sine', gain = 0.5, slideTo = null, attack = 0.005 }) {
      const t0 = c.currentTime + start;
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g).connect(out);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    }

    // Built-in sounds are synthesized, so there are no files to ship or licence.
    const BUILTIN = {
      pop: (c, o) => tone(c, o, { freq: 520, slideTo: 880, dur: 0.09, gain: 0.6 }),
      blip: (c, o) => { tone(c, o, { freq: 1200, dur: 0.06, type: 'triangle', gain: 0.4 }); tone(c, o, { freq: 1600, start: 0.07, dur: 0.06, type: 'triangle', gain: 0.3 }); },
      chime: (c, o) => { tone(c, o, { freq: 880, dur: 0.5, gain: 0.45 }); tone(c, o, { freq: 1318.5, start: 0.12, dur: 0.7, gain: 0.4 }); },
      ding: (c, o) => { tone(c, o, { freq: 1568, dur: 1.0, gain: 0.45 }); tone(c, o, { freq: 3136, dur: 0.5, gain: 0.08 }); },
      bell: (c, o) => { [523.3, 1046.5, 1568, 2093].forEach((f, i) => tone(c, o, { freq: f, dur: 1.4 - i * 0.25, gain: 0.35 / (i + 1) })); },
      coins: (c, o) => { [987.8, 1318.5, 1975.5, 2637].forEach((f, i) => tone(c, o, { freq: f, start: i * 0.07, dur: 0.18, type: 'square', gain: 0.12 })); },
      fanfare: (c, o) => {
        [[523.3, 0], [659.3, 0.12], [784, 0.24], [1046.5, 0.36]].forEach(([f, s]) => tone(c, o, { freq: f, start: s, dur: s === 0.36 ? 0.7 : 0.16, type: 'sawtooth', gain: 0.12 }));
        tone(c, o, { freq: 523.3, start: 0.36, dur: 0.7, type: 'triangle', gain: 0.2 });
      },
      levelup: (c, o) => { [392, 523.3, 659.3, 784, 1046.5].forEach((f, i) => tone(c, o, { freq: f, start: i * 0.06, dur: 0.14, type: 'triangle', gain: 0.3 })); },
      whoosh: (c, o) => tone(c, o, { freq: 200, slideTo: 1400, dur: 0.35, type: 'sawtooth', gain: 0.08, attack: 0.1 }),
      error: (c, o) => { tone(c, o, { freq: 440, dur: 0.18, type: 'square', gain: 0.12 }); tone(c, o, { freq: 330, start: 0.2, dur: 0.3, type: 'square', gain: 0.12 }); },
    };
    const BUILTIN_NAMES = { pop: 'Pop', blip: 'Blip', chime: 'Chime', ding: 'Ding', bell: 'Bell', coins: 'Coins', fanfare: 'Fanfare', levelup: 'Level up', whoosh: 'Whoosh', error: 'Alert buzz' };

    async function play(name, volume) {
      const c = context();
      if (!c || c.state !== 'running' || !name || name === 'none') return;
      const out = c.createGain();
      out.gain.value = Math.max(0, Math.min(1, volume == null ? 0.7 : volume));
      out.connect(c.destination);

      if (name.startsWith('builtin:')) {
        const fn = BUILTIN[name.slice(8)] || BUILTIN.pop;
        fn(c, out);
        return;
      }
    }

    /** Decide whether an incoming event should make a sound, based on shared settings. */
    function forEvent(e, settings, cls) {
      if (!settings || e.silent) return;
      const alerts = settings.alerts || {};
      if (e.kind === 'system') {
        if (e.code === 'connection-lost' && alerts.soundOnConnectionLost) play(alerts.connectionLostSound, alerts.connectionLostVolume);
        return;
      }
      cls = cls || classify(e, settings);
      if (cls.hidden) return;
      const h = settings.highlights || {};
      if (cls.highlight && h.sound) {
        const now = Date.now();
        if (now - (lastByKind.highlight || 0) < 250) return;
        lastByKind.highlight = now;
        play(h.soundName, h.volume);
        return;
      }
      const cfg = alerts.kinds && alerts.kinds[e.kind];
      if (!cfg || !cfg.sound) return;
      if (cfg.platforms && cfg.platforms[e.platform] === false) return;
      const now = Date.now();
      if (e.kind === 'chat') {
        if (now - lastChat < (alerts.chatSoundCooldownSec || 0) * 1000) return;
        lastChat = now;
      } else {
        if (now - (lastByKind[e.kind] || 0) < 250) return;
        lastByKind[e.kind] = now;
      }
      play(cfg.soundName, cfg.volume);
    }

    function forget(file) { buffers.delete(file); }

    return { unlock, unlocked, supported, onState, play, forEvent, forget, BUILTIN_NAMES };
  })();

  // ---------- Local actions (no server in the web version; see hub.js) ----------
  function api(method, url, body) {
    return window.UniChatHub.api(method, url, body);
  }
  function storePin() { /* no PIN in the web version */ }

  // ---------- Text-to-speech (browser's built-in voices) ----------
  const Speech = (function () {
    const synth = window.speechSynthesis;
    let queued = 0;

    function voices() { return synth ? synth.getVoices() : []; }

    function textFor(e, tts, cls) {
      let msg = (cls && cls.maskText ? '' : plainText(e))
        .replace(/https?:\/\/\S+/g, '')
        .replace(/\b[A-Za-z]+\d+\b/g, '')   // Twitch cheermotes like Cheer100
        .replace(/\s+/g, ' ')
        .trim();
      const max = tts.maxChars || 200;
      if (msg.length > max) msg = msg.slice(0, max).replace(/\s+\S*$/, '') + '…';
      let intro = '';
      if (tts.readNames) {
        const name = (e.user && e.user.name ? e.user.name : 'Someone').replace(/^@/, '');
        const amountInTitle = e.amount && e.title && e.title.toLowerCase().includes(e.amount.toLowerCase());
        intro = `${name} ${e.title || ''}${e.amount && !amountInTitle ? ' ' + e.amount : ''}.`;
      }
      return `${intro} ${msg}`.trim();
    }

    function say(text, tts) {
      if (!synth || !text) return;
      if (queued >= 6) return; // don't build a backlog during a flood of alerts
      const u = new SpeechSynthesisUtterance(text);
      const v = tts.voice && voices().find(x => x.name === tts.voice);
      if (v) u.voice = v;
      u.rate = tts.rate || 1;
      u.volume = tts.volume == null ? 0.9 : tts.volume;
      queued++;
      u.onend = u.onerror = () => { queued = Math.max(0, queued - 1); };
      synth.speak(u);
    }

    /** Speak an alert if text-to-speech is on for its kind. Waits a moment so the alert sound plays first. */
    function forEvent(e, settings, cls) {
      const tts = settings && settings.tts;
      if (!tts || !tts.enabled || e.silent || !(tts.kinds && tts.kinds[e.kind])) return;
      cls = cls || classify(e, settings);
      if (cls.hidden) return;
      const text = textFor(e, tts, cls);
      if (!text) return;
      setTimeout(() => say(text, tts), 900);
    }

    function stop() { if (synth) { synth.cancel(); queued = 0; } }
    function speaking() { return !!synth && (synth.speaking || synth.pending); }

    return { available: !!synth, voices, say, forEvent, stop, speaking };
  })();

  const VERSION = '0.0.12';
  window.UniChat = { VERSION, api, storePin, fmtMoney, icon, esc, safeUrl, safeColor, renderEvent, connect, Sound, Speech, classify, plainText, NAMES, PLATFORMS, ALERT_KINDS, KIND_LABEL, KIND_EMOJI, fmtTime, nameHtml, avatarHtml, swapAvatar, partsHtml, shownParts, userColor, statusTone, fmtCount, fmtDuration };
})();
