/*
 * Batch mode: many images (several files or a whole folder) in the page itself.
 *
 * - A strip above the editor lists every image with its vector result.
 * - Clicking an image opens it in the normal editor (compare, colours,
 *   separate icons, icon sheet…). Edits made there are kept for that image.
 * - "Save all SVG files" writes plain .svg files straight into a folder
 *   (or downloads them one by one), ready to upload; ZIP stays available.
 *
 * Uses its own worker. Needs VectorizerApp.buildOptions (app.js),
 * VectorizerEngine (engine.js) and, for sheets, IconSheet (sheet.js).
 */
(function () {
  'use strict';

  const WORKER_URL = 'worker.js?v=20';
  const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const enc = new TextEncoder();

  let items = [];       // { file, orig, path, status, icons, result, overrides, svg, thumb, sheet, error, detail, edited }
  let rootName = 'vectorized';
  let running = false, stopRequested = false, worker = null, pendingReject = null;
  let active = -1, editorUrl = null;

  // ---------------------------------------------------------------------------
  // Collecting files (picker, folder picker, drag & drop incl. folders)
  // ---------------------------------------------------------------------------
  const isImage = (f) => f && (IMAGE_EXT.test(f.name) || (/^image\//.test(f.type) && !/svg/.test(f.type)));
  const baseName = (p) => p.split('/').pop().replace(/\.[^.]+$/, '') || 'image';

  function readAllEntries(reader) {
    return new Promise((resolve) => {
      const all = [];
      const next = () => reader.readEntries((batch) => {
        if (!batch.length) return resolve(all);
        all.push(...batch);
        next();
      }, () => resolve(all));
      next();
    });
  }
  async function walkEntry(entry, out) {
    if (entry.isFile) {
      const file = await new Promise((res) => entry.file(res, () => res(null)));
      if (isImage(file)) out.push({ file, path: entry.fullPath.replace(/^\/+/, '') });
    } else if (entry.isDirectory) {
      for (const child of await readAllEntries(entry.createReader())) await walkEntry(child, out);
    }
  }
  function commonRoot(paths) {
    const firsts = new Set(paths.map((p) => (p.includes('/') ? p.split('/')[0] : '')));
    return firsts.size === 1 && !firsts.has('') ? [...firsts][0] : '';
  }

  function openWith(list) {
    list = list.filter((x) => isImage(x.file));
    if (!list.length) { alert('لم أجد صوراً (PNG أو JPG أو WEBP…) في ما اخترته.'); return; }
    if (running) stop();
    list.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
    const root = commonRoot(list.map((x) => x.path));
    rootName = root || 'vectorized';
    items.forEach(freeItem);
    items = list.map((x) => ({
      file: x.file,
      orig: URL.createObjectURL(x.file),
      path: root ? x.path.slice(root.length + 1) : x.path, // relative to the root folder
      status: 'wait', names: [], link: -1, icons: 0, result: null, overrides: {}, svg: null, thumb: null, sheet: null, error: '', detail: '', edited: false,
    }));
    showBar();
    openInEditor(0);
    start();
  }
  function freeItem(it) {
    if (it.thumb) URL.revokeObjectURL(it.thumb);
    if (it.orig) URL.revokeObjectURL(it.orig);
  }

  // ---------------------------------------------------------------------------
  // Batch panel (inside the page, above the editor)
  // ---------------------------------------------------------------------------
  function buildBar() {
    const el = document.createElement('section');
    el.className = 'batchbar';
    el.id = 'batchBar';
    el.hidden = true;
    el.innerHTML = `
      <div class="bb-head">
        <div class="bb-title"><b id="bbTitle"></b><span id="bbSummary"></span></div>
        <button type="button" class="sheet-close" id="bbClose" title="إغلاق الدفعة" aria-label="إغلاق الدفعة">×</button>
      </div>
      <div class="batch-progress"><div class="bar"><i id="bBar"></i></div><span id="bStatus"></span></div>
      <ul class="bb-strip" id="bList"></ul>
      <div class="bb-link" id="bLinkRow" hidden>
        <span>🔗 ربط بمولّد البرومبتات (أسماء الملفات + metadata.csv):</span>
        <label>من البرومبت # <input type="number" id="bLinkFrom" min="1" value="1"></label>
        <label>صور لكل برومبت <input type="number" id="bLinkPer" min="1" max="4" value="2"></label>
        <button type="button" class="btn" id="bLink">ربط بالترتيب</button>
        <button type="button" class="btn ghost" id="bUnlink">إلغاء الربط</button>
        <small>تأكد من الأسماء تحت كل صورة؛ لتغيير صورة واحدة افتحها واختر برومبتها في المحرّر.</small>
      </div>
      <div class="bb-foot">
        <div class="bb-opts">
          <label class="check"><input type="checkbox" id="bFull" checked> ملف SVG كامل لكل صورة</label>
          <label class="check"><input type="checkbox" id="bIcons" checked> كل أيقونة في ملف SVG منفصل</label>
          <label class="check"><input type="checkbox" id="bSheet"> لوحة أيقونات لكل صورة</label>
        </div>
        <div class="bb-btns">
          <button type="button" class="btn primary" id="bSave">حفظ كل ملفات SVG</button>
          <button type="button" class="btn" id="bZip">تنزيل ZIP</button>
          <button type="button" class="btn" id="bRun">إعادة التحويل بالإعدادات الحالية</button>
          <button type="button" class="btn" id="bStop">إيقاف</button>
        </div>
      </div>
      <p class="note">اضغط أي صورة لفتحها في المحرّر (المقارنة، الألوان، الأيقونات، لوحة الأيقونات)؛ تعديلاتك عليها تُحفظ في الدفعة. 🔒 لا تُرفع صورك إلى أي خادم.</p>`;
    const wrap = document.querySelector('.viewer-wrap');
    wrap.insertBefore(el, wrap.firstChild);
    $('bbClose').addEventListener('click', closeBar);
    $('bRun').addEventListener('click', () => {
      items.forEach((it) => { if (!it.edited) { it.status = 'wait'; it.sheet = null; } });
      start();
    });
    $('bStop').addEventListener('click', stop);
    $('bSave').addEventListener('click', saveAll);
    $('bZip').addEventListener('click', downloadZip);
    $('bSheet').addEventListener('change', updateButtons);
    $('bLink').addEventListener('click', () => linkInOrder(true));
    $('bUnlink').addEventListener('click', () => linkInOrder(false));
    return el;
  }
  function showBar() {
    const bar = $('batchBar') || buildBar();
    bar.hidden = false;
    renderList();
    renderSummary();
    setProgress(0, '');
  }
  function closeBar() {
    if (running) stop();
    $('batchBar').hidden = true;
    items.forEach(freeItem);
    items = [];
    active = -1;
    editorUrl = null;
  }

  const STATUS = { wait: 'في الانتظار', work: 'جارٍ…', done: '', error: 'خطأ', stopped: 'أُوقف' };
  function statusText(it) {
    if (it.status === 'done') return (it.icons >= 2 ? `✓ ${it.icons} أيقونات` : '✓ تم') + (it.edited ? ' · معدّل' : '');
    if (it.status === 'error') return `✗ ${esc(it.error || STATUS.error)}`;
    return STATUS[it.status];
  }
  // ---- link with the prompt generator: image k belongs to prompt from + floor(k / per)
  function renderLinkRow() {
    const L = window.VectorizerApp && window.VectorizerApp.readLink();
    $('bLinkRow').hidden = !L;
    if (L && !$('bLinkRow').dataset.init) { $('bLinkPer').value = L.perPrompt || 2; $('bLinkRow').dataset.init = '1'; }
  }
  function linkInOrder(on) {
    const A = window.VectorizerApp, L = A.readLink();
    if (!L) return;
    const from = Math.max(1, parseInt($('bLinkFrom').value, 10) || 1) - 1;
    const per = Math.max(1, parseInt($('bLinkPer').value, 10) || 1);
    items.forEach((it, k) => {
      const i = from + Math.floor(k / per), pr = on && L.prompts[i];
      it.link = pr ? i : -1;
      it.names = pr ? pr.items.slice() : [];
      it.sheet = null;
    });
    if (items[active] && editorUrl) A.setLink(items[active].link, true);
    renderList();
  }
  function linkText(it) {
    const A = window.VectorizerApp, L = it.link >= 0 && A && A.readLink(), pr = L && L.prompts[it.link];
    if (!pr) return '';
    const bad = it.status === 'done' && it.icons !== pr.items.length;
    return `<span class="bb-lk${bad ? ' bad' : ''}" dir="ltr" title="${esc(pr.items.join(', '))}">${bad ? '⚠ ' : ''}${esc(A.promptLabel(pr))}</span>`;
  }
  function renderList() {
    $('bList').innerHTML = items.map((it, i) => `<li class="bb-card b-${it.status}${i === active ? ' is-active' : ''}">
        <button type="button" class="bb-open" data-i="${i}" title="فتح في المحرّر: ${esc(it.path)}">
          <span class="bb-img"><img alt="" src="${it.thumb || it.orig}" class="${it.thumb ? '' : 'is-orig'}">${it.status === 'work' ? '<span class="b-spin"></span>' : ''}</span>
          <span class="bb-name" dir="ltr">${esc(it.path)}</span>
          <span class="bb-st"${it.detail ? ` title="${esc(it.detail)}"` : ''}>${statusText(it)}</span>${linkText(it)}
        </button>
      </li>`).join('');
    $('bList').querySelectorAll('.bb-open').forEach((b) => b.addEventListener('click', () => openInEditor(+b.dataset.i)));
    renderLinkRow();
    updateButtons();
  }
  function renderSummary() {
    const done = items.filter((x) => x.status === 'done');
    const icons = done.reduce((n, x) => n + (x.icons >= 2 ? x.icons : 0), 0);
    $('bbTitle').textContent = `دفعة: ${items.length} صورة من «${rootName}»`;
    $('bbSummary').textContent = done.length ? ` — تم ${done.length}، و ${icons} أيقونة منفصلة` : '';
    updateButtons();
  }
  function updateButtons() {
    const done = items.some((x) => x.status === 'done');
    $('bSave').disabled = running || !done;
    $('bZip').disabled = running || !done;
    $('bStop').disabled = !running;
    $('bRun').disabled = running || !items.length;
  }
  function setProgress(fraction, label) {
    $('bBar').style.width = Math.round(Math.max(0, Math.min(1, fraction)) * 100) + '%';
    $('bStatus').textContent = label || '';
  }

  // ---- the editor shows one image of the batch; its edits are kept
  function openInEditor(i) {
    const it = items[i];
    if (!it) return;
    try {
      const dt = new DataTransfer();
      dt.items.add(it.file);
      $('file').files = dt.files;
    } catch (_) { return; }
    active = i;
    editorUrl = null;
    $('file').dispatchEvent(new Event('change'));
    renderList();
    const card = $('bList').children[i];
    if (card && card.scrollIntoView) card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  window.addEventListener('vectorizer:result', () => {
    const st = window.VectorizerState, it = items[active];
    if (!st || !st.result || !st.source || !it) return;
    let first = false;
    if (!editorUrl) {
      if (st.source.name !== baseName(it.file.name)) return;
      editorUrl = st.source.url;                   // this editor session belongs to the item
      first = true;                                // its first result is not an edit
    } else if (st.source.url !== editorUrl) {      // another image was opened by hand
      active = -1; editorUrl = null; renderList(); return;
    }
    if (first && window.VectorizerApp) {
      if (it.link >= 0) window.VectorizerApp.setLink(it.link, true);
      if (it.names && it.names.length) window.VectorizerApp.setNames(it.names, true);
    }
    it.result = st.result;
    it.overrides = { ...st.colorOverrides };
    it.icons = (st.result.objects || []).length;
    it.svg = window.VectorizerEngine.toSVG(st.result, { colors: it.overrides, minMP: window.VectorizerApp.stockMP });
    it.sheet = null;
    if (it.thumb) URL.revokeObjectURL(it.thumb);
    it.thumb = URL.createObjectURL(new Blob([it.svg], { type: 'image/svg+xml' }));
    if (!first) it.edited = true;                 // settings or colours changed in the editor
    it.status = 'done';
    renderList();
    renderSummary();
  });

  // names typed in the editor belong to the image open there
  window.addEventListener('vectorizer:names', () => {
    const st = window.VectorizerState, it = items[active];
    if (!st || !it || !st.source) return;
    if (editorUrl ? st.source.url !== editorUrl : st.source.name !== baseName(it.file.name)) return;
    it.names = (st.names || []).slice();
    if (it.link !== st.link) { it.link = st.link; renderList(); }
    it.sheet = null;
  });

  // ---------------------------------------------------------------------------
  // Processing (own worker, one image after another)
  // ---------------------------------------------------------------------------
  async function decode(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file); } catch (_) { /* fall back */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }
  function pixels(img) {
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const maxWork = (window.VectorizerApp && window.VectorizerApp.maxWork) || 2600;
    const scale = Math.max(w, h) > maxWork ? maxWork / Math.max(w, h) : 1;
    const ww = Math.max(1, Math.round(w * scale)), wh = Math.max(1, Math.round(h * scale));
    const c = document.createElement('canvas');
    c.width = ww; c.height = wh;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, ww, wh);
    if (img.close) img.close();
    return { rgba: ctx.getImageData(0, 0, ww, wh).data, w: ww, h: wh, scale: ww / w };
  }
  let jobId = 0;
  function vectorizeInWorker(px, options, onProgress) {
    return new Promise((resolve, reject) => {
      if (!worker) worker = new Worker(WORKER_URL);
      const id = ++jobId;
      pendingReject = reject;
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.id !== id) return;
        if (m.type === 'progress') onProgress(m.progress);
        else if (m.type === 'done') resolve(m.result);
        else reject(new Error(m.message));
      };
      worker.onerror = (e) => reject(new Error(e.message || 'worker error'));
      const copy = new Uint8ClampedArray(px.rgba);
      worker.postMessage({ id, rgba: copy, width: px.w, height: px.h, options }, [copy.buffer]);
    });
  }
  function stop() {
    stopRequested = true;
    if (worker) { worker.terminate(); worker = null; }
    if (pendingReject) { pendingReject(new Error('stopped')); pendingReject = null; }
  }

  async function start() {
    if (running || !items.length) return;
    if (!window.VectorizerApp || !window.VectorizerEngine) { alert('تعذّر تشغيل المحرك.'); return; }
    running = true;
    stopRequested = false;
    renderList();
    const total = items.length;
    for (let i = 0; i < total; i++) {
      const it = items[i];
      if (stopRequested) break;
      if (it.status === 'done') continue;
      it.status = 'work';
      renderList();
      const label = `${i + 1} / ${total} — ${it.path}`;
      setProgress(i / total, label);
      try {
        const px = pixels(await decode(it.file));
        const options = window.VectorizerApp.buildOptions(px.w, px.h, px.scale);
        const result = await vectorizeInWorker(px, options, (p) => setProgress((i + p) / total, label));
        if (it.status !== 'work') continue;            // the editor already delivered this one
        it.result = result;
        it.overrides = {};
        it.icons = (result.objects || []).length;
        it.svg = window.VectorizerEngine.toSVG(result, { minMP: window.VectorizerApp.stockMP });
        it.sheet = null;
        if (it.thumb) URL.revokeObjectURL(it.thumb);
        it.thumb = URL.createObjectURL(new Blob([it.svg], { type: 'image/svg+xml' }));
        it.status = 'done';
      } catch (err) {
        if (stopRequested) { it.status = 'stopped'; break; }
        it.status = 'error';
        it.error = 'تعذّرت قراءة الصورة أو تحويلها';
        it.detail = String((err && err.message) || err);
      }
      renderList();
      renderSummary();
    }
    if (stopRequested) items.forEach((it) => { if (it.status === 'wait' || it.status === 'work') it.status = 'stopped'; });
    running = false;
    pendingReject = null;
    const done = items.filter((x) => x.status === 'done').length;
    setProgress(done / total, stopRequested ? `أُوقف — تم ${done} من ${total}` : `اكتمل — تم ${done} من ${total}`);
    $('bRun').textContent = done === total ? 'إعادة التحويل بالإعدادات الحالية' : 'متابعة التحويل';
    renderList();
    renderSummary();
  }

  // ---------------------------------------------------------------------------
  // Output files
  // ---------------------------------------------------------------------------
  async function sheetFor(it) {
    if (it.sheet !== null) return it.sheet;
    it.sheet = '';
    const S = window.IconSheet;
    if (!S || !it.result) return it.sheet;
    const data = S.extractIcons(it.result, it.overrides);
    if (data.icons.length < 2) return it.sheet;
    const { svg } = S.buildSheet(data, { title: S.defaultTitle(baseName(it.path)), ratio: '4:3', side: 'left', hero: 1, cols: 0, brand: true, tiles: true, names: (it.names || []).join('\n') });
    try { it.sheet = await S.textToPaths(svg); } catch (_) { it.sheet = svg; }
    return it.sheet;
  }

  // Every output file with a path inside the folder tree and a flat name.
  async function outputs() {
    const want = { full: $('bFull').checked, icons: $('bIcons').checked, sheet: $('bSheet').checked };
    const out = [], usedTree = new Set(), usedFlat = new Set();
    const unique = (set, p) => {
      let q = p, k = 2;
      while (set.has(q.toLowerCase())) q = p.replace(/(\.[^./]+)?$/, `-${k++}$1`);
      set.add(q.toLowerCase());
      return q;
    };
    const A = window.VectorizerApp, rows = [];
    const add = (tree, flat, text, meta) => {
      const f = unique(usedFlat, flat);
      out.push({ tree: unique(usedTree, tree), flat: f, data: enc.encode(text) });
      if (meta) rows.push([f, ...meta]);
      return f;
    };
    for (const it of items) {
      if (it.status !== 'done' || !it.result) continue;
      const dir = it.path.includes('/') ? it.path.slice(0, it.path.lastIndexOf('/') + 1) : '';
      const base = baseName(it.path);
      const flatBase = (dir.replace(/\//g, '-') + base).replace(/[\\:*?"<>|]+/g, '_');
      const objs = it.result.objects || [];
      if (want.full || objs.length < 2) add(`${rootName}/${dir}${base}.svg`, `${flatBase}.svg`, it.svg, A.metaFor(it.link, -1));
      if (want.icons && objs.length >= 2) {
        const names = it.names || [];
        const files = A.objectNames(base, objs.length, names);
        const label = $('nameUnder') && $('nameUnder').checked;
        for (let i = 0; i < objs.length; i++) {
          const svg = await A.iconSVG(it.result, it.overrides, i, label ? names[i] : '');
          const n = files[i].replace(/\.svg$/, '');
          if (names[i]) {   // same name in the folder tree and the flat save, so the CSV matches both
            const f = unique(usedFlat, `${n}.svg`);
            out.push({ tree: unique(usedTree, `${rootName}/${dir}${base}-icons/${f}`), flat: f, data: enc.encode(svg) });
            const m = A.metaFor(it.link, i);
            if (m) rows.push([f, ...m]);
          } else {
            add(`${rootName}/${dir}${base}-icons/${n}.svg`, `${flatBase}-${String(i + 1).padStart(2, '0')}.svg`, svg);
          }
        }
      }
      if (want.sheet && objs.length >= 2) {
        const sheet = await sheetFor(it);
        if (sheet) add(`${rootName}/${dir}${base}-sheet.svg`, `${flatBase}-sheet.svg`, sheet, A.metaFor(it.link, -1));
      }
    }
    if (rows.length) add(`${rootName}/metadata.csv`, 'metadata.csv', A.csvText(rows));
    return out;
  }

  function saveBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // Plain .svg files: straight into a folder when the browser allows it,
  // otherwise one download per file.
  async function saveAll() {
    const btn = $('bSave'), label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'جارٍ التجهيز…';
    try {
      const files = await outputs();
      if (!files.length) return;
      if (window.showDirectoryPicker) {
        let dir;
        try { dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'vectorizer-svg' }); }
        catch (e) { if (e && e.name === 'AbortError') return; dir = null; }
        if (dir) {
          for (let i = 0; i < files.length; i++) {
            const fh = await dir.getFileHandle(files[i].flat, { create: true });
            const w = await fh.createWritable();
            await w.write(files[i].data);
            await w.close();
            setProgress((i + 1) / files.length, `حفظ ${i + 1} / ${files.length}`);
          }
          setProgress(1, `✓ حُفظ ${files.length} ملف SVG في المجلد «${dir.name}»`);
          return;
        }
      }
      if (files.length > 40 && !confirm(`سيُنزَّل ${files.length} ملف SVG واحداً تلو الآخر، وقد يطلب المتصفح السماح بتنزيل عدة ملفات. متابعة؟ (يمكنك استعمال ZIP بدلاً من ذلك)`)) return;
      for (let i = 0; i < files.length; i++) {
        saveBlob(new Blob([files[i].data], { type: 'image/svg+xml' }), files[i].flat);
        setProgress((i + 1) / files.length, `تنزيل ${i + 1} / ${files.length}`);
        await new Promise((r) => setTimeout(r, 250));
      }
      setProgress(1, `✓ نُزّل ${files.length} ملف SVG`);
    } finally {
      btn.textContent = label;
      updateButtons();
    }
  }

  // ---- ZIP (deflate when available, otherwise stored)
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(d) {
    let c = 0xffffffff;
    for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  async function deflateRaw(data) {
    if (typeof CompressionStream === 'undefined') return null;
    try {
      const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (_) { return null; }
  }
  async function makeZip(files, onProgress) {
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const parts = [], central = [];
    let offset = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i], name = enc.encode(f.name), crc = crc32(f.data);
      const packed = await deflateRaw(f.data);
      const useDeflate = packed && packed.length < f.data.length;
      const body = useDeflate ? packed : f.data, method = useDeflate ? 8 : 0;
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
      local.setUint16(8, method, true); local.setUint16(10, time, true); local.setUint16(12, date, true);
      local.setUint32(14, crc, true); local.setUint32(18, body.length, true); local.setUint32(22, f.data.length, true);
      local.setUint16(26, name.length, true);
      parts.push(local.buffer, name, body);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
      cen.setUint16(10, method, true); cen.setUint16(12, time, true); cen.setUint16(14, date, true);
      cen.setUint32(16, crc, true); cen.setUint32(20, body.length, true); cen.setUint32(24, f.data.length, true);
      cen.setUint16(28, name.length, true); cen.setUint32(42, offset, true);
      central.push(cen.buffer, name);
      offset += 30 + name.length + body.length;
      if (onProgress) onProgress((i + 1) / files.length);
    }
    const cenSize = central.reduce((s, c) => s + c.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  }
  async function downloadZip() {
    const btn = $('bZip'), label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'جارٍ تجهيز الملف…';
    try {
      const files = (await outputs()).map((f) => ({ name: f.tree, data: f.data }));
      if (!files.length) return;
      const blob = await makeZip(files, (p) => setProgress(p, `ضغط الملفات… ${Math.round(p * 100)}%`));
      saveBlob(blob, `${rootName}-svg.zip`);
      setProgress(1, `✓ ${files.length} ملف SVG في ${(blob.size / 1024 / 1024).toFixed(2)} MB`);
    } finally {
      btn.textContent = label;
      updateButtons();
    }
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------
  const filesInput = $('batchFiles'), folderInput = $('batchFolder');

  if (filesInput) filesInput.addEventListener('change', () => {
    const list = [...filesInput.files].map((file) => ({ file, path: file.name }));
    filesInput.value = '';
    if (list.length === 1) { // a single image goes to the normal editor
      const dt = new DataTransfer(); dt.items.add(list[0].file); $('file').files = dt.files; $('file').dispatchEvent(new Event('change'));
      return;
    }
    openWith(list);
  });
  if (folderInput) folderInput.addEventListener('change', () => {
    const list = [...folderInput.files].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
    folderInput.value = '';
    openWith(list);
  });

  // Several files or a folder dropped anywhere -> batch (runs before app.js' single-file drop).
  window.addEventListener('drop', async (e) => {
    const dt = e.dataTransfer;
    if (!dt) return;
    const entries = [...(dt.items || [])].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
    const hasDir = entries.some((en) => en.isDirectory);
    const fileCount = [...(dt.files || [])].filter(isImage).length;
    if (!hasDir && fileCount < 2) return; // leave single images to app.js
    e.preventDefault();
    e.stopImmediatePropagation();
    const dropEl = $('drop');
    if (dropEl) dropEl.classList.remove('hover');
    const files = [...(dt.files || [])];
    const out = [];
    if (entries.length) { for (const en of entries) await walkEntry(en, out); }
    else files.forEach((file) => out.push({ file, path: file.name }));
    openWith(out);
  }, true);

  window.VectorizerBatch = { openWith, start, stop, outputs, items: () => items };
})();
