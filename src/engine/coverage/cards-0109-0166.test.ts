// Coverage for cards that are wired in the engine but were not used in any test:
//   #109 #114 #115 #118 #122 #123 #124 #137 #141 #160 #163 #166
//
// Each assertion comes from the card's text, never from what the engine does: a
// test written by copying the engine's output would lock its bugs in instead of
// showing them.
import { describe, it, expect } from "vitest";
import { card, mkCreature, scenario, byId } from "../testkit";
import { playCard, endTurn, resolvePendingAction, canPlayCard, effectiveCost, withAuras } from "../rules";
import type { GameState } from "../state";
import type { CreatureInstance } from "../state";

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

// The ground objects placed by default (prisms) get in the way of the moves and get
// picked up under a placed creature, so the board is cleared.
const bareBoard = (s: GameState): GameState => ({ ...s, prisms: [], seeds: [], butins: [] });

// Replace a creature on the board (to take it out of summoning sickness after a real
// placement, without building the instance by hand).
const patch = (s: GameState, id: number, o: Record<string, unknown>): GameState => ({
  ...s,
  creatures: s.creatures.map((c) => (c.instanceId === id ? { ...c, ...o } : c)),
});

// Retrouve l'exemplaire pose d'une carte donnee.
const posee = (s: GameState, cardId: number): CreatureInstance =>
  s.creatures.find((c) => c.cardId === cardId)!;

describe("#109 Flaqueux - PORTEE", () => {
  // Text: « PORTEE : @range@ », ShooterRangeData RangeMin 1 / RangeMax 2: it is a
  // range 2 shooter. A shooter fires from a distance (d >= 2) with no hit back and does
  // not move after shooting.
  // Printed stats: AT 1, HP 2, PM 3.

  // Place the real Flaqueux, then take it out of summoning sickness on the chosen
  // cell, so the tested range is the one set by the card, not a value copied by hand
  // into mkCreature.
  const flaqueuxEnJeu = (s0: GameState, at: { x: number; y: number }) => {
    let s = playCard(s0, card(109), { x: 8, y: 2 });
    const f = posee(s, 109);
    s = patch(s, f.instanceId, { position: { ...at }, movementLeft: 3, hasAttacked: false });
    return { s, id: f.instanceId };
  };

  it("pose sur le plateau, il a bien une PORTEE de 2", () => {
    let s = bareBoard(scenario([], 109));
    s = playCard(s, card(109), { x: 8, y: 2 });
    expect(posee(s, 109).range).toBe(2);
  });

  it("tire a 2 cases sans avancer ni subir de riposte", () => {
    // Target exactly 2 cells away (6 - 4): in range, so a ranged shot.
    const foe = mkCreature(50, "enemy", { x: 4, y: 2 }, {
      currentAttack: 4, baseAttack: 4, currentLife: 5, baseLife: 5,
      movementLeft: 0, hasAttacked: true,
    });
    const { s: s0, id } = flaqueuxEnJeu(bareBoard(withDecks(scenario([foe], 109))), { x: 6, y: 2 });
    const s = endTurn(s0);
    expect(byId(s, 50)!.currentLife).toBe(4);            // 5 - 1 (AT imprime du Flaqueux)
    expect(byId(s, id)!.position).toEqual({ x: 6, y: 2 }); // it does not move after its shot
    expect(byId(s, id)!.currentLife).toBe(2);            // aucune riposte a distance
  });

  it("sa portee vaut EXACTEMENT 2 : a 3 cases il n'a pas de tir, il avance d'abord", () => {
    // What tells them apart: with range 3 it would shoot from x=6 without moving. With
    // range 2 it has to move one cell closer first.
    const foe = mkCreature(50, "enemy", { x: 3, y: 2 }, {
      currentAttack: 4, baseAttack: 4, currentLife: 5, baseLife: 5,
      movementLeft: 0, hasAttacked: true,
    });
    const { s: s0, id } = flaqueuxEnJeu(bareBoard(withDecks(scenario([foe], 109))), { x: 6, y: 2 });
    const s = endTurn(s0);
    expect(byId(s, id)!.position).toEqual({ x: 5, y: 2 }); // avance d'1 case pour entrer en portee
    expect(byId(s, 50)!.currentLife).toBe(4);             // puis tire : 5 - 1
    expect(byId(s, id)!.currentLife).toBe(2);             // toujours aucune riposte (d = 2)
  });
});

