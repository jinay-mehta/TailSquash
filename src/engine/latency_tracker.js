// latency_tracker.js - sliding window percentile calculator adaptive hedging ke liye

export class LatencyTracker {
  constructor(windowSize = 1000, fallbackP90 = 25) {
    this.windowSize = windowSize;
    this.fallbackP90 = fallbackP90; // shuru me jab tak data na ho tab tak fallback
    this.samples = [];
    this.sortedCache = null;
    this.totalRecorded = 0;
  }

  // sample record karo (ms me)
  record(ms) {
    if (typeof ms !== 'number' || isNaN(ms) || ms < 0) return;

    this.samples.push(ms);
    this.totalRecorded++;

    // ring buffer jaisa: windowSize se bada ho to purana hatao
    if (this.samples.length > this.windowSize) {
      this.samples.shift();
    }

    // naya data aaya to purana sorted cache bekar
    this.sortedCache = null;
  }

  // lazy sort taaki ek hi tick me baar baar sort na chale
  _sorted() {
    if (!this.sortedCache) {
      this.sortedCache = this.samples.slice().sort((a, b) => a - b);
    }
    return this.sortedCache;
  }

  getPercentile(pct) {
    // warm-up check: agar 10 se kam sample hain to percentile calculate karna bewakoofi hai
    if (this.samples.length < 10) {
      if (pct >= 95) return this.fallbackP90 * 1.4;
      if (pct >= 90) return this.fallbackP90;
      return this.fallbackP90 * 0.6;
    }

    const arr = this._sorted();
    // nearest-rank logic
    const idx = Math.min(
      arr.length - 1,
      Math.max(0, Math.ceil((pct / 100) * arr.length) - 1)
    );
    return arr[idx];
  }

  getP50() { return this.getPercentile(50); }
  getP90() { return this.getPercentile(90); }
  getP95() { return this.getPercentile(95); }
  getP99() { return this.getPercentile(99); }

  getSummary() {
    const len = this.samples.length;
    if (len === 0) {
      return { count: 0, p50: 0, p90: 0, p95: 0, p99: 0, avg: 0, min: 0, max: 0 };
    }

    const arr = this._sorted();
    let sum = 0;
    for (let i = 0; i < len; i++) sum += arr[i];

    return {
      count: len,
      p50: this.getP50(),
      p90: this.getP90(),
      p95: this.getP95(),
      p99: this.getP99(),
      avg: Number((sum / len).toFixed(2)),
      min: arr[0],
      max: arr[len - 1]
    };
  }

  getStats() {
    const summary = this.getSummary();
    return {
      samplesInWindow: summary.count,
      totalRecorded: this.totalRecorded,
      p50: summary.p50,
      p90: summary.p90,
      p95: summary.p95,
      p99: summary.p99,
      avg: summary.avg
    };
  }

  reset() {
    this.samples = [];
    this.sortedCache = null;
    this.totalRecorded = 0;
  }
}
