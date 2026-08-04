// Re-encode raw self-play games into value-net training samples. A raw game
// (recordRaw.ts) is a pure function of (seed, actions), so it is replayed and
// encode2() is called at each decision: the expensive search is paid once and the
// re-encoding to the v2 layout is free.
//
// Three choices:
//  - Sample at the end of the turn. The heuristic/MCTS evaluate the board after the
//    end-of-turn combat, so we sample the board after endTurn (the next player's
//    starting position), not the raw mid-turn state. A net trained on mid-turn
//    boards would have to learn combat resolution again and would do worse.
//  - Label = plain ±1 from the side to move (encode2 uses a single perspective;
//    me = the side to move). No shaping, no discount.
//  - Drop replay mismatches. If the replayed winner/turns do not match the stored
//    result (engine drift or non-determinism), the whole game is dropped.
import type { Side } from "../../engine/board";
import type { God } from "../../data/types";
import { createInitialState } from "../../engine/rules";
import { actingSide, applyAction } from "../actions";
import { decodeAction, type RawGame } from "./recordRaw";
import { encode2, type EncodeCtx2 } from "../encode2";
import { encode3 } from "../encode3";
import type { CorpusBelief } from "../belief/corpus";
import { buildBeliefFromState } from "../belief/determinizeBelief";

export interface EncodeRawOpts {
  cardIndex: Map<number, number>;        // frozen vocab (buildCardIndex2 over vocab.json)
  corpusMap?: Map<God, CorpusBelief>;    // belief tables (opponent channel); omit → foe_belief = 0
  /** Keep only every k-th fin-de-tour sample per game (intra-turn decorrelation).
   *  1 = keep all end-of-turn boards (already ~one per turn). */
  stride?: number;
  /** Which encoder/capture convention (default "v2" for older data):
   *  - "v2": encode2, board captured right after endTurn (it may carry a pending opened by a
   *    FIN_DE_TOUR pick, so the net trains on a few pending boards it can never see at inference);
   *  - "v3": encode3, board captured at the first resolved (pending-free) state after endTurn; the
   *    real pick recorded in the raw actions is applied first. Matches the inference-side tripwire
   *    exactly. */
  encoder?: "v2" | "v3";
  /** Oracle test: encode3 fills the opponent channels from the true hidden state
   *  (perfect information) instead of the belief posterior. v3 only. */
  perfectInfo?: boolean;
  /** Mixed value label: y = (1-λ)·z + λ·rv where z = final outcome ±1 and rv = the
   *  search's root value at the next decision from this board (stored in RawGame.pis
   *  when generated with --record-pi). It reduces the noise of an outcome that comes
   *  30 turns later with the search's local judgement. Falls back to plain z for
   *  boards with no searched decision after them, and for older raws without pis.
   *  0 (default) = plain outcome, same behaviour as before. */
  mixValue?: number;
}

export interface EncodedSample {
  x: Float32Array;   // encode2 output (length = encodingLength2)
  y: number;         // label ∈ {+1, -1}: did the side-to-move win?
  mover: Side;       // whose perspective x is in (= side to move at this board)
}

export interface EncodeRawResult {
  samples: EncodedSample[];
  dropped: null | "draw" | "result-mismatch";
}

const tagsFor = (raw: RawGame, side: Side): string[] | undefined =>
  side === "ally" ? raw.mu?.a.tags : raw.mu?.e.tags;

/** Replay one raw game and emit its fin-de-tour value samples. Returns
 *  `{dropped}` set (and no samples) for draws and replay mismatches. */
export function encodeRawGame(raw: RawGame, opts: EncodeRawOpts): EncodeRawResult {
  if (raw.res.w === 0) return { samples: [], dropped: "draw" };

  const gods = raw.mu?.a.god && raw.mu?.e.god ? { ally: raw.mu.a.god, enemy: raw.mu.e.god } : undefined;
  let state = createInitialState({ ally: raw.decks.a, enemy: raw.decks.e }, { seed: raw.seed, firstSide: raw.first, gods });
  const v3 = opts.encoder === "v3";

  // Capture the board after endTurn (next player's start position) at each turn.
  // v3: if endTurn opened a FIN_DE_TOUR pick, wait for the recorded resolve and capture the first
  // pending-free state instead (the same distribution as at inference).
  const boards: typeof state[] = [];
  const boardActIdx: number[] = []; // index (into acts) of the action that produced each board
  let awaitingResolved = false;
  try {
    for (let k = 0; k < raw.acts.length; k++) {
      const action = decodeAction(raw.acts[k]);
      const wasEndTurn = action.kind === "endTurn";
      state = applyAction(state, action);
      if (state.winner !== null || state.mulligan) continue;
      if (v3) {
        if (wasEndTurn) awaitingResolved = true;
        if (awaitingResolved && !state.pendingAction) {
          boards.push(state);
          boardActIdx.push(k);
          awaitingResolved = false;
        }
      } else if (wasEndTurn) {
        boards.push(state);
        boardActIdx.push(k);
      }
    }
  } catch {
    // Engine drift: an action recorded as legal at generation time now throws
    // (rules changed since the shard's engineSha). Same treatment as a final
    // result mismatch, the whole game is dropped, the run continues.
    return { samples: [], dropped: "result-mismatch" };
  }

  // Drop on replay drift: the engine is pure, so a faithful replay must reproduce
  // the stored winner and turn count exactly.
  const winner: Side | null = state.winner;
  const w: 0 | 1 | -1 = winner === null ? 0 : winner === "ally" ? 1 : -1;
  if (w !== raw.res.w || state.turn !== raw.res.turns) return { samples: [], dropped: "result-mismatch" };

  const stride = Math.max(1, opts.stride ?? 1);
  const samples: EncodedSample[] = [];
  for (let i = 0; i < boards.length; i += stride) {
    const s = boards[i];
    const mover = actingSide(s);
    const ctx: EncodeCtx2 = {
      cardIndex: opts.cardIndex,
      belief: opts.corpusMap ? buildBeliefFromState(s, mover, opts.corpusMap) : null,
      // v3 drops myTags on purpose: inference (netLeaf) can never fill them, since half the leaves are
      // encoded from the opponent's perspective, whose tags we do not know. A feature filled in training
      // and zero at inference would repeat the earlier my_tags mistake. The tag globals stay reserved at
      // zero until the belief model fills them on both sides. v2 keeps the old fill (the deployed value2
      // was trained with it).
      myTags: v3 ? undefined : tagsFor(raw, mover),
      ...(opts.perfectInfo ? { perfectInfo: true } : {}),
    };
    const x = v3 ? encode3(s, mover, ctx as never) : encode2(s, mover, ctx);
    const z = winner === mover ? 1 : -1;
    let y = z;
    const lambda = opts.mixValue ?? 0;
    if (lambda > 0 && raw.pis) {
      // rv of the first searched decision after this board, the search's local
      // judgement, already from the mover's perspective (the decision's actor is
      // the side to move on this board).
      const pi = raw.pis.find((p) => p.i > boardActIdx[i]);
      if (pi) y = (1 - lambda) * z + lambda * pi.rv;
    }
    samples.push({ x, y, mover });
  }
  return { samples, dropped: null };
}
