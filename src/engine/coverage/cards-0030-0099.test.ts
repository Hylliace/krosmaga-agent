// Coverage for cards that are wired in the engine but were not used in any test:
//   #30 #35 #41 #47 #49 #53 #62 #64 #83 #87 #90 #99
//
// Each assertion comes from the card's text, never from what the engine does. Cards
// already covered by an existing generic test are not tested twice here.
//
// Two cards of this list have no test here, and why:
//   #35 Graine: a token (removed, model graine_token) that cannot be played from the
//     hand: canPlayCard(#35) returns "Aucune cible sur cette case." on every cell;
//     placing it goes through plantSeed(). Its text only describes walking onto the
//     Graine, already tested both ways in spells.test.ts ("walking onto an allied
//     seed grants +1 AR" / "walking onto an enemy seed deals 1 damage").
//   #49 DofusPourpre: a card with no text (empty description), a hidden token
//     (hiddenCards.ts). No assertion can come from a text that does not exist. Worth
//     noting: it can actually be cast. canPlayCard returns null even on an empty cell
//     (its castTarget AnySummon is not applied), playCard spends its 2 AP, removes it
//     from the hand, does not put it in the discard, and does nothing at all (its
//     DamageData:1 is never applied). With no reference text there is no way to tell
//     whether that is the expected behaviour.
import { describe, it, expect } from "vitest";
import { card, mkCreature, scenario, byId } from "../testkit";
import { playCard, canPlayCard, endTurn, resolvePendingAction, validPendingTargets, effectiveCost, withAuras } from "../rules";
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

const hasCell = (cells: { x: number; y: number }[], x: number, y: number) =>
  cells.some((c) => c.x === x && c.y === y);

// ───────────────────────────── #30 Truchemuche ─────────────────────────────
describe("#30 Truchemuche - change de ligne quand une invocation ADVERSE entre en jeu", () => {
  // Text: « Change de ligne quand une invocation adverse entre en jeu. »
  // Two qualifiers: the trigger is an enemy creature entering play (not an allied
  // one), and the effect is a row change (same column, next row; the creature does not
  // change column).
  const truche = (y: number, owner: "ally" | "enemy" = "ally") =>
    mkCreature(60, owner, { x: owner === "ally" ? 6 : 3, y }, {
      cardId: 30, triggers: card(30).triggers ?? [],
      currentLife: 5, baseLife: 5, currentAttack: 4, baseAttack: 4,
      baseMovement: 3, movementLeft: 0, hasAttacked: true,
    });

  const enemyPlays = (s: GameState, cell: { x: number; y: number }) => {
    const withHand = {
      ...s,
      activeSide: "enemy" as const,
      players: { ...s.players, enemy: { ...s.players.enemy, hand: [135], handCostMods: [0], ap: 20, maxAp: 20 } },
    };
    return playCard(withHand, card(135), cell);
  };

  // The destination is drawn at random between the two free neighbouring rows: only
  // one is left free so the assertion is exact rather than "one of the two". The
  // blocker is the control: it does not move.
  it("une invocation ADVERSE qui entre en jeu fait changer de ligne (meme colonne, ligne voisine)", () => {
    card(30); card(135);
    const bloc = mkCreature(61, "ally", { x: 6, y: 1 }, {});
    const s = enemyPlays(bareBoard(scenario([truche(2), bloc])), { x: 1, y: 0 });
    expect(byId(s, 60)!.position).toEqual({ x: 6, y: 3 }); // meme colonne, ligne voisine libre
    expect(byId(s, 61)!.position).toEqual({ x: 6, y: 1 }); // temoin : seule la Truche bouge
  });

  it("sur la ligne du bord, elle ne peut aller que vers l'unique ligne voisine", () => {
    card(30); card(135);
    const s = enemyPlays(bareBoard(scenario([truche(0)])), { x: 1, y: 2 });
    expect(byId(s, 60)!.position).toEqual({ x: 6, y: 1 });
  });

  it("« adverse » se lit depuis la Truche : une Truche ENNEMIE change de ligne quand VOUS invoquez", () => {
    card(30); card(135);
    const bloc = mkCreature(61, "enemy", { x: 3, y: 1 }, {});
    let s = bareBoard(scenario([truche(2, "enemy"), bloc], 135));
    s = playCard(s, card(135), { x: 8, y: 0 });
    expect(byId(s, 60)!.position).toEqual({ x: 3, y: 3 });
  });

  it("une invocation ALLIEE qui entre en jeu ne declenche rien (« adverse »)", () => {
    card(30); card(135);
    let s = bareBoard(scenario([truche(2)]));
    s = { ...s, players: { ...s.players, ally: { ...s.players.ally, hand: [135], handCostMods: [0], ap: 20, maxAp: 20 } } };
    s = playCard(s, card(135), { x: 8, y: 0 });
    expect(byId(s, 60)!.position).toEqual({ x: 6, y: 2 });
  });

  it("aucune ligne voisine libre dans sa colonne : la Truche reste sur place", () => {
    card(30); card(135);
    const above = mkCreature(61, "ally", { x: 6, y: 1 }, {});
    const below = mkCreature(62, "ally", { x: 6, y: 3 }, {});
    const s = enemyPlays(bareBoard(scenario([truche(2), above, below])), { x: 1, y: 0 });
    expect(byId(s, 60)!.position).toEqual({ x: 6, y: 2 });
  });
});

