// Belief-weighted determinization tests. Uses a real initial game state (two
// corpus decks) to check that the sampled world is valid and that the belief is
// built from public information only (shuffling the true opponent hand must not
// move the posterior, which is the key leak test for buildBeliefFromState).
import { describe, it, expect, beforeAll } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { God } from "../../data/types";
import type { GameState } from "../../engine/state";
import { cards } from "../../engine/testkit";
import { createInitialState } from "../../engine/rules";
import { Rng } from "../../engine/rng";
import { loadCorpus, type DeckEntry } from "../corpus/loader";
import { buildCorpusBelief, type CorpusBelief } from "./corpus";
import { queryHand } from "./state";
import { buildBeliefFromState, determinizeWithBelief, determinizeBelief } from "./determinizeBelief";
import { applyAction, legalActions } from "../actions";
import { DeterminizedMctsAgent } from "../agents/DeterminizedMctsAgent";

const sortedEq = (a: number[], b: number[]) => JSON.stringify([...a].sort((x, y) => x - y)) === JSON.stringify([...b].sort((x, y) => x - y));

let corpusMap: Map<God, CorpusBelief>;
let allyDeck: DeckEntry, enemyDeck: DeckEntry;

beforeAll(() => {
  const pool = cards();
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const CORPUS = path.resolve(HERE, "../../../decks-corpus");
  const { decks } = loadCorpus(path.join(CORPUS, "decks.json"), path.join(CORPUS, "weights.json"), { isKnownCard: (id) => pool.has(id) });
  corpusMap = buildCorpusBelief(decks);
  allyDeck = decks.find((d) => d.god === "Iop")!;
  enemyDeck = decks.find((d) => d.god === "Cra")!;
});

function freshState(): GameState {
  return createInitialState({ ally: allyDeck.cards, enemy: enemyDeck.cards }, { seed: 42, firstSide: "ally", gods: { ally: "Iop", enemy: "Cra" } });
}

describe("determinizeWithBelief", () => {
  it("samples a structurally valid world (foe sizes kept, my deck a permutation)", () => {
    const s = freshState();
    const belief = buildBeliefFromState(s, "ally", corpusMap)!;
    expect(belief).not.toBeNull();
    const w = determinizeWithBelief(s, "ally", belief, new Rng(7));
    expect(w.players.enemy.hand.length).toBe(s.players.enemy.hand.length);
    expect(w.players.enemy.deck.length).toBe(s.players.enemy.deck.length);
    expect(w.players.ally.hand).toEqual(s.players.ally.hand); // my hand untouched
    expect(sortedEq(w.players.ally.deck, s.players.ally.deck)).toBe(true); // my deck reshuffled, same multiset
  });

  it("the sampled foe cards are plausible Cra/neutral deck cards", () => {
    const s = freshState();
    const w = determinizeBelief(s, "ally", corpusMap, new Rng(9));
    const cra = corpusMap.get("Cra")!;
    for (const id of [...w.players.enemy.hand, ...w.players.enemy.deck]) {
      expect(cra.cardIndex.has(id)).toBe(true); // drawn from Cra's corpus universe
    }
  });
});

describe("buildBeliefFromState leak identity (decisive)", () => {
  it("permuting the true foe hand does not move the posterior", () => {
    const s1 = freshState();
    const b1 = buildBeliefFromState(s1, "ally", corpusMap)!;
    queryHand(b1); // force solve

    // s2 = identical public state, but the foe's hidden hand replaced with different
    // real Cra cards of the same size.
    const cra = corpusMap.get("Cra")!;
    const len = s1.players.enemy.hand.length;
    const otherHand = cra.cards.slice(0, len);
    expect(otherHand).not.toEqual(s1.players.enemy.hand);
    const s2: GameState = { ...s1, players: { ...s1.players, enemy: { ...s1.players.enemy, hand: otherHand } } };
    const b2 = buildBeliefFromState(s2, "ally", corpusMap)!;
    queryHand(b2);

    expect(Array.from(b1.postW!)).toEqual(Array.from(b2.postW!));
    expect(b1.postGen).toBe(b2.postGen);
  });
});

describe("DeterminizedMctsAgent + belief (end-to-end)", () => {
  it("plays a legal action when sampling worlds from the belief", () => {
    let s = freshState();
    while (s.mulligan) s = applyAction(s, { kind: "mulligan", returnIndices: [] }); // keep openers → turn 1
    const legal = legalActions(s);
    const agent = new DeterminizedMctsAgent({ worlds: 2, simulations: 8, belief: corpusMap });
    const a = agent.chooseAction(s, legal, new Rng(11));
    expect(legal.some((l) => JSON.stringify(l) === JSON.stringify(a))).toBe(true);
  });
});
