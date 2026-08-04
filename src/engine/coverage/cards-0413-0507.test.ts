// Coverage for cards that are wired in the engine but were not used in any test:
//   #413 #419 #423 #425 #435 #448 #450 #457 #467 #497 #504 #507
//
// Each assertion comes from the card's text, never from what the engine does: a
// test written by copying the engine's output would lock its bugs in instead of
// showing them.
import { describe, it, expect } from "vitest";
import { card, mkCreature, scenario, byId } from "../testkit";
import { playCard, endTurn, canPlayCard, resolvePendingAction, validPendingTargets, resolveDeathsAndWin, withAuras } from "../rules";
import { validSpawnCells } from "../queries";
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

// Put a card (and the AP to pay for it) in the hand of the active camp.
const handOf = (s: GameState, side: "ally" | "enemy", ids: number[]): GameState => ({
  ...s,
  activeSide: side,
  players: {
    ...s.players,
    [side]: { ...s.players[side], hand: [...ids], handCostMods: ids.map(() => 0), ap: 20, maxAp: 20 },
  },
});

describe("#413 Kam Erlite, « Gagne +1 AR quand une invocation alliée meurt »", () => {
  // Three qualifiers: the gain is +1 AR (no AT), it is triggered by an allied death
  // (not an enemy one), and it fires on every death.
  const kam = () =>
    mkCreature(1, "ally", { x: 7, y: 2 }, {
      cardId: 413, triggers: card(413).triggers ?? [],
      currentAttack: 5, baseAttack: 5, printedAttack: 5,
      currentLife: 3, baseLife: 3, armor: 0,
    });

  it("une invocation ALLIÉE qui meurt donne +1 AR", () => {
    card(413);
    const victime = mkCreature(2, "ally", { x: 6, y: 2 }, { currentLife: 0 });
    const sc = bareBoard(scenario([kam(), victime]));
    const s = resolveDeathsAndWin(sc, sc.creatures, sc.dofuses, [], new Set());
    expect(byId(s, 1)!.armor).toBe(1);
    expect(byId(s, 1)!.currentAttack).toBe(5); // the text only gives AR
  });

  it("une invocation ADVERSE qui meurt ne donne rien (« alliée »)", () => {
    card(413);
    const victime = mkCreature(2, "enemy", { x: 4, y: 2 }, { currentLife: 0 });
    const sc = bareBoard(scenario([kam(), victime]));
    const s = resolveDeathsAndWin(sc, sc.creatures, sc.dofuses, [], new Set());
    expect(byId(s, 1)!.armor).toBe(0);
  });

  it("deux morts alliées dans le même balayage donnent +2 AR (une fois par mort)", () => {
    card(413);
    const v1 = mkCreature(2, "ally", { x: 6, y: 1 }, { currentLife: 0 });
    const v2 = mkCreature(3, "ally", { x: 6, y: 3 }, { currentLife: 0 });
    const sc = bareBoard(scenario([kam(), v1, v2]));
    const s = resolveDeathsAndWin(sc, sc.creatures, sc.dofuses, [], new Set());
    expect(byId(s, 1)!.armor).toBe(2);
  });
});