// ─────────────────────────────── #41 Flopin ────────────────────────────────
describe("#41 Flopin - PORTEE 3 + APPARITION : infligez 2 degats", () => {
  // Text: « PORTEE : 3 / APPARITION : Infligez 2 degats. »
  // The range belongs to the placed creature; the APPARITION is 2 damage on a chosen
  // creature (the text does not limit the camp).
  const build = () => {
    card(41);
    const foe = mkCreature(60, "enemy", { x: 3, y: 2 }, { currentLife: 5, baseLife: 5 });
    const pal = mkCreature(61, "ally", { x: 6, y: 2 }, { currentLife: 5, baseLife: 5 });
    let s = bareBoard(scenario([foe, pal], 41));
    s = playCard(s, card(41), { x: 8, y: 2 });
    return s;
  };

  it("l'APPARITION inflige 2 degats a l'invocation choisie, et Flopin arrive avec PORTEE 3", () => {
    const s0 = build();
    expect(s0.pendingAction).not.toBeNull(); // the APPARITION asks for a target
    const s = resolvePendingAction(s0, { x: 3, y: 2 });
    expect(byId(s, 60)!.currentLife).toBe(3);   // 5 - 2
    const flopin = s.creatures.find((c) => c.cardId === 41)!;
    expect(flopin.range).toBe(3);               // PORTEE : 3
    expect(flopin.currentLife).toBe(card(41).life);
  });

  it("le texte ne restreint pas le camp : les 2 degats peuvent viser une invocation ALLIEE", () => {
    const s0 = build();
    expect(hasCell(validPendingTargets(s0), 6, 2)).toBe(true);
    const s = resolvePendingAction(s0, { x: 6, y: 2 });
    expect(byId(s, 61)!.currentLife).toBe(3); // 5 - 2
    expect(byId(s, 60)!.currentLife).toBe(5); // l'ennemi non vise est intact
  });
});

