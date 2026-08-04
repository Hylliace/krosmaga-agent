// DMC (DouZero-style Deep Monte Carlo) afterstate encoder. Unlike encodeRaw (which
// samples the end-of-turn board and asks "who wins from here?"), this samples the
// afterstate of the action actually chosen at each decision and labels it with the
// Monte-Carlo return. A scalar net f trained on these gives an afterstate value
// Q(s,a) ≈ f(encode(apply(s,a))), and the QAgent then plays argmax_a Q(s,a) (1-ply
// greedy, no search). The DMC loop repeats: self-play with the current f, encode the
// afterstates again, retrain. It is a closed self-improvement loop (not distilling a
// fixed search), which is the point of trying policy RL.
//
// The perspective and label convention match netLeaf exactly: the afterstate is
// settled with no pending action, encoded from actingSide(afterstate), and labeled +1
// if that side wins the game. At inference QAgent flips the sign back to the actor.
import type { Side } from "../../engine/board";
import { createInitialState } from "../../engine/rules";
import { actingSide, applyAction } from "../actions";
import { decodeAction, type RawGame } from "./recordRaw";
import { encode2, type EncodeCtx2 } from "../encode2";
import type { God } from "../../data/types";
import type { CorpusBelief } from "../belief/corpus";
import { buildBeliefFromState } from "../belief/determinizeBelief";

export interface EncodeAfterstateOpts {
  cardIndex: Map<number, number>;
  /** Keep every k-th afterstate sample per game (intra-turn decorrelation). */
  stride?: number;
  /** Belief tables. When set, the foe channels are filled from the belief
   *  posterior (so the net matches netLeaf's inference distribution and can serve
   *  as a search leaf without OOD). Omit => belief=null (the search-free QAgent
   *  convention). Train and inference must agree. */
  corpusMap?: Map<God, CorpusBelief>;
}

export interface AfterstateSample {
  x: Float32Array; // encode2 of the pending-free afterstate, from its actingSide's view
  y: number;       // +1 iff that encoded side wins the game
}

export interface EncodeAfterstateResult {
  samples: AfterstateSample[];
  dropped: null | "draw" | "result-mismatch";
}

/** Replay one raw game and emit an afterstate value sample per chosen action. */
export function encodeAfterstateGame(raw: RawGame, opts: EncodeAfterstateOpts): EncodeAfterstateResult {
  if (raw.res.w === 0) return { samples: [], dropped: "draw" };
  const gods = raw.mu?.a.god && raw.mu?.e.god ? { ally: raw.mu.a.god, enemy: raw.mu.e.god } : undefined;
  let state = createInitialState({ ally: raw.decks.a, enemy: raw.decks.e }, { seed: raw.seed, firstSide: raw.first, gods });

  const afters: { x: Float32Array; encSide: Side }[] = [];
  try {
    for (let k = 0; k < raw.acts.length; k++) {
      const action = decodeAction(raw.acts[k]);
      const isMulligan = state.mulligan !== null && state.mulligan !== undefined;
      const next = applyAction(state, action);
      // Sample the afterstate of every NON-mulligan decision. Encode `next`
      // AS-IS (no pending settle, settling would roll Math.random on random
      // effects). A pending afterstate is a legitimate intermediate board whose
      // actingSide is the actor about to resolve; the target-resolution decision
      // gets its own (pending-free) afterstate. Skip terminal/mulligan boards.
      if (!isMulligan && next.winner === null && !next.mulligan) {
        const encSide = actingSide(next);
        const ctx: EncodeCtx2 = {
          cardIndex: opts.cardIndex,
          belief: opts.corpusMap ? buildBeliefFromState(next, encSide, opts.corpusMap) : null,
        };
        afters.push({ x: encode2(next, encSide, ctx), encSide });
      }
      state = next;
    }
  } catch {
    return { samples: [], dropped: "result-mismatch" };
  }

  const winner: Side | null = state.winner;
  const w: 0 | 1 | -1 = winner === null ? 0 : winner === "ally" ? 1 : -1;
  if (w !== raw.res.w || state.turn !== raw.res.turns) return { samples: [], dropped: "result-mismatch" };

  const stride = Math.max(1, opts.stride ?? 1);
  const samples: AfterstateSample[] = [];
  for (let i = 0; i < afters.length; i += stride) {
    samples.push({ x: afters[i].x, y: winner === afters[i].encSide ? 1 : -1 });
  }
  return { samples, dropped: null };
}
