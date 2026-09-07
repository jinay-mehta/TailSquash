// hedge_budget.js - circuit breaker taaki zyada hedging se cluster crash na ho jaye

export class HedgeBudget {
  constructor(maxRatio = 0.08, windowMs = 10000) {
    this.maxRatio = maxRatio;     // max 8% extra traffic allowed
    this.windowMs = windowMs;     // 10 sec sliding window
    this.requests = [];           // request ke timestamps
    this.hedges = [];             // hedge dispatches ke timestamps
    this.rejectedCount = 0;       // kitne hedge budget ki wajah se roke
  }

  // 10 second se purane timestamps nikaal do
  _prune(now) {
    const threshold = now - this.windowMs;
    while (this.requests.length && this.requests[0] < threshold) {
      this.requests.shift();
    }
    while (this.hedges.length && this.hedges[0] < threshold) {
      this.hedges.shift();
    }
  }

  recordRequest() {
    const now = Date.now();
    this.requests.push(now);
    this._prune(now);
  }

  // check karo budget bacha hai ya nahi hedge fire karne ke liye
  canHedge() {
    const now = Date.now();
    this._prune(now);

    const total = this.requests.length;

    // warm-up: agar 20 se kam requests hain window me to max 2 hedge allow karo
    if (total < 20) {
      if (this.hedges.length < 2) {
        this.hedges.push(now);
        return true;
      }
      this.rejectedCount++;
      return false;
    }

    const currentRate = this.hedges.length / total;
    if (currentRate < this.maxRatio) {
      this.hedges.push(now);
      return true;
    }

    // budget cross ho gaya! hedge drop karo warna backend mar jayega
    this.rejectedCount++;
    return false;
  }

  getStats() {
    const now = Date.now();
    this._prune(now);

    const reqCount = this.requests.length;
    const hedgeCount = this.hedges.length;
    const ratioPct = reqCount > 0 ? (hedgeCount / reqCount) * 100 : 0;

    return {
      windowRequests: reqCount,
      windowHedges: hedgeCount,
      currentRatioPercent: Number(ratioPct.toFixed(2)),
      maxAllowedPercent: this.maxRatio * 100,
      throttledCount: this.rejectedCount,
      budgetHealthy: ratioPct <= (this.maxRatio * 100)
    };
  }

  reset() {
    this.requests = [];
    this.hedges = [];
    this.rejectedCount = 0;
  }
}
