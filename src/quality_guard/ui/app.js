// Quality Guard — the app. Plain modules, no build step.

const token = new URLSearchParams(location.search).get("t") || "";
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const fmt = new Intl.NumberFormat("en-US");
const VERDICTS = ["pass", "review", "reject"];
const LABEL = { pass: "مقبول", review: "مراجعة", reject: "مرفوض" };
const LEVEL = { info: "ملاحظة", review: "مراجعة", reject: "رفض" };
const LEVEL_CLASS = { info: "info", review: "review", reject: "reject" };

const ICONS = {
  gear: '<path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
  sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  gauge: '<path d="M12 14l4-4"/><path d="M3.3 17a9 9 0 1 1 17.4 0"/><circle cx="12" cy="14" r="1.5"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
  play: '<path d="M7 5v14l12-7L7 5Z" fill="currentColor"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
  sort: '<path d="M4 7h10M4 12h7M4 17h4"/><path d="m17 9 3-3 3 3M20 6v12" transform="translate(-3 0)"/>',
  alert: '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17.5v.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.01"/>',
  "chevron-left": '<path d="m15 5-7 7 7 7"/>',
  "chevron-right": '<path d="m9 5 7 7-7 7"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
const paintIcons = (root = document) => $$("[data-icon]", root).forEach((el) => { el.innerHTML = icon(el.dataset.icon); });

// Isolate a left-to-right run (numbers, sizes, percentages) inside Arabic text.
const iso = (s) => `\u2066${s}\u2069`;
function plural(n, one, two, few, many) {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return `${iso(n)} ${few}`;
  return `${iso(n)} ${many}`;
}
const duration = (sec) => sec < 90
  ? plural(Math.max(1, Math.round(sec)), "ثانية", "ثانيتين", "ثوانٍ", "ثانية")
  : plural(Math.round(sec / 60), "دقيقة", "دقيقتين", "دقائق", "دقيقة");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, body) {
  const res = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-QG-Token": token, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const media = (kind, id) => `/api/${kind}/${id}?t=${encodeURIComponent(token)}`;

function toast(message, kind = "pass", ms = 3600) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === "reject" ? "alert" : kind === "info" ? "info" : "check")}<span>${esc(message)}</span>`;
  $("#toasts").append(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 300); }, ms);
}

function countUp(el, to) {
  const from = Number(el.dataset.v || 0);
  el.dataset.v = to;
  if (from === to || matchMedia("(prefers-reduced-motion: reduce)").matches) { el.textContent = fmt.format(to); return; }
  const start = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - start) / 700);
    el.textContent = fmt.format(Math.round(from + (to - from) * (1 - (1 - k) ** 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------------------------------------------------------------- state

const S = {
  app: null,        // /api/state
  results: null,    // /api/results
  byId: new Map(),
  filter: "all",
  rule: null,
  query: "",
  sort: "priority",
  list: [],         // ids currently shown, in order
  current: -1,      // index into list for the viewer
  polling: null,
  shown: new Set(),
};

function setView(name) {
  for (const v of ["start", "scan", "results", "error"]) $(`#view-${v}`).hidden = v !== name;
  const order = ["start", "scan", "results", "apply"];
  const at = name === "results" && S.results?.applied ? 3 : order.indexOf(name === "error" ? "start" : name);
  $$(".steps span").forEach((el, i) => { el.classList.toggle("on", i === at); el.classList.toggle("done", i < at); });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---------------------------------------------------------------- theme

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $("#btn-theme");
  btn.dataset.icon = theme === "dark" ? "sun" : "moon";
  btn.innerHTML = icon(btn.dataset.icon);
  try { localStorage.setItem("qg-theme", theme); } catch { /* private mode */ }
}
function initTheme() {
  let theme = null;
  try { theme = localStorage.getItem("qg-theme"); } catch { /* private mode */ }
  applyTheme(theme || "dark");
  $("#btn-theme").addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
}

// ---------------------------------------------------------------- start view

