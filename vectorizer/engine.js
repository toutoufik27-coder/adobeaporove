/*
 * Vectorizer engine — converts RGBA pixels into layered SVG paths.
 *
 * Pipeline:
 *   1. Colour quantisation (k-means++ in CIE Lab) or Otsu threshold (B&W mode)
 *   2. Clean-up: remove speckles and thin anti-aliasing halos
 *   3. Stacked layers (largest colour at the bottom) so shapes never leave gaps
 *   4. Sub-pixel contour extraction (Gaussian-smoothed mask + marching squares)
 *   5. Corner detection and corner sharpening
 *   6. Cubic Bézier fitting (Schneider's algorithm) between corners
 *
 * Works in a Web Worker (self.VectorizerEngine) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Colour helpers
  // ---------------------------------------------------------------------------
  const LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function labF(t) {
    return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  }
  function rgbToLab(r, g, b, out, o) {
    const R = LIN[r], G = LIN[g], B = LIN[b];
    const fx = labF((R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047);
    const fy = labF(R * 0.2126729 + G * 0.7151522 + B * 0.072175);
    const fz = labF((R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883);
    out[o] = 116 * fy - 16;
    out[o + 1] = 500 * (fx - fy);
    out[o + 2] = 200 * (fy - fz);
  }
  function toHex(rgb) {
    return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  }

  // Small deterministic PRNG so the same image always gives the same result.
  function mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------------------
  // 1. Quantisation
  // ---------------------------------------------------------------------------
  function kmeans(lab, opaque, k, rand, mergeDist) {
    const SAMPLE = 40000;
    const n = opaque.length;
    const m = Math.min(n, SAMPLE);
    const sample = new Float32Array(m * 3);
    for (let i = 0; i < m; i++) {
      const p = opaque[n <= SAMPLE ? i : Math.floor(rand() * n)] * 3;
      sample[i * 3] = lab[p];
      sample[i * 3 + 1] = lab[p + 1];
      sample[i * 3 + 2] = lab[p + 2];
    }

    // k-means++ initialisation
    const centers = [];
    const first = Math.floor(rand() * m) * 3;
    centers.push([sample[first], sample[first + 1], sample[first + 2]]);
    const dist = new Float32Array(m).fill(Infinity);
    while (centers.length < k) {
      const c = centers[centers.length - 1];
      let sum = 0;
      for (let i = 0; i < m; i++) {
        const dl = sample[i * 3] - c[0], da = sample[i * 3 + 1] - c[1], db = sample[i * 3 + 2] - c[2];
        const d = dl * dl + da * da + db * db;
        if (d < dist[i]) dist[i] = d;
        sum += dist[i];
      }
      if (sum <= 1e-9) break; // fewer distinct colours than k
      let r = rand() * sum, idx = 0;
      for (; idx < m - 1; idx++) {
        r -= dist[idx];
        if (r <= 0) break;
      }
      centers.push([sample[idx * 3], sample[idx * 3 + 1], sample[idx * 3 + 2]]);
    }

    // Lloyd iterations on the sample
    const K = centers.length;
    const acc = new Float64Array(K * 4);
    for (let iter = 0; iter < 16; iter++) {
      acc.fill(0);
      for (let i = 0; i < m; i++) {
        const l = sample[i * 3], a = sample[i * 3 + 1], b = sample[i * 3 + 2];
        let best = 0, bd = Infinity;
        for (let c = 0; c < K; c++) {
          const cc = centers[c];
          const dl = l - cc[0], da = a - cc[1], db = b - cc[2];
          const d = dl * dl + da * da + db * db;
          if (d < bd) { bd = d; best = c; }
        }
        acc[best * 4] += l; acc[best * 4 + 1] += a; acc[best * 4 + 2] += b; acc[best * 4 + 3]++;
      }
      let moved = 0;
      for (let c = 0; c < K; c++) {
        const cnt = acc[c * 4 + 3];
        if (!cnt) continue;
        const nl = acc[c * 4] / cnt, na = acc[c * 4 + 1] / cnt, nb = acc[c * 4 + 2] / cnt;
        moved = Math.max(moved, Math.abs(nl - centers[c][0]) + Math.abs(na - centers[c][1]) + Math.abs(nb - centers[c][2]));
        centers[c] = [nl, na, nb];
      }
      if (moved < 0.05) break;
    }

    // Merge perceptually near-identical centres (weighted), so "max colours" is only
    // a ceiling and one flat colour is never split into several shades.
    const cl = centers.map((c, i) => ({ c, w: acc[i * 4 + 3] || 1 }));
    for (;;) {
      let bi = -1, bj = -1, bd = mergeDist;
      for (let i = 0; i < cl.length; i++) for (let j = i + 1; j < cl.length; j++) {
        const a = cl[i].c, b = cl[j].c;
        const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        if (d < bd) { bd = d; bi = i; bj = j; }
      }
      if (bi < 0) break;
      const A = cl[bi], B = cl[bj], W = A.w + B.w;
      A.c = [0, 1, 2].map((k) => (A.c[k] * A.w + B.c[k] * B.w) / W);
      A.w = W;
      cl.splice(bj, 1);
    }
    return cl.map((x) => x.c);
  }

  // 3x3 box blur of the Lab image (noise-reduced colours for palette + flatness).
  function boxLab(lab, w, h) {
    const out = new Float32Array(lab.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let a = 0, b = 0, c = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = (yy * w + xx) * 3;
          a += lab[q]; b += lab[q + 1]; c += lab[q + 2]; n++;
        }
      }
      const p = (y * w + x) * 3;
      out[p] = a / n; out[p + 1] = b / n; out[p + 2] = c / n;
    }
    return out;
  }

  // A pixel is "flat" when its smoothed colour barely changes around it, i.e. it
  // lies inside a region and not on an anti-aliased edge.
  function flatMask(labB, alphaMask, w, h, thr) {
    const flat = new Uint8Array(w * h);
    const t2 = thr * thr;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (!alphaMask[p]) continue;
      let ok = 1;
      for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) {
        const q = (p + dy * w + dx) * 3, pp = p * 3;
        const dl = labB[pp] - labB[q], da = labB[pp + 1] - labB[q + 1], db = labB[pp + 2] - labB[q + 2];
        if (dl * dl + da * da + db * db > t2 || !alphaMask[p + dy * w + dx]) { ok = 0; break; }
      }
      flat[p] = ok;
    }
    return flat;
  }

  // Confident pixels (flat, or very close to a palette colour) take the nearest
  // colour. Other pixels are anti-aliased edges: they are explained as a mix of
  // two colours that actually occur around them (within 2px) and take whichever
  // of the two dominates, so an edge never turns into an unrelated third colour.
  function assignLabels(lab, alphaMask, flat, w, h, centers) {
    const N = w * h;
    const labels = new Int32Array(N).fill(-1);
    const K = centers.length;
    const C = new Float32Array(K * 3);
    centers.forEach((c, i) => C.set(c, i * 3));
    const pending = [];
    for (let p = 0; p < N; p++) {
      if (!alphaMask[p]) continue;
      const l = lab[p * 3], a = lab[p * 3 + 1], b = lab[p * 3 + 2];
      let best = 0, bd = Infinity;
      for (let c = 0; c < K; c++) {
        const dl = l - C[c * 3], da = a - C[c * 3 + 1], db = b - C[c * 3 + 2];
        const d = dl * dl + da * da + db * db;
        if (d < bd) { bd = d; best = c; }
      }
      labels[p] = best;
      if (flat && !flat[p] && bd >= 36) pending.push(p, best, bd);
    }
    const confident = new Uint8Array(N);
    for (let p = 0; p < N; p++) confident[p] = alphaMask[p] ? 1 : 0;
    for (let i = 0; i < pending.length; i += 3) confident[pending[i]] = 0;
    const out = new Int32Array(labels);
    const cand = new Int32Array(K);
    for (let i = 0; i < pending.length; i += 3) {
      const p = pending[i];
      const x = p % w, y = (p - x) / w;
      let nc = 0;
      for (let dy = -3; dy <= 3; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -3; dx <= 3; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (!confident[q]) continue;
          const L = labels[q];
          let seen = false;
          for (let k = 0; k < nc; k++) if (cand[k] === L) { seen = true; break; }
          if (!seen) cand[nc++] = L;
        }
      }
      if (nc === 0) continue; // keep nearest colour
      const l = lab[p * 3], a = lab[p * 3 + 1], b = lab[p * 3 + 2];
      let res = pending[i + 1], rd = Infinity;
      // best explanation of the pixel by one colour or a mix of two colours
      const tryMix = (ci, cj) => {
        const ex = C[cj * 3] - C[ci * 3], ey = C[cj * 3 + 1] - C[ci * 3 + 1], ez = C[cj * 3 + 2] - C[ci * 3 + 2];
        const ee = ex * ex + ey * ey + ez * ez;
        if (ee < 1e-6) return;
        const qx = l - C[ci * 3], qy = a - C[ci * 3 + 1], qz = b - C[ci * 3 + 2];
        let s = (qx * ex + qy * ey + qz * ez) / ee;
        if (s < 0) s = 0; else if (s > 1) s = 1;
        const rx = qx - s * ex, ry = qy - s * ey, rz = qz - s * ez;
        const r = rx * rx + ry * ry + rz * rz;
        if (r < rd) { rd = r; res = s < 0.5 ? ci : cj; }
      };
      for (let u = 0; u < nc; u++) {
        const ci = cand[u];
        const dl = l - C[ci * 3], da = a - C[ci * 3 + 1], db = b - C[ci * 3 + 2];
        const d = dl * dl + da * da + db * db;
        if (d < rd) { rd = d; res = ci; }
        for (let v = u + 1; v < nc; v++) tryMix(ci, cand[v]);
      }
      // A line only 2-3px wide has no confident pixel of its own colour nearby, so
      // the colours around it cannot explain it (a light arm between two navy
      // outlines is not navy). Then its own nearest colour, alone or mixed with a
      // neighbour, is allowed too.
      if (rd > 22 * 22) {
        const c0 = pending[i + 1];
        if (pending[i + 2] < rd) { rd = pending[i + 2]; res = c0; }
        for (let u = 0; u < nc; u++) if (cand[u] !== c0) tryMix(cand[u], c0);
      }
      out[p] = res;
    }
    return out;
  }

  function otsu(lab, alphaMask, N) {
    const hist = new Float64Array(101);
    let total = 0;
    for (let p = 0; p < N; p++) {
      if (!alphaMask[p]) continue;
      hist[Math.max(0, Math.min(100, Math.round(lab[p * 3])))]++;
      total++;
    }
    let sum = 0;
    for (let i = 0; i <= 100; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 50;
    for (let t = 0; t <= 100; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t; }
    }
    return thr + 0.5;
  }

  // ---------------------------------------------------------------------------
  // 2. Clean-up of speckles and anti-aliasing halos
  // ---------------------------------------------------------------------------
  // Does region L separate two colours A and B (each along >= 25% of its edge) while
  // its own colour lies between them?
  function isBandBetween(L, labs, C) {
    let total = 0;
    for (const n of labs.values()) total += n;
    const big = [...labs].filter(([, n]) => n >= total * 0.25).map(([k]) => k);
    for (let i = 0; i < big.length; i++) for (let j = i + 1; j < big.length; j++) {
      // clearly different colours only: between close colours it is shading
      if (labDist2(C, big[i], big[j]) < 30 * 30) continue;
      const pair = isBlend(L, new Map([[big[i], 1], [big[j], 1]]), C);
      if (pair) return pair;
    }
    return null;
  }
  // Is colour L (almost) a mix of two of its neighbouring colours? Images blend in
  // sRGB, which bows away from the straight Lab line (up to ~11 between cobalt and
  // white), so the tolerance grows with the distance between the two colours.
  function isBlend(L, nbs, C) {
    const l = C[L * 3], a = C[L * 3 + 1], b = C[L * 3 + 2];
    const list = [...nbs.keys()];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const I = list[i] * 3, J = list[j] * 3;
      const ex = C[J] - C[I], ey = C[J + 1] - C[I + 1], ez = C[J + 2] - C[I + 2];
      const ee = ex * ex + ey * ey + ez * ez;
      if (ee < 1) continue;
      const qx = l - C[I], qy = a - C[I + 1], qz = b - C[I + 2];
      const t = (qx * ex + qy * ey + qz * ez) / ee;
      if (t < 0.1 || t > 0.9) continue;           // strictly between the two
      const tol = Math.max(8, 0.12 * Math.sqrt(ee));
      if ((qx - t * ex) ** 2 + (qy - t * ey) ** 2 + (qz - t * ez) ** 2 < tol * tol) return [list[i], list[j]];
    }
    return null;
  }

  // 4-connected regions of equal label: region id per pixel, label and area per region.
  function regions(labels, w, h) {
    const N = w * h, comp = new Int32Array(N).fill(-1), stack = new Int32Array(N);
    const label = [], area = [];
    for (let s = 0; s < N; s++) {
      if (comp[s] !== -1 || labels[s] < 0) continue;
      const L = labels[s], id = label.length;
      let sp = 0, n = 0;
      stack[sp++] = s; comp[s] = id;
      while (sp) {
        const p = stack[--sp], x = p % w;
        n++;
        if (x > 0 && labels[p - 1] === L && comp[p - 1] === -1) { comp[p - 1] = id; stack[sp++] = p - 1; }
        if (x < w - 1 && labels[p + 1] === L && comp[p + 1] === -1) { comp[p + 1] = id; stack[sp++] = p + 1; }
        if (p >= w && labels[p - w] === L && comp[p - w] === -1) { comp[p - w] = id; stack[sp++] = p - w; }
        if (p + w < N && labels[p + w] === L && comp[p + w] === -1) { comp[p + w] = id; stack[sp++] = p + w; }
      }
      label.push(L); area.push(n);
    }
    return { comp, label, area };
  }
  // Per region: pixels touching another label (`boundary`) and, for regions smaller
  // than `maxArea`, the shared edge with each neighbouring region.
  function regionEdges(labels, R, w, h, maxArea) {
    const N = w * h, n = R.label.length;
    const boundary = new Int32Array(n), nb = new Array(n).fill(null);
    for (let p = 0; p < N; p++) {
      const c = R.comp[p];
      if (c < 0) continue;
      const x = p % w, L = labels[p], track = R.area[c] < maxArea;
      let edge = false;
      const see = (q) => {
        if (labels[q] === L) return;
        edge = true;
        const d = R.comp[q];
        if (track && d >= 0) { const m = nb[c] || (nb[c] = new Map()); m.set(d, (m.get(d) || 0) + 1); }
      };
      if (x > 0) see(p - 1);
      if (x < w - 1) see(p + 1);
      if (p >= w) see(p - w);
      if (p + w < N) see(p + w);
      if (edge) boundary[c]++;
    }
    return { boundary, nb };
  }
  const labDist2 = (C, A, B) => (C[A * 3] - C[B * 3]) ** 2 + (C[A * 3 + 1] - C[B * 3 + 1]) ** 2 + (C[A * 3 + 2] - C[B * 3 + 2]) ** 2;

  // Shading: two neighbouring regions of close colours whose border is gradual (the
  // colour changes a little per pixel, as in a gradient) are one surface, not two
  // shapes. A real edge changes abruptly between two adjacent pixels. Merging them
  // removes the blotchy border a soft gradient otherwise leaves (smaller region
  // takes the colour of the larger one).
  function mergeSoftBorders(labels, lab, w, h, labColors, minArea) {
    const R = regions(labels, w, h), n = R.label.length;
    const smallArea = Math.max(100, (minArea || 10) * 6);
    const pairs = new Map();
    const add = (p, q) => {
      const a = R.comp[p], b = R.comp[q];
      if (a < 0 || b < 0 || labels[p] === labels[q]) return;
      const key = a < b ? a * n + b : b * n + a;
      const step = Math.sqrt((lab[p * 3] - lab[q * 3]) ** 2 + (lab[p * 3 + 1] - lab[q * 3 + 1]) ** 2 + (lab[p * 3 + 2] - lab[q * 3 + 2]) ** 2);
      const e = pairs.get(key);
      if (e) { e[0]++; e[1] += step; } else pairs.set(key, [1, step]);
    };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (x < w - 1) add(p, p + 1);
      if (y < h - 1) add(p, p + w);
    }
    const list = [];
    for (const [key, [count, sum]] of pairs) {
      if (count < 8) continue;
      const a = Math.floor(key / n), b = key % n;
      const d = Math.sqrt(labDist2(labColors, R.label[a], R.label[b]));
      // small pieces (a streak of shading) may be a little less gradual; real small
      // details have hard edges (ratio 0.45 and above)
      const small = Math.min(R.area[a], R.area[b]) < smallArea;
      if (d < 30 && sum / count < (small ? 0.4 : 0.25) * d) list.push([count, a, b]);
    }
    if (!list.length) return labels;
    list.sort((u, v) => v[0] - u[0]);
    const parent = Int32Array.from({ length: n }, (_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (const [, a, b] of list) {
      const ra = find(a), rb = find(b);
      if (ra === rb) continue;
      if (R.area[ra] >= R.area[rb]) { parent[rb] = ra; R.area[ra] += R.area[rb]; } else { parent[ra] = rb; R.area[rb] += R.area[ra]; }
    }
    const out = new Int32Array(labels);
    for (let p = 0; p < w * h; p++) if (R.comp[p] >= 0) out[p] = R.label[find(R.comp[p])];
    return out;
  }

  function cleanLabels(labels, w, h, labColors, minArea, cleanEdges, lab) {
    const N = w * h;
    let R, E, out = labels;
    // Two rounds: a sliver next to another halo is judged again once that halo is gone
    // and it touches the real colours on both sides.
    for (let round = 0; round < (cleanEdges ? 2 : 1); round++) {
    R = regions(out, w, h);
    E = regionEdges(out, R, w, h, cleanEdges ? N * 0.25 : 0);
    const flagged = new Uint8Array(N);
    let anyFlag = false;
    // Small neighbouring pieces of similar colours (a small spot split by JPEG noise
    // between two shades) are judged together: one spot, drawn in its main colour.
    const grp = Int32Array.from({ length: R.label.length }, (_, i) => i);
    const findG = (i) => { while (grp[i] !== i) { grp[i] = grp[grp[i]]; i = grp[i]; } return i; };
    if (cleanEdges) {
      for (let c = 0; c < R.label.length; c++) {
        if (R.area[c] >= minArea || !E.nb[c]) continue;
        for (const d of E.nb[c].keys()) {
          if (R.area[d] >= minArea || labDist2(labColors, R.label[c], R.label[d]) >= 30 * 30) continue;
          const a = findG(c), b = findG(d);
          if (a !== b) grp[a] = b;
        }
      }
    }
    const gArea = new Float64Array(R.label.length), gMain = new Int32Array(R.label.length).fill(-1);
    for (let c = 0; c < R.label.length; c++) {
      const g = findG(c);
      gArea[g] += R.area[c];
      if (gMain[g] < 0 || R.area[c] > R.area[gMain[g]]) gMain[g] = c;
    }
    const regroup = [];
    for (let c = 0; c < R.label.length; c++) {
      const g = findG(c);
      if (gMain[g] !== c && gArea[g] >= Math.max(8, minArea * 0.3)) regroup.push(c);
    }
    if (regroup.length) {
      const relabel = new Int32Array(R.label.length).fill(-1);
      for (const c of regroup) relabel[c] = R.label[gMain[findG(c)]];
      out = Int32Array.from(out);
      for (let p = 0; p < N; p++) { const c = R.comp[p]; if (c >= 0 && relabel[c] >= 0) out[p] = relabel[c]; }
      R = regions(out, w, h);
      E = regionEdges(out, R, w, h, cleanEdges ? N * 0.25 : 0);
    }
    const flagRegion = new Uint8Array(R.label.length);
    const bandPair = new Array(R.label.length).fill(null);   // halo band: the two colours it blends
    const islandCand = new Uint8Array(R.label.length);
    // Pieces of one colour that touch diagonally are one shape (a diagonal stroke,
    // the arms of a "K"): their size is judged together.
    const dg = Int32Array.from({ length: R.label.length }, (_, i) => i);
    const findD = (i) => { while (dg[i] !== i) { dg[i] = dg[dg[i]]; i = dg[i]; } return i; };
    for (let y = 0; y < h - 1; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x, a = R.comp[p];
      if (a < 0) continue;
      for (const q of [x > 0 ? p + w - 1 : -1, x < w - 1 ? p + w + 1 : -1]) {
        if (q < 0) continue;
        const b = R.comp[q];
        if (b < 0 || b === a || out[q] !== out[p]) continue;
        const ra = findD(a), rb = findD(b);
        if (ra !== rb) dg[ra] = rb;
      }
    }
    const dArea = new Float64Array(R.label.length);
    for (let c = 0; c < R.label.length; c++) dArea[findD(c)] += R.area[c];
    for (let c = 0; c < R.label.length; c++) {
      const area = R.area[c], L = R.label[c];
      // Speckle: tiny region. A small compact spot of a clearly different colour
      // from everything around it (the light centre of a tiny ring) is a detail.
      let bad = dArea[findD(c)] < minArea;
      if (bad && cleanEdges && area >= Math.max(8, minArea * 0.3) && E.nb[c] && E.boundary[c] / area < 0.9) {
        let near = Infinity;
        for (const d of E.nb[c].keys()) near = Math.min(near, labDist2(labColors, L, R.label[d]));
        if (near >= 30 * 30) bad = false;
      }
      // Halo: a band of up to ~3px whose colour is a blend of the two colours it
      // separates (anti-aliasing, soft edge shading). A thin line of its own colour
      // (the light arm of a buckle between two navy outlines, a thin ring) is a real
      // detail; a near-identical shade joins its look-alike neighbour below instead
      // of being handed to whatever is next to it.
      if (!bad && cleanEdges && area > 2 && area < N * 0.25 && E.nb[c]) {
        const ratio = E.boundary[c] / area;
        const labs = new Map();
        for (const [d, k] of E.nb[c]) labs.set(R.label[d], (labs.get(R.label[d]) || 0) + k);
        const pair = (ratio > 0.6 && isBlend(L, labs, labColors)) ||
          // a wider soft edge (upscaled or blurry image, up to ~4.5px): a band that lies
          // between two colours, touching both along its length, in a colour between them
          (ratio > 0.42 && isBandBetween(L, labs, labColors));
        if (pair) { bad = true; bandPair[c] = true; }
        islandCand[c] = area < minArea * 4 && labs.size === 1 ? 1 : 0;
      }
      if (bad) { flagRegion[c] = 1; anyFlag = true; }
    }
    // Noise islands: a small speck wholly inside one region of a close colour, or a
    // stray bit of edge blend (a mix of its surroundings and some other colour).
    // Judged only against a neighbour that stays: a dot of real colour inside a
    // ring of edge blend is a real dot (the ring is removed, the dot kept).
    for (let c = 0; c < R.label.length; c++) {
      if (!islandCand[c] || flagRegion[c]) continue;
      const nbr = [...E.nb[c].keys()];
      if (nbr.some((d) => flagRegion[d])) continue;
      const L = R.label[c], M = R.label[nbr[0]], area = R.area[c];
      let bad = labDist2(labColors, L, M) < 25 * 25;
      // (only a few pixels: a real dot of another colour is kept)
      if (!bad && area < Math.max(12, minArea * 0.6)) {
        const pair = new Map([[M, 1]]);
        for (let X = 0; X < labColors.length / 3 && !bad; X++) {
          if (X === L || X === M) continue;
          pair.set(X, 1);
          bad = !!isBlend(L, pair, labColors);
          pair.delete(X);
        }
      }
      if (bad) { flagRegion[c] = 1; anyFlag = true; }
    }
    if (!anyFlag) break;
    // the two colours of a band are those of neighbouring regions that stay (not
    // other halos being removed in the same pass)
    for (let c = 0; c < R.label.length; c++) {
      if (!bandPair[c]) continue;
      const labs = new Map();
      for (const [d, k] of E.nb[c]) if (!flagRegion[d]) labs.set(R.label[d], (labs.get(R.label[d]) || 0) + k);
      const pr = isBlend(R.label[c], labs, labColors);
      // only a real edge between clearly different colours is split in its middle; a
      // soft shade between close colours (shading inside a surface) joins the nearer one
      bandPair[c] = pr && labDist2(labColors, pr[0], pr[1]) >= 30 * 30 ? pr : null;
    }
    const next = new Int32Array(out);
    for (let p = 0; p < N; p++) {
      const c = R.comp[p];
      if (c < 0 || !flagRegion[c]) continue;
      const pr = bandPair[c];
      if (pr && lab) {
        // a blend band splits where its own colour crosses the middle between the two
        // colours, so the edge stays in the middle of the soft edge and shapes keep
        // their size (giving the whole band to one side makes them grow)
        const A = pr[0] * 3, B = pr[1] * 3;
        const ex = labColors[B] - labColors[A], ey = labColors[B + 1] - labColors[A + 1], ez = labColors[B + 2] - labColors[A + 2];
        const t = ((lab[p * 3] - labColors[A]) * ex + (lab[p * 3 + 1] - labColors[A + 1]) * ey + (lab[p * 3 + 2] - labColors[A + 2]) * ez) / (ex * ex + ey * ey + ez * ez || 1);
        next[p] = t < 0.5 ? pr[0] : pr[1];
      } else flagged[p] = 1;
    }
    out = reassignFlagged(next, flagged, w, h, labColors);
    }
    if (!cleanEdges) return out;

    // Tints: a small thin sliver that is only a lighter / darker shade of the larger
    // region it lies along (the lighter middle row of a thin light arm) joins that
    // region. Smaller always joins larger, and a few rounds let pieces that became
    // connected be judged again.
    for (let round = 0; round < 3; round++) {
      R = regions(out, w, h);
      E = regionEdges(out, R, w, h, N * 0.002);
      const n = R.label.length, into = new Int32Array(n).fill(-1);
      let merges = 0;
      for (let c = 0; c < n; c++) {
        const area = R.area[c];
        if (area <= 2 || area >= N * 0.002 || !E.nb[c] || E.boundary[c] / area <= 0.6) continue;
        // the neighbour it shares most of its edge with, if the colours are close;
        // else any neighbour along a good part of its edge whose colour is nearly the
        // same (a near-white top row of a pale band, next to a navy outline)
        let d = -1, most = 0, total = 0;
        for (const [k, cnt] of E.nb[c]) { total += cnt; if (cnt > most) { most = cnt; d = k; } }
        if (d >= 0 && (R.area[d] <= area || labDist2(labColors, R.label[c], R.label[d]) >= 15 * 15)) d = -1;
        if (d < 0) {
          let bd = 12 * 12;
          const hair = E.boundary[c] / area > 0.9;   // 1-2px: any contact will do
          for (const [k, cnt] of E.nb[c]) {
            if ((!hair && cnt < total * 0.3) || R.area[k] <= area) continue;
            const e = labDist2(labColors, R.label[c], R.label[k]);
            if (e < bd) { bd = e; d = k; }
          }
        }
        if (d < 0) continue;
        into[c] = d; merges++;
      }
      if (!merges) break;
      const target = new Int32Array(n);
      for (let c = 0; c < n; c++) {   // follow joins to the final region (areas grow, so no cycles)
        let t = c;
        for (let k = 0; k < 8 && into[t] >= 0; k++) t = into[t];
        target[c] = R.label[t];
      }
      const next = new Int32Array(out);
      for (let p = 0; p < N; p++) if (R.comp[p] >= 0) next[p] = target[R.comp[p]];
      out = next;
    }
    // final sweep: specks left over by the passes above join the neighbour they
    // share most of their edge with
    R = regions(out, w, h);
    E = regionEdges(out, R, w, h, minArea);
    const into = new Int32Array(R.label.length).fill(-1);
    let specks = 0;
    for (let c = 0; c < R.label.length; c++) {
      if (R.area[c] >= minArea || !E.nb[c]) continue;
      let d = -1, most = 0;
      for (const [k, cnt] of E.nb[c]) if (cnt > most && R.area[k] >= minArea) { most = cnt; d = k; }
      if (d >= 0) { into[c] = R.label[d]; specks++; }
    }
    if (specks) {
      out = new Int32Array(out);
      for (let p = 0; p < N; p++) { const c = R.comp[p]; if (c >= 0 && into[c] >= 0) out[p] = into[c]; }
    }
    return out;
  }

  // Reassign flagged pixels to the colour-nearest unflagged neighbour, growing inwards.
  function reassignFlagged(labels, flagged, w, h, labColors) {
    const N = w * h;
    const out = new Int32Array(labels);
    for (let pass = 0; pass < 64; pass++) {
      let changed = 0, remaining = 0;
      const updates = [];
      for (let p = 0; p < N; p++) {
        if (!flagged[p]) continue;
        const x = p % w, y = (p - x) / w;
        const own = labels[p];
        let best = -2, bd = Infinity;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if ((!dx && !dy) || xx < 0 || xx >= w) continue;
            const q = yy * w + xx;
            if (flagged[q]) continue;
            const L = out[q];
            if (L < 0) { if (best === -2) best = -1; continue; }
            const d = labDist2(labColors, own, L);
            if (d < bd) { bd = d; best = L; }
          }
        }
        if (best !== -2) updates.push(p, best);
        else remaining++;
      }
      for (let i = 0; i < updates.length; i += 2) {
        out[updates[i]] = updates[i + 1];
        flagged[updates[i]] = 0;
        changed++;
      }
      if (!remaining || !changed) break;
    }
    return out;
  }


  // ---------------------------------------------------------------------------
  // Soft coverage: recover sub-pixel edge positions from anti-aliased pixels.
  // Each pixel is modelled as a mix of its own label and (at most) one neighbour
  // label; `frac` is the share of its own label.
  // ---------------------------------------------------------------------------
  function softCoverage(labels, lab, rgba, w, h, labMeans) {
    const N = w * h;
    const alt = new Int32Array(N).fill(-2);
    const frac = new Float32Array(N).fill(1);
    // Search radius: the direct neighbours, and up to 3 px for pixels whose colour is
    // clearly not their own label's (the inside of a wide, blurred edge): the edge is
    // then placed where the colour crosses the middle of the two colours, not where
    // the labels happen to switch (blurry images made shapes grow by the blur width).
    const cand = new Int32Array(64);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        const L = labels[p];
        const alpha = rgba[p * 4 + 3];
        let own2 = 0;
        if (L >= 0) {
          const dl = lab[p * 3] - labMeans[L * 3], da = lab[p * 3 + 1] - labMeans[L * 3 + 1], db = lab[p * 3 + 2] - labMeans[L * 3 + 2];
          own2 = dl * dl + da * da + db * db;
        }
        const R = L >= 0 && own2 > 6 * 6 ? 3 : 1;
        let nc = 0, touchesClear = false;
        for (let dy = -R; dy <= R; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -R; dx <= R; dx++) {
            const xx = x + dx;
            if ((!dx && !dy) || xx < 0 || xx >= w) continue;
            const A = labels[yy * w + xx];
            if (A === L) continue;
            if (A < 0) { if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) touchesClear = true; continue; }
            let seen = false;
            for (let k = 0; k < nc; k++) if (cand[k] === A) { seen = true; break; }
            if (!seen && nc < 64) cand[nc++] = A;
          }
        }
        let bestA = -2, bestS = 0, bestR = Infinity;
        for (let k = 0; k < nc; k++) {
          const A = cand[k];
          if (L < 0) { if (bestA === -2) bestA = A; continue; }
          // project the pixel colour on the segment between the two label colours
          const ex = labMeans[A * 3] - labMeans[L * 3];
          const ey = labMeans[A * 3 + 1] - labMeans[L * 3 + 1];
          const ez = labMeans[A * 3 + 2] - labMeans[L * 3 + 2];
          const qx = lab[p * 3] - labMeans[L * 3];
          const qy = lab[p * 3 + 1] - labMeans[L * 3 + 1];
          const qz = lab[p * 3 + 2] - labMeans[L * 3 + 2];
          const ee = ex * ex + ey * ey + ez * ez;
          // two near-identical colours: noise alone would decide the "mix" and
          // could hand a background pixel to a stray twin label (a dot)
          if (ee < 8 * 8) continue;
          let s = (qx * ex + qy * ey + qz * ez) / ee;
          s = s < 0 ? 0 : s > 1 ? 1 : s;
          const rx = qx - s * ex, ry = qy - s * ey, rz = qz - s * ez;
          const res = Math.sqrt(rx * rx + ry * ry + rz * rz);
          if (res > Math.max(8, 0.35 * Math.sqrt(ee))) continue;
          if (res < bestR) { bestR = res; bestA = A; bestS = s; }
        }
        if (L < 0) {
          // translucent edge pixel next to an opaque region
          if (bestA >= 0 && alpha > 0) { alt[p] = bestA; frac[p] = 1 - alpha / 255; }
        } else if (bestA >= 0) {
          alt[p] = bestA; frac[p] = 1 - bestS;
        } else if (touchesClear && alpha < 250) {
          frac[p] = alpha / 255;
        }
      }
    }
    return { alt, frac };
  }


  // ---------------------------------------------------------------------------
  // 3/4. Mask smoothing + marching squares
  // ---------------------------------------------------------------------------
  function gaussianKernel(sigma) {
    const r = Math.max(1, Math.ceil(sigma * 2.5));
    const k = new Float32Array(2 * r + 1);
    let s = 0;
    for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
    for (let i = 0; i < k.length; i++) k[i] /= s;
    return { k, r };
  }

  function blur(src, w, h, kern) {
    const { k, r } = kern;
    const tmp = new Float32Array(w * h);
    const dst = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let i = -r; i <= r; i++) {
          const xx = x + i < 0 ? 0 : x + i >= w ? w - 1 : x + i;
          s += src[row + xx] * k[i + r];
        }
        tmp[row + x] = s;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let i = -r; i <= r; i++) {
          const yy = y + i < 0 ? 0 : y + i >= h ? h - 1 : y + i;
          s += tmp[yy * w + x] * k[i + r];
        }
        dst[y * w + x] = s;
      }
    }
    return dst;
  }

  // Returns closed loops (arrays of [x, y]) of the 0.5 iso-line of `grid`.
  // `grid` is padded with a zero border so that every loop closes.
  // Three box blurs of radius r (close to a Gaussian of sigma ~ r), O(1) per pixel.
  function boxBlur3(src, w, h, r) {
    let a = Float32Array.from(src), b = new Float32Array(src.length);
    const pass = (from, to, horiz) => {
      const n = horiz ? w : h, m = horiz ? h : w;
      for (let j = 0; j < m; j++) {
        const at = (i) => (horiz ? j * w + i : i * w + j);
        let sum = 0;
        for (let i = -r; i <= r; i++) sum += from[at(Math.min(n - 1, Math.max(0, i)))];
        for (let i = 0; i < n; i++) {
          to[at(i)] = sum / (2 * r + 1);
          sum += from[at(Math.min(n - 1, i + r + 1))] - from[at(Math.max(0, i - r))];
        }
      }
    };
    for (let k = 0; k < 3; k++) { pass(a, b, true); pass(b, a, false); }
    return a;
  }

  // 3-4 chamfer distance transform in place (0 = source, large = far)
  function chamfer(d, w, h) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 3);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 3);
        if (x > 0) v = Math.min(v, d[i - w - 1] + 4);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + 4);
      }
      d[i] = v;
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + 3);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 3);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + 4);
        if (x > 0) v = Math.min(v, d[i + w - 1] + 4);
      }
      d[i] = v;
    }
  }

  function marchingSquares(grid, PW, PH, ox, oy) {
    const next = new Int32Array(PW * PH * 2).fill(-1);
    const starts = [];
    const ins = [0, 0, 0, 0];
    const vals = [0, 0, 0, 0];
    const edges = [0, 0, 0, 0];
    const cr = [0, 0, 0, 0], crEntry = [false, false, false, false];

    for (let j = 0; j < PH - 1; j++) {
      for (let i = 0; i < PW - 1; i++) {
        const a = grid[j * PW + i], b = grid[j * PW + i + 1];
        const c = grid[(j + 1) * PW + i + 1], d = grid[(j + 1) * PW + i];
        const ia = a >= 0.5, ib = b >= 0.5, ic = c >= 0.5, id = d >= 0.5;
        if (ia === ib && ib === ic && ic === id) continue;
        // corners clockwise (screen coords): tl, tr, br, bl
        vals[0] = a; vals[1] = b; vals[2] = c; vals[3] = d;
        ins[0] = ia; ins[1] = ib; ins[2] = ic; ins[3] = id;
        edges[0] = (j * PW + i) * 2;           // top
        edges[1] = (j * PW + i + 1) * 2 + 1;   // right
        edges[2] = ((j + 1) * PW + i) * 2;     // bottom
        edges[3] = (j * PW + i) * 2 + 1;       // left
        let nc = 0;
        for (let q = 0; q < 4; q++) {
          const q1 = (q + 1) & 3;
          if (ins[q] !== ins[q1]) { cr[nc] = edges[q]; crEntry[nc] = !ins[q]; nc++; }
        }
        if (nc === 2) {
          if (crEntry[0]) { next[cr[0]] = cr[1]; starts.push(cr[0]); }
          else { next[cr[1]] = cr[0]; starts.push(cr[1]); }
        } else {
          // saddle: rotate so that the list starts with an entry
          const off = crEntry[0] ? 0 : 1;
          const en0 = cr[off], ex0 = cr[(off + 1) & 3], en1 = cr[(off + 2) & 3], ex1 = cr[(off + 3) & 3];
          if ((a + b + c + d) / 4 >= 0.5) { next[en0] = ex1; next[en1] = ex0; }
          else { next[en0] = ex0; next[en1] = ex1; }
          starts.push(en0, en1);
        }
      }
    }

    function edgePoint(e) {
      const cell = e >> 1;
      const i = cell % PW, j = (cell - i) / PW;
      let x, y;
      if ((e & 1) === 0) { // horizontal edge (i,j)-(i+1,j)
        const va = grid[cell], vb = grid[cell + 1];
        x = i + (0.5 - va) / (vb - va); y = j;
      } else {             // vertical edge (i,j)-(i,j+1)
        const va = grid[cell], vb = grid[cell + PW];
        x = i; y = j + (0.5 - va) / (vb - va);
      }
      return [ox + x - 0.5, oy + y - 0.5];
    }

    const loops = [];
    for (const s of starts) {
      if (next[s] === -1) continue;
      const pts = [];
      let e = s;
      while (e !== -1 && next[e] !== -1) {
        pts.push(edgePoint(e));
        const n = next[e];
        next[e] = -1;
        e = n;
      }
      if (pts.length >= 3) loops.push(pts);
    }
    return loops;
  }

  // ---------------------------------------------------------------------------
  // 5/6. Corner detection + Bézier fitting
  // ---------------------------------------------------------------------------
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
  const mul = (a, s) => [a[0] * s, a[1] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  const len = (a) => Math.hypot(a[0], a[1]);
  const norm = (a) => { const l = len(a); return l > 1e-12 ? [a[0] / l, a[1] / l] : [0, 0]; };

  function polygonArea(pts) {
    let s = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      s += p[0] * q[1] - q[0] * p[1];
    }
    return s / 2;
  }

  // Arc-length helper for a closed polyline.
  function makeArc(pts) {
    const n = pts.length;
    const cum = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + len(sub(pts[(i + 1) % n], pts[i]));
    const total = cum[n];
    function at(s) {
      s = ((s % total) + total) % total;
      let lo = 0, hi = n;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
      const segLen = cum[lo + 1] - cum[lo];
      const t = segLen > 0 ? (s - cum[lo]) / segLen : 0;
      const p = pts[lo], q = pts[(lo + 1) % n];
      return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    }
    return { cum, total, at };
  }

  function lineIntersect(p, d, q, e) {
    const den = d[0] * e[1] - d[1] * e[0];
    if (Math.abs(den) < 1e-9) return null;
    const t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den;
    return [p[0] + d[0] * t, p[1] + d[1] * t];
  }

  function detectCorners(pts, arc, r, threshold) {
    const n = pts.length;
    const { cum, total, at } = arc;
    if (total < r * 4) return [];
    const ang = new Float64Array(n);
    const cosT = Math.cos(threshold);
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const u = norm(sub(p, at(cum[i] - r)));
      const v = norm(sub(at(cum[i] + r), p));
      ang[i] = dot(u, v) < cosT ? Math.acos(Math.max(-1, Math.min(1, dot(u, v)))) : 0;
    }
    const corners = [];
    for (let i = 0; i < n; i++) {
      if (!ang[i]) continue;
      let isMax = true;
      // non-maximum suppression within ±r arc length
      for (let dir = -1; dir <= 1 && isMax; dir += 2) {
        for (let k = 1; k < n; k++) {
          const j = (i + dir * k + n) % n;
          const d = dir > 0 ? (cum[j] - cum[i] + total) % total : (cum[i] - cum[j] + total) % total;
          if (d > r) break;
          if (ang[j] > ang[i] || (ang[j] === ang[i] && j < i)) { isMax = false; break; }
        }
      }
      if (isMax) corners.push(i);
    }
    return corners;
  }

  // Schneider, "An Algorithm for Automatically Fitting Digitized Curves", Graphics Gems 1990.
  function bezierPt(b, t) {
    const mt = 1 - t;
    const a = mt * mt * mt, c = 3 * mt * mt * t, d = 3 * mt * t * t, e = t * t * t;
    return [a * b[0][0] + c * b[1][0] + d * b[2][0] + e * b[3][0], a * b[0][1] + c * b[1][1] + d * b[2][1] + e * b[3][1]];
  }
  function bezierD1(b, t) {
    const mt = 1 - t;
    const a = 3 * mt * mt, c = 6 * mt * t, d = 3 * t * t;
    return [a * (b[1][0] - b[0][0]) + c * (b[2][0] - b[1][0]) + d * (b[3][0] - b[2][0]),
      a * (b[1][1] - b[0][1]) + c * (b[2][1] - b[1][1]) + d * (b[3][1] - b[2][1])];
  }
  function bezierD2(b, t) {
    const mt = 1 - t;
    return [6 * mt * (b[2][0] - 2 * b[1][0] + b[0][0]) + 6 * t * (b[3][0] - 2 * b[2][0] + b[1][0]),
      6 * mt * (b[2][1] - 2 * b[1][1] + b[0][1]) + 6 * t * (b[3][1] - 2 * b[2][1] + b[1][1])];
  }

  function chordParams(P) {
    const u = [0];
    for (let i = 1; i < P.length; i++) u.push(u[i - 1] + len(sub(P[i], P[i - 1])));
    const L = u[u.length - 1] || 1;
    return u.map((v) => v / L);
  }

  function generateBezier(P, u, t1, t2) {
    const p0 = P[0], p3 = P[P.length - 1];
    let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
    for (let i = 0; i < P.length; i++) {
      const t = u[i], mt = 1 - t;
      const b0 = mt * mt * mt, b1 = 3 * mt * mt * t, b2 = 3 * mt * t * t, b3 = t * t * t;
      const a1 = mul(t1, b1), a2 = mul(t2, b2);
      c00 += dot(a1, a1); c01 += dot(a1, a2); c11 += dot(a2, a2);
      const tmp = sub(P[i], add(mul(p0, b0 + b1), mul(p3, b2 + b3)));
      x0 += dot(a1, tmp); x1 += dot(a2, tmp);
    }
    const det = c00 * c11 - c01 * c01;
    let al = 0, ar = 0;
    if (Math.abs(det) > 1e-12) { al = (x0 * c11 - x1 * c01) / det; ar = (c00 * x1 - c01 * x0) / det; }
    const segLen = len(sub(p3, p0));
    const eps = 1e-6 * segLen;
    if (al < eps || ar < eps || al > segLen * 2 || ar > segLen * 2) { al = ar = segLen / 3; }
    return [p0, add(p0, mul(t1, al)), add(p3, mul(t2, ar)), p3];
  }

  function maxError(P, b, u) {
    let maxD = 0, split = P.length >> 1;
    for (let i = 1; i < P.length - 1; i++) {
      const d = sub(bezierPt(b, u[i]), P[i]);
      const dd = dot(d, d);
      if (dd >= maxD) { maxD = dd; split = i; }
    }
    return { maxD, split };
  }

  function reparameterize(P, b, u) {
    return u.map((t, i) => {
      const d = sub(bezierPt(b, t), P[i]);
      const d1 = bezierD1(b, t), d2 = bezierD2(b, t);
      const num = dot(d, d1), den = dot(d1, d1) + dot(d, d2);
      if (Math.abs(den) < 1e-12) return t;
      const nt = t - num / den;
      return nt < 0 ? 0 : nt > 1 ? 1 : nt;
    });
  }

  // Total turning (radians) along a polyline and the index where half is reached.
  function turning(P) {
    let total = 0;
    const acc = [0];
    for (let i = 1; i < P.length - 1; i++) {
      const a = sub(P[i], P[i - 1]), b = sub(P[i + 1], P[i]);
      const la = len(a), lb = len(b);
      if (la < 1e-9 || lb < 1e-9) { acc.push(total); continue; }
      total += Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]));
      acc.push(total);
    }
    let half = 1;
    while (half < acc.length - 1 && acc[half] < total / 2) half++;
    return { total, half };
  }

  function fitCubic(P, t1, t2, err2, out, depth) {
    // A single cubic cannot hold a wide arc faithfully: split curves that turn
    // more than ~100° (designers draw a circle with four nodes, not two).
    if (P.length >= 8 && depth < 24) {
      const { total, half } = turning(P);
      if (total > 1.75 && half > 1 && half < P.length - 2) {
        const lo = Math.max(0, half - 2), hi = Math.min(P.length - 1, half + 2);
        const tc = norm(sub(P[lo], P[hi]));
        if (tc[0] || tc[1]) {
          fitCubic(P.slice(0, half + 1), t1, tc, err2, out, depth + 1);
          fitCubic(P.slice(half), mul(tc, -1), t2, err2, out, depth + 1);
          return;
        }
      }
    }
    if (P.length === 2) {
      const d = len(sub(P[1], P[0])) / 3;
      out.push([P[0], add(P[0], mul(t1, d)), add(P[1], mul(t2, d)), P[1]]);
      return;
    }
    let u = chordParams(P);
    let b = generateBezier(P, u, t1, t2);
    let { maxD, split } = maxError(P, b, u);
    if (maxD < err2) { out.push(b); return; }
    if (maxD < err2 * 16) {
      for (let it = 0; it < 6; it++) {
        u = reparameterize(P, b, u);
        b = generateBezier(P, u, t1, t2);
        ({ maxD, split } = maxError(P, b, u));
        if (maxD < err2) { out.push(b); return; }
      }
    }
    if (depth > 24) { out.push(b); return; }
    const lo = Math.max(0, split - 2), hi = Math.min(P.length - 1, split + 2);
    let tc = norm(sub(P[lo], P[hi]));
    if (!tc[0] && !tc[1]) tc = norm(sub(P[split - 1], P[split + 1]));
    fitCubic(P.slice(0, split + 1), t1, tc, err2, out, depth + 1);
    fitCubic(P.slice(split), mul(tc, -1), t2, err2, out, depth + 1);
  }

  // Long lines may deviate a little more: JPEG noise wobbles an edge by up to ~1px,
  // while a real curve over the same length bends much further from its chord.
  let lineSlack = 0.015;   // 0 while fitting clean (symmetrised) points
  const lineTol = (tol, L) => Math.max(tol, Math.min(1.0, lineSlack * L));
  function isStraight(P, tol) {
    const a = P[0], b = P[P.length - 1];
    const d = sub(b, a), L = len(d);
    if (L < 1e-9) return false;
    tol = lineTol(tol, L);
    for (let i = 1; i < P.length - 1; i++) {
      const v = sub(P[i], a);
      if (Math.abs(v[0] * d[1] - v[1] * d[0]) / L > tol) return false;
    }
    return true;
  }



  // Taubin (λ|μ) smoothing of an open polyline with fixed ends: removes wobble
  // (e.g. JPEG block noise) without shrinking curves the way plain averaging does.
  function taubin(P, iterations) {
    if (P.length < 5 || iterations <= 0) return P;
    let A = P.map((p) => [p[0], p[1]]);
    const step = (f) => {
      const B = A.map((p) => [p[0], p[1]]);
      for (let i = 1; i < A.length - 1; i++) {
        B[i][0] = A[i][0] + f * ((A[i - 1][0] + A[i + 1][0]) / 2 - A[i][0]);
        B[i][1] = A[i][1] + f * ((A[i - 1][1] + A[i + 1][1]) / 2 - A[i][1]);
      }
      A = B;
    };
    for (let k = 0; k < iterations; k++) { step(0.5); step(-0.53); }
    return A;
  }

  // Snap a nearly horizontal / vertical line to be exact.
  function snapAxis(a, b, maxDeg) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const ang = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);
    if (Math.min(ang, 180 - ang) < maxDeg) { const y = (a[1] + b[1]) / 2; return [[a[0], y], [b[0], y]]; }
    if (Math.abs(ang - 90) < maxDeg) { const x = (a[0] + b[0]) / 2; return [[x, a[1]], [x, b[1]]]; }
    return null;
  }

  // Straight runs inside a smooth stretch: long enough, within tolerance of
  // their chord, and without the one-sided bow that a gentle arc would have.
  function lineRuns(P, tol, minLen) {
    const runs = [];
    const n = P.length;
    let i = 0;
    while (i < n - 2) {
      let j = i + 2;
      while (j < n && isStraight(P.slice(i, j + 1), tol)) j++;
      j--;
      // if the run bends into a curve at its end, shorten it until it is straight
      while (j - i >= 2 && len(sub(P[j], P[i])) >= minLen && isBowed(P, i, j)) j -= Math.max(1, Math.floor((j - i) * 0.1));
      if (j - i >= 2 && len(sub(P[j], P[i])) >= minLen && !isBowed(P, i, j)) {
        runs.push([i, j]);
        i = j;
      } else i++;
    }
    return runs;
  }
  let bowTol = 0.1;
  function isBowed(P, i, j) {
    const a = P[i], d = norm(sub(P[j], a));
    const tol = Math.max(bowTol, lineSlack * 0.27 * len(sub(P[j], a)));
    let sum = 0, cnt = 0;
    const m0 = i + Math.floor((j - i) / 4), m1 = j - Math.floor((j - i) / 4);
    for (let k = m0; k <= m1; k++) { const v = sub(P[k], a); sum += v[0] * d[1] - v[1] * d[0]; cnt++; }
    return cnt > 0 && Math.abs(sum / cnt) > tol;
  }
  function fitLine(P, i, j) {
    let cx = 0, cy = 0;
    for (let k = i; k <= j; k++) { cx += P[k][0]; cy += P[k][1]; }
    const m = j - i + 1;
    cx /= m; cy /= m;
    let sxx = 0, sxy = 0, syy = 0;
    for (let k = i; k <= j; k++) { const dx = P[k][0] - cx, dy = P[k][1] - cy; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    let d = [Math.cos(th), Math.sin(th)];
    if (dot(d, sub(P[j], P[i])) < 0) d = mul(d, -1);
    const proj = (p) => { const t = dot(sub(p, [cx, cy]), d); return [cx + d[0] * t, cy + d[1] * t]; };
    return { d, proj };
  }

  // Fits one corner-to-corner stretch with straight lines where the outline is
  // straight and G1-continuous Bézier curves elsewhere.
  function fitRun(P, t1, t2, opts, segs) {
    P = taubin(P, opts.regularize);
    const n = P.length;
    const tolL = Math.max(0.3, Math.min(opts.tolerance, 1.2) * 0.8);
    bowTol = Math.max(0.07, tolL * 0.2);
    if (n === 2 || (isStraight(P, tolL) && !(n >= 6 && isBowed(P, 0, n - 1)))) { segs.push({ line: true, p: [P[0], P[n - 1]] }); return; }
    // A straight piece is a real part of the drawing (a side, a flat back), not a short
    // chord of a gentle curve: on a large smooth image every few pixels of a curve look
    // straight, which would turn the curve into a polyline.
    let total = 0;
    for (let i = 1; i < n; i++) total += len(sub(P[i], P[i - 1]));
    const runs = lineRuns(P, tolL, Math.max(5, opts.cornerWindow * 3, Math.min(40, 0.2 * total)));
    if (runs.length === 1 && runs[0][0] === 0 && runs[0][1] === n - 1) {
      segs.push({ line: true, p: [P[0], P[n - 1]] });
      return;
    }
    const Q = P.slice();
    // trim run ends back to where the outline actually leaves the line, so the
    // neighbouring curve starts at the true tangent point (no kink)
    for (const run of runs) {
      const f0 = fitLine(P, run[0], run[1]);
      const off = (p) => len(sub(p, f0.proj(p)));
      while (run[1] - run[0] > 3 && run[1] !== n - 1 && off(P[run[1]]) > 0.12) run[1]--;
      while (run[1] - run[0] > 3 && run[0] !== 0 && off(P[run[0]]) > 0.12) run[0]++;
    }
    const dirs = runs.map(([a, b]) => {
      const f = fitLine(P, a, b);
      if (a !== 0) Q[a] = f.proj(P[a]);
      if (b !== n - 1) Q[b] = f.proj(P[b]);
      return f.d;
    });
    const err2 = opts.tolerance * opts.tolerance;
    let pos = 0, tIn = t1;
    const curve = (from, to, ta, tb) => {
      if (to <= from) return;
      const C = [];
      fitCubic(Q.slice(from, to + 1), ta, tb, err2, C, 0);
      for (const c of C) segs.push({ line: false, p: c });
    };
    runs.forEach(([a, b], k) => {
      curve(pos, a, tIn, mul(dirs[k], -1));
      segs.push({ line: true, p: [Q[a], Q[b]] });
      pos = b;
      tIn = dirs[k];
    });
    curve(pos, n - 1, tIn, t2);
  }


  // Make nearly horizontal / vertical lines exact, moving the shared vertices
  // (and the neighbouring curve handles) so the outline stays connected.
  function snapSegments(segs, maxDeg) {
    const n = segs.length;
    const axis = segs.map((sg) => {
      if (!sg.line) return null;
      const snapped = snapAxis(sg.p[0], sg.p[1], maxDeg);
      if (!snapped) return null;
      return snapped[0][1] === snapped[1][1] ? { h: snapped[0][1] } : { v: snapped[0][0] };
    });
    for (let i = 0; i < n; i++) {
      const prev = (i - 1 + n) % n;
      const a = axis[prev], b = axis[i];
      if (!a && !b) continue;
      const V = segs[i].p[0];
      let x = V[0], y = V[1];
      for (const ax of [a, b]) {
        if (!ax) continue;
        if (ax.h !== undefined) y = ax.h; else x = ax.v;
      }
      if (a && b && a.h !== undefined && b.h !== undefined) y = (a.h + b.h) / 2;
      if (a && b && a.v !== undefined && b.v !== undefined) x = (a.v + b.v) / 2;
      const dx = x - V[0], dy = y - V[1];
      if (!dx && !dy) continue;
      const NV = [x, y];
      const cur = segs[i], pr = segs[prev];
      if (!cur.line) cur.p[1] = [cur.p[1][0] + dx, cur.p[1][1] + dy];
      cur.p[0] = NV;
      const last = pr.p.length - 1;
      if (!pr.line) pr.p[2] = [pr.p[2][0] + dx, pr.p[2][1] + dy];
      pr.p[last] = NV;
    }
  }


  // Solve a small dense linear system (Gaussian elimination with pivoting).
  function solve(A, b) {
    const n = b.length;
    const M = A.map((row, i) => row.concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      if (Math.abs(M[piv][c]) < 1e-12) return null;
      [M[c], M[piv]] = [M[piv], M[c]];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((row, i) => row[n] / row[i]);
  }

  // If a closed contour is a circle or an axis-aligned ellipse, return it as
  // four exact Bézier quarter-arcs (what a designer would draw).
  function fitEllipseLoop(pts, tol) {
    const n = pts.length;
    if (n < 12) return null;
    let mx = 0, my = 0;
    for (const p of pts) { mx += p[0]; my += p[1]; }
    mx /= n; my /= n;
    // A x² + B y² + C x + D y = 1  (centred coordinates)
    const S = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], v = [0, 0, 0, 0];
    for (const p of pts) {
      const x = p[0] - mx, y = p[1] - my;
      const f = [x * x, y * y, x, y];
      for (let i = 0; i < 4; i++) { v[i] += f[i]; for (let j = 0; j < 4; j++) S[i][j] += f[i] * f[j]; }
    }
    const sol = solve(S, v);
    if (!sol) return null;
    const [A, B, C, D] = sol;
    if (A <= 0 || B <= 0) return null;
    const cx = -C / (2 * A), cy = -D / (2 * B);
    const k = 1 + A * cx * cx + B * cy * cy;
    let rx = Math.sqrt(k / A), ry = Math.sqrt(k / B);
    if (!isFinite(rx) || !isFinite(ry) || rx < 1.5 || ry < 1.5) return null;
    if (Math.abs(rx - ry) < Math.max(0.35, 0.02 * Math.max(rx, ry))) rx = ry = (rx + ry) / 2; // circle
    // max distance of the contour to the ellipse (radial approximation)
    let maxErr = 0;
    for (const p of pts) {
      const dx = (p[0] - mx - cx) / rx, dy = (p[1] - my - cy) / ry;
      const rr = Math.hypot(dx, dy);
      const e = Math.abs(rr - 1) * Math.hypot(dx * rx, dy * ry) / (rr || 1);
      if (e > maxErr) maxErr = e;
    }
    // small shapes need a tolerance relative to their size: a 4px diamond is within
    // half a pixel of a circle, yet it is not one
    const R = Math.max(rx, ry);
    if (maxErr > Math.max(Math.max(0.3, Math.min(tol, 0.08 * R)), 0.012 * R)) return null;
    const X = mx + cx, Y = my + cy, K = 0.5522847498;
    const P = [[X + rx, Y], [X, Y + ry], [X - rx, Y], [X, Y - ry]];
    const H = [[0, K * ry], [-K * rx, 0], [0, -K * ry], [K * rx, 0]]; // tangent handles
    const segs = [];
    for (let i = 0; i < 4; i++) {
      const a = P[i], b = P[(i + 1) % 4], ha = H[i], hb = H[(i + 1) % 4];
      segs.push({ line: false, p: [a, [a[0] + ha[0], a[1] + ha[1]], [b[0] - hb[0], b[1] - hb[1]], b] });
    }
    return segs;
  }


  // If a closed contour is an axis-aligned (rounded) rectangle, return it with
  // exact straight sides and four equal quarter-circle corners.
  function fitRoundRectLoop(pts, tol, blurRound) {
    const n = pts.length;
    if (n < 12) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
    }
    const w = x1 - x0, h = y1 - y0;
    if (w < 4 || h < 4) return null;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hw = w / 2, hh = h / 2;
    const maxErrFor = (r) => {
      let m = 0;
      for (const p of pts) {
        const qx = Math.abs(p[0] - cx) - hw + r, qy = Math.abs(p[1] - cy) - hh + r;
        const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
        const e = Math.abs(d);
        if (e > m) m = e;
      }
      return m;
    };
    const rMax = Math.min(hw, hh);
    let bestR = 0, bestE = Infinity;
    for (let r = 0; r <= rMax; r += Math.max(0.25, rMax / 60)) {
      const e = maxErrFor(r);
      if (e < bestE) { bestE = e; bestR = r; }
    }
    // a tiny radius is just the mask smoothing rounding a sharp corner
    const sharp = bestR <= blurRound;
    if (sharp) bestE = Math.min(bestE, maxErrFor(0) - blurRound * 0.45);
    if (bestE > Math.max(tol, 0.01 * Math.max(w, h))) return null;
    if (bestR > rMax * 0.97) return null; // that is an ellipse / capsule, handled elsewhere
    const r = sharp ? 0 : bestR, K = 0.5522847498 * r;
    const L = (a, b) => ({ line: true, p: [a, b] });
    const C = (a, h1, h2, b) => ({ line: false, p: [a, h1, h2, b] });
    if (!r) return [L([x0, y0], [x1, y0]), L([x1, y0], [x1, y1]), L([x1, y1], [x0, y1]), L([x0, y1], [x0, y0])];
    return [
      L([x0 + r, y0], [x1 - r, y0]),
      C([x1 - r, y0], [x1 - r + K, y0], [x1, y0 + r - K], [x1, y0 + r]),
      L([x1, y0 + r], [x1, y1 - r]),
      C([x1, y1 - r], [x1, y1 - r + K], [x1 - r + K, y1], [x1 - r, y1]),
      L([x1 - r, y1], [x0 + r, y1]),
      C([x0 + r, y1], [x0 + r - K, y1], [x0, y1 - r + K], [x0, y1 - r]),
      L([x0, y1 - r], [x0, y0 + r]),
      C([x0, y0 + r], [x0, y0 + r - K], [x0 + r - K, y0], [x0 + r, y0]),
    ];
  }

  // Turns one closed contour into a list of segments ({line} or cubic).
  // Rotational symmetry: a star, a regular polygon, a flower or a gear repeats n times
  // around its centre (n = 3..8). Averaging the n copies of its radius profile
  // cancels noise and blur, so every point comes out identical, as a designer
  // would draw it. Only accepted when the copies already agree closely.
  function symmetrizeLoop(pts) {
    const n = pts.length;
    if (n < 40) return null;
    let A = 0, cx = 0, cy = 0;
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n], c = p[0] * q[1] - q[0] * p[1];
      A += c; cx += (p[0] + q[0]) * c; cy += (p[1] + q[1]) * c;
    }
    if (Math.abs(A) < 1e-6) return null;
    cx /= 3 * A; cy /= 3 * A;
    // angle must advance monotonically (shape seen whole from its centre)
    const ang = [], rad = [];
    let prev = Math.atan2(pts[0][1] - cy, pts[0][0] - cx), acc = prev, dir = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.atan2(pts[i][1] - cy, pts[i][0] - cx);
      let d = a - prev;
      if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
      if (i) {
        if (!dir && Math.abs(d) > 1e-3) dir = Math.sign(d);
        if (dir && d * dir < -0.02) return null;
      }
      acc += i ? d : 0; prev = a;
      ang.push(acc); rad.push(Math.hypot(pts[i][0] - cx, pts[i][1] - cy));
    }
    if (!dir || Math.abs(acc - ang[0]) < 2 * Math.PI * 0.97) return null;
    // radius on a uniform angular grid (M divisible by 3..8)
    const M = 840, r = new Float64Array(M), a0 = ang[0];
    const order = ang.map((a, i) => [(dir > 0 ? a - a0 : a0 - a), rad[i]]).sort((u, v) => u[0] - v[0]);
    let k = 0;
    for (let j = 0; j < M; j++) {
      const t = (j / M) * 2 * Math.PI;
      while (k < order.length - 1 && order[k + 1][0] < t) k++;
      const [t0, r0] = order[k], [t1, r1] = k + 1 < order.length ? order[k + 1] : [order[0][0] + 2 * Math.PI, order[0][1]];
      r[j] = t1 > t0 ? r0 + (r1 - r0) * Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : r0;
    }
    let mean = 0;
    for (let j = 0; j < M; j++) mean += r[j];
    mean /= M;
    if (mean < 6) return null;
    let best = null;
    for (let f = 3; f <= 8; f++) {
      const step = M / f, sym = new Float64Array(M);
      for (let j = 0; j < M; j++) { let sum = 0; for (let q = 0; q < f; q++) sum += r[(j + q * step) % M]; sym[j] = sum / f; }
      let res = 0, lo = Infinity, hi = -Infinity;
      for (let j = 0; j < M; j++) { res += (r[j] - sym[j]) ** 2; lo = Math.min(lo, sym[j]); hi = Math.max(hi, sym[j]); }
      res = Math.sqrt(res / M) / mean;
      const variation = (hi - lo) / mean;
      if (variation < 0.12 || res > 0.035) continue;
      if (!best || res < best.res * 0.9 || (res <= best.res * 1.1 && f > best.f)) best = { f, res, sym };
    }
    if (!best) return null;
    // Cut the loop at its f tips, resample each piece by arc length, rotate the pieces
    // onto the first one and average them point by point (radius-vs-angle is badly
    // conditioned on a star's flanks, where the outline runs almost radially).
    const f = best.f, step = M / f;
    let jmax = 0;
    for (let j = 1; j < step; j++) if (best.sym[j] > best.sym[jmax]) jmax = j;
    const rel = ang.map((a) => (dir > 0 ? a - a0 : a0 - a));   // 0 .. 2π, increasing with i
    const tips = [];
    for (let q = 0; q < f; q++) {
      const t = ((jmax + q * step) / M) * 2 * Math.PI;
      let bi = 0, bd = Infinity;
      for (let i = 0; i < n; i++) { const d = Math.abs(rel[i] - t); if (d < bd) { bd = d; bi = i; } }
      tips.push(bi);
    }
    const m = Math.max(12, Math.ceil(n / f));
    const pieceAt = (from, to) => {   // points from index `from` to `to` (wrapping), resampled to m
      const P = [];
      for (let i = from; ; i = (i + 1) % n) { P.push(pts[i]); if (i === to) break; }
      const cum = [0];
      for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
      const L = cum[cum.length - 1], out = [];
      let k = 0;
      for (let j = 0; j < m; j++) {
        const u = (j / (m - 1)) * L;
        while (k < cum.length - 2 && cum[k + 1] < u) k++;
        const seg = cum[k + 1] - cum[k] || 1, v = (u - cum[k]) / seg;
        out.push([P[k][0] + (P[k + 1][0] - P[k][0]) * v, P[k][1] + (P[k + 1][1] - P[k][1]) * v]);
      }
      return out;
    };
    const rot = (p, t) => { const c = Math.cos(t), s = Math.sin(t); return [cx + (p[0] - cx) * c - (p[1] - cy) * s, cy + (p[0] - cx) * s + (p[1] - cy) * c]; };
    const turn = (q) => dir * (q * 2 * Math.PI) / f;
    const pieces = [];
    for (let q = 0; q < f; q++) pieces.push(pieceAt(tips[q], tips[(q + 1) % f]).map((p) => rot(p, -turn(q))));
    const avg = [];
    for (let j = 0; j < m; j++) {
      let x = 0, y = 0;
      for (const P of pieces) { x += P[j][0]; y += P[j][1]; }
      avg.push([x / f, y / f]);
    }
    let dev = 0;
    for (const P of pieces) for (let j = 0; j < m; j++) dev += (P[j][0] - avg[j][0]) ** 2 + (P[j][1] - avg[j][1]) ** 2;
    // real stars / polygons repeat within a pixel; a shape that is only nearly
    // symmetric (a pillow with four similar sides) keeps its own outline
    if (Math.sqrt(dev / (f * m)) > Math.min(0.04 * mean, Math.max(1.5, 0.008 * mean))) return null;
    const smooth = taubin(avg, 3);   // pixel staircase left after averaging (tips stay fixed)
    const out = [];
    for (let q = 0; q < f; q++) for (let j = 0; j < m - 1; j++) out.push(rot(smooth[j], turn(q)));
    return { pts: out, f: best.f, cx, cy };
  }

  // Fit one period of a symmetric loop (tip to next tip) and rotate it f times, so
  // every point of a star has the very same nodes and smooth curves.
  function fitSymmetric(S, opts) {
    const { pts: Q, f, cx, cy } = S, n = Q.length, per = n / f;
    const at = (i) => Q[((i % n) + n) % n];
    const rad = (i) => { const q = at(i); return Math.hypot(q[0] - cx, q[1] - cy); };
    let i0 = 0;
    for (let i = 1; i < per; i++) if (rad(i) > rad(i0)) i0 = i;
    let iv = i0;
    for (let i = i0; i <= i0 + per; i++) if (rad(i) < rad(iv)) iv = i;
    const w = Math.max(2, Math.round(per / 10));
    const turn = (i, k) => {
      const a = norm(sub(at(i), at(i - k))), b = norm(sub(at(i + k), at(i)));
      return Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1])));
    };
    // a real corner turns within a few points; a rounded tip turns gradually
    const sharp = (i) => { const T = turn(i, w); return T > 0.87 && turn(i, Math.max(1, Math.round(w / 4))) > 0.6 * T; };
    const pieces = sharp(iv) && iv > i0 && iv < i0 + per ? [[i0, iv], [iv, i0 + per]] : [[i0, i0 + per]];
    const one = [];
    // the points are already noise-free; a side is either one straight line or one
    // smooth curve (straight pieces inside a gentle curve look like breaks)
    // (a whole straight side, as in a polygon, is still found as one line)
    const clean = { ...opts, regularize: 0, cornerWindow: Math.max(opts.cornerWindow, per) };
    lineSlack = 0;
    for (const [a, b] of pieces) {
      const P = [];
      for (let i = a; i <= b; i++) P.push(at(i));
      const k = Math.min(w, P.length - 1);
      const t1 = sharp(a) ? norm(sub(P[k], P[0])) : norm(sub(at(a + 1), at(a - 1)));
      const t2 = sharp(b) ? norm(sub(P[P.length - 1 - k], P[P.length - 1])) : norm(sub(at(b - 1), at(b + 1)));
      fitRun(P, t1, t2, clean, one);
    }
    lineSlack = 0.015;
    const ang = Math.atan2(at(i0 + per)[1] - cy, at(i0 + per)[0] - cx) - Math.atan2(at(i0)[1] - cy, at(i0)[0] - cx);
    const segs = [];
    for (let k = 0; k < f; k++) {
      const c = Math.cos(ang * k), s = Math.sin(ang * k);
      const rot = (p) => [cx + (p[0] - cx) * c - (p[1] - cy) * s, cy + (p[0] - cx) * s + (p[1] - cy) * c];
      for (const g of one) segs.push({ line: g.line, p: g.p.map(rot) });
    }
    return segs;
  }

  function fitLoop(rawPts, opts) {
    // de-duplicate
    const pts = [];
    for (const p of rawPts) {
      const q = pts[pts.length - 1];
      if (!q || Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) > 1e-4) pts.push(p);
    }
    if (pts.length > 1) {
      const a = pts[0], z = pts[pts.length - 1];
      if (Math.abs(a[0] - z[0]) + Math.abs(a[1] - z[1]) <= 1e-4) pts.pop();
    }
    let n = pts.length;
    if (n < 3) return null;
    const ell = opts.shapes !== false ? fitEllipseLoop(pts, Math.max(0.45, opts.tolerance)) : null;
    if (ell) return ell;
    const rrect = opts.shapes !== false ? fitRoundRectLoop(pts, Math.max(0.45, opts.tolerance), opts.blurRound || 0.6) : null;
    if (rrect) return rrect;
    if (opts.shapes !== false) {
      const sym = symmetrizeLoop(pts);
      if (sym) return fitSymmetric(sym, opts);
    }
    if (opts.regularize && n >= 8) {
      // cyclic Taubin pass so noise does not create false corners
      let A = pts;
      const step = (f) => A.map((p, i) => {
        const a = A[(i - 1 + n) % n], b = A[(i + 1) % n];
        return [p[0] + f * ((a[0] + b[0]) / 2 - p[0]), p[1] + f * ((a[1] + b[1]) / 2 - p[1])];
      });
      for (let k = 0; k < opts.regularize; k++) { A = step(0.5); A = step(-0.53); }
      pts.splice(0, n, ...A);
    }

    const arc = makeArc(pts);
    const r = opts.cornerWindow;

    // Sharpen corners: fit a line to each arm next to the corner (skipping the
    // part rounded by smoothing) and move the corner to where the arms meet.
    const cornerPos = new Map();   // index -> sharpened position
    const cornerTrim = new Map();  // index -> arc length of rounded points to drop
    const armDir = new Map();      // index -> { back, fwd } unit directions away from the corner
    function fitArm(s, dir, inner, outer) {
      const P = [];
      for (let t = inner; t <= outer + 1e-9; t += 0.5) P.push(arc.at(s + dir * t));
      if (P.length < 3) return null;
      let cx = 0, cy = 0;
      for (const p of P) { cx += p[0]; cy += p[1]; }
      cx /= P.length; cy /= P.length;
      let sxx = 0, sxy = 0, syy = 0;
      for (const p of P) { const dx = p[0] - cx, dy = p[1] - cy; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
      const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      let d = [Math.cos(theta), Math.sin(theta)];
      // orient away from the corner
      if (dot(d, sub(P[P.length - 1], P[0])) < 0) d = mul(d, -1);
      let rms = 0;
      for (const p of P) { const v = [p[0] - cx, p[1] - cy]; const e = v[0] * d[1] - v[1] * d[0]; rms += e * e; }
      rms = Math.sqrt(rms / P.length);
      return { c: [cx, cy], d, rms };
    }
    const armRange = (list, ci) => {
      const i = list[ci], s = arc.cum[i];
      const prev = list[(ci - 1 + list.length) % list.length], nextC = list[(ci + 1) % list.length];
      const dPrev = list.length > 1 ? (s - arc.cum[prev] + arc.total) % arc.total : arc.total;
      const dNext = list.length > 1 ? (arc.cum[nextC] - s + arc.total) % arc.total : arc.total;
      return { s, dPrev, dNext };
    };
    // Keep a corner only if one of its arms is straight or the turn is very
    // sharp: noise on a curve produces "corners" whose arms are both curved.
    const raw = detectCorners(pts, arc, r, opts.cornerAngle);
    const corners = raw.filter((i, ci) => {
      const { s, dPrev, dNext } = armRange(raw, ci);
      const u = norm(sub(pts[i], arc.at(s - r))), v = norm(sub(arc.at(s + r), pts[i]));
      if (Math.acos(Math.max(-1, Math.min(1, dot(u, v)))) > (100 * Math.PI) / 180) return true;
      const b = Math.min(Math.max(3 * r, 6), dPrev * 0.5), f = Math.min(Math.max(3 * r, 6), dNext * 0.5);
      const back = b - Math.min(r, dPrev * 0.25) >= 1 ? fitArm(s, -1, Math.min(r, dPrev * 0.25), b) : null;
      const fwd = f - Math.min(r, dNext * 0.25) >= 1 ? fitArm(s, 1, Math.min(r, dNext * 0.25), f) : null;
      // too short to judge (small detail) -> keep
      if (!back && !fwd) return true;
      if (back && fwd) {
        // multi-scale check: the arms themselves must turn by (roughly) the
        // corner angle. On a smooth curve they differ only by the arc between them.
        const armTurn = Math.PI - Math.acos(Math.max(-1, Math.min(1, dot(back.d, fwd.d))));
        if (armTurn < opts.cornerAngle * 0.75) return false;
      }
      return (back && back.rms < 0.35) || (fwd && fwd.rms < 0.35);
    });
    const isCorner = new Set(corners);
    for (let ci = 0; ci < corners.length; ci++) {
      const i = corners[ci];
      const s = arc.cum[i];
      const prev = corners[(ci - 1 + corners.length) % corners.length];
      const nextC = corners[(ci + 1) % corners.length];
      const dPrev = corners.length > 1 ? (s - arc.cum[prev] + arc.total) % arc.total : arc.total;
      const dNext = corners.length > 1 ? (arc.cum[nextC] - s + arc.total) % arc.total : arc.total;
      const innerB = Math.min(r, dPrev * 0.25), outerB = Math.min(Math.max(3 * r, 6), dPrev * 0.5);
      const innerF = Math.min(r, dNext * 0.25), outerF = Math.min(Math.max(3 * r, 6), dNext * 0.5);
      const back = outerB - innerB >= 1 ? fitArm(s, -1, innerB, outerB) : null;
      const fwd = outerF - innerF >= 1 ? fitArm(s, 1, innerF, outerF) : null;
      armDir.set(i, {
        back: back && back.rms < 0.3 ? back.d : null,
        fwd: fwd && fwd.rms < 0.3 ? fwd.d : null,
      });
      if (!back || !fwd || back.rms > 0.3 || fwd.rms > 0.3) continue;
      const x = lineIntersect(back.c, back.d, fwd.c, fwd.d);
      if (x && len(sub(x, pts[i])) < Math.max(2, 1.5 * r)) {
        cornerPos.set(i, x);
        cornerTrim.set(i, Math.min(innerB, innerF));
      }
    }

    // Split points: corners, plus smooth split points for long / corner-less loops.
    let splits = corners.slice();
    if (splits.length === 0) splits = [0, Math.floor(n / 3), Math.floor((2 * n) / 3)];
    else if (splits.length === 1) splits.push((splits[0] + Math.floor(n / 2)) % n);
    splits.sort((a, b) => a - b);
    splits = splits.filter((v, i, arr) => i === 0 || v !== arr[i - 1]);

    const ptAt = (i) => cornerPos.get(i) || pts[i];
    const segs = [];
    const err2 = opts.tolerance * opts.tolerance;
    for (let k = 0; k < splits.length; k++) {
      const i0 = splits[k], i1 = splits[(k + 1) % splits.length];
      const segLen = (arc.cum[i1] - arc.cum[i0] + arc.total) % arc.total || arc.total;
      const s0 = arc.cum[i0], s1 = s0 + segLen;
      const trim0 = cornerTrim.get(i0) || 0, trim1 = cornerTrim.get(i1) || 0;
      const P = [ptAt(i0)];
      for (let i = (i0 + 1) % n; i !== i1; i = (i + 1) % n) {
        const d0 = (arc.cum[i] - s0 + arc.total) % arc.total;
        if (d0 < trim0 || segLen - d0 < trim1) continue; // rounded corner points
        P.push(pts[i]);
      }
      P.push(ptAt(i1));
      const h = Math.max(0.5, Math.min(r, segLen / 3));
      const a0 = armDir.get(i0), a1 = armDir.get(i1);
      const t1 = isCorner.has(i0)
        ? (a0 && a0.fwd) || norm(sub(arc.at(s0 + h), P[0]))
        : norm(sub(arc.at(s0 + h), arc.at(s0 - h)));
      const t2 = isCorner.has(i1)
        ? (a1 && a1.back) || norm(sub(arc.at(s1 - h), P[P.length - 1]))
        : norm(sub(arc.at(s1 - h), arc.at(s1 + h)));
      fitRun(P, t1, t2, opts, segs);
    }
    if (opts.snapDeg) snapSegments(segs, opts.snapDeg);
    return smoothJoins(curveChains(mergeCurves(collapseTiny(sharpenTips(segs, opts.maskAt), Math.max(2.5, opts.tolerance * 3)), opts.tolerance), opts.tolerance));
  }

  // A chain of straight lines that meet at slight angles (3..25 degrees) is a
  // gentle curve drawn as a polygon: it is refitted as smooth cubic curves.
  function curveChains(segs, tol) {
    const n = segs.length;
    if (n < 3) return segs;
    const dirOf = (g) => norm(sub(g.p[g.p.length - 1], g.p[0]));
    const bend = (A, B) => Math.acos(Math.max(-1, Math.min(1, dot(dirOf(A), dirOf(B)))));
    const lo = (3 * Math.PI) / 180, hi = (25 * Math.PI) / 180;
    const soft = (i) => { const A = segs[i], B = segs[(i + 1) % n]; if (!A.line || !B.line) return false; const b = bend(A, B); return b > lo && b < hi; };
    // start at a join that is not soft, so chains do not wrap around
    let start = -1;
    for (let i = 0; i < n; i++) if (!soft(i)) { start = (i + 1) % n; break; }
    if (start < 0) return segs;   // the whole loop is one gentle polygon: leave it
    const out = [];
    for (let k = 0; k < n;) {
      const i = (start + k) % n;
      let m = 1;
      while (k + m < n && soft((start + k + m - 1) % n)) m++;
      if (m >= 2) {
        const chain = [];
        for (let j = 0; j < m; j++) chain.push(segs[(i + j) % n]);
        const P = [chain[0].p[0]];
        for (const g of chain) {
          const a = g.p[0], b = g.p[1], L = len(sub(b, a)), steps = Math.max(1, Math.ceil(L / 2));
          for (let t = 1; t <= steps; t++) P.push(add(a, mul(sub(b, a), t / steps)));
        }
        const C = [];
        fitCubic(P, dirOf(chain[0]), mul(dirOf(chain[m - 1]), -1), Math.max(tol, 0.8) ** 2, C, 0);
        for (const c of C) out.push({ line: false, p: c });
      } else out.push(segs[i]);
      k += m;
    }
    return out;
  }

  // Smooth points, as in Illustrator: where two segments meet at a slight angle
  // (under ~30 degrees, not a real corner) the handles are put on one straight
  // line, so the outline has no small kink. Handle lengths are kept; next to a
  // straight line the curve takes the line's direction.
  function smoothJoins(segs) {
    const n = segs.length;
    if (n < 2) return segs;
    const out = segs.map((g) => ({ line: g.line, p: g.p.map((v) => v.slice()) }));
    const limit = Math.cos((30 * Math.PI) / 180);
    for (let i = 0; i < n; i++) {
      const A = out[i], B = out[(i + 1) % n];
      if (A.line && B.line) continue;
      const q = A.p[A.p.length - 1];
      // a zero-length handle takes its direction from the other control point
      let hA = A.line ? null : sub(q, A.p[2]), hB = B.line ? null : sub(B.p[1], q);
      if (hA && len(hA) < 0.3) hA = mul(norm(sub(q, A.p[1])), len(sub(q, A.p[0])) / 3);
      if (hB && len(hB) < 0.3) hB = mul(norm(sub(B.p[2], q)), len(sub(B.p[3], q)) / 3);
      const ta = A.line ? norm(sub(q, A.p[0])) : norm(hA);
      const tb = B.line ? norm(sub(B.p[1], q)) : norm(hB);
      if (!(ta[0] || ta[1]) || !(tb[0] || tb[1])) continue;
      if (dot(ta, tb) < limit) continue;                 // a real corner
      const t = A.line ? ta : B.line ? tb : norm(add(ta, tb));
      if (!A.line) A.p[2] = sub(q, mul(t, len(hA)));
      if (!B.line) B.p[1] = add(q, mul(t, len(hB)));
    }
    return out;
  }

  // A narrow wedge (the notch between an antler and a head, the tip of a thin spike)
  // is blurred into a tiny blunt connector. Two edges that run towards each other at
  // a narrow angle are extended until they meet, giving the sharp tip a designer
  // draws. Parallel edges (the round end of a stroke) never meet and are left alone.
  function sharpenTips(segs, maskAt) {
    if (segs.length < 4) return segs;
    const out = segs.map((g) => ({ line: g.line, p: g.p.map((v) => v.slice()) }));
    const endDir = (g) => norm(sub(g.p[g.p.length - 1], g.p[g.p.length - 2]));
    const startDir = (g) => norm(sub(g.p[1], g.p[0]));
    for (let k = 0; k < out.length && out.length > 4; k++) {
      const n = out.length, S = out[k], P = out[(k - 1 + n) % n], Nx = out[(k + 1) % n];
      const a = S.p[0], b = S.p[S.p.length - 1], L = len(sub(b, a));
      if (L > 6 || L < 0.5) continue;
      const dP = endDir(P), dN = startDir(Nx);   // arriving along dP, leaving along dN
      const back = mul(dN, -1);
      const conv = Math.acos(Math.max(-1, Math.min(1, dot(dP, back))));   // wedge angle
      if (conv < 0.17 || conv > 1.2) continue;                          // 10..70 degrees
      // X = a + t dP = b + u back
      const det = dP[0] * -back[1] + back[0] * dP[1];
      if (Math.abs(det) < 1e-6) continue;
      const rx = b[0] - a[0], ry = b[1] - a[1];
      const t = (rx * -back[1] + back[0] * ry) / det, u = (dP[0] * ry - dP[1] * rx) / det;
      if (t < 0 || u < 0 || t > Math.max(4 * L, 10) || u > Math.max(4 * L, 10)) continue;
      const X = [a[0] + dP[0] * t, a[1] + dP[1] * t];
      // the tip must still lie in the (blurred) shape: a narrow wedge fades out
      // towards its tip, while a point poking into another colour has nothing there
      if (maskAt) {
        const mid = [(X[0] + (a[0] + b[0]) / 2) / 2, (X[1] + (a[1] + b[1]) / 2) / 2];
        if (maskAt(X[0], X[1]) < 0.12 || maskAt(mid[0], mid[1]) < 0.25) continue;
      }
      const moveEnd = (g, q) => { const e = g.p[g.p.length - 1], dx = q[0] - e[0], dy = q[1] - e[1]; g.p[g.p.length - 1] = q; if (!g.line) g.p[2] = [g.p[2][0] + dx, g.p[2][1] + dy]; };
      const moveStart = (g, q) => { const e = g.p[0], dx = q[0] - e[0], dy = q[1] - e[1]; g.p[0] = q; if (!g.line) g.p[1] = [g.p[1][0] + dx, g.p[1][1] + dy]; };
      moveEnd(P, X);
      moveStart(Nx, X);
      out.splice(k, 1);
      k--;
    }
    return out;
  }

  // Fewer nodes, like a designer: two neighbouring curves that meet smoothly are
  // replaced by one curve when a single cubic still follows both within tolerance
  // and the pair turns less than ~100 degrees.
  function mergeCurves(segs, tol) {
    const bez = (b, t) => bezierPt(b, t);
    const tanOut = (g) => norm(sub(g.p[3], g.p[2]));
    const tanIn = (g) => norm(sub(g.p[1], g.p[0]));
    const err2 = tol * tol;
    let out = segs.slice(), changed = true;
    for (let guard = 0; changed && guard < 200 && out.length > 3; guard++) {
      changed = false;
      for (let i = 0; i < out.length && out.length > 3; i++) {
        const A = out[i], B = out[(i + 1) % out.length];
        if (A.line || B.line) continue;
        const ta = tanOut(A), tb = tanIn(B);
        if (dot(ta, tb) < Math.cos(0.12)) continue;            // not a smooth join (a corner)
        const P = [];
        for (let k = 0; k <= 12; k++) P.push(bez(A.p, k / 12));
        for (let k = 1; k <= 12; k++) P.push(bez(B.p, k / 12));
        const { total } = turning(P);
        if (total > 1.75) continue;
        const t1 = tanIn(A), t2 = mul(tanOut(B), -1);
        let u = chordParams(P), b = generateBezier(P, u, t1, t2);
        let { maxD } = maxError(P, b, u);
        for (let it = 0; it < 6 && maxD >= err2; it++) {
          u = reparameterize(P, b, u); b = generateBezier(P, u, t1, t2); ({ maxD } = maxError(P, b, u));
        }
        if (maxD >= err2) continue;
        const j = (i + 1) % out.length;
        out[i] = { line: false, p: b };
        out.splice(j, 1);
        changed = true;
      }
    }
    return out;
  }

  // Two nodes a couple of pixels apart (a tiny curve left between a sharpened corner
  // and the next segment) become one node, as a designer would draw it.
  function collapseTiny(segs, minLen) {
    if (segs.length < 4) return segs;
    let out = segs;
    for (let pass = 0; pass < 3; pass++) {
      const n = out.length;
      let k = -1;
      for (let i = 0; i < n; i++) {
        const s = out[i], a = s.p[0], b = s.p[s.p.length - 1];
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < minLen && n > 3) { k = i; break; }
      }
      if (k < 0) break;
      const s = out[k], a = s.p[0], b = s.p[s.p.length - 1];
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const prev = out[(k - 1 + n) % n], next = out[(k + 1) % n];
      const moveEnd = (g, q) => {   // move the last node of g to q, dragging its handle along
        const e = g.p[g.p.length - 1], dx = q[0] - e[0], dy = q[1] - e[1];
        const p = g.p.map((v) => v.slice());
        p[p.length - 1] = q;
        if (!g.line) p[2] = [p[2][0] + dx, p[2][1] + dy];
        return { line: g.line, p };
      };
      const moveStart = (g, q) => {
        const e = g.p[0], dx = q[0] - e[0], dy = q[1] - e[1];
        const p = g.p.map((v) => v.slice());
        p[0] = q;
        if (!g.line) p[1] = [p[1][0] + dx, p[1][1] + dy];
        return { line: g.line, p };
      };
      const next2 = out.slice();
      next2[(k - 1 + n) % n] = moveEnd(prev, m);
      next2[(k + 1) % n] = moveStart(next, m);
      next2.splice(k, 1);
      out = next2;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // SVG path serialisation
  // ---------------------------------------------------------------------------
  function fmt(v) {
    const s = (Math.round(v * 100) / 100).toFixed(2);
    return s.replace(/\.?0+$/, '').replace(/^-0$/, '0');
  }
  function segsToPath(segs, scale) {
    if (!segs || !segs.length) return '';
    const P = (p) => fmt(p[0] * scale) + ' ' + fmt(p[1] * scale);
    let d = 'M' + P(segs[0].p[0]);
    for (const s of segs) {
      d += s.line ? 'L' + P(s.p[1]) : 'C' + P(s.p[1]) + ' ' + P(s.p[2]) + ' ' + P(s.p[3]);
    }
    return d + 'Z';
  }

  // ---------------------------------------------------------------------------
  // Main entry point
  // ---------------------------------------------------------------------------
  /**
   * @param {Uint8ClampedArray} rgba  pixel data (w*h*4)
   * @param {number} w
   * @param {number} h
   * @param {object} options
   *   mode: 'color' | 'bw'
   *   colors: max colours (2..64)
   *   smooth: mask blur sigma in px (0..3)
   *   tolerance: curve-fitting error in px
   *   cornerAngle: degrees of turn that counts as a corner
   *   minArea: speckle size in px
   *   cleanEdges: remove anti-aliasing halos
   *   outScale: multiply output coordinates (original size / working size)
   * @param {function} progress  optional (fraction, label) callback
   */
  function vectorize(rgba, w, h, options, progress) {
    const o = Object.assign({
      mode: 'color', colors: 12, smooth: 0.9, tolerance: 0.6, cornerAngle: 60,
      minArea: 10, cleanEdges: true, outScale: 1, mergeDist: 6, flatThreshold: 4, denoise: false, regularize: 3, snapAxis: true, removeRules: true, clearHoles: false, mergeSoft: true,
    }, options || {});
    const report = progress || function () {};
    const N = w * h;
    const lab = new Float32Array(N * 3);
    const alphaMask = new Uint8Array(N);
    const opaque = [];
    for (let p = 0; p < N; p++) {
      if (rgba[p * 4 + 3] >= 128) { alphaMask[p] = 1; opaque.push(p); }
      rgbToLab(rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2], lab, p * 3);
    }
    const hasTransparency = opaque.length < N;
    const outW = Math.round(w * o.outScale), outH = Math.round(h * o.outScale);
    if (!opaque.length) return { width: outW, height: outH, background: null, layers: [] };
    report(0.1, 'quantize');

    let labels;
    let K;
    let labSoft = lab;
    const exactHex = [];
    if (o.mode === 'bw') {
      const thr = otsu(lab, alphaMask, N);
      labels = new Int32Array(N);
      for (let p = 0; p < N; p++) labels[p] = !alphaMask[p] ? -1 : lab[p * 3] < thr ? 0 : 1;
      K = 2;
    } else {
      // Palette from flat (interior) pixels only, using noise-reduced colours.
      const labB = boxLab(lab, w, h);

      const flat = flatMask(labB, alphaMask, w, h, o.flatThreshold);
      if (o.denoise) labSoft = labB; // optional: noise-reduced colours for edge coverage
      let samples = [];
      for (const p of opaque) if (flat[p]) samples.push(p);
      if (samples.length < opaque.length * 0.05) samples = opaque;
      const maxK = Math.max(2, Math.min(64, o.colors | 0));
      const rand = mulberry32(1234567);
      let centers = kmeans(labB, samples, maxK, rand, o.mergeDist);
      // Second pass: colours with no flat interior (thin text, tiny details) are
      // missed above. Find pixels that are neither near a palette colour nor a
      // blend of two palette colours, and add palette entries for them.
      if (centers.length < maxK) {
        const missed = [];
        const step = Math.max(1, Math.floor(opaque.length / 60000));
        for (let k = 0; k < opaque.length; k += step) {
          const p = opaque[k] * 3;
          const l = labB[p], a = labB[p + 1], b = labB[p + 2];
          let bestD = Infinity;
          for (const c of centers) bestD = Math.min(bestD, (l - c[0]) ** 2 + (a - c[1]) ** 2 + (b - c[2]) ** 2);
          // Flat light pixels are a real colour, not an edge blend: a uniform pale
          // blue next to white (a lens, paper) needs its own entry even when close.
          if (flat[opaque[k]] && l > 85) { if (bestD >= 5 * 5) missed.push(opaque[k]); continue; }
          if (bestD < 15 * 15) continue;
          let explained = false;
          for (let i = 0; i < centers.length && !explained; i++) for (let j = i + 1; j < centers.length; j++) {
            const ci = centers[i], cj = centers[j];
            const ex = cj[0] - ci[0], ey = cj[1] - ci[1], ez = cj[2] - ci[2];
            const ee = ex * ex + ey * ey + ez * ez;
            const qx = l - ci[0], qy = a - ci[1], qz = b - ci[2];
            let t = ee > 0 ? (qx * ex + qy * ey + qz * ez) / ee : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            if ((qx - t * ex) ** 2 + (qy - t * ey) ** 2 + (qz - t * ez) ** 2 < 8 * 8) { explained = true; break; }
          }
          if (!explained) missed.push(opaque[k]);
        }
        if (missed.length * step > Math.max(12, opaque.length * 0.001)) {
          const extra = kmeans(labB, missed, Math.min(4, maxK - centers.length), rand, o.mergeDist);
          centers = centers.concat(extra.filter((e) => centers.every((c) => Math.hypot(c[0] - e[0], c[1] - e[1], c[2] - e[2]) >= o.mergeDist)));
        }
      }
      // Known palette (the colours the image was generated with): every colour
      // group close to one of them is drawn in exactly that colour, and shades of
      // the same colour collapse into one.
      if (o.snapColors && o.snapColors.length) {
        const pal = o.snapColors.map((hex) => {
          const v = parseInt(String(hex).replace('#', ''), 16), c = new Float64Array(3);
          rgbToLab(v >> 16, (v >> 8) & 255, v & 255, c, 0);
          return { hex: '#' + String(hex).replace('#', '').toLowerCase(), c };
        });
        // CIE94-style distance: a lighter / less saturated shade of the same colour is
        // close, a different hue is not (sky blue must never become cyan).
        const dist = (c, q) => {
          const C1 = Math.hypot(q[1], q[2]), C2 = Math.hypot(c[1], c[2]);
          const dL = c[0] - q[0], dC = C2 - C1;
          const dH2 = Math.max(0, (c[1] - q[1]) ** 2 + (c[2] - q[2]) ** 2 - dC * dC);
          if (C1 > 10 && C2 > 10) {
            let dh = Math.abs(Math.atan2(c[2], c[1]) - Math.atan2(q[2], q[1])) * 180 / Math.PI;
            if (dh > 180) dh = 360 - dh;
            if (dh > 20) return Infinity;
          }
          if (Math.abs(dL) > 8) return Infinity;   // a lighter / darker colour is another colour
          return Math.sqrt(dL * dL + (dC / (1 + 0.045 * C1)) ** 2 + dH2 / (1 + 0.015 * C1) ** 2);
        };
        // Pixels are assigned with the image's own colours (moving the centres would
        // re-split smooth areas into blotches); then groups that are shades of the
        // same palette colour are merged and drawn in exactly that colour.
        labels = assignLabels(lab, alphaMask, flat, w, h, centers);
        K = centers.length;
        // shared edge length between groups, and each group's whole edge length
        const adj = new Float64Array(K * K), edge = new Float64Array(K);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const p = y * w + x, A = labels[p];
          if (A < 0) continue;
          for (const q of [x < w - 1 ? p + 1 : -1, y < h - 1 ? p + w : -1]) {
            const B = q < 0 ? -1 : labels[q];
            if (B < 0 || B === A) continue;
            adj[A * K + B]++; adj[B * K + A]++; edge[A]++; edge[B]++;
          }
        }
        const match = centers.map((c, i) => {
          let best = null, bd = Infinity;
          for (const q of pal) { const d = dist(c, q.c); if (d < bd) { bd = d; best = q; } }
          return best && bd < (o.snapDist || 20) ? { i, hex: best.hex, d: bd } : null;
        }).filter(Boolean).sort((a, b) => a.d - b.d);
        const remap = new Int32Array(K), owners = new Map();
        for (let i = 0; i < K; i++) remap[i] = i;
        for (const m of match) {       // closest shade first: it gets the exact colour
          const list = owners.get(m.hex);
          if (!list) { owners.set(m.hex, [m.i]); exactHex[m.i] = m.hex; continue; }
          // a shade that shares a real edge with the group is a separate part of the
          // drawing (strap back vs outline): merging would erase that edge
          const f = list[0];
          const touch = list.reduce((t, j) => t + adj[m.i * K + j], 0);
          if (touch < 0.1 * Math.min(edge[m.i], edge[f])) { remap[m.i] = f; list.push(m.i); }
        }
        for (let p = 0; p < N; p++) if (labels[p] >= 0) labels[p] = remap[labels[p]];
      } else {
        labels = assignLabels(lab, alphaMask, flat, w, h, centers);
        K = centers.length;
      }
    }
    report(0.3, 'clean');

    // Lab colour of each label (for colour-nearest reassignment)
    let labColors = new Float64Array(K * 3);
    let counts = new Float64Array(K);
    for (let p = 0; p < N; p++) {
      const L = labels[p];
      if (L < 0) continue;
      labColors[L * 3] += lab[p * 3]; labColors[L * 3 + 1] += lab[p * 3 + 1]; labColors[L * 3 + 2] += lab[p * 3 + 2];
      counts[L]++;
    }
    for (let L = 0; L < K; L++) if (counts[L]) for (let c = 0; c < 3; c++) labColors[L * 3 + c] /= counts[L];
    // Two groups whose actual colours are almost the same (a second navy 3-4 units away)
    // are one colour: merged into the larger one, keeping an exact palette colour.
    if (o.mode !== 'bw') {
      const into = Int32Array.from({ length: K }, (_, i) => i);
      const find = (i) => { while (into[i] !== i) i = into[i]; return i; };
      const lim = Math.max(3, o.mergeDist || 6) ** 2;
      let merged = false;
      for (let a = 0; a < K; a++) for (let b = a + 1; b < K; b++) {
        if (!counts[a] || !counts[b]) continue;
        const ra = find(a), rb = find(b);
        if (ra === rb || labDist2(labColors, a, b) >= lim) continue;
        const keep = counts[ra] >= counts[rb] ? ra : rb, drop = keep === ra ? rb : ra;
        into[drop] = keep;
        if (!exactHex[keep] && exactHex[drop]) exactHex[keep] = exactHex[drop];
        merged = true;
      }
      if (merged) {
        for (let p = 0; p < N; p++) if (labels[p] >= 0) labels[p] = find(labels[p]);
        labColors = new Float64Array(K * 3); counts = new Float64Array(K);
        for (let p = 0; p < N; p++) {
          const L = labels[p];
          if (L < 0) continue;
          labColors[L * 3] += lab[p * 3]; labColors[L * 3 + 1] += lab[p * 3 + 1]; labColors[L * 3 + 2] += lab[p * 3 + 2];
          counts[L]++;
        }
        for (let L = 0; L < K; L++) if (counts[L]) for (let c = 0; c < 3; c++) labColors[L * 3 + c] /= counts[L];
      }
    }
    labels = cleanLabels(labels, w, h, labColors, Math.max(1, o.minArea), o.cleanEdges && o.mode !== 'bw', lab);
    if (o.mergeSoft && o.mode !== 'bw') labels = mergeSoftBorders(labels, lab, w, h, labColors, o.minArea);

    // Lab means of the cleaned labels, then per-pixel soft coverage
    // Background = the colour covering most of the image border. Its region that
    // is connected to the border becomes a label of its own, so it can be hidden
    // (transparent background) while same-coloured areas inside shapes stay.
    let bgRegion = -1;
    {
      const bc = new Float64Array(K);
      let total = 0;
      const tally = (p) => { total++; if (labels[p] >= 0) bc[labels[p]]++; };
      for (let x = 0; x < w; x++) { tally(x); tally((h - 1) * w + x); }
      for (let y = 1; y < h - 1; y++) { tally(y * w); tally(y * w + w - 1); }
      let bgLabel = -1;
      for (let L = 0; L < K; L++) if (bc[L] > total * 0.5 && (bgLabel < 0 || bc[L] > bc[bgLabel])) bgLabel = L;
      if (bgLabel >= 0) {
        bgRegion = K++;
        const stack = [];
        const seed = (p) => { if (labels[p] === bgLabel) { labels[p] = bgRegion; stack.push(p); } };
        for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
        for (let y = 1; y < h - 1; y++) { seed(y * w); seed(y * w + w - 1); }
        while (stack.length) {
          const p = stack.pop(), x = p % w, y = (p - x) / w;
          if (x > 0) seed(p - 1);
          if (x < w - 1) seed(p + 1);
          if (y > 0) seed(p - w);
          if (y < h - 1) seed(p + w);
        }
        // Thin rules (grid / divider lines some generators draw between icons)
        // become background; cells they had closed off rejoin the background.
        if (o.removeRules && removeRules(labels, w, h, bgRegion)) {
          for (let p = 0; p < N; p++) if (labels[p] === bgRegion) stack.push(p);
          while (stack.length) {
            const p = stack.pop(), x = p % w, y = (p - x) / w;
            if (x > 0) seed(p - 1);
            if (x < w - 1) seed(p + 1);
            if (y > 0) seed(p - w);
            if (y < h - 1) seed(p + w);
          }
        }
        // Holes: areas of the background colour enclosed by a shape (the
        // centre of a ring, a handle opening) are negative space, not fill.
        if (o.clearHoles) for (let p = 0; p < N; p++) if (labels[p] === bgLabel) labels[p] = bgRegion;
      } else if (hasTransparency) {
        // transparent background: rules simply become transparent
        if (o.removeRules) removeRules(labels, w, h, -1);
        // near-white areas are what is left of the old background inside shapes
        if (o.clearHoles) {
          const sum = new Float64Array(K * 4);
          for (let p = 0; p < N; p++) {
            const L = labels[p];
            if (L < 0) continue;
            sum[L * 4] += lab[p * 3]; sum[L * 4 + 1] += lab[p * 3 + 1]; sum[L * 4 + 2] += lab[p * 3 + 2]; sum[L * 4 + 3]++;
          }
          const hole = new Uint8Array(K);
          let any = false;
          for (let L = 0; L < K; L++) {
            const c = sum[L * 4 + 3];
            if (!c) continue;
            if (sum[L * 4] / c >= 97 && Math.hypot(sum[L * 4 + 1] / c, sum[L * 4 + 2] / c) <= 4) { hole[L] = 1; any = true; }
          }
          if (any) {
            bgRegion = K++;
            for (let p = 0; p < N; p++) if (labels[p] >= 0 && hole[labels[p]]) labels[p] = bgRegion;
          }
        }
      }
    }
    labColors = new Float64Array(K * 3); counts = new Float64Array(K);
    for (let p = 0; p < N; p++) {
      const L = labels[p];
      if (L < 0) continue;
      labColors[L * 3] += lab[p * 3]; labColors[L * 3 + 1] += lab[p * 3 + 1]; labColors[L * 3 + 2] += lab[p * 3 + 2];
      counts[L]++;
    }
    for (let L = 0; L < K; L++) if (counts[L]) for (let c = 0; c < 3; c++) labColors[L * 3 + c] /= counts[L];
    // colour of each label from its interior pixels (a blurred edge would pull it
    // towards its neighbours and move every sub-pixel edge)
    const coreColors = Float64Array.from(labColors), coreSum = new Float64Array(K * 3), coreCnt = new Float64Array(K);
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
      const p = y * w + x, L = labels[p];
      if (L < 0 || labels[p - 2] !== L || labels[p + 2] !== L || labels[p - 2 * w] !== L || labels[p + 2 * w] !== L ||
        labels[p - w - 1] !== L || labels[p + w + 1] !== L || labels[p - w + 1] !== L || labels[p + w - 1] !== L) continue;
      coreSum[L * 3] += lab[p * 3]; coreSum[L * 3 + 1] += lab[p * 3 + 1]; coreSum[L * 3 + 2] += lab[p * 3 + 2]; coreCnt[L]++;
    }
    for (let L = 0; L < K; L++) if (coreCnt[L] >= 4) for (let c = 0; c < 3; c++) coreColors[L * 3 + c] = coreSum[L * 3 + c] / coreCnt[L];
    const soft = softCoverage(labels, labSoft, rgba, w, h, coreColors);

    // Final colours = mean original RGB of each label; order layers by area (largest first).
    const rgbSum = new Float64Array(K * 3);
    const area = new Float64Array(K);
    const bbox = [];
    for (let L = 0; L < K; L++) bbox.push([w, h, -1, -1]);
    for (let p = 0; p < N; p++) {
      const L = labels[p];
      if (L < 0) continue;
      rgbSum[L * 3] += rgba[p * 4]; rgbSum[L * 3 + 1] += rgba[p * 4 + 1]; rgbSum[L * 3 + 2] += rgba[p * 4 + 2];
      area[L]++;
    }
    // The colour of a layer is the average of its interior pixels only: edge pixels
    // are blends with the neighbouring colours and would shift it.
    const inSum = new Float64Array(K * 3), inCnt = new Float64Array(K);
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
      const p = y * w + x, L = labels[p];
      if (L < 0) continue;
      let inner = true;
      for (let dy = -2; dy <= 2 && inner; dy++) for (let dx = -2; dx <= 2; dx++) if (labels[p + dy * w + dx] !== L) { inner = false; break; }
      if (!inner) continue;
      inSum[L * 3] += rgba[p * 4]; inSum[L * 3 + 1] += rgba[p * 4 + 1]; inSum[L * 3 + 2] += rgba[p * 4 + 2];
      inCnt[L]++;
    }
    const meanRGB = (L) => (inCnt[L] >= Math.max(4, area[L] * 0.05)
      ? [inSum[L * 3] / inCnt[L], inSum[L * 3 + 1] / inCnt[L], inSum[L * 3 + 2] / inCnt[L]]
      : [rgbSum[L * 3] / area[L], rgbSum[L * 3 + 1] / area[L], rgbSum[L * 3 + 2] / area[L]]);
    const order = [];
    for (let L = 0; L < K; L++) if (area[L]) order.push(L);
    order.sort((a, b) => area[b] - area[a]);
    // B&W: the light label is always the (invisible) bottom layer
    if (o.mode === 'bw' && order.includes(1)) { order.splice(order.indexOf(1), 1); order.unshift(1); }
    // the border background always sits at the very bottom
    if (bgRegion >= 0 && order.includes(bgRegion)) { order.splice(order.indexOf(bgRegion), 1); order.unshift(bgRegion); }
    // Stacking order like a designer's file: in a stack an edge between colours a
    // and b is traced by every layer between them, so the order that minimises
    // (shared edge length x rank distance) puts the outline colour on top and the
    // fills underneath it, with the fills' edges hidden under the outline.
    if (o.mode !== 'bw' && o.designOrder !== false && order.length > 3) {
      const idx = new Int32Array(K).fill(-1);
      order.forEach((L, i) => { idx[L] = i; });
      const m = order.length, E = new Float64Array(m * m);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const p = y * w + x, a = labels[p];
        if (a < 0) continue;
        if (x < w - 1) { const b = labels[p + 1]; if (b >= 0 && b !== a) { E[idx[a] * m + idx[b]]++; E[idx[b] * m + idx[a]]++; } }
        if (y < h - 1) { const b = labels[p + w]; if (b >= 0 && b !== a) { E[idx[a] * m + idx[b]]++; E[idx[b] * m + idx[a]]++; } }
      }
      const fixed = bgRegion >= 0 && order[0] === bgRegion ? 1 : 0;
      let pos = order.map((_, i) => i);   // pos[layer index] = rank
      const cost = () => { let c = 0; for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) c += E[i * m + j] * Math.abs(pos[i] - pos[j]); return c; };
      let best = cost();
      for (let pass = 0; pass < 20; pass++) {
        let improved = false;
        for (let i = fixed; i < m; i++) for (let t = fixed; t < m; t++) {
          if (t === pos[i]) continue;
          const from = pos[i], trial = pos.slice();
          for (let j = 0; j < m; j++) {
            if (j === i) continue;
            if (from < t && trial[j] > from && trial[j] <= t) trial[j]--;
            else if (from > t && trial[j] >= t && trial[j] < from) trial[j]++;
          }
          trial[i] = t;
          const saved = pos; pos = trial;
          const c = cost();
          if (c < best - 1e-9) { best = c; improved = true; } else pos = saved;
        }
        if (!improved) break;
      }
      const next = new Array(m);
      order.forEach((L, i) => { next[pos[i]] = L; });
      order.splice(0, m, ...next);
    }
    const rank = new Int32Array(K).fill(-1);
    order.forEach((L, i) => { rank[L] = i; });
    const rankMap = new Int32Array(N);
    for (let p = 0; p < N; p++) rankMap[p] = labels[p] < 0 ? -1 : rank[labels[p]];

    // Bounding box of each "union" mask (rank >= r) — computed from per-rank boxes, suffix-merged.
    const rb = order.map(() => [w, h, -1, -1]);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const r = rankMap[y * w + x];
      if (r < 0) continue;
      const b = rb[r];
      if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
    }
    for (let r = rb.length - 2; r >= 0; r--) {
      const b = rb[r], c = rb[r + 1];
      b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]); b[2] = Math.max(b[2], c[2]); b[3] = Math.max(b[3], c[3]);
    }

    // Stacking uses "effective" colours: a tiny fragment (a streak, a letter) counts as
    // the large colour around it, so no shape is extended under something that may
    // be dropped, and nothing is left uncovered if it is.
    const effRank = new Int32Array(N).fill(-1);
    {
      const RG = regions(labels, w, h), minBig = Math.max(150, o.minArea * 10);
      const queue = new Int32Array(N);
      let qh = 0, qt = 0;
      for (let p = 0; p < N; p++) {
        const c = RG.comp[p];
        if (c >= 0 && RG.area[c] >= minBig) { effRank[p] = rankMap[p]; queue[qt++] = p; }
        else if (c < 0) effRank[p] = -1;
        else effRank[p] = -2;   // small: to be filled from the nearest large colour
      }
      while (qh < qt) {
        const p = queue[qh++], x = p % w;
        const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w];
        for (const q of nb) if (q >= 0 && q < N && effRank[q] === -2) { effRank[q] = effRank[p]; queue[qt++] = q; }
      }
      for (let p = 0; p < N; p++) if (effRank[p] === -2) effRank[p] = rankMap[p];
    }
    const touches = (p, r) => {   // an 8-neighbour of p has rank r
      const x = p % w, y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w && rankMap[yy * w + xx] === r) return true;
        }
      }
      return false;
    };
    const kern = o.smooth >= 0.25 ? gaussianKernel(o.smooth) : null;
    const pad = kern ? kern.r + 1 : 1;
    const fitOpts = {
      tolerance: Math.max(0.1, o.tolerance),
      cornerAngle: (Math.max(10, Math.min(170, o.cornerAngle)) * Math.PI) / 180,
      cornerWindow: Math.max(1.5, 1.25 + 1.5 * (o.smooth || 0)),
      regularize: Math.max(0, o.regularize | 0),
      snapDeg: o.snapAxis ? 3 : 0,
      blurRound: 0.5 + 1.5 * (o.smooth || 0),
    };
    const minLoopArea = Math.max(1, o.minArea * 0.5);
    const layers = [];
    let background = null;

    for (let r = 0; r < order.length; r++) {
      const L = order[r];
      // snapExact: draw in the palette's exact hex; otherwise the image's real colour
      // (shades are merged either way)
      const color = o.mode === 'bw' ? '#000000' : exactHex[L] && o.snapExact !== false ? exactHex[L] : toHex(meanRGB(L));
      report(0.4 + (0.6 * r) / order.length, 'trace');
      if (o.mode === 'bw' && (L === 1 || L === bgRegion)) continue;
      if (L === bgRegion && o.removeBackground) continue;
      if (r === 0 && !hasTransparency) { background = color; continue; }

      const b = rb[r];
      const x0 = Math.max(0, b[0] - pad), y0 = Math.max(0, b[1] - pad);
      const x1 = Math.min(w, b[2] + 1 + pad), y1 = Math.min(h, b[3] + 1 + pad);
      const rw = x1 - x0, rh = y1 - y0;
      // Each edge drawn once, as in Illustrator. In a stack, an edge between colours
      // of rank a < b would be traced by every layer a+1..b, each fit slightly
      // different, and the visible edge would be their bumpy union. Layers below b
      // retreat a few pixels from colours ranked under them wherever the area is
      // anyway covered by a higher layer, so only the layer that owns the colour
      // draws that edge (and the file gets smaller).
      // How a designer stacks shapes: the part of this colour hidden under the layers
      // above reaches exactly to the middle between this colour and the colours below
      // it (the centre of the outline drawn on top). Hidden edges then sit in the
      // middle of the covering stroke, never as a second outline next to a visible
      // edge, and hidden areas enclosed by this colour are simply filled.
      const medial = o.medialStack !== false && r < order.length - 1;
      let cov = null;
      if (medial) {
        const INF = 1e9, dOwn = new Float32Array(rw * rh), dLow = new Float32Array(rw * rh);
        for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
          const k = effRank[(y + y0) * w + x + x0], i = y * rw + x;
          dOwn[i] = k === r ? 0 : INF;
          dLow[i] = k < r ? 0 : INF;
        }
        chamfer(dOwn, rw, rh);
        chamfer(dLow, rw, rh);
        cov = new Uint8Array(rw * rh);
        // 1: hidden part of this colour; 2: also within 2 px of it (a fragment on its
        // edge keeps the edge round)
        // the dividing line is smoothed (it is hidden, so it only needs to be simple)
        const diff = new Float32Array(rw * rh);
        for (let i = 0; i < rw * rh; i++) diff[i] = Math.max(-150, Math.min(150, dOwn[i] - dLow[i]));
        const sm = boxBlur3(diff, rw, rh, 6);
        for (let i = 0; i < rw * rh; i++) cov[i] = sm[i] <= 0 && dOwn[i] < INF ? 1 : dOwn[i] <= 6 ? 2 : 0;
      }
      let mask = new Float32Array(rw * rh);
      for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
        const p = (y + y0) * w + x + x0, i = y * rw + x;
        const A = soft.alt[p], f = soft.frac[p];
        const e = effRank[p];
        const inc = (k) => {
          if (k === r) return 1;
          if (k < r && k >= 0) return 0;
          if (!cov) return k > r ? 1 : 0;
          // covered, or a small fragment: decided by the colour it effectively sits in
          if (e === r) return 1;
          if (e > r) return cov[i] ? 1 : 0;
          return k > r && cov[i] === 2 ? 1 : 0;   // fragment of a colour above, on this edge
        };
        mask[i] = (rankMap[p] >= 0 ? inc(rankMap[p]) * f : 0) + (A >= 0 ? inc(rank[A]) * (1 - f) : 0);
      }
      if (kern) mask = blur(mask, rw, rh, kern);
      const PW = rw + 2, PH = rh + 2;
      const grid = new Float32Array(PW * PH);
      for (let y = 0; y < rh; y++) grid.set(mask.subarray(y * rw, y * rw + rw), (y + 1) * PW + 1);

      const loops = marchingSquares(grid, PW, PH, x0, y0);
      fitOpts.maskAt = (x, y) => {   // mask value at image point (x, y), bilinear
        const gx = x - x0 + 0.5, gy = y - y0 + 0.5, ix = Math.floor(gx), iy = Math.floor(gy);
        if (ix < 0 || iy < 0 || ix >= PW - 1 || iy >= PH - 1) return 0;
        const fx = gx - ix, fy = gy - iy, g = (i, j) => grid[j * PW + i];
        return (g(ix, iy) * (1 - fx) + g(ix + 1, iy) * fx) * (1 - fy) + (g(ix, iy + 1) * (1 - fx) + g(ix + 1, iy + 1) * fx) * fy;
      };
      if (o.debug) o.debug.push({ color, loops });
      const parts = [];
      for (const loop of loops) {
        if (Math.abs(polygonArea(loop)) < minLoopArea) continue;
        const d = segsToPath(fitLoop(loop, fitOpts), o.outScale);
        if (!d) continue;
        let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        for (const p of loop) {
          if (p[0] < bx0) bx0 = p[0]; if (p[0] > bx1) bx1 = p[0];
          if (p[1] < by0) by0 = p[1]; if (p[1] > by1) by1 = p[1];
        }
        const k = o.outScale;
        parts.push({ d, box: [bx0 * k, by0 * k, bx1 * k, by1 * k] });
      }
      if (parts.length) layers.push({ color, d: parts.map((q) => q.d).join(''), parts });
    }
    report(1, 'done');
    return { width: outW, height: outH, background, layers, objects: findObjects(labels, w, h, bgRegion, o.outScale) };
  }


  // Long, thin foreground structures (straight rules, grid lines, crosses of
  // grid lines) are relabelled as background. A shape counts as a rule when it
  // reaches the image edge or spans half of it, and its average thickness
  // (area / (width + height)) is only a few pixels.
  function removeRules(labels, w, h, bg) {
    const N = w * h, seen = new Uint8Array(N), stack = [], members = [];
    const tmax = Math.max(4, 0.008 * Math.max(w, h));
    let removed = 0;
    const fg = (p) => labels[p] >= 0 && labels[p] !== bg;
    for (let s = 0; s < N; s++) {
      if (seen[s] || !fg(s)) continue;
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      members.length = 0;
      seen[s] = 1; stack.push(s);
      while (stack.length) {
        const p = stack.pop(), x = p % w, y = (p - x) / w;
        members.push(p);
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const q = yy * w + xx;
            if (!seen[q] && fg(q)) { seen[q] = 1; stack.push(q); }
          }
        }
      }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      // a rule reaches the image edge or spans half of it; icons do neither
      const edge = x0 <= 1 || y0 <= 1 || x1 >= w - 2 || y1 >= h - 2;
      const long = bw >= 0.5 * w || bh >= 0.5 * h || (edge && (bw >= 0.25 * w || bh >= 0.25 * h));
      if (long && members.length / (bw + bh) <= tmax) {
        for (const p of members) labels[p] = bg;
        removed++;
      }
    }
    return removed;
  }

  // Separate objects (e.g. the icons of an icon sheet): connected regions that
  // are not background, with nearby pieces merged. Boxes are in output units,
  // sorted in reading order.
  function findObjects(labels, w, h, bgRegion, scale) {
    const N = w * h;
    const seen = new Uint8Array(N);
    const boxes = [];
    const stack = [];
    const isFg = (p) => labels[p] >= 0 && labels[p] !== bgRegion;
    for (let s = 0; s < N; s++) {
      if (seen[s] || !isFg(s)) continue;
      let x0 = w, y0 = h, x1 = -1, y1 = -1, area = 0;
      seen[s] = 1; stack.push(s);
      while (stack.length) {
        const p = stack.pop(), x = p % w, y = (p - x) / w;
        area++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const q = yy * w + xx;
            if (!seen[q] && isFg(q)) { seen[q] = 1; stack.push(q); }
          }
        }
      }
      boxes.push({ x0, y0, x1, y1, area });
    }
    // merge boxes closer than `gap` (parts of the same icon)
    const gap = Math.max(4, Math.round(Math.max(w, h) * 0.025));
    let merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i < boxes.length && !merged; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.x0 - gap <= b.x1 && b.x0 - gap <= a.x1 && a.y0 - gap <= b.y1 && b.y0 - gap <= a.y1) {
          a.x0 = Math.min(a.x0, b.x0); a.y0 = Math.min(a.y0, b.y0);
          a.x1 = Math.max(a.x1, b.x1); a.y1 = Math.max(a.y1, b.y1); a.area += b.area;
          boxes.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
    const minArea = N * 0.0005;
    const out = boxes.filter((b) => b.area >= minArea)
      .map((b) => ({ x: b.x0 * scale, y: b.y0 * scale, w: (b.x1 + 1 - b.x0) * scale, h: (b.y1 + 1 - b.y0) * scale }));
    if (out.length < 2) return [];
    // reading order: rows (by vertical overlap), then left to right
    out.sort((a, b) => a.y - b.y);
    const rows = [];
    for (const b of out) {
      const row = rows.find((r) => b.y < r.y1 && b.y + b.h > r.y0);
      if (row) { row.items.push(b); row.y1 = Math.max(row.y1, b.y + b.h); }
      else rows.push({ y0: b.y, y1: b.y + b.h, items: [b] });
    }
    return rows.flatMap((r) => r.items.sort((a, b) => a.x - b.x));
  }

  // Artboard size for stock sites: Adobe Stock recommends vectors of about 15 MP
  // (max 65 MP). The drawing is unchanged; only the declared width/height grow.
  function stockSize(W, H, mp) {
    const k = mp ? Math.max(1, Math.sqrt((mp * 1e6) / Math.max(1, W * H))) : 1;
    return [Math.round(W * k), Math.round(H * k)];
  }
  // Move every point of an absolute path (M/L/C pairs) by (dx, dy).
  function shiftPath(d, dx, dy) {
    if (!dx && !dy) return d;
    let i = 0;
    return d.replace(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi, (m) => fmt(+m + (i++ % 2 ? dy : dx)));
  }

  function toSVG(result, opts) {
    const o = Object.assign({ outline: false, colors: null, crop: null, padding: 0, minMP: 0 }, opts || {});
    let vx = 0, vy = 0, W = result.width, H = result.height;
    let keep = () => true;
    if (o.crop) {
      const c = o.crop, pad = o.padding;
      vx = c.x - pad; vy = c.y - pad; W = c.w + 2 * pad; H = c.h + 2 * pad;
      // a shape belongs to the object when its centre lies inside the object box
      keep = (q) => {
        const cx = (q.box[0] + q.box[2]) / 2, cy = (q.box[1] + q.box[3]) / 2;
        return cx >= c.x && cx <= c.x + c.w && cy >= c.y && cy <= c.y + c.h;
      };
    }
    const f = (v) => fmt(v);
    // a cropped object is moved so its artboard starts at (0,0), as stock sites expect
    const ox = vx, oy = vy;
    vx = 0; vy = 0;
    const vb = `0 0 ${f(W)} ${f(H)}`;
    const rect = `x="0" y="0" width="${f(W)}" height="${f(H)}"`;
    const pathsOf = (l) => shiftPath(o.crop ? (l.parts || []).filter(keep).map((q) => q.d).join('') : l.d, -ox, -oy);
    const [SW, SH] = stockSize(W, H, o.minMP);
    const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${SW}" height="${SH}">`];
    if (o.outline) {
      // like Illustrator's outline mode: 1px hairlines at any zoom, and the anchor
      // points (nodes) as small squares, so the drawing itself can be judged
      const hair = 'vector-effect="non-scaling-stroke"';
      parts.push(`<rect ${rect} fill="#fff"/>`);
      parts.push(`<g fill="none" stroke="#1a1a1a" stroke-width="1" stroke-linejoin="round">`);
      if (result.background) parts.push(`<rect ${rect} ${hair}/>`);
      const anchors = [];
      for (const l of result.layers) {
        const d = pathsOf(l);
        if (!d) continue;
        parts.push(`<path ${hair} d="${d}"/>`);
        if (o.anchors !== false) for (const m of d.matchAll(/[MLC]([^MLCZ]+)/g)) {
          const v = m[1].trim().split(/[\s,]+/);
          anchors.push(`M${v[v.length - 2]} ${v[v.length - 1]}h0`);
        }
      }
      parts.push('</g>');
      if (anchors.length) parts.push(`<path fill="none" stroke="#2f6bff" stroke-width="4" stroke-linecap="square" ${hair} d="${anchors.join('')}"/>`);
    } else {
      const col = (c) => (o.colors && o.colors[c]) || c;
      if (result.background) parts.push(`<rect ${rect} fill="${col(result.background)}"/>`);
      for (const l of result.layers) { const d = pathsOf(l); if (d) parts.push(`<path fill="${col(l.color)}" fill-rule="evenodd" d="${d}"/>`); }
    }
    parts.push('</svg>');
    return parts.join('\n');
  }

  const api = { vectorize, toSVG, stockSize, _internal: { marchingSquares, fitLoop, detectCorners, makeArc, symmetrizeLoop } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.VectorizerEngine = api;
})(typeof self !== 'undefined' ? self : globalThis);
