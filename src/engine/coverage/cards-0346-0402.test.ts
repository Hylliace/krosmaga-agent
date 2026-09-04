// Coverage for cards that are wired in the engine but were not used in any test:
// #346 #359 #365 #369 #375 #380 #386 #393 #395 #398 #400 #402
//
// Each assertion comes from the card's text, never from what the engine does: a
// test written by copying the engine's output would lock its bugs in instead of
// showing them.
import { describe, it, expect } from "vitest";
import { card, mkCreature, scenario, byId } from "../testkit";
import {
  playCard, canPlayCard, endTurn, withAuras,
  resolvePendingAction, validPendingTargets, resolveDeathsAndWin,
} from "../rules";
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

// The ground objects placed by default (prisms) get in the way of moves and charges,
// so the board is cleared.
const bareBoard = (s: GameState): GameState => ({ ...s, prisms: [], seeds: [], butins: [] });

describe("#346 Jabs - Confere +2 AT a une invocation", () => {
  // Texte : « Confere +2 AT a une invocation. » Aucun qualificatif de camp
  // (castTarget AnySummon) : allie comme adverse.
  it("une invocation ALLIEE gagne exactement +2 AT", () => {
    card(346);
    const cible = mkCreature(60, "ally", { x: 6, y: 2 }, {
      currentAttack: 3, baseAttack: 3, printedAttack: 3,
    });
    const s0 = bareBoard(scenario([cible], 346));
    expect(canPlayCard(s0, card(346), { x: 6, y: 2 })).toBeNull();
    const s = playCard(s0, card(346), { x: 6, y: 2 });
    expect(byId(s, 60)!.currentAttack).toBe(5); // 3 + 2
  });

  it("une invocation ADVERSE est une cible legale et gagne aussi +2 AT", () => {
    card(346);
    const cible = mkCreature(60, "enemy", { x: 3, y: 2 }, {
      currentAttack: 3, baseAttack: 3, printedAttack: 3,
    });
    const s0 = bareBoard(scenario([cible], 346));
    expect(canPlayCard(s0, card(346), { x: 3, y: 2 })).toBeNull();
    const s = playCard(s0, card(346), { x: 3, y: 2 });
    expect(byId(s, 60)!.currentAttack).toBe(5);
  });

  it("ne touche que la cible designee, pas les autres invocations", () => {
    card(346);
    const cible = mkCreature(60, "ally", { x: 6, y: 2 }, { currentAttack: 3, baseAttack: 3 });
    const voisine = mkCreature(61, "ally", { x: 6, y: 3 }, { currentAttack: 3, baseAttack: 3 });
    const s = playCard(bareBoard(scenario([cible, voisine], 346)), card(346), { x: 6, y: 2 });
    expect(byId(s, 60)!.currentAttack).toBe(5);
    expect(byId(s, 61)!.currentAttack).toBe(3); // intacte
  });

  it("« a une INVOCATION » : une case vide n'est pas une cible legale", () => {
    card(346);
    const cible = mkCreature(60, "ally", { x: 6, y: 2 }, { currentAttack: 3, baseAttack: 3 });
    const s0 = bareBoard(scenario([cible], 346));
    // Same state, same AP: the only difference is that a creature is there.
    expect(canPlayCard(s0, card(346), { x: 6, y: 2 })).toBeNull();
    expect(canPlayCard(s0, card(346), { x: 6, y: 4 })).not.toBeNull();
  });
});

