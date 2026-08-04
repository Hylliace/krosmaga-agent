// Belief: corpus statistics layer (safe in the browser: pure functions over
// already-loaded DeckEntry[], no fs). Precomputes, once per god, everything the
// in-match BeliefState reducer (state.ts) needs: the per-deck card-count matrix
// (the mixture particles), a uniform prior, and a smoothed generic (GEN) backoff
// component (presence and copy-count laws) that covers off-corpus gods and gods with
// few decks. The section letters below are (A) presence backoff, (B) copy dist,
// (C) eps scaling, (D) prior, (F) neutralStat. Class cards never back off to another
// god (godType check through card.god).
import type { God } from "../../data/types";
import type { DeckEntry } from "../corpus/loader";
import { getCard } from "../../engine/cardRegistry";

export interface BeliefHyperParams {
  betaPresence?: number;  // (A) god-level presence smoothing strength
  gammaPresence?: number; // (A) global-level presence smoothing strength
  betaCopy?: number;      // (B) god-level copy-dist smoothing
  gammaCopy?: number;     // (B) global-level copy-dist smoothing
  eps0?: number;          // (C) base GEN prior mass at Nref decks
  nRef?: number;          // (C) reference god size for eps scaling
  p0?: number;            // (A) uniform card floor; 0 = derive 1/|globalCards|
  tau?: number;           // likelihood temperature (<1); used by state.ts
  lambdaMiss?: number;    // soft miss penalty; used by state.ts
  likelihood?: "hypergeometric" | "presence";
  priorMode?: "uniform" | "metaWeight";
  costApTilt?: number;    // turn-order prior tilt; 0 = off
  pmiEta?: number;        // optional GEN co-occurrence lift; 0 = off
  pmiClamp?: number;
}

export const BELIEF_DEFAULTS: Required<BeliefHyperParams> = {
  betaPresence: 6,
  gammaPresence: 8,
  betaCopy: 4,
  gammaCopy: 4,
  eps0: 0.1,
  nRef: 30,
  p0: 0,
  // tau/lambdaMiss tuned on held-out k-fold (sweepBelief): τ≤0.4 are all tied for
  // best (Brier ~18% below the prior, ECE ~0.007, MCE ~0.015); τ=0.3 is a pick from
  // the middle of that group, and eps0=0.10 keeps GEN robust against off-meta decks.
  tau: 0.3,
  lambdaMiss: 0.02,
  likelihood: "hypergeometric",
  priorMode: "uniform",
  costApTilt: 0,
  pmiEta: 0,
  pmiClamp: 4,
};

// Global copy histogram given presence (pooled prior U(k), k=1..3), spec (B).
const COPY_PRIOR: readonly [number, number, number] = [0.5, 0.16, 0.34];

export interface CorpusBelief {
  god: God;
  cards: number[];                 // sorted union of card ids in this god's decks (universe C)
  cardIndex: Map<number, number>;  // cardId -> column index in cards/deckCounts
  deckIds: string[];               // particle ids (N_g)
  deckCounts: Uint8Array;          // N_g * C, [d*C + i] = copies of cards[i] in deck d (0..3)
  priorW: Float64Array;            // N_g, sums to 1 (uniform = 1/N_g)
  genPresence: Float64Array;       // C, p_g(c) = P(c present in a generic god-g deck)
  genCopyDist: Float64Array;       // C * 4, [i*4 + k] = p_g(c)*q_g(c,k) for k>=1; [i*4] = 1-p_g(c)
  genExpCopies: Float64Array;      // C, E[copies of c | generic deck]
  epsGen: number;                  // (C) GEN prior mass for this god
  // (F) global (all gods) presence/copy mass per card, lets state.ts compute a
  // smoothed p_g for an OFF-corpus card (not in `cards`) on demand, and is the
  // NEUTRE backoff target. presentSum = Σ_all π_d·[c present]; copy = Σ_all π_d·[count=k].
  neutralStat: Map<number, { presentSum: number; copy: [number, number, number] }>;
  p0: number;                      // resolved uniform card floor
  nGods: number;                   // W in p_hat (number of gods that contributed)
  hyper: Required<BeliefHyperParams>;
}

