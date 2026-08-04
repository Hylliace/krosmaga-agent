// Coverage for cards that are wired in the engine but were not used in any test:
// #567 #568 #571 #577 #605 #661 #671 #673 #687 #692 #706 #712
//
// Each assertion comes from the card's text, never from what the engine does.
// When the text and the engine disagree, the test is not bent to match the
// engine (see #567 and #568 below).
import { describe, it, expect } from "vitest";
import { card, mkCreature, scenario, byId } from "../testkit";
import { playCard, endTurn, canPlayCard, withAuras, resolvePendingAction, validPendingTargets } from "../rules";
import type { GameState } from "../state";

// scenario() leaves the decks empty: an endTurn would draw from an empty deck and
// trigger FATIGUE, which would hit the Dofus and pollute the assertions. Both
// decks are filled with neutral cards (#16 Bebe Phorreur).
const withDecks = (s: GameState, allyDeck: number[] = [16, 16, 16, 16]): GameState => ({
  ...s,
  players: {
    ...s.players,
    ally: { ...s.players.ally, deck: allyDeck },
    enemy: { ...s.players.enemy, deck: [16, 16, 16, 16] },
  },
});

// The ground objects placed by default (prisms) get in the way of the end-of-turn
// moves, so the board is cleared.
const bareBoard = (s: GameState): GameState => ({ ...s, prisms: [], seeds: [], butins: [] });

// Setup to know about: the FRATRIE keyword (#577 / #605 / #673 / #687).
// In rules.ts: when a FRATRIE creature is played while at least one enemy creature
// is still alive, the engine holds the summon and first opens an optional pick
// ("target an enemy creature, all its copies in the enemy deck go to their
// discard"). With no enemy in play there is no pick and the creature lands at once,
// which is why this helper is conditional. This mill pick has nothing to do with
// the abilities tested below: we decline it by clicking a free cell, which places
// the creature (and so fires its APPARITION). Without declining, the creature never
// lands and a naive test would pass without testing anything.
const declineFratrie = (s: GameState): GameState =>
  s.pendingAction?.summonAfter ? resolvePendingAction(s, { x: 5, y: 4 }) : s;

// ---------------------------------------------------------------------------
// #567 Piege Boomerang: no test, the card is not implemented.
// Text: « Inflige 2 degats. | Recuperez ce piege si vous avez au moins
// 3 cartes dans votre defausse. » cardType = Aoe, castTarget = EmptyAlliedCells:
// it is a ground object placed on an empty cell of your own camp (same shape as
// the Graine #35 or the Bombe #101), dealing its 2 damage to whoever walks on it.
// Its data is only [DamageData 2]: no placement effect (PlaceTrap / PlaceBombe /
// PlaceGlyph), so nothing fills state.traps, and no executor reads the condition
// "au moins 3 cartes dans votre defausse" (567 appears nowhere in rules.ts /
// effects.ts). In practice canPlayCard on an empty allied cell (x=7) returns
// "Aucune cible sur cette case." (the cell its castTarget asks for is exactly the
// one where it cannot be played), while canPlayCard on an enemy creature returns
// null and takes 2 HP from it, after which state.traps stays empty and the card goes
// to the discard and never comes back. Both halves of the text (placing the trap,
// getting it back under a condition) are missing: any passing test written here
// would lock in a direct damage spell that the text does not describe. So no test.
// ---------------------------------------------------------------------------

