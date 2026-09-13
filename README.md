# EasyTier WebSocket Relay for Cloudflare Workers

... (rest of README unchanged)

## Federation between relays (cross-account peering)

To allow two Cloudflare deployments (different accounts) to mutually discover peers without requiring outbound WebSocket clients in Workers, this project includes a simple federation mechanism. Each relay can be configured with REMOTE_RELAY_URLS (comma separated list) and a shared EASYTIER_FEDERATION_SECRET. The relay will periodically POST its known peer info to remote relays; remote relays will inject those peers into their routing tables and broadcast route updates to locally connected clients.

Environment variables (new and important):

- EASYTIER_PEER_ID: numeric unique ID for this server relay (must be distinct between different deployments). Default: 10000001
- EASYTIER_PUBLIC_SERVER_NETWORK_NAME: network name advertised by this relay (default: public_server)
- EASYTIER_FEDERATION_SECRET: shared secret used to authenticate federation HTTP pushes between relays
- REMOTE_RELAY_URLS: comma-separated list of remote relay base URLs (example: https://a.workers.dev, https://b.workers.dev). The federation POST endpoint used is `/_federation/sync` at each URL.
- FEDERATION_POLL_INTERVAL_MS: how often (ms) to push local peer infos to remote relays. Default: 5000

Usage example (wrangler.toml env):

[env.production]
EASYTIER_PEER_ID = "10000011"
EASYTIER_PUBLIC_SERVER_NETWORK_NAME = "my-network"
EASYTIER_FEDERATION_SECRET = "a-long-random-secret"
REMOTE_RELAY_URLS = "https://relay-other.acct.workers.dev"
FEDERATION_POLL_INTERVAL_MS = "5000"

Notes:
- Federation is optional. If REMOTE_RELAY_URLS is empty, nothing is pushed.
- Federation sends JSON representations of peer infos; the remote relay will insert them as if they were peers, and then broadcast route updates to locally-connected clients.
- This mechanism avoids needing outbound WebSocket client support in Workers and works across Cloudflare accounts.
