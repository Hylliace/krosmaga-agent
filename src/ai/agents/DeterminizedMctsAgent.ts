// Fair MCTS: the agent never reads the opponent's hidden cards or the true
// Dofus nature. Instead, for each decision it samples several plausible worlds
// (determinize), runs the search in each, and plays the move that is best on
// average across them. This is PIMC (Perfect Information Monte-Carlo), the
// standard way to apply tree search to an imperfect-information card game.
//
// `me`'s legal moves depend only on observable info (my hand, the board), so the
// action set is identical in every sampled world, which makes aggregating the
// root visit counts across worlds well-defined.
import type { Agent } from "./Agent";
import type { GameState } from "../../engine/state";
import type { Action } from "../actions";
import { actingSide } from "../actions";
import { MctsAgent, oneStepHeuristicScore, type MctsOptions, type LeafEval, type PriorFn } from "./MctsAgent";
import { EVAL_WEIGHTS } from "../eval";
import { Rng } from "../../engine/rng";
import { determinize, resampleEnemyReals } from "../determinize";
import { determinizeBelief } from "../belief/determinizeBelief";
import { determinizeInfere, mondesInferes, INFERENCE_DEFAUT, type OptionsInference } from "../belief/inferenceAdverse";
import type { CorpusBelief } from "../belief/corpus";
import type { God } from "../../data/types";
import type { Side } from "../../engine/board";
import { mulliganV1 } from "../mulligan";

export interface DetMctsOptions extends MctsOptions {
  worlds?: number; // how many determinised worlds to sample per decision
  // When set, worlds are sampled from the corpus belief (a plausible enemy decklist
  // that matches the public observations) instead of re-partitioning the enemy's
  // true unseen cards (which gives too much information about an unknown matchup).
  // Falls back to the plain determinize for an enemy god with no corpus.
  belief?: Map<God, CorpusBelief>;
  // Builds a leaf evaluator for each decision from the real root state (so a net
  // leaf can compute the root belief once and reuse it across worlds and leaves).
  // When set, it replaces the heuristic leaf eval inside the inner search.
  makeLeafEval?: (rootState: GameState, me: Side) => LeafEval;
  // Policy prior factory for each decision (built from the real root state, like
  // makeLeafEval). Drives PUCT in the inner search.
  makePriorFn?: (rootState: GameState, me: Side) => PriorFn;
  // π̄ act variant (Grill et al. 2020, "MCTS as Regularized Policy Optimization"):
  // the inner search runs with the value leaf only (no PUCT prior, which hurt at low
  // budget), then at the root the action is picked with the closed-form regularized
  // policy π̄(a) ∝ π(a)/(α−Q(a)). It mixes the search Q with the policy prior with a
  // weight λ ∝ √N/(N+|A|) that depends on the budget, which is what the paper
  // suggests for small budgets. Needs makePriorFn (the policy) for π and
  // makeLeafEval for Q.
  piBar?: boolean;
  piBarC?: number; // λ constant (default 1.5); higher = lean more on the prior
  // Root veto margin for this agent. Defaults to EVAL_WEIGHTS.rootVeto (100). Lets an
  // arena compare veto 60 and veto 100 without touching the shared constant.
  vetoMargin?: number;
  // Opponent-model rollout: for the root veto and tie-break, the deep projection
  // lets the opponent play (greedy completion, 3 plies) instead of passing. On by
  // default: on vs off scored 57.1% [50.8, 63.3] over 238 games (4 shards between
  // 52.5 and 65%). false gives the older pass rollout (used as the B arm in A/B tests).
  oppModel?: boolean;
  // Self-play generation only (wave 3+): while state.turn <= turns, sample the
  // root action ∝ pooled visits^(1/temperature) instead of argmax, the AlphaZero
  // opening-temperature ingredient that keeps deterministic self-play from
  // replaying the same lines (shared-blind-spot collapse). Seeded rng only, so
  // games stay reproducible. Never set in arenas or production (default = greedy).
  explore?: { turns: number; temperature?: number };
  // Size of the portfolio of opponent policies in the deep rollout (1 = the balanced
  // completion only, 2 = plus a rush, 3 = plus a control intent, the worst board is
  // kept). Default 1.
  oppK?: number;
  // Cheating agent, for measurement only: every world is the real state (the
  // opponent hand and the real Dofus are visible) and nothing is hidden at the root.
  // Playing it against the normal agent at the same budget bounds what any better
  // belief model could gain. Never used to play or to generate data.
  cheat?: boolean;
  // Root choice. Over 321 decisions at 2x80 the root visits are nearly uniform (the most
  // visited move gets 13% of the visits for about 8.6 candidates, second/first = 94% at the
  // median; UCB1 with c=1.4 almost takes turns when the q gaps are about 0.2), so "most
  // visited" carries little information and the heuristic tie-break decides: the move played
  // is not the most visited one in 69% of the decisions. "q" = after the veto, play the argmax
  // of the mean search value (ties broken by visits). Default "visits" (the old behaviour)
  // until an arena decides.
  // Ablation: "heur" = the rule layer alone chooses, the argmax of the one-step heuristic score
  // (oneStepHeuristicScore, the one of the veto and the tie-break) among the moves that pass the
  // veto; the visits only break exact ties. It measures what the search and value5 add on top
  // of the rules, with the same set of candidates. For measurement only.
  rootPick?: "visits" | "q" | "heur";
  // Honest root. The veto and the tie-break score each move on blindFoeDofuses(state), which
  // only hides the kind of the Dofus: the opponent model rollout (completeTurnGreedy) then makes
  // the opponent play the cards of its real hand. Measured: changing only the hidden hand
  // changes at least one score in 82% of the decisions, and the set that survives the veto in
  // 32%. true = the root layer works on a world drawn from the belief (opponent hand and deck
  // sampled, the draw fixed per decision), like the search. Required whenever the opponent's
  // hand is really unknown, as against a human. Default false (the old behaviour) until an
  // arena measures the gap.
  rootFair?: boolean;
  // Honest root with K worlds. In the arena, rootFair loses about 6 points against the root
  // that sees the real hand (p = 0.024); with a single draw of the opponent's hand, the
  // opponent model rollouts are noisy. K > 1 = each move is scored (veto, tie-break, "heur"
  // choice) by the mean of its score over K worlds drawn from the belief. K = 1 (default) =
  // rootFair unchanged.
  rootFairK?: number;
  // Inference from the opponent's last turn (belief/inferenceAdverse.ts). The worlds (search
  // and honest root) are drawn in excess, then resampled by the likelihood of the AP the
  // opponent left unused. true = default settings; an object = explicit settings. Off by default.
  inferAdv?: boolean | Partial<OptionsInference>;
}

