// Weighting the worlds by the opponent's last turn.
//
// Policy-based inference (in Skat, the largest single gain of Kermit), in a minimal and
// honest version: it only uses public information, the AP the opponent left unused at the end
// of its last turn (the engine keeps them until the start of its next turn, and the game shows
// the opponent's AP counter).
//
// The idea: an opponent who ends its turn with A unused AP probably had no playable card for
// A AP or less in hand, and above all no creature, since creatures are almost always played.
// For an imagined opponent hand H, each card of H that was playable with A AP and was kept
// multiplies the likelihood of H by the probability of "keeping" that kind of card.
//
// How: draw `candidats` times more worlds than needed from the usual belief
// (determinizeBelief), weigh each one, then resample in proportion to the weights
// (systematic resampling). If all weights are equal (A = 0, or no playable card), it falls
// back on the original belief.
//
// A known approximation: playability is tested on the current board (after the end of turn
// moves), not on the one the opponent had in front of it.
import type { GameState } from "../../engine/state";
import { BOARD_COLS, BOARD_ROWS, type Side } from "../../engine/board";
import type { God } from "../../data/types";
import type { Rng } from "../../engine/rng";
import { canPlayCard } from "../../engine/rules";
import { getCard } from "../../engine/cardRegistry";
import { determinize } from "../determinize";
import { determinizeBelief } from "./determinizeBelief";
import type { CorpusBelief } from "./corpus";

export interface OptionsInference {
  /** Probability that a player keeps a playable creature when ending its turn. */
  tenueInvocation: number;
  /** Same for a spell (often kept for the right moment). */
  tenueSort: number;
  /** Candidate worlds drawn per world kept. */
  candidats: number;
}
export const INFERENCE_DEFAUT: OptionsInference = { tenueInvocation: 0.35, tenueSort: 0.6, candidats: 4 };

const autre = (s: Side): Side => (s === "ally" ? "enemy" : "ally");

/** Likelihood of the opponent's last turn in the world `w` (imagined opponent hand). */
export function vraisemblanceDernierTour(w: GameState, me: Side, o: OptionsInference = INFERENCE_DEFAUT): number {
  const foe = autre(me);
  const p = w.players[foe];
  if (p.ap <= 0 || p.hand.length === 0) return 1;
  // The opponent "to move", with the AP it had when it ended its turn.
  const vu: GameState = { ...w, activeSide: foe, pendingAction: null, mulligan: null, winner: null };
  const jouable = new Map<number, boolean>();
  let v = 1;
  for (const id of p.hand) {
    let j = jouable.get(id);
    if (j === undefined) {
      const card = getCard(id);
      j = false;
      if (card) {
        for (let y = 0; y < BOARD_ROWS && !j; y++) for (let x = 0; x < BOARD_COLS && !j; x++) {
          if (canPlayCard(vu, card, { x, y }) === null) j = true;
        }
      }
      jouable.set(id, j);
    }
    if (j) v *= getCard(id)?.cardType === "Summon" ? o.tenueInvocation : o.tenueSort;
  }
  return v;
}

/** `n` worlds drawn from the belief, then resampled by the likelihood of the opponent's
 *  last turn. `tirer` produces a candidate world (the usual belief). */
export function mondesInferes(n: number, tirer: () => GameState, me: Side, rng: Rng, o: OptionsInference = INFERENCE_DEFAUT): GameState[] {
  const m = Math.max(n, n * Math.max(1, Math.floor(o.candidats)));
  const candidats: GameState[] = [];
  const poids: number[] = [];
  let total = 0;
  for (let i = 0; i < m; i++) {
    const w = tirer();
    const p = vraisemblanceDernierTour(w, me, o);
    candidats.push(w); poids.push(p); total += p;
  }
  if (!(total > 0)) return candidats.slice(0, n);
  // Systematic resampling: n evenly spaced points, a single draw.
  // The candidates are shuffled first: an even step over an ordered (periodic) sequence
  // would always land on the same kind of world (aliasing).
  const ordre = rng.shuffle(Array.from({ length: m }, (_, k) => k));
  const out: GameState[] = [];
  const pas = total / n;
  const u = rng.next() * pas;
  let cumul = 0, i = 0;
  for (let k = 0; k < n; k++) {
    const cible = u + k * pas;
    while (i < m - 1 && cumul + poids[ordre[i]] < cible) { cumul += poids[ordre[i]]; i++; }
    out.push(candidats[ordre[i]]);
  }
  return out;
}

/** Shortcut: inferred worlds drawn from the corpus belief (or from a plain shuffle). */
export function determinizeInfere(
  state: GameState, me: Side, belief: Map<God, CorpusBelief> | undefined, n: number, rng: Rng, o: OptionsInference = INFERENCE_DEFAUT,
): GameState[] {
  const tirer = () => (belief ? determinizeBelief(state, me, belief, rng) : determinize(state, me, rng));
  return mondesInferes(n, tirer, me, rng, o);
}
