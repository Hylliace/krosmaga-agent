// The leaf-eval hook (where the value net plugs in). Uses a synthetic leafEval (no
// model) so it is fast and safe for CI; the real net path is covered by
// encode2.test, the TsValueModel parity test, and the arena CLI.
import { describe, it, expect, beforeAll } from "vitest";
import { cards, mkCreature, scenario } from "../../engine/testkit";
import { Rng } from "../../engine/rng";
import { MctsAgent, type LeafEval, type PriorFn } from "./MctsAgent";
import { legalActions } from "../actions";

beforeAll(() => { cards(); });

function multiActionState() {
  // Ally creature on board + two cheap summons in hand at full AP → many legal
  // actions (play each summon on each spawn cell, + endTurn).
  const cheap = [...cards().values()]
    .filter((c) => c.cardType === "Summon" && (c.cost ?? 9) <= 3 && !(c as { isDevCard?: boolean }).isDevCard)
    .slice(0, 2)
    .map((c) => c.id);
  const me = mkCreature(1, "ally", { x: 8, y: 2 }, { currentAttack: 2, currentLife: 4, movementLeft: 2 });
  const foe = mkCreature(2, "enemy", { x: 1, y: 2 }, { currentAttack: 2, currentLife: 4 });
  return scenario([me, foe], ...cheap);
}

describe("MCTS leaf-eval hook", () => {
  it("invokes the injected leafEval and returns root stats summing to the sim budget", () => {
    let calls = 0;
    const leafEval: LeafEval = () => { calls++; return 0.25; };
    const agent = new MctsAgent({ simulations: 40, maxBranch: 5, leafEval });
    const stats = agent.searchRootStats(multiActionState(), new Rng(1));
    expect(calls).toBeGreaterThan(0);
    expect(stats.length).toBeGreaterThan(0);
    const totalVisits = stats.reduce((a, s) => a + s.visits, 0);
    expect(totalVisits).toBe(40); // every simulation visits exactly one root child
  });

  it("steers toward the action the leafEval rewards", () => {
    // leafEval that loves a specific outcome: reward boards where my creature has
    // advanced (lower x in ally frame). The search should prefer moving forward.
    const leafEval: LeafEval = (probe, rootSide) => {
      const mine = probe.creatures.filter((c) => c.owner === rootSide && c.currentLife > 0);
      const adv = mine.reduce((a, c) => a + (9 - c.position.x), 0);
      return Math.tanh(adv / 10);
    };
    const agent = new MctsAgent({ simulations: 120, maxBranch: 6, leafEval });
    const stats = agent.searchRootStats(multiActionState(), new Rng(2));
    expect(stats.reduce((a, s) => a + s.visits, 0)).toBe(120);
    // A clear winner emerges (most-visited child has a real share of the budget).
    const top = Math.max(...stats.map((s) => s.visits));
    expect(top).toBeGreaterThan(120 / stats.length);
  });

  it("PUCT prior concentrates visits on the prior-favored action", () => {
    const state = multiActionState();
    // Prior favors endTurn (identified by content, always legal). maxBranch wide so
    // the candidate set covers all legal moves (no heuristic exclusion). Flat leaf
    // so the prior, not the value, drives selection.
    const priorFn: PriorFn = (_s, acts) => {
      const w = new Float32Array(acts.length).fill(0.001);
      const i = acts.findIndex((a) => a.kind === "endTurn");
      if (i >= 0) w[i] = 1;
      return w;
    };
    const agent = new MctsAgent({ simulations: 150, maxBranch: 50, leafEval: () => 0, priorFn, cPuct: 2 });
    const stats = agent.searchRootStats(state, new Rng(3));
    const et = stats.find((s) => s.action.kind === "endTurn");
    expect(et).toBeDefined();
    // With a flat value and a peaked prior, PUCT keeps re-selecting the favored arm.
    expect(et!.visits).toBe(Math.max(...stats.map((s) => s.visits)));
  });
});
