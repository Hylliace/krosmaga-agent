// WASM SIMD backend for the 3x3 board convolutions (the ~70% hot spot of a value
// forward). Wraps the generated kernel (convKernel.ts, built by
// scripts/gen_conv_wasm.mjs) behind the exact conv2d contract:
//   - BIT-EXACT vs nnOps.conv2d (same per-cell tap order, same ci accumulation
//     order, IEEE f32 lanewise), guarded by the PyTorch-parity tests.
//   - Synchronous everywhere (the 1.3 KB module compiles sync even on a browser
//     main thread, which caps sync compiles at 4 KB).
//   - Graceful: any failure (no SIMD, OOM, foreign weight blob) => null, caller
//     falls back to the TS loop.
//
// Memory layout (bump-allocated, grown on demand):
//   [staged weight blobs...][padded input scratch][12-wide output scratch]
// Weights are staged once per model blob (the conv weight tensors are subarrays
// of that blob, so their wasm pointer is just base + byteOffset).
import { CONV_WASM_B64 } from "./convKernel";
import { PLANE, ROWS, COLS } from "./nnOps";

const PH = ROWS + 2; // 7
const PW = COLS + 2; // 12
const IN_ROW = PH * PW;   // 84 floats per padded input channel
const OUT_ROW = ROWS * PW; // 60 floats per 12-wide output channel

interface WasmConv {
  mem: WebAssembly.Memory;
  conv: (inp: number, w: number, out: number, cin: number, cout: number) => void;
}

let inst: WasmConv | null | undefined; // undefined = not tried, null = unavailable
let f32 = new Float32Array(0);
const staged = new Map<ArrayBufferLike, number>(); // weight blob buffer -> byte base
let bump = 0;      // next free byte
let inBase = -1;   // padded-input scratch (bytes)
let outBase = -1;  // 12-wide output scratch (bytes)
let scratchCap = 0; // channels capacity of current scratch

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  if (typeof Buffer !== "undefined") return Buffer.from(b64, "base64");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function ensureInst(): WasmConv | null {
  if (inst !== undefined) return inst;
  try {
    const mod = new WebAssembly.Module(b64ToBytes(CONV_WASM_B64));
    const i = new WebAssembly.Instance(mod, {});
    const mem = i.exports.mem as WebAssembly.Memory;
    inst = { mem, conv: i.exports.conv as WasmConv["conv"] };
    f32 = new Float32Array(mem.buffer);
  } catch {
    inst = null; // no SIMD / blocked wasm => TS fallback
  }
  return inst;
}

function ensureBytes(endByte: number): boolean {
  const w = inst as WasmConv;
  if (endByte <= w.mem.buffer.byteLength) return true;
  const pages = Math.ceil((endByte - w.mem.buffer.byteLength) / 65536) + 4;
  try { w.mem.grow(pages); } catch { return false; }
  f32 = new Float32Array(w.mem.buffer);
  return true;
}

function ensureScratch(maxChannels: number): boolean {
  if (inBase >= 0 && maxChannels <= scratchCap) return true;
  const cap = Math.max(maxChannels, 256);
  const inBytes = cap * IN_ROW * 4;
  const outBytes = cap * OUT_ROW * 4;
  const base = (bump + 15) & ~15;
  if (!ensureBytes(base + inBytes + outBytes)) return false;
  inBase = base;
  outBase = base + inBytes;
  scratchCap = cap;
  bump = base + inBytes + outBytes;
  return true;
}

/** Stage a model's full weight blob into wasm memory (once per blob). Returns
 *  false when wasm is unavailable, callers then stay on the TS path. */
export function stageWeights(blob: Float32Array): boolean {
  if (!ensureInst()) return false;
  if (staged.has(blob.buffer)) return true;
  const base = (bump + 15) & ~15;
  // The whole underlying buffer is copied (so any subarray resolves to base +
  // byteOffset), so its own size has to be reserved, not the size of the view;
  // otherwise a view on a big buffer would write past the reservation. A failed
  // grow has to return false (TS fallback), not throw from the constructor.
  const fullBytes = blob.buffer.byteLength;
  if (!ensureBytes(base + fullBytes)) return false;
  bump = base + fullBytes;
  try {
    f32.set(new Float32Array(blob.buffer, 0, fullBytes >> 2), base >> 2);
  } catch {
    return false;
  }
  staged.set(blob.buffer, base);
  // scratch invalidated if it sat before the new bump? (it never does: bump only grows)
  return ensureScratch(scratchCap || 0);
}

