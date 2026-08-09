// Heuristic position evaluation: score a GameState from one side's point of
// view (higher = better for `side`). The hand-crafted "understanding" of
// Krosmaga the first real agent uses, and the baseline the trained value net
// must beat. Fast; weights are tunable (EVAL_WEIGHTS).
//
// Priorities (largest magnitude first):
//   1. Winning / losing (terminal).
//   2. Real-Dofus pressure, destroying 2 of the enemy's 3 reals is the win.
//   3. Threat, not a creature's distance to the Dofus but the number of turns
//      it needs to get there (distance / PM + lane blockers, +1 if it cannot move
//      yet this turn = summoning sickness), weighted by its attack.
//   4. Board presence, raw stats on the board.
//   5. Hand advantage, the difference in hand size (a top signal).
//   6. AP reserve, banked AP persists across turns.
//
// INFORMATION-FAIR: `side` knows the real/fake of its own Dofus, but not of the
// opponent's (only revealed when one is destroyed). Undestroyed enemy Dofus are
// valued by the probability they are real, no peeking at hidden truth.
//
// Not modelled here (handled by the layers above): potential PM-boost / charge
// acceleration (lookahead / MCTS / net), the tempo to afford a Fléau-finish
// (MCTS), combat control via pre-combat setup (MCTS + hand), and deck-draw
// quality (net). Deck-card count is ignored (noise).
import type { GameState } from "../engine/state";
import type { CreatureInstance } from "../engine/state";
import type { Side } from "../engine/board";
import { BOARD_COLS } from "../engine/board";
import { DOFUS_LIFE } from "../engine/rules";

