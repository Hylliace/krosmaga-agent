// handCostTempMods has to stay aligned 1:1 with the hand.
//
// effectiveCost and cheapestHandSlot read it by index:
//   (player.handCostMods[i] ?? 0) + (player.handCostTempMods?.[i] ?? 0)
// A shift never crashes: it quietly applies the surcharge (Ralentissement #188) or the discount
// (Bas de Laine #1047) to the wrong card.
//
// The bug: only playCard kept this alignment. Six paths rebuilt the hand without it:
// RecycleHand, RecycleFamily, RecycleGodDrawAny, DiscardRandomHand, DestroyCardInOpponentHand
// and fuseOrbesInHand.
//
// The stamps in this test are not uniform on purpose: with [2,2,2] an index shift would be
// completely invisible.
import { describe, it, expect } from "vitest";
import { card, scenario } from "./testkit";
import { playCard, effectiveCost } from "./rules";
import type { GameState } from "./state";

const MARTINGALE = 1149; // « Place votre main sous votre pioche. Piochez autant. »
const FILLER = 16;       // carte neutre, servant de contenu de main et de pioche

describe("RecycleHand (Martingale #1149) : le tampon temporaire ne survit pas au recyclage", () => {
  // Hand: [Martingale, A, B] with a non-uniform stamp, only A and B are surcharged. After the
  // recycle, the whole hand goes under the deck and as many new cards are drawn: none of them must
  // be surcharged, since none was there when the surcharge was applied.
  const etat = (): GameState => {
    card(MARTINGALE); card(FILLER);
    const s = scenario([]);
    return {
      ...s,
      prisms: [], seeds: [], butins: [],
      players: {
        ...s.players,
        ally: {
          ...s.players.ally,
          hand: [MARTINGALE, FILLER, FILLER],
          handCostMods: [0, 0, 0],
          handCostTempMods: [0, 5, 5], // +5 PA on the two cards held
          deck: [FILLER, FILLER, FILLER, FILLER],
          deckCostMods: [0, 0, 0, 0],
          ap: 10,
          maxAp: 10,
        },
      },
    };
  };

  it("les cartes repiochees paient leur cout IMPRIME, sans surcharge heritee", () => {
    const s = playCard(etat(), card(MARTINGALE), { x: 8, y: 2 });
    const p = s.players.ally;
    expect(p.hand.length).toBeGreaterThan(0); // the recycle did draw again
    // Before the fix, the [5,5] stamp survived the hand being emptied and applied to the newly
    // drawn cards.
    expect(effectiveCost(p, card(FILLER))).toBe(card(FILLER).cost);
  });

  it("le tampon ne depasse jamais la longueur de la main", () => {
    const s = playCard(etat(), card(MARTINGALE), { x: 8, y: 2 });
    const p = s.players.ally;
    // The invariant itself: a stamp longer than the hand is exactly what an index shift looks like.
    expect((p.handCostTempMods ?? []).length).toBeLessThanOrEqual(p.hand.length);
  });
});
