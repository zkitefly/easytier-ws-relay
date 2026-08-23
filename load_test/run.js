#!/usr/bin/env node
// ============================================================
// Module 7: Load Test Toolkit (负载测试与性能优化)
//
// Usage (node):
//   node load_test/run.js --target wss://<host>/ws?room=default \
//       --users 10000 --duration 3600 --ramp-up 600
//
// The tool simulates N EasyTier-like "peers" that:
//   1. Open a WebSocket, send Handshake
//   2. Respond to PING, periodic SyncRouteInfo / GetGlobalPeerMap
//   3. Sample end-to-end latency (ping->pong round trip)
//   4. Aggregate metrics into a JSON report written to stdout
//      or a file for later analysis.
//
// NOTE: 100k connections need tuning: --max-old-space-size=8192,
// and ideally running from multiple clients (each simulating 5-20k).
// ============================================================

import { WebSocket } from 'ws';
import { Buffer } from 'buffer';
import { parseArgs } from 'node:util';

const MAGIC = 0xd1e1a5e1;
const VERSION = 1;
const HEADER_SIZE = 16;

const PacketType = {
  Data: 1, HandShake: 2, Ping: 4, Pong: 5,
  RpcReq: 8, RpcResp: 9, ForeignNetworkPacket: 10,
  KcpSrc: 11, KcpDst: 12,
};

function writeU32LE(buf, off, v) { buf.writeUInt32LE(v >>> 0, off); }
function writeU8(buf, off, v)   { buf.writeUInt8(v & 0xff, off); }

function createHeader(from, to, type, len) {
  const b = Buffer.alloc(HEADER_SIZE);
  writeU32LE(b, 0, from); writeU32LE(b, 4, to);
  writeU8(b, 8, type); writeU8(b, 9, 0); writeU8(b, 10, 1); writeU8(b, 11, 0);
  writeU32LE(b, 12, len);
  return b;
}

function parseHeader(buf) {
  if (buf.length < HEADER_SIZE) return null;
  return {
    fromPeerId: buf.readUInt32LE(0),
    toPeerId: buf.readUInt32LE(4),
    packetType: buf.readUInt8(8),
    flags: buf.readUInt8(9),
    forwardCounter: buf.readUInt8(10),
    len: buf.readUInt32LE(12),
  };
}

// Minimal Handshake encoding (no protobuf - enough for the server to reject
// gracefully or to exercise WebSocket + handshake hot paths). For a full
// protocol fidelity test, the caller should use the protos package.
function encodeHandshakeLite(myPeerId, networkName = 'net1') {
  const nameBuf = Buffer.from(networkName, 'utf8');
  const payload = Buffer.alloc(4 + 4 + 4 + nameBuf.length + 32);
  let o = 0;
  payload.writeUInt32LE(MAGIC, o); o += 4;
  payload.writeUInt32LE(myPeerId, o); o += 4;
  payload.writeUInt32LE(VERSION, o); o += 4;
  nameBuf.copy(payload, o); o += nameBuf.length;
  return payload;
}

function makePeer(id) { return 20000000 + id; }

class SimPeer {
  constructor(id, targetUrl, reporter) {
    this.id = id;
    this.peerId = makePeer(id);
    this.url = targetUrl;
    this.ws = null;
    this.connected = false;
    this.handshakeOk = false;
    this.reporter = reporter;
    this.lastPingSent = 0;
    this.pingLatencySamples = [];
    this.rpcCount = 0;
    this.bytesSent = 0;
    this.bytesRecv = 0;
    this.openTs = 0;
    this.connectMs = 0;
  }

