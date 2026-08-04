// The random stream has to advance, never be overwritten.
//
// The engine has a single seeded stream in `state.rng`. Each draw advances it, and that is what
// guarantees two random events in a row do not replay the same draw.
//
// The bug: castSpell opens its own local stream (`new Rng(state.rng)`) and, at the end,
// overwrites the global stream with its own. But resolveDeathsAndWin, which runs in the middle of
// the cast and makes its own draws for MORT reactions, received `state`, so the stream from before
// the spell; and its advance was then thrown away by the overwrite.
//
// Result: a non-random spell that kills a creature with a random MORT left the global stream
// unchanged. The next random event of the game then replays exactly the same draw. In replays and
// online, two runs of the same state could then diverge.
import { describe, it, expect } from "vitest";
import { card, mkCreature, scenario } from "./testkit";
import { playCard } from "./rules";
import type { GameState } from "./state";

const FIOLE = 123;    // Fiole de Douleur : 2 degats, aucun aleatoire
const MALOBOSS = 470; // MORT : ajoute 3 cartes de Bandit ALEATOIRES a la main

describe("castSpell : l'avance du flux aleatoire n'est pas perdue", () => {
  const etat = (): GameState => {
    card(FIOLE); card(MALOBOSS);
    // Enemy Maloboss with 2 HP: the Fiole kills it outright, with no draw at all on the spell's side.
    const cible = mkCreature(1, "enemy", { x: 3, y: 2 }, {
      cardId: MALOBOSS, triggers: card(MALOBOSS).triggers ?? [],
      currentLife: 2, baseLife: 2, currentAttack: 2, baseAttack: 2,
    });
    const s = scenario([cible], FIOLE);
    return {
      ...s,
      prisms: [], seeds: [], butins: [],
      rng: 123456,
      players: {
        ...s.players,
        ally: { ...s.players.ally, ap: 10 },
        // The MORT draws random Bandits for the dead creature's camp.
        enemy: { ...s.players.enemy, hand: [], handCostMods: [] },
      },
    };
  };

  it("tuer une creature a MORT aleatoire FAIT AVANCER state.rng", () => {
    const s0 = etat();
    const s1 = playCard(s0, card(FIOLE), { x: 3, y: 2 });
    // La MORT du Maloboss a bien eu lieu.
    expect(s1.creatures.find((c) => c.instanceId === 1)).toBeUndefined();
    expect(s1.players.enemy.hand.length).toBeGreaterThan(0);
    // And the draw it used has to show in the global stream.
    expect(s1.rng).not.toBe(s0.rng);
  });

  it("le tirage suivant n'est pas une REPETITION de celui de la MORT", () => {
    // Direct symptom of the overwrite: if the stream does not move, casting the same spell
    // again from the resulting state makes exactly the same draw.
    const s1 = playCard(etat(), card(FIOLE), { x: 3, y: 2 });
    const mainApres1 = [...s1.players.enemy.hand];

    // A second Maloboss, same situation, but starting from the state that already advanced.
    // The drawn cards must not be the same as the first time; otherwise the stream did not move.
    const s2base: GameState = {
      ...s1,
      creatures: [
        mkCreature(2, "enemy", { x: 3, y: 2 }, {
          cardId: MALOBOSS, triggers: card(MALOBOSS).triggers ?? [],
          currentLife: 2, baseLife: 2, currentAttack: 2, baseAttack: 2,
        }),
      ],
      players: {
        ...s1.players,
        ally: { ...s1.players.ally, hand: [FIOLE], handCostMods: [0], ap: 10 },
        enemy: { ...s1.players.enemy, hand: [], handCostMods: [] },
      },
    };
    const s2 = playCard(s2base, card(FIOLE), { x: 3, y: 2 });
    expect(s2.players.enemy.hand.length).toBeGreaterThan(0);
    expect(s2.players.enemy.hand).not.toEqual(mainApres1);
  });
});
