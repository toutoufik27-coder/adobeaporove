// Generates the adversarial fixtures in test/fixtures/ (run once; the files are kept).
// Every fixture draws "noisy" paths: outlines with redundant collinear and near-duplicate
// nodes that the engine would normally simplify. Elements that must come out unchanged
// carry data-role="protected"; data-role="control" marks plain geometry nearby that may
// be improved (it proves the protection is targeted, not global); data-role="keep"
// marks geometry that must not be removed.
//   node test/make-fixtures.js
import fs from 'fs';
import { pngBase64 } from '../src/png.js';

const f2 = (v) => +v.toFixed(2);
// a rectangle outline with a node every `step` units and small jitter-free duplicates
export function noisyRect(x, y, w, h, step = 2) {
  const P = [];
  const edge = (x0, y0, x1, y1) => { const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / step)); for (let i = 0; i < n; i++) P.push([x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]); };
  edge(x, y, x + w, y); edge(x + w, y, x + w, y + h); edge(x + w, y + h, x, y + h); edge(x, y + h, x, y);
  return 'M' + P.map((p) => `${f2(p[0])} ${f2(p[1])}`).join(' L') + 'Z';
}
// a circle drawn with many short lines (a candidate for curve fitting / circle recognition)
export function noisyCircle(cx, cy, r, n = 48) {
  const P = [];
  for (let i = 0; i < n; i++) { const t = (2 * Math.PI * i) / n; P.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
  return 'M' + P.map((p) => `${f2(p[0])} ${f2(p[1])}`).join(' L') + 'Z';
}
const svg = (body, attrs = 'viewBox="0 0 200 200" width="400" height="400"') => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>\n${body}\n</svg>\n`;
const CONTROL = `  <path data-role="control" fill="#1b998b" d="${noisyRect(150, 150, 40, 40)}"/>`;
// 4x4 checker image (red / blue), made with the engine's own encoder
const PNG = 'data:image/png;base64,' + pngBase64(Float32Array.from({ length: 48 }, (_, i) => { const p = Math.floor(i / 3), c = i % 3, on = ((p % 4) + Math.floor(p / 4)) % 2; return on ? [230, 57, 70][c] : [29, 53, 87][c]; }), 4, 4);

export const FIXTURES = {
  'filter-shadow': svg(`  <defs><filter id="shadow" x="-20%" y="-20%" width="160%" height="160%"><feDropShadow dx="6" dy="6" stdDeviation="3" flood-color="#000" flood-opacity="0.6"/></filter></defs>
  <path data-role="protected" filter="url(#shadow)" fill="#e63946" d="${noisyRect(20, 20, 60, 60)}"/>
${CONTROL}`),
  'filter-group': svg(`  <defs><filter id="blur"><feGaussianBlur stdDeviation="2"/></filter></defs>
  <g filter="url(#blur)"><path data-role="protected" fill="#457b9d" d="${noisyRect(20, 20, 60, 60)}"/></g>
${CONTROL}`),
  'filter-css-function': svg(`  <path data-role="protected" style="filter: blur(2px)" fill="#457b9d" d="${noisyRect(20, 20, 60, 60)}"/>
${CONTROL}`),
  'pattern-fill': svg(`  <defs><pattern id="pat" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(30)"><rect width="5" height="10" fill="#264653"/></pattern></defs>
  <path data-role="protected" fill="url(#pat)" d="${noisyRect(20, 20, 60, 60)}"/>
${CONTROL}`),
  'gradient-linear': svg(`  <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#f4a261"/><stop offset="0.5" stop-color="#2a9d8f" stop-opacity="0.5"/><stop offset="1" stop-color="#e76f51"/></linearGradient></defs>
  <path data-role="gradient" fill="url(#lg)" d="${noisyRect(20, 20, 100, 60)}"/>
${CONTROL}`),
  'gradient-radial': svg(`  <defs><radialGradient id="rg" cx="0.5" cy="0.5" r="0.4" fx="0.3" fy="0.3" spreadMethod="reflect" gradientTransform="rotate(20 0.5 0.5)"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#1d3557"/></radialGradient></defs>
  <path data-role="gradient" fill="url(#rg)" d="${noisyCircle(70, 70, 50)}"/>
${CONTROL}`),
  'gradient-userspace-spread': svg(`  <defs><linearGradient id="ug" gradientUnits="userSpaceOnUse" x1="20" y1="0" x2="40" y2="0" spreadMethod="repeat"><stop offset="0" stop-color="#003049"/><stop offset="1" stop-color="#fcbf49"/></linearGradient></defs>
  <path data-role="gradient" fill="url(#ug)" d="${noisyRect(10, 10, 120, 50)}"/>
${CONTROL}`),
  'mask-luminance': svg(`  <defs><mask id="m"><rect x="0" y="0" width="200" height="200" fill="#fff"/><circle cx="50" cy="50" r="20" fill="#000"/><rect x="60" y="20" width="30" height="60" fill="#808080"/></mask></defs>
  <path data-role="mask" mask="url(#m)" fill="#6a4c93" d="${noisyRect(15, 15, 80, 80)}"/>
${CONTROL}`),
  'mask-bbox-alpha': svg(`  <defs><mask id="m2" maskContentUnits="objectBoundingBox" style="mask-type:alpha"><rect x="0.25" y="0" width="0.5" height="1" fill="#000" fill-opacity="0.5"/></mask></defs>
  <path data-role="mask" mask="url(#m2)" fill="#6a4c93" d="${noisyRect(15, 15, 80, 80)}"/>
${CONTROL}`),
  'mask-group': svg(`  <defs><mask id="mg"><rect x="0" y="0" width="200" height="200" fill="#fff"/><rect x="30" y="30" width="70" height="30" fill="#666"/></mask></defs>
  <g mask="url(#mg)" opacity="0.8"><path data-role="mask" fill="#ff006e" d="${noisyRect(20, 20, 60, 60)}"/><path data-role="mask" fill="#3a86ff" stroke="#000" stroke-width="4" opacity="0.7" d="${noisyRect(50, 50, 60, 60)}"/></g>
${CONTROL}`),
  'mask-group-bbox': svg(`  <defs><mask id="mb" maskContentUnits="objectBoundingBox"><rect x="0" y="0" width="0.5" height="1" fill="#fff"/></mask></defs>
  <g mask="url(#mb)"><path data-role="mask" fill="#8338ec" d="${noisyRect(20, 20, 60, 60)}"/><path data-role="mask" fill="#fb5607" d="${noisyRect(60, 60, 60, 60)}"/></g>
${CONTROL}`),
  'clip-bbox': svg(`  <defs><clipPath id="cb" clipPathUnits="objectBoundingBox"><circle cx="0.5" cy="0.5" r="0.4"/></clipPath></defs>
  <path data-role="clip" clip-path="url(#cb)" fill="#ff595e" d="${noisyRect(20, 20, 80, 80)}"/>
${CONTROL}`),
  'clip-user-nested': svg(`  <defs><clipPath id="c1"><rect x="10" y="10" width="70" height="70" transform="rotate(10 45 45)"/></clipPath><clipPath id="c2" clip-path="url(#c1)"><circle cx="45" cy="45" r="40"/></clipPath></defs>
  <g transform="translate(5 5)"><path data-role="clip" clip-path="url(#c2)" fill="#ffca3a" d="${noisyRect(5, 5, 90, 90)}"/></g>
${CONTROL}`),
  'text-overlap': svg(`  <path data-role="keep" fill="#8ac926" d="${noisyRect(20, 40, 120, 50)}"/>
  <text x="30" y="75" font-family="sans-serif" font-size="24" fill="#1982c4">Hello</text>
${CONTROL}`),
  'image-overlap': svg(`  <path data-role="keep" fill="#8ac926" d="${noisyRect(20, 20, 80, 80)}"/>
  <image x="30" y="30" width="60" height="60" href="${PNG}"/>
${CONTROL}`),
  'image-over-hidden': svg(`  <path data-role="keep" fill="#8ac926" d="${noisyRect(40, 40, 30, 30)}"/>
  <image x="20" y="20" width="80" height="80" preserveAspectRatio="none" href="${PNG}"/>
${CONTROL}`),
  'marker-inherited': svg(`  <defs><marker id="arrow" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto"><path d="M0 0L6 3L0 6Z" fill="#000"/></marker></defs>
  <g marker-end="url(#arrow)" marker-mid="url(#arrow)"><path data-role="protected" fill="none" stroke="#333" stroke-width="2" d="M20 100 L30 100 L40 100 L50 100 L60 100 L70 100 L80 100 L90 100 L100 100"/></g>
${CONTROL}`),
  'marker-css': svg(`  <style>.m{marker:url(#dot)}</style>
  <defs><marker id="dot" markerWidth="4" markerHeight="4" refX="2" refY="2"><circle cx="2" cy="2" r="2" fill="#d62828"/></marker></defs>
  <path data-role="protected" class="m" fill="none" stroke="#333" stroke-width="2" d="M20 60 L30 60 L40 60 L50 60 L60 60 L70 60 L80 60"/>
${CONTROL}`),
  'vector-effect': svg(`  <g transform="scale(3)"><path data-role="protected" vector-effect="non-scaling-stroke" fill="#eee" stroke="#000" stroke-width="2" d="${noisyRect(5, 5, 20, 20, 1)}"/></g>
${CONTROL}`),
  'stroke-skew': svg(`  <g transform="skewX(30) scale(1 0.5)"><path data-role="stroke" fill="none" stroke="#0077b6" stroke-width="6" stroke-linejoin="miter" d="${noisyRect(10, 20, 60, 60)}"/></g>
${CONTROL}`),
  'stroke-dash': svg(`  <path data-role="protected" fill="none" stroke="#0077b6" stroke-width="3" stroke-dasharray="8 4" stroke-dashoffset="3" stroke-linecap="round" d="${noisyRect(20, 20, 80, 80)}"/>
${CONTROL}`),
  'css-descendant': svg(`  <style>g.a path{fill:#e71d36} g > path.b{stroke:#011627;stroke-width:3} path[data-x]{opacity:.5}</style>
  <g class="a"><path data-role="css" data-x="1" class="b" fill="#2ec4b6" d="${noisyRect(20, 20, 60, 60)}"/></g>
${CONTROL}`),
  'css-important': svg(`  <style>.x{fill:#ff9f1c !important} path{fill:#2ec4b6}</style>
  <path data-role="css" class="x" style="fill:#011627" d="${noisyRect(20, 20, 60, 60)}"/>
${CONTROL}`),
  'css-media': svg(`  <style>@media (max-width: 100px){ .y{fill:#e71d36} } .y{fill:#2ec4b6}</style>
  <path data-role="css" class="y" d="${noisyRect(20, 20, 60, 60)}"/>
${CONTROL}`),
  'css-pseudo': svg(`  <style>path:first-child{fill:#e71d36} path:hover{fill:#000}</style>
  <path data-role="css" fill="#2ec4b6" d="${noisyRect(20, 20, 60, 60)}"/>
${CONTROL}`),
  'transform-invalid': svg(`  <path data-role="protected" transform="translate(30) foo(2)" fill="#9b5de5" d="${noisyRect(20, 20, 60, 60)}"/>
${CONTROL}`),
  'transform-css': svg(`  <path data-role="protected" style="transform: rotate(10deg)" fill="#9b5de5" d="${noisyRect(20, 20, 60, 60)}"/>
${CONTROL}`),
  'nested-svg': svg(`  <svg x="10" y="10" width="100" height="50" viewBox="0 0 50 50" preserveAspectRatio="xMaxYMid slice"><path data-role="viewport" fill="#f15bb5" d="${noisyRect(-10, 5, 70, 40)}"/></svg>
${CONTROL}`),
  'use-symbol': svg(`  <defs><symbol id="sym" viewBox="0 0 20 10" preserveAspectRatio="xMidYMax meet"><g transform="translate(2 1)" fill="#e76f51"><g transform="rotate(10)"><path d="M0 0H16V8H0Z"/></g><circle cx="15" cy="-2" r="4" fill="#2a9d8f"/></g></symbol></defs>
  <use href="#sym" x="10" y="10" width="80" height="80"/>
  <path data-role="keep" fill="#264653" d="${noisyRect(100, 20, 60, 40)}"/>
${CONTROL}`),
  'use-in-group': svg(`  <defs><symbol id="s2" viewBox="0 0 10 10"><rect width="10" height="10" fill="#023e8a"/></symbol></defs>
  <g opacity="0.5"><rect x="20" y="20" width="60" height="60" fill="#0077b6"/><use href="#s2" x="50" y="50" width="60" height="60" opacity="0.8"/></g>
${CONTROL}`),
  'nested-svg-overflow': svg(`  <svg x="20" y="20" width="60" height="60" viewBox="0 0 10 10" overflow="visible"><path data-role="viewport" fill="#f15bb5" d="${noisyRect(-2, 2, 14, 6, 0.5)}"/></svg>
  <svg x="100" y="20" width="60" height="60" viewBox="0 0 10 10"><path data-role="viewport" fill="#9b5de5" d="${noisyRect(-2, 2, 14, 6, 0.5)}"/></svg>
${CONTROL}`),
  'nested-transforms': svg(`  <g transform="translate(100 20) rotate(30)"><g transform="scale(-1 1)"><g transform="matrix(1 0.2 -0.3 1 5 5)"><path data-role="transform" fill="#00bbf9" d="${noisyRect(10, 10, 50, 40)}"/></g></g></g>
${CONTROL}`),
  'negative-scale': svg(`  <g transform="scale(-1 -1) translate(-120 -120)"><path data-role="transform" fill="#00f5d4" stroke="#222" stroke-width="2" d="${noisyCircle(50, 50, 30)}"/></g>
${CONTROL}`),
  'rotated-shapes': svg(`  <path data-role="transform" transform="rotate(37 60 60)" fill="#fee440" d="${noisyRect(30, 40, 60, 40)}"/>
${CONTROL}`),
  'skew': svg(`  <path data-role="transform" transform="skewY(20)" fill="#fb5607" d="${noisyRect(20, 10, 60, 40)}"/>
${CONTROL}`),
  'non-uniform-scale-stroke': svg(`  <path data-role="stroke" transform="scale(2 0.5)" fill="none" stroke="#3a86ff" stroke-width="4" stroke-linecap="square" d="M10 60 L20 60 L30 70 L40 60 L50 60"/>
${CONTROL}`),
  'group-opacity': svg(`  <g opacity="0.5"><path data-role="opacity" fill="#ff006e" d="${noisyRect(20, 20, 60, 60)}"/><path data-role="opacity" fill="#3a86ff" d="${noisyRect(50, 50, 60, 60)}"/></g>
${CONTROL}`),
  'opacity-fill-stroke': svg(`  <path data-role="opacity" opacity="0.5" fill="#ff006e" stroke="#3a86ff" stroke-width="10" d="${noisyRect(30, 30, 80, 80)}"/>
${CONTROL}`),
  'use-referenced': svg(`  <path id="p" data-role="protected" fill="#8338ec" d="${noisyRect(20, 20, 40, 40)}"/>
  <use href="#p" x="60" y="0"/>
${CONTROL}`),
  'par-meet-mismatch': svg(`  <path data-role="keep" fill="#ffbe0b" d="${noisyRect(-40, 20, 60, 60)}"/>
${CONTROL}`, 'viewBox="0 0 200 200" width="600" height="300"'),
  'par-slice': svg(`  <path data-role="viewport" fill="#ffbe0b" d="${noisyRect(20, 20, 60, 60)}"/>
${CONTROL}`, 'viewBox="0 0 200 200" width="600" height="300" preserveAspectRatio="xMinYMax slice"'),
  'par-none': svg(`  <path data-role="viewport" fill="#ffbe0b" stroke="#000" stroke-width="3" d="${noisyCircle(60, 60, 40)}"/>
${CONTROL}`, 'viewBox="0 0 200 200" width="600" height="300" preserveAspectRatio="none"'),
  'compound-holes': svg(`  <path data-role="topology" fill="#2b2d42" fill-rule="evenodd" d="${noisyRect(20, 20, 100, 100)} ${noisyRect(40, 40, 20, 20)} ${noisyRect(80, 80, 20, 20)}"/>
${CONTROL}`),
  'nonzero-holes': svg(`  <path data-role="topology" fill="#2b2d42" d="M20 20 L70 20 L120 20 L120 70 L120 120 L70 120 L20 120 L20 70 Z M40 40 L40 60 L40 80 L60 80 L80 80 L80 60 L80 40 L60 40 Z"/>
${CONTROL}`),
  'self-intersection': svg(`  <path data-role="topology" fill="#8d99ae" d="M20 20 L50 50 L80 80 L80 50 L80 20 L50 50 L20 80 L20 50 Z"/>
${CONTROL}`),
  'thin-stroke': svg(`  <path data-role="keep" fill="none" stroke="#000" stroke-width="0.3" d="M20 30 L40 30 L60 30 L80 30 L100 30"/>
  <path data-role="keep" fill="#000" d="M20 60 L60 60 L100 60 L100 60.4 L60 60.4 L20 60.4 Z"/>
${CONTROL}`),
  'tiny-details': svg(`  <path data-role="keep" fill="#000" d="${noisyRect(20, 20, 2, 2, 0.5)} ${noisyRect(30, 20, 1, 1, 0.25)} ${noisyRect(40, 20, 0.6, 0.6, 0.2)}"/>
${CONTROL}`),
  'negative-coords': svg(`  <path data-role="transform" fill="#ef233c" d="${noisyRect(-80, -80, 60, 60)}"/>
${CONTROL.replace('150, 150', '30, 30')}`, 'viewBox="-100 -100 200 200" width="400" height="400"'),
  'overlapping-paths': svg(`  <path data-role="keep" fill="#06d6a0" d="${noisyRect(20, 20, 70, 70)}"/>
  <path data-role="keep" fill="#118ab2" fill-opacity="0.6" d="${noisyRect(50, 50, 70, 70)}"/>
${CONTROL}`),
  'hidden-certain': svg(`  <path data-role="hidden" fill="#ef476f" d="${noisyRect(40, 40, 30, 30)}"/>
  <rect x="20" y="20" width="80" height="80" fill="#073b4c"/>
${CONTROL}`),
  'hidden-under-filter': svg(`  <defs><filter id="off"><feOffset dx="40" dy="0"/></filter></defs>
  <path data-role="keep" fill="#ef476f" d="${noisyRect(40, 40, 30, 30)}"/>
  <rect x="20" y="20" width="80" height="80" fill="#073b4c" filter="url(#off)"/>
${CONTROL}`),
  'hidden-under-pattern': svg(`  <defs><pattern id="stripes" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="4" height="8" fill="#073b4c"/></pattern></defs>
  <path data-role="keep" fill="#ef476f" d="${noisyRect(40, 40, 30, 30)}"/>
  <rect x="20" y="20" width="80" height="80" fill="url(#stripes)"/>
${CONTROL}`),
  'hidden-under-mask': svg(`  <defs><mask id="hole"><rect width="200" height="200" fill="#fff"/><rect x="45" y="45" width="10" height="10" fill="#000"/></mask></defs>
  <path data-role="keep" fill="#ef476f" d="${noisyRect(40, 40, 30, 30)}"/>
  <rect x="20" y="20" width="80" height="80" fill="#073b4c" mask="url(#hole)"/>
${CONTROL}`),
  'partially-hidden': svg(`  <path data-role="keep" fill="#ef476f" d="${noisyRect(20, 20, 81, 40)}"/>
  <rect x="20" y="20" width="80" height="40" fill="#073b4c"/>
${CONTROL}`),
  'hidden-sliver-ring': svg(`  <path data-role="keep" fill="#ffd166" d="${noisyCircle(60, 60, 40, 96)}"/>
  <circle cx="60" cy="60" r="39.6" fill="#073b4c"/>
${CONTROL}`),
};

if (process.argv[1] && process.argv[1].endsWith('make-fixtures.js')) {
  const dir = new URL('./fixtures/', import.meta.url);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(FIXTURES)) { let k = 0; fs.writeFileSync(new URL(name + '.svg', dir), text.replace(/data-role="/g, () => `data-k="${k++}" data-role="`)); }
  console.log(`${Object.keys(FIXTURES).length} fixtures written to test/fixtures/`);
}
