// DMC (DouZero-style) afterstate-greedy agent. Search-FREE: for each legal
// action a it evaluates the AFTERSTATE apply(s,a) with a scalar net f and plays
// argmax_a f(afterstate), i.e. 1-ply greedy over a learned afterstate value.
// This is the DMC counterpart of PolicyAgent: instead of imitating a search's
// move distribution, it ranks moves by their Monte-Carlo-learned value, and the
// net is improved in a closed self-play loop (encodeAfterstate -> train -> here).
//
// epsilon>0 makes it epsilon-greedy for self-play exploration (DMC needs it to
// discover better lines than its current greedy policy); epsilon=0 is the arena
// player. Perspective/settle convention mirrors netLeaf + encodeAfterstate so
// train and inference see identical inputs.
import type { Agent } from "./Agent";
import type { GameState } from "../../engine/state";
import type { Side } from "../../engine/board";
import type { Rng } from "../../engine/rng";
import type { Action } from "../actions";
import { actingSide, applyAction } from "../actions";
import { encode2, type EncodeCtx2 } from "../encode2";
import type { TsValueModel } from "../net/TsValueModel";
import { mulliganV1 } from "../mulligan";

export class QAgent implements Agent {
  readonly name: string;
  private readonly f: TsValueModel;
  private readonly cardIndex: Map<number, number>;
  private readonly epsilon: number;

  constructor(f: TsValueModel, cardIndex: Map<number, number>, epsilon = 0) {
    this.f = f;
    this.cardIndex = cardIndex;
    this.epsilon = epsilon;
    this.name = `Q(eps=${epsilon})`;
  }

  chooseAction(state: GameState, legal: Action[], rng: Rng): Action {
    if (state.mulligan) return { kind: "mulligan", returnIndices: mulliganV1(state, state.mulligan.current) };
    if (legal.length === 1) return legal[0];
    if (this.epsilon > 0 && rng.next() < this.epsilon) return legal[rng.int(legal.length)];

    const me: Side = actingSide(state);
    const ctx: EncodeCtx2 = { cardIndex: this.cardIndex, belief: null };
    let best = -1;
    let bestQ = -Infinity;
    for (let i = 0; i < legal.length; i++) {
      const next = applyAction(state, legal[i]);
      let q: number;
      if (next.winner !== null) {
        // A move that ends the game now: terminal value, no net needed.
        q = next.winner === me ? 1 : -1;
      } else {
        // Encode the afterstate AS-IS (pending or not), identical convention to
        // encodeAfterstate, so f sees the exact distribution it trained on.
        const encSide = actingSide(next);
        const v = this.f.value(encode2(next, encSide, ctx));
        q = encSide === me ? v : -v; // net answers for the encoded side; flip to the actor
      }
      if (q > bestQ) { bestQ = q; best = i; }
    }
    return legal[best];
  }
}
