// Coverage for cards that are wired in the engine but were not used in any test.
//
// Each assertion comes from the card's text, never from what the engine does: a
// test written by copying the engine's output would lock its bugs in instead of
// showing them. When the text and the engine disagree, the test is not bent to
// match the engine.
import { describe, it, expect } from "vitest";
import { card, mkCreature, scenario, byId } from "../testkit";
import { playCard, endTurn, withAuras } from "../rules";
import type { GameState } from "../state";

// scenario() leaves the decks empty: an endTurn would draw from an empty deck and
// trigger FATIGUE, which would hit the Dofus and pollute the assertions. Both
// decks are filled with neutral cards.
const withDecks = (s: GameState, allyDeck: number[] = [16, 16, 16]): GameState => ({
  ...s,
  players: {
    ...s.players,
    ally: { ...s.players.ally, deck: allyDeck },
    enemy: { ...s.players.enemy, deck: [16, 16, 16] },
  },
});

// The ground objects placed by default (prisms) get in the way of the end-of-turn
// moves, so the board is cleared.
const bareBoard = (s: GameState): GameState => ({ ...s, prisms: [], seeds: [], butins: [] });

describe("#15 Tofu Royal - CHEF : +1 AT et +1 PM a vos AUTRES Tofus", () => {
  // Texte : « CHEF : +1 AT et +1 PM a vos autres Tofus. »
  // Trois qualificatifs a verifier : la famille (Tofu), le camp (vos), et
  // l'exclusion de soi-meme (autres).
  const build = () => {
    card(15);
    // #453 Tofu : AT 1, PV 2, PM 5. Allie, de la famille Tofu -> doit recevoir l'aura.
    const tofuAllie = mkCreature(60, "ally", { x: 6, y: 1 }, {
      cardId: 453, currentAttack: 1, baseAttack: 1, printedAttack: 1,
      baseMovement: 5, printedMovement: 5, movementLeft: 5, currentLife: 2, baseLife: 2,
    });
    // Ally without the Tofu family -> must get nothing.
    const allieNonTofu = mkCreature(61, "ally", { x: 6, y: 3 }, {
      cardId: 9999, currentAttack: 2, baseAttack: 2, baseMovement: 2, movementLeft: 2,
    });
    // Tofu ENNEMI -> « vos » Tofus : ne doit rien recevoir.
    const tofuEnnemi = mkCreature(62, "enemy", { x: 3, y: 1 }, {
      cardId: 453, currentAttack: 1, baseAttack: 1, printedAttack: 1,
      baseMovement: 5, printedMovement: 5, movementLeft: 5, currentLife: 2, baseLife: 2,
    });
    let s = scenario([tofuAllie, allieNonTofu, tofuEnnemi], 15);
    s = { ...s, players: { ...s.players, ally: { ...s.players.ally, ap: 10 } } };
    return playCard(s, card(15), { x: 8, y: 2 });
  };

  it("un Tofu allie gagne bien +1 AT et +1 PM", () => {
    const s = build();
    expect(byId(s, 60)!.currentAttack).toBe(2); // 1 imprime + 1 d'aura
    expect(byId(s, 60)!.baseMovement).toBe(6);  // 5 imprime + 1 d'aura
  });

  it("un allie qui n'est pas un Tofu ne recoit rien", () => {
    const s = build();
    expect(byId(s, 61)!.currentAttack).toBe(2);
    expect(byId(s, 61)!.baseMovement).toBe(2);
  });

  it("un Tofu ENNEMI ne recoit rien (« vos » Tofus)", () => {
    const s = build();
    expect(byId(s, 62)!.currentAttack).toBe(1);
    expect(byId(s, 62)!.baseMovement).toBe(5);
  });

  it("le Tofu Royal ne se buffe pas lui-meme (« vos AUTRES Tofus »)", () => {
    const s = build();
    const royal = s.creatures.find((c) => c.cardId === 15)!;
    expect(royal.currentAttack).toBe(card(15).attack);
    expect(royal.baseMovement).toBe(card(15).movement);
  });
});

describe("#29 Tireur d'elite - diminue de 1 la portee et augmente l'AT de 2", () => {
  // Text: « Diminue de 1 la portee d'une invocation et augmente son AT de 2. »
  // Both effects must land on the same target, in a single cast.
  it("la cible perd 1 de portee ET gagne 2 d'AT", () => {
    card(29);
    const cible = mkCreature(60, "ally", { x: 6, y: 2 }, {
      currentAttack: 3, baseAttack: 3, printedAttack: 3, range: 3,
    });
    let s = scenario([cible], 29);
    s = { ...s, players: { ...s.players, ally: { ...s.players.ally, ap: 10 } } };
    s = playCard(s, card(29), { x: 6, y: 2 });
    expect(byId(s, 60)!.range).toBe(2);         // 3 - 1
    expect(byId(s, 60)!.currentAttack).toBe(5); // 3 + 2
  });

  it("s'applique aussi a une invocation ENNEMIE (le texte ne restreint pas le camp)", () => {
    card(29);
    const cible = mkCreature(60, "enemy", { x: 3, y: 2 }, {
      currentAttack: 3, baseAttack: 3, printedAttack: 3, range: 3,
    });
    let s = scenario([cible], 29);
    s = { ...s, players: { ...s.players, ally: { ...s.players.ally, ap: 10 } } };
    s = playCard(s, card(29), { x: 3, y: 2 });
    expect(byId(s, 60)!.range).toBe(2);
    expect(byId(s, 60)!.currentAttack).toBe(5);
  });
});

