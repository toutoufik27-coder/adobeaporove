// Curve Fitting Engine: a stretch of outline (dense points between two nodes that
// must stay, with the tangents at those nodes) becomes the simplest segment kind
// that stays within tolerance: line, circular arc, quadratic, or cubic Bézier(s).
import { fitCubics, fitCircle, quadFromTangents, quadPoint, lineDeviation, distToPolyline, dist, sub, add, mul, cross, dot, norm, turnDeg } from './geom.js';
import { arcToCubics } from './pathdata.js';
import { bez } from './geom.js';

function maxDistTo(P, curvePts) { let m = 0; for (const q of P) { const d = distToPolyline(q, curvePts); if (d > m) m = d; } return m; }
function hausdorffPts(P, C) { let m = maxDistTo(P, C); for (const q of C) { const d = distToPolyline(q, P); if (d > m) m = d; } return m; }

// P: points (P[0] and P[P.length-1] are the fixed nodes); t1 leaves P[0], t2 points
// back from the last point. Returns { segs, kind, error } for the chosen fit.
export function fitStretch(P, t1, t2, tol, { allowArc = true, allowQuad = true, allowLine = true } = {}) {
  const a = P[0], b = P[P.length - 1];
  const closedLoop = dist(a, b) < 1e-9;
  if (allowLine && !closedLoop) {
    const dev = lineDeviation(P, a, b);
    if (dev <= tol) return { segs: [{ t: 'L', p: [a, b] }], kind: 'line', error: dev };
  }
  const cands = [];
  if (allowArc && !closedLoop && P.length >= 6) {
    const c = fitCircle(P);
    if (c && c.err <= tol && c.r < 1e6) {
      const ca = [c.cx, c.cy];
      if (Math.abs(dist(a, ca) - c.r) <= tol * 0.5 && Math.abs(dist(b, ca) - c.r) <= tol * 0.5) {
        const mid = P[Math.floor(P.length / 2)];
        const ang = (q) => Math.atan2(q[1] - c.cy, q[0] - c.cx);
        let sw = ang(b) - ang(a); const mm = ang(mid) - ang(a);
        const norm2 = (x) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        // direction: does the arc pass through mid going positive (sweep=1 in SVG y-down)?
        const pos = norm2(mm) < norm2(sw);
        const span = pos ? norm2(sw) : 2 * Math.PI - norm2(sw);
        const seg = { t: 'A', p: [a, b], a: { rx: c.r, ry: c.r, rot: 0, large: span > Math.PI ? 1 : 0, sweep: pos ? 1 : 0 } };
        const pts = arcToCubics(a, c.r, c.r, 0, seg.a.large, seg.a.sweep, b).flatMap((q) => [0, 0.25, 0.5, 0.75].map((t) => bez(q, t))).concat([b]);
        const err = hausdorffPts(P, pts);
        // the arc must leave / arrive along the original tangents (smooth joins stay smooth)
        const ta = norm(sub(pts[1], pts[0])), tb = norm(sub(pts[pts.length - 2], pts[pts.length - 1]));
        if (err <= tol && span > (15 * Math.PI) / 180 && turnDeg(ta, t1) < 8 && turnDeg(tb, t2) < 8) cands.push({ segs: [seg], kind: 'arc', error: err, cost: 1.2 });
      }
    }
  }
  if (allowQuad && !closedLoop) {
    const c = quadFromTangents(a, b, t1, t2);
    if (c) {
      const q = [a, c, b], pts = [];
      for (let i = 0; i <= 24; i++) pts.push(quadPoint(q, i / 24));
      const err = hausdorffPts(P, pts);
      if (err <= tol) cands.push({ segs: [{ t: 'Q', p: q }], kind: 'quadratic', error: err, cost: 1.1 });
    }
  }
  const cub = fitCubics(P, t1, t2, tol).map((p) => ({ t: 'C', p }));
  let cerr = 0;
  for (const s of cub) cerr = Math.max(cerr, 0);
  cands.push({ segs: cub, kind: cub.length === 1 ? 'cubic' : 'cubics', error: cerr, cost: cub.length * 1.5 });
  cands.sort((x, y) => x.cost - y.cost);
  return cands[0];
}
