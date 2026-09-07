// hedged_proxy.js - main proxy jisme speculative hedging ka logic hai
import http from 'node:http';
import { LatencyTracker } from './latency_tracker.js';
import { HedgeBudget } from './hedge_budget.js';

export class HedgedProxy {
  constructor(port = 5002, upstreamNodes = [], opts = {}) {
    this.port = port;
    this.upstreamNodes = upstreamNodes;
    this.cursor = 0;

    // p90 pe hedge trigger karenge
    this.targetPercentile = opts.targetPercentile || 90;
    // 15ms floor rakha hai taaki local jitter me faltu me hedge fire na ho
    this.minHedgeFloorMs = opts.minHedgeDelayMs || 15;
    this.maxBudgetRatio = opts.maxBudgetRatio || 0.08; // max 8% extra traffic allowed

    this.tracker = new LatencyTracker(1000, 25);
    this.budget = new HedgeBudget(this.maxBudgetRatio, 10000);
    this.server = null;

    this.metrics = {
      totalRequests: 0,
      hedgedDispatched: 0,
      hedgesWon: 0,
      primaryWonAfterHedge: 0,
      abortedCount: 0,
      budgetBlockedCount: 0,
      primaryFailedFallback: 0,
      hedgeFailedFallback: 0
    };

    this.telemetryHook = null;
  }

  setTelemetryListener(fn) {
    this.telemetryHook = fn;
  }

  // do alag node utha rahe race ke liye (round robin)
  _selectReplicaPair() {
    const total = this.upstreamNodes.length;
    if (total === 0) throw new Error('No upstream replicas configured in HedgedProxy');

    const pIdx = this.cursor % total;
      this.cursor = (this.cursor + 1) % total;
    const sIdx = (pIdx + 1) % total;

    return {
      primary: this.upstreamNodes[pIdx],
      secondary: this.upstreamNodes[sIdx]
    };
  }

