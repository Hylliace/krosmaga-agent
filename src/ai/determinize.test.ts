import { describe, it, expect } from "vitest";
import { createInitialState, applyMulligan } from "../engine/rules";
import { Rng } from "../engine/rng";
import { determinize, resampleEnemyReals } from "./determinize";
import type { GameState } from "../engine/state";
import type { Side } from "../engine/board";

const deckA = Array.from({ length: 30 }, (_, i) => 100 + i);
const deckB = Array.from({ length: 30 }, (_, i) => 500 + i);

// A mid-game state (past the mulligan) with both hands + decks populated.
function midGame(): GameState {
  let s = createInitialState({ ally: deckA, enemy: deckB }, { seed: 1, shuffle: false });
  s = applyMulligan(s, s.mulligan!.current, []); // player 1 keeps
  s = applyMulligan(s, s.mulligan!.current, []); // player 2 keeps → turn 1
  return s;
}

const sortedDofusKinds = (s: GameState, side: "ally" | "enemy") =>
  s.dofuses
    .filter((d) => d.owner === side)
    .map((d) => `${d.position.x},${d.position.y}:${d.kind}`)
    .sort();

describe("determinize (information-fair world sampling)", () => {
  it("keeps my observable info: my hand, my deck composition, my Dofus kinds", () => {
    const s = midGame();
    const w = determinize(s, "ally", new Rng(42));
    // My hand is untouched.
    expect(w.players.ally.hand).toEqual(s.players.ally.hand);
    // My deck: same multiset (composition known), possibly reordered.
    expect([...w.players.ally.deck].sort()).toEqual([...s.players.ally.deck].sort());
    // My own Dofus' real/fake is known → unchanged.
    expect(sortedDofusKinds(w, "ally")).toEqual(sortedDofusKinds(s, "ally"));
  });

  it("re-samples the opponent's hand but keeps its size and total cards", () => {
    const s = midGame();
    const w = determinize(s, "ally", new Rng(7));
    expect(w.players.enemy.hand.length).toBe(s.players.enemy.hand.length);
    expect(w.players.enemy.handCostMods.length).toBe(w.players.enemy.hand.length);
    // The opponent's unseen multiset (hand + deck) is conserved, nothing
    // created or lost, just re-partitioned.
    const before = [...s.players.enemy.hand, ...s.players.enemy.deck].sort();
    const after = [...w.players.enemy.hand, ...w.players.enemy.deck].sort();
    expect(after).toEqual(before);
  });

  it("keeps exactly 3 real enemy Dofus among the undestroyed (no destructions yet)", () => {
    const s = midGame();
    const w = determinize(s, "ally", new Rng(99));
    const enemyReals = w.dofuses.filter((d) => d.owner === "enemy" && d.kind === "real").length;
    expect(enemyReals).toBe(3);
    expect(w.dofuses.filter((d) => d.owner === "enemy").length).toBe(5);
  });

  it("respects revealed Dofus: a destroyed enemy real stays real, and only 2 reals remain to place", () => {
    const s = midGame();
    // Destroy one enemy real Dofus (its nature is now revealed).
    const er = s.dofuses.find((d) => d.owner === "enemy" && d.kind === "real")!;
    const s2: GameState = { ...s, dofuses: s.dofuses.map((d) => (d === er ? { ...d, currentLife: 0 } : d)) };
    const w = determinize(s2, "ally", new Rng(5));
    // The destroyed one keeps its revealed kind.
    const destroyed = w.dofuses.find((d) => d.position.x === er.position.x && d.position.y === er.position.y)!;
    expect(destroyed.kind).toBe("real");
    // Among the 4 undestroyed enemy Dofus, exactly 2 reals remain.
    const aliveReals = w.dofuses.filter((d) => d.owner === "enemy" && d.currentLife > 0 && d.kind === "real").length;
    expect(aliveReals).toBe(2);
  });

  it("is reproducible: same state + same seed → identical world", () => {
    const s = midGame();
    expect(determinize(s, "ally", new Rng(123))).toEqual(determinize(s, "ally", new Rng(123)));
  });
});

// A living enemy Dofus that has been revealed is public.
describe("resampleEnemyReals: public information is never drawn again", () => {
  it("a living revealed enemy Dofus keeps its kind in every world", () => {
    const base = midGame();
    const foe: Side = "enemy";
    // Reveal a real enemy Dofus, its kind is now shown.
    const revele = base.dofuses.find((d) => d.owner === foe && d.kind === "real")!;
    const dofuses = base.dofuses.map((d) =>
      d.position.x === revele.position.x && d.position.y === revele.position.y
        ? { ...d, revealed: true }
        : d,
    );
    // A hundred sampled worlds with different seeds, and none of them may change
    // the kind of the revealed Dofus.
    for (let seed = 1; seed <= 100; seed++) {
      const out = resampleEnemyReals(dofuses, foe, new Rng(seed));
      const apres = out.find(
        (d) => d.position.x === revele.position.x && d.position.y === revele.position.y,
      )!;
      expect(apres.kind).toBe("real");
    }
  });

  // A safety net, not a proof of the fix: this test also passes without it (the
  // total is right in both cases, 3 cells out of 5, or 1 known and 2 cells out of
  // 4). I keep it because the invariant matters, but the test above is the one that
  // tells the two apart.
  it("the total number of real enemy Dofus stays exact after a reveal", () => {
    const base = midGame();
    const foe: Side = "enemy";
    const revele = base.dofuses.find((d) => d.owner === foe && d.kind === "real")!;
    const dofuses = base.dofuses.map((d) =>
      d.position.x === revele.position.x && d.position.y === revele.position.y
        ? { ...d, revealed: true }
        : d,
    );
    for (let seed = 1; seed <= 50; seed++) {
      const out = resampleEnemyReals(dofuses, foe, new Rng(seed));
      const vrais = out.filter((d) => d.owner === foe && d.kind === "real").length;
      // The revealed one counts once, not twice. Without the fix it was counted
      // as known and also put back into the draw.
      expect(vrais).toBe(3);
    }
  });
});
