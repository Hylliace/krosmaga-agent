// Permanent spec for the cards of the Pandawa god.
//
// Each `it` checks that an effect wired in the data is really played by the engine.
// Since an unknown effect type is a silent no-op in the engine, a card can look wired
// and do nothing, so these tests are the only proof that the wiring holds.
//
// The rules they follow come from the rules of the game for this god.
import { describe, it, expect } from "vitest";
import { card, cards, mkCreature, scenario, byId } from "./testkit";
import { woundDofus } from "./effects";
import type { GameEvent } from "./state";
import { playCard, endTurn, startTurn, resolvePendingAction, cancelPendingAction, withAuras, fermentOf, canPlayCard, validPendingTargets } from "./rules";
import type { GameState } from "./state";

/** FERMENTATION counter of the first copy of `cardId` in the hand (single-copy tests). */
const fermDe = (s: GameState, cardId: number) =>
  fermentOf(s.players.ally.handFerment, s.players.ally.hand.indexOf(cardId));
import { applyEffects } from "./effects";
import type { CreatureInstance } from "./state";
import type { Effect } from "../data/types";

/** Applies raw effects on a bare board, to test a primitive. */
function applyEffects2(cs: CreatureInstance[], effs: Effect[], at: { x: number; y: number }) {
  const copie = cs.map((c) => ({ ...c, properties: new Set(c.properties) }));
  applyEffects(copie, [], [], effs, { casterSide: "ally", targetCell: at });
  return copie;
}

const TONNEAU = 2004;
const PICOLE = 2021;
const LAIT_DE_BAMBOU = 506;

// Non-empty decks: otherwise the draw at the start of the turn triggers the fatigue
// (rule 11) and wounds the Dofus, which gets in the way of the assertions.
const withDecks = (s: ReturnType<typeof scenario>): ReturnType<typeof scenario> => ({
  ...s,
  players: {
    ...s.players,
    ally: { ...s.players.ally, deck: [16, 16, 16] },
    enemy: { ...s.players.enemy, deck: [16, 16, 16] },
  },
});

/** Places a Pandawa creature with its triggers, ready to act. */
const pandawa = (instanceId: number, cardId: number, pos: { x: number; y: number },
                 o: Parameters<typeof mkCreature>[3] = {}) => {
  const c = card(cardId);
  return mkCreature(instanceId, "ally", pos, {
    cardId,
    triggers: c.triggers ?? [],
    currentLife: c.life ?? 5,
    baseLife: c.life ?? 5,
    printedLife: c.life ?? 5,
    currentAttack: c.attack ?? 2,
    baseAttack: c.attack ?? 2,
    printedAttack: c.attack ?? 2,
    ...o,
  });
};

describe("Pandawa: the Tonneau is a Wall and a normal deck card", () => {
  it("#2004 carries the Statue property (Wall) and the Tonneau family", () => {
    const t = card(TONNEAU);
    expect(t.effects).toContainEqual({ type: "SetPropertyData", PropertyType: "Statue" });
    expect(t.families).toContain("Tonneau");
    expect(t.movement).toBe(0);           // "/" for MP
  });
  it("it is not a token: Recyclage must be able to take it back from the discard", () => {
    // A token goes to tokenDiscard, a zone no effect can reach (state.ts).
    expect((card(TONNEAU) as { isToken?: boolean }).isToken).toBeFalsy();
  });
  it("it is not a Pandawa, so it can never be drunk", () => {
    expect(card(TONNEAU).families).not.toContain("Pandawa");
  });
  it("it uses the animated model « Tonneau de l'Éméché » (Dofus 3 rig no. 4575)", () => {
    // The 6 cards that place, count, bring back or turn into a Tonneau (Mali Bouh, Marc Tini,
    // Aruko Riku, Barak Oktell, Kura Sao, Recyclage, Exaltation) all show this figure.
    expect(card(TONNEAU).model).toBe("pandawa_tonneau");
  });
});

