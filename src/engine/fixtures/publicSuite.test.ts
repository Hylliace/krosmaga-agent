// Default test suite, runs with no game data at all.
//
// This is the suite `npm test` runs, so the one a reader who clones the repository sees pass.
// It tests the engine against entirely fictional cards (see syntheticPool.ts): summoning,
// combat, auras, triggers and movement.
//
// The full suite (2400+ tests) uses the real card catalog, which cannot be redistributed. It
// needs a local extraction.
import { describe, it, expect, beforeAll } from "vitest";
import { registerCards } from "../cardRegistry";
import { SYNTHETIC_POOL, ID } from "./syntheticPool";
import { mkCreature, scenario, byId } from "../testkit";
import { playCard, endTurn, withAuras } from "../rules";
import type { GameState } from "../state";

const card = (id: number) => SYNTHETIC_POOL.find((c) => c.id === id)!;

// Decks filled: scenario() leaves them empty, and an endTurn on an empty deck triggers
// FATIGUE, which hits the Dofus and pollutes the assertions.
const withDecks = (s: GameState): GameState => ({
  ...s,
  players: {
    ...s.players,
    ally: { ...s.players.ally, deck: [ID.FILLER, ID.FILLER, ID.FILLER] },
    enemy: { ...s.players.enemy, deck: [ID.FILLER, ID.FILLER, ID.FILLER] },
  },
});
const bare = (s: GameState): GameState => ({ ...s, prisms: [], seeds: [], butins: [] });

beforeAll(() => registerCards(SYNTHETIC_POOL));

describe("Invocation et pose", () => {
  it("poser une creature la met sur le plateau et debite les PA", () => {
    let s = scenario([], ID.GRUNT);
    const apAvant = s.players.ally.ap;
    s = playCard(s, card(ID.GRUNT), { x: 8, y: 2 });
    const pose = s.creatures.find((c) => c.cardId === ID.GRUNT);
    expect(pose).toBeDefined();
    expect(pose!.position).toEqual({ x: 8, y: 2 });
    expect(s.players.ally.ap).toBe(apAvant - card(ID.GRUNT).cost);
  });

  it("le mal des invocations empeche l'avance de fin de tour", () => {
    // The rule is stated as behaviour, not as an internal field: a creature placed this turn does
    // not advance at the end of the turn. So we test the advance, not how the engine stores it.
    let s = scenario([], ID.GRUNT);
    s = playCard(s, card(ID.GRUNT), { x: 8, y: 2 });
    const id = s.creatures.find((c) => c.cardId === ID.GRUNT)!.instanceId;
    const apres = endTurn(bare(withDecks(s)));
    expect(byId(apres, id)!.position).toEqual({ x: 8, y: 2 });
  });
});

describe("Aura de CHEF", () => {
  it("+1 AT aux AUTRES membres de la famille, ni a soi ni a l'ennemi", () => {
    const allie = mkCreature(1, "ally", { x: 6, y: 1 }, {
      cardId: ID.KIN, currentAttack: 1, baseAttack: 1, printedAttack: 1,
    });
    const etranger = mkCreature(2, "ally", { x: 6, y: 3 }, {
      cardId: ID.GRUNT, currentAttack: 2, baseAttack: 2, printedAttack: 2,
    });
    const ennemi = mkCreature(3, "enemy", { x: 3, y: 1 }, {
      cardId: ID.KIN, currentAttack: 1, baseAttack: 1, printedAttack: 1,
    });
    let s = scenario([allie, etranger, ennemi], ID.CHIEF);
    s = { ...s, players: { ...s.players, ally: { ...s.players.ally, ap: 10 } } };
    s = playCard(s, card(ID.CHIEF), { x: 8, y: 2 });

    expect(byId(s, 1)!.currentAttack).toBe(2); // Testkin allie : +1
    expect(byId(s, 2)!.currentAttack).toBe(2); // hors famille : rien
    expect(byId(s, 3)!.currentAttack).toBe(1); // Testkin ennemi : rien
    const chef = s.creatures.find((c) => c.cardId === ID.CHIEF)!;
    expect(chef.currentAttack).toBe(card(ID.CHIEF).attack); // « AUTRES » : pas soi
  });
});

describe("Conditionnel BLESSE", () => {
  const bleeder = (pv: number) =>
    mkCreature(1, "ally", { x: 6, y: 2 }, {
      cardId: ID.BLEEDER, currentAttack: 1, baseAttack: 1, printedAttack: 1,
      currentLife: pv, baseLife: 5, printedLife: 5,
    });

  it("a PV pleins : aucun bonus", () => {
    const s = scenario([bleeder(5)]);
    expect(withAuras(s.creatures).find((c) => c.instanceId === 1)!.currentAttack).toBe(1);
  });

  it("blesse : +2 AT", () => {
    const s = scenario([bleeder(3)]);
    expect(withAuras(s.creatures).find((c) => c.instanceId === 1)!.currentAttack).toBe(3);
  });
});

