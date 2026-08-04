// Held-out splits. One shared file (decks-corpus/splits.json) used by both the
// self-play sampler and the arena, so train and held-out never drift apart.
//
// Two safeguards:
//  - Dedup before splitting: near-duplicate decks (same god and a large card
//    overlap, e.g. variants by the same author) are clustered and put in the same
//    fold, so a deck and its twin cannot end up on both sides.
//  - Stratified k-fold by god: each god's clusters are spread round-robin over the
//    k folds, so every fold has ~1/k of each god (small gods like Xelor/Sadida too).
// k=5 gives 80/20 folds; rotating the folds lets the small gods still give a signal.
import type { DeckEntry } from "./loader";

export interface Splits {
  k: number;
  seed: number;
  dupThreshold: number;
  folds: Record<string, number>; // deckId -> fold index (0..k-1)
}

/** Jaccard over card multisets (copy counts matter). */
export function multisetJaccard(a: number[], b: number[]): number {
  const ca = new Map<number, number>();
  const cb = new Map<number, number>();
  for (const x of a) ca.set(x, (ca.get(x) ?? 0) + 1);
  for (const x of b) cb.set(x, (cb.get(x) ?? 0) + 1);
  let inter = 0;
  let uni = 0;
  for (const key of new Set([...ca.keys(), ...cb.keys()])) {
    const x = ca.get(key) ?? 0;
    const y = cb.get(key) ?? 0;
    inter += Math.min(x, y);
    uni += Math.max(x, y);
  }
  return uni === 0 ? 0 : inter / uni;
}

/** Cluster id per deck: near-duplicates (same god, Jaccard >= threshold) merge. */
export function dedupClusters(decks: DeckEntry[], threshold = 0.85): number[] {
  const parent = decks.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < decks.length; i++) {
    for (let j = i + 1; j < decks.length; j++) {
      if (decks[i].god === decks[j].god && multisetJaccard(decks[i].cards, decks[j].cards) >= threshold) {
        parent[find(i)] = find(j);
      }
    }
  }
  return decks.map((_, i) => find(i));
}

/** Stratified k-fold over dedup clusters. Deterministic given (k, seed). */
export function buildSplits(decks: DeckEntry[], k = 5, seed = 7, dupThreshold = 0.85): Splits {
  const cluster = dedupClusters(decks, dupThreshold);
  const clusters = new Map<number, DeckEntry[]>();
  decks.forEach((d, i) => {
    const c = cluster[i];
    if (!clusters.has(c)) clusters.set(c, []);
    clusters.get(c)!.push(d);
  });
  // cluster ids grouped by god
  const byGod = new Map<string, number[]>();
  for (const [cid, members] of clusters) {
    const g = members[0].god;
    if (!byGod.has(g)) byGod.set(g, []);
    byGod.get(g)!.push(cid);
  }
  const folds: Record<string, number> = {};
  for (const [, cids] of byGod) {
    const sorted = [...cids].sort((a, b) => a - b);
    const by = sorted.length ? seed % sorted.length : 0; // deterministic rotation
    sorted.forEach((_, i) => {
      const cid = sorted[(i + by) % sorted.length];
      const f = i % k;
      for (const d of clusters.get(cid)!) folds[d.deckId] = f;
    });
  }
  return { k, seed, dupThreshold, folds };
}

export function trainDecks(decks: DeckEntry[], splits: Splits, heldOutFold: number): DeckEntry[] {
  return decks.filter((d) => splits.folds[d.deckId] !== heldOutFold);
}
export function heldOutDecks(decks: DeckEntry[], splits: Splits, heldOutFold: number): DeckEntry[] {
  return decks.filter((d) => splits.folds[d.deckId] === heldOutFold);
}
