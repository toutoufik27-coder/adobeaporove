// Memory probe (Node only; a no-op in the browser worker): the peak heapUsed, RSS,
// arrayBuffers and external memory seen at the points where the engine holds the most
// buffers (region check with its three renders, global check, final validation), and
// where each peak happened.
const usage = typeof process !== 'undefined' && process && typeof process.memoryUsage === 'function' ? () => process.memoryUsage() : null;
const KEYS = ['rss', 'heapUsed', 'arrayBuffers', 'external'];
export function probe(ctx, where) {
  if (!usage || !ctx) return;
  const m = usage(), mem = (ctx.mem ||= { peak: { rss: 0, heapUsed: 0, arrayBuffers: 0, external: 0 }, at: {}, samples: 0 });
  mem.samples++;
  for (const k of KEYS) if (m[k] > mem.peak[k]) { mem.peak[k] = m[k]; mem.at[k] = where; }
}