describe("#568 Piou Bleu, APPARITION : +1 Armure a une AUTRE invocation alliee", () => {
  // Text: « APPARITION : Confere +1 Armure a une autre invocation alliee. »
  // Three qualifiers: the amount (+1 AR), excluding itself ("autre"), and the camp
  // ("alliee"). The engine does not respect the camp (the pick is opened as
  // any_creature), so only the part that matches the text is tested here.
  const build = () => {
    const allie = mkCreature(1, "ally", { x: 6, y: 2 }, { currentLife: 5, baseLife: 5, armor: 0 });
    let s = bareBoard(withDecks(scenario([allie], 568)));
    s = playCard(s, card(568), { x: 8, y: 2 });
    return resolvePendingAction(s, { x: 6, y: 2 });
  };

  it("l'invocation alliee designee gagne exactement +1 Armure", () => {
    const s = build();
    expect(byId(s, 1)!.armor).toBe(1);
  });

  it("« une AUTRE invocation » : la case de pose du Piou n'est pas une cible offerte", () => {
    // Strong assertion: it is not enough to see that the Piou ends with 0 AR (it would
    // end at 0 with any engine, since the ally was the one picked); the list of legal
    // targets is checked before choosing.
    const allie = mkCreature(1, "ally", { x: 6, y: 2 }, { currentLife: 5, baseLife: 5, armor: 0 });
    let s = bareBoard(withDecks(scenario([allie], 568)));
    s = playCard(s, card(568), { x: 8, y: 2 });
    const cibles = validPendingTargets(s);
    expect(cibles).toContainEqual({ x: 6, y: 2 });          // l'autre invocation, oui
    expect(cibles).not.toContainEqual({ x: 8, y: 2 });      // sa propre case, non
  });

  it("le Piou Bleu arrive sur le plateau avec ses stats imprimees et 0 Armure", () => {
    const s = build();
    const piou = s.creatures.find((c) => c.cardId === 568)!;
    expect(piou.armor).toBe(0);
    expect(piou.currentLife).toBe(card(568).life);
    expect(piou.currentAttack).toBe(card(568).attack);
  });
});

describe("#571 Muloune, APPARITION : place en main le PREMIER Mulou de la pioche", () => {
  // Text: « APPARITION : Place dans votre main le premier Mulou de votre pioche. »
  // "premier" = the next one that would be drawn, so the closest to the top.
  // drawCardFrom does deck.pop(): the top is the end of the array.
  // Deck: [#284 Mulou (bottom), #16, #42 Milimulou (Mulou), #16 (top)]
  // -> the first Mulou met going down from the top is #42, not #284.
  const build = () => {
    let s = bareBoard(withDecks(scenario([], 571), [284, 16, 42, 16]));
    return playCard(s, card(571), { x: 8, y: 2 });
  };

  it("remonte le Mulou le plus proche du dessus de la pioche (#42), pas celui du fond", () => {
    card(42); card(284);
    const s = build();
    expect(s.players.ally.hand).toContain(42);
    expect(s.players.ally.hand).not.toContain(284);
  });

  it("la carte tutoree quitte la pioche ; les non-Mulou y restent", () => {
    const s = build();
    expect(s.players.ally.deck).not.toContain(42);
    expect(s.players.ally.deck).toContain(284); // l'autre Mulou est reste au fond
    expect(s.players.ally.deck.filter((c) => c === 16).length).toBe(2); // les neutres intacts
  });

  it("le tutorage est bien restreint a la famille Mulou : sans Mulou en pioche, rien ne remonte", () => {
    // Qualifier "le premier MULOU": a deck of neutral cards (#16 Phorreur) must give
    // nothing. Without the family filter the top card would come up, which is exactly
    // the mutant the previous test kills.
    let s = bareBoard(withDecks(scenario([], 571), [16, 16, 16, 16]));
    s = playCard(s, card(571), { x: 8, y: 2 });
    expect(s.players.ally.hand).toEqual([]);
    expect(s.players.ally.deck).toEqual([16, 16, 16, 16]);
  });
});

