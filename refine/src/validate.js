// Final validation. The exported text, not the internal state, is what is judged:
//   export -> XML / SVG / references (integrity) -> parse again -> protected elements
//   unchanged -> topology of the re-parsed geometry -> render again (internal renderer)
//   -> render in the browser (the source of truth) -> compare with the original.
// On failure, the changed elements under the differing pixels are returned to their
// original (with their merge partners) and the whole check runs again. When the output
// still cannot be proven, the ORIGINAL is returned.
//
// Two explicit modes:
//   STRICT    the browser render is required. Without a browser oracle nothing is
//             accepted: the original is kept and the reason is reported.
//   FALLBACK  without a browser, the internal renderer alone may accept the output,
//             and the result says so: browserVerified = false, level "internal-only".
// Only a STRICT pass with the browser is a certified ("browser-verified") result.
import { loadSVG, elementBox } from './model.js';
import { renderViewFor } from './viewport.js';
import { render } from './raster.js';
import { compare } from './metrics.js';
// the browser oracle is Node-only: loaded on demand, so this module also runs in a web worker
const getBrowser = async () => (await import('./browser.js')).getBrowser();
const oracleStatus = async () => (await import('./browser.js')).browserStatus();
export const STRICT = 'strict', FALLBACK = 'fallback';
import { exportSVG } from './output.js';
import { integrity } from './integrity.js';
import { topology, polyOf } from './features.js';
import { selfIntersections, flatten } from './geom.js';
import { expand } from './pathdata.js';
import { apply } from './matrix.js';
import { maxScale } from './raster.js';
import { probe } from './memprobe.js';

// Browser renders of two SVG texts on the same grid. null when no browser is available.
export async function browserPair(origText, outText, side = 600) {
  const browser = await getBrowser();
  if (!browser) return null;
  const doc = loadSVG(origText);
  const rv = renderViewFor(doc, side);
  const a = await browser.render(origText, rv.cssW, rv.cssH);
  const b = await browser.render(outText, rv.cssW, rv.cssH);
  return { a: a.img, b: b.img, view: rv.view, doc };
}
export async function browserDiff(origText, outText, side = 600) {
  const p = await browserPair(origText, outText, side);
  if (!p) return null;
  const c = compare(p.a, p.b, p.view, { radius: 1 });
  return { visible: c.visibleShare, pixels: c.pixelShare, solid: c.solid, mean: c.mean, diff: c.diff, mask: c.visibleMask, view: p.view, W: p.view.W, H: p.view.H };
}

const within = (c, S) => c.visibleShare <= S.globalMax && c.solid <= S.maxSolid * 4;
const selfX = (subs, u) => subs.reduce((n, sp) => n + (sp.closed ? selfIntersections(polyOf(sp, 0.25 * u), 50) : 0), 0);
const stat = (c) => ({ visible: c.visibleShare, solid: c.solid, mean: c.mean, pixels: c.pixelShare });

