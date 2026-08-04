// Policy agent with no search (the DouZero/Suphx approach): play the policy net's
// move directly, with no MCTS and no determinized worlds. This was the starting
// point for policy RL: the value+search stack had hit a ceiling (the value net
// reaches about 66% accuracy with perfect information as well as without), so the
// idea was to learn the move instead of evaluating the position. `temperature` 0 =
// greedy argmax (arena), >0 = sample ∝ prior^(1/T) (self-play exploration for RL).
import type { Agent } from "./Agent";
import type { GameState } from "../../engine/state";
import type { Side } from "../../engine/board";
import type { Rng } from "../../engine/rng";
import type { Action } from "../actions";
import { actingSide } from "../actions";
import { encode2 } from "../encode2";
import { priorOverLegal } from "../policy";
import type { TsPolicyModel } from "../net/TsPolicyModel";
import { mulliganV1 } from "../mulligan";

export class PolicyAgent implements Agent {
  readonly name: string;
  private readonly model: TsPolicyModel;
  private readonly cardIndex: Map<number, number>;
  private readonly temperature: number;

  constructor(model: TsPolicyModel, cardIndex: Map<number, number>, temperature = 0) {
    this.model = model;
    this.cardIndex = cardIndex;
    this.temperature = temperature;
    this.name = `Policy(T=${temperature})`;
  }

  chooseAction(state: GameState, legal: Action[], rng: Rng): Action {
    if (state.mulligan) return { kind: "mulligan", returnIndices: mulliganV1(state, state.mulligan.current) };
    if (legal.length === 1) return legal[0];
    const side: Side = actingSide(state);
    const { what, where } = this.model.policy(encode2(state, side, { cardIndex: this.cardIndex, belief: null }));
    const w = priorOverLegal(legal, what, where, this.cardIndex);
    if (this.temperature <= 0) {
      let best = 0;
      for (let i = 1; i < w.length; i++) if (w[i] > w[best]) best = i;
      return legal[best];
    }
    const inv = 1 / this.temperature;
    const wt = Array.from(w, (v) => Math.pow(Math.max(0, v), inv));
    let total = 0;
    for (const v of wt) total += v;
    if (total <= 0) return legal[rng.int(legal.length)];
    let r = rng.next() * total;
    for (let i = 0; i < wt.length; i++) { r -= wt[i]; if (r <= 0) return legal[i]; }
    return legal[legal.length - 1];
  }
}