export const EVAL_WEIGHTS = {
  win: 1_000_000,
  realDestroyed: 1200, // per enemy real Dofus destroyed (you need 2)
  realDamage: 120, // per life point chipped off a real Dofus (expected, for enemy)
  fakeDestroyed: 80, // destroying a fake → +1 spawn column (a real reach gain)
  // Chip damage on my own fake Dofus: it brings the enemy closer to a free spawn
  // column and reveals nothing useful. Without this term, hurting your own fake was
  // free for the heuristic, so absurd self-Fléau plays got through (damaging an
  // allied Dofus is almost never right; the rare combos, Julith / Héros Martyr, have
  // to outweigh a penalty, not nothing).
  ownFakeDamage: 30, // per life point chipped off my own fake Dofus
  boardStat: 10, // per (attack + life + armor) point on the board
  // PM are worth something on their own: the threat term only moves when a boost
  // crosses a ceil(dist/PM) threshold, so a +1 PM buff used to score zero minus the
  // hand card and the eval refused ally boosts. Boosting an allied creature is almost
  // always right; the rare case where it gives the enemy the initiative in combat is
  // for the search to judge, not a reason to hide the move.
  mobility: 5, // per PM point of a living creature
  // 6 → 8 (two cases pointing the same way: defending a Scarafon, and defending the
  // row threatened by a Wabbit). At 6, the material trade always won over defending
  // the threatened lane: the judge preferred keeping a body intact over removing a
  // threat 2 turns from the Dofus. To be checked in the arena with the next A/B.
  threat: 8, // × attack × imminence(turns-to-reach the enemy base)
  // Diminishing returns of threat within a lane: a second strong attacker on a lane
  // that is already winning adds little (the Dofus only falls once), while pressure on
  // an empty lane forces the defender to split. Each lane's threat contributions are
  // sorted and weighted 1, laneDecay, laneDecay^2, ..., so spreading beats stacking.
  laneDecay: 0.5,
  hand: 32, // per card of hand-size advantage (tier-1 signal)
  reserve: 7, // per banked AP of advantage (persists across turns)
  // Opportunity cost of passing with unspent AP (they are lost at the start of the
  // next turn, startTurn resets ap to maxAp). The best turns spend all the AP you
  // have (card power follows AP cost); passing with AP left is almost always bad.
  // Applied in oneStepHeuristicScore (the eval itself cannot see the AP before the
  // pass), not to the banked reserve (which stays).
  wastedAp: 15, // per AP thrown away by ending the turn with them unspent
  // Rule 4: a card's worth follows its AP cost (~costWorth eval points per AP). For
  // an effect summon, the part of that price not covered by its body is in the
  // effect, and playing it while the effect does nothing measurable throws that part
  // away (Chuchoteurs kept for the right moment, while a Tronknyde can be played on
  // curve). Applied in oneStepHeuristicScore.
  costWorth: 35, // eval points one AP of card cost is expected to buy
  effectFizzle: 3.5, // multiplier on the (capped) effect share when playing an effect summon
  // Cap on the effect share entering the malus: big effect creatures (Protoflex,
  // 7 PA, share ~150) must stay playable, the cap keeps the deterrent aimed at
  // cheap utility cards dumped "just to spend AP", not at finishers.
  fizzleCap: 40,
  // Rule 6 (found by going through a real "forte" game): a spell has no body, its
  // whole worth is the effect. The wastedAp rule was paying the AI to burn spells for
  // nothing (casting removes the unspent-AP penalty, and Heure de Gloire even sets it
  // to zero since it converts all remaining AP). To balance this, every spell play
  // carries its full effect share (at least 1 AP worth, even for 0-cost spells) as a
  // penalty that only a real eval swing after the end of turn (a kill, a lasting
  // buff, an enabled capture...) can pay back. Buffing a creature that breaks through
  // at the end of the turn pays nothing back (the buff leaves the board with it),
  // which was exactly the mistake seen.
  spellFizzle: 3.5, // multiplier on the (capped) spell effect share
  // Root sanity veto. The tie-break only decides near-tied visit counts, so whenever
  // the value net strongly preferred a line that is clearly bad (charging the
  // opponent's creature for nothing, heuristic gap 202; throwing away Heure de
  // Gloire, gap ~119) it went straight through. Root actions whose one-step
  // heuristic score is more than this margin below the best root action are vetoed,
  // and the net has no say on them. Wide enough (100) to leave close calls and real
  // 1-ply "sacrifices" that the search may justify.
  rootVeto: 100,
  // Rule 3, stricter (seen in a real "forte" game: the AI cashed its reserve and then
  // passed, a total waste that got through the rule 3 penalty because the ~22/AP gap
  // is under the root veto margin). Cashing the reserve is only worth it when it
  // unlocks a play this turn (a hand card becomes affordable), which can be checked
  // by comparing the playable cards before and after the cash. A cash that unlocks
  // nothing gets this flat penalty, sized to trigger the root veto whatever the
  // reserve size.
  pointlessCash: 200,
  // Rule 9 (Autorité #486 cast on an opponent creature right next to the AI's own
  // real Dofus, 8 AP paid to speed up the loss): the horizon effect turns the eval
  // upside down. The pass line carries a big looming threat term, while the action
  // line has already counted the loss, so getting it over with wins by hundreds. The
  // fix compares each root action with the pass line on the state of my own Dofus:
  // an action that leaves them worse than doing nothing means I am hurting my own win
  // condition. This is the multiplier on that difference.
  dofusAccel: 1.5,
  // Rule 11 (Flèche Destructrice, a very strong spell, burned to kill a Robin that a
  // cheap Orbe also killed): the capped spell penalty (spellFizzle × fizzleCap) is
  // flat from 2 AP on, so two spells that do the same thing pay the same and nothing
  // pushes toward the cheaper one. A linear bonus per AP above the first: with the
  // same effect the cheap spell wins (18/AP of difference), and a big spell that is
  // needed (a kill swing of 200+) easily pays it back.
  spellCostPremium: 18,
  // Rule 14 (Hugo should be played in front of a Scarafon): a creature with CONTRE
  // COUP wants a creature in front of it. Each hit it takes fires its effect, and in
  // front of an attacker weaker than its HP it takes several before dying (Yugo with
  // 3 HP against a 2 ATK Scarafon: 2 targeted draws, not 1). A bonus per expected
  // trigger; the three middle placements used to score the same (-4.5) and the net
  // picked one at random.
  contreCoupFacing: 25,
  // Early reserve (e.g. playing a Scarafon on an AP prism to play a 3 AP creature next
  // turn): early in the game, an AP in the reserve almost always turns into tempo (a
  // card played one turn earlier), so it is worth about costWorth, not 7. The base
  // weight undervalued the AP prism (27) next to the card prism (52). An extra amount
  // per reserve AP until turn 4 included; after that the reserve goes back to its
  // normal value.
  reserveEarly: 28,
  // Rule 16 (e.g. Kokoko in front of a Kerubim): a shooter placed in front of an enemy
  // has the initiative: during the end-of-turn advance it shoots first, and there is
  // no ranged answer. If it one-shots the target (ATK >= HP+AR), it is a free kill.
  // Placement bonus: kill / chip damage.
  shooterFacingKill: 40,
  shooterFacingChip: 15,
  // Rule 18 (creatures are best played as answers to other creatures: a Rat Dominant
  // in front of a Black Wabbit kills it and survives; a 1 AP Scarafon will kill the
  // Amalia in front of it): playing as an answer keeps the initiative in combat (our
  // own advance decides the fight, and the opponent's boosts come too late). Bonus
  // for a melee creature placed in front of a target it kills: big if it survives
  // the exchange, small if it is just a 1-for-1.
  meleeFacingKill: 40,
  meleeFacingTrade: 15,
  // Rule 20 (e.g. Chuck has only 2 HP and dies in one hit from a Black Wabbit, which
  // was the best choice since drawing matters a lot in this game; the Piou aux Oeufs
  // d'Or is a priority target too): a creature that draws again and again (a trigger
  // other than APPARITION with DrawCards/TutorFromDeck) is worth much more than its
  // body. With this extra value, the search makes killing it fast, or protecting your
  // own, a priority.
  drawEngine: 30,
  // Rule 21 (when the plan includes drawing during the turn, draw first, since the
  // draw can change the plan): a tiny ordering bonus to play the cards that draw
  // first. Small enough to never change play/keep, only the order.
  drawFirst: 8,
  // Rule 22 (e.g. a Crâ placed on an empty lane: the opponent plays in front of it,
  // the Crâ walks forward without using its range and gets killed, so the whole
  // benefit of the range is lost): a shooter is played as an answer, never first on
  // an empty lane when there are already enemy creatures to answer elsewhere. A
  // placement penalty when it is not an answer.
  shooterEmptyLane: 25,
  // Rule 23 (e.g. Héroïne Stridulante, a very strong card, offered to an Éclaireur
  // d'Élite that one-shots it, when the options were to give up the lane or stall
  // with a small creature; same with a Robin sacrificed): standing in front of an
  // enemy that one-shots us while we cannot kill it is feeding it. The penalty is
  // proportional to the cost: feeding a big card is much worse than sacrificing a
  // chump blocker.
  feedCost: 8,
  // Rule 24 (e.g. Flèche Destructrice at 5 AP on a Robin with 1 HP, very expensive
  // for one damage): removal overkill costs in proportion to the cost above the
  // target's remaining HP.
  removalOverkill: 12,
  // Rule 17 (e.g. Archille, a fairly strong card, parked on a dead lane, then a Dragon
  // Cochon wasted to block it although it would leave the board on its own two turns
  // later): a creature whose lane has no target Dofus left is temporary, it walks to
  // the open wall and goes back to the deck. Its body is only worth a fraction, so
  // we avoid parking big cards there and spending removal on them.
  deadLaneBody: 0.5,
  // Rule 27 (e.g. playing the champion gives back an orb and the hand reaches ten
  // cards, so the next draw goes to the discard): ending your own turn with a full
  // hand burns next turn's draw. A penalty of about one hand card: playing something,
  // even an average card, beats burning a draw. 40 = one hand card (32) plus the lost
  // option, sized to outweigh the keep margin of rule 4.
  handFullBurn: 40,
  // Portfolio of opponent policies: weight added to the Dofus term in the greedy
  // completion of a rush opponent. With 1.5 the Dofus term counts 2.5 times its
  // normal weight in the choice of the rush, enough to push its moves towards
  // pressure without hiding the rest of the score.
  oppRushBias: 1.5,
  // Same for a control opponent, on the mass of my creatures. Same dose as the rush,
  // it pushes the moves towards removals and trades.
  oppControlBias: 1.5,
};