export class DeterminizedMctsAgent implements Agent {
  readonly name: string;
  private readonly worlds: number;
  private readonly inner: MctsAgent;
  private readonly belief?: Map<God, CorpusBelief>;
  private readonly makeLeafEval?: (rootState: GameState, me: Side) => LeafEval;
  private readonly makePriorFn?: (rootState: GameState, me: Side) => PriorFn;
  private readonly piBar: boolean;
  private readonly piBarC: number;
  private readonly explore?: { turns: number; temperature?: number };
  private readonly vetoMargin?: number;
  private readonly oppModel: boolean;
  private readonly cheat: boolean;
  private readonly oppK: number;
  private readonly rootPick: "visits" | "q" | "heur";
  private readonly rootFair: boolean;
  private readonly rootFairK: number;
  private readonly inferOpts: OptionsInference | null;

  constructor(opts: DetMctsOptions = {}) {
    this.worlds = opts.worlds ?? 6;
    // With π̄, the inner search must run without the PUCT prior (value leaf only),
    // strip priorFn from the inner MctsAgent; the prior is used only at the root.
    this.inner = new MctsAgent(opts.piBar ? { ...opts, priorFn: undefined } : opts);
    this.belief = opts.belief;
    this.makeLeafEval = opts.makeLeafEval;
    this.makePriorFn = opts.makePriorFn;
    this.piBar = opts.piBar ?? false;
    this.piBarC = opts.piBarC ?? 1.5;
    this.explore = opts.explore;
    this.vetoMargin = opts.vetoMargin;
    this.oppModel = opts.oppModel ?? true;
    this.cheat = opts.cheat ?? false;
    this.oppK = opts.oppK ?? 1;
    this.rootPick = opts.rootPick ?? "visits";
    this.rootFair = opts.rootFair ?? false;
    this.rootFairK = Math.max(1, Math.floor(opts.rootFairK ?? 1));
    this.inferOpts = opts.inferAdv ? { ...INFERENCE_DEFAUT, ...(typeof opts.inferAdv === "object" ? opts.inferAdv : {}) } : null;
    const tag = ((opts.makeLeafEval ? "+v" : "") + (opts.makePriorFn ? "+p" : "") || (opts.belief ? "+belief" : "")) + (opts.cheat ? "+cheat" : "") + (opts.rootSH ? "+SH" : "") + (opts.expandBestFirst ? "+BF" : "") + (this.rootPick === "q" ? "+Q" : this.rootPick === "heur" ? "+H" : "") + (opts.rootFair ? `+fair${this.rootFairK > 1 ? this.rootFairK : ""}` : "") + (this.inferOpts ? "+S5" : "");
    this.name = `DetMCTS(${this.worlds}x${opts.simulations ?? 80}${tag}${opts.explore ? `+x${opts.explore.turns}` : ""})`;
  }

