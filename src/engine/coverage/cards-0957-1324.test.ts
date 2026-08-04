// Coverage for cards that are wired in the engine but were not used in any test:
// #957 #973 #1020 #1025 #1042 #1081 #1120 #1203 #1206 #1275 #1320 #1324
//
// Each assertion comes from the card's text, never from what the engine does: a
// test written by copying the engine's output would lock its bugs in instead of
// showing them.
//
// A test whose only assertion is negative ("the ally is not hit", "no Butin drops")
// would still pass if the card's effect were removed entirely. So each negative
// test also has, in the same state, a positive control that fails if the effect
// disappears.
import { describe, it, expect } from "vitest";
import { card, mkCreature, scenario, byId } from "../testkit";
import { playCard, endTurn, canPlayCard, runTrigger, resolvePendingAction, resolveDeathsAndWin } from "../rules";
import { slideCreatureBack } from "../effects";
import type { GameState } from "../state";

// scenario() leaves the decks empty: an endTurn would draw from an empty deck and
// trigger FATIGUE, which would hit the Dofus and pollute the assertions. Both
// decks are filled with neutral cards.
const withDecks = (
  s: GameState,
  allyDeck: number[] = [16, 16, 16],
  enemyDeck: number[] = [16, 16, 16],
): GameState => ({
  ...s,
  players: {
    ...s.players,
    ally: { ...s.players.ally, deck: allyDeck },
    enemy: { ...s.players.enemy, deck: enemyDeck },
  },
});

// The ground objects placed by default (prisms) get in the way of the end-of-turn
// moves and of placing objects on the start cells, so the board is cleared.
const bareBoard = (s: GameState): GameState => ({ ...s, prisms: [], seeds: [], butins: [] });

// ---------------------------------------------------------------------------
describe("#957 Purge - inflige 1 aux invocations ADVERSES", () => {
  // Text: « Inflige @damage@ aux invocations adverses. » (@damage@ = 1, the amount on
  // the card). Two qualifiers: the camp ("adverses" only), and that creatures are hit,
  // so not the Dofus (general rule: damage never reaches a Dofus unless the text says
  // so). The text gives no shape: every enemy is hit wherever it is, hence one enemy
  // right against its own wall and another in the middle of the board.
  const build = () => {
    card(957);
    const ennemiLoin = mkCreature(60, "enemy", { x: 1, y: 0 }, { currentLife: 5, baseLife: 5 });
    const ennemiBlinde = mkCreature(61, "enemy", { x: 4, y: 3 }, { currentLife: 5, baseLife: 5, armor: 2 });
    const allie = mkCreature(62, "ally", { x: 6, y: 2 }, { currentLife: 5, baseLife: 5 });
    const s0 = scenario([ennemiLoin, ennemiBlinde, allie], 957);
    return { s0, s: playCard(s0, card(957), { x: 8, y: 2 }) };
  };

  it("chaque invocation adverse perd 1 PV, ou qu'elle soit sur le plateau", () => {
    const { s } = build();
    expect(byId(s, 60)!.currentLife).toBe(4); // 5 - 1
  });

  it("les degats passent par l'armure : l'adversaire blinde perd 1 AR, pas de PV", () => {
    const { s } = build();
    expect(byId(s, 61)!.armor).toBe(1);        // 2 - 1
    expect(byId(s, 61)!.currentLife).toBe(5);  // PV intacts
  });

  it("les invocations ALLIEES ne sont pas touchees (« adverses »)", () => {
    const { s } = build();
    expect(byId(s, 62)!.currentLife).toBe(5);
    expect(byId(s, 62)!.armor).toBe(0);
    // Positive control in the same state: the spell did hit someone.
    expect(byId(s, 60)!.currentLife).toBe(4);
  });

  it("aucun Dofus n'est touche (le texte ne vise que les invocations)", () => {
    const { s0, s } = build();
    expect(s.dofuses.map((d) => d.currentLife)).toEqual(s0.dofuses.map((d) => d.currentLife));
    expect(byId(s, 60)!.currentLife).toBe(4); // temoin positif
  });
});

