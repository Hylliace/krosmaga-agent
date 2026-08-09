// Portfolio of opponent policies (oppK). These tests check that the board kept with
// two policies is never better for me than with one (it is a min over a larger set),
// that the scoring with two policies is deterministic, and that leaving oppK out gives
// the same score as oppK = 1.
import { describe, it, expect } from "vitest";
import { scenario, cards, mkCreature } from "../../engine/testkit";
import { oneStepHeuristicScore, worstOppBoard } from "./MctsAgent";
import { evaluate } from "../eval";
import { actingSide, legalActions, applyAction } from "../actions";

const FLEAU = 757;

function mkState() {
  cards();
  const ally = mkCreature(1, "ally", { x: 6, y: 2 }, { currentAttack: 2, currentLife: 3, baseMovement: 2 });
  const foe1 = mkCreature(2, "enemy", { x: 3, y: 2 }, { currentAttack: 2, currentLife: 4, baseMovement: 2 });
  const foe2 = mkCreature(3, "enemy", { x: 4, y: 0 }, { currentAttack: 3, currentLife: 2, baseMovement: 3 });
  return scenario([ally, foe1, foe2], FLEAU);
}

describe("portfolio of opponent policies (oppK)", () => {
  it("min: eval(worstOppBoard k=2) <= eval(worstOppBoard k=1)", () => {
    // The property holds for the portfolio (a min over a larger set of
    // continuations), not for the full score, whose Dofus term is compared to a
    // baseline that also changes with k.
    const s = mkState();
    const side = actingSide(s);
    const myEnd = applyAction(s, { kind: "endTurn" });
    const e1 = evaluate(worstOppBoard(myEnd, side, 1), side);
    const e2 = evaluate(worstOppBoard(myEnd, side, 2), side);
    expect(e2).toBeLessThanOrEqual(e1 + 1e-9);
  });

  it("two calls with k=2 give the same score", () => {
    const s = mkState();
    const side = actingSide(s);
    const a = legalActions(s)[0];
    const x = oneStepHeuristicScore(s, a, side, true, true, true, 2);
    const y = oneStepHeuristicScore(s, a, side, true, true, true, 2);
    expect(x).toBe(y);
  });

  it("k=1 by default: leaving oppK out gives the same score as oppK=1", () => {
    const s = mkState();
    const side = actingSide(s);
    const a = legalActions(s)[0];
    const without = oneStepHeuristicScore(s, a, side, true, true, true);
    const k1 = oneStepHeuristicScore(s, a, side, true, true, true, 1);
    expect(without).toBe(k1);
  });
});
