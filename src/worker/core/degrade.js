// ============================================================
// Module 8: Degrade Strategy & Disaster Recovery
//           (降级策略与容灾方案)
//
// Design Goals:
//   - Tiered degradation: full -> minimal -> offline, never hard-fail.
//   - Peer-Center digest 304-response as the fast path: when quota
//     is critically low, we still respond (short-circuit) instead
//     of allocating memory for a full snapshot.
//   - Fallback to "light relay only" mode: stop producing route
//     broadcasts, only forward Data packets between already-known
//     peers. Already established P2P tunnels keep working.
// ============================================================

import { MY_PEER_ID, PacketType } from './constants.js';
import { Priority } from './rate_limiter.js';

export const DegradeLevel = Object.freeze({
  FULL: 'full',
  LIGHT: 'light',
  MINIMAL: 'minimal',
  OFFLINE: 'offline',
});

export class DegradeController {
  constructor(options = {}) {
    this.level = DegradeLevel.FULL;
    this.onChangeHandlers = [];
    this.forceLightAfterMs = options.forceLightAfterMs ?? (4 * 60 * 60 * 1000); // 4h
    this.startedAt = Date.now();
    this.lastFullAt = Date.now();
    this.peerRejectCount = 0;
  }

  onChange(fn) { if (typeof fn === 'function') this.onChangeHandlers.push(fn); }

  setLevel(next, reason = '') {
    const prev = this.level;
    if (prev === next) return;
    this.level = next;
    if (next === DegradeLevel.FULL) this.lastFullAt = Date.now();
    for (const fn of this.onChangeHandlers) {
      try { fn(prev, next, reason); } catch (e) { console.error('[Degrade] handler err:', e.message); }
    }
  }

  /**
   * Auto-tick that transitions level based on QuotaMonitor health
   * and the age of the DO instance.
   */
  tick(quotaMonitor, activePeerCount = 0, now = Date.now()) {
    const qLevel = quotaMonitor?.level || 'normal';
    const age = now - this.startedAt;
    const sinceFull = now - this.lastFullAt;

    let next = DegradeLevel.FULL;
    let reason = '';

    if (qLevel === 'critical') {
      next = DegradeLevel.MINIMAL;
      reason = 'quota:critical';
    } else if (qLevel === 'warn') {
      next = DegradeLevel.LIGHT;
      reason = 'quota:warn';
    } else if (age > this.forceLightAfterMs && activePeerCount > 500 && sinceFull > 1800_000) {
      // Very long-running large room: use LIGHT to save CPU
      next = DegradeLevel.LIGHT;
      reason = 'long_running:large';
    }

    if (next !== this.level) this.setLevel(next, reason);
    return { level: this.level, reason, ageMs: age, sinceFullMs: sinceFull };
  }

  // ------- policy checkers used at call sites -------
  allowBroadcast() {
    return this.level === DegradeLevel.FULL || this.level === DegradeLevel.LIGHT;
  }

  allowFullRouteInfo() {
    return this.level === DegradeLevel.FULL;
  }

  allowPeerCenterFullResponse() {
    return this.level === DegradeLevel.FULL || this.level === DegradeLevel.LIGHT;
  }

  allowNewPeer(activePeerCount, hardLimit) {
    if (this.level === DegradeLevel.OFFLINE) return false;
    if (this.level === DegradeLevel.MINIMAL) {
      // Only accept reconnects of peers we've seen before (checking
      // this is caller's responsibility). For unknown peers, apply
      // a stricter limit (50% of hard limit).
      return activePeerCount < Math.max(10, Math.floor(hardLimit * 0.5));
    }
    return activePeerCount < hardLimit;
  }

  /**
   * Fast-path RPC response for quota-critical mode. Returns a
   * pre-built minimal payload so callers skip heavy encoding.
   */
  buildMinimalRouteAck(types, targetPeerId, mySessionId) {
    const respPayload = { isInitiator: false, sessionId: mySessionId };
    return types.SyncRouteInfoResponse.encode(respPayload).finish();
  }

  /**
   * Decide the priority of a packet given the degrade level.
   * Returns adjusted priority (never increases).
   */
  priorityFor(packetType) {
    switch (packetType) {
      case PacketType.HandShake: return Priority.HANDSHAKE;
      case PacketType.RpcResp:   return Priority.RPC_RESP;
      case PacketType.Data:      return Priority.DATA_FWD;
      case PacketType.KcpSrc:
      case PacketType.KcpDst:
      case PacketType.ForeignNetworkPacket:
        return Priority.DATA_FWD;
      case PacketType.Ping:      return Priority.PING;
      case PacketType.RpcReq:    return Priority.ROUTE_REQ;
      default:                   return Priority.GOSSIP;
    }
  }

  snapshot() {
    return {
      level: this.level,
      startedAt: this.startedAt,
      lastFullAt: this.lastFullAt,
      ageMs: Date.now() - this.startedAt,
      peerRejectCount: this.peerRejectCount,
    };
  }
}

/**
 * Fallback helper: encode a "retry later" handshake response that
 * tells clients to back off 15 seconds before reconnecting.
 * We don't have a native retry-after field in HandshakeRequest,
 * so we surface it via the features list for forward-compatible
 * clients.
 */
export function encodeRetryHandshake(types, magic, retrySeconds = 15) {
  const respPayload = {
    magic,
    myPeerId: MY_PEER_ID,
    version: 1,
    features: [`retry-after=${retrySeconds}`, 'degraded'],
    networkName: 'degraded',
    networkSecretDigrest: new Uint8Array(32),
  };
  return types.HandshakeRequest.encode(respPayload).finish();
}
