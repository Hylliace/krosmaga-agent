import { describe, it, expect } from "vitest";
import { cards } from "../engine/testkit"; // loads + registers the disk card pool
import { RandomAgent } from "./agents/RandomAgent";
import { runArena, formatArena } from "./arena/arena";

function summonDeck(): number[] {
  const pool = [...cards().values()]
    .filter((c) => c.cardType === "Summon" && !c.isDevCard && (c.cost ?? 0) <= 4)
    .sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0) || a.id - b.id)
    .slice(0, 15)
    .map((c) => c.id);
  const deck: number[] = [];
  while (deck.length < 30) deck.push(pool[deck.length % pool.length]);
  return deck;
}

describe("Arena (AI-vs-AI benchmark)", () => {
  const deck = summonDeck();

  it("Random vs Random over 100 mirror games is ~even and reproducible", () => {
    const opts = { games: 100, decks: { ally: deck, enemy: deck }, baseSeed: 1, maxTurns: 200 };
    const r1 = runArena(new RandomAgent(), new RandomAgent(), opts);
    const r2 = runArena(new RandomAgent(), new RandomAgent(), opts);
    // Surface the result so `npm test` shows the self-play loop actually running.
    // eslint-disable-next-line no-console
    console.log(formatArena("Random vs Random (100 mirror games)", r1));

    expect(r1).toEqual(r2); // deterministic batch
    expect(r1.winsA + r1.winsB + r1.draws).toBe(100);
    // Two identical random agents with side-swapping should be close to even.
    expect(r1.scoreA).toBeGreaterThan(0.3);
    expect(r1.scoreA).toBeLessThan(0.7);
  });
});