  async connect() {
    return new Promise((resolve) => {
      this.openTs = Date.now();
      try {
        this.ws = new WebSocket(this.url, { perMessageDeflate: false });
      } catch (e) { resolve(false); return; }
      const done = (ok) => { if (!done._fired) { done._fired = true; resolve(ok); } };
      this.ws.on('open', () => {
        this.connected = true;
        this.connectMs = Date.now() - this.openTs;
        // send handshake
        try {
          const payload = encodeHandshakeLite(this.peerId, 'loadnet');
          const hdr = createHeader(this.peerId, 0, PacketType.HandShake, payload.length);
          const msg = Buffer.concat([hdr, payload]);
          this.ws.send(msg);
          this.bytesSent += msg.length;
        } catch (_) {}
        setTimeout(() => done(this.connected && this.handshakeOk), 2000);
      });
      this.ws.on('message', (data) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        this.bytesRecv += buf.length;
        const h = parseHeader(buf);
        if (!h) return;
        if (h.packetType === PacketType.HandShake) this.handshakeOk = true;
        if (h.packetType === PacketType.Ping) {
          const payload = buf.subarray(HEADER_SIZE);
          const resp = Buffer.concat([
            createHeader(h.toPeerId, h.fromPeerId, PacketType.Pong, payload.length),
            payload,
          ]);
          try { this.ws.send(resp); this.bytesSent += resp.length; } catch (_) {}
        }
        if (h.packetType === PacketType.Pong) {
          if (this.lastPingSent > 0) {
            this.pingLatencySamples.push(Date.now() - this.lastPingSent);
            if (this.pingLatencySamples.length > 32) this.pingLatencySamples.shift();
            this.lastPingSent = 0;
          }
        }
      });
      this.ws.on('error', () => done(false));
      this.ws.on('close', () => { this.connected = false; done(this.handshakeOk); });
    });
  }

  tick(now) {
    if (!this.connected) return;
    // Send one PING every 30s on average
    if (!this.lastPingSent && (Math.random() < 1 / 30)) {
      try {
        const payload = Buffer.alloc(8);
        payload.writeUInt32LE(now >>> 0, 0);
        payload.writeUInt32LE(this.id & 0xffffffff, 4);
        const msg = Buffer.concat([
          createHeader(this.peerId, 0, PacketType.Ping, payload.length), payload,
        ]);
        this.ws.send(msg);
        this.bytesSent += msg.length;
        this.lastPingSent = now;
      } catch (_) {}
    }
  }

  close(code = 1000) {
    try { this.ws && this.ws.close(code); } catch (_) {}
    this.connected = false;
  }

  avgPing() {
    if (this.pingLatencySamples.length === 0) return 0;
    const s = this.pingLatencySamples.reduce((a, b) => a + b, 0);
    return s / this.pingLatencySamples.length;
  }

  p95Ping() {
    if (this.pingLatencySamples.length === 0) return 0;
    const s = Array.from(this.pingLatencySamples).sort((a, b) => a - b);
    return s[Math.floor(s.length * 0.95)];
  }
}

