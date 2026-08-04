// Determinism and hygiene checks, run across the corpus (all gods) so that every
// god's effects fire (including paths a single deck never reaches: Ecaflip dice in
// effects.ts, random-summon family picks, etc.). Five checks:
//  (1) tripwire      : patch Math.random to throw in a seeded sim -> 0 hits required.
//  (2) replay equal  : same (decks, seed) -> byte-identical game.
//  (3) immutability  : applyAction must not mutate its input state (MCTS relies on
//                      this; catches in-place Set/array aliasing).
//  (4) MIRROR-SYM    : identical decks, first player swapped -> ally-seat win rate
//                      ~50% overall (catches an engine bug that favours one side).
//  (5) no HARD-LOCK  : a non-terminal state must always offer at least 1 legal action.
//                      Zero legal actions means a non-optional pendingAction opened
//                      with no valid target (or a pick you cannot leave), which used
//                      to freeze self-play. Counted over every game the checks play.
// Run: npx tsx src/ai/cli/checkDeterminism.ts --reps 2
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { cards } from "../../engine/testkit";
import { createInitialState } from "../../engine/rules";
import { Rng } from "../../engine/rng";
import { RandomAgent } from "../agents/RandomAgent";
import { HeuristicAgent } from "../agents/HeuristicAgent";
import { actingSide, legalActions, applyAction } from "../actions";
import type { GameState } from "../../engine/state";
import type { Side } from "../../engine/board";
import type { Agent } from "../agents/Agent";

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const REPS = parseInt(arg("--reps", "2"), 10);
const MIRROR = parseInt(arg("--mirror", "25"), 10); // seeds per deck for the mirror check

cards();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DECKS_PATH = path.resolve(HERE, "../../../decks-corpus/decks.json");
const corpus = JSON.parse(fs.readFileSync(DECKS_PATH, "utf-8")) as Array<{ god: string; cards: Array<{ id: number; count: number }> }>;
const byGod = new Map<string, number[][]>();
for (const d of corpus) {
  const g = (d.god || "").toUpperCase();
  if (g === "FECA") continue;
  const expanded = d.cards.flatMap((c) => Array(c.count).fill(c.id) as number[]);
  if (expanded.length !== 45) continue;
  if (!byGod.has(g)) byGod.set(g, []);
  byGod.get(g)!.push(expanded);
}
const reps: { god: string; deck: number[] }[] = [];
for (const [g, decks] of byGod) for (const deck of decks.slice(0, REPS)) reps.push({ god: g, deck });
console.log(`corpus reps: ${reps.length} decks across ${byGod.size} gods (${REPS}/god)`);

const makeAgent = (k: "h" | "r"): Agent => (k === "h" ? new HeuristicAgent() : (new RandomAgent() as Agent));

function stateHash(s: GameState): number {
  let h = 2166136261 >>> 0;
  const mix = (v: number) => { h = Math.imul(h ^ (v >>> 0), 16777619) >>> 0; };
  const mixStr = (str: string) => { for (let i = 0; i < str.length; i++) mix(str.charCodeAt(i)); };
  mix(s.turn); mixStr(s.activeSide); mix(s.rng >>> 0); mixStr(s.winner ?? "_");
  for (const c of s.creatures) {
    mix(c.instanceId); mix(c.position.x * 7 + c.position.y);
    mix((c.currentLife + 1000) | 0); mix((c.currentAttack + 1000) | 0); mix((c.armor + 1000) | 0); mix((c.movementLeft + 1000) | 0);
    mixStr([...c.properties].sort().join(","));
  }
  for (const d of s.dofuses) { mix(d.position.x * 7 + d.position.y); mix((d.currentLife + 1000) | 0); mixStr(d.kind); }
  for (const side of ["ally", "enemy"] as Side[]) {
    const p = s.players[side]; mix(p.ap); mix(p.apReserve); mix(p.hand.length); mix(p.deck.length); mixStr(p.hand.join(","));
  }
  return h;
}

// (5) HARD-LOCK aggregation, a non-terminal state with zero legal actions. Every
// runGame call (across all four checks) feeds this, so the gate sees thousands of
// games across all gods. A single hit fails the gate.
let hardLocks = 0;
const hardLockSamples: string[] = [];

function runGame(
  deckA: number[], deckB: number[], aK: "h" | "r", bK: "h" | "r", seed: number,
  opts: { firstSide?: Side; checkImmut?: boolean } = {},
) {
  let state = createInitialState({ ally: deckA, enemy: deckB }, { seed, firstSide: opts.firstSide });
  const rng = new Rng((seed ^ 0x9e3779b9) | 0);
  const a = makeAgent(aK), b = makeAgent(bK);
  let plies = 0, immutFails = 0;
  let fp = 2166136261 >>> 0;
  const mix = (v: number) => { fp = Math.imul(fp ^ (v >>> 0), 16777619) >>> 0; };
  while (state.winner === null && state.turn <= 200) {
    const side: Side = actingSide(state);
    const legal = legalActions(state);
    if (legal.length === 0) {
      // Invariant violation: the loop guard already guarantees winner===null &&
      // turn<=200, so a non-terminal state with no legal action is a HARD-LOCK.
      // Record it (with the stuck pick's prompt) for check [5] and stop this game.
      hardLocks++;
      if (hardLockSamples.length < 12) hardLockSamples.push(`seed ${seed} turn ${state.turn}: ${state.pendingAction?.prompt ?? "(no pending)"}`);
      break;
    }
    const act = (side === "ally" ? a : b).chooseAction(state, legal, rng);
    mix(act.kind.length);
    if (act.kind === "play") { mix(act.cardId); mix(act.target.x * 7 + act.target.y); }
    else if (act.kind === "resolve") { mix(act.target.x * 7 + act.target.y + 99); }
    if (opts.checkImmut) {
      const before = stateHash(state);
      const next = applyAction(state, act);
      if (stateHash(state) !== before) immutFails++; // input state was mutated
      state = next;
    } else {
      state = applyAction(state, act);
    }
    if (++plies > 4000) break;
  }
  return { winner: state.winner, turns: state.turn, plies, fp, immutFails };
}