// ─────────────────────────────── #47 Adamai ────────────────────────────────
describe("#47 Adamai - APPARITION : remontez en main de son PROPRIETAIRE une invocation a 4 AT ou moins", () => {
  // Text: « APPARITION : Remontez dans la main de son proprietaire une invocation
  // ayant 4 AT ou moins. »
  // Three qualifiers: the threshold (4 AT or less), the destination (its owner's hand,
  // not yours), and no camp limit.
  const build = () => {
    card(47); card(135); card(453);
    // Chacha Noir ennemi, 1 AT -> cible legale.
    const petitEnnemi = mkCreature(60, "enemy", { x: 3, y: 2 }, {
      cardId: 135, currentAttack: 1, baseAttack: 1, currentLife: 2, baseLife: 2,
    });
    // Enemy with 5 AT -> above the threshold, never a valid target.
    const grosEnnemi = mkCreature(61, "enemy", { x: 3, y: 0 }, {
      cardId: 135, currentAttack: 5, baseAttack: 5, currentLife: 5, baseLife: 5,
    });
    // Allied Tofu, 1 AT -> also a legal target (the text does not limit the camp).
    const allie = mkCreature(62, "ally", { x: 6, y: 2 }, {
      cardId: 453, currentAttack: 1, baseAttack: 1, currentLife: 2, baseLife: 2,
    });
    let s = bareBoard(scenario([petitEnnemi, grosEnnemi, allie], 47));
    s = playCard(s, card(47), { x: 8, y: 2 });
    return s;
  };

  it("une invocation ENNEMIE a 4 AT ou moins remonte dans la main de l'ADVERSAIRE", () => {
    const s0 = build();
    const s = resolvePendingAction(s0, { x: 3, y: 2 });
    expect(byId(s, 60)).toBeUndefined();                 // quittee le plateau
    expect(s.players.enemy.hand).toContain(135);         // « de son proprietaire »
    expect(s.players.ally.hand).not.toContain(135);
  });

  it("une invocation a PLUS de 4 AT n'est pas une cible legale", () => {
    const s0 = build();
    expect(hasCell(validPendingTargets(s0), 3, 0)).toBe(false); // 5 AT : hors seuil
    expect(hasCell(validPendingTargets(s0), 3, 2)).toBe(true);  // 1 AT : legale
  });

  it("le seuil est inclusif : EXACTEMENT 4 AT remonte bien en main (« 4 AT ou moins »)", () => {
    card(47); card(135);
    const pile = mkCreature(60, "enemy", { x: 3, y: 2 }, {
      cardId: 135, currentAttack: 4, baseAttack: 4, currentLife: 4, baseLife: 4,
    });
    const s0 = playCard(bareBoard(scenario([pile], 47)), card(47), { x: 8, y: 2 });
    expect(hasCell(validPendingTargets(s0), 3, 2)).toBe(true);
    const s = resolvePendingAction(s0, { x: 3, y: 2 });
    expect(byId(s, 60)).toBeUndefined();
    expect(s.players.enemy.hand).toContain(135);
  });

  it("le camp n'est pas restreint : une invocation ALLIEE a 4 AT ou moins remonte dans VOTRE main", () => {
    const s0 = build();
    expect(hasCell(validPendingTargets(s0), 6, 2)).toBe(true);
    const s = resolvePendingAction(s0, { x: 6, y: 2 });
    expect(byId(s, 62)).toBeUndefined();
    expect(s.players.ally.hand).toContain(453);
    expect(s.players.enemy.hand).not.toContain(453);
  });
});

// ─────────────────────────────── #53 Crochet ───────────────────────────────
describe("#53 Crochet - inflige 3 a une invocation ADVERSE", () => {
  // Text: « Inflige 3 a une invocation adverse. » The "adverse" qualifier is carried by
  // castTarget OpponentSummon: an allied creature (or an empty cell) is not a legal
  // target.
  const build = () => {
    card(53);
    const foe = mkCreature(60, "enemy", { x: 3, y: 2 }, { currentLife: 5, baseLife: 5, armor: 0 });
    const pal = mkCreature(61, "ally", { x: 6, y: 2 }, { currentLife: 5, baseLife: 5 });
    return bareBoard(scenario([foe, pal], 53));
  };

  it("inflige 3 degats a l'invocation adverse visee", () => {
    const s = playCard(build(), card(53), { x: 3, y: 2 });
    expect(byId(s, 60)!.currentLife).toBe(2); // 5 - 3
    expect(byId(s, 61)!.currentLife).toBe(5); // l'allie n'est pas touche
  });

  it("les degats passent d'abord par l'armure de la cible", () => {
    const s0 = build();
    const armee = { ...s0, creatures: s0.creatures.map((c) => (c.instanceId === 60 ? { ...c, armor: 2 } : c)) };
    const s = playCard(armee, card(53), { x: 3, y: 2 });
    expect(byId(s, 60)!.armor).toBe(0);       // 2 d'armure consommee
    expect(byId(s, 60)!.currentLife).toBe(4); // 5 - (3 - 2)
  });

  it("une invocation ALLIEE n'est pas une cible legale (« adverse »)", () => {
    expect(canPlayCard(build(), card(53), { x: 6, y: 2 })).toBe("Cette invocation n'est pas ennemie.");
  });

  it("une case vide n'est pas une cible legale (« une invocation »)", () => {
    expect(canPlayCard(build(), card(53), { x: 4, y: 4 })).toBe("Aucune cible sur cette case.");
  });

  it("un Dofus n'est pas une invocation : sa case n'est pas une cible legale", () => {
    const s0 = build();
    const dofusEnnemi = s0.dofuses.find((d) => d.owner === "enemy")!;
    expect(canPlayCard(s0, card(53), dofusEnnemi.position)).toBe("Aucune cible sur cette case.");
  });

  it("3 degats tuent une invocation adverse a 3 PV", () => {
    const s0 = build();
    const fragile = { ...s0, creatures: s0.creatures.map((c) => (c.instanceId === 60 ? { ...c, currentLife: 3, baseLife: 3 } : c)) };
    expect(byId(playCard(fragile, card(53), { x: 3, y: 2 }), 60)).toBeUndefined();
  });
});

