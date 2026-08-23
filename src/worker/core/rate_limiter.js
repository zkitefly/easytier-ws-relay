// ============================================================
// Module 4: Rate Limiter & Priority Queue (请求限流与优先级队列)
//
// Design Goals:
//   - Per-peer budget: token bucket (independent from the message
//     throttler above; this one guards *expensive* operations).
//   - Global DO budget: protect against burst of 10000 peers all
//     doing an O(N) route update at once.
//   - Priority: Handshake > RpcResp > Data forward > non-critical
//     RPC (GetGlobalPeerMap, periodic route gossip).
// ============================================================

export const Priority = Object.freeze({
  HANDSHAKE: 0,   // highest - must always process
  RPC_RESP: 1,    // responses to in-flight RPCs
  DATA_FWD: 2,    // user data forwarding
  PING: 3,        // ping/pong
  ROUTE_REQ: 4,   // route sync requests
  PEER_CENTER: 5, // peer center RPC (periodic)
  GOSSIP: 6,      // lowest priority periodic broadcast
});

const DEFAULT_PEER_QPS = 60;           // baseline per-peer QPS
const DEFAULT_PEER_BURST = 240;
const DEFAULT_GLOBAL_QPS = 20000;      // per-DO global ops budget
const DEFAULT_GLOBAL_BURST = 80000;
const DEFAULT_QUEUE_MAX_LEN = 2000;
const DEFAULT_QUEUE_FLUSH_MS = 10;

class TokenBucket {
  constructor(perSec, burst) {
    this.perSec = perSec;
    this.burst = burst;
    this.tokens = burst;
    this.last = Date.now();
  }
  try(cost = 1) {
    const now = Date.now();
    const delta = Math.max(0, now - this.last);
    this.last = now;
    this.tokens = Math.min(this.burst, this.tokens + (delta / 1000) * this.perSec);
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }
  tokensRemaining() {
    return Math.floor(this.tokens);
  }
}

export class PriorityRateLimiter {
  constructor(options = {}) {
    this.peerQps = options.peerQps ?? DEFAULT_PEER_QPS;
    this.peerBurst = options.peerBurst ?? DEFAULT_PEER_BURST;
    this.globalQps = options.globalQps ?? DEFAULT_GLOBAL_QPS;
    this.globalBurst = options.globalBurst ?? DEFAULT_GLOBAL_BURST;
    this.queueMax = options.queueMax ?? DEFAULT_QUEUE_MAX_LEN;
    this.queueFlushMs = options.queueFlushMs ?? DEFAULT_QUEUE_FLUSH_MS;

    this.globalBucket = new TokenBucket(this.globalQps, this.globalBurst);
    this.peerBuckets = new Map(); // peerId -> TokenBucket

    // Queues by priority (0..6)
    this.queues = [];
    for (let i = 0; i <= Priority.GOSSIP; i++) this.queues.push([]);
    this._queueTimer = null;
    this._queueFlushBound = this._flushQueues.bind(this);

    // Counters
    this.stats = {
      allowed: 0,
      rejected: 0,
      queued: 0,
      dequeued: 0,
      byPriority: new Array(Priority.GOSSIP + 1).fill(0),
    };
  }

  // ------- public API -------
  /**
   * Try to admit an operation.
   * @param {string|number} peerId
   * @param {number} priority Priority.* constant
   * @param {number} cost token cost
   * @returns {boolean} true if admitted, false if rejected or queued
   */
  tryAdmit(peerId, priority, cost = 1, onDequeue = null) {
    if (priority === Priority.HANDSHAKE) {
      // Always allow handshake, but still debit if possible
      this._peerBucket(peerId).try(cost);
      this.globalBucket.try(cost);
      this.stats.allowed++;
      this.stats.byPriority[priority]++;
      return true;
    }

    const peer = this._peerBucket(peerId);
    if (peer.try(cost) && this.globalBucket.try(cost)) {
      this.stats.allowed++;
      this.stats.byPriority[priority]++;
      return true;
    }

    // Not enough tokens - queue or reject
    if (onDequeue && this._totalQueued() < this.queueMax) {
      const qIdx = Math.min(Math.max(priority | 0, 0), Priority.GOSSIP);
      this.queues[qIdx].push({ peerId, priority, cost, onDequeue, ts: Date.now() });
      this.stats.queued++;
      this._ensureTimer();
      return false; // caller should short-circuit: will be called back later
    }

    this.stats.rejected++;
    return false;
  }

  snapshotStats() {
    const byPriority = Array.from(this.stats.byPriority);
    return {
      allowed: this.stats.allowed,
      rejected: this.stats.rejected,
      queued: this.stats.queued,
      dequeued: this.stats.dequeued,
      queuedNow: this._totalQueued(),
      globalTokens: this.globalBucket.tokensRemaining(),
      peerBucketCount: this.peerBuckets.size,
      byPriority,
    };
  }

  resetStats() {
    this.stats = {
      allowed: 0, rejected: 0, queued: 0, dequeued: 0,
      byPriority: new Array(Priority.GOSSIP + 1).fill(0),
    };
  }

  /** Drop buckets for peers no longer active. */
  cleanupIdle(activePeerIds) {
    const set = new Set(activePeerIds || []);
    for (const k of Array.from(this.peerBuckets.keys())) {
      if (!set.has(k)) this.peerBuckets.delete(k);
    }
  }

  // ------- internal -------
  _peerBucket(peerId) {
    if (!peerId) return this.globalBucket; // anon => global only
    let b = this.peerBuckets.get(peerId);
    if (!b) {
      b = new TokenBucket(this.peerQps, this.peerBurst);
      this.peerBuckets.set(peerId, b);
    }
    return b;
  }

  _totalQueued() {
    let s = 0;
    for (const q of this.queues) s += q.length;
    return s;
  }

  _ensureTimer() {
    if (this._queueTimer) return;
    this._queueTimer = setTimeout(this._queueFlushBound, this.queueFlushMs);
  }

  _flushQueues() {
    this._queueTimer = null;
    const maxIter = this.queueMax; // hard cap to avoid runaway
    for (let iter = 0; iter < maxIter && this._totalQueued() > 0; iter++) {
      // Find highest-priority non-empty queue
      let idx = -1;
      for (let i = 0; i < this.queues.length; i++) {
        if (this.queues[i].length > 0) { idx = i; break; }
      }
      if (idx < 0) return;
      const item = this.queues[idx].shift();
      // Try global bucket; if empty, requeue and wait for next tick
      if (!this.globalBucket.try(item.cost)) {
        this.queues[idx].unshift(item);
        this._ensureTimer();
        return;
      }
      try {
        item.onDequeue && item.onDequeue();
      } catch (e) {
        console.error('[PRL] dequeue handler err:', e.message);
      }
      this.stats.dequeued++;
      this.stats.byPriority[item.priority]++;
    }
    if (this._totalQueued() > 0) this._ensureTimer();
  }
}
