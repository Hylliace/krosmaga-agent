// Throughput microbench and real-model parity check for the TS value net.
//
//   npx tsx src/ai/cli/benchValue.ts --model data/models/value [--n 20000]
//
// Reports: (1) max parity error on the exported reference rows, (2) forward
// passes per second (single thread, synchronous), and (3) the NetMCTS leaf budget
// this allows: how many determinizations × sims fit a target latency per move.
import * as fs from "node:fs";
import { TsValueModel, type TsManifest } from "../net/TsValueModel";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const MODEL = arg("--model", "data/models/value");
const N = parseInt(arg("--n", "20000"), 10);
const LIVE_MS = parseFloat(arg("--live-ms", "200")); // target per-move eval budget

function loadModel(prefix: string): { model: TsValueModel; manifest: TsManifest } {
  const manifest = JSON.parse(fs.readFileSync(`${prefix}.manifest.json`, "utf-8")) as TsManifest;
  const buf = fs.readFileSync(`${prefix}.weights.f32`);
  const weights = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return { model: new TsValueModel(manifest, weights), manifest };
}

function main(): void {
  const { model, manifest } = loadModel(MODEL);
  console.log(`model: encLen ${manifest.enc_len}, channels ${manifest.channels}, blocks ${manifest.blocks}, vocab ${manifest.vocab_size}`);

  // (1) parity on the exported reference rows.
  if (fs.existsSync(`${MODEL}.ref.json`)) {
    const ref = JSON.parse(fs.readFileSync(`${MODEL}.ref.json`, "utf-8")) as { inputs: number[][]; logits: number[] };
    let maxRel = 0;
    for (let i = 0; i < ref.inputs.length; i++) {
      const z = model.logit(Float32Array.from(ref.inputs[i]));
      maxRel = Math.max(maxRel, Math.abs(z - ref.logits[i]) / (1e-3 + Math.abs(ref.logits[i])));
    }
    console.log(`parity (real model, ${ref.inputs.length} rows): max rel err ${maxRel.toExponential(2)} ${maxRel < 1e-4 ? "OK" : "FAIL"}`);
  }

  // (2) throughput on random inputs of the right length.
  const x = new Float32Array(manifest.enc_len);
  for (let i = 0; i < x.length; i++) x[i] = Math.random() * 0.5;
  let sink = 0;
  for (let i = 0; i < 1000; i++) sink += model.value(x); // warmup
  const t0 = performance.now();
  for (let i = 0; i < N; i++) { x[i % x.length] = (i & 7) * 0.1; sink += model.value(x); }
  const dt = performance.now() - t0;
  const perSec = (N / dt) * 1000;
  const usEach = (dt / N) * 1000;
  console.log(`throughput: ${perSec.toFixed(0)} forwards/sec (${usEach.toFixed(1)} µs each) [sink ${sink.toFixed(3)}]`);

  // (3) NetMCTS leaf budget for a live per-move latency target.
  const leavesPerMove = Math.floor((LIVE_MS / 1000) * perSec);
  console.log(`live budget @ ${LIVE_MS}ms/move: ~${leavesPerMove} leaf evals`);
  for (const det of [4, 8, 16]) {
    console.log(`  e.g. ${det} determinizations × ${Math.floor(leavesPerMove / det)} sims each`);
  }
}

main();