/** Build the per-god corpus belief tables from the TRAIN-fold decks. Returns a
 *  map keyed by the deck god (one CorpusBelief per god present in `trainDecks`). */
export function buildCorpusBelief(
  trainDecks: DeckEntry[],
  opts: BeliefHyperParams = {},
): Map<God, CorpusBelief> {
  const hyper: Required<BeliefHyperParams> = { ...BELIEF_DEFAULTS, ...opts };

  // Group decks by god.
  const byGod = new Map<God, DeckEntry[]>();
  for (const d of trainDecks) {
    if (!byGod.has(d.god)) byGod.set(d.god, []);
    byGod.get(d.god)!.push(d);
  }

  // ---- global pass (all gods) for backoff: presentSum_all(c) & copy_all(c,k). ----
  // π_d is uniform within god (1/N_g), so a deck contributes 1/N_g; a god's decks
  // sum to 1, and W = Σ_all π_d = number of gods.
  const presentSumAll = new Map<number, number>();              // Σ_all π_d·[c present]
  const copyAll = new Map<number, [number, number, number]>();  // Σ_all π_d·[count=k]
  const globalCards = new Set<number>();
  let W = 0;
  for (const [, decks] of byGod) {
    const piD = 1 / decks.length;
    W += 1; // each god's priors sum to 1
    for (const deck of decks) {
      const counts = countDeck(deck.cards);
      for (const [id, k] of counts) {
        globalCards.add(id);
        presentSumAll.set(id, (presentSumAll.get(id) ?? 0) + piD);
        const cc = copyAll.get(id) ?? [0, 0, 0];
        cc[Math.min(3, k) - 1] += piD;
        copyAll.set(id, cc);
      }
    }
  }
  const p0 = hyper.p0 > 0 ? hyper.p0 : 1 / Math.max(1, globalCards.size);

  // p_hat(c), global smoothed presence (NEUTRE backoff target), spec (A).
  const pHat = (c: number): number =>
    ((presentSumAll.get(c) ?? 0) + hyper.gammaPresence * p0) / (W + hyper.gammaPresence);
  // q_hat(c,k), global smoothed copy law given presence, spec (B).
  const qHat = (c: number, k: number): number => {
    const cc = copyAll.get(c) ?? [0, 0, 0];
    const present = presentSumAll.get(c) ?? 0;
    return (cc[k - 1] + hyper.gammaCopy * COPY_PRIOR[k - 1]) / (present + hyper.gammaCopy);
  };

  // neutralStat shared by all gods (global table; small).
  const neutralStat = new Map<number, { presentSum: number; copy: [number, number, number] }>();
  for (const c of globalCards) {
    neutralStat.set(c, { presentSum: presentSumAll.get(c) ?? 0, copy: copyAll.get(c) ?? [0, 0, 0] });
  }

  // ---- PER-GOD tables. ----
  const out = new Map<God, CorpusBelief>();
  for (const [god, decks] of byGod) {
    const N = decks.length;
    const piD = 1 / N;
    const deckCountMaps = decks.map((d) => countDeck(d.cards));

    // Universe = sorted union of this god's card ids.
    const cardSet = new Set<number>();
    for (const m of deckCountMaps) for (const id of m.keys()) cardSet.add(id);
    const cards = [...cardSet].sort((a, b) => a - b);
    const C = cards.length;
    const cardIndex = new Map<number, number>();
    cards.forEach((id, i) => cardIndex.set(id, i));

    const deckCounts = new Uint8Array(N * C);
    for (let d = 0; d < N; d++) {
      for (const [id, k] of deckCountMaps[d]) {
        deckCounts[d * C + cardIndex.get(id)!] = Math.min(3, k);
      }
    }

    const priorW = new Float64Array(N).fill(piD);
    if (hyper.priorMode === "metaWeight") {
      let s = 0;
      for (let d = 0; d < N; d++) { priorW[d] = decks[d].weight; s += decks[d].weight; }
      if (s > 0) for (let d = 0; d < N; d++) priorW[d] /= s;
    }

    const genPresence = new Float64Array(C);
    const genCopyDist = new Float64Array(C * 4);
    const genExpCopies = new Float64Array(C);

    for (let i = 0; i < C; i++) {
      const c = cards[i];
      // rawPresent_g(c) = Σ_{d in g} π_d·[c present] = (#g-decks with c)/N  (W_g = 1).
      let rawPresent = 0;
      const copyG: [number, number, number] = [0, 0, 0];
      for (let d = 0; d < N; d++) {
        const k = deckCounts[d * C + i];
        if (k >= 1) { rawPresent += piD; copyG[k - 1] += piD; }
      }
      // (A) presence backoff: NEUTRE -> global p_hat; class -> within-god toward p0.
      const neutre = isNeutral(c);
      const backoff = neutre
        ? pHat(c)
        : (rawPresent + hyper.betaPresence * p0) / (1 + hyper.betaPresence);
      const pG = (rawPresent + hyper.betaPresence * backoff) / (1 + hyper.betaPresence);
      genPresence[i] = pG;

      // (B) copy dist given present: q_g(c,k); genCopyDist = pG*q_g, [0] = 1-pG.
      genCopyDist[i * 4 + 0] = 1 - pG;
      let exp = 0;
      for (let k = 1; k <= 3; k++) {
        const qg = (copyG[k - 1] + hyper.betaCopy * qHat(c, k)) / (rawPresent + hyper.betaCopy);
        genCopyDist[i * 4 + k] = pG * qg;
        exp += k * qg * pG;
      }
      genExpCopies[i] = exp;
    }

    // (C) GEN prior mass, scaled up for tiny gods.
    const epsGen = clamp(hyper.eps0 * (hyper.nRef / N), 0.05, 0.4);

    out.set(god, {
      god,
      cards,
      cardIndex,
      deckIds: decks.map((d) => d.deckId),
      deckCounts,
      priorW,
      genPresence,
      genCopyDist,
      genExpCopies,
      epsGen,
      neutralStat,
      p0,
      nGods: W,
      hyper,
    });
  }
  return out;
}