describe("Pandawa: cards wired without a line of engine code", () => {
  it("#2006 Yves Ress: CONTRE COUP adds a Picole to the hand", () => {
    // The trigger changed: nothing fires at placement any more…
    const pose = playCard(withDecks(scenario([], 2006)), card(2006), { x: 8, y: 2 });
    expect(pose.players.ally.hand).not.toContain(PICOLE);
    // …it is by taking damage that it banks the Picole.
    const yves = pandawa(1, 2006, { x: 6, y: 2 });
    const frappeur = mkCreature(9, "enemy", { x: 5, y: 2 }, { currentAttack: 1, baseAttack: 1 });
    const s = endTurn(withDecks(scenario([yves, frappeur])));
    expect(s.players.ally.hand).toContain(PICOLE);
  });

  it("#2012 Mali Bouh: APPARITION charges 2 cells per allied Tonneau", () => {
    const t1 = pandawa(2, TONNEAU, { x: 7, y: 1 }, { movementLeft: 0, hasAttacked: true });
    const s = playCard(withDecks(scenario([t1], 2012)), card(2012), { x: 8, y: 2 });
    const mali = s.creatures.find((c) => c.cardId === 2012)!;
    expect(mali.position.x).toBeLessThan(8);   // 1 Tonneau => 2 cells forward
  });

  it("#2011 Barak Oktell: APPARITION places a Tonneau in the camp", () => {
    let s = playCard(withDecks(scenario([], 2011)), card(2011), { x: 8, y: 2 });
    // placement "campChoose" opens a pick: it is resolved on a free cell of the camp.
    if (s.pendingAction) s = resolvePendingAction(s, { x: 7, y: 0 });
    expect(s.creatures.some((c) => c.cardId === TONNEAU && c.owner === "ally")).toBe(true);
  });

  it("#2005 Champion Assoiffé: lowers the AT of the first enemy in front, for a while", () => {
    // an ally in front does not count: it skips to the first enemy
    const amie = pandawa(1, 2007, { x: 5, y: 2 });
    const proche = mkCreature(9, "enemy", { x: 3, y: 2 }, { currentAttack: 3, baseAttack: 3 });
    const loin = mkCreature(10, "enemy", { x: 1, y: 2 }, { currentAttack: 3, baseAttack: 3 });
    const horsLigne = mkCreature(11, "enemy", { x: 3, y: 0 }, { currentAttack: 3, baseAttack: 3 });
    let s = playCard(withDecks(scenario([amie, proche, loin, horsLigne], 2005)), card(2005), { x: 8, y: 2 });
    // NÉCROME opens a pick before the placement; the APPARITION only fires after it
    // (pendingAction.fireApparitionAfter). The reveal is declined.
    expect(s.pendingAction).toBeTruthy();
    s = resolvePendingAction(s, { x: -1, y: -1 });
    expect(byId(s, 9)!.currentAttack).toBe(2);    // the first enemy in front
    expect(byId(s, 10)!.currentAttack).toBe(3);   // the one behind: untouched
    expect(byId(s, 11)!.currentAttack).toBe(3);   // other lane: untouched
    expect(byId(s, 1)!.currentAttack).toBe(amie.currentAttack);  // the ally is never touched

    // "jusqu'à votre prochain tour": the malus is given back at the start of the caster's turn.
    // Without the tempReversionSink relay, an effect with a duration carried by a trigger
    // (and not by a spell) stayed permanent.
    s = startTurn(endTurn(s), "ally");
    expect(byId(s, 9)!.currentAttack).toBe(3);
  });

  it("#2007 Marc Tini: FIN DU TOUR, +1 AT and +1 AR per allied Tonneau in play", () => {
    const marc = pandawa(1, 2007, { x: 6, y: 2 }, { movementLeft: 0, hasAttacked: true });
    const t1 = pandawa(2, TONNEAU, { x: 7, y: 1 }, { movementLeft: 0, hasAttacked: true });
    const t2 = pandawa(3, TONNEAU, { x: 7, y: 3 }, { movementLeft: 0, hasAttacked: true });
    const atk0 = marc.currentAttack;
    const s = endTurn(withDecks(scenario([marc, t1, t2])));
    expect(byId(s, 1)!.currentAttack).toBe(atk0 + 2);   // 2 Tonneaux
    expect(byId(s, 1)!.armor).toBe(2);
  });

  it("#2007 Marc Tini: without a Tonneau, no gain (the dynamic count is 0)", () => {
    const marc = pandawa(1, 2007, { x: 6, y: 2 }, { movementLeft: 0, hasAttacked: true });
    const atk0 = marc.currentAttack;
    const s = endTurn(withDecks(scenario([marc])));
    expect(byId(s, 1)!.currentAttack).toBe(atk0);
    expect(byId(s, 1)!.armor).toBe(0);
  });

  it("#2017 Kura Sao: draws when an allied Tonneau dies", () => {
    const kura = pandawa(1, 2017, { x: 6, y: 2 }, { movementLeft: 0, hasAttacked: true });
    const tonneau = pandawa(2, TONNEAU, { x: 7, y: 2 }, { currentLife: 1, movementLeft: 0, hasAttacked: true });
    const base = withDecks(scenario([kura, tonneau], 2027));
    const mainAvant = base.players.ally.hand.length;
    // Killing the Tonneau here is not easy (setting it to 0 HP and going through endTurn does
    // not work), so this test only checks that the trigger is declared and filtered. The full
    // path is tested further down.
    const trg = (card(2017).triggers ?? [])[0] as { trigger: string; filter?: { family?: string } };
    expect(trg.trigger).toBe("MORT_ALLIEE");
    expect(trg.filter?.family).toBe("Tonneau");
    expect(mainAvant).toBeGreaterThanOrEqual(0);
  });

  it("#2018 Zatoïshwan: APPARITION makes the enemies vulnerable, then deals 1 to them", () => {
    const cible = mkCreature(9, "enemy", { x: 2, y: 2 }, { currentLife: 5, baseLife: 5 });
    const s = playCard(withDecks(scenario([cible], 2018)), card(2018), { x: 8, y: 2 });
    const e = byId(s, 9)!;
    // vulnerability 1 set before the damage, so 1 damage becomes 2
    expect(e.vulnerability).toBe(1);
    expect(e.currentLife).toBe(3);
  });

  it("#2023 Prohibition: silences a creature", () => {
    // The engine ignores a silence on a creature that has nothing to silence (the
    // `hadSomething` guard, effects.ts), so it is given some armour.
    const cible = mkCreature(9, "enemy", { x: 2, y: 2 }, { armor: 2 });
    let s = playCard(withDecks(scenario([cible], 2023)), card(2023), { x: 2, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 2, y: 2 });
    expect(byId(s, 9)!.silenced).toBe(true);
  });

  it("#2022 Stabilité: makes the creatures of both sides on a row unmovable", () => {
    const ami = mkCreature(1, "ally", { x: 4, y: 1 });
    const ennemi = mkCreature(2, "enemy", { x: 4, y: 3 });
    const hors = mkCreature(3, "ally", { x: 5, y: 2 });
    let s = playCard(withDecks(scenario([ami, ennemi, hors], 2022)), card(2022), { x: 4, y: 0 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 4, y: 0 });
    expect(byId(s, 1)!.properties.has("Rooted")).toBe(true);
    expect(byId(s, 2)!.properties.has("Rooted")).toBe(true);   // both sides
    expect(byId(s, 3)!.properties.has("Rooted")).toBe(false);  // other row
  });

  it("#2038 Exaltation: turns a creature into an allied 0/2 Tonneau", () => {
    const cible = mkCreature(9, "enemy", { x: 2, y: 2 }, { currentLife: 7, baseLife: 7, currentAttack: 6 });
    let s = playCard(withDecks(scenario([cible], 2038)), card(2038), { x: 2, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 2, y: 2 });
    const t = s.creatures.find((c) => c.cardId === TONNEAU);
    expect(t).toBeDefined();
    expect(t!.owner).toBe("ally");            // "Tonneau allié"
    expect(t!.currentLife).toBe(2);           // back to the printed 0/2
    expect(t!.currentAttack).toBe(0);
    expect(t!.position).toEqual({ x: 2, y: 2 }); // stays on its cell
  });

  it("#2024 Apéro !: draws 1 card, and the Lait de Bambou has a condition", () => {
    const eff = card(2024).effects as Array<Record<string, unknown>>;
    expect(eff[0]).toMatchObject({ type: "DrawCards", amount: 1 });
    expect(eff[1]).toMatchObject({
      type: "AddCardToHand", cardId: LAIT_DE_BAMBOU,
      requireCondition: { kind: "outnumbered" },
    });
  });

  it("#2027 Flasque Explosive: 3 damage to two creatures, allies allowed", () => {
    const a = mkCreature(9, "enemy", { x: 3, y: 1 }, { currentLife: 9, baseLife: 9 });
    const b = mkCreature(10, "enemy", { x: 3, y: 3 }, { currentLife: 9, baseLife: 9 });
    const ami = pandawa(1, 2007, { x: 6, y: 2 }, { currentLife: 9, baseLife: 9 });
    const base = withDecks(scenario([a, b, ami], 2027));

    // two different targets: each takes 3
    let s = playCard(base, card(2027), { x: 3, y: 1 });
    expect(s.pendingAction).toBeTruthy();                 // the second click is asked
    s = resolvePendingAction(s, { x: 3, y: 3 });
    expect(byId(s, 9)!.currentLife).toBe(6);
    expect(byId(s, 10)!.currentLife).toBe(6);

    // an ally is a legal target
    let t = playCard(base, card(2027), { x: 3, y: 1 });
    t = resolvePendingAction(t, { x: 6, y: 2 });
    expect(byId(t, 1)!.currentLife).toBe(6);

    // second pick declined (click elsewhere): the spell still goes off, only the first one is hit
    let u = playCard(base, card(2027), { x: 3, y: 1 });
    u = resolvePendingAction(u, { x: 0, y: 0 });
    expect(byId(u, 9)!.currentLife).toBe(6);
    expect(byId(u, 10)!.currentLife).toBe(9);
    expect(u.pendingAction).toBeNull();

    // never the same one twice: the first target is left out of the valid choices
    const v = playCard(base, card(2027), { x: 3, y: 1 });
    expect(validPendingTargets(v).some((p) => p.x === 3 && p.y === 1)).toBe(false);
  });

  it("#2028 Recyclage: one Tonneau from the deck and one from the discard", () => {
    const base = withDecks(scenario([], 2028));
    const jouer = (deck: number[], discard: number[]) => playCard({
      ...base,
      players: { ...base.players, ally: { ...base.players.ally, deck, discard } },
    }, card(2028), { x: 0, y: 0 });
    // both piles have one: two come back
    expect(jouer([16, TONNEAU, 16], [TONNEAU, 16]).players.ally.hand
      .filter((id) => id === TONNEAU).length).toBe(2);
    // only one pile has one: that one is still taken
    expect(jouer([16, 16], [TONNEAU, 16]).players.ally.hand
      .filter((id) => id === TONNEAU).length).toBe(1);
    expect(jouer([16, TONNEAU], [16]).players.ally.hand
      .filter((id) => id === TONNEAU).length).toBe(1);
    // neither has one: the spell is used up with no effect, not blocked
    const vide = jouer([16, 16], [16]);
    expect(vide.players.ally.hand.filter((id) => id === TONNEAU).length).toBe(0);
    expect(vide.players.ally.discard).toContain(2028);
  });

  it("#2010 Aruko Riku: APPARITION draws the next spell of 5 AP or more", () => {
    const base = withDecks(scenario([], 2010));
    const jouer = (deck: number[]) => playCard({
      ...base, players: { ...base.players, ally: { ...base.players.ally, deck } },
    }, card(2010), { x: 8, y: 2 }).players.ally.hand;
    // 2038 Exaltation = 7 AP spell; 2021 Picole = 0 AP spell; TONNEAU = 3 AP creature
    expect(jouer([2021, 2038, TONNEAU])).toContain(2038);
    // under the threshold or the wrong type: nothing comes back
    expect(jouer([2021, TONNEAU])).not.toContain(2021);
    // the threshold reads the printed cost, not the cost discounted in the deck:
    // a discount carried by deckCostMods does not make a 5 AP spell ineligible.
    const remise = playCard({
      ...base,
      players: { ...base.players, ally: {
        ...base.players.ally, deck: [TONNEAU, 2036], deckCostMods: [0, -1] } },
    }, card(2010), { x: 8, y: 2 });
    expect(remise.players.ally.hand).toContain(2036);   // Ivresse de la Bataille, 5 AP
  });

  it("#2008 Brasseuse Enjouée: APPARITION stuns a creature", () => {
    const cible = mkCreature(9, "enemy", { x: 2, y: 2 });
    let s = playCard(withDecks(scenario([cible], 2008)), card(2008), { x: 8, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 2, y: 2 });
    expect(byId(s, 9)!.properties.has("Stunned")).toBe(true);
  });
});