describe("#114 Ruel Stroud - Coute 3 PA de moins par autre membre allie de la Confrerie du Tofu en jeu", () => {
  // Text: « Coute 3 PA de moins par autre membre allie de la Confrerie du Tofu en
  // jeu. » Printed cost 6. Four qualifiers: the family (BrotherhoodOfTheTofu), the camp
  // (allie), the place ("en jeu") and the "par" count. #47 Adamai is of the
  // BrotherhoodOfTheTofu family.
  const cost = (creatures: CreatureInstance[], hand: number[] = [], deck?: number[]) => {
    let s = scenario(creatures, 114, ...hand);
    if (deck) s = withDecks(s, deck);
    return effectiveCost(s.players.ally, card(114), s.creatures, 0, [], { ally: 0, enemy: 0 });
  };
  const bro = (id: number, owner: "ally" | "enemy", x: number, y: number, cardId = 47) =>
    mkCreature(id, owner, { x, y }, { cardId });

  it("aucun membre en jeu : cout plein de 6", () => {
    card(47);
    expect(cost([])).toBe(6);
  });

  it("un membre allie en jeu : 6 - 3 = 3", () => {
    card(47);
    expect(cost([bro(1, "ally", 6, 1)])).toBe(3);
  });

  it("deux membres allies en jeu : 6 - 6 = 0 (jamais negatif)", () => {
    card(47);
    expect(cost([bro(1, "ally", 6, 1), bro(2, "ally", 6, 3)])).toBe(0);
  });

  it("un membre ENNEMI de la Confrerie ne reduit rien (« allie »)", () => {
    card(47);
    expect(cost([bro(1, "enemy", 3, 1)])).toBe(6);
  });

  it("un allie qui n'est PAS de la Confrerie ne reduit rien", () => {
    // #453 Tofu : famille « Tofu », pas « BrotherhoodOfTheTofu ».
    card(453);
    expect(cost([mkCreature(1, "ally", { x: 6, y: 1 }, { cardId: 453 })])).toBe(6);
  });

  it("un premier Ruel Stroud deja en jeu reduit le second (il est lui-meme de la Confrerie)", () => {
    // "par autre membre": the placed copy is a different member from the one in hand.
    card(114);
    expect(cost([bro(1, "ally", 6, 1, 114)])).toBe(3);
  });

  it("un membre dans la main ou dans la PIOCHE ne reduit rien (« en jeu »)", () => {
    card(47);
    expect(cost([], [47])).toBe(6);            // en main
    expect(cost([], [], [47, 47, 47])).toBe(6); // dans la pioche
  });
});

describe("#115 Corbacassin - MORT : inflige 1 degat aux invocations autour de lui", () => {
  // Text: « MORT : Inflige 1 degat aux invocations autour de lui. »
  // "aux invocations" with no camp qualifier -> both camps.
  // "autour de lui" -> the 8 adjacent cells (3x3 block centred on its cell).
  // It is killed with #123 Fiole de Douleur (2 damage): it has only 1 HP.
  const setup = () => {
    card(115); card(123);
    const corbac = mkCreature(1, "ally", { x: 6, y: 2 }, {
      cardId: 115, triggers: card(115).triggers ?? [],
      currentAttack: 1, baseAttack: 1, currentLife: 1, baseLife: 1, printedLife: 1,
    });
    const allieAdjacent = mkCreature(2, "ally", { x: 6, y: 1 }, { currentLife: 5, baseLife: 5 });
    const ennemiAdjacent = mkCreature(3, "enemy", { x: 5, y: 2 }, { currentLife: 5, baseLife: 5 });
    const ennemiDiagonal = mkCreature(4, "enemy", { x: 5, y: 3 }, { currentLife: 5, baseLife: 5 });
    const ennemiLoin = mkCreature(5, "enemy", { x: 4, y: 2 }, { currentLife: 5, baseLife: 5 });
    const s = bareBoard(scenario([corbac, allieAdjacent, ennemiAdjacent, ennemiDiagonal, ennemiLoin], 123));
    return playCard(s, card(123), { x: 6, y: 2 }); // la Fiole tue le Corbacassin
  };

  it("le Corbacassin meurt bien (montage)", () => {
    expect(byId(setup(), 1)).toBeUndefined();
  });

  it("une invocation ALLIEE adjacente prend 1", () => {
    expect(byId(setup(), 2)!.currentLife).toBe(4);
  });

  it("une invocation ENNEMIE adjacente prend 1 (« aux invocations », pas de camp)", () => {
    expect(byId(setup(), 3)!.currentLife).toBe(4);
  });

  it("une invocation en DIAGONALE est bien « autour de lui »", () => {
    expect(byId(setup(), 4)!.currentLife).toBe(4);
  });

  it("une invocation a 2 cases n'est PAS autour de lui", () => {
    expect(byId(setup(), 5)!.currentLife).toBe(5);
  });

  it("1 degat seulement, et il passe par l'armure de la voisine", () => {
    // « Inflige 1 degat » : regle generale, tout degat traverse d'abord l'armure.
    card(115); card(123);
    const corbac = mkCreature(1, "ally", { x: 6, y: 2 }, {
      cardId: 115, triggers: card(115).triggers ?? [],
      currentAttack: 1, baseAttack: 1, currentLife: 1, baseLife: 1, printedLife: 1,
    });
    const blinde = mkCreature(2, "ally", { x: 6, y: 1 }, { currentLife: 5, baseLife: 5, armor: 2 });
    let s = bareBoard(scenario([corbac, blinde], 123));
    s = playCard(s, card(123), { x: 6, y: 2 });
    expect(byId(s, 2)!.armor).toBe(1);       // 2 - 1 : un seul degat
    expect(byId(s, 2)!.currentLife).toBe(5); // PV intacts
  });

  it("les Dofus autour de lui ne sont pas touches (« aux invocations »)", () => {
    // General rule: damage never reaches a Dofus unless the text says so, and the text
    // only talks about creatures.
    card(115); card(123);
    // Cell {8,0}: the allied Dofus of row 0 is at {9,0}, adjacent.
    const corbac = mkCreature(1, "ally", { x: 8, y: 0 }, {
      cardId: 115, triggers: card(115).triggers ?? [],
      currentAttack: 1, baseAttack: 1, currentLife: 1, baseLife: 1, printedLife: 1,
    });
    let s = bareBoard(scenario([corbac], 123));
    const avant = s.dofuses.find((d) => d.position.x === 9 && d.position.y === 0)!.currentLife;
    s = playCard(s, card(123), { x: 8, y: 0 });
    expect(byId(s, 1)).toBeUndefined(); // il est bien mort
    expect(s.dofuses.find((d) => d.position.x === 9 && d.position.y === 0)!.currentLife).toBe(avant);
  });
});

