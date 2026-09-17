// Template for a challenger agent: copy this file, rename it, and change whatever you
// want (the search, the evaluation, the belief, anything). The arena
// (cli/challengeArena.ts) loads the module by its path and calls makeChallenger(ctx);
// it must return an object that follows the Agent contract (agents/Agent.ts):
// chooseAction(state, legal, rng) -> one action from `legal`.
//
// Fairness rule: `state` is complete. It holds the opponent's hand and deck
// (state.players[...]) and the real kind of their Dofus. An honest agent does not read
// them: the belief is built from public information only (buildBeliefFromState). An
// agent that cheats wins every arena and has learned nothing.
//
// This example wraps the reference agent (value network + PIMC) at the saturation
// budget of 2 worlds x 80 simulations: it plays even with the champion, the natural
// starting point to measure what your changes bring.
import type { Agent } from "./Agent";
import type { GameState } from "../../engine/state";
import type { Rng } from "../../engine/rng";
import type { Action } from "../actions";
import { makeValueAgent } from "./valueAgent";
import type { ChallengerContext } from "../cli/challengeArena";

export function makeChallenger(ctx: ChallengerContext): Agent {
  const reference = makeValueAgent(ctx.model, ctx.cardIndex, ctx.corpusMap, { worlds: 2, simulations: 80, maxBranch: 12 });
  return {
    name: "Challenger(example)",
    chooseAction(state: GameState, legal: Action[], rng: Rng): Action {
      // Your idea goes here: filter `legal`, rank again, call another search,
      // another network... Here it just hands over to the reference.
      return reference.chooseAction(state, legal, rng);
    },
  };
}
