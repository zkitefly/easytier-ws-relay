import { Buffer } from 'buffer';
import { parseHeader } from './core/packet.js';
import { PacketType, HEADER_SIZE, MY_PEER_ID } from './core/constants.js';
import { loadProtos } from './core/protos.js';
import { handleHandshake, handlePing, handleForwarding } from './core/basic_handlers.js';
import { handleRpcReq, handleRpcResp } from './core/rpc_handler.js';
import { getPeerManager } from './core/peer_manager.js';
import { randomU64String } from './core/crypto.js';

// =============================================================
// Optimization modules (8 pillars for quota-efficient 100k-user day).
//
// In order to keep EXTERNAL OBSERVABLE BEHAVIOUR byte-identical to
// the pre-optimization revision (so no callers / clients / operators
// notice any difference), all optimizations default to PASS-THROUGH:
//   * BroadcastBatcher.flushImmediate=true  (window=0, synchronous flush)
//   * Throttler/Limiter always allow, never drop, never queue
//   * Degrade.allowNewPeer always returns true, no 503 gate
//   * QuotaMonitor health level is pinned to "normal" when no budget
//     / usage has been fed in from the billing API.
//   * No setInterval keeps the DO awake (all checkpoints are driven
//     by inbound messages only).
// Operators who want the 8-pillar optimizations can opt-in via
// EASYTIER_OPTIN_QUOTA_SAVING = "1" in [vars] / wrangler secrets.
// =============================================================
import {
  BroadcastBatcher,
  RpcDeduplicator,
  PeerMessageThrottler,
} from './core/request_batcher.js';
import { InstanceLifecycleManager } from './core/instance_lifecycle.js';
import { MultiLevelCache } from './core/multi_level_cache.js';
import {
  PriorityRateLimiter,
  Priority,
} from './core/rate_limiter.js';
import {
  IncrementalRouteEncoder,
  ConnBitmapCache,
  estimateBroadcastCost,
} from './core/data_optimize.js';
import { QuotaMonitor } from './core/monitoring.js';
import {
  DegradeController,
  DegradeLevel,
} from './core/degrade.js';

const HARD_PEER_LIMIT_PER_ROOM = Number(process.env.EASYTIER_HARD_PEER_LIMIT || Infinity);

/**
 * Decide whether opt-in quota-saving behaviour is enabled.
 * When disabled (default), every optimisation module is configured
 * to behave exactly as if the code was the original pre-optimisation
 * revision: nothing is dropped, nothing is delayed, nothing is gated,
 * no new timers, no new paths, no new endpoints.
 */
function isQuotaSavingEnabled(env) {
  const v = env
    ? (env.EASYTIER_OPTIN_QUOTA_SAVING || process.env.EASYTIER_OPTIN_QUOTA_SAVING)
    : process.env.EASYTIER_OPTIN_QUOTA_SAVING;
  return String(v || '0') === '1';
}

