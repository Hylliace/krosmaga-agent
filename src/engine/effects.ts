// Effect application: how the Effect entries of cards change the live arrays of
// creatures / Dofus during a spell cast.
//
// Convention: handlers mutate the given `creatures`, `dofuses` and `log` arrays in
// place, the same pattern as processCombatPhase in rules.ts. The caller has to:
//   - make shallow copies before calling applyEffects (do not mutate the input
//     GameState's arrays directly)
//   - call resolveDeathsAndWin after applyEffects to handle the creatures / Dofus
//     that reached 0 life and check the win condition
//
// Unknown effect types silently do nothing, so the engine does not throw mid-turn
// on a card whose effect is not implemented yet.
//
// Each handler is meant to be tiny and pure (apart from the local mutation).

import type { Effect, DynamicValue } from "../data/types";
import type { Coords, Side } from "./board";
import { BOARD_COLS, sameCoords, isAlliedTerritory, isImmovable } from "./board";
import { getCard, summonsOfCost, famsOf, effsOf } from "./cardRegistry";
import type { Rng } from "./rng";
import type { CreatureInstance, DofusInstance, GameEvent } from "./state";

export interface EffectContext {
  casterSide: "ally" | "enemy";
  // Cell the spell is targeting. Required for cell-targeted effects
  // (DamageData, SetPropertyData on a cell). AoE / global effects will
  // ignore it and read from their own params.
  targetCell?: Coords;
  // Optional: the instance the spell targets (when the player clicked a specific
  // creature rather than a cell). Set by the caller; for now it is resolved from
  // targetCell only.
  targetInstanceId?: number;
  sourceInstanceId?: number;
  // For TRIGGER-driven effects (APPARITION, MORT, …), the instance that
  // owns the trigger. Self-targeted effect types (SelfDamageData,
  // BoostAttackData, …) act on this creature instead of targetCell.
  selfInstanceId?: number;
  // Seeded RNG for any random effect (dice rolls, random transforms/picks). Every random
  // effect has to draw from this seeded stream; reaching one without it throws
  // (requireRng). There is no fallback to a global generator: a ctx without it made
  // replays diverge without any warning. Callers seed from state.rng and store the
  // advanced rng.state back into the state they build; the live game uses the same
  // seeded pipeline (castSpell / runTrigger).
  rng?: Rng;
  // Minimum value for the CASTER's dice rolls this turn (Dé Pipé #535). 0/undefined
  // = no floor; populated from players[casterSide].diceFloor at ctx construction.
  diceFloor?: number;
  // The last dice value rolled during this cast (set by handleDamage when its amount is
  // a die). Lets a follow-up effect react to the same roll: Dé du Chateux #459
  // "Dévoile ... sur 3 ou moins" reads it. Undefined = no die rolled.
  diceRoll?: number;
  // General rule: damage never applies to Dofus unless the card says so. True only when
  // the card explicitly targets a Dofus (castTarget contains "Dofus", Fléau #757); then
  // handleDamage may hit the Dofus on the target cell. Trigger contexts leave it unset,
  // so the Dofus are protected.
  dofusTargetable?: boolean;
  // Sink for creatures killed by a `bounceKilledToHand` effect (Cancane #775
  // "si elle va dans la défausse, elle remonte dans votre main"). The handler
  // records the victim's {cardId, owner}; the caller (runTrigger) moves it from
  // the owner's discard to the CASTER's hand after death resolution.
  bounceKilledSink?: { cardId: number; owner: "ally" | "enemy" }[];
  // Sink for the reversions of temporary maluses set by a trigger. The `duration`
  // block of playCardInner only reads card.effects, so an effect with a duration
  // carried by a trigger (APPARITION...) would otherwise apply for good. The effect
  // layer puts the measured reversion here, and rules moves it to pendingReversions.
  tempReversionSink?: { kind: "stat"; expireSide: "ally" | "enemy"; field: "attack" | "armor" | "movement" | "range" | "life"; amount: number; instanceIds: number[] }[];
  // Per-cell hook for forced slides (push / attract / retreat via slideCreatureBack).
  // When set, each cell a sliding creature crosses goes through this callback so it
  // interacts with the board exactly like a normal advance step: gangrène
  // (movementPoison), walking over tokens (graine/piège/butin/glyphe/tas d'os) and
  // prism pickup (the creature moves on its own, cell by cell along the way). Given by
  // the rules.ts caller, which owns the AdvanceTracking and the settle pass
  // (removeConsumed* / activatePrism / butin rolls) run after applyEffects. Absent: the
  // slide is a plain relocation (no interaction).
  onSlideStep?: (mover: CreatureInstance, nx: number, ny: number) => void;
  // Is the damage dealt by this pass spell damage (a card of cardType Spell/Aoe)? Only spell
  // damage is reduced by the anti-spell modifiers: "réduit de N les dégâts des sorts adverses"
  // (Joris #110, SpellDamageReductionAura) and "insensible aux dégâts des sorts" (Atcham,
  // SpellDamageInsensitivity). A creature's own ability damage (APPARITION "Infligez N" of
  // the Black Wabbit #495, MORT, Dathura/Gargoule/Pisti, the Pacificatrice's volley...) is not
  // a spell and must not be reduced. Left undefined, it is computed when applyEffect starts:
  // a source creature on the board means a creature ability (not a spell); no source means
  // a spell.
  isSpell?: boolean;
}

// A Dofus's starting HP. Same as DOFUS_LIFE in rules.ts (duplicated here to keep
// effects.ts free of a circular import on rules). Used as the heal cap for Soin de
// Dofus (a Dofus cannot be healed above its starting HP).
const DOFUS_MAX_LIFE = 5;

// Determinism guard: every source of chance has to come from the seeded generator in
// the ctx. A missing rng used to fall back to the global generator, which made two
// identical games diverge. A missing rng is a caller bug: pass `new Rng(state.rng)` in
// the ctx and store the advanced `rng.state` back into the state you build. Throwing
// turns a silent replay divergence into a failure that is easy to find.
function requireRng(rng: Rng | undefined, what: string): Rng {
  if (!rng) throw new Error(`effects: rng manquant pour ${what} — chaque effet aléatoire doit tirer du flux seedé (déterminisme)`);
  return rng;
}

// Resolve a DynamicValue down to a plain integer. Most cards use
// ConstIntegerValue (just a number); the more complex variants
// (NumberOfSummonValue, TriggeringDiceValue, …) will need state in scope
// to evaluate properly, TODO when we meet them.
// Roll `n` dice of `sides` faces and sum (1..sides each). Always from the seeded RNG.
function rollDice(n: number, sides: number, rng?: Rng, floor = 0): number {
  const r = requireRng(rng, "un jet de dé");
  let total = 0;
  // `floor` (Dé Pipé): each individual die cannot land below `floor` ("vos jets de
  // dé ne peuvent être inférieurs à N"). Clamped per die, capped at `sides`.
  const lo = Math.min(floor, sides);
  for (let i = 0; i < n; i++) total += Math.max(lo, 1 + r.int(sides));
  return total;
}

// `onRoll` fires only when a real die was rolled (never for constants), with the
// post-floor total (Dé Pipé: the face the player must see is the floored value).
// This is the single choke point every d6 in the game goes through, so the DICE_THROW
// beat (the Ecaflip die animation) can be emitted exactly at its instant.
export function resolveDynamicValue(v: DynamicValue, rng?: Rng, floor = 0, onRoll?: (result: number, sides: number) => void): number {
  if (typeof v === "number") return v;
  if ("const" in v && typeof v.const === "number") return v.const;
  const o = v as { type?: string; dice?: string };
  // Dice values (Ecaflip's Dé cards): the bindata "TriggeringDiceValue" is a
  // 1d6, and our description parser emits { dice: "NdM" }. Rolled at resolve
  // time, from the seeded RNG when available; `floor` applies Dé Pipé.
  if (o.type === "TriggeringDiceValue") {
    const r = rollDice(1, 6, rng, floor);
    onRoll?.(r, 6);
    return r;
  }
  if (typeof o.dice === "string") {
    const m = /^(\d*)d(\d+)$/.exec(o.dice);
    if (m) {
      const sides = parseInt(m[2], 10);
      const r = rollDice(parseInt(m[1] || "1", 10), sides, rng, floor);
      onRoll?.(r, sides);
      return r;
    }
  }
  return 0;
}

// Builds the `onRoll` sink for one effect application: pushes the DICE_THROW
// beat (Ecaflip die tumble) into the event log at the very instant the die is
// rolled. `at`/`instanceId` seat the die on the concerned cell; `spell` tells
// the FX layer to add the cell shockwave (spell-cast sequences only; the
// property/creature global script "Dice Rolled" shows the bare die).
function diceSink(log: GameEvent[], ctx: EffectContext): (result: number, sides: number) => void {
  return (result, sides) => {
    log.push({
      type: "DICE_THROW",
      instanceId: ctx.selfInstanceId ?? ctx.targetInstanceId,
      at: ctx.targetCell ? { ...ctx.targetCell } : undefined,
      spell: ctx.isSpell === true,
      result,
      sides,
    });
  };
}

// Read the optional AoE scope the merge may have stamped on a stat effect
// ("allies" / "enemies" / "all"). Undefined → single-target.
function scopeOf(effect: Effect): Scope | undefined {
  const s = (effect as { scope?: string }).scope;
  return s === "allies" || s === "allies_camp" || s === "enemies" || s === "all" || s === "own_camp" || s === "enemy_camp"
    ? (s as Scope)
    : undefined;
}
// Name of the drunk property of the Pandawa god. A free string (properties are a
// Set<string>, not a closed enum); the UI already reads it in boardViews.ts to pick
// the "drunk" animation set of rig 44.
export const SAOUL = "Saoul";

/** Pandawa god: drunkenness does not survive a change of control.
 *  Call it at every change of owner: capture, gift, defection on a coup de grâce,
 *  and reversion (going back to the original side is also a change of control).
 *  The log is optional: some reversion sites do not have one at hand, and the UI
 *  derives the drunk state from the Set of properties, not from the event. */
export function shedDrunkOnControlChange(c: CreatureInstance, log?: GameEvent[]): void {
  if (!c.properties.has(SAOUL)) return;
  c.properties = new Set(c.properties);
  c.properties.delete(SAOUL);
  log?.push({ type: "PROPERTY_UNAPPLIED", instanceId: c.instanceId, property: SAOUL });
}
const familyOf = (effect: Effect): string | undefined => (effect as { family?: string }).family;
const godOf = (effect: Effect): string | undefined => (effect as { god?: string }).god; // classe/dieu (Synchroniseur #714 "vos autres Xélors")
const excludeSelfOf = (effect: Effect): boolean | undefined => (effect as { excludeSelf?: boolean }).excludeSelf;
const woundedOf = (effect: Effect): boolean | undefined => (effect as { wounded?: boolean }).wounded;
// Pandawa god: drunkenness sub-filters and MP threshold, read like `wounded`.
const drunkOf = (effect: Effect): boolean | undefined => (effect as { drunk?: boolean }).drunk;
const soberOf = (effect: Effect): boolean | undefined => (effect as { sober?: boolean }).sober;
const minMoveOf = (effect: Effect): number | undefined => (effect as { minMovement?: number }).minMovement;

// A Dofus is invulnerable when either:
//   - Artheon #1424: the creature that targeted it (invulnerableBy) is still alive, a single Dofus
//     pinned by one creature; or
//   - Grougaloragran #397: "Tant qu'il est en jeu, vos Dofus sont invulnérables", a passive aura over
//     all of an owner's Dofus while any of that owner's creatures carries ProtectsOwnDofus.
// Every Dofus damage/destruction site checks this and leaves the Dofus untouched. Both forms switch
// off automatically when the protecting creature dies (currentLife > 0 gate).
export function dofusInvulnerable(d: { invulnerableBy?: number; invulnerableTurns?: number; owner?: CreatureInstance["owner"] }, creatures: CreatureInstance[]): boolean {
  if ((d.invulnerableTurns ?? 0) > 0) return true; // Orbe Doré #594: temporary invulnerability (turn-counted)
  // A silenced Artheon #1424 makes its Dofus vulnerable again (the effect of the creature is
  // silenced, so the Dofus is vulnerable again). Same for a carrier of ProtectsOwnDofus
  // (Grougaloragran #397): silenced, it no longer gives its aura.
  if (d.invulnerableBy != null && creatures.some((c) => c.instanceId === d.invulnerableBy && c.currentLife > 0 && !c.silenced)) return true;
  return d.owner != null && creatures.some((c) => c.owner === d.owner && c.currentLife > 0 && !c.silenced && c.properties.has("ProtectsOwnDofus"));
}

// The single entry point for Dofus damage. Every site that lowers a Dofus's life has to go
// through here so the fragility of Sinistro #215 holds: the equipment is destroyed as soon as
// its host Dofus is wounded (any damage, not only a kill, so the currentLife<=0 check of
// resolveDeathsAndWin is not enough). The Dofus still takes the full damage; only the
// attachment is cleared. `amount` has to be the positive damage, already clamped (callers
// keep their own DAMAGE / FIGHT_OBJECT_REMOVED logs).
// Heals a Dofus, capped at its starting life. The counterpart of woundDofus: every life gain
// of a Dofus goes through here, so none changes without notice. The event is only pushed if
// the life really changes (so an untouched Dofus does not trigger a heal animation).
export function healDofus(dofus: DofusInstance, amount: number, log: GameEvent[]): void {
  const before = dofus.currentLife;
  const after = Math.min(DOFUS_MAX_LIFE, before + amount);
  if (after === before) return;
  dofus.currentLife = after;
  log.push({
    type: "DOFUS_LIFE_HEALED",
    dofusAt: { ...dofus.position },
    heal: after - before,
    lifeMod: { valueBefore: before, valueAfter: after, modification: after - before },
  });
}

