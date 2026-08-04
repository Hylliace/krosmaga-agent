// Pure-TS synchronous inference for the policy net. Same trunk as TsValueModel but
// with two factored heads (what / where); reproduces policy_model.py exactly (parity
// test TsPolicyModel.test.ts). Returns softmax probabilities ready for
// policy.ts/priorOverLegal.
import { N_PLANES2 } from "../encode2";
import { PLANE, conv2d, linear, bnEval, reluInPlace, softmaxInPlace, buildTensors, type Tensor, type NnManifest } from "./nnOps";

const PLANES_LEN = N_PLANES2 * PLANE; // 2150
const N_GLOBALS = 91;
const HEADER = PLANES_LEN + N_GLOBALS; // 2241

export class TsPolicyModel {
  private t: Map<string, Tensor>;
  readonly encLen: number;
  readonly channels: number;
  readonly blocks: number;
  readonly vLen: number;
  readonly eps: number;
  readonly whatSize: number;
  readonly whereSize: number;

  constructor(manifest: NnManifest, weights: Float32Array) {
    this.t = buildTensors(manifest, weights);
    this.encLen = manifest.enc_len;
    this.channels = manifest.channels;
    this.blocks = manifest.blocks;
    this.vLen = manifest.v_len;
    this.eps = manifest.bn_eps;
    this.whatSize = manifest.what_size ?? this.get("what_head.bias").data.length;
    this.whereSize = manifest.where_size ?? this.get("where_head.bias").data.length;
  }

  private get(key: string): Tensor {
    const t = this.t.get(key);
    if (!t) throw new Error(`missing tensor ${key}`);
    return t;
  }

  private bn(data: Float32Array, prefix: string, C: number): void {
    bnEval(data, this.get(prefix + ".weight").data, this.get(prefix + ".bias").data,
      this.get(prefix + ".running_mean").data, this.get(prefix + ".running_var").data, C, this.eps);
  }

  private trunkFeats(x: ArrayLike<number>): Float32Array {
    const C = this.channels;
    const planes = new Float32Array(PLANES_LEN);
    for (let i = 0; i < PLANES_LEN; i++) planes[i] = x[i];
    let cur = conv2d(planes, this.get("stem.0.weight").data, N_PLANES2, C);
    this.bn(cur, "stem.1", C);
    reluInPlace(cur);
    for (let b = 0; b < this.blocks; b++) {
      const p = `tower.${b}.`;
      let h = conv2d(cur, this.get(p + "c1.weight").data, C, C);
      this.bn(h, p + "b1", C); reluInPlace(h);
      h = conv2d(h, this.get(p + "c2.weight").data, C, C);
      this.bn(h, p + "b2", C);
      for (let i = 0; i < cur.length; i++) cur[i] = Math.max(0, cur[i] + h[i]);
    }
    const pf = linear(cur, this.get("plane_fc.weight"), this.get("plane_fc.bias").data);
    reluInPlace(pf);
    const g0 = new Float32Array(N_GLOBALS);
    for (let i = 0; i < N_GLOBALS; i++) g0[i] = x[PLANES_LEN + i];
    let g = linear(g0, this.get("glob.0.weight"), this.get("glob.0.bias").data);
    reluInPlace(g);
    g = linear(g, this.get("glob.2.weight"), this.get("glob.2.bias").data);
    reluInPlace(g);
    const v = new Float32Array(this.vLen);
    for (let i = 0; i < this.vLen; i++) v[i] = x[HEADER + i];
    const vv = linear(v, this.get("vfc.weight"), this.get("vfc.bias").data);
    reluInPlace(vv);
    const cat = new Float32Array(pf.length + g.length + vv.length);
    cat.set(pf, 0); cat.set(g, pf.length); cat.set(vv, pf.length + g.length);
    let h = linear(cat, this.get("trunk.0.weight"), this.get("trunk.0.bias").data);
    reluInPlace(h);
    h = linear(h, this.get("trunk.3.weight"), this.get("trunk.3.bias").data);
    reluInPlace(h);
    return h;
  }

  /** Pre-softmax head logits (parity is checked here). */
  logits(x: ArrayLike<number>): { what: Float32Array; where: Float32Array } {
    const h = this.trunkFeats(x);
    return {
      what: linear(h, this.get("what_head.weight"), this.get("what_head.bias").data),
      where: linear(h, this.get("where_head.weight"), this.get("where_head.bias").data),
    };
  }

  /** Softmaxed marginals, ready for priorOverLegal. */
  policy(x: ArrayLike<number>): { what: Float32Array; where: Float32Array } {
    const { what, where } = this.logits(x);
    softmaxInPlace(what); softmaxInPlace(where);
    return { what, where };
  }
}
