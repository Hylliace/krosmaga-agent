// Coverage for cards that are wired in the engine but were not used in any test:
//   #753 #759 #768 #774 #783 #801 #813 #817 #825 #830 #831 #836
//
// Each assertion comes from the card's text, never from what the engine does. The
// qualifiers of the text (family, camp, "autres", "prochain" vs "dernier", rarity,
// "à côté", "d'une rangée") are tested one by one, not only the main case.
//
// The tutor setups put an off-family card at the targeted end of the deck on
// purpose: without it, the assertion "this is the one that comes up" would pass
// even if the family filter were removed from the engine.
import { describe, it, expect } from "vitest";
import { card, mkCreature, scenario, byId } from "../testkit";
import { playCard, endTurn, runTrigger, resolvePendingAction, resolveDeathsAndWin, DOFUS_LIFE } from "../rules";
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

// The ground objects placed by default (prisms) get in the way of the moves and the
// start cells, so the board is cleared.
const bareBoard = (s: GameState): GameState => ({ ...s, prisms: [], seeds: [], butins: [] });

// Explicit ally hand + plenty of AP (a summon never costs more than 6 here).
const allyHand = (s: GameState, ids: number[]): GameState => ({
  ...s,
  players: { ...s.players, ally: { ...s.players.ally, hand: [...ids], handCostMods: ids.map(() => 0), ap: 20, maxAp: 20 } },
});

// Same on the enemy side, with the enemy hand active (to make an enemy creature
// "enter play").
const enemyTurnHand = (s: GameState, ids: number[]): GameState => ({
  ...s,
  activeSide: "enemy",
  players: { ...s.players, enemy: { ...s.players.enemy, hand: [...ids], handCostMods: ids.map(() => 0), ap: 20, maxAp: 20 } },
});

describe("#753 Bouftou Chafer, TAS D'OS + APPARITION : place le PROCHAIN Chafer de la pioche dans la main", () => {
  // Text: « TAS D'OS / APPARITION : Place dans votre main le prochain Chafer de votre
  // pioche. »
  // Two qualifiers on the APPARITION: the family (Chafer) and "le PROCHAIN", the one
  // that would be drawn first. drawCardFrom does deck.pop(): the top of the deck is
  // the end of the array, the bottom is index 0.
  // Deck: [197 Chafer Lancier (bottom), 336 Chafer Archer, 16 Bébé Phorreur (top)].
  // The top is a non-Chafer on purpose: the engine has to skip it to get down to the
  // first Chafer. Without this screen card, the test would pass even if the family
  // filter disappeared.
  const play = () => {
    card(753); card(197); card(336);
    const s0 = allyHand(bareBoard(withDecks(scenario([]), [197, 336, 16])), [753]);
    return playCard(s0, card(753), { x: 8, y: 2 });
  };

  it("c'est le Chafer le plus proche du DESSUS qui monte en main (pas celui du fond)", () => {
    const s = play();
    expect(s.players.ally.hand).toEqual([336]); // #336 Chafer Archer, le prochain pioché
    expect(s.players.ally.deck).not.toContain(336);
  });

  it("la carte hors-famille posée AU-DESSUS du Chafer n'est pas prise (« un Chafer »)", () => {
    const s = play();
    expect(s.players.ally.hand).not.toContain(16);
    expect(s.players.ally.deck).toContain(16);
  });

  it("un seul Chafer part (« le prochain », au singulier) et le reste de la pioche est intact", () => {
    const s = play();
    expect(s.players.ally.hand.length).toBe(1);
    expect(s.players.ally.deck).toContain(197); // l'autre Chafer reste au fond
    expect(s.players.ally.deck.length).toBe(2);
  });

  it("aucun Chafer dans la pioche : rien ne monte en main", () => {
    card(753);
    const s0 = allyHand(bareBoard(withDecks(scenario([]), [16, 16, 16])), [753]);
    const s = playCard(s0, card(753), { x: 8, y: 2 });
    expect(s.players.ally.hand).toEqual([]);
    expect(s.players.ally.deck.length).toBe(3);
  });

  it("TAS D'OS : mort, il laisse un Tas d'Os de SON camp sur sa case", () => {
    // The keyword is the first word of the text: it belongs to this card, not only to
    // the generic mechanism, so we check that the card really has it.
    card(753);
    const bouftou = mkCreature(900, "ally", { x: 5, y: 1 }, { cardId: 753, currentLife: 0 });
    const sc = bareBoard(scenario([bouftou]));
    const res = resolveDeathsAndWin(sc, [bouftou], sc.dofuses, [], new Set());
    expect((res.tasDOs ?? []).some((t) => t.owner === "ally" && t.position.x === 5 && t.position.y === 1)).toBe(true);
  });
});

