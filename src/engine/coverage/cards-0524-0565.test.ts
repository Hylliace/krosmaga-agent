// Coverage for cards that are wired in the engine but were not used in any test:
// #524 #527 #529 #532 #536 #540 #546 #555 #558 #560 #561 #565
//
// Each assertion comes from the card's text, never from what the engine does: a
// test written by copying the engine's output would lock its bugs in instead of
// showing them.
import { describe, it, expect } from "vitest";
import { card, mkCreature, scenario, byId } from "../testkit";
import { playCard, endTurn, resolvePendingAction } from "../rules";
import type { GameState } from "../state";
import type { PrismInstance } from "../state";

// scenario() leaves the decks empty: an endTurn would draw from an empty deck and
// trigger FATIGUE, which would hit the Dofus and pollute the assertions. Both
// decks are filled with neutral cards (#16 Bebe Phorreur).
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

// Board with a fixed set of prisms. bareBoard is never used here: the engine brings
// back all the prisms at the start of a turn when none are left (prisms.length ===
// 0), which would put back the ones we want to see destroyed.
const withPrisms = (s: GameState, prisms: PrismInstance[]): GameState => ({ ...s, prisms, seeds: [], butins: [] });

describe("#524 Wabbit Infernal - MORT : inflige 1 degat aux invocations", () => {
  // Text: « MORT : Inflige 1 degat aux invocations. » No camp qualifier: both camps take
  // it. The Wabbit itself is dead, so it cannot be hit. "aux invocations" excludes the
  // Dofus (general rule: damage never reaches a Dofus unless the text says so).
  const setup = () => {
    card(524); card(253);
    const wabbit = mkCreature(1, "ally", { x: 6, y: 2 }, {
      cardId: 524, triggers: card(524).triggers ?? [],
      currentAttack: 2, baseAttack: 2, currentLife: 4, baseLife: 4,
    });
    const temoinAllie = mkCreature(2, "ally", { x: 7, y: 0 }, { currentLife: 5, baseLife: 5 });
    const temoinEnnemi = mkCreature(3, "enemy", { x: 3, y: 4 }, { currentLife: 5, baseLife: 5 });
    const s = scenario([wabbit, temoinAllie, temoinEnnemi], 253);
    // #253 Fleche Destructrice "Detruit une invocation": a clean kill, with no side damage
    // to muddle the count.
    return playCard(bareBoard(s), card(253), { x: 6, y: 2 });
  };

  it("le Wabbit detruit quitte bien le plateau", () => {
    expect(byId(setup(), 1)).toBeUndefined();
  });

  it("une invocation ALLIEE encaisse 1 degat", () => {
    expect(byId(setup(), 2)!.currentLife).toBe(4); // 5 - 1
  });

  it("une invocation ADVERSE encaisse 1 degat (le texte ne restreint pas le camp)", () => {
    expect(byId(setup(), 3)!.currentLife).toBe(4); // 5 - 1
  });

  it("aucun Dofus n'est touche (« aux invocations »)", () => {
    const s = setup();
    expect(s.dofuses.every((d) => d.currentLife === 5)).toBe(true);
  });

  it("tant que le Wabbit VIT, rien ne part (declencheur MORT)", () => {
    card(524);
    const temoinAllie = mkCreature(2, "ally", { x: 7, y: 0 }, { currentLife: 5, baseLife: 5 });
    const temoinEnnemi = mkCreature(3, "enemy", { x: 3, y: 4 }, { currentLife: 5, baseLife: 5 });
    const s = playCard(bareBoard(scenario([temoinAllie, temoinEnnemi], 524)), card(524), { x: 8, y: 2 });
    expect(s.creatures.some((c) => c.cardId === 524)).toBe(true);
    expect(byId(s, 2)!.currentLife).toBe(5);
    expect(byId(s, 3)!.currentLife).toBe(5);
  });
});