describe("#457 Kerubim le Nunchakeur, « Gagne +1 AT et +1 AR quand une invocation alliée meurt »", () => {
  const kerubim = () =>
    mkCreature(1, "ally", { x: 7, y: 2 }, {
      cardId: 457, triggers: card(457).triggers ?? [],
      currentAttack: 4, baseAttack: 4, printedAttack: 4,
      currentLife: 4, baseLife: 4, armor: 0,
    });

  it("une mort ALLIÉE donne +1 AT ET +1 AR (les deux, pas l'un ou l'autre)", () => {
    card(457);
    const victime = mkCreature(2, "ally", { x: 6, y: 2 }, { currentLife: 0 });
    const sc = bareBoard(scenario([kerubim(), victime]));
    const s = resolveDeathsAndWin(sc, sc.creatures, sc.dofuses, [], new Set());
    expect(byId(s, 1)!.currentAttack).toBe(5); // 4 + 1
    expect(byId(s, 1)!.armor).toBe(1);
  });

  it("une mort ADVERSE ne donne ni AT ni AR (« alliée »)", () => {
    card(457);
    const victime = mkCreature(2, "enemy", { x: 4, y: 2 }, { currentLife: 0 });
    const sc = bareBoard(scenario([kerubim(), victime]));
    const s = resolveDeathsAndWin(sc, sc.creatures, sc.dofuses, [], new Set());
    expect(byId(s, 1)!.currentAttack).toBe(4);
    expect(byId(s, 1)!.armor).toBe(0);
  });

  it("deux morts alliées dans le même balayage donnent +2 AT et +2 AR (une fois par mort)", () => {
    card(457);
    const v1 = mkCreature(2, "ally", { x: 6, y: 1 }, { currentLife: 0 });
    const v2 = mkCreature(3, "ally", { x: 6, y: 3 }, { currentLife: 0 });
    const sc = bareBoard(scenario([kerubim(), v1, v2]));
    const s = resolveDeathsAndWin(sc, sc.creatures, sc.dofuses, [], new Set());
    expect(byId(s, 1)!.currentAttack).toBe(6); // 4 + 1 + 1
    expect(byId(s, 1)!.armor).toBe(2);
  });
});

describe("#419 Guy Yomtella, « PORTÉE : 4 »", () => {
  // The printed range is 4 (RangeMax). It has to be set at summon and be exactly 4: an
  // enemy 4 cells away is shot on the spot, an enemy 5 cells away forces a step first.
  const poser = (foe: ReturnType<typeof mkCreature>) => {
    let s = bareBoard(withDecks(scenario([foe])));
    s = handOf(s, "ally", [419]);
    s = playCard(s, card(419), { x: 8, y: 0 });
    // Summoning sickness is lifted: the range is measured on a shooter that acts.
    return {
      ...s,
      creatures: s.creatures.map((c) =>
        c.cardId === 419 ? { ...c, movementLeft: c.baseMovement, hasAttacked: false } : c,
      ),
    };
  };

  it("l'invocation posée porte une portée de 4", () => {
    card(419);
    const s = poser(mkCreature(2, "enemy", { x: 4, y: 0 }, { currentLife: 10, baseLife: 10 }));
    expect(s.creatures.find((c) => c.cardId === 419)!.range).toBe(4);
  });

  it("un ennemi à 4 cases est touché SANS que le tireur bouge ni ne subisse de riposte", () => {
    card(419);
    // Guy en (8,0), ennemi en (4,0) : distance 4 = sa portée.
    const s = endTurn(poser(mkCreature(2, "enemy", { x: 4, y: 0 }, { currentAttack: 9, baseAttack: 9, currentLife: 10, baseLife: 10 })));
    const guy = s.creatures.find((c) => c.cardId === 419)!;
    expect(byId(s, 2)!.currentLife).toBe(7); // 10 − 3 (AT imprimée de Guy)
    expect(guy.position).toEqual({ x: 8, y: 0 }); // a tiré depuis sa case
    expect(guy.currentLife).toBe(3);             // a shot does not take a hit back
  });

  it("un ennemi à 5 cases est hors de portée : le tireur fait UN pas puis tire", () => {
    card(419);
    // Guy at (8,0), enemy at (3,0): distance 5 > 4. It moves one cell (to 7) and is then
    // only 4 away: it shoots. Proof that the range is 4 and not 5.
    const s = endTurn(poser(mkCreature(2, "enemy", { x: 3, y: 0 }, { currentAttack: 9, baseAttack: 9, currentLife: 10, baseLife: 10 })));
    const guy = s.creatures.find((c) => c.cardId === 419)!;
    expect(guy.position).toEqual({ x: 7, y: 0 }); // a single step, then it stops to shoot
    expect(byId(s, 2)!.currentLife).toBe(7);      // 10 − 3
    expect(guy.currentLife).toBe(3);              // toujours aucune riposte
  });
});

