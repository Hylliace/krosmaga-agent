// Belief: reducer, posterior and query tests. Small synthetic corpora for the
// probability mechanics; the real corpus for the realDeckCard coverage and the
// leak checks on real events. The leak-identity test is the important one:
// shuffling the opponent's hidden cards must not change any output.
import { describe, it, expect, beforeAll } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { God } from "../../data/types";
import type { GameEvent } from "../../engine/events";
import type { DeckEntry } from "../corpus/loader";
import { buildCorpusBelief, type CorpusBelief } from "./corpus";
import {
  initBelief, applyObs, updateBelief, projectForObserver, reconcileFromSnapshot,
  queryHand, queryDeck, queryPool, sampleDeck, type BeliefState,
} from "./state";
import { realDeckCard } from "./realDeckCard";
import { Rng } from "../../engine/rng";

const TRUE = () => true;

// Build a one-god synthetic corpus from {deckId: {cardId: copies}}.
function mkCorpus(god: God, decks: Record<string, Record<number, number>>): CorpusBelief {
  const entries: DeckEntry[] = Object.entries(decks).map(([deckId, counts]) => {
    const cards: number[] = [];
    for (const [id, n] of Object.entries(counts)) for (let i = 0; i < n; i++) cards.push(Number(id));
    return { deckId, name: deckId, god, author: "t", tags: [], costAP: 0, cards, weight: 1 };
  });
  return buildCorpusBelief(entries).get(god)!;
}
const idx = (cb: CorpusBelief, c: number) => cb.cardIndex.get(c)!;

describe("projectForObserver (leak gate)", () => {
  const draw = (side: "ally" | "enemy", burned?: boolean): GameEvent => ({ type: "CARD_DRAWN", side, cardId: 123, burned });
  it("drops the cardId of a normal foe draw", () => {
    const obs = projectForObserver(draw("enemy", false), "ally");
    expect(obs).toEqual({ kind: "drawHidden" });
    expect(JSON.stringify(obs)).not.toContain("123");
  });
  it("keeps a burned foe draw (milled to public)", () => {
    expect(projectForObserver(draw("enemy", true), "ally")).toEqual({ kind: "revealFromDeck", cardId: 123 });
  });
  it("ignores my-own-side draws and unrelated events", () => {
    expect(projectForObserver(draw("ally", false), "ally")).toBeNull();
    expect(projectForObserver({ type: "FIGHT_OBJECT_TRANSFORMED", instanceId: 1, intoCardId: 9 }, "ally")).toBeNull();
  });
  it("routes CARD_PLAYED / bounce / recover by side and direction", () => {
    expect(projectForObserver({ type: "CARD_PLAYED", side: "enemy", cardId: 7 }, "ally")).toEqual({ kind: "revealFromHand", cardId: 7 });
    expect(projectForObserver({ type: "CARD_MOVED", side: "enemy", from: "board", to: "hand", cardId: 7 }, "ally")).toEqual({ kind: "bounceToHand", cardId: 7 });
    expect(projectForObserver({ type: "CARD_MOVED", side: "enemy", from: "discard", to: "hand", cardId: 7 }, "ally")).toEqual({ kind: "recoverToHand", cardId: 7 });
    expect(projectForObserver({ type: "CARD_MOVED", side: "enemy", from: "board", to: "discard", cardId: 7 }, "ally")).toBeNull();
  });
});