describe("#43 Edass le Trouble Fete - BLESSE : gagne +2 AT et initiative", () => {
  // Text: « BLESSE : Gagne +2 AT et initiative. »
  // The bonus is conditional: it must only exist while the creature is wounded
  // (current HP < base HP).
  const edass = (life: number) =>
    mkCreature(1, "ally", { x: 6, y: 2 }, {
      cardId: 43, triggers: card(43).triggers ?? [],
      currentAttack: 1, baseAttack: 1, printedAttack: 1,
      currentLife: life, baseLife: 5, printedLife: 5,
    });

  it("a PV pleins : aucun bonus d'AT et pas d'initiative", () => {
    card(43);
    const s = scenario([edass(5)]);
    const e = withAuras(s.creatures).find((c) => c.instanceId === 1)!;
    expect(e.currentAttack).toBe(1);
    expect(e.properties.has("FirstStrike")).toBe(false);
  });

  it("blesse : +2 AT et initiative", () => {
    card(43);
    const s = scenario([edass(3)]);
    const e = withAuras(s.creatures).find((c) => c.instanceId === 1)!;
    expect(e.currentAttack).toBe(3); // 1 + 2
    expect(e.properties.has("FirstStrike")).toBe(true);
  });
});

describe("#45 Khan Karkass - CONTRE COUP : ajoute 1 Fan a votre main", () => {
  // Text: « CONTRE COUP : Ajoute 1 Fan a votre main. » CONTRE COUP fires when the
  // creature takes damage from another creature.
  it("encaisser un coup en melee met un Fan (#70) dans la main", () => {
    card(45); card(70);
    const khan = mkCreature(1, "ally", { x: 6, y: 0 }, {
      cardId: 45, triggers: card(45).triggers ?? [],
      currentAttack: 2, baseAttack: 2, currentLife: 6, baseLife: 6,
      baseMovement: 3, movementLeft: 3, hasAttacked: false,
    });
    const foe = mkCreature(2, "enemy", { x: 5, y: 0 }, {
      currentAttack: 2, baseAttack: 2, currentLife: 5, baseLife: 5,
    });
    const s = endTurn(bareBoard(withDecks(scenario([khan, foe]))));
    expect(byId(s, 1)!.currentLife).toBeLessThan(6); // il a bien encaisse
    expect(s.players.ally.hand).toContain(70);
  });
});

describe("#23 Arbre a Chachas - MUR + CONTRE COUP : ajoute 1 Chacha Noir", () => {
  // Text: « MUR / CONTRE COUP : Ajoute 1 Chacha Noir a votre main. »
  // MUR (Statue property) = does not move.
  const setup = () => {
    card(23); card(135);
    const arbre = mkCreature(1, "ally", { x: 6, y: 1 }, {
      cardId: 23, triggers: card(23).triggers ?? [],
      properties: new Set(card(23).properties ?? []),
      currentAttack: 1, baseAttack: 1, currentLife: 5, baseLife: 5,
      baseMovement: 0, movementLeft: 0, hasAttacked: false,
    });
    const foe = mkCreature(2, "enemy", { x: 5, y: 1 }, {
      currentAttack: 2, baseAttack: 2, currentLife: 5, baseLife: 5,
    });
    // The Arbre is a 0-PM MUR: it never moves into contact. The enemy has to walk up
    // to it, which only happens at the end of the enemy turn. Hence the two endTurn:
    // the first ends the ally turn, the second makes the enemy advance into contact.
    const s1 = endTurn(bareBoard(withDecks(scenario([arbre, foe]))));
    return endTurn(s1);
  };

  it("MUR : ne bouge pas de sa case en fin de tour", () => {
    const s = setup();
    expect(byId(s, 1)!.position).toEqual({ x: 6, y: 1 });
  });

  it("CONTRE COUP : encaisser un coup met un Chacha Noir (#135) dans la main", () => {
    const s = setup();
    expect(byId(s, 1)!.currentLife).toBeLessThan(5);
    expect(s.players.ally.hand).toContain(135);
  });
});

describe("#51 Yugo - CONTRE COUP : place en main le dernier membre de la Confrerie du Tofu de la pioche", () => {
  // Text: « CONTRE COUP : Place dans votre main le dernier membre de la
  // Confrerie du Tofu de votre pioche. »
  // drawCardFrom does deck.pop(): the end of the array is the top of the deck, so
  // the bottom (the "dernier") is index 0.
  it("un membre de la Confrerie remonte de la pioche vers la main", () => {
    card(51); card(47);
    const yugo = mkCreature(1, "ally", { x: 6, y: 0 }, {
      cardId: 51, triggers: card(51).triggers ?? [],
      currentAttack: 3, baseAttack: 3, currentLife: 4, baseLife: 4,
      baseMovement: 3, movementLeft: 3, hasAttacked: false,
    });
    const foe = mkCreature(2, "enemy", { x: 5, y: 0 }, {
      currentAttack: 1, baseAttack: 1, currentLife: 5, baseLife: 5,
    });
    // #47 Adamai is of the BrotherhoodOfTheTofu family; it is the only one of its
    // family in the deck, placed at the bottom.
    const s = endTurn(bareBoard(withDecks(scenario([yugo, foe]), [47, 16, 16])));
    expect(byId(s, 1)!.currentLife).toBeLessThan(4); // le CONTRE COUP a bien pu partir
    expect(s.players.ally.hand).toContain(47);
    expect(s.players.ally.deck).not.toContain(47);
  });
});
