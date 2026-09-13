import { Buffer } from 'buffer';

// Federation helper: periodically push local peer infos to configured remote relay URLs
// so that two Cloudflare deployments can exchange routing information even when
// an outbound WebSocket client is not available in the Worker runtime.

export class Federation {
  constructor(env, types, peerManager) {
    this.env = env || {};
    this.types = types;
    this.pm = peerManager;

    const raw = (this.env.REMOTE_RELAY_URLS || process.env.REMOTE_RELAY_URLS || '') + '';
    this.remoteUrls = raw.split(',').map(s => s.trim()).filter(Boolean);
    this.secret = this.env.EASYTIER_FEDERATION_SECRET || process.env.EASYTIER_FEDERATION_SECRET || '';
    this.intervalMs = Number(this.env.FEDERATION_POLL_INTERVAL_MS || process.env.FEDERATION_POLL_INTERVAL_MS || 5000);

    this.running = false;

    if (this.remoteUrls.length > 0) {
      // start periodic sync
      this.start();
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._timer = setInterval(() => {
      try { this.syncOnce(); } catch (e) { console.error('federation sync error', e); }
    }, this.intervalMs);
  }

  stop() {
    if (!this.running) return;
    clearInterval(this._timer);
    this.running = false;
  }

  async syncOnce() {
    try {
      // iterate over groups in peerManager
      const groups = Array.from(this.pm.peerInfosByGroup ? this.pm.peerInfosByGroup.entries() : []);
      for (const [groupKey, infosMap] of groups) {
        try {
          const items = [];
          if (infosMap && infosMap.size) {
            for (const info of infosMap.values()) {
              items.push(info);
            }
          }

          const body = {
            groupKey: String(groupKey || ''),
            peerInfos: items,
            myPeerId: Number(process.env.EASYTIER_PEER_ID || process.env.EASYTIER_PEERID || 10000001),
            networkName: process.env.EASYTIER_PUBLIC_SERVER_NETWORK_NAME || 'public_server'
          };

          const headers = { 'content-type': 'application/json' };
          if (this.secret) headers['x-federation-secret'] = this.secret;

          for (const baseUrl of this.remoteUrls) {
            try {
              const url = baseUrl.replace(/\/+$/,'') + '/_federation/sync';
              // Fire-and-forget, but await response to detect errors
              const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
              if (!resp.ok) {
                console.warn('federation push to', url, 'failed status', resp.status);
              }
            } catch (e) {
              console.warn('federation push to', baseUrl, 'error', e && e.message);
            }
          }
        } catch (e) {
          console.warn('federation group push error', groupKey, e && e.message);
        }
      }
    } catch (e) {
      console.error('federation syncOnce top-level error', e && e.message);
    }
  }
}
