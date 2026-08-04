// Belief: in-match reducer, Bayesian posterior and queries. A BeliefState is a
// mutable per-match cache over a shared (immutable) CorpusBelief. It is only driven
// by public observations: projectForObserver() is the one place that reads
// ev.cardId, and it drops the id of a normal (not burned) opponent CARD_DRAWN, the
// one event that would leak the opponent's hidden hand (rules.ts logs it into the
// state.log, which sees everything). Nothing here ever reads foe.hand[]/foe.deck[].
//
// Posterior = finite mixture over the corpus decklists of the opponent's god
// (particles) plus a smoothed generic component; a soft multivariate
// hypergeometric likelihood reweights the particles by the revealed cards, and
// co-occurrence comes out naturally because a reveal floors every deck that does
// not have the card.
import type { Side } from "../../engine/board";
import type { GameEvent } from "../../engine/events";
import type { Rng } from "../../engine/rng";
import type { CorpusBelief } from "./corpus";
import { genPresenceOf } from "./corpus";

// Pooled copy prior U(k) (k=1..3), matches corpus.ts COPY_PRIOR.
const COPY_PRIOR: readonly [number, number, number] = [0.5, 0.16, 0.34];
const GEN_EXP_COPIES_FALLBACK = 1 * 0.5 + 2 * 0.16 + 3 * 0.34; // E[k] under U, for off-corpus GEN

// --- combinatorics (auto-extending log-factorial table) ---
// Seeded at 46 (a fresh 45-card deck) but grows on demand: in-game card
// generation (reward cards, tokens drawn to hand, deck-search) can push the foe's
// hidden pool U = hand+deck above 45, and a fixed table would index `undefined`
// → NaN (which then poisons the foe_belief encoding). logFact extends as needed.
const LOGFACT: number[] = (() => {
  const f = [0];
  for (let n = 1; n <= 46; n++) f[n] = f[n - 1] + Math.log(n);
  return f;
})();
function logFact(n: number): number {
  for (let i = LOGFACT.length; i <= n; i++) LOGFACT[i] = LOGFACT[i - 1] + Math.log(i);
  return LOGFACT[n];
}
function logChoose(n: number, k: number): number {
  if (k < 0 || k > n || n < 0) return -Infinity;
  return logFact(n) - logFact(k) - logFact(n - k);
}
/** C(U-m, take)/C(U, take), the hypergeometric "none of m copies land in `take`
 *  of U slots" probability. Returns 1 when m=0, 0 when m>U-take. */
function ratioNoneIn(U: number, m: number, take: number): number {
  if (m <= 0) return 1;
  if (take <= 0 || U <= 0) return 1;
  if (m > U - take) return 0;
  return Math.exp(logChoose(U - m, take) - logChoose(U, take));
}
// Small binomial C(k, j) for k,j ≤ 3 (multi-copy upweight in the likelihood).
const BINOM3: number[][] = [
  [1, 0, 0, 0],
  [1, 1, 0, 0],
  [1, 2, 1, 0],
  [1, 3, 3, 1],
];

const other = (s: Side): Side => (s === "ally" ? "enemy" : "ally");

// ---------------------------------------------------------------------------
// Public observation (the only thing the reducer consumes). projectForObserver
// is the leak gate: a non-burned foe draw becomes a size-only {drawHidden}.
// ---------------------------------------------------------------------------
export type PublicObs =
  | { kind: "drawHidden" }                         // foe drew a hidden card (cardId dropped)
  | { kind: "deckEmpty" }                          // foe deck exhausted
  | { kind: "revealFromHand"; cardId: number }     // a hand card became public (played / milled-from-hand)
  | { kind: "revealFromDeck"; cardId: number }     // a deck card became public (burned / milled-from-deck)
  | { kind: "bounceToHand"; cardId: number }       // board → hand (we saw it on board)
  | { kind: "recoverToHand"; cardId: number }      // discard → hand (always public)
  | { kind: "boardToDeck"; cardId: number };       // board → deck (re-enters hidden pool)

/** The leak gate. The only function that destructures ev.cardId. Returns a
 *  size/identity-projected observation, or null for events the belief ignores.
 *  A normal foe CARD_DRAWN yields {drawHidden} without its cardId. */
