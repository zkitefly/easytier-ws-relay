export const MAGIC = 0xd1e1a5e1;
export const VERSION = 1;

// Allow configuring server peer id via environment variable EASYTIER_PEER_ID.
// This lets different Cloudflare deployments use distinct peer IDs.
export const MY_PEER_ID = Number(process.env.EASYTIER_PEER_ID || process.env.EASYTIER_PEERID || 10000001);
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
