// Sanity rules: damaging an allied Dofus is almost never right (apart from rare
// combos, Julith / Héros Martyr, which have to outweigh a penalty, not nothing).
// These tests lock the heuristic signal that (a) charges for chip damage on your
// own fake and (b) ranks a Fléau on yourself below the same Fléau aimed at the
// enemy, so the root tie-break steers near-equal searches away from it.
import { describe, it, expect } from "vitest";
import { scenario, cards, mkCreature, card } from "../engine/testkit";
import { evaluate } from "./eval";
import { oneStepHeuristicScore } from "./agents/MctsAgent";
import { applyAction, declineCell } from "./actions";
import { vetoByHeuristic, blindFoeDofuses } from "./agents/DeterminizedMctsAgent";
import { resampleEnemyReals } from "./determinize";
import { Rng } from "../engine/rng";

const FLEAU = 757; // "Fléau": deals damage to a Dofus (3 AP)

describe("règle : ne pas abîmer ses propres Dofus", () => {
  it("grignoter son PROPRE faux Dofus fait baisser le score", () => {
    const s = scenario([]);
    const fake = s.dofuses.find((d) => d.owner === "ally" && d.kind === "fake")!;
    const chipped = { ...s, dofuses: s.dofuses.map((d) => (d === fake ? { ...d, currentLife: d.currentLife - 1 } : d)) };
    expect(evaluate(chipped, "ally")).toBeLessThan(evaluate(s, "ally"));
  });

  it("pick de Glaie : BOOSTER le Scarafon score mieux que refuser (cas réel seed 31000001 T3)", () => {
    cards();
    // Scarafon 8 cells from the enemy wall: PM3 = 3 turns, PM4 = 2 turns. The AI in the
    // campaign refused this free +1 PM (the net did not care either way, so it was a
    // coin flip). The heuristic tie-break has to prefer the target over the refusal.
    const GLAIE = 126, SCARAFON = 533;
    const scara = mkCreature(1, "ally", { x: 8, y: 4 }, { cardId: SCARAFON, currentAttack: 2, currentLife: 2, baseMovement: 3 });
    const s = scenario([scara], GLAIE);
    const afterPlay = applyAction(s, { kind: "play", cardId: GLAIE, target: { x: 8, y: 2 } });
    expect(afterPlay.pendingAction).toBeTruthy();
    const boost = oneStepHeuristicScore(afterPlay, { kind: "resolve", target: { x: 8, y: 4 } }, "ally");
    const decline = oneStepHeuristicScore(afterPlay, { kind: "resolve", target: declineCell(afterPlay)! }, "ally");
    expect(boost).toBeGreaterThan(decline);
  });

  it("règle 3 : passer avec des PA + une carte jouable score moins bien que la jouer", () => {
    cards();
    const SCARAFON = 533; // invocation à 1 PA (fait piocher à l'apparition)
    const base = scenario([], SCARAFON); // 10 AP in hand
    // Non-empty decks on both sides: otherwise every draw triggers FATIGUE (drawing
    // from an empty deck damages your own Dofus) and skews the comparison.
    const s = {
      ...base,
      players: {
        ...base.players,
        ally: { ...base.players.ally, deck: [16, 16, 16, 16] },
        enemy: { ...base.players.enemy, deck: [16, 16, 16, 16] },
      },
    };
    const pass = oneStepHeuristicScore(s, { kind: "endTurn" }, "ally");
    const play = oneStepHeuristicScore(s, { kind: "play", cardId: SCARAFON, target: { x: 8, y: 2 } }, "ally");
    expect(play).toBeGreaterThan(pass);
  });

  it("règle 3 : encaisser la réserve puis passer est pire que passer réserve intacte", () => {
    cards();
    const base = scenario([]);
    // no playable card: the only question is what to do with the reserve
    const s = { ...base, players: { ...base.players, ally: { ...base.players.ally, hand: [], handCostMods: [], ap: 0, apReserve: 3 } } };
    const pass = oneStepHeuristicScore(s, { kind: "endTurn" }, "ally");
    const cashPass = oneStepHeuristicScore(s, { kind: "reserve" }, "ally");
    expect(pass).toBeGreaterThan(cashPass);
  });

  it("règle 4 : Tronknyde (pur corps) se pose sans regret même sans autre plan", () => {
    cards();
    const TRONKNYDE = 280;
    const base = scenario([], TRONKNYDE);
    const s = { ...base, players: { ...base.players, ally: { ...base.players.ally, deck: [16, 16] }, enemy: { ...base.players.enemy, deck: [16, 16] } } };
    const pass = oneStepHeuristicScore(s, { kind: "endTurn" }, "ally");
    const play = oneStepHeuristicScore(s, { kind: "play", cardId: TRONKNYDE, target: { x: 8, y: 2 } }, "ally");
    expect(play).toBeGreaterThan(pass);
  });

  it("règle 4 : Chuchoteurs (carte a effet CHEF) se GARDE quand l'aura ne touche personne...", () => {
    cards();
    const CHUCHOTEURS = 555;
    const base = scenario([], CHUCHOTEURS); // plateau vide: l'aura ne boosterait personne
    const s = { ...base, players: { ...base.players, ally: { ...base.players.ally, deck: [16, 16] }, enemy: { ...base.players.enemy, deck: [16, 16] } } };
    const pass = oneStepHeuristicScore(s, { kind: "endTurn" }, "ally");
    const play = oneStepHeuristicScore(s, { kind: "play", cardId: CHUCHOTEURS, target: { x: 8, y: 2 } }, "ally");
    expect(pass).toBeGreaterThan(play);
  });

  it("... mais se POSE quand l'aura touche plusieurs allies (le bon moment)", () => {
    cards();
    const CHUCHOTEURS = 555, TRONKNYDE = 280;
    const allies = [1, 2, 3].map((k) => mkCreature(k, "ally", { x: 7, y: k }, { cardId: TRONKNYDE, currentAttack: 3, currentLife: 3, baseMovement: 2 }));
    const base = scenario(allies, CHUCHOTEURS);
    const s = { ...base, players: { ...base.players, ally: { ...base.players.ally, deck: [16, 16] }, enemy: { ...base.players.enemy, deck: [16, 16] } } };
    const pass = oneStepHeuristicScore(s, { kind: "endTurn" }, "ally");
    const play = oneStepHeuristicScore(s, { kind: "play", cardId: CHUCHOTEURS, target: { x: 8, y: 2 } }, "ally");
    expect(play).toBeGreaterThan(pass);
  });

  it("règle 5 : deux menaces REPARTIES sur deux lignes valent mieux qu'empilées sur une", () => {
    const stats = { currentAttack: 4, currentLife: 4, baseMovement: 3 };
    const stacked = scenario([
      mkCreature(1, "ally", { x: 5, y: 2 }, stats),
      mkCreature(2, "ally", { x: 6, y: 2 }, stats),
    ]);
    const spread = scenario([
      mkCreature(1, "ally", { x: 5, y: 2 }, stats),
      mkCreature(2, "ally", { x: 6, y: 0 }, stats),
    ]);
    expect(evaluate(spread, "ally")).toBeGreaterThan(evaluate(stacked, "ally"));
  });

  it("Fléau sur un Dofus ENNEMI score mieux que Fléau sur son PROPRE Dofus", () => {
    cards(); // registre de cartes requis pour rejouer l'action
    const s = scenario([], FLEAU);
    const own = s.dofuses.find((d) => d.owner === "ally")!;
    const foe = s.dofuses.find((d) => d.owner === "enemy")!;
    const selfHit = oneStepHeuristicScore(s, { kind: "play", cardId: FLEAU, target: own.position }, "ally");
    const foeHit = oneStepHeuristicScore(s, { kind: "play", cardId: FLEAU, target: foe.position }, "ally");
    expect(foeHit).toBeGreaterThan(selfHit);
  });
});

