import { describe, it, expect } from "vitest";
import { cards } from "../engine/testkit"; // loads + registers the disk card pool
import { RandomAgent } from "./agents/RandomAgent";
import { HeuristicAgent } from "./agents/HeuristicAgent";
import { MctsAgent } from "./agents/MctsAgent";
import { runArena, formatArena } from "./arena/arena";

// A realistic mixed deck (the "Iop test" list).
const MIXED = [
  533, 533, 16, 16, 427, 427, 126, 126, 428, 72, 72, 72, 152, 985, 985, 985, 81,
  256, 256, 256, 283, 149, 149, 21, 21, 118, 118, 118, 429, 429,
];

// These are real self-play benchmarks (slow but deterministic, the seeded RNG
// makes every game reproducible, so the scores below are fixed, not flaky).
// They are the heavier AI tests; generous timeouts.
describe("MctsAgent (search core)", () => {
  it("crushes Random, more decisively than the 1-ply heuristic does", () => {
    cards();
    const r = runArena(
      new MctsAgent({ simulations: 80, maxBranch: 10 }),
      new RandomAgent(),
      { games: 16, decks: { ally: MIXED, enemy: MIXED }, baseSeed: 1, maxTurns: 120 },
    );
    // eslint-disable-next-line no-console
    console.log(formatArena("MCTS(80) vs Random", r));
    expect(r.scoreA).toBeGreaterThan(0.8);
  }, 30000);

  it("Beats the heuristic, the tree search adds real multi-turn lookahead", () => {
    cards();
    // Heuristic prior (top-K) focuses the budget so the search out-reads the
    // 1-ply heuristic. Strength scales with `simulations` = the difficulty knob.
    const r = runArena(
      new MctsAgent({ simulations: 250, maxBranch: 10 }),
      new HeuristicAgent(),
      { games: 16, decks: { ally: MIXED, enemy: MIXED }, baseSeed: 1, maxTurns: 120 },
    );
    // eslint-disable-next-line no-console
    console.log(formatArena("MCTS(250) vs Heuristic", r));
    expect(r.scoreA).toBeGreaterThan(0.5);
  }, 90000);
});
