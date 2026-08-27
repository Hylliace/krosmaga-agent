// Wires the value net as the MCTS leaf evaluator, consistent with how it was
// trained: every sample the net saw is a resolved end-of-turn board, encoded from
// the point of view of the player about to play (the receiver, with fresh AP). So
// at inference the leaf has to be encoded the same way:
//
//   1. Never on a pending state. A rare FIN_DE_TOUR pick opened by the probe itself
//      is settled deterministically first (first legal target); anything still
//      pending after that throws instead of quietly returning a score for an input
//      the net never saw. (The search itself goes through pending picks, see
//      MctsAgent.simulate, so this only handles picks opened by the probe, not
//      decision picks.)
//   2. From the point of view of actingSide(probe), not rootSide. An older version
//      encoded mid-turn probes from the side that had just spent AP, a combination
//      (my_ap < my_max_ap, wrong side) that never appears in the training rows; the
//      net's answer there was unconstrained (it led to the claim-reserve-then-pass
//      bug). The value is then flipped back to rootSide's sign.
//   3. With the belief of that side: the belief channel is "what the encoding side
//      cannot see about its opponent". Both directions are built once from the real
//      root (public information only, so nothing leaks), then reused across worlds
//      and leaves.
//
// The encoder is chosen from the model's enc_len: a v2 manifest (value2, the
// deployed judge) uses encode2, a v3 manifest uses encode3.
import type { GameState } from "../../engine/state";
import type { Side } from "../../engine/board";
import type { God } from "../../data/types";
import type { CorpusBelief } from "../belief/corpus";
import type { BeliefState } from "../belief/state";
import { buildBeliefFromState } from "../belief/determinizeBelief";
import { resolvePendingAction, validPendingTargets } from "../../engine/rules";
import { actingSide, declineCell } from "../actions";
import { evaluate } from "../eval";
import { encode2, encodingLength2, type EncodeCtx2 } from "../encode2";
import { encode3, encodingLength3, N_PLANES3, vocabSizeOf3 } from "../encode3";
import { LAYOUTS, projectToLayout } from "../enc/legacyLayout";
import type { TsValueModel } from "../net/TsValueModel";
import type { LeafEval } from "./MctsAgent";

let deadEndWarned = false;
function warnDeadEndOnce(p: GameState): void {
  if (deadEndWarned) return;
  deadEndWarned = true;
  console.warn(
    `netLeaf: unsettleable pending explored ("${p.pendingAction?.prompt ?? "?"}") — scored with the heuristic fallback. ` +
      "A NON-optional pick with zero targets is an engine dead-end (live soft-lock risk); worth an engine-side rule fix.",
  );
}

/** Settle a pending pick opened by a probe, deterministically (first legal target, bounded). Returns
 *  a pending-free state, or null for a dead-end pending; the caller then scores the raw state with
 *  the heuristic instead of the net. Mulligan still throws: no search line can reach it, so it is
 *  always a real wiring bug, never a possible branch. */
export function settleProbePendings(probe: GameState): GameState | null {
  let p = probe;
  for (let hops = 0; p.pendingAction && hops < 8; hops++) {
    // First legal target; an optional pick with no target declines in-board (resolve on a non-target
    // cell, the engine's own decline path, which also settles decline side effects like Lame Émoussée's
    // ally damage). The off-board cancel is useless here: it does nothing for plain optionals.
    const t = validPendingTargets(p)[0] ?? (p.pendingAction.optional ? declineCell(p) : null);
    if (!t) break;
    const next = resolvePendingAction(p, t);
    if (next === p) break;
    p = next;
  }
  if (p.mulligan) {
    throw new Error(
      "netLeaf tripwire: asked to score a MULLIGAN state — outside every distribution and unreachable by search; wiring bug.",
    );
  }
  // A pending action that is not optional and has no legal target is a dead end in
  // the engine (e.g. a ChangeRow spell on a creature whose two adjacent cells in the
  // same column are taken: it cannot be resolved or cancelled, a real game would get
  // stuck there). The search reaches it on hypothetical lines, so crashing the whole
  // run would be wrong; return null and let the heuristic score the branch (it ranks
  // "AP spent, board unchanged, turn stuck" poorly anyway).
  return p.pendingAction ? null : p;
}

/** Build a `makeLeafEval(rootState, me)` that scores leaves with the value net.
 *  `cardIndex` = frozen vocab; `corpusMap` = belief tables (optional; without it
 *  both belief channels are 0). */
export function netLeafEvalFactory(
  model: TsValueModel,
  cardIndex: Map<number, number>,
  corpusMap?: Map<God, CorpusBelief>,
): (rootState: GameState, me: Side) => LeafEval {
  const v2len = encodingLength2(cardIndex);
  const v3len = encodingLength3(cardIndex);
  // Inherited layout: PLANES3 comes from the observation registry, so any entry
  // added to the registry (for example "Saoul" for the Pandawa god) widens the
  // vector and makes a network trained before unreadable. A model that declares the
  // old length is now served through a projection onto its training layout,
  // instead of crashing the search. When the registry has not moved, the frozen
  // layout is the current layout and the direct branch applies (no cost).
  return (rootState, me) => {
    // One belief per perspective, both from public info only: beliefs[s] is what
    // side s cannot see about its opponent. Built once per decision.
    const beliefs: Record<Side, BeliefState | null> = corpusMap
      ? { ally: buildBeliefFromState(rootState, "ally", corpusMap), enemy: buildBeliefFromState(rootState, "enemy", corpusMap) }
      : { ally: null, enemy: null };
    void me; // perspective now derives from each probe, not from the root side

    return (probeState: GameState, rootSide: Side): number => {
      const p = settleProbePendings(probeState);
      if (p === null) {
        // Dead-end pending on a hypothetical line: the net cannot score it (zero
        // training rows); the heuristic can. Same squash as MctsAgent's default
        // leaf (evalScale 3000). Warn once, it usually flags an engine gap.
        warnDeadEndOnce(probeState);
        return Math.tanh(evaluate(probeState, rootSide) / 3000);
      }
      const side = actingSide(p); // the receiver: fresh AP, about to play, the training distribution
      const ctx: EncodeCtx2 = { cardIndex, belief: beliefs[side] };
      // Route by layout identity (the number of planes the model declares), not by
      // length: the length alone does not say which planes the network expects.
      // TsValueModel then checks the exact shape of the vector.
      const target = LAYOUTS.get(model.nPlanes);
      const x =
        model.nPlanes === N_PLANES3 ? encode3(p, side, ctx) :
        target ? projectToLayout(encode3(p, side, ctx), target, vocabSizeOf3(cardIndex)) :
        model.encLen === v2len ? encode2(p, side, ctx) :
        (() => { throw new Error(`netLeaf: model with ${model.nPlanes} planes / ${model.encLen} columns, no known layout (current v3 ${v3len} with ${N_PLANES3} planes, frozen ${[...LAYOUTS.keys()].join("/")}, v2 ${v2len})`); })();
      const v = model.value(x);
      // The net answers "does the ENCODED side win?"; selectChild wants the
      // value from rootSide's perspective.
      return side === rootSide ? v : -v;
    };
  };
}