describe("#118 Archille - INITIATIVE", () => {
  // Text: « INITIATIVE ». A creature with initiative hits before its target: if it
  // kills it, it takes no hit back. Stats: AT 3, HP 4.
  it("pose sur le plateau, il porte bien INITIATIVE", () => {
    let s = bareBoard(scenario([], 118));
    s = playCard(s, card(118), { x: 8, y: 2 });
    expect(posee(s, 118).properties.has("FirstStrike")).toBe(true);
  });

  it("frappe le premier : il tue sa cible et n'encaisse pas la riposte", () => {
    // Archille: AT 3, HP 4. Target: AT 4, HP 3. Without initiative the exchange would be
    // mutual and Archille (4 HP) would die from the 4 enemy AT.
    // (Checked by removing it: without the card's FirstStrike SetPropertyData, Archille
    // dies, so the "untouched" assertion really depends on the keyword.)
    let s = bareBoard(withDecks(scenario([], 118)));
    s = playCard(s, card(118), { x: 8, y: 2 });
    const id = posee(s, 118).instanceId;
    // Take it out of summoning sickness and put it in contact with the target.
    s = patch(s, id, { position: { x: 6, y: 2 }, movementLeft: 1, hasAttacked: false });
    const foe = mkCreature(50, "enemy", { x: 5, y: 2 }, {
      currentAttack: 4, baseAttack: 4, currentLife: 3, baseLife: 3,
      movementLeft: 0, hasAttacked: true,
    });
    s = { ...s, creatures: [...s.creatures, foe] };
    s = endTurn(s);
    expect(byId(s, 50)).toBeUndefined();       // the target (3 HP) falls to the 3 AT
    expect(byId(s, id)!.currentLife).toBe(4);  // intact : pas de riposte
  });

  it("l'initiative ne dispense pas de la riposte d'une cible qui SURVIT", () => {
    // "INITIATIVE" = hitting first, not immunity. A target with 6 HP takes the 3 AT,
    // survives and hits back normally.
    let s = bareBoard(withDecks(scenario([], 118)));
    s = playCard(s, card(118), { x: 8, y: 2 });
    const id = posee(s, 118).instanceId;
    s = patch(s, id, { position: { x: 6, y: 2 }, movementLeft: 1, hasAttacked: false });
    const foe = mkCreature(50, "enemy", { x: 5, y: 2 }, {
      currentAttack: 1, baseAttack: 1, currentLife: 6, baseLife: 6,
      movementLeft: 0, hasAttacked: true,
    });
    s = { ...s, creatures: [...s.creatures, foe] };
    s = endTurn(s);
    expect(byId(s, 50)!.currentLife).toBe(3);  // 6 - 3
    expect(byId(s, id)!.currentLife).toBe(3);  // 4 - 1 : la riposte est bien encaissee
  });
});