describe("#577 Echo (2 etoiles), tant qu'elle est en jeu, l'AT des invocations ADVERSES est reduite de 1", () => {
  // Text: « FRATRIE / Tant qu'elle est en jeu, l'AT des invocations adverses est
  // reduite de 1. » Qualifiers: the camp (enemies only), itself (Echo is in its own
  // camp, so untouched), and the duration ("tant qu'elle est en jeu": the penalty
  // goes away when it leaves the board).
  const board = () => [
    mkCreature(1, "ally", { x: 6, y: 2 }, { cardId: 577, currentAttack: 2, baseAttack: 2, printedAttack: 2, currentLife: 5, baseLife: 5 }),
    mkCreature(2, "enemy", { x: 3, y: 2 }, { currentAttack: 3, baseAttack: 3, printedAttack: 3, currentLife: 5, baseLife: 5 }),
    mkCreature(3, "ally", { x: 7, y: 2 }, { currentAttack: 3, baseAttack: 3, printedAttack: 3, currentLife: 5, baseLife: 5 }),
  ];

  it("une invocation ADVERSE perd 1 AT", () => {
    card(577);
    const cs = withAuras(board());
    expect(cs.find((c) => c.instanceId === 2)!.currentAttack).toBe(2); // 3 - 1
  });

  it("une invocation ALLIEE ne perd rien", () => {
    card(577);
    const cs = withAuras(board());
    expect(cs.find((c) => c.instanceId === 3)!.currentAttack).toBe(3);
  });

  it("Echo elle-meme garde son AT (elle n'est pas « adverse » d'elle-meme)", () => {
    card(577);
    const cs = withAuras(board());
    expect(cs.find((c) => c.instanceId === 1)!.currentAttack).toBe(card(577).attack);
  });

  it("« tant qu'elle est en jeu » : Echo partie, l'ennemi retrouve ses 3 AT", () => {
    card(577);
    const withEcho = withAuras(board());
    expect(withEcho.find((c) => c.instanceId === 2)!.currentAttack).toBe(2);
    const withoutEcho = withAuras(withEcho.filter((c) => c.instanceId !== 1));
    expect(withoutEcho.find((c) => c.instanceId === 2)!.currentAttack).toBe(3);
  });
});

describe("#687 Echo (3 etoiles), le malus d'AT se voit sur les degats reellement portes", () => {
  // Same text as #577, checked here through combat: an enemy creature with 3 AT must
  // only deal 2 damage while Echo is in play.
  const setup = (avecEcho: boolean) => {
    card(687);
    const echo = mkCreature(1, "ally", { x: 8, y: 0 }, {
      cardId: 687, currentAttack: 3, baseAttack: 3, currentLife: 5, baseLife: 5,
      movementLeft: 0, baseMovement: 0,
    });
    // Allied punching bag: 10 HP, 0 AT (so no hit back muddles the HP).
    const sac = mkCreature(2, "ally", { x: 8, y: 1 }, {
      currentAttack: 0, baseAttack: 0, currentLife: 10, baseLife: 10,
      movementLeft: 0, baseMovement: 0,
    });
    // The enemy starts two cells away from the bag: otherwise it would already be in
    // contact during the ally turn and a first exchange would skew the count.
    const foe = mkCreature(3, "enemy", { x: 6, y: 1 }, {
      currentAttack: 3, baseAttack: 3, currentLife: 10, baseLife: 10,
      movementLeft: 2, baseMovement: 2, hasAttacked: false,
    });
    const cs = avecEcho ? [echo, sac, foe] : [sac, foe];
    // Two endTurn: the first ends the ally turn, the second makes the enemy advance
    // into contact with the punching bag.
    return endTurn(endTurn(bareBoard(withDecks(scenario(cs)))));
  };

  it("sans Echo, l'ennemi a 3 AT inflige bien 3 degats (temoin)", () => {
    const s = setup(false);
    expect(byId(s, 2)!.currentLife).toBe(7); // 10 - 3
  });

  it("avec Echo en jeu, le meme ennemi n'inflige plus que 2 degats", () => {
    const s = setup(true);
    expect(byId(s, 3)!.currentAttack).toBe(2); // 3 - 1
    expect(byId(s, 2)!.currentLife).toBe(8);   // 10 - 2
  });
});

