// Coverage for cards that are wired in the engine but were not used in any test.
// Cards: #234 #235 #237 #240 #244 #247 #249 #265 #266 #267 #275 #277
//
// Each assertion comes from the card's text, never from what the engine does: a
// test written by copying the engine's output would lock its bugs in instead of
// showing them.
//
// A stat that comes from the card (resistance, range, property, aura) has to reach
// the test through actually summoning the card, never copied by hand into
// mkCreature; otherwise the test checks the engine's generic mechanism and would
// stay green even if the card lost its effect. So the setups below summon the card
// and then move the resulting instance, keeping what the engine set on it.
import { describe, it, expect } from "vitest";
import { card, mkCreature, scenario, byId } from "../testkit";
import { playCard, endTurn, runTrigger, resolvePendingAction, validPendingTargets, canPlayCard } from "../rules";
import { validSpawnCells } from "../queries";
import type { GameState } from "../state";
import type { Coords } from "../board";

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

// Summon `cardId` from the hand (summon column 8), then move the resulting instance
// to `pos`. Everything the card set at summon (resistance, range, properties,
// triggers, printed stats) is kept, so the following test is really about the card
// and not about copied values.
const summonThenPlace = (
  s: GameState,
  cardId: number,
  pos: Coords,
  extra: Partial<GameState["creatures"][number]> = {},
): { state: GameState; id: number } => {
  const played = playCard(s, card(cardId), { x: 8, y: 2 });
  const inst = played.creatures.find((c) => c.cardId === cardId)!;
  return {
    id: inst.instanceId,
    state: {
      ...played,
      creatures: played.creatures.map((c) =>
        c.instanceId === inst.instanceId ? { ...c, position: { ...pos }, ...extra } : c,
      ),
    },
  };
};

// ---------------------------------------------------------------------------
// #234 Craqueboule Chuchote, « RESISTANCE : 1 / MORT : Invoque un Chuchoteur
// Porte-Etendard. »  (AT 3, PV 3, PM 2)
// ---------------------------------------------------------------------------
describe("#234 Craqueboule Chuchote - RESISTANCE 1 + MORT : invoque un Chuchoteur Porte-Etendard", () => {
  it("invoque depuis la main : la creature entre en jeu avec RESISTANCE 1 et ses stats imprimees", () => {
    let s = bareBoard(scenario([], 234));
    s = playCard(s, card(234), { x: 8, y: 2 });
    const craq = s.creatures.find((c) => c.cardId === 234)!;
    expect(craq.resistance).toBe(1);   // « RESISTANCE : 1 »
    expect(craq.currentLife).toBe(3);
    expect(craq.currentAttack).toBe(3);
  });

  // The tested creature is the one the engine just summoned: its resistance comes from
  // the card, not from an mkCreature set up to pass.
  const combat = (foeAttack: number) => {
    const foe = mkCreature(2, "enemy", { x: 4, y: 2 }, {
      currentAttack: foeAttack, baseAttack: foeAttack, currentLife: 12, baseLife: 12,
      baseMovement: 2, movementLeft: 2,
    });
    const { state, id } = summonThenPlace(bareBoard(withDecks(scenario([foe], 234))), 234, { x: 6, y: 2 });
    // The enemy starts 2 cells away: nothing on the first endTurn (end of the ally turn,
    // the Craqueboule has summoning sickness and does not move); it comes into contact
    // and hits once on the second (enemy advance).
    return { s: endTurn(endTurn(state)), id };
  };

  it("RESISTANCE 1 : un coup de 3 ne lui retire que 2 PV", () => {
    const { s, id } = combat(3);
    expect(byId(s, id)!.currentLife).toBe(1); // 3 PV - (3 - 1)
  });

  it("tant qu'il survit, aucun Chuchoteur n'apparait (la MORT seule declenche)", () => {
    const { s, id } = combat(3);
    expect(byId(s, id)!.currentLife).toBeGreaterThan(0);
    expect(s.creatures.some((c) => c.cardId === 555)).toBe(false);
  });

  it("MORT : sa destruction fait apparaitre un Chuchoteur Porte-Etendard (#555) allie sur sa case", () => {
    // 6 d'AT - 1 de resistance = 5 degats > 3 PV : il meurt.
    const { s, id } = combat(6);
    expect(byId(s, id)).toBeUndefined(); // detruit
    const token = s.creatures.find((c) => c.cardId === 555);
    expect(token).toBeDefined();
    expect(token!.owner).toBe("ally");               // the token belongs to the dead creature's camp
    expect(token!.position).toEqual({ x: 6, y: 2 }); // sur la case liberee
    expect(token!.currentLife).toBe(card(555).life);     // 2
    expect(token!.currentAttack).toBe(card(555).attack); // 1
  });
});

