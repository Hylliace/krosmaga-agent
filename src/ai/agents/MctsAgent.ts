// Monte-Carlo Tree Search agent, the first agent that genuinely anticipates
// several moves ahead, modelling the opponent's best replies.
//
// The loop, run `simulations` times per decision:
//   1. DESCENDRE, from the root, follow UCB until a not-fully-expanded node.
//   2. AJOUTER, expand one untried action into a new child.
//   3. ÉVALUER, score the new leaf with the heuristic eval (truncated
//                    rollout, AlphaZero-style; far more stable than random
//                    playouts and reuses our strong eval).
//   4. REMONTER, add the value back up the path.
// Then play the root's MOST-VISITED child (the line the search kept returning to).
//
// Perspective: every value is from `rootSide` (the side to move at the root).
// A node where the opponent moves therefore minimises that value, adversarial
// (minimax-flavoured) search. The sign in selectChild encodes that.
//
// M3a simplification (perfect information + fixed chance): the search reads the
// full GameState, including the opponent's hand, and the engine's chance is
// fixed by `state.rng` (so the tree is deterministic). Both are temporary, M3b
// adds DETERMINISATION (sample plausible hidden hands/decks, re-seed chance) to
// make it fair against unknown decks. Here we only want to prove the engine
// plays strongly.
import type { Agent } from "./Agent";
import type { GameState } from "../../engine/state";
import type { Side } from "../../engine/board";
import { BOARD_COLS } from "../../engine/board";
import type { Rng } from "../../engine/rng";
import type { Action } from "../actions";
import { actingSide, legalActions, applyAction, declineCell } from "../actions";
import { validPendingTargets, resolvePendingAction, conditionMet, MAX_HAND } from "../../engine/rules";
import { effectRequiresTarget } from "../../engine/effects";
import { evaluate, EVAL_WEIGHTS, ownDofusSubscore, dofusProgress, turnsToReach } from "../eval";
import { getCard } from "../../engine/cardRegistry";

const END_TURN: Action = { kind: "endTurn" };

/** One-step heuristic score of playing `a` from `state`, for `side`: apply the
 *  action, auto-resolve up to 4 pending picks (first valid target / decline),
 *  then score the end-of-turn board with the hand-written evaluate(). Used as
 *  the candidate prior and as the root sanity tie-break in the determinized
 *  agent: when the value net cannot separate near-equal moves, this is what
 *  knows that a wasted reserve or a damaged own Dofus is worse. */
