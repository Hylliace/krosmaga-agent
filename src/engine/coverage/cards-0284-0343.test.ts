// Coverage for cards that are wired in the engine but were not used in any test.
// Cards: #284 #293 #311 #312 #315 #322 #324 #328 #329 #332 #335 #343.
//
// Each assertion comes from the card's text, never from what the engine does. When
// the text and the engine disagree, the test is not bent to match the engine.
//
// Card with no test here, and why:
//  - #343 Piege Sournois ("Inflige 3 si vous avez au moins 3 cartes dans votre
//    defausse"): the text and the engine disagree. The discard condition exists
//    nowhere in the data (no `requireCondition` on the DamageData, although the
//    conditionMet/discardAtLeast mechanism exists and is used by Baron Sramedi
//    #243), so the spell would deal its 3 damage even with an empty discard. And its
//    castTarget (EmptyAlliedCells) clashes with validateSpellTarget, which requires a
//    creature as soon as an effect is a DamageData: the card cannot be played on the
//    empty cell it declares and can be played on any creature. No test written: it
//    would lock in the current behaviour.
import { describe, it, expect } from "vitest";
import { card, mkCreature, scenario, byId } from "../testkit";
import { playCard, canPlayCard, endTurn, runTrigger, resolvePendingAction, resolveDeathsAndWin } from "../rules";
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

// The ground objects placed by default (prisms) get in the way of the end-of-turn
// moves and of pushes, so the board is cleared.
const bareBoard = (s: GameState): GameState => ({ ...s, prisms: [], seeds: [], butins: [] });

// Empty hand: the draw tests count cards, and a pre-filled hand would skew the count.
const emptyHand = (s: GameState): GameState => ({
  ...s,
  players: { ...s.players, ally: { ...s.players.ally, hand: [], handCostMods: [] } },
});

// Give the hand to the opponent with `cardId` playable (used by the "une invocation
// adverse entre en jeu" tests).
const enemyPlays = (s: GameState, cardId: number): GameState => ({
  ...bareBoard(s),
  activeSide: "enemy",
  players: {
    ...s.players,
    enemy: { ...s.players.enemy, hand: [cardId], handCostMods: [0], ap: 20, maxAp: 20 },
  },
});

describe("#284 Mulou - COUP DE GRACE : se transforme en Mulou Alpha", () => {
  // Text: « COUP DE GRACE : Se transforme en Mulou Alpha. »
  // COUP DE GRACE = it has to kill. Two qualifiers: the transformation fires on a
  // lethal hit (not on any hit), and the new form is the Mulou Alpha #813 (token stats).
  const mulou = () =>
    mkCreature(1, "ally", { x: 5, y: 0 }, {
      cardId: 284, triggers: card(284).triggers ?? [],
      currentAttack: 4, baseAttack: 4, currentLife: 4, baseLife: 4,
      baseMovement: 3, movementLeft: 3, hasAttacked: false,
    });

  it("tuer en melee le transforme en Mulou Alpha #813, avec les stats du Mulou Alpha", () => {
    card(813);
    const foe = mkCreature(2, "enemy", { x: 4, y: 0 }, {
      currentAttack: 0, baseAttack: 0, currentLife: 1, baseLife: 1,
    });
    const s = endTurn(bareBoard(withDecks(scenario([mulou(), foe]))));
    expect(byId(s, 2)).toBeUndefined();                          // la cible est bien morte
    expect(byId(s, 1)!.cardId).toBe(813);                        // « se transforme en Mulou Alpha »
    expect(byId(s, 1)!.currentAttack).toBe(card(813).attack);    // 5 AT, stats du Mulou Alpha
    expect(byId(s, 1)!.baseLife).toBe(card(813).life);           // 5 HP
    // The Mulou #284 is 4 AT / 4 HP: the transformation does change the stats.
    expect(card(813).attack).not.toBe(card(284).attack);
    expect(byId(s, 1)!.owner).toBe("ally");                      // asOwner "keep": the camp does not change
  });

  it("frapper SANS tuer ne transforme pas (le COUP DE GRACE exige un mort)", () => {
    const foe = mkCreature(2, "enemy", { x: 4, y: 0 }, {
      currentAttack: 0, baseAttack: 0, currentLife: 9, baseLife: 9,
    });
    const s = endTurn(bareBoard(withDecks(scenario([mulou(), foe]))));
    expect(byId(s, 2)!.currentLife).toBe(5);  // a bien encaisse les 4 AT
    expect(byId(s, 1)!.cardId).toBe(284);     // still a Mulou: no transformation
    expect(byId(s, 1)!.currentAttack).toBe(4);
  });
});

