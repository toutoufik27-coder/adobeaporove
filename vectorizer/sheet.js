/*
 * Icon sheet: builds a stock-ready "icon set" presentation sheet (SVG / PNG)
 * from the separate icons found by the vectorizer.
 *
 * Reads the app state that app.js exposes as window.VectorizerState and never
 * modifies it. In the downloaded SVG every <text> is converted to <path>
 * (opentype.js + Inter, loaded on demand from fonts/), as Adobe Stock requires.
 */
(function () {
  'use strict';

  const BRAND = { cobalt: '#155EEF', blue: '#2E90FA', cyan: '#12B8D4', navy: '#102A43', pale: '#E8F3FF', off: '#F8FAFC', white: '#FFFFFF' };
  // Second mapping for the big icon on the cobalt panel.
  const HERO = { navy: 'white', white: 'white', pale: 'white', blue: 'cyan', cyan: 'cyan', cobalt: 'navy' };
  const RATIOS = { '4:3': [4, 3], '16:9': [16, 9], '3:2': [3, 2], '1:1': [1, 1], '4:5': [4, 5] };
  const W = 2400;
  const TITLE_FAMILY = "'Segoe UI', Arial, sans-serif";
  const LABEL_FAMILY = "Inter, 'Segoe UI', sans-serif";
  const OPENTYPE_SRC = ['fonts/opentype.min.js', 'https://cdn.jsdelivr.net/npm/opentype.js@1.3.4/dist/opentype.min.js'];
  const FONT_SRC = {
    title: ['fonts/Inter-Bold.woff', 'https://cdn.jsdelivr.net/npm/@fontsource/inter@5.3.0/files/inter-latin-700-normal.woff'],
    label: ['fonts/Inter-SemiBold.woff', 'https://cdn.jsdelivr.net/npm/@fontsource/inter@5.3.0/files/inter-latin-600-normal.woff'],
  };
  const SVGNS = 'http://www.w3.org/2000/svg';

  const $ = (id) => document.getElementById(id);
  const num = (v) => Math.round(v * 100) / 100;
  const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

  // ---------------------------------------------------------------------------
  // 1. Icons from the vectorizer result
  // ---------------------------------------------------------------------------
  // A shape belongs to an icon when the centre of its box lies inside the
  // icon's box (same rule as toSVG with crop). Shapes are kept in layer order,
  // one path per layer colour.
  function extractIcons(result, overrides) {
    const icons = [];
    const area = new Map(); // colour -> summed box area of its shapes
    for (const b of result.objects || []) {
      // safety net: a shape much larger than the icon (e.g. a traced
      // background region) is never part of it
      const m = Math.max(b.w, b.h) * 0.25;
      const paths = [];
      for (const layer of result.layers || []) {
        const fill = (overrides && overrides[layer.color]) || layer.color;
        let d = '';
        for (const q of layer.parts || []) {
          const [x0, y0, x1, y1] = q.box;
          const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
          if (cx < b.x || cx > b.x + b.w || cy < b.y || cy > b.y + b.h) continue;
          if (x0 < b.x - m || y0 < b.y - m || x1 > b.x + b.w + m || y1 > b.y + b.h + m) continue;
          d += q.d;
          area.set(fill, (area.get(fill) || 0) + (x1 - x0) * (y1 - y0));
        }
        if (d) paths.push({ d, fill });
      }
      if (paths.length) icons.push({ x: b.x, y: b.y, w: b.w, h: b.h, paths });
    }
    return { icons, area };
  }

  // ---------------------------------------------------------------------------
  // 2. Brand colours (Signature Cobalt)
  // ---------------------------------------------------------------------------
  function hexRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    const n = m ? parseInt(m[1], 16) : 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function linear(c) {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function luminance(rgb) {
    return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
  }
  function hsv(rgb) {
    const [r, g, b] = rgb, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h, s: mx ? d / mx : 0 };
  }
  // original colour -> brand key
  function brandMap(area, tiles) {
    const map = {}, mid = [];
    for (const c of area.keys()) {
      const rgb = hexRgb(c), L = luminance(rgb), { h, s } = hsv(rgb);
      if (L < 0.05) map[c] = 'navy';
      else if (h >= 165 && h <= 200 && s > 0.55 && L > 0.2) map[c] = 'cyan';
      else if (L >= 0.7) map[c] = tiles ? 'white' : 'pale';
      else if (L >= 0.4) map[c] = 'blue';
      else mid.push([c, L]);
    }
    if (mid.length) {
      // the mid tone with the largest area is the reference; clearly lighter ones become blue
      const Ld = mid.reduce((a, b) => (area.get(b[0]) > area.get(a[0]) ? b : a))[1];
      for (const [c, L] of mid) map[c] = L > Ld * 1.6 ? 'blue' : 'cobalt';
    }
    return map;
  }

  // ---------------------------------------------------------------------------
  // 3. Sheet template (all sizes relative to W / H)
  // ---------------------------------------------------------------------------
  function wrapWords(text, maxChars, maxLines) {
    const lines = [];
    let cur = '';
    for (let w of text.split(/\s+/).filter(Boolean)) {
      while (w.length > maxChars) { // hard-break a word that is longer than a line
        if (cur) { lines.push(cur); cur = ''; }
        lines.push(w.slice(0, maxChars));
        w = w.slice(maxChars);
      }
      if (!w) continue;
      if (!cur) cur = w;
      else if (cur.length + 1 + w.length <= maxChars) cur += ' ' + w;
      else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    if (lines.length <= maxLines) return lines;
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].slice(0, Math.max(1, maxChars - 1)) + '…';
    return kept;
  }

  function iconGroup(icon, ax, ay, size, fillOf) {
    const sc = size / Math.max(icon.w, icon.h);
    const ox = ax + (size - icon.w * sc) / 2, oy = ay + (size - icon.h * sc) / 2;
    return `<g transform="translate(${num(ox)} ${num(oy)}) scale(${+sc.toFixed(5)}) translate(${num(-icon.x)} ${num(-icon.y)})">` +
      icon.paths.map((p) => `<path fill="${fillOf(p.fill)}" fill-rule="evenodd" d="${p.d}"/>`).join('') + '</g>';
  }

  function textEl(str, x, y, size, o) {
    return `<text data-font="${o.font}" x="${num(x)}" y="${num(y)}" font-family="${xml(o.family)}" font-size="${num(size)}" ` +
      `font-weight="${o.weight}"${o.ls ? ` letter-spacing="${num(o.ls)}"` : ''} text-anchor="middle" fill="${o.fill}">${xml(str)}</text>`;
  }

  function buildSheet(data, o) {
    const { icons, area } = data;
    const N = icons.length;
    const [rw, rh] = RATIOS[o.ratio] || RATIOS['4:3'];
    const H = Math.round(W * rh / rw);
    const pw = Math.round(W * 0.27);
    const left = o.side !== 'right';
    const px = left ? 0 : W - pw, pcx = px + pw / 2;
    const map = o.brand ? brandMap(area, o.tiles) : null;
    const fillOf = (c) => (map ? BRAND[map[c] || 'cobalt'] : c);
    const heroOf = (c) => (map ? BRAND[HERO[map[c] || 'cobalt']] : c);

    const fs = Math.min(pw * 0.095, H * 0.06);
    const bandH = Math.max(H * 0.13, fs * 1.9);
    // artboard of about 16 MP for Adobe Stock; the drawing itself stays 2400 units wide
    const [SW, SH] = window.VectorizerEngine ? window.VectorizerEngine.stockSize(W, H, 16) : [W, H];
    const out = [`<svg xmlns="${SVGNS}" viewBox="0 0 ${W} ${H}" width="${SW}" height="${SH}">`];
    out.push(`<rect width="${W}" height="${H}" fill="${BRAND.off}"/>`);

    // side panel
    out.push(`<rect x="${px}" y="0" width="${pw}" height="${H}" fill="${BRAND.cobalt}"/>`);
    out.push(`<rect x="${px}" y="${num(H - bandH)}" width="${pw}" height="${num(bandH)}" fill="${BRAND.navy}"/>`);
    out.push(`<rect x="${left ? pw - 10 : px}" y="0" width="10" height="${H}" fill="${BRAND.cyan}"/>`);

    // big icon
    const heroSize = Math.min(pw * 0.5, H * 0.3);
    const hero = icons[Math.min(N, Math.max(1, o.hero | 0)) - 1];
    out.push(iconGroup(hero, pcx - heroSize / 2, H * 0.1, heroSize, heroOf));

    // title
    const maxChars = Math.max(1, Math.floor(pw * 0.82 / (fs * 0.6)));
    const lines = wrapWords(o.title.toUpperCase(), maxChars, 4);
    const y0 = H * 0.1 + heroSize + fs * 1.9;
    const title = { font: 'title', family: TITLE_FAMILY, weight: 700, fill: BRAND.white };
    lines.forEach((ln, i) => out.push(textEl(ln, pcx, y0 + i * fs * 1.12, fs, title)));
    const lastY = y0 + Math.max(0, lines.length - 1) * fs * 1.12;

    // accent bar + "ICON SET" capsule
    const barW = pw * 0.18, barY = lastY + fs * 0.75;
    out.push(`<rect x="${num(pcx - barW / 2)}" y="${num(barY)}" width="${num(barW)}" height="8" rx="4" fill="${BRAND.cyan}"/>`);
    const capW = pw * 0.56, capH = fs * 1.15, capY = barY + 8 + fs * 0.7;
    out.push(`<rect x="${num(pcx - capW / 2)}" y="${num(capY)}" width="${num(capW)}" height="${num(capH)}" rx="${num(capH / 2)}" fill="${BRAND.white}"/>`);
    const cs = fs * 0.62;
    out.push(textEl('ICON SET', pcx, capY + capH / 2 + cs * 0.36, cs, { ...title, fill: BRAND.cobalt, ls: fs * 0.06 }));

    // "EDITABLE" band
    const es = fs * 1.02;
    out.push(textEl('EDITABLE', pcx, H - bandH / 2 + es * 0.36, es, { ...title, ls: fs * 0.08 }));

    // icon grid in the remaining area
    const pad = Math.round(W * 0.03);
    const gx = (left ? pw : 0) + pad, gy = pad, gw = W - pw - 2 * pad, gh = H - 2 * pad;
    const names = o.names.split('\n').map((s) => s.trim()).slice(0, N);
    const k = names.some(Boolean) ? 1.3 : 1.05;
    const cols = o.cols > 0 ? [Math.min(o.cols | 0, N)] : Array.from({ length: N }, (_, i) => i + 1);
    let best = { s: -1, c: 1 };
    for (const c of cols) {
      const s = Math.min(gw / c, gh / Math.ceil(N / c) / k);
      if (s > best.s) best = { s, c };
    }
    const { s, c } = best, r = Math.ceil(N / c), cellH = s * k;
    const ox = gx + (gw - c * s) / 2, oy = gy + (gh - r * cellH) / 2;
    const tile = s * 0.8, ls = Math.max(14, s * 0.085);
    const label = { font: 'label', family: LABEL_FAMILY, weight: 600, fill: BRAND.navy };
    icons.forEach((ic, i) => {
      const cx = ox + (i % c) * s + s / 2;
      const top = oy + Math.floor(i / c) * cellH + (s - tile) / 2;
      if (o.tiles) {
        out.push(`<rect x="${num(cx - tile / 2)}" y="${num(top)}" width="${num(tile)}" height="${num(tile)}" rx="${num(tile * 0.2)}" fill="${BRAND.pale}"/>`);
        const is = tile * 0.62;
        out.push(iconGroup(ic, cx - is / 2, top + tile * 0.19, is, fillOf));
      } else {
        const is = tile * 0.84;
        out.push(iconGroup(ic, cx - is / 2, top + tile * 0.08, is, fillOf));
      }
      if (names[i]) out.push(textEl(names[i].toUpperCase(), cx, top + tile + ls * 1.55, ls, label));
    });

    out.push('</svg>');
    return { svg: out.join('\n'), W, H, cols: c };
  }

  // ---------------------------------------------------------------------------
  // 5. <text> -> <path> for the downloaded SVG (opentype.js, loaded on demand)
  // ---------------------------------------------------------------------------
  let opentypeReady = null;
  const fonts = {};
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { s.remove(); reject(new Error('cannot load ' + src)); };
      document.head.appendChild(s);
    });
  }
  function loadOpentype() {
    if (window.opentype) return Promise.resolve(window.opentype);
    if (!opentypeReady) {
      opentypeReady = (async () => {
        for (const src of OPENTYPE_SRC) {
          try { await loadScript(src); if (window.opentype) return window.opentype; } catch (_) { /* try next */ }
        }
        throw new Error('opentype.js unavailable');
      })().catch((e) => { opentypeReady = null; throw e; });
    }
    return opentypeReady;
  }
  async function loadFont(key) {
    if (fonts[key]) return fonts[key];
    const ot = await loadOpentype();
    for (const url of FONT_SRC[key]) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        fonts[key] = ot.parse(await res.arrayBuffer());
        return fonts[key];
      } catch (_) { /* try next */ }
    }
    throw new Error('font unavailable: ' + key);
  }
  async function textToPaths(svg) {
    const f = { title: await loadFont('title'), label: await loadFont('label') };
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    for (const t of Array.from(doc.getElementsByTagName('text'))) {
      const font = f[t.getAttribute('data-font')] || f.title;
      const size = parseFloat(t.getAttribute('font-size')) || 16;
      const ls = parseFloat(t.getAttribute('letter-spacing')) || 0;
      const x = parseFloat(t.getAttribute('x')) || 0, y = parseFloat(t.getAttribute('y')) || 0;
      const anchor = t.getAttribute('text-anchor') || 'start';
      const glyphs = font.stringToGlyphs(t.textContent || '');
      const scale = size / font.unitsPerEm;
      const adv = glyphs.map((g, i) => ((g.advanceWidth || 0) + (i < glyphs.length - 1 ? font.getKerningValue(g, glyphs[i + 1]) : 0)) * scale);
      const width = adv.reduce((a, b) => a + b, 0) + ls * Math.max(0, glyphs.length - 1);
      let pen = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x;
      let d = '';
      glyphs.forEach((g, i) => { d += g.getPath(pen, y, size).toPathData(2); pen += adv[i] + ls; });
      if (d) {
        const p = doc.createElementNS(SVGNS, 'path');
        p.setAttribute('fill', t.getAttribute('fill') || '#000000');
        p.setAttribute('d', d);
        t.parentNode.replaceChild(p, t);
      } else {
        t.parentNode.removeChild(t);
      }
    }
    return new XMLSerializer().serializeToString(doc);
  }

  // ---------------------------------------------------------------------------
  // 4. Interface
  // ---------------------------------------------------------------------------
  const opts = { title: '', ratio: '4:3', side: 'left', hero: 1, cols: 0, brand: true, tiles: true, names: '' };
  let data = null, sourceKey = null, previewUrl = null, lastFocus = null;

  function defaultTitle(name) {
    return String(name || '')
      .replace(/\.[a-z0-9]{2,5}$/i, '')
      .replace(/\d{5,}/g, ' ')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
  }

  function buildModal() {
    const el = document.createElement('div');
    el.className = 'sheet-modal';
    el.id = 'sheetModal';
    el.hidden = true;
    el.innerHTML = `
      <div class="sheet-box" role="dialog" aria-modal="true" aria-labelledby="sheetHeading">
        <aside class="sheet-side">
          <div class="sheet-head">
            <h2 id="sheetHeading">لوحة أيقونات</h2>
            <button type="button" class="sheet-close" id="shClose" aria-label="إغلاق">×</button>
          </div>
          <p class="sheet-count" id="shCount"></p>
          <div class="sheet-field">
            <label for="shTitle">العنوان (بالإنجليزية، 40 حرفاً كحد أقصى)</label>
            <input type="text" id="shTitle" maxlength="40" dir="ltr" autocomplete="off">
          </div>
          <div class="sheet-pair">
            <div class="sheet-field">
              <label for="shRatio">المقاس</label>
              <select id="shRatio">${Object.keys(RATIOS).map((r) => `<option value="${r}">${r}</option>`).join('')}</select>
            </div>
            <div class="sheet-field">
              <label for="shSide">جهة اللوحة</label>
              <select id="shSide"><option value="left">يسار</option><option value="right">يمين</option></select>
            </div>
          </div>
          <div class="sheet-pair">
            <div class="sheet-field">
              <label for="shHero">الأيقونة الكبيرة</label>
              <input type="number" id="shHero" min="1" step="1" value="1" dir="ltr">
            </div>
            <div class="sheet-field">
              <label for="shCols">الأعمدة (0 = تلقائي)</label>
              <input type="number" id="shCols" min="0" step="1" value="0" dir="ltr">
            </div>
          </div>
          <label class="check"><input type="checkbox" id="shBrand" checked> تلوين بألوان البراند</label>
          <label class="check"><input type="checkbox" id="shTiles" checked> مربعات خلف الأيقونات</label>
          <div class="sheet-field">
            <label for="shNames">أسماء الأيقونات: سطر لكل أيقونة بنفس الترتيب</label>
            <textarea id="shNames" rows="7" dir="ltr" spellcheck="false"></textarea>
          </div>
          <p class="sheet-warn" id="shWarn" hidden>الخط يدعم الحروف اللاتينية فقط؛ اكتب العنوان والأسماء بالإنجليزية.</p>
          <div class="actions">
            <button type="button" class="btn primary" id="shSvg">تنزيل SVG</button>
            <button type="button" class="btn" id="shPng">تنزيل PNG</button>
          </div>
          <p class="note" id="shInfo"></p>
        </aside>
        <div class="sheet-view" id="shView"></div>
      </div>`;
    document.body.appendChild(el);

    el.addEventListener('mousedown', (e) => { if (e.target === el) close(); });
    $('shClose').addEventListener('click', close);
    const bind = (id, key, read) => {
      $(id).addEventListener(id === 'shRatio' || id === 'shSide' || $(id).type === 'checkbox' ? 'change' : 'input', () => { opts[key] = read($(id)); render(); });
    };
    bind('shTitle', 'title', (i) => i.value);
    bind('shRatio', 'ratio', (i) => i.value);
    bind('shSide', 'side', (i) => i.value);
    bind('shHero', 'hero', (i) => parseInt(i.value, 10) || 1);
    bind('shCols', 'cols', (i) => Math.max(0, parseInt(i.value, 10) || 0));
    bind('shBrand', 'brand', (i) => i.checked);
    bind('shTiles', 'tiles', (i) => i.checked);
    bind('shNames', 'names', (i) => i.value);
    $('shSvg').addEventListener('click', downloadSVG);
    $('shPng').addEventListener('click', downloadPNG);
    return el;
  }

  function syncInputs() {
    const n = data ? data.icons.length : 0;
    $('shTitle').value = opts.title;
    $('shRatio').value = opts.ratio;
    $('shSide').value = opts.side;
    $('shHero').max = Math.max(1, n);
    $('shHero').value = opts.hero;
    $('shCols').max = Math.max(0, n);
    $('shCols').value = opts.cols;
    $('shBrand').checked = opts.brand;
    $('shTiles').checked = opts.tiles;
    $('shNames').value = opts.names;
    $('shNames').placeholder = Array.from({ length: Math.min(n, 30) }, (_, i) => `Icon ${i + 1}`).join('\n');
  }

  function current() {
    const n = data.icons.length;
    return { ...opts, hero: Math.min(n, Math.max(1, opts.hero)), cols: Math.min(n, Math.max(0, opts.cols)) };
  }

  function render() {
    const view = $('shView');
    const ok = data && data.icons.length >= 2;
    $('shSvg').disabled = !ok;
    $('shPng').disabled = !ok;
    $('shCount').textContent = data ? `عدد الأيقونات: ${data.icons.length}` : '';
    $('shWarn').hidden = !/[^ -ɏ -⁯\n\r\t]/.test(opts.title + opts.names);
    if (!ok) {
      view.innerHTML = '<p class="sheet-empty">لم أجد أيقونات منفصلة في هذه الصورة</p>';
      $('shInfo').textContent = '';
      return;
    }
    const sheet = buildSheet(data, current());
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(new Blob([sheet.svg], { type: 'image/svg+xml' }));
    let img = view.querySelector('img');
    if (!img) {
      view.innerHTML = '';
      img = document.createElement('img');
      img.alt = 'معاينة لوحة الأيقونات';
      view.appendChild(img);
    }
    img.src = previewUrl;
    img.dataset.size = `${sheet.W}x${sheet.H}`;
    $('shInfo').textContent = `${sheet.W} × ${sheet.H} بكسل — ${sheet.cols} أعمدة`;
  }

  function fileBase() {
    const t = (opts.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return (t || 'icons') + '-icon-sheet';
  }
  function save(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }
  async function downloadSVG() {
    if (!data || data.icons.length < 2) return;
    const btn = $('shSvg'), label = btn.textContent;
    const { svg } = buildSheet(data, current());
    btn.disabled = true;
    btn.textContent = 'جارٍ تحويل النص…';
    let out = svg, converted = true;
    try {
      out = await textToPaths(svg);
    } catch (_) {
      converted = false;
      out = svg;
    }
    save(new Blob([out], { type: 'image/svg+xml' }), fileBase() + '.svg');
    btn.disabled = false;
    btn.textContent = label;
    if (!converted) alert('النص لم يُحوَّل إلى paths');
  }
  function downloadPNG() {
    if (!data || data.icons.length < 2) return;
    const { svg, W: w, H: h } = buildSheet(data, current());
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      c.toBlob((b) => save(b, fileBase() + '.png'), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); alert('تعذّر إنشاء ملف PNG.'); };
    img.src = url;
  }

  function onKey(e) { if (e.key === 'Escape') close(); }

  function open() {
    const st = window.VectorizerState;
    if (!st || !st.result) return;
    const modal = $('sheetModal') || buildModal();
    data = extractIcons(st.result, st.colorOverrides);
    const key = st.source ? st.source.url : '';
    if (key !== sourceKey) { // new image: fresh defaults
      sourceKey = key;
      Object.assign(opts, { title: defaultTitle(st.source && st.source.name), hero: 1, cols: 0, names: '' });
    }
    // names typed in the editor fill the sheet when it has none of its own
    const given = (st.names || []).join('\n');
    if (given.trim() && (!opts.names.trim() || opts.names === opts.fromEditor)) opts.names = given;
    opts.fromEditor = given;
    syncInputs();
    render();
    lastFocus = document.activeElement;
    modal.hidden = false;
    document.documentElement.classList.add('sheet-open');
    document.addEventListener('keydown', onKey);
    $('shTitle').focus();
  }
  function close() {
    const modal = $('sheetModal');
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.documentElement.classList.remove('sheet-open');
    document.removeEventListener('keydown', onKey);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  const openBtn = $('openSheet');
  if (openBtn) openBtn.addEventListener('click', open);

  // exposed for tests / other scripts
  window.IconSheet = { open, close, extractIcons, brandMap, buildSheet, textToPaths, defaultTitle };
})();
