// Game event vocabulary, named after the events of the original game.
//
// Convention: we keep the game's UPPER_SNAKE_CASE names as they are, so the events the engine
// emits read the same as the original game's. Each event below carries only the payload
// fields it uses; it is a TypeScript discriminated union rather than one struct where every
// field is optional, because TS narrows it well.
//
// Many of these events are not emitted by the engine yet. They are defined here so the names
// already exist when new mechanics are added (Phorzerker fusion, Sinistro shots, seeds, ...).

import type { Coords, Side } from "./board";

// The movement types of the original game.
// (TELEPORT / SLIDE / RALLY are used by spells/abilities that move
// creatures without walking.)
export type MovementType = "WALK" | "RUN" | "TELEPORT" | "SLIDE" | "RALLY";

// The kinds of triggered ability of the original game.
// (Used by NEW_TRIGGERABLE_CAPACITY / TRIGGERABLE_CAPACITY_ENDED to
// describe when a triggered ability fires.)
export type TriggerableCapacityType =
  | "EMPTY" | "ON_SOMETHING" | "ON_DEATH" | "ON_DEATH_BLOW"
  | "ON_HIT" | "WHEN_WOUNDED";

// ValueModification, the same shape as in the original game.
// Used by DAMAGE / LIFE_HEALED / ATTACK_GAINED / ARMOR_GAINED / etc.
// when communicating "this stat changed from X to Y by amount Z".
export interface ValueModification {
  valueBefore: number;
  modification: number;
  valueAfter: number;
}

// Discriminated union of every game event. The field shapes follow what the original game's
// executors read from GameEventData (Int1..Int5, CellCoord1..2, etc.). We give those fields
// meaningful names.