describe("Combat de fin de tour", () => {
  it("une creature avance puis engage l'ennemi rencontre, avec riposte", () => {
    const attaquant = mkCreature(1, "ally", { x: 6, y: 0 }, {
      cardId: ID.GRUNT, currentAttack: 2, baseAttack: 2, currentLife: 3, baseLife: 3,
      baseMovement: 2, movementLeft: 2, hasAttacked: false,
    });
    const defenseur = mkCreature(2, "enemy", { x: 5, y: 0 }, {
      cardId: ID.GRUNT, currentAttack: 2, baseAttack: 2, currentLife: 3, baseLife: 3,
    });
    const s = endTurn(bare(withDecks(scenario([attaquant, defenseur]))));
    // Degats simultanes : les deux encaissent.
    expect(byId(s, 1)!.currentLife).toBe(1);
    expect(byId(s, 2)!.currentLife).toBe(1);
  });

  it("CONTRE COUP : encaisser un coup ajoute la carte annoncee en main", () => {
    const riposteur = mkCreature(1, "ally", { x: 6, y: 0 }, {
      cardId: ID.RETORT, triggers: card(ID.RETORT).triggers ?? [],
      currentAttack: 2, baseAttack: 2, currentLife: 5, baseLife: 5,
      baseMovement: 2, movementLeft: 2, hasAttacked: false,
    });
    const foe = mkCreature(2, "enemy", { x: 5, y: 0 }, {
      cardId: ID.GRUNT, currentAttack: 2, baseAttack: 2, currentLife: 4, baseLife: 4,
    });
    const s = endTurn(bare(withDecks(scenario([riposteur, foe]))));
    expect(byId(s, 1)!.currentLife).toBeLessThan(5);
    expect(s.players.ally.hand).toContain(ID.GRUNT);
  });
});

describe("MUR", () => {
  it("une creature MUR ne bouge pas de sa case en fin de tour", () => {
    const mur = mkCreature(1, "ally", { x: 6, y: 1 }, {
      cardId: ID.WALL, properties: new Set(card(ID.WALL).properties),
      currentAttack: 0, baseAttack: 0, currentLife: 5, baseLife: 5,
      baseMovement: 0, movementLeft: 0,
    });
    const s = endTurn(bare(withDecks(scenario([mur]))));
    expect(byId(s, 1)!.position).toEqual({ x: 6, y: 1 });
  });
});

describe("Sort a cible", () => {
  it("le sort inflige ses degats a la creature ciblee, et a elle seule", () => {
    const cible = mkCreature(1, "enemy", { x: 3, y: 2 }, {
      cardId: ID.GRUNT, currentLife: 4, baseLife: 4,
    });
    const voisine = mkCreature(2, "enemy", { x: 3, y: 3 }, {
      cardId: ID.GRUNT, currentLife: 4, baseLife: 4,
    });
    let s = scenario([cible, voisine], ID.BOLT);
    s = playCard(s, card(ID.BOLT), { x: 3, y: 2 });
    expect(byId(s, 1)!.currentLife).toBe(2);
    expect(byId(s, 2)!.currentLife).toBe(4);
  });
});

describe("Ligne de tir", () => {
  it("un allie devant le tireur bloque la ligne : pas de tir", () => {
    // Every creature blocks the line of fire.
    const archer = mkCreature(1, "ally", { x: 7, y: 2 }, {
      cardId: ID.ARCHER, range: 3, currentAttack: 3, baseAttack: 3,
      currentLife: 2, baseLife: 2, baseMovement: 0, movementLeft: 0, hasAttacked: false,
    });
    const bloqueur = mkCreature(2, "ally", { x: 6, y: 2 }, {
      cardId: ID.WALL, properties: new Set(card(ID.WALL).properties),
      currentAttack: 0, baseAttack: 0, currentLife: 5, baseLife: 5,
      baseMovement: 0, movementLeft: 0,
    });
    const foe = mkCreature(3, "enemy", { x: 5, y: 2 }, {
      cardId: ID.GRUNT, currentLife: 4, baseLife: 4, currentAttack: 0, baseAttack: 0,
    });
    const s = endTurn(bare(withDecks(scenario([archer, bloqueur, foe]))));
    expect(byId(s, 3)!.currentLife).toBe(4); // intact : la ligne etait bouchee
  });

  it("ligne degagee : le tireur touche l'ennemi a distance", () => {
    const archer = mkCreature(1, "ally", { x: 7, y: 2 }, {
      cardId: ID.ARCHER, range: 3, currentAttack: 3, baseAttack: 3,
      currentLife: 2, baseLife: 2, baseMovement: 0, movementLeft: 0, hasAttacked: false,
    });
    const foe = mkCreature(3, "enemy", { x: 5, y: 2 }, {
      cardId: ID.GRUNT, currentLife: 4, baseLife: 4, currentAttack: 0, baseAttack: 0,
    });
    const s = endTurn(bare(withDecks(scenario([archer, foe]))));
    expect(byId(s, 3)!.currentLife).toBeLessThan(4);
  });
});

describe("Invariant de copie-sur-ecriture", () => {
  it("endTurn ne mute pas l'etat qu'on lui passe", () => {
    const empreinte = (s: GameState) =>
      JSON.stringify(s, (_k, v) => (v instanceof Set ? [...v] : v));
    const a = mkCreature(1, "ally", { x: 6, y: 0 }, {
      cardId: ID.GRUNT, currentAttack: 2, baseAttack: 2, currentLife: 3, baseLife: 3,
      baseMovement: 2, movementLeft: 2, hasAttacked: false,
    });
    const b = mkCreature(2, "enemy", { x: 5, y: 0 }, {
      cardId: ID.GRUNT, currentAttack: 2, baseAttack: 2, currentLife: 3, baseLife: 3,
    });
    const s = bare(withDecks(scenario([a, b])));
    const avant = empreinte(s);
    endTurn(s);
    expect(empreinte(s)).toBe(avant);
  });
});
