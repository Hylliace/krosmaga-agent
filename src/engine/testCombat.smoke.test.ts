// Smoke test for the dev "Test Combat" board builder: prove that a hand-crafted
// setup builds a valid GameState, that devPlaceCreature is faithful, that the mal
// d'invocation toggle governs the end-of-turn advance, and that endTurn resolves
// on the built state without throwing.
import { describe, it, expect } from "vitest";
import { cards } from "./testkit";
import { endTurn } from "./rules";
import { buildTestState, type TestSetup } from "./testCombat";

const pool = () => cards();
const getCard = (id: number) => pool().get(id);

// A plain melee creature: has movement + life, no shooter range, no innate
// keyword property or conditional/statue effect that would stop it advancing.
function vanillaMover() {
  for (const c of pool().values()) {
    if (c.cardType !== "Summon") continue;
    if ((c.movement ?? 0) < 1 || (c.life ?? 0) < 1) continue;
    if (c.properties && c.properties.length) continue;
    if (c.effects.some((e) =>
      e.type === "ShooterRangeData" || e.type === "SetPropertyData" ||
      e.type === "ConditionalFirstStrike" || e.type === "WoundedProperty")) continue;
    return c;
  }
  throw new Error("no vanilla mover in pool");
}

const filler = () => [...pool().keys()].slice(0, 40);

describe("Test Combat board builder", () => {
  it("places a creature faithfully (stats from the card, ready when not sick)", () => {
    const card = vanillaMover();
    const setup: TestSetup = {
      creatures: [{ cardId: card.id, owner: "ally", cell: { x: 5, y: 2 }, sick: false }],
      objects: [],
      activeSide: "ally",
    };
    const s = buildTestState(setup, getCard, filler());
    const c = s.creatures.find((x) => x.cardId === card.id)!;
    expect(c).toBeTruthy();
    expect(c.currentLife).toBe(card.life);
    expect(c.currentAttack).toBe(card.attack);
    // sick:false ⇒ ready to act.
    expect(c.hasAttacked).toBe(false);
    expect(c.movementLeft).toBe(c.baseMovement);
  });

  it("honours PV / property overrides", () => {
    const card = vanillaMover();
    const setup: TestSetup = {
      creatures: [{
        cardId: card.id, owner: "enemy", cell: { x: 2, y: 1 }, sick: true,
        overrides: { life: 3, armor: 2 }, properties: ["Shield"],
      }],
      objects: [],
      activeSide: "ally",
    };
    const s = buildTestState(setup, getCard, filler());
    const c = s.creatures.find((x) => x.cardId === card.id)!;
    expect(c.currentLife).toBe(3);
    expect(c.armor).toBe(2);
    expect(c.properties.has("Shield")).toBe(true);
    expect(c.owner).toBe("enemy");
  });

  it("a NON-sick creature advances on the resolution", () => {
    const card = vanillaMover();
    const setup: TestSetup = {
      creatures: [{ cardId: card.id, owner: "ally", cell: { x: 5, y: 2 }, sick: false }],
      objects: [],
      activeSide: "ally",
    };
    const s = buildTestState(setup, getCard, filler());
    const before = s.creatures.find((x) => x.cardId === card.id)!.position.x;
    const after = endTurn(s);
    const moved = after.creatures.find((x) => x.cardId === card.id);
    expect(moved).toBeTruthy();
    expect(moved!.position.x).not.toBe(before);
  });

  it("a sick creature does not advance on the resolution", () => {
    const card = vanillaMover();
    const setup: TestSetup = {
      creatures: [{ cardId: card.id, owner: "ally", cell: { x: 5, y: 2 }, sick: true }],
      objects: [],
      activeSide: "ally",
    };
    const s = buildTestState(setup, getCard, filler());
    const c0 = s.creatures.find((x) => x.cardId === card.id)!;
    expect(c0.movementLeft).toBe(card.movement ?? 0); // keeps PM, sickness is hasAttacked, not 0 PM
    expect(c0.hasAttacked).toBe(true);
    const after = endTurn(s);
    const c1 = after.creatures.find((x) => x.cardId === card.id)!;
    expect(c1.position.x).toBe(5); // stayed put (mal d'invocation, enforced by hasAttacked)
  });

  it("places ground objects and does not fatigue a Dofus on resolution", () => {
    const card = vanillaMover();
    const dofusBefore = buildTestState(
      { creatures: [], objects: [], activeSide: "ally" }, getCard, filler(),
    ).dofuses.reduce((n, d) => n + d.currentLife, 0);
    const setup: TestSetup = {
      creatures: [{ cardId: card.id, owner: "ally", cell: { x: 5, y: 2 }, sick: false }],
      objects: [
        { type: "seed", owner: "ally", cell: { x: 6, y: 0 } },
        { type: "prism", owner: "enemy", cell: { x: 3, y: 4 } },
      ],
      activeSide: "ally",
    };
    const s = buildTestState(setup, getCard, filler());
    expect((s.seeds ?? []).some((o) => o.position.x === 6 && o.position.y === 0)).toBe(true);
    expect(s.prisms.some((o) => o.position.x === 3 && o.position.y === 4)).toBe(true);
    // Filler decks ⇒ the start-of-turn draw never deck-outs, so no fatigue hits a Dofus.
    const after = endTurn(s);
    const dofusAfter = after.dofuses.reduce((n, d) => n + d.currentLife, 0);
    expect(dofusAfter).toBe(dofusBefore);
  });
});