describe("#293 Chef Grouilleux - CHEF : +1 PM a vos autres invocations", () => {
  // Text: « CHEF : +1 PM a vos AUTRES invocations. »
  // Three qualifiers: no family filter ("vos invocations", not "vos Grouilleux"), the
  // camp ("vos"), and itself excluded ("autres"). And it is +1 PM only: no AT given.
  const build = () => {
    card(293); card(453);
    // #453 Tofu : AT 1, PV 2, PM 5. Allie d'une AUTRE famille que Grouilleux.
    const allie = mkCreature(60, "ally", { x: 6, y: 1 }, {
      cardId: 453, currentAttack: 1, baseAttack: 1, printedAttack: 1,
      baseMovement: 5, printedMovement: 5, movementLeft: 5, currentLife: 2, baseLife: 2,
    });
    const ennemi = mkCreature(61, "enemy", { x: 3, y: 1 }, {
      cardId: 453, currentAttack: 1, baseAttack: 1, printedAttack: 1,
      baseMovement: 5, printedMovement: 5, movementLeft: 5, currentLife: 2, baseLife: 2,
    });
    return playCard(bareBoard(scenario([allie, ennemi], 293)), card(293), { x: 8, y: 2 });
  };

  it("un allie d'une AUTRE famille gagne +1 PM (aucun filtre de famille)", () => {
    const s = build();
    expect(byId(s, 60)!.baseMovement).toBe(6); // 5 imprime + 1 d'aura
  });

  it("il ne donne QUE des PM : aucune AT", () => {
    const s = build();
    expect(byId(s, 60)!.currentAttack).toBe(1); // AT imprimee inchangee
  });

  it("une invocation ENNEMIE ne recoit rien (« vos » invocations)", () => {
    const s = build();
    expect(byId(s, 61)!.baseMovement).toBe(5);
  });

  it("le Chef ne se buffe pas lui-meme (« vos AUTRES invocations »)", () => {
    const s = build();
    const chef = s.creatures.find((c) => c.cardId === 293)!;
    expect(chef.baseMovement).toBe(card(293).movement);
  });
});

describe("#311 Uppercut - inflige 1 et repousse de 7 cases", () => {
  // Text: « Inflige 1 et repousse de 7 cases. » castTarget AnySummon: the text says
  // "une invocation", with no camp limit. Both effects must land on the same target in
  // a single cast.
  //
  // Limit of this test: the battlefield has 8 playable columns (x=1..8, columns 0 and
  // 9 are the Dofus walls). A push of 7 is the whole width of the board: starting from
  // the opposite wall, the target always ends up against its own wall. No setup can
  // tell "7" from "8 or more", so the test checks that the push crosses the whole board
  // (>= 7) and stops before the wall column, which is the most that can be observed.
  it("une invocation ADVERSE prend 1 degat ET recule de 7 cases", () => {
    card(311);
    const foe = mkCreature(60, "enemy", { x: 8, y: 2 }, { currentLife: 5, baseLife: 5 });
    const s = playCard(bareBoard(scenario([foe], 311)), card(311), { x: 8, y: 2 });
    expect(byId(s, 60)!.currentLife).toBe(4);   // 5 - 1: the damage is 1, no more
    expect(byId(s, 60)!.position.x).toBe(1);    // 8 -> 1 : 7 cases vers son propre mur
    expect(byId(s, 60)!.position.y).toBe(2);    // the push stays on the row
  });

  it("s'applique aussi a une invocation ALLIEE (« une invocation », sans camp)", () => {
    card(311);
    const ally = mkCreature(61, "ally", { x: 1, y: 3 }, { currentLife: 5, baseLife: 5 });
    const s = playCard(bareBoard(scenario([ally], 311)), card(311), { x: 1, y: 3 });
    expect(byId(s, 61)!.currentLife).toBe(4);
    expect(byId(s, 61)!.position.x).toBe(8);    // 1 -> 8 : 7 cases vers le mur allie
  });

  it("« une invocation » : une case VIDE n'est pas une cible legale", () => {
    card(311);
    const foe = mkCreature(60, "enemy", { x: 3, y: 1 }, { currentLife: 5, baseLife: 5 });
    const s = bareBoard(scenario([foe], 311));
    expect(canPlayCard(s, card(311), { x: 5, y: 4 })).toBe("Aucune cible sur cette case.");
    expect(canPlayCard(s, card(311), { x: 3, y: 1 })).toBeNull(); // control: on the creature, it can be played
  });
});

