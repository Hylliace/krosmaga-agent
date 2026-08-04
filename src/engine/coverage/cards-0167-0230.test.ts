// Coverage for cards that are wired in the engine but were not used in any test:
// #167 #169 #173 #179 #185 #192 #199 #202 #206 #208 #221 #230
//
// Each assertion comes from the card's text, never from what the engine does. When
// the text and the engine disagree, the test is not bent to match the engine.
import { describe, it, expect } from "vitest";
import { card, mkCreature, scenario, byId } from "../testkit";
import { playCard, canPlayCard, endTurn, resolvePendingAction, resolveDeathsAndWin } from "../rules";
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
// moves and of the placement cells, so the board is cleared.
const bareBoard = (s: GameState): GameState => ({ ...s, prisms: [], seeds: [], butins: [] });

describe("#167 Tofukaz - gagne +2 AT et +1 PM quand un de VOS TOFUS meurt", () => {
  // Text: « Gagne +2 AT et +1 PM quand un de vos Tofus meurt. »
  // Three qualifiers: the family (Tofu), the camp (vos), and the exact gain.
  // Printed Tofukaz: AT 1 / HP 3 / PM 3.
  const tofukaz = () =>
    mkCreature(1, "ally", { x: 6, y: 2 }, {
      cardId: 167, triggers: card(167).triggers ?? [],
      currentAttack: 1, baseAttack: 1, printedAttack: 1,
      currentLife: 3, baseLife: 3, printedLife: 3,
      baseMovement: 3, printedMovement: 3, movementLeft: 3,
    });

  const kill = (victim: ReturnType<typeof mkCreature>) => {
    const t = tofukaz();
    const base = scenario([t, victim]);
    const creatures = base.creatures.map((c) => (c.instanceId === victim.instanceId ? { ...c, currentLife: 0 } : c));
    return resolveDeathsAndWin(base, creatures, base.dofuses, [...base.log], new Set());
  };

  it("la mort d'un TOFU ALLIE donne exactement +2 AT et +1 PM", () => {
    card(167); card(453);
    // #453 Tofu : famille Tofu, allie.
    const s = kill(mkCreature(2, "ally", { x: 5, y: 1 }, { cardId: 453 }));
    expect(byId(s, 1)!.currentAttack).toBe(3);  // 1 + 2
    expect(byId(s, 1)!.baseMovement).toBe(4);   // 3 + 1
  });

  it("la mort d'un allie d'une AUTRE famille ne donne rien (filtre de famille)", () => {
    card(167); card(21);
    // #21 Wabbit: a real card of the real "Wabbit" family; the filter has to reject it
    // on the family, not because the card cannot be found.
    const s = kill(mkCreature(2, "ally", { x: 5, y: 1 }, { cardId: 21 }));
    expect(card(21).families).toEqual(["Wabbit"]); // safety check: the victim does have a family, and it is not Tofu
    expect(byId(s, 1)!.currentAttack).toBe(1);
    expect(byId(s, 1)!.baseMovement).toBe(3);
  });

  it("la mort d'un TOFU ENNEMI ne donne rien (« VOS Tofus »)", () => {
    card(167); card(453);
    const s = kill(mkCreature(2, "enemy", { x: 3, y: 1 }, { cardId: 453 }));
    expect(byId(s, 1)!.currentAttack).toBe(1);
    expect(byId(s, 1)!.baseMovement).toBe(3);
  });

  it("deux Tofus allies qui meurent : le gain se cumule (+4 AT / +2 PM)", () => {
    card(167); card(453);
    const t = tofukaz();
    const v1 = mkCreature(2, "ally", { x: 5, y: 1 }, { cardId: 453 });
    const v2 = mkCreature(3, "ally", { x: 5, y: 3 }, { cardId: 453 });
    const base = scenario([t, v1, v2]);
    const creatures = base.creatures.map((c) => (c.instanceId !== 1 ? { ...c, currentLife: 0 } : c));
    const s = resolveDeathsAndWin(base, creatures, base.dofuses, [...base.log], new Set());
    expect(byId(s, 1)!.currentAttack).toBe(5);  // 1 + 2 + 2
    expect(byId(s, 1)!.baseMovement).toBe(5);   // 3 + 1 + 1
  });

  it("le gain part aussi quand le Tofu meurt dans un vrai combat de fin de tour", () => {
    // The tests above push the death straight into resolveDeathsAndWin. This one goes
    // through the full path: end-of-turn advance, melee, death.
    card(167); card(453);
    // Tofukaz does not move (movementLeft 0) on an empty lane: it does not fight.
    const t = mkCreature(1, "ally", { x: 7, y: 4 }, {
      cardId: 167, triggers: card(167).triggers ?? [],
      currentAttack: 1, baseAttack: 1, printedAttack: 1,
      currentLife: 3, baseLife: 3, baseMovement: 3, printedMovement: 3, movementLeft: 0,
    });
    // Allied Tofu (AT 1 / HP 2) rushing at an enemy with AT 3: it hits and dies.
    const tofu = mkCreature(2, "ally", { x: 6, y: 2 }, {
      cardId: 453, currentAttack: 1, baseAttack: 1, currentLife: 2, baseLife: 2,
      baseMovement: 5, movementLeft: 5, hasAttacked: false,
    });
    const foe = mkCreature(3, "enemy", { x: 5, y: 2 }, {
      currentAttack: 3, baseAttack: 3, currentLife: 5, baseLife: 5,
    });
    const s = endTurn(bareBoard(withDecks(scenario([t, tofu, foe]))));
    expect(byId(s, 2)).toBeUndefined();          // the Tofu did die in combat
    expect(byId(s, 1)!.currentAttack).toBe(3);   // 1 + 2
    expect(byId(s, 1)!.baseMovement).toBe(4);    // 3 + 1
  });
});