// Sangsuce Tsu Tsu #24: "TOUS les soins deviennent des dégâts", Dofus included (Mot
// Reconstituant #491 used to heal a Dofus from 3 to 5 with the Sangsuce in play). Every Dofus
// heal goes through here: it either gives life back or takes it, through the usual
// woundDofus path (Sinistro broken, Sir Comte Flex mirror, Julith Jurgen...). An invulnerable
// Dofus (Artheon #1424 / Orbe Doré) takes nothing, and is not healed either, since the heal
// no longer exists. Any capture is handled by resolveDeathsAndWin.
export function healOrHarmDofus(
  dofus: DofusInstance,
  amount: number,
  log: GameEvent[],
  creatures: CreatureInstance[],
  dofuses: DofusInstance[],
): void {
  if (amount <= 0 || !healsAreReversed(creatures)) {
    healDofus(dofus, amount, log);
    return;
  }
  if (dofusInvulnerable(dofus, creatures)) return;
  woundDofus(dofus, amount, log, creatures, dofuses);
  if (dofus.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", dofusAt: { ...dofus.position } });
  else log.push({ type: "DAMAGE", targetCell: { ...dofus.position }, damage: amount });
}

export function woundDofus(
  dofus: DofusInstance,
  amount: number,
  log: GameEvent[],
  creatures: CreatureInstance[],
  dofuses: DofusInstance[],
  isMirror = false,
): void {
  if (amount <= 0) return;
  // Gueule de Bois #2039: the reduction is taken off here, at the single point
  // every Dofus damage goes through, so it holds for every source (a creature's
  // attack, a spell, an effect, a reflection), not only spells. It applies per
  // hit, before the shield: a hit brought down to 0 does not use up the
  // Pissenlit #1041.
  const reduction = Math.max(0, (dofus.damageReduction ?? 0) | 0);
  if (reduction > 0) {
    amount = Math.max(0, amount - reduction);
    if (amount <= 0) return;
  }
  // Pissenlit Maléfique #1041: a one-hit shield absorbs the entire hit, then is consumed. (No log
  // event, there is no Dofus-shield-break GameEvent yet; the Dofus simply takes no damage.)
  if (dofus.shielded) {
    dofus.shielded = false;
    return;
  }
  dofus.currentLife = Math.max(0, dofus.currentLife - amount);
  if (dofus.sinistroAttached) {
    dofus.sinistroAttached = false;
    log.push({ type: "SINISTRO_DESTROYED", dofusAt: { ...dofus.position } });
  }
  // Sir Comte Flex #406 (MirrorAllyDofusDamageToEnemyRow): the instant a Dofus is wounded, if its
  // owner has a living carrier of the marker, the enemy Dofus on the same row takes the same amount
  // ("en subit autant"). The mirror strike goes through woundDofus too, so it breaks an enemy
  // Sinistro and counts toward capture, but with isMirror=true so it never chains: the reaction
  // fires only on the original hit, so two opposing Flex cannot loop. Fizzles if no living enemy
  // Dofus shares the row (or it is invulnerable, Artheon #1424 / Grougal #397).
  if (!isMirror) {
    const ownerHasMirror = creatures.some(
      (c) => c.currentLife > 0 && c.owner === dofus.owner &&
        (effsOf(c)).some((e) => e.type === "MirrorAllyDofusDamageToEnemyRow"),
    );
    if (ownerHasMirror) {
      const enemyDof = dofuses.find(
        (d) => d.currentLife > 0 && d.owner !== dofus.owner && d.position.y === dofus.position.y,
      );
      if (enemyDof && !dofusInvulnerable(enemyDof, creatures)) {
        woundDofus(enemyDof, amount, log, creatures, dofuses, true);
        if (enemyDof.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", dofusAt: { ...enemyDof.position } });
        else log.push({ type: "DAMAGE", targetCell: { ...enemyDof.position }, damage: amount });
      }
    }
  }
  // Julith Jurgen #352 (DamageEnemiesOnAllyDofusDamage): the instant a Dofus is wounded, each living
  // carrier owned by that Dofus's side deals its fixed amount to all enemy invocations ("Inflige 1 dégât
  // aux invocations adverses quand un Dofus allié subit des dégâts"). Independent of the Dofus damage
  // amount; only hits creatures (never a Dofus) so it cannot chain woundDofus, fires on every hit.
  for (const julith of creatures) {
    if (julith.currentLife <= 0 || julith.owner !== dofus.owner) continue;
    const marker = (effsOf(julith)).find((e) => e.type === "DamageEnemiesOnAllyDofusDamage") as { amount?: number } | undefined;
    if (!marker) continue;
    const dmg = marker.amount ?? 1;
    for (const c of creatures) {
      if (c.currentLife <= 0 || c.owner === dofus.owner) continue; // enemy invocations only
      const armorBefore = c.armor;
      const dealt = applyDamageToCreatureFromSpell(c, dmg, log, creatures, dofus.owner);
      if (dealt > 0 || armorBefore > c.armor) log.push({ type: "DAMAGE", sourceInstanceId: julith.instanceId, targetInstanceId: c.instanceId, damage: dealt, armorHit: armorBefore > c.armor });
    }
  }
  // Héros Martyr #956 (DamageEnemiesOnAllyDofusDestroyed): when this Dofus is destroyed (this hit
  // brought it to 0), each living carrier owned by the Dofus's side deals its fixed amount to all
  // enemy invocations ("Inflige N aux invocations adverses quand un Dofus allié est détruit").
  // Distinct from Julith (fires on any wound); this fires only on destruction. Hits creatures only
  // (never a Dofus) so it cannot re-enter woundDofus.
  if (dofus.currentLife <= 0) {
    for (const martyr of creatures) {
      if (martyr.currentLife <= 0 || martyr.owner !== dofus.owner) continue;
      const marker = (effsOf(martyr)).find((e) => e.type === "DamageEnemiesOnAllyDofusDestroyed") as { amount?: number } | undefined;
      if (!marker) continue;
      const dmg = marker.amount ?? 0;
      if (dmg <= 0) continue;
      for (const c of creatures) {
        if (c.currentLife <= 0 || c.owner === dofus.owner) continue; // enemy invocations only
        const armorBefore = c.armor;
        const dealt = applyDamageToCreatureFromSpell(c, dmg, log, creatures, dofus.owner);
        if (dealt > 0 || armorBefore > c.armor) log.push({ type: "DAMAGE", sourceInstanceId: martyr.instanceId, targetInstanceId: c.instanceId, damage: dealt, armorHit: armorBefore > c.armor });
      }
    }
  }
}

// Apply one Effect by dispatching on its `type` discriminator.
export function applyEffect(
  creatures: CreatureInstance[],
  dofuses: DofusInstance[],
  log: GameEvent[],
  effect: Effect,
  ctx: EffectContext,
): void {
  // Determine once whether this pass is spell damage (see EffectContext.isSpell). A spell has no
  // board-creature source (spellCtx sets none; a spell pending carries sourceInstanceId -1); a
  // creature ability (APPARITION/MORT/attack…) carries its live-or-dead source instance. So: a
  // known board creature ⇒ creature ability (not spell); anything else ⇒ spell. Cached on the ctx
  // literal (contained, every caller builds a fresh ctx object), so the loop only computes it once.
  if (ctx.isSpell === undefined) {
    const srcId = ctx.selfInstanceId ?? ctx.sourceInstanceId;
    const src = srcId != null && srcId >= 0 ? creatures.find((c) => c.instanceId === srcId) : undefined;
    ctx.isSpell = !src;
  }
  switch (effect.type) {
    case "DamageData":
      // Cast away the Effect union's open-ended fallback member
      // ({ type: string; … }), which prevents the literal `case` from
      // narrowing on its own. Same pattern as PushData below.
      handleDamage(creatures, dofuses, log, effect as { type: "DamageData"; Damage: DynamicValue }, ctx);
      return;
    case "DestroyDofus": {
      // "Détruit un Dofus" (Garde Temps): the cast target is the Dofus
      // (castTarget AnyDofus). Drop it to 0 life; castSpell's resolveDeathsAndWin
      // culls it and settles the win condition (real → win count, fake → spawn
      // range to the destroyer).
      if (!ctx.targetCell) return;
      const target = dofuses.find((d) => sameCoords(d.position, ctx.targetCell!) && d.currentLife > 0);
      if (target && !dofusInvulnerable(target, creatures)) { // Artheon #1424: invulnerable → cannot be destroyed
        woundDofus(target, target.currentLife, log, creatures, dofuses); // → 0 via the canonical path (breaks any Sinistro)
        log.push({ type: "FIGHT_OBJECT_REMOVED", dofusAt: { ...target.position } });
      }
      return;
    }
    case "AoeDamageDofus": {
      // "Inflige N dégâts à tous les Dofus adverses" (Harcèlement #136). Reduce
      // every enemy Dofus's life by N; castSpell's resolveDeathsAndWin settles
      // captures (real → win count) / spawn-range (fake). Log DAMAGE for
      // survivors, FIGHT_OBJECT_REMOVED for any brought to 0 (like DestroyDofus).
      const amount = (effect as { amount: number }).amount | 0;
      if (amount <= 0) return;
      for (const d of dofuses) {
        if (d.currentLife <= 0 || d.owner === ctx.casterSide || dofusInvulnerable(d, creatures)) continue; // only the foe's, never an invulnerable one (Artheon #1424)
        woundDofus(d, amount, log, creatures, dofuses); // canonical Dofus damage (breaks any Sinistro)
        if (d.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", dofusAt: { ...d.position } });
        else log.push({ type: "DAMAGE", targetCell: { ...d.position }, damage: amount });
      }
      return;
    }
    case "BoostResistance": {
      // Lien Spiritueux (Pandawa god): "Augmente la résistance de vos Pandawas
      // de 1". It only acts on the ones that already have resistance (in practice
      // the drunk ones) and never gives any to a sober one. Hence
      // `requireResistance`, without which it would be a universal buff.
      const e = effect as { amount: number; requireResistance?: boolean };
      const exige = e.requireResistance === true;
      for (const c of creatures) {
        if (c.currentLife <= 0) continue;
        if (!scopeMatches(c, scopeOf(effect) ?? "allies", ctx.casterSide)) continue;
        if (familyOf(effect) && !famsOf(c).includes(familyOf(effect)!)) continue;
        if (exige && c.resistance <= 0) continue;
        if (drunkOf(effect) && !c.properties.has(SAOUL)) continue;
        const avant = c.resistance;
        c.resistance = Math.max(0, avant + (e.amount | 0));
        if (c.resistance !== avant) log.push({ type: "PROPERTY_APPLIED", instanceId: c.instanceId, property: "Resistance" });
      }
      return;
    }
    case "TeleportInFrontOfFamily": {
      // Chamrak (Pandawa god): "Une invocation se téléporte DEVANT le premier
      // <famille> allié de SA LIGNE". Lane = same y. The sweep goes from the
      // creature towards the front of its side and stops at the first member of
      // the family; the landing cell is the one just in front of it, if free.
      // If there is no free cell in front of the Tonneau, it teleports behind
      // the Tonneau instead; with no Tonneau on the lane, the effect does nothing.
      // "Devant" = the caster's enemy side (the Tonneau is allied to the caster
      // and faces the enemy, whatever the side of the moved creature). "Le
      // premier Tonneau" = the closest to the creature, the ones in front of it first.
      const e = effect as { family: string };
      if (!ctx.targetCell) return;
      const me = creatures.find((c) => sameCoords(c.position, ctx.targetCell!) && c.currentLife > 0);
      if (!me || me.properties.has("Rooted") || me.properties.has("Statue")) return;
      const avant = ctx.casterSide === "ally" ? -1 : 1;   // the caster's front
      const devantMoi = me.owner === "ally" ? -1 : 1;     // the target's front
      const ancres = creatures
        .filter((c) => c.currentLife > 0 && c.owner === ctx.casterSide &&
                       c.position.y === me.position.y && famsOf(c).includes(e.family) &&
                       c.instanceId !== me.instanceId)
        .sort((a, b) => {
          const fa = (a.position.x - me.position.x) * devantMoi > 0 ? 0 : 1;   // in front of the creature first
          const fb = (b.position.x - me.position.x) * devantMoi > 0 ? 0 : 1;
          return fa - fb || Math.abs(a.position.x - me.position.x) - Math.abs(b.position.x - me.position.x);
        });
      const ancre = ancres[0];
      if (!ancre) return;                                  // no Tonneau: no effect
      const libre = (cible: { x: number; y: number }) =>
        cible.x >= 1 && cible.x <= 8 &&
        !creatures.some((c) => c.currentLife > 0 && sameCoords(c.position, cible)) &&
        !dofuses.some((d) => d.currentLife > 0 && sameCoords(d.position, cible));
      for (const cible of [{ x: ancre.position.x + avant, y: ancre.position.y },     // in front
                           { x: ancre.position.x - avant, y: ancre.position.y }]) {  // otherwise behind
        if (!libre(cible)) continue;
        const depuis = { ...me.position };
        me.position = { ...cible };
        log.push({ type: "FIGHT_OBJECT_MOVED", instanceId: me.instanceId, from: depuis, to: { ...cible }, movementType: "TELEPORT" });
        return;
      }
      return;
    }
    case "ToggleDrunk": {
      // Alfonse Dé: "rend un Pandawa allié saoul OU sobre". An automatic toggle of
      // the current state, not a choice. An engine without UnsetProperty could not
      // sober a creature up, so it is done here, on the clicked target, and only if
      // it is a Pandawa.
      if (!ctx.targetCell) return;
      const c = creatures.find((x) => sameCoords(x.position, ctx.targetCell!) && x.currentLife > 0);
      if (!c || !famsOf(c).includes("Pandawa")) return;
      if (c.owner !== ctx.casterSide) return; // "un Pandawa ALLIÉ", never an enemy one
      const props = new Set(c.properties);
      if (props.has(SAOUL)) {
        props.delete(SAOUL);
        log.push({ type: "PROPERTY_UNAPPLIED", instanceId: c.instanceId, property: SAOUL });
      } else {
        props.add(SAOUL);
        log.push({ type: "PROPERTY_APPLIED", instanceId: c.instanceId, property: SAOUL });
      }
      c.properties = props;
      return;
    }
    case "DamageDofusPerArmoredAlly": {
      // Attaque Naturelle #1012: each of the caster's creatures with armour (armor>0) deals N to
      // the enemy Dofus on its row. Several armoured allies on the same row stack onto that Dofus
      // (a Dofus brought to 0 by an earlier hit is skipped). Captures settled by resolveDeathsAndWin.
      // Pandatak (Pandawa god): "Vos Pandawas SAOULS infligent 1 dégât au Dofus
      // adverse de leur ligne", the same mechanic with another selection criterion.
      // So it is generalised rather than cloned: `family` + `drunk` narrow it, and
      // `requireArmor:false` drops the armour requirement of Attaque Naturelle #1012.
      const e = effect as { amount: number; family?: string; drunk?: boolean; sober?: boolean; requireArmor?: boolean };
      const amount = e.amount | 0;
      const exigeAr = e.requireArmor !== false;
      if (amount <= 0) return;
      for (const c of creatures) {
        if (c.currentLife <= 0 || c.owner !== ctx.casterSide) continue;
        if (exigeAr && c.armor <= 0) continue;
        if (e.family && !famsOf(c).includes(e.family)) continue;
        if (e.drunk && !c.properties.has(SAOUL)) continue;
        if (e.sober && c.properties.has(SAOUL)) continue;
        const dof = dofuses.find((d) => d.currentLife > 0 && d.owner !== ctx.casterSide && d.position.y === c.position.y);
        if (!dof || dofusInvulnerable(dof, creatures)) continue; // Artheon #1424
        woundDofus(dof, amount, log, creatures, dofuses); // canonical Dofus damage (breaks any Sinistro)
        if (dof.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", dofusAt: { ...dof.position } });
        else log.push({ type: "DAMAGE", targetCell: { ...dof.position }, damage: amount });
      }
      return;
    }
    case "DamageAllByOwnAttack": {
      // Sacrifice Véritable #861: every living creature (both sides) takes damage = its own current AT.
      // Bodyguard (#320 Silas / #300 Bould Erdash): the guard takes all damage meant for its
      // protected creature, self-damage included, with overflow past its own life. The direct
      // call to applyDamageToCreatureFromSpell bypassed the redirection, which only lives in the
      // wrapper, so the protected creature took the hit itself.
      // dealSpellDamageThroughGuard already logs the DAMAGE and the removal.
      for (const c of [...creatures]) {
        if (c.currentLife <= 0 || c.currentAttack <= 0) continue;
        dealSpellDamageThroughGuard(c, c.currentAttack, log, creatures, ctx.sourceInstanceId ?? -1, ctx.casterSide);
      }
      return;
    }
    case "DamageEnemiesByFamilyCount": {
      // Tofu Explosif #155 (MORT): deal (count of the caster's living `family` creatures, excl. self)
      // × `per` to all enemy creatures.
      const e = effect as { family: string; per: number; excludeSelf?: boolean };
      let n = 0;
      for (const c of creatures) {
        if (c.currentLife <= 0 || c.owner !== ctx.casterSide) continue;
        if (e.excludeSelf && c.instanceId === ctx.selfInstanceId) continue;
        if (!(famsOf(c)).includes(e.family)) continue;
        n++;
      }
      const amt = n * (e.per | 0);
      if (amt > 0) handleAoeDamage(creatures, log, ctx, amt, "enemies", undefined);
      return;
    }
    case "ScatterDamageDofus": {
      // "N dégâts répartis entre les Dofus adverses" (Craps #10). Deal N points
      // one AT A time, each onto a living enemy Dofus picked uniformly at random
      // (independent draw, the same Dofus can be hit repeatedly). A captured /
      // invulnerable Dofus drops out of the pool, so we re-filter every point.
      // RNG from ctx (seeded → reproducible in sims/replays); resolveDeathsAndWin
      // settles each capture / spawn-range afterwards.
      // The amount accepts a die (V2 Craps #10 "1d6 dégâts répartis"), so it goes
      // through resolveDynamicValue, and the roll is captured in ctx.diceRoll as
      // handleDamage does: it is the only write that feeds the "sur N ou moins"
      // markers. A plain number goes through unchanged.
      const rawScatter = (effect as { amount: DynamicValue }).amount;
      let n = resolveDynamicValue(rawScatter, ctx.rng, ctx.diceFloor) | 0;
      if (typeof rawScatter === "object" && rawScatter !== null && typeof (rawScatter as { dice?: string }).dice === "string") {
        ctx.diceRoll = n;
      }
      while (n-- > 0) {
        const pool = dofuses.filter(
          (d) => d.currentLife > 0 && d.owner !== ctx.casterSide && !dofusInvulnerable(d, creatures),
        );
        if (pool.length === 0) break; // no enemy Dofus left → remaining points fizzle
        const d = pool[requireRng(ctx.rng, "le choix d'un Dofus aléatoire").int(pool.length)];
        woundDofus(d, 1, log, creatures, dofuses); // canonical Dofus damage (breaks any Sinistro)
        if (d.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", dofusAt: { ...d.position } });
        else log.push({ type: "DAMAGE", targetCell: { ...d.position }, damage: 1 });
      }
      return;
    }
    case "SetDofusLife": {
      // "Faire chuter les PV d'un Dofus à N" (Sanction #151), set the targeted
      // Dofus's life down to value (never raises it). resolveDeathsAndWin settles a
      // capture (real → win count, fake → spawn range) if it reaches 0.
      if (!ctx.targetCell) return;
      const value = Math.max(0, (effect as { value: number }).value | 0);
      const d = dofuses.find((x) => sameCoords(x.position, ctx.targetCell!) && x.currentLife > value);
      if (d && !dofusInvulnerable(d, creatures)) { // Artheon #1424: invulnerable → life cannot be set down
        const dmg = d.currentLife - value;
        woundDofus(d, dmg, log, creatures, dofuses); // reduce to `value`; canonical Dofus damage (breaks any Sinistro)
        if (d.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", dofusAt: { ...d.position } });
        else log.push({ type: "DAMAGE", targetCell: { ...d.position }, damage: dmg });
      }
      return;
    }
    case "RevealEnemyDofusLine": {
      // "Dévoile le Dofus adverse de la ligne sur N ou moins" (Dé du Chateux #459).
      // Runs after the dice damage on the same line: if that roll (ctx.diceRoll) is
      // ≤ maxRoll, reveal the enemy Dofus on the target's row (one per row at the
      // base column). Reuses the `revealed` flag (NÉCROME's reveal infrastructure).
      const maxRoll = (effect as { maxRoll: number }).maxRoll | 0;
      if (ctx.diceRoll == null || ctx.diceRoll > maxRoll || !ctx.targetCell) return;
      const row = ctx.targetCell.y;
      const d = dofuses.find((x) => x.currentLife > 0 && x.owner !== ctx.casterSide && x.position.y === row && !x.revealed);
      if (d) d.revealed = true; // board re-renders the revealed Dofus from state.dofuses
      return;
    }

    case "SetPropertyData":
      handleSetProperty(creatures, dofuses, log, effect as { type: "SetPropertyData"; PropertyType: string }, ctx);
      return;

    case "PushData":
      handlePush(creatures, dofuses, log, effect as { type: "PushData"; Distance: number }, ctx);
      return;

    // --- Targeted stat mutations, all routed through one generic handler
    //     (applyStatMod). Adding a new buff/debuff = one line here + maybe a
    //     STAT_FIELDS entry. ---
    case "Heal": {
      const healAmount = resolveDynamicValue((effect as { amount: DynamicValue }).amount, ctx.rng, ctx.diceFloor, diceSink(log, ctx));
      // A single-target heal can land on a Dofus rather than a creature: Soin de Dofus #650
      // ("un Dofus") and Mot Reconstituant #491 ("une invocation OU un Dofus"). If the picked
      // cell has a Dofus and no creature, heal the Dofus, capped at its starting life (all
      // Dofus start at DOFUS_MAX_LIFE). A DOFUS_LIFE_HEALED is pushed so the heal has a beat to
      // hang its animation on (effect and health bar going up); LIFE_HEALED does not work since
      // a Dofus has no instanceId.
      if (!scopeOf(effect) && ctx.targetCell) {
        const onCell = creatures.find((c) => sameCoords(c.position, ctx.targetCell!) && c.currentLife > 0);
        if (!onCell) {
          const d = dofuses.find((x) => sameCoords(x.position, ctx.targetCell!) && x.currentLife > 0);
          if (d) {
            healOrHarmDofus(d, healAmount, log, creatures, dofuses);
            return;
          }
        }
      }
      // "Soigne vos Dofus de N" (Grougaloragran #409): a scoped heal flagged
      // `dofus` heals every Dofus on the scope's side (no pick), capped at the
      // starting life. (Single-target dofus heal is the picked-cell path above.)
      if ((effect as { dofus?: boolean }).dofus && scopeOf(effect)) {
        const sc = scopeOf(effect);
        for (const d of dofuses) {
          if (d.currentLife <= 0) continue;
          if (sc === "allies" && d.owner !== ctx.casterSide) continue;
          if (sc === "enemies" && d.owner === ctx.casterSide) continue;
          healOrHarmDofus(d, healAmount, log, creatures, dofuses);
        }
        return;
      }
      applyStatMod(creatures, log, ctx, { field: "life", mode: "add", amount: healAmount, scope: scopeOf(effect), shape: shapeOf(effect), family: familyOf(effect), excludeSelf: excludeSelfOf(effect), drunk: drunkOf(effect), sober: soberOf(effect), minMovement: minMoveOf(effect) });
      return;
    }
    case "BoostAttack":
      applyStatMod(creatures, log, ctx, { field: "attack", mode: "add", amount: resolveDynamicValue((effect as { amount: DynamicValue }).amount, ctx.rng, ctx.diceFloor, diceSink(log, ctx)), scope: scopeOf(effect), shape: shapeOf(effect), family: familyOf(effect), god: godOf(effect), excludeSelf: excludeSelfOf(effect), wounded: woundedOf(effect), drunk: drunkOf(effect), sober: soberOf(effect), minMovement: minMoveOf(effect), minAttack: (effect as { minAttack?: number }).minAttack });
      return;
    case "BoostColumnAttack":
      // "Confère +N AT aux invocations d'une rangée" (Tikoko): the player picks
      // a cell; every creature on that RANGÉE, the vertical column (same x),
      // allies and enemies, gains +N AT. scope "all" + shape "column" reuses
      // the generic AoE path; targetCell (the clicked cell) supplies the column.
      applyStatMod(creatures, log, ctx, { field: "attack", mode: "add", amount: resolveDynamicValue((effect as { amount: DynamicValue }).amount, ctx.rng, ctx.diceFloor, diceSink(log, ctx)), scope: "all", shape: "column", minAttack: (effect as { minAttack?: number }).minAttack });
      return;
    case "BoostArmor": {
      const e = effect as { amount: DynamicValue; woundedAmount?: number };
      let amount = resolveDynamicValue(e.amount, ctx.rng, ctx.diceFloor, diceSink(log, ctx));
      // Single-target wounded-conditional amount (Saizan Zen #522: "+1 AR ou +2
      // si elle est blessée"). Read the picked target's state at resolve time,
      // like SetAttack toLife. Only meaningful single-target (no scope).
      if (e.woundedAmount != null && !scopeOf(effect) && ctx.targetCell) {
        const tgt = creatures.find((x) => sameCoords(x.position, ctx.targetCell!) && x.currentLife > 0);
        if (tgt && tgt.currentLife < tgt.baseLife) amount = e.woundedAmount | 0;
      }
      applyStatMod(creatures, log, ctx, { field: "armor", mode: "add", amount, scope: scopeOf(effect), shape: shapeOf(effect), family: familyOf(effect), god: godOf(effect), excludeSelf: excludeSelfOf(effect), wounded: woundedOf(effect), drunk: drunkOf(effect), sober: soberOf(effect), minMovement: minMoveOf(effect), minAttack: (effect as { minAttack?: number }).minAttack });
      return;
    }
    case "SetMovement":
      applyStatMod(creatures, log, ctx, { field: "movement", mode: "set", amount: (effect as { value: number }).value | 0, scope: scopeOf(effect), shape: shapeOf(effect) });
      return;
    case "DestroyArmor": {
      // "Détruisez l'AR d'une invocation" (Larve Orange): the picked creature
      // loses its whole armour pool.
      const t = ctx.targetCell;
      const tgt = t ? creatures.find((x) => sameCoords(x.position, t) && x.currentLife > 0) : undefined;
      if (!tgt) return;
      const destroyed = tgt.armor;
      tgt.armor = 0;
      // gainAttack (V2 Larve Orange #116): the source gains as much AT as the
      // armour destroyed, permanently, hence baseAttack, which survives the reset
      // at the start of the turn (same write as AddArmorToAttack).
      // Zero armour destroyed = zero AT gained, and the target can belong to
      // either side.
      if ((effect as { gainAttack?: boolean }).gainAttack && destroyed > 0) {
        const me = findSelf(creatures, ctx);
        if (me) {
          me.currentAttack += destroyed;
          me.baseAttack += destroyed;
        }
      }
      return;
    }
    case "AttractCreature": {
      // Chacha Tyran #943 "attire une invocation de N cases": the picked creature
      // slides N cells toward the CASTER's wall/Dofus (Chacha's owner, may be the
      // opposite of the target's own side), stopping at the first obstacle.
      const t = ctx.targetCell;
      const tgt = t ? creatures.find((x) => sameCoords(x.position, t) && x.currentLife > 0) : undefined;
      if (tgt) slideCreatureBack(tgt, creatures, dofuses, (effect as { distance?: number }).distance ?? 0, log, ctx.casterSide, ctx.onSlideStep);
      return;
    }
    case "BoostMovement":
      applyStatMod(creatures, log, ctx, { field: "movement", mode: "add", amount: (effect as { amount: number }).amount | 0, scope: scopeOf(effect), shape: shapeOf(effect), family: familyOf(effect), excludeSelf: excludeSelfOf(effect), drunk: drunkOf(effect), sober: soberOf(effect), minMovement: minMoveOf(effect) });
      return;
    case "SetAttack": {
      // "Passe l'AT à N" (value), or, for Acide Sandoz, "AT égale à ses PV
      // restants" (toLife): the new attack is read from the single target's
      // current life at resolve time. toLife is always single-target (no scope),
      // so we look the target up via ctx.targetCell.
      const e = effect as { value?: number; toLife?: boolean; add?: boolean; fromSource?: boolean };
      const sc = scopeOf(effect);
      // Per-creature toLife in a scope ("AT des autres = à leurs PV", Darkli Moon):
      // each matched creature's attack becomes its own current life.
      if (e.toLife && sc) {
        for (const c of creatures) {
          if (c.currentLife <= 0) continue;
          if (excludeSelfOf(effect) && c.instanceId === ctx.selfInstanceId) continue;
          if (!scopeMatches(c, sc, ctx.casterSide)) continue;
          if (shapeOf(effect) && (!ctx.targetCell || !inShape(c, ctx.targetCell, shapeOf(effect)!))) continue;
          mutateStat(c, log, "attack", "set", c.currentLife);
        }
        return;
      }
      let amount = (e.value ?? 0) | 0;
      if (e.fromSource) {
        // "AT des autres = à la sienne" (Moon): all set to the SOURCE's attack.
        const src = ctx.selfInstanceId != null ? creatures.find((x) => x.instanceId === ctx.selfInstanceId && x.currentLife > 0) : undefined;
        amount = src ? src.currentAttack : 0;
      } else if (e.toLife) {
        const t = ctx.targetCell;
        const tgt = t ? creatures.find((x) => sameCoords(x.position, t) && x.currentLife > 0) : undefined;
        amount = tgt ? tgt.currentLife : 0;
      }
      // Coup de Sang #570: `add` adds the life to the current attack ("confère autant d'AT
      // qu'elle a de PV"); without it, toLife/value sets the attack (Acide Sandoz, Darkli Moon).
      applyStatMod(creatures, log, ctx, { field: "attack", mode: e.add ? "add" : "set", amount, scope: sc, shape: shapeOf(effect), excludeSelf: excludeSelfOf(effect) });
      return;
    }
    case "BoostRange":
      applyStatMod(creatures, log, ctx, { field: "range", mode: "add", amount: resolveDynamicValue((effect as { amount: DynamicValue }).amount, ctx.rng, ctx.diceFloor, diceSink(log, ctx)), scope: scopeOf(effect), shape: shapeOf(effect) });
      return;
    case "SetLife":
      // "Fait chuter à N les PV", set life to an exact value (reuses the life
      // field; capped at baseLife so it cannot over-heal).
      applyStatMod(creatures, log, ctx, { field: "life", mode: "set", amount: (effect as { value: number }).value | 0, scope: scopeOf(effect), shape: shapeOf(effect) });
      return;
    case "HealFull":
      // "Soigne les PV manquants", restore to full (currentLife = baseLife).
      handleHealFull(creatures, log, ctx, scopeOf(effect));
      return;

    case "SetRange": {
      // "Supprime la portée", set range to `max` (0 = melee again).
      const wanted = (effect as { max: number }).max | 0;
      // onlyIfLower (V2 Oeil de Lynx #388): the spell gives a range, it never
      // lowers one. On a shooter that already has as much or more it does
      // nothing; without this guard, casting it on a 1-3 would bring it down to 1-2.
      if ((effect as { onlyIfLower?: boolean }).onlyIfLower) {
        const t = ctx.targetCell;
        const tgt = t ? creatures.find((x) => sameCoords(x.position, t) && x.currentLife > 0) : undefined;
        if (!tgt || tgt.range >= wanted) return;
      }
      applyStatMod(creatures, log, ctx, { field: "range", mode: "set", amount: wanted });
      return;
    }
    case "MultiplyAttack":
      handleMultiplyAttack(creatures, log, effect as { factor: number }, ctx);
      return;
    case "Transform":
      handleTransform(creatures, log, effect as { tokenId: number; asOwner: "caster" | "keep"; attack?: number; life?: number; cost?: number }, ctx);
      return;
    case "TransformAll":
      handleTransformAll(creatures, log, ctx, effect as { tokenId?: number; randomCost?: number; scope?: string; family?: string; excludeSelf?: boolean; fromCardId?: number });
      return;
    case "Vulnerability":
      handleVulnerability(creatures, log, ctx, (effect as { amount: number }).amount | 0, scopeOf(effect), shapeOf(effect));
      return;
    case "SetProperty":
      handleGrantProperty(creatures, log, ctx, effect as { property: string; scope?: string; family?: string; notFamily?: string; excludeSelf?: boolean; self?: boolean });
      return;
    case "ShieldAlliedDofuses":
      // Maître Féca #1676 "… et à vos Dofus": SetProperty Shield only covers creatures
      // (handleGrantProperty), so this companion effect grants the one-hit Dofus shield
      // (shielded) to every living Dofus on the caster's side.
      for (const d of dofuses) if (d.currentLife > 0 && d.owner === ctx.casterSide) d.shielded = true;
      return;
    case "DamageSameFamilyAsTarget": {
      // Banqueroute #822 "toutes les invocations de la même famille que la cible subissent N":
      // the cast target itself is hit by the sibling DamageData; here we hit every other living
      // creature (either camp) sharing any family with the target.
      if (!ctx.targetCell) return;
      // The target may have just died from the sibling DamageData, applied right before by
      // applyEffects. The dead are only removed after the whole pass of effects
      // (resolveDeathsAndWin), so its body still holds its cell, and we find it to read its family.
      // The damage is simultaneous, so its death does not cancel the family sweep. Otherwise the
      // 6 AP spell turns into "N damage" as soon as it kills its target (the 2 other Chachas were left untouched).
      const target = creatures.find((c) => sameCoords(c.position, ctx.targetCell!) && c.currentLife > 0)
        ?? creatures.find((c) => sameCoords(c.position, ctx.targetCell!));
      if (!target) return;
      const fams = famsOf(target);
      const amount = (effect as { amount?: number }).amount ?? 0;
      if (amount <= 0 || fams.length === 0) return;
      for (const c of creatures) {
        if (c.currentLife <= 0 || c.instanceId === target.instanceId) continue;
        if (!(famsOf(c)).some((f) => fams.includes(f))) continue;
        const armorBefore = c.armor;
        const dealt = applyDamageToCreatureFromSpell(c, amount, log, creatures, ctx.casterSide);
        if (dealt > 0 || armorBefore > c.armor) log.push({ type: "DAMAGE", sourceInstanceId: ctx.sourceInstanceId ?? -1, targetInstanceId: c.instanceId, damage: dealt, armorHit: armorBefore > c.armor });
      }
      return;
    }
    case "AoeDamage": {
      // amount may be a die (Dé Rebondissant #573 "1d6 aux invocations adverses"),
      // one roll for the whole AoE, honouring Dé Pipé's floor.
      const amt = resolveDynamicValue((effect as { amount: number | DynamicValue }).amount, ctx.rng, ctx.diceFloor, diceSink(log, ctx)) | 0;
      handleAoeDamage(creatures, log, ctx, amt, scopeOf(effect), shapeOf(effect), (effect as { zone?: "ownCamp" | "enemyCamp" }).zone, (effect as { minAttack?: number }).minAttack, (effect as { excludeTargetCreature?: boolean }).excludeTargetCreature);
      return;
    }
    case "DamageEnemiesByEnemyCount": {
      // Dathura #600/#721/#909 (APPARITION): amount = number of enemy creatures in
      // `countZone` (ownCamp = the caster's half / board = everywhere). The damage
      // lands on enemy creatures per `target`: "all" (everywhere, #600), "ownCamp"
      // (only those in the caster's half, #721), or "front" (the first enemy ahead
      // on the source's row, #909).
      const e = effect as { target: "all" | "ownCamp" | "front"; countZone: "ownCamp" | "board" };
      let n = 0;
      for (const c of creatures) {
        if (c.currentLife <= 0 || c.owner === ctx.casterSide) continue; // count enemies only
        if (e.countZone === "ownCamp" && !isAlliedTerritory(c.position.x, ctx.casterSide)) continue;
        n++;
      }
      if (n <= 0) return;
      if (e.target === "front") {
        const me = findSelf(creatures, ctx);
        if (!me) return;
        const dx = me.owner === "ally" ? -1 : 1;
        const y = me.position.y;
        let tgt: CreatureInstance | undefined;
        for (let x = me.position.x + dx; x >= 0 && x < BOARD_COLS; x += dx) {
          const o = creatures.find((c) => c.currentLife > 0 && c.position.x === x && c.position.y === y);
          if (!o) continue;               // empty cell → keep scanning
          if (o.owner === me.owner) continue; // allied creature → does not block
          tgt = o; break;                 // first enemy ahead
        }
        if (tgt) dealSpellDamageThroughGuard(tgt, n, log, creatures, me.instanceId, ctx.casterSide, false, false); // Garde du corps (overflow), creature APPARITION damage, never spell (Joris ignores it)
        return;
      }
      for (const c of creatures) {
        if (c.currentLife <= 0 || c.owner === ctx.casterSide) continue;
        if (e.target === "ownCamp" && !isAlliedTerritory(c.position.x, ctx.casterSide)) continue;
        const armorBefore = c.armor;
        const dealt = applyDamageToCreatureFromSpell(c, n, log, creatures, ctx.casterSide, false, false); // Dathura APPARITION, creature damage, not a spell
        const armorHit = armorBefore > c.armor;
        if (dealt > 0 || armorHit) log.push({ type: "DAMAGE", sourceInstanceId: ctx.selfInstanceId ?? -1, targetInstanceId: c.instanceId, damage: dealt, armorHit });
      }
      return;
    }
    case "DamageRowByOwnCost": {
      // Gargoule #818 (HORDE APPARITION): amount = the AP actually paid to summon it, dealt
      // to every other creature on its row (allies and enemies, friendly fire), never to
      // itself. The bindata value is LastAPCost ("cost of the last card played by this
      // fighter" = this card on its own APPARITION), so it follows the paid cost, not the
      // printed one: a HORDE discount (−1 per Goule death) or a Polter surcharge changes it
      // through playedCostMod (floored at 0).
      const me = findSelf(creatures, ctx);
      if (!me) return;
      const cost = Math.max(0, (me.costOverride ?? getCard(me.cardId)?.cost ?? 0) + (me.playedCostMod ?? 0));
      if (cost <= 0) return;
      for (const c of creatures) {
        if (c.currentLife <= 0 || c.instanceId === me.instanceId) continue;
        if (c.position.y !== me.position.y) continue;
        const armorBefore = c.armor;
        const dealt = applyDamageToCreatureFromSpell(c, cost, log, creatures, ctx.casterSide, false, false); // Gargoule APPARITION, creature damage, not a spell
        const armorHit = armorBefore > c.armor;
        if (dealt > 0 || armorHit) log.push({ type: "DAMAGE", sourceInstanceId: me.instanceId, targetInstanceId: c.instanceId, damage: dealt, armorHit });
      }
      return;
    }
    case "DamageAdjacentFront": {
      // Pisti Yeul #932 (APPARITION): amount = the source's current attack, dealt to whatever
      // is on the single cell right ahead (x+forwardDx, same row): a creature of either side,
      // or, with hitDofus, the Dofus on that cell (a bush can summon Pisti right in front of a
      // Dofus).
      const me = findSelf(creatures, ctx);
      if (!me) return;
      const dmg = me.currentAttack;
      if (dmg <= 0) return;
      const dx = me.owner === "ally" ? -1 : 1;
      const cx = me.position.x + dx, cy = me.position.y;
      if (cx < 0 || cx >= BOARD_COLS) return;
      const c = creatures.find((o) => o.currentLife > 0 && o.position.x === cx && o.position.y === cy);
      if (c) {
        const armorBefore = c.armor;
        const dealt = applyDamageToCreatureFromSpell(c, dmg, log, creatures, ctx.casterSide, false, false); // Pisti Yeul APPARITION, creature damage, not a spell
        const armorHit = armorBefore > c.armor;
        if (dealt > 0 || armorHit) log.push({ type: "DAMAGE", sourceInstanceId: me.instanceId, targetInstanceId: c.instanceId, damage: dealt, armorHit });
        return;
      }
      if ((effect as { hitDofus?: boolean }).hitDofus) {
        const d = dofuses.find((o) => o.currentLife > 0 && o.position.x === cx && o.position.y === cy);
        if (d && !dofusInvulnerable(d, creatures)) { // Artheon #1424
          woundDofus(d, dmg, log, creatures, dofuses); // canonical Dofus damage (breaks any Sinistro)
          if (d.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", dofusAt: { ...d.position } });
          else log.push({ type: "DAMAGE", targetCell: { ...d.position }, damage: dmg });
        }
      }
      return;
    }
    case "AddArmorToAttack":
      handleAddArmorToAttack(creatures, log, ctx, scopeOf(effect), shapeOf(effect));
      return;
    case "AoePush":
      handleAoePush(creatures, dofuses, log, ctx, (effect as { distance: number }).distance | 0, scopeOf(effect), shapeOf(effect));
      return;
    case "WeakenFirstEnemyAhead":
      handleWeakenFirstEnemyAhead(creatures, log, ctx,
        resolveDynamicValue((effect as { amount: DynamicValue }).amount, ctx.rng, ctx.diceFloor, diceSink(log, ctx)) | 0,
        (effect as { duration?: string }).duration);
      return;
    case "ReduceDofusDamage": {
      // On the five Dofus of the caster, never the opponent's. Cumulative: two
      // copies played in the same turn reduce by 2 (the same reading as the sum
      // of the SpellDamageReductionAura of the pool).
      const n = Math.max(0, ((effect as { amount?: number }).amount ?? 0) | 0);
      if (n > 0) {
        for (const d of dofuses) {
          if (d.owner === ctx.casterSide) d.damageReduction = (d.damageReduction ?? 0) + n;
        }
      }
      return;
    }
    case "AttractFirstAhead":
      handleAttractFirstAhead(creatures, dofuses, log, ctx);
      return;

    case "Destroy":
      handleDestroy(creatures, log, ctx);
      return;

    case "AoeDestroy":
      handleAoeDestroy(creatures, log, ctx, effect as { scope: Scope; maxAttack?: number; maxLife?: number; condition?: { kind: string; value?: number }; shape?: AoeShape });
      return;

    case "RetreatSelf": {
      // Betty Boubz #145 (CONTRE COUP "Recule de N cases"): the source slides toward its own
      // wall (towardSide undefined → target.owner's wall), interacting with the board per cell.
      const me = findSelf(creatures, ctx);
      if (me) slideCreatureBack(me, creatures, dofuses, (effect as { cells?: number }).cells ?? 0, log, undefined, ctx.onSlideStep);
      return;
    }
    case "DestroyInFront":
      handleDestroyInFront(creatures, log, ctx, effect as { maxAttack?: number; enemyOnly?: boolean });
      return;
    case "DamageInFront":
      handleDamageInFront(creatures, dofuses, log, ctx, effect as { type: "DamageInFront"; amount: DynamicValue; hitDofus?: boolean });
      return;
    case "DamageDofusOnRow":
      handleDamageDofusOnRow(creatures, dofuses, log, ctx, (effect as { amount: number }).amount | 0);
      return;
    case "DamageDofusOnTargetRow":
      handleDamageDofusOnTargetRow(creatures, dofuses, log, ctx, (effect as { amount: number }).amount | 0);
      return;
    case "BoostMovementFromEnemyInLine":
      handleBoostMovementFromEnemyInLine(creatures, log, ctx);
      return;

    case "Charge":
      handleCharge(creatures, log, effect as { cells: number | "toWall" }, ctx);
      return;

    case "DamageFirstEnemyAheadPerFamily": {
      // "Vos <famille> infligent N dégâts à la première invocation adverse de
      // leur ligne": each living carrier of the caster's side sweeps its lane
      // (same y) towards the opponent's side and hits the closest enemy creature;
      // allies do not block, only enemies count.
      // One volley per carrier, and nothing if the lane has no enemy: the Dofus
      // is never hit.
      const ef = effect as { family: string; amount: number };
      const dmg = ef.amount | 0;
      if (dmg > 0) {
        const tireurs = creatures.filter(
          (c) => c.currentLife > 0 && c.owner === ctx.casterSide && !c.silenced && famsOf(c).includes(ef.family),
        );
        for (const me of tireurs) {
          const dx = me.owner === "ally" ? -1 : 1;
          let cible: CreatureInstance | undefined;
          let best = Infinity;
          for (const c of creatures) {
            if (c.currentLife <= 0 || c.owner === me.owner || c.position.y !== me.position.y) continue;
            const devant = (c.position.x - me.position.x) * dx;
            if (devant > 0 && devant < best) { best = devant; cible = c; }
          }
          if (!cible) continue;
          const armorBefore = cible.armor;
          const lifeBefore = cible.currentLife;
          dealSpellDamageThroughGuard(cible, dmg, log, creatures, me.instanceId, ctx.casterSide);
          if (cible.currentLife < lifeBefore || cible.armor < armorBefore) {
            log.push({
              type: "DAMAGE",
              sourceInstanceId: me.instanceId,
              targetInstanceId: cible.instanceId,
              damage: lifeBefore - cible.currentLife,
              armorHit: armorBefore > cible.armor,
            });
          }
        }
      }
      return;
    }
    case "RecoverSelfSpell":
      // A plain marker: castSpell reads it after the resolution to send the
      // spell back to the hand. Nothing to do here, but the case must exist so
      // that the marker does not fall into the "unknown type" branch.
      return;
    case "NoOp":
      // Poils de Jiji #281: a junk card with no effect, playing it just discards it.
      return;

    case "Teleport":
      handleTeleport(creatures, dofuses, log, effect as { cells: number | DynamicValue }, ctx);
      return;

    case "TeleportBehindAttacker":
      handleTeleportBehindAttacker(creatures, dofuses, log, ctx);
      return;

    case "TakeControl":
      handleTakeControl(creatures, log, ctx);
      return;

    case "Silence":
      handleSilence(creatures, log, ctx, scopeOf(effect), shapeOf(effect), (effect as { single?: boolean }).single, (effect as { excludeSelf?: boolean }).excludeSelf);
      return;

    case "ShooterRangeData":
      // Static creature-shape effect (defines a ranged-attacker's
      // targeting volume). Applied at summon time by the creature setup
      // not at cast time. No-op here.
      return;

    case "SelfDamageData":
      handleSelfDamage(creatures, log, effect as { Damage: number }, ctx);
      return;
    case "BoostAttackData":
      handleBoostAttack(creatures, effect as { Boost: number }, ctx);
      return;
    case "BoostLifeData":
      handleBoostLife(creatures, effect as { Boost: number }, ctx);
      return;
    case "HealSelfData":
      handleHealSelf(creatures, log, effect as { Heal: number }, ctx);
      return;

    case "BoostMovementPoisonData": {
      // Gangraîne #1439: "L'invocation ciblée subit N dégât(s) par case parcourue
      // quand elle se déplace ou qu'elle charge." Stamp the poison value on the
      // single picked creature; the per-cell damage is dealt by advanceCreature's
      // step loop (rules.ts). Additive: a second cast adds to it, as in the
      // original game.
      if (!ctx.targetCell) return;
      const tgt = creatures.find((c) => sameCoords(c.position, ctx.targetCell!) && c.currentLife > 0);
      if (!tgt) return;
      const amount = resolveDynamicValue((effect as { Value: DynamicValue }).Value, ctx.rng, ctx.diceFloor, diceSink(log, ctx)) | 0;
      if (amount !== 0) tgt.movementPoison = Math.max(0, tgt.movementPoison + amount);
      return;
    }

    case "AttachSinistro":
      // Sinistro #215: attach a Sinistro equipment to the targeted allied Dofus (no damage).
      handleAttachSinistro(dofuses, log, ctx);
      return;

    case "AttachNecronomigore":
      // Nécronomigore #700: attach the Nécronomigore equipment (counter=6) to the targeted allied Dofus (no damage).
      handleAttachNecronomigore(dofuses, ctx);
      return;

    case "BoostResistanceData":
    case "CreateCardCounterData":
    case "SinistroData":
      // TODO: per-type handling. Silent no-op for now. (SinistroData still appears on
      // other cards, e.g. Diod Dewit #337, keep the no-op so they do not crash.)
      return;

    default:
      // Unknown effect type, log nothing (we do not want to spam) and
      // let the spell resolve as a partial cast.
      return;
  }
}

// Apply every effect on a card in order. Effects on a single card are
// cumulative: e.g. a spell with [Damage 2, SetProperty Stun] both damages
// and stuns the target.
export function applyEffects(
  creatures: CreatureInstance[],
  dofuses: DofusInstance[],
  log: GameEvent[],
  effects: Effect[],
  ctx: EffectContext,
): void {
  const logStart = log.length;
  for (const e of effects) {
    applyEffect(creatures, dofuses, log, e, ctx);
  }
  // Dargone #1291 / Malox Makugen #76: react to heals that landed during these effects.
  // applyEffect never re-enters applyEffects, so each LIFE_HEALED is scanned exactly once here.
  applyHealReactions(creatures, dofuses, log, logStart);
}

// "Chaque fois qu'un allié est soigné, réduit de N l'AT de la première invocation adverse
// de sa ligne ayant ≥ minAt AT" (Dargone #1291). For every LIFE_HEALED of a creature
// logged during this applyEffects pass whose owner controls a living Dargone, the enemy
// on Dargone's row closest to Dargone with at least minAt AT loses N AT.
function applyHealReactions(creatures: CreatureInstance[], dofuses: DofusInstance[], log: GameEvent[], logStart: number): void {
  const dargones = creatures.filter((c) => c.currentLife > 0 && (effsOf(c)).some((e) => e.type === "ReduceFirstEnemyAtOnAllyHeal"));
  // Malox Makugen #76: "inflige N au dofus adverse de sa ligne quand UNE invocation est soignée"
  // reacts to any creature healed (both sides), striking the enemy Dofus on Malox's own row.
  const maloxes = creatures.filter((c) => c.currentLife > 0 && (effsOf(c)).some((e) => e.type === "DamageDofusOnRowOnHeal"));
  // Pacificatrice Enjouée #1519: "inflige N dégât aux invocations ADVERSES quand une invocation
  // ALLIÉE est soignée", reacts only to an ally heal, hitting every enemy creature (not Dofus).
  const pacifs = creatures.filter((c) => c.currentLife > 0 && (effsOf(c)).some((e) => e.type === "DamageEnemiesOnAllyHeal"));
  if (dargones.length === 0 && maloxes.length === 0 && pacifs.length === 0) return;
  for (let i = logStart; i < log.length; i++) {
    const ev = log[i] as { type: string; instanceId?: number };
    if (ev.type !== "LIFE_HEALED" || ev.instanceId == null) continue;
    const healed = creatures.find((c) => c.instanceId === ev.instanceId);
    if (!healed || healed.currentLife <= 0) continue; // a Dofus heal has no creature
    for (const m of maloxes) {
      if (m.currentLife <= 0) continue;
      const mk = (effsOf(m)).find((e) => e.type === "DamageDofusOnRowOnHeal") as { amount?: number } | undefined;
      const amount = mk?.amount ?? 1;
      const dof = dofuses.find((o) => o.currentLife > 0 && o.owner !== m.owner && o.position.y === m.position.y);
      if (!dof || dofusInvulnerable(dof, creatures)) continue; // Artheon #1424
      woundDofus(dof, amount, log, creatures, dofuses); // canonical Dofus damage (breaks any Sinistro)
      if (dof.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", dofusAt: { ...dof.position } });
      else log.push({ type: "DAMAGE", targetCell: { ...dof.position }, damage: amount });
    }
    for (const d of dargones) {
      if (d.currentLife <= 0 || healed.owner !== d.owner) continue;
      const mk = (effsOf(d)).find((e) => e.type === "ReduceFirstEnemyAtOnAllyHeal") as { amount?: number; minAt?: number } | undefined;
      const amount = mk?.amount ?? 1, minAt = mk?.minAt ?? 0;
      const enemies = creatures.filter((c) => c.currentLife > 0 && c.owner !== d.owner && c.position.y === d.position.y && c.currentAttack >= minAt);
      if (enemies.length === 0) continue;
      enemies.sort((a, b) => Math.abs(a.position.x - d.position.x) - Math.abs(b.position.x - d.position.x));
      const target = enemies[0];
      const before = target.currentAttack;
      const after = Math.max(0, before - amount);
      target.currentAttack = after;
      target.baseAttack = Math.max(0, target.baseAttack - amount);
      log.push({ type: "ATTACK_GAINED", instanceId: target.instanceId, attackMod: { valueBefore: before, modification: after - before, valueAfter: after } });
    }
    for (const p of pacifs) {
      // Only an ally heal arms it; each living Pacificatrice then sprays every enemy
      // creature (not Dofus) for N, armour/resistance applying normally, same per-hit
      // shape as handleAoeDamage. Fires once per ally-heal event (an AoE heal of 2
      // allies → two sprays). A dead enemy from an earlier spray is skipped (life ≤ 0).
      if (p.currentLife <= 0 || healed.owner !== p.owner) continue;
      const mk = (effsOf(p)).find((e) => e.type === "DamageEnemiesOnAllyHeal") as { amount?: number } | undefined;
      const amount = mk?.amount ?? 1;
      for (const enemy of creatures) {
        if (enemy.currentLife <= 0 || enemy.owner === p.owner) continue;
        const armorBefore = enemy.armor;
        const dealt = applyDamageToCreatureFromSpell(enemy, amount, log, creatures, p.owner, false, false); // Pacificatrice spray, creature passive, not a spell
        const armorHit = armorBefore > enemy.armor;
        if (dealt > 0 || armorHit) {
          log.push({ type: "DAMAGE", sourceInstanceId: p.instanceId, targetInstanceId: enemy.instanceId, damage: dealt, armorHit });
        }
      }
    }
  }
}

// Does this effect type require the player to choose an external target
// (i.e. not the source creature itself, but another cell / creature on
// the board)? Used by the trigger system to decide if it should pause
// for an interactive pick or apply immediately.
export function effectRequiresTarget(eff: Effect): boolean {
  // Row-pick AoE (Tikoko): it is an area effect, but the player still chooses
  // which row, so it needs an interactive pick.
  if (eff.type === "BoostColumnAttack") return true;
  // Moskito's APPARITION: source swaps places with a picked allied creature.
  if (eff.type === "SwapSourcePosition") return true;
  // Asprogik Mils' APPARITION: source swaps its attack with a picked creature.
  if (eff.type === "SwapSourceAttack") return true;
  // Chacha Sauvage's APPARITION: source swaps its movement with a picked creature.
  if (eff.type === "SwapSourceMovement") return true;
  // Larve Orange's APPARITION: the player picks a creature whose armour is wiped.
  if (eff.type === "DestroyArmor") return true;
  // Alfonse Dé (Pandawa god): the player picks the Pandawa whose drunkenness toggles.
  if (eff.type === "ToggleDrunk") return true;
  if (eff.type === "AttractCreature") return true; // Chacha Tyran #943: pick the creature to pull
  if (eff.type === "MoveAdjacentRowRandom") return true; // Larve Verte #139: pick the creature to teleport to a random adjacent row
  if (eff.type === "CopyFamilyFromTarget") return true; // Pupuce #441: pick the creature whose family the source adopts
  if (eff.type === "TutorCopyOfTarget") return true; // Wabbit en Chocolat #733: pick the creature whose copy is pulled from the deck
  if (eff.type === "CopyTextFromTarget") return true; // Anathar #316 (V2): pick the ENEMY creature whose text the source adopts
  // Phaeris' APPARITION ("silence les invocations d'UNE ligne"): a shaped silence
  // needs a pick to choose which line, the targetCell anchors the row/column.
  // Exception: `selfAnchored` (Frondeur Nimbos #1168 "les autres invocations de SA ligne")
  // auto-centers on the source's cell, so it applies immediately like AoeDamage shape:row.
  if (eff.type === "Silence" && (eff as { shape?: string }).shape && !(eff as { selfAnchored?: boolean }).selfAnchored) return true;
  // Tartanque / Tofu Mutant: the player picks one of their own creatures to sacrifice.
  if (eff.type === "Sacrifice") return true;
  // Amalia's poupée: the player chooses a valid summon cell to place the token on.
  if (eff.type === "SummonToken" && ["choose", "campChoose"].includes((eff as { placement?: string }).placement ?? "")) return true;
  // Kerubim "dévoilez un dofus [adverse]" (#333/#378/#1234): a single reveal is a
  // player pick (you target which Dofus). scope all/line auto-apply (no target).
  if (eff.type === "RevealDofuses" && (eff as { scope?: string }).scope === "one") return true;
  // Patek Tag's APPARITION: the player picks a prism to destroy.
  if (eff.type === "DestroyPrism") return true;
  if (eff.type === "DestroyBoardObject") return true; // Tournesol Sauvage #1082: pick the board object to destroy
  if (eff.type === "BounceColumn") return true; // #1269: pick the column (rangée) to bounce
  if (eff.type === "SacrificeForReserve") return true; // Embaumement #1460: pick the ally creature to sacrifice
  if (eff.type === "TeleportToCell") return true; // Téléportation #119: 1st pick = the ally creature to teleport
  if (eff.type === "ProtectDofus") return true; // Lien de Sang #1495: 1st pick = the ally creature that will protect a Dofus
  if (eff.type === "GuardCreature") return true; // Garde du corps #320/#300: APPARITION pick = the ally creature it protects
  if (eff.type === "DamageDofus") return true; // Padgref Démouelle #222: APPARITION pick = one of your Dofus to damage (held off the board until chosen)
  if (eff.type === "DamageAllyToSummon") return true; // Pampactus #218: APPARITION pick = an ally creature to damage (cost to summon)
  if (eff.type === "RamasserPrisme" && (eff as { choose?: boolean }).choose) return true; // Lou 2★ #521: APPARITION pick = which prism to collect
  if (eff.type === "RespawnPrisms" && (eff as { choose?: boolean }).choose) return true; // Lou 1★ #572: APPARITION pick = which own first-column row gets its prism back
  if (eff.type === "MakeDofusInvulnerable") return true; // Artheon #1424: APPARITION pick = any Dofus, made invulnerable while Artheon lives (held off the board until chosen)
  if (eff.type === "ShieldDofus") return true; // Pissenlit Maléfique #1041: APPARITION pick = an ally Dofus, given a one-hit shield (held off the board until chosen)
  if (eff.type === "TeleportToGlyph") return true; // Téléglyphe #1735: 1st pick = the creature to teleport onto a glyph
  if (eff.type === "SwapDofus") return true; // Ush #426/#13: pick the other Dofus to swap with
  if (eff.type === "MoveRowDofus") return true; // Ush #100: pick the destroyed-Dofus slot to move to
  if (eff.type === "AttachSinistro") return true; // Diod Dewit #337 APPARITION: pick an allied Dofus to equip with the Sinistro
  // Erik Rak's APPARITION: the player picks a prism to turn into a Butin.
  if (eff.type === "TransformPrismToButin") return true;
  // Remington Smisse #80 APPARITION: the player picks a prism to turn into a Bombe.
  if (eff.type === "TransformPrismToBombe") return true;
  // Kibri's APPARITION: the player picks one of their own prisms to sacrifice.
  if (eff.type === "SacrificePrismBuff") return true;
  // Marline's APPARITION: source swaps place and side with a picked enemy.
  if (eff.type === "SwapBody") return true;
  // Seed-transform pick (Li Crounch/Dodu/Canar APPARITION): the player chooses
  // one of their own planted seeds to turn into the token creature.
  if (eff.type === "TransformSeed") return true;
  // Seed → Buisson pick (Selk Ator APPARITION): same own-seed pick.
  if (eff.type === "TransformSeedToBush") return true;
  // Glyph placed by a trigger (Melita APPARITION): the player picks an empty cell
  // of their camp. (On a spell the cast cell is the target, no pending.)
  if (eff.type === "PlaceGlyph") return true;
  // Tas d'Os placed by a trigger (Chafer Archer #336 APPARITION): the player picks
  // an empty cell of their camp. (On the #691 Tas d'Os AOE card the cast cell is the
  // target, castSpell applies the effect directly, never consulting this.)
  if (eff.type === "PlaceTasDOs") return true;
  // Butin placed by a trigger (V2 Erik Rak #720 APPARITION): the player chooses the cell, on
  // either side. Strictly tied to `pickCell`: without it PlaceButin keeps its V1 path (spells
  // #789 / #1382 / #1104: the cast cell is the target, castSpell never looks at this function).
  // No card of the V1 catalogue carries PlaceButin in a `trigger`.
  if (eff.type === "PlaceButin") return !!(eff as { pickCell?: string }).pickCell;
  // Tas d'Os: "Transformez UN tas d'os allié" (#738) = the player chooses which one.
  // #147 Roi Chafer carries all:true ("TOUS les tas d'os"), so there is no choice.
  if (eff.type === "TransformTasDOs") return !(eff as { all?: boolean }).all;
  // "Détruisez UN tas d'os allié" (#223 self, #626 chafers) = a pick as well.
  // Required: ConsumeTasDOsBuff carries a `scope` field ("self"/"chafers") that is not an AoE
  // zone, so this test must stay before the `scope` shortcut below, otherwise the pick is
  // never asked.
  if (eff.type === "ConsumeTasDOsBuff") return true;
  // Any scoped effect is an AoE applied to a whole side/area, no pick needed.
  if ((eff as { scope?: string }).scope) return false;
  switch (eff.type) {
    case "DamageData":
    case "PushData":
    case "SetPropertyData":
    case "Heal":
    case "Destroy":
    case "BoostAttack":
    case "BoostArmor":
    case "Charge":
    case "SetMovement":
    case "BoostMovement":
    case "SetAttack":
    case "SetLife":
    case "Teleport":
    case "TakeControl":
    case "ReturnToHand":
    case "ReturnToDeck":
    case "Transform":
      // A "Se transforme en X" self-transform needs no pick (it acts on the
      // source creature, found via ctx.targetCell); a "Transforme une
      // invocation en X" spell prompts for the target.
      return !(eff as { self?: boolean }).self;
    case "SetProperty":
      // Targeted grant prompts; a "Gagne X" self-grant does not (scoped grants
      // are already short-circuited by the scope guard at the top).
      return !(eff as { self?: boolean }).self;
    case "Silence":
      // A scoped Silence (enemy_camp / cross) is an AoE, already returned false
      // by the scope guard above. A `single` Silence ("Réduisez UNE invocation au
      // silence", Justice #209) picks one creature; bare Silence (Mot de Silence
      // #220) hits the whole board with no pick.
      return !!(eff as { single?: boolean }).single;
    case "TriggerAttack":
    case "BoostRange":
      // SetProperty on a trigger usually targets an ally creature
      // ("APPARITION: Donne Furtif à une invocation alliée"). When
      // emitted from a spell we get the click target already in
      // ctx.targetCell; when emitted from a trigger we need the pick.
      // Exception: a self range-buff (Soldat Tripoux #1337 "MORT ADVERSE : +1 portée")
      // applies to the source, no pick.
      if (eff.type === "BoostRange" && (eff as { self?: boolean }).self) return false;
      return true;
    default:
      return false;
  }
}

// What kind of target a given effect needs. The hint string is used by
// the UI to write a localised prompt; the `filter` drives target-cell
// validation.
export function effectTargetFilter(
  eff: Effect,
): { filter: "enemy_creature" | "copyable_enemy_creature" | "wounded_enemy_creature" | "ally_creature" | "any_creature" | "any_dofus" | "any_cell" | "own_seed" | "own_tas_dos" | "own_empty_camp" | "free_cell_any_camp" | "own_summon_cell" | "any_prism" | "ally_prism" | "enemy_prism" | "prism_in_enemy_camp" | "own_prismless_first_col" | "board_object" | "ally_dofus" | "ally_dofus_no_equipment" | "enemy_dofus" | "ally_glyph" | "destroyed_ally_dofus" | "enemy_unrevealed_dofus"; prompt: string } {
  if (eff.type === "Heal" && (eff as { dofus?: boolean }).dofus) {
    return { filter: "any_dofus", prompt: "Choisissez un Dofus à soigner." };
  }
  if (eff.type === "RevealDofuses" && (eff as { scope?: string }).scope === "one") {
    return (eff as { side?: string }).side === "enemy"
      ? { filter: "enemy_unrevealed_dofus", prompt: "Choisissez un Dofus adverse à dévoiler." }
      : { filter: "any_dofus", prompt: "Choisissez un Dofus à dévoiler." };
  }
  if (eff.type === "ReturnToHand" && (eff as { pickSide?: string }).pickSide) {
    // "Remontez une de VOS invocations dans votre main" (Arakne Albinos #260): the
    // pick is restricted to the caster's own side, not any creature.
    return (eff as { pickSide?: string }).pickSide === "enemy"
      ? { filter: "enemy_creature", prompt: "Choisissez une invocation adverse à renvoyer." }
      : { filter: "ally_creature", prompt: "Choisissez une de vos invocations à renvoyer en main." };
  }
  if (eff.type === "ToggleDrunk") {
    // Alfonse Dé (Pandawa god): "un Pandawa ALLIÉ". Without this case, the any_cell
    // fallback made an enemy Pandawa targetable, and a click on an empty cell used up
    // the trigger. The family is already narrowed by pickFamily.
    return { filter: "ally_creature", prompt: "Choisissez un Pandawa allié à saouler ou dégriser." };
  }
  if (eff.type === "DestroyPrism") {
    return { filter: "any_prism", prompt: "Choisissez un prisme à détruire." };
  }
  if (eff.type === "DestroyBoardObject") {
    return { filter: "board_object", prompt: "Choisissez l'objet de plateau à détruire." };
  }
  if (eff.type === "BounceColumn") {
    return { filter: "any_cell", prompt: "Choisissez une rangée (colonne) à remonter en main." };
  }
  if (eff.type === "SacrificeForReserve") {
    return { filter: "ally_creature", prompt: "Choisissez une invocation alliée à sacrifier." };
  }
  if (eff.type === "TeleportToCell") {
    return { filter: "ally_creature", prompt: "Choisissez une invocation à téléporter." };
  }
  if (eff.type === "ProtectDofus") {
    return { filter: "ally_creature", prompt: "Choisissez l'invocation alliée qui protégera un Dofus." };
  }
  if (eff.type === "DamageDofus") {
    return (eff as { side?: string }).side === "enemy"
      ? { filter: "enemy_dofus", prompt: "Choisissez un Dofus adverse à blesser." }
      : { filter: "ally_dofus", prompt: "Choisissez un de vos Dofus à blesser (pour invoquer)." };
  }
  if (eff.type === "DamageAllyToSummon") {
    return { filter: "ally_creature", prompt: "Choisissez l'invocation alliée à blesser pour invoquer (cliquez hors du terrain pour annuler)." };
  }
  if (eff.type === "RamasserPrisme") {
    // V2 Malocac #85 "Récupérez un prisme dans le camp adverse": `inZone` replaces the owner
    // criterion by a position criterion, so it is tested first and takes priority over `side`,
    // exactly as in the pool filter of RamasserPrisme (rules.ts), since both must name the same
    // set of prisms.
    if ((eff as { inZone?: string }).inZone === "enemyCamp") {
      return { filter: "prism_in_enemy_camp", prompt: "Choisissez un prisme dans le camp adverse à récupérer (cliquez ailleurs pour ne rien récupérer, ou hors du terrain pour annuler la pose)." };
    }
    // `side` restricts which prisms are pickable: Malocac #85 "un prisme ADVERSE" → enemy_prism,
    // an ally-only pickup → ally_prism, else any prism (Lou #521 "un prisme").
    const side = (eff as { side?: string }).side;
    const filter = side === "enemy" ? "enemy_prism" : side === "ally" ? "ally_prism" : "any_prism";
    const what = side === "enemy" ? "un prisme adverse" : side === "ally" ? "un de vos prismes" : "un prisme";
    return { filter, prompt: `Choisissez ${what} à récupérer (cliquez ailleurs pour ne rien récupérer, ou hors du terrain pour annuler la pose).` };
  }
  if (eff.type === "RespawnPrisms" && (eff as { choose?: boolean }).choose) {
    // Lou 1★ #572: pick one of your FIRST-COLUMN (x=8) rows that has no prism, the
    // prism of that row (PRISM_PATTERN[y]) reappears there.
    return { filter: "own_prismless_first_col", prompt: "Choisissez la ligne (1ʳᵉ colonne) où faire réapparaître votre prisme." };
  }
  if (eff.type === "MakeDofusInvulnerable") {
    return { filter: "any_dofus", prompt: "Choisissez un Dofus à rendre invulnérable." };
  }
  if (eff.type === "ShieldDofus") {
    return { filter: "ally_dofus", prompt: "Choisissez un Dofus allié à protéger d'un bouclier." };
  }
  if (eff.type === "GuardCreature") {
    return { filter: "ally_creature", prompt: "Choisissez l'invocation alliée à protéger." };
  }
  if (eff.type === "TeleportToGlyph") {
    return { filter: "any_creature", prompt: "Choisissez une invocation à téléporter sur un glyphe." };
  }
  if (eff.type === "SwapDofus") {
    return { filter: (eff as { side?: string }).side === "enemy" ? "enemy_dofus" : "ally_dofus", prompt: "Choisissez l'autre Dofus à échanger." };
  }
  if (eff.type === "AttachSinistro") {
    return { filter: "ally_dofus_no_equipment", prompt: "Choisissez un Dofus allié (sans équipement) où poser le Sinistro." };
  }
  if (eff.type === "AttachNecronomigore") {
    return { filter: "ally_dofus_no_equipment", prompt: "Choisissez un Dofus allié (sans équipement) où poser le Nécronomigore." };
  }
  if (eff.type === "MoveRowDofus") {
    return { filter: "destroyed_ally_dofus", prompt: "Choisissez l'emplacement d'un Dofus détruit." };
  }
  if (eff.type === "SacrificePrismBuff") {
    return { filter: "ally_prism", prompt: "Choisissez un de vos prismes à sacrifier (cliquez ailleurs pour ne rien sacrifier, ou hors du terrain pour annuler la pose)." };
  }
  if (eff.type === "TransformPrismToButin") {
    return { filter: "any_prism", prompt: "Choisissez un prisme à transformer en Butin." };
  }
  if (eff.type === "TransformPrismToBombe") {
    return { filter: "any_prism", prompt: "Choisissez un prisme à transformer en Bombe." };
  }
  if (eff.type === "TransformSeed" || eff.type === "TransformSeedToBush") {
    return { filter: "own_seed", prompt: "Choisissez une de vos graines à transformer." };
  }
  if (eff.type === "TransformTasDOs") {
    return { filter: "own_tas_dos", prompt: "Choisissez un de vos tas d'os à transformer en Chafer Décrépit." };
  }
  if (eff.type === "ConsumeTasDOsBuff") {
    return { filter: "own_tas_dos", prompt: "Choisissez un de vos tas d'os à détruire." };
  }
  if (eff.type === "PlaceGlyph") {
    return { filter: "own_empty_camp", prompt: "Choisissez une case vide de votre camp pour le Glyphe." };
  }
  if (eff.type === "PlaceTasDOs") {
    return { filter: "own_empty_camp", prompt: "Choisissez une case vide de votre camp pour le Tas d'Os." };
  }
  if (eff.type === "PlaceButin" && (eff as { pickCell?: string }).pickCell) {
    // V2 Erik Rak #720: no side restriction, unlike Trouvaille #1382 / #789, which place
    // "dans votre camp". A prism on the cell is accepted: the placement replaces it, which is
    // the whole point of the free choice.
    return { filter: "free_cell_any_camp", prompt: "Choisissez une case libre ou poser le Butin (n'importe quel camp)." };
  }
  switch (eff.type) {
    case "PushData":
      // "Repousse une invocation", typically targets an enemy
      // invocation (the side is implied by the card text but we
      // simplify to "any creature" so push-self / push-ally cards
      // (Esquive "Repousse une invocation alliée") also work.
      return { filter: "any_creature", prompt: "Choisissez une invocation à repousser." };
    case "DamageData":
      return { filter: "any_creature", prompt: "Choisissez une cible." };
    case "Destroy":
      return { filter: "any_creature", prompt: "Choisissez une invocation à détruire." };
    case "AttractCreature":
      return { filter: "any_creature", prompt: "Choisissez une invocation à attirer." };
    case "MoveAdjacentRowRandom":
      return { filter: "any_creature", prompt: "Choisissez une invocation à déplacer sur une ligne adjacente." };
    case "CopyFamilyFromTarget":
      return { filter: "any_creature", prompt: "Choisissez l'invocation dont copier la famille." };
    case "CopyTextFromTarget":
      return { filter: "copyable_enemy_creature", prompt: "Choisissez l'invocation adverse dont copier le texte." };
    case "TutorCopyOfTarget":
      return { filter: "any_creature", prompt: "Choisissez l'invocation dont tirer une copie de la pioche." };
    case "Heal":
      return { filter: "any_creature", prompt: "Choisissez une invocation à soigner." };
    case "BoostAttack":
      // `side` restricts the pick (Flécheur #986 "à une invocation ALLIÉE" → ally_creature).
      return { filter: (eff as { side?: string }).side === "ally" ? "ally_creature" : (eff as { side?: string }).side === "enemy" ? "enemy_creature" : "any_creature", prompt: "Choisissez une invocation à renforcer." };
    case "BoostColumnAttack":
      return { filter: "any_cell", prompt: "Choisissez une rangée (colonne) — +1 AT à toutes ses invocations." };
    case "SwapSourcePosition": {
      const cap = (eff as { maxAttack?: number }).maxAttack;
      return {
        filter: "ally_creature",
        prompt:
          cap != null
            ? `Choisissez une de vos invocations (${cap} AT ou moins) pour échanger sa position.`
            : "Choisissez une de vos invocations pour échanger sa position.",
      };
    }
    case "SwapSourceAttack":
      return { filter: "any_creature", prompt: "Choisissez une autre invocation pour échanger son AT." };
    case "SwapSourceMovement":
      return { filter: "any_creature", prompt: "Choisissez une autre invocation pour échanger ses PM." };
    case "SwapBody": {
      const cap = (eff as { maxAttack?: number }).maxAttack;
      return {
        filter: "enemy_creature",
        prompt:
          cap != null
            ? `Choisissez une invocation adverse (${cap} AT ou moins) — échange de corps (position + camp).`
            : "Choisissez une invocation adverse — échange de corps (position + camp).",
      };
    }
    case "BoostArmor":
      return { filter: (eff as { side?: string }).side === "ally" ? "ally_creature" : (eff as { side?: string }).side === "enemy" ? "enemy_creature" : "any_creature", prompt: "Choisissez une invocation à blinder." };
    case "Charge":
      return { filter: "any_creature", prompt: "Choisissez une invocation à faire charger." };
    case "SetMovement":
    case "BoostMovement":
    case "SetAttack":
      return { filter: "any_creature", prompt: "Choisissez une invocation." };
    case "SetLife":
      return { filter: "any_creature", prompt: "Choisissez une invocation dont les PV chutent." };
    case "Teleport":
      return { filter: "any_creature", prompt: "Choisissez une invocation à téléporter." };
    case "TakeControl":
      return { filter: "enemy_creature", prompt: "Choisissez une invocation adverse à contrôler." };
    case "ReturnToHand":
    case "ReturnToDeck":
      return { filter: "any_creature", prompt: "Choisissez une invocation à renvoyer." };
    case "TriggerAttack":
      return { filter: "any_creature", prompt: "Choisissez une invocation qui attaque." };
    case "BoostRange":
      return { filter: "any_creature", prompt: "Choisissez une invocation à distance." };
    case "Transform":
      // "Transforme une invocation en X" picks any creature; but the "un de VOS <famille>"
      // variant (Wa Wabbit #59 "un de vos Wabbits", the only pickFamily Transform) is
      // restricted to your side, so an enemy member of that family cannot be picked.
      return (eff as { pickFamily?: string }).pickFamily
        ? { filter: "ally_creature", prompt: "Choisissez une de vos invocations à transformer." }
        : { filter: "any_creature", prompt: "Choisissez une invocation à transformer." };
    case "SetPropertyData":
      return { filter: "ally_creature", prompt: "Choisissez une invocation alliée." };
    case "SetProperty":
      return { filter: "any_creature", prompt: "Choisissez une invocation." };
    case "Silence":
      // A shaped silence (Phaeris "d'une ligne") picks any cell to anchor the
      // row/column; a single/bare silence picks one creature.
      if ((eff as { shape?: string }).shape)
        return { filter: "any_cell", prompt: "Choisissez une ligne — toutes ses invocations sont réduites au silence." };
      return { filter: "any_creature", prompt: "Choisissez une invocation à réduire au silence." };
    case "DestroyArmor":
      return { filter: "any_creature", prompt: "Choisissez une invocation dont l'AR est détruite." };
    case "Sacrifice":
      return { filter: "ally_creature", prompt: "Sacrifiez une de vos invocations." };
    case "SummonToken":
      // `campChoose` (Gwand Pa Wabbit #143) lets the player drop a wall token anywhere
      // in their territory; the default `choose` (Amalia's poupée) is the spawn zone.
      return (eff as { placement?: string }).placement === "campChoose"
        ? { filter: "own_empty_camp", prompt: "Choisissez une case libre de votre camp." }
        : { filter: "own_summon_cell", prompt: "Choisissez une case d'invocation pour la poupée." };
    default:
      return { filter: "any_cell", prompt: "Choisissez une case." };
  }
}

// Garde du corps #320/#300 (local mirror of rules.ts `guardOf`, same anti-circular-dep
// reason): if `victim` is protected by a living bodyguard, return it so spell damage is
// dealt to the bodyguard instead; otherwise return `victim` unchanged.
function guardOfSpell(victim: CreatureInstance, creatures: CreatureInstance[]): CreatureInstance {
  // Silencing the guard or the protected creature cuts the link. This is a deliberate
  // exception to "silence cuts what a creature gives, not what it receives", so do not
  // derive it from the general rule, it contradicts it.
  if (victim.protectedByGuard == null || victim.silenced) return victim;
  const g = creatures.find((c) => c.instanceId === victim.protectedByGuard && c.currentLife > 0 && !c.silenced);
  return g && g.instanceId !== victim.instanceId ? g : victim;
}

// Garde du corps #320/#300, deal `dmg` to `victim` as a spell/targeted hit, but route it through a
// living bodyguard when one is shielding `victim`. The guard only soaks up to its own life: any
// excess (what would drop it past 0) overflows onto the protected creature, which then meets the
// leftover with its own defences. E.g. 3 dmg onto A guarded by a 2-life B → B takes 2 (dies), A
// takes 1. (`dealt` is the post-shield/résistance/armure life damage and currentLife is left
// unclamped by applyDamageToCreatureFromSpell, so `dealt - lifeBefore` is exactly the overflow.)
// Logs DAMAGE / FIGHT_OBJECT_REMOVED for each creature actually hit.
export function dealSpellDamageThroughGuard(
  victim: CreatureInstance,
  dmg: number,
  log: GameEvent[],
  creatures: CreatureInstance[],
  sourceInstanceId: number,
  casterSide?: Side,
  pierceArmor = false,
  isSpell = true,
): void {
  const guard = guardOfSpell(victim, creatures);
  const lifeBefore = guard.currentLife;
  const guardArmorBefore = guard.armor;
  const dealt = applyDamageToCreatureFromSpell(guard, dmg, log, creatures, casterSide, pierceArmor, isSpell);
  if (dealt > 0 || guardArmorBefore > guard.armor) {
    log.push({ type: "DAMAGE", sourceInstanceId, targetInstanceId: guard.instanceId, damage: dealt, armorHit: guardArmorBefore > guard.armor });
  }
  if (guard.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", instanceId: guard.instanceId });
  if (guard === victim) return; // not guarded, the hit landed directly
  const overflow = Math.max(0, dealt - lifeBefore);
  if (overflow <= 0) return; // the bodyguard soaked the whole hit
  const armorBefore = victim.armor;
  const through = applyDamageToCreatureFromSpell(victim, overflow, log, creatures, casterSide, pierceArmor, isSpell);
  if (through > 0 || armorBefore > victim.armor) {
    log.push({ type: "DAMAGE", sourceInstanceId, targetInstanceId: victim.instanceId, damage: through, armorHit: armorBefore > victim.armor });
  }
  if (victim.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", instanceId: victim.instanceId });
}

// "Réduit de N les dégâts des sorts adverses" (Joris #110, SpellDamageReductionAura): sum of
// the N of all living sources of camp `ownerSide`. Used for both kinds of target of an enemy
// spell: a creature (applyDamageToCreatureFromSpell) and a Dofus (handleDamage; the Fléau
// #757 used to show the reduction on the card while the Dofus still took the raw damage).
function sumSpellDamageReduction(creatures: CreatureInstance[], ownerSide: Side): number {
  let reduction = 0;
  for (const c of creatures) {
    if (c.currentLife <= 0 || c.owner !== ownerSide) continue;
    const a = (effsOf(c)).find((e) => e.type === "SpellDamageReductionAura") as { amount?: number } | undefined;
    if (a) reduction += a.amount ?? 0;
  }
  return reduction;
}

// Local mirror of `applyDamageToCreature` from rules.ts, duplicated here to
// keep effects.ts free of circular deps on rules. Same defensive order:
// Shield → CantDie/Invulnerable → Résistance (flat reducer, not consumed) →
// Armure (absorbing pool, consumed) → life. Spell damage does not pierce
// armor by default (the few PierceArmor spell sources will pass a flag once
// we wire them).
// Returns the damage that reduced life (0 if shield/dodge/Résistance/armor
// ate it all).
function applyDamageToCreatureFromSpell(
  target: CreatureInstance,
  damage: number,
  log: GameEvent[],
  creatures: CreatureInstance[] = [],
  casterSide?: Side,
  pierceArmor = false,
  // false = this damage is not spell damage (a creature's own "s'inflige N dégât" keyword, etc.).
  // It still goes through the full defensive chain (Bouclier → Résistance → Armure → HP), but the
  // two spell-only modifiers below are skipped: an "insensible aux dégâts des sorts" creature does
  // not dodge its own self damage, and the anti-spell reduction aura does not reduce it.
  isSpell = true,
): number {
  if (damage <= 0) return 0;
  // "Insensible aux dégâts des sorts" (Atcham #468/#146/#171): immune to all spell damage, single
  // target and area (both go through here), friendly or enemy. Combat damage still lands (it goes
  // through applyDamageToCreature, which does not check this property).
  if (isSpell && target.properties.has("SpellDamageInsensitivity")) {
    log.push({ type: "DAMAGE_DODGED", targetInstanceId: target.instanceId });
    return 0;
  }
  // "Réduit de N les dégâts des sorts ADVERSES" (#110): an enemy spell (casterSide ≠ the target's
  // owner) hitting a creature whose owner controls a living aura source is lowered by N first
  // (before Résistance/Armure). Several sources stack.
  if (isSpell && casterSide != null && casterSide !== target.owner) {
    const reduction = sumSpellDamageReduction(creatures, target.owner);
    if (reduction > 0) {
      damage = Math.max(0, damage - reduction);
      if (damage <= 0) return 0;
    }
  }
  // "Tant qu'une lune est en jeu, les dégâts subis par vos Mulous sont réduits de 1" (Pleine Lune
  // #746): MoonGuard is granted by withAuras to a side's Mulous while it owns a FullMoon creature.
  if (target.properties.has("MoonGuard")) { damage = Math.max(0, damage - 1); if (damage <= 0) return 0; }
  // "Ne subit jamais plus de 1 dégât à la fois" (Rupuce #242): cap each hit at 1.
  if (target.properties.has("DamageCap1")) damage = Math.min(damage, 1);
  if (target.properties.has("Shield")) {
    target.properties = new Set(target.properties); // clone before mutating the shared Set (aliasing)
    target.properties.delete("Shield");
    log.push({ type: "PROPERTY_UNAPPLIED", instanceId: target.instanceId, property: "Shield" });
    log.push({ type: "DAMAGE_DODGED", targetInstanceId: target.instanceId });
    return 0;
  }
  if (target.properties.has("CantDie") || target.properties.has("Invulnerable")) {
    log.push({ type: "DAMAGE_DODGED", targetInstanceId: target.instanceId });
    return 0;
  }
  // "Subir des dégâts annule l'état assommé", the hit landed, so wake it.
  if (target.properties.has("Stunned")) {
    target.properties = new Set(target.properties); // clone before mutating the shared Set (aliasing)
    target.properties.delete("Stunned");
    target.stunTurns = undefined; // "annule tout le compteur", as on the combat path
    log.push({ type: "PROPERTY_UNAPPLIED", instanceId: target.instanceId, property: "Stunned" });
  }
  // Vulnérabilité raises the hit, Résistance lowers it, both flat.
  let remaining = Math.max(0, damage + target.vulnerability - target.resistance);
  // Armure: absorbing pool, consumed, unless the spell pierces armour (PERCE
  // ARMURE, Flèche Perçante #294), which ignores Armure (Résistance above still
  // applies, PierceArmor bypasses Armure only).
  if (remaining > 0 && !pierceArmor && target.armor > 0) {
    const absorbed = Math.min(target.armor, remaining);
    const before = target.armor;
    target.armor -= absorbed;
    remaining -= absorbed;
    log.push({
      type: "ARMOR_GAINED",
      instanceId: target.instanceId,
      armorMod: { valueBefore: before, modification: -absorbed, valueAfter: target.armor },
    });
  }
  target.currentLife -= remaining;
  // Mark a DAMAGE death so resolveDeathsAndWin can fire the victim's posthumous CONTRE COUP
  // ("qu'elle survive ou non"), a spell that one-shots it must still bank its effect.
  if (remaining > 0 && target.currentLife <= 0) target.diedFromDamage = true;
  return remaining;
}

// --------------- generic targeted stat mutation ---------------
//
// Most single-target buffs/debuffs are the same shape: find the creature on
// the target cell, change one numeric stat (add a delta or set an exact
// value), clamp it, and log the matching event. Rather than a near-identical
// handler per stat we describe each stat once in STAT_FIELDS and route every
// such effect through applyStatMod. Adding a new buff/debuff is then a single
// dispatch line (+ a field entry if it is a new stat).
//
// `write` applies the new value and any companion field (e.g. attack also
// raises baseAttack so the buff survives the start-of-turn reset). `cap`
// bounds the result (heal cannot exceed baseLife). `event` is the protocol
// event the UI plays.
interface StatField {
  read: (c: CreatureInstance) => number;
  write: (c: CreatureInstance, before: number, after: number) => void;
  cap: (c: CreatureInstance) => number;
  event: (c: CreatureInstance, before: number, after: number) => GameEvent;
}

const mod = (valueBefore: number, valueAfter: number) => ({
  valueBefore,
  modification: valueAfter - valueBefore,
  valueAfter,
});

const STAT_FIELDS: Record<"life" | "attack" | "armor" | "movement" | "range" | "resistance", StatField> = {
  // Heal: raises currentLife only (baseLife = the cap), never overheals.
  life: {
    read: (c) => c.currentLife,
    write: (c, _b, after) => { c.currentLife = after; },
    cap: (c) => c.baseLife,
    event: (c, b, a) => ({ type: "LIFE_HEALED", instanceId: c.instanceId, heal: a - b, lifeMod: mod(b, a) }),
  },
  // Resistance: a flat reduction taken off each instance of damage (separate from
  // AR, which is a pool that gets used up). It persists as it is: withAuras only
  // resets `auraResistance`, never the base resistance (Lien Spiritueux).
  resistance: {
    read: (c) => c.resistance,
    write: (c, _b, after) => { c.resistance = Math.max(0, after); },
    cap: () => Number.MAX_SAFE_INTEGER,   // no cap on resistance
    event: (c, b, a) => ({ type: "PROPERTY_APPLIED", instanceId: c.instanceId, property: `Resistance${a - b >= 0 ? "+" : ""}${a - b}` }),
  },
  // Attack: persistent, currentAttack and baseAttack move by the same delta.
  attack: {
    read: (c) => c.currentAttack,
    write: (c, b, after) => { const d = after - b; c.currentAttack = after; c.baseAttack += d; },
    cap: () => Number.POSITIVE_INFINITY,
    event: (c, b, a) => ({ type: "ATTACK_GAINED", instanceId: c.instanceId, attackMod: mod(b, a) }),
  },
  // Armure: a fresh absorbing pool; no companion field.
  armor: {
    read: (c) => c.armor,
    write: (c, _b, after) => { c.armor = after; },
    cap: () => Number.POSITIVE_INFINITY,
    event: (c, b, a) => ({ type: "ARMOR_GAINED", instanceId: c.instanceId, armorMod: mod(b, a) }),
  },
  // Movement: the PM stat lives in baseMovement; `movementLeft` is the current
  // turn's remaining budget. Creatures advance once, at end of turn, spending
  // movementLeft, so a mid-turn change to the stat must also update the live
  // budget to take effect this turn:
  //   • a buff (+PM, e.g. Glaie) grants the extra cell(s) this turn: bump
  //     movementLeft by the same delta. But only for a creature already free to
  //     move (movementLeft > 0), a summoning-sick creature keeps
  //     movementLeft = 0, so its bonus correctly waits for next turn.
  //   • a debuff / set-lower (e.g. Pesanteur "passe à 1 les PM") bites now:
  //     cap the remaining budget to the new PM so the creature is slowed this
  //     very turn.
  movement: {
    read: (c) => c.baseMovement,
    write: (c, before, after) => {
      c.baseMovement = after;
      const delta = after - before;
      if (delta < 0) c.movementLeft = Math.min(c.movementLeft, after);
      else if (delta > 0 && c.movementLeft > 0) c.movementLeft += delta;
    },
    cap: () => Number.POSITIVE_INFINITY,
    event: (c, b, a) => ({ type: "MOVEMENT_POINT_BOOST", instanceId: c.instanceId, movementMod: mod(b, a) }),
  },
  // Portée (shooter attack distance). RangeMin stays 1; we surface the new max.
  range: {
    read: (c) => c.range,
    write: (c, _b, after) => { c.range = after; },
    cap: () => Number.POSITIVE_INFINITY,
    event: (c, _b, a) => ({ type: "SHOOTER_RANGE", instanceId: c.instanceId, rangeMin: 1, rangeMax: a }),
  },
};

// Apply a stat delta to one creature with the proper field semantics (used by
// the temporary-modifier reversal in rules.ts). Discards the log events.
export function bumpStat(
  c: CreatureInstance,
  field: "attack" | "armor" | "movement" | "range" | "life",
  delta: number,
): void {
  mutateStat(c, [], field, "add", delta);
}

// Read a stat by its field name. Exported so that the temporary reversion in rules.ts can
// measure the delta that was really taken, instead of deriving it again from the effect:
// mutateStat clamps at 0, so a creature with 1 AT only loses 1 and one with 0 AT loses nothing (Sénilité #1241).
export function readStat(
  c: CreatureInstance,
  field: "attack" | "armor" | "movement" | "range" | "life",
): number {
  return STAT_FIELDS[field].read(c);
}

// Apply a stat change to one creature (the per-creature core, shared by the
// single-target and AoE paths).
function mutateStat(
  c: CreatureInstance,
  log: GameEvent[],
  field: keyof typeof STAT_FIELDS,
  mode: "add" | "set",
  amount: number,
): void {
  const f = STAT_FIELDS[field];
  const before = f.read(c);
  // A boost cannot create range: an additive +portée only lands on a creature that already has
  // non-zero range, so a melee unit (range 0) stays melee (e.g. Héroïne Stridulante #887 cannot
  // give range to a Wabbit). A "set" (SetRange = remove portée) is not affected.
  if (field === "range" && mode === "add" && before === 0) return;
  let after = mode === "set" ? amount : before + amount;
  // A "passe l'AT à N" sets the base without auras: continuous CHEF / conditional ATK auras (folded
  // into auraAttack) stack on top, they are not absorbed. So Foul Moon #929 / Moon #1747 setting
  // an ally's ATK to its own n leaves that ally at n + its own chief +1 (= n+1), and a plain "AT à
  // 3" on a chief-buffed creature lands at 3 + chief. withAuras then strips and folds auraAttack
  // again, keeping the aura on top. Attack only, since auraAttack is its aura pool.
  if (field === "attack" && mode === "set") after = amount + c.auraAttack;
  after = Math.max(0, Math.min(after, f.cap(c)));
  if (after === before) return; // no-op (e.g. overheal, +0)
  f.write(c, before, after);
  log.push(f.event(c, before, after));
}

// Sangsuce Tsu Tsu #24 (HealingsDoDamageInstead): "Tous les soins deviennent des dégâts." While any
// carrier is alive (either camp), a heal of N on a creature deals N spell damage to it instead of
// restoring life (applies to the Heal/HealSelf path and HealFull). Dofus heals are not affected here.
function healsAreReversed(creatures: CreatureInstance[]): boolean {
  return creatures.some((c) => c.currentLife > 0 && c.properties.has("HealingsDoDamageInstead"));
}

// A "scope" turns a single-target stat effect into an AoE one: instead of the
// clicked cell, it hits a whole side of the board. "allies" = the caster's
// creatures, "enemies" = the foe's, "all" = both. Stamped onto the effect by
// the merge from phrasing like "vos invocations" / "invocations adverses".
type Scope = "allies" | "allies_camp" | "enemies" | "all" | "own_camp" | "enemy_camp";
function scopeMatches(c: CreatureInstance, scope: Scope, casterSide: "ally" | "enemy"): boolean {
  switch (scope) {
    case "all": return true;
    case "enemies": return c.owner !== casterSide;
    case "allies": return c.owner === casterSide;
    case "allies_camp": return c.owner === casterSide && isAlliedTerritory(c.position.x, casterSide);
    // Positional camps, any creature (either owner) standing in a territory.
    case "own_camp": return isAlliedTerritory(c.position.x, casterSide);
    case "enemy_camp": return isAlliedTerritory(c.position.x, casterSide === "ally" ? "enemy" : "ally");
  }
}

// A `shape` restricts an AoE to a geometric zone around the clicked cell.
// Krosmaga vocabulary (5 rows × 10 columns, creatures advance along their row):
//   row, "ligne": every cell of the targeted horizontal lane (same y).
//   column, "rangée": every cell of the targeted vertical column (same x).
//   cross, the targeted row and column ("la ligne et la rangée").
//   around, the targeted cell and its 8 neighbours ("autour").
// In line with `AoeShape` in data/types.ts: "beside" = the 2 side cells of the
// target, same row (Flasque Explosive).
type AoeShape = "row" | "column" | "cross" | "around" | "beside";
function inShape(c: CreatureInstance, t: Coords, shape: AoeShape): boolean {
  switch (shape) {
    case "row": return c.position.y === t.y;       // ligne (horizontal)
    case "column": return c.position.x === t.x;    // rangée (vertical)
    case "cross": return c.position.x === t.x || c.position.y === t.y;
    case "around": return Math.abs(c.position.x - t.x) <= 1 && Math.abs(c.position.y - t.y) <= 1;
    // "celles à côté" = the 2 side cells of the targeted cell: same row (same x),
    // one line above and one below. The reading used for Flasque Explosive ("like
    // Boo"), and the one the engine already carries under the property
    // DamagesOn3CellsSameColumn of Marteleur Nimbos #972.
    case "beside": return c.position.x === t.x && Math.abs(c.position.y - t.y) === 1;
  }
}
function shapeOf(effect: Effect): AoeShape | undefined {
  const s = (effect as { shape?: string }).shape;
  return s === "row" || s === "column" || s === "cross" || s === "around" || s === "beside" ? s : undefined;
}

// Dispatch a stat effect: AoE when the effect has a `scope`, otherwise the single
// clicked creature.
// An AoE effect that is not damage applies as a sweep: the priority cell (the front, from the
// caster's point of view) first, then row by row, L1→L5. So the targets are iterated in that
// order (AoE damage stays simultaneous and is never sorted). Same comparator as the advance
// (moveOrderIds) and as sweepPrecedes in rules.ts. `side` = ctx.casterSide (caster's view).
function sweepOrder(creatures: CreatureInstance[], side: Side): CreatureInstance[] {
  return [...creatures].sort((a, b) =>
    side === "ally"
      ? (a.position.x - b.position.x) || (a.position.y - b.position.y)
      : (b.position.x - a.position.x) || (b.position.y - a.position.y),
  );
}

function applyStatMod(
  creatures: CreatureInstance[],
  log: GameEvent[],
  ctx: EffectContext,
  opts: { field: keyof typeof STAT_FIELDS; mode: "add" | "set"; amount: number; scope?: Scope; shape?: AoeShape; family?: string; god?: string; excludeSelf?: boolean; wounded?: boolean; minAttack?: number;
         // Pandawa god: "ayant au moins N PM" (Engourdissement) and the
         // drunkenness sub-filters (Tournée Générale, Ivresse de la Bataille).
         minMovement?: number; drunk?: boolean; sober?: boolean },
): void {
  // Sangsuce Tsu Tsu #24: a positive life-add (a heal) becomes spell damage of the same amount while a
  // HealingsDoDamageInstead carrier is alive (both camps). Other stat mods are untouched.
  const reverseHeal = opts.field === "life" && opts.mode === "add" && opts.amount > 0 && healsAreReversed(creatures);
  const apply = (c: CreatureInstance) => {
    if (reverseHeal) {
      const armorBefore = c.armor;
      const dealt = applyDamageToCreatureFromSpell(c, opts.amount, log, creatures, ctx.casterSide);
      if (dealt > 0 || armorBefore > c.armor) log.push({ type: "DAMAGE", sourceInstanceId: ctx.selfInstanceId ?? -1, targetInstanceId: c.instanceId, damage: dealt, armorHit: armorBefore > c.armor });
    } else {
      mutateStat(c, log, opts.field, opts.mode, opts.amount);
    }
  };
  if (opts.scope) {
    // Scoped AoE, optionally narrowed to a geometric shape around targetCell,
    // a creature family ("vos autres Gelées"), a WOUNDED-only sub-filter
    // ("vos invocations blessées" → currentLife < baseLife), and/or excluding
    // the source ("autres"). Used by family-buff triggers as well as the AoE spells.
    const scope = opts.scope, shape = opts.shape, t = ctx.targetCell;
    for (const c of creatures) {
      if (c.currentLife <= 0) continue;
      if (opts.excludeSelf && c.instanceId === ctx.selfInstanceId) continue;
      if (!scopeMatches(c, scope, ctx.casterSide)) continue;
      if (shape && (!t || !inShape(c, t, shape))) continue;
      if (opts.family && !(famsOf(c)).includes(opts.family)) continue;
      if (opts.god && getCard(c.cardId)?.god !== opts.god) continue; // "vos autres Xélors" (Synchroniseur #714)
      if (opts.wounded && c.currentLife >= c.baseLife) continue; // "blessées" only
      if (opts.minAttack != null && c.currentAttack < opts.minAttack) continue; // "ayant au moins N AT"
      if (opts.minMovement != null && c.baseMovement < opts.minMovement) continue; // "ayant au moins N PM" (Engourdissement)
      // Pandawa god: "vos Pandawas saouls" / "vos invocations sobres"
      if (opts.drunk && !c.properties.has(SAOUL)) continue;
      if (opts.sober && c.properties.has(SAOUL)) continue;
      apply(c);
    }
    return;
  }
  if (!ctx.targetCell) return;
  const c = creatures.find((x) => sameCoords(x.position, ctx.targetCell!) && x.currentLife > 0);
  if (!c) return;
  apply(c);
}

// "Confère vulnérabilité N", add N to the vulnerability of every matching
// creature (single clicked target, or a whole scope / shape for the AoE cards
// like Talon d'Achille "à toutes les invocations"). Stacks additively. Emits a
// RESISTANCE event with a negative-equivalent so the figurine can flag it (we
// reuse that channel, there is no dedicated vulnerability event yet).
function handleVulnerability(
  creatures: CreatureInstance[],
  log: GameEvent[],
  ctx: EffectContext,
  amount: number,
  scope: Scope | undefined,
  shape: AoeShape | undefined,
): void {
  if (amount === 0) return;
  const bump = (c: CreatureInstance) => {
    c.vulnerability += amount;
    log.push({ type: "PROPERTY_APPLIED", instanceId: c.instanceId, property: "Vulnerability" });
  };
  if (scope) {
    const t = ctx.targetCell;
    for (const c of creatures) {
      if (c.currentLife <= 0) continue;
      if (!scopeMatches(c, scope, ctx.casterSide)) continue;
      if (shape && (!t || !inShape(c, t, shape))) continue;
      bump(c);
    }
    return;
  }
  if (!ctx.targetCell) return;
  const c = creatures.find((x) => sameCoords(x.position, ctx.targetCell!) && x.currentLife > 0);
  if (c) bump(c);
}

// "Inflige N dégâts aux invocations (adverses) (autour de lui / de sa ligne)": an area damage
// burst. The centre is ctx.targetCell (the clicked cell for a spell, or the source creature's
// own cell for a trigger). `scope` filters which side(s) are hit; `shape` narrows it to the 3×3
// block ("around") or the row; with no shape it is the whole scope on the board. The source
// creature never hits itself. Goes through the shared damage helper so Shield / Résistance /
// Vulnérabilité all apply to each victim.
// "Confère aux invocations autour du Glyphe autant d'AT qu'elles ont d'AR" (Glyphe Agressif):
// every creature in scope+shape gains +AT equal to its own current Armure (the AR itself is not
// used up).
// "Repousse de N cases les invocations autour" (Glyphe de Retraite): every creature in
// scope+shape slides N cells toward its own owner's wall (reuses the single-target push). The
// targets are recorded first so a push does not change who is "around".
function handleAoePush(
  creatures: CreatureInstance[],
  dofuses: DofusInstance[],
  log: GameEvent[],
  ctx: EffectContext,
  distance: number,
  scope: Scope | undefined,
  shape: AoeShape | undefined,
): void {
  if (distance <= 0) return;
  const t = ctx.targetCell;
  const sc = scope ?? "all";
  const targets = creatures.filter(
    (c) =>
      c.currentLife > 0 &&
      scopeMatches(c, sc, ctx.casterSide) &&
      (!shape || (!!t && inShape(c, t, shape))),
  );
  // Each creature is pushed toward its own wall; those closest to their wall go first, so a stacked
  // column clears from the back and never blocks itself (creatures move one at a time). Progress
  // toward the wall: ally → x, enemy → (cols-1 − x); higher = nearer its wall.
  const progress = (c: CreatureInstance) => (c.owner === "ally" ? c.position.x : BOARD_COLS - 1 - c.position.x);
  targets.sort((a, b) => progress(b) - progress(a));
  for (const c of targets) slideCreatureBack(c, creatures, dofuses, distance, log, undefined, ctx.onSlideStep);
}

// Katar #458/#265/#324 "Attire la première invocation adverse devant lui", auto (no pick):
// find the nearest enemy ahead of the source on its own row, then pull it toward the source until
// it is adjacent in front (slideCreatureBack towardSide = source's side → it slides into the source's
// wall direction and stops one cell before the source). A following ChargeSelf then charges into it.
// Champion Assoiffé #2005 "Réduit de N l'AT de la première invocation ENNEMIE devant lui
// jusqu'à votre prochain tour", automatic (no pick). Same reading of "devant" as
// handleAttractFirstAhead below: the carrier's lane (same y), towards the opponent's side,
// skipping allies and taking the first enemy.
// The reversion is measured on the stat really taken and not on -amount: mutateStat
// clamps at 0, so a creature with 1 AT only gives back 1 point, not N. Without it, a
// malus of 2 on a creature with 1 AT would give it a permanent +1.
function handleWeakenFirstEnemyAhead(
  creatures: CreatureInstance[],
  log: GameEvent[],
  ctx: EffectContext,
  amount: number,
  duration: string | undefined,
): void {
  const me = findSelf(creatures, ctx);
  if (!me || amount <= 0) return;
  const dx = me.owner === "ally" ? -1 : 1;
  let cible: CreatureInstance | undefined;
  let best = Infinity;
  for (const c of creatures) {
    if (c.currentLife <= 0 || c.owner === me.owner || c.position.y !== me.position.y) continue;
    const devant = (c.position.x - me.position.x) * dx;
    if (devant > 0 && devant < best) { best = devant; cible = c; }
  }
  if (!cible) return;
  const avant = readStat(cible, "attack");
  mutateStat(cible, log, "attack", "add", -amount);
  const encaisse = avant - readStat(cible, "attack");
  if (encaisse > 0 && duration && ctx.tempReversionSink) {
    ctx.tempReversionSink.push({
      kind: "stat",
      expireSide: duration === "opponentNextTurn" ? (me.owner === "ally" ? "enemy" : "ally") : me.owner,
      field: "attack",
      amount: encaisse,
      instanceIds: [cible.instanceId],
    });
  }
}


function handleAttractFirstAhead(
  creatures: CreatureInstance[],
  dofuses: DofusInstance[],
  log: GameEvent[],
  ctx: EffectContext,
): void {
  const me = findSelf(creatures, ctx);
  if (!me) return;
  const dx = me.owner === "ally" ? -1 : 1; // the source's forward direction
  let nearest: CreatureInstance | undefined;
  let best = Infinity;
  for (const c of creatures) {
    if (c.currentLife <= 0 || c.owner === me.owner || c.position.y !== me.position.y) continue;
    const ahead = (c.position.x - me.position.x) * dx; // > 0 = ahead of the source
    if (ahead > 0 && ahead < best) { best = ahead; nearest = c; }
  }
  if (nearest) slideCreatureBack(nearest, creatures, dofuses, BOARD_COLS, log, me.owner, ctx.onSlideStep);
}

function handleAddArmorToAttack(
  creatures: CreatureInstance[],
  log: GameEvent[],
  ctx: EffectContext,
  scope: Scope | undefined,
  shape: AoeShape | undefined,
): void {
  const t = ctx.targetCell;
  const sc = scope ?? "all";
  for (const c of creatures) {
    if (c.currentLife <= 0) continue;
    if (!scopeMatches(c, sc, ctx.casterSide)) continue;
    if (shape && (!t || !inShape(c, t, shape))) continue;
    if (c.armor <= 0) continue;
    const before = c.currentAttack;
    c.currentAttack += c.armor;
    c.baseAttack += c.armor;
    log.push({ type: "ATTACK_GAINED", instanceId: c.instanceId, attackMod: { valueBefore: before, modification: c.armor, valueAfter: c.currentAttack } });
  }
}

function handleAoeDamage(
  creatures: CreatureInstance[],
  log: GameEvent[],
  ctx: EffectContext,
  amount: number,
  scope: Scope | undefined,
  shape: AoeShape | undefined,
  zone?: "ownCamp" | "enemyCamp",
  minAttack?: number,
  excludeTargetCreature?: boolean,
): void {
  if (amount <= 0) return;
  const t = ctx.targetCell;
  const sc = scope ?? "all";
  for (const c of creatures) {
    if (c.currentLife <= 0) continue;
    if (c.instanceId === ctx.selfInstanceId) continue; // never the source itself
    // Pied du Sacrieur #271: the clicked creature already took the primary damage via a
    // separate single-target DamageData, so the "aux autres" splash must skip it.
    if (excludeTargetCreature && t && c.position.x === t.x && c.position.y === t.y) continue;
    if (!scopeMatches(c, sc, ctx.casterSide)) continue;
    if (shape && (!t || !inShape(c, t, shape))) continue;
    // Note: an "inciblable" (Untargetable) enemy is hit by area spells. The keyword only stops it from
    // being chosen as a single target (validateSpellTarget) or by a creature ability
    // (cellMatchesFilter). Zone effects (Tremblement, Flèche Tempête, Championne's push, glyphs)
    // affect it normally, so there is no Untargetable skip here.
    // zone "ownCamp" (Apôtre Nécrosé): only hits creatures standing in the caster's own territory
    // ("dans votre camp").
    if (zone === "ownCamp" && !isAlliedTerritory(c.position.x, ctx.casterSide)) continue;
    // zone "enemyCamp" (Deserboss #112): only hit creatures standing in the
    // OPPONENT's half ("situées dans le camp adverse"). A creature is never on a
    // wall column, so "not in the caster's territory" is exactly the enemy half.
    if (zone === "enemyCamp" && isAlliedTerritory(c.position.x, ctx.casterSide)) continue;
    // minAttack (Gardienne Inflexible): only hit creatures whose current attack
    // is at least N ("ayant au moins N AT").
    if (minAttack != null && c.currentAttack < minAttack) continue;
    // GARDE DU CORPS (#320/#300) also applies to zone damage: a bodyguard "reçoit les dégâts à la
    // place de celle qu'elle protège", so each victim goes through the guard. A protected creature's
    // share is redirected to its living bodyguard (what goes past the guard's HP hits the protected
    // one, as with a single target). This is what lets the L'Enklarveur↔Prespic + Kralamor/Bould combo
    // last (Kralamor stays alive behind Bould and keeps healing).
    dealSpellDamageThroughGuard(c, amount, log, creatures, ctx.selfInstanceId ?? -1, ctx.casterSide, false, ctx.isSpell ?? true);
  }
}

// "Confère <mot-clé> à une invocation" / "Gagne <mot-clé>", grant a keyword
// property (Shield / FirstStrike / Untargetable / Rooted / PierceArmor) to the
// clicked creature (targeted), the source (self), or a whole scope+family.
function handleGrantProperty(
  creatures: CreatureInstance[],
  log: GameEvent[],
  ctx: EffectContext,
  effect: { property: string; scope?: string; shape?: string; family?: string; notFamily?: string; excludeSelf?: boolean; self?: boolean },
): void {
  const prop = effect.property;
  if (!prop) return;
  const add = (c: CreatureInstance) => {
    // Drunk state (Pandawa god): only Pandawas can be drunk, every other creature is
    // always sober, so the placement is refused.
    if (prop === SAOUL && !famsOf(c).includes("Pandawa")) return;
    // Stun duration: "Assomme une invocation pour N tour(s)". Absent = 1, the old
    // behaviour. Fiole de Pandapiler puts its FERMENTATION there.
    if (prop === "Stunned") {
      const t = (effect as { turns?: number }).turns;
      if (typeof t === "number" && t > 1) c.stunTurns = t | 0;
    }
    // Making an already drunk Pandawa drunk again is a complete no-op. A Picole can be cast
    // on a drunk Pandawa, but it has no effect: the Pandawa stays drunk and, above all, the
    // triggers of Pandawas that become drunk do not fire. So the target stays legal (no
    // sobriety filter on the caster), it just has no effect. Without the PROPERTY_APPLIED
    // emitted again here, the reading of the log that arms the "SAOUL : …" sees nothing,
    // which is the point.
    if (c.properties.has(prop)) return;
    c.properties = new Set(c.properties); // clone before mutating the shared Set (aliasing)
    c.properties.add(prop);
    log.push({ type: "PROPERTY_APPLIED", instanceId: c.instanceId, property: prop });
  };
  if (effect.self) {
    const me = findSelf(creatures, ctx);
    if (me && me.currentLife > 0) add(me);
    return;
  }
  const scope = scopeOf(effect as Effect);
  if (scope) {
    // shape "around" (Glyphe de Léthargie) narrows to the 3×3 block centred on
    // the clicked cell (the glyph cell), on top of the camp scope.
    const shape = shapeOf(effect as Effect);
    for (const c of creatures) {
      if (c.currentLife <= 0) continue;
      if (effect.excludeSelf && c.instanceId === ctx.selfInstanceId) continue;
      if (!scopeMatches(c, scope, ctx.casterSide)) continue;
      if (shape && (!ctx.targetCell || !inShape(c, ctx.targetCell, shape))) continue;
      if (effect.family && !(famsOf(c)).includes(effect.family)) continue;
      if (effect.notFamily && (famsOf(c)).includes(effect.notFamily)) continue; // skip this family (Bébé Percedal #901: spare the Brotherhood)
      add(c);
    }
    return;
  }
  if (!ctx.targetCell) return;
  const c = creatures.find((x) => sameCoords(x.position, ctx.targetCell!) && x.currentLife > 0);
  if (c) add(c);
}

// --------------- individual handlers ---------------

// "Soigne les PV manquants", restore a creature to full life. Single-target
// (clicked cell) or AoE by scope. Logs LIFE_HEALED for the gain.
function handleHealFull(
  creatures: CreatureInstance[],
  log: GameEvent[],
  ctx: EffectContext,
  scope: Scope | undefined,
): void {
  const reverse = healsAreReversed(creatures); // Sangsuce Tsu Tsu #24: heal-to-full → damage of the deficit
  const heal = (c: CreatureInstance) => {
    if (c.currentLife <= 0 || c.currentLife >= c.baseLife) return;
    if (reverse) {
      const armorBefore = c.armor;
      const dealt = applyDamageToCreatureFromSpell(c, c.baseLife - c.currentLife, log, creatures, ctx.casterSide);
      if (dealt > 0 || armorBefore > c.armor) log.push({ type: "DAMAGE", sourceInstanceId: ctx.selfInstanceId ?? -1, targetInstanceId: c.instanceId, damage: dealt, armorHit: armorBefore > c.armor });
      return;
    }
    const before = c.currentLife;
    c.currentLife = c.baseLife;
    log.push({ type: "LIFE_HEALED", instanceId: c.instanceId, heal: c.baseLife - before, lifeMod: mod(before, c.baseLife) });
  };
  if (scope) {
    for (const c of creatures) if (scopeMatches(c, scope, ctx.casterSide)) heal(c);
    return;
  }
  if (!ctx.targetCell) return;
  const c = creatures.find((x) => sameCoords(x.position, ctx.targetCell!) && x.currentLife > 0);
  if (c) heal(c);
}

// "Double son AT", multiply the targeted creature's attack (current and base,
// so it persists) by `factor`. Logs ATTACK_GAINED.
function handleMultiplyAttack(
  creatures: CreatureInstance[],
  log: GameEvent[],
  effect: { factor: number },
  ctx: EffectContext,
): void {
  if (!ctx.targetCell) return;
  const c = creatures.find((x) => sameCoords(x.position, ctx.targetCell!) && x.currentLife > 0);
  if (!c) return;
  const f = Math.max(0, effect.factor | 0);
  const before = c.currentAttack;
  const after = before * f;
  if (after === before) return;
  c.currentAttack = after;
  c.baseAttack = c.baseAttack * f;
  log.push({ type: "ATTACK_GAINED", instanceId: c.instanceId, attackMod: mod(before, after) });
}

// "Transforme une invocation en X", replace the targeted creature's identity
// with the token card's: stats, keywords, triggers, range and Résistance are
// all swapped to the token's. `asOwner:"caster"` flips it to your side ("en X
// allié"); "keep" leaves the owner. The transformed unit is summoning-sick
// (cannot act this turn). Same instanceId & cell. No-op if the token is not in
// the registry (UI/tests must register the pool).
// Rewrite one creature's identity to a token card's (stats / keywords / range /
// Résistance / triggers), set its owner, and re-announce it. Shared by the
// single-target Transform and the mass TransformAll.
export function transformCreature(c: CreatureInstance, tokenId: number, owner: Side, log: GameEvent[]): void {
  const token = getCard(tokenId);
  if (!token) return;
  const props = new Set<string>(token.properties ?? []);
  let range = 0;
  let resistance = 0;
  for (const e of token.effects ?? []) {
    if (e.type === "SetPropertyData") {
      const p = (e as { PropertyType?: string }).PropertyType;
      if (p) props.add(p);
    } else if (e.type === "ShooterRangeData") {
      const rm = (e as { RangeMax?: number | { const?: number } }).RangeMax;
      range = Math.max(range, typeof rm === "number" ? rm : (rm?.const ?? 0));
    } else if (e.type === "BoostResistanceData") {
      const b = (e as { Boost?: number | { const?: number } }).Boost;
      resistance += typeof b === "number" ? b : (b?.const ?? 0);
    }
  }
  c.cardId = token.id;
  c.owner = owner;
  // Drunkenness does not survive a transform; the properties are replaced anyway by
  // those of the new form below. But the FERMENTATION set on the creature and the
  // stun duration must be cleared explicitly: a stale `stunTurns` would make a later
  // stun last longer.
  c.ferment = undefined;
  c.stunTurns = undefined;
  c.currentLife = token.life ?? 1;
  c.baseLife = token.life ?? 1;
  c.printedLife = token.life ?? 1;
  c.currentAttack = token.attack ?? 0;
  c.baseAttack = token.attack ?? 0;
  c.printedAttack = token.attack ?? 0;
  c.baseMovement = token.movement ?? 0;
  c.printedMovement = token.movement ?? 0;
  // A transformation sets PM to match the new creature: a creature that can still act this turn (no
  // summoning sickness, has not acted, so hasAttacked === false) gets the new token's full movement,
  // so a slow creature turned into a fast one advances the faster amount, and the other way round
  // (e.g. Jeanne Houillère / Crail, PM 2, turned into a Marcassinet #263 used to advance 2 instead of
  // 3). This also covers the earlier cases that only needed a refresh from 0: an enemy taken with
  // asOwner:"caster" (its PM was never reset on the caster's turn) and a 0-PM Mur. A creature with
  // summoning sickness or that already acted (hasAttacked === true) keeps its state, only capped to
  // the new maximum: it gets no free advance, and the sickness carries over (movementLeft stays 0).
  c.movementLeft = !c.hasAttacked
    ? c.baseMovement
    : Math.min(c.movementLeft, c.baseMovement);
  c.properties = props;
  c.triggers = token.triggers ?? [];
  c.range = range;
  c.resistance = resistance;
  c.vulnerability = 0;
  c.armor = 0;
  // Transform is a full rebuild into a fresh token, clear the runtime debuffs
  // that are not carried by the new card's data (Gangraîne poison, silence) and any
  // prior per-instance cost override (the new token's printed cost applies unless the
  // caller re-sets costOverride, e.g. a Phorzerker fusion / Moumoune #989).
  c.movementPoison = 0;
  c.silenced = false;
  c.costOverride = undefined;
  c.textCardId = undefined; // Anathar #316: the new form takes its own text (c.triggers was just replaced by the token's)
  // Clear the old aura accumulators inherited from the previous card. withAuras step 1 strips
  // these back out of base/range on every recompute; if they survived the rebuild they would be
  // subtracted again from the new token's printed stats, dropping it below them once the old buff
  // source is gone (e.g. a Marcassin Or #407 transforming a chief-buffed shooter into a Marcassinet
  // #263 left it at 0 AT / −1 range instead of 1 AT / range 0). The next recomputeAuras adds back
  // whatever the new form really receives, same reasoning as the silence reset just above.
  c.auraAttack = 0;
  c.auraRange = 0;
  c.auraMovement = 0;
  c.auraResistance = 0;
  c.auraVulnerability = 0; // `vulnerability` was just reset to 0 above, the accumulator follows
  // Transformation beat: a transformation is neither a death nor a summon. The replay swaps the
  // figurine in place with the gen_transformation effect (and its sound) at this beat, then skips
  // the spawn animation of the NEW_SUMMON that follows (kept, since it carries the final state for
  // anything that reads the log: recordings, AI).
  log.push({ type: "FIGHT_OBJECT_TRANSFORMED", instanceId: c.instanceId, intoCardId: token.id });
  log.push({ type: "NEW_SUMMON", instanceId: c.instanceId, cardId: token.id, owner, at: { ...c.position } });
}

function handleTransform(
  creatures: CreatureInstance[],
  log: GameEvent[],
  effect: { tokenId?: number; randomCost?: number | "target"; asOwner: "caster" | "keep"; attack?: number; life?: number; cost?: number },
  ctx: EffectContext,
): void {
  if (!ctx.targetCell) return;
  const c = creatures.find((x) => sameCoords(x.position, ctx.targetCell!) && x.currentLife > 0);
  if (!c) return;
  // Random-cost transform (Otomaï #102 CONTRE COUP « invocation aléatoire coûtant 6 PA ») : pick a
  // random Summon of that exact cost from the seeded rng, mandatory (requireRng), else use the
  // fixed tokenId.
  let tokenId = effect.tokenId;
  if (effect.randomCost != null) {
    // randomCost "target" (V2 Otomaï #102 "en une autre invocation aléatoire au MÊME
    // COÛT en PA"): the cost read is the one printed on the target's card, never its
    // current cost. A reduction already applied (Vampyro, Nox…) does not move the pool,
    // the same rule as Coqueline, which always fetches a 2 AP creature.
    const wantCost = effect.randomCost === "target" ? getCard(c.cardId)?.cost : effect.randomCost;
    if (wantCost == null) return;
    const pool = summonsOfCost(wantCost);
    if (pool.length === 0) return;
    tokenId = pool[requireRng(ctx.rng, "un Transform aléatoire").int(pool.length)];
  }
  if (tokenId == null || !getCard(tokenId)) return;
  const owner = effect.asOwner === "caster" ? ctx.casterSide : c.owner;
  transformCreature(c, tokenId, owner, log);
  // Optional stat/cost overrides (Moumoune #989 "Se transforme en Phorzerker 6/6" → 6/6,
  // cost 6): applied after the token rebuild so they win over the token's printed values.
  if (effect.attack != null) c.currentAttack = c.baseAttack = c.printedAttack = effect.attack;
  if (effect.life != null) c.currentLife = c.baseLife = c.printedLife = effect.life;
  if (effect.cost != null) c.costOverride = effect.cost;
}

// "Transforme les autres invocations en X" (Marcassin Or), turn every matching
// creature into the token, each keeping its own owner. scope filters the side
// (default all); excludeSelf skips the source.
function handleTransformAll(
  creatures: CreatureInstance[],
  log: GameEvent[],
  ctx: EffectContext,
  effect: { tokenId?: number; randomCost?: number; scope?: string; family?: string; excludeSelf?: boolean; fromCardId?: number },
): void {
  // Two modes: a fixed token (Transchamation → Chacha Noir) or a random creature
  // of an exact cost rolled per target (Otomaï → "invocations aléatoires coûtant
  // 5 PA"). For the random mode each target rolls independently and uniformly
  // from the cost pool, using the game RNG so it stays reproducible.
  const pool = effect.randomCost != null ? summonsOfCost(effect.randomCost) : null;
  if (pool != null) {
    if (pool.length === 0) return;
  } else if (!getCard(effect.tokenId!)) {
    return;
  }
  const pickToken = (): number =>
    pool != null
      ? pool[requireRng(ctx.rng, "un TransformAll aléatoire").int(pool.length)]
      : effect.tokenId!;
  const scope = scopeOf(effect as Effect) ?? "all";
  for (const c of [...creatures]) {
    if (c.currentLife <= 0) continue;
    if (effect.excludeSelf && c.instanceId === ctx.selfInstanceId) continue;
    if (!scopeMatches(c, scope, ctx.casterSide)) continue;
    if (effect.family && !(famsOf(c)).includes(effect.family)) continue;
    // "Remplace vos <X> par des <Y>" (Chacha Or #224): restrict to creatures of a
    // specific source card (Chacha Noir → Chacha Or).
    if (effect.fromCardId != null && c.cardId !== effect.fromCardId) continue;
    transformCreature(c, pickToken(), c.owner, log); // each keeps its owner
  }
}

// "Détruit les invocations ayant N AT/PV ou moins", a mass destroy over a
// scope (all / allies / enemies), filtered by an attack and/or life ceiling
// (currentAttack/currentLife ≤ cap, live stats). CantDie / Invulnerable protect,
// exactly like the single-target Destroy. An optional `condition` (e.g.
// "outnumbered", Duelliste Spectral) gates the whole effect; it is evaluated
// from the creature list so no GameState is needed here.
function handleAoeDestroy(
  creatures: CreatureInstance[],
  log: GameEvent[],
  ctx: EffectContext,
  effect: { scope: Scope; maxAttack?: number; maxLife?: number; condition?: { kind: string; value?: number }; shape?: AoeShape; rarity?: string; property?: string },
): void {
  if (effect.condition) {
    if (!conditionHolds(creatures, ctx, effect.condition)) return;
  }
  for (const c of creatures) {
    if (c.currentLife <= 0) continue;
    if (!scopeMatches(c, effect.scope, ctx.casterSide)) continue;
    // Toxine: only invocations of a given rarity (Common / Silver / Gold …).
    if (effect.rarity && (getCard(c.cardId) as { rarity?: string } | undefined)?.rarity !== effect.rarity) continue;
    // Razortemps: only invocations carrying a property (Untargetable …).
    if (effect.property && !c.properties.has(effect.property)) continue;
    // shape "around" (Glyphe de Mort) narrows the mass-destroy to the 3×3 block
    // centred on the clicked cell (the glyph cell), regardless of camp scope.
    if (effect.shape && (!ctx.targetCell || !inShape(c, ctx.targetCell, effect.shape))) continue;
    if (effect.maxAttack != null && c.currentAttack > effect.maxAttack) continue;
    if (effect.maxLife != null && c.currentLife > effect.maxLife) continue;
    if (c.properties.has("CantDie") || c.properties.has("Invulnerable")) {
      log.push({ type: "DAMAGE_DODGED", targetInstanceId: c.instanceId });
      continue;
    }
    c.currentLife = 0;
    log.push({ type: "FIGHT_OBJECT_REMOVED", instanceId: c.instanceId });
  }
}

// Evaluate a player-state condition from the live creature list (the engine's
// effect layer has no GameState). Only the board-derivable conditions are
// supported here ("outnumbered"); reserve-based ones never reach this path.
function conditionHolds(
  creatures: CreatureInstance[],
  ctx: EffectContext,
  cond: { kind: string; value?: number },
): boolean {
  if (cond.kind === "outnumbered") {
    const mine = creatures.filter((c) => c.currentLife > 0 && c.owner === ctx.casterSide).length;
    const foe = creatures.filter((c) => c.currentLife > 0 && c.owner !== ctx.casterSide).length;
    return mine < foe;
  }
  return true;
}

// "Détruit la première créature DEVANT lui si elle possède N AT ou moins"
// (Gloutoblop). Scans forward in the source's row (allies face x=0, enemies
// x=BOARD_COLS-1) for the nearest creature of either side; destroys it only if
// its attack is within the cap (otherwise nothing, the clause checks that
// first creature, it does not look past it). CantDie / Invulnerable protect.
function handleDestroyInFront(
  creatures: CreatureInstance[],
  log: GameEvent[],
  ctx: EffectContext,
  effect: { maxAttack?: number; enemyOnly?: boolean },
): void {
  const me = findSelf(creatures, ctx);
  if (!me) return;
  const dx = me.owner === "ally" ? -1 : 1;
  const y = me.position.y;
  let target: CreatureInstance | undefined;
  for (let x = me.position.x + dx; x >= 0 && x < BOARD_COLS; x += dx) {
    const c = creatures.find((o) => o.currentLife > 0 && o.position.x === x && o.position.y === y);
    if (!c) continue;
    // enemyOnly (V2 Gloutoblop #314): an allied creature does not block the lane, it
    // is crossed and the search goes on. Without the flag, the first creature met
    // stays the target, ally included: the V1 behaviour, unchanged.
    if (effect.enemyOnly && c.owner === me.owner) continue;
    target = c;
    break;
  }
  if (!target) return;
  if (effect.maxAttack != null && target.currentAttack > effect.maxAttack) return;
  if (target.properties.has("CantDie") || target.properties.has("Invulnerable")) {
    log.push({ type: "DAMAGE_DODGED", targetInstanceId: target.instanceId });
    return;
  }
  target.currentLife = 0;
  log.push({ type: "FIGHT_OBJECT_REMOVED", instanceId: target.instanceId });
}

// "Inflige à la première invocation ADVERSE devant lui N dégâts" (Héros Chataîgneur, N = your
// seeds in play). Scans the source's row toward the enemy side, skipping allied creatures and
// empty cells, and hits the first enemy at any distance (allies do not block; whole row). Does
// nothing if there is no enemy ahead on the row, or if the resolved amount is 0.
function handleDamageInFront(
  creatures: CreatureInstance[],
  dofuses: DofusInstance[],
  log: GameEvent[],
  ctx: EffectContext,
  effect: { amount: DynamicValue; hitDofus?: boolean; anyCamp?: boolean; bounceKilledToHand?: boolean },
): void {
  const me = findSelf(creatures, ctx);
  if (!me) return;
  const dmg = resolveDynamicValue(effect.amount, ctx.rng, ctx.diceFloor, diceSink(log, ctx));
  if (dmg <= 0) return;
  const dx = me.owner === "ally" ? -1 : 1;
  const y = me.position.y;
  let target: CreatureInstance | undefined;
  for (let x = me.position.x + dx; x >= 0 && x < BOARD_COLS; x += dx) {
    const c = creatures.find((o) => o.currentLife > 0 && o.position.x === x && o.position.y === y);
    if (!c) continue;              // empty cell → keep scanning
    if (c.owner === me.owner && !effect.anyCamp) continue; // skip allies, unless anyCamp (Zespadon #564: "la première invocation devant lui", ally or enemy)
    target = c;                    // first creature ahead (first enemy, or first of any camp when anyCamp)
    break;
  }
  if (!target) {
    // Emma Zone #1866 ("première invocation OU dofus adverse de sa ligne"): no enemy creature
    // ahead → hit the enemy Dofus on this row instead, if there is one (resolveDeathsAndWin
    // settles the capture/win afterwards, like AoeDamageDofus).
    if (effect.hitDofus) {
      const d = dofuses.find((o) => o.currentLife > 0 && o.owner !== me.owner && o.position.y === y);
      if (d) {
        woundDofus(d, dmg, log, creatures, dofuses); // canonical Dofus damage (breaks any Sinistro)
        if (d.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", dofusAt: { ...d.position } });
        else log.push({ type: "DAMAGE", targetCell: { ...d.position }, damage: dmg });
      }
    }
    return;
  }
  // isSpell = false: DamageInFront is always a creature ability. The six carriers of the
  // catalogue (#564 Zespadon, #775 Cancane, #920 Héros Chataîgneur, #1108 Guerrier Boudeur,
  // #1866 Emma Zone, #2013 Ivrogne Brutale) are creatures, never a spell. The call with 6
  // arguments fell back on the `isSpell = true` default of the signature, so this damage
  // was cut by "réduit de N les dégâts des sorts adverses" (Joris #110) and dodged by
  // "insensible aux dégâts des sorts" (Atcham #468/#146/#171). The damage of the Héros
  // Chataîgneur is ability damage, not spell damage, like Black Wabbit.
  dealSpellDamageThroughGuard(target, dmg, log, creatures, me.instanceId, ctx.casterSide, false, false); // Garde du corps #320/#300 (overflow past the bodyguard)
  // Cancane #775: "Si elle va dans la défausse, elle remonte dans votre main." If the front
  // creature died from this hit, the caster steals/recovers its card to hand, recorded here,
  // executed by runTrigger after death resolution (the card is in its owner's discard by then).
  if (effect.bounceKilledToHand && target.currentLife <= 0) {
    ctx.bounceKilledSink?.push({ cardId: target.cardId, owner: target.owner });
  }
}

// Sinistro #215: mark the targeted allied Dofus as carrying a Sinistro equipment. The click cell
// (castTarget AlliedDofusWithoutEquipement) is the host Dofus. No damage on placement, the bindata
// DamageData{1} was dropped by the authored AttachSinistro effect (one per Dofus; validateSpellTarget
// already rejects an already-equipped one).
function handleAttachSinistro(dofuses: DofusInstance[], log: GameEvent[], ctx: EffectContext): void {
  if (!ctx.targetCell) return;
  const d = dofuses.find(
    (o) => o.owner === ctx.casterSide && o.currentLife > 0 && sameCoords(o.position, ctx.targetCell!),
  );
  if (!d) return;
  d.sinistroAttached = true;
  // Placement beat, the counterpart of SINISTRO_DESTROYED: the original prefab
  // (FX_Xel_Sinistro_Persistent) has three branches (Spawn, Idle, Destroy), and the spawn is a
  // one-shot that has to happen at this exact moment.
  log.push({ type: "SINISTRO_ATTACHED", dofusAt: { ...d.position } });
}

// Nécronomigore #700 tuning (from its bindata CreateCardCounterData{6} + DamageData{5}).
export const NECRONOMIGORE_COUNTER = 6; // ticks down at each owner FIN_DE_TOUR
export const NECRONOMIGORE_DAMAGE = 5;  // dealt to all enemy Dofus once the counter reaches 0

// Nécronomigore #700: arm the Nécronomigore equipment on the targeted allied Dofus (counter = 6).
// The click cell (castTarget AlliedDofusWithoutEquipement) is the host Dofus. No damage on placement,
// the bindata [SetPropertyData, CreateCardCounterData{6}, DamageData{5}] was dropped by the authored
// AttachNecronomigore effect (canPlayCard already rejects an already-equipped Dofus).
function handleAttachNecronomigore(dofuses: DofusInstance[], ctx: EffectContext): void {
  if (!ctx.targetCell) return;
  const d = dofuses.find(
    (o) => o.owner === ctx.casterSide && o.currentLife > 0 && sameCoords(o.position, ctx.targetCell!),
  );
  if (d) d.necronomigoreCounter = NECRONOMIGORE_COUNTER;
}

// Sinistro #215 firing (called at the OWNER's FIN_DE_TOUR for each of their Sinistro-bearing Dofus):
// the totem shoots forward along its host Dofus's row, like handleDamageInFront, it skips allied
// creatures / empty cells and hits the first enemy creature for 1; if none, it hits the enemy Dofus
// of that row for 1 (through woundDofus, so it breaks an enemy Sinistro too). A captured/invulnerable
// enemy Dofus is spared. The host never wounds itself (it only fires toward the enemy).
export function sinistroShot(
  creatures: CreatureInstance[],
  dofuses: DofusInstance[],
  log: GameEvent[],
  host: DofusInstance,
): void {
  const dx = host.owner === "ally" ? -1 : 1;
  const y = host.position.y;
  let target: CreatureInstance | undefined;
  for (let x = host.position.x + dx; x >= 0 && x < BOARD_COLS; x += dx) {
    const c = creatures.find((o) => o.currentLife > 0 && o.position.x === x && o.position.y === y);
    if (!c) continue;                    // empty cell → keep scanning
    if (c.owner === host.owner) continue; // allied creature → skip (does not block)
    target = c;                          // first enemy ahead
    break;
  }
  if (target) {
    log.push({ type: "SINISTRO_SHOT", dofusAt: { ...host.position }, targetCell: { ...target.position } });
    dealSpellDamageThroughGuard(target, 1, log, creatures, -1, host.owner); // sourceless (a Dofus has no instanceId)
    return;
  }
  // No enemy creature ahead → hit the enemy Dofus of this row, if any (resolveDeathsAndWin settles capture/win).
  const d = dofuses.find((o) => o.currentLife > 0 && o.owner !== host.owner && o.position.y === y);
  if (!d || dofusInvulnerable(d, creatures)) return; // Artheon #1424
  log.push({ type: "SINISTRO_SHOT", dofusAt: { ...host.position }, targetCell: { ...d.position } });
  woundDofus(d, 1, log, creatures, dofuses); // canonical Dofus damage (also breaks an enemy Sinistro)
  if (d.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", dofusAt: { ...d.position } });
  else log.push({ type: "DAMAGE", targetCell: { ...d.position }, damage: 1 });
}

// Nécronomigore #700 firing (called at the owner's FIN_DE_TOUR once its counter has reached 0):
// "il infligera tous les tours 5 aux Dofus adverses": deal NECRONOMIGORE_DAMAGE to every enemy
// Dofus. Each Dofus hit is revealed first (like fatigue), then takes the damage through
// woundDofus (breaks an enemy Sinistro, counts toward capture/win). An invulnerable enemy Dofus
// (Artheon #1424 / Orbe Doré #594) is revealed but takes no damage. The caller settles
// capture/win with resolveDeathsAndWin.
export function necronomigoreFire(
  side: Side,
  creatures: CreatureInstance[],
  dofuses: DofusInstance[],
  log: GameEvent[],
): void {
  for (const d of dofuses) {
    if (d.owner === side || d.currentLife <= 0) continue; // only living enemy Dofus
    if (!d.revealed) { d.revealed = true; log.push({ type: "DOFUS_REVEALED", at: { ...d.position }, kind: d.kind }); }
    if (dofusInvulnerable(d, creatures)) continue; // revealed but takes no damage
    woundDofus(d, NECRONOMIGORE_DAMAGE, log, creatures, dofuses);
    if (d.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", dofusAt: { ...d.position } });
    else log.push({ type: "DAMAGE", targetCell: { ...d.position }, damage: NECRONOMIGORE_DAMAGE });
  }
}

// "inflige N dégât au dofus adverse" (Jèms Blond #340, COUP DE GRÂCE): hits the enemy Dofus on the
// source's own row directly ("celui de sa ligne"), with no creature scan. The caller's
// resolveDeathsAndWin settles the capture/win, like AoeDamageDofus.
function handleDamageDofusOnRow(
  creatures: CreatureInstance[],
  dofuses: DofusInstance[],
  log: GameEvent[],
  ctx: EffectContext,
  amount: number,
): void {
  const me = findSelf(creatures, ctx);
  if (!me || amount <= 0) return;
  const d = dofuses.find((o) => o.currentLife > 0 && o.owner !== me.owner && o.position.y === me.position.y);
  if (!d || dofusInvulnerable(d, creatures)) return; // Artheon #1424
  woundDofus(d, amount, log, creatures, dofuses); // canonical Dofus damage (breaks any Sinistro)
  if (d.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", dofusAt: { ...d.position } });
  else log.push({ type: "DAMAGE", targetCell: { ...d.position }, damage: amount });
}

// Flèche Criblante #8: "et N au Dofus adverse": the arrow goes through the targeted creature to the
// enemy Dofus on that creature's own row ("la ligne de l'invocation ciblée"). A spell has no
// source on the board, so "enemy" is relative to the caster (ctx.casterSide) and the row is the
// cast cell's (ctx.targetCell.y), even if the creature just died from the X damage. Settled like
// handleDamageDofusOnRow (an invulnerable Artheon Dofus is skipped; capture/win settled by the
// caller's resolveDeathsAndWin).
function handleDamageDofusOnTargetRow(
  creatures: CreatureInstance[],
  dofuses: DofusInstance[],
  log: GameEvent[],
  ctx: EffectContext,
  amount: number,
): void {
  if (!ctx.targetCell || amount <= 0 || ctx.casterSide == null) return;
  const d = dofuses.find((o) => o.currentLife > 0 && o.owner !== ctx.casterSide && o.position.y === ctx.targetCell!.y);
  if (!d || dofusInvulnerable(d, creatures)) return; // Artheon #1424
  woundDofus(d, amount, log, creatures, dofuses); // canonical Dofus damage (breaks any Sinistro)
  if (d.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", dofusAt: { ...d.position } });
  else log.push({ type: "DAMAGE", targetCell: { ...d.position }, damage: amount });
}

// "Augmente ses PM de la valeur de PM du premier adversaire de sa ligne" (Leanor):
// scan the source's row toward the enemy side (skipping allied creatures and
// empty cells, like handleDamageInFront), find the first enemy, and self-boost the
// source's movement by that enemy's base PM. No-op if no enemy ahead or it has 0 PM.
function handleBoostMovementFromEnemyInLine(
  creatures: CreatureInstance[],
  log: GameEvent[],
  ctx: EffectContext,
): void {
  const me = findSelf(creatures, ctx);
  if (!me) return;
  const dx = me.owner === "ally" ? -1 : 1;
  const y = me.position.y;
  let enemy: CreatureInstance | undefined;
  for (let x = me.position.x + dx; x >= 0 && x < BOARD_COLS; x += dx) {
    const c = creatures.find((o) => o.currentLife > 0 && o.position.x === x && o.position.y === y);
    if (!c) continue;              // empty cell → keep scanning
    if (c.owner === me.owner) continue; // allied creature → skip (does not block)
    enemy = c;                     // first enemy ahead
    break;
  }
  if (!enemy || enemy.baseMovement <= 0) return;
  mutateStat(me, log, "movement", "add", enemy.baseMovement);
}

// "Détruit une invocation", outright kill the creature on the target cell
// (ignores Shield: destruction is not damage). CantDie / Invulnerable still
// protect. resolveDeathsAndWin (called by the caster) culls it to the discard.
function handleDestroy(
  creatures: CreatureInstance[],
  log: GameEvent[],
  ctx: EffectContext,
): void {
  if (!ctx.targetCell) return;
  const c = creatures.find((x) => sameCoords(x.position, ctx.targetCell!) && x.currentLife > 0);
  if (!c) return;
  if (c.properties.has("CantDie") || c.properties.has("Invulnerable")) {
    log.push({ type: "DAMAGE_DODGED", targetInstanceId: c.instanceId });
    return;
  }
  c.currentLife = 0;
  log.push({ type: "FIGHT_OBJECT_REMOVED", instanceId: c.instanceId });
}

// "L'invocation ciblée charge de N cases", the creature advances exactly N
// cells this turn and shakes off summoning sickness so it can move/engage
// immediately. We set movementLeft to N (not max with whatever it had): a
// "charge de N cases" is a precise N-cell burst, so a 3-PM creature charged 1
// moves exactly 1, not its full PM. (A plain "Charge" keyword, by contrast,
// lets the creature advance by its PM; that is handled at summon time.) "toWall"
// charges far enough to reach the opposing wall.
function handleCharge(
  creatures: CreatureInstance[],
  log: GameEvent[],
  effect: { cells: number | "toWall" },
  ctx: EffectContext,
): void {
  if (!ctx.targetCell) return;
  const c = creatures.find((x) => sameCoords(x.position, ctx.targetCell!) && x.currentLife > 0);
  if (!c) return;
  // A Mur (Statue) and an INAMOVIBLE (Rooted) creature never charge. We leave before touching
  // movementLeft or emitting the charge effect, so the target stays fully unchanged. The burst
  // stays independent of PM for the others: a 0-PM creature (NoMovementPoints) hit by a charge
  // still moves, since a charge does not spend PM.
  if (c.properties.has("Statue") || c.properties.has("Rooted")) {
    return;
  }
  const cells = effect.cells === "toWall" ? BOARD_COLS : Math.max(0, effect.cells | 0);
  if (cells <= 0) return;
  const before = c.movementLeft;
  c.movementLeft = cells; // Exactly N, a charge of N is a precise N-cell burst
  c.hasAttacked = false; // charge lets it act this turn (bypass summoning sickness)
  log.push({
    type: "MOVEMENT_POINT_BOOST",
    instanceId: c.instanceId,
    movementMod: { valueBefore: before, modification: c.movementLeft - before, valueAfter: c.movementLeft },
    charge: true, // marks the charge: the display must not play the "+PM" FX
  });
}

// "Téléporte une invocation de N cases", instantly relocate the creature N
// cells forward (toward the enemy wall). Unlike Charge it does not fight or
// pick up prisms along the way, it jumps. It lands on the furthest valid
// landing cell within N (an on-board, non-wall cell that is empty of creatures
// and Dofuses), skipping over any occupied cells in between (it is a teleport).
// If no cell within N is free, it does not move. Statues cannot be teleported.
function handleTeleport(
  creatures: CreatureInstance[],
  dofuses: DofusInstance[],
  log: GameEvent[],
  effect: { cells: number | DynamicValue },
  ctx: EffectContext,
): void {
  if (!ctx.targetCell) return;
  const c = creatures.find((x) => sameCoords(x.position, ctx.targetCell!) && x.currentLife > 0);
  if (!c) return;
  if (isImmovable(c.properties)) { // INAMOVIBLE / Mur, cannot be teleported by an effect
    return;
  }
  // cells may be a dice value (Bond du Félin "de 1d6 cases"), roll it from the
  // seeded RNG so the jump distance is reproducible.
  const cells = Math.max(0, resolveDynamicValue(effect.cells, ctx.rng, ctx.diceFloor, diceSink(log, ctx)) | 0);
  if (cells <= 0) return;
  const dx = c.owner === "ally" ? -1 : 1; // forward = toward the enemy wall
  const y = c.position.y;
  const isWall = (x: number) => x === 0 || x === BOARD_COLS - 1;
  const free = (x: number) =>
    x >= 0 && x < BOARD_COLS && !isWall(x) &&
    !creatures.some((o) => o !== c && o.currentLife > 0 && o.position.x === x && o.position.y === y) &&
    !dofuses.some((d) => d.currentLife > 0 && d.position.x === x && d.position.y === y);
  // Furthest reachable landing cell within N (prefer the full jump).
  let dest: number | null = null;
  for (let k = cells; k >= 1; k--) {
    const nx = c.position.x + dx * k;
    if (free(nx)) { dest = nx; break; }
  }
  if (dest === null) return;
  const from = { ...c.position };
  c.position = { x: dest, y };
  log.push({
    type: "FIGHT_OBJECT_MOVED",
    instanceId: c.instanceId,
    from,
    to: { ...c.position },
    movementType: "TELEPORT",
  });
}

// "Se téléporte derrière son adversaire après avoir subi des dégâts" (Sram #183/#206/#546,
// CONTRE_COUP on itself). The creature (ctx.selfInstanceId) jumps to the cell right behind the
// attacker that just hit it, on the attacker's own base side (+x for an ally attacker, −x for an
// enemy one), in the attacker's row. The attacker is read from the most recent DAMAGE this
// creature took (sourceInstanceId in the log), so it works at any range and even when the damage
// came from a blast (no same-row requirement). No move if the attacker is unknown or dead, or if
// the landing cell is a base column, off the board or taken (creature or Dofus).
function handleTeleportBehindAttacker(
  creatures: CreatureInstance[],
  dofuses: DofusInstance[],
  log: GameEvent[],
  ctx: EffectContext,
): void {
  const selfId = ctx.selfInstanceId;
  if (selfId == null) return;
  const self = creatures.find((c) => c.instanceId === selfId && c.currentLife > 0);
  if (!self) return;
  if (isImmovable(self.properties)) return; // INAMOVIBLE / Mur, cannot teleport itself behind the attacker
  let attackerId: number | undefined;
  for (let i = log.length - 1; i >= 0; i--) {
    const ev = log[i] as { type: string; targetInstanceId?: number; sourceInstanceId?: number };
    if (ev.type === "DAMAGE" && ev.targetInstanceId === selfId && ev.sourceInstanceId != null) {
      attackerId = ev.sourceInstanceId;
      break;
    }
  }
  if (attackerId == null) return;
  const attacker = creatures.find((c) => c.instanceId === attackerId && c.currentLife > 0);
  if (!attacker) return;
  const bx = attacker.position.x + (attacker.owner === "ally" ? 1 : -1); // behind = toward attacker's base
  const by = attacker.position.y;
  const isWall = (x: number) => x === 0 || x === BOARD_COLS - 1;
  if (bx < 0 || bx >= BOARD_COLS || isWall(bx)) return;
  const occupied =
    creatures.some((o) => o.currentLife > 0 && o.position.x === bx && o.position.y === by) ||
    dofuses.some((d) => d.currentLife > 0 && d.position.x === bx && d.position.y === by);
  if (occupied) return;
  const from = { ...self.position };
  self.position = { x: bx, y: by };
  log.push({ type: "FIGHT_OBJECT_MOVED", instanceId: self.instanceId, from, to: { x: bx, y: by }, movementType: "TELEPORT" });
}

// "Prenez le contrôle d'une invocation adverse", the creature on the target
// cell switches to the CASTER's side. It now advances toward the opposite wall
// (direction is derived from owner) and is summoning-sick on the takeover turn
// (cannot move/attack until the caster's next turn), mirroring a fresh arrival.
// castTarget=OpponentSummon already restricts the pick to enemy creatures
// (enforced in validateSpellTarget).
function handleTakeControl(
  creatures: CreatureInstance[],
  log: GameEvent[],
  ctx: EffectContext,
): void {
  if (!ctx.targetCell) return;
  const c = creatures.find((x) => sameCoords(x.position, ctx.targetCell!) && x.currentLife > 0);
  if (!c) return;
  if (c.owner === ctx.casterSide) return; // already ours, nothing to take
  c.owner = ctx.casterSide;
  shedDrunkOnControlChange(c, log); // drunkenness does not survive the capture
  // Taking control (Séduction #185...) does not give summoning sickness again. The seized creature
  // becomes ours and plays its turn right away: it gets the "ready" state of a turn start (like
  // startTurn: movementLeft = baseMovement, hasAttacked = false), so it advances at the end of
  // this turn against its old camp. Before, it was made sick (movementLeft 0 + hasAttacked) and
  // skipped its turn.
  c.movementLeft = c.baseMovement;
  c.hasAttacked = false;
  // Changing camp resets the creature's AP cost to its printed value: the cost mod it was played
  // with by its former owner (a Vampyro/Wagnar reduction, a Polter Tofu escalation) and any in-play
  // override no longer apply, so if it later goes back to the new owner's hand (death recover /
  // bounce) it carries no old modifier.
  c.playedCostMod = 0;
  c.costOverride = undefined;
  log.push({ type: "SUMMONING_CHANGED_TEAM", instanceId: c.instanceId, newOwner: ctx.casterSide });
}

// "Réduit les invocations au silence": global, silences every creature on the board. Following
// the game's CAPACITY_DESC_Silence ("Annule les compétences et les modificateurs de
// l'invocation"), a silenced creature loses both:
//   - its abilities: keyword properties, triggers, innate Résistance, and any gained Armure pool;
//   - its stat modifiers: attack / life / movement go back to the card's printed values (buffs and
//     debuffs are wiped). Life is only ever reduced (silence never heals): currentLife is capped
//     at printedLife.
// A creature is only hit if it actually has something to strip, so the log stays clean. (#220 says
// only "les invocations", so all sides.)
// The 3 immobility keywords, in the two sources summonCreature reads to set them:
// card.properties and the flat SetPropertyData. Used by silence to tell printed
// immobility (which survives) from immobility given by a spell (which goes away).
const IMMOBILITY: ReadonlySet<string> = new Set(["Statue", "Rooted", "NoMovementPoints"]);

function handleSilence(
  creatures: CreatureInstance[],
  log: GameEvent[],
  ctx: EffectContext,
  scope: Scope | undefined,
  shape: AoeShape | undefined,
  single?: boolean,
  excludeSelf?: boolean,
): void {
  // Default scope is "all" (global Mot de Silence). A scope / shape narrows it
  // (e.g. Ronces Multiples = the cross of the targeted cell). `single` restricts
  // to the one creature on the picked cell (Justice #209: "Réduisez UNE
  // invocation au silence"). `excludeSelf` spares the source ("les AUTRES
  // invocations", Phaeris #597).
  const sc: Scope = scope ?? "all";
  for (const c of sweepOrder(creatures, ctx.casterSide)) { // balayage (AoE hors dégâts)
    if (c.currentLife <= 0) continue;
    if (excludeSelf && c.instanceId === ctx.selfInstanceId) continue;
    if (single && (!ctx.targetCell || c.position.x !== ctx.targetCell.x || c.position.y !== ctx.targetCell.y)) continue;
    if (!scopeMatches(c, sc, ctx.casterSide)) continue;
    if (shape && (!ctx.targetCell || !inShape(c, ctx.targetCell, shape))) continue;
    const hadSomething =
      c.properties.size > 0 ||
      c.triggers.length > 0 ||
      c.resistance > 0 ||
      c.armor > 0 ||
      c.range > 0 ||
      c.baseAttack !== c.printedAttack ||
      c.baseLife !== c.printedLife ||
      c.baseMovement !== c.printedMovement ||
      // An ability can live entirely in `card.effects` without leaving any trace on the
      // instance: cost aura (Felida #216, Silo #849, Piou Royal #542, Héroïne Éternelle #1100),
      // CHEF aura, reduction, reactive marker. Without this term these creatures were skipped,
      // `silenced` was never set, and the ~20 `!c.silenced` guards of the engine became dead
      // code for exactly the cards they were meant to cover: 96 creatures of the catalogue,
      // including 6 of the 8 earlier silence fixes (#819, #216, #416, #355, #849, #523).
      // Measured before the fix: Mot de Silence #220 cast directly on a Piou Royal #542 left
      // `silenced === false` and emitted no FIGHT_OBJECT_SILENCED. A vanilla creature
      // (`effects: []`) is still ignored, so there is no log noise.
      // effsOf and not getCard: a copied ability (Anathar #316, textCardId) counts exactly
      // like a printed ability. Without it, an Anathar whose whole text is passive (CHEF aura,
      // cost aura, reactive marker) would be skipped by handleSilence, `silenced` would never be
      // set, and the `!c.silenced` guards of the engine would become dead code on it again,
      // exactly the regression this term was added to close.
      effsOf(c).length > 0 ||
      // Modifiers stamped on the instance with no trace elsewhere: Vulnérabilité, Gangraine
      // #1439, usurped families (Pupuce #441). Without these terms a creature that only carried
      // Gangraine was skipped, and silence did nothing on it in particular.
      c.vulnerability > 0 ||
      c.movementPoison > 0 ||
      c.familyOverride != null;
    if (!hadSomething) continue;

    // A Wall stays a wall even when silenced ("ne peut jamais se déplacer … même s'il est réduit
    // au silence"), so only the immobility printed on the card is kept. An immobility given from
    // outside (Enraciné #692, Camouflage #890, Stabilité #2022) is an effect like any other and goes
    // away with the rest: silence removes every effect and turns a creature into a vanilla one. An
    // aura immobility (Arakne à Crochets #1457) is granted again just after by withAuras: silence
    // cuts what a creature gives, not what it receives.
    const printedImmobility = new Set<string>();
    {
      const cd = getCard(c.cardId);
      for (const q of cd?.properties ?? []) if (IMMOBILITY.has(q)) printedImmobility.add(q);
      for (const e of cd?.effects ?? []) {
        if (e.type !== "SetPropertyData") continue;
        const q = (e as { PropertyType?: string }).PropertyType;
        if (q && IMMOBILITY.has(q)) printedImmobility.add(q);
      }
    }
    const keep = new Set<string>();
    for (const q of printedImmobility) if (c.properties.has(q)) keep.add(q);
    const droppedRooted = c.properties.has("Rooted") && !keep.has("Rooted");
    c.properties = keep;
    c.stunTurns = undefined; // "Stunned" just went away, and so does its multi-turn counter
    c.triggers = [];
    c.resistance = 0;
    c.armor = 0;
    c.range = 0; // Portée is a compétence → silenced shooter becomes melee.
    // Revert stat modifiers to printed values.
    c.currentAttack = c.printedAttack;
    c.baseAttack = c.printedAttack;
    c.baseLife = c.printedLife;
    c.currentLife = Math.min(c.currentLife, c.printedLife);
    c.baseMovement = c.printedMovement;
    c.movementLeft = Math.min(c.movementLeft, c.printedMovement);
    // Silence resets the stats to the printed values (without auras) above, but the aura*
    // accumulators still hold what was folded in. withAuras strips `aura*` from the live stats and
    // then adds it back; if they stayed as they were, the strip would subtract twice, and a silenced
    // creature that receives a living chief's aura would wrongly lose it. They are reset to the
    // printed baseline; withAuras gives back any aura the creature still receives from a source that
    // is not silenced.
    c.auraAttack = 0;
    c.auraMovement = 0;
    c.auraRange = 0;
    c.auraResistance = 0;
    // Silence empties `vulnerability` further down (back to vanilla): without this reset, step 1
    // of withAuras would subtract a stale aura share again from a field already at 0. withAuras
    // then grants the aura share again if a living, non-silenced Empaleur still gives it.
    c.auraVulnerability = 0;
    c.auraProperties = new Set<string>();
    // Silence wipes the properties, so the bookkeeping of the conditional keywords that withAuras
    // granted must start again from zero. Otherwise the next reconciliation would try to remove bits
    // that are already gone (and worse, a new grant would wrongly remember them as "already innate").
    c.condProperties = new Set<string>();
    // Silence removes every effect and turns a creature into a vanilla one. The last
    // survivors were the negative modifiers stamped on the instance, which nothing else
    // reset.
    if (c.vulnerability > 0) {
      c.vulnerability = 0;
      log.push({ type: "PROPERTY_UNAPPLIED", instanceId: c.instanceId, property: "Vulnerability" });
    }
    if (c.movementPoison > 0) {
      c.movementPoison = 0;
      log.push({ type: "PROPERTY_UNAPPLIED", instanceId: c.instanceId, property: "MovementPoison" });
    }
    if (droppedRooted) log.push({ type: "PROPERTY_UNAPPLIED", instanceId: c.instanceId, property: "Rooted" });
    c.familyOverride = undefined; // Pupuce #441: back to the printed families of the card
    c.textCardId = undefined; // Anathar #316: the copied text goes away with the rest (back to the printed text)
    // Bookkeeping of conditional auras: the stats were just reset to the printed values, so
    // these counters of "what is currently folded in" are stale. Leaving them would make
    // withAuras compute a wrong delta at the next recompute.
    c.condArmorGranted = 0; // conditional AR (#387/#559), armor was just emptied
    c.inCampAtk = 0;        // conditional AT "dans votre camp" (Exécuteur Endeuillé #1425)
    c.silenced = true; // persistent marker for the UI overlay (flag ⟺ event)

    log.push({ type: "FIGHT_OBJECT_SILENCED", instanceId: c.instanceId });
  }
}

function handleDamage(
  creatures: CreatureInstance[],
  dofuses: DofusInstance[],
  log: GameEvent[],
  effect: Extract<Effect, { type: "DamageData" }>,
  ctx: EffectContext,
): void {
  if (!ctx.targetCell) return;
  const pierceArmor = !!(effect as { pierceArmor?: boolean }).pierceArmor; // PERCE ARMURE (#294)
  const dmg = resolveDynamicValue(effect.Damage, ctx.rng, ctx.diceFloor, diceSink(log, ctx));
  // Capture the roll when the amount was a die, so a follow-up "sur N ou moins"
  // effect (Dé du Chateux) reacts to this very roll.
  const dv = effect.Damage as { type?: string; dice?: string };
  if (typeof dv === "object" && (dv.type === "TriggeringDiceValue" || typeof dv.dice === "string")) ctx.diceRoll = dmg;
  if (dmg <= 0) return;

  // Try to hit a creature first (priority over Dofus on the cell, in
  // practice they cannot coexist on the same cell, so this is a one-or-
  // the-other lookup).
  const creature = creatures.find(
    (c) => sameCoords(c.position, ctx.targetCell!) && c.currentLife > 0,
  );
  if (creature) {
    // Spells go through the shared damage helper so Shield / CantDie also apply to spell damage.
    // `pierceArmor` (PERCE ARMURE, Flèche Perçante #294) makes the hit ignore the target's Armure.
    // Garde du corps #320/#300: the spell lands on the target's bodyguard instead (if there is one),
    // which only absorbs up to its own life; the rest goes through to the protected creature.
    dealSpellDamageThroughGuard(creature, dmg, log, creatures, ctx.sourceInstanceId ?? -1, ctx.casterSide, pierceArmor, ctx.isSpell ?? true);
    return;
  }

  // General rule: a damage spell only hits a Dofus if the card says so (ctx.dofusTargetable,
  // castTarget Dofus, e.g. Fléau #757).
  if (!ctx.dofusTargetable) return;
  const dofus = dofuses.find(
    (d) => sameCoords(d.position, ctx.targetCell!) && d.currentLife > 0,
  );
  if (dofus && dofusInvulnerable(dofus, creatures)) return; // Artheon #1424: invulnerable Dofus takes no spell damage
  if (dofus) {
    // Lien de Sang #1495: a living creature linked to this Dofus takes the spell damage
    // in its place (its own Shield/Résistance/Armure apply), and the Dofus takes nothing.
    // A silenced protector no longer protects.
    const guard = dofus.protectedBy != null
      ? creatures.find((c) => c.instanceId === dofus.protectedBy && c.currentLife > 0 && !c.silenced)
      : undefined;
    if (guard) {
      const lifeBefore = guard.currentLife;
      const armorBefore = guard.armor;
      const dealt = applyDamageToCreatureFromSpell(guard, dmg, log, creatures, ctx.casterSide, pierceArmor, ctx.isSpell ?? true);
      if (dealt > 0 || armorBefore > guard.armor) {
        log.push({ type: "DAMAGE", sourceInstanceId: ctx.sourceInstanceId ?? -1, targetInstanceId: guard.instanceId, damage: dealt, armorHit: armorBefore > guard.armor });
      }
      if (guard.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", instanceId: guard.instanceId });
      // Lien de Sang #1495 behaves like Sacrifice: the protector soaks only up to its own life;
      // any surplus spills onto the Dofus (which then meets it with its own defences).
      const overflow = Math.max(0, dealt - lifeBefore);
      if (overflow > 0) {
        woundDofus(dofus, overflow, log, creatures, dofuses); // canonical Dofus damage (breaks any Sinistro)
        log.push({ type: "DAMAGE", sourceInstanceId: ctx.sourceInstanceId ?? -1, targetCell: { ...dofus.position }, damage: overflow });
        if (dofus.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", dofusAt: { ...dofus.position } });
      }
    } else {
      // "Réduit de N les dégâts des sorts adverses" (Joris #110) also protects the Dofus of its camp: an
      // enemy spell (Fléau #757) has its damage to the Dofus lowered by N before woundDofus (the
      // reduction used to be shown on the card while the Dofus still took the raw damage). Only applies
      // to enemy spell damage; a creature ability that hits a Dofus (isSpell=false) or allied damage is
      // not reduced.
      const dofusDmg = (ctx.isSpell ?? true) && ctx.casterSide != null && ctx.casterSide !== dofus.owner
        ? Math.max(0, dmg - sumSpellDamageReduction(creatures, dofus.owner))
        : dmg;
      if (dofusDmg <= 0) return; // fully absorbed: the Dofus takes nothing (no DAMAGE logged)
      woundDofus(dofus, dofusDmg, log, creatures, dofuses); // canonical Dofus damage (breaks any Sinistro)
      log.push({
        type: "DAMAGE",
        targetCell: { ...dofus.position },
        damage: dofusDmg,
        sourceInstanceId: ctx.sourceInstanceId,
      });
      if (dofus.currentLife <= 0) {
        log.push({ type: "FIGHT_OBJECT_REMOVED", dofusAt: { ...dofus.position } });
      }
    }
  }
  // Empty cell, damage is wasted, no log entry (matches in-game
  // behaviour: AoE on a dead-end cell just fizzles).
}

function handlePush(
  creatures: CreatureInstance[],
  dofuses: DofusInstance[],
  log: GameEvent[],
  effect: { type: "PushData"; Distance: number },
  ctx: EffectContext,
): void {
  // "Repousse de N cases": move the creature on the target cell away
  // from the caster, i.e. toward its OWNER's wall column. We push by
  // up to N cells, stopping at the first obstacle (other creature,
  // Dofus, board edge). Cells crossed do not take damage; we just
  // teleport-step until we hit something.
  //
  // If the target cell is empty or holds a Dofus, push does nothing
  // (Dofuses are immovable; in-game push only affects "invocations").
  // If the creature died from an earlier effect on this card (e.g.
  // DamageData), currentLife<=0 → skip too: a corpse does not get
  // pushed.
  if (!ctx.targetCell) return;
  const dist = effect.Distance | 0;
  if (dist <= 0) return;

  const target = creatures.find(
    (c) => sameCoords(c.position, ctx.targetCell!) && c.currentLife > 0,
  );
  if (!target) return;
  slideCreatureBack(target, creatures, dofuses, dist, log, undefined, ctx.onSlideStep);
  // "Repoussez une invocation de 7 cases. Infligez LUI 4..." (Ombre #515): the following effects of
  // the same card aim at the same creature, so at its new cell. Without this update, they would hit
  // the cell it just left and reach nobody. The context belongs to this applyEffects call (an object
  // literal at each caller), so the mutation does not leak.
  ctx.targetCell = { ...target.position };
}

// The push primitive ("Repousse de N cases", Championne Embrocheuse). Slides
// one creature away from its objective (toward its OWNER's wall: ally → x+,
// enemy → x−) by up to `dist` cells, stopping at the first obstacle (another
// creature, a Dofus, or the board edge). Cells crossed take no damage. Emits a
// SLIDE move. Shared so the mass-retreat (Tout ou Rien) uses the exact same
// movement as the push.
export function slideCreatureBack(
  target: CreatureInstance,
  creatures: CreatureInstance[],
  dofuses: DofusInstance[],
  dist: number,
  log: GameEvent[],
  towardSide?: Side,
  // When given, each crossed cell goes through this hook so the sliding creature interacts
  // with the board like a normal advance step (gangrène + walking over tokens + prism). The
  // slide stops as soon as the creature dies on the way (gangrène / enemy seed / trap).
  // Absent: a plain relocation (the older behaviour, no interaction).
  onStep?: (mover: CreatureInstance, nx: number, ny: number) => void,
): void {
  if (target.currentLife <= 0 || (dist | 0) <= 0) return;
  // INAMOVIBLE (Rooted) / Mur (Statue) "ne peut jamais être déplacé": push, attract and
  // retreat (all go through here) cannot move it.
  if (isImmovable(target.properties)) {
    return;
  }
  // Default: toward the TARGET's own wall (push-back). `towardSide` overrides this to
  // slide toward that side's wall/Dofus instead (Chacha Tyran #943 "attire … vers les
  // dofus du propriétaire de Chacha", which may be the opposite direction).
  const dx = (towardSide ?? target.owner) === "ally" ? +1 : -1;
  const from = { ...target.position };
  let stepsMoved = 0;
  for (let i = 0; i < (dist | 0); i++) {
    const nx = target.position.x + dx;
    const ny = target.position.y;
    // A forced slide (push / attract / retreat) stops just before a wall column (x=0 or
    // x=BOARD_COLS-1): a destroyed Dofus frees its cell for a walk or a charge (which then
    // breaks through to the bottom of the deck, see advanceCreature/isWallCol), but never for
    // a forced move, so a pushed or pulled creature stops one cell short. A living Dofus on
    // that cell is also caught by the next check; this one covers the dead one.
    if (nx <= 0 || nx >= BOARD_COLS - 1) break;            // off-board or a wall column
    if (creatures.some((c) => c !== target && c.currentLife > 0 && c.position.x === nx && c.position.y === ny)) break;
    if (dofuses.some((d) => d.currentLife > 0 && d.position.x === nx && d.position.y === ny)) break;
    target.position = { x: nx, y: ny };
    stepsMoved++;
    if (onStep) {
      // Interact with the cell just entered (token walk-over + gangrène), exactly like
      // a walking step. If it kills the creature, stop sliding, a corpse moves no further.
      onStep(target, nx, ny);
      if (target.currentLife <= 0) break;
    }
  }
  if (stepsMoved > 0) {
    log.push({ type: "FIGHT_OBJECT_MOVED", instanceId: target.instanceId, from, to: { ...target.position }, movementType: "SLIDE" });
  }
}

// --- Self-targeted handlers (triggered effects on the owner) ---
//
// These run when a trigger (APPARITION / MORT / ...) fires on a creature whose own
// description tells it to do something to itself (e.g. "APPARITION : S'inflige 2 dégâts"
// = self damage 2). The caller puts the creature's instanceId in ctx.selfInstanceId and
// it is looked up here. With no selfInstanceId they silently do nothing (these effect
// types make no sense outside a self trigger).

function findSelf(
  creatures: CreatureInstance[],
  ctx: EffectContext,
): CreatureInstance | undefined {
  if (ctx.selfInstanceId === undefined) return undefined;
  return creatures.find((c) => c.instanceId === ctx.selfInstanceId);
}

function handleSelfDamage(
  creatures: CreatureInstance[],
  log: GameEvent[],
  effect: { Damage: number },
  ctx: EffectContext,
): void {
  const me = findSelf(creatures, ctx);
  if (!me || me.currentLife <= 0) return;
  const dmg = effect.Damage | 0;
  if (dmg <= 0) return;
  // "S'inflige N dégât" (Muguet Tourmenté #946, Disciple de l'Agonie #1163 "puis à lui-même"...) is
  // ordinary damage taken: it has to drain armour before life, and respect Bouclier / Résistance /
  // Vulnérabilité / Invulnérable, like any other hit (it used to subtract raw HP, so a Muguet with
  // AR lost life while its armour stayed untouched). isSpell=false: self damage is not spell
  // damage. Self damage has to be absorbed by a Garde du corps protecting the creature, so it goes
  // through the guard-aware helper: a protected creature hurting itself has the damage taken by its
  // bodyguard (anything past the guard's HP spills over onto it, like any damage). The helper logs
  // DAMAGE / FIGHT_OBJECT_REMOVED itself.
  dealSpellDamageThroughGuard(me, dmg, log, creatures, me.instanceId, me.owner, false, false);
}

function handleBoostAttack(
  creatures: CreatureInstance[],
  effect: { Boost: number },
  ctx: EffectContext,
): void {
  const me = findSelf(creatures, ctx);
  if (!me) return;
  me.currentAttack += effect.Boost | 0;
  me.baseAttack += effect.Boost | 0;       // persistent boost
}

function handleBoostLife(
  creatures: CreatureInstance[],
  effect: { Boost: number },
  ctx: EffectContext,
): void {
  const me = findSelf(creatures, ctx);
  if (!me) return;
  const b = effect.Boost | 0;
  me.currentLife += b;
  me.baseLife += b;                         // also raises the cap
}

function handleHealSelf(
  creatures: CreatureInstance[],
  log: GameEvent[],
  effect: { Heal: number },
  ctx: EffectContext,
): void {
  const me = findSelf(creatures, ctx);
  if (!me || me.currentLife <= 0) return;
  const heal = effect.Heal | 0;
  // Sangsuce Tsu Tsu #24: "TOUS les soins deviennent des dégâts." Exact mirror of applyStatMod
  // (reverseHeal) and handleHealFull; this was the third and last heal path that escaped it.
  // The self-heal becomes spell damage of the same amount, with the whole chain (spell
  // insensitivity, anti-spell reduction, Bouclier / Résistance / Vulnérabilité, armour then HP),
  // and without LIFE_HEALED: a reversed heal is not a heal, so it must not arm the "quand une
  // invocation est soignée" reactors (Pacificatrice #1519, Dargone #1291, Malox #76). As in
  // applyStatMod, the inversion short-circuits before the overheal cap: the damage lands even at
  // full HP. The only card that takes this path today: Luc Ossit #769 (FIN DE TOUR, Heal 1).
  if (heal > 0 && healsAreReversed(creatures)) {
    const armorBefore = me.armor;
    const dealt = applyDamageToCreatureFromSpell(me, heal, log, creatures, ctx.casterSide);
    if (dealt > 0 || armorBefore > me.armor) {
      log.push({ type: "DAMAGE", sourceInstanceId: ctx.selfInstanceId ?? -1, targetInstanceId: me.instanceId, damage: dealt, armorHit: armorBefore > me.armor });
    }
    return;
  }
  const before = me.currentLife;
  // Do not overheal past baseLife (in-game cap on heal-self).
  me.currentLife = Math.min(me.baseLife, me.currentLife + heal);
  // Emit LIFE_HEALED so a self heal counts as "une invocation est soignée": it triggers the
  // heal-reaction auras (Pacificatrice #1519, Dargone #1291, Malox #76) and shows in the log like
  // any other heal. Since applyHealReactions runs at the end of this applyEffects pass, a
  // FIN_DE_TOUR self heal (Luc Ossit #769) deals its damage and fully resolves inside the
  // FIN_DE_TOUR phase, so before the advance. Does nothing at the cap.
  if (me.currentLife > before) {
    log.push({ type: "LIFE_HEALED", instanceId: me.instanceId, heal: me.currentLife - before, lifeMod: mod(before, me.currentLife) });
  }
}

function handleSetProperty(
  creatures: CreatureInstance[],
  _dofuses: DofusInstance[],
  log: GameEvent[],
  effect: Extract<Effect, { type: "SetPropertyData" }>,
  ctx: EffectContext,
): void {
  // Property goes on the creature at targetCell. Spells like "Furtif"
  // target an ally and add the Furtif property to it.
  // SetProperty on a Dofus is also possible (e.g. [DBG] Invincible
  // Dofus), we route to either container depending on what is at the
  // target cell.
  if (!ctx.targetCell) return;
  const prop = effect.PropertyType;
  if (!prop) return;
  const creature = creatures.find(
    (c) => sameCoords(c.position, ctx.targetCell!) && c.currentLife > 0,
  );
  // Pandawa god: the same guards as handleGrantProperty. A data SetPropertyData "Saoul"
  // must neither make a non-Pandawa drunk nor miss the new trigger on a target that is
  // already drunk. No card takes this path today; it is a consistency guard for future data.
  if (creature && prop === SAOUL) {
    if (!famsOf(creature).includes("Pandawa")) return;
    if (creature.properties.has(prop)) {
      log.push({ type: "PROPERTY_APPLIED", instanceId: creature.instanceId, property: prop });
      return;
    }
  }
  if (creature && !creature.properties.has(prop)) {
    creature.properties = new Set(creature.properties); // clone before mutating the shared Set (aliasing)
    creature.properties.add(prop);
    log.push({ type: "PROPERTY_APPLIED", instanceId: creature.instanceId, property: prop });
    return;
  }
  // No-op on Dofus for now, Dofus does not model properties (the
  // [DBG] Invincible Dofus needs a DofusInstance.properties field that
  // we will add when we wire targeted-on-Dofus effects properly).
}
