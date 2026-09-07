// app.js - TailSquash telemetry dashboard controller
// Connects to SSE endpoint at /api/stream and renders real-time latency graphs.

let timelineChart = null;
let percentileChart = null;
const MAX_SAMPLES_DISPLAY = 35;

const state = {
  labels: [],
  stdLatencies: [],
  hedgeLatencies: []
};

// Initialize Chart.js with light-theme friendly palettes
function setupCharts() {
  const ctxTimeline = document.getElementById('timelineChart').getContext('2d');
  timelineChart = new Chart(ctxTimeline, {
    type: 'line',
    data: {
      labels: state.labels,
      datasets: [
        {
          label: 'Standard (Baseline)',
          data: state.stdLatencies,
          borderColor: '#dc2626',
          backgroundColor: 'rgba(220, 38, 38, 0.05)',
          borderWidth: 1.8,
          pointRadius: 2,
          tension: 0.1
        },
        {
          label: 'TailSquash',
          data: state.hedgeLatencies,
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37, 99, 235, 0.08)',
          borderWidth: 2,
          pointRadius: 2,
          tension: 0.1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: { display: false },
        y: {
          title: { display: true, text: 'Round-Trip (ms)', color: '#64748b', font: { size: 11 } },
          grid: { color: '#f1f5f9' },
          ticks: { color: '#64748b', font: { size: 10 } },
          min: 0,
          suggestedMax: 100
        }
      },
      plugins: { legend: { display: false } }
    }
  });

  const ctxPercentile = document.getElementById('percentileChart').getContext('2d');
  percentileChart = new Chart(ctxPercentile, {
    type: 'bar',
    data: {
      labels: ['P50', 'P90', 'P95', 'P99', 'P99.9'],
      datasets: [
        {
          label: 'Standard',
          data: [0, 0, 0, 0, 0],
          backgroundColor: '#dc2626',
          borderRadius: 3
        },
        {
          label: 'TailSquash',
          data: [0, 0, 0, 0, 0],
          backgroundColor: '#059669',
          borderRadius: 3
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          title: { display: true, text: 'ms', color: '#64748b', font: { size: 11 } },
          grid: { color: '#f1f5f9' },
          ticks: { color: '#64748b', font: { size: 10 } },
          min: 0
        },
        x: {
          ticks: { color: '#475569', font: { size: 10 } },
          grid: { display: false }
        }
      },
      plugins: {
        legend: {
          labels: { color: '#334155', boxWidth: 10, font: { size: 11 } }
        }
      }
    }
  });
}

function pushTimelineSample(stdMs, hedgeMs) {
  state.labels.push(new Date().toLocaleTimeString());
  state.stdLatencies.push(stdMs);
  state.hedgeLatencies.push(hedgeMs);

  if (state.labels.length > MAX_SAMPLES_DISPLAY) {
    state.labels.shift();
    state.stdLatencies.shift();
    state.hedgeLatencies.shift();
  }

  timelineChart.update('none');
}

