// Logistic baseline and value-mapping check. Self-contained (synthetic data), so it
// is fast and needs no dataset on disk.
import { describe, it, expect } from "vitest";
import { Rng } from "../../engine/rng";
import { fitLogistic, evalMetrics, splitByGroup, labelsToTargets, sigmoid } from "./logistic";
import { LogisticValueModel } from "./valueModel";

// Build a linearly-separable-ish dataset: t = 1 iff w*·x + noise > 0.
function makeData(n: number, dim: number, rng: Rng): { X: Float32Array; t: Float32Array; idx: Uint32Array } {
  const wStar = new Float32Array(dim);
  for (let j = 0; j < dim; j++) wStar[j] = rng.next() * 2 - 1;
  const X = new Float32Array(n * dim);
  const t = new Float32Array(n);
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let z = 0;
    for (let j = 0; j < dim; j++) { const v = rng.next() * 2 - 1; X[i * dim + j] = v; z += wStar[j] * v; }
    z += (rng.next() * 2 - 1) * 0.2; // small label noise
    t[i] = z > 0 ? 1 : 0;
    idx[i] = Math.floor(i / 6); // ~6 rows per "game"
  }
  return { X, t, idx };
}

describe("logistic baseline", () => {
  it("fits separable data: val accuracy high, beats the base-rate Brier", () => {
    const rng = new Rng(42);
    const dim = 10;
    const { X, t, idx } = makeData(900, dim, rng);
    const { train, val } = splitByGroup(idx, 0.2, new Rng(7));
    expect(train.length).toBeGreaterThan(0);
    expect(val.length).toBeGreaterThan(0);
    // disjoint by game
    const trGames = new Set(train.map((r) => idx[r]));
    expect(val.every((r) => !trGames.has(idx[r]))).toBe(true);

    const fit = fitLogistic(X, t, dim, train, { epochs: 40, lr: 0.5, l2: 1e-4, rng: new Rng(1) });
    const m = evalMetrics(X, t, dim, val, fit);
    expect(m.acc).toBeGreaterThan(0.85);
    expect(m.brier).toBeLessThan(0.2);
    // base-rate Brier = p(1-p) where p = positive rate; the fit must beat it.
    expect(m.brier).toBeLessThan(m.base * (1 - m.base));
  });

  it("value(x) is the (−1,1) unit mapping = 2σ(z)−1, monotone in the logit", () => {
    const w = Float32Array.from([2, -1, 0.5]);
    const model = new LogisticValueModel(w, 0.1);
    const x = [1, 0, 2];
    let z = 0.1; for (let j = 0; j < 3; j++) z += w[j] * x[j];
    expect(model.prob(x)).toBeCloseTo(sigmoid(z), 12);
    expect(model.value(x)).toBeCloseTo(2 * sigmoid(z) - 1, 12);
    expect(model.value(x)).toBeGreaterThan(-1);
    expect(model.value(x)).toBeLessThan(1);
    // a strongly-positive logit → value near +1; strongly-negative → near −1.
    expect(new LogisticValueModel(Float32Array.from([10]), 0).value([1])).toBeGreaterThan(0.99);
    expect(new LogisticValueModel(Float32Array.from([10]), 0).value([-1])).toBeLessThan(-0.99);
  });

  it("round-trips through JSON unchanged", () => {
    const model = new LogisticValueModel(Float32Array.from([0.3, -0.7, 1.1, 0]), -0.2);
    const back = LogisticValueModel.fromJSON(model.toJSON());
    const x = [1, 2, -1, 5];
    expect(back.value(x)).toBeCloseTo(model.value(x), 12);
    expect(back.w.length).toBe(model.w.length);
  });

  it("labelsToTargets maps ±1 → {1,0}", () => {
    const y = Float32Array.from([1, -1, 1, -1]);
    expect(Array.from(labelsToTargets(y))).toEqual([1, 0, 1, 0]);
  });
});
