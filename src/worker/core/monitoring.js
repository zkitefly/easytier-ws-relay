// ============================================================
// Module 6: Real-time Monitoring & Dynamic Adjustment
//           (实时监控与动态调整机制)
//
// Design Goals:
//   - Track quota-like metrics DO exposes (we don't have raw
//     billing data, so we compute surrogates):
//       * invocation-minutes (approximated by tick age)
//       * request count (per DO method / WS message)
//       * storage reads / writes
//       * active peers, room tier, cache hit ratios
//   - Expose metrics via an in-memory ring buffer + a lightweight
//     /metrics endpoint from the DO (for pull).
//   - Implement dynamic back-pressure:
//       * Warning threshold (70%) -> reduce broadcast frequency
//       * Critical threshold (90%) -> drop low-priority RPCs
// ============================================================

import { Priority } from './rate_limiter.js';

const DEFAULT_WARN_THRESHOLD = 0.70;
const DEFAULT_CRIT_THRESHOLD = 0.90;
const DEFAULT_BUDGET_WINDOW_MS = 60 * 1000; // 1 min rolling budget
const DEFAULT_SLOT_MS = 1000;              // 1s slots

class RollingCounter {
  constructor(windowMs = DEFAULT_BUDGET_WINDOW_MS, slotMs = DEFAULT_SLOT_MS) {
    this.windowMs = windowMs;
    this.slotMs = slotMs;
    this.slotCount = Math.max(1, Math.ceil(windowMs / slotMs));
    this.slots = new Array(this.slotCount).fill(0);
    this.head = 0;
    this.lastSlotTs = Date.now();
    this.total = 0;
  }
  _advance(now = Date.now()) {
    const delta = now - this.lastSlotTs;
    if (delta <= 0) return;
    const steps = Math.min(this.slotCount, Math.floor(delta / this.slotMs));
    for (let i = 0; i < steps; i++) {
      this.head = (this.head + 1) % this.slotCount;
      this.total -= this.slots[this.head];
      this.slots[this.head] = 0;
    }
    if (steps > 0) this.lastSlotTs += steps * this.slotMs;
  }
  add(v = 1, now = Date.now()) {
    this._advance(now);
    this.slots[this.head] += v;
    this.total += v;
    return this.total;
  }
  value() {
    this._advance();
    return Math.max(0, this.total);
  }
}

export class QuotaMonitor {
  constructor(options = {}) {
    this.dailyBudget = options.dailyBudget ?? 100000; // daily quota units
    this.warnRatio = options.warnRatio ?? DEFAULT_WARN_THRESHOLD;
    this.critRatio = options.critRatio ?? DEFAULT_CRIT_THRESHOLD;

    // Rolling counters (surrogate metrics)
    this.cInvocation = new RollingCounter(60 * 1000);   // invocations/sec
    this.cWsMsg = new RollingCounter(60 * 1000);        // WS msgs/sec
    this.cBroadcast = new RollingCounter(60 * 1000);    // route broadcasts/min
    this.cRpcReq = new RollingCounter(60 * 1000);       // RPC req/min
    this.cForward = new RollingCounter(60 * 1000);      // forward ops/min

    // Daily counters (reset via explicit tick with "dayRoll")
    this.dailyStart = this._startOfDayTs();
    this.dailyUsed = options.initialDailyUsed ?? 0;

    // Tier / health
    this.level = 'normal'; // normal | warn | critical
    this._onLevelChange = [];

    // Adjustments that depend on the health level
    this.adjustments = {
      broadcastWindowMs: 40,
      routeUpdateThrottleMs: 100,
      allowLowPri: true,
      enablePeerCenterResponse: true,
    };

    // Events circular buffer (last N events for diagnostics)
    this.events = [];
    this.maxEvents = 256;
  }

  onLevelChange(fn) { if (typeof fn === 'function') this._onLevelChange.push(fn); }

  recordInvocation() { this.cInvocation.add(1); this._bumpDaily(0.01); }
  recordWsMsg(n = 1)    { this.cWsMsg.add(n); this._bumpDaily(0.002 * n); }
  recordBroadcast(n = 1){ this.cBroadcast.add(n); this._bumpDaily(0.05 * n); }
  recordRpcReq(n = 1)   { this.cRpcReq.add(n); this._bumpDaily(0.01 * n); }
  recordForward(n = 1)  { this.cForward.add(n); this._bumpDaily(0.001 * n); }

  /**
   * Record a direct quota usage (e.g. from billing webhook / wrapper).
   * This is the real source of truth if the caller can provide it.
   */
  recordQuotaUsage(units) {
    this.dailyUsed = Math.max(0, this.dailyUsed + (units | 0));
  }

  /**
   * Should this priority be processed RIGHT NOW given current health?
   */
  admitsPriority(p) {
    if (this.level === 'normal') return true;
    if (this.level === 'warn') {
      return p <= Priority.ROUTE_REQ; // drop gossip, peer center
    }
    // critical: only handshake + responses + data
    return p <= Priority.DATA_FWD;
  }