describe("#423 Déphasage, « Confère inciblable à une invocation »", () => {
  // castTarget AnySummon: the text says "une invocation", with no camp limit, so the
  // effect has to work on an ally as well as on an enemy.
  it("confère INCIBLABLE à une invocation alliée", () => {
    card(423);
    const cible = mkCreature(1, "ally", { x: 6, y: 2 });
    let s = handOf(bareBoard(scenario([cible])), "ally", [423]);
    expect(byId(s, 1)!.properties.has("Untargetable")).toBe(false);
    s = playCard(s, card(423), { x: 6, y: 2 });
    expect(byId(s, 1)!.properties.has("Untargetable")).toBe(true);
  });

  it("confère INCIBLABLE à une invocation ADVERSE (le texte ne restreint pas le camp)", () => {
    card(423);
    const cible = mkCreature(1, "enemy", { x: 3, y: 2 });
    let s = handOf(bareBoard(scenario([cible])), "ally", [423]);
    s = playCard(s, card(423), { x: 3, y: 2 });
    expect(byId(s, 1)!.properties.has("Untargetable")).toBe(true);
  });

  it("conséquence : la cible devenue inciblable ne peut plus être choisie par un sort", () => {
    card(423);
    const cible = mkCreature(1, "ally", { x: 6, y: 2 });
    let s = handOf(bareBoard(scenario([cible])), "ally", [423, 423]);
    expect(canPlayCard(s, card(423), { x: 6, y: 2 })).toBeNull(); // légal avant
    s = playCard(s, card(423), { x: 6, y: 2 });
    // The reason for the refusal is checked explicitly: a bare `not.toBeNull()` would pass
    // for any other reason (missing AP, card not in hand...).
    expect(canPlayCard(s, card(423), { x: 6, y: 2 })).toBe("Cette créature est intargetable.");
  });
});

describe("#425 Epouventrail, « MUR »", () => {
  // MUR = Statue property: can be placed anywhere on the allied side (castTarget
  // EmptyAlliedCells, not only the summon column) and never advances.
  it("un MUR est posable ailleurs que sur la colonne d'invocation, contrairement à une invocation normale", () => {
    card(425); card(413);
    const s = bareBoard(scenario([]));
    const murCells = validSpawnCells(s, "ally", card(425));
    const normalCells = validSpawnCells(s, "ally", card(413));
    expect(murCells).toContainEqual({ x: 5, y: 2 });    // milieu du camp allié
    expect(normalCells).not.toContainEqual({ x: 5, y: 2 });
    expect(normalCells.every((c) => c.x === 8)).toBe(true); // invocation normale : colonne 8
  });

  it("un MUR n'est PAS posable dans le camp adverse", () => {
    card(425);
    const s = bareBoard(scenario([]));
    expect(validSpawnCells(s, "ally", card(425)).some((c) => c.x <= 4)).toBe(false);
  });

  const poserMur = () => {
    const s = handOf(bareBoard(withDecks(scenario([]))), "ally", [425, 413, 429]);
    return playCard(s, card(425), { x: 5, y: 2 });
  };

  it("posé, il porte la propriété MUR", () => {
    card(425);
    expect(poserMur().creatures.find((c) => c.cardId === 425)!.properties.has("Statue")).toBe(true);
  });

  it("MUR : il ne bouge pas même en lui donnant 3 PM, alors que privé de MUR il traverserait le plateau", () => {
    card(425);
    // Careful: the Epouventrail has 0 printed PM. Seeing it stay still proves nothing
    // about the MUR property, it would stay put even without it. It has to be given PM
    // by force and compared with its control without Statue.
    const s = poserMur();
    const avecPm = (st: GameState) => ({
      ...st,
      creatures: st.creatures.map((c) =>
        c.cardId === 425 ? { ...c, baseMovement: 3, printedMovement: 3, movementLeft: 3, hasAttacked: false } : c,
      ),
    });
    const sansStatue = (st: GameState) => ({
      ...st,
      creatures: st.creatures.map((c) => {
        if (c.cardId !== 425) return c;
        const p = new Set(c.properties);
        p.delete("Statue");
        return { ...c, properties: p };
      }),
    });
    // Three ends of turn: its own, the opponent's, then its own again (on that turn the
    // summoning sickness is gone and the advance happens).
    const trois = (st: GameState) => endTurn(endTurn(endTurn(st)));
    expect(trois(avecPm(s)).creatures.find((c) => c.cardId === 425)!.position).toEqual({ x: 5, y: 2 });
    // Control: the same creature without MUR does advance.
    const temoin = trois(avecPm(sansStatue(s))).creatures.find((c) => c.cardId === 425)!;
    expect(temoin.position.x).toBeLessThan(5);
  });

  it("conséquence du MUR : un Bond #429 (« une invocation alliée sauf un Mur ») le refuse", () => {
    card(425); card(429); card(413);
    let s = poserMur();
    s = playCard(s, card(413), { x: 8, y: 1 }); // une invocation alliée ordinaire
    expect(canPlayCard(s, card(429), { x: 5, y: 2 })).toBe("Un Mur ne peut pas être ciblé.");
    expect(canPlayCard(s, card(429), { x: 8, y: 1 })).toBeNull(); // le témoin non-MUR, lui, est ciblable
  });
});

