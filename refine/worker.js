// The engine runs here, off the page's thread.
import { loadSVG } from './src/model.js';
import { analyzeDoc, recommendMode } from './src/analyze.js';
import { processDoc, stateOutput, report, stageMetrics, idMap, inspect, finalize, STAGES } from './src/process.js';
import { settingsFor, MODES } from './src/engine.js';
import { exportSVG } from './src/output.js';
import { makeSource, align } from './src/source.js';
import { detectGroups, buildPrompt, proposals, applyRing, verifyRing } from './src/semantic.js';
import { restore, snapshot, record } from './src/engine.js';

let doc = null, text = '', ctx = null, src = null;
const alignSource = () => { if (!src || !doc) return; src.T = align(doc, src); post('source-aligned', { T: src.T, W: src.W, H: src.H }); };
const post = (type, data, transfer) => self.postMessage({ type, ...data }, transfer || []);

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'load') {
      text = m.text; ctx = null;
      doc = loadSVG(text);
      const a = analyzeDoc(doc, settingsFor('balanced'));
      const rec = recommendMode(a);
      // the original as it will be shown (sanitized, same serializer)
      const original = exportSVG(doc, doc.elements.map((e) => ({ subpaths: e.orig, removed: false })), { exact: true });
      post('analysis', { analysis: a, recommendation: rec, removed: doc.removed, original, name: m.name });
      alignSource();
    } else if (m.type === 'source') {
      src = m.clear ? null : makeSource(new Uint8ClampedArray(m.rgba), m.W, m.H);
      if (src) alignSource();
    } else if (m.type === 'process') {
      const S = settingsFor(m.mode, m.settings || {});
      const useSrc = src && src.T && src.T.correlation > 0.8 ? src : null;
      ctx = processDoc(doc, S, (p) => post('progress', { pass: p }), useSrc);
      const last = ctx.history.length - 1;
      const orig = stateOutput(ctx, 0, m.exportOptions || {});
      // the exported text passes the final validation (re-parsed, re-rendered) before it is shown
      const out = await finalize(ctx, m.exportOptions || {}, { browser: false });
      const r = report(ctx, text, out.text);
      post('processed', { defaults: MODES, dry: !!m.dry, mode: m.mode, settings: S, report: r, stages: ctx.history.map((h) => ({ name: h.name, nodes: h.nodes })), original: orig.text, output: out.text, integrity: out.integrity, validation: out.validation, log: ctx.log, counts: ctx.counts });
    } else if (m.type === 'stage') {
      const o = stateOutput(ctx, m.index, m.exportOptions || {});
      post('stage', { index: m.index, output: o.text, integrity: o.integrity, metrics: stageMetrics(ctx, m.index), report: report(ctx, text, o.text, m.index) });
    } else if (m.type === 'idmap') {
      const r = idMap(ctx, m.index);
      post('idmap', r, [r.ids.buffer]);
    } else if (m.type === 'inspect') {
      post('inspect', { data: inspect(ctx, m.el, m.index) });
    }
    else if (m.type === 'semantic-detect') {
      const keep = ctx.history[ctx.history.length - 1].state;
      restore(ctx, ctx.history[m.index].state);
      ctx.semGroups = detectGroups(ctx.doc, ctx.u);
      ctx.semIndex = m.index;
      restore(ctx, keep);
      const groups = ctx.semGroups.map((g) => ({ id: g.id, kind: g.kind, count: g.members.length, center: g.center || null, radius: g.radius || null, gapCV: +g.gapCV.toFixed(3), text: g.text, first: [g.members[0].cx, g.members[0].cy], last: [g.members.at(-1).cx, g.members.at(-1).cy], size: Math.max(...g.members.map((x) => x.size)), linked: (g.links || []).length }));
      post('semantic-groups', { groups, prompt: buildPrompt(ctx.semGroups), viewBox: ctx.doc.viewBox, output: stateOutput(ctx, m.index, m.exportOptions || {}).text });
    } else if (m.type === 'semantic-proposals') {
      post('semantic-proposals', { proposals: proposals(ctx.semGroups, m.answer) });
    } else if (m.type === 'semantic-apply') {
      // intended changes on top of the chosen stage; a new history stage records them
      restore(ctx, ctx.history[ctx.semIndex].state);
      const results = [];
      for (const it of m.items) {
        const g = ctx.semGroups.find((x) => x.id === it.group);
        if (!g || g.kind !== 'radial' || !(it.to >= 2 && it.to <= 64)) { results.push({ ...it, ok: false, reason: 'only rings can be rebuilt for now' }); continue; }
        const before = ctx.doc.elements.map((e) => ({ subpaths: e.subpaths, removed: e.removed }));
        applyRing(ctx.doc, g, it.to, ctx.u);
        const v = verifyRing(ctx.doc, before, g, ctx.u);
        if (!v.ok) ctx.doc.elements.forEach((e, i) => { e.subpaths = before[i].subpaths; });
        const r = { ...it, ok: v.ok, reason: v.ok ? `${g.members.length} -> ${it.to} marks, nothing outside the ring changed` : `${v.outside} pixels outside the ring would change` };
        record(ctx, { pass: 'semantic correction', op: it.op === 'even' ? 'even spacing' : 'set count', el: g.el, accepted: v.ok, confidence: it.confidence ?? 1, label: it.reason, reason: r.reason });
        results.push(r);
      }
      ctx.history = ctx.history.slice(0, ctx.semIndex + 1);
      snapshot(ctx, 'Semantic');
      const last = ctx.history.length - 1;
      const out = stateOutput(ctx, last, m.exportOptions || {});
      post('semantic-applied', { results, stages: ctx.history.map((h) => ({ name: h.name, nodes: h.nodes })), index: last, output: out.text, integrity: out.integrity, report: report(ctx, text, out.text, last), metrics: stageMetrics(ctx, last), log: ctx.log });
    }
  } catch (err) {
    post('error', { message: String((err && err.message) || err), stack: String(err && err.stack || '') });
  }
};
