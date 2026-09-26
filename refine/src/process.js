// The full pipeline with history stages, the report and the export.
import { createContext, snapshot, restore, countNodes, resetDoc, nodesOf, rebase } from './engine.js';
import { passRestore, imageError } from './restore.js';
import { passStructure, passDuplicates, passMicro, passCollinear, passAnalysis, passFit, passShapes, passTopology, passVisual, passFinal } from './passes.js';
import { exportSVG } from './output.js';
import { integrity } from './integrity.js';
import { probe } from './memprobe.js';
import { dropChanges, summarize } from './changes.js';

export const STAGES = ['Original', 'Restored', 'Cleaned', 'Simplified', 'Reconstructed', 'Shapes', 'Final'];

export function processDoc(doc, S, onProgress = () => {}, src = null) {
  resetDoc(doc);
  const ctx = createContext(doc, S, src);
  const t = Date.now(), times = {};
  const run = (name, fn) => { const t0 = Date.now(); onProgress(name); fn(); times[name] = Date.now() - t0; probe(ctx, name); };
  snapshot(ctx, 'Original');
  run('1 structural cleanup', () => passStructure(ctx));
  if (src && src.T) {
    run('1b restoration to the source image', () => passRestore(ctx));
    rebase(ctx);
    snapshot(ctx, 'Restored');
  }
  const afterStructure = doc.elements.map((e) => ({ subpaths: e.subpaths, removed: e.removed }));
  // the reference every later step is measured against (engine.attempt drift check)
  for (const e of doc.elements) e.refSubs = e.subpaths;
  run('2 duplicate points', () => passDuplicates(ctx));
  run('3 micro-segments', () => passMicro(ctx));
  snapshot(ctx, 'Cleaned');
  run('4 collinear simplification', () => passCollinear(ctx));
  snapshot(ctx, 'Simplified');
  run('5 curve analysis', () => passAnalysis(ctx));
  run('6 curve fitting', () => passFit(ctx));
  snapshot(ctx, 'Reconstructed');
  const beforeFit = ctx.history[ctx.history.length - 2].state;
  run('7 shape recognition', () => passShapes(ctx, beforeFit, afterStructure));
  snapshot(ctx, 'Shapes');
  run('8 topology validation', () => passTopology(ctx, afterStructure));
  run('9 visual validation', () => passVisual(ctx, afterStructure));
  run('10 final optimization', () => passFinal(ctx));
  snapshot(ctx, 'Final');
  if (src && src.T) {
    const view = ctx.view;
    const img0 = render(ctx.doc, view, { geom: (x) => x.orig, box: null });
    const imgF = render(ctx.doc, view, { geom: (x) => (x.removed ? null : x.subpaths) });
    ctx.imageFidelity = { ...(ctx.imageFidelity || {}), original: imageError(ctx, img0, view), final: imageError(ctx, imgF, view) };
  }
  ctx.times = times; ctx.ms = Date.now() - t;
  // the reference crops are only a cache: released here (the history keeps the result)
  ctx.cropStats = { ...ctx.crops.stats, maxBytes: ctx.crops.max };
  ctx.crops.clear();
  return ctx;
}

// Final validation of the exported result (see validate.js). The Final stage becomes
// exactly what passed; ctx.validation keeps the evidence for the report.
export async function finalize(ctx, opts = {}, o = {}) {
  const { finalizeOutput } = await import('./validate.js');
  const fin = await finalizeOutput(ctx, opts, o);
  ctx.history[ctx.history.length - 1].state = fin.state;
  for (const unit of fin.rolledBack) { const [a, b] = unit.split(':'); dropChanges(ctx, +a, b == null ? null : +b); }
  // browserVerified is true only when the browser itself drew the exported text and it
  // passed; "certified" additionally needs STRICT mode
  ctx.validation = {
    ok: fin.ok, kept: fin.kept, mode: fin.mode, level: fin.level, browserVerified: fin.browserVerified, certified: fin.ok && fin.browserVerified && fin.mode === 'strict',
    browserStatus: fin.browserStatus, fidelity: fin.fidelity, rolledBack: fin.rolledBack, rounds: fin.rounds.length, internal: fin.internal, browser: fin.browser,
    processedInternal: fin.processedInternal || null, reason: fin.reason || null, checks: fin.rounds.map((r) => r.failures.map((x) => `${x.check}: ${x.detail}`)),
  };
  ctx.final = { ...(ctx.final || {}), ...(fin.internal ? { visibleShare: fin.internal.visible, solid: fin.internal.solid } : {}) };
  return { text: fin.text, integrity: fin.integrity, validation: ctx.validation };
}

export function stateOutput(ctx, stageIndex, opts) {
  const h = ctx.history[stageIndex];
  const text = exportSVG(ctx.doc, h.state, opts);
  return { text, integrity: integrity(text) };
}

