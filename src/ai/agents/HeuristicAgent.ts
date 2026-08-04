// Turn-aware greedy agent. In Krosmaga a summon or spell often does nothing
// visible when it is played: creatures only advance and fight at the end of the
// turn. So a naive 1-ply eval cannot tell good placement or timing from bad (every
// spawn cell looks the same) and plays barely better than Random.
//
// Instead, a candidate play is scored by the board it leads to after my
// end-of-turn combat: "if I did this and then ended my turn, how good is the
// result?". That makes lane choice and tempo matter, and the agent still builds a
// multi-card turn (it applies the best play, then decides again). Target picks
// (pending) and mulligan are judged on their immediate result.
//
// It only looks one turn ahead: enough to stop wasting cards and spells and to put
// creatures where they do work. The deeper search is MCTS, which uses this same
// eval at its leaves.
import type { Agent } from "./Agent";
import type { GameState } from "../../engine/state";
import type { Rng } from "../../engine/rng";
import type { Action } from "../actions";
import { actingSide, applyAction } from "../actions";
import { evaluate } from "../eval";

const END_TURN: Action = { kind: "endTurn" };

export class HeuristicAgent implements Agent {
  readonly name = "Heuristic";

  chooseAction(state: GameState, legal: Action[], rng: Rng): Action {
    const side = actingSide(state);
    let best: Action[] = [];
    let bestScore = -Infinity;
    for (const a of legal) {
      const score = this.scoreAction(state, a, side);
      if (score > bestScore + 1e-6) {
        bestScore = score;
        best = [a];
      } else if (Math.abs(score - bestScore) <= 1e-6) {
        best.push(a);
      }
    }
    return best.length === 1 ? best[0] : best[rng.int(best.length)];
  }

  private scoreAction(state: GameState, a: Action, side: import("../../engine/board").Side): number {
    const after = applyAction(state, a);
    // Ending the turn already ran combat, evaluate it directly.
    // A play that opened a target prompt (pending) or any non-normal phase cannot
    // be "ended through", so we judge it on its immediate result.
    if (a.kind === "endTurn" || after.pendingAction || after.mulligan || after.winner !== null) {
      return evaluate(after, side);
    }
    // Otherwise peek one step further: if I ended my turn now, how good is the
    // post-combat board? This is what makes placement / tempo legible.
    return evaluate(applyAction(after, END_TURN), side);
  }
}