describe("#759 Gary Bûhl, APPARITION : invoque 2 Momies À CÔTÉ de lui", () => {
  // Text: « APPARITION : Invoque 2 Momies à côté de lui. »
  // "à côté" = the two side cells, same column (same x), y±1.
  it("les 2 Momies (#360) apparaissent sur les deux cases latérales de sa rangée", () => {
    card(759); card(360);
    const s0 = allyHand(bareBoard(withDecks(scenario([]))), [759]);
    const s = playCard(s0, card(759), { x: 8, y: 2 });
    const gary = s.creatures.find((c) => c.cardId === 759)!;
    expect(gary.position).toEqual({ x: 8, y: 2 });
    const momies = s.creatures.filter((c) => c.cardId === 360 && c.owner === "ally");
    expect(momies.length).toBe(2);
    expect(momies.map((m) => m.position).sort((a, b) => a.y - b.y)).toEqual([{ x: 8, y: 1 }, { x: 8, y: 3 }]);
  });

  it("une case latérale occupée : une seule Momie, sur la case libre restante", () => {
    card(759); card(360);
    const bloc = mkCreature(50, "ally", { x: 8, y: 1 }, {});
    const s0 = allyHand(bareBoard(withDecks(scenario([bloc]))), [759]);
    const s = playCard(s0, card(759), { x: 8, y: 2 });
    const momies = s.creatures.filter((c) => c.cardId === 360 && c.owner === "ally");
    expect(momies.length).toBe(1);
    expect(momies[0].position).toEqual({ x: 8, y: 3 });
    expect(byId(s, 50)!.position).toEqual({ x: 8, y: 1 }); // le bloqueur n'a pas bougé
  });

  it("posé sur le bord du plateau : une seule Momie, du côté qui existe", () => {
    // "à côté de lui" does not go off the board: on row 1 (y=0) there is only one side
    // neighbour. The engine must not make up for it somewhere else.
    card(759); card(360);
    const s0 = allyHand(bareBoard(withDecks(scenario([]))), [759]);
    const s = playCard(s0, card(759), { x: 8, y: 0 });
    const momies = s.creatures.filter((c) => c.cardId === 360 && c.owner === "ally");
    expect(momies.length).toBe(1);
    expect(momies[0].position).toEqual({ x: 8, y: 1 });
  });

  it("les deux côtés occupés : aucune Momie, mais Gary se pose quand même", () => {
    card(759); card(360);
    const haut = mkCreature(50, "ally", { x: 8, y: 1 }, {});
    const bas = mkCreature(51, "ally", { x: 8, y: 3 }, {});
    const s0 = allyHand(bareBoard(withDecks(scenario([haut, bas]))), [759]);
    const s = playCard(s0, card(759), { x: 8, y: 2 });
    expect(s.creatures.filter((c) => c.cardId === 360).length).toBe(0);
    expect(s.creatures.some((c) => c.cardId === 759)).toBe(true);
  });
});