describe("#312 Fleche de Recul - repousse une invocation adverse de 5 cases", () => {
  // Text: « Repousse une invocation adverse de 5 cases. » Two qualifiers: the exact
  // distance (5) and the camp ("adverse", castTarget OpponentSummon). And it is a plain
  // push: no damage is mentioned.
  it("recule l'invocation adverse d'EXACTEMENT 5 cases, sans lui infliger de degat", () => {
    card(312);
    // Starting at x=7: the target ends at x=2 and there is still one free cell (x=1)
    // before its wall. A push of 6 or more would have sent it to x=1, so the setup does
    // tell "5" from "more than 5".
    const foe = mkCreature(60, "enemy", { x: 7, y: 2 }, { currentLife: 5, baseLife: 5 });
    const s = playCard(bareBoard(scenario([foe], 312)), card(312), { x: 7, y: 2 });
    expect(byId(s, 60)!.position.x).toBe(2);   // 7 -> 2 : exactement 5 cases, pas 6
    expect(byId(s, 60)!.position.y).toBe(2);   // la ligne est conservee
    expect(byId(s, 60)!.currentLife).toBe(5);  // aucun degat
  });

  it("refuse de cibler une invocation ALLIEE (« adverse »)", () => {
    card(312);
    const ally = mkCreature(61, "ally", { x: 6, y: 2 }, { currentLife: 5, baseLife: 5 });
    const foe = mkCreature(62, "enemy", { x: 3, y: 2 }, { currentLife: 5, baseLife: 5 });
    const s = bareBoard(scenario([ally, foe], 312));
    expect(canPlayCard(s, card(312), { x: 6, y: 2 })).toBe("Cette invocation n'est pas ennemie.");
    expect(canPlayCard(s, card(312), { x: 3, y: 2 })).toBeNull(); // controle : l'ennemie est bien ciblable
  });
});