describe("#435 Assoiffé, « Bannit les 4 dernières cartes parties dans votre défausse pour infliger 5 »", () => {
  // Two halves of the text: the cost (banish the 4 most recently discarded cards, so it
  // cannot be played with fewer than 4) and the effect (5 damage).
  const defausse = [16, 47, 70, 133, 135]; // la plus ancienne d'abord

  const monter = (discard: number[]) => {
    const foe = mkCreature(1, "enemy", { x: 3, y: 2 }, { currentLife: 8, baseLife: 8 });
    const s = handOf(bareBoard(scenario([foe])), "ally", [435]);
    return { ...s, players: { ...s.players, ally: { ...s.players.ally, discard: [...discard] } } };
  };

  it("injouable avec seulement 3 cartes dans la défausse", () => {
    card(435);
    const s = monter([16, 47, 70]);
    expect(canPlayCard(s, card(435), { x: 3, y: 2 })).toBe("Pas assez de cartes dans votre défausse à bannir.");
  });

  it("jouable dès 4 cartes dans la défausse", () => {
    card(435);
    const s = monter([16, 47, 70, 133]);
    expect(canPlayCard(s, card(435), { x: 3, y: 2 })).toBeNull();
  });

  it("« VOTRE défausse » : une défausse adverse bien garnie ne débloque pas le sort", () => {
    card(435);
    let s = monter([16, 47, 70]); // 3 chez moi
    s = { ...s, players: { ...s.players, enemy: { ...s.players.enemy, discard: [16, 16, 16, 16, 16, 16] } } };
    expect(canPlayCard(s, card(435), { x: 3, y: 2 })).toBe("Pas assez de cartes dans votre défausse à bannir.");
  });

  it("inflige 5 dégâts et bannit exactement les 4 DERNIÈRES défaussées", () => {
    card(435);
    const s = playCard(monter(defausse), card(435), { x: 3, y: 2 });
    expect(byId(s, 1)!.currentLife).toBe(3); // 8 − 5
    const p = s.players.ally;
    expect(p.banished).toEqual([47, 70, 133, 135]); // les 4 plus récentes
    expect(p.discard).not.toContain(47);
    expect(p.discard).not.toContain(135);
    expect(p.discard).toContain(16);  // la plus ancienne reste
    expect(p.discard).toContain(435); // the spell itself goes to the discard
  });

  it("les dégâts passent par l'armure de la cible", () => {
    card(435);
    const foe = mkCreature(1, "enemy", { x: 3, y: 2 }, { currentLife: 8, baseLife: 8, armor: 2 });
    let s = handOf(bareBoard(scenario([foe])), "ally", [435]);
    s = { ...s, players: { ...s.players, ally: { ...s.players.ally, discard: [...defausse] } } };
    s = playCard(s, card(435), { x: 3, y: 2 });
    expect(byId(s, 1)!.armor).toBe(0);       // 2 d'armure absorbés
    expect(byId(s, 1)!.currentLife).toBe(5); // 8 − 3 restants
  });
});

