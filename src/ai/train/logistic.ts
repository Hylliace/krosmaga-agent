// Logistic-regression baseline over the encode2 features. The first learned model:
// it predicts P(win | end-of-turn board, side to move). It (a) tests the whole
// pipeline end to end (raw → encode2 → samples → fit → value) and (b) fixes the
// output-unit mapping the MCTS needs, see valueModel.ts.
//
// Pure and dependency-free (one seeded Rng for shuffling). Works on the f32 layout
// of the encoded shards: X = Float32Array(nRows*dim) row-major, t = labels ∈ {0,1}.
import { Rng } from "../../engine/rng";

export interface LogisticFit {
  w: Float32Array;
  b: number;
}

export interface FitOpts {
  epochs?: number;
  lr?: number;       // learning rate
  l2?: number;       // L2 weight decay (not applied to bias)
  batchSize?: number;
  rng?: Rng;
}

export function sigmoid(z: number): number {
  // Numerically stable on both signs.
  if (z >= 0) { const e = Math.exp(-z); return 1 / (1 + e); }
  const e = Math.exp(z); return e / (1 + e);
}

/** Minibatch SGD logistic regression. `rows` selects the training subset of X/t
 *  (so train/val share the same backing buffers). Labels t ∈ {0,1}. */
export function fitLogistic(X: Float32Array, t: Float32Array, dim: number, rows: number[], opts: FitOpts = {}): LogisticFit {
  const epochs = opts.epochs ?? 20;
  const lr = opts.lr ?? 0.1;
  const l2 = opts.l2 ?? 1e-4;
  const batch = Math.max(1, opts.batchSize ?? 256);
  const rng = opts.rng ?? new Rng(0x5eed1);

  const w = new Float32Array(dim);
  let b = 0;
  const order = rows.slice();
  const gw = new Float64Array(dim);

  for (let ep = 0; ep < epochs; ep++) {
    rng.shuffle(order);
    for (let s = 0; s < order.length; s += batch) {
      const end = Math.min(order.length, s + batch);
      gw.fill(0);
      let gb = 0;
      for (let k = s; k < end; k++) {
        const r = order[k];
        const base = r * dim;
        let z = b;
        for (let j = 0; j < dim; j++) z += w[j] * X[base + j];
        const d = sigmoid(z) - t[r];
        for (let j = 0; j < dim; j++) gw[j] += d * X[base + j];
        gb += d;
      }
      const inv = 1 / (end - s);
      for (let j = 0; j < dim; j++) w[j] -= lr * (gw[j] * inv + l2 * w[j]);
      b -= lr * gb * inv;
    }
  }
  return { w, b };
}

export interface Metrics {
  brier: number;
  logloss: number;
  acc: number;
  base: number; // positive-label rate (the no-skill baseline)
  n: number;
}

export function evalMetrics(X: Float32Array, t: Float32Array, dim: number, rows: number[], fit: LogisticFit): Metrics {
  let brier = 0, logloss = 0, correct = 0, pos = 0;
  for (const r of rows) {
    const base = r * dim;
    let z = fit.b;
    for (let j = 0; j < dim; j++) z += fit.w[j] * X[base + j];
    const p = sigmoid(z);
    const y = t[r];
    brier += (p - y) * (p - y);
    logloss += -(y * Math.log(Math.max(p, 1e-12)) + (1 - y) * Math.log(Math.max(1 - p, 1e-12)));
    if ((p >= 0.5 ? 1 : 0) === y) correct++;
    pos += y;
  }
  const n = rows.length || 1;
  return { brier: brier / n, logloss: logloss / n, acc: correct / n, base: pos / n, n: rows.length };
}

/** Split row indices into train/val by group (game ordinal from idx.u32), so a
 *  game's correlated intra-turn rows never straddle the split (no leakage). */
export function splitByGroup(groups: ArrayLike<number>, valFrac: number, rng: Rng): { train: number[]; val: number[] } {
  const uniq = [...new Set(Array.from(groups as ArrayLike<number>))];
  rng.shuffle(uniq);
  const nVal = Math.round(uniq.length * valFrac);
  const valSet = new Set(uniq.slice(0, nVal));
  const train: number[] = [], val: number[] = [];
  for (let r = 0; r < groups.length; r++) (valSet.has(groups[r]) ? val : train).push(r);
  return { train, val };
}

/** Convert labels y ∈ {+1,-1} to logistic targets t ∈ {1,0}. */
export function labelsToTargets(y: Float32Array): Float32Array {
  const t = new Float32Array(y.length);
  for (let i = 0; i < y.length; i++) t[i] = y[i] > 0 ? 1 : 0;
  return t;
}