  /**
   * Refresh health level based on daily budget.
   * Call on a 1-second tick from the host.
   */
  tick(extra = {}) {
    // roll day if needed
    const sod = this._startOfDayTs();
    if (sod !== this.dailyStart) {
      this.dailyStart = sod;
      this.dailyUsed = extra.carryOverDailyUsed ?? 0;
      this._log('DAY_ROLL', { used: this.dailyUsed });
    }

    const ratio = this.dailyBudget > 0 ? this.dailyUsed / this.dailyBudget : 0;
    const prev = this.level;
    let next = 'normal';
    if (ratio >= this.critRatio) next = 'critical';
    else if (ratio >= this.warnRatio) next = 'warn';

    // Also consider *current burst rate* to handle "80% used in 1 hour"
    const perMinRate = this.cInvocation.value() + this.cWsMsg.value() * 0.2;
    if (next === 'normal' && perMinRate > 40000) next = 'warn';

    if (prev !== next) {
      this.level = next;
      this._applyAdjustments(next);
      this._log('LEVEL', { from: prev, to: next, ratio, perMinRate });
      for (const fn of this._onLevelChange) {
        try { fn(prev, next); } catch (e) { console.error('[QuotaMonitor] level handler:', e.message); }
      }
    }

    return this.snapshot();
  }

  snapshot() {
    const ratio = this.dailyBudget > 0 ? this.dailyUsed / this.dailyBudget : 0;
    return {
      level: this.level,
      dailyBudget: this.dailyBudget,
      dailyUsed: this.dailyUsed,
      dailyRatio: Math.round(ratio * 10000) / 100,
      perSec: {
        invocations: this.cInvocation.value() / 60,
        wsMsgs: this.cWsMsg.value() / 60,
        broadcasts: this.cBroadcast.value() / 60,
        rpcReqs: this.cRpcReq.value() / 60,
        forwards: this.cForward.value() / 60,
      },
      adjustments: { ...this.adjustments },
      recentEvents: Array.from(this.events),
    };
  }

  _applyAdjustments(level) {
    if (level === 'normal') {
      this.adjustments.broadcastWindowMs = 40;
      this.adjustments.routeUpdateThrottleMs = 100;
      this.adjustments.allowLowPri = true;
      this.adjustments.enablePeerCenterResponse = true;
    } else if (level === 'warn') {
      this.adjustments.broadcastWindowMs = 120;      // slower cadence
      this.adjustments.routeUpdateThrottleMs = 400;
      this.adjustments.allowLowPri = true;
      this.adjustments.enablePeerCenterResponse = true;
    } else {
      // critical: aggressive batching, drop low pri
      this.adjustments.broadcastWindowMs = 500;
      this.adjustments.routeUpdateThrottleMs = 1500;
      this.adjustments.allowLowPri = false;
      this.adjustments.enablePeerCenterResponse = false;
    }
  }

  _bumpDaily(v) { this.dailyUsed = Math.max(0, this.dailyUsed + v); }

  _startOfDayTs() {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  }

  _log(kind, data) {
    this.events.push({ t: Date.now(), kind, ...data });
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
  }
}

/**
 * Emit a compact Prometheus-text-style metrics block for /metrics.
 */
export function formatMetricsText(snapshot, cacheStats, limiterStats, lifecycleInfo) {
  const lines = [];
  const add = (name, value, help = '') => {
    if (help) lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name} ${value}`);
  };
  add('easytier_do_quota_daily_budget_total', snapshot.dailyBudget,
      'Configured daily quota budget (units)');
  add('easytier_do_quota_daily_used_total', snapshot.dailyUsed,
      'Units consumed so far today');
  add('easytier_do_quota_daily_ratio', snapshot.dailyRatio,
      '0-100 percentage of quota used today');
  add('easytier_do_health_level',
      snapshot.level === 'normal' ? 0 : snapshot.level === 'warn' ? 1 : 2,
      '0 normal, 1 warn, 2 critical');
  add('easytier_do_rate_ws_msgs_per_sec', snapshot.perSec.wsMsgs);
  add('easytier_do_rate_broadcasts_per_sec', snapshot.perSec.broadcasts);
  add('easytier_do_rate_rpc_reqs_per_sec', snapshot.perSec.rpcReqs);
  add('easytier_do_rate_forwards_per_sec', snapshot.perSec.forwards);

  if (cacheStats) {
    add('easytier_cache_l1_hit_total', cacheStats.l1Hit);
    add('easytier_cache_l1_miss_total', cacheStats.l1Miss);
    add('easytier_cache_l2_hit_total', cacheStats.l2Hit);
    add('easytier_cache_l2_miss_total', cacheStats.l2Miss);
    add('easytier_cache_l1_size_bytes', cacheStats.l1Bytes);
    add('easytier_cache_l2_entries', cacheStats.l2Size);
  }
  if (limiterStats) {
    add('easytier_limit_allowed_total', limiterStats.allowed);
    add('easytier_limit_rejected_total', limiterStats.rejected);
    add('easytier_limit_queued_now', limiterStats.queuedNow);
    add('easytier_limit_global_tokens_remaining', limiterStats.globalTokens);
  }
  if (lifecycleInfo) {
    add('easytier_lifecycle_age_ms', lifecycleInfo.ageMs);
    add('easytier_lifecycle_idle_ms', lifecycleInfo.idleMs);
    add('easytier_lifecycle_peer_count', lifecycleInfo.peerCount);
    add('easytier_lifecycle_tier',
        lifecycleInfo.tier === 'hot' ? 2 : lifecycleInfo.tier === 'warm' ? 1 : 0);
  }
  return lines.join('\n') + '\n';
}