const REAL_PER_SIDE = 3;

function other(s: Side): Side {
  return s === "ally" ? "enemy" : "ally";
}

// Forward steps a creature needs to reach the enemy back column (where the
// Dofus sit). Ally advances toward x=0, enemy toward x=BOARD_COLS-1.
function distanceToBase(owner: Side, x: number): number {
  return owner === "ally" ? x : BOARD_COLS - 1 - x;
}

// Living enemy creatures directly ahead of `c` in its lane (same row, toward the
// base). Each one is a fight the creature must win first → ~+1 turn of delay.
function enemyBlockersAhead(state: GameState, c: CreatureInstance): number {
  return state.creatures.filter(
    (o) =>
      o.currentLife > 0 &&
      o.owner !== c.owner &&
      o.position.y === c.position.y &&
      (c.owner === "ally" ? o.position.x < c.position.x : o.position.x > c.position.x),
  ).length;
}

// Blocking (e.g. a Tikoko placed on the empty lane instead of in front of the
// Scarafon that was rushing to the Dofus): a blocker that wins the exchange is not
// just one more turn of delay, the attacker never arrives. A sequential exchange
// simulation (simultaneous damage, like the engine) against each blocker on the
// path: if the melee attacker dies before getting through, its threat is zero, so
// placing the right defender finally pays off. Shooters kill blockers from range
// with no answer, so for them it is only a delay, as before. Kept simple on
// purpose: no initiative and no auras.
function meleeDiesToBlockers(state: GameState, c: CreatureInstance): boolean {
  if (c.range > 0) return false;
  let life = c.currentLife + c.armor;
  for (const b of state.creatures) {
    if (b.currentLife <= 0 || b.owner === c.owner || b.position.y !== c.position.y) continue;
    if (!(c.owner === "ally" ? b.position.x < c.position.x : b.position.x > c.position.x)) continue;
    const hits = Math.ceil((b.currentLife + b.armor) / Math.max(1, c.currentAttack));
    life -= hits * b.currentAttack; // riposte simultanée, y compris sur le coup fatal
    if (life <= 0) return true;
  }
  return false;
}