// One full check of a state. Returns { ok, internalOk, text, failures, mask, bad,
// internal, browser }. `oracle` = { browser, ref, rv } or null (then browser = null:
// not measured, which is never the same as "passed").
async function checkState(ctx, state, opts, oracle) {
  const { doc, S, view } = ctx, failures = [];
  const text = exportSVG(doc, state, opts);
  const integ = integrity(text);
  if (!integ.ok) failures.push({ check: 'integrity', detail: integ.errors.slice(0, 3).join('; ') });
  let doc2 = null;
  try { doc2 = loadSVG(text); } catch (err) { failures.push({ check: 'reparse', detail: String(err.message || err) }); }
  // protected elements are written exactly as they were
  for (const e of doc.elements) if (e.locked && (state[e.idx].removed || state[e.idx].subpaths !== e.orig || state[e.idx].flat)) failures.push({ check: 'protected', detail: `protected element #${e.idx} changed`, el: e.idx });
  const bad = new Set();
  let mask = null, internal = null, browser = null;
  if (doc2) {
    // the re-parsed geometry keeps the topology of the validated state (export and
    // rounding must not change it)
    const live = doc.elements.filter((e) => !state[e.idx].removed);
    if (live.length !== doc2.elements.length) failures.push({ check: 'structure', detail: `${live.length} elements expected, ${doc2.elements.length} parsed` });
    else live.forEach((e, j) => {
      const st = state[e.idx], e2 = doc2.elements[j];
      if (st.subpaths === e.orig && !st.flat) return;
      const u = ctx.u / (e2.scale || 1);
      if (topology(st.subpaths, e.rule, u).signature !== topology(e2.subpaths, e2.rule, u).signature) { failures.push({ check: 'topology', detail: `element #${e.idx}: contours / holes changed on export`, el: e.idx }); bad.add(e.idx); }
      else if (e.fill && e.fill.kind !== 'none' && selfX(e2.subpaths, u) > selfX(st.subpaths, u)) { failures.push({ check: 'topology', detail: `element #${e.idx}: self-intersections added on export`, el: e.idx }); bad.add(e.idx); }
    });
    // render the re-parsed output again (internal renderer, same grid as the original)
    const img = render(doc2, view, { orig: true });
    const c = compare(ctx.origImg, img, view, { labA: ctx.origLab, radius: Math.max(1, Math.min(3, Math.round(S.maxDev * ctx.u * view.k))) });
    internal = { ...stat(c), ok: within(c, S) };
    probe(ctx, 'final validation');
    if (!internal.ok) { failures.push({ check: 'internal render', detail: `visible ${(c.visibleShare * 100).toFixed(3)}%, ${c.solid} spot px` }); mask = c.visibleMask; }
  }
  const internalOk = !failures.length;
  if (doc2 && oracle) {
    // the exported text in the browser, against the original in the browser
    let B = null;
    try { B = await oracle.browser.render(text, oracle.rv.cssW, oracle.rv.cssH); }
    catch (err) { browser = { ok: false, error: String(err.message || err) }; failures.push({ check: 'browser render', detail: browser.error }); }
    if (B) {
      const cb = compare(oracle.ref, B.img, oracle.rv.view, { radius: 1 });
      browser = { ...stat(cb), ok: within(cb, S) };
      if (!browser.ok) { failures.push({ check: 'browser render', detail: `visible ${(cb.visibleShare * 100).toFixed(3)}%, ${cb.solid} spot px` }); mask = mask ? mask.map((v, i) => v | cb.visibleMask[i]) : cb.visibleMask; }
    }
  }
  return { ok: !failures.length, internalOk, text, failures, mask, bad, internal, browser, integrity: integ };
}

// What changed under the differing pixels. A differing pixel is attributed to a changed
// contour when it lies within 2 px of that contour's old or new outline (not just inside
// its box: large contours span the whole artwork). Units are as small as the geometry
// allows: one contour ("idx:sub") when the element kept its contour list, else the
// element ("idx"). Returned ranked by the number of pixels each unit explains.
function offenders(ctx, state, mask, ref) {
  const { doc, view } = ctx;
  if (!mask) return [];
  const hits = [];
  for (let y = 0; y < view.H; y++) for (let x = 0; x < view.W; x++) if (mask[y * view.W + x]) hits.push([x + 0.5, y + 0.5]);
  if (!hits.length) return [];
  const R = 2, cell = 4, grid = new Map();
  const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  hits.forEach((p, i) => { const k = key(p[0], p[1]); (grid.get(k) || grid.set(k, []).get(k)).push(i); });
  // pixels near an outline (element coordinates -> pixels), densely sampled
  const near = (subs, m) => {
    const found = new Set();
    for (const sp of subs) {
      if (!sp.segs.length) continue;
      const pts = [...flatten(expand(sp.segs), 0.25 / (view.k * maxScale(m))), sp.segs[sp.segs.length - 1].p.at(-1)];
      for (let i = 0; i < pts.length; i++) {
        const a = toPx(view, m, pts[i]), b = toPx(view, m, pts[(i + 1) % pts.length]);
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 1));
        for (let t = 0; t <= n; t++) {
          const q = [a[0] + ((b[0] - a[0]) * t) / n, a[1] + ((b[1] - a[1]) * t) / n];
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            const list = grid.get(`${Math.floor(q[0] / cell) + dx},${Math.floor(q[1] / cell) + dy}`);
            if (list) for (const h of list) if (Math.hypot(hits[h][0] - q[0], hits[h][1] - q[1]) <= R) found.add(h);
          }
        }
      }
    }
    return found;
  };
  const score = new Map();
  const add = (unit, set) => { if (set.size) score.set(unit, (score.get(unit) || 0) + set.size); };
  for (const e of doc.elements) {
    const st = state[e.idx], r = ref[e.idx];
    if (st.removed === r.removed && st.subpaths === r.subpaths && !st.flat) continue;
    const mo = r.ctm || e.origCtm || e.ctm, mn = st.ctm || e.ctm;
    if (!st.removed && !r.removed && !st.flat && st.subpaths.length === r.subpaths.length) {
      st.subpaths.forEach((sp, n) => { if (sp !== r.subpaths[n]) add(`${e.idx}:${n}`, new Set([...near([r.subpaths[n]], mo), ...near([sp], mn)])); });
    } else add(String(e.idx), new Set([...(r.removed ? [] : near(r.subpaths, mo)), ...(st.removed ? [] : near(st.subpaths, mn))]));
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]);
}
const toPx = (view, m, p) => { const q = apply(m, p); return [(q[0] - view.x) * view.k, (q[1] - view.y) * view.k]; };

