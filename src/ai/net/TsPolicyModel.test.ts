// TS/PyTorch parity for the policy net. Checks the what/where head logits against
// the exported PyTorch reference (a random tiny model with random BN stats), and
// that the softmaxed marginals are valid distributions.
import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { TsPolicyModel } from "./TsPolicyModel";
import type { NnManifest } from "./nnOps";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "__fixtures__");

let model: TsPolicyModel;
let ref: { inputs: number[][]; what_logits: number[][]; where_logits: number[][] };

beforeAll(() => {
  const manifest = JSON.parse(fs.readFileSync(path.join(FIX, "tiny_policy.manifest.json"), "utf-8")) as NnManifest;
  const buf = fs.readFileSync(path.join(FIX, "tiny_policy.weights.f32"));
  model = new TsPolicyModel(manifest, new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
  ref = JSON.parse(fs.readFileSync(path.join(FIX, "tiny_policy.ref.json"), "utf-8"));
});

describe("TsPolicyModel parity", () => {
  it("matches PyTorch what/where logits to float32 precision", () => {
    // float32 (PyTorch) vs float64 (TS) accumulation over the deeper policy trunk:
    // this RANDOM-stress fixture lands ~1e-4 relative. Real trained models (small
    // logits, like the value model's 8e-6) are far tighter; 3e-4 is the stress gate.
    let maxRel = 0;
    for (let i = 0; i < ref.inputs.length; i++) {
      const { what, where } = model.logits(Float32Array.from(ref.inputs[i]));
      for (let j = 0; j < what.length; j++)
        maxRel = Math.max(maxRel, Math.abs(what[j] - ref.what_logits[i][j]) / (1e-3 + Math.abs(ref.what_logits[i][j])));
      for (let j = 0; j < where.length; j++)
        maxRel = Math.max(maxRel, Math.abs(where[j] - ref.where_logits[i][j]) / (1e-3 + Math.abs(ref.where_logits[i][j])));
    }
    expect(maxRel).toBeLessThan(3e-4);
  });

  it("policy() returns valid softmax distributions", () => {
    const { what, where } = model.policy(Float32Array.from(ref.inputs[0]));
    expect(what.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    expect(where.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    expect(Math.min(...what)).toBeGreaterThanOrEqual(0);
  });
});