describe("#768 Jeanne Houillère, RALLIEMENT + APPARITION : donne BOUCLIER à une invocation", () => {
  // Text: « RALLIEMENT / APPARITION : Donnez bouclier à une invocation. »
  // The text says "une invocation" with no camp limit, so the target can be an
  // enemy. And the shield goes to the target, not to Jeanne.
  const summon = (extra: ReturnType<typeof mkCreature>[]) => {
    card(768);
    const s0 = allyHand(bareBoard(withDecks(scenario(extra))), [768]);
    return playCard(s0, card(768), { x: 8, y: 2 });
  };

  it("elle porte bien le mot-clé RALLIEMENT et ne se donne PAS le bouclier à elle-même", () => {
    // The APPARITION choice has to be resolved for the creature to really be placed.
    const s = resolvePendingAction(summon([mkCreature(60, "ally", { x: 6, y: 2 }, {})]), { x: 6, y: 2 });
    const jeanne = s.creatures.find((c) => c.cardId === 768)!;
    expect(jeanne.properties.has("Ralliement")).toBe(true);
    expect(jeanne.properties.has("Shield")).toBe(false);
  });

  it("l'APPARITION ouvre un choix sur N'IMPORTE QUELLE invocation", () => {
    const s = summon([mkCreature(60, "ally", { x: 6, y: 2 }, {})]);
    expect(s.pendingAction!.filter).toBe("any_creature");
  });

  it("la cible ALLIÉE désignée gagne le bouclier", () => {
    let s = summon([mkCreature(60, "ally", { x: 6, y: 2 }, {})]);
    expect(byId(s, 60)!.properties.has("Shield")).toBe(false);
    s = resolvePendingAction(s, { x: 6, y: 2 });
    expect(byId(s, 60)!.properties.has("Shield")).toBe(true);
    expect(s.pendingAction).toBeNull();
  });

  it("une seule invocation reçoit le bouclier (« une invocation »)", () => {
    // Two allies on the board: only the chosen cell gets the shield.
    let s = summon([mkCreature(60, "ally", { x: 6, y: 2 }, {}), mkCreature(61, "ally", { x: 6, y: 4 }, {})]);
    s = resolvePendingAction(s, { x: 6, y: 2 });
    expect(byId(s, 60)!.properties.has("Shield")).toBe(true);
    expect(byId(s, 61)!.properties.has("Shield")).toBe(false);
  });

  it("aucune invocation sur le plateau : elle se pose quand même, sans choix figé", () => {
    // The text gives no placement condition: with no target, the APPARITION just does
    // nothing. The engine must not get stuck on an empty choice.
    const s = summon([]);
    expect(s.pendingAction).toBeNull();
    expect(s.creatures.some((c) => c.cardId === 768 && c.position.x === 8 && c.position.y === 2)).toBe(true);
  });

  it("la cible ADVERSE désignée gagne le bouclier (« une invocation », sans restriction de camp)", () => {
    let s = summon([mkCreature(61, "enemy", { x: 3, y: 2 }, {})]);
    s = resolvePendingAction(s, { x: 3, y: 2 });
    expect(byId(s, 61)!.properties.has("Shield")).toBe(true);
    expect(s.creatures.find((c) => c.cardId === 768)!.properties.has("Shield")).toBe(false);
  });
});

describe("#774 Gelée Sucrée, APPARITION : place les 2 PREMIÈRES Gelées de la pioche en main", () => {
  // Text: « APPARITION : Place dans votre main les 2 premières Gelées de votre
  // pioche. » "Premières" = the closest to the top (the end of the array).
  // Deck: [417 Gelée Fraise (bottom), 39 Gelée Menthe, 203 Gelée Citron, 16 (top)].
  // The top is a non-Gelée: the engine has to skip it (otherwise the test would pass
  // with no family filter).
  const play = () => {
    card(774); card(417); card(39); card(203);
    const s0 = allyHand(bareBoard(withDecks(scenario([]), [417, 39, 203, 16])), [774]);
    return playCard(s0, card(774), { x: 8, y: 2 });
  };

  it("les 2 Gelées les plus proches du dessus montent en main, la 3e reste au fond", () => {
    const s = play();
    expect(s.players.ally.hand).toContain(203); // Gelée Citron (la plus haute)
    expect(s.players.ally.hand).toContain(39);  // Gelée Menthe (la suivante)
    expect(s.players.ally.hand).not.toContain(417); // Gelée Fraise, au fond : pas prise
    expect(s.players.ally.deck).toContain(417);
  });

  it("exactement 2 cartes tutorées, et jamais une carte hors-famille", () => {
    const s = play();
    expect(s.players.ally.hand.length).toBe(2);
    expect(s.players.ally.hand).not.toContain(16);
    expect(s.players.ally.deck).toContain(16);
  });

  it("une seule Gelée dans la pioche : elle monte seule (pas de complément hors-famille)", () => {
    card(774); card(39);
    const s0 = allyHand(bareBoard(withDecks(scenario([]), [16, 39, 16])), [774]);
    const s = playCard(s0, card(774), { x: 8, y: 2 });
    expect(s.players.ally.hand).toEqual([39]);
  });
});