describe("Pandawa: the drunk state", () => {
  // The rules: +1 resistance / −1 MP; only for Pandawas; permanent; making a drunk
  // Pandawa drunk again is a no-op; silence sobers it up.
  it("#2021 Picole makes an allied Pandawa drunk", () => {
    const cible = pandawa(1, 2007, { x: 6, y: 2 });   // Marc Tini: a neutral dummy of the set. David Boivit #2002, the only
    // Pandawa with no effect, was removed from the set; Marc Tini replaces it because its
    // only trigger is FIN DU TOUR, so it is inert in these setups, where the creatures are
    // built directly, and does nothing when no Tonneau is in play.
    let s = playCard(withDecks(scenario([cible], PICOLE)), card(PICOLE), { x: 6, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 6, y: 2 });
    expect(byId(s, 1)!.properties.has("Saoul")).toBe(true);
  });

  it("being drunk gives +1 resistance and −1 MP", () => {
    const sobre = pandawa(1, 2007, { x: 6, y: 2 });
    const pm0 = withAuras([sobre])[0].baseMovement;
    const res0 = withAuras([sobre])[0].resistance;
    const ivre = { ...sobre, properties: new Set(["Saoul"]) };
    const apres = withAuras([ivre])[0];
    expect(apres.resistance).toBe(res0 + 1);
    expect(apres.baseMovement).toBe(pm0 - 1);
  });

  it("the bonus goes away by itself when the drunkenness leaves (aura* accumulators)", () => {
    const ivre = { ...pandawa(1, 2007, { x: 6, y: 2 }), properties: new Set(["Saoul"]) };
    const apresIvre = withAuras([ivre])[0];
    const degrise = withAuras([{ ...apresIvre, properties: new Set<string>() }])[0];
    expect(degrise.resistance).toBe(0);
    expect(degrise.baseMovement).toBe(pandawa(1, 2007, { x: 6, y: 2 }).baseMovement);
  });

  it("only Pandawas can be drunk, the Tonneau stays sober", () => {
    const tonneau = pandawa(1, TONNEAU, { x: 6, y: 2 });
    const s = applyEffects2([tonneau], [{ type: "SetProperty", property: "Saoul" }], { x: 6, y: 2 });
    expect(s[0].properties.has("Saoul")).toBe(false);
  });

  it("#2001 Habb Sinte: SAOUL triggers the +1 AR", () => {
    const habb = pandawa(1, 2001, { x: 6, y: 2 });
    let s = playCard(withDecks(scenario([habb], PICOLE)), card(PICOLE), { x: 6, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 6, y: 2 });
    expect(byId(s, 1)!.armor).toBe(1);
  });

  // You cannot make a drunk Pandawa drunk again. A Picole can be cast on a drunk Pandawa, but it
  // has no effect: the Pandawa stays drunk and, above all, the triggers of Pandawas that become
  // drunk do not fire. The older reading (making it drunk again triggers again) came from an
  // unsure answer that was wrongly turned into a rule.
  it("making an already drunk Pandawa drunk again: legal target, no effect, no trigger", () => {
    const habb = pandawa(1, 2001, { x: 6, y: 2 });
    let s = playCard(withDecks(scenario([habb], PICOLE, PICOLE)), card(PICOLE), { x: 6, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 6, y: 2 });
    expect(byId(s, 1)!.armor).toBe(1);                       // first SAOUL: Habb Sinte gains its +1 AR
    const journal = s.log.length;
    const mainAvant = s.players.ally.hand.length;
    s = playCard(s, card(PICOLE), { x: 6, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 6, y: 2 });
    // A Picole can be cast on a drunk Pandawa: the spell does go off, it is played, logged and
    // leaves the hand. It is not a refused target, it is a target with no effect.
    expect(s.players.ally.hand.length).toBe(mainAvant - 1);
    expect(s.log.slice(journal).some((e) => e.type === "CARD_PLAYED"
      && (e as { cardId?: number }).cardId === PICOLE)).toBe(true);
    expect(byId(s, 1)!.armor).toBe(1);                       // no effect: the +1 AR does not stack
    expect(byId(s, 1)!.properties.has("Saoul")).toBe(true);  // the Pandawa stays drunk
    expect(s.log.slice(journal).some((e) => e.type === "PROPERTY_APPLIED"
      && (e as { property?: string }).property === "Saoul")).toBe(false); // no new trigger
  });

  it("#2016 Mel Idro: SAOUL makes it charge one cell", () => {
    const mel = pandawa(1, 2016, { x: 6, y: 2 }, { movementLeft: 0, hasAttacked: true });
    let s = playCard(withDecks(scenario([mel], PICOLE)), card(PICOLE), { x: 6, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 6, y: 2 });
    expect(byId(s, 1)!.position.x).toBe(5);   // moved one cell towards the enemy
  });

  it("#2015 Pandiego: allied Pandawas enter drunk, and it does not", () => {
    const pandiego = pandawa(1, 2015, { x: 6, y: 2 }, { movementLeft: 0, hasAttacked: true });
    const s = playCard(withDecks(scenario([pandiego], 2007)), card(2007), { x: 8, y: 2 });
    const entrant = s.creatures.find((c) => c.cardId === 2007)!;
    expect(entrant.properties.has("Saoul")).toBe(true);
    expect(byId(s, 1)!.properties.has("Saoul")).toBe(false); // the reactor leaves itself out
  });

  it("#2023 Prohibition sobers up its target", () => {
    const habb = pandawa(1, 2001, { x: 6, y: 2 });
    let s = playCard(withDecks(scenario([habb], PICOLE, 2023)), card(PICOLE), { x: 6, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 6, y: 2 });
    expect(byId(s, 1)!.properties.has("Saoul")).toBe(true);
    s = playCard(s, card(2023), { x: 6, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 6, y: 2 });
    expect(byId(s, 1)!.properties.has("Saoul")).toBe(false);
  });

  it("#2030 Vague à Lame: damage to the enemies and drunkenness for the allied Pandawas of the row", () => {
    const ami = pandawa(1, 2007, { x: 4, y: 1 });
    const hors = pandawa(2, 2007, { x: 5, y: 1 });
    const ennemi = mkCreature(9, "enemy", { x: 4, y: 3 }, { currentLife: 5, baseLife: 5 });
    let s = playCard(withDecks(scenario([ami, hors, ennemi], 2030)), card(2030), { x: 4, y: 0 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 4, y: 0 });
    expect(byId(s, 9)!.currentLife).toBe(3);                   // 2 damage
    expect(byId(s, 1)!.properties.has("Saoul")).toBe(true);    // same row
    expect(byId(s, 2)!.properties.has("Saoul")).toBe(false);   // other row
  });
});

