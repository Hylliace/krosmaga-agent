// Factored policy space contract.
import { describe, it, expect } from "vitest";
import type { Action } from "./actions";
import {
  whatIndex, whereIndex, whatSize, whatSpecials, WHERE_NONE, WHERE_SIZE,
  policyTargets, priorOverLegal,
} from "./policy";

const cardIndex = new Map<number, number>([[10, 0], [20, 1], [30, 2]]); // 3 cards → OOV=3, specials 4..7

describe("policy action space", () => {
  it("maps what/where for each action kind", () => {
    const sp = whatSpecials(cardIndex);
    expect(whatSize(cardIndex)).toBe(3 + 1 + 4); // vocab+OOV+4 specials = 8
    expect(whatIndex({ kind: "play", cardId: 20, target: { x: 3, y: 2 } }, cardIndex)).toBe(1);
    expect(whatIndex({ kind: "play", cardId: 999, target: { x: 0, y: 0 } }, cardIndex)).toBe(3); // OOV
    expect(whatIndex({ kind: "endTurn" }, cardIndex)).toBe(sp.ENDTURN);
    expect(whatIndex({ kind: "resolve", target: { x: 1, y: 1 } }, cardIndex)).toBe(sp.RESOLVE);
    expect(whereIndex({ kind: "play", cardId: 20, target: { x: 3, y: 2 } })).toBe(2 * 10 + 3);
    expect(whereIndex({ kind: "endTurn" })).toBe(WHERE_NONE);
    expect(WHERE_SIZE).toBe(51);
  });

  it("builds normalized what/where marginals from visit counts", () => {
    const stats = [
      { action: { kind: "play", cardId: 10, target: { x: 8, y: 0 } } as Action, visits: 30 },
      { action: { kind: "play", cardId: 20, target: { x: 8, y: 0 } } as Action, visits: 10 },
      { action: { kind: "endTurn" } as Action, visits: 60 },
    ];
    const { what, where } = policyTargets(stats, cardIndex);
    expect(what.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(where.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(what[0]).toBeCloseTo(0.3, 6); // card 10
    expect(what[whatSpecials(cardIndex).ENDTURN]).toBeCloseTo(0.6, 6);
    expect(where[8]).toBeCloseTo(0.4, 6);          // cell (x8,y0) = 0*10+8 = 8 (both plays)
    expect(where[WHERE_NONE]).toBeCloseTo(0.6, 6); // endTurn
  });

  it("priorOverLegal scores legal actions by what·where, renormalized", () => {
    const legal: Action[] = [
      { kind: "play", cardId: 10, target: { x: 8, y: 0 } },
      { kind: "endTurn" },
    ];
    const what = new Float32Array(whatSize(cardIndex));
    const where = new Float32Array(WHERE_SIZE);
    what[0] = 0.7; what[whatSpecials(cardIndex).ENDTURN] = 0.3;
    where[whereIndex(legal[0])] = 0.5; where[WHERE_NONE] = 0.5;
    const prior = priorOverLegal(legal, what, where, cardIndex);
    expect(prior.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(prior[0]).toBeGreaterThan(prior[1]); // 0.7*0.5 > 0.3*0.5
  });

  it("priorOverLegal falls back to uniform for a cold policy", () => {
    const legal: Action[] = [{ kind: "endTurn" }, { kind: "reserve" }];
    const prior = priorOverLegal(legal, new Float32Array(whatSize(cardIndex)), new Float32Array(WHERE_SIZE), cardIndex);
    expect(prior[0]).toBeCloseTo(0.5, 6);
    expect(prior[1]).toBeCloseTo(0.5, 6);
  });
});
