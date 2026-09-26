// Memory / time benchmark: processes N files one after the other in ONE process
// (cycling through samples/ and test/fixtures/) and logs, after every file, the
// processing time, heapUsed, RSS and ArrayBuffer memory.
//   node test/bench.js 100 [mode] [--gc]      (--gc needs node --expose-gc)
import fs from 'fs';
import { loadSVG } from '../src/model.js';
import { processDoc, stateOutput } from '../src/process.js';
import { settingsFor } from '../src/engine.js';

const N = +(process.argv[2] || 10), mode = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'professional';
const gc = process.argv.includes('--gc') && global.gc;
const dirs = [new URL('../samples/', import.meta.url), new URL('./fixtures/', import.meta.url)];
const files = dirs.flatMap((d) => fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.svg')).map((f) => new URL(f, d)) : []);
const MB = (b) => (b / 1048576).toFixed(1);
let peakRss = 0, peakHeap = 0, total = 0;
const rows = [];
for (let i = 0; i < N; i++) {
  const f = files[i % files.length], text = fs.readFileSync(f, 'utf8');
  const t0 = Date.now();
  const doc = loadSVG(text);
  const ctx = processDoc(doc, settingsFor(mode));
  stateOutput(ctx, ctx.history.length - 1, {});
  const ms = Date.now() - t0;
  total += ms;
  if (gc) gc();
  const m = process.memoryUsage();
  peakRss = Math.max(peakRss, m.rss); peakHeap = Math.max(peakHeap, m.heapUsed);
  rows.push({ i: i + 1, file: f.pathname.split('/').pop(), ms, heap: +MB(m.heapUsed), rss: +MB(m.rss), ab: +MB(m.arrayBuffers) });
  console.log(`${String(i + 1).padStart(3)} ${f.pathname.split('/').pop().padEnd(34)} ${String(ms).padStart(6)} ms  heap ${MB(m.heapUsed).padStart(7)} MB  rss ${MB(m.rss).padStart(7)} MB  arrayBuffers ${MB(m.arrayBuffers).padStart(7)} MB`);
}
console.log(`files ${N}, total ${(total / 1000).toFixed(1)} s, mean ${(total / N).toFixed(0)} ms/file, peak heap ${MB(peakHeap)} MB, peak rss ${MB(peakRss)} MB`);
if (process.argv.includes('--json')) fs.writeFileSync(process.argv[process.argv.indexOf('--json') + 1], JSON.stringify(rows));
