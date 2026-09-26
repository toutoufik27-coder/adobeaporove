// Before / after on the sample that has its source image: deer-frame-icon.svg, traced
// from deer-frame-source.png. Runs the engine (professional mode: restoration to the
// image, repetition consistency; final validation STRICT in the browser) and writes to
// out-dir:
//   deer-before.svg, deer-after.svg, deer-compare.html and deer-before-after.png (the
//   page drawn by the browser: source | before | after, zooms with the outlines)
// Needs Chrome / Edge (SVG_REFINE_BROWSER=... when it is not in a standard place).
//   node test/before-after.js out-dir
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { pathToFileURL } from 'url';
const OUT = path.resolve(process.argv[2] || '.');
fs.mkdirSync(OUT, { recursive: true });
const { loadSVG } = await import('../src/model.js');
const { processDoc, finalize, report } = await import('../src/process.js');
const { settingsFor } = await import('../src/engine.js');
const { decodePNG } = await import('../src/png.js');
const { makeSource, align } = await import('../src/source.js');
const { resetDoc } = await import('../src/engine.js');
const { writePath } = await import('../src/pathdata.js');
const { curveDistance } = await import('../src/evidence.js');
const { elementBox } = await import('../src/model.js');
const { closeBrowser, getBrowser, findBrowser, browserStatus } = await import('../src/browser.js');
if (!(await getBrowser())) { console.error('no browser: ' + browserStatus().reason); process.exit(2); }

const svgText = fs.readFileSync(new URL('../samples/deer-frame-icon.svg', import.meta.url), 'utf8');
const pngBuf = fs.readFileSync(new URL('../samples/deer-frame-source.png', import.meta.url));
const png = decodePNG(pngBuf);
const src = makeSource(png.data, png.width, png.height);
const doc = loadSVG(svgText);
resetDoc(doc);
src.T = align(doc, src);
const ctx = processDoc(doc, settingsFor('professional'), () => {}, src);
const out = await finalize(ctx, {}, { validation: 'strict' });
const rep = report(ctx, svgText, out.text), v = out.validation, im = rep.image, rvo = rep.repairVsOptimization;
fs.writeFileSync(path.join(OUT, 'deer-before.svg'), svgText);
fs.writeFileSync(path.join(OUT, 'deer-after.svg'), out.text);

// where the drawing changed: every final contour against the original contour it came
// from (same element and index, or, when a contour moved to another element, the
// original contour at the same place); recoloured contours first, then the largest
// displacement
const fin = ctx.history.at(-1).state, moves = [];
const origs = doc.elements.filter((e) => e.orig && e.orig.length).flatMap((e) => e.orig.map((sp, i) => ({ e, i, sp, box: elementBox(e, [sp]) })));
const centre = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
const hex = (e) => '#' + e.fill.rgb.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('');
for (const e of doc.elements) {
  const st = fin[e.idx];
  if (!e.orig || !e.orig.length || st.removed) continue;
  st.subpaths.forEach((sp, i) => {
    if (e.orig.includes(sp)) return;
    const box = elementBox(e, [sp]), c = centre(box);
    // same place and size (concentric contours share a centre, not a size)
    const far = (b) => Math.hypot(centre(b)[0] - c[0], centre(b)[1] - c[1]) + Math.abs(b[2] - b[0] - (box[2] - box[0])) + Math.abs(b[3] - b[1] - (box[3] - box[1]));
    const from = st.subpaths.length === e.orig.length ? origs.find((o) => o.e === e && o.i === i) : origs.map((o) => ({ o, d: far(o.box) })).sort((a, b) => a.d - b.d)[0].o;
    const d = curveDistance(from.sp, sp, ctx.u / (e.scale || 1)) / (ctx.u / (e.scale || 1));
    const recolour = from.e !== e && from.e.fill.kind === 'solid' && e.fill.kind === 'solid' && hex(from.e) !== hex(e) ? [hex(from.e), hex(e)] : null;
    moves.push({ e, i, d, box, box0: from.box, recolour });
  });
}
moves.sort((a, b) => (b.recolour ? 1 : 0) - (a.recolour ? 1 : 0) || b.d - a.d);
// zoom windows: around the recoloured parts and the largest moves (merged when they overlap)
const size = Math.max(doc.viewBox[2], doc.viewBox[3]), win = size * 0.16, zooms = [];
for (const m of moves) {
  // the point of the largest displacement is not known here: centre of the contour's box
  const c = [(m.box[0] + m.box[2]) / 2, (m.box[1] + m.box[3]) / 2];
  const w = Math.min(win, Math.max(m.box[2] - m.box[0], m.box[3] - m.box[1]) + 10);
  if (zooms.some((z) => Math.abs(z.c[0] - c[0]) < z.w / 2 && Math.abs(z.c[1] - c[1]) < z.w / 2)) continue;
  zooms.push({ c, w, m });
  if (zooms.length === 3) break;
}

