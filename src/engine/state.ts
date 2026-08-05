// Game state: the single source of truth for a match in progress.
//
// Pure data. Every gameplay function takes a GameState and returns a new GameState. We never
// mutate, which makes undo/replay/network sync simple.

import type { Coords, Side } from "./board";
import type { Trigger, God } from "../data/types";
// Imported for use within this module (GameState.log: GameEvent[]). Also
// re-exported at the bottom of the file as the canonical public name.
import type { GameEvent } from "./events";

// A creature currently on the board. Separate from Card because:
// - life/attack change during play
// - the same Card can be summoned several times (each gets its own instance)
// - properties can be added/removed at runtime (Root, Shield, Poison...)
//
// We store both `current` (changes with damage/buffs) and `base` (refreshed at start of turn for
// movement, or used to reset at game restart) values so the engine never needs to look up the
// original Card: it carries its own stats.
export interface CreatureInstance {
  instanceId: number;       // unique across the whole match
  cardId: number;           // points back to the Card definition (for art/name lookup)
  owner: Side;
  position: Coords;
  currentLife: number;
  currentAttack: number;
  movementLeft: number;     // how many cells it can still move this turn
  baseLife: number;         // life at full health
  baseAttack: number;
  baseMovement: number;     // refreshed on movementLeft at the start of each owner turn
  // The card's original printed stats, saved at summon and never changed by buffs. Silence ("annule
  // les modificateurs") sets the live stats back to these. (base* take buffs in over time; these do
  // not.)
  printedAttack: number;
  printedLife: number;
  printedMovement: number;
  // Armure (AR): "Protection supplémentaire ne pouvant pas être soignée". A pool that absorbs damage,
  // on top of currentLife: incoming damage drains it before life. Healing never restores it (heal only
  // refills life up to baseLife), and PierceArmor (Perce Armure) skips it entirely. Gained from
  // BoostArmor spells (Bouclier Féca, Compulsion, …). 0 by default. Not the same thing as Résistance
  // below.
  armor: number;
  // Portée (Range): "Distance d'attaque de cette invocation. Empêche ses déplacements après avoir
  // attaqué." 0 = melee (the default). When > 0 the creature is a shooter: during the advance it fires
  // at the nearest enemy in its lane up to `range` cells away (any creature in between blocks the
  // line), takes no counter, and stops once it has fired. Set from ShooterRangeData (RangeMax) at
  // summon; raised by BoostRange; cleared by Silence.
  range: number;
  // Résistance: "Réduit les dégâts encaissés de la valeur indiquée." A flat per-hit damage reduction
  // that is never used up: `resistance` is subtracted from every incoming damage instance (floored at
  // 0) before Armure or life apply. PierceArmor does not skip it (the in-game text says PierceArmor
  // only ignores armure). Set at summon from BoostResistanceData; 0 by default.
  resistance: number;
  // Vulnérabilité: "Augmente les dégâts subis par une invocation." The opposite of Résistance: a flat
  // per-hit damage increase added to every incoming damage instance before Résistance / Armure apply.
  // Adds up (Vulnérabilité:2 then :1 → 3). Given by spells like Talon d'Achille / Chronophagie; 0 by
  // default.
  vulnerability: number;
  // Gangraîne #1439 (BoostMovementPoisonData): "subit N dégât(s) par case parcourue quand elle se
  // déplace ou qu'elle charge." A flat self damage dealt for each cell crossed during a normal advance
  // / charge (not forced moves: push / teleport / attract do not go through the step loop). Adds up (a
  // second Gangraîne adds to it, as in the original game). 0 by default; only set by the spell.
  movementPoison: number;
  // Aura contributions currently applied to this creature from allied CHEF
  // auras ("CHEF: +N AT/PM à vos autres X"). Stored separately so they can be
  // stripped and recomputed whenever the board changes (a CHEF entering /
  // leaving, a creature being summoned / transformed / taking a new side).
  // Folded into currentAttack/baseAttack and baseMovement; kept here only so
  // recomputeAuras can subtract the previous contribution before re-summing.
  auraAttack: number;
  auraMovement: number;
  // Continuous range part from a conditional self boost (Evangelyne's "+2 portée si un autre membre de
  // la Confrérie du Tofu est en jeu"). Folded into `range`, removed and computed again by withAuras
  // like auraAttack; kept separate so the bonus can be taken back when the condition stops holding.
  auraRange: number;
  // Continuous Résistance contribution from a wounded-state keyword ("BLESSÉ :
  // gagne résistance N", Maude #1765). Folded into `resistance`, stripped and
  // recomputed by withAuras like auraAttack so it appears only while the
  // creature is wounded and vanishes the instant it is healed back to full.
  auraResistance: number;
  // Properties currently GRANTED to this creature by an allied CHEF property
  // aura (Dan Lemil #718 PierceArmor, Joris #307 Untargetable). Tracked
  // separately so withAuras can revoke them when the chief leaves without
  // stripping a property the creature has innately. Owned by withAuras; absent
  // (treated as empty) on a creature no aura ever touched.
  auraProperties?: Set<string>;
  // Properties currently granted to this creature by its own conditional keywords: conditional
  // initiative (Tristepin / Zorine #668), BLESSÉ (Grouilleux #309, Edass #43), conditional family
  // keywords (Korbax #379), seed-conditional keywords (Kolo Kolko). Same bookkeeping as
  // `auraProperties` and for the same reason: withAuras must revoke ONLY what it granted itself, so
  // a keyword CONFERRED FROM OUTSIDE (Initiative #464, Ravage #259, Cervelle de Iop #683, Eratz #83)
  // is never stripped when the carrier's own condition flips. A conferred keyword is permanent.
  // Owned by withAuras; absent (treated as empty) until it grants something.
  condProperties?: Set<string>;
  // Transient: this creature's life reached 0 because of DAMAGE (not a Destroy / Sacrifice /
  // capture / transform). Set by the damage handlers, read once by resolveDeathsAndWin to fire
  // the posthumous CONTRE COUP ("qu'elle survive ou non"), then cleared on any survivor. Never
  // outlives a death wave: a creature carrying it is either culled or healed back (flag stripped).
  diedFromDamage?: boolean;
  hasAttacked: boolean;     // can only attack once per turn
  properties: Set<string>;  // Root, Shield, Invisibility, Taunt, ...
  familyOverride?: string[];  // Pupuce #441 "devient de la famille de la cible" : remplace les familles de la carte (lu via famsOf au lieu de getCard(cardId).families)
  // Trigger-keyword effects snapshotted from the source Card at summon
  // time. The engine reads this directly (instead of looking up the Card
  // by id) when an event happens, keeps `resolveDeathsAndWin`,
  // `endTurn`, etc. free of any data-layer dependency.
  triggers: Trigger[];
  // The handCostMod this exact copy was played with, carried on the figurine so any lasting cost
  // modifier survives the trip board→hand:
  //   - a reduction "jusqu'à ce qu'elle soit défaussée" (Vampyro/Wagnar StampCostReduction) stays on
  //     the card when it is sent back to hand alive (it was not discarded). On a return after death
  //     (Polter Tofu / Baron Sramedi) the card did pass through the discard, so that external
  //     reduction is reset; the recover only keeps the positive self surcharge;
  //   - Polter Tofu's #358 per-copy +1 surcharge grows from max(0, this value) on death.
  // Optional (treated as 0 when absent).
  playedCostMod?: number;
  // How much conditional armor (from a ConditionalArmorWhileAlly effect, Rat Devil
  // #387, Boufton Noir #559) is currently folded into `armor`. Unlike auras, armor is
  // a consumable pool, so withAuras grants/removes the bonus only on the condition's
  // TRANSITION and stores the granted amount here to know the delta on the next
  // recompute (and to avoid re-granting an already-consumed pool while the condition
  // stays true). 0/undefined = nothing granted. Floored at 0 on removal.
  condArmorGranted?: number;
  // How much of a "+N AT tant qu'il est dans VOTRE camp" boost, which depends on the position
  // (Exécuteur Endeuillé #1425's ConditionalStatBoost inOwnCamp), is currently folded into
  // currentAttack/baseAttack/auraAttack. Set by withAuras step 2b and synced again per cell during the
  // end-of-turn advance (applyWalkOverPickups) so the boost drops the moment the creature leaves its
  // camp. 0/undefined = none.
  inCampAtk?: number;
  // Camille Kaz #785 (StrikeNextEnemyHardSummon): set once she has struck the next enemy
  // hard-cast summon, so her one-shot reaction never fires again. Optional/back-compat.
  strikeSpent?: boolean;
  // GARDE DU CORPS (Silas #320, Bould Erdash #300): the instanceId of a living bodyguard that took this
  // creature under its protection (its APPARITION picked this creature). While that bodyguard is
  // alive, damage aimed at this creature goes to it instead ("reçoit les dégâts à la place de celle
  // qu'elle protège"). The redirect checks the bodyguard is still alive, so the link breaks on its own
  // when it dies. Optional.
  protectedByGuard?: number;
  // Whether this creature has been réduite au silence. handleSilence strips its
  // abilities + stat modifiers (so afterwards it is mechanically a printed-stats
  // unit) and sets this flag, which the UI reads to stamp the "muted" overlay
  // (card_silenced.png on the card view, icon_silenced.png on the board
  // figurine). The flag is never auto-cleared, silence is permanent in
  // Krosmaga, except by a Transform, which rebuilds the creature as a fresh
  // token. Optional/back-compat (treated as false).
  silenced?: boolean;
  // Per-instance PA cost override for the card "once in play", used when a creature's in-play cost must
  // differ from its current cardId's printed cost. A Phorzerker born from a fusion (Énutrof + Phorreur)
  // or from Moumoune #989's CONTRE_COUP carries the source Énutrof's cost here, not token #800's
  // printed 3. Read through creatureCost(): effects that refer to the cost (Embaumement #1460) and the
  // board card tooltip use it. Cleared by transformCreature (a full rebuild takes the token's cost
  // unless set again). Optional (absent → fall back to getCard(cardId).cost).
  costOverride?: number;
}

