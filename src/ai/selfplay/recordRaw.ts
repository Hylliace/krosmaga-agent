// Raw self-play recorder. A game is stored as (decks, seed, firstSide, compact
// actions, result, matchup), ~1-3 KB, instead of encoded samples. Since the engine
// is a pure function of (seed, actions) (checked by the determinism tests), the game
// replays exactly, so it can be encoded again with any later encoding without
// running the expensive search again. The search is paid only once.
import type { Side } from "../../engine/board";
import type { God } from "../../data/types";
import { createInitialState } from "../../engine/rules";
import { Rng } from "../../engine/rng";
import type { Agent } from "../agents/Agent";
import { actingSide, legalActions, applyAction, type Action } from "../actions";

// Compact action codes (rebuild the exact Action on replay):
//  mulligan -> [0, mask]   play -> [1, cardId, x, y]   resolve -> [2, x, y]
//  cancel   -> [3]         reserve -> [4]              endTurn -> [5]
export type RawAction = number[];

export interface RawMatchup {
  a: { id?: string; god?: God; author?: string; tags?: string[]; w?: number };
  e: { id?: string; god?: God; author?: string; tags?: string[]; w?: number };
  wc?: number; // wCost (importance weight; the deck weight is META, never mixed into the value signal)
}

export interface RawGame {
  v: "raw-v1";
  seed: number;
  first: Side;
  decks: { a: number[]; e: number[] }; // Unshuffled (45 each); shuffle is derived from seed at replay
  acts: RawAction[];
  res: { w: 0 | 1 | -1; turns: number; plies: number }; // 1=ally wins, -1=enemy, 0=draw(cap)
  mu?: RawMatchup;
  ag?: { a: string; e: string };
  eng?: string; // engine git sha, stamped by the generator
  // v2 search recording: for each searched decision, the pooled root visit
  // distribution (soft π target for the policy net) and the search's value of the
  // position (the low-noise half of the mixed value label). The search computes them
  // anyway, so recording them is free. `i` = index into `acts`; `s` =
  // [rawAction, visits, q(3dp)] per root candidate; `rv` = visit-weighted root value.
  pis?: { i: number; rv: number; s: [RawAction, number, number][] }[];
}

export interface RawStuckInfo {
  seed: number; turn: number; side: Side; plies: number;
  pending: string | null; recentMix: Record<string, number>; mu?: RawMatchup;
}

export function encodeAction(a: Action): RawAction {
  switch (a.kind) {
    case "mulligan": { let mask = 0; for (const i of a.returnIndices) mask |= 1 << i; return [0, mask]; }
    case "play": return [1, a.cardId, a.target.x, a.target.y];
    case "resolve": return [2, a.target.x, a.target.y];
    case "cancel": return [3];
    case "reserve": return [4];
    case "endTurn": return [5];
  }
}

export function decodeAction(r: RawAction): Action {
  switch (r[0]) {
    case 0: { const idx: number[] = []; for (let i = 0; i < 30; i++) if (r[1] & (1 << i)) idx.push(i); return { kind: "mulligan", returnIndices: idx }; }
    case 1: return { kind: "play", cardId: r[1], target: { x: r[2], y: r[3] } };
    case 2: return { kind: "resolve", target: { x: r[1], y: r[2] } };
    case 3: return { kind: "cancel" };
    case 4: return { kind: "reserve" };
    case 5: return { kind: "endTurn" };
    default: throw new Error(`bad raw action code ${r[0]}`);
  }
}

export interface RecordRawOptions {
  decks: Record<Side, number[]>;
  seed: number;
  firstSide?: Side;
  gods?: Record<Side, God>;
  maxTurns?: number;
  maxPlies?: number;
  mu?: RawMatchup;
  agents?: { a: string; e: string };
  onStuck?: (info: RawStuckInfo) => void;
  // v2: record the search evidence (pooled visit distribution + root value) for
  // every searched decision, via the agent's chooseActionWithStats when it has
  // one. Free at generation time; enables soft-π policy targets + mixed value
  // labels at encode time.
  recordSearch?: boolean;
}

// Duck-typed extension implemented by DeterminizedMctsAgent (kept structural so
// recordRaw does not depend on the agent class).
interface SearchStatsAgent extends Agent {
  chooseActionWithStats(state: ReturnType<typeof createInitialState>, legal: Action[], rng: Rng): {
    action: Action;
    stats: { action: Action; visits: number; q: number }[] | null;
    rootValue: number | null;
  };
}
const hasSearchStats = (a: Agent): a is SearchStatsAgent =>
  typeof (a as Partial<SearchStatsAgent>).chooseActionWithStats === "function";
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Within-turn transposition signature: the whole state minus the two fields that
 *  grow on every ply even when nothing meaningful changes, `log` (append-only)
 *  and `nextInstanceId` (a monotonic counter). Sets (creature.properties) become
 *  sorted arrays so they actually serialise. Two pending-free decision states with
 *  the same signature are functionally identical (same board / hands / resources /
 *  rng), so revisiting one within A turn means the turn cannot make progress,
 *  the fingerprint of a no-op cycle like Pampactus #218's play->cancel->play. */
function turnStateSig(s: unknown): string {
  return JSON.stringify(s, (k, v) =>
    k === "log" || k === "nextInstanceId" ? undefined : v instanceof Set ? [...v].sort() : v,
  );
}