describe("posterior mechanics", () => {
  it("multi-copy: revealing one copy upweights the 3-of deck over the 1-of deck", () => {
    const cb = mkCorpus("Iop", { A: { 5001: 3, 9001: 1 }, B: { 5001: 1, 9002: 1 } });
    const b = initBelief(cb, 5, 20);
    applyObs(b, { kind: "revealFromHand", cardId: 5001 }, TRUE);
    queryHand(b); // force solve
    expect(b.postW![0]).toBeGreaterThan(b.postW![1]); // A (3-of) > B (1-of)
  });

  it("co-occurrence: revealing a signature card lifts its corpus partner's pool prob above the prior", () => {
    const cb = mkCorpus("Iop", { A: { 1001: 1, 1002: 1, 1003: 1 }, B: { 2001: 1, 2002: 1, 2003: 1 } });
    const b = initBelief(cb, 5, 20);
    const partner = idx(cb, 1002), foreign = idx(cb, 2002);
    const priorPartner = queryPool(b)[partner];
    const priorForeign = queryPool(b)[foreign];
    applyObs(b, { kind: "revealFromHand", cardId: 1001 }, TRUE); // 1001 only in A
    const postPartner = queryPool(b)[partner];
    const postForeign = queryPool(b)[foreign];
    expect(postPartner).toBeGreaterThan(priorPartner); // archetype partner rises
    expect(postForeign).toBeLessThan(priorForeign);    // incompatible card drops
  });

  it("seen all copies (×3) ⇒ hand=deck=pool=0 for that card", () => {
    const cb = mkCorpus("Iop", { A: { 7001: 3, 9001: 1 }, B: { 8001: 1, 9002: 1 } });
    const b = initBelief(cb, 10, 30);
    for (let i = 0; i < 3; i++) applyObs(b, { kind: "revealFromHand", cardId: 7001 }, TRUE);
    const i = idx(cb, 7001);
    expect(queryHand(b)[i]).toBeCloseTo(0, 9);
    expect(queryDeck(b)[i]).toBeCloseTo(0, 9);
    expect(queryPool(b)[i]).toBeCloseTo(0, 9);
  });

  it("bounce round-trip: play then bounce ⇒ card pinned in hand (P=1), seen floor kept", () => {
    const cb = mkCorpus("Iop", { A: { 3001: 1, 9001: 1 }, B: { 3001: 1, 9002: 1 } });
    const b = initBelief(cb, 5, 20);
    applyObs(b, { kind: "revealFromHand", cardId: 3001 }, TRUE); // out=1, seen=1
    applyObs(b, { kind: "bounceToHand", cardId: 3001 }, TRUE);   // out=0, pinned=1, seen stays 1
    expect(b.seen.get(3001)).toBe(1);
    expect(b.out.get(3001) ?? 0).toBe(0);
    expect(b.pinnedHand.get(3001)).toBe(1);
    expect(queryHand(b)[idx(cb, 3001)]).toBeCloseTo(1, 9);
  });

  it("deckEmpty ⇒ a still-hidden card is in hand not deck", () => {
    const cb = mkCorpus("Iop", { A: { 4001: 1, 9001: 1 }, B: { 4001: 1, 9002: 1 } });
    const b = initBelief(cb, 3, 5);
    applyObs(b, { kind: "deckEmpty" }, TRUE);
    expect(b.deckSize).toBe(0);
    const i = idx(cb, 4001);
    expect(queryDeck(b)[i]).toBeCloseTo(0, 9);
    expect(queryHand(b)[i]).toBeGreaterThan(0);
  });

  it("gating: a NON-real card (token/reward/foreign) leaves out/seen untouched", () => {
    const cb = mkCorpus("Iop", { A: { 6001: 1, 9001: 1 }, B: { 6001: 1, 9002: 1 } });
    const b = initBelief(cb, 5, 20);
    applyObs(b, { kind: "revealFromHand", cardId: 424242 }, () => false); // not a real foe-deck card
    expect(b.out.size).toBe(0);
    expect(b.seen.size).toBe(0);
    expect(b.handSize).toBe(4); // slot still left the hand
  });

  it("consistency invariant: Σ max(0,count_d−out) == H+D for the true particle", () => {
    const cb = mkCorpus("Iop", { A: { 1: 2, 2: 1, 3: 1 } }); // T = 4 cards
    const b = initBelief(cb, 4, 0); // all in hand, none drawn yet (H+D = 4 = T)
    applyObs(b, { kind: "revealFromHand", cardId: 1 }, TRUE);
    applyObs(b, { kind: "revealFromHand", cardId: 2 }, TRUE);
    const C = cb.cards.length;
    let s = 0;
    for (let i = 0; i < C; i++) s += Math.max(0, cb.deckCounts[0 * C + i] - (b.out.get(cb.cards[i]) ?? 0));
    expect(s).toBe(b.handSize + b.deckSize);
  });

  it("posterior cache: a query clears dirty; a reveal sets it", () => {
    const cb = mkCorpus("Iop", { A: { 1: 1, 2: 1 }, B: { 1: 1, 3: 1 } });
    const b = initBelief(cb, 5, 20);
    expect(b.dirty).toBe(true);
    queryHand(b);
    expect(b.dirty).toBe(false);
    applyObs(b, { kind: "revealFromHand", cardId: 1 }, TRUE);
    expect(b.dirty).toBe(true);
  });
});