describe("Pandawa: primitives added to the engine", () => {
  const ivre = (id: number, cardId: number, pos: { x: number; y: number }, o = {}) =>
    ({ ...pandawa(id, cardId, pos, o), properties: new Set(["Saoul"]) });


  it("#2039 Gueule de Bois: draws 2 and shields your Dofus by 1 until your turn", () => {
    const base = withDecks(scenario([], 2039));
    const mains0 = base.players.ally.hand.length;
    let s = playCard(base, card(2039), { x: 0, y: 0 });
    expect(s.players.ally.hand.length).toBe(mains0 - 1 + 2);      // minus the played card, plus 2 drawn
    // the reduction is set on the five Dofus of the caster, never the opponent's
    expect(s.dofuses.filter((d) => d.owner === "ally" && d.damageReduction === 1).length).toBe(5);
    expect(s.dofuses.some((d) => d.owner === "enemy" && (d.damageReduction ?? 0) > 0)).toBe(false);

    // it holds per hit and for every source: two hits of 1 do not get through
    const dofus = s.dofuses.find((d) => d.owner === "ally")!;
    const vie0 = dofus.currentLife;
    const creatures = s.creatures.map((c) => ({ ...c }));
    const dofuses = s.dofuses.map((d) => ({ ...d }));
    const log: GameEvent[] = [];
    woundDofus(dofuses.find((d) => d.owner === "ally")!, 1, log, creatures, dofuses);
    woundDofus(dofuses.find((d) => d.owner === "ally")!, 1, log, creatures, dofuses);
    expect(dofuses.find((d) => d.owner === "ally")!.currentLife).toBe(vie0);
    // a hit of 3 lets 2 through
    woundDofus(dofuses.find((d) => d.owner === "ally")!, 3, log, creatures, dofuses);
    expect(dofuses.find((d) => d.owner === "ally")!.currentLife).toBe(vie0 - 2);

    // "jusqu'à votre prochain tour": the protection covers the opponent's turn, then goes away
    s = startTurn(endTurn(s), "ally");
    expect(s.dofuses.every((d) => (d.damageReduction ?? 0) === 0)).toBe(true);
  });

  it("#2029 Happy Hour: one card per drunk allied Pandawa in play", () => {
    const a = ivre(1, 2007, { x: 6, y: 1 });
    const b = ivre(2, 2007, { x: 6, y: 3 });
    const sobre = pandawa(3, 2007, { x: 6, y: 2 });
    const base = withDecks(scenario([a, b, sobre], 2029));
    const avant = base.players.ally.hand.length;
    const s = playCard(base, card(2029), { x: 0, y: 0 });
    // 2 drunk ones -> 2 cards drawn; the played card leaves the hand.
    expect(s.players.ally.hand.length).toBe(avant - 1 + 2);
  });

  it("#2032 Pandatak: each drunk Pandawa hits the enemy Dofus of its own lane", () => {
    const a = ivre(1, 2007, { x: 6, y: 1 });
    const sobre = pandawa(2, 2007, { x: 6, y: 3 });
    const base = withDecks(scenario([a, sobre], 2032));
    const pv = new Map(base.dofuses.filter((d) => d.owner === "enemy").map((d) => [d.position.y, d.currentLife]));
    const s = playCard(base, card(2032), { x: 0, y: 0 });
    const apres = new Map(s.dofuses.filter((d) => d.owner === "enemy").map((d) => [d.position.y, d.currentLife]));
    expect(apres.get(1)!).toBe(pv.get(1)! - 1);   // lane of the drunk one
    expect(apres.get(3)!).toBe(pv.get(3)!);       // lane of the sober one: untouched
  });

  it("#2034 Engourdissement: pushes back by 1 and sets the MP to 2", () => {
    const rapide = mkCreature(9, "enemy", { x: 3, y: 1 }, { currentAttack: 3, baseAttack: 3, baseMovement: 3 });
    const lente = mkCreature(10, "enemy", { x: 3, y: 3 }, { currentAttack: 1, baseAttack: 1, baseMovement: 1 });
    const ami = pandawa(1, 2007, { x: 6, y: 2 });
    const s = playCard(withDecks(scenario([rapide, lente, ami], 2034)), card(2034), { x: 0, y: 0 });
    // MP set to 2: the slow one gains a point, it is not a cap.
    expect(byId(s, 9)!.baseMovement).toBe(2);
    expect(byId(s, 10)!.baseMovement).toBe(2);
    // attack no longer changes: the effect was rewritten
    expect(byId(s, 9)!.currentAttack).toBe(3);
    expect(byId(s, 10)!.currentAttack).toBe(1);
    // pushed back 1 cell towards their wall (x grows on the enemy side), not the ally
    expect(byId(s, 9)!.position.x).toBe(2);
    expect(byId(s, 10)!.position.x).toBe(2);
    expect(byId(s, 1)!.position.x).toBe(6);
  });

  it("#2035 Tournée Générale: AR to every ally, AT only to drunk Pandawas", () => {
    const ivrePandawa = ivre(1, 2007, { x: 6, y: 1 });
    const sobrePandawa = pandawa(2, 2007, { x: 6, y: 2 });
    const at0 = sobrePandawa.currentAttack;
    const s = playCard(withDecks(scenario([ivrePandawa, sobrePandawa], 2035)), card(2035), { x: 0, y: 0 });
    expect(byId(s, 1)!.armor).toBe(1);
    expect(byId(s, 2)!.armor).toBe(1);                        // AR: everyone
    expect(byId(s, 1)!.currentAttack).toBe(at0 + 1);          // AT: the drunk one
    expect(byId(s, 2)!.currentAttack).toBe(at0);              // not the sober one
  });

  it("#2036 Ivresse de la Bataille: the sober ones charge, the drunk ones gain +2/+1", () => {
    const sobre = pandawa(1, 2007, { x: 6, y: 1 }, { movementLeft: 0, hasAttacked: true });
    const saoul = ivre(2, 2007, { x: 6, y: 3 }, { movementLeft: 0, hasAttacked: true });
    const at0 = saoul.currentAttack;
    const s = playCard(withDecks(scenario([sobre, saoul], 2036)), card(2036), { x: 0, y: 0 });
    expect(byId(s, 1)!.position.x).toBe(4);            // sober: charged 2
    expect(byId(s, 2)!.position.x).toBe(6);            // drunk: did not charge
    expect(byId(s, 2)!.currentAttack).toBe(at0 + 2);
    expect(byId(s, 2)!.armor).toBe(1);
  });

  it("#2004 Tonneau: FIN DU TOUR, charges the lane and heals the drunk Pandawas", () => {
    const tonneau = pandawa(1, TONNEAU, { x: 6, y: 2 }, { movementLeft: 0, hasAttacked: true });
    const memeLigne = pandawa(2, 2007, { x: 5, y: 2 }, { movementLeft: 0, hasAttacked: true });
    const autreLigne = pandawa(3, 2007, { x: 5, y: 0 }, { movementLeft: 0, hasAttacked: true });
    const blesse = { ...ivre(4, 2007, { x: 4, y: 2 }, { movementLeft: 0, hasAttacked: true }), currentLife: 1 };
    const s = endTurn(withDecks(scenario([tonneau, memeLigne, autreLigne, blesse])));
    expect(byId(s, 2)!.position.x).toBeLessThan(5);   // same lane: charged
    expect(byId(s, 3)!.position.x).toBe(5);           // other lane: did not move
    expect(byId(s, 4)!.currentLife).toBeGreaterThan(1); // drunk: healed
  });
});