// ---------------------------------------------------------------------------
describe("#973 Pretresse de la coupe - APPARITION : +1 AR a une invocation, elle est soignee de 2 PV", () => {
  // Text: « APPARITION : Donnez +1 AR a une invocation, elle est soignee de 2 PV. »
  // Qualifiers: "une invocation" (no camp limit), "elle" (the same target gets both
  // effects), and the heal is a heal (so capped at base HP).
  const poser = (autres: ReturnType<typeof mkCreature>[]) => {
    card(973);
    const s = bareBoard(scenario(autres, 973));
    return playCard(s, card(973), { x: 8, y: 2 });
  };

  it("la cible choisie gagne 1 AR ET recupere 2 PV", () => {
    const blesse = mkCreature(60, "ally", { x: 6, y: 2 }, { currentLife: 3, baseLife: 6, armor: 0 });
    const s = resolvePendingAction(poser([blesse]), { x: 6, y: 2 });
    expect(byId(s, 60)!.armor).toBe(1);        // +1 AR
    expect(byId(s, 60)!.currentLife).toBe(5);  // 3 + 2
  });

  it("« elle » : une AUTRE invocation ne recoit ni AR ni soin", () => {
    const blesse = mkCreature(60, "ally", { x: 6, y: 2 }, { currentLife: 3, baseLife: 6, armor: 0 });
    const voisin = mkCreature(61, "ally", { x: 6, y: 3 }, { currentLife: 3, baseLife: 6, armor: 0 });
    const s = resolvePendingAction(poser([blesse, voisin]), { x: 6, y: 2 });
    expect(byId(s, 61)!.armor).toBe(0);
    expect(byId(s, 61)!.currentLife).toBe(3);
    // Positive control: the chosen target did get both effects.
    expect(byId(s, 60)!.armor).toBe(1);
    expect(byId(s, 60)!.currentLife).toBe(5);
  });

  it("« une invocation » n'est pas restreint au camp : une invocation ADVERSE est une cible legale", () => {
    const ennemi = mkCreature(60, "enemy", { x: 3, y: 2 }, { currentLife: 2, baseLife: 6, armor: 0 });
    const s = resolvePendingAction(poser([ennemi]), { x: 3, y: 2 });
    expect(byId(s, 60)!.armor).toBe(1);
    expect(byId(s, 60)!.currentLife).toBe(4); // 2 + 2
  });

  it("un soin ne deborde pas : a PV pleins la cible ne gagne que l'AR", () => {
    const sain = mkCreature(60, "ally", { x: 6, y: 2 }, { currentLife: 6, baseLife: 6, armor: 0 });
    const s = resolvePendingAction(poser([sain]), { x: 6, y: 2 });
    expect(byId(s, 60)!.armor).toBe(1);
    expect(byId(s, 60)!.currentLife).toBe(6);
  });

  it("seule sur le plateau : l'APPARITION s'eteint sans figer la partie", () => {
    // Safety invariant: a targeting with no target must never leave a pendingAction
    // that cannot be resolved.
    const s = poser([]);
    expect(s.pendingAction).toBeNull();
    const pretresse = s.creatures.find((c) => c.cardId === 973)!;
    expect(pretresse.armor).toBe(0); // "donnez A UNE INVOCATION": it does not pick itself
  });
});

// ---------------------------------------------------------------------------
describe("#1324 Pretresse de la coiffe - APPARITION : +1 AT a une invocation, elle est soignee de 2 PV", () => {
  // Text: « APPARITION : Donnez +1 AT a une invocation, elle est soignee de 2 PV. »
  // Same pattern as #973, but the attack goes up, not the armour.
  const poser = (autres: ReturnType<typeof mkCreature>[]) => {
    card(1324);
    const s = bareBoard(scenario(autres, 1324));
    return playCard(s, card(1324), { x: 8, y: 2 });
  };

  it("la cible choisie gagne 1 AT ET recupere 2 PV", () => {
    const blesse = mkCreature(60, "ally", { x: 6, y: 2 }, {
      currentLife: 3, baseLife: 6, currentAttack: 2, baseAttack: 2, printedAttack: 2, armor: 0,
    });
    const s = resolvePendingAction(poser([blesse]), { x: 6, y: 2 });
    expect(byId(s, 60)!.currentAttack).toBe(3); // 2 + 1
    expect(byId(s, 60)!.currentLife).toBe(5);   // 3 + 2
    expect(byId(s, 60)!.armor).toBe(0);         // the text does not give armour
  });

  it("« elle » : une AUTRE invocation ne recoit ni AT ni soin", () => {
    const blesse = mkCreature(60, "ally", { x: 6, y: 2 }, { currentLife: 3, baseLife: 6, currentAttack: 2, baseAttack: 2 });
    const voisin = mkCreature(61, "ally", { x: 6, y: 3 }, { currentLife: 3, baseLife: 6, currentAttack: 2, baseAttack: 2 });
    const s = resolvePendingAction(poser([blesse, voisin]), { x: 6, y: 2 });
    expect(byId(s, 61)!.currentAttack).toBe(2);
    expect(byId(s, 61)!.currentLife).toBe(3);
    // Temoin positif : la cible designee a bien recu les deux effets.
    expect(byId(s, 60)!.currentAttack).toBe(3);
    expect(byId(s, 60)!.currentLife).toBe(5);
  });

  it("un soin ne deborde pas : a PV pleins la cible ne gagne que l'AT", () => {
    const sain = mkCreature(60, "ally", { x: 6, y: 2 }, {
      currentLife: 6, baseLife: 6, currentAttack: 2, baseAttack: 2, printedAttack: 2,
    });
    const s = resolvePendingAction(poser([sain]), { x: 6, y: 2 });
    expect(byId(s, 60)!.currentAttack).toBe(3);
    expect(byId(s, 60)!.currentLife).toBe(6);
  });

  it("le bonus d'AT est permanent : il survit au passage de tour", () => {
    const blesse = mkCreature(60, "ally", { x: 6, y: 2 }, {
      currentLife: 3, baseLife: 6, currentAttack: 2, baseAttack: 2, printedAttack: 2,
      movementLeft: 0, hasAttacked: true,
    });
    const s = resolvePendingAction(poser([blesse]), { x: 6, y: 2 });
    const apres = endTurn(bareBoard(withDecks(s)));
    expect(byId(apres, 60)!.currentAttack).toBe(3);
  });
});