describe("#185 Seduction - prenez le controle d'une invocation adverse", () => {
  // Text: « Prenez le contrôle d'une invocation adverse. » castTarget OpponentSummon,
  // cost 12 AP. The card is the twin of #111 Controle Mental (same TakeControl effect)
  // but it was used in no test, so here we check on card #185 itself the camp switch,
  // the refusal to target your own camp, and the cost actually paid.
  const withAp = (s: GameState, ap: number): GameState => ({
    ...s,
    players: { ...s.players, ally: { ...s.players.ally, ap, maxAp: ap } },
  });

  it("l'invocation adverse ciblee passe dans VOTRE camp", () => {
    card(185);
    const foe = mkCreature(1, "enemy", { x: 3, y: 2 }, {
      currentAttack: 4, baseAttack: 4, currentLife: 5, baseLife: 5,
      baseMovement: 2, movementLeft: 0, hasAttacked: false,
    });
    let s = withAp(bareBoard(scenario([foe], 185)), 20);
    s = playCard(s, card(185), { x: 3, y: 2 });
    expect(byId(s, 1)!.owner).toBe("ally");
    expect(s.players.ally.ap).toBe(8); // 20 - 12 : le cout imprime de #185 est bien 12
  });

  it("la creature saisie se retourne : elle avance contre son ancien camp des CE tour", () => {
    card(185);
    const foe = mkCreature(1, "enemy", { x: 3, y: 2 }, {
      currentAttack: 4, baseAttack: 4, currentLife: 5, baseLife: 5,
      baseMovement: 3, movementLeft: 0, hasAttacked: false,
    });
    let s = withAp(bareBoard(withDecks(scenario([foe], 185))), 20);
    s = playCard(s, card(185), { x: 3, y: 2 });
    expect(byId(s, 1)!.position.x).toBe(3); // l'avance n'a pas encore eu lieu
    s = endTurn(s);
    expect(byId(s, 1)!.position.x).toBeLessThan(3); // elle marche vers x=0, l'ancien camp
  });

  it("ne peut pas cibler une invocation de VOTRE camp (« adverse »)", () => {
    card(185);
    const mine = mkCreature(1, "ally", { x: 6, y: 2 });
    const s = withAp(bareBoard(scenario([mine], 185)), 20);
    expect(() => playCard(s, card(185), { x: 6, y: 2 })).toThrow();
  });
});