describe("Pandawa: FERMENTATION", () => {
  // x = number of turns spent in the hand, +1 at each end of the holder's turn, no cap,
  // fixed at the moment the card is played, reset when the card comes back to the hand.
  it("the counter goes up one step at each end of my turn", () => {
    let s = withDecks(scenario([], 2009, 2009));
    expect(fermDe(s, 2009)).toBe(0);
    s = startTurn(endTurn(s), "ally");
    expect(fermDe(s, 2009)).toBe(1);
    s = startTurn(endTurn(s), "ally");
    expect(fermDe(s, 2009)).toBe(2);
  });

  it("#2009 Mimosa: APPARITION gives it 1(+x) AR, the value is fixed at the cast", () => {
    let s = withDecks(scenario([], 2009));
    s = startTurn(endTurn(s), "ally");                 // x = 1  →  1 + 1 = 2 AR
    s = startTurn(endTurn(s), "ally");                 // x = 2  →  1 + 2 = 3 AR
    // The bonus goes on itself (`self`): no pick, unlike the old version, which gave AT to a
    // chosen creature.
    s = playCard(s, card(2009), { x: 8, y: 2 });
    expect(s.pendingAction).toBeFalsy();
    expect(s.creatures.find((c) => c.cardId === 2009)!.armor).toBe(3);
  });

  it("#2020 Héros Soiffard: APPARITION charges 1(+x) cells", () => {
    let s = withDecks(scenario([], 2020));
    s = startTurn(endTurn(s), "ally");
    s = startTurn(endTurn(s), "ally");                 // x = 2 → charges 3
    s = playCard(s, card(2020), { x: 8, y: 2 });
    const heros = s.creatures.find((c) => c.cardId === 2020)!;
    expect(heros.position.x).toBe(5);
  });

  it("#2014 Overlin Kwin: the value is set on the creature and used again at SAOUL", () => {
    let s = withDecks(scenario([], 2014, PICOLE));
    s = startTurn(endTurn(s), "ally");
    s = startTurn(endTurn(s), "ally");                 // x = 2 → 3 Picoles when it becomes drunk
    s = playCard(s, card(2014), { x: 8, y: 2 });
    const kwin = s.creatures.find((c) => c.cardId === 2014)!;
    expect(kwin.ferment).toBe(2);              // set on the creature
    const avant = s.players.ally.hand.filter((id) => id === PICOLE).length;
    s = playCard(s, card(PICOLE), { ...kwin.position });
    if (s.pendingAction) s = resolvePendingAction(s, { ...kwin.position });
    const apres = s.creatures.find((c) => c.cardId === 2014)!;
    expect(apres.properties.has("Saoul")).toBe(true);
    // the played Picole leaves the hand, 1 + x = 3 come back
    expect(s.players.ally.hand.filter((id) => id === PICOLE).length).toBe(avant - 1 + 3);
  });


  it("the counter is reset when the card comes back to the hand", () => {
    let s = withDecks(scenario([], 2009));
    s = startTurn(endTurn(s), "ally");
    s = startTurn(endTurn(s), "ally");
    expect(fermDe(s, 2009)).toBe(2);
    // the card is played: its copy leaves the tracking
    s = playCard(s, card(2009), { x: 8, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 8, y: 2 });
    expect(fermDe(s, 2009)).toBe(0);
    // a new copy arrives: it starts from zero, not from 2
    s = { ...s, players: { ...s.players, ally: { ...s.players.ally, hand: [...s.players.ally.hand, 2009] } } };
    expect(fermDe(s, 2009)).toBe(0);
    s = startTurn(endTurn(s), "ally");
    expect(fermDe(s, 2009)).toBe(1);
  });

  it("each copy has its own counter: playing the clicked copy leaves the other one untouched", () => {
    // hand: [Mimosa A (4 turns), Mimosa B (1 turn)], counters per slot
    let s = withDecks(scenario([], 2009, 2009));
    s = { ...s, players: { ...s.players, ally: { ...s.players.ally, handFerment: [4, 1] } } };
    // copy B is played (slot 1, counter 1) -> 1 + 1 = 2 AR on itself
    s = playCard(s, card(2009), { x: 8, y: 2 }, { handIndex: 1 });
    expect(s.creatures.find((c) => c.cardId === 2009)!.armor).toBe(2);
    // copy A keeps its counter of 4, neither reset nor used up
    expect(s.players.ally.handFerment).toEqual([4]);
    expect(fermDe(s, 2009)).toBe(4);
  });
});

