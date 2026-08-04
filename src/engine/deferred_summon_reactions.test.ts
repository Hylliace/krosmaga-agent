import { describe, it, expect } from "vitest";
import { card, mkCreature, scenario } from "./testkit";
import { playCard, resolvePendingAction, cancelPendingAction } from "./rules";

// Regression: a creature with a targeted APPARITION is kept off the board until its
// targeting pick is resolved, so it is not "posée" at the placement click. Reactions
// of creatures already on the board (ON_PLAY draws like Piou aux Œufs d'Or #446;
// ENTERS_PLAY buffs/strikes like Welsh #278 / Julith Jurgen #432) must therefore only
// fire when it actually lands, never at the placement click.
describe("Deferred targeted-APPARITION summon does not fire on-board reactors at placement-click", () => {
  const buffTarget = () => mkCreature(2, "ally", { x: 6, y: 2 }, { currentAttack: 2, baseAttack: 2 }); // Tomla Klass #72 buffs it

  it("ON_PLAY: Piou aux Œufs d'Or #446 draws only on landing, not at placement-click", () => {
    card(72); card(446);
    const piou = mkCreature(700, "ally", { x: 6, y: 1 }, { cardId: 446, triggers: card(446).triggers ?? [] });
    const sc = scenario([piou, buffTarget()]);
    const base = {
      ...sc, prisms: [], butins: [], seeds: [],
      players: { ...sc.players, ally: { ...sc.players.ally, hand: [72], handCostMods: [0], deck: [9999, 9998], ap: 10, maxAp: 10 } },
    };

    let s = playCard(base, card(72), { x: 8, y: 1 });
    expect(s.pendingAction).not.toBeNull();
    expect(s.creatures.some((c) => c.cardId === 72)).toBe(false);
    expect(s.players.ally.hand.length).toBe(0); // no premature Piou draw

    s = resolvePendingAction(s, { x: 6, y: 2 });
    expect(s.creatures.some((c) => c.cardId === 72)).toBe(true);
    expect(s.players.ally.hand.length).toBe(1); // drew exactly once, on landing
  });

  it("ON_PLAY: cancelling the placement (click off-board) fires no reaction at all", () => {
    card(72); card(446);
    const piou = mkCreature(700, "ally", { x: 6, y: 1 }, { cardId: 446, triggers: card(446).triggers ?? [] });
    const sc = scenario([piou, buffTarget()]);
    const base = {
      ...sc, prisms: [], butins: [], seeds: [],
      players: { ...sc.players, ally: { ...sc.players.ally, hand: [72], handCostMods: [0], deck: [9999, 9998], ap: 10, maxAp: 10 } },
    };
    let s = playCard(base, card(72), { x: 8, y: 1 });
    s = cancelPendingAction(s); // click off the board → whole play reverts
    expect(s.creatures.some((c) => c.cardId === 72)).toBe(false);
    expect(s.players.ally.hand).toContain(72); // card back in hand
    expect(s.players.ally.hand.length).toBe(1); // Only Tomla, Piou never drew
  });

  it("ENTERS_PLAY: enemy Welsh #278 reacts only on landing, not at placement-click", () => {
    card(72); card(278);
    const welsh = mkCreature(700, "enemy", { x: 3, y: 2 }, { cardId: 278, currentAttack: 2, baseAttack: 2, armor: 0, triggers: card(278).triggers ?? [] });
    const sc = scenario([welsh, buffTarget()]);
    const base = { ...sc, prisms: [], players: { ...sc.players, ally: { ...sc.players.ally, hand: [72], handCostMods: [0], ap: 10, maxAp: 10 } } };

    let s = playCard(base, card(72), { x: 8, y: 1 });
    expect(s.pendingAction).not.toBeNull();
    const before = s.creatures.find((c) => c.instanceId === 700)!;
    expect(before.currentAttack).toBe(2); // Welsh has not reacted yet
    expect(before.armor).toBe(0);

    s = resolvePendingAction(s, { x: 6, y: 2 });
    const after = s.creatures.find((c) => c.instanceId === 700)!;
    expect(after.currentAttack).toBe(3); // +1 once, on landing
    expect(after.armor).toBe(1);
  });
});