describe("#605 Toxine, APPARITION : detruit les invocations PEU COMMUNES en jeu", () => {
  // Text: « FRATRIE / APPARITION : Detruit les invocations peu communes en jeu. »
  // "peu commune" = Silver rarity. "en jeu" does not limit the camp: both camps are
  // hit. The other rarities are spared.
  // Controls: #219 Bouftou Noir (Silver), #348 Renate (Common), #752 Samson Deur
  // (Gold); none has an effect or a trigger.
  const build = () => {
    card(219); card(348); card(752);
    const silverAllie = mkCreature(1, "ally", { x: 6, y: 0 }, { cardId: 219, currentLife: 3, baseLife: 3 });
    const silverEnnemi = mkCreature(2, "enemy", { x: 3, y: 0 }, { cardId: 219, currentLife: 3, baseLife: 3 });
    const commun = mkCreature(3, "ally", { x: 6, y: 1 }, { cardId: 348, currentLife: 1, baseLife: 1 });
    const or = mkCreature(4, "enemy", { x: 3, y: 1 }, { cardId: 752, currentLife: 3, baseLife: 3 });
    const s = bareBoard(withDecks(scenario([silverAllie, silverEnnemi, commun, or], 605)));
    return declineFratrie(playCard(s, card(605), { x: 8, y: 2 }));
  };

  it("detruit la peu commune ALLIEE", () => {
    expect(byId(build(), 1)).toBeUndefined();
  });

  it("detruit la peu commune ADVERSE (« en jeu » ne restreint pas le camp)", () => {
    expect(byId(build(), 2)).toBeUndefined();
  });

  it("epargne une COMMUNE et une rarete or", () => {
    const s = build();
    expect(byId(s, 3)!.currentLife).toBe(1);
    expect(byId(s, 4)!.currentLife).toBe(3);
  });

  it("Toxine elle-meme (Infinite) survit a sa propre APPARITION", () => {
    const s = build();
    const toxine = s.creatures.find((c) => c.cardId === 605)!;
    expect(toxine.currentLife).toBe(card(605).life);
  });
});

describe("#661 Goultard, INITIATIVE", () => {
  // Text: « INITIATIVE » (the only text of the card). Goultard: 5 AT / 2 HP.
  // Against an enemy with 3 AT / 5 HP, initiative has to turn the exchange around:
  // Goultard hits first for 5, kills the enemy (5 HP), and so takes nothing. Without
  // initiative the exchange would be simultaneous and Goultard (2 HP) would die from
  // the 3 enemy AT.
  const setup = () => {
    const foe = mkCreature(2, "enemy", { x: 7, y: 2 }, {
      currentAttack: 3, baseAttack: 3, currentLife: 5, baseLife: 5,
      movementLeft: 2, baseMovement: 2, hasAttacked: false,
    });
    let s = bareBoard(withDecks(scenario([foe], 661)));
    s = playCard(s, card(661), { x: 8, y: 2 });
    // Two endTurn: the first ends the ally turn (Goultard has summoning sickness and
    // does not move), the second makes the enemy advance into contact.
    return endTurn(endTurn(s));
  };

  it("la propriete INITIATIVE (FirstStrike) est bien innee a la pose", () => {
    let s = bareBoard(withDecks(scenario([], 661)));
    s = playCard(s, card(661), { x: 8, y: 2 });
    const g = s.creatures.find((c) => c.cardId === 661)!;
    expect(g.properties.has("FirstStrike")).toBe(true);
  });

  it("frappe en premier : l'assaillant meurt ET Goultard reste debout", () => {
    // Both halves matter in the same test. "the attacker dies" alone would be empty:
    // Goultard's 5 AT kill its 5 HP with or without initiative, and the simultaneous
    // exchange would kill Goultard too. So the survival of the one hitting is the only
    // assertion that tells the two apart.
    const s = setup();
    expect(byId(s, 2)).toBeUndefined();
    expect(s.creatures.some((c) => c.cardId === 661)).toBe(true);
  });

  it("Goultard (2 PV) ressort de l'echange sans une egratignure", () => {
    const s = setup();
    const g = s.creatures.find((c) => c.cardId === 661)!;
    expect(g.currentLife).toBe(card(661).life); // 2 PV, aucun degat encaisse
  });
});