describe("#783 Creusée, inflige 2 aux invocations ADVERSES d'une RANGÉE", () => {
  // Text: « Inflige @damage@ aux invocations adverses d'une rangée. »
  // (@damage@ is 2 on the shipped card.) RANGÉE = same x. Two qualifiers: the shape
  // (a column of the board, not a row) and the camp (enemies only).
  const cast = () => {
    card(783);
    const ennemiHaut = mkCreature(1, "enemy", { x: 4, y: 0 }, { currentLife: 5, baseLife: 5 });
    const ennemiCible = mkCreature(5, "enemy", { x: 4, y: 2 }, { currentLife: 5, baseLife: 5 }); // la case cliquée
    const ennemiBas = mkCreature(2, "enemy", { x: 4, y: 4 }, { currentLife: 5, baseLife: 5 });
    const ennemiMemeLigne = mkCreature(3, "enemy", { x: 3, y: 2 }, { currentLife: 5, baseLife: 5 });
    const allieMemeRangee = mkCreature(4, "ally", { x: 4, y: 1 }, { currentLife: 5, baseLife: 5 });
    const s0 = allyHand(bareBoard(withDecks(scenario([ennemiHaut, ennemiCible, ennemiBas, ennemiMemeLigne, allieMemeRangee]))), [783]);
    return playCard(s0, card(783), { x: 4, y: 2 });
  };

  it("toute la rangée visée (même x) est touchée, des deux extrémités à la case cliquée", () => {
    const s = cast();
    expect(byId(s, 1)!.currentLife).toBe(3); // 5 − 2
    expect(byId(s, 5)!.currentLife).toBe(3);
    expect(byId(s, 2)!.currentLife).toBe(3);
  });

  it("un ennemi de la même LIGNE mais d'une autre rangée n'est pas touché", () => {
    const s = cast();
    expect(byId(s, 3)!.currentLife).toBe(5);
  });

  it("une invocation ALLIÉE de la rangée visée n'est pas touchée (« adverses »)", () => {
    const s = cast();
    expect(byId(s, 4)!.currentLife).toBe(5);
  });

  it("aucun Dofus n'est touché (le texte ne vise que « les invocations »)", () => {
    const s = cast();
    expect(s.dofuses.every((d) => d.currentLife === DOFUS_LIFE)).toBe(true);
  });
});

describe("#801 Truche Royale, CHEF : +1 AT et +1 PM à vos AUTRES Truches ; change de ligne à l'arrivée d'une invocation adverse", () => {
  // Text: « CHEF : +1 AT et +1 PM à vos autres Truches. / Change de ligne quand une
  // invocation adverse entre en jeu. »
  // Three qualifiers on the aura: family (Truche), camp (vos), itself excluded
  // (autres). On the row change: only an enemy creature.
  const summonChief = () => {
    card(801); card(37);
    // #37 Truche : AT 3, PV 4, PM 3. Alliée et Truche -> doit recevoir l'aura.
    const trucheAlliee = mkCreature(60, "ally", { x: 6, y: 1 }, {
      cardId: 37, currentAttack: 3, baseAttack: 3, printedAttack: 3,
      baseMovement: 3, printedMovement: 3, movementLeft: 3, currentLife: 4, baseLife: 4,
    });
    // Ally that is not a Truche -> nothing.
    const allieNonTruche = mkCreature(61, "ally", { x: 6, y: 3 }, {
      cardId: 9999, currentAttack: 2, baseAttack: 2, baseMovement: 2, movementLeft: 2,
    });
    // Truche ADVERSE -> « vos » Truches : rien.
    const trucheEnnemie = mkCreature(62, "enemy", { x: 3, y: 1 }, {
      cardId: 37, currentAttack: 3, baseAttack: 3, printedAttack: 3,
      baseMovement: 3, printedMovement: 3, movementLeft: 3, currentLife: 4, baseLife: 4,
    });
    const s0 = allyHand(bareBoard(withDecks(scenario([trucheAlliee, allieNonTruche, trucheEnnemie]))), [801]);
    return playCard(s0, card(801), { x: 8, y: 2 });
  };

  it("une Truche alliée gagne +1 AT et +1 PM", () => {
    const s = summonChief();
    expect(byId(s, 60)!.currentAttack).toBe(4); // 3 + 1
    expect(byId(s, 60)!.baseMovement).toBe(4);  // 3 + 1
  });

  it("un allié qui n'est pas une Truche ne reçoit rien", () => {
    const s = summonChief();
    expect(byId(s, 61)!.currentAttack).toBe(2);
    expect(byId(s, 61)!.baseMovement).toBe(2);
  });

  it("une Truche ADVERSE ne reçoit rien", () => {
    const s = summonChief();
    expect(byId(s, 62)!.currentAttack).toBe(3);
    expect(byId(s, 62)!.baseMovement).toBe(3);
  });

  it("elle ne se buffe pas elle-même (« vos AUTRES Truches »)", () => {
    const s = summonChief();
    const royale = s.creatures.find((c) => c.cardId === 801)!;
    expect(royale.currentAttack).toBe(card(801).attack);
    expect(royale.baseMovement).toBe(card(801).movement);
  });

  it("une invocation ADVERSE qui entre en jeu la fait changer de ligne (seule ligne adjacente libre de SA rangée)", () => {
    card(801); card(6);
    const royale = mkCreature(70, "ally", { x: 6, y: 2 }, { cardId: 801, triggers: card(801).triggers ?? [] });
    const bloc = mkCreature(71, "ally", { x: 6, y: 1 }, { cardId: 9999 }); // y−1 pris -> seule case libre : y+1
    const s0 = enemyTurnHand(bareBoard(withDecks(scenario([royale, bloc]))), [6]);
    const s = playCard(s0, card(6), { x: 1, y: 0 }); // l'adversaire invoque
    expect(byId(s, 70)!.position).toEqual({ x: 6, y: 3 });
  });

  it("le changement de ligne reste dans SA rangée et ne saute qu'UNE ligne", () => {
    // "Change de LIGNE": the column (x) does not change, and the jump is one row. Both
    // neighbours are free here, so the side does not matter, but the move has to stay
    // adjacent and in the same column.
    card(801); card(6);
    const royale = mkCreature(70, "ally", { x: 6, y: 2 }, { cardId: 801, triggers: card(801).triggers ?? [] });
    const s0 = enemyTurnHand(bareBoard(withDecks(scenario([royale]))), [6]);
    const s = playCard(s0, card(6), { x: 1, y: 0 });
    const apres = byId(s, 70)!.position;
    expect(apres.x).toBe(6);
    expect(Math.abs(apres.y - 2)).toBe(1);
  });

  it("une invocation ALLIÉE qui entre en jeu ne la fait PAS changer de ligne", () => {
    card(801); card(6);
    const royale = mkCreature(70, "ally", { x: 6, y: 2 }, { cardId: 801, triggers: card(801).triggers ?? [] });
    const bloc = mkCreature(71, "ally", { x: 6, y: 1 }, { cardId: 9999 });
    const s0 = allyHand(bareBoard(withDecks(scenario([royale, bloc]))), [6]);
    const s = playCard(s0, card(6), { x: 8, y: 4 }); // invocation ALLIÉE
    expect(byId(s, 70)!.position).toEqual({ x: 6, y: 2 });
  });
});