// How many turns until this creature starts hitting the enemy Dofus, from its
// current speed (PM). A wall or a 0-PM creature never gets there. A creature that
// cannot advance this turn (hasAttacked: just summoned, so summoning sickness, or
// already acted; sickness no longer sets PM to zero) only advances next turn, +1.
// Exported for the Glaie case of rule 19: the floor does not apply when the PM boost
// brings a creature to one turn or less from the Dofus (the surprise window).
export function turnsToReach(state: GameState, c: CreatureInstance): number {
  if (c.baseMovement <= 0) return Infinity;
  if (meleeDiesToBlockers(state, c)) return Infinity; // blocked until death: it never arrives
  const dist = distanceToBase(c.owner, c.position.x);
  const sickDelay = c.hasAttacked || c.movementLeft <= 0 ? 1 : 0;
  return Math.ceil(dist / c.baseMovement) + sickDelay + enemyBlockersAhead(state, c);
}

// Imminence multiplier: arriving in 1 turn is worth far more than in 4.
function imminence(turns: number): number {
  if (!isFinite(turns)) return 0;
  if (turns <= 1) return 8;
  if (turns === 2) return 3;
  if (turns === 3) return 1.2;
  return 0.4;
}

// Rule 13 (e.g. passing with 3 AP while a Fléau could be cast): an exported view of
// the Dofus term, used to measure the realized share of a spell. Progress on the
// Dofus is permanent (never speculative), so it pays the card back.
export function dofusProgress(state: GameState, side: Side): number {
  return dofusScore(state, side, EVAL_WEIGHTS);
}