// Rule 6 (found by going through a real game against "forte"): a spell has no body,
// its whole value is its effect. The "spend your AP" rule was paying the AI to burn
// its spells for nothing (Heure de Gloire with 1 AP left for +1/+1, a boost on a
// creature that breaks through at the end of the turn and goes back to the deck
// with the boost). The spellFizzle penalty balances that: only a real eval gain
// after the end of turn (a kill, a big lasting boost, a breakthrough made possible)
// pays the card back.
describe("règle 6 : ne pas brûler les sorts pour rien", () => {
  const HEURE_DE_GLOIRE = 296; // 0 PA, "dépense vos PA restants : +1 AT/+1 AR par PA"

  it("Heure de Gloire à 1 PA restant (+1/+1 marginal) : GARDER la carte bat la brûler", () => {
    cards();
    const stayer = mkCreature(1, "ally", { x: 5, y: 2 }); // avance mais reste en jeu
    const base = scenario([stayer], HEURE_DE_GLOIRE);
    const s = { ...base, players: { ...base.players, ally: { ...base.players.ally, ap: 1 } } };
    const burn = oneStepHeuristicScore(s, { kind: "play", cardId: HEURE_DE_GLOIRE, target: { x: 5, y: 2 } }, "ally");
    const hold = oneStepHeuristicScore(s, { kind: "endTurn" }, "ally");
    expect(hold).toBeGreaterThan(burn);
  });

  it("Heure de Gloire à 10 PA (+10/+10 durable) : la jouer bat passer", () => {
    cards();
    const stayer = mkCreature(1, "ally", { x: 5, y: 2 });
    const s = scenario([stayer], HEURE_DE_GLOIRE); // 10 PA par défaut
    const play = oneStepHeuristicScore(s, { kind: "play", cardId: HEURE_DE_GLOIRE, target: { x: 5, y: 2 } }, "ally");
    const pass = oneStepHeuristicScore(s, { kind: "endTurn" }, "ally");
    expect(play).toBeGreaterThan(pass);
  });

  it("boost sur une créature qui PERCE en fin de tour < boost sur une créature qui reste", () => {
    cards();
    // At (1,3): atk 2, PM 2, enemy Dofus (0,3) at 1 HP. At the end-of-turn advance it
    // breaks the Dofus, breaks through, and goes back to the deck with the boost.
    const capturer = mkCreature(1, "ally", { x: 1, y: 3 }, { movementLeft: 2 });
    const stayer = mkCreature(2, "ally", { x: 5, y: 1 }, { movementLeft: 2 });
    const base = scenario([capturer, stayer], HEURE_DE_GLOIRE);
    const s = {
      ...base,
      dofuses: base.dofuses.map((d) =>
        d.owner === "enemy" && d.position.y === 3 ? { ...d, currentLife: 1 } : d),
    };
    // The Heure de Gloire pick is tied to the cast cell (the play directly targets the
    // creature to buff), so the comparison is done on the play. Same spell penalty on
    // both sides: only what happens to the boost after the end of turn makes the
    // difference (gone with the breakthrough, or kept).
    const onCapturer = oneStepHeuristicScore(s, { kind: "play", cardId: HEURE_DE_GLOIRE, target: { x: 1, y: 3 } }, "ally");
    const onStayer = oneStepHeuristicScore(s, { kind: "play", cardId: HEURE_DE_GLOIRE, target: { x: 5, y: 1 } }, "ally");
    expect(onStayer).toBeGreaterThan(onCapturer);
  });
});

// Root veto: the 85% visit tie-break only decides near-ties, so when the value net
// strongly preferred a line that clearly does nothing (Charge #427 cast on the enemy
// creature with no good fight at all: heuristic gap ~200), it still got through.
// vetoByHeuristic removes from the vote every action more than rootVeto (100)
// points below the best root heuristic score.
describe("veto racine : le réseau ne vote plus sur les coups prouvablement nuls", () => {
  it("Charge sur la créature adverse (aucun bénéfice) est vetoée malgré ses visites", () => {
    cards();
    const CHARGE = 427;
    const foe = mkCreature(1, "enemy", { x: 5, y: 2 }, { movementLeft: 2 });
    const base = scenario([foe], CHARGE);
    const s = {
      ...base,
      aoeObjects: [],
      players: {
        ...base.players,
        ally: { ...base.players.ally, ap: 2, deck: [16, 16, 16, 16] },
        enemy: { ...base.players.enemy, deck: [16, 16, 16, 16] },
      },
    };
    // The (simulated) net loves the mistake: 90 visits for the enemy Charge, 10 for passing.
    const stats = [
      { action: { kind: "play", cardId: CHARGE, target: { x: 5, y: 2 } } as const, visits: 90, q: 0.4 },
      { action: { kind: "endTurn" } as const, visits: 10, q: 0.1 },
    ];
    const kept = vetoByHeuristic(s, stats);
    expect(kept.map((k) => k.action.kind)).toEqual(["endTurn"]);
  });

  it("ne veto jamais tout : des actions proches restent toutes votables", () => {
    cards();
    const s = scenario([mkCreature(1, "ally", { x: 5, y: 2 })]);
    const stats = [
      { action: { kind: "endTurn" } as const, visits: 50, q: 0 },
      { action: { kind: "reserve" } as const, visits: 50, q: 0 },
    ];
    const kept = vetoByHeuristic(s, stats);
    expect(kept.length).toBeGreaterThan(0);
  });
});

// Rule 7: the value of Glaie (+1 PM on APPARITION) is a surprise tempo tool. You keep
// it until the boost lets a creature reach the Dofus one turn earlier (a PM3
// creature 4 cells away: the opponent bets you have no boost, you play it, surprise).
// Played alone (the pick can only target itself), the card wastes its effect share,
// so the waste is floored at half its AP value. The right moment is already rewarded
// by the imminence term of the eval (the ceil(dist/PM) threshold is crossed).
describe("règle 7 : les invocations à pick se gardent quand le pick n'a pas de cible externe", () => {
  const GLAIE = 126;
  const fill = (s: ReturnType<typeof scenario>) => ({
    ...s,
    aoeObjects: [],
    players: {
      ...s.players,
      ally: { ...s.players.ally, deck: [16, 16, 16, 16] },
      enemy: { ...s.players.enemy, deck: [16, 16, 16, 16] },
    },
  });

  it("Glaie posée SEULE tour 2 (pick sur elle-même uniquement) : passer vaut mieux", () => {
    cards();
    const base = fill(scenario([], GLAIE));
    const s = { ...base, turn: 2, players: { ...base.players, ally: { ...base.players.ally, ap: 2, maxAp: 2 } } };
    const play = oneStepHeuristicScore(s, { kind: "play", cardId: GLAIE, target: { x: 8, y: 2 } }, "ally");
    const pass = oneStepHeuristicScore(s, { kind: "endTurn" }, "ally");
    expect(pass).toBeGreaterThan(play);
  });

  it("le moment de SURPRISE (créature PM3 à 4 cases, boost -> Dofus un tour plus tôt) : jouer Glaie gagne", () => {
    cards();
    // Créature 4 AT PM3 à 4 cases du mur : ceil(4/3)=2 tours ; +1 PM -> 1 tour.
    const runner = mkCreature(1, "ally", { x: 4, y: 3 }, { currentAttack: 4, baseAttack: 4, baseMovement: 3, movementLeft: 3 });
    const base = fill(scenario([runner], GLAIE));
    const s = { ...base, players: { ...base.players, ally: { ...base.players.ally, ap: 2 } } };
    const play = oneStepHeuristicScore(s, { kind: "play", cardId: GLAIE, target: { x: 8, y: 3 } }, "ally");
    const pass = oneStepHeuristicScore(s, { kind: "endTurn" }, "ally");
    expect(play).toBeGreaterThan(pass);
  });
});