/** Settle any pending picks (first valid target / decline), bounded. */
function settleHops(s: GameState): GameState {
  let cur = s;
  for (let hops = 0; cur.pendingAction && cur.winner === null && hops < 4; hops++) {
    const t = validPendingTargets(cur)[0] ?? (cur.pendingAction.optional ? declineCell(cur) : null);
    if (!t) break;
    const next = resolvePendingAction(cur, t);
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

/** Rule 8: look one more turn ahead. From a board where it is the opponent's
 *  turn, let them pass and run their end of turn: their creatures advance and
 *  fight (deterministic). A boost on a creature that this board kills anyway is
 *  worth nothing at this horizon (it advanced 4 cells instead of 3 and died all
 *  the same). Cards the opponent might play are ignored on purpose: that part is
 *  the search's job, this is the cheap certain part. */
function opponentPassRollout(s: GameState): GameState {
  if (s.winner !== null || s.pendingAction || s.mulligan) return s;
  return settleHops(applyAction(s, END_TURN));
}

// Rule 9: the "do nothing" counterfactual: pass from the root state, then the
// opponent-pass rollout, at the same horizon as the deep action lines. Memoized
// per root state object (immutable), since the root scoring loop calls this once
// per candidate action of the same state.
const passBaselineCache = new WeakMap<GameState, GameState>();
const passBaselineCacheOpp = new WeakMap<GameState, GameState>();
function passBaseline(state: GameState, oppModel = false): GameState {
  const cache = oppModel ? passBaselineCacheOpp : passBaselineCache;
  const hit = cache.get(state);
  if (hit) return hit;
  const myEnd = settleHops(applyAction(state, END_TURN));
  const b = oppModel ? opponentModelRollout(myEnd) : opponentPassRollout(myEnd);
  cache.set(state, b);
  return b;
}

/** Opponent-model rollout. A class of mistakes that survived the first 25 rules
 *  (defending a Scarafon, Heure de Gloire on a survivor at 2 HP, defending the
 *  Wabbit's lane, "the enemy will just play another creature") all comes from the
 *  same gap: the deep rollout makes the opponent pass, so defending never pays off
 *  (the threat never plays) and a fragile survivor looks safe (nothing comes to
 *  finish it). Here the opponent plays its turn: a greedy completion with the
 *  shallow score from its own point of view (reusing completeTurnGreedy from rule
 *  10, 3 plies at most), then its end of turn. It only runs at the root (veto and
 *  tie-break). Can be switched per agent (oppModel option) for on/off A/B tests. */
function opponentModelRollout(s: GameState): GameState {
  if (s.winner !== null || s.pendingAction || s.mulligan) return s;
  const foe = actingSide(s);
  const played = completeTurnGreedy(s, foe, 3);
  if (played.winner !== null || played.pendingAction) return played;
  return settleHops(applyAction(played, END_TURN));
}

// Rule 13 v2: the short pass probe (my end of turn without playing and without the
// opponent rollout), at the same horizon as `myEnd`, to measure what a spell does
// on top of doing nothing. Memoized per root state (immutable).
const shallowPassCache = new WeakMap<GameState, GameState>();
function shallowPassProbe(state: GameState): GameState {
  const hit = shallowPassCache.get(state);
  if (hit) return hit;
  const b = settleHops(applyAction(state, END_TURN));
  shallowPassCache.set(state, b);
  return b;
}

/** Rule 10 (e.g. Sono Sino before the two Gzenahs): scoring each candidate as if
 *  the turn stopped there favours playing the big card first and misses ordering
 *  synergies inside the turn (Gzenah buffs every later Iop entry; Sono Sino's
 *  apparition checks the board it lands on). So the rest of my turn is played out
 *  greedily (each step picked by the shallow one-step score), and a root candidate
 *  is judged by the whole turn it starts. Since this is planned again at every
 *  real decision, the greedy completion settles on the right order. */
function completeTurnGreedy(start: GameState, side: Side, maxPlies = 5): GameState {
  let cur = start;
  for (let ply = 0; ply < maxPlies; ply++) {
    if (cur.winner !== null || cur.mulligan || cur.pendingAction || actingSide(cur) !== side) break;
    const acts = legalActions(cur).filter((x) => x.kind !== "endTurn");
    if (acts.length === 0) break;
    let best: Action | null = null;
    let bestScore = oneStepHeuristicScore(cur, END_TURN, side); // continuing must beat stopping
    for (const x of acts) {
      const sc = oneStepHeuristicScore(cur, x, side);
      if (sc > bestScore) { bestScore = sc; best = x; }
    }
    if (!best) break;
    cur = settleHops(applyAction(cur, best));
  }
  return cur;
}

export function oneStepHeuristicScore(state: GameState, a: Action, side: Side, deep = false, plan = false, oppModel = false): number {
  let after = applyAction(state, a);
  // Rule 7 (e.g. Glaie #126 played alone on turn 2): an APPARITION pick whose only
  // valid target is the summon itself (or nothing at all) cannot put its effect
  // where it matters. It has to be detected before the auto-resolve below uses up
  // the pick. Two shapes, same waste:
  //   - the pick opened but every target is the summon's own cell;
  //   - the pick never opened although the card has an APPARITION that needs a
  //     target (no valid target, so the engine skips it silently, the Glaie-alone
  //     case). A single external target always opens the pick in this engine, so
  //     "no pending" here can only mean it fizzled.
  // The penalty itself is applied in the Summon branch.
  let pickSelfOnly = false;
  if (a.kind === "play" && after.winner === null) {
    if (after.pendingAction) {
      const tgts = validPendingTargets(after);
      pickSelfOnly = tgts.length === 0 || tgts.every((t) => t.x === a.target.x && t.y === a.target.y);
    } else {
      const card = getCard(a.cardId);
      if (card && card.cardType === "Summon" &&
          (card.triggers ?? []).some((t) => t.trigger === "APPARITION" && t.effects.some((e) => effectRequiresTarget(e)))) {
        pickSelfOnly = true;
      }
    }
    // Rule 15 (e.g. Kamasutar played with a full hand, so its draw "si main < 4" could
    // not happen): an APPARITION where every effect has a requireCondition that is
    // false at the moment of the summon is wasted, same treatment as a pick with no
    // external target (rule 7: the effect share is floored at half the cost). It uses
    // the engine's own evaluator (conditionMet, on the state after the summon, like
    // runTrigger), only for conditions that do not depend on the summoned creature;
    // an unknown condition is treated as live, so there are no false positives.
    if (!pickSelfOnly) {
      const card = getCard(a.cardId);
      const SAFE_CONDS = new Set(["handBelow", "reserveAtLeast", "reserveEmpty", "discardAtLeast", "noDofusDestroyed", "outnumbered", "seedInPlay"]);
      const appEffs = (card?.triggers ?? []).filter((t) => t.trigger === "APPARITION").flatMap((t) => t.effects);
      if (
        appEffs.length > 0 &&
        appEffs.every((e) => {
          const cond = (e as { requireCondition?: { kind: string } }).requireCondition;
          if (cond && SAFE_CONDS.has(cond.kind) && !conditionMet(after, side, cond as never)) return true;
          // Same idea (e.g. Noxine played with no AP to steal): StealReserve on an empty
          // enemy reserve steals nothing. The effect is certainly dead when played, so the
          // card is better kept until stealing really takes a resource away.
          if (e.type === "StealReserve" && state.players[side === "ally" ? "enemy" : "ally"].apReserve <= 0) return true;
          return false;
        })
      ) {
        pickSelfOnly = true;
      }
    }
  }
  for (let hops = 0; after.pendingAction && after.winner === null && hops < 4; hops++) {
    const tgts = validPendingTargets(after);
    let t = tgts[0] ?? (after.pendingAction.optional ? declineCell(after) : null);
    // Smarter target choice in deep mode (the "first target" of the scan was sometimes
    // the enemy creature, so the probe buffed the opponent and buried the card). For
    // the root veto and tie-break we take the target that maximises the immediate
    // eval (at most 12 targets); the hot shallow paths keep the first target.
    if (deep && tgts.length > 1 && tgts.length <= 12) {
      let bestE = -Infinity;
      for (const cand of tgts) {
        const r = resolvePendingAction(after, cand);
        if (r === after) continue;
        const e = evaluate(r, side);
        if (e > bestE) { bestE = e; t = cand; }
      }
    }
    if (!t) break;
    const next = resolvePendingAction(after, t);
    if (next === after) break;
    after = next;
  }
  // Unspent AP are lost when the turn ends (startTurn resets ap), so that
  // opportunity cost is charged to every line that ends the turn (spend all the
  // AP you have; cashing the reserve and passing is twice as wasteful, since the
  // banked AP would have stayed).
  if (a.kind === "endTurn") {
    const board = deep ? (oppModel ? opponentModelRollout(after) : opponentPassRollout(after)) : after;
    // Rule 27: ending your own turn with a full hand burns next turn's draw.
    const burn = state.players[side].hand.length >= MAX_HAND ? EVAL_WEIGHTS.handFullBurn : 0;
    return evaluate(board, side) - EVAL_WEIGHTS.wastedAp * state.players[side].ap - burn;
  }
  if (after.pendingAction || after.mulligan || after.winner !== null) {
    return evaluate(after, side);
  }
  // Rule 10: judge the candidate by the whole turn it starts (root plan mode).
  if (plan) after = completeTurnGreedy(after, side);
  const myEnd = settleHops(applyAction(after, END_TURN));
  const board = deep ? (oppModel ? opponentModelRollout(myEnd) : opponentPassRollout(myEnd)) : myEnd;
  let score = evaluate(board, side) - EVAL_WEIGHTS.wastedAp * after.players[side].ap;
  // Rule 27: if the action line still ends with a full hand, the next draw burns,
  // same penalty.
  if (after.players[side].hand.length >= MAX_HAND) score -= EVAL_WEIGHTS.handFullBurn;
  // Rule 9 (e.g. Autorité on an opponent creature next to the AI's own real Dofus):
  // a counterfactual guard against the horizon effect. Compare my own Dofus at this
  // horizon against the pass line: if my action left them worse than doing nothing
  // (I paid to speed up my own loss), charge the full difference. Deep/root only;
  // pending states have no pass baseline.
  if (deep && state.pendingAction === null) {
    const ownAction = ownDofusSubscore(board, side);
    const ownPass = ownDofusSubscore(passBaseline(state, oppModel), side);
    if (ownAction < ownPass) score -= EVAL_WEIGHTS.dofusAccel * (ownPass - ownAction);
  }
  // Rule 3, stricter: cashing the reserve is only worth it when it unlocks a play
  // this turn. Compare the playable cardIds before and after the cash: if nothing
  // new becomes affordable, the cashed AP can only vanish at the end of the turn
  // (the banked reserve would have stayed). A flat penalty, sized to trigger the
  // root veto (the plain ~22/AP gap slipped under it in real games).
  if (a.kind === "reserve") {
    const playableIds = (s: GameState): Set<number> => {
      const ids = new Set<number>();
      for (const act of legalActions(s)) if (act.kind === "play") ids.add(act.cardId);
      return ids;
    };
    const before = playableIds(state);
    let unlocked = false;
    for (const id of playableIds(after)) if (!before.has(id)) { unlocked = true; break; }
    if (!unlocked) score -= EVAL_WEIGHTS.pointlessCash;
    // Early reserve: the reserveEarly bonus values banked AP because it turns into
    // tempo later. A cash that unlocks a card is exactly that, so it keeps the bonus;
    // otherwise the rule would punish the very plan it supports (bank to play earlier).
    if (unlocked && state.turn <= 4) score += EVAL_WEIGHTS.reserveEarly * state.players[side].apReserve;
  }
  // Rule 4: an effect summon whose price partly comes from its effect loses that
  // share when played just to spend AP. The eval difference only counts what the
  // effect actually changed on the board, so subtracting the effect share means a
  // fizzled effect keeps the card in hand, while an effect that lands (an aura on
  // allies, an enabled kill...) still beats passing. Vanilla bodies (no effects)
  // are worth their stats: no penalty, play them freely.
  if (a.kind === "play") {
    const card = getCard(a.cardId);
    if (card && card.cardType === "Summon") {
      const hasEffect =
        (card.effects?.length ?? 0) + (card.triggers?.length ?? 0) + (card.properties?.length ?? 0) > 0;
      if (hasEffect) {
        const body = EVAL_WEIGHTS.boardStat * ((card.attack ?? 0) + (card.life ?? 0)) + EVAL_WEIGHTS.mobility * (card.movement ?? 0);
        let effectShare = Math.max(0, EVAL_WEIGHTS.costWorth * (card.cost ?? 0) - body);
        // Rule 7: when the apparition pick can only target the summon itself (or
        // nothing), the real value of the effect (Glaie's +1 PM as a surprise on a
        // creature one turn away from the enemy Dofus) certainly cannot happen this turn.
        // The wasted share is floored at half the card's AP worth, so playing it on curve
        // loses to keeping it, even for cards whose body almost covers their cost (Glaie
        // 2/2 PM3 at 2 AP: share 15 floored to 35, so the turn-2 solo play now waits).
        // Same for Glaie-like cards: a summon that speeds up allies (APPARITION
        // BoostMovement) is in its surprise window when the boost brings a creature to
        // one turn or less from the Dofus while it was two or more turns away. Outside
        // that window it gets the same floor as a pick with no target (rule 7).
        if (!pickSelfOnly &&
            (card.triggers ?? []).some((t) => t.trigger === "APPARITION" && t.effects.some((e) => e.type === "BoostMovement"))) {
          const before = new Map(state.creatures.map((c) => [c.instanceId, turnsToReach(state, c)]));
          const converts = after.creatures.some(
            (c) => c.owner === side && c.currentLife > 0 &&
              turnsToReach(after, c) <= 1 && (before.get(c.instanceId) ?? Infinity) > 1,
          );
          if (!converts) pickSelfOnly = true;
        }
        // Rule 26 (e.g. keep Tomla Klass to boost, at the last moment, a creature that
        // would not have enough attack to kill the opposing creature): a summon whose
        // APPARITION is a targeted attack boost is in its window when the boost turns a
        // non-kill into a kill, an ally that did not kill the creature in front of it on
        // its row now kills it. Otherwise, same floor as rule 7.
        if (!pickSelfOnly) {
          const atkBoosts = (card.triggers ?? [])
            .filter((t) => t.trigger === "APPARITION")
            .flatMap((t) => t.effects)
            .filter((e) => e.type === "BoostAttack" && effectRequiresTarget(e)) as Array<{ amount?: number }>;
          if (atkBoosts.length > 0) {
            const amount = atkBoosts.reduce((s, e) => s + (e.amount ?? 0), 0);
            let converts = false;
            for (const mine of state.creatures) {
              if (mine.owner !== side || mine.currentLife <= 0) continue;
              const lane = state.creatures.filter(
                (o) => o.owner !== side && o.currentLife > 0 && o.position.y === mine.position.y,
              );
              if (lane.length === 0) continue;
              const nearest = lane.reduce((m, o) =>
                Math.abs(o.position.x - mine.position.x) < Math.abs(m.position.x - mine.position.x) ? o : m);
              const hp = nearest.currentLife + nearest.armor;
              if (mine.currentAttack < hp && mine.currentAttack + amount >= hp) { converts = true; break; }
            }
            if (!converts) pickSelfOnly = true;
          }
        }
        if (pickSelfOnly) {
          // Certain waste (a pick with no external target, rule 7, or an apparition
          // condition that is certainly false, rule 15): the floor goes above the cap.
          // fizzleCap protects finishers whose effect can still land; when the effect is
          // certainly dead on play there is nothing to protect (Kamasutar at 4 AP with a
          // full hand: a share of 70, not 40).
          effectShare = Math.max(effectShare, 0.5 * EVAL_WEIGHTS.costWorth * (card.cost ?? 0));
          score -= EVAL_WEIGHTS.effectFizzle * effectShare;
        } else {
          score -= EVAL_WEIGHTS.effectFizzle * Math.min(EVAL_WEIGHTS.fizzleCap, effectShare);
        }
      }
      // Rule 14 (e.g. put Hugo in front of a Scarafon): a creature with CONTRE COUP
      // wants a creature in front of it. Each hit it takes fires its effect; in front of
      // the closest attacker of its row it takes ceil(HP / enemy ATK) hits before dying
      // (Yugo with 3 HP against a 2 ATK Scarafon survives the first hit and draws twice).
      // A bonus per expected trigger (at most 3), zero on an empty row: equivalent
      // placements are no longer equivalent, and the weak attacker becomes the
      // preferred spot.
      if ((card.triggers ?? []).some((t) => t.trigger === "CONTRE_COUP")) {
        const lane = state.creatures.filter(
          (c) => c.owner !== side && c.currentLife > 0 && c.currentAttack > 0 && c.position.y === a.target.y,
        );
        if (lane.length > 0) {
          const nearest = lane.reduce((m, c) =>
            Math.abs(c.position.x - a.target.x) < Math.abs(m.position.x - a.target.x) ? c : m);
          const hits = Math.min(3, Math.ceil((card.life ?? 1) / Math.max(1, nearest.currentAttack)));
          score += EVAL_WEIGHTS.contreCoupFacing * hits;
        }
      }
      // Rule 16 (e.g. Kokoko in front of a Kerubim): a shooter placed in front of an
      // enemy has the initiative: during the advance it shoots first, and there is no
      // ranged answer. Enough ATK to one-shot the closest target on the row is a free
      // kill (big bonus); otherwise it is safe chip damage (small bonus).
      const rangeMk = (card.effects ?? []).find((e) => e.type === "ShooterRangeData") as { RangeMax?: number } | undefined;
      if ((rangeMk?.RangeMax ?? 0) > 0) {
        const lane = state.creatures.filter(
          (c) => c.owner !== side && c.currentLife > 0 && c.position.y === a.target.y,
        );
        if (lane.length > 0) {
          // The line of fire is read exactly like in the engine (fireShooterShot, rules.ts):
          // walk cell by cell in front of the shooter and stop at the first occupant. Every
          // creature blocks the line: with an ally in front, the shooter cannot see the enemy,
          // so there is no bonus for facing it.
          // An older version used the closest enemy of the row in absolute distance, so it
          // gave the bonus through an ally, to an enemy behind the shooter, and to an enemy
          // out of range.
          const dx = side === "ally" ? -1 : 1; // cf. forwardDx() du moteur
          let seen: (typeof state.creatures)[number] | null = null;
          for (let d = 1; d <= (rangeMk?.RangeMax ?? 0); d++) {
            const x = a.target.x + dx * d;
            if (x < 0 || x >= BOARD_COLS) break;
            const cr = state.creatures.find(
              (c) => c.currentLife > 0 && c.position.x === x && c.position.y === a.target.y,
            );
            if (cr) {
              if (cr.owner !== side) seen = cr; // premier ENNEMI en vue
              break;                            // allié = ligne bloquée, on s'arrête
            }
          }
          if (seen) {
            const oneShot = (card.attack ?? 0) >= seen.currentLife + seen.armor;
            score += oneShot ? EVAL_WEIGHTS.shooterFacingKill : EVAL_WEIGHTS.shooterFacingChip;
          }
          // Blocked lane or target out of range: no bonus and no malus. The lane
          // is not empty (there are enemies in it), so rule 22 does not apply.
        } else if (state.creatures.some((c) => c.owner !== side && c.currentLife > 0)) {
          // Rule 22: a shooter placed on an empty lane while there are enemies to answer
          // elsewhere loses the whole benefit of its range (the opponent plays in front of
          // it, advances and kills it). It is better kept for an answer. No penalty on an
          // empty board (early game: the curve matters more, there is nothing to answer).
          score -= EVAL_WEIGHTS.shooterEmptyLane;
        }
      } else {
        // Rule 18 (creatures are best played as answers to other creatures): a melee
        // creature placed in front of a target it kills in the exchange (simultaneous
        // damage) keeps the initiative. Big bonus if it survives the hit back (Rat
        // Dominant against Black Wabbit), small if it is a 1-for-1. No reward for
        // standing there as food (dying without killing).
        const lane = state.creatures.filter(
          (c) => c.owner !== side && c.currentLife > 0 && c.position.y === a.target.y,
        );
        if (lane.length > 0) {
          const nearest = lane.reduce((m, c) =>
            Math.abs(c.position.x - a.target.x) < Math.abs(m.position.x - a.target.x) ? c : m);
          const kills = (card.attack ?? 0) >= nearest.currentLife + nearest.armor;
          const survives = (card.life ?? 1) > nearest.currentAttack;
          if (kills) score += survives ? EVAL_WEIGHTS.meleeFacingKill : EVAL_WEIGHTS.meleeFacingTrade;
        }
      }
      // Rule 23 (e.g. Héroïne Stridulante offered to a one-shot, Robin sacrificed):
      // standing in front of an enemy that one-shots us while we cannot kill it is
      // feeding it. The penalty is the card's cost: stalling with a 1-2 AP chump blocker
      // is still fine, feeding a strong card is not. Applies to melee and shooters (a
      // shooter gets at best one shot before dying, which does not pay for a big card).
      {
        const laneFoes = state.creatures.filter(
          (c) => c.owner !== side && c.currentLife > 0 && c.currentAttack > 0 && c.position.y === a.target.y,
        );
        if (laneFoes.length > 0) {
          const nearest = laneFoes.reduce((m, c) =>
            Math.abs(c.position.x - a.target.x) < Math.abs(m.position.x - a.target.x) ? c : m);
          const oneShotMe = nearest.currentAttack >= (card.life ?? 1);
          const canKill = (card.attack ?? 0) >= nearest.currentLife + nearest.armor;
          // Same idea (e.g. Poiscaille offered to Robin des Landes, who hits from range and
          // kills it without any risk): against a shooter that one-shots us, being able to
          // kill it in melee does not count, because it shoots first and we never reach it.
          const foeShootsFirst = nearest.range > 0;
          if (oneShotMe && (!canKill || foeShootsFirst)) score -= EVAL_WEIGHTS.feedCost * (card.cost ?? 0);
        }
      }
    } else if (card && card.cardType === "Spell") {
      // Rule 6: a spell is only effect, so casting it only makes sense when the eval
      // swing after the end of turn pays back the card's worth. Floored at 1 AP so
      // 0-cost spells (Heure de Gloire) still count: otherwise the wastedAp relief was
      // paying the AI to burn them for +1/+1 on a creature about to leave the board.
      // A kill, a lasting buff or an enabled capture moves the eval far above the
      // penalty and still gets played.
      const effectShare = EVAL_WEIGHTS.costWorth * Math.max(1, card.cost ?? 0);
      // Rule 13 (e.g. passing with 3 AP instead of throwing a Fléau): the penalty and
      // the bonus apply to the share of the effect that is not realized, proportionally.
      // Dofus damage is permanent progress (never speculative), so it pays the card back
      // in proportion.
      // How much is realized is measured on the end-of-turn probe of the action line
      // against the pass line: an accelerator that captures now what the pass did not
      // reach (Amalia at 2 HP charged onto the Dofus) realizes everything. Checked in a
      // test: a Charge on a creature already next to the Dofus hits the Dofus twice in
      // the turn (the charge keeps hasAttacked, the advance hits again), so it really
      // makes progress and is not pure waste.
      let realized = Math.max(0, dofusProgress(myEnd, side) - dofusProgress(shallowPassProbe(state), side));
      // Rule 25 (e.g. play Carquois as soon as possible when there is no answer in hand:
      // the point is to find answers fast): drawn cards are progress as real as Dofus
      // damage. A draw spell realizes its share in proportion to the net cards gained
      // against the pass (+1 makes up for the spell itself, already counted by the hand
      // term of the eval).
      const netCards = myEnd.players[side].hand.length - shallowPassProbe(state).players[side].hand.length;
      if ((card.effects ?? []).some((e) => e.type === "DrawCards")) {
        realized += Math.max(0, netCards + 1) * EVAL_WEIGHTS.hand;
      }
      // Rule 19 (e.g. a Charge on a Kokoko that moved 2 cells but did not threaten the
      // Dofus): an accelerator (Charge / PM boost) is only worth playing to get a capture
      // the pass would not have had. No Dofus progress realized means certain waste, so
      // the full penalty applies with no cap (like rule 15); the threat gain in the eval
      // is not enough to pay it back.
      const isAccel = (card.effects ?? []).some((e) => e.type === "Charge" || e.type === "BoostMovement");
      if (isAccel && realized <= 0) {
        score -= EVAL_WEIGHTS.spellFizzle * effectShare +
          EVAL_WEIGHTS.spellCostPremium * Math.max(0, (card.cost ?? 0) - 1);
        return score;
      }
      // Rule 24 (e.g. Flèche Destructrice at 5 AP on a Robin with 1 HP, very expensive for
      // one damage): a removal spell on a creature pays for the overkill, its cost above
      // the target's remaining HP+AR. Killing an 8 HP creature with the Destructrice is
      // still free; burning it on a tiny one is penalised, even with no other option in
      // hand.
      if ((card.effects ?? []).some((e) => e.type === "Destroy" || e.type === "DamageData")) {
        const victim = state.creatures.find(
          (c) => c.owner !== side && c.currentLife > 0 && c.position.x === a.target.x && c.position.y === a.target.y,
        );
        if (victim) score -= EVAL_WEIGHTS.removalOverkill * Math.max(0, (card.cost ?? 0) - (victim.currentLife + victim.armor));
      }
      const unrealizedFactor = Math.max(0, 1 - realized / effectShare);
      // Rule 11: the capped penalty is flat from 2 AP on, so nothing separates two spells
      // that do the same thing. A linear bonus per AP above the first means the cheapest
      // removal that is enough wins; a big spell that is needed pays it back with its swing.
      score -= unrealizedFactor * (
        EVAL_WEIGHTS.spellFizzle * Math.min(EVAL_WEIGHTS.fizzleCap, effectShare) +
        EVAL_WEIGHTS.spellCostPremium * Math.max(0, (card.cost ?? 0) - 1)
      );
    }
    // Rule 21 (when the plan includes drawing during the turn, draw first, since the
    // draw can reveal a better plan): a tiny ordering bonus for cards that draw, too
    // small to change play/keep, big enough to put them first in the turn.
    if (card) {
      const drawsNow =
        (card.effects ?? []).some((e) => e.type === "DrawCards") ||
        (card.triggers ?? []).some((t) => t.trigger === "APPARITION" && t.effects.some((e) => e.type === "DrawCards"));
      if (drawsNow) score += EVAL_WEIGHTS.drawFirst;
    }
  }
  return score;
}

// A leaf evaluator: scores a board after the end-of-turn probe from rootSide's
// view and returns a value already in (−1,1). This is how the value net replaces
// the heuristic at the leaves without changing the search. The probe and terminal
// handling stay in leafValue; this only scores a non-terminal probe position.
export type LeafEval = (probeState: GameState, rootSide: Side) => number;

// A prior: weights over the legal actions of a state (aligned 1:1 with `legal`,
// any non-negative scale). When set, the search uses PUCT with these priors and
// expands the top-K by prior, instead of the heuristic top-K + UCB1.
export type PriorFn = (state: GameState, legal: Action[]) => Float32Array;

interface Node {
  state: GameState;
  toMove: Side; // actingSide(state)
  parent: Node | null;
  action: Action | null; // the action that led here from the parent
  children: Node[];
  untried: Action[];
  visits: number;
  value: number; // Σ leaf values, always from rootSide's perspective
  terminal: boolean;
  prior: number; // P(action) from the parent's policy prior (PUCT); 0 if no prior
  priorMap: Map<string, number> | null; // child action-key → prior, when a prior is active
}

export interface MctsOptions {
  simulations?: number; // budget per move = difficulty knob
  c?: number; // UCB exploration constant
  evalScale?: number; // squashes the heuristic eval into (-1, 1) via tanh
  maxBranch?: number; // keep only the top-K heuristic actions per node (prior)
  // Optional value-net (or any) leaf evaluator. When set, it scores the
  // non-terminal probe board instead of the heuristic; it must return (−1,1).
  leafEval?: LeafEval;
  // Optional policy prior. When set, the search runs PUCT (prior-weighted)
  // and expands the top-K actions by prior instead of the heuristic top-K.
  priorFn?: PriorFn;
  cPuct?: number; // PUCT exploration constant (used only when a prior is active)
}

export class MctsAgent implements Agent {
  readonly name: string;
  private readonly simulations: number;
  private readonly c: number;
  private readonly scale: number;
  private readonly maxBranch: number;
  private readonly leaf?: LeafEval;
  private readonly prior?: PriorFn;
  private readonly cPuct: number;
  // Set for the duration of a searchRootStats call (per-decision overrides, e.g. a
  // net leaf/prior that captured the root belief). Fall back to the ctor versions.
  private activeLeaf?: LeafEval;
  private activePrior?: PriorFn;

  constructor(opts: MctsOptions = {}) {
    this.simulations = opts.simulations ?? 400;
    this.c = opts.c ?? 1.4;
    this.scale = opts.evalScale ?? 3000;
    this.maxBranch = opts.maxBranch ?? 10;
    this.leaf = opts.leafEval;
    this.prior = opts.priorFn;
    this.cPuct = opts.cPuct ?? 1.5;
    this.name = `MCTS(${this.simulations})`;
  }

  // Heuristic prior: with ~50 legal moves, a modest budget cannot search deep
  // enough, and plain MCTS becomes a noisy 1-ply heuristic. So at each node we only
  // keep the top-K moves by the heuristic's combat-aware score (the same signal that
  // made HeuristicAgent strong). The budget then goes to plausible moves, and the
  // tree gets deep enough to beat the 1-ply agent.
  // Choose which actions to expand at a node and, when a policy prior is active, the
  // per-action prior weights for PUCT. With a prior: top-K by prior, weights kept.
  // Without: the heuristic combat-aware top-K, no priors.
  private candidates(state: GameState, rng: Rng): { actions: Action[]; priorMap: Map<string, number> | null } {
    const legal = legalActions(state);
    // The candidate set is the heuristic combat-aware top-K (good coverage, it keeps
    // the good moves). Letting a weak learned policy pick the set directly was a net
    // loss (it left good moves out), so the policy only reweights PUCT exploration
    // among the heuristic candidates and never replaces them.
    let actions: Action[];
    if (legal.length <= this.maxBranch) {
      actions = rng.shuffle([...legal]);
    } else {
      const side = actingSide(state);
      const scored = legal
        .map((a) => ({ a, s: this.actionPrior(state, a, side) }))
        .sort((x, y) => y.s - x.s);
      // Three fixes to the candidate set:
      //  1. Collapse plays that do not depend on the target: two plays of the same card
      //     with exactly the same one-step score are interchangeable (a global AoE gives
      //     ~50 identical actions, one per cell, which used to fill every slot). One is
      //     kept; the search still explores the card.
      //  2/3. Always keep endTurn and reserve: passing and banking must stay searchable
      //     in a busy position (they used to get pruned).
      const seenPlay = new Set<string>();
      actions = [];
      for (const { a, s } of scored) {
        if (a.kind === "play") {
          const k = `${a.cardId}:${s}`;
          if (seenPlay.has(k)) continue;
          seenPlay.add(k);
        }
        actions.push(a);
        if (actions.length >= this.maxBranch) break;
      }
      for (const kind of ["endTurn", "reserve"] as const) {
        if (!actions.some((a) => a.kind === kind)) {
          const found = legal.find((a) => a.kind === kind);
          if (found) actions.push(found);
        }
      }
    }
    if (!this.activePrior) return { actions, priorMap: null };
    const w = this.activePrior(state, actions); // policy weights over the selected candidates
    let s = 0;
    for (let i = 0; i < actions.length; i++) s += w[i];
    const priorMap = new Map<string, number>();
    for (let i = 0; i < actions.length; i++) priorMap.set(JSON.stringify(actions[i]), s > 0 ? w[i] / s : 1 / actions.length);
    return { actions, priorMap };
  }

  // Combat-aware one-step score of an action (same as HeuristicAgent): a play is
  // judged by the board after the current side's end-of-turn combat.
  // A play that opens a pending pick (deferred summon, targeted APPARITION) used to
  // be scored on the mid-pick state, where the creature is still off the board and
  // the AP refunded, so it looked like it did nothing; those cards sank to the
  // bottom and were pruned. The pick is first settled on a representative target
  // (the first legal one, or the in-board decline), then the end of turn is probed
  // as usual. The tree itself still searches every target (settling is only used to
  // rank the candidates).
  private actionPrior(state: GameState, a: Action, side: Side): number {
    return oneStepHeuristicScore(state, a, side);
  }

  chooseAction(state: GameState, legal: Action[], rng: Rng): Action {
    if (legal.length === 1) return legal[0];
    const stats = this.searchRootStats(state, rng);
    // Play the most-visited child (the robust MCTS choice), rng to break ties.
    let best = stats[0];
    for (const s of stats) {
      if (s.visits > best.visits || (s.visits === best.visits && rng.next() < 0.5)) best = s;
    }
    return best.action;
  }

  // Run the search and return each root action with its visit count. Exposed so
  // the determinised agent can aggregate these over many sampled worlds.
  searchRootStats(state: GameState, rng: Rng, leafEval?: LeafEval, priorFn?: PriorFn): { action: Action; visits: number; q: number }[] {
    this.activeLeaf = leafEval ?? this.leaf;
    this.activePrior = priorFn ?? this.prior;
    const rootSide = actingSide(state);
    const root = this.makeNode(state, null, null, rng);
    for (let i = 0; i < this.simulations; i++) {
      this.simulate(root, rootSide, rng);
    }
    // q = mean backed-up value of the child (rootSide's view, in (−1,1)), the search's
    // own judgement of each root action. Exposed for the v2 policy recording (soft π
    // targets and root value, used for the mixed value label that reduces the noise
    // of the final-outcome signal).
    return root.children.map((ch) => ({ action: ch.action!, visits: ch.visits, q: ch.visits > 0 ? ch.value / ch.visits : 0 }));
  }

  /** Expand one untried action of `node` into a new child and return it. */
  private expandOne(node: Node, rng: Rng): Node {
    const action = node.untried.pop()!;
    const child = this.makeNode(applyAction(node.state, action), node, action, rng);
    if (node.priorMap) child.prior = node.priorMap.get(JSON.stringify(action)) ?? 0;
    node.children.push(child);
    return child;
  }

  private makeNode(state: GameState, parent: Node | null, action: Action | null, rng: Rng): Node {
    const terminal = state.winner !== null;
    // Top-K candidate actions (+ priors when a policy prior is active).
    const { actions, priorMap } = terminal ? { actions: [], priorMap: null } : this.candidates(state, rng);
    return { state, toMove: actingSide(state), parent, action, children: [], untried: actions, visits: 0, value: 0, terminal, prior: 0, priorMap };
  }

  private simulate(root: Node, rootSide: Side, rng: Rng): void {
    // 1+2. Descend through fully-expanded nodes, then expand one leaf.
    let node = root;
    while (!node.terminal && node.untried.length === 0 && node.children.length > 0) {
      node = this.selectChild(node, rootSide);
    }
    if (!node.terminal && node.untried.length > 0) {
      node = this.expandOne(node, rng);
      // A net leaf must never score a pending state (there are no training rows for it). Each pick target
      // is a move itself, so keep expanding through the pending chain and evaluate the resolved state
      // instead. Successive simulations pop different targets, so the whole pick still gets explored. (The
      // heuristic leaf keeps its raw pending evaluation: its eval is plain arithmetic on the state, not a
      // learned distribution.)
      for (let hops = 0; this.activeLeaf && node.state.pendingAction && !node.terminal && node.untried.length > 0 && hops < 8; hops++) {
        node = this.expandOne(node, rng);
      }
    }
    // 3. Leaf value (rootSide perspective).
    const value = this.leafValue(node.state, rootSide);
    // 4. Backpropagate.
    for (let n: Node | null = node; n !== null; n = n.parent) {
      n.visits += 1;
      n.value += value;
    }
  }

  private selectChild(node: Node, rootSide: Side): Node {
    // The player to move at `node` steers toward states good for them: rootSide
    // maximises the (rootSide-perspective) value, the opponent minimises it.
    const sign = node.toMove === rootSide ? 1 : -1;
    const puct = node.priorMap !== null; // policy prior active → PUCT, else UCB1
    const sqrtParent = puct ? Math.sqrt(node.visits) : 0;
    const logParent = puct ? 0 : Math.log(node.visits + 1);
    let best = node.children[0];
    let bestScore = -Infinity;
    for (const ch of node.children) {
      const exploit = sign * (ch.value / ch.visits);
      const explore = puct
        ? this.cPuct * ch.prior * (sqrtParent / (1 + ch.visits))
        : this.c * Math.sqrt(logParent / ch.visits);
      const score = exploit + explore;
      if (score > bestScore) {
        bestScore = score;
        best = ch;
      }
    }
    return best;
  }

  // Truncated-rollout value: ±1 at a decided game, else the heuristic eval
  // squashed into (-1, 1), from rootSide's perspective.
  //
  // Crucial: a creature does nothing until end-of-turn combat, so the raw eval
  // cannot tell a good placement/play from a bad one mid-turn, it would make the
  // search blind to exactly what matters. So on a normal turn we evaluate the
  // board after the current side's end-of-turn combat (same trick that made the
  // heuristic strong). Pending/mulligan leaves keep their immediate value.
  private leafValue(state: GameState, rootSide: Side): number {
    if (state.winner !== null) return state.winner === rootSide ? 1 : -1;
    const probe = !state.pendingAction && !state.mulligan ? applyAction(state, END_TURN) : state;
    if (probe.winner !== null) return probe.winner === rootSide ? 1 : -1;
    // Value net (or any injected leaf eval) returns (−1,1) directly; else the
    // heuristic squashed via tanh.
    if (this.activeLeaf) return this.activeLeaf(probe, rootSide);
    return Math.tanh(evaluate(probe, rootSide) / this.scale);
  }
}
