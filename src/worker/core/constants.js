export const MAGIC = 0xd1e1a5e1;
export const VERSION = 1;
export const MY_PEER_ID = 10000001; // Server Peer ID

/** Normalize peerId to consistent number for Map keys. Fixes JS Map key mismatch: 123 vs "123" are different keys. */
export function normalizePeerId(id) {
  if (id == null) return undefined;
  const n = typeof id === 'number' ? id : parseInt(String(id), 10);
  return Number.isInteger(n) && n >= 0 && n <= 0xFFFFFFFF ? n : undefined;
}
export const HEADER_SIZE = 16;

export const PacketType = {
  Invalid: 0,
  Data: 1,
  HandShake: 2,
  RoutePacket: 3, // deprecated
  Ping: 4,
  Pong: 5,
  TaRpc: 6, // deprecated
  Route: 7, // deprecated
  RpcReq: 8,
  RpcResp: 9,
  ForeignNetworkPacket: 10,
  KcpSrc: 11,
  KcpDst: 12,
};