describe("#359 Lela - APPARITION : donnez +1 AT et +1 AR a une invocation", () => {
  // Text: « APPARITION : Donnez +1 AT et +1 AR a une invocation. »
  // Both bonuses go to the same chosen creature; no camp qualifier ("une invocation").
  const build = () => {
    card(359);
    const allie = mkCreature(60, "ally", { x: 6, y: 2 }, {
      currentAttack: 2, baseAttack: 2, printedAttack: 2, armor: 0,
    });
    const ennemi = mkCreature(61, "enemy", { x: 3, y: 2 }, {
      currentAttack: 2, baseAttack: 2, printedAttack: 2, armor: 0,
    });
    const s0 = bareBoard(scenario([allie, ennemi], 359));
    return playCard(s0, card(359), { x: 8, y: 0 });
  };

  it("l'APPARITION ouvre un choix de cible", () => {
    const s = build();
    expect(s.pendingAction).not.toBeNull();
  });

  it("la cible choisie gagne +1 AT ET +1 AR (les deux ensemble)", () => {
    const s = resolvePendingAction(build(), { x: 6, y: 2 });
    expect(byId(s, 60)!.currentAttack).toBe(3); // 2 + 1
    expect(byId(s, 60)!.armor).toBe(1);         // 0 + 1
  });

  it("une invocation ADVERSE est une cible legale (« une invocation », sans restriction de camp)", () => {
    const s0 = build();
    expect(validPendingTargets(s0).some((c) => c.x === 3 && c.y === 2)).toBe(true);
    const s = resolvePendingAction(s0, { x: 3, y: 2 });
    expect(byId(s, 61)!.currentAttack).toBe(3);
    expect(byId(s, 61)!.armor).toBe(1);
    expect(byId(s, 60)!.currentAttack).toBe(2); // l'allie non choisi reste intact
    expect(byId(s, 60)!.armor).toBe(0);
  });
});

describe("#365 Kabrok - APPARITION : ajoute 2 Corbacs a votre main", () => {
  // Texte : « APPARITION : Ajoute 2 Corbacs a votre main. » Corbac = #56.
  it("deux exemplaires du Corbac #56 arrivent dans la main du joueur qui l'invoque", () => {
    card(365); card(56);
    const s0 = bareBoard(scenario([], 365));
    expect(s0.players.ally.hand.filter((c) => c === 56)).toHaveLength(0);
    const s = playCard(s0, card(365), { x: 8, y: 2 });
    expect(s.players.ally.hand.filter((c) => c === 56)).toHaveLength(2);
    expect(s.players.enemy.hand.filter((c) => c === 56)).toHaveLength(0); // « VOTRE main »
  });
});

describe("#369 Tristepin - APPARITION Charge + initiative si un AUTRE membre allie de la Confrerie du Tofu est en jeu", () => {
  // Text: « APPARITION : Charge / Gagne initiative si un autre membre allie de la
  // Confrerie du Tofu est en jeu. »
  // Three qualifiers for initiative: AUTRE (not itself), ALLIE (not the enemy), and a
  // member of the BrotherhoodOfTheTofu family.
  // The initiative tests go through a real summon (playCard), not a bare mkCreature:
  // mkCreature starts with an empty property Set, so "no initiative" would be true
  // from the start. Summoning for real also goes through the summonCreature setup,
  // which has to refuse to fix the FirstStrike of the SetPropertyData while the
  // condition is not met. #369 has both effects (SetPropertyData FirstStrike +
  // ConditionalFirstStrike): without that check, every summoned Tristepin would have
  // initiative all the time.
  const FS = (cs: ReturnType<typeof withAuras>, cardId: number) =>
    cs.find((c) => c.cardId === cardId)!.properties.has("FirstStrike");
  // Tristepin is summoned at (8,3); the controls are placed in lane y=1 so its 3-cell
  // charge meets nobody.
  const play369 = (autres: Parameters<typeof scenario>[0]) => {
    card(369);
    const s = playCard(bareBoard(scenario(autres, 369)), card(369), { x: 8, y: 3 });
    return withAuras(s.creatures);
  };

  it("APPARITION Charge : avance immediatement de tous ses PM (3), dans la voie libre", () => {
    const cs = play369([]);
    expect(cs.find((c) => c.cardId === 369)!.position.x).toBe(5); // 8 - 3 PM
  });

  it("SEUL en jeu : pas d'initiative (l'initiative innee ne doit PAS etre figee a l'invocation)", () => {
    expect(FS(play369([]), 369)).toBe(false);
  });

  it("un AUTRE membre ALLIE de la Confrerie en jeu : initiative", () => {
    card(152); // Yugo : famille BrotherhoodOfTheTofu
    expect(FS(play369([mkCreature(2, "ally", { x: 6, y: 1 }, { cardId: 152 })]), 369)).toBe(true);
  });

  it("un membre de la Confrerie ADVERSE ne donne PAS l'initiative (« allie »)", () => {
    card(152);
    expect(FS(play369([mkCreature(2, "enemy", { x: 3, y: 1 }, { cardId: 152 })]), 369)).toBe(false);
  });

  it("un allie HORS Confrerie ne donne pas l'initiative (famille)", () => {
    card(21); // Wabbit : famille Wabbit
    expect(FS(play369([mkCreature(2, "ally", { x: 6, y: 1 }, { cardId: 21 })]), 369)).toBe(false);
  });

  it("l'initiative se retire quand le membre allie de la Confrerie quitte le jeu", () => {
    card(152);
    // Same board as the positive test, except that Yugo is dead: the "si ... est en jeu"
    // of the text is a continuous condition, not a snapshot taken at summon.
    const yugoMort = mkCreature(2, "ally", { x: 6, y: 1 }, { cardId: 152, currentLife: 0 });
    expect(FS(play369([yugoMort]), 369)).toBe(false);
  });
});