/** Play a game and return its RawGame, or null if it hit the ply cap (stuck). */
export function recordGameRaw(agentA: Agent, agentB: Agent, opts: RecordRawOptions): RawGame | null {
  const maxTurns = opts.maxTurns ?? 200;
  const maxPlies = opts.maxPlies ?? 1500;
  let state = createInitialState(opts.decks, { seed: opts.seed, firstSide: opts.firstSide, gods: opts.gods });
  const agentRng = new Rng((opts.seed ^ 0x9e3779b9) | 0);
  const acts: RawAction[] = [];
  const pis: NonNullable<RawGame["pis"]> = [];
  let plies = 0;
  const mix: Record<string, number> = {};
  // Within-turn no-progress guard (see turnStateSig): break play->cancel livelocks
  // (Pampactus #218) by ending the turn the instant a pending-free state recurs,
  // the agent already had nothing better than a no-op cycle, so passing is correct.
  // Off in the engine (the cancel take-back is a legit human misclick affordance);
  // this lives in the AI driver only. Reset each time the acting side changes.
  let guardActor: Side | null = null;
  const seenThisTurn = new Set<string>();
  while (state.winner === null && state.turn <= maxTurns) {
    const side = actingSide(state);
    if (side !== guardActor) { guardActor = side; seenThisTurn.clear(); }
    if (state.pendingAction === null) {
      const sig = turnStateSig(state);
      if (seenThisTurn.has(sig)) {
        acts.push(encodeAction({ kind: "endTurn" }));
        state = applyAction(state, { kind: "endTurn" });
        if (++plies > maxPlies) { opts.onStuck?.({ seed: opts.seed, turn: state.turn, side, plies, pending: "GUARD-endTurn loop", recentMix: mix, mu: opts.mu }); return null; }
        continue;
      }
      seenThisTurn.add(sig);
    }
    const legal = legalActions(state);
    if (legal.length === 0) {
      // A non-terminal state with no legal action = a HARD-LOCK (a non-optional
      // pending that opened with zero valid targets, or an unescapable pick).
      // Post-fix this should be impossible; if it ever recurs, log it loudly as a
      // stuck game (with a HARDLOCK marker + the pick's prompt) instead of letting
      // it fall through to a silent winner-less "draw" that quietly pollutes the
      // corpus. Discarded like any stuck game (return null).
      const pa = state.pendingAction;
      opts.onStuck?.({ seed: opts.seed, turn: state.turn, side, plies, pending: pa ? `HARDLOCK ${pa.prompt ?? "pending"}` : "HARDLOCK (no pending)", recentMix: mix, mu: opts.mu });
      return null;
    }
    const agent = side === "ally" ? agentA : agentB;
    let action: Action;
    if (opts.recordSearch && hasSearchStats(agent)) {
      const r = agent.chooseActionWithStats(state, legal, agentRng);
      action = r.action;
      if (r.stats && r.stats.length > 0) {
        pis.push({ i: acts.length, rv: r3(r.rootValue ?? 0), s: r.stats.map((st) => [encodeAction(st.action), st.visits, r3(st.q)] as [RawAction, number, number]) });
      }
    } else {
      action = agent.chooseAction(state, legal, agentRng);
    }
    acts.push(encodeAction(action));
    const key = `${side}:${action.kind}` + (action.kind === "play" ? `#${action.cardId}` : "");
    mix[key] = (mix[key] ?? 0) + 1;
    const pa = state.pendingAction;
    const pendingSummary = pa ? `${pa.prompt ?? "pending"}${pa.summonAfter ? ` summon#${pa.summonAfter.cardId}` : ""}` : null;
    state = applyAction(state, action);
    if (++plies > maxPlies) {
      opts.onStuck?.({ seed: opts.seed, turn: state.turn, side, plies, pending: pendingSummary, recentMix: mix, mu: opts.mu });
      return null;
    }
  }
  const winner = state.winner;
  return {
    v: "raw-v1",
    seed: opts.seed,
    first: opts.firstSide ?? "ally",
    decks: { a: opts.decks.ally, e: opts.decks.enemy },
    acts,
    res: { w: winner === null ? 0 : winner === "ally" ? 1 : -1, turns: state.turn, plies },
    mu: opts.mu,
    ag: opts.agents,
    ...(opts.recordSearch && pis.length > 0 ? { pis } : {}),
  };
}

/** Replay a RawGame by applying its stored actions again, yielding each decision
 *  point except the mulligan (state, mover), which is what re-encoding uses, plus the
 *  final result. gods are taken from `mu` if present (they do not affect game logic,
 *  only the encoding). */
export function replayRaw(raw: RawGame): { steps: { state: ReturnType<typeof createInitialState>; mover: Side }[]; w: 0 | 1 | -1; turns: number } {
  const gods = raw.mu?.a.god && raw.mu?.e.god ? { ally: raw.mu.a.god, enemy: raw.mu.e.god } : undefined;
  let state = createInitialState({ ally: raw.decks.a, enemy: raw.decks.e }, { seed: raw.seed, firstSide: raw.first, gods });
  const steps: { state: ReturnType<typeof createInitialState>; mover: Side }[] = [];
  for (const r of raw.acts) {
    const side = actingSide(state);
    if (!state.mulligan) steps.push({ state, mover: side }); // skip mulligan positions (no board)
    state = applyAction(state, decodeAction(r));
  }
  const winner = state.winner;
  return { steps, w: winner === null ? 0 : winner === "ally" ? 1 : -1, turns: state.turn };
}