// Rule 8: look one more turn ahead. The AI boosted (Glaie) a creature that the
// existing enemy board was going to kill next turn anyway: it moved 4 cells instead
// of 3 and died the same way, a wasted resource. At the root horizon, after my end
// of turn, the opponent passes and its end of turn is played out (advances and
// fights of the creatures already on the board, deterministic), so a boost on a
// doomed creature is worth zero. Cards the opponent might play are still the
// search's job.
describe("règle 8 : ne pas booster une créature condamnée par le plateau existant", () => {
  const GLAIE = 126;
  it("pick de Glaie : cible SÛRE > cible que l'ennemi tue à sa fin de tour (horizon profond)", () => {
    cards();
    // doomed 2/2 at (4,0): an enemy killer with 6 AT / 6 HP at (2,0) and PM2 crushes it
    // during the enemy end-of-turn advance. safe 2/2 at (6,4), empty lane.
    const doomed = mkCreature(1, "ally", { x: 4, y: 0 }, { movementLeft: 0, baseMovement: 0 });
    const killer = mkCreature(2, "enemy", { x: 2, y: 0 }, { currentAttack: 6, baseAttack: 6, currentLife: 6, baseLife: 6, baseMovement: 2, movementLeft: 2 });
    const safe = mkCreature(3, "ally", { x: 6, y: 4 }, { movementLeft: 0, baseMovement: 0 });
    const base = scenario([doomed, killer, safe], GLAIE);
    const s = {
      ...base,
      aoeObjects: [],
      players: {
        ...base.players,
        ally: { ...base.players.ally, ap: 2, deck: [16, 16, 16, 16] },
        enemy: { ...base.players.enemy, deck: [16, 16, 16, 16] },
      },
    };
    // Glaie is placed on a spawn cell; the apparition pick chooses who gets the +1 PM,
    // so the bad decision is the resolve.
    const afterPlay = applyAction(s, { kind: "play", cardId: GLAIE, target: { x: 8, y: 2 } });
    expect(afterPlay.pendingAction).toBeTruthy();
    const onDoomed = oneStepHeuristicScore(afterPlay, { kind: "resolve", target: { x: 4, y: 0 } }, "ally", true);
    const onSafe = oneStepHeuristicScore(afterPlay, { kind: "resolve", target: { x: 6, y: 4 } }, "ally", true);
    expect(onSafe).toBeGreaterThan(onDoomed);
  });
});

// Rule 3, stricter (real game: the AI cashed its reserve and then passed, a total
// waste that got under the veto since the ~22/AP gap is below 100). Cashing is only
// worth it if it unlocks a play this turn; otherwise a flat penalty (pointlessCash)
// sized to trigger the root veto.
describe("règle 3 affûtée : encaisser la réserve sans rien débloquer est vetoé", () => {
  it("réserve encaissée avec main vide : l'écart au pass dépasse la marge du veto", () => {
    cards();
    const base = scenario([]);
    const s = { ...base, players: { ...base.players, ally: { ...base.players.ally, hand: [], handCostMods: [], ap: 4, apReserve: 3 } } };
    const cash = oneStepHeuristicScore(s, { kind: "reserve" }, "ally", true);
    const pass = oneStepHeuristicScore(s, { kind: "endTurn" }, "ally", true);
    expect(pass - cash).toBeGreaterThan(100); // > rootVeto -> le veto l'exclut du vote
  });

  it("encaisser qui DÉBLOQUE une carte (coût = PA+réserve) n'est PAS sur-puni", () => {
    cards();
    const JUSTICE = 130; // invocation 5 PA
    const base = scenario([], JUSTICE);
    // 3 PA en main + 2 en réserve : Justice (5) injouable sans encaisser.
    const s = { ...base, players: { ...base.players, ally: { ...base.players.ally, ap: 3, apReserve: 2, deck: [16, 16] }, enemy: { ...base.players.enemy, deck: [16, 16] } } };
    const cash = oneStepHeuristicScore(s, { kind: "reserve" }, "ally", true);
    const pass = oneStepHeuristicScore(s, { kind: "endTurn" }, "ally", true);
    expect(pass - cash).toBeLessThan(100); // pas de malus forfaitaire -> reste votable
  });

  // Plan mode (rule 10) is the one of the veto and of the root tie-break. A bug found in a
  // real game: the "unlocks a card" test was evaluated on the end of the planned turn, so
  // it was inverted (cashing without playing anything passed, cashing to play was punished).
  it("plan mode: cashing with an empty hand is still vetoed", () => {
    cards();
    const base = scenario([]);
    const s = { ...base, players: { ...base.players, ally: { ...base.players.ally, hand: [], handCostMods: [], ap: 1, apReserve: 1 } } };
    const cash = oneStepHeuristicScore(s, { kind: "reserve" }, "ally", true, true);
    const pass = oneStepHeuristicScore(s, { kind: "endTurn" }, "ally", true, true);
    expect(pass - cash).toBeGreaterThan(100);
  });

  it("plan mode: cashing to play Dragon Cochon (5 AP) is not punished", () => {
    cards();
    // A creature with no effect (rule 4 does not apply): the plan plays it after cashing.
    // Justice does not fit here: the rules prefer to keep it (effect share), and cashing to
    // keep it is exactly the waste this targets.
    const DRAGON_COCHON = 449;
    const base = scenario([], DRAGON_COCHON);
    const s = { ...base, players: { ...base.players, ally: { ...base.players.ally, ap: 3, apReserve: 2, deck: [16, 16] }, enemy: { ...base.players.enemy, deck: [16, 16] } } };
    const cash = oneStepHeuristicScore(s, { kind: "reserve" }, "ally", true, true);
    const pass = oneStepHeuristicScore(s, { kind: "endTurn" }, "ally", true, true);
    expect(pass - cash).toBeLessThan(100);
  });
});

// Rule 9: Autorité #486 (8 AP, "charge jusqu'au Dofus adverse") cast on the player's
// creature right next to the AI's Dofus, paying to speed up the loss of its own
// Dofus. Horizon effect: the "pass" line carries the looming threat (-582), while the
// Autorité line has already counted the loss (-140), so the heuristic preferred
// getting it over with. Counterfactual guard: any action that leaves my Dofus worse
// than doing nothing pays the difference (dofusAccel).
describe("règle 9 : ne jamais accélérer la perte de ses propres Dofus", () => {
  it("Autorité sur la créature adverse collée à MON Dofus : condamnée et vetoée", () => {
    cards();
    const AUTORITE = 486;
    const yours = mkCreature(1, "enemy", { x: 8, y: 2 }, { currentAttack: 3, baseAttack: 3, currentLife: 4, baseLife: 4, baseMovement: 2, movementLeft: 2 });
    const base = scenario([yours], AUTORITE);
    const s = {
      ...base,
      aoeObjects: [],
      players: {
        ...base.players,
        ally: { ...base.players.ally, ap: 8, deck: [16, 16, 16, 16] },
        enemy: { ...base.players.enemy, deck: [16, 16, 16, 16] },
      },
    };
    const play = oneStepHeuristicScore(s, { kind: "play", cardId: AUTORITE, target: { x: 8, y: 2 } }, "ally", true);
    const pass = oneStepHeuristicScore(s, { kind: "endTurn" }, "ally", true);
    expect(pass - play).toBeGreaterThan(100); // beyond the margin, so the veto removes it
    const stats = [
      { action: { kind: "play" as const, cardId: AUTORITE, target: { x: 8, y: 2 } }, visits: 90, q: 0.3 },
      { action: { kind: "endTurn" as const }, visits: 10, q: 0 },
    ];
    expect(vetoByHeuristic(s, stats).map((k) => k.action.kind)).toEqual(["endTurn"]);
  });
});

// Rule 10: order of plays in the turn. The AI played Sono Sino (4/4, APPARITION +1 AR
// if another Iop) before two Gzenah (+1 AT/+1 AR each time an allied Iop enters);
// the other order gives +2 AT/+3 AR more (Sono enters last, triggers both Gzenah
// and gets its armour). Cause: scoring each card as if the turn stopped there
// favours the big card first. Fix: complete the turn greedily before scoring (plan
// mode).
describe("règle 10 : l'ordre des poses est jugé sur le tour complet", () => {
  it("commencer par Gzenah bat commencer par Sono Sino (8 PA, main Sono+Gz+Gz)", () => {
    cards();
    const SONO = 321, GZ = 421;
    const base = scenario([], SONO, GZ, GZ);
    const s = {
      ...base,
      aoeObjects: [],
      players: {
        ...base.players,
        ally: { ...base.players.ally, ap: 8, deck: [16, 16, 16, 16] },
        enemy: { ...base.players.enemy, deck: [16, 16, 16, 16] },
      },
    };
    const startGz = oneStepHeuristicScore(s, { kind: "play", cardId: GZ, target: { x: 8, y: 1 } }, "ally", true, true);
    const startSono = oneStepHeuristicScore(s, { kind: "play", cardId: SONO, target: { x: 8, y: 0 } }, "ally", true, true);
    expect(startGz).toBeGreaterThan(startSono);
  });
});

