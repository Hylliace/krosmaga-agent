// Likelihood of the opponent's last turn and resampling of the worlds.
import { describe, it, expect } from "vitest";
import { scenario, cards } from "../../engine/testkit";
import { Rng } from "../../engine/rng";
import type { GameState } from "../../engine/state";
import { vraisemblanceDernierTour, mondesInferes, INFERENCE_DEFAUT } from "./inferenceAdverse";

const POISCAILLE = 95; // creature with no effect, 4 AP
const DRAGON_COCHON = 449; // creature with no effect, 5 AP

/** The opponent (enemy) ended its turn with `ap` AP and the hand `hand`. */
function apresTourAdverse(hand: number[], ap: number): GameState {
  cards();
  const s = scenario([]);
  return { ...s, players: { ...s.players, enemy: { ...s.players.enemy, hand, handCostMods: hand.map(() => 0), ap } } };
}

describe("likelihood of the opponent's last turn", () => {
  it("no AP left: no information", () => {
    expect(vraisemblanceDernierTour(apresTourAdverse([POISCAILLE], 0), "ally")).toBe(1);
  });

  it("a playable creature kept with the AP left: the hand is less likely", () => {
    expect(vraisemblanceDernierTour(apresTourAdverse([POISCAILLE], 5), "ally")).toBeCloseTo(INFERENCE_DEFAUT.tenueInvocation);
  });

  it("two copies kept: the penalty adds up", () => {
    const t = INFERENCE_DEFAUT.tenueInvocation;
    expect(vraisemblanceDernierTour(apresTourAdverse([POISCAILLE, POISCAILLE], 5), "ally")).toBeCloseTo(t * t);
  });

  it("a card too expensive for the AP left: no penalty", () => {
    expect(vraisemblanceDernierTour(apresTourAdverse([DRAGON_COCHON], 4), "ally")).toBe(1);
  });
});

describe("resampling of the worlds", () => {
  it("returns exactly n worlds and favours the likely hands", () => {
    // Half of the candidates with a playable creature kept, half without.
    let i = 0;
    const tirer = () => apresTourAdverse(i++ % 2 === 0 ? [POISCAILLE] : [DRAGON_COCHON], 4);
    // With 4 AP left, Poiscaille (4) was playable, Dragon Cochon (5) was not.
    const mondes = mondesInferes(200, tirer, "ally", new Rng(7), { ...INFERENCE_DEFAUT, candidats: 4 });
    expect(mondes).toHaveLength(200);
    const avecPoiscaille = mondes.filter((w) => w.players.enemy.hand.includes(POISCAILLE)).length;
    // Weight 0.35 against 1: about 0.35 / 1.35 = 26% of the worlds kept.
    expect(avecPoiscaille / 200).toBeGreaterThan(0.18);
    expect(avecPoiscaille / 200).toBeLessThan(0.34);
  });

  it("all weights equal: the candidates are taken without bias", () => {
    let i = 0;
    const tirer = () => apresTourAdverse(i++ % 2 === 0 ? [POISCAILLE] : [DRAGON_COCHON], 0);
    const mondes = mondesInferes(100, tirer, "ally", new Rng(3), { ...INFERENCE_DEFAUT, candidats: 2 });
    const avecPoiscaille = mondes.filter((w) => w.players.enemy.hand.includes(POISCAILLE)).length;
    // An unbiased draw: around half (binomial n = 100, p = 0.5).
    expect(avecPoiscaille).toBeGreaterThan(35);
    expect(avecPoiscaille).toBeLessThan(65);
  });
});