// ---------------------------------------------------------------------------
// #267 Craqueleur Ancestral, « RESISTANCE : 1 / MORT : Invoque un
// Craqueboule. »  (AT 4, PV 5, PM 2)
// ---------------------------------------------------------------------------
describe("#267 Craqueleur Ancestral - RESISTANCE 1 + MORT : invoque un Craqueboule", () => {
  it("invoque depuis la main : la creature entre en jeu avec RESISTANCE 1 et ses stats imprimees", () => {
    let s = bareBoard(scenario([], 267));
    s = playCard(s, card(267), { x: 8, y: 2 });
    const cra = s.creatures.find((c) => c.cardId === 267)!;
    expect(cra.resistance).toBe(1);
    expect(cra.currentLife).toBe(5);
    expect(cra.currentAttack).toBe(4);
  });

  const combat = (foeAttack: number) => {
    const foe = mkCreature(2, "enemy", { x: 4, y: 2 }, {
      currentAttack: foeAttack, baseAttack: foeAttack, currentLife: 14, baseLife: 14,
      baseMovement: 2, movementLeft: 2,
    });
    const { state, id } = summonThenPlace(bareBoard(withDecks(scenario([foe], 267))), 267, { x: 6, y: 2 });
    return { s: endTurn(endTurn(state)), id };
  };

  it("RESISTANCE 1 : un coup de 4 ne lui retire que 3 PV", () => {
    const { s, id } = combat(4);
    expect(byId(s, id)!.currentLife).toBe(2); // 5 - (4 - 1)
  });

  it("MORT : sa destruction fait apparaitre un Craqueboule (#210) allie sur sa case", () => {
    // 8 - 1 = 7 degats > 5 PV.
    const { s, id } = combat(8);
    expect(byId(s, id)).toBeUndefined();
    const token = s.creatures.find((c) => c.cardId === 210);
    expect(token).toBeDefined();
    expect(token!.owner).toBe("ally");
    expect(token!.position).toEqual({ x: 6, y: 2 });
    expect(token!.resistance).toBe(1); // le Craqueboule invoque a sa propre « RESISTANCE : 1 »
  });

  it("tant qu'il survit, aucun Craqueboule n'apparait", () => {
    const { s, id } = combat(4);
    expect(byId(s, id)!.currentLife).toBeGreaterThan(0);
    expect(s.creatures.some((c) => c.cardId === 210)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #237 Gligli Agressif, « CHEF : +1 PM a vos autres Gliglis. » (AT 3, PV 4, PM 4)
// ---------------------------------------------------------------------------
describe("#237 Gligli Agressif - CHEF : +1 PM a vos AUTRES Gliglis", () => {
  // Three qualifiers: the family (Gligli), the camp (vos), itself excluded (autres).
  // And only one stat: PM, not AT.
  const build = () => {
    // #181 Gligli : AT 3, PV 1, PM 3, famille Gligli, allie -> recoit l'aura.
    const gligliAllie = mkCreature(60, "ally", { x: 6, y: 1 }, {
      cardId: 181, currentAttack: 3, baseAttack: 3, printedAttack: 3,
      baseMovement: 3, printedMovement: 3, movementLeft: 3, currentLife: 1, baseLife: 1,
    });
    // Allie hors famille Gligli -> rien.
    const allieNonGligli = mkCreature(61, "ally", { x: 6, y: 3 }, {
      cardId: 9999, currentAttack: 2, baseAttack: 2, baseMovement: 2, movementLeft: 2,
    });
    // Gligli ENNEMI -> « vos » Gliglis : rien.
    const gligliEnnemi = mkCreature(62, "enemy", { x: 3, y: 1 }, {
      cardId: 181, currentAttack: 3, baseAttack: 3, printedAttack: 3,
      baseMovement: 3, printedMovement: 3, movementLeft: 3, currentLife: 1, baseLife: 1,
    });
    const s = bareBoard(scenario([gligliAllie, allieNonGligli, gligliEnnemi], 237));
    return playCard(s, card(237), { x: 8, y: 2 });
  };

  it("un Gligli allie gagne +1 PM", () => {
    const s = build();
    expect(byId(s, 60)!.baseMovement).toBe(4); // 3 imprime + 1 d'aura
  });

  it("l'aura ne touche que les PM : l'AT du Gligli allie est inchangee", () => {
    const s = build();
    expect(byId(s, 60)!.currentAttack).toBe(3);
  });

  it("un allie qui n'est pas un Gligli ne recoit rien", () => {
    const s = build();
    expect(byId(s, 61)!.baseMovement).toBe(2);
  });

  it("un Gligli ENNEMI ne recoit rien (« vos » Gliglis)", () => {
    const s = build();
    expect(byId(s, 62)!.baseMovement).toBe(3);
  });

  it("le Gligli Agressif ne se buffe pas lui-meme (« vos AUTRES Gliglis »)", () => {
    const s = build();
    const chef = s.creatures.find((c) => c.cardId === 237)!;
    expect(chef.baseMovement).toBe(card(237).movement); // 4 imprime, pas 5
  });

  it("CHEF : l'aura tombe des que le chef quitte le plateau", () => {
    const s = build();
    const chef = s.creatures.find((c) => c.cardId === 237)!;
    // The chief is taken off the board: the allied Gligli must get its 3 PM back.
    const sans = playCard(
      { ...s, creatures: s.creatures.filter((c) => c.instanceId !== chef.instanceId), players: { ...s.players, ally: { ...s.players.ally, hand: [16], handCostMods: [0] } } },
      card(16), { x: 8, y: 4 },
    );
    expect(byId(sans, 60)!.baseMovement).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// #249 Ratgnagna, « CHEF : +1 AT et +1 PM a vos autres Rats. » (AT 3, PV 4, PM 2)
// ---------------------------------------------------------------------------
describe("#249 Ratgnagna - CHEF : +1 AT et +1 PM a vos AUTRES Rats", () => {
  const build = () => {
    // #557 Rat Dominant : AT 4, PV 5, PM 3, famille Rat, allie.
    const ratAllie = mkCreature(60, "ally", { x: 6, y: 1 }, {
      cardId: 557, currentAttack: 4, baseAttack: 4, printedAttack: 4,
      baseMovement: 3, printedMovement: 3, movementLeft: 3, currentLife: 5, baseLife: 5,
    });
    const allieNonRat = mkCreature(61, "ally", { x: 6, y: 3 }, {
      cardId: 9999, currentAttack: 2, baseAttack: 2, baseMovement: 2, movementLeft: 2,
    });
    const ratEnnemi = mkCreature(62, "enemy", { x: 3, y: 1 }, {
      cardId: 557, currentAttack: 4, baseAttack: 4, printedAttack: 4,
      baseMovement: 3, printedMovement: 3, movementLeft: 3, currentLife: 5, baseLife: 5,
    });
    const s = bareBoard(scenario([ratAllie, allieNonRat, ratEnnemi], 249));
    return playCard(s, card(249), { x: 8, y: 2 });
  };

  it("un Rat allie gagne +1 AT ET +1 PM", () => {
    const s = build();
    expect(byId(s, 60)!.currentAttack).toBe(5); // 4 + 1
    expect(byId(s, 60)!.baseMovement).toBe(4);  // 3 + 1
  });

  it("un allie qui n'est pas un Rat ne recoit rien", () => {
    const s = build();
    expect(byId(s, 61)!.currentAttack).toBe(2);
    expect(byId(s, 61)!.baseMovement).toBe(2);
  });

  it("un Rat ENNEMI ne recoit rien (« vos » Rats)", () => {
    const s = build();
    expect(byId(s, 62)!.currentAttack).toBe(4);
    expect(byId(s, 62)!.baseMovement).toBe(3);
  });

  it("le Ratgnagna ne se buffe pas lui-meme (« vos AUTRES Rats »)", () => {
    const s = build();
    const chef = s.creatures.find((c) => c.cardId === 249)!;
    expect(chef.currentAttack).toBe(card(249).attack);   // 3
    expect(chef.baseMovement).toBe(card(249).movement);  // 2
  });
});

// ---------------------------------------------------------------------------
// #244 Tofu Noir, « APPARITION : Charge de 1 case. » (AT 2, PV 2, PM 3)
// ---------------------------------------------------------------------------
describe("#244 Tofu Noir - APPARITION : Charge de 1 case", () => {
  it("invoque sur la colonne de depart (x=8), il avance d'EXACTEMENT 1 case", () => {
    let s = bareBoard(scenario([], 244));
    s = playCard(s, card(244), { x: 8, y: 2 });
    const tofu = s.creatures.find((c) => c.cardId === 244)!;
    expect(tofu.position).toEqual({ x: 7, y: 2 }); // 1 cell toward the enemy camp, not 3 (its PM)
  });

  it("la charge d'1 case sur une invocation adverse adjacente la frappe (2 AT) sans changer de case", () => {
    const foe = mkCreature(2, "enemy", { x: 7, y: 2 }, {
      currentAttack: 0, baseAttack: 0, currentLife: 5, baseLife: 5,
    });
    let s = bareBoard(scenario([foe], 244));
    s = playCard(s, card(244), { x: 8, y: 2 });
    const tofu = s.creatures.find((c) => c.cardId === 244)!;
    expect(byId(s, 2)!.currentLife).toBe(3);       // 5 - 2 (l'AT du Tofu Noir)
    expect(tofu.position).toEqual({ x: 8, y: 2 }); // the targeted cell is taken: it stays where it is
  });

  it("« de 1 case » : la charge est son seul mouvement du tour, il n'avance pas une 2e fois en fin de tour", () => {
    let s = bareBoard(withDecks(scenario([], 244)));
    s = playCard(s, card(244), { x: 8, y: 2 });
    expect(s.creatures.find((c) => c.cardId === 244)!.position.x).toBe(7);
    s = endTurn(s);
    expect(s.creatures.find((c) => c.cardId === 244)!.position).toEqual({ x: 7, y: 2 });
  });

  it("la charge est une APPARITION : une case bloquee par un ALLIE ne la fait pas avancer non plus", () => {
    const ami = mkCreature(2, "ally", { x: 7, y: 2 }, { currentLife: 5, baseLife: 5, currentAttack: 0, baseAttack: 0 });
    let s = bareBoard(scenario([ami], 244));
    s = playCard(s, card(244), { x: 8, y: 2 });
    expect(s.creatures.find((c) => c.cardId === 244)!.position).toEqual({ x: 8, y: 2 });
    expect(byId(s, 2)!.currentLife).toBe(5); // it never hits its own camp
  });
});

// ---------------------------------------------------------------------------
// #247 Fantome Cra, « PORTEE : 2 / INCIBLABLE » (AT 3, PV 3, PM 3)
// ---------------------------------------------------------------------------
describe("#247 Fantome Cra - PORTEE 2 + INCIBLABLE", () => {
  it("invoque depuis la main : portee 2 et propriete INCIBLABLE", () => {
    let s = bareBoard(scenario([], 247));
    s = playCard(s, card(247), { x: 8, y: 2 });
    const f = s.creatures.find((c) => c.cardId === 247)!;
    expect(f.range).toBe(2);                             // « PORTEE : 2 »
    expect(f.properties.has("Untargetable")).toBe(true); // « INCIBLABLE »
    expect(f.currentAttack).toBe(3);
    expect(f.currentLife).toBe(3);
  });

  // The shooter is the instance that was really summoned (range set by the card): we
  // move it and wake it up so it plays its end-of-turn advance.
  const shooter = (foeX: number) => {
    const foe = mkCreature(2, "enemy", { x: foeX, y: 2 }, {
      currentAttack: 9, baseAttack: 9, currentLife: 10, baseLife: 10,
      baseMovement: 0, movementLeft: 0,
    });
    const { state, id } = summonThenPlace(
      bareBoard(withDecks(scenario([foe], 247))), 247, { x: 6, y: 2 },
      { hasAttacked: false, movementLeft: 3 },
    );
    return { s: endTurn(state), id };
  };

  it("PORTEE 2 : a distance 2 il tire sans se deplacer ni subir de riposte", () => {
    const { s, id } = shooter(4);
    expect(byId(s, 2)!.currentLife).toBe(7);              // 10 - 3, touche a d=2
    expect(byId(s, id)!.currentLife).toBe(3);             // aucune riposte : c'est un tir
    expect(byId(s, id)!.position).toEqual({ x: 6, y: 2 }); // already in range: it does not move
  });

  it("PORTEE 2 exactement : a distance 3 il doit d'abord se rapprocher pour tirer", () => {
    const { s, id } = shooter(3);
    expect(byId(s, id)!.position).toEqual({ x: 5, y: 2 }); // il avance jusqu'a etre a d=2
    expect(byId(s, 2)!.currentLife).toBe(7);              // puis tire
    expect(byId(s, id)!.currentLife).toBe(3);             // toujours aucune riposte
  });
});

// ---------------------------------------------------------------------------
// #265 Katar, « INITIATIVE / DEBUT DU TOUR : Attire la premiere invocation
// adverse situee devant lui. » (AT 6, PV 3, PM 3)
// ---------------------------------------------------------------------------
describe("#265 Katar - INITIATIVE + DEBUT DU TOUR : attire la premiere invocation adverse devant lui", () => {
  it("invoque depuis la main : il porte INITIATIVE", () => {
    let s = bareBoard(scenario([], 265));
    s = playCard(s, card(265), { x: 8, y: 2 });
    const k = s.creatures.find((c) => c.cardId === 265)!;
    expect(k.properties.has("FirstStrike")).toBe(true); // « INITIATIVE »
    expect(k.currentAttack).toBe(6);
    expect(k.currentLife).toBe(3);
  });

  const katarAt = (x: number, movement = 3) =>
    mkCreature(1, "ally", { x, y: 2 }, {
      cardId: 265, triggers: card(265).triggers ?? [],
      currentAttack: 6, baseAttack: 6, currentLife: 3, baseLife: 3,
      baseMovement: movement, movementLeft: movement,
    });

  const build = () => {
    // On its row, in front of it (lower x for an ally): the first one = the closest
    // (x=2); the second one (x=1) must not move.
    const premiere = mkCreature(2, "enemy", { x: 2, y: 2 }, { currentLife: 9, baseLife: 9, currentAttack: 1, baseAttack: 1 });
    const seconde = mkCreature(3, "enemy", { x: 1, y: 2 }, { currentLife: 9, baseLife: 9, currentAttack: 1, baseAttack: 1 });
    // Autre LIGNE : pas « devant lui ».
    const autreLigne = mkCreature(4, "enemy", { x: 2, y: 0 }, { currentLife: 9, baseLife: 9, currentAttack: 1, baseAttack: 1 });
    // DERRIERE lui (deja passe) : pas « devant lui ».
    const derriere = mkCreature(5, "enemy", { x: 7, y: 2 }, { currentLife: 9, baseLife: 9, currentAttack: 1, baseAttack: 1 });
    const s = bareBoard(scenario([katarAt(6), premiere, seconde, autreLigne, derriere]));
    return runTrigger(s, "DEBUT_DE_TOUR", 1);
  };

  it("la PREMIERE invocation adverse de sa ligne est tiree juste devant lui", () => {
    const s = build();
    expect(byId(s, 2)!.position).toEqual({ x: 5, y: 2 }); // collee devant Katar (x=6)
  });

  it("la seconde invocation de la meme ligne ne bouge pas (« la premiere »)", () => {
    const s = build();
    expect(byId(s, 3)!.position).toEqual({ x: 1, y: 2 });
  });

  it("une invocation adverse d'une AUTRE ligne n'est pas attiree", () => {
    const s = build();
    expect(byId(s, 4)!.position).toEqual({ x: 2, y: 0 });
  });

  it("une invocation adverse DERRIERE lui n'est pas attiree (« devant lui »)", () => {
    const s = build();
    expect(byId(s, 5)!.position).toEqual({ x: 7, y: 2 });
  });

  it("attirer n'inflige aucun degat (le texte ne parle que d'attirer)", () => {
    const s = build();
    expect(byId(s, 2)!.currentLife).toBe(9);
    expect(byId(s, 1)!.currentLife).toBe(3);
  });

  it("« DEBUT DU TOUR » : le declencheur part au debut du tour de SON camp, pas de celui de l'adversaire", () => {
    // Katar and its target do not move (0 PM), so no end-of-turn advance muddles the
    // reading: only the trigger can move them.
    const cible = mkCreature(2, "enemy", { x: 2, y: 2 }, {
      currentLife: 9, baseLife: 9, currentAttack: 1, baseAttack: 1, baseMovement: 0, movementLeft: 0,
    });
    const s0 = bareBoard(withDecks(scenario([katarAt(6, 0), cible])));
    const s1 = endTurn(s0); // start of the enemy turn: Katar is an ally, nothing fires
    expect(s1.activeSide).toBe("enemy");
    expect(byId(s1, 2)!.position).toEqual({ x: 2, y: 2 });
    const s2 = endTurn(s1); // debut du tour ALLIE : le declencheur de Katar part
    expect(s2.activeSide).toBe("ally");
    expect(byId(s2, 2)!.position).toEqual({ x: 5, y: 2 });
  });

  it("aucune invocation adverse devant lui : rien ne se passe, Katar est intact", () => {
    const s = runTrigger(bareBoard(scenario([katarAt(6)])), "DEBUT_DE_TOUR", 1);
    expect(byId(s, 1)!.position).toEqual({ x: 6, y: 2 });
    expect(byId(s, 1)!.currentLife).toBe(3);
    expect(s.pendingAction).toBeNull(); // pas de choix ouvert : l'attirance est automatique
  });
});

// ---------------------------------------------------------------------------
// #277 Abraxane, « APPARITION : Soignez une invocation de 2 PV. » (AT 1, PV 2, PM 3)
// ---------------------------------------------------------------------------
describe("#277 Abraxane - APPARITION : soigne une invocation de 2 PV", () => {
  const build = () => {
    // Allie blesse : 2/5.
    const allieBlesse = mkCreature(60, "ally", { x: 6, y: 2 }, { currentLife: 2, baseLife: 5 });
    // Allie a peine blesse : 4/5 -> le soin de 2 doit s'arreter a 5.
    const allieCoupEpingle = mkCreature(61, "ally", { x: 6, y: 3 }, { currentLife: 4, baseLife: 5 });
    // Wounded enemy: the text does not limit the camp.
    const ennemiBlesse = mkCreature(62, "enemy", { x: 3, y: 2 }, { currentLife: 2, baseLife: 5 });
    let s = bareBoard(scenario([allieBlesse, allieCoupEpingle, ennemiBlesse], 277));
    s = playCard(s, card(277), { x: 8, y: 0 });
    return s;
  };

  it("l'APPARITION ouvre bien un choix d'invocation a soigner", () => {
    const s = build();
    expect(s.pendingAction).not.toBeNull();
    expect(s.pendingAction!.filter).toBe("any_creature");
  });

  it("l'invocation choisie regagne 2 PV", () => {
    const s = resolvePendingAction(build(), { x: 6, y: 2 });
    expect(byId(s, 60)!.currentLife).toBe(4); // 2 + 2
    expect(s.pendingAction).toBeNull();
  });

  it("le soin ne depasse pas les PV de base", () => {
    const s = resolvePendingAction(build(), { x: 6, y: 3 });
    expect(byId(s, 61)!.currentLife).toBe(5); // 4 + 2 plafonne a 5
  });

  it("« une invocation » : une invocation ADVERSE peut aussi etre soignee", () => {
    const s = resolvePendingAction(build(), { x: 3, y: 2 });
    expect(byId(s, 62)!.currentLife).toBe(4); // 2 + 2
  });

  it("une seule invocation est soignee, pas toutes", () => {
    const s = resolvePendingAction(build(), { x: 6, y: 2 });
    expect(byId(s, 61)!.currentLife).toBe(4); // intacte
    expect(byId(s, 62)!.currentLife).toBe(2); // intacte
  });

  it("« une invocation » = une AUTRE : Abraxane n'est pas sur le plateau pendant le choix et ne peut pas se soigner", () => {
    const s = build();
    // The summon is deferred until the pick is resolved: Abraxane is not placed yet, so
    // it is never among its own targets.
    expect(s.creatures.some((c) => c.cardId === 277)).toBe(false);
    const cibles = validPendingTargets(s);
    expect(cibles).toContainEqual({ x: 6, y: 2 });
    expect(cibles).toContainEqual({ x: 3, y: 2 });
    expect(cibles.some((c) => c.x === 8 && c.y === 0)).toBe(false); // sa propre case d'invocation
  });

  it("une fois le soin resolu, Abraxane arrive bien sur la case d'invocation choisie", () => {
    const s = resolvePendingAction(build(), { x: 6, y: 2 });
    const abx = s.creatures.find((c) => c.cardId === 277)!;
    expect(abx.position).toEqual({ x: 8, y: 0 });
    expect(abx.currentLife).toBe(2);   // PV imprimes
    expect(abx.currentAttack).toBe(1); // AT imprimee
  });

  it("aucune autre invocation sur le plateau : pas de blocage, Abraxane est posee sans choix ouvert", () => {
    const s = playCard(bareBoard(scenario([], 277)), card(277), { x: 8, y: 0 });
    expect(s.pendingAction).toBeNull(); // pas de pending sans cible : aucun gel de partie
    expect(s.creatures.some((c) => c.cardId === 277 && c.position.x === 8 && c.position.y === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #235 Qilby (cost 7, AT 6, HP 7) and #275 Qilby (cost 5, AT 4, HP 6):
// « COUP DE GRACE : Remonte l'invocation adverse dans votre main. »
// Same text as #496 (already tested elsewhere), but each card has its own data:
// coverage per card means checking that each one really has its trigger, otherwise
// a card missing its trigger would go unnoticed.
// ---------------------------------------------------------------------------
describe("#235 / #275 Qilby - COUP DE GRACE : remonte l'invocation adverse dans votre main", () => {
  // #6 is the victim's card: "votre main" = the killer's hand, not the discard of the
  // victim's owner.
  const trade = (cardId: number, atk: number, life: number, victimAttack: number) => {
    const qilby = mkCreature(1, "ally", { x: 5, y: 2 }, {
      cardId, triggers: card(cardId).triggers ?? [],
      currentAttack: atk, baseAttack: atk, currentLife: life, baseLife: life,
      movementLeft: 3, baseMovement: 3, hasAttacked: false,
    });
    const victime = mkCreature(2, "enemy", { x: 4, y: 2 }, {
      cardId: 6, currentAttack: victimAttack, baseAttack: victimAttack, currentLife: 2, baseLife: 5,
    });
    const base = scenario([qilby, victime]);
    return endTurn(bareBoard(withDecks({
      ...base,
      players: {
        ...base.players,
        ally: { ...base.players.ally, hand: [], handCostMods: [] },
        enemy: { ...base.players.enemy, discard: [] },
      },
    })));
  };

  it("#235 (cout 7) : tuer au corps a corps envoie la carte de la victime dans SA main", () => {
    const s = trade(235, 6, 7, 1); // 6 AT sur 2 PV : la victime meurt, Qilby survit
    expect(byId(s, 2)).toBeUndefined();
    expect(s.players.ally.hand).toContain(6);
    expect(s.players.enemy.discard).not.toContain(6);
  });

  it("#235 : pas de rebond si Qilby ne survit pas a l'echange", () => {
    const s = trade(235, 6, 2, 5); // 2 PV contre 5 AT : les deux meurent
    expect(byId(s, 1)).toBeUndefined();
    expect(s.players.ally.hand).not.toContain(6);
    expect(s.players.enemy.discard).toContain(6); // defausse normale de son proprietaire
  });

  it("#275 (cout 5) : meme COUP DE GRACE, avec ses propres stats", () => {
    const s = trade(275, 4, 6, 1);
    expect(byId(s, 2)).toBeUndefined();
    expect(s.players.ally.hand).toContain(6);
    expect(s.players.enemy.discard).not.toContain(6);
  });

  it("#275 : pas de rebond si Qilby ne survit pas a l'echange", () => {
    const s = trade(275, 4, 2, 5);
    expect(byId(s, 1)).toBeUndefined();
    expect(s.players.ally.hand).not.toContain(6);
    expect(s.players.enemy.discard).toContain(6);
  });
});

// ---------------------------------------------------------------------------
// #240 Buisson: « Vous pouvez invoquer un allie sur un buisson. »
// A token card that describes the bush object (SetPropertyData ActAsSpawnPoint): it
// is never played from the hand, the bush comes from #214 / #108. The full chain
// seed -> bush -> summon on it was not covered anywhere from end to end, so it is
// locked here.
// ---------------------------------------------------------------------------
describe("#240 Buisson - vous pouvez invoquer un allie sur un buisson", () => {
  // #214 « Transforme une Graine alliee en Buisson. »; #481 La Folle, cost 2, the
  // creature placed on the bush.
  const seeded = () => {
    const base = bareBoard(scenario([], 214, 481));
    return { ...base, seeds: [{ position: { x: 6, y: 2 }, owner: "ally" as const }] };
  };

  it("une graine alliee transformee en buisson devient une case d'invocation hors zone de depart", () => {
    const s0 = seeded();
    expect(canPlayCard(s0, card(214), { x: 6, y: 2 })).toBeNull();
    const s1 = playCard(s0, card(214), { x: 6, y: 2 });
    expect((s1.bushes ?? []).some((b) => b.owner === "ally" && b.position.x === 6 && b.position.y === 2)).toBe(true);
    // x=6 is outside the summon column (x=8): the bush is what makes it playable.
    expect(validSpawnCells(s1, "ally").some((c) => c.x === 6 && c.y === 2)).toBe(true);
    expect(canPlayCard(s1, card(481), { x: 6, y: 2 })).toBeNull();
  });

  it("l'invocation posee dessus arrive bien sur la case, et le buisson est consomme", () => {
    const s1 = playCard(seeded(), card(214), { x: 6, y: 2 });
    const s2 = playCard(s1, card(481), { x: 6, y: 2 });
    expect(s2.creatures.some((c) => c.cardId === 481 && c.position.x === 6 && c.position.y === 2)).toBe(true);
    expect(s2.bushes ?? []).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// #266 PIEGE test: not tested, on purpose.
// The card has no text (empty description), so there is nothing to derive an
// assertion from, and writing a test would mean making up a rule. Raw data:
// isToken true, isDevCard false, cardType Aoe, castTarget EmptyCell, model
// "piege_test", figurine null, effects [DamageData 2], triggers []. Despite its name
// it has no PlaceTrap effect: played, it would not set a trap, it would deal 2
// damage on an empty cell (so to nobody). #266 is not mentioned in rules.ts or
// effects.ts.
// Open question: is #266 PIEGE test a leftover dev card to remove from the pool, or
// a real trap card? If it is real, what is its official text (who places the trap,
// on which cell, who takes the 2 damage and when)?
// ---------------------------------------------------------------------------