// Information fairness: the AI must never see the true kind of the enemy Dofus.
// Leak measured before the fix: +999,700 for breaking the hidden real one rather
// than the hidden fake one (the simulated win term went through the horizon of the
// veto/tie-break). Fix: the root layer scores on a blinded state (enemy kinds
// re-drawn, with a seed per decision).
describe("info-fairness : la nature des Dofus adverses ne fuit pas", () => {
  const FLEAU = 757;
  // Same base (scenario() draws a seed on each call, a known trap); only the hidden
  // truths differ between the two variants.
  const base0 = scenario([], FLEAU);
  const mk = (realY: number, fakeY: number) => {
    return {
      ...base0,
      aoeObjects: [],
      dofuses: base0.dofuses.map((d) => {
        if (d.owner !== "enemy") return d;
        if (d.position.y === realY) return { ...d, kind: "real" as const, currentLife: 1 };
        if (d.position.y === fakeY) return { ...d, kind: "fake" as const, currentLife: 1 };
        return d;
      }),
      players: { ...base0.players, ally: { ...base0.players.ally, ap: 3, deck: [16, 16] }, enemy: { ...base0.players.enemy, deck: [16, 16] } },
    };
  };

  it("l'état aveuglé est IDENTIQUE quel que soit l'emplacement réel du vrai caché", () => {
    cards();
    const a = blindFoeDofuses(mk(1, 3)); // vrai en y=1
    const b = blindFoeDofuses(mk(3, 1)); // vrai en y=3 (info cachée inversée)
    expect(a.dofuses.map((d) => `${d.owner}${d.position.y}${d.kind}`)).toEqual(
      b.dofuses.map((d) => `${d.owner}${d.position.y}${d.kind}`));
  });

  it("sur l'état aveuglé, sniper le vrai caché ne score pas mieux que le faux caché", () => {
    cards();
    const blind = blindFoeDofuses(mk(1, 3));
    const hit1 = oneStepHeuristicScore(blind, { kind: "play", cardId: FLEAU, target: { x: 0, y: 1 } }, "ally", true, true);
    const hit3 = oneStepHeuristicScore(blind, { kind: "play", cardId: FLEAU, target: { x: 0, y: 3 } }, "ally", true, true);
    // the two hidden targets at 1 HP have the same epistemic status: any gap can only
    // come from the sampled world, never from the truth, so swapping the truth does not
    // move the scores.
    const blindSwapped = blindFoeDofuses(mk(3, 1));
    const hit1b = oneStepHeuristicScore(blindSwapped, { kind: "play", cardId: FLEAU, target: { x: 0, y: 1 } }, "ally", true, true);
    const hit3b = oneStepHeuristicScore(blindSwapped, { kind: "play", cardId: FLEAU, target: { x: 0, y: 3 } }, "ally", true, true);
    expect(hit1).toBe(hit1b);
    expect(hit3).toBe(hit3b);
  });

  it("resampleEnemyReals compte les vrais déjà révélés via les pierres tombales", () => {
    cards();
    const s = scenario([]);
    const rng = new Rng(7);
    const tombs = [{ owner: "enemy" as const, kind: "real" as const }];
    const out = s.dofuses.filter((d) => d.owner === "enemy").length
      ? resampleEnemyReals(s.dofuses, "enemy", rng, tombs)
      : [];
    const reals = out.filter((d) => d.owner === "enemy" && d.currentLife > 0 && d.kind === "real").length;
    expect(reals).toBe(2); // 3 - 1 révélé
  });
});

// Rule 11 (the Robin could have been killed with an orb, and a very strong spell,
// the Flèche Destructrice, was used instead): the capped spell penalty is flat from
// 2 AP on, so two spells that do the same thing paid the same. The linear
// spellCostPremium bonus decides: with the same effect, the cheapest removal wins.
describe("règle 11 : le removal le moins cher suffisant d'abord", () => {
  it("tuer Robin des Landes (1 PV) : Flèche Perçante (2 PA) score mieux que Flèche Destructrice (5 PA)", () => {
    cards();
    const PERCANTE = 294, DESTRUCTRICE = 253, ROBIN = 528;
    const robin = mkCreature(9, "enemy", { x: 4, y: 2 }, { cardId: ROBIN, currentAttack: 2, currentLife: 1, baseMovement: 2 });
    const base = scenario([robin], PERCANTE);
    const s = {
      ...base,
      players: {
        ...base.players,
        ally: { ...base.players.ally, hand: [PERCANTE, DESTRUCTRICE], handCostMods: [0, 0], deck: [16, 16] },
        enemy: { ...base.players.enemy, deck: [16, 16] },
      },
    };
    const cheap = oneStepHeuristicScore(s, { kind: "play", cardId: PERCANTE, target: { x: 4, y: 2 } }, "ally");
    const dear = oneStepHeuristicScore(s, { kind: "play", cardId: DESTRUCTRICE, target: { x: 4, y: 2 } }, "ally");
    expect(cheap).toBeGreaterThan(dear);
  });
});

// Rule 12 (an éclaireur placed in front of an enemy on a row whose dofus is already
// destroyed; no point placing the flécheur in front of the Alibert since there is no
// dofus behind to protect): a creature cannot leave its row, so if the target Dofus
// of its row is destroyed, reaching the wall breaks through for nothing. Its capture
// threat is zero, and blocking an enemy attacker on a row where my Dofus has already
// fallen protects nothing.
describe("règle 12 : une voie dont le Dofus cible est détruit ne porte plus de menace", () => {
  // A single call to scenario() (each call draws a random seed); the variants are
  // derived from the same base state.
  const mkVariants = (owner: "ally" | "enemy") => {
    const atk = mkCreature(1, owner, { x: 4, y: 2 }, { currentAttack: 4, currentLife: 3, baseMovement: 2 });
    const base = scenario([atk]);
    const targetSide = owner === "ally" ? "enemy" : "ally";
    const killed = base.dofuses.find((d) => d.owner === targetSide && d.position.y === 2)!;
    const deadLane = {
      ...base,
      dofuses: base.dofuses.filter((d) => d !== killed),
      destroyedDofuses: [...(base.destroyedDofuses ?? []), { position: { ...killed.position }, owner: killed.owner, kind: killed.kind }],
    };
    return { base, deadLane };
  };

  it("le même attaquant ALLIÉ apporte moins d'éval sur une rangée au Dofus adverse détruit", () => {
    const { base, deadLane } = mkVariants("ally");
    const deltaAlive = evaluate(base, "ally") - evaluate({ ...base, creatures: [] }, "ally");
    const deltaDead = evaluate(deadLane, "ally") - evaluate({ ...deadLane, creatures: [] }, "ally");
    expect(deltaAlive).toBeGreaterThan(deltaDead);
  });

  it("un attaquant ENNEMI ne menace plus rien sur une rangée où MON Dofus est déjà tombé", () => {
    const { base, deadLane } = mkVariants("enemy");
    // from my side: its presence costs me less when my lane is already dead
    const costAlive = evaluate({ ...base, creatures: [] }, "ally") - evaluate(base, "ally");
    const costDead = evaluate({ ...deadLane, creatures: [] }, "ally") - evaluate(deadLane, "ally");
    expect(costAlive).toBeGreaterThan(costDead);
  });
});