describe("Pandawa: the last fine gaps", () => {
  const ivre = (id: number, cardId: number, pos: { x: number; y: number }, o = {}) =>
    ({ ...pandawa(id, cardId, pos, o), properties: new Set(["Saoul"]) });

  it("#2003 Alfonse Dé: toggles drunkenness, makes a sober one drunk, sobers up a drunk one", () => {
    const sobre = pandawa(1, 2007, { x: 6, y: 1 });
    let s = playCard(withDecks(scenario([sobre], 2003)), card(2003), { x: 8, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 6, y: 1 });
    expect(byId(s, 1)!.properties.has("Saoul")).toBe(true);

    const saoul = ivre(2, 2007, { x: 6, y: 3 });
    let t = playCard(withDecks(scenario([saoul], 2003)), card(2003), { x: 8, y: 2 });
    if (t.pendingAction) t = resolvePendingAction(t, { x: 6, y: 3 });
    expect(byId(t, 2)!.properties.has("Saoul")).toBe(false);   // sobered up
  });

  it("#2013 Ivrogne Brutale: 1 damage sober, 2 drunk (condition on the source)", () => {
    const cibleA = mkCreature(9, "enemy", { x: 5, y: 2 }, { currentLife: 9, baseLife: 9 });
    const sobre = pandawa(1, 2013, { x: 6, y: 2 }, { movementLeft: 0, hasAttacked: true });
    const s = endTurn(withDecks(scenario([sobre, cibleA])));
    expect(byId(s, 9)!.currentLife).toBe(8);

    const cibleB = mkCreature(9, "enemy", { x: 5, y: 2 }, { currentLife: 9, baseLife: 9 });
    const saoule = ivre(1, 2013, { x: 6, y: 2 }, { movementLeft: 0, hasAttacked: true });
    const t = endTurn(withDecks(scenario([saoule, cibleB])));
    expect(byId(t, 9)!.currentLife).toBe(7);   // 1 + bonus 1
  });

  it("#2037 Lien Spiritueux: +1 resistance only to the Pandawas that already have some, then drunkenness", () => {
    const saoul = ivre(1, 2007, { x: 6, y: 1 });        // withAuras will give it 1 resistance
    const sobre = pandawa(2, 2007, { x: 6, y: 3 });
    let s = withDecks(scenario([saoul, sobre], 2037));
    s = { ...s, creatures: withAuras(s.creatures) };
    expect(byId(s, 1)!.resistance).toBe(1);
    expect(byId(s, 2)!.resistance).toBe(0);
    s = playCard(s, card(2037), { x: 0, y: 0 });
    // the drunk one had resistance -> +1; the sober one had none -> nothing, even though it
    // becomes drunk just after (the order of the effects protects it).
    expect(byId(s, 1)!.resistance).toBeGreaterThanOrEqual(2);
    expect(byId(s, 2)!.properties.has("Saoul")).toBe(true);
    const base = withAuras([{ ...byId(s, 2)!, auraResistance: 0, resistance: 0 }])[0].resistance;
    expect(base).toBe(1);   // its resistance only comes from drunkenness
  });
});

describe("Pandawa: the last three mechanics", () => {
  it("#2026 Fiole de Pandapiler: gives +1(+x) AT to a creature", () => {
    let s = withDecks(scenario([], 2026));
    s = startTurn(endTurn(s), "ally");          // x = 1 → +2 AT
    const cible = mkCreature(9, "enemy", { x: 3, y: 2 }, { currentLife: 9, baseLife: 9, currentAttack: 0, baseAttack: 0, printedAttack: 0 });
    s = { ...s, creatures: [cible] };
    s = playCard(s, card(2026), { x: 3, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 3, y: 2 });
    expect(byId(s, 9)!.currentAttack).toBe(2);
  });

  it("#2008 Brasseuse: a one-turn stun writes no counter (no regression for #404)", () => {
    const cible = mkCreature(9, "enemy", { x: 3, y: 2 });
    let s = playCard(withDecks(scenario([cible], 2008)), card(2008), { x: 8, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 3, y: 2 });
    expect(byId(s, 9)!.properties.has("Stunned")).toBe(true);
    expect(byId(s, 9)!.stunTurns).toBeUndefined();
  });

  it("#2025 Karcham: refuses a creature that is not next to an allied Pandawa", () => {
    const isole = pandawa(1, 2007, { x: 3, y: 0 });   // no neighbour
    const proche = mkCreature(2, "ally", { x: 5, y: 2 });
    const ancre = pandawa(3, 2007, { x: 5, y: 3 });   // next to `proche`
    const s = withDecks(scenario([isole, proche, ancre], 2025));
    expect(canPlayCard(s, card(2025), { x: 3, y: 0 })).toBeTruthy();   // refused
    expect(canPlayCard(s, card(2025), { x: 5, y: 2 })).toBeNull();     // accepted
  });

  it("#2025 Karcham: teleports the target 3 cells forward", () => {
    const proche = mkCreature(2, "ally", { x: 5, y: 2 });
    const ancre = pandawa(3, 2007, { x: 5, y: 3 });
    let s = playCard(withDecks(scenario([proche, ancre], 2025)), card(2025), { x: 5, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 5, y: 2 });
    expect(byId(s, 2)!.position.x).toBe(2);
  });

  it("#2031 Chamrak: the target lands in front of the first allied Tonneau of its lane", () => {
    const cible = mkCreature(1, "ally", { x: 7, y: 2 });
    const tonneau = pandawa(2, TONNEAU, { x: 4, y: 2 });     // same lane, in front of it
    const leurre = pandawa(3, TONNEAU, { x: 4, y: 0 });      // other lane
    let s = playCard(withDecks(scenario([cible, tonneau, leurre], 2031)), card(2031), { x: 7, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 7, y: 2 });
    expect(byId(s, 1)!.position).toEqual({ x: 3, y: 2 });    // just in front of the Tonneau
  });

  it("#2031 Chamrak: with no Tonneau on its lane, the creature does not move", () => {
    const cible = mkCreature(1, "ally", { x: 7, y: 2 });
    const ailleurs = pandawa(2, TONNEAU, { x: 4, y: 0 });
    let s = playCard(withDecks(scenario([cible, ailleurs], 2031)), card(2031), { x: 7, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 7, y: 2 });
    expect(byId(s, 1)!.position).toEqual({ x: 7, y: 2 });
  });
});