describe("#169 Mot Retablissant - confere +2 AR a VOS invocations", () => {
  // Text: « Confère +2 AR à vos invocations. » A global spell (castTarget AlliedGod):
  // every allied creature, no enemy one.
  // (The "scope allies" executor is already covered by #3 Puissance Sylvestre in
  // spells.test.ts; here we check the amount and camp specific to #169.)
  const build = () => {
    card(169);
    const a1 = mkCreature(1, "ally", { x: 6, y: 1 }, { armor: 0 });
    const a2 = mkCreature(2, "ally", { x: 7, y: 3 }, { armor: 2 });
    const foe = mkCreature(3, "enemy", { x: 3, y: 2 }, { armor: 1 });
    const s = bareBoard(scenario([a1, a2, foe], 169));
    return playCard(s, card(169), { x: 0, y: 0 });
  };

  it("chaque invocation alliee gagne +2 AR (cumul avec l'AR deja en place)", () => {
    const s = build();
    expect(byId(s, 1)!.armor).toBe(2); // 0 + 2
    expect(byId(s, 2)!.armor).toBe(4); // 2 + 2
  });

  it("les invocations ADVERSES ne recoivent rien (« VOS invocations »)", () => {
    const s = build();
    expect(byId(s, 3)!.armor).toBe(1); // inchangee
  });
});

describe("#173 Amsrad Cepaisset - bannit les 5 dernieres cartes de votre defausse pour etre invoque", () => {
  // Text: « Bannit les 5 dernières cartes parties dans votre défausse pour être
  // invoqué. » Two parts: it is a cost (cannot be played without 5 cards in the
  // discard), and the 5 most recent ones are the ones that go (the discard array has
  // the most recent at the end).
  const withDiscard = (discard: number[]) => {
    card(173);
    const s = bareBoard(scenario([], 173));
    return { ...s, players: { ...s.players, ally: { ...s.players.ally, discard } } };
  };

  it("injouable avec seulement 4 cartes en defausse", () => {
    const s = withDiscard([16, 47, 70, 135]);
    expect(canPlayCard(s, card(173), { x: 8, y: 2 })).not.toBeNull();
  });

  it("jouable des que la defausse contient 5 cartes", () => {
    const s = withDiscard([16, 47, 70, 135, 331]);
    expect(canPlayCard(s, card(173), { x: 8, y: 2 })).toBeNull();
  });

  it("a la pose : les 5 cartes les PLUS RECENTES sont bannies, la plus ancienne reste en defausse", () => {
    // Discard from oldest to most recent: [16, 47, 70, 135, 331, 360].
    // The last 5 = 47, 70, 135, 331, 360. 16 (the oldest) stays.
    let s = withDiscard([16, 47, 70, 135, 331, 360]);
    s = playCard(s, card(173), { x: 8, y: 2 });
    expect(s.players.ally.discard).toEqual([16]);
    expect(s.players.ally.banished).toEqual([47, 70, 135, 331, 360]);
    // et l'invocation arrive bien (AT 4 / PV 7 / PM 3)
    const amsrad = s.creatures.find((c) => c.cardId === 173)!;
    expect(amsrad.position).toEqual({ x: 8, y: 2 });
    expect(amsrad.currentAttack).toBe(4);
    expect(amsrad.currentLife).toBe(7);
  });

  it("le banni s'AJOUTE au cout en PA (« pour etre invoque » n'est pas un cout alternatif)", () => {
    // Discard of exactly 5: it is fully emptied, and the 3 AP are taken as usual. If
    // banishing replaced the cost, the AP would stay at 10.
    let s = withDiscard([16, 47, 70, 135, 331]);
    expect(s.players.ally.ap).toBe(10);
    s = playCard(s, card(173), { x: 8, y: 2 });
    expect(s.players.ally.discard).toEqual([]);
    expect(s.players.ally.banished).toEqual([16, 47, 70, 135, 331]);
    expect(s.players.ally.ap).toBe(7); // 10 - 3
  });
});

