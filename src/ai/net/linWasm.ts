// WASM SIMD backend for the sparse-input linear layers (plane_fc 96x2400 and
// vfc 128x9581, ~10 % of search time at the V8 profile). Wraps the generated
// kernel (linKernel.ts, built by scripts/gen_linear_wasm.mjs):
//   - weights are staged once per tensor, transposed to [Nin][nout4] so the 4
//     output lanes load contiguously (nout4 = Nout rounded up to a multiple of
//     4, zero-padded, the pad lanes accumulate 0 and are dropped on copy-out);
//   - accumulation order per output = the same sequential nonzero order as the
//     TS loop; precision is f32 lanewise instead of f64 (the conv-kernel
//     precedent: PyTorch accumulates f32 too, full-model parity gate <= 1e-4);
//   - synchronous, graceful: any failure => null, caller falls back to TS.
import { LIN_WASM_B64 } from "./linKernel";
import type { Tensor } from "./nnOps";

interface WasmLin {
  mem: WebAssembly.Memory;
  lin: (idxB: number, valB: number, wtB: number, outB: number, nnz: number, nout4: number) => void;
}

let inst: WasmLin | null | undefined; // undefined = not tried, null = unavailable
let f32 = new Float32Array(0);
let i32 = new Int32Array(0);
const staged = new WeakMap<Float32Array, { base: number; nout4: number; nin: number }>();
let bump = 0;       // next free byte
let idxBase = -1;   // scratch: nonzero indices (i32)
let valBase = -1;   // scratch: nonzero values (f32)
let outBase = -1;   // scratch: nout4 accumulator (f32)
let idxCap = 0;     // scratch capacity (entries)
let outCap = 0;     // scratch capacity (f32)

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  if (typeof Buffer !== "undefined") return Buffer.from(b64, "base64");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function refreshViews(mem: WebAssembly.Memory): void {
  f32 = new Float32Array(mem.buffer);
  i32 = new Int32Array(mem.buffer);
}

function ensureInst(): WasmLin | null {
  if (inst !== undefined) return inst;
  try {
    const mod = new WebAssembly.Module(b64ToBytes(LIN_WASM_B64));
    const i = new WebAssembly.Instance(mod, {});
    const mem = i.exports.mem as WebAssembly.Memory;
    inst = { mem, lin: i.exports.lin as WasmLin["lin"] };
    refreshViews(mem);
  } catch {
    inst = null; // no SIMD / blocked wasm => TS fallback
    // Logged once: on this path the logits are computed in f64 (TS loop), so a report
    // of an absurd move from an old Safari/iOS could not be reproduced on a machine
    // with SIMD without this message.
    if (typeof console !== "undefined") console.info("[linWasm] WASM SIMD indisponible : repli TS (accumulation f64)");
  }
  return inst;
}

function ensureBytes(endByte: number): boolean {
  const w = inst as WasmLin;
  if (endByte <= w.mem.buffer.byteLength) return true;
  try {
    const pages = Math.ceil((endByte - w.mem.buffer.byteLength) / 65536);
    w.mem.grow(pages);
    refreshViews(w.mem); // growth detaches the old views
    return true;
  } catch {
    return false;
  }
}

// Stage a [Nout, Nin] weight tensor transposed to [Nin][nout4]. Returns null on
// any failure (caller falls back to TS). Keyed by the tensor's data view, the
// loader builds one Float32Array subarray per tensor and reuses it forever.
function stageTransposed(w: Tensor): { base: number; nout4: number; nin: number } | null {
  const [nout, nin] = w.shape;
  if (!nout || !nin || w.shape.length !== 2) return null;
  const hit = staged.get(w.data);
  if (hit) {
    // The key is the data view: if a second tensor shared the same view with another
    // shape, reusing the staging would quietly give wrong numbers. The current callers
    // never do this (buildTensors makes one subarray per tensor), but it is checked
    // anyway: a mismatch falls back to TS.
    if (hit.nin !== nin || hit.nout4 !== ((nout + 3) & ~3)) return null;
    return hit;
  }
  const nout4 = (nout + 3) & ~3;
  const bytes = nin * nout4 * 4;
  const base = (bump + 15) & ~15;
  if (!ensureBytes(base + bytes)) return null;
  f32.fill(0, base >> 2, (base + bytes) >> 2);
  const W = w.data;
  for (let o = 0; o < nout; o++) {
    const wb = o * nin;
    for (let i = 0; i < nin; i++) f32[(base >> 2) + i * nout4 + o] = W[wb + i];
  }
  bump = base + bytes;
  const entry = { base, nout4, nin };
  staged.set(w.data, entry);
  return entry;
}

function ensureScratch(nnzCap: number, noutCap: number): boolean {
  if (nnzCap <= idxCap && noutCap <= outCap && idxBase >= 0) return true;
  const nnzC = Math.max(nnzCap, idxCap, 1024);
  const outC = Math.max(noutCap, outCap, 256);
  const idxB = (bump + 15) & ~15;
  const valB = idxB + nnzC * 4;
  const outB = valB + nnzC * 4;
  if (!ensureBytes(outB + outC * 4)) return false;
  idxBase = idxB; valBase = valB; outBase = outB;
  idxCap = nnzC; outCap = outC;
  bump = outB + outC * 4;
  return true;
}

// Sparse-input linear via wasm. Returns null when unavailable (TS fallback).
// Contract: identical nonzero-gathering as nnOps.linearSparseIn, bias-seeded
// accumulator, f32 lanewise accumulation in the sequential nonzero order.
export function linearSparseInWasm(input: Float32Array, w: Tensor, bias: Float32Array): Float32Array | null {
  const inst = ensureInst();
  if (!inst) return null;
  const st = stageTransposed(w);
  if (!st) return null;
  const [nout, nin] = w.shape;
  if (input.length !== nin) return null;
  if (!ensureScratch(nin, st.nout4)) return null;
  // gather nonzeros (same order as the TS loop)
  let nnz = 0;
  const ib = idxBase >> 2, vb = valBase >> 2, ob = outBase >> 2;
  for (let i = 0; i < nin; i++) {
    const v = input[i];
    if (v !== 0) { i32[ib + nnz] = i; f32[vb + nnz] = v; nnz++; }
  }
  // seed the accumulator with the bias (pad lanes stay 0)
  f32.fill(0, ob, ob + st.nout4);
  f32.set(bias, ob);
  if (nnz > 0) inst.lin(idxBase, valBase, st.base, outBase, nnz, st.nout4);
  return f32.slice(ob, ob + nout);
}
