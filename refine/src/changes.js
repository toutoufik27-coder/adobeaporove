// What the engine actually changed, split into REPAIR and OPTIMIZATION.
//
// OPTIMIZATION makes the file smaller or simpler without correcting anything: node
// reduction, path normalization, precision reduction, redundant command removal.
// REPAIR corrects the geometry: geometry correction, broken continuity, malformed
// geometry, accidental artifacts, primitive reconstruction, topology repair.
// A smaller file is never evidence of a repair.
//
// Counting follows the result, not the attempts: every accepted change is kept per
// unit (an element, or one contour "idx:sub"); a later rollback of that unit (topology
// or visual validation, the final gate) removes its changes; and only units whose final
// geometry differs from the original are counted.

export const REPAIR = 'repair', OPTIMIZATION = 'optimization';
// op -> [class, type]
const OPS = {
  'empty element': [OPTIMIZATION, 'redundant element removal'],
  'invisible element': [OPTIMIZATION, 'redundant element removal'],
  'hidden element': [OPTIMIZATION, 'redundant element removal'],
  'hidden contours': [OPTIMIZATION, 'redundant command removal'],
  'zero-length segment': [OPTIMIZATION, 'redundant command removal'],
  'near-duplicate point': [OPTIMIZATION, 'node reduction'],
  'collinear points': [OPTIMIZATION, 'node reduction'],
  'curve reconstruction': [OPTIMIZATION, 'node reduction'],
  'merge paths': [OPTIMIZATION, 'path normalization'],
  'flatten transform': [OPTIMIZATION, 'path normalization'],
  precision: [OPTIMIZATION, 'precision reduction'],
  'micro-segment': [OPTIMIZATION, 'node reduction'],
  'degenerate contour': [REPAIR, 'malformed geometry'],
  'close open contour': [REPAIR, 'broken continuity'],
  'join broken stroke': [REPAIR, 'broken continuity'],
  'tiny artifact': [REPAIR, 'accidental artifacts'],
  'duplicate geometry': [REPAIR, 'accidental artifacts'],
  'self-intersection loop': [REPAIR, 'topology repair'],
  'kink repair': [REPAIR, 'geometry correction'],
  'symmetry correction': [REPAIR, 'geometry correction'],
  'restore outline': [REPAIR, 'geometry correction'],
  'set count': [REPAIR, 'geometry correction'],
  'even spacing': [REPAIR, 'geometry correction'],
};
export function classify(op) {
  if (OPS[op]) return OPS[op];
  if (/ reconstruction$/.test(op)) return [REPAIR, 'primitive reconstruction'];
  return [OPTIMIZATION, 'other'];
}

const unitOf = (el, sub) => (sub == null ? String(el) : `${el}:${sub}`);
// entry.supersedes: the change was built from the original contour and replaces it
// whole (a primitive reconstruction), so earlier changes of that unit are gone
export function noteChange(ctx, entry) {
  const u = unitOf(entry.el, entry.sub), m = (ctx.changes ||= new Map());
  if (!m.has(u) || entry.supersedes) m.set(u, []);
  m.get(u).push({ op: entry.op, cls: entry.cls || classify(entry.op), pass: entry.pass });
}
// A rollback of a unit: an element rollback drops its contour units too.
export function dropChanges(ctx, el, sub = null) {
  const m = ctx.changes;
  if (!m) return 0;
  let n = 0;
  for (const [u, list] of [...m]) {
    const [a, b] = u.split(':');
    if (+a !== el || (sub != null && b != null && +b !== sub)) continue;
    if (sub != null && b == null) continue;           // a contour rollback keeps element-level changes
    n += list.length; m.delete(u);
  }
  ctx.rolledBackCandidates = (ctx.rolledBackCandidates || 0) + n;
  return n;
}

// Summary of the changes present in a state (history state array). Exact for the Final
// stage; for an earlier stage it also counts later changes of the units that differ there.
export function summarize(ctx, state) {
  const { doc } = ctx, out = { repairs: { total: 0, byType: {} }, optimizations: { total: 0, byType: {} } };
  const same = (a, b) => a === b || (a.length === b.length && a.every((sp, i) => sp === b[i]));
  for (const [u, list] of ctx.changes || []) {
    const [a, b] = u.split(':').map((x) => (x == null ? null : +x));
    const e = doc.elements[a], st = state[a];
    if (!e || !st) continue;
    const changedEl = st.removed || !same(st.subpaths, e.orig) || !!st.flat || st.digits !== undefined;
    if (!changedEl) continue;
    // a contour unit counts when that contour differs (contour lists of equal length)
    if (b != null && !st.removed && st.subpaths.length === e.orig.length && st.subpaths[b] === e.orig[b]) continue;
    for (const c of list) {
      const bucket = c.cls[0] === REPAIR ? out.repairs : out.optimizations;
      bucket.total++; bucket.byType[c.cls[1]] = (bucket.byType[c.cls[1]] || 0) + 1;
    }
  }
  out.rejected = ctx.rejectedCount;
  out.rolledBack = ctx.rolledBackCandidates || 0;
  return out;
}
