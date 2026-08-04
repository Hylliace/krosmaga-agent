import { describe, it, expect } from "vitest";
import { cards } from "../engine/testkit";
import { HeuristicAgent } from "./agents/HeuristicAgent";
import { recordGame } from "./selfplay/record";
import { buildCardIndex, encodingLength } from "./encode";

const MIXED = [
  533, 533, 16, 16, 427, 427, 126, 126, 428, 72, 72, 72, 152, 985, 985, 985, 81,
  256, 256, 256, 283, 149, 149, 21, 21, 118, 118, 118, 429, 429,
];

describe("recordGame (value-net training data)", () => {
  it("produces samples with the right encoding size and a valid outcome label", () => {
    cards();
    const idx = buildCardIndex(MIXED);
    const samples = recordGame(new HeuristicAgent(), new HeuristicAgent(), {
      decks: { ally: MIXED, enemy: MIXED },
      seed: 1,
      cardIndex: idx,
      maxTurns: 120,
    });
    expect(samples.length).toBeGreaterThan(5);
    for (const s of samples) {
      expect(s.enc.length).toBe(encodingLength(idx.size));
      expect([-1, 0, 1]).toContain(s.value);
    }
    // A decided game must contain both winning and losing labels (the two movers
    // alternate, and exactly one of them won).
    const winner = samples.find((s) => s.value === 1);
    const loser = samples.find((s) => s.value === -1);
    expect(winner && loser).toBeTruthy();
  });

  it("is reproducible: same seed → identical samples", () => {
    cards();
    const idx = buildCardIndex(MIXED);
    const opts = { decks: { ally: MIXED, enemy: MIXED }, seed: 7, cardIndex: idx, maxTurns: 120 };
    const a = recordGame(new HeuristicAgent(), new HeuristicAgent(), opts);
    const b = recordGame(new HeuristicAgent(), new HeuristicAgent(), opts);
    expect(a.length).toBe(b.length);
    expect(a.map((s) => s.value)).toEqual(b.map((s) => s.value));
    expect(Array.from(a[0].enc)).toEqual(Array.from(b[0].enc));
  });
});
