// Coverage for cards that are wired in the engine but were not used in any test.
// Cards: #851 #863 #885 #889 #890 #892 #894 #899 #922 #927 #945 #950.
//
// Each assertion comes from the card's text, never from what the engine does: a
// test written by copying the engine's output would lock its bugs in instead of
// showing them.
import { describe, it, expect } from "vitest";
import { card, mkCreature, scenario, byId } from "../testkit";
import { playCard, endTurn, effectiveCost, resolvePendingAction } from "../rules";
import type { GameState } from "../state";

// scenario() leaves the decks empty: an endTurn would draw from an empty deck and
// trigger FATIGUE, which would hit the Dofus and pollute the assertions. Both
// decks are filled with neutral cards.
const withDecks = (s: GameState, allyDeck: number[] = [16, 16, 16], enemyDeck: number[] = [16, 16, 16]): GameState => ({
  ...s,
  players: {
    ...s.players,
    ally: { ...s.players.ally, deck: allyDeck },
    enemy: { ...s.players.enemy, deck: enemyDeck },
  },
});

// The ground objects placed by default (prisms) get in the way of the end-of-turn
// moves, so the board is cleared.
const bareBoard = (s: GameState): GameState => ({ ...s, prisms: [], seeds: [], butins: [] });

const dofusLives = (s: GameState, owner: "ally" | "enemy") =>
  s.dofuses.filter((d) => d.owner === owner).map((d) => d.currentLife);

// ---------------------------------------------------------------------------
describe("#851 Oropo, FIN DE TOUR : place en main le dernier membre de la Fratrie des Oublies de votre pioche", () => {
  // Text: « FRATRIE / FIN DE TOUR : Place dans votre main le dernier membre de la
  // Fratrie des Oublies de votre pioche. »
  // Two qualifiers: the family (Fratrie) and "le DERNIER" of the deck. drawCardFrom
  // does deck.pop(): the end of the array is the top, so the "dernier" (the bottom) is
  // index 0, the first member met starting from the bottom.
  const oropo = () =>
    mkCreature(1, "ally", { x: 6, y: 2 }, {
      cardId: 851, triggers: card(851).triggers ?? [],
      currentAttack: 6, baseAttack: 6, printedAttack: 6,
      currentLife: 4, baseLife: 4, printedLife: 4,
      baseMovement: 0, printedMovement: 0, movementLeft: 0, hasAttacked: true,
    });

  it("remonte le membre de la Fratrie le plus PROCHE DU FOND, pas celui du dessus", () => {
    card(851); card(922); card(927);
    // Deck (index 0 = bottom): [#16 Bebe Phorreur, #922 Arpagone (Fratrie),
    // #927 Bump (Fratrie)]. The "dernier" is #922, not #927.
    let s = bareBoard(withDecks(scenario([oropo()]), [16, 922, 927]));
    expect(s.players.ally.hand).toEqual([]);
    s = endTurn(s);
    expect(s.players.ally.hand).toEqual([922]);
    expect(s.players.ally.deck).toEqual([16, 927]); // the Bump stays in the deck
  });

  it("ne remonte rien si la pioche ne contient aucun membre de la Fratrie", () => {
    card(851);
    let s = bareBoard(withDecks(scenario([oropo()]), [16, 16, 16]));
    s = endTurn(s);
    expect(s.players.ally.hand).toEqual([]);
    expect(s.players.ally.deck).toEqual([16, 16, 16]);
  });

  it("« FIN DE TOUR » = la fin de SON tour : ne part pas quand l'adversaire finit le sien", () => {
    // Regle moteur (rules.ts, pass FIN_DE_TOUR : « fires for YOUR creatures at the
    // end of YOUR turn, not at the end of every turn »). Ici l'Oropo appartient a
    // l'ENNEMI et c'est l'ALLIE qui finit son tour : le declencheur doit rester muet.
    card(851); card(922);
    const oropoAdverse = mkCreature(1, "enemy", { x: 3, y: 2 }, {
      cardId: 851, triggers: card(851).triggers ?? [],
      currentAttack: 6, baseAttack: 6, currentLife: 4, baseLife: 4,
      baseMovement: 0, printedMovement: 0, movementLeft: 0, hasAttacked: true,
    });
    let s = bareBoard(withDecks(scenario([oropoAdverse]), [16, 16, 16], [16, 922, 16]));
    s = endTurn(s); // end of the ally turn
    // The only card leaving on the enemy side is its start-of-turn draw (the top, a #16):
    // the Arpagone in the middle of the deck has not moved.
    expect(s.players.enemy.hand).not.toContain(922);
    expect(s.players.enemy.deck).toContain(922);
  });
});