describe("#375 Piou Vert - APPARITION : Charge de 1 case", () => {
  // Text: « APPARITION : Charge de 1 case. » Exactly one cell, while the Piou Vert has
  // 4 PM: the charge has a number, it does not use all its PM.
  it("avance d'exactement 1 case a l'invocation (et pas de ses 4 PM)", () => {
    card(375);
    const s = playCard(bareBoard(scenario([], 375)), card(375), { x: 8, y: 2 });
    const piou = s.creatures.find((c) => c.cardId === 375)!;
    expect(piou.position.x).toBe(7); // 8 - 1
  });

  it("la charge de 1 case porte le coup a l'ennemi juste devant", () => {
    card(375);
    // Piou Vert AT 3. L'ennemi est a x=7, la case immediatement devant (8,2).
    const foe = mkCreature(60, "enemy", { x: 7, y: 2 }, { currentLife: 6, baseLife: 6, currentAttack: 1, baseAttack: 1 });
    const s = playCard(bareBoard(scenario([foe], 375)), card(375), { x: 8, y: 2 });
    expect(byId(s, 60)!.currentLife).toBe(3); // 6 - 3
  });
});

describe("#380 Chafer Translucide - TAS D'OS + INCIBLABLE", () => {
  // Texte : « TAS D'OS / INCIBLABLE ».
  it("INCIBLABLE : porte la propriete des son invocation", () => {
    card(380);
    const s = playCard(bareBoard(scenario([], 380)), card(380), { x: 8, y: 1 });
    const chafer = s.creatures.find((c) => c.cardId === 380)!;
    expect(chafer.properties.has("Untargetable")).toBe(true);
  });

  it("INCIBLABLE : un sort mono-cible (Jabs #346) ne peut pas le designer", () => {
    card(380); card(346);
    const s0 = bareBoard(scenario([], 380, 346));
    const s = playCard(s0, card(380), { x: 8, y: 1 });
    const chafer = s.creatures.find((c) => c.cardId === 380)!;
    // The refusal has to come from INCIBLABLE, not from missing AP or a card missing
    // from the hand: another creature can still be targeted in the same state.
    const temoin = mkCreature(70, "ally", { x: 6, y: 4 }, { cardId: 9999 });
    const s2 = { ...s, creatures: [...s.creatures, temoin] };
    expect(canPlayCard(s2, card(346), { x: 6, y: 4 })).toBeNull();
    expect(canPlayCard(s2, card(346), chafer.position)).toBe("Cette créature est intargetable.");
  });

  it("INCIBLABLE : une APPARITION a cible (Lela #359) ne peut pas le designer non plus", () => {
    card(380); card(359);
    // The refusal has to come from INCIBLABLE and not from an empty board: a control that
    // can be targeted is placed in the same state, and it has to be among the targets.
    const temoin = mkCreature(70, "ally", { x: 6, y: 4 }, { cardId: 9999 });
    const s0 = bareBoard(scenario([temoin], 380, 359));
    const s1 = playCard(s0, card(380), { x: 8, y: 1 });
    const chafer = s1.creatures.find((c) => c.cardId === 380)!;
    const s2 = playCard(s1, card(359), { x: 8, y: 3 });
    const cibles = validPendingTargets(s2);
    expect(cibles.some((c) => c.x === 6 && c.y === 4)).toBe(true);
    expect(cibles.some((c) => c.x === chafer.position.x && c.y === chafer.position.y)).toBe(false);
  });

  it("TAS D'OS : sa mort laisse un Tas d'Os de son camp sur sa case", () => {
    card(380);
    const chafer = mkCreature(900, "ally", { x: 5, y: 1 }, { cardId: 380, currentLife: 0 });
    const sc = scenario([chafer]);
    const res = resolveDeathsAndWin(sc, [chafer], sc.dofuses, [], new Set());
    expect((res.tasDOs ?? []).some((t) => t.owner === "ally" && t.position.x === 5 && t.position.y === 1)).toBe(true);
  });
});

