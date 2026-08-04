// Coverage for cards that are wired in the engine but were not used in any test:
//   #1413 #1426 #1497 #1634 #1681 #1739 #1841
//
// Each assertion comes from the card's text, never from what the engine does: a
// test written by copying the engine's output would lock its bugs in instead of
// showing them.
//
// An assertion has to fail if the card's effect disappears. The starting positions
// of the pushes are chosen for that: a target against the wall would end up on the
// same cell with any longer distance, and the test would prove nothing.
import { describe, it, expect } from "vitest";
import { card, mkCreature, scenario, byId } from "../testkit";
import {
  playCard, canPlayCard, endTurn, resolvePendingAction, runTrigger, resolveDeathsAndWin,
} from "../rules";
import type { GameState } from "../state";

// scenario() leaves the decks empty: an endTurn would draw from an empty deck and
// trigger FATIGUE, which would hit the Dofus and pollute the assertions. Both
// decks are filled with neutral cards.
const withDecks = (s: GameState, allyDeck: number[] = [16, 16, 16]): GameState => ({
  ...s,
  players: {
    ...s.players,
    ally: { ...s.players.ally, deck: allyDeck, deckCostMods: allyDeck.map(() => 0) },
    enemy: { ...s.players.enemy, deck: [16, 16, 16] },
  },
});

// The ground objects placed by default (prisms) get in the way of the moves and of
// placing objects, so the board is cleared.
const bareBoard = (s: GameState): GameState => ({ ...s, prisms: [], seeds: [], butins: [] });

// ---------------------------------------------------------------------------
// #1413 Fleau: « Inflige @damage@ a un Dofus. » (token spell, castTarget AnyDofus)
// ---------------------------------------------------------------------------
// #1413 is a data duplicate of #757 (same name, cost, family, castTarget and
// effects). #757 is already covered in spells.test.ts, but a data duplicate is not a
// coverage duplicate: if #1413 ever drifts in the shipped JSON, no test would catch
// it. So it is tested on its own.
describe("#1413 Fleau - Inflige 1 degat a un Dofus", () => {
  it("inflige exactement 1 degat au Dofus ADVERSE choisi, et a lui seul", () => {
    card(1413);
    const s0 = scenario([], 1413);
    const avant = s0.dofuses.map((d) => ({ x: d.position.x, y: d.position.y, pv: d.currentLife }));
    const s = playCard(s0, card(1413), { x: 0, y: 0 });
    for (const d of s.dofuses) {
      const ref = avant.find((a) => a.x === d.position.x && a.y === d.position.y)!;
      const attendu = d.position.x === 0 && d.position.y === 0 ? ref.pv - 1 : ref.pv;
      expect(d.currentLife).toBe(attendu);
    }
  });

  it("peut aussi viser un Dofus ALLIE (« un Dofus », sans restriction de camp)", () => {
    card(1413);
    const s0 = scenario([], 1413);
    expect(canPlayCard(s0, card(1413), { x: 9, y: 2 })).toBeNull();
    const avant = s0.dofuses.find((d) => d.position.x === 9 && d.position.y === 2)!.currentLife;
    const s = playCard(s0, card(1413), { x: 9, y: 2 });
    expect(s.dofuses.find((d) => d.position.x === 9 && d.position.y === 2)!.currentLife).toBe(avant - 1);
  });

  it("refuse une invocation et une case vide (« a un Dofus »)", () => {
    card(1413);
    const ennemi = mkCreature(60, "enemy", { x: 4, y: 2 }, { currentLife: 5, baseLife: 5 });
    const allie = mkCreature(61, "ally", { x: 6, y: 2 }, { currentLife: 5, baseLife: 5 });
    const s = scenario([ennemi, allie], 1413);
    expect(canPlayCard(s, card(1413), { x: 4, y: 2 })).not.toBeNull();
    expect(canPlayCard(s, card(1413), { x: 6, y: 2 })).not.toBeNull();
    expect(canPlayCard(s, card(1413), { x: 5, y: 3 })).not.toBeNull();
  });

  it("jeton : part au tokenDiscard, jamais dans la defausse recuperable", () => {
    expect(card(1413).isToken).toBe(true);
    const s = playCard(scenario([], 1413), card(1413), { x: 0, y: 0 });
    expect(s.players.ally.discard).not.toContain(1413);
    expect(s.players.ally.tokenDiscard).toContain(1413);
  });
});

