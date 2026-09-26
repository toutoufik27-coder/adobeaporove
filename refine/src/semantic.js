// Semantic correction: the engine measures structure exactly (groups of repeated
// marks, their count and spacing); a local vision model says what the object is and
// what count it should have; the engine then rebuilds the group geometrically from
// its own marks (same shape, colour and layer), and verifies that nothing else moved.
import { findGroups, norm360 } from './structure.js';
import { apply, invert, mult } from './matrix.js';
import { render } from './raster.js';
import { compare, labImage } from './metrics.js';
import { makeView } from './raster.js';
import { deepCopy } from './model.js';

// Groups worth asking about, with a plain description (positions in % of the icon).
export function detectGroups(doc, u) {
  const [vx, vy, vw, vh] = doc.viewBox;
  const P = (x, y) => `(${Math.round(((x - vx) / vw) * 100)}%, ${Math.round(((y - vy) / vh) * 100)}%)`;
  const groups = findGroups(doc, u).filter((g) => (g.kind === 'radial' && g.gapCV < 0.6 && g.members.length >= 4) || (g.kind === 'row' && g.members.length >= 3));
  // the same marks drawn in two layers (a solid mark + the hole above it) are one group
  const linked = new Set();
  for (const g of groups) for (const h of groups) {
    if (g === h || g.el === h.el || h.members.length !== g.members.length || linked.has(h)) continue;
    const tol = 0.4 * Math.max(...g.members.map((m) => m.size));
    if (g.members.every((m) => h.members.some((k) => Math.hypot(k.cx - m.cx, k.cy - m.cy) < tol))) { (g.links ||= []).push(h); linked.add(h); }
  }
  return groups.filter((g) => !linked.has(g)).map((g, i) => ({
    ...g, id: i + 1,
    text: g.kind === 'radial'
      ? `Group ${i + 1}: ${g.members.length} similar marks arranged in a circle around ${P(...g.center)}, radius ${Math.round((g.radius / Math.max(vw, vh)) * 100)}% of the icon; spacing is ${g.gapCV < 0.04 ? 'regular' : g.gapCV < 0.15 ? 'slightly irregular' : 'irregular'}.`
      : `Group ${i + 1}: ${g.members.length} similar marks in a row from ${P(g.members[0].cx, g.members[0].cy)} to ${P(g.members.at(-1).cx, g.members.at(-1).cy)}; spacing is ${g.gapCV < 0.04 ? 'regular' : 'irregular'}.`,
  }));
}

export function buildPrompt(groups) {
  return [
    'You check a flat vector icon for drawing mistakes made by an AI image generator (wrong number of repeated parts, e.g. a clock with 14 hour marks).',
    'The engine measured the repeated parts exactly. Trust these counts, do not recount:',
    ...groups.map((g) => g.text),
    'For every group say what the marks are and, only if the real object has a fixed conventional number of them (clock hour marks: 12, snowflake arms: 6, days of a week: 7 ...), that number. If any count is acceptable (decorative dots, buttons, stripes, lights), use null.',
    'Reply with JSON only: {"object": "what the icon shows", "groups": [{"id": 1, "meaning": "what the marks are", "expected_count": 12 or null, "confidence": 0.0-1.0}]}',
  ].join('\n');
}

// Proposals from the measurements and the model's answer (answer may be null: then
// only purely geometric proposals — even spacing — are made).
export function proposals(groups, answer) {
  const out = [];
  const byId = new Map(((answer && answer.groups) || []).map((a) => [+a.id, a]));
  for (const g of groups) {
    const a = byId.get(g.id), n = g.members.length;
    const want = a && Number.isInteger(+a.expected_count) && +a.expected_count > 1 ? +a.expected_count : null;
    if (want && want !== n && g.kind === 'radial' && want <= 64) {
      out.push({ group: g.id, op: 'count', from: n, to: want, confidence: +(a.confidence ?? 0.7), reason: `${answer.object || 'object'}: ${a.meaning || 'marks'} should be ${want}, found ${n}` , source: 'model' });
    } else if (g.kind === 'radial' && g.gapCV >= 0.03 && g.gapCV < 0.3) {
      out.push({ group: g.id, op: 'even', from: n, to: n, confidence: 0.9, reason: `${n} marks on a circle with uneven spacing (variation ${(g.gapCV * 100).toFixed(0)}%)`, source: 'geometry' });
    }
  }
  return out;
}

