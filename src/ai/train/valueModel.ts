// The value model and the output-unit mapping the MCTS depends on.
//
// MctsAgent.selectChild scores a child with `sign * (value/visits)`, centred on 0
// in (−1,1), where +1 means rootSide wins. Plugging in a raw sigmoid P(win) ∈ [0,1]
// would break the opponent's minimiser. So the model exposes
// value(x) = 2·σ(z) − 1 ∈ (−1,1), the same convention as the tanh of leafValue,
// and keeps prob(x) = σ(z) for calibration and metrics.
//
// Inputs are encode2 vectors (single perspective: x is in the frame of the side to
// move, so value(x) is that side's value, which is what a leaf needs when encoded
// from rootSide).
import { sigmoid, type LogisticFit } from "./logistic";

export interface ValueModelJson {
  schema: "logistic-v1";
  dim: number;
  w: number[];
  b: number;
}

export class LogisticValueModel {
  readonly w: Float32Array;
  readonly b: number;
  constructor(w: Float32Array, b: number) {
    this.w = w;
    this.b = b;
  }

  static fromFit(fit: LogisticFit): LogisticValueModel {
    return new LogisticValueModel(fit.w, fit.b);
  }

  private logit(x: ArrayLike<number>): number {
    let z = this.b;
    const w = this.w;
    for (let j = 0; j < w.length; j++) z += w[j] * x[j];
    return z;
  }

  /** Calibrated win probability σ(z) ∈ [0,1]. */
  prob(x: ArrayLike<number>): number {
    return sigmoid(this.logit(x));
  }

  /** MCTS-ready value ∈ (−1,1): +1 ⇒ the to-move side wins. = 2·prob − 1. */
  value(x: ArrayLike<number>): number {
    return 2 * sigmoid(this.logit(x)) - 1;
  }

  toJSON(): ValueModelJson {
    return { schema: "logistic-v1", dim: this.w.length, w: Array.from(this.w), b: this.b };
  }

  static fromJSON(j: ValueModelJson): LogisticValueModel {
    if (j.schema !== "logistic-v1") throw new Error(`unexpected value-model schema ${j.schema}`);
    return new LogisticValueModel(Float32Array.from(j.w), j.b);
  }
}