// A Dofus base. Each side has 5 Dofus, one per row on the base column.
// 3 are "real" (rows 0, 2, 4 by default, see REAL_DOFUS_ROWS in board.ts):
// capturing 2 of the opponent's 3 real Dofus wins the match (you do not
// need to take all 3, see REAL_DOFUS_TO_WIN). The other 2 are "fake"
// decoys: they do not count toward victory, but destroying one grants
// +1 column of spawn range to the destroyer's side. Both kinds have the
// same hit points, can be attacked the same way, and physically block
// movement until broken.
export type DofusKind = "real" | "fake";
export interface DofusInstance {
  position: Coords;
  owner: Side;
  currentLife: number;
  kind: DofusKind;
  // The Dofus's COLOUR / type as a stable per-Dofus index (into the colour palette),
  // separate from real/fake (`kind`). Assigned at creation (placeholder: its initial
  // row; later: by the deck's god) and carried for life by the instance, so a
  // position-swap (Bluff #61) moves the Dofus with its colour (an Ivoire stays Ivoire,
  // it never inherits the destination row's colour). Optional for back-compat; the UI
  // falls back to the row index when absent.
  color?: number;
  // Whether this Dofus has been revealed (face-up). All Dofus start unrevealed
  // (undefined/false). A NÉCROME play may optionally reveal one of the caster's
  // own unrevealed Dofus for a second Orbe. Optional so existing literals/tests
  // stay valid; read with `!d.revealed`. (Reveal consequences come in a later
  // layer; for now revealing only grants the Orbe + flips this flag.)
  revealed?: boolean;
  // Lien de Sang #1495: the instanceId of an allied creature linked to protect this Dofus. While that
  // creature is alive, damage aimed at this Dofus goes to it instead ("elle subira les dégâts à sa
  // place"). Cleared on its own when the linked creature dies (the redirect checks it is still alive).
  // Optional.
  protectedBy?: number;
  // Artheon #1424: instanceId of the creature making this Dofus invulnerable ("ciblez un dofus,
  // il est invulnérable tant que cette invocation est en jeu"). While that creature is alive,
  // every damage/destruction site (combat, AoE, DamageData, DestroyDofus, SetDofusLife) skips
  // this Dofus (dofusInvulnerable() guards them). Implicitly cleared when the creature dies (the
  // guard re-checks it is still alive). Optional/back-compat.
  invulnerableBy?: number;
  // Orbe Doré #594: temporary invulnerability. Set to N when the owner casts "Confère invulnérable à vos
  // Dofus pour 1 tour"; dofusInvulnerable() returns true while > 0. Lowered at the start of the owner's
  // turn (so a value of 1 set on the owner's turn survives the opponent's combat phase and ends at the
  // owner's next turn). Optional.
  invulnerableTurns?: number;
  // Pissenlit Maléfique #1041: a one-hit SHIELD on this Dofus. The next time the Dofus would take
  // any damage (combat or effect, all routed through woundDofus), the hit is absorbed in full and
  // the shield is consumed (set back to false). Optional/back-compat.
  shielded?: boolean;
  // Sinistro #215: a Sinistro equipment is attached to this Dofus. At FIN_DE_TOUR of the
  // OWNER's turn it shoots forward on its row (1 dmg to the first enemy creature, else the
  // enemy Dofus of that row). Destroyed the instant this host Dofus takes any damage (the
  // wound clears it; the Dofus still takes the damage), see woundDofus. One per Dofus.
  sinistroAttached?: boolean;
  // Nécronomigore #700: a Nécronomigore equipment counting down on this Dofus. When present (!==
  // undefined) the equipment is attached (it takes the Dofus's single equipment slot, like
  // sinistroAttached). Starts at 6 and goes down at each of the owner's FIN_DE_TOUR; once it reaches 0
  // ("au bout de 6 tours") it stays at 0 and, at every owner FIN_DE_TOUR, deals 5 to all enemy Dofus.
  // It stays when the host is only wounded (unlike Sinistro): it lives on the Dofus, so it only goes
  // when the host is destroyed ("jusqu'à sa destruction"). Optional; read with `!== undefined`.
  necronomigoreCounter?: number;
}