// ---------------------------------------------------------------------------
// #1426 Skhul, « APPARITION : Repousse une invocation de 4 cases. »
// ---------------------------------------------------------------------------
describe("#1426 Skhul - APPARITION : Repousse une invocation de 4 cases", () => {
  // Three things to check, all from the text:
  //   - the trigger does open a target choice "une invocation";
  //   - the distance is 4 cells, no more, no less;
  //   - "une invocation" is not limited to a camp (ally or enemy).
  // The push goes toward the wall of the target's owner (general rule of "Repousse"):
  // an ally moves back toward higher x, an enemy toward lower x. A push stops one cell
  // before the wall column (x=0 / x=9), so the targets are placed far enough from the
  // wall that the landing cell proves the distance of 4 and not just a stop.
  const poser = (autres: ReturnType<typeof mkCreature>[]) => {
    card(1426);
    const s = bareBoard(scenario(autres, 1426));
    return playCard(s, card(1426), { x: 8, y: 2 });
  };

  it("l'APPARITION ouvre un choix visant une invocation", () => {
    const cible = mkCreature(60, "ally", { x: 3, y: 1 }, { currentLife: 5, baseLife: 5 });
    const s = poser([cible]);
    expect(s.pendingAction).not.toBeNull();
    expect(s.pendingAction!.filter).toBe("any_creature");
  });

  it("une invocation ALLIEE recule de 4 cases exactement (3 -> 7, loin du mur)", () => {
    const cible = mkCreature(60, "ally", { x: 3, y: 1 }, { currentLife: 5, baseLife: 5 });
    const s0 = poser([cible]);
    expect(byId(s0, 60)!.position).toEqual({ x: 3, y: 1 }); // etat AVANT le choix
    const s = resolvePendingAction(s0, { x: 3, y: 1 });
    // x=8 would be the last free cell before the allied wall: landing on 7 proves that
    // the distance of 4 stopped the push, not the edge.
    expect(byId(s, 60)!.position).toEqual({ x: 7, y: 1 });
  });

  it("une invocation ADVERSE recule de 4 cases elle aussi (6 -> 2, loin de son mur)", () => {
    // "une invocation": the text does not limit the camp. The enemy moves back toward
    // its own wall, so toward lower x: 6 -> 5 -> 4 -> 3 -> 2. x=1 is its last free cell,
    // so stopping at 2 proves the distance.
    const cible = mkCreature(61, "enemy", { x: 6, y: 3 }, { currentLife: 5, baseLife: 5 });
    const s0 = poser([cible]);
    const s = resolvePendingAction(s0, { x: 6, y: 3 });
    expect(byId(s, 61)!.position).toEqual({ x: 2, y: 3 });
  });

  it("la poussee ne coute aucun PV a la cible (« Repousse » seul)", () => {
    const cible = mkCreature(60, "ally", { x: 3, y: 1 }, { currentLife: 5, baseLife: 5 });
    const s = resolvePendingAction(poser([cible]), { x: 3, y: 1 });
    expect(byId(s, 60)!.currentLife).toBe(5);
  });

  it("Skhul lui-meme arrive avec ses caracteristiques imprimees (3 AT / 2 PV / 3 PM) et ne se repousse pas", () => {
    const cible = mkCreature(60, "ally", { x: 3, y: 1 }, { currentLife: 5, baseLife: 5 });
    const s = resolvePendingAction(poser([cible]), { x: 3, y: 1 });
    const skhul = s.creatures.find((c) => c.cardId === 1426)!;
    expect(skhul.currentAttack).toBe(3);
    expect(skhul.currentLife).toBe(2);
    expect(skhul.baseMovement).toBe(3);
    // The card's flat PushData must not apply to the caster placed on the spawn cell:
    // Skhul stays where it was put.
    expect(skhul.position).toEqual({ x: 8, y: 2 });
  });
});

