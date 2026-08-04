// Self-play data recorder. Plays a game and captures, for every decision point,
// (encoded position, who was to move), then fills in the final outcome from that
// mover's point of view. This is the training set for a value net: "given this
// position (from the side to move), will that side win?".
//
// A learned value net can then replace the hand-written heuristic at the MCTS
// leaves, the first real jump in strength (better eval = better search). The policy
// net (which move to play) comes later and needs an action-index mapping; the value
// data here needs little per decision and is useful right away.
//
// Pure (no file I/O) so it can be tested and run from Node or the browser; a small
// Node script streams many of these to JSONL for the Python side.
import type { Side } from "../../engine/board";
import type { God } from "../../data/types";
import { createInitialState } from "../../engine/rules";
import { Rng } from "../../engine/rng";
import type { Agent } from "../agents/Agent";
import { actingSide, legalActions, applyAction } from "../actions";
import { encode } from "../encode";

export interface Sample {
  enc: Float32Array; // encode(state, side-to-move)
  value: number; // +1 win / 0 draw / -1 loss, from the side-to-move's view
}

/** Emitted when a game fails to terminate (hits the ply cap), a hung/looping
 *  game, almost always an engine or card bug. Carries enough to reproduce and
 *  debug: the seed replays the exact game; `recentMix` shows the repeating cycle
 *  (e.g. {"enemy:play#72": 2000, "enemy:cancel": 2000}); `pending` names the
 *  card/effect stuck open. */
export interface StuckInfo {
  seed: number;
  turn: number;
  side: Side;
  plies: number;
  pending: string | null; // the open pending action (prompt + held summon card), if any
  recentActions: string[]; // last ~12 action descriptors, the visible loop
  recentMix: Record<string, number>; // action histogram over the whole game, the cycle stands out
}

export interface RecordOptions {
  decks: Record<Side, number[]>;
  seed: number;
  cardIndex: Map<number, number>;
  firstSide?: Side;
  // Each side's god (match-up metadata); forwarded to createInitialState.
  gods?: Record<Side, God>;
  maxTurns?: number;
  // Abort a game that takes more than this many plies (a non-terminating loop).
  // Real games are well under ~1500 plies; default leaves a wide margin.
  maxPlies?: number;
  // Called (once) when a game is aborted by the ply cap. The game's samples are
  // discarded (a looping game is garbage data); use this to log/persist the cause.
  onStuck?: (info: StuckInfo) => void;
  // Called when a game ends in a draw (turn cap, no winner). Its samples are
  // discarded (value=0 mass flattens the net); log the cause so a systemic stall
  // is visible rather than silently dropped.
  onDraw?: (info: { seed: number; turns: number; plies: number }) => void;
}

export function recordGame(agentA: Agent, agentB: Agent, opts: RecordOptions): Sample[] {
  let state = createInitialState(opts.decks, { seed: opts.seed, firstSide: opts.firstSide, gods: opts.gods });
  const agentRng = new Rng((opts.seed ^ 0x9e3779b9) | 0);
  const maxTurns = opts.maxTurns ?? 300;
  const maxPlies = opts.maxPlies ?? 4000;

  // Record (encoding, mover) per decision; resolve `value` once we know who won.
  const pending: { enc: Float32Array; mover: Side }[] = [];

  // Loop-detection bookkeeping (cheap): action histogram + a short tail, so an
  // aborted game can name its cycle for debugging.
  let plies = 0;
  const mix: Record<string, number> = {};
  const recent: string[] = [];

  while (state.winner === null && state.turn <= maxTurns) {
    const side = actingSide(state);
    const legal = legalActions(state);
    if (legal.length === 0) break;
    // Skip mulligan picks: they have no board to evaluate yet and would flood
    // the set with near-identical pre-game positions.
    if (!state.mulligan) {
      pending.push({ enc: encode(state, side, opts.cardIndex), mover: side });
    }
    const agent = side === "ally" ? agentA : agentB;
    const action = agent.chooseAction(state, legal, agentRng);
    const key = `${side}:${action.kind}` + (action.kind === "play" ? `#${action.cardId}` : "");
    mix[key] = (mix[key] ?? 0) + 1;
    const pa = state.pendingAction;
    recent.push(`t${state.turn} ${key}${pa ? "(P)" : ""}`);
    if (recent.length > 12) recent.shift();
    const pendingSummary = pa ? `${pa.prompt ?? "pending"}${pa.summonAfter ? ` summon#${pa.summonAfter.cardId}` : ""}` : null;

    state = applyAction(state, action);

    if (++plies > maxPlies) {
      // Non-terminating game → discard its samples (looping = garbage data) and
      // report the cause so it can be debugged.
      opts.onStuck?.({
        seed: opts.seed,
        turn: state.turn,
        side,
        plies,
        pending: pendingSummary,
        recentActions: [...recent],
        recentMix: mix,
      });
      return [];
    }
  }

  const winner = state.winner;
  if (winner === null) {
    // Draw (turn cap reached): dropped. Labelling these value=0 would flood the value
    // net with neutral targets and flatten it. The cause is logged.
    opts.onDraw?.({ seed: opts.seed, turns: state.turn, plies });
    return [];
  }
  return pending.map(({ enc, mover }) => ({ enc, value: winner === mover ? 1 : -1 }));
}