  chooseAction(state: GameState, legal: Action[], rng: Rng): Action {
    return this.chooseActionWithStats(state, legal, rng).action;
  }

  /** chooseAction plus the evidence behind it: the pooled root stats (visits and mean
   *  q per action) and the search's overall value of the position (visit-weighted
   *  mean q, from the acting side, in (−1,1)). The v2 recording uses this (soft π
   *  targets and root value for the mixed value label) at no extra search cost.
   *  stats is null for mulligan and forced moves. */
  chooseActionWithStats(state: GameState, legal: Action[], rng: Rng): {
    action: Action;
    stats: { action: Action; visits: number; q: number }[] | null;
    rootValue: number | null;
  } {
    // Mulligan v1 (documented heuristic, not searched, see mulligan.ts).
    if (state.mulligan) return { action: { kind: "mulligan", returnIndices: mulliganV1(state, state.mulligan.current) }, stats: null, rootValue: null };
    if (legal.length === 1) return { action: legal[0], stats: null, rootValue: null };
    const stats = this.aggregatedStats(state, rng);
    let vSum = 0, vN = 0;
    for (const s of stats) { vSum += s.q * s.visits; vN += s.visits; }
    const rootValue = vN > 0 ? vSum / vN : null;
    const action = this.piBar && this.makePriorFn && stats.length > 1
      ? this.piBarAction(state, stats)
      : this.pickFromStats(state, stats, rng);
    return { action, stats, rootValue };
  }

  /** π̄ act (Grill et al. 2020): pick the root action by the closed-form regularized
   *  policy π̄(a) ∝ π(a)/(α−Q(a)), α set so Σπ̄=1 (α>maxQ), λ=piBarC·√N/(N+|A|). At low
   *  N, λ is large → α large → π̄ leans on the prior π; as N grows, α→maxQ → π̄ leans on
   *  the search Q. Argmax π̄ is scale-invariant in λ, so λ acts purely through α. */
  private piBarAction(state: GameState, stats: { action: Action; visits: number; q: number }[]): Action {
    const me = actingSide(state);
    const priorFn = this.makePriorFn!(state, me);
    const raw = priorFn(state, stats.map((s) => s.action));
    let ps = 0;
    for (let i = 0; i < raw.length; i++) ps += Math.max(0, raw[i]);
    const A = stats.length;
    const pi = stats.map((_, i) => (ps > 0 ? Math.max(0, raw[i]) / ps : 1 / A));
    const q = stats.map((s) => s.q);
    const N = stats.reduce((a, s) => a + s.visits, 0);
    const lambda = this.piBarC * Math.sqrt(N) / (N + A);
    const maxQ = Math.max(...q);
    const sumAt = (alpha: number) => { let s = 0; for (let i = 0; i < A; i++) s += lambda * pi[i] / (alpha - q[i]); return s; };
    let lo = maxQ + 1e-6, hi = maxQ + 2 + lambda * A;
    while (sumAt(hi) > 1 && hi < maxQ + 1e6) hi *= 2;
    for (let it = 0; it < 40; it++) { const mid = (lo + hi) / 2; if (sumAt(mid) > 1) lo = mid; else hi = mid; }
    const alpha = (lo + hi) / 2;
    let best = 0, bestV = -Infinity;
    for (let i = 0; i < A; i++) { const v = pi[i] / (alpha - q[i]); if (v > bestV) { bestV = v; best = i; } }
    return stats[best].action;
  }