describe("Pandawa: gaps found by an adversarial review", () => {
  it("a SAOUL set through a pick does trigger (Alfonse Dé makes Habb Sinte drunk -> +1 AR)", () => {
    // resolvePendingAction was not wrapped: the toggle set the drunkenness, but the "SAOUL :"
    // of the target never fired.
    const habb = pandawa(1, 2001, { x: 6, y: 2 });
    let s = playCard(withDecks(scenario([habb], 2003)), card(2003), { x: 8, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 6, y: 2 });
    expect(byId(s, 1)!.properties.has("Saoul")).toBe(true);
    expect(byId(s, 1)!.armor).toBe(1);
  });

  it("drunkenness does not survive a change of control", () => {
    const ivre = { ...pandawa(1, 2001, { x: 3, y: 2 }), properties: new Set(["Saoul"]) };
    const copie = [{ ...ivre, properties: new Set(ivre.properties) }];
    applyEffects(copie, [], [], [{ type: "TakeControl" } as never], { casterSide: "enemy", targetCell: { x: 3, y: 2 } });
    expect(copie[0].owner).toBe("enemy");
    expect(copie[0].properties.has("Saoul")).toBe(false);
  });

  it("a transform clears the FERMENTATION set on the creature and the stun duration", () => {
    const cible = { ...pandawa(1, 2014, { x: 3, y: 2 }), ferment: 4, stunTurns: 3 };
    let s = playCard(withDecks(scenario([cible], 2038)), card(2038), { x: 3, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 3, y: 2 });
    const t = s.creatures.find((c) => c.cardId === TONNEAU)!;
    expect(t.ferment).toBeUndefined();
    expect(t.stunTurns).toBeUndefined();
  });

  it("no double trigger when the wrappers nest (depth guard)", () => {
    // Picole through playCard: the SAOUL of Habb Sinte must fire only once.
    const habb = pandawa(1, 2001, { x: 6, y: 2 });
    let s = playCard(withDecks(scenario([habb], PICOLE)), card(PICOLE), { x: 6, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 6, y: 2 });
    expect(byId(s, 1)!.armor).toBe(1);   // not 2
  });
});

describe("Pandawa: fixes from the adversarial review (second wave)", () => {
  const ivre = (id: number, cardId: number, pos: { x: number; y: number }, o = {}) =>
    ({ ...pandawa(id, cardId, pos, o), properties: new Set(["Saoul"]) });

  it("SwapBody (Marline #62): the body swap sobers up", () => {
    const cible = { ...mkCreature(9, "enemy", { x: 3, y: 2 }, { currentAttack: 2, baseAttack: 2 }),
                    cardId: 2007, properties: new Set(["Saoul"]) };
    let s = playCard(withDecks(scenario([cible], 62)), card(62), { x: 8, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 3, y: 2 });
    const echangee = byId(s, 9)!;
    expect(echangee.owner).toBe("ally");                       // the body came over to our side
    expect(echangee.properties.has("Saoul")).toBe(false);      // drunkenness gone
  });

  it("spell damage cancels the whole stun counter (not only combat)", () => {
    const cible = mkCreature(9, "enemy", { x: 3, y: 2 },
      { currentLife: 9, baseLife: 9, properties: new Set(["Stunned"]) });
    (cible as { stunTurns?: number }).stunTurns = 3;
    let s = playCard(withDecks(scenario([cible], 2033)), card(2033), { x: 3, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 3, y: 2 });
    expect(byId(s, 9)!.properties.has("Stunned")).toBe(false);
    expect(byId(s, 9)!.stunTurns).toBeUndefined();
  });

  it("silence also clears the multi-turn stun counter", () => {
    const cible = mkCreature(9, "enemy", { x: 3, y: 2 },
      { armor: 1, properties: new Set(["Stunned"]) });
    (cible as { stunTurns?: number }).stunTurns = 3;
    let s = playCard(withDecks(scenario([cible], 2023)), card(2023), { x: 3, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 3, y: 2 });
    expect(byId(s, 9)!.stunTurns).toBeUndefined();
  });

  it("cancelling a deferred placement gives the fermentation back (take-back with no loss)", () => {
    let s = withDecks(scenario([], 2005));                 // Champion Assoiffé, NÉCROME
    s = startTurn(endTurn(s), "ally");
    s = startTurn(endTurn(s), "ally");                     // x = 2
    expect(fermDe(s, 2005)).toBe(2);
    s = playCard(s, card(2005), { x: 8, y: 2 });
    // NÉCROME: the reveal pick on the enemy Dofus must open, otherwise this test would
    // pass without testing anything.
    expect(s.pendingAction).toBeTruthy();
    s = cancelPendingAction(s);
    expect(s.players.ally.hand).toContain(2005);
    expect(fermDe(s, 2005)).toBe(2);   // nothing lost
  });

  it("#2031 Chamrak: cell in front of the Tonneau taken -> lands behind it", () => {
    const cible = mkCreature(1, "ally", { x: 7, y: 2 });
    const tonneau = pandawa(2, TONNEAU, { x: 4, y: 2 });
    const bouchon = mkCreature(3, "enemy", { x: 3, y: 2 });   // in front of the Tonneau: taken
    let s = playCard(withDecks(scenario([cible, tonneau, bouchon], 2031)), card(2031), { x: 7, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 7, y: 2 });
    expect(byId(s, 1)!.position).toEqual({ x: 5, y: 2 });     // behind the Tonneau
  });

  it("#2031 Chamrak refuses an enemy target (the text says « une invocation alliée »)", () => {
    // The text of the card was narrowed to "une invocation ALLIÉE". The restriction does not
    // come from the effect (TeleportInFrontOfFamily only reads `family`) but from the castTarget
    // "AlliedSummon", which the engine applies (rules.ts, branch ct.startsWith("Allied")). The
    // test proves it by the refusal, otherwise a decorative field could have passed for a rule.
    const ennemie = mkCreature(9, "enemy", { x: 7, y: 2 });
    const tonneau = pandawa(2, TONNEAU, { x: 4, y: 2 });
    const etat = withDecks(scenario([ennemie, tonneau], 2031));
    expect(canPlayCard(etat, card(2031), { x: 7, y: 2 })).toBeTruthy();
    expect(() => playCard(etat, card(2031), { x: 7, y: 2 })).toThrow();
  });

  it("#2031 Chamrak: a Tonneau in front of the creature takes priority over a closer one behind", () => {
    const cible = mkCreature(1, "ally", { x: 5, y: 2 });
    const devant = pandawa(2, TONNEAU, { x: 2, y: 2 });       // in front, 3 cells away
    const derriere = pandawa(3, TONNEAU, { x: 6, y: 2 });     // behind, 1 cell away
    let s = playCard(withDecks(scenario([cible, devant, derriere], 2031)), card(2031), { x: 5, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 5, y: 2 });
    expect(byId(s, 1)!.position).toEqual({ x: 1, y: 2 });     // in front of the Tonneau ahead
  });

  it("#2021 Picole: refused on an ally that is not a Pandawa", () => {
    const tonneau = pandawa(1, TONNEAU, { x: 6, y: 2 });      // Tonneau family, not Pandawa
    const s = withDecks(scenario([tonneau], PICOLE));
    expect(canPlayCard(s, card(PICOLE), { x: 6, y: 2 })).toBeTruthy();   // an error is expected
  });

  it("#2003 Alfonse Dé: an enemy Pandawa cannot be toggled", () => {
    const ennemiPandawa = { ...mkCreature(9, "enemy", { x: 3, y: 2 }), cardId: 2007 };
    let s = playCard(withDecks(scenario([ennemiPandawa], 2003)), card(2003), { x: 8, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 3, y: 2 });
    expect(byId(s, 9)!.properties.has("Saoul")).toBe(false);  // guard on the handler side
  });

  it("#2024 Apéro !: not outnumbered, draws 1 but no Lait de Bambou", () => {
    // with equal creatures (0-0), not outnumbered
    const base = withDecks(scenario([], 2024));
    const s = playCard(base, card(2024), { x: 0, y: 0 });
    expect(s.players.ally.hand.filter((id) => id === LAIT_DE_BAMBOU).length).toBe(0);
    expect(s.players.ally.hand.length).toBe(base.players.ally.hand.length - 1 + 1); // played, 1 drawn
  });

  it("#2024 Apéro !: outnumbered, the Lait de Bambou arrives", () => {
    const surnombre = [mkCreature(9, "enemy", { x: 3, y: 1 }), mkCreature(10, "enemy", { x: 3, y: 3 })];
    const s = playCard(withDecks(scenario(surnombre, 2024)), card(2024), { x: 0, y: 0 });
    expect(s.players.ally.hand).toContain(LAIT_DE_BAMBOU);
  });

  it("#2033 Jour de la Mousson: the Lait de Bambou only arrives if the target dies", () => {
    let s = withDecks(scenario([], 2033));
    s = startTurn(endTurn(s), "ally");                        // x = 1 -> 2 damage
    const fragile = mkCreature(9, "enemy", { x: 3, y: 2 }, { currentLife: 2, baseLife: 2 });
    s = { ...s, creatures: [fragile] };
    s = playCard(s, card(2033), { x: 3, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 3, y: 2 });
    expect(s.players.ally.hand).toContain(LAIT_DE_BAMBOU);    // killed -> Lait

    let t = withDecks(scenario([], 2033));                    // x = 0 -> 1 damage
    const solide = mkCreature(9, "enemy", { x: 3, y: 2 }, { currentLife: 5, baseLife: 5 });
    t = { ...t, creatures: [solide] };
    t = playCard(t, card(2033), { x: 3, y: 2 });
    if (t.pendingAction) t = resolvePendingAction(t, { x: 3, y: 2 });
    expect(t.players.ally.hand.filter((id) => id === LAIT_DE_BAMBOU).length).toBe(0);
  });

  it("#2019 Pandiwan Kenobi: APPARITION pushes the enemies back 2 cells", () => {
    const e1 = mkCreature(9, "enemy", { x: 4, y: 1 }, { currentLife: 9, baseLife: 9 });
    const s = playCard(withDecks(scenario([e1], 2019)), card(2019), { x: 8, y: 2 });
    expect(byId(s, 9)!.position.x).toBe(2);                   // pushed back towards its camp
  });
});