// The browser oracle for one document: the reference (the original) is rendered once.
// The reference is the input text as given; when image restoration changed the drawing
// on purpose, it is the restored state. The sanitized original as the engine writes it
// is compared with the input too (serializer / sanitizer fidelity), so a writer bug is
// never hidden by rendering both sides through the same writer.
async function prepareOracle(ctx, restored, origState) {
  const { doc, S } = ctx;
  const browser = await getBrowser();
  if (!browser) return { oracle: null, status: await oracleStatus(), fidelity: null };
  const rv = renderViewFor(doc, S.raster || 700);
  const written = restored ? exportSVG(doc, origState, { pretty: false }) : exportSVG(doc, origState, { exact: true, pretty: false });
  const W = await browser.render(written, rv.cssW, rv.cssH);
  let fidelity = null;
  if (!restored && doc.sourceText != null) {
    try {
      const raw = await browser.render(doc.sourceText, rv.cssW, rv.cssH);
      const c = compare(raw.img, W.img, rv.view, { radius: 1 });
      fidelity = { ...stat(c), ok: c.solid === 0 && c.visibleShare === 0, sanitized: doc.removed.length };
    } catch (err) { fidelity = { ok: false, error: String(err.message || err), sanitized: doc.removed.length }; }
  }
  return { oracle: { browser, ref: W.img, rv }, status: { available: true, exe: browser.exe, reason: null }, fidelity };
}

