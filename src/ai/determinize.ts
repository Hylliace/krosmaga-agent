// Determinisation, turn the true GameState into a plausible "world" consistent
// with what side `me` can legitimately observe. The search then runs on this
// sampled world instead of the truth, so the AI never peeks at hidden info.
// Averaging the search over many sampled worlds is how a fair agent reasons
// under uncertainty (PIMC, Perfect Information Monte-Carlo).
//
// What we re-sample (hidden to `me`):
//   - `me`'s own deck order, you do not know your own draw order → reshuffle.
//   - the OPPONENT's hand vs deck split + order, re-partition their unseen
//     cards into a fresh hand of the same size + a shuffled deck.
//   - which undestroyed enemy Dofus are real, re-sample, consistent with the
//     count already revealed by destructions.
//   - the engine RNG (future draws / dice), fresh seed per world.
//
// What we keep (observable / known to `me`):
//   - `me`'s hand, board, AP, reserve, and the real/fake of `me`'s own Dofus;
//   - both discards (public), all creatures, the opponent's hand size.
//
// Scope: re-partitioning the opponent's true unseen multiset is exactly right
// for a known matchup (mirror: you know their decklist, so you know the multiset
// of their remaining cards). For an unknown deck it slightly over-informs, the
// generalist fix is to sample the opponent's deck from the meta first (later).
// Belief tracking (Fléau / tutored cards) will later pin known cards into the
// sampled hand; for now cost-modifiers on the opponent's hand are dropped.
import type { GameState, DofusInstance } from "../engine/state";
import type { Side } from "../engine/board";
import type { Rng } from "../engine/rng";

const REAL_PER_SIDE = 3;

export function determinize(state: GameState, me: Side, rng: Rng): GameState {
  const foe: Side = me === "ally" ? "enemy" : "ally";
  const myP = state.players[me];
  const foeP = state.players[foe];

  // My own deck: composition known, order not → reshuffle.
  const myDeck = rng.shuffle([...myP.deck]);

  // Opponent: re-partition their unseen cards (hand + deck) into a fresh hand of
  // the same size + a shuffled deck.
  const unseen = rng.shuffle([...foeP.hand, ...foeP.deck]);
  const foeHand = unseen.slice(0, foeP.hand.length);
  const foeDeck = unseen.slice(foeP.hand.length);

  return {
    ...state,
    rng: (rng.int(0x7fffffff) | 0) >>> 0,
    dofuses: resampleEnemyReals(state.dofuses, foe, rng, state.destroyedDofuses),
    players: {
      ...state.players,
      [me]: { ...myP, deck: myDeck },
      [foe]: {
        ...foeP,
        hand: foeHand,
        handCostMods: foeHand.map(() => 0), // cost-mods lost on re-partition (belief TODO)
        deck: foeDeck,
      },
    },
  };
}

// Re-randomise which undestroyed enemy Dofus are real. Destroyed Dofus keep their
// revealed kind; `me`'s own Dofus are untouched (known). The number of reals among
// the living enemy Dofus is 3 minus the reals already revealed.
// Destroyed Dofus are removed from `dofuses` and kept in state.destroyedDofuses, so
// filtering the array on life<=0 is not enough: late-game worlds would place all 3
// reals among the survivors (a miscalibrated belief). Pass the destroyed list to
// count the revealed reals.
export function resampleEnemyReals(dofuses: DofusInstance[], foe: Side, rng: Rng, destroyed?: { owner: Side; kind: "real" | "fake" }[]): DofusInstance[] {
  const aliveEnemy = dofuses.filter((d) => d.owner === foe && d.currentLife > 0);
  const revealedReals =
    dofuses.filter((d) => d.owner === foe && d.currentLife <= 0 && d.kind === "real").length +
    (destroyed ?? []).filter((d) => d.owner === foe && d.kind === "real").length;
  const realsToPlace = Math.max(0, REAL_PER_SIDE - revealedReals);

  const key = (x: number, y: number) => `${x},${y}`;
  const realCells = new Set(
    rng
      .shuffle(aliveEnemy.map((d) => d.position))
      .slice(0, realsToPlace)
      .map((p) => key(p.x, p.y)),
  );

  return dofuses.map((d) => {
    if (d.owner !== foe || d.currentLife <= 0) return d; // mine + revealed: unchanged
    return { ...d, kind: realCells.has(key(d.position.x, d.position.y)) ? "real" : "fake" };
  });
}
