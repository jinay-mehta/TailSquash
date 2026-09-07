// server.js - telemetry bridge & web dashboard server
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockCluster } from '../cluster/mock_nodes.js';
import { StandardProxy } from '../engine/standard_proxy.js';
import { HedgedProxy } from '../engine/hedged_proxy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

const PORT = parseInt(process.env.PORT || '3000', 10);

export class WebAppServer {
  constructor(port = PORT) {
    this.port = port;
    this.cluster = new MockCluster();
    this.stdProxy = null;
    this.hedgedProxy = null;
    this.server = null;
    this.sseClients = new Set();
    this.trafficTimer = null;
  }

  async init() {
    // 1. Boot up mock cluster replicas (:4001, :4002, :4003)
    await this.cluster.start();

    // 2. Boot up control baseline proxy (:5001)
    this.stdProxy = new StandardProxy(5001, this.cluster.nodes);
    await this.stdProxy.start();

    // 3. Boot up TailSquash hedged proxy (:5002)
    this.hedgedProxy = new HedgedProxy(5002, this.cluster.nodes, {
      targetPercentile: 90,
      minHedgeDelayMs: 15,
      maxBudgetRatio: 0.08
    });
    await this.hedgedProxy.start();

    // Pipe live hedge telemetry events directly into our SSE stream
    this.hedgedProxy.setTelemetryListener((evt) => {
      this.broadcastSSE('telemetry', evt);
    });
  }

  broadcastSSE(eventName, payload) {
    const data = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(data);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  serveFile(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json',
      '.svg': 'image/svg+xml'
    }[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain' });
        res.end(err.code === 'ENOENT' ? 'Not Found' : `Server Error: ${err.message}`);
        return;
      }
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    });
  }

  // Fire a simultaneous request to both Standard and Hedged proxies to compare behavior
  async executeSideBySideRequest() {
    const fetchStd = async () => {
      const t0 = performance.now();
      try {
        const r = await fetch(`http://localhost:${this.stdProxy.port}/data`);
        await r.json();
        return { ok: true, latency: performance.now() - t0, status: r.status };
      } catch (err) {
        return { ok: false, latency: 1500, error: err.message };
      }
    };

    const fetchHedge = async () => {
      const t0 = performance.now();
      try {
        const r = await fetch(`http://localhost:${this.hedgedProxy.port}/data`);
        const json = await r.json();
        return {
          ok: true,
          latency: performance.now() - t0,
          wasHedged: r.headers.get('x-was-hedged') === 'true',
          hedgeWon: r.headers.get('x-hedge-won') === 'true',
          replica: r.headers.get('x-replica-id') || 'unknown',
          status: r.status,
          body: json
        };
      } catch (err) {
        return { ok: false, latency: 1500, error: err.message };
      }
    };

    // Run concurrently for true side-by-side fairness
    const [resStd, resHedge] = await Promise.all([fetchStd(), fetchHedge()]);

    const report = {
      timestamp: Date.now(),
      standardLatency: Number(resStd.latency.toFixed(1)),
      hedgedLatency: Number(resHedge.latency.toFixed(1)),
      wasHedged: Boolean(resHedge.wasHedged),
      hedgeWon: Boolean(resHedge.hedgeWon),
      winnerNode: resHedge.replica || 'unknown',
      latencySavedMs: Number(Math.max(0, resStd.latency - resHedge.latency).toFixed(1))
    };

    this.broadcastSSE('request_pair', report);
    return report;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const pathname = url.pathname;

        // Enable CORS for development
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        // SSE Real-time Feed
        if (pathname === '/api/stream') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });
          res.write(':\n\n'); // SSE comment to keep alive
          this.sseClients.add(res);

          req.on('close', () => this.sseClients.delete(res));
          return;
        }

        // API: Current System Status
        if (pathname === '/api/status' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            cluster: {
              nodes: this.cluster.nodes,
              chaos: this.cluster.getChaos(),
              stats: this.cluster.getStats()
            },
            standardProxy: this.stdProxy.getStats(),
            hedgedProxy: this.hedgedProxy.getStats(),
            autoTrafficActive: this.trafficTimer !== null
          }));
          return;
        }

        // API: Update Chaos Settings
        if (pathname === '/api/chaos' && req.method === 'POST') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            try {
              const cfg = JSON.parse(body || '{}');
              this.cluster.setChaos(cfg);
              this.broadcastSSE('chaos_updated', this.cluster.getChaos());
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, chaos: this.cluster.getChaos() }));
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        // API: Step 1 Request Pair
        if (pathname === '/api/test/single' && req.method === 'POST') {
          const result = await this.executeSideBySideRequest();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }

        // API: Batch Load Burst
        if (pathname === '/api/test/batch' && req.method === 'POST') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', async () => {
            const { count = 50, delayBetweenMs = 45 } = body ? JSON.parse(body) : {};
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ started: true, count }));

            for (let i = 0; i < count; i++) {
              await this.executeSideBySideRequest();
              if (delayBetweenMs > 0) {
                await new Promise((r) => setTimeout(r, delayBetweenMs));
              }
            }
          });
          return;
        }

        // API: Toggle Continuous Background Stream
        if (pathname === '/api/traffic/toggle' && req.method === 'POST') {
          if (this.trafficTimer) {
            clearInterval(this.trafficTimer);
            this.trafficTimer = null;
          } else {
            this.trafficTimer = setInterval(() => {
              this.executeSideBySideRequest().catch(() => {});
            }, 120);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ active: this.trafficTimer !== null }));
          return;
        }

        // API: Clear Counters
        if (pathname === '/api/reset' && req.method === 'POST') {
          this.stdProxy.reset();
          this.hedgedProxy.reset();
          this.cluster.resetStats();
          this.broadcastSSE('stats_reset', {});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        // Static Files Serving
        let reqFile = pathname === '/' ? '/index.html' : pathname;
        let absPath = path.normalize(path.join(PUBLIC_DIR, reqFile));

        if (!absPath.startsWith(PUBLIC_DIR)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Access Denied');
          return;
        }

        this.serveFile(res, absPath);
      });

      this.server.on('error', reject);
      this.server.listen(this.port, '0.0.0.0', () => {
        console.log(`[TailSquash] Web console ready: http://localhost:${this.port} (or http://127.0.0.1:${this.port})`);
        resolve();
      });
    });
  }

  async stop() {
    if (this.trafficTimer) clearInterval(this.trafficTimer);
    if (this.server) await new Promise((r) => this.server.close(r));
    if (this.stdProxy) await this.stdProxy.stop();
    if (this.hedgedProxy) await this.hedgedProxy.stop();
    if (this.cluster) await this.cluster.stop();
  }
}

// Direct execution entrypoint
if (process.argv[1]?.endsWith('server.js')) {
  const app = new WebAppServer(PORT);
  app.init().then(() => app.start()).catch((err) => {
    console.error('[TailSquash Server Error]:', err);
  });
}