describe("#386 Lucie Fhair - PORTEE 3 + COUP DE GRACE : recupere le dernier sort de votre defausse", () => {
  // Text: « PORTEE : 3 / COUP DE GRACE : Recupere le dernier sort parti dans votre
  // defausse. » Two qualifiers: SORT (not a summon) and DERNIER (the most recently
  // discarded).
  it("PORTEE : invoquee, elle a une portee de 3", () => {
    card(386);
    const s = playCard(bareBoard(scenario([], 386)), card(386), { x: 8, y: 2 });
    expect(s.creatures.find((c) => c.cardId === 386)!.range).toBe(3);
  });

  it("COUP DE GRACE : tuer une invocation remonte en main le DERNIER SORT de la defausse", () => {
    card(386); card(346); card(29); card(21);
    const lucie = mkCreature(1, "ally", { x: 6, y: 2 }, {
      cardId: 386, triggers: card(386).triggers ?? [],
      range: 3, currentAttack: 3, baseAttack: 3, currentLife: 4, baseLife: 4,
      baseMovement: 3, movementLeft: 3, hasAttacked: false,
    });
    const foe = mkCreature(2, "enemy", { x: 3, y: 2 }, { currentLife: 2, baseLife: 2, currentAttack: 1, baseAttack: 1 });
    let s = bareBoard(withDecks(scenario([lucie, foe])));
    // Allied discard, oldest to most recent: spell #29, summon #21, spell #346. The
    // "dernier sort" is therefore #346.
    s = { ...s, players: { ...s.players, ally: { ...s.players.ally, discard: [29, 21, 346] } } };
    s = endTurn(s);
    expect(byId(s, 2)).toBeUndefined();                     // l'ennemi est bien tue (2 PV - 3 AT)
    expect(s.players.ally.hand).toContain(346);             // le dernier SORT est revenu
    expect(s.players.ally.discard).not.toContain(346);
    expect(s.players.ally.hand).not.toContain(21);          // a summon is not a spell
    expect(s.players.ally.hand).not.toContain(29);          // and not the older spell
  });

  it("aucune mise a mort : rien ne remonte de la defausse", () => {
    card(386); card(346);
    const lucie = mkCreature(1, "ally", { x: 6, y: 2 }, {
      cardId: 386, triggers: card(386).triggers ?? [],
      range: 3, currentAttack: 3, baseAttack: 3, currentLife: 4, baseLife: 4,
      baseMovement: 3, movementLeft: 3, hasAttacked: false,
    });
    const foe = mkCreature(2, "enemy", { x: 3, y: 2 }, { currentLife: 9, baseLife: 9, currentAttack: 1, baseAttack: 1 });
    let s = bareBoard(withDecks(scenario([lucie, foe])));
    s = { ...s, players: { ...s.players, ally: { ...s.players.ally, discard: [346] } } };
    s = endTurn(s);
    expect(byId(s, 2)!.currentLife).toBe(6);        // touche mais vivant
    expect(s.players.ally.hand).not.toContain(346); // pas de COUP DE GRACE, pas de recuperation
  });

  it("« VOTRE defausse » : un sort qui dort dans la defausse ADVERSE n'est pas recupere", () => {
    card(386); card(346);
    const lucie = mkCreature(1, "ally", { x: 6, y: 2 }, {
      cardId: 386, triggers: card(386).triggers ?? [],
      range: 3, currentAttack: 3, baseAttack: 3, currentLife: 4, baseLife: 4,
      baseMovement: 3, movementLeft: 3, hasAttacked: false,
    });
    const foe = mkCreature(2, "enemy", { x: 3, y: 2 }, { currentLife: 2, baseLife: 2, currentAttack: 1, baseAttack: 1 });
    let s = bareBoard(withDecks(scenario([lucie, foe])));
    // Defausse alliee VIDE, le sort #346 est chez l'adversaire.
    s = { ...s, players: {
      ...s.players,
      ally: { ...s.players.ally, discard: [] },
      enemy: { ...s.players.enemy, discard: [346] },
    } };
    s = endTurn(s);
    expect(byId(s, 2)).toBeUndefined();                  // la mise a mort a bien eu lieu
    expect(s.players.ally.hand).not.toContain(346);      // rien n'est venu d'en face
    expect(s.players.enemy.discard).toContain(346);      // la defausse adverse est intacte
  });
});