// ─────────────────────────── #64 Grimm Beurguen ────────────────────────────
describe("#64 Grimm Beurguen - CHEF : +1 AT a vos AUTRES invocations", () => {
  // Text: « CHEF : +1 AT a vos autres invocations. » The aura has no family (unlike
  // Tofu Royal #15): it hits all your creatures, whatever their family. Three
  // qualifiers: the camp ("vos"), itself excluded ("autres"), and no family filter.
  const build = () => {
    card(64); card(453);
    // Ally with no family -> the family-less aura must still reach it.
    const sansFamille = mkCreature(60, "ally", { x: 6, y: 1 }, {
      cardId: 9999, currentAttack: 2, baseAttack: 2,
    });
    // Allie d'une famille quelconque (Tofu) -> touche aussi.
    const tofuAllie = mkCreature(61, "ally", { x: 6, y: 3 }, {
      cardId: 453, currentAttack: 1, baseAttack: 1, printedAttack: 1, currentLife: 2, baseLife: 2,
    });
    // Ennemi -> « vos » invocations : rien.
    const ennemi = mkCreature(62, "enemy", { x: 3, y: 1 }, {
      cardId: 453, currentAttack: 1, baseAttack: 1, printedAttack: 1, currentLife: 2, baseLife: 2,
    });
    return playCard(bareBoard(scenario([sansFamille, tofuAllie, ennemi], 64)), card(64), { x: 8, y: 2 });
  };

  it("un allie SANS famille recoit +1 AT (l'aura n'a pas de filtre de famille)", () => {
    expect(byId(build(), 60)!.currentAttack).toBe(3); // 2 + 1
  });

  it("un allie d'une autre famille recoit aussi +1 AT", () => {
    expect(byId(build(), 61)!.currentAttack).toBe(2); // 1 + 1
  });

  it("une invocation ENNEMIE ne recoit rien (« vos »)", () => {
    expect(byId(build(), 62)!.currentAttack).toBe(1);
  });

  it("Grimm ne se buffe pas lui-meme (« vos AUTRES invocations »)", () => {
    const grimm = build().creatures.find((c) => c.cardId === 64)!;
    expect(grimm.currentAttack).toBe(card(64).attack);
  });

  it("CHEF : l'aura tombe des que Grimm quitte le plateau", () => {
    const s = build();
    const sansGrimm = withAuras(s.creatures.filter((c) => c.cardId !== 64));
    expect(sansGrimm.find((c) => c.instanceId === 60)!.currentAttack).toBe(2); // retour a l'AT de base
    expect(sansGrimm.find((c) => c.instanceId === 61)!.currentAttack).toBe(1);
  });
});