describe("#122 Black Tiwabbit - APPARITION : Infligez 1 degat", () => {
  // Texte : « APPARITION : Infligez 1 degat. » Aucun qualificatif de camp :
  // la cible peut etre n'importe quelle invocation. « Infligez » (et non
  // « s'inflige ») : la cible est choisie.
  it("ouvre un choix de cible et retire 1 PV a une invocation ADVERSE", () => {
    const foe = mkCreature(50, "enemy", { x: 4, y: 2 }, { currentLife: 5, baseLife: 5 });
    let s = bareBoard(scenario([foe], 122));
    s = playCard(s, card(122), { x: 8, y: 2 });
    expect(s.pendingAction).not.toBeNull();
    expect(s.pendingAction!.filter).toBe("any_creature");
    s = resolvePendingAction(s, { x: 4, y: 2 });
    expect(byId(s, 50)!.currentLife).toBe(4); // 5 - 1
  });

  it("peut aussi frapper une invocation ALLIEE (le texte ne restreint pas le camp)", () => {
    const mate = mkCreature(51, "ally", { x: 6, y: 1 }, { currentLife: 5, baseLife: 5 });
    let s = bareBoard(scenario([mate], 122));
    s = playCard(s, card(122), { x: 8, y: 2 });
    s = resolvePendingAction(s, { x: 6, y: 1 });
    expect(byId(s, 51)!.currentLife).toBe(4);
  });

  it("un seul degat, et sur la SEULE cible choisie", () => {
    const a = mkCreature(50, "enemy", { x: 4, y: 2 }, { currentLife: 5, baseLife: 5 });
    const b = mkCreature(51, "enemy", { x: 4, y: 1 }, { currentLife: 5, baseLife: 5 });
    let s = bareBoard(scenario([a, b], 122));
    s = playCard(s, card(122), { x: 8, y: 2 });
    s = resolvePendingAction(s, { x: 4, y: 2 });
    expect(byId(s, 50)!.currentLife).toBe(4);
    expect(byId(s, 51)!.currentLife).toBe(5); // the neighbour is not concerned
  });

  it("un Dofus n'est pas une cible : le Dofus adverse ne perd rien", () => {
    // General rule: damage never reaches a Dofus unless the text says so.
    const foe = mkCreature(50, "enemy", { x: 4, y: 2 }, { currentLife: 5, baseLife: 5 });
    let s = bareBoard(scenario([foe], 122));
    s = playCard(s, card(122), { x: 8, y: 2 });
    const avant = s.dofuses.find((d) => d.position.x === 0 && d.position.y === 0)!.currentLife;
    s = resolvePendingAction(s, { x: 0, y: 0 }); // clic sur un Dofus adverse
    expect(s.dofuses.find((d) => d.position.x === 0 && d.position.y === 0)!.currentLife).toBe(avant);
  });
});

describe("#123 Fiole de Douleur - Inflige 2", () => {
  // Text: « Inflige @damage@ » = 2 damage; castTarget AnySummon -> the target is a
  // creature of any camp. General rule: damage never reaches a Dofus unless the text
  // says so.
  it("retire 2 PV a une invocation adverse", () => {
    const foe = mkCreature(50, "enemy", { x: 4, y: 2 }, { currentLife: 5, baseLife: 5 });
    let s = bareBoard(scenario([foe], 123));
    s = playCard(s, card(123), { x: 4, y: 2 });
    expect(byId(s, 50)!.currentLife).toBe(3); // 5 - 2
  });

  it("peut viser une invocation ALLIEE (« une invocation », sans camp)", () => {
    const mate = mkCreature(51, "ally", { x: 6, y: 2 }, { currentLife: 5, baseLife: 5 });
    let s = bareBoard(scenario([mate], 123));
    expect(canPlayCard(s, card(123), { x: 6, y: 2 })).toBeNull();
    s = playCard(s, card(123), { x: 6, y: 2 });
    expect(byId(s, 51)!.currentLife).toBe(3);
  });

  it("ne peut pas viser un Dofus (pourtant bien vivant sur la case) ni une case vide", () => {
    const s = bareBoard(scenario([], 123));
    // Setup: first check that a living Dofus really is on these cells, otherwise the
    // refusal would prove nothing.
    expect(s.dofuses.some((d) => d.position.x === 0 && d.position.y === 0 && d.currentLife > 0)).toBe(true);
    expect(s.dofuses.some((d) => d.position.x === 9 && d.position.y === 0 && d.currentLife > 0)).toBe(true);
    expect(canPlayCard(s, card(123), { x: 0, y: 0 })).not.toBeNull(); // Dofus adverse
    expect(canPlayCard(s, card(123), { x: 9, y: 0 })).not.toBeNull(); // Dofus allie
    expect(canPlayCard(s, card(123), { x: 5, y: 2 })).not.toBeNull(); // case vide
  });

  it("les degats passent par l'armure avant les PV", () => {
    const foe = mkCreature(50, "enemy", { x: 4, y: 2 }, { currentLife: 5, baseLife: 5, armor: 3 });
    let s = bareBoard(scenario([foe], 123));
    s = playCard(s, card(123), { x: 4, y: 2 });
    expect(byId(s, 50)!.armor).toBe(1);        // 3 - 2
    expect(byId(s, 50)!.currentLife).toBe(5);  // PV intacts
  });

  it("frappe la seule cible designee : les voisines sont intactes", () => {
    const cible = mkCreature(50, "enemy", { x: 4, y: 2 }, { currentLife: 5, baseLife: 5 });
    const voisine = mkCreature(51, "enemy", { x: 4, y: 1 }, { currentLife: 5, baseLife: 5 });
    let s = bareBoard(scenario([cible, voisine], 123));
    s = playCard(s, card(123), { x: 4, y: 2 });
    expect(byId(s, 50)!.currentLife).toBe(3);
    expect(byId(s, 51)!.currentLife).toBe(5);
  });
});