describe("#179 Bouftou du Printemps - DEBUT DU TOUR : gagne +1 AR", () => {
  // Text: « DÉBUT DU TOUR : Gagne +1 AR. » The trigger is the start of your own turn: it
  // does not fire at the start of the enemy turn, and it adds up from turn to turn.
  const setup = () => {
    card(179);
    const bouftou = mkCreature(1, "ally", { x: 8, y: 2 }, {
      cardId: 179, triggers: card(179).triggers ?? [],
      currentAttack: 6, baseAttack: 6, currentLife: 3, baseLife: 3,
      baseMovement: 2, movementLeft: 0, armor: 0,
    });
    return bareBoard(withDecks(scenario([bouftou])));
  };

  it("le debut du tour ADVERSE ne donne rien", () => {
    const s = endTurn(setup()); // fin du tour allie -> debut du tour ennemi
    expect(byId(s, 1)!.armor).toBe(0);
  });

  it("+1 AR au debut de chacun de VOS tours (cumulatif)", () => {
    let s = endTurn(setup()); // -> debut tour ennemi
    s = endTurn(s);           // -> debut tour allie n°1
    expect(byId(s, 1)!.armor).toBe(1);
    s = endTurn(s);           // -> debut tour ennemi
    s = endTurn(s);           // -> debut tour allie n°2
    expect(byId(s, 1)!.armor).toBe(2);
  });

  it("un Bouftou ADVERSE se declenche au debut du tour ADVERSE, pas au votre", () => {
    // "DEBUT DU TOUR" = its owner's turn, whatever the camp.
    card(179);
    const mk = (id: number, owner: "ally" | "enemy", x: number) =>
      mkCreature(id, owner, { x, y: 2 }, {
        cardId: 179, triggers: card(179).triggers ?? [],
        currentAttack: 6, baseAttack: 6, currentLife: 3, baseLife: 3,
        baseMovement: 2, movementLeft: 0, armor: 0,
      });
    const s = endTurn(bareBoard(withDecks(scenario([mk(1, "ally", 8), mk(2, "enemy", 1)]))));
    expect(byId(s, 2)!.armor).toBe(1); // le tour ennemi vient de commencer
    expect(byId(s, 1)!.armor).toBe(0); // l'allie attend le sien
  });
});

describe("#192 Armure Sanguine - confere +4 AR a une invocation", () => {
  // Text: « Confère +4 AR à une invocation. » No camp is given and castTarget =
  // AnySummon: allies and enemies are both legal targets.
  it("+4 AR a l'invocation alliee CIBLEE seulement, en plus de l'AR deja presente", () => {
    card(192);
    // "UNE invocation": single target. A second ally on the board is the control: if it
    // gained AR, the effect would have been applied with scope allies.
    const cible = mkCreature(1, "ally", { x: 6, y: 2 }, { armor: 1 });
    const temoin = mkCreature(2, "ally", { x: 7, y: 4 }, { armor: 0 });
    let s = bareBoard(scenario([cible, temoin], 192));
    s = playCard(s, card(192), { x: 6, y: 2 });
    expect(byId(s, 1)!.armor).toBe(5); // 1 + 4
    expect(byId(s, 2)!.armor).toBe(0); // le temoin ne recoit rien
  });

  it("cible aussi une invocation ADVERSE (« une invocation », sans restriction de camp)", () => {
    card(192);
    let s = bareBoard(scenario([mkCreature(1, "enemy", { x: 3, y: 2 }, { armor: 0 })], 192));
    s = playCard(s, card(192), { x: 3, y: 2 });
    expect(byId(s, 1)!.armor).toBe(4);
  });
});

