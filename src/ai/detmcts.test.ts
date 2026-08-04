import { describe, it, expect } from "vitest";
import { cards } from "../engine/testkit";
import { RandomAgent } from "./agents/RandomAgent";
import { DeterminizedMctsAgent } from "./agents/DeterminizedMctsAgent";
import { runArena, formatArena } from "./arena/arena";

const MIXED = [
  533, 533, 16, 16, 427, 427, 126, 126, 428, 72, 72, 72, 152, 985, 985, 985, 81,
  256, 256, 256, 283, 149, 149, 21, 21, 118, 118, 118, 429, 429,
];

// The fair agent: it never reads the opponent's hand or the true nature of the Dofus. It samples
// plausible worlds (determinize) and searches each. The sampling itself is tested in
// determinize.test.ts; here we only check that the fair agent still plays well (clearly beats
// Random). Against the heuristic it is about even at this budget; the real gain needs the trained
// net (better prior + eval + fast inference → many more sims). Deterministic through the seeded RNG.
describe("DeterminizedMctsAgent (fair search)", () => {
  it("plays well under hidden information, clearly beats Random", () => {
    cards();
    const r = runArena(
      new DeterminizedMctsAgent({ worlds: 4, simulations: 60, maxBranch: 10 }),
      new RandomAgent(),
      { games: 8, decks: { ally: MIXED, enemy: MIXED }, baseSeed: 1, maxTurns: 100 },
    );
    // eslint-disable-next-line no-console
    console.log(formatArena("DetMCTS(4x60) vs Random", r));
    expect(r.scoreA).toBeGreaterThan(0.6);
  }, 30000);
});