describe("#124 Cactoblong - APPARITION : s'inflige 2 degats", () => {
  // Text: « APPARITION : S'inflige 2 degats. » Cactoblong is a 6/6, so it comes into
  // play with 4 HP out of 6.
  it("arrive en jeu a 4 PV sur 6", () => {
    let s = bareBoard(scenario([], 124));
    s = playCard(s, card(124), { x: 8, y: 2 });
    expect(posee(s, 124).baseLife).toBe(6);
    expect(posee(s, 124).currentLife).toBe(4); // 6 - 2
  });

  it("ne touche que lui-meme : ses voisins sont intacts", () => {
    const voisin = mkCreature(50, "ally", { x: 8, y: 1 }, { currentLife: 5, baseLife: 5 });
    const foe = mkCreature(51, "enemy", { x: 4, y: 2 }, { currentLife: 5, baseLife: 5 });
    let s = bareBoard(scenario([voisin, foe], 124));
    s = playCard(s, card(124), { x: 8, y: 2 });
    expect(byId(s, 50)!.currentLife).toBe(5);
    expect(byId(s, 51)!.currentLife).toBe(5);
  });

  it("« S'inflige » : aucun choix de cible ne s'ouvre", () => {
    const foe = mkCreature(50, "enemy", { x: 4, y: 2 }, { currentLife: 5, baseLife: 5 });
    let s = bareBoard(scenario([foe], 124));
    s = playCard(s, card(124), { x: 8, y: 2 });
    expect(s.pendingAction).toBeNull();
  });
});

describe("#137 Yugo - CONTRE COUP : place en main le dernier membre de la Confrerie du Tofu de la pioche", () => {
  // Text: « CONTRE COUP : Place dans votre main le dernier membre de la Confrerie du
  // Tofu de votre pioche. » Stats: 6 AP, AT 4, HP 6, PM 3.
  // The trigger JSON is the same as #51 Yugo's, but the card is different, so it gets
  // its own behaviour test.
  // drawCardFrom does deck.pop(): the end of the array is the top of the deck, so the
  // bottom (the "dernier") is index 0.
  const combat = (allyDeck: number[]) => {
    card(137);
    const yugo = mkCreature(1, "ally", { x: 6, y: 0 }, {
      cardId: 137, triggers: card(137).triggers ?? [],
      currentAttack: 4, baseAttack: 4, currentLife: 6, baseLife: 6,
      baseMovement: 3, movementLeft: 3, hasAttacked: false,
    });
    const foe = mkCreature(2, "enemy", { x: 5, y: 0 }, {
      currentAttack: 1, baseAttack: 1, currentLife: 9, baseLife: 9,
    });
    return endTurn(bareBoard(withDecks(scenario([yugo, foe]), allyDeck)));
  };

  it("un membre de la Confrerie remonte de la pioche vers la main", () => {
    // #47 Adamai est de la famille BrotherhoodOfTheTofu.
    card(47);
    const s = combat([47, 16, 16]);
    expect(byId(s, 1)!.currentLife).toBeLessThan(6); // le CONTRE COUP a bien pu partir
    expect(s.players.ally.hand).toContain(47);
    expect(s.players.ally.deck).not.toContain(47);
  });

  it("« le DERNIER » = le fond de la pioche, pas le premier membre venu", () => {
    // Two members of the Confrerie in the deck: #47 at the bottom (index 0), #51 Yugo
    // just above. Only the one at the bottom must come up.
    card(47); card(51);
    const s = combat([47, 51, 16]);
    expect(s.players.ally.hand).toContain(47);
    expect(s.players.ally.hand).not.toContain(51);
    expect(s.players.ally.deck).toContain(51);
  });

  it("aucun membre de la Confrerie dans la pioche : rien ne monte en main", () => {
    // #16 Bebe Phorreur is not of the Confrerie du Tofu.
    // We do not assert an empty hand: the turn change has its own draw, unrelated to
    // the trigger. We assert what the text requires: no member of the Confrerie joins
    // the hand.
    const s = combat([16, 16, 16]);
    expect(byId(s, 1)!.currentLife).toBeLessThan(6); // le declencheur a bien tourne
    const confrerie = s.players.ally.hand.filter((id) =>
      (card(id).families ?? []).includes("BrotherhoodOfTheTofu"));
    expect(confrerie).toEqual([]);
  });
});