describe("#671 Piege Explosif Active, inflige 3 degats a VOS invocations", () => {
  // Text: « Inflige @damage:0@ a vos invocations. Vous avez 1 tour pour le jouer ou
  // vos Dofus subiront 1 degat. » The @damage:0@ template refers to the card's first
  // effect, so 3 damage. Main qualifier: "VOS" invocations, those of the player who
  // plays the card, not the other side's.
  const build = () => {
    const allie = mkCreature(1, "ally", { x: 6, y: 0 }, { currentLife: 5, baseLife: 5 });
    const petitAllie = mkCreature(2, "ally", { x: 6, y: 1 }, { currentLife: 2, baseLife: 2 });
    const ennemi = mkCreature(3, "enemy", { x: 3, y: 0 }, { currentLife: 5, baseLife: 5 });
    const s = bareBoard(withDecks(scenario([allie, petitAllie, ennemi], 671)));
    return playCard(s, card(671), { x: 5, y: 0 });
  };

  it("chaque invocation alliee encaisse 3 degats", () => {
    expect(byId(build(), 1)!.currentLife).toBe(2); // 5 - 3
  });

  it("une alliee a 2 PV en meurt", () => {
    expect(byId(build(), 2)).toBeUndefined();
  });

  it("les invocations ADVERSES ne sont pas touchees (« VOS invocations »)", () => {
    expect(byId(build(), 3)!.currentLife).toBe(5);
  });

  it("« a vos INVOCATIONS » : aucun Dofus n'est egratigne, ni le sien ni celui d'en face", () => {
    // General engine rule: damage only reaches a Dofus when the text says so. The text
    // of #671 only talks about creatures; the 1 damage penalty to the Dofus is the
    // other clause, the one about the trap not played in time.
    const avant = bareBoard(withDecks(scenario([], 671))).dofuses.map((d) => d.currentLife);
    expect(build().dofuses.map((d) => d.currentLife)).toEqual(avant);
  });
});

describe("#673 Oropo, MORT : place en main le DERNIER membre de la Fratrie des Oublies de la pioche", () => {
  // Text: « FRATRIE / MORT : Place dans votre main le dernier membre de la Fratrie des
  // Oublies de votre pioche. » "dernier" = the farthest from the top, so the bottom
  // of the deck = index 0 of the array.
  // Deck: [#680 Coqueline (Fratrie, bottom), #16, #100 Ush (Fratrie), #16].
  const setup = () => {
    card(673); card(680); card(100);
    // Bourreau adverse : 5 AT / 10 PV. Oropo a 2 PV, il mourra du premier coup.
    const foe = mkCreature(2, "enemy", { x: 7, y: 1 }, {
      currentAttack: 5, baseAttack: 5, currentLife: 10, baseLife: 10,
      movementLeft: 2, baseMovement: 2, hasAttacked: false,
    });
    let s = bareBoard(withDecks(scenario([foe], 673), [680, 16, 100, 16]));
    s = declineFratrie(playCard(s, card(673), { x: 8, y: 1 }));
    // Deux endTurn : le second fait avancer l'ennemi au contact et tue Oropo.
    return endTurn(endTurn(s));
  };

  it("Oropo meurt bien sous le coup adverse (le declencheur MORT peut partir)", () => {
    const s = setup();
    expect(s.creatures.some((c) => c.cardId === 673)).toBe(false);
  });

  it("remonte le membre de la Fratrie situe au FOND de la pioche (#680)", () => {
    const s = setup();
    expect(s.players.ally.hand).toContain(680);
    expect(s.players.ally.deck).not.toContain(680);
  });

  it("ne prend PAS le membre de la Fratrie plus proche du dessus (#100)", () => {
    const s = setup();
    expect(s.players.ally.hand).not.toContain(100);
    expect(s.players.ally.deck).toContain(100);
  });
});