describe("#527 Malopo - FIN DU TOUR : detruit le prisme adverse de sa ligne", () => {
  // Text: « PORTEE : 2 / FIN DU TOUR : Detruit le prisme adverse de sa ligne. »
  // Three qualifiers: the timing (end of its own camp's turn), the camp of the prism
  // ("adverse") and the row ("sa ligne" = same y).
  const prismes = (): PrismInstance[] => ([
    { position: { x: 1, y: 2 }, owner: "enemy", kind: "draw" }, // enemy, same row -> destroyed
    { position: { x: 1, y: 1 }, owner: "enemy", kind: "fleau" }, // enemy, other row -> untouched
    { position: { x: 8, y: 2 }, owner: "ally", kind: "draw" },  // ally, same row -> untouched
  ]);
  const malopo = () => {
    card(527);
    return mkCreature(1, "ally", { x: 6, y: 2 }, {
      cardId: 527, triggers: card(527).triggers ?? [],
      currentAttack: 2, baseAttack: 2, currentLife: 2, baseLife: 2, range: 2,
    });
  };
  const setup = () => endTurn(withPrisms(withDecks(scenario([malopo()])), prismes()));
  const has = (s: GameState, x: number, y: number) =>
    s.prisms.some((p) => p.position.x === x && p.position.y === y);

  it("le prisme ADVERSE de sa ligne est detruit", () => {
    expect(has(setup(), 1, 2)).toBe(false);
  });

  it("le prisme adverse d'une AUTRE ligne survit", () => {
    expect(has(setup(), 1, 1)).toBe(true);
  });

  it("le prisme ALLIE de sa ligne survit (« adverse »)", () => {
    expect(has(setup(), 8, 2)).toBe(true);
  });

  it("rien ne part a la fin du tour ADVERSE (« FIN DU TOUR » = le sien)", () => {
    // Same setup, but the enemy is the one ending its turn: the allied Malopo must not
    // fire.
    const s0 = { ...withPrisms(withDecks(scenario([malopo()])), prismes()), activeSide: "enemy" as const };
    expect(has(endTurn(s0), 1, 2)).toBe(true);
  });

  it("PORTEE 2 : le Malopo pose entre en jeu avec 2 de portee", () => {
    card(527);
    const s = playCard(bareBoard(withDecks(scenario([], 527))), card(527), { x: 8, y: 2 });
    expect(s.creatures.find((c) => c.cardId === 527)!.range).toBe(2);
  });
});

describe("#529 Maskemane Classe - APPARITION : les 2 premiers SORTS de la pioche en main", () => {
  // Text: « APPARITION : Place dans votre main les 2 premiers sorts de votre pioche. »
  // Two qualifiers: the type (spell, not summon) and the rank (the first 2, so from the
  // top). drawCardFrom does deck.pop(): the top of the deck is the end of the array.
  //   index :   0        1        2        3       4
  //   deck  : [#29(S)] [#453(I)] [#253(S)] [#16(I)] [#532(S)]
  //                                                  ^ top
  // The first 2 spells met from the top = #532 then #253.
  const setup = () => {
    card(529); card(29); card(253); card(532); card(453);
    // bareBoard: without it, placing on (8,2) would use the allied draw prism and draw
    // one more card, which would skew all the counts.
    const s = bareBoard(withDecks(scenario([], 529), [29, 453, 253, 16, 532]));
    return playCard(s, card(529), { x: 8, y: 2 });
  };

  it("les 2 sorts les plus proches du dessus arrivent en main", () => {
    const s = setup();
    expect(s.players.ally.hand).toContain(532);
    expect(s.players.ally.hand).toContain(253);
  });

  it("le 3e sort, plus profond, reste dans la pioche (« les 2 premiers »)", () => {
    const s = setup();
    expect(s.players.ally.hand).not.toContain(29);
    expect(s.players.ally.deck).toContain(29);
  });

  it("les invocations ne sont pas touchees (« sorts »)", () => {
    const s = setup();
    expect(s.players.ally.hand).not.toContain(453);
    expect(s.players.ally.hand).not.toContain(16);
    expect(s.players.ally.deck).toEqual(expect.arrayContaining([453, 16]));
  });

  it("les 2 sorts pris quittent la pioche", () => {
    const s = setup();
    expect(s.players.ally.deck).not.toContain(532);
    expect(s.players.ally.deck).not.toContain(253);
    expect(s.players.ally.deck.length).toBe(3); // 5 - 2
  });
});