describe("#141 Tristepin - APPARITION Charge + initiative conditionnelle", () => {
  // Text: « APPARITION : Charge. Gagne initiative si un autre membre allie de la
  // Confrerie du Tofu est en jeu. » Stats: 4 AP, AT 3, HP 4, PM 3.
  // Same wiring as #6 Tristepin, but a different card, so it gets its own test.
  const FS = (cs: CreatureInstance[], id: number) =>
    withAuras(cs).find((c) => c.instanceId === id)!.properties.has("FirstStrike");
  const pin = (o: Record<string, unknown> = {}) =>
    mkCreature(1, "ally", { x: 6, y: 2 }, { cardId: 141, ...o });
  // #47 Adamai : famille BrotherhoodOfTheTofu.
  const membre = (owner: "ally" | "enemy", life = 5) =>
    mkCreature(2, owner, { x: 6, y: 1 }, { cardId: 47, currentLife: life });

  it("seul en jeu : PAS d'initiative", () => {
    card(141); card(47);
    expect(FS([pin()], 1)).toBe(false);
  });

  it("un AUTRE membre allie de la Confrerie en jeu : initiative", () => {
    card(141); card(47);
    expect(FS([pin(), membre("ally")], 1)).toBe(true);
  });

  it("le membre meurt : l'initiative est revoquee", () => {
    card(141); card(47);
    expect(FS([pin(), membre("ally", 0)], 1)).toBe(false);
  });

  it("un membre ENNEMI ne donne pas l'initiative (« allie »)", () => {
    card(141); card(47);
    expect(FS([pin(), membre("enemy")], 1)).toBe(false);
  });

  it("silencie, il perd son initiative conditionnelle", () => {
    card(141); card(47);
    expect(FS([pin({ silenced: true }), membre("ally")], 1)).toBe(false);
  });

  it("pose seul, l'instance ne porte PAS FirstStrike (l'initiative est conditionnelle, pas imprimee)", () => {
    // The JSON also has an unconditional SetPropertyData FirstStrike (the keyword
    // marker). The text makes initiative depend on another member being there, so
    // placing it alone must give nothing.
    let s = bareBoard(withDecks(scenario([], 141)));
    s = playCard(s, card(141), { x: 8, y: 2 });
    expect(posee(s, 141).properties.has("FirstStrike")).toBe(false);
    expect(withAuras(s.creatures).find((c) => c.cardId === 141)!.properties.has("FirstStrike")).toBe(false);
  });

  it("APPARITION Charge : il avance de ses 3 PM des la pose, puis reste en mal d'invocation", () => {
    let s = bareBoard(withDecks(scenario([], 141)));
    s = playCard(s, card(141), { x: 8, y: 2 });
    expect(posee(s, 141).position.x).toBe(5);   // 8 - 3 PM, charge immediate
    expect(posee(s, 141).hasAttacked).toBe(true); // toujours en mal d'invocation
    const apres = endTurn(s);
    expect(posee(apres, 141).position.x).toBe(5); // it does not advance a second time
  });
});

