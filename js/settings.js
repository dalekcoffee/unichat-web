/* UniChat Web settings page: edits the settings saved in this browser, builds bookmarkable links,
   shows live status from chat tabs open in this browser, and sends them test alerts. */
(function () {
  'use strict';
  // Never run inside another site's frame (stops "clickjacking" tricks on this page).
  if (window.top !== window.self) {
    document.body.textContent = 'UniChat settings can only be opened directly, not inside another page.';
    return;
  }
  const U = window.UniChat;
  const Store = window.UniChatStore;
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('unichat') : null;

  const KINDS = [
    ['chat', '💬 Chat message'],
    ['follow', '💙 Follow', 'TikTok, Kick and Nimo TV follows (Twitch follows need a login)'],
    ['donation', '💰 Donation', 'Twitch bits and Hype Chats, TikTok gifts, Kick KICKs, Blaze tips, Nimo TV diamond gifts and paid chat'],
    ['sub', '⭐ Sub', 'Twitch, Kick and Blaze subs and gifted subs; TikTok and Nimo TV subscribers'],
    ['raid', '🚀 Raid', 'Twitch and Velora raids'],
  ];

  // A link's settings win over this browser's, so show those when the page was opened from a link.
  const fromLink = Store.hasUrlConfig();
  let saved = fromLink ? Store.load() : Store.loadSaved();
  // The link's part after the page name (?…#…). A chat tab opened from the same link updates to the new link on Save.
  let linkConfig = location.search + location.hash;

  // ---------- helpers ----------
  const clone = o => JSON.parse(JSON.stringify(o));
  const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  function setPath(obj, path, value) {
    const keys = path.split('.');
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
      o = o[keys[i]];
    }
    o[keys[keys.length - 1]] = value;
  }
  let toastTimer;
  function toast(text, isError) {
    let el = $('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = text;
    el.classList.toggle('err', !!isError);
    el.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = '0'; }, isError ? 6000 : 2500);
  }
  const prefs = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  // ---------- page chrome: section icons, navigation, theme ----------
  const SICONS = {
    link: 'M3.9 12a3.1 3.1 0 0 1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7A3.1 3.1 0 0 1 3.9 12ZM8 13h8v-2H8v2Zm9-6h-4v1.9h4a3.1 3.1 0 0 1 0 6.2h-4V17h4a5 5 0 0 0 0-10Z',
    signal: 'M1 9l2 2a12.7 12.7 0 0 1 18 0l2-2A15.6 15.6 0 0 0 1 9Zm8 8 3 3 3-3a4.2 4.2 0 0 0-6 0Zm-4-4 2 2a7 7 0 0 1 10 0l2-2a9.9 9.9 0 0 0-14 0Z',
    filter: 'M10 18h4v-2h-4v2ZM3 6v2h18V6H3Zm3 7h12v-2H6v2Z',
    megaphone: 'M18 11v2h4v-2h-4Zm-2 6.6 3.2 2.4 1.2-1.6-3.2-2.4-1.2 1.6ZM20.4 5.6 19.2 4 16 6.4l1.2 1.6 3.2-2.4ZM4 9a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h1v4h2v-4h1l5 3V6L8 9H4Zm11.5 3a4.5 4.5 0 0 0-1.5-3.4v6.8a4.5 4.5 0 0 0 1.5-3.4Z',
    speaker: 'M3 9v6h4l5 5V4L7 9H3Zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4ZM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6Z',
    display: 'M21 3H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5v2h8v-2h5a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Zm0 14H3V5h18v12Z',
    backup: 'M19 9h-4V3H9v6H5l7 7 7-7ZM5 18v2h14v-2H5Z',
    vr: 'M4 6h16a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-4.2l-2.3-2.7a2 2 0 0 0-3 0L8.2 18H4a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3Z',
    play: 'M8 5v14l11-7L8 5Z',
    bug: 'M20 8h-2.8a6 6 0 0 0-1.8-2l1.6-1.6L15.6 3l-2.2 2.2a6 6 0 0 0-2.8 0L8.4 3 7 4.4 8.6 6a6 6 0 0 0-1.8 2H4v2h2.1a6 6 0 0 0 0 1v1H4v2h2v1a6 6 0 0 0 .1 1H4v2h2.8a6 6 0 0 0 10.4 0H20v-2h-2.1a6 6 0 0 0 .1-1v-1h2v-2h-2v-1a6 6 0 0 0-.1-1H20V8Zm-6 8h-4v-2h4v2Zm0-4h-4v-2h4v2Z',
  };
  const sicon = name => (SICONS[name] ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${SICONS[name]}"/></svg>` : '');
  $$('[data-ico]').forEach(el => { if (el.tagName === 'SPAN') el.innerHTML = sicon(el.dataset.ico); });
  $$('[data-icon]').forEach(el => { el.innerHTML = U.icon(el.dataset.icon); });
  $('#linkNotice').classList.toggle('hidden', !fromLink);
  $('#appVersion').textContent = 'v' + U.VERSION;

  if (Store.RELAY_URL) $('#sec-resonite').classList.remove('hidden'); else $('#sec-resonite').remove();

  // Section menu (sidebar on wide screens, scrolling chips on phones). Buttons, not "#" links: the part of the
  // address after "#" can hold your settings, so the page never changes it.
  const sections = $$('section[data-nav]');
  const nav = $('#sNav');
  nav.innerHTML = sections.map(sec => {
    const ico = sec.dataset.plat ? U.icon(sec.dataset.plat) : sicon(sec.dataset.ico);
    return `<button type="button" data-jump="${sec.id}">${ico}<span>${U.esc(sec.dataset.nav)}</span></button>`;
  }).join('');
  nav.addEventListener('click', e => {
    const b = e.target.closest('[data-jump]');
    if (!b) return;
    const target = document.getElementById(b.dataset.jump);
    if (target) target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  });
  let spyQueued = false;
  function spy() {
    spyQueued = false;
    const offset = parseFloat(getComputedStyle(sections[0]).scrollMarginTop) || 80;
    const shown = sections.filter(sec => sec.offsetParent !== null);
    let current = shown[0] || sections[0];
    for (const sec of shown) if (sec.getBoundingClientRect().top - offset <= 8) current = sec;
    if (shown.length && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = shown[shown.length - 1];
    $$('#sNav [data-jump]').forEach(b => {
      const on = b.dataset.jump === current.id;
      if (on && !b.classList.contains('active') && nav.scrollWidth > nav.clientWidth + 2) {
        nav.scrollTo({ left: b.offsetLeft - (nav.clientWidth - b.offsetWidth) / 2, behavior: 'smooth' });
      }
      b.classList.toggle('active', on);
    });
  }
  window.addEventListener('scroll', () => { if (!spyQueued) { spyQueued = true; requestAnimationFrame(spy); } }, { passive: true });
  window.addEventListener('resize', spy);

  function applyTheme(theme) { document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark'; }
  function markPlatformCards() {
    $$('.plat-head .switch input').forEach(i => i.closest('.plat-block').classList.toggle('off', !i.checked));
  }

  // ---------- sound pickers ----------
  function volumeControl(path) {
    return `<div class="vol"><input type="range" min="0" max="1" step="0.05" data-path="${path}"><span class="pct" data-pct-for="${path}"></span></div>`;
  }
  function testButtons(soundPath, volumePath) {
    return `<div class="test-btns"><button class="btn small" type="button" data-test-here data-s="${soundPath}" data-v="${volumePath}" title="Play it here">▶ Test</button></div>`;
  }
  $$('[data-volume-control]').forEach(el => { el.outerHTML = volumeControl(el.dataset.volumeControl); });
  $$('[data-test-buttons]').forEach(el => { const [s, v] = el.dataset.testButtons.split('|'); el.outerHTML = testButtons(s, v); });

  $('#soundRows').innerHTML = KINDS.map(([kind, label, hint]) => {
    const base = `alerts.kinds.${kind}`;
    const plats = ['twitch', 'tiktok', 'kick', 'velora', 'blaze', 'nimo', 'x'].map(p => `<label title="${U.NAMES[p]}">${U.icon(p)}<input type="checkbox" data-path="${base}.platforms.${p}"></label>`).join('');
    return `<div class="sound-row">
      <div class="sr-label"><b>${label}</b>${hint ? `<div class="help">${hint}</div>` : ''}</div>
      <div class="sr-controls">
        <select data-path="${base}.soundName" data-sound-select></select>
        ${volumeControl(`${base}.volume`)}
        ${testButtons(`${base}.soundName`, `${base}.volume`)}
        <div class="plat-checks" title="Which platforms play this sound">${plats}</div>
      </div>
    </div>`;
  }).join('');

  function fillSoundSelects() {
    const options = Object.entries(U.Sound.BUILTIN_NAMES).map(([k, v]) => `<option value="builtin:${k}">${v}</option>`).join('');
    $$('[data-sound-select]').forEach(sel => { sel.innerHTML = options; });
  }
  fillSoundSelects();

  function updatePercents() {
    $$('[data-pct-for]').forEach(el => {
      const input = $(`[data-path="${el.dataset.pctFor}"]`);
      if (input) el.textContent = Math.round(Number(input.value) / (Number(input.max) || 1) * 100) + '%'; // the slider's end is 100%
    });
    $$('[data-rate-for]').forEach(el => {
      const input = $(`[data-path="${el.dataset.rateFor}"]`);
      if (input) el.textContent = Number(input.value).toFixed(1) + '×';
    });
  }

  // ---------- popup / TTS kinds ----------
  const chip = (path, label) => `<label class="chip-check"><input type="checkbox" data-path="${path}"><span>${label}</span></label>`;
  // Basic: one row per kind, with what it does (sound, big popup, read aloud). Chat can't pop up or be read aloud.
  const GRID = [['chat', '💬 Chat'], ['follow', '💙 Follow'], ['donation', '💰 Donation'], ['sub', '⭐ Sub'], ['raid', '🚀 Raid']];
  const tick = (path, label) => `<label class="ag-cell" title="${label}"><input type="checkbox" data-path="${path}" aria-label="${label}"></label>`;
  $('#alertGrid').innerHTML = '<div class="ag-row ag-head"><span></span><span>Sound</span><span>Popup</span><span>Read aloud</span></div>' +
    GRID.map(([k, l]) => `<div class="ag-row"><span class="ag-name">${l}</span>${tick(`alerts.kinds.${k}.sound`, `${l}: sound`)}${k === 'chat' ? '<span></span><span></span>'
      : tick(`popup.kinds.${k}`, `${l}: big popup`) + tick(`tts.kinds.${k}`, `${l}: read aloud`)}</div>`).join('');

  // The overall Volume (every sound and the voice, on top of their own volumes) also applies to the tests on this page.
  const useMasterVolume = () => U.Sound.setMaster(Number($('[data-path="alerts.masterVolume"]').value));

  // Basic settings by default; "Show all settings" (remembered on this device) shows every option.
  const modeBtn = $('#modeBtn');
  function applyMode(all) {
    document.body.classList.toggle('basic', !all);
    modeBtn.textContent = all ? 'Basic settings' : 'Show all settings';
    modeBtn.setAttribute('aria-pressed', String(all));
    $$('#sNav [data-jump]').forEach(b => { const sec = document.getElementById(b.dataset.jump); b.hidden = !!sec && sec.classList.contains('adv') && !all; });
    spy();
  }
  modeBtn.addEventListener('click', () => { const all = document.body.classList.contains('basic'); prefs.set('unichat.web.settingsAll', all); applyMode(all); });

  function fillVoices() {
    const sel = $('#ttsVoice');
    const current = sel.value || (saved.tts && saved.tts.voice) || '';
    const voices = U.Speech.voices();
    const own = Object.entries(U.Speech.KOKORO).map(([k, label]) => `<option value="kokoro:${k}">${U.esc(label)}${k === 'af_heart' ? ' (default)' : ''}</option>`).join('');
    sel.innerHTML = `<optgroup label="UniChat voices">${own}</optgroup><optgroup label="This device"><option value="">Default device voice</option>` +
      voices.map(v => `<option value="${U.esc(v.name)}">${U.esc(v.name)}${v.lang ? ` (${U.esc(v.lang)})` : ''}</option>`).join('') + '</optgroup>';
    if (current && !current.startsWith('kokoro:') && !voices.some(v => v.name === current)) {
      sel.insertAdjacentHTML('beforeend', `<option value="${U.esc(current)}">${U.esc(current)} (not on this device)</option>`);
    }
    sel.value = current;
  }
  if (window.speechSynthesis) window.speechSynthesis.addEventListener('voiceschanged', fillVoices);

  // ---------- text size: whole numbers, snapping to presets ----------
  const SIZE_PRESETS = [['Small', 14], ['Medium', 18], ['Large', 24]];
  const sizeRange = $('#fontSizeRange');
  const sizeNum = $('#fontSizeNum');
  (function buildSizePresets() {
    const min = Number(sizeRange.min), max = Number(sizeRange.max);
    $('#fontPresets').innerHTML = SIZE_PRESETS.map(([l, v]) => `<option value="${v}" label="${l}"></option>`).join('');
    $('#sizePresets').innerHTML = SIZE_PRESETS.map(([l, v]) => {
      const pct = (v - min) / (max - min) * 100;
      return `<button type="button" data-size="${v}" style="left:calc(${pct}% + ${((0.5 - pct / 100) * 16).toFixed(1)}px)" title="${v}px">${l}</button>`;
    }).join('');
  })();
  const snapSize = v => { v = Math.round(v); for (const [, p] of SIZE_PRESETS) if (Math.abs(v - p) <= 1) return p; return v; };
  function showSize(v, keepBox) {
    v = Math.min(48, Math.max(10, Math.round(v)));
    sizeRange.value = Math.min(v, Number(sizeRange.max));
    if (!keepBox) sizeNum.value = v;
    $('#sizePreview').style.fontSize = v + 'px';
    $$('#sizePresets button').forEach(b => b.classList.toggle('on', Number(b.dataset.size) === v));
  }
  sizeRange.addEventListener('input', () => { showSize(snapSize(Number(sizeRange.value))); changed(); });
  sizeNum.addEventListener('input', () => { const v = Number(sizeNum.value); if (v >= 10 && v <= 48) showSize(v, true); });
  sizeNum.addEventListener('change', () => { showSize(Number(sizeNum.value) || 16); changed(); });
  $('#sizePresets').addEventListener('click', e => { const b = e.target.closest('[data-size]'); if (b) { showSize(Number(b.dataset.size)); changed(); } });

  // ---------- form binding ----------
  function render() {
    fillVoices();
    $$('[data-path]').forEach(el => {
      const v = getPath(saved, el.dataset.path);
      if (el.type === 'checkbox') el.checked = !!v;
      else if (el.dataset.type === 'list') el.value = (v || []).join('\n');
      else el.value = v == null ? '' : v;
    });
    updatePercents();
    useMasterVolume();
    showSize(saved.display.fontSize || 16);
    applyTheme(saved.display.theme);
    markPlatformCards();
    ownKeyChoice = saved.tikTok.ownKey === true;
    showTikTokKey();
    $('#savebar').classList.toggle('show', false);
    updateLinks();
    showNimoPick();
    spy();
  }

  function collect() {
    const s = clone(saved);
    $$('[data-path]').forEach(el => {
      let v;
      if (el.type === 'checkbox') v = el.checked;
      else if (el.dataset.type === 'list') v = el.value.split(/[\n,]/).map(x => x.trim()).filter(Boolean);
      else if (el.type === 'number' || el.type === 'range') {
        v = Number(el.value);
        if (!el.step || Number.isInteger(Number(el.step))) v = Math.round(v);
      } else v = el.value;
      setPath(s, el.dataset.path, v);
    });
    s.tikTok.ownKey = ownKeyChoice; // its box is forced on (and locked) for usernames the relay doesn't serve
    return s;
  }

  function changed() {
    updatePercents();
    useMasterVolume();
    markPlatformCards();
    applyTheme($('[data-path="display.theme"]').value); // preview here; Save applies it everywhere
    updateLinks();
    $('#savebar').classList.toggle('show', JSON.stringify(collect()) !== JSON.stringify(saved));
  }
  document.addEventListener('input', e => { if (e.target.closest('[data-path]')) changed(); });
  document.addEventListener('change', e => { if (e.target.closest('[data-path]')) changed(); });

  function save() {
    try {
      saved = Store.save(collect());
      render();
      if (fromLink) relinkChatTabs();
      toast('Saved. Open chat pages update right away, without losing their chat.');
    } catch (err) {
      toast(err.message, true);
    }
  }

  /**
   * A chat tab opened from a link keeps that link's settings over the saved ones, so it wouldn't see these changes.
   * Chat tabs showing the link this page was opened from switch their address to the new link (no reload, chat kept);
   * this page's address follows, so the next Save and a reload stay in step.
   */
  function relinkChatTabs() {
    const next = Store.shareUrl(saved, 'index.html', keyBox.checked).replace(/^[^?#]*/, '');
    if (next === linkConfig) return;
    if (channel) channel.postMessage({ type: 'relink', from: linkConfig, to: next });
    linkConfig = next;
    try { history.replaceState(null, '', location.pathname + next); } catch { /* address unchanged: harmless */ }
    $('#linkNotice').classList.add('hidden');
  }
  $('#save').addEventListener('click', save);
  $('#revert').addEventListener('click', render);
  document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); } });

  // ---------- bookmarkable links ----------
  const keyBox = $('#linkIncludesKey');
  keyBox.checked = prefs.get('unichat.web.linkIncludesKey', false);
  keyBox.addEventListener('change', () => { prefs.set('unichat.web.linkIncludesKey', keyBox.checked); updateLinks(); });

  function updateLinks() {
    const s = collect();
    const chat = Store.shareUrl(s, 'index.html', keyBox.checked);
    const overlay = Store.shareUrl(s, 'overlay.html', keyBox.checked);
    // Links that read TikTok through the relay never carry a key, so the choice is hidden then.
    const relay = Store.usesRelay(s);
    $('#linkKeyRow').classList.toggle('hidden', relay);
    $('#linkKeyHelp').classList.toggle('hidden', relay);
    $('#chatLink').value = chat;
    $('#overlayLink').value = overlay;
    $('#chatOpen').href = chat;
    $('#overlayOpen').href = overlay;
    $('#backLink').href = fromLink ? chat : 'index.html';
    $('#brandLink').href = $('#backLink').href;
  }

  // The chat page opens Settings in its own tab, so the chat keeps running. "Back to chat" then returns to that tab
  // (and closes this one) instead of loading a second chat page.
  const chatTab = () => { try { return window.opener && !window.opener.closed && window.opener.location.origin === location.origin ? window.opener : null; } catch { return null; } };
  ['#backLink', '#brandLink'].forEach(sel => $(sel).addEventListener('click', e => {
    const tab = chatTab();
    if (!tab || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    if (!$('#savebar').classList.contains('show') || confirm('You have unsaved changes. Leave without saving?')) {
      tab.focus();
      window.close();
    }
  }));

  document.addEventListener('click', e => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    const input = document.getElementById(b.dataset.copy);
    const done = () => toast('Link copied. Paste it into a bookmark.');
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(input.value).then(done, () => { input.select(); document.execCommand('copy'); done(); });
    else { input.select(); document.execCommand('copy'); done(); }
  });

  $('#toggleKey').addEventListener('click', e => {
    e.preventDefault();
    const input = $('#eulerKey');
    input.type = input.type === 'password' ? 'text' : 'password';
    $('#toggleKey').textContent = input.type === 'password' ? 'Show' : 'Hide';
    $('#toggleKey').setAttribute('aria-pressed', String(input.type === 'text'));
  });

  // ---------- tests ----------
  document.addEventListener('click', e => {
    const here = e.target.closest('[data-test-here]');
    if (here) {
      const sound = $(`[data-path="${here.dataset.s}"]`).value;
      const volume = Number($(`[data-path="${here.dataset.v}"]`).value);
      U.Sound.unlock().then(() => U.Sound.play(sound, volume));
      return;
    }
    const test = e.target.closest('[data-test]');
    if (test) {
      if (!channel) { toast("This browser can't send test alerts to other tabs", true); return; }
      channel.postMessage({ type: 'test', platform: $('#testPlatform').value, kind: test.dataset.test });
      toast(connectedTabs ? 'Test alert sent to the open chat page' : 'Sent. Open the chat page in this browser to see it.');
    }
  });
  $('#testTts').addEventListener('click', () => {
    if (!U.Speech.available) { toast('This browser has no text-to-speech', true); return; }
    U.Speech.stop();
    const tts = collect().tts;
    U.Speech.say(`${tts.readNames ? 'NightOwl says: ' : ''}Loving the stream, keep it up!`, tts);
  });

  // ---------- backup ----------
  const exportKeyBox = $('#exportIncludesKey');
  exportKeyBox.checked = prefs.get('unichat.web.exportIncludesKey', true);
  exportKeyBox.addEventListener('change', () => prefs.set('unichat.web.exportIncludesKey', exportKeyBox.checked));
  $('#exportBtn').addEventListener('click', () => {
    const s = collect();
    const withKey = exportKeyBox.checked && !!String(s.tikTok.eulerKey || '').trim();
    const blob = new Blob([Store.exportJson(s, withKey)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `unichat-settings-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(withKey ? 'Downloaded. It includes your Euler key, so keep the file private.' : 'Downloaded (without an Euler key)');
  });
  $('#importFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      saved = Store.importJson(await file.text());
      render();
      toast('Settings loaded and saved in this browser');
    } catch (err) {
      toast('Could not load that file: ' + err.message, true);
    }
  });

  // ---------- Nimo TV: pick the streamer from Nimo's search ----------
  // Nimo names aren't unique, so Find lists Nimo's results and "Use" saves that exact room (nimo.roomId) with the name.
  const nimoName = $('#nimoChannel');
  const nimoRoom = $('[data-path="nimo.roomId"]');
  const nimoFind = $('#nimoFind');
  const nimoPick = $('#nimoPick');
  let nimoPicked = null; // { room, name } chosen on this page, to show the name next to the room
  const helpLine = text => { const p = document.createElement('p'); p.className = 'help'; p.textContent = text; return p; };

  function showNimoPick() {
    const room = Number(nimoRoom.value) || 0;
    nimoPick.replaceChildren();
    if (!room) return;
    const who = nimoPicked && Number(nimoPicked.room) === room ? `${nimoPicked.name}, ` : '';
    const line = helpLine(`✓ Using ${who}room ${room} (nimo.tv/live/${room}).`);
    line.classList.add('nimo-picked');
    nimoPick.append(line);
  }

  // Typing a different name drops the picked room (it belonged to the old name).
  nimoName.addEventListener('input', () => {
    if (Number(nimoRoom.value)) { nimoRoom.value = 0; nimoPicked = null; showNimoPick(); }
  });
  nimoName.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); findNimo(); } });
  nimoFind.addEventListener('click', findNimo);

  function resultRow(u) {
    const row = document.createElement('div');
    row.className = 'nimo-result' + (u.exact ? ' exact' : '');
    const img = document.createElement('img');
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    if (typeof u.avatar === 'string' && /^https:\/\//i.test(u.avatar)) img.src = u.avatar; // Nimo's own image servers (checked in nimo.js; https here too)
    const info = document.createElement('div');
    info.className = 'grow';
    const name = document.createElement('b');
    name.textContent = u.name || '(no name)';
    const meta = document.createElement('span');
    meta.className = 'detail';
    meta.textContent = [`room ${u.room}`, u.alias ? `nimo.tv/${u.alias}` : '', `${u.followers.toLocaleString()} follower${u.followers === 1 ? '' : 's'}`, u.live ? 'LIVE' : ''].filter(Boolean).join(' · ');
    info.append(name, meta);
    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'btn small';
    use.textContent = 'Use';
    use.addEventListener('click', () => {
      nimoPicked = { room: u.room, name: u.name };
      nimoName.value = Store.normalizeNimo(u.name) || u.room;
      nimoRoom.value = u.room;
      changed();
      showNimoPick();
      nimoPick.append(helpLine('Click Save to use it.'));
    });
    row.append(img, info, use);
    return row;
  }

  async function findNimo() {
    const query = Store.normalizeNimo(nimoName.value);
    if (!query) { toast('Type a Nimo name or room number first', true); return; }
    if (!window.UniChatNimo) { toast("Nimo search isn't available on this page", true); return; }
    nimoFind.disabled = true;
    nimoPick.replaceChildren(helpLine('Searching Nimo…'));
    try {
      const found = (await window.UniChatNimo.findStreamers(query)).slice(0, 12);
      nimoPick.replaceChildren();
      if (!found.length) { nimoPick.append(helpLine(`Nimo found nobody for "${query}". Check the spelling, or use the number from your nimo.tv/live/<number> link.`)); return; }
      const exact = found.filter(u => u.exact).length;
      nimoPick.append(helpLine(exact > 1 ? `${exact} streamers are called "${query}". Pick yours:`
        : exact === 1 ? 'Is this you? Click Use to confirm.'
          : `Nobody is called exactly "${query}". Closest results:`));
      const list = document.createElement('div');
      list.className = 'nimo-results';
      found.forEach(u => list.append(resultRow(u)));
      nimoPick.append(list);
    } catch (err) {
      nimoPick.replaceChildren(helpLine(`Couldn't search Nimo (${err.message}). Try again in a moment.`));
    } finally {
      nimoFind.disabled = false;
    }
  }

  // ---------- TikTok: the relay holds the Euler key for its username (see store.js) ----------
  // "Use my own Euler key" (tikTok.ownKey) is the backup for when the relay is down: off by default for the relay's
  // username, and always on (locked) for any other username, which the relay doesn't serve.
  let ownKeyChoice = false; // what was picked for the relay's username (kept while another name is typed)
  function showTikTokKey() {
    const box = $('#ownKey');
    const relayName = Store.relayServes($('[data-path="tikTok.username"]').value || Store.DEFAULTS.tikTok.username);
    const own = !relayName || ownKeyChoice;
    box.checked = own;
    box.disabled = !relayName;
    $('#ownKeyRow').classList.toggle('hidden', !Store.RELAY_URL);
    $('#relayKeyNote').classList.toggle('hidden', !relayName || own);
    $('#relayUser').textContent = '@' + Store.RELAY_TIKTOK_USER;
    $('#ownKeyWhy').classList.toggle('hidden', !Store.RELAY_URL || !own);
    $('#ownKeyWhy').textContent = relayName
      ? 'Connecting straight to Euler with your key, not through the relay. Turn this off to go back to the relay.'
      : `Only @${Store.RELAY_TIKTOK_USER} can use the relay, so other usernames need their own free key.`;
    $('#eulerKeyField').classList.toggle('hidden', !own);
    $('#eulerSteps').classList.toggle('hidden', !own);
    $('#savedKeyNote').classList.toggle('hidden', own || !$('#eulerKey').value);
  }
  $('[data-path="tikTok.username"]').addEventListener('input', showTikTokKey);
  $('#ownKey').addEventListener('change', () => {
    if ($('#ownKey').disabled) return;
    ownKeyChoice = $('#ownKey').checked;
    showTikTokKey();
    changed();
  });
  $('#forgetKey').addEventListener('click', () => {
    $('#eulerKey').value = '';
    changed();
    showTikTokKey();
    toast('Press Save to forget the key in this browser.');
  });

  // ---------- Resonite: this device sends its chat to the in-game panel (the chat page does it, see resonite.js) ----------
  // Saved straight away and kept apart from the settings (Store.resonite), so the room code never goes into links or backups.
  let resReport = null; // the latest word from a chat page in this browser
  const RES_TEXT = {
    connecting: () => 'Connecting to the relay…',
    sending: r => `Sending to Resonite · ${r.readers ? `${r.readers} panel${r.readers === 1 ? '' : 's'} reading` : 'no panel connected yet'}`,
    retrying: r => `Can't reach the relay (${r.reason || 'no answer'}). Trying again by itself…`,
    badroom: () => "The relay didn't accept this room code. Press New room, then paste the new panel code into your panel.",
    inuse: () => "Someone else's UniChat is sending to this room right now. Press New room to get a room of your own.",
    replaced: () => 'Another device (or chat tab) took over sending. Turn this off and on again here to take it back.',
    refused: r => `The relay refused: ${r.reason || 'not set up for Resonite yet'}.`,
    noroom: () => 'Type your room code, or press New room.',
    off: () => 'Not sending from this device.',
  };
  function showResState() {
    let text;
    if (!$('#resOn').checked) text = RES_TEXT.off();
    else if (!Store.resonite.isRoom($('#resRoom').value)) text = RES_TEXT.noroom();
    else if (!resReport || resReport.state === 'off' || resReport.state === 'noroom') text = 'Open the chat page on this device to start sending.';
    else text = (Object.prototype.hasOwnProperty.call(RES_TEXT, resReport.state) ? RES_TEXT[resReport.state] : RES_TEXT.connecting)(resReport);
    $('#resState').textContent = text;
  }
  async function showPanelCode() {
    const room = Store.resonite.cleanRoom($('#resRoom').value);
    if (!Store.resonite.isRoom(room) || !(window.crypto && crypto.subtle)) { $('#resPanel').value = ''; return; }
    const code = await Store.resonite.panelCode(room);
    if (Store.resonite.cleanRoom($('#resRoom').value) === room) $('#resPanel').value = code; // not typed on meanwhile
  }
  function saveResonite() {
    const room = Store.resonite.cleanRoom($('#resRoom').value);
    if (!Store.resonite.isRoom(room)) { toast('A room code is 16 letters and digits (no 0, O, 1, I or L).', true); showResState(); return; }
    $('#resRoom').value = room;
    try { Store.resonite.save({ on: $('#resOn').checked, room }); }
    catch (err) { toast(err.message, true); return; }
    resReport = null;
    showResState();
    showPanelCode();
  }
  if (Store.RELAY_URL) {
    let res = Store.resonite.load();
    if (!res.room && window.crypto && crypto.getRandomValues) { // the first visit (or the old send-key setup): make this browser's room
      res = { on: res.on, room: Store.resonite.newRoom() };
      try { Store.resonite.save(res); } catch { /* shown when they try to turn it on */ }
    }
    $('#resOn').checked = res.on;
    $('#resRoom').value = res.room;
    $('#resOn').addEventListener('change', saveResonite);
    $('#resRoom').addEventListener('change', saveResonite);
    $('#resRoom').addEventListener('input', () => { showResState(); showPanelCode(); });
    $('#resRoomShow').addEventListener('click', () => {
      const input = $('#resRoom');
      input.type = input.type === 'password' ? 'text' : 'password';
      $('#resRoomShow').textContent = input.type === 'password' ? 'Show' : 'Hide';
      $('#resRoomShow').setAttribute('aria-pressed', String(input.type === 'text'));
    });
    $('#resNewRoom').addEventListener('click', () => {
      if (!confirm('Make a new room? Your panels in Resonite will need the new panel code.')) return;
      $('#resRoom').value = Store.resonite.newRoom();
      saveResonite();
      toast('New room made. Copy the new panel code into your panel.');
    });
    $('#resCopy').addEventListener('click', () => {
      const input = $('#resPanel');
      if (!input.value) return;
      const done = () => toast("Copied. Paste it into the key field on your panel's Configuration page in Resonite.");
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(input.value).then(done, () => { input.select(); document.execCommand('copy'); done(); });
      else { input.select(); document.execCommand('copy'); done(); }
    });
    showResState();
    showPanelCode();
  }

  // ---------- TikTok: Euler connections opened today (written by the chat page, see tiktok.js) ----------
  function showTikTokCount() {
    let c = null;
    try { c = JSON.parse(localStorage.getItem('unichat.web.tiktokCount') || 'null'); } catch { /* none */ }
    const today = new Date().toISOString().slice(0, 10);
    const n = c && c.day === today ? Math.max(0, Math.floor(Number(c.n) || 0)) : 0;
    $('#tiktokCount').textContent = c && c.day === today && c.via === 'relay'
      ? `Your relay opened ${n} Euler connection${n === 1 ? '' : 's'} today (UTC). Compare with the usage in your Euler dashboard.`
      : `This browser opened ${n} Euler connection${n === 1 ? '' : 's'} today (UTC). Other devices count separately; compare the total with the usage in your Euler dashboard.`;
  }
  showTikTokCount();
  setInterval(showTikTokCount, 15000);
  window.addEventListener('storage', e => { if (e.key === 'unichat.web.tiktokCount') showTikTokCount(); });

  // ---------- live status & diagnostics from chat tabs in this browser ----------
  let connectedTabs = false;
  const logs = [];
  if (channel) {
    channel.addEventListener('message', ev => {
      const m = ev.data || {};
      if (m.type === 'status') {
        connectedTabs = true;
        const list = (Array.isArray(m.status) ? m.status : []).filter(s => s && typeof s === 'object');
        $('#statusRows').innerHTML = list.map(s => {
          const t = U.statusTone(s);
          const extra = [
            ['reconnecting', 'error', 'stopped'].includes(s.state) ? U.attemptText(s) : '',
            s.live === true && Number.isFinite(s.liveSince) ? `live for ${U.fmtDuration(Date.now() - s.liveSince)}` : '',
            saved.display.showViewerCounts && Number.isFinite(s.viewers) ? `${s.viewers.toLocaleString()} watching` : '',
          ];
          return `<tr>
          <td>${U.icon(s.platform)}</td>
          <td><span class="pill t-${t.tone}${s.state === 'stopped' ? ' failed' : ''}"><span class="dot"></span>${U.esc(t.text)}</span></td>
          <td><b>${U.esc(s.label)}</b> <span class="detail">${U.esc([s.detail, ...extra, t.note].filter(Boolean).join(' · '))}</span></td>
        </tr>`;
        }).join('') || '<tr><td class="help keep">No platforms set up.</td></tr>';
      } else if (m.type === 'resonite' && Store.RELAY_URL) {
        resReport = { state: String(m.state || ''), readers: Math.min(99, Math.max(0, Math.floor(Number(m.readers)) || 0)), reason: String(m.reason || '').slice(0, 200) };
        showResState();
      } else if (m.type === 'diag' && typeof m.line === 'string') {
        logs.unshift(m.line.slice(0, 1000));
        logs.length = Math.min(logs.length, 100);
        $('#logs').textContent = logs.join('\n');
      }
    });
    channel.postMessage({ type: 'hello?' });
    channel.postMessage({ type: 'resonite?' });
  }

  applyMode(prefs.get('unichat.web.settingsAll', false) === true);
  render();
})();
