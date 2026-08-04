// The simplest possible agent: pick a uniformly-random legal move. It plays
// badly, but it is the floor every stronger agent must beat, and it validates
// that the action layer + self-play loop work end to end.
import type { Agent } from "./Agent";
import type { GameState } from "../../engine/state";
import type { Rng } from "../../engine/rng";
import type { Action } from "../actions";

export class RandomAgent implements Agent {
  readonly name = "Random";
  chooseAction(_state: GameState, legal: Action[], rng: Rng): Action {
    return legal[rng.int(legal.length)];
  }
}