describe("#448 Truchon, « Change de ligne quand une invocation adverse entre en jeu »", () => {
  const truchon = () =>
    mkCreature(1, "ally", { x: 6, y: 2 }, {
      cardId: 448, triggers: card(448).triggers ?? [],
      currentAttack: 2, baseAttack: 2, currentLife: 1, baseLife: 1,
      baseMovement: 3, movementLeft: 3,
    });

  it("une invocation ADVERSE qui entre en jeu le fait changer de ligne (même colonne)", () => {
    card(448); card(453);
    let s = handOf(bareBoard(withDecks(scenario([truchon()]))), "enemy", [453]);
    s = playCard(s, card(453), { x: 1, y: 0 }); // l'adversaire invoque un Tofu
    const t = byId(s, 1)!;
    expect(t.position.x).toBe(6);            // même colonne
    expect([1, 3]).toContain(t.position.y);  // ligne adjacente (il était en y=2)
  });

  it("une invocation ALLIÉE qui entre en jeu ne le fait PAS bouger (« adverse »)", () => {
    card(448); card(453);
    let s = handOf(bareBoard(withDecks(scenario([truchon()]))), "ally", [453]);
    s = playCard(s, card(453), { x: 8, y: 0 }); // c'est MOI qui invoque
    expect(byId(s, 1)!.position).toEqual({ x: 6, y: 2 });
  });

  it("les deux lignes voisines occupées : il reste sur place (aucune case libre)", () => {
    card(448); card(453);
    const haut = mkCreature(2, "ally", { x: 6, y: 1 });
    const bas = mkCreature(3, "ally", { x: 6, y: 3 });
    let s = handOf(bareBoard(withDecks(scenario([truchon(), haut, bas]))), "enemy", [453]);
    s = playCard(s, card(453), { x: 1, y: 0 });
    expect(byId(s, 1)!.position).toEqual({ x: 6, y: 2 });
  });
});

describe("#450 Tiwabbit Tados, « APPARITION : Charge de 1 case si vous avez une Cawotte en jeu »", () => {
  const poser = (board: ReturnType<typeof mkCreature>[]) => {
    const s = handOf(bareBoard(withDecks(scenario(board))), "ally", [450]);
    return playCard(s, card(450), { x: 8, y: 2 });
  };

  it("avec une Cawotte alliée en jeu : il charge de 1 case (8 → 7)", () => {
    card(450); card(133);
    const cawotte = mkCreature(2, "ally", { x: 6, y: 0 }, { cardId: 133 });
    const s = poser([cawotte]);
    expect(s.creatures.find((c) => c.cardId === 450)!.position).toEqual({ x: 7, y: 2 });
  });

  it("sans Cawotte : il reste sur sa case d'invocation", () => {
    card(450);
    const s = poser([]);
    expect(s.creatures.find((c) => c.cardId === 450)!.position).toEqual({ x: 8, y: 2 });
  });

  it("une Cawotte ADVERSE ne compte pas (« si VOUS avez une Cawotte en jeu »)", () => {
    card(450); card(133);
    const cawotteAdverse = mkCreature(2, "enemy", { x: 3, y: 0 }, { cardId: 133 });
    const s = poser([cawotteAdverse]);
    expect(s.creatures.find((c) => c.cardId === 450)!.position).toEqual({ x: 8, y: 2 });
  });
});