// Fetch complete system statistics from server
async function refreshMetrics() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) return;
    const data = await res.json();

    const stdLat = data.standardProxy.latency;
    const hedgeLat = data.hedgedProxy.latency;
    const metrics = data.hedgedProxy.metrics;
    const budget = data.hedgedProxy.budget;

    // P99 Card
    document.getElementById('stdP99Val').textContent = `${stdLat.p99.toFixed(1)} ms`;
    document.getElementById('hedgeP99Val').textContent = `${hedgeLat.p99.toFixed(1)} ms`;

    const badge = document.getElementById('p99SavingsBadge');
    if (stdLat.p99 > 0 && stdLat.p99 > hedgeLat.p99) {
      const reduction = (((stdLat.p99 - hedgeLat.p99) / stdLat.p99) * 100).toFixed(0);
      badge.textContent = `${reduction}% Faster`;
      badge.className = 'pill pill-success';
    } else {
      badge.textContent = '--%';
    }

    // Budget & Overhead
    const total = metrics.totalRequests || data.hedgedProxy.totalRequests || 0;
    const hedgedCount = metrics.hedgedDispatched || 0;
    const overheadPct = total > 0 ? (hedgedCount / total) * 100 : (budget.currentRatioPercent || 0);

    document.getElementById('overheadPercentVal').textContent = `${overheadPct.toFixed(1)}%`;
    document.getElementById('hedgedCountVal').textContent = hedgedCount;
    document.getElementById('totalReqVal').textContent = total;

    const maxAllowed = budget.maxAllowedPercent || 8;
    const meterPct = Math.min(100, (overheadPct / maxAllowed) * 100);
    document.getElementById('budgetProgressBar').style.width = `${meterPct}%`;

    const statusBadge = document.getElementById('budgetStatusBadge');
    if (statusBadge) {
      if (budget.throttledCount > 0 || overheadPct > maxAllowed) {
        statusBadge.textContent = 'Throttling';
        statusBadge.className = 'pill pill-danger';
      } else {
        statusBadge.textContent = 'Budget OK';
        statusBadge.className = 'pill pill-blue';
      }
    }

    // Rescues & Socket Kills
    document.getElementById('hedgesWonVal').textContent = metrics.hedgesWon;
    document.getElementById('hedgeWinsBadge').textContent = `${metrics.hedgesWon}`;
    document.getElementById('abortedVal').textContent = metrics.abortedCount;

    // Adaptive Hedge Cutoff Indicator
    document.getElementById('dynamicHedgeCutoff').textContent =
      `${data.hedgedProxy.currentHedgeThresholdMs.toFixed(1)} ms (P90)`;

    // Update Percentile Bar Chart
    if (percentileChart) {
      percentileChart.data.datasets[0].data = [
        stdLat.p50, stdLat.p90, stdLat.p95, stdLat.p99, stdLat.p999 || stdLat.p99
      ];
      percentileChart.data.datasets[1].data = [
        hedgeLat.p50, hedgeLat.p90, hedgeLat.p95, hedgeLat.p99, hedgeLat.p999 || hedgeLat.p99
      ];
      percentileChart.update('none');
    }

    // Cluster Replica Health
    const nodeStats = data.cluster.stats;
    if (nodeStats['node-a']) {
      document.getElementById('nodeAReqs').textContent = nodeStats['node-a'].requests;
      document.getElementById('nodeAStalls').textContent = nodeStats['node-a'].stragglers;
    }
    if (nodeStats['node-b']) {
      document.getElementById('nodeBReqs').textContent = nodeStats['node-b'].requests;
      document.getElementById('nodeBStalls').textContent = nodeStats['node-b'].stragglers;
    }
    if (nodeStats['node-c']) {
      document.getElementById('nodeCReqs').textContent = nodeStats['node-c'].requests;
      document.getElementById('nodeCStalls').textContent = nodeStats['node-c'].stragglers;
    }

    // Traffic Toggle Button
    const btnText = document.getElementById('btnTrafficText');
    const btn = document.getElementById('btnToggleTraffic');
    if (data.autoTrafficActive) {
      btn.classList.add('btn-danger');
      btnText.textContent = 'Pause Load';
    } else {
      btn.classList.remove('btn-danger');
      btnText.textContent = 'Start Load';
    }
  } catch (err) {
    console.warn('[refreshMetrics] Error:', err);
  }
}

// Log Feed Entry
function appendTerminalEntry(data) {
  const feed = document.getElementById('logStream');
  const entry = document.createElement('div');

  if (data.wasHedged && data.hedgeWon) {
    entry.className = 'feed-entry rescue';
    entry.innerHTML = `
      <span>[RESCUE] Replica ${data.winnerNode.toUpperCase()} won in ${data.hedgedLatency}ms</span>
      <span>+${data.latencySavedMs}ms saved</span>
    `;
  } else if (data.standardLatency > 300) {
    entry.className = 'feed-entry stall';
    entry.innerHTML = `
      <span>[STALL] Standard blocked (${data.standardLatency}ms)</span>
      <span>Hedge completed in ${data.hedgedLatency}ms</span>
    `;
  } else {
    entry.className = 'feed-entry';
    entry.innerHTML = `
      <span>[PARITY] Std ${data.standardLatency}ms | Hedge ${data.hedgedLatency}ms</span>
      <span>OK</span>
    `;
  }

  feed.insertBefore(entry, feed.firstChild);
  if (feed.children.length > 35) {
    feed.removeChild(feed.lastChild);
  }
}

