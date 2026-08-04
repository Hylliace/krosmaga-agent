// Factored policy action space (shared by the π training targets and the MCTS prior
// at inference). An action is split into what × where:
//
//   what  = which card / which non-targeted action. Card ids go through the frozen
//           vocab (OOV reserved), then 4 specials {ENDTURN, reserve, cancel, resolve}.
//   Where = the target cell (y*10+x, 0..49) or none (50) for actions with no cell.
//
// P(action) = softmax_what[what(a)] · softmax_where[where(a)], renormalised over the
// legal actions of the position. This keeps the head small and handles AoE for
// free: an action already has a single target cell (its AoE centre), so there is no
// blow-up per affected cell to collapse.
//
// The mulligan is not in this space (it has its own v1 heuristic, see mulligan.ts).
import type { Action } from "./actions";

export const WHERE_NONE = 50; // after the 50 board cells
export const WHERE_SIZE = 51;

/** WHAT-space size for a given vocab index map (cardIndex.size+1 incl OOV, +4 specials). */
export function whatSize(cardIndex: Map<number, number>): number {
  return cardIndex.size + 1 + 4;
}

// Special what tokens live just past the vocab block (OOV = cardIndex.size).
export function whatSpecials(cardIndex: Map<number, number>) {
  const base = cardIndex.size + 1; // first index after the vocab+OOV block
  return { ENDTURN: base, RESERVE: base + 1, CANCEL: base + 2, RESOLVE: base + 3 };
}

/** What index of an action (OOV-safe). Throws for mulligan (out of this space). */
export function whatIndex(action: Action, cardIndex: Map<number, number>): number {
  const sp = whatSpecials(cardIndex);
  switch (action.kind) {
    case "play": return cardIndex.get(action.cardId) ?? cardIndex.size; // OOV
    case "resolve": return sp.RESOLVE;
    case "endTurn": return sp.ENDTURN;
    case "reserve": return sp.RESERVE;
    case "cancel": return sp.CANCEL;
    case "mulligan": throw new Error("mulligan is not in the play-policy space");
  }
}

/** Where index of an action (cell y*10+x, or none for cell-less actions). */
export function whereIndex(action: Action): number {
  if (action.kind === "play" || action.kind === "resolve")
    return action.target.y * 10 + action.target.x;
  return WHERE_NONE;
}

/** Build the factored π targets (what & where marginals) from MCTS root visit
 *  counts. Each is a normalized distribution; an action's joint target is the
 *  product (the net learns the marginals, the MCTS provides them). */
export function policyTargets(
  stats: { action: Action; visits: number }[],
  cardIndex: Map<number, number>,
): { what: Float32Array; where: Float32Array } {
  const what = new Float32Array(whatSize(cardIndex));
  const where = new Float32Array(WHERE_SIZE);
  let total = 0;
  for (const s of stats) {
    if (s.action.kind === "mulligan") continue;
    what[whatIndex(s.action, cardIndex)] += s.visits;
    where[whereIndex(s.action)] += s.visits;
    total += s.visits;
  }
  if (total > 0) {
    for (let i = 0; i < what.length; i++) what[i] /= total;
    for (let i = 0; i < where.length; i++) where[i] /= total;
  }
  return { what, where };
}

/** Inference prior: score the legal actions by what·where (from the policy head's
 *  softmaxed marginals), renormalised over the legal set. Returns weights aligned
 *  1:1 with `legal`. Used as the MCTS PUCT prior (replaces the heuristic top-K). */
export function priorOverLegal(
  legal: Action[],
  whatProbs: ArrayLike<number>,
  whereProbs: ArrayLike<number>,
  cardIndex: Map<number, number>,
): Float32Array {
  const out = new Float32Array(legal.length);
  let sum = 0;
  for (let i = 0; i < legal.length; i++) {
    const a = legal[i];
    if (a.kind === "mulligan") continue;
    const w = (whatProbs[whatIndex(a, cardIndex)] ?? 0) * (whereProbs[whereIndex(a)] ?? 0);
    out[i] = w;
    sum += w;
  }
  if (sum > 0) for (let i = 0; i < out.length; i++) out[i] /= sum;
  else out.fill(1 / Math.max(1, legal.length)); // uniform fallback (cold/empty policy)
  return out;
}
