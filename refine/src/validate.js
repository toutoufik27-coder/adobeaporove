// Final validation. The exported text, not the internal state, is what is judged:
//   export -> XML / SVG / references (integrity) -> parse again -> protected elements
//   unchanged -> topology of the re-parsed geometry -> render again (internal renderer)
//   -> render in the browser (the source of truth) -> compare with the original.
// On failure, the changed elements under the differing pixels are returned to their
// original (with their merge partners) and the whole check runs again. When the output
// still cannot be proven, the ORIGINAL is returned.
import { loadSVG, elementBox } from './model.js';
import { renderViewFor } from './viewport.js';
import { render } from './raster.js';
import { compare } from './metrics.js';
// the browser oracle is Node-only: loaded on demand, so this module also runs in a web worker
const getBrowser = async () => (await import('./browser.js')).getBrowser();
import { exportSVG } from './output.js';
import { integrity } from './integrity.js';
import { topology, polyOf } from './features.js';
import { selfIntersections, flatten } from './geom.js';
import { expand } from './pathdata.js';
import { apply } from './matrix.js';
import { maxScale } from './raster.js';

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

// One full check of a state. Returns { ok, text, failures: [..], mask: Uint8Array | null }.
async function checkState(ctx, state, opts, useBrowser, origText) {
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
    internal = { visible: c.visibleShare, solid: c.solid, mean: c.mean };
    if (!within(c, S)) { failures.push({ check: 'internal render', detail: `visible ${(c.visibleShare * 100).toFixed(3)}%, ${c.solid} spot px` }); mask = c.visibleMask; }
    if (useBrowser) {
      const bro = await getBrowser();
      if (bro) {
        const rv = renderViewFor(doc, S.raster || 700);
        const A = await bro.render(origText, rv.cssW, rv.cssH), B = await bro.render(text, rv.cssW, rv.cssH);
        const cb = compare(A.img, B.img, rv.view, { radius: 1 });
        browser = { visible: cb.visibleShare, solid: cb.solid, mean: cb.mean };
        if (!within(cb, S)) { failures.push({ check: 'browser render', detail: `visible ${(cb.visibleShare * 100).toFixed(3)}%, ${cb.solid} spot px` }); mask = mask ? mask.map((v, i) => v | cb.visibleMask[i]) : cb.visibleMask; }
      } else browser = 'unavailable';
    }
  }
  return { ok: !failures.length, text, failures, mask, bad, internal, browser, integrity: integ };
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

export async function finalizeOutput(ctx, opts = {}, { browser = true, maxRounds = 10 } = {}) {
  const { doc } = ctx;
  // the reference: the original, or the drawing corrected to the source image (an intended change)
  const ri = ctx.history.findIndex((h) => h.name === 'Restored');
  const origState = ri > 0 ? ctx.history[ri].state.map((s) => ({ ...s })) : doc.elements.map((e) => ({ subpaths: e.orig, removed: false, digits: undefined, flat: null, ctm: e.origCtm || e.ctm }));
  const origText = exportSVG(doc, origState, opts);
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
  for (let r = 0; r < maxRounds; r++) {
    const res = await checkState(ctx, state, opts, browser, origText);
    rounds.push({ ok: res.ok, failures: res.failures, internal: res.internal, browser: res.browser });
    if (res.ok) return { ok: true, kept: 'processed', text: res.text, state, rolledBack, rounds, integrity: res.integrity, internal: res.internal, browser: res.browser };
    // the main contributors first: every unit explaining at least a fifth of what the top one explains
    const ranked = offenders(ctx, state, res.mask, origState).filter(([u]) => !rolledBack.includes(u));
    const off = new Set([...[...res.bad].map(String), ...ranked.filter(([, n]) => n >= 0.2 * ranked[0][1]).map(([u]) => u)]);
    for (const f of res.failures) if (f.el != null) off.add(String(f.el));
    const fresh = [...off].filter((i) => !rolledBack.includes(i));
    if (!fresh.length) break;
    for (const i of fresh) rollback(i);
  }
  // not provable: KEEP ORIGINAL
  const res = await checkState(ctx, origState, opts, browser, origText);
  return { ok: false, kept: 'original', text: origText, state: origState, rolledBack, rounds, integrity: res.integrity, internal: res.internal, browser: res.browser, reason: rounds.at(-1).failures.map((f) => `${f.check}: ${f.detail}`).join('; ') };
}
