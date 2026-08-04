// Run a batch of games between two agents and aggregate the result. This is how
// we answer the only question that matters when iterating on AI: "is agent A
// actually better than agent B?" Every stronger agent (heuristic, MCTS, net)
// gets benchmarked here against the previous one.
//
// Fairness: Krosmaga has a first-player advantage, so by default we swap sides
// each game (A is ally on even seeds, enemy on odd) and credit wins to the agent
// regardless of seat. Score counts a draw as half a win (Elo-friendly).
import type { Side } from "../../engine/board";
import type { Agent } from "../agents/Agent";
import { playGame } from "../selfplay/playGame";

export interface ArenaOptions {
  games: number;
  decks: Record<Side, number[]>;
  baseSeed?: number;
  maxTurns?: number;
  swapSides?: boolean; // default true
}

export interface ArenaResult {
  games: number;
  winsA: number;
  winsB: number;
  draws: number;
  scoreA: number; // (winsA + 0.5·draws) / games, 0.5 means evenly matched
  avgTurns: number;
  avgPlies: number;
}

export function runArena(agentA: Agent, agentB: Agent, opts: ArenaOptions): ArenaResult {
  const { games, decks, baseSeed = 1, maxTurns = 300, swapSides = true } = opts;
  let winsA = 0;
  let winsB = 0;
  let draws = 0;
  let sumTurns = 0;
  let sumPlies = 0;

  for (let i = 0; i < games; i++) {
    const aIsAlly = !swapSides || i % 2 === 0;
    const ally = aIsAlly ? agentA : agentB;
    const enemy = aIsAlly ? agentB : agentA;
    const r = playGame(ally, enemy, { decks, seed: baseSeed + i, maxTurns });
    sumTurns += r.turns;
    sumPlies += r.plies;
    if (r.winner === null) draws++;
    else if ((r.winner === "ally") === aIsAlly) winsA++;
    else winsB++;
  }

  return {
    games,
    winsA,
    winsB,
    draws,
    scoreA: (winsA + 0.5 * draws) / games,
    avgTurns: sumTurns / games,
    avgPlies: sumPlies / games,
  };
}

/** One-line human-readable summary for logs. */
export function formatArena(label: string, r: ArenaResult): string {
  const pct = (n: number) => `${Math.round((100 * n) / r.games)}%`;
  return (
    `${label}: A ${pct(r.winsA)} / B ${pct(r.winsB)} / draw ${pct(r.draws)} ` +
    `(scoreA ${r.scoreA.toFixed(3)}, avg ${r.avgTurns.toFixed(1)} turns, ${r.avgPlies.toFixed(0)} plies)`
  );
}