describe("#467 Fumfamfim, « APPARITION : Échangez sa position avec celle d'un allié »", () => {
  it("échange sa case avec l'allié choisi", () => {
    card(467);
    const allie = mkCreature(1, "ally", { x: 6, y: 2 }, { currentAttack: 5, baseAttack: 5 });
    let s = handOf(bareBoard(withDecks(scenario([allie]))), "ally", [467]);
    s = playCard(s, card(467), { x: 8, y: 0 });
    expect(s.pendingAction).not.toBeNull();
    expect(s.pendingAction!.filter).toBe("ally_creature");
    s = resolvePendingAction(s, { x: 6, y: 2 });
    expect(s.creatures.find((c) => c.cardId === 467)!.position).toEqual({ x: 6, y: 2 });
    expect(byId(s, 1)!.position).toEqual({ x: 8, y: 0 });
    expect(s.pendingAction).toBeNull();
  });

  it("aucun cap d'AT (« un allié », sans restriction) et il ne s'échange pas avec lui-même", () => {
    card(467);
    const gros = mkCreature(1, "ally", { x: 6, y: 2 }, { currentAttack: 5, baseAttack: 5 });
    let s = handOf(bareBoard(withDecks(scenario([gros]))), "ally", [467]);
    s = playCard(s, card(467), { x: 8, y: 0 });
    expect(validPendingTargets(s)).toContainEqual({ x: 6, y: 2 });
    expect(validPendingTargets(s)).not.toContainEqual({ x: 8, y: 0 }); // sa propre case
  });

  it("une invocation ADVERSE n'est pas un choix légal (« un allié »)", () => {
    card(467);
    const allie = mkCreature(1, "ally", { x: 6, y: 2 });
    const adverse = mkCreature(2, "enemy", { x: 3, y: 2 });
    let s = handOf(bareBoard(withDecks(scenario([allie, adverse]))), "ally", [467]);
    s = playCard(s, card(467), { x: 8, y: 0 });
    expect(validPendingTargets(s)).not.toContainEqual({ x: 3, y: 2 });
  });

  it("sans aucun autre allié : aucun choix demandé, il se pose simplement", () => {
    card(467);
    let s = handOf(bareBoard(withDecks(scenario([]))), "ally", [467]);
    s = playCard(s, card(467), { x: 8, y: 0 });
    expect(s.pendingAction).toBeNull();
    expect(s.creatures.find((c) => c.cardId === 467)!.position).toEqual({ x: 8, y: 0 });
  });
});

describe("#497 Corbac Chef, « CHEF : +1 PM à vos autres Corbacs »", () => {
  // Four qualifiers: the stat (PM only), the family (Corbac), the camp ("vos") and
  // itself excluded ("autres").
  const build = () => {
    card(497); card(56);
    const chef = mkCreature(1, "ally", { x: 8, y: 2 }, {
      cardId: 497, currentAttack: 2, baseAttack: 2, printedAttack: 2,
      baseMovement: 2, printedMovement: 2, currentLife: 4, baseLife: 4,
    });
    // #56 Corbac : AT 2, PV 1, PM 3.
    const corbacAllie = mkCreature(2, "ally", { x: 6, y: 1 }, {
      cardId: 56, currentAttack: 2, baseAttack: 2, printedAttack: 2,
      baseMovement: 3, printedMovement: 3, currentLife: 1, baseLife: 1,
    });
    const allieNonCorbac = mkCreature(3, "ally", { x: 6, y: 3 }, {
      cardId: 453, baseMovement: 5, printedMovement: 5,
    });
    const corbacAdverse = mkCreature(4, "enemy", { x: 3, y: 1 }, {
      cardId: 56, currentAttack: 2, baseAttack: 2, printedAttack: 2,
      baseMovement: 3, printedMovement: 3, currentLife: 1, baseLife: 1,
    });
    return withAuras([chef, corbacAllie, allieNonCorbac, corbacAdverse]);
  };

  it("un Corbac allié gagne +1 PM, et RIEN d'autre (le texte ne donne pas d'AT)", () => {
    const cs = build();
    const c = cs.find((x) => x.instanceId === 2)!;
    expect(c.baseMovement).toBe(4);   // 3 imprimé + 1
    expect(c.currentAttack).toBe(2);  // inchangée
  });

  it("un allié qui n'est pas un Corbac ne reçoit rien", () => {
    const cs = build();
    expect(cs.find((x) => x.instanceId === 3)!.baseMovement).toBe(5);
  });

  it("un Corbac ADVERSE ne reçoit rien (« vos » Corbacs)", () => {
    const cs = build();
    expect(cs.find((x) => x.instanceId === 4)!.baseMovement).toBe(3);
  });

  it("le Corbac Chef ne se buffe pas lui-même (« vos AUTRES Corbacs »)", () => {
    const cs = build();
    expect(cs.find((x) => x.instanceId === 1)!.baseMovement).toBe(2);
  });

  it("témoin : sans le Chef sur le plateau, le même Corbac reste à 3 PM (le +1 vient bien de lui)", () => {
    card(56);
    const corbacSeul = mkCreature(2, "ally", { x: 6, y: 1 }, {
      cardId: 56, currentAttack: 2, baseAttack: 2, printedAttack: 2,
      baseMovement: 3, printedMovement: 3, currentLife: 1, baseLife: 1,
    });
    expect(withAuras([corbacSeul]).find((x) => x.instanceId === 2)!.baseMovement).toBe(3);
  });
});