describe("#315 Chef de Guerre Bouftou - CHEF : +1 AT et +1 PM a vos autres Bouftous", () => {
  // Text: « CHEF : +1 AT et +1 PM a vos AUTRES Bouftous. »
  // The "Bouftou" family has the internal name "Gobbal" in the data (Boufton Blanc,
  // Bouftou Noir, Roi des Bouftous... are all Gobbal).
  // Qualifiers: family, camp, itself excluded.
  const build = () => {
    card(315); card(40); card(453);
    // #40 Bouftou Noir : famille Gobbal, AT 2, PV 3, PM 3, aucun effet propre.
    const bouftouAllie = mkCreature(60, "ally", { x: 6, y: 1 }, {
      cardId: 40, currentAttack: 2, baseAttack: 2, printedAttack: 2,
      baseMovement: 3, printedMovement: 3, movementLeft: 3, currentLife: 3, baseLife: 3,
    });
    // #453 Tofu: an ally but not a Bouftou.
    const nonBouftou = mkCreature(61, "ally", { x: 6, y: 3 }, {
      cardId: 453, currentAttack: 1, baseAttack: 1, printedAttack: 1,
      baseMovement: 5, printedMovement: 5, movementLeft: 5, currentLife: 2, baseLife: 2,
    });
    const bouftouEnnemi = mkCreature(62, "enemy", { x: 3, y: 1 }, {
      cardId: 40, currentAttack: 2, baseAttack: 2, printedAttack: 2,
      baseMovement: 3, printedMovement: 3, movementLeft: 3, currentLife: 3, baseLife: 3,
    });
    return playCard(
      bareBoard(scenario([bouftouAllie, nonBouftou, bouftouEnnemi], 315)),
      card(315), { x: 8, y: 2 },
    );
  };

  it("la famille « Bouftou » du texte correspond bien a la famille interne Gobbal", () => {
    // The link from text to data is part of the test: if #40 changed family, the
    // assertions below would mean nothing.
    expect(card(40).families ?? []).toContain("Gobbal");
    expect(card(40).name).toContain("Bouftou");
    expect(card(453).families ?? []).not.toContain("Gobbal");
  });

  it("un Bouftou allie gagne +1 AT ET +1 PM", () => {
    const s = build();
    expect(byId(s, 60)!.currentAttack).toBe(3); // 2 + 1
    expect(byId(s, 60)!.baseMovement).toBe(4);  // 3 + 1
  });

  it("un allie qui n'est PAS un Bouftou ne recoit rien", () => {
    const s = build();
    expect(byId(s, 61)!.currentAttack).toBe(1);
    expect(byId(s, 61)!.baseMovement).toBe(5);
  });

  it("un Bouftou ENNEMI ne recoit rien (« vos » Bouftous)", () => {
    const s = build();
    expect(byId(s, 62)!.currentAttack).toBe(2);
    expect(byId(s, 62)!.baseMovement).toBe(3);
  });

  it("le Chef de Guerre ne se buffe pas lui-meme (« vos AUTRES Bouftous »)", () => {
    const s = build();
    const chef = s.creatures.find((c) => c.cardId === 315)!;
    expect(chef.currentAttack).toBe(card(315).attack);
    expect(chef.baseMovement).toBe(card(315).movement);
  });
});

describe("#322 Baraklud - APPARITION : soignez une invocation de 3 PV", () => {
  // Text: « APPARITION : Soignez une invocation de 3 PV. »
  // Qualifiers: the exact amount (3), the implicit cap of a heal (no more than base
  // HP), "une" invocation (only one, the chosen one), and "une invocation" with no camp
  // limit, so an enemy creature is a legal target.
  const play = (others: CreatureInstance[]) =>
    playCard(bareBoard(scenario(others, 322)), card(322), { x: 8, y: 2 });

  it("soigne la cible choisie de 3 PV, et ELLE SEULE", () => {
    card(322);
    const blesse = mkCreature(60, "ally", { x: 6, y: 1 }, { currentLife: 2, baseLife: 7 });
    // Control: another wounded ally that must get nothing ("une invocation", not "vos
    // invocations").
    const temoin = mkCreature(61, "ally", { x: 6, y: 3 }, { currentLife: 2, baseLife: 7 });
    let s = play([blesse, temoin]);
    expect(s.pendingAction).not.toBeNull();           // l'APPARITION ouvre un choix de cible
    s = resolvePendingAction(s, { x: 6, y: 1 });
    expect(byId(s, 60)!.currentLife).toBe(5);         // 2 + 3
    expect(byId(s, 61)!.currentLife).toBe(2);         // the control is not healed
  });

  it("ne surSOIGNE pas au-dela des PV de base", () => {
    card(322);
    const presqueSain = mkCreature(60, "ally", { x: 6, y: 1 }, { currentLife: 6, baseLife: 7 });
    let s = play([presqueSain]);
    s = resolvePendingAction(s, { x: 6, y: 1 });
    expect(byId(s, 60)!.currentLife).toBe(7);         // plafonne a 7, pas 9
  });

  it("« une invocation » : une invocation ADVERSE est une cible legale", () => {
    card(322);
    const ennemiBlesse = mkCreature(60, "enemy", { x: 3, y: 1 }, { currentLife: 2, baseLife: 7 });
    let s = play([ennemiBlesse]);
    expect(s.pendingAction).not.toBeNull();
    s = resolvePendingAction(s, { x: 3, y: 1 });
    expect(byId(s, 60)!.currentLife).toBe(5);         // 2 + 3
  });
});