/** Smoothed presence P(c in a generic god-g deck) for any card id, including one
 *  off the god's corpus universe (rawPresent = 0). Mirrors the in-loop formula so
 *  state.ts can score off-corpus cards consistently. */
export function genPresenceOf(corpus: CorpusBelief, cardId: number): number {
  const i = corpus.cardIndex.get(cardId);
  if (i !== undefined) return corpus.genPresence[i];
  const { hyper, p0, neutralStat } = corpus;
  const ns = neutralStat.get(cardId);
  const presentAll = ns?.presentSum ?? 0;
  // rawPresent in god g is 0 (off-corpus); replicate p_hat / backoff with that.
  const pHat = (presentAll + hyper.gammaPresence * p0) / (corpus.nGods + hyper.gammaPresence);
  const backoff = isNeutral(cardId) ? pHat : (0 + hyper.betaPresence * p0) / (1 + hyper.betaPresence);
  return (0 + hyper.betaPresence * backoff) / (1 + hyper.betaPresence);
}

// --- helpers ---

function countDeck(expanded: number[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const id of expanded) m.set(id, (m.get(id) ?? 0) + 1);
  return m;
}

/** A NEUTRE (neutral) card has god "None"; everything else is a class card whose
 *  presence must not backoff across gods. Unregistered ids are treated as NEUTRE
 *  (the conservative cross-god floor). */
export function isNeutral(cardId: number): boolean {
  const g = getCard(cardId)?.god;
  return g === undefined || g === "None";
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