describe("#813 Mulou Alpha, COUP DE GRÂCE : se transforme en Mulou Garou", () => {
  // Text: « COUP DE GRÂCE : Se transforme en Mulou Garou. »
  // COUP DE GRÂCE = when it kills. Mulou Garou (#199) is a 6/6 with 3 PM.
  it("elle devient Mulou Garou (#199) après avoir tué en mêlée", () => {
    card(813); card(199);
    const alpha = mkCreature(1, "ally", { x: 5, y: 2 }, {
      cardId: 813, triggers: card(813).triggers ?? [],
      currentAttack: 5, baseAttack: 5, printedAttack: 5,
      currentLife: 5, baseLife: 5, printedLife: 5,
      baseMovement: 3, movementLeft: 3, hasAttacked: false,
    });
    // Victim with no attack: no hit back muddles the final HP.
    const victime = mkCreature(2, "enemy", { x: 4, y: 2 }, {
      currentAttack: 0, baseAttack: 0, currentLife: 3, baseLife: 3,
    });
    const s = endTurn(bareBoard(withDecks(scenario([alpha, victime]))));
    expect(byId(s, 2)).toBeUndefined(); // la victime est bien morte
    const m = byId(s, 1)!;
    expect(m.cardId).toBe(199);       // même instance, nouvelle identité
    expect(m.currentAttack).toBe(6);  // stats de Mulou Garou
    expect(m.currentLife).toBe(6);
    expect(m.baseMovement).toBe(3);
  });

  it("sans kill, aucune transformation (elle reste Mulou Alpha)", () => {
    card(813);
    const alpha = mkCreature(1, "ally", { x: 5, y: 2 }, {
      cardId: 813, triggers: card(813).triggers ?? [],
      currentAttack: 5, baseAttack: 5, printedAttack: 5,
      currentLife: 5, baseLife: 5, printedLife: 5,
      baseMovement: 3, movementLeft: 3, hasAttacked: false,
    });
    const s = endTurn(bareBoard(withDecks(scenario([alpha]))));
    const m = byId(s, 1)!;
    expect(m.cardId).toBe(813);
    expect(m.currentAttack).toBe(5);
  });

  it("blesser sans tuer ne transforme pas (« COUP DE GRÂCE » = un kill)", () => {
    card(813);
    const alpha = mkCreature(1, "ally", { x: 5, y: 2 }, {
      cardId: 813, triggers: card(813).triggers ?? [],
      currentAttack: 5, baseAttack: 5, printedAttack: 5,
      currentLife: 9, baseLife: 9, printedLife: 9,
      baseMovement: 1, movementLeft: 1, hasAttacked: false,
    });
    const encaisseur = mkCreature(2, "enemy", { x: 4, y: 2 }, {
      currentAttack: 0, baseAttack: 0, currentLife: 20, baseLife: 20,
    });
    const s = endTurn(bareBoard(withDecks(scenario([alpha, encaisseur]))));
    expect(byId(s, 2)!.currentLife).toBeLessThan(20); // elle a bien frappé
    expect(byId(s, 1)!.cardId).toBe(813);             // mais rien n'est mort
  });
});