describe("#199 Mulou Garou - COUP DE GRACE : se soigne de 2 PV", () => {
  // Text: « COUP DE GRÂCE : Se soigne de 2 PV. » COUP DE GRÂCE fires when the creature
  // kills another one. Printed Mulou Garou: AT 6 / HP 6 / PM 3.
  const setup = (life: number) => {
    card(199);
    const mulou = mkCreature(1, "ally", { x: 6, y: 2 }, {
      cardId: 199, triggers: card(199).triggers ?? [],
      currentAttack: 6, baseAttack: 6, currentLife: life, baseLife: 6,
      baseMovement: 3, movementLeft: 3, hasAttacked: false,
    });
    // Prey with no attack: it dies without hitting back, so the heal is isolated.
    const proie = mkCreature(2, "enemy", { x: 5, y: 2 }, {
      currentAttack: 0, baseAttack: 0, currentLife: 1, baseLife: 1,
    });
    return endTurn(bareBoard(withDecks(scenario([mulou, proie]))));
  };

  it("tuer une invocation soigne le Mulou Garou de 2 PV", () => {
    const s = setup(2);
    expect(byId(s, 2)).toBeUndefined();       // la proie est bien morte
    expect(byId(s, 1)!.currentLife).toBe(4);  // 2 + 2
  });

  it("le soin ne depasse pas les PV maximum", () => {
    const s = setup(5);
    expect(byId(s, 2)).toBeUndefined();
    expect(byId(s, 1)!.currentLife).toBe(6);  // 5 + 2 plafonne a 6
  });

  it("BLESSER sans tuer ne soigne pas (le COUP DE GRACE exige un kill)", () => {
    card(199);
    const mulou = mkCreature(1, "ally", { x: 6, y: 2 }, {
      cardId: 199, triggers: card(199).triggers ?? [],
      currentAttack: 6, baseAttack: 6, currentLife: 2, baseLife: 6,
      baseMovement: 3, movementLeft: 3, hasAttacked: false,
    });
    // Target with 10 HP: the Mulou takes 6 HP from it but does not kill it.
    const encaisseur = mkCreature(2, "enemy", { x: 5, y: 2 }, {
      currentAttack: 0, baseAttack: 0, currentLife: 10, baseLife: 10,
    });
    const s = endTurn(bareBoard(withDecks(scenario([mulou, encaisseur]))));
    expect(byId(s, 2)!.currentLife).toBe(4); // 10 - 6 : blesse, vivant
    expect(byId(s, 1)!.currentLife).toBe(2); // aucun soin
  });

  it("sans combat du tout, aucun soin", () => {
    card(199);
    const mulou = mkCreature(1, "ally", { x: 6, y: 2 }, {
      cardId: 199, triggers: card(199).triggers ?? [],
      currentAttack: 6, baseAttack: 6, currentLife: 2, baseLife: 6,
      baseMovement: 1, movementLeft: 1, hasAttacked: false,
    });
    // Nobody to kill: it walks into empty space.
    const s = endTurn(bareBoard(withDecks(scenario([mulou]))));
    expect(byId(s, 1)!.currentLife).toBe(2);
  });
});

describe("#202 Piou Rouge - APPARITION : donnez +1 AT a une invocation", () => {
  // Text: « APPARITION : Donnez +1 AT à une invocation. » The text does not limit the
  // target's camp; the choice is a pick.
  it("ouvre un choix de cible et donne exactement +1 AT a l'invocation alliee choisie", () => {
    card(202);
    const cible = mkCreature(1, "ally", { x: 6, y: 2 }, { currentAttack: 2, baseAttack: 2 });
    let s = bareBoard(scenario([cible], 202));
    s = playCard(s, card(202), { x: 8, y: 2 });
    expect(s.pendingAction).not.toBeNull();
    expect(byId(s, 1)!.currentAttack).toBe(2); // nothing until the target is chosen
    s = resolvePendingAction(s, { x: 6, y: 2 });
    expect(byId(s, 1)!.currentAttack).toBe(3); // 2 + 1
    // The Piou Rouge comes in with its printed AT (3): the +1 went to the target.
    // Note: this pick is a `deferredSummon`, so the Piou is kept off the board during
    // the choice and only lands at resolution. It is therefore never a candidate for
    // its own bonus.
    expect(s.creatures.find((c) => c.cardId === 202)!.currentAttack).toBe(3);
    expect(s.creatures.find((c) => c.cardId === 202)!.position).toEqual({ x: 8, y: 2 });
  });

  it("peut aussi renforcer une invocation ADVERSE (« une invocation », sans restriction de camp)", () => {
    card(202);
    const foe = mkCreature(1, "enemy", { x: 3, y: 2 }, { currentAttack: 4, baseAttack: 4 });
    let s = bareBoard(scenario([foe], 202));
    s = playCard(s, card(202), { x: 8, y: 2 });
    s = resolvePendingAction(s, { x: 3, y: 2 });
    expect(byId(s, 1)!.currentAttack).toBe(5); // 4 + 1
  });

  it("plateau vide : l'APPARITION fait long feu, le Piou arrive quand meme (pas de blocage)", () => {
    // The pick is a deferredSummon: with no other creature in play there is no target,
    // and a pending action with no target would freeze the game. So the placement has to
    // go through anyway, with no pendingAction open.
    card(202);
    let s = bareBoard(scenario([], 202));
    s = playCard(s, card(202), { x: 8, y: 2 });
    expect(s.pendingAction).toBeNull();
    const piou = s.creatures.find((c) => c.cardId === 202)!;
    expect(piou.position).toEqual({ x: 8, y: 2 });
    expect(piou.currentAttack).toBe(3); // AT imprime, aucun bonus a se donner
  });
});