// Rule 13 (passing with 3 AP when a Fléau could have been thrown somewhere): the
// spell penalty used to apply to the whole effect, even when fully realized. The 2
// permanent damage of a Fléau (~150 eval) never paid back the 176 penalty, so
// passing always beat chip damage. The penalty now applies to the share that is not
// realized as Dofus progress; speculative spells (buffs) keep their full penalty
// (the rule 6 tests already lock that).
describe("règle 13 : un Fléau qui grignote un Dofus bat la passe à PA perdus", () => {
  it("avec 3 PA et un Fléau en main, jeter le Fléau sur un Dofus ennemi score mieux que passer", () => {
    cards();
    const base = scenario([], FLEAU);
    const s = {
      ...base,
      players: {
        ...base.players,
        ally: { ...base.players.ally, ap: 3, deck: [16, 16] },
        enemy: { ...base.players.enemy, deck: [16, 16] },
      },
    };
    // A real Dofus: the chip damage realizes ~240 eval (2 damage x 120); on a fake the
    // realization is ~zero and the penalty stays full (on purpose)
    const foe = s.dofuses.find((d) => d.owner === "enemy" && d.kind === "real")!;
    const pass = oneStepHeuristicScore(s, { kind: "endTurn" }, "ally");
    const chip = oneStepHeuristicScore(s, { kind: "play", cardId: FLEAU, target: foe.position }, "ally");
    expect(chip).toBeGreaterThan(pass);
  });
});

// Rule 14 (Hugo should be played in front of a Scarafon): a creature with CONTRE COUP
// wants a creature in front of it. Each hit it takes fires its effect, and against an
// attacker weaker than its HP it takes several (Yugo with 3 HP against a 2 ATK
// Scarafon = 2 draws). The three middle placements scored the same, so the net
// picked at random.
describe("règle 14 : une créature CONTRE COUP se pose en face d'un attaquant", () => {
  const YUGO = 152, SCARAFON = 533;

  it("Yugo se pose en face du Scarafon (rangée 2) plutôt que sur une rangée vide", () => {
    cards();
    const scara = mkCreature(1, "enemy", { x: 1, y: 2 }, { cardId: SCARAFON, currentAttack: 2, currentLife: 1, baseMovement: 3 });
    // prisms removed: the starting prisms (x=8) make the placements unequal, and the
    // draw prism on an empty deck even triggers FATIGUE (a -400 artefact)
    const s = { ...scenario([scara], YUGO), prisms: [] };
    const facing = oneStepHeuristicScore(s, { kind: "play", cardId: YUGO, target: { x: 8, y: 2 } }, "ally");
    const empty = oneStepHeuristicScore(s, { kind: "play", cardId: YUGO, target: { x: 8, y: 1 } }, "ally");
    expect(facing).toBeGreaterThan(empty);
  });

  it("face à un attaquant FAIBLE (2 coups encaissés) plutôt qu'à un fort (1 coup)", () => {
    cards();
    const weak = mkCreature(1, "enemy", { x: 1, y: 2 }, { cardId: SCARAFON, currentAttack: 2, currentLife: 1, baseMovement: 3 });
    const strong = mkCreature(2, "enemy", { x: 1, y: 1 }, { cardId: SCARAFON, currentAttack: 4, currentLife: 1, baseMovement: 3 });
    const s = { ...scenario([weak, strong], YUGO), prisms: [] };
    const vsWeak = oneStepHeuristicScore(s, { kind: "play", cardId: YUGO, target: { x: 8, y: 2 } }, "ally");
    const vsStrong = oneStepHeuristicScore(s, { kind: "play", cardId: YUGO, target: { x: 8, y: 1 } }, "ally");
    expect(vsWeak).toBeGreaterThan(vsStrong);
  });
});

// Early reserve (it could have been played on an AP prism, to play a 3 AP creature
// next turn): early in the game, a reserve AP almost always turns into tempo, so it
// is worth about costWorth, not 7. Later it goes back to its normal value.
describe("réserve précoce : un PA banké tôt vaut plus qu'une carte de plus, tard non", () => {
  it("au tour 2, +1 réserve bat +1 carte en main ; au tour 10 c'est l'inverse", () => {
    const base = scenario([]);
    const mk = (turn: number, reserve: number, extraCard: boolean) => ({
      ...base,
      turn,
      players: {
        ...base.players,
        ally: {
          ...base.players.ally,
          apReserve: reserve,
          hand: extraCard ? [...base.players.ally.hand, 16] : base.players.ally.hand,
        },
      },
    });
    const earlyReserve = evaluate(mk(2, 1, false), "ally") - evaluate(mk(2, 0, false), "ally");
    const earlyCard = evaluate(mk(2, 0, true), "ally") - evaluate(mk(2, 0, false), "ally");
    expect(earlyReserve).toBeGreaterThan(earlyCard);
    const lateReserve = evaluate(mk(10, 1, false), "ally") - evaluate(mk(10, 0, false), "ally");
    const lateCard = evaluate(mk(10, 0, true), "ally") - evaluate(mk(10, 0, false), "ally");
    expect(lateCard).toBeGreaterThan(lateReserve);
  });
});

// Lethal blocker (why did the enemy not try to defend?): a melee attacker that dies
// in the exchange against the blockers of its row never reaches the Dofus, so its
// threat is zero, not "delayed by one turn". Placing the right defender pays off.
describe("bloqueur létal : la menace d'un attaquant condamné par la file tombe à zéro", () => {
  it("un 2/1 ennemi bloqué par mon 5/2 ne pèse presque plus ; un 6/6 traverse et pèse encore", () => {
    const runt = mkCreature(1, "enemy", { x: 5, y: 3 }, { currentAttack: 2, currentLife: 1, baseMovement: 3 });
    const tank = mkCreature(2, "enemy", { x: 5, y: 1 }, { currentAttack: 6, currentLife: 6, baseMovement: 3 });
    const base = scenario([runt, tank]);
    const noAtk = (s: typeof base, id: number) => ({ ...s, creatures: s.creatures.filter((c) => c.instanceId !== id) });
    const block = (s: typeof base, y: number, id: number) =>
      ({ ...s, creatures: [...s.creatures, mkCreature(id, "ally", { x: 7, y }, { currentAttack: 5, currentLife: 2, baseMovement: 2 })] });
    // cost of the 2/1 for me, without and with my 5/2 blocker in front of it
    const costRuntOpen = evaluate(noAtk(base, 1), "ally") - evaluate(base, "ally");
    const blocked3 = block(base, 3, 10);
    const costRuntBlocked = evaluate(noAtk(blocked3, 1), "ally") - evaluate(blocked3, "ally");
    expect(costRuntOpen).toBeGreaterThan(costRuntBlocked); // blocked until death, so no threat
    // the 6/6 takes the hit back from the 5/2 and gets through: its threat still counts
    const blocked1 = block(base, 1, 11);
    const costTankBlocked = evaluate(noAtk(blocked1, 2), "ally") - evaluate(blocked1, "ally");
    expect(costTankBlocked).toBeGreaterThan(0); // toujours une menace
  });
});

