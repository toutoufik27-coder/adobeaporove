// Path data: parse every command (M L H V C S Q T A Z, absolute and relative) into
// absolute native segments, and write segments back with a chosen precision.
// Segment: { t:'L', p:[p0,p1] } | { t:'Q', p:[p0,c,p1] } | { t:'C', p:[p0,c1,c2,p1] }
//          { t:'A', p:[p0,p1], a:{ rx, ry, rot, large, sweep } }
// Subpath: { segs, closed, start }

export function parsePath(d) {
  const errors = [], stats = { commands: 0, relative: 0, byType: {} };
  const tokens = [];
  const re = /\s*(?:([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)|(,)|(\S))/gy;
  let m;
  const src = d || '';
  while (re.lastIndex < src.length && (m = re.exec(src))) {
    if (m[1]) tokens.push(m[1]);
    else if (m[2]) tokens.push(+m[2]);
    else if (m[4]) { errors.push(`invalid character "${m[4]}" at ${m.index}`); break; }
  }
  const subs = [];
  let i = 0, cmd = null, cur = [0, 0], start = [0, 0], sub = null, lastC = null, lastQ = null;
  const isNum = () => typeof tokens[i] === 'number';
  const need = (k) => { for (let j = 0; j < k; j++) if (typeof tokens[i + j] !== 'number') return false; return true; };
  const open = () => { if (!sub) { sub = { segs: [], closed: false, start: cur }; subs.push(sub); } };
  const push = (s) => { open(); sub.segs.push(s); cur = s.p[s.p.length - 1]; };
  while (i < tokens.length) {
    if (typeof tokens[i] === 'string') { cmd = tokens[i++]; stats.commands++; stats.byType[cmd.toUpperCase()] = (stats.byType[cmd.toUpperCase()] || 0) + 1; if (cmd !== cmd.toUpperCase() && cmd !== 'z') stats.relative++; }
    else if (!cmd) { errors.push('path data does not start with a command'); break; }
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    const pt = (x, y) => rel ? [cur[0] + x, cur[1] + y] : [x, y];
    if (C === 'Z') {
      if (sub) {
        // a gap below floating-point noise (relative data accumulates ~1e-14) is not a segment
        const gap = Math.hypot(cur[0] - start[0], cur[1] - start[1]), eps = 1e-9 * Math.max(1, Math.abs(start[0]), Math.abs(start[1]));
        if (gap > eps) sub.segs.push({ t: 'L', p: [cur, start], implicit: true });
        else if (gap > 0 && sub.segs.length) { const last = sub.segs[sub.segs.length - 1]; last.p[last.p.length - 1] = start; }
        sub.closed = true;
      }
      cur = start; sub = null; lastC = lastQ = null;
      if (isNum()) { errors.push('numbers after Z'); break; }
      continue;
    }
    const arity = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 }[C];
    if (!need(arity)) { errors.push(`command ${cmd} is missing numbers`); break; }
    if (C === 'M') {
      cur = pt(tokens[i], tokens[i + 1]); i += 2; start = cur; sub = null; open();
      cmd = rel ? 'l' : 'L'; lastC = lastQ = null; continue;
    }
    if (C === 'L') { push({ t: 'L', p: [cur, pt(tokens[i], tokens[i + 1])] }); i += 2; lastC = lastQ = null; }
    else if (C === 'H') { const x = tokens[i++]; push({ t: 'L', p: [cur, [rel ? cur[0] + x : x, cur[1]]] }); lastC = lastQ = null; }
    else if (C === 'V') { const y = tokens[i++]; push({ t: 'L', p: [cur, [cur[0], rel ? cur[1] + y : y]] }); lastC = lastQ = null; }
    else if (C === 'C') { const c1 = pt(tokens[i], tokens[i + 1]), c2 = pt(tokens[i + 2], tokens[i + 3]), q = pt(tokens[i + 4], tokens[i + 5]); i += 6; push({ t: 'C', p: [cur, c1, c2, q] }); lastC = c2; lastQ = null; }
    else if (C === 'S') {
      const c1 = lastC ? [2 * cur[0] - lastC[0], 2 * cur[1] - lastC[1]] : cur;
      const c2 = pt(tokens[i], tokens[i + 1]), q = pt(tokens[i + 2], tokens[i + 3]); i += 4;
      push({ t: 'C', p: [cur, c1, c2, q] }); lastC = c2; lastQ = null;
    } else if (C === 'Q') { const c = pt(tokens[i], tokens[i + 1]), q = pt(tokens[i + 2], tokens[i + 3]); i += 4; push({ t: 'Q', p: [cur, c, q] }); lastQ = c; lastC = null; }
    else if (C === 'T') {
      const c = lastQ ? [2 * cur[0] - lastQ[0], 2 * cur[1] - lastQ[1]] : cur, q = pt(tokens[i], tokens[i + 1]); i += 2;
      push({ t: 'Q', p: [cur, c, q] }); lastQ = c; lastC = null;
    } else if (C === 'A') {
      const [rx, ry, rot, large, sweep] = tokens.slice(i, i + 5), q = pt(tokens[i + 5], tokens[i + 6]); i += 7;
      if ((large !== 0 && large !== 1) || (sweep !== 0 && sweep !== 1)) errors.push('arc flags must be 0 or 1');
      if (!rx || !ry) push({ t: 'L', p: [cur, q] });
      else push({ t: 'A', p: [cur, q], a: { rx: Math.abs(rx), ry: Math.abs(ry), rot, large: large ? 1 : 0, sweep: sweep ? 1 : 0 } });
      lastC = lastQ = null;
    }
  }
  for (const s of subs) if (!s.closed && s.segs.length) {
    const a = s.segs[0].p[0], z = s.segs[s.segs.length - 1].p.at(-1);
    s.endsAtStart = Math.hypot(a[0] - z[0], a[1] - z[1]) < 1e-9;
  }
  return { subpaths: subs, errors, stats };
}