function renderStart() {
  const a = S.app;
  const hw = a.hardware;
  $("#hw-text").textContent = [hw.gpu, `${Math.round(hw.ram_gb)} GB`, `${hw.jobs} عامل`].filter(Boolean).join(" · ");

  const recent = $("#recent");
  recent.innerHTML = a.recent.map((f) => `<button type="button" title="${esc(f)}">${esc(f)}</button>`).join("");
  $$("button", recent).forEach((b) => b.addEventListener("click", () => { $("#folder-input").value = b.title; }));
  if (!$("#folder-input").value && a.recent[0]) $("#folder-input").value = a.recent[0];

  const localReady = a.local_ai.ocr || a.local_ai.faces;
  const local = $("#opt-local");
  local.checked = localReady && a.options.local_ai;
  local.disabled = !localReady;
  $("#opt-local-row").classList.toggle("disabled", !localReady);
  if (!localReady) {
    $("#local-desc").innerHTML = 'غير مثبت بعد. شغّل <b>install-gpu-windows.bat</b> مرة واحدة لتفعيله على كرت الشاشة.';
  }

  const vision = $("#opt-vision");
  vision.checked = a.vision.key && a.options.vision;
  vision.disabled = !a.vision.key;
  $("#opt-vision-row").classList.toggle("disabled", !a.vision.key);
  const per100 = a.vision.per_100 ? ` تقريباً $${a.vision.per_100.toFixed(1)} لكل 100 صورة.` : "";
  $("#vision-desc").innerHTML = a.vision.key
    ? `عيوب الأيدي والأجسام، الشعارات، الأعمال الفنية، المحتوى المحظور، والقيمة التجارية.${esc(per100)}`
    : 'يحتاج مفتاح Claude API. أضفه من <button type="button" class="link" id="open-settings-inline">الإعدادات</button>.';
  $("#open-settings-inline")?.addEventListener("click", (e) => { e.preventDefault(); openDrawer(); });
  $("#opt-recursive").checked = !!a.options.recursive;

  const groups = ["المواصفات التقنية", "جودة الصورة", "عيوب الذكاء الاصطناعي", "قواعد المحتوى المولّد", "الملكية الفكرية",
    "الأشخاص والممتلكات", "التشابه والتكرار", "القيمة التجارية", "عناصر مرئية ممنوعة", "العنوان والكلمات", "المحتوى المحظور"];
  $("#rule-chips").innerHTML = groups.map((g) => `<span>${g}</span>`).join("");
}

async function pickFolder() {
  try {
    const { path } = await api("pick", { initial: $("#folder-input").value });
    if (path) { $("#folder-input").value = path; toast("تم اختيار المجلد", "info", 1800); }
  } catch (e) { toast(e.message, "reject"); }
}

async function startScan() {
  const input = $("#folder-input").value.trim();
  if (!input) { toast("اختر مجلد الصور أولاً", "review"); $("#folder-input").focus(); return; }
  const btn = $("#btn-start");
  btn.disabled = true;
  try {
    await api("scan", {
      input, recursive: $("#opt-recursive").checked, local_ai: $("#opt-local").checked, vision: $("#opt-vision").checked,
    });
    beginScanView(input);
  } catch (e) {
    toast(e.message, "reject");
  } finally { btn.disabled = false; }
}

// ---------------------------------------------------------------- scan view

function beginScanView(folder) {
  S.shown = new Set();
  $("#mosaic").innerHTML = "";
  $("#scan-folder").textContent = folder || "";
  ["pass", "review", "reject"].forEach((v) => { const el = $(`#c-${v}`); el.dataset.v = 0; el.textContent = "0"; });
  $$("#stages li").forEach((li) => li.classList.remove("on", "done", "skip"));
  if (!$("#opt-local").checked) $('#stages li[data-stage="local"]').classList.add("skip");
  if (!$("#opt-vision").checked) $('#stages li[data-stage="vision"]').classList.add("skip");
  setView("scan");
  clearInterval(S.polling);
  S.polling = setInterval(poll, 450);
  poll();
}

const STAGE_TITLE = { analyze: `نفحص كل صورة بتكبير ${iso("100%")}…`, similar: "نبحث عن الصور المتشابهة…", local: "ذكاء جهازك يقرأ النصوص ويبحث عن الوجوه…", vision: "Claude يراجع الصور بصرياً…", done: "ننهي التقرير…" };

async function poll() {
  let p;
  try { p = await api("progress"); } catch { return; }
  const order = ["analyze", "similar", "local", "vision", "done"];
  const at = order.indexOf(p.stage);
  $$("#stages li").forEach((li) => {
    const i = order.indexOf(li.dataset.stage);
    li.classList.toggle("on", i === at);
    li.classList.toggle("done", at > i);
  });
  const frac = p.total ? p.done / p.total : 0;
  const ring = $("#ring-bar");
  ring.style.strokeDashoffset = String(552.9 * (1 - (p.stage === "analyze" || p.stage === "local" || p.stage === "vision" ? frac : p.stage ? 1 : 0)));
  $("#pct").textContent = `${Math.round((p.stage ? frac : 0) * 100)}%`;
  $("#count").textContent = `${iso(fmt.format(p.done))} من ${iso(fmt.format(p.total))}`;
  $("#scan-title").textContent = STAGE_TITLE[p.stage] || "نجهّز الفحص…";
  $("#current").textContent = p.current ? `الآن: ${p.current}` : "";
  for (const v of VERDICTS) countUp($(`#c-${v}`), p.counts[v] || 0);
  if (p.elapsed > 1 && p.done && p.stage === "analyze") {
    const rate = p.done / p.elapsed;
    const left = Math.max(0, (p.total - p.done) / rate);
    $("#rate").textContent = `${iso(rate.toFixed(1))} صورة في الثانية · متبقٍ تقريباً ${duration(left)}`;
  }
  const mosaic = $("#mosaic");
  for (const item of p.recent) {
    if (S.shown.has(item.id)) continue;
    S.shown.add(item.id);
    const tile = document.createElement("div");
    tile.className = item.verdict;
    if (item.thumb) {
      const im = document.createElement("img");
      im.alt = "";
      im.src = media("thumb", item.id);
      tile.append(im);
    } else {
      const ext = document.createElement("span");
      ext.textContent = item.ext;
      tile.append(ext);
    }
    mosaic.prepend(tile);
    while (mosaic.children.length > 36) mosaic.lastChild.remove();
  }

  if (p.status === "done") { clearInterval(S.polling); await loadResults(true); }
  else if (p.status === "cancelled") { clearInterval(S.polling); toast("أُوقف الفحص", "review"); await boot(); }
  else if (p.status === "error") { clearInterval(S.polling); $("#error-text").textContent = p.error; setView("error"); }
}