// A real Dofus that has been destroyed (captured). Kept as a trophy record so
// the UI can stack the captured eggs on the destroyer's card-pool. We only store
// what the trophy needs to render the exact same egg: the colour palette index
// and the owner side (which side lost it → picks the egg's god theme and which
// pool shows it). Fake Dofus are not recorded (only "vrais dofus").
export interface CapturedDofus {
  owner: Side;   // the side that lost this Dofus (its egg keeps that side's god theme)
  color: number; // colour palette index → dofus_<colour>.png (kept consistent with the live egg)
}

// A Dofus slot that has been destroyed (real or fake). The original leaves a
// persistent "destroyed" FX on the emptied wall cell for the rest of the match
// (DofusView.InstantiateDestroyedFx → GetDestroyedFx: white smoke for a real
// Dofus, black for a fake). We keep the record here so the smoke renders from
// state in every view (live, online guest, replay viewer, hot-seat flip).
export interface DestroyedDofus {
  position: Coords; // the wall cell where the Dofus stood (x=0 enemy / x=9 ally)
  owner: Side;      // the side that owned the destroyed Dofus
  kind: "real" | "fake"; // drives the smoke colour (white vs black)
}

// A player's per-match state: hand, deck, AP, life total (via Dofus), etc.
export interface PlayerState {
  side: Side;
  // The deck's god (Iop, Cra...). Public / info-fair for both sides, the foe's
  // god is shown at match start. "None" for a neutral-only or unknown deck.
  // Optional for back-compat; createInitialState always sets it (from opts.gods
  // or derived from the deck's cards). Consumed by the AI match-up encoding.
  god?: God;
  // Deck is the draw pile. Top of deck is the last element (pop()).
  deck: number[];           // card ids
  hand: number[];           // card ids currently in hand
  // Per-hand-slot cost modifier, aligned 1:1 with `hand` (same length, same
  // index). 0 = no change; negative = cheaper (e.g. Cupidité stamps −1 on
  // every card currently in hand). The effective cost of hand[i] is
  // max(0, card.cost + handCostMods[i]). New draws enter with 0, so a hand
  // reduction never carries over to future draws.
  handCostMods: number[];
  // Per-deck-slot cost modifier, aligned 1:1 with `deck` (same index). The deck
  // analogue of handCostMods: lets a discount accrue on cards still in the deck
  // (HORDE, each HORDE creature death stamps −1 on every HORDE card in hand and
  // deck). On draw, the deck slot's mod transfers into handCostMods, so the card
  // keeps it; on discard the card drops out of hand/deck so the mod is lost (a
  // recovered card re-enters at 0). Optional + read with `?? []` for back-compat;
  // treated as all-zero when absent or length-mismatched (so a stale array is
  // safely ignored rather than misaligned).
  deckCostMods?: number[];
  // Temporary per-hand-slot surcharge, aligned 1:1 with `hand` like handCostMods, but
  // it EXPIRES at the end of this player's next turn (Ralentissement #188: "+2 PA au
  // coût des cartes de la main adverse courante pendant 1 tour"). Stored on the
  // surcharged player; cleared in endTurn when that player's own turn ends, so a
  // surcharge stamped on the enemy during the caster's turn survives the caster's
  // endTurn and lifts only after the enemy has had their turn. effectiveCost /
  // cheapestHandSlot add it on top of handCostMods. Cards drawn after the stamp are not
  // surcharged: draws append nothing here, so the new slot reads `?? 0`. Optional /
  // back-compat: absent or short → 0 for the missing slots.
  handCostTempMods?: number[];
  discard: number[];        // played/discarded card ids
  // Cards removed from the game (not the same as the discard). A NÉCROME creature is banished here when
  // it dies instead of going to the discard pile ("il ne va pas en défausse, la carte est bannie").
  // Optional so older PlayerState literals/tests stay valid; read with `?? []`.
  banished?: number[];
  // SPECIAL token discard pile, distinct from both `discard` and `banished`. Every
  // token card (isToken, summoned creatures, board objects, the Fléau #757) lands
  // here instead of the normal discard whenever it would leave play (board death,
  // spell cast, hand/draw overflow, mill, bounce…). It is inaccessible to every
  // effect and spell: no recovery/tutor/banish/discard-search path (Indie,
  // RecoverFromDiscard, BanishDiscard…) ever reads it, only the normal `discard`.
  // Tokens are thus permanently removed from any recursion loop. Optional so older
  // PlayerState literals/tests stay valid; read with `?? []`.
  tokenDiscard?: number[];
  // Minimum value of this player's dice rolls for the current turn (Dé Pipé #535:
  // "vos jets de dé ne peuvent être inférieurs à 3"). 0/undefined = no floor. Set
  // when Dé Pipé resolves, cleared at the player's endTurn (like coinForcedPile).
  diceFloor?: number;
  // Active traps (Sram) in this player's hand. A placer spell (Piège Mortel #624 …) drops the matching
  // "Activé" card (#681 …) here with a turn counter: the holder must play it within `counter` of their
  // own turns, otherwise at their endTurn each of their Dofus takes `penalty` and the card leaves the
  // hand. One entry per trap card delivered. Optional.
  // Boufballe #1137 uses the same counter but with `buffEnemy` instead of `penalty`: when it runs out
  // the holder's enemy creatures gain a permanent stat buff (and the card leaves the hand). Playing it
  // sends it to the opponent's hand (new counter).
  activeTraps?: { cardId: number; counter: number; penalty: number; buffEnemy?: { attack: number; armor: number } }[];
  // Repos Éternel #20: "Durant ce tour, ne dépensez pas de PA pour jouer vos cartes. À la place
  // bannissez des cartes de votre défausse." While set, playCard pays each card's cost by banishing
  // that many discard cards (no AP spent), and canPlayCard checks the discard size instead of AP.
  // Per-turn flag, set when Repos Éternel resolves, cleared at the player's endTurn (like
  // coinForcedPile).
  discardPaysCost?: boolean;
  // Discount waiting for the next card this player plays (La Folle #481 / Emma Cabre #963: "Réduit de N
  // PA le coût de votre prochaine carte jouée"). effectiveCost subtracts it from every hand card;
  // playCard uses it up (resets to 0) when any card is played. 0/undefined = none. Stays until used
  // (not tied to a turn).
  nextCardDiscount?: number;
  // Persistent class cost AURA (Nouvelle Vague #1213: "Les cartes Fécas de votre jeu
  // coûtent 1 PA de moins"). Maps a god → total PA reduction applied to every card of
  // that god, read dynamically by effectiveCost. Unlike a per-card StampCostReduction
  // (lost when a card hits the discard), this is an aura: it follows the class, so a
  // Feca card keeps the discount through any discard/redraw cycle and a Feca card drawn
  // later is discounted too. Stacks if cast more than once. Absent = none.
  godCostReductions?: Record<string, number>;
  ap: number;               // action points available this turn
  maxAp: number;            // grows by 1 per turn up to some cap
  // Action point reserve: a stored pool separate from `ap` that stays across turns (it is not
  // refilled or reset at turn start). Filled by the AP prism (+1) and spent only by cards with a
  // reserve cost (ApReserveCost / AllAPReserveConsumption in the original game). No reserve-cost card
  // is implemented yet, so for now it only adds up and is displayed, but the resource is tracked
  // correctly.
  apReserve: number;
  // Réserve de graines (Sadida), a banked counter of PLAYABLE seeds, analogous
  // to the AP reserve but capped at SEED_CAP (10). Filled by AddSeeds effects
  // ("Ajoute N Graines à votre réserve de graines"). It is the source from which
  // seeds are planted (manually, 1 PA each) onto empty cells of one's own camp →
  // each plant moves one unit from here onto the board as a GameState.seeds entry.
  // Distinct from seeds already on the board ("en jeu"): the reserve only counts
  // the playable ones still in hand-of-seeds. The UI shows it only when > 0. 0 by
  // default.
  seedReserve: number;
  extraSpawnRange: number;  // Bastion extends this
  // Trucage: while true, this player's coin flips ("A OU B") land on Pile (the
  // positive / first branch). Set for the ACTIVE turn only; cleared at the start
  // of endTurn so it never reaches the creature-movement phase.
  coinForcedPile?: boolean;
}