// Rule 15 (do not throw Kamasutar away like that when there are other options):
// Kamasutar #92 draws 2 if the hand has fewer than 4 cards. Played with a full hand,
// the effect is certainly dead when it is played; same effect-share floor as rule 7.
// With a short hand, the effect works and playing it is good again.
describe("règle 15 : une APPARITION à condition prouvablement fausse est un effet gaspillé", () => {
  const KAMASUTAR = 92;
  it("main pleine (condition morte), un Fléau sur Dofus bat la pose de Kamasutar ; main courte, Kamasutar bat la passe", () => {
    cards();
    // prisms removed (the play would use one, and the draw prism on a small deck even
    // triggers fatigue) and decks filled (the apparition draws 2)
    const base = { ...scenario([], KAMASUTAR), prisms: [] };
    const full = {
      ...base,
      players: {
        ...base.players,
        ally: { ...base.players.ally, ap: 5, hand: [KAMASUTAR, FLEAU, 16, 16, 16], handCostMods: [0, 0, 0, 0, 0], deck: [16, 16, 16, 16] },
        enemy: { ...base.players.enemy, deck: [16, 16, 16, 16] },
      },
    };
    const foe = full.dofuses.find((d) => d.owner === "enemy" && d.kind === "real")!;
    const kamaFull = oneStepHeuristicScore(full, { kind: "play", cardId: KAMASUTAR, target: { x: 8, y: 2 } }, "ally");
    const fleau = oneStepHeuristicScore(full, { kind: "play", cardId: FLEAU, target: foe.position }, "ally");
    expect(fleau).toBeGreaterThan(kamaFull);
    // short hand: after the play 0 cards are left, < 4, so the draw 2 works and playing > passing
    const small = {
      ...full,
      players: { ...full.players, ally: { ...full.players.ally, ap: 4, hand: [KAMASUTAR], handCostMods: [0] } },
    };
    const kamaSmall = oneStepHeuristicScore(small, { kind: "play", cardId: KAMASUTAR, target: { x: 8, y: 2 } }, "ally");
    const pass = oneStepHeuristicScore(small, { kind: "endTurn" }, "ally");
    expect(kamaSmall).toBeGreaterThan(pass);
  });
});

// Rule 16 (Kokoko in front of the Kerubim is the best thing a ranged creature can
// do): a shooter placed in front of an enemy has the initiative: during the advance
// it shoots first, and there is no ranged answer. Kokoko with 3 ATK one-shots a
// Kerubim with 3 HP.
describe("règle 16 : un tireur se pose en face d'une cible, surtout s'il la one-shot", () => {
  const KOKOKO = 157, KERUBIM = 378;
  it("Kokoko se pose en face du Kerubim (même sur une voie de bord) plutôt que sur une voie vide", () => {
    cards();
    const keru = mkCreature(1, "enemy", { x: 1, y: 0 }, { cardId: KERUBIM, currentAttack: 3, currentLife: 3, baseMovement: 3 });
    const s = { ...scenario([keru], KOKOKO), prisms: [] };
    const facing = oneStepHeuristicScore(s, { kind: "play", cardId: KOKOKO, target: { x: 8, y: 0 } }, "ally");
    const empty = oneStepHeuristicScore(s, { kind: "play", cardId: KOKOKO, target: { x: 8, y: 2 } }, "ally");
    expect(facing).toBeGreaterThan(empty);
  });
});

// Rule 17 (Archille parked on a dead lane, then a Dragon Cochon sacrificed to block
// it although it would leave the board on its own two turns later): a creature whose
// lane has no target Dofus is temporary, so its body only counts half, both ways
// (parking your own big card there, or wasting removal on the opponent's).
describe("règle 17 : le corps d'une créature sur voie morte est décoté", () => {
  it("le même corps allié apporte moins d'éval quand sa voie n'a plus de Dofus cible", () => {
    const body = mkCreature(1, "ally", { x: 6, y: 2 }, { currentAttack: 0, currentLife: 6, armor: 0, baseMovement: 2 });
    const base = scenario([body]);
    const killed = base.dofuses.find((d) => d.owner === "enemy" && d.position.y === 2)!;
    const deadLane = {
      ...base,
      dofuses: base.dofuses.filter((d) => d !== killed),
      destroyedDofuses: [...(base.destroyedDofuses ?? []), { position: { ...killed.position }, owner: killed.owner, kind: killed.kind }],
    };
    const deltaAlive = evaluate(base, "ally") - evaluate({ ...base, creatures: [] }, "ally");
    const deltaDead = evaluate(deadLane, "ally") - evaluate({ ...deadLane, creatures: [] }, "ally");
    // ATK 0: no threat term applies, only the body discount separates the two
    expect(deltaDead).toBeLessThan(deltaAlive);
    expect(deltaDead).toBeGreaterThan(0); // il bloque encore : pas zéro
  });
});

// Rule 18 (creatures are best played as answers to other creatures: the Rat Dominant
// in front of the Black Wabbit kills it and survives; keeping the initiative means
// our advance decides the fight): a melee creature placed in front of a target it
// kills gets a bonus, doubled if it survives the hit back.
describe("règle 18 : une mêlée se pose en réponse quand elle gagne l'échange", () => {
  it("pose en face d'un 2/3 que je tue en survivant > pose sur une voie vide ; pas de bonus si je meurs sans tuer", () => {
    cards();
    const TRONKNYDE = 280; // pur corps 3/3
    const wabbit = mkCreature(1, "enemy", { x: 1, y: 2 }, { currentAttack: 2, currentLife: 3, baseMovement: 2 });
    const s = { ...scenario([wabbit], TRONKNYDE), prisms: [] };
    const facing = oneStepHeuristicScore(s, { kind: "play", cardId: TRONKNYDE, target: { x: 8, y: 2 } }, "ally");
    const empty = oneStepHeuristicScore(s, { kind: "play", cardId: TRONKNYDE, target: { x: 8, y: 1 } }, "ally");
    expect(facing).toBeGreaterThan(empty);
    // in front of an 8/9 monster that Tronknyde does not kill: no answer bonus
    const monster = mkCreature(2, "enemy", { x: 1, y: 3 }, { currentAttack: 8, currentLife: 9, baseMovement: 2 });
    const s2 = { ...scenario([monster], TRONKNYDE), prisms: [] };
    const feed = oneStepHeuristicScore(s2, { kind: "play", cardId: TRONKNYDE, target: { x: 8, y: 3 } }, "ally");
    const away = oneStepHeuristicScore(s2, { kind: "play", cardId: TRONKNYDE, target: { x: 8, y: 1 } }, "ally");
    expect(feed).toBeLessThanOrEqual(away);
  });
});

// Rule 13 v2: what a spell realizes is measured against the pass line. A Charge on
// a creature already next to the Dofus only does early what the natural advance was
// going to do, so the penalty is full and the card is kept. The same Charge that
// captures now what the pass would not reach realizes everything, so it is played.
describe("règle 13 v2 : un accélérateur vaut ce qu'il réalise en plus de la passe", () => {
  const CHARGE = 749; // Charge (Iop) : 2 PA, charge 2 cases
  it("Charge qui fait CAPTURER un Dofus entamé hors de portée naturelle : lancer bat garder", () => {
    cards();
    // creature with 3 ATK, 3 cells from the enemy Dofus (2 HP left), PM 1: the pass does
    // not get there this turn; the Charge (2 cells) and the advance put it next to the
    // Dofus and it destroys it.
    const runner = mkCreature(1, "ally", { x: 4, y: 2 }, { currentAttack: 3, currentLife: 4, baseMovement: 1, movementLeft: 1 });
    const base = { ...scenario([runner], CHARGE), prisms: [] };
    const dofuses = base.dofuses.map((d) =>
      d.owner === "enemy" && d.position.y === 2 ? { ...d, currentLife: 2, kind: "real" as const } : d);
    const s = { ...base, dofuses, players: { ...base.players, ally: { ...base.players.ally, ap: 2, deck: [16, 16] }, enemy: { ...base.players.enemy, deck: [16, 16] } } };
    const cast = oneStepHeuristicScore(s, { kind: "play", cardId: CHARGE, target: { x: 4, y: 2 } }, "ally");
    const pass = oneStepHeuristicScore(s, { kind: "endTurn" }, "ally");
    expect(cast).toBeGreaterThan(pass);
  });
});