// ---------------------------------------------------------------- results

async function loadResults(fresh = false) {
  S.results = await api("results");
  S.byId = new Map(S.results.files.map((f) => [f.id, f]));
  if (fresh) { S.filter = "all"; S.rule = null; S.query = ""; $("#search").value = ""; }
  renderResults();
  setView("results");
}

function topFinding(f) {
  const order = { reject: 2, review: 1, info: 0 };
  return [...f.findings].sort((a, b) => order[b.level] - order[a.level])[0];
}

function renderSummary() {
  const r = S.results;
  const total = r.files.length || 1;
  for (const v of VERDICTS) {
    const n = r.counts[v];
    countUp($(`#s-${v}`), n);
    $(`#b-${v}`).style.width = `${(n / total) * 100}%`;
    $(`#p-${v}`).textContent = `${iso(`${Math.round((n / total) * 100)}%`)} من الصور`;
    $(`#n-${v}`).textContent = fmt.format(n);
  }
  $("#n-all").textContent = fmt.format(r.files.length);
  const C = 2 * Math.PI * 48;
  let offset = 0;
  for (const v of VERDICTS) {
    const len = (r.counts[v] / total) * C;
    const el = $(`#d-${v}`);
    el.setAttribute("stroke-dasharray", `${len} ${C - len}`);
    el.setAttribute("stroke-dashoffset", String(-offset));
    offset += len;
  }
  $("#d-pct").textContent = `${Math.round((r.counts.pass / total) * 100)}%`;
  $("#d-note").textContent = r.counts.review ? `و${fmt.format(r.counts.review)} تنتظر قرارك` : "لا شيء ينتظر قرارك";
  $$(".stat").forEach((b) => b.classList.toggle("active", b.dataset.filter === S.filter));
  $$("#seg button").forEach((b) => b.classList.toggle("on", b.dataset.f === S.filter));
}

function renderResults() {
  const r = S.results;
  $("#res-title").textContent = `${fmt.format(r.files.length)} ملف فُحص`;
  const facts = [`<span class="ltr mono">${esc(r.input)}</span>`, `في ${duration(r.seconds)}`, `${iso(r.jobs)} صور تُفحص معاً`];
  if (r.local_ai.startsWith("on")) facts.push(`ذكاء محلي: ${esc(r.local_ai.slice(4))}`);
  if (r.vision === "on") facts.push(`Claude: ${r.vision_calls} طلب${r.cost != null ? ` · $${r.cost.toFixed(2)}` : ""}`);
  $("#res-sub").innerHTML = facts.map((f) => `<span>${f}</span>`).join("");

  const notes = [];
  if (r.vision !== "on") {
    const why = r.vision === "off" ? "" : ` (${esc(r.vision)})`;
    notes.push(["info", "eye", `لم تعمل مراجعة Claude البصرية${why}، فالأيدي المشوهة والشعارات غير النصية والأعمال الفنية لم تُفحص إلا بعينك.`]);
  }
  if (!r.local_ai.startsWith("on") && r.local_ai !== "off") notes.push(["info", "chip", `الذكاء المحلي لم يعمل: ${esc(r.local_ai)}`]);
  if (r.csv) notes.push(["info", "doc", `العناوين والكلمات من <span class="ltr mono">${esc(r.csv)}</span>`]);
  for (const w of r.csv_warnings) notes.push(["review", "alert", `CSV: ${esc(w)}`]);
  notes.push(["accent", "spark", "<b>مرفوض</b> = مخالفة مقيسة لقاعدة منشورة. <b>مراجعة</b> = خطر يحتاج نظرك. <b>مقبول</b> = لم تظهر مشكلة، لكن Adobe قد يرفض لأسباب ذوقية لا تُقاس مسبقاً."]);
  $("#notices").innerHTML = notes.map(([c, i, t]) => `<div class="notice ${c}">${icon(i)}<p>${t}</p></div>`).join("");

  renderReasons();
  renderSummary();
  renderGrid();
  renderActionbar();
}