describe("#692 Enracine, assomme une invocation pour 1 tour et lui confere INAMOVIBLE", () => {
  // Text: « Assomme une invocation pour 1 tour et lui confere inamovible. »
  // castTarget = AnySummon: the text does not limit the camp.
  // "pour 1 tour" only applies to the stun; "lui confere inamovible" has no duration.
  const cible = (side: "ally" | "enemy", pos: { x: number; y: number }) =>
    mkCreature(1, side, pos, {
      currentLife: 5, baseLife: 5, currentAttack: 1, baseAttack: 1,
      movementLeft: 2, baseMovement: 2, hasAttacked: false,
    });

  it("pose bien les DEUX proprietes d'un coup sur une invocation adverse", () => {
    let s = bareBoard(withDecks(scenario([cible("enemy", { x: 3, y: 2 })], 692)));
    s = playCard(s, card(692), { x: 3, y: 2 });
    expect(byId(s, 1)!.properties.has("Stunned")).toBe(true);
    expect(byId(s, 1)!.properties.has("Rooted")).toBe(true);
  });

  it("le texte ne restreint pas le camp : une invocation ALLIEE est une cible legale", () => {
    const s = bareBoard(withDecks(scenario([cible("ally", { x: 6, y: 2 })], 692)));
    expect(canPlayCard(s, card(692), { x: 6, y: 2 })).toBeNull();
    const after = playCard(s, card(692), { x: 6, y: 2 });
    expect(byId(after, 1)!.properties.has("Stunned")).toBe(true);
    expect(byId(after, 1)!.properties.has("Rooted")).toBe(true);
  });

  it("assommee « pour 1 tour » : elle n'avance pas a son tour, puis l'assommement tombe", () => {
    let s = bareBoard(withDecks(scenario([cible("enemy", { x: 3, y: 2 })], 692)));
    s = playCard(s, card(692), { x: 3, y: 2 });
    s = endTurn(s); // end of the ally turn -> it is the enemy's turn
    s = endTurn(s); // fin du tour ennemi : l'assommee aurait du avancer
    expect(byId(s, 1)!.position.x).toBe(3);                        // n'a pas bouge
    expect(byId(s, 1)!.properties.has("Stunned")).toBe(false);     // 1 tour, consomme
  });

  it("INAMOVIBLE reste apres la fin de l'assommement (aucune duree dans le texte)", () => {
    let s = bareBoard(withDecks(scenario([cible("enemy", { x: 3, y: 2 })], 692)));
    s = playCard(s, card(692), { x: 3, y: 2 });
    s = endTurn(endTurn(s));
    expect(byId(s, 1)!.properties.has("Rooted")).toBe(true);
  });

  it("temoin sans le sort : la meme invocation avance bien de ses 2 PM", () => {
    const s = endTurn(endTurn(bareBoard(withDecks(scenario([cible("enemy", { x: 3, y: 2 })])))));
    expect(byId(s, 1)!.position.x).toBe(5);
  });

  it("« UNE invocation » : la voisine ne recoit ni assommement ni inamovible", () => {
    const voisine = mkCreature(2, "enemy", { x: 3, y: 3 }, {
      currentLife: 5, baseLife: 5, movementLeft: 2, baseMovement: 2, hasAttacked: false,
    });
    let s = bareBoard(withDecks(scenario([cible("enemy", { x: 3, y: 2 }), voisine], 692)));
    s = playCard(s, card(692), { x: 3, y: 2 });
    expect(byId(s, 2)!.properties.has("Stunned")).toBe(false);
    expect(byId(s, 2)!.properties.has("Rooted")).toBe(false);
    // et elle avance normalement a son tour, contrairement a l'enracinee
    const apres = endTurn(endTurn(s));
    expect(byId(apres, 2)!.position.x).toBe(5);
    expect(byId(apres, 1)!.position.x).toBe(3);
  });
});

