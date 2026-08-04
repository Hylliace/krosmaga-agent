// Invariant: the engine never mutates the state it is given.
//
// The engine is copy-on-write: each transition returns a new state. If a transition writes into the
// input state, three things break silently:
//   - the snapshot already saved in the replay history is rewritten, so the replay shows damage
//     before the card that causes it;
//   - the AI, which tries several moves from the same node, sees its probes add up: two identical
//     calls give different results;
//   - the state attached to a bug report no longer describes the real game.
//
// No test protected this invariant before; this file does.
import { describe, it, expect } from "vitest";
import { cards, card, mkCreature, scenario } from "./testkit";
import { endTurn } from "./rules";
import type { GameState } from "./state";

// Full fingerprint of the state. JSON.stringify ignores Sets, so they are expanded, otherwise a
// change to `properties` would go unnoticed.
const empreinte = (s: GameState): string =>
  JSON.stringify(s, (_k, v) => (v instanceof Set ? [...v] : v));

describe("endTurn ne mute pas l'etat d'entree", () => {
  // Detonation of a Sram trap (step 0d): the penalty hits the player's Dofus, and each Dofus wound
  // triggers Julith Jurgen #352, which deals damage to all enemy invocations. That hit back writes into
  // the creatures array it gets, hence the corruption when it was the input state's array.
  const etatPiege = (): GameState => {
    cards();
    const julith = mkCreature(1, "ally", { x: 7, y: 2 }, {
      cardId: 352, triggers: card(352).triggers ?? [],
      currentLife: 4, baseLife: 4, currentAttack: 2, baseAttack: 2,
      movementLeft: 0, hasAttacked: true,
    });
    const ennemi = mkCreature(2, "enemy", { x: 3, y: 2 }, {
      cardId: 9999, currentLife: 5, baseLife: 5, currentAttack: 1, baseAttack: 1,
      movementLeft: 0, hasAttacked: true,
    });
    const s = scenario([julith, ennemi]);
    return {
      ...s,
      prisms: [], seeds: [], butins: [],
      players: {
        ...s.players,
        ally: {
          ...s.players.ally,
          deck: [16, 16, 16],
          // Piege actif dont le compteur tombe a 0 a cette fin de tour.
          activeTraps: [{ cardId: 681, counter: 1, penalty: 3 }],
        },
        enemy: { ...s.players.enemy, deck: [16, 16, 16] },
      },
    };
  };

  it("la detonation d'un piege laisse l'etat d'entree intact", () => {
    const s = etatPiege();
    const avant = empreinte(s);
    endTurn(s); // retour volontairement ignore : on n'observe que l'entree
    expect(empreinte(s)).toBe(avant);
  });

  it("appeler endTurn deux fois sur le MEME etat donne le MEME resultat", () => {
    // Getting a different result from the same call is the visible symptom of mutating the input: it is
    // exactly what the AI does when it searches a node again.
    const s = etatPiege();
    const a = empreinte(endTurn(s));
    const b = empreinte(endTurn(s));
    expect(b).toBe(a);
  });
});