// ---- (1) Tripwire over every ordered god-pair (heuristic both: plays real cards -> fires effects). ----
const ORIGINAL_RANDOM = Math.random;
let tripHits = 0, games = 0;
const tripPairs: string[] = [];
Math.random = () => { throw new Error("Math.random() called inside seeded simulation"); };
try {
  let seed = 1000;
  for (let i = 0; i < reps.length; i++) {
    for (let j = 0; j < reps.length; j++) {
      seed++; games++;
      try { runGame(reps[i].deck, reps[j].deck, "h", "h", seed); }
      catch (e) {
        if (e instanceof Error && e.message.includes("Math.random")) { tripHits++; if (tripPairs.length < 12) tripPairs.push(`${reps[i].god} vs ${reps[j].god} (seed ${seed})`); }
        else throw e;
      }
    }
    process.stderr.write(`\r(1) tripwire ${i + 1}/${reps.length} (games=${games}, hits=${tripHits})    `);
  }
} finally { Math.random = ORIGINAL_RANDOM; }
console.log(`\n[1] Math.random tripwire : ${tripHits === 0 ? `PASS (0 hits / ${games} games)` : `FAIL (${tripHits}) -> ${tripPairs.join(" | ")}`}`);

// ---- (2) Replay equality over every ordered god-pair. ----
let replayFails = 0, rgames = 0;
const replayKeys: string[] = [];
let rseed = 50000;
for (let i = 0; i < reps.length; i++) {
  for (let j = 0; j < reps.length; j++) {
    rseed++; rgames++;
    const r1 = runGame(reps[i].deck, reps[j].deck, "h", "h", rseed);
    const r2 = runGame(reps[i].deck, reps[j].deck, "h", "h", rseed);
    if (r1.winner !== r2.winner || r1.turns !== r2.turns || r1.plies !== r2.plies || r1.fp !== r2.fp) {
      replayFails++; if (replayKeys.length < 12) replayKeys.push(`${reps[i].god} vs ${reps[j].god} (seed ${rseed})`);
    }
  }
  process.stderr.write(`\r(2) replay ${i + 1}/${reps.length} (games=${rgames}, fails=${replayFails})    `);
}
console.log(`\n[2] replay equality      : ${replayFails === 0 ? `PASS (${rgames} pairs)` : `FAIL (${replayFails}) -> ${replayKeys.join(" | ")}`}`);

// ---- (3) Immutability: applyAction must not mutate its input (sample of games). ----
let immutFails = 0, immutGames = 0;
for (let i = 0; i < Math.min(reps.length, 9); i++) {
  for (let j = 0; j < Math.min(reps.length, 9); j++) {
    immutGames++;
    immutFails += runGame(reps[i].deck, reps[j].deck, "h", "h", 70000 + i * 100 + j, { checkImmut: true }).immutFails;
  }
}
console.log(`[3] applyAction immutab. : ${immutFails === 0 ? `PASS (${immutGames} games, input never mutated)` : `FAIL (${immutFails} in-place mutations)`}`);

// ---- (4) Mirror symmetry: identical decks, first-player swapped -> seat score ~50%
//          (draws scored 0.5 so they do not fake a bias). ----
let mAlly = 0, mEnemy = 0, mDraw = 0, mirrorGames = 0;
const mdecks = reps.slice(0, Math.min(reps.length, 4));
const mTotal = mdecks.length * MIRROR * 2;
for (const r of mdecks) {
  for (let s = 0; s < MIRROR; s++) {
    for (const fs2 of ["ally", "enemy"] as Side[]) {
      mirrorGames++;
      const w = runGame(r.deck, r.deck, "h", "h", 90000 + s, { firstSide: fs2 }).winner;
      if (w === "ally") mAlly++; else if (w === "enemy") mEnemy++; else mDraw++;
      if (mirrorGames % 10 === 0) process.stderr.write(`\r(4) mirror ${mirrorGames}/${mTotal}    `);
    }
  }
}
const seatScore = (mAlly + 0.5 * mDraw) / mirrorGames;
const decided = mAlly + mEnemy;
const allyShare = decided > 0 ? mAlly / decided : 0.5;
const mirrorOk = Math.abs(seatScore - 0.5) <= 0.05;
console.log(`\n[4] mirror symmetry      : ${mirrorOk ? "PASS" : "FAIL"} (seat score ${(seatScore * 100).toFixed(1)}% | ally/enemy/draw = ${mAlly}/${mEnemy}/${mDraw} | ally share of decided ${(allyShare * 100).toFixed(1)}%)`);

// ---- (5) No hard-lock: aggregated over every game the four checks above played. ----
console.log(`[5] no hard-lock         : ${hardLocks === 0 ? "PASS (0 hard-locks / all games)" : `FAIL (${hardLocks}) -> ${hardLockSamples.join(" | ")}`}`);

console.log("=== M0 determinism gate ===");
console.log(tripHits === 0 && replayFails === 0 && immutFails === 0 && mirrorOk && hardLocks === 0 ? "GATE: GREEN" : "GATE: RED");