describe("#324 Katar - INITIATIVE + DEBUT DU TOUR : attire la premiere invocation adverse devant lui", () => {
  // Text: « INITIATIVE / DEBUT DU TOUR : Attire la premiere invocation adverse situee
  // devant lui. »
  // Qualifiers: INITIATIVE (FirstStrike property when placed); "premiere" (the closest,
  // not all); "adverse" (an ally in front of it is not a target); "devant lui" (its row,
  // in its direction of advance, so not behind); and the text only talks about
  // pulling: no charge, so no damage (unlike Katar 1* #458, which follows with a
  // ChargeSelf).
  const katar = (pos: { x: number; y: number }) =>
    mkCreature(1, "ally", pos, {
      cardId: 324, triggers: card(324).triggers ?? [],
      properties: new Set(["FirstStrike"]),
      currentAttack: 4, baseAttack: 4, currentLife: 3, baseLife: 3,
    });

  it("INITIATIVE : la pose confere la propriete FirstStrike", () => {
    card(324);
    const s = playCard(bareBoard(scenario([], 324)), card(324), { x: 8, y: 2 });
    const k = s.creatures.find((c) => c.cardId === 324)!;
    expect(k.properties.has("FirstStrike")).toBe(true);
  });

  const board = () => {
    card(324);
    const proche = mkCreature(2, "enemy", { x: 4, y: 2 }, { currentLife: 5, baseLife: 5 });
    const loin = mkCreature(3, "enemy", { x: 2, y: 2 }, { currentLife: 5, baseLife: 5 });
    const autreLigne = mkCreature(4, "enemy", { x: 4, y: 0 }, { currentLife: 5, baseLife: 5 });
    return runTrigger(
      bareBoard(scenario([katar({ x: 7, y: 2 }), proche, loin, autreLigne])),
      "DEBUT_DE_TOUR", 1,
    );
  };

  it("attire la PREMIERE invocation adverse devant lui, collee devant Katar", () => {
    const s = board();
    expect(byId(s, 2)!.position).toEqual({ x: 6, y: 2 }); // tiree de x=4 a la case devant Katar (x=7)
  });

  it("n'attire QUE la premiere : la suivante de la ligne et celle d'une autre ligne ne bougent pas", () => {
    const s = board();
    expect(byId(s, 3)!.position).toEqual({ x: 2, y: 2 });
    expect(byId(s, 4)!.position).toEqual({ x: 4, y: 0 });
  });

  it("attire seulement : la cible ne subit aucun degat (le texte ne parle pas de charge)", () => {
    const s = board();
    expect(byId(s, 2)!.currentLife).toBe(5);
    expect(byId(s, 1)!.currentLife).toBe(3);
  });

  it("« adverse » : une invocation ALLIEE devant lui n'est pas attiree, c'est l'ennemie derriere elle qui l'est", () => {
    card(324);
    // Katar at x=7, an ally at x=5 (in front of it), an enemy at x=3 (further). Without
    // the camp filter, the ally at x=5 would be the "premiere devant lui" and would be
    // pulled to x=6. With the filter, the enemy is pulled, and it stops behind the ally
    // that blocks its way (x=4).
    const allieDevant = mkCreature(5, "ally", { x: 5, y: 2 }, { currentLife: 5, baseLife: 5 });
    const ennemieDerriere = mkCreature(6, "enemy", { x: 3, y: 2 }, { currentLife: 5, baseLife: 5 });
    const s = runTrigger(
      bareBoard(scenario([katar({ x: 7, y: 2 }), allieDevant, ennemieDerriere])),
      "DEBUT_DE_TOUR", 1,
    );
    expect(byId(s, 5)!.position).toEqual({ x: 5, y: 2 }); // l'allie n'a pas bouge
    expect(byId(s, 6)!.position).toEqual({ x: 4, y: 2 }); // l'ennemie a bien ete tiree
  });

  it("« devant lui » : une invocation adverse situee DERRIERE Katar n'est pas attiree", () => {
    card(324);
    // Katar at x=5. "Devant lui" for an ally = lower x. The enemy at x=7 is behind, so it
    // must not move. The one at x=3 is in front, so it is pulled (the test is not empty).
    const derriere = mkCreature(7, "enemy", { x: 7, y: 2 }, { currentLife: 5, baseLife: 5 });
    const devant = mkCreature(8, "enemy", { x: 3, y: 2 }, { currentLife: 5, baseLife: 5 });
    const s = runTrigger(
      bareBoard(scenario([katar({ x: 5, y: 2 }), derriere, devant])),
      "DEBUT_DE_TOUR", 1,
    );
    expect(byId(s, 7)!.position).toEqual({ x: 7, y: 2 }); // derriere : immobile
    expect(byId(s, 8)!.position).toEqual({ x: 4, y: 2 }); // devant : tiree contre Katar
  });
});