// A prism is a board object sitting on a cell of a side's base summon
// column (x=8 ally / x=1 enemy), one per row (y=0..4). It activates when
// that side summons a creature onto its cell, granting a one-shot bonus,
// then is consumed. When the board has zero prisms left (both sides), all
// 10 respawn at the start of the next turn. See engine/rules.ts for the
// placement pattern and activation logic. Mirrors AoeType.Prism /
// AoeSubType (Prism_AP / Prism_Draw / Prism_Damage) in the bindata.
export type PrismKind = "ap" | "fleau" | "draw";
export interface PrismInstance {
  position: Coords;
  owner: Side;
  kind: PrismKind;
}

// A seed planted on the board (Sadida "Graine"). A board object sitting on one
// empty cell, with an owner (the side that planted / produced it). Owner is what
// the step-effect keys off, not the camp the seed sits in: when a creature walks
// onto a seed, an allied seed (same owner as the walker) grants it +1 AR, an
// enemy seed (other owner) deals it 1 damage, then the seed is consumed. At most
// one seed per cell, and a seed and a creature never share a cell. Manual plants
// only land in the planter's own territory (cols 5-8 ally / 1-4 enemy); cards may
// place seeds elsewhere. Counted by "Graines en jeu" effects (distinct from the
// reserve). Mirrors AoeType.Seed in the bindata.
export interface SeedInstance {
  position: Coords;
  owner: Side;
}