describe("#393 Mandhal - CONTRE COUP : gagne +3 AT", () => {
  // Text: « CONTRE COUP : Gagne +3 AT. » CONTRE COUP fires when the creature takes
  // damage from another creature.
  it("encaisser un coup en melee lui donne +3 AT", () => {
    card(393);
    const mandhal = mkCreature(1, "ally", { x: 6, y: 0 }, {
      cardId: 393, triggers: card(393).triggers ?? [],
      currentAttack: 2, baseAttack: 2, printedAttack: 2,
      currentLife: 7, baseLife: 7, baseMovement: 2, movementLeft: 2, hasAttacked: false,
    });
    const foe = mkCreature(2, "enemy", { x: 5, y: 0 }, {
      currentAttack: 2, baseAttack: 2, currentLife: 5, baseLife: 5,
    });
    const s = endTurn(bareBoard(withDecks(scenario([mandhal, foe]))));
    expect(byId(s, 1)!.currentLife).toBe(5);    // 7 - 2 : il a bien encaisse
    expect(byId(s, 1)!.currentAttack).toBe(5);  // 2 + 3
    // Damage is simultaneous: the hit was dealt with the AT from before the bonus.
    expect(byId(s, 2)!.currentLife).toBe(3);    // 5 - 2
    // "GAGNE +3 AT": Mandhal is the one gaining it, not the one that hit it.
    expect(byId(s, 2)!.currentAttack).toBe(2);
  });

  it("sans degat subi, aucun bonus", () => {
    card(393);
    const mandhal = mkCreature(1, "ally", { x: 6, y: 0 }, {
      cardId: 393, triggers: card(393).triggers ?? [],
      currentAttack: 2, baseAttack: 2, printedAttack: 2,
      currentLife: 7, baseLife: 7, baseMovement: 2, movementLeft: 2, hasAttacked: false,
    });
    const s = endTurn(bareBoard(withDecks(scenario([mandhal]))));
    expect(byId(s, 1)!.currentAttack).toBe(2); // rien ne l'a frappe
  });
});