// Dofus term, information-fair (see header). Returns the score contribution.
function dofusScore(state: GameState, side: Side, W: typeof EVAL_WEIGHTS): number {
  const foe = other(side);

  // A destroyed Dofus is removed from state.dofuses (it stays in state.destroyedDofuses
  // for the smoke effect), so the currentLife<=0 filters below never matched and the
  // eval did not see captures: as soon as a Dofus died, its accumulated damage penalty
  // disappeared and the eval jumped back up. That hole is what made paying to speed up
  // the loss of my own Dofus look good. Destroyed Dofus now count from the
  // destroyed list, at full damage plus the destruction premium, for good.
  const tombs = state.destroyedDofuses ?? [];
  const myTombReals = tombs.filter((d) => d.owner === side && d.kind === "real").length;
  const myTombFakes = tombs.filter((d) => d.owner === side && d.kind === "fake").length;

  // My own Dofus, I know their nature.
  const myReals = state.dofuses.filter((d) => d.owner === side && d.kind === "real");
  const myRealsLost = myReals.filter((d) => d.currentLife <= 0).length + myTombReals;
  const myRealDamage = myReals.reduce((s, d) => s + (DOFUS_LIFE - d.currentLife), 0) + myTombReals * DOFUS_LIFE;
  const myFakes = state.dofuses.filter((d) => d.owner === side && d.kind === "fake");
  const myFakesLost = myFakes.filter((d) => d.currentLife <= 0).length + myTombFakes;
  const myFakeDamage = myFakes.reduce((s, d) => s + (DOFUS_LIFE - d.currentLife), 0) + myTombFakes * DOFUS_LIFE;

  // Enemy Dofus, only destroyed ones reveal their nature; the rest are hidden.
  const enemy = state.dofuses.filter((d) => d.owner === foe);
  const enemyRealsDestroyed = enemy.filter((d) => d.currentLife <= 0 && d.kind === "real").length
    + tombs.filter((d) => d.owner === foe && d.kind === "real").length;
  const enemyFakesDestroyed = enemy.filter((d) => d.currentLife <= 0 && d.kind === "fake").length
    + tombs.filter((d) => d.owner === foe && d.kind === "fake").length;
  const enemyAlive = enemy.filter((d) => d.currentLife > 0);
  // Each undestroyed enemy Dofus is real with this probability (remaining reals
  // spread over remaining Dofus). We value expected real damage, not the truth.
  const enemyRealsRemaining = Math.max(0, REAL_PER_SIDE - enemyRealsDestroyed);
  const pReal = enemyAlive.length > 0 ? enemyRealsRemaining / enemyAlive.length : 0;
  // Destroyed enemy reals are revealed: their full damage counts (pReal=1),
  // keeping the term symmetric with the own-side accounting above.
  const enemyExpectedRealDamage = enemyAlive.reduce((s, d) => s + (DOFUS_LIFE - d.currentLife) * pReal, 0)
    + enemyRealsDestroyed * DOFUS_LIFE;

  let s = 0;
  s += W.realDestroyed * (enemyRealsDestroyed - myRealsLost);
  s += W.realDamage * (enemyExpectedRealDamage - myRealDamage);
  // Fake destruction is revealed info: I gain spawn range when I break an enemy
  // fake; I give it away when one of mine breaks.
  s += W.fakeDestroyed * (enemyFakesDestroyed - myFakesLost);
  s -= W.ownFakeDamage * myFakeDamage;
  return s;
}

/** Mass of the creatures of the other side: weighted sum of the living enemy bodies
 *  (stats and mobility, with the same discount for a dead lane as the evaluation).
 *  Used by the control intent of the opponent portfolio, an opponent that tries to
 *  clear my board before going for the Dofus. The value is positive and goes down
 *  when my creatures die, and the control intent tries to make it small. */
export function foeMassSubscore(state: GameState, side: Side): number {
  const W = EVAL_WEIGHTS;
  const lanesWithAllyDofus = new Set<number>();
  const lanesWithEnemyDofus = new Set<number>();
  for (const d of state.dofuses) {
    if (d.currentLife <= 0) continue;
    if (d.owner === "ally") lanesWithAllyDofus.add(d.position.y);
    else lanesWithEnemyDofus.add(d.position.y);
  }
  let mass = 0;
  for (const c of state.creatures) {
    if (c.currentLife <= 0 || c.owner === side) continue;
    const targetLanes = c.owner === "ally" ? lanesWithEnemyDofus : lanesWithAllyDofus;
    const bodyMult = targetLanes.has(c.position.y) ? 1 : W.deadLaneBody;
    mass += bodyMult * (W.boardStat * (c.currentAttack + c.currentLife + c.armor) + W.mobility * c.baseMovement);
  }
  return mass;
}

/** Rule 9 helper: my own Dofus health as a (non-positive) subscore, priced with
 *  the same weights as dofusScore. Used by the deep root heuristic to compare
 *  an action line vs the pass line, an action that leaves my Dofus worse than
 *  doing nothing actively hurt my own win condition. */
export function ownDofusSubscore(state: GameState, side: Side): number {
  const W = EVAL_WEIGHTS;
  let s = 0;
  for (const d of state.dofuses) {
    if (d.owner !== side) continue;
    const dmg = DOFUS_LIFE - d.currentLife;
    if (d.kind === "real") {
      s -= W.realDamage * dmg;
      if (d.currentLife <= 0) s -= W.realDestroyed;
    } else {
      s -= W.ownFakeDamage * dmg;
      if (d.currentLife <= 0) s -= W.fakeDestroyed;
    }
  }
  // Destroyed Dofuses leave state.dofuses, count the tombstones (same fix as
  // dofusScore: without this the loss vanishes from the books the turn it lands).
  for (const d of state.destroyedDofuses ?? []) {
    if (d.owner !== side) continue;
    s -= d.kind === "real"
      ? W.realDamage * DOFUS_LIFE + W.realDestroyed
      : W.ownFakeDamage * DOFUS_LIFE + W.fakeDestroyed;
  }
  return s;
}