// A Tas d'Os (pile of bones) on the board (Chafer). A board object on one cell, owned by a side.
// Created either by playing the Tas d'Os card (#691) onto an empty cell of one's camp, or left behind
// by a creature with the "TAS D'OS" keyword when it dies (on its death cell). Walk-over / summoned
// onto (like a seed): an allied Chafer gains +1 AT +1 AR (permanent, adds up) and uses it up; any
// other creature that lands there (an allied non-Chafer or any enemy) just destroys it.
export interface TasDOsInstance {
  position: Coords;
  owner: Side;
}

// A Piège (trap) placed on the board (Sram). A board object on one cell, owned by the side that placed
// it (in its own camp). Walk-over: an enemy creature stepping onto it takes `damage` and the trap is
// used up; an allied creature stepping onto it picks it up, the trap card (`cardId`) goes back to the
// owner's hand and the trap is used up. Visible to both. Only #101 Bombe (damage 2) uses it for now
// (the other board traps are turned off).
export interface TrapInstance {
  position: Coords;
  owner: Side;
  cardId: number; // the trap card (returned to hand when an ally picks it up)
  damage: number; // dealt to an enemy that walks onto it
}

// A Buisson (bush) planted on the board (Sadida). A board object on one cell, made by transforming a
// seed (Buisson #214 / Selk Ator #108). It acts as a spawn point for its owner: that side may summon a
// creature directly onto the Buisson's cell, even outside the normal spawn zone. The Buisson is used
// up (removed) the moment a creature is summoned onto it. Same as AoeType.Bush / "ActAsSpawnPoint" in
// the card data (#240).
export interface BushInstance {
  position: Coords;
  owner: Side;
}

// A Butin (treasure) placed on the board (Enutrof). A board object on one cell, with an `owner` = the
// side that placed it (for the "vos Butins / Butin allié" card effects). Unlike seeds, anyone can pick
// it up: any creature (either side) that is summoned onto it or walks onto it picks it up. The Butin
// is used up and the picker's side gains a random reward card (1/3 Pelle #944, 1/3 Élixir de
// Jouvence #798, 1/3 Pioche Antique #1252). Same as AoeType.Loot in the card data (#789).
export interface ButinInstance {
  position: Coords;
  owner: Side;
}

// A Cadeau de Nowel (#1042) placed on the board. A board object on one cell, with an `owner` = the
// side that placed it (Reine de Nowel #703's side). Unlike a Butin the reward goes to the creature
// that uses it, not to the picker's hand: passing over it uses it up and rolls one equally likely
// outcome, +1 AT, +1 AR, +1 PM, or 1 damage (25% each; not changed by Dé Pipé, since it is
// "équiprobable"). Using it counts as an allied dice/coin roll for the picker's side, so it fires that
// side's roll reactions (Sentinelle Affûtée #1606 +1/+1, Atout Caché #1201 −1 PA). Not in the card
// data (rebuilt from the rules as described). May change.
export interface GiftInstance {
  position: Coords;
  owner: Side;
}

// A Glyphe (rune) placed on the board (Féca). A board object that stays, on one empty cell of its
// owner's camp. A GLYPHE spell places it and applies its "quand il est joué" effect once to the 3×3
// around it; the rune then stays in play, counted by "Glyphes en jeu" / NumberOfGlyphsValue and used
// by step-on / row effects. Same as AoeType.Glyph in the card data.
export interface GlyphInstance {
  position: Coords;
  owner: Side;
}

