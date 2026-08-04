// Wires the policy net as the MCTS PUCT prior. Returns a `makePriorFn` for
// DeterminizedMctsAgent: at each node it encodes the current state (the policy was
// trained on current-state inputs, belief channel off) and turns the head softmaxes
// into per-legal-action weights through the factored what×where space.
//
// Unlike the value leaf (which reuses the root belief), the prior is evaluated at
// every node (one forward per node), so it needs the fast TS forward and a modest
// simulation budget. The encode uses belief=null to match genPolicyData.
import type { GameState } from "../../engine/state";
import type { Side } from "../../engine/board";
import type { Action } from "../actions";
import { actingSide } from "../actions";
import { encode2 } from "../encode2";
import { priorOverLegal } from "../policy";
import type { TsPolicyModel } from "../net/TsPolicyModel";
import type { PriorFn } from "./MctsAgent";

/** Build a `makePriorFn(rootState, me)` backed by the policy net. The returned
 *  PriorFn scores any state's legal actions; it encodes from the side to move
 *  (so the policy is always read in the mover's canonical frame). */
export function netPriorFactory(
  model: TsPolicyModel,
  cardIndex: Map<number, number>,
): (rootState: GameState, me: Side) => PriorFn {
  return () => (state: GameState, legal: Action[]): Float32Array => {
    const side = actingSide(state);
    const { what, where } = model.policy(encode2(state, side, { cardIndex, belief: null }));
    return priorOverLegal(legal, what, where, cardIndex);
  };
}
