// Shared pure-TS NN primitives for the exported nets (value + policy). Reproduce
// PyTorch eval-mode ops exactly so the TS forward matches within 1e-4 (parity
// gates). All tensors come from an export.py blob via a manifest tensor table.
import { linearSparseInWasm } from "./linWasm";

export const ROWS = 5;
export const COLS = 10;
export const PLANE = ROWS * COLS; // 50

export interface NnManifestTensor { key: string; shape: number[]; offset: number; count: number; }
export interface NnManifest {
  schema: string;
  enc_len: number;
  vocab_size: number;
  v_len: number;
  channels: number;
  blocks: number;
  bn_eps: number;
  tensors: NnManifestTensor[];
  // policy-only:
  what_size?: number;
  where_size?: number;
}

export interface Tensor { data: Float32Array; shape: number[]; }

export function buildTensors(manifest: NnManifest, weights: Float32Array): Map<string, Tensor> {
  const m = new Map<string, Tensor>();
  for (const t of manifest.tensors) m.set(t.key, { data: weights.subarray(t.offset, t.offset + t.count), shape: t.shape });
  return m;
}

// 3×3, stride 1, pad 1 conv on a 5×10 board; no bias. weight [Cout,Cin,3,3].
// Zero-pad to (Cin × 7 × 12) once so the 9-tap kernel is unrolled and branchless.
// Output channels are processed 4 at a time, so each padded tap load feeds 4 MAC
// chains (4× less input traffic), and the pad buffer is a reused module scratch (no
// allocation per call). Bit-exact against the naive loop (same tap order per cell,
// same ci accumulation order), checked by the TsValueModel PyTorch parity test.
// About 1.5× faster on the conv, which is ~70% of a value forward.
const PH = ROWS + 2; // 7
const PW = COLS + 2; // 12
let convPadScratch = new Float32Array(0);
export function conv2d(input: Float32Array, weight: Float32Array, Cin: number, Cout: number): Float32Array {
  const need = Cin * PH * PW;
  if (convPadScratch.length < need) convPadScratch = new Float32Array(need);
  const padded = convPadScratch;
  padded.fill(0, 0, need);
  for (let ci = 0; ci < Cin; ci++) {
    const pb = ci * PH * PW, ib = ci * PLANE;
    for (let y = 0; y < ROWS; y++) {
      const prow = pb + (y + 1) * PW + 1, irow = ib + y * COLS;
      for (let x = 0; x < COLS; x++) padded[prow + x] = input[irow + x];
    }
  }
  const out = new Float32Array(Cout * PLANE);
  const coQuads = Cout & ~3;
  for (let co = 0; co < coQuads; co += 4) {
    const ob0 = co * PLANE, ob1 = (co + 1) * PLANE, ob2 = (co + 2) * PLANE, ob3 = (co + 3) * PLANE;
    for (let ci = 0; ci < Cin; ci++) {
      const pb = ci * PH * PW;
      const wA = (co * Cin + ci) * 9, wB = ((co + 1) * Cin + ci) * 9, wC = ((co + 2) * Cin + ci) * 9, wD = ((co + 3) * Cin + ci) * 9;
      const a0 = weight[wA], a1 = weight[wA + 1], a2 = weight[wA + 2], a3 = weight[wA + 3], a4 = weight[wA + 4], a5 = weight[wA + 5], a6 = weight[wA + 6], a7 = weight[wA + 7], a8 = weight[wA + 8];
      const b0 = weight[wB], b1 = weight[wB + 1], b2 = weight[wB + 2], b3 = weight[wB + 3], b4 = weight[wB + 4], b5 = weight[wB + 5], b6 = weight[wB + 6], b7 = weight[wB + 7], b8 = weight[wB + 8];
      const c0 = weight[wC], c1 = weight[wC + 1], c2 = weight[wC + 2], c3 = weight[wC + 3], c4 = weight[wC + 4], c5 = weight[wC + 5], c6 = weight[wC + 6], c7 = weight[wC + 7], c8 = weight[wC + 8];
      const d0 = weight[wD], d1 = weight[wD + 1], d2 = weight[wD + 2], d3 = weight[wD + 3], d4 = weight[wD + 4], d5 = weight[wD + 5], d6 = weight[wD + 6], d7 = weight[wD + 7], d8 = weight[wD + 8];
      for (let y = 0; y < ROWS; y++) {
        let p = pb + y * PW;
        const r0 = ob0 + y * COLS, r1 = ob1 + y * COLS, r2 = ob2 + y * COLS, r3 = ob3 + y * COLS;
        for (let x = 0; x < COLS; x++, p++) {
          const t0 = padded[p], t1 = padded[p + 1], t2 = padded[p + 2];
          const t3 = padded[p + PW], t4 = padded[p + PW + 1], t5 = padded[p + PW + 2];
          const t6 = padded[p + 2 * PW], t7 = padded[p + 2 * PW + 1], t8 = padded[p + 2 * PW + 2];
          out[r0 + x] += t0 * a0 + t1 * a1 + t2 * a2 + t3 * a3 + t4 * a4 + t5 * a5 + t6 * a6 + t7 * a7 + t8 * a8;
          out[r1 + x] += t0 * b0 + t1 * b1 + t2 * b2 + t3 * b3 + t4 * b4 + t5 * b5 + t6 * b6 + t7 * b7 + t8 * b8;
          out[r2 + x] += t0 * c0 + t1 * c1 + t2 * c2 + t3 * c3 + t4 * c4 + t5 * c5 + t6 * c6 + t7 * c7 + t8 * c8;
          out[r3 + x] += t0 * d0 + t1 * d1 + t2 * d2 + t3 * d3 + t4 * d4 + t5 * d5 + t6 * d6 + t7 * d7 + t8 * d8;
        }
      }
    }
  }
  // remainder channels (Cout not a multiple of 4), plain loop
  for (let co = coQuads; co < Cout; co++) {
    const ob = co * PLANE;
    for (let ci = 0; ci < Cin; ci++) {
      const pb = ci * PH * PW, wb = (co * Cin + ci) * 9;
      const w0 = weight[wb], w1 = weight[wb + 1], w2 = weight[wb + 2];
      const w3 = weight[wb + 3], w4 = weight[wb + 4], w5 = weight[wb + 5];
      const w6 = weight[wb + 6], w7 = weight[wb + 7], w8 = weight[wb + 8];
      for (let y = 0; y < ROWS; y++) {
        let p = pb + y * PW;
        const orow = ob + y * COLS;
        for (let x = 0; x < COLS; x++, p++) {
          out[orow + x] +=
            padded[p] * w0 + padded[p + 1] * w1 + padded[p + 2] * w2 +
            padded[p + PW] * w3 + padded[p + PW + 1] * w4 + padded[p + PW + 2] * w5 +
            padded[p + 2 * PW] * w6 + padded[p + 2 * PW + 1] * w7 + padded[p + 2 * PW + 2] * w8;
        }
      }
    }
  }
  return out;
}

