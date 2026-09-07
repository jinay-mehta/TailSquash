// mock_nodes.js - simulates 3 upstream microservice/storage replica nodes.
// Provides realistic baseline latency (8-16ms) plus configurable tail-latency chaos
// (e.g. 600-1100ms stalls representing GC pauses, disk flush stalls, or thread pool exhaustion).

import http from 'node:http';

export class MockCluster {
  constructor() {
    this.nodes = [
      { id: 'node-a', port: 4001, name: 'Replica Alpha (US-East)' },
      { id: 'node-b', port: 4002, name: 'Replica Beta (US-Central)' },
      { id: 'node-c', port: 4003, name: 'Replica Gamma (US-West)' }
    ];

    // Default chaos parameters
    this.chaosConfig = {
      stragglerRate: 0.05,        // 5% chance an incoming request hits a stall
      baseLatencyMin: 8,          // Minimum normal response time
      baseLatencyMax: 16,         // Maximum normal response time
      stragglerDelayMin: 600,     // Typical Java/Go GC pause lower bound
      stragglerDelayMax: 1100,    // Upper bound on noisy neighbor stall
      targetedNodeStall: null     // Pin a single node (e.g. 'node-b') to constantly stall
    };

    this.stats = {
      'node-a': { requests: 0, stragglers: 0, totalMs: 0 },
      'node-b': { requests: 0, stragglers: 0, totalMs: 0 },
      'node-c': { requests: 0, stragglers: 0, totalMs: 0 }
    };

    this.servers = [];
  }

  setChaos(cfg) {
    this.chaosConfig = { ...this.chaosConfig, ...cfg };
  }

  getChaos() {
    return { ...this.chaosConfig };
  }

  getStats() {
    return { ...this.stats };
  }

  resetStats() {
    for (const k of Object.keys(this.stats)) {
      this.stats[k] = { requests: 0, stragglers: 0, totalMs: 0 };
    }
  }

  start() {
    return Promise.all(
      this.nodes.map((node) => {
        return new Promise((resolve, reject) => {
          const srv = http.createServer((req, res) => {
            const t0 = performance.now();
            const record = this.stats[node.id];
            record.requests++;

            // Check if this request should experience a tail-latency stall
            const isTargeted = this.chaosConfig.targetedNodeStall === node.id;
            const isRandom = Math.random() < this.chaosConfig.stragglerRate;
            const shouldStall = isTargeted || isRandom;

            let delay = Math.floor(
              this.chaosConfig.baseLatencyMin +
              Math.random() * (this.chaosConfig.baseLatencyMax - this.chaosConfig.baseLatencyMin)
            );

            if (shouldStall) {
              record.stragglers++;
              const stallDuration = Math.floor(
                this.chaosConfig.stragglerDelayMin +
                Math.random() * (this.chaosConfig.stragglerDelayMax - this.chaosConfig.stragglerDelayMin)
              );
              delay += stallDuration;
            }

            // Track client cancellation so we don't finish writing to a closed socket
            let clientAborted = false;
            req.on('close', () => {
              if (!res.writableEnded) {
                clientAborted = true;
              }
            });

            setTimeout(() => {
              if (clientAborted) return; // Slower node was cancelled by proxy's AbortController

              const elapsed = performance.now() - t0;
              record.totalMs += elapsed;

              res.writeHead(200, {
                'Content-Type': 'application/json',
                'X-Replica': node.id,
                'X-Compute-Time': elapsed.toFixed(1),
                'X-Stalled': shouldStall ? '1' : '0'
              });

              // Realistic microservice payload
              res.end(
                JSON.stringify({
                  status: 'OK',
                  replica: node.id,
                  replicaName: node.name,
                  latencyMs: Number(elapsed.toFixed(1)),
                  wasStalled: shouldStall,
                  timestamp: Date.now(),
                  blockSignature: `blk_${Math.random().toString(36).slice(2, 8)}`
                })
              );
            }, delay);
          });

          srv.on('error', reject);
          srv.listen(node.port, () => {
            this.servers.push(srv);
            resolve(node);
          });
        });
      })
    );
  }

  stop() {
    return Promise.all(
      this.servers.map((s) => new Promise((res) => s.close(res)))
    );
  }
}
