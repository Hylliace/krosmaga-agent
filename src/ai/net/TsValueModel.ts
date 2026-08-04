// Pure-TS synchronous inference for the ValueNet. Reproduces the forward of model.py
// exactly (Conv2d / BatchNorm in eval mode / ReLU / Linear / tanh), so live play needs
// no Python, no native dependency and no async in the MCTS. Parity with PyTorch is
// checked in CI (TsValueModel.test.ts, |TS−PyTorch| < 1e-4).
//
// Reads the output of export.py: a flat float32 weight blob plus a manifest tensor
// table. BatchNorm runs in eval mode (running stats), reproduced as it is (no
// folding), so the math matches very closely.
import { N_PLANES2 } from "../encode2";
import { PLANE, conv2d, conv2dSparseIn, linear, linearSparseIn, bnEval, reluInPlace, buildTensors, type Tensor, type NnManifest } from "./nnOps";
import { stageWeights, convWasm, convSparseWasm } from "./convWasm";

export type TsManifest = NnManifest & { n_planes?: number; n_globals?: number; n_v?: number };

export class TsValueModel {
  private t = new Map<string, Tensor>();
  readonly encLen: number;
  readonly channels: number;
  readonly blocks: number;
  readonly vLen: number;
  readonly eps: number;
  // v3: layout comes from the manifest; pre-v3 manifests fall back to the
  // frozen v2 constants (43 planes / 91 globals).
  readonly nPlanes: number;
  readonly nGlobals: number;
  private readonly planesLen: number;
  private readonly header: number;

  // WASM SIMD conv backend: the tower convs run ~4.6x faster when the module compiled
  // and the blob is staged; otherwise every call falls back to the TS loop. Precision:
  // wasm accumulates lanewise in f32 (like PyTorch) while the TS loop keeps f64
  // intermediates; the differences are ~1e-6, well inside the 1e-4 PyTorch parity test
  // that covers this file.
  private readonly wasmOk: boolean;

  constructor(manifest: TsManifest, weights: Float32Array) {
    this.t = buildTensors(manifest, weights);
    this.wasmOk = stageWeights(weights);
    this.encLen = manifest.enc_len;
    this.channels = manifest.channels;
    this.blocks = manifest.blocks;
    this.vLen = manifest.v_len;
    this.eps = manifest.bn_eps;
    this.nPlanes = manifest.n_planes ?? N_PLANES2;
    this.nGlobals = manifest.n_globals ?? 91;
    this.planesLen = this.nPlanes * PLANE;
    this.header = this.planesLen + this.nGlobals;
  }

  private get(key: string): Tensor {
    const t = this.t.get(key);
    if (!t) throw new Error(`missing tensor ${key}`);
    return t;
  }

  /** value ∈ (−1,1): +1 ⇒ the to-move side (x's perspective) wins. */
  value(x: ArrayLike<number>): number {
    return Math.tanh(this.logit(x));
  }

  /** Pre-tanh value (unbounded). Parity vs PyTorch is checked here. */
  logit(x: ArrayLike<number>): number {
    const C = this.channels;

    // planes (C0 = nPlanes, 5×10) → conv stem → BN → ReLU. The raw encoding is
    // very sparse (v3: ~25 of 215 planes non-zero) → sparse-input stem, exact.
    const planes = new Float32Array(this.planesLen);
    for (let i = 0; i < this.planesLen; i++) planes[i] = x[i];
    let cur = (this.wasmOk ? convSparseWasm(planes, this.get("stem.0.weight").data, this.nPlanes, C) : null)
      ?? conv2dSparseIn(planes, this.get("stem.0.weight").data, this.nPlanes, C);
    this.bn(cur, "stem.1", C);
    reluInPlace(cur);

    // residual tower (wasm SIMD conv when available, TS loop otherwise)
    for (let b = 0; b < this.blocks; b++) {
      const p = `tower.${b}.`;
      const w1 = this.get(p + "c1.weight").data;
      let h = (this.wasmOk ? convWasm(cur, w1, C, C) : null) ?? conv2d(cur, w1, C, C);
      this.bn(h, p + "b1", C);
      reluInPlace(h);
      const w2 = this.get(p + "c2.weight").data;
      h = (this.wasmOk ? convWasm(h, w2, C, C) : null) ?? conv2d(h, w2, C, C);
      this.bn(h, p + "b2", C);
      for (let i = 0; i < cur.length; i++) cur[i] = Math.max(0, cur[i] + h[i]); // ReLU(x+h)
    }

    // plane_fc(flatten) → (ReLU applied at concat); post-ReLU input is ~half
    // zeros, linearSparseIn falls back to dense when it is not sparse enough.
    const pf = linearSparseIn(cur, this.get("plane_fc.weight"), this.get("plane_fc.bias").data);
    reluInPlace(pf);

    // globals MLP
    const g0 = new Float32Array(this.nGlobals);
    for (let i = 0; i < this.nGlobals; i++) g0[i] = x[this.planesLen + i];
    let g = linear(g0, this.get("glob.0.weight"), this.get("glob.0.bias").data);
    reluInPlace(g);
    g = linear(g, this.get("glob.2.weight"), this.get("glob.2.bias").data);
    reluInPlace(g);

    // V-vectors (dropout is identity at eval) → vfc → ReLU at concat. Multihots
    // over the vocab: ~150 non-zero of ~9600 → sparse-input linear, exact.
    const v = new Float32Array(this.vLen);
    for (let i = 0; i < this.vLen; i++) v[i] = x[this.header + i];
    const vv = linearSparseIn(v, this.get("vfc.weight"), this.get("vfc.bias").data);
    reluInPlace(vv);

    // concat [pf(96), g(48), vv(128)] → trunk → value head → tanh
    const cat = new Float32Array(pf.length + g.length + vv.length);
    cat.set(pf, 0); cat.set(g, pf.length); cat.set(vv, pf.length + g.length);
    let h = linear(cat, this.get("trunk.0.weight"), this.get("trunk.0.bias").data);
    reluInPlace(h);
    h = linear(h, this.get("trunk.3.weight"), this.get("trunk.3.bias").data);
    reluInPlace(h);
    const out = linear(h, this.get("value_head.weight"), this.get("value_head.bias").data);
    return out[0];
  }

  private bn(data: Float32Array, prefix: string, C: number): void {
    bnEval(
      data,
      this.get(prefix + ".weight").data, this.get(prefix + ".bias").data,
      this.get(prefix + ".running_mean").data, this.get(prefix + ".running_var").data,
      C, this.eps,
    );
  }
}