  private pickFromStats(state: GameState, statsIn: { action: Action; visits: number; q: number }[], rng: Rng): Action {
    // Information fairness: the veto / tie-break / plan rollouts used to run on the
    // true state, so when a simulated line broke a hidden enemy Dofus within the
    // horizon, its real kind leaked into the score (measured: +999,700 for sniping the
    // hidden real Dofus against the hidden fake one). The score is computed on a
    // blinded state instead: enemy Dofus kinds are re-sampled with a deterministic
    // per-decision seed shared by every candidate, the same information the search
    // has in its own determinized worlds.
    const mondes = this.cheat ? [state] : this.rootFair ? this.fairRoots(state) : [blindFoeDofuses(state)]; // the cheating agent keeps the truth up to the veto and tie-break
    const blind = mondes[0];
    const meRacine = actingSide(state);
    // Root score of a move: the mean over the worlds (only one unless rootFairK > 1).
    const scoreRacine = (a: Action): number => {
      let t = 0;
      for (const m of mondes) t += oneStepHeuristicScore(m, a, meRacine, true, true, this.oppModel, this.oppK);
      return t / mondes.length;
    };
    // Root sanity veto: drop root actions that the one-step heuristic rates far below
    // the best-scored root action. The 85% tie-break below only decides near-ties, so
    // a value net that strongly preferred a line that does nothing (charging the
    // opponent's creature for nothing, a spell with zero effect) used to get through.
    // Also applied to exploration sampling, since there is no reason to learn bad lines.
    const stats = vetoByHeuristic(blind, statsIn, this.vetoMargin, this.oppModel, this.oppK, scoreRacine);
    if (this.explore && state.turn <= this.explore.turns) {
      const pick = this.sampleByVisits(stats, this.explore.temperature ?? 1, rng);
      if (pick) return pick;
    }
    if (this.rootPick === "heur") {
      // See DetMctsOptions.rootPick: argmax of the rule score, ties broken by visits.
      let best: { action: Action; score: number; visits: number } | null = null;
      for (const v of stats) {
        const score = scoreRacine(v.action);
        if (!best || score > best.score || (score === best.score && v.visits > best.visits)) best = { action: v.action, score, visits: v.visits };
      }
      return best!.action;
    }
    if (this.rootPick === "q") {
      // See DetMctsOptions.rootPick: the veto stays, the heuristic tie-break at 85% of
      // the visits is replaced by the value of the search.
      let bestQ = stats[0];
      for (const v of stats) {
        if (v.visits === 0) continue;
        if (bestQ.visits === 0 || v.q > bestQ.q || (v.q === bestQ.q && v.visits > bestQ.visits)) bestQ = v;
      }
      return bestQ.action;
    }
    // Sanity tie-break: the pooled visit counts are the main signal, but when several
    // root actions are within a small margin of the top, the value net could not
    // really separate them, and picking at random there let bad moves through (a
    // Fléau on your own Dofus, burning the AP reserve for nothing). Among near-tied
    // actions we pick by the one-step heuristic score instead, which does count wasted
    // resources (reserve -7/AP) and damage to your own Dofus (-120/pt real, -30/pt fake).
    let maxVisits = 0;
    for (const v of stats) if (v.visits > maxVisits) maxVisits = v.visits;
    const near = stats.filter((v) => v.visits >= maxVisits * 0.85);
    if (near.length === 1) return near[0].action;
    let best: { action: Action; score: number } | null = null;
    for (const v of near) {
      const score = scoreRacine(v.action); // rules 8+10 on the blinded state (info-fairness), averaged over the root worlds
      if (!best || score > best.score || (score === best.score && rng.next() < 0.5)) best = { action: v.action, score };
    }
    return best!.action;
  }

  /** See DetMctsOptions.rootFair: the world on which the root layer (veto, tie-break,
   *  rollouts) scores the moves. Opponent hand and deck drawn from the belief (or
   *  shuffled again without a belief), kind of the enemy Dofus hidden exactly as in
   *  blindFoeDofuses. The draw comes from state.rng: the same for every move of a
   *  decision, reproducible, independent of the agent's rng. */
  private fairRoot(state: GameState, k = 0): GameState {
    const me = actingSide(state);
    // k = 0: the same seed as before the K option (rootFair with K = 1 strictly unchanged).
    const rng = new Rng((state.rng ^ 0x5eedfa1 ^ Math.imul(k, 0x9e3779b1)) | 0);
    const w = this.belief ? determinizeBelief(state, me, this.belief, rng) : determinize(state, me, rng);
    return { ...w, dofuses: blindFoeDofuses(state).dofuses };
  }

  /** The K worlds of the honest root (see DetMctsOptions.rootFairK). */
  private fairRoots(state: GameState): GameState[] {
    if (this.inferOpts) {
      // K worlds kept out of K × candidates, a reproducible draw per decision.
      let k = 0;
      return mondesInferes(this.rootFairK, () => this.fairRoot(state, k++), actingSide(state), new Rng((state.rng ^ 0x5e5e5) | 0), this.inferOpts);
    }
    const out: GameState[] = [];
    for (let k = 0; k < this.rootFairK; k++) out.push(this.fairRoot(state, k));
    return out;
  }