describe("#395 Wobot 01 - CHEF : +1 AT a vos AUTRES Wabbits", () => {
  // Text: « CHEF : +1 AT a vos autres Wabbits. » Three qualifiers: the family (Wabbit),
  // the camp (vos), itself excluded (autres). And only one stat: AT (not PM).
  const build = () => {
    card(395); card(21);
    const wobot = mkCreature(50, "ally", { x: 8, y: 2 }, {
      cardId: 395, currentAttack: card(395).attack!, baseAttack: card(395).attack!,
      printedAttack: card(395).attack!, baseMovement: card(395).movement!, printedMovement: card(395).movement!,
    });
    const wabbitAllie = mkCreature(60, "ally", { x: 6, y: 1 }, {
      cardId: 21, currentAttack: 2, baseAttack: 2, printedAttack: 2,
      baseMovement: 3, printedMovement: 3,
    });
    const allieNonWabbit = mkCreature(61, "ally", { x: 6, y: 3 }, {
      cardId: 9999, currentAttack: 2, baseAttack: 2, printedAttack: 2,
    });
    const wabbitEnnemi = mkCreature(62, "enemy", { x: 3, y: 1 }, {
      cardId: 21, currentAttack: 2, baseAttack: 2, printedAttack: 2,
    });
    return withAuras([wobot, wabbitAllie, allieNonWabbit, wabbitEnnemi]);
  };
  const at = (cs: ReturnType<typeof withAuras>, id: number) =>
    cs.find((c) => c.instanceId === id)!.currentAttack;

  it("un Wabbit allie gagne +1 AT", () => {
    expect(at(build(), 60)).toBe(3); // 2 + 1
  });

  // The three negative tests also check again that the aura did apply to the allied
  // Wabbit: without this control in the same state, they would stay true even if the
  // Wobot's ability were removed entirely.
  it("mais rien d'autre : ses PM ne bougent pas", () => {
    const cs = build();
    expect(at(cs, 60)).toBe(3);                                        // l'aura d'AT est bien passee...
    expect(cs.find((c) => c.instanceId === 60)!.baseMovement).toBe(3); // ...et elle s'est arretee a l'AT
  });

  it("un allie qui n'est pas un Wabbit ne recoit rien", () => {
    const cs = build();
    expect(at(cs, 60)).toBe(3);
    expect(at(cs, 61)).toBe(2);
  });

  it("un Wabbit ADVERSE ne recoit rien (« VOS » Wabbits)", () => {
    const cs = build();
    expect(at(cs, 60)).toBe(3);
    expect(at(cs, 62)).toBe(2);
  });

  it("le Wobot ne se buffe pas lui-meme (« vos AUTRES Wabbits »)", () => {
    const cs = build();
    expect(at(cs, 60)).toBe(3);
    expect(at(cs, 50)).toBe(card(395).attack!);
  });

  it("CHEF : le bonus disparait quand le Wobot n'est plus en jeu", () => {
    card(395); card(21);
    // Same board as the positive case, except that the chief is dead: a CHEF aura is
    // continuous, it goes away with its carrier.
    const wobotMort = mkCreature(50, "ally", { x: 8, y: 2 }, {
      cardId: 395, currentAttack: card(395).attack!, baseAttack: card(395).attack!,
      currentLife: 0,
    });
    const wabbitAllie = mkCreature(60, "ally", { x: 6, y: 1 }, {
      cardId: 21, currentAttack: 2, baseAttack: 2, printedAttack: 2,
    });
    expect(at(withAuras([wobotMort, wabbitAllie]), 60)).toBe(2);
  });
});

describe("#398 Piou Bleu - APPARITION : donnez +1 AR a une invocation", () => {
  // Texte : « APPARITION : Donnez +1 AR a une invocation. » Un seul bonus,
  // l'armure ; aucun qualificatif de camp.
  const build = () => {
    card(398);
    const allie = mkCreature(60, "ally", { x: 6, y: 2 }, {
      currentAttack: 2, baseAttack: 2, armor: 0,
    });
    const ennemi = mkCreature(61, "enemy", { x: 3, y: 2 }, { armor: 0 });
    return playCard(bareBoard(scenario([allie, ennemi], 398)), card(398), { x: 8, y: 0 });
  };

  it("la cible choisie gagne +1 AR", () => {
    const s = resolvePendingAction(build(), { x: 6, y: 2 });
    expect(byId(s, 60)!.armor).toBe(1);
  });

  it("elle ne gagne QUE de l'armure (l'AT ne bouge pas)", () => {
    const s = resolvePendingAction(build(), { x: 6, y: 2 });
    expect(byId(s, 60)!.armor).toBe(1);         // l'effet a bien eu lieu...
    expect(byId(s, 60)!.currentAttack).toBe(2); // ...et il s'est arrete a l'armure
  });

  it("une invocation ADVERSE est une cible legale", () => {
    const s0 = build();
    expect(validPendingTargets(s0).some((c) => c.x === 3 && c.y === 2)).toBe(true);
    const s = resolvePendingAction(s0, { x: 3, y: 2 });
    expect(byId(s, 61)!.armor).toBe(1);
    expect(byId(s, 60)!.armor).toBe(0);
  });
});