// opts: export options. o.validation: STRICT (default) or FALLBACK; o.browser = false
// disables the oracle (it then counts as unavailable).
export async function finalizeOutput(ctx, opts = {}, { browser = true, validation = STRICT, maxRounds = 10 } = {}) {
  const { doc } = ctx;
  if (validation !== STRICT && validation !== FALLBACK) throw new Error(`unknown validation mode "${validation}"`);
  // the reference: the original, or the drawing corrected to the source image (an intended change)
  const ri = ctx.history.findIndex((h) => h.name === 'Restored');
  const origState = ri > 0 ? ctx.history[ri].state.map((s) => ({ ...s })) : doc.elements.map((e) => ({ subpaths: e.orig, removed: false, digits: undefined, flat: null, ctm: e.origCtm || e.ctm }));
  const prep = browser ? await prepareOracle(ctx, ri > 0, origState) : { oracle: null, status: { available: false, exe: null, reason: 'browser validation disabled (--no-browser)' }, fidelity: null };
  const { oracle, fidelity } = prep;
  const common = { mode: validation, browserStatus: prep.status, fidelity };
  let state = ctx.history[ctx.history.length - 1].state.map((s) => ({ ...s }));
  const rolledBack = [], rounds = [];
  // unit "idx" returns the element (and its merge partners); "idx:sub" one contour
  const rollback = (unit) => {
    if (rolledBack.includes(unit)) return;
    rolledBack.push(unit);
    const [a, b] = unit.split(':').map(Number);
    if (b != null && !isNaN(b)) {
      const subs = state[a].subpaths.map((sp, n) => (n === b ? origState[a].subpaths[n] : sp));
      const back = subs.every((sp, n) => sp === origState[a].subpaths[n]);
      state[a] = { ...state[a], subpaths: back ? origState[a].subpaths : subs, ...(back ? { digits: undefined } : {}) };
      return;
    }
    state[a] = { ...origState[a] };
    for (const [m, list] of Object.entries(ctx.merged || {})) {
      if (+m === a) for (const p of list) rollback(String(p));
      else if (list.includes(a)) rollback(String(m));
    }
  };
  // the original, when nothing else can be proven (its own checks are reported too)
  const keepOriginal = async (reason) => {
    let res = await checkState(ctx, origState, opts, oracle);
    // the export options themselves (restructuring, minified numbers of changed elements)
    // must not change the original either: when they do, the original is written as is
    if (!res.ok) { const r2 = await checkState(ctx, origState, { exact: true, pretty: opts.pretty ?? !opts.minify }, oracle); if (r2.ok || !res.internalOk) res = r2; }
    // a writer that cannot reproduce the input (fidelity failed with nothing sanitized
    // away): the input text itself is the faithful original
    const raw = fidelity && !fidelity.ok && !fidelity.sanitized && doc.sourceText != null;
    return { ...common, ok: false, kept: 'original', text: raw ? doc.sourceText : res.text, state: origState, rolledBack, rounds, integrity: raw ? integrity(doc.sourceText) : res.integrity, internal: res.internal, browser: res.browser, browserVerified: false, level: 'original-kept', reason };
  };
  // The input and the engine's copy of it differ in the browser. With nothing removed
  // on input, that is a writer bug: nothing written by the engine can be trusted, the
  // input is kept. When unsafe content was removed (an external <image> shows Chrome's
  // broken-image box, for example) the difference is the sanitization itself: the
  // sanitized original is the reference, and the report says so.
  if (fidelity && !fidelity.ok) {
    if (fidelity.error || !fidelity.sanitized) {
      const why = fidelity.error ? `the browser could not draw the input (${fidelity.error})` : `the original as written by the engine does not look like the input in the browser (visible ${(fidelity.visible * 100).toFixed(3)}%, ${fidelity.solid} spot px)`;
      return keepOriginal(`fidelity: ${why}`);
    }
    fidelity.attributedTo = `sanitization (${fidelity.sanitized} unsafe item(s) removed on input): the sanitized original is the reference`;
  }
  if (validation === STRICT && !oracle) {
    // STRICT without the source of truth: report what the internal renderer sees, accept nothing
    const res = await checkState(ctx, state, opts, null);
    rounds.push({ ok: false, failures: res.failures, internal: res.internal, browser: null });
    const out = await keepOriginal(`STRICT validation needs the browser oracle, which is unavailable (${prep.status.reason}); the processed result was not accepted. FALLBACK mode accepts an internal-only result, reported as not browser-verified`);
    return { ...out, processedInternal: res.internal, processedInternalOk: res.internalOk };
  }
  for (let r = 0; r < maxRounds; r++) {
    const res = await checkState(ctx, state, opts, oracle);
    rounds.push({ ok: res.ok, failures: res.failures, internal: res.internal, browser: res.browser });
    if (res.ok) {
      const browserVerified = !!(res.browser && res.browser.ok);
      return { ...common, ok: true, kept: 'processed', text: res.text, state, rolledBack, rounds, integrity: res.integrity, internal: res.internal, browser: res.browser, browserVerified, level: browserVerified ? 'browser-verified' : 'internal-only' };
    }
    // the main contributors first: every unit explaining at least a fifth of what the top one explains
    const ranked = offenders(ctx, state, res.mask, origState).filter(([u]) => !rolledBack.includes(u));
    const off = new Set([...[...res.bad].map(String), ...ranked.filter(([, n]) => n >= 0.2 * ranked[0][1]).map(([u]) => u)]);
    for (const f of res.failures) if (f.el != null) off.add(String(f.el));
    const fresh = [...off].filter((i) => !rolledBack.includes(i));
    if (!fresh.length) break;
    for (const i of fresh) rollback(i);
  }
  // not provable: KEEP ORIGINAL
  return keepOriginal(rounds.at(-1).failures.map((f) => `${f.check}: ${f.detail}`).join('; '));
}