describe("#532 Rafale - inflige 2 et repousse une invocation de 2 cases", () => {
  // Text: « Inflige 2 et repousse une invocation adverse de 2 cases. »
  // The push moves the target away from its goal, so toward the wall of its own camp
  // (an enemy creature moves back toward lower x).
  //
  // The text and the source data disagree (checked, not tested here): the text says
  // "invocation ADVERSE" but the castTarget shipped by the original client is
  // AnySummon, and the engine does let Rafale be cast on an allied creature (probe: an
  // ally with 6 HP at (6,2) ends with 4 HP, pushed to (8,2)). The OpponentSummon value
  // does exist in the data. No test locks in this behaviour: it needs a decision.
  it("la cible subit 2 degats ET recule de 2 cases", () => {
    card(532);
    const cible = mkCreature(1, "enemy", { x: 4, y: 2 }, { currentLife: 6, baseLife: 6 });
    const s = playCard(bareBoard(scenario([cible], 532)), card(532), { x: 4, y: 2 });
    expect(byId(s, 1)!.currentLife).toBe(4);                 // 6 - 2
    expect(byId(s, 1)!.position).toEqual({ x: 2, y: 2 });    // 4 - 2 cases
  });

  it("la poussee s'arrete sur un obstacle : 1 seule case libre = 1 seul pas", () => {
    card(532);
    const cible = mkCreature(1, "enemy", { x: 4, y: 2 }, { currentLife: 6, baseLife: 6 });
    const mur = mkCreature(2, "enemy", { x: 2, y: 2 }, { currentLife: 5, baseLife: 5 });
    const s = playCard(bareBoard(scenario([cible, mur], 532)), card(532), { x: 4, y: 2 });
    expect(byId(s, 1)!.position).toEqual({ x: 3, y: 2 });
    expect(byId(s, 2)!.position).toEqual({ x: 2, y: 2 });    // l'obstacle ne bouge pas
  });

  it("2 degats exactement : une cible a 3 PV survit a 1 PV et est repoussee", () => {
    card(532);
    const cible = mkCreature(1, "enemy", { x: 4, y: 2 }, { currentLife: 3, baseLife: 3 });
    const s = playCard(bareBoard(scenario([cible], 532)), card(532), { x: 4, y: 2 });
    expect(byId(s, 1)!.currentLife).toBe(1);                 // 3 - 2
    expect(byId(s, 1)!.position).toEqual({ x: 2, y: 2 });
  });

  it("une cible a 2 PV est tuee par les degats", () => {
    card(532);
    const cible = mkCreature(1, "enemy", { x: 4, y: 2 }, { currentLife: 2, baseLife: 2 });
    const s = playCard(bareBoard(scenario([cible], 532)), card(532), { x: 4, y: 2 });
    expect(byId(s, 1)).toBeUndefined();
    expect(s.creatures.length).toBe(0); // ni sur sa case, ni deux cases plus loin
  });
});

describe("#536 Maskemane Pleutre - APPARITION : les 3 premieres INVOCATIONS de la pioche", () => {
  // Text: « APPARITION : Place dans votre main les 3 premieres invocations de votre
  // pioche. » The mirror of #529, but with summons.
  const setup = () => {
    card(536); card(453); card(47); card(29); card(253);
    //   index :   0         1        2         3        4
    //   deck  : [#453(I)] [#29(S)] [#47(I)] [#253(S)] [#16(I)]
    //                                                  ^ dessus
    const s = bareBoard(withDecks(scenario([], 536), [453, 29, 47, 253, 16]));
    return playCard(s, card(536), { x: 8, y: 2 });
  };

  it("les 3 invocations de la pioche remontent en main", () => {
    const s = setup();
    expect(s.players.ally.hand).toEqual(expect.arrayContaining([16, 47, 453]));
  });

  it("les sorts restent dans la pioche (« invocations »)", () => {
    const s = setup();
    expect(s.players.ally.hand).not.toContain(29);
    expect(s.players.ally.hand).not.toContain(253);
    expect(s.players.ally.deck).toEqual(expect.arrayContaining([29, 253]));
    expect(s.players.ally.deck.length).toBe(2); // 5 - 3
  });

  it("ce sont les 3 invocations les plus proches du DESSUS, et seulement 3", () => {
    // A deck of 5 different summons: only this setup tells "les 3 PREMIERES" apart from
    // picking up any cards.
    //   index :   0         1        2        3         4
    //   deck  : [#453]    [#47]    [#16]    [#341]    [#153]
    //                                                  ^ top
    card(536); card(341); card(153);
    const s = playCard(bareBoard(withDecks(scenario([], 536), [453, 47, 16, 341, 153])), card(536), { x: 8, y: 2 });
    expect(s.players.ally.hand).toEqual(expect.arrayContaining([153, 341, 16]));
    expect(s.players.ally.hand).not.toContain(453);
    expect(s.players.ally.hand).not.toContain(47);
    expect(s.players.ally.deck).toEqual([453, 47]); // les 2 du fond restent
  });
});