// the source image in SVG user units (x' = s x + tx)
const T = src.T, b64 = pngBuf.toString('base64');
const imgEl = `<image href="data:image/png;base64,${b64}" x="${-T.tx / T.s}" y="${-T.ty / T.s}" width="${png.width / T.s}" height="${png.height / T.s}" preserveAspectRatio="none"/>`;
const vb = doc.viewBox.join(' ');
const inner = (t) => t.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const outlines = (subsOf, color, width) => doc.elements.filter((e) => e.subpaths && e.orig && e.orig.length).map((e) => { const subs = subsOf(e); if (!subs || !subs.length) return ''; return `<path transform="matrix(${e.ctm.join(' ')})" d="${writePath(subs, 3)}" fill="none" stroke="${color}" stroke-width="${width}" vector-effect="non-scaling-stroke"/>`; }).join('');
const withBox = (body, box) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.join(' ')}" preserveAspectRatio="xMidYMid meet">${body}</svg>`;
const full = [doc.viewBox[0], doc.viewBox[1], doc.viewBox[2], doc.viewBox[3]];
const uri = (s) => 'data:image/svg+xml;base64,' + Buffer.from(s).toString('base64');
const panels = (box) => [
  withBox(imgEl, box),
  withBox(inner(svgText), box),
  withBox(inner(out.text), box),
  withBox(imgEl + `<g opacity="0.95">${outlines((e) => e.orig, '#e63946', 2.2)}${outlines((e) => (fin[e.idx].removed ? null : fin[e.idx].subpaths), '#2ec27e', 1.4)}</g>`, box),
];
const pct = (x) => (x * 100).toFixed(2) + '%';
const row = (label, a, b, good) => `<tr><td>${label}</td><td>${a}</td><td class="${good === undefined ? '' : good ? 'good' : 'bad'}">${b}</td></tr>`;
const zoomRows = zooms.map((z, k) => {
  const box = [z.c[0] - z.w / 2, z.c[1] - z.w / 2, z.w, z.w];
  const p = panels(box);
  const hexb = (h) => `<bdi dir="ltr">${h}</bdi>`;
  const title = z.m.recolour ? `لون الجزء كان ${hexb(z.m.recolour[0])} وأصبح ${hexb(z.m.recolour[1])} مثل النسخ الثلاث المتناظرة الأخرى${z.m.d >= 0.05 ? `، وحافته تحركت ${z.m.d.toFixed(1)} u نحو الصورة` : ''}` : `الحد تحرك ${z.m.d.toFixed(1)} u (${(z.m.d / 10).toFixed(2)}% من حجم التصميم) نحو الصورة`;
  return `<h2>تكبير ${k + 1}: ${title}</h2>
  <div class="grid4">${p.map((s, i) => `<figure><img src="${uri(s)}"><figcaption>${['الصورة الأصلية (PNG)', 'قبل (SVG الأصلي)', 'بعد (الناتج)', 'الحواف: الأحمر قبل، الأخضر بعد، فوق الصورة'][i]}</figcaption></figure>`).join('')}</div>`;
}).join('');
const fp = panels(full);
const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>
body{margin:0;padding:24px 28px;background:#f6f7f9;font:15px/1.5 "Noto Sans Arabic","DejaVu Sans",sans-serif;color:#15202b;width:1344px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:22px 0 8px}p.sub{margin:0 0 14px;color:#5b6570}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
figure{margin:0;background:#fff;border:1px solid #dde1e6;border-radius:8px;padding:8px}figure img{width:100%;display:block;image-rendering:auto;background:#fff}
figcaption{text-align:center;font-size:13px;color:#46505a;margin-top:6px}
table{border-collapse:collapse;background:#fff;border:1px solid #dde1e6;border-radius:8px;overflow:hidden;width:100%}
td,th{padding:7px 12px;border-bottom:1px solid #eef0f3;text-align:right}th{background:#eef2f7;font-weight:600}
td.good{color:#127a3a;font-weight:600}td.bad{color:#b42318;font-weight:600}.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.note{font-size:13px;color:#5b6570;margin-top:8px}
</style></head><body>
<h1>قبل وبعد: deer-frame-icon.svg مع صورته الأصلية</h1>
<p class="sub">الوضع الاحترافي: المطابقة مع الصورة الأصلية، وتوحيد لون الأجزاء المتكررة المتناظرة. الناتج مرّ بالتحقق النهائي في المتصفح (STRICT، Chromium): ${v.level === 'browser-verified' ? 'ناجح ومُتحقق منه في المتصفح' : v.level}.</p>
<div class="grid3">${fp.slice(0, 3).map((s, i) => `<figure><img src="${uri(s)}"><figcaption>${['الصورة الأصلية (PNG) التي رُسم منها الفيكتور', 'قبل: SVG الأصلي', 'بعد: SVG الناتج'][i]}</figcaption></figure>`).join('')}</div>
<div class="cols"><div><h2>المطابقة مع الصورة الأصلية</h2><table><tr><th></th><th>قبل</th><th>بعد</th></tr>
${row('بكسلات خاطئة (ΔE > 20)', pct(im.wrongBefore / 100), pct(im.wrongAfter / 100), im.wrongAfter < im.wrongBefore)}
${row('متوسط الفرق ΔE', im.meanBefore.toFixed(2), im.meanAfter.toFixed(2), im.meanAfter < im.meanBefore)}
${row('حواف أعيدت إلى مكانها في الصورة', '—', String(im.restored))}
</table></div><div><h2>الملف</h2><table><tr><th></th><th>قبل</th><th>بعد</th></tr>
${row('العقد', rep.original.nodes, rep.processed.nodes, rep.processed.nodes <= rep.original.nodes)}
${row('الحجم', (rep.original.bytes / 1024).toFixed(1) + ' KB', (rep.processed.bytes / 1024).toFixed(1) + ' KB', rep.processed.bytes <= rep.original.bytes)}
${row('إصلاحات فعلية', '—', `${rvo.repairs.total} (${Object.entries(rvo.repairs.byType).map(([k, n]) => ({ 'geometry correction': 'تصحيح هندسة', 'primitive reconstruction': 'إعادة بناء شكل', 'repetition consistency': 'توحيد لون جزء متكرر' }[k] || k) + ' ' + n).join('، ') || '—'})`)}
${row('تحسينات (حجم وبنية فقط)', '—', String(rvo.optimizations.total))}
${row('فرق مرئي عن الرسم المصحح: داخلي / متصفح', '—', `${pct(v.internal.visible)} / ${v.browser && v.browser.visible != null ? pct(v.browser.visible) : '—'}`)}
${v.intended ? row('التصحيح المقصود كما رسمه المتصفح', '—', v.intended.browserVerified ? `${v.intended.ok ? 'في مكانه فقط' : 'لم يتأكد'}: ${v.intended.changedPixels} بكسل تغيّر، ${v.intended.outside} خارج مكانه، ${v.intended.disagree} بلون مختلف` : 'لم يُفحص في المتصفح', v.intended.ok) : ''}
</table></div></div>
${zoomRows}
<p class="note">الأرقام محسوبة من هذا التشغيل. «البكسلات الخاطئة» تقارن رسم الـSVG بالصورة الأصلية، وجزء كبير من الباقي سببه نعومة حواف الصورة وليس خطأ في الرسم. تحرّك الحواف مقاس بمسافة Hausdorff، و1 u = 1/1000 من حجم التصميم.</p>
</body></html>`;
fs.writeFileSync(path.join(OUT, 'deer-compare.html'), html);
console.log(JSON.stringify({ level: v.level, image: im, nodes: [rep.original.nodes, rep.processed.nodes], bytes: [rep.original.bytes, rep.processed.bytes], repairs: rvo.repairs, optimizations: rvo.optimizations.total, internal: v.internal, browser: v.browser, zooms: zooms.map((z) => ({ el: z.m.e.idx, sub: z.m.i, d: +z.m.d.toFixed(2), recolour: z.m.recolour })), moves: moves.length, intended: v.intended, restoredAccepted: ctx.counts['restore outline|accepted'] || 0, restoredRejected: ctx.counts['restore outline|rejected'] || 0 }, null, 1));
await closeBrowser();

// screenshot of the page, drawn by the browser after every image is decoded
const exe = findBrowser(), dir = fs.mkdtempSync(path.join(OUT, '.shot-'));
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const proc = spawn(exe, ['--headless=new', ...(asRoot ? ['--no-sandbox'] : []), '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb', '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((res) => { let b = ''; proc.stderr.on('data', (d) => { b += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(b); if (m) res(m[1]); }); });
const ws = new WebSocket(wsUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
const s = (m, p) => send(m, p, sessionId);
const ev = async (expression) => (await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.result.value;
await s('Page.enable');
await s('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
await s('Page.navigate', { url: pathToFileURL(path.join(OUT, 'deer-compare.html')).href });
for (let t = 0; t < 100 && (await ev('document.readyState')) !== 'complete'; t++) await new Promise((r) => setTimeout(r, 200));
await ev('Promise.all([...document.images].map((i) => i.decode().catch(() => null)))');
const h = await ev('document.documentElement.scrollHeight');
await s('Emulation.setDeviceMetricsOverride', { width: 1400, height: h, deviceScaleFactor: 1, mobile: false });
await ev('new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(ok, 300))))');
const shot = await s('Page.captureScreenshot', { format: 'png', fromSurface: true });
fs.writeFileSync(path.join(OUT, 'deer-before-after.png'), Buffer.from(shot.result.data, 'base64'));
await send('Browser.close'); proc.kill();
setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(0); }, 300);