function renderReasons() {
  const r = S.results;
  const max = Math.max(1, ...r.reasons.map((x) => x.count));
  const list = $("#reasons");
  if (!r.reasons.length) { list.innerHTML = '<li class="none">لا توجد أسباب رفض أو مراجعة. ممتاز.</li>'; return; }
  list.innerHTML = r.reasons.slice(0, 14).map((x) => {
    const cls = x.level === 2 ? "reject" : "review";
    return `<li><button type="button" class="${cls}${S.rule === x.rule ? " on" : ""}" data-rule="${esc(x.rule)}">
      <span class="r-msg">${esc(x.message)}</span><span class="r-count num">${fmt.format(x.count)}</span>
      <span class="r-bar"><i style="width:${(x.count / max) * 100}%"></i></span></button></li>`;
  }).join("");
  $$("button", list).forEach((b) => b.addEventListener("click", () => {
    S.rule = S.rule === b.dataset.rule ? null : b.dataset.rule;
    renderReasons();
    renderGrid();
  }));
}

function filtered() {
  const q = S.query.trim().toLowerCase();
  const order = { review: 0, reject: 1, pass: 2 };
  const weight = (f) => f.findings.reduce((s, x) => s + (x.level === "reject" ? 10 : x.level === "review" ? 3 : 0), 0);
  let files = S.results.files.filter((f) =>
    (S.filter === "all" || f.verdict === S.filter)
    && (!S.rule || f.findings.some((x) => x.rule === S.rule))
    && (!q || f.file.toLowerCase().includes(q) || f.findings.some((x) => x.message.toLowerCase().includes(q))));
  const sorters = {
    priority: (a, b) => order[a.verdict] - order[b.verdict] || weight(b) - weight(a) || a.file.localeCompare(b.file),
    name: (a, b) => a.file.localeCompare(b.file, undefined, { numeric: true }),
    sharp: (a, b) => (a.metrics.sharpness ?? 99) - (b.metrics.sharpness ?? 99),
    size: (a, b) => b.megapixels - a.megapixels,
  };
  files = files.sort(sorters[S.sort]);
  return files;
}

function cardHTML(f) {
  const top = topFinding(f);
  const reason = top && top.level !== "info" ? esc(top.message) : "لم تظهر أي مشكلة";
  const chips = [];
  if (f.width) chips.push(iso(`${f.megapixels.toFixed(1)} MP`));
  if (f.metrics.sharpness != null) chips.push(`حدة ${iso(Number(f.metrics.sharpness).toFixed(2))}`);
  if (f.metadata.ai_generated) chips.push("AI");
  if (f.vision_checked) chips.push("Claude");
  const thumb = ["jpeg", "png"].includes(f.kind)
    ? `<img loading="lazy" alt="" src="${media("thumb", f.id)}">`
    : f.kind === "svg" ? `<img loading="lazy" alt="" src="${media("file", f.id)}" style="object-fit:contain;padding:12px">`
      : `<span class="ext">${esc(f.file.split(".").pop().toUpperCase())}</span>`;
  return `<article class="gcard ${f.verdict}" tabindex="0" data-id="${f.id}" aria-label="${esc(f.file)} — ${LABEL[f.verdict]}">
    <div class="gthumb">${thumb}<span class="vpill">${LABEL[f.verdict]}</span>${f.overridden ? '<span class="manual">يدوي</span>' : ""}</div>
    <div class="gbody"><p class="gname" title="${esc(f.file)}">${esc(f.file)}</p>
    <p class="greason${top && top.level !== "info" ? "" : " ok"}">${reason}</p>
    <div class="gchips">${chips.map((c) => `<span class="num">${c}</span>`).join("")}</div></div></article>`;
}

function renderGrid() {
  const files = filtered();
  S.list = files.map((f) => f.id);
  $("#grid").innerHTML = files.map(cardHTML).join("");
  $("#empty").hidden = files.length > 0;
  const chip = $("#rule-filter");
  if (S.rule) {
    const reason = S.results.reasons.find((x) => x.rule === S.rule);
    chip.innerHTML = `<span class="rule-chip ${reason?.level === 2 ? "reject" : "review"}">${esc((reason?.message || S.rule).slice(0, 38))}… <button type="button" aria-label="إلغاء التصفية">×</button></span>`;
    $("button", chip).addEventListener("click", () => { S.rule = null; renderReasons(); renderGrid(); });
  } else chip.innerHTML = "";
}

function renderActionbar() {
  const r = S.results;
  const c = r.counts;
  const applied = r.applied;
  $("#ab-text").innerHTML = applied
    ? `وُزّعت الملفات: <b>${fmt.format(applied.counts.pass)}</b> مقبول · <b>${fmt.format(applied.counts.review)}</b> مراجعة · <b>${fmt.format(applied.counts.reject)}</b> مرفوض`
    : `راجع ما تحتاجه، ثم انسخ الملفات إلى <b>pass</b> (${fmt.format(c.pass)}) و<b>review</b> (${fmt.format(c.review)}) و<b>reject</b> (${fmt.format(c.reject)})`;
  $("#btn-open-out").hidden = !applied;
  $("#btn-report").hidden = !applied;
  $("#btn-apply").innerHTML = `${icon("sort")}${applied ? "وزّع من جديد" : "وزّع الملفات على المجلدات"}`;
  const at = applied ? 3 : 2;
  $$(".steps span").forEach((el, i) => { el.classList.toggle("on", i === at); el.classList.toggle("done", i < at); });
}

