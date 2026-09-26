// Engine tests: parser, security, path data, geometry model, the full pipeline on
// real vectorized SVGs (fidelity, no added nodes, integrity) and on a feature file.
import fs from 'fs';
import { parseXML } from '../src/xml.js';
import { parsePath, writePath } from '../src/pathdata.js';
import { loadSVG } from '../src/model.js';
import { analyzeDoc } from '../src/analyze.js';
import { processDoc, stateOutput, report, finalize, STAGES } from '../src/process.js';
import { settingsFor } from '../src/engine.js';
import { integrity } from '../src/integrity.js';
import { fitCircle, selfIntersections } from '../src/geom.js';

// every check is counted: passed, failed, or skipped (a check that could not run is
// never reported as passed). Each section prints its time.
let pass = 0, fail = 0, skipped = 0, section = null, t0 = Date.now();
const ok = (c, msg) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${msg}`); if (c) pass++; else fail++; };
const skip = (msg, n = 1) => { console.log(`SKIP ${msg}${n > 1 ? ` (${n} checks)` : ''}`); skipped += n; };
const begin = (name) => { if (section) console.log(`# ${section}: ${((Date.now() - t0) / 1000).toFixed(1)} s`); section = name; t0 = Date.now(); };
const throws = (f) => { try { f(); return false; } catch { return true; } };
const { getBrowser, browserStatus } = await import('../src/browser.js');
const oracle = await getBrowser();
console.log(`browser oracle: ${oracle ? 'available (' + oracle.exe + ')' : 'UNAVAILABLE (' + browserStatus().reason + ')'}`);
begin('parser, path data, geometry');

// XML
ok(throws(() => parseXML('<svg><g></svg>')), 'mismatched tags are rejected');
ok(throws(() => parseXML('<svg a="1" a="2"/>')), 'duplicate attributes are rejected');
ok(parseXML('<!DOCTYPE x [<!ENTITY e "x">]><svg/>').removed.length === 1, 'DOCTYPE / entities are dropped, never expanded');
// path data: every command, relative and absolute
const pd = parsePath('M10 10h20v20H10zm5 5l5 5c1 2 3 4 5 6s2 2 3 3q1 1 2 2t2 2a5 5 0 0 1 5 5');
ok(!pd.errors.length && pd.subpaths.length === 2 && pd.subpaths[1].segs.map((s) => s.t).join('') === 'LCCQQA', 'all path commands parsed');
ok(parsePath('M0 0L1').errors.length === 1, 'malformed path data is reported');
const rt = parsePath(writePath(pd.subpaths, 4, { minify: true }));
ok(JSON.stringify(rt.subpaths.map((s) => s.segs.map((g) => g.p.at(-1).map((v) => +v.toFixed(3))))) === JSON.stringify(pd.subpaths.map((s) => s.segs.map((g) => g.p.at(-1).map((v) => +v.toFixed(3))))), 'minified relative path data round-trips');
// geometry
const C = []; for (let i = 0; i < 50; i++) C.push([10 + 5 * Math.cos(i / 8), 20 + 5 * Math.sin(i / 8)]);
const fc = fitCircle(C);
ok(Math.abs(fc.r - 5) < 1e-6 && Math.abs(fc.cx - 10) < 1e-6, 'circle fitting');
ok(selfIntersections([[0, 0], [10, 10], [10, 0], [0, 10]]) === 1, 'self-intersection detection');

// grid Hausdorff: neighbour cells by index (60 / 0.2 = 300 but 59.8 / 0.2 = 298.99..)
{
  const { hausdorff } = await import('../src/geom.js');
  ok(Math.abs(hausdorff([[100, 60]], [[100.0327, 59.9963]], 0.2) - Math.hypot(0.0327, 0.0037)) < 1e-9, 'Hausdorff distance finds the nearest point across a cell boundary (floating-point cell index)');
}