describe("#540 Katsou Mee - APPARITION : donnez +3 AT a une invocation", () => {
  // Text: « APPARITION : Donnez +3 AT a une invocation. » No camp qualifier: any
  // creature is a valid target.
  it("l'invocation choisie gagne exactement +3 AT", () => {
    card(540);
    const allie = mkCreature(1, "ally", { x: 6, y: 2 }, { currentAttack: 2, baseAttack: 2, printedAttack: 2 });
    let s = playCard(bareBoard(scenario([allie], 540)), card(540), { x: 8, y: 2 });
    expect(s.pendingAction!.filter).toBe("any_creature"); // l'APPARITION ouvre un choix de cible
    s = resolvePendingAction(s, { x: 6, y: 2 });
    expect(byId(s, 1)!.currentAttack).toBe(5); // 2 + 3
  });

  it("le bonus ne tombe QUE sur la cible choisie", () => {
    card(540);
    const cible = mkCreature(1, "ally", { x: 6, y: 2 }, { currentAttack: 2, baseAttack: 2, printedAttack: 2 });
    const autre = mkCreature(2, "ally", { x: 6, y: 0 }, { currentAttack: 2, baseAttack: 2, printedAttack: 2 });
    let s = playCard(bareBoard(scenario([cible, autre], 540)), card(540), { x: 8, y: 2 });
    s = resolvePendingAction(s, { x: 6, y: 2 });
    expect(byId(s, 1)!.currentAttack).toBe(5);
    expect(byId(s, 2)!.currentAttack).toBe(2);
    // "une invocation": Katsou Mee does not buff itself by default.
    expect(s.creatures.find((c) => c.cardId === 540)!.currentAttack).toBe(card(540).attack);
  });

  it("une invocation ADVERSE est une cible valide (le texte ne restreint pas le camp)", () => {
    card(540);
    const foe = mkCreature(1, "enemy", { x: 3, y: 2 }, { currentAttack: 2, baseAttack: 2, printedAttack: 2 });
    let s = playCard(bareBoard(scenario([foe], 540)), card(540), { x: 8, y: 2 });
    s = resolvePendingAction(s, { x: 3, y: 2 });
    expect(byId(s, 1)!.currentAttack).toBe(5);
  });
});

