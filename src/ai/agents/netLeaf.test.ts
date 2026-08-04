// The leaf convention checks. Three guarantees:
//   1. Perspective: the net always gets the probe from actingSide(probe)'s view (the receiver, as in
//      the training data), and the value is sign-flipped back to rootSide's convention.
//   2. Pending settle + tripwire: a pending opened by the probe is settled before encoding; states
//      that cannot be settled throw instead of scoring garbage.
//   3. Search: with a net leaf, the MCTS never evaluates a pending state; it goes down through the
//      pick targets and scores the resolved child.
import { describe, it, expect, beforeAll } from "vitest";
import { cards, mkCreature, scenario } from "../../engine/testkit";
import { Rng } from "../../engine/rng";
import { actingSide, applyAction } from "../actions";
import type { GameState } from "../../engine/state";
import { MctsAgent, type LeafEval } from "./MctsAgent";
import { netLeafEvalFactory, settleProbePendings } from "./netLeaf";
import { buildCardIndex2, encodingLength2, N_PLANES2, GLOBALS2 } from "../encode2";
import type { TsValueModel } from "../net/TsValueModel";

let cardIndex: Map<number, number>;

beforeAll(() => {
  cards();
  cardIndex = buildCardIndex2([...cards().keys()]);
});

// A stub "model" that records every encoding it is fed and reports, via
// my_is_first, which side the encoding was taken from (firstSide is "ally" in
// scenario(), so my_is_first=1 ⇔ encoded from ally's perspective).
function stubModel(onEncode?: (fromAlly: boolean) => void, value = 0.8): TsValueModel {
  const isFirstIdx = N_PLANES2 * 50 + GLOBALS2.indexOf("my_is_first");
  return {
    encLen: encodingLength2(cardIndex),
    value(x: ArrayLike<number>) {
      onEncode?.(x[isFirstIdx] === 1);
      return value;
    },
  } as unknown as TsValueModel;
}

function midTurnState(): GameState {
  const me = mkCreature(1, "ally", { x: 7, y: 2 }, { currentAttack: 2, currentLife: 4, movementLeft: 2 });
  const foe = mkCreature(2, "enemy", { x: 2, y: 2 }, { currentAttack: 2, currentLife: 4 });
  const s = scenario([me, foe]);
  // Mid-turn: AP already spent, a case the net never saw in training.
  return { ...s, firstSide: "ally", players: { ...s.players, ally: { ...s.players.ally, ap: 2, maxAp: 6 } } };
}

