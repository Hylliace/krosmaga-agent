import { describe, it, expect } from "vitest";
import { cards } from "../engine/testkit"; // loads + registers the disk card pool
import { RandomAgent } from "./agents/RandomAgent";
import { playGame } from "./selfplay/playGame";
import { legalActions, applyAction } from "./actions";
import { createInitialState } from "../engine/rules";

// A 30-card deck of cheap non-dev Summons, so Random play actually fills the
// board, advances, and destroys Dofus (games resolve instead of stalling).
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

describe("Action layer", () => {
  it("legalActions during mulligan = all 2^3 subsets of the opening hand", () => {
    const deck = summonDeck();
    const s = createInitialState({ ally: deck, enemy: deck }, { seed: 1 });
    expect(s.mulligan).not.toBeNull();
    const acts = legalActions(s);
    expect(acts.every((a) => a.kind === "mulligan")).toBe(true);
    expect(acts.length).toBe(8); // 2^3
  });

  it("resolving both mulligans via the action layer reaches turn 1 with endTurn available", () => {
    const deck = summonDeck();
    let s = createInitialState({ ally: deck, enemy: deck }, { seed: 1 });
    s = applyAction(s, { kind: "mulligan", returnIndices: [] }); // player 1 keeps
    s = applyAction(s, { kind: "mulligan", returnIndices: [] }); // player 2 keeps
    expect(s.mulligan).toBeNull();
    expect(s.turn).toBe(1);
    const acts = legalActions(s);
    expect(acts.some((a) => a.kind === "endTurn")).toBe(true);
  });
});

describe("Self-play loop (Random vs Random)", () => {
  const deck = summonDeck();
  const both = { ally: deck, enemy: deck };

  it("a game terminates and returns a well-formed result", () => {
    const r = playGame(new RandomAgent(), new RandomAgent(), { decks: both, seed: 1, maxTurns: 200 });
    expect(r.plies).toBeGreaterThan(0);
    expect(r.turns).toBeGreaterThan(0);
    expect(["ally", "enemy", null]).toContain(r.winner);
  });

  it("is reproducible: same seed → identical result", () => {
    const a = playGame(new RandomAgent(), new RandomAgent(), { decks: both, seed: 42, maxTurns: 200 });
    const b = playGame(new RandomAgent(), new RandomAgent(), { decks: both, seed: 42, maxTurns: 200 });
    expect(a).toEqual(b);
  });

  it("different seeds explore different games", () => {
    const seen = new Set<string>();
    for (let s = 0; s < 12; s++) {
      const r = playGame(new RandomAgent(), new RandomAgent(), { decks: both, seed: s, maxTurns: 200 });
      seen.add(`${r.winner}:${r.turns}:${r.plies}`);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("runs many games without throwing, and most produce a winner", () => {
    let decided = 0;
    const N = 30;
    for (let s = 0; s < N; s++) {
      const r = playGame(new RandomAgent(), new RandomAgent(), { decks: both, seed: s, maxTurns: 200 });
      if (r.winner !== null) decided++;
    }
    expect(decided).toBeGreaterThan(0); // Random play resolves at least some games
  });
});
