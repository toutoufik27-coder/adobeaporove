// UI of the reconstruction engine. The engine runs in worker.js; this file only shows
// results. SVG content is untrusted: it is displayed only after the engine's
// sanitizer, and filtered again here before it enters the page.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
const pct = (a, b) => (b ? Math.round((1 - a / b) * 100) : 0);
const MODE_AR = { safe: 'آمنة', balanced: 'متوازنة', professional: 'احترافية', aggressive: 'قوية' };
const STAGE_AR = { Restored: 'مطابقة الصورة', Semantic: 'تصحيح المعنى', Original: 'الأصل', Cleaned: 'التنظيف', Simplified: 'التبسيط', Reconstructed: 'إعادة بناء المنحنيات', Shapes: 'الأشكال', Final: 'النهائي' };
const PASS_AR = { 'image restoration': 'المطابقة مع الصورة الأصلية', 'structural cleanup': 'تنظيف البنية', 'duplicate point cleanup': 'النقاط المكررة', 'micro-segment cleanup': 'المقاطع الدقيقة', 'collinear simplification': 'النقاط على خط واحد', 'curve analysis': 'تحليل المنحنيات', 'curve fitting': 'ملاءمة المنحنيات', 'shape recognition': 'التعرف على الأشكال', 'topology validation': 'تحقق الطوبولوجيا', 'visual validation': 'التحقق البصري', 'final optimization': 'التحسين النهائي' };
const ISSUE_AR = { hidden: 'أشكال مخفية بالكامل تحت أشكال أعلى', 'micro-segments': 'مقاطع دقيقة جداً (ضجيج)', 'duplicate-points': 'نقاط مكررة أو مقاطع بطول صفر', 'collinear-points': 'نقاط زائدة على خط مستقيم', kinks: 'انكسارات صغيرة في الحواف', 'self-intersections': 'تقاطعات ذاتية', 'open-contour': 'حدود مفتوحة في شكل معبأ', 'near-primitive': 'أشكال شبه هندسية (دائرة/مستطيل) مرسومة بعقد كثيرة', unsupported: 'عناصر محفوظة كما هي', security: 'عناصر غير آمنة حُذفت', warning: 'تنبيهات', 'invalid-path': 'بيانات مسار غير صالحة' };
const SETTINGS = [
  ['simplify', 'تسامح التبسيط (‰ من حجم التصميم)', 'number', 0.1],
  ['curve', 'تسامح المنحنيات (‰)', 'number', 0.1],
  ['maxDev', 'أقصى انحراف مسموح (‰)', 'number', 0.1],
  ['cornerAngle', 'حماية الزوايا (درجة: أقل = زوايا أكثر)', 'number', 1],
  ['shapeMaxDev', 'أقصى انحراف لإعادة بناء شكل هندسي (نسبة من حجمه)', 'number', 0.001],
  ['shapeSystematic', 'انحراف منتظم يُعتبر شكلاً مقصوداً (نسبة من حجمه)', 'number', 0.001],
  ['micro', 'حد المقاطع الدقيقة (‰)', 'number', 0.1],
  ['precision', 'الدقة العشرية', 'select', ['adaptive', '1', '2', '3', '4']],
  ['maxAreaError', 'أقصى تغير في مساحة الحد (نسبة)', 'number', 0.001],
  ['regionMax', 'أقصى خطأ بصري لكل شكل (نسبة)', 'number', 0.001],
  ['symmetry', 'تصحيح التناظر', 'bool'],
  ['topologyRepair', 'إصلاح الطوبولوجيا', 'bool'],
  ['strokePreservation', 'حماية المسارات ذات الحدود (stroke)', 'bool'],
  ['flattenTransforms', 'تطبيق التحويلات (transform) على الإحداثيات', 'bool'],
  ['removeHidden', 'حذف الأجزاء المخفية تماماً', 'bool'],
  ['mergePaths', 'دمج المسارات المتطابقة المتجاورة', 'bool'],
];