export function evaluate(state: GameState, side: Side): number {
  if (state.winner === side) return EVAL_WEIGHTS.win;
  if (state.winner === other(side)) return -EVAL_WEIGHTS.win;

  const foe = other(side);
  const W = EVAL_WEIGHTS;
  let score = dofusScore(state, side, W);

  // --- Board presence + per-creature threat (turns-to-reach, attack-weighted).
  // Threat is aggregated per lane with diminishing returns (see laneDecay): the
  // strongest attacker of a lane counts fully, the next ones less and less.
  // Rule 12 (e.g. an Éclaireur placed in front of an enemy on a lane whose Dofus is
  // already destroyed, a big mistake): a creature cannot leave its row; if the enemy
  // Dofus of its row is destroyed, reaching the wall breaks through for nothing (back
  // to the deck, no damage). Its capture threat is zero, and the other way round,
  // blocking an enemy attacker on a row where my Dofus has already fallen protects
  // nothing. `state.dofuses` only holds living Dofus, so a Set of the rows each camp
  // can still threaten is enough.
  const lanesWithAllyDofus = new Set<number>();
  const lanesWithEnemyDofus = new Set<number>();
  for (const d of state.dofuses) {
    if (d.currentLife <= 0) continue;
    if (d.owner === "ally") lanesWithAllyDofus.add(d.position.y);
    else lanesWithEnemyDofus.add(d.position.y);
  }
  const laneThreats = new Map<string, number[]>();
  for (const c of state.creatures) {
    if (c.currentLife <= 0) continue;
    const sgn = c.owner === side ? 1 : -1;
    const targetLanes = c.owner === "ally" ? lanesWithEnemyDofus : lanesWithAllyDofus;
    const deadLane = !targetLanes.has(c.position.y);
    // Rule 17: on a lane with no target Dofus the creature is temporary (it is about to
    // break through for nothing), so its body only counts half.
    const bodyMult = deadLane ? W.deadLaneBody : 1;
    score += sgn * bodyMult * W.boardStat * (c.currentAttack + c.currentLife + c.armor);
    score += sgn * bodyMult * W.mobility * c.baseMovement;
    // Rule 20: a draw engine (a repeatable trigger, not the one-shot APPARITION) is
    // worth much more than its body. Even on a dead lane it keeps drawing, so this term
    // gets no deadLaneBody discount.
    if (c.triggers.some((t) => t.trigger !== "APPARITION" && t.effects.some((e) => e.type === "DrawCards" || e.type === "TutorFromDeck"))) {
      score += sgn * W.drawEngine;
    }
    if (deadLane) continue; // rule 12: dead lane → zero capture threat
    const t = c.currentAttack * imminence(turnsToReach(state, c));
    if (t > 0) {
      const key = `${c.owner}|${c.position.y}`;
      const arr = laneThreats.get(key);
      if (arr) arr.push(t);
      else laneThreats.set(key, [t]);
    }
  }
  for (const [key, arr] of laneThreats) {
    const sgn = key.startsWith(side) ? 1 : -1;
    arr.sort((a, b) => b - a);
    let mult = 1;
    for (const t of arr) {
      score += sgn * W.threat * t * mult;
      mult *= W.laneDecay;
    }
  }

  // --- Resource advantage.
  score += W.hand * (state.players[side].hand.length - state.players[foe].hand.length);
  // Early reserve: early in the game, a reserve AP is worth about one AP of tempo
  // (see reserveEarly), so the AP prism competes with the card prism again.
  // The threshold is 6, not 4, because the eval runs on probe boards (end of turn plus
  // the opponent rollout, so the decision plus 2 turns): with 4 the bonus disappeared
  // from decision turn 3 on; 6 covers decisions 1-4.
  const reserveW = W.reserve + (state.turn <= 6 ? W.reserveEarly : 0);
  score += reserveW * (state.players[side].apReserve - state.players[foe].apReserve);

  return score;
}