describe("#206 Lame Ourduvis - se teleporte derriere son adversaire apres avoir subi des degats lors d'un combat", () => {
  // Text: « Se téléporte derrière son adversaire après avoir subi des dégâts lors d'un
  // combat. » Two qualifiers: where it lands (behind the attacker, on the attacker's
  // base side) and the source of the damage (combat, not a spell). Lame Ourduvis: AT 3
  // / HP 6 / PM 3.
  const lame = () =>
    mkCreature(1, "ally", { x: 6, y: 2 }, {
      cardId: 206, triggers: card(206).triggers ?? [],
      currentAttack: 3, baseAttack: 3, currentLife: 6, baseLife: 6,
      baseMovement: 3, movementLeft: 0, hasAttacked: false,
    });

  it("encaisser un coup en combat la place DERRIERE l'attaquant (cote base de l'attaquant)", () => {
    card(206);
    // The enemy starts at (5,2) and advances toward higher x; the Lame blocks it at
    // (6,2), hence the melee. The attacker's contact cell is (5,2), and "derrière lui"
    // (on its base side, lower x) is (4,2). That is the cell the text means.
    //
    // The reference is the cell the hit comes from, not where the attacker ends up: once
    // the Lame has left, the enemy walks on into the freed cell (engine behaviour, not
    // part of the text of #206). So the attacker's final position is not asserted.
    const foe = mkCreature(2, "enemy", { x: 5, y: 2 }, {
      currentAttack: 2, baseAttack: 2, currentLife: 8, baseLife: 8,
      baseMovement: 1, movementLeft: 1, hasAttacked: false,
    });
    let s = endTurn(bareBoard(withDecks(scenario([lame(), foe])))); // fin du tour allie
    s = endTurn(s);                                                // l'ennemi avance et frappe
    expect(byId(s, 1)!.currentLife).toBe(4);              // 6 - 2 : elle a bien subi le combat
    expect(byId(s, 1)!.position).toEqual({ x: 4, y: 2 }); // derriere la case de contact (5,2)
  });

  it("des degats de SORT ne la teleportent pas (« lors d'un COMBAT »)", () => {
    card(206); card(308);
    // #308 Poele : 3 degats a une invocation (AnySummon).
    let s = bareBoard(withDecks(scenario([lame()], 308)));
    s = playCard(s, card(308), { x: 6, y: 2 });
    expect(byId(s, 1)!.currentLife).toBe(3);              // 6 - 3 : elle a bien encaisse
    expect(byId(s, 1)!.position).toEqual({ x: 6, y: 2 }); // but it did not move
  });
});

describe("#208 Virilite - confere +2 AT et +1 AR a VOS invocations", () => {
  // Text: « Confère +2 AT et +1 AR à vos invocations. » A global spell (castTarget
  // AlliedGod): both bonuses go to every ally and to no enemy.
  const build = () => {
    card(208);
    const a1 = mkCreature(1, "ally", { x: 6, y: 1 }, { currentAttack: 2, baseAttack: 2, armor: 0 });
    const a2 = mkCreature(2, "ally", { x: 7, y: 3 }, { currentAttack: 5, baseAttack: 5, armor: 3 });
    const foe = mkCreature(3, "enemy", { x: 3, y: 2 }, { currentAttack: 4, baseAttack: 4, armor: 0 });
    const s = bareBoard(scenario([a1, a2, foe], 208));
    return playCard(s, card(208), { x: 0, y: 0 });
  };

  it("chaque alliee gagne +2 AT ET +1 AR", () => {
    const s = build();
    expect(byId(s, 1)!.currentAttack).toBe(4); // 2 + 2
    expect(byId(s, 1)!.armor).toBe(1);         // 0 + 1
    expect(byId(s, 2)!.currentAttack).toBe(7); // 5 + 2
    expect(byId(s, 2)!.armor).toBe(4);         // 3 + 1
  });

  it("les adverses ne recoivent ni AT ni AR", () => {
    const s = build();
    expect(byId(s, 3)!.currentAttack).toBe(4);
    expect(byId(s, 3)!.armor).toBe(0);
  });
});

