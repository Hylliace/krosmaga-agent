// Belief calibration harness. Replays games against held-out opponents, rebuilds
// the belief from public events only (every state.log event goes through the leak
// check: the log sees everything, so it is never read raw for an opponent draw id),
// and scores P(card in opponent hand) against the true hidden hand. Main metric =
// Brier (low variance with class imbalance); ECE on quantile bins; compared with a
// prior-only god-marginal baseline.
//
// The hyperparameters only change the corpus tables and the posterior, not the
// games (the HeuristicAgent never uses the belief). So the work is split:
// extractObs() runs the expensive engine replay once per game and caches the
// public observations and the ground truth; scoreCached() then scores again
// cheaply for any set of hyperparameters, which is what the tuning sweep uses.
import type { God } from "../../data/types";
import type { Side } from "../../engine/board";
import type { CorpusBelief } from "./corpus";
import type { RawGame } from "../selfplay/recordRaw";
import { replayRaw } from "../selfplay/recordRaw";
import { initBelief, applyObs, queryHand, projectForObserver, type PublicObs } from "./state";
import { realDeckCard } from "./realDeckCard";

export interface CalibrationResult {
  n: number;
  brier: number;
  baselineBrier: number;
  ece: number;            // quantile-binned expected calibration error
  mce: number;
  logloss: number;
  reliability: { conf: number; acc: number; n: number }[];
  perGod: Record<string, { brier: number; baselineBrier: number; n: number }>;
}

// One game pre-projected to public observations + per-step ground truth. The
// opening (cards already reflected in H0/D0) is skipped; each step carries the
// new public obs since the previous step.
export interface CachedGame {
  foeGod: God;
  H0: number;
  D0: number;
  steps: { obs: PublicObs[]; truth: number[] }[];
}

/** Run the expensive engine replay once and cache the public-obs stream + truth.
 *  Reads the true foe hand only for the y-label (truth), never to build belief. */
export function extractObs(raw: RawGame, observer: Side = "ally"): CachedGame | null {
  const foe: Side = observer === "ally" ? "enemy" : "ally";
  const foeGod = (foe === "ally" ? raw.mu?.a.god : raw.mu?.e.god) as God | undefined;
  if (!foeGod) return null;
  const { steps } = replayRaw(raw);
  if (steps.length === 0) return null;
  const first = steps[0].state;
  const H0 = first.players[foe].hand.length;
  const D0 = first.players[foe].deck.length;
  let cursor = first.log.length; // skip the opening (already in H0/D0)
  const cached: { obs: PublicObs[]; truth: number[] }[] = [];
  for (const step of steps) {
    const log = step.state.log;
    const obs: PublicObs[] = [];
    for (; cursor < log.length; cursor++) {
      const o = projectForObserver(log[cursor], observer); // PUBLIC-only projection
      if (o) obs.push(o);
    }
    cached.push({ obs, truth: [...step.state.players[foe].hand] }); // y-label only
  }
  return { foeGod, H0, D0, steps: cached };
}

interface Pair { p: number; y: number; pBase: number; god: God; }

/** Score a hyperparam-specific corpus over cached games (cheap; no engine replay). */
export function scoreCached(
  cached: CachedGame[],
  corpusMap: Map<God, CorpusBelief>,
  opts: { everyNth?: number; bins?: number } = {},
): CalibrationResult {
  const everyNth = opts.everyNth ?? 4;
  const pairs: Pair[] = [];
  for (const game of cached) {
    const corpus = corpusMap.get(game.foeGod);
    if (!corpus) continue;
    const isReal = (id: number) => realDeckCard(id, game.foeGod);
    const b = initBelief(corpus, game.H0, game.D0);
    let sampled = 0;
    for (const step of game.steps) {
      for (const o of step.obs) applyObs(b, o, isReal);
      if (sampled++ % everyNth !== 0) continue;
      const pred = queryHand(b);
      const truth = new Set(step.truth); // presence (≥1 copy) in the true hidden hand
      for (let i = 0; i < corpus.cards.length; i++) {
        const c = corpus.cards[i];
        pairs.push({ p: pred[i], y: truth.has(c) ? 1 : 0, pBase: corpus.genPresence[i], god: game.foeGod });
      }
    }
  }
  return metricsOf(pairs, opts.bins ?? 15);
}

/** Convenience: extract + score in one pass (used by the single-config CLI/tests). */
export function calibrate(
  games: RawGame[],
  corpusMap: Map<God, CorpusBelief>,
  opts: { observer?: Side; everyNth?: number; bins?: number } = {},
): CalibrationResult {
  const cached = games.map((g) => extractObs(g, opts.observer ?? "ally")).filter((c): c is CachedGame => c !== null);
  return scoreCached(cached, corpusMap, opts);
}

function brierOf(ps: Pair[], use: (p: Pair) => number): number {
  if (!ps.length) return 0;
  let s = 0;
  for (const p of ps) s += (use(p) - p.y) ** 2;
  return s / ps.length;
}

function metricsOf(pairs: Pair[], bins: number): CalibrationResult {
  const n = pairs.length;
  const brier = brierOf(pairs, (p) => p.p);
  const baselineBrier = brierOf(pairs, (p) => p.pBase);
  let logloss = 0;
  for (const p of pairs) {
    const q = Math.min(1 - 1e-12, Math.max(1e-12, p.p));
    logloss += -(p.y * Math.log(q) + (1 - p.y) * Math.log(1 - q));
  }
  logloss = n ? logloss / n : 0;

  // QUANTILE (equal-frequency) reliability bins, trustworthy under imbalance.
  const sorted = [...pairs].sort((a, b) => a.p - b.p);
  const reliability: { conf: number; acc: number; n: number }[] = [];
  let ece = 0, mce = 0;
  for (let bIdx = 0; bIdx < bins; bIdx++) {
    const lo = Math.floor((bIdx * n) / bins);
    const hi = Math.floor(((bIdx + 1) * n) / bins);
    if (hi <= lo) continue;
    let conf = 0, acc = 0;
    for (let i = lo; i < hi; i++) { conf += sorted[i].p; acc += sorted[i].y; }
    const m = hi - lo;
    conf /= m; acc /= m;
    reliability.push({ conf, acc, n: m });
    const gap = Math.abs(acc - conf);
    ece += (m / n) * gap;
    mce = Math.max(mce, gap);
  }

  const perGod: Record<string, { brier: number; baselineBrier: number; n: number }> = {};
  for (const g of new Set(pairs.map((p) => p.god))) {
    const sub = pairs.filter((p) => p.god === g);
    perGod[g] = { brier: brierOf(sub, (p) => p.p), baselineBrier: brierOf(sub, (p) => p.pBase), n: sub.length };
  }

  return { n, brier, baselineBrier, ece, mce, logloss, reliability, perGod };
}