describe("netLeaf leaf convention", () => {
  it("encodes the probe from the RECEIVER's perspective and sign-flips back to rootSide", () => {
    const seen: boolean[] = [];
    const makeLeaf = netLeafEvalFactory(stubModel((fromAlly) => seen.push(fromAlly)), cardIndex);
    const state = midTurnState();
    const leaf = makeLeaf(state, "ally");

    // Probe of my mid-turn state = I end my turn → receiver is the enemy.
    const probe1 = applyAction(state, { kind: "endTurn" });
    expect(actingSide(probe1)).toBe("enemy");
    const v1 = leaf(probe1, "ally");
    expect(seen.pop()).toBe(false); // encoded from ENEMY's view (receiver)…
    expect(v1).toBeCloseTo(-0.8, 6); // …and flipped back to rootSide=ally

    // One more endTurn → back to me fresh: no flip.
    const probe2 = applyAction(probe1, { kind: "endTurn" });
    expect(actingSide(probe2)).toBe("ally");
    const v2 = leaf(probe2, "ally");
    expect(seen.pop()).toBe(true); // encoded from ALLY's view
    expect(v2).toBeCloseTo(0.8, 6);
  });

  it("value2-style flow: 'the encoded side wins' is invariant under the flip", () => {
    // A model that always says "ally wins" regardless of perspective must yield
    // +1-ish for rootSide=ally from both probe parities.
    const isFirstIdx = N_PLANES2 * 50 + GLOBALS2.indexOf("my_is_first");
    const model = {
      encLen: encodingLength2(cardIndex),
      value: (x: ArrayLike<number>) => (x[isFirstIdx] === 1 ? 0.7 : -0.7),
    } as unknown as TsValueModel;
    const state = midTurnState();
    const leaf = netLeafEvalFactory(model, cardIndex)(state, "ally");
    const probe1 = applyAction(state, { kind: "endTurn" }); // receiver enemy
    const probe2 = applyAction(probe1, { kind: "endTurn" }); // receiver ally
    expect(leaf(probe1, "ally")).toBeCloseTo(0.7, 6);
    expect(leaf(probe2, "ally")).toBeCloseTo(0.7, 6);
  });

  it("settles a pending pick deterministically before encoding (no pending ever reaches the net)", () => {
    const s = midTurnState();
    const pendingState: GameState = {
      ...s,
      pendingAction: {
        side: "ally",
        prompt: "test pick",
        filter: "ally_creature",
        pendingEffects: [],
        sourceInstanceId: 999,
      },
    };
    const settled = settleProbePendings(pendingState);
    expect(settled).not.toBeNull();
    expect(settled!.pendingAction).toBeNull();

    let calls = 0;
    const leaf = netLeafEvalFactory(stubModel(() => calls++), cardIndex)(s, "ally");
    expect(() => leaf(pendingState, "ally")).not.toThrow();
    expect(calls).toBe(1);
  });

  it("an optional pick with zero valid targets settles by declining in-board (arena crash, Lame Émoussée)", () => {
    // Only an ally on the board → an enemy-creature filter has no valid target. The off-board cancel does
    // nothing for plain optionals, so the settle must resolve on a non-target cell (the engine's own
    // decline path).
    const s = midTurnState();
    const noTargetOptional: GameState = {
      ...s,
      creatures: s.creatures.filter((c) => c.owner === "ally"),
      pendingAction: {
        side: "ally",
        prompt: "frapper une invocation adverse (optionnel)",
        filter: "enemy_creature",
        optional: true,
        pendingEffects: [],
        sourceInstanceId: 999,
      },
    };
    const settled = settleProbePendings(noTargetOptional);
    expect(settled).not.toBeNull();
    expect(settled!.pendingAction).toBeNull();

    // Same pick but NON-optional: no target and no decline = an engine DEAD-END
    // (a live game would soft-lock). The search reaches those on hypothetical
    // lines, so the leaf must not crash: settle reports null and the eval falls
    // back to the heuristic (net never called).
    const noTargetMandatory: GameState = {
      ...noTargetOptional,
      pendingAction: { ...noTargetOptional.pendingAction!, optional: undefined },
    };
    expect(settleProbePendings(noTargetMandatory)).toBeNull();
    let netCalls = 0;
    const leaf = netLeafEvalFactory(stubModel(() => netCalls++), cardIndex)(noTargetMandatory, "ally");
    const v = leaf(noTargetMandatory, "ally");
    expect(Number.isFinite(v)).toBe(true);
    expect(Math.abs(v)).toBeLessThanOrEqual(1);
    expect(netCalls).toBe(0);
  });

  it("Tripwire: an un-settleable out-of-distribution state throws instead of scoring", () => {
    const s = midTurnState();
    const mulliganState: GameState = { ...s, mulligan: { current: "ally", first: "ally", second: "enemy" } };
    const leaf = netLeafEvalFactory(stubModel(), cardIndex)(s, "ally");
    expect(() => leaf(mulliganState, "ally")).toThrow(/tripwire/);
  });
});

describe("MctsAgent + net leaf, pendings are searched, never scored", () => {
  it("with a net-style leafEval, every scored probe is pending-free", () => {
    const a = mkCreature(1, "ally", { x: 7, y: 1 }, { currentAttack: 2, currentLife: 3 });
    const b = mkCreature(2, "ally", { x: 6, y: 3 }, { currentAttack: 1, currentLife: 2 });
    const foe = mkCreature(3, "enemy", { x: 2, y: 2 }, { currentAttack: 2, currentLife: 4 });
    const s = scenario([a, b, foe]);
    const root: GameState = {
      ...s,
      pendingAction: {
        side: "ally",
        prompt: "pick an ally",
        filter: "ally_creature",
        pendingEffects: [],
        sourceInstanceId: 999,
      },
    };
    let sawPending = 0;
    let calls = 0;
    const leafEval: LeafEval = (probe) => {
      calls++;
      if (probe.pendingAction) sawPending++;
      return 0.1;
    };
    const agent = new MctsAgent({ simulations: 24, maxBranch: 8, leafEval });
    const stats = agent.searchRootStats(root, new Rng(7));
    expect(calls).toBeGreaterThan(0);
    expect(sawPending).toBe(0);
    // The root children are the pick's resolve targets (the pick is searched).
    expect(stats.length).toBeGreaterThan(1);
  });
});