// Rule 19 (a Charge on Kokoko that moved 2 cells but did not threaten the Dofus, a
// real waste; and for Glaie, keep it to give the PM that reaches the Dofus): an
// accelerator that gives no Dofus progress this turn is certain waste, full penalty
// with no cap, and the threat gain no longer pays it back.
describe("règle 19 : un accélérateur à vide (aucun progrès Dofus) se garde", () => {
  const CHARGE = 749, GLAIE = 126;
  it("Charge qui ne fait qu'avancer (aucun contact Dofus ce tour) : garder bat lancer", () => {
    cards();
    const runner = mkCreature(1, "ally", { x: 6, y: 2 }, { currentAttack: 3, currentLife: 4, baseMovement: 1, movementLeft: 1 });
    const base = { ...scenario([runner], CHARGE), prisms: [] };
    const s = { ...base, players: { ...base.players, ally: { ...base.players.ally, ap: 2, deck: [16, 16] }, enemy: { ...base.players.enemy, deck: [16, 16] } } };
    const cast = oneStepHeuristicScore(s, { kind: "play", cardId: CHARGE, target: { x: 6, y: 2 } }, "ally");
    const pass = oneStepHeuristicScore(s, { kind: "endTurn" }, "ally");
    expect(pass).toBeGreaterThan(cast);
  });
  it("Glaie dont le boost ne convertit rien ce tour : garder bat poser, même avec une cible externe", () => {
    cards();
    // a boostable ally exists (the pick opens, so rule 7 alone does not apply) but it is
    // far from every Dofus: the +1 PM gives nothing this turn.
    const far = mkCreature(1, "ally", { x: 7, y: 1 }, { currentAttack: 2, currentLife: 3, baseMovement: 2, movementLeft: 2 });
    const base = { ...scenario([far], GLAIE), prisms: [] };
    const s = { ...base, players: { ...base.players, ally: { ...base.players.ally, ap: 2, deck: [16, 16] }, enemy: { ...base.players.enemy, deck: [16, 16] } } };
    const play = oneStepHeuristicScore(s, { kind: "play", cardId: GLAIE, target: { x: 8, y: 2 } }, "ally");
    const pass = oneStepHeuristicScore(s, { kind: "endTurn" }, "ally");
    expect(pass).toBeGreaterThan(play);
  });
});

// Rule 20 (killing Chuck, 2 HP, with the Black Wabbit to cut the opponent's draws;
// the Piou aux Oeufs d'Or is the priority target, since drawing matters a lot in
// this game): a repeatable draw engine is worth much more than its body.
describe("règle 20 : un moteur de pioche adverse pèse plus lourd que son corps", () => {
  it("à corps égal, l'ennemi avec Chuck Lapalette (pioche sur MORT ADVERSE) me coûte plus cher", () => {
    cards();
    const engine = mkCreature(1, "enemy", { x: 2, y: 1 }, { cardId: 1541, currentAttack: 3, currentLife: 2, baseMovement: 2, triggers: card(1541).triggers ?? [] });
    const vanilla = mkCreature(1, "enemy", { x: 2, y: 1 }, { cardId: 280, currentAttack: 3, currentLife: 2, baseMovement: 2 });
    const sEngine = scenario([engine]);
    const sVanilla = { ...sEngine, creatures: [vanilla] }; // same state, only the trigger changes
    expect(evaluate(sEngine, "ally")).toBeLessThan(evaluate(sVanilla, "ally"));
  });
});

// Rule 22 (a Crâ placed on an empty lane: the opponent plays in front of it and the
// whole benefit of the range is lost): a shooter is played as an answer, never first
// on an empty lane when there are enemies to answer elsewhere.
describe("règle 22 : un tireur ne s'avance pas en premier sur une voie vide", () => {
  const KOKOKO = 157;
  it("avec un ennemi présent ailleurs, la pose en vis-à-vis écrase la pose sur voie vide", () => {
    cards();
    const keru = mkCreature(1, "enemy", { x: 1, y: 2 }, { cardId: 378, currentAttack: 3, currentLife: 3, baseMovement: 3 });
    const s = { ...scenario([keru], KOKOKO), prisms: [] };
    const facing = oneStepHeuristicScore(s, { kind: "play", cardId: KOKOKO, target: { x: 8, y: 2 } }, "ally");
    const empty = oneStepHeuristicScore(s, { kind: "play", cardId: KOKOKO, target: { x: 8, y: 1 } }, "ally");
    expect(facing - empty).toBeGreaterThan(30); // bonus de réponse + malus voie-vide cumulés
  });
});

// Rule 23 (Héroïne Stridulante, a very strong card, offered to an Éclaireur d'Élite
// that one-shots it, when the options were to give up the lane or stall with a small
// creature; same with a Robin): feeding means standing in front of a one-shot while
// unable to kill it; the penalty follows the cost.
describe("règle 23 : on ne donne pas une carte en pâture à un one-shot", () => {
  it("un 3/3 posé face à un monstre 8/9 score strictement moins que sur une autre voie", () => {
    cards();
    const TRONKNYDE = 280;
    const monster = mkCreature(2, "enemy", { x: 1, y: 3 }, { currentAttack: 8, currentLife: 9, baseMovement: 2 });
    const s2 = { ...scenario([monster], TRONKNYDE), prisms: [] };
    const feed = oneStepHeuristicScore(s2, { kind: "play", cardId: TRONKNYDE, target: { x: 8, y: 3 } }, "ally");
    const away = oneStepHeuristicScore(s2, { kind: "play", cardId: TRONKNYDE, target: { x: 8, y: 1 } }, "ally");
    expect(away).toBeGreaterThan(feed);
  });
});

// Rule 24 (Flèche Destructrice at 5 AP burned on a Robin with 1 HP, very expensive for
// one damage, even with no other removal in hand): overkill costs in proportion to
// the cost above the target's remaining HP.
describe("règle 24 : l'overkill de removal se paie", () => {
  const DESTRUCTRICE = 253, ROBIN = 528;
  it("Flèche Destructrice sur un Robin à 1 PV loin de tout : garder bat brûler", () => {
    cards();
    const robin = mkCreature(9, "enemy", { x: 1, y: 2 }, { cardId: ROBIN, currentAttack: 2, currentLife: 1, baseMovement: 2 });
    const base = { ...scenario([robin], DESTRUCTRICE), prisms: [] };
    const s = { ...base, players: { ...base.players, ally: { ...base.players.ally, ap: 5, deck: [16, 16] }, enemy: { ...base.players.enemy, deck: [16, 16] } } };
    const burn = oneStepHeuristicScore(s, { kind: "play", cardId: DESTRUCTRICE, target: { x: 1, y: 2 } }, "ally");
    const pass = oneStepHeuristicScore(s, { kind: "endTurn" }, "ally");
    expect(pass).toBeGreaterThan(burn);
  });
  it("la même Destructrice sur un gros 8 PV menaçant part sans malus d'overkill : tuer bat passer", () => {
    cards();
    const tank = mkCreature(9, "enemy", { x: 4, y: 2 }, { currentAttack: 6, currentLife: 8, baseMovement: 3, movementLeft: 3 });
    const base = { ...scenario([tank], DESTRUCTRICE), prisms: [] };
    const s = { ...base, players: { ...base.players, ally: { ...base.players.ally, ap: 5, deck: [16, 16] }, enemy: { ...base.players.enemy, deck: [16, 16] } } };
    const kill = oneStepHeuristicScore(s, { kind: "play", cardId: DESTRUCTRICE, target: { x: 4, y: 2 } }, "ally");
    const pass = oneStepHeuristicScore(s, { kind: "endTurn" }, "ally");
    expect(kill).toBeGreaterThan(pass);
  });
});

// Rule 25 (Carquois should have been played as soon as possible, to find answers
// fast): drawn cards are progress as real as Dofus damage, so a draw spell realizes
// its share in proportion to the cards gained.
describe("règle 25 : un sort de pioche se joue, il réalise sa part en cartes", () => {
  const CARQUOIS = 627; // pioche 2 puis FIN DE TOUR
  it("Carquois en main sans autre solution : le jouer bat passer", () => {
    cards();
    const base = { ...scenario([], CARQUOIS), prisms: [] };
    const s = { ...base, players: { ...base.players,
      ally: { ...base.players.ally, ap: 2, deck: [16, 16, 16, 16] },
      enemy: { ...base.players.enemy, deck: [16, 16, 16, 16] } } };
    const draw = oneStepHeuristicScore(s, { kind: "play", cardId: CARQUOIS, target: { x: 8, y: 2 } }, "ally");
    const pass = oneStepHeuristicScore(s, { kind: "endTurn" }, "ally");
    expect(draw).toBeGreaterThan(pass);
  });
});

