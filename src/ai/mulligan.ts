// Mulligan v1 (a documented heuristic; a learned mulligan would come with an
// AlphaZero-style setup). Rule: send back opening cards too expensive for the early
// curve, keep cheap cards that can be played on curve. The redraw shuffles the
// returned cards back into the deck, so sending back too many just risks drawing
// the same expensive cards again; that is why the threshold is modest and the hand
// is never emptied.
//
// Going second gets the 4th card and 1 banked AP, so the opener can have a slightly
// higher curve; going first wants the cheapest possible start.
import type { GameState } from "../engine/state";
import type { Side } from "../engine/board";
import { getCard } from "../engine/cardRegistry";

/** Slots of `side`'s opening hand to send back. Empty = keep everything. */
export function mulliganV1(state: GameState, side: Side): number[] {
  const hand = state.players[side].hand;
  if (hand.length === 0) return [];
  const second = state.mulligan?.second === side;
  const keepMax = second ? 4 : 3; // max cost we are happy to keep in the opener

  const costs = hand.map((id) => getCard(id)?.cost ?? 0);
  const ret: number[] = [];
  for (let i = 0; i < hand.length; i++) if (costs[i] > keepMax) ret.push(i);

  // Never return the whole hand: if every card is over-curve, keep the cheapest
  // one (a redraw could be worse, and an empty hand wastes the look).
  if (ret.length === hand.length) {
    let cheapest = 0;
    for (let i = 1; i < hand.length; i++) if (costs[i] < costs[cheapest]) cheapest = i;
    return ret.filter((i) => i !== cheapest);
  }
  return ret;
}
