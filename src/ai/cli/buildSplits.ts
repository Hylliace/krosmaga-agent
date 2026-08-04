// Loads the weighted corpus, sanity-checks the sampler, builds the stratified
// dedup k-fold splits, writes decks-corpus/splits.json, and reports.
// Run: npx tsx src/ai/cli/buildSplits.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { cards } from "../../engine/testkit";
import { Rng } from "../../engine/rng";
import { loadCorpus } from "../corpus/loader";
import { CorpusSampler } from "../corpus/sample";
import { buildSplits, dedupClusters } from "../corpus/splits";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../decks-corpus");
const DECKS = path.join(ROOT, "decks.json");
const WEIGHTS = path.join(ROOT, "weights.json");
const SPLITS_OUT = path.join(ROOT, "splits.json");

const pool = cards();
const { decks, weights } = loadCorpus(DECKS, WEIGHTS, {
  isKnownCard: (id) => pool.has(id),
  warn: (m) => console.warn("  [skip]", m),
});

console.log(`\n=== LOADER ===`);
console.log(`loaded ${decks.length} decks (Feca excluded); floor/cap ${weights.floor}/${weights.cap}`);
const byGod = new Map<string, number>();
for (const d of decks) byGod.set(d.god, (byGod.get(d.god) ?? 0) + 1);
console.log("per god:", [...byGod].map(([g, n]) => `${g} ${n}`).join(", "));
const ws = decks.map((d) => d.weight);
console.log(`weight range: ${Math.min(...ws).toFixed(2)} .. ${Math.max(...ws).toFixed(2)} (mean ${(ws.reduce((a, b) => a + b, 0) / ws.length).toFixed(2)})`);

console.log(`\n=== SAMPLER ===`);
const rng = new Rng(123);
const sampler = new CorpusSampler(decks);
for (const [label, alpha] of [["proportional", 0], ["god-normalized", 1]] as const) {
  let firstCheaperOk = 0;
  const godHits = new Map<string, number>();
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const m = sampler.matchup(rng, { alpha });
    const expectedFirst = m.ally.costAP <= m.enemy.costAP ? "ally" : "enemy";
    if (m.firstSide === expectedFirst) firstCheaperOk++;
    godHits.set(m.ally.god, (godHits.get(m.ally.god) ?? 0) + 1);
    godHits.set(m.enemy.god, (godHits.get(m.enemy.god) ?? 0) + 1);
  }
  const cov = [...byGod.keys()].sort().map((g) => `${g} ${((100 * (godHits.get(g) ?? 0)) / (2 * N)).toFixed(1)}%`).join("  ");
  console.log(`[${label}] firstSide=cheaper: ${firstCheaperOk === N ? "PASS" : `FAIL ${firstCheaperOk}/${N}`}`);
  console.log(`   god share: ${cov}`);
}

console.log(`\n=== SPLITS (k=5, dedup) ===`);
const splits = buildSplits(decks, 5, 7);
fs.writeFileSync(SPLITS_OUT, JSON.stringify(splits, null, 2));
// stratification matrix: fold x god
const fg = new Map<string, number[]>();
for (const d of decks) {
  if (!fg.has(d.god)) fg.set(d.god, new Array(splits.k).fill(0));
  fg.get(d.god)![splits.folds[d.deckId]]++;
}
console.log(`wrote ${SPLITS_OUT}`);
const nClusters = new Set(dedupClusters(decks, splits.dupThreshold)).size;
console.log(`dedup: ${decks.length} decks -> ${nClusters} clusters (near-duplicates merged, kept in same fold)`);
console.log(`fold sizes: ${[...Array(splits.k)].map((_, f) => decks.filter((d) => splits.folds[d.deckId] === f).length).join(" / ")}`);
console.log("stratification (god x fold, decks per fold):");
for (const [g, arr] of [...fg].sort()) console.log(`   ${g.padEnd(9)} ${arr.join(" ")}`);
