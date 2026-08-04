// The agent-facing action layer: turn a GameState into the set of legal moves,
// and apply a chosen move. This is the single bridge between the engine and any
// AI (Random, heuristic, MCTS, neural). Everything downstream speaks `Action`.
//
// "Whoever must act now" depends on the phase:
//   - mulligan      → state.mulligan.current chooses cards to send back
//   - pending action→ state.pendingAction.side picks a target (or declines)
//   - normal turn   → state.activeSide plays cards / claims reserve / ends turn
import type { GameState } from "../engine/state";
import type { Coords, Side } from "../engine/board";
import { BOARD_COLS, BOARD_ROWS } from "../engine/board";
import { getCard } from "../engine/cardRegistry";
import {
  canPlayCard,
  playCard,
  endTurn,
  claimReserve,
  resolvePendingAction,
  cancelPendingAction,
  validPendingTargets,
  applyMulligan,
} from "../engine/rules";

export type Action =
  | { kind: "mulligan"; returnIndices: number[] } // send these opening-hand slots back
  | { kind: "play"; cardId: number; target: Coords } // cast/summon cardId at a cell
  | { kind: "resolve"; target: Coords } // pick a target for the pending action
  | { kind: "cancel" } // decline an optional pending action
  | { kind: "reserve" } // cash the AP reserve into usable AP
  | { kind: "endTurn" };

/** Who must act in the current state. */
export function actingSide(state: GameState): Side {
  if (state.mulligan) return state.mulligan.current;
  if (state.pendingAction) return state.pendingAction.side;
  return state.activeSide;
}

/** True once the match is decided. */
export function isTerminal(state: GameState): boolean {
  return state.winner !== null;
}

/** A board cell that is not a legal pending target, clicking it declines the optional
 *  pick. For a deferred summon the engine routes this to landDeferredSummon (the creature
 *  lands without the optional effect), exactly like a human "click elsewhere on the board".
 *  Prefers a truly empty cell so it cannot accidentally match a creature/Dofus filter.
 *  Returns null only when every cell is a valid target (an "any_cell" pick, no in-board
 *  decline exists, so the caller falls back to the take-back cancel).
 *  Exported for netLeaf.settleProbePendings (probe-opened picks settle the same way). */
export function declineCell(state: GameState): Coords | null {
  const targets = new Set(validPendingTargets(state).map((t) => `${t.x},${t.y}`));
  const occupied = new Set<string>();
  for (const c of state.creatures) if (c.currentLife > 0) occupied.add(`${c.position.x},${c.position.y}`);
  for (const d of state.dofuses) occupied.add(`${d.position.x},${d.position.y}`);
  // Prefer an empty, non-target cell (fails creature/Dofus filters → a clean decline).
  for (let y = 0; y < BOARD_ROWS; y++)
    for (let x = 0; x < BOARD_COLS; x++) {
      const k = `${x},${y}`;
      if (!targets.has(k) && !occupied.has(k)) return { x, y };
    }
  // Fallback: any non-target cell.
  for (let y = 0; y < BOARD_ROWS; y++)
    for (let x = 0; x < BOARD_COLS; x++) if (!targets.has(`${x},${y}`)) return { x, y };
  return null;
}

/** Enumerate every legal action for whoever must act now. Never empty in a
 *  normal turn (endTurn is always available). */
export function legalActions(state: GameState): Action[] {
  if (state.winner !== null) return [];

  // --- Mulligan: any subset of the opening hand may be returned (2^n masks).
  if (state.mulligan) {
    const n = state.players[state.mulligan.current].hand.length;
    const out: Action[] = [];
    for (let mask = 0; mask < 1 << n; mask++) {
      const returnIndices: number[] = [];
      for (let i = 0; i < n; i++) if (mask & (1 << i)) returnIndices.push(i);
      out.push({ kind: "mulligan", returnIndices });
    }
    return out;
  }

  // --- Pending target pick (APPARITION / second swap target / row change …).
  if (state.pendingAction) {
    const out: Action[] = validPendingTargets(state).map((target) => ({ kind: "resolve", target }));
    if (state.pendingAction.optional) {
      // Declining always prefers the in-board decline (resolve on a non-target cell), the same "click
      // elsewhere" a human makes. The engine routes it correctly for every optional pick: a deferred
      // summon lands without its optional effect (Tomla Klass #72; the off-board take-back would loop a
      // deterministic agent forever), and a plain pick settles its decline side effects (Lame Émoussée's
      // ally damage, Sacrifice's committed cost…). The off-board cancel is only kept as the "any_cell"
      // fallback: for a plain optional pick cancelPendingAction is a UI take-back that does nothing, which
      // froze agents in a cancel loop whenever a pick opened with zero valid targets (e.g. no wounded
      // enemy).
      const cell = declineCell(state);
      out.push(cell ? { kind: "resolve", target: cell } : { kind: "cancel" });
    }
    return out;
  }

  // --- Normal turn.
  const player = state.players[state.activeSide];
  const out: Action[] = [];
  // Distinct card ids only, two copies of the same card at different hand slots
  // are interchangeable, so we do not double up the action space.
  // NOTE (TODO for MCTS): a fully target-agnostic spell (global AoE) is currently
  // emitted once per legal cell. Harmless for Random/heuristic play; we will
  // collapse those to one representative cell when action-space size matters.
  const seen = new Set<number>();
  for (const cardId of player.hand) {
    if (seen.has(cardId)) continue;
    seen.add(cardId);
    const card = getCard(cardId);
    if (!card) continue;
    for (let y = 0; y < BOARD_ROWS; y++) {
      for (let x = 0; x < BOARD_COLS; x++) {
        if (canPlayCard(state, card, { x, y }) === null) {
          out.push({ kind: "play", cardId, target: { x, y } });
        }
      }
    }
  }
  if (player.apReserve > 0) out.push({ kind: "reserve" });
  out.push({ kind: "endTurn" });
  return out;
}

/** Apply a chosen action, returning the new state. Assumes the action is legal
 *  (came from legalActions) and the card registry is populated (registerCards). */
export function applyAction(state: GameState, action: Action): GameState {
  switch (action.kind) {
    case "mulligan":
      return state.mulligan ? applyMulligan(state, state.mulligan.current, action.returnIndices) : state;
    case "play": {
      const card = getCard(action.cardId);
      return card ? playCard(state, card, action.target) : state;
    }
    case "resolve":
      return resolvePendingAction(state, action.target);
    case "cancel":
      return cancelPendingAction(state);
    case "reserve":
      return claimReserve(state, state.activeSide);
    case "endTurn":
      return endTurn(state);
  }
}
