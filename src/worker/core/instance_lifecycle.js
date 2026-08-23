// ============================================================
// Module 2: Instance Lifecycle Management (实例生命周期管理)
//
// Design Goals:
//   - Extend idle timeout for active rooms to avoid hibernation churn.
//   - Aggressively release memory of cold in-memory structures.
//   - Provide warm / hot / cold tier classification for rooms so
//     monitoring can reason about them.
//
// Note:
//   Cloudflare Durable Objects already have an idle-hibernation
//   mechanism (~30s without inbound WebSocket messages when using
//   Hibernatable WebSockets). This layer adds an application-level
//   "memory shrink" step that runs BEFORE hibernation kicks in,
//   plus controls for WS keep-alive cadence.
// ============================================================

const DEFAULT_WARM_TIMEOUT_MS = 2 * 60 * 1000;   // 2 min: no peers => warm
const DEFAULT_COLD_TIMEOUT_MS = 10 * 60 * 1000;  // 10 min: no activity => cold
const DEFAULT_SHG_INTERVAL_MS = 15 * 1000;       // shrink every 15s
const DEFAULT_PING_INTERVAL_MS = 55 * 1000;      // keep WS alive < 60s CF timeout

export class InstanceLifecycleManager {
  constructor(options = {}) {
    this.warmTimeoutMs = options.warmTimeoutMs ?? DEFAULT_WARM_TIMEOUT_MS;
    this.coldTimeoutMs = options.coldTimeoutMs ?? DEFAULT_COLD_TIMEOUT_MS;
    this.shrinkIntervalMs = options.shrinkIntervalMs ?? DEFAULT_SHG_INTERVAL_MS;
    this.pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;

    this._lastShrink = Date.now();
    this._lastActivity = Date.now();
    this._lastPeerCount = 0;
    this._createdAt = Date.now();

    this._tier = 'hot'; // hot | warm | cold
    this._onShrinkHandlers = [];
    this._onTierChangeHandlers = [];

    this._pingTimer = null;
    this._pingRegistry = new Set(); // ws references
  }

  /** Register a WebSocket for periodic keep-alive PINGs. */
  registerKeepAlive(ws) {
    if (!ws) return;
    this._pingRegistry.add(ws);
    this._ensurePingLoop();
  }

  /** Unregister a WebSocket (call on close). */
  unregisterKeepAlive(ws) {
    if (!ws) return;
    this._pingRegistry.delete(ws);
    if (this._pingRegistry.size === 0 && this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  _ensurePingLoop() {
    if (this._pingTimer) return;
    this._pingTimer = setInterval(() => {
      const now = Date.now();
      for (const ws of Array.from(this._pingRegistry)) {
        if (ws.readyState !== 1) { // WS_OPEN
          this._pingRegistry.delete(ws);
          continue;
        }
        // Only send if the socket has been quiet for more than half the interval
        const lastSeen = ws.lastSeen || 0;
        if (now - lastSeen > (this.pingIntervalMs >>> 1)) {
          try {
            // Send a tiny, zero-cost "heartbeat" via the ws.ping() API
            // if available (CF runtime may not expose it); otherwise
            // callers rely on app-level PING via PacketType.Ping.
            if (typeof ws.ping === 'function') {
              ws.ping().catch(() => {});
            }
          } catch (_) { /* ignore */ }
        }
      }
    }, this.pingIntervalMs);
    if (typeof this._pingTimer.unref === 'function') {
      this._pingTimer.unref();
    }
  }

  /** Register a callback to invoke during a memory-shrink pass. */
  onShrink(handler) {
    if (typeof handler === 'function') this._onShrinkHandlers.push(handler);
  }

  onTierChange(handler) {
    if (typeof handler === 'function') this._onTierChangeHandlers.push(handler);
  }

  /** Mark any kind of activity (message received, peer joined, etc). */
  touchActivity(peerCount = 0) {
    this._lastActivity = Date.now();
    if (typeof peerCount === 'number') this._lastPeerCount = peerCount;
    const prev = this._tier;
    this._tier = 'hot';
    if (prev !== this._tier) this._emitTier(prev, this._tier);
  }

  /**
   * Called periodically by the DO host loop. Triggers shrink when
   * appropriate and returns current tier + diagnostics.
   */
  tick(options = {}) {
    const now = Date.now();
    const peerCount = typeof options.peerCount === 'number' ? options.peerCount : this._lastPeerCount;
    this._lastPeerCount = peerCount;

    const idleMs = now - this._lastActivity;
    const prevTier = this._tier;

    if (peerCount === 0 && idleMs > this.coldTimeoutMs) {
      this._tier = 'cold';
    } else if (peerCount === 0 && idleMs > this.warmTimeoutMs) {
      this._tier = 'warm';
    } else {
      this._tier = 'hot';
    }
    if (prevTier !== this._tier) this._emitTier(prevTier, this._tier);

    if (now - this._lastShrink >= this.shrinkIntervalMs) {
      this._lastShrink = now;
      this._runShrink({ tier: this._tier, peerCount });
    }

    return {
      tier: this._tier,
      ageMs: now - this._createdAt,
      idleMs,
      peerCount,
      keepAliveCount: this._pingRegistry.size,
    };
  }

  /** Force a shrink pass immediately (useful before hibernation). */
  forceShrink(context = {}) {
    this._runShrink({ tier: this._tier, forced: true, ...context });
  }

  getTier() {
    return this._tier;
  }

  _emitTier(from, to) {
    for (const fn of this._onTierChangeHandlers) {
      try { fn(from, to); } catch (e) { console.error('[Lifecycle] tier handler err:', e.message); }
    }
  }

  _runShrink(ctx) {
    // Aggressiveness: cold > warm > hot
    const agg = ctx.tier === 'cold' ? 3 : ctx.tier === 'warm' ? 2 : 1;
    for (const fn of this._onShrinkHandlers) {
      try { fn({ aggressiveness: agg, ...ctx }); } catch (e) {
        console.error('[Lifecycle] shrink handler err:', e.message);
      }
    }
  }
}
