// The common contract every AI implements. An agent is a pure decision
// function: given a state and the legal moves, pick one. Stochastic agents draw
// from the supplied (seeded) RNG so a whole experiment stays reproducible.
//
// The same interface carries us from RandomAgent → HeuristicAgent → MctsAgent →
// NetAgent. Only the body of chooseAction changes.
import type { GameState } from "../../engine/state";
import type { Rng } from "../../engine/rng";
import type { Action } from "../actions";

export interface Agent {
  readonly name: string;
  /** Choose one of `legal` (guaranteed non-empty by the caller). */
  chooseAction(state: GameState, legal: Action[], rng: Rng): Action;
}