// A blocking interactive pick, set when an APPARITION trigger / spell
// needs the player to choose an external target before resolution can
// continue. The UI shows a targeting overlay and routes the next click
// to `resolvePendingAction` instead of the normal play flow.
// While set, the player cannot end their turn or play other cards.
export interface PendingAction {
  // Side that owes the pick (= owner of the trigger that fired).
  side: Side;
  // Description of what is being picked (used for hint text in the UI).
  prompt: string;
  // What kind of target is legal:
  //   - "enemy_creature" / "ally_creature" / "any_creature"
  //   - "any_dofus"
  //   - "any_cell"
  filter:
    | "enemy_creature"
    | "ally_creature"
    | "any_creature"
    | "any_dofus"
    | "any_cell"
    | "own_seed" // a cell carrying one of the picker's own planted seeds (Sadida seed-transform picks)
    | "own_empty_camp" // an empty cell of the picker's own territory (Melita's "invoquez un Glyphe dans votre camp")
    | "own_summon_cell" // a free cell where the picker may summon a creature, spawn zone (+ Bastion extension) or own Buisson (Amalia chooses where her poupée lands)
    | "any_prism" // a cell carrying a prism, any side (Patek Tag's "Détruisez un prisme")
    | "ally_prism" // a cell carrying one of the picker's own prisms (Kibri #735 "Sacrifiez un de vos prismes")
    | "enemy_prism" // a cell carrying one of the OPPONENT's prisms (Malocac #85 "Récupérez un prisme adverse")
    | "own_prismless_first_col" // an empty cell of the picker's own first column (x=8 ally / x=1 enemy) whose prism is missing, Lou 1★ #572 "faites réapparaître un prisme allié" (pick where)
    | "board_object" // a cell carrying a Seed/Trap(Bombe)/Butin/Glyphe/Tas d'os/Cadeau de Nowel, any side (Tournesol Sauvage #1082 "détruisez … en jeu")
    | "ally_glyph" // an empty cell with one of the picker's own Glyphes (Téléglyphe #1735 "sur un glyphe allié")
    | "ally_dofus" // a cell carrying one of the picker's own living Dofus (Ush #426 "un autre dofus allié")
    | "ally_dofus_no_equipment" // a cell carrying one of the picker's own living Dofus that carries no equipment yet (Diod Dewit #337: place a Sinistro on an allied Dofus "sans équipement")
    | "ally_phorreur_or_unrevealed_dofus" // a cell carrying an allied Phorreur creature or one of the picker's own unrevealed Dofus, the combined NÉCROME+Phorzerker secondary pick (Championne Périmée #634 / Champion Croulant #899): click the Phorreur to FUSE, the Dofus to reveal for a 2nd Orbe
    | "enemy_dofus" // a cell carrying an enemy living Dofus (Ush #13 "un autre dofus adverse")
    | "destroyed_ally_dofus" // an empty cell of the picker's own Dofus wall, where one of their Dofus was destroyed (Ush #100 "la position d'un dofus allié détruit")
    | "ally_unrevealed_dofus" // a cell carrying one of the picker's own, still-UNREVEALED Dofus (NÉCROME optional reveal)
    | "enemy_unrevealed_dofus" // a cell carrying an enemy, still-UNREVEALED Dofus (Kerubim "dévoilez un dofus adverse", pick ciblé #333/#378)
    | "own_cell_no_unit" // an empty cell of the picker's own territory (no living creature/Dofus; board objects allowed), TeleportToCell destination (Téléportation #119)
    | "wounded_enemy_creature" // a cell carrying a wounded enemy creature (currentLife < baseLife), Lame Émoussée #1177 2nd pick
    | "any_summon_but_statue" // any living creature except a Mur (Statue), Fulgurance #14 2nd pick (original SecondaryTarget AnySummonButStatue)
    | "ally_dofus_unlinked"; // one of the picker's own living Dofus not already protected by a living creature, Lien de Sang #1495 2nd pick (original SecondaryTarget AlliedDofusWithoutDamageReflection)
  // Snapshot of the effects still to apply (anything that was not a
  // self-effect on the triggering creature). When the player picks a
  // target, the engine runs `applyEffects` over this list with the
  // chosen cell as `targetCell`.
  pendingEffects: import("../data/types").Effect[];
  // Which creature this came from (so its instanceId can still be used
  // as sourceInstanceId, and so we know the caster's side for filter
  // resolution).
  sourceInstanceId: number;
  // For TWO-target spells (SwapAttack / SwapArmor): the first creature the
  // player already picked. The next click is the second creature, and
  // resolvePendingAction swaps the stat between the two. Absent for the
  // ordinary single-pick (trigger) flow.
  firstTarget?: Coords;
  // Mandatory two-click spells (the twoStepPending family: swaps, Détournement, teleports, Bluff, Lien
  // de Sang, Punition… plus Trouvaille's multi-butin picks): the play is held. The 1st click commits
  // nothing (no AP paid, card still in hand, no log, no ON_PLAY reaction). The final pick commits the
  // whole cast in one step (resolvePendingAction enters playCard again with `commitHeld`); clicking a
  // cell that is not a valid next pick, or clicking off the board, simply takes it back. The
  // optional-secondary trio (#576/#1177/#1350) is exempt (committed cost), and so are the deferred
  // summons (already cancellable through summonAfter).
  heldSpell?: { cardId: number };
  // Deferred arrival reactions: when the APPARITION of the creature just placed opens a targeting, the
  // bystanders' reactions to its arrival (ON_PLAY "quand vous jouez une invocation", ENTERS_PLAY "quand
  // une X entre en jeu", the Truche #37 that changes row, Camille Kaz #785's armed strike) do not fire
  // until the pick is closed: the entrant's effect lands first (Black Wabbit #495's targeted damage hits
  // the Truche before its reactive move). Stamped by fireApparitionPhase; fired by
  // fireDeferredArrivalReactions when it closes (resolvePendingAction wrapper, or landDeferredSummon on
  // a decline). `playedCardId` is only there for a card played from hand (arms ON_PLAY + Camille).
  arrivalReactionsAfter?: { entrantId: number; side: Side; playedCardId?: number };
  // NÉCROME played from the hand (deferredNecrome / phorzerkerNecrome): the card comes from a real play
  // from the hand. The landing skips the arrival reactions (skipArrivalReactions); the settle of the
  // reveal pick fires them only once, after the held APPARITION. firePendingApparition reads this flag
  // to arm ON_PLAY/Camille. Fixes the double ENTERS_PLAY (Welsh +2).
  apparitionPlayedFromHand?: boolean;
  // True for trigger pendings (APPARITION "Donnez +X à une invocation"): the
  // player may DECLINE by clicking any non-target cell, and the source creature
  // can never be targeted by its own effect.
  optional?: boolean;
  // Optional attack ceiling on the legal targets (Moskito: "une de vos
  // invocations ayant 3 AT ou moins"). When set, only creatures whose
  // currentAttack ≤ maxAttack qualify, enforced by cellMatchesFilter and the
  // valid-target enumeration.
  maxAttack?: number;
  // Optional attack FLOOR on the legal targets (Pissenlion #1045: "une invocation
  // ayant au moins N AT"). Only creatures with currentAttack ≥ minAttack qualify.
  minAttack?: number;
  // Optional family restriction on the legal targets (Wa Wabbit #59: "un de vos
  // wabbits"). Only creatures whose families include this one qualify.
  family?: string;
  // Optional zone restriction: "ownCamp" = only creatures in the picker's own
  // territory qualify (Arakne "une invocation située dans votre camp").
  zone?: "ownCamp";
  // FRATRIE / deferred targeted APPARITION: the creature is placed only after its targeting pick
  // resolves (or is declined), never before. So while this is set no AP is spent and no prism/butin/tas
  // d'os/graine is picked up until the player has chosen the target. The card is out of the hand but
  // its `cost` is still unpaid (taken by placeDeferredSummon at landing) and `playedCostMod` is carried
  // onto the landed figurine. `cost` always carries the unpaid AP (refunded where the summon is
  // deferred, charged again by placeDeferredSummon at landing) so an off-board cancel can give the card
  // back to the hand with the AP intact. `deferredNecrome` marks a held NÉCROME so its base Orbe is only
  // given at landing.
  summonAfter?: { cardId: number; cell: Coords; owner: Side; cost?: number; playedCostMod?: number; deferredNecrome?: boolean };
  // Set on a summonAfter pick that defers the creature's own targeted APPARITION (as
  // opposed to the FRATRIE keyword's mill): resolvePendingAction lands the creature, then
  // auto-resolves the re-opened APPARITION pick with the target chosen here, so the
  // player only clicks once. The creature appears on the board only at that point.
  deferredSummon?: boolean;
  // NÉCROME deferred summon (any hand-played Necrome with an unrevealed Dofus or, for #634/#899, a
  // fusable Phorreur): the creature is held off the board until the reveal/combined pick settles,
  // the base Orbe is granted only at landing (decline-on-board or a valid pick), never on off-board
  // cancel. Routes through the same summonAfter machinery as the other deferred summons.
  deferredNecrome?: boolean;
  // NÉCROME Dofus reveal: this pick was opened before the source's APPARITION effect, which must wait
  // until the reveal is resolved or declined. Carries the original `fireApparition` flag; when the pick
  // settles, fireApparitionPhase runs for sourceInstanceId (true = played from hand → fire its
  // APPARITION; false = summoned by an effect → only the reactions).
  fireApparitionAfter?: boolean;
  // Trouvaille #1382 ("posez N butins"): a multi-cell placement deferred like a targeting effect.
  // Nothing is placed and no AP is spent until the last cell is chosen. `cells` collects the cells
  // picked so far (the cast cell is the first); once it reaches `total` the play commits. Hand plays now
  // use the held flow (`heldSpell` set, `cost` unused at 0, playCard `heldButinCells` pays at commit);
  // `cost` is only charged by the older committed path.
  butinCast?: { cardId: number; cost: number; cells: Coords[]; total: number };
  // PHORZERKER capacity: this optional pick (opened just before the source Enutrof's APPARITION,
  // filter "ally_creature" + family "Phorreur") fuses the picked Phorreur into the source. On a
  // valid pick resolvePendingAction transforms the Enutrof into a Phorzerker (#800) with the two
  // creatures' AT/PV summed (Enutrof's PM kept) and BANISHES the Phorreur, and the Enutrof's own
  // APPARITION never fires. On decline, fireApparitionAfter fires the normal APPARITION.
  phorzerkerFusion?: boolean;
  // Combined NÉCROME+Phorzerker pick (Championne Périmée #634 / Champion Croulant #899): the source
  // Énutrof is already placed (Necrome placed it + granted the base Orbe). resolvePendingAction
  // branches on the clicked cell, a Phorreur → POST-placement fuse (no APPARITION); an unrevealed
  // Dofus → reveal for a 2nd Orbe + APPARITION; a decline → APPARITION (the Énutrof plays, not cancelled).
  phorzerkerNecrome?: boolean;
}