async function applyPiles() {
  const btn = $("#btn-apply");
  btn.disabled = true;
  try {
    S.results.applied = await api("apply", {});
    renderActionbar();
    toast("وُزّعت الملفات، وكُتب التقرير", "pass");
  } catch (e) { toast(e.message, "reject"); }
  finally { btn.disabled = false; }
}

async function setVerdict(id, verdict) {
  try {
    const res = await api("override", { id, verdict });
    const f = S.byId.get(id);
    f.verdict = res.verdict;
    f.overridden = res.overridden;
    S.results.counts = res.counts;
    S.results.applied = null;
    renderSummary();
    renderActionbar();
    const card = $(`.gcard[data-id="${id}"]`);
    if (card) card.outerHTML = cardHTML(f);
    if (!$("#viewer").hidden) renderViewerPanel();
    toast(res.overridden ? `صار الحكم: ${LABEL[res.verdict]}` : "عاد حكم الأداة", "info", 1600);
  } catch (e) { toast(e.message, "reject"); }
}

// ---------------------------------------------------------------- viewer

const V = { scale: 1, fit: 1, x: 0, y: 0, zoomed: false, drag: null, nw: 0, nh: 0 };

function openViewer(id) {
  S.current = S.list.indexOf(id);
  if (S.current < 0) return;
  $("#viewer").hidden = false;
  document.body.style.overflow = "hidden";
  showCurrent();
  $("#v-close").focus();
}
function closeViewer() {
  $("#viewer").hidden = true;
  document.body.style.overflow = "";
  const card = $(`.gcard[data-id="${S.list[S.current]}"]`);
  card?.focus();
}
function step(delta) {
  if (!S.list.length) return;
  S.current = (S.current + delta + S.list.length) % S.list.length;
  showCurrent();
}

function showCurrent() {
  const f = S.byId.get(S.list[S.current]);
  const img = $("#v-img");
  V.zoomed = false;
  $("#v-stage").classList.remove("zoomed");
  img.onload = null;
  const full = ["jpeg", "png", "svg"].includes(f.kind) ? media("file", f.id) : null;
  const thumb = ["jpeg", "png"].includes(f.kind) ? media("thumb", f.id) : null;
  img.removeAttribute("src");
  $("#v-loading").hidden = !full;
  const load = (src, final) => {
    img.onload = () => {
      const w = img.naturalWidth || 1000, h = img.naturalHeight || 1000;
      if (final) {
        $("#v-loading").hidden = true;
        V.nw = w; V.nh = h;  // browsers apply EXIF rotation, so these are the upright dimensions
      } else if (f.width) {
        // Show the preview at the full image's size so zooming continues seamlessly.
        const long = Math.max(f.width, f.height), short = Math.min(f.width, f.height);
        [V.nw, V.nh] = w >= h ? [long, short] : [short, long];
      } else { V.nw = w; V.nh = h; }
      fitImage();
    };
    img.src = src;
  };
  if (thumb) load(thumb, !full);
  if (full) {
    const pre = new Image();
    pre.onload = () => { if (S.byId.get(S.list[S.current]) === f) load(full, true); };
    pre.onerror = () => { $("#v-loading").hidden = true; };
    pre.src = full;
  }
  renderViewerPanel();
}

function stageBox() { const r = $("#v-stage").getBoundingClientRect(); return { w: r.width, h: r.height }; }
function paint() {
  const img = $("#v-img");
  img.style.width = `${V.nw}px`;
  img.style.height = `${V.nh}px`;
  img.style.transform = `translate(${V.x}px, ${V.y}px) scale(${V.scale})`;
  const pct = Math.round(V.scale * devicePixelRatio * 100);
  $("#v-zoom").textContent = V.zoomed ? iso(`${pct}%`) : `ملاءمة · ${iso(`${pct}%`)}`;
}
function fitImage() {
  const { w, h } = stageBox();
  if (!V.nw) return;
  V.fit = Math.min((w - 40) / V.nw, (h - 40) / V.nh, 1 / devicePixelRatio);
  V.scale = V.fit;
  V.x = (w - V.nw * V.scale) / 2;
  V.y = (h - V.nh * V.scale) / 2;
  V.zoomed = false;
  $("#v-stage").classList.remove("zoomed");
  paint();
}
function zoomAt(px, py, scale) {
  const ix = (px - V.x) / V.scale;
  const iy = (py - V.y) / V.scale;
  V.scale = scale;
  V.x = px - ix * scale;
  V.y = py - iy * scale;
  V.zoomed = scale > V.fit * 1.01;
  $("#v-stage").classList.toggle("zoomed", V.zoomed);
  clampPan();
  paint();
}
function clampPan() {
  const { w, h } = stageBox();
  const iw = V.nw * V.scale, ih = V.nh * V.scale;
  V.x = iw <= w ? (w - iw) / 2 : Math.min(0, Math.max(w - iw, V.x));
  V.y = ih <= h ? (h - ih) / 2 : Math.min(0, Math.max(h - ih, V.y));
}
function toggleZoom(px, py) {
  const { w, h } = stageBox();
  if (V.zoomed) fitImage();
  else zoomAt(px ?? w / 2, py ?? h / 2, 1 / devicePixelRatio);
}

