// Byte-bounded LRU cache for reference crops (Float32 RGB + Lab buffers).
// The limit is in bytes, not entries: one crop can be 8 MB and another 8 KB, so an
// entry count says nothing about memory. The least recently used entries are evicted
// one by one until the new entry fits; an entry larger than the whole budget is not
// cached at all (it is simply recomputed when needed).
export const MAX_CACHE_BYTES = 48 * 1024 * 1024;

const sizeOf = (v) => {
  let n = 0;
  for (const x of Object.values(v)) if (x && typeof x.byteLength === 'number') n += x.byteLength;
  return n;
};

export class ByteLRU {
  constructor(maxBytes = MAX_CACHE_BYTES) {
    this.max = maxBytes; this.map = new Map(); this.bytes = 0;
    this.stats = { hits: 0, misses: 0, evictions: 0, uncached: 0, peakBytes: 0, peakEntries: 0 };
  }
  get size() { return this.map.size; }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) { this.stats.misses++; return undefined; }
    this.stats.hits++;
    this.map.delete(key); this.map.set(key, hit);          // most recently used last
    return hit.value;
  }
  set(key, value) {
    const bytes = sizeOf(value);
    if (this.map.has(key)) { this.bytes -= this.map.get(key).bytes; this.map.delete(key); }
    if (bytes > this.max) { this.stats.uncached++; return value; }
    while (this.bytes + bytes > this.max && this.map.size) {
      const [k, old] = this.map.entries().next().value;
      this.map.delete(k); this.bytes -= old.bytes; this.stats.evictions++;
    }
    this.map.set(key, { value, bytes });
    this.bytes += bytes;
    if (this.bytes > this.stats.peakBytes) this.stats.peakBytes = this.bytes;
    if (this.map.size > this.stats.peakEntries) this.stats.peakEntries = this.map.size;
    return value;
  }
  clear() { this.map.clear(); this.bytes = 0; }
}
