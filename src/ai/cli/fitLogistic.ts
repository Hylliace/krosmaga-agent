// Fit the logistic baseline on encoded shards.
//
//   npx tsx src/ai/cli/fitLogistic.ts --in dataset/enc/games.0 --out dataset/models/logistic.json
//
// Reads <in>.x.f32 / <in>.y.f32 / <in>.idx.u32 (+ <in>.meta.json for the size),
// splits by game into train/val (no intra-game leakage), fits, reports
// Brier/logloss/acc against the no-skill base rate, and saves the value model JSON.
import * as fs from "node:fs";
import * as path from "node:path";
import { Rng } from "../../engine/rng";
import { fitLogistic, evalMetrics, splitByGroup, labelsToTargets } from "../train/logistic";
import { LogisticValueModel } from "../train/valueModel";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const IN = arg("--in", "dataset/enc/games.0");
const OUT = arg("--out", "dataset/models/logistic.json");
const VAL = parseFloat(arg("--val", "0.15"));
const EPOCHS = parseInt(arg("--epochs", "25"), 10);
const LR = parseFloat(arg("--lr", "0.1"));
const L2 = parseFloat(arg("--l2", "1e-4"));
const BATCH = parseInt(arg("--batch", "256"), 10);
const SEED = parseInt(arg("--seed", "1"), 10);

function readF32(p: string): Float32Array {
  const buf = fs.readFileSync(p);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
function readU32(p: string): Uint32Array {
  const buf = fs.readFileSync(p);
  return new Uint32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function main(): void {
  const meta = JSON.parse(fs.readFileSync(`${IN}.meta.json`, "utf-8")) as { encLen: number };
  const dim = meta.encLen;
  const X = readF32(`${IN}.x.f32`);
  const y = readF32(`${IN}.y.f32`);
  const idx = readU32(`${IN}.idx.u32`);
  const nRows = y.length;
  if (X.length !== nRows * dim) throw new Error(`X length ${X.length} != ${nRows}*${dim}`);
  const t = labelsToTargets(y);

  const rng = new Rng((SEED ^ 0x1234abcd) | 0);
  const { train, val } = splitByGroup(idx, VAL, rng);
  const nGames = new Set(Array.from(idx)).size;
  console.log(`rows ${nRows} (dim ${dim}) from ${nGames} games → train ${train.length} / val ${val.length}`);

  const t0 = Date.now();
  const fit = fitLogistic(X, t, dim, train, { epochs: EPOCHS, lr: LR, l2: L2, batchSize: BATCH, rng });
  const trM = evalMetrics(X, t, dim, train, fit);
  const vaM = evalMetrics(X, t, dim, val, fit);
  console.log(`fit in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  train: brier ${trM.brier.toFixed(4)} logloss ${trM.logloss.toFixed(4)} acc ${(trM.acc * 100).toFixed(1)}% (base ${(trM.base * 100).toFixed(1)}%)`);
  console.log(`  val  : brier ${vaM.brier.toFixed(4)} logloss ${vaM.logloss.toFixed(4)} acc ${(vaM.acc * 100).toFixed(1)}% (base ${(vaM.base * 100).toFixed(1)}%)`);

  const model = LogisticValueModel.fromFit(fit);
  fs.mkdirSync(path.dirname(path.resolve(OUT)) || ".", { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(model.toJSON()));
  fs.writeFileSync(`${OUT}.metrics.json`, JSON.stringify({
    in: IN, dim, nRows, nGames, valFrac: VAL, epochs: EPOCHS, lr: LR, l2: L2, batch: BATCH,
    train: trM, val: vaM, createdAt: new Date().toISOString(),
  }, null, 2));
  console.log(`saved value model → ${OUT}`);
}

main();