export function projectForObserver(ev: GameEvent, observer: Side): PublicObs | null {
  const foe = other(observer);
  switch (ev.type) {
    case "CARD_DRAWN":
      if (ev.side !== foe) return null;
      return ev.burned ? { kind: "revealFromDeck", cardId: ev.cardId } : { kind: "drawHidden" };
    case "CARD_PLAYED":
      return ev.side === foe ? { kind: "revealFromHand", cardId: ev.cardId } : null;
    case "CARD_MOVED": {
      if (ev.side !== foe) return null;
      const { from, to, cardId } = ev;
      if ((from === "hand" || from === "deck") && (to === "discard" || to === "banished" || to === "board"))
        return { kind: from === "hand" ? "revealFromHand" : "revealFromDeck", cardId };
      if (from === "board" && to === "hand") return { kind: "bounceToHand", cardId };
      if (from === "discard" && to === "hand") return { kind: "recoverToHand", cardId };
      if (from === "board" && to === "deck") return { kind: "boardToDeck", cardId };
      return null; // board → discard/banished etc.: already-revealed lifecycle, no-op
    }
    case "NO_MORE_CARD_TO_DRAW":
      return ev.side === foe ? { kind: "deckEmpty" } : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
export interface BeliefState {
  corpus: CorpusBelief;
  out: Map<number, number>;        // signed ledger: copies of c that left the hidden pool (not returned)
  seen: Map<number, number>;       // monotone max-ever of out(c) → consistency floor
  pinnedHand: Map<number, number>; // copies known in hand now (bounce/recover)
  R: number;                       // Σ out
  handSize: number;                // H (public)
  deckSize: number;                // D (public)
  postW: Float64Array | null;      // cached normalized particle posterior
  postGen: number;                 // cached P(GEN)
  dirty: boolean;
}

export function initBelief(corpus: CorpusBelief, foeHandSize: number, foeDeckSize: number): BeliefState {
  return {
    corpus,
    out: new Map(),
    seen: new Map(),
    pinnedHand: new Map(),
    R: 0,
    handSize: foeHandSize,
    deckSize: foeDeckSize,
    postW: null,
    postGen: 0,
    dirty: true,
  };
}

const inc = (m: Map<number, number>, k: number, by: number) => {
  const v = (m.get(k) ?? 0) + by;
  if (v === 0) m.delete(k); else m.set(k, v);
};

/** Apply one public observation. Mutates + returns b (running per-match cache).
 *  `isReal(id)` gates every out/seen bump to the foe's real deck cards. */
export function applyObs(b: BeliefState, obs: PublicObs | null, isReal: (id: number) => boolean): BeliefState {
  if (!obs) return b;
  switch (obs.kind) {
    case "drawHidden": // hidden hand card; size-only, posterior unchanged
      b.handSize++; b.deckSize = Math.max(0, b.deckSize - 1);
      return b;
    case "deckEmpty":
      b.deckSize = 0;
      return b;
    case "revealFromHand": {
      const c = obs.cardId;
      b.handSize = Math.max(0, b.handSize - 1);
      if (!isReal(c)) return b; // foreign / token / reward: occupies a slot but not a deck-pool card
      inc(b.out, c, 1); b.R++; bumpSeen(b, c);
      if ((b.pinnedHand.get(c) ?? 0) > 0) inc(b.pinnedHand, c, -1);
      b.dirty = true;
      return b;
    }
    case "revealFromDeck": {
      const c = obs.cardId;
      b.deckSize = Math.max(0, b.deckSize - 1);
      if (!isReal(c)) return b;
      inc(b.out, c, 1); b.R++; bumpSeen(b, c);
      b.dirty = true;
      return b;
    }
    case "bounceToHand":
    case "recoverToHand": {
      const c = obs.cardId;
      b.handSize++;
      if (!isReal(c)) return b;
      inc(b.out, c, -1); b.R--; // re-entered the (now known-in-hand) pool
      inc(b.pinnedHand, c, 1);
      b.dirty = true;
      return b;
    }
    case "boardToDeck": {
      const c = obs.cardId;
      b.deckSize++;
      if (!isReal(c)) return b;
      inc(b.out, c, -1); b.R--; // re-entered the hidden pool
      b.dirty = true;
      return b;
    }
  }
}

function bumpSeen(b: BeliefState, c: number): void {
  const o = b.out.get(c) ?? 0;
  if (o > (b.seen.get(c) ?? 0)) b.seen.set(c, o);
}

export function updateBelief(b: BeliefState, ev: GameEvent, observer: Side, isReal: (id: number) => boolean): BeliefState {
  return applyObs(b, projectForObserver(ev, observer), isReal);
}

/** Cross-check the ledger against the foe's public piles (append-only, keep ids):
 *  out(c) must be ≥ the number of c's sitting in discard+banished+tokenDiscard.
 *  Raises the floor if the event stream drifted low; refreshes sizes. Leak-free
 *  (reads only public zones). Idempotent. */
export function reconcileFromSnapshot(
  b: BeliefState,
  foePublic: { discard: number[]; banished: number[]; tokenDiscard: number[]; handSize: number; deckSize: number },
  isReal: (id: number) => boolean,
): BeliefState {
  const floor = new Map<number, number>();
  for (const pile of [foePublic.discard, foePublic.banished, foePublic.tokenDiscard])
    for (const id of pile) if (isReal(id)) floor.set(id, (floor.get(id) ?? 0) + 1);
  for (const [c, f] of floor) {
    const o = b.out.get(c) ?? 0;
    if (f > o) { inc(b.out, c, f - o); b.R += f - o; b.dirty = true; }
    if (f > (b.seen.get(c) ?? 0)) { b.seen.set(c, f); b.dirty = true; }
  }
  b.handSize = foePublic.handSize;
  b.deckSize = foePublic.deckSize;
  return b;
}

// --- posterior solve (lazy, on dirty) ---
function genCopyLaw(corpus: CorpusBelief, c: number, k: number): number {
  const i = corpus.cardIndex.get(c);
  if (i !== undefined) return corpus.genCopyDist[i * 4 + k];
  return genPresenceOf(corpus, c) * COPY_PRIOR[k - 1]; // off-corpus approx
}

function solve(b: BeliefState): void {
  const { corpus } = b;
  const N = corpus.deckIds.length;
  const C = corpus.cards.length;
  const { tau, lambdaMiss, likelihood } = corpus.hyper;
  const usePresence = likelihood === "presence"; // drop the multi-copy upweight, keep the deficit penalty
  const logLambda = Math.log(lambdaMiss);
  const seen = [...b.seen].filter(([, s]) => s > 0);

  const logOmega = new Float64Array(N);
  for (let d = 0; d < N; d++) {
    let logL = 0, deficit = 0;
    for (const [c, s] of seen) {
      const i = corpus.cardIndex.get(c);
      const cnt = i !== undefined ? corpus.deckCounts[d * C + i] : 0;
      const take = Math.min(s, cnt);
      if (!usePresence) logL += Math.log(BINOM3[cnt][take]); // C(cnt, take); cnt<s → take=cnt → log1=0
      deficit += Math.max(0, s - cnt);
    }
    logL += deficit * logLambda;
    logOmega[d] = Math.log(corpus.priorW[d]) + tau * logL;
  }

  // GEN component.
  let logLgen = 0;
  for (const [c, s] of seen) {
    let term = 0;
    for (let k = s; k <= 3; k++) term += genCopyLaw(corpus, c, k) * BINOM3[k][s];
    logLgen += Math.log(Math.max(term, 1e-300));
  }
  const eps = corpus.epsGen;
  const logOmegaGen = Math.log(eps / (1 - eps)) + tau * logLgen;

  // Normalize in log-space.
  let mx = logOmegaGen;
  for (let d = 0; d < N; d++) if (logOmega[d] > mx) mx = logOmega[d];
  let Z = Math.exp(logOmegaGen - mx);
  for (let d = 0; d < N; d++) Z += Math.exp(logOmega[d] - mx);
  const postW = new Float64Array(N);
  for (let d = 0; d < N; d++) postW[d] = Math.exp(logOmega[d] - mx) / Z;
  b.postW = postW;
  b.postGen = Math.exp(logOmegaGen - mx) / Z;
  b.dirty = false;
}

function ensureSolved(b: BeliefState): void {
  if (b.dirty || b.postW === null) solve(b);
}

// Query geometry shared by all marginals.
interface Geom { U: number; Hu: number; D: number; pinnedTotal: number; }
function geom(b: BeliefState): Geom {
  let pinnedTotal = 0;
  for (const v of b.pinnedHand.values()) pinnedTotal += v;
  const Hu = Math.max(0, b.handSize - pinnedTotal);
  const D = b.deckSize;
  return { U: Hu + D, Hu, D, pinnedTotal };
}

// Per-card marginal over the mixture. zone: 'hand' | 'deck' | 'pool' | 'expHand'.
function marginal(b: BeliefState, zone: "hand" | "deck" | "pool" | "expHand"): Float64Array {
  ensureSolved(b);
  const { corpus, postW, postGen } = b;
  const N = corpus.deckIds.length;
  const C = corpus.cards.length;
  const g = geom(b);
  const out = new Float64Array(C);
  for (let i = 0; i < C; i++) {
    const c = corpus.cards[i];
    const outC = b.out.get(c) ?? 0;
    const pinned = b.pinnedHand.get(c) ?? 0;
    // particle mass
    let acc = 0;
    for (let d = 0; d < N; d++) {
      const rem = Math.max(0, corpus.deckCounts[d * C + i] - outC);
      const m = Math.max(0, rem - pinned);
      acc += postW![d] * particleTerm(zone, m, pinned, g);
    }
    // GEN mass. The GEN component is an independent-copies approximation, so clamp
    // P(in hand)/P(in deck) ≤ P(in pool) to keep the probability axiom (the pool
    // branch is the unconditional presence; hand/deck are sub-events of it).
    const remGen = Math.max(0, corpus.genExpCopies[i] - outC);
    let gt = genTerm(zone, remGen, pinned, corpus.genPresence[i], g);
    if (zone === "hand" || zone === "deck")
      gt = Math.min(gt, genTerm("pool", remGen, pinned, corpus.genPresence[i], g));
    acc += postGen * gt;
    out[i] = acc;
  }
  return out;
}

function particleTerm(zone: string, m: number, pinned: number, g: Geom): number {
  switch (zone) {
    case "hand": return pinned >= 1 ? 1 : (m <= 0 ? 0 : 1 - ratioNoneIn(g.U, m, g.Hu));
    case "deck": return m <= 0 ? 0 : 1 - ratioNoneIn(g.U, m, g.D);
    case "pool": return pinned >= 1 || m >= 1 ? 1 : 0;
    case "expHand": return pinned + (g.U > 0 ? m * (g.Hu / g.U) : 0);
    default: return 0;
  }
}
function genTerm(zone: string, remGen: number, pinned: number, pPresent: number, g: Geom): number {
  const frac = g.U > 0 ? g.Hu / g.U : 0;
  switch (zone) {
    case "hand": return pinned >= 1 ? 1 : (remGen <= 0 ? 0 : 1 - Math.pow(1 - frac, remGen));
    case "deck": return remGen <= 0 ? 0 : 1 - Math.pow(1 - (g.U > 0 ? g.D / g.U : 0), remGen);
    case "pool": return pinned >= 1 ? 1 : (remGen > 0 ? pPresent : 0);
    case "expHand": return pinned + remGen * frac;
    default: return 0;
  }
}

export function queryHand(b: BeliefState): Float64Array { return marginal(b, "hand"); }
export function queryDeck(b: BeliefState): Float64Array { return marginal(b, "deck"); }
export function queryPool(b: BeliefState): Float64Array { return marginal(b, "pool"); }
export function queryExpectedHandCopies(b: BeliefState): Float64Array { return marginal(b, "expHand"); }

/** P(card hidden in hand / deck / pool) for any card id (off-universe → 0/ GEN). */
export function pCardHidden(b: BeliefState, cardId: number): { hand: number; deck: number; pool: number } {
  const i = b.corpus.cardIndex.get(cardId);
  if (i === undefined) {
    // off-corpus: GEN-only via on-the-fly presence
    ensureSolved(b);
    const g = geom(b);
    const outC = b.out.get(cardId) ?? 0;
    const pinned = b.pinnedHand.get(cardId) ?? 0;
    const pPresent = genPresenceOf(b.corpus, cardId);
    const remGen = Math.max(0, pPresent * GEN_EXP_COPIES_FALLBACK - outC);
    return {
      hand: b.postGen * genTerm("hand", remGen, pinned, pPresent, g),
      deck: b.postGen * genTerm("deck", remGen, pinned, pPresent, g),
      pool: b.postGen * genTerm("pool", remGen, pinned, pPresent, g),
    };
  }
  return { hand: queryHand(b)[i], deck: queryDeck(b)[i], pool: queryPool(b)[i] };
}

export function asMap(corpus: CorpusBelief, v: Float64Array): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 0; i < corpus.cards.length; i++) m.set(corpus.cards[i], v[i]);
  return m;
}