// Rebuild a ring with `count` marks, evenly spaced, from its own prototype marks.
export function applyRing(doc, g, count, u) {
  const touched = [];
  if ([g, ...(g.links || [])].some((grp) => doc.elements[grp.el].locked)) return touched;   // protected: never rebuilt
  for (const grp of [g, ...(g.links || [])]) {
    const e = doc.elements[grp.el];
    const inv = invert(e.ctm) || [1, 0, 0, 1, 0, 0];
    const members = grp.members;
    const step = 360 / count;
    // phase: keep a mark at the top when there is one near it, else start at the top
    const top = members.reduce((b, m) => (Math.min(m.angle, 360 - m.angle) < Math.min(b.angle, 360 - b.angle) ? m : b));
    const phase = Math.min(top.angle, 360 - top.angle) < step / 2 ? (top.angle > 180 ? top.angle - 360 : top.angle) : 0;
    const types = new Map();
    for (const m of members) { const t = m.type ?? 0; (types.get(t) || types.set(t, []).get(t)).push(m); }
    const majority = [...types.entries()].sort((a, b) => b[1].length - a[1].length)[0][0];
    const R = grp.radius, C = grp.center;
    const proto = (t) => { const list = [...types.get(t)].sort((a, b) => a.area - b.area); return list[Math.floor(list.length / 2)]; };
    const newSubs = [];
    for (let k = 0; k < count; k++) {
      const ang = phase + k * step;
      // a rarer kind of mark (e.g. long ticks at the quarters) keeps its places
      let t = majority;
      for (const [tt, list] of types) if (tt !== majority && list.some((m) => Math.abs(((m.angle - ang + 540) % 360) - 180) < step / 3)) t = tt;
      const p = proto(t);
      const rot = ang - p.angle, r = (rot * Math.PI) / 180;
      // rotate about the ring centre, then move the mark onto the mean radius
      const pr = Math.hypot(p.cx - C[0], p.cy - C[1]) || 1;
      const ux = Math.sin((ang * Math.PI) / 180), uy = -Math.cos((ang * Math.PI) / 180);
      const M = mult([1, 0, 0, 1, ux * (R - pr), uy * (R - pr)], mult([1, 0, 0, 1, C[0], C[1]], mult([Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0], [1, 0, 0, 1, -C[0], -C[1]])));
      const L = mult(inv, mult(M, e.ctm));             // in the element's own coordinates
      const src = e.subpaths[p.sub];
      newSubs.push(transformSub(src, L, rot));
    }
    const drop = new Set(members.map((m) => m.sub));
    e.subpaths = [...e.subpaths.filter((s, i) => !drop.has(i)), ...newSubs];
    touched.push(e.idx);
  }
  return touched;
}
function transformSub(sp, m, rotDeg) {
  const f = (q) => apply(m, q);
  return { closed: sp.closed, start: sp.start && f(sp.start), segs: sp.segs.map((g) => ({ t: g.t, p: g.p.map(f), ...(g.a ? { a: { ...g.a, rot: g.a.rot + rotDeg } } : {}) })) };
}

// An intended change: everything outside the group's ring must stay identical, and the
// new marks must look like the old ones.
export function verifyRing(doc, before, g, u) {
  const view = makeView(doc.viewBox, 600);
  const cur = render(doc, view, { geom: (x) => (x.removed ? null : x.subpaths) });
  const old = render(doc, view, { geom: (x) => (before[x.idx].removed ? null : before[x.idx].subpaths) });
  const c = compare(old, cur, view, { radius: 1 });
  const maxMark = Math.max(...g.members.map((m) => m.size));
  const inner = g.radius - maxMark * 1.2, outer = g.radius + maxMark * 1.2;
  let outside = 0;
  for (let y = 0; y < view.H; y++) for (let x = 0; x < view.W; x++) {
    const p = y * view.W + x;
    if (c.diff[p] <= 10) continue;
    const X = view.x + (x + 0.5) / view.k, Y = view.y + (y + 0.5) / view.k, d = Math.hypot(X - g.center[0], Y - g.center[1]);
    if (d < inner || d > outer) outside++;
  }
  return { ok: outside <= 3, outside, changed: c.badPixels };
}
export { deepCopy };
