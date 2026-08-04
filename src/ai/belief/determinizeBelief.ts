// Belief-weighted determinization. Replaces the "re-partition the opponent's true
// unseen cards" of determinize.ts (which gives too much information for an unknown
// matchup and effectively looks at hidden cards) with a world sampled from the
// belief: a plausible opponent hand and deck drawn from the corpus posterior,
// consistent with the public observations. Nothing leaks: the belief is only built
// from public zones (discard / banished / tokenDiscard / opponent creatures on the
// board), never from the true opponent hand.
import type { GameState } from "../../engine/state";
import type { Side } from "../../engine/board";
import type { God } from "../../data/types";
import type { Rng } from "../../engine/rng";
import { determinize, resampleEnemyReals } from "../determinize";
import type { CorpusBelief } from "./corpus";
import { initBelief, sampleDeck, type BeliefState } from "./state";
import { realDeckCard } from "./realDeckCard";

const other = (s: Side): Side => (s === "ally" ? "enemy" : "ally");

/** Build a foe BeliefState from the public state alone: the foe's god + hand/deck
 *  sizes, and the multiset of real deck cards that have left the hidden pool
 *  (discard + banished + tokenDiscard + living foe board creatures, whose cardIds
 *  are public). Order-independent, so this snapshot reconstruction yields the same
 *  posterior as the incremental reducer (pins from bounce/recover are the only
 *  thing not recoverable from a snapshot, a rare, deferred refinement). Returns
 *  null when the foe god has no corpus (caller falls back to the plain shuffle). */
export function buildBeliefFromState(state: GameState, me: Side, corpusMap: Map<God, CorpusBelief>): BeliefState | null {
  const foe = other(me);
  const foeP = state.players[foe];
  const foeGod = foeP.god;
  if (!foeGod || foeGod === "None") return null;
  const corpus = corpusMap.get(foeGod);
  if (!corpus) return null;

  const b = initBelief(corpus, foeP.hand.length, foeP.deck.length);
  const isReal = (id: number) => realDeckCard(id, foeGod);
  const floor = new Map<number, number>();
  const bump = (id: number) => { if (isReal(id)) floor.set(id, (floor.get(id) ?? 0) + 1); };
  for (const id of foeP.discard) bump(id);
  for (const id of foeP.banished ?? []) bump(id);
  for (const id of foeP.tokenDiscard ?? []) bump(id);
  for (const c of state.creatures) if (c.owner === foe && c.currentLife > 0) bump(c.cardId); // played → left hand
  for (const [c, k] of floor) { b.out.set(c, k); b.seen.set(c, k); b.R += k; }
  b.dirty = true;
  return b;
}

/** Sample one world from a foe belief: keep `me`'s known info, reshuffle my deck,
 *  draw the foe's hand+deck from the belief, resample which enemy Dofus are real. */
export function determinizeWithBelief(state: GameState, me: Side, belief: BeliefState, rng: Rng): GameState {
  const foe = other(me);
  const myP = state.players[me];
  const foeP = state.players[foe];
  const myDeck = rng.shuffle([...myP.deck]);
  const { hand: foeHand, deck: foeDeck } = sampleDeck(belief, rng);
  return {
    ...state,
    rng: (rng.int(0x7fffffff) | 0) >>> 0,
    dofuses: resampleEnemyReals(state.dofuses, foe, rng, state.destroyedDofuses),
    players: {
      ...state.players,
      [me]: { ...myP, deck: myDeck },
      [foe]: { ...foeP, hand: foeHand, handCostMods: foeHand.map(() => 0), deck: foeDeck },
    },
  };
}

/** Convenience: build the belief from public state + sample a world. Falls back to
 *  the plain (composition-preserving) determinize when the foe god has no corpus. */
export function determinizeBelief(state: GameState, me: Side, corpusMap: Map<God, CorpusBelief>, rng: Rng): GameState {
  const belief = buildBeliefFromState(state, me, corpusMap);
  return belief ? determinizeWithBelief(state, me, belief, rng) : determinize(state, me, rng);
}