// Sparse-INPUT variant of conv2d for the stem, whose input is the raw encoding:
// on a real board only ~25 of the 215 v3 planes are non-zero (few creatures, few
// properties/triggers/families present). An all-zero input channel contributes
// exactly 0 to every output tap, so skipping it is BIT-IDENTICAL to the dense
// loop, no parity cost. Only the active channels are padded and accumulated.
export function conv2dSparseIn(input: Float32Array, weight: Float32Array, Cin: number, Cout: number): Float32Array {
  const active: number[] = [];
  for (let ci = 0; ci < Cin; ci++) {
    const ib = ci * PLANE;
    for (let i = 0; i < PLANE; i++) {
      if (input[ib + i] !== 0) { active.push(ci); break; }
    }
  }
  const nAct = active.length;
  const need = nAct * PH * PW;
  if (convPadScratch.length < need) convPadScratch = new Float32Array(need);
  const padded = convPadScratch;
  padded.fill(0, 0, need);
  for (let a = 0; a < nAct; a++) {
    const pb = a * PH * PW, ib = active[a] * PLANE;
    for (let y = 0; y < ROWS; y++) {
      const prow = pb + (y + 1) * PW + 1, irow = ib + y * COLS;
      for (let x = 0; x < COLS; x++) padded[prow + x] = input[irow + x];
    }
  }
  // Same 4-wide output-channel blocking as conv2d (see above), bit-exact.
  const out = new Float32Array(Cout * PLANE);
  const coQuads = Cout & ~3;
  for (let co = 0; co < coQuads; co += 4) {
    const ob0 = co * PLANE, ob1 = (co + 1) * PLANE, ob2 = (co + 2) * PLANE, ob3 = (co + 3) * PLANE;
    for (let a = 0; a < nAct; a++) {
      const pb = a * PH * PW, ciw = active[a] * 9;
      const wA = co * Cin * 9 + ciw, wB = (co + 1) * Cin * 9 + ciw, wC = (co + 2) * Cin * 9 + ciw, wD = (co + 3) * Cin * 9 + ciw;
      const a0 = weight[wA], a1 = weight[wA + 1], a2 = weight[wA + 2], a3 = weight[wA + 3], a4 = weight[wA + 4], a5 = weight[wA + 5], a6 = weight[wA + 6], a7 = weight[wA + 7], a8 = weight[wA + 8];
      const b0 = weight[wB], b1 = weight[wB + 1], b2 = weight[wB + 2], b3 = weight[wB + 3], b4 = weight[wB + 4], b5 = weight[wB + 5], b6 = weight[wB + 6], b7 = weight[wB + 7], b8 = weight[wB + 8];
      const c0 = weight[wC], c1 = weight[wC + 1], c2 = weight[wC + 2], c3 = weight[wC + 3], c4 = weight[wC + 4], c5 = weight[wC + 5], c6 = weight[wC + 6], c7 = weight[wC + 7], c8 = weight[wC + 8];
      const d0 = weight[wD], d1 = weight[wD + 1], d2 = weight[wD + 2], d3 = weight[wD + 3], d4 = weight[wD + 4], d5 = weight[wD + 5], d6 = weight[wD + 6], d7 = weight[wD + 7], d8 = weight[wD + 8];
      for (let y = 0; y < ROWS; y++) {
        let p = pb + y * PW;
        const r0 = ob0 + y * COLS, r1 = ob1 + y * COLS, r2 = ob2 + y * COLS, r3 = ob3 + y * COLS;
        for (let x = 0; x < COLS; x++, p++) {
          const t0 = padded[p], t1 = padded[p + 1], t2 = padded[p + 2];
          const t3 = padded[p + PW], t4 = padded[p + PW + 1], t5 = padded[p + PW + 2];
          const t6 = padded[p + 2 * PW], t7 = padded[p + 2 * PW + 1], t8 = padded[p + 2 * PW + 2];
          out[r0 + x] += t0 * a0 + t1 * a1 + t2 * a2 + t3 * a3 + t4 * a4 + t5 * a5 + t6 * a6 + t7 * a7 + t8 * a8;
          out[r1 + x] += t0 * b0 + t1 * b1 + t2 * b2 + t3 * b3 + t4 * b4 + t5 * b5 + t6 * b6 + t7 * b7 + t8 * b8;
          out[r2 + x] += t0 * c0 + t1 * c1 + t2 * c2 + t3 * c3 + t4 * c4 + t5 * c5 + t6 * c6 + t7 * c7 + t8 * c8;
          out[r3 + x] += t0 * d0 + t1 * d1 + t2 * d2 + t3 * d3 + t4 * d4 + t5 * d5 + t6 * d6 + t7 * d7 + t8 * d8;
        }
      }
    }
  }
  for (let co = coQuads; co < Cout; co++) {
    const ob = co * PLANE;
    for (let a = 0; a < nAct; a++) {
      const pb = a * PH * PW, wb = (co * Cin + active[a]) * 9;
      const w0 = weight[wb], w1 = weight[wb + 1], w2 = weight[wb + 2];
      const w3 = weight[wb + 3], w4 = weight[wb + 4], w5 = weight[wb + 5];
      const w6 = weight[wb + 6], w7 = weight[wb + 7], w8 = weight[wb + 8];
      for (let y = 0; y < ROWS; y++) {
        let p = pb + y * PW;
        const orow = ob + y * COLS;
        for (let x = 0; x < COLS; x++, p++) {
          out[orow + x] +=
            padded[p] * w0 + padded[p + 1] * w1 + padded[p + 2] * w2 +
            padded[p + PW] * w3 + padded[p + PW + 1] * w4 + padded[p + PW + 2] * w5 +
            padded[p + 2 * PW] * w6 + padded[p + 2 * PW + 1] * w7 + padded[p + 2 * PW + 2] * w8;
        }
      }
    }
  }
  return out;
}

