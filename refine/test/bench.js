// Memory / time benchmark. Processes files one after the other in ONE process (the
// order of the test suite: samples/, then test/fixtures/, then test/defects/) and, with
// --isolated, every file again in a fresh process, so a slowdown that only appears in
// sequence (a leak, a growing cache, a poisoned browser queue) shows as a difference.
// Per file: processing time, and the PEAKS seen inside the engine (heapUsed, RSS,
// arrayBuffers, external: src/memprobe.js samples them where the most buffers are
// alive), the crop cache peak in bytes, and heap / arrayBuffers after a GC.
//   node --expose-gc test/bench.js [N] [mode] [--isolated] [--final] [--json out.json]
//   --final also runs the final validation (browser when available, else internal only)
import fs from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { loadSVG } from '../src/model.js';
import { processDoc, finalize } from '../src/process.js';
import { settingsFor } from '../src/engine.js';

const args = process.argv.slice(2);
const num = args.find((a) => /^\d+$/.test(a));
const mode = args.find((a) => ['safe', 'balanced', 'professional', 'aggressive'].includes(a)) || 'professional';
const withFinal = args.includes('--final');
const MB = (b) => (b / 1048576).toFixed(1);
const dirs = [new URL('../samples/', import.meta.url), new URL('./fixtures/', import.meta.url)];
let files = dirs.flatMap((d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.svg')).sort().map((f) => fileURLToPath(new URL(f, d))) : []));
const defects = new URL('./defects/', import.meta.url);
if (fs.existsSync(defects)) for (const n of fs.readdirSync(defects).sort()) { const p = fileURLToPath(new URL(n.endsWith('.svg') ? n : `${n}/bad.svg`, defects)); if (fs.existsSync(p)) files.push(p); }
const N = num ? +num : files.length;

async function one(file) {
  const text = fs.readFileSync(file, 'utf8');
  const t0 = Date.now();
  const doc = loadSVG(text), ctx = processDoc(doc, settingsFor(mode));
  let validation = null;
  if (withFinal) { const out = await finalize(ctx, {}, { validation: 'fallback' }); validation = out.validation.level; }
  const ms = Date.now() - t0, peak = ctx.mem ? ctx.mem.peak : {};
  if (global.gc) global.gc();
  const m = process.memoryUsage();
  return { file: file.split(/[\\/]/).slice(-2).join('/'), ms, peakHeap: peak.heapUsed || 0, peakRss: peak.rss || 0, peakAB: peak.arrayBuffers || 0, peakExt: peak.external || 0, cropPeak: ctx.cropStats ? ctx.cropStats.peakBytes : 0, heapAfterGC: m.heapUsed, abAfterGC: m.arrayBuffers, rssAfter: m.rss, validation };
}

// child mode: one file, JSON on stdout
if (process.env.BENCH_ONE) {
  process.stdout.write(JSON.stringify(await one(process.env.BENCH_ONE)));
  if (withFinal) { const { closeBrowser } = await import('../src/browser.js'); await closeBrowser(); }
  process.exit(0);
}

const rows = [];
const line = (r, tag = '') => console.log(`${String(rows.length).padStart(3)} ${r.file.padEnd(40)} ${String(r.ms).padStart(6)} ms  peak heap ${MB(r.peakHeap).padStart(6)}  rss ${MB(r.peakRss).padStart(6)}  arrayBuffers ${MB(r.peakAB).padStart(6)}  external ${MB(r.peakExt).padStart(6)}  crops ${MB(r.cropPeak).padStart(5)} MB  after GC heap ${MB(r.heapAfterGC).padStart(5)} ab ${MB(r.abAfterGC).padStart(6)}${tag}`);
console.log(`sequential, one process, mode ${mode}${withFinal ? ', with final validation' : ''}, ${N} files`);
for (let i = 0; i < N; i++) { const r = await one(files[i % files.length]); rows.push(r); line(r); }
const peak = (k) => rows.reduce((a, r) => Math.max(a, r[k]), 0);
const slow = [...rows].sort((a, b) => b.ms - a.ms).slice(0, 5);
const summary = {
  files: N, totalMs: rows.reduce((a, r) => a + r.ms, 0), peakHeap: peak('peakHeap'), peakRss: peak('peakRss'), peakArrayBuffers: peak('peakAB'), peakExternal: peak('peakExt'), peakCrops: peak('cropPeak'),
  heapAfterGC: { first: rows[0].heapAfterGC, last: rows.at(-1).heapAfterGC }, slowest: slow.map((r) => ({ file: r.file, ms: r.ms })),
};
console.log(`total ${(summary.totalMs / 1000).toFixed(1)} s; peaks: heap ${MB(summary.peakHeap)} MB, RSS ${MB(summary.peakRss)} MB, arrayBuffers ${MB(summary.peakArrayBuffers)} MB, external ${MB(summary.peakExternal)} MB, crop cache ${MB(summary.peakCrops)} MB; heap after GC first ${MB(summary.heapAfterGC.first)} MB -> last ${MB(summary.heapAfterGC.last)} MB`);
console.log('slowest: ' + slow.map((r) => `${r.file} ${(r.ms / 1000).toFixed(1)} s`).join(', '));
if (args.includes('--isolated')) {
  console.log('\nisolated: every file in a fresh process (same mode); ratio = sequential / isolated time');
  summary.isolated = [];
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.file)) continue;
    seen.add(r.file);
    const file = files.find((f) => f.endsWith(r.file));
    const res = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), mode, ...(withFinal ? ['--final'] : [])], { env: { ...process.env, BENCH_ONE: file }, encoding: 'utf8', maxBuffer: 1 << 24 });
    let iso = null;
    try { iso = JSON.parse(res.stdout); } catch { console.log(`${r.file}: the isolated run failed: ${String(res.stderr).slice(0, 200)}`); continue; }
    const ratio = r.ms / Math.max(1, iso.ms);
    summary.isolated.push({ file: r.file, sequentialMs: r.ms, isolatedMs: iso.ms, ratio });
    console.log(`${r.file.padEnd(40)} sequential ${String(r.ms).padStart(6)} ms  isolated ${String(iso.ms).padStart(6)} ms  ratio ${ratio.toFixed(2)}`);
  }
}
if (args.includes('--json')) fs.writeFileSync(args[args.indexOf('--json') + 1], JSON.stringify({ mode, rows, summary }, null, 1));
if (withFinal) { const { closeBrowser } = await import('../src/browser.js'); await closeBrowser(); }