describe("#160 Kralamour - APPARITION : Soignez une invocation de 2 PV", () => {
  // Text: « APPARITION : Soignez une invocation de 2 PV. » No camp qualifier -> any
  // creature. A heal never goes above base HP. "une invocation" excludes the Dofus.
  it("rend 2 PV a une invocation alliee blessee", () => {
    const blesse = mkCreature(50, "ally", { x: 6, y: 2 }, { currentLife: 3, baseLife: 5 });
    let s = bareBoard(scenario([blesse], 160));
    s = playCard(s, card(160), { x: 8, y: 2 });
    expect(s.pendingAction).not.toBeNull();
    s = resolvePendingAction(s, { x: 6, y: 2 });
    expect(byId(s, 50)!.currentLife).toBe(5); // 3 + 2
  });

  it("le soin plafonne aux PV de base", () => {
    const presqueSain = mkCreature(50, "ally", { x: 6, y: 2 }, { currentLife: 4, baseLife: 5 });
    let s = bareBoard(scenario([presqueSain], 160));
    s = playCard(s, card(160), { x: 8, y: 2 });
    s = resolvePendingAction(s, { x: 6, y: 2 });
    expect(byId(s, 50)!.currentLife).toBe(5); // pas 6
  });

  it("peut soigner une invocation ADVERSE (« une invocation », sans camp)", () => {
    const foe = mkCreature(50, "enemy", { x: 4, y: 2 }, { currentLife: 2, baseLife: 5 });
    let s = bareBoard(scenario([foe], 160));
    s = playCard(s, card(160), { x: 8, y: 2 });
    expect(s.pendingAction!.filter).toBe("any_creature");
    s = resolvePendingAction(s, { x: 4, y: 2 });
    expect(byId(s, 50)!.currentLife).toBe(4); // 2 + 2
  });

  it("une seule invocation soignee : la voisine reste blessee", () => {
    const a = mkCreature(50, "ally", { x: 6, y: 2 }, { currentLife: 3, baseLife: 5 });
    const b = mkCreature(51, "ally", { x: 6, y: 1 }, { currentLife: 3, baseLife: 5 });
    let s = bareBoard(scenario([a, b], 160));
    s = playCard(s, card(160), { x: 8, y: 2 });
    s = resolvePendingAction(s, { x: 6, y: 2 });
    expect(byId(s, 50)!.currentLife).toBe(5);
    expect(byId(s, 51)!.currentLife).toBe(3);
  });

  it("un Dofus n'est pas « une invocation » : il n'est pas soigne", () => {
    const blesse = mkCreature(50, "ally", { x: 6, y: 2 }, { currentLife: 3, baseLife: 5 });
    let s = bareBoard(scenario([blesse], 160));
    // The allied Dofus of row 0 is wounded so that a heal would be visible.
    s = { ...s, dofuses: s.dofuses.map((d) => (d.position.x === 9 && d.position.y === 0 ? { ...d, currentLife: 5 } : d)) };
    s = playCard(s, card(160), { x: 8, y: 2 });
    s = resolvePendingAction(s, { x: 9, y: 0 }); // clic sur le Dofus allie blesse
    expect(s.dofuses.find((d) => d.position.x === 9 && d.position.y === 0)!.currentLife).toBe(5);
  });
});

describe("#163 Larve Violette - APPARITION : Repoussez une invocation de 2 cases", () => {
  // Text: « APPARITION : Repoussez une invocation de 2 cases. » Push = send the target
  // back toward its own wall, by exactly 2 cells.
  it("repousse une invocation adverse de 2 cases vers son camp", () => {
    const foe = mkCreature(50, "enemy", { x: 4, y: 2 }, { currentLife: 5, baseLife: 5 });
    let s = bareBoard(scenario([foe], 163));
    s = playCard(s, card(163), { x: 8, y: 2 });
    expect(s.pendingAction).not.toBeNull();
    s = resolvePendingAction(s, { x: 4, y: 2 });
    expect(byId(s, 50)!.position).toEqual({ x: 2, y: 2 }); // 4 - 2, meme ligne
  });

  it("peut repousser une invocation ALLIEE (« une invocation », sans camp)", () => {
    const mate = mkCreature(50, "ally", { x: 6, y: 1 }, { currentLife: 5, baseLife: 5 });
    let s = bareBoard(scenario([mate], 163));
    s = playCard(s, card(163), { x: 8, y: 2 });
    s = resolvePendingAction(s, { x: 6, y: 1 });
    expect(byId(s, 50)!.position).toEqual({ x: 8, y: 1 }); // 6 + 2, vers le mur allie
  });

  it("s'arrete sur un obstacle : la cible ne traverse pas une autre invocation", () => {
    const foe = mkCreature(50, "enemy", { x: 4, y: 2 }, { currentLife: 5, baseLife: 5 });
    const mur = mkCreature(51, "enemy", { x: 3, y: 2 }, { currentLife: 5, baseLife: 5 });
    let s = bareBoard(scenario([foe, mur], 163));
    s = playCard(s, card(163), { x: 8, y: 2 });
    s = resolvePendingAction(s, { x: 4, y: 2 });
    expect(byId(s, 50)!.position).toEqual({ x: 4, y: 2 }); // bloquee des la 1re case
    expect(byId(s, 51)!.position).toEqual({ x: 3, y: 2 }); // l'obstacle ne bouge pas
  });

  it("poussee PARTIELLE : elle parcourt la 1re case puis bute sur l'obstacle", () => {
    // What tells "de 2 cases" apart: the obstacle is 2 cells away, so the target moves
    // back exactly 1 instead of 2.
    const foe = mkCreature(50, "enemy", { x: 4, y: 2 }, { currentLife: 5, baseLife: 5 });
    const mur = mkCreature(51, "enemy", { x: 2, y: 2 }, { currentLife: 5, baseLife: 5 });
    let s = bareBoard(scenario([foe, mur], 163));
    s = playCard(s, card(163), { x: 8, y: 2 });
    s = resolvePendingAction(s, { x: 4, y: 2 });
    expect(byId(s, 50)!.position).toEqual({ x: 3, y: 2 });
    expect(byId(s, 51)!.position).toEqual({ x: 2, y: 2 });
  });

  it("le Dofus au bout de la ligne bloque aussi la poussee", () => {
    // Target at x=1: its wall (x=0) has a Dofus, which cannot be crossed.
    const foe = mkCreature(50, "enemy", { x: 1, y: 2 }, { currentLife: 5, baseLife: 5 });
    let s = bareBoard(scenario([foe], 163));
    s = playCard(s, card(163), { x: 8, y: 2 });
    s = resolvePendingAction(s, { x: 1, y: 2 });
    expect(byId(s, 50)!.position).toEqual({ x: 1, y: 2 });
  });

  it("la poussee ne fait aucun degat (« Repoussez », rien d'autre)", () => {
    const foe = mkCreature(50, "enemy", { x: 4, y: 2 }, { currentLife: 5, baseLife: 5 });
    let s = bareBoard(scenario([foe], 163));
    s = playCard(s, card(163), { x: 8, y: 2 });
    s = resolvePendingAction(s, { x: 4, y: 2 });
    expect(byId(s, 50)!.currentLife).toBe(5);
  });
});