// ---------------------------------------------------------------------------
// #1497 Argolio, « PORTEE : @range@ / COUP DE GRACE : Inflige 1 degat a
// toutes les invocations adverses. »
// ---------------------------------------------------------------------------
describe("#1497 Argolio - PORTEE 3 + COUP DE GRACE : 1 degat a toutes les invocations adverses", () => {
  it("PORTEE : Argolio arrive avec une portee de tir de 3 (4 AT / 4 PV / 3 PM)", () => {
    card(1497);
    const s0 = bareBoard(scenario([], 1497));
    const s = playCard(s0, card(1497), { x: 8, y: 2 });
    const argo = s.creatures.find((c) => c.cardId === 1497)!;
    expect(argo.range).toBe(3);
    expect(argo.currentAttack).toBe(4);
    expect(argo.currentLife).toBe(4);
    expect(argo.baseMovement).toBe(3);
  });

  // "TOUTES les invocations adverses": everywhere on the board, not only around
  // Argolio. "adverses": the camp opposite Argolio's; its allies and itself take
  // nothing.
  const monter = () => {
    card(1497);
    const argo = mkCreature(1, "ally", { x: 6, y: 2 }, {
      cardId: 1497, triggers: card(1497).triggers ?? [],
      currentAttack: 4, baseAttack: 4, currentLife: 4, baseLife: 4, range: 3,
    });
    const ennemiProche = mkCreature(2, "enemy", { x: 4, y: 2 }, { currentLife: 5, baseLife: 5 });
    const ennemiLoin = mkCreature(3, "enemy", { x: 1, y: 4 }, { currentLife: 5, baseLife: 5 });
    const allie = mkCreature(4, "ally", { x: 7, y: 0 }, { currentLife: 5, baseLife: 5 });
    const avant = bareBoard(scenario([argo, ennemiProche, ennemiLoin, allie]));
    return { avant, apres: runTrigger(avant, "COUP_DE_GRACE", 1) };
  };

  it("toutes les invocations ADVERSES perdent 1 PV, ou qu'elles soient", () => {
    const { apres: s } = monter();
    expect(byId(s, 2)!.currentLife).toBe(4); // 5 - 1
    expect(byId(s, 3)!.currentLife).toBe(4); // 5 - 1, a l'autre bout du plateau
  });

  it("les invocations alliees et Argolio lui-meme ne sont pas touches", () => {
    const { apres: s } = monter();
    expect(byId(s, 4)!.currentLife).toBe(5);
    expect(byId(s, 1)!.currentLife).toBe(4); // ses PV imprimes, intacts
  });

  it("aucun Dofus n'est touche (les degats ne visent jamais un Dofus sans mention)", () => {
    const { avant, apres } = monter();
    expect(apres.dofuses.map((d) => d.currentLife)).toEqual(avant.dofuses.map((d) => d.currentLife));
  });

  it("l'armure de la cible absorbe le degat (pas de PERCE ARMURE dans le texte)", () => {
    card(1497);
    const argo = mkCreature(1, "ally", { x: 6, y: 2 }, {
      cardId: 1497, triggers: card(1497).triggers ?? [],
      currentAttack: 4, baseAttack: 4, currentLife: 4, baseLife: 4, range: 3,
    });
    const blinde = mkCreature(2, "enemy", { x: 4, y: 2 }, { currentLife: 5, baseLife: 5, armor: 2 });
    const s = runTrigger(bareBoard(scenario([argo, blinde])), "COUP_DE_GRACE", 1);
    expect(byId(s, 2)!.armor).toBe(1);       // 2 - 1 absorbe
    expect(byId(s, 2)!.currentLife).toBe(5); // PV intacts
  });

  // The tests above force the trigger by hand (runTrigger). This one goes through the
  // real path: Argolio shoots at 3 cells, kills, and the COUP DE GRACE fires on its own
  // from the end-of-turn combat. So it checks both keywords at once: "PORTEE : 3" (it
  // hits without moving) and "COUP DE GRACE" (the trigger really exists on a kill).
  it("VRAI chemin : il tire a 3 cases sans avancer, et sa mise a mort declenche le COUP DE GRACE", () => {
    card(1497);
    const argo = mkCreature(1, "ally", { x: 6, y: 2 }, {
      cardId: 1497, triggers: card(1497).triggers ?? [],
      currentAttack: 4, baseAttack: 4, currentLife: 4, baseLife: 4,
      range: 3, baseMovement: 3, movementLeft: 3, hasAttacked: false,
    });
    // Target exactly 3 cells away (6 -> 3): in range, so hit without the shooter having
    // to move closer.
    const victime = mkCreature(2, "enemy", { x: 3, y: 2 }, {
      currentLife: 1, baseLife: 1, currentAttack: 0, baseAttack: 0,
    });
    const autreEnnemi = mkCreature(3, "enemy", { x: 1, y: 4 }, { currentLife: 5, baseLife: 5 });
    const s = endTurn(bareBoard(withDecks(scenario([argo, victime, autreEnnemi]))));
    expect(byId(s, 2)).toBeUndefined();                   // abattue a distance
    expect(byId(s, 1)!.position).toEqual({ x: 6, y: 2 }); // it did not move: that is the PORTEE
    expect(byId(s, 3)!.currentLife).toBe(4);              // 5 - 1 : le COUP DE GRACE est bien parti
  });
});