// ---- conversions to lines / cubics (for measuring and rendering)
const cache = new WeakMap();
export function toCubics(s) {
  if (s.t === 'L' || s.t === 'C') return [s];
  let r = cache.get(s);
  if (r) return r;
  if (s.t === 'Q') { const [p0, c, p1] = s.p; r = [{ t: 'C', p: [p0, [p0[0] + (2 / 3) * (c[0] - p0[0]), p0[1] + (2 / 3) * (c[1] - p0[1])], [p1[0] + (2 / 3) * (c[0] - p1[0]), p1[1] + (2 / 3) * (c[1] - p1[1])], p1] }]; }
  else r = arcToCubics(s.p[0], s.a.rx, s.a.ry, s.a.rot, s.a.large, s.a.sweep, s.p[1]).map((b) => ({ t: 'C', p: b }));
  cache.set(s, r);
  return r;
}
export const expand = (segs) => segs.flatMap(toCubics);

export function arcCenter(p0, rx, ry, phiDeg, large, sweep, p1) {
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = (phiDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2, dy = (p0[1] - p1[1]) / 2;
  const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const sign = large === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const co = sign * Math.sqrt(Math.max(0, num / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
  const cx1 = (co * rx * y1) / ry, cy1 = (-co * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (p0[0] + p1[0]) / 2, cy = sin * cx1 + cos * cy1 + (p0[1] + p1[1]) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI; else if (sweep && dt < 0) dt += 2 * Math.PI;
  return { cx, cy, rx, ry, phi, t1, dt };
}
export function arcToCubics(p0, rx, ry, phiDeg, large, sweep, p1) {
  if (!rx || !ry || (p0[0] === p1[0] && p0[1] === p1[1])) return [[p0, p0, p1, p1]];
  const { cx, cy, rx: RX, ry: RY, phi, t1, dt } = arcCenter(p0, rx, ry, phiDeg, large, sweep, p1);
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9)), d = dt / n, k = (4 / 3) * Math.tan(d / 4);
  const P = (t) => [cx + RX * Math.cos(t) * cos - RY * Math.sin(t) * sin, cy + RX * Math.cos(t) * sin + RY * Math.sin(t) * cos];
  const D = (t) => [-RX * Math.sin(t) * cos - RY * Math.cos(t) * sin, -RX * Math.sin(t) * sin + RY * Math.cos(t) * cos];
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = t1 + i * d, b = a + d, pa = i ? P(a) : p0, pb = i === n - 1 ? p1 : P(b), da = D(a), db = D(b);
    out.push([pa, [pa[0] + k * da[0], pa[1] + k * da[1]], [pb[0] - k * db[0], pb[1] - k * db[1]], pb]);
  }
  return out;
}

// ---- writing
export function numFormatter(digits, minify) {
  return (v) => {
    let s = (+v.toFixed(digits)).toString();
    if (s === '-0') s = '0';
    if (s.includes('e')) s = (+v).toFixed(digits).replace(/\.?0+$/, '');
    if (minify) s = s.replace(/^(-?)0\./, '$1.');
    return s;
  };
}
// join numbers with the fewest separators (minify) or single spaces
function joinNums(nums, minify) {
  if (!minify) return nums.join(' ');
  let out = '';
  for (const s of nums) {
    if (!out) { out = s; continue; }
    const needSep = !(s[0] === '-' || (s[0] === '.' && /[.eE]\d*$/.test(out.split(/[ -]/).pop()) && out.split(/[ -]/).pop().includes('.')));
    out += needSep ? ' ' + s : s;
  }
  return out;
}

// Subpaths -> path data. Absolute or relative is chosen per command (the shorter),
// using the rounded current point so relative values add up exactly.
export function writePath(subpaths, digits = 2, { minify = false, relative = true } = {}) {
  const f = numFormatter(digits, minify);
  const R = (v) => +(+v).toFixed(digits);
  let d = '', cur = [0, 0], last = '';
  const emit = (letter, abs, relv) => {
    let best = null;
    for (const [L, nums] of [[letter, abs], relative ? [letter.toLowerCase(), relv] : null]) {
      if (!nums) continue;
      const body = joinNums(nums.map(f), minify);
      const s = (L === last && minify ? (body[0] === '-' ? '' : ' ') : L) + body;
      if (!best || s.length < best.s.length) best = { s, L };
    }
    d += (d && !minify && best.s[0] !== ' ' && best.L !== last ? '' : '') + best.s;
    last = best.L;
  };
  for (const sp of subpaths) {
    const segs = sp.segs;
    const st = segs.length ? segs[0].p[0] : sp.start;
    if (!st) continue;
    const s0 = [R(st[0]), R(st[1])];
    emit('M', s0, [s0[0] - cur[0], s0[1] - cur[1]]);
    last = 'M'; cur = s0;
    const startPt = s0;
    const n = segs.length;
    for (let i = 0; i < n; i++) {
      const s = segs[i], e = s.p[s.p.length - 1], E = [R(e[0]), R(e[1])];
      if (sp.closed && i === n - 1 && s.t === 'L' && E[0] === startPt[0] && E[1] === startPt[1]) break;   // Z draws it
      const rl = (q) => [R(q[0]) - cur[0], R(q[1]) - cur[1]];
      const fix = (arr) => arr.map((v) => +v.toFixed(digits));
      if (s.t === 'L') {
        if (E[1] === cur[1] && E[0] !== cur[0]) emit('H', [E[0]], fix([E[0] - cur[0]]));
        else if (E[0] === cur[0] && E[1] !== cur[1]) emit('V', [E[1]], fix([E[1] - cur[1]]));
        else if (E[0] === cur[0] && E[1] === cur[1]) { continue; }
        else emit('L', E, fix(rl(e)));
      } else if (s.t === 'C') emit('C', [R(s.p[1][0]), R(s.p[1][1]), R(s.p[2][0]), R(s.p[2][1]), ...E], fix([...rl(s.p[1]), ...rl(s.p[2]), ...rl(e)]));
      else if (s.t === 'Q') emit('Q', [R(s.p[1][0]), R(s.p[1][1]), ...E], fix([...rl(s.p[1]), ...rl(e)]));
      else if (s.t === 'A') { const a = s.a, h = [R(a.rx), R(a.ry), R(a.rot), a.large, a.sweep]; emit('A', [...h, ...E], [...h, ...fix(rl(e))]); }
      cur = E;
    }
    if (sp.closed) { d += minify ? 'z' : 'Z'; last = 'Z'; cur = startPt; }
  }
  return d;
}

// Rounds coordinates the way writePath does (to measure precision loss).
export function roundSubpaths(subpaths, digits) {
  const R = (v) => +(+v).toFixed(digits);
  return subpaths.map((sp) => ({ ...sp, start: sp.start && [R(sp.start[0]), R(sp.start[1])], segs: sp.segs.map((s) => ({ ...s, p: s.p.map((q) => [R(q[0]), R(q[1])]), a: s.a && { ...s.a, rx: R(s.a.rx), ry: R(s.a.ry), rot: R(s.a.rot) } })) }));
}