function initViewer() {
  const stage = $("#v-stage");
  stage.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".v-nav")) return;
    V.drag = { x: e.clientX, y: e.clientY, ox: V.x, oy: V.y, moved: false };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener("pointermove", (e) => {
    if (!V.drag) return;
    const dx = e.clientX - V.drag.x, dy = e.clientY - V.drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) V.drag.moved = true;
    if (V.zoomed && V.drag.moved) {
      stage.classList.add("dragging");
      V.x = V.drag.ox + dx; V.y = V.drag.oy + dy;
      clampPan(); paint();
    }
  });
  stage.addEventListener("pointerup", (e) => {
    stage.classList.remove("dragging");
    if (V.drag && !V.drag.moved && !e.target.closest(".v-nav")) {
      const r = stage.getBoundingClientRect();
      toggleZoom(e.clientX - r.left, e.clientY - r.top);
    }
    V.drag = null;
  });
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    const next = Math.min(Math.max(V.scale * Math.exp(-e.deltaY * 0.0015), V.fit), 4 / devicePixelRatio);
    zoomAt(e.clientX - r.left, e.clientY - r.top, next);
  }, { passive: false });
  window.addEventListener("resize", () => { if (!$("#viewer").hidden) fitImage(); });
  $("#v-prev").addEventListener("click", () => step(-1));
  $("#v-next").addEventListener("click", () => step(1));
  $("#v-close").addEventListener("click", closeViewer);
  $$("#v-seg button").forEach((b) => b.addEventListener("click", () => setVerdict(S.list[S.current], b.dataset.v)));
  $("#v-reset").addEventListener("click", () => setVerdict(S.list[S.current], "auto"));
  $("#v-reveal").addEventListener("click", () => api("open", { what: "file", id: S.list[S.current] }).catch((e) => toast(e.message, "reject")));
  document.addEventListener("keydown", (e) => {
    if ($("#viewer").hidden || e.target.matches("input, select, textarea")) return;
    const k = e.key;
    if (k === "Escape") closeViewer();
    else if (k === "ArrowLeft") step(1);
    else if (k === "ArrowRight") step(-1);
    else if (k === "z" || k === "Z" || k === " ") { e.preventDefault(); toggleZoom(); }
    else if (["1", "2", "3"].includes(k)) setVerdict(S.list[S.current], VERDICTS[Number(k) - 1]);
    else if (k === "0") setVerdict(S.list[S.current], "auto");
  });
}

function gauge(label, value, text, { max, mark, good = "high" }) {
  const k = Math.max(0, Math.min(1, value / max));
  const ok = good === "high" ? value >= mark : value <= mark;
  return `<div class="metric ${ok ? "pass" : "review"}"><div class="top"><span>${label}</span><b class="num">${iso(text)}</b></div>
    <div class="gauge"><i style="width:${k * 100}%"></i><u style="inset-inline-start:${Math.min(1, mark / max) * 100}%" title="الحد"></u></div></div>`;
}

