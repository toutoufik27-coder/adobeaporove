// Renderer conformance: the internal reference renderer against the browser (the source
// of truth) on every fixture and sample. Pixels inside uncertain regions (what the
// capability system already protects: text, image, filter, pattern ...) are excluded;
// everywhere else the renderer claims to be exact, and this measures it.
//   node test/conformance.js [--all] [--png out-dir]
import fs from 'fs';
import { loadSVG } from '../src/model.js';
import { exportSVG } from '../src/output.js';
import { makeView, render } from '../src/raster.js';
import { renderViewFor } from '../src/viewport.js';
import { compare } from '../src/metrics.js';
import { getBrowser, closeBrowser } from '../src/browser.js';
import { pngBase64 } from '../src/png.js';

// Agreement required where the renderer claims support: no solid spot at all (a real
// shape difference), and only isolated edge pixels. Measured on the real samples: lines
// and fractional edges match Chrome exactly (coverage 0.75 -> 64, 0.875 -> 32); the
// remaining edge noise (<= 0.18 %) is on curves, is unchanged by 4x..16x supersampling
// and grows when the curve flattening is made MORE exact, so it is Chrome's own curve
// approximation. The limit sits just above that measured floor.
export const LIMITS = { visible: 0.0025, meanDE: 0.6, solid: 0 };

export async function conformance(files, { pngDir = null, side = 400 } = {}) {
  const browser = await getBrowser();
  if (!browser) return null;
  const rows = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const doc = loadSVG(text);
    const clean = exportSVG(doc, doc.elements.map((e) => ({ subpaths: e.orig, removed: false })), { exact: true });
    const rv = renderViewFor(doc, side);
    const view = rv.view;
    const mine = render(doc, view, { orig: true });
    const { img: ref } = await browser.render(clean, rv.cssW, rv.cssH);
    // mask out uncertain regions
    const skip = new Uint8Array(view.W * view.H);
    let skipped = 0;
    for (const r of doc.uncertain || []) {
      const x0 = Math.max(0, Math.floor((r.box[0] - view.x) * view.k) - 2), x1 = Math.min(view.W, Math.ceil((r.box[2] - view.x) * view.k) + 2);
      const y0 = Math.max(0, Math.floor((r.box[1] - view.y) * view.k) - 2), y1 = Math.min(view.H, Math.ceil((r.box[3] - view.y) * view.k) + 2);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (!skip[y * view.W + x]) { skip[y * view.W + x] = 1; skipped++; }
    }
    const a = Float32Array.from(ref), b = Float32Array.from(mine);
    for (let p = 0; p < skip.length; p++) if (skip[p]) for (let c = 0; c < 3; c++) { a[p * 3 + c] = 255; b[p * 3 + c] = 255; }
    const c = compare(a, b, view, { radius: 1 });
    // defect fixtures are all called bad.svg / expected.svg: keep their folder in the name
    const parts = (f.pathname || String(f)).split('/'), name = /^(bad|expected)\.svg$/.test(parts.at(-1)) ? parts.slice(-2).join('/') : parts.at(-1);
    const row = { name, visible: c.visibleShare, pixel: c.pixelShare, mean: c.mean, solid: c.solid, excluded: skipped / skip.length, pass: c.visibleShare <= LIMITS.visible && c.mean <= LIMITS.meanDE && c.solid <= LIMITS.solid };
    rows.push(row);
    if (pngDir) {
      fs.mkdirSync(pngDir, { recursive: true });
      fs.writeFileSync(`${pngDir}/${name}.browser.png`, Buffer.from(pngBase64(ref, view.W, view.H), 'base64'));
      fs.writeFileSync(`${pngDir}/${name}.internal.png`, Buffer.from(pngBase64(mine, view.W, view.H), 'base64'));
    }
  }
  return rows;
}

if (process.argv[1] && process.argv[1].endsWith('conformance.js')) {
  const dirs = [new URL('../samples/', import.meta.url), new URL('./fixtures/', import.meta.url)];
  const files = dirs.flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.svg')).map((f) => new URL(f, d)));
  const pi = process.argv.indexOf('--png');
  const rows = await conformance(files, { pngDir: pi > 0 ? process.argv[pi + 1] : null });
  if (!rows) { console.log('SKIP no browser found (set SVG_REFINE_BROWSER)'); process.exit(0); }
  let fail = 0;
  for (const r of rows) {
    if (!r.pass) fail++;
    console.log(`${r.pass ? 'ok  ' : 'DIFF'} ${r.name.padEnd(34)} visible ${(r.visible * 100).toFixed(3).padStart(7)}%  pixels ${(r.pixel * 100).toFixed(3).padStart(7)}%  meanΔE ${r.mean.toFixed(3).padStart(6)}  spots ${String(r.solid).padStart(5)}  excluded ${(r.excluded * 100).toFixed(0).padStart(3)}%`);
  }
  console.log(`${rows.length - fail}/${rows.length} agree with the browser`);
  await closeBrowser();
  process.exit(fail ? 1 : 0);
}
