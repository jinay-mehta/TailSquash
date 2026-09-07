// standard_proxy.js - traditional unhedged round-robin reverse proxy
// Serves as the control group baseline to demonstrate unmitigated tail latency.

import http from 'node:http';
import { LatencyTracker } from './latency_tracker.js';

export class StandardProxy {
  constructor(port = 5001, upstreamNodes = []) {
    this.port = port;
    this.upstreamNodes = upstreamNodes;
    this.rrIndex = 0;
    this.tracker = new LatencyTracker(1000);
    this.server = null;
    this.totalRequests = 0;
  }

  _nextNode() {
    const node = this.upstreamNodes[this.rrIndex % this.upstreamNodes.length];
    this.rrIndex++;
    return node;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        const start = performance.now();
        this.totalRequests++;

        const targetNode = this._nextNode();
        const host = targetNode.host || 'localhost';
        const url = `http://${host}:${targetNode.port}${req.url}`;

        try {
          const upstreamRes = await fetch(url, {
            method: req.method,
            headers: {
              ...req.headers,
              host: `${host}:${targetNode.port}`
            }
          });

          const data = await upstreamRes.arrayBuffer();
          const elapsed = performance.now() - start;
          this.tracker.record(elapsed);

          res.writeHead(upstreamRes.status, {
            'Content-Type': upstreamRes.headers.get('content-type') || 'application/json',
            'X-Proxy-Engine': 'Standard-RoundRobin',
            'X-Replica-Id': targetNode.id,
            'X-Total-Elapsed-Ms': elapsed.toFixed(1)
          });
          res.end(Buffer.from(data));
        } catch (err) {
          const elapsed = performance.now() - start;
          this.tracker.record(elapsed);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Bad Gateway', message: err.message }));
        }
      });

      this.server.on('error', reject);
      this.server.listen(this.port, resolve);
    });
  }

  getStats() {
    return {
      type: 'standard',
      port: this.port,
      totalRequests: this.totalRequests,
      latency: this.tracker.getStats()
    };
  }

  reset() {
    this.totalRequests = 0;
    this.tracker.reset();
  }

  stop() {
    if (this.server) {
      return new Promise((res) => this.server.close(res));
    }
  }
}