function weightedPick(weights: Float64Array, rng: Rng): number {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) sum += weights[i];
  if (sum <= 0) return rng.int(weights.length);
  let t = rng.next() * sum;
  for (let i = 0; i < weights.length; i++) { t -= weights[i]; if (t < 0) return i; }
  return weights.length - 1;
}

/** For PIMC determinization: sample one plausible hidden opponent hand and deck
 *  consistent with the public observations: a particle drawn from the posterior
 *  (or the GEN component), laid out respecting out/seen/pinned, then split into a
 *  hand of size H (pinned cards forced in) and a deck of size D. Public information
 *  only: it reads the belief, never the true opponent cards. */
export function sampleDeck(b: BeliefState, rng: Rng): { hand: number[]; deck: number[] } {
  ensureSolved(b);
  const { corpus } = b;
  const N = corpus.deckIds.length;
  const C = corpus.cards.length;
  const H = b.handSize, D = b.deckSize;

  // Pinned (known-in-hand) cards are forced into the hand.
  const hand: number[] = [];
  for (const [c, k] of b.pinnedHand) for (let i = 0; i < k; i++) hand.push(c);
  const needUnknown = Math.max(0, H + D - hand.length);

  // Hidden NON-pinned copies of a card are capped at 3 − out(c) − pinned(c): a card
  // whose copies have all left (out=3) can never reappear (the seen=3 ⇒ gone rule).
  const copies = new Map<number, number>();
  const cap = (c: number) => Math.max(0, 3 - (b.out.get(c) ?? 0) - (b.pinnedHand.get(c) ?? 0));
  const tryAdd = (c: number): boolean => {
    const cur = copies.get(c) ?? 0;
    if (cur >= cap(c)) return false;
    copies.set(c, cur + 1);
    return true;
  };

  // Component: GEN if u < postGen, else a particle d ~ postW. A particle seeds its
  // exact remaining multiset; GEN seeds the observed floors. Both then top up to
  // needUnknown by sampling cards weighted by expected copies, respecting caps.
  const u = rng.next();
  if (u >= b.postGen) {
    let acc = b.postGen, d = N - 1;
    for (let i = 0; i < N; i++) { acc += b.postW![i]; if (u < acc) { d = i; break; } }
    for (let i = 0; i < C; i++) {
      const c = corpus.cards[i];
      const rem = Math.max(0, corpus.deckCounts[d * C + i] - (b.out.get(c) ?? 0));
      const pinned = b.pinnedHand.get(c) ?? 0;
      for (let k = 0; k < rem - pinned; k++) tryAdd(c);
    }
  } else {
    for (const [c, s] of b.seen) {
      const floor = Math.max(0, (s - (b.out.get(c) ?? 0)) - (b.pinnedHand.get(c) ?? 0));
      for (let k = 0; k < floor; k++) tryAdd(c);
    }
  }
  let placed = 0;
  for (const v of copies.values()) placed += v;
  let guard = 0;
  while (placed < needUnknown && guard++ < 200000) {
    if (tryAdd(corpus.cards[weightedPick(corpus.genExpCopies, rng)])) placed++;
  }

  const unknown: number[] = [];
  for (const [c, k] of copies) for (let j = 0; j < k; j++) unknown.push(c);
  rng.shuffle(unknown);
  if (unknown.length > needUnknown) unknown.length = needUnknown; // a soft-floor particle may overshoot

  // Partition: fill the hand to H (pinned already in), the rest is the deck.
  const handNeed = Math.max(0, H - hand.length);
  for (let i = 0; i < handNeed && i < unknown.length; i++) hand.push(unknown[i]);
  return { hand, deck: unknown.slice(handNeed) };
}