begin('security, feature file, protection');
// security + feature file
const feat = fs.readFileSync(new URL('../samples/features.svg', import.meta.url), 'utf8');
const fdoc = loadSVG(feat);
const what = fdoc.removed.map((r) => r.what).join(' | ');
ok(/script/.test(what) && /onload/.test(what) && /href/.test(what) && /DOCTYPE/.test(what), 'unsafe content removed: ' + what);
ok(fdoc.elements.some((e) => e.fill.kind === 'gradient') && fdoc.clips.size === 1 && fdoc.elements.some((e) => e.tag === 'use' && e.parts), 'gradients, clip paths and <use> are modelled');
const fctx = processDoc(fdoc, settingsFor('professional'));
const fout = stateOutput(fctx, fctx.history.length - 1, {});
ok(fout.integrity.ok, 'feature file output passes the integrity check ' + fout.integrity.errors.join('; '));
ok(/url\(#g1\)/.test(fout.text) && /clip-path="url\(#c1\)"/.test(fout.text) && /stroke-linejoin/.test(fout.text) && /<style>/.test(fout.text), 'gradient, clip, stroke and styles preserved');
ok(!/script|onload|javascript:|evil\.example/.test(fout.text), 'no unsafe content in the output');
ok(fctx.final.visibleShare < 0.002, `feature file visual difference ${(fctx.final.visibleShare * 100).toFixed(3)}%`);
if (!oracle) skip('feature file in STRICT: a difference caused by sanitization is attributed to it (no browser)');
else {
  // the external <image> the sanitizer removed shows Chrome's broken-image box in the input
  const fv = (await finalize(processDoc(loadSVG(feat), settingsFor('professional')), {}, { validation: 'strict' })).validation;
  ok(fv.ok && fv.browserVerified && fv.fidelity && !fv.fidelity.ok && /sanitization/.test(fv.fidelity.attributedTo || ''), `feature file in STRICT: ${fv.level}; input vs sanitized original differ by ${(fv.fidelity.visible * 100).toFixed(3)}%, attributed to ${fv.fidelity.attributedTo ? 'sanitization' : '?'}`);
}
ok(integrity('<svg xmlns="http://www.w3.org/2000/svg"><path fill="url(#nope)" d="M0 0L1 1"/></svg>').errors.some((e) => /broken reference/.test(e)), 'integrity check finds broken references');

// ---- regression: phase 2 (protection)
{
  const { parseTransform } = await import('../src/matrix.js');
  ok(parseTransform('translate(30) foo(2)') === null && parseTransform('rotate(30 5)') === null && parseTransform('matrix(1 0 0 1 0)') === null && parseTransform('translate(10)x') === null,
    'invalid transform lists are rejected as a whole (browsers apply no transform)');
  // an unchanged path must be written exactly as it was (its rounding was never validated)
  const tiny = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path fill="#000" d="M0.12345 0.12345L0.87654 0.12345L0.87654 0.87654Z"/></svg>';
  const tdoc = loadSVG(tiny), tctx = processDoc(tdoc, settingsFor('safe'));
  ok(/d="M0\.12345 0\.12345L0\.87654 0\.12345L0\.87654 0\.87654Z"/.test(stateOutput(tctx, 0, {}).text), 'unchanged path data is not rewritten (no unvalidated rounding)');
  const cc = loadSVG('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g color="#ff0000"><path fill="currentColor" d="M0 0H5V5Z"/></g></svg>');
  ok(cc.elements[0].fill.rgb.slice(0, 3).join() === '255,0,0', 'currentColor resolves the inherited color property');
  const fx = loadSVG('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><filter id="f"><feOffset dx="5"/></filter><g filter="url(#f)"><path d="M0 0L10 0L20 0L20 20Z"/></g><path d="M50 50L60 50L70 50L70 70Z"/></svg>');
  ok(fx.elements[0].locked && !fx.elements[0].editable && fx.elements[0].support.level === 'UNSUPPORTED' && !fx.elements[1].locked, 'a filter inherited from a group locks the geometry; plain geometry stays editable');
  const mk = loadSVG('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><marker id="m"><path d="M0 0L3 3Z"/></marker><g marker-mid="url(#m)"><path stroke="#000" fill="none" d="M0 0L10 0L20 0"/></g></svg>');
  ok(mk.elements[0].locked, 'a marker inherited from a group locks the path');
  const us = loadSVG('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path id="p" d="M0 0L10 0L20 0L20 20Z"/><use href="#p" x="30"/></svg>');
  ok(us.elements[0].locked, 'geometry copied by <use> is locked (the copy would change unseen)');
  const { protectionTests } = await import('./protection.js');
  protectionTests(ok);
}

// ---- regression: export and serializer
{
  const { exportSVG } = await import('../src/output.js');
  const { serialize } = await import('../src/xml.js');
  const tx = loadSVG('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><text x="5" y="20"><tspan>ab</tspan> <tspan>cd</tspan></text><text x="5" y="30"><tspan>x</tspan><tspan>y</tspan></text></svg>');
  const st0 = tx.elements.map((e) => ({ subpaths: e.orig, removed: false }));
  const both = [exportSVG(tx, st0, { exact: true }), exportSVG(tx, st0, { pretty: false }), exportSVG(tx, st0, { minify: true })];
  ok(both.every((t) => t.includes('<tspan>ab</tspan> <tspan>cd</tspan>') && t.includes('<tspan>x</tspan><tspan>y</tspan>')), 'text content is written verbatim: the space between two <tspan>s is kept, and none is added');
  const gr = loadSVG('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><style>g { fill: #ff0000 }</style><g><path d="M0 0H50V50Z"/></g></svg>');
  const gout = exportSVG(gr, gr.elements.map((e) => ({ subpaths: e.orig, removed: false })), { preserveStructure: false });
  ok(loadSVG(gout).elements[0].fill.rgb.slice(0, 3).join() === '255,0,0', 'a group styled by a `g` rule is not unwrapped by --no-structure (the fill stays red)');
  // an earlier history stage was never through the precision validation: no rounding
  const small = loadSVG('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 0.1 0.1"><path fill="#000" d="M0.01234 0.01234L0.05 0.01234L0.08766 0.01234L0.08766 0.08766L0.01234 0.08766Z"/></svg>');
  const sctx = processDoc(small, settingsFor('professional'));
  const si = sctx.history.findIndex((h) => h.name === 'Simplified'), sst = sctx.history[si].state[0];
  const written = loadSVG(stateOutput(sctx, si, {}).text).elements[0].subpaths[0].segs.flatMap((g) => g.p);
  ok(sst.subpaths !== small.elements[0].orig && written.some((q) => Math.abs(q[0] - 0.01234) < 1e-9), `an intermediate stage is written without unvalidated rounding (0.01234 kept, not 0.012)`);
}

// ---- regression: phase 3 / 4 (renderer, viewport)
begin('renderer, viewport, browser conformance');
{
  const { render } = await import('../src/raster.js');
  const { renderViewFor } = await import('../src/viewport.js');
  const px = (doc, x, y) => { const rv = renderViewFor(doc, 100), img = render(doc, rv.view, { orig: true }), p = (y * rv.view.W + x) * 3; return [0, 1, 2].map((c) => Math.round(img[p + c])); };
  const svg = (b) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">${b}</svg>`;
  // gradient: real colours, not the mean
  const g = loadSVG(svg('<linearGradient id="g"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient><rect width="100" height="100" fill="url(#g)"/>'));
  const gl = px(g, 1, 50), gr = px(g, 98, 50);
  ok(gl[0] > 245 && gl[2] < 10 && gr[2] > 245 && gr[0] < 10, `linear gradient drawn per pixel (left ${gl}, right ${gr}), not as its mean colour`);
  // group opacity: overlapping children are blended once
  const go = loadSVG(svg('<g opacity="0.5"><rect width="60" height="60" fill="#000"/><rect x="40" y="40" width="60" height="60" fill="#000"/></g>'));
  ok(px(go, 50, 50)[0] === 128 && px(go, 10, 10)[0] === 128, `group opacity composited as one layer (overlap ${px(go, 50, 50)[0]}, single ${px(go, 10, 10)[0]})`);
  // stroke under non-uniform scale: built in local space (horizontal width 2 x 4 = 8)
  const ns = loadSVG(svg('<g transform="scale(2 0.5)"><path d="M20 0V200" stroke="#000" stroke-width="4" fill="none"/></g>'));
  ok(px(ns, 36, 50)[0] === 0 && px(ns, 43, 50)[0] === 0 && px(ns, 34, 50)[0] === 255 && px(ns, 45, 50)[0] === 255, 'stroke under a non-uniform scale is drawn in its own coordinates (8 units wide, not 4)');
  // elementBox: stroke reach uses the largest stretch of the transform
  const { elementBox } = await import('../src/model.js');
  const bx = elementBox(ns.elements[0]);
  ok(bx[0] <= 36 && bx[2] >= 44 && bx[1] <= 0 && bx[3] >= 100, `stroke box covers the stretched stroke and the end of the open path (${bx.map((v) => +v.toFixed(1))})`);
  // clipPathUnits="objectBoundingBox" follows the element's own box
  const cb = loadSVG(svg('<clipPath id="c" clipPathUnits="objectBoundingBox"><rect width="0.5" height="1"/></clipPath><rect x="20" y="20" width="60" height="60" fill="#000" clip-path="url(#c)"/>'));
  ok(px(cb, 40, 50)[0] === 0 && px(cb, 60, 50)[0] === 255, 'objectBoundingBox clip is mapped to the element box');
  // dashes are drawn
  const da = loadSVG(svg('<path d="M0 50H100" stroke="#000" stroke-width="10" stroke-dasharray="10 10"/>'));
  ok(px(da, 5, 50)[0] === 0 && px(da, 15, 50)[0] === 255, 'dashed strokes are drawn as dashes');
  // viewport: preserveAspectRatio alignment and the area outside the viewBox
  const vp = loadSVG('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="300" height="100" preserveAspectRatio="xMinYMid meet"><rect x="150" width="10" height="10"/></svg>');
  const rv = renderViewFor(vp, 300);
  ok(Math.abs(rv.view.x) < 1e-9 && rv.view.W === 300 && rv.view.H === 100 && rv.view.x + rv.view.W / rv.view.k >= 160, 'root view follows preserveAspectRatio and includes content outside the viewBox');
  const sl = loadSVG('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="300" height="100" preserveAspectRatio="xMidYMax slice"/>');
  const rs = renderViewFor(sl, 300).view;
  ok(Math.abs(rs.k - 3) < 1e-9 && Math.abs(rs.y - (100 - 100 / 3)) < 1e-9, 'slice crops the viewBox like a browser');
  // Chrome is the reference: the internal renderer must agree wherever it claims support
  const { conformance } = await import('./conformance.js');
  const dirs = [new URL('../samples/', import.meta.url), new URL('./fixtures/', import.meta.url)];
  const confFiles = dirs.flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.svg')).map((f) => new URL(f, d)));
  const rows = await conformance(confFiles);
  if (!rows) skip(`conformance with the browser: no browser (${browserStatus().reason})`, confFiles.length);
  else for (const r of rows) {
    // a file whose every pixel is excluded (uncertain everywhere) proves nothing
    if (r.excluded >= 0.99) { skip(`renderer vs browser: ${r.name} (100% of the image is an uncertain region: nothing compared)`); continue; }
    ok(r.pass, `renderer agrees with the browser: ${r.name} (visible ${(r.visible * 100).toFixed(3)}%, mean ΔE ${r.mean.toFixed(3)}, spots ${r.solid}, excluded ${(r.excluded * 100).toFixed(0)}%)`);
  }
}

// ---- browser oracle robustness and the two validation modes
begin('validation modes (STRICT / FALLBACK)');
{
  if (!oracle) skip('a failed browser render does not fail the next one (no browser)');
  else {
    let first = null, second = null;
    try { await oracle.render('<svg xmlns="http://www.w3.org/2000/svg"><g></svg>', 20, 20); } catch (err) { first = err.message; }
    try { second = await oracle.render('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="5" height="5"/></svg>', 20, 20); } catch (err) { second = err.message; }
    ok(first && second && second.W === 20, `a failed browser render does not fail the next one (queue recovers: ${typeof second === 'string' ? second : 'rendered'})`);
  }
  const text = fs.readFileSync(new URL('../samples/deer-frame-icon.svg', import.meta.url), 'utf8');
  const run = async (o) => { const d = loadSVG(text), c = processDoc(d, settingsFor('professional')); return (await finalize(c, {}, o)).validation; };
  const st = await run({ validation: 'strict', browser: false });
  ok(!st.ok && st.kept === 'original' && !st.browserVerified && !st.certified && st.level === 'original-kept' && /STRICT/.test(st.reason), `STRICT without a browser accepts nothing: original kept, browserVerified false (${st.reason.slice(0, 80)}...)`);
  const fb = await run({ validation: 'fallback', browser: false });
  ok(fb.ok && fb.kept === 'processed' && fb.browserVerified === false && !fb.certified && fb.level === 'internal-only', `FALLBACK without a browser: accepted by the internal renderer only, reported as level ${fb.level}, browserVerified ${fb.browserVerified}`);
  if (!oracle) skip('a writer that changes the rendering keeps the input itself (no browser)');
  else {
    // simulate a writer bug: the input shows a shape the engine's copy does not have
    const d = loadSVG(text), c = processDoc(d, settingsFor('professional'));
    d.sourceText = text.replace('</svg>', '<rect width="60" height="60" fill="#f00"/></svg>');
    const o = await finalize(c, {}, { validation: 'strict' });
    ok(!o.validation.ok && o.validation.level === 'original-kept' && /fidelity/.test(o.validation.reason) && o.text === d.sourceText, `a writer that changes the rendering (nothing sanitized): the input text itself is kept (${o.validation.reason.slice(0, 90)}...)`);
  }
  if (!oracle) skip('STRICT with the browser: browser-verified and certified (no browser)');
  else {
    const sb = await run({ validation: 'strict' });
    ok(sb.ok && sb.browserVerified && sb.certified && sb.level === 'browser-verified' && sb.fidelity && sb.fidelity.ok, `STRICT with the browser: ${sb.level}, certified ${sb.certified}, input vs engine-written original in the browser: visible ${(sb.fidelity.visible * 100).toFixed(3)}%`);
  }
}

// ---- regression: final validation (export -> re-parse -> re-render -> browser)
begin('final gate');
// the gate mechanism itself (rollback of what the render shows as changed) is tested
// in FALLBACK when no browser exists, in STRICT with the browser
const V = oracle ? 'strict' : 'fallback';
{
  ok(parsePath('m0 0l0.1 0l0.2 0.3l-0.3 -0.3z').subpaths[0].segs.length === 3, 'a closing gap of floating-point noise is not a segment (0.1 + 0.2 - 0.3 != 0)');
  const text = fs.readFileSync(new URL('../samples/deer-frame-icon.svg', import.meta.url), 'utf8');
  const doc = loadSVG(text), ctx = processDoc(doc, settingsFor('professional'));
  // corrupt one finished contour: the gate must find it and return it to the original
  const last = ctx.history.at(-1).state, e = doc.elements.find((x) => x.editable && x.subpaths.length > 1);
  const moved = last[e.idx].subpaths.map((sp, i) => (i === 1 ? { ...sp, segs: sp.segs.map((g) => ({ ...g, p: g.p.map((q) => [q[0] + 6, q[1]]) })) } : sp));
  last[e.idx] = { ...last[e.idx], subpaths: moved };
  const out = await finalize(ctx, {}, { validation: V });
  ok(out.validation.ok && out.validation.rolledBack.includes(`${e.idx}:1`) && out.validation.rounds >= 2, `the final gate returns a visibly changed contour to its original (${out.validation.rolledBack.join(', ')}; first round: ${out.validation.checks[0].join('; ')})`);
  // a changed protected element is caught even if nothing else notices
  const fdoc = loadSVG('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><filter id="f"><feOffset dx="3"/></filter><path filter="url(#f)" d="M10 10L50 10L90 10L90 90Z"/></svg>');
  const fctx = processDoc(fdoc, settingsFor('professional'));
  fctx.history.at(-1).state[0] = { ...fctx.history.at(-1).state[0], subpaths: [] , removed: true };
  const fo = await finalize(fctx, {}, { validation: V });
  ok(fo.validation.rolledBack.includes('0') && /d="M10 10L50 10L90 10L90 90Z"/.test(fo.text), 'the final gate restores a protected element that was changed');
}

// real vectorized files
begin('real vectorized files');
for (const f of fs.readdirSync(new URL('../samples/', import.meta.url)).filter((f) => f.endsWith('.svg') && f !== 'features.svg')) {
  const text = fs.readFileSync(new URL('../samples/' + f, import.meta.url), 'utf8');
  for (const mode of ['safe', 'professional']) {
    const doc = loadSVG(text);
    analyzeDoc(doc, settingsFor(mode));
    const ctx = processDoc(doc, settingsFor(mode));
    // judged on the exported text: re-parsed, re-rendered, and rendered in the browser
    const out = await finalize(ctx, {}, { validation: V });
    const r = report(ctx, text, out.text), v = out.validation, S = settingsFor(mode);
    const bro = v.browser && v.browser.visible != null ? v.browser : null;
    const rvo = r.repairVsOptimization;
    ok(ctx.history.every((h) => STAGES.includes(h.name)) && !ctx.history.some((h) => h.name === 'Restored') && out.integrity.ok && v.ok && r.processed.nodes <= r.original.nodes && v.internal.visible <= S.globalMax && v.internal.solid <= S.maxSolid * 4
      && v.browserVerified === !!oracle && (oracle ? bro && bro.visible <= S.globalMax && bro.solid <= S.maxSolid * 4 : v.level === 'internal-only')
      && ctx.cropStats.peakBytes <= ctx.cropStats.maxBytes,
      `${f} [${mode}] nodes ${r.original.nodes} -> ${r.processed.nodes}, ${v.level}: internal ${(v.internal.visible * 100).toFixed(3)}% / ${v.internal.solid} spots, browser ${bro ? (bro.visible * 100).toFixed(3) + '% / ' + bro.solid + ' spots' : 'not measured'}, ${v.rolledBack.length} change(s) returned; repairs ${rvo.repairs.total}, optimizations ${rvo.optimizations.total}, rejected ${rvo.rejected}, rolled back ${rvo.rolledBack}; crop cache peak ${(ctx.cropStats.peakBytes / 1048576).toFixed(1)} MB; ${(ctx.ms / 1000).toFixed(1)}s`);
  }
}

// ---- hidden geometry: removed only when CERTAINLY hidden
begin('hidden geometry');
{
  const base = fs.readFileSync(new URL('./fixtures/hidden-sliver-ring.svg', import.meta.url), 'utf8');
  for (const r of ['39.8', '39.95']) for (const mode of ['safe', 'professional', 'aggressive']) {
    const doc = loadSVG(base.replace('r="39.6"', `r="${r}"`)), ctx = processDoc(doc, settingsFor(mode));
    const out = stateOutput(ctx, ctx.history.length - 1, {});
    ok(/data-k="0"/.test(out.text), `a visible ${(40 - +r).toFixed(2)}-unit ring under a circle is kept [${mode}] (was removed as "hidden" when <= 1% showed)`);
  }
  const hc = loadSVG(fs.readFileSync(new URL('./fixtures/hidden-certain.svg', import.meta.url), 'utf8')), hctx = processDoc(hc, settingsFor('professional'));
  ok(!/data-k="0"/.test(stateOutput(hctx, hctx.history.length - 1, {}).text), 'a shape certainly hidden under an opaque shape is still removed');
}

// ---- defect fixtures: real repairs, measured toward the expected geometry
begin('defect fixtures and clean SVG');
{
  const { defectTests } = await import('./defects.js');
  await defectTests(ok, skip, { validation: V });
}

begin('semantic correction, source image');
// semantic correction with a local model (a mock server that speaks the Ollama and
// OpenAI protocols): a clock drawn with 14 marks becomes a clock with 12
{
  const { startMockModel } = await import('./mock-model.js');
  const { detectGroups, buildPrompt, proposals, applyRing, verifyRing } = await import('../src/semantic.js');
  const { askVision, ANSWER_SCHEMA, listModels } = await import('../src/ai.js');
  const { pngBase64 } = await import('../src/png.js');
  const { makeView, render } = await import('../src/raster.js');
  const { resetDoc } = await import('../src/engine.js');
  const server = await startMockModel(11998);
  const doc = loadSVG(fs.readFileSync(new URL('../samples/clock-14-marks.svg', import.meta.url), 'utf8'));
  resetDoc(doc);
  const u = Math.max(doc.viewBox[2], doc.viewBox[3]) / 1000;
  const groups = detectGroups(doc, u);
  ok(groups.some((g) => g.kind === 'radial' && g.members.length === 14), 'the 14 hour marks are found and counted');
  const view = makeView(doc.viewBox, 400), png = pngBase64(render(doc, view), view.W, view.H);
  for (const provider of ['ollama', 'openai']) {
    const cfg = { provider, url: 'http://localhost:11998', model: 'mock-vision' };
    ok((await listModels(cfg)).length === 1, `${provider}: models listed`);
    const { answer } = await askVision(cfg, buildPrompt(groups), png, ANSWER_SCHEMA);
    const p = proposals(groups, answer).find((x) => x.op === 'count');
    ok(p && p.from === 14 && p.to === 12, `${provider}: proposal ${p && p.from} -> ${p && p.to}`);
  }
  const { answer } = await askVision({ provider: 'ollama', url: 'http://localhost:11998', model: 'm' }, buildPrompt(groups), png);
  const p = proposals(groups, answer).find((x) => x.op === 'count'), g = groups.find((x) => x.id === p.group);
  const before = doc.elements.map((e) => ({ subpaths: e.subpaths, removed: false }));
  applyRing(doc, g, p.to, u);
  const v = verifyRing(doc, before, g, u);
  const after = detectGroups(doc, u).find((x) => x.kind === 'radial' && Math.abs(x.radius - g.radius) < 0.1 * g.radius);
  ok(v.ok && after && after.members.length === 12 && after.gapCV < 0.03, `rebuilt as 12 evenly spaced marks, nothing else changed (${v.outside} px outside)`);
  server.close();
}

// restoration to the source image: the deer frame icon and the crop of the sheet it
// was traced from; the icon is found in the picture, and edges move toward it
{
  const { decodePNG } = await import('../src/png.js');
  const { makeSource, align } = await import('../src/source.js');
  const png = decodePNG(fs.readFileSync(new URL('../samples/deer-frame-source.png', import.meta.url)));
  const src = makeSource(png.data, png.width, png.height);
  const doc = loadSVG(fs.readFileSync(new URL('../samples/deer-frame-icon.svg', import.meta.url), 'utf8'));
  const { resetDoc } = await import('../src/engine.js');
  resetDoc(doc);
  src.T = align(doc, src);
  ok(src.T && src.T.correlation > 0.98 && Math.abs(src.T.s - 1) < 0.01 && Math.abs(src.T.tx - 18.06) < 1.5 && Math.abs(src.T.ty - 16.88) < 1.5, `icon found in the source image (s ${src.T.s.toFixed(4)}, offset ${src.T.tx.toFixed(1)}, ${src.T.ty.toFixed(1)}, correlation ${src.T.correlation})`);
  const ctx = processDoc(doc, settingsFor('professional'), () => {}, src);
  const f = ctx.imageFidelity, out = stateOutput(ctx, ctx.history.length - 1, {});
  ok(ctx.history.some((h) => h.name === 'Restored') && f.final.badShare < f.original.badShare && f.final.mean < f.original.mean && out.integrity.ok,
    `closer to the source image: wrong pixels ${(f.original.badShare * 100).toFixed(2)}% -> ${(f.final.badShare * 100).toFixed(2)}%, mean ΔE ${f.original.mean.toFixed(2)} -> ${f.final.mean.toFixed(2)}`);
  // snapping to blurred image edges once left a spike (a 157-degree turn back) in a
  // frame corner: the restored outlines may not turn back where the original did not
  const { newNeedles } = await import('../src/restore.js');
  const ri = ctx.history.findIndex((h) => h.name === 'Restored'), spikes = [];
  doc.elements.forEach((e) => { const st = ctx.history[ri].state[e.idx]; if (e.orig && st.subpaths.length === e.orig.length) st.subpaths.forEach((sp, i) => { if (sp !== e.orig[i] && newNeedles(e.orig[i], sp, ctx.u / (e.scale || 1))) spikes.push(`${e.idx}:${i}`); }); });
  ok(!spikes.length, `restoration to the source image adds no spike to any outline${spikes.length ? ' (' + spikes.join(', ') + ')' : ''}`);
}
begin(null);
{ const { closeBrowser } = await import('../src/browser.js'); await closeBrowser(); }
console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped (browser ${oracle ? 'available' : 'unavailable'})`);
process.exit(fail ? 1 : 0);