// Pre-game redraw phase. Before turn 1, each player in turn order looks at
// their opening hand (3 cards) and may send any subset back into the deck;
// those cards are shuffled in and an equal number are redrawn, so the hand
// stays at 3. Player 2 then gets a 4th card (not chosen) plus 1 banked AP as
// the going-second compensation. While `mulligan` is set the match has not
// started (turn 0) and normal play is blocked, the UI shows the redraw panel.
export interface MulliganState {
  current: Side;   // who is choosing right now
  first: Side;     // player 1 (goes first; no compensation)
  second: Side;    // player 2 (gets the extra card + 1 reserve AP)
}

export interface GameState {
  turn: number;                  // 1, 2, 3... (0 during the mulligan phase)
  activeSide: Side;              // whose turn is it?
  // Who took turn 1 (the cheaper deck; no going-second bonus). Persists the whole
  // match, unlike mulligan.first which is cleared after the redraw, so the AI can
  // encode the first/second-player advantage at any point. Optional for back-compat;
  // set by createInitialState.
  firstSide?: Side;
  // Seedable RNG state (mulberry32, one uint32, see engine/rng.ts). Every
  // source of chance draws from this, so a game is reproducible from its seed:
  // copy the state → copy this number → identical future. Foundation for the
  // AI's game simulation / self-play. Advanced by shuffles, Dofus layout,
  // mulligan redraw, dice, random picks.
  rng: number;
  // Non-null only during the pre-game redraw; null once the match is underway.
  mulligan: MulliganState | null;
  players: Record<Side, PlayerState>;
  creatures: CreatureInstance[];
  dofuses: DofusInstance[];
  // Real Dofus destroyed so far (trophies). Appended in resolveDeathsAndWin as
  // each real Dofus is captured; the UI stacks them on the destroyer's card-pool.
  // Optional/back-compat (treated as [] when absent, older snapshots/tests).
  capturedDofuses?: CapturedDofus[];
  // Every Dofus slot destroyed so far (real + fake), persistent smoke markers
  // on the emptied wall cells. Appended in resolveDeathsAndWin alongside
  // capturedDofuses. Optional/back-compat (absent = []). See DestroyedDofus.
  destroyedDofuses?: DestroyedDofus[];
  // Prisms currently on the board (both sides). Consumed on summon,
  // respawned (the full home set) at the start of any turn when none remain.
  prisms: PrismInstance[];
  // Seeds planted on the board (both sides). Each carries its owner; consumed
  // when a creature walks onto its cell (allied seed → +1 AR, enemy seed → 1
  // damage). Distinct from PlayerState.seedReserve (the playable, un-planted
  // pool). Optional so older scenarios/snapshots that predate seeds still
  // type-check (treated as []).
  seeds?: SeedInstance[];
  // Tas d'Os on the board (both sides). Created by the Tas d'Os card or left by a
  // "TAS D'OS"-keyword creature on death; consumed when a creature lands on it (an
  // allied Chafer is buffed, anyone else destroys it). Optional (treated as []).
  tasDOs?: TasDOsInstance[];
  // Buissons on the board (both sides). Each acts as a spawn point for its owner
  // (validSpawnCells includes them) and is consumed when a creature lands on it.
  // Optional for back-compat (treated as []).
  bushes?: BushInstance[];
  // Glyphes (Féca runes) on the board (both sides). Placed by GLYPHE spells;
  // persist. Optional for back-compat (treated as []).
  glyphs?: GlyphInstance[];
  // Butins (Enutrof treasures) on the board. Placed in a side's camp; picked up by
  // any creature summoned/walking onto them → random reward to the picker. Optional
  // for back-compat (treated as []).
  butins?: ButinInstance[];
  // Pièges (Sram traps) on the board. Placed in a side's camp; an enemy walking
  // onto one takes damage, an ally walking onto one picks it up (card → hand).
  // Optional for back-compat (treated as []).
  traps?: TrapInstance[];
  // Cadeaux de Nowel (#1042) on the board. Scattered across the whole board (minus
  // the two spawn columns) by Reine de Nowel #703's APPARITION. Pickup is open: any
  // creature (either side) that passes over / is summoned onto one consumes it and
  // rolls a random equiprobable outcome (+1 AT | +1 AR | +1 PM | 1 damage). That roll
  // also fires the picker side's roll reactions (Sentinelle Affûtée #1606 / Atout
  // Caché #1201). See GiftInstance + the Reine de Nowel notes in rules.ts. Optional
  // for back-compat (treated as []). SUSCEPTIBLE D'ÉVOLUER (mécanique très particulière).
  gifts?: GiftInstance[];
  nextInstanceId: number;        // counter for creature instanceIds
  // Winner is null until someone's Dofus base collapses.
  winner: Side | null;
  // Event log, useful for replays, network sync, and debugging.
  log: GameEvent[];
  // Blocking interactive prompt, see PendingAction. While non-null the
  // active player cannot play cards / end turn; they must resolve this
  // first (or via a future "cancel" UI we will add later).
  pendingAction: PendingAction | null;
  // Temporary stat modifiers awaiting reversal ("jusqu'à votre prochain tour",
  // Sénilité). Each is undone at the start of `expireSide`'s turn. Optional so
  // existing scenarios that do not set it still type-check (treated as []).
  pendingReversions?: TempReversion[];
}