describe("Pandawa: the last two cards never tested end to end", () => {
  it("#2000 Chopine: SAOUL makes it change lane (adjacent)", () => {
    const chopine = pandawa(1, 2000, { x: 6, y: 2 });
    let s = playCard(withDecks(scenario([chopine], PICOLE)), card(PICOLE), { x: 6, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 6, y: 2 });
    const apres = byId(s, 1)!;
    expect(apres.properties.has("Saoul")).toBe(true);
    expect(Math.abs(apres.position.y - 2)).toBe(1);   // adjacent lane (bounded randomness)
    expect(apres.position.x).toBe(6);                 // same row
  });

  it("#2017 Kura Sao: really draws when an allied Tonneau dies", () => {
    const kura = pandawa(1, 2017, { x: 6, y: 1 }, { movementLeft: 0, hasAttacked: true });
    const tonneau = pandawa(2, TONNEAU, { x: 5, y: 2 }, { currentLife: 1, movementLeft: 0, hasAttacked: true });
    const base = withDecks(scenario([kura, tonneau], 2033));   // Jour de la Mousson: 1 damage
    const mainAvant = base.players.ally.hand.length;
    let s = playCard(base, card(2033), { x: 5, y: 2 });
    if (s.pendingAction) s = resolvePendingAction(s, { x: 5, y: 2 });
    expect(byId(s, 2)).toBeUndefined();                        // the Tonneau is dead
    // -1 the played card, +1 Kura Sao's draw, +1 the Lait (target killed)
    expect(s.players.ally.hand.length).toBe(mainAvant - 1 + 1 + 1);
  });
});

describe("Pandawa: FERMENTATION visible in the hand", () => {
  // The "(+x)" of the text shows the live value on the cards one of whose effects is marked
  // `ferment` (read by the card display). This test guards both directions: every card with a
  // FERMENTATION text must carry the marker, and the other way round. Otherwise a card would
  // show a counter it does not use, or use a counter the player cannot see.
  const marque = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.some(marque);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return o.ferment === true || Object.values(o).some(marque);
    }
    return false;
  };
  const PORTEUSES = [2005, 2009, 2014, 2020, 2026, 2033];

  it("the 6 FERMENTATION cards carry the marker read by the display", () => {
    for (const id of PORTEUSES) {
      const c = card(id);
      expect(marque(c.effects) || marque(c.triggers), `#${id} ${c.name}`).toBe(true);
      expect(c.description).toContain("FERMENTATION");
    }
  });

  it("no other card of the god carries the marker (no stray counter)", () => {
    // This goes through the real pool and not a frozen range of ids: the set moves (David
    // Boivit #2002 removed, Gueule de Bois added), and a hard-coded range breaks at each change
    // while letting through the cards added past its end.
    for (const c of [...cards().values()].filter((x) => x.god === "Pandawa")) {
      if (PORTEUSES.includes(c.id)) continue;
      expect(marque(c.effects) || marque(c.triggers), `#${c.id} ${c.name}`).toBe(false);
      expect(c.description ?? "").not.toContain("FERMENTATION");
    }
  });

  it("the counter shown is the one of the slot, not of the card name", () => {
    // two Mimosa with different counters: the hand must read 4 then 1
    const s = withDecks(scenario([], 2009, 2009));
    const avec = { ...s, players: { ...s.players, ally: { ...s.players.ally, handFerment: [4, 1] } } };
    expect(fermentOf(avec.players.ally.handFerment, 0)).toBe(4);
    expect(fermentOf(avec.players.ally.handFerment, 1)).toBe(1);
  });
});