// Sparse-input stem path (~9.5% of the search time once the linear layer was
// ported): the stem weights are staged transposed by input channel
// ([ci][co][3x3]), then the existing kernel is called once per active channel with
// cin=1. With cin=1 its wstride is 36, so the [ci][co*9] block matches its
// addressing exactly. The accumulation order per output cell (active ci in
// increasing order, sum of the 9 taps, then add) is the same as conv2dSparseIn;
// precision becomes lanewise f32, like the tower.
const stagedT = new WeakMap<Float32Array, number>();

function stageStemTransposed(weight: Float32Array, Cin: number, Cout: number): number | null {
  const hit = stagedT.get(weight);
  if (hit !== undefined) return hit;
  const bytes = Cin * Cout * 36;
  const base = (bump + 15) & ~15;
  if (!ensureBytes(base + bytes)) return null;
  const bF = base >> 2;
  for (let ci = 0; ci < Cin; ci++) {
    for (let co = 0; co < Cout; co++) {
      const src = (co * Cin + ci) * 9, dst = bF + (ci * Cout + co) * 9;
      for (let t = 0; t < 9; t++) f32[dst + t] = weight[src + t];
    }
  }
  bump = base + bytes;
  stagedT.set(weight, base);
  return base;
}

/** WASM 3x3 conv with sparse input (stem): skips input channels that are all zero.
 *  Returns null when the backend cannot run this call; the caller then falls back
 *  to nnOps.conv2dSparseIn. */
export function convSparseWasm(input: Float32Array, weight: Float32Array, Cin: number, Cout: number): Float32Array | null {
  if (Cout % 4 !== 0) return null;
  const w = ensureInst();
  if (!w) return null;
  const tBase = stageStemTransposed(weight, Cin, Cout);
  if (tBase === null) return null;
  if (!ensureScratch(Math.max(1, Cout))) return null;
  const inF = inBase >> 2, outF = outBase >> 2;
  f32.fill(0, outF, outF + Cout * OUT_ROW);
  for (let ci = 0; ci < Cin; ci++) {
    const ib = ci * PLANE;
    let act = false;
    for (let i = 0; i < PLANE; i++) if (input[ib + i] !== 0) { act = true; break; }
    if (!act) continue;
    // pad ce canal seul (bordures à zéro, rangées 10 -> 12 de large)
    f32.fill(0, inF, inF + IN_ROW);
    for (let y = 0; y < ROWS; y++) {
      const prow = inF + (y + 1) * PW + 1, irow = ib + y * COLS;
      for (let x = 0; x < COLS; x++) f32[prow + x] = input[irow + x];
    }
    w.conv(inBase, tBase + ci * Cout * 36, outBase, 1, Cout);
  }
  const out = new Float32Array(Cout * PLANE);
  for (let co = 0; co < Cout; co++) {
    const ob = co * PLANE, wb = outF + co * OUT_ROW;
    for (let y = 0; y < ROWS; y++) {
      const orow = ob + y * COLS, wrow = wb + y * PW;
      for (let x = 0; x < COLS; x++) out[orow + x] = f32[wrow + x];
    }
  }
  return out;
}

/** WASM 3x3 conv (stride 1, pad 1) on the 5x10 board. Returns null when the
 *  backend cannot run this call (unstaged weights, odd Cout, no wasm), the
 *  caller must fall back to nnOps.conv2d. Bit-exact with it otherwise. */
export function convWasm(input: Float32Array, weight: Float32Array, Cin: number, Cout: number): Float32Array | null {
  if (Cout % 4 !== 0) return null;
  const w = ensureInst();
  if (!w) return null;
  const base = staged.get(weight.buffer);
  if (base === undefined) return null;
  if (!ensureScratch(Math.max(Cin, Cout))) return null;

  // pad input directly into wasm memory (zero borders, copy 10-wide rows)
  const inF = inBase >> 2;
  f32.fill(0, inF, inF + Cin * IN_ROW);
  for (let ci = 0; ci < Cin; ci++) {
    const pb = inF + ci * IN_ROW, ib = ci * PLANE;
    for (let y = 0; y < ROWS; y++) {
      const prow = pb + (y + 1) * PW + 1, irow = ib + y * COLS;
      for (let x = 0; x < COLS; x++) f32[prow + x] = input[irow + x];
    }
  }
  // zero the 12-wide output accumulator, run, compact to Cout x 50
  const outF = outBase >> 2;
  f32.fill(0, outF, outF + Cout * OUT_ROW);
  w.conv(inBase, base + weight.byteOffset, outBase, Cin, Cout);
  const out = new Float32Array(Cout * PLANE);
  for (let co = 0; co < Cout; co++) {
    const ob = co * PLANE, wb = outF + co * OUT_ROW;
    for (let y = 0; y < ROWS; y++) {
      const orow = ob + y * COLS, wrow = wb + y * PW;
      for (let x = 0; x < COLS; x++) out[orow + x] = f32[wrow + x];
    }
  }
  return out;
}