describe("sampleDeck (determinization consumer)", () => {
  it("returns exactly H hand + D deck cards, with pinned cards forced into the hand", () => {
    const cb = mkCorpus("Iop", { A: { 3001: 1, 1: 1, 2: 1, 3: 1 }, B: { 3001: 1, 4: 1, 5: 1, 6: 1 } });
    const b = initBelief(cb, 2, 2); // tiny synthetic deck → keep H+D within the card-pool capacity
    applyObs(b, { kind: "revealFromHand", cardId: 3001 }, TRUE);
    applyObs(b, { kind: "bounceToHand", cardId: 3001 }, TRUE); // pinned in hand
    const rng = new Rng(1);
    for (let t = 0; t < 30; t++) {
      const { hand, deck } = sampleDeck(b, rng);
      expect(hand.length).toBe(b.handSize);
      expect(deck.length).toBe(b.deckSize);
      expect(hand).toContain(3001); // pinned
    }
  });

  it("never samples a card whose copies are all already seen", () => {
    const cb = mkCorpus("Iop", { A: { 7001: 3, 9001: 1 }, B: { 8001: 1, 9002: 1 } });
    const b = initBelief(cb, 4, 0);
    for (let i = 0; i < 3; i++) applyObs(b, { kind: "revealFromHand", cardId: 7001 }, TRUE);
    const rng = new Rng(2);
    for (let t = 0; t < 50; t++) {
      const { hand, deck } = sampleDeck(b, rng);
      expect([...hand, ...deck]).not.toContain(7001);
    }
  });

  it("samples a high-posterior card more often than a low-posterior one", () => {
    const cb = mkCorpus("Iop", { A: { 1001: 1, 1002: 1, 1003: 1 }, B: { 2001: 1, 2002: 1, 2003: 1 } });
    const b = initBelief(cb, 3, 0);
    applyObs(b, { kind: "revealFromHand", cardId: 1001 }, TRUE); // makes A dominant
    const rng = new Rng(3);
    let partner = 0, foreign = 0;
    for (let t = 0; t < 200; t++) {
      const all = [...sampleDeck(b, rng).hand, ...sampleDeck(b, rng).deck];
      if (all.includes(1002)) partner++; // A's card
      if (all.includes(2002)) foreign++; // B's card
    }
    expect(partner).toBeGreaterThan(foreign);
  });
});

describe("Leak identity (decisive)", () => {
  it("permuting the foe's hidden cards never moves postW/postGen/queryHand", () => {
    const cb = mkCorpus("Iop", { A: { 1001: 2, 1002: 1, 1003: 1 }, B: { 2001: 1, 2002: 1, 1002: 1 } });
    // The same public event stream (what both players see), regardless of the
    // foe's actual hidden hand/deck. The belief must depend on this alone.
    const stream: GameEvent[] = [
      { type: "CARD_DRAWN", side: "enemy", cardId: 99999, burned: false }, // hidden, id must be ignored
      { type: "CARD_PLAYED", side: "enemy", cardId: 1002 },
      { type: "CARD_DRAWN", side: "ally", cardId: 1, burned: false },       // my draw, ignored
      { type: "CARD_MOVED", side: "enemy", from: "deck", to: "discard", cardId: 1001 },
      { type: "CARD_PLAYED", side: "enemy", cardId: 1001 },
    ];
    const run = () => {
      const b = initBelief(cb, 4, 41);
      for (const ev of stream) updateBelief(b, ev, "ally", TRUE);
      queryHand(b);
      return b;
    };
    const a = run(), c = run();
    expect(Array.from(a.postW!)).toEqual(Array.from(c.postW!));
    expect(a.postGen).toBe(c.postGen);
    expect(Array.from(queryHand(a))).toEqual(Array.from(queryHand(c)));
  });

  it("static guard: state.ts never indexes foe.hand[]/foe.deck[] element values", async () => {
    const fs = await import("node:fs");
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const raw = fs.readFileSync(path.join(HERE, "state.ts"), "utf-8");
    // Strip comments first, the leak guard is about code, not prose.
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/\.hand\s*\[/);
    expect(src).not.toMatch(/\.deck\s*\[/);
    // ev.cardId is only reachable in projectForObserver (the sole fn taking a
    // GameEvent); the reducer/queries take a projected PublicObs, never ev.
    expect(src).not.toMatch(/foeP?\.(hand|deck)\b/);
  });
});

describe("realDeckCard + reconcile (real corpus)", () => {
  let belief: Map<God, CorpusBelief>;
  beforeAll(async () => {
    const { cards } = await import("../../engine/testkit");
    const { loadCorpus } = await import("../corpus/loader");
    const pool = cards();
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const CORPUS = path.resolve(HERE, "../../../decks-corpus");
    const { decks } = loadCorpus(
      path.join(CORPUS, "decks.json"), path.join(CORPUS, "weights.json"),
      { isKnownCard: (id) => pool.has(id) },
    );
    belief = buildCorpusBelief(decks);
  });

  it("every corpus card is realDeckCard==true for its own god (gate never drops a real card)", () => {
    for (const [god, cb] of belief) {
      for (const c of cb.cards) expect(realDeckCard(c, god)).toBe(true);
    }
  });

  it("reconcileFromSnapshot raises the ledger floor from the public discard pile", () => {
    const cb = belief.get("Iop")!;
    const c = cb.cards[0];
    const b = initBelief(cb, 4, 41);
    reconcileFromSnapshot(b, { discard: [c, c], banished: [], tokenDiscard: [], handSize: 4, deckSize: 39 }, (id) => realDeckCard(id, "Iop"));
    expect(b.out.get(c)).toBe(2);
    expect(b.seen.get(c)).toBe(2);
    expect(b.deckSize).toBe(39);
  });
});