describe("#328 Corum - MORT : invoque une Momie", () => {
  // Text: « MORT : Invoque une Momie. » (token #360, 2 HP / 2 AT).
  // "near" placement on the death path = the cell freed by the dead creature.
  it("sa mort pose UNE Momie #360 alliee sur sa case", () => {
    card(328); card(360);
    const sc = bareBoard(scenario([]));
    const mourant = mkCreature(1, "ally", { x: 6, y: 2 }, {
      cardId: 328, currentLife: 0, baseLife: 4, triggers: card(328).triggers ?? [],
    });
    const s = resolveDeathsAndWin(sc, [mourant], sc.dofuses, [], new Set());
    const momies = s.creatures.filter((c) => c.cardId === 360 && c.currentLife > 0);
    expect(momies.length).toBe(1);                          // « une » Momie
    expect(momies[0].owner).toBe("ally");                   // dans VOTRE camp
    expect(momies[0].position).toEqual({ x: 6, y: 2 });     // on the dead creature's cell
    expect(momies[0].baseLife).toBe(card(360).life);        // stats du jeton Momie
    expect(momies[0].currentAttack).toBe(card(360).attack);
  });

  it("en partie reelle : tue en melee, il laisse la Momie sur sa case", () => {
    card(328); card(360);
    // Corum has summoning sickness (PM 0 + hasAttacked): it does nothing during the ally
    // advance. The enemy comes to kill it on the next turn, hence the two endTurn.
    const corum = mkCreature(1, "ally", { x: 6, y: 2 }, {
      cardId: 328, triggers: card(328).triggers ?? [],
      currentLife: 2, baseLife: 4, currentAttack: 6, baseAttack: 6,
      movementLeft: 0, hasAttacked: true,
    });
    const tueur = mkCreature(2, "enemy", { x: 5, y: 2 }, {
      currentAttack: 3, baseAttack: 3, currentLife: 9, baseLife: 9,
      baseMovement: 3, movementLeft: 3,
    });
    const s = endTurn(endTurn(bareBoard(withDecks(scenario([corum, tueur])))));
    expect(byId(s, 1)).toBeUndefined();                     // Corum est mort du coup
    const momies = s.creatures.filter((c) => c.cardId === 360 && c.currentLife > 0);
    expect(momies.length).toBe(1);
    expect(momies[0].owner).toBe("ally");
    expect(momies[0].position).toEqual({ x: 6, y: 2 });     // la Momie occupe la case liberee
  });
});

describe("#329 Eksa Soth - PORTEE 3 + COUP DE GRACE : piochez 1 carte", () => {
  // Text: « PORTEE : 3 / COUP DE GRACE : Piochez 1 carte. »
  // Qualifiers: the range is given when placed; the draw only fires when Eksa Soth
  // kills (COUP DE GRACE), not when it only wounds.
  it("PORTEE : la pose confere range 3", () => {
    card(329);
    const s = playCard(bareBoard(scenario([], 329)), card(329), { x: 8, y: 2 });
    const eksa = s.creatures.find((c) => c.cardId === 329)!;
    expect(eksa.range).toBe(3);
  });

  const tir = (pvCible: number) => {
    card(329);
    const eksa = mkCreature(1, "ally", { x: 6, y: 2 }, {
      cardId: 329, triggers: card(329).triggers ?? [], range: 3,
      currentAttack: 3, baseAttack: 3, currentLife: 4, baseLife: 4,
      baseMovement: 3, movementLeft: 3, hasAttacked: false,
    });
    const cible = mkCreature(2, "enemy", { x: 3, y: 2 }, {
      currentLife: pvCible, baseLife: pvCible, currentAttack: 0, baseAttack: 0,
    });
    return endTurn(emptyHand(bareBoard(withDecks(scenario([eksa, cible])))));
  };

  it("tuer a distance fait piocher exactement 1 carte", () => {
    const s = tir(1);
    expect(byId(s, 2)).toBeUndefined();          // the target died from the shot
    expect(s.players.ally.hand).toEqual([16]);   // 1 carte piochee
    expect(s.players.ally.deck.length).toBe(2);  // 3 - 1
  });

  it("blesser sans tuer ne fait rien piocher", () => {
    const s = tir(9);
    expect(byId(s, 2)!.currentLife).toBe(6);     // 9 - 3 : touchee mais vivante
    expect(s.players.ally.hand).toEqual([]);     // aucune pioche
    expect(s.players.ally.deck.length).toBe(3);
  });
});

