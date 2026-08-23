// ============================================================
// Module 5: Data Storage & Access Pattern Optimization
//           (数据存储与访问模式优化)
//
// Design Goals:
//   - Replace Map<> iteration hot paths with indexed snapshots.
//   - Shard peer infos by group and compute incremental deltas,
//     avoiding O(N) re-encoding on every broadcast.
//   - Avoid serializing the same peerInfo payload for every peer.
// ============================================================

import { Buffer } from 'buffer';
import { MY_PEER_ID } from './constants.js';

/**
 * Build a cache key from a (groupKey, peerId, version) triple.
 * If version changes, key changes -> invalidation is free.
 */
export function peerInfoCacheKey(groupKey, peerId, version) {
  return `pienc:${groupKey}:${peerId}:v${version ?? 0}`;
}

/**
 * Incremental Encoder for RouteSync payloads.
 * Caches per-peer encoded bytes and recombines them without
 * re-encoding.
 *
 * Usage:
 *   const enc = new IncrementalRouteEncoder(cache, types, groupKey);
 *   const { peerInfosItems, rawPeerInfos, updatedCount } =
 *       enc.buildPeerInfosPayload(relevantPeers, peerInfos, sessionVerMap, forceFull);
 */
export class IncrementalRouteEncoder {
  constructor(cache, types, groupKey) {
    this.cache = cache; // MultiLevelCache
    this.types = types;
    this.groupKey = groupKey;
  }

  _encodeOne(peerId, info, tag) {
    const key = peerInfoCacheKey(this.groupKey, peerId, info.version || 1);
    return this.cache.getOrComputeSync(key, () => {
      return this.types.RoutePeerInfo.encode(info).finish();
    }, { tag, level: 2 });
  }

  buildPeerInfosPayload(relevantPeers, getPeerInfoFn, sessionVerMap, forceFull = false) {
    const tag = `group:${this.groupKey}:peerinfos`;
    const items = [];
    const rawItems = [];
    let updatedCount = 0;
    for (const pid of relevantPeers) {
      const info = getPeerInfoFn(pid);
      if (!info) continue;
      const version = info.version || 1;
      const prev = forceFull ? 0 : (sessionVerMap.get(pid) || 0);
      if (forceFull || version > prev) {
        items.push(info);
        const enc = this._encodeOne(pid, info, tag);
        rawItems.push(Buffer.isBuffer(enc) ? Uint8Array.from(enc) : enc);
        sessionVerMap.set(pid, version);
        updatedCount++;
      }
    }
    return { peerInfosItems: items, rawPeerInfos: rawItems, updatedCount };
  }
}

/**
 * Connection Bitmap cache.
 * The bitmap computation is O(N^2); we memoize it by signature.
 * Signature already accounts for peerId+version, so cache hit is safe.
 */
export class ConnBitmapCache {
  constructor(cache) {
    this.cache = cache;
  }

  get(groupKey, signature) {
    return this.cache.l1.get(this.cache.connBitmapKey(groupKey, signature));
  }

  set(groupKey, signature, value, bytes) {
    return this.cache.l1.set(
      this.cache.connBitmapKey(groupKey, signature),
      value, bytes, 5000
    );
  }

  invalidate(groupKey) {
    this.cache.l1.invalidate(`cbm:${groupKey}:`);
    this.cache.l2.invalidate(`cbm:${groupKey}:`);
  }
}

/**
 * Sharding-aware room ID generator.
 *
 * Problem: 100,000 users all using the default room causes one DO
 * to carry everything. Solution: if user doesn't specify a room,
 * deterministically shard them by networkName + peerId hash into
 * 1 of N virtual rooms. Peers in the same network MUST land in
 * the same shard to be visible to each other.
 *
 * We provide a helper so the outer worker.js can map
 * (networkName, peerId) -> stable shardId without breaking P2P
 * discovery of the same network.
 */
export function shardRoomFor(networkName, overrideShardCount = 0) {
  const N = overrideShardCount || Number(process.env.EASYTIER_SHARD_COUNT || 1);
  if (N <= 1) return networkName || 'default';
  const safe = String(networkName || 'default');
  // FNV-1a 32-bit hash of the network name for stable shard mapping
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < safe.length; i++) {
    h ^= safe.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const shard = h % N;
  return `${safe}#s${shard}`;
}

/**
 * Estimate the cost (in DO units) of a route broadcast to N peers.
 * Used by monitoring / rate limiter to make admission decisions.
 */
export function estimateBroadcastCost(peerCount) {
  if (!peerCount || peerCount <= 0) return 1;
  // Dominant cost: per-peer encoding (linear) + bitmap setup (N^2/8)
  return Math.ceil(peerCount * 1.5 + (peerCount * peerCount) / 8000);
}