// Connect to Server-Sent Events
function startEventStream() {
  const sse = new EventSource('/api/stream');

  sse.addEventListener('request_pair', (e) => {
    const item = JSON.parse(e.data);
    pushTimelineSample(item.standardLatency, item.hedgedLatency);
    appendTerminalEntry(item);
    refreshMetrics();
  });

  sse.addEventListener('stats_reset', () => {
    state.labels = [];
    state.stdLatencies = [];
    state.hedgeLatencies = [];
    timelineChart.data.labels = [];
    timelineChart.data.datasets[0].data = [];
    timelineChart.data.datasets[1].data = [];
    timelineChart.update();
    refreshMetrics();
  });
}

// Setup User Interactions & Keyboard Shortcuts
function bindActions() {
  // Auto stream toggle
  const toggleTraffic = async () => {
    await fetch('/api/traffic/toggle', { method: 'POST' });
    refreshMetrics();
  };
  document.getElementById('btnToggleTraffic').addEventListener('click', toggleTraffic);

  // Burst 50
  const triggerBurst = async () => {
    const btn = document.getElementById('btnBurst');
    btn.disabled = true;
    btn.innerHTML = '<span>In-Flight...</span>';
    try {
      await fetch('/api/test/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 50, delayBetweenMs: 40 })
      });
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = '<span>Burst 50</span>';
      }, 2400);
    }
  };
  document.getElementById('btnBurst').addEventListener('click', triggerBurst);

  // Single step
  const triggerSingle = async () => {
    await fetch('/api/test/single', { method: 'POST' });
  };
  document.getElementById('btnSingle').addEventListener('click', triggerSingle);

  // Reset
  const triggerReset = async () => {
    await fetch('/api/reset', { method: 'POST' });
  };
  document.getElementById('btnReset').addEventListener('click', triggerReset);

  // Straggler Slider
  const slider = document.getElementById('stragglerSlider');
  const sliderLabel = document.getElementById('stragglerRateDisplay');
  slider.addEventListener('input', (e) => {
    sliderLabel.textContent = `${parseFloat(e.target.value).toFixed(1)}%`;
  });
  slider.addEventListener('change', async (e) => {
    const val = parseFloat(e.target.value) / 100;
    await fetch('/api/chaos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stragglerRate: val, targetedNodeStall: null })
    });
  });

  // Force 1000ms Stall
  document.getElementById('btnInjectStall').addEventListener('click', async () => {
    await fetch('/api/chaos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stragglerRate: 1.0, stragglerDelayMin: 1000, stragglerDelayMax: 1200 })
    });
    await triggerSingle();
    setTimeout(async () => {
      await fetch('/api/chaos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stragglerRate: 0.05, stragglerDelayMin: 600, stragglerDelayMax: 1100 })
      });
    }, 2000);
  });

  // Degrade Node Beta
  document.getElementById('btnDegradeNode').addEventListener('click', async () => {
    await fetch('/api/chaos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetedNodeStall: 'node-b' })
    });
    document.getElementById('cardNodeB').style.borderColor = '#dc2626';
  });

  // Reset Chaos
  document.getElementById('btnResetChaos').addEventListener('click', async () => {
    await fetch('/api/chaos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stragglerRate: 0.05, stragglerDelayMin: 600, stragglerDelayMax: 1100, targetedNodeStall: null })
    });
    slider.value = 5;
    sliderLabel.textContent = '5.0%';
    document.getElementById('cardNodeB').style.borderColor = '#e2e8f0';
  });

  // Global Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;

    if (e.key === ' ' || e.key === 'b' || e.key === 'B') {
      e.preventDefault();
      triggerBurst();
    } else if (e.key === 's' || e.key === 'S') {
      triggerSingle();
    } else if (e.key === 'a' || e.key === 'A') {
      toggleTraffic();
    } else if (e.key === 'r' || e.key === 'R') {
      triggerReset();
    }
  });
}

// App Bootstrap
window.addEventListener('DOMContentLoaded', () => {
  setupCharts();
  startEventStream();
  bindActions();
  refreshMetrics();
  setInterval(refreshMetrics, 2000);
});