describe("#817 Oropo, FRATRIE + APPARITION : place le DERNIER membre de la Fratrie des Oubliés de la pioche en main", () => {
  // Text: « FRATRIE / APPARITION : Place dans votre main le dernier membre de la
  // Fratrie des Oubliés de votre pioche. »
  // "Dernier" = the farthest from the top, so toward the bottom = index 0 of the array.
  // Deck: [16 (bottom, not Fratrie), 100 Ush, 680 Coqueline (top)].
  // The bottom is a non-Fratrie card on purpose: without it, the test would pass even
  // if the family filter were removed.
  const play = () => {
    card(817); card(100); card(680);
    const s0 = allyHand(bareBoard(withDecks(scenario([]), [16, 100, 680])), [817]);
    return playCard(s0, card(817), { x: 8, y: 2 });
  };

  it("c'est le membre le plus proche du FOND qui monte en main, pas celui du dessus", () => {
    const s = play();
    expect(s.players.ally.hand).toEqual([100]); // Ush, the lower of the two
    expect(s.players.ally.deck).toContain(680); // Coqueline reste dans la pioche
  });

  it("un seul membre part et les cartes hors-Fratrie sont ignorées", () => {
    const s = play();
    expect(s.players.ally.hand.length).toBe(1);
    expect(s.players.ally.deck).toContain(16);
    expect(s.players.ally.deck.length).toBe(2);
  });

  it("aucun membre de la Fratrie dans la pioche : rien ne monte en main", () => {
    card(817);
    const s0 = allyHand(bareBoard(withDecks(scenario([]), [16, 16, 16])), [817]);
    const s = playCard(s0, card(817), { x: 8, y: 2 });
    expect(s.players.ally.hand).toEqual([]);
  });

  it("FRATRIE : avec une invocation adverse en jeu, le choix de mill s'ouvre AVANT la pose ; décliné, l'APPARITION part quand même", () => {
    // The FRATRIE keyword opens an optional choice (target an enemy creature to discard
    // its copies). It comes before the placement; we decline it by clicking an empty
    // cell, and the APPARITION must then run normally.
    card(817); card(100);
    const cible = mkCreature(80, "enemy", { x: 3, y: 2 }, {});
    const s0 = allyHand(bareBoard(withDecks(scenario([cible]), [16, 100, 680])), [817]);
    const held = playCard(s0, card(817), { x: 8, y: 2 });
    expect(held.pendingAction!.filter).toBe("enemy_creature");
    expect(held.creatures.some((c) => c.cardId === 817)).toBe(false); // pas encore posé
    const s = resolvePendingAction(held, { x: 7, y: 4 }); // declined on an empty cell
    expect(s.creatures.some((c) => c.cardId === 817)).toBe(true);
    expect(s.players.ally.hand).toEqual([100]);
  });
});

describe("#825 Princesse Brinière, COUP DE GRÂCE : vos AUTRES invocations chargent de 1 case", () => {
  // Text: « COUP DE GRÂCE : Vos autres invocations chargent de 1 case. »
  // Three qualifiers: "vos" (camp), "autres" (not itself), "de 1 case" (exactly one,
  // even if the ally has 3 PM).
  const fire = () => {
    card(825);
    const princesse = mkCreature(1, "ally", { x: 7, y: 2 }, { cardId: 825, triggers: card(825).triggers ?? [] });
    const allie = mkCreature(2, "ally", { x: 6, y: 0 }, {
      currentAttack: 2, baseAttack: 2, baseMovement: 3, movementLeft: 3, hasAttacked: false,
    });
    const ennemi = mkCreature(3, "enemy", { x: 3, y: 4 }, {
      currentAttack: 2, baseAttack: 2, baseMovement: 3, movementLeft: 3, hasAttacked: false,
    });
    return runTrigger(bareBoard(withDecks(scenario([princesse, allie, ennemi]))), "COUP_DE_GRACE", 1);
  };

  it("une invocation alliée avance d'EXACTEMENT 1 case vers l'adversaire (et pas de ses 3 PM)", () => {
    const s = fire();
    expect(byId(s, 2)!.position).toEqual({ x: 5, y: 0 });
  });

  it("la Princesse elle-même ne bouge pas (« vos AUTRES invocations »)", () => {
    const s = fire();
    expect(byId(s, 1)!.position).toEqual({ x: 7, y: 2 });
  });

  it("une invocation ADVERSE ne charge pas (« VOS invocations »)", () => {
    const s = fire();
    expect(byId(s, 3)!.position).toEqual({ x: 3, y: 4 });
  });

  it("la charge est un bonus : l'alliée garde ses PM pour son avance de fin de tour", () => {
    const s = fire();
    expect(byId(s, 2)!.movementLeft).toBe(3);
  });

  it("sur un kill RÉEL en fin de tour, l'alliée en mal d'invocation avance quand même d'1 case", () => {
    // The death-wave path (fireCoupDeGrace) is separate from runTrigger, so it is
    // covered with a real kill. The ally has summoning sickness (0 PM, hasAttacked):
    // without the charge it would stay where it is, so the +1 cell seen can only come
    // from the COUP DE GRÂCE.
    card(825);
    const princesse = mkCreature(1, "ally", { x: 5, y: 2 }, {
      cardId: 825, triggers: card(825).triggers ?? [],
      currentAttack: 5, baseAttack: 5, currentLife: 6, baseLife: 6,
      baseMovement: 1, movementLeft: 1, hasAttacked: false,
    });
    const victime = mkCreature(2, "enemy", { x: 4, y: 2 }, {
      currentAttack: 0, baseAttack: 0, currentLife: 3, baseLife: 3,
    });
    const allieMalInvoque = mkCreature(3, "ally", { x: 6, y: 0 }, {
      baseMovement: 3, movementLeft: 0, hasAttacked: true,
    });
    const s = endTurn(bareBoard(withDecks(scenario([princesse, victime, allieMalInvoque]))));
    expect(byId(s, 2)).toBeUndefined();                       // le kill a bien eu lieu
    expect(byId(s, 3)!.position).toEqual({ x: 5, y: 0 });     // 6 -> 5 : une case
  });
});