describe("#546 Ejipe - se teleporte derriere son adversaire apres des degats en combat", () => {
  // Text: « Se teleporte derriere son adversaire apres avoir subi des degats lors d'un
  // combat. » Three qualifiers: the destination (behind the attacker, on the
  // attacker's camp side), the source of the damage ("lors d'un COMBAT", not a spell),
  // and that the combat counts whether Ejipe is the attacker or the one attacked (melee
  // damage goes both ways).
  const ejipe = (o: Partial<import("../state").CreatureInstance> = {}) => {
    card(546);
    return mkCreature(1, "ally", { x: 6, y: 2 }, {
      cardId: 546, triggers: card(546).triggers ?? [],
      currentAttack: 4, baseAttack: 4, currentLife: 8, baseLife: 8,
      baseMovement: 3, movementLeft: 0, hasAttacked: false,
      ...o,
    });
  };

  // Setup A: Ejipe is the attacker. It is already in contact with an enemy and hits
  // at the end of its own turn (one endTurn is enough); melee goes both ways, so it
  // "subit des degats lors d'un combat".
  const combatOffensif = () => {
    const foe = mkCreature(2, "enemy", { x: 5, y: 2 }, {
      currentAttack: 3, baseAttack: 3, currentLife: 9, baseLife: 9,
    });
    return endTurn(bareBoard(withDecks(scenario([ejipe(), foe]))));
  };

  it("Ejipe survit au coup encaisse", () => {
    expect(byId(combatOffensif(), 1)!.currentLife).toBe(5); // 8 - 3
  });

  it("il se retrouve DERRIERE l'attaquant, du cote du camp de celui-ci", () => {
    // The opponent is at (5,2); "derriere" it = the next cell going back toward its own
    // base, so (4,2).
    expect(byId(combatOffensif(), 1)!.position).toEqual({ x: 4, y: 2 });
    expect(byId(combatOffensif(), 2)!.position).toEqual({ x: 5, y: 2 }); // l'adversaire, lui, n'a pas bouge
  });

  // Setup B: Ejipe is the one attacked. It has already hit (hasAttacked) and the enemy
  // comes into contact at the end of the enemy turn (two endTurn: the first ends the
  // ally turn, the second makes the enemy advance).
  it("meme resultat quand c'est l'ENNEMI qui vient le frapper", () => {
    const foe = mkCreature(2, "enemy", { x: 4, y: 2 }, {
      currentAttack: 3, baseAttack: 3, currentLife: 9, baseLife: 9,
    });
    const s = endTurn(endTurn(bareBoard(withDecks(scenario([ejipe({ hasAttacked: true }), foe])))));
    // L'ennemi avance de (4,2) a (5,2) puis frappe : Ejipe passe derriere lui, en
    // (4,2), la case qu'il vient justement de liberer.
    expect(byId(s, 1)!.currentLife).toBe(5);
    expect(byId(s, 1)!.position).toEqual({ x: 4, y: 2 });
    expect(byId(s, 2)!.position).toEqual({ x: 5, y: 2 });
  });

  it("des degats de SORT ne le teleportent pas (« lors d'un combat »)", () => {
    card(546); card(123);
    const foe = mkCreature(2, "enemy", { x: 5, y: 2 }, { currentLife: 9, baseLife: 9 });
    // #123 Fiole de Douleur: 2 damage to a creature, here on our own Ejipe.
    const s = playCard(bareBoard(scenario([ejipe(), foe], 123)), card(123), { x: 6, y: 2 });
    expect(byId(s, 1)!.currentLife).toBe(6);              // il a bien subi les degats
    expect(byId(s, 1)!.position).toEqual({ x: 6, y: 2 }); // mais n'a pas bouge
  });
});

describe("#555 Chuchoteurs Porte-Etendard - CHEF : +1 AT a vos autres invocations", () => {
  // Text: « CHEF : +1 AT a vos autres invocations. » Three qualifiers: the camp
  // ("vos"), itself excluded ("autres") and no family (all your creatures, not only
  // the Chuchoteurs). A CHEF aura only exists while the chief is in play.
  const setup = () => {
    card(555);
    const allie = mkCreature(1, "ally", { x: 6, y: 1 }, { currentAttack: 2, baseAttack: 2, printedAttack: 2 });
    const foe = mkCreature(2, "enemy", { x: 3, y: 1 }, { currentAttack: 2, baseAttack: 2, printedAttack: 2 });
    return playCard(bareBoard(scenario([allie, foe], 555, 253)), card(555), { x: 8, y: 2 });
  };

  it("une invocation alliee gagne +1 AT, meme hors de la famille du chef", () => {
    expect(byId(setup(), 1)!.currentAttack).toBe(3); // 2 + 1
  });

  it("une invocation ADVERSE ne recoit rien (« vos »)", () => {
    expect(byId(setup(), 2)!.currentAttack).toBe(2);
  });

  it("le chef ne se buffe pas lui-meme (« vos AUTRES invocations »)", () => {
    const chef = setup().creatures.find((c) => c.cardId === 555)!;
    expect(chef.currentAttack).toBe(card(555).attack); // 1
  });

  it("l'aura tombe quand le chef quitte le plateau", () => {
    card(253);
    const s0 = setup();
    const chef = s0.creatures.find((c) => c.cardId === 555)!;
    const s = playCard(s0, card(253), chef.position); // #253 detruit le chef
    expect(s.creatures.some((c) => c.cardId === 555)).toBe(false);
    expect(byId(s, 1)!.currentAttack).toBe(2); // le +1 est revoque
  });
});