export function report(ctx, beforeText, afterText, stageIndex = ctx.history.length - 1) {
  const { doc } = ctx;
  const st = ctx.history[stageIndex].state;
  const live = (s) => doc.elements.filter((e, i) => !s[i].removed);
  const orig = ctx.history[0].state;
  const R = ctx.removedNodes;
  const acc = (op) => ctx.counts[`${op}|accepted`] || 0;
  const shapeOps = Object.keys(ctx.counts).filter((k) => k.endsWith('reconstruction|accepted') && !k.startsWith('curve')).reduce((n, k) => n + ctx.counts[k], 0);
  const g = ctx.final;
  return {
    original: { elements: doc.elements.length, paths: doc.elements.filter((e) => e.tag === 'path').length, nodes: countNodes(doc, orig), bytes: beforeText.length },
    processed: { elements: live(st).length, paths: live(st).filter((e) => e.tag === 'path' || st[e.idx].flat).length, nodes: countNodes(doc, st), bytes: afterText.length },
    changes: {
      removedPoints: (R['zero-length segment'] || 0) + (R['near-duplicate point'] || 0) + (R['collinear points'] || 0),
      simplifiedSegments: (R['micro-segment'] || 0) + (R['collinear points'] || 0),
      reconstructedCurves: acc('curve reconstruction'),
      detectedShapes: shapeOps,
      symmetry: acc('symmetry correction'),
      mergedPaths: acc('merge paths'),
      removedHidden: acc('hidden contours') + acc('hidden element'),
      removedElements: acc('empty element') + acc('invisible element') + acc('hidden element'),
      rejected: ctx.rejectedCount, accepted: ctx.acceptedCount,
    },
    // what the result contains, by kind (a smaller file is not a repair)
    repairVsOptimization: summarize(ctx, st),
    validation: ctx.validation || null,
    visual: g ? { visible: +(g.visibleShare * 100).toFixed(3), pixelDifference: +(g.pixelShare * 100).toFixed(3), meanDeltaE: +g.mean.toFixed(3), structural: +((g.structural || 0) * 100).toFixed(3), spots: g.solid, score: g.score } : null,
    image: ctx.imageFidelity && ctx.imageFidelity.original ? { alignment: ctx.src.T, meanBefore: +ctx.imageFidelity.original.mean.toFixed(3), meanAfter: +ctx.imageFidelity.final.mean.toFixed(3), wrongBefore: +(ctx.imageFidelity.original.badShare * 100).toFixed(3), wrongAfter: +(ctx.imageFidelity.final.badShare * 100).toFixed(3), restored: ctx.counts['restore outline|accepted'] || 0 } : null,
    ms: ctx.ms, times: ctx.times,
  };
}

// Metrics of any history stage against the original.
import { globalCheck } from './engine.js';
import { makeView, alphaBoxes, render } from './raster.js';
import { apply } from './matrix.js';
import { toCubics } from './pathdata.js';
export function stageMetrics(ctx, i) {
  const keep = ctx.history[ctx.history.length - 1].state;
  restore(ctx, ctx.history[i].state);
  const g = globalCheck(ctx);
  const im = ctx.src && ctx.src.T ? imageError(ctx, g.img, ctx.view) : null;
  restore(ctx, keep);
  return { image: im && { mean: +im.mean.toFixed(3), wrong: +(im.badShare * 100).toFixed(3) }, visible: +(g.visibleShare * 100).toFixed(3), pixelDifference: +(g.pixelShare * 100).toFixed(3), meanDeltaE: +g.mean.toFixed(3), structural: +((g.structural || 0) * 100).toFixed(3), spots: g.solid, score: g.score, nodes: ctx.history[i].nodes };
}
// Top-most element index under every pixel (for picking shapes in the viewer).
export function idMap(ctx, i, maxSide = 900) {
  const keep = ctx.history[ctx.history.length - 1].state;
  restore(ctx, ctx.history[i].state);
  const view = makeView(ctx.doc.viewBox, maxSide), ids = new Int32Array(view.W * view.H).fill(-1);
  const boxes = alphaBoxes({ ...ctx.doc, elements: ctx.doc.elements.map((e) => e.removed ? { ...e, render: false } : e) }, view);
  boxes.forEach((b, k) => { if (b) for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) if (b.data[y * b.w + x] > 0.3) ids[(b.y0 + y) * view.W + b.x0 + x] = k; });
  restore(ctx, keep);
  return { ids, W: view.W, H: view.H, x: view.x, y: view.y, k: view.k };
}
// Nodes, control points, segments and box of one element (root coordinates).
export function inspect(ctx, idx, i) {
  const e = ctx.doc.elements[idx];
  const geo = (subs, m) => subs.map((sp) => ({
    closed: sp.closed,
    segs: sp.segs.map((g) => ({ t: g.t, p: g.p.map((q) => apply(m, q)), c: g.t === 'A' ? toCubics(g).map((c) => c.p.map((q) => apply(m, q))) : null })),
  }));
  const st = ctx.history[i].state[idx];
  const b = (subs, m) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const sp of subs) for (const g of sp.segs) for (const q of (g.t === 'A' ? toCubics(g).flatMap((c) => c.p) : g.p)) { const r = apply(m, q); x0 = Math.min(x0, r[0]); y0 = Math.min(y0, r[1]); x1 = Math.max(x1, r[0]); y1 = Math.max(y1, r[1]); } return [x0, y0, x1, y1]; };
  const nodes = (subs) => subs.reduce((n, s) => n + s.segs.length + (s.closed ? 0 : 1), 0);
  return {
    idx, tag: e.tag, id: e.id || null, editable: e.editable, reason: e.reason, removed: st.removed,
    original: { subpaths: geo(e.orig, e.origCtm || e.ctm), box: b(e.orig, e.origCtm || e.ctm), nodes: nodes(e.orig) },
    current: { subpaths: geo(st.subpaths, st.ctm || e.ctm), box: b(st.subpaths, st.ctm || e.ctm), nodes: st.removed ? 0 : nodes(st.subpaths) },
    log: ctx.log.filter((l) => l.el === idx).slice(0, 80),
  };
}
