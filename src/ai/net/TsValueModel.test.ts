// TS/PyTorch parity check. The committed fixture (tiny.*) was produced by
// export.py/make_fixture.py from a random ValueNet with random BatchNorm running
// stats; if the TS forward does the same ops as PyTorch, value(x) matches the
// exported reference within 1e-4 for every row.
import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { TsValueModel, type TsManifest } from "./TsValueModel";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "__fixtures__");

let model: TsValueModel;
let ref: { inputs: number[][]; values: number[]; logits: number[] };

beforeAll(() => {
  const manifest = JSON.parse(fs.readFileSync(path.join(FIX, "tiny.manifest.json"), "utf-8")) as TsManifest;
  const buf = fs.readFileSync(path.join(FIX, "tiny.weights.f32"));
  const weights = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  model = new TsValueModel(manifest, weights);
  ref = JSON.parse(fs.readFileSync(path.join(FIX, "tiny.ref.json"), "utf-8"));
});

describe("TsValueModel inference parity", () => {
  it("matches the PyTorch reference logits within 1e-4 (relative) on every row", () => {
    expect(ref.inputs.length).toBeGreaterThan(0);
    let maxRel = 0;
    for (let i = 0; i < ref.inputs.length; i++) {
      const z = model.logit(Float32Array.from(ref.inputs[i]));
      // Float32 (PyTorch) vs float64 (TS) accumulation: compare with a small
      // absolute floor + 1e-4 relative tolerance (logits can be large).
      const rel = Math.abs(z - ref.logits[i]) / (1e-3 + Math.abs(ref.logits[i]));
      maxRel = Math.max(maxRel, rel);
      // value() applies tanh → always in [−1,1].
      const v = model.value(Float32Array.from(ref.inputs[i]));
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
      expect(v).toBeCloseTo(ref.values[i], 4);
    }
    expect(maxRel).toBeLessThan(1e-4);
  });

  it("is deterministic and pure (same input → same output)", () => {
    const x = Float32Array.from(ref.inputs[0]);
    expect(model.value(x)).toBe(model.value(x));
  });
});
