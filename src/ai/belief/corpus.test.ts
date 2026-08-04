// Corpus belief tables: sanity tests on the real corpus. Checks the smoothing,
// backoff, copy distribution and eps formulas (sections A-C, F below) without the
// stateful reducer (state.ts).
import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { cards } from "../../engine/testkit";
import { loadCorpus } from "../corpus/loader";
import { buildCorpusBelief, genPresenceOf, isNeutral, type CorpusBelief } from "./corpus";
import type { God } from "../../data/types";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.resolve(HERE, "../../../decks-corpus");

let belief: Map<God, CorpusBelief>;
let pool: Set<number>;

beforeAll(() => {
  pool = cards(); // registers the disk pool (getCard) + returns the id set
  const { decks } = loadCorpus(
    path.join(CORPUS, "decks.json"),
    path.join(CORPUS, "weights.json"),
    { isKnownCard: (id) => pool.has(id) },
  );
  belief = buildCorpusBelief(decks);
});

describe("buildCorpusBelief", () => {
  it("builds one CorpusBelief per non-Feca god", () => {
    // 9 deck gods minus Feca (excluded by weights.json).
    expect(belief.size).toBe(9);
    for (const g of belief.keys()) expect(g).not.toBe("Feca");
  });

  it("priorW is uniform and normalized (sums to 1)", () => {
    for (const cb of belief.values()) {
      const s = cb.priorW.reduce((a, b) => a + b, 0);
      expect(s).toBeCloseTo(1, 9);
      // uniform => every particle equal
      expect(cb.priorW[0]).toBeCloseTo(1 / cb.deckIds.length, 12);
    }
  });

  it("genPresence ∈ [floor, 1] and genCopyDist rows sum to 1", () => {
    for (const cb of belief.values()) {
      for (let i = 0; i < cb.cards.length; i++) {
        const p = cb.genPresence[i];
        expect(p).toBeGreaterThan(0);
        expect(p).toBeLessThanOrEqual(1);
        const rowSum = cb.genCopyDist[i * 4] + cb.genCopyDist[i * 4 + 1] + cb.genCopyDist[i * 4 + 2] + cb.genCopyDist[i * 4 + 3];
        expect(rowSum).toBeCloseTo(1, 9);
        // E[copies] = Σ k·p(c)·q(k) must lie in (0, 3].
        expect(cb.genExpCopies[i]).toBeGreaterThan(0);
        expect(cb.genExpCopies[i]).toBeLessThanOrEqual(3 + 1e-9);
      }
    }
  });

  it("presence is monotone in corpus frequency: the most-played card outranks a singleton", () => {
    const cb = belief.get("Iop")!;
    const N = cb.deckIds.length;
    const C = cb.cards.length;
    let topIdx = 0, topFreq = -1, rare = -1;
    for (let i = 0; i < C; i++) {
      let freq = 0;
      for (let d = 0; d < N; d++) if (cb.deckCounts[d * C + i] >= 1) freq++;
      if (freq > topFreq) { topFreq = freq; topIdx = i; }
      if (freq === 1 && rare < 0) rare = i; // a singleton (≈40% of cards are)
    }
    expect(topFreq).toBeGreaterThan(1);
    expect(rare).toBeGreaterThanOrEqual(0);
    expect(cb.genPresence[topIdx]).toBeGreaterThan(cb.genPresence[rare]);
  });

  it("eps scales up for tiny gods (Xelor 22 > Eniripsa 41), both within [0.05, 0.40]", () => {
    const xel = belief.get("Xelor")!;
    const eni = belief.get("Eniripsa")!;
    expect(xel.deckIds.length).toBeLessThan(eni.deckIds.length); // sanity on corpus sizes
    expect(xel.epsGen).toBeGreaterThan(eni.epsGen);
    for (const cb of belief.values()) {
      expect(cb.epsGen).toBeGreaterThanOrEqual(0.05);
      expect(cb.epsGen).toBeLessThanOrEqual(0.4);
    }
  });

  it("class cards never get cross-god backoff mass; off-corpus presence is a small positive floor", () => {
    const iop = belief.get("Iop")!;
    const cra = belief.get("Cra")!;
    // Find a class card that is in Cra's universe but not in Iop's.
    const classCardOfCra = cra.cards.find((c) => !iop.cardIndex.has(c) && !isNeutral(c));
    expect(classCardOfCra).toBeDefined();
    const off = genPresenceOf(iop, classCardOfCra!);
    expect(off).toBeGreaterThan(0);           // floor, never 0
    expect(off).toBeLessThan(0.02);           // class card of another god ≈ p0-level, no cross-god lift
    // A NEUTRE card off Iop's corpus (if any) backs off toward the global rate,
    // which should be >= the class-card floor.
    const neutralOff = cra.cards.find((c) => !iop.cardIndex.has(c) && isNeutral(c));
    if (neutralOff !== undefined) {
      expect(genPresenceOf(iop, neutralOff)).toBeGreaterThanOrEqual(off);
    }
  });

  it("in-corpus genPresenceOf matches the precomputed table", () => {
    const cb = belief.get("Sram")!;
    const c = cb.cards[3];
    expect(genPresenceOf(cb, c)).toBeCloseTo(cb.genPresence[cb.cardIndex.get(c)!], 12);
  });
});