describe("#558 Devouement - transforme une invocation en Momie alliee", () => {
  // Text: « Transforme une invocation en Momie alliee. » Two qualifiers: the resulting
  // form (the Momie #360: 2 AT / 2 HP / 3 PM) and the resulting camp (ALLIEE, so the
  // caster's, even on an enemy target).
  it("une invocation ADVERSE devient une Momie de VOTRE camp", () => {
    card(558); card(360);
    const foe = mkCreature(1, "enemy", { x: 3, y: 2 }, {
      currentAttack: 7, baseAttack: 7, printedAttack: 7,
      currentLife: 9, baseLife: 9, printedLife: 9,
      baseMovement: 1, printedMovement: 1,
    });
    const s = playCard(bareBoard(scenario([foe], 558)), card(558), { x: 3, y: 2 });
    const momie = byId(s, 1)!;
    expect(momie.cardId).toBe(360);
    expect(momie.owner).toBe("ally");
    // The stats are those of the Momie card, not those of the target.
    expect(momie.currentAttack).toBe(card(360).attack);
    expect(momie.currentLife).toBe(card(360).life);
    expect(momie.baseMovement).toBe(card(360).movement);
    expect(momie.position).toEqual({ x: 3, y: 2 }); // the transformation happens in place
  });

  it("une invocation ALLIEE aussi (« une invocation », sans restriction de camp)", () => {
    card(558); card(360);
    const mine = mkCreature(1, "ally", { x: 6, y: 2 }, {
      currentAttack: 7, baseAttack: 7, printedAttack: 7,
      currentLife: 9, baseLife: 9, printedLife: 9,
    });
    const s = playCard(bareBoard(scenario([mine], 558)), card(558), { x: 6, y: 2 });
    expect(byId(s, 1)!.cardId).toBe(360);
    expect(byId(s, 1)!.owner).toBe("ally");
    expect(byId(s, 1)!.currentAttack).toBe(card(360).attack);
  });
});

describe("#560 Don Rascailles - APPARITION : detruisez un prisme", () => {
  // Text: « PORTEE : 3 / APPARITION : Detruisez un prisme. » The text does not say
  // "adverse": any prism can be destroyed, one of yours included.
  const poser = () => {
    card(560);
    const prismes: PrismInstance[] = [
      { position: { x: 1, y: 2 }, owner: "enemy", kind: "draw" },
      { position: { x: 8, y: 0 }, owner: "ally", kind: "ap" },
    ];
    return playCard(withPrisms(scenario([], 560), prismes), card(560), { x: 8, y: 2 });
  };
  const has = (s: GameState, x: number, y: number) =>
    s.prisms.some((p) => p.position.x === x && p.position.y === y);

  it("l'APPARITION ouvre un choix de prisme", () => {
    expect(poser().pendingAction!.filter).toBe("any_prism");
  });

  it("le prisme choisi disparait, l'autre reste", () => {
    const s = resolvePendingAction(poser(), { x: 1, y: 2 });
    expect(has(s, 1, 2)).toBe(false);
    expect(has(s, 8, 0)).toBe(true);
  });

  it("un prisme ALLIE est aussi une cible valide (le texte ne restreint pas le camp)", () => {
    const s = resolvePendingAction(poser(), { x: 8, y: 0 });
    expect(has(s, 8, 0)).toBe(false);
    expect(has(s, 1, 2)).toBe(true);
  });

  it("PORTEE 3 : le Don Rascailles entre en jeu avec 3 de portee", () => {
    // A targeted APPARITION keeps the creature off the board until the choice: it is
    // placed when the prism is chosen.
    const s = resolvePendingAction(poser(), { x: 1, y: 2 });
    expect(s.creatures.find((c) => c.cardId === 560)!.range).toBe(3);
  });
});