function renderViewerPanel() {
  const f = S.byId.get(S.list[S.current]);
  if (!f) return;
  $("#v-name").textContent = f.file;
  const facts = [];
  if (f.width) facts.push(iso(`${f.width}×${f.height}`), iso(`${f.megapixels.toFixed(1)} MP`));
  facts.push(iso(`${(f.size_bytes / 1e6).toFixed(1)} MB`), f.kind.toUpperCase(), `${iso(S.current + 1)} من ${iso(S.list.length)}`);
  $("#v-facts").textContent = facts.join(" · ");
  $$("#v-seg button").forEach((b) => b.classList.toggle("on", b.dataset.v === f.verdict));
  $("#v-auto").textContent = f.overridden ? `حكم الأداة: ${LABEL[f.computed_verdict]} · غيّرته يدوياً` : "حكم الأداة";
  $("#v-reset").hidden = !f.overridden;

  const groups = S.results.groups;
  const order = { reject: 0, review: 1, info: 2 };
  const items = [...f.findings].sort((a, b) => order[a.level] - order[b.level]);
  $("#v-findings").innerHTML = items.length
    ? items.map((x) => `<li class="${LEVEL_CLASS[x.level]}"><div><span class="lv">${LEVEL[x.level]}</span> <span class="g">· ${esc(groups[x.group] || x.group)}</span>
        <p class="m">${esc(x.message)}</p>${x.detail ? `<p class="d">${esc(x.detail)}</p>` : ""}</div></li>`).join("")
    : `<li class="clean" style="grid-template-columns:auto 1fr">${icon("check")}<span>لم تظهر أي مشكلة في الفحوص</span></li>`;

  const m = f.metrics;
  const th = S.app.thresholds;
  const parts = [];
  if (m.sharpness != null) parts.push(gauge(`الحدة بتكبير ${iso("100%")}`, m.sharpness, Number(m.sharpness).toFixed(2), { max: 2, mark: th["quality.sharpness_review"].value }));
  if (m.noise != null) parts.push(gauge("الضوضاء في المناطق الملساء", m.noise, Number(m.noise).toFixed(1), { max: 12, mark: th["quality.noise_review"].value, good: "low" }));
  if (m.jpeg_quality != null) parts.push(gauge("جودة ضغط JPEG", m.jpeg_quality, `${m.jpeg_quality} / 100`, { max: 100, mark: th["technical.jpeg_quality_review"].value }));
  if (f.width) parts.push(gauge("الدقة", f.megapixels, `${f.megapixels.toFixed(1)} MP`, { max: 50, mark: 4 }));
  const kv = [];
  if (m.icc) kv.push(["ملف الألوان", esc(m.icc)]);
  if (m.faces != null) kv.push(["الوجوه", fmt.format(m.faces)]);
  if (m.text_regions != null) kv.push(["مناطق نص", fmt.format(m.text_regions)]);
  if (f.metadata.ai_generated) kv.push(["ذكاء اصطناعي", esc(f.metadata.ai_evidence || "نعم")]);
  kv.push(["فُحصت بـ", [f.local_checked && "ذكاء جهازك", f.vision_checked && "Claude", "القياس"].filter(Boolean).join(" + ")]);
  $("#v-metrics").innerHTML = parts.join("") + `<dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;

  const bad = new Set(f.findings.filter((x) => x.rule.startsWith("meta.blocked")).map((x) => x.detail.toLowerCase()));
  const md = f.metadata;
  $("#v-meta").innerHTML = md.title || md.keywords.length
    ? `<dl class="kv"><dt>العنوان</dt><dd class="ltr" style="text-align:right">${esc(md.title) || "—"}</dd>
       <dt>المصدر</dt><dd>${md.source === "csv" ? "ملف CSV" : "داخل الملف"}</dd></dl>
       <div class="kw" style="margin-top:10px">${md.keywords.map((k) => `<span class="${[...bad].some((b) => k.toLowerCase().includes(b)) ? "bad" : ""}">${esc(k)}</span>`).join("")}</div>`
    : '<p class="muted" style="font-size:.86rem">لا يوجد عنوان ولا كلمات مفتاحية؛ أضفها في بوابة Adobe أو في ملف CSV بجانب الصور.</p>';
}

// ---------------------------------------------------------------- settings drawer

function openDrawer() {
  renderDrawer();
  $("#scrim").hidden = false;
  $("#drawer").hidden = false;
  $("#d-close").focus();
}
function closeDrawer() { $("#scrim").hidden = true; $("#drawer").hidden = true; }

const TH_LABEL = {
  "quality.sharpness_review": ["حد الحدة للمراجعة", "أعلى = أكثر صرامة مع الصور اللينة"],
  "quality.noise_review": ["حد الضوضاء للمراجعة", "أقل = أكثر صرامة مع الحبيبات"],
  "technical.jpeg_quality_review": ["أقل جودة JPEG مقبولة", "تحتها تذهب الصورة للمراجعة"],
  "technical.png_margin_review": ["الفراغ المسموح حول عنصر PNG", "نسبة من كل جانب"],
  "similarity.similar_distance": ["حساسية كشف التشابه", "أعلى = يعتبر صوراً أبعد متشابهة"],
  "similarity.max_similar": ["أقصى عدد من المشهد نفسه", "الزائد يذهب للمراجعة"],
};

function renderDrawer() {
  const a = S.app;
  const hw = a.hardware;
  $("#hw-grid").innerHTML = [
    [hw.gpu || "لا يوجد", "كرت الشاشة"], [`${Math.round(hw.ram_gb)} GB`, "الذاكرة"],
    [hw.cores, "أنوية المعالج"], [hw.jobs, "صور تُفحص معاً"],
  ].map(([b, s]) => `<div><b class="num">${esc(b)}</b><span>${s}</span></div>`).join("");
  $("#hw-note").textContent = a.local_ai.ocr
    ? "الذكاء المحلي مثبت. يعمل على كرت الشاشة إن كانت نسخة PyTorch تدعم CUDA."
    : "لتفعيل الذكاء المحلي على كرت الشاشة شغّل install-gpu-windows.bat مرة واحدة.";
  $("#s-model").innerHTML = a.vision.models.map((m) => `<option value="${m}" ${m === a.vision.model ? "selected" : ""}>${m}</option>`).join("");
  $("#s-remember").checked = a.vision.remembered;
  $("#s-key").placeholder = a.vision.key ? "المفتاح محفوظ لهذه الجلسة — اكتب مفتاحاً جديداً لتغييره" : "sk-ant-…";
  $("#s-cost").textContent = a.vision.per_100 ? `تكلفة تقديرية: $${a.vision.per_100.toFixed(1)} لكل 100 صورة مع ${a.vision.model}.` : "";
  $("#s-thresholds").innerHTML = Object.entries(a.thresholds).map(([k, t]) => {
    const [label, hint] = TH_LABEL[k] || [k, ""];
    return `<label class="slider"><span class="top"><span>${label}</span><b class="num" id="tv-${k.replace(".", "-")}">${t.value}</b></span>
      <input type="range" min="${t.min}" max="${t.max}" step="${t.step}" value="${t.value}" data-key="${k}"><small>${hint}</small></label>`;
  }).join("");
  $$("#s-thresholds input").forEach((inp) => {
    inp.addEventListener("input", () => { $(`#tv-${inp.dataset.key.replace(".", "-")}`).textContent = inp.value; });
    inp.addEventListener("change", () => saveThresholds({ [inp.dataset.key]: Number(inp.value) }));
  });
}

