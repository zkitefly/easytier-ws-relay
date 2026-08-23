// ============================================================
// Module 3: Multi-Level Cache (智能缓存机制)
//
// Design Goals:
//   - L1: Per-instance in-memory cache with tiny TTL for hot paths
//         (connBitmap encoding, peerInfo digests, RPC snapshot).
//   - L2: Signature-based invalidation so we skip re-encoding
//         whenever inputs haven't changed (the biggest win).
//   - Expose invalidate() for explicit mutation sites.
//
// Biggest wins in this codebase:
//   1. pushRouteUpdateTo(): re-encodes peerInfos + connBitmap
//      every call. Cache the encoded buffer keyed by version
//      vector + connBitmap signature.
//   2. GetGlobalPeerMap: digest-based 304-style response already
//      exists; we add an LRU of encoded snapshots for different
//      peer sets.
// ============================================================

const DEFAULT_L1_MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const DEFAULT_L1_TTL_MS = 2000;               // 2 s
const DEFAULT_L2_MAX_ENTRIES = 200;
const DEFAULT_L2_TTL_MS = 15 * 1000;          // 15 s

class LruCache {
  constructor(maxEntries, maxBytes = Infinity) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.map = new Map(); // key -> { value, bytes, atime }
    this.bytes = 0;
  }

  set(key, value, bytes = 0, ttlMs = Infinity) {
    const expireAt = ttlMs === Infinity ? Infinity : Date.now() + ttlMs;
    if (this.map.has(key)) {
      const prev = this.map.get(key);
      this.bytes -= prev.bytes | 0;
    }
    const entry = { value, bytes: bytes | 0, expireAt, atime: Date.now() };
    this.map.set(key, entry);
    this.bytes += entry.bytes;
    this._evict();
    return value;
  }

  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expireAt) {
      this.map.delete(key);
      this.bytes -= e.bytes | 0;
      return undefined;
    }
    e.atime = Date.now();
    // Move to end (Map preserves insertion order)
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  invalidate(prefix) {
    if (!prefix) {
      this.map.clear();
      this.bytes = 0;
      return;
    }
    for (const k of Array.from(this.map.keys())) {
      if (String(k).startsWith(prefix)) {
        const e = this.map.get(k);
        this.map.delete(k);
        this.bytes -= e ? (e.bytes | 0) : 0;
      }
    }
  }

  size() { return this.map.size; }
  usedBytes() { return this.bytes; }

  _evict() {
    // First expire TTL entries
    const now = Date.now();
    for (const [k, e] of Array.from(this.map.entries())) {
      if (now > e.expireAt) {
        this.map.delete(k);
        this.bytes -= e.bytes | 0;
      }
    }
    // Next enforce size (LRU: Map keys are in insertion order; drop oldest)
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const it = this.map.keys().next();
      if (it.done) break;
      const k = it.value;
      const e = this.map.get(k);
      this.map.delete(k);
      this.bytes -= e ? (e.bytes | 0) : 0;
    }
  }
}

export class MultiLevelCache {
  constructor(options = {}) {
    this.l1 = new LruCache(
      options.l1MaxEntries ?? 512,
      options.l1MaxBytes ?? DEFAULT_L1_MAX_BYTES
    );
    this.l2 = new LruCache(
      options.l2MaxEntries ?? DEFAULT_L2_MAX_ENTRIES,
      Infinity
    );
    this.l1Ttl = options.l1TtlMs ?? DEFAULT_L1_TTL_MS;
    this.l2Ttl = options.l2TtlMs ?? DEFAULT_L2_TTL_MS;

    // Hits / misses counters
    this.stats = { l1Hit: 0, l1Miss: 0, l2Hit: 0, l2Miss: 0 };
  }

  // ---------------- public helpers ----------------
  snapshotStats() {
    return {
      ...this.stats,
      l1Size: this.l1.size(),
      l1Bytes: this.l1.usedBytes(),
      l2Size: this.l2.size(),
    };
  }

  resetStats() {
    this.stats = { l1Hit: 0, l1Miss: 0, l2Hit: 0, l2Miss: 0 };
  }

  /**
   * Two-level lookup with compute-on-miss.
   * Tags support easy invalidation by prefix.
   */
  async getOrCompute(key, computeFn, opts = {}) {
    const tagPrefix = opts.tag ? `${opts.tag}:` : '';
    const fullKey = `${tagPrefix}${key}`;
    const ttl = opts.ttlMs != null ? opts.ttlMs : (opts.level === 2 ? this.l2Ttl : this.l1Ttl);
    const bytes = opts.bytes | 0;

    const l1Val = this.l1.get(fullKey);
    if (l1Val !== undefined) { this.stats.l1Hit++; return l1Val; }
    this.stats.l1Miss++;

    if (opts.level !== 1) {
      const l2Val = this.l2.get(fullKey);
      if (l2Val !== undefined) {
        this.stats.l2Hit++;
        // promote to L1
        this.l1.set(fullKey, l2Val, bytes, this.l1Ttl);
        return l2Val;
      }
      this.stats.l2Miss++;
    }

    const value = await computeFn();
    // Write L1 always, L2 only if level !== 1
    this.l1.set(fullKey, value, bytes, this.l1Ttl);
    if (opts.level !== 1) this.l2.set(fullKey, value, bytes, ttl);
    return value;
  }

  /** Sync version for encode/decode hot paths (no async compute). */
  getOrComputeSync(key, computeFn, opts = {}) {
    const tagPrefix = opts.tag ? `${opts.tag}:` : '';
    const fullKey = `${tagPrefix}${key}`;
    const ttl = opts.ttlMs != null ? opts.ttlMs : (opts.level === 2 ? this.l2Ttl : this.l1Ttl);
    const bytes = opts.bytes | 0;

    const l1Val = this.l1.get(fullKey);
    if (l1Val !== undefined) { this.stats.l1Hit++; return l1Val; }
    this.stats.l1Miss++;

    if (opts.level !== 1) {
      const l2Val = this.l2.get(fullKey);
      if (l2Val !== undefined) {
        this.stats.l2Hit++;
        this.l1.set(fullKey, l2Val, bytes, this.l1Ttl);
        return l2Val;
      }
      this.stats.l2Miss++;
    }

    const value = computeFn();
    this.l1.set(fullKey, value, bytes, this.l1Ttl);
    if (opts.level !== 1) this.l2.set(fullKey, value, bytes, ttl);
    return value;
  }

  invalidate(tagPrefix) {
    const p = tagPrefix ? `${tagPrefix}:` : '';
    this.l1.invalidate(p);
    this.l2.invalidate(p);
  }

  // ---------------- domain-specific helpers ----------------

  /**
   * Build a stable version key from a map of peerId->version.
   * Good cache key for encoded peerInfos arrays.
   */
  versionVectorKey(groupKey, peerVerMap) {
    const parts = [];
    const ids = Array.from(peerVerMap.keys()).sort((a, b) => Number(a) - Number(b));
    for (const id of ids) parts.push(`${id}:${peerVerMap.get(id)}`);
    return `vv:${groupKey}:${parts.join(',')}`;
  }

  /**
   * Key for connBitmap cached encoding.
   */
  connBitmapKey(groupKey, signature) {
    return `cbm:${groupKey}:${signature}`;
  }
}