describe("#332 Truchideur - change de ligne quand une invocation ADVERSE entre en jeu", () => {
  // Text: « Change de ligne quand une invocation adverse entre en jeu. »
  // The generic mechanism (adjacent row only, full column, pickup on the landing cell)
  // is already covered by the Truche #37 in spells.test.ts. What is checked here is
  // specific to this card: its wiring, and above all the "adverse" qualifier, which no
  // Truche test covered. #40 Bouftou Noir is the one entering: no effect, no trigger,
  // so only the entering into play is measured.
  const truchideur = () =>
    mkCreature(700, "ally", { x: 6, y: 2 }, {
      cardId: 332, triggers: card(332).triggers ?? [],
      currentLife: 2, baseLife: 2, currentAttack: 3, baseAttack: 3,
    });
  // y-1 is taken: the only free adjacent row of the column is y+1.
  const bloqueur = () => mkCreature(701, "ally", { x: 6, y: 1 }, { cardId: 9999 });

  it("une invocation ADVERSE qui entre en jeu le fait changer de ligne", () => {
    card(332); card(40);
    const s0 = enemyPlays(scenario([truchideur(), bloqueur()]), 40);
    const s = playCard(s0, card(40), { x: 1, y: 0 });
    expect(byId(s, 700)!.position).toEqual({ x: 6, y: 3 }); // esquive vers la seule ligne adjacente libre
  });

  it("une invocation ALLIEE qui entre en jeu ne le fait PAS bouger (« adverse »)", () => {
    card(332); card(40);
    const sc = bareBoard(scenario([truchideur(), bloqueur()], 40));
    const s = playCard(sc, card(40), { x: 8, y: 0 });
    expect(byId(s, 700)!.position).toEqual({ x: 6, y: 2 }); // il reste sur place
  });
});

describe("#335 Lebolas - PORTEE : 3", () => {
  // Text: « PORTEE : 3 » and nothing else (its only effect is ShooterRangeData 1-3).
  // The range system is covered by spells.test.ts "Portee (range system)". What is
  // checked here is specific to this card: that placing it gives a range of 3, so it
  // shoots at 3 cells instead of walking.
  it("la pose confere range 3", () => {
    card(335);
    const s = playCard(bareBoard(scenario([], 335)), card(335), { x: 8, y: 2 });
    const lebolas = s.creatures.find((c) => c.cardId === 335)!;
    expect(lebolas.range).toBe(3);
  });

  it("tire sur une cible a 3 cases sans se deplacer", () => {
    card(335);
    const lebolas = mkCreature(1, "ally", { x: 6, y: 2 }, {
      cardId: 335, range: 3,
      currentAttack: 3, baseAttack: 3, currentLife: 2, baseLife: 2,
      baseMovement: 3, movementLeft: 3, hasAttacked: false,
    });
    const cible = mkCreature(2, "enemy", { x: 3, y: 2 }, {
      currentLife: 9, baseLife: 9, currentAttack: 4, baseAttack: 4,
    });
    const s = endTurn(bareBoard(withDecks(scenario([lebolas, cible]))));
    expect(byId(s, 2)!.currentLife).toBe(6);              // 9 - 3 : touchee a 3 cases
    expect(byId(s, 1)!.position).toEqual({ x: 6, y: 2 }); // le tireur n'avance pas
    expect(byId(s, 1)!.currentLife).toBe(2);              // et ne prend aucune riposte
  });
});
