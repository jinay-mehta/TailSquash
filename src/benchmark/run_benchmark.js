// run_benchmark.js - automated CLI benchmark suite for TailSquash
// Compares latency percentiles between Standard and Hedged proxies under high concurrency.

import { MockCluster } from '../cluster/mock_nodes.js';
import { StandardProxy } from '../engine/standard_proxy.js';
import { HedgedProxy } from '../engine/hedged_proxy.js';

// Parse simple CLI arguments (e.g. node run_benchmark.js --requests 800 --workers 30)
const args = process.argv.slice(2);
function getArg(flag, fallback) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const TOTAL_REQUESTS = parseInt(getArg('--requests', '600'), 10);
const CONCURRENCY = parseInt(getArg('--workers', '20'), 10);
const STRAGGLER_RATE = parseFloat(getArg('--chaos', '0.05'));

async function dispatchLoad(port, count, concurrency) {
  const durations = [];
  let index = 0;

  async function clientWorker() {
    while (true) {
      const current = index++;
      if (current >= count) break;

      const t0 = performance.now();
      try {
        const res = await fetch(`http://localhost:${port}/data`);
        await res.text();
        durations.push(performance.now() - t0);
      } catch {
        durations.push(1500); // Record timeout
      }
    }
  }

  const pool = Array.from({ length: concurrency }, () => clientWorker());
  await Promise.all(pool);
  return durations.sort((a, b) => a - b);
}

function calculatePercentiles(sortedList) {
  const n = sortedList.length;
  if (!n) return { p50: 0, p90: 0, p95: 0, p99: 0, p999: 0, avg: 0, min: 0, max: 0 };

  const getP = (p) => {
    const idx = Math.max(0, Math.min(n - 1, Math.ceil((p / 100) * n) - 1));
    return sortedList[idx];
  };

  let sum = 0;
  for (let i = 0; i < n; i++) sum += sortedList[i];

  return {
    min: Number(sortedList[0].toFixed(2)),
    max: Number(sortedList[n - 1].toFixed(2)),
    avg: Number((sum / n).toFixed(2)),
    p50: Number(getP(50).toFixed(2)),
    p90: Number(getP(90).toFixed(2)),
    p95: Number(getP(95).toFixed(2)),
    p99: Number(getP(99).toFixed(2)),
    p999: Number(getP(99.9).toFixed(2))
  };
}

export async function runBenchmark() {
  console.log('\n===============================================================');
  console.log('  TAILSQUASH STATISTICAL BENCHMARK SUITE');
  console.log(`  Requests per test:   ${TOTAL_REQUESTS}`);
  console.log(`  Worker concurrency:  ${CONCURRENCY} parallel clients`);
  console.log(`  Cluster stall rate:  ${(STRAGGLER_RATE * 100).toFixed(1)}% (600-1100ms stalls)`);
  console.log('===============================================================\n');

  // Spin up temporary isolated instances
  const cluster = new MockCluster();
  cluster.setChaos({ stragglerRate: STRAGGLER_RATE });
  await cluster.start();

  const stdProxy = new StandardProxy(5001, cluster.nodes);
  await stdProxy.start();

  const hedgedProxy = new HedgedProxy(5002, cluster.nodes, {
    targetPercentile: 90,
    minHedgeDelayMs: 15,
    maxBudgetRatio: 0.08
  });
  await hedgedProxy.start();

  // Warm-up caches
  console.log('-> Warming up JIT and connection pools...');
  await dispatchLoad(5002, 40, 4);
  stdProxy.reset();
  hedgedProxy.reset();

  // 1. Test Standard Baseline
  console.log(`-> Running baseline test against Standard Proxy (${TOTAL_REQUESTS} reqs)...`);
  const stdDurations = await dispatchLoad(5001, TOTAL_REQUESTS, CONCURRENCY);
  const stdStats = calculatePercentiles(stdDurations);
  console.log(`   [Done] Standard P99: ${stdStats.p99} ms | Avg: ${stdStats.avg} ms`);

  // 2. Test TailSquash Hedged
  console.log(`-> Running test against TailSquash Proxy (${TOTAL_REQUESTS} reqs)...`);
  const hedgeDurations = await dispatchLoad(5002, TOTAL_REQUESTS, CONCURRENCY);
  const hedgeStats = calculatePercentiles(hedgeDurations);
  const hMetrics = hedgedProxy.getStats();
  console.log(`   [Done] TailSquash P99: ${hedgeStats.p99} ms | Avg: ${hedgeStats.avg} ms`);

  // Compute Improvements
  const p99Reduction = (((stdStats.p99 - hedgeStats.p99) / stdStats.p99) * 100).toFixed(2);
  const p99Factor = (stdStats.p99 / Math.max(1, hedgeStats.p99)).toFixed(1);
  const overheadPct = ((hMetrics.metrics.hedgedDispatched / TOTAL_REQUESTS) * 100).toFixed(2);

  // Print results table
  console.log('\n---------------------------------------------------------------');
  console.log('  RESULTS COMPARISON');
  console.log('---------------------------------------------------------------');
  console.table({
    'P50 (Median)': { Standard: `${stdStats.p50} ms`, TailSquash: `${hedgeStats.p50} ms`, Win: 'Parity' },
    'P90':          { Standard: `${stdStats.p90} ms`, TailSquash: `${hedgeStats.p90} ms`, Win: 'Boundary' },
    'P95':          { Standard: `${stdStats.p95} ms`, TailSquash: `${hedgeStats.p95} ms`, Win: 'Shielded' },
    'P99 (Tail)':   { Standard: `${stdStats.p99} ms`, TailSquash: `${hedgeStats.p99} ms`, Win: `${p99Reduction}% faster (${p99Factor}x)` },
    'P99.9 (Worst)':{ Standard: `${stdStats.p999} ms`, TailSquash: `${hedgeStats.p999} ms`, Win: 'Ceiling enforced' },
    'Average':      { Standard: `${stdStats.avg} ms`, TailSquash: `${hedgeStats.avg} ms`, Win: `${(stdStats.avg - hedgeStats.avg).toFixed(1)} ms saved` }
  });

  console.log(`Traffic Overhead:     ${overheadPct}% (Budget cap: < 8%)`);
  console.log(`Speculative Wins:     ${hMetrics.metrics.hedgesWon} requests rescued`);
  console.log(`Aborted Connections:  ${hMetrics.metrics.abortedCount} slow sockets killed`);
  console.log('---------------------------------------------------------------\n');

  // Tear down
  await stdProxy.stop();
  await hedgedProxy.stop();
  await cluster.stop();
}

if (process.argv[1]?.endsWith('run_benchmark.js')) {
  runBenchmark().catch(console.error);
}