describe("#166 Marline - APPARITION : echangez son corps avec une invocation adverse ayant 2 AT ou moins", () => {
  // Text: « APPARITION : Echangez son corps avec une invocation adverse ayant 2 AT ou
  // moins. » Three qualifiers: the camp (adverse), the threshold (2 AT or less) and
  // what is swapped (the body: position and camp).
  const build = (foes: CreatureInstance[]) => {
    const s = bareBoard(scenario(foes, 166));
    return playCard(s, card(166), { x: 8, y: 2 });
  };
  const foe = (id: number, atk: number, x: number, y: number) =>
    mkCreature(id, "enemy", { x, y }, {
      currentAttack: atk, baseAttack: atk, printedAttack: atk,
      currentLife: 5, baseLife: 5,
    });

  it("le choix est restreint aux invocations ADVERSES de 2 AT ou moins", () => {
    const s = build([foe(50, 2, 4, 1), foe(51, 3, 4, 3)]);
    expect(s.pendingAction).not.toBeNull();
    expect(s.pendingAction!.filter).toBe("enemy_creature");
    expect(s.pendingAction!.maxAttack).toBe(2);
  });

  it("l'echange porte sur la position ET le camp", () => {
    let s = build([foe(50, 2, 4, 1)]);
    // An APPARITION with a choice keeps the creature off the board until the pick, so
    // Marline only appears after the resolution.
    s = resolvePendingAction(s, { x: 4, y: 1 });
    const marline = posee(s, 166);
    expect(marline.position).toEqual({ x: 4, y: 1 });
    expect(marline.owner).toBe("enemy");
    expect(byId(s, 50)!.position).toEqual({ x: 8, y: 2 });
    expect(byId(s, 50)!.owner).toBe("ally");
  });

  it("2 AT est bien INCLUS, 3 AT est exclu : viser la 3 AT n'echange rien", () => {
    // Both targets are on the board: only the threshold separates them.
    let s = build([foe(50, 2, 4, 1), foe(51, 3, 4, 3)]);
    s = resolvePendingAction(s, { x: 4, y: 3 }); // clic sur la 3 AT
    expect(byId(s, 51)!.position).toEqual({ x: 4, y: 3 }); // rien n'a bouge
    expect(byId(s, 51)!.owner).toBe("enemy");
    expect(s.creatures.find((c) => c.cardId === 166)?.owner ?? "ally").toBe("ally");
  });

  it("une invocation adverse a 3 AT n'est pas echangeable", () => {
    const s = build([foe(51, 3, 4, 3)]);
    // No legal target: the trigger does not even open.
    expect(s.pendingAction).toBeNull();
    const marline = posee(s, 166);
    expect(marline.position).toEqual({ x: 8, y: 2 });
    expect(marline.owner).toBe("ally");
    expect(byId(s, 51)!.position).toEqual({ x: 4, y: 3 });
    expect(byId(s, 51)!.owner).toBe("enemy");
  });

  it("une invocation ALLIEE de 2 AT n'est pas une cible (« adverse »)", () => {
    let s = bareBoard(scenario([mkCreature(52, "ally", { x: 6, y: 1 }, {
      currentAttack: 2, baseAttack: 2, currentLife: 5, baseLife: 5,
    })], 166));
    s = playCard(s, card(166), { x: 8, y: 2 });
    expect(s.pendingAction).toBeNull(); // pas d'adverse -> pas de pick
    const marline = posee(s, 166);
    expect(marline.position).toEqual({ x: 8, y: 2 });
    expect(byId(s, 52)!.position).toEqual({ x: 6, y: 1 });
  });
});