// ─────────────────────────────── #62 Marline ───────────────────────────────
describe("#62 Marline - APPARITION : echangez son corps avec une invocation ADVERSE a 5 AT ou moins", () => {
  // Text: « APPARITION : Echangez son corps avec une invocation adverse ayant 5 AT ou
  // moins. » Swapping bodies = both creatures swap their cell and their camp. Two
  // qualifiers: ADVERSE, and 5 AT or less.
  const build = () => {
    card(62); card(135); card(453);
    const cibleLegale = mkCreature(60, "enemy", { x: 3, y: 2 }, {
      cardId: 135, currentAttack: 3, baseAttack: 3, currentLife: 4, baseLife: 4,
    });
    const tropFort = mkCreature(61, "enemy", { x: 3, y: 0 }, {
      cardId: 135, currentAttack: 6, baseAttack: 6, currentLife: 4, baseLife: 4,
    });
    const allie = mkCreature(62, "ally", { x: 6, y: 2 }, {
      cardId: 453, currentAttack: 2, baseAttack: 2, currentLife: 2, baseLife: 2,
    });
    let s = bareBoard(scenario([cibleLegale, tropFort, allie], 62));
    s = playCard(s, card(62), { x: 8, y: 2 });
    return s;
  };

  it("Marline et l'invocation adverse echangent leur case ET leur camp", () => {
    const s0 = build();
    const s = resolvePendingAction(s0, { x: 3, y: 2 });
    const marline = s.creatures.find((c) => c.cardId === 62)!;
    expect(marline.position).toEqual({ x: 3, y: 2 }); // Marline prend la place de l'adverse...
    expect(marline.owner).toBe("enemy");              // ...et passe dans son camp
    const echangee = byId(s, 60)!;
    expect(echangee.position).toEqual({ x: 8, y: 2 }); // l'adverse prend la case de Marline...
    expect(echangee.owner).toBe("ally");               // ...et passe dans le votre
  });

  it("une invocation adverse a PLUS de 5 AT n'est pas ciblable", () => {
    expect(hasCell(validPendingTargets(build()), 3, 0)).toBe(false); // 6 AT
    expect(hasCell(validPendingTargets(build()), 3, 2)).toBe(true);  // 3 AT
  });

  it("le seuil est inclusif : EXACTEMENT 5 AT est ciblable (« 5 AT ou moins »)", () => {
    card(62); card(135);
    const pile = mkCreature(60, "enemy", { x: 3, y: 2 }, {
      cardId: 135, currentAttack: 5, baseAttack: 5, currentLife: 4, baseLife: 4,
    });
    const s0 = playCard(bareBoard(scenario([pile], 62)), card(62), { x: 8, y: 2 });
    expect(hasCell(validPendingTargets(s0), 3, 2)).toBe(true);
  });

  it("une invocation ALLIEE n'est pas ciblable (« adverse »)", () => {
    expect(hasCell(validPendingTargets(build()), 6, 2)).toBe(false);
  });
});

// ────────────────────── #83 Eratz le Revendicateur ─────────────────────────
describe("#83 Eratz le Revendicateur - APPARITION : donnez INITIATIVE a une invocation", () => {
  // Texte : « APPARITION : Donnez initiative a une invocation. » Aucun
  // qualificatif de camp : allie comme adverse.
  const build = () => {
    card(83);
    const pal = mkCreature(60, "ally", { x: 6, y: 2 }, { currentLife: 5, baseLife: 5 });
    const foe = mkCreature(61, "enemy", { x: 3, y: 2 }, { currentLife: 5, baseLife: 5 });
    let s = bareBoard(scenario([pal, foe], 83));
    s = playCard(s, card(83), { x: 8, y: 2 });
    return s;
  };

  it("l'invocation alliee choisie gagne INITIATIVE", () => {
    const s0 = build();
    expect(byId(s0, 60)!.properties.has("FirstStrike")).toBe(false); // etat avant
    const s = resolvePendingAction(s0, { x: 6, y: 2 });
    expect(byId(s, 60)!.properties.has("FirstStrike")).toBe(true);
    expect(byId(s, 61)!.properties.has("FirstStrike")).toBe(false);  // l'autre ne gagne rien
  });

  it("le camp n'est pas restreint : une invocation ADVERSE peut recevoir l'initiative", () => {
    const s0 = build();
    expect(hasCell(validPendingTargets(s0), 3, 2)).toBe(true);
    const s = resolvePendingAction(s0, { x: 3, y: 2 });
    expect(byId(s, 61)!.properties.has("FirstStrike")).toBe(true);
  });
});

