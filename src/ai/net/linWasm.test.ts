// Parity of the sparse-input linear WASM kernel (linWasm): bit-exact against a
// step-by-step scalar f32 reference (same sequential accumulation order per output,
// f32 rounding at each step, which is how the kernel works lanewise).
// Model parity (logit before tanh vs the PyTorch export, tolerance 1e-4) is covered
// by the existing TsValueModel/netLeaf tests, which use this path whenever WASM is
// available (node >= 16, so always in CI).
import { describe, it, expect } from "vitest";
import { linearSparseInWasm } from "./linWasm";
import type { Tensor } from "./nnOps";

const fr = Math.fround;

// Reference: step-by-step f32 accumulation, non-zeros in sequential order.
function refF32(input: Float32Array, w: Tensor, bias: Float32Array): Float32Array {
  const [Nout, Nin] = w.shape;
  const out = new Float32Array(Nout);
  for (let o = 0; o < Nout; o++) {
    let acc = bias[o];
    for (let i = 0; i < Nin; i++) {
      if (input[i] !== 0) acc = fr(acc + fr(w.data[o * Nin + i] * input[i]));
    }
    out[o] = acc;
  }
  return out;
}

function mkTensor(nout: number, nin: number, seed: number): Tensor {
  const data = new Float32Array(nout * nin);
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0), (s / 0xffffffff) * 2 - 1);
  for (let i = 0; i < data.length; i++) data[i] = fr(rnd() * 0.2);
  return { shape: [nout, nin], data } as Tensor;
}

function mkInput(nin: number, nnz: number, seed: number): Float32Array {
  const input = new Float32Array(nin);
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 22695477 + 1) >>> 0), s / 0xffffffff);
  for (let k = 0; k < nnz; k++) input[Math.floor(rnd() * nin)] = fr(rnd() * 2 - 1);
  return input;
}

const CASES: Array<[string, number, number, number]> = [
  ["vfc réel (128x9581), très creux", 128, 9581, 220],
  ["plane_fc réel (96x2400), mi-dense", 96, 2400, 1100],
  ["dense (nnz ~= Nin)", 32, 200, 200],
  ["Nout non multiple de 4 (pad)", 7, 53, 20],
  ["une seule sortie", 1, 400, 60],
];

describe("linWasm : parité bit-exacte vs référence scalaire f32 pas-à-pas", () => {
  for (const [name, nout, nin, nnz] of CASES) {
    it(name, () => {
      const w = mkTensor(nout, nin, 42 + nout);
      const bias = mkInput(nout, nout, 7).map(fr);
      const input = mkInput(nin, nnz, 1234 + nin);
      const got = linearSparseInWasm(input, w, bias);
      expect(got).not.toBeNull();
      const want = refF32(input, w, bias);
      expect(got!.length).toBe(nout);
      for (let o = 0; o < nout; o++) {
        // Object.is is strict: it tells +0 from -0 and handles NaN; the contract is
        // bit-exact, not just equal with ===.
        expect(Object.is(got![o], want[o])).toBe(true);
      }
    });
  }

  it("nnz = 0 : retourne exactement le biais", () => {
    const w = mkTensor(16, 100, 5);
    const bias = mkInput(16, 16, 9).map(fr);
    const got = linearSparseInWasm(new Float32Array(100), w, bias);
    expect(got).not.toBeNull();
    for (let o = 0; o < 16; o++) expect(got![o]).toBe(bias[o]);
  });

  it("staging réutilisé : deux appels sur le même tenseur donnent le même résultat", () => {
    const w = mkTensor(64, 500, 77);
    const bias = new Float32Array(64);
    const input = mkInput(500, 40, 3);
    const a = linearSparseInWasm(input, w, bias)!;
    const b = linearSparseInWasm(input, w, bias)!;
    for (let o = 0; o < 64; o++) expect(a[o]).toBe(b[o]);
  });

  it("plusieurs tenseurs stagés (croissance mémoire) : résultats stables", () => {
    const tensors = [mkTensor(128, 9581, 1), mkTensor(96, 2400, 2), mkTensor(128, 9581, 3)];
    const inputs = tensors.map((t, i) => mkInput(t.shape[1], 150, 50 + i));
    const before = tensors.map((t, i) => linearSparseInWasm(inputs[i], t, new Float32Array(t.shape[0]))!);
    const after = tensors.map((t, i) => linearSparseInWasm(inputs[i], t, new Float32Array(t.shape[0]))!);
    for (let t = 0; t < tensors.length; t++) {
      const want = refF32(inputs[t], tensors[t], new Float32Array(tensors[t].shape[0]));
      for (let o = 0; o < want.length; o++) {
        expect(before[t][o]).toBe(want[o]);
        expect(after[t][o]).toBe(want[o]);
      }
    }
  });
});
