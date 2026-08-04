// Play one full match between two agents, headless and reproducibly.
//
// ally = agentA, enemy = agentB. The whole game is a pure function of `seed`:
// the engine's chance (shuffle / Dofus / draws / dice) comes from the GameState
// RNG seeded here, and each agent's own randomness comes from a separate seeded
// RNG (derived from `seed`) so agent choices are reproducible without disturbing
// the game's chance stream. Same seed → same game, every time.
//
// The card registry must be populated first (registerCards) so `play` actions
// can resolve card ids to Cards.
import type { GameState } from "../../engine/state";
import type { Side } from "../../engine/board";
import { createInitialState } from "../../engine/rules";
import { Rng } from "../../engine/rng";
import type { Agent } from "../agents/Agent";
import { actingSide, legalActions, applyAction } from "../actions";

export interface PlayGameOptions {
  decks: Record<Side, number[]>;
  seed: number;
  firstSide?: Side;
  // Safety cap: a stalling agent (only ending turns) would never finish, so we
  // stop after this many turns and call it a draw. Real games end far sooner.
  maxTurns?: number;
  // Hard ply cap against a NON-advancing loop (turn never increments, an engine
  // or card bug). Hitting it ends the game as a draw. Real games are well under
  // ~1500 plies; default leaves a wide margin.
  maxPlies?: number;
  // Optional sink for every (state-before, action), used later to record
  // self-play data for training. Called before the action is applied.
  onStep?: (state: GameState, action: ChosenAction) => void;
}

export interface GameResult {
  winner: Side | null; // null = draw (hit the turn cap)
  turns: number; // final turn counter
  plies: number; // total agent decisions taken
}

// Tiny indirection so onStep's type matches chooseAction's return.
type ChosenAction = ReturnType<Agent["chooseAction"]>;

export function playGame(agentA: Agent, agentB: Agent, opts: PlayGameOptions): GameResult {
  let state = createInitialState(opts.decks, { seed: opts.seed, firstSide: opts.firstSide });
  const agentRng = new Rng((opts.seed ^ 0x9e3779b9) | 0);
  const maxTurns = opts.maxTurns ?? 300;
  const maxPlies = opts.maxPlies ?? 4000;
  let plies = 0;

  while (state.winner === null && state.turn <= maxTurns) {
    const side = actingSide(state);
    const agent = side === "ally" ? agentA : agentB;
    const legal = legalActions(state);
    if (legal.length === 0) break; // defensive: should never happen
    const action = agent.chooseAction(state, legal, agentRng);
    opts.onStep?.(state, action);
    state = applyAction(state, action);
    plies++;
    if (plies > maxPlies) break; // hard stop against a non-advancing loop
  }

  return { winner: state.winner, turns: state.turn, plies };
}