// ────────────────────────────── #87 Malobouc ───────────────────────────────
describe("#87 Malobouc - MORT : detruit tous les prismes ADVERSES", () => {
  // Text: « MORT : Detruit tous les prismes adverses. » "Adverses" is read from the
  // camp of the Malobouc that dies: the prisms of its own camp survive.
  const setup = () => {
    card(87);
    const malobouc = mkCreature(1, "ally", { x: 6, y: 1 }, {
      cardId: 87, triggers: card(87).triggers ?? [],
      currentLife: 3, baseLife: 3, currentAttack: 2, baseAttack: 2,
      baseMovement: 3, movementLeft: 0, hasAttacked: true, // does not move: the enemy is the one coming
    });
    const foe = mkCreature(2, "enemy", { x: 5, y: 1 }, {
      currentAttack: 3, baseAttack: 3, currentLife: 6, baseLife: 6,
      baseMovement: 2, movementLeft: 2, hasAttacked: false,
    });
    const s0: GameState = {
      ...withDecks(scenario([malobouc, foe])),
      seeds: [], butins: [],
      prisms: [
        { position: { x: 8, y: 4 }, owner: "ally", kind: "ap" },
        { position: { x: 1, y: 0 }, owner: "enemy", kind: "ap" },
        { position: { x: 1, y: 4 }, owner: "enemy", kind: "draw" },
      ],
    };
    // Two endTurn: the first ends the ally turn, the second makes the enemy advance into
    // contact with the Malobouc and kill it (3 damage on 3 HP).
    return { avant: s0, apres: endTurn(endTurn(s0)) };
  };

  it("le Malobouc meurt bien du coup ennemi (prealable du declencheur MORT)", () => {
    const { avant, apres } = setup();
    expect(byId(avant, 1)!.currentLife).toBe(3);
    expect(byId(apres, 1)).toBeUndefined();
  });

  it("tous les prismes ADVERSES sont detruits, ceux de son propre camp restent", () => {
    const { avant, apres: s } = setup();
    expect(avant.prisms.filter((p) => p.owner === "enemy")).toHaveLength(2); // etat avant
    expect(s.prisms.filter((p) => p.owner === "enemy")).toHaveLength(0);
    expect(s.prisms.filter((p) => p.owner === "ally")).toHaveLength(1);
  });
});

// ────────────────────────────── #90 Ebranler ───────────────────────────────
describe("#90 Ebranler - assomme une invocation pour 1 tour", () => {
  // Text: « Assomme une invocation pour 1 tour. » castTarget AnySummon: the camp is
  // not limited. "Pour 1 tour" = the target skips its next turn (it does not advance),
  // then is back to normal.
  const build = () => {
    card(90);
    const foe = mkCreature(60, "enemy", { x: 3, y: 2 }, {
      currentLife: 5, baseLife: 5, baseMovement: 2, movementLeft: 2, hasAttacked: false,
    });
    const pal = mkCreature(61, "ally", { x: 6, y: 4 }, {
      currentLife: 5, baseLife: 5, baseMovement: 2, movementLeft: 0, hasAttacked: true,
    });
    return bareBoard(withDecks(scenario([foe, pal], 90)));
  };

  it("la cible est assommee par le sort", () => {
    const s = playCard(build(), card(90), { x: 3, y: 2 });
    expect(byId(s, 60)!.properties.has("Stunned")).toBe(true);
    expect(byId(s, 60)!.currentLife).toBe(5); // « assomme » : aucun degat
  });

  it("l'assommee n'avance pas a son tour, puis retrouve son deplacement au suivant (« 1 tour »)", () => {
    let s = playCard(build(), card(90), { x: 3, y: 2 });
    s = endTurn(s);          // end of the ally turn -> it is the enemy's turn
    s = endTurn(s);          // fin du tour ennemi : l'assommee aurait du avancer
    expect(byId(s, 60)!.position).toEqual({ x: 3, y: 2 });          // n'a pas bouge
    expect(byId(s, 60)!.properties.has("Stunned")).toBe(false);     // 1 tour, pas plus
    s = endTurn(s);          // fin du tour allie
    s = endTurn(s);          // tour ennemi suivant : elle avance normalement de 2
    expect(byId(s, 60)!.position).toEqual({ x: 5, y: 2 });
  });

  it("castTarget AnySummon : une invocation ALLIEE est aussi une cible legale", () => {
    const s0 = build();
    expect(canPlayCard(s0, card(90), { x: 6, y: 4 })).toBeNull();
    const s = playCard(s0, card(90), { x: 6, y: 4 });
    expect(byId(s, 61)!.properties.has("Stunned")).toBe(true);
  });

  // ASSOMME means a stunned creature neither moves nor attacks, and taking damage
  // cancels it.
  it("une invocation assommee n'ATTAQUE pas non plus, meme au contact", () => {
    card(90);
    const pal = mkCreature(60, "ally", { x: 6, y: 2 }, {
      currentLife: 5, baseLife: 5, currentAttack: 3, baseAttack: 3,
      baseMovement: 2, movementLeft: 2, hasAttacked: false,
    });
    const foe = mkCreature(61, "enemy", { x: 5, y: 2 }, {
      currentLife: 6, baseLife: 6, currentAttack: 1, baseAttack: 1,
      baseMovement: 0, movementLeft: 0, hasAttacked: true,
    });
    const base = () => bareBoard(withDecks(scenario([pal, foe], 90)));
    // Control: without the spell, the ally fights the enemy in contact at the end of
    // the turn.
    const temoin = endTurn(base());
    expect(byId(temoin, 61)!.currentLife).toBe(3); // 6 - 3 : la melee a bien lieu
    expect(byId(temoin, 60)!.currentLife).toBe(4); // riposte 1
    // Assomme : aucune frappe, donc aucune riposte non plus.
    const s = endTurn(playCard(base(), card(90), { x: 6, y: 2 }));
    expect(byId(s, 61)!.currentLife).toBe(6);
    expect(byId(s, 60)!.currentLife).toBe(5);
  });

  it("subir des degats annule l'etat assomme", () => {
    card(90); card(53);
    const foe = mkCreature(60, "enemy", { x: 3, y: 2 }, {
      currentLife: 8, baseLife: 8, baseMovement: 2, movementLeft: 2, hasAttacked: false,
    });
    let s = bareBoard(withDecks(scenario([foe], 90, 53)));
    s = playCard(s, card(90), { x: 3, y: 2 });
    expect(byId(s, 60)!.properties.has("Stunned")).toBe(true);
    s = playCard(s, card(53), { x: 3, y: 2 }); // Crochet : 3 degats
    expect(byId(s, 60)!.currentLife).toBe(5);
    expect(byId(s, 60)!.properties.has("Stunned")).toBe(false);
  });
});

