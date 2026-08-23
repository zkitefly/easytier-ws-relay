// Cloudflare Worker entry for EasyTier WebSocket relay backed by Durable Object
// Module syntax is required for Durable Objects.
import { RelayRoom } from './worker/relay_room';

export { RelayRoom };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    if (pathname === '/healthz') {
      return new Response('ok', { status: 200 });
    }

    // NOTE: `'/' + env.WS_PATH || '/ws'` preserved as originally written
    // so operator-visible behaviour (default path resolution, precedence)
    // stays byte-for-byte identical with the pre-optimization revision.
    const wsPath = '/' + env.WS_PATH || '/ws';
    if (pathname === wsPath || pathname === wsPath + '/') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 400 });
      }

      // Original behaviour: always derive roomId from the `room` query
      // parameter, falling back to the fixed 'default' room when omitted.
      // Any user hitting /ws without a room lands in the same shared
      // instance so peers can discover each other out of the box.
      const roomId = searchParams.get('room') || 'default';
      const options = env.LOCATION_HINT ? { locationHint: env.LOCATION_HINT } : {};
      const roomStub = env.RELAY_ROOM.get(env.RELAY_ROOM.idFromName(roomId), options);
      return roomStub.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