describe("#830 Toxine, APPARITION : détruit les invocations RARES en jeu", () => {
  // Text: « FRATRIE / APPARITION : Détruit les invocations rares en jeu. »
  // "Rare" = the Gold rarity (Gold is shown as "Rare" in the UI). "En jeu", with no
  // camp limit: both camps. Toxine is Infinite, so it survives its own effect.
  const play = () => {
    card(830); card(199); card(401); card(836); card(135); card(147); card(100);
    const rareAllie = mkCreature(10, "ally", { x: 6, y: 1 }, { cardId: 199 });   // Gold = Rare
    const rareEnnemi = mkCreature(11, "enemy", { x: 3, y: 1 }, { cardId: 401 }); // Gold = Rare
    const peuCommune = mkCreature(12, "ally", { x: 6, y: 2 }, { cardId: 836 });  // Silver
    const commune = mkCreature(13, "enemy", { x: 3, y: 2 }, { cardId: 135 });    // Common
    const krosmic = mkCreature(14, "ally", { x: 6, y: 3 }, { cardId: 147 });     // Krosmic
    const infinie = mkCreature(15, "enemy", { x: 3, y: 3 }, { cardId: 100 });    // Infinite
    const s0 = allyHand(bareBoard(withDecks(scenario([rareAllie, rareEnnemi, peuCommune, commune, krosmic, infinie]))), [830]);
    // Toxine also has FRATRIE: this keyword opens an optional choice (mill) before it
    // is placed. We decline it by clicking an empty cell: it is then placed at once and
    // its APPARITION fires.
    const held = playCard(s0, card(830), { x: 8, y: 0 });
    expect(held.pendingAction!.filter).toBe("enemy_creature"); // c'est bien le choix FRATRIE
    return resolvePendingAction(held, { x: 7, y: 4 });
  };

  it("les invocations rares des DEUX camps sont détruites", () => {
    const s = play();
    expect(byId(s, 10)).toBeUndefined();
    expect(byId(s, 11)).toBeUndefined();
  });

  it("les autres raretés survivent (commune, peu commune, krosmique, infinie)", () => {
    const s = play();
    expect(byId(s, 12)).not.toBeUndefined();
    expect(byId(s, 13)).not.toBeUndefined();
    expect(byId(s, 14)).not.toBeUndefined();
    expect(byId(s, 15)).not.toBeUndefined();
  });

  it("Toxine elle-même (Infinie) survit à sa propre APPARITION", () => {
    const s = play();
    expect(s.creatures.some((c) => c.cardId === 830 && c.currentLife > 0)).toBe(true);
  });
});

