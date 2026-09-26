// Final audit numbers, measured (nothing here is copied from a document):
//   - browser oracle: available or not, and why
//   - conformance: internal renderer vs the browser on every sample, fixture and defect
//   - per file (samples, fixtures, defects; one process, in order): time, memory peaks,
//     repairs / optimizations / rejected / rolled back, validation level
//   - what the renderer does not draw (protected, validated only in the browser)
//   node test/audit.js [--mode professional] [--json out.json]
import fs from 'fs';
import { fileURLToPath } from 'url';
import { loadSVG } from '../src/model.js';
import { processDoc, finalize, report } from '../src/process.js';
import { settingsFor } from '../src/engine.js';
import { CAPS } from '../src/raster.js';
import { getBrowser, browserStatus, closeBrowser } from '../src/browser.js';
import { conformance } from './conformance.js';

const args = process.argv.slice(2);
const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'professional';
const MB = (b) => +(b / 1048576).toFixed(1);
const list = (d, f = (x) => x.endsWith('.svg')) => fs.readdirSync(d).filter(f).sort().map((x) => new URL(x, d));
const samples = list(new URL('../samples/', import.meta.url)), fixtures = list(new URL('./fixtures/', import.meta.url));
const defDir = new URL('./defects/', import.meta.url);
const defects = fs.readdirSync(defDir).sort().map((n) => new URL(n.endsWith('.svg') ? n : `${n}/bad.svg`, defDir));
const files = [...samples, ...fixtures, ...defects];
const name = (u) => fileURLToPath(u).split(/[\\/]/).slice(-2).join('/');

const oracle = await getBrowser();
const out = { mode, browser: browserStatus(), conformance: null, files: [], totals: {}, unsupported: {} };
console.log(`browser: ${oracle ? 'available ' + oracle.exe : 'UNAVAILABLE (' + out.browser.reason + ')'}`);

if (oracle) {
  const rows = await conformance(files);
  out.conformance = rows.map((r) => ({ ...r, name: r.name, measured: r.excluded < 0.99 }));
  for (const r of out.conformance) console.log(`conformance ${r.measured ? (r.pass ? 'ok  ' : 'DIFF') : 'n/a '} ${r.name.padEnd(34)} visible ${(r.visible * 100).toFixed(3)}%  pixels ${(r.pixel * 100).toFixed(3)}%  meanΔE ${r.mean.toFixed(3)}  solid ${r.solid}  excluded ${(r.excluded * 100).toFixed(0)}%`);
}

const T = { repairs: 0, optimizations: 0, rejected: 0, rolledBack: 0, byRepair: {}, byOpt: {}, levels: {}, peak: { rss: 0, heapUsed: 0, arrayBuffers: 0, external: 0 }, maxMs: 0, maxFile: null, cropPeak: 0 };
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const t0 = Date.now();
  const doc = loadSVG(text), ctx = processDoc(doc, settingsFor(mode));
  const fin = await finalize(ctx, {}, { validation: oracle ? 'strict' : 'fallback' });
  const ms = Date.now() - t0, r = report(ctx, text, fin.text), x = r.repairVsOptimization, v = fin.validation;
  for (const [k, n] of Object.entries(doc.unsupported)) out.unsupported[k] = (out.unsupported[k] || 0) + n;
  for (const e of doc.elements) for (const why of e.support ? e.support.reasons : []) out.unsupported[`protected: ${why.code}`] = (out.unsupported[`protected: ${why.code}`] || 0) + 1;
  const row = { file: name(f), ms, nodes: [r.original.nodes, r.processed.nodes], bytes: [r.original.bytes, r.processed.bytes], repairs: x.repairs, optimizations: x.optimizations, rejected: x.rejected, rolledBack: x.rolledBack + v.rolledBack.length, level: v.level, internal: v.internal, browser: v.browser, mem: ctx.mem ? ctx.mem.peak : null, cropPeak: ctx.cropStats.peakBytes };
  out.files.push(row);
  T.repairs += x.repairs.total; T.optimizations += x.optimizations.total; T.rejected += x.rejected; T.rolledBack += row.rolledBack;
  for (const [k, n] of Object.entries(x.repairs.byType)) T.byRepair[k] = (T.byRepair[k] || 0) + n;
  for (const [k, n] of Object.entries(x.optimizations.byType)) T.byOpt[k] = (T.byOpt[k] || 0) + n;
  T.levels[v.level] = (T.levels[v.level] || 0) + 1;
  if (ctx.mem) for (const k of Object.keys(T.peak)) T.peak[k] = Math.max(T.peak[k], ctx.mem.peak[k]);
  T.cropPeak = Math.max(T.cropPeak, row.cropPeak);
  if (ms > T.maxMs) { T.maxMs = ms; T.maxFile = row.file; }
  console.log(`${row.file.padEnd(40)} ${String(ms).padStart(6)} ms  nodes ${row.nodes.join('->')}  repairs ${x.repairs.total} optimizations ${x.optimizations.total} rejected ${x.rejected} rolled back ${row.rolledBack}  ${v.level}  peak rss ${ctx.mem ? MB(ctx.mem.peak.rss) : '-'} MB ab ${ctx.mem ? MB(ctx.mem.peak.arrayBuffers) : '-'} MB`);
}
out.totals = { ...T, peak: Object.fromEntries(Object.entries(T.peak).map(([k, v]) => [k, MB(v)])), cropPeakMB: MB(T.cropPeak), slowest: [...out.files].sort((a, b) => b.ms - a.ms).slice(0, 5).map((r) => `${r.file} ${(r.ms / 1000).toFixed(1)} s`) };
out.notDrawn = Object.entries(CAPS).filter(([, v]) => !v).map(([k]) => k);
console.log(JSON.stringify(out.totals, null, 1));
console.log('not drawn by the internal renderer (protected; validated only in the browser): ' + out.notDrawn.join(', '));
console.log('unsupported / protected occurrences: ' + JSON.stringify(out.unsupported));
if (args.includes('--json')) fs.writeFileSync(args[args.indexOf('--json') + 1], JSON.stringify(out, null, 1));
await closeBrowser();