// ──────────────────────────── #99 Ruel Stroud ──────────────────────────────
describe("#99 Ruel Stroud - coute 3 PA de moins par AUTRE membre ALLIE de la Confrerie du Tofu en jeu", () => {
  // Text: « Coute 3 PA de moins par autre membre allie de la Confrerie du Tofu en
  // jeu. » Printed cost 4. Three qualifiers: the family (BrotherhoodOfTheTofu), the
  // camp (allie), and the step of 3 AP per member.
  // #47 Adamai and #41 Flopin are both of the Confrerie; #453 Tofu is not.
  const costWith = (creatures: ReturnType<typeof mkCreature>[]) => {
    card(99); card(47); card(41); card(453);
    const s = bareBoard(scenario(creatures, 99));
    return effectiveCost(s.players.ally, card(99), s.creatures, 0, [], { ally: 0, enemy: 0 });
  };
  const confrerie = (id: number, owner: "ally" | "enemy", cardId: number, y: number) =>
    mkCreature(id, owner, { x: owner === "ally" ? 6 : 3, y }, { cardId });

  it("aucun membre en jeu : cout imprime (4 PA)", () => {
    expect(costWith([])).toBe(4);
    expect(card(99).cost).toBe(4);
  });

  it("un membre allie de la Confrerie : -3 PA (4 -> 1)", () => {
    expect(costWith([confrerie(60, "ally", 47, 1)])).toBe(1);
  });

  it("deux membres allies : -6 PA, plancher a 0", () => {
    expect(costWith([confrerie(60, "ally", 47, 1), confrerie(61, "ally", 41, 3)])).toBe(0);
  });

  it("un membre de la Confrerie ADVERSE ne reduit rien (« allie »)", () => {
    expect(costWith([confrerie(60, "enemy", 47, 1)])).toBe(4);
  });

  it("un allie qui n'est pas de la Confrerie ne reduit rien (famille)", () => {
    expect(costWith([confrerie(60, "ally", 453, 1)])).toBe(4);
  });

  // Ruel Stroud is itself of the Confrerie du Tofu: another copy of #99 already in
  // play is indeed "un autre membre allie de la Confrerie".
  it("un AUTRE Ruel Stroud deja en jeu compte comme membre allie : -3 PA", () => {
    expect(card(99).families).toContain("BrotherhoodOfTheTofu");
    expect(costWith([confrerie(60, "ally", 99, 1)])).toBe(1);
  });
});
