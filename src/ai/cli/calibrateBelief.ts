// Belief calibration on a held-out fold. Generates games where the opponent
// (enemy) plays a held-out deck and "me" (ally) plays a train deck, so the
// opponent's true 45-card list is not a particle of the corpus (no leakage).
// Builds the belief from public information only and reports Brier (main metric)
// and ECE against a prior-only baseline.
//
//   npx tsx src/ai/cli/calibrateBelief.ts --games 300 --fold 0
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { cards } from "../../engine/testkit";
import { Rng } from "../../engine/rng";
import { HeuristicAgent } from "../agents/HeuristicAgent";
import { loadCorpus } from "../corpus/loader";
import { trainDecks, heldOutDecks } from "../corpus/splits";
import { recordGameRaw, type RawGame, type RawMatchup } from "../selfplay/recordRaw";
import { buildCorpusBelief } from "../belief/corpus";
import { calibrate } from "../belief/calibrate";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const GAMES = parseInt(arg("--games", "300"), 10);
const FOLD = parseInt(arg("--fold", "0"), 10);
const SEED = parseInt(arg("--seed", "777"), 10);

const pool = cards();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.resolve(HERE, "../../../decks-corpus");
const { decks } = loadCorpus(path.join(CORPUS, "decks.json"), path.join(CORPUS, "weights.json"), { isKnownCard: (id) => pool.has(id) });
const splits = JSON.parse(fs.readFileSync(path.join(CORPUS, "splits.json"), "utf-8"));

const train = trainDecks(decks, splits, FOLD);
const held = heldOutDecks(decks, splits, FOLD);
console.log(`fold ${FOLD}: ${train.length} train / ${held.length} held-out decks; building belief on train...`);
const corpusMap = buildCorpusBelief(train);

const rng = new Rng(SEED);
const pick = <T,>(a: T[]) => a[rng.int(a.length)];

console.log(`generating ${GAMES} games (enemy = held-out, ally = train)...`);
const games: RawGame[] = [];
let stuck = 0;
for (let i = 0; i < GAMES; i++) {
  const me = pick(train);      // ally = train
  const foe = pick(held);      // enemy = held-out (the deck we must not have memorised)
  const firstSide = me.costAP <= foe.costAP ? "ally" : "enemy";
  const mu: RawMatchup = { a: { god: me.god }, e: { god: foe.god } };
  const raw = recordGameRaw(new HeuristicAgent(), new HeuristicAgent(), {
    decks: { ally: me.cards, enemy: foe.cards }, seed: SEED + 1 + i, firstSide,
    gods: { ally: me.god, enemy: foe.god }, maxTurns: 200, maxPlies: 1500, mu,
    onStuck: () => { stuck++; },
  });
  if (raw) games.push(raw);
  if (i % 50 === 0) process.stdout.write(`  ${i}/${GAMES} (${games.length} kept, ${stuck} stuck)\r`);
}

console.log(`\nscoring belief over ${games.length} games...`);
const r = calibrate(games, corpusMap, { observer: "ally", everyNth: 4 });

console.log(`\n=== BELIEF CALIBRATION (fold ${FOLD}, held-out foe) ===`);
console.log(`samples      : ${r.n}`);
console.log(`Brier        : ${r.brier.toFixed(4)}   (baseline prior-only ${r.baselineBrier.toFixed(4)}, ` +
  `${((1 - r.brier / r.baselineBrier) * 100).toFixed(1)}% better)`);
console.log(`ECE (quant.) : ${r.ece.toFixed(4)}   MCE ${r.mce.toFixed(4)}   logloss ${r.logloss.toFixed(4)}`);
console.log(`reliability  : ` + r.reliability.map((b) => `[${b.conf.toFixed(2)}->${b.acc.toFixed(2)}]`).join(" "));
console.log(`per god (Brier model/baseline):`);
for (const [g, s] of Object.entries(r.perGod).sort())
  console.log(`   ${g.padEnd(9)} ${s.brier.toFixed(4)} / ${s.baselineBrier.toFixed(4)}  (n=${s.n})`);
const pass = r.brier < r.baselineBrier;
console.log(`\nVERDICT: ${pass ? "model beats prior baseline (Brier)" : "model NOT better than baseline — investigate"}`);