// ---------------------------------------------------------------------------
describe("#1020 Jabs - +2 AT a une invocation ALLIEE", () => {
  // Text: « Confere +2 AT a une invocation alliee. » The camp qualifier is carried by
  // castTarget AlliedSummon: an enemy creature is not a legal target.
  it("l'invocation alliee visee gagne 2 AT", () => {
    card(1020);
    const allie = mkCreature(60, "ally", { x: 6, y: 2 }, {
      currentAttack: 2, baseAttack: 2, printedAttack: 2,
    });
    const s = playCard(scenario([allie], 1020), card(1020), { x: 6, y: 2 });
    expect(byId(s, 60)!.currentAttack).toBe(4); // 2 + 2
    expect(byId(s, 60)!.baseAttack).toBe(4);    // bonus permanent
  });

  it("« UNE invocation » : seule la cible visee est buffee", () => {
    card(1020);
    const cible = mkCreature(60, "ally", { x: 6, y: 2 }, { currentAttack: 2, baseAttack: 2, printedAttack: 2 });
    const voisin = mkCreature(61, "ally", { x: 6, y: 3 }, { currentAttack: 2, baseAttack: 2, printedAttack: 2 });
    const s = playCard(scenario([cible, voisin], 1020), card(1020), { x: 6, y: 2 });
    expect(byId(s, 60)!.currentAttack).toBe(4); // temoin positif
    expect(byId(s, 61)!.currentAttack).toBe(2);
  });

  it("une invocation ADVERSE n'est pas une cible legale (« alliee »)", () => {
    card(1020);
    const allie = mkCreature(59, "ally", { x: 6, y: 2 }, { currentAttack: 2, baseAttack: 2 });
    const ennemi = mkCreature(60, "enemy", { x: 3, y: 2 }, { currentAttack: 2, baseAttack: 2 });
    const s = scenario([allie, ennemi], 1020);
    // The refusal is really about the camp of the target, not the cost or the hand: in
    // the same state, the allied creature is accepted.
    expect(canPlayCard(s, card(1020), { x: 3, y: 2 })).toBe("Cette invocation n'est pas alliée.");
    expect(canPlayCard(s, card(1020), { x: 6, y: 2 })).toBeNull();
  });

  it("une case vide n'est pas une cible legale (le texte exige une invocation)", () => {
    card(1020);
    const allie = mkCreature(60, "ally", { x: 6, y: 2 }, { currentAttack: 2, baseAttack: 2 });
    const s = scenario([allie], 1020);
    expect(canPlayCard(s, card(1020), { x: 5, y: 4 })).not.toBeNull();
    expect(canPlayCard(s, card(1020), { x: 6, y: 2 })).toBeNull(); // controle : l'allie, lui, est legal
  });
});