export type GameEvent =
  // ===== Turn lifecycle =====
  | { type: "TURN_STARTED"; side: Side; turn: number }
  | { type: "TURN_STARTED_READY"; side: Side }
  | { type: "TURN_ENDED"; side: Side; turn: number }
  | { type: "MOVEMENT_PHASE_STARTED"; side: Side }
  | { type: "MOVEMENT_PHASE_ENDED"; side: Side }
  | { type: "FIGHT_STARTED" }
  | { type: "FIGHT_ENDED" }
  // ===== Cards =====
  | { type: "CARD_TO_BE_PLAYED"; side: Side; cardId: number }
  | { type: "CARD_PLAYED"; side: Side; cardId: number; instanceId?: number }
  | { type: "CARD_DRAWN"; side: Side; cardId: number; burned?: boolean }
  // `from: "nowhere"` = the card is created (Fléau prism, token, butin): it comes
  // from no pile. The original game has its own move for this case, 0.30 s in one
  // go, against 0.70 s for a real draw.
  // `at` (optional): the cell where the card was gained when it comes from a ground
  // object that was picked up (Butin reward → card created in hand). It lets the
  // replay move the card flight to the moment of the pickup, with the creature
  // stopped on the cell (same mechanism as the Cadeau de Nowel outcomes).
  | { type: "CARD_MOVED"; cardId: number; from: "hand" | "deck" | "discard" | "board" | "nowhere"; to: "hand" | "deck" | "discard" | "board" | "banished"; side: Side; at?: Coords }
  | { type: "CARD_EFFECT_FAILED"; cardId: number; reason: string }
  | { type: "CARD_FUSION"; sourceInstanceId: number; absorbedInstanceId: number }
  | { type: "BANISHED_CARD_EVENT"; cardId: number; side: Side }
  | { type: "PLAYER_CARD_COST_MODIFIED"; side: Side; cardId: number; newCost: number }
  | { type: "DYNAMIC_CARD_VALUES"; cardId: number }
  | { type: "NO_MORE_CARD_TO_DRAW"; side: Side }
  | { type: "HAND_FULL"; side: Side }
  // ===== Summons / Fight Objects =====
  | { type: "NEW_SUMMON"; instanceId: number; cardId: number; owner: Side; at: Coords }
  | { type: "FIGHT_OBJECT_MOVED"; instanceId: number; from: Coords; to: Coords; movementType: MovementType }
  // `transformed`: the removal is a transformation into a board object (Main de
  // Nidas → Butin, TransformIntoSeed/Bush…), not a death. The replay plays neither
  // the death animation and sound nor the flight to the discard: the transformation
  // FX, then the object appears (NEW_A_O_E).
  | { type: "FIGHT_OBJECT_REMOVED"; instanceId?: number; dofusAt?: Coords; brokeThrough?: boolean; transformed?: boolean }
  | { type: "FIGHT_OBJECT_TRANSFORMED"; instanceId: number; intoCardId: number }
  | { type: "FIGHT_OBJECT_SILENCED"; instanceId: number }
  | { type: "SUMMONING_CHANGED_TEAM"; instanceId: number; newOwner: Side }
  | { type: "SUMMON_FAMILIES_MODIFIED"; instanceId: number; families: string[] }
  | { type: "ADD_SUMMONING_SICKNESS"; instanceId: number }
  // ===== Stats / Combat =====
  | { type: "FIGHT_ATTACK"; attackerId: number; targetId: number }
  | { type: "DAMAGE"; targetInstanceId?: number; targetCell?: Coords; damage: number; sourceInstanceId?: number; lifeMod?: ValueModification;
      // True when this hit is part of a simultaneous creature-vs-creature
      // exchange (both strike at once). Both paired DAMAGE events carry it
      // so the replay plays the two attack animations together. Absent for
      // single / initiative (FirstStrike) strikes, which play sequentially.
      // Same as the simultaneous attacks flag of the original game.
      simultaneous?: boolean;
      // True when the hit went into the target's armour (even if it cost no life). CONTRE_COUP fires on
      // "subir des dégâts", which includes losing armour, so it is flagged here for the trigger to react
      // to armour-only hits.
      armorHit?: boolean;
      // True when this hit is a real combat strike (melee exchange, shooter shot, attack splash,
      // wall/Dofus hit: the source physically attacks). The replay only plays the source's 'attack'
      // swing for these; effect damage (APPARITION like Black Wabbit, FIN_DE_TOUR like Pacificatrix,
      // spells, hits back...) leaves it unset, so the source stays idle while the victim flinches.
      // Only a replay annotation, no rules logic reads it.
      combat?: boolean;
      // The cell where the damage happened when it comes from a ground object that was picked up
      // (the "damage" outcome of a Cadeau de Nowel), see the `at` note of the stat events. Not to be
      // confused with targetCell (damage on a Dofus).
      at?: Coords }
  // `onDeathOf` = this stat change is the reaction to a death (MORT / MORT ADVERSE /
  // MORT ALLIEE, e.g. Disciple Cochonnet #616 gaining +1 AT/+1 AR when an enemy
  // dies). The engine resolves the deaths after the full sweep, so these events
  // land at the end of the log: without this marker, the display played the boost
  // after the other creatures moved, instead of at the moment of the fatal hit.
  // Additive and only for display (the final state is the same, the events carry
  // absolute values).
  | { type: "LIFE_HEALED"; instanceId: number; heal: number; lifeMod: ValueModification; onDeathOf?: number }
  // `at` (optional): the cell where the effect happened, when it comes from a ground
  // object that was picked up (outcome of a Cadeau de Nowel). Without this stamp the
  // replay cannot link the outcome to the gift's cell (the event only carries the
  // instanceId, and the creature has already finished its walk).
  | { type: "ARMOR_GAINED"; instanceId: number; armorMod: ValueModification; onDeathOf?: number; at?: Coords }
  | { type: "ATTACK_GAINED"; instanceId: number; attackMod: ValueModification; onDeathOf?: number; at?: Coords }
  | { type: "DAMAGE_GAINED"; instanceId: number; damageMod: ValueModification }
  | { type: "HIT_BOOSTED"; instanceId: number; boost: number }
  | { type: "PLAYER_DAMAGES_BOOST"; side: Side; boost: number }
  | { type: "DAMAGE_REFLECTION_REGISTRATION"; instanceId: number }
  | { type: "DAMAGE_REFLECTED"; reflectorId: number; originalAttackerId: number; damage: number }
  | { type: "DAMAGE_DODGED"; targetInstanceId: number; sourceInstanceId?: number }
  // `charge` = this PM gain is a charge (Lait de Bambou #506: "Chargez de N cases"),
  // not a real PM bonus. The engine uses the same event for both; without this
  // marker the display played the "+PM" FX on a charge. Additive: consumers that
  // ignore it do not change.
  | { type: "MOVEMENT_POINT_BOOST"; instanceId: number; movementMod: ValueModification; charge?: boolean; onDeathOf?: number; at?: Coords }
  | { type: "MOVEMENT_POISON"; instanceId: number; movementMod: ValueModification }
  | { type: "SHOOTER_RANGE"; instanceId: number; rangeMin: number; rangeMax: number }
  | { type: "RESISTANCE"; instanceId: number; resistanceMod: ValueModification }
  | { type: "SET_HIT_LIMIT"; instanceId: number; limit: number }
  // ===== Properties / Triggers =====
  | { type: "PROPERTY_APPLIED"; instanceId: number; property: string }
  | { type: "PROPERTY_UNAPPLIED"; instanceId: number; property: string }
  | { type: "NEW_TRIGGERABLE_CAPACITY"; instanceId: number; capacityType: TriggerableCapacityType }
  | { type: "TRIGGERABLE_CAPACITY_ENDED"; instanceId: number; capacityType: TriggerableCapacityType }
  // ===== Dofuses =====
  | { type: "DOFUS_REVEALED"; at: Coords; kind: "real" | "fake" }
  | { type: "DOFUS_HIDDEN"; at: Coords }
  | { type: "LAST_DOFUS_DESTROYED"; winner: Side }
  | { type: "BLOCKED_DOFUS"; at: Coords }
  | { type: "UNBLOCKED_DOFUS"; at: Coords }
  // ===== Player resources =====
  | { type: "ACTION_POINTS_LOST"; side: Side; amount: number }
  | { type: "ACTION_POINTS_GAINED"; side: Side; amount: number }
  | { type: "ACTION_POINTS_GAINED_FOR_TURN"; side: Side; amount: number }
  | { type: "ACTION_POINTS_USED"; side: Side; amount: number }
  | { type: "A_P_RESERVE_MODIFIED"; side: Side; mod: ValueModification }
  | { type: "A_P_RESERVE_USED"; side: Side; amount: number }
  | { type: "SPAWN_AREA_EXPANDED"; side: Side; newRange: number }
  | { type: "KAMA_RECEIVED"; side: Side; amount: number }
  // ===== AOE / Glyphs / Counters =====
  | { type: "NEW_A_O_E"; at: Coords; ownerSide: Side; aoeType: string }
  // A ground object (graine/tas d'os/buisson/glyphe/butin/cadeau/piège) leaves the cell
  // because a new object is being placed there: a cell never holds two ground objects, so the
  // arriving object replaces the old one. The counterpart of NEW_A_O_E: the FX layer shows the
  // old object vanish just before the new one appears ("le butin apparaît puis disparaît au
  // profit de la graine").
  | { type: "A_O_E_REMOVED"; at: Coords }
  | { type: "A_O_E_ACTIVATED"; at: Coords; kind?: string; byInstanceId?: number }
  | { type: "CARD_COUNTER_CREATED"; instanceId: number; initialValue: number; maxValue: number }
  | { type: "CARD_COUNTER_CHANGED"; instanceId: number; counterMod: ValueModification }
  // ===== Misc rituals / sub-systems =====
  // A real die roll (Ecaflip d6) at the exact moment of the roll. `at` = cell where the die
  // lands (target of the spell / cell of the carrier); with no cell, `instanceId` (the creature
  // concerned) then `side` (die at the portrait of the god, e.g. Dé du Chacha #514, which adds to
  // the hand) are the fallback seats. `spell` = a roll from a spell, so the original cast sequence
  // adds the MiddleImpact shockwave when the die lands; a property or creature roll (global script
  // "Dice Rolled") shows the die alone, 1.5 s.
  | { type: "DICE_THROW"; instanceId?: number; at?: Coords; side?: Side; spell?: boolean; result: number; sides: number }
  // A coin flip ("A OU B") at the moment of the flip. `face` = the resolved branch (pile = the
  // first, positive one, forced by Trucage). Seated like the die: `at` (cell of the carrier or of
  // the dead creature), otherwise `instanceId`, otherwise `side` (spells, all castTarget AlliedGod,
  // so the coin goes to the portrait of the god). The original global script "Dice Thrown": the
  // coin alone, 2.0 s, no cell wave.
  | { type: "COIN_FLIP"; instanceId?: number; at?: Coords; side?: Side; face: "pile" | "face" }
  | { type: "XELOR_CLOCK_UPDATED"; tick: number }
  | { type: "PHORZERKER_TRANSFORMATION"; instanceId: number; cardIdBefore: number; cardIdAfter: number }
  | { type: "EVOLUTIVE_CARD_XP_GAINED"; cardId: number; xpGained: number }
  | { type: "SINISTRO_SHOT"; instanceId?: number; dofusAt?: Coords; targetCell: Coords } // a Sinistro fires onto targetCell, from a creature (instanceId) or, for Sinistro #215, a host Dofus (dofusAt)
  | { type: "DOFUS_LIFE_HEALED"; dofusAt: Coords; heal: number; lifeMod: ValueModification } // a Dofus regains life (Soin de Dofus #650, Mot Reconstituant #491, Grougaloragran #409)
  | { type: "SINISTRO_ATTACHED"; dofusAt: Coords } // Sinistro #215 equipment placed on a host Dofus (beat of the spawn FX + sound)
  | { type: "SINISTRO_DESTROYED"; dofusAt: Coords } // Sinistro #215 equipment destroyed because its host Dofus was wounded
  | { type: "SEED_RESERVE_MODIFIED"; side: Side; mod: ValueModification }
  | { type: "SEED_PLANTED"; at: Coords; ownerSide: Side }
  | { type: "BLOCKED_ROW"; rowIndex: number; side: Side }
  | { type: "UNBLOCKED_ROW"; rowIndex: number }
  | { type: "RALLIED"; instanceId: number }
  | { type: "PERSISTENT_FX"; at: Coords; fx: string }
  // ===== Meta / debug =====
  | { type: "NOW" }
  | { type: "EFFECT_STOPPED"; reason?: string }
  | { type: "RUN_DIALOG"; dialogId: string }
  | { type: "RUN_EMOTE"; side: Side; emoteId: string }
  | { type: "TAG_PLAYED_BY_A_I"; tag: string }
  | { type: "TAG_PLAYED_BY_HUMAN"; tag: string }
  | { type: "ADMIN_COMMAND_EVENT"; command: string }
  | { type: "EXTERNAL_SCRIPT"; scriptId: string }
  // ===== Engine-end signal =====
  // GAME_WON is not in Ankama's enum (LAST_DOFUS_DESTROYED triggers the
  // end), but we emit it explicitly for our own state-machine clarity.
  // Kept as a clearly-non-Krosmaga additional event marked with a
  // distinct prefix so it stands out from protocol events.
  | { type: "GAME_WON"; winner: Side };

// Helper to build a ValueModification record.
export function vMod(before: number, after: number): ValueModification {
  return { valueBefore: before, modification: after - before, valueAfter: after };
}