describe("#561 Piou Violet - APPARITION : +1 AT et +1 AR a vos autres Pious", () => {
  // Texte : « APPARITION : Donne +1 AT et +1 AR a vos autres Pious. »
  // Trois qualificatifs : la famille (Piou), le camp (« vos ») et l'exclusion de
  // soi (« autres »).
  const setup = () => {
    card(561); card(568);
    // #568 Piou Bleu : 2 AT / 3 PV, famille Piou.
    const piouAllie = mkCreature(1, "ally", { x: 6, y: 1 }, {
      cardId: 568, currentAttack: 2, baseAttack: 2, printedAttack: 2,
      currentLife: 3, baseLife: 3, armor: 0,
    });
    const allieNonPiou = mkCreature(2, "ally", { x: 6, y: 3 }, {
      cardId: 9999, currentAttack: 2, baseAttack: 2, printedAttack: 2, armor: 0,
    });
    const piouEnnemi = mkCreature(3, "enemy", { x: 3, y: 1 }, {
      cardId: 568, currentAttack: 2, baseAttack: 2, printedAttack: 2,
      currentLife: 3, baseLife: 3, armor: 0,
    });
    const s = scenario([piouAllie, allieNonPiou, piouEnnemi], 561);
    return playCard(bareBoard(s), card(561), { x: 8, y: 2 });
  };

  it("un Piou allie gagne +1 AT et +1 AR", () => {
    const s = setup();
    expect(byId(s, 1)!.currentAttack).toBe(3); // 2 + 1
    expect(byId(s, 1)!.armor).toBe(1);         // 0 + 1
  });

  it("un allie qui n'est pas un Piou ne recoit rien", () => {
    const s = setup();
    expect(byId(s, 2)!.currentAttack).toBe(2);
    expect(byId(s, 2)!.armor).toBe(0);
  });

  it("un Piou ADVERSE ne recoit rien (« vos » Pious)", () => {
    const s = setup();
    expect(byId(s, 3)!.currentAttack).toBe(2);
    expect(byId(s, 3)!.armor).toBe(0);
  });

  it("le Piou Violet ne se buffe pas lui-meme (« vos AUTRES Pious »)", () => {
    const s = setup();
    const violet = s.creatures.find((c) => c.cardId === 561)!;
    expect(violet.currentAttack).toBe(card(561).attack);
    expect(violet.armor).toBe(0);
  });
});

describe("#565 Globule la Crapule - APPARITION : le premier Sacrieur de la pioche en main", () => {
  // Text: « APPARITION : Place dans votre main le premier Sacrieur de votre pioche. »
  // Two qualifiers: the family (Sacrieur) and the rank (the first, so the closest to the
  // top = the end of the deck array).
  //   index :    0        1       2        3
  //   deck  : [#341(S)] [#16]  [#153(S)] [#16]
  //                                       ^ top
  // The first Sacrieur met from the top is #153, not #341.
  const setup = () => {
    card(565); card(341); card(153);
    const s = bareBoard(withDecks(scenario([], 565), [341, 16, 153, 16]));
    return playCard(s, card(565), { x: 8, y: 2 });
  };

  it("le Sacrieur le plus proche du dessus arrive en main", () => {
    const s = setup();
    expect(s.players.ally.hand).toContain(153);
    expect(s.players.ally.deck).not.toContain(153);
  });

  it("le Sacrieur plus profond reste dans la pioche (« LE premier », un seul)", () => {
    const s = setup();
    expect(s.players.ally.hand).not.toContain(341);
    expect(s.players.ally.deck).toContain(341);
    expect(s.players.ally.deck.length).toBe(3); // 4 - 1
  });

  it("une carte hors famille posee sur le dessus n'est pas prise (« Sacrieur »)", () => {
    const s = setup();
    expect(s.players.ally.hand).not.toContain(16);
    expect(s.players.ally.deck).toEqual(expect.arrayContaining([16, 16]));
  });

  it("une pioche sans Sacrieur ne donne rien", () => {
    card(565);
    const s = playCard(bareBoard(withDecks(scenario([], 565), [16, 16, 16])), card(565), { x: 8, y: 2 });
    expect(s.players.ally.hand).toEqual([]);
    expect(s.players.ally.deck.length).toBe(3);
  });
});
