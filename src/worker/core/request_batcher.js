// ============================================================
// Module 1: Request Batching & Coalescing (请求合并与批处理)
//
// Design Goals:
//   - Reduce broadcast frequency by batching N peer membership
//     changes into a single route update broadcast.
//   - De-duplicate identical RPC requests (e.g. GetGlobalPeerMap
//     with same digest) within a coalescing window.
//   - Limit per-second message processing cost inside a single
//     Durable Object invocation.
// ============================================================

const DEFAULT_BATCH_WINDOW_MS = 40;
const DEFAULT_MAX_BATCH_SIZE = 200;
const DEFAULT_DEDUP_WINDOW_MS = 80;

export class BroadcastBatcher {
  constructor(flushFn, options = {}) {
    this.flushFn = flushFn;
    this.windowMs = options.windowMs ?? DEFAULT_BATCH_WINDOW_MS;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.pendingGroups = new Map(); // groupKey -> { timer, excludes:Set, forceFull, dirty }
    this._flushBound = this._flushGroup.bind(this);
  }

  /**
   * Schedule a route broadcast for a group. Multiple calls within
   * the batching window are merged into one flush.
   */
  schedule(groupKey, excludePeerId = null, opts = {}) {
    if (!groupKey) groupKey = '';
    let entry = this.pendingGroups.get(groupKey);
    if (!entry) {
      entry = {
        timer: null,
        excludes: new Set(),
        forceFull: false,
        dirty: false,
        createdAt: Date.now(),
      };
      this.pendingGroups.set(groupKey, entry);
    }
    if (excludePeerId !== null && excludePeerId !== undefined) {
      entry.excludes.add(excludePeerId);
    }
    if (opts.forceFull) entry.forceFull = true;
    entry.dirty = true;

    if (!entry.timer) {
      if (this.windowMs <= 0) {
        // Zero-window: flush synchronously. This matches the original
        // code path where `broadcastRouteUpdate` is called inline.
        this._flushGroup(groupKey);
        return;
      }
      const now = Date.now();
      const age = now - entry.createdAt;
      const delay = age >= this.windowMs ? 0 : this.windowMs - age;
      entry.timer = setTimeout(() => this._flushBound(groupKey), delay);
    }

    if (entry.excludes.size >= this.maxBatchSize) {
      this._flushGroup(groupKey);
    }
  }

  /** Immediately flush all pending groups (call on hibernate/shutdown). */
  flushAll() {
    for (const gk of Array.from(this.pendingGroups.keys())) {
      this._flushGroup(gk);
    }
  }

  pendingCount() {
    return this.pendingGroups.size;
  }

  _flushGroup(groupKey) {
    const entry = this.pendingGroups.get(groupKey);
    if (!entry) return;
    this.pendingGroups.delete(groupKey);
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (!entry.dirty) return;
    try {
      this.flushFn(groupKey, entry.excludes, { forceFull: entry.forceFull });
    } catch (e) {
      console.error('[BroadcastBatcher] flush error:', e?.message || e);
    }
  }
}

// ============================================================
// RPC Request De-duplicator
// - Keyed by (method, input-sha1-ish) -> cached response
// ============================================================

export class RpcDeduplicator {
  constructor(options = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_DEDUP_WINDOW_MS;
    this.cache = new Map(); // key -> { respBytes, expireAt }
    this._lastClean = 0;
    this._cleanIntervalMs = Math.max(this.windowMs * 2, 500);
  }

  _hash(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(36);
  }

  _cleanup(now = Date.now()) {
    if (now - this._lastClean < this._cleanIntervalMs) return;
    this._lastClean = now;
    for (const [k, v] of this.cache.entries()) {
      if (now > v.expireAt) this.cache.delete(k);
    }
  }

  key(serviceName, methodIndex, rawBody) {
    const bodyStr = rawBody && typeof rawBody === 'object' && rawBody.length != null
      ? (rawBody.length > 128
          ? `${rawBody.length}:${this._hash(Buffer.from(rawBody.subarray(0, 64)).toString('hex'))}`
          : Buffer.from(rawBody).toString('hex'))
      : String(rawBody ?? '');
    return `${serviceName}:${methodIndex}:${bodyStr}`;
  }

  get(key) {
    this._cleanup();
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expireAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.respBytes;
  }

  set(key, respBytes, customTtlMs) {
    this._cleanup();
    const ttl = customTtlMs ?? this.windowMs;
    this.cache.set(key, { respBytes, expireAt: Date.now() + ttl });
  }

  size() {
    this._cleanup();
    return this.cache.size;
  }
}

// ============================================================
// Message Rate Throttler (per-peer inbound message budget)
// - Soft cap: messages within budget bypass extra overhead
// - Hard cap: excessive messages are delayed via micro-batching
// ============================================================

export class PeerMessageThrottler {
  constructor(options = {}) {
    this.perPeerPerSec = options.perPeerPerSec ?? 200;
    this.burstMultiplier = options.burstMultiplier ?? 3;
    this.tokens = new Map(); // peerId -> { tokens, lastRefill }
    this.windowMs = 1000;
  }

  _refill(entry, now) {
    const elapsed = now - entry.lastRefill;
    if (elapsed <= 0) return;
    const add = (elapsed / this.windowMs) * this.perPeerPerSec;
    entry.tokens = Math.min(
      this.perPeerPerSec * this.burstMultiplier,
      entry.tokens + add
    );
    entry.lastRefill = now;
  }

  /** Returns true if allowed, false if should be throttled. */
  tryAcquire(peerId, cost = 1) {
    if (!peerId) return true;
    const now = Date.now();
    let entry = this.tokens.get(peerId);
    if (!entry) {
      entry = {
        tokens: this.perPeerPerSec * this.burstMultiplier,
        lastRefill: now,
      };
      this.tokens.set(peerId, entry);
    }
    this._refill(entry, now);
    if (entry.tokens >= cost) {
      entry.tokens -= cost;
      return true;
    }
    return false;
  }

  /** Drop idle peers' token buckets to free memory. */
  cleanupIdle(activePeerIds, now = Date.now()) {
    const active = new Set(activePeerIds || []);
    for (const pid of Array.from(this.tokens.keys())) {
      if (!active.has(pid)) this.tokens.delete(pid);
    }
  }
}
