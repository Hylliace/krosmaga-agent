// Direct reproduction of the seed-15 symptom: a raw game must replay exactly.
// During recording the agent's lookahead used to mutate the live state (Shield
// aliasing), so a recorded action could be illegal in the clean replay (card 884
// "played" while not in hand). This checks, for many weighted match-ups, that
//   (a) every stored action is legal at its replay decision point, and
//   (b) the replayed result/turns match the recorded result/turns.
// A single failure prints the diverging act; 0 failures = the fix holds.
//
//   npx tsx src/ai/cli/verifyReplay.ts --games 400
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { cards } from "../../engine/testkit";
import { Rng } from "../../engine/rng";
import { HeuristicAgent } from "../agents/HeuristicAgent";
import { loadCorpus } from "../corpus/loader";
import { CorpusSampler } from "../corpus/sample";
import { createInitialState } from "../../engine/rules";
import { actingSide, legalActions, applyAction } from "../actions";
import { recordGameRaw, decodeAction, type RawMatchup } from "../selfplay/recordRaw";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const GAMES = parseInt(arg("--games", "400"), 10);

cards();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.resolve(HERE, "../../../decks-corpus");
const { decks } = loadCorpus(path.join(CORPUS, "decks.json"), path.join(CORPUS, "weights.json"), { isKnownCard: () => true });
const sampler = new CorpusSampler(decks);
const rng = new Rng(20260629);

const sameAction = (a: ReturnType<typeof decodeAction>, b: ReturnType<typeof decodeAction>) => JSON.stringify(a) === JSON.stringify(b);

// Patch Math.random to throw inside the seeded sim (mirrors genRawGames): a game
// that touches it is NON-DETERMINISTIC (an effect path that did not thread the rng)
// and is discarded, exactly as the dataset generator discards it. The point of
// this run is to prove that every game that does not touch Math.random replays
// byte-for-byte, i.e. the residual divergence is the rng-threading gap, not aliasing.
const ORIGINAL_RANDOM = Math.random;
const trip = () => { throw new Error("Math.random() in seeded sim"); };

let ok = 0, illegal = 0, mismatch = 0, skipped = 0, nondeterm = 0;
const ndSeeds: string[] = [];
for (let i = 0; i < GAMES; i++) {
  const m = sampler.matchup(rng, { alpha: 1 });
  const seed = 1_000_000 + i;
  const mu: RawMatchup = { a: { god: m.ally.god }, e: { god: m.enemy.god } };
  let raw;
  Math.random = trip;
  try {
    raw = recordGameRaw(new HeuristicAgent(), new HeuristicAgent(), {
      decks: { ally: m.ally.cards, enemy: m.enemy.cards }, seed, firstSide: m.firstSide,
      gods: { ally: m.ally.god, enemy: m.enemy.god }, maxTurns: 200, maxPlies: 1500, mu,
    });
  } catch (e) {
    Math.random = ORIGINAL_RANDOM;
    if (e instanceof Error && e.message.includes("Math.random")) { nondeterm++; if (ndSeeds.length < 20) ndSeeds.push(`${m.ally.god} vs ${m.enemy.god} (seed ${seed})`); continue; }
    throw e;
  }
  Math.random = ORIGINAL_RANDOM;
  if (!raw) { skipped++; continue; }

  // Replay: re-apply every stored action from a fresh initial state, asserting
  // each is legal at the decision point it claims to act on.
  Math.random = trip;
  let state = createInitialState({ ally: raw.decks.a, enemy: raw.decks.e }, { seed: raw.seed, firstSide: raw.first, gods: { ally: m.ally.god, enemy: m.enemy.god } });
  let bad = false;
  try {
    for (let k = 0; k < raw.acts.length; k++) {
      const act = decodeAction(raw.acts[k]);
      const legal = legalActions(state);
      if (!legal.some((l) => sameAction(l, act))) {
        illegal++; bad = true;
        const side = actingSide(state);
        console.log(`\n[ILLEGAL] seed=${seed} ${m.ally.god} vs ${m.enemy.god} act#${k}=${JSON.stringify(raw.acts[k])} mover=${side} (not among ${legal.length} legal)`);
        break;
      }
      state = applyAction(state, act);
    }
  } finally { Math.random = ORIGINAL_RANDOM; }
  if (bad) continue;
  const w = state.winner === null ? 0 : state.winner === "ally" ? 1 : -1;
  if (w !== raw.res.w || state.turn !== raw.res.turns) {
    mismatch++;
    console.log(`\n[MISMATCH] seed=${seed} recorded w=${raw.res.w} t=${raw.res.turns} -> replay w=${w} t=${state.turn}`);
    continue;
  }
  ok++;
  if (i % 50 === 0) process.stderr.write(`\r  ${i}/${GAMES} (ok=${ok} illegal=${illegal} mismatch=${mismatch} nd=${nondeterm} skip=${skipped})    `);
}
const replayed = GAMES - skipped - nondeterm;
console.log(`\n=== verifyReplay: ${ok}/${replayed} deterministic games replay exact | illegal=${illegal} mismatch=${mismatch} | nondeterm-discarded=${nondeterm} stuck=${skipped} ===`);
if (ndSeeds.length) console.log(`  Math.random (rng-threading gap) games: ${ndSeeds.join(" | ")}`);
console.log(illegal === 0 && mismatch === 0 ? "REPLAY: GREEN — every deterministic game re-encodes exactly (residual = rng-threading gap only)." : "REPLAY: RED — a deterministic game still diverged (real bug).");