// A temporary modifier that reverts at the start of `expireSide`'s next turn.
//  - "stat": re-apply `amount` (the inverse delta) to each still-living creature
//    in `instanceIds` (Sénilité).
//  - "control": give `instanceId` back to `originalOwner` (Fiole de Psykoz,
//    "prenez le contrôle … jusqu'au tour de votre adversaire").
export type TempReversion =
  | {
      kind: "stat";
      expireSide: Side;
      field: "attack" | "armor" | "movement" | "range" | "life";
      amount: number;
      instanceIds: number[];
    }
  | {
      kind: "control";
      expireSide?: Side;   // turn-based expiry (Fiole de Psykoz "jusqu'au tour adverse")
      linkedTo?: number;   // Or death-linked: reverts when this creature dies (Anathar #316 "tant qu'il est en vie")
      instanceId: number;
      originalOwner: Side;
      // Miranda #107: control only ends if the source dies or is transformed (neither silence nor Marline
      // breaks it). The identity (cardId) is saved when control is taken, to detect a transformation at any
      // time (resolveDeathsAndWin):
      //  - `sourceCardId`: if the source (linkedTo) changes cardId → transformed → control broken, the
      //    creature goes back to its camp (on top of the "source dead" case already handled).
      //  - `seizedCardId`: if the controlled creature (instanceId) changes cardId → it is transformed → it
      //    stays with the controller for good (reversion removed, never given back). This wins over the
      //    break by the source (Marca Or case, sweep: the controlled creature transformed before the source
      //    keeps its new camp).
      sourceCardId?: number;
      seizedCardId?: number;
    };

// Game event union, re-exported from ./events.ts (canonical definition
// kept there so it stays close to the Krosmaga protocol mapping).
export type { GameEvent } from "./events";