// ---------------------------------------------------------------------------
describe("#1025 Chevaucheur Ancien - APPARITION : +1 AT et +1 AR par Phorreur ALLIE en jeu", () => {
  // Text: « APPARITION : Gagne +1 AT et +1 AR par Phorreur allie en jeu. »
  // Qualifiers: the family (Phorreur), the camp (allie), and both stats going up by
  // the same count. Printed body: AT 3 / HP 3 / AR 0.
  // #16 Bebe Phorreur and #168 Phorreur are of the Phorreur family; #453 Tofu is not.
  //
  // Setup: the card is a `phorzerker`. As soon as an allied Phorreur is in play,
  // playCard first offers the PHORZERKER fusion and holds the summon off the board. We
  // decline (click on a free cell): the Chevaucheur is placed normally and its
  // APPARITION fires. That is the real game path, so runTrigger is not used as a
  // shortcut every time.
  const jouer = (autres: ReturnType<typeof mkCreature>[]) => {
    card(1025);
    const s = bareBoard(withDecks(scenario(autres, 1025)));
    return playCard(s, card(1025), { x: 8, y: 2 });
  };
  const chevaucheur = (s: GameState) => s.creatures.find((c) => c.cardId === 1025 && c.currentLife > 0)!;

  it("deux Phorreurs allies en jeu : +2 AT et +2 AR", () => {
    card(16);
    const p1 = mkCreature(2, "ally", { x: 7, y: 0 }, { cardId: 16 });
    const p2 = mkCreature(3, "ally", { x: 7, y: 1 }, { cardId: 16 });
    const pend = jouer([p1, p2]);
    expect(pend.pendingAction?.phorzerkerFusion).toBe(true); // la fusion est proposee d'abord
    const s = resolvePendingAction(pend, { x: 8, y: 4 });    // on decline : pose normale
    expect(chevaucheur(s).currentAttack).toBe(5); // 3 + 2
    expect(chevaucheur(s).armor).toBe(2);         // 0 + 2
  });

  it("aucun Phorreur en jeu : aucun bonus", () => {
    card(453);
    const quidam = mkCreature(2, "ally", { x: 7, y: 0 }, { cardId: 453 });
    const s = jouer([quidam]);
    expect(s.pendingAction).toBeNull(); // pas de Phorreur : pas de fusion proposee
    expect(chevaucheur(s).currentAttack).toBe(3);
    expect(chevaucheur(s).armor).toBe(0);
  });

  it("un Phorreur ADVERSE ne compte pas (« Phorreur ALLIE »)", () => {
    card(16); card(168);
    const allie = mkCreature(2, "ally", { x: 7, y: 0 }, { cardId: 16 });
    const ennemi = mkCreature(3, "enemy", { x: 3, y: 0 }, { cardId: 168 });
    const s = resolvePendingAction(jouer([allie, ennemi]), { x: 8, y: 4 });
    expect(chevaucheur(s).currentAttack).toBe(4); // le seul Phorreur ALLIE
    expect(chevaucheur(s).armor).toBe(1);
  });

  it("un allie qui n'est pas Phorreur ne compte pas", () => {
    card(16); card(453);
    const phorreur = mkCreature(2, "ally", { x: 7, y: 0 }, { cardId: 16 });
    const tofu = mkCreature(3, "ally", { x: 7, y: 3 }, { cardId: 453 });
    const s = resolvePendingAction(jouer([phorreur, tofu]), { x: 8, y: 4 });
    expect(chevaucheur(s).currentAttack).toBe(4);
    expect(chevaucheur(s).armor).toBe(1);
  });

  it("« EN JEU » : un Phorreur deja mort ne compte plus", () => {
    card(16);
    const vivant = mkCreature(2, "ally", { x: 7, y: 0 }, { cardId: 16 });
    const mort = mkCreature(3, "ally", { x: 7, y: 1 }, { cardId: 16, currentLife: 0 });
    const s = resolvePendingAction(jouer([vivant, mort]), { x: 8, y: 4 });
    expect(chevaucheur(s).currentAttack).toBe(4); // un seul Phorreur vivant
    expect(chevaucheur(s).armor).toBe(1);
  });

  it("le declencheur seul (runTrigger) donne le meme compte", () => {
    card(16);
    const cheva = mkCreature(1, "ally", { x: 8, y: 2 }, {
      cardId: 1025, triggers: card(1025).triggers ?? [],
      currentAttack: 3, baseAttack: 3, printedAttack: 3, currentLife: 3, baseLife: 3, armor: 0,
    });
    const p1 = mkCreature(2, "ally", { x: 7, y: 0 }, { cardId: 16 });
    const s = runTrigger(scenario([cheva, p1]), "APPARITION", 1);
    expect(byId(s, 1)!.currentAttack).toBe(4);
    expect(byId(s, 1)!.armor).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("#1081 Rose Tenebreuse - APPARITION : donnez INAMOVIBLE a une invocation", () => {
  // Text: « APPARITION : Donnez inamovible a une invocation. » The keyword is given to
  // another chosen creature; the Rose itself is not described as inamovible.
  const poser = (autres: ReturnType<typeof mkCreature>[]) => {
    card(1081);
    return playCard(bareBoard(withDecks(scenario(autres, 1081))), card(1081), { x: 8, y: 2 });
  };

  it("l'invocation choisie devient INAMOVIBLE", () => {
    const cible = mkCreature(60, "ally", { x: 6, y: 2 }, {});
    const s = resolvePendingAction(poser([cible]), { x: 6, y: 2 });
    expect(byId(s, 60)!.properties.has("Rooted")).toBe(true);
  });

  it("INAMOVIBLE : la cible ne peut plus etre deplacee (poussee sans effet)", () => {
    const cible = mkCreature(60, "ally", { x: 6, y: 2 }, {});
    const temoin = mkCreature(61, "ally", { x: 6, y: 4 }, {});
    const s = resolvePendingAction(poser([cible, temoin]), { x: 6, y: 2 });
    const creatures = s.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
    const enracinee = creatures.find((c) => c.instanceId === 60)!;
    const libre = creatures.find((c) => c.instanceId === 61)!;
    slideCreatureBack(enracinee, creatures, s.dofuses, 1, []);
    slideCreatureBack(libre, creatures, s.dofuses, 1, []);
    expect(enracinee.position).toEqual({ x: 6, y: 2 }); // inamovible : n'a pas bouge
    expect(libre.position).toEqual({ x: 7, y: 4 });     // temoin : repousse vers son mur
  });

  it("INAMOVIBLE bloque le deplacement IMPOSE, pas l'avance naturelle de fin de tour", () => {
    // An INAMOVIBLE creature still uses its PM at the end of the turn.
    const cible = mkCreature(60, "ally", { x: 6, y: 2 }, {
      baseMovement: 2, printedMovement: 2, movementLeft: 2, hasAttacked: false,
    });
    const s = resolvePendingAction(poser([cible]), { x: 6, y: 2 });
    expect(byId(s, 60)!.properties.has("Rooted")).toBe(true);
    const apres = endTurn(s);
    expect(byId(apres, 60)!.position).toEqual({ x: 4, y: 2 }); // 6 - 2 PM
  });

  it("la Rose elle-meme n'est PAS inamovible (le mot-cle est DONNE a une autre)", () => {
    const cible = mkCreature(60, "ally", { x: 6, y: 2 }, {});
    const s = resolvePendingAction(poser([cible]), { x: 6, y: 2 });
    const rose = s.creatures.find((c) => c.cardId === 1081)!;
    expect(rose.properties.has("Rooted")).toBe(false);
    expect(byId(s, 60)!.properties.has("Rooted")).toBe(true); // temoin positif
  });

  it("« une invocation » n'est pas restreint au camp : une adverse peut la recevoir", () => {
    const ennemi = mkCreature(60, "enemy", { x: 3, y: 2 }, {});
    const s = resolvePendingAction(poser([ennemi]), { x: 3, y: 2 });
    expect(byId(s, 60)!.properties.has("Rooted")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("#1120 Lard Devil - APPARITION : place en main le PREMIER Justicier de la pioche", () => {
  // Text: « APPARITION : Place dans votre main le premier Justicier de votre pioche. »
  // "Premier" = the one that would be drawn first, so the top of the deck.
  // drawCardFrom does deck.pop(): the top is the end of the array, the bottom is index 0.
  // #209 Justice and #412 Merkator are of the Justicier family; #16 is not.
  //
  // Setup: bareBoard is needed. Placing the summon on a start cell would pick up the
  // prism there, and its random reward can make you draw, which skews the hand and
  // deck counts.
  it("le Justicier le plus PROCHE du dessus remonte en main, un seul", () => {
    card(1120); card(209); card(412); card(16);
    const s1 = bareBoard(withDecks(scenario([], 1120), [412, 16, 209, 16])); // dessus = fin du tableau
    const s = playCard(s1, card(1120), { x: 8, y: 2 });
    expect(s.players.ally.hand).toContain(209);      // the higher of the two Justiciers
    expect(s.players.ally.hand).not.toContain(412);  // « le PREMIER » : un seul
    expect(s.players.ally.deck).not.toContain(209);
    expect(s.players.ally.deck).toContain(412);      // l'autre reste dans la pioche
  });

  it("les cartes qui ne sont pas Justiciers restent dans la pioche", () => {
    card(1120); card(209); card(16);
    const s1 = bareBoard(withDecks(scenario([], 1120), [16, 16, 209, 16]));
    const s = playCard(s1, card(1120), { x: 8, y: 2 });
    expect(s.players.ally.hand).toEqual([209]); // temoin positif : le Justicier, lui, remonte
    expect(s.players.ally.deck.filter((id) => id === 16)).toHaveLength(3);
  });

  it("« VOTRE pioche » : un Justicier de la pioche ADVERSE n'est pas pris", () => {
    card(1120); card(209); card(16);
    const s1 = bareBoard(withDecks(scenario([], 1120), [16, 16, 16], [16, 209, 16]));
    const s = playCard(s1, card(1120), { x: 8, y: 2 });
    expect(s.players.ally.hand).toHaveLength(0);
    expect(s.players.enemy.deck).toEqual([16, 209, 16]); // la pioche adverse est intacte
    expect(s.players.enemy.hand).not.toContain(209);
  });

  it("aucun Justicier dans la pioche : rien ne remonte", () => {
    card(1120); card(16);
    const s1 = bareBoard(withDecks(scenario([], 1120), [16, 16, 16]));
    const s = playCard(s1, card(1120), { x: 8, y: 2 });
    expect(s.players.ally.hand).toHaveLength(0);
    expect(s.players.ally.deck).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
describe("#1203 Vitalite Ancestrale - passe a 4 les PM des invocations EN JEU", () => {
  // Text: « Passe a 4 les PM des invocations en jeu. » Three qualifiers: "passe a" (a
  // fixed value, so it can also lower PM above 4), "des invocations" with no camp
  // limit (so both camps), and "en jeu": what comes after the spell is not affected.
  const build = () => {
    card(1203);
    const lent = mkCreature(60, "ally", { x: 7, y: 0 }, { baseMovement: 2, printedMovement: 2, movementLeft: 2 });
    const rapide = mkCreature(61, "ally", { x: 7, y: 1 }, { baseMovement: 6, printedMovement: 6, movementLeft: 6 });
    const ennemi = mkCreature(62, "enemy", { x: 3, y: 3 }, { baseMovement: 1, printedMovement: 1, movementLeft: 1 });
    return playCard(scenario([lent, rapide, ennemi], 1203), card(1203), { x: 8, y: 2 });
  };

  it("une invocation lente MONTE a 4 PM", () => {
    expect(byId(build(), 60)!.baseMovement).toBe(4);
  });

  it("« passe a » : une invocation a 6 PM DESCEND a 4", () => {
    expect(byId(build(), 61)!.baseMovement).toBe(4);
  });

  it("les invocations ADVERSES sont concernees aussi (« en jeu », sans camp)", () => {
    expect(byId(build(), 62)!.baseMovement).toBe(4);
  });

  it("le changement mord des ce tour : l'alliee a 2 PM avance bien de 4 cases", () => {
    const s = endTurn(bareBoard(withDecks(build())));
    expect(byId(s, 60)!.position).toEqual({ x: 3, y: 0 }); // 7 - 4
  });

  it("« EN JEU » : une invocation posee APRES le sort garde ses PM imprimes", () => {
    card(1203); card(453); // #453 Tofu : 5 PM imprimes
    const lent = mkCreature(60, "ally", { x: 7, y: 0 }, { baseMovement: 2, printedMovement: 2, movementLeft: 2 });
    const s0 = playCard(bareBoard(scenario([lent], 1203, 453)), card(1203), { x: 8, y: 2 });
    expect(byId(s0, 60)!.baseMovement).toBe(4); // temoin positif : le sort a bien agi
    const s = playCard(s0, card(453), { x: 8, y: 4 });
    const tofu = s.creatures.find((c) => c.cardId === 453)!;
    expect(tofu.baseMovement).toBe(5); // came after: the spell did not touch it
  });
});

// ---------------------------------------------------------------------------
describe("#1206 Recrue Indomptee - NECROME / APPARITION : gagne +1 AR OU s'inflige 1 degat", () => {
  // Text: « NECROME / APPARITION : Gagne +1 AR OU s'inflige 1 degat. »
  // "OU" = a coin: exactly one of the two branches fires, never both, never none. The
  // PILE branch is the first part of the text (+1 AR). Printed body: HP 4 / AT 5.
  const recrue = () =>
    mkCreature(1, "ally", { x: 8, y: 2 }, {
      cardId: 1206, triggers: card(1206).triggers ?? [],
      currentLife: 4, baseLife: 4, currentAttack: 5, baseAttack: 5, armor: 0,
    });

  it("piece forcee sur PILE : +1 AR, aucun degat", () => {
    card(1206);
    const base = scenario([recrue()]);
    const forced = { ...base, players: { ...base.players, ally: { ...base.players.ally, coinForcedPile: true } } };
    const s = runTrigger(forced, "APPARITION", 1);
    expect(byId(s, 1)!.armor).toBe(1);
    expect(byId(s, 1)!.currentLife).toBe(4);
  });

  it("les deux branches sont atteignables et s'excluent (« OU »)", () => {
    card(1206);
    const vues = new Set<string>();
    for (let seed = 0; seed < 30; seed++) {
      const base = scenario([recrue()]);
      const s = runTrigger({ ...base, rng: seed }, "APPARITION", 1);
      const r = byId(s, 1)!;
      const ar = r.armor === 1 && r.currentLife === 4;
      const degat = r.armor === 0 && r.currentLife === 3; // 4 - 1
      expect(ar || degat).toBe(true); // exactement une des deux branches
      vues.add(ar ? "ar" : "degat");
    }
    expect(vues.has("ar")).toBe(true);
    expect(vues.has("degat")).toBe(true);
  });

  it("l'auto-degat passe par l'armure comme tout degat subi", () => {
    card(1206);
    let couvert = false;
    for (let seed = 0; seed < 30; seed++) {
      const base = scenario([{ ...recrue(), armor: 2 }]);
      const s = runTrigger({ ...base, rng: seed }, "APPARITION", 1);
      const r = byId(s, 1)!;
      if (r.armor === 3) continue;            // branche +1 AR
      couvert = true;
      expect(r.armor).toBe(1);                // 2 - 1 absorbe
      expect(r.currentLife).toBe(4);          // PV intacts
    }
    expect(couvert).toBe(true);
  });

  it("NECROME : jouee avec un Dofus non revele, la pose ouvre d'abord la revelation", () => {
    // NECROME is the first part of the text: the engine has to recognise the card as
    // such and offer to reveal a Dofus before placing it.
    card(1206);
    const s = playCard(bareBoard(withDecks(scenario([], 1206))), card(1206), { x: 8, y: 2 });
    expect(s.pendingAction?.deferredNecrome).toBe(true);
    expect(s.creatures.some((c) => c.cardId === 1206)).toBe(false); // retenue hors du plateau
  });

  it("NECROME decline : la Recrue se pose et son APPARITION part quand meme", () => {
    card(1206);
    const base = bareBoard(withDecks(scenario([], 1206)));
    const forced = { ...base, players: { ...base.players, ally: { ...base.players.ally, coinForcedPile: true } } };
    const pend = playCard(forced, card(1206), { x: 8, y: 2 });
    const s = resolvePendingAction(pend, { x: 8, y: 4 }); // clic ailleurs = pose normale
    const r = s.creatures.find((c) => c.cardId === 1206 && c.currentLife > 0)!;
    expect(r.armor).toBe(1);        // branche PILE : +1 AR
    expect(r.currentLife).toBe(4);  // PV imprimes intacts
  });
});

// ---------------------------------------------------------------------------
describe("#1275 Coffre a Grosse Serrure - RESISTANCE 1 + MORT : depose un Butin allie sur la premiere case de sa ligne", () => {
  // Text: « RESISTANCE : @resistance@ / MORT : Depose un Butin allie sur la premiere
  // case de sa ligne. » @resistance@ = 1 (the Boost on the card).
  // Printed body: HP 2 / AT 3.
  it("le coffre invoque porte bien RESISTANCE 1", () => {
    card(1275);
    const s = playCard(bareBoard(scenario([], 1275)), card(1275), { x: 8, y: 1 });
    const coffre = s.creatures.find((c) => c.cardId === 1275)!;
    expect(coffre.resistance).toBe(1);
    expect(coffre.currentLife).toBe(2);
  });

  it("RESISTANCE : un coup de 2 ne lui coute qu'1 PV (il survit)", () => {
    card(1275);
    // The enemy is already next to the allied start cell (8,1); it only hits at the end
    // of its own turn, hence the two endTurn.
    const frappeur = mkCreature(2, "enemy", { x: 7, y: 1 }, {
      currentAttack: 2, baseAttack: 2, currentLife: 12, baseLife: 12, movementLeft: 2,
    });
    const s0 = playCard(bareBoard(withDecks(scenario([frappeur], 1275))), card(1275), { x: 8, y: 1 });
    const s = endTurn(endTurn(s0));
    const coffre = s.creatures.find((c) => c.cardId === 1275 && c.currentLife > 0);
    expect(coffre).toBeTruthy();
    expect(coffre!.currentLife).toBe(1); // 2 PV - (2 degats - 1 de RESISTANCE)
  });

  it("MORT en combat reel : un Butin ALLIE apparait sur la premiere case de SA ligne (x=8)", () => {
    card(1275);
    // 5 AT - 1 RESISTANCE = 4 damage on 2 HP: the chest dies for good.
    const frappeur = mkCreature(2, "enemy", { x: 7, y: 1 }, {
      currentAttack: 5, baseAttack: 5, currentLife: 12, baseLife: 12, movementLeft: 2,
    });
    const s0 = playCard(bareBoard(withDecks(scenario([frappeur], 1275))), card(1275), { x: 8, y: 1 });
    const s = endTurn(endTurn(s0));
    expect(s.creatures.some((c) => c.cardId === 1275 && c.currentLife > 0)).toBe(false); // bien mort
    expect(s.butins ?? []).toHaveLength(1);
    expect((s.butins ?? [])[0].position).toEqual({ x: 8, y: 1 }); // sa ligne, case de depart alliee
    expect((s.butins ?? [])[0].owner).toBe("ally");               // « Butin ALLIE »
  });

  it("MORT (declencheur isole) : meme depot depuis le milieu du plateau", () => {
    card(1275);
    const coffre = mkCreature(1, "ally", { x: 6, y: 1 }, {
      cardId: 1275, triggers: card(1275).triggers ?? [], resistance: 1,
      currentLife: 2, baseLife: 2,
    });
    const base = bareBoard(scenario([coffre]));
    const creatures = base.creatures.map((c) => (c.instanceId === 1 ? { ...c, currentLife: 0 } : c));
    const s = resolveDeathsAndWin(base, creatures, base.dofuses, [...base.log], new Set());
    expect(s.butins ?? []).toHaveLength(1);
    expect((s.butins ?? [])[0].position).toEqual({ x: 8, y: 1 });
    expect((s.butins ?? [])[0].owner).toBe("ally");
  });
});

// ---------------------------------------------------------------------------
describe("#1320 Coffre Fort - RESISTANCE 1 + MORT : depose un Butin allie sur la premiere case de sa ligne", () => {
  // Same text as #1275, on a bigger body (HP 4 / AT 5).
  const coffreEn = (owner: "ally" | "enemy", pos: { x: number; y: number }) =>
    mkCreature(1, owner, pos, {
      cardId: 1320, triggers: card(1320).triggers ?? [], resistance: 1,
      currentLife: 4, baseLife: 4,
    });
  const tuer = (coffre: ReturnType<typeof mkCreature>, autres: ReturnType<typeof mkCreature>[] = []) => {
    const base = bareBoard(scenario([coffre, ...autres]));
    const creatures = base.creatures.map((c) => (c.instanceId === coffre.instanceId ? { ...c, currentLife: 0 } : c));
    return resolveDeathsAndWin(base, creatures, base.dofuses, [...base.log], new Set());
  };

  it("le coffre invoque porte bien RESISTANCE 1", () => {
    card(1320);
    const s = playCard(bareBoard(scenario([], 1320)), card(1320), { x: 8, y: 3 });
    const coffre = s.creatures.find((c) => c.cardId === 1320)!;
    expect(coffre.resistance).toBe(1);
    expect(coffre.currentLife).toBe(4);
  });

  it("RESISTANCE : un coup de 2 ne lui coute qu'1 PV", () => {
    card(1320);
    const frappeur = mkCreature(2, "enemy", { x: 7, y: 3 }, {
      currentAttack: 2, baseAttack: 2, currentLife: 20, baseLife: 20, movementLeft: 2,
    });
    const s0 = playCard(bareBoard(withDecks(scenario([frappeur], 1320))), card(1320), { x: 8, y: 3 });
    const s = endTurn(endTurn(s0));
    const coffre = s.creatures.find((c) => c.cardId === 1320 && c.currentLife > 0)!;
    expect(coffre.currentLife).toBe(3); // 4 PV - (2 - 1)
  });

  it("MORT : le Butin tombe sur la LIGNE du coffre, pas sur une autre", () => {
    card(1320);
    const s = tuer(coffreEn("ally", { x: 5, y: 4 }));
    expect((s.butins ?? []).map((b) => b.position)).toEqual([{ x: 8, y: 4 }]);
  });

  it("un coffre ADVERSE depose son Butin sur SA premiere case a lui (x=1) et il lui appartient", () => {
    card(1320);
    const s = tuer(coffreEn("enemy", { x: 4, y: 2 }));
    expect(s.butins ?? []).toHaveLength(1);
    expect((s.butins ?? [])[0].position).toEqual({ x: 1, y: 2 });
    expect((s.butins ?? [])[0].owner).toBe("enemy");
  });

  it("premiere case deja occupee par une creature : aucun Butin", () => {
    card(1320);
    // Positive control first: without the squatter, the same setup does drop a Butin.
    // Without this control, the test would also pass if the MORT trigger were removed.
    expect(tuer(coffreEn("ally", { x: 5, y: 3 })).butins ?? []).toHaveLength(1);
    const squatteur = mkCreature(2, "ally", { x: 8, y: 3 }, {});
    const s = tuer(coffreEn("ally", { x: 5, y: 3 }), [squatteur]);
    expect(s.butins ?? []).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("#1042 Cadeau de Nowel - donne un cadeau a l'invocation qui l'ouvre", () => {
  // Text: « Donne un cadeau a l'invocation qui l'ouvre... un beau, si elle a ete
  // gentille. » #1042 is a token (isToken): it is never played from a hand. It is
  // placed on the board by the Reine de Nowel #703 and then lives as the ground
  // object `state.gifts`. The rule used is four outcomes with equal odds (+1 AT | +1 AR
  // | +1 PM | 1 damage); the "un beau, si elle a ete gentille" part is not modelled, on
  // purpose.
  //
  // Already covered by spells.test.ts: placement by #703, pickup by an allied creature,
  // all four outcomes being reachable, death on the gift's cell. What was covered
  // nowhere and is tested here: "l'invocation qui l'ouvre" has no camp, so a gift
  // placed by one camp is opened by the enemy creature that walks on it, and that
  // creature is the one that gets the effect.
  const marcheurAdverse = () =>
    mkCreature(1, "enemy", { x: 3, y: 2 }, {
      baseMovement: 1, printedMovement: 1, movementLeft: 1,
      currentAttack: 3, baseAttack: 3, currentLife: 4, baseLife: 4, armor: 0,
    });

  it("un cadeau ALLIE ouvert par une invocation ADVERSE : consomme, et c'est l'ADVERSE qui recoit l'effet", () => {
    for (let seed = 0; seed < 12; seed++) {
      const base = bareBoard(withDecks(scenario([marcheurAdverse()])));
      const st = { ...base, rng: seed, gifts: [{ position: { x: 4, y: 2 }, owner: "ally" as const }] };
      // 1er endTurn : fin du tour allie. 2e : l'ennemi avance de (3,2) vers (4,2).
      const s = endTurn(endTurn(st));
      expect(s.gifts ?? []).toHaveLength(0); // le cadeau a bien ete ouvert
      const w = byId(s, 1)!;
      // Exactly one of the four outcomes, on the enemy walker.
      const delta = (w.currentAttack - 3) + (w.armor - 0) + (w.baseMovement - 1) + (4 - w.currentLife);
      expect(delta).toBe(1);
    }
  });

  it("sans cadeau sur son chemin, le meme marcheur ne gagne rien (temoin)", () => {
    const s = endTurn(endTurn(bareBoard(withDecks(scenario([marcheurAdverse()])))));
    const w = byId(s, 1)!;
    expect(w.currentAttack).toBe(3);
    expect(w.armor).toBe(0);
    expect(w.baseMovement).toBe(1);
    expect(w.currentLife).toBe(4);
  });
});