describe("#400 Tofu Enrage - APPARITION : Charge d'autant de cases que vous avez de Tofus en jeu", () => {
  // Text: « APPARITION : Charge d'autant de cases que vous avez de Tofus en jeu. » Two
  // qualifiers: "vous" (your Tofus, not the other side's) and the count itself, which
  // sets the charge distance.
  // Tofu Enragé does not count itself. The text does not say "autres" (unlike Ratou #490,
  // which does), so the exclusion is a rule decision, not a reading of the text, and it only
  // holds for this card.
  // #453 Tofu is a plain Tofu with no ability; they are placed outside lane y=0 so they
  // do not block the charge.
  const chargeX = (extras: Parameters<typeof scenario>[0]) => {
    card(400); card(453);
    const s = playCard(bareBoard(scenario(extras, 400)), card(400), { x: 8, y: 0 });
    return s.creatures.find((c) => c.cardId === 400)!.position.x;
  };

  it("seul en jeu, il ne se compte pas : aucune charge", () => {
    expect(chargeX([])).toBe(8); // stays on its summon cell
  });

  // The positive control of the whole describe: it proves that the charge still exists.
  // Without it, the three "8" below would stay true even if the charge were removed entirely.
  it("deux Tofus allies : il charge de 2 cases, pas de 3", () => {
    expect(chargeX([
      mkCreature(60, "ally", { x: 7, y: 3 }, { cardId: 453 }),
      mkCreature(61, "ally", { x: 7, y: 4 }, { cardId: 453 }),
    ])).toBe(6); // 8 - 2: itself does not add the third cell
  });

  it("les Tofus ADVERSES ne comptent pas (« que VOUS avez »)", () => {
    expect(chargeX([
      mkCreature(60, "enemy", { x: 3, y: 3 }, { cardId: 453 }),
      mkCreature(61, "enemy", { x: 3, y: 4 }, { cardId: 453 }),
    ])).toBe(8);
  });

  it("un allie qui n'est pas un Tofu ne compte pas (famille)", () => {
    expect(chargeX([mkCreature(60, "ally", { x: 7, y: 3 }, { cardId: 9999 })])).toBe(8);
  });
});

describe("#402 Canar - APPARITION : transformez une de vos Graines en Poupee Gonflable", () => {
  // Text: « APPARITION : Transformez une de vos Graines en Poupee Gonflable. »
  // Qualifier: UNE DE VOS Graines, so an enemy seed cannot be chosen.
  const build = () => {
    card(402); card(5);
    const s0 = {
      ...bareBoard(scenario([], 402)),
      seeds: [
        { position: { x: 7, y: 2 }, owner: "ally" as const },
        { position: { x: 3, y: 1 }, owner: "enemy" as const },
      ],
    };
    return playCard(s0, card(402), { x: 8, y: 0 });
  };

  it("seule une graine ALLIEE est choisissable", () => {
    expect(validPendingTargets(build())).toEqual([{ x: 7, y: 2 }]);
  });

  it("la graine choisie devient une Gonflable (#5) alliee sur sa case, et disparait du sol", () => {
    const s = resolvePendingAction(build(), { x: 7, y: 2 });
    const gonflable = s.creatures.find((c) => c.cardId === 5);
    expect(gonflable).toBeTruthy();
    expect(gonflable!.owner).toBe("ally");
    expect(gonflable!.position).toMatchObject({ x: 7, y: 2 });
    expect((s.seeds ?? []).some((g) => g.owner === "ally")).toBe(false);
    expect((s.seeds ?? []).some((g) => g.owner === "enemy")).toBe(true); // la graine adverse est intacte
  });

  it("« UNE de vos Graines » : avec deux graines alliees, une seule est transformee", () => {
    card(402); card(5);
    const s0 = {
      ...bareBoard(scenario([], 402)),
      seeds: [
        { position: { x: 7, y: 2 }, owner: "ally" as const },
        { position: { x: 7, y: 4 }, owner: "ally" as const },
      ],
    };
    const s1 = playCard(s0, card(402), { x: 8, y: 0 });
    expect(validPendingTargets(s1)).toHaveLength(2); // les deux sont proposees
    const s = resolvePendingAction(s1, { x: 7, y: 2 });
    expect(s.creatures.filter((c) => c.cardId === 5)).toHaveLength(1);
    expect(s.seeds ?? []).toEqual([{ position: { x: 7, y: 4 }, owner: "ally" }]);
  });

  it("sans aucune graine, le Canar entre en jeu sans ouvrir de choix impossible", () => {
    card(402);
    // A pendingAction opened with zero targets would freeze the game: there must not be
    // one. The card itself must still have been played.
    const s = playCard(bareBoard(scenario([], 402)), card(402), { x: 8, y: 0 });
    expect(s.creatures.some((c) => c.cardId === 402)).toBe(true);
    expect(s.pendingAction).toBeNull();
  });
});