  // p90 calculate karo, floor se kam nahi hona chahiye
  _calculateHedgeTimeout() {
    const historicalP90 = this.tracker.getPercentile(this.targetPercentile);
    // floor se kam delay mat do warna local network jitter me faltu race shuru ho jayegi
    return Math.max(this.minHedgeFloorMs, historicalP90);
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        const reqStart = performance.now();
        this.metrics.totalRequests++;
        this.budget.recordRequest();

        const { primary, secondary } = this._selectReplicaPair();
        const hedgeTimeoutMs = this._calculateHedgeTimeout();

        const primaryCtrl = new AbortController();
        let secondaryCtrl = null;
        let hedgeFired = false;
        let hedgeTimer = null;

        // helper function upstream call karne ke liye
        const doFetch = async (node, ctrl, isHedge) => {
          const t0 = performance.now();
          const host = node.host || 'localhost';
          const targetUrl = `http://${host}:${node.port}${req.url}`;

          const upstreamRes = await fetch(targetUrl, {
            method: req.method,
            headers: {
              ...req.headers,
              host: `${host}:${node.port}`
            },
            signal: ctrl.signal
          });

          const buffer = await upstreamRes.arrayBuffer();
          return {
            res: upstreamRes,
            data: buffer,
            node,
            isHedge,
            duration: performance.now() - t0
          };
        };

        // try-catch wrap kiya taaki ek node mare to promise.race crash na kare
        const safeFetch = (node, ctrl, isHedge) =>
          doFetch(node, ctrl, isHedge)
            .then((val) => ({ ok: true, ...val }))
            .catch((err) => ({ ok: false, error: err, node, isHedge }));

        // pehle primary ko hit karo
        const primaryPromise = safeFetch(primary, primaryCtrl, false);

        let secondaryPromise = null;

        // timer: agar primary late hua toh secondary fire hoga
        const hedgeTriggerPromise = new Promise((resolveHedge) => {
          hedgeTimer = setTimeout(() => {
            // budget check karo pehle - overhedge nahi karna warna backend fatt jayega
            if (this.budget.canHedge()) {
              hedgeFired = true;
              this.metrics.hedgedDispatched++;
              secondaryCtrl = new AbortController();
              secondaryPromise = safeFetch(secondary, secondaryCtrl, true);
              resolveHedge(secondaryPromise);
            } else {
              // budget khatam, chup chap baitho
              this.metrics.budgetBlockedCount++;
              resolveHedge(null);
            }
          }, hedgeTimeoutMs);
        });

        try {
          // race karwao dono me
          let winner = await Promise.race([
            primaryPromise,
            hedgeTriggerPromise.then((p) => (p ? p : new Promise(() => {})))
          ]);

          clearTimeout(hedgeTimer);

          // agar jo pehle aaya wo fail ho gaya to dusre ka wait karo (502 bachane ke liye)
          if (!winner.ok) {
            if (!winner.isHedge && secondaryPromise) {
              this.metrics.primaryFailedFallback++;
              winner = await secondaryPromise;
            } else if (winner.isHedge) {
              this.metrics.hedgeFailedFallback++;
              winner = await primaryPromise;
            }
          }

          if (!winner.ok) {
            throw winner.error || new Error('All replicas failed');
          }

          const elapsed = performance.now() - reqStart;
          this.tracker.record(elapsed);

          // jo haar gaya uska connection turant kato, memory aur socket bachao
          if (winner.isHedge) {
            this.metrics.hedgesWon++;
            this.metrics.abortedCount++;
            primaryCtrl.abort();
          } else if (hedgeFired && secondaryCtrl) {
              this.metrics.primaryWonAfterHedge++;
              this.metrics.abortedCount++;
              secondaryCtrl.abort();
          }

          // client ko response bhej do
          res.writeHead(winner.res.status, {
            'Content-Type': winner.res.headers.get('content-type') || 'application/json',
            'X-Proxy-Engine': 'TailSquash',
            'X-Replica-Id': winner.node.id,
            'X-Was-Hedged': hedgeFired ? 'true' : 'false',
            'X-Hedge-Won': winner.isHedge ? 'true' : 'false',
            'X-Hedge-Cutoff-Ms': hedgeTimeoutMs.toFixed(1),
            'X-Total-Elapsed-Ms': elapsed.toFixed(1)
          });
          res.end(Buffer.from(winner.data));

          // dashboard updates
          if (this.telemetryHook) {
            this.telemetryHook({
              type: 'hedged',
              latencyMs: Number(elapsed.toFixed(2)),
              winnerNode: winner.node.id,
              wasHedged: hedgeFired,
              hedgeWon: winner.isHedge,
              hedgeDelayMs: Number(hedgeTimeoutMs.toFixed(2)),
              timestamp: Date.now()
            });
          }
        } catch (err) {
            clearTimeout(hedgeTimer);
            if (primaryCtrl) primaryCtrl.abort();
            if (secondaryCtrl) secondaryCtrl.abort();

            const elapsed = performance.now() - reqStart;
            this.tracker.record(elapsed);

            // dono node dead ya timeout
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: 'Bad Gateway',
              proxy: 'TailSquash',
              message: err.message || 'Upstream service unavailable'
            }));
        }
      });

      this.server.on('error', reject);
      this.server.listen(this.port, resolve);
    });
  }

  getStats() {
    return {
      type: 'hedged',
      port: this.port,
      totalRequests: this.metrics.totalRequests,
      metrics: { ...this.metrics },
      budget: this.budget.getStats(),
      latency: this.tracker.getStats(),
      currentHedgeThresholdMs: Number(this._calculateHedgeTimeout().toFixed(2))
    };
  }

  reset() {
    this.metrics = {
      totalRequests: 0,
      hedgedDispatched: 0,
      hedgesWon: 0,
      primaryWonAfterHedge: 0,
      abortedCount: 0,
      budgetBlockedCount: 0,
      primaryFailedFallback: 0,
      hedgeFailedFallback: 0
    };
    this.tracker.reset();
    this.budget.reset();
  }

  stop() {
    if (this.server) {
      return new Promise((res) => this.server.close(res));
    }
  }
}
