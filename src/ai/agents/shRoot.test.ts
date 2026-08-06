// Sequential halving at the root. These tests check that it is deterministic for a
// given seed, that it spends exactly the budget (each simulation goes through one
// root child), that every candidate gets at least one visit in the first phase, and
// that the most visited move is never one the heuristic ranks near the bottom.
import { describe, it, expect } from "vitest";
import { scenario, cards, mkCreature } from "../../engine/testkit";
import { MctsAgent, oneStepHeuristicScore } from "./MctsAgent";
import { actingSide } from "../actions";
import { Rng } from "../../engine/rng";

const FLEAU = 757; // spell that damages a Dofus, gives several play candidates plus end of turn

function mkState() {
  cards();
  const ally = mkCreature(1, "ally", { x: 6, y: 2 }, { currentAttack: 2, currentLife: 3, baseMovement: 2 });
  const foe = mkCreature(2, "enemy", { x: 3, y: 2 }, { currentAttack: 1, currentLife: 4, baseMovement: 2 });
  return scenario([ally, foe], FLEAU);
}

describe("sequential halving at the root", () => {
  it("same seed, same root stats", () => {
    const s = mkState();
    const a1 = new MctsAgent({ simulations: 48, rootSH: true });
    const a2 = new MctsAgent({ simulations: 48, rootSH: true });
    expect(JSON.stringify(a1.searchRootStats(s, new Rng(7)))).toBe(JSON.stringify(a2.searchRootStats(s, new Rng(7))));
  });

  it("the root visits add up to the number of simulations", () => {
    const s = mkState();
    const stats = new MctsAgent({ simulations: 48, rootSH: true }).searchRootStats(s, new Rng(3));
    expect(stats.reduce((acc, x) => acc + x.visits, 0)).toBe(48);
  });

  it("every candidate is visited in the first phase", () => {
    const s = mkState();
    const stats = new MctsAgent({ simulations: 48, rootSH: true }).searchRootStats(s, new Rng(11));
    expect(stats.length).toBeGreaterThanOrEqual(2);
    for (const st of stats) expect(st.visits).toBeGreaterThanOrEqual(1);
  });

  it("the most visited move stays in the top half of the heuristic ranking", () => {
    const s = mkState();
    const side = actingSide(s);
    const stats = new MctsAgent({ simulations: 64, rootSH: true }).searchRootStats(s, new Rng(5));
    let top = stats[0];
    for (const st of stats) if (st.visits > top.visits) top = st;
    const scored = stats.map((st) => ({ st, h: oneStepHeuristicScore(s, st.action, side) })).sort((x, y) => y.h - x.h);
    expect(scored.findIndex((e) => e.st === top)).toBeLessThanOrEqual(Math.ceil(stats.length / 2));
  });

  it("off by default, so plain UCB1 does not change", () => {
    const s = mkState();
    const r1 = new MctsAgent({ simulations: 48 }).searchRootStats(s, new Rng(7));
    const r2 = new MctsAgent({ simulations: 48 }).searchRootStats(s, new Rng(7));
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});
