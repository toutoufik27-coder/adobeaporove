// Generates the defect fixtures in test/defects/ (run once; the files are kept):
// every case is a drawing with a real geometric defect (bad.svg) and the drawing as it
// should be (expected.svg). expected.svg is the corrected geometry, not a minified copy
// of bad.svg: the tests measure whether the engine output moved TOWARD it.
// clean.svg is a drawing without defects: the engine must not repair anything there.
//   node test/make-defects.js
import fs from 'fs';

// deterministic noise (the fixtures must not change between runs)
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const f = (v) => +v.toFixed(3);
const pts = (P) => P.map((p) => `${f(p[0])} ${f(p[1])}`);
const poly = (P, close = true) => 'M' + pts(P).join(' L') + (close ? 'Z' : '');
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="400" height="400">\n${body}\n</svg>\n`;
const circleD = (cx, cy, r) => `M${f(cx + r)} ${f(cy)}A${f(r)} ${f(r)} 0 0 1 ${f(cx - r)} ${f(cy)}A${f(r)} ${f(r)} 0 0 1 ${f(cx + r)} ${f(cy)}Z`;
const ellipseD = (cx, cy, rx, ry) => `M${f(cx + rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 0 1 ${f(cx - rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 0 1 ${f(cx + rx)} ${f(cy)}Z`;
// a circle traced as n straight segments with radial jitter (fraction of r)
function tracedCircle(cx, cy, r, n, jitter, seed) {
  const R = rng(seed), P = [];
  for (let i = 0; i < n; i++) { const t = (2 * Math.PI * (i + 0.3 * (R() - 0.5))) / n, rr = r * (1 + jitter * (2 * R() - 1)); P.push([cx + rr * Math.cos(t), cy + rr * Math.sin(t)]); }
  return poly(P);
}
// an ellipse as four cubic quarters, each with its own (wrong) handle ratio
function kappaEllipse(cx, cy, rx, ry, ks) {
  const q = [[cx + rx, cy], [cx, cy + ry], [cx - rx, cy], [cx, cy - ry]];
  const tan = [[0, 1], [-1, 0], [0, -1], [1, 0]];
  let d = `M${f(q[0][0])} ${f(q[0][1])}`;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], ta = tan[i], tb = tan[(i + 1) % 4], k = ks[i];
    const la = i % 2 === 0 ? ry : rx, lb = i % 2 === 0 ? rx : ry;
    d += `C${f(a[0] + ta[0] * k * la)} ${f(a[1] + ta[1] * k * la)} ${f(b[0] - tb[0] * k * lb)} ${f(b[1] - tb[1] * k * lb)} ${f(b[0])} ${f(b[1])}`;
  }
  return d + 'Z';
}
// a smooth closed blob: cubic segments through `P` with tangents from the neighbours
function blob(P, bend = null) {
  const n = P.length, T = P.map((p, i) => { const a = P[(i - 1 + n) % n], b = P[(i + 1) % n]; return [(b[0] - a[0]) / 6, (b[1] - a[1]) / 6]; });
  let d = `M${f(P[0][0])} ${f(P[0][1])}`;
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[(i + 1) % n];
    let c1 = [a[0] + T[i][0], a[1] + T[i][1]];
    const c2 = [b[0] - T[(i + 1) % n][0], b[1] - T[(i + 1) % n][1]];
    // the outlier: the handle leaving node `seg`, pushed sideways by `off` units
    if (bend && bend.seg === i) { const L = Math.hypot(T[i][0], T[i][1]); c1 = [c1[0] - (T[i][1] / L) * bend.off, c1[1] + (T[i][0] / L) * bend.off]; }
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(b[0])} ${f(b[1])}`;
  }
  return d + 'Z';
}
const BLOB = [[100, 40], [140, 55], [160, 95], [150, 140], [110, 165], [65, 150], [42, 110], [55, 65]];

export const DEFECTS = {
  // 1. a circle traced with many points, slightly distorted -> a true circle
  'distorted-circle': {
    kind: 'primitive reconstruction', count: 1,
    bad: `  <path fill="#264653" d="${tracedCircle(100, 100, 60, 72, 0.004, 1)}"/>`,
    expected: `  <path fill="#264653" d="${circleD(100, 100, 60)}"/>`,
  },
  // 2. an ellipse whose quarter handles are wrong (irregular) -> a true ellipse
  'irregular-ellipse': {
    kind: 'primitive reconstruction', count: 1,
    bad: `  <path fill="#e76f51" d="${kappaEllipse(100, 100, 70, 40, [0.545, 0.558, 0.548, 0.556])}"/>`,
    expected: `  <path fill="#e76f51" d="${ellipseD(100, 100, 70, 40)}"/>`,
  },
  // 3. a rectangle with redundant nodes on its sides, two of them off the line (bent sides)
  'rectangle-extra-points': {
    kind: 'primitive reconstruction', count: 1,
    bad: `  <path fill="#2a9d8f" d="M40 50 L60 50 L80 50.04 L100 50 L120 50 L140 50 L160 50 L160 75 L160 100 L159.96 125 L160 150 L130 150 L100 150 L70 150 L40 150 L40 120 L40 90 L40 70Z"/>`,
    expected: `  <path fill="#2a9d8f" d="M40 50H160V150H40Z"/>`,
  },
  // 4. a smooth outline with one wrong control point: a kink at a node and a bump
  'outlier-control-point': {
    kind: 'geometry correction', count: 1,
    bad: `  <path fill="#6a4c93" d="${blob(BLOB, { seg: 2, off: 0.6 })}"/>`,
    expected: `  <path fill="#6a4c93" d="${blob(BLOB)}"/>`,
  },
  // 5. a speck left by the tracer, away from everything else
  'tiny-artifact': {
    kind: 'accidental artifacts', count: 1,
    bad: `  <path fill="#1d3557" d="M50 50H150V150H50Z"/>\n  <path fill="#1d3557" d="M20 175L20.25 175L20.25 175.25L20 175.25Z"/>`,
    expected: `  <path fill="#1d3557" d="M50 50H150V150H50Z"/>`,
  },
  // 6. the same shape drawn twice, one on top of the other
  'duplicate-geometry': {
    kind: 'accidental artifacts', count: 1,
    bad: `  <path fill="#e63946" d="M100 30L165 150H35Z"/>\n  <path fill="#e63946" d="M100 30L165 150H35Z"/>`,
    expected: `  <path fill="#e63946" d="M100 30L165 150H35Z"/>`,
  },
  // 7. one stroked line broken into two subpaths at a shared node
  'broken-continuity': {
    kind: 'broken continuity', count: 1,
    bad: `  <path fill="none" stroke="#000" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" d="M20 150L60 60L100 120M100 120L140 60L180 150"/>`,
    expected: `  <path fill="none" stroke="#000" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" d="M20 150L60 60L100 120L140 60L180 150"/>`,
  },
  // 8. closed outlines left open by a tiny gap (a filled one and a stroked one)
  'tiny-gap': {
    kind: 'broken continuity', count: 2,
    bad: `  <path fill="#457b9d" d="M30 30L100 30L100 100L30 100L30 30.08"/>\n  <path fill="none" stroke="#000" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" d="M120 120L170 120L170 170L120 170L120 120.08"/>`,
    expected: `  <path fill="#457b9d" d="M30 30L100 30L100 100L30 100Z"/>\n  <path fill="none" stroke="#000" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" d="M120 120L170 120L170 170L120 170Z"/>`,
  },
  // 9. a square whose corner overshoots and crosses back: a tiny needless loop
  'self-intersection': {
    kind: 'topology repair', count: 1,
    bad: `  <path fill="#264653" d="M50 50L150.3 50L150 49.7L150 150L50 150Z"/>`,
    expected: `  <path fill="#264653" d="M50 50L150 50L150 150L50 150Z"/>`,
  },
  // 10. a row of the same dot, every copy distorted differently
  'distorted-repeated-shapes': {
    kind: 'primitive reconstruction', count: 5,
    bad: [30, 65, 100, 135, 170].map((x, i) => `  <path fill="#f4a261" d="${tracedCircle(x, 100, 12, 36, 0.005, 10 + i)}"/>`).join('\n'),
    expected: [30, 65, 100, 135, 170].map((x) => `  <path fill="#f4a261" d="${circleD(x, 100, 12)}"/>`).join('\n'),
  },
};

// Clean geometry: exact arcs, straight sides, minimal smooth cubics. Nothing to repair.
export const CLEAN = svg([
  `  <path fill="#264653" d="${circleD(55, 55, 35)}"/>`,
  `  <path fill="#2a9d8f" d="M110 20H180V90H110Z"/>`,
  `  <path fill="#e9c46a" d="${blob([[55, 110], [90, 130], [75, 180], [30, 175], [20, 135]])}"/>`,
  `  <path fill="none" stroke="#e76f51" stroke-width="4" stroke-linecap="round" d="M110 180C130 120 160 120 180 180"/>`,
].join('\n'));

if (process.argv[1] && process.argv[1].endsWith('make-defects.js')) {
  const dir = new URL('./defects/', import.meta.url);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, d] of Object.entries(DEFECTS)) {
    fs.mkdirSync(new URL(`${name}/`, dir), { recursive: true });
    fs.writeFileSync(new URL(`${name}/bad.svg`, dir), svg(d.bad));
    fs.writeFileSync(new URL(`${name}/expected.svg`, dir), svg(d.expected));
  }
  fs.writeFileSync(new URL('clean.svg', dir), CLEAN);
  console.log(`${Object.keys(DEFECTS).length} defect fixtures + clean.svg written to test/defects/`);
}