export function linear(input: Float32Array, w: Tensor, bias: Float32Array): Float32Array {
  const [Nout, Nin] = w.shape;
  const out = new Float32Array(Nout);
  const W = w.data;
  for (let o = 0; o < Nout; o++) {
    let acc = bias[o];
    const wb = o * Nin;
    for (let i = 0; i < Nin; i++) acc += W[wb + i] * input[i];
    out[o] = acc;
  }
  return out;
}

// Sparse-INPUT linear: skip zero inputs (exact, a 0·w term adds exactly 0).
// Pays off hugely on the V-vectors (~150 non-zero of ~9600: hand/deck/discard
// multihots over the vocab); falls back to the dense loop when the input is not
// actually sparse (post-ReLU activations vary), so it is always safe to use.
export function linearSparseIn(input: Float32Array, w: Tensor, bias: Float32Array): Float32Array {
  // WASM SIMD first (~10% of the search time in the V8 profile): same sequential
  // accumulation order per output, lanewise f32 precision (same as the conv: logit
  // parity <= 1e-4). null => TS loop below.
  const viaWasm = linearSparseInWasm(input, w, bias);
  if (viaWasm) return viaWasm;
  const [Nout, Nin] = w.shape;
  const idx: number[] = [];
  for (let i = 0; i < Nin; i++) if (input[i] !== 0) idx.push(i);
  if (idx.length * 2 > Nin) return linear(input, w, bias);
  const out = new Float32Array(Nout);
  const W = w.data;
  const nnz = idx.length;
  for (let o = 0; o < Nout; o++) {
    let acc = bias[o];
    const wb = o * Nin;
    for (let k = 0; k < nnz; k++) {
      const i = idx[k];
      acc += W[wb + i] * input[i];
    }
    out[o] = acc;
  }
  return out;
}

// BatchNorm eval: y = (x − mean)/sqrt(var+eps) · gamma + beta, per channel.
export function bnEval(data: Float32Array, gamma: Float32Array, beta: Float32Array, mean: Float32Array, varr: Float32Array, C: number, eps: number): void {
  for (let c = 0; c < C; c++) {
    const scale = gamma[c] / Math.sqrt(varr[c] + eps);
    const shift = beta[c] - mean[c] * scale;
    const base = c * PLANE;
    for (let i = 0; i < PLANE; i++) data[base + i] = data[base + i] * scale + shift;
  }
}

export function reluInPlace(a: Float32Array): void {
  for (let i = 0; i < a.length; i++) if (a[i] < 0) a[i] = 0;
}

export function softmaxInPlace(a: Float32Array): void {
  let mx = -Infinity;
  for (let i = 0; i < a.length; i++) if (a[i] > mx) mx = a[i];
  let s = 0;
  for (let i = 0; i < a.length; i++) { a[i] = Math.exp(a[i] - mx); s += a[i]; }
  if (s > 0) for (let i = 0; i < a.length; i++) a[i] /= s;
}
