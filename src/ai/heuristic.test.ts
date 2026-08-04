import { describe, it, expect } from "vitest";
import { scenario, mkCreature, cards } from "../engine/testkit";
import { evaluate } from "./eval";
import { RandomAgent } from "./agents/RandomAgent";
import { HeuristicAgent } from "./agents/HeuristicAgent";
import { runArena, formatArena } from "./arena/arena";

// A realistic mixed deck (summons + spells + targeting), so the heuristic's
// edge over Random, good targeting, not wasting cards, sane tempo, actually
// shows. (The "Iop test" list.)
const MIXED_DECK = [
  533, 533, 16, 16, 427, 427, 126, 126, 428, 72, 72, 72, 152, 985, 985, 985, 81,
  256, 256, 256, 283, 149, 149, 21, 21, 118, 118, 118, 429, 429,
];

describe("evaluate (heuristic)", () => {
  it("a winning state scores hugely positive, a losing one hugely negative", () => {
    const s = scenario([]);
    expect(evaluate({ ...s, winner: "ally" }, "ally")).toBeGreaterThan(0);
    expect(evaluate({ ...s, winner: "enemy" }, "ally")).toBeLessThan(0);
  });

  it("an extra allied creature on the board raises the score", () => {
    const empty = scenario([]);
    const withCreature = scenario([mkCreature(1, "ally", { x: 5, y: 2 }, { currentAttack: 3, currentLife: 4 })]);
    expect(evaluate(withCreature, "ally")).toBeGreaterThan(evaluate(empty, "ally"));
  });

  it("damaging an enemy real Dofus improves the ally score", () => {
    const s = scenario([]);
    const er = s.dofuses.find((d) => d.owner === "enemy" && d.kind === "real")!;
    const damaged = { ...s, dofuses: s.dofuses.map((d) => (d === er ? { ...d, currentLife: 1 } : d)) };
    expect(evaluate(damaged, "ally")).toBeGreaterThan(evaluate(s, "ally"));
  });

  it("threat is measured in TURNS-to-reach, not raw distance", () => {
    // Same stats; the only difference is how fast it reaches the enemy base.
    //   far+fast: 6 cells away, 6 PM → reaches in 1 turn  (more dangerous)
    //   near+slow: 3 cells away, 2 PM → reaches in 2 turns (less dangerous)
    const stats = { currentAttack: 3, currentLife: 3, baseLife: 3 };
    const farFast = scenario([mkCreature(1, "ally", { x: 6, y: 2 }, { ...stats, baseMovement: 6 })]);
    const nearSlow = scenario([mkCreature(1, "ally", { x: 3, y: 2 }, { ...stats, baseMovement: 2 })]);
    expect(evaluate(farFast, "ally")).toBeGreaterThan(evaluate(nearSlow, "ally"));
  });

  it("is zero-sum-ish: a position good for ally is bad for enemy", () => {
    const withCreature = scenario([mkCreature(1, "ally", { x: 5, y: 2 }, { currentAttack: 3, currentLife: 4 })]);
    expect(evaluate(withCreature, "ally")).toBeGreaterThan(0);
    expect(evaluate(withCreature, "enemy")).toBeLessThan(0);
  });
});

describe("HeuristicAgent vs RandomAgent (benchmark)", () => {
  it("the turn-aware heuristic clearly beats Random and is reproducible", () => {
    cards(); // populate the card registry so `play` actions resolve
    // With the turns-to-reach threat and the tier-1 hand differential, this was
    // measured at ~0.93-0.95 on this mixed deck across seeds. The test checks a safe
    // floor. MCTS closes the remaining gap to perfect play.
    const opts = { games: 80, decks: { ally: MIXED_DECK, enemy: MIXED_DECK }, baseSeed: 1, maxTurns: 200 };
    const r = runArena(new HeuristicAgent(), new RandomAgent(), opts);
    // eslint-disable-next-line no-console
    console.log(formatArena("Heuristic(A) vs Random(B), 80 mixed games", r));
    expect(r.scoreA).toBeGreaterThan(0.85);
    // Deterministic batch.
    const r2 = runArena(new HeuristicAgent(), new RandomAgent(), opts);
    expect(r2.scoreA).toBe(r.scoreA);
  }, 30000); // 160 games (two reproducible batches) can edge past the 5s default
});