async function saveThresholds(values) {
  try { S.app = await api("settings", { thresholds: values }); toast("حُفظت الحدود، وتُطبّق على الفحص القادم", "info", 2200); }
  catch (e) { toast(e.message, "reject"); }
}

async function saveVision() {
  const body = { vision_model: $("#s-model").value, remember: $("#s-remember").checked };
  const key = $("#s-key").value.trim();
  if (key) body.api_key = key;
  try {
    S.app = await api("settings", body);
    $("#s-key").value = "";
    renderDrawer();
    if (!$("#view-start").hidden) renderStart();
    toast("حُفظت إعدادات Claude", "pass", 2000);
  } catch (e) { toast(e.message, "reject"); }
}

// ---------------------------------------------------------------- boot

async function boot() {
  S.app = await api("state");
  renderStart();
  const p = await api("progress");
  if (p.status === "running") beginScanView(S.app.recent[0]);
  else if (p.status === "done") await loadResults();
  else setView("start");
}

function wire() {
  paintIcons();
  initTheme();
  initViewer();
  $("#btn-pick").addEventListener("click", pickFolder);
  $("#folder-visual").addEventListener("click", pickFolder);
  $("#folder-visual").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickFolder(); } });
  $("#folder-input").addEventListener("keydown", (e) => { if (e.key === "Enter") startScan(); });
  $("#btn-start").addEventListener("click", startScan);
  $("#btn-cancel").addEventListener("click", () => api("cancel", {}).then(() => toast("نوقف الفحص…", "review", 1500)));
  $("#btn-new").addEventListener("click", async () => { await api("reset", {}).catch(() => {}); await boot(); });
  $("#btn-error-back").addEventListener("click", async () => { await api("reset", {}).catch(() => {}); await boot(); });
  $("#btn-apply").addEventListener("click", applyPiles);
  $("#btn-open-out").addEventListener("click", () => api("open", { what: "out" }).catch((e) => toast(e.message, "reject")));
  $("#btn-report").addEventListener("click", () => api("open", { what: "report" }).catch((e) => toast(e.message, "reject")));
  $("#btn-settings").addEventListener("click", openDrawer);
  $("#d-close").addEventListener("click", closeDrawer);
  $("#scrim").addEventListener("click", closeDrawer);
  $("#s-save").addEventListener("click", saveVision);
  $("#s-defaults").addEventListener("click", () => saveThresholds(S.app.defaults).then(renderDrawer));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#drawer").hidden) closeDrawer(); });

  $$(".stat").forEach((b) => b.addEventListener("click", () => {
    S.filter = S.filter === b.dataset.filter ? "all" : b.dataset.filter;
    renderSummary(); renderGrid();
    $(".toolbar").scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  $$("#seg button").forEach((b) => b.addEventListener("click", () => { S.filter = b.dataset.f; renderSummary(); renderGrid(); }));
  $("#search").addEventListener("input", (e) => { S.query = e.target.value; renderGrid(); });
  $("#sort").addEventListener("change", (e) => { S.sort = e.target.value; renderGrid(); });
  $("#size").addEventListener("input", (e) => { $("#grid").style.setProperty("--card-min", `${e.target.value}px`); });
  $("#grid").addEventListener("click", (e) => { const c = e.target.closest(".gcard"); if (c) openViewer(Number(c.dataset.id)); });
  $("#grid").addEventListener("keydown", (e) => {
    const c = e.target.closest(".gcard");
    if (c && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openViewer(Number(c.dataset.id)); }
  });

  // Drop a folder path (from Explorer's address bar or a text file) onto the card.
  const card = $("#folder-card");
  card.addEventListener("dragover", (e) => { e.preventDefault(); card.classList.add("drag"); });
  card.addEventListener("dragleave", () => card.classList.remove("drag"));
  card.addEventListener("drop", (e) => {
    e.preventDefault(); card.classList.remove("drag");
    const text = e.dataTransfer.getData("text/plain").trim();
    if (text) $("#folder-input").value = text;
    else toast("المتصفح لا يكشف مسار المجلد المسحوب؛ استخدم زر تصفّح", "info");
  });
}

wire();
boot().catch((e) => { $("#error-text").textContent = `تعذّر الاتصال بالأداة: ${e.message}`; setView("error"); });
