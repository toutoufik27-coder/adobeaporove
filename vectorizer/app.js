(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const MAX_WORK = 2600;  // largest side processed (bigger images are downscaled); 2x upscales of Flow images fit
  const STOCK_MP = 16;    // exported artboards: Adobe Stock recommends about 15 MP

  const PRESETS = {
    logo:         { mode: 'color', colors: 12, detail: 6, smooth: 4, corners: 7, speckle: 4, cleanEdges: true, removeBg: true, holes: true },
    illustration: { mode: 'color', colors: 24, detail: 7, smooth: 4, corners: 6, speckle: 3, cleanEdges: true, removeBg: true, holes: true },
    photo:        { mode: 'color', colors: 32, detail: 5, smooth: 4, corners: 3, speckle: 5, cleanEdges: false },
    bw:           { mode: 'bw',    colors: 2,  detail: 6, smooth: 4, corners: 7, speckle: 4, cleanEdges: false },
  };

  const state = {
    preset: 'logo',
    mode: 'color',
    source: null,       // { w, h, name, url }
    work: null,         // { rgba, w, h, scale }
    result: null,
    colorOverrides: {},
    view: 'split',
    split: 0.5,
    zoom: { s: 1, x: 0, y: 0 },
    jobId: 0,
    svgUrl: null,
    outlineUrl: null,
  };
  window.VectorizerState = state; // read-only access for sheet.js (icon sheet)

  // ---------------------------------------------------------------------------
  // Worker
  // ---------------------------------------------------------------------------
  let worker = null;
  let workerBusy = false;
  function getWorker() {
    if (!worker) {
      worker = new Worker('worker.js?v=20');
      worker.onmessage = onWorkerMessage;
      worker.onerror = (e) => { workerBusy = false; showBusy(false); alert('حدث خطأ أثناء التحويل: ' + e.message); };
    }
    return worker;
  }

  function onWorkerMessage(e) {
    const msg = e.data;
    if (msg.id !== state.jobId) return;
    if (msg.type === 'progress') {
      const labels = { quantize: 'تحليل الألوان…', clean: 'تنظيف الضوضاء…', trace: 'رسم المنحنيات…', done: 'اكتمل' };
      $('busyText').textContent = labels[msg.stage] || 'جارٍ التحويل…';
      $('busyBar').style.width = Math.round(msg.progress * 100) + '%';
      return;
    }
    workerBusy = false;
    showBusy(false);
    if (msg.type === 'error') { alert('تعذّر التحويل: ' + msg.message); return; }
    state.result = msg.result;
    state.colorOverrides = {};
    renderResult();
  }

  // Engine options from the current settings (also used by batch.js).
  function buildOptions(w, h, scale) {
    const s = readSettings();
    const area = (w * h) / 1e6;
    // Large images (2000 px Flow exports, upscales): JPEG noise wobbles every edge by
    // about a pixel, so curves may deviate a little more and the outline is smoothed
    // more before fitting. Small images keep the fine settings.
    const k = Math.max(1, Math.max(w, h) / 1200);
    return {
      mode: s.mode,
      colors: s.colors,
      tolerance: +(1.2 * Math.pow(0.87, s.detail - 1) * Math.min(k, 1.8)).toFixed(3),
      smooth: s.smooth * 0.2,
      cornerAngle: 100 - s.corners * 6,
      minArea: Math.round((s.speckle * s.speckle * 0.9 + (s.speckle ? 1 : 0)) * Math.max(0.5, area)),
      cleanEdges: s.cleanEdges,
      removeBackground: s.removeBg,
      clearHoles: s.removeBg && s.holes,            // background inside shapes -> transparent
      regularize: Math.round(s.smooth * 0.5 + (s.smooth ? (k - 1) * 12 : 0)),   // geometric smoothing passes
      snapAxis: state.preset !== 'photo',           // exact horizontal / vertical lines
      mergeDist: state.preset === 'photo' ? 3 : 6,  // merge near-identical shades
      removeRules: state.preset !== 'photo',        // drop grid / divider lines
      mergeSoft: state.preset !== 'photo',          // gradients are one surface, not blotches
      snapColors: state.preset !== 'photo' && s.mode !== 'bw' && $('snapPal').checked ? linkColors() : null,
      snapExact: false,   // shades are merged, but drawn in the image's real colour (closest to the original)
      outScale: 1 / scale,
    };
  }
  window.VectorizerApp = { buildOptions, maxWork: MAX_WORK, stockMP: STOCK_MP, parseNames, setNames, setLink, readLink, promptLabel, metaFor, csvText, objectNames, iconSVG };

  function runVectorize() {
    if (!state.work) return;
    if (workerBusy && worker) { worker.terminate(); worker = null; } // drop the stale job
    const { rgba, w, h, scale } = state.work;
    const options = buildOptions(w, h, scale);
    state.jobId++;
    workerBusy = true;
    showBusy(true);
    const copy = new Uint8ClampedArray(rgba);
    getWorker().postMessage({ id: state.jobId, rgba: copy, width: w, height: h, options }, [copy.buffer]);
  }

  let debounceT = 0;
  function scheduleRun() {
    clearTimeout(debounceT);
    debounceT = setTimeout(runVectorize, 350);
  }

  // ---------------------------------------------------------------------------
  // Settings UI
  // ---------------------------------------------------------------------------
  const sliders = ['colors', 'detail', 'smooth', 'corners', 'speckle'];

  function applyPreset(name) {
    const p = PRESETS[name];
    state.preset = name;
    state.mode = p.mode;
    for (const k of sliders) $(k).value = p[k];
    $('cleanEdges').checked = p.cleanEdges;
    $('removeBg').checked = !!p.removeBg;
    $('clearHoles').checked = !!p.holes;
    document.querySelectorAll('#presets button').forEach((b) => b.classList.toggle('on', b.dataset.preset === name));
    $('colorsField').style.display = p.mode === 'bw' ? 'none' : '';
    updateOutputs();
  }

  function readSettings() {
    const s = { mode: state.mode, cleanEdges: $('cleanEdges').checked, removeBg: $('removeBg').checked, holes: $('clearHoles').checked };
    for (const k of sliders) s[k] = +$(k).value;
    return s;
  }

  function updateOutputs() {
    for (const k of sliders) $(k + 'Out').textContent = $(k).value;
  }

  document.querySelectorAll('#presets button').forEach((b) => {
    b.addEventListener('click', () => { applyPreset(b.dataset.preset); scheduleRun(); });
  });
  for (const k of sliders) {
    $(k).addEventListener('input', () => { updateOutputs(); scheduleRun(); });
  }
  $('cleanEdges').addEventListener('change', scheduleRun);
  $('removeBg').addEventListener('change', scheduleRun);
  $('clearHoles').addEventListener('change', scheduleRun);

  // ---------------------------------------------------------------------------
  // Loading images
  // ---------------------------------------------------------------------------
  function loadImageFromUrl(url, name) {
    const img = new Image();
    img.onload = () => prepareImage(img, url, name);
    img.onerror = () => alert('تعذّر قراءة هذه الصورة.');
    img.src = url;
  }

  function loadFile(file) {
    if (!file || !file.type.startsWith('image/')) { alert('الرجاء اختيار ملف صورة.'); return; }
    if (state.source && state.source.url.startsWith('blob:')) URL.revokeObjectURL(state.source.url);
    loadImageFromUrl(URL.createObjectURL(file), file.name.replace(/\.[^.]+$/, ''));
  }

  function prepareImage(img, url, name) {
    const w = img.naturalWidth, h = img.naturalHeight;
    const maxSide = Math.max(w, h);
    let scale = 1;
    if (maxSide > MAX_WORK) scale = MAX_WORK / maxSide;
    const ww = Math.max(1, Math.round(w * scale)), wh = Math.max(1, Math.round(h * scale));
    const c = document.createElement('canvas');
    c.width = ww; c.height = wh;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, ww, wh);
    const data = ctx.getImageData(0, 0, ww, wh).data;
    state.source = { w, h, name: name || 'vector', url };
    state.work = { rgba: data, w: ww, h: wh, scale: ww / w };
    state.result = null;
    state.link = -1;
    setNames([], true);

    $('drop').hidden = true;
    $('viewer').hidden = false;
    $('imgOriginal').src = url;
    $('imgVector').removeAttribute('src');
    $('stage').style.width = w + 'px';
    $('stage').style.height = h + 'px';
    $('stage').classList.toggle('pixelated', maxSide < 256);
    setActions(false);
    requestAnimationFrame(() => { fitView(); runVectorize(); });
  }

  $('file').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
  const drop = $('drop');
  drop.addEventListener('click', (e) => { if (e.target.id !== 'demoBtn') $('file').click(); });
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('hover'); }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('hover'); }));
  document.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) loadFile(f); });
  document.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData ? e.clipboardData.items : [])].find((i) => i.type.startsWith('image/'));
    if (item) loadFile(item.getAsFile());
  });

  $('demoBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const c = document.createElement('canvas');
    c.width = 640; c.height = 420;
    const g = c.getContext('2d');
    g.fillStyle = '#f7f3ea'; g.fillRect(0, 0, 640, 420);
    g.fillStyle = '#f2b134'; g.beginPath(); g.arc(200, 190, 120, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#1f2a44'; g.beginPath(); g.arc(160, 160, 16, 0, Math.PI * 2); g.arc(240, 160, 16, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#1f2a44'; g.lineWidth = 14; g.lineCap = 'round';
    g.beginPath(); g.arc(200, 200, 70, 0.2 * Math.PI, 0.8 * Math.PI); g.stroke();
    g.fillStyle = '#2f6bff'; g.beginPath(); g.moveTo(380, 330); g.lineTo(470, 90); g.lineTo(560, 330); g.closePath(); g.fill();
    g.fillStyle = '#f7f3ea'; g.fillRect(440, 230, 60, 60);
    g.fillStyle = '#e4572e'; g.font = 'bold 54px sans-serif'; g.fillText('SVG', 90, 390);
    loadImageFromUrl(c.toDataURL('image/png'), 'demo');
  });

  // ---------------------------------------------------------------------------
  // Rendering result
  // ---------------------------------------------------------------------------
  function currentSVG(outline) {
    return VectorizerEngine.toSVG(state.result, { outline, anchors: outline && state.anchors, colors: state.colorOverrides, minMP: outline ? 0 : STOCK_MP });
  }

  function renderResult() {
    const r = state.result;
    if (state.svgUrl) URL.revokeObjectURL(state.svgUrl);
    if (state.outlineUrl) URL.revokeObjectURL(state.outlineUrl);
    const svg = currentSVG(false);
    state.svgUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    state.outlineUrl = URL.createObjectURL(new Blob([currentSVG(true)], { type: 'image/svg+xml' }));
    applyView();

    // palette
    const colors = [];
    if (r.background) colors.push(r.background);
    r.layers.forEach((l) => { if (!colors.includes(l.color)) colors.push(l.color); });
    const pal = $('palette');
    pal.innerHTML = '';
    colors.forEach((c) => {
      const sw = document.createElement('label');
      sw.className = 'swatch';
      sw.style.background = state.colorOverrides[c] || c;
      sw.title = c;
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.value = state.colorOverrides[c] || c;
      inp.addEventListener('input', () => {
        state.colorOverrides[c] = inp.value;
        sw.style.background = inp.value;
        refreshSvgOnly();
      });
      sw.appendChild(inp);
      pal.appendChild(sw);
    });
    $('paletteWrap').hidden = !colors.length;
    renderObjects();

    // stats
    const bytes = new Blob([svg]).size;
    const nodes = r.layers.reduce((n, l) => n + (l.d.match(/[CL]/g) || []).length, 0);
    $('stats').hidden = false;
    $('stats').innerHTML =
      `<div><b>${colors.length}</b><span>ألوان</span></div>` +
      `<div><b>${nodes.toLocaleString('ar')}</b><span>منحنى وخط</span></div>` +
      `<div><b>${(bytes / 1024).toFixed(1)} KB</b><span>حجم الملف</span></div>` +
      `<div><b>${(r.ms / 1000).toFixed(2)} ث</b><span>وقت المعالجة</span></div>`;
    setActions(true);
    window.dispatchEvent(new CustomEvent('vectorizer:result')); // batch.js keeps edits
  }

  // ---------------------------------------------------------------------------
  // Separate objects (icon sheets): thumbnails, single download, ZIP
  // ---------------------------------------------------------------------------
  let objectUrls = [];
  // Optional icon names (pasted from the prompt generator, reading order).
  // They name the files, feed the icon sheet and can be written under each icon.
  state.names = [];
  function parseNames(text) {
    const t = String(text || '').trim();
    if (!t) return [];
    const parts = t.includes('\n') ? t.split(/\n/) : t.split(/[,،;]/);
    return parts.map((x) => x.replace(/^\s*(\d+[.)-]\s*)/, '').trim());
  }
  function slug(name) {
    return String(name || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\u0600-\u06ff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  }
  // File names for the separate objects: the icon's name when known, else a number.
  function objectNames(base, count, names) {
    const used = new Set();
    return Array.from({ length: count }, (_, i) => {
      let n = slug(names && names[i]) || `${base}-${String(i + 1).padStart(2, '0')}`, q = n, k = 2;
      while (used.has(q)) q = `${n}-${k++}`;
      used.add(q);
      return q + '.svg';
    });
  }
  function darkest(result, colors) {
    let best = '#1a1a1a', lum = 2;
    for (const l of result.layers) {
      const c = (colors && colors[l.color]) || l.color, m = /^#?([0-9a-f]{6})$/i.exec(c);
      if (!m) continue;
      const v = parseInt(m[1], 16), y = (0.2126 * (v >> 16) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255)) / 255;
      if (y < lum) { lum = y; best = c; }
    }
    return best;
  }
  const xmlText = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // One separate object as SVG; with a name, the name is written under it as outlines.
  async function iconSVG(result, colors, i, name) {
    const b = result.objects[i];
    const pad = Math.round(Math.max(b.w, b.h) * 0.04);
    const svg = VectorizerEngine.toSVG(result, { crop: b, padding: pad, colors, minMP: STOCK_MP });
    if (!name || !window.IconSheet) return svg;
    const W = b.w + 2 * pad, H = b.h + 2 * pad;
    const fs = Math.max(W, H) * 0.1, label = name.toUpperCase();
    const tw = label.length * fs * 0.66;
    const OW = Math.max(W, tw + fs), OH = H + fs * 1.9, dx = (OW - W) / 2;
    const f = (v) => Math.round(v * 100) / 100;
    const body = svg.split('\n').slice(1, -1).join('\n');
    const bg = result.background ? `<rect width="${f(OW)}" height="${f(OH)}" fill="${(colors && colors[result.background]) || result.background}"/>\n` : '';
    const [SW, SH] = VectorizerEngine.stockSize(OW, OH, STOCK_MP);
    const out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f(OW)} ${f(OH)}" width="${SW}" height="${SH}">\n${bg}` +
      `<g transform="translate(${f(dx)} 0)">\n${body}\n</g>\n` +
      `<text data-font="label" x="${f(OW / 2)}" y="${f(H + fs * 1.25)}" font-family="Inter, Arial, sans-serif" font-size="${f(fs)}" font-weight="600" text-anchor="middle" fill="${darkest(result, colors)}">${xmlText(label)}</text>\n</svg>`;
    try { return await window.IconSheet.textToPaths(out); } catch (_) { return svg; }
  }
  function objectSVG(i) {
    const b = state.result.objects[i];
    const pad = Math.round(Math.max(b.w, b.h) * 0.04);
    return VectorizerEngine.toSVG(state.result, { crop: b, padding: pad, colors: state.colorOverrides });
  }
  const labelOn = () => $('nameUnder').checked;
  function exportSVG(i) {
    return iconSVG(state.result, state.colorOverrides, i, labelOn() ? state.names[i] : '');
  }
  function objectName(i) {
    return objectNames(state.source.name, state.result.objects.length, state.names)[i];
  }
  function renderObjects() {
    objectUrls.forEach((u) => URL.revokeObjectURL(u));
    objectUrls = [];
    const objs = (state.result && state.result.objects) || [];
    const box = $('icons');
    box.innerHTML = '';
    $('iconsWrap').hidden = objs.length < 2;
    if (objs.length < 2) return;
    renderLinkSel();
    $('iconsCount').textContent = `(${objs.length}) — اضغط لتنزيل عنصر`;
    const names = state.names.filter(Boolean).length;
    const warn = $('namesWarn');
    warn.hidden = !names || names === objs.length;
    warn.textContent = `عدد الأسماء ${names} وعدد الأيقونات ${objs.length}: تأكد أن الترتيب صحيح (من اليسار إلى اليمين، صفاً بعد صف).`;
    objs.forEach((_, i) => {
      const url = URL.createObjectURL(new Blob([objectSVG(i)], { type: 'image/svg+xml' }));
      objectUrls.push(url);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.title = objectName(i);
      btn.innerHTML = `<img alt="" src="${url}">` + (state.names[i] ? `<span class="nm">${xmlText(state.names[i])}</span>` : '');
      btn.addEventListener('click', async () => download(new Blob([await exportSVG(i)], { type: 'image/svg+xml' }), objectName(i)));
      box.appendChild(btn);
    });
  }
  // ---- link with the prompt generator (same site: it saves its prompts in this browser)
  state.link = -1;
  function readLink() {
    try { const v = JSON.parse(localStorage.getItem('pg2:link')); return v && v.prompts && v.prompts.length ? v : null; } catch (_) { return null; }
  }
  function linkColors() {
    const L = readLink();
    return L && L.colors && L.colors.length ? L.colors : null;
  }
  function renderSnap() {
    const c = linkColors();
    $('snapWrap').hidden = $('snapHint').hidden = !c;
    $('snapChips').innerHTML = (c || []).map((x) => `<i style="background:${x}"></i>`).join('');
  }
  try { $('snapPal').checked = localStorage.getItem('vz:snap') !== '0'; } catch (_) {}
  $('snapPal').addEventListener('change', () => {
    try { localStorage.setItem('vz:snap', $('snapPal').checked ? '1' : '0'); } catch (_) {}
    scheduleRun();
  });
  renderSnap();
  function promptLabel(pr) {
    return `#${pr.n} ${pr.label}${pr.part ? ' (' + pr.part + ')' : ''}`;
  }
  function renderLinkSel() {
    const L = readLink(), sel = $('linkSel');
    $('linkField').hidden = !L;
    if (!L) return;
    const n = (state.result && state.result.objects && state.result.objects.length) || 0;
    sel.innerHTML = '<option value="-1">— بدون ربط —</option>' + L.prompts.map((pr, i) =>
      `<option value="${i}">${xmlText(promptLabel(pr))} — ${xmlText(pr.items.slice(0, 3).join(', '))}…${n && pr.items.length !== n ? ' ⚠' : ''}</option>`).join('');
    sel.value = String(state.link);
  }
  function setLink(i, silent) {
    const L = readLink(), pr = L && L.prompts[i];
    state.link = pr ? i : -1;
    setNames(pr ? pr.items : [], silent);
    renderLinkSel();
  }
  $('linkSel').addEventListener('change', () => setLink(+$('linkSel').value));
  window.addEventListener('storage', (e) => { if (e.key === 'pg2:link') { renderSnap(); if (state.result) renderLinkSel(); } });

  // Adobe Stock CSV: one row per file, names exactly as saved
  function csvText(rows) {
    const head = ['Filename', 'Title', 'Keywords', 'Category', 'Releases'];
    return [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  }
  function metaFor(link, i) {   // i = icon index, or -1 for the whole set / sheet
    const L = readLink(), pr = L && L.prompts[link];
    if (!pr) return null;
    const m = i < 0 ? pr : pr.icons && pr.icons[i];
    return m ? [m.title, m.keywords.join(', '), '8', ''] : null;
  }

  function setNames(list, silent) {
    state.names = (list || []).slice();
    $('iconNames').value = state.names.join(', ');
    if (state.result) renderObjects();
    if (!silent) window.dispatchEvent(new CustomEvent('vectorizer:names'));
  }
  $('iconNames').addEventListener('input', () => {
    state.names = parseNames($('iconNames').value);
    if (state.result) renderObjects();
    window.dispatchEvent(new CustomEvent('vectorizer:names'));
  });
  $('dlZip').addEventListener('click', async () => {
    const enc = new TextEncoder();
    const files = [];
    for (let i = 0; i < state.result.objects.length; i++) files.push({ name: objectName(i), data: enc.encode(await exportSVG(i)) });
    files.push({ name: state.source.name + '-all.svg', data: enc.encode(currentSVG(false)) });
    if (state.link >= 0) {
      const rows = [];
      files.forEach((f, i) => { const m = metaFor(state.link, i < files.length - 1 ? i : -1); if (m) rows.push([f.name, ...m]); });
      if (rows.length) files.push({ name: 'metadata.csv', data: enc.encode(csvText(rows)) });
    }
    download(makeZip(files), state.source.name + '-icons.zip');
  });

  // Minimal ZIP writer (stored, no compression) — enough for SVG files.
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(d) {
    let c = 0xffffffff;
    for (let i = 0; i < d.length; i++) c = CRC_TABLE[(c ^ d[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function makeZip(files) {
    const enc = new TextEncoder();
    const chunks = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
      local.setUint32(14, crc, true); local.setUint32(18, size, true); local.setUint32(22, size, true);
      local.setUint16(26, name.length, true);
      chunks.push(local.buffer, name, f.data);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
      cen.setUint32(16, crc, true); cen.setUint32(20, size, true); cen.setUint32(24, size, true);
      cen.setUint16(28, name.length, true); cen.setUint32(42, offset, true);
      central.push(cen.buffer, name);
      offset += 30 + name.length + size;
    }
    const cenSize = central.reduce((s, c) => s + c.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, end.buffer], { type: 'application/zip' });
  }

  let refreshT = 0;
  function refreshSvgOnly() {
    clearTimeout(refreshT);
    refreshT = setTimeout(() => {
      renderObjects();
      if (state.svgUrl) URL.revokeObjectURL(state.svgUrl);
      state.svgUrl = URL.createObjectURL(new Blob([currentSVG(false)], { type: 'image/svg+xml' }));
      applyView();
      window.dispatchEvent(new CustomEvent('vectorizer:result'));
    }, 60);
  }

  // anchor points in the outline view: hidden by default, shown on demand
  state.anchors = false;
  $('anchorsBtn').addEventListener('click', () => {
    state.anchors = !state.anchors;
    $('anchorsBtn').classList.toggle('on', state.anchors);
    if (!state.result) return;
    if (state.outlineUrl) URL.revokeObjectURL(state.outlineUrl);
    state.outlineUrl = URL.createObjectURL(new Blob([currentSVG(true)], { type: 'image/svg+xml' }));
    applyView();
  });

  function applyView() {
    const v = state.view;
    $('anchorsBtn').hidden = v !== 'outline';
    const vec = $('imgVector'), orig = $('imgOriginal');
    const url = v === 'outline' ? state.outlineUrl : state.svgUrl;
    if (url && vec.getAttribute('src') !== url) vec.src = url;
    vec.style.visibility = v === 'original' || !url ? 'hidden' : 'visible';
    orig.style.visibility = v === 'vector' ? 'hidden' : 'visible';
    const splitMode = v === 'split' || v === 'outline';
    vec.style.clipPath = splitMode ? `inset(0 0 0 ${state.split * 100}%)` : 'none';
    orig.style.clipPath = splitMode && url ? `inset(0 ${(1 - state.split) * 100}% 0 0)` : 'none';
    $('divider').style.display = splitMode && url ? '' : 'none';
    $('divider').style.left = state.split * 100 + '%';
    document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  }
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => { state.view = b.dataset.view; applyView(); }));

  function showBusy(on) {
    $('busy').hidden = !on;
    if (on) { $('busyBar').style.width = '0%'; $('busyText').textContent = 'جارٍ التحويل…'; }
  }
  function setActions(on) {
    ['dlSvg', 'dlPng', 'copySvg'].forEach((id) => { $(id).disabled = !on; });
  }

  // ---------------------------------------------------------------------------
  // Zoom & pan
  // ---------------------------------------------------------------------------
  const canvas = $('canvas'), stage = $('stage');
  function applyZoom() {
    const z = state.zoom;
    stage.style.transform = `translate(${z.x}px, ${z.y}px) scale(${z.s})`;
    stage.style.setProperty('--inv', 1 / z.s);
    $('zoomLabel').textContent = Math.round(z.s * 100) + '%';
  }
  function fitView() {
    if (!state.source) return;
    const cw = canvas.clientWidth, ch = canvas.clientHeight, pad = 24;
    const s = Math.min((cw - pad * 2) / state.source.w, (ch - pad * 2) / state.source.h, 8);
    state.zoom = { s, x: (cw - state.source.w * s) / 2, y: (ch - state.source.h * s) / 2 };
    applyZoom();
  }
  function zoomAt(factor, cx, cy) {
    const z = state.zoom;
    const ns = Math.max(0.05, Math.min(64, z.s * factor));
    z.x = cx - ((cx - z.x) * ns) / z.s;
    z.y = cy - ((cy - z.y) * ns) / z.s;
    z.s = ns;
    applyZoom();
  }
  $('zoomIn').addEventListener('click', () => zoomAt(1.5, canvas.clientWidth / 2, canvas.clientHeight / 2));
  $('zoomOut').addEventListener('click', () => zoomAt(1 / 1.5, canvas.clientWidth / 2, canvas.clientHeight / 2));
  $('zoomFit').addEventListener('click', fitView);
  window.addEventListener('resize', () => { if (state.source) fitView(); });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });

  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    const onDivider = e.target.closest('#divider');
    drag = { divider: !!onDivider, x: e.clientX, y: e.clientY, zx: state.zoom.x, zy: state.zoom.y };
    canvas.setPointerCapture(e.pointerId);
    if (!onDivider) canvas.classList.add('panning');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.divider) {
      const rect = stage.getBoundingClientRect();
      state.split = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      applyView();
    } else {
      state.zoom.x = drag.zx + e.clientX - drag.x;
      state.zoom.y = drag.zy + e.clientY - drag.y;
      applyZoom();
    }
  });
  const endDrag = () => { drag = null; canvas.classList.remove('panning'); };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------
  function download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  $('dlSvg').addEventListener('click', () => {
    download(new Blob([currentSVG(false)], { type: 'image/svg+xml' }), state.source.name + '.svg');
  });
  $('dlPng').addEventListener('click', () => {
    const r = state.result;
    const k = Math.min(4, 8192 / Math.max(r.width, r.height));
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = Math.round(r.width * k); c.height = Math.round(r.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob((b) => download(b, state.source.name + '@4x.png'), 'image/png');
    };
    img.src = state.svgUrl;
  });
  $('copySvg').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(currentSVG(false));
      const b = $('copySvg'); const t = b.textContent; b.textContent = 'تم النسخ ✓'; setTimeout(() => { b.textContent = t; }, 1400);
    } catch (_) { alert('تعذّر النسخ إلى الحافظة.'); }
  });

  applyPreset('logo');
})();