// Rule 23, extended (Poiscaille offered to Robin des Landes, who hits from range and
// so kills it without any risk): against a shooter that one-shots us, being able to
// kill it in melee does not count, we never reach it.
describe("règle 23 étendue : face à un tireur qui one-shot, la pose reste une pâture", () => {
  it("mon 4/4 (qui tuerait un 4/3 en mêlée) posé face à un TIREUR 4/3 : pire qu'ailleurs", () => {
    cards();
    const TRONKNYDE = 280;
    const sniper = mkCreature(2, "enemy", { x: 1, y: 3 }, { currentAttack: 4, currentLife: 3, baseMovement: 2, range: 2 });
    const s2 = { ...scenario([sniper], TRONKNYDE), prisms: [] };
    const feed = oneStepHeuristicScore(s2, { kind: "play", cardId: TRONKNYDE, target: { x: 8, y: 3 } }, "ally");
    const away = oneStepHeuristicScore(s2, { kind: "play", cardId: TRONKNYDE, target: { x: 8, y: 1 } }, "ally");
    expect(away).toBeGreaterThan(feed);
  });
});

// Rule 15, extended (Noxine played when there was no AP to steal in the reserve):
// StealReserve on an empty enemy reserve is an effect that is dead when played; with
// an AP to steal, the effect is worth it (the steal swings the resource both ways).
describe("règle 15 étendue : Noxine se garde tant qu'il n'y a rien à voler", () => {
  const NOXINE = 392;
  it("la même pose de Noxine score nettement mieux quand la réserve adverse a un PA à voler", () => {
    cards();
    const base = { ...scenario([], NOXINE), prisms: [] };
    const s0 = { ...base, players: { ...base.players,
      ally: { ...base.players.ally, ap: 2, deck: [16, 16] },
      enemy: { ...base.players.enemy, apReserve: 0, deck: [16, 16] } } };
    const s1 = { ...s0, players: { ...s0.players, enemy: { ...s0.players.enemy, apReserve: 1 } } };
    const dry = oneStepHeuristicScore(s0, { kind: "play", cardId: NOXINE, target: { x: 8, y: 2 } }, "ally");
    const steal = oneStepHeuristicScore(s1, { kind: "play", cardId: NOXINE, target: { x: 8, y: 2 } }, "ally");
    expect(steal - dry).toBeGreaterThan(60);
  });
});

// Opponent-model rollout: the remaining class of mistakes (defending never paying
// off, fragile survivors overvalued) came from the deep rollout that makes the
// opponent pass. With oppModel, the opponent plays its turn (greedy completion).
// Judging the saved real cases again: in one, defending the Wabbit's lane moves to
// the top; in another, the lead of Heure de Gloire drops from 128 to 27 points.
describe("rollout modèle d'adversaire : l'adversaire simulé joue, il ne passe plus", () => {
  it("face à une main adverse menaçante, la passe projetée avec oppModel est PIRE que sans", () => {
    cards();
    const TRONKNYDE = 280;
    // the opponent (enemy) has enough to put bodies on the board: projecting its turn has
    // to lower my eval compared with the naive pass where it plays nothing
    // turn 9: at the opponent's startTurn its AP are refreshed from the turn number (not
    // from the state before the pass), so a later turn is needed for it to afford its
    // Tronknydes in the projection.
    const base = { ...scenario([], TRONKNYDE), prisms: [], turn: 9 };
    const s = {
      ...base,
      players: {
        ...base.players,
        ally: { ...base.players.ally, ap: 0, hand: [], handCostMods: [], deck: [16, 16] },
        enemy: { ...base.players.enemy, maxAp: 5, hand: [280, 280, 280], handCostMods: [0, 0, 0], deck: [16, 16] },
      },
    };
    const passOff = oneStepHeuristicScore(s, { kind: "endTurn" }, "ally", true, false, false);
    const passOn = oneStepHeuristicScore(s, { kind: "endTurn" }, "ally", true, false, true);
    expect(passOn).toBeLessThan(passOff); // ses Tronknydes posés pèsent sur mon éval
  });
});

// Rule 26 (keep Tomla Klass to boost, at the last moment, creatures that would not
// have enough attack to kill the opposing creature; it was burned on Abigaïl, 3->5 ATK
// against 3 HP, which changed nothing): a targeted ATK boost is played when it turns a
// non-kill into a kill, otherwise it is kept.
describe("règle 26 : le boost d'attaque se garde pour convertir un kill", () => {
  const TOMLA = 72, TRONKNYDE = 280;
  const mkState = (foeLife: number) => {
    const mine = mkCreature(1, "ally", { x: 6, y: 2 }, { cardId: TRONKNYDE, currentAttack: 3, currentLife: 3, baseMovement: 2 });
    const foe = mkCreature(2, "enemy", { x: 3, y: 2 }, { currentAttack: 2, currentLife: foeLife, baseMovement: 2 });
    const base = { ...scenario([mine, foe], TOMLA), prisms: [] };
    return { ...base, players: { ...base.players,
      ally: { ...base.players.ally, ap: 2, deck: [16, 16] },
      enemy: { ...base.players.enemy, deck: [16, 16] } } };
  };
  // deep+plan mode: the one used by the root veto/tie-break, where the rule applies (and
  // where the smarter target choice picks the ally, not the enemy)
  it("le +2 ATK convertit un kill (vis-à-vis 4 PV, ATK 3 -> 5) : jouer bat passer", () => {
    cards();
    const s = mkState(4);
    const play = oneStepHeuristicScore(s, { kind: "play", cardId: TOMLA, target: { x: 8, y: 2 } }, "ally", true, true);
    const pass = oneStepHeuristicScore(s, { kind: "endTurn" }, "ally", true, true);
    expect(play).toBeGreaterThan(pass);
  });
  it("le +2 ATK ne convertit rien (vis-à-vis 8 PV) : garder bat jouer", () => {
    cards();
    const s = mkState(8);
    const play = oneStepHeuristicScore(s, { kind: "play", cardId: TOMLA, target: { x: 8, y: 2 } }, "ally", true, true);
    const pass = oneStepHeuristicScore(s, { kind: "endTurn" }, "ally", true, true);
    expect(pass).toBeGreaterThan(play);
  });
});

// Rule 27 (the hand reaches ten cards, so the next drawn card goes to the discard):
// ending your turn with a full hand burns the next draw. The typical case: Chuchoteurs
// that are kept when their aura hits nobody (rule 4) still have to be played if
// keeping them means ending at 10 cards.
describe("règle 27 : finir à main pleine brûle la pioche, jouer plutôt que cramer un tirage", () => {
  it("Chuchoteurs sans cible d'aura : se garde à main normale, se joue à main pleine", () => {
    cards();
    const CHUCHOTEURS = 555;
    const base = { ...scenario([], CHUCHOTEURS), prisms: [] };
    const fill = (n: number) => {
      const hand = [CHUCHOTEURS, ...Array(n - 1).fill(16)];
      return {
        ...base,
        players: {
          ...base.players,
          ally: { ...base.players.ally, ap: 4, hand, handCostMods: hand.map(() => 0), deck: [16, 16] },
          enemy: { ...base.players.enemy, deck: [16, 16] },
        },
      };
    };
    // main pleine (10) : jouer bat garder, la pioche brûlerait sinon
    const sFull = fill(10);
    const playFull = oneStepHeuristicScore(sFull, { kind: "play", cardId: CHUCHOTEURS, target: { x: 8, y: 2 } }, "ally");
    const passFull = oneStepHeuristicScore(sFull, { kind: "endTurn" }, "ally");
    expect(playFull).toBeGreaterThan(passFull);
    // main courte (4) : la règle 4 reprend la main, garder bat jouer
    const sSmall = fill(4);
    const playSmall = oneStepHeuristicScore(sSmall, { kind: "play", cardId: CHUCHOTEURS, target: { x: 8, y: 2 } }, "ally");
    const passSmall = oneStepHeuristicScore(sSmall, { kind: "endTurn" }, "ally");
    expect(passSmall).toBeGreaterThan(playSmall);
  });
});
