// A capture is not a death: it must not credit anyone with a kill.
//
// Engine rule: a creature that breaks through the wall (brokeThroughIds) does have
// currentLife = 0, but it is not dead: no CONTRE COUP, no MORT trigger, no COUP DE
// GRÂCE.
//
// The bug: collectCdgKills only filtered on currentLife <= 0 and went back through
// the log with no limit. But the log keeps the whole game (only createGame clears
// it). Since the capturing creature is at 0 HP, the backward scan found a DAMAGE
// from an earlier turn and named its author as the killer: an opponent was credited
// with a kill it did not make, and its COUP DE GRÂCE fired.
//
// The original comment said this case was "naturally filtered out (a capture is not
// a kill)" because the capturing creature would not have taken any damage. That is
// wrong as soon as it took some earlier in the game.
import { describe, it, expect } from "vitest";
import { card, mkCreature, scenario, byId } from "./testkit";
import { endTurn } from "./rules";
import type { GameState } from "./state";

// #329 Eksa Soth: COUP DE GRÂCE -> draw 1 card. Very easy to observe: just count
// the hand.
const EKSA_SOTH = 329;

// `sourceDuVieuxDegat`: who wounded the capturing creature on an earlier turn.
//  - instance 2 (Eksa Soth) -> the bug credits it with the capture
//  - an instance that does not exist -> nobody can be credited (control)
// Both states are otherwise the same, so the normal enemy draw at the start of the
// turn cancels out in the comparison.
const etat = (sourceDuVieuxDegat: number): GameState => {
  card(EKSA_SOTH);
  // The capturing creature: an ally at (1,2), 2 PM. Allies advance toward lower x;
  // the enemy wall column is x = 0.
  const capteur = mkCreature(1, "ally", { x: 1, y: 2 }, {
    cardId: 9999, currentAttack: 3, baseAttack: 3,
    currentLife: 4, baseLife: 4, baseMovement: 2, movementLeft: 2, hasAttacked: false,
  });
  // Eksa Soth, enemy, parked far from lane 2: it takes no part in this turn.
  const eksa = mkCreature(2, "enemy", { x: 5, y: 4 }, {
    cardId: EKSA_SOTH, triggers: card(EKSA_SOTH).triggers ?? [],
    currentAttack: 3, baseAttack: 3, currentLife: 4, baseLife: 4,
    movementLeft: 0, hasAttacked: true,
  });
  const s = scenario([capteur, eksa]);
  return {
    ...s,
    prisms: [], seeds: [], butins: [],
    // The enemy Dofus of lane 2 has only 1 HP: the capturing creature destroys it and
    // walks onto the wall column, so it breaks through.
    dofuses: s.dofuses.map((d) =>
      d.owner === "enemy" && d.position.y === 2 ? { ...d, currentLife: 1 } : d,
    ),
    // The point of the test: a wound taken by the capturing creature on an earlier turn,
    // already in the cumulative log.
    log: [{ type: "DAMAGE", sourceInstanceId: sourceDuVieuxDegat, targetInstanceId: 1, damage: 1 }],
    players: {
      ...s.players,
      ally: { ...s.players.ally, deck: [16, 16, 16] },
      enemy: { ...s.players.enemy, deck: [16, 16, 16], hand: [], handCostMods: [] },
    },
  };
};

describe("Une capture ne crédite aucun COUP DE GRÂCE (journal cumulatif)", () => {
  it("le capteur perce bien le mur (garde-fou du montage)", () => {
    const s = endTurn(etat(999));
    // Broken through = removed from the board, and the Dofus of lane 2 has fallen.
    expect(byId(s, 1)).toBeUndefined();
    expect(s.dofuses.filter((d) => d.owner === "enemy" && d.position.y === 2 && d.currentLife > 0)).toHaveLength(0);
  });

  it("l'adversaire qui avait blessé le capteur un tour plus tôt ne pioche PAS", () => {
    const avecCoupable = endTurn(etat(2)).players.enemy.hand.length;   // Eksa Soth désigné
    const temoin = endTurn(etat(999)).players.enemy.hand.length;        // nobody to name
    // The two states only differ by the source of an old damage. If the capture
    // credited Eksa Soth, its COUP DE GRÂCE would add a card.
    expect(avecCoupable).toBe(temoin);
  });
});
