// AI rule 16 (bonus for a shooter facing an enemy) against the line-of-fire rule: if
// there is an ally between the shooter and the enemy, the shooter cannot see the
// enemy and cannot hit it.
//
// The engine applies this rule in fireShooterShot (rules.ts): it walks cell by cell
// in front of the shooter and stops at the first occupant, allies included. The AI
// used the closest enemy of the row in absolute distance, so it gave the bonus
// through an ally.
import { describe, it, expect } from "vitest";
import { cards, card, mkCreature, scenario } from "../engine/testkit";
import { oneStepHeuristicScore } from "./agents/MctsAgent";
import { EVAL_WEIGHTS } from "./eval";
import type { Action } from "./actions";

// #335 Lebolas: a plain shooter (range 1-3, AT 3, HP 2), no trigger and no effect
// besides its range, so the score only moves because of rule 16.
const LEBOLAS = 335;
const POSE = { x: 8, y: 2 } as const; // allied placement cell, same lane as the target

// Both compared states have exactly the same material: one ally and one enemy. Only
// the lane of the ally changes. Otherwise, adding a blocker would move the score for
// plain material reasons and the comparison would prove nothing.
const etat = (voieDuBloqueur: number) => {
  cards();
  const bloqueur = mkCreature(1, "ally", { x: 7, y: voieDuBloqueur }, {
    cardId: 9999, currentAttack: 1, baseAttack: 1, currentLife: 3, baseLife: 3,
  });
  // Target with 2 HP and no armour: Lebolas (AT 3) kills it in one hit, so the expected
  // bonus is shooterFacingKill, the bigger of the two.
  const cible = mkCreature(2, "enemy", { x: 5, y: 2 }, {
    cardId: 9999, currentAttack: 2, baseAttack: 2, currentLife: 2, baseLife: 2, armor: 0,
  });
  const s = scenario([bloqueur, cible], LEBOLAS);
  return { ...s, prisms: [], seeds: [], butins: [] };
};

const action: Action = { kind: "play", cardId: LEBOLAS, target: { ...POSE } };
const score = (voieDuBloqueur: number) => oneStepHeuristicScore(etat(voieDuBloqueur), action, "ally");

describe("IA regle 16 : le bonus de vis-a-vis respecte la ligne de tir", () => {
  it("ligne degagee : poser le tireur face a une cible qu'il tue vaut le bonus", () => {
    // The blocker is on lane 0, the target on lane 2: nothing between the shooter (8,2)
    // and the target (5,2), distance 3 = Lebolas's max range.
    expect(score(0)).toBeGreaterThan(score(2));
  });

  it("un ALLIE devant coupe la vue : le bonus tombe entierement", () => {
    // Same material, but the blocker moves to lane 2, at (7,2): the first occupant in
    // front of the shooter is an ally, so the line is blocked.
    const degagee = score(0);
    const bloquee = score(2);
    // The gap has to be about the size of the kill bonus, not a small positional
    // difference: the whole bonus is what disappears.
    expect(degagee - bloquee).toBeGreaterThan(EVAL_WEIGHTS.shooterFacingKill * 0.5);
  });

  it("la carte de reference est bien un tireur nu (garde-fou du montage)", () => {
    const c = card(LEBOLAS);
    const portee = (c.effects ?? []).find((e) => e.type === "ShooterRangeData") as
      | { RangeMax?: number }
      | undefined;
    expect(portee?.RangeMax).toBe(3);
    expect(c.triggers ?? []).toHaveLength(0);
    expect(c.attack).toBe(3);
  });
});