  /** Opening temperature: sample ∝ visits^(1/T) among positively-visited actions.
   *  Returns null when nothing has visits (caller falls back to greedy). */
  private sampleByVisits(stats: { action: Action; visits: number }[], temp: number, rng: Rng): Action | null {
    const pos = stats.filter((s) => s.visits > 0);
    if (pos.length === 0) return null;
    const weights = pos.map((s) => Math.pow(s.visits, 1 / Math.max(temp, 1e-3)));
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rng.next() * total;
    for (let i = 0; i < pos.length; i++) {
      r -= weights[i];
      if (r <= 0) return pos[i].action;
    }
    return pos[pos.length - 1].action;
  }

  /** Pooled root visit counts per action, aggregated over the sampled worlds: the
   *  PIMC policy signal (used by chooseAction and by the policy-data recorder to
   *  build π targets). */
  aggregatedStats(state: GameState, rng: Rng): { action: Action; visits: number; q: number }[] {
    const me = actingSide(state);
    // Build the per-decision leaf eval + prior once (capture the root belief),
    // reused for every world + node in this decision.
    const leafEval = this.makeLeafEval?.(state, me);
    // π̄ mode: the inner search runs value-only (no PUCT prior); the policy is used
    // solely at the root by piBarAction. Otherwise the prior drives PUCT as before.
    const priorFn = this.piBar ? undefined : this.makePriorFn?.(state, me);
    // q pooled across worlds VISIT-WEIGHTED (qSum accumulates q×visits).
    const votes = new Map<string, { action: Action; visits: number; qSum: number }>();
    // Worlds drawn in excess then resampled (otherwise: the usual draw, unchanged).
    const inferes = this.inferOpts && !this.cheat ? determinizeInfere(state, me, this.belief ?? undefined, this.worlds, rng, this.inferOpts) : null;
    for (let w = 0; w < this.worlds; w++) {
      const world = inferes ? inferes[w] : this.cheat ? state : this.belief ? determinizeBelief(state, me, this.belief, rng) : determinize(state, me, rng);
      for (const s of this.inner.searchRootStats(world, rng, leafEval, priorFn)) {
        const key = JSON.stringify(s.action);
        const cur = votes.get(key);
        if (cur) { cur.visits += s.visits; cur.qSum += s.q * s.visits; }
        else votes.set(key, { action: s.action, visits: s.visits, qSum: s.q * s.visits });
      }
    }
    return [...votes.values()].map((v) => ({ action: v.action, visits: v.visits, q: v.visits > 0 ? v.qSum / v.visits : 0 }));
  }
}

/** Root sanity veto. Keeps only the pooled root stats whose one-step heuristic
 *  score is within EVAL_WEIGHTS.rootVeto of the best-scored root action. The
 *  heuristic simulates the end of the turn, so lines that do nothing (a spell
 *  with zero effect, a buff on a creature that breaks through and leaves with it,
 *  charging the opponent's creature for nothing) score far below the best action
 *  and are vetoed however hard the value net pushes them. Pure and exported for
 *  the sanity tests. Never returns an empty list (the heuristic-best action
 *  always survives). */
export function vetoByHeuristic<T extends { action: Action }>(state: GameState, stats: T[], margin?: number, oppModel = false, oppK = 1, score?: (a: Action) => number): T[] {
  if (stats.length <= 1) return stats;
  const me = actingSide(state);
  const m = margin ?? EVAL_WEIGHTS.rootVeto;
  // `score`: a scoring given by the agent (e.g. the mean over K root worlds); otherwise a single state.
  const scored = stats.map((s) => ({ s, h: score ? score(s.action) : oneStepHeuristicScore(state, s.action, me, true, true, oppModel, oppK) })); // rules 8+10: same metric as the tie-break (deep+plan); a veto judged at a shorter horizon could veto the plan-best action
  let hBest = -Infinity;
  for (const e of scored) if (e.h > hBest) hBest = e.h;
  const kept = scored.filter((e) => e.h >= hBest - m).map((e) => e.s);
  return kept.length > 0 ? kept : stats;
}

/** Information fairness helper: re-sample the enemy's hidden Dofus kinds with a
 *  deterministic per-decision seed (derived from the match rng), so the root
 *  heuristic layer (veto / tie-break / plan rollouts) never scores against the
 *  truth. All candidates of one decision share the same sampled hypothesis.
 *  Exported for the fairness test. */
export function blindFoeDofuses(state: GameState): GameState {
  const me = actingSide(state);
  const foe: Side = me === "ally" ? "enemy" : "ally";
  return {
    ...state,
    dofuses: resampleEnemyReals(state.dofuses, foe, new Rng((state.rng ^ 0xd0f05eed) | 0), state.destroyedDofuses),
  };
}