// Engine messages are English (logs, CLI); the page shows them in Arabic.
const TR = [
  [/^outline moved more than ([\d.]+)% of the artwork \(all steps together, from the original contour\)$/, 'الحافة ستبتعد أكثر من $1% عن الحد الأصلي (مجموع كل الخطوات)'],
  [/^area changed by ([\d.]+)% \(limit ([\d.]+)%\)$/, 'تتغير المساحة بنسبة $1% (الحد $2%)'],
  [/^the render changes \((\d+) px\): not certainly hidden$/, 'الرسم يتغير ($1 بكسل): ليس مخفياً بشكل مؤكد'],
  [/^removal changes ([\d.]+) px \(limit ([\d.]+) px\)$/, 'الحذف يغيّر $1 بكسل (الحد $2)'],
  [/^kept: (\d+) other marks of the same size.*$/, 'أُبقي: $1 علامات أخرى بنفس الحجم (نمط مقصود، ليس شائبة)'],
  [/^isolated speck ([\d.]+) u \(limit ([\d.]+) u\)$/, 'نقطة شاردة $1 u (الحد $2 u)'],
  [/^drawn again as element #(\d+)$/, 'مرسوم مرة ثانية كعنصر #$1'],
  [/^subpaths (\d+) and (\d+) meet at one node.*$/, 'المساران الفرعيان $1 و$2 يلتقيان في عقدة واحدة'],
  [/^ends ([\d.]+) u apart: closed with Z$/, 'الطرفان متباعدان $1 u: أُغلق الحد'],
  [/^loop of ([\d.]+) u cut at the crossing$/, 'حلقة طولها $1 u قُطعت عند التقاطع'],
  [/^(\d+) broken smooth node\(s\).*$/, '$1 عقدة ناعمة مكسورة (نقطة تحكم شاذة)'],
  [/^deviation ([\d.]+) u from the ([\w-]+) is above ([\d.]+) u$/, 'الانحراف $1 u عن الشكل الهندسي أكبر من $3 u'],
  [/^deviation ([\d.]+)% of its size is above ([\d.]+)%$/, 'الانحراف $1% من حجم الشكل أكبر من $2%'],
  [/^the outline departs from the ([\w-]+) systematically \(([\d.]+)% of its size\): an intentional shape, kept$/, 'الحد يبتعد عن الشكل الهندسي بانتظام ($2% من حجمه): شكل مقصود، أُبقي كما هو'],
  [/^area differs by ([\d.]+)% \(limit ([\d.]+)%\)$/, 'المساحة تختلف بنسبة $1% (الحد $2%)'],
  [/^perimeter differs by ([\d.]+)% \(limit ([\d.]+)%\)$/, 'المحيط يختلف بنسبة $1% (الحد $2%)'],
  [/^the outline has (\d+) real corner\(s\).*$/, 'الحد فيه $1 زاوية حقيقية: ليس دائرة أو شكلاً بيضوياً'],
  [/^corners would change.*$/, 'ستتغير الزوايا'],
  [/^the ([\w-]+) does not fit the outline's box.*$/, 'الشكل الهندسي لا يطابق صندوق الحد'],
  [/^([\w-]+): deviation ([\d.]+) u, area ([\d.]+)%, perimeter ([\d.]+)%$/, 'انحراف $2 u، مساحة $3%، محيط $4%'],
  [/^(\w+) mirror deviation ([\d.]+) u$/, 'انحراف التناظر $2 u'],
  [/^topology would change.*$/, 'سيتغير التركيب (الحدود / الثقوب / التداخل)'],
  [/^would move the gradient.*$/, 'سيحرّك التدرج اللوني (يتغير صندوق الشكل)'],
  [/^outline moved more than ([\d.]+)% of the artwork$/, 'الحافة ستتحرك أكثر من $1% من حجم التصميم'],
  [/^creates self-intersections \((\d+) -> (\d+)\)$/, 'ينشئ تقاطعات ذاتية ($1 ← $2)'],
  [/^closed \/ open state changed$/, 'تتغير حالة الإغلاق'],
  [/^visual deviation ([\d.]+)% of the object, (\d+) px spot exceeds tolerance$/, 'الانحراف البصري $1% من الشكل وبقعة $2 بكسل — أكبر من المسموح'],
  [/^visual deviation ([\d.]+)% of the object exceeds tolerance$/, 'الانحراف البصري $1% من الشكل — أكبر من المسموح'],
  [/^visual deviation ([\d.]+)%$/, 'الانحراف البصري $1%'],
  [/^no geometry$/, 'بدون هندسة'],
  [/^no fill and no stroke.*$/, 'بدون تعبئة وبدون حدود (أو شفافية 0)'],
  [/^object error ([\d.]+)% \((\d+) px spot\) after all passes$/, 'خطأ الشكل $1% (بقعة $2 بكسل) بعد كل المراحل — أُرجع'],
  [/^contour region error ([\d.]+)% after all passes$/, 'خطأ منطقة الحد $1% بعد كل المراحل — أُرجع'],
  [/^global visible difference ([\d.]+)% above ([\d.]+)%$/, 'الفرق المرئي الكلي $1% أعلى من $2% — أُرجع'],
  [/^pixel difference ([\d.]+)%, mean ΔE ([\d.]+), structural ([\d.]+)%$/, 'فرق البكسلات $1%، متوسط ΔE $2، بنيوي $3%'],
  [/^organic shape protected \(organic score ([\d.]+)\)$/, 'شكل عضوي محمي (درجة $1)'],
  [/^gradient \/ pattern would be distorted$/, 'سيتشوه التدرج / النمط'],
  [/^clip \/ mask is in the same coordinate system$/, 'القص / القناع في نفس نظام الإحداثيات'],
  [/^non-uniform scale changes the stroke$/, 'تكبير غير متساوٍ يغيّر سماكة الحد'],
  [/^transform applied to the coordinates \(visual deviation ([\d.]+)%\)$/, 'طُبّق التحويل على الإحداثيات (انحراف $1%)'],
  [/^visual deviation after flattening$/, 'انحراف بصري بعد تطبيق التحويل'],
  [/^adaptive decimals.*$/, 'عدد منازل عشرية تلقائي لكل عنصر (خطأ التقريب < 0.005% من التصميم)'],
  [/^(\d+) decimals$/, '$1 منازل عشرية'],
  [/^refit at ([\d.]+)% tolerance$/, 'إعادة بناء بتسامح $1%'],
  [/^(\d+) contour\(s\) covered by shapes above$/, '$1 حد مغطى بأشكال أعلى'],
  [/^completely covered by shapes above$/, 'مغطى بالكامل بأشكال أعلى'],
  [/^(\d+) micro-segment\(s\) < ([\d.]+)%$/, '$1 مقطع دقيق أقصر من $2%'],
  [/^(\d+) node\(s\) on straight lines$/, '$1 عقدة على خط مستقيم'],
  [/^(\d+) zero-length, (\d+) near-duplicate$/, '$1 بطول صفر، $2 شبه مكررة'],
  [/^(\d+) contour\(s\) without area$/, '$1 حد بدون مساحة'],
  [/^fill already closes it: explicit Z$/, 'التعبئة تغلقه أصلاً: إغلاق صريح Z'],
  [/^same style, drawn one after the other$/, 'نفس الخصائص ومتتاليان'],
  [/^(vertical|horizontal) mirror symmetry (\d+)%$/, (m, a, b) => `تناظر ${a === 'vertical' ? 'عمودي' : 'أفقي'} ${b}%`],
  [/^(circle|ellipse|rectangle|rounded-rectangle|triangle|polygon|quadrilateral) \(deviation ([\d.]+)%\)$/, (m, a, b) => `${SHAPE_AR[a] || a} (انحراف ${b}%)`],
  [/^(\d+) organic, (\d+) geometric contours, (\d+) protected details$/, '$1 حد عضوي، $2 هندسي، $3 تفصيلة محمية'],
  [/^(\d+)% of the drawn area is hidden under other shapes$/, '$1% من المساحة المرسومة مخفية تحت أشكال أخرى'],
  [/^highly detailed vector paths$/, 'مسارات فيكتور كثيفة التفاصيل'],
  [/^(\d+)% of the nodes are noise.*$/, '$1% من العقد ضجيج (مقاطع دقيقة، تكرار، انكسارات، نقاط على خط)'],
  [/^(\d+) shape\(s\) that are almost perfect circles \/ rectangles$/, '$1 شكل شبه دائرة أو مستطيل مثالي'],
  [/^gradients \/ masks \/ strokes present.*$/, 'يحتوي تدرجات / أقنعة / حدود: إعادة بناء محافظة'],
  [/^the geometry is already clean$/, 'الهندسة نظيفة أصلاً'],
  [/^closer to the source image: mean ΔE ([\d.]+) -> ([\d.]+), wrong pixels (\d+) -> (\d+)$/, 'أقرب إلى الصورة الأصلية: ΔE $1 ← $2، بكسلات خاطئة $3 ← $4'],
  [/^not closer to the source image \(mean ΔE ([\d.]+) -> ([\d.]+), wrong pixels (\d+) -> (\d+)\)$/, 'ليس أقرب إلى الصورة الأصلية (ΔE $1 ← $2، بكسلات خاطئة $3 ← $4)'],
  [/^too many nodes for the corrected outline$/, 'الحافة المصححة تحتاج عقداً كثيرة'],
  [/^outline moved to the source image$/, 'نقل الحافة إلى مكانها في الصورة'],
  [/^difference to the source image: mean ΔE ([\d.]+) -> ([\d.]+), wrong pixels ([\d.]+)% -> ([\d.]+)%$/, 'الفرق عن الصورة الأصلية: ΔE $1 ← $2، بكسلات خاطئة $3% ← $4%'],
];
const SHAPE_AR = { circle: 'دائرة', ellipse: 'بيضوي', rectangle: 'مستطيل', 'rounded-rectangle': 'مستطيل بزوايا دائرية', triangle: 'مثلث', polygon: 'مضلع', quadrilateral: 'رباعي' };
const OP_AR = { 'restore outline': 'إعادة الحافة إلى الصورة', 'image fidelity': 'المطابقة مع الصورة', 'empty element': 'عنصر فارغ', 'invisible element': 'عنصر غير مرئي', 'degenerate contour': 'حد بدون مساحة', 'close open contour': 'إغلاق حد مفتوح', 'hidden element': 'عنصر مخفي', 'hidden contours': 'حدود مخفية', 'zero-length segment': 'مقطع بطول صفر', 'near-duplicate point': 'نقطة شبه مكررة', 'micro-segment': 'مقطع دقيق', 'collinear points': 'نقاط على خط واحد', 'curve reconstruction': 'إعادة بناء منحنى', 'symmetry correction': 'تصحيح تناظر', 'topology rollback': 'إرجاع (طوبولوجيا)', 'object rollback': 'إرجاع شكل', 'contour rollback': 'إرجاع حد', 'global check': 'التحقق الكلي', 'merge paths': 'دمج مسارات', precision: 'الدقة العشرية', 'flatten transform': 'تطبيق التحويل', 'tiny artifact': 'إزالة شائبة صغيرة', 'duplicate geometry': 'شكل مكرر', 'join broken stroke': 'وصل خط مقطوع', 'self-intersection loop': 'حلقة تقاطع ذاتي', 'kink repair': 'إصلاح نقطة تحكم شاذة' };
const ar = (s) => { s = String(s ?? ''); for (const [re, to] of TR) if (re.test(s)) return s.replace(re, to); return s; };
const opAr = (op) => OP_AR[op] || (/^(\S+) reconstruction$/.test(op) ? 'إعادة بناء ' + (SHAPE_AR[op.split(' ')[0]] || op) : op);

const st = {
  text: null, name: 'file.svg', analysis: null, rec: null, defaults: null, mode: null, overrides: {},
  result: null, applied: false, stage: 0, stageData: new Map(), original: null,
  view: { mode: 'side', z: 1, cx: 0, cy: 0, vb: [0, 0, 100, 100], z100: 1 }, slider: 0.5,
  inspect: false, sel: null, inspectData: null, idmap: null, logFilter: 'rejected',
};
let worker = null;
function startWorker() {
  if (worker) worker.terminate();
  worker = new Worker(new URL('worker.js?v=2', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => handle(e.data);
  worker.onerror = (e) => busy(false, 'خطأ: ' + e.message);
}
const send = (m) => worker.postMessage(m);
function busy(on, text, pass) { $('busy').hidden = !on; if (text) $('busyText').textContent = text; $('busyPass').textContent = pass || ''; }

// ---------------------------------------------------------------- loading
function load(file) {
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) { alert('الملف أكبر من 25 ميغابايت'); return; }
  st.name = file.name.replace(/\.svg$/i, '');
  file.text().then((t) => {
    st.view.vbSet = false;
    for (const b of $('leftPane').children) b.setAttribute('aria-pressed', b.dataset.l === 'svg');
    Object.assign(st, { leftPane: 'svg', text: t, analysis: null, result: null, applied: false, stage: 0, stageData: new Map(), sel: null, inspectData: null, idmap: null, overrides: {} });
    for (const id of ['anCard', 'recCard', 'repCard', 'logCard', 'expCard', 'historyBar', 'inspector', 'secCard', 'aiCard']) $(id).hidden = true;
    $('aiGroups').innerHTML = ''; $('aiStatus').textContent = '';
    startWorker();
    busy(true, 'جارٍ التحليل…');
    send({ type: 'load', text: t, name: file.name });
  });
}
$('file').onchange = (e) => load(e.target.files[0]);
$('srcFile').onchange = (e) => loadSource(e.target.files[0]);
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const fs = [...e.dataTransfer.files];
  const svg = fs.find((f) => /svg/i.test(f.type) || /\.svg$/i.test(f.name)), img = fs.find((f) => /^image\/(png|jpeg|webp)$/.test(f.type));
  if (svg) load(svg);
  if (img) setTimeout(() => loadSource(img), svg ? 50 : 0);
});
// the source raster: decoded by the browser, pixels go to the engine
function loadSource(file) {
  if (!file) return;
  const url = URL.createObjectURL(file), im = new Image();
  im.onload = () => {
    const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
    const g = c.getContext('2d'); g.drawImage(im, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height);
    st.srcImage = { url: c.toDataURL('image/png'), W: c.width, H: c.height, name: file.name, T: null };
    URL.revokeObjectURL(url);
    if (!worker) startWorker();
    send({ type: 'source', rgba: d.data.buffer, W: c.width, H: c.height });
    $('srcCard').hidden = false; $('srcCard').innerHTML = `<h2>الصورة الأصلية</h2><p class="muted"><span dir="ltr">${esc(file.name)}</span> — <span dir="ltr">${c.width}×${c.height}</span>. جارٍ إيجاد مكان الـSVG فيها…</p>`;
  };
  im.src = url;
}

function handle(m) {
  if (m.type === 'error') { busy(false); alert('خطأ في المعالجة: ' + m.message); console.error(m.stack); return; }
  if (m.type === 'progress') { $('busyPass').textContent = 'المرحلة ' + m.pass; return; }
  if (m.type === 'analysis') {
    st.analysis = m.analysis; st.rec = m.recommendation; st.original = m.original;
    showSecurity(m.removed); showAnalysis();
    $('drop').hidden = true; $('panes').hidden = false;
    mount($('canA'), st.original); mount($('canB'), st.original); fit(); layout();
    // dry run of the recommended mode: the expected numbers are real
    busy(true, `حساب النتيجة المتوقعة (${MODE_AR[st.rec.mode]})…`);
    send({ type: 'process', mode: st.rec.mode, dry: true, exportOptions: exportOptions() });
    return;
  }
  if (m.type === 'processed') {
    busy(false);
    st.defaults = m.defaults; st.result = m; st.mode = m.mode; st.stageData = new Map(); st.idmap = null;
    st.stage = m.stages.length - 1;
    st.stageData.set(st.stage, { output: m.output, integrity: m.integrity, report: m.report, metrics: m.report.visual });
    if (!m.dry) st.applied = true;
    showRecommendation(); fillSettings();
    if (st.applied) { showResult(); verifyInBrowser(m); }
    else { mount($('canB'), m.output); $('tagB').textContent = 'معاينة ' + MODE_AR[m.mode] + ' (غير مطبّقة بعد)'; layout(); }
    return;
  }
  if (m.type === 'stage') {
    busy(false);
    st.stageData.set(m.index, { output: m.output, integrity: m.integrity, report: m.report, metrics: m.metrics });
    if (m.index === st.stage) showStage();
    return;
  }
  if (m.type === 'source-aligned') { sourceAligned(m); return; }
  if (m.type === 'semantic-groups') { semGroups(m); return; }
  if (m.type === 'semantic-proposals') { semProposals(m.proposals); return; }
  if (m.type === 'semantic-applied') { semApplied(m); return; }
  if (m.type === 'idmap') { st.idmap = m; if (st.pendingPick) { const p = st.pendingPick; st.pendingPick = null; pickAt(p[0], p[1]); } return; }
  if (m.type === 'inspect') { st.inspectData = m.data; drawInspect(); showInspector(); }
}

// ---------------------------------------------------------------- panels
function showSecurity(removed) {
  const c = $('secCard');
  if (!removed.length) { c.hidden = true; return; }
  c.hidden = false;
  c.innerHTML = `<h2>الأمان</h2><div class="warn">حُذف ${removed.length} عنصر غير آمن من الملف قبل المعالجة:</div><ul class="issues">${removed.slice(0, 20).map((r) => `<li>${esc(r.what)} <span class="muted">${esc(r.detail)}</span></li>`).join('')}</ul>`;
}
function showAnalysis() {
  const a = st.analysis, s = a.summary;
  $('anCard').hidden = false;
  const tags = Object.entries(s.tags).map(([k, v]) => `${esc(k)} ${v}`).join('، ');
  $('anSum').innerHTML = `<div class="kv">
    <span>العناصر</span><b>${s.elements}</b><span>المسارات (path)</span><b>${s.paths}</b><span>العقد</span><b>${s.nodes.toLocaleString()}</b>
    <span>حجم الملف</span><b>${kb(s.bytes)}</b><span>viewBox</span><b dir="ltr">${s.viewBox.map((v) => +v.toFixed(2)).join(' ')}</b>
    <span>مساحة مرسومة لكنها مخفية</span><b>${Math.round(s.hiddenShare * 100)}%</b>
    <span>تدرجات / قص / أقنعة</span><b>${s.gradients} / ${s.clips} / ${s.masks}</b><span>حدود stroke / تحويلات</span><b>${s.strokes} / ${s.transforms}</b>
    <span>التعقيد</span><b>${Object.entries(s.complexity).map(([k, v]) => `${esc(k)} ${v}`).join('، ')}</b></div>
    <p class="muted">العناصر: ${tags}</p>`;
  const c = a.counts;
  $('anIssues').innerHTML = Object.keys(c).length ? Object.entries(c).map(([k, v]) => `<li><b>${v}</b> × ${esc(ISSUE_AR[k] || k)}</li>`).join('') : '<li>لا مشاكل — الهندسة نظيفة</li>';
  const rows = a.elements.filter((x) => x.complexity).sort((x, y) => y.complexity.score - x.complexity.score).slice(0, 60);
  $('anTable').innerHTML = '<tr><th>#</th><th>عقد</th><th>منحنيات</th><th>خطوط</th><th>أقواس</th><th>حدود</th><th>ثقوب</th><th>التعقيد</th></tr>' + rows.map((x) =>
    `<tr data-el="${x.idx}"><td>${esc(x.tag)} ${x.idx}${x.id ? ' #' + esc(x.id) : ''}</td><td>${x.complexity.nodes}</td><td>${x.complexity.curves}</td><td>${x.complexity.lines}</td><td>${x.complexity.arcs}</td><td>${x.complexity.subpaths}</td><td>${x.topology.holes}</td><td>${esc(x.complexity.label)}</td></tr>`).join('');
}
function showRecommendation() {
  const r = st.result, rec = st.rec, rp = r.report;
  $('recCard').hidden = false;
  const mine = r.mode === rec.mode;
  $('recBody').innerHTML = `<p>${rec.reasons.map((x) => esc(ar(x))).join('، ')}.</p>
    <p>المقترح: <b>${MODE_AR[rec.mode]}</b></p>
    <div class="big"><div><b>${pct(rp.processed.nodes, rp.original.nodes)}%</b>عقد أقل</div><div><b>${pct(rp.processed.bytes, rp.original.bytes)}%</b>حجم أصغر</div><div><b>${rp.visual.visible}%</b>فرق بصري</div></div>
    ${rp.image ? `<div class="good">مع الصورة الأصلية: البكسلات الخاطئة ${rp.image.wrongBefore}% ← ${rp.image.wrongAfter}%، و${rp.image.restored} حافة أعيدت إلى مكانها.</div>` : ''}
    <p class="muted">${mine ? 'هذه الأرقام محسوبة فعلاً بتشغيل المعالجة على ملفك' : `أرقام الوضع «${MODE_AR[r.mode]}» المطبّق`} (${(rp.ms / 1000).toFixed(1)} ث).</p>
    ${st.applied ? '' : `<button class="btn primary" id="applyRec">تطبيق المعالجة ${MODE_AR[rec.mode]}</button>`}`;
  const b = $('applyRec');
  if (b) b.onclick = () => { st.applied = true; showResult(); showRecommendation(); verifyInBrowser({ ...st.result, dry: false }); };
  for (const x of $('modes').children) { x.classList.toggle('rec', x.dataset.m === rec.mode); x.setAttribute('aria-pressed', st.applied && x.dataset.m === r.mode); }
}
$('modes').onclick = (e) => {
  const m = e.target.dataset.m;
  if (!m || !st.text) return;
  st.overrides = {};
  runMode(m);
};
function runMode(m, overrides = {}) {
  busy(true, `معالجة ${MODE_AR[m]}…`);
  st.mode = m;
  send({ type: 'process', mode: m, settings: overrides, exportOptions: exportOptions() });
}
function fillSettings() {
  const d = { ...st.defaults[st.mode], ...st.result.settings };
  $('advBody').innerHTML = SETTINGS.map(([k, label, type, step]) => {
    const v = d[k];
    if (type === 'bool') return `<label for="s_${k}">${label}</label><input type="checkbox" id="s_${k}" ${v ? 'checked' : ''}>`;
    if (type === 'select') return `<label for="s_${k}">${label}</label><select id="s_${k}">${step.map((o) => `<option ${String(v) === o ? 'selected' : ''} value="${o}">${o === 'adaptive' ? 'تلقائية' : o}</option>`).join('')}</select>`;
    return `<label for="s_${k}">${label}</label><input type="number" id="s_${k}" step="${step}" value="${v}">`;
  }).join('');
}
$('advReset').onclick = () => { st.result.settings = { ...st.defaults[st.mode] }; fillSettings(); };
$('advApply').onclick = () => {
  const o = {};
  for (const [k, , type] of SETTINGS) { const el = $('s_' + k); o[k] = type === 'bool' ? el.checked : type === 'select' ? el.value : +el.value; }
  runMode(st.mode, o);
};

function showResult() {
  $('aiCard').hidden = false; $('aiRun').disabled = false; $('aiNoModel').disabled = false;
  $('historyBar').hidden = false; $('repCard').hidden = false; $('logCard').hidden = false; $('expCard').hidden = false;
  $('stages').innerHTML = st.result.stages.map((s, i) => `<button data-i="${i}"><b>${esc(STAGE_AR[s.name] || s.name)}</b><small>${s.nodes.toLocaleString()} عقدة</small></button>`).join('');
  showLog();
  showStage();
}
$('stages').onclick = (e) => { const b = e.target.closest('button'); if (b) goStage(+b.dataset.i); };
$('undo').onclick = () => goStage(st.stage - 1);
$('redo').onclick = () => goStage(st.stage + 1);
function goStage(i) {
  if (!st.result || i < 0 || i >= st.result.stages.length) return;
  st.stage = i; st.idmap = null;
  if (st.stageData.has(i)) showStage(); else { busy(true, 'تحضير المرحلة…'); send({ type: 'stage', index: i, exportOptions: exportOptions() }); }
}
function showStage() {
  const d = st.stageData.get(st.stage);
  if (!d) return;
  for (const b of $('stages').children) b.setAttribute('aria-current', +b.dataset.i === st.stage);
  $('undo').disabled = st.stage === 0; $('redo').disabled = st.stage === st.result.stages.length - 1;
  mount($('canB'), d.output);
  $('tagB').textContent = STAGE_AR[st.result.stages[st.stage].name] || '';
  layout();
  showReport(d); showExport(d);
  if (st.sel != null && st.inspect) send({ type: 'inspect', el: st.sel, index: st.stage });
}
function showReport(d) {
  const r = d.report, v = d.metrics, c = r.changes;
  $('repStage').textContent = '— ' + (STAGE_AR[st.result.stages[st.stage].name] || '') + ' · ' + MODE_AR[st.result.mode];
  const row = (l, a, b) => `<tr><td>${l}</td><td>${a}</td><td>${b}</td></tr>`;
  $('repBody').innerHTML = `<table class="cmp"><tr><th></th><th>الأصل</th><th>بعد المعالجة</th></tr>
    ${row('العناصر', r.original.elements, r.processed.elements)}${row('المسارات', r.original.paths, r.processed.paths)}
    ${row('العقد', r.original.nodes.toLocaleString(), v.nodes != null ? v.nodes.toLocaleString() : r.processed.nodes.toLocaleString())}${row('حجم الملف', kb(r.original.bytes), kb(r.processed.bytes))}</table>
    <h2 style="margin-top:10px">التغييرات <span class="muted">(كل المعالجة)</span></h2>
    <div class="kv">
      <span>نقاط زائدة حُذفت</span><b>${c.removedPoints}</b><span>مقاطع بُسّطت</span><b>${c.simplifiedSegments}</b>
      <span>منحنيات أعيد بناؤها</span><b>${c.reconstructedCurves}</b><span>أشكال هندسية اكتُشفت</span><b>${c.detectedShapes}</b>
      <span>تصحيح تناظر</span><b>${c.symmetry}</b><span>مسارات دُمجت</span><b>${c.mergedPaths}</b>
      <span>أجزاء مخفية حُذفت</span><b>${c.removedHidden}</b><span>تعديلات مرفوضة</span><b>${c.rejected}</b></div>
    ${r.repairVsOptimization ? repairHTML(r.repairVsOptimization) : ''}
    <h2 style="margin-top:10px">${r.image ? 'الفرق البصري بعد المطابقة مع الصورة' : 'الفرق البصري عن الأصل'}</h2>
    ${r.image ? '<p class="muted">بعد إعادة الحواف إلى الصورة، تُقاس بقية المراحل (التبسيط والمنحنيات) على الرسم المصحح حتى لا تُفسده.</p>' : ''}
    <div class="kv"><span>فرق مرئي (بعد تجاهل إزاحة أقل من بكسل)</span><b>${v.visible}%</b><span>بكسلات تغيّرت (صارم)</span><b>${v.pixelDifference}%</b>
    <span>متوسط ΔE</span><b>${v.meanDeltaE}</b><span>فرق بنيوي (SSIM)</span><b>${v.structural}%</b><span>بقع مرئية (بكسل)</span><b>${v.spots}</b></div>
    ${r.image ? `<h2 style="margin-top:10px">المطابقة مع الصورة الأصلية</h2>
    <div class="kv"><span>بكسلات خاطئة (ΔE > 20)</span><b>${r.image.wrongBefore}% ← ${v.image ? v.image.wrong : r.image.wrongAfter}%</b>
    <span>متوسط الفرق ΔE</span><b>${r.image.meanBefore} ← ${v.image ? v.image.mean : r.image.meanAfter}</b>
    <span>حواف أعيدت إلى مكانها في الصورة</span><b>${r.image.restored}</b></div>
    <p class="muted">الرقم الأول للـSVG الأصلي، والثاني لهذه المرحلة. الجزء الباقي من الخطأ سببه نعومة حواف الصورة (JPEG)، وليس خطأ في الرسم.</p>` : ''}`;
}
// Repair and optimization are reported apart: a smaller file is not a repair.
const TYPE_AR = { 'primitive reconstruction': 'إعادة بناء شكل هندسي', 'geometry correction': 'تصحيح هندسة', 'broken continuity': 'استمرارية مقطوعة', 'malformed geometry': 'هندسة معطوبة', 'accidental artifacts': 'شوائب عَرَضية', 'topology repair': 'إصلاح طوبولوجيا', 'node reduction': 'تقليل العقد', 'path normalization': 'توحيد صيغة المسار', 'precision reduction': 'تقليل الدقة العشرية', 'redundant command removal': 'حذف أوامر زائدة', 'redundant element removal': 'حذف عناصر زائدة' };
function repairHTML(x) {
  const list = (b) => Object.entries(b.byType).map(([k, n]) => `<span>${TYPE_AR[k] || esc(k)}</span><b>${n}</b>`).join('');
  return `<h2 style="margin-top:10px">إصلاح أم تحسين؟</h2>
    <div class="kv"><span><b>إصلاحات فعلية</b> (تصحيح الهندسة)</span><b>${x.repairs.total}</b>${list(x.repairs)}</div>
    <div class="kv"><span><b>تحسينات</b> (حجم وبنية فقط)</span><b>${x.optimizations.total}</b>${list(x.optimizations)}</div>
    <div class="kv"><span>اقتراحات مرفوضة</span><b>${x.rejected}</b><span>تعديلات أُرجعت بعد قبولها</span><b>${x.rolledBack}</b></div>
    <p class="muted">صغر حجم الملف ليس دليلاً على الإصلاح.</p>`;
}
function showLog() {
  const log = st.result.log.filter((l) => l.op !== 'analysis');
  const f = st.logFilter;
  const rows = log.filter((l) => f === 'all' || (f === 'accepted' ? l.accepted : l.accepted === false)).slice(0, 400);
  $('logTable').innerHTML = rows.length ? rows.map((l) => `<tr data-el="${l.el ?? ''}"><td class="${l.accepted ? 'ok' : 'no'}">${l.accepted ? '✓' : '✗'}</td><td><b>${esc(l.label ? ar(l.label) : opAr(l.op))}</b> <span class="muted">${l.label ? esc(opAr(l.op)) : ''}</span><br><span class="muted">${esc(PASS_AR[l.pass] || l.pass)}${l.el != null ? ` · عنصر ${l.el}${l.sub != null ? ' / حد ' + l.sub : ''}` : ''}${l.cls ? ` · ${l.cls[0] === 'repair' ? 'إصلاح' : 'تحسين'}` : ''}${l.evidence && l.evidence.score != null ? ` · الهامش المتبقي ${Math.round(l.evidence.score * 100)}%` : ''}</span><br>${esc(ar(l.reason))}</td></tr>`).join('') : '<tr><td class="muted">لا شيء</td></tr>';
}
$('logFilter').onclick = (e) => { const f = e.target.dataset.f; if (!f) return; st.logFilter = f; for (const b of $('logFilter').children) b.setAttribute('aria-pressed', b.dataset.f === f); showLog(); };
for (const t of ['logTable', 'anTable']) $(t).onclick = (e) => {
  const tr = e.target.closest('tr[data-el]');
  if (!tr || tr.dataset.el === '' || !st.result) return;
  st.sel = +tr.dataset.el;
  if (!st.inspect) { $('inspect').checked = true; setInspect(true); }
  send({ type: 'inspect', el: st.sel, index: st.stage });
};

// ---------------------------------------------------------------- export
function exportOptions() { return { preserveStructure: $('exStructure').checked, minify: $('exMin').checked, pretty: !$('exMin').checked }; }
for (const id of ['exStructure', 'exPretty', 'exMin']) $(id).onchange = () => { if (!st.result) return; st.stageData = new Map(); busy(true, 'تحديث التصدير…'); send({ type: 'stage', index: st.stage, exportOptions: exportOptions() }); };
function showExport(d) {
  const i = d.integrity;
  $('integ').innerHTML = i.ok
    ? `<div class="good">فحص السلامة ناجح: XML صالح، المسارات صالحة، كل المراجع موجودة، المعرفات فريدة${i.warnings.length ? ` <span class="muted">(${i.warnings.length} تنبيه)</span>` : ''}.</div>`
    : `<div class="warn"><b>فشل فحص السلامة — لا يمكن اعتبار الملف «ناتجاً احترافياً»:</b><ul class="issues">${i.errors.slice(0, 10).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
  const b = d.browser, finalStage = st.result && st.stage === st.result.stages.length - 1;
  if (!finalStage) $('integ').innerHTML += '<div class="warn">هذه مرحلة وسيطة: لم تمر بالتحقق النهائي (إعادة التحليل والرسم في المتصفح). المرحلة «النهائي» وحدها يتم التحقق منها.</div>';
  if (b) $('integ').innerHTML += b.pending ? '<div class="muted">التحقق البصري في المتصفح جارٍ…</div>'
    : b.ok ? `<div class="good">التحقق البصري في المتصفح ناجح: فرق مرئي ${(b.visible * 100).toFixed(3)}% و${b.solid} بكسل بقع.</div>`
    : `<div class="warn"><b>النتيجة لم تجتز التحقق البصري في المتصفح${b.error ? ' (' + esc(b.error) + ')' : ` (فرق مرئي ${(b.visible * 100).toFixed(3)}%، ${b.solid} بكسل بقع)`}: الملف الأصلي هو المعروض والمُحمَّل.</b></div>`;
  $('download').disabled = !i.ok || !!(b && b.pending);
  $('downloadAnyway').hidden = i.ok;
}
// Final validation in this browser (the source of truth): the original and the output are
// drawn by the browser itself on the same grid and compared with the mode's limits. An
// output that fails is not offered: the original is kept.
async function browserCheck(origText, outText, S) {
  const [{ loadSVG }, { renderViewFor }, { compare }] = await Promise.all([import('./src/model.js'), import('./src/viewport.js'), import('./src/metrics.js')]);
  const rv = renderViewFor(loadSVG(origText), S.raster || 700), W = rv.cssW, H = rv.cssH;
  const draw = (text) => new Promise((ok, fail) => {
    const img = new Image(), url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.drawImage(img, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H).data, out = new Float32Array(W * H * 3);
      for (let p = 0; p < W * H; p++) for (let k = 0; k < 3; k++) out[p * 3 + k] = d[p * 4 + k];
      URL.revokeObjectURL(url); ok(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); fail(new Error('the browser cannot display this SVG')); };
    img.src = url;
  });
  const a = await draw(origText), b = await draw(outText);
  const c = compare(a, b, { W, H }, { radius: 1 });
  return { ok: c.visibleShare <= S.globalMax && c.solid <= S.maxSolid * 4, visible: c.visibleShare, solid: c.solid };
}
async function verifyInBrowser(m) {
  const d = st.stageData.get(st.stage);
  if (!d || m.dry) return;
  d.browser = { pending: true };
  showExport(d);
  try { d.browser = await browserCheck(m.original, d.output, m.settings); }
  catch (err) { d.browser = { ok: false, error: String(err.message || err) }; }
  if (!d.browser.ok) { d.rejectedOutput = d.output; d.output = m.original; if (st.applied) mount($('canB'), d.output); }
  showExport(d);
}
function download() {
  const d = st.stageData.get(st.stage);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([d.output], { type: 'image/svg+xml' }));
  const sn = st.result.stages[st.stage].name.toLowerCase();
  a.download = `${st.name}-${sn === 'final' ? 'clean' : sn}.svg`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
$('download').onclick = download;
$('downloadAnyway').onclick = () => { if (confirm('فشل فحص السلامة. الملف قد لا يعمل بشكل صحيح في برامج أخرى. تحميل رغم ذلك؟')) download(); };

// ---------------------------------------------------------------- viewer
// Only the engine's sanitized output reaches this point; it is filtered once more.
function safeSVG(text) {
  const d = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = d.documentElement;
  if (d.querySelector('parsererror') || svg.nodeName.toLowerCase() !== 'svg') return null;
  for (const el of [...svg.querySelectorAll('script,foreignObject,iframe,embed,object')]) el.remove();
  for (const el of [svg, ...svg.querySelectorAll('*')]) for (const a of [...el.attributes]) {
    if (/^on/i.test(a.name)) el.removeAttribute(a.name);
    if (/href$/i.test(a.name) && !/^#|^data:image\/(png|jpe?g|gif|webp);/i.test(a.value.trim())) el.removeAttribute(a.name);
  }
  return svg;
}
function mount(can, text) {
  const svg = safeSVG(text);
  can.replaceChildren();
  if (!svg) return;
  const el = document.importNode(svg, true);
  if (can.id === 'canB' || !st.view.vbSet) {
    const vb = (el.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    if (vb.length === 4 && vb.every(isFinite)) st.view.vb = vb;
    else { const w = parseFloat(el.getAttribute('width')) || 300, h = parseFloat(el.getAttribute('height')) || 150; st.view.vb = [0, 0, w, h]; }
    const W = parseFloat(el.getAttribute('width')), vbw = st.view.vb[2];
    st.view.z100 = W && !/%/.test(el.getAttribute('width')) ? W / vbw : 1;
    st.view.vbSet = true;
  }
  el.setAttribute('width', '100%'); el.setAttribute('height', '100%'); el.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  el.removeAttribute('x'); el.removeAttribute('y');
  el.dataset.doc = '1';
  can.append(el);
  const ov = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ov.setAttribute('class', 'ov'); ov.setAttribute('width', '100%'); ov.setAttribute('height', '100%');
  can.append(ov);
  applyView();
}
function paneSize() { const r = $('canB').getBoundingClientRect(); return [Math.max(1, r.width), Math.max(1, r.height)]; }
function fit() { const [w, h] = paneSize(), vb = st.view.vb; st.view.z = Math.min(w / vb[2], h / vb[3]) * 0.94; st.view.cx = vb[0] + vb[2] / 2; st.view.cy = vb[1] + vb[3] / 2; applyView(); }
function windowBox() { const [w, h] = paneSize(), z = st.view.z; return [st.view.cx - w / 2 / z, st.view.cy - h / 2 / z, w / z, h / z]; }
function applyView() {
  const box = windowBox().map((v) => +v.toFixed(6)).join(' ');
  for (const can of [$('canA'), $('canB')]) for (const s of can.children) s.setAttribute('viewBox', box);
  $('zoomLabel').textContent = Math.round((st.view.z / st.view.z100) * 100) + '%';
  drawInspect();
  if (typeof drawGroupsOverlay === 'function') drawGroupsOverlay();
}
$('zoomBar').onclick = (e) => {
  const z = e.target.dataset.z;
  if (!z) return;
  if (z === 'fit') return fit();
  if (z === 'in') st.view.z *= 1.5; else if (z === 'out') st.view.z /= 1.5; else st.view.z = st.view.z100 * +z;
  applyView();
};
// pan (drag) and zoom (wheel) — both panes share one view
for (const pane of [$('paneA'), $('paneB')]) {
  let drag = null;
  pane.addEventListener('pointerdown', (e) => { if (e.target.id === 'handle') return; drag = { x: e.clientX, y: e.clientY, cx: st.view.cx, cy: st.view.cy, moved: false }; pane.setPointerCapture(e.pointerId); pane.classList.add('dragging'); });
  pane.addEventListener('pointermove', (e) => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true; st.view.cx = drag.cx - dx / st.view.z; st.view.cy = drag.cy - dy / st.view.z; applyView(); });
  pane.addEventListener('pointerup', (e) => { pane.classList.remove('dragging'); const d = drag; drag = null; if (d && !d.moved && st.inspect) { const p = toUser(pane, e); pick(p[0], p[1]); } });
  pane.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = toUser(pane, e), f = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    st.view.z = Math.min(st.view.z100 * 64, Math.max(1e-3, st.view.z * f));
    const [w, h] = paneSize(), r = pane.getBoundingClientRect();
    st.view.cx = p[0] - (e.clientX - r.left - w / 2) / st.view.z; st.view.cy = p[1] - (e.clientY - r.top - h / 2) / st.view.z;
    applyView();
  }, { passive: false });
}
function toUser(pane, e) { const r = pane.getBoundingClientRect(), b = windowBox(); return [b[0] + (e.clientX - r.left) / st.view.z, b[1] + (e.clientY - r.top) / st.view.z]; }
window.addEventListener('resize', () => applyView());

$('viewModes').onclick = (e) => { const v = e.target.dataset.v; if (!v) return; st.view.mode = v; for (const b of $('viewModes').children) b.setAttribute('aria-pressed', b.dataset.v === v); layout(); };
function layout() {
  const m = st.view.mode, panes = $('panes');
  panes.className = 'panes' + (m === 'slider' || m === 'overlay' ? ' stack' : m === 'single' ? ' one' : '');
  $('overlayBar').hidden = m !== 'overlay';
  $('handle').hidden = m !== 'slider';
  const A = $('canA'), B = $('canB');
  const diff = m === 'overlay' && $('diffBlend').checked;          // difference: identical areas turn black
  A.style.opacity = m === 'overlay' && !diff ? $('opA').value / 100 : 1;
  B.style.opacity = m === 'overlay' && !diff ? $('opB').value / 100 : 1;
  $('opA').disabled = $('opB').disabled = diff;
  B.style.mixBlendMode = m === 'overlay' && $('diffBlend').checked ? 'difference' : '';
  $('paneB').style.background = m === 'slider' || m === 'overlay' ? 'transparent' : '#fff';
  if (m === 'slider') { const w = paneSize()[0]; B.style.clipPath = `inset(0 0 0 ${st.slider * w}px)`; $('handle').style.left = st.slider * w - 1 + 'px'; }
  else B.style.clipPath = '';
  $('paneA').querySelector('.tag').hidden = m === 'overlay';
  requestAnimationFrame(applyView);
}
for (const id of ['opA', 'opB', 'diffBlend']) $(id).oninput = layout;
{
  const h = $('handle');
  let on = false;
  h.addEventListener('pointerdown', (e) => { on = true; h.setPointerCapture(e.pointerId); e.stopPropagation(); });
  h.addEventListener('pointermove', (e) => { if (!on) return; const r = $('paneB').getBoundingClientRect(); st.slider = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); layout(); });
  h.addEventListener('pointerup', () => { on = false; });
}

// ---------------------------------------------------------------- geometry inspection
$('inspect').onchange = (e) => setInspect(e.target.checked);
function setInspect(on) { st.inspect = on; $('inspectBar').hidden = !on; if (!on) { st.sel = null; st.inspectData = null; $('inspector').hidden = true; } drawInspect(); }
for (const id of ['showOrig', 'showCur', 'showCtrl', 'showBox']) $(id).onchange = drawInspect;
function pick(x, y) {
  if (!st.result) return;
  if (!st.idmap) { st.pendingPick = [x, y]; send({ type: 'idmap', index: st.stage }); return; }
  pickAt(x, y);
}
function pickAt(x, y) {
  const m = st.idmap, X = Math.floor((x - m.x) * m.k), Y = Math.floor((y - m.y) * m.k);
  const id = X >= 0 && Y >= 0 && X < m.W && Y < m.H ? m.ids[Y * m.W + X] : -1;
  if (id < 0) { st.sel = null; st.inspectData = null; $('inspector').hidden = true; drawInspect(); return; }
  st.sel = id;
  send({ type: 'inspect', el: id, index: st.stage });
}
function drawInspect() {
  for (const can of [$('canA'), $('canB')]) { const ov = can.querySelector('svg.ov'); if (ov) for (const n of [...ov.children]) if (!n.classList.contains('grp')) n.remove(); }
  const d = st.inspectData;
  if (!st.inspect || !d) return;
  const px = 1 / st.view.z;                               // one screen pixel in user units
  const ns = 'http://www.w3.org/2000/svg';
  const draw = (ov, geo, color, dashed) => {
    const g = document.createElementNS(ns, 'g');
    let path = '';
    const nodes = [], ctrls = [];
    for (const sp of geo.subpaths) {
      if (!sp.segs.length) continue;
      path += `M${sp.segs[0].p[0].join(' ')}`;
      for (const s of sp.segs) {
        if (s.t === 'L') path += `L${s.p[1].join(' ')}`;
        else if (s.t === 'Q') { path += `Q${s.p[1].join(' ')} ${s.p[2].join(' ')}`; ctrls.push([s.p[0], s.p[1]], [s.p[2], s.p[1]]); }
        else if (s.t === 'C') { path += `C${s.p[1].join(' ')} ${s.p[2].join(' ')} ${s.p[3].join(' ')}`; ctrls.push([s.p[0], s.p[1]], [s.p[3], s.p[2]]); }
        else for (const c of s.c) path += `C${c[1].join(' ')} ${c[2].join(' ')} ${c[3].join(' ')}`;
        nodes.push(s.p[0]);
      }
      if (sp.closed) path += 'Z'; else nodes.push(sp.segs[sp.segs.length - 1].p.at(-1));
    }
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', path); p.setAttribute('fill', 'none'); p.setAttribute('stroke', color); p.setAttribute('stroke-width', 1.5 * px);
    if (dashed) p.setAttribute('stroke-dasharray', `${4 * px} ${3 * px}`);
    g.append(p);
    if ($('showCtrl').checked) for (const [a, b] of ctrls) {
      const l = document.createElementNS(ns, 'line');
      l.setAttribute('x1', a[0]); l.setAttribute('y1', a[1]); l.setAttribute('x2', b[0]); l.setAttribute('y2', b[1]); l.setAttribute('stroke', color); l.setAttribute('stroke-width', px); l.setAttribute('opacity', 0.6);
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', b[0]); c.setAttribute('cy', b[1]); c.setAttribute('r', 2.5 * px); c.setAttribute('fill', '#fff'); c.setAttribute('stroke', color); c.setAttribute('stroke-width', px);
      g.append(l, c);
    }
    for (const q of nodes) {
      const r = document.createElementNS(ns, 'rect'), s = (dashed ? 7 : 6) * px;
      r.setAttribute('x', q[0] - s / 2); r.setAttribute('y', q[1] - s / 2); r.setAttribute('width', s); r.setAttribute('height', s);
      r.setAttribute('fill', dashed ? 'none' : color); r.setAttribute('stroke', color); r.setAttribute('stroke-width', px);
      g.append(r);
    }
    if ($('showBox').checked && isFinite(geo.box[0])) {
      const b = document.createElementNS(ns, 'rect');
      b.setAttribute('x', geo.box[0]); b.setAttribute('y', geo.box[1]); b.setAttribute('width', geo.box[2] - geo.box[0]); b.setAttribute('height', geo.box[3] - geo.box[1]);
      b.setAttribute('fill', 'none'); b.setAttribute('stroke', color); b.setAttribute('stroke-width', px); b.setAttribute('stroke-dasharray', `${2 * px} ${2 * px}`); b.setAttribute('opacity', 0.7);
      g.append(b);
    }
    ov.append(g);
  };
  const ovA = $('canA').querySelector('svg.ov'), ovB = $('canB').querySelector('svg.ov');
  const box = windowBox().join(' ');
  for (const ov of [ovA, ovB]) if (ov) ov.setAttribute('viewBox', box);
  const side = st.view.mode === 'side';
  if ($('showOrig').checked) draw(side ? ovA : ovB, d.original, '#e11d48', true);
  if ($('showCur').checked && !d.removed) draw(ovB, d.current, '#2563eb', false);
}
function showInspector() {
  const d = st.inspectData, c = $('inspector');
  if (!d) { c.hidden = true; return; }
  c.hidden = false;
  c.innerHTML = `<h2>فحص الهندسة — ${esc(d.tag)} ${d.idx}${d.id ? ' #' + esc(d.id) : ''}</h2>
    ${d.editable ? '' : `<p class="muted">غير قابل للتعديل: ${esc(d.reason)}</p>`}${d.removed ? '<p class="warn">حُذف هذا العنصر في هذه المرحلة.</p>' : ''}
    <div class="cols"><div>عقد الأصل<br><b>${d.original.nodes}</b></div><div>عقد الآن<br><b>${d.current.nodes}</b></div><div>حدود الأصل<br><b>${d.original.subpaths.length}</b></div><div>حدود الآن<br><b>${d.current.subpaths.length}</b></div></div>
    <p class="muted"><span class="dot o"></span> الأصل (متقطع) &nbsp; <span class="dot c"></span> النتيجة — المربعات: العقد، الدوائر: نقاط التحكم</p>
    ${d.log.length ? `<div class="scroll"><table class="log">${d.log.map((l) => `<tr><td class="${l.accepted ? 'ok' : 'no'}">${l.accepted ? '✓' : '✗'}</td><td><b>${esc(l.label ? ar(l.label) : opAr(l.op))}</b>${l.sub != null ? ` <span class="muted">حد ${l.sub}</span>` : ''} — ${esc(ar(l.reason))}</td></tr>`).join('')}</table></div>` : '<p class="muted">لا تعديلات مسجلة لهذا العنصر.</p>'}`;
}


// ---------------------------------------------------------------- semantic correction (local model)
import { askVision, listModels, PROVIDERS, ANSWER_SCHEMA } from './src/ai.js';
const AI_KEY = 'refine:ai';
try { const c = JSON.parse(localStorage.getItem(AI_KEY) || 'null'); if (c) { $('aiProvider').value = c.provider; $('aiUrl').value = c.url; $('aiModel').value = c.model || ''; } } catch {}
const aiCfg = () => ({ provider: $('aiProvider').value, url: $('aiUrl').value.trim(), model: $('aiModel').value.trim() });
const saveAi = () => { try { localStorage.setItem(AI_KEY, JSON.stringify(aiCfg())); } catch {} };
$('aiProvider').onchange = () => { $('aiUrl').value = PROVIDERS[$('aiProvider').value].url; saveAi(); };
$('aiUrl').onchange = $('aiModel').onchange = saveAi;
$('aiTest').onclick = async () => {
  $('aiStatus').textContent = 'جارٍ الاتصال…';
  try {
    const models = await listModels(aiCfg());
    $('aiModels').innerHTML = models.map((x) => `<option value="${esc(x)}">`).join('');
    if (!$('aiModel').value && models.length) $('aiModel').value = models.find((x) => /vl|vision|gemma3|llava|minicpm|moondream/i.test(x)) || models[0];
    saveAi();
    $('aiStatus').innerHTML = `<span class="ok">متصل ✓</span> — ${models.length} نموذج: ${models.slice(0, 8).map(esc).join('، ')}`;
  } catch (e) { $('aiStatus').innerHTML = `<span class="no">تعذّر الاتصال:</span> ${esc(e.message)}`; }
};
let sem = { groups: [], prompt: '', viewBox: null, output: '', proposals: [], answer: null, useModel: true };
$('aiRun').onclick = () => { sem.useModel = true; startSemantic(); };
$('aiNoModel').onclick = () => { sem.useModel = false; startSemantic(); };
function startSemantic() {
  $('aiStatus').textContent = 'قياس الأجزاء المتكررة…'; $('aiGroups').innerHTML = '';
  send({ type: 'semantic-detect', index: st.stage, exportOptions: exportOptions() });
}
const groupAr = (g) => g.kind === 'radial' ? `${g.count} عنصر متشابه على دائرة، التباعد ${g.gapCV < 0.04 ? 'منتظم' : g.gapCV < 0.15 ? 'غير منتظم قليلاً' : 'غير منتظم'}` : `${g.count} عنصر متشابه في صف`;
async function semGroups(m) {
  Object.assign(sem, { groups: m.groups, prompt: m.prompt, viewBox: m.viewBox, output: m.output, answer: null });
  st.semGroups = m.groups; drawGroupsOverlay();
  if (!m.groups.length) { $('aiStatus').textContent = 'لا توجد أجزاء متكررة يمكن فحصها في هذه الأيقونة.'; return; }
  if (!sem.useModel) { $('aiStatus').textContent = 'بدون نموذج: اكتب العدد الصحيح بنفسك، أو وزّع التباعد بالتساوي.'; send({ type: 'semantic-proposals', answer: null }); return; }
  const cfg = aiCfg();
  if (!cfg.model) { $('aiStatus').innerHTML = '<span class="no">اختر نموذجاً أولاً (اختبار الاتصال).</span>'; return; }
  $('aiStatus').textContent = `النموذج ${cfg.model} يفحص الصورة… (قد يأخذ دقيقة على المعالج)`;
  try {
    const png = await annotatedPNG(m.output, m.groups, m.viewBox);
    const t = performance.now();
    const { answer, raw } = await askVision(cfg, m.prompt, png, ANSWER_SCHEMA);
    sem.answer = answer;
    if (!answer) { $('aiStatus').innerHTML = `<span class="no">رد النموذج ليس JSON صالحاً:</span> <code>${esc(String(raw).slice(0, 200))}</code>`; send({ type: 'semantic-proposals', answer: null }); return; }
    $('aiStatus').innerHTML = `النموذج يرى: <b>${esc(answer.object || '؟')}</b> <span class="muted">(${((performance.now() - t) / 1000).toFixed(1)} ث)</span>`;
    send({ type: 'semantic-proposals', answer });
  } catch (e) { $('aiStatus').innerHTML = `<span class="no">خطأ من النموذج:</span> ${esc(e.message)}`; }
}
function semProposals(list) {
  sem.proposals = list;
  const byG = new Map(list.map((p) => [p.group, p]));
  const meaning = new Map(((sem.answer && sem.answer.groups) || []).map((a) => [+a.id, a]));
  $('aiGroups').innerHTML = `<table class="log">${sem.groups.map((g) => {
    const p = byG.get(g.id), a = meaning.get(g.id);
    const to = p ? p.to : g.count;
    return `<tr><td><label class="chk"><input type="checkbox" data-g="${g.id}" ${p ? 'checked' : ''} ${g.kind !== 'radial' ? 'disabled' : ''}></label></td>
      <td><b>مجموعة ${g.id}</b>: ${groupAr(g)}${a ? `<br>النموذج: ${esc(a.meaning || '')}${a.expected_count ? ` — العدد الصحيح <b>${+a.expected_count}</b>` : ' — أي عدد مقبول'}` : ''}
      ${p ? `<br><span class="${p.source === 'model' ? 'no' : 'muted'}">${p.op === 'count' ? `اقتراح: ${p.from} ← ${p.to}` : 'اقتراح: توزيع متساوٍ'}</span>` : ''}</td>
      <td>${g.kind === 'radial' ? `<input type="number" min="2" max="64" value="${to}" data-n="${g.id}" style="width:56px">` : ''}</td></tr>`;
  }).join('')}</table>
  <div class="row"><button class="btn primary" id="semApply">تطبيق المحدد</button></div>`;
  $('semApply').onclick = () => {
    const items = [];
    for (const cb of $('aiGroups').querySelectorAll('input[data-g]:checked')) {
      const id = +cb.dataset.g, g = sem.groups.find((x) => x.id === id), to = +$('aiGroups').querySelector(`input[data-n="${id}"]`).value, p = byG.get(id);
      items.push({ group: id, to, op: to === g.count ? 'even' : 'count', confidence: p ? p.confidence : 1, reason: p ? p.reason : `manual: ${g.count} -> ${to}` });
    }
    if (!items.length) return;
    busy(true, 'إعادة رسم المجموعات…');
    send({ type: 'semantic-apply', items, exportOptions: exportOptions() });
  };
  for (const inp of $('aiGroups').querySelectorAll('input[data-n]')) inp.oninput = () => { const cb = $('aiGroups').querySelector(`input[data-g="${inp.dataset.n}"]`); if (cb) cb.checked = true; };
}
function semApplied(m) {
  busy(false);
  st.result.stages = m.stages; st.result.log = m.log;
  st.stageData = new Map(); st.stage = m.index; st.idmap = null;
  st.stageData.set(m.index, { output: m.output, integrity: m.integrity, report: m.report, metrics: m.metrics });
  showResult();
  const bad = m.results.filter((r) => !r.ok);
  $('aiStatus').innerHTML = `طُبّق ${m.results.length - bad.length} تصحيح${bad.length ? ` — رُفض ${bad.length}: ${bad.map((r) => esc(r.reason)).join('، ')}` : ''}. قارن مع الأصل في العارض.`;
  st.semGroups = null; drawGroupsOverlay();
}
// numbered rings on the image the model sees (and on the viewer)
function annotatedPNG(svgText, groups, vb) {
  return new Promise((resolve, reject) => {
    const img = new Image(), S = 768, k = S / Math.max(vb[2], vb[3]);
    const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = Math.round(vb[2] * k); c.height = Math.round(vb[3] * k);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      g.lineWidth = 2; g.font = 'bold 20px sans-serif';
      for (const gr of groups) {
        const cx = (gr.kind === 'radial' ? gr.center[0] : gr.first[0]) - vb[0], cy = (gr.kind === 'radial' ? gr.center[1] : gr.first[1]) - vb[1];
        g.strokeStyle = '#e11d48'; g.fillStyle = '#e11d48';
        if (gr.kind === 'radial') { g.beginPath(); g.arc(cx * k, cy * k, gr.radius * k, 0, 7); g.setLineDash([6, 5]); g.stroke(); g.setLineDash([]); }
        const lx = gr.kind === 'radial' ? (cx + gr.radius * 0.72) * k : cx * k, ly = gr.kind === 'radial' ? (cy - gr.radius * 0.72) * k : cy * k - 14;
        g.beginPath(); g.arc(lx, ly, 13, 0, 7); g.fillStyle = '#e11d48'; g.fill(); g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(gr.id), lx, ly + 1);
      }
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/png').split(',')[1]);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not draw the SVG')); };
    img.src = url;
  });
}
function drawGroupsOverlay() {
  const ov = $('canB').querySelector('svg.ov');
  if (!ov) return;
  for (const n of [...ov.querySelectorAll('.grp')]) n.remove();
  if (!st.semGroups) return;
  const ns = 'http://www.w3.org/2000/svg', px = 1 / st.view.z;
  for (const g of st.semGroups) {
    const grp = document.createElementNS(ns, 'g'); grp.setAttribute('class', 'grp');
    if (g.kind === 'radial') {
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', g.center[0]); c.setAttribute('cy', g.center[1]); c.setAttribute('r', g.radius); c.setAttribute('fill', 'none'); c.setAttribute('stroke', '#e11d48'); c.setAttribute('stroke-width', 2 * px); c.setAttribute('stroke-dasharray', `${6 * px} ${5 * px}`);
      grp.append(c);
    }
    const t = document.createElementNS(ns, 'text');
    const x = g.kind === 'radial' ? g.center[0] + g.radius * 0.72 : g.first[0], y = g.kind === 'radial' ? g.center[1] - g.radius * 0.72 : g.first[1] - 14 * px;
    t.setAttribute('x', x); t.setAttribute('y', y); t.setAttribute('font-size', 16 * px); t.setAttribute('font-weight', 'bold'); t.setAttribute('fill', '#e11d48'); t.setAttribute('text-anchor', 'middle'); t.textContent = g.id;
    grp.append(t);
    ov.append(grp);
  }
}


// ---------------------------------------------------------------- source image
function sourceAligned(m) {
  const si = st.srcImage;
  if (!si) return;
  si.T = m.T;
  const good = m.T && m.T.correlation > 0.8;
  $('srcCard').innerHTML = `<h2>الصورة الأصلية</h2><p class="muted"><span dir="ltr">${esc(si.name)}</span> — <span dir="ltr">${si.W}×${si.H}</span></p>` + (good
    ? `<div class="good">وُجد مكان الـSVG في الصورة (تطابق ${(m.T.correlation * 100).toFixed(1)}%). المعالجة الآن تعيد الحواف إلى مكانها في الصورة، ولا تقبل تغييراً إلا إذا قرّب الرسم منها.</div>`
    : `<div class="warn">هذه الصورة لا تطابق ملف الـSVG (تطابق ${m.T ? (m.T.correlation * 100).toFixed(0) : 0}%). لن تُستعمل.</div>`);
  const b = $('leftPane').querySelector('[data-l=img]');
  b.disabled = !good;
  if (good && st.analysis) {
    // the recommendation must reflect the source image: run the dry run again
    st.applied = false;
    busy(true, 'المعالجة مع الصورة الأصلية…');
    send({ type: 'process', mode: st.mode || st.rec.mode, dry: true, exportOptions: exportOptions() });
  }
}
$('leftPane').onclick = (e) => {
  const l = e.target.dataset.l;
  if (!l || e.target.disabled) return;
  st.leftPane = l;
  for (const b of $('leftPane').children) b.setAttribute('aria-pressed', b.dataset.l === l);
  showLeft();
};
function showLeft() {
  const si = st.srcImage;
  if (st.leftPane === 'img' && si && si.T && st.view.vb) {
    // the image placed in the SVG's coordinates (inverse of the alignment)
    const { s, tx, ty } = si.T, vb = st.view.vb;
    const text = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(' ')}" width="${vb[2]}" height="${vb[3]}"><image href="${si.url}" x="${-tx / s}" y="${-ty / s}" width="${si.W / s}" height="${si.H / s}" preserveAspectRatio="none"/></svg>`;
    mount($('canA'), text);
    $('paneA').querySelector('.tag').textContent = 'الصورة الأصلية';
  } else if (st.original) { mount($('canA'), st.original); $('paneA').querySelector('.tag').textContent = 'الأصل'; }
}
