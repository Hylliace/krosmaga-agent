// Held-out hyperparameter sweep for the belief model. Generates the games against
// held-out opponents once per fold (the expensive engine replay), caches the public
// observations, then scores them again cheaply over a (tau, lambdaMiss, eps0) grid,
// averaging the metrics across folds (k-fold selection, so the hyperparameters do
// not overfit one fold).
//
//   npx tsx src/ai/cli/sweepBelief.ts --games 140 --folds 0,1,2
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { cards } from "../../engine/testkit";
import { Rng } from "../../engine/rng";
import { HeuristicAgent } from "../agents/HeuristicAgent";
import { loadCorpus } from "../corpus/loader";
import { trainDecks, heldOutDecks } from "../corpus/splits";
import { recordGameRaw, type RawMatchup } from "../selfplay/recordRaw";
import { buildCorpusBelief, type BeliefHyperParams } from "../belief/corpus";
import { extractObs, scoreCached, type CachedGame } from "../belief/calibrate";
import type { DeckEntry } from "../corpus/loader";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const GAMES = parseInt(arg("--games", "140"), 10);
const FOLDS = arg("--folds", "0,1,2").split(",").map((s) => parseInt(s, 10));
const SEED = parseInt(arg("--seed", "4242"), 10);

const pool = cards();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.resolve(HERE, "../../../decks-corpus");
const { decks } = loadCorpus(path.join(CORPUS, "decks.json"), path.join(CORPUS, "weights.json"), { isKnownCard: (id) => pool.has(id) });
const splits = JSON.parse(fs.readFileSync(path.join(CORPUS, "splits.json"), "utf-8"));

// --- generate + cache games per fold (once) ---
const foldData: { fold: number; train: DeckEntry[]; cache: CachedGame[] }[] = [];
for (const fold of FOLDS) {
  const train = trainDecks(decks, splits, fold);
  const held = heldOutDecks(decks, splits, fold);
  const rng = new Rng(SEED + fold * 1009);
  const pick = <T,>(a: T[]) => a[rng.int(a.length)];
  const cache: CachedGame[] = [];
  let stuck = 0;
  for (let i = 0; i < GAMES; i++) {
    const me = pick(train), foe = pick(held);
    const firstSide = me.costAP <= foe.costAP ? "ally" : "enemy";
    const mu: RawMatchup = { a: { god: me.god }, e: { god: foe.god } };
    const raw = recordGameRaw(new HeuristicAgent(), new HeuristicAgent(), {
      decks: { ally: me.cards, enemy: foe.cards }, seed: SEED + fold * 1_000_000 + i, firstSide,
      gods: { ally: me.god, enemy: foe.god }, maxTurns: 200, maxPlies: 1500, mu, onStuck: () => { stuck++; },
    });
    if (raw) { const c = extractObs(raw, "ally"); if (c) cache.push(c); }
    if (i % 40 === 0) process.stdout.write(`  fold ${fold}: ${i}/${GAMES} (${cache.length} cached, ${stuck} stuck)\r`);
  }
  console.log(`\nfold ${fold}: ${train.length} train decks, ${cache.length} cached games`);
  foldData.push({ fold, train, cache });
}

// --- grid sweep (re-score cheaply per combo, average across folds) ---
const TAUS = [0.2, 0.3, 0.4, 0.6];
const LAMBDAS = [0.005, 0.01, 0.02];
const EPS0S = [0.05, 0.1];
console.log(`\nsweeping ${TAUS.length * LAMBDAS.length * EPS0S.length} combos over ${foldData.length} folds...\n`);

interface Row { tau: number; lambdaMiss: number; eps0: number; brier: number; baseline: number; ece: number; mce: number; rel: number; }
const rows: Row[] = [];
for (const tau of TAUS) for (const lambdaMiss of LAMBDAS) for (const eps0 of EPS0S) {
  const hyper: BeliefHyperParams = { tau, lambdaMiss, eps0 };
  let brier = 0, baseline = 0, ece = 0, mce = 0, nFolds = 0;
  for (const fd of foldData) {
    const corpusMap = buildCorpusBelief(fd.train, hyper);
    const r = scoreCached(fd.cache, corpusMap, { everyNth: 4 });
    brier += r.brier; baseline += r.baselineBrier; ece += r.ece; mce += r.mce; nFolds++;
  }
  rows.push({ tau, lambdaMiss, eps0, brier: brier / nFolds, baseline: baseline / nFolds, ece: ece / nFolds, mce: mce / nFolds, rel: 0 });
}
for (const r of rows) r.rel = (1 - r.brier / r.baseline) * 100;

rows.sort((a, b) => a.brier - b.brier);
console.log("rank  tau  lmiss  eps0 |  Brier   (vs base)   rel%   ECE     MCE");
rows.forEach((r, i) => {
  console.log(`${String(i + 1).padStart(2)}.   ${r.tau.toFixed(1)}  ${r.lambdaMiss.toFixed(3)}  ${r.eps0.toFixed(2)} | ${r.brier.toFixed(4)}  (${r.baseline.toFixed(4)})  ${r.rel.toFixed(1).padStart(5)}  ${r.ece.toFixed(4)}  ${r.mce.toFixed(4)}`);
});

const best = rows[0];
console.log(`\nBEST (by Brier): tau=${best.tau} lambdaMiss=${best.lambdaMiss} eps0=${best.eps0}` +
  ` -> Brier ${best.brier.toFixed(4)} (${best.rel.toFixed(1)}% better than prior), ECE ${best.ece.toFixed(4)}, MCE ${best.mce.toFixed(4)}`);
// Per-god of the best config on the first fold (diagnostic).
const bestMap = buildCorpusBelief(foldData[0].train, { tau: best.tau, lambdaMiss: best.lambdaMiss, eps0: best.eps0 });
const r0 = scoreCached(foldData[0].cache, bestMap, { everyNth: 4 });
console.log(`per-god (fold ${foldData[0].fold}, Brier model/baseline):`);
for (const [g, s] of Object.entries(r0.perGod).sort())
  console.log(`   ${g.padEnd(9)} ${s.brier.toFixed(4)} / ${s.baselineBrier.toFixed(4)}  (n=${s.n})`);