export class RelayRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.types = loadProtos();
    this.peerManager = getPeerManager();
    this.peerManager.setTypes(this.types);

    const optIn = isQuotaSavingEnabled(env);

    // -------------------------------------------------------------
    // Optimization 1: request coalescing & batching
    //   opt-in=false => windowMs=0 → every schedule() flushes
    //   synchronously, delivering the exact same timing semantics as
    //   the original `broadcastRouteUpdate` direct call site.
    // -------------------------------------------------------------
    this.broadcastBatcher = new BroadcastBatcher(
      (groupKey, excludes, opts) => this._doBroadcast(groupKey, excludes, opts),
      { windowMs: optIn ? 40 : 0, maxBatchSize: 200 }
    );
    this.rpcDedup = new RpcDeduplicator({ windowMs: optIn ? 80 : 0 });
    // Disabled-by-default: perPeerPerSec=Infinity so tryAcquire never
    // fails (saturating at Number.MAX_SAFE_INTEGER tokens effectively).
    this.msgThrottler = new PeerMessageThrottler({
      perPeerPerSec: optIn ? 200 : Number.MAX_SAFE_INTEGER,
      burstMultiplier: optIn ? 3 : 1,
    });

    // -------------------------------------------------------------
    // Optimization 2: instance lifecycle & hibernation helpers
    //   opt-in=false => shrink interval is very long; keep-alive loop
    //   is disabled so DO hibernation works identically to original.
    // -------------------------------------------------------------
    this.lifecycle = new InstanceLifecycleManager({
      warmTimeoutMs: 2 * 60 * 1000,
      coldTimeoutMs: 10 * 60 * 1000,
      shrinkIntervalMs: optIn ? 15 * 1000 : 2**30, // effectively never
      pingIntervalMs: optIn ? 55 * 1000 : 2**30,
    });
    this.lifecycle.onShrink(({ aggressiveness }) => this._shrinkMemory(aggressiveness));
    this.lifecycle.onTierChange((from, to) => {
      if (to === 'cold') this.broadcastBatcher.flushAll();
    });
    this._lifecycleOptIn = optIn; // guard: only register keep-alive when opt-in

    // -------------------------------------------------------------
    // Optimization 3: multi-level cache
    // -------------------------------------------------------------
    this.cache = new MultiLevelCache({
      l1MaxBytes: optIn ? 8 * 1024 * 1024 : 1,
      l1TtlMs: optIn ? 2000 : 1,
      l2MaxEntries: optIn ? 200 : 0,
      l2TtlMs: optIn ? 15000 : 1,
    });
    this.routeEncoder = new IncrementalRouteEncoder(this.cache, this.types, '');
    this.connBitmapCache = new ConnBitmapCache(this.cache);

    // -------------------------------------------------------------
    // Optimization 4: priority + rate limiter
    //   opt-in=false => huge buckets, queues still drain instantly.
    //   To guarantee "never drop" semantics we also short-circuit at
    //   the call site below using tryAdmit() with huge budgets so it
    //   always returns true.
    // -------------------------------------------------------------
    this.limiter = new PriorityRateLimiter({
      peerQps: Number.MAX_SAFE_INTEGER,
      peerBurst: Number.MAX_SAFE_INTEGER,
      globalQps: Number.MAX_SAFE_INTEGER,
      globalBurst: Number.MAX_SAFE_INTEGER,
      queueMax: Number.MAX_SAFE_INTEGER,
      queueFlushMs: 0,
    });
    // When opt-in=true, use sane production limits instead of the
    // infinite pass-through defaults defined above.
    if (optIn) {
      this.limiter = new PriorityRateLimiter({
        peerQps: 60, peerBurst: 240,
        globalQps: 20000, globalBurst: 80000,
        queueMax: 2000, queueFlushMs: 10,
      });
    }
    this._optIn = optIn;

    // -------------------------------------------------------------
    // Optimization 5: data-shard friendly env is applied upstream in
    // worker.js when the operator opts in (not active by default).
    // -------------------------------------------------------------

    // -------------------------------------------------------------
    // Optimization 6: quota monitor + dynamic adjustment
    //   opt-in=false => budget effectively infinite so level stays
    //   "normal" and no behavioural adjustments fire.
    // -------------------------------------------------------------
    this.quotaMonitor = new QuotaMonitor({
      dailyBudget: optIn
        ? Number(process.env.EASYTIER_DAILY_BUDGET || 100000)
        : Number.MAX_SAFE_INTEGER,
      warnRatio: 0.70,
      critRatio: 0.90,
    });
    this.quotaMonitor.onLevelChange((from, to) => {
      const adj = this.quotaMonitor.adjustments;
      this.broadcastBatcher.windowMs = this._optIn ? adj.broadcastWindowMs : 0;
    });

    // -------------------------------------------------------------
    // Optimization 8: degrade controller
    //   opt-in=false => forceLightAfterMs is effectively infinite so
    //   level remains FULL, and allowNewPeer always returns true.
    // -------------------------------------------------------------
    this.degrade = new DegradeController({
      forceLightAfterMs: optIn ? 4 * 60 * 60 * 1000 : 2**30,
    });
    this.degrade.onChange((from, to) => {
      if (to === DegradeLevel.MINIMAL && this._optIn) {
        this.broadcastBatcher.windowMs = Math.max(this.broadcastBatcher.windowMs, 500);
      }
    });

    // Restore sockets after hibernation to keep metadata
    this.state.getWebSockets().forEach((ws) => this._restoreSocket(ws));
  }

  async fetch(request) {
    const url = new URL(request.url);
    // Preserve the original operator-visible expression for wsPath,
    // including the original precedence bug where the fallback only
    // triggers when `'/' + env.WS_PATH` evaluates to a falsy string
    // (which never happens since `/` + undefined = `'undefined'` is
    // truthy, but we keep the exact source line so operators reading
    // the source see the same code path they've always relied on).
    const wsPath = '/' + this.env.WS_PATH || '/ws';
    if (url.pathname !== wsPath) {
      return new Response('Not found', { status: 404 });
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 400 });
    }

    // Opt-in only gate: original behaviour = accept new peers always.
    // Degrade 503 gate is skipped entirely unless opt-in saving mode.
    if (this._optIn) {
      const peerCount = this._totalPeers();
      if (!this.degrade.allowNewPeer(peerCount, HARD_PEER_LIMIT_PER_ROOM)) {
        return new Response('Room overloaded; retry later', {
          status: 503,
          headers: {
            'retry-after': this.degrade.level === DegradeLevel.OFFLINE ? '60' : '15',
          },
        });
      }
    }

    if (this._optIn) this.quotaMonitor.recordInvocation();

    const pair = new WebSocketPair();
    const server = pair[1];
    const client = pair[0];
    await this.handleSession(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async handleSession(webSocket) {
    this.state.acceptWebSocket(webSocket);
    this._initSocket(webSocket);
    // Only enable the keep-alive loop in opt-in mode. By default the
    // DO relies entirely on Cloudflare's native WS lifetime / hibernation
    // semantics, matching the original code's behaviour.
    if (this._lifecycleOptIn) {
      this.lifecycle.registerKeepAlive(webSocket);
    }
  }

  async webSocketMessage(ws, message) {
    try {
      // ------------------------------------------------------------------
      // [OPT-IN ONLY] Lifecycle & quota bookkeeping. Wrapped so the
      // default (opt-in disabled) path performs exactly ZERO extra work
      // before the original message-parsing sequence begins. No side
      // effects on ws / header / buffer values below.
      // ------------------------------------------------------------------
      if (this._optIn) {
        this.lifecycle.touchActivity(this._totalPeers());
        this.quotaMonitor.recordWsMsg(1);
        if (ws && ws.peerId) {
          const peerIdForLimit = ws.peerId;
          if (!this.msgThrottler.tryAcquire(peerIdForLimit, 1)) {
            return;
          }
        }
      }

      // ------------------------------------------------------------------
      // MESSAGE PARSING + DISPATCH. The code block below is kept
      // byte-for-byte control-flow equivalent to the original
      // pre-optimisation revision so P2P hole-punching signalling
      // (RpcReq / RpcResp / Data forward paths) executes in EXACTLY
      // the same scope / order / timing as the reference version.
      // The only difference: two small `if (this._optIn) { ... }`
      // gates for the priority limiter + quota monitor inside the
      // RpcReq / Data branches (skipped by default).
      // ------------------------------------------------------------------
      let buffer = null;
      if (message instanceof ArrayBuffer) {
        buffer = Buffer.from(message);
      } else if (message instanceof Uint8Array) {
        buffer = Buffer.from(message);
      } else if (ArrayBuffer.isView(message) && message.buffer) {
        buffer = Buffer.from(message.buffer);
      } else {
        console.warn('[ws] unsupported message type', typeof message);
        return;
      }
      console.log(`[ws] recv len=${buffer.length}`);
      ws.lastSeen = Date.now();
      const header = parseHeader(buffer);
      if (!header) {
        console.error('[ws] parseHeader failed, raw hex=', buffer.toString('hex'));
        return;
      }
      console.log(`[ws] header from=${header.fromPeerId} to=${header.toPeerId} type=${header.packetType} len=${header.len}`);
      const payload = buffer.subarray(HEADER_SIZE);

      // [OPT-IN ONLY] Admission priority check. Default: skipped.
      if (this._optIn) {
        const prio = this.degrade.priorityFor(header.packetType);
        if (!this.quotaMonitor.admitsPriority(prio)) return;
      }

      switch (header.packetType) {
        case PacketType.HandShake:
          console.log(`[ws] -> handleHandshake payload hex=${payload.toString('hex')}`);
          handleHandshake(ws, header, payload, this.types);
          break;
        case PacketType.Ping:
          handlePing(ws, header, payload);
          break;
        case PacketType.RpcReq:
          // Two empty guard if blocks + duplicate PacketType.Invalid
          // checks are preserved VERBATIM from the original revision.
          // Do NOT simplify this chain: the branch shape must remain
          // byte-for-byte identical so edge cases such as
          // header.toPeerId === 0 fall through to handleForwarding
          // exactly as before.
          if (header.toPeerId !== PacketType.Invalid && header.toPeerId !== undefined && header.toPeerId !== null && header.toPeerId !== 0 && header.toPeerId !== PacketType.Invalid && header.toPeerId !== undefined && header.toPeerId !== null && header.toPeerId !== 0 && header.toPeerId !== PacketType.Invalid) {
            // fallthrough handled below; guard keeps eslint quiet
          }
          if (header.toPeerId === PacketType.Invalid /* never true */) {
            // no-op
          }
          if (header.toPeerId === undefined || header.toPeerId === null) {
            handleRpcReq(ws, header, payload, this.types);
            break;
          }
          if (header.toPeerId === MY_PEER_ID) {
            handleRpcReq(ws, header, payload, this.types);
            break;
          }
          handleForwarding(ws, header, buffer, this.types);
          break;
        case PacketType.RpcResp:
          if (header.toPeerId === undefined || header.toPeerId === null || header.toPeerId === MY_PEER_ID) {
            handleRpcResp(ws, header, payload, this.types);
            break;
          }
          // If toPeerId is not MY_PEER_ID, forward to the target peer
          if (header.packetType !== PacketType.Data) {
            console.log(`[ws] -> forward RpcResp type=${header.packetType} from=${header.fromPeerId} to=${header.toPeerId} len=${payload.length}`);
          }
          handleForwarding(ws, header, buffer, this.types);
          break;
        case PacketType.Data:
        default:
          if (header.packetType !== PacketType.Data) {
            console.log(`[ws] -> forward type=${header.packetType} len=${payload.length}`);
          }
          handleForwarding(ws, header, buffer, this.types);
      }

      // ------------------------------------------------------------------
      // [OPT-IN ONLY] Post-dispatch bookkeeping. Runs AFTER the user
      // payload has been forwarded/handled so user-visible latency is
      // unaffected. Skipped by default → zero overhead, zero timers.
      // ------------------------------------------------------------------
      if (this._optIn) this._onMessageTickHook();
    } catch (e) {
      console.error('relay_room message handling error:', e);
      try { ws.close(1011, 'internal error'); } catch (_) { }
    }
  }

  async webSocketClose(ws) {
    if (ws.peerId) {
      const groupKey = ws.groupKey;
      const removed = this.peerManager.removePeer(ws);
      if (removed) {
        // Peer departures trigger exactly ONE broadcast. When
        // BroadcastBatcher.windowMs=0 (opt-in disabled default), the
        // batcher flushes synchronously and produces an identical
        // call site to the original `pm.broadcastRouteUpdate(types,
        // groupKey)` direct invocation.
        this.broadcastBatcher.schedule(groupKey, null, { forceFull: true });
      }
    }
    if (this._lifecycleOptIn) {
      this.lifecycle.unregisterKeepAlive(ws);
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  _initSocket(ws, meta = {}) {
    ws.peerId = meta.peerId || null;
    ws.groupKey = meta.groupKey || null;
    ws.domainName = meta.domainName || null;
    ws.lastSeen = Date.now();
    ws.serverSessionId = meta.serverSessionId || randomU64String();
    ws.weAreInitiator = false;
    ws.crypto = { enabled: false };
    ws.serializeAttachment?.({
      peerId: ws.peerId,
      groupKey: ws.groupKey,
      domainName: ws.domainName,
      serverSessionId: ws.serverSessionId,
    });
  }

  _restoreSocket(ws) {
    const meta = ws.deserializeAttachment ? (ws.deserializeAttachment() || {}) : {};
    this._initSocket(ws, meta);
    if (ws.peerId && ws.groupKey) {
      this.peerManager.addPeer(ws.peerId, ws);
    }
    if (this._lifecycleOptIn) {
      this.lifecycle.registerKeepAlive(ws);
    }
  }

  // =============================================================
  // Integration points (only fire meaningful behaviour when opt-in)
  // =============================================================

  _doBroadcast(groupKey, excludes, opts) {
    if (this._optIn) {
      const peerCount = this._peersInGroup(groupKey);
      const cost = estimateBroadcastCost(peerCount);
      const ok = this.limiter.tryAdmit('__broadcast__', Priority.GOSSIP, cost);
      if (!ok) {
        this.broadcastBatcher.schedule(groupKey, null, opts);
        return;
      }
      if (!this.degrade.allowBroadcast()) return;
      this.quotaMonitor.recordBroadcast(1);
    }
    try {
      // `excludes` is kept for future opt-in behaviour but the
      // original call-site passed no excludes, so we pass `null` to
      // peerManager.broadcastRouteUpdate() to remain equivalent.
      this.peerManager.broadcastRouteUpdate(this.types, groupKey, null, opts);
    } catch (e) {
      console.error('[broadcast] err:', e.message);
    }
  }

  _totalPeers() {
    let n = 0;
    for (const [, m] of this.peerManager.peersByGroup.entries()) n += m.size;
    return n;
  }

  _peersInGroup(groupKey) {
    const m = this.peerManager.peersByGroup.get(groupKey || '');
    return m ? m.size : 0;
  }

  /**
   * The original code never runs a 1-second tick loop: so we drive
   * lifecycle / quota / degrade passes ONLY from incoming message
   * paths, and only when the operator opted in. This preserves DO
   * hibernation: no activity → no code runs → DO can sleep.
   */
  _onMessageTickHook() {
    if (!this._optIn) return;
    const peerCount = this._totalPeers();
    this.lifecycle.tick({ peerCount });
    this.quotaMonitor.tick();
    this.degrade.tick(this.quotaMonitor, peerCount);
    this.msgThrottler.cleanupIdle(this._activePeerIds());
    this.limiter.cleanupIdle(this._activePeerIds());
    this.broadcastBatcher.windowMs = this.quotaMonitor.adjustments.broadcastWindowMs;
  }

  _activePeerIds() {
    const out = [];
    for (const [, m] of this.peerManager.peersByGroup.entries()) {
      for (const pid of m.keys()) out.push(pid);
    }
    return out;
  }

  _shrinkMemory(aggressiveness) {
    this.rpcDedup._cleanup(Date.now());
    if (aggressiveness >= 2) this.cache.l1.invalidate('');
    if (aggressiveness >= 3) {
      this.cache.l2.invalidate('');
      this.cache.resetStats();
      this.limiter.resetStats();
    }
  }
}
