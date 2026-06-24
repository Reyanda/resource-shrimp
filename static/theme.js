/* ============================================================
   Reyanda shared design-language runtime + customizer.
   One engine, every app. Reads/writes the SAME settings key
   Open Canvas Studio uses (open-canvas-studio.ui.v1), so a
   change in any product applies across all of them.

   It computes a unified palette from the user's choices and
   drives both the OCS-style tokens (--accent, --ink-*, …) and
   the "bridge" variables the vanilla apps already theme off
   (--bg, --fg, --card, --border, --primary, …). No build step.
   ============================================================ */
(function () {
  'use strict';
  var KEY = 'open-canvas-studio.ui.v1';   // shared with Open Canvas Studio
  var OCS_EVT = 'obc:settings-changed';

  // 8 accent families (exact OCS hex ramps) ------------------------------
  var ACCENTS = {
    'vision-grey':     { label: 'Vision Grey',   p: '#A1A1A6', s: '#D1D1D6', t: '#6E6E73' },
    'paper-neutral':   { label: 'Paper',         p: '#b08d57', s: '#d6c1a1', t: '#7d6a52' },
    'midnight-cool':   { label: 'Midnight',      p: '#4f8cff', s: '#56c7ff', t: '#8b5cf6' },
    'sunset-editorial':{ label: 'Sunset',        p: '#d97756', s: '#f59e0b', t: '#e11d48' },
    'studio-teal':     { label: 'Studio Teal',   p: '#0e7c83', s: '#4f5bd5', t: '#7c3aed' },
    'anthropic-warm':  { label: 'Warm',          p: '#d97757', s: '#6a9bcc', t: '#788c5d' },
    'journal-neutral': { label: 'Journal',       p: '#0072B2', s: '#D55E00', t: '#009E73' },
    'kiki-blossom':    { label: 'KIKI Blossom',  p: '#B5277C', s: '#FF375F', t: '#5E5CE6' }
  };
  var ACCENT_ORDER = ['vision-grey','paper-neutral','midnight-cool','sunset-editorial',
                      'studio-teal','anthropic-warm','journal-neutral','kiki-blossom'];

  var FONTS = {
    system:  "-apple-system, BlinkMacSystemFont, 'SF Pro Text', Inter, system-ui, sans-serif",
    inter:   "Inter, system-ui, sans-serif",
    grotesk: "'Space Grotesk', 'Helvetica Neue', sans-serif",
    serif:   "Georgia, 'Times New Roman', serif",
    mono:    "'SF Mono', 'JetBrains Mono', Consolas, monospace"
  };
  var FONT_ORDER = ['system','inter','grotesk','serif','mono'];

  // Background → [light, dark] CSS background values (drives --bg) --------
  var BACKGROUNDS = {
    'plain':        { label: 'Plain',       l: '#eef2f7',
      d: '#111113' },
    'calm':         { label: 'Calm',
      l: 'radial-gradient(1100px 760px at 78% -8%, #F6F8FD, transparent 60%), #E9EEF8',
      d: 'radial-gradient(1100px 760px at 78% -8%, #2c2c2e, transparent 60%), #111113' },
    'vision-grey':  { label: 'Vision Grey',
      l: 'radial-gradient(900px 620px at 12% -6%, #F5F5F7, transparent 60%), linear-gradient(180deg,#ECECEF,#D7D7DC)',
      d: 'radial-gradient(1100px 700px at 78% -8%, rgba(99,102,241,0.10), transparent 60%), radial-gradient(900px 620px at 8% 108%, rgba(20,184,166,0.08), transparent 60%), #0b1220' },
    'nature-clean': { label: 'Clean',       l: '#ffffff', d: '#161617' },
    'cytoplasm':    { label: 'Cytoplasm',
      l: 'linear-gradient(160deg,#FFE4E6,#FFF1F2 45%,#FFF7ED)',
      d: 'linear-gradient(160deg,#2b1115,#1e1112 55%,#140d12)' },
    'kiki':         { label: 'KIKI',
      l: 'linear-gradient(160deg,#FFE7CF,#FFD6E6 38%,#F3DDFF 70%,#D9EEFF)',
      d: 'radial-gradient(1000px 700px at 80% -10%, rgba(181,39,124,0.18), transparent 60%), #14101b' }
  };
  var BG_ORDER = ['vision-grey','calm','plain','nature-clean','cytoplasm','kiki'];

  var MATERIALS = {
    clear:   { label: 'Clear',   blur: '20px', cardAlpha: 0.72 },
    frosted: { label: 'Frosted', blur: '28px', cardAlpha: 0.9 },
    glass:   { label: 'Glass',   blur: '24px', cardAlpha: 0.6 },
    solid:   { label: 'Solid',   blur: '0px',  cardAlpha: 1 }
  };
  var MATERIAL_ORDER = ['clear','frosted','glass','solid'];

  var DEFAULTS = {
    mode: 'dark', uiAccentFamily: 'vision-grey', accent: '#A1A1A6',
    material: 'clear', background: 'vision-grey', uiFont: 'system',
    uiFontSize: 14, cornerRadius: 12
  };

  // helpers --------------------------------------------------------------
  function clamp(n, a, b) { n = +n; if (isNaN(n)) return a; return Math.max(a, Math.min(b, n)); }
  function hexToRgb(h) {
    h = (h || '').replace('#', '');
    if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    var n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbStr(hex) { var c = hexToRgb(hex); return c[0] + ' ' + c[1] + ' ' + c[2]; }
  function lin(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function lum(rgb) { return 0.2126*lin(rgb[0]) + 0.7152*lin(rgb[1]) + 0.0722*lin(rgb[2]); }
  function contrast(a, b) { var la=lum(a), lb=lum(b), hi=Math.max(la,lb), lo=Math.min(la,lb); return (hi+0.05)/(lo+0.05); }
  function readableInk() {
    var cols = [].slice.call(arguments).map(hexToRgb), avg = [0,0,0];
    cols.forEach(function (c) { avg[0]+=c[0]; avg[1]+=c[1]; avg[2]+=c[2]; });
    avg = avg.map(function (x) { return x / cols.length; });
    return contrast(avg, [12,22,38]) >= contrast(avg, [255,255,255]) ? '#0c1626' : '#ffffff';
  }
  function mix(hex, withHex, t) {
    var a = hexToRgb(hex), b = hexToRgb(withHex);
    var r = a.map(function (x, i) { return Math.round(x + (b[i] - x) * t); });
    return 'rgb(' + r[0] + ',' + r[1] + ',' + r[2] + ')';
  }
  function resolveMode(m) {
    if (m === 'system') return (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    return m === 'light' ? 'light' : 'dark';
  }

  function load() {
    var s = null;
    try { s = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}
    var out = {}; for (var k in DEFAULTS) out[k] = DEFAULTS[k];
    if (s && typeof s === 'object') for (var j in s) if (s[j] != null) out[j] = s[j];
    return out;
  }
  function save(patch) {
    var cur = {};
    try { cur = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) {}
    for (var k in patch) cur[k] = patch[k];           // preserve OCS's other fields
    try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch (e) {}
    try { document.dispatchEvent(new CustomEvent(OCS_EVT)); } catch (e) {}
    return cur;
  }

  // apply ----------------------------------------------------------------
  function apply(s) {
    s = s || load();
    var root = document.documentElement, st = root.style;
    var mode = resolveMode(s.mode), dark = mode === 'dark';
    var fam = ACCENTS[s.uiAccentFamily] || ACCENTS['vision-grey'];
    var accent = (s.accent && /^#/.test(s.accent)) ? s.accent : fam.p;
    var mat = MATERIALS[s.material] || MATERIALS.clear;
    var bg = BACKGROUNDS[s.background] || BACKGROUNDS['vision-grey'];

    root.setAttribute('data-mode', mode);
    root.setAttribute('data-theme', s.material || 'clear');
    root.setAttribute('data-bg', s.background || 'vision-grey');
    root.setAttribute('data-accent', s.uiAccentFamily || 'vision-grey');

    // OCS accent tokens
    st.setProperty('--accent', accent);
    st.setProperty('--accent-rgb', rgbStr(accent));
    st.setProperty('--accent-2', fam.s);
    st.setProperty('--accent-3', fam.t);
    st.setProperty('--accent-strong', dark ? mix(accent, '#ffffff', 0.34) : mix(accent, '#000000', 0.18));
    st.setProperty('--accent-gradient', 'linear-gradient(135deg,' + accent + ',' + fam.s + ')');
    st.setProperty('--accent-gradient-active', 'linear-gradient(135deg,' + fam.s + ',' + fam.t + ')');
    st.setProperty('--ink-on-accent', readableInk(accent, fam.s));
    st.setProperty('--tint-accent', 'rgb(' + rgbStr(accent) + ' / ' + (dark ? 0.20 : 0.16) + ')');
    st.setProperty('--tint-accent-line', 'rgb(' + rgbStr(accent) + ' / ' + (dark ? 0.34 : 0.42) + ')');
    st.setProperty('--accent-glow', 'rgb(' + rgbStr(fam.s) + ' / 0.42)');
    st.setProperty('--ink-1', dark ? '#f5f5f7' : '#0c1626');
    st.setProperty('--ink-2', dark ? '#c7c7cc' : '#41526b');
    st.setProperty('--ink-3', dark ? '#8e8e93' : '#6b7c93');

    // typography + radii + material
    st.setProperty('--ui-font', FONTS[s.uiFont] || FONTS.system);
    st.setProperty('--ui-font-size', clamp(s.uiFontSize, 11, 18) + 'px');
    var cr = clamp(s.cornerRadius, 0, 26);
    st.setProperty('--radius-xl', Math.round(cr * 1.6) + 'px');
    st.setProperty('--radius-panel', Math.round(cr * 1.2 + 6) + 'px');
    st.setProperty('--radius-control', Math.max(2, Math.round(cr * 0.9 + 3)) + 'px');
    st.setProperty('--radius-pill', '999px');
    st.setProperty('--glass-blur', mat.blur);

    // ── bridge variables consumed by the vanilla apps ──
    st.setProperty('--font-body', FONTS[s.uiFont] || FONTS.system);
    st.setProperty('--fg', dark ? '#f5f5f7' : '#0c1626');
    st.setProperty('--muted', dark ? '#8e8e93' : '#6e6e73');
    st.setProperty('--bg', dark ? bg.d : bg.l);
    var cardRgb = dark ? '28,28,30' : '255,255,255';
    st.setProperty('--card', mat.cardAlpha >= 1 ? (dark ? '#1c1c1e' : '#ffffff')
                                                : 'rgba(' + cardRgb + ',' + mat.cardAlpha + ')');
    st.setProperty('--border', dark ? 'rgba(255,255,255,0.08)' : 'rgba(13,26,45,0.08)');
    st.setProperty('--border-strong', dark ? 'rgba(255,255,255,0.16)' : 'rgba(13,26,45,0.16)');
    st.setProperty('--primary', dark ? '#f5f5f7' : '#0c1626');
    st.setProperty('--primary-fg', dark ? '#0b1220' : '#ffffff');
    st.setProperty('--primary-light', fam.s);
    st.setProperty('--success', '#16a34a');
    st.setProperty('--error', '#c2334a');

    api._current = s;
    try { document.dispatchEvent(new CustomEvent('reyanda:theme-applied', { detail: s })); } catch (e) {}
  }

  // customizer panel -----------------------------------------------------
  function ensureStyles() {
    if (document.getElementById('rth-style')) return;
    var css =
      '.rth-backdrop{position:fixed;inset:0;background:rgba(0,0,0,0.5);backdrop-filter:blur(4px);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px}' +
      '.rth-modal{width:100%;max-width:440px;max-height:86vh;overflow:auto;background:var(--card,#1c1c1e);color:var(--fg,#f5f5f7);border:1px solid var(--border,rgba(255,255,255,0.1));border-radius:18px;box-shadow:0 24px 70px -24px rgba(0,0,0,0.6);font-family:var(--font-body,system-ui)}' +
      '.rth-head{display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid var(--border,rgba(255,255,255,0.08))}' +
      '.rth-title{font-weight:700;font-size:16px}' +
      '.rth-x{background:none;border:none;color:var(--muted,#8e8e93);font-size:20px;cursor:pointer;line-height:1}' +
      '.rth-body{padding:16px 20px 22px}' +
      '.rth-sec{margin-bottom:18px}' +
      '.rth-label{font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--muted,#8e8e93);margin-bottom:9px}' +
      '.rth-seg{display:flex;flex-wrap:wrap;gap:6px}' +
      '.rth-chip{padding:7px 13px;border-radius:100px;border:1px solid var(--border,rgba(255,255,255,0.1));background:transparent;color:var(--fg,#f5f5f7);font-size:13px;font-family:inherit;cursor:pointer;transition:all .15s}' +
      '.rth-chip:hover{border-color:var(--border-strong,rgba(255,255,255,0.2))}' +
      '.rth-chip.on{background:var(--accent,#A1A1A6);color:var(--ink-on-accent,#0c1626);border-color:transparent;font-weight:600}' +
      '.rth-accs{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}' +
      '.rth-acc{aspect-ratio:1;border-radius:12px;border:2px solid transparent;cursor:pointer;position:relative;overflow:hidden}' +
      '.rth-acc.on{border-color:var(--fg,#f5f5f7)}' +
      '.rth-acc span{position:absolute;left:0;right:0;bottom:0;font-size:9px;text-align:center;padding:2px 1px;background:rgba(0,0,0,0.35);color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.rth-row{display:flex;align-items:center;gap:10px}' +
      '.rth-row input[type=range]{flex:1;accent-color:var(--accent,#A1A1A6)}' +
      '.rth-val{font-size:12px;color:var(--muted,#8e8e93);min-width:42px;text-align:right}';
    var el = document.createElement('style'); el.id = 'rth-style'; el.textContent = css;
    document.head.appendChild(el);
  }

  function chip(label, on, onClick) {
    var b = document.createElement('button');
    b.className = 'rth-chip' + (on ? ' on' : ''); b.textContent = label;
    b.onclick = onClick; return b;
  }
  function section(title, node) {
    var s = document.createElement('div'); s.className = 'rth-sec';
    var l = document.createElement('div'); l.className = 'rth-label'; l.textContent = title;
    s.appendChild(l); s.appendChild(node); return s;
  }

  function openPanel() {
    ensureStyles();
    var s = load();
    var back = document.createElement('div'); back.className = 'rth-backdrop';
    var modal = document.createElement('div'); modal.className = 'rth-modal';
    back.appendChild(modal);
    function close() { if (back.parentNode) back.parentNode.removeChild(back); }
    back.addEventListener('click', function (e) { if (e.target === back) close(); });

    var head = document.createElement('div'); head.className = 'rth-head';
    head.innerHTML = '<div class="rth-title">Appearance</div>';
    var x = document.createElement('button'); x.className = 'rth-x'; x.innerHTML = '&times;'; x.onclick = close;
    head.appendChild(x); modal.appendChild(head);

    var body = document.createElement('div'); body.className = 'rth-body'; modal.appendChild(body);

    function set(patch) { s = save(patch); apply(s); rebuild(); }
    function rebuild() {
      body.innerHTML = '';
      // Mode
      var modeWrap = document.createElement('div'); modeWrap.className = 'rth-seg';
      [['light','Light'],['dark','Dark'],['system','System']].forEach(function (m) {
        modeWrap.appendChild(chip(m[1], s.mode === m[0], function () { set({ mode: m[0] }); }));
      });
      body.appendChild(section('Mode', modeWrap));
      // Accent families
      var accs = document.createElement('div'); accs.className = 'rth-accs';
      ACCENT_ORDER.forEach(function (id) {
        var f = ACCENTS[id];
        var a = document.createElement('button');
        a.className = 'rth-acc' + (s.uiAccentFamily === id ? ' on' : '');
        a.style.background = 'linear-gradient(135deg,' + f.p + ',' + f.s + ')';
        a.title = f.label;
        a.innerHTML = '<span>' + f.label + '</span>';
        a.onclick = function () { set({ uiAccentFamily: id, accent: f.p }); };
        accs.appendChild(a);
      });
      body.appendChild(section('Accent', accs));
      // Material
      var matWrap = document.createElement('div'); matWrap.className = 'rth-seg';
      MATERIAL_ORDER.forEach(function (id) {
        matWrap.appendChild(chip(MATERIALS[id].label, s.material === id, function () { set({ material: id }); }));
      });
      body.appendChild(section('Material', matWrap));
      // Background
      var bgWrap = document.createElement('div'); bgWrap.className = 'rth-seg';
      BG_ORDER.forEach(function (id) {
        bgWrap.appendChild(chip(BACKGROUNDS[id].label, s.background === id, function () { set({ background: id }); }));
      });
      body.appendChild(section('Background', bgWrap));
      // Font
      var fWrap = document.createElement('div'); fWrap.className = 'rth-seg';
      FONT_ORDER.forEach(function (id) {
        fWrap.appendChild(chip(id.charAt(0).toUpperCase() + id.slice(1), s.uiFont === id, function () { set({ uiFont: id }); }));
      });
      body.appendChild(section('Font', fWrap));
      // Font size
      var fs = document.createElement('div'); fs.className = 'rth-row';
      var fsR = document.createElement('input'); fsR.type = 'range'; fsR.min = 11; fsR.max = 18; fsR.step = 1; fsR.value = s.uiFontSize;
      var fsV = document.createElement('div'); fsV.className = 'rth-val'; fsV.textContent = s.uiFontSize + 'px';
      fsR.oninput = function () { fsV.textContent = fsR.value + 'px'; };
      fsR.onchange = function () { set({ uiFontSize: +fsR.value }); };
      fs.appendChild(fsR); fs.appendChild(fsV);
      body.appendChild(section('Text size', fs));
      // Corners
      var co = document.createElement('div'); co.className = 'rth-row';
      var coR = document.createElement('input'); coR.type = 'range'; coR.min = 0; coR.max = 24; coR.step = 1; coR.value = s.cornerRadius;
      var coV = document.createElement('div'); coV.className = 'rth-val'; coV.textContent = s.cornerRadius + 'px';
      coR.oninput = function () { coV.textContent = coR.value + 'px'; };
      coR.onchange = function () { set({ cornerRadius: +coR.value }); };
      co.appendChild(coR); co.appendChild(coV);
      body.appendChild(section('Corners', co));
    }
    rebuild();
    document.body.appendChild(back);
  }

  // boot -----------------------------------------------------------------
  var api = {
    apply: function () { apply(load()); },
    get: load,
    set: function (patch) { var s = save(patch); apply(s); return s; },
    openPanel: openPanel,
    accents: ACCENTS,
    _current: null
  };
  window.ReyandaTheme = api;

  apply(load());
  // live cross-app + cross-tab sync
  window.addEventListener('storage', function (e) { if (e.key === KEY) apply(load()); });
  document.addEventListener(OCS_EVT, function () { apply(load()); });
  if (window.matchMedia) {
    try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { apply(load()); }); } catch (e) {}
  }
})();