// ---------------------------------------------------------------------------
// #1634 Petit Coffre: « RESISTANCE : @resistance@ / MORT : Depose un Butin allie
// sur la premiere case de sa ligne. »
// ---------------------------------------------------------------------------
// Both abilities are generic and already used by #711 Coffre Tirelire, but no test
// names #1634: one test per card is the only safety net if the shipped data drifts.
// The enemy side of the drop, which #711 does not cover, is added as well.
describe("#1634 Petit Coffre - RESISTANCE 1 + MORT : Butin sur la premiere case de sa ligne", () => {
  it("pose : il arrive avec RESISTANCE 1 cuite a l'invocation (2 AT / 1 PV / 3 PM, aucune armure)", () => {
    card(1634);
    const s = playCard(bareBoard(scenario([], 1634)), card(1634), { x: 8, y: 2 });
    const coffre = s.creatures.find((c) => c.cardId === 1634)!;
    expect(coffre.resistance).toBe(1);
    expect(coffre.armor).toBe(0); // RESISTANCE is not armour: there is nothing to use up
    expect(coffre.currentAttack).toBe(2);
    expect(coffre.currentLife).toBe(1);
    expect(coffre.baseMovement).toBe(3);
  });

  // The Coffre is placed by the engine, so its resistance comes from the card. An enemy
  // comes to hit it the next turn (two endTurn: the first ends the ally turn, the
  // second makes the opponent advance).
  const frappePar = (attaque: number) => {
    card(1634);
    let s = playCard(bareBoard(withDecks(scenario([], 1634))), card(1634), { x: 8, y: 2 });
    const frappeur = mkCreature(80, "enemy", { x: 7, y: 2 }, {
      currentLife: 9, baseLife: 9, currentAttack: attaque, baseAttack: attaque,
    });
    s = { ...s, creatures: [...s.creatures, frappeur] };
    const apres = endTurn(endTurn(s));
    return { apres, coffre: apres.creatures.find((c) => c.cardId === 1634) };
  };

  it("RESISTANCE 1 : un coup de 1 est entierement absorbe, le Coffre a 1 PV survit", () => {
    const { apres, coffre } = frappePar(1);
    expect(coffre).toBeDefined();
    expect(coffre!.currentLife).toBe(1); // 1 damage - 1 resistance = 0
    // Proof that the hit happened: the Coffre hit back with its 2 AT.
    expect(byId(apres, 80)!.currentLife).toBe(7); // 9 - 2
  });

  it("RESISTANCE 1 : un coup de 2 passe pour 1 et tue le Coffre (la reduction vaut 1, pas plus)", () => {
    const { coffre } = frappePar(2);
    expect(coffre).toBeUndefined(); // 2 - 1 = 1 degat sur 1 PV
  });

  const mourir = (camp: "ally" | "enemy", at: { x: number; y: number }) => {
    card(1634);
    const coffre = mkCreature(1, camp, at, {
      cardId: 1634, triggers: card(1634).triggers ?? [],
      currentLife: 1, baseLife: 1, currentAttack: 2, baseAttack: 2,
    });
    const base = bareBoard(scenario([coffre]));
    const creatures = base.creatures.map((c) => (c.instanceId === 1 ? { ...c, currentLife: 0 } : c));
    return resolveDeathsAndWin(base, creatures, base.dofuses, [...base.log], new Set());
  };

  it("MORT : un Butin ALLIE apparait sur la premiere case de SA ligne (x=8, meme y)", () => {
    const s = mourir("ally", { x: 5, y: 3 });
    const butins = s.butins ?? [];
    expect(butins).toHaveLength(1);
    expect(butins[0].position).toEqual({ x: 8, y: 3 }); // the row of the dead creature, not another one
    expect(butins[0].owner).toBe("ally");
  });

  it("MORT cote ADVERSE : le Butin appartient a son controleur et tombe sur SA premiere case (x=1)", () => {
    const s = mourir("enemy", { x: 4, y: 0 });
    const butins = s.butins ?? [];
    expect(butins).toHaveLength(1);
    expect(butins[0].position).toEqual({ x: 1, y: 0 });
    expect(butins[0].owner).toBe("enemy");
  });

  it("MORT : rien ne tombe si la premiere case de la ligne est deja occupee", () => {
    card(1634);
    const coffre = mkCreature(1, "ally", { x: 5, y: 3 }, {
      cardId: 1634, triggers: card(1634).triggers ?? [], currentLife: 1, baseLife: 1,
    });
    const bloqueur = mkCreature(2, "ally", { x: 8, y: 3 }, { currentLife: 5, baseLife: 5 });
    const base = bareBoard(scenario([coffre, bloqueur]));
    const creatures = base.creatures.map((c) => (c.instanceId === 1 ? { ...c, currentLife: 0 } : c));
    const s = resolveDeathsAndWin(base, creatures, base.dofuses, [...base.log], new Set());
    expect(s.butins ?? []).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// #1681 Persan, « MORT : Invoque un Chacha Noir. »
// ---------------------------------------------------------------------------
describe("#1681 Persan - MORT : Invoque un Chacha Noir", () => {
  // #135 Chacha Noir: 1 AT / 2 HP / 6 PM. The "near / MORT" placement happens on the
  // cell of the dead creature.
  const tuer = (camp: "ally" | "enemy", at: { x: number; y: number }) => {
    card(1681); card(135);
    const persan = mkCreature(1, camp, at, {
      cardId: 1681, triggers: card(1681).triggers ?? [],
      currentAttack: 4, baseAttack: 4, currentLife: 1, baseLife: 2,
    });
    const base = bareBoard(scenario([persan]));
    const creatures = base.creatures.map((c) => (c.instanceId === 1 ? { ...c, currentLife: 0 } : c));
    return resolveDeathsAndWin(base, creatures, base.dofuses, [...base.log], new Set());
  };

  it("la mort du Persan allie fait apparaitre UN Chacha Noir allie sur sa case", () => {
    const s = tuer("ally", { x: 6, y: 2 });
    expect(byId(s, 1)).toBeUndefined(); // le Persan est bien mort
    const chachas = s.creatures.filter((c) => c.cardId === 135);
    expect(chachas).toHaveLength(1); // « UN Chacha Noir »
    expect(chachas[0].owner).toBe("ally");
    expect(chachas[0].position).toEqual({ x: 6, y: 2 });
  });

  it("le Chacha Noir invoque a bien les caracteristiques de la carte #135 (1 AT / 2 PV / 6 PM)", () => {
    const s = tuer("ally", { x: 6, y: 2 });
    const chacha = s.creatures.find((c) => c.cardId === 135)!;
    expect(chacha.currentAttack).toBe(1);
    expect(chacha.currentLife).toBe(2);
    expect(chacha.baseMovement).toBe(6);
  });

  it("un Persan ADVERSE invoque un Chacha Noir ADVERSE (l'invocation revient a son controleur)", () => {
    const s = tuer("enemy", { x: 3, y: 2 });
    const chachas = s.creatures.filter((c) => c.cardId === 135);
    expect(chachas).toHaveLength(1);
    expect(chachas[0].owner).toBe("enemy");
    expect(chachas[0].position).toEqual({ x: 3, y: 2 });
  });

  it("VRAI chemin : tue au corps a corps, le Chacha Noir prend sa case et bloque le tueur", () => {
    card(1681); card(135);
    const persan = mkCreature(1, "ally", { x: 6, y: 2 }, {
      cardId: 1681, triggers: card(1681).triggers ?? [],
      currentAttack: 0, baseAttack: 0, currentLife: 1, baseLife: 2,
      movementLeft: 0, baseMovement: 0, hasAttacked: true,
    });
    const tueur = mkCreature(2, "enemy", { x: 5, y: 2 }, {
      currentLife: 6, baseLife: 6, currentAttack: 3, baseAttack: 3,
    });
    // Two endTurn: the first ends the ally turn, the second makes the enemy advance into
    // contact with the Persan.
    const s = endTurn(endTurn(bareBoard(withDecks(scenario([persan, tueur])))));
    expect(byId(s, 1)).toBeUndefined();
    const chachas = s.creatures.filter((c) => c.cardId === 135);
    expect(chachas).toHaveLength(1);
    expect(chachas[0].owner).toBe("ally");
    expect(chachas[0].position).toEqual({ x: 6, y: 2 });  // la case du mort
    expect(byId(s, 2)!.position).toEqual({ x: 5, y: 2 }); // the killer cannot move into it
  });
});

// ---------------------------------------------------------------------------
// #1739 Jahash: « APPARITION : Place dans votre main le premier sort de votre
// pioche, il coute 3 PA de moins. »
// ---------------------------------------------------------------------------
describe("#1739 Jahash - APPARITION : le premier SORT de la pioche en main, a -3 PA", () => {
  // The "premier sort de votre pioche" = the first one you would draw, so starting
  // from the top. drawCardFrom does deck.pop(): the top is the end of the array,
  // index 0 is the bottom.
  // #8 Fleche Criblante = a 5 AP spell; #58 Pollinisation = a 7 AP spell;
  // #16 Bebe Phorreur = a 2 AP summon (not a spell, must be skipped).
  const jouer = (deck: number[], creatures: ReturnType<typeof mkCreature>[] = [], ap = 10) => {
    card(1739); card(8); card(58); card(16);
    const base = bareBoard(scenario(creatures, 1739));
    const s0 = {
      ...base,
      players: {
        ...base.players,
        ally: { ...base.players.ally, deck, deckCostMods: deck.map(() => 0), hand: [1739], handCostMods: [0], ap, maxAp: ap },
      },
    };
    return playCard(s0, card(1739), { x: 8, y: 2 });
  };

  it("prend le sort le plus haut dans la pioche, pas celui du fond", () => {
    // Deck (bottom -> top): #58 (spell), #16 (summon), #8 (spell).
    // The first spell drawn would be #8, so that is the one that comes to the hand.
    const s = jouer([58, 16, 8]);
    expect(s.players.ally.hand).toContain(8);
    expect(s.players.ally.hand).not.toContain(58);
    expect(s.players.ally.deck).toEqual([58, 16]);
  });

  it("le sort tutore coute 3 PA de moins", () => {
    const s = jouer([58, 16, 8]);
    const idx = s.players.ally.hand.indexOf(8);
    expect(s.players.ally.handCostMods[idx]).toBe(-3);
  });

  it("la remise de 3 PA est reellement payee : la Fleche Criblante (5 PA) n'en coute que 2", () => {
    // The keyword only counts if it changes the price when the card is played: we really
    // play it and look at the AP spent.
    const cible = mkCreature(60, "enemy", { x: 4, y: 2 }, { currentLife: 9, baseLife: 9 });
    const s0 = jouer([58, 16, 8], [cible], 20);
    expect(s0.players.ally.ap).toBe(14); // 20 - 6 (Jahash)
    const s = playCard(s0, card(8), { x: 4, y: 2 });
    expect(s.players.ally.ap).toBe(12);  // 14 - (5 - 3), et non 14 - 5
  });

  it("saute les INVOCATIONS de la pioche : « le premier SORT »", () => {
    // Deck (bottom -> top): #8 (spell), #16 (summon). The top is a summon: it is
    // skipped, and #8 comes up.
    const s = jouer([8, 16]);
    expect(s.players.ally.hand).toContain(8);
    expect(s.players.ally.deck).toEqual([16]);
    expect(s.players.ally.handCostMods[s.players.ally.hand.indexOf(8)]).toBe(-3);
  });

  it("une pioche sans aucun sort : rien ne monte en main, la pioche est intacte", () => {
    const s = jouer([16, 16]);
    expect(s.players.ally.hand).toEqual([]); // Jahash lui-meme a quitte la main
    expect(s.players.ally.deck).toEqual([16, 16]);
  });

  it("un seul sort monte (« LE premier sort »), pas tous ceux de la pioche", () => {
    // Two spells in the deck: only the one on top must come up.
    const s = jouer([58, 8]);
    expect(s.players.ally.hand).toEqual([8]);
    expect(s.players.ally.deck).toEqual([58]);
  });

  it("Jahash arrive avec ses caracteristiques imprimees (4 AT / 5 PV / 3 PM)", () => {
    const s = jouer([58, 16, 8]);
    const jahash = s.creatures.find((c) => c.cardId === 1739)!;
    expect(jahash.currentAttack).toBe(4);
    expect(jahash.currentLife).toBe(5);
    expect(jahash.baseMovement).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// #1841 Lagoyave, « RALLIEMENT / PERCE ARMURE »
// ---------------------------------------------------------------------------
describe("#1841 Lagoyave - RALLIEMENT + PERCE ARMURE", () => {
  // The two keywords are not in card.properties: they come from two SetPropertyData
  // in card.effects. So the first thing to check is that both land on the placed copy.
  it("l'exemplaire pose porte les DEUX mots-cles (3 AT / 4 PV / 3 PM)", () => {
    card(1841);
    const s0 = bareBoard(scenario([], 1841));
    const s = playCard(s0, card(1841), { x: 8, y: 2 });
    const lago = s.creatures.find((c) => c.cardId === 1841)!;
    expect(lago.properties.has("Ralliement")).toBe(true);
    expect(lago.properties.has("PierceArmor")).toBe(true);
    expect(lago.currentAttack).toBe(3);
    expect(lago.currentLife).toBe(4);
    expect(lago.baseMovement).toBe(3);
    expect(lago.position).toEqual({ x: 8, y: 2 }); // aucun allie a rallier : il reste pose
  });

  it("RALLIEMENT : pose sur une ligne adjacente a un allie RALLIEMENT plus avance, il remonte a sa colonne", () => {
    card(1841);
    const avance = mkCreature(60, "ally", { x: 5, y: 1 }, { properties: new Set(["Ralliement"]) });
    const s0 = bareBoard(scenario([avance], 1841));
    const s = playCard(s0, card(1841), { x: 8, y: 2 });
    const lago = s.creatures.find((c) => c.cardId === 1841)!;
    expect(lago.position).toEqual({ x: 5, y: 2 });
  });

  it("temoin : le meme allie avance SANS le mot-cle ne declenche aucun ralliement", () => {
    // Proof that the previous test really measures RALLIEMENT and not just any advance
    // toward the furthest ally.
    card(1841);
    const avance = mkCreature(60, "ally", { x: 5, y: 1 }, { properties: new Set() });
    const s0 = bareBoard(scenario([avance], 1841));
    const s = playCard(s0, card(1841), { x: 8, y: 2 });
    const lago = s.creatures.find((c) => c.cardId === 1841)!;
    expect(lago.position).toEqual({ x: 8, y: 2 });
  });

  // PERCE ARMURE : les degats portes ignorent l'ARMURE de la cible.
  const combat = (pierce: boolean) => {
    card(1841);
    const blinde = mkCreature(70, "enemy", { x: 4, y: 2 }, {
      currentLife: 5, baseLife: 5, armor: 3,
      currentAttack: 0, baseAttack: 0, movementLeft: 0, baseMovement: 0, hasAttacked: true,
    });
    let s = bareBoard(withDecks(scenario([blinde], 1841)));
    if (pierce) {
      // The real Lagoyave, placed by the engine (its keywords come from the card).
      s = playCard(s, card(1841), { x: 8, y: 2 });
      s = {
        ...s,
        creatures: s.creatures.map((c) =>
          c.cardId === 1841 ? { ...c, position: { x: 5, y: 2 }, hasAttacked: false, movementLeft: 3 } : c),
      };
    } else {
      // Control: same AT, same place, but without the keyword.
      const temoin = mkCreature(71, "ally", { x: 5, y: 2 }, {
        currentAttack: 3, baseAttack: 3, currentLife: 4, baseLife: 4,
        movementLeft: 3, baseMovement: 3, hasAttacked: false,
      });
      s = { ...s, creatures: [...s.creatures, temoin] };
    }
    return endTurn(s);
  };

  it("PERCE ARMURE : les 3 degats de Lagoyave ignorent l'armure et entament les PV", () => {
    const s = combat(true);
    expect(byId(s, 70)!.armor).toBe(3);       // armure intacte : elle est ignoree
    expect(byId(s, 70)!.currentLife).toBe(2); // 5 - 3
  });

  it("temoin sans PERCE ARMURE : les memes 3 degats sont absorbes par l'armure", () => {
    const s = combat(false);
    expect(byId(s, 70)!.armor).toBe(0);       // 3 - 3 absorbes
    expect(byId(s, 70)!.currentLife).toBe(5); // PV intacts
  });
});

