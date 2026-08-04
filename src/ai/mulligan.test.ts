// Mulligan v1 heuristic.
import { describe, it, expect, beforeAll } from "vitest";
import { cards } from "../engine/testkit";
import type { GameState } from "../engine/state";
import type { Card } from "../data/types";
import { mulliganV1 } from "./mulligan";

let cheap: number, mid: number, exp: number;

beforeAll(() => {
  const pool = cards();
  const byCost = (c: number) =>
    [...pool.values()].find((card: Card) => card.cost === c && !(card as { isDevCard?: boolean }).isDevCard)!.id;
  cheap = byCost(2); mid = byCost(4); exp = byCost(6);
});

function mulState(hand: number[], side: "ally" | "enemy", second: "ally" | "enemy"): GameState {
  return {
    players: { ally: { hand }, enemy: { hand } },
    mulligan: { current: side, first: second === "ally" ? "enemy" : "ally", second },
  } as unknown as GameState;
}

describe("mulligan v1", () => {
  it("First player keeps cost ≤3, returns pricier cards", () => {
    const s = mulState([cheap, mid, exp], "ally", "enemy"); // ally goes first
    expect(mulliganV1(s, "ally").sort()).toEqual([1, 2]); // mid(4) + exp(6)
  });

  it("Second player tolerates one more (keeps cost ≤4)", () => {
    const s = mulState([cheap, mid, exp], "ally", "ally"); // ally goes second
    expect(mulliganV1(s, "ally")).toEqual([2]); // only exp(6)
  });

  it("never returns the entire hand (keeps the cheapest)", () => {
    const s = mulState([exp, exp, mid], "ally", "enemy");
    const ret = mulliganV1(s, "ally");
    expect(ret.length).toBe(2); // 3 over-curve cards minus the cheapest kept
    expect(ret).not.toContain(2); // mid(4) is the cheapest here → kept
  });

  it("keeps a perfect low curve (returns nothing)", () => {
    const s = mulState([cheap, cheap, cheap], "ally", "enemy");
    expect(mulliganV1(s, "ally")).toEqual([]);
  });
});