describe("#706 Uppercut, inflige 2 degats a une invocation ADVERSE", () => {
  // Text: « Inflige 2 degats a une invocation adverse. » castTarget = OpponentSummon:
  // an allied creature is not a legal target.
  // General engine rule: damage always goes through armour.
  it("la cible adverse perd exactement 2 PV", () => {
    const foe = mkCreature(1, "enemy", { x: 3, y: 2 }, { currentLife: 5, baseLife: 5 });
    let s = bareBoard(withDecks(scenario([foe], 706)));
    s = playCard(s, card(706), { x: 3, y: 2 });
    expect(byId(s, 1)!.currentLife).toBe(3); // 5 - 2
  });

  it("les degats passent d'abord par l'armure", () => {
    const foe = mkCreature(1, "enemy", { x: 3, y: 2 }, { currentLife: 5, baseLife: 5, armor: 1 });
    let s = bareBoard(withDecks(scenario([foe], 706)));
    s = playCard(s, card(706), { x: 3, y: 2 });
    expect(byId(s, 1)!.armor).toBe(0);
    expect(byId(s, 1)!.currentLife).toBe(4); // 1 absorbed by the armour, 1 on the HP
  });

  it("une invocation ALLIEE n'est pas une cible legale", () => {
    const ami = mkCreature(1, "ally", { x: 6, y: 2 }, { currentLife: 5, baseLife: 5 });
    const s = bareBoard(withDecks(scenario([ami], 706)));
    expect(canPlayCard(s, card(706), { x: 6, y: 2 })).not.toBeNull();
  });

  it("« UNE invocation adverse » : la seule ciblee encaisse, pas ses voisines", () => {
    const foe = mkCreature(1, "enemy", { x: 3, y: 2 }, { currentLife: 5, baseLife: 5 });
    const voisin = mkCreature(2, "enemy", { x: 3, y: 3 }, { currentLife: 5, baseLife: 5 });
    const derriere = mkCreature(3, "enemy", { x: 4, y: 2 }, { currentLife: 5, baseLife: 5 });
    let s = bareBoard(withDecks(scenario([foe, voisin, derriere], 706)));
    s = playCard(s, card(706), { x: 3, y: 2 });
    expect(byId(s, 1)!.currentLife).toBe(3);
    expect(byId(s, 2)!.currentLife).toBe(5);
    expect(byId(s, 3)!.currentLife).toBe(5);
  });
});

describe("#712 Piege Troublant, place un Piege Troublant Active dans la main de VOTRE ADVERSAIRE", () => {
  // Text: « Place un Piege Troublant Active dans la main de votre adversaire. » The
  // named card is #950 Piege Troublant Active, whose own text says « Vous avez 1 tour
  // pour le jouer ou vos Dofus subiront 1 degat », so counter 1, penalty 1, on the
  // caster's enemy camp.
  const build = () => {
    card(712); card(950);
    const sc = bareBoard(withDecks(scenario([], 712)));
    const base: GameState = {
      ...sc,
      players: {
        ...sc.players,
        enemy: { ...sc.players.enemy, hand: [], handCostMods: [], activeTraps: [] },
      },
    };
    return playCard(base, card(712), { x: 5, y: 0 });
  };

  it("c'est bien le #950 Piege Troublant Active qui atterrit", () => {
    expect(build().players.enemy.hand).toContain(950);
  });

  it("il va dans la main de l'ADVERSAIRE, pas dans celle du lanceur", () => {
    const s = build();
    expect(s.players.ally.hand).not.toContain(950);
  });

  it("il est arme chez l'adversaire pour 1 tour, penalite 1 sur ses Dofus", () => {
    expect(build().players.enemy.activeTraps).toEqual([{ cardId: 950, counter: 1, penalty: 1 }]);
  });

  it("non joue au bout d'un tour adverse, il explose : chaque Dofus adverse perd 1 PV", () => {
    let s = build();
    const avant = s.dofuses.filter((d) => d.owner === "enemy").map((d) => d.currentLife);
    s = endTurn(s); // fin du tour allie -> tour de l'adversaire
    s = endTurn(s); // l'adversaire finit son tour sans avoir joue le piege
    const apres = s.dofuses.filter((d) => d.owner === "enemy").map((d) => d.currentLife);
    expect(apres).toEqual(avant.map((v) => v - 1));
    expect(s.players.enemy.hand).not.toContain(950); // la carte quitte la main
  });

  it("quand il explose, ce sont « VOS Dofus » du point de vue du PORTEUR : ceux du lanceur sont intacts", () => {
    // The text of #950 says "vos Dofus": the holder of the trapped card is the
    // opponent, so the penalty falls on their Dofus. The caster's, who never had the
    // trap in hand, must lose nothing.
    let s = build();
    const avantLanceur = s.dofuses.filter((d) => d.owner === "ally").map((d) => d.currentLife);
    s = endTurn(endTurn(s));
    expect(s.dofuses.filter((d) => d.owner === "ally").map((d) => d.currentLife)).toEqual(avantLanceur);
  });
});