// ---------------------------------------------------------------------------
describe("#863 Gaston Bo, PERCE ARMURE", () => {
  // Texte : « PERCE ARMURE » (mot-cle inne). PERCE ARMURE ignore l'Armure de
  // la cible : les degats vont directement aux PV et l'Armure reste intacte.
  it("arrive en jeu avec la propriete PERCE ARMURE", () => {
    card(863);
    let s = bareBoard(withDecks(scenario([], 863)));
    s = playCard(s, card(863), { x: 8, y: 1 });
    const g = s.creatures.find((c) => c.cardId === 863)!;
    expect(g.properties.has("PierceArmor")).toBe(true);
  });

  it("en melee : l'Armure de la cible est ignoree, pas consommee", () => {
    card(863);
    // Gaston Bo : AT 4 / PV 3 / PM 3. Cible : PV 6, AR 3, AT 1.
    // Sans PERCE ARMURE : AR 3 -> 0 et PV 6 - 1 = 5.
    // Avec PERCE ARMURE  : AR reste a 3 et PV 6 - 4 = 2.
    const foe = mkCreature(2, "enemy", { x: 5, y: 1 }, {
      currentLife: 6, baseLife: 6, printedLife: 6, armor: 3,
      currentAttack: 1, baseAttack: 1, printedAttack: 1,
    });
    let s = bareBoard(withDecks(scenario([foe], 863)));
    s = playCard(s, card(863), { x: 8, y: 1 });
    // The creature was just placed (summoning sickness): it is freed so it advances and
    // fights at the end of the ally turn.
    s = { ...s, creatures: s.creatures.map((c) => (c.cardId === 863 ? { ...c, movementLeft: 3, hasAttacked: false } : c)) };
    s = endTurn(s);
    const f = byId(s, 2)!;
    expect(f.armor).toBe(3);
    expect(f.currentLife).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe("#885 Roulage de Pelle, inflige 3", () => {
  // Text: « Inflige @damage@. » (DamageData 3), castTarget AnySummon: the text does
  // not limit the camp of the target.
  it("3 degats a une invocation adverse, absorbes d'abord par l'Armure", () => {
    card(885);
    const foe = mkCreature(1, "enemy", { x: 3, y: 2 }, { currentLife: 5, baseLife: 5, printedLife: 5, armor: 2 });
    let s = scenario([foe], 885);
    s = playCard(s, card(885), { x: 3, y: 2 });
    expect(byId(s, 1)!.armor).toBe(0);       // 2 d'Armure consommes
    expect(byId(s, 1)!.currentLife).toBe(4); // le 3e degat passe : 5 - 1
  });

  it("frappe aussi une invocation ALLIEE (AnySummon)", () => {
    card(885);
    const mine = mkCreature(1, "ally", { x: 6, y: 2 }, { currentLife: 5, baseLife: 5, printedLife: 5 });
    let s = scenario([mine], 885);
    s = playCard(s, card(885), { x: 6, y: 2 });
    expect(byId(s, 1)!.currentLife).toBe(2); // 5 - 3
  });
});

// ---------------------------------------------------------------------------
describe("#889 Zespadon Noir, APPARITION : transforme les AUTRES Pichons en Bernardo de la Carpett", () => {
  // Text: « APPARITION : Transforme les autres Pichons en Bernardo de la Carpett. »
  // Three qualifiers: the family (Pichon), "les AUTRES" (itself excluded) and no camp
  // limit (both camps).
  const build = () => {
    card(889); card(485); card(95);
    // #95 Sergent Poiscaille (Pichon) : AT 4 / PV 6 / PM 2.
    const pichonAllie = mkCreature(1, "ally", { x: 6, y: 0 }, {
      cardId: 95, currentAttack: 4, baseAttack: 4, printedAttack: 4,
      currentLife: 6, baseLife: 6, printedLife: 6,
    });
    const pichonEnnemi = mkCreature(2, "enemy", { x: 3, y: 0 }, {
      cardId: 95, currentAttack: 4, baseAttack: 4, printedAttack: 4,
      currentLife: 6, baseLife: 6, printedLife: 6,
    });
    const nonPichon = mkCreature(3, "ally", { x: 6, y: 3 }, {
      cardId: 9999, currentAttack: 2, baseAttack: 2, currentLife: 5, baseLife: 5,
    });
    let s = bareBoard(withDecks(scenario([pichonAllie, pichonEnnemi, nonPichon], 889)));
    return playCard(s, card(889), { x: 8, y: 2 });
  };

  it("un Pichon ALLIE devient un Bernardo (#485 : 2 AT / 2 PV, INCIBLABLE)", () => {
    const s = build();
    const c = byId(s, 1)!;
    expect(c.cardId).toBe(485);
    expect(c.currentAttack).toBe(2);
    expect(c.currentLife).toBe(2);
    expect(c.properties.has("Untargetable")).toBe(true);
    expect(c.owner).toBe("ally"); // chacun garde son camp
  });

  it("un Pichon ENNEMI est transforme lui aussi (le texte ne restreint pas le camp)", () => {
    const s = build();
    const c = byId(s, 2)!;
    expect(c.cardId).toBe(485);
    expect(c.currentAttack).toBe(2);
    expect(c.owner).toBe("enemy");
  });

  it("une invocation qui n'est pas un Pichon est epargnee", () => {
    const s = build();
    expect(byId(s, 3)!.cardId).toBe(9999);
    expect(byId(s, 3)!.currentAttack).toBe(2);
    expect(byId(s, 3)!.currentLife).toBe(5);
  });

  it("le Zespadon Noir ne se transforme pas lui-meme (« les AUTRES »)", () => {
    const s = build();
    const self = s.creatures.find((c) => c.position.x === 8 && c.position.y === 2)!;
    expect(self.cardId).toBe(889);
    expect(self.currentAttack).toBe(card(889).attack);
    expect(self.currentLife).toBe(card(889).life);
  });
});

// ---------------------------------------------------------------------------
describe("#890 Camouflage, confere INAMOVIBLE a une invocation", () => {
  // Text: « Confere inamovible a une invocation. »
  // INAMOVIBLE = no forced move (push, teleport, charge, bounce to hand, swap); the
  // natural end-of-turn advance is still allowed.
  it("la cible alliee gagne la propriete INAMOVIBLE, le temoin non", () => {
    card(890);
    const cible = mkCreature(1, "ally", { x: 6, y: 2 }, { currentLife: 5, baseLife: 5 });
    const temoin = mkCreature(2, "ally", { x: 6, y: 4 }, { currentLife: 5, baseLife: 5 });
    let s = bareBoard(withDecks(scenario([cible, temoin], 890)));
    s = playCard(s, card(890), { x: 6, y: 2 });
    expect(byId(s, 1)!.properties.has("Rooted")).toBe(true);
    expect(byId(s, 2)!.properties.has("Rooted")).toBe(false);
  });

  it("la cible camouflee encaisse une poussee sans bouger ; le temoin, lui, recule", () => {
    card(890); card(239);
    // #239 Esquive : PushData de 4 sur une invocation alliee.
    const cible = mkCreature(1, "ally", { x: 4, y: 1 }, { currentLife: 5, baseLife: 5 });
    const temoin = mkCreature(2, "ally", { x: 4, y: 3 }, { currentLife: 5, baseLife: 5 });
    let s = bareBoard(withDecks(scenario([cible, temoin], 890, 239, 239)));
    s = playCard(s, card(890), { x: 4, y: 1 }); // Camouflage on the target only
    s = playCard(s, card(239), { x: 4, y: 1 });
    s = playCard(s, card(239), { x: 4, y: 3 });
    expect(byId(s, 1)!.position).toEqual({ x: 4, y: 1 }); // INAMOVIBLE: nothing moves it
    // The control does move back 4 cells (4 -> 8): that is the measure of what the
    // Camouflage prevented. Without it the target would end up exactly there (checked
    // by removing the spell: without it, the target lands at {8,1}).
    expect(byId(s, 2)!.position).toEqual({ x: 8, y: 3 });
  });

  it("s'applique aussi a une invocation ADVERSE (AnySummon)", () => {
    card(890);
    const foe = mkCreature(1, "enemy", { x: 3, y: 2 }, { currentLife: 5, baseLife: 5 });
    let s = scenario([foe], 890);
    s = playCard(s, card(890), { x: 3, y: 2 });
    expect(byId(s, 1)!.properties.has("Rooted")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("#892 Jahash, APPARITION : place en main le premier SORT de la pioche, il coute 4 PA de moins", () => {
  // Text: « APPARITION : Place dans votre main le premier sort de votre pioche, il
  // coute 4 PA de moins. »
  // Qualifiers: the type (a spell, not a summon), "le PREMIER" (= the top of the
  // deck, so the end of the array) and the 4 AP discount.
  it("saute les invocations, prend le sort du dessus et lui colle -4 PA", () => {
    card(892); card(519); card(922);
    // Deck (index 0 = bottom): [#519 Criblage (spell, 8 AP), #16 (summon), #922 Arpagone
    // (summon)]. Starting from the top we skip the two summons and take the Criblage.
    let s = bareBoard(withDecks(scenario([], 892), [519, 16, 922]));
    s = playCard(s, card(892), { x: 8, y: 2 });
    const p = s.players.ally;
    expect(p.hand).toContain(519);
    expect(p.deck).toEqual([16, 922]); // les invocations restent en pioche
    const idx = p.hand.indexOf(519);
    expect(p.handCostMods[idx]).toBe(-4);
    expect(effectiveCost(p, card(519), s.creatures, idx, [], undefined)).toBe(4); // 8 - 4
  });

  it("entre DEUX sorts, prend celui du dessus (« le premier »)", () => {
    card(892); card(519); card(885);
    // Deck (index 0 = bottom): [#885 Roulage de Pelle (spell), #16 (summon), #519
    // Criblage (spell)]. The "premier" starting from the top is #519; the Roulage de
    // Pelle, lower down, must stay in the deck.
    let s = bareBoard(withDecks(scenario([], 892), [885, 16, 519]));
    s = playCard(s, card(892), { x: 8, y: 2 });
    expect(s.players.ally.hand).toEqual([519]);
    expect(s.players.ally.deck).toEqual([885, 16]);
  });

  it("ne remonte rien si la pioche ne contient aucun sort", () => {
    card(892);
    let s = bareBoard(withDecks(scenario([], 892), [16, 16, 922]));
    s = playCard(s, card(892), { x: 8, y: 2 });
    expect(s.players.ally.hand).toEqual([]);
    expect(s.players.ally.deck).toEqual([16, 16, 922]);
  });
});

// ---------------------------------------------------------------------------
describe("#894 Chacha Rabia, APPARITION : place en main le premier Chacha de la pioche", () => {
  // Text: « APPARITION : Place dans votre main le premier Chacha de votre pioche. »
  // Qualifiers: the family (Chacha) and "le PREMIER" (= the top, so the end of the
  // array).
  it("prend le Chacha le plus proche du DESSUS et laisse celui du fond", () => {
    card(894); card(135); card(732);
    // Deck (index 0 = bottom): [#135 Chacha Noir, #16, #732 Chacha Teigne].
    // The "premier" is #732.
    let s = bareBoard(withDecks(scenario([], 894), [135, 16, 732]));
    s = playCard(s, card(894), { x: 8, y: 2 });
    expect(s.players.ally.hand).toEqual([732]);
    expect(s.players.ally.deck).toEqual([135, 16]);
  });

  it("ne remonte rien si la pioche ne contient aucun Chacha", () => {
    card(894);
    let s = bareBoard(withDecks(scenario([], 894), [16, 16, 16]));
    s = playCard(s, card(894), { x: 8, y: 2 });
    expect(s.players.ally.hand).toEqual([]);
    expect(s.players.ally.deck).toEqual([16, 16, 16]);
  });
});

// ---------------------------------------------------------------------------
describe("#899 Champion Croulant, NECROME + INAMOVIBLE", () => {
  // Text: « NECROME / INAMOVIBLE. »
  // NECROME opens the choice "revelez un de vos Dofus" when the creature is placed; we
  // decline by clicking elsewhere on the board, and the creature is then placed
  // normally. INAMOVIBLE = it is never moved.
  const poser = () => {
    card(899);
    let s = bareBoard(withDecks(scenario([], 899)));
    s = playCard(s, card(899), { x: 8, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 7, y: 4 }); // decline : pose directe
    return s;
  };

  it("arrive en jeu avec la propriete INAMOVIBLE", () => {
    const s = poser();
    const champ = s.creatures.find((c) => c.cardId === 899)!;
    expect(champ.properties.has("Rooted")).toBe(true);
    expect(champ.position).toEqual({ x: 8, y: 2 });
  });

  it("INAMOVIBLE ne bloque QUE le deplacement impose : l'avance naturelle de fin de tour a bien lieu", () => {
    // INAMOVIBLE forbids charge / teleport / push / bounce to hand / swap, but the
    // creature still uses its PM at the end of the turn. Champion Croulant has 2 PM: 8 -> 6.
    let s = poser();
    s = { ...s, creatures: s.creatures.map((c) => (c.cardId === 899 ? { ...c, movementLeft: 2, hasAttacked: false } : c)) };
    s = endTurn(s);
    const champ = s.creatures.find((c) => c.cardId === 899)!;
    expect(champ.position).toEqual({ x: 6, y: 2 });
  });

  it("INAMOVIBLE : une poussee ne le deplace pas, alors qu'un temoin recule", () => {
    // #312 Fleche de Recul: a PushData of 5 on an enemy creature. Here the Champion is an
    // ally, so the opponent is the one pushing it.
    //
    // Beware of a test that proves nothing: a push sends the target toward its own wall
    // (ally -> higher x) and stops one cell before the wall column (x=9). A Champion left
    // on its placement cell (x=8) cannot move anyway, Rooted or not, so a test set up
    // like that passes even without INAMOVIBLE (checked by removing it). So it is moved
    // to x=5, where a push has room, and a control without INAMOVIBLE is added on the
    // next row to measure what is prevented.
    card(312);
    let s = poser();
    const temoin = mkCreature(50, "ally", { x: 5, y: 3 }, { currentLife: 5, baseLife: 5 });
    s = {
      ...s,
      creatures: [
        ...s.creatures.map((c) => (c.cardId === 899 ? { ...c, position: { x: 5, y: 2 } } : c)),
        temoin,
      ],
      activeSide: "enemy",
      players: { ...s.players, enemy: { ...s.players.enemy, hand: [312, 312], handCostMods: [0, 0], ap: 10, maxAp: 10 } },
    };
    s = playCard(s, card(312), { x: 5, y: 2 }); // sur le Champion INAMOVIBLE
    s = playCard(s, card(312), { x: 5, y: 3 }); // sur le temoin
    const champ = s.creatures.find((c) => c.cardId === 899)!;
    expect(champ.position).toEqual({ x: 5, y: 2 }); // INAMOVIBLE : pas d'un pouce
    expect(byId(s, 50)!.position).toEqual({ x: 8, y: 3 }); // le temoin, lui, recule
  });
});

// ---------------------------------------------------------------------------
describe("#922 Arpagone, coute 1 PA de moins par invocation ENNEMIE en jeu", () => {
  // Text: « FRATRIE / Coute 1 PA de moins par invocation ennemie en jeu. »
  // Printed cost: 5 AP. Qualifier: ENNEMIE (allied creatures do not count).
  const cout = (s: GameState) => effectiveCost(s.players.ally, card(922), s.creatures, 0, [], undefined);
  const ennemis = (n: number) =>
    Array.from({ length: n }, (_, i) => mkCreature(10 + i, "enemy", { x: 3, y: i }, { currentLife: 5, baseLife: 5 }));

  it("plateau vide : cout plein de 5 PA", () => {
    card(922);
    expect(cout(scenario([], 922))).toBe(5);
  });

  it("3 invocations ennemies : 5 - 3 = 2 PA", () => {
    card(922);
    expect(cout(scenario(ennemis(3), 922))).toBe(2);
  });

  it("les invocations ALLIEES ne reduisent rien", () => {
    card(922);
    const allies = [
      mkCreature(20, "ally", { x: 6, y: 0 }, { currentLife: 5, baseLife: 5 }),
      mkCreature(21, "ally", { x: 6, y: 1 }, { currentLife: 5, baseLife: 5 }),
      mkCreature(22, "ally", { x: 6, y: 2 }, { currentLife: 5, baseLife: 5 }),
    ];
    expect(cout(scenario(allies, 922))).toBe(5);
  });

  it("le cout ne descend jamais sous 0", () => {
    card(922);
    expect(cout(scenario(ennemis(5), 922))).toBe(0); // 5 - 5, pas -0 ni negatif
  });
});

// ---------------------------------------------------------------------------
describe("#927 Bump, RALLIEMENT + APPARITION : +2 AR aux AUTRES invocations alliees", () => {
  // Text: « FRATRIE / RALLIEMENT / APPARITION : Donne +2 AR aux autres invocations
  // alliees. » Qualifiers: the camp (ALLIEES) and "les AUTRES" (itself excluded).
  const build = () => {
    card(927);
    const allieA = mkCreature(1, "ally", { x: 6, y: 0 }, { currentLife: 5, baseLife: 5, armor: 0 });
    const allieB = mkCreature(2, "ally", { x: 6, y: 3 }, { currentLife: 5, baseLife: 5, armor: 1 });
    const ennemi = mkCreature(3, "enemy", { x: 3, y: 0 }, { currentLife: 5, baseLife: 5, armor: 0 });
    let s = bareBoard(withDecks(scenario([allieA, allieB, ennemi], 927)));
    s = playCard(s, card(927), { x: 8, y: 2 });
    // FRATRIE opens a choice to discard enemy cards when it is placed: we decline it by
    // clicking an empty cell, and Bump is then placed at once.
    if (s.pendingAction) s = resolvePendingAction(s, { x: 7, y: 4 });
    return s;
  };

  it("les invocations alliees deja en jeu gagnent +2 AR", () => {
    const s = build();
    expect(byId(s, 1)!.armor).toBe(2); // 0 + 2
    expect(byId(s, 2)!.armor).toBe(3); // 1 + 2
  });

  it("une invocation ENNEMIE ne recoit rien", () => {
    const s = build();
    expect(byId(s, 3)!.armor).toBe(0);
  });

  it("Bump ne se donne pas d'armure a lui-meme (« les AUTRES »)", () => {
    const s = build();
    const bump = s.creatures.find((c) => c.cardId === 927)!;
    expect(bump.armor).toBe(0);
  });

  it("Bump porte bien le mot-cle RALLIEMENT", () => {
    const s = build();
    const bump = s.creatures.find((c) => c.cardId === 927)!;
    expect(bump.properties.has("Ralliement")).toBe(true);
  });

  it("RALLIEMENT : pose a cote d'un allie RALLIEMENT plus avance, Bump remonte se mettre a son niveau", () => {
    // The keyword is not just a label: when placed on a row next to the row of a
    // RALLIEMENT ally that is further ahead, the new creature walks up to that ally's
    // column. Without the keyword on Bump, it would stay on its placement cell. No enemy
    // in play here, so FRATRIE opens no choice.
    card(927);
    const ancre = mkCreature(1, "ally", { x: 5, y: 1 }, {
      currentLife: 5, baseLife: 5, properties: new Set(["Ralliement"]),
    });
    let s = bareBoard(withDecks(scenario([ancre], 927)));
    s = playCard(s, card(927), { x: 8, y: 2 }); // ligne 2, adjacente a la ligne 1
    expect(s.pendingAction).toBeNull();
    const bump = s.creatures.find((c) => c.cardId === 927)!;
    expect(bump.position).toEqual({ x: 5, y: 2 });
  });

  it("RALLIEMENT : sans allie RALLIEMENT a cote, Bump reste sur sa case de pose", () => {
    card(927);
    const ancreSansMotCle = mkCreature(1, "ally", { x: 5, y: 1 }, { currentLife: 5, baseLife: 5 });
    let s = bareBoard(withDecks(scenario([ancreSansMotCle], 927)));
    s = playCard(s, card(927), { x: 8, y: 2 });
    const bump = s.creatures.find((c) => c.cardId === 927)!;
    expect(bump.position).toEqual({ x: 8, y: 2 });
  });
});

// ---------------------------------------------------------------------------
describe("#945 Piege Explosif, place un Piege Explosif Active dans la main de l'ADVERSAIRE", () => {
  // Text of #945: « Place un Piege Explosif Active dans la main de votre adversaire. »
  // Text of the #671 placed this way: « Inflige 3 a vos invocations. Vous avez 1 tour
  // pour le jouer ou vos Dofus subiront 1 degat. »
  const lancer = () => {
    card(945); card(671);
    let s = bareBoard(withDecks(scenario([], 945)));
    return playCard(s, card(945), { x: 0, y: 0 }); // castTarget AlliedGod : la case est ignoree
  };

  it("la carte #671 atterrit dans la main ADVERSE, pas dans la sienne", () => {
    const s = lancer();
    expect(s.players.enemy.hand).toContain(671);
    expect(s.players.ally.hand).not.toContain(671);
  });

  it("elle arrive armee : 1 tour de sursis, 1 degat de penalite", () => {
    const s = lancer();
    expect(s.players.enemy.activeTraps).toEqual([{ cardId: 671, counter: 1, penalty: 1 }]);
    expect(s.players.ally.activeTraps ?? []).toEqual([]);
  });

  it("non joue a temps : chaque Dofus de l'adversaire perd 1 PV et la carte quitte sa main", () => {
    let s = lancer();
    const avantEnemy = dofusLives(s, "enemy");
    const avantAlly = dofusLives(s, "ally");
    s = endTurn(s); // end of the ally turn -> the enemy turn starts
    // "1 tour pour le jouer": the delay really exists, nothing has gone off yet.
    expect(dofusLives(s, "enemy")).toEqual(avantEnemy);
    expect(s.players.enemy.activeTraps).toEqual([{ cardId: 671, counter: 1, penalty: 1 }]);
    s = endTurn(s); // end of the enemy turn: the trap was not played, so it goes off
    expect(dofusLives(s, "enemy")).toEqual(avantEnemy.map((l) => l - 1));
    expect(s.players.enemy.hand).not.toContain(671);
    expect(s.players.enemy.activeTraps ?? []).toEqual([]);
    expect(dofusLives(s, "ally")).toEqual(avantAlly); // the caster's Dofus are untouched
  });
});

// ---------------------------------------------------------------------------
describe("#950 Piege Troublant Active, piochez 2 cartes ; 1 tour pour le jouer sinon 1 degat aux Dofus", () => {
  // Text: « Piochez 2 cartes. Vous avez 1 tour pour le jouer ou vos Dofus subiront
  // 1 degat. »
  // This card only gets into a hand when placed by #712 Piege Troublant, which arms
  // it (1 turn of delay, 1 damage), so that is the reference setup.
  const donner = () => {
    card(712); card(950);
    let s = bareBoard(withDecks(scenario([], 712), [16, 16, 16], [16, 16, 16, 16, 16]));
    return playCard(s, card(712), { x: 0, y: 0 });
  };

  it("arrive dans la main adverse, armee pour 1 tour et 1 degat", () => {
    const s = donner();
    expect(s.players.enemy.hand).toContain(950);
    expect(s.players.enemy.activeTraps).toEqual([{ cardId: 950, counter: 1, penalty: 1 }]);
  });

  it("joue a temps : son detenteur pioche 2 cartes et le compte a rebours s'eteint", () => {
    let s = donner();
    s = endTurn(s); // le tour adverse commence
    expect(s.activeSide).toBe("enemy");
    s = { ...s, players: { ...s.players, enemy: { ...s.players.enemy, ap: 10 } } };
    const mainAvant = s.players.enemy.hand.length;
    const piocheAvant = s.players.enemy.deck.length;
    const dofusAvant = dofusLives(s, "enemy");
    s = playCard(s, card(950), { x: 0, y: 0 });
    expect(s.players.enemy.deck.length).toBe(piocheAvant - 2);
    expect(s.players.enemy.hand.length).toBe(mainAvant - 1 + 2); // -1 la carte jouee, +2 piochees
    expect(s.players.enemy.activeTraps ?? []).toEqual([]);
    s = endTurn(s);
    expect(dofusLives(s, "enemy")).toEqual(dofusAvant); // joue a temps : aucune penalite
  });

  it("non joue : chaque Dofus de son detenteur perd 1 PV et la carte quitte sa main", () => {
    let s = donner();
    const avant = dofusLives(s, "enemy");
    const avantLanceur = dofusLives(s, "ally");
    s = endTurn(s); // le tour adverse commence
    expect(dofusLives(s, "enemy")).toEqual(avant); // « 1 tour » : le sursis court encore
    s = endTurn(s); // end of the enemy turn without playing the card
    expect(dofusLives(s, "enemy")).toEqual(avant.map((l) => l - 1));
    expect(s.players.enemy.hand).not.toContain(950);
    expect(dofusLives(s, "ally")).toEqual(avantLanceur); // the penalty only hits the holder
  });
});