class LoadReporter {
  constructor() {
    this.attempts = 0; this.successConnects = 0; this.handshakes = 0;
    this.errors = 0;
  }
  summary(peers, durationSec) {
    let totalSent = 0, totalRecv = 0, totalPings = 0;
    let pingSum = 0, pingP95Vals = [], connects = 0, connectSum = 0;
    for (const p of peers) {
      totalSent += p.bytesSent; totalRecv += p.bytesRecv;
      totalPings += p.pingLatencySamples.length;
      if (p.avgPing() > 0) pingSum += p.avgPing();
      if (p.p95Ping() > 0) pingP95Vals.push(p.p95Ping());
      if (p.connected) connects++;
      connectSum += p.connectMs;
    }
    const live = peers.filter(p => p.connected).length;
    const avgConn = connects ? connectSum / connects : 0;
    const avgPing = totalPings ? pingSum / peers.filter(p => p.avgPing() > 0).length : 0;
    const p95 = pingP95Vals.length ? pingP95Vals.sort((a,b)=>a-b)[Math.floor(pingP95Vals.length * 0.95)] : 0;
    return {
      durationSec,
      totalPeers: peers.length,
      live,
      attempts: this.attempts,
      successConnects: this.successConnects,
      handshakes: this.handshakes,
      errors: this.errors,
      handshakeRate: this.attempts ? (this.handshakes / this.attempts) : 0,
      avgConnectMs: avgConn,
      avgPingMs: avgPing,
      p95PingMs: p95,
      bytesSentPerSec: totalSent / Math.max(1, durationSec),
      bytesRecvPerSec: totalRecv / Math.max(1, durationSec),
      totalPings,
    };
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      target:   { type: 'string', default: 'ws://127.0.0.1:8787/ws?room=default' },
      users:    { type: 'string', default: '1000' },
      duration: { type: 'string', default: '120' }, // seconds
      'ramp-up':{ type: 'string', default: '60' },  // seconds
      shard:    { type: 'string', default: '0' },   // this client's shard index
      shards:   { type: 'string', default: '1' },   // total client shards
      out:      { type: 'string', default: '' },
    },
  });

  const N = Math.max(1, parseInt(values.users, 10));
  const DURATION = Math.max(10, parseInt(values.duration, 10));
  const RAMP = Math.max(1, parseInt(values['ramp-up'], 10));
  const SHARD = parseInt(values.shard, 10) || 0;
  const SHARDS = Math.max(1, parseInt(values.shards, 10));
  const BASE_URL = values.target;
  const START = Date.now();

  console.error(`[loadtest] target=${BASE_URL} peers=${N}/${SHARDS} shard=${SHARD} duration=${DURATION}s ramp=${RAMP}s`);

  const reporter = new LoadReporter();
  const peers = [];
  for (let i = 0; i < N; i++) peers.push(new SimPeer(SHARD * N + i, BASE_URL, reporter));

  // Ramp-up: connect N/RAMP peers per second (jittered)
  const perTick = Math.max(1, Math.ceil(N / RAMP));
  let peerIdx = 0;
  const rampStart = Date.now();
  for (let t = 0; t < RAMP && peerIdx < N; t++) {
    const batch = [];
    for (let k = 0; k < perTick && peerIdx < N; k++, peerIdx++) {
      batch.push(peers[peerIdx].connect());
      reporter.attempts++;
    }
    const results = await Promise.all(batch);
    for (const ok of results) {
      if (ok) { reporter.successConnects++; reporter.handshakes++; }
      else reporter.errors++;
    }
    const elapsed = (Date.now() - rampStart) / 1000;
    const nextSleep = Math.max(0, 1000 * (t + 1) - (elapsed * 1000));
    await new Promise(r => setTimeout(r, nextSleep));
  }
  console.error(`[loadtest] ramp up done; live=${peers.filter(p=>p.connected).length}`);

  // Steady-state: tick peers periodically
  const steadyStart = Date.now();
  const totalSeconds = DURATION;
  for (let s = 0; s < totalSeconds; s += 1) {
    const now = Date.now();
    for (const p of peers) p.tick(now);
    await new Promise(r => setTimeout(r, 1000));
    if (s % 30 === 0) {
      const live = peers.filter(p => p.connected).length;
      const sum = reporter.summary(peers, (Date.now() - START) / 1000);
      console.error(`[loadtest] t=${s}s live=${live} avgPing=${sum.avgPingMs.toFixed(1)}ms p95=${sum.p95PingMs.toFixed(1)}ms connRate=${(sum.handshakeRate*100).toFixed(1)}%`);
    }
  }

  // Final report
  const sum = reporter.summary(peers, (Date.now() - START) / 1000);
  const report = JSON.stringify({
    startedAt: new Date(START).toISOString(),
    endedAt: new Date().toISOString(),
    args: { target: BASE_URL, N, DURATION, RAMP, SHARD, SHARDS },
    summary: sum,
  }, null, 2);
  if (values.out) {
    const fs = await import('node:fs');
    fs.writeFileSync(values.out, report);
    console.error(`[loadtest] report written: ${values.out}`);
  } else {
    process.stdout.write(report + '\n');
  }

  // Graceful close
  for (const p of peers) p.close();
  setTimeout(() => process.exit(0), 2000);
}

// Guard against being imported
if (typeof process !== 'undefined' && process.argv && process.argv[1] && process.argv[1].includes('load_test')) {
  main().catch(e => { console.error(e); process.exit(1); });
}