describe("#504 Archille, « INITIATIVE »", () => {
  // INITIATIVE = hits first: a target killed by its hit does not hit back.
  const poser = () => {
    const foe = mkCreature(2, "enemy", { x: 7, y: 2 }, { currentAttack: 3, baseAttack: 3, currentLife: 4, baseLife: 4 });
    let s = handOf(bareBoard(withDecks(scenario([foe]))), "ally", [504]);
    s = playCard(s, card(504), { x: 8, y: 2 });
    // Summoning sickness is lifted so Archille fights at the end of the turn.
    return {
      ...s,
      creatures: s.creatures.map((c) =>
        c.cardId === 504 ? { ...c, movementLeft: c.baseMovement, hasAttacked: false } : c,
      ),
    };
  };

  it("l'invocation posée porte bien INITIATIVE", () => {
    card(504);
    expect(poser().creatures.find((c) => c.cardId === 504)!.properties.has("FirstStrike")).toBe(true);
  });

  it("elle tue l'ennemi collé SANS subir la riposte", () => {
    card(504);
    const s = endTurn(poser());
    expect(byId(s, 2)).toBeUndefined();                                    // 4 AT vs 4 PV → mort
    expect(s.creatures.find((c) => c.cardId === 504)!.currentLife).toBe(4); // intacte
  });

  it("témoin : privée d'INITIATIVE, la même créature encaisse la riposte", () => {
    card(504);
    const base = poser();
    const sans = {
      ...base,
      creatures: base.creatures.map((c) => {
        if (c.cardId !== 504) return c;
        const p = new Set(c.properties);
        p.delete("FirstStrike");
        return { ...c, properties: p };
      }),
    };
    const s = endTurn(sans);
    expect(byId(s, 2)).toBeUndefined();
    expect(s.creatures.find((c) => c.cardId === 504)!.currentLife).toBe(1); // 4 − 3
  });
});

describe("#507 Noximilien l'Horloger, « MORT : Ajoute 2 PA à votre réserve »", () => {
  it("sa mort ajoute 2 PA à la réserve de SON contrôleur", () => {
    card(507);
    const nox = mkCreature(1, "ally", { x: 6, y: 2 }, {
      cardId: 507, triggers: card(507).triggers ?? [],
      currentAttack: 4, baseAttack: 4, currentLife: 0, baseLife: 3,
    });
    const sc = bareBoard(scenario([nox]));
    const avant = sc.players.ally.apReserve;
    const s = resolveDeathsAndWin(sc, sc.creatures, sc.dofuses, [], new Set());
    expect(s.players.ally.apReserve).toBe(avant + 2);
    expect(s.players.enemy.apReserve).toBe(sc.players.enemy.apReserve);
  });

  it("un Noximilien ADVERSE qui meurt remplit la réserve ADVERSE, pas la mienne", () => {
    card(507);
    const nox = mkCreature(1, "enemy", { x: 3, y: 2 }, {
      cardId: 507, triggers: card(507).triggers ?? [],
      currentAttack: 4, baseAttack: 4, currentLife: 0, baseLife: 3,
    });
    const sc = bareBoard(scenario([nox]));
    const s = resolveDeathsAndWin(sc, sc.creatures, sc.dofuses, [], new Set());
    expect(s.players.enemy.apReserve).toBe(sc.players.enemy.apReserve + 2);
    expect(s.players.ally.apReserve).toBe(sc.players.ally.apReserve);
  });

  it("son INVOCATION ne donne rien : le texte réserve le gain à la MORT", () => {
    card(507);
    let s = handOf(bareBoard(withDecks(scenario([]))), "ally", [507]);
    const avant = s.players.ally.apReserve;
    s = playCard(s, card(507), { x: 8, y: 2 });
    expect(s.players.ally.apReserve).toBe(avant);
  });
});