describe("#221 Chuck Maurice - INITIATIVE", () => {
  // Text: « INITIATIVE. » The keyword is innate: Chuck Maurice (AT 1 / HP 1 / PM 3) hits
  // before its opponent in the exchange.
  it("arrive sur le plateau avec l'initiative", () => {
    card(221);
    let s = bareBoard(scenario([], 221));
    s = playCard(s, card(221), { x: 8, y: 2 });
    const chuck = s.creatures.find((c) => c.cardId === 221)!;
    expect(chuck.properties.has("FirstStrike")).toBe(true);
  });

  it("frappe le premier : il tue l'assaillant a 1 PV et ressort intact", () => {
    card(221);
    // The enemy (AT 2, HP 1) advances toward higher x and runs into Chuck. Without
    // initiative Chuck (1 HP) would die; with it, Chuck hits first, kills the attacker,
    // and takes no hit back.
    const foe = mkCreature(2, "enemy", { x: 7, y: 2 }, {
      currentAttack: 2, baseAttack: 2, currentLife: 1, baseLife: 1,
      baseMovement: 2, movementLeft: 2, hasAttacked: false,
    });
    let s = bareBoard(withDecks(scenario([foe], 221)));
    s = playCard(s, card(221), { x: 8, y: 2 });
    s = endTurn(s); // fin du tour allie
    s = endTurn(s); // l'ennemi avance dans Chuck
    expect(byId(s, 2)).toBeUndefined(); // l'assaillant est mort
    const chuck = s.creatures.find((c) => c.cardId === 221);
    expect(chuck).toBeDefined();         // without initiative it would have died in the exchange
    expect(chuck!.currentLife).toBe(1);  // intact
  });
});

describe("#230 Wobot 02 - MORT : invoque un Wabbit", () => {
  // Text: « MORT : Invoque un Wabbit. » The token is the Wabbit #21 (AT 3 / HP 4 /
  // PM 3), placed on the cell freed by the Wobot, on the Wobot's side. Printed Wobot
  // 02: AT 5 / HP 4 / PM 2.
  const kill = (owner: "ally" | "enemy", cell: { x: number; y: number }) => {
    card(230); card(21);
    const wobot = mkCreature(1, owner, cell, {
      cardId: 230, triggers: card(230).triggers ?? [],
      currentAttack: 5, baseAttack: 5, currentLife: 4, baseLife: 4,
    });
    const base = bareBoard(scenario([wobot]));
    const creatures = base.creatures.map((c) => (c.instanceId === 1 ? { ...c, currentLife: 0 } : c));
    return resolveDeathsAndWin(base, creatures, base.dofuses, [...base.log], new Set());
  };

  it("un Wabbit #21 apparait sur la case de mort, du cote du Wobot", () => {
    const s = kill("ally", { x: 6, y: 2 });
    expect(byId(s, 1)).toBeUndefined(); // le Wobot a bien quitte le plateau
    const wabbits = s.creatures.filter((c) => c.cardId === 21 && c.currentLife > 0);
    expect(wabbits).toHaveLength(1);
    expect(wabbits[0].owner).toBe("ally");
    expect(wabbits[0].position).toEqual({ x: 6, y: 2 });
    expect(wabbits[0].currentAttack).toBe(3); // stats imprimees du Wabbit
    expect(wabbits[0].currentLife).toBe(4);
  });

  it("un Wobot ADVERSE invoque le Wabbit pour SON camp", () => {
    const s = kill("enemy", { x: 3, y: 2 });
    const wabbits = s.creatures.filter((c) => c.cardId === 21 && c.currentLife > 0);
    expect(wabbits).toHaveLength(1);
    expect(wabbits[0].owner).toBe("enemy");
    expect(wabbits[0].position).toEqual({ x: 3, y: 2 });
  });
});
