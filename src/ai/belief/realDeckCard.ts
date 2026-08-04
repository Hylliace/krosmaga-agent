// Belief check: "could this card id be one of the opponent's original 45 deck
// cards?". A card that was not in the opponent's deck at the start comes either from
// a token (a creature the deck produced, never put in a deck) or from my deck
// (stolen: Zaldior, recover from my discard, mill my deck...). Either way it must not
// constrain the posterior over the opponent's corpus deck. So a real opponent deck
// card must be:
//   - registered (known to the engine),
//   - not a token (isToken: summoned creatures, board objects, the Fléau...),
//   - not a generated reward card (Butin loot etc., created during the game),
//   - of the opponent's own class or neutral (a card of another class came from my deck).
// The class check does most of the work; GENERATED_REWARD catches the few neutral
// generated cards it would let through.
import type { God } from "../../data/types";
import { getCard } from "../../engine/cardRegistry";
import { isToken } from "../../engine/rules";

// Neutral cards created during the game that were never in any deck (Énutrof Butin
// loot, ...). Tokens are already excluded by isToken(); this set is only for
// non-token generated cards whose god is "None" (the class check alone would keep
// them). The corpus coverage test checks that none of them is ever a real deck card.
export const GENERATED_REWARD: ReadonlySet<number> = new Set<number>([
  944,  // Pelle (Butin reward)
  1252, // Pioche Antique (Butin reward)
  798,  // Élixir de Jouvence (Butin reward)
  757,  // Fléau (token-like prism payload)
]);

/** True iff `cardId` is plausibly one of god `foeGod`'s original deck cards, the
 *  gate every belief out/seen update passes through. */
export function realDeckCard(cardId: number, foeGod: God): boolean {
  const card = getCard(cardId);
  if (!card) return false;                 // unregistered → ignore
  if (isToken(cardId)) return false;       // token / board object / Fléau
  if (GENERATED_REWARD.has(cardId)) return false; // in-game reward, undeckable
  const g = card.god;                      // a card of another class came from my deck
  return g === "None" || g === foeGod;
}