describe("#831 Sambalinette, RÉSISTANCE : 1", () => {
  // Text: « RÉSISTANCE : @resistance@ » (the shipped card has a single
  // BoostResistanceData Boost 1). Nothing else: no trigger, no property. What is left
  // to check for this card is that the value is set at summon; the generic
  // resistance mechanism itself is already covered by spells.test.ts (describe
  // "Résistance vs Armure").
  const poser = () => {
    card(831);
    const s0 = allyHand(bareBoard(withDecks(scenario([]))), [831]);
    return playCard(s0, card(831), { x: 8, y: 2 });
  };

  it("elle arrive avec RÉSISTANCE 1 et aucune armure", () => {
    const s = poser();
    const sam = s.creatures.find((c) => c.cardId === 831)!;
    expect(sam.resistance).toBe(1);
    expect(sam.armor).toBe(0);
    expect(sam.currentLife).toBe(card(831).life);
    expect(sam.currentAttack).toBe(card(831).attack);
  });

  it("un coup de 2 ne lui retire qu'1 PV, et la Résistance n'est pas consommée", () => {
    const s0 = poser();
    const sam = s0.creatures.find((c) => c.cardId === 831)!;
    // An enemy with 2 AT comes into contact: it takes two endTurn (the first ends the
    // ally turn, the second makes the enemy advance).
    const cogneur = mkCreature(90, "enemy", { x: 7, y: 2 }, {
      currentAttack: 2, baseAttack: 2, currentLife: 9, baseLife: 9,
      baseMovement: 1, movementLeft: 1, hasAttacked: false,
    });
    const s1 = endTurn({ ...s0, creatures: [...s0.creatures, cogneur] });
    const s2 = endTurn(s1);
    const apres = byId(s2, sam.instanceId)!;
    expect(apres.currentLife).toBe(card(831).life - 1); // 2 encaissés − 1 de Résistance
    expect(apres.resistance).toBe(1);                   // a permanent reduction, not a pool
  });
});

describe("#836 Chachafer, TAS D'OS ; gagne +1 AT et +1 AR quand un Chacha ALLIÉ entre en jeu", () => {
  // Text: « TAS D'OS / Gagne +1 AT et +1 AR quand un Chacha allié entre en jeu. »
  // Two qualifiers on the trigger: the family (Chacha) and the camp (allié).
  const chachafer = () =>
    mkCreature(700, "ally", { x: 6, y: 2 }, {
      cardId: 836, triggers: card(836).triggers ?? [],
      currentAttack: 2, baseAttack: 2, printedAttack: 2, armor: 0,
      currentLife: 1, baseLife: 1,
    });

  it("un Chacha ALLIÉ qui entre en jeu lui donne +1 AT et +1 AR", () => {
    card(836); card(135);
    const s0 = allyHand(bareBoard(withDecks(scenario([chachafer()]))), [135]);
    const s = playCard(s0, card(135), { x: 8, y: 0 }); // Chacha Noir, allié
    expect(byId(s, 700)!.currentAttack).toBe(3);
    expect(byId(s, 700)!.armor).toBe(1);
  });

  it("un allié qui n'est PAS un Chacha ne déclenche rien", () => {
    card(836); card(6);
    const s0 = allyHand(bareBoard(withDecks(scenario([chachafer()]))), [6]); // Tristepin : Iop
    const s = playCard(s0, card(6), { x: 8, y: 0 });
    expect(byId(s, 700)!.currentAttack).toBe(2);
    expect(byId(s, 700)!.armor).toBe(0);
  });

  it("un Chacha ADVERSE qui entre en jeu ne déclenche rien (« un Chacha ALLIÉ »)", () => {
    card(836); card(135);
    const s0 = enemyTurnHand(bareBoard(withDecks(scenario([chachafer()]))), [135]);
    const s = playCard(s0, card(135), { x: 1, y: 0 });
    expect(byId(s, 700)!.currentAttack).toBe(2);
    expect(byId(s, 700)!.armor).toBe(0);
  });

  it("deux Chachas alliés successifs cumulent (+2 AT / +2 AR)", () => {
    card(836); card(135); card(732);
    const s0 = allyHand(bareBoard(withDecks(scenario([chachafer()]))), [135, 732]);
    let s = playCard(s0, card(135), { x: 8, y: 0 });
    s = playCard(s, card(732), { x: 8, y: 4 }); // Chacha Teigne, allié
    expect(byId(s, 700)!.currentAttack).toBe(4);
    expect(byId(s, 700)!.armor).toBe(2);
  });

  it("TAS D'OS : mort, il laisse un Tas d'Os de SON camp sur sa case", () => {
    card(836);
    const chf = mkCreature(901, "ally", { x: 5, y: 3 }, { cardId: 836, currentLife: 0 });
    const sc = bareBoard(scenario([chf]));
    const res = resolveDeathsAndWin(sc, [chf], sc.dofuses, [], new Set());
    expect((res.tasDOs ?? []).some((t) => t.owner === "ally" && t.position.x === 5 && t.position.y === 3)).toBe(true);
  });
});
