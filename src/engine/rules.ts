// Turn loop and top-level game rules.
//
// Pure logic: each function takes a GameState and returns a new GameState. No mutation.

import type { Card, Effect, PlayerCondition, AoeScope, DynamicValue, God, Trigger } from "../data/types";
import {
  BOARD_COLS,
  BOARD_ROWS,
  REAL_DOFUS_ROWS,
  REAL_DOFUS_TO_WIN,
  isSpawnCell,
  isAlliedTerritory,
  isImmovable,
  cannotAdvance,
  dofusSideAt,
  sameCoords,
  type Coords,
  type Side,
} from "./board";
import type { CreatureInstance, GameEvent, GameState, PendingAction, PlayerState, DofusInstance, TempReversion, SeedInstance, TrapInstance } from "./state";
import { creatureAt, dofusAt, isCellFree, validSpawnCells } from "./queries";
import { getCard, isKnownFamily, summonsOfFamily, summonsOfCost, famsOf, registryGeneration } from "./cardRegistry";
import { applyEffects, effectRequiresTarget, effectTargetFilter, bumpStat, slideCreatureBack, resolveDynamicValue, dofusInvulnerable, transformCreature, woundDofus, sinistroShot, necronomigoreFire } from "./effects";
import { Rng, randomSeed } from "./rng";
import type { TriggerType } from "../data/types";

// Cap on AP growth, original Krosmaga tops out around 10.
export const MAX_AP = 10;

// Cap on the seed reserve (Sadida "réserve de graines"). Adders never push it past this;
// anything above is lost.
export const SEED_CAP = 10;

// AP cost to plant one seed from the reserve on a board cell by hand (on top of using one
// reserve seed).
export const SEED_PLANT_COST = 1;

// Opening hand drawn before the mulligan. Both players start by looking at
// this many cards; player 1 keeps 3, player 2 gets a 4th after the redraw.
export const MULLIGAN_HAND = 3;

// Banked AP granted to the player going second, claimable on their first turn.
export const SECOND_PLAYER_RESERVE = 1;

// Legacy single starting-hand size (kept for reference / any non-mulligan path).
export const STARTING_HAND = 4;

// Cap on how many cards a player can hold in hand. Drawing past this cap
// "burns" the card straight into the discard (not lost, just not in hand).
export const MAX_HAND = 10;

// Each Dofus has this much life. Krosmaga's standard Dofus is 5 PV (verified
// against the original game). Real game has Dofus with unique abilities
// (Ocra, Ebony, Ivory...), we will model those later.
export const DOFUS_LIFE = 5;

// Helper: other side.
function other(side: Side): Side {
  return side === "ally" ? "enemy" : "ally";
}

function mkPlayer(side: Side, deck: number[]): PlayerState {
  return {
    side,
    deck: [...deck],
    deckCostMods: deck.map(() => 0), // parallel to deck (HORDE discount accrual)
    hand: [],
    handCostMods: [],
    discard: [],
    banished: [],
    tokenDiscard: [],
    ap: 0,
    maxAp: 0,
    apReserve: 0,
    seedReserve: 0,
    extraSpawnRange: 0,
  };
}

// HORDE PA discount: stamp −`n` onto every HORDE card in this player's hand and
// deck (the two parallel cost-mod arrays). The stamp accrues negatively and is
// floored at 0 by effectiveCost; a card keeps it until it leaves hand/deck for the
// discard (a recovered card re-enters at 0). Falls back to zero-mods when the deck
// array is absent/length-mismatched so a stale array can never misalign.
function stampCostReduction(p: PlayerState, matches: (id: number) => boolean, n: number): PlayerState {
  if (n <= 0) return p;
  const handCostMods = p.hand.map((id, i) => (p.handCostMods[i] ?? 0) - (matches(id) ? n : 0));
  const baseDeckMods = p.deckCostMods && p.deckCostMods.length === p.deck.length ? p.deckCostMods : p.deck.map(() => 0);
  const deckCostMods = p.deck.map((id, i) => (baseDeckMods[i] ?? 0) - (matches(id) ? n : 0));
  return { ...p, handCostMods, deckCostMods };
}

// Take a card and its accumulated cost mod (Vampyro/Wagnar #697/#779, HORDE) out of the deck at
// `index`, together, so `deck` and `deckCostMods` never drift in length or order. Fixes a stale or
// missing deckCostMods to an aligned array of zeros first, so it is always safe to call. Pass the
// returned costMod to addCardToHand so a tutored/drawn card keeps its reduction ("jusqu'à ce
// qu'elles soient défaussées"). Used by every deck→hand / deck→discard removal so the length check
// of drawCardFrom can never trip.
function removeFromDeckAt(player: PlayerState, index: number): { player: PlayerState; cardId: number; costMod: number } {
  const deck = [...player.deck];
  const aligned = !!player.deckCostMods && player.deckCostMods.length === player.deck.length;
  const mods = aligned ? [...player.deckCostMods!] : player.deck.map(() => 0);
  const cardId = deck.splice(index, 1)[0];
  const costMod = mods.splice(index, 1)[0] ?? 0;
  return { player: { ...player, deck, deckCostMods: mods }, cardId, costMod };
}

function applyHordeDiscount(p: PlayerState, n: number): PlayerState {
  return stampCostReduction(p, (id) => !!getCard(id)?.horde, n);
}

// True if the card is a Glyphe, either the base Glyphe token (#827, which is a
// glyph placed straight onto its target cell) or any card whose play lays down a
// glyph (a PlaceGlyph effect among its flat effects: Glyphe Enflammé, de Mort,
// de Léthargie, de Retraite, de Renouveau, Agressif…). Téléglyphe references a
// glyph but does not place one, so it is correctly excluded. Creatures whose
// PlaceGlyph sits on a trigger (Melita's APPARITION) are not glyph cards, only
// the flat effects[] are inspected, so they are excluded too.
export function isGlyphCard(card: Card): boolean {
  if ((card as { model?: string }).model === "glyphe_token") return true;
  return (card.effects ?? []).some((e) => e.type === "PlaceGlyph");
}

// True if the card belongs to the NÉCROME keyword family. Nécromes are banished
// (removed from game) when they die instead of going to the discard pile, and
// grant an Orbe when played (later layer). Keyed off the card's family tag.
export function isNecrome(cardId: number): boolean {
  return (getCard(cardId)?.families ?? []).includes("Necrome");
}

// True if the card is a token: a card that cannot be put in a deck and only appears in play
// (summoned creatures like Gélatine, board objects like Bombe/Tas d'Os/Butin/Glyphe, and the
// Fléau #757). Based on the `isToken` flag stamped by the merge from the bindata `IsToken` field
// (same as isNecrome). A token must never reach the normal discard pile by any path; it goes to
// the owner's hidden tokenDiscard zone through discardCardFor() below.
export function isToken(cardId: number): boolean {
  return getCard(cardId)?.isToken === true;
}

// Append `cardId` to the OWNER's correct discard zone: the normal `discard` for a
// regular card, or the inaccessible `tokenDiscard` for a token (isToken). Returns a
// new PlayerState (pure). Every site that would push a leaving card to a discard pile
// goes through this so a token never lands in the recoverable pile, board death, spell
// cast, hand/draw overflow, mill, bounce… all converge here.
export function discardCardFor(p: PlayerState, cardId: number): PlayerState {
  if (isToken(cardId)) {
    return { ...p, tokenDiscard: [...(p.tokenDiscard ?? []), cardId] };
  }
  return { ...p, discard: [...p.discard, cardId] };
}

// The PA cost of a creature "once in play": its per-instance costOverride if set
// (a Phorzerker keeps the source Énutrof's cost, fusion / Moumoune #989), else the
// printed cost of its current card. Read by cost-referencing effects (Embaumement
// #1460 reserve gain) and the board card tooltip.
export function creatureCost(c: CreatureInstance): number {
  return c.costOverride ?? getCard(c.cardId)?.cost ?? 0;
}


// FRATRIE keyword: a creature of the "Fratrie des Oubliés" family. When summoned it lets the
// caster target an enemy creature; every copy of that card in the opponent's deck is milled to
// their discard. Based on the family tag, like Nécrome.
export function isFratrie(cardId: number): boolean {
  return (getCard(cardId)?.families ?? []).includes("Fratrie");
}

// A Dofus carries at most one equipment. True if it already has one, a Sinistro #215 or a
// Nécronomigore #700, used to gate AlliedDofusWithoutEquipement placement and the
// ally_dofus_no_equipment pick for both equipment cards (neither can double up).
function dofusHasEquipment(d: DofusInstance): boolean {
  return !!d.sinistroAttached || d.necronomigoreCounter !== undefined;
}

// Baron Sramedi #243: "MORT : Remonte dans votre main si vous avez au moins 10
// cartes dans votre défausse." A RecoverSelfToHand marker on the card's MORT
// trigger makes the dying card return to hand (instead of discard) when its
// condition holds, evaluated against the owner's state at death time.
function recoversToHandOnDeath(cardId: number, ownerState: import("./state").PlayerState, ownerDofusCount: number): boolean {
  const trig = (getCard(cardId)?.triggers ?? []).find((t) => t.trigger === "MORT");
  const eff = trig?.effects.find((e) => e.type === "RecoverSelfToHand") as { condition?: PlayerCondition } | undefined;
  if (!eff) return false;
  const c = eff.condition;
  if (!c) return true; // unconditional recover
  if (c.kind === "discardAtLeast") return ownerState.discard.length >= c.value;
  // Julith Jurgen #488: "tant qu'aucun de vos Dofus (vrai ou faux) n'a été détruit"
  // the owner still has all BOARD_ROWS of their Dofus alive.
  if (c.kind === "noDofusDestroyed") return ownerDofusCount >= BOARD_ROWS;
  // Missiz Frizz #474: "dépense N PA de votre réserve pour remonter dans votre main"
  // the recover happens only if the reserve can pay (checked pre-spend).
  if (c.kind === "reserveAtLeast") return ownerState.apReserve >= c.value;
  return false; // other conditions are not wired for this marker yet
}

// Cumulative cost surcharge applied each time a self-recovering card returns to
// hand (Polter Tofu #358 "il coûte 1 PA de plus"). 0 for plain RecoverSelfToHand.
function recoverCostDeltaOnDeath(cardId: number): number {
  const trig = (getCard(cardId)?.triggers ?? []).find((t) => t.trigger === "MORT");
  const eff = trig?.effects.find((e) => e.type === "RecoverSelfToHand") as { costDelta?: number } | undefined;
  return eff?.costDelta ?? 0;
}

// Héros Félin #1156 (RecoverToHandOnDofusKill): "Remonte dans votre main s'il détruit un Dofus."
// Its effect fires the moment it destroys a Dofus: it must not step onto the freed wall cell and
// advance to break through first. A creature with this marker that kills a Dofus mid-advance
// breaks through in place, like the end-of-move engage, instead of walking into the cell. The
// return to hand itself is handled in resolveDeathsAndWin from brokeThroughIds.
function recoversToHandOnDofusKill(cardId: number): boolean {
  return (getCard(cardId)?.effects ?? []).some((e) => e.type === "RecoverToHandOnDofusKill");
}

// Excarnus #523: "Vos autres Bouftous remontent dans votre main quand ils meurent." A dead
// creature goes back to its owner's hand when an allied creature (a different instance) has a
// ReturnFamilyToHandAura whose family the dead one belongs to.
//
// Volley rule (same as Nenufar #821): the marker is judged at the moment the victim dies. Deaths
// in one volley are simultaneous, so a carrier covers if it is alive, or died in the same volley
// as the victim or a later one (it was still in play at the fatal moment). Two Excarnus dying
// together cover each other (each one is "un autre Bouftou" for the other), so both go back to
// the hand. A carrier that died in an earlier volley of the cascade, or that left by capture
// (breaking through is a capture, not a death), does not cover. With no `salveOf`/
// `brokeThroughIds`, only a living carrier counts (calls outside volley resolution).
function returnsViaFamilyAura(
  dead: CreatureInstance,
  creatures: CreatureInstance[],
  salveOf?: Map<number, number>,
  brokeThroughIds?: Set<number>,
): boolean {
  const vSalve = salveOf?.get(dead.instanceId) ?? 0;
  return creatures.some((c) => {
    if (c.owner !== dead.owner || c.instanceId === dead.instanceId) return false;
    const inPlayAtDeath = c.currentLife > 0 ||
      (salveOf !== undefined && !brokeThroughIds?.has(c.instanceId) && (salveOf.get(c.instanceId) ?? 0) >= vSalve);
    if (!inPlayAtDeath) return false;
    const aura = (getCard(c.cardId)?.effects ?? []).find((e) => e.type === "ReturnFamilyToHandAura") as { family?: string } | undefined;
    return !!aura?.family && (famsOf(dead)).includes(aura.family);
  });
}

// The three reward cards a Butin pickup grants (1/3 each): Pelle #944 (deal 2),
// Élixir de Jouvence #798 (+1 AT/+1 AR), Pioche Antique #1252 (draw 1, −1 PA).
const BUTIN_REWARD_IDS = [944, 798, 1252];

// "vos Butins" (Tolot #651 "Tant qu'il est en jeu vos Butins sont gratuits") are
// these reward cards, not a card that lays down a Butin token. Drives the
// `butin`-scoped cost aura so Tolot makes Pelle / Élixir / Pioche Antique free.
export function isButinCard(card: Card): boolean {
  return BUTIN_REWARD_IDS.includes(card.id);
}

// How many cells of `side`'s camp can take a Butin, counted with the same predicate as the
// multi-Butin pick (the "own_empty_camp" filter). Trouvaille #1382 only defers its multi-cell
// placement when at least `total` such cells exist, so the player can always finish the
// (non-optional) picks. This must match the pick filter exactly, or the two diverge and the pick
// opens again with zero targets in the middle of the selection, a hard lock. It used to be a
// hand-written copy that did diverge: it counted a Tas d'Os cell as free (a Butin can go there in
// its own bookkeeping) while own_empty_camp rejects a Tas d'Os cell, so a camp full except for two
// Tas d'Os cells passed the check (count 2) but the second pick had no legal target and the game
// froze. Delegating to cellMatchesFilter keeps the check and the pick in step.
function countFreeButinCells(state: GameState, side: Side): number {
  let n = 0;
  for (let x = 0; x < BOARD_COLS; x++) {
    if (!isAlliedTerritory(x, side)) continue;
    for (let y = 0; y < BOARD_ROWS; y++) {
      if (cellMatchesFilter(state, { x, y }, "own_empty_camp", side)) n++;
    }
  }
  return n;
}

type CostScope = "glyph" | "summon" | "spell" | "butin" | "all";
// Does `card` fall under a cost-aura scope? "glyph" → it is a Glyphe; "butin" → it is
// a Butin reward card (Pelle / Élixir / Pioche Antique); "summon" → a creature
// card; "spell" → a spell/AoE card. A glyph
// card is also a spell, so stacked auras (Alchimiste glyph −1 + Felida spell +1)
// can both apply to it, that is the intended additive behaviour.
function cardMatchesCostScope(card: Card, scope: CostScope): boolean {
  if (scope === "all") return true;
  if (scope === "glyph") return isGlyphCard(card);
  if (scope === "butin") return isButinCard(card);
  if (scope === "summon") return card.cardType === "Summon";
  return card.cardType === "Spell" || card.cardType === "Aoe"; // "spell"
}

// Signed PA delta applied to `card` by every CardCostAura a side's living
// creatures carry (Alchimiste → {glyph,−1}; Felida → {summon,−1} + {spell,+1}).
// Negative = cheaper, positive = dearer; floored to 0 by effectiveCost. Auras of
// non-matching scope contribute nothing.
export function cardCostAuraDelta(creatures: CreatureInstance[], side: Side, card: Card, reserves?: Partial<Record<Side, number>>): number {
  let delta = 0;
  for (const c of creatures) {
    if (c.currentLife <= 0) continue;
    const own = c.owner === side;
    for (const e of getCard(c.cardId)?.effects ?? []) {
      if (e.type !== "CardCostAura") continue;
      const a = e as { scope?: CostScope; amount?: number; family?: string; cardId?: number; enemy?: boolean; setTo?: number; requireReserve?: number };
      if (a.setTo != null) continue;     // set-cost auras are a hard override, handled in effectiveCost
      // An own aura shifts your cards; an `enemy` aura (Maître Joris) shifts the
      // OPPONENT's cards. So apply iff own-ness differs from the aura's enemy flag.
      if (own === !!a.enemy) continue;
      // Reserve-gated aura (Encablure #1100): applies only while the aura owner holds at
      // least `requireReserve` PA in reserve. Without `reserves` (sims) → cannot verify → skip.
      if (a.requireReserve != null && (reserves?.[c.owner] ?? 0) < a.requireReserve) continue;
      // A CARD-ID aura (Kabrok #473 "les Corbacs adverses coûtent 1 PA de plus" → cardId 56)
      // matches a specific card; a family aura ("vos Chachas coûtent 1 de moins") matches any
      // card of that family regardless of type; otherwise match by card-type scope.
      const matches = a.cardId != null
        ? card.id === a.cardId
        : a.family
        ? (card.families ?? []).includes(a.family)
        : !!a.scope && cardMatchesCostScope(card, a.scope);
      if (matches) delta += a.amount ?? 0;
    }
  }
  return delta;
}

// "Les pièges activés de la main adverse coûtent +N PA et infligent +M dégât" (Héroïne Perfide
// #1254). Driven by the effect (an ActivatedTrapAura marker on the card) rather than a hard-coded
// id: returns the {costTax, damageBonus} of the aura on this card, or null. Read by effectiveCost
// (tax) and when traps go off (damage bonus).
function activatedTrapAuraOf(cardId: number): { costTax: number; damageBonus: number } | null {
  const e = (getCard(cardId)?.effects ?? []).find((x) => x.type === "ActivatedTrapAura") as
    | { costTax?: number; damageBonus?: number }
    | undefined;
  return e ? { costTax: e.costTax ?? 0, damageBonus: e.damageBonus ?? 0 } : null;
}

// Effective AP cost of a card the player is about to play: its printed cost plus the modifier on
// its first matching hand slot (0 if none), plus any continuous board cost auras that match this
// card's kind (Alchimiste makes the owner's Glyphes cheaper; Felida makes summons cheaper and
// spells more expensive), floored at 0. `allies` is the live board; pass it so the dynamic auras
// are counted (the empty default leaves callers that do not care, and cards with no matching
// aura, unaffected).
// Index of the cheapest hand slot holding `cardId` (the most negative stamp wins), or -1.
// So a per-copy discount (Héros Félin #1156 "il coûte désormais 0 PA" stamped on the slot of the
// recovered copy) is the one the player spends, and is not hidden by a fresh full-price copy that
// happens to sit earlier in the hand. playCard removes the same slot, so the AP check and the
// actual play stay consistent.
function cheapestHandSlot(player: PlayerState, cardId: number): number {
  let best = -1, bestMod = 0;
  for (let i = 0; i < player.hand.length; i++) {
    if (player.hand[i] !== cardId) continue;
    const m = (player.handCostMods[i] ?? 0) + (player.handCostTempMods?.[i] ?? 0);
    if (best === -1 || m < bestMod) { best = i; bestMod = m; }
  }
  return best;
}

// The hand slot a play spends: the exact copy the player selected (`handIndex`) when it is a valid
// slot for this card, otherwise the cheapest matching slot. Shared by canPlayCard (AP check) and
// playCard (removal + payment) so the affordability check and the actual play always price the
// same copy; two copies of one card can have different costs per slot (Héros Félin at 0 vs at 4).
// An outdated index (out of range, or the hand shifted so it no longer holds this card) falls
// back to the cheapest slot.
function resolveHandSlot(player: PlayerState, cardId: number, handIndex?: number): number {
  if (handIndex != null && handIndex >= 0 && handIndex < player.hand.length && player.hand[handIndex] === cardId) {
    return handIndex;
  }
  return cheapestHandSlot(player, cardId);
}

// `handIndex` (optional) prices a specific hand slot, the index-aware UI passes it so
// each duplicate copy shows its own cost. Without it, the cheapest matching slot is used.
export function effectiveCost(player: PlayerState, card: Card, allies: CreatureInstance[] = [], handIndex?: number, glyphs: import("./state").GlyphInstance[] = [], reserves?: Partial<Record<Side, number>>): number {
  // "Se pose gratuitement si vous avez au moins N PA dans votre réserve" (Dente):
  // a marker that zeroes the cost outright while the reserve threshold holds.
  // Checked from the player's reserve alone (no board needed); overrides every
  // other modifier when met.
  const freeMarker = (card.effects ?? []).find((e) => e.type === "FreeIfReserve") as { value?: number } | undefined;
  if (freeMarker && player.apReserve >= (freeMarker.value ?? 0)) return 0;
  // "Vos Butins sont gratuits" (Tolot), a `free` CardCostAura on a living owned
  // creature zeroes the cost of any card matching its scope, overriding everything.
  if (allies.length > 0 && allies.some((c) =>
    c.currentLife > 0 && c.owner === player.side &&
    (getCard(c.cardId)?.effects ?? []).some((e) => {
      if (e.type !== "CardCostAura" || !(e as { free?: boolean }).free) return false;
      const a = e as { scope?: CostScope; cardId?: number };
      // `cardId` aura matches one precise card (Kriss → Boufballe #1137); else by scope.
      return a.cardId != null ? a.cardId === card.id : (a.scope != null && cardMatchesCostScope(card, a.scope));
    }))) {
    return 0;
  }
  // "Le coût de vos <invocations|sorts|famille> est de N PA" (Nox), a `setTo`
  // CardCostAura on a living owned creature forces every matching card to exactly
  // that cost (a hard override of the printed cost and any other modifier).
  if (allies.length > 0) {
    for (const c of allies) {
      if (c.currentLife <= 0 || c.owner !== player.side) continue;
      for (const e of getCard(c.cardId)?.effects ?? []) {
        if (e.type !== "CardCostAura") continue;
        const a = e as { scope?: CostScope; family?: string; setTo?: number };
        if (a.setTo == null) continue;
        const matches = a.family ? (card.families ?? []).includes(a.family) : !!a.scope && cardMatchesCostScope(card, a.scope);
        if (matches) return Math.max(0, a.setTo | 0);
      }
    }
  }
  const idx = handIndex != null ? handIndex : cheapestHandSlot(player, card.id);
  // handCostMods (persistent) + handCostTempMods (Ralentissement #188's one-turn
  // surcharge, see PlayerState); both are aligned 1:1 with `hand`.
  const modd = idx >= 0 ? (player.handCostMods[idx] ?? 0) + (player.handCostTempMods?.[idx] ?? 0) : 0;
  const aura = allies.length > 0 ? cardCostAuraDelta(allies, player.side, card, reserves) : 0;
  // Self cost reduction by a live board count ("Coûte N PA de moins par invocation
  // alliée blessée en jeu", Raku Kapi): a marker on the card's own effects,
  // resolved against the board each time the cost is read (never applied as an
  // effect). `allies` is the full creature list; resolveCountValue filters by the
  // CountSpec's own scope.
  let selfRed = 0;
  if (allies.length > 0) {
    const m = (card.effects ?? []).find((e) => e.type === "SelfCostReduction") as
      | { amount?: { count: import("../data/types").CountSpec; per?: number } }
      | undefined;
    if (m?.amount) selfRed = resolveCountValue(m.amount, allies, player.side);
  }
  // Self cost reduction by discard size ("Coûte N PA de moins par carte dans votre
  // défausse", Oscar Nak): another never-applied marker, resolved against the
  // caster's discard pile each time the cost is read.
  const disc = (card.effects ?? []).find((e) => e.type === "CostPerDiscard") as { per?: number } | undefined;
  if (disc) selfRed += Math.max(0, disc.per ?? 0) * player.discard.length;
  // Self cost reduction by ally GLYPH count ("Coûte N PA de moins par glyphe allié en
  // jeu", Retour Du Bâton #1640): another never-applied marker, resolved against the
  // caster's glyphes on the board (passed in by the cost-aware callers).
  const gly = (card.effects ?? []).find((e) => e.type === "CostPerGlyph") as { per?: number } | undefined;
  if (gly) selfRed += Math.max(0, gly.per ?? 0) * glyphs.filter((g) => g.owner === player.side).length;
  // Persistent class cost aura (Nouvelle Vague #1213): every card of a banked god
  // costs N less, read live so it follows the class through discard/redraw and applies
  // to cards drawn after it was cast. Distinct from the per-card stamps in `modd`.
  const godRed = card.god ? (player.godCostReductions?.[card.god] ?? 0) : 0;
  // Pending "next card" discount (La Folle / Emma Cabre) applies to every hand card
  // (any could be the next played); consumed by playCard when one is played.
  const nextDisc = Math.max(0, player.nextCardDiscount ?? 0);
  // Héroïne Perfide #1254 (ActivatedTrapAura): an Active Trap in this player's hand
  // costs +costTax while the opponent has a living aura source in play.
  let trapTax = 0;
  if ((player.activeTraps ?? []).some((t) => t.cardId === card.id)) {
    for (const c of allies) {
      if (c.currentLife <= 0 || c.owner === player.side) continue;
      const aura = activatedTrapAuraOf(c.cardId);
      if (aura) { trapTax += aura.costTax; }
    }
  }
  return Math.max(0, card.cost + modd + aura - selfRed - godRed - nextDisc + trapTax);
}

// Card id of the "Fléau" spell that the Fléau prism adds to the hand (#757 in the neutral pool,
// "Inflige X à un Dofus"). The UI needs this card in its cardById map to render it; since it is a
// neutral card, Match merges the neutral pool for this reason.
export const FLEAU_CARD_ID = 757;

// Prism layout per side, by row (y). A symmetric pattern, fixed on the base summon column whatever
// the Bastion spawn-range extension:
//   y0 → AP   y1 → Fléau   y2 → Draw   y3 → Fléau   y4 → AP
// Same as in the game (positions 1&5 = PA, 2&4 = Fléau, 3 = pioche).
const PRISM_PATTERN: import("./state").PrismKind[] = ["ap", "fleau", "draw", "fleau", "ap"];

// Build the full set of 10 prisms (5 per side) at their home cells. Ally's
// base summon column is x=8, enemy's is x=1 (see board.isSpawnCell).
export function initialPrisms(): import("./state").PrismInstance[] {
  const out: import("./state").PrismInstance[] = [];
  for (let y = 0; y < BOARD_ROWS; y++) {
    const kind = PRISM_PATTERN[y];
    out.push({ position: { x: 8, y }, owner: "ally", kind });
    out.push({ position: { x: 1, y }, owner: "enemy", kind });
  }
  return out;
}

// A prism does not reappear on an occupied home cell (x=8 ally / x=1 enemy). "Occupied"
// = a living creature or any ground object ("objet au sol") on the cell, seed / tas d'os /
// buisson / glyphe / butin / piège. (Erik Rak #720 turns a prism into a Butin on the freed
// home cell, so that Butin must block the respawn there.) Prisms themselves are not checked:
// callers skip rows that still hold a prism (haveRows), and the startTurn reset only fires
// when there are no prisms at all. Dofus live on the wall columns (x=0/x=9) and can never
// reach a prism cell, so that check is purely defensive. Ground-object arrays are optional → `?? []`.
function prismCellOccupied(state: GameState, cell: Coords): boolean {
  return (
    state.creatures.some((c) => c.currentLife > 0 && sameCoords(c.position, cell)) ||
    state.dofuses.some((d) => d.currentLife > 0 && sameCoords(d.position, cell)) ||
    cellHasGroundObject(state, cell)
  );
}

// Invariant: a cell never has two ground objects at once. Ground objects = seed / tas d'os / bush
// / glyph / butin / Nowel gift / trap (prisms are a separate array). Two mechanisms follow from
// this:
//  - `cellHasGroundObject`: for placements "on a free cell" (Dwanlaposh, generic PlaceButin,
//    planting...), which skip a cell that is already taken.
//  - `replaceGroundObjectsAt`: for placements on a given cell (Nenufar seed on the dead creature's
//    cell, transformation, Pelle Sismique, prism→butin...), where the new object replaces the old
//    one. The old one leaves with an A_O_E_REMOVED (visible: it "appears and then disappears").
function cellHasGroundObject(state: GameState, cell: Coords): boolean {
  return (
    (state.seeds ?? []).some((s) => sameCoords(s.position, cell)) ||
    (state.tasDOs ?? []).some((t) => sameCoords(t.position, cell)) ||
    (state.bushes ?? []).some((b) => sameCoords(b.position, cell)) ||
    (state.glyphs ?? []).some((g) => sameCoords(g.position, cell)) ||
    (state.butins ?? []).some((b) => sameCoords(b.position, cell)) ||
    (state.gifts ?? []).some((g) => sameCoords(g.position, cell)) ||
    (state.traps ?? []).some((t) => sameCoords(t.position, cell))
  );
}

// Strip every ground object sitting on `cell` so an incoming object can take the cell without ever
// stacking (the "replace" side of the one-object-per-cell rule). Pushes one A_O_E_REMOVED so the FX
// shows the evicted object vanish. Returns the state with those objects filtered out; a no-op (same
// reference, no log) when the cell is already clear. Prisms are not touched here, each placement
// site keeps its own prism handling (some replace a prism, some are blocked by one).
function replaceGroundObjectsAt(state: GameState, cell: Coords, log: GameEvent[]): GameState {
  if (!cellHasGroundObject(state, cell)) return state;
  log.push({ type: "A_O_E_REMOVED", at: { ...cell } });
  const drop = <T extends { position: Coords }>(arr: T[] | undefined): T[] | undefined =>
    arr && arr.some((o) => sameCoords(o.position, cell)) ? arr.filter((o) => !sameCoords(o.position, cell)) : arr;
  return {
    ...state,
    seeds: drop(state.seeds), tasDOs: drop(state.tasDOs), bushes: drop(state.bushes),
    glyphs: drop(state.glyphs), butins: drop(state.butins), gifts: drop(state.gifts), traps: drop(state.traps),
  };
}

// "Fait à nouveau apparaître vos prismes", re-add the caster side's prisms
// that have been consumed (one per row on its base column, following the
// standard pattern). Rows that still have their prism, or whose cell is
// occupied, are left untouched (the prism does not reappear there).
function respawnSidePrisms(state: GameState, side: Side): GameState {
  const baseX = side === "ally" ? 8 : 1;
  const haveRows = new Set(state.prisms.filter((p) => p.owner === side).map((p) => p.position.y));
  const added: import("./state").PrismInstance[] = [];
  for (let y = 0; y < BOARD_ROWS; y++) {
    if (haveRows.has(y)) continue;
    const cell = { x: baseX, y };
    if (prismCellOccupied(state, cell)) continue; // occupied → prism stays absent
    added.push({ position: cell, owner: side, kind: PRISM_PATTERN[y] });
  }
  if (added.length === 0) return state;
  return {
    ...state,
    prisms: [...state.prisms, ...added],
    log: [
      ...state.log,
      ...added.map((p) => ({ type: "NEW_A_O_E" as const, at: { ...p.position }, ownerSide: p.owner, aoeType: `prism_${p.kind}` })),
    ],
  };
}

// Respawn a single missing prism of `side`: on `row` if given (Bouftou Male #36,
// the allied prism of the source's row), else the first missing row (Lou #572,
// "un prisme allié"). No-op if that row already has the prism or the cell is taken.
function respawnOneSidePrism(state: GameState, side: Side, row: number | null): GameState {
  const baseX = side === "ally" ? 8 : 1;
  const haveRows = new Set(state.prisms.filter((p) => p.owner === side).map((p) => p.position.y));
  const rows = row != null ? [row] : Array.from({ length: BOARD_ROWS }, (_, y) => y);
  for (const y of rows) {
    if (haveRows.has(y)) continue;
    const cell = { x: baseX, y };
    if (prismCellOccupied(state, cell)) continue;
    const added = { position: cell, owner: side, kind: PRISM_PATTERN[y] };
    return {
      ...state,
      prisms: [...state.prisms, added],
      log: [...state.log, { type: "NEW_A_O_E" as const, at: { ...cell }, ownerSide: side, aoeType: `prism_${added.kind}` }],
    };
  }
  return state;
}

// How many of each side's 5 Dofus are real (the rest are fake). Capturing
// REAL_DOFUS_TO_WIN of an opponent's reals wins the match.
const REAL_DOFUS_PER_SIDE = REAL_DOFUS_ROWS.length; // 3

// A random real/fake assignment for one side's 5 rows: REAL_DOFUS_PER_SIDE
// reals + the rest fake, shuffled (Fisher–Yates) via the seeded RNG so each
// match's layout is reproducible from its seed.
function randomDofusKinds(rng: Rng): ("real" | "fake")[] {
  const kinds: ("real" | "fake")[] = [];
  for (let i = 0; i < BOARD_ROWS; i++) kinds.push(i < REAL_DOFUS_PER_SIDE ? "real" : "fake");
  return rng.shuffle(kinds);
}

function placeDofuses(rng: Rng): DofusInstance[] {
  // 5 Dofus per side, one per row on the base column. REAL_DOFUS_PER_SIDE (3)
  // are real, the other 2 are fake, but which rows are real is RANDOMISED
  // independently for each side at match start (as in the original game, where
  // each player secretly arranges their own Dofus). Both kinds share life and
  // combat behaviour; only the destruction outcome differs:
  //   - real Dofus destroyed → counts toward the attacker's win condition
  //     (capture REAL_DOFUS_TO_WIN of the opponent's reals to win)
  //   - fake Dofus destroyed → grants +1 spawn-range column to the attacker.
  const allyKinds = randomDofusKinds(rng);
  const enemyKinds = randomDofusKinds(rng);
  // Colours of the real Dofus. The original game has 6 colours (DofusType: Ebony/Emerald/Ivory/
  // Ochre/CardinalRed/Turquoise, here indexes into DOFUS_COLOR_FILES). They are split 3+3 with no
  // overlap: each camp gets REAL_DOFUS_PER_SIDE different colours (one per real Dofus), so all 6
  // appear in the game. Seeded draw, so it can be reproduced from the seed. `color` travels with the
  // instance: a position swap (Bluff) keeps each Dofus's colour.
  const palette = rng.shuffle(Array.from({ length: 2 * REAL_DOFUS_PER_SIDE }, (_, i) => i));
  const allyColors = palette.slice(0, REAL_DOFUS_PER_SIDE);
  const enemyColors = palette.slice(REAL_DOFUS_PER_SIDE);
  // Each real Dofus takes the next colour of its trio, in row order. The fake ones stay hidden, with
  // colour -1 (never shown: they use the "fake"/"hidden" look, not a coloured egg).
  let ai = 0, ei = 0;
  const out: DofusInstance[] = [];
  for (let y = 0; y < BOARD_ROWS; y++) {
    const eColor = enemyKinds[y] === "real" ? enemyColors[ei++] : -1;
    const aColor = allyKinds[y] === "real" ? allyColors[ai++] : -1;
    out.push({ position: { x: 0, y }, owner: "enemy", currentLife: DOFUS_LIFE, kind: enemyKinds[y], color: eColor });
    out.push({ position: { x: BOARD_COLS - 1, y }, owner: "ally", currentLife: DOFUS_LIFE, kind: allyKinds[y], color: aColor });
  }
  return out;
}

// Options for a fresh match.
//   firstSide, who takes turn 1 (no going-second bonus). Krosmaga: the side
//               with the lower average card cost; the caller computes it.
//   seed, RNG seed. Omitted → a fresh random seed (live game). Pass an
//               explicit seed to make the whole match reproducible (AI sims).
//   shuffle, shuffle each deck with the seeded RNG (default true). Pass
//               false to keep the given deck order (deterministic tests).
export interface InitOptions {
  firstSide?: Side;
  seed?: number;
  shuffle?: boolean;
  // Each side's god (match-up metadata). Public/info-fair. When omitted, the god
  // is DERIVED from the deck's cards (most common non-neutral god). The corpus
  // path passes it explicitly (authoritative).
  gods?: Record<Side, God>;
}

// Derive a deck's god from its cards: the most common non-neutral card god, or
// "None" for a neutral-only deck. Used to populate PlayerState.god when the
// caller does not pass `opts.gods`. Safe if the registry is not fully populated
// (unknown ids just do not vote).
function deckGod(ids: number[]): God {
  const counts = new Map<God, number>();
  for (const id of ids) {
    const g = getCard(id)?.god;
    if (g && g !== "None" && g !== "Rushu") counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  let best: God = "None", bestN = 0;
  for (const [g, n] of counts) if (n > bestN) { best = g; bestN = n; }
  return best;
}

// Build a fresh game state for a new match. All initial chance (deck shuffle +
// Dofus layout) is drawn from the seeded RNG and its advanced state is stored
// in `state.rng`, so the match is reproducible from `seed`.
export function createInitialState(
  decks: Record<Side, number[]>,
  opts: InitOptions = {},
): GameState {
  const first: Side = opts.firstSide ?? "ally";
  const second: Side = first === "ally" ? "enemy" : "ally";
  const allyGod = opts.gods?.ally ?? deckGod(decks.ally);
  const enemyGod = opts.gods?.enemy ?? deckGod(decks.enemy);
  const rng = new Rng(opts.seed ?? randomSeed());
  const order = (ids: number[]) =>
    opts.shuffle === false ? [...ids] : rng.shuffle([...ids]);
  const allyDeck = order(decks.ally);
  const enemyDeck = order(decks.enemy);
  const dofuses = placeDofuses(rng);
  let state: GameState = {
    turn: 0,
    activeSide: first,
    firstSide: first,
    mulligan: { current: first, first, second },
    rng: rng.state,
    players: {
      ally: { ...mkPlayer("ally", allyDeck), god: allyGod },
      enemy: { ...mkPlayer("enemy", enemyDeck), god: enemyGod },
    },
    creatures: [],
    dofuses,
    prisms: initialPrisms(),
    seeds: [],
    bushes: [],
    glyphs: [],
    butins: [],
    nextInstanceId: 1,
    winner: null,
    log: [],
    pendingAction: null,
    pendingReversions: [],
  };
  // Both players draw their 3-card opening hand for the mulligan. The match
  // does not start yet, startTurn(first) runs once both players have redrawn
  // (see applyMulligan). Turn stays 0 throughout the redraw phase.
  for (let i = 0; i < MULLIGAN_HAND; i++) {
    state = drawCard(state, first);
    state = drawCard(state, second);
  }
  return state;
}

// Resolve one player's mulligan choice. `returnIndices` are positions in that
// player's current 3-card hand to send back: those cards go into the deck, the
// whole deck is reshuffled (via the seeded RNG), then the same number are
// redrawn (so a returned card can come back). Hand returns to 3.
//
// Order: player 1 chooses first, then player 2. After player 2 resolves, the
// match begins, player 2 gets a 4th (unchosen) card and 1 banked AP, the
// mulligan clears, and turn 1 starts for player 1.
// Deterministic core of a mulligan redraw: split the current hand into kept and
// returned cards, reshuffle the whole deck (with the returned cards folded back
// in), then redraw one card per returned one. Pure, drives both applyMulligan
// (the commit) and previewMulliganRedraw (the UI animation), so the faces the
// player sees fly in are exactly the faces they get.
function mulliganDraw(state: GameState, side: Side, returnIndices: number[]) {
  const player = state.players[side];
  const ret = new Set(returnIndices.filter((i) => i >= 0 && i < player.hand.length));
  const kept: number[] = [];
  const returned: number[] = [];
  const retSlots: number[] = []; // original hand indices of the returned cards
  player.hand.forEach((id, i) => {
    if (ret.has(i)) {
      returned.push(id);
      retSlots.push(i);
    } else {
      kept.push(id);
    }
  });
  const rng = new Rng(state.rng);
  const deck = rng.shuffle([...player.deck, ...returned]);
  const drawn: number[] = [];
  for (let i = 0; i < returned.length && deck.length > 0; i++) {
    drawn.push(deck.pop()!);
  }
  return { player, kept, retSlots, deck, drawn, rngState: rng.state };
}

// Preview the cards a mulligan redraw would deal, paired with the hand slot each
// fills, for the redraw animation. Reproducible: applyMulligan reshuffles from
// the same RNG state, so these are the very cards that get committed.
export function previewMulliganRedraw(
  state: GameState,
  side: Side,
  returnIndices: number[],
): { slot: number; cardId: number }[] {
  const m = state.mulligan;
  if (!m || m.current !== side) return [];
  const { retSlots, drawn } = mulliganDraw(state, side, returnIndices);
  return retSlots
    .map((slot, i) => ({ slot, cardId: drawn[i] }))
    .filter((x) => x.cardId !== undefined);
}

export function applyMulligan(
  state: GameState,
  side: Side,
  returnIndices: number[],
): GameState {
  const m = state.mulligan;
  if (!m || m.current !== side) return state; // not this side's redraw

  const { player, kept, deck, drawn, rngState } = mulliganDraw(state, side, returnIndices);
  const hand = [...kept, ...drawn];
  // Write the advanced RNG state back so the reshuffle is part of the
  // reproducible game; all later spreads below preserve it.
  let next: GameState = {
    ...state,
    rng: rngState,
    players: {
      ...state.players,
      // Reshuffle resets the deck order; deckCostMods restart at 0 (the mulligan
      // runs at turn 0, before any HORDE death, so nothing is lost).
      [side]: { ...player, deck, hand, handCostMods: hand.map(() => 0), deckCostMods: deck.map(() => 0) },
    },
  };

  if (side === m.first) {
    // Hand off to player 2's redraw.
    return { ...next, mulligan: { ...m, current: m.second } };
  }

  // Player 2 just finished → start the match. Give the going-second bonuses
  // (an extra unchosen card + banked AP), clear the mulligan, begin turn 1.
  next = { ...next, mulligan: null };
  next = drawCard(next, m.second); // 4th card, not mulliganed
  const sp = next.players[m.second];
  next = {
    ...next,
    players: {
      ...next.players,
      [m.second]: { ...sp, apReserve: sp.apReserve + SECOND_PLAYER_RESERVE },
    },
  };
  return startTurn(next, m.first);
}

// Start a new turn for `side`: grow maxAp, refill ap, draw a card, reset
// creature movement/attack flags for that side.
// Resolve a board-derived count ("+N par X en jeu", Marquage, Force de l'Âge,
// Scaramel…): count the living creatures matching the spec, times `per`.
function resolveCountValue(
  v: { count: import("../data/types").CountSpec; per?: number },
  creatures: CreatureInstance[],
  casterSide: Side,
  selfId?: number,
): number {
  const s = v.count;
  let n = 0;
  for (const c of creatures) {
    if (c.currentLife <= 0) continue;
    if (s.excludeSelf && selfId != null && c.instanceId === selfId) continue;
    if (s.scope === "allies" && c.owner !== casterSide) continue;
    if (s.scope === "enemies" && c.owner === casterSide) continue;
    if (s.family && !(famsOf(c)).includes(s.family)) continue;
    if (s.withRange && c.range <= 0) continue;
    if (s.wounded && c.currentLife >= c.baseLife) continue;
    if (s.withArmorOrShield && !(c.armor > 0 || c.properties.has("Shield"))) continue;
    n++;
  }
  return Math.max(0, (v.per ?? 1) | 0) * n;
}

// Resolve a bindata NumberOfSeedsValue ("autant que de Graines … en jeu",
// Grainaille, Héros Chataîgneur): FixedValue + ValuePerSeed × (board seeds
// matching the TeamFilter, relative to the caster). TeamFilter mirrors the
// PlayerTarget enum: 0 = Own (the caster's seeds), 1 = Opponent, 2 = Both.
function resolveSeedValue(
  v: { TeamFilter?: number; ValuePerSeed?: number; ValuePerGlyph?: number; FixedValue?: number },
  objects: { owner: Side }[],
  casterSide: Side,
): number {
  const tf = (v.TeamFilter ?? 0) | 0;
  let n = 0;
  for (const o of objects) {
    if (tf === 0 && o.owner !== casterSide) continue; // Own
    if (tf === 1 && o.owner === casterSide) continue; // Opponent
    n++; // tf === 2 → Both
  }
  // Per-object multiplier: NumberOfSeedsValue uses ValuePerSeed, NumberOfGlyphs
  // Value uses ValuePerGlyph, read whichever is present.
  return ((v.FixedValue ?? 0) | 0) + ((v.ValuePerSeed ?? v.ValuePerGlyph ?? 0) | 0) * n;
}

// Is this a bindata NumberOfSeedsValue / NumberOfGlyphsValue dynamic value?
function isSeedValue(x: unknown): x is { TeamFilter?: number; ValuePerSeed?: number; FixedValue?: number } {
  return !!x && typeof x === "object" && (x as { type?: string }).type === "NumberOfSeedsValue";
}
function isGlyphValue(x: unknown): x is { TeamFilter?: number; ValuePerGlyph?: number; FixedValue?: number } {
  return !!x && typeof x === "object" && (x as { type?: string }).type === "NumberOfGlyphsValue";
}
// "autant que de Butins EN JEU" (Havre-sac #1131). The bindata NumberOfLootsValue has no TeamFilter
// (only ValuePerLoot + FixedValue), so it counts every Butin on the board, both sides, resolved
// against the live butin count, not per owner like seeds/glyphs.
function isLootValue(x: unknown): x is { ValuePerLoot?: number; FixedValue?: number } {
  return !!x && typeof x === "object" && (x as { type?: string }).type === "NumberOfLootsValue";
}
// "autant que de PA dans votre réserve" (Casey Io), a value read straight from
// the caster's AP reserve (× an optional `per`, default 1).
function isReserveValue(x: unknown): x is { per?: number } {
  return !!x && typeof x === "object" && (x as { type?: string }).type === "ReserveValue";
}
// "X dégâts OU Y si vous avez au moins N PA dans votre réserve" (Instantina #371): a THRESHOLD
// value, `then` when the owner's reserve ≥ `ifReserveAtLeast`, else `else`. Resolved against the
// reserve passed into resolveCounts (the trigger owner's apReserve).
function isReserveThresholdValue(x: unknown): x is { ifReserveAtLeast: number; then: number; else: number } {
  return !!x && typeof x === "object" && typeof (x as { ifReserveAtLeast?: unknown }).ifReserveAtLeast === "number";
}

// "+N par carte en main" (Mitaine #551 "gagne autant d'AT que vous avez de cartes en main"). A
// runtime marker resolved by resolveCounts against the hand size.
function isHandValue(x: unknown): x is { per?: number } {
  return !!x && typeof x === "object" && (x as { type?: string }).type === "HandSizeValue";
}

// Replace any board-derived dynamic amounts in an effect list with the concrete
// value now, so the stat / damage handlers (which read a plain number / dice)
// see a resolved value. Covers our `{ count }` amounts and the bindata
// NumberOfSeedsValue (in `amount` or a DamageData's `Damage` field).
function resolveCounts(
  effects: Effect[],
  creatures: CreatureInstance[],
  seeds: { owner: Side }[],
  glyphs: { owner: Side }[],
  casterSide: Side,
  selfId?: number,
  reserve = 0,
  handSize = 0,
  lootCount = 0,
): Effect[] {
  const resolveBoardVal = (v: unknown): number | undefined => {
    if (isSeedValue(v)) return resolveSeedValue(v, seeds, casterSide);
    if (isGlyphValue(v)) return resolveSeedValue(v, glyphs, casterSide);
    if (isReserveValue(v)) return Math.max(0, (v.per ?? 1) | 0) * Math.max(0, reserve | 0);
    // "autant d'AT que vous avez de cartes en main" (Mitaine #551) → per × hand size.
    if (isHandValue(v)) return Math.max(0, (v.per ?? 1) | 0) * Math.max(0, handSize | 0);
    // "autant que de Butins en jeu" (Havre-sac #1131) → FixedValue + ValuePerLoot × all butins.
    if (isLootValue(v)) return Math.max(0, ((v.FixedValue ?? 0) | 0) + ((v.ValuePerLoot ?? 0) | 0) * Math.max(0, lootCount | 0));
    // "X dégâts ou Y si réserve ≥ N" (Instantina #371) → picks `then`/`else` by the reserve.
    if (isReserveThresholdValue(v)) return Math.max(0, (reserve >= (v.ifReserveAtLeast | 0) ? v.then : v.else) | 0);
    return undefined;
  };
  return effects.map((e) => {
    let out = e;
    const amt = (out as { amount?: unknown }).amount;
    if (amt && typeof amt === "object" && "count" in (amt as object)) {
      out = { ...out, amount: resolveCountValue(amt as { count: import("../data/types").CountSpec; per?: number }, creatures, casterSide, selfId) } as Effect;
    } else {
      const r = resolveBoardVal(amt);
      if (r !== undefined) out = { ...out, amount: r } as Effect;
    }
    const dmgRaw = (out as { Damage?: unknown }).Damage;
    if (dmgRaw && typeof dmgRaw === "object" && "count" in (dmgRaw as object)) {
      // Criblage #519: "inflige à un dofus autant de dégâts que de <famille> alliés en jeu",
      // a count in the DamageData's Damage field (resolved against the creatures, like amount).
      out = { ...out, Damage: resolveCountValue(dmgRaw as { count: import("../data/types").CountSpec; per?: number }, creatures, casterSide, selfId) } as Effect;
    } else {
      const dmg = resolveBoardVal(dmgRaw);
      if (dmg !== undefined) out = { ...out, Damage: dmg } as Effect;
    }
    // Resolve a dynamic `value` (Maine Cooyne #1579: SetMovement "= au nombre de
    // Chachas alliés"). A literal numeric value is untouched (not an object).
    const valR = (out as { value?: unknown }).value;
    if (valR && typeof valR === "object" && "count" in (valR as object)) {
      out = { ...out, value: resolveCountValue(valR as { count: import("../data/types").CountSpec; per?: number }, creatures, casterSide, selfId) } as Effect;
    } else {
      const rv = resolveBoardVal(valR);
      if (rv !== undefined) out = { ...out, value: rv } as Effect;
    }
    // Resolve a dynamic `cells` count (Bain de Sang #1316: Charge "d'autant de cases que
    // d'invocations blessées en jeu"). A literal number / "toWall" / a dice value is untouched.
    const cellsR = (out as { cells?: unknown }).cells;
    if (cellsR && typeof cellsR === "object" && "count" in (cellsR as object)) {
      out = { ...out, cells: resolveCountValue(cellsR as { count: import("../data/types").CountSpec; per?: number }, creatures, casterSide, selfId) } as Effect;
    }
    return out;
  });
}

// Drop effects whose `requireCondition` (a PlayerCondition) is not met right now,
// for "+N stat … si <condition>" riders where the whole effect is annulled when
// the condition fails (Murmures Sauvages "+1 AR si vous avez une Graine en jeu";
// Orma's FIN DU TOUR self-buff). Distinct from DrawCards' `condition`, which
// gates a draw bonus rather than the whole effect.
function dropUnmetConditions(effects: Effect[], state: GameState, caster: Side, selfId?: number): Effect[] {
  return effects.filter((e) => {
    const rc = (e as { requireCondition?: PlayerCondition }).requireCondition;
    if (!rc) return true;
    const met = conditionMet(state, caster, rc, selfId);
    return (rc as { negate?: boolean }).negate ? !met : met; // negate (Gouloutony #403 « si vous n'avez PAS de goules en jeu »)
  });
}

// Flip a coin for `side` ("A OU B"): true = Pile (the positive / first branch).
// Forced to Pile by Trucage (coinForcedPile) during the active turn, else a
// 50/50 draw from the seeded RNG (so it is reproducible).
function flipCoin(state: GameState, side: Side, rng: Rng): boolean {
  return state.players[side].coinForcedPile === true || rng.int(2) === 0;
}

// Map a stat-effect type to its STAT_FIELDS key (for temporary reversions).
const TEMP_STAT_FIELD: Record<string, Extract<TempReversion, { kind: "stat" }>["field"] | undefined> = {
  BoostAttack: "attack", BoostArmor: "armor", BoostMovement: "movement", BoostRange: "range", Heal: "life",
};

// Which creatures a temporary stat effect hit, by its scope (mirrors the AoE
// scope semantics; undefined scope = the single creature on the clicked cell).
function tempScopeMatches(c: CreatureInstance, scope: string | undefined, caster: Side, target: Coords): boolean {
  switch (scope) {
    case "allies": return c.owner === caster;
    case "enemies": return c.owner !== caster;
    case "all": return true;
    case "own_camp": return isAlliedTerritory(c.position.x, caster);
    case "enemy_camp": return isAlliedTerritory(c.position.x, other(caster));
    case undefined: return sameCoords(c.position, target);
    default: return false;
  }
}

export function startTurn(state: GameState, side: Side): GameState {
  const turn = state.turn + 1;
  const player = state.players[side];
  const newMaxAp = Math.min(MAX_AP, player.maxAp + 1);

  const nextPlayer: PlayerState = {
    ...player,
    ap: newMaxAp,
    maxAp: newMaxAp,
  };

  // Expire temporary modifiers due at this side's turn start. Done before the
  // movement reset so a creature whose control reverts to this side is refreshed
  // as one of its own (it can act this turn again). "stat" re-applies the inverse
  // delta (Sénilité); "control" hands the creature back to its original owner
  // (Fiole de Psykoz "jusqu'au tour de votre adversaire").
  const allRev = state.pendingReversions ?? [];
  const expiring = allRev.filter((r) => r.expireSide === side);
  let pendingReversions = allRev;
  let reverted = state.creatures;
  if (expiring.length > 0) {
    reverted = reverted.map((c) => ({ ...c }));
    for (const rev of expiring) {
      for (const c of reverted) {
        if (c.currentLife <= 0) continue;
        if (rev.kind === "stat" && rev.instanceIds.includes(c.instanceId)) bumpStat(c, rev.field, rev.amount);
        else if (rev.kind === "control" && c.instanceId === rev.instanceId) c.owner = rev.originalOwner;
      }
    }
    pendingReversions = allRev.filter((r) => r.expireSide !== side);
  }

  // Reset movement + attack flags for creatures owned by this side.
  const creatures = reverted.map((c) =>
    c.owner === side
      ? { ...c, movementLeft: c.baseMovement, hasAttacked: false }
      : c,
  );

  // Prism reset: at the start of any turn, if no prism is left on the board, the full home set (10,
  // both sides) comes back. This is a state check (prisms.length === 0), not a flag, so the reset
  // happens however the board was emptied (pickup, destruction, Erik Rak butin transform, planting
  // over...), and only when it is really empty (one prism left, no reset). A home cell that is
  // occupied (creature or ground object) does not get its prism back, see prismCellOccupied. A
  // NEW_A_O_E event is emitted per prism that comes back, for the log/replay. `prisms` below is a
  // replace, which is safe because this only happens when state.prisms is already empty.
  const respawning = state.prisms.length === 0;
  const prisms = respawning
    ? initialPrisms().filter((p) => !prismCellOccupied(state, p.position))
    : state.prisms;
  const respawnLog: GameEvent[] = respawning
    ? prisms.map((p) => ({
        type: "NEW_A_O_E" as const,
        at: { ...p.position },
        ownerSide: p.owner,
        aoeType: `prism_${p.kind}`,
      }))
    : [];

  let next: GameState = {
    ...state,
    turn,
    activeSide: side,
    players: { ...state.players, [side]: nextPlayer },
    creatures,
    // Orbe Doré #594: this side's Dofus temporary invulnerability ticks down at the start of its turn
    // (a value of 1 set last turn protected through the opponent's combat; it expires now).
    dofuses: state.dofuses.some((d) => d.owner === side && (d.invulnerableTurns ?? 0) > 0)
      ? state.dofuses.map((d) => (d.owner === side && (d.invulnerableTurns ?? 0) > 0 ? { ...d, invulnerableTurns: (d.invulnerableTurns ?? 0) - 1 } : d))
      : state.dofuses,
    prisms,
    pendingReversions,
    log: [...state.log, { type: "TURN_STARTED", side, turn }, ...respawnLog],
  };
  // Draw one card at the start of every turn, including turn 1 for the first player (everyone draws
  // on their turn). Going second is not compensated by having the first player skip a draw, but by
  // the 4th card added at the end of the mulligan plus the banked reserve AP (see applyMulligan). So
  // the first player starts turn 1 with 4 cards (3 + this draw) and the second player starts their
  // turn with 5 (3 + 4th card + this draw).
  next = drawCard(next, side);
  // DÉBUT DU TOUR triggers, fire on every surviving creature owned by the side
  // whose turn just started (mirror of the FIN_DE_TOUR pass in endTurn). Snapshot
  // the list first so a trigger that adds/removes creatures does not disturb the
  // iteration; runTrigger re-finds each by id and no-ops if it is gone.
  const dbtLogStart = next.log.length;
  const dbtRoster = next.creatures;
  for (const me of [...next.creatures]) {
    if (me.owner !== side || me.currentLife <= 0) continue;
    if (!me.triggers.some((t) => t.trigger === "DEBUT_DE_TOUR")) continue;
    next = runTrigger(next, "DEBUT_DE_TOUR", me.instanceId);
    if (next.winner) return next;
  }
  // Damage dealt by a DÉBUT DE TOUR effect also settles its own reactions (same gap as the FIN_DE_TOUR
  // pass): a heal here (Alargix #494 / Grougaloragran #409) triggers an allied Pacificatrice Enjouée
  // #1519 that hits the enemies, and a CoinFlip branch (Griffeur Tonkino #628) can deal damage; either
  // has to fire the victims' CONTRE_COUP / ON_DAMAGE like any other damage source.
  next = settleDamageReactions(next, dbtLogStart, dbtRoster);
  if (next.winner) return next;
  return next;
}

// CONTRE_COUP ("Contre Coup"), ability text: "Exécute l'effet après avoir subi des dégâts." So it
// fires on any creature that actually took damage, to life or to armour, and survived, whatever
// the source: a hit back while attacking, a hit while defending, or a spell, allied or enemy.
//
// It fires once per damage instance, not once per creature: if a defender is hit by two attackers
// in the same phase (the front one dies, the next one in the lane advances and hits it again),
// CONTRE_COUP runs twice, e.g. Yugo tutors a second Tofu (as long as one is left in the deck). So
// we keep an ordered list of hit ids (not a Set). The list is recorded before firing, so a
// contre-coup effect that itself deals damage cannot re-trigger this pass recursively.
// Safety cap (rule 4): the recursive CONTRE_COUP cascade below can really be infinite, e.g. the
// L'Enklarveur #534 ↔ Prespic #478 ping-pong, kept going forever by Kralamor #228's heal. The
// number of reaction waves is capped so the loop ends cleanly (the remaining reactions are
// dropped); the deaths it caused still generated their AP reserve (Eliacube #250).
const CONTRE_COUP_CASCADE_CAP = 200;
// Same kind of cap (rule 4): the bystander ON_DAMAGE cascade can also be infinite, e.g. Jet le Pied
// Volant #158 charging again into an initiative strike that an immortal GARDE DU CORPS keeps
// absorbing (the loop only ends when the bodyguard finally dies). The waves are capped so a healed
// or immortal-guard variant ends cleanly; kept separate from the CONTRE_COUP cap so the two
// cascades' wave counts stay independent.
const DAMAGE_REACTION_CASCADE_CAP = 200;

// `only` (resolution sweep): only this creature reacts, for a single wave. The cascade (the damage
// its reaction produces) is not run here; it goes back into the calling sweep's list, which picks
// it up in cell order. Without `only`, the function behaves as before: all wounded creatures,
// full cascade.
export function fireContreCoup(state: GameState, fromLogIndex: number, inlineBuffed?: Map<number, number>, only?: number): GameState {
  let after = state;
  let idx = fromLogIndex;
  // Rule 4: reactions resolve recursively. A CONTRE_COUP whose effect deals new damage has to fire the
  // new victims' CONTRE_COUPs in turn, and so on. So after each wave the log is scanned again for new
  // DAMAGE (from `idx` on) and it fires again, until nothing new lands (stable) or the cap is hit.
  for (let wave = 0; wave < CONTRE_COUP_CASCADE_CAP; wave++) {
    const hits: { target: number; attacker: number }[] = [];
    for (let i = idx; i < after.log.length; i++) {
      const ev = after.log[i] as { type: string; targetInstanceId?: number; sourceInstanceId?: number; damage?: number; armorHit?: boolean };
      // A hit "lands" (subir des dégâts) when it costs life or chews ARMOUR, both
      // arrive as a single DAMAGE event per hit, so we never double-count. We also
      // record the source (the attacker) for "targetAttacker" contre-coups.
      if (ev.type === "DAMAGE" && typeof ev.targetInstanceId === "number" && ((ev.damage ?? 0) > 0 || ev.armorHit)) {
        if (only !== undefined && ev.targetInstanceId !== only) continue; // balayage : une case à la fois
        hits.push({ target: ev.targetInstanceId, attacker: ev.sourceInstanceId ?? -1 });
      }
    }
    idx = after.log.length; // the next wave reacts only to damage these reactions generate
    if (hits.length === 0) break; // stable, no new "subir des dégâts" to react to
    for (const { target: id, attacker } of hits) {
      const c = after.creatures.find((x) => x.instanceId === id && x.currentLife > 0);
      if (!c) continue; // died → MORT handles it, not a post-damage reaction
      // Low-PV bounce (Arakne #420 / Grougaloragran #161): reduced to ≤ threshold but
      // alive → it escapes back to its owner's hand (fresh card). Checked before
      // CONTRE_COUP since it leaves the board.
      const bounce = (getCard(c.cardId)?.effects ?? []).find((e) => e.type === "BounceBelowPv") as { threshold?: number } | undefined;
      if (bounce && c.currentLife <= (bounce.threshold ?? 0)) {
        after = bounceCreature(after, c.position, "hand");
        continue;
      }
      if (!c.triggers.some((t) => t.trigger === "CONTRE_COUP")) continue;
      // A pure self stat-buff CONTRE COUP (Laon #153 / Mandhal #393 / Tristecoeur #366) already applied
      // inline the instant this creature took combat damage during its advance, decrement per damage
      // instance and skip, so it is not applied twice. A NON-inline hit (spell, enemy defender) still fires.
      if (inlineBuffed) {
        const n = inlineBuffed.get(id) ?? 0;
        if (n > 0) { inlineBuffed.set(id, n - 1); continue; }
      }
      // "targetAttacker" effects (Belgodass #756 / Polter #399 / Anathar #316): captured
      // before runTrigger (which skips them) and applied to the creature that hit us.
      const atkEffects = c.triggers.filter((t) => t.trigger === "CONTRE_COUP").flatMap((t) => t.effects).filter((e) => (e as { targetAttacker?: boolean }).targetAttacker);
      const caster = c.owner, self = c.instanceId;
      after = runTrigger(after, "CONTRE_COUP", id);
      if (after.winner) return after;
      if (atkEffects.length > 0 && attacker >= 0) {
        after = applyEffectsToAttacker(after, atkEffects, caster, self, attacker);
        if (after.winner) return after;
      }
    }
    if (only !== undefined) break; // a single wave: what follows goes back into the cell-by-cell sweep
  }
  return after;
}

// Apply a CONTRE_COUP's "targetAttacker" effects (silence / transform / take-control)
// to the creature that just dealt the damage (the DAMAGE event's sourceInstanceId).
// Mirrors the snapshot-then-settle pattern of the other state-level effect helpers.
function applyEffectsToAttacker(state: GameState, effects: Effect[], casterSide: Side, selfInstanceId: number, attackerInstanceId: number): GameState {
  const attacker = state.creatures.find((c) => c.instanceId === attackerInstanceId && c.currentLife > 0);
  if (!attacker || effects.length === 0) return state;
  const attackerCell = { ...attacker.position };
  let result = state;
  // Creature effects (Silence #756) run on a snapshot; player-state effects
  // (TransformIntoBush #399, board-object) route through applyPlayerStateEffect with
  // the attacker's cell as the target.
  const creatureEffs = effects.filter((e) => !PLAYER_STATE_TYPES.has(e.type));
  const playerEffs = effects.filter((e) => PLAYER_STATE_TYPES.has(e.type));
  if (creatureEffs.length > 0) {
    const creatures = result.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
    const dofuses = result.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
    const log: GameEvent[] = [...result.log];
    // Seeded rng passed down and stored back: a targetAttacker CONTRE COUP can carry a random effect
    // (transform), so it must never use the global generator.
    const atkRng = new Rng(result.rng);
    applyEffects(creatures, dofuses, log, creatureEffs, { casterSide, selfInstanceId, targetCell: attackerCell, diceFloor: result.players[casterSide].diceFloor, rng: atkRng });
    result = resolveDeathsAndWin({ ...result, creatures, dofuses, log, rng: atkRng.state }, creatures, dofuses, log, new Set());
    // Anathar #316 "prend le contrôle … tant qu'il est en vie": seizing the attacker
    // creates a control reversion LINKED to the contre-coup creature, it hands the
    // attacker back to its original owner when Anathar (selfInstanceId) dies.
    const whileAlive = creatureEffs.some((e) => e.type === "TakeControl" && (e as { whileSourceAlive?: boolean }).whileSourceAlive);
    if (whileAlive && result.creatures.some((c) => c.instanceId === attackerInstanceId && c.owner === casterSide)) {
      result = { ...result, pendingReversions: [...(result.pendingReversions ?? []), { kind: "control", instanceId: attackerInstanceId, originalOwner: attacker.owner, linkedTo: selfInstanceId }] };
    }
  }
  for (const e of playerEffs) {
    if (result.winner) break;
    result = applyPlayerStateEffect(result, e, casterSide, attackerCell).state;
  }
  return result;
}

// Reactive ON_DAMAGE ("charge / gagne +N quand un <X> subit des dégâts"): a bystander whose filter
// matches an entity hit in this batch fires its own ON_DAMAGE trigger, a self effect (Chacha
// Teigne charges, Requin Lancier gains AT, Jet le Pied Volant #158 charges). Recursive, like
// fireContreCoup (rule 4 / combo 2): after each wave the log is scanned again for new damage and
// the matching reactors fire again, so a reactor whose own reaction produces new matching damage
// (Jet charging again into a guard-soaked initiative strike) keeps firing. The loop runs as long
// as the bodyguard survives, bounded by DAMAGE_REACTION_CASCADE_CAP.
// The per-wave `idx = log.length` step matters: each wave reacts only to the previous wave's new
// damage, so a single hit is never counted twice. Chacha Teigne #732 / Requin Lancier #33 still
// fire exactly once per original hit (their reactions produce no matching damage, so wave 1 is
// empty).
// `deferred` (passed only by endTurn) goes into the reactor's runTrigger so a CHARGE it performs
// keeps deferring a guard-soaked initiative counter (combo 2).
function fireDamageReactions(state: GameState, fromLogIndex: number, deferred?: { attackerId: number; targetId: number }[], victimRoster?: readonly CreatureInstance[]): GameState {
  let after = state;
  let idx = fromLogIndex;
  for (let wave = 0; wave < DAMAGE_REACTION_CASCADE_CAP; wave++) {
    const hitCreatureIds = new Set<number>();
    const hitDofusCells: { x: number; y: number }[] = [];
    for (let i = idx; i < after.log.length; i++) {
      const ev = after.log[i] as { type: string; targetInstanceId?: number; targetCell?: { x: number; y: number }; damage?: number; armorHit?: boolean };
      if (ev.type !== "DAMAGE" || !((ev.damage ?? 0) > 0 || ev.armorHit)) continue;
      if (typeof ev.targetInstanceId === "number") hitCreatureIds.add(ev.targetInstanceId);
      else if (ev.targetCell) hitDofusCells.push(ev.targetCell);
    }
    idx = after.log.length; // the next wave reacts only to damage these reactions produce
    if (hitCreatureIds.size === 0 && hitDofusCells.length === 0) break; // stable, no new damage
    // Filter lookups must still find a victim that died from the very damage being reacted to: a
    // lethal hit back still "wounded an ally", so Jet le Pied Volant #158 must charge when your
    // creature dies in combat. after.creatures is post-cull, so the pre-phase `victimRoster` (which
    // still holds the dead victims) is laid under the live board (live entries win).
    const victimBoard = new Map<number, CreatureInstance>();
    for (const c of victimRoster ?? []) victimBoard.set(c.instanceId, c);
    for (const c of after.creatures) victimBoard.set(c.instanceId, c);
    const reactorIds = after.creatures
      .filter((r) => r.currentLife > 0 && r.triggers.some((t) => t.trigger === "ON_DAMAGE"))
      .map((r) => r.instanceId);
    for (const rid of reactorIds) {
      const r = after.creatures.find((c) => c.instanceId === rid && c.currentLife > 0);
      if (!r) continue; // died to an earlier reactor's combat
      const f = r.triggers.find((t) => t.trigger === "ON_DAMAGE")?.filter ?? {};
      const creatureMatches = [...hitCreatureIds].filter((did) => {
        if (f.excludeSelf && did === rid) return false;
        const dc = victimBoard.get(did);
        if (!dc) return false;
        if (f.side === "ally" && dc.owner !== r.owner) return false;
        if (f.side === "enemy" && dc.owner === r.owner) return false;
        if (f.family && !(famsOf(dc)).includes(f.family)) return false;
        return true;
      }).length;
      const dofusMatches = !f.includeDofus ? 0 : hitDofusCells.filter((cell) => {
        const d = after.dofuses.find((df) => df.position.x === cell.x && df.position.y === cell.y);
        if (!d) return false;
        if (f.side === "ally" && d.owner !== r.owner) return false;
        if (f.side === "enemy" && d.owner === r.owner) return false;
        return true;
      }).length;
      // Fire once per matching hit in this wave (a zone effect wounding several matching entities
      // repeats the reaction, Chacha Teigne #732 advances 1 per damaged allied Chacha). matchCount
      // comes from this wave's fresh slice, so a reaction's own damage is reacted to next wave (not
      // double-counted). Stop early if the reactor dies mid-way.
      const matchCount = creatureMatches + dofusMatches;
      for (let k = 0; k < matchCount; k++) {
        after = runTrigger(after, "ON_DAMAGE", rid, undefined, deferred);
        if (after.winner) return after;
        if (!after.creatures.some((c) => c.instanceId === rid && c.currentLife > 0)) break;
      }
    }
  }
  return after;
}

// A targeted pending resolution that deals DAMAGE and returns EARLY (the two-step "cost-then-effect"
// spells: Lame Émoussée #1177, Sacrifice #576, Pluie de Météorites #1350, Pampactus #218, Punition
// #189) skips resolvePendingAction's general tail, so without this its damage would never fire
// CONTRE_COUP (Boo #513 summoning another Boo when it survives damage, ripostes, Goule Ash self-death)
// or bystander ON_DAMAGE reactions (Jet le Pied Volant #158, Chacha Teigne #732). Each such branch
// routes its post-damage state through here so a DAMAGE event always triggers the same reactions the
// fall-through path (and combat) fire. `fromLogIndex` = the log length before the branch's damage was
// applied. Mirrors the tail order: contre-coup then bystanders.
function settleDamageReactions(state: GameState, fromLogIndex: number, victimRoster?: readonly CreatureInstance[]): GameState {
  let after = fireContreCoup(state, fromLogIndex);
  after = fireDamageReactions(after, fromLogIndex, undefined, victimRoster); // roster: react even to a victim this damage killed
  if (victimRoster) after = payMissingPosthumousContreCoups(after, fromLogIndex, victimRoster);
  return after;
}

// A victim hit several times before dying only got one contre-coup (Momie #360 with 2 HP, hit by
// two Disciples de l'Agonie #1163, gave back 1 AP instead of 2). The rule is "one hit = one
// contre-coup", and the surviving case already follows it (n hits, n triggers). The dead case lost
// it: resolveDeathsAndWin only adds one posthumous hit back per corpse, and fireContreCoup skips
// the earlier hits since the target is no longer on the board. So the (n − 1) missing ones are paid
// here, when the volley settles and the pre-volley roster still gives access to the dead
// creature's triggers.
//
// Limited to the owner's resource effects (POSTHUMOUS_PLAYER_STATE_CC): the only ones that make
// sense without a living body, and the only ones whose repetition is unambiguous. A hit back on
// the killer or an area burst stays at one copy (the one from resolveDeathsAndWin).
function payMissingPosthumousContreCoups(
  state: GameState,
  fromLogIndex: number,
  roster: readonly CreatureInstance[],
): GameState {
  const hits = new Map<number, number>();
  for (let i = fromLogIndex; i < state.log.length; i++) {
    const ev = state.log[i] as { type: string; targetInstanceId?: number; damage?: number; armorHit?: boolean };
    if (ev.type !== "DAMAGE" || typeof ev.targetInstanceId !== "number") continue;
    if (!((ev.damage ?? 0) > 0 || ev.armorHit)) continue; // same definition of "subir des dégâts" as fireContreCoup
    hits.set(ev.targetInstanceId, (hits.get(ev.targetInstanceId) ?? 0) + 1);
  }
  let result = state;
  for (const [id, n] of hits) {
    if (n < 2) continue; // a single hit: already paid, by the living path or the posthumous one
    if (result.creatures.some((c) => c.instanceId === id && c.currentLife > 0)) continue; // survivante : fireContreCoup a tout payé
    const victim = roster.find((c) => c.instanceId === id);
    if (!victim) continue;
    const effs = victim.triggers
      .filter((t) => t.trigger === "CONTRE_COUP")
      .flatMap((t) => t.effects)
      .filter((e) => !(e as { targetAttacker?: boolean }).targetAttacker && POSTHUMOUS_PLAYER_STATE_CC.has(e.type));
    if (effs.length === 0) continue;
    for (let k = 1; k < n && !result.winner; k++) {
      for (const eff of effs) {
        if (result.winner) break;
        result = applyPlayerStateEffect(result, eff, victim.owner, undefined, { ...victim.position }).state;
      }
    }
  }
  return result;
}

// Combo 2: replay the counters that were deferred when an initiative first strike was soaked by a
// GARDE DU CORPS. By now the bodyguard's full sub-wave (its death, CONTRE_COUP, bystander ON_DAMAGE
// like Jet le Pied Volant #158) has resolved, since endTurn ran fireContreCoup /
// fireDamageReactions first. Each counter lands only if both fighters are still alive and still
// adjacent (a reaction may have killed or moved either), uses the attacker's current attack,
// respects the target's own bodyguard (overflow spills back), then resolves its own consequences.
function resolveDeferredCounters(state: GameState, counters: { attackerId: number; targetId: number }[]): GameState {
  let after = state;
  for (const { attackerId, targetId } of counters) {
    const logBefore = after.log.length;
    const creatures = after.creatures.map((c) => ({ ...c, position: { ...c.position } }));
    const dofuses = after.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
    const log = [...after.log];
    const attacker = creatures.find((c) => c.instanceId === attackerId && c.currentLife > 0);
    const target = creatures.find((c) => c.instanceId === targetId && c.currentLife > 0);
    if (!attacker || !target) continue; // a reaction already removed one of them, no counter
    const adjacent = attacker.position.y === target.position.y && Math.abs(attacker.position.x - target.position.x) === 1;
    if (!adjacent) continue; // displaced out of melee, no counter
    const pierces = attacker.properties.has("PierceArmor");
    const guard = guardOf(target, creatures);
    const recipient = guard ?? target;
    const recArmor0 = recipient.armor, recLife0 = recipient.currentLife;
    const dealt = applyDamageToCreature(recipient, attacker.currentAttack, log, pierces);
    log.push({ type: "DAMAGE", sourceInstanceId: attacker.instanceId, targetInstanceId: recipient.instanceId, damage: dealt, armorHit: recArmor0 > recipient.armor });
    if (recipient.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", instanceId: recipient.instanceId });
    if (guard) {
      const spill = Math.max(0, dealt - recLife0);
      if (spill > 0) {
        const tArmor0 = target.armor;
        const through = applyDamageToCreature(target, spill, log, pierces);
        log.push({ type: "DAMAGE", sourceInstanceId: attacker.instanceId, targetInstanceId: target.instanceId, damage: through, armorHit: tArmor0 > target.armor });
        if (target.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", instanceId: target.instanceId });
      }
    }
    after = resolveDeathsAndWin({ ...after, creatures, dofuses, log }, creatures, dofuses, log, new Set());
    if (after.winner) return after;
    after = fireContreCoup(after, logBefore);
    if (after.winner) return after;
    after = fireDamageReactions(after, logBefore, undefined, creatures); // roster: react even to a victim the counter killed
    if (after.winner) return after;
  }
  return after;
}

// COUP DE GRÂCE attribution: for each creature that died in a combat that just resolved
// (currentLife<=0), the killer is the source of the last damage it took (same log scan as
// CONTRE_COUP / TeleportBehindAttacker). Must be called on the pre-cull creatures array so the
// victim's card id / owner / freed cell are still known. Shared by the end-of-turn combat phase
// and the charge paths (applyChargeOnSummon / applyChargeAlliesOnState), so a kill made during a
// charge fires COUP DE GRÂCE too (Milkar #46 "COUP DE GRÂCE : Charge" killing on its APPARITION
// charge).
//
// A creature that broke through (capture of a Dofus) is not a kill, and two guards make sure of it:
//   1. It has currentLife = 0 (set by the break-through), and the log covers the whole game (only
//      createGame clears it). An unbounded backward scan could find a DAMAGE from an earlier turn
//      and give it a killer, so a capture was counted as a COUP DE GRÂCE kill, against the rule
//      "a capture is not a death".
//   2. A shooter that destroys the Dofus at contact is another break-through site with the same
//      problem.
// So `brokeThroughIds` excludes the creatures that broke through, and `fromLogIndex` limits the
// backward scan to the current sequence.
function collectCdgKills(
  creatures: CreatureInstance[],
  log: GameEvent[],
  brokeThroughIds: ReadonlySet<number> = new Set<number>(),
  fromLogIndex = 0,
): { killerId: number; victimCardId: number; victimOwner: Side; victimPosition: Coords }[] {
  return creatures
    .filter((c) => c.currentLife <= 0 && !brokeThroughIds.has(c.instanceId))
    .map((victim) => {
      let killerId: number | undefined;
      for (let i = log.length - 1; i >= fromLogIndex; i--) {
        const ev = log[i];
        if (ev.type === "DAMAGE" && ev.targetInstanceId === victim.instanceId && ev.sourceInstanceId != null) {
          killerId = ev.sourceInstanceId;
          break;
        }
      }
      return { killerId, victimCardId: victim.cardId, victimOwner: victim.owner, victimPosition: { ...victim.position } };
    })
    .filter((k): k is { killerId: number; victimCardId: number; victimOwner: Side; victimPosition: Coords } => k.killerId != null);
}

// COUP DE GRÂCE ("Coup de grâce"): a creature that delivers a killing blow in combat and survives
// the exchange fires this trigger, once per enemy it killed. `kills` holds, per victim, the
// killer's id and the victim's card id/owner, captured before the victim is culled so a kill
// bounce (Qilby) still knows what to move. A killer that died in the exchange is skipped (we check
// again that it is alive in the post-combat state).
function fireCoupDeGrace(
  state: GameState,
  kills: { killerId: number; victimCardId: number; victimOwner: Side }[],
  // COUP DE GRÂCE auto-buffs already applied inline at the moment of the kill (Tsar Tsu Tsu #138):
  // that many pure auto-buff firings are skipped so they are not doubled. Absent outside the
  // end-of-turn advance.
  inlineBuffed?: Map<number, number>,
  // Truche Foldingue #434: ids whose switch coin flip was already played inline, at the moment of the
  // kill. Without this filter the trigger would start again here and flip the coin a second time, and
  // the Truche could then go back to its original camp.
  alreadyDefected?: Set<number>,
): GameState {
  let result = state;
  for (const k of kills) {
    if (result.winner) break;
    if (alreadyDefected?.has(k.killerId)) continue;
    const killer = result.creatures.find((c) => c.instanceId === k.killerId && c.currentLife > 0);
    if (!killer) continue; // killer died in the exchange → no coup de grâce
    const trig = killer.triggers.find((t) => t.trigger === "COUP_DE_GRACE");
    if (!trig || trig.effects.length === 0) continue;
    // Déjà appliqué inline (auto-buff pur) → décrémente et saute ce firing.
    if ((inlineBuffed?.get(k.killerId) ?? 0) > 0 && coupDeGraceSelfStatBuffs(killer)) {
      inlineBuffed!.set(k.killerId, inlineBuffed!.get(k.killerId)! - 1);
      continue;
    }
    // Qilby: the killed enemy goes to the KILLER's hand instead of its owner's
    // discard (where resolveDeathsAndWin just placed it).
    if (trig.effects.some((e) => e.type === "BounceKilledToHand")) {
      result = bounceKilledCardToHand(result, k.victimCardId, k.victimOwner, killer.owner);
    }
    // Remaining player-state effects (Sphincter Cell: "récupère le dernier rat de
    // votre défausse") fire through the normal trigger path, owned by the killer.
    if (trig.effects.some((e) => e.type !== "BounceKilledToHand")) {
      result = runTrigger(result, "COUP_DE_GRACE", k.killerId);
    }
  }
  return result;
}

// Toutancoffron #633 (TransformKilledToButin): "Transforme en Butin allié les invocations qu'il
// détruit." For each kill in this combat whose killer is a living carrier of the marker, drop a
// Butin owned by the killer's side on the cell the victim freed. The victim already died normally
// (MORT + discard handled by resolveDeathsAndWin); this is a side effect, not a silent transform.
// The killer must have survived the exchange (same convention as COUP DE GRÂCE). One Butin per
// victim; skipped if a Dofus or a Butin already holds that cell (the killer itself may stand on
// it: a Butin can share a cell with a creature, and is only picked up once something is later
// summoned onto or walks onto the cell).
function applyKillToButin(
  state: GameState,
  kills: { killerId: number; victimOwner: Side; victimPosition: Coords }[],
): GameState {
  let butins = state.butins ?? [];
  const log = [...state.log];
  let changed = false;
  for (const k of kills) {
    const killer = state.creatures.find((c) => c.instanceId === k.killerId && c.currentLife > 0);
    if (!killer) continue; // killer died in the exchange → no loot (COUP DE GRÂCE convention)
    if (!(getCard(killer.cardId)?.effects ?? []).some((e) => e.type === "TransformKilledToButin")) continue;
    const cell = k.victimPosition;
    if (state.dofuses.some((d) => sameCoords(d.position, cell))) continue; // never under a Dofus
    if (butins.some((b) => sameCoords(b.position, cell))) continue;        // one Butin per cell
    butins = [...butins, { position: { ...cell }, owner: killer.owner }];
    log.push({ type: "NEW_A_O_E", at: { ...cell }, ownerSide: killer.owner, aoeType: "loot" });
    changed = true;
  }
  return changed ? { ...state, butins, log } : state;
}

// Move a just-killed victim's card from its owner's discard to the killer's hand
// (Qilby's coup de grâce). No-op if the card is not in that discard (a Nécrome is
// banished, a break-through victim recycles to the deck instead).
function bounceKilledCardToHand(state: GameState, victimCardId: number, victimOwner: Side, toSide: Side): GameState {
  const vp = state.players[victimOwner];
  const idx = vp.discard.lastIndexOf(victimCardId);
  if (idx < 0) return state;
  const discard = [...vp.discard.slice(0, idx), ...vp.discard.slice(idx + 1)];
  let result: GameState = { ...state, players: { ...state.players, [victimOwner]: { ...vp, discard } } };
  result = addCardToHand(result, toSide, victimCardId, 1);
  return result;
}

// Does a freshly-summoned creature wake `trig` (an ENTERS_PLAY reaction carried by
// `reactor`)? `side` is read relative to the reactor; `family` narrows it. The
// reactor is never the summoned creature, so excludeSelf needs no extra check.
function entersPlayFilterMatches(trig: Trigger, summoned: CreatureInstance, reactor: CreatureInstance): boolean {
  const f = trig.filter;
  if (!f) return false;
  if (f.side === "ally" && summoned.owner !== reactor.owner) return false;
  if (f.side === "enemy" && summoned.owner === reactor.owner) return false;
  if (f.family && !(famsOf(summoned)).includes(f.family)) return false;
  return true;
}

// Reactive ENTERS_PLAY: when `summonedId` lands, every other living creature whose
// ENTERS_PLAY filter matches it fires now (Welsh gains +1/+1 on an enemy summon,
// Gzenah on an allied Iop). The buffs touch only the reactors, so no recursion.
function fireEntersPlayReactions(state: GameState, summonedId: number): GameState {
  const summoned0 = state.creatures.find((c) => c.instanceId === summonedId);
  if (!summoned0) return state;
  const reactorIds = state.creatures
    .filter((r) => r.instanceId !== summonedId && r.currentLife > 0 &&
      r.triggers.some((t) => t.trigger === "ENTERS_PLAY" && entersPlayFilterMatches(t, summoned0, r)))
    .map((r) => r.instanceId);
  let result = state;
  for (const rid of reactorIds) {
    if (result.winner || result.pendingAction) break;
    const reactor = result.creatures.find((c) => c.instanceId === rid);
    const summoned = result.creatures.find((c) => c.instanceId === summonedId && c.currentLife > 0);
    if (!reactor || !summoned) continue;
    const trig = reactor.triggers.find((t) => t.trigger === "ENTERS_PLAY" && entersPlayFilterMatches(t, summoned, reactor));
    if (trig?.entrant) {
      // Grany #289 / Shin Larve #500: the ENTERING creature gains a permanent buff
      // (not the reactor itself). Julith Jurgen #432: the entrant instead takes
      // DamageData. Apply the trigger's effects to the newcomer.
      result = applyEntrantEntryBuff(result, summonedId, trig.effects, rid);
    } else {
      result = runTrigger(result, "ENTERS_PLAY", rid);
    }
  }
  return result;
}

// Apply an ENTERS_PLAY `entrant` trigger's effects to the creature that was just summoned: stat
// buffs (BoostAttack/BoostArmor, single target on its own cell) plus an optional Charge (moves it
// now via applyChargeOnSummon). Grany #289 / Shin Larve #500.
// Julith Jurgen #432 ("inflige N dégât(s) aux invocations adverses qui entrent en jeu") uses a
// DamageData on the same `entrant` path: the entrant takes the damage (from the reactor Julith)
// and deaths/win are settled right after. With two Julith on the board each fires its own
// reaction, so the entrant takes 1+1.
function applyEntrantEntryBuff(state: GameState, entrantId: number, effects: Effect[], reactorId?: number): GameState {
  const me = state.creatures.find((c) => c.instanceId === entrantId && c.currentLife > 0);
  if (!me) return state;
  let result = state;
  // Seeded rng passed down and stored back: these are trigger effects defined by cards, and a random
  // one (dice damage, transform) must never use the global generator.
  const entryRng = new Rng(result.rng);
  const dmgEffs = effects.filter((e) => e.type === "DamageData");
  const statEffs = effects.filter((e) => e.type !== "Charge" && e.type !== "ChargeSelf" && e.type !== "DamageData");
  if (statEffs.length > 0) {
    const creatures = result.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
    const dofuses = result.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
    const log: GameEvent[] = [...result.log];
    applyEffects(creatures, dofuses, log, statEffs, { casterSide: me.owner, targetCell: { ...me.position }, selfInstanceId: entrantId, rng: entryRng });
    result = { ...result, creatures, dofuses, log, rng: entryRng.state };
  }
  // DamageData on the entrant (Julith Jurgen #432): hit the newcomer on its own cell,
  // then resolve deaths + win condition (mirror of how spell/charge damage settles).
  if (dmgEffs.length > 0) {
    const creatures = result.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
    const dofuses = result.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
    const log: GameEvent[] = [...result.log];
    const entrant = creatures.find((c) => c.instanceId === entrantId && c.currentLife > 0);
    if (entrant) {
      applyEffects(creatures, dofuses, log, dmgEffs, {
        casterSide: result.creatures.find((c) => c.instanceId === reactorId)?.owner ?? me.owner,
        targetCell: { ...entrant.position },
        sourceInstanceId: reactorId,
        rng: entryRng,
      });
      result = resolveDeathsAndWin({ ...result, creatures, dofuses, log, rng: entryRng.state }, creatures, dofuses, log, new Set<number>());
    }
  }
  const charge = effects.find((e) => e.type === "Charge" || e.type === "ChargeSelf") as { cells?: number } | undefined;
  if (charge) result = applyChargeOnSummon(result, entrantId, Math.max(0, (charge.cells ?? 0) | 0));
  return result;
}

// Reactive ON_PLAY ("quand vous jouez un sort / une carte / une invocation"): when `playerSide`
// plays `playedCard`, each of their living creatures whose ON_PLAY filter matches the card's type
// fires now. For a summon this fires from inside the APPARITION phase (fireApparitionPhase), after
// the played creature's own APPARITION has resolved, so its effect lands before bystanders react
// to the play. `excludeId` is the creature just summoned: it is on the board by then, so it is
// skipped (a creature does not react to its own entrance).
// A planted seed reaches here as SEED_AS_CARD, with cardType "Aoe", so it counts as a spell and
// fires the "quand vous jouez un SORT" reactors too. See plantSeed.
function fireOnPlayReactions(state: GameState, playerSide: Side, playedCard: Card, excludeId?: number): GameState {
  const playedType: "spell" | "summon" = playedCard.cardType === "Summon" ? "summon" : "spell";
  const reactorIds = state.creatures
    .filter((r) => r.currentLife > 0 && r.instanceId !== excludeId &&
      r.triggers.some((t) => {
        if (t.trigger !== "ON_PLAY") return false;
        const ct = t.filter?.cardType;
        if (ct && ct !== playedType) return false;
        // rarity filter (Sigrun #917 "quand votre adversaire joue une carte Krosmic").
        const rar = (t.filter as { rarity?: string } | undefined)?.rarity;
        if (rar && (playedCard as { rarity?: string }).rarity !== rar) return false;
        // family filter (Sipho #603/#751 "quand un membre de la fratrie des Oubliés est joué" only reacts to
        // plays of a card of that family).
        const fam = t.filter?.family;
        if (fam && !(playedCard.families ?? []).includes(fam)) return false;
        // filter.side "enemy" → react to the OPPONENT's plays (Lilotte #569 "quand
        // votre adversaire joue") ; default / "ally" → react to your own plays.
        const isOwnPlay = r.owner === playerSide;
        return t.filter?.side === "enemy" ? !isOwnPlay : isOwnPlay;
      }))
    .map((r) => r.instanceId);
  let result = state;
  for (const rid of reactorIds) {
    if (result.winner || result.pendingAction) break;
    result = runTrigger(result, "ON_PLAY", rid);
  }
  return result;
}

// Re-entrancy guard for ON_PRISM reactions: a Lilotte #579 charging onto another prism
// would pick it up mid-reaction; we do not want that pickup to recursively fire a fresh
// wave (it terminates, prisms are finite, but the chain would be surprising). So the
// first prism event fires every Lilotte once; pickups caused by those charges do not
// re-fire. Single-threaded engine; the flag is always cleared in `finally`.
let _firingPrismReactions = false;

// Reactive ON_PRISM ("charge de N cases quand un prisme est ramassé ou détruit", Lilotte #579):
// every living creature with an ON_PRISM trigger fires now. Called from activatePrism (a pickup,
// once per prism) and from the prism destruction handlers (DestroyPrism / DestroyAllEnemyPrisms /
// DestroyPrismOnRow, once per destroy effect), after the prism has left the board.
function fireOnPrismReactions(state: GameState, excludeInstanceId?: number): GameState {
  if (_firingPrismReactions) return state;
  // `excludeInstanceId` (Lilotte #579): the creature that just landed on the picked-up prism does not
  // react to it, because prisms resolve before any creature effect, including the new creature's
  // own. Passed only by the pickup path (activatePrism); destruction fires all.
  const reactorIds = state.creatures
    .filter((r) => r.currentLife > 0 && r.instanceId !== excludeInstanceId && r.triggers.some((t) => t.trigger === "ON_PRISM"))
    .map((r) => r.instanceId);
  if (reactorIds.length === 0) return state;
  _firingPrismReactions = true;
  try {
    let result = state;
    for (const rid of reactorIds) {
      // NB: we do not break on result.pendingAction here. A prism destroyed by a
      // trigger pick (Patek Tag #363) fires this from inside resolvePendingAction,
      // where that pending is not cleared until the resolve returns, breaking on it
      // would skip every reactor. ChargeSelf opens no pick of its own, so it is safe.
      if (result.winner) break;
      result = runTrigger(result, "ON_PRISM", rid);
    }
    return result;
  } finally {
    _firingPrismReactions = false;
  }
}

// End the current player's turn and hand control to the other side.
//
// Krosmaga's "advance phase" runs here, between the click on Fin de tour and
// the opponent picking up the cards: every creature owned by the active
// player walks forward using every remaining movementLeft. If they bump into
// an enemy creature or Dofus on the way, they stop and attack, combat is
// simultaneous (both sides deal damage), so a 2/3 hitting a 3/2 results in
// both dying. We then cull dead creatures, broken Dofuses, and check the
// win condition before handing turn to the other side.
export function endTurn(state: GameState): GameState {
  if (state.winner) return state;
  // 0. Trucage expires here, before the movement phase: it only forces Pile on
  //    coin flips made while the player was actively playing cards, never on the
  //    flips that occur during the end-of-turn creature movement.
  if (state.players[state.activeSide].coinForcedPile) {
    const p = state.players[state.activeSide];
    state = { ...state, players: { ...state.players, [state.activeSide]: { ...p, coinForcedPile: false } } };
  }
  // 0b. Dé Pipé's dice floor expires here too (it only applies "durant ce tour").
  if (state.players[state.activeSide].diceFloor) {
    const p = state.players[state.activeSide];
    state = { ...state, players: { ...state.players, [state.activeSide]: { ...p, diceFloor: 0 } } };
  }
  // 0c. Repos Éternel's "pay with discard" mode expires here too ("durant ce tour").
  if (state.players[state.activeSide].discardPaysCost) {
    const p = state.players[state.activeSide];
    state = { ...state, players: { ...state.players, [state.activeSide]: { ...p, discardPaysCost: false } } };
  }
  // 0e. Ralentissement #188's one-turn hand surcharge lifts at the end of the
  //     surcharged player's turn. It was stamped on this player during the OPPONENT's
  //     turn, survived the opponent's endTurn (we only clear the ending player's own
  //     temp), and now expires after this player has had their full turn with it.
  if ((state.players[state.activeSide].handCostTempMods ?? []).some((m) => m !== 0)) {
    const p = state.players[state.activeSide];
    state = { ...state, players: { ...state.players, [state.activeSide]: { ...p, handCostTempMods: undefined } } };
  }
  // 0d. Active traps (Sram) the active player still holds tick down here: any whose
  //     counter hits 0 (not played this turn) DETONATES, each of the holder's Dofus
  //     takes the penalty and the card leaves their hand.
  if ((state.players[state.activeSide].activeTraps ?? []).length > 0) {
    const side = state.activeSide;
    const p = state.players[side];
    let hand = [...p.hand];
    let handCostMods = [...p.handCostMods];
    const survivors: { cardId: number; counter: number; penalty: number }[] = [];
    // Héroïne Perfide #1254 (ActivatedTrapAura, owned by the opponent of the trap
    // holder) makes each detonation hit for +damageBonus.
    const perfideBonus = state.creatures.reduce((acc, c) => {
      if (c.currentLife <= 0 || c.owner !== other(side)) return acc;
      const aura = activatedTrapAuraOf(c.cardId);
      return acc + (aura ? aura.damageBonus : 0);
    }, 0);
    let totalPenalty = 0;
    let buffAtk = 0, buffArm = 0; // Boufballe #1137: enemy-creature stat buff on expiry
    for (const t of p.activeTraps ?? []) {
      if (t.counter - 1 <= 0) {
        const hi = hand.indexOf(t.cardId); // drop one copy of the detonated card
        if (hi >= 0) { hand = [...hand.slice(0, hi), ...hand.slice(hi + 1)]; handCostMods = [...handCostMods.slice(0, hi), ...handCostMods.slice(hi + 1)]; }
        // Boufballe expires as a buff (no Dofus penalty); a Sram trap as a Dofus penalty.
        if (t.buffEnemy) { buffAtk += t.buffEnemy.attack | 0; buffArm += t.buffEnemy.armor | 0; }
        else totalPenalty += t.penalty + perfideBonus;
      } else {
        survivors.push({ ...t, counter: t.counter - 1 });
      }
    }
    state = { ...state, players: { ...state.players, [side]: { ...p, hand, handCostMods, activeTraps: survivors } } };
    // Boufballe detonation: the holder (`side`) failed to send it back in time, so the holder's enemy
    // creatures (the side that threw it over) gain the permanent buff. Applied once to the board
    // present at expiry. casterSide = side, so the scope "enemies" hits exactly the holder's opponent.
    if (buffAtk > 0 || buffArm > 0) {
      const creatures = state.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
      const dofuses = state.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
      const log = [...state.log];
      const buffEffs: Effect[] = [];
      if (buffAtk > 0) buffEffs.push({ type: "BoostAttack", amount: buffAtk, scope: "enemies" } as Effect);
      if (buffArm > 0) buffEffs.push({ type: "BoostArmor", amount: buffArm, scope: "enemies" } as Effect);
      applyEffects(creatures, dofuses, log, buffEffs, { casterSide: side, diceFloor: state.players[side].diceFloor });
      state = { ...state, creatures, dofuses, log };
    }
    if (totalPenalty > 0) {
      // Clone the dofuses first, then route each holder Dofus through woundDofus so an attached
      // Sinistro breaks when its host is wounded by the trap (the Dofus still takes the penalty).
      const dofuses = state.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
      // The creatures have to be cloned too: woundDofus goes through this array for Julith Jurgen #352
      // and Héros Martyr #956, and their hit back writes into the objects it gets. Passing
      // state.creatures made the trap detonation write into the input state, so into the snapshot
      // already saved in the replay history and into a state the AI searches again. Same cloning as the
      // Boufballe branch just above. No change to game behaviour.
      const creatures = state.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
      const log = [...state.log];
      for (const d of dofuses) if (d.owner === side && d.currentLife > 0) woundDofus(d, totalPenalty, log, creatures, dofuses);
      state = resolveDeathsAndWin({ ...state, creatures, dofuses }, creatures, dofuses, log, new Set());
    }
  }
  // 1. FIN_DE_TOUR triggers fire the moment the player ends their turn, before creatures advance
  //    (the few "à la fin des déplacements" effects, Ben Debouche, Lapino, Forbank, use POST_ADVANCE
  //    below instead). Only the active side's surviving creatures: "fin du tour" fires for your
  //    creatures at the end of your turn, not at the end of every turn.
  // Pre-phase snapshot: every FIN_DE_TOUR trigger checks its condition on the board as it was the
  // moment the player ended their turn, so end-of-turn effects cannot interact with each other. A
  // creature wounded by another FIN_DE_TOUR in this phase (Disciple de l'Agonie #1163 self-wound)
  // does not meet a peer's condition (Laghertha #1432 "si une invocation alliée est blessée").
  // Effects still apply one after the other to the live `state`.
  const fdtSnapshot = state;
  for (const me of [...state.creatures]) {
    if (me.owner !== state.activeSide || me.currentLife <= 0) continue;
    if (!me.triggers.some((t) => t.trigger === "FIN_DE_TOUR")) continue;
    state = runTrigger(state, "FIN_DE_TOUR", me.instanceId, fdtSnapshot);
    if (state.winner) return state;
  }
  // 1b. Sinistro #215 totems fire at the OWNER's end of turn (after creature FIN_DE_TOUR, before
  //     the advance): each Sinistro-bearing Dofus of the active side shoots forward on its row,
  //     1 dmg to the first enemy creature, else the enemy Dofus of that row. Each shot resolves on
  //     a fresh snapshot (Dofuses never move, so we re-find the host by position).
  for (const pos of state.dofuses
    .filter((d) => d.owner === state.activeSide && d.currentLife > 0 && d.sinistroAttached)
    .map((d) => ({ ...d.position }))) {
    const host0 = state.dofuses.find((d) => sameCoords(d.position, pos) && d.owner === state.activeSide && d.currentLife > 0 && d.sinistroAttached);
    if (!host0) continue; // a prior shot's death resolution cannot change this, but stay defensive
    const creatures = state.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
    const dofuses = state.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
    const log = [...state.log];
    const host = dofuses.find((d) => sameCoords(d.position, pos))!;
    sinistroShot(creatures, dofuses, log, host);
    state = resolveDeathsAndWin(state, creatures, dofuses, log, new Set());
    if (state.winner) return state;
  }
  // 1b-bis. Nécronomigore #700 equipments count down and fire at the owner's end of turn. Each
  //     Dofus of the active side with a Nécronomigore lowers its counter; once it reaches 0 ("au
  //     bout de 6 tours") it deals 5 to all enemy Dofus this turn and every owner turn after. One
  //     shared clone for the whole tick (a Dofus never moves), so the counter change and the damage
  //     settle together, then one resolveDeathsAndWin.
  if (state.dofuses.some((d) => d.owner === state.activeSide && d.currentLife > 0 && d.necronomigoreCounter !== undefined)) {
    const creatures = state.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
    const dofuses = state.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
    const log = [...state.log];
    let fired = false;
    for (const d of dofuses) {
      if (d.owner !== state.activeSide || d.currentLife <= 0 || d.necronomigoreCounter === undefined) continue;
      if (d.necronomigoreCounter > 0) d.necronomigoreCounter -= 1; // count down; the placement turn's own end is tick 1
      if (d.necronomigoreCounter === 0) fired = true;             // 0 = armed: fires this turn and every turn after
    }
    if (fired) necronomigoreFire(state.activeSide, creatures, dofuses, log); // 5 to every enemy Dofus
    state = resolveDeathsAndWin(state, creatures, dofuses, log, new Set());
    if (state.winner) return state;
  }
  // 1c. Damage dealt during the end-of-turn phase settles its own reactions here: a creature
  //     wounded by a FIN_DE_TOUR effect (Pacificatrice Enjouée #1519 hitting the enemies when an ally
  //     is healed by Luc Ossit #769, a Sinistro #215 totem shot, a self-wound) must still fire its
  //     CONTRE_COUP (Boo #513 / Empereur Gelax #422 summoning again on survival, Laon Épée Filante
  //     #153 self-buff) and any bystander ON_DAMAGE (Jet le Pied Volant #158), exactly like spell or
  //     combat damage does (see settleDamageReactions in the cast path). Without this the victims
  //     took the hit but their reactions never fired. Settled once after the whole phase so a
  //     reaction (a summoned Boo) cannot feed back into a peer's FIN_DE_TOUR condition; the pre-phase
  //     snapshot already kept those apart. The pre-phase roster lets an ON_DAMAGE bystander react to
  //     an ally that an end-of-turn aura killed.
  state = settleDamageReactions(state, fdtSnapshot.log.length, fdtSnapshot.creatures);
  if (state.winner) return state;
  // Capture the log after the end-of-turn effects (including their now-settled reactions) so the
  // advance-phase CONTRE_COUP only attributes damage from the advance phase, not from a FIN_DE_TOUR
  // effect it already reacted to above.
  const logBefore = state.log.length;
  // 2. Combat phase: creatures advance, fight, maybe die or break a Dofus.
  // Combo 2: counters of initiative strikes soaked by a GARDE DU CORPS are deferred here and replayed
  // below, after the bodyguard's consequences have fully resolved (depth first).
  const deferredCounters: { attackerId: number; targetId: number }[] = [];
  // CONTRE COUP is resolved inline, per mover, inside processCombatPhase: a Contre Coup effect has to
  // show up in the game the moment it happens, before the engine goes on with the rest of the moves.
  // So there is no post-phase fireContreCoup here; a survivor's summon/buff/hit back already landed
  // the moment it took damage. `contreCoupInlineBuffed` still records the creatures whose pure
  // self-buff was applied mid-advance, so the inline fireContreCoup does not apply them again.
  const contreCoupInlineBuffed = new Map<number, number>();
  const mortAdverseInlineBuffed = new Map<number, number>();
  const coupDeGraceInlineBuffed = new Map<number, number>();
  let after = processCombatPhase(state, state.activeSide, deferredCounters, contreCoupInlineBuffed, mortAdverseInlineBuffed, coupDeGraceInlineBuffed);
  if (after.winner) return after;
  // 2c. Bystander ON_DAMAGE reactions (charge/buff "quand un allié subit des dégâts"). Recursive, and
  //     given deferredCounters so an ON_DAMAGE CHARGE that meets a guard-soaked initiative strike
  //     keeps deferring the counter: the combo 2 loop runs while the bodyguard survives.
  // Pass the pre-advance roster: an ON_DAMAGE reactor (Jet le Pied Volant #158) must still fire for an
  // ally that died in the advance, whose owner/family is no longer on the post-cull board.
  after = fireDamageReactions(after, logBefore, deferredCounters, state.creatures);
  if (after.winner) return after;
  // 2d. Combo 2: now that each guard's full sub-wave (death, CONTRE_COUP, bystander ON_DAMAGE) has
  //     resolved, the defenders take their deferred counters, each with its own reactions.
  after = resolveDeferredCounters(after, deferredCounters);
  if (after.winner) return after;
  // 2c. POST_ADVANCE triggers, "à la fin de tous les déplacements" (Ben Debouche heals his other
  //     allies, Lapino those on his row, Forbank digs up a Butin). They fire after the advance, on
  //     the active side's survivors.
  const postAdvLogStart = after.log.length;
  const postAdvRoster = after.creatures;
  for (const me of [...after.creatures]) {
    if (me.owner !== state.activeSide || me.currentLife <= 0) continue;
    if (!me.triggers.some((t) => t.trigger === "POST_ADVANCE")) continue;
    after = runTrigger(after, "POST_ADVANCE", me.instanceId);
    if (after.winner) return after;
  }
  // Damage dealt by a POST_ADVANCE effect settles its own reactions here too (same gap as FIN_DE_TOUR
  // / DÉBUT DE TOUR): Petit Ogrest #666/#947/#952 blasts the enemies around it (3×3), and a Ben
  // Debouche #71 / Lapino #258 heal arms an allied Pacificatrice #1519; the wounded creatures must
  // fire their CONTRE_COUP / ON_DAMAGE. The advance's fireDamageReactions above stopped at logBefore,
  // so POST_ADVANCE damage was never reacted to. Pre-advance roster, so an ON_DAMAGE bystander reacts
  // to a kill.
  after = settleDamageReactions(after, postAdvLogStart, postAdvRoster);
  if (after.winner) return after;
  // 3. Suicide timers, "meurt à la fin de son tour" (Mort Proche): any creature
  //    flagged DiesAtEndOfTurn whose owner's turn just ended dies now (after it
  //    got to act this turn with its buff). Goes through resolveDeathsAndWin so
  //    its MORT trigger + discard are handled like any other death.
  if (after.creatures.some((c) => c.currentLife > 0 && c.owner === state.activeSide && c.properties.has("DiesAtEndOfTurn"))) {
    const creatures = after.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
    const dofuses = after.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
    for (const c of creatures) {
      if (c.owner === state.activeSide && c.currentLife > 0 && c.properties.has("DiesAtEndOfTurn")) c.currentLife = 0;
    }
    after = resolveDeathsAndWin(after, creatures, dofuses, [...after.log], new Set());
    if (after.winner) return after;
  }
  // Summoning sickness (the `hasAttacked` flag) clears at the end of the turn of the player who
  // placed the creature. startTurn only refreshes the incoming side, so without this the creatures
  // the player just summoned would stay flagged "mal d'invocation" for the whole opponent turn, and
  // a transform / prise de contrôle on them during that turn would wrongly treat them as unable to
  // act. Their PM is still only reset at their own next startTurn; here we only lift the flag.
  after = {
    ...after,
    creatures: after.creatures.map((c) =>
      c.owner === state.activeSide && c.currentLife > 0 && c.hasAttacked ? { ...c, hasAttacked: false } : c,
    ),
  };
  return startTurn(after, other(after.activeSide));
}

// Forward direction on the X axis for `side`'s creatures. Ally pushes toward
// x=0 (enemy wall), enemy pushes toward x=BOARD_COLS-1 (ally wall). Movement
// is purely horizontal in the MVP, the original game has slightly more
// nuanced auto-pathing on rare occasions but straight-forward covers >99% of
// real plays and we can refine when we encounter a counter-example.
function forwardDx(side: Side): number {
  return side === "ally" ? -1 : 1;
}

// Wall columns are the back-row of each side. They are not normally walkable:
// every cell hosts a Dofus (real or fake) that has to be destroyed first.
// A creature that successfully steps onto a wall column (after destroying
// a Dofus) is removed from the board, it has "broken through" the wall.
function isWallCol(x: number): boolean {
  return x === 0 || x === BOARD_COLS - 1;
}

// Apply damage to a creature, honoring its defensive layers in order:
//   1. Shield (Bouclier): absorbs the first instance entirely, then drops.
//      PierceArmor does not bypass Shield, "Perce Armure" only ignores
//      armor (per CAPACITY_DESC_PierceArmor), so Shield always gets first say.
//   2. CantDie / Invulnerable: fully dodge.
//   3. Résistance: a flat per-hit reducer. Never consumed (it is a permanent
//      creature stat). Floor at 0, a fully-resisted hit still "lands" (the
//      Shield/CantDie checks fired) but deals 0 to AR/life. PierceArmor does
//      not bypass Résistance (per the in-game text).
//   4. Armure (AR): an absorbing pool drained before life. Skipped when the
//      attacker has PierceArmor. Drained armor surfaces as an ARMOR_GAINED
//      event with negative modification; it is never healed back.
//   5. Life: whatever damage remains.
// Returns the damage that actually reduced life (0 if Shield/dodge/Résistance/
// armor ate it all), callers use this to decide whether to emit a DAMAGE
// event and check for death. Mutates target.currentLife / armor / properties.
function applyDamageToCreature(
  target: CreatureInstance,
  damage: number,
  log: GameEvent[],
  attackerPiercesArmor = false,
): number {
  if (damage <= 0) return 0;
  // "Tant qu'une lune est en jeu, les dégâts subis par vos Mulous sont réduits de 1" (Pleine Lune
  // #746): withAuras gives MoonGuard to a side's Mulous while that side owns a FullMoon creature.
  if (target.properties.has("MoonGuard")) { damage = Math.max(0, damage - 1); if (damage <= 0) return 0; }
  // "Ne subit jamais plus de 1 dégât à la fois" (Rupuce #242): each hit is capped at 1, so it never
  // loses more than 1 HP per hit.
  if (target.properties.has("DamageCap1")) damage = Math.min(damage, 1);
  if (target.properties.has("Shield")) {
    // Shield absorbs the full instance, no life lost.
    target.properties = new Set(target.properties); // clone before mutating the shared Set (aliasing, cf. Stunned below)
    target.properties.delete("Shield");
    log.push({ type: "PROPERTY_UNAPPLIED", instanceId: target.instanceId, property: "Shield" });
    log.push({ type: "DAMAGE_DODGED", targetInstanceId: target.instanceId });
    return 0;
  }
  if (target.properties.has("CantDie") || target.properties.has("Invulnerable")) {
    log.push({ type: "DAMAGE_DODGED", targetInstanceId: target.instanceId });
    return 0;
  }
  // "Subir des dégâts annule l'état assommé", the instance landed (it was not
  // dodged above), so wake the creature.
  if (target.properties.has("Stunned")) {
    target.properties = new Set(target.properties);
    target.properties.delete("Stunned");
    log.push({ type: "PROPERTY_UNAPPLIED", instanceId: target.instanceId, property: "Stunned" });
  }
  // Vulnérabilité raises the hit, Résistance lowers it, both flat, applied
  // before Armure. (Shield / CantDie above already negated the whole instance.)
  let remaining = Math.max(0, damage + target.vulnerability - target.resistance);
  // Armure: absorbing pool, consumed, bypassed by PierceArmor.
  if (remaining > 0 && !attackerPiercesArmor && target.armor > 0) {
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
  // Mark a DAMAGE death so resolveDeathsAndWin can fire the victim's posthumous CONTRE COUP.
  if (remaining > 0 && target.currentLife <= 0) target.diedFromDamage = true;
  return remaining;
}

// Lien de Sang #1495: if `dofus` is linked to a living protector (protectedBy), the incoming
// `amount` goes to that creature instead (its own Shield / Résistance / Armure apply, like any
// hit). The protector only absorbs up to its own life: like a Sacrifice, when the hit is more
// than its life the protector is destroyed and the surplus goes on to the Dofus. Returns the
// damage the Dofus still takes: the overflow when redirected (0 if the protector took it all), or
// the unchanged `amount` when there is no living protector.
function redirectDofusDamage(
  dofus: DofusInstance,
  amount: number,
  creatures: CreatureInstance[],
  log: GameEvent[],
  sourceInstanceId?: number,
): number {
  if (amount <= 0) return amount;
  if (dofusInvulnerable(dofus, creatures)) return 0; // Artheon #1424: invulnerable Dofus takes no combat damage
  if (dofus.protectedBy == null) return amount;
  const guard = creatures.find((c) => c.instanceId === dofus.protectedBy && c.currentLife > 0);
  if (!guard) return amount; // protector dead / gone → the Dofus takes the hit normally
  const lifeBefore = guard.currentLife;
  const armorBefore = guard.armor;
  const dealt = applyDamageToCreature(guard, amount, log, false); // unclamped: currentLife may go < 0
  if (dealt > 0 || armorBefore > guard.armor) {
    // Carry the attacker id so a COUP_DE_GRÂCE/targetKiller MORT on the protector (when it dies
    // here) can identify its killer in resolveDeathsAndWin (matches the spell/bodyguard paths).
    // `combat: true`: every caller is a real attack on a Dofus (advance wall hit / shooter shot)
    // that Lien de Sang soaks, the attacker must still play its swing in the replay.
    log.push({ type: "DAMAGE", sourceInstanceId, targetInstanceId: guard.instanceId, damage: dealt, armorHit: armorBefore > guard.armor, combat: true });
  }
  if (guard.currentLife <= 0) {
    log.push({ type: "FIGHT_OBJECT_REMOVED", instanceId: guard.instanceId });
  }
  // Surplus damage the protector could not absorb (it died) spills onto the Dofus.
  return Math.max(0, dealt - lifeBefore);
}

// Garde du corps #320/#300: the living bodyguard that took `victim` under its protection
// (its APPARITION picked `victim`), or undefined. While it lives, damage AIMED at the
// protected creature is dealt to the bodyguard instead, the protected creature itself
// takes nothing (so in melee it survives and still counters; the bodyguard, possibly
// elsewhere, absorbs the hit and may die, settled by resolveDeathsAndWin afterwards).
function guardOf(victim: CreatureInstance, creatures: CreatureInstance[]): CreatureInstance | undefined {
  if (victim.protectedByGuard == null) return undefined;
  const g = creatures.find((c) => c.instanceId === victim.protectedByGuard && c.currentLife > 0);
  return g && g.instanceId !== victim.instanceId ? g : undefined;
}

// Garde du corps #320/#300 for the inline combat sites (seed/trap walk-over, shooter fire). Routes
// `dmg` to `victim`'s living bodyguard; the guard soaks only up to its own life and the EXCESS
// overflows onto `victim` (whose own defences then apply). Logs a conditional DAMAGE for the guard
// and for the overflow (only when HP/armour actually moved, matching the prior inline guards). Does
// not log FIGHT_OBJECT_REMOVED, callers settle deaths (the shooter needs the protégé's own death
// for its adjacency stop). `sourceInstanceId` is omitted for sourceless damage (seeds/traps).
// applyDamageToCreature leaves currentLife unclamped, so `dealt - lifeBefore` is exactly the spill.
function applyGuardedCombatDamage(
  victim: CreatureInstance,
  dmg: number,
  log: GameEvent[],
  creatures: CreatureInstance[],
  pierces: boolean,
  sourceInstanceId?: number,
  // True when this is a real attack (shooter shot) → the DAMAGE events carry
  // `combat` so the replay swings the source. Seed/trap walk-overs (sourceless
  // hazards) leave it unset.
  combat?: boolean,
): { recipient: CreatureInstance; recipientDied: boolean; victimDied: boolean } {
  const dmgEvent = (target: number, damage: number, armorHit: boolean): GameEvent =>
    sourceInstanceId != null
      ? { type: "DAMAGE", sourceInstanceId, targetInstanceId: target, damage, armorHit, combat }
      : { type: "DAMAGE", targetInstanceId: target, damage, armorHit, combat };
  const guard = guardOf(victim, creatures);
  const recipient = guard ?? victim;
  const armorBefore = recipient.armor;
  const lifeBefore = recipient.currentLife;
  const dealt = applyDamageToCreature(recipient, dmg, log, pierces);
  if (dealt > 0 || armorBefore > recipient.armor) log.push(dmgEvent(recipient.instanceId, dealt, armorBefore > recipient.armor));
  if (guard) {
    const spill = Math.max(0, dealt - lifeBefore);
    if (spill > 0) {
      const vArmorBefore = victim.armor;
      const through = applyDamageToCreature(victim, spill, log, pierces);
      if (through > 0 || vArmorBefore > victim.armor) log.push(dmgEvent(victim.instanceId, through, vArmorBefore > victim.armor));
    }
  }
  return { recipient, recipientDied: recipient.currentLife <= 0, victimDied: victim.currentLife <= 0 };
}

// Single source of truth for creature against creature melee. Called from both the "step into the
// enemy's cell" path and the "engage an enemy you stopped next to" path. These used to be two
// separate copies that drifted apart: the engage-at-end copy forgot the `simultaneous` flag and
// FirstStrike, so two creatures that stopped side by side fought one after the other (one attack
// animation, then the other) instead of striking at once. Going through here keeps them the same.
//
// Rules (same as the original game):
//   - Default: both strike at the same time (both deal damage, both can die). The paired DAMAGE
//     events carry `simultaneous: true` so the replay plays the two attack animations together.
//   - `FirstStrike` ("Initiative") overrides this: the holder strikes first and, if it kills its
//     opponent, takes no counter. If both (or neither) have it, it is simultaneous again. These
//     hits are not flagged, so the replay plays the initiative strike, then the counter.
//   - `noCounter` (Tir Rapide #1178, the only case in the game): the attack goes one way. The
//     target takes the hit and never strikes back, even at corps à corps. It reuses the
//     FirstStrike branch (single unflagged DAMAGE, no `simultaneous` pairing) and skips the
//     counter.
//   - Damage goes through applyDamageToCreature so Shield / PierceArmor / CantDie apply.
// Sets me.hasAttacked and logs DAMAGE + FIGHT_OBJECT_REMOVED. Any movement after the exchange
// (stepping into a freed cell) is left to the caller.
// #207 Masse: "Les invocations qu'il blesse meurent si vous avez un AUTRE <famille> en jeu." True
// when `me` has the LethalMeleeIfFamily marker and another living ally of that family (besides
// `me`) is on the board.
function hasLethalMelee(me: CreatureInstance, creatures: CreatureInstance[]): boolean {
  const m = (getCard(me.cardId)?.effects ?? []).find((e) => e.type === "LethalMeleeIfFamily") as { family?: string } | undefined;
  if (!m?.family) return false;
  return creatures.some((c) => c.currentLife > 0 && c.owner === me.owner && c.instanceId !== me.instanceId && (getCard(c.cardId)?.families ?? []).includes(m.family!));
}

function resolveMeleeExchange(
  me: CreatureInstance,
  foe: CreatureInstance,
  log: GameEvent[],
  creatures: CreatureInstance[] = [],
  // No longer used: guard-soaked initiative counters are not deferred anymore (they resolve inline,
  // the bodyguard only absorbs damage). The parameter is kept so callers stay unchanged.
  _deferred?: { attackerId: number; targetId: number }[],
  // Tir Rapide #1178 only: `me` strikes, the target never answers (see the header note).
  noCounter = false,
  // Patty Ceriz #31 (PushTargetOnAttack "repousse de 1 case son adversaire quand elle attaque"):
  // the melee exchange goes both ways (both fighters strike), so the marker applies to its carrier
  // whether it started the exchange or was attacked. The push is not applied here: it is returned
  // so the caller runs it after applyAttackSplash. Pushing first would make the attacker's splash
  // (Marteleur #972) start from the cell it landed on instead of the cell of the hit.
): { target: CreatureInstance; distance: number }[] {
  const myDmg = me.currentAttack;
  const theirDmg = foe.currentAttack;
  const myPierces = me.properties.has("PierceArmor");
  const theirPierces = foe.properties.has("PierceArmor");
  // Initiative ("FirstStrike"), but Assommé (Stunned) overrides it. A stunned creature can neither
  // use its own Initiative nor strike back in time: the incoming hit wakes it
  // (applyDamageToCreature clears Stunned), but it only gets to counter if that hit does not kill
  // it. A lethal blow drops it before it can react (a stunned Jahash used to hit back and kill
  // Gemene while dying from the blow). So attacking a stunned creature makes the attacker strike
  // first, and a stunned mover (forced onto an enemy) is beaten to it the same way. Going through
  // the initiative branch below gives exactly this: the first one strikes, the second counters
  // only if it survives.
  const meStunned = me.properties.has("Stunned");
  const foeStunned = foe.properties.has("Stunned");
  let meFirst: boolean, theyFirst: boolean;
  if (foeStunned && !meStunned) { meFirst = true; theyFirst = false; }
  else if (meStunned && !foeStunned) { meFirst = false; theyFirst = true; }
  else {
    meFirst = me.properties.has("FirstStrike") && !meStunned;
    theyFirst = foe.properties.has("FirstStrike") && !foeStunned;
  }
  // TIR RAPIDE #1178 (noCounter): a triggered attack is ONE-WAY, route it through the
  // initiative branch as "me strikes alone". Initiative on the defender is moot here: it
  // orders an exchange, and there is no exchange (a ranged shot, which is what this spell
  // makes the creature do, is likewise never answered, not even by a FirstStrike target).
  if (noCounter) { meFirst = true; theyFirst = false; }
  me.hasAttacked = true;
  // Life/armor saved before the exchange so #207 Masse's lethality can tell whether each fighter was
  // really wounded (lost life or armor). A hit that was fully resisted (0 dealt) must not trigger it
  // ("dès lors que Masse applique des dommages non nuls").
  const meLife0 = me.currentLife, meArmor0 = me.armor;
  const foeLife0 = foe.currentLife, foeArmor0 = foe.armor;

  // Garde du corps #320/#300: a strike aimed at `combatant` lands on its living bodyguard
  // instead (guardOf); the combatant itself takes nothing, so the survival/counter checks
  // below (which read the COMBATANT's currentLife) see it unharmed, while the bodyguard
  // (possibly elsewhere) absorbs the hit and may die (settled by resolveDeathsAndWin). The
  // DAMAGE log targets the actual recipient so the HP animation + ON_DAMAGE reactions land
  // on the bodyguard. No protector → recipient === combatant, identical to before.
  const hit = (combatant: CreatureInstance, dmg: number, pierces: boolean) => {
    const guard = guardOf(combatant, creatures);
    const recipient = guard ?? combatant;
    const armorBefore = recipient.armor;
    const lifeBefore = recipient.currentLife;
    const dealt = applyDamageToCreature(recipient, dmg, log, pierces);
    // Garde du corps overflow: the bodyguard soaks only up to its own life; the excess (what
    // would drop it past 0) carries through to the protected combatant, which then meets the
    // leftover with its own defences. currentLife is left unclamped, so dealt - lifeBefore is
    // exactly the spill. The caller logs the overflow DAMAGE (it owns the source + simultaneous
    // flag); the combatant's own currentLife now reflects the hit, so the survival/counter and
    // end-of-exchange death checks below correctly see it harmed (and skip its counter if it died).
    let overflow: { target: CreatureInstance; dealt: number; armorHit: boolean } | undefined;
    if (guard) {
      const spill = Math.max(0, dealt - lifeBefore);
      if (spill > 0) {
        const cArmorBefore = combatant.armor;
        const through = applyDamageToCreature(combatant, spill, log, pierces);
        overflow = { target: combatant, dealt: through, armorHit: cArmorBefore > combatant.armor };
      }
    }
    return { recipient, dealt, armorHit: armorBefore > recipient.armor, overflow };
  };

  // Who really struck in this exchange. What counts is launching the attack, not the damage dealt: a
  // creature with 0 AT (or whose hit is fully absorbed) did attack. A hit that was never struck (dead
  // before striking against an INITIATIVE, or a reply removed by Tir Rapide #1178) does not count.
  let meStruck = false, foeStruck = false;
  if (meFirst !== theyFirst) {
    // INITIATIVE: exactly one side strikes first. Resolve that strike, then
    // only the SURVIVOR (if the defender lived) counters, this is the one
    // case where the counter's attack animation is correctly skipped (the
    // would-be counter-attacker died to the initiative strike before getting
    // a chance to swing).
    const first = meFirst ? me : foe;
    const second = meFirst ? foe : me;
    const firstDmg = meFirst ? myDmg : theirDmg;
    const firstPierces = meFirst ? myPierces : theirPierces;
    const r1 = hit(second, firstDmg, firstPierces);
    if (first === me) meStruck = true; else foeStruck = true;
    // Always emit DAMAGE for the swing so the replay plays the attack
    // animation, even when the hit dealt 0 to life (Résistance fully soaked
    // it, AR absorbed it, Shield dodged it…). The "did it actually hurt
    // life" question is answered by the `damage` value (0 = no HP lost) and
    // by the Shield/DAMAGE_DODGED/ARMOR_GAINED events emitted by
    // applyDamageToCreature itself. `armorHit` flags an armour-only hit so
    // CONTRE_COUP still fires (losing armour is "subir des dégâts").
    log.push({ type: "DAMAGE", sourceInstanceId: first.instanceId, targetInstanceId: r1.recipient.instanceId, damage: r1.dealt, armorHit: r1.armorHit, combat: true });
    if (r1.overflow) log.push({ type: "DAMAGE", sourceInstanceId: first.instanceId, targetInstanceId: r1.overflow.target.instanceId, damage: r1.overflow.dealt, armorHit: r1.overflow.armorHit, combat: true });
    // `!noCounter`: Tir Rapide #1178 suppresses the answer entirely, including the inline
    // riposte of a protégée whose bodyguard soaked the hit (it is the combatant, not the guard).
    if (!noCounter && second.currentLife > 0) {
      // A GARDE DU CORPS that absorbs the initiative strike only takes damage (like spell damage); it is
      // not a fighter and does not get "engaged". The real fighter is the protected creature (`second`),
      // so its counter resolves inline here, exactly as when there is no guard. Deferring it (as the
      // engine did before) wrongly let the bodyguard's own consequences come before the protected
      // creature's hit back. The bodyguard's own consequences (its death, CONTRE_COUP, bystander
      // ON_DAMAGE) then settle afterwards like any damage reaction. The old `deferred` initiative
      // counter plumbing is now never filled.
      const secondDmg = meFirst ? theirDmg : myDmg;
      const secondPierces = meFirst ? theirPierces : myPierces;
      const r2 = hit(first, secondDmg, secondPierces);
      if (second === me) meStruck = true; else foeStruck = true;
      log.push({ type: "DAMAGE", sourceInstanceId: second.instanceId, targetInstanceId: r2.recipient.instanceId, damage: r2.dealt, armorHit: r2.armorHit, combat: true });
      if (r2.overflow) log.push({ type: "DAMAGE", sourceInstanceId: second.instanceId, targetInstanceId: r2.overflow.target.instanceId, damage: r2.overflow.dealt, armorHit: r2.overflow.armorHit, combat: true });
    }
  } else {
    // Simultaneous: both strike at once. Both DAMAGE events carry
    // `simultaneous: true` so the replay plays them together, and both
    // fire unconditionally so neither animation is silently dropped when
    // the hit deals 0 (e.g. fully resisted by Résistance).
    const rTheirs = hit(foe, myDmg, myPierces);
    const rMe = hit(me, theirDmg, theirPierces);
    meStruck = true; foeStruck = true; // simultaneous hits: both attacked, even if one dies
    log.push({ type: "DAMAGE", sourceInstanceId: me.instanceId, targetInstanceId: rTheirs.recipient.instanceId, damage: rTheirs.dealt, simultaneous: true, armorHit: rTheirs.armorHit, combat: true });
    if (rTheirs.overflow) log.push({ type: "DAMAGE", sourceInstanceId: me.instanceId, targetInstanceId: rTheirs.overflow.target.instanceId, damage: rTheirs.overflow.dealt, simultaneous: true, armorHit: rTheirs.overflow.armorHit, combat: true });
    log.push({ type: "DAMAGE", sourceInstanceId: foe.instanceId, targetInstanceId: rMe.recipient.instanceId, damage: rMe.dealt, simultaneous: true, armorHit: rMe.armorHit, combat: true });
    if (rMe.overflow) log.push({ type: "DAMAGE", sourceInstanceId: foe.instanceId, targetInstanceId: rMe.overflow.target.instanceId, damage: rMe.overflow.dealt, simultaneous: true, armorHit: rMe.overflow.armorHit, combat: true });
  }
  // #207 Masse (LethalMeleeIfFamily): any creature this carrier wounded in the melee (it lost life or
  // armor; a hit that was fully resisted does not count) dies outright if it survived, while a second
  // living ally of the family is on the board. Symmetric: the melee is an exchange, so it fires
  // whether the carrier struck as the attacker (`me`) or countered as the defender (`foe`).
  const meWoundedFoe = foe.currentLife < foeLife0 || foe.armor < foeArmor0;
  const foeWoundedMe = me.currentLife < meLife0 || me.armor < meArmor0;
  if (foe.currentLife > 0 && meWoundedFoe && hasLethalMelee(me, creatures)) foe.currentLife = 0;
  if (me.currentLife > 0 && foeWoundedMe && hasLethalMelee(foe, creatures)) me.currentLife = 0;
  if (foe.currentLife <= 0) {
    log.push({ type: "FIGHT_OBJECT_REMOVED", instanceId: foe.instanceId });
  }
  if (me.currentLife <= 0) {
    log.push({ type: "FIGHT_OBJECT_REMOVED", instanceId: me.instanceId });
  }
  // Patty Ceriz #31: each fighter that struck and has the marker pushes its opponent back. Symmetric
  // (the exchange goes both ways), independent of the damage (0 AT still pushes), and independent of
  // its own survival: it pushes even if it dies (simultaneous hits, its attack already left). A
  // corpse is not pushed, though: the target must be alive. When silenced it does not push anymore,
  // since the push is its effect.
  const pushes: { target: CreatureInstance; distance: number }[] = [];
  const pushMarker = (c: CreatureInstance): number =>
    c.silenced ? 0
      : ((getCard(c.cardId)?.effects ?? []).find((e) => e.type === "PushTargetOnAttack") as { distance?: number } | undefined)?.distance ?? 0;
  if (meStruck && foe.currentLife > 0) {
    const d = pushMarker(me);
    if (d > 0) pushes.push({ target: foe, distance: d });
  }
  if (foeStruck && me.currentLife > 0) {
    const d = pushMarker(foe);
    if (d > 0) pushes.push({ target: me, distance: d });
  }
  return pushes;
}

// Deal `dmg` (the carrier's attack) to the cell (x,y) as part of an attack SPLASH: any creature there
// (both camps, never the carrier) takes combat damage, and the Dofus there is wounded, enemy-only by
// default, or any-camp when `anyCampDofus` (Dark Vlad's friendly fire). A no-op if the cell is off-board.
function splashAttackCell(me: CreatureInstance, x: number, y: number, dmg: number, pierces: boolean, anyCampDofus: boolean, log: GameEvent[], creatures: CreatureInstance[], dofuses: DofusInstance[]): void {
  if (x < 0 || x >= BOARD_COLS || y < 0 || y >= BOARD_ROWS) return;
  const c = creatures.find((o) => o.instanceId !== me.instanceId && o.currentLife > 0 && o.position.x === x && o.position.y === y);
  if (c) {
    const armorBefore = c.armor;
    const dealt = applyDamageToCreature(c, dmg, log, pierces);
    if (dealt > 0 || armorBefore > c.armor) log.push({ type: "DAMAGE", sourceInstanceId: me.instanceId, targetInstanceId: c.instanceId, damage: dealt, armorHit: armorBefore > c.armor, combat: true });
    if (c.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", instanceId: c.instanceId });
  }
  const d = dofuses.find((o) => o.currentLife > 0 && o.position.x === x && o.position.y === y && (anyCampDofus || o.owner !== me.owner));
  if (d && !dofusInvulnerable(d, creatures)) {
    woundDofus(d, dmg, log, creatures, dofuses);
    if (d.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", dofusAt: { ...d.position } });
    else log.push({ type: "DAMAGE", targetCell: { ...d.position }, damage: dmg, sourceInstanceId: me.instanceId, combat: true });
  }
}

// Attack splash: extra damage a carrier deals around its target each time it lands a combat attack
// (called after each attack: melee / Dofus / end-engage, before it steps into the cell). Two
// carriers:
//   • Marteleur Nimbos #972 (DamagesOn3CellsSameColumn): "case en face + les 2 cases à côté de
//     celle-ci", so the 2 cells above and below in the front column (fx, y∓1); any creature, enemy
//     Dofus only.
//   • Dark Vlad #482 (DamagesInSquareFriendlyFireIncludingDofuses): "chaque invocation ou Dofus
//     AUTOUR de lui", so all 8 cells around him; any creature (friendly fire) and any Dofus (both
//     camps).
// The amount is the carrier's current attack.
function applyAttackSplash(me: CreatureInstance, log: GameEvent[], creatures: CreatureInstance[], dofuses: DofusInstance[]): void {
  const dmg = me.currentAttack;
  if (dmg <= 0) return;
  const pierces = me.properties.has("PierceArmor");
  if (me.properties.has("DamagesOn3CellsSameColumn")) {
    const fx = me.position.x + forwardDx(me.owner);
    for (const fy of [me.position.y - 1, me.position.y + 1]) splashAttackCell(me, fx, fy, dmg, pierces, false, log, creatures, dofuses);
  }
  if (me.properties.has("DamagesInSquareFriendlyFireIncludingDofuses")) {
    const frontX = me.position.x + forwardDx(me.owner); // the cell that just took the combat attack
    for (let ddx = -1; ddx <= 1; ddx++) {
      for (let ddy = -1; ddy <= 1; ddy++) {
        if (ddx === 0 && ddy === 0) continue; // skip the carrier's own cell
        const sx = me.position.x + ddx, sy = me.position.y + ddy;
        if (sx === frontX && sy === me.position.y) continue; // front target already took the combat attack, do not double-hit it
        splashAttackCell(me, sx, sy, dmg, pierces, true, log, creatures, dofuses);
      }
    }
  }
}

// Tracking accumulators threaded through an advance so the caller can apply
// the deferred side-effects (wall break-throughs → deck; prism pickups →
// player bonuses) after the mutation pass.
interface AdvanceTracking {
  brokeThroughIds: Set<number>;
  prismCellKeys: Set<string>;
  collectedPrismKeys: Set<string>;
  prismPickups: { at: Coords; side: Side; props: Set<string>; byInstanceId?: number }[];
  // Seeds on the board, keyed "x,y" → owner. A creature stepping onto a seed
  // cell consumes it (key recorded in consumedSeedKeys) and gains +1 AR if it is
  // an allied seed (same owner as the walker) or takes 1 damage if it is an
  // enemy seed. Consumed seeds are stripped from state after the advance pass.
  seedCells: Map<string, Side>;
  consumedSeedKeys: Set<string>;
  // Glyphes on the board, keyed "x,y" → owner. A creature stepping onto a glyph:
  //  - an enemy of the glyph's owner destroys it (key → consumedGlyphKeys);
  //  - an allied Féca gains +AR = number of rows holding an allied glyph (the
  //    glyph persists). Allied non-Féca: nothing.
  glyphCells: Map<string, Side>;
  consumedGlyphKeys: Set<string>;
  // Tas d'Os on the board, keyed "x,y" → owner. A creature stepping onto a Tas d'Os
  // always consumes it (key → consumedTasDOsKeys); an allied Chafer (same owner) also
  // gains +1 AT +1 AR (permanent). Anyone else just destroys it.
  tasDOsCells: Map<string, Side>;
  consumedTasDOsKeys: Set<string>;
  // Bushes, keyed "x,y" (any owner): any creature that walks on one destroys it. No other effect, it
  // does not block.
  bushCells: Set<string>;
  consumedBushKeys: Set<string>;
  // Butins on the board, keyed "x,y" (owner-agnostic for pickup, anyone collects).
  // A creature stepping onto a butin cell consumes it (key → consumedButinKeys) and
  // its owner is recorded in butinPickups; after the advance pass each pickup rolls
  // a random reward card into that side's hand.
  butinCells: Set<string>;
  consumedButinKeys: Set<string>;
  butinPickups: { side: Side; at: Coords }[];
  // Cadeaux de Nowel (#1042) on the board, keyed "x,y" (any owner: either side can pick one up). A
  // creature stepping onto a gift cell uses it up (key → consumedGiftKeys) and its outcome (+1 AT |
  // +1 AR | +1 PM | 1 damage, equally likely) is resolved inline, at the moment of the step. Lethal
  // damage stops the advance (the loop checks currentLife > 0) and the creature dies on the gift
  // cell, like an enemy seed or the Gangraîne poison. The +1 PM only changes baseMovement (it never
  // extends the current advance); the +1 AT counts right away (including the fight at the end of a
  // charge).
  //   giftRng: a stream derived from state.rng (seed ^ salt) used only for gift draws, because the
  //   advance has no access to the GameState to move state.rng forward step by step. The salt keeps
  //   it apart from the main stream; it is folded back into state.rng at settle time
  //   (applyGiftRollReactions) only if draws happened, so with no gift state.rng stays the same
  //   (existing games replay the same).
  //   giftRolls: number of pickups per camp. Each pickup is an allied roll for the camp that picks it
  //   up, but Sentinelle Affûtée / Atout Caché resolve at the state level (hands, costs), which the
  //   advance cannot reach, so they are deferred to settle time by count, like the rolls of the death
  //   path (rollCounts).
  giftCells: Set<string>;
  consumedGiftKeys: Set<string>;
  giftRng: Rng;
  giftRolls: { ally: number; enemy: number };
  // Pièges on the board, keyed "x,y" → the trap. A creature stepping onto a trap uses it up (key →
  // consumedTrapKeys); an enemy of the owner takes its damage, an ally records a pickup (the trap
  // card goes back to the owner's hand after the pass).
  trapCells: Map<string, TrapInstance>;
  consumedTrapKeys: Set<string>;
  trapPickups: { side: Side; cardId: number }[];
  // Rule 4 / combo 2: when an INITIATIVE first strike is absorbed by a GARDE DU CORPS, the defender's
  // counter is deferred, since the bodyguard's full consequences (its death, CONTRE_COUP, bystander
  // ON_DAMAGE like Jet le Pied Volant #158) must resolve before the counter. resolveMeleeExchange
  // records {attacker, target} here; endTurn replays them after the first-strike reactions. Absent
  // (undefined) outside the end-of-turn phase, so counters resolve inline.
  deferredInitiativeCounters?: { attackerId: number; targetId: number }[];
  // Nenufar #821 death seeds placed inline at the moment a Sadida dies mid-advance. Present only on
  // trackings that ask for immediate placement (the end-of-turn combat phase). Each entry's cell is
  // also set in `seedCells` so walkers use it up; after the advance, entries whose key is not in
  // consumedSeedKeys are added to state.seeds, and their instanceIds are passed to resolveDeathsAndWin
  // so it does not add them again.
  deathSeeds?: { position: Coords; owner: Side; instanceId: number }[];
  // TAS D'OS (Chafer) placed inline the moment a tagged creature dies mid-advance, like deathSeeds. The
  // cell is also set in `tasDOsCells` so the killer's own kill and continue step, and any later walker
  // of this sweep, uses it up (a non-Chafer / enemy destroys it, an allied Chafer gains +1AT+1AR).
  // Survivors (cell not in consumedTasDOsKeys) are added after the sweep; their ids skip
  // resolveDeathsAndWin.
  deathTasDOs?: { position: Coords; owner: Side; instanceId: number }[];
  // CONTRE COUP self stat buffs (Laon #153 +AT/+AR etc.) applied inline the moment a creature takes
  // combat damage during its own advance, so the rest of that advance uses the buffed stats.
  // instanceId → count (a creature hit twice buffs twice). Present only in the end-of-turn combat
  // phase; the post-phase fireContreCoup reads it so the same self buff is not applied twice.
  contreCoupInlineBuffed?: Map<number, number>;
  // MORT ADVERSE self stat buffs (Chevalier de Parme #1969 +AT quand un adverse meurt) applied inline
  // the moment the killer downs an enemy mid-advance, so the rest of its advance (kill and continue +
  // Dofus hit) uses the raised stats. instanceId → number of kills already buffed;
  // resolveDeathsAndWin skips that many of the creature's MORT ADVERSE firings. Present only in the
  // end-of-turn combat phase.
  mortAdverseInlineBuffed?: Map<number, number>;
  // COUP DE GRÂCE self stat buffs (Tsar Tsu Tsu #138 +AT/+AR per kill) applied inline at the moment
  // of the kill, so the rest of the advance (kill and continue + Dofus hit) gets the boost.
  // instanceId → number of buffed kills; fireCoupDeGrace skips that many pure auto-buff firings.
  // Present only at end of turn.
  coupDeGraceInlineBuffed?: Map<number, number>;
  // COUP DE GRÂCE "change de propriétaire" (Truche Foldingue #434) resolved inline, at the moment of
  // the kill: the switch has to happen during the advance, not after, so the creature that changes
  // camp goes off in the other direction with its remaining PM. Its own RNG stream (derived from
  // state.rng, like the gifts), so it can be reproduced without disturbing the other draws.
  // `defected` keeps the ids already resolved so fireCoupDeGrace does not replay their coin flip;
  // `rolls` counts the rolls per camp, whose reactions (Sentinelle / Atout Caché) fire at settle
  // time. No Trucage here: it expires before the movement phase (endTurn step 0), so it never forces
  // a draw of the advance. Present only at end of turn.
  cdgDefect?: { rng: Rng; defected: Set<number>; rolls: Record<Side, number> };
  // Otomaï #447: set to true the moment a creature whose MORT transforms the whole sweeping side dies
  // during the advance (deathTransformsAllHitsSide). The killer that triggered it already stopped (no
  // break-through); the sweep loop then stops moving the others. Every remaining mover is about to
  // be transformed too, so it must not play its turn. The transform lands in resolveDeathsAndWin.
  transformAllCancel?: boolean;
}

// The base Glyphe card (#827). Remaniement sends every caster glyph back to the hand as this base
// card (always the base, not the card it came from).
const BASE_GLYPH_CARD_ID = 827;

// "Tant qu'elle est en main, son coût est réduit de N PA quand <événement>" (Nonne #1643 anyDeath,
// Impératrice #1300 enemyDeath, Golgor #1349 allyButinPickup): a passive behaviour in the hand. For
// `count` occurrences of `event`, stamp −amount on every hand card of `side` with a matching
// HandCostOnEvent marker (hand only, adds up; effectiveCost floors at 0). Replaces the old Golgor
// discount keyed by id.
function stampHandCostOnEvent(state: GameState, side: Side, event: "anyDeath" | "enemyDeath" | "allyButinPickup", count: number): GameState {
  if (count <= 0) return state;
  const p = state.players[side];
  let touched = false;
  const handCostMods = p.hand.map((id, i) => {
    const ev = (getCard(id)?.effects ?? []).find((e) => e.type === "HandCostOnEvent") as { event?: string; amount?: number } | undefined;
    if (!ev || ev.event !== event) return p.handCostMods[i] ?? 0;
    touched = true;
    return (p.handCostMods[i] ?? 0) - (ev.amount ?? 1) * count;
  });
  return touched ? { ...state, players: { ...state.players, [side]: { ...p, handCostMods } } } : state;
}

// Ecaflip "roll-reactive" cards respond to every allied dice or coin roll, whether the owner played
// it or an effect triggered it. Driven by the RollReaction marker (Sentinelle Affûtée #1606: +1
// AT/+1 AR on the board; Atout Caché #1201: −1 PA in hand) rather than ids hard-coded like Golgor.
function rollReactionOf(cardId: number): { attack?: number; armor?: number; handCost?: number } | undefined {
  return (getCard(cardId)?.effects ?? []).find((e) => e.type === "RollReaction") as
    | { attack?: number; armor?: number; handCost?: number }
    | undefined;
}

// True if applying these effects rolls a die or flips a coin (a CoinFlip, or a
// dice-valued Damage/amount/cells). Used to fire the roll reactions once per
// rolling cast / trigger.
function effectsHaveRoll(effects: readonly Effect[]): boolean {
  const isDice = (v: unknown): boolean =>
    !!v && typeof v === "object" &&
    ((v as { type?: string }).type === "TriggeringDiceValue" || typeof (v as { dice?: string }).dice === "string");
  return effects.some((e) =>
    e.type === "CoinFlip" ||
    isDice((e as { Damage?: unknown }).Damage) ||
    isDice((e as { amount?: unknown }).amount) ||
    isDice((e as { cells?: unknown }).cells));
}

// Apply the allied roll reactions for `side`'s rolls (n rolls): buff its board
// Sentinelles (+n AT / +n AR) and discount its hand Atout Cachés (−n PA). Both
// changes are permanent stat/cost edits (not auras), so they survive recomputes.
function applyAllyRollReactions(state: GameState, side: Side, n: number): GameState {
  if (n <= 0) return state;
  let result = state;
  // Board creatures with a RollReaction stat buff (Sentinelle Affûtée #1606): +n×attack
  // AT (current+base) and +n×armor AR, permanently.
  if (result.creatures.some((c) => { if (c.currentLife <= 0 || c.owner !== side) return false; const r = rollReactionOf(c.cardId); return !!r && (!!r.attack || !!r.armor); })) {
    result = {
      ...result,
      creatures: result.creatures.map((c) => {
        if (c.currentLife <= 0 || c.owner !== side) return c;
        const r = rollReactionOf(c.cardId);
        if (!r || (!r.attack && !r.armor)) return c;
        const da = n * (r.attack ?? 0), dr = n * (r.armor ?? 0);
        return { ...c, currentAttack: c.currentAttack + da, baseAttack: c.baseAttack + da, armor: c.armor + dr };
      }),
    };
  }
  // Hand cards with a RollReaction cost shift (Atout Caché #1201): handCostMod += n×handCost.
  const p = result.players[side];
  if (p.hand.some((id) => rollReactionOf(id)?.handCost)) {
    const handCostMods = p.hand.map((id, i) => (p.handCostMods[i] ?? 0) + n * (rollReactionOf(id)?.handCost ?? 0));
    result = { ...result, players: { ...result.players, [side]: { ...p, handCostMods } } };
  }
  return result;
}

// The base Orbe card (#708). A NÉCROME grants one to its owner's hand when played
// (a keyword behaviour, keyed off isNecrome like the banish above, not authored
// per-card). A later layer adds a second Orbe when a Dofus is revealed.
const ORBE_CARD_ID = 708;

// Orbe fusion chain (printed on the tokens themselves), both ENABLED, see fuseOrbesInHand:
//   • 3× Orbe (#708) in hand → fuse into 1 Orbe Doré (#594)
//   • 2× Orbe Doré (#594) in hand → fuse into 1 Nécronomigore (#700)  (#700 is now playable,
//     AttachNecronomigore + FIN_DE_TOUR tick/fire)
const ORBE_DORE_CARD_ID = 594;
const NECRONOMIGORE_CARD_ID = 700;

// #800 "Phorzerker", the token an Enutrof's PHORZERKER fusion turns it into ("Invocation
// issue de la fusion entre un Phorreur et un Enutrof"). Its printed 5/5/2 is overridden by
// the fusion (summed AT/PV, Enutrof's PM); the token only supplies the identity/family.
const PHORZERKER_TOKEN_ID = 800;

// Drop 1 PA off every Golgor currently in `side`'s hand (a handCostMods stamp),
// Build the "butin cells" set an AdvanceTracking needs, and strip consumed ones.
function buildButinCells(state: GameState): Set<string> {
  const s = new Set<string>();
  for (const b of state.butins ?? []) s.add(`${b.position.x},${b.position.y}`);
  return s;
}
function removeConsumedButins(state: GameState, consumed: Set<string>): GameState {
  if (consumed.size === 0) return state;
  return { ...state, butins: (state.butins ?? []).filter((b) => !consumed.has(`${b.position.x},${b.position.y}`)) };
}
// Grant one random Butin reward (seeded) to `side`'s hand, and apply the
// "−N PA in hand per Butin picked up" markers (Golgor #1349 = allyButinPickup) to the
// same side (the picker). This is the single chokepoint for every pickup path,
// walk-over, summon-on, and Bernalette's GrabAllButins (called once per butin), so the
// discount covers them all.
function applyButinReward(state: GameState, side: Side, rng: Rng, at?: Coords): GameState {
  const awarded = BUTIN_REWARD_IDS[rng.int(3)];
  // Log the card gained (CARD_MOVED nowhere→hand, stamped `at` = the butin's cell when it comes from
  // a walk) before adding it: the replay makes it fly to the hand while the creature is stopped on the
  // butin, then the move goes on. Full hand: no log, the card burns.
  const logged = logCardCreatedInHand(state, side, awarded, at);
  const withReward = addCardToHand(logged, side, awarded, 1, 0);
  const stamped = stampHandCostOnEvent(withReward, side, "allyButinPickup", 1);
  return applyButinPickupReactions(stamped, side); // Ratchet #589
}
// Ratchet #589: "Inflige N au Dofus adverse de sa ligne quand vous ramassez un Butin."
// A passive on card.effects (like Malox #76's heal version), applyButinReward is the
// single chokepoint for every pickup by `side`, so after the reward each living Ratchet
// the picker owns strikes the enemy Dofus on its own row (canonical woundDofus → breaks a
// Sinistro; skips an invulnerable Dofus; resolveDeathsAndWin settles capture/win).
function applyButinPickupReactions(state: GameState, side: Side): GameState {
  const ratchets = state.creatures.filter((c) => c.currentLife > 0 && c.owner === side &&
    (getCard(c.cardId)?.effects ?? []).some((e) => e.type === "DamageDofusOnRowOnButinPickup"));
  if (ratchets.length === 0) return state;
  const dofuses = state.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
  const log = [...state.log];
  let hit = false;
  for (const r of ratchets) {
    const mk = (getCard(r.cardId)?.effects ?? []).find((e) => e.type === "DamageDofusOnRowOnButinPickup") as { amount?: number } | undefined;
    const amount = mk?.amount ?? 1;
    const dof = dofuses.find((o) => o.currentLife > 0 && o.owner !== r.owner && o.position.y === r.position.y);
    if (!dof || dofusInvulnerable(dof, state.creatures)) continue; // Artheon #1424
    woundDofus(dof, amount, log, state.creatures, dofuses); // canonical Dofus damage (breaks any Sinistro)
    hit = true;
    if (dof.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", dofusAt: { ...dof.position } });
    else log.push({ type: "DAMAGE", targetCell: { ...dof.position }, damage: amount });
  }
  if (!hit) return state;
  return resolveDeathsAndWin({ ...state, dofuses }, state.creatures, dofuses, log, new Set());
}
// Maluss #292: "Inflige N au Dofus adverse de sa ligne quand vous volez ou détruisez un prisme
// adverse." Mirror of Ratchet #589 (butins). `count` = number of enemy prisms `side` just removed
// (stole or destroyed); each living Maluss the side owns strikes the enemy Dofus on its own row for
// amount×count (canonical woundDofus, breaks a Sinistro, skips an invulnerable Dofus, settles win).
function applyEnemyPrismLossReactions(state: GameState, side: Side, count: number): GameState {
  if (count <= 0) return state;
  const malusses = state.creatures.filter((c) => c.currentLife > 0 && c.owner === side &&
    (getCard(c.cardId)?.effects ?? []).some((e) => e.type === "DamageDofusOnRowOnEnemyPrismLoss"));
  if (malusses.length === 0) return state;
  const dofuses = state.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
  const log = [...state.log];
  let hit = false;
  for (const r of malusses) {
    const mk = (getCard(r.cardId)?.effects ?? []).find((e) => e.type === "DamageDofusOnRowOnEnemyPrismLoss") as { amount?: number } | undefined;
    const amount = (mk?.amount ?? 1) * count;
    const dof = dofuses.find((o) => o.currentLife > 0 && o.owner !== r.owner && o.position.y === r.position.y);
    if (!dof || dofusInvulnerable(dof, state.creatures)) continue; // Artheon #1424
    woundDofus(dof, amount, log, state.creatures, dofuses);
    hit = true;
    if (dof.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", dofusAt: { ...dof.position } });
    else log.push({ type: "DAMAGE", targetCell: { ...dof.position }, damage: amount });
  }
  if (!hit) return state;
  return resolveDeathsAndWin({ ...state, dofuses }, state.creatures, dofuses, log, new Set());
}

// Apply all the butin pickups an advance pass collected: each rolls a reward into
// the picker's hand. Returns the new state (RNG state already advanced by `rng`).
function applyButinPickups(state: GameState, pickups: { side: Side; at: Coords }[], rng: Rng): GameState {
  let result = state;
  for (const pk of pickups) result = applyButinReward(result, pk.side, rng, pk.at);
  return result;
}

// ---- Cadeaux de Nowel (Reine de Nowel #703) --------------------------------------------------
// Board "gift cells" (keyed "x,y", owner-agnostic) an AdvanceTracking needs, and the strip pass.
function buildGiftCells(state: GameState): Set<string> {
  const s = new Set<string>();
  for (const g of state.gifts ?? []) s.add(`${g.position.x},${g.position.y}`);
  return s;
}
function removeConsumedGifts(state: GameState, consumed: Set<string>): GameState {
  if (consumed.size === 0) return state;
  return { ...state, gifts: (state.gifts ?? []).filter((g) => !consumed.has(`${g.position.x},${g.position.y}`)) };
}
// The four equally likely outcomes of using a Cadeau de Nowel. The order does not matter (25% each)
// but stays fixed so replays match: 0 → +1 AT, 1 → +1 AR, 2 → +1 PM, 3 → 1 damage. The draw is a
// plain rng.int(4), not the dice-value path, so Dé Pipé does not bias it (the outcome is
// "équiprobable"; Sentinelle/Atout only react to it, they do not change it).
const GIFT_OUTCOMES = 4;
// Salt of the RNG stream derived for gifts (see AdvanceTracking.giftRng): keeps the inline draws of
// the advance apart from the main state.rng stream (32-bit golden ratio).
const GIFT_ROLL_SALT = 0x9e3779b9;
// Salt of the coin flip stream for COUP DE GRÂCE "change de propriétaire" resolved inline.
const CDG_DEFECT_SALT = 0x85ebca6b;
// Outcome of one gift, applied inline in the mutable context of the advance (the `creatures` array
// of the pass): the creature picks it up and the outcome happens there. Lethal damage leaves
// currentLife at 0, so the advance loop stops (`while (me.currentLife > 0)`) and the settle's
// resolveDeathsAndWin kills it on the gift cell ("elle doit mourir à l'endroit où elle s'est pris
// les dégâts"), like an enemy seed or the Gangraîne poison. The +1 PM only changes baseMovement (it
// never extends the current advance); the +1 AT counts right away (including the fight at the end of
// a charge). Each outcome is stamped `at` = the gift cell (the replay plays it at the moment of the
// pickup).
function applyGiftOutcomeInline(me: CreatureInstance, log: GameEvent[], rng: Rng, at: Coords): void {
  const roll = rng.int(GIFT_OUTCOMES);
  if (roll === 0) {
    const before = me.currentAttack;
    me.currentAttack += 1; me.baseAttack += 1; // permanent
    log.push({ type: "ATTACK_GAINED", instanceId: me.instanceId, attackMod: { valueBefore: before, modification: 1, valueAfter: me.currentAttack }, at: { ...at } });
  } else if (roll === 1) {
    const before = me.armor;
    me.armor += 1;
    log.push({ type: "ARMOR_GAINED", instanceId: me.instanceId, armorMod: { valueBefore: before, modification: 1, valueAfter: me.armor }, at: { ...at } });
  } else if (roll === 2) {
    const before = me.baseMovement;
    me.baseMovement += 1; // permanent PM (jamais movementLeft → pas d'extension de l'avance)
    log.push({ type: "MOVEMENT_POINT_BOOST", instanceId: me.instanceId, movementMod: { valueBefore: before, modification: 1, valueAfter: me.baseMovement }, at: { ...at } });
  } else {
    const armorBefore = me.armor;
    const dealt = applyDamageToCreature(me, 1, log); // respects armor/shield/résistance like any damage
    if (dealt > 0 || armorBefore > me.armor) {
      log.push({ type: "DAMAGE", targetInstanceId: me.instanceId, damage: dealt, armorHit: armorBefore > me.armor, at: { ...at } });
    }
    // Death from a board hazard: logged where it happens (see seed/trap). The creature dies on the gift
    // cell, and the advance stops right after.
    if (me.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", instanceId: me.instanceId });
  }
}
// Roll reactions deferred to settle time: each pickup is an allied roll for the camp that picks it
// up, but Sentinelle Affûtée #1606 / Atout Caché #1201 work at the state level (hands, costs), which
// the advance cannot reach. So they are applied by count (the rollCounts pattern of the death path),
// then the derived giftRng stream is folded into state.rng, only if draws happened, so games with no
// gift keep exactly the same state.rng.
function applyGiftRollReactions(state: GameState, tr: AdvanceTracking): GameState {
  const total = tr.giftRolls.ally + tr.giftRolls.enemy;
  if (total === 0) return state;
  let result = { ...state, rng: tr.giftRng.state };
  for (const side of ["ally", "enemy"] as const) {
    if (tr.giftRolls[side] > 0) result = applyAllyRollReactions(result, side, tr.giftRolls[side]);
  }
  return result;
}
// Apply one gift pickup to creature `instanceId` (picked up by `side`) at the state level. This is
// the path of a summon placed on the gift (the creature does not walk: it is already on the cell
// and dies there if the draw is lethal). The walking path goes through applyGiftOutcomeInline
// during the advance.
// Returns { state, damaged } so the batch can settle deaths/contre-coup once.
function applyOneGiftOutcome(state: GameState, instanceId: number, side: Side, rng: Rng, at: Coords): { state: GameState; damaged: boolean } {
  const creatures = state.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
  const me = creatures.find((c) => c.instanceId === instanceId && c.currentLife > 0);
  let damaged = false;
  if (me) {
    const log = [...state.log];
    const lifeBefore = me.currentLife, armorBefore = me.armor;
    applyGiftOutcomeInline(me, log, rng, at);
    damaged = me.currentLife < lifeBefore || me.armor < armorBefore;
    state = { ...state, creatures, log };
  } else {
    // Nobody to reward (the creature is already dead): the draw still happened on the RNG side, nothing
    // to log.
    rng.int(GIFT_OUTCOMES);
  }
  // The consumption is an allied dice/coin roll for the picker → its roll reactions fire (the
  // death + contre-coup of a lethal roll are settled once by the batch caller, applyGiftPickups).
  state = applyAllyRollReactions(state, side, 1);
  return { state, damaged };
}
// Apply every gift pickup a SUMMON-ONTO collected (the walk path resolves inline via
// applyGiftOutcomeInline now). Each rolls its outcome onto the consuming creature and
// fires that side's roll reactions; if any roll dealt damage, a single
// resolveDeathsAndWin (with ccFrom = the log index before the first outcome) settles
// the resulting deaths and the wounded survivors' CONTRE COUP in the usual cell-sweep.
// Returns the new state (RNG already advanced by `rng`).
function applyGiftPickups(state: GameState, pickups: { instanceId: number; side: Side; at: Coords }[], rng: Rng): GameState {
  if (pickups.length === 0) return state;
  let result = state;
  const ccFrom = result.log.length; // contre-coup salve begins here (any gift damage below)
  let anyDamage = false;
  for (const pk of pickups) {
    const r = applyOneGiftOutcome(result, pk.instanceId, pk.side, rng, pk.at);
    result = r.state;
    anyDamage = anyDamage || r.damaged;
  }
  if (anyDamage) {
    const creatures = result.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
    const dofuses = result.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
    const log = [...result.log];
    result = resolveDeathsAndWin({ ...result, creatures, dofuses, log }, creatures, dofuses, log, new Set(), new Set(), new Set(), ccFrom);
  }
  return result;
}

// Build the "cell → seed owner" map an AdvanceTracking needs from the current
// board, and (after the advance pass) strip the seeds a walker consumed.
function buildSeedCells(state: GameState): Map<string, Side> {
  const m = new Map<string, Side>();
  for (const s of state.seeds ?? []) m.set(`${s.position.x},${s.position.y}`, s.owner);
  return m;
}

// "cell → trap" map for the walk-over machinery (Sram Bombe #101).
function buildTrapCells(state: GameState): Map<string, TrapInstance> {
  const m = new Map<string, TrapInstance>();
  for (const t of state.traps ?? []) m.set(`${t.position.x},${t.position.y}`, t);
  return m;
}

// Strip the traps an advance pass consumed (stepped on) from the board.
function removeConsumedTraps(state: GameState, consumed: Set<string>): GameState {
  if (consumed.size === 0) return state;
  return { ...state, traps: (state.traps ?? []).filter((t) => !consumed.has(`${t.position.x},${t.position.y}`)) };
}

// Allies that walked over their own trap pick it up: the trap card returns to that
// side's hand (honouring MAX_HAND inside addCardToHand).
function applyTrapPickups(state: GameState, pickups: { side: Side; cardId: number }[]): GameState {
  let result = state;
  for (const p of pickups) result = addCardToHand(result, p.side, p.cardId, 1);
  return result;
}
function removeConsumedSeeds(state: GameState, consumed: Set<string>): GameState {
  if (consumed.size === 0) return state;
  // recomputeAuras: losing a seed may drop a side from ≥1 → 0, revoking any
  // ConditionalSeedProperty (Kolo Kolko).
  return recomputeAuras({
    ...state,
    seeds: (state.seeds ?? []).filter((s) => !consumed.has(`${s.position.x},${s.position.y}`)),
  });
}
function buildTasDOsCells(state: GameState): Map<string, Side> {
  const m = new Map<string, Side>();
  for (const t of state.tasDOs ?? []) m.set(`${t.position.x},${t.position.y}`, t.owner);
  return m;
}
function removeConsumedTasDOs(state: GameState, consumed: Set<string>): GameState {
  if (consumed.size === 0) return state;
  return { ...state, tasDOs: (state.tasDOs ?? []).filter((t) => !consumed.has(`${t.position.x},${t.position.y}`)) };
}
// Bushes: "toute créature qui marche sur un buisson le détruit". Any owner, like the use at summon
// time (summonCreature), except that here even an enemy bush goes. It does not block: the move goes
// on.
function buildBushCells(state: GameState): Set<string> {
  return new Set((state.bushes ?? []).map((b) => `${b.position.x},${b.position.y}`));
}
function removeConsumedBushes(state: GameState, consumed: Set<string>): GameState {
  if (consumed.size === 0) return state;
  return { ...state, bushes: (state.bushes ?? []).filter((b) => !consumed.has(`${b.position.x},${b.position.y}`)) };
}
function buildGlyphCells(state: GameState): Map<string, Side> {
  const m = new Map<string, Side>();
  for (const g of state.glyphs ?? []) m.set(`${g.position.x},${g.position.y}`, g.owner);
  return m;
}
function removeConsumedGlyphs(state: GameState, consumed: Set<string>): GameState {
  if (consumed.size === 0) return state;
  return {
    ...state,
    glyphs: (state.glyphs ?? []).filter((g) => !consumed.has(`${g.position.x},${g.position.y}`)),
  };
}

// Damage an enemy seed inflicts when an enemy walks onto it: 1 by default,
// raised to the SeedStepDamage aura amount while the seed's owner has a living
// creature carrying it (Soldat Cornouiller: "Tant qu'elle est en jeu vos Graines
// infligent 2 dégâts aux invocations adverses qui marchent dessus").
function seedStepDamage(creatures: CreatureInstance[], seedOwner: Side): number {
  let dmg = 1;
  for (const c of creatures) {
    if (c.currentLife <= 0 || c.owner !== seedOwner) continue;
    for (const e of getCard(c.cardId)?.effects ?? []) {
      if (e.type === "SeedStepDamage") dmg = Math.max(dmg, ((e as { amount?: number }).amount ?? 1) | 0);
    }
  }
  return dmg;
}

// A creature `me` has just landed on cell (nx,ny): apply every walk-over pickup of a board object
// there (prism / seed / piège / glyphe / tas d'os / butin), recording what was used up in `tr` so the
// caller's apply pass (resolveDeathsAndWin + the remove/activate helpers) can settle it. Single
// source of truth, shared by advanceCreature's step and Téléportation #119 (a teleport also picks up
// or triggers what it lands on).
// The "+N AT tant qu'il est dans VOTRE camp" amount for `me`, which depends on its position (Exécuteur
// Endeuillé #1425); 0 if it has none or is silenced (a silenced creature gives no self boost, same
// as withAuras step 2b). Used by the mid-advance resync below so the boost follows the camp line.
function inCampAttackBoost(me: CreatureInstance): number {
  if (me.silenced) return 0;
  let total = 0;
  for (const e of getCard(me.cardId)?.effects ?? []) {
    if (e.type === "ConditionalStatBoost" &&
        (e as { stat?: string }).stat === "attack" &&
        (e as { condition?: string }).condition === "inOwnCamp") {
      total += (e as { amount?: number }).amount ?? 0;
    }
  }
  return total | 0;
}

function applyWalkOverPickups(me: CreatureInstance, nx: number, ny: number, creatures: CreatureInstance[], log: GameEvent[], tr: AdvanceTracking): void {
    const cellKey = `${nx},${ny}`;
    // Exécuteur Endeuillé #1425 "+N AT tant qu'il est dans VOTRE camp": this boost depends on the
    // position, so it must drop the moment the creature crosses its camp line mid-advance; withAuras at
    // the phase boundary is too coarse. It is resynced against the cell being entered (nx), keeping
    // currentAttack/baseAttack/auraAttack in step so the next withAuras removes the right amount.
    // `inCampAtk` records the folded part (set by withAuras step 2b, like condArmorGranted). It corrects
    // itself outside the sweep: any later recomputeAuras removes auraAttack (kept consistent here) and
    // computes it again from scratch.
    {
      const boost = inCampAttackBoost(me);
      const have = me.inCampAtk ?? 0;
      if (boost !== 0 || have !== 0) {
        const want = isAlliedTerritory(nx, me.owner) ? boost : 0;
        const delta = want - have;
        if (delta !== 0) {
          me.currentAttack += delta;
          me.baseAttack += delta;
          me.auraAttack += delta;
          me.inCampAtk = want;
        }
      }
    }
    if (
      tr.prismCellKeys.has(cellKey) &&
      !tr.collectedPrismKeys.has(cellKey) &&
      !me.properties.has("DontTriggerPrismsEffects")
    ) {
      tr.collectedPrismKeys.add(cellKey);
      tr.prismPickups.push({ at: { x: nx, y: ny }, side: me.owner, props: new Set(me.properties), byInstanceId: me.instanceId });
    }
    // Seed walk-over: stepping onto a seed cell consumes the seed. An allied
    // seed (same owner as the walker) grants +1 AR; an enemy seed deals 1
    // damage. Taken once per cell; the seed does not block, so movement continues.
    const seedOwner = tr.seedCells.get(cellKey);
    if (seedOwner !== undefined && !tr.consumedSeedKeys.has(cellKey)) {
      tr.consumedSeedKeys.add(cellKey);
      if (seedOwner === me.owner) {
        const armorBefore = me.armor;
        me.armor += 1;
        log.push({
          type: "ARMOR_GAINED",
          instanceId: me.instanceId,
          armorMod: { valueBefore: armorBefore, modification: 1, valueAfter: me.armor },
        });
      } else {
        // Garde du corps #320/#300: a bodyguard soaks up to its own life, the rest overflows onto me.
        const r = applyGuardedCombatDamage(me, seedStepDamage(creatures, seedOwner), log, creatures, false);
        // Death from a board hazard: logged where it happens, like the shooter (seed/trap/gift deaths used
        // to be culled by the settle with no FIGHT_OBJECT_REMOVED, so they were never animated). The advance
        // loop stops (it checks currentLife > 0): the creature dies on the cell.
        if (r.recipientDied) log.push({ type: "FIGHT_OBJECT_REMOVED", instanceId: r.recipient.instanceId });
        if (r.victimDied && me.instanceId !== r.recipient.instanceId) log.push({ type: "FIGHT_OBJECT_REMOVED", instanceId: me.instanceId });
      }
    }
    // Piège walk-over (Sram Bombe #101). An enemy of the trap's owner takes its
    // damage; an ally picks it up (the trap card returns to the owner's hand). Taken
    // once per cell; the trap does not block, so movement continues.
    const trap = tr.trapCells.get(cellKey);
    if (trap !== undefined && !tr.consumedTrapKeys.has(cellKey)) {
      tr.consumedTrapKeys.add(cellKey);
      if (trap.owner === me.owner) {
        tr.trapPickups.push({ side: me.owner, cardId: trap.cardId });
      } else {
        // Garde du corps #320/#300: a bodyguard soaks up to its own life, the rest overflows onto me.
        const r = applyGuardedCombatDamage(me, trap.damage, log, creatures, false);
        // Mort par danger de terrain : journalisée au site (cf. graine ci-dessus).
        if (r.recipientDied) log.push({ type: "FIGHT_OBJECT_REMOVED", instanceId: r.recipient.instanceId });
        if (r.victimDied && me.instanceId !== r.recipient.instanceId) log.push({ type: "FIGHT_OBJECT_REMOVED", instanceId: me.instanceId });
      }
    }
    // Glyphe walk-over (base Glyphe #827). An enemy of the glyph's owner destroys
    // it (no bonus). An allied Féca gains +AR = number of rows (y) that hold at
    // least one allied glyph, the glyph persists (only enemies destroy it). An
    // allied non-Féca does nothing.
    const glyphOwner = tr.glyphCells.get(cellKey);
    if (glyphOwner !== undefined && !tr.consumedGlyphKeys.has(cellKey)) {
      if (glyphOwner !== me.owner) {
        tr.consumedGlyphKeys.add(cellKey); // enemy steps on it → destroyed
      } else if (getCard(me.cardId)?.god === "Feca") {
        const rows = new Set<number>();
        for (const [k, o] of tr.glyphCells) {
          if (o === glyphOwner && !tr.consumedGlyphKeys.has(k)) rows.add(Number(k.split(",")[1]));
        }
        const ar = rows.size;
        if (ar > 0) {
          const armorBefore = me.armor;
          me.armor += ar;
          log.push({
            type: "ARMOR_GAINED",
            instanceId: me.instanceId,
            armorMod: { valueBefore: armorBefore, modification: ar, valueAfter: me.armor },
          });
        }
      }
    }
    // Tas d'Os walk-over (Chafer). Stepping onto a Tas d'Os always uses it up. An allied Chafer (same
    // owner) gains +1 AT +1 AR (permanent, adds up); any other creature that lands there (an allied
    // non-Chafer or any enemy) just destroys it.
    const tasOwner = tr.tasDOsCells.get(cellKey);
    if (tasOwner !== undefined && !tr.consumedTasDOsKeys.has(cellKey)) {
      tr.consumedTasDOsKeys.add(cellKey);
      if (tasOwner === me.owner && (famsOf(me)).includes("Chafer")) {
        const atBefore = me.currentAttack;
        me.currentAttack += 1;
        me.baseAttack += 1; // persistent (current and base move together)
        log.push({ type: "ATTACK_GAINED", instanceId: me.instanceId, attackMod: { valueBefore: atBefore, modification: 1, valueAfter: me.currentAttack } });
        const arBefore = me.armor;
        me.armor += 1;
        log.push({ type: "ARMOR_GAINED", instanceId: me.instanceId, armorMod: { valueBefore: arBefore, modification: 1, valueAfter: me.armor } });
      }
    }
    // Bush walk-over: "toute créature qui marche sur un buisson le détruit". Any owner, no effect and no
    // blocking: the cell is simply freed.
    if (tr.bushCells.has(cellKey) && !tr.consumedBushKeys.has(cellKey)) {
      tr.consumedBushKeys.add(cellKey);
    }
    // Butin walk-over: stepping onto a butin cell consumes it (owner-agnostic) and
    // records a pickup for the WALKER's side, it gets a random reward after the
    // pass. The butin does not block, so movement continues.
    if (tr.butinCells.has(cellKey) && !tr.consumedButinKeys.has(cellKey)) {
      tr.consumedButinKeys.add(cellKey);
      // Inline marker (like the prism and the gift): it cuts the replay's walk block exactly on the butin.
      // The creature stops there, the card gained (reward stamped `at`, deferred to settle time) flies to
      // the hand at that moment, then the move goes on.
      log.push({ type: "A_O_E_ACTIVATED", at: { x: nx, y: ny }, kind: "loot", byInstanceId: me.instanceId });
      tr.butinPickups.push({ side: me.owner, at: { x: nx, y: ny } });
    }
    // Cadeau de Nowel walk-over: the cell is used up (any owner) and the outcome is resolved inline, at
    // the moment of the step (draw on the derived tr.giftRng stream). Lethal damage stops the advance
    // (the loop checks currentLife > 0) and the creature dies on the gift cell, like an enemy seed. Only
    // the roll reactions (Sentinelle/Atout, at the state level) are deferred to settle time, by count
    // (tr.giftRolls). A gift does not block: if the creature survives, the move goes on.
    if (tr.giftCells.has(cellKey) && !tr.consumedGiftKeys.has(cellKey)) {
      tr.consumedGiftKeys.add(cellKey);
      // Inline pickup marker (like the prism, the only pickup that carries a cell): it cuts the replay's
      // walk block exactly on the gift. The creature stops there, the outcome (stamped `at`) plays on the
      // spot, then the walk/charge goes on. No rules effect.
      log.push({ type: "A_O_E_ACTIVATED", at: { x: nx, y: ny }, kind: "gift", byInstanceId: me.instanceId });
      applyGiftOutcomeInline(me, log, tr.giftRng, { x: nx, y: ny });
      tr.giftRolls[me.owner] += 1;
    }
}

// Gangraîne #1439 (movementPoison): a poisoned creature takes `movementPoison` self-damage for
// each cell it steps through. Funneled through every per-cell move site, the normal advance
// (stepInto) and a forced slide (push / attract / retreat, via makeSlideStep). Self-damage: no
// source, no bodyguard redirect; death is settled by the caller's resolveDeathsAndWin.
function applyMovementPoisonStep(me: CreatureInstance, log: GameEvent[]): void {
  if (me.movementPoison > 0 && me.currentLife > 0) {
    const armorBefore = me.armor;
    const dealt = applyDamageToCreature(me, me.movementPoison, log);
    if (dealt > 0 || armorBefore > me.armor) {
      log.push({ type: "DAMAGE", targetInstanceId: me.instanceId, damage: dealt, armorHit: armorBefore > me.armor });
    }
    // Death from a board hazard: logged where it happens (see seed/trap/gift).
    if (me.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", instanceId: me.instanceId });
  }
}

// Per-cell hook that a forced slide (slideCreatureBack) runs for each crossed cell, so a pushed /
// attracted / retreating creature interacts with the board exactly like a walking step: token
// walk-over (graine/piège/butin/glyphe/tas d'os/prisme) + gangrène, one creature at a time (it
// "se déplacera seule … chaque case du trajet"). Closes over the same mutable arrays + AdvanceTracking
// that the caller settles afterwards (removeConsumed* / activatePrism / butin rolls). Same order as
// stepInto: walk-over, then gangrène.
function makeSlideStep(
  creatures: CreatureInstance[],
  log: GameEvent[],
  tr: AdvanceTracking,
): (mover: CreatureInstance, nx: number, ny: number) => void {
  return (mover, nx, ny) => {
    applyWalkOverPickups(mover, nx, ny, creatures, log, tr);
    applyMovementPoisonStep(mover, log);
  };
}

// Move the creature `instanceId` onto cell (nx,ny), already checked free by the caller, then make it
// interact with whatever object is there, exactly like advancing onto the cell (full walk-over). A
// single `applyWalkOverPickups` + the same settle pass as Téléportation #119: used seeds/glyphes/tas
// d'os/butins/pièges are removed, butin rewards rolled, trap pickups sent back to hand, an enemy
// seed/piège deals damage (deaths/win settle), and a prism that was picked up is activated (firing
// its ON_PRISM reactions, Lilotte #579 etc.). Shared by Truche #37 (ChangeRowSelf) and Nainfants
// #904 (MoveAdjacentRowRandom), two row changes that pick up what they land on.
function relocateThenPickup(state: GameState, instanceId: number, nx: number, ny: number): GameState {
  const creatures = state.creatures.map((cr) => ({ ...cr, position: { ...cr.position }, properties: new Set(cr.properties) }));
  const dofuses = state.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
  const moved = creatures.find((cr) => cr.instanceId === instanceId);
  if (!moved) return state;
  const from = { ...moved.position };
  moved.position = { x: nx, y: ny };
  // A row change is a teleport (the creature does not cross the cells in between: Truches, Larve
  // Verte). The original game has three kinds of move, and the last two differ on one point:
  //   walk      → the end-of-turn advance;
  //   slide     → push effect, 0.6 s, then the object slides to its cell (speed ×2), 0.5 s;
  //   teleport  → the same push effect, 0.6 s, then the object is placed at once, 0.5 s.
  // The row change is the teleport: same effect, different move. The slide is kept for pushes
  // ("Repoussez").
  const log: GameEvent[] = [...state.log, { type: "FIGHT_OBJECT_MOVED", instanceId, from, to: { x: nx, y: ny }, movementType: "TELEPORT" }];
  const tr: AdvanceTracking = {
    brokeThroughIds: new Set<number>(),
    prismCellKeys: new Set(state.prisms.map((p) => `${p.position.x},${p.position.y}`)),
    collectedPrismKeys: new Set<string>(),
    prismPickups: [],
    seedCells: buildSeedCells(state), consumedSeedKeys: new Set<string>(),
    glyphCells: buildGlyphCells(state), consumedGlyphKeys: new Set<string>(),
    tasDOsCells: buildTasDOsCells(state), consumedTasDOsKeys: new Set<string>(),
    bushCells: buildBushCells(state), consumedBushKeys: new Set<string>(),
    butinCells: buildButinCells(state), consumedButinKeys: new Set<string>(), butinPickups: [],
    giftCells: buildGiftCells(state), consumedGiftKeys: new Set<string>(), giftRng: new Rng((state.rng ^ GIFT_ROLL_SALT) | 0), giftRolls: { ally: 0, enemy: 0 },
    trapCells: buildTrapCells(state), consumedTrapKeys: new Set<string>(), trapPickups: [],
  };
  applyWalkOverPickups(moved, nx, ny, creatures, log, tr);
  let result = resolveDeathsAndWin({ ...state, creatures, dofuses, log }, creatures, dofuses, log, tr.brokeThroughIds);
  result = removeConsumedSeeds(result, tr.consumedSeedKeys);
  result = removeConsumedGlyphs(result, tr.consumedGlyphKeys);
  result = removeConsumedTasDOs(result, tr.consumedTasDOsKeys);
  result = removeConsumedBushes(result, tr.consumedBushKeys);
  result = removeConsumedButins(result, tr.consumedButinKeys);
  result = removeConsumedGifts(result, tr.consumedGiftKeys);
  result = removeConsumedTraps(result, tr.consumedTrapKeys);
  result = applyTrapPickups(result, tr.trapPickups);
  const rng = new Rng(result.rng);
  result = applyButinPickups(result, tr.butinPickups, rng);
  result = applyGiftRollReactions(result, tr);
  result = { ...result, rng: rng.state };
  for (const pk of tr.prismPickups) result = activatePrism(result, pk.at, pk.side, pk.props, undefined, pk.byInstanceId);
  return { ...result, creatures: withAuras(result.creatures) };
}

// ───────── shooter FIRE (single shot) ─────────
// Fire one shooter shot from `me` at the nearest enemy (creature or Dofus) ahead in its lane within
// `me.range` (every creature blocks the line of fire), taking no counter. Applies damage (garde du
// corps overflow for creatures, Lien de Sang redirect for Dofus), logs DAMAGE / FIGHT_OBJECT_REMOVED,
// and sets `me.hasAttacked`. Does not move the creature: the caller handles any step (the melee kill
// and continue) and the "stop after firing" bookkeeping.
//
// Single source of truth for a shooter's shot, used by:
//   - advanceCreature's shooter loop (the first shot), and
//   - Cléophée #28/#755/#845 (ShooterSecondAttack): a second normal shot after the advance, which
//     finds the nearest target again (it may differ from the first if that one died), only when an
//     allied Confrérie du Tofu member is in play.
//
// Returns { fired, killedAdjacentCreature }: `fired` is false when no enemy was in range;
// `killedAdjacentCreature` is true only when the shot killed a creature standing right ahead
// (d===1), which tells the caller the path may be free for a kill and continue step.
function fireShooterShot(
  me: CreatureInstance,
  creatures: CreatureInstance[],
  dofuses: DofusInstance[],
  log: GameEvent[],
  side: Side,
  dx: number,
  // Deferred-counter list threaded into resolveMeleeExchange for the d=1 case
  // (corps à corps), so a FirstStrike/bodyguard interaction orders like any melee.
  deferred?: { attackerId: number; targetId: number }[],
  // Tir Rapide #1178: the d=1 exchange below becomes one-way (no counter). Off everywhere else.
  noCounter = false,
  // Break-through: a shooter that destroys the adjacent Dofus (d=1, corps à corps) breaks through
  // exactly like a melee engage, so it needs the sweep's brokeThroughIds (Clara Byne). Absent only in
  // older tests; the d≥2 shot never breaks through.
  tr?: { brokeThroughIds: Set<number> },
): { fired: boolean; killedAdjacentCreature: boolean; adjacentCleared: boolean } {
  const R = me.range;
  const y = me.position.y;
  // First creature/Dofus on the line of fire. Every creature blocks the line of fire, allied or enemy
  // (a shooter used to fire at the Dofus over an allied creature). An ally in front means no shot; the
  // shooter walks up behind it (the walk below already stops one cell before the blocker) and waits.
  // The old "shooting over friendlies" was an implementation guess, never a rule.
  let enemy: { d: number; creature?: CreatureInstance; dofus?: DofusInstance } | null = null;
  for (let d = 1; d <= R; d++) {
    const x = me.position.x + dx * d;
    if (x < 0 || x >= BOARD_COLS) break;
    const cr = creatures.find(
      (c) => c.instanceId !== me.instanceId && c.currentLife > 0 && c.position.x === x && c.position.y === y,
    );
    if (cr) {
      if (cr.owner === side) return { fired: false, killedAdjacentCreature: false, adjacentCleared: false }; // allié = ligne bloquée
      enemy = { d, creature: cr };
      break;
    }
    const df = dofuses.find((dd) => dd.currentLife > 0 && dd.owner !== side && dd.position.x === x && dd.position.y === y);
    if (df) { enemy = { d, dofus: df }; break; }
  }
  if (!enemy) return { fired: false, killedAdjacentCreature: false, adjacentCleared: false };

  const myPierces = me.properties.has("PierceArmor");
  let killedAdjacentCreature = false;
  let meleePushes: { target: CreatureInstance; distance: number }[] = [];
  if (enemy.creature) {
    if (enemy.d === 1) {
      // CORPS À CORPS: a ranged unit only shoots without a reply at a distance (d ≥ 2). With the enemy
      // right next to it, it fights as a melee unit: a full exchange with a counter, like any melee.
      // Initiative (FirstStrike) still applies through resolveMeleeExchange, which also logs the deaths
      // itself. The only exception: `noCounter` (Tir Rapide #1178), where the triggered attack goes one
      // way even here, adjacent.
      // The exchange's pushes (Patty Ceriz #31) are applied here, not at the end of the function: at d=1
      // the fight is a full melee exchange, so the push comes from the exchange (and applies to both
      // fighters). The end of the function only covers the ranged shot (d ≥ 2), otherwise Patty would
      // push twice at contact.
      meleePushes = resolveMeleeExchange(me, enemy.creature, log, creatures, deferred, noCounter);
      killedAdjacentCreature = enemy.creature.currentLife <= 0;
    } else {
      // Garde du corps #320/#300: the shot lands on the target's bodyguard, which soaks only
      // up to its own life, the excess overflows onto the adjacent enemy. The shooter stops
      // only if that adjacent enemy itself died (to the overflow, or directly when unguarded).
      const r = applyGuardedCombatDamage(enemy.creature, me.currentAttack, log, creatures, myPierces, me.instanceId, true);
      if (r.recipientDied) log.push({ type: "FIGHT_OBJECT_REMOVED", instanceId: r.recipient.instanceId });
      if (r.victimDied && enemy.creature.instanceId !== r.recipient.instanceId) {
        log.push({ type: "FIGHT_OBJECT_REMOVED", instanceId: enemy.creature.instanceId });
      }
      // d ≥ 2 → never adjacent, so no kill-and-continue step.
    }
  } else if (enemy.dofus) {
    const toDofus = redirectDofusDamage(enemy.dofus, me.currentAttack, creatures, log, me.instanceId); // Lien de Sang #1495
    if (toDofus > 0) {
      woundDofus(enemy.dofus, toDofus, log, creatures, dofuses); // canonical Dofus damage (breaks any Sinistro)
      log.push({ type: "DAMAGE", targetCell: { ...enemy.dofus.position }, damage: toDofus, sourceInstanceId: me.instanceId, combat: true });
      if (enemy.dofus.currentLife <= 0) {
        log.push({ type: "FIGHT_OBJECT_REMOVED", dofusAt: { ...enemy.dofus.position } });
        // Break-through at contact (Clara Byne used to stay in play): a shooter that destroys the adjacent
        // Dofus (d=1, corps à corps) breaks through and goes back into the deck, exactly like the melee
        // engage (the attack at d=1 already works "like a melee"). A ranged shot (d ≥ 2) does not break
        // through, since the shooter is not touching the wall.
        if (enemy.d === 1 && tr) {
          me.currentLife = 0;
          tr.brokeThroughIds.add(me.instanceId);
          log.push({ type: "FIGHT_OBJECT_REMOVED", instanceId: me.instanceId, brokeThrough: true });
        }
      }
    }
  }
  // Patty Ceriz #31 (PushTargetOnAttack "repousse son adversaire quand elle attaque"): after the shot
  // lands, push the enemy creature it hit back (away from the shooter, so toward its own wall), if it
  // survived. Only creatures (a Dofus cannot be pushed). The ranged shot (d ≥ 2) is handled here; corps
  // à corps (d = 1) is a melee exchange and its push comes from resolveMeleeExchange (meleePushes).
  // Without this split, Patty pushed twice at contact.
  // When silenced, it does not push anymore (same check as in melee).
  if (enemy.d >= 2 && !me.silenced) {
    const pushMk = (getCard(me.cardId)?.effects ?? []).find((e) => e.type === "PushTargetOnAttack") as { distance?: number } | undefined;
    if (pushMk && enemy.creature && enemy.creature.currentLife > 0) {
      slideCreatureBack(enemy.creature, creatures, dofuses, Math.max(0, (pushMk.distance ?? 0) | 0), log);
    }
  }
  for (const p of meleePushes) {
    if (p.target.currentLife > 0) slideCreatureBack(p.target, creatures, dofuses, p.distance, log);
  }
  me.hasAttacked = true;
  // Was the cell in front of us freed by this shot? A shooter normally stops after attacking, unless
  // the way opens: the adjacent victim died, or it was pushed back (Patty Ceriz #31 at corps à corps:
  // Patty then moves one cell and starts the fight again). We test from our current cell: we may have
  // moved back ourselves if the target was the one with the marker.
  const aheadX = me.position.x + dx;
  const adjacentCleared =
    enemy.d === 1 && !!enemy.creature &&
    !creatures.some((c) => c.instanceId !== me.instanceId && c.currentLife > 0 && c.position.x === aheadX && c.position.y === y) &&
    !dofuses.some((dd) => dd.currentLife > 0 && dd.position.x === aheadX && dd.position.y === y);
  return { fired: true, killedAdjacentCreature, adjacentCleared };
}

// Cléophée #28/#755/#845 (ShooterSecondAttack {family}): read the marker off the
// card and confirm its family condition, a second living ally of that family
// (besides `me` itself; Cléophée alone, being a Tofu, does not qualify). True
// → the shooter fires a second normal shot after its advance.
function shooterFiresSecondAttack(me: CreatureInstance, creatures: CreatureInstance[]): boolean {
  const m = (getCard(me.cardId)?.effects ?? []).find((e) => e.type === "ShooterSecondAttack") as { family?: string } | undefined;
  if (!m?.family) return false;
  return creatures.some(
    (c) => c.currentLife > 0 && c.owner === me.owner && c.instanceId !== me.instanceId && famsOf(c).includes(m.family!),
  );
}

// Advance one creature forward (direction `dx`, from `side`'s point of view) using all its remaining
// movementLeft, resolving fights / Dofus hits / wall break-throughs / prism pickups on the way, then
// the end-of-move "engage in front" attack. This is the single source of truth for creature
// movement: the end-of-turn phase calls it for every creature, and an immediate Charge spell calls
// it for the charged creature, so both behave the same.
// Rule 10: a creature that transforms itself on COUP DE GRÂCE (the Mulou chain #42→#193→#284→#813)
// stops its advance the moment it kills. It stays where it is (no break-through into the freed cell,
// no kill and continue). The transform itself still fires after combat (fireCoupDeGrace). Other COUP
// DE GRÂCE effects (e.g. #199 Mulou Garou's heal) keep the normal kill and continue.
function transformsOnCoupDeGrace(me: CreatureInstance): boolean {
  return me.triggers.some((t) => t.trigger === "COUP_DE_GRACE" && t.effects.some((e) => e.type === "Transform"));
}

// True if this creature's MORT summons a token onto its own death cell: placement "self" (exactly the
// death cell) or "near" (summonTokensNear picks the nearest free cell, and the death cell that was
// just freed is the only one at distance 0, so the token lands there). Rat Dominant #557 → Ratou
// #490. Such a token fills the freed cell the moment the victim dies, so a killer must not kill and
// continue through it. It stops at its current cell, and the end-of-advance death pass places the
// token on the (now free) cell.
function deathSummonFillsCell(victim: CreatureInstance): boolean {
  return victim.triggers.some(
    (t) =>
      t.trigger === "MORT" &&
      t.effects.some(
        (e) =>
          e.type === "SummonToken" &&
          ((e as { placement?: string }).placement === "near" || (e as { placement?: string }).placement === "self"),
      ),
  );
}

// Otomaï #447 (and similar): a victim whose MORT transforms every other invocation (TransformAll)
// changes the killer itself the moment it dies, so the killer stops there (no break-through) and
// every remaining mover of this sweep is cancelled, because it is about to be transformed too. True
// if, from the sweeping side's point of view, the transform really reaches that side's creatures:
// scope "all" (both camps), scope "enemy" = the victim's enemies = the killer's side, scope "ally" =
// the victim's own side (only cancels if the sweep is the victim's side; this never happens for a
// melee kill, but stays correct). The transform itself still fires after the sweep in
// resolveDeathsAndWin (seeded rng unchanged).
function deathTransformsAllHitsSide(victim: CreatureInstance, side: Side): boolean {
  const trig = victim.triggers.find((t) => t.trigger === "MORT");
  if (!trig) return false;
  return trig.effects.some((e) => {
    if (e.type !== "TransformAll") return false;
    const scope = (e as { scope?: string }).scope ?? "all";
    if (scope === "all") return true;
    if (scope === "enemy") return side !== victim.owner;
    if (scope === "ally") return side === victim.owner;
    return false;
  });
}

// Nenufar #821 (AllyFamilyDeathSeed): "tant qu'elle est en jeu, vos autres <famille> se transforment en
// Graines quand ils meurent". True iff, AT the moment `victim` dies, a living ally (not the victim itself)
// carries the marker for one of the victim's families, so the victim leaves a Seed on its death cell.
function leavesNenufarSeed(victim: CreatureInstance, creatures: CreatureInstance[]): boolean {
  const vFams = famsOf(victim);
  if (vFams.length === 0) return false;
  return creatures.some(
    (c) =>
      c.currentLife > 0 &&
      c.owner === victim.owner &&
      c.instanceId !== victim.instanceId &&
      (getCard(c.cardId)?.effects ?? []).some(
        (e) => e.type === "AllyFamilyDeathSeed" && vFams.includes((e as { family: string }).family),
      ),
  );
}

// Place a Nenufar death seed on the victim's cell the moment it dies during an advance (the seed must
// appear at death, not after all movement). It goes into `tr.seedCells` so the killer's own kill and
// continue step, and any later walker of this sweep, hits it through the normal walk-over rule (an
// enemy of the seed's owner takes 1 damage and uses it up; an ally gains +1 AR). The instanceId is
// recorded in `tr.deathSeeds` so processCombatPhase adds the ones no walker used to state.seeds, and
// tells resolveDeathsAndWin to skip them (no double placement). Does nothing unless the tracking
// asked for it (deathSeeds set).
function registerDeathSeed(victim: CreatureInstance, creatures: CreatureInstance[], tr: AdvanceTracking, log: GameEvent[]): void {
  if (!tr.deathSeeds) return;
  if (tr.brokeThroughIds.has(victim.instanceId)) return; // a Dofus capture is not a death, no seed (see capture-not-a-death)
  const key = `${victim.position.x},${victim.position.y}`;
  if (tr.seedCells.has(key)) return; // a seed already sits here (or already registered this death), do not stack a second
  if (!leavesNenufarSeed(victim, creatures)) return;
  tr.seedCells.set(key, victim.owner);
  tr.deathSeeds.push({ position: { ...victim.position }, owner: victim.owner, instanceId: victim.instanceId });
  // Appearance beat: the seed sprouts at the moment of death, so the replay shows it at this beat, not
  // at the final commit after all the moves (Klor Ofil dying with Nénufar in play).
  log.push({ type: "NEW_A_O_E", at: { ...victim.position }, ownerSide: victim.owner, aoeType: "seed" });
}

// After a creature finishes advancing, drop a Nenufar seed on the cell of every Sadida that died in
// this step but whose killer never stepped onto it: ranged fire, splash (Marteleur), a melee counter
// (the seed appears the moment the Sadida dies, in every case, so the rest of the sweep walks over
// it). The kill and continue sites already seeded the killer's own step; this catches the rest.
// Idempotent (registerDeathSeed checks the cell).
function registerPendingDeathSeeds(creatures: CreatureInstance[], tr: AdvanceTracking, log: GameEvent[]): void {
  if (!tr.deathSeeds) return;
  for (const c of creatures) {
    if (c.currentLife <= 0) registerDeathSeed(c, creatures, tr, log);
  }
}

// TAS D'OS version of registerDeathSeed: a dying Chafer leaves a Tas d'Os on its death cell the moment
// it dies, registered into `tasDOsCells` so the killer's kill and continue step, and any later
// walker of this sweep, interacts with it through applyWalkOverPickups (an allied Chafer gains
// +1AT+1AR; anyone else destroys it). The id is recorded in `tr.deathTasDOs` so processCombatPhase
// adds the ones no walker used and tells resolveDeathsAndWin to skip them. Does nothing unless the
// tracking asked for it (deathTasDOs set).
function registerDeathTasDOs(victim: CreatureInstance, tr: AdvanceTracking, log: GameEvent[]): void {
  if (!tr.deathTasDOs) return;
  if (tr.brokeThroughIds.has(victim.instanceId)) return; // a Dofus capture is not a death, no Tas d'Os (see capture-not-a-death)
  const key = `${victim.position.x},${victim.position.y}`;
  if (tr.tasDOsCells.has(key)) return; // a Tas d'Os already sits here (or already registered this death), do not stack a second
  if (!getCard(victim.cardId)?.tasDOs) return; // only TAS D'OS-tagged (Chafer) victims leave one
  tr.tasDOsCells.set(key, victim.owner);
  tr.deathTasDOs.push({ position: { ...victim.position }, owner: victim.owner, instanceId: victim.instanceId });
  // Appearance beat at the moment of death, same logic as the Nénufar seed.
  log.push({ type: "NEW_A_O_E", at: { ...victim.position }, ownerSide: victim.owner, aoeType: "tas_dos" });
}

// Post-advance scan mirroring registerPendingDeathSeeds: seed a Tas d'Os on every Chafer that died this step but
// whose killer never stepped onto it (range fire, splash, a melee counter). Idempotent (registerDeathTasDOs guards).
function registerPendingDeathTasDOs(creatures: CreatureInstance[], tr: AdvanceTracking, log: GameEvent[]): void {
  if (!tr.deathTasDOs) return;
  for (const c of creatures) {
    if (c.currentLife <= 0) registerDeathTasDOs(c, tr, log);
  }
}

function advanceCreature(
  me: CreatureInstance,
  creatures: CreatureInstance[],
  dofuses: DofusInstance[],
  log: GameEvent[],
  side: Side,
  dx: number,
  tr: AdvanceTracking,
  // RALLIEMENT (Féca): a rally advance only repositions. It walks forward collecting prisms/seeds/
  // butins like a charge but never fights (it stops before any creature) and stops the moment it
  // reaches the rally target's column (`stopAtCol`). `noCombat` turns off the shooter fire, the
  // en-route melee and the end-of-move engage.
  // CHARGE (`chargeMelee`): a shooter that charges does not fire at range; it only attacks once it
  // reaches CORPS À CORPS. So in charge mode a shooter skips its ranged branch and advances/engages as
  // a melee unit (taking the counter). The normal end-of-turn advance leaves this off, so shooters
  // fire at range.
  // naturalAdvance: this is the creature's own end-of-turn advance (the main sweep), the moment it
  // "would have finished advancing and playing its turn". A stunned creature spends that turn doing
  // nothing, then wakes up (its stun ends here). Forced charges / rallies / TriggerAttack leave it
  // unset, so those bonus actions never use up the stun.
  // noCounter (Tir Rapide #1178 only): the attack this advance resolves goes one way, the enemy hit at
  // corps à corps does not strike back. It reaches the two combat sites a TriggerAttack can hit (the
  // shooter's d=1 exchange, the end-of-move engage). It is not passed to the en-route melee on purpose
  // (movementLeft is 0 for a triggered attack, so that loop never runs); a normal advance/charge
  // always takes its counter.
  opts?: { noCombat?: boolean; stopAtCol?: number; chargeMelee?: boolean; naturalAdvance?: boolean; noCounter?: boolean },
): void {
  // COUP DE GRÂCE "change de propriétaire" (Truche Foldingue #434), resolved at the moment of the kill,
  // in the middle of the advance. If the draw makes it switch, it goes to the opponent on the spot,
  // keeps its remaining PM and goes off in the other direction: `side` and `dx` are computed again for
  // the rest of this advance, which is why the parameters are reassigned rather than constants.
  // Example: 3 PM, it moves 2 cells, kills, switches; it has 1 PM left, turns around and moves one
  // cell. Roi des Truches #282 cancels the switch for the Truches of its camp.
  // Returns true if the camp changed.
  const maybeDefectOnKill = (): boolean => {
    const d = tr.cdgDefect;
    if (!d) return false;            // seule l'avance de fin de tour s'y branche
    if (me.currentLife <= 0) return false; // killed in the exchange, so no coup de grâce
    if (d.defected.has(me.instanceId)) return false;
    const branches = coupDeGraceDefectBranches(me);
    if (!branches) return false;
    if (familyMovePowersNullified(me, creatures)) return false; // Roi des Truches #282
    const pile = d.rng.int(2) === 0;
    d.rolls[me.owner] += 1; // a real allied roll: its Ecaflip reactions fire at settle time
    d.defected.add(me.instanceId); // resolved here, so fireCoupDeGrace does not replay it
    if (!(pile ? branches.pile : branches.face)) return false; // l'autre branche : elle reste
    me.owner = other(me.owner);
    // Changing camp brings back the printed cost (same rule as handleTakeControl).
    me.playedCostMod = 0;
    me.costOverride = undefined;
    log.push({ type: "SUMMONING_CHANGED_TEAM", instanceId: me.instanceId, newOwner: me.owner });
    side = me.owner;
    dx = forwardDx(side);
    return true;
  };

  // Local helper that records a 1-cell step + handles the "landed on wall →
  // disappear" rule. Returns true if the creature has been removed (so the
  // outer movement loop should break).
  const stepInto = (me: CreatureInstance, nx: number, ny: number): boolean => {
    const from = { ...me.position };
    me.position = { x: nx, y: ny };
    me.movementLeft -= 1;
    log.push({
      type: "FIGHT_OBJECT_MOVED",
      instanceId: me.instanceId,
      from,
      to: { ...me.position },
      movementType: "WALK",
    });
    applyWalkOverPickups(me, nx, ny, creatures, log, tr);
    // Gangraîne #1439: `movementPoison` self-damage for each cell stepped through (the
    // en-route walk, a shooter closing the gap, a Charge, and now forced slides too, via
    // makeSlideStep). Shared helper so every per-cell move site behaves identically. Death
    // is settled like a trap kill, the loop guards on `currentLife > 0` and
    // resolveDeathsAndWin culls / logs the removal after the advance pass.
    applyMovementPoisonStep(me, log);
    if (isWallCol(nx)) {
      me.currentLife = 0;
      tr.brokeThroughIds.add(me.instanceId);
      log.push({ type: "FIGHT_OBJECT_REMOVED", instanceId: me.instanceId, brokeThrough: true });
      return true;
    }
    return false;
  };

  // Assommé (Stunned): "ne peut ni avancer ni attaquer tant qu'elle est assommée." It stays where it
  // is and skips the end-of-move engage entirely this turn (the state is also cleared early if it
  // takes damage, see applyDamageToCreature). The stun lasts exactly one of the creature's own
  // turns: it ends at the moment the creature would have finished advancing/attacking. Only its
  // natural end-of-turn advance uses it up; a forced charge/rally/TriggerAttack (naturalAdvance
  // unset) leaves it stunned and does nothing.
  if (me.properties.has("Stunned")) {
    if (opts?.naturalAdvance) {
      me.properties = new Set(me.properties); // clone before mutating the shared Set (aliasing)
      me.properties.delete("Stunned");
      log.push({ type: "PROPERTY_UNAPPLIED", instanceId: me.instanceId, property: "Stunned" });
    }
    return;
  }

  // MAL D'INVOCATION / already acted this turn: a creature placed this turn has `hasAttacked: true`
  // (and movementLeft 0). `movementLeft:0` did block the walk, but not the standing engage at the end
  // of the move (further down): a creature just placed in front of an enemy still hit it (mutual
  // exchange). So melee is guarded like the shooter (see the Portée branch right after): in normal
  // end-of-turn mode, if it already acted or has summoning sickness, it does nothing. `hasAttacked` is
  // reliable on entry (reset to false at the start of the turn), and a creature that kills on the way
  // sets it to true after this point, so the break-through (kill, then hit the Dofus) still works.
  // Skipped for a CHARGE (chargeMelee) / a RALLIEMENT (noCombat), which already reset hasAttacked to
  // false on their side (the charge/rally makes the creature act despite summoning sickness).
  if (!opts?.noCombat && !opts?.chargeMelee && me.hasAttacked) return;

  // Only a Mur (Statue) / 0-PM unit stays where it is on a natural advance. INAMOVIBLE (Rooted) still
  // takes its own end-of-turn advance: INAMOVIBLE only prevents forced moves (charge, teleport,
  // push/pull, return to hand, position swap), not its own advance. But a CHARGE (chargeMelee, forced
  // by Justice #130 / Jice #283, or its own "APPARITION : Charge") does not move an INAMOVIBLE: "pas
  // de charge" (Arty Romi + Arakne à Crochets #1457). Every charge goes through here, so the block
  // holds everywhere. The 0-PM case (NoMovementPoints) does not depend on PM for a charge (only
  // Statue/Rooted block it).
  const isImmobile = me.properties.has("Statue")
    || (!opts?.chargeMelee && me.properties.has("NoMovementPoints"))
    || (opts?.chargeMelee === true && me.properties.has("Rooted"));

  // ───────── shooter (Portée) ─────────
  // A ranged creature fires at the nearest enemy in its lane within `range` cells (the line of fire is
  // blocked by the first creature, allied or enemy), takes no counter, and stops once it has fired
  // ("empêche ses déplacements après avoir attaqué"). If the nearest enemy is out of range it walks
  // forward to close the gap (if it can move, blocked by the first unit ahead), then fires. A shooter
  // with summoning sickness (hasAttacked already set) does nothing this turn.
  // (A rally advance, opts.noCombat, skips firing and walks like a melee unit. A CHARGE,
  // opts.chargeMelee, also skips the ranged branch: a charging shooter only attacks at corps à corps,
  // so it falls through to the melee walk + engage below.)
  if (me.range > 0 && !opts?.noCombat && !opts?.chargeMelee) {
    if (me.hasAttacked) return;
    const y = me.position.y;
    const firstBlockerDist = (): number | null => {
      for (let d = 1; ; d++) {
        const x = me.position.x + dx * d;
        if (x < 0 || x >= BOARD_COLS) return null;
        const occupied =
          creatures.some((c) => c.instanceId !== me.instanceId && c.currentLife > 0 && c.position.x === x && c.position.y === y) ||
          dofuses.some((dd) => dd.currentLife > 0 && dd.position.x === x && dd.position.y === y);
        if (occupied) return d;
      }
    };
    while (me.currentLife > 0) {
      const shot = fireShooterShot(me, creatures, dofuses, log, side, dx, tr.deferredInitiativeCounters, opts?.noCounter === true, tr);
      if (shot.fired) {
        // Normally a shooter stops after firing ("empêche ses déplacements après avoir attaqué"). Exception:
        // if it just killed an adjacent creature (the one engaging it in melee), the path is free. It may
        // step into the freed cell and keep advancing, firing again at any target that comes into range,
        // exactly like a melee kill and continue.
        // `me.currentLife > 0`: a d=1 corps à corps can kill the shooter through the counter (both die), and
        // a dead shooter must not step forward.
        // `adjacentCleared` extends the exception to a cell freed by a push and not only by a death (Patty
        // Ceriz #31): in both cases the way is open. The death-specific handling below is already guarded by
        // the search for `shotVictim` (a corpse on the cell), so it does not fire on a plain push.
        if ((shot.killedAdjacentCreature || shot.adjacentCleared) && me.currentLife > 0 && !isImmobile && me.movementLeft > 0) {
          if (transformsOnCoupDeGrace(me)) { me.movementLeft = 0; return; } // rule 10: a transforming shooter halts on its kill (stays put)
          const nx = me.position.x + dx;
          if (nx < 0 || nx >= BOARD_COLS) { me.movementLeft = 0; return; }
          // Same rule as melee: if the shot's adjacent victim summons a token onto its death cell, the shooter
          // cannot step through it. It stops (it already fired this turn).
          const shotVictim = creatures.find((c) => c.currentLife <= 0 && c.owner !== side && c.position.x === nx && c.position.y === y);
          // Nenufar #821: the adjacent victim's death cell sprouts a Seed now, so the shooter's step onto it
          // hits it through the normal walk-over rule.
          if (shotVictim) registerDeathSeed(shotVictim, creatures, tr, log);
          if (shotVictim) registerDeathTasDOs(shotVictim, tr, log); // same as the TAS D'OS case
          if (shotVictim && deathSummonFillsCell(shotVictim)) { me.movementLeft = 0; return; }
          // Otomaï #447: a shot that kills it transforms the shooter too, so the shooter stops and the sweep is
          // cancelled for the rest. The transform fires after the sweep.
          if (shotVictim && deathTransformsAllHitsSide(shotVictim, side)) { tr.transformAllCancel = true; me.movementLeft = 0; return; }
          if (stepInto(me, nx, y)) return; // broke through (should not happen vs a creature kill)
          continue; // re-evaluate from the new position
        }
        me.movementLeft = 0; // stops after firing
        return;
      }
      // No enemy in range yet, try to close the distance.
      if (isImmobile || me.movementLeft <= 0) return;
      if (firstBlockerDist() === 1) return; // a friendly directly ahead blocks the walk
      const nx = me.position.x + dx;
      if (nx < 0 || nx >= BOARD_COLS) return;
      if (stepInto(me, nx, y)) return; // walked into the wall (empty lane) → broke through
      // loop: re-check for a shot from the new position
    }
    return;
  }

  // A Mur (Statue) / 0-PM (NoMovementPoints) melee creature does not advance.
  // INAMOVIBLE (Rooted) does advance, it is only immune to forced displacement.
  if (isImmobile) return;

  // Set once the advance STOPS parked on an enemy that survived our hit (we
  // already attacked it, do not double-hit it in the end-engage below). Running
  // out of movement, or killing-and-continuing up to the wall, leaves this
  // false, so the end-engage can still strike the adjacent Dofus / creature.
  let stoppedOnSurvivor = false;
  while (me.movementLeft > 0 && me.currentLife > 0) {
    // RALLIEMENT: halt once level with the rally target's column.
    if (opts?.stopAtCol !== undefined && me.position.x === opts.stopAtCol) break;
    const nx = me.position.x + dx;
    const ny = me.position.y;
    if (nx < 0 || nx >= BOARD_COLS) break;

    const blockingCreature = creatures.find(
      (c) => c.instanceId !== me.instanceId && c.currentLife > 0 && c.position.x === nx && c.position.y === ny,
    );
    const blockingDofus = dofuses.find(
      (d) => d.position.x === nx && d.position.y === ny && d.currentLife > 0,
    );

    if (blockingCreature) {
      // Rally: stop in front of any creature (enemy "s'arrête devant", ally blocks),
      // never fight.
      if (opts?.noCombat || blockingCreature.owner === side) {
        me.movementLeft = 0;
        break;
      }
      const meLife0 = me.currentLife, meArmor0 = me.armor;
      const meX0 = me.position.x;
      const blockPushes = resolveMeleeExchange(me, blockingCreature, log, creatures, tr.deferredInitiativeCounters);
      applyAttackSplash(me, log, creatures, dofuses); // Marteleur #972: also hits the 2 side cells
      // Patty Ceriz #31: the push is applied after the splash, otherwise the Marteleur's splash would start
      // from the cell where the pushed creature landed, not from the cell of the hit.
      for (const p of blockPushes) {
        if (p.target.currentLife > 0) slideCreatureBack(p.target, creatures, dofuses, p.distance, log);
      }
      // If we are the ones who were pushed back (Patty Ceriz #31 pushes us back when it takes our hit), the
      // target cell `nx` computed at the top of the iteration is outdated: using it would teleport us over
      // the cell we moved back from. The iteration starts again from the new position, and the advance
      // goes on normally with the remaining PM.
      const meWasPushed = me.position.x !== meX0;
      if (me.currentLife <= 0) break;
      // CONTRE COUP self-buff (Laon #153 etc.): if the counter hurt us, the +AT/+AR lands now, before we go
      // on with this advance to hit the Dofus / next enemy, not after the whole phase.
      applyInlineContreCoupSelfBuff(me, meLife0, meArmor0, log, tr);
      if (blockingCreature.currentLife > 0) {
        // The blocker survived. We only stop if it is still right in front of us: the engage rule is about
        // being blocked, not about having struck. If a push cleared the way (Patty Ceriz #31: either it pushed
        // us back, or it moved back itself), the advance goes on with the remaining PM and can start another
        // fight one cell further. The test uses our current cell, not `nx`, which is outdated when we were the
        // one who moved back.
        const aheadX = me.position.x + dx;
        if (blockingCreature.position.x === aheadX && blockingCreature.position.y === ny) {
          me.movementLeft = 0;
          stoppedOnSurvivor = true;
          break;
        }
        continue; // the way is clear: compute again from the current position (the step will cost 1 PM)
      }
      // MORT ADVERSE self-buff (Chevalier de Parme #1969): the enemy just died to us, so the +AT lands now
      // and the rest of the advance (next enemy, then the Dofus) uses the raised attack.
      applyInlineMortAdverseSelfBuff(me, log, tr);
      // COUP DE GRÂCE self-buff (Tsar Tsu Tsu #138 "+2 AT/+2 AR quand elle tue", Klaus #716 "+1 AT et se
      // soigne de 2 PV"): same moment, same reason.
      applyInlineCoupDeGraceSelfBuff(me, creatures, dofuses, log, tr);
      // In a rare setup the inline heal can take life away instead of giving it (Sangsuce Tsu Tsu #24 turns
      // every heal around): a dead mover does not go on with its advance.
      if (me.currentLife <= 0) break;
      // Truche Foldingue #434: the camp switch happens here, at the kill. If it changes camp, the rest of the
      // loop goes on with the new `dx`: it spends its remaining PM the other way, and the corpse in front of
      // it is no longer on its path.
      if (maybeDefectOnKill()) continue;
      // Nenufar #821: the freed cell sprouts a Seed the moment the Sadida dies. It is registered now so the
      // killer's step below (and any later walker) hits it through the normal walk-over rule.
      registerDeathSeed(blockingCreature, creatures, tr, log);
      // TAS D'OS (Chafer): the freed cell drops a Tas d'Os the moment the Chafer dies, so the killer's step
      // below (and any later walker) uses it up; a non-Chafer killer like Jahash destroys it.
      registerDeathTasDOs(blockingCreature, tr, log);
      // Rule 10: a creature that transforms on COUP DE GRÂCE (Mulou) halts the instant it kills,
      // it stays put (no percée into the freed cell, no kill-and-continue). The transform fires
      // post-combat (fireCoupDeGrace). #199 (heal, not transform) keeps the normal continue.
      if (transformsOnCoupDeGrace(me)) { me.movementLeft = 0; return; }
      // A victim whose MORT summons a token onto its own death cell (Rat Dominant #557 → Ratou) fills the
      // freed cell the moment it dies, so the killer cannot kill and continue through it. Stop here; the
      // end-of-advance death pass places the token on the (now free) cell.
      if (deathSummonFillsCell(blockingCreature)) { me.movementLeft = 0; stoppedOnSurvivor = true; break; }
      // Otomaï #447: killing it transforms the killer itself, so the killer stops here (no break-through),
      // and the sweep is cancelled for everyone still to play. The transform fires after the sweep.
      if (deathTransformsAllHitsSide(blockingCreature, side)) { tr.transformAllCancel = true; me.movementLeft = 0; return; }
      if (meWasPushed) continue; // pushed back: `nx` is outdated, compute again from the new cell
      if (stepInto(me, nx, ny)) break;
      continue;
    }

    if (blockingDofus) {
      if (opts?.noCombat || blockingDofus.owner === side) {
        me.movementLeft = 0;
        break;
      }
      const dmg = me.currentAttack;
      const toDofus = redirectDofusDamage(blockingDofus, dmg, creatures, log, me.instanceId); // Lien de Sang #1495
      me.hasAttacked = true;
      applyAttackSplash(me, log, creatures, dofuses); // Marteleur #972 : frappe aussi les 2 cases latérales
      if (toDofus > 0) {
        woundDofus(blockingDofus, toDofus, log, creatures, dofuses); // canonical Dofus damage (breaks any Sinistro)
        log.push({ type: "DAMAGE", targetCell: { ...blockingDofus.position }, damage: toDofus, sourceInstanceId: me.instanceId, combat: true });
      }
      if (blockingDofus.currentLife > 0) {
        me.movementLeft = 0;
        stoppedOnSurvivor = true;
        break;
      }
      log.push({ type: "FIGHT_OBJECT_REMOVED", dofusAt: { ...blockingDofus.position } });
      // Héros Félin #1156: destroying the Dofus fires "revient en main" at this moment. It does not step
      // onto the freed cell to break through the wall; it breaks through in place, like the end-of-move
      // engage below. The return to hand reads brokeThroughIds in resolveDeathsAndWin, so the outcome
      // (back to hand) is the same.
      if (recoversToHandOnDofusKill(me.cardId)) {
        me.currentLife = 0;
        tr.brokeThroughIds.add(me.instanceId);
        log.push({ type: "FIGHT_OBJECT_REMOVED", instanceId: me.instanceId, brokeThrough: true });
        break;
      }
      if (stepInto(me, nx, ny)) break;
      continue;
    }

    if (stepInto(me, nx, ny)) break;
  }

  // Rally advances never strike at the end of the move.
  if (opts?.noCombat) return;

  // ENGAGE AT end, having stopped adjacent to an enemy, strike it. Gated on
  // `stoppedOnSurvivor` (not hasAttacked): a creature that killed someone en
  // route and ran out of movement next to the Dofus must still hit it (percée).
  // We only skip when parked on an enemy that survived our hit (already struck).
  if (me.currentLife > 0 && !stoppedOnSurvivor) {
    const fx = me.position.x + dx;
    const fy = me.position.y;
    if (fx >= 0 && fx < BOARD_COLS) {
      const enemyInFront = creatures.find(
        (c) => c.instanceId !== me.instanceId && c.currentLife > 0 && c.owner !== side && c.position.x === fx && c.position.y === fy,
      );
      const enemyDofusInFront = dofuses.find(
        (d) => d.owner !== side && d.currentLife > 0 && d.position.x === fx && d.position.y === fy,
      );
      if (enemyInFront) {
        const engagePushes = resolveMeleeExchange(me, enemyInFront, log, creatures, tr.deferredInitiativeCounters, opts?.noCounter === true);
        applyAttackSplash(me, log, creatures, dofuses); // Marteleur #972: also hits the 2 side cells
        // Patty Ceriz #31: push after the splash (same reason as the blocking engage above).
        for (const p of engagePushes) {
          if (p.target.currentLife > 0) slideCreatureBack(p.target, creatures, dofuses, p.distance, log);
        }
      } else if (enemyDofusInFront) {
        const dmg = me.currentAttack;
        const toDofus = redirectDofusDamage(enemyDofusInFront, dmg, creatures, log, me.instanceId); // Lien de Sang #1495
        me.hasAttacked = true;
        applyAttackSplash(me, log, creatures, dofuses); // Marteleur #972 : frappe aussi les 2 cases latérales
        if (toDofus > 0) {
          woundDofus(enemyDofusInFront, toDofus, log, creatures, dofuses); // canonical Dofus damage (breaks any Sinistro)
          log.push({ type: "DAMAGE", targetCell: { ...enemyDofusInFront.position }, damage: toDofus, sourceInstanceId: me.instanceId, combat: true });
          if (enemyDofusInFront.currentLife <= 0) {
            log.push({ type: "FIGHT_OBJECT_REMOVED", dofusAt: { ...enemyDofusInFront.position } });
            me.currentLife = 0;
            tr.brokeThroughIds.add(me.instanceId);
            log.push({ type: "FIGHT_OBJECT_REMOVED", instanceId: me.instanceId, brokeThrough: true });
          }
        }
      } else if (isWallCol(fx) && (opts?.naturalAdvance || opts?.chargeMelee)) {
        // The Dofus of this row is already destroyed, so the wall column in front is open. A creature that
        // reaches the last cell by advancing (with its PM or a charge, including when it spends its last PM
        // on that cell) breaks through and goes back into the deck, even with 0 PM left (Tristepin used to
        // stay stuck on the last cell). A creature that was only teleported here never goes through this
        // path (a teleport does not call advanceCreature): it waits for its next advance/charge. The rally
        // (noCombat) already returned earlier. If it had movement left, the loop would already have walked
        // onto the wall cell (stepInto → break-through), so this case only fires when the advance ends on
        // the cell.
        me.currentLife = 0;
        tr.brokeThroughIds.add(me.instanceId);
        log.push({ type: "FIGHT_OBJECT_REMOVED", instanceId: me.instanceId, brokeThrough: true });
      }
    }
  }
}

// CONTRE COUP cards whose only effect is a self stat buff (Laon #153 +AT/+AR, Mandhal #393 +AT,
// Tristecoeur #366 +AT/+PM). For these, the buff must land the moment the creature takes combat
// damage during its own advance, so the rest of its advance (kill and continue / Dofus hit) uses the
// buffed stats, not after the whole phase. Returns the buff effects, or null if the creature has no
// CONTRE COUP or mixes in other effects (those stay with fireContreCoup).
function contreCoupSelfStatBuffs(c: CreatureInstance): { type: string; amount: number }[] | null {
  const effs = c.triggers.filter((t) => t.trigger === "CONTRE_COUP").flatMap((t) => t.effects);
  if (effs.length === 0) return null;
  const isSelfBuff = (e: Effect) =>
    (e.type === "BoostAttack" || e.type === "BoostArmor" || e.type === "BoostMovement") &&
    (e as { self?: boolean }).self === true;
  if (!effs.every(isSelfBuff)) return null;
  return effs.map((e) => ({ type: e.type, amount: (e as { amount?: number }).amount ?? 0 }));
}

// Apply a surviving creature's CONTRE COUP self stat-buff the instant it takes combat damage mid-advance.
// ATK/AR hit the live stats immediately (so the rest of the advance is buffed); PM goes to baseMovement
// only, never movementLeft, so a mid-advance PM gain still waits for next turn (the Tristepin rule /
// "Cas 1"). Records the instanceId in tr.contreCoupInlineBuffed so the post-phase fireContreCoup skips it.
function applyInlineContreCoupSelfBuff(
  me: CreatureInstance, life0: number, armor0: number, log: GameEvent[], tr: AdvanceTracking,
): void {
  if (!tr.contreCoupInlineBuffed) return;                     // only the end-of-turn combat phase opts in
  if (me.currentLife <= 0) return;                            // died → its self-buff is moot (culled)
  if (me.currentLife >= life0 && me.armor >= armor0) return; // took no damage → CONTRE COUP did not fire
  const buffs = contreCoupSelfStatBuffs(me);
  if (!buffs) return;
  for (const b of buffs) {
    if (!b.amount) continue;
    if (b.type === "BoostAttack") {
      const before = me.currentAttack;
      bumpStat(me, "attack", b.amount);
      log.push({ type: "ATTACK_GAINED", instanceId: me.instanceId, attackMod: { valueBefore: before, modification: b.amount, valueAfter: me.currentAttack } });
    } else if (b.type === "BoostArmor") {
      const before = me.armor;
      bumpStat(me, "armor", b.amount);
      log.push({ type: "ARMOR_GAINED", instanceId: me.instanceId, armorMod: { valueBefore: before, modification: b.amount, valueAfter: me.armor } });
    } else if (b.type === "BoostMovement") {
      // PM to baseMovement only (not movementLeft) → effective next turn, never the current advance.
      const before = me.baseMovement;
      me.baseMovement += b.amount;
      log.push({ type: "MOVEMENT_POINT_BOOST", instanceId: me.instanceId, movementMod: { valueBefore: before, modification: b.amount, valueAfter: me.baseMovement } });
    }
  }
  tr.contreCoupInlineBuffed.set(me.instanceId, (tr.contreCoupInlineBuffed.get(me.instanceId) ?? 0) + 1);
}

// MORT ADVERSE self stat-buffs (Chevalier de Parme #1969 "+1 AT quand une invocation adverse
// meurt"). Same shape as contreCoupSelfStatBuffs: only FIXED-amount self BoostAttack/Armor/Movement
// count, a count-based amount ("+1 par cochon", Disciple Cochonnet) is left to the post-advance
// pass (it does not ramp mid-advance). Returns the buffs, or null if the creature has none / mixes in
// non-self-stat effects (those keep the deferred resolution).
function mortAdverseSelfStatBuffs(c: CreatureInstance): { type: string; amount: number }[] | null {
  const effs = c.triggers.filter((t) => t.trigger === "MORT_ADVERSE").flatMap((t) => t.effects);
  if (effs.length === 0) return null;
  const isSelfBuff = (e: Effect) =>
    (e.type === "BoostAttack" || e.type === "BoostArmor" || e.type === "BoostMovement") &&
    (e as { self?: boolean }).self === true &&
    typeof (e as { amount?: unknown }).amount === "number";
  if (!effs.every(isSelfBuff)) return null;
  return effs.map((e) => ({ type: e.type, amount: (e as { amount?: number }).amount ?? 0 }));
}

// Apply a killer's MORT ADVERSE self stat buff the moment it kills an enemy mid-advance, so the rest
// of its advance (kill and continue, then the Dofus hit) uses the raised stats. Without this the +AT
// only landed in the post-advance death pass, so a Chevalier de Parme #1969 that cleared a whole row
// hit the Dofus with its base attack and failed to kill it in one hit. Works like
// applyInlineContreCoupSelfBuff: AT/AR go to the live stats now; PM goes to baseMovement only (next
// turn). Records the count in tr.mortAdverseInlineBuffed so resolveDeathsAndWin skips exactly that
// many of this creature's MORT ADVERSE firings (no double count). Call once per enemy the creature
// kills.
function applyInlineMortAdverseSelfBuff(me: CreatureInstance, log: GameEvent[], tr: AdvanceTracking): void {
  if (!tr.mortAdverseInlineBuffed) return; // only the end-of-turn combat phase opts in
  if (me.currentLife <= 0) return;         // the killer itself died (mutual kill) → its buff is moot
  const buffs = mortAdverseSelfStatBuffs(me);
  if (!buffs) return;
  for (const b of buffs) {
    if (!b.amount) continue;
    if (b.type === "BoostAttack") {
      const before = me.currentAttack;
      bumpStat(me, "attack", b.amount);
      log.push({ type: "ATTACK_GAINED", instanceId: me.instanceId, attackMod: { valueBefore: before, modification: b.amount, valueAfter: me.currentAttack } });
    } else if (b.type === "BoostArmor") {
      const before = me.armor;
      bumpStat(me, "armor", b.amount);
      log.push({ type: "ARMOR_GAINED", instanceId: me.instanceId, armorMod: { valueBefore: before, modification: b.amount, valueAfter: me.armor } });
    } else if (b.type === "BoostMovement") {
      const before = me.baseMovement;
      me.baseMovement += b.amount; // baseMovement only → next turn, never extends the current advance
      log.push({ type: "MOVEMENT_POINT_BOOST", instanceId: me.instanceId, movementMod: { valueBefore: before, modification: b.amount, valueAfter: me.baseMovement } });
    }
  }
  tr.mortAdverseInlineBuffed.set(me.instanceId, (tr.mortAdverseInlineBuffed.get(me.instanceId) ?? 0) + 1);
}

// COUP DE GRÂCE self stat buffs (Tsar Tsu Tsu #138 "+2 AT/+2 AR quand elle tue"). Only pure fixed
// self mods: a trigger that touches anything other than its carrier (player effect, enemy target)
// stays with fireCoupDeGrace. Like MORT ADVERSE, this is a trigger "at the moment of the kill": the
// gain has to come before the next hit (kill and continue, then the Dofus), otherwise the creature
// clears a row but hits the Dofus with its base attack.
// A heal on itself counts as a self mod (Klaus #716 "+1 AT et se soigne de 2 PV", Mulou Garou #199
// "se soigne de 2 PV"): it changes a stat, so it is immediate. Without it Klaus ended its move with
// the attack and HP it had before the coup de grâce.
function coupDeGraceSelfStatBuffs(c: CreatureInstance): { type: string; amount: number }[] | null {
  const effs = c.triggers.filter((t) => t.trigger === "COUP_DE_GRACE").flatMap((t) => t.effects);
  if (effs.length === 0) return null;
  const isSelfBuff = (e: Effect) =>
    (e.type === "BoostAttack" || e.type === "BoostArmor" || e.type === "BoostMovement" ||
      // A scoped Heal ("soigne vos invocations") or one marked `dofus` is not a self mod.
      (e.type === "Heal" && !(e as { dofus?: boolean }).dofus && !(e as { scope?: string }).scope)) &&
    (e as { self?: boolean }).self === true &&
    typeof (e as { amount?: unknown }).amount === "number";
  if (!effs.every(isSelfBuff)) return null;
  return effs.map((e) => ({ type: e.type, amount: (e as { amount?: number }).amount ?? 0 }));
}

// Does this creature's COUP DE GRÂCE give it to the opponent (Truche Foldingue #434: "50% de chances
// de changer de propriétaire")? Returns the coin flip to play, or null. The effect sits inside a
// CoinFlip; an empty `face` branch means "nothing happens".
function coupDeGraceDefectBranches(c: CreatureInstance): { pile: boolean; face: boolean } | null {
  const effs = c.triggers.filter((t) => t.trigger === "COUP_DE_GRACE").flatMap((t) => t.effects);
  const gives = (list: readonly Effect[] | undefined) => (list ?? []).some((e) => e.type === "GiveSelfToOpponent");
  if (gives(effs)) return { pile: true, face: true }; // inconditionnel (aucune carte aujourd'hui)
  for (const e of effs) {
    if (e.type !== "CoinFlip") continue;
    const cf = e as { pile?: Effect[]; face?: Effect[] };
    if (gives(cf.pile) || gives(cf.face)) return { pile: gives(cf.pile), face: gives(cf.face) };
  }
  return null;
}

// Apply a killer's COUP DE GRÂCE self stat-buff the instant it kills mid-advance (Tsar Tsu Tsu #138).
// Mirror of applyInlineMortAdverseSelfBuff : AT/AR live now, PM to baseMovement only ; records the count in
// tr.coupDeGraceInlineBuffed so fireCoupDeGrace skips exactly that many pure-self-buff firings (no double).
function applyInlineCoupDeGraceSelfBuff(me: CreatureInstance, creatures: CreatureInstance[], dofuses: DofusInstance[], log: GameEvent[], tr: AdvanceTracking): void {
  if (!tr.coupDeGraceInlineBuffed) return; // only the end-of-turn combat phase opts in
  if (me.currentLife <= 0) return;         // killed in the exchange → no coup de grâce (fireCoupDeGrace agrees)
  const buffs = coupDeGraceSelfStatBuffs(me);
  if (!buffs) return;
  for (const b of buffs) {
    if (!b.amount) continue;
    if (b.type === "Heal") {
      // The heal goes through the real effect pipeline, not a hand-written addition: it is the only way to
      // keep the cap at base HP, the heal inversion (Sangsuce Tsu Tsu #24 "tous les soins deviennent des
      // dégâts") and the heal reactions (Dargone #1291, Malox Makugen #76, Pacificatrice Enjouée #1519).
      // applyEffects emits LIFE_HEALED, then runs its own reactions. targetCell = its cell, so the `self`
      // Heal lands on it.
      applyEffects(creatures, dofuses, log, [{ type: "Heal", amount: b.amount, self: true } as Effect], {
        casterSide: me.owner,
        selfInstanceId: me.instanceId,
        targetCell: { ...me.position },
      });
      continue;
    }
    if (b.type === "BoostAttack") {
      const before = me.currentAttack;
      bumpStat(me, "attack", b.amount);
      log.push({ type: "ATTACK_GAINED", instanceId: me.instanceId, attackMod: { valueBefore: before, modification: b.amount, valueAfter: me.currentAttack } });
    } else if (b.type === "BoostArmor") {
      const before = me.armor;
      bumpStat(me, "armor", b.amount);
      log.push({ type: "ARMOR_GAINED", instanceId: me.instanceId, armorMod: { valueBefore: before, modification: b.amount, valueAfter: me.armor } });
    } else if (b.type === "BoostMovement") {
      const before = me.baseMovement;
      me.baseMovement += b.amount;
      log.push({ type: "MOVEMENT_POINT_BOOST", instanceId: me.instanceId, movementMod: { valueBefore: before, modification: b.amount, valueAfter: me.baseMovement } });
    }
  }
  tr.coupDeGraceInlineBuffed.set(me.instanceId, (tr.coupDeGraceInlineBuffed.get(me.instanceId) ?? 0) + 1);
}

// (resolveInlineContreCoup was removed: CONTRE COUP is no longer a separate pass "after the advance";
// it is a step of the resolution sweep, see resolveDeathsAndWin, parameter `ccFrom`.)

function processCombatPhase(state: GameState, side: Side, deferredCounters: { attackerId: number; targetId: number }[] = [], contreCoupInlineBuffed?: Map<number, number>, mortAdverseInlineBuffed?: Map<number, number>, coupDeGraceInlineBuffed?: Map<number, number>): GameState {
  // Work on shallow copies so we can mutate, then pack at the end. `let` (not const): the inline
  // CONTRE COUP resolution (below) packs these again between movers, so they may be replaced by new
  // arrays.
  let creatures = state.creatures.map((c) => ({ ...c, position: { ...c.position } }));
  let dofuses = state.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
  let log = [...state.log];
  // Base state carried forward across inline CONTRE COUP firings (player-state / prisms / seeds / rng
  // deltas from a mid-sweep summon or reserve gain). The final resolveDeathsAndWin packs against it.
  let baseState = state;
  const dx = forwardDx(side);

  // Move order follows the rule 2 sweep. First: front line first (closest to the opposing wall), so a
  // creature that is already engaging clears the path for the back line, and a back creature never
  // runs into an ally that has not moved yet. Second (same column): L1→L5 by row, so effects triggered
  // during the advance resolve in sweep order. This matters for the rare cross-lane case (Marteleur
  // #972 side splash, an area effect landing mid-advance). With no effect the advance is logically
  // simultaneous (same final board whatever the order), so this tie-break changes nothing there.
  // L1→L5 = y going up for the ally, mirrored (y going down) for the enemy, same as the fatigue
  // reveal order (rule 11). L1 is y=0.
  const moveOrderIds = creatures
    .filter((c) => c.owner === side)
    .sort((a, b) =>
      side === "ally"
        ? (a.position.x - b.position.x) || (a.position.y - b.position.y)
        : (b.position.x - a.position.x) || (b.position.y - a.position.y),
    )
    .map((c) => c.instanceId);

  // Track which creatures left the board through a wall break-through (destroyed a Dofus and stepped
  // onto the empty wall cell). These are handled differently: the card goes back to the bottom of the
  // deck, not to the discard ("quand une créature détruit un dofus et disparaît au mur, la carte
  // originale doit être placée sous la pioche").
  const brokeThroughIds = new Set<number>();

  // Prism pickup during the advance phase, any creature that walks onto a
  // prism cell (its own or the opponent's) collects it, and the bonus goes to
  // the WALKER's owner. We only RECORD pickups here; the bonuses (AP reserve /
  // draw / Fléau-to-hand) mutate player state, which we pack at the very end,
  // so they are applied after the movement loop via activatePrism. A cell is
  // collected once per phase, first creature to cross it wins.
  const prismCellKeys = new Set(
    state.prisms.map((p) => `${p.position.x},${p.position.y}`),
  );
  const collectedPrismKeys = new Set<string>();
  const prismPickups: { at: Coords; side: Side; props: Set<string>; byInstanceId?: number }[] = [];

  const tracking: AdvanceTracking = {
    brokeThroughIds, prismCellKeys, collectedPrismKeys, prismPickups,
    seedCells: buildSeedCells(state), consumedSeedKeys: new Set<string>(),
    glyphCells: buildGlyphCells(state), consumedGlyphKeys: new Set<string>(),
    tasDOsCells: buildTasDOsCells(state), consumedTasDOsKeys: new Set<string>(),
    bushCells: buildBushCells(state), consumedBushKeys: new Set<string>(),
    butinCells: buildButinCells(state), consumedButinKeys: new Set<string>(), butinPickups: [],
    giftCells: buildGiftCells(state), consumedGiftKeys: new Set<string>(), giftRng: new Rng((state.rng ^ GIFT_ROLL_SALT) | 0), giftRolls: { ally: 0, enemy: 0 },
    trapCells: buildTrapCells(state), consumedTrapKeys: new Set<string>(), trapPickups: [],
    deferredInitiativeCounters: deferredCounters,
    deathSeeds: [], // opt in to inline Nenufar seed placement for the end-of-turn sweep
    deathTasDOs: [], // opt in to inline Tas d'Os placement for the end-of-turn sweep
    contreCoupInlineBuffed, // opt in to inline CONTRE COUP self-buffs (undefined outside end-of-turn)
    mortAdverseInlineBuffed, // opt in to inline MORT ADVERSE self-buffs (Chevalier de Parme #1969)
    coupDeGraceInlineBuffed, // opt in to inline COUP DE GRÂCE self-buffs (Tsar Tsu Tsu #138)
    // opt in to the inline owner-change coup de grâce (Truche Foldingue #434), flux RNG dédié.
    cdgDefect: {
      rng: new Rng((state.rng ^ CDG_DEFECT_SALT) | 0),
      defected: new Set<number>(),
      rolls: { ally: 0, enemy: 0 },
    },
  };

  // CHEF aura providers may leave the board mid-sweep: a chief that captures a Dofus at the wall
  // (brokeThroughIds → currentLife 0) or dies in melee stops giving its aura. Since the sweep moves
  // creatures one at a time and the front-line (most advanced) movers go first, a chief deep in enemy
  // territory can disappear before a back-line ally of its family fights. That ally must then hit with
  // its base stats, not the gone chief's buff (a Scaraboss #607 captured a Dofus, but a back-line
  // Scarafon #533 still hit with the old +1 AT and won a free trade). Auras are computed again only
  // when a ChiefAura provider really leaves, so BLESSÉ and other conditional self boosts stay frozen
  // for the rest of the sweep as before.
  const chiefProviderIds = new Set(
    creatures
      .filter((c) => c.currentLife > 0 && (getCard(c.cardId)?.effects ?? []).some((e) => e.type === "ChiefAura"))
      .map((c) => c.instanceId),
  );

  // Phase accumulators: deaths are now removed mover by mover, so everything that has to be read on a
  // corpse (the killer of a COUP DE GRÂCE, the attacker of a Rose Maudite) is captured in the loop,
  // before the removal, and replayed at the end on the settled board.
  const cdgKills: { killerId: number; victimCardId: number; victimOwner: Side; victimPosition: Coords }[] = [];
  const roseRetaliate: { sourceId: number; amount: number }[] = [];
  const roseSeen = new Set<string>();

  for (const id of moveOrderIds) {
    const me = creatures.find((c) => c.instanceId === id);
    if (!me || me.currentLife <= 0) continue; // already died this phase
    const moverLogStart = log.length; // damage this creature's whole advance deals belongs to it
    advanceCreature(me, creatures, dofuses, log, side, dx, tracking, { naturalAdvance: true });
    // Cléophée #28/#755/#845 (ShooterSecondAttack): "attaque une deuxième fois APRÈS un combat si un
    // autre membre allié de la Confrérie du Tofu est en jeu". Only if the shooter really fired
    // (me.hasAttacked: a shooter that found no target never "fought", so no second shot) and survived
    // its advance. The second shot is a normal shooter fire: it finds the nearest enemy in range again
    // (which may be a different target if the first one died), from the creature's current position,
    // with no extra move.
    if (
      me.currentLife > 0 &&
      me.range > 0 &&
      me.hasAttacked &&
      shooterFiresSecondAttack(me, creatures)
    ) {
      fireShooterShot(me, creatures, dofuses, log, side, dx, tracking.deferredInitiativeCounters, false, tracking);
    }
    // Nenufar #821: seed every Sadida that died during this creature's advance (range/splash/counter
    // kills that the kill and continue sites did not already seed), so the next movers of this sweep
    // walk over it. Before the removal: the corpse must still be on its cell.
    registerPendingDeathSeeds(creatures, tracking, log);
    registerPendingDeathTasDOs(creatures, tracking, log); // same as the TAS D'OS case
    // Otomaï #447: once a creature whose MORT transforms the whole sweeping side has died in this sweep
    // (the inline kill-site hooks set the flag and stopped the killer; this also catches splash/counter
    // kills), stop moving the rest. Every remaining mover is about to be transformed and must not play
    // its turn. Checked before the removal (after it, there is no corpse left to see).
    if (!tracking.transformAllCancel && creatures.some((c) => c.currentLife <= 0 && !brokeThroughIds.has(c.instanceId) && deathTransformsAllHitsSide(c, side))) {
      tracking.transformAllCancel = true;
    }
    // COUP DE GRÂCE attribution: for each creature that died to this mover, the killer is the source of
    // the last damage it took. Captured before the removal (we keep the victim's card/camp for the Qilby
    // bounce) and gathered over the whole phase; "did the killer survive?" is decided at the end, on the
    // settled board.
    // brokeThroughIds: a creature that broke through is not a victim. moverLogStart: limits the backward
    // scan to this creature's advance (the log covers the whole game).
    cdgKills.push(...collectCdgKills(creatures, log, brokeThroughIds, moverLogStart));
    // Rose Maudite #1353 ("inflige 1 aux invocations qui blessent vos invocations LORS D'UN COMBAT"): each
    // enemy invocation that wounded an invocation of the carrier's camp during this combat takes
    // `amount`. The text limits it to COMBAT: `ev.combat` excludes spells and effect damage (a MORT
    // explosion does not trigger it). Scanned before the removal (the wounded target may be dead), 1 hit
    // back per source and per wounded camp, applied after the removal.
    {
      const roseAmount: Partial<Record<Side, number>> = {};
      for (const c of creatures) {
        if (c.currentLife <= 0) continue;
        const m = (getCard(c.cardId)?.effects ?? []).find((e) => e.type === "RetaliateAlliesWoundedInCombat") as { amount?: number } | undefined;
        if (m) roseAmount[c.owner] = Math.max(roseAmount[c.owner] ?? 0, m.amount ?? 1);
      }
      if (roseAmount.ally != null || roseAmount.enemy != null) {
        const cById = new Map(creatures.map((c) => [c.instanceId, c]));
        for (let i = moverLogStart; i < log.length; i++) {
          const ev = log[i] as { type: string; targetInstanceId?: number; sourceInstanceId?: number; damage?: number; armorHit?: boolean; combat?: boolean };
          if (ev.type !== "DAMAGE" || ev.targetInstanceId == null || ev.sourceInstanceId == null) continue;
          if (!ev.combat) continue; // « lors d'un combat » : ni sort, ni effet, ni explosion de MORT
          if (!((ev.damage ?? 0) > 0 || ev.armorHit)) continue; // an actual wound (life or armour)
          const tgt = cById.get(ev.targetInstanceId), src = cById.get(ev.sourceInstanceId);
          if (!tgt || !src || src.owner === tgt.owner) continue; // wounded by an enemy creature
          const amt = roseAmount[tgt.owner]; // the wounded side has Rose Maudite
          if (amt == null) continue;
          const key = `${ev.sourceInstanceId}:${tgt.owner}`;
          if (roseSeen.has(key)) continue; // one retaliate per wounding source per wounded side
          roseSeen.add(key);
          roseRetaliate.push({ sourceId: ev.sourceInstanceId, amount: amt });
        }
      }
    }

    // ---- Consequences resolved at the moment of the fatal hit -------------------------------------
    // Deaths used to be set aside until the end of the sweep: a MORT ADVERSE that should have killed a
    // target before its carrier advanced came too late (Guerrier Boudeur #1108). Now each advance
    // resolves what it caused right away, before the next creature moves, and deaths and CONTRE COUPS
    // go through one single cell-by-cell sweep (`moverLogStart` = the start of this advance's volley).
    {
      const inlineSeeded = new Set((tracking.deathSeeds ?? []).map((s) => s.instanceId));
      const inlineTasDOs = new Set((tracking.deathTasDOs ?? []).map((t) => t.instanceId));
      const after = resolveDeathsAndWin(
        baseState, creatures, dofuses, log, brokeThroughIds, inlineSeeded, inlineTasDOs,
        moverLogStart, contreCoupInlineBuffed, mortAdverseInlineBuffed,
      );
      baseState = after;
      creatures = after.creatures.map((c) => ({ ...c, position: { ...c.position } }));
      dofuses = after.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
      log = [...after.log];
      if (baseState.winner) return baseState;
    }
    // A CHEF that left the board with this mover (died or broke through, currentLife 0) no longer gives
    // its aura: compute again so the remaining allies of its family that have not moved yet lose the
    // buff before they fight. Redundant with the withAuras of resolveDeathsAndWin when the chief dies,
    // but not when it captures (the body is removed without going through a wave).
    if (chiefProviderIds.size > 0) {
      let chiefLeft = false;
      for (const cid of chiefProviderIds) {
        const chief = creatures.find((c) => c.instanceId === cid);
        if (!chief || chief.currentLife <= 0) { chiefProviderIds.delete(cid); chiefLeft = true; }
      }
      if (chiefLeft) creatures = withAuras(creatures, seedSidesOf(baseState));
    }
    if (tracking.transformAllCancel) break;
  }

  // CONTRE COUP "qu'elle survive ou NON": the posthumous contre-coup of a creature killed by damage
  // (hit back on the killer, area burst, resource gain) is captured and applied by resolveDeathsAndWin
  // itself. It holds for every lethal source (combat, spell, glyph, effect), not only the sweep's
  // melee. The surviving case is still handled by fireContreCoup.

  const inlineSeededIds = new Set((tracking.deathSeeds ?? []).map((s) => s.instanceId));
  const inlineTasDOsIds = new Set((tracking.deathTasDOs ?? []).map((t) => t.instanceId));
  let result = resolveDeathsAndWin(baseState, creatures, dofuses, log, brokeThroughIds, inlineSeededIds, inlineTasDOsIds);
  // Rose Maudite hits back (post-cull, on the settled board; the attacker's own death settles
  // normally).
  if (roseRetaliate.length > 0 && !result.winner) {
    const cs = result.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
    const ds = result.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
    const lg = [...result.log];
    let any = false;
    for (const r of roseRetaliate) {
      const src = cs.find((c) => c.instanceId === r.sourceId && c.currentLife > 0);
      if (!src) continue;
      const armorBefore = src.armor;
      const dealt = applyDamageToCreature(src, r.amount, lg, false);
      if (dealt > 0 || armorBefore > src.armor) { lg.push({ type: "DAMAGE", targetInstanceId: src.instanceId, damage: dealt, armorHit: armorBefore > src.armor }); any = true; }
    }
    if (any) result = resolveDeathsAndWin({ ...result, creatures: cs, dofuses: ds, log: lg }, cs, ds, lg, new Set());
    if (result.winner) return result;
  }
  result = removeConsumedSeeds(result, tracking.consumedSeedKeys);
  // Nenufar #821 inline death-seeds: add to the board the ones no walker consumed this sweep (the consumed
  // ones already dealt their damage / +AR via applyWalkOverPickups and must not reappear). resolveDeathsAndWin
  // skipped all of them (inlineSeededIds), so this is the sole place they land.
  {
    const survived = (tracking.deathSeeds ?? []).filter(
      (s) => !tracking.consumedSeedKeys.has(`${s.position.x},${s.position.y}`),
    );
    if (survived.length > 0) {
      const rem: GameEvent[] = [];
      for (const s of survived) result = replaceGroundObjectsAt(result, s.position, rem);
      result = { ...result, seeds: [...(result.seeds ?? []), ...survived.map((s) => ({ position: { ...s.position }, owner: s.owner }))], log: [...result.log, ...rem] };
    }
  }
  result = removeConsumedGlyphs(result, tracking.consumedGlyphKeys);
  result = removeConsumedTasDOs(result, tracking.consumedTasDOsKeys);
  result = removeConsumedBushes(result, tracking.consumedBushKeys);
  // TAS D'OS inline (Chafer): add the ones no walker used in this sweep (the used ones were destroyed /
  // gave +AT+AR through applyWalkOverPickups). resolveDeathsAndWin skipped all inline ones
  // (inlineTasDOsIds), so this is the only place the survivors land.
  {
    const survivedTasDOs = (tracking.deathTasDOs ?? []).filter(
      (t) => !tracking.consumedTasDOsKeys.has(`${t.position.x},${t.position.y}`),
    );
    if (survivedTasDOs.length > 0) {
      const rem: GameEvent[] = [];
      for (const t of survivedTasDOs) result = replaceGroundObjectsAt(result, t.position, rem);
      result = { ...result, tasDOs: [...(result.tasDOs ?? []), ...survivedTasDOs.map((t) => ({ position: { ...t.position }, owner: t.owner }))], log: [...result.log, ...rem] };
    }
  }
  result = removeConsumedButins(result, tracking.consumedButinKeys);
  result = removeConsumedGifts(result, tracking.consumedGiftKeys);
  result = removeConsumedTraps(result, tracking.consumedTrapKeys);
  result = applyTrapPickups(result, tracking.trapPickups);
  // Apply prism pickups collected during movement: consume the prism and grant
  // its bonus to the WALKER's owner. activatePrism matches by cell (ignoring
  // the prism's owner), so a second creature crossing an already-taken cell is
  // a harmless no-op (the prism is gone). Bonuses touch player state, hence
  // applied here on the packed result rather than mid-loop.
  for (const pk of prismPickups) {
    result = activatePrism(result, pk.at, pk.side, pk.props, undefined, pk.byInstanceId);
  }
  // Butin pickups: each walker that crossed a butin draws a random reward into its
  // hand. The combat phase has no RNG of its own, so we roll from state.rng and
  // persist the advanced state (reproducible in sims/replays).
  if (tracking.butinPickups.length > 0) {
    const rng = new Rng(result.rng);
    result = { ...applyButinPickups(result, tracking.butinPickups, rng), rng: rng.state };
  }
  // Cadeau de Nowel pickups: each walker that crossed a gift rolls its outcome (+1 AT/AR/PM or 1
  // damage) on itself and fires the picker side's roll reactions (Sentinelle/Atout). Same situation as
  // butins with no own RNG, so roll from state.rng and store it. A lethal roll settles its own death +
  // contre-coup inside applyGiftPickups.
  // Roll reactions of the gifts picked up during the sweep (the outcomes themselves were resolved
  // inline at the step, see applyGiftOutcomeInline).
  result = applyGiftRollReactions(result, tracking);
  // COUP DE GRÂCE fires last, on the settled board (killers that survived). The auto-buffs already
  // applied inline during the advance (Tsar Tsu Tsu #138) are skipped through coupDeGraceInlineBuffed.
  result = fireCoupDeGrace(result, cdgKills, coupDeGraceInlineBuffed, tracking.cdgDefect?.defected);
  // Roll reactions of the switch coin flips played inline during the sweep (Truche Foldingue #434).
  // The switch itself is already applied; only the Ecaflip reactions (Sentinelle Affûtée / Atout Caché)
  // work at the state level and wait for the settle. The camp credited is the one that rolled at the
  // time of the draw (before the switch), recorded in `rolls`.
  for (const s of ["ally", "enemy"] as Side[]) {
    const n = tracking.cdgDefect?.rolls[s] ?? 0;
    if (n > 0) result = applyAllyRollReactions(result, s, n);
  }
  // Toutancoffron #633: a surviving carrier drops an allied Butin on each cell it freed by a kill.
  result = applyKillToButin(result, cdgKills);
  return result;
}

// Pack the post-mutation arrays into a new immutable GameState, applying all the side effects that
// follow from any creature / Dofus reaching 0 life this turn:
//   1. Dead creatures → cardId moved to the owner's discard (or bottom of the deck if they "broke
//      through" a wall, see brokeThroughIds).
//   2. Dead fake Dofuses → +1 spawn-range column for the destroyer.
//   3. Real Dofus captures checked against REAL_DOFUS_TO_WIN to set the winner.
//
// Nécro Phorreur #1221 ("Tant qu'il est en jeu, les cartes défaussées sont bannies à la place") is a
// passive marker while in play: true whenever any living creature, on either side, has
// BanishAllDiscards. While it holds, no card may stay in either player's discard; resolveDeathsAndWin
// moves both piles into `banished`.
function discardsAreBanished(creatures: CreatureInstance[]): boolean {
  return creatures.some(
    (c) => c.currentLife > 0 && (getCard(c.cardId)?.effects ?? []).some((e) => e.type === "BanishAllDiscards"),
  );
}

// Extracted from `processCombatPhase` so the spell pipeline can call it after damage handlers run
// (DamageData on a creature or Dofus produces the same kind of deaths as combat does, and must
// trigger the same cleanup / win logic).
//
// Rule 8: a few Cochon/Salamurai cards fire their MORT_ADVERSE effect even if the reactor itself died
// in the same death wave (posthumous, like a CONTRE_COUP: e.g. both die in melee, or an area effect
// kills both). Identified by card id (the descriptions have no keyword for it). Every other
// MORT_ADVERSE reactor still has to survive. Chuck Lapalette #1541 (tutor a Cochon) + Empereur Gemene
// #1271 (+1 AP reserve) change player state (work post-cull); Guerrier Boudeur #1108 (2 damage to the
// first enemy ahead) fires from its last cell; Perigourdin #884 (Shield self) does nothing once dead.
const MA_FIRES_ON_OWN_DEATH: ReadonlySet<number> = new Set([1541, 1108, 884, 1271]);
// The same on the MORT ALLIÉE side. Necrom l'Ancien #411 ("Gagne +1 AT et piochez une carte quand un
// de vos Sadidas meurt") is a Sadida itself: its own death triggers it, and it makes its owner draw
// while dying (the +1 AT is lost, since the creature is removed). This is not the general rule: every
// other MORT ALLIÉE reactor (Gros Nambourg, Kralamor, Bébé Phorreur #1478) still has to be alive,
// decided card by card.
const ML_FIRES_ON_OWN_DEATH: ReadonlySet<number> = new Set([411]);
// Eliacube #250 (MUR): "Ajoute 1 PA à votre réserve quand une invocation meurt", any creature death,
// either side. Keyed by id (an AddReserve in effects[] is not unique to it: Noximilien/Scoreur/
// Momie… also have one for other reasons); the amount is read from its data.
const RESERVE_ON_DEATH_IDS: ReadonlySet<number> = new Set([250]);
export function resolveDeathsAndWin(
  prevState: GameState,
  creatures: CreatureInstance[],
  dofuses: DofusInstance[],
  log: GameEvent[],
  brokeThroughIds: Set<number>,
  // Nenufar #821: instanceIds whose death-seed was already placed inline during the advance (registerDeathSeed).
  // Excluded from the Nenufar seed loop below so a seed is not added twice (once inline, once here).
  inlineSeededIds: Set<number> = new Set(),
  // TAS D'OS: instanceIds whose Tas d'Os was already placed inline during the advance
  // (registerDeathTasDOs). Excluded from the newTasDOs loop below so it is not added twice.
  inlineTasDOsIds: Set<number> = new Set(),
  // Log index where the damage volley whose consequences are resolved here starts. When given, the
  // CONTRE COUPS of wounded survivors go into the same cell-by-cell sweep as the deaths. When absent,
  // the function only resolves deaths, as before.
  ccFrom?: number,
  // Pure auto-buff contre-coups already applied inline during the advance (see
  // applyInlineContreCoupSelfBuff): not to be replayed.
  inlineBuffed?: Map<number, number>,
  // MORT ADVERSE self buffs already applied inline at the moment of the kill
  // (applyInlineMortAdverseSelfBuff, Chevalier de Parme #1969): instanceId → number of firings to skip
  // in the pass below.
  mortAdverseInlineBuffed?: Map<number, number>,
): GameState {
  // MORT triggers fire before we cull dead creatures so their effects can read the creature's position
  // / state.
  //
  // Resolution order: the damage of one event all lands at the same time, then its consequences are
  // resolved cell by cell, in an absolute order, the same for both players, never mirrored.
  //
  // Column by column, starting from the enemy wall: first key `x` going up (0 → 9, from the enemy wall
  // toward ours), second key `y` going up (0 → 4). So the whole column next to the enemy wall goes
  // first (x=1: y=0, 1, 2, 3, 4), then the next column (x=2: y=0…4), and so on, until our own wall.
  // (Careful: it really is `x` first. Sorting by `y` first would sweep row by row, the opposite.)
  //
  // And the resolution cascades: any death caused by a reaction opens a new wave, resolved right away,
  // until nothing changes. Before, a creature killed by a MORT effect was removed silently (no MORT of
  // its own, no MORT ADVERSE in the others, no posthumous contre-coup).
  const byCell = (a: CreatureInstance, b: CreatureInstance) =>
    (a.position.x - b.position.x) || (a.position.y - b.position.y);
  // A creature that reached the enemy wall / captured a Dofus has currentLife=0 too (see
  // advanceCreature's stepInto), but it did not die: it is a capture, a completely different mechanic.
  // The card goes back to its owner's deck, it is not killed. So it must be invisible to the whole
  // death-trigger system: no MORT of its own, no MORT_ADVERSE/MORT_ALLIEE in others, and not counted by
  // any "quand une invocation meurt" effect (Eliacube reserve, Tas d'Os, Nenufar seeds, Rat Tiboiseur
  // family recover, HORDE discount, #1300/#1643 hand cost). `trulyDying` is that set of real deaths
  // (gathered over all waves); the card-routing loop below still uses the full `deadCreatures`/
  // `brokeThroughIds` to send the captured card back.
  const trulyDying: CreatureInstance[] = [];
  // Posthumous CONTRE COUP: "qu'elle survive ou NON". Captured per wave, before the removal and before
  // the wave's MORTs add new DAMAGE to the log (the killer is read from the log of the damage that just
  // landed). `diedFromDamage` limits it to deaths by damage: a creature destroyed (Destroy / Sacrifice)
  // or captured did not "subir" anything and does not contre-coup. Holds for every lethal source
  // (combat, spell, glyph, APPARITION/MORT effect…), not only the sweep's melee.
  const deadRetaliations: DeadRetaliation[] = [];
  // Player-state MORT effects (e.g. "MORT : Invoque une Momie") cannot run on
  // the creature snapshot, they need the final GameState, so we collect them
  // here and apply them just before returning.
  const mortPlayerEffects: { effect: Effect; owner: Side; pos: Coords }[] = [];
  // Charge effects on a death trigger (Coppa #1048 "MORT ADVERSE : charge de 1 case"; Bébé Tofu #541
  // "MORT : vos tofus chargent") are not handled by applyEffects (charges use the separate advance
  // code). Deferred and replayed on the settled state through applyChargeOnSummon /
  // applyChargeAlliesOnState (full advance: combat, prisms…).
  const mortChargeEffects: { effect: Effect; instanceId: number; owner: Side }[] = [];
  // State-level "targetKiller" effects (Bellaphone #356 "remonte le tueur en main"),
  // bounces / player-state cannot run on the creature snapshot; deferred and replayed
  // on the settled state against the killer's (re-resolved) cell.
  const mortKillerEffects: { effect: Effect; killerInstanceId: number; owner: Side }[] = [];
  // Seeded RNG for everything random during death resolution: MORT / MORT_ADVERSE random effects (Otomaï
  // #447 "invocations aléatoires coûtant 5 PA") and the death-recover coin (Shava #367). Created before
  // the MORT loop so the dying creatures' random effects draw from the seeded stream (sims/replays can
  // be reproduced) instead of Math.random; the real death path never goes through runTrigger (which
  // seeds its own rng), only through here. Stored in result.rng below; unchanged if nothing random
  // fired. `let`: a CONTRE COUP slotted in between plays its own RNG stream (runTrigger), so it is
  // synced again afterwards to keep a single stream (otherwise the same draws would be replayed and the
  // replay would go out of sync).
  let deathRng = new Rng(prevState.rng);
  // Current state passed through the sweep: a CONTRE COUP slotted in between can summon, draw, gain AP…
  // Everything the final packing reads (players, RNG, nextInstanceId, seeds, glyphs) must come from
  // here and not from `prevState`, otherwise those gains would be overwritten. Equal to `prevState` as
  // long as no contre-coup is slotted in, so nothing changes for callers without `ccFrom`.
  let base = prevState;
  // Display: the reactions to a death (MORT / MORT ADVERSE / MORT ALLIÉE) are resolved here, so after
  // the full sweep. Their stat events end up at the end of the log, and the boost animation played
  // after the other creatures moved instead of at the moment of the fatal hit (Disciple Cochonnet
  // #616). Each stat event produced by a reaction is stamped with the id of the dead creature that
  // triggered it, and the replay plays it at that beat. Display only: the final state does not change.
  const STAT_EVENTS = new Set(["ATTACK_GAINED", "ARMOR_GAINED", "LIFE_HEALED", "MOVEMENT_POINT_BOOST"]);
  const stampDeathReaction = (from: number, victimId: number) => {
    for (let k = from; k < log.length; k++) {
      const e = log[k] as { type: string; onDeathOf?: number };
      if (STAT_EVENTS.has(e.type) && e.onDeathOf === undefined) e.onDeathOf = victimId;
    }
  };
  // Ecaflip roll reactions (Sentinelle Affûtée #1606 board +AT/+AR, Atout Caché #1201 hand −PA) fire on every
  // allied coin/dice roll, including Shava Shavien #367's MORT coin, which is flipped inside the card-recover
  // routing below (not a CoinFlip effect, so effectsHaveRoll/runTrigger never sees it). The number of rolls each
  // side made during death resolution is counted here (two Shavas dying = two rolls = +2) and applied at the end.
  const rollCounts: Record<Side, number> = { ally: 0, enemy: 0 };

  // ---- The resolution sweep -----------------------------------------------------------------------
  // One single list for all reactions (the MORT of a killed creature and the CONTRE COUP of a wounded
  // survivor), sorted by the absolute cell order. We take the cell with the highest priority, resolve
  // it completely, and if that produces new damage (so new deaths, new contre-coups), they go into the
  // same list and are taken in turn: a creature killed by a reaction, even on a cell already passed, is
  // resolved right away.
  //
  // CONTRE COUP is only slotted in if the caller gives `ccFrom` (the start of the damage volley).
  // Callers that do not keep their old order (deaths here, contre-coups at their own boundary), which
  // limits the reach of this change.
  const resolvedDeadIds = new Set<number>();
  // Volley: the corpses that appeared at the same moment. The posthumous MORT ADVERSE
  // (MA_FIRES_ON_OWN_DEATH) only counts within its own volley: a dead creature does not react to a death
  // that came after its own (Chuck Lapalette #1541 used to tutor two Cochons, one of them for a later
  // death).
  const salveOf = new Map<number, number>();
  let salveSeq = 0;
  // How far each creature's contre-coup has been handled: it reacts to each new damage (two Prespic
  // #478 hit each other back until both die, which is the intended behaviour).
  const ccDone = new Map<number, number>();
  const canContreCoup = (c: CreatureInstance) =>
    c.triggers.some((t) => t.trigger === "CONTRE_COUP")
    || (getCard(c.cardId)?.effects ?? []).some((e) => e.type === "BounceBelowPv");
  const tookDamageSince = (id: number, from: number): boolean => {
    for (let i = from; i < log.length; i++) {
      const ev = log[i] as { type: string; targetInstanceId?: number; damage?: number; armorHit?: boolean };
      if (ev.type === "DAMAGE" && ev.targetInstanceId === id && ((ev.damage ?? 0) > 0 || ev.armorHit)) return true;
    }
    return false;
  };

  for (let step = 0; step < 512; step++) {
    // 1. Stamp the new corpses: those that fall together form a volley.
    const fresh = creatures.filter((c) => c.currentLife <= 0 && !salveOf.has(c.instanceId));
    if (fresh.length > 0) {
      salveSeq += 1;
      for (const c of fresh) salveOf.set(c.instanceId, salveSeq);
      // The posthumous contre-coup is read from the log of the damage that just landed, so before the MORTs
      // of this volley add theirs.
      deadRetaliations.push(...collectDeadRetaliations(
        fresh.filter((c) => !brokeThroughIds.has(c.instanceId) && c.diedFromDamage), log,
      ));
    }
    // 2. The single list of pending reactions, sorted by cell.
    const pending: CreatureInstance[] = [];
    for (const c of creatures) {
      if (c.currentLife <= 0) {
        if (!resolvedDeadIds.has(c.instanceId) && !brokeThroughIds.has(c.instanceId)) pending.push(c);
      } else if (ccFrom !== undefined && canContreCoup(c) && tookDamageSince(c.instanceId, ccDone.get(c.instanceId) ?? ccFrom)) {
        pending.push(c);
      }
    }
    if (pending.length === 0) break;
    pending.sort(byCell);
    const me = pending[0];

    // 3a. CASE D'UNE SURVIVANTE BLESSÉE → son CONTRE COUP, ici et maintenant.
    if (me.currentLife > 0) {
      const from = ccDone.get(me.instanceId) ?? ccFrom!;
      ccDone.set(me.instanceId, log.length); // what is handled here will not be replayed
      const corpses = creatures.filter((c) => c.currentLife <= 0);
      const live = creatures.filter((c) => c.currentLife > 0);
      // fireContreCoup works on a GameState: it is wrapped around the living creatures (it ignores corpses),
      // it runs, then the corpses go back into the array, where they wait for their cell.
      const after = fireContreCoup(
        { ...base, creatures: live, dofuses, log, rng: deathRng.state },
        from, inlineBuffed, me.instanceId,
      );
      base = after;
      creatures = [...after.creatures.map((c) => ({ ...c, position: { ...c.position } })), ...corpses];
      dofuses = after.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
      log = after.log;
      deathRng = new Rng(after.rng);
      if (base.winner) break;
      continue;
    }

    // 3b. Cell of a dead creature → its MORT, then the MORT ADVERSE / ALLIÉE it triggers in the others.
    resolvedDeadIds.add(me.instanceId);
    trulyDying.push(me);

  {
    const mortTriggers = me.triggers.filter((t) => t.trigger === "MORT");
    for (const t of mortTriggers) {
      for (const eff of t.effects) {
        if ((eff as { targetKiller?: boolean }).targetKiller) {
          // The killer is the source of the last DAMAGE in the log that targeted `me`.
          // Bouftou Citrouille #780 (Transform) runs on the snapshot; state-level
          // effects (Bellaphone #356 ReturnToHand bounce) are deferred to the final
          // state. Only fires if the killer survived the trade.
          let killerId = -1;
          for (let i = log.length - 1; i >= 0; i--) {
            const ev = log[i] as { type: string; targetInstanceId?: number; sourceInstanceId?: number };
            if (ev.type === "DAMAGE" && ev.targetInstanceId === me.instanceId && (ev.sourceInstanceId ?? -1) >= 0) { killerId = ev.sourceInstanceId!; break; }
          }
          const stateLevel = PLAYER_STATE_TYPES.has(eff.type) || eff.type === "ReturnToHand" || eff.type === "ReturnToDeck" || eff.type === "MoveAdjacentRowRandom";
          if (stateLevel) {
            if (killerId >= 0) mortKillerEffects.push({ effect: eff, killerInstanceId: killerId, owner: me.owner });
          } else {
            const killer = creatures.find((c) => c.instanceId === killerId && c.currentLife > 0);
            if (killer) {
              applyEffects(creatures, dofuses, log, [eff], {
                casterSide: me.owner,
                selfInstanceId: me.instanceId,
                targetCell: { ...killer.position },
                diceFloor: base.players[me.owner].diceFloor,
                rng: deathRng,
              });
            }
          }
        } else if (eff.type === "ChargeSelf" || eff.type === "ChargeAllies") {
          mortChargeEffects.push({ effect: eff, instanceId: me.instanceId, owner: me.owner });
        } else if (PLAYER_STATE_TYPES.has(eff.type)) {
          mortPlayerEffects.push({ effect: eff, owner: me.owner, pos: { ...me.position } });
        } else {
          // Creature/area effects run on the snapshot. targetCell = the dying
          // creature's own cell so area shapes ("autour de lui") center on it.
          const fromMort = log.length;
          applyEffects(creatures, dofuses, log, [eff], {
            casterSide: me.owner,
            selfInstanceId: me.instanceId,
            targetCell: { ...me.position },
            diceFloor: base.players[me.owner].diceFloor,
            rng: deathRng,
          });
          stampDeathReaction(fromMort, me.instanceId); // MORT : ses effets s'animent a sa mort
        }
      }
    }
  }

  // MORT_ADVERSE ("Mort adverse"), the mirror of MORT: a creature reacts each time one of its enemies
  // dies, anywhere on the board (any enemy death; fires once per death). Self/area effects run on the
  // snapshot (selfInstanceId = the reactor); player-state effects (e.g. AddReserve) are deferred with
  // the MORT player effects. A reactor that died is normally excluded, except the four
  // MA_FIRES_ON_OWN_DEATH cards (rule 8), which fire after death, but only for the deaths of their own
  // volley: dying does not let them react to what happens after. The reactors strike at the same time
  // (two Guerrier Boudeur #1108 = one volley); they are taken in cell order.
  for (const dead of [me]) {
    for (const reactor of [...creatures].sort(byCell)) {
      const reactorFiresWhenDead =
        reactor.currentLife <= 0 && !brokeThroughIds.has(reactor.instanceId)
        && MA_FIRES_ON_OWN_DEATH.has(reactor.cardId)
        && salveOf.get(reactor.instanceId) === salveOf.get(dead.instanceId);
      if ((reactor.currentLife <= 0 && !reactorFiresWhenDead) || reactor.owner === dead.owner) continue;
      // Already applied inline when this reactor killed (Chevalier de Parme #1969 clearing a row: the +AT
      // went up at each kill so the Dofus hit gets it). One firing per inline kill is then skipped, so it is
      // not doubled. Only concerns its pure auto-buff MORT ADVERSE.
      if ((mortAdverseInlineBuffed?.get(reactor.instanceId) ?? 0) > 0 && mortAdverseSelfStatBuffs(reactor)) {
        mortAdverseInlineBuffed!.set(reactor.instanceId, mortAdverseInlineBuffed!.get(reactor.instanceId)! - 1);
        continue;
      }
      for (const t of reactor.triggers) {
        if (t.trigger !== "MORT_ADVERSE") continue;
        // Resolve "+N par X en jeu" count amounts against the live board (Disciple
        // Cochonnet: +1 AT/+1 AR par cochon allié), keyed off the reactor as self.
        const resolved = resolveCounts(t.effects, creatures, base.seeds ?? [], base.glyphs ?? [], reactor.owner, reactor.instanceId, base.players[reactor.owner].apReserve, base.players[reactor.owner].hand.length, (base.butins ?? []).length);
        for (const eff of resolved) {
          if (eff.type === "ChargeSelf" || eff.type === "ChargeAllies") {
            mortChargeEffects.push({ effect: eff, instanceId: reactor.instanceId, owner: reactor.owner });
          } else if (PLAYER_STATE_TYPES.has(eff.type)) {
            mortPlayerEffects.push({ effect: eff, owner: reactor.owner, pos: { ...reactor.position } });
          } else {
            const from = log.length;
            applyEffects(creatures, dofuses, log, [eff], {
              casterSide: reactor.owner,
              selfInstanceId: reactor.instanceId,
              targetCell: { ...reactor.position },
              diceFloor: base.players[reactor.owner].diceFloor,
              rng: deathRng,
            });
            stampDeathReaction(from, dead.instanceId); // le boost s'anime au coup fatal
          }
        }
      }
    }
  }

  // MORT_ALLIEE ("quand une invocation alliée meurt"), the same-side mirror: a living creature reacts
  // each time one of its own other invocations dies (Gros Nambourg +1 AT, Kralamor heals the rest). Same
  // once-per-death code as MORT_ADVERSE; the dead creature is excluded since it is not alive, except the
  // ML_FIRES_ON_OWN_DEATH cards (Necrom l'Ancien #411), which react to their own death. Reactors are
  // taken in absolute cell order.
  for (const dead of [me]) {
    for (const reactor of [...creatures].sort(byCell)) {
      // A capture is not a death: a creature that broke through never triggers itself.
      const firesOnOwnDeath =
        reactor.instanceId === dead.instanceId
        && !brokeThroughIds.has(reactor.instanceId)
        && ML_FIRES_ON_OWN_DEATH.has(reactor.cardId);
      if ((reactor.currentLife <= 0 && !firesOnOwnDeath) || reactor.owner !== dead.owner) continue;
      for (const t of reactor.triggers) {
        if (t.trigger !== "MORT_ALLIEE") continue;
        // A family filter ("quand un PHORREUR allié meurt", Bébé Phorreur #1478) limits it to deaths of that
        // family; no filter = any allied death.
        if (t.filter?.family && !(famsOf(dead)).includes(t.filter.family)) continue;
        const resolved = resolveCounts(t.effects, creatures, base.seeds ?? [], base.glyphs ?? [], reactor.owner, reactor.instanceId, base.players[reactor.owner].apReserve, base.players[reactor.owner].hand.length, (base.butins ?? []).length);
        for (const eff of resolved) {
          if (eff.type === "ChargeSelf" || eff.type === "ChargeAllies") {
            mortChargeEffects.push({ effect: eff, instanceId: reactor.instanceId, owner: reactor.owner });
          } else if (PLAYER_STATE_TYPES.has(eff.type)) {
            mortPlayerEffects.push({ effect: eff, owner: reactor.owner, pos: { ...reactor.position } });
          } else {
            const from = log.length;
            applyEffects(creatures, dofuses, log, [eff], {
              casterSide: reactor.owner,
              selfInstanceId: reactor.instanceId,
              targetCell: { ...reactor.position },
              diceFloor: base.players[reactor.owner].diceFloor,
              rng: deathRng,
            });
            stampDeathReaction(from, dead.instanceId); // le boost s'anime au coup fatal
          }
        }
      }
    }
  }

  } // ---- end of the wave: if its reactions killed, the next wave picks them up -----------------------

  const deadCreatures = creatures.filter((c) => c.currentLife <= 0);
  const aliveCreatures = creatures.filter((c) => c.currentLife > 0);
  // A creature brought to 0 then healed back within the same wave survives, drop the marker so it
  // can never fire a posthumous CONTRE COUP on a later, non-damage death.
  for (const c of aliveCreatures) if (c.diedFromDamage) delete c.diedFromDamage;
  const deadDofuses = dofuses.filter((d) => d.currentLife <= 0);
  const aliveDofuses = dofuses.filter((d) => d.currentLife > 0);

  const playersAfter = { ...base.players };
  // Eliacube #250: each living Eliacube adds its reserve amount × the number of creatures that died in
  // this wave (any side) to its owner's AP reserve. Dofus deaths do not count ("une invocation"), and
  // neither does a Dofus capture (a break-through is not a death), so count `trulyDying`, not
  // `deadCreatures`. A dead Eliacube gives nothing (not in aliveCreatures).
  if (trulyDying.length > 0) {
    for (const c of aliveCreatures) {
      if (!RESERVE_ON_DEATH_IDS.has(c.cardId)) continue;
      const amt = ((getCard(c.cardId)?.effects ?? []).find((e) => e.type === "AddReserve") as { amount?: number } | undefined)?.amount ?? 1;
      const p = playersAfter[c.owner];
      playersAfter[c.owner] = { ...p, apReserve: p.apReserve + amt * trulyDying.length };
    }
  }
  // A dying creature's MORT effect runs before the card itself reaches the discard
  // (Indie #454 "récupère une carte Infinite de votre défausse" must not see itself).
  // So we DEFER the dead cards' discard additions and apply them after the MORT
  // player-state effects below.
  const deferredDeadDiscards: { side: Side; cardId: number }[] = [];
  // A card that goes back to the hand on death (Shava #367, Baron Sramedi #243, Renisurrection #483,
  // Héros Félin #1156) and that a full hand sends to the discard is really "défaussée car la main d'un
  // des joueurs est pleine": it must feed Nain Patraque #965 and Crasslek #355 like any draw burn.
  let recoverOverflowBurns = 0;
  for (const dead of deadCreatures) {
    const owner = playersAfter[dead.owner];
    if (brokeThroughIds.has(dead.instanceId) || dead.properties.has("DeckOnDeath")) {
      // #1156 Héros Félin (RecoverToHandOnDofusKill): a creature that BREAKS through
      // (destroys a Dofus) and carries this marker returns to its owner's hand at the
      // marker's cost (0 PA) instead of recycling to the deck. Enfouissement/DeckOnDeath
      // is not a break-through, so it always recycles below.
      const recMk = brokeThroughIds.has(dead.instanceId)
        ? (getCard(dead.cardId)?.effects ?? []).find((e) => e.type === "RecoverToHandOnDofusKill") as { cost?: number } | undefined
        : undefined;
      if (recMk) {
        if (owner.hand.length >= MAX_HAND) {
          deferredDeadDiscards.push({ side: dead.owner, cardId: dead.cardId });
          recoverOverflowBurns++;
        } else {
          // Stamp this recovered copy's own hand slot so its effective cost = recMk.cost
          // (0), a per-copy discount, not a card-wide one (a fresh copy keeps full price).
          // cheapestHandSlot + playCard ensure this discounted slot is the one spent.
          const mod = (recMk.cost ?? 0) - (getCard(dead.cardId)?.cost ?? 0);
          playersAfter[dead.owner] = { ...owner, hand: [...owner.hand, dead.cardId], handCostMods: [...owner.handCostMods, mod] };
          log.push({ type: "CARD_MOVED", cardId: dead.cardId, from: "board", to: "hand", side: dead.owner });
        }
      } else {
        // Send back to the deck (not the discard). The deck convention is `pop()` from the end, so the top
        // (next card drawn) is the last array element and the bottom is index 0. Enfouissement #684 ("se
        // place sur la pioche de son propriétaire") puts the marked creature on top, so it is drawn next; a
        // plain break-through goes to the bottom. deckCostMods is kept aligned when present (a card sent back
        // has no discount, so 0).
        const toTop = dead.properties.has("DeckOnDeath");
        const deck = toTop ? [...owner.deck, dead.cardId] : [dead.cardId, ...owner.deck];
        const mods = owner.deckCostMods && owner.deckCostMods.length === owner.deck.length ? owner.deckCostMods : null;
        playersAfter[dead.owner] = mods
          ? { ...owner, deck, deckCostMods: toTop ? [...mods, 0] : [0, ...mods] }
          : { ...owner, deck };
        // The card goes back into the deck: the replay has to see it pass to animate it (the original
        // game's move to the deck, 0.30 s) and play its sounds (leaving the board = card_move_gen, reaching
        // the deck = card_graveyardIn). Without this event, a creature that broke through a Dofus went back
        // to the deck in total silence.
        log.push({ type: "CARD_MOVED", cardId: dead.cardId, from: "board", to: "deck", side: dead.owner });
      }
    } else if (isNecrome(dead.cardId)) {
      // NÉCROME: dies removed from the game, banished, not discarded ("il ne va pas en défausse, la carte
      // est bannie"). Only the normal death (discard) path is replaced; a creature that broke through a
      // Dofus still goes back to the deck above.
      playersAfter[dead.owner] = {
        ...owner,
        banished: [...(owner.banished ?? []), dead.cardId],
      };
      log.push({ type: "CARD_MOVED", cardId: dead.cardId, from: "board", to: "banished", side: dead.owner });
    } else if (dead.properties.has("ReturnToHandOnDeath") || returnsViaFamilyAura(dead, creatures, salveOf, brokeThroughIds)) {
      // Renisurrection #483: the enchanted creature returns to its owner's hand on
      // death at its normal cost. Honour MAX_HAND, a full hand burns it to discard.
      // Excarnus #523: an allied Bouftou returns the same way while a living other
      // allied Excarnus covers it (returnsViaFamilyAura).
      if (owner.hand.length >= MAX_HAND) {
        deferredDeadDiscards.push({ side: dead.owner, cardId: dead.cardId });
        recoverOverflowBurns++;
      } else {
        playersAfter[dead.owner] = { ...owner, hand: [...owner.hand, dead.cardId], handCostMods: [...owner.handCostMods, 0] };
        log.push({ type: "CARD_MOVED", cardId: dead.cardId, from: "board", to: "hand", side: dead.owner });
      }
    } else if (recoversToHandOnDeath(dead.cardId, owner, aliveDofuses.filter((d) => d.owner === dead.owner).length)) {
      // Baron Sramedi: the card returns to hand instead of the discard when its
      // condition holds. Honour MAX_HAND, a full hand burns the card to discard.
      // Shava Shavien #367: a coin decides which hand (pile = owner's, face = enemy's). The flip is a real
      // allied roll → record it so the owner's roll reactions (Sentinelle Affûtée / Atout Caché) fire below.
      const recEff = (getCard(dead.cardId)?.triggers ?? []).flatMap((t) => (t.trigger === "MORT" ? t.effects : [])).find((e) => e.type === "RecoverSelfToHand") as { coinToEnemy?: boolean } | undefined;
      let toSide: Side = dead.owner;
      if (recEff?.coinToEnemy) {
        const pile = flipCoin(base, dead.owner, deathRng);
        rollCounts[dead.owner] += 1;
        if (!pile) toSide = other(dead.owner);
      }
      const target = playersAfter[toSide];
      if (target.hand.length >= MAX_HAND) {
        deferredDeadDiscards.push({ side: dead.owner, cardId: dead.cardId });
        recoverOverflowBurns++;
      } else {
        // Cumulative cost escalation per COPY (Polter Tofu #358): this death adds costDelta,
        // and only this copy escalates. The escalation is SELF-originated so it carries, but
        // any external reduction the copy was played with (Vampyro/Wagnar "−N jusqu'à la
        // défausse") is reset here, a death sends the card through the discard (unlike a live
        // bounce, which keeps it). Self-surcharges are positive and external stamps negative,
        // so the prior self-surcharge is max(0, playedCostMod): a Vampyro-discounted Polter Tofu
        // that dies comes back at base+1 = 2 (the −1 dropped), still escalating per re-death.
        const bonus = Math.max(0, dead.playedCostMod ?? 0) + recoverCostDeltaOnDeath(dead.cardId);
        playersAfter[toSide] = {
          ...target,
          hand: [...target.hand, dead.cardId],
          handCostMods: [...target.handCostMods, bonus],
        };
        log.push({ type: "CARD_MOVED", cardId: dead.cardId, from: "board", to: "hand", side: toSide });
      }
    } else {
      deferredDeadDiscards.push({ side: dead.owner, cardId: dead.cardId });
    }
  }

  // Fake-Dofus destruction → +1 column of spawn range for the DESTROYER's
  // side (the opposite of the dead Dofus's owner, since you only attack
  // enemy Dofuses).
  for (const dead of deadDofuses) {
    if (dead.kind !== "fake") continue;
    const destroyer = other(dead.owner);
    const p = playersAfter[destroyer];
    playersAfter[destroyer] = {
      ...p,
      extraSpawnRange: p.extraSpawnRange + 1,
    };
  }

  // Trophy record: append each real Dofus destroyed this wave to capturedDofuses
  // (kept for the card-pool trophy display). Fakes are excluded (only "vrais
  // dofus"); we store the colour + losing owner so the UI renders the exact egg.
  const newlyCaptured = deadDofuses
    .filter((d) => d.kind === "real")
    .map((d) => ({ owner: d.owner, color: d.color ?? d.position.y }));
  const capturedDofuses = newlyCaptured.length
    ? [...(base.capturedDofuses ?? []), ...newlyCaptured]
    : base.capturedDofuses;

  // Destroyed-slot record: every Dofus destroyed this wave (real and fake) leaves
  // a persistent smoke marker on its emptied wall cell (original's DestroyedFx,
  // white for a real, black for a fake). Position + kind so the UI renders the
  // right smoke at the right slot for the rest of the match. A percée (capture)
  // is a destruction here (deadDofuses = currentLife <= 0), which is what we want.
  const newlyDestroyed = deadDofuses.map((d) => ({
    position: { ...d.position },
    owner: d.owner,
    kind: d.kind,
  }));
  const destroyedDofuses = newlyDestroyed.length
    ? [...(base.destroyedDofuses ?? []), ...newlyDestroyed]
    : base.destroyedDofuses;

  // Win condition: capture REAL_DOFUS_TO_WIN of the opponent's real Dofuses.
  // Each side starts with REAL_DOFUS_PER_SIDE reals (at randomised rows), so the
  // count, not the rows, is what matters here.
  const allyRealLost = REAL_DOFUS_PER_SIDE
    - aliveDofuses.filter((d) => d.owner === "ally" && d.kind === "real").length;
  const enemyRealLost = REAL_DOFUS_PER_SIDE
    - aliveDofuses.filter((d) => d.owner === "enemy" && d.kind === "real").length;
  let winner: Side | null = base.winner;
  if (enemyRealLost >= REAL_DOFUS_TO_WIN && allyRealLost < REAL_DOFUS_TO_WIN) winner = "ally";
  else if (allyRealLost >= REAL_DOFUS_TO_WIN && enemyRealLost < REAL_DOFUS_TO_WIN) winner = "enemy";
  if (winner && base.winner !== winner) {
    log.push({ type: "LAST_DOFUS_DESTROYED", winner });
  }

  // Control reversions (Miranda #107 / Anathar #316 "tant qu'il est en vie"), checked again at each
  // resolution. Control only ends if the source dies or is transformed (silence and Marline do not
  // break it, so neither touches the reversion here). On top of that, a transformation of the
  // controlled creature itself (Marca Or) ties it to the controller for good. A transformation is
  // detected by card identity (cardId saved when control was taken), checked at each pass, not only
  // at death.
  const deadIds = new Set(deadCreatures.map((d) => d.instanceId));
  const prevRev = base.pendingReversions ?? [];
  const endedControl: typeof prevRev = [];
  // Sweep order (area effects other than damage) from `side`'s point of view: the first cell is the
  // front (most advanced column), then row by row, L1→L5. `a` comes before `b` when the comparator is
  // < 0 (= moveOrderIds). Used to settle the Marca Or race below.
  const sweepPrecedes = (a: Coords, b: Coords, side: Side): boolean =>
    (side === "ally" ? (a.x - b.x) || (a.y - b.y) : (b.x - a.x) || (b.y - a.y)) < 0;
  for (const r of prevRev) {
    if (r.kind !== "control") continue;
    const seized = aliveCreatures.find((c) => c.instanceId === r.instanceId);
    const seizedTransformed = !!seized && r.seizedCardId != null && seized.cardId !== r.seizedCardId;
    let source: CreatureInstance | undefined;
    let sourceTransformed = false;
    let sourceGone = false;
    if (r.linkedTo != null) {
      source = aliveCreatures.find((c) => c.instanceId === r.linkedTo);
      sourceTransformed = !!source && r.sourceCardId != null && source.cardId !== r.sourceCardId;
      // The source is gone if it dies or is transformed (silence/Marline do not count).
      sourceGone = deadIds.has(r.linkedTo) || !source || sourceTransformed;
    }
    if (!seizedTransformed && !sourceGone) continue; // nothing changes for this reversion
    if (seizedTransformed && sourceGone) {
      // Race (Marca Or, sweep): the controlled creature and the source both changed in the same pass. The
      // sweep order decides, from the controller's point of view (both are in its camp).
      //  - controlled creature transformed before the source → it keeps its new camp (reversion removed);
      //  - source transformed/dead before → control is broken first → the controlled creature goes back.
      // Source dead (not transformed) → no cell to compare: the transformation wins, it stays.
      const ctrlSide = seized!.owner; // = the controller (not given back yet at this point)
      const seizedFirst = !sourceTransformed || !source || sweepPrecedes(seized!.position, source.position, ctrlSide);
      if (!seizedFirst) seized!.owner = r.originalOwner;
      endedControl.push(r);
      continue;
    }
    if (seizedTransformed) { endedControl.push(r); continue; } // controlled creature transformed, source intact → it stays
    // sourceGone only (source died or was transformed) → the controlled creature goes back to its camp.
    if (seized) seized.owner = r.originalOwner;
    endedControl.push(r);
  }
  const reversionsAfter = endedControl.length > 0 ? prevRev.filter((r) => !endedControl.includes(r)) : prevRev;

  let result: GameState = {
    ...base,
    players: playersAfter,
    // Recompute auras: a chief may have just died (drop its buff) or a target
    // left the board. Seeds are unchanged by death resolution, so the seed-side
    // set from prevState is current for the ConditionalSeedProperty step.
    creatures: withAuras(aliveCreatures, seedSidesOf(base)),
    dofuses: aliveDofuses,
    capturedDofuses,
    destroyedDofuses,
    pendingReversions: reversionsAfter,
    rng: deathRng.state, // advanced if a death-recover coin (Shava #367) was flipped; else unchanged
    log,
    winner,
  };
  // Apply collected MORT player-state effects to the final state (the dying
  // creature is already culled, so a death-summon lands on a now-free board).
  for (const { effect, owner, pos } of mortPlayerEffects) {
    result = applyPlayerStateEffect(result, effect, owner, undefined, pos).state;
  }
  // Now the dead cards reach their owners' discards, after their own MORT effects ran
  // (so a death-recover does not pull the just-died card back; Indie #454). A token
  // creature (Gélatine, Tas d'Os figurine…) is routed to the inaccessible tokenDiscard
  // instead of the normal pile (discardCardFor), so no recovery effect ever sees it.
  for (const { side, cardId } of deferredDeadDiscards) {
    result = { ...result, players: { ...result.players, [side]: discardCardFor(result.players[side], cardId) } };
  }
  // Nécro Phorreur #1221: while a living BanishAllDiscards creature is on the board (either side), no
  // card may stay in either player's discard; both piles are moved into `banished`. Done here, right
  // after the dead cards reached the discard and before the RecoverSelfOnFamilyDeath pass below, so a
  // card that should be banished is never pulled back to hand by Rat Tiboiseur #339. The discard stays
  // empty as long as Nécro Phorreur lives; once it dies (not among the survivors here) discards work
  // again. (Note: a discard from before it arrived is also cleared on the first settle.)
  if (discardsAreBanished(result.creatures)) {
    for (const side of ["ally", "enemy"] as Side[]) {
      const p = result.players[side];
      if (p.discard.length > 0) {
        result = { ...result, players: { ...result.players, [side]: { ...p, banished: [...(p.banished ?? []), ...p.discard], discard: [] } } };
      }
    }
  }
  // Replay deferred state-level "targetKiller" effects (Bellaphone #356 "remonte le
  // tueur en main") on the settled state, against the killer's current cell, only if
  // it is still on the board.
  for (const { effect, killerInstanceId, owner } of mortKillerEffects) {
    const killer = result.creatures.find((c) => c.instanceId === killerInstanceId && c.currentLife > 0);
    if (!killer) continue;
    // Nainfants #904: the killer changes to a random adjacent row (no player pick).
    if (effect.type === "MoveAdjacentRowRandom") result = moveToRandomAdjacentRow(result, killerInstanceId);
    else result = applyPlayerStateEffect(result, effect, owner, { ...killer.position }).state;
  }
  // Replay deferred death-trigger charges on the settled state, once per death (Coppa
  // #1048 advances 1 case per enemy death ; Bébé Tofu #541 makes your Tofus charge).
  for (const { effect, instanceId, owner } of mortChargeEffects) {
    if (effect.type === "ChargeSelf") {
      const me = result.creatures.find((c) => c.instanceId === instanceId && c.currentLife > 0);
      const cells = (effect as { cells?: number }).cells ?? me?.baseMovement ?? 0;
      result = applyChargeOnSummon(result, instanceId, Math.max(0, cells | 0));
    } else {
      const ce = effect as { cells?: number; family?: string; excludeSelf?: boolean; wounded?: boolean };
      result = applyChargeAlliesOnState(result, owner, ce.cells, ce.excludeSelf ? instanceId : undefined, ce.family, ce.wounded);
    }
  }
  // HORDE discount: each HORDE creature that died this wave stamps −1 PA on every
  // HORDE card still in its owner's hand + deck (the dead creature's own card is
  // already in the discard, so it is not counted).
  const hordeDeaths: Record<Side, number> = { ally: 0, enemy: 0 };
  // `trulyDying` already excludes captures (brokeThroughIds): only a real death of a HORDE creature
  // stamps the −1 PA (a capture is not a death).
  for (const me of trulyDying) {
    if (getCard(me.cardId)?.horde) hordeDeaths[me.owner] += 1;
  }
  if (hordeDeaths.ally > 0 || hordeDeaths.enemy > 0) {
    result = {
      ...result,
      players: {
        ally: applyHordeDiscount(result.players.ally, hordeDeaths.ally),
        enemy: applyHordeDiscount(result.players.enemy, hordeDeaths.enemy),
      },
    };
  }
  // "Tant qu'elle est en main, son coût est réduit de N PA quand une invocation [ennemie] meurt"
  // (Nonne #1643 = anyDeath, Impératrice Galantine #1300 = enemyDeath): stamp the HandCostOnEvent
  // markers per side (anyDeath = all deaths of this wave; enemyDeath = deaths of the holder's
  // opponent's creatures).
  // A creature that captured a Dofus (brokeThroughIds) is excluded by `trulyDying`, so it never counts
  // for the "quand une invocation meurt" cost reduction of #1300/#1643.
  if (trulyDying.length > 0) {
    for (const side of ["ally", "enemy"] as Side[]) {
      result = stampHandCostOnEvent(result, side, "anyDeath", trulyDying.length);
      result = stampHandCostOnEvent(result, side, "enemyDeath", trulyDying.filter((d) => d.owner !== side).length);
    }
  }
  // "Revient de votre défausse dans votre main quand un de vos <famille> meurt" (Rat
  // Tiboiseur #339 = Rat): per side, gather the families of this side's creatures that
  // died this wave, then pull any RecoverSelfOnFamilyDeath card of a matching family out
  // of that side's discard back into its hand (addCardToHand honours MAX_HAND).
  if (trulyDying.length > 0) {
    const deathFams: Record<Side, Set<string>> = { ally: new Set(), enemy: new Set() };
    for (const dead of trulyDying) for (const f of famsOf(dead)) deathFams[dead.owner].add(f);
    for (const side of ["ally", "enemy"] as Side[]) {
      if (deathFams[side].size === 0) continue;
      const idxs: number[] = [];
      result.players[side].discard.forEach((id, i) => {
        const m = (getCard(id)?.effects ?? []).find((e) => e.type === "RecoverSelfOnFamilyDeath") as { family?: string } | undefined;
        if (m?.family && deathFams[side].has(m.family)) idxs.push(i);
      });
      if (idxs.length === 0) continue;
      const drop = new Set(idxs);
      const ids = idxs.map((i) => result.players[side].discard[i]);
      result = { ...result, players: { ...result.players, [side]: { ...result.players[side], discard: result.players[side].discard.filter((_, i) => !drop.has(i)) } } };
      for (const id of ids) result = addCardToHand(result, side, id, 1, 0);
    }
  }
  // "TAS D'OS" keyword: a dying tagged creature (Chafer) leaves a Tas d'Os on its
  // death cell, owned by its side. The creature is culled, so the cell is now free.
  // A captured Chafer (brokeThroughIds) left to the deck, did not die → no Tas d'Os (trulyDying).
  const newTasDOs = trulyDying
    .filter((d) => getCard(d.cardId)?.tasDOs)
    .filter((d) => !inlineTasDOsIds.has(d.instanceId)) // already placed inline at the moment of death (sweep)
    .map((d) => ({ position: { ...d.position }, owner: d.owner }));
  if (newTasDOs.length > 0) {
    // One object per cell: a glyph the dying Chafer was standing on is replaced by the Tas d'Os.
    const rem: GameEvent[] = [];
    for (const t of newTasDOs) result = replaceGroundObjectsAt(result, t.position, rem);
    result = { ...result, tasDOs: [...(result.tasDOs ?? []), ...newTasDOs], log: [...result.log, ...rem] };
  }
  // "Tant qu'elle est en jeu, vos autres <famille> se transforment en graines quand ils meurent"
  // (Nenufar #821 = Sadida): each dying allied creature of a matching family leaves a Seed on its (now
  // free) death cell, same shape as the Tas d'Os keyword. The card itself still goes to the discard
  // through the normal death routing.
  //
  // The marker is judged at the moment the victim dies (Incision kills Nenufar and La Gonflable in the
  // same volley, and the doll still leaves its seed). Deaths in a volley are simultaneous (only their
  // resolution is one after the other), so a carrier counts if it is alive, or died in the same volley
  // as the victim or a later one (it was still in play at the victim's fatal moment). A carrier that
  // died in an earlier volley (killed earlier in the cascade) does not count, and neither does a
  // captured carrier (it broke through: it left the game through its own event, and a capture is not
  // a death). Note: the cell-by-cell resolution order (Gelax/Encre) does not matter here; this checks a
  // state condition at the moment of death, not the targets of an effect that resolves on the current
  // board.
  const nenufarCovers = (d: CreatureInstance): boolean => {
    const vFams = famsOf(d);
    if (vFams.length === 0) return false;
    const vSalve = salveOf.get(d.instanceId) ?? 0;
    return creatures.some((c) =>
      c.instanceId !== d.instanceId && c.owner === d.owner &&
      (c.currentLife > 0 || (!brokeThroughIds.has(c.instanceId) && (salveOf.get(c.instanceId) ?? 0) >= vSalve)) &&
      (getCard(c.cardId)?.effects ?? []).some(
        (e) => e.type === "AllyFamilyDeathSeed" && vFams.includes((e as { family: string }).family),
      ));
  };
  const newSeeds = trulyDying
    .filter((d) => !inlineSeededIds.has(d.instanceId)) // already placed inline at the moment of death
    .filter(nenufarCovers)
    .map((d) => ({ position: { ...d.position }, owner: d.owner }));
  if (newSeeds.length > 0) {
    // One object per cell: a glyph the dying Sadida stood on is replaced by the Nenufar seed.
    const rem: GameEvent[] = [];
    for (const s of newSeeds) result = replaceGroundObjectsAt(result, s.position, rem);
    result = { ...result, seeds: [...(result.seeds ?? []), ...newSeeds], log: [...result.log, ...rem] };
  }
  // Fire the Ecaflip roll reactions for any coin/dice rolled during death resolution (Shava #367's MORT coin).
  // Applied on the fully-settled state so surviving Sentinelles get +AT/+AR and hand Atout Cachés get −PA.
  for (const side of ["ally", "enemy"] as Side[]) {
    if (rollCounts[side] > 0) result = applyAllyRollReactions(result, side, rollCounts[side]);
  }
  // Posthumous CONTRE COUP of the killed creatures (hit back on the killer / area burst / resource
  // gain), on the cleaned board, like the MORT effects. A hit back that kills in turn goes through
  // resolveDeathsAndWin again, so its victim's contre-coup fires too (a cascade, bounded by the
  // deaths).
  // "Full hand" burn of the cards that went back to the hand in this volley: the same two hooks as the
  // draw burn (addCardToHand), fired once the volley is fully settled. Crasslek's hit back is a
  // consequence of the burn, not of the death, and it can open its own volley.
  if (recoverOverflowBurns > 0 && !result.winner) {
    result = { ...result, creatures: buffOnOverflowDiscard(result.creatures, recoverOverflowBurns) };
    result = damageEnemiesOnOverflowDiscard(result, recoverOverflowBurns);
  }
  if (deadRetaliations.length > 0 && !result.winner) result = applyDeadRetaliations(result, deadRetaliations);
  return result;
}

type DeadRetaliation = {
  atkEffects: Effect[];
  areaEffects: Effect[];
  playerEffects: Effect[];
  killerId: number | undefined;
  caster: Side;
  self: number;
  // The dying creature's card, so it can be taken out of its own discard while its posthumous
  // contre-coup resolves (Prince Belimberbe #1379, see applyDeadRetaliations).
  cardId: number;
  pos: Coords;
};

// Capture (before the removal) the contre-coup of creatures killed by damage. Effects that target
// the creature itself cannot run for a removed creature (runTrigger no longer finds it), so only the
// hit back (targetAttacker), the area burst (L'Enklarveur #534 "1 aux autres invocations") and the
// owner's resource effects (Grine Piz #462 AddSeeds, Momie #360 AddReserve, Yugo #152 tutor…) are
// kept, since they need no living source. The surviving case goes through fireContreCoup.
function collectDeadRetaliations(dying: CreatureInstance[], log: GameEvent[]): DeadRetaliation[] {
  const out: DeadRetaliation[] = [];
  for (const victim of dying) {
    if (!victim.triggers.some((t) => t.trigger === "CONTRE_COUP")) continue;
    const cc = victim.triggers.filter((t) => t.trigger === "CONTRE_COUP").flatMap((t) => t.effects);
    const atkEffects = cc.filter((e) => (e as { targetAttacker?: boolean }).targetAttacker);
    const areaEffects = cc.filter((e) => !(e as { targetAttacker?: boolean }).targetAttacker && !PLAYER_STATE_TYPES.has(e.type));
    const playerEffects = cc.filter((e) => !(e as { targetAttacker?: boolean }).targetAttacker && POSTHUMOUS_PLAYER_STATE_CC.has(e.type));
    if (atkEffects.length === 0 && areaEffects.length === 0 && playerEffects.length === 0) continue;
    let killerId: number | undefined;
    for (let i = log.length - 1; i >= 0; i--) {
      const ev = log[i];
      if (ev.type === "DAMAGE" && ev.targetInstanceId === victim.instanceId && ev.sourceInstanceId != null) { killerId = ev.sourceInstanceId; break; }
    }
    out.push({ atkEffects, areaEffects, playerEffects, killerId, caster: victim.owner, self: victim.instanceId, cardId: victim.cardId, pos: { ...victim.position } });
  }
  return out;
}

// Apply the captured contre-coups on the state that is already cleaned (the dead creature is no
// longer on the board).
function applyDeadRetaliations(state: GameState, rets: DeadRetaliation[]): GameState {
  let result = state;
  for (const r of rets) {
    // Area burst (L'Enklarveur #534) with a ghost source: the creature is removed, so excludeSelf does
    // not apply and AoeDamage{scope:all} hits all living creatures.
    if (r.areaEffects.length > 0) {
      const cs = result.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
      const ds = result.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
      const lg = [...result.log];
      // Seeded rng passed down and stored back: a posthumous contre-coup can carry a random effect (die,
      // random Transform). Without the rng in ctx it fell back to the global generator and broke replay
      // equality.
      const retRng = new Rng(result.rng);
      const lgBefore = lg.length;
      applyEffects(cs, ds, lg, r.areaEffects, { casterSide: r.caster, selfInstanceId: r.self, targetCell: r.pos, diceFloor: result.players[r.caster].diceFloor, rng: retRng });
      result = resolveDeathsAndWin({ ...result, creatures: cs, dofuses: ds, log: lg, rng: retRng.state }, cs, ds, lg, new Set(), new Set(), new Set(), lgBefore);
      if (result.winner) return result;
    }
    // Riposte targetAttacker (Craqueboule #675 / Polter #399 …) contre le tueur.
    if (r.atkEffects.length > 0 && r.killerId != null) {
      result = applyEffectsToAttacker(result, r.atkEffects, r.caster, r.self, r.killerId);
      if (result.winner) return result;
    }
    // The owner's resource effects (seed, AP, draw…): credited to the dying creature's camp, with its
    // death cell as selfCell, same convention as the MORT player-state effects.
    //
    // The posthumous contre-coup resolves before the dying creature "finishes" its death: its own card
    // must not be visible to it. This is the same rule as the MORT effects, which run before the card
    // reaches the discard (deferredDeadDiscards / Indie #454), except that here the discards are already
    // filled, since this contre-coup is applied last (it has to see the cleaned board and can cascade).
    // So its card is taken out of its discard for a moment, then put back if the effect did not use it.
    // Without this, Prince Belimberbe #1379 ("place dans votre main la dernière invocation partie dans
    // votre défausse") picked itself back up instead of the previous invocation.
    if (r.playerEffects.length > 0) {
      const before = result.players[r.caster];
      const di = before.discard.lastIndexOf(r.cardId);
      if (di >= 0) {
        result = { ...result, players: { ...result.players, [r.caster]: { ...before, discard: [...before.discard.slice(0, di), ...before.discard.slice(di + 1)] } } };
      }
      for (const eff of r.playerEffects) {
        if (result.winner) break;
        result = applyPlayerStateEffect(result, eff, r.caster, undefined, r.pos).state;
      }
      if (di >= 0) {
        // Put back in the discard (at the end of the pile: it just arrived there). Skipped if the effect
        // moved it somewhere else in the meantime; the card must never exist twice.
        const after = result.players[r.caster];
        const movedElsewhere = after.hand.includes(r.cardId) && !before.hand.includes(r.cardId);
        if (!movedElsewhere) {
          result = { ...result, players: { ...result.players, [r.caster]: { ...after, discard: [...after.discard, r.cardId] } } };
        }
      }
    }
  }
  return result;
}

// Draw the top card of `side`'s deck into their hand. No-op if empty
// (fatigue rules TBD).
// Cash the whole AP reserve into the current turn's usable AP (1:1). Triggered
// by clicking the reserve tile. No-op if the reserve is empty or it is not that
// side's turn. (Distinct from SpendReserveDouble, which doubles the reserve.)
export function claimReserve(state: GameState, side: Side): GameState {
  if (state.winner || state.activeSide !== side) return state;
  const p = state.players[side];
  if (p.apReserve <= 0) return state;
  return {
    ...state,
    players: { ...state.players, [side]: { ...p, ap: p.ap + p.apReserve, apReserve: 0 } },
    // Log the reserve→AP conversion (the original game's reserve-used event). Without this event, the UI
    // only noticed the claim by diffing the state, which missed it when the AP gained was spent right
    // away (claim grouped with a card), and the opponent then saw nothing change.
    log: [...state.log, { type: "A_P_RESERVE_USED", side, amount: p.apReserve }],
  };
}

// The fake "card" a planted seed stands for: a spell for both purposes:
//   - COST (seedPlantCost): an opponent's "coût augmenté" aura taxes it (Maître Joris #117).
//   - ON_PLAY reactions (plantSeed): "quand vous jouez un sort" fires on a plant.
// cardType "Aoe" is what carries that: cardMatchesCostScope resolves "spell"/"all" to true (and every
// family/cardId/glyph/butin aura to false), and fireOnPlayReactions puts any non-Summon in "spell".
// No families and no rarity, so the reactors filtered by family (Sipho #603/#751) and by rarity
// (Sigrun #917) do not fire.
const SEED_AS_CARD = { id: -1, cardType: "Aoe", families: [], effects: [] } as unknown as Card;

// PA cost to plant one seed from the reserve, right now, for `side`. Base SEED_PLANT_COST plus any
// tax from the opponent's living "cost up" board auras (Maître Joris #117: "le coût des sorts
// adverses est augmenté de 3 PA", which also applies to graines). Deck-based reductions (Wagnar's
// per-card stamps, Cupidité's AddCostModifier) never apply here: a seed is not a deck card, so it is
// never stamped, which is why it does not go through effectiveCost. Only the opponent's cost
// increase is added; own-side board auras are left out on purpose (the ruling is "Joris augmente le
// coût des graines", nothing else).
export function seedPlantCost(state: GameState, side: Side): number {
  const foe = other(side);
  let tax = 0;
  for (const c of state.creatures) {
    if (c.currentLife <= 0 || c.owner !== foe) continue;
    for (const e of getCard(c.cardId)?.effects ?? []) {
      if (e.type !== "CardCostAura") continue;
      const a = e as { scope?: CostScope; amount?: number; family?: string; cardId?: number; enemy?: boolean; setTo?: number; requireReserve?: number };
      if (!a.enemy || a.setTo != null || (a.amount ?? 0) <= 0) continue;
      if (a.requireReserve != null && (state.players[c.owner].apReserve ?? 0) < a.requireReserve) continue;
      const matches = a.cardId != null
        ? SEED_AS_CARD.id === a.cardId
        : a.family
        ? (SEED_AS_CARD.families ?? []).includes(a.family)
        : !!a.scope && cardMatchesCostScope(SEED_AS_CARD, a.scope);
      if (matches) tax += a.amount ?? 0;
    }
  }
  return SEED_PLANT_COST + tax;
}

// Manually plant one seed from `side`'s reserve onto `cell`. Costs SEED_PLANT_COST
// PA and one reserve seed; the planted seed carries `side` as its owner (what its
// walk-over effect keys off). Returns state unchanged (a safe no-op the UI can
// call optimistically) if any precondition fails: not `side`'s turn / game over /
// a pick is pending, an empty reserve or too little PA, or `cell` is not a legal
// seed cell, inside `side`'s own territory (cols 5-8 ally / 1-4 enemy) and free
// of any creature, Dofus, existing seed, or prism.
export function plantSeed(state: GameState, side: Side, cell: Coords): GameState {
  if (state.winner || state.activeSide !== side || state.pendingAction) return state;
  const p = state.players[side];
  const cost = seedPlantCost(state, side); // base 1 + opponent's Maître Joris tax
  if ((p.seedReserve ?? 0) <= 0 || p.ap < cost) return state;
  if (!isAlliedTerritory(cell.x, side)) return state;
  if (state.creatures.some((c) => c.currentLife > 0 && sameCoords(c.position, cell))) return state;
  if (state.dofuses.some((d) => sameCoords(d.position, cell))) return state;
  const seeds: SeedInstance[] = state.seeds ?? [];
  if (cellHasGroundObject(state, cell)) return state; // one object per cell: cannot plant on any occupied ground cell
  // A prism cell is allowed: planting on a prism destroys it without collecting its bonus. So it is not
  // rejected; the prism is just dropped (no activatePrism) when we plant.
  const prismHere = state.prisms.some((pr) => sameCoords(pr.position, cell));
  const prisms = prismHere ? state.prisms.filter((pr) => !sameCoords(pr.position, cell)) : state.prisms;
  // recomputeAuras: planting may have flipped a side from 0 → ≥1 seed, granting
  // any ConditionalSeedProperty (Kolo Kolko's Initiative + Untargetable).
  let result = recomputeAuras({
    ...state,
    players: {
      ...state.players,
      [side]: { ...p, seedReserve: (p.seedReserve ?? 0) - 1, ap: p.ap - cost },
    },
    seeds: [...seeds, { position: { ...cell }, owner: side }],
    prisms, // a prism on this cell was just dropped (no bonus), see above
    log: [
      ...state.log,
      { type: "SEED_PLANTED", at: { ...cell }, ownerSide: side },
      { type: "ACTION_POINTS_USED", side, amount: cost },
    ],
  });
  // Destroying that prism (by any means) charges ON_PRISM reactors (Lilotte #579).
  if (prismHere) result = fireOnPrismReactions(result);
  // Planting a seed is playing a card, and a spell one, same reading as on the cost side. So both the
  // untyped reactors (Lilotte #444 charges, Ertan Knapz #1854 damages itself, the opponent's Miss Nuit
  // #382 banks a PA) and the "quand vous jouez un sort" ones fire: Angèle #1257 heals, Crapaud Mufle
  // #238 grows, Emma Zone #1866 shoots, Magislek #466 stings, and Tama Hok #878 dies. Only the reactors
  // filtered on "invocation" stay silent (Piou #446, Lilotte #569), plus family (Sipho) / rarity
  // (Sigrun): SEED_AS_CARD has neither.
  // Fires last, once the seed is on the board: same order as a card play, whose own effect settles
  // before bystanders react.
  if (!result.winner) result = fireOnPlayReactions(result, side, SEED_AS_CARD);
  return result;
}

// Draw the top card of `fromSide`'s deck into `toSide`'s hand. Usually the two are the same (a normal
// draw); they differ for the cross-draw cards (Echaenge, Bowne Piauch, "chaque joueur pioche chez son
// adversaire"), where you draw from the opponent's pile. Empty source deck → does nothing. The hand
// cap burn sends the card straight to the drawer's (toSide) discard.
// Fatigue (empty deck, rule 11): when a player must draw from their own empty deck, each of their
// Dofus is revealed then takes 1 damage, once per missed card (the caller loops one drawCard per
// card, so N missed draws = N hits). Goes through woundDofus (so it breaks a Sinistro, is mirrored by
// #406, feeds Julith #352, and counts toward capture/win). Reveal + damage happen in sweep order, the
// fatigued side's own L1→L5 (ally y going up; enemy mirrored, y going down). Invulnerable Dofus
// (Artheon #1424 / Orbe Doré #594) are still revealed but take no damage.
function applyFatigue(state: GameState, side: Side): GameState {
  if (state.mulligan) return state; // never during the pre-game redraw (decks are full then anyway)
  const creatures = state.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
  const dofuses = state.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
  const log: GameEvent[] = [...state.log, { type: "NO_MORE_CARD_TO_DRAW", side }];
  const order = dofuses
    .filter((d) => d.owner === side && d.currentLife > 0)
    .sort((a, b) => (side === "ally" ? a.position.y - b.position.y : b.position.y - a.position.y));
  let any = false;
  for (const d of order) {
    if (!d.revealed) { d.revealed = true; log.push({ type: "DOFUS_REVEALED", at: { ...d.position }, kind: d.kind }); }
    if (dofusInvulnerable(d, creatures)) continue; // invulnerable → revealed but no fatigue damage
    woundDofus(d, 1, log, creatures, dofuses);
    any = true;
    if (d.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", dofusAt: { ...d.position } });
    else log.push({ type: "DAMAGE", targetCell: { ...d.position }, damage: 1 });
  }
  const next: GameState = { ...state, creatures, dofuses, log };
  return any ? resolveDeathsAndWin(next, creatures, dofuses, log, new Set()) : next;
}

export function drawCardFrom(state: GameState, toSide: Side, fromSide: Side): GameState {
  const from = state.players[fromSide];
  if (from.deck.length === 0) {
    // Deck-out: a self draw from your own empty deck triggers fatigue (rule 11); a cross-draw from
    // an empty opponent deck just fizzles (it is not your pile, so no fatigue lands).
    return fromSide === toSide ? applyFatigue(state, toSide) : state;
  }
  const deck = [...from.deck];
  const drawn = deck.pop()!;
  // Deck cost-mod aligned with the deck (HORDE discount accrued while in the
  // deck), pop the drawn card's mod off the same end. Falls back to zeros when
  // absent or length-mismatched, so a stale array can never misalign.
  const fromMods = from.deckCostMods && from.deckCostMods.length === from.deck.length
    ? [...from.deckCostMods] : from.deck.map(() => 0);
  const drawnMod = fromMods.pop() ?? 0;
  const to = state.players[toSide];
  // When source = destination we must read `to` after popping the deck, so build
  // the to-side patch from the same `from` object in that case.
  const toBase = fromSide === toSide ? { ...to, deck, deckCostMods: fromMods } : to;
  const overflowing = toBase.hand.length >= MAX_HAND;
  // Your own draw keeps the discount the card accrued in your deck; a STOLEN card
  // (cross-draw) enters the thief's hand at normal cost (the HORDE discount is the
  // original owner's).
  const drawnHandMod = fromSide === toSide ? drawnMod : 0;
  const hand = overflowing ? toBase.hand : [...toBase.hand, drawn];
  const handCostMods = overflowing ? toBase.handCostMods : [...toBase.handCostMods, drawnHandMod];
  // A burned card (drawn into a full hand) is discarded, to the inaccessible
  // tokenDiscard if it is a token, else the normal pile.
  const burnToToken = overflowing && isToken(drawn);
  const discard = overflowing && !burnToToken ? [...toBase.discard, drawn] : toBase.discard;
  const tokenDiscard = burnToToken ? [...(toBase.tokenDiscard ?? []), drawn] : toBase.tokenDiscard;
  const players = { ...state.players };
  if (fromSide !== toSide) players[fromSide] = { ...from, deck, deckCostMods: fromMods };
  players[toSide] = { ...toBase, hand, handCostMods, discard, tokenDiscard };
  const next: GameState = {
    ...state,
    players,
    // Nain Patraque #965: a card burned by a full hand (overflowing) buffs every holder.
    creatures: overflowing ? buffOnOverflowDiscard(state.creatures, 1) : state.creatures,
    log: [...state.log, { type: "CARD_DRAWN", side: toSide, cardId: drawn, burned: overflowing }],
  };
  // Crasslek #355: the same burn makes every holder hit the enemy summons.
  return overflowing ? damageEnemiesOnOverflowDiscard(next, 1) : next;
}

// Reactive ON_DRAW ("gagne +N quand vous piochez une carte", Phorreur Furieux):
// after `side` draws, each of their living creatures with an ON_DRAW trigger fires
// its self effect. The module flag blocks re-entry (an ON_DRAW effect that itself
// draws will not cascade); it is transient (reset in `finally`), so it never leaks
// across top-level operations and reproducibility is unaffected.
let firingDrawReactions = false;
function fireDrawReactions(state: GameState, side: Side): GameState {
  if (firingDrawReactions) return state;
  const reactorIds = state.creatures
    .filter((r) => r.currentLife > 0 && r.owner === side && r.triggers.some((t) => t.trigger === "ON_DRAW"))
    .map((r) => r.instanceId);
  if (reactorIds.length === 0) return state;
  firingDrawReactions = true;
  let after = state;
  try {
    for (const rid of reactorIds) {
      after = runTrigger(after, "ON_DRAW", rid);
      if (after.winner) break;
    }
  } finally {
    firingDrawReactions = false;
  }
  return after;
}

export function drawCard(state: GameState, side: Side): GameState {
  // Hand-cap rule: if the player is already at MAX_HAND, the drawn card is
  // "burned", straight to the discard pile (handled in drawCardFrom). Original
  // Krosmaga behavior; prevents infinite hand stuffing.
  return fireDrawReactions(drawCardFrom(state, side, side), side);
}

/**
 * A card leaves the deck for the hand through an effect (Oropo tutor, Abigaël's filtered draw…).
 * These effects used to put the card in the hand directly, without logging anything: the replay saw
 * nothing pass, so there was no animation and the card appeared in the hand all at once.
 *
 * We log the same event as a normal draw, so the flight from the deck and the arrival in the hand
 * are replayed the same way.
 *
 * This is a display event. It does not trigger the "quand vous piochez" reactions (Phorreur
 * Furieux…): those stay with drawCard() through fireDrawReactions, since a tutor is not a draw for
 * the rules.
 * `burned`: the hand was full and the card goes straight to the discard (addCardToHand handles it),
 * so the flight stops above the deck.
 */
function logDeckToHand(state: GameState, side: Side, cardId: number): GameState {
  const burned = state.players[side].hand.length >= MAX_HAND;
  return { ...state, log: [...state.log, { type: "CARD_DRAWN", side, cardId, burned }] };
}

/**
 * A created card lands in the hand (Fléau prism…). It comes out of no pile: the original game gives
 * it its own move (0.30 s in one go, against 0.70 s for a real draw). With no event in the log, it
 * appeared without any animation.
 * Full hand: addCardToHand sends it to the discard, so there is nothing to animate toward the hand.
 */
function logCardCreatedInHand(state: GameState, side: Side, cardId: number, at?: Coords): GameState {
  if (state.players[side].hand.length >= MAX_HAND) return state;
  // `at`: the cell of the ground object that produced the card (Butin reward); the replay moves the
  // card flight to the moment of the pickup.
  return { ...state, log: [...state.log, { type: "CARD_MOVED", cardId, from: "nowhere", to: "hand", side, ...(at ? { at: { ...at } } : {}) }] };
}

// Validation helper, returns null if the play is legal, or a human-readable
// reason if not. Separate from playCard so the UI can gray out illegal plays.
export function canPlayCard(
  state: GameState,
  card: Card,
  target: Coords,
  // The hand slot the player selected. The AP check uses that copy's cost, so it matches what
  // playCard will really spend. Omitted → cheapest slot.
  handIndex?: number,
): string | null {
  if (state.winner) return "La partie est terminée.";
  const side = state.activeSide;
  const player = state.players[side];
  if (!player.hand.includes(card.id)) return "Carte absente de la main.";
  // Repos Éternel #20 ("ne dépensez pas de PA … à la place bannissez"): while the flag is up, the cost
  // is paid by banishing discard cards, not AP, so the AP check is skipped (the discard size
  // requirement is enforced with the banish check below).
  const priceSlot = resolveHandSlot(player, card.id, handIndex);
  if (!player.discardPaysCost && player.ap < effectiveCost(player, card, state.creatures, priceSlot >= 0 ? priceSlot : undefined, state.glyphs, { ally: state.players.ally.apReserve, enemy: state.players.enemy.apReserve })) return "Pas assez d'AP.";
  // Radoris Montrouge #489: an extra cost paid from the reserve ("Dépense 1 PA de votre
  // réserve pour être invoqué"), unplayable without enough reserve AP.
  if (card.reserveCost != null && (player.apReserve ?? 0) < card.reserveCost) return "Pas assez de PA en réserve.";
  // Heure de Gloire (#296) and Désynchronisation (#377) are 0-cost spells that turn your remaining AP
  // into a buff (+1 AT/AR per AP) / into damage (1 per AP); Gelure (#170) turns them into reserve AP.
  // With 0 AP they would do nothing, so none of them can be cast at all. The original game marks these
  // cards AllAPConsumption and needs actionPoints != 0 to play them.
  if (card.effects.some((e) => e.type === "SpendApAsBuff" || e.type === "SpendApAsDamage" || e.type === "TransferApToReserve") && player.ap <= 0) {
    return "Aucun PA à dépenser.";
  }
  // Same original rule (AllAPConsumption) for the summon variant, Radoris
  // Montrouge #489, whose APPARITION converts your remaining AP into +AT/+AR:
  // at 0 PA the card is unplayable outright, even though its printed cost is 0
  // and the reserve could still pay its reserveCost.
  if (
    (card.triggers ?? []).some((t) => t.effects.some((e) => e.type === "SpendApAsBuff" || e.type === "SpendApAsDamage")) &&
    player.ap <= 0
  ) {
    return "Aucun PA à dépenser.";
  }
  // Sablier de Xélor #212 (SpendReserveDouble) / Rollback #376 (SpendReserveCharge) burn the whole
  // reserve as their fuel: with an empty reserve the original game greys them out (a
  // ReserveAPConsumption secondary cost needs a non-empty reserve).
  if (card.effects.some((e) => e.type === "SpendReserveDouble" || e.type === "SpendReserveCharge") && (player.apReserve ?? 0) <= 0) {
    return "Aucun PA en réserve.";
  }
  // Seed-transform spells (Graines de Folie/Sacrifice, Botanique…) can only be cast when the caster
  // owns at least one planted seed to transform: the spell cannot be played with no seed (the Summon
  // variants, Li Crounch etc., stay playable and their APPARITION just does nothing; they carry the
  // transform in their triggers, not effects[], so this check skips them).
  if (
    (card.cardType === "Spell" || card.cardType === "Aoe") &&
    card.effects.some((e) => e.type === "TransformAllSeeds" || e.type === "TransformSeed" || e.type === "TransformSeedToBush") &&
    !(state.seeds ?? []).some((s) => s.owner === side)
  ) {
    return "Aucune graine à transformer.";
  }
  // Corruption (TransformAllButins), same rule for Butins: unplayable with none
  // of yours on the board (mirrors the seed gate above).
  if (
    (card.cardType === "Spell" || card.cardType === "Aoe") &&
    card.effects.some((e) => e.type === "TransformAllButins") &&
    !(state.butins ?? []).some((b) => b.owner === side)
  ) {
    return "Aucun Butin à transformer.";
  }
  // Remaniement (BounceGlyphs), unplayable when the caster owns no glyph to
  // bounce (mirrors the seed / butin gates above; the game greys it out then).
  if (
    card.effects.some((e) => e.type === "BounceGlyphs") &&
    !(state.glyphs ?? []).some((g) => g.owner === side)
  ) {
    return "Aucun Glyphe à remonter.";
  }
  // Tofu Mutant (#301): its APPARITION sacrifices an allied Tofu and that is its whole purpose, so the
  // card cannot be played without an allied Tofu on the board. Only the sacrifice restricted to a
  // family blocks the play; the generic Sacrifice (Tartanque #154, no family) stays playable and just
  // does nothing with no target. The effect is on the APPARITION trigger, so look there, not in
  // card.effects.
  const sacFam = (card.triggers ?? []).flatMap((t) => t.effects ?? []).find(
    (e) => e.type === "Sacrifice" && (e as { family?: string }).family,
  ) as { family?: string } | undefined;
  if (
    sacFam?.family &&
    !state.creatures.some((c) => c.currentLife > 0 && c.owner === side && (famsOf(c)).includes(sacFam.family!))
  ) {
    return `Aucun ${sacFam.family} allié à sacrifier.`;
  }
  // Embaumement #1460 (SacrificeForReserve): sacrifices one of your creatures, so the card cannot be
  // played without an allied creature on the board (otherwise it could be cast on a Dofus / empty cell
  // for no effect). validateSpellTarget then forces the click onto an ally.
  if (
    card.effects.some((e) => e.type === "SacrificeForReserve") &&
    !state.creatures.some((c) => c.currentLife > 0 && c.owner === side)
  ) {
    return "Aucune invocation alliée à sacrifier.";
  }
  // Two-step spells with "a cost on an ally, then an optional effect on a 2nd target" (Sacrifice #576,
  // Lame Émoussée #1177, Pluie de Météorites #1350): all are CanCastWithNoSecondaryTarget=true, so they
  // only need the ally (cost) target to be playable. The 2nd pick always opens afterwards and must be
  // clicked to finish, even with no valid 2nd target (the spell is never cast until you click
  // somewhere). So the only playability check is "an allied creature exists".
  if (
    card.effects.some((e) => e.type === "SacrificeForDamage" || e.type === "LameEmoussee" || e.type === "DestroyArmorForDamage") &&
    !state.creatures.some((c) => c.currentLife > 0 && c.owner === side)
  ) {
    return "Aucune invocation alliée à cibler.";
  }
  // Pampactus #218 (DamageAllyToSummon, APPARITION): "infligez 1 dégât à une invocation alliée pour
  // l'invoquer". Cannot be played without an existing allied creature to pay the cost on
  // (CanCastWithNoSecondaryTarget=false). The pick then forces the click onto an allied creature.
  if (
    (card.triggers ?? []).some((t) => t.effects.some((e) => e.type === "DamageAllyToSummon")) &&
    !state.creatures.some((c) => c.currentLife > 0 && c.owner === side)
  ) {
    return "Aucune invocation alliée à blesser pour l'invoquer.";
  }
  // "Bannit les N dernières cartes parties dans votre défausse pour …" (Sram): cannot be played unless
  // the caster's discard holds at least N cards to banish. The banish itself happens in playCard.
  const banishCost = card.effects.find((e) => e.type === "BanishDiscard") as { count: number } | undefined;
  // Cards to banish from the discard: the BanishDiscard requirement PLUS, under
  // Repos Éternel, this card's whole cost (paid in banished cards instead of AP).
  const banishNeeded = (banishCost ? banishCost.count | 0 : 0)
    + (player.discardPaysCost ? effectiveCost(player, card, state.creatures, undefined, state.glyphs, { ally: state.players.ally.apReserve, enemy: state.players.enemy.apReserve }) : 0);
  if (banishNeeded > 0 && player.discard.length < banishNeeded) {
    return "Pas assez de cartes dans votre défausse à bannir.";
  }

  if (card.cardType === "Summon") {
    // Single source of TRUTH for "where can this be summoned": validSpawnCells
    // (queries.ts). It covers the spawn zone (+ Bastion extension), walls (anywhere
    // in the allied territory), and the allied Buisson / Butin / Tas d'Os summon
    // points, and, crucially, it EXCLUDES the Dofus base cells, which stay
    // non-summonable even once the Dofus there has been destroyed.
    //
    // This used to be a second, hand-rolled copy of that logic, and the copy had
    // drifted: it was missing the Dofus-cell exclusion (a free, destroyed-Dofus
    // cell passed isCellFree, and the Bastion-extended zone reaches the back wall
    // column). The human UI never offered those cells (it highlights via
    // validSpawnCells), but the AI gates its moves through canPlayCard, so it could
    // summon onto a destroyed Dofus cell. Delegating here keeps the two in lock step.
    if (!validSpawnCells(state, side, card).some((c) => sameCoords(c, target))) {
      return isCellFree(state, target) ? "Case hors zone de pose." : "Case occupée.";
    }
    return null;
  }

  if (card.cardType === "Spell" || card.cardType === "Aoe") {
    return validateSpellTarget(state, card, target);
  }

  // Dofus / GameRules cards are not player-castable like normal spells,
  // they are board state. Allow for now (UI should not expose them).
  return null;
}

// Validate that `target` is a legal cast cell for the given spell. We
// do not have the original game's full `castTarget` logic yet, just
// the most common cases:
//   - Spells that deal damage (DamageData in effects) require the
//     target to contain something damageable (a creature or Dofus).
//   - Spells that set a property require the target to contain
//     a creature (Dofus property changes not modeled yet).
//   - Other spells (buff zones, AoE on empty cells, …) pass for now.
// Returns null if OK, else an error string.
function validateSpellTarget(
  state: GameState,
  card: Card,
  target: Coords,
): string | null {
  // Board bounds, already mostly impossible because cells are only
  // emitted in [0, BOARD_COLS) × [0, BOARD_ROWS) but defensive guard.
  if (target.x < 0 || target.x >= BOARD_COLS || target.y < 0 || target.y >= BOARD_ROWS) {
    return "Case hors plateau.";
  }
  // Generic castTargets tied to a cell: "Cell" (Ronces Multiples #172, Tremblement de Terre #231, Épée
  // Céleste #631, Pelle Sismique #1104, Mot Protecteur #1395), "AnyColumn" (Creusée #783, Trêve #1269,
  // Mise en Garde #1306, Incision #1417) and "AnyRow" (Éventrail #232, Ronces Agressives #439): the
  // original game only offers the battlefield cells (columns 1 to 8), so the two Dofus columns (0 and
  // 9) can never be selected.
  const ctCell = card.castTarget ?? "";
  if ((ctCell === "Cell" || ctCell === "AnyColumn" || ctCell === "AnyRow") && (target.x === 0 || target.x === BOARD_COLS - 1)) {
    return "Les colonnes des Dofus ne peuvent pas être ciblées.";
  }
  const hasDamage = card.effects.some((e) => e.type === "DamageData");
  const hasSetProperty = card.effects.some((e) => e.type === "SetPropertyData");
  // Authored effects that operate on a chosen creature also require one
  // under the cursor (Soigne / Détruit / Confère +AT à une invocation).
  const needsCreature = card.effects.some(
    (e) =>
      // An AoE-scoped stat effect hits a whole side → no creature pick needed.
      !(e as { scope?: string }).scope &&
      (e.type === "Heal" ||
        e.type === "Destroy" ||
        e.type === "BoostAttack" ||
        e.type === "BoostArmor" ||
        e.type === "Charge" ||
        e.type === "SetMovement" ||
        e.type === "SetAttack" ||
        e.type === "Teleport" ||
        e.type === "TakeControl" ||
        e.type === "ReturnToHand" ||
        e.type === "ReturnToDeck" ||
        e.type === "TriggerAttack" ||
        e.type === "BoostRange" ||
        e.type === "SwapAttack" ||
        e.type === "SwapArmor" ||
        e.type === "ChangeRow" ||
        e.type === "SwapPosition" ||
        e.type === "HealFull" ||
        e.type === "SetLife" ||
        e.type === "SetRange" ||
        e.type === "MultiplyAttack" ||
        e.type === "Transform" ||
        e.type === "TransformIntoSeed" ||
        e.type === "TransformIntoButin" ||
        e.type === "SpendApAsBuff" ||
        e.type === "SpendApAsDamage" ||
        e.type === "SacrificeForReserve" || // Embaumement #1460: must click one of your creatures (not a Dofus / empty cell)
        e.type === "ProtectDofus" || // Lien de Sang #1495: 1st pick must be an ally creature (else the link has no guard → the spell fizzles)
        e.type === "TeleportToCell" || // Téléportation #119: 1st pick must be a summon (the AlliedBoardSide check then limits it to your camp); an empty/Dofus cell is not a valid cast
        e.type === "SacrificeForDamage" || // Sacrifice #576: 1st pick must be an ally creature (the one sacrificed)
        e.type === "LameEmoussee" || // Lame Émoussée #1177: 1st pick must be an ally creature (the one damaged for 1)
        e.type === "DestroyArmorForDamage" || // Pluie de Météorites #1350: 1st pick must be an ally creature (armour destroyed)
        (e.type === "SetProperty" && !(e as { self?: boolean }).self)),
  );
  // Two-target swaps also need a second creature to exchange with.
  const isSwap = card.effects.some((e) => e.type === "SwapAttack" || e.type === "SwapArmor" || e.type === "SwapPosition");
  if (isSwap && state.creatures.filter((c) => c.currentLife > 0).length < 2) {
    return "Il faut deux invocations.";
  }
  const creature = creatureAt(state, target);
  const dofus = dofusAt(state, target);
  // Mot Reconstituant #491 (castTarget "SummonOrDofus"): heals a creature or a
  // Dofus, so the click may land on either. Handled before the Dofus-only branch
  // below (which would otherwise match on the "Dofus" substring and reject a
  // creature target). The Heal effect itself routes to whichever the cell holds.
  const ctDofus = card.castTarget ?? "";
  if (ctDofus === "SummonOrDofus") {
    if (!creature && !dofus) return "Aucune cible sur cette case.";
    return null;
  }
  // Dofus-only spells (Fléau → castTarget "AnyDofus"): may only hit a Dofus,
  // never a creature, even though they carry DamageData. "Allied/Opponent"
  // prefixes restrict the side; "Any" hits either (allied and enemy Dofus).
  if (ctDofus.includes("Dofus")) {
    if (!dofus) return "Ce sort ne peut viser qu'un Dofus.";
    if (ctDofus.startsWith("Allied") && dofus.owner !== state.activeSide) {
      return "Ce Dofus n'est pas allié.";
    }
    if (ctDofus.startsWith("Opponent") && dofus.owner === state.activeSide) {
      return "Ce Dofus n'est pas ennemi.";
    }
    // Sinistro #215 / Nécronomigore #700 (AlliedDofusWithoutEquipement): the host Dofus must carry no equipment yet.
    if (ctDofus === "AlliedDofusWithoutEquipement" && dofusHasEquipment(dofus)) {
      return "Ce Dofus a déjà un équipement.";
    }
    // "…WithoutInvulnerable" (Punition #189 / Refus de Mort #248, "Sacrifiez un de
    // vos Dofus …"): an invulnerable Dofus (Artheon #1424 / Orbe Doré #594) cannot be
    // picked as the sacrifice.
    if (ctDofus.includes("WithoutInvulnerable") && dofusInvulnerable(dofus, state.creatures)) {
      return "Ce Dofus est invulnérable.";
    }
    return null;
  }
  // General rule: damage never applies to Dofus unless the card says so, and that case (castTarget
  // Dofus) already returned above. So a generic damage spell needs a creature on the cell; a Dofus (or
  // empty) cell is not a valid target.
  if (hasDamage && !creature) {
    return "Aucune cible sur cette case.";
  }
  // A castTarget "…Summon…" (AlliedSummon, OpponentSummon, AnySummon…) says that the target is an
  // invocation: the click must land on a creature, whatever the card's effects. Without this, a spell
  // none of whose effects is in the needsCreature list above could be cast on an empty cell (or a
  // Dofus) and was used up for nothing (Esquive #239, PushData only). Also concerns #312 Flèche de
  // Recul, #537 Fiole de Frayeur, #1014 Ralliement, #1735 Téléglyphe (1st pick), #1439 Gangraîne: all
  // say "une invocation" in their text. "SummonOrDofus" already returned above; "EmptyAlliedSpawnCells"
  // contains "Spawn", not "Summon", so the spells that place a token are not affected.
  const needsSummonTarget = ctDofus.includes("Summon");
  if ((hasSetProperty || needsCreature || needsSummonTarget) && !creature) {
    return "Aucune créature à cibler.";
  }
  // SummonToken spells (Lapinos, …) drop creatures onto the board, so they can
  // only be cast on a cell where you could place a creature normally, i.e. a
  // free cell in your spawn zone. This makes the UI highlight exactly those
  // cells and blocks casting anywhere else.
  const summonsTokens = card.effects.some((e) => e.type === "SummonToken");
  // A global SummonToken spell (Lapinos #291, castTarget AlliedGod) is cast on the god through the
  // "effet global" box. Its tokens place themselves on the first départ rank (summonTokens), so there
  // is no board target to check. Clicking a départ cell must not cast it; the UI offers no board
  // target for it. Other (non-global) SummonToken spells still need a spawn cell.
  if (summonsTokens && (card.castTarget ?? "") !== "AlliedGod") {
    const onSpawn = validSpawnCells(state, state.activeSide).some((c) => sameCoords(c, target));
    if (!onSpawn) {
      return "Vous ne pouvez poser des invocations que sur vos cases de pose.";
    }
  }
  // Seed-transform spells (Botanique) target one of your planted seeds, the
  // clicked cell must carry a seed you own (the UI then highlights exactly those
  // cells; the no-seed case is already blocked upstream in canPlayCard).
  if (card.effects.some((e) => e.type === "TransformSeed" || e.type === "TransformSeedToBush")) {
    const onOwnSeed = (state.seeds ?? []).some((s) => s.owner === state.activeSide && sameCoords(s.position, target));
    if (!onOwnSeed) return "Choisissez une de vos graines à transformer.";
  }
  // GLYPHE spells (castTarget EmptyAlliedCells) drop a rune on a cell of your own camp with no
  // creature/Dofus. A glyph already on the cell is allowed: the new glyph replaces it ("on peut poser
  // un glyphe sur un glyphe, ça supprime l'ancien"). The card data agrees: glyph cards are tagged
  // EmptyAlliedCells, not EmptyAlliedCellsWithNoAOE (the value that would block an existing AOE). The
  // replacement itself is handled in the PlaceGlyph effect.
  if (card.effects.some((e) => e.type === "PlaceGlyph")) {
    if (!isAlliedTerritory(target.x, state.activeSide)) return "Le Glyphe doit être posé dans votre camp.";
    if (creature || dofus) return "Case occupée.";
  }
  // Bombe #101 (castTarget EmptyAlliedCells, PlaceTrap): the trap goes on a cell of
  // your own camp with no creature/Dofus, same enum as the glyphs, so an existing
  // board object on the cell is allowed (the trap coexists; walk-over resolves each).
  if (card.effects.some((e) => e.type === "PlaceTrap")) {
    if (!isAlliedTerritory(target.x, state.activeSide)) return "Le piège doit être posé dans votre camp.";
    if (creature || dofus) return "Case occupée.";
  }
  // Tas d'Os card #691 (castTarget EmptyAlliedCells), an empty cell of your camp
  // (no creature / Dofus / existing Tas d'Os). A prism on the cell is allowed: the
  // placement destroys it (handled in the PlaceTasDOs effect).
  if (card.effects.some((e) => e.type === "PlaceTasDOs")) {
    if (!isAlliedTerritory(target.x, state.activeSide)) return "Le Tas d'Os doit être posé dans votre camp.";
    if (creature || dofus) return "Case occupée.";
    if ((state.tasDOs ?? []).some((t) => sameCoords(t.position, target))) return "Il y a déjà un Tas d'Os ici.";
  }
  // Butin cards (castTarget EmptyAlliedCells, #789 / Trouvaille #1382) drop a
  // treasure on an empty cell of your own camp, no creature / Dofus / butin there.
  // Pelle Sismique #1104 (PlaceButin with onTargetCell) is EXEMPT: it is cast on any
  // cell of the board (enemy side included) and the butin's placement is resolved by
  // the effect handler, not gated here.
  const butinPlace = card.effects.find((e) => e.type === "PlaceButin") as { onTargetCell?: boolean } | undefined;
  if (butinPlace && !butinPlace.onTargetCell) {
    if (!isAlliedTerritory(target.x, state.activeSide)) return "Le Butin doit être posé dans votre camp.";
    if (creature || dofus) return "Case occupée.";
    if ((state.butins ?? []).some((b) => sameCoords(b.position, target))) return "Il y a déjà un Butin ici.";
  }
  // Side restriction from the card's own castTarget (the game's targeting
  // data). "Allied*Summon*" spells (Force de Iop, Jabs allié) may only hit
  // your own invocations; "Opponent*Summon*" only the foe's. "Any*Summon*"
  // and non-creature targets impose no side constraint here.
  if (creature) {
    const ct = card.castTarget ?? "";
    if (ct.includes("Summon")) {
      if (ct.startsWith("Allied") && creature.owner !== state.activeSide) {
        return "Cette invocation n'est pas alliée.";
      }
      if (ct.startsWith("Opponent") && creature.owner === state.activeSide) {
        return "Cette invocation n'est pas ennemie.";
      }
      // "Wounded" target (e.g. Fin de la Souffrance → AlliedWoundedSummon)
      // can only pick a creature that has taken damage.
      if (ct.includes("Wounded") && creature.currentLife >= creature.baseLife) {
        return "Cette invocation n'est pas blessée.";
      }
      // "WithRange" target (Oeil de Lynx → AnySummonWithRange) needs a shooter;
      // "…GreaterThan1" (Tireur d'élite) needs range ≥ 2 (so −1 leaves ≥ 1).
      if (ct.includes("WithRange")) {
        const min = ct.includes("GreaterThan1") ? 2 : 1;
        if (creature.range < min) return "Cette invocation n'a pas assez de portée.";
      }
      // Family-restricted target: "Allied<Family>Summon" (e.g. AlliedEnutrofSummon
      // → Transphorzerker "un de vos Enutrofs"). The middle token names a family;
      // the picked creature must belong to it. We only enforce when the token is a
      // real family key (so non-family modifiers like "Wounded" are left alone).
      const fam = ct.match(/^(?:Allied|Opponent|Any)([A-Z][A-Za-z]+)Summon$/);
      if (fam && isKnownFamily(fam[1]) && !(famsOf(creature)).includes(fam[1])) {
        return `Cette invocation n'est pas de la famille ${fam[1]}.`;
      }
      // Exact-attack target ("…SummonEqual3AT" → Fiole de Psykoz): the creature's
      // attack must equal N exactly (distinct from the ≤ caps used elsewhere).
      const eq = ct.match(/SummonEqual(\d+)AT/);
      if (eq && creature.currentAttack !== parseInt(eq[1], 10)) {
        return `Cette invocation n'a pas exactement ${eq[1]} AT.`;
      }
      // "…ThatCanCharge" (Rafale #204 / Charge #427/#749 / Potion de Vélocité #440 / Autorité #486): in the
      // original game CanCharge is exactly !Statue && !Stunned && !Rooted, so a Mur, an Assommé or an
      // Enraciné cannot be picked at all. PM are not tested: a creature with summoning sickness or 0 PM
      // stays targetable (the charge is a bonus that does not depend on PM). Rooted can come from an aura
      // (Arakne à Crochets #1457 RootAllAura), so read the aura view, not the raw properties.
      if (ct.includes("ThatCanCharge")) {
        const p = withAuras(state.creatures).find((c) => c.instanceId === creature.instanceId)?.properties ?? creature.properties;
        if (p.has("Statue") || p.has("Stunned") || p.has("Rooted")) {
          return "Cette invocation ne peut pas charger.";
        }
      }
      // "…ButStatue" (Fulgurance #14 / Bond #429 / Bond du Félin #472): any allied
      // summon except a Mur (Statue).
      if (ct.includes("ButStatue") && creature.properties.has("Statue")) {
        return "Un Mur ne peut pas être ciblé.";
      }
      // "…InAlliedBoardSide" / "…InSummonAlliedBoardSide" (Téléportation #119 "une invocation située dans
      // VOTRE camp" / Détournement #134): the picked creature must stand in the caster's own half; its
      // owner may still be either side for the Any… variant (#119 can grab an enemy creature that crossed
      // over).
      if (ct.includes("AlliedBoardSide") && !isAlliedTerritory(creature.position.x, state.activeSide)) {
        return "Cette invocation n'est pas dans votre camp.";
      }
      // "…WithoutDamageReflection" (Lien de Sang #1495): "DamageReflection" is the original game's
      // protection link (one creature protects, the other is protected; the GARDE DU CORPS of Silas #320
      // uses the very same link). The original excludes a creature holding either role, so three
      // exclusions here: already guarding a living Dofus (Lien de Sang), currently protected by a living
      // garde du corps, or currently being someone's garde du corps.
      if (ct.includes("WithoutDamageReflection")) {
        const inLink =
          state.dofuses.some((d) => d.currentLife > 0 && d.protectedBy === creature.instanceId) ||
          (creature.protectedByGuard != null && state.creatures.some((cr) => cr.instanceId === creature.protectedByGuard && cr.currentLife > 0)) ||
          state.creatures.some((cr) => cr.currentLife > 0 && cr.protectedByGuard === creature.instanceId);
        if (inLink) return "Cette invocation est déjà dans un lien de protection.";
      }
    }
  }
  // Inciblable (Untargetable): the creature cannot be chosen as a single target by any spell, its own
  // controller's too, not only the opponent's ("inciblable concerne aussi bien l'adversaire que moi").
  // Zone/scoped effects still affect it (that is not "targeting"); only this single-target pick is
  // blocked.
  if (creature && creature.properties.has("Untargetable")) {
    return "Cette créature est intargetable.";
  }
  return null;
}

// Play a card from the active player's hand. Target is the spawn cell for
// Summons. For Spells, it is the cell/creature being targeted (not wired yet).
export function playCard(
  state: GameState,
  card: Card,
  target: Coords,
  opts?: { commitHeld?: boolean; heldButinCells?: Coords[]; handIndex?: number },
): GameState {
  const err = canPlayCard(state, card, target, opts?.handIndex);
  if (err) throw new Error(`playCard: ${err}`);
  const side = state.activeSide;
  const player = state.players[side];

  // Two-click spells: the first pick must not commit the play. The spell counts as "résolu et joué"
  // only once its mandatory second pick lands. So a held pending is parked that carries nothing but the
  // pick itself: no AP paid, card still in hand, nothing logged, no ON_PLAY reaction fired.
  // resolvePendingAction enters playCard again with `commitHeld` to commit the whole cast in one step;
  // clicking a cell without a valid 2nd target, clicking the 1st pick again, or clicking off the board
  // simply takes it back. Exempt:
  //   - the optional-secondary trio (Sacrifice #576 / Lame Émoussée #1177 / Pluie de Météorites
  //     #1350): their 1st pick pays a committed cost and declining on the board settles them; they
  //     keep the committed parking in castSpell;
  //   - a mandatory pick with zero valid 2nd targets: the cast must fizzle (used up, nothing happens),
  //     through the normal committed path below;
  //   - deferred summons (NÉCROME / PHORZERKER / FRATRIE / targeted APPARITION): already held and
  //     cancellable through summonAfter (unchanged).
  const spellish = card.cardType === "Spell" || card.cardType === "Aoe";
  if (spellish && !opts?.commitHeld) {
    const pendingPick = twoStepPending(card, target, side);
    if (pendingPick && !pendingPick.optional) {
      const held: GameState = {
        ...state,
        pendingAction: {
          ...pendingPick,
          prompt: `${pendingPick.prompt.replace(/\.$/, "")} — cliquez ailleurs pour annuler.`,
          heldSpell: { cardId: card.id },
        },
      };
      if (validPendingTargets(held).length > 0) return held;
      // Zero valid 2nd targets → fall through: the committed cast fizzles.
    }
    // Trouvaille #1382 (« posez N butins ») is a mandatory MULTI-click pick: same held
    // rule. The cast cell is only the 1st selection; the next picks accumulate in
    // butinCast and the last one commits the whole play (playCard `heldButinCells`).
    // Only when enough free camp cells exist to finish the picks; otherwise fall
    // through to the normal immediate cast.
    const heldButinE = card.effects.find((e) => e.type === "PlaceButin") as { count?: number } | undefined;
    const heldButinTotal = heldButinE ? Math.max(1, (heldButinE.count ?? 1) | 0) : 0;
    if (heldButinTotal > 1 && countFreeButinCells(state, side) >= heldButinTotal) {
      return {
        ...state,
        pendingAction: {
          side,
          prompt: "Choisissez une autre case de votre camp où poser un butin — cliquez ailleurs pour annuler.",
          filter: "own_empty_camp",
          pendingEffects: [],
          sourceInstanceId: -1,
          heldSpell: { cardId: card.id },
          butinCast: { cardId: card.id, cost: 0, cells: [{ ...target }], total: heldButinTotal },
        },
      };
    }
  }

  // Pay AP and remove the card from hand. Where it ends up depends on the card type:
  //   - Spell  → goes straight to the discard pile (used up on cast).
  //   - Summon → does not enter the discard yet. The card "lives" in the CreatureInstance on the
  //              board; it only enters the discard when that creature dies in combat (or breaks
  //              through a wall and leaves the board).
  // This is what gives the discard count its real meaning: at any moment it tells you how many cards
  // have actually left play.
  // Spend the exact slot the player selected (opts.handIndex): two copies of the same card can have
  // different per-slot costs (Héros Félin #1156 recovered at 0 vs fresh at 4, Polter Tofu #358 growing
  // surcharge, Vampyro reductions), so the game must play the copy that was clicked, not quietly the
  // cheapest. Falls back to the cheapest matching slot when no index is given (AI / play from code) or
  // the given index is outdated (out of range, or the hand shifted so it no longer holds this card).
  // effectiveCost below prices the same slot again, so the AP check and the actual play stay
  // consistent.
  const handIdx = resolveHandSlot(player, card.id, opts?.handIndex);
  const paid = effectiveCost(player, card, state.creatures, handIdx >= 0 ? handIdx : undefined, state.glyphs, { ally: state.players.ally.apReserve, enemy: state.players.enemy.apReserve });
  const newHand = [...player.hand.slice(0, handIdx), ...player.hand.slice(handIdx + 1)];
  const newMods = [...player.handCostMods.slice(0, handIdx), ...player.handCostMods.slice(handIdx + 1)];
  // Keep Ralentissement #188's one-turn surcharge aligned with the hand: drop the
  // played slot too. If handIdx sits past the temp array (a card drawn after the
  // stamp, temp was not extended for it), the slices leave temp untouched, which is
  // right: that fresh card carried no surcharge.
  const newTempMods = player.handCostTempMods
    ? [...player.handCostTempMods.slice(0, handIdx), ...player.handCostTempMods.slice(handIdx + 1)]
    : undefined;
  // Carry this slot's handCostMod onto the figurine so a lasting cost modifier survives a later return
  // to hand: a Vampyro/Wagnar reduction ("jusqu'à ce qu'elle soit défaussée") stays on a card sent back,
  // and Polter Tofu #358 keeps growing from it.
  const playedCostMod = player.handCostMods[handIdx] ?? 0;
  const isSpell = card.cardType !== "Summon";
  // BanishDiscard (Sram): "Bannit les N dernières cartes parties dans votre défausse pour …". The N most
  // recently discarded cards leave the game (→ banished), as a play cost. Done before the spell itself
  // enters the discard, so the card being cast is not one of the banished ones. canPlayCard made sure
  // there are at least N.
  const banishEff = card.effects.find((e) => e.type === "BanishDiscard") as { count: number } | undefined;
  // Total cards to banish from the discard before the spell enters it: the
  // BanishDiscard requirement (Sram) PLUS, under Repos Éternel, the card's whole
  // cost (`paid`), since it is paid in banished cards rather than AP. canPlayCard
  // already ensured the discard holds enough.
  const altCostCards = player.discardPaysCost ? paid : 0;
  const totalBanish = (banishEff ? Math.max(0, banishEff.count | 0) : 0) + altCostCards;
  let baseDiscard = player.discard;
  let baseBanished = player.banished ?? [];
  if (totalBanish > 0) {
    const cut = Math.max(0, player.discard.length - totalBanish);
    baseBanished = [...baseBanished, ...player.discard.slice(cut)]; // the N most recent
    baseDiscard = player.discard.slice(0, cut);
  }
  // Playing an Active Trap (Sram) DEFUSES it: drop its counter entry so it no
  // longer expires against the holder's Dofus.
  const atIdx = (player.activeTraps ?? []).findIndex((t) => t.cardId === card.id);
  const newActiveTraps = atIdx >= 0
    ? [...(player.activeTraps ?? []).slice(0, atIdx), ...(player.activeTraps ?? []).slice(atIdx + 1)]
    : player.activeTraps;
  // A played spell enters the discard, unless it is a token (Fléau #757), which goes
  // to the inaccessible tokenDiscard instead so no recovery effect can replay it.
  const spellIsToken = isSpell && isToken(card.id);
  // Boufballe #1137: playing it does not discard it, "renvoyez-la dans la main adverse".
  // It leaves the holder's pile entirely and lands in the opponent's hand (re-armed with
  // a fresh counter via addCardToHand) after the cast resolves. The defuse above already
  // dropped its expired counter from this player.
  const bouncesToEnemy = isSpell && !!(card.effects.find((e) => e.type === "CreateCardCounterData") as { bounceToEnemyHand?: boolean } | undefined)?.bounceToEnemyHand;
  const nextPlayer: PlayerState = {
    ...player,
    ap: player.ap - (player.discardPaysCost ? 0 : paid), // Repos Éternel: cost paid in cards, no AP
    // Radoris Montrouge #489: also pay its reserve cost ("Dépense 1 PA de votre réserve").
    apReserve: (player.apReserve ?? 0) - (card.reserveCost ?? 0),
    activeTraps: newActiveTraps,
    hand: newHand,
    handCostMods: newMods,
    handCostTempMods: newTempMods,
    discard: isSpell && !spellIsToken && !bouncesToEnemy ? [...baseDiscard, card.id] : baseDiscard,
    tokenDiscard: spellIsToken && !bouncesToEnemy ? [...(player.tokenDiscard ?? []), card.id] : player.tokenDiscard,
    banished: baseBanished,
    // Consume any pending "next card" discount, it was just applied to `paid`. A
    // DiscountNextCard effect on this card (La Folle / Emma Cabre) runs afterwards
    // in summonCreature/castSpell and sets a fresh one for the following card.
    nextCardDiscount: 0,
  };

  let next: GameState = {
    ...state,
    players: { ...state.players, [side]: nextPlayer },
    log: [...state.log, { type: "CARD_PLAYED", side, cardId: card.id }],
  };

  // Reactive ON_PLAY ("quand vous jouez un sort/une carte/une invocation"): the player's own creatures
  // react to the card just played. For a summon the reactions fire where it lands (summonCreature, only
  // when playedFromHand), not here, so a creature whose targeted APPARITION keeps it off the board does
  // not trigger them at the placement click, before it is really placed ("tant que le ciblage n'est pas
  // résolu, la créature n'est pas posée"; e.g. Piou aux Œufs d'Or #446 only draws once the summon really
  // lands). summonCreature fires them before building the new instance, so the new creature is not on
  // the board yet to react to its own entrance. For a spell the order is the other way round: the
  // spell's own effects must resolve first (a recover on kill like Flèche Chercheuse #38, damage, etc.
  // settles before any "quand vous jouez un sort" aura like Emma Zone #1866 reacts), so a spell fires
  // its reactions after castSpell (below).

  if (card.cardType === "Summon") {
    // PHORZERKER fusion (Enutrof ability): when an allied Phorreur is in play, the Énutrof is held off
    // the board (like a placement effect that needs a click) until the player decides. Open a deferred,
    // optional secondary-target pick on the Phorreurs:
    //   • click a Phorreur → fuse (resolvePendingAction): place the Énutrof and transform it into a
    //     Phorzerker (#800) with the two creatures' AT/PV added up, the Énutrof's PM kept; the Phorreur
    //     is banished and the Énutrof's own APPARITION never fires.
    //   • click elsewhere on the board → decline: the Énutrof lands normally and its APPARITION fires
    //     (the standard summonAfter decline → landDeferredSummon path).
    //   • click off the board → cancelPendingAction undoes the whole play (card back to hand).
    // AP is refunded now and charged again at landing (the summonAfter.cost), like the other deferred
    // summons. Checked before the targeted APPARITION trial so an Énutrof whose APPARITION is itself
    // targeted (Erik Rak #720) still offers fusion first, then its APPARITION on decline.
    const phorreurInPlay = next.creatures.some(
      (c) => c.currentLife > 0 && c.owner === side && (getCard(c.cardId)?.families ?? []).includes("Phorreur"),
    );
    const hasUnrevealedDofus = next.dofuses.some((d) => d.owner === side && d.currentLife > 0 && !d.revealed);
    // NÉCROME (and the combined NÉCROME+Phorzerker carriers #634/#899): held off the board until the
    // reveal/combined pick settles, like every other card that targets on placement.
    //   • click a Phorreur (combined only) → fuse; click an unrevealed Dofus → reveal for a 2nd Orbe;
    //   • click elsewhere on the board → land normally (base Orbe + APPARITION, no secondary effect);
    //   • click off the board → cancel the whole play (card back to hand, no base Orbe).
    // The base Orbe is given only at landing (placeDeferredSummon, never on cancel). Checked first so a
    // NÉCROME+Phorzerker carrier is caught here, not by the plain phorzerker block below.
    if (isNecrome(card.id) && !next.winner && (hasUnrevealedDofus || (card.phorzerker && phorreurInPlay))) {
      const combined = !!card.phorzerker && phorreurInPlay;
      next = {
        ...next,
        players: { ...next.players, [side]: { ...next.players[side], ap: next.players[side].ap + paid } }, // refund; re-charged at landing
        pendingAction: {
          side,
          prompt: combined
            ? "PHORZERKER / NÉCROME : ciblez un Phorreur pour fusionner, un de vos Dofus pour un autre Orbe, posez ailleurs, ou cliquez hors du terrain pour annuler."
            : "NÉCROME : révélez un de vos Dofus pour un autre Orbe, posez ailleurs, ou cliquez hors du terrain pour annuler.",
          filter: combined ? "ally_phorreur_or_unrevealed_dofus" : "ally_unrevealed_dofus",
          pendingEffects: [{ type: "RevealDofus" }],
          sourceInstanceId: -1, // the creature is not on the board yet
          summonAfter: { cardId: card.id, cell: target, owner: side, cost: paid, playedCostMod, deferredNecrome: true },
          optional: true,
          fireApparitionAfter: true, // the held APPARITION fires after a land (decline / reveal), not on cancel
          deferredNecrome: true,
          // Hand play: the landing skips the arrival reactions; the settle re-run fires
          // them once, ON_PLAY/Camille armed via this flag (fix: Welsh double ENTERS_PLAY).
          apparitionPlayedFromHand: true,
          ...(combined ? { phorzerkerNecrome: true } : {}),
        },
      };
    } else
    if (card.phorzerker && !isNecrome(card.id) && phorreurInPlay && !next.winner) {
      next = {
        ...next,
        players: { ...next.players, [side]: { ...next.players[side], ap: next.players[side].ap + paid } }, // refund; re-charged at landing
        pendingAction: {
          side,
          prompt: "PHORZERKER : ciblez un Phorreur allié pour fusionner, posez ailleurs pour l'invoquer normalement, ou cliquez hors du terrain pour annuler.",
          filter: "ally_creature",
          family: "Phorreur",
          pendingEffects: [],
          sourceInstanceId: -1, // the Énutrof is not on the board yet
          summonAfter: { cardId: card.id, cell: target, owner: side, cost: paid, playedCostMod },
          optional: true,
          phorzerkerFusion: true,
        },
      };
    } else
    // FRATRIE: a creature with a targeting effect is placed only after its pick is resolved, so the
    // summon is held and the FRATRIE pick opens first. The card is already paid / out of hand;
    // resolvePendingAction (or a decline) places it through summonAfter. Skipped when there is no enemy
    // to target (the card then lands directly through the normal path below).
    if (isFratrie(card.id) && !next.winner && next.creatures.some((c) => c.currentLife > 0 && c.owner !== side)) {
      next = {
        ...next,
        players: { ...next.players, [side]: { ...next.players[side], ap: next.players[side].ap + paid } }, // refund; re-charged at landing
        pendingAction: {
          side,
          prompt: "FRATRIE : ciblez une invocation adverse — toutes ses copies dans le deck adverse partent à sa défausse (posez ailleurs pour la poser directement, ou cliquez hors du terrain pour annuler).",
          filter: "enemy_creature",
          pendingEffects: [{ type: "FratrieMill" }],
          sourceInstanceId: -1, // the creature is not on the board yet
          summonAfter: { cardId: card.id, cell: target, owner: side, cost: paid, playedCostMod }, // cost carried so off-board cancel refunds AP
          optional: true,
        },
      };
    } else {
      // A creature whose own APPARITION needs a target is held off the board until the pick resolves: no
      // AP is spent and nothing (prism/butin/seed/tas d'os) is picked up before the player chose the
      // target. We summon on a trial state to find out whether the APPARITION opens a targeting pick, and
      // to capture that pick's exact filter / caps / family / zone / prompt / optional, without keeping the
      // trial. If it does, the same pick is opened on the state where nothing was placed and the card is
      // held in summonAfter; placeDeferredSummon runs the real summon again (charging AP + doing the
      // pickups) when the pick resolves, then resolvePendingAction resolves it on its own.
      const newId = next.nextInstanceId;
      const trial = summonCreature(next, card, target, side, true, playedCostMod, false, true);
      // Only defer when the pick the trial opened is the creature's own targeted APPARITION
      // not a PRE-apparition keyword pick (NÉCROME Dofus reveal, PHORZERKER fusion) that
      // merely HOLDS the APPARITION. Those carry the new creature as their source too, but they
      // set `fireApparitionAfter` and must land the creature normally (the held APPARITION then
      // fires on resolve/decline). The real targeted-APPARITION pick never sets that flag.
      const targetedApparition = !isNecrome(card.id) && (card.triggers ?? []).some((t) => t.trigger === "APPARITION" && t.effects.some((e) => effectRequiresTarget(e)));
      if (targetedApparition && trial.pendingAction && trial.pendingAction.sourceInstanceId === newId &&
          trial.pendingAction.fireApparitionAfter === undefined && !trial.winner) {
        next = {
          ...next, // Discard the trial placement, keep the un-placed state (AP refunded next line)
          players: { ...next.players, [side]: { ...next.players[side], ap: next.players[side].ap + paid } },
          pendingAction: {
            ...trial.pendingAction,                                              // real filter / caps / family / zone / prompt / optional
            sourceInstanceId: -1,                                                // the creature is not on the board yet
            summonAfter: { cardId: card.id, cell: target, owner: side, cost: paid, playedCostMod },
            deferredSummon: true,
            // The TRIAL's stamp must not ride along: the real landing re-stamps its own
            // re-opened pick, and a stale stamp here would double-fire the reactions.
            arrivalReactionsAfter: undefined,
          },
        };
      } else {
        next = trial; // not a targeted APPARITION (or it ended the game) → keep the real summon
      }
    }
  } else if (card.cardType === "Spell" || card.cardType === "Aoe") {
    const butinE = card.effects.find((e) => e.type === "PlaceButin") as { count?: number } | undefined;
    const butinTotal = butinE ? Math.max(1, (butinE.count ?? 1) | 0) : 0;
    // Final pick of a held Trouvaille #1382 (`heldButinCells`): every cell was chosen and the payment was
    // just committed above. Lay down one Butin per cell, then fire the ON_PLAY reactions (the spell's own
    // effect settles first). The 1st-click held parking is at the top of playCard; a cast without enough
    // free camp cells to finish the picks falls through to the normal immediate cast below.
    if (butinTotal > 1 && opts?.heldButinCells) {
      for (const cell of opts.heldButinCells) {
        if (next.winner) break;
        next = applyPlayerStateEffect(next, { type: "PlaceButin", count: 1 }, side, cell).state;
      }
      if (!next.winner) next = fireOnPlayReactions(next, side, card);
    } else {
      const cast = castSpell(next, card, target, playedCostMod);
      if (!cast.winner && cast.pendingAction) {
        if (opts?.commitHeld) {
          // Held commit, second entry (mandatory two-click spell): keep the committed pending parked as it is.
          // The caller (resolvePendingAction) resolves the pick, then fires the ON_PLAY reactions, so the
          // spell's own effect settles first. Firing them here (the old timing) would let them out before the
          // effect.
          next = cast;
        } else {
          // Multi-step spell still committed at the cast click (the optional-cost trio):
          // its effect completes later in resolvePendingAction, and fireOnPlayReactions
          // is a no-op while a pendingAction is open, so keep the legacy timing and fire
          // the ON_PLAY reactions before the cast (they would otherwise be silently skipped).
          // castSpell is pure, so the detection cast above is safely discarded.
          next = castSpell(fireOnPlayReactions(next, side, card), card, target, playedCostMod);
        }
      } else {
        // Immediate spell: its own damage/effects settle first, then the "quand vous jouez un sort" auras
        // react (Emma Zone #1866), and only then are the "… SI l'invocation meurt" markers settled (Flèche
        // d'Immolation draw / Flèche Chercheuse recover / Ronce & Poussière réserve), so a kill finished by a
        // reactive trigger still counts. killTargetId is read from `next` before the damage lands.
        const killTargetId = creatureAt(next, target)?.instanceId;
        next = cast;
        if (!next.winner) next = fireOnPlayReactions(next, side, card);
        if (!next.winner) next = settleOnKillMarkers(next, card, side, killTargetId, playedCostMod);
      }
    }
  }
  // Dofus / GameRules cards are not player-castable for now.

  // Boufballe #1137 "renvoyez-la dans la main adverse", after the (no-op) cast resolves,
  // it lands in the opponent's hand re-armed with a fresh counter (addCardToHand auto-arms
  // any CreateCardCounterData card). It never entered the holder's discard (see above).
  if (bouncesToEnemy && !next.winner) {
    next = addCardToHand(next, other(side), card.id, 1);
  }

  return next;
}

// Resolve a spell cast from start to end:
//   1. Snapshot creatures/Dofuses for mutation
//   2. Run every Effect handler in order (effects.ts mutates the snapshot)
//   3. resolveDeathsAndWin to settle dead creatures → discard, dead Dofuses → fake bonuses / win
//      check, and update the state log
//
// playCard has already paid AP, removed the card from the hand and added it to the discard, so we
// only need to apply the effects on top of the state it gives us.
// Settle the "… SI l'invocation ciblée meurt" spell markers on the single-target creature that was at
// the cast cell: Flèche d'Immolation #351 (DrawOnKill), Flèche Chercheuse #38 (RecoverOnKill), Ronce
// #384 (SeedReserveOnKill), Poussière Temporelle #184 (AddReserveOnKill). `killTargetId` is the
// creature read at the target cell before the spell's damage. playCard calls this after
// fireOnPlayReactions, so a kill finished by a reactive "quand vous jouez un sort" trigger (Emma Zone
// #1866) still counts as the spell killing its target. Runs once per cast; castSpell no longer
// settles these inline.
function settleOnKillMarkers(result: GameState, card: Card, side: Side, killTargetId: number | undefined, playedCostMod: number): GameState {
  if (killTargetId == null) return result;
  const died = !result.creatures.some((c) => c.instanceId === killTargetId && c.currentLife > 0);
  if (!died) return result;
  // Ronce #384: bank a seed in the caster's reserve (capped).
  const seedOnKill = card.effects.find((e) => e.type === "SeedReserveOnKill") as { amount?: number } | undefined;
  if (seedOnKill) {
    const p = result.players[side];
    result = { ...result, players: { ...result.players, [side]: { ...p, seedReserve: Math.min(SEED_CAP, (p.seedReserve ?? 0) + (seedOnKill.amount ?? 1)) } } };
  }
  // Poussière Temporelle #184: add N PA to the reserve.
  const reserveOnKill = card.effects.find((e) => e.type === "AddReserveOnKill") as { amount?: number } | undefined;
  if (reserveOnKill) {
    const p = result.players[side];
    result = { ...result, players: { ...result.players, [side]: { ...p, apReserve: p.apReserve + Math.max(0, (reserveOnKill.amount ?? 0) | 0) } } };
  }
  // Flèche d'Immolation #351: draw N card(s).
  const drawOnKill = card.effects.find((e) => e.type === "DrawOnKill") as { amount?: number } | undefined;
  if (drawOnKill) {
    for (let i = 0; i < (drawOnKill.amount ?? 1); i++) result = drawCard(result, side);
  }
  // Flèche Chercheuse #38: bring the spell back to hand (it was discarded on cast) with a growing self
  // surcharge; any external "−N jusqu'à la défausse" reduction is reset by the trip through the
  // discard, so the previous self surcharge is max(0, playedCostMod). Respects MAX_HAND: a full hand
  // burns the recovery (it stays in the discard).
  const recoverOnKill = card.effects.find((e) => e.type === "RecoverOnKill") as { costDelta?: number } | undefined;
  if (recoverOnKill) {
    const p = result.players[side];
    if (p.hand.length < MAX_HAND) {
      const di = p.discard.lastIndexOf(card.id); // the copy this cast just discarded
      const discard = di >= 0 ? [...p.discard.slice(0, di), ...p.discard.slice(di + 1)] : p.discard;
      const bonus = Math.max(0, playedCostMod) + (recoverOnKill.costDelta ?? 1);
      result = {
        ...result,
        players: { ...result.players, [side]: { ...p, discard, hand: [...p.hand, card.id], handCostMods: [...p.handCostMods, bonus] } },
        log: [...result.log, { type: "CARD_MOVED", cardId: card.id, from: "discard", to: "hand", side }],
      };
    }
  }
  return result;
}

// Two-click spells: the pick metadata (prompt / filter / optional secondary) for the pendingAction
// that the first click opens. Shared by playCard (held parking for the mandatory picks: nothing is
// committed until the 2nd click) and castSpell (committed parking: the optional-cost trio, plus the
// fizzle detection for the mandatory ones).
function twoStepPending(card: Card, target: Coords, side: Side): PendingAction | null {
  const twoStep = card.effects.find((e) => e.type === "SwapAttack" || e.type === "SwapArmor" || e.type === "ChangeRow" || e.type === "SwapPosition" || e.type === "TeleportToCell" || e.type === "TeleportToGlyph" || e.type === "SwapTwoDofus" || e.type === "ProtectDofus" || e.type === "SacrificeForDamage" || e.type === "LameEmoussee" || e.type === "DestroyArmorForDamage" || e.type === "SacrificeDofusForDamage");
  if (!twoStep) return null;
  const prompt =
    twoStep.type === "SwapAttack" ? "Choisissez la 2ᵉ invocation (échange d'AT)."
      : twoStep.type === "SwapArmor" ? "Choisissez la 2ᵉ invocation (échange d'AR)."
        : twoStep.type === "SwapPosition" ? "Choisissez la 2ᵉ invocation (échange de position)."
          : twoStep.type === "TeleportToCell" ? "Choisissez la case de destination (votre camp)."
            : twoStep.type === "TeleportToGlyph" ? "Choisissez le glyphe allié de destination."
              : twoStep.type === "SwapTwoDofus" ? "Choisissez le 2ᵉ Dofus (échange de position)."
                : twoStep.type === "ProtectDofus" ? "Choisissez le Dofus à protéger."
                  : twoStep.type === "SacrificeForDamage" ? "Choisissez l'invocation à blesser (dégâts = AT de la sacrifiée ; cliquez ailleurs pour ne rien blesser)."
                    : twoStep.type === "LameEmoussee" ? "Choisissez une invocation adverse BLESSÉE à frapper (cliquez ailleurs pour n'infliger que le dégât à votre allié)."
                      : twoStep.type === "DestroyArmorForDamage" ? "Choisissez l'invocation à frapper (dégâts = AR détruite ; cliquez ailleurs pour ne frapper personne)."
                        : twoStep.type === "SacrificeDofusForDamage" ? "Choisissez le Dofus ADVERSE à frapper (votre Dofus est sacrifié)."
                          : "Choisissez la rangée de destination.";
  // Cost-then-optional-effect spells (Sacrifice #576 / Lame Émoussée #1177 / Pluie de Météorites
  // #1350, all CanCastWithNoSecondaryTarget): the 2nd pick is optional, so clicking elsewhere on the
  // board still applies the cost on the 1st creature (decline path).
  const optionalSecondary =
    twoStep.type === "SacrificeForDamage" || twoStep.type === "LameEmoussee" || twoStep.type === "DestroyArmorForDamage";
  return {
    side,
    prompt,
    // ChangeRow / TeleportToCell / TeleportToGlyph pick a destination cell;
    // SwapTwoDofus picks an allied Dofus; ProtectDofus (#1495) an allied Dofus not
    // already protected (original SecondaryTarget AlliedDofusWithoutDamageReflection);
    // SwapPosition (#14) any summon except a Mur (original SecondaryTarget
    // AnySummonButStatue); the stat swaps + SacrificeForDamage pick a creature.
    filter: twoStep.type === "TeleportToCell" ? "own_cell_no_unit" : twoStep.type === "TeleportToGlyph" ? "ally_glyph" : twoStep.type === "SwapTwoDofus" ? "ally_dofus" : twoStep.type === "ProtectDofus" ? "ally_dofus_unlinked" : twoStep.type === "SacrificeDofusForDamage" ? "enemy_dofus" : twoStep.type === "ChangeRow" ? "any_cell" : twoStep.type === "LameEmoussee" ? "wounded_enemy_creature" : twoStep.type === "SwapPosition" ? "any_summon_but_statue" : "any_creature",
    pendingEffects: [twoStep],
    sourceInstanceId: -1,
    firstTarget: { ...target },
    ...(optionalSecondary ? { optional: true } : {}),
  };
}

// `_playedCostMod` is accepted for signature parity with the other commit paths but
// is not read here: the AP was already debited by the caller before the cast lands.
function castSpell(state: GameState, card: Card, target: Coords, _playedCostMod = 0): GameState {
  // TWO-target spells: the cast click is the first pick; park a pendingAction so the UI
  // prompts for the second, and resolvePendingAction applies the effect. Only reached
  // committed (AP paid, card discarded): by the optional-cost trio's normal cast, or by a
  // held commit re-entry / fizzle probe for the mandatory picks (playCard).
  const twoStepParked = twoStepPending(card, target, state.activeSide);
  if (twoStepParked) {
    const parked: GameState = { ...state, pendingAction: twoStepParked };
    // Fizzle: a non-optional two-step spell whose mandatory second pick would have zero valid targets is
    // still cast (playCard already paid the AP and sent the card to the discard) but does nothing: the
    // pending never opens and the board is untouched ("l'effet est consommé mais rien ne se passe"). This
    // is both the real rule and the fix for a hard freeze: legalActions offers neither a resolve nor a
    // cancel for a non-optional pending with no targets, so an agent has no legal move and self-play gets
    // stuck. The same for the whole family: Détournement #134 on a boxed-in creature (both neighbours in
    // the column taken), Bluff #61 with a single eligible Dofus left, Téléglyphe #1735 with no allied
    // glyph, Téléportation #119 into a full camp, Lien de Sang #1495 with no allied Dofus, Punition #189
    // with no enemy Dofus (its own-Dofus sacrifice is in resolvePendingAction, so fizzling spares it
    // too). The optional secondaries are exempt: they open even with no 2nd target (the 1st pick already
    // applied a cost, and declining on the board settles them, see legalActions).
    if (!twoStepParked.optional && validPendingTargets(parked).length === 0) {
      return state;
    }
    return parked;
  }

  // Glyphe de Retraite #736 (the only PlaceGlyph + AoePush card): its text is "QUAND IL EST PLACÉ, ce
  // Glyphe repousse de 3 cases…", so the glyph must already be on the board when the push slides
  // creatures across its cell. An allied Féca retreating over it then gains the glyph's +AR (and an
  // enemy pushed across destroys it, like any walk-over). PlaceGlyph is a player-state effect applied
  // after the board/push pass below, so it is moved up here onto `state`, before the snapshot +
  // tracking are built (buildGlyphCells then sees it), and skipped in the player-state loop so it is
  // not placed twice. (#736 has no AoeDamage, so the push runs in the immediate mainEffects pass.)
  let glyphPreplaced = false;
  if (card.effects.some((e) => e.type === "AoePush")) {
    const pg = card.effects.find((e) => e.type === "PlaceGlyph");
    if (pg) {
      state = applyPlayerStateEffect(state, pg, state.activeSide, target).state;
      glyphPreplaced = true;
    }
  }

  // Snapshot for in-place mutation by the effect handlers (same pattern as processCombatPhase). `let`:
  // the ordered resolution below can pack these arrays again (a CONTRE COUP that fires before the
  // deaths gives back new objects).
  let creatures = state.creatures.map((c) => ({
    ...c,
    position: { ...c.position },
    properties: new Set(c.properties),
  }));
  let dofuses = state.dofuses.map((d) => ({
    ...d,
    position: { ...d.position },
  }));
  let log: GameEvent[] = [...state.log];
  const spellLogStart = log.length; // the damage of this spell starts here
  // Index from which the final fireContreCoup scans. Moved forward if the contre-coups already fired
  // earlier (before the deaths) because their cells came first; otherwise they would fire twice.
  let ccFrom = spellLogStart;

  // Seeded RNG for any random effect this cast triggers (dice spells, coin flips). The advanced state
  // is written back into the returned state so the roll can be reproduced in sims.
  //
  // `let` and not `const`: the stream has to be seeded again after each step that uses randomness
  // elsewhere, typically resolveDeathsAndWin, which draws for the MORT reactions. Without this, the
  // local stream overwrote at the end of the cast the progress made by those steps, and the next draw
  // of the game was replayed the same way.
  let rng = new Rng(state.rng);

  // Does this spell roll (a die or a coin)? Captured before the CoinFlip below is
  // resolved away, so Ecaflip's roll-reactive cards (#1606/#1201) fire afterwards.
  const isRollingCard = effectsHaveRoll(card.effects);

  // Coin flip ("A OU B", pile ou face). Not a player choice: Pile = the first
  // (positive) branch, Face = the second. Forced to Pile by Trucage during the
  // caster's active turn; otherwise a 50/50 RNG roll. We resolve to one branch
  // and swap it into `card.effects` so the rest of castSpell runs it normally.
  const coin = card.effects.find((e) => e.type === "CoinFlip") as
    | { pile: Effect[]; face: Effect[] }
    | undefined;
  if (coin) {
    card = { ...card, effects: flipCoin(state, state.activeSide, rng) ? coin.pile : coin.face };
  }

  // Heure de Gloire (#296) "Dépense vos PA restants pour donner +1 AT et +1 AR par PA utilisé" /
  // Désynchronisation (#377) "… pour infliger l'équivalent en dégâts". The size is the live remaining
  // AP (not a fixed amount), so it is resolved here where player state is available: read the caster's
  // AP, build a +AP buff on each listed stat (or a flat AP-sized DamageData on the targeted creature),
  // and (below) set the AP to zero. canPlayCard already blocked the 0-AP case, so apSpent ≥ 1 here.
  const spendEff = card.effects.find((e) => e.type === "SpendApAsBuff" || e.type === "SpendApAsDamage") as
    | { type: "SpendApAsBuff" | "SpendApAsDamage"; stats?: ("attack" | "armor")[] }
    | undefined;
  const apSpent = spendEff ? state.players[state.activeSide].ap : 0;
  const effectsToApply: Effect[] = spendEff
    ? spendEff.type === "SpendApAsDamage"
      ? [{ type: "DamageData", Damage: apSpent } as Effect]
      : (spendEff.stats ?? ["attack", "armor"]).map((st) =>
          st === "armor"
            ? ({ type: "BoostArmor", amount: apSpent } as Effect)
            : ({ type: "BoostAttack", amount: apSpent } as Effect),
        )
    : card.effects;

  // Pollinisation (#58): snapshot the enemy creatures (id + cell) before the
  // spell's AoE damage lands, so that after death resolution we can plant an
  // allied seed on the cell of every enemy that died from this cast.
  const pollinates = card.effects.some((e) => e.type === "PlantSeedOnEnemyDeaths");
  const enemyCellsBefore = pollinates
    ? state.creatures
        .filter((c) => c.owner !== state.activeSide && c.currentLife > 0)
        .map((c) => ({ id: c.instanceId, cell: { ...c.position } }))
    : [];
  // The "… SI l'invocation ciblée meurt" markers (Flèche d'Immolation DrawOnKill, Flèche Chercheuse
  // RecoverOnKill, Ronce SeedReserveOnKill, Poussière Temporelle AddReserveOnKill) are no longer
  // settled here: playCard saves the target and calls settleOnKillMarkers after fireOnPlayReactions,
  // so a kill by a reactive "quand vous jouez un sort" (Emma Zone) counts.

  // Capture the Charge target's PM budget before the effect handlers overwrite
  // movementLeft (handleCharge sets it to the burst size). A Charge is an extra
  // immediate advance and must not consume the creature's normal end-of-turn
  // movement, "charge" and "spending PM" are two different things. We restore
  // this budget after the immediate advance (below) so the creature still
  // advances its PM at end of turn, exactly like chargeAllies.
  const hasCharge = card.effects.some((e) => e.type === "Charge");
  const chargeTargetPre = hasCharge
    ? creatures.find((c) => sameCoords(c.position, target) && c.currentLife > 0)
    : undefined;
  const chargePmBudget = chargeTargetPre?.movementLeft;
  // Bond du Félin #472 and similar (Teleport effect): note the targeted creature + its cell before the
  // jump, to replay the walk-over on its landing cell after applyEffects (the Teleport handler only
  // moves it, without picking anything up).
  const teleportPre = card.effects.some((e) => e.type === "Teleport")
    ? creatures.find((c) => sameCoords(c.position, target) && c.currentLife > 0)
    : undefined;
  const teleportTargetId = teleportPre?.instanceId;
  const teleportFrom = teleportPre ? { ...teleportPre.position } : undefined;
  // Summoning sickness is `hasAttacked` before the charge, the only reliable signal (movementLeft is
  // not: a 0-PM veteran shooter/turret, or a static creature just taken over with Fiole de Psykoz,
  // also has movementLeft 0 but no summoning sickness). handleCharge clears hasAttacked so the burst
  // can move/strike; this pre-charge state must be applied again so a unit that was just summoned keeps
  // its sickness (no end-of-turn melee/shot even with a target in range) while a unit already in play
  // keeps its end-of-turn action. Same rule as the scoped chargeAllies (`wasSpent`). This fixes a new
  // shooter charged by Lait de Bambou wrongly firing, and a 0-PM creature taken over wrongly staying
  // asleep.
  const chargeWasSpent = chargeTargetPre?.hasAttacked ?? false;

  // Tracking accumulator for any board movement this cast performs, a Charge /
  // ChargeAllies / RetreatAllies / TriggerAttack advance, or a forced slide (push /
  // attract via the effect handlers). Built before applyEffects so the slide hook
  // (spellCtx.onSlideStep) can record token walk-overs / prism pickups as the
  // handlers run; the settle pass below packs them. (Charge effects below reuse it.)
  const tracking: AdvanceTracking = {
    brokeThroughIds: new Set<number>(),
    prismCellKeys: new Set(state.prisms.map((p) => `${p.position.x},${p.position.y}`)),
    collectedPrismKeys: new Set<string>(),
    prismPickups: [],
    seedCells: buildSeedCells(state), consumedSeedKeys: new Set<string>(),
    glyphCells: buildGlyphCells(state), consumedGlyphKeys: new Set<string>(),
    tasDOsCells: buildTasDOsCells(state), consumedTasDOsKeys: new Set<string>(),
    bushCells: buildBushCells(state), consumedBushKeys: new Set<string>(),
    butinCells: buildButinCells(state), consumedButinKeys: new Set<string>(), butinPickups: [],
    giftCells: buildGiftCells(state), consumedGiftKeys: new Set<string>(), giftRng: new Rng((state.rng ^ GIFT_ROLL_SALT) | 0), giftRolls: { ally: 0, enemy: 0 },
    trapCells: buildTrapCells(state), consumedTrapKeys: new Set<string>(), trapPickups: [],
  };
  // Kept as a variable so the dice roll the damage rolls (spellCtx.diceRoll) is
  // readable afterwards for "sur N ou moins" spell-level effects (Dé Ecaflip's
  // recover below).
  const spellCtx = {
    casterSide: state.activeSide,
    targetCell: target,
    rng,
    diceFloor: state.players[state.activeSide].diceFloor,
    diceRoll: undefined as number | undefined,
    // Damage only hits a Dofus if the card says so (general rule): only an explicit Dofus castTarget
    // (Fléau #757 "AnyDofus") lets handleDamage hit the Dofus of the targeted cell.
    dofusTargetable: (card.castTarget ?? "").includes("Dofus"),
    // Forced slides (push/attract/retreat) interact with each crossed cell.
    onSlideStep: makeSlideStep(creatures, log, tracking),
  };
  // Rule "simultaneous area damage → deaths → effects": an area push (AoePush) that follows area damage
  // in the same card only sweeps the survivors after the dead are gone, never before. It is set aside
  // here to be replayed on the post-cull board (Flèche Tempête #84: Inflige 2 PUIS repousse). A push
  // with no damage before it (Peur, Glyphe de Retraite, APPARITION pushes) keeps the immediate path,
  // unchanged.
  const deferredPush: Effect[] = [];
  const mainEffects: Effect[] = [];
  {
    let sawAoeDamage = false;
    for (const e of effectsToApply) {
      if (e.type === "AoeDamage" || e.type === "DamageEnemiesByEnemyCount") sawAoeDamage = true;
      if (e.type === "AoePush" && sawAoeDamage) deferredPush.push(e);
      else mainEffects.push(e);
    }
  }
  applyEffects(creatures, dofuses, log, dropUnmetConditions(resolveCounts(mainEffects, creatures, state.seeds ?? [], state.glyphs ?? [], state.activeSide, undefined, state.players[state.activeSide].apReserve, state.players[state.activeSide].hand.length, (state.butins ?? []).length), state, state.activeSide), spellCtx);

  // TELEPORT (Bond du Félin #472 "téléporte une invocation de 1d6 cases", Fulgurance #14, Bond #429): a
  // creature that lands on a cell after a jump picks up what is there (prism/fléau, seed, butin, gift,
  // trap), exactly like the other teleports (Truche, Téléportation #119 through relocateThenPickup).
  // The Teleport handler (effects.ts) only moves the creature, so the walk-over is replayed on its
  // landing cell, and the settle of `tracking` below activates the prism / removes the object. Skipped
  // if the jump did not happen (blocked cell / INAMOVIBLE).
  if (teleportTargetId != null && teleportFrom) {
    const moved = creatures.find((c) => c.instanceId === teleportTargetId && c.currentLife > 0);
    if (moved && !sameCoords(moved.position, teleportFrom)) {
      applyWalkOverPickups(moved, moved.position.x, moved.position.y, creatures, log, tracking);
    }
  }

  // Temporary stat modifiers ("… jusqu'à votre prochain tour", Sénilité): the
  // delta was just applied above; record the INVERSE so startTurn undoes it at
  // the expiry turn. We snapshot the affected creatures' ids now (by the same
  // scope), so creatures summoned later are not touched.
  const tempReversions: TempReversion[] = [];
  for (const e of card.effects) {
    const dur = (e as { duration?: string }).duration;
    if (!dur) continue;
    const expireSide: Side = dur === "opponentNextTurn" ? other(state.activeSide) : state.activeSide;
    if (e.type === "TakeControl") {
      // Temporary control (Fiole de Psykoz): handleTakeControl above already
      // flipped the picked creature to the caster, record a reversion to hand it
      // back to its original owner (the opponent) at the expiry turn.
      const seized = creatures.find((c) => c.currentLife > 0 && sameCoords(c.position, target));
      if (seized) {
        // This is a temporary control cast on the caster's own turn: the borrowed
        // creature must behave exactly like one of theirs right now. handleTakeControl
        // marked it summoning-sick, the correct default for a permanent seize (Contrôle
        // Mental) and for reactive captures, but a temporary control would then revert
        // (at expireSide's turn start) before it ever got to act. Refresh it so it can
        // advance and fight this turn, exactly as a creature the caster already owned.
        seized.movementLeft = seized.baseMovement;
        seized.hasAttacked = false;
        tempReversions.push({ kind: "control", expireSide, instanceId: seized.instanceId, originalOwner: other(state.activeSide) });
      }
      continue;
    }
    const field = TEMP_STAT_FIELD[e.type];
    const amt = ((e as { amount?: number }).amount ?? 0) | 0;
    if (!field || amt === 0) continue;
    const scope = (e as { scope?: string }).scope as string | undefined;
    const affected = creatures
      .filter((c) => c.currentLife > 0 && tempScopeMatches(c, scope, state.activeSide, target))
      .map((c) => c.instanceId);
    if (affected.length === 0) continue;
    tempReversions.push({ kind: "stat", expireSide, field, amount: -amt, instanceIds: affected });
  }

  // Charge resolves immediately: the targeted creature advances right now (not at end
  // of turn). handleCharge has already set its movementLeft and cleared summoning
  // sickness; here we run the same advance the end-of-turn phase uses, threading the
  // `tracking` built above so the deferred side-effects (deck returns, prism bonuses)
  // are applied below.
  if (hasCharge) {
    const charged = creatures.find((c) => sameCoords(c.position, target) && c.currentLife > 0);
    // "pas de charge" for an INAMOVIBLE (Justice #130 on a target made Rooted by Arakne à Crochets
    // #1457). Justice's SetAttack still applies (it is not a move); only the charge is cancelled. The
    // PM/hasAttacked restore below still runs, so the state stays clean.
    if (charged && !isImmovable(charged.properties)) {
      advanceCreature(charged, creatures, dofuses, log, charged.owner, forwardDx(charged.owner), tracking, { chargeMelee: true });
      // Restore the PM used by the burst so the end-of-turn advance still moves the creature by its PM (a
      // charge is not spending PM). The charge is a bonus action: for a creature already in play it must
      // not use up the turn's natural attack either, so the summoning sickness state from before the
      // charge is restored (`chargeWasSpent`). A creature that was ready (hasAttacked false: any unit in
      // play, including 0-PM shooters/turrets and a static one taken over with Fiole de Psykoz) keeps its
      // fin-de-tour attack even after a charge that struck. A creature that had summoning sickness before
      // the charge (a fresh summon, born with hasAttacked true: Protoflex + Lait de Bambou) keeps it: no
      // melee/shot at end of turn, even with a target in range. Same as the scoped chargeAllies
      // (`wasSpent`).
      if (charged.currentLife > 0 && chargePmBudget !== undefined) {
        charged.movementLeft = chargePmBudget;
        charged.hasAttacked = chargeWasSpent;
      }
    }
  }
  // "Vos invocations chargent de N cases", scoped charge (a spell variant).
  const caSpell = card.effects.find((e) => e.type === "ChargeAllies") as { cells: number; family?: string; wounded?: boolean } | undefined;
  if (caSpell) {
    chargeAllies(creatures, dofuses, log, state.activeSide, caSpell.cells, undefined, caSpell.family, tracking, caSpell.wounded);
  }
  // "Vos invocations reculent de N cases", the Face branch of Tout ou Rien.
  const reSpell = card.effects.find((e) => e.type === "RetreatAllies") as { cells: number } | undefined;
  if (reSpell) {
    retreatAllies(creatures, dofuses, state.activeSide, reSpell.cells, log, spellCtx.onSlideStep);
  }

  // COUP DE GRÂCE kills owed by a triggered attack (filled by the TriggerAttack block below,
  // fired once the board is settled). Empty for every other spell.
  let cdgKills: ReturnType<typeof collectCdgKills> = [];
  // TriggerAttack, "L'invocation ciblée déclenche une attaque" (Tir Rapide #1178, the only carrier):
  // the creature attacks the cell in front of it right now, without moving. advanceCreature is reused
  // with movementLeft=0 (no walk) and hasAttacked cleared, so only its "engage in front" branch (or,
  // for a shooter, its shot) fires, through the single shared combat path.
  // `noCounter`: the enemy struck this way does not answer, even at corps à corps; this is the one
  // melee in the game without a counter. It reaches both combat sites a triggered attack can hit: the
  // shooter's d=1 exchange and the end-of-move engage.
  // The triggered attack is a bonus: it does not use up the creature's turn ("Tir Rapide ne met pas les
  // PM de la cible à 0"). The 0-PM/ready pair above is only forced for the strike (so it hits in place)
  // and restored right after, exactly like a Charge (see `hasCharge` above): a creature that was ready
  // still takes its end-of-turn advance/attack, one with summoning sickness keeps it.
  if (card.effects.some((e) => e.type === "TriggerAttack")) {
    const attacker = creatures.find((c) => sameCoords(c.position, target) && c.currentLife > 0);
    if (attacker) {
      const pmBefore = attacker.movementLeft;
      const actedBefore = attacker.hasAttacked;
      attacker.movementLeft = 0;
      attacker.hasAttacked = false;
      advanceCreature(attacker, creatures, dofuses, log, attacker.owner, forwardDx(attacker.owner), tracking, { noCounter: true });
      if (attacker.currentLife > 0) {
        attacker.movementLeft = pmBefore;
        attacker.hasAttacked = actedBefore;
      }
      // A kill made by the triggered attack is a real kill: the attacker's COUP DE GRÂCE fires. Limited to
      // this attacker's victims (a spell's own damage effects are not "its" kills), captured pre-cull,
      // fired on the settled board below, same pattern as applyChargeOnSummon.
      // Limits: a creature that broke through is not a victim, and the backward scan stops at the start of
      // this spell (the log covers the whole game).
      cdgKills = collectCdgKills(creatures, log, tracking.brokeThroughIds, spellLogStart)
        .filter((k) => k.killerId === attacker.instanceId);
    }
  }

  // ---- Resolution order after the volley ----------------------------------------------------------
  // The spell's damage has just landed all at the same time (one volley, no reaction has fired yet).
  // Its consequences resolve cell by cell in the absolute order (y going up, then x going up), so the
  // CONTRE COUP of a survivor and the MORT of a killed creature go in the order of their cells, not in
  // a fixed order.
  // Example (Pied du Sacrieur #271 on a Gelée d'Encre #69, with an Empereur Gelax #422):
  //  - if Gelax's cell comes first, it summons its Gelée, then the Encre dies and its MORT (+1 AT/+1 AR
  //    to your other Gelées) finds the newborn on the board, so it gets the boost;
  //  - if the Encre comes first, it dies first, boosts the Gelées that are there, and Gelax's Gelée is
  //    born afterwards, so it gets nothing.
  // One single sweep: resolveDeathsAndWin gets the start of the volley (`spellLogStart`) and slots the
  // contre-coups of wounded survivors in between the deaths, at their cell.
  // It is given the stream already advanced by the spell (not `state`), otherwise its own draws would
  // start again from the seed from before the cast, and the spell's die and a MORT's coin would be
  // correlated. Its progress is then taken back.
  let result = resolveDeathsAndWin(
    { ...state, rng: rng.state }, creatures, dofuses, log, tracking.brokeThroughIds, new Set(), new Set(), spellLogStart,
  );
  rng = new Rng(result.rng);
  // Everything the volley triggered is handled. So the end-of-cast fireContreCoup must not replay that
  // damage again: it only scans what lands after (pushes, charges, player-state effects played below).
  ccFrom = result.log.length;
  result = removeConsumedSeeds(result, tracking.consumedSeedKeys);
  result = removeConsumedGlyphs(result, tracking.consumedGlyphKeys);
  result = removeConsumedTasDOs(result, tracking.consumedTasDOsKeys);
  result = removeConsumedBushes(result, tracking.consumedBushKeys);
  result = removeConsumedButins(result, tracking.consumedButinKeys);
  result = removeConsumedGifts(result, tracking.consumedGiftKeys);
  result = removeConsumedTraps(result, tracking.consumedTrapKeys);
  result = applyTrapPickups(result, tracking.trapPickups);
  // Butin pickups from a charge/advance this cast (rng is the cast's seeded RNG).
  result = applyButinPickups(result, tracking.butinPickups, rng);
  result = applyGiftRollReactions(result, tracking);
  // Pollinisation (#58): plant an allied seed on the (now-free) cell of every
  // enemy that died from this cast. We match by instanceId snapshotted before the
  // damage, an enemy still alive in result.creatures survived (no seed).
  if (pollinates && enemyCellsBefore.length > 0) {
    const extraLog: GameEvent[] = [];
    const planted: SeedInstance[] = [];
    let working = result;
    for (const { id, cell } of enemyCellsBefore) {
      if (working.creatures.some((c) => c.instanceId === id && c.currentLife > 0)) continue; // survived
      if (working.creatures.some((c) => c.currentLife > 0 && sameCoords(c.position, cell))) continue; // cell taken by a survivor
      if (planted.some((s) => sameCoords(s.position, cell))) continue; // do not plant twice in this cast
      // One object per cell: any ground object already on the death cell (e.g. the Butin that Coffre #711
      // just dropped there through its own MORT on this kill) is replaced by the seed (it appears, then
      // disappears through A_O_E_REMOVED: Coffre + Pollinisation).
      working = replaceGroundObjectsAt(working, cell, extraLog);
      planted.push({ position: { ...cell }, owner: state.activeSide });
      extraLog.push({ type: "SEED_PLANTED", at: { ...cell }, ownerSide: state.activeSide });
    }
    if (planted.length > 0) {
      result = recomputeAuras({ ...working, seeds: [...(working.seeds ?? []), ...planted], log: [...working.log, ...extraLog] });
    }
  }
  // NOTE: the "… SI l'invocation meurt" markers (draw / recover / seed / AP reserve) are
  // settled by playCard via settleOnKillMarkers, after fireOnPlayReactions (so a reactive
  // Emma-Zone kill counts). They are intentionally not applied here.
  for (const pk of tracking.prismPickups) {
    result = activatePrism(result, pk.at, pk.side, pk.props, undefined, pk.byInstanceId);
  }
  // Deferred area push (see the split above): replayed now, on the board that is already culled (dead
  // gone, MORTs resolved), to keep the order damage → deaths → push. A new tracking is built on
  // `result` (correct snapshots of seeds/glyphs/tas d'os/butins/traps/prisms) with a new onSlideStep,
  // so nothing is shared with the arrays of the first pass. The new cull catches a death that happened
  // during the push (gangrène / enemy seed / trap crossed).
  if (deferredPush.length > 0 && !result.winner) {
    const pc = result.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
    const pd = result.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
    const pl: GameEvent[] = [...result.log];
    const pushTracking: AdvanceTracking = {
      brokeThroughIds: new Set<number>(),
      prismCellKeys: new Set(result.prisms.map((p) => `${p.position.x},${p.position.y}`)),
      collectedPrismKeys: new Set<string>(),
      prismPickups: [],
      seedCells: buildSeedCells(result), consumedSeedKeys: new Set<string>(),
      glyphCells: buildGlyphCells(result), consumedGlyphKeys: new Set<string>(),
      tasDOsCells: buildTasDOsCells(result), consumedTasDOsKeys: new Set<string>(),
      bushCells: buildBushCells(result), consumedBushKeys: new Set<string>(),
      butinCells: buildButinCells(result), consumedButinKeys: new Set<string>(), butinPickups: [],
      giftCells: buildGiftCells(result), consumedGiftKeys: new Set<string>(), giftRng: new Rng((result.rng ^ GIFT_ROLL_SALT) | 0), giftRolls: { ally: 0, enemy: 0 },
      trapCells: buildTrapCells(result), consumedTrapKeys: new Set<string>(), trapPickups: [],
    };
    // `targetCell` is set back to the original target cell: handlePush moves the context to the pushed
    // creature's new cell (so a following "infligez-LUI" finds it), and this second pass must not inherit
    // that move. It aims at the spell's cell, not at a creature.
    // Explicit `rng`: spellCtx captured the Rng object at the start of the cast, before the new seed that
    // follows resolveDeathsAndWin. A plain spread of spellCtx would carry the old object, whose progress
    // would be lost.
    const pushCtx = { ...spellCtx, rng, targetCell: { ...target }, onSlideStep: makeSlideStep(pc, pl, pushTracking) };
    const pushEffects = dropUnmetConditions(resolveCounts(deferredPush, pc, result.seeds ?? [], result.glyphs ?? [], state.activeSide, undefined, result.players[state.activeSide].apReserve, result.players[state.activeSide].hand.length, (result.butins ?? []).length), result, state.activeSide);
    applyEffects(pc, pd, pl, pushEffects, pushCtx);
    result = resolveDeathsAndWin({ ...result, creatures: pc, dofuses: pd, log: pl }, pc, pd, pl, new Set());
    result = removeConsumedSeeds(result, pushTracking.consumedSeedKeys);
    result = removeConsumedGlyphs(result, pushTracking.consumedGlyphKeys);
    result = removeConsumedTasDOs(result, pushTracking.consumedTasDOsKeys);
  result = removeConsumedBushes(result, pushTracking.consumedBushKeys);
    result = removeConsumedButins(result, pushTracking.consumedButinKeys);
    result = removeConsumedGifts(result, pushTracking.consumedGiftKeys);
    result = removeConsumedTraps(result, pushTracking.consumedTrapKeys);
    result = applyTrapPickups(result, pushTracking.trapPickups);
    result = applyButinPickups(result, pushTracking.butinPickups, rng);
    result = applyGiftRollReactions(result, pushTracking);
    for (const pk of pushTracking.prismPickups) {
      result = activatePrism(result, pk.at, pk.side, pk.props, undefined, pk.byInstanceId);
    }
  }
  // COUP DE GRÂCE of a killer sent by a triggered attack (Tir Rapide #1178), on the settled board. It
  // must have survived, which fireCoupDeGrace checks again. Empty for every other spell. The same list
  // feeds Toutancoffron #633: a kill through Tir Rapide drops its Butin.
  if (cdgKills.length > 0 && !result.winner) {
    result = fireCoupDeGrace(result, cdgKills);
    result = applyKillToButin(result, cdgKills);
  }
  // CONTRE_COUP also reacts to spell damage (allied or enemy spell): fire it for any survivor this cast
  // hurt, exactly like combat damage. `ccFrom` = the start of the spell's volley, unless the
  // contre-coups already fired before the deaths (their cells came first), in which case only what
  // landed since then is scanned (typically the damage from the MORTs).
  result = fireContreCoup(result, ccFrom);
  if (result.winner) return { ...result, rng: rng.state };
  result = fireDamageReactions(result, state.log.length, undefined, state.creatures); // bystander ON_DAMAGE reactions (roster: react to a killed ally too)
  if (result.winner) return { ...result, rng: rng.state };
  // Several hits taken before dying: pay back the missing contre-coups.
  result = payMissingPosthumousContreCoups(result, state.log.length, state.creatures);
  if (result.winner) return { ...result, rng: rng.state };

  // Heure de Gloire / Désynchronisation consume all the caster's remaining AP
  // (the buff/damage above used that amount). Zero it out now that the board
  // effects are settled.
  if (spendEff) {
    const p = result.players[state.activeSide];
    result = { ...result, players: { ...result.players, [state.activeSide]: { ...p, ap: 0 } } };
  }

  // Player-state effects run after the board effects resolve. They live here
  // (not in effects.ts) because they touch hand / deck / turn, which only
  // rules.ts owns (drawCard / endTurn). applyEffects above silently skips
  // them (unknown-type no-op), so this is the single place they are applied.
  const caster = state.activeSide;
  let endsTurn = false;
  // Resolve any {count} amount first (Sang Tatoué "Piochez 1 par invocation
  // alliée blessée" → DrawCards amount = wounded-ally count). We count against
  // the POST-resolution board (result.creatures), so the spell's own board
  // effects are already settled. The trigger path resolves counts too (runTrigger);
  // this is the spell equivalent, which the raw loop previously skipped.
  const playerStateEffects = resolveCounts(card.effects, result.creatures, result.seeds ?? [], result.glyphs ?? [], caster, undefined, result.players[caster].apReserve, result.players[caster].hand.length, (result.butins ?? []).length);
  // #1237 Second Souffle / Bakara: a spell that "récupère les N dernières de votre défausse" must not
  // count itself. It is only "parti dans la défausse" once resolved, but playCard discarded it early.
  // The copy just cast is lifted off the pile while its own recover resolves, then put back on top.
  const liftsSelf = card.effects.some((e) => e.type === "RecoverFromDiscard");
  let liftedSelf = false;
  if (liftsSelf) {
    const p = result.players[caster];
    const i = p.discard.lastIndexOf(card.id);
    if (i >= 0) {
      result = { ...result, players: { ...result.players, [caster]: { ...p, discard: [...p.discard.slice(0, i), ...p.discard.slice(i + 1)] } } };
      liftedSelf = true;
    }
  }
  // Escompte #1629 ("celle-ci comprise"): the cast spell is itself a <god> card that
  // must join the recycle. Pull it back out of the discard and into the hand before the
  // RecycleGodDrawAny effect runs, so it is counted, shuffled into the deck, and redrawn-
  // against like the other <god> cards (instead of staying in the discard).
  if (card.effects.some((e) => e.type === "RecycleGodDrawAny")) {
    const p = result.players[caster];
    const i = p.discard.lastIndexOf(card.id);
    if (i >= 0) {
      const discard = [...p.discard.slice(0, i), ...p.discard.slice(i + 1)];
      result = addCardToHand({ ...result, players: { ...result.players, [caster]: { ...p, discard } } }, caster, card.id, 1);
    }
  }
  for (const e of playerStateEffects) {
    if (glyphPreplaced && e.type === "PlaceGlyph") continue; // already placed before the push (see the move above)
    // Take the stream back at each iteration: a state effect can summon a token, and summonCreature
    // stores its own progress in the state it returns. Without the step below, two tokens placed by the
    // same spell would replay the same draw.
    result = { ...result, rng: rng.state };
    const r = applyPlayerStateEffect(result, e, caster, target, undefined, rng);
    result = r.state;
    rng = new Rng(result.rng);
    endsTurn = endsTurn || r.endsTurn;
  }
  if (liftedSelf) {
    const p = result.players[caster];
    result = { ...result, players: { ...result.players, [caster]: discardCardFor(p, card.id) } };
  }
  // Dé Ecaflip #342: "Récupérez ce sort sur N ou moins." If the dice damage rolled ≤ maxRoll (captured
  // in spellCtx.diceRoll), move this spell from the caster's discard back to hand (instead of leaving
  // it discarded). Does nothing if the roll missed.
  const recover = card.effects.find((e) => e.type === "RecoverSelfOnLowRoll") as { maxRoll: number } | undefined;
  if (recover && spellCtx.diceRoll != null && spellCtx.diceRoll <= recover.maxRoll) {
    const p = result.players[caster];
    const di = p.discard.lastIndexOf(card.id);
    if (di >= 0) {
      const discard = [...p.discard.slice(0, di), ...p.discard.slice(di + 1)];
      result = addCardToHand({ ...result, players: { ...result.players, [caster]: { ...p, discard } } }, caster, card.id, 1);
    }
  }
  // Ecaflip roll reactions: a dice/coin spell is one allied roll for the caster,
  // fire its board Sentinelles (+1/+1) and hand Atout Cachés (−1 PA).
  if (isRollingCard) result = applyAllyRollReactions(result, caster, 1);
  // Queue any temporary-stat reversions recorded above.
  if (tempReversions.length > 0) {
    result = { ...result, pendingReversions: [...(result.pendingReversions ?? []), ...tempReversions] };
  }
  // Bake the advanced RNG state in before any end-of-turn handoff so the dice
  // roll (and any future random spell effect) is part of the reproducible game.
  result = { ...result, rng: rng.state };
  // NB: Trouvaille #1382's multi-cell Butin placement is deferred up in playCard
  // (butinCast), it never reaches castSpell, so there is no trailing pick to open here.
  if (endsTurn) result = endTurn(result);
  return result;
}

// Effect types that touch the player (hand / deck / AP / prisms) rather than a
// board creature. Used to route trigger effects to applyPlayerStateEffect
// instead of the creature-effect executors in effects.ts.
const PLAYER_STATE_TYPES: ReadonlySet<string> = new Set([
  "DrawCards", "CrossDraw", "StealTopDraw", "MillDeck", "StealDiscard", "DrawFiltered", "DrawUpTo", "EndTurn", "RespawnPrisms", "AddCostModifier", "EnemyHandSurcharge",
  "AddReserve", "DrainAp", "TransferApToReserve", "StealReserve", "SpendReserveDouble", "DamageEnemiesByReserve", "SacrificePoupesque",
  "AddCardToHand", "AddRandomFamilyCards", "ControlAround", "GiveSelfToOpponent", "SummonToken", "TutorFromDeck", "RecoverFromDiscard", "ForceCoinPile", "SetDiceFloor", "DiscountNextCard", "BanishOwnDiscard", "BanishFamilyDiscardBuffSelf", "SetDiscardPaysCost", "HandFreeThisTurn", "TriggerRally", "PlaceTrap", "GiveActiveTrap", "RecycleHand", "StampCostReduction", "RecycleFamily", "RecycleGodDrawAny",
  "AddSeeds", "TransformAllSeeds", "TransformSeed", "PlaceSeedsInFront", "TransformIntoSeed", "TransformIntoBush", "TransformSeedToBush", "TransformIntoButin", "TransformAllButins", "PlaceButinInFront",
  "PlaceGlyph", "PlaceTasDOs", "TransformTasDOs", "ConsumeTasDOsBuff", "DrawPerCreatureAround", "DamageEnemiesOnGlyphLines", "DestroyPrism", "DestroyBoardObject", "TransformObjectsToTraps", "PlaceBombe", "PlaceButin", "SpawnButinsOnStartCells", "DropButinStartRow", "GrabAllButins", "GrabButin", "TransformPrismToButin", "TransformPrismToBombe", "BounceGlyphs", "DestroyCardInOpponentHand",
  "ChangeRowSelf", "DestroyAllEnemyPrisms", "RamasserPrisme", "SacrificePrismBuff", "RevealDofuses", "SwapDofus", "MoveRowDofus", "ShuffleDofus", "BounceClosestOnRow", "BounceColumn", "SpendReserveCharge", "SacrificeForReserve", "DrawSummonFreeElseDiscard", "DestroyOwnGlyphs", "DestroyPrismOnRow", "AttractPrisms", "DiscardRandomHand", "MakeOwnDofusesInvulnerable",
  "ShieldDofusOnRow", "PlaceNowelGifts",
]);

// Player-state CONTRE COUP effects that fire even when the creature is killed by the hit (CONTRE COUP
// triggers "qu'elle survive OU MEURE"). These only touch the owner's own resources: seed reserve
// (Grine Piz #462), AP reserve (Momie #360), hand/deck/discard (Yugo #152/#51/#137, Megathon #159,
// Rabet #484, Arbre à Chachas #23, Tsu Tsu #1509, Khan Karkass #45, Prince Belimberbe #1379). So they
// need no living source on the board and can be replayed safely post-cull for the dying creature's
// owner. SummonToken (Boo #513, Empereur Gelax #422, Pissenlit Diabolique #1595) is left out on
// purpose: placing a token needs a board cell, and it is not confirmed whether a dying summoner
// spawns, so those keep their survive-only behaviour (fireContreCoup).
const POSTHUMOUS_PLAYER_STATE_CC: ReadonlySet<string> = new Set([
  "AddSeeds", "AddReserve", "DrawCards", "AddCardToHand", "TutorFromDeck", "RecoverFromDiscard",
]);

// Apply one player-state effect, returning the new state and whether it should end the turn
// (deferred so draws happen first). Shared by castSpell (spell cast) and runTrigger (APPARITION /
// MORT / … effects). `target` is only used by the bounce effects, which only exist on spell casts
// (in triggers they go through the pending-action path instead). `caster` is the side that owns the
// effect.
// Evaluate a player-state condition for the caster at resolution time.
// "outnumbered" = the caster controls strictly fewer living invocations than the opponent (not
// confirmed yet; only reserveAtLeast is used for now). Board-object conditions (Graines en jeu) wait
// for those systems.
// Exported for rule 15 of the AI: to detect at placement time that a conditional APPARITION
// (Kamasutar "si main < 4") can never fire, with the same evaluator as the engine, so the rule is
// not duplicated.
export function conditionMet(state: GameState, caster: Side, cond: PlayerCondition, selfId?: number): boolean {
  if (cond.kind === "reserveAtLeast") {
    return state.players[caster].apReserve >= cond.value;
  }
  if (cond.kind === "reserveEmpty") {
    // "si elle est vide", the caster's AP reserve is at 0 (Lomega).
    return state.players[caster].apReserve <= 0;
  }
  if (cond.kind === "discardAtLeast") {
    // "si vous avez au moins N cartes dans votre défausse" (Baron Sramedi).
    return state.players[caster].discard.length >= cond.value;
  }
  if (cond.kind === "handBelow") {
    // "si vous avez moins de N cartes en main" (Kamasutar #92), evaluated at trigger
    // time, after the card itself has already left the hand.
    return state.players[caster].hand.length < cond.value;
  }
  if (cond.kind === "noDofusDestroyed") {
    // "tant qu'aucun de vos Dofus n'a été détruit" (Julith Jurgen), all BOARD_ROWS
    // of the caster's Dofus are still alive on the board.
    return state.dofuses.filter((d) => d.owner === caster && d.currentLife > 0).length >= BOARD_ROWS;
  }
  if (cond.kind === "enemyAheadOnRow") {
    // "si une invocation adverse se trouve devant lui" (Cavalier Nimbos), a living
    // enemy on the same row, ahead of the source in its advance direction.
    const me = selfId != null ? state.creatures.find((c) => c.instanceId === selfId) : undefined;
    if (!me) return false;
    const dx = forwardDx(caster);
    return state.creatures.some((c) => c.currentLife > 0 && c.owner !== caster && c.position.y === me.position.y && (c.position.x - me.position.x) * dx > 0);
  }
  if (cond.kind === "outnumbered") {
    const mine = state.creatures.filter((c) => c.owner === caster && c.currentLife > 0).length;
    const foe = state.creatures.filter((c) => c.owner === other(caster) && c.currentLife > 0).length;
    return mine < foe;
  }
  if (cond.kind === "seedInPlay") {
    // "si vous avez une Graine en jeu", the caster owns at least one seed
    // planted on the board (reserve seeds do not count, they are not "en jeu").
    return (state.seeds ?? []).some((s) => s.owner === caster);
  }
  if (cond.kind === "tasDOsInPlay") {
    // "si vous avez un Tas d'Os allié en jeu" (Chafer Traqueur #617), the caster owns ≥1 tas d'os.
    return (state.tasDOs ?? []).some((t) => t.owner === caster);
  }
  if (cond.kind === "glyphInPlay") {
    // "si un Glyphe allié est en jeu", the caster owns at least one Glyphe.
    const min = cond.value ?? 1;
    return (state.glyphs ?? []).filter((g) => g.owner === caster).length >= min;
  }
  if (cond.kind === "woundedAllyInPlay") {
    // "si une invocation alliée est blessée": the caster owns at least one living creature below its max
    // life (currentLife < baseLife). "alliée" includes the source itself (the text says "une", not "une
    // autre"). This is the engine's usual definition of wounded (castTarget …Wounded, the count-spec
    // `wounded` filter): blessée means it has taken damage.
    return state.creatures.some((c) => c.owner === caster && c.currentLife > 0 && c.currentLife < c.baseLife);
  }
  if (cond.kind === "allyFamilyInPlay") {
    // "si vous avez un autre <famille> en jeu", the caster owns ≥1 living
    // creature of that family. excludeSelf drops the source (the "autre"), so a
    // Iop checking "un autre Iop" needs a second Iop, not just itself.
    return state.creatures.some(
      (c) =>
        c.owner === caster &&
        c.currentLife > 0 &&
        !(cond.excludeSelf && selfId != null && c.instanceId === selfId) &&
        (cond.cardIds ? cond.cardIds.includes(c.cardId) : (famsOf(c)).includes(cond.family!)),
    );
  }
  return false;
}

// Roi des Truches #282 (NullifyFamilyMovePowers {family}): true when `me` belongs to that
// family and a different living ally carries the marker, its ChangeRowSelf (row change)
// and GiveSelfToOpponent (owner change) are then nullified.
function familyMovePowersNullified(me: CreatureInstance, creatures: readonly CreatureInstance[]): boolean {
  const myFams = getCard(me.cardId)?.families ?? [];
  if (myFams.length === 0) return false;
  return creatures.some((c) => {
    if (c.currentLife <= 0 || c.owner !== me.owner || c.instanceId === me.instanceId) return false;
    const m = (getCard(c.cardId)?.effects ?? []).find((x) => x.type === "NullifyFamilyMovePowers") as { family?: string } | undefined;
    return !!m?.family && myFams.includes(m.family);
  });
}

function applyPlayerStateEffect(
  state: GameState,
  e: Effect,
  caster: Side,
  target?: Coords,
  selfCell?: Coords,
  rng?: Rng,
): { state: GameState; endsTurn: boolean } {
  let result = state;
  let endsTurn = false;
  if (e.type === "DrawCards") {
    // "Votre adversaire pioche N cartes" (Maskemane #424, Phorreur #168…): the
    // opponent is the drawer. The conditional bonus is still evaluated for the
    // card's owner (caster), never the forced drawer.
    const drawer = (e as { side?: "enemy" }).side === "enemy" ? other(caster) : caster;
    let n = Math.max(0, ((e as { amount?: number }).amount ?? 0) | 0);
    // Conditional bonus: "Piochez A carte(s) ou A+B si <condition>". The extra
    // `bonus` cards are drawn only when the player-state condition holds at cast.
    const cond = (e as { condition?: PlayerCondition }).condition;
    const bonus = Math.max(0, ((e as { bonus?: number }).bonus ?? 0) | 0);
    if (cond && bonus > 0 && conditionMet(result, caster, cond)) n += bonus;
    // costMod ("elle coûte N PA de moins", Pioche Antique) stamps the freshly
    // drawn card's hand slot. Applied per draw on the actually-drawn card (skips
    // burned overflow, which never enters the hand).
    const costMod = ((e as { costMod?: number }).costMod ?? 0) | 0;
    for (let i = 0; i < n; i++) {
      const before = result.players[drawer].hand.length;
      result = drawCard(result, drawer);
      if (costMod !== 0 && result.players[drawer].hand.length > before) {
        const p = result.players[drawer];
        const mods = [...p.handCostMods];
        mods[mods.length - 1] = (mods[mods.length - 1] ?? 0) + costMod;
        result = { ...result, players: { ...result.players, [drawer]: { ...p, handCostMods: mods } } };
      }
    }
  } else if (e.type === "ChangeRowSelf") {
    // "Change de ligne" (Truche, reacting to an enemy summon): the creature moves to an adjacent free cell
    // of its own column, one row up or down only (a Truche cannot jump 2 rows). Does nothing if both
    // neighbours are taken / off the board. `selfCell` is the reactor's current position (passed by the
    // trigger path).
    if (selfCell) {
      const me = result.creatures.find((c) => c.currentLife > 0 && c.position.x === selfCell.x && c.position.y === selfCell.y);
      // Roi des Truches #282 nullifies this ability for the owner's other Truches.
      if (me && !familyMovePowersNullified(me, result.creatures) && !isImmovable(me.properties)) { // INAMOVIBLE: a row-change is a relocation, blocked
        const taken = new Set(result.creatures.filter((c) => c.currentLife > 0 && c.position.x === selfCell.x).map((c) => c.position.y));
        const free: number[] = [];
        for (const y of [selfCell.y - 1, selfCell.y + 1]) if (y >= 0 && y < BOARD_ROWS && !taken.has(y)) free.push(y);
        if (free.length > 0) {
          // No rng given: seed from the state and store the advanced state back (same idiom as
          // moveToRandomAdjacentRow), never the global generator.
          const roll = rng ?? new Rng(result.rng);
          const y = free[roll.int(free.length)];
          if (!rng) result = { ...result, rng: roll.state };
          // The dodge is a relocation that picks up the landing cell's object (seed/piège/butin/glyphe/tas
          // d'os/prisme), a full walk-over. relocateThenPickup moves it, applies the pickup and settles
          // deaths/prisms at the GameState level (result here is a GameState).
          result = relocateThenPickup(result, me.instanceId, selfCell.x, y);
        }
      }
    }
  } else if (e.type === "CrossDraw") {
    // "Chaque joueur pioche N carte(s) chez son adversaire" (Echaenge, Bowne
    // Piauch): both players draw off the other player's deck into their own hand.
    const n = Math.max(0, ((e as { amount?: number }).amount ?? 0) | 0);
    const opp = other(caster);
    for (let i = 0; i < n; i++) {
      result = drawCardFrom(result, caster, opp); // you draw from the opponent's pile
      result = drawCardFrom(result, opp, caster); // the opponent draws from yours
    }
  } else if (e.type === "MillDeck") {
    // "Défausse les N premières cartes de sa pioche" (mill the top of the deck into the discard). `both`
    // → every player mills their own deck (Rituel Sram, Gredin); otherwise only the caster. `perCreature`
    // → N is that side's living creature count (Gredin), otherwise the fixed `amount`. Top of deck = last
    // element (pop), same as drawCard. Stops early on an empty deck.
    const both = !!(e as { both?: boolean }).both;
    const perCreature = !!(e as { perCreature?: boolean }).perCreature;
    const fixed = Math.max(0, ((e as { amount?: number }).amount ?? 0) | 0);
    const sides: Side[] = both ? ["ally", "enemy"] : [caster];
    for (const side of sides) {
      const cnt = perCreature
        ? result.creatures.filter((c) => c.owner === side && c.currentLife > 0).length
        : fixed;
      if (cnt <= 0) continue;
      const p = result.players[side];
      const deck = [...p.deck];
      const discard = [...p.discard];
      // Keep deckCostMods the same length as deck: milled cards go to the discard (their stamp is dropped),
      // but the remaining deck must stay aligned so later draws keep their Vampyro/HORDE −1.
      const mods = p.deckCostMods && p.deckCostMods.length === p.deck.length ? [...p.deckCostMods] : p.deck.map(() => 0);
      // `family` (Funérailles "Défausse 3 Srams de votre pioche") → discard the
      // first N cards of that family, scanning from the deck top (last element)
      // down; else just the top N.
      const fam = (e as { family?: string }).family;
      if (fam) {
        for (let i = deck.length - 1; i >= 0 && discard.length - p.discard.length < cnt; i--) {
          if ((getCard(deck[i])?.families ?? []).includes(fam)) { discard.push(deck[i]); deck.splice(i, 1); mods.splice(i, 1); }
        }
      } else {
        for (let i = 0; i < cnt && deck.length > 0; i++) { discard.push(deck.pop()!); mods.pop(); }
      }
      result = { ...result, players: { ...result.players, [side]: { ...p, deck, discard, deckCostMods: mods } } };
    }
  } else if (e.type === "StealDiscard") {
    // "Déplace les cartes de la défausse de votre adversaire dans la votre"
    // (Fosscheur): the opponent's whole discard pile is appended to the caster's,
    // and the opponent's is emptied.
    const opp = other(caster);
    const myP = result.players[caster];
    const oppP = result.players[opp];
    result = {
      ...result,
      players: {
        ...result.players,
        [caster]: { ...myP, discard: [...myP.discard, ...oppP.discard] },
        [opp]: { ...oppP, discard: [] },
      },
    };
  } else if (e.type === "StealTopDraw") {
    // "Piochez N chez votre adversaire, votre adversaire pioche N" (Escroc): you
    // take the top of the OPPONENT's deck, then the opponent draws off their own.
    const n = Math.max(0, ((e as { amount?: number }).amount ?? 0) | 0);
    const noRedraw = !!(e as { noRedraw?: boolean }).noRedraw;
    const opp = other(caster);
    for (let i = 0; i < n; i++) {
      result = drawCardFrom(result, caster, opp); // you steal their top card
      if (!noRedraw) result = drawCard(result, opp); // they draw a fresh one (unless pure steal)
    }
  } else if (e.type === "DrawFiltered") {
    // "Piochez N cartes. Si ce n'est pas une invocation/sort, défaussez-la"
    // (Abigaël): draw the top card; keep it in hand if its type matches, else
    // send it straight to the discard.
    const n = Math.max(0, ((e as { amount?: number }).amount ?? 0) | 0);
    const keep = (e as { keep?: string }).keep === "spell" ? "Spell" : "Summon";
    // Family variant (Tofoune #106 / Tofu Céleste #415): keep only cards of `keepFamily`.
    const keepFamily = (e as { keepFamily?: string }).keepFamily;
    for (let i = 0; i < n; i++) {
      const p0 = result.players[caster];
      if (p0.deck.length === 0) break;
      // Take the top card and its deck stamp together so deckCostMods stays aligned and the kept card keeps
      // its Vampyro/HORDE −1.
      const { player: p, cardId: drawn, costMod: drawnMod } = removeFromDeckAt(p0, p0.deck.length - 1);
      const dc = getCard(drawn);
      const matches = keepFamily ? (dc?.families ?? []).includes(keepFamily) : dc?.cardType === keep;
      result = {
        ...result,
        players: {
          ...result.players,
          // A non-matching drawn card is discarded, to tokenDiscard if it is a token.
          [caster]: matches ? p : discardCardFor(p, drawn),
        },
      };
      if (matches) {
        result = logDeckToHand(result, caster, drawn);
        result = addCardToHand(result, caster, drawn, 1, drawnMod);
      } else {
        // Set aside: it still leaves the deck and falls into the discard, so the replay animates it like a
        // card going to the graveyard (CARD_MOVED deck→discard).
        result = { ...result, log: [...result.log, { type: "CARD_MOVED", cardId: drawn, from: "deck", to: "discard", side: caster }] };
      }
    }
  } else if (e.type === "DrawUpTo") {
    // "Chaque joueur pioche jusqu'à avoir N cartes en main", both players
    // draw until their hand reaches N (or their deck runs out).
    const n = Math.max(0, ((e as { amount?: number }).amount ?? 0) | 0);
    for (const sd of ["ally", "enemy"] as Side[]) {
      let guard = MAX_HAND + 1; // safety against any pathological loop
      while (result.players[sd].hand.length < n && result.players[sd].deck.length > 0 && guard-- > 0) {
        result = drawCard(result, sd);
      }
    }
  } else if (e.type === "EndTurn") {
    endsTurn = true; // defer: draws first, then end the turn
  } else if (e.type === "ReturnToHand" || e.type === "ReturnToDeck") {
    const to = e.type === "ReturnToHand" ? "hand" : "deck";
    const scope = (e as { scope?: AoeScope }).scope;
    if (scope) {
      // Mass bounce ("Remonte TOUTES les invocations dans la main de leur
      // propriétaire", Art Du Fourrage; or "les AUTRES invocations dans votre
      // camp", Veuve Noire). Snapshot the cells first, then bounce each living
      // creature in scope. bounceCreature only removes its own target, so the
      // captured coords stay valid through the fold; each card returns to its
      // OWNER's hand/deck (overflow → discard, MAX_HAND honoured). `excludeSelf`
      // skips the source (found via selfCell, the trigger owner's cell).
      const excludeSelf = (e as { excludeSelf?: boolean }).excludeSelf;
      const inScope = (c: CreatureInstance): boolean => {
        switch (scope) {
          case "allies": return c.owner === caster;
          case "enemies": return c.owner === other(caster);
          case "own_camp": return isAlliedTerritory(c.position.x, caster);
          case "enemy_camp": return isAlliedTerritory(c.position.x, other(caster));
          default: return true; // "all"
        }
      };
      const targets = result.creatures.filter(
        (c) =>
          c.currentLife > 0 &&
          inScope(c) &&
          !(excludeSelf && selfCell && sameCoords(c.position, selfCell)),
      );
      // Art Du Fourrage etc.: sending back to hand/deck is an area move, so it applies in sweep order: the
      // first cell (the caster's front) then row by row L1→L5. This order holds for the mechanics and for
      // the animation (the replay plays the log in order).
      targets.sort((a, b) =>
        caster === "ally"
          ? (a.position.x - b.position.x) || (a.position.y - b.position.y)
          : (b.position.x - a.position.x) || (b.position.y - a.position.y),
      );
      for (const c of targets) result = bounceCreature(result, c.position, to);
    } else if ((e as { self?: boolean }).self && selfCell) {
      // Self-bounce on a trigger (Elo Baine "remonte dans votre main"): the
      // source returns to its OWNER's hand/deck. selfCell = the trigger owner's
      // cell. `toSide` redirects (e.g. to the opponent's hand) if set.
      const ts = (e as { toSide?: "caster" | "opponent" }).toSide;
      const side = ts === "caster" ? caster : ts === "opponent" ? other(caster) : undefined;
      result = bounceCreature(result, selfCell, to, side);
    } else if (target) {
      // Direct-target bounce (Bellaphone #356 targetKiller "remonte le tueur dans VOTRE
      // main"): `toSide` redirects to the caster/opponent's hand (default = owner's).
      const ts = (e as { toSide?: "caster" | "opponent" }).toSide;
      const side = ts === "caster" ? caster : ts === "opponent" ? other(caster) : undefined;
      result = bounceCreature(result, target, to, side);
    }
  } else if (e.type === "RecycleHand") {
    // "Place votre main sous votre pioche. Piochez autant." (Martingale): the
    // whole hand goes to the bottom of the deck (index 0, drawn last), then you
    // draw the same count, i.e. swap your hand for that many fresh top cards.
    const p = result.players[caster];
    const n = p.hand.length;
    // Hand → deck bottom (index 0). Carry each hand card's stamp into deckCostMods at the same (front)
    // positions so the recycled cards keep their Vampyro/HORDE −1 (under the deck, not discarded) and the
    // array stays aligned for the n new draws below.
    const baseDeckMods = p.deckCostMods && p.deckCostMods.length === p.deck.length ? p.deckCostMods : p.deck.map(() => 0);
    const handMods = p.hand.map((_, i) => p.handCostMods[i] ?? 0);
    let r = {
      ...result,
      // handCostTempMods is indexed 1:1 on the hand (see effectiveCost). The whole hand goes under the deck,
      // so the temporary stamp no longer points at anything and has to go, otherwise it would apply again
      // to the n cards drawn after.
      players: { ...result.players, [caster]: { ...p, hand: [], handCostMods: [], handCostTempMods: undefined, deck: [...p.hand, ...p.deck], deckCostMods: [...handMods, ...baseDeckMods] } },
    };
    for (let i = 0; i < n; i++) r = drawCard(r, caster);
    result = r;
  } else if (e.type === "AddSeeds") {
    // "Ajoute N Graine(s) à votre réserve de graines", bank N seeds, capped at
    // SEED_CAP (10). `amount` may be a dynamic board count ("autant que
    // d'invocations adverses en jeu", Révolte Naturelle); the player-state loop
    // does not run resolveCounts, so resolve it here against the live board. `side`
    // is the caster by default (every current card adds to "votre" reserve).
    const side: Side = (e as { side?: string }).side === "enemy" ? other(caster) : caster;
    const amtSpec = (e as { amount?: number | { count: import("../data/types").CountSpec; per?: number } }).amount;
    const amount =
      amtSpec && typeof amtSpec === "object" && "count" in amtSpec
        ? resolveCountValue(amtSpec, result.creatures, caster)
        : Math.max(0, ((amtSpec as number) ?? 0) | 0);
    const p = result.players[side];
    result = {
      ...result,
      players: { ...result.players, [side]: { ...p, seedReserve: Math.min(SEED_CAP, (p.seedReserve ?? 0) + amount) } },
    };
  } else if (e.type === "TransformAllSeeds") {
    // "Transforme vos Graines en <token>" (Graines de Folie/Sacrifice): each of
    // the caster's planted seeds becomes the token creature on its own cell,
    // owned by the caster and summoning-sick (summonCreature handles the sickness
    // + APPARITION). We remove all the caster's seeds first, then summon on each
    // freed cell. Enemy seeds are untouched.
    const tokenId = (e as { tokenId?: number }).tokenId;
    const token = tokenId != null ? getCard(tokenId) : undefined;
    if (token) {
      const mySeedCells = (result.seeds ?? []).filter((s) => s.owner === caster).map((s) => ({ ...s.position }));
      result = { ...result, seeds: (result.seeds ?? []).filter((s) => s.owner !== caster) };
      for (const cell of mySeedCells) result = summonCreature(result, token, cell, caster, false);
    }
  } else if (e.type === "TransformAllButins") {
    // "Transforme vos Butins en <token>" (Corruption): each of the caster's Butins
    // becomes the token creature on its own cell (owned by the caster, summoning-
    // sick). Remove the caster's butins first so summonCreature does not re-grab
    // them; enemy butins are untouched. Mirror of TransformAllSeeds.
    const tokenId = (e as { tokenId?: number }).tokenId;
    const token = tokenId != null ? getCard(tokenId) : undefined;
    if (token) {
      const myButinCells = (result.butins ?? []).filter((b) => b.owner === caster).map((b) => ({ ...b.position }));
      result = { ...result, butins: (result.butins ?? []).filter((b) => b.owner !== caster) };
      for (const cell of myButinCells) result = summonCreature(result, token, cell, caster, false);
    }
  } else if (e.type === "PlaceButinInFront") {
    // "Déterre un Butin allié sur la case devant lui" (Forbank, FIN DU TOUR): place
    // a caster Butin on the cell directly ahead of the source (toward the enemy),
    // if that cell is on-board and free (no creature / Dofus / butin). selfCell =
    // the source's (post-move) position.
    if (selfCell) {
      const dx = caster === "ally" ? -1 : 1;
      const x = selfCell.x + dx, y = selfCell.y;
      const free = x >= 0 && x < BOARD_COLS &&
        !result.creatures.some((c) => c.currentLife > 0 && c.position.x === x && c.position.y === y) &&
        !result.dofuses.some((d) => d.currentLife > 0 && d.position.x === x && d.position.y === y) &&
        !cellHasGroundObject(result, { x, y }); // one object per cell
      if (free) {
        result = {
          ...result,
          butins: [...(result.butins ?? []), { position: { x, y }, owner: caster }],
          log: [...result.log, { type: "NEW_A_O_E", at: { x, y }, ownerSide: caster, aoeType: "loot" }],
        };
      }
    }
  } else if (e.type === "PlaceSeedsInFront") {
    // "Fait apparaître N Graines sur les cases de la rangée devant lui" (Rôdeur Sylvestre #907
    // APPARITION): one seed in front of it, and on the cells next to that seed in the same rangée, 3 in
    // all. The rangée is the vertical line (same x, see the board vocabulary), so the pattern is the
    // column in front, not the straight row:
    //
    //     . . G . R          G = seed, R = Rôdeur (ally, facing decreasing x)
    //     . . G . .
    //     . . G . .
    //
    // The anchor is the cell right in front (x+dx, y), then its two neighbours in that column (y−1,
    // y+1). At the edge of the board there is only one neighbour, so only 2 seeds fall: the effect
    // follows the adjacency it describes and does not reach further to make up its count. Occupied
    // cells (creature / Dofus / ground object) are skipped too, so fewer than N may fall.
    const count = Math.max(0, ((e as { count?: number }).count ?? 0) | 0);
    if (selfCell && count > 0) {
      const dx = caster === "ally" ? -1 : 1;
      const x = selfCell.x + dx;
      const ys = [selfCell.y, selfCell.y - 1, selfCell.y + 1]
        .filter((y) => y >= 0 && y < BOARD_ROWS)
        .slice(0, count);
      const seeds: SeedInstance[] = [...(result.seeds ?? [])];
      let prisms = result.prisms;
      const placedLog: GameEvent[] = [];
      for (const y of ys) {
        const cell = { x, y };
        if (cell.x < 0 || cell.x >= BOARD_COLS) break; // colonne hors plateau → rien à poser
        if (result.creatures.some((c) => c.currentLife > 0 && sameCoords(c.position, cell))) continue;
        if (result.dofuses.some((d) => sameCoords(d.position, cell))) continue;
        if (cellHasGroundObject(result, cell) || seeds.some((s) => sameCoords(s.position, cell))) continue; // one object per cell
        seeds.push({ position: cell, owner: caster });
        // A prism on this cell is destroyed (no bonus) by the seed landing on it.
        prisms = prisms.filter((pr) => !sameCoords(pr.position, cell));
        placedLog.push({ type: "SEED_PLANTED", at: { ...cell }, ownerSide: caster });
      }
      const prismsDestroyed = prisms.length < result.prisms.length;
      if (placedLog.length > 0) result = recomputeAuras({ ...result, seeds, prisms, log: [...result.log, ...placedLog] });
      // Destroying a prism (by any means) charges ON_PRISM reactors (Lilotte #579), once per event.
      if (prismsDestroyed) result = fireOnPrismReactions(result);
    }
  } else if (e.type === "TransformIntoSeed") {
    // "Transforme une invocation en Graine alliée" (Savoir Sadida): the targeted
    // creature (any side, castTarget AnySummon) is removed and replaced by one
    // of the caster's seeds on its cell. A transformation, not a death: no MORT
    // trigger and no discard (the card simply leaves the board). recomputeAuras
    // handles a chief leaving and the new seed granting ConditionalSeedProperty.
    if (target) {
      const c = result.creatures.find((cr) => cr.currentLife > 0 && sameCoords(cr.position, target));
      if (c) {
        // One object per cell: strip any object already on the creature's cell (e.g. a glyph it
        // was standing on) before the seed takes its place.
        const rem: GameEvent[] = [];
        result = replaceGroundObjectsAt(result, c.position, rem);
        const seeds = [...(result.seeds ?? []), { position: { ...c.position }, owner: caster }];
        result = recomputeAuras({
          ...result,
          creatures: result.creatures.filter((cr) => cr.instanceId !== c.instanceId),
          seeds,
          log: [
            ...result.log,
            ...rem,
            { type: "FIGHT_OBJECT_REMOVED", instanceId: c.instanceId, transformed: true },
            { type: "SEED_PLANTED", at: { ...c.position }, ownerSide: caster },
          ],
        });
      }
    }
  } else if (e.type === "TransformIntoBush") {
    // Polter #399 (CONTRE COUP): the targeted creature (the attacker) is removed and
    // replaced by one of the CASTER's Buissons (spawn point) on its cell, a
    // transformation, not a death (no MORT, no discard). recomputeAuras handles a
    // chief leaving the board.
    if (target) {
      const c = result.creatures.find((cr) => cr.currentLife > 0 && sameCoords(cr.position, target));
      if (c) {
        const rem: GameEvent[] = [];
        result = replaceGroundObjectsAt(result, c.position, rem); // one object per cell
        const bushes = [...(result.bushes ?? []), { position: { ...c.position }, owner: caster }];
        result = recomputeAuras({
          ...result,
          creatures: result.creatures.filter((cr) => cr.instanceId !== c.instanceId),
          bushes,
          log: [
            ...result.log,
            ...rem,
            { type: "FIGHT_OBJECT_REMOVED", instanceId: c.instanceId, transformed: true },
            { type: "NEW_A_O_E", at: { ...c.position }, ownerSide: caster, aoeType: "bush" },
          ],
        });
      }
    }
  } else if (e.type === "TransformIntoButin") {
    // "Transforme une invocation en Butin allié" (Main de Nidas): the targeted
    // creature (any side, castTarget AnySummon) is removed and replaced by one of
    // the caster's Butins on its cell. A transformation, not a death (no MORT, no
    // discard). recomputeAuras handles a chief leaving the board.
    if (target) {
      const c = result.creatures.find((cr) => cr.currentLife > 0 && sameCoords(cr.position, target));
      if (c) {
        const rem: GameEvent[] = [];
        result = replaceGroundObjectsAt(result, c.position, rem); // one object per cell
        const butins = [...(result.butins ?? []), { position: { ...c.position }, owner: caster }];
        result = recomputeAuras({
          ...result,
          creatures: result.creatures.filter((cr) => cr.instanceId !== c.instanceId),
          butins,
          log: [
            ...result.log,
            ...rem,
            // `transformed`: not a death. The replay plays the transformation (FX gen_transformation), not the
            // death animation/sound or the flight to the discard.
            { type: "FIGHT_OBJECT_REMOVED", instanceId: c.instanceId, transformed: true },
            { type: "NEW_A_O_E", at: { ...c.position }, ownerSide: caster, aoeType: "loot" },
          ],
        });
      }
    }
  } else if (e.type === "TransformSeed") {
    // "Transforme UNE de vos Graines en <token>", the picked cell (`target`)
    // must carry one of the caster's own seeds: remove it and summon the token
    // creature there (summoning-sick). No-op if the cell has no allied seed (the
    // pick/target validation normally guarantees one, but stay safe).
    const tokenId = (e as { tokenId?: number }).tokenId;
    const token = tokenId != null ? getCard(tokenId) : undefined;
    const seedHere = target && (result.seeds ?? []).some((s) => s.owner === caster && sameCoords(s.position, target));
    if (token && target && seedHere) {
      result = { ...result, seeds: (result.seeds ?? []).filter((s) => !(s.owner === caster && sameCoords(s.position, target))) };
      result = summonCreature(result, token, target, caster, false);
    }
  } else if (e.type === "TransformSeedToBush") {
    // "Transforme une Graine alliée en Buisson" (Buisson #214 / Selk Ator #108):
    // the picked cell must carry one of the caster's seeds, replace it with a
    // Buisson (board object / spawn point) owned by the caster. recomputeAuras
    // since losing the seed may revoke a ConditionalSeedProperty.
    const seedHere = target && (result.seeds ?? []).some((s) => s.owner === caster && sameCoords(s.position, target));
    if (target && seedHere) {
      const seeds = (result.seeds ?? []).filter((s) => !(s.owner === caster && sameCoords(s.position, target)));
      const bushes = [...(result.bushes ?? []), { position: { ...target }, owner: caster }];
      result = recomputeAuras({
        ...result,
        seeds,
        bushes,
        log: [...result.log, { type: "NEW_A_O_E", at: { ...target }, ownerSide: caster, aoeType: "bush" }],
      });
    }
  } else if (e.type === "DrawPerCreatureAround") {
    // "fait piocher 1 carte par invocation autour du Glyphe" (Glyphe de
    // Renouveau): draw one card for the caster per creature (both camps) in the
    // 3×3 around the targeted cell.
    if (target) {
      const n = result.creatures.filter(
        (c) => c.currentLife > 0 && Math.abs(c.position.x - target.x) <= 1 && Math.abs(c.position.y - target.y) <= 1,
      ).length;
      for (let i = 0; i < n; i++) result = drawCard(result, caster);
    }
  } else if (e.type === "DamageEnemiesOnGlyphLines") {
    // "Vos Glyphes infligent N dégâts aux invocations adverses de leur ligne" (Crail APPARITION): each of
    // the caster's glyphs deals N to every enemy creature on that glyph's row (y). A creature on a row
    // that holds two of the caster's glyphs is therefore hit twice (→ 2N in total). One damage instance
    // is applied per glyph rather than adding N×count into a single hit, so the per-hit defensive
    // modifiers (Shield absorbs one full instance, Résistance/MoonGuard reduce each hit, DamageCap1 caps
    // each hit at 1) apply once per glyph. Damage + deaths resolve here.
    const amount = Math.max(0, ((e as { amount?: number }).amount ?? 0) | 0);
    const myGlyphs = (result.glyphs ?? []).filter((g) => g.owner === caster);
    if (amount > 0 && myGlyphs.length > 0) {
      const creatures = result.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
      const dofuses = result.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
      const log = [...result.log];
      for (const g of myGlyphs) {
        for (const c of creatures) {
          if (c.currentLife <= 0 || c.owner === caster) continue;
          if (c.position.y !== g.position.y) continue;
          const armorBefore = c.armor;
          const dealt = applyDamageToCreature(c, amount, log, false);
          const armorHit = armorBefore > c.armor;
          if (dealt > 0 || armorHit) log.push({ type: "DAMAGE", targetInstanceId: c.instanceId, damage: dealt, armorHit });
        }
      }
      result = resolveDeathsAndWin(result, creatures, dofuses, log, new Set());
    }
  } else if (e.type === "PlaceGlyph") {
    // GLYPHE spell (Glyphe Enflammé…): place a lasting Glyphe owned by the caster on the targeted (empty,
    // own-camp) cell. The "around" effect was already applied by applyEffects, centred on this same cell.
    // Placing it on a prism destroys that prism (a glyph and a prism cannot share a cell: the glyph
    // replaces it, exactly like PlaceTasDOs / plantSeed).
    if (target) {
      // One object per cell: any ground object already on the target, a glyph (casting again replaces it)
      // or another object (seed/butin/tas d'os/…), is replaced, so the walk-over AR and Crail's per-glyph
      // count never see two objects on one cell.
      const rem: GameEvent[] = [];
      result = replaceGroundObjectsAt(result, target, rem);
      const glyphs = [...(result.glyphs ?? []), { position: { ...target }, owner: caster }];
      const before = result.prisms.length;
      const prisms = result.prisms.filter((p) => !sameCoords(p.position, target));
      result = { ...result, glyphs, prisms, log: [...result.log, ...rem, { type: "NEW_A_O_E", at: { ...target }, ownerSide: caster, aoeType: "glyph" }] };
      // Destroying that prism charges ON_PRISM reactors (Lilotte #579).
      if (prisms.length < before) result = fireOnPrismReactions(result);
    }
  } else if (e.type === "PlaceTasDOs") {
    // Tas d'Os card (#691): place a Tas d'Os owned by the caster on the targeted (empty, own-camp) cell.
    // Placing it on a prism destroys that prism (the tas d'os replaces it on the cell); any ground
    // object already there is also replaced (one object per cell).
    if (target) {
      const rem: GameEvent[] = [];
      result = replaceGroundObjectsAt(result, target, rem);
      const tasDOs = [...(result.tasDOs ?? []), { position: { ...target }, owner: caster }];
      const before = result.prisms.length;
      const prisms = result.prisms.filter((p) => !sameCoords(p.position, target));
      result = { ...result, tasDOs, prisms, log: [...result.log, ...rem, { type: "NEW_A_O_E", at: { ...target }, ownerSide: caster, aoeType: "tasdos" }] };
      // Destroying that prism charges ON_PRISM reactors (Lilotte #579).
      if (prisms.length < before) result = fireOnPrismReactions(result);
    }
  } else if (e.type === "TransformTasDOs") {
    // Chafer Fantassin #738 (one) / Roi Chafer #147 (all): transform the caster's allied Tas d'Os into a
    // Chafer Décrépit (#313) on its cell. The Tas d'Os is removed first so the new creature does not use
    // it up again when it lands.
    const all = !!(e as { all?: boolean }).all;
    const mine = (result.tasDOs ?? []).filter((t) => t.owner === caster);
    const toTransform = all ? mine : mine.slice(0, 1);
    if (toTransform.length > 0) {
      const cells = toTransform.map((t) => ({ ...t.position }));
      result = { ...result, tasDOs: (result.tasDOs ?? []).filter((t) => !toTransform.includes(t)) };
      const token = getCard(313); // Chafer Décrépit
      if (token) for (const cell of cells) result = summonCreature(result, token, cell, caster, false);
    }
  } else if (e.type === "ConsumeTasDOsBuff") {
    // Chafer d'Elite #223 (scope self) / Chafer Hallebardier #626 (scope chafers):
    // DESTROY one allied Tas d'Os to grant a stat buff. No allied tas d'os → nothing.
    const eff = e as { scope: "self" | "chafers"; attack?: number; armor?: number; movement?: number };
    const mine = (result.tasDOs ?? []).filter((t) => t.owner === caster);
    if (mine.length > 0) {
      const da = eff.attack ?? 0, dr = eff.armor ?? 0, dm = eff.movement ?? 0;
      const log = [...result.log];
      const creatures = result.creatures.map((c) => {
        const isSource = !!selfCell && sameCoords(c.position, selfCell);
        const hit = c.currentLife > 0 && c.owner === caster && (eff.scope === "self"
          ? isSource
          : !isSource && (famsOf(c)).includes("Chafer"));
        if (!hit) return c;
        const nc = { ...c, currentAttack: c.currentAttack + da, baseAttack: c.baseAttack + da, armor: c.armor + dr, baseMovement: c.baseMovement + dm };
        if (da) log.push({ type: "ATTACK_GAINED", instanceId: c.instanceId, attackMod: { valueBefore: c.currentAttack, modification: da, valueAfter: nc.currentAttack } });
        if (dr) log.push({ type: "ARMOR_GAINED", instanceId: c.instanceId, armorMod: { valueBefore: c.armor, modification: dr, valueAfter: nc.armor } });
        return nc;
      });
      result = { ...result, creatures, tasDOs: (result.tasDOs ?? []).filter((t) => t !== mine[0]), log };
    }
  } else if (e.type === "PlaceButin") {
    const placed = [...(result.butins ?? [])];
    if ((e as { onTargetCell?: boolean }).onTargetCell) {
      // Pelle Sismique #1104: dig the Butin on the exact targeted cell, on any side of the board. The row's
      // area damage + death resolution have already run (this is a player-state effect, applied after
      // resolveDeathsAndWin), so the cell can be taken if no living creature and no Dofus remain on it: an
      // enemy that died frees its cell (the Butin appears), while an ally or an enemy that survived blocks
      // it (no Butin). Any board object on the cell is destroyed and replaced by the Butin.
      const tx = target?.x, ty = target?.y;
      const here = (p: { x: number; y: number }) => p.x === tx && p.y === ty;
      const blocked =
        target == null ||
        result.creatures.some((c) => c.currentLife > 0 && here(c.position)) ||
        result.dofuses.some((d) => d.currentLife > 0 && here(d.position));
      if (!blocked) {
        result = {
          ...result,
          prisms: (result.prisms ?? []).filter((p) => !here(p.position)),
          seeds: (result.seeds ?? []).filter((s) => !here(s.position)),
          glyphs: (result.glyphs ?? []).filter((g) => !here(g.position)),
          traps: (result.traps ?? []).filter((t) => !here(t.position)),
          tasDOs: (result.tasDOs ?? []).filter((t) => !here(t.position)),
          bushes: (result.bushes ?? []).filter((b) => !here(b.position)),
          gifts: (result.gifts ?? []).filter((g) => !here(g.position)), // one object per cell, a Cadeau de Nowel is also cleared
          butins: [...placed.filter((b) => !here(b.position)), { position: { x: tx!, y: ty! }, owner: caster }],
          log: [...result.log, { type: "NEW_A_O_E", at: { x: tx!, y: ty! }, ownerSide: caster, aoeType: "loot" }],
        };
      }
    } else {
      // Generic Butin droppers (#789, Trouvaille #1382): place one Butin (owned by the
      // caster) on the targeted cell, only if it is a free cell of the caster's camp (no
      // creature / Dofus / seed / glyph / butin there). #1382 ("posez 2 butins") lands
      // its first here; castSpell then opens a pick for each remaining one.
      const free = (x: number, y: number): boolean =>
        isAlliedTerritory(x, caster) &&
        !result.creatures.some((c) => c.currentLife > 0 && c.position.x === x && c.position.y === y) &&
        !result.dofuses.some((d) => d.currentLife > 0 && d.position.x === x && d.position.y === y) &&
        !placed.some((b) => b.position.x === x && b.position.y === y) &&
        !cellHasGroundObject(result, { x, y }); // one object per cell, skip any occupied ground cell
      if (target && free(target.x, target.y)) {
        result = {
          ...result,
          butins: [...placed, { position: { x: target.x, y: target.y }, owner: caster }],
          log: [...result.log, { type: "NEW_A_O_E", at: { x: target.x, y: target.y }, ownerSide: caster, aoeType: "loot" }],
        };
      }
    }
  } else if (e.type === "PlaceNowelGifts") {
    // Reine de Nowel #703 (APPARITION). This may change: a very particular mechanic, rebuilt from the
    // rules as described, with no card data behind it.
    //
    //   1. Count: an equally likely draw picks 3, 4, 5 or 6 gifts. It is a raw rng.int(4)+3, not the
    //      "dice value" path, so Dé Pipé (diceFloor) does not bias it. This draw is not an "allied
    //      roll": it does not trigger Sentinelle/Atout (only using a gift does).
    //   2. Spread: over the whole board except the two start columns (x=1 enemy / x=8 ally). A cell must
    //      be free: no living creature, no Dofus, no ground object (seed/tas d'os/bush/glyph/butin/trap),
    //      no prism, and no gift already placed this turn (prismCellOccupied covers everything except
    //      prisms and gifts, which are tested here). The wall columns x=0/x=9 are only excluded when
    //      occupied (Dofus).
    //   3. Collision: cells are picked at random among the free eligible cells; if there are fewer free
    //      cells than gifts, only what fits is placed (nothing carried over).
    //   The pickup (a creature moving onto a gift) is handled elsewhere: outcome inline at the step
    //   (applyWalkOverPickups → applyGiftOutcomeInline, death on the gift cell) + roll reactions at
    //   settle time (applyGiftRollReactions); a summon placed on it → applyGiftPickups.
    if (!rng) {
      // No RNG in scope → cannot roll the count/placement reproducibly; skip (defensive: the
      // APPARITION path always threads one). Leaves the board untouched.
    } else {
      const count = 3 + rng.int(4); // 3..6, équiprobable, hors Dé Pipé
      // Build the pool of eligible free cells (excluding the two spawn columns).
      const eligible: Coords[] = [];
      const placed: import("./state").GiftInstance[] = [...(result.gifts ?? [])];
      const occupiedByGift = (c: Coords) => placed.some((g) => sameCoords(g.position, c));
      const occupiedByPrism = (c: Coords) => (result.prisms ?? []).some((p) => sameCoords(p.position, c));
      for (let x = 0; x < BOARD_COLS; x++) {
        if (x === 1 || x === 8) continue; // cases de départ (première rangée ennemie / alliée)
        for (let y = 0; y < BOARD_ROWS; y++) {
          const cell = { x, y };
          if (prismCellOccupied(result, cell) || occupiedByPrism(cell) || occupiedByGift(cell)) continue;
          eligible.push(cell);
        }
      }
      const log = [...result.log];
      const toPlace = Math.min(count, eligible.length);
      for (let i = 0; i < toPlace; i++) {
        // Pick a random remaining eligible cell (swap-remove so each is used once).
        const j = rng.int(eligible.length);
        const cell = eligible[j];
        eligible[j] = eligible[eligible.length - 1];
        eligible.pop();
        placed.push({ position: { ...cell }, owner: caster });
        log.push({ type: "NEW_A_O_E", at: { ...cell }, ownerSide: caster, aoeType: "gift" });
      }
      result = { ...result, gifts: placed, log };
    }
  } else if (e.type === "SpawnButinsOnStartCells") {
    // Dwanlaposh #802 (APPARITION): a caster-owned Butin appears on every free cell of the caster's start
    // column (ally x=8 / enemy x=1), replacing any prism there. The source gains +attackPerPrism AT and
    // +armorPerPrism AR (default 1/1) for each prism really replaced (a free cell with no prism still
    // gets a Butin, but gives no buff). Cells holding a living creature/Dofus or another board object
    // (Butin/seed/glyph/trap/Tas d'os) are skipped. Butins land on all free start cells; the buff only
    // counts the prisms replaced.
    const eff = e as { attackPerPrism?: number; armorPerPrism?: number };
    const da1 = eff.attackPerPrism ?? 1, dr1 = eff.armorPerPrism ?? 1;
    const baseX = caster === "ally" ? 8 : 1;
    const placed = [...(result.butins ?? [])];
    const log = [...result.log];
    let prisms = result.prisms;
    let prismsReplaced = 0;
    for (let y = 0; y < BOARD_ROWS; y++) {
      const cell = { x: baseX, y };
      const occupied =
        result.creatures.some((c) => c.currentLife > 0 && sameCoords(c.position, cell)) ||
        result.dofuses.some((d) => d.currentLife > 0 && sameCoords(d.position, cell)) ||
        placed.some((b) => sameCoords(b.position, cell)) ||
        (result.seeds ?? []).some((s) => sameCoords(s.position, cell)) ||
        (result.bushes ?? []).some((b) => sameCoords(b.position, cell)) ||
        (result.glyphs ?? []).some((g) => sameCoords(g.position, cell)) ||
        (result.traps ?? []).some((t) => sameCoords(t.position, cell)) ||
        (result.tasDOs ?? []).some((t) => sameCoords(t.position, cell)) ||
        (result.gifts ?? []).some((g) => sameCoords(g.position, cell)); // one object per cell
      if (occupied) continue;
      // Free cell → a Butin appears; a prism here is replaced (counts for the buff).
      if (prisms.some((p) => sameCoords(p.position, cell))) {
        prisms = prisms.filter((p) => !sameCoords(p.position, cell));
        prismsReplaced++;
      }
      placed.push({ position: { ...cell }, owner: caster });
      log.push({ type: "NEW_A_O_E", at: { ...cell }, ownerSide: caster, aoeType: "loot" });
    }
    let creatures = result.creatures;
    if (prismsReplaced > 0 && selfCell) {
      const da = prismsReplaced * da1, dr = prismsReplaced * dr1;
      creatures = creatures.map((c) => {
        if (c.currentLife <= 0 || !sameCoords(c.position, selfCell)) return c;
        const nc = { ...c, currentAttack: c.currentAttack + da, baseAttack: c.baseAttack + da, armor: c.armor + dr };
        if (da) log.push({ type: "ATTACK_GAINED", instanceId: c.instanceId, attackMod: { valueBefore: c.currentAttack, modification: da, valueAfter: nc.currentAttack } });
        if (dr) log.push({ type: "ARMOR_GAINED", instanceId: c.instanceId, armorMod: { valueBefore: c.armor, modification: dr, valueAfter: nc.armor } });
        return nc;
      });
    }
    result = { ...result, creatures, butins: placed, prisms, log };
    // A replaced prism left the board → ON_PRISM reactors (Lilotte #579) charge once,
    // like DestroyAllEnemyPrisms (one reaction per destroy event, not per prism).
    if (prismsReplaced > 0) result = fireOnPrismReactions(result);
  } else if (e.type === "DropButinStartRow") {
    // Coffres #711/#1320/#1634/#1275 "MORT : Dépose un Butin allié sur la première case de sa ligne":
    // drop a caster-owned Butin on the start cell of the dying creature's row (ally x=8 / enemy x=1, like
    // Dwanlaposh). The dead creature is already culled here, but the cell may hold another board object /
    // creature / Dofus; skip if occupied.
    if (selfCell) {
      const cell = { x: caster === "ally" ? 8 : 1, y: selfCell.y };
      const placed = [...(result.butins ?? [])];
      // A prism on the start cell is replaced by the Butin (the start columns carry a
      // prism per row, so otherwise the Butin would almost never appear); mirrors
      // Dwanlaposh #802, the only other Butin-on-start-cell card. A creature / Dofus /
      // other board object blocks the drop → no Butin.
      const occupied =
        result.creatures.some((c) => c.currentLife > 0 && sameCoords(c.position, cell)) ||
        result.dofuses.some((d) => d.currentLife > 0 && sameCoords(d.position, cell)) ||
        placed.some((b) => sameCoords(b.position, cell)) ||
        (result.seeds ?? []).some((s) => sameCoords(s.position, cell)) ||
        (result.bushes ?? []).some((b) => sameCoords(b.position, cell)) ||
        (result.glyphs ?? []).some((g) => sameCoords(g.position, cell)) ||
        (result.traps ?? []).some((t) => sameCoords(t.position, cell)) ||
        (result.tasDOs ?? []).some((t) => sameCoords(t.position, cell)) ||
        (result.gifts ?? []).some((g) => sameCoords(g.position, cell)); // one object per cell
      if (!occupied) {
        const prisms = (result.prisms ?? []).filter((p) => !sameCoords(p.position, cell));
        const replacedPrism = prisms.length < (result.prisms ?? []).length;
        result = {
          ...result,
          prisms,
          butins: [...placed, { position: { ...cell }, owner: caster }],
          log: [...result.log, { type: "NEW_A_O_E", at: { ...cell }, ownerSide: caster, aoeType: "loot" }],
        };
        // A replaced prism left the board → ON_PRISM reactors (Lilotte #579) charge
        // once, exactly like Dwanlaposh #802 (SpawnButinsOnStartCells) and DestroyPrism.
        if (replacedPrism) result = fireOnPrismReactions(result);
      }
    }
  } else if (e.type === "GrabAllButins") {
    // "Ramasse tous les Butins en jeu et gagne +1 AT par Butin ramassé"
    // (Bernalette): remove every butin on the board (both camps), grant the caster
    // one random reward per butin, and boost the SOURCE's AT by the butin count.
    // RNG is managed internally (new Rng(state.rng) → persist) like summonCreature.
    const count = (result.butins ?? []).length;
    if (count > 0) {
      result = { ...result, butins: [] };
      const r = new Rng(result.rng);
      for (let i = 0; i < count; i++) result = applyButinReward(result, caster, r);
      result = { ...result, rng: r.state };
      if (selfCell) {
        result = {
          ...result,
          creatures: result.creatures.map((c) =>
            c.currentLife > 0 && sameCoords(c.position, selfCell)
              ? { ...c, currentAttack: c.currentAttack + count, baseAttack: c.baseAttack + count }
              : c),
        };
      }
    }
  } else if (e.type === "GrabButin") {
    // Snouffle #225: "Ramassez N butin(s)", grab the N butins nearest the source
    // (any camp), each giving one random reward to the caster. No AT boost (that is
    // Bernalette's GrabAllButins). RNG seeded from state → persisted.
    const n = Math.max(0, ((e as { amount?: number }).amount ?? 1) | 0);
    let butins = [...(result.butins ?? [])];
    if (selfCell) {
      const d = (pos: Coords) => Math.abs(pos.x - selfCell.x) + Math.abs(pos.y - selfCell.y);
      butins = [...butins].sort((a, b) => d(a.position) - d(b.position));
    }
    const take = Math.min(n, butins.length);
    if (take > 0) {
      const r = new Rng(result.rng);
      result = { ...result, butins: butins.slice(take) };
      for (let i = 0; i < take; i++) result = applyButinReward(result, caster, r);
      result = { ...result, rng: r.state };
    }
  } else if (e.type === "DestroyOwnGlyphs") {
    // "Détruit vos glyphes" (Retour Du Bâton #1640): remove every Glyphe owned by the
    // caster from the board (no log event, the board re-renders from state.glyphs).
    result = { ...result, glyphs: (result.glyphs ?? []).filter((g) => g.owner !== caster) };
  } else if (e.type === "DestroyPrism") {
    // "Détruisez un prisme" (Patek Tag): remove the prism on the picked cell
    // (any side). The prism just disappears from state.prisms (no pickup bonus,
    // no log event, FIGHT_OBJECT_REMOVED carries no prism cell; the board
    // re-renders from state.prisms, exactly like plantSeed onto a prism).
    if (target) {
      const destroyed = result.prisms.find((p) => p.position.x === target.x && p.position.y === target.y);
      const prisms = result.prisms.filter(
        (p) => !(p.position.x === target.x && p.position.y === target.y),
      );
      const removed = prisms.length < result.prisms.length;
      result = { ...result, prisms };
      if (removed) result = fireOnPrismReactions(result); // Lilotte #579
      if (destroyed && destroyed.owner !== caster) result = applyEnemyPrismLossReactions(result, caster, 1); // Maluss #292
    }
  } else if (e.type === "DestroyBoardObject") {
    // Tournesol Sauvage #1082: remove the Seed/Trap/Butin/Glyphe/Tas d'os/Cadeau de Nowel on the picked
    // cell (only one object is ever on a cell). The gift is a ground object that can be targeted and
    // destroyed here. recomputeAuras: a removed seed may cancel a ConditionalSeedProperty.
    if (target) {
      const dropHere = <T extends { position: Coords }>(arr: T[] | undefined): T[] => (arr ?? []).filter((o) => !(o.position.x === target.x && o.position.y === target.y));
      result = recomputeAuras({
        ...result,
        seeds: dropHere(result.seeds), traps: dropHere(result.traps), butins: dropHere(result.butins),
        glyphs: dropHere(result.glyphs), tasDOs: dropHere(result.tasDOs), gifts: dropHere(result.gifts),
      });
    }
  } else if (e.type === "TransformObjectsToTraps") {
    // Kaotika #612: every Seed/Butin/Glyphe/Tas d'os (any side) is removed and replaced by an allied trap
    // (Bombe) on its cell. recomputeAuras: losing the seeds may cancel a ConditionalSeedProperty. Note:
    // the Cadeaux de Nowel are left out on purpose; Kaotika does not turn them into Bombes.
    const ef = e as { cardId?: number; damage?: number };
    const cells: Coords[] = [...(result.seeds ?? []), ...(result.butins ?? []), ...(result.glyphs ?? []), ...(result.tasDOs ?? [])].map((o) => ({ ...o.position }));
    if (cells.length > 0) {
      const newTraps: TrapInstance[] = cells.map((cell) => ({ position: cell, owner: caster, cardId: ef.cardId ?? 0, damage: Math.max(0, ef.damage ?? 0) }));
      result = recomputeAuras({
        ...result,
        seeds: [], butins: [], glyphs: [], tasDOs: [],
        traps: [...(result.traps ?? []), ...newTraps],
      });
    }
  } else if (e.type === "PlaceBombe") {
    // Remington Smisse #178/#334 (MORT) : lay `count` Bombe trap(s) (cardId 101,
    // damage 2) owned by the SOURCE'S side (so enemies of Remington jump on them).
    // `selfCell` = the dying Remington's cell (already freed by resolveDeathsAndWin).
    //  - placement "self" (#178): one trap on selfCell.
    //  - placement "around" (#334): up to `count` traps on free cells in priority
    //    order [up (x,y-1), down (x,y+1), front (forwardDx), back (-forwardDx)].
    //    "Free" = on the walkable board and no creature, Dofus, or existing trap there.
    const ef = e as { count?: number; placement?: "self" | "around" };
    const count = Math.max(0, (ef.count ?? 1) | 0);
    if (selfCell && count > 0) {
      const isFree = (cell: Coords): boolean => {
        if (cell.y < 0 || cell.y >= BOARD_ROWS) return false;
        if (cell.x <= 0 || cell.x >= BOARD_COLS - 1) return false; // exclude wall columns / off-board
        if (result.creatures.some((c) => c.currentLife > 0 && sameCoords(c.position, cell))) return false;
        if (result.dofuses.some((d) => d.currentLife > 0 && sameCoords(d.position, cell))) return false;
        if (cellHasGroundObject(result, cell)) return false; // one object per cell, skip any occupied ground cell
        return true;
      };
      let cells: Coords[];
      if (ef.placement === "around") {
        const fdx = forwardDx(caster); // ally advances x-1, enemy x+1
        const candidates: Coords[] = [
          { x: selfCell.x, y: selfCell.y - 1 }, // up
          { x: selfCell.x, y: selfCell.y + 1 }, // down
          { x: selfCell.x + fdx, y: selfCell.y }, // front
          { x: selfCell.x - fdx, y: selfCell.y }, // back
        ];
        cells = candidates.filter(isFree).slice(0, count);
      } else {
        // "self": the source's own cell (just vacated by the death).
        cells = [{ ...selfCell }];
      }
      if (cells.length > 0) {
        // "self": the source's own (just-vacated) cell is IMPOSED, a ground object still on it
        // (e.g. a glyph the dead creature stood on) is replaced by the Bombe (one object per cell).
        // "around" cells were already filtered object-free by isFree.
        const rem: GameEvent[] = [];
        if (ef.placement !== "around") for (const cell of cells) result = replaceGroundObjectsAt(result, cell, rem);
        const newTraps: TrapInstance[] = cells.map((cell) => ({ position: { ...cell }, owner: caster, cardId: 101, damage: 2 }));
        result = { ...result, traps: [...(result.traps ?? []), ...newTraps], log: [...result.log, ...rem] };
      }
    }
  } else if (e.type === "SwapDofus") {
    // Ush #426 (ally) / #13 (enemy): swap the position of the `side` Dofus on the
    // SOURCE's row with the picked Dofus (at `target`). Kind/revealed stay with each;
    // only their cells exchange.
    const dside: Side = (e as { side?: string }).side === "enemy" ? other(caster) : caster;
    if (selfCell && target) {
      const rowDofus = result.dofuses.find((dd) => dd.currentLife > 0 && dd.owner === dside && dd.position.y === selfCell.y);
      const picked = result.dofuses.find((dd) => dd.currentLife > 0 && sameCoords(dd.position, target));
      if (rowDofus && picked && !sameCoords(rowDofus.position, picked.position)) {
        const posA = { ...rowDofus.position }, posB = { ...picked.position };
        result = { ...result, dofuses: result.dofuses.map((dd) =>
          sameCoords(dd.position, posA) ? { ...dd, position: { ...posB } } :
          sameCoords(dd.position, posB) ? { ...dd, position: { ...posA } } : dd) };
      }
    }
  } else if (e.type === "SacrificeForReserve") {
    // Embaumement #1460 (Sort): destroy the picked ally creature (death resolved →
    // its MORT fires) and add its printed cost to the caster's reserve.
    if (target) {
      const victim = result.creatures.find((c) => c.currentLife > 0 && sameCoords(c.position, target) && c.owner === caster);
      if (victim) {
        const cost = Math.max(0, creatureCost(victim)); // honours a Phorzerker's source-Énutrof cost
        const creatures = result.creatures.map((c) => (c.instanceId === victim.instanceId ? { ...c, currentLife: 0 } : c));
        const bumped = { ...result, players: { ...result.players, [caster]: { ...result.players[caster], apReserve: result.players[caster].apReserve + cost } } };
        result = resolveDeathsAndWin(bumped, creatures, result.dofuses, [...result.log], new Set());
      }
    }
  } else if (e.type === "DrawSummonFreeElseDiscard") {
    // Chasseur #245: draw the top card. If it is a Summon, it lands in hand at 0 PA
    // (stamp −cost); otherwise it goes straight to the discard.
    const p0 = result.players[caster];
    if (p0.deck.length > 0) {
      const drawn = p0.deck[p0.deck.length - 1];
      const deck = p0.deck.slice(0, -1);
      const deckCostMods = (p0.deckCostMods ?? []).slice(0, -1);
      const cd = getCard(drawn);
      const popped = { ...p0, deck, deckCostMods };
      if (cd?.cardType === "Summon") {
        result = addCardToHand({ ...result, players: { ...result.players, [caster]: popped } }, caster, drawn, 1, -(cd.cost ?? 0));
      } else {
        // The non-Summon drawn card is discarded, to tokenDiscard if it is a token.
        result = { ...result, players: { ...result.players, [caster]: discardCardFor(popped, drawn) } };
      }
    }
  } else if (e.type === "BounceColumn") {
    // (Sort) #1269 "remonte les invocations d'une rangée": send every creature in the picked "rangée" =
    // vertical column (same x, the Tikoko convention), allies and enemies, back to its owner's hand. The
    // cells are saved first since bounceCreature mutates.
    if (target) {
      const cells = result.creatures.filter((c) => c.currentLife > 0 && c.position.x === target.x).map((c) => ({ ...c.position }));
      for (const cell of cells) result = bounceCreature(result, cell, "hand");
    }
  } else if (e.type === "SpendReserveCharge") {
    // Sablier du Xélor #376: spend all of the caster's reserve AP (apReserve→0); every
    // one of the caster's creatures then charges that many cells.
    const n = result.players[caster].apReserve;
    if (n > 0) {
      result = { ...result, players: { ...result.players, [caster]: { ...result.players[caster], apReserve: 0 } } };
      result = applyChargeAlliesOnState(result, caster, n, undefined, undefined);
    }
  } else if (e.type === "DamageEnemiesByReserve") {
    // Nox #353 (MORT): deal (caster's reserve AP × per) to all enemy creatures, then drain the
    // whole reserve. Canonical creature damage (armure/résistance); resolveDeathsAndWin settles.
    const per = ((e as { per?: number }).per ?? 1) | 0;
    const amt = result.players[caster].apReserve * per;
    if (amt > 0) {
      const creatures = result.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
      const log = [...result.log];
      for (const c of creatures) {
        if (c.currentLife <= 0 || c.owner === caster) continue;
        const armorBefore = c.armor;
        const dealt = applyDamageToCreature(c, amt, log, false);
        if (dealt > 0 || armorBefore > c.armor) log.push({ type: "DAMAGE", targetInstanceId: c.instanceId, damage: dealt, armorHit: armorBefore > c.armor });
        if (c.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", instanceId: c.instanceId });
      }
      result = resolveDeathsAndWin({ ...result, log }, creatures, result.dofuses, log, new Set());
    }
    // "Dépense tous les PA de votre réserve", drain to 0 regardless.
    result = { ...result, players: { ...result.players, [caster]: { ...result.players[caster], apReserve: 0 } } };
  } else if (e.type === "SacrificePoupesque") {
    // Sacrifice Poupesque #89 (Sadida, global): on each row, deal per×(caster's poupées[Doll] on that row)
    // to the first enemy creature/Dofus of the row (closest to the caster; a creature comes before the
    // back-column Dofus), then destroy all the caster's poupées (the sacrifice).
    const eff = e as { family?: string; per?: number };
    const fam = eff.family ?? "Doll";
    const per = eff.per ?? 2;
    const dx = forwardDx(caster);
    const creatures = result.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
    const dofuses = result.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
    const log = [...result.log];
    for (let y = 0; y < BOARD_ROWS; y++) {
      const n = creatures.filter((c) => c.currentLife > 0 && c.owner === caster && c.position.y === y && famsOf(c).includes(fam)).length;
      if (n <= 0) continue;
      const dmg = n * per;
      // Closest enemy creature to the caster on this row (smallest forward projection x*dx).
      let tgt: import("./state").CreatureInstance | undefined;
      for (const ec of creatures) {
        if (ec.currentLife <= 0 || ec.owner === caster || ec.position.y !== y) continue;
        if (!tgt || ec.position.x * dx < tgt.position.x * dx) tgt = ec;
      }
      if (tgt) {
        const armorBefore = tgt.armor;
        const dealt = applyDamageToCreature(tgt, dmg, log, false);
        if (dealt > 0 || armorBefore > tgt.armor) log.push({ type: "DAMAGE", targetInstanceId: tgt.instanceId, damage: dealt, armorHit: armorBefore > tgt.armor });
        if (tgt.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", instanceId: tgt.instanceId });
      } else {
        const dof = dofuses.find((d) => d.currentLife > 0 && d.owner !== caster && d.position.y === y);
        if (dof && !dofusInvulnerable(dof, creatures)) {
          woundDofus(dof, dmg, log, creatures, dofuses);
          if (dof.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", dofusAt: { ...dof.position } });
          else log.push({ type: "DAMAGE", targetCell: { ...dof.position }, damage: dmg });
        }
      }
    }
    // Destroy all the caster's poupées (the "Sacrifice").
    for (const c of creatures) if (c.currentLife > 0 && c.owner === caster && famsOf(c).includes(fam)) c.currentLife = 0;
    result = resolveDeathsAndWin({ ...result, log }, creatures, dofuses, log, new Set());
  } else if (e.type === "BounceClosestOnRow") {
    // Championne du Blasphème #1451: bounce the creature closest to the source on its
    // row (same y, min |dx|, source excluded, ally or enemy) to its OWNER's hand.
    if (selfCell) {
      const onRow = result.creatures.filter((c) => c.currentLife > 0 && c.position.y === selfCell.y && !sameCoords(c.position, selfCell));
      if (onRow.length > 0) {
        const closest = onRow.reduce((a, b) => Math.abs(b.position.x - selfCell.x) < Math.abs(a.position.x - selfCell.x) ? b : a);
        result = bounceCreature(result, closest.position, "hand");
      }
    }
  } else if (e.type === "MakeOwnDofusesInvulnerable") {
    // Orbe Doré #594: all of the CASTER's Dofus gain temporary invulnerability for N turns. No pick
    // (castTarget AlliedGod). Decremented at the start of the caster's turn (startTurn).
    const turns = Math.max(1, ((e as { turns?: number }).turns ?? 1) | 0);
    result = { ...result, dofuses: result.dofuses.map((d) => (d.owner === caster ? { ...d, invulnerableTurns: turns } : d)) };
  } else if (e.type === "ShuffleDofus") {
    // Guy #274: for each side, randomly permute the positions of its living Dofus (the
    // kind/revealed follow each Dofus → the real one lands on a random row). No pick.
    const roll = rng ?? new Rng(result.rng);
    const moves: { from: Coords; to: Coords }[] = [];
    for (const sd of ["ally", "enemy"] as Side[]) {
      const living = result.dofuses.filter((d) => d.currentLife > 0 && d.owner === sd);
      if (living.length > 1) {
        const tos = roll.shuffle(living.map((d) => ({ ...d.position })));
        living.forEach((d, i) => moves.push({ from: { ...d.position }, to: tos[i] }));
      }
    }
    if (moves.length > 0) {
      const dofuses = result.dofuses.map((d) => {
        const m = moves.find((mm) => sameCoords(mm.from, d.position));
        return m ? { ...d, position: { ...m.to } } : d;
      });
      result = recomputeAuras({ ...result, dofuses });
    }
    if (!rng) result = { ...result, rng: roll.state };
  } else if (e.type === "MoveRowDofus") {
    // Ush #100: the CASTER's Dofus on the SOURCE's row moves to the picked (empty wall)
    // cell, where one of their Dofus was destroyed. No-op if no row Dofus survives.
    if (selfCell && target) {
      const rowDofus = result.dofuses.find((dd) => dd.currentLife > 0 && dd.owner === caster && dd.position.y === selfCell.y);
      if (rowDofus) {
        const fromPos = { ...rowDofus.position };
        result = { ...result, dofuses: result.dofuses.map((dd) => sameCoords(dd.position, fromPos) ? { ...dd, position: { ...target } } : dd) };
      }
    }
  } else if (e.type === "DestroyAllEnemyPrisms") {
    // "Détruit tous les prismes adverses" (Comte Harebourg): every prism owned by
    // the opponent leaves the board; the caster's own prisms stay.
    const beforeAll = result.prisms.length;
    result = { ...result, prisms: result.prisms.filter((p) => p.owner === caster) };
    const destroyedAll = beforeAll - result.prisms.length;
    if (destroyedAll > 0) {
      result = fireOnPrismReactions(result); // Lilotte #579
      result = applyEnemyPrismLossReactions(result, caster, destroyedAll); // Maluss #292: 1 per enemy prism destroyed
    }
  } else if (e.type === "RamasserPrisme") {
    // "Ramassez/récupérez un (ou tous) prisme(s)" (Lou / Malocac / Comte Harebourg):
    // consume the matching prism(s) and grant the bonus to the caster (reuses
    // activatePrism, same bonus as a walk-over). `side`/`kind` restrict the pool;
    // for a single pickup, take the prism nearest to the source (selfCell).
    const eff = e as { side?: "ally" | "enemy"; kind?: string; all?: boolean; choose?: boolean };
    const props = selfCell
      ? (result.creatures.find((c) => c.currentLife > 0 && sameCoords(c.position, selfCell))?.properties ?? new Set<string>())
      : new Set<string>();
    let pool = result.prisms.filter((p) =>
      (!eff.kind || p.kind === eff.kind) &&
      (eff.side !== "ally" || p.owner === caster) &&
      (eff.side !== "enemy" || p.owner !== caster));
    if (eff.choose && target) {
      // Lou 2★ #521: collect the prism the player picked (any side), not the nearest.
      pool = pool.filter((p) => sameCoords(p.position, target));
    } else if (!eff.all) {
      if (selfCell) {
        const d = (pos: Coords) => Math.abs(pos.x - selfCell.x) + Math.abs(pos.y - selfCell.y);
        pool = [...pool].sort((a, b) => d(a.position) - d(b.position));
      }
      pool = pool.slice(0, 1);
    }
    // Snapshot cells first, activatePrism rebuilds result.prisms each call.
    for (const cell of pool.map((p) => ({ ...p.position }))) {
      result = activatePrism(result, cell, caster, props);
    }
  } else if (e.type === "SacrificePrismBuff") {
    // Kibri #735: "sacrifiez un de vos prismes POUR donner +1 AT +1 AR à vos autres
    // invocations." The player chooses which allied prism to sacrifice via the APPARITION
    // pick (`target` = the picked prism cell); a defensive fallback to the first prism
    // covers any path that omits the target. No allied prism → nothing.
    const eff = e as { attack?: number; armor?: number; movement?: number };
    const mine = result.prisms.filter((p) => p.owner === caster);
    const chosen = (target && mine.find((p) => sameCoords(p.position, target))) || mine[0];
    if (chosen) {
      const da = eff.attack ?? 0, dr = eff.armor ?? 0, dm = eff.movement ?? 0;
      const log = [...result.log];
      const creatures = result.creatures.map((c) => {
        const isSource = !!selfCell && sameCoords(c.position, selfCell);
        if (c.currentLife <= 0 || c.owner !== caster || isSource) return c;
        const nc = { ...c, currentAttack: c.currentAttack + da, baseAttack: c.baseAttack + da, armor: c.armor + dr, baseMovement: c.baseMovement + dm };
        if (da) log.push({ type: "ATTACK_GAINED", instanceId: c.instanceId, attackMod: { valueBefore: c.currentAttack, modification: da, valueAfter: nc.currentAttack } });
        if (dr) log.push({ type: "ARMOR_GAINED", instanceId: c.instanceId, armorMod: { valueBefore: c.armor, modification: dr, valueAfter: nc.armor } });
        return nc;
      });
      result = { ...result, creatures, prisms: result.prisms.filter((p) => p !== chosen), log };
      // Sacrificing (destroying) the prism charges ON_PRISM reactors (Lilotte #579).
      result = fireOnPrismReactions(result);
    }
  } else if (e.type === "RevealDofuses") {
    // "Dévoile … les Dofus": sets `revealed`. Scope `all` (Sang Méprise #211) / `line` (Salbatroce #480,
    // the source's row) apply directly; scope `one` (Kerubim #333/#378 "un dofus adverse", Démasqué
    // #1234) is a pick, so the targeted Dofus is revealed (`target` = cell chosen / targeted by the
    // spell). `side` filters the camp.
    const eff = e as { scope: "all" | "one" | "line"; side?: "ally" | "enemy" };
    const sideOk = (d: import("./state").DofusInstance) =>
      eff.side === "ally" ? d.owner === caster : eff.side === "enemy" ? d.owner !== caster : true;
    if (eff.scope === "one") {
      if (target) {
        const dofuses = result.dofuses.map((d) =>
          !d.revealed && sideOk(d) && sameCoords(d.position, target) ? { ...d, revealed: true } : d);
        result = { ...result, dofuses };
      }
    } else {
      const row = eff.scope === "line" && selfCell ? selfCell.y : null;
      const dofuses = result.dofuses.map((d) => {
        if (d.revealed || !sideOk(d)) return d;
        if (eff.scope === "line" && d.position.y !== row) return d;
        return { ...d, revealed: true };
      });
      result = { ...result, dofuses };
    }
  } else if (e.type === "DestroyPrismOnRow") {
    // "Détruit le prisme adverse de sa ligne" (Kerubim le Brocanteur #378): remove the
    // prism on the source's row (selfCell.y) belonging to `side` (enemy = not caster).
    const eff = e as { side?: "ally" | "enemy" };
    const row = selfCell ? selfCell.y : null;
    if (row != null) {
      const beforeRow = result.prisms;
      result = { ...result, prisms: beforeRow.filter((p) => {
        if (p.position.y !== row) return true;
        if (eff.side === "enemy" && p.owner === caster) return true;
        if (eff.side === "ally" && p.owner !== caster) return true;
        return false; // on the row + right side → destroyed
      }) };
      const destroyedEnemy = beforeRow.filter((p) => !result.prisms.includes(p) && p.owner !== caster).length; // Maluss #292
      if (result.prisms.length < beforeRow.length) result = fireOnPrismReactions(result); // Lilotte #579
      if (destroyedEnemy > 0) result = applyEnemyPrismLossReactions(result, caster, destroyedEnemy);
    }
  } else if (e.type === "AttractPrisms") {
    // Attirance #125: each matching prism SLIDES toward the caster's camp (ally → +x,
    // enemy → −x) as far as it can, STOPPED by any obstacle on the way (the owner
    // never changes). Process the prisms nearest the camp first so they do not stack.
    const eff = e as { side?: "ally" | "enemy" };
    const dir = caster === "ally" ? 1 : -1;
    const isTarget = (p: import("./state").PrismInstance) =>
      eff.side === "enemy" ? p.owner !== caster : eff.side === "ally" ? p.owner === caster : true;
    let prisms = [...result.prisms];
    const movers = prisms.filter(isTarget).sort((a, b) => dir > 0 ? b.position.x - a.position.x : a.position.x - b.position.x);
    const blocked = (cell: Coords, self: import("./state").PrismInstance) =>
      result.creatures.some((c) => c.currentLife > 0 && sameCoords(c.position, cell)) ||
      result.dofuses.some((d) => sameCoords(d.position, cell)) ||
      (result.seeds ?? []).some((s) => sameCoords(s.position, cell)) ||
      (result.tasDOs ?? []).some((t) => sameCoords(t.position, cell)) ||
      (result.butins ?? []).some((b) => sameCoords(b.position, cell)) ||
      (result.bushes ?? []).some((b) => sameCoords(b.position, cell)) ||
      (result.glyphs ?? []).some((g) => sameCoords(g.position, cell)) ||
      prisms.some((q) => q !== self && sameCoords(q.position, cell));
    for (const p of movers) {
      let nx = p.position.x;
      while (true) {
        const tx = nx + dir;
        if (tx < 0 || tx >= BOARD_COLS) break;
        if (blocked({ x: tx, y: p.position.y }, p)) break;
        nx = tx;
      }
      if (nx !== p.position.x) {
        prisms = prisms.map((q) => (q === p ? { ...q, position: { x: nx, y: p.position.y } } : q));
      }
    }
    result = { ...result, prisms };
  } else if (e.type === "DiscardRandomHand") {
    // Phorzerker #357: discard N random cards from the caster's hand (seeded RNG so
    // it is reproducible). Carries each card's handCostMod off with it.
    const n = Math.max(0, ((e as { amount?: number }).amount ?? 1) | 0);
    const p = result.players[caster];
    let hand = [...p.hand];
    let handCostMods = [...p.handCostMods];
    // handCostTempMods is indexed 1:1 on the hand: it must get exactly the same splices, otherwise the
    // surcharge/discount slides onto other cards.
    let handCostTempMods = p.handCostTempMods ? [...p.handCostTempMods] : undefined;
    let discard = [...p.discard];
    let tokenDiscard = [...(p.tokenDiscard ?? [])];
    // No rng given: seed from the state and store the advanced state back, never the global generator.
    const roll = rng ?? new Rng(result.rng);
    for (let i = 0; i < n && hand.length > 0; i++) {
      const idx = roll.int(hand.length);
      // A discarded token goes to the inaccessible tokenDiscard, not the normal pile.
      if (isToken(hand[idx])) tokenDiscard = [...tokenDiscard, hand[idx]];
      else discard = [...discard, hand[idx]];
      hand = [...hand.slice(0, idx), ...hand.slice(idx + 1)];
      handCostMods = [...handCostMods.slice(0, idx), ...handCostMods.slice(idx + 1)];
      if (handCostTempMods) handCostTempMods = [...handCostTempMods.slice(0, idx), ...handCostTempMods.slice(idx + 1)];
    }
    result = { ...result, rng: rng ? result.rng : roll.state, players: { ...result.players, [caster]: { ...p, hand, handCostMods, handCostTempMods, discard, tokenDiscard } } };
  } else if (e.type === "TransformPrismToButin") {
    // "Transformez un Prisme en Butin" (Erik Rak): the picked prism (any side) is
    // removed and replaced by a Butin owned by the caster on that same cell.
    if (target) {
      const before = result.prisms.length;
      const rem: GameEvent[] = [];
      result = replaceGroundObjectsAt(result, target, rem); // one object per cell (defensive: prism cells are normally object-free)
      const prisms = result.prisms.filter(
        (p) => !(p.position.x === target.x && p.position.y === target.y),
      );
      const butins = [...(result.butins ?? []), { position: { ...target }, owner: caster }];
      result = { ...result, prisms, butins, log: [...result.log, ...rem, { type: "NEW_A_O_E", at: { ...target }, ownerSide: caster, aoeType: "loot" }] };
      // Transforming (destroying) the prism charges ON_PRISM reactors (Lilotte #579).
      if (prisms.length < before) result = fireOnPrismReactions(result);
    }
  } else if (e.type === "TransformPrismToBombe") {
    // "APPARITION : Transformez un prisme en Bombe" (Remington Smisse #80): the picked
    // prism (any side) is removed and replaced by a Bombe trap (cardId 101, damage 2)
    // owned by the SOURCE'S side (`caster`) on that same cell, so an enemy of Remington
    // jumping on it takes 2, regardless of which side owned the prism. Cloned from
    // TransformPrismToButin (above), placing a trap instead of a Butin.
    if (target) {
      const before = result.prisms.length;
      const rem: GameEvent[] = [];
      result = replaceGroundObjectsAt(result, target, rem); // one object per cell (defensive)
      const prisms = result.prisms.filter(
        (p) => !(p.position.x === target.x && p.position.y === target.y),
      );
      const traps: TrapInstance[] = [...(result.traps ?? []), { position: { ...target }, owner: caster, cardId: 101, damage: 2 }];
      result = { ...result, prisms, traps, log: [...result.log, ...rem] };
      // Transforming (destroying) the prism charges ON_PRISM reactors (Lilotte #579).
      if (prisms.length < before) result = fireOnPrismReactions(result);
    }
  } else if (e.type === "BounceGlyphs") {
    // "Vos Glyphes remontent dans votre main" (Remaniement): remove every glyph owned by the caster from
    // the board and add that many base Glyphe (#827) cards to the caster's hand (always the base card,
    // not the glyph card it came from). Enemy glyphs are untouched. The board renders again from
    // state.glyphs, so no removal event is needed (like DestroyPrism).
    const mine = (result.glyphs ?? []).filter((g) => g.owner === caster);
    if (mine.length > 0) {
      result = { ...result, glyphs: (result.glyphs ?? []).filter((g) => g.owner !== caster) };
      result = addCardToHand(result, caster, BASE_GLYPH_CARD_ID, mine.length);
    }
  } else if (e.type === "ShieldDofusOnRow") {
    // Championne Endoctrinée #869 APPARITION ("Place un bouclier sur le Dofus allié de
    // SA LIGNE si vous êtes en sous nombre"): shield the caster's living Dofus on the
    // SOURCE's row (same y), no pick. The requireCondition (outnumbered) is already
    // applied by dropUnmetConditions, so reaching here means the condition held.
    if (selfCell) {
      const dofuses = result.dofuses.map((d) =>
        d.currentLife > 0 && d.owner === caster && d.position.y === selfCell.y ? { ...d, shielded: true } : d);
      result = { ...result, dofuses };
    }
  } else if (e.type === "RevealDofus") {
    // NÉCROME : flip the picked allied Dofus to revealed and grant a 2nd Orbe
    // (#708). The ally_unrevealed_dofus filter already guarantees the target is
    // one of the caster's living, unrevealed Dofus.
    if (target) {
      const dofuses = result.dofuses.map((d) =>
        d.owner === caster && d.currentLife > 0 && sameCoords(d.position, target)
          ? { ...d, revealed: true }
          : d,
      );
      result = addCardToHand({ ...result, dofuses }, caster, ORBE_CARD_ID, 1, 0);
    }
  } else if (e.type === "DestroyCardInOpponentHand") {
    // "Détruit un <carte> dans la main adverse" (Horlogère Gousset: a Fléau #757).
    // Remove the first matching card from the opponent's hand (+ its aligned
    // cost-mod slot) and send it to their discard. No-op if they hold none.
    const cardId = (e as { cardId: number }).cardId;
    const opp = other(caster);
    const p = result.players[opp];
    const idx = p.hand.indexOf(cardId);
    if (idx >= 0) {
      // The destroyed card (typically the Fléau #757, a token) leaves the hand to its
      // owner's discard, routed to the inaccessible tokenDiscard if it is a token.
      const handRemoved: PlayerState = {
        ...p,
        hand: [...p.hand.slice(0, idx), ...p.hand.slice(idx + 1)],
        handCostMods: [...p.handCostMods.slice(0, idx), ...p.handCostMods.slice(idx + 1)],
        // Same splice on the temporary stamp, indexed 1:1 on the hand: without it the surcharge of
        // Ralentissement #188 would slide from one card to another.
        handCostTempMods: p.handCostTempMods
          ? [...p.handCostTempMods.slice(0, idx), ...p.handCostTempMods.slice(idx + 1)]
          : undefined,
      };
      result = {
        ...result,
        players: {
          ...result.players,
          [opp]: discardCardFor(handRemoved, cardId),
        },
        log: [...result.log, { type: "CARD_MOVED", cardId, from: "hand", to: "discard", side: opp }],
      };
    }
  } else if (e.type === "RespawnPrisms") {
    const scope = (e as { scope?: string }).scope;
    if (scope === "both") {
      result = respawnSidePrisms(result, caster);
      result = respawnSidePrisms(result, other(caster));
    } else if (scope === "one") {
      result = respawnOneSidePrism(result, caster, null);
    } else if (scope === "line") {
      result = respawnOneSidePrism(result, caster, selfCell ? selfCell.y : null);
    } else {
      result = respawnSidePrisms(result, caster); // default: all of the caster's side
    }
  } else if (e.type === "AddCostModifier") {
    // "Réduit de N PA le coût des cartes de votre main", stamp the delta
    // onto every card currently in the caster's hand (not future draws).
    const amount = ((e as { amount?: number }).amount ?? 0) | 0;
    const p = result.players[caster];
    result = {
      ...result,
      players: { ...result.players, [caster]: { ...p, handCostMods: p.handCostMods.map((m) => m + amount) } },
    };
  } else if (e.type === "EnemyHandSurcharge") {
    // Ralentissement #188: "Augmente de N PA le coût des cartes de la main adverse
    // courante pendant 1 tour." Stamp a temporary +N on every card currently in the
    // OPPONENT's hand (future draws append nothing → stay at 0). It rides
    // handCostTempMods, which endTurn lifts at the end of the opponent's own next
    // turn. Add onto any existing surcharge so a second cast stacks.
    const amount = ((e as { amount?: number }).amount ?? 0) | 0;
    const foe = other(caster);
    const p = result.players[foe];
    const temp = p.hand.map((_, i) => (p.handCostTempMods?.[i] ?? 0) + amount);
    result = {
      ...result,
      players: { ...result.players, [foe]: { ...p, handCostTempMods: temp } },
    };
  } else if (e.type === "AddReserve") {
    // "Ajoute N PA à votre / la réserve adverse".
    const amount = ((e as { amount?: number }).amount ?? 0) | 0;
    const side: Side = (e as { side?: string }).side === "enemy" ? other(caster) : caster;
    const p = result.players[side];
    result = { ...result, players: { ...result.players, [side]: { ...p, apReserve: Math.max(0, p.apReserve + amount) } } };
  } else if (e.type === "DrainAp") {
    // "Dépense N PA" with nothing in return (Cactana #587 DÉBUT DU TOUR): takes N from the caster's AP
    // pool, floored at 0. The start-of-turn refill already happened.
    const n = Math.max(0, ((e as { amount?: number }).amount ?? 0) | 0);
    const p = result.players[caster];
    result = { ...result, players: { ...result.players, [caster]: { ...p, ap: Math.max(0, p.ap - n) } } };
  } else if (e.type === "TransferApToReserve") {
    // "Transfère vos PA vers votre réserve", move current AP into reserve.
    const p = result.players[caster];
    result = { ...result, players: { ...result.players, [caster]: { ...p, apReserve: p.apReserve + p.ap, ap: 0 } } };
  } else if (e.type === "StealReserve") {
    // "Vole [N | tous les] PA de la réserve adverse pour les ajouter à la vôtre". `amount` is limited to
    // the opponent's available reserve; absent = steal it all (Noxine #392 = 1).
    const foe = other(caster);
    const me = result.players[caster], op = result.players[foe];
    const amount = (e as { amount?: number }).amount;
    const n = amount != null ? Math.min(Math.max(0, amount | 0), op.apReserve) : op.apReserve;
    result = {
      ...result,
      players: {
        ...result.players,
        [caster]: { ...me, apReserve: me.apReserve + n },
        [foe]: { ...op, apReserve: op.apReserve - n },
      },
    };
  } else if (e.type === "AddCardToHand") {
    // "Ajoute N <carte> à votre main", drop N copies of a specific card
    // (usually a token like Bébé Phorreur Armuré) into the caster's hand. `amount`
    // may be a die (Dé du Chacha "Ajoutez 1d6 Chacha Noirs") → resolve it with the
    // cast RNG + the caster's dice floor.
    const id = (e as { cardId?: number }).cardId;
    // `side:"enemy"` drops the cards into the OPPONENT's hand (Jiji #465 "ajoute 2
    // poils dans la main adverse"); default = the caster's own hand.
    const handSide = (e as { side?: "caster" | "enemy" }).side === "enemy" ? other(caster) : caster;
    // `fill:true` fills the target hand up to MAX_HAND (Kabrok #473 "remplit de
    // corbacs la main"), count = the free slots, so nothing overflows to discard.
    let n: number;
    if ((e as { fill?: boolean }).fill) {
      n = Math.max(0, MAX_HAND - result.players[handSide].hand.length);
    } else {
      const rawAmount = (e as { amount?: number | DynamicValue }).amount ?? 0;
      // Dice amount with no rng given: seed from the state and store the advanced state back, never the
      // global generator (rollDice is now strict).
      const roll = rng ?? (typeof rawAmount === "number" ? undefined : new Rng(result.rng));
      n = Math.max(0, resolveDynamicValue(rawAmount, roll, result.players[caster].diceFloor) | 0);
      if (!rng && roll) result = { ...result, rng: roll.state };
    }
    if (id && n > 0) result = addCardToHand(result, handSide, id, n);
  } else if (e.type === "AddRandomFamilyCards") {
    // Maloboss #470 "MORT : ajoute 3 autres bandits à votre main": add `amount`
    // distinct random Summons of `family` (no duplicate, "pas deux fois le même
    // bandit"), excluding the source card by NAME (excludeName, "pas un autre
    // Maloboss", so every Maloboss version is excluded).
    const fam = (e as { family?: string }).family;
    const want = Math.max(0, ((e as { amount?: number }).amount ?? 0) | 0);
    const exclude = (e as { excludeName?: string }).excludeName;
    const pool = (fam ? summonsOfFamily(fam) : []).filter((tid) => !(exclude && getCard(tid)?.name === exclude));
    const roll = rng ?? new Rng(result.rng);
    for (let k = 0; k < want && pool.length > 0; k++) {
      const cid = pool.splice(roll.int(pool.length), 1)[0]; // distinct: removed from the pool
      result = addCardToHand(result, caster, cid, 1);
    }
    if (!rng) result = { ...result, rng: roll.state };
  } else if (e.type === "ControlAround") {
    // Miranda #107: seize every enemy creature in the 8 cells around the source, with
    // a reversion linked to the source's life (whileSourceAlive, like Anathar #316),
    // they return to their owner when Miranda dies. `selfCell` = the source's cell.
    if (selfCell) {
      const source = result.creatures.find((c) => sameCoords(c.position, selfCell) && c.currentLife > 0);
      const seized = result.creatures.filter((c) =>
        c.currentLife > 0 && c.owner === other(caster) &&
        Math.abs(c.position.x - selfCell.x) <= 1 && Math.abs(c.position.y - selfCell.y) <= 1 &&
        !sameCoords(c.position, selfCell));
      if (source && seized.length > 0) {
        const ids = new Set(seized.map((c) => c.instanceId));
        // An invocation whose control is taken during a turn advances at the end of this turn (Gemene did not
        // advance after being taken by Miranda). So it gets the "ready" state of a turn start, exactly like
        // handleTakeControl: PM are only given back at the start of a turn and to creatures already in the
        // active camp, so without this a seized creature arrived with 0 PM (spent during the opponent's turn)
        // and skipped its turn.
        const creatures = result.creatures.map((c) => (ids.has(c.instanceId) ? { ...c, owner: caster, movementLeft: c.baseMovement, hasAttacked: false } : c));
        const reversions: TempReversion[] = seized.map((c) => ({ kind: "control", instanceId: c.instanceId, originalOwner: c.owner, linkedTo: source.instanceId, sourceCardId: source.cardId, seizedCardId: c.cardId }));
        result = recomputeAuras({
          ...result,
          creatures,
          pendingReversions: [...(result.pendingReversions ?? []), ...reversions],
          log: [...result.log, ...seized.map((c) => ({ type: "SUMMONING_CHANGED_TEAM" as const, instanceId: c.instanceId, newOwner: caster }))],
        });
      }
    }
  } else if (e.type === "GiveSelfToOpponent") {
    // Truche Foldingue #434 (COUP DE GRÂCE, branche pile 50%): the source defects to
    // the OPPONENT's side. `selfCell` = the source's cell (passed by runTrigger).
    if (selfCell) {
      const me = result.creatures.find((c) => sameCoords(c.position, selfCell) && c.currentLife > 0);
      // Roi des Truches #282 nullifies the owner-change ability for the owner's Truches.
      if (me && !familyMovePowersNullified(me, result.creatures)) {
        const newOwner = other(me.owner);
        result = recomputeAuras({
          ...result,
          creatures: result.creatures.map((c) => (c.instanceId === me.instanceId ? { ...c, owner: newOwner, movementLeft: 0, hasAttacked: true } : c)),
          log: [...result.log, { type: "SUMMONING_CHANGED_TEAM", instanceId: me.instanceId, newOwner }],
        });
      }
    }
  } else if (e.type === "TutorFromDeck") {
    // "Place le prochain/dernier X de votre pioche dans votre main", search the
    // caster's deck for up to N cards matching the filter (a Summon, a Spell, or
    // a family) and move them to hand. `from`: "top" = the next-drawn end (last
    // array element), "bottom" = the deck's bottom (index 0).
    const ef = e as { from?: string; amount?: number; summon?: boolean; spell?: boolean; family?: string; glyph?: boolean; cardId?: number; costMod?: number };
    const n = Math.max(0, (ef.amount ?? 0) | 0);
    const costMod = (ef.costMod ?? 0) | 0; // "il coûte N PA de moins" → negative
    const matches = (cardId: number): boolean => {
      const cd = getCard(cardId);
      if (!cd) return false;
      // Exact card by id (Brute Impie's "la première Championne du Blasphème").
      if (ef.cardId != null && cardId !== ef.cardId) return false;
      if (ef.summon && cd.cardType !== "Summon") return false;
      if (ef.spell && cd.cardType !== "Spell") return false;
      if (ef.family && !(cd.families ?? []).includes(ef.family)) return false;
      if ((ef as { rarity?: string }).rarity && cd.rarity !== (ef as { rarity?: string }).rarity) return false; // Indie #509 "carte Infinite"
      if ((ef as { god?: string }).god && cd.god !== (ef as { god?: string }).god) return false; // Many de Brakmar #227 "carte Xélor"
      if ((ef as { cost?: number }).cost != null && cd.cost !== (ef as { cost?: number }).cost) return false; // "… coûtant N PA"
      // A "Glyphe" card = one carrying the PlaceGlyph effect (Malory's tutor).
      if ((ef as { glyph?: boolean }).glyph && !(cd.effects ?? []).some((e) => e.type === "PlaceGlyph")) return false;
      // A "Piège" card = a placer with GiveActiveTrap (Initiée Funèbre #1231 "le premier piège"): the 3
      // Piège placers #624/#712/#945, not the Bombe #101/PlaceTrap.
      if ((ef as { trap?: boolean }).trap && !(cd.effects ?? []).some((e) => e.type === "GiveActiveTrap")) return false;
      return true;
    };
    const deck = [...result.players[caster].deck];
    // deckCostMods moves with the deck so the tutored card keeps its Vampyro/HORDE stamp and the array
    // keeps the same length (otherwise later draws hit drawCardFrom's guard and fall back to zeros).
    const dp = result.players[caster];
    const mods = dp.deckCostMods && dp.deckCostMods.length === dp.deck.length ? [...dp.deckCostMods] : dp.deck.map(() => 0);
    const picked: number[] = [];
    const pickedMods: number[] = [];
    if (ef.from === "bottom") {
      for (let i = 0; i < deck.length && picked.length < n; ) {
        if (matches(deck[i])) { picked.push(deck[i]); pickedMods.push(mods[i] ?? 0); deck.splice(i, 1); mods.splice(i, 1); } else i++;
      }
    } else {
      for (let i = deck.length - 1; i >= 0 && picked.length < n; i--) {
        if (matches(deck[i])) { picked.push(deck[i]); pickedMods.push(mods[i] ?? 0); deck.splice(i, 1); mods.splice(i, 1); }
      }
    }
    result = { ...result, players: { ...result.players, [caster]: { ...result.players[caster], deck, deckCostMods: mods } } };
    // Carry the deck stamp (Vampyro −1) stacked with the effect's own discount (ef.costMod, e.g. Jahash).
    for (let k = 0; k < picked.length; k++) {
      result = logDeckToHand(result, caster, picked[k]);
      result = addCardToHand(result, caster, picked[k], 1, pickedMods[k] + costMod);
    }
  } else if (e.type === "SummonToken") {
    // "Invoque N <token> sur vos cases de départ", materialise up to N token
    // creatures on the caster's free spawn cells (back column first). With
    // `family` instead of a fixed `tokenId` (Nomekop: "Invoque 2 Chachas"), each
    // of the N is rolled independently from that family's Summon pool, using the
    // game RNG (seeded from state.rng, persisted) so the picks are reproducible.
    const id = (e as { tokenId?: number }).tokenId;
    const fam = (e as { family?: string }).family;
    const cost = (e as { cost?: number }).cost;
    const n = Math.max(0, ((e as { amount?: number }).amount ?? 0) | 0);
    const placement = (e as { placement?: string }).placement;
    // "Invoque un <token> sur chaque case de sa rangée" (Bébé Phorreur #1245, Corbac #205): one copy on
    // every empty cell of the source's row (y = selfCell.y) within the caster's territory. Each token
    // fires its normal APPARITION on summon, so a token with a built-in "Charge de 1" (Corbac #56)
    // advances one cell by itself ("vos corbacs chargent" is exactly that built-in charge, no extra
    // effect needed).
    if (placement === "row" && id != null && selfCell) {
      const token = getCard(id);
      if (token) {
        const xs: number[] = [];
        for (let x = 1; x <= 8; x++) if (isAlliedTerritory(x, caster)) xs.push(x);
        // Front column first (ally toward 0, enemy toward 9): a token that charges
        // forward on summon vacates toward the already-filled front, so it never
        // lands on a cell we are about to fill, keeps every empty cell summoned.
        xs.sort((a, b) => (caster === "ally" ? a - b : b - a));
        for (const x of xs) {
          const cell = { x, y: selfCell.y };
          if (creatureAt(result, cell)) continue; // occupied (incl. the source / a charged token) → skip
          result = summonCreature(result, token, cell, caster, false);
        }
      }
      return { state: result, endsTurn };
    }
    if (placement === "column" && id != null && selfCell) {
      // "Invoque un <token> sur chaque case de sa RANGÉE" (Héroïne Séculaire #1245, Corbeau Noir #205): one
      // copy on every empty cell of the source's column (x = selfCell.x, every row y). "rangée" is the
      // vertical column (same x), not the horizontal lane / "ligne". A creature just summoned stands in its
      // own camp, so the whole column is the caster's and no per-cell territory check is needed. Each token
      // fires its own APPARITION (e.g. a Corbac that charges leaves the column into its own lane, so there
      // is no collision inside the column).
      const token = getCard(id);
      if (token) {
        for (let y = 0; y < BOARD_ROWS; y++) {
          const cell = { x: selfCell.x, y };
          if (creatureAt(result, cell)) continue; // occupied (incl. the source) → skip
          result = summonCreature(result, token, cell, caster, false);
        }
      }
      return { state: result, endsTurn };
    }
    if (placement === "beside" && id != null && selfCell) {
      // Boo #513 "à côté de lui s'il survit": one token on a cell next to it vertically (same column x,
      // y±1, the two cells beside it). Among the free ones the seeded RNG picks up or down; if both are
      // taken, nothing is summoned.
      const token = getCard(id);
      if (token) {
        const sides = [{ x: selfCell.x, y: selfCell.y - 1 }, { x: selfCell.x, y: selfCell.y + 1 }]
          .filter((c) => c.y >= 0 && c.y < BOARD_ROWS && !dofusSideAt(c.x, c.y) && isCellFree(result, c));
        if (sides.length > 0) {
          const roll = rng ?? new Rng(result.rng);
          const pick = sides[roll.int(sides.length)];
          if (!rng) result = { ...result, rng: roll.state };
          result = summonCreature(result, token, pick, caster, false);
        }
      }
      return { state: result, endsTurn };
    }
    if (placement === "front" && id != null && selfCell) {
      // Pissenlit Diabolique #1595 "à 2 cases devant lui si c'est possible": one token
      // on the cell `frontDistance` cells ahead (toward the enemy), only if it is
      // on-board and free (no creature / Dofus), otherwise nothing is summoned.
      const token = getCard(id);
      const dist = Math.max(1, ((e as { frontDistance?: number }).frontDistance ?? 1) | 0);
      const cell = { x: selfCell.x + forwardDx(caster) * dist, y: selfCell.y };
      if (token && cell.x >= 0 && cell.x < BOARD_COLS && !dofusSideAt(cell.x, cell.y) && isCellFree(result, cell)) {
        result = summonCreature(result, token, cell, caster, false);
      }
      return { state: result, endsTurn };
    }
    if (placement === "frontAndSides" && id != null && selfCell) {
      // Khan Karkass #510 "invoque 3 fans autour de lui": one token in front (cell x+forwardDx, same row) +
      // one on the left + one on the right (cells y∓1, same column). Each cell that is taken / off the board
      // is skipped (that fan is not placed).
      const token = getCard(id);
      if (token) {
        const dx = forwardDx(caster);
        const cells = [
          { x: selfCell.x + dx, y: selfCell.y },
          { x: selfCell.x, y: selfCell.y - 1 },
          { x: selfCell.x, y: selfCell.y + 1 },
        ];
        for (const cell of cells) {
          if (cell.x < 0 || cell.x >= BOARD_COLS || cell.y < 0 || cell.y >= BOARD_ROWS) continue;
          if (dofusSideAt(cell.x, cell.y) || !isCellFree(result, cell)) continue;
          result = summonCreature(result, token, cell, caster, false);
        }
      }
      // Khan Karkass #510 "vos fans chargent", charge the family after the summon
      // (the new fans included). Done here, not as a separate ChargeAllies effect,
      // because runTrigger's charge pass runs before this player-state summon.
      const chargeFam = (e as { thenChargeFamily?: string }).thenChargeFamily;
      if (chargeFam) result = applyChargeAlliesOnState(result, caster, undefined, undefined, chargeFam);
      return { state: result, endsTurn };
    }
    if (placement === "sides" && selfCell) {
      // Nomekop #563 "2 Chachas à côté de lui" (+ Gary Bûhl #759, Moogrr Céleste #1263): one token on each
      // free cell next to it vertically (same column, y±1), a random family member when `family` is set
      // (each cell rolled on its own, reproducibly), otherwise the fixed `id`. A cell off the board / on a
      // Dofus / taken is skipped, so 0, 1 or 2 are summoned. Capped at `amount`.
      const sides = [{ x: selfCell.x, y: selfCell.y - 1 }, { x: selfCell.x, y: selfCell.y + 1 }]
        .filter((c) => c.y >= 0 && c.y < BOARD_ROWS && !dofusSideAt(c.x, c.y) && isCellFree(result, c));
      const pool = fam ? summonsOfFamily(fam) : (cost != null ? summonsOfCost(cost) : (id != null ? [id] : []));
      const targets = sides.slice(0, Math.max(0, n));
      if (pool.length > 0 && targets.length > 0) {
        const roll = rng ?? new Rng(result.rng);
        for (let i = 0; i < targets.length; i++) {
          // Independent per-cell pick (mirrors the family-pool path's bit-mixer so
          // sims/replays reproduce both the creature and the cell it lands on).
          let h = (roll.state ^ Math.imul((result.log.length | 0) + 1 + i, 0x9e3779b1)) | 0;
          h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
          h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
          h = (h ^ (h >>> 15)) >>> 0;
          const tok = getCard(pool[new Rng(h).int(pool.length)]);
          if (tok) result = summonCreature(result, tok, targets[i], caster, false);
        }
        roll.next();
        if (!rng) result = { ...result, rng: roll.state };
      }
      return { state: result, endsTurn };
    }
    if (placement === "sidesOrBehind" && selfCell) {
      // Abraknyde #516 "MORT : Invoque 2 Araknes À CÔTÉ OU DERRIÈRE lui" (+ Abraknyde Ancestral #455, 2
      // Corbacs). Never in front, so the generic "near" (Chebyshev, which also allows the front cells, the
      // diagonals and the death cell just freed) was wrong for these two.
      // Candidates, in priority order: the two side cells (same x, y±1, "à côté"), then the cell right
      // behind ("derrière", away from the enemy). Back diagonals are excluded (neither "à côté" nor
      // "derrière"), and so is the creature's own death cell: unlike the MORT summons with no position (Rat
      // Dominant #557 and similar), these two name their cells, so the corpse's cell stays empty. A
      // candidate off the board / on a Dofus / taken is skipped, so 0, 1 or 2 land. Capped at `amount`.
      const back = -forwardDx(caster); // away from the enemy wall
      const cand = [
        { x: selfCell.x, y: selfCell.y - 1 },
        { x: selfCell.x, y: selfCell.y + 1 },
        { x: selfCell.x + back, y: selfCell.y },
      ].filter((c) =>
        c.x >= 0 && c.x < BOARD_COLS && c.y >= 0 && c.y < BOARD_ROWS &&
        !dofusSideAt(c.x, c.y) && isCellFree(result, c));
      const pool = fam ? summonsOfFamily(fam) : (cost != null ? summonsOfCost(cost) : (id != null ? [id] : []));
      const targets = cand.slice(0, Math.max(0, n));
      if (pool.length > 0 && targets.length > 0) {
        const roll = rng ?? new Rng(result.rng);
        for (let i = 0; i < targets.length; i++) {
          let h = (roll.state ^ Math.imul((result.log.length | 0) + 1 + i, 0x9e3779b1)) | 0;
          h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
          h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
          h = (h ^ (h >>> 15)) >>> 0;
          const tok = getCard(pool[new Rng(h).int(pool.length)]);
          if (tok) result = summonCreature(result, tok, targets[i], caster, false);
        }
        roll.next();
        if (!rng) result = { ...result, rng: roll.state };
      }
      return { state: result, endsTurn };
    }
    if (placement === "self" && id != null && selfCell) {
      // Goultard #304 "MORT : Se transforme en Dark Vlad", the token lands on the
      // dying creature's exact cell (selfCell = its position). By the time MORT
      // player-state effects run the dead creature is already culled, so the cell is
      // free. fireApparition=false: a transform is not a fresh play (Dark Vlad has no
      // APPARITION anyway; its passive comes from effects[] at summon either way).
      const token = getCard(id);
      if (token && !dofusSideAt(selfCell.x, selfCell.y) && isCellFree(result, selfCell)) {
        result = summonCreature(result, token, selfCell, caster, false);
      }
      return { state: result, endsTurn };
    }
    const summonOne = (tokenId: number, useRng?: Rng): void => {
      if ((placement === "target" || placement === "choose" || placement === "campChoose") && target) {
        // "Invoque … sur la case ciblée" (Échange d'Âmes): drop the rolled creature
        // on the clicked cell, firing its APPARITION like any normal summon.
        const cd = getCard(tokenId);
        if (cd) result = summonCreature(result, cd, target, caster, false);
      } else if (placement === "near" && selfCell) {
        // Pass the rng so the landing cell is random (Gelax's Jelly "autour de lui").
        result = summonTokensNear(result, tokenId, 1, caster, selfCell, useRng);
      } else {
        result = summonTokens(result, tokenId, 1, caster);
      }
    };
    // Random pools: a `family` (Nomekop's Chachas) or an exact `cost` (Échange
    // d'Âmes "invocation aléatoire coûtant 6 PA"). Each of the N is rolled
    // independently from the seeded RNG (reproducible).
    // `excludeSelf` drops the SOURCE's own card from a family pool, Empereur Gelax
    // #422 invokes "une AUTRE Gelée", i.e. any Jelly that is not itself (matched by
    // name so every version of the Emperor is excluded).
    const selfName = (e as { excludeSelf?: boolean }).excludeSelf && selfCell
      ? getCard(creatureAt(result, selfCell)?.cardId ?? -1)?.name
      : undefined;
    const pool = fam
      ? summonsOfFamily(fam).filter((tid) => !(selfName && getCard(tid)?.name === selfName))
      : (cost != null ? summonsOfCost(cost) : null);
    if (pool && n > 0) {
      if (pool.length > 0) {
        const roll = rng ?? new Rng(result.rng);
        // Build a UNIFORM pick from the threaded rng and the game's monotonic event
        // count, combined through a strong bit-mixer (splitmix32 finalizer). If the
        // caller re-feeds the same rng seed (a React state quirk can do this for a
        // reactive summon like Empereur Gelax's contre-coup), the event count alone
        // still spreads the pick evenly over the pool, no jelly is favoured. It
        // stays deterministic (event count = pure function of history) so sims /
        // replays reproduce the exact roll. The same `mix` rolls the creature and
        // its cell, so both vary together.
        let h = (roll.state ^ Math.imul((result.log.length | 0) + 1, 0x9e3779b1)) | 0;
        h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
        h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
        h = (h ^ (h >>> 15)) >>> 0;
        const mix = new Rng(h);
        for (let i = 0; i < n; i++) summonOne(pool[mix.int(pool.length)], mix);
        roll.next(); // keep the shared rng moving for any later effect / reproducibility
        if (!rng) result = { ...result, rng: roll.state }; // persist when we own the RNG
      }
    } else if (id && n > 0) {
      if ((placement === "target" || placement === "choose" || placement === "campChoose") && target) {
        for (let i = 0; i < n; i++) summonOne(id);
      } else {
        result = placement === "near" && selfCell
          ? summonTokensNear(result, id, n, caster, selfCell, rng)
          : summonTokens(result, id, n, caster);
      }
    }
  } else if (e.type === "ForceCoinPile") {
    // Trucage: "Durant ce tour vos lancers de pièce tombent sur Pile." Sets a
    // per-turn flag the coin-flip resolver reads; cleared at endTurn.
    const p = result.players[caster];
    result = { ...result, players: { ...result.players, [caster]: { ...p, coinForcedPile: true } } };
  } else if (e.type === "SetDiceFloor") {
    // Dé Pipé: "Durant ce tour vos jets de dé ne peuvent être inférieurs à N."
    // Sets a per-turn floor resolveDynamicValue reads (via ctx.diceFloor); cleared
    // at endTurn. Keeps the higher of any existing floor.
    const p = result.players[caster];
    const floor = Math.max(p.diceFloor ?? 0, (e as { floor: number }).floor | 0);
    result = { ...result, players: { ...result.players, [caster]: { ...p, diceFloor: floor } } };
  } else if (e.type === "DiscountNextCard") {
    // La Folle #481 / Emma Cabre #963: the caster's next played card costs N less.
    // Accumulates and persists until playCard consumes it.
    const p = result.players[caster];
    const add = Math.max(0, (e as { amount?: number }).amount ?? 0);
    result = { ...result, players: { ...result.players, [caster]: { ...p, nextCardDiscount: (p.nextCardDiscount ?? 0) + add } } };
  } else if (e.type === "ClassCostAura") {
    // Nouvelle Vague #1213: "Les cartes Fécas de votre jeu coûtent 1 PA de moins." Unlike a
    // StampCostReduction (a per-card stamp lost in the discard), this is a lasting class aura: the
    // reduction is stored on the player, keyed by god, and effectiveCost subtracts it for every card of
    // that god (in hand now, drawn later, or recovered from the discard). Adds up if cast more than once.
    const p = result.players[caster];
    const eff = e as { god: string; amount?: number };
    const n = Math.max(0, eff.amount ?? 0);
    if (n > 0 && eff.god) {
      const cur = { ...(p.godCostReductions ?? {}) };
      cur[eff.god] = (cur[eff.god] ?? 0) + n;
      result = { ...result, players: { ...result.players, [caster]: { ...p, godCostReductions: cur } } };
    }
  } else if (e.type === "StampCostReduction") {
    // Wagnar / Vampyro: "tous tes <sorts|invocations|cartes> coûtent N PA de moins
    // jusqu'à ce qu'ils soient défaussés", stamp −N on every matching card in the
    // caster's hand + deck (same persistent per-card model as HORDE; floored at 0
    // by effectiveCost, lost when a card leaves for the discard).
    const p = result.players[caster];
    const eff = e as { scope?: CostScope; amount?: number };
    const n = Math.max(0, eff.amount ?? 0);
    const matches = (id: number) => {
      const c = getCard(id);
      return !!c && !!eff.scope && cardMatchesCostScope(c, eff.scope);
    };
    result = { ...result, players: { ...result.players, [caster]: stampCostReduction(p, matches, n) } };
    // Vampyro reduces all your invocations "jusqu'à ce qu'elles soient défaussées", itself included. The
    // played Vampyro left the hand before the stamp, so the reduction is carried on its figurine
    // (playedCostMod): if it later goes back to hand (bounce / recover), it keeps the −N. Only when the
    // source card matches the scope.
    if (selfCell && n > 0) {
      const src = result.creatures.find((c) => c.currentLife > 0 && sameCoords(c.position, selfCell));
      if (src && matches(src.cardId)) {
        result = { ...result, creatures: result.creatures.map((c) =>
          c.instanceId === src.instanceId ? { ...c, playedCostMod: (c.playedCostMod ?? 0) - n } : c) };
      }
    }
  } else if (e.type === "RecycleFamily") {
    // Goule Taka #871: "Place les <famille> de votre main sous votre pioche.
    // Piochez autant de <famille>." Pull the family cards out of hand, drop them at
    // the bottom of the deck, then tutor the same count of that family back from the
    // deck (top-first). Cost-mods (HORDE discount) follow each card hand↔deck, so a
    // discounted Goule keeps its discount through the recycle. Net hand size is
    // unchanged (remove G, draw ≤ G) → no overflow.
    const fam = (e as { family: string }).family;
    const p = result.players[caster];
    const isFam = (id: number) => (getCard(id)?.families ?? []).includes(fam);
    const stayHand: number[] = [], stayMods: number[] = [], moved: number[] = [], movedMods: number[] = [];
    // handCostTempMods follows the hand, not the deck: the cards that go under the deck lose their
    // temporary stamp, those that stay keep it at their new index, and each tutored card comes in at 0
    // (it was not there when the stamp was applied).
    const stayTemp: number[] = [];
    p.hand.forEach((id, i) => {
      (isFam(id) ? moved : stayHand).push(id);
      (isFam(id) ? movedMods : stayMods).push(p.handCostMods[i] ?? 0);
      if (!isFam(id)) stayTemp.push(p.handCostTempMods?.[i] ?? 0);
    });
    if (moved.length > 0) {
      const baseDeckMods = p.deckCostMods && p.deckCostMods.length === p.deck.length ? [...p.deckCostMods] : p.deck.map(() => 0);
      let deck = [...moved, ...p.deck];           // bottom = front (index 0); top = pop() = end
      let deckMods = [...movedMods, ...baseDeckMods];
      const hand = [...stayHand], handCostMods = [...stayMods];
      for (let k = 0; k < moved.length; k++) {
        let idx = -1;
        for (let j = deck.length - 1; j >= 0; j--) { if (isFam(deck[j])) { idx = j; break; } } // top-first
        if (idx === -1) break;                    // deck out of that family
        hand.push(deck[idx]); handCostMods.push(deckMods[idx] ?? 0);
        stayTemp.push(0); // carte tutoree depuis la pioche : jamais surchargee
        deck = [...deck.slice(0, idx), ...deck.slice(idx + 1)];
        deckMods = [...deckMods.slice(0, idx), ...deckMods.slice(idx + 1)];
      }
      result = { ...result, players: { ...result.players, [caster]: { ...p, hand, handCostMods, handCostTempMods: p.handCostTempMods ? stayTemp : undefined, deck, deckCostMods: deckMods } } };
    }
  } else if (e.type === "RecycleGodDrawAny") {
    // Escompte #1629: place your <god> hand cards (incl. the cast spell itself, re-added
    // to hand by `recyclesSelf` before this runs) into the deck, SHUFFLED, then draw that
    // many any cards (top of deck). Unlike RecycleFamily, the redraw is not filtered.
    const god = (e as { god: string }).god;
    const p = result.players[caster];
    const isGod = (id: number) => getCard(id)?.god === god;
    const stayHand: number[] = [], stayMods: number[] = [], moved: number[] = [], movedMods: number[] = [];
    // Same split as RecycleFamily for the temporary stamp. The drawCard calls that follow do not extend
    // handCostTempMods, which is correct: a card drawn after the stamp is not surcharged.
    const stayTemp: number[] = [];
    p.hand.forEach((id, i) => {
      (isGod(id) ? moved : stayHand).push(id);
      (isGod(id) ? movedMods : stayMods).push(p.handCostMods[i] ?? 0);
      if (!isGod(id)) stayTemp.push(p.handCostTempMods?.[i] ?? 0);
    });
    if (moved.length > 0) {
      const baseDeckMods = p.deckCostMods && p.deckCostMods.length === p.deck.length ? [...p.deckCostMods] : p.deck.map(() => 0);
      const pairs: [number, number][] = [
        ...p.deck.map((c, i) => [c, baseDeckMods[i]] as [number, number]),
        ...moved.map((c, i) => [c, movedMods[i]] as [number, number]),
      ];
      const shuffled = (rng ?? new Rng(state.rng)).shuffle(pairs);
      result = {
        ...result,
        players: { ...result.players, [caster]: { ...p, hand: stayHand, handCostMods: stayMods, handCostTempMods: p.handCostTempMods ? stayTemp : undefined, deck: shuffled.map((x) => x[0]), deckCostMods: shuffled.map((x) => x[1]) } },
      };
      for (let k = 0; k < moved.length; k++) result = drawCard(result, caster);
    }
  } else if (e.type === "BanishOwnDiscard") {
    // Emma Cabre #963: "Bannit N carte(s) de votre défausse", the N most-recent
    // discard cards leave the game (→ banished). This is an effect, not a play cost
    // (no requirement): no-op on an empty discard. `eachPlayer` (Phorreur Ancestral
    // #1498 "… de chaque joueur") banishes the N most-recent of both discards.
    const n = Math.max(0, (e as { count?: number }).count ?? 0);
    const sides: Side[] = (e as { eachPlayer?: boolean }).eachPlayer ? ["ally", "enemy"] : [caster];
    if (n > 0) {
      let players = result.players;
      for (const side of sides) {
        const p = players[side];
        if (p.discard.length === 0) continue;
        const cut = Math.max(0, p.discard.length - n);
        const banished = [...(p.banished ?? []), ...p.discard.slice(cut)];
        players = { ...players, [side]: { ...p, discard: p.discard.slice(0, cut), banished } };
      }
      result = { ...result, players };
    }
  } else if (e.type === "BanishFamilyDiscardBuffSelf") {
    // Goule Dorak #893: "APPARITION : Bannit les Goules de votre défausse. Gagne +1 AT et +1 AR
    // par Goule bannie." Count the caster's NORMAL-discard cards of <family>, give +N×per AT and
    // +N×per AR to the source (permanent), then banish those cards (→ banished, inaccessible).
    const fam = (e as unknown as { family: string }).family;
    const per = Math.max(0, (e as { per?: number }).per ?? 1);
    const p = result.players[caster];
    const isFam = (id: number) => (getCard(id)?.families ?? []).includes(fam);
    const toBanish = p.discard.filter(isFam);
    if (toBanish.length > 0) {
      result = {
        ...result,
        players: { ...result.players, [caster]: { ...p, discard: p.discard.filter((id) => !isFam(id)), banished: [...(p.banished ?? []), ...toBanish] } },
      };
      const me = selfCell ? result.creatures.find((c) => sameCoords(c.position, selfCell) && c.currentLife > 0) : undefined;
      if (me) {
        const d = toBanish.length * per;
        result = {
          ...result,
          creatures: result.creatures.map((c) => (c.instanceId === me.instanceId
            ? { ...c, currentAttack: c.currentAttack + d, baseAttack: c.baseAttack + d, armor: c.armor + d }
            : c)),
          log: [...result.log,
            { type: "ATTACK_GAINED", instanceId: me.instanceId, attackMod: { valueBefore: me.currentAttack, modification: d, valueAfter: me.currentAttack + d } },
            { type: "ARMOR_GAINED", instanceId: me.instanceId, armorMod: { valueBefore: me.armor, modification: d, valueAfter: me.armor + d } },
          ],
        };
      }
    }
  } else if (e.type === "SetDiscardPaysCost") {
    // Repos Éternel #20: "Durant ce tour, ne dépensez pas de PA … à la place
    // bannissez des cartes de votre défausse." Per-turn flag; cleared at endTurn.
    const p = result.players[caster];
    result = { ...result, players: { ...result.players, [caster]: { ...p, discardPaysCost: true } } };
  } else if (e.type === "HandFreeThisTurn") {
    // Bas de Laine #1047: "Les cartes présentes dans votre main coûtent 0 PA si elles sont jouées durant
    // ce tour." Bas de Laine itself is already out of the hand at this point, so a large discount is
    // stamped on every remaining hand slot through handCostTempMods (effectiveCost floors the cost at 0;
    // endTurn lifts it at the end of the caster's own turn). Added on top of any existing temporary
    // surcharge.
    const p = result.players[caster];
    const temp = p.hand.map((_, i) => (p.handCostTempMods?.[i] ?? 0) - 99);
    result = { ...result, players: { ...result.players, [caster]: { ...p, handCostTempMods: temp } } };
  } else if (e.type === "TriggerRally") {
    // Ralliement #1014: the targeted creature performs a rally move now (force = it
    // need not own the keyword itself; the ally it joins still must).
    if (target) {
      const c = result.creatures.find((cr) => cr.currentLife > 0 && sameCoords(cr.position, target));
      if (c) result = applyRally(result, c.instanceId, true);
    }
  } else if (e.type === "PlaceTrap") {
    // Sram Bombe #101: lay a trap on the targeted (empty allied) cell. Any ground object already there,
    // a trap or another object (glyph/seed/butin/…), is replaced, never stacked (one ground object per
    // cell; the original game holds a single AOE per cell).
    if (target) {
      const ef = e as { cardId?: number; damage?: number };
      const rem: GameEvent[] = [];
      result = replaceGroundObjectsAt(result, target, rem);
      const trap: TrapInstance = { position: { ...target }, owner: caster, cardId: ef.cardId ?? 0, damage: Math.max(0, ef.damage ?? 0) };
      result = { ...result, traps: [...(result.traps ?? []), trap], log: [...result.log, ...rem] };
    }
  } else if (e.type === "GiveActiveTrap") {
    // Piège Mortel #624 …: drop the paired Activé card into the OPPONENT's hand
    // with a turn counter. They must play it before it expires (their endTurn), or
    // each of their Dofus takes `penalty`.
    const ef = e as { trapCardId?: number; counter?: number; penalty?: number };
    if (ef.trapCardId) {
      const opp = other(caster);
      result = addCardToHand(result, opp, ef.trapCardId, 1);
      const p = result.players[opp];
      result = { ...result, players: { ...result.players, [opp]: { ...p, activeTraps: [...(p.activeTraps ?? []), { cardId: ef.trapCardId, counter: Math.max(1, ef.counter ?? 1), penalty: Math.max(0, ef.penalty ?? 0) }] } } };
    }
  } else if (e.type === "SpendReserveDouble") {
    // "Dépense votre réserve pour en gagner le double ce tour", convert the
    // whole reserve to twice as much usable AP this turn.
    const p = result.players[caster];
    result = { ...result, players: { ...result.players, [caster]: { ...p, ap: p.ap + p.apReserve * 2, apReserve: 0 } } };
  } else if (e.type === "RecoverFromDiscard") {
    // "Place dans votre main la dernière invocation partie dans votre défausse" (Prince Belimberbe): pull
    // a card back out of the caster's discard into the hand. `summon`/`family` filter the candidates;
    // `which` = the most recent match ("last", default) or a random one. Does nothing if nothing matches.
    const ef = e as { summon?: boolean; spell?: boolean; family?: string; which?: string; all?: boolean; count?: number; eachPlayer?: boolean; maxCost?: number };
    // Indices of cards in `discard` that pass the summon/spell/family filters.
    // ("le dernier SORT" #418: only Spell/Aoe cardTypes qualify.)
    const matchIdxs = (discard: number[]): number[] => {
      const out: number[] = [];
      for (let i = 0; i < discard.length; i++) {
        const cd = getCard(discard[i]);
        if (!cd) continue;
        if (ef.summon && cd.cardType !== "Summon") continue;
        if (ef.spell && !(cd.cardType === "Spell" || cd.cardType === "Aoe")) continue;
        if (ef.family && !(cd.families ?? []).includes(ef.family)) continue;
        if (ef.maxCost != null && (cd.cost ?? 0) > ef.maxCost) continue; // Bouftou Céleste #128 "coûtant 6 PA ou moins"
        if ((ef as { rarity?: string }).rarity && cd.rarity !== (ef as { rarity?: string }).rarity) continue;
        // `cardId` recovers one precise card (Horloge #442 → le sort Sinistro #215).
        if ((ef as { cardId?: number }).cardId != null && discard[i] !== (ef as { cardId?: number }).cardId) continue;
        out.push(i);
      }
      return out;
    };
    // Pull the cards at `picks` (ascending indices into `side`'s discard) into the
    // CASTER's hand: drop them from that discard, then add oldest→newest (MAX_HAND
    // honoured inside addCardToHand).
    const recoverPicks = (side: Side, picks: number[], toSide: Side = caster, costMod = 0, toDeck = false) => {
      if (picks.length === 0) return;
      const pp = result.players[side];
      const cards = picks.map((i) => pp.discard[i]);
      const drop = new Set(picks);
      const discard = pp.discard.filter((_, i) => !drop.has(i));
      result = { ...result, players: { ...result.players, [side]: { ...pp, discard } } };
      if (toDeck) {
        // Indie #305 "les place sur votre pioche": onto the top of the deck (drawn
        // next, the deck convention is pop() from the end, so the end is the top).
        const tp = result.players[toSide];
        // Keep deckCostMods aligned: cards recovered from the discard come in at 0 (Vampyro reset), but the
        // array must grow so the other cards' stamps survive later draws.
        const baseMods = tp.deckCostMods && tp.deckCostMods.length === tp.deck.length ? tp.deckCostMods : tp.deck.map(() => 0);
        result = { ...result, players: { ...result.players, [toSide]: { ...tp, deck: [...tp.deck, ...cards], deckCostMods: [...baseMods, ...cards.map(() => 0)] } } };
      } else {
        for (const cid of cards) result = addCardToHand(result, toSide, cid, 1, costMod);
      }
    };
    if ((ef as { forSide?: string }).forSide === "enemy") {
      // Phorrerstein #1414: the opponent recovers their own last discard into their
      // hand (at a +costDelta penalty). Distinct from `fromEnemy`, which STEALS the
      // opponent's discard into the caster's hand.
      const opp = other(caster);
      const idxs = matchIdxs(result.players[opp].discard);
      if (idxs.length > 0) recoverPicks(opp, [idxs[idxs.length - 1]], opp, (ef as { costDelta?: number }).costDelta ?? 0);
    } else if (ef.eachPlayer) {
      // "le dernier <X> parti dans la défausse de CHAQUE joueur" (Bakara #303):
      // the most recent match from both discards, all into the caster's hand.
      for (const side of [caster, other(caster)] as Side[]) {
        const idxs = matchIdxs(result.players[side].discard);
        if (idxs.length > 0) recoverPicks(side, [idxs[idxs.length - 1]]);
      }
    } else {
      // `fromEnemy` pulls from the OPPONENT's discard instead of your own (Fripon
      // #73 "récupère 1 carte aléatoire de la défausse adverse"); the card still
      // lands in the CASTER's hand (recoverPicks always adds to `caster`).
      const srcSide = (ef as { fromEnemy?: boolean }).fromEnemy ? other(caster) : caster;
      const idxs = matchIdxs(result.players[srcSide].discard);
      // `costDelta` stamps the recovered card (Indie #454 "elle coûte 1 PA de moins" → −1).
      const cm = (ef as { costDelta?: number }).costDelta ?? 0;
      const toDeck = !!(ef as { toDeck?: boolean }).toDeck; // Indie #305: onto the deck, not the hand
      if (ef.all) {
        // "Récupère les <famille>s de votre défausse" (Armée des Ombres): every match.
        recoverPicks(srcSide, idxs, caster, cm, toDeck);
      } else if (ef.count && ef.count > 0) {
        // "les N derniers <X>" (Bakara #262): the last `count` matches, in pile order.
        recoverPicks(srcSide, idxs.slice(-ef.count), caster, cm);
      } else if (idxs.length > 0) {
        // Discard is appended oldest→newest, so the last matching index is the most
        // recently discarded match; `random` picks any match from the seeded rng.
        // When no rng is threaded in (the death-resolution path, resolveDeathsAndWin
        // calls this without one), seed from the STATE's rng and write the advanced
        // state back (same idiom as moveToRandomAdjacentRow) so the pick is
        // REPRODUCIBLE instead of falling back to a non-deterministic Math.random.
        let randIdx: number;
        if (rng) {
          randIdx = rng.int(idxs.length);
        } else {
          const roll = new Rng(result.rng);
          randIdx = roll.int(idxs.length);
          result = { ...result, rng: roll.state };
        }
        recoverPicks(srcSide, [ef.which === "random" ? idxs[randIdx] : idxs[idxs.length - 1]], caster, cm);
      }
    }
  }
  return { state: result, endsTurn };
}

// "Remonte / Place une invocation dans la main / sur la pioche de son
// propriétaire", a bounce: the creature leaves the board without dying (no
// MORT trigger, no discard), and its card id returns to a hand (top of) or deck
// (top = end of array, popped first). By default it goes to the creature's own
// owner; `toSide` overrides that, a steal ("Remonte dans VOTRE main", Zaldior)
// sends an enemy's card to the caster's hand instead. Hand bounces honour
// MAX_HAND (overflow burns to discard). Emits CARD_MOVED for the replay.
function bounceCreature(state: GameState, at: Coords, to: "hand" | "deck", toSide?: Side): GameState {
  const c = creatureAt(state, at);
  if (!c) return state;
  // INAMOVIBLE (Rooted) / Mur (Statue) "ne peut jamais être remonté", bounce
  // cannot return it to hand.
  if (isImmovable(c.properties)) {
    return state;
  }
  const dest = toSide ?? c.owner;
  // Remove the figurine from the board.
  let next: GameState = {
    ...state,
    creatures: state.creatures.filter((x) => x.instanceId !== c.instanceId),
    log: [
      ...state.log,
      { type: "FIGHT_OBJECT_REMOVED", instanceId: c.instanceId },
      { type: "CARD_MOVED", cardId: c.cardId, from: "board", to, side: dest },
    ],
  };
  if (to === "hand") {
    const before = next.players[dest].hand.length;
    next = addCardToHand(next, dest, c.cardId, 1);
    // A lasting cost modifier the card was played with (Vampyro/Wagnar reduction "jusqu'à ce qu'elle
    // soit défaussée") survives the trip board→hand: put it back on the new hand slot (the last one
    // added), unless MAX_HAND burned the card.
    const p = next.players[dest];
    if ((c.playedCostMod ?? 0) !== 0 && p.hand.length > before) {
      const mods = [...p.handCostMods];
      mods[mods.length - 1] = c.playedCostMod ?? 0;
      next = { ...next, players: { ...next.players, [dest]: { ...p, handCostMods: mods } } };
    }
  } else {
    // Board→deck bounce: carry the creature's playedCostMod (Vampyro/Wagnar −1) onto the new deck slot
    // and keep deckCostMods aligned, so a discounted creature sent back from the board keeps its
    // reduction when drawn again.
    const p = next.players[dest];
    const baseMods = p.deckCostMods && p.deckCostMods.length === p.deck.length ? p.deckCostMods : p.deck.map(() => 0);
    next = { ...next, players: { ...next.players, [dest]: { ...p, deck: [...p.deck, c.cardId], deckCostMods: [...baseMods, c.playedCostMod ?? 0] } } };
  }
  // Araknoplasme #416: "une invocation SUR LE TERRAIN remonte EN MAIN" → buff your family.
  if (to === "hand") next = buffFamilyOnBounce(next);
  return next;
}

// Each living holder of BuffFamilyOnBounce ({family, attack, armor}) grants +attack AT /
// +armor AR (permanent) to its OWNER's `family` creatures when a creature returns to hand
// (Araknoplasme #416: +1 AT/+1 AR to your Araknes). The just-bounced card is already off
// the board, so it is not buffed.
function buffFamilyOnBounce(state: GameState): GameState {
  const grants: { side: Side; family: string; at: number; ar: number }[] = [];
  for (const c of state.creatures) {
    if (c.currentLife <= 0) continue;
    const m = (getCard(c.cardId)?.effects ?? []).find((e) => e.type === "BuffFamilyOnBounce") as { family?: string; attack?: number; armor?: number } | undefined;
    if (m?.family) grants.push({ side: c.owner, family: m.family, at: m.attack ?? 0, ar: m.armor ?? 0 });
  }
  if (grants.length === 0) return state;
  return {
    ...state,
    creatures: state.creatures.map((c) => {
      let da = 0, dr = 0;
      const fams = getCard(c.cardId)?.families ?? [];
      for (const g of grants) if (c.owner === g.side && fams.includes(g.family)) { da += g.at; dr += g.ar; }
      return da || dr ? { ...c, currentAttack: c.currentAttack + da, baseAttack: c.baseAttack + da, armor: c.armor + dr } : c;
    }),
  };
}

// Compute again the continuous CHEF auras ("CHEF: +N AT/PM à vos autres X") and the conditional
// keywords (Tristepin's "initiative si un membre de la Confrérie est en jeu") across the board,
// returning a new creatures array (pure: it never mutates the input, so it is safe to call on any
// state). Each creature stores its current aura contribution; it is removed, added up again from
// every living chief, and the new total is folded back into the live stats. Idempotent: safe to call
// after any board change (summon / death / transform / control swap).
// Performance cache: withAuras took ~6.7% of the search time (V8 profile) and filtered the effects
// of every card again at every call (8 effect types × N creatures). Card definitions do not change
// at run time, so the aura profile is memoized by cardId. A plain lookup cache, with the effect
// order kept (filter is stable), so the result is the same to the bit.
interface AuraProfile {
  chief: Array<{ stat: "attack" | "movement" | "resistance" | "range"; amount: number; family?: string; allCamps?: boolean; enemy?: boolean }>;
  perFamily: Array<{ stats: ("attack" | "range" | "movement")[]; family: string; per: number; excludeSelf?: boolean }>;
  cond: Array<{ stat: "attack" | "range" | "movement"; amount: number; family?: string; cardId?: number; condition?: "woundedInPlay" | "enemyAheadOnRow" | "inOwnCamp" | "outnumbered" }>;
  wounded: Array<{ stat: "attack" | "range" | "movement"; amount: number }>;
  woundedRes: Array<{ amount: number }>;
  condArmor: Array<{ amount: number; family?: string; cardId?: number }>;
  condRes: Array<{ amount: number; family?: string; cardId?: number }>;
  condFS: Array<{ family?: string; condition?: "outnumbered" }>;
}
const auraProfileCache = new Map<number, AuraProfile>();
// Registry generation the cache is valid for. Registering again (registerCards) replaces the whole
// pool, so the profiles computed on the old registry have to go.
let auraProfileGen = -1;
function auraProfile(cardId: number): AuraProfile {
  const gen = registryGeneration();
  if (gen !== auraProfileGen) {
    auraProfileCache.clear();
    auraProfileGen = gen;
  }
  let prof = auraProfileCache.get(cardId);
  if (prof) return prof;
  const def = getCard(cardId);
  const effs = def?.effects ?? [];
  prof = {
    chief: effs.filter((e) => e.type === "ChiefAura") as never,
    perFamily: effs.filter((e) => e.type === "StatPerFamilyInPlay") as never,
    cond: effs.filter((e) => e.type === "ConditionalStatBoost") as never,
    wounded: effs.filter((e) => e.type === "WoundedStatBoost") as never,
    woundedRes: effs.filter((e) => e.type === "WoundedResistance") as never,
    condArmor: effs.filter((e) => e.type === "ConditionalArmorWhileAlly") as never,
    condRes: effs.filter((e) => e.type === "ConditionalResistanceWhileAlly") as never,
    condFS: effs.filter((e) => e.type === "ConditionalFirstStrike") as never,
  };
  // Do not memoize a missing card. If the registry is not filled yet, getCard returns undefined and the
  // profile above is empty: freezing it would silently take all its auras away from the card for the
  // rest of the process. It is computed again at the next call.
  if (def) auraProfileCache.set(cardId, prof);
  return prof;
}

export function withAuras(creatures: CreatureInstance[], seedSides?: Set<Side>): CreatureInstance[] {
  const next = creatures.map((c) => ({ ...c }));
  // Remember each creature's previous movement-aura contribution before step 1
  // zeroes it, so step 3 can push the CHANGE onto the live end-of-turn budget
  // (movementLeft), this is what makes a CHEF « +PM » aura take effect this turn.
  const prevAuraMovement = new Map(next.map((c) => [c.instanceId, c.auraMovement]));
  // 1. Strip the previous aura contribution back out of the live stats.
  for (const c of next) {
    c.currentAttack -= c.auraAttack;
    c.baseAttack -= c.auraAttack;
    c.baseMovement -= c.auraMovement;
    c.range -= c.auraRange;
    c.resistance -= c.auraResistance;
    c.auraAttack = 0;
    c.auraMovement = 0;
    c.auraRange = 0;
    c.auraResistance = 0;
    c.inCampAtk = 0; // re-derived in step 2b (Exécuteur #1425 inOwnCamp portion)
  }
  // 2. Re-sum every living chief's aura onto its allied (other) targets.
  for (const chief of next) {
    // A silenced chief loses its abilities, so it gives no aura. Recipients are not checked for silence:
    // the buff is the chief's ability given to allies, so a silenced ally still gets a living chief's
    // aura. Only silencing the chief removes it.
    if (chief.currentLife <= 0 || chief.silenced) continue;
    const auras = auraProfile(chief.cardId).chief;
    if (auras.length === 0) continue;
    for (const a of auras) {
      for (const t of next) {
        if (t.currentLife <= 0 || t.instanceId === chief.instanceId) continue;
        // Scope: `enemy` → enemy creatures only (Echo's "AT des invocations
        // adverses réduite"); else "vos autres" → allies, or allCamps → both.
        if (a.enemy) {
          if (t.owner === chief.owner) continue;
        } else if (!a.allCamps && t.owner !== chief.owner) continue;
        if (a.family && !(famsOf(t)).includes(a.family)) continue;
        if (a.stat === "attack") t.auraAttack += a.amount | 0;
        // Craqueboule Or #26: "CHEF : Augmente de 1 la résistance de vos autres
        // Craqueleurs", a continuous flat-reducer aura, routed through the same
        // auraResistance accumulator as the BLESSÉ keyword (stripped in step 1,
        // folded into `resistance` in step 3).
        else if (a.stat === "resistance") t.auraResistance += a.amount | 0;
        // Héroïne Stridulante #887: "CHEF : +1 portée à vos autres invocations", folded into
        // auraRange (stripped each pass, folded into `range` like Evangelyne's conditional range).
        else if (a.stat === "range") { if (t.range > 0) t.auraRange += a.amount | 0; } // +portée only on an existing shooter; inner check so range 0 does not fall through to movement
        else t.auraMovement += a.amount | 0;
      }
    }
  }
  // 2a-bis. Self auras per family count ("Gagne +N AT et +N portée PAR <famille> allié en jeu", Eclaireur
  //   d'Elite #1182). Continuous: count this carrier's living family allies (excludeSelf → "autre"),
  //   multiply by `per`, add to each listed aura accumulator (folded in at step 3, removed at the next
  //   recompute like the chief auras).
  for (const c of next) {
    if (c.currentLife <= 0 || c.silenced) continue; // silenced → provides no self-aura
    const auras = auraProfile(c.cardId).perFamily;
    for (const a of auras) {
      const n = next.filter((o) =>
        o.currentLife > 0 && o.owner === c.owner && (famsOf(o)).includes(a.family) &&
        !(a.excludeSelf && o.instanceId === c.instanceId)).length;
      if (n <= 0) continue;
      const bonus = n * (a.per | 0);
      for (const st of a.stats) {
        if (st === "attack") c.auraAttack += bonus;
        else if (st === "range") { if (c.range > 0) c.auraRange += bonus; } // +portée only on an existing shooter; inner check avoids movement fall-through
        else c.auraMovement += bonus;
      }
    }
  }
  // 2b. Conditional self stat boosts ("Gagne +N AT/portée si un AUTRE membre allié de <famille> est en
  //     jeu", Evangelyne). Continuous like the chief auras above: given while a living ally of that
  //     family is on the board, taken back otherwise. Goes through the same aura* accumulators so step 3
  //     folds them in and step 1 removes them at the next recompute.
  for (const c of next) {
    if (c.currentLife <= 0 || c.silenced) continue; // silenced → no conditional self-boost
    const conds = auraProfile(c.cardId).cond;
    for (const cond of conds) {
      let met: boolean;
      if (cond.condition === "inOwnCamp") {
        // Exécuteur Endeuillé: +N while it stands in its own territory.
        met = isAlliedTerritory(c.position.x, c.owner);
      } else if (cond.condition === "outnumbered") {
        // Zorine #668: +N AT while you are outnumbered, strictly fewer living invocations than the opponent
        // (same as conditionMet).
        const mine = next.filter((o) => o.currentLife > 0 && o.owner === c.owner).length;
        const foe = next.filter((o) => o.currentLife > 0 && o.owner !== c.owner).length;
        met = mine < foe;
      } else if (cond.condition === "enemyAheadOnRow") {
        // Canne Jalman: +N PM while an enemy is ahead of it on the same row.
        const dx = forwardDx(c.owner);
        met = next.some((o) => o.currentLife > 0 && o.owner !== c.owner && o.position.y === c.position.y && (o.position.x - c.position.x) * dx > 0);
      } else if (cond.condition === "woundedInPlay") {
        // Requinou: +N while at least one other invocation (any side) is wounded.
        met = next.some((o) => o.currentLife > 0 && o.instanceId !== c.instanceId && o.currentLife < o.baseLife);
      } else {
        // Condition: a creature satisfying the clause is in play. Either a member of a
        // family (Evangelyne → Confrérie du Tofu) or a specific card (Marcassinet → "tant
        // que vous avez une Glaie en jeu", cond.cardId). Allied-only by default; allCamps
        // counts both camps (Snouffle Noir #866 "tant qu'un Coffre est en jeu", any side).
        const allCamps = (cond as { allCamps?: boolean }).allCamps;
        met = next.some(
          (o) =>
            o.currentLife > 0 &&
            o.instanceId !== c.instanceId &&
            (allCamps || o.owner === c.owner) &&
            (cond.cardId != null
              ? o.cardId === cond.cardId
              : (famsOf(o)).includes(cond.family!)),
        );
      }
      if (!met) continue;
      if (cond.stat === "attack") {
        c.auraAttack += cond.amount | 0;
        // Exécuteur Endeuillé #1425: record the part that depends on the position (inOwnCamp) so the
        // mid-advance resync (applyWalkOverPickups) can drop it the moment the creature leaves its camp.
        if (cond.condition === "inOwnCamp") c.inCampAtk = (c.inCampAtk ?? 0) + (cond.amount | 0);
      } else if (cond.stat === "movement") c.auraMovement += cond.amount | 0;
      else if (c.range > 0) c.auraRange += cond.amount | 0; // +portée only on an existing shooter
    }
  }
  // 2c. Self stat boosts while wounded ("BLESSÉ : +N AT/PM", the Sacrieur keyword; Dureden #323 +2 AT,
  //     Arakne #475 +1 PM). Continuous: the bonus is given while the creature is wounded (its
  //     currentLife is below its max baseLife) and taken back the moment it is healed to full; BLESSÉ is
  //     a live state, not a one-shot. Goes through the same aura* accumulators so step 3 folds them in
  //     and step 1 removes them at the next recompute. Auras never touch baseLife, so it stays the real
  //     max here, and the recompute runs after every life change (resolveDeathsAndWin → withAuras fires
  //     after combat, spells and heals).
  for (const c of next) {
    if (c.currentLife <= 0 || c.silenced) continue; // silenced → no BLESSÉ self-boost
    if (c.currentLife >= c.baseLife) continue; // not wounded → no bonus
    const prof2c = auraProfile(c.cardId);
    for (const cond of prof2c.wounded) {
      if (cond.stat === "attack") c.auraAttack += cond.amount | 0;
      else if (cond.stat === "movement") c.auraMovement += cond.amount | 0;
      else if (c.range > 0) c.auraRange += cond.amount | 0; // +portée only on an existing shooter
    }
    // BLESSÉ : gagne résistance N (Maude #1765), flat reducer while wounded.
    for (const cond of prof2c.woundedRes) {
      c.auraResistance += cond.amount | 0;
    }
  }
  // 2d. Conditional armour ("Gagne +N AR tant que vous avez un [autre] <famille|carte> en jeu", Rat
  //     Devil #387 → Rat Dechant #91, Boufton Noir #559 → autre Gobbal). Armour is a pool that gets used
  //     up, not a continuous aura, so this works on transitions: give +N once when the condition turns
  //     true, remove +N (floored at 0) when it turns false. How much was given is kept in
  //     `condArmorGranted` so each recompute only applies the difference: idempotent while the condition
  //     holds, and a pool already spent in combat is never given again. Self excluded by instanceId
  //     (handles the "autre" in #559, harmless for the cross-card #387).
  for (const c of next) {
    const conds = auraProfile(c.cardId).condArmor;
    const have = c.condArmorGranted ?? 0;
    if (conds.length === 0 || c.silenced) {
      // Card lost the effect, transform (cardId changed → no conds) or SILENCE (abilities stripped):
      // drop the bookkeeping so a later condition-transition cannot re-grant. handleSilence already
      // zeroed the live armor pool, so nothing to subtract here.
      if (have !== 0) c.condArmorGranted = 0;
      continue;
    }
    let want = 0;
    if (c.currentLife > 0) {
      for (const cond of conds) {
        const met = next.some(
          (o) =>
            o.currentLife > 0 &&
            o.instanceId !== c.instanceId &&
            o.owner === c.owner &&
            (cond.cardId != null ? o.cardId === cond.cardId : (famsOf(o)).includes(cond.family!)),
        );
        if (met) want += cond.amount | 0;
      }
    }
    if (want !== have) {
      c.armor = Math.max(0, c.armor + (want - have));
      c.condArmorGranted = want;
    }
  }
  // 2e. Conditional RÉSISTANCE ("Gagne résistance N tant qu'un AUTRE membre allié de <famille> est en
  //     jeu", Poo #581, Fratrie des Oubliés). Unlike armour, résistance is a flat reducer computed again
  //     each pass (auraResistance is reset to zero each pass), so this is a pure aura with no transition
  //     bookkeeping: give +N to auraResistance while another living ally of the family is on the board,
  //     otherwise nothing. Folded into resistance at step 3 below.
  for (const c of next) {
    if (c.currentLife <= 0 || c.silenced) continue; // silenced → no conditional résistance
    const conds = auraProfile(c.cardId).condRes;
    for (const cond of conds) {
      const met = next.some(
        (o) =>
          o.currentLife > 0 &&
          o.instanceId !== c.instanceId &&
          o.owner === c.owner &&
          (cond.cardId != null ? o.cardId === cond.cardId : (famsOf(o)).includes(cond.family!)),
      );
      if (met) c.auraResistance += cond.amount | 0;
    }
  }
  // 3. Fold the fresh aura back in. (movementLeft is refreshed from baseMovement
  // at the owner's turn start, so movement auras take effect next turn.)
  for (const c of next) {
    // Floor attack / movement at 0, an aura can REDUCE them now (Echo's enemy-AT
    // debuff), and a negative stat is meaningless (and would heal in combat).
    c.currentAttack = Math.max(0, c.currentAttack + c.auraAttack);
    c.baseAttack = Math.max(0, c.baseAttack + c.auraAttack);
    c.baseMovement = Math.max(0, c.baseMovement + c.auraMovement);
    c.range += c.auraRange;
    c.resistance += c.auraResistance;
    // A CHEF "+PM" aura (Goultard le Barbare #310) must affect the current end-of-turn advance right away,
    // like the +AT aura is folded into currentAttack, and like a direct +PM buff (see STAT_FIELDS.movement
    // in effects.ts). The change in the movement aura is pushed onto the live budget: a positive change
    // gives the extra cell(s) this turn only to a creature already free to move (movementLeft > 0, so a
    // unit with summoning sickness at 0 keeps its bonus for next turn); a negative change caps the
    // remaining budget to the new PM. A creature's own PM change mid-advance (Tristepin +PM on damage)
    // goes through baseMovement, not auraMovement, so it is untouched here and stays frozen for this
    // turn, which is the intended split.
    const dAuraMv = c.auraMovement - (prevAuraMovement.get(c.instanceId) ?? 0);
    if (dAuraMv > 0) { if (c.movementLeft > 0) c.movementLeft += dAuraMv; }
    else if (dAuraMv < 0) c.movementLeft = Math.min(c.movementLeft, c.baseMovement);
  }
  // 4. Conditional FirstStrike ("Gagne initiative si un AUTRE membre allié de <famille> est en jeu",
  //    Tristepin). Continuous: given while a living ally of that family is on the board, taken back
  //    otherwise. This code owns the FirstStrike bit for these creatures (their built-in one is not set
  //    at summon, see summonCreature), so toggling it here is the single source.
  for (const c of next) {
    if (c.currentLife <= 0 || c.silenced) continue; // silenced → loses its own conditional initiative
    const conds = auraProfile(c.cardId).condFS;
    if (conds.length === 0) continue;
    const met = conds.some((cond) => {
      if (cond.condition === "outnumbered") {
        // Zorine #668: initiative while you are outnumbered, strictly fewer living invocations than the
        // opponent.
        const mine = next.filter((o) => o.currentLife > 0 && o.owner === c.owner).length;
        const foe = next.filter((o) => o.currentLife > 0 && o.owner !== c.owner).length;
        return mine < foe;
      }
      return next.some(
        (o) =>
          o.currentLife > 0 &&
          o.instanceId !== c.instanceId &&
          o.owner === c.owner &&
          (famsOf(o)).includes(cond.family!),
      );
    });
    c.properties = new Set(c.properties); // clone before mutating the shared Set
    if (met) c.properties.add("FirstStrike");
    else c.properties.delete("FirstStrike");
  }
  // 4b. Properties while wounded ("BLESSÉ : gagne initiative", Grouilleux #309, Edass #43). Continuous
  //     like step 4: the listed property is given while the creature is wounded and taken back the
  //     moment it is full again. This code owns these bits (not set at summon: summonCreature skips them
  //     when a WoundedProperty exists), so toggling here is the single source.
  for (const c of next) {
    if (c.currentLife <= 0 || c.silenced) continue; // silenced → loses its own BLESSÉ property
    const props = (getCard(c.cardId)?.effects ?? []).filter(
      (e) => e.type === "WoundedProperty",
    ) as Array<{ property: string }>;
    if (props.length === 0) continue;
    const wounded = c.currentLife < c.baseLife;
    c.properties = new Set(c.properties); // clone before mutating the shared Set
    for (const p of props) {
      if (wounded) c.properties.add(p.property);
      else c.properties.delete(p.property);
    }
  }
  // 4c. Conditional family properties ("Gagne initiative ET inciblable TANT QUE vous avez un AUTRE
  //     <famille> en jeu", Korbax #379, FirstStrike + Untargetable while another living Justicier ally
  //     exists). Continuous like step 4 (family ally check) but gives a list of properties. This code
  //     owns these bits (not set at summon: Korbax only has the ConditionalFamilyProperties marker, no
  //     SetPropertyData), so toggling here is the single source.
  for (const c of next) {
    if (c.currentLife <= 0 || c.silenced) continue; // silenced → loses its own conditional family keywords (Korbax #379)
    const conds = (getCard(c.cardId)?.effects ?? []).filter(
      (e) => e.type === "ConditionalFamilyProperties",
    ) as Array<{ properties: string[]; family: string; allCamps?: boolean }>;
    if (conds.length === 0) continue;
    c.properties = new Set(c.properties); // clone before mutating the shared Set
    for (const cond of conds) {
      const met = next.some(
        (o) => o.currentLife > 0 && o.instanceId !== c.instanceId && (cond.allCamps || o.owner === c.owner) && (famsOf(o)).includes(cond.family),
      );
      for (const p of cond.properties ?? []) {
        if (met) c.properties.add(p);
        else c.properties.delete(p);
      }
    }
  }
  // 5. Conditional seed properties ("Gagne initiative et inciblable tant que vous avez une Graine en
  //    jeu", Kolo Kolko). Continuous: the listed properties are given while the creature's owner has at
  //    least 1 planted seed, taken back otherwise. This code owns these bits (not set at summon, see
  //    summonCreature), so toggling here is the single source. Only runs when seedSides is given (every
  //    useful recompute passes it); a bare withAuras() leaves the bits as they are rather than wrongly
  //    clearing them.
  if (seedSides) {
    for (const c of next) {
      if (c.currentLife <= 0 || c.silenced) continue; // silenced → loses its own seed-conditional keywords (Kolo Kolko)
      const conds = (getCard(c.cardId)?.effects ?? []).filter(
        (e) => e.type === "ConditionalSeedProperty",
      ) as Array<{ properties: string[] }>;
      if (conds.length === 0) continue;
      const met = seedSides.has(c.owner);
      c.properties = new Set(c.properties);
      for (const cond of conds) {
        for (const p of cond.properties ?? []) {
          if (met) c.properties.add(p);
          else c.properties.delete(p);
        }
      }
    }
  }
  // 5b. Moon guard (Pleine Lune #746): "Tant qu'une lune est en jeu, les dégâts subis par vos Mulous
  //     sont réduits de 1". A side that owns a living FullMoon creature ("une lune") gives MoonGuard to
  //     its living Mulous; applyDamageToCreature / ...FromSpell take 1 off each hit. Continuous, owned
  //     here (not set at summon), toggled at every recompute.
  {
    const moonSides = new Set<Side>();
    for (const c of next) if (c.currentLife > 0 && c.properties.has("FullMoon")) moonSides.add(c.owner);
    for (const c of next) {
      if (c.currentLife <= 0 || !(famsOf(c)).includes("Mulou")) continue;
      c.properties = new Set(c.properties);
      if (moonSides.has(c.owner)) c.properties.add("MoonGuard");
      else c.properties.delete("MoonGuard");
    }
  }
  // 6. CHEF property auras ("CHEF : Donne <keyword> à vos AUTRES invocations",
  //    Dan Lemil #718 perce armure, Joris #307 inciblable). The source grants a
  //    property to every other living ally while it is on the board. We track what
  //    each creature received in `auraProperties`, so revoking the grant (the
  //    chief left) never strips a property the recipient holds innately.
  for (const t of next) {
    const prev = t.auraProperties ?? EMPTY_PROPS;
    const granted = new Set<string>();
    if (t.currentLife > 0) {
      for (const src of next) {
        if (src.currentLife <= 0 || src.silenced || src.instanceId === t.instanceId) continue; // skip dead + silenced (loses its aura) + self
        for (const e of getCard(src.cardId)?.effects ?? []) {
          // ChiefPropertyAura: to your other invocations (same camp only).
          if (e.type === "ChiefPropertyAura" && src.owner === t.owner) granted.add((e as { property: string }).property);
          // RootAllAura (Arakne à Crochets #1457): Rooted on all the other invocations, both camps
          // (it stays INAMOVIBLE itself through its own SetPropertyData, not through the aura).
          else if (e.type === "RootAllAura") granted.add("Rooted");
        }
      }
    }
    if (prev.size === 0 && granted.size === 0) continue; // nothing to reconcile (common case)
    const props = new Set(t.properties);
    for (const p of prev) props.delete(p);              // strip last round's grants
    const nextAura = new Set<string>();
    for (const p of granted) {
      if (!props.has(p)) { props.add(p); nextAura.add(p); } // add only if not innate / another source
    }
    t.properties = props;
    t.auraProperties = nextAura;
  }
  return next;
}
const EMPTY_PROPS: ReadonlySet<string> = new Set();

// Which sides currently have at least one planted seed on the board (drives the
// ConditionalSeedProperty auras, Kolo Kolko).
function seedSidesOf(state: GameState): Set<Side> {
  const s = new Set<Side>();
  for (const seed of state.seeds ?? []) s.add(seed.owner);
  return s;
}

// Recompute all auras (chief / conditional / seed) against the live board +
// seeds. Call after any change to the planted seeds so seed-conditional
// properties (Kolo Kolko) flip in lockstep with gaining/losing a seed.
function recomputeAuras(state: GameState): GameState {
  return { ...state, creatures: withAuras(state.creatures, seedSidesOf(state)) };
}

// RALLIEMENT reaction cards (keyed by id, like Golgor): #948 Chauchane (+1 AT) and
// #660 Duc Rex (a Shield) react as the target, they buff THEMSELVES when another
// creature rallies to them. #834 Arty reacts as the target too but buffs the RALLIER
// (clears its summoning sickness). #762 Igor Tex is the ODD one out: it acts as the
// RALLIER ("Donne +1 PM aux invocations qu'il rallie", IL rallie), so when Igor
// advances to align with allies, those allies (the targets) gain +1 PM. Handled below
// keyed on the rallier's cardId, not the target's.
const CHAUCHANE_CARD_ID = 948;
const DUC_REX_CARD_ID = 660;
const IGOR_TEX_CARD_ID = 762;
const ARTY_CARD_ID = 834;

// RALLIEMENT (Féca keyword). When a creature with the Ralliement property is summoned on a row next to
// an allied Ralliement creature that is strictly more advanced, the new creature walks forward along
// its own row until it reaches that ally's column: the nearest such ally ahead ("la première
// rencontrée sur le côté"). The walk collects prisms/seeds/butins like a charge but never fights: it
// stops in front of any creature in its path ("s'arrête devant"). Called right after the summon,
// before the APPARITION.
function applyRally(state: GameState, instanceId: number, force = false): GameState {
  const me0 = state.creatures.find((c) => c.instanceId === instanceId && c.currentLife > 0);
  if (!me0) return state;
  // The rallier normally needs the Ralliement keyword; the spell Ralliement #1014
  // ("permet à l'invocation ciblée de rallier") grants the move to any creature
  // (force), but the target it joins must still own the keyword (checked below).
  if (!force && !me0.properties.has("Ralliement")) return state;
  const dx = forwardDx(me0.owner);
  const sx = me0.position.x;
  const sy = me0.position.y;
  let rallyCol: number | null = null;
  for (const c of state.creatures) {
    if (c.currentLife <= 0 || c.instanceId === instanceId) continue;
    if (c.owner !== me0.owner || !c.properties.has("Ralliement")) continue;
    if (Math.abs(c.position.y - sy) !== 1) continue;          // adjacent row
    const ahead = (c.position.x - sx) * dx;                    // >0 ⇒ ahead, 0 ⇒ same column (côte à côte)
    // The rally fires for a Ralliement creature ahead (the rallier advances to line up) or one already
    // side by side on the next row, same column (ahead==0, no advance). A creature behind (ahead<0) is
    // not a rally target.
    if (ahead < 0) continue;
    if (rallyCol === null || ahead < (rallyCol - sx) * dx) rallyCol = c.position.x; // nearest at-or-ahead
  }
  if (rallyCol === null) return state;                         // nothing to rally to
  const creatures = state.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
  const dofuses = state.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
  const log: GameEvent[] = [...state.log];
  const me = creatures.find((c) => c.instanceId === instanceId)!;
  const tracking: AdvanceTracking = {
    brokeThroughIds: new Set<number>(),
    prismCellKeys: new Set(state.prisms.map((p) => `${p.position.x},${p.position.y}`)),
    collectedPrismKeys: new Set<string>(),
    prismPickups: [],
    seedCells: buildSeedCells(state), consumedSeedKeys: new Set<string>(),
    glyphCells: buildGlyphCells(state), consumedGlyphKeys: new Set<string>(),
    tasDOsCells: buildTasDOsCells(state), consumedTasDOsKeys: new Set<string>(),
    bushCells: buildBushCells(state), consumedBushKeys: new Set<string>(),
    butinCells: buildButinCells(state), consumedButinKeys: new Set<string>(), butinPickups: [],
    giftCells: buildGiftCells(state), consumedGiftKeys: new Set<string>(), giftRng: new Rng((state.rng ^ GIFT_ROLL_SALT) | 0), giftRolls: { ally: 0, enemy: 0 },
    trapCells: buildTrapCells(state), consumedTrapKeys: new Set<string>(), trapPickups: [],
  };
  const savedML = me.movementLeft;
  me.movementLeft = Math.abs(rallyCol - sx);                   // distance to the rally column
  advanceCreature(me, creatures, dofuses, log, me.owner, dx, tracking, { noCombat: true, stopAtCol: rallyCol });
  me.movementLeft = savedML;                                  // rally is an extra move (like charge)

  // Rally reactions (keyed by the id of the target on the board, like Golgor): the rally creature(s) S
  // reached, at the rally column on a next row, react when rallied. The rally "happens" on summon
  // (conditions met), so these fire even if S was blocked before the column.
  const targets = creatures.filter((c) =>
    c.currentLife > 0 && c.owner === me.owner && c.instanceId !== instanceId &&
    c.properties.has("Ralliement") && Math.abs(c.position.y - sy) === 1 && c.position.x === rallyCol);
  // #762 Igor Tex is the RALLIER (me), not a target: "Donne +1 PM aux invocations
  // qu'il rallie", when Igor advances to pull level with allied Ralliement creatures,
  // each of them (the targets) gains +1 PM. baseMovement is permanent (survives
  // recomputeAuras, like Chauchane's +1 AT); movementLeft is bumped too so an already-
  // on-board target advances 3 this turn (startTurn set movementLeft = old baseMovement).
  const meRalliesAndGivesPm = me.cardId === IGOR_TEX_CARD_ID;
  for (const t of targets) {
    if (meRalliesAndGivesPm) {
      t.baseMovement += 1;
      t.movementLeft += 1;
    }
    if (t.cardId === CHAUCHANE_CARD_ID) {
      // "Gagne +1 AT quand une invocation la rallie", permanent (base + live).
      t.baseAttack += 1;
      t.currentAttack += 1;
    } else if (t.cardId === DUC_REX_CARD_ID) {
      t.properties = new Set(t.properties); // clone before mutating the shared Set (aliasing)
      t.properties.add("Shield"); // "Gagne un bouclier quand une invocation le rallie"
    } else if (t.cardId === ARTY_CARD_ID) {
      // "Annule le mal d'invocation des invocations qui le rallient", the RALLIER
      // can act this turn.
      me.hasAttacked = false;
      me.movementLeft = me.baseMovement;
    }
  }
  let result: GameState = { ...state, creatures, dofuses, log };
  result = removeConsumedSeeds(result, tracking.consumedSeedKeys);
  result = removeConsumedGlyphs(result, tracking.consumedGlyphKeys);
  result = removeConsumedTasDOs(result, tracking.consumedTasDOsKeys);
  result = removeConsumedBushes(result, tracking.consumedBushKeys);
  result = removeConsumedButins(result, tracking.consumedButinKeys);
  result = removeConsumedGifts(result, tracking.consumedGiftKeys);
  result = removeConsumedTraps(result, tracking.consumedTrapKeys);
  result = applyTrapPickups(result, tracking.trapPickups);
  const rng = new Rng(result.rng);
  result = applyButinPickups(result, tracking.butinPickups, rng);
  result = applyGiftRollReactions(result, tracking);
  result = { ...result, rng: rng.state };
  for (const pk of tracking.prismPickups) result = activatePrism(result, pk.at, pk.side, pk.props, undefined, pk.byInstanceId);
  return recomputeAuras(result);                              // the move may change aura ranges
}

// "APPARITION : charge de N cases" (Corbac #56 …): the just-summoned creature
// advances N cells right now (with combat, it attacks anything it reaches), like a
// spell Charge but self-targeted. Reuses the advance machinery: deaths/captures are
// settled by resolveDeathsAndWin, and prism/seed/butin/trap pickups along the way
// are applied. The creature stays summoning-sick afterwards (no end-of-turn move).
function applyChargeOnSummon(state: GameState, instanceId: number, cells: number): GameState {
  const me0 = state.creatures.find((c) => c.instanceId === instanceId && c.currentLife > 0);
  if (!me0 || cells <= 0) return state;
  // "pas de charge" for an INAMOVIBLE / Mur: a forced charge (Grany #289, Coppa #1048 MORT, Lait de
  // Bambou #506…) does not move it. (advanceCreature would block it too, but we return here so no
  // charge FX is emitted without a move.)
  if (isImmovable(me0.properties)) return state;
  // A charge from an effect is an extra move (same convention as chargeAllies and the RALLIEMENT): it
  // must not use up the creature's normal end-of-turn PM advance. The movement budget from before the
  // charge is saved and restored after it. This tells the two callers apart without a special case: a
  // charger that was just summoned had movementLeft 0 (it has summoning sickness, the charge is its
  // only move, so restoring 0 keeps it in place at end of turn), while a creature already in play
  // (Justice #130 targets an existing ally) had its full PM, so it still takes its fin-de-tour advance.
  const pmBudget = me0.movementLeft;
  const dx = forwardDx(me0.owner);
  const creatures = state.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
  const dofuses = state.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
  const log: GameEvent[] = [...state.log];
  const me = creatures.find((c) => c.instanceId === instanceId)!;
  const tracking: AdvanceTracking = {
    brokeThroughIds: new Set<number>(),
    prismCellKeys: new Set(state.prisms.map((p) => `${p.position.x},${p.position.y}`)),
    collectedPrismKeys: new Set<string>(),
    prismPickups: [],
    seedCells: buildSeedCells(state), consumedSeedKeys: new Set<string>(),
    glyphCells: buildGlyphCells(state), consumedGlyphKeys: new Set<string>(),
    tasDOsCells: buildTasDOsCells(state), consumedTasDOsKeys: new Set<string>(),
    bushCells: buildBushCells(state), consumedBushKeys: new Set<string>(),
    butinCells: buildButinCells(state), consumedButinKeys: new Set<string>(), butinPickups: [],
    giftCells: buildGiftCells(state), consumedGiftKeys: new Set<string>(), giftRng: new Rng((state.rng ^ GIFT_ROLL_SALT) | 0), giftRolls: { ally: 0, enemy: 0 },
    trapCells: buildTrapCells(state), consumedTrapKeys: new Set<string>(), trapPickups: [],
  };
  me.movementLeft = cells;
  // Display marker: the creature charges (its own ability, with the charge FX and sound); this is not a
  // PM bonus. Emitted before the advance so the FX starts before the move. Additive, can be ignored.
  log.push({ type: "MOVEMENT_POINT_BOOST", instanceId: me.instanceId, movementMod: { valueBefore: pmBudget, modification: cells - pmBudget, valueAfter: cells }, charge: true });
  advanceCreature(me, creatures, dofuses, log, me.owner, dx, tracking, { chargeMelee: true }); // combat enabled; a charging shooter melees only (rule 9)
  if (me.currentLife > 0) me.movementLeft = pmBudget; // restore the end-of-turn advance budget (0 for a summon = keeps summoning sickness; full PM for a target already in play = still advances)
  // A kill made during this charge fires the charger's COUP DE GRÂCE (Milkar #46 "COUP DE GRÂCE :
  // Charge" killing on its APPARITION charge). Captured from the pre-cull creatures array, fired on the
  // settled board below.
  // Limits: a creature that broke through is not a victim, and the backward scan stops at the start of
  // this charge (the log covers the whole game).
  const cdgKills = collectCdgKills(creatures, log, tracking.brokeThroughIds, state.log.length);
  let result = resolveDeathsAndWin({ ...state, creatures, dofuses, log }, creatures, dofuses, log, tracking.brokeThroughIds);
  result = removeConsumedSeeds(result, tracking.consumedSeedKeys);
  result = removeConsumedGlyphs(result, tracking.consumedGlyphKeys);
  result = removeConsumedTasDOs(result, tracking.consumedTasDOsKeys);
  result = removeConsumedBushes(result, tracking.consumedBushKeys);
  result = removeConsumedButins(result, tracking.consumedButinKeys);
  result = removeConsumedGifts(result, tracking.consumedGiftKeys);
  result = removeConsumedTraps(result, tracking.consumedTrapKeys);
  result = applyTrapPickups(result, tracking.trapPickups);
  const rng = new Rng(result.rng);
  result = applyButinPickups(result, tracking.butinPickups, rng);
  result = applyGiftRollReactions(result, tracking);
  result = { ...result, rng: rng.state };
  for (const pk of tracking.prismPickups) result = activatePrism(result, pk.at, pk.side, pk.props, undefined, pk.byInstanceId);
  // COUP DE GRÂCE fires last, on the settled board (a charger that survived + killed).
  result = fireCoupDeGrace(result, cdgKills);
  result = applyKillToButin(result, cdgKills); // Toutancoffron #633 carrier charging into a kill
  return result;
}

// State-level wrapper for ChargeAllies replayed off a death trigger (Bébé Tofu #541
// "MORT : vos tofus chargent"): advances the caster's matching allies with the full
// tracking machinery, then settles deaths and consumed board objects (mirror of
// applyChargeOnSummon, but charging a scope of allies instead of one creature).
function applyChargeAlliesOnState(state: GameState, casterSide: Side, cells: number | undefined, excludeId: number | undefined, family: string | undefined, wounded?: boolean): GameState {
  const creatures = state.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
  const dofuses = state.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
  const log: GameEvent[] = [...state.log];
  const tracking: AdvanceTracking = {
    brokeThroughIds: new Set<number>(),
    prismCellKeys: new Set(state.prisms.map((p) => `${p.position.x},${p.position.y}`)),
    collectedPrismKeys: new Set<string>(),
    prismPickups: [],
    seedCells: buildSeedCells(state), consumedSeedKeys: new Set<string>(),
    glyphCells: buildGlyphCells(state), consumedGlyphKeys: new Set<string>(),
    tasDOsCells: buildTasDOsCells(state), consumedTasDOsKeys: new Set<string>(),
    bushCells: buildBushCells(state), consumedBushKeys: new Set<string>(),
    butinCells: buildButinCells(state), consumedButinKeys: new Set<string>(), butinPickups: [],
    giftCells: buildGiftCells(state), consumedGiftKeys: new Set<string>(), giftRng: new Rng((state.rng ^ GIFT_ROLL_SALT) | 0), giftRolls: { ally: 0, enemy: 0 },
    trapCells: buildTrapCells(state), consumedTrapKeys: new Set<string>(), trapPickups: [],
  };
  chargeAllies(creatures, dofuses, log, casterSide, cells, excludeId, family, tracking, wounded);
  // Same limits as above.
  const cdgKills = collectCdgKills(creatures, log, tracking.brokeThroughIds, state.log.length); // a charged ally killing fires its own COUP DE GRÂCE
  let result = resolveDeathsAndWin({ ...state, creatures, dofuses, log }, creatures, dofuses, log, tracking.brokeThroughIds);
  result = removeConsumedSeeds(result, tracking.consumedSeedKeys);
  result = removeConsumedGlyphs(result, tracking.consumedGlyphKeys);
  result = removeConsumedTasDOs(result, tracking.consumedTasDOsKeys);
  result = removeConsumedBushes(result, tracking.consumedBushKeys);
  result = removeConsumedButins(result, tracking.consumedButinKeys);
  result = removeConsumedGifts(result, tracking.consumedGiftKeys);
  result = removeConsumedTraps(result, tracking.consumedTrapKeys);
  result = applyTrapPickups(result, tracking.trapPickups);
  const rng = new Rng(result.rng);
  result = applyButinPickups(result, tracking.butinPickups, rng);
  result = applyGiftRollReactions(result, tracking);
  result = { ...result, rng: rng.state };
  for (const pk of tracking.prismPickups) result = activatePrism(result, pk.at, pk.side, pk.props, undefined, pk.byInstanceId);
  result = fireCoupDeGrace(result, cdgKills);
  result = applyKillToButin(result, cdgKills);
  return result;
}

// `fireApparition` is true only when the card is played from hand. Creatures that appear through a
// spell or an effect (SummonToken, transforms, Gelax's Jelly on a contre-coup…) do not play their own
// "À l'invocation" ability, but they keep their built-in keywords (SelfCharge, properties) and still
// let other creatures react through ENTERS_PLAY.
//
// Exception, La Folle #481: her text ("Réduit de 1 PA le coût de votre prochaine carte jouée") has no
// "APPARITION :" label on the card. It is built in, not an "À l'invocation" ability, so it applies
// however she enters play (hand, Dodu #318's TransformSeed, Amalia #368's SummonToken, Graines de
// Folie #162). The authored data can only encode it as an APPARITION trigger, so effect summons must
// not skip it like they skip real labelled apparitions.
const UNLABELED_APPARITION_IDS = new Set([481]);

// A creature that was just summoned lands on its cell exactly like a walking step: a Seed / Piège /
// Glyphe there must fire right now, for both sides. An allied object gives its bonus (graine +1 AR,
// glyphe Féca +AR), an enemy object hits it (graine/piège damage) or is destroyed (glyphe), the same
// as walking onto the cell ("posé dessus = marche dessus"). Goes through the same
// applyWalkOverPickups + settle pass as Téléportation #119 / relocateThenPickup, so the summon-on and
// walk-on rules can never drift apart. Butin / Tas d'Os / prisme are not handled here:
// summonCreature settles them itself (butin reward timing, tas built into the new instance, the
// prism's self-carrier guard), so their tracking maps stay empty to avoid handling them twice. An
// enemy seed/piège can kill the newcomer (resolveDeathsAndWin) before its APPARITION fires.
function applySummonGroundPickups(state: GameState, instanceId: number, at: Coords): GameState {
  const onSeed = (state.seeds ?? []).some((s) => sameCoords(s.position, at));
  const onGlyph = (state.glyphs ?? []).some((g) => sameCoords(g.position, at));
  const onTrap = (state.traps ?? []).some((t) => sameCoords(t.position, at));
  if (!onSeed && !onGlyph && !onTrap) return state; // nothing underfoot → no-op fast path
  const creatures = state.creatures.map((cr) => ({ ...cr, position: { ...cr.position }, properties: new Set(cr.properties) }));
  const dofuses = state.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
  const moved = creatures.find((cr) => cr.instanceId === instanceId && cr.currentLife > 0);
  if (!moved) return state;
  const log: GameEvent[] = [...state.log];
  const tr: AdvanceTracking = {
    brokeThroughIds: new Set<number>(),
    // Prism is settled by summonCreature's own activatePrism (self-carrier guard), skip here.
    prismCellKeys: new Set<string>(), collectedPrismKeys: new Set<string>(), prismPickups: [],
    seedCells: buildSeedCells(state), consumedSeedKeys: new Set<string>(),
    glyphCells: buildGlyphCells(state), consumedGlyphKeys: new Set<string>(),
    // Butin / Tas d'Os / Buisson settled inline by summonCreature → empty maps, no double-handling.
    tasDOsCells: new Map<string, Side>(), consumedTasDOsKeys: new Set<string>(),
    bushCells: new Set<string>(), consumedBushKeys: new Set<string>(),
    butinCells: new Set<string>(), consumedButinKeys: new Set<string>(), butinPickups: [],
    giftCells: new Set<string>(), consumedGiftKeys: new Set<string>(), giftRng: new Rng((state.rng ^ GIFT_ROLL_SALT) | 0), giftRolls: { ally: 0, enemy: 0 },
    trapCells: buildTrapCells(state), consumedTrapKeys: new Set<string>(), trapPickups: [],
  };
  applyWalkOverPickups(moved, at.x, at.y, creatures, log, tr);
  let result = resolveDeathsAndWin({ ...state, creatures, dofuses, log }, creatures, dofuses, log, tr.brokeThroughIds);
  result = removeConsumedSeeds(result, tr.consumedSeedKeys);
  result = removeConsumedGlyphs(result, tr.consumedGlyphKeys);
  result = removeConsumedTraps(result, tr.consumedTrapKeys);
  result = applyTrapPickups(result, tr.trapPickups);
  return { ...result, creatures: withAuras(result.creatures, seedSidesOf(result)) };
}

// ── DEV / "Test Combat" tab ──────────────────────────────────────────────────
// Build a creature instance faithfully from its Card, the same stat / property /
// range / résistance / summoning-sickness derivation as summonCreature's own
// instance construction below, but as a pure value with no board side-effects:
// no APPARITION, no ENTERS_PLAY reactions, no bush/butin/prism settling. Used by
// the dev board builder to drop pieces into an arbitrary state so the engine's
// resolution can be exercised on hand-crafted situations.
// Keep in SYNC with the instance literal inside summonCreature (just below).
export function devBuildCreature(card: Card, at: Coords, owner: Side, instanceId: number): CreatureInstance {
  const props = new Set<string>(card.properties ?? []);
  const apparitionGrants = new Set<string>();
  for (const t of card.triggers ?? []) {
    if (t.trigger !== "APPARITION") continue;
    for (const e of t.effects) {
      const g = e as { type: string; property?: string; self?: boolean; scope?: string };
      if (g.type === "SetProperty" && g.property && !g.self && !g.scope) apparitionGrants.add(g.property);
    }
  }
  const conditionalFirstStrike = card.effects.some(
    (e) => e.type === "ConditionalFirstStrike"
      || (e.type === "WoundedProperty" && (e as { property?: string }).property === "FirstStrike"),
  );
  const woundedResistance = card.effects.some((e) => e.type === "WoundedResistance");
  let resistance = 0;
  let range = 0;
  for (const eff of card.effects) {
    if (eff.type === "SetPropertyData") {
      const p = (eff as { PropertyType?: string }).PropertyType;
      if (p && !apparitionGrants.has(p) && !(p === "FirstStrike" && conditionalFirstStrike)) props.add(p);
    } else if (eff.type === "ShooterRangeData") {
      const rm = (eff as { RangeMax?: number | { const?: number } }).RangeMax;
      range = Math.max(range, typeof rm === "number" ? rm : (rm?.const ?? 0));
    } else if (eff.type === "BoostResistanceData" && !woundedResistance) {
      const b = (eff as { Boost?: number | { const?: number } }).Boost;
      resistance += typeof b === "number" ? b : (b?.const ?? 0);
    }
  }
  const hasCharge = props.has("NoSummoningSickness");
  const hasStatue = cannotAdvance(props);
  return {
    instanceId,
    cardId: card.id,
    owner,
    position: { ...at },
    currentLife: card.life ?? 1,
    currentAttack: card.attack ?? 0,
    // Summoning sickness does not set PM to zero: a new summon keeps its full movement; the `hasAttacked`
    // flag alone blocks its end-of-turn advance (naturalAdvance checks hasAttacked, not movementLeft).
    // This keeps "Échangez ses PM" (Chacha Sauvage) from passing a fake 0. Only a Mur/Statue stays at 0.
    movementLeft: hasStatue ? 0 : (card.movement ?? 0),
    baseLife: card.life ?? 1,
    baseAttack: card.attack ?? 0,
    baseMovement: hasStatue ? 0 : (card.movement ?? 0),
    printedAttack: card.attack ?? 0,
    printedLife: card.life ?? 1,
    printedMovement: card.movement ?? 0,
    armor: 0,
    resistance,
    vulnerability: 0,
    movementPoison: 0,
    auraAttack: 0,
    auraMovement: 0,
    auraResistance: 0,
    auraRange: 0,
    range,
    hasAttacked: !hasCharge,
    properties: props,
    silenced: false,
    triggers: card.triggers ?? [],
  };
}

// Manual overrides the dev board builder can force onto a placed creature. Every
// field is optional; absent = keep the card's faithful value. `sick` toggles the
// mal d'invocation (true = just-summoned/cannot advance; false = ready to act).
export interface DevPlaceOpts {
  sick?: boolean;
  life?: number;
  attack?: number;
  armor?: number;
  range?: number;
  resistance?: number;
  vulnerability?: number;
  properties?: string[];
}

// Drop a faithfully-built creature onto `state` at `at` for `owner`, apply the
// dev overrides, then re-fold allied CHEF auras via withAuras. No trigger fires,
// this is a state-construction helper, not a play. Returns a new state.
export function devPlaceCreature(state: GameState, card: Card, at: Coords, owner: Side, opts: DevPlaceOpts = {}): GameState {
  const id = state.nextInstanceId;
  const inst = devBuildCreature(card, at, owner, id);
  if (opts.sick === false) { inst.movementLeft = inst.baseMovement; inst.hasAttacked = false; }
  else if (opts.sick === true) { inst.movementLeft = inst.baseMovement; inst.hasAttacked = true; } // sickness = hasAttacked, keeps PM
  if (opts.attack != null) { inst.printedAttack = opts.attack; inst.baseAttack = opts.attack; inst.currentAttack = opts.attack; }
  if (opts.life != null) {
    inst.currentLife = opts.life;
    // Keep currentLife ≤ baseLife (the health bar's max): a value above the
    // printed life raises the ceiling; a lower value just wounds the creature.
    if (opts.life > inst.baseLife) { inst.baseLife = opts.life; inst.printedLife = Math.max(inst.printedLife, opts.life); }
  }
  if (opts.armor != null) inst.armor = opts.armor;
  if (opts.range != null) inst.range = opts.range;
  if (opts.resistance != null) inst.resistance = opts.resistance;
  if (opts.vulnerability != null) inst.vulnerability = opts.vulnerability;
  if (opts.properties) for (const p of opts.properties) inst.properties.add(p);
  const creatures = withAuras([...state.creatures, inst]);
  return { ...state, creatures, nextInstanceId: id + 1 };
}

function summonCreature(state: GameState, card: Card, at: Coords, owner: Side = state.activeSide, fireApparition = true, playedCostMod = 0, necromeAlreadyDeferred = false, playedFromHand = false): GameState {
  // Reactive ON_PLAY ("quand vous jouez une invocation", Piou aux Œufs d'Or #446's draw, …) is not
  // fired here anymore: it fires from fireApparitionPhase, after this creature's own APPARITION has
  // resolved, so the played card's effect lands before bystanders react to the play (Piou used to draw
  // before Malory's glyph tutor). `playedFromHand` is passed on to fireApparitionPhase to gate them
  // (tokens / effect summons do not "play"), and the entrant is excluded there so it never reacts to
  // its own entrance. The deferred-summon detection trial (playCard) still fires them and throws them
  // away; the real landing fires them once.
  // The instance's property set comes from two sources:
  //  1. card.properties[], the static SummonProperty[] field of the card data (empty for most
  //     creatures).
  //  2. SetPropertyData entries in card.effects[], the "built-in keywords" most creatures use
  //     (Eliacube's `Statue`, Defhi Croquets' `FirstStrike`, etc.). Applied at summon time because
  //     they describe what the creature is, not a one-shot spell effect.
  const props = new Set<string>(card.properties ?? []);
  // Properties a targeted APPARITION grant ("Donnez bouclier à une invocation")
  // hands to another creature, not innate self keywords. The extracted bindata
  // strands that grant's SetPropertyData in flat effects[]; without this guard
  // summonCreature would wrongly give the summoner the property itself.
  const apparitionGrants = new Set<string>();
  for (const t of card.triggers ?? []) {
    if (t.trigger !== "APPARITION") continue;
    for (const e of t.effects) {
      const g = e as { type: string; property?: string; self?: boolean; scope?: string };
      if (g.type === "SetProperty" && g.property && !g.self && !g.scope) apparitionGrants.add(g.property);
    }
  }
  // A creature whose FirstStrike is conditional must not get it as a built-in keyword: withAuras gives
  // it or takes it back based on the board (Tristepin: family ally in play) or on its own state
  // (Grouilleux #309 / Edass #43: BLESSÉ → initiative only while wounded). Same for a Résistance that
  // only applies while wounded (Maude #1765): withAuras owns it through auraResistance, so the card
  // data value is not set here.
  const conditionalFirstStrike = card.effects.some(
    (e) => e.type === "ConditionalFirstStrike"
      || (e.type === "WoundedProperty" && (e as { property?: string }).property === "FirstStrike"),
  );
  const woundedResistance = card.effects.some((e) => e.type === "WoundedResistance");
  let resistance = 0;
  let range = 0;
  for (const eff of card.effects) {
    if (eff.type === "SetPropertyData") {
      const p = (eff as { PropertyType?: string }).PropertyType;
      if (p && !apparitionGrants.has(p) && !(p === "FirstStrike" && conditionalFirstStrike)) props.add(p);
    } else if (eff.type === "ShooterRangeData") {
      // Innate Portée: the creature is a shooter with attack distance =
      // RangeMax (all bindata shooters use RangeMin 1). DynamicValue → int.
      const rm = (eff as { RangeMax?: number | { const?: number } }).RangeMax;
      range = Math.max(range, typeof rm === "number" ? rm : (rm?.const ?? 0));
    } else if (eff.type === "BoostResistanceData" && !woundedResistance) {
      // Built-in Résistance: "RÉSISTANCE: N" on the card, a flat per-hit damage reduction (not an AR pool
      // that absorbs). Like SetPropertyData above, it describes what the creature is, so it is set at
      // summon rather than treated as a one-shot effect. Several BoostResistanceData entries on the same
      // card simply add up. Boost is a plain int in all card data, but the {const} DynamicValue shape is
      // accepted too.
      const b = (eff as { Boost?: number | { const?: number } }).Boost;
      resistance += typeof b === "number" ? b : (b?.const ?? 0);
    }
  }

  // Summoning sickness: a just-summoned creature normally cannot move or
  // attack on its first turn. The `NoSummoningSickness` keyword (UI label
  // "Charge") removes this restriction, creature acts immediately.
  const hasCharge = props.has("NoSummoningSickness");
  // A Mur (Statue) / 0-PM unit is summoned with no movement. INAMOVIBLE (Rooted)
  // keeps its printed PM, it walks/attacks normally, it just cannot be displaced.
  const hasStatue = cannotAdvance(props);

  const instance: CreatureInstance = {
    instanceId: state.nextInstanceId,
    cardId: card.id,
    owner,
    position: { ...at },
    currentLife: card.life ?? 1,
    currentAttack: card.attack ?? 0,
    // Summoning sickness does not set PM to zero: a new summon keeps its full movement; the `hasAttacked`
    // flag alone blocks its end-of-turn advance (naturalAdvance checks hasAttacked, not movementLeft).
    // This keeps "Échangez ses PM" (Chacha Sauvage) from passing a fake 0. Only a Mur/Statue stays at 0.
    movementLeft: hasStatue ? 0 : (card.movement ?? 0),
    baseLife: card.life ?? 1,
    baseAttack: card.attack ?? 0,
    baseMovement: hasStatue ? 0 : (card.movement ?? 0),
    printedAttack: card.attack ?? 0,
    printedLife: card.life ?? 1,
    printedMovement: card.movement ?? 0,
    armor: 0,        // Armure pool only ever gained from BoostArmor spells.
    resistance,      // Flat damage reducer baked in from BoostResistanceData.
    vulnerability: 0, // Flat damage increase; only granted later by spells.
    movementPoison: 0, // Gangraîne #1439; only granted later by the spell.
    auraAttack: 0,   // Recomputed by recomputeAuras after the creature lands.
    auraMovement: 0,
    auraResistance: 0, // Wounded-keyword Résistance (Maude #1765); owned by withAuras.
    auraRange: 0,    // Conditional range boost (Evangelyne); set by withAuras.
    range,           // Shooter attack distance (0 = melee).
    hasAttacked: !hasCharge,
    properties: props,
    silenced: false, // set true by handleSilence; cleared by transform.
    triggers: card.triggers ?? [],
    // The handCostMod this copy was played with (Vampyro/Wagnar reduction, Polter Tofu
    // surcharge…), carried so it can be restored if the card returns to hand. 0 = absent.
    ...(playedCostMod ? { playedCostMod } : {}),
  };
  // A Buisson on the summon cell (owned by this side) is used up the moment the creature lands on it
  // ("le buisson disparaît").
  const bushesAfter = (state.bushes ?? []).filter(
    (b) => !(b.owner === owner && sameCoords(b.position, at)),
  );
  // A Butin on the summon cell is also picked up (any owner, pickup is open). The
  // butin is consumed and the SUMMONER's side gets a random reward (rolled below).
  const butinHere = (state.butins ?? []).some((b) => sameCoords(b.position, at));
  const butinsAfter = butinHere
    ? (state.butins ?? []).filter((b) => !sameCoords(b.position, at))
    : state.butins;
  // A Cadeau de Nowel on the summon cell is likewise consumed (pickup is open), mirrors the Butin
  // rule "posé dessus = marche dessus". The outcome roll onto the newcomer is applied after the
  // creature is on the board (below, once we hold the RNG), like the butin reward. Gifts are never
  // placed on spawn columns, so this only fires for a token/effect summon landing off-spawn.
  const giftHere = (state.gifts ?? []).some((g) => sameCoords(g.position, at));
  const giftsAfter = giftHere
    ? (state.gifts ?? []).filter((g) => !sameCoords(g.position, at))
    : state.gifts;
  // A Tas d'Os on the summon cell is consumed when the creature lands on it (same
  // rule as a walk-over, "posé dessus fonctionne comme les graines"): an allied
  // Chafer (same owner) gains +1 AT +1 AR (permanent); anyone else just destroys it.
  const tasHere = (state.tasDOs ?? []).find((t) => sameCoords(t.position, at));
  const tasDOsAfter = tasHere ? (state.tasDOs ?? []).filter((t) => t !== tasHere) : state.tasDOs;
  if (tasHere && tasHere.owner === owner && (card.families ?? []).includes("Chafer")) {
    instance.currentAttack += 1;
    instance.baseAttack += 1;
    instance.armor += 1;
  }
  const afterSummon: GameState = {
    ...state,
    creatures: [...state.creatures, instance],
    bushes: bushesAfter,
    butins: butinsAfter,
    gifts: giftsAfter,
    tasDOs: tasDOsAfter,
    nextInstanceId: state.nextInstanceId + 1,
    log: [
      ...state.log,
      {
        type: "NEW_SUMMON",
        instanceId: instance.instanceId,
        cardId: card.id,
        owner: instance.owner,
        at: { ...at },
      },
      // Surface each starting property as a PROPERTY_APPLIED event so
      // the log shows "Eliacube acquires Statue" right after the
      // NEW_SUMMON line, matches what the original game emits.
      ...Array.from(props).map(
        (p) =>
          ({ type: "PROPERTY_APPLIED", instanceId: instance.instanceId, property: p }) as const,
      ),
      // Innate Résistance surfaces as a RESISTANCE event so the figurine can
      // show its RÉSISTANCE badge from turn one. (Distinct from the
      // ARMOR_GAINED event that is emitted when Armure is granted.)
      ...(resistance > 0
        ? [
            {
              type: "RESISTANCE" as const,
              instanceId: instance.instanceId,
              resistanceMod: {
                valueBefore: 0,
                modification: resistance,
                valueAfter: resistance,
              },
            },
          ]
        : []),
    ],
  };
  // Activate a prism sitting under the summon (if any) before firing
  // APPARITION. Prism bonuses are immediate (no targeting), whereas
  // APPARITION can open an interactive pendingAction, keeping the
  // non-interactive bonus first avoids resolving a board effect while a
  // pick is pending. The summoned creature's properties modulate the
  // bonus (Double* / DontTrigger*), so we pass its prop set in.
  // Fold CHEF auras in now that the new creature is on the board (it may be a
  // chief, or a fresh target of an existing one).
  const withChiefs: GameState = { ...afterSummon, creatures: withAuras(afterSummon.creatures, seedSidesOf(afterSummon)) };
  // selfCarrierId = this creature's id: a creature does not apply its own prism aura to its own landing
  // pickup (the prism resolves before its effects/auras start working). Harebourg #578 lands on a prism
  // → 1× (not 2×); Larve blanche #743 lands on a prism → still triggers it.
  const afterPrism = activatePrism(withChiefs, at, instance.owner, props, instance.instanceId);

  // Seed / Piège / Glyphe under the summon: a creature that was just placed lands on the cell exactly
  // like a walk, so it must trigger them right away for both sides. An ally gains the bonus (graine +1
  // AR, glyphe Féca +AR), an enemy takes the damage / just destroys it (graine/piège), the same as
  // walking onto the cell ("posé dessus = marche dessus"). Butin / Tas d'Os / Buisson / prisme are
  // settled separately above with their own summon handling (butin reward timing, tas built into the
  // new instance, bush as spawn enabler, the prism's self-carrier guard), so this only covers the three
  // that the summon path used to ignore. An enemy seed/piège may kill the newcomer here.
  const afterGround = applySummonGroundPickups(afterPrism, instance.instanceId, at);

  // Butin pickup: a creature summoned onto a Butin grabs a random reward into the
  // summoner's hand. We roll from state.rng and persist the advanced state here,
  // before the APPARITION runTrigger below continues from it, so the whole summon
  // stays reproducible (no rng param needed on summonCreature, like runTrigger).
  let afterLoot = afterGround;
  if (butinHere) {
    const rng = new Rng(afterLoot.rng);
    afterLoot = { ...applyButinReward(afterLoot, instance.owner, rng), rng: rng.state };
  }
  // Cadeau de Nowel pickup on summon: roll the outcome onto the newcomer + fire its side's roll
  // reactions, reusing the shared batch helper (settles a lethal roll's death/contre-coup too).
  if (giftHere) {
    const rng = new Rng(afterLoot.rng);
    afterLoot = { ...applyGiftPickups(afterLoot, [{ instanceId: instance.instanceId, side: instance.owner, at: { ...at } }], rng), rng: rng.state };
  }

  // NÉCROME keyword: playing a Nécrome gives 1 base Orbe (#708) to its owner's hand ("lorsqu'on les
  // pose, nous donne un orbe en main"). Added before the APPARITION fires so the orbe is in hand
  // whatever the APPARITION does (some open a pending pick). Card-specific "Ajoute 1 Orbe si…" texts
  // (#655) give one more orbe on top of this base one.
  if (isNecrome(card.id)) {
    afterLoot = addCardToHand(afterLoot, instance.owner, ORBE_CARD_ID, 1, 0);
  }

  // RALLIEMENT: a freshly-summoned rally creature advances to join an allied rally
  // creature (more advanced, adjacent row) before its APPARITION fires.
  afterLoot = applyRally(afterLoot, instance.instanceId);

  // (The PHORZERKER fusion is offered EARLIER, in playCard, as a deferred pick that holds the
  // Énutrof off the board until the player picks a Phorreur to fuse, places it elsewhere, or
  // cancels, so it is not handled here in summonCreature.)

  // The NÉCROME reveal (keyword) is resolved before the APPARITION effect: offer an optional pick of
  // one of the owner's unrevealed Dofus to reveal for a second Orbe. The creature's APPARITION (push /
  // damage / …) must not resolve until this Dofus targeting is settled, revealed or declined (same
  // principle as deferred targeted APPARITIONs). fireApparitionPhase then runs for this creature once
  // the pick settles (see resolvePendingAction / cancelPendingAction). The APPARITION has not opened any
  // pick yet, so there is no conflict (one pendingAction at a time). The base Orbe (above) is already
  // in hand.
  // The NÉCROME reveal / combined pick is opened here only for an immediate (effect or token) summon. A
  // NÉCROME played from hand is deferred in playCard (held off the board) and lands through
  // placeDeferredSummon with `necromeAlreadyDeferred=true`. Its pick was already shown, so it must not
  // open again (the base Orbe above is still given exactly once at this landing).
  if (isNecrome(card.id) && !necromeAlreadyDeferred) {
    const hasUnrevealed = afterLoot.dofuses.some((d) => d.owner === instance.owner && d.currentLife > 0 && !d.revealed);
    // A NÉCROME card that also has the PHORZERKER ability (#634 Championne Périmée / #899 Champion
    // Croulant) offers a combined secondary pick: click an allied Phorreur to fuse, an unrevealed Dofus to
    // reveal it for a 2nd Orbe, or elsewhere for neither (the Énutrof plays normally).
    const hasPhorreur =
      card.phorzerker &&
      afterLoot.creatures.some(
        (c) => c.owner === instance.owner && c.currentLife > 0 && c.instanceId !== instance.instanceId &&
          (getCard(c.cardId)?.families ?? []).includes("Phorreur"),
      );
    if (card.phorzerker && (hasPhorreur || hasUnrevealed)) {
      return {
        ...afterLoot,
        pendingAction: {
          side: instance.owner,
          prompt: "PHORZERKER / NÉCROME : ciblez un Phorreur pour fusionner, un de vos Dofus pour un autre Orbe, ou ailleurs.",
          filter: "ally_phorreur_or_unrevealed_dofus",
          pendingEffects: [{ type: "RevealDofus" }],
          sourceInstanceId: instance.instanceId,
          optional: true,
          fireApparitionAfter: fireApparition,
          phorzerkerNecrome: true,
        },
      };
    }
    if (hasUnrevealed) {
      return {
        ...afterLoot,
        pendingAction: {
          side: instance.owner,
          prompt: "NÉCROME : révélez un de vos Dofus non révélés pour un autre Orbe (ou déclinez).",
          filter: "ally_unrevealed_dofus",
          pendingEffects: [{ type: "RevealDofus" }],
          sourceInstanceId: instance.instanceId,
          optional: true,
          fireApparitionAfter: fireApparition,
        },
      };
    }
  }

  // Arrival reactions (ON_PLAY / ENTERS_PLAY / Camille Kaz #785's strike) live inside
  // fireApparitionPhase, inline after the APPARITION, stamped on its pick when one opens
  // (arrivalReactionsAfter), or skipped here entirely for a hand-played NÉCROME landing
  // (necromeAlreadyDeferred, the reveal-pick settle fires them once, see
  // firePendingApparition / apparitionPlayedFromHand).
  return fireApparitionPhase(afterLoot, instance.instanceId, fireApparition, playedFromHand, necromeAlreadyDeferred);
}

// Camille Kaz #785's armed strike on a freshly-landed enemy entrant. Every living enemy of
// the newcomer carrying the StrikeNextEnemyHardSummon marker and not yet spent hits it, then
// takes its self-damage, and disarms (one-shot). Reuses the spell-damage path so armour /
// résistance / boucliers apply.
function fireCamilleStrikes(state: GameState, entrantInstanceId: number, entrantOwner: Side): GameState {
  const markerOf = (cid: number) => (getCard(cid)?.effects ?? []).find((e) => e.type === "StrikeNextEnemyHardSummon") as { damage?: number; self?: number } | undefined;
  const armed = state.creatures.filter((c) => c.currentLife > 0 && c.owner === other(entrantOwner) && !c.strikeSpent && markerOf(c.cardId));
  if (armed.length === 0) return state;
  const creatures = state.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
  const dofuses = state.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
  const log = [...state.log];
  for (const a of armed) {
    const cam = creatures.find((c) => c.instanceId === a.instanceId && c.currentLife > 0);
    if (!cam) continue;
    const m = markerOf(cam.cardId)!;
    cam.strikeSpent = true; // one-shot: disarm regardless of the outcome
    const entrant = creatures.find((c) => c.instanceId === entrantInstanceId && c.currentLife > 0);
    if (entrant) applyEffects(creatures, dofuses, log, [{ type: "DamageData", Damage: m.damage ?? 0 }], { casterSide: cam.owner, selfInstanceId: cam.instanceId, targetCell: { ...entrant.position } });
    // "puis s'inflige M": always, right after the strike.
    applyEffects(creatures, dofuses, log, [{ type: "DamageData", Damage: m.self ?? 0 }], { casterSide: cam.owner, selfInstanceId: cam.instanceId, targetCell: { ...cam.position } });
  }
  return resolveDeathsAndWin({ ...state, creatures, dofuses, log }, creatures, dofuses, log, new Set());
}

// Fire a creature's APPARITION phase: its APPARITION trigger (Radoris #489's SpendApAsBuff self buff
// and Corbac/Purpuce's SelfCharge included), then the ENTERS_PLAY reactions of every other creature.
// Fetches the instance again by id so it runs either inline at summon or later, once a NÉCROME Dofus
// reveal pick has settled (the push/effect waits for that). `fireApparition` is false for effect/spell
// summons (skip the trigger, still run the reactions), exactly as in summonCreature.
function fireApparitionPhase(state: GameState, instanceId: number, fireApparition: boolean, playedFromHand = false, skipArrivalReactions = false): GameState {
  const instance = state.creatures.find((c) => c.instanceId === instanceId);
  if (!instance) return state;
  const card = getCard(instance.cardId);
  if (!card) return state;
  const owner = instance.owner;
  let afterApparition = fireApparition || UNLABELED_APPARITION_IDS.has(card.id)
    ? runTrigger(state, "APPARITION", instance.instanceId)
    : state;
  // Radoris Montrouge #489: "APPARITION : dépense vos PA. Gagne +1 AT et +1 AR par PA utilisé." A
  // SpendApAsBuff marker on the APPARITION (runTrigger above skipped it, there is no creature-effect
  // handler) makes the creature spend its owner's remaining AP and gain +1 of each listed stat per AP,
  // on itself (the self version of Heure de Gloire #296).
  const spendBuff = (card.triggers ?? [])
    .flatMap((t) => (t.trigger === "APPARITION" ? t.effects : []))
    .find((e) => e.type === "SpendApAsBuff") as { stats?: ("attack" | "armor")[] } | undefined;
  if (spendBuff && !afterApparition.pendingAction && !afterApparition.winner) {
    const apSpent = afterApparition.players[owner].ap | 0;
    if (apSpent > 0) {
      const stats = spendBuff.stats ?? ["attack", "armor"];
      const log = [...afterApparition.log];
      const creatures = afterApparition.creatures.map((c) => {
        if (c.instanceId !== instance.instanceId) return c;
        const nc = { ...c };
        if (stats.includes("attack")) {
          log.push({ type: "ATTACK_GAINED", instanceId: c.instanceId, attackMod: { valueBefore: c.currentAttack, modification: apSpent, valueAfter: c.currentAttack + apSpent } });
          nc.currentAttack = c.currentAttack + apSpent;
          nc.baseAttack = c.baseAttack + apSpent;
        }
        if (stats.includes("armor")) {
          log.push({ type: "ARMOR_GAINED", instanceId: c.instanceId, armorMod: { valueBefore: c.armor, modification: apSpent, valueAfter: c.armor + apSpent } });
          nc.armor = c.armor + apSpent;
        }
        return nc;
      });
      afterApparition = {
        ...afterApparition,
        players: { ...afterApparition.players, [owner]: { ...afterApparition.players[owner], ap: 0 } },
        creatures,
        log,
      };
    }
  }

  // APPARITION self-charge (Corbac #56 …): the new creature advances now. `cells`
  // is either a fixed number or a board count ("d'autant de cases que vous avez de
  // <famille>") resolved against the post-summon board.
  const selfCharge = card.effects.find((e) => e.type === "SelfCharge") as { cells?: number | "toWall" | { count: import("../data/types").CountSpec; per?: number }; condition?: PlayerCondition; thenDie?: boolean } | undefined;
  if (
    selfCharge && !afterApparition.pendingAction && !afterApparition.winner &&
    (!selfCharge.condition || conditionMet(afterApparition, instance.owner, selfCharge.condition, instance.instanceId))
  ) {
    const cells = selfCharge.cells === "toWall"
      ? BOARD_COLS // Purpuce #34: charge the whole lane; advanceCreature caps it at the wall.
      : typeof selfCharge.cells === "number"
        ? selfCharge.cells
        : resolveCountValue(selfCharge.cells!, afterApparition.creatures, instance.owner, instance.instanceId);
    afterApparition = applyChargeOnSummon(afterApparition, instance.instanceId, Math.max(0, cells | 0));
    // Purpuce #34 "puis meurt": if it survived the charge (a clear lane reaching the
    // Dofus), it dies now. A charge into a creature usually already killed it (1 PV).
    if (selfCharge.thenDie && !afterApparition.winner) {
      const survivor = afterApparition.creatures.find((c) => c.instanceId === instance.instanceId && c.currentLife > 0);
      if (survivor) {
        const creatures = afterApparition.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
        const dofuses = afterApparition.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
        const log: GameEvent[] = [...afterApparition.log];
        const dyer = creatures.find((c) => c.instanceId === instance.instanceId);
        if (dyer) dyer.currentLife = 0;
        afterApparition = resolveDeathsAndWin(afterApparition, creatures, dofuses, log, new Set());
      }
    }
  }

  // Cogneur Nimbos #905: a self-property granted only when a board condition holds at summon
  // (Shield "si une invocation adverse se trouve devant lui" → enemyAheadOnRow). Like the
  // conditional SelfCharge above, evaluated on the post-apparition board; no-op when unmet.
  const condProp = card.effects.find((e) => e.type === "ConditionalSelfProperty") as { property?: string; condition?: PlayerCondition } | undefined;
  if (
    condProp?.property && condProp.condition && !afterApparition.winner &&
    conditionMet(afterApparition, instance.owner, condProp.condition, instance.instanceId)
  ) {
    const me = afterApparition.creatures.find((c) => c.instanceId === instance.instanceId && c.currentLife > 0);
    if (me && !me.properties.has(condProp.property)) {
      const creatures = afterApparition.creatures.map((c) => c.instanceId === instance.instanceId
        ? { ...c, properties: new Set(c.properties).add(condProp.property!) } : c);
      afterApparition = { ...afterApparition, creatures, log: [...afterApparition.log, { type: "PROPERTY_APPLIED", instanceId: instance.instanceId, property: condProp.property }] };
    }
  }

  // Reactive ON_PLAY ("quand vous jouez une invocation", Piou aux Œufs d'Or #446's draw) then
  // ENTERS_PLAY ("gagne +N quand une <X> entre en jeu", Welsh, Gzenah; Truche #37's row change): fired
  // here, after this creature's own APPARITION has resolved above, so the played card's effect lands
  // before bystanders react (Piou used to draw before Malory's APPARITION could tutor its Glyphe).
  // ON_PLAY is only armed by a card played from hand (playedFromHand: tokens / effect summons do not
  // "play"); the entrant is excluded so it never reacts to its own entrance.
  // If the APPARITION opened a targeting pick, the reactions are not fired in the middle of the pick:
  // they are stamped onto it (arrivalReactionsAfter) and fired only once it settles (the entrant's
  // effect must land first: Black Wabbit #495's targeted damage hits the Truche #37 before her row
  // change, which used to dodge it). The settle points (the resolvePendingAction wrapper and
  // landDeferredSummon on decline) make sure the reactions are never lost.
  // `skipArrivalReactions` (landing of a NÉCROME played from hand, necromeAlreadyDeferred): the reveal
  // pick settle runs this phase again for the held APPARITION, and the reactions fire there, once, so
  // the landing run must stay silent (otherwise Welsh #278 gained +2).
  // Camille Kaz #785's armed strike is part of the same bundle (after ENTERS_PLAY).
  if (!afterApparition.winner && !skipArrivalReactions) {
    if (afterApparition.pendingAction) {
      afterApparition = {
        ...afterApparition,
        pendingAction: {
          ...afterApparition.pendingAction,
          arrivalReactionsAfter: { entrantId: instance.instanceId, side: owner, ...(playedFromHand ? { playedCardId: card.id } : {}) },
        },
      };
    } else {
      if (playedFromHand) afterApparition = fireOnPlayReactions(afterApparition, owner, card, instance.instanceId);
      if (!afterApparition.winner) afterApparition = fireEntersPlayReactions(afterApparition, instance.instanceId);
      if (playedFromHand && !afterApparition.winner) afterApparition = fireCamilleStrikes(afterApparition, instance.instanceId, owner);
    }
  }

  return afterApparition;
}

// Fire the arrival reactions that were deferred while the entrant's own APPARITION pick was open
// (arrivalReactionsAfter, stamped by fireApparitionPhase): ON_PLAY bystanders (hand plays only), then
// ENTERS_PLAY bystanders, then Camille Kaz #785's armed strike, the same order as the settled path.
// If the pick's own resolution opened another pending, the reactions run on a copy with the pending
// cleared and the new pick is put back (they are self-contained).
function fireDeferredArrivalReactions(state: GameState, ra: NonNullable<PendingAction["arrivalReactionsAfter"]>): GameState {
  if (state.winner) return state;
  const ownPick = state.pendingAction;
  let s: GameState = ownPick ? { ...state, pendingAction: null } : state;
  const played = ra.playedCardId != null ? getCard(ra.playedCardId) : undefined;
  if (played && !s.winner) s = fireOnPlayReactions(s, ra.side, played, ra.entrantId);
  if (!s.winner) s = fireEntersPlayReactions(s, ra.entrantId);
  if (played && !s.winner) s = fireCamilleStrikes(s, ra.entrantId, ra.side);
  return ownPick ? { ...s, pendingAction: ownPick } : s;
}

// Fire the deferred APPARITION phase once a NÉCROME Dofus-reveal pick settles (resolved or
// declined). No-op unless `fireApparitionAfter` was set when the reveal opened.
function firePendingApparition(state: GameState, pending: PendingAction): GameState {
  if (pending.fireApparitionAfter === undefined || pending.sourceInstanceId == null) return state;
  // A hand-played NÉCROME's landing skipped the arrival reactions (apparitionPlayedFromHand):
  // this settle run fires them, once, with ON_PLAY/Camille armed. Effect-summoned NÉCROMEs
  // (flag absent) fire ENTERS_PLAY only, their landing was silent too (early reveal-pick return).
  return fireApparitionPhase(state, pending.sourceInstanceId, pending.fireApparitionAfter, pending.apparitionPlayedFromHand === true);
}

// FRATRIE deferred summon: place the creature that was held back until its
// targeting pick settled (the card was already paid / removed from hand), firing
// its APPARITION etc. exactly like a normal summon. No-op-safe if the card id is
// unknown. Clears the (already-resolved) FRATRIE pendingAction first.
function placeDeferredSummon(state: GameState, sa: { cardId: number; cell: Coords; owner: Side; cost?: number; playedCostMod?: number; deferredNecrome?: boolean }): GameState {
  const cd = getCard(sa.cardId);
  if (!cd) return { ...state, pendingAction: null };
  let s: GameState = { ...state, pendingAction: null };
  // The held card carries its still-UNPAID cost (refunded at the defer site): charge it now, at
  // landing, so no AP was spent while the targeting pick was open. The landed figurine carries
  // `playedCostMod`.
  if (sa.cost != null) {
    const p = s.players[sa.owner];
    s = { ...s, players: { ...s.players, [sa.owner]: { ...p, ap: Math.max(0, p.ap - sa.cost) } } };
  }
  // A deferred NÉCROME lands without firing its APPARITION here (the held APPARITION is fired once,
  // explicitly, by the resolve/decline path) and without re-opening the reveal pick (already shown).
  // The base Orbe is still granted exactly once inside summonCreature.
  return summonCreature(s, cd, sa.cell, sa.owner, !sa.deferredNecrome, sa.playedCostMod ?? 0, sa.deferredNecrome === true, true);
}

// Materialise up to `amount` copies of a token card on `side`'s free spawn
// cells, back column (next to the Dofus) first so "vos cases de départ" fills
// the way the original does. summonCreature owns the creature to state.active-
// Side, which is the caster while a spell resolves, so this only runs during
// the caster's turn. Stops early if the board runs out of room or the token
// id is not registered. Returns the state unchanged if neither holds.
function summonTokens(state: GameState, tokenId: number, amount: number, side: Side): GameState {
  const token = getCard(tokenId);
  if (!token) return state;
  let next = state;
  for (let i = 0; i < amount; i++) {
    // "Sur vos cases de départ" (Lapinos #291): only the base spawn column
    // (isSpawnCell, x=8 ally / x=1 enemy), never the columns unlocked by
    // capturing fake Dofus (extraSpawnRange). Top-to-bottom fill for a
    // deterministic order. (NB: this is the only card on the no-placement
    // SummonToken path, every other SummonToken sets a `placement`.)
    const cells: Coords[] = [];
    for (let y = 0; y < BOARD_ROWS; y++) {
      for (let x = 0; x < BOARD_COLS; x++) {
        if (!isSpawnCell(x, side)) continue;
        if (isCellFree(next, { x, y })) cells.push({ x, y });
      }
    }
    if (cells.length === 0) break;
    next = summonCreature(next, token, cells[0], side, false);
  }
  return next;
}

// Create up to `amount` token copies on free cells nearest to `nearCell` (a trigger's "Invoque N X à
// côté de lui"). Goes outward in rings from the source so the tokens appear beside it; falls back to
// the owner's spawn zone if the area around is full. Owned by `side` (the source's controller, which
// is correct even for a MORT firing on the opponent's turn).
// "Vos (autres) invocations chargent de N cases": every matching allied creature gains N movement
// (and loses summoning sickness), then advances right now through the shared advance/combat path.
// `excludeId` skips the source ("autres"); `family` narrows it. Passes `tr` so the caller can apply
// prism pickups / deck returns afterwards.
function chargeAllies(
  creatures: CreatureInstance[],
  dofuses: DofusInstance[],
  log: GameEvent[],
  casterSide: Side,
  cells: number | undefined,
  excludeId: number | undefined,
  family: string | undefined,
  tr: AdvanceTracking,
  wounded: boolean | undefined = undefined,
): void {
  // `cells` GIVEN → an extra N-cell burst that does not consume the turn's move
  // (Jice: charge 1 now, still advance PM at end of turn, PM restored below).
  // `cells` UNDEFINED → a full "charge": each ally advances its whole PM now and
  // keeps none (non-additive, like ChargeSelf's "APPARITION : Charge" / Tristepin,
  // vs the additive "charge de N cases" / Lilotte). Used by "Vos autres X chargent".
  const fullCharge = cells == null;
  const n = Math.max(0, cells ?? 0);
  if (!fullCharge && n <= 0) return;
  // Snapshot the chargers first, advanceCreature can remove creatures (wall
  // break-through), so we do not want to iterate a mutating array.
  const chargers = creatures.filter(
    (c) =>
      c.currentLife > 0 &&
      c.owner === casterSide &&
      c.instanceId !== excludeId &&
      !cannotAdvance(c.properties) && !c.properties.has("Rooted") && // INAMOVIBLE (Rooted) does not charge with the group; Statue/0-PM are excluded too
      (!family || (famsOf(c)).includes(family)) &&
      (!wounded || c.currentLife < c.baseLife), // "vos invocations blessées chargent"
  );
  // Charge front first (closest to the opposing wall), the same order as the end-of-turn sweep
  // (moveOrderIds) and retreatAllies. A front charger frees its cell before the one behind it advances,
  // so a stacked column does not block itself; otherwise a creature behind an ally that has not charged
  // yet stays where it is while still getting the group's buff (La Gerbouille #547). Ally = x going up
  // then L1→L5 (y going up); enemy mirrored.
  chargers.sort((a, b) =>
    casterSide === "ally"
      ? (a.position.x - b.position.x) || (a.position.y - b.position.y)
      : (b.position.x - a.position.x) || (b.position.y - a.position.y),
  );
  for (const c of chargers) {
    if (c.currentLife <= 0) continue; // could have died to an earlier charger's combat
    // The charge is an extra, immediate N-cell burst, it must not eat the
    // creature's normal movement for this turn. So: save the PM budget, advance
    // exactly N now (Jice charges 1 → a 3-PM ally moves 1 here, not 3), then
    // restore the PM so the creature still advances its PM during the
    // end-of-turn resolution (total this turn = N + PM).
    const pmBudget = c.movementLeft;
    // A creature already spent before the charge (summoning sickness, or it already struck through an
    // earlier mid-turn effect) must not gain a new end-of-turn action from a forced charge. It still
    // moves (a forced charge works despite summoning sickness) but stays spent, so e.g. a charged
    // shooter with summoning sickness does not fire at range at end of turn (Evangelyne #498 charged by
    // Jice Aouaire #283 used to shoot).
    const wasSpent = c.hasAttacked;
    c.movementLeft = fullCharge ? c.baseMovement : n;
    c.hasAttacked = false;
    // Display marker: each charge plays its ability (charge FX and sound), never the "+PM" FX. Emitted
    // before the advance.
    log.push({ type: "MOVEMENT_POINT_BOOST", instanceId: c.instanceId, movementMod: { valueBefore: pmBudget, modification: c.movementLeft - pmBudget, valueAfter: c.movementLeft }, charge: true });
    advanceCreature(c, creatures, dofuses, log, c.owner, forwardDx(c.owner), tr, { chargeMelee: true });
    // Restore PM only for the extra N-cell burst; a full charge is the move. Clear hasAttacked (so a
    // charge that struck does not cancel the creature's natural end-of-turn encounter), same rule as
    // the targeted Charge above. A full charge keeps hasAttacked, it was the turn's action.
    if (c.currentLife > 0 && !fullCharge) {
      c.movementLeft = pmBudget;
      c.hasAttacked = false;
    }
    // …but a creature spent before the charge stays spent regardless (no bonus end-of-turn shot/advance).
    if (c.currentLife > 0 && wasSpent) c.hasAttacked = true;
  }
}

// "Vos invocations reculent de N cases" (Tout ou Rien, Face). Each ally is
// pushed back using the same primitive as Championne Embrocheuse's "Repousse"
// (slideCreatureBack): slide toward the owner's wall, stopping at a creature /
// Dofus / board edge, emitting a SLIDE. We process the ones closest to the wall
// first so a stacked column clears from the back, never blocking itself.
function retreatAllies(creatures: CreatureInstance[], dofuses: DofusInstance[], casterSide: Side, cells: number, log: GameEvent[], onStep?: (mover: CreatureInstance, nx: number, ny: number) => void): void {
  const n = Math.max(0, cells | 0);
  if (n <= 0) return;
  const backDx = -forwardDx(casterSide); // away from the enemy (toward own wall)
  const movers = creatures.filter((c) => c.currentLife > 0 && c.owner === casterSide);
  movers.sort((a, b) => (backDx > 0 ? b.position.x - a.position.x : a.position.x - b.position.x));
  for (const c of movers) slideCreatureBack(c, creatures, dofuses, n, log, undefined, onStep);
}

function summonTokensNear(state: GameState, tokenId: number, amount: number, side: Side, nearCell: Coords, rng?: Rng): GameState {
  const token = getCard(tokenId);
  if (!token) return state;
  let next = state;
  for (let i = 0; i < amount; i++) {
    // All free, in-bounds, non-Dofus cells.
    const cells: Coords[] = [];
    for (let y = 0; y < BOARD_ROWS; y++) {
      for (let x = 0; x < BOARD_COLS; x++) {
        if (dofusSideAt(x, y)) continue;
        if (!isCellFree(next, { x, y })) continue;
        cells.push({ x, y });
      }
    }
    if (cells.length === 0) break;
    // "Autour de lui": among the closest tier (min Chebyshev distance to the
    // source) pick a random free cell, so the token does not always land on the
    // same spot (Empereur Gelax's Jelly). Reading order only when no rng is given.
    const dist = (c: Coords) => Math.max(Math.abs(c.x - nearCell.x), Math.abs(c.y - nearCell.y));
    const minD = Math.min(...cells.map(dist));
    const tier = cells.filter((c) => dist(c) === minD).sort((a, b) => a.y - b.y || a.x - b.x);
    const pick = rng ? tier[rng.int(tier.length)] : tier[0];
    next = summonCreature(next, token, pick, side, false);
  }
  return next;
}

// Pick up the prism sitting at `at` (if any) for `side`, the side of the
// creature that landed on the cell, whether by summon or by walking over it
// during the advance phase. Important: prisms have no allegiance for pickup,
// a creature collects any prism it lands on (its own or the opponent's), and
// the bonus always goes to `side` (the picker's owner), never the prism's
// original owner. Consumes the prism and arms a respawn if the board is now
// empty of prisms. `props` is the picking creature's property set, it can
// double the bonus (DoublePrismBonuses / DoubleAPPrismBonuses) or suppress it
// entirely (DontTriggerPrismsEffects).
function activatePrism(
  state: GameState,
  at: Coords,
  side: Side,
  props: Set<string>,
  // The freshly-placed creature's instanceId when this pickup is its own
  // summon-landing. When set, the picker's own prism aura is ignored (see
  // below); every other pickup path leaves it undefined.
  selfCarrierId?: number,
  // The picker's instanceId for LOGGING only, walk-over / teleport / slide
  // pickups thread it here (selfCarrierId stays undefined so the aura logic is
  // unaffected). Remote pickups (RamasserPrisme cast) leave it undefined → the
  // log falls back to a creatureless line.
  byInstanceId?: number,
): GameState {
  // Match by cell only, not by prism.owner. Whoever lands on the cell picks
  // it up, even if it is the opponent's prism; the bonus is granted to `side`.
  const prism = state.prisms.find((p) => sameCoords(p.position, at));
  if (!prism) return state;

  // A creature's own prism aura is not active for its own landing pickup: when a creature is placed on
  // a prism, the prism resolves before that creature's new effects start working, APPARITION and
  // static auras alike. So at a summon landing (selfCarrierId set) the picker's own `props` are ignored
  // for prism modifiers and it is excluded from the team aura scan; only other living allied carriers,
  // already in play, count. For every other pickup path (walk-over during advance, RamasserPrisme
  // APPARITION, …) selfCarrierId is undefined and the picker's own props apply as before.
  const selfHas = (p: string) => selfCarrierId === undefined && props.has(p);
  const otherCarrierHas = (p: string) =>
    state.creatures.some(
      (c) => c.currentLife > 0 && c.owner === side && c.instanceId !== selfCarrierId && c.properties.has(p),
    );

  // DontTriggerPrismsEffects (Larve blanche #743 "tant qu'elle est en jeu, les
  // prismes ne déclenchent pas leurs effets"): the prism does not activate at all,
  // no bonus, it stays on the board. A carrier already in play suppresses every
  // allied pickup; a freshly-summoned Larve does not suppress its own landing
  // (the prism resolves before her aura), so she collects it.
  if (selfHas("DontTriggerPrismsEffects") || otherCarrierHas("DontTriggerPrismsEffects")) return state;

  // DoublePrismBonuses is a TEAM aura (Comte Harebourg #578 "les invocations ALLIÉES
  // ramassent deux fois les prismes"): any other living carrier on the picker's side
  // doubles every pickup of that side. A carrier does not double its own landing
  // pickup (same rule, prism before aura), so Harebourg summoned onto a prism
  // collects it once unless a second carrier is already in play.
  const doubleAll = selfHas("DoublePrismBonuses") || otherCarrierHas("DoublePrismBonuses");
  const doubleAp = doubleAll || selfHas("DoubleAPPrismBonuses") || otherCarrierHas("DoubleAPPrismBonuses");

  // Remove the consumed prism first; we layer the bonus on top.
  let next: GameState = {
    ...state,
    prisms: state.prisms.filter((p) => p !== prism),
    log: [...state.log, { type: "A_O_E_ACTIVATED", at: { ...at }, kind: prism.kind, byInstanceId: byInstanceId ?? selfCarrierId }],
  };

  const player = next.players[side];
  if (prism.kind === "ap") {
    const gain = doubleAp ? 2 : 1;
    next = {
      ...next,
      players: {
        ...next.players,
        [side]: { ...player, apReserve: player.apReserve + gain },
      },
      log: [
        ...next.log,
        {
          type: "A_P_RESERVE_MODIFIED",
          side,
          mod: {
            valueBefore: player.apReserve,
            modification: gain,
            valueAfter: player.apReserve + gain,
          },
        },
      ],
    };
  } else if (prism.kind === "draw") {
    const times = doubleAll ? 2 : 1;
    for (let i = 0; i < times; i++) next = drawCard(next, side);
  } else if (prism.kind === "fleau") {
    const times = doubleAll ? 2 : 1;
    // The Fléau card is created (it comes out of no pile): it is logged so the replay can animate it,
    // with the original game's own move for it (0.30 s). With no event, it appeared in the hand all at
    // once.
    for (let i = 0; i < times; i++) {
      next = logCardCreatedInHand(next, side, FLEAU_CARD_ID);
      next = addCardToHand(next, side, FLEAU_CARD_ID, 1);
    }
  }

  // (The reset when the board is empty is handled at startTurn by a state check, prisms.length === 0,
  // so no per-removal flag is needed here; see startTurn.)
  // A prism was just picked up → fire ON_PRISM reactions (Lilotte #579 charges). The creature that
  // landed on this prism does not react to it (the prism resolved before its own effects).
  const picker = next.creatures.find((c) => c.currentLife > 0 && sameCoords(c.position, at));
  next = fireOnPrismReactions(next, picker?.instanceId);
  // Maluss #292: STEALING (collecting) an enemy prism (owner ≠ the picker's side) strikes the enemy Dofus.
  if (prism.owner !== side) next = applyEnemyPrismLossReactions(next, side, 1);
  return next;
}

// Orbe fusion (Nécronomigore chain), a state rule checked after any Orbe / Orbe Doré is given to a
// hand. Merges, in order:
//   • 3× Orbe (#708)       → 1× Orbe Doré (#594)    ("Si vous avez 3 Orbes en main, ils fusionnent…")
//   • 2× Orbe Doré (#594)  → 1× Nécronomigore (#700) ("Si vous avez 2 Orbes Dorés en main, ils fusionnent…")
// The 594→700 step runs after the 708→594 one so a golden one made by the first merge can complete a
// golden pair. Each merge loops while a full group remains, and the whole thing runs after each
// single addCardToHand. So a NÉCROME giving two Orbes one after the other (base on landing, then the
// Dofus-reveal Orbe) merges the first triple before the second Orbe lands, which frees hand slots so
// an almost full hand no longer burns the second one. Direct hand manipulation (not addCardToHand):
// the card count only ever goes down, so a new card never overflows and there is no re-entry.
function fuseOrbesInHand(state: GameState, side: Side): GameState {
  const p = state.players[side];
  let hand = p.hand;
  let mods = p.handCostMods;
  // handCostTempMods is indexed 1:1 on the hand: the fusion removes cards and makes a new one, so it has
  // to follow the same rebuild. The new card did not exist when the stamp was applied → 0.
  let temps = p.handCostTempMods;
  let changed = false;
  const collapse = (from: number, need: number, into: number): void => {
    while (hand.filter((id) => id === from).length >= need) {
      const nh: number[] = [];
      const nm: number[] = [];
      const nt: number[] | undefined = temps ? [] : undefined;
      let removed = 0;
      for (let i = 0; i < hand.length; i++) {
        if (hand[i] === from && removed < need) { removed++; continue; } // drop `need` copies of `from`
        nh.push(hand[i]); nm.push(mods[i]);
        if (nt) nt.push(temps?.[i] ?? 0);
      }
      nh.push(into); nm.push(0); // mint one `into` (pays its printed cost)
      if (nt) nt.push(0);        // the new card was not there when the stamp was applied
      hand = nh; mods = nm; temps = nt;
      changed = true;
    }
  };
  collapse(ORBE_CARD_ID, 3, ORBE_DORE_CARD_ID);         // 3 Orbe → 1 Orbe Doré
  collapse(ORBE_DORE_CARD_ID, 2, NECRONOMIGORE_CARD_ID); // 2 Orbe Doré → 1 Nécronomigore
  if (!changed) return state;
  return { ...state, players: { ...state.players, [side]: { ...p, hand, handCostMods: mods, handCostTempMods: temps } } };
}

// Add `count` copies of a specific card id directly to `side`'s hand
// (used by the Fléau prism, which grants a Fléau card not drawn from the
// deck). Honors the MAX_HAND cap, overflow copies are burned to discard,
// same as an over-cap draw.
function addCardToHand(
  state: GameState,
  side: Side,
  cardId: number,
  count: number,
  costMod = 0,
): GameState {
  const player = state.players[side];
  const hand = [...player.hand];
  const handCostMods = [...player.handCostMods];
  const discard = [...player.discard];
  const tokenDiscard = [...(player.tokenDiscard ?? [])];
  // A token burned by a full hand goes to the inaccessible tokenDiscard, never the
  // recoverable pile (e.g. a bounced-to-hand token figurine overflowing).
  const cardIsToken = isToken(cardId);
  let overflows = 0;
  for (let i = 0; i < count; i++) {
    if (hand.length >= MAX_HAND) { (cardIsToken ? tokenDiscard : discard).push(cardId); overflows++; }
    else {
      hand.push(cardId);
      handCostMods.push(costMod); // e.g. Jahash's tutored spell: "-N PA"
    }
  }
  let next: GameState = {
    ...state,
    players: { ...state.players, [side]: { ...player, hand, handCostMods, discard, tokenDiscard } },
    // Nain Patraque #965: each card burned by a full hand buffs every holder.
    creatures: overflows > 0 ? buffOnOverflowDiscard(state.creatures, overflows) : state.creatures,
  };
  // Boufballe #1137: a card carrying CreateCardCounterData with an expiry buff arms a
  // turn counter the instant it lands in a hand (Kriss drops it in the enemy's hand;
  // playing it bounces it back here). The holder must replay it before the counter hits
  // 0, else on their endTurn the buff fires on the HOLDER's enemy creatures (see the
  // activeTraps detonation in endTurn) and the card leaves their hand.
  const counterEff = (getCard(cardId)?.effects ?? []).find((e) => e.type === "CreateCardCounterData") as
    | { InitialValue?: number; expireBuffEnemy?: { attack: number; armor: number } }
    | undefined;
  const landed = count - overflows;
  if (counterEff?.expireBuffEnemy && landed > 0) {
    const np = next.players[side];
    const armed = Array.from({ length: landed }, () => ({
      cardId,
      counter: Math.max(1, (counterEff.InitialValue ?? 1) | 0),
      penalty: 0,
      buffEnemy: counterEff.expireBuffEnemy!,
    }));
    next = { ...next, players: { ...next.players, [side]: { ...np, activeTraps: [...(np.activeTraps ?? []), ...armed] } } };
  }
  // Crasslek #355: each burned card makes every holder hit the enemy summons.
  const result = overflows > 0 ? damageEnemiesOnOverflowDiscard(next, overflows) : next;
  // Orbe fusion: granting an Orbe (may complete a triple → Orbe Doré) or an Orbe Doré (may
  // complete a pair → Nécronomigore) triggers a fusion in the receiving hand. Checked here so
  // every grant path (NÉCROME base grant, Dofus-reveal, #655's conditional AddCardToHand, any
  // future source) fuses, and multi-grant NÉCROMEs fuse stepwise.
  return cardId === ORBE_CARD_ID || cardId === ORBE_DORE_CARD_ID ? fuseOrbesInHand(result, side) : result;
}

// "Gagne +AT/+AR quand une carte est défaussée car la main d'un des joueurs est pleine"
// (Nain Patraque #965): per overflow-burn, each living holder of BuffSelfOnOverflowDiscard
// gains +attack AT / +armor AR (permanent). Fires regardless of whose hand overflowed.
function buffOnOverflowDiscard(creatures: CreatureInstance[], n: number): CreatureInstance[] {
  if (n <= 0) return creatures;
  let any = false;
  const out = creatures.map((c) => {
    if (c.currentLife <= 0) return c;
    const m = (getCard(c.cardId)?.effects ?? []).find((e) => e.type === "BuffSelfOnOverflowDiscard") as { attack?: number; armor?: number } | undefined;
    if (!m) return c;
    const da = n * (m.attack ?? 0), dr = n * (m.armor ?? 0);
    if (!da && !dr) return c;
    any = true;
    return { ...c, currentAttack: c.currentAttack + da, baseAttack: c.baseAttack + da, armor: c.armor + dr };
  });
  return any ? out : creatures;
}

// "Inflige N dégât(s) aux invocations adverses quand une carte est défaussée car la main d'un des
// joueurs est pleine" (Crasslek #355): per overflow burn, each living holder of
// DamageEnemiesOnOverflowDiscard hits every living enemy summon for its amount (Shield/Armure/
// Résistance apply through applyDamageToCreature), then the deaths settle right away
// (resolveDeathsAndWin: MORT triggers, discard, win). Fires whatever hand overflowed. Holders are
// read first so two opposing holders both fire even if the first one's damage kills the second.
function damageEnemiesOnOverflowDiscard(state: GameState, n: number): GameState {
  if (n <= 0) return state;
  const holders = state.creatures
    .filter((c) => c.currentLife > 0)
    .map((c) => ({
      instanceId: c.instanceId,
      owner: c.owner,
      m: (getCard(c.cardId)?.effects ?? []).find((e) => e.type === "DamageEnemiesOnOverflowDiscard") as { amount?: number } | undefined,
    }))
    .filter((h) => (h.m?.amount ?? 0) > 0);
  if (holders.length === 0) return state;
  const creatures = state.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
  const dofuses = state.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
  const log: GameEvent[] = [...state.log];
  for (const h of holders) {
    const dmg = n * (h.m!.amount ?? 0);
    for (const c of creatures) {
      if (c.currentLife <= 0 || c.owner === h.owner) continue;
      const armorBefore = c.armor;
      const dealt = applyDamageToCreature(c, dmg, log, false);
      const armorHit = armorBefore > c.armor;
      if (dealt > 0 || armorHit) log.push({ type: "DAMAGE", sourceInstanceId: h.instanceId, targetInstanceId: c.instanceId, damage: dealt, armorHit });
    }
  }
  return resolveDeathsAndWin(state, creatures, dofuses, log, new Set());
}

// Fire every trigger of type `triggerType` registered on the creature
// `instanceId`. Effects are applied in array order to mutable snapshots,
// then resolveDeathsAndWin packs them back into an immutable state,
// same pattern as castSpell. Returns the new state.
//
// A creature can have multiple triggers of the same type (e.g. two
// APPARITION blocks parsed from a description with two keyword sections)
// we fire them all in order.
export function runTrigger(
  state: GameState,
  triggerType: TriggerType,
  instanceId: number,
  // Board used only to evaluate this trigger's conditions / count amounts (not to apply effects, those
  // always change the live `state`). Defaults to `state`. The FIN_DE_TOUR phase passes a pre-phase
  // snapshot so end-of-turn effects do not interact with each other: each checks the board as it was
  // when the player ended their turn, blind to the wounds / changes other FIN_DE_TOUR effects cause in
  // the same phase (Laghertha #1432 does not fire on a Disciple de l'Agonie #1163 self-wound from the
  // same phase).
  evalState?: GameState,
  // Rule 4 / combo 2: where deferred counters go for an end-of-turn ON_DAMAGE charge. When present, a
  // CHARGE this trigger performs that meets an INITIATIVE strike absorbed by a GARDE DU CORPS defers
  // the defender's counter into this array (endTurn empties it) instead of resolving it inline, so the
  // loop of Jet le Pied Volant #158 under a guard keeps running. Passed only by fireDamageReactions from
  // endTurn; undefined everywhere else (charge counters resolve inline).
  deferredInitiativeCounters?: { attackerId: number; targetId: number }[],
): GameState {
  const owner = state.creatures.find((c) => c.instanceId === instanceId);
  if (!owner) return state;
  const matching = owner.triggers.filter((t) => t.trigger === triggerType);
  if (matching.length === 0) return state;

  // Does this trigger roll (a die or coin)? An allied roll for the trigger's owner (Shava's MORT coin
  // flip, Rémus's FIN DU TOUR, a 1d6 APPARITION…): fire the roll reactions for owner.owner at the end
  // (triggered rolls count too). Captured before the CoinFlip is expanded below.
  const triggerRolls = matching.some((t) => effectsHaveRoll(t.effects));

  // Seeded RNG for any random effect this trigger fires (Otomaï's MORT "transforme … en invocations
  // aléatoires"). Seeded from state.rng and its advanced state written back below, so the rolls can be
  // reproduced in sims / replays. Untouched when no random effect runs (state unchanged).
  //
  // `let` and not `const`, for the same reason as in castSpell: resolveDeathsAndWin draws for the MORT
  // reactions in the middle of the trigger, and its progress has to be taken back rather than
  // overwritten.
  let rng = new Rng(state.rng);

  // Split each trigger's effects into:
  //   - self effects (applied here & now on the source instance)
  //   - target effects (need a player click, deferred to pendingAction)
  // We process triggers in order, applying self effects to a single
  // mutable snapshot. The first target-effect we hit interrupts the
  // chain: anything after waits for the player to pick a target and
  // pendingAction is set so the UI can prompt. After resolution
  // (`resolvePendingAction`) the chain resumes, for the MVP we do not
  // handle "second target-effect after a first one" yet; in practice
  // very few cards chain multiple external-target effects.

  const creatures = state.creatures.map((c) => ({
    ...c,
    position: { ...c.position },
    properties: new Set(c.properties),
  }));
  const dofuses = state.dofuses.map((d) => ({
    ...d,
    position: { ...d.position },
  }));
  const log: GameEvent[] = [...state.log];

  // Collate target-effects from all matching triggers. Self-effects are
  // applied inline. We assume order does not matter much between self
  // and target effects for current cards (all current APPARITION self
  // patterns are pre-target).
  const pendingTargetEffects: import("../data/types").Effect[] = [];
  const playerEffects: import("../data/types").Effect[] = [];
  const chargeEffects: import("../data/types").Effect[] = [];
  // Cancane #775: creatures killed by a `bounceKilledToHand` DamageInFront, captured here and
  // moved to the CASTER's hand after death resolution ("remonte dans votre main").
  const bounceKilledSink: { cardId: number; owner: Side }[] = [];
  // Tracking accumulator for any board movement this trigger performs, scoped/self charges
  // (below) or a forced slide (push/attract via the immediate effects). Built before the loop
  // so the slide hook can record token walk-overs / prism pickups as the effects run; the
  // settle pass below packs them.
  const tracking: AdvanceTracking = {
    brokeThroughIds: new Set<number>(),
    prismCellKeys: new Set(state.prisms.map((p) => `${p.position.x},${p.position.y}`)),
    collectedPrismKeys: new Set<string>(),
    prismPickups: [],
    seedCells: buildSeedCells(state), consumedSeedKeys: new Set<string>(),
    glyphCells: buildGlyphCells(state), consumedGlyphKeys: new Set<string>(),
    tasDOsCells: buildTasDOsCells(state), consumedTasDOsKeys: new Set<string>(),
    bushCells: buildBushCells(state), consumedBushKeys: new Set<string>(),
    butinCells: buildButinCells(state), consumedButinKeys: new Set<string>(), butinPickups: [],
    giftCells: buildGiftCells(state), consumedGiftKeys: new Set<string>(), giftRng: new Rng((state.rng ^ GIFT_ROLL_SALT) | 0), giftRolls: { ally: 0, enemy: 0 },
    trapCells: buildTrapCells(state), consumedTrapKeys: new Set<string>(), trapPickups: [],
    deferredInitiativeCounters, // combo 2: a charge this trigger runs keeps deferring a guard-soaked counter
  };
  for (const t of matching) {
    // Expand any CoinFlip ("A OU B") to its resolved branch first, so the picked
    // branch's effects route through the normal paths below. Pile = first branch.
    const expanded: import("../data/types").Effect[] = [];
    for (const e0 of t.effects) {
      if (e0.type === "CoinFlip") {
        const cf = e0 as { pile: import("../data/types").Effect[]; face: import("../data/types").Effect[] };
        expanded.push(...(flipCoin(state, owner.owner, rng) ? cf.pile : cf.face));
      } else {
        expanded.push(e0);
      }
    }
    // Resolve any "+N par X en jeu" count amounts against the live board (the
    // source is `instanceId`, so excludeSelf works for self-buffs).
    // Conditions + count-amounts read `evalBoard` (the FIN_DE_TOUR pre-phase snapshot when
    // supplied, else the live `state`) so end-of-turn effects do not see each other's changes;
    // EFFECTS still apply to the live `creatures`/`state` below. Default path keeps the live
    // `creatures` copy for counting (zero behaviour change when no snapshot is passed).
    const evalBoard = evalState ?? state;
    const countCreatures = evalState ? evalState.creatures : creatures;
    const triggerEffects = dropUnmetConditions(resolveCounts(expanded, countCreatures, evalBoard.seeds ?? [], evalBoard.glyphs ?? [], owner.owner, instanceId, evalBoard.players[owner.owner].apReserve, evalBoard.players[owner.owner].hand.length, (evalBoard.butins ?? []).length), evalBoard, owner.owner, instanceId);
    for (const eff of triggerEffects) {
      // `targetAttacker` effects (Belgodass #756 silence / Polter #399 transform /
      // Anathar #316 take-control the creature that just hit us) are not applied here:
      // runTrigger has no notion of "the attacker", so fireContreCoup resolves them
      // against the DAMAGE event's sourceInstanceId after this normal pass.
      if ((eff as { targetAttacker?: boolean }).targetAttacker) continue;
      const massBounce =
        (eff.type === "ReturnToHand" || eff.type === "ReturnToDeck") &&
        ((eff as { scope?: string }).scope || (eff as { self?: boolean }).self);
      // TransformSeed is player-state but needs an interactive pick (which seed),
      // so on a trigger it must route to the pending path, not the immediate
      // player-effect path (which has no target). The spell path applies it
      // directly with its cast target instead.
      const immediatePlayerState =
        PLAYER_STATE_TYPES.has(eff.type) &&
        eff.type !== "TransformSeed" && eff.type !== "TransformSeedToBush" && eff.type !== "PlaceGlyph" && eff.type !== "PlaceTasDOs" && eff.type !== "DestroyPrism" && eff.type !== "DestroyBoardObject" && eff.type !== "SwapDofus" && eff.type !== "MoveRowDofus" && eff.type !== "TransformPrismToButin" && eff.type !== "TransformPrismToBombe" && eff.type !== "SacrificePrismBuff" &&
        !(eff.type === "RamasserPrisme" && (eff as { choose?: boolean }).choose) && // Lou 2★ #521: choose-which-prism routes to the pick path
        !(eff.type === "RespawnPrisms" && (eff as { choose?: boolean }).choose) && // Lou 1★ #572: choose-where-to-respawn routes to the pick path
        // A single Dofus reveal (Kerubim "dévoilez un dofus [adverse]") is a player
        // pick on a trigger → route to the targeted path, not the immediate one.
        !(eff.type === "RevealDofuses" && (eff as { scope?: string }).scope === "one") &&
        // Amalia's "choose"-placement poupée (and Gwand Pa Wabbit's "campChoose"
        // cawotte) needs a player pick, so it must fall through to the targeted-pick
        // path, not auto-apply here.
        !(eff.type === "SummonToken" && ["choose", "campChoose"].includes((eff as { placement?: string }).placement ?? ""));
      if (immediatePlayerState || massBounce) {
        // Player-state (DrawCards / AddCardToHand / …), applied to the whole
        // GameState after deaths resolve, not to the creature snapshot. A scoped
        // bounce (Veuve Noire "les autres invocations de votre camp") is a mass
        // hand/deck op, so it routes here too; an UNSCOPED bounce (Adamaï) falls
        // through to the targeted-pick path below.
        playerEffects.push(eff);
      } else if (eff.type === "ChargeAllies" || eff.type === "ChargeSelf") {
        // Scoped charge ("Vos autres invocations chargent") or self-charge
        // ("APPARITION : Charge" = Tristepin), both advance live creatures, so
        // they run on the snapshot before death resolution.
        chargeEffects.push(eff);
      } else if (effectRequiresTarget(eff)) {
        pendingTargetEffects.push(eff);
      } else {
        applyEffects(creatures, dofuses, log, [eff], {
          casterSide: owner.owner,
          selfInstanceId: instanceId,
          // Area effects (AoeDamage "autour de lui / de sa ligne") center on
          // the source creature's own cell.
          targetCell: { ...owner.position },
          rng, // random self-effects (Otomaï) roll from the seeded generator
          diceFloor: state.players[owner.owner].diceFloor,
          bounceKilledSink, // Cancane #775: collect creatures killed in front to steal to hand
          onSlideStep: makeSlideStep(creatures, log, tracking), // forced slides interact per cell
        });
      }
    }
  }

  // Snapshot who is already dead before the charges run, so we can attribute COUP
  // DE GRÂCE only to combat kills the charge itself makes (a non-combat self-effect
  // kill earlier in this trigger must not count as a coup de grâce).
  const deadBeforeCharge = new Set(creatures.filter((c) => c.currentLife <= 0).map((c) => c.instanceId));
  // Scoped charges advance allied creatures right now (combat + wall breaks +
  // prism pickups), threading the `tracking` accumulator built above (settled below).
  for (const eff of chargeEffects) {
    if (eff.type === "ChargeSelf") {
      // The source charges with its own PM right away. Like every charge from an effect
      // (applyChargeOnSummon, chargeAllies, the Charge spell), the burst is an extra move: the budget and
      // spent flag from before the charge are saved and restored after. This tells the two cases apart
      // without a special case:
      //   - "APPARITION : Charge" (Protoflex #288, Tristepin #6): new summon → budget 0 + hasAttacked true
      //     → restored → stays in place at end of turn;
      //   - a reactor already in play (Lilotte #444 ON_PLAY "charge quand vous jouez une carte", Lilotte
      //     #579 ON_PRISM): full PM + not spent → restored → it still takes its normal fin-de-tour advance
      //     (the charge used to overwrite movementLeft with 0, which froze her at end of turn).
      const self = creatures.find((c) => c.instanceId === instanceId && c.currentLife > 0);
      // "pas de charge" for an INAMOVIBLE: Statue/0-PM and Rooted block the charge.
      if (self && self.baseMovement > 0 && !cannotAdvance(self.properties) && !self.properties.has("Rooted")) {
        // `cells` charges exactly N cells (Lilotte "charge de 1 case"), or a dice value
        // (Defhi Croquets #319 "APPARITION : Charge de 1d6 cases") rolled now from the
        // trigger's seeded RNG with the owner's Dé Pipé floor, the roll also fired the
        // Ecaflip roll reactions via `triggerRolls` above. A missing `cells` means the
        // creature charges its whole PM (Tristepin's "APPARITION : Charge").
        const rawCells = (eff as { cells?: number | DynamicValue }).cells;
        const cells = rawCells == null
          ? undefined
          : typeof rawCells === "number"
            ? rawCells
            : resolveDynamicValue(rawCells, rng, state.players[owner.owner].diceFloor);
        // Save both halves of the creature's end-of-turn action, and restore them after the burst (the
        // wasSpent convention, as in chargeAllies and the Charge spell):
        //   - hasAttacked is restored to true for a charger with summoning sickness (Protoflex #288 used to
        //     engage again at end of turn): such a creature must never take a new fin-de-tour action. It is
        //     restored to false for a reactor already in play even if its charge hit (it keeps its normal
        //     end-of-turn engage);
        //   - movementLeft is restored so a reactor already in play keeps its fin-de-tour advance ("la charge
        //     est un bonus"; Lilotte #444) while a new summon gets 0 back and stays in place.
        const wasSpent = self.hasAttacked;
        const pmBudget = self.movementLeft;
        self.movementLeft = cells != null ? cells : self.baseMovement;
        self.hasAttacked = false; // the charge lets it move/engage right now
        advanceCreature(self, creatures, dofuses, log, self.owner, forwardDx(self.owner), tracking, { chargeMelee: true });
        if (self.currentLife > 0) {
          self.movementLeft = pmBudget;
          self.hasAttacked = wasSpent;
        }
      }
      continue;
    }
    const ce = eff as { cells?: number; family?: string; excludeSelf?: boolean; wounded?: boolean };
    chargeAllies(creatures, dofuses, log, owner.owner, ce.cells, ce.excludeSelf ? instanceId : undefined, ce.family, tracking, ce.wounded);
  }
  // A CHARGE that killed in combat in this trigger fires the charger's COUP DE GRÂCE (Milkar #46 "COUP
  // DE GRÂCE : Charge" landing a kill on its APPARITION charge). Captured from the pre-cull creatures,
  // limited to deaths from the charge's combat (deadBeforeCharge), fired on the settled board after the
  // RNG is stored again.
  const chargeCdgKills = chargeEffects.length === 0
    ? []
    // Same limits as elsewhere: creatures that broke through are excluded, and the scan stops at the
    // start of this trigger (the log covers the whole game).
    : collectCdgKills(creatures.filter((c) => !deadBeforeCharge.has(c.instanceId)), log, tracking.brokeThroughIds, state.log.length);

  // First: resolve any deaths from the self effects (e.g. self damage that killed the creature). This
  // must happen before a pending action is set, otherwise the player would be asked to pick a target
  // for a creature that is already dead.
  // The stream already advanced is passed, then its progress is taken back: without this, the draws of
  // the MORT reactions started again from the seed from before the trigger, and their progress was then
  // overwritten further down.
  let after = resolveDeathsAndWin({ ...state, rng: rng.state }, creatures, dofuses, log, tracking.brokeThroughIds);
  rng = new Rng(after.rng);
  // Cancane #775: a creature killed in front this trigger goes to the CASTER's hand instead of
  // staying in its owner's discard ("si elle va dans la défausse, elle remonte dans votre main").
  for (const b of bounceKilledSink) after = bounceKilledCardToHand(after, b.cardId, b.owner, owner.owner);
  after = removeConsumedSeeds(after, tracking.consumedSeedKeys);
  after = removeConsumedGlyphs(after, tracking.consumedGlyphKeys);
  after = removeConsumedTasDOs(after, tracking.consumedTasDOsKeys);
  after = removeConsumedBushes(after, tracking.consumedBushKeys);
  after = removeConsumedButins(after, tracking.consumedButinKeys);
  after = removeConsumedGifts(after, tracking.consumedGiftKeys);
  after = removeConsumedTraps(after, tracking.consumedTrapKeys);
  after = applyTrapPickups(after, tracking.trapPickups);
  after = applyButinPickups(after, tracking.butinPickups, rng); // reward roll uses the trigger's RNG
  after = applyGiftRollReactions(after, tracking);
  // Ecaflip roll reactions for a TRIGGERED roll (Shava MORT coin, Rémus FIN DU
  // TOUR, a 1d6 APPARITION…): one allied roll for the trigger's owner.
  if (triggerRolls) after = applyAllyRollReactions(after, owner.owner, 1);
  // Persist the advanced RNG state from any random self-effect (Otomaï). When no
  // random effect ran, rng.state === state.rng so this is a no-op. Player-state
  // effects below (which may roll their own RNG, e.g. Nomekop) then chain from
  // this value, keeping the whole trigger reproducible.
  after = { ...after, rng: rng.state };
  for (const pk of tracking.prismPickups) {
    after = activatePrism(after, pk.at, pk.side, pk.props, undefined, pk.byInstanceId);
  }

  // Player-state effects act on the post-death GameState. The trigger's owner
  // is the "caster" (a MORT/draw fires for the dead creature's controller).
  for (const eff of playerEffects) {
    // Pass rng so random player-state effects on a trigger (Phorreur Domestique
    // #255 "récupère 1 carte aléatoire de votre défausse") draw from the seeded
    // generator and stay reproducible.
    const r = applyPlayerStateEffect(after, eff, owner.owner, undefined, owner.position, rng);
    after = r.endsTurn ? endTurn(r.state) : r.state;
  }
  // Store the RNG again: the player-state effects above roll the shared `rng` object (e.g. Empereur
  // Gelax's random Jelly), but they get it as a parameter so they do not write it back themselves.
  // Without this, the progress is lost and the next damage event rolls the same pick again; each new
  // contre-coup must be independent.
  after = { ...after, rng: rng.state };

  // COUP DE GRÂCE for combat kills the charge made in this trigger, on the settled
  // board (killer must have survived, re-checked inside fireCoupDeGrace). Placed
  // after the RNG re-persist so a dice coup-de-grâce charge advances `after.rng`
  // without being clobbered; a no-op ([] kills) when this trigger had no charge.
  after = fireCoupDeGrace(after, chargeCdgKills);
  after = applyKillToButin(after, chargeCdgKills);

  // If the source died from self-effects, or no target effects pending,
  // we are done.
  if (pendingTargetEffects.length === 0) return after;
  const stillAlive = after.creatures.find((c) => c.instanceId === instanceId);
  if (!stillAlive) return after;

  // Check that at least one valid target exists for the first pending
  // effect, if not, silently skip (matches the in-game behaviour where
  // a trigger with no legal target just does not fire).
  const firstEff = pendingTargetEffects[0];
  const { filter, prompt } = effectTargetFilter(firstEff);
  // Optional attack ceiling (Moskito: ≤3 AT) and zone restriction (Arakne: "dans
  // votre camp") carried by some picks.
  const maxAttack = (firstEff as { maxAttack?: number }).maxAttack;
  const minAttack = (firstEff as { minAttack?: number }).minAttack; // Pissenlion #1045 "ayant au moins N AT"
  const pickFamily = (firstEff as { pickFamily?: string }).pickFamily; // Wa Wabbit #59 "un de vos wabbits"
  const zone = (firstEff as { zone?: "ownCamp" }).zone;
  // Source creature can never be targeted by its own trigger, so it does not
  // count toward "is there a legal target".
  if (!hasAtLeastOneTarget(after, filter, owner.owner, instanceId, maxAttack, zone, minAttack, pickFamily)) {
    return after;
  }

  // Park the pending effects on the state so the UI can prompt the
  // player. Engine consumers must call `resolvePendingAction(state,
  // target)` next. Trigger pendings are optional: the player may decline by
  // clicking any non-target cell, and cannot pick the source itself.
  return {
    ...after,
    pendingAction: {
      side: owner.owner,
      prompt,
      filter,
      pendingEffects: pendingTargetEffects,
      sourceInstanceId: instanceId,
      optional: true,
      ...(maxAttack != null ? { maxAttack } : {}),
      ...(minAttack != null ? { minAttack } : {}),
      ...(pickFamily != null ? { family: pickFamily } : {}),
      ...(zone != null ? { zone } : {}),
    },
  };
}

// Walk the board and return true if there is at least one cell matching
// the given filter, used by runTrigger to skip pending-action setup
// when nothing can actually be targeted.
function hasAtLeastOneTarget(
  state: GameState,
  filter: PendingAction["filter"],
  ownerSide: Side,
  excludeInstanceId?: number,
  maxAttack?: number,
  zone?: "ownCamp",
  minAttack?: number,
  family?: string,
): boolean {
  const ok = (c: CreatureInstance) =>
    c.currentLife > 0 &&
    c.instanceId !== excludeInstanceId &&
    (maxAttack == null || c.currentAttack <= maxAttack) &&
    (minAttack == null || c.currentAttack >= minAttack) &&
    (family == null || (famsOf(c)).includes(family)) &&
    (zone !== "ownCamp" || isAlliedTerritory(c.position.x, ownerSide));
  switch (filter) {
    case "enemy_creature":
      return state.creatures.some((c) => ok(c) && c.owner !== ownerSide);
    case "wounded_enemy_creature":
      return state.creatures.some((c) => ok(c) && c.owner !== ownerSide && c.currentLife < c.baseLife);
    case "ally_creature":
      return state.creatures.some((c) => ok(c) && c.owner === ownerSide);
    case "any_creature":
      return state.creatures.some((c) => ok(c));
    case "any_dofus":
      return state.dofuses.some((d) => d.currentLife > 0);
    case "ally_unrevealed_dofus":
      return state.dofuses.some((d) => d.currentLife > 0 && d.owner === ownerSide && !d.revealed);
    case "ally_phorreur_or_unrevealed_dofus":
      // Combined NÉCROME+Phorzerker pick: an allied Phorreur (→ fuse) or an own unrevealed Dofus (→ reveal).
      return state.creatures.some((c) => c.currentLife > 0 && c.owner === ownerSide && (famsOf(c)).includes("Phorreur"))
        || state.dofuses.some((d) => d.currentLife > 0 && d.owner === ownerSide && !d.revealed);
    case "enemy_unrevealed_dofus":
      return state.dofuses.some((d) => d.currentLife > 0 && d.owner !== ownerSide && !d.revealed);
    case "ally_dofus":
      return state.dofuses.some((d) => d.currentLife > 0 && d.owner === ownerSide);
    case "ally_dofus_no_equipment":
      return state.dofuses.some((d) => d.currentLife > 0 && d.owner === ownerSide && !dofusHasEquipment(d));
    case "ally_glyph":
      return (state.glyphs ?? []).some((g) => g.owner === ownerSide && !state.creatures.some((c) => c.currentLife > 0 && sameCoords(c.position, g.position)));
    case "enemy_dofus":
      return state.dofuses.some((d) => d.currentLife > 0 && d.owner !== ownerSide);
    case "destroyed_ally_dofus": {
      const wall = ownerSide === "ally" ? BOARD_COLS - 1 : 0;
      for (let y = 0; y < BOARD_ROWS; y++) if (!state.dofuses.some((d) => d.currentLife > 0 && d.position.x === wall && d.position.y === y)) return true;
      return false;
    }
    case "any_cell":
      return true;
    case "own_seed":
      return (state.seeds ?? []).some((s) => s.owner === ownerSide);
    case "own_empty_camp":
      for (let y = 0; y < BOARD_ROWS; y++) {
        for (let x = 0; x < BOARD_COLS; x++) {
          if (cellMatchesFilter(state, { x, y }, "own_empty_camp", ownerSide)) return true;
        }
      }
      return false;
    case "own_summon_cell":
      for (let y = 0; y < BOARD_ROWS; y++) {
        for (let x = 0; x < BOARD_COLS; x++) {
          if (canSummonHere(state, { x, y }, ownerSide)) return true;
        }
      }
      return false;
    case "any_prism":
      return state.prisms.length > 0;
    case "ally_prism":
      return state.prisms.some((p) => p.owner === ownerSide);
    case "enemy_prism":
      return state.prisms.some((p) => p.owner !== ownerSide);
    case "own_prismless_first_col": {
      // Lou #572: is there a row on the picker's first column (x=8 ally / x=1 enemy)
      // whose prism is missing and whose cell is free? (mirrors respawnOneSidePrism)
      const baseX = ownerSide === "ally" ? 8 : 1;
      const haveRows = new Set(state.prisms.filter((p) => p.owner === ownerSide).map((p) => p.position.y));
      for (let y = 0; y < BOARD_ROWS; y++) {
        if (!haveRows.has(y) && !prismCellOccupied(state, { x: baseX, y })) return true;
      }
      return false;
    }
    case "board_object":
      return !!(state.seeds?.length || state.traps?.length || state.butins?.length || state.glyphs?.length || state.tasDOs?.length || state.gifts?.length);
  }
  // `filter` is the wide pending-action union: anything this switch does not name
  // has no targetable cell, so the trigger must skip its pending-action setup.
  return false;
}

// Called by the UI when the player clicks a cell while a pendingAction
// is set. Applies the parked effects with the chosen cell as
// targetCell, clears the pending action, processes deaths.
// Decline an optional pending action (the player clicked off the board / "en
// dehors du terrain" to target nothing). No-op for a non-optional spell pending,
// which must still be resolved on a real target.
// Decline / cancel of a deferred targeted-APPARITION summon (deferredSummon): land the
// creature now, its self-effects apply and its AP is charged, but drop the targeting
// pick its APPARITION re-opens, since the player chose no target. A plain FRATRIE summon
// has no re-opened pick, so this is a no-op beyond placeDeferredSummon for it.
function landDeferredSummon(state: GameState, pending: PendingAction): GameState {
  const sa = pending.summonAfter;
  if (!sa) return { ...state, pendingAction: null };
  const landed = placeDeferredSummon(state, sa);
  // Declined deferred targeted APPARITION: the landing opened the pick again. Drop it (no target chosen)
  // and fire the arrival reactions it was holding (arrivalReactionsAfter), deferred behind the pick and
  // never lost.
  if (pending.deferredSummon && landed.pendingAction) {
    const ra = landed.pendingAction.arrivalReactionsAfter;
    const settled: GameState = { ...landed, pendingAction: null };
    return ra ? fireDeferredArrivalReactions(settled, ra) : settled;
  }
  return landed;
}

export function cancelPendingAction(state: GameState): GameState {
  // Held spell (mandatory two-click play): nothing was committed at the 1st pick, so dropping the
  // pending is the cancel (card still in hand, AP untouched, log unchanged).
  if (state.pendingAction?.heldSpell) return { ...state, pendingAction: null };
  if (state.pendingAction && state.pendingAction.optional) {
    // Clicking off the board cancels the whole play for any deferred summon: the creature was held off
    // the board, so its card goes back to hand (with its cost mod) and nothing is placed. This covers the
    // Phorzerker fusion, FRATRIE, deferred targeted APPARITION (Erik Rak / Diod Dewit), and deferred
    // NÉCROME, which all carry `summonAfter`. The AP was refunded when the pick opened (summonAfter.cost
    // holds the unpaid cost), so no AP change here. Not a landing.
    const sa = state.pendingAction.summonAfter;
    if (sa) {
      const p = state.players[sa.owner];
      return {
        ...state,
        players: {
          ...state.players,
          [sa.owner]: { ...p, hand: [...p.hand, sa.cardId], handCostMods: [...p.handCostMods, sa.playedCostMod ?? 0] },
        },
        pendingAction: null,
      };
    }
    // An ALREADY-PLACED creature (no summonAfter): a declined held APPARITION still fires it. Only
    // reached now for effect-/token-summoned creatures (hand-played NÉCROMEs defer above).
    if (state.pendingAction.fireApparitionAfter !== undefined) {
      return firePendingApparition({ ...state, pendingAction: null }, state.pendingAction);
    }
    return state;
  }
  return state;
}

// Public entry: resolve the click, then fire any arrival reactions deferred behind the
// pick that just settled (arrivalReactionsAfter, see fireApparitionPhase). Compared by
// REFERENCE on the stamp object so an unchanged pending (invalid click on a non-optional
// pick → same object) or an accumulating one (a butinCast pick, the spread keeps the same
// nested stamp) does not fire early, and a CHAINED fresh pick fires its own stamp exactly
// once, at its own settle (the recursive internal calls also route through this wrapper).
export function resolvePendingAction(state: GameState, target: Coords): GameState {
  const ra = state.pendingAction?.arrivalReactionsAfter;
  const out = resolvePendingActionCore(state, target);
  if (ra && !out.winner && out.pendingAction?.arrivalReactionsAfter !== ra) {
    return fireDeferredArrivalReactions(out, ra);
  }
  return out;
}

function resolvePendingActionCore(state: GameState, target: Coords): GameState {
  const pending = state.pendingAction;
  if (!pending) return state;
  // A CREATURE-target optional trigger cannot pick its own source (Black Wabbit,
  // Tomla Klass…). But a cell/area trigger (filter "any_cell", e.g. Tikoko's
  // rangée) can include the source's own cell, clicking it boosts the column
  // Tikoko stands on, Tikoko included. So the source-as-decline shortcut only
  // applies when the trigger targets a creature.
  const source = state.creatures.find((c) => c.instanceId === pending.sourceInstanceId);
  const clickedSelf =
    pending.optional && pending.filter !== "any_cell" && !!source && sameCoords(source.position, target);
  // Validate the click against the filter. For an optional creature trigger,
  // clicking a non-target cell (or the source itself) declines the effect. An
  // "any_cell" trigger has no in-board decline, the player declines by clicking
  // off the board (cancelPendingAction). For a non-optional (spell) pending we
  // keep waiting (silent no-op).
  // A held spell (mandatory two-click play): the 2nd pick is valid only on an actual
  // valid-target cell. The raw filter is not enough, it would accept re-clicking the
  // 1st pick (any_creature), any board cell for ChangeRow (any_cell), or a butin cell
  // already chosen, so gate on the same enumeration the UI highlights.
  const heldInvalid =
    !!pending.heldSpell && !validPendingTargets(state).some((c) => sameCoords(c, target));
  if (clickedSelf || heldInvalid || !cellMatchesFilter(state, target, pending.filter, pending.side, pending.maxAttack, pending.zone, pending.minAttack, pending.family)) {
    // Held spell: nothing was committed at the 1st pick, so a click without a valid
    // 2nd target cancels the whole play, pure take-back, the card never left the
    // hand and no AP moved.
    if (pending.heldSpell) return { ...state, pendingAction: null };
    if (!pending.optional) return state;
    // A deferred NÉCROME declined on the board: land the creature (base Orbe granted at landing, no
    // secondary effect) then fire its held APPARITION exactly once. (Off-board cancel is handled by
    // cancelPendingAction → card to hand, no Orbe.)
    if (pending.deferredNecrome && pending.summonAfter) {
      const newId = state.nextInstanceId;
      const landed = placeDeferredSummon(state, pending.summonAfter);
      // The silent landing (skipArrivalReactions) left the arrival reactions to this
      // settle run, playedFromHand armed so ON_PLAY/Camille fire here, once, after the
      // held APPARITION (fix: Welsh double ENTERS_PLAY).
      return fireApparitionPhase({ ...landed, pendingAction: null }, newId, true, pending.apparitionPlayedFromHand === true);
    }
    // Sacrifice #576: declining the damage target (click elsewhere) still SACRIFICES the
    // 1st creature (the cost is committed), it just deals no damage.
    if (pending.firstTarget && pending.pendingEffects.some((e) => e.type === "SacrificeForDamage")) {
      const victim = creatureAt(state, pending.firstTarget);
      if (!victim) return { ...state, pendingAction: null };
      // Full clone: resolveDeathsAndWin runs the MORT / MORT ALLIEE / MORT ADVERSE through applyEffects,
      // which writes into the objects it gets. The old `: c` returned the input object for every other
      // creature, so a sacrificed creature with a MORT trigger (Corbacassin #115) wounded the board of the
      // input state, and replaying the same decline added up the damage. Same cloning as the Lame Emoussée
      // branch just below.
      const creatures = state.creatures.map((c) =>
        c.instanceId === victim.instanceId
          ? { ...c, currentLife: 0, position: { ...c.position }, properties: new Set(c.properties) }
          : { ...c, position: { ...c.position }, properties: new Set(c.properties) },
      );
      const dofuses = state.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
      return resolveDeathsAndWin({ ...state, pendingAction: null }, creatures, dofuses, [...state.log], new Set());
    }
    // Lame Émoussée #1177: declining the wounded-enemy pick still deals `self` to the 1st (ally).
    if (pending.firstTarget && pending.pendingEffects.some((e) => e.type === "LameEmoussee")) {
      const eff = pending.pendingEffects.find((e) => e.type === "LameEmoussee") as { self: number };
      const creatures = state.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
      const dofuses = state.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
      const log = [...state.log];
      applyEffects(creatures, dofuses, log, [{ type: "DamageData", Damage: eff.self }], { casterSide: state.activeSide, targetCell: { ...pending.firstTarget } });
      const after = resolveDeathsAndWin({ ...state, pendingAction: null }, creatures, dofuses, log, new Set());
      return settleDamageReactions(after, state.log.length, creatures);
    }
    // Pluie de Météorites #1350: declining the damage target still destroys the ally's armour and draws.
    if (pending.firstTarget && pending.pendingEffects.some((e) => e.type === "DestroyArmorForDamage")) {
      const eff = pending.pendingEffects.find((e) => e.type === "DestroyArmorForDamage") as { draw?: number };
      const ally = creatureAt(state, pending.firstTarget);
      if (!ally) return { ...state, pendingAction: null };
      const log = [...state.log];
      if (ally.armor > 0) log.push({ type: "ARMOR_GAINED", instanceId: ally.instanceId, armorMod: { valueBefore: ally.armor, modification: -ally.armor, valueAfter: 0 } });
      const creatures = state.creatures.map((c) => (c.instanceId === ally.instanceId && c.armor > 0 ? { ...c, armor: 0 } : c));
      let result: GameState = { ...state, creatures, log, pendingAction: null };
      for (let i = 0; i < (eff.draw ?? 0) && !result.winner; i++) result = drawCard(result, state.activeSide);
      return result;
    }
    // Pampactus #218 ("infligez 1 dégât à une invocation alliée pour l'invoquer"): it can only be summoned
    // by paying the ally-damage cost, so declining the pick (clicking a non-ally cell) cancels the whole
    // play. The card goes back to hand and nothing is placed, exactly like the off-board cancel (no ally
    // targeted → no summon).
    if (pending.summonAfter && pending.pendingEffects.some((e) => e.type === "DamageAllyToSummon")) {
      return cancelPendingAction(state);
    }
    // Declining still lands the creature (you played it, only the targeting was optional):
    // a FRATRIE keeps its direct landing, a deferred targeted APPARITION lands without its
    // targeted effect.
    return pending.summonAfter
      ? landDeferredSummon(state, pending)
      : firePendingApparition({ ...state, pendingAction: null }, pending);
  }

  // Held two-click spell with a valid 2nd pick: commit the whole play now. Enter playCard again
  // (`commitHeld`: pays AP, discards, logs, and castSpell parks the pick again as a committed pending),
  // resolve that pending through the normal branches below, then fire the "quand vous jouez un sort"
  // reactions; the spell's own effect settles first. None of this happened at the 1st pick. (A held
  // butinCast pending has no firstTarget: its picks add up in the butinCast branch further down.)
  if (pending.heldSpell && pending.firstTarget) {
    const held = getCard(pending.heldSpell.cardId);
    if (!held) return { ...state, pendingAction: null };
    const committed = playCard({ ...state, pendingAction: null }, held, pending.firstTarget, { commitHeld: true });
    if (committed.winner || !committed.pendingAction) return committed; // fizzled or settled outright
    let done = resolvePendingAction(committed, target);
    if (!done.winner && !done.pendingAction) done = fireOnPlayReactions(done, pending.side, held);
    return done;
  }

  // A deferred NÉCROME with a valid pick (a Phorreur to fuse, or an unrevealed Dofus to reveal): land
  // the creature first (base Orbe granted, APPARITION not yet fired), then re-open the same pick with
  // the real landed source and recurse, so the existing phorzerkerNecrome / RevealDofus handlers run
  // unchanged (Phorreur → fuse & cancel APPARITION; Dofus → reveal for a 2nd Orbe + fire APPARITION).
  if (pending.deferredNecrome && pending.summonAfter) {
    const newId = state.nextInstanceId;
    const landed = placeDeferredSummon(state, pending.summonAfter);
    return resolvePendingAction(
      { ...landed, pendingAction: { ...pending, sourceInstanceId: newId, summonAfter: undefined, deferredNecrome: undefined } },
      target,
    );
  }

  // Deferred targeted-APPARITION summon: the creature was held off the board until now
  // (no AP spent, nothing picked up). The clicked `target` (validated above) is its
  // APPARITION's target. Land it now, placeDeferredSummon charges the cost and places it
  // (picking up any prism/seed/butin/tas-d'os on the cell) and fires its APPARITION, which
  // re-opens the same targeting pick with the real source on the board; we auto-resolve
  // that pick with `target` so the player clicked only once.
  if (pending.deferredSummon && pending.summonAfter) {
    const landed = placeDeferredSummon(state, pending.summonAfter);
    return landed.pendingAction ? resolvePendingAction(landed, target) : landed;
  }

  // Combined NÉCROME+Phorzerker pick (Championne Périmée #634 / Champion Croulant #899): the Énutrof
  // is already placed (Necrome placed it + granted the base Orbe). The clicked cell (validated above
  // as a Phorreur or an unrevealed Dofus) decides: a PHORREUR → POST-placement fuse (transform the
  // source into Phorzerker #800, summed AT/PV, Énutrof's PM, banish the Phorreur, its APPARITION is
  // cancelled, so we do not fire it); an unrevealed DOFUS → reveal it for a 2nd Orbe, then fire the
  // held APPARITION. (A decline was handled at the top → firePendingApparition.)
  if (source && pending.phorzerkerNecrome) {
    const phorreur = state.creatures.find(
      (c) => c.currentLife > 0 && c.owner === pending.side && c.instanceId !== source.instanceId &&
        sameCoords(c.position, target) && (getCard(c.cardId)?.families ?? []).includes("Phorreur"),
    );
    if (phorreur) {
      const sumAttack = source.currentAttack + phorreur.currentAttack;
      const sumLife = source.currentLife + phorreur.currentLife;
      const pm = source.baseMovement; // keeps the Énutrof's PM
      const log: GameEvent[] = [...state.log];
      const creatures = state.creatures
        .filter((c) => c.instanceId !== phorreur.instanceId)
        .map((c) => (c.instanceId === source.instanceId ? { ...c, position: { ...c.position }, properties: new Set(c.properties) } : c));
      const fused = creatures.find((c) => c.instanceId === source.instanceId)!;
      transformCreature(fused, PHORZERKER_TOKEN_ID, source.owner, log); // → Phorzerker identity (stays summoning-sick)
      fused.currentAttack = fused.baseAttack = fused.printedAttack = sumAttack;
      fused.currentLife = fused.baseLife = fused.printedLife = sumLife;
      fused.baseMovement = fused.printedMovement = pm;
      fused.movementLeft = Math.min(fused.movementLeft, pm);
      fused.costOverride = getCard(source.cardId)?.cost; // in-play cost = the Énutrof's
      log.push({ type: "FIGHT_OBJECT_REMOVED", instanceId: phorreur.instanceId });
      log.push({ type: "CARD_MOVED", cardId: phorreur.cardId, from: "board", to: "banished", side: phorreur.owner });
      const owner = state.players[phorreur.owner];
      const fusedOut: GameState = {
        ...state,
        creatures: withAuras(creatures, seedSidesOf(state)),
        players: { ...state.players, [phorreur.owner]: { ...owner, banished: [...(owner.banished ?? []), phorreur.cardId] } },
        log,
        pendingAction: null, // the Énutrof's own APPARITION is cancelled by the fusion
      };
      // The fusion cancels the APPARITION, but the creature DID enter play, and its silent
      // landing left the arrival reactions to this settle: fire them once. `playedCardId` is
      // the Énutrof actually played (source.cardId, the copy was transformed, not `source`).
      return fireDeferredArrivalReactions(fusedOut, {
        entrantId: source.instanceId,
        side: pending.side,
        ...(pending.apparitionPlayedFromHand ? { playedCardId: source.cardId } : {}),
      });
    }
    // Otherwise the click is an unrevealed Dofus → reveal it (2nd Orbe), then fire the held APPARITION.
    const after = applyPlayerStateEffect(state, { type: "RevealDofus" }, pending.side, target).state;
    return firePendingApparition({ ...after, pendingAction: null }, pending);
  }

  // PHORZERKER fusion (deferred): the Énutrof is still off the board (summonAfter). The picked
  // allied Phorreur (validated above) is banished and the Énutrof is placed and transformed into
  // a Phorzerker (#800) whose AT and PV are the sum of both creatures' current values, keeping the
  // Énutrof's PM. The Énutrof's own APPARITION is CANCELLED (placed with fireApparition=false).
  if (pending.phorzerkerFusion && pending.summonAfter) {
    const sa = pending.summonAfter;
    const cd = getCard(sa.cardId);
    const phorreur0 = state.creatures.find((c) => c.currentLife > 0 && c.owner === pending.side && sameCoords(c.position, target));
    if (!cd || !phorreur0) return { ...state, pendingAction: null };
    // Land the Énutrof now: charge its (deferred) cost and place it without firing its APPARITION.
    let s: GameState = { ...state, pendingAction: null };
    if (sa.cost != null) {
      const p = s.players[sa.owner];
      s = { ...s, players: { ...s.players, [sa.owner]: { ...p, ap: Math.max(0, p.ap - sa.cost) } } };
    }
    const newId = s.nextInstanceId;
    s = summonCreature(s, cd, sa.cell, sa.owner, false, sa.playedCostMod ?? 0, false, true);
    const enutrof = s.creatures.find((c) => c.instanceId === newId && c.currentLife > 0);
    const phorreur = s.creatures.find((c) => c.instanceId === phorreur0.instanceId && c.currentLife > 0);
    if (!enutrof || !phorreur) return s; // summon failed / Phorreur gone → leave the Énutrof placed
    const sumAttack = enutrof.currentAttack + phorreur.currentAttack;
    const sumLife = enutrof.currentLife + phorreur.currentLife;
    const pm = enutrof.baseMovement; // the result keeps the Énutrof's PM
    const log: GameEvent[] = [...s.log];
    // Remove (banish) the Phorreur; clone the Énutrof so transformCreature mutates a copy.
    const creatures = s.creatures
      .filter((c) => c.instanceId !== phorreur.instanceId)
      .map((c) => (c.instanceId === enutrof.instanceId ? { ...c, position: { ...c.position }, properties: new Set(c.properties) } : c));
    const fused = creatures.find((c) => c.instanceId === enutrof.instanceId)!;
    transformCreature(fused, PHORZERKER_TOKEN_ID, enutrof.owner, log); // → Phorzerker identity (stays summoning-sick)
    fused.currentAttack = fused.baseAttack = fused.printedAttack = sumAttack;
    fused.currentLife = fused.baseLife = fused.printedLife = sumLife;
    fused.baseMovement = fused.printedMovement = pm;
    fused.movementLeft = Math.min(fused.movementLeft, pm);
    fused.costOverride = cd.cost; // in-play cost = the Énutrof's, not token #800's 3
    // The Phorreur is banished (removed from the game, not discarded → no MORT, no recovery).
    log.push({ type: "FIGHT_OBJECT_REMOVED", instanceId: phorreur.instanceId });
    log.push({ type: "CARD_MOVED", cardId: phorreur.cardId, from: "board", to: "banished", side: phorreur.owner });
    const owner = s.players[phorreur.owner];
    return {
      ...s,
      // Re-fold CHEF auras: the banished Phorreur may have been buffing allies (or been buffed).
      creatures: withAuras(creatures, seedSidesOf(s)),
      players: { ...s.players, [phorreur.owner]: { ...owner, banished: [...(owner.banished ?? []), phorreur.cardId] } },
      log,
      pendingAction: null,
    };
  }

  // Moskito's APPARITION swap: the source trades cells with the picked ally.
  // Distinct from the two-target SwapPosition spell (which needs firstTarget).
  if (source && pending.pendingEffects.some((e) => e.type === "SwapSourcePosition")) {
    return resolveSwapPosition(state, source.position, target);
  }

  // Asprogik Mils' APPARITION: the source trades its attack with the picked
  // creature (any side). Reuses the two-target swap resolver with the source as
  // the first cell. clickedSelf above already rejected picking the source ("autre").
  if (source && pending.pendingEffects.some((e) => e.type === "SwapSourceAttack")) {
    return resolveSwap(state, source.position, target, "SwapAttack");
  }

  // Pupuce #441: the source adopts the picked creature's family (replaces its own,
  // via familyOverride). Read everywhere through famsOf.
  if (source && pending.pendingEffects.some((e) => e.type === "CopyFamilyFromTarget")) {
    const model = creatureAt(state, target);
    const fams = model ? [...famsOf(model)] : [];
    return {
      ...state,
      creatures: state.creatures.map((c) => (c.instanceId === source.instanceId ? { ...c, familyOverride: fams } : c)),
      pendingAction: null,
    };
  }

  // Garde du corps #320/#300: the source (the just-summoned bodyguard) takes the picked
  // ally creature under its protection, that creature's incoming damage is redirected
  // onto the bodyguard (guardOf) for as long as the bodyguard lives. Self-pick is a no-op.
  if (source && pending.pendingEffects.some((e) => e.type === "GuardCreature")) {
    const protectedCreature = creatureAt(state, target);
    if (!protectedCreature || protectedCreature.instanceId === source.instanceId) {
      return { ...state, pendingAction: null };
    }
    return {
      ...state,
      creatures: state.creatures.map((c) => (c.instanceId === protectedCreature.instanceId ? { ...c, protectedByGuard: source.instanceId } : c)),
      pendingAction: null,
    };
  }

  // Wabbit en Chocolat #733: pull a copy of the picked creature's card from the deck
  // into the caster's hand (via TutorFromDeck by cardId, no-op if not in the deck).
  if (pending.pendingEffects.some((e) => e.type === "TutorCopyOfTarget")) {
    const model = creatureAt(state, target);
    if (!model) return { ...state, pendingAction: null };
    const tut = { type: "TutorFromDeck" as const, from: "top" as const, amount: 1, cardId: model.cardId };
    const after = applyPlayerStateEffect(state, tut, pending.side).state;
    return { ...after, pendingAction: null };
  }

  // Chacha Sauvage's APPARITION: the source trades its movement with the picked
  // creature (any side). clickedSelf above already rejected picking the source.
  if (source && pending.pendingEffects.some((e) => e.type === "SwapSourceMovement")) {
    return resolveSwap(state, source.position, target, "SwapMovement");
  }

  // Sacrifice (Tartanque #154, Tofu Mutant #301): the picked allied creature is
  // destroyed; the source then gains a buff, fixed (+N AT / +N AR) or the victim's
  // own AT + PM (gainFromVictim). A family filter (#301 "un Tofu") is enforced
  // here; a wrong-family pick just declines (the source was already played).
  const sac = source && (pending.pendingEffects.find((e) => e.type === "Sacrifice") as
    | { family?: string; gainAttack?: number; gainArmor?: number; gainFromVictim?: boolean }
    | undefined);
  if (source && sac) {
    const victim = state.creatures.find(
      (c) => c.currentLife > 0 && c.owner === pending.side && sameCoords(c.position, target) && c.instanceId !== source.instanceId,
    );
    if (!victim || (sac.family && !(famsOf(victim)).includes(sac.family))) {
      return { ...state, pendingAction: null };
    }
    const gainAt = sac.gainFromVictim ? victim.currentAttack : (sac.gainAttack ?? 0);
    const gainMv = sac.gainFromVictim ? victim.baseMovement : 0;
    const gainAr = sac.gainFromVictim ? 0 : (sac.gainArmor ?? 0);
    // Full clone: the original `return c` gave back the input object for every other creature, while
    // resolveDeathsAndWin then runs the MORT / MORT ALLIEE / MORT ADVERSE through applyEffects, which
    // writes into it. Sacrificing a carrier of an offensive MORT (Corbacassin #115), or simply having a
    // MORT ALLIEE reactor on the board, rewrote the input state, and searching the same state again added
    // up the damage (5 -> 4 -> 3).
    const clone = (c: CreatureInstance): CreatureInstance => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) });
    const creatures = state.creatures.map((c) => {
      if (c.instanceId === victim.instanceId) return { ...clone(c), currentLife: 0 };
      if (c.instanceId === source.instanceId)
        return { ...clone(c), currentAttack: c.currentAttack + gainAt, baseAttack: c.baseAttack + gainAt, baseMovement: c.baseMovement + gainMv, movementLeft: c.movementLeft + gainMv, armor: c.armor + gainAr };
      return clone(c);
    });
    const dofuses = state.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
    const settled = resolveDeathsAndWin({ ...state, pendingAction: null }, creatures, dofuses, [...state.log], new Set());
    return { ...settled, creatures: withAuras(settled.creatures) };
  }

  // Marline's APPARITION "body swap": the source and the picked enemy trade
  // both their cells and their sides (the enemy becomes yours on Marline's spot,
  // Marline becomes the foe's on the enemy's spot).
  if (source && pending.pendingEffects.some((e) => e.type === "SwapBody")) {
    return resolveSwapBody(state, source.position, target);
  }

  // Targeted bounce from a trigger pick (Adamaï: "Remonte une invocation ≤N AT
  // dans la main de son propriétaire"). ReturnToHand/ReturnToDeck are
  // player-state effects, not handled by effects.ts applyEffects, so the generic
  // path below would no-op, apply the bounce to the picked creature here.
  const bounceEff = pending.pendingEffects.find((e) => e.type === "ReturnToHand" || e.type === "ReturnToDeck") as
    | { type: string; toSide?: "caster" | "opponent" }
    | undefined;
  if (bounceEff) {
    // `toSide` redirects the card away from its owner: "caster" = a steal into the
    // trigger owner's hand (Zaldior), "opponent" = push it to the foe's hand.
    const toSide =
      bounceEff.toSide === "caster" ? pending.side : bounceEff.toSide === "opponent" ? other(pending.side) : undefined;
    const after = bounceCreature(state, target, bounceEff.type === "ReturnToHand" ? "hand" : "deck", toSide);
    return { ...after, pendingAction: null };
  }

  // Padgref Démouelle #222: "infligez 1 dégât à un de vos dofus pour l'invoquer". The
  // deferred-summon machinery already paid + placed Padgref; its APPARITION now picks one
  // of your Dofus and deals N to it (a self-inflicted summon cost). A guarded Dofus (Lien
  // de Sang) redirects the hit to its guard creature, mirroring the spell dofus-damage path.
  const dmgDofus = pending.pendingEffects.find((e) => e.type === "DamageDofus") as { amount: number; side?: "ally" | "enemy" } | undefined;
  if (dmgDofus) {
    const dofus = state.dofuses.find((d) => d.currentLife > 0 && sameCoords(d.position, target));
    if (!dofus) return { ...state, pendingAction: null };
    const guard = dofus.protectedBy != null
      ? state.creatures.find((c) => c.instanceId === dofus.protectedBy && c.currentLife > 0)
      : undefined;
    const log = [...state.log];
    let creatures = state.creatures;
    let dofuses = state.dofuses;
    if (guard) {
      creatures = state.creatures.map((c) => c.instanceId === guard.instanceId ? { ...c, currentLife: Math.max(0, c.currentLife - dmgDofus.amount) } : c);
      log.push({ type: "DAMAGE", sourceInstanceId: pending.sourceInstanceId ?? -1, targetInstanceId: guard.instanceId, damage: dmgDofus.amount, armorHit: false });
    } else {
      dofuses = state.dofuses.map((d) => sameCoords(d.position, dofus.position) ? { ...d, currentLife: Math.max(0, d.currentLife - dmgDofus.amount) } : d);
      log.push({ type: "DAMAGE", targetCell: { ...dofus.position }, damage: dmgDofus.amount, sourceInstanceId: pending.sourceInstanceId });
    }
    const settled = resolveDeathsAndWin({ ...state, pendingAction: null }, creatures, dofuses, log, new Set());
    return { ...settled, creatures: withAuras(settled.creatures) };
  }

  // Artheon #1424: the deferred-summon machinery already landed Artheon; its APPARITION now picks
  // any Dofus and makes it invulnerable while Artheon stays in play (invulnerableBy = Artheon's
  // instanceId, every damage/destruction site skips a Dofus guarded by a living creature, and the
  // guard lapses on its own when Artheon dies).
  if (pending.pendingEffects.some((e) => e.type === "MakeDofusInvulnerable")) {
    const dofus = state.dofuses.find((d) => d.currentLife > 0 && sameCoords(d.position, target));
    if (!dofus || pending.sourceInstanceId == null) return { ...state, pendingAction: null };
    const dofuses = state.dofuses.map((d) =>
      sameCoords(d.position, dofus.position) ? { ...d, invulnerableBy: pending.sourceInstanceId } : d);
    return { ...state, dofuses, pendingAction: null };
  }

  // Pissenlit Maléfique #1041: the picked ally Dofus gets a one-hit shield (woundDofus absorbs the
  // first damage it takes, then clears it). Just sets the flag, no source binding needed.
  if (pending.pendingEffects.some((e) => e.type === "ShieldDofus")) {
    const dofus = state.dofuses.find((d) => d.currentLife > 0 && sameCoords(d.position, target));
    if (!dofus) return { ...state, pendingAction: null };
    const dofuses = state.dofuses.map((d) =>
      sameCoords(d.position, dofus.position) ? { ...d, shielded: true } : d);
    return { ...state, dofuses, pendingAction: null };
  }

  // Sinistro placed by a trigger pick (Diod Dewit #337 APPARITION: "Placez un Sinistro sur un
  // Dofus"): attach the Sinistro to the picked allied Dofus (without equipment), the engine then
  // fires it at FIN_DE_TOUR and breaks it if the host is wounded, exactly like the #215 spell.
  if (pending.pendingEffects.some((e) => e.type === "AttachSinistro")) {
    const dofus = state.dofuses.find((d) => d.currentLife > 0 && d.owner === pending.side && sameCoords(d.position, target) && !dofusHasEquipment(d));
    if (!dofus) return { ...state, pendingAction: null };
    const dofuses = state.dofuses.map((d) => sameCoords(d.position, dofus.position) ? { ...d, sinistroAttached: true } : d);
    return { ...state, dofuses, pendingAction: null };
  }

  // FRATRIE mill: the picked enemy creature names a card; every copy of that card
  // in the opponent's deck is moved to their discard (the board creature stays).
  // Then the Fratrie creature itself is placed (it lands only after the pick).
  if (pending.pendingEffects.some((e) => e.type === "FratrieMill")) {
    let result: GameState = { ...state, pendingAction: null };
    const victim = creatureAt(state, target);
    if (victim) {
      const opp = victim.owner;
      const op = result.players[opp];
      const milled = op.deck.filter((id) => id === victim.cardId);
      if (milled.length > 0) {
        // Rebuild deck + deckCostMods together so removing every copy of victim.cardId keeps the opponent's
        // deckCostMods aligned (otherwise their later draws lose Vampyro/HORDE).
        const baseMods = op.deckCostMods && op.deckCostMods.length === op.deck.length ? op.deckCostMods : op.deck.map(() => 0);
        const deck: number[] = [];
        const deckMods: number[] = [];
        op.deck.forEach((id, i) => { if (id !== victim.cardId) { deck.push(id); deckMods.push(baseMods[i] ?? 0); } });
        const log: GameEvent[] = [...result.log];
        for (const id of milled) log.push({ type: "CARD_MOVED", cardId: id, from: "deck", to: "discard", side: opp });
        result = { ...result, players: { ...result.players, [opp]: { ...op, deck, deckCostMods: deckMods, discard: [...op.discard, ...milled] } }, log };
      }
    }
    return pending.summonAfter ? placeDeferredSummon(result, pending.summonAfter) : result;
  }

  // Seed transform from a trigger pick (Li Crounch/Dodu/Canar APPARITION:
  // "Transformez une de vos Graines en <token>"). TransformSeed is a player-state
  // effect (it removes a board seed and summons a creature) → apply it to the
  // picked seed cell via applyPlayerStateEffect, which owns that mutation.
  const seedTransform = pending.pendingEffects.find((e) => e.type === "TransformSeed" || e.type === "TransformSeedToBush");
  if (seedTransform) {
    const after = applyPlayerStateEffect(state, seedTransform, pending.side, target).state;
    return { ...after, pendingAction: null };
  }

  // Glyph placed by a trigger pick (Melita APPARITION): drop the Glyphe on the
  // picked empty camp cell via the PlaceGlyph player-state handler.
  const placeGlyph = pending.pendingEffects.find((e) => e.type === "PlaceGlyph");
  if (placeGlyph) {
    const after = applyPlayerStateEffect(state, placeGlyph, pending.side, target).state;
    return { ...after, pendingAction: null };
  }

  // Tas d'Os placed by a trigger pick (Chafer Archer #336 APPARITION): drop the Tas
  // d'Os on the picked empty camp cell via the PlaceTasDOs player-state handler.
  const placeTasDOs = pending.pendingEffects.find((e) => e.type === "PlaceTasDOs");
  if (placeTasDOs) {
    const after = applyPlayerStateEffect(state, placeTasDOs, pending.side, target).state;
    return { ...after, pendingAction: null };
  }

  // Prism destroyed by a trigger pick (Patek Tag APPARITION): remove the prism on
  // the picked cell via the DestroyPrism player-state handler.
  const destroyPrism = pending.pendingEffects.find((e) => e.type === "DestroyPrism");
  if (destroyPrism) {
    const after = applyPlayerStateEffect(state, destroyPrism, pending.side, target).state;
    return { ...after, pendingAction: null };
  }

  // Board object destroyed by a trigger pick (Tournesol Sauvage #1082): remove the
  // Seed/Trap/Butin/Glyphe/Tas d'os on the picked cell via its player-state handler.
  const destroyObj = pending.pendingEffects.find((e) => e.type === "DestroyBoardObject");
  if (destroyObj) {
    const after = applyPlayerStateEffect(state, destroyObj, pending.side, target).state;
    return { ...after, pendingAction: null };
  }

  // Dofus swap by a trigger pick (Ush #426/#13): the SOURCE's-row Dofus swaps cells with
  // the picked Dofus. Pass the source's cell so the handler finds the row Dofus.
  const swapDofus = pending.pendingEffects.find((e) => e.type === "SwapDofus");
  if (swapDofus) {
    const after = applyPlayerStateEffect(state, swapDofus, pending.side, target, source?.position).state;
    return { ...after, pendingAction: null };
  }

  // Dofus moved to a destroyed-Dofus slot by a trigger pick (Ush #100).
  const moveDofus = pending.pendingEffects.find((e) => e.type === "MoveRowDofus");
  if (moveDofus) {
    const after = applyPlayerStateEffect(state, moveDofus, pending.side, target, source?.position).state;
    return { ...after, pendingAction: null };
  }

  // Dofus revealed by a trigger pick (Kerubim "dévoilez un dofus [adverse]" #333/#378):
  // flip `revealed` on the picked Dofus via the RevealDofuses player-state handler.
  const revealDofuses = pending.pendingEffects.find((e) => e.type === "RevealDofuses");
  if (revealDofuses) {
    const after = applyPlayerStateEffect(state, revealDofuses, pending.side, target).state;
    return { ...after, pendingAction: null };
  }

  // Prism → Butin from a trigger pick (Erik Rak APPARITION): swap the picked prism
  // for a caster-owned Butin via the TransformPrismToButin player-state handler.
  const prismToButin = pending.pendingEffects.find((e) => e.type === "TransformPrismToButin");
  if (prismToButin) {
    const after = applyPlayerStateEffect(state, prismToButin, pending.side, target).state;
    return { ...after, pendingAction: null };
  }

  // Prism → Bombe from a trigger pick (Remington Smisse #80 APPARITION): swap the picked
  // prism for a Bombe trap owned by the SOURCE'S side (pending.side) via the
  // TransformPrismToBombe player-state handler, so an enemy of Remington jumps on it.
  const prismToBombe = pending.pendingEffects.find((e) => e.type === "TransformPrismToBombe");
  if (prismToBombe) {
    const after = applyPlayerStateEffect(state, prismToBombe, pending.side, target).state;
    return { ...after, pendingAction: null };
  }

  // Prism sacrifice from a trigger pick (Kibri #735 APPARITION): sacrifice the picked
  // allied prism and buff the source's other creatures. selfCell = the source cell so the
  // buff skips Kibri itself ("vos AUTRES invocations").
  const sacrificePrism = pending.pendingEffects.find((e) => e.type === "SacrificePrismBuff");
  if (sacrificePrism) {
    const src = state.creatures.find((c) => c.instanceId === pending.sourceInstanceId && c.currentLife > 0);
    const after = applyPlayerStateEffect(state, sacrificePrism, pending.side, target, src?.position).state;
    return { ...after, pendingAction: null };
  }

  // Prism pickup from a trigger pick (Lou 2★ #521 "Ramassez un prisme", choose which):
  // collect the picked prism (any side) and grant its bonus to the caster via RamasserPrisme.
  const ramasser = pending.pendingEffects.find((e) => e.type === "RamasserPrisme" && (e as { choose?: boolean }).choose);
  if (ramasser) {
    const src = state.creatures.find((c) => c.instanceId === pending.sourceInstanceId && c.currentLife > 0);
    const after = applyPlayerStateEffect(state, ramasser, pending.side, target, src?.position).state;
    return { ...after, pendingAction: null };
  }

  // Prism respawn from a trigger pick (Lou 1★ #572 "faites réapparaître un prisme allié",
  // choose where): respawn the prism of the picked first-column row on the caster's side.
  const respawnPick = pending.pendingEffects.find((e) => e.type === "RespawnPrisms" && (e as { choose?: boolean }).choose);
  if (respawnPick) {
    return { ...respawnOneSidePrism(state, pending.side, target.y), pendingAction: null };
  }

  // Damage an ally creature to summon (Pampactus #218 "infligez 1 dégât à une invocation
  // alliée pour l'invoquer"): the deferred-summon machinery already placed Pampactus; its
  // APPARITION now deals N to the picked ally creature (a self-inflicted summon cost).
  const dmgAlly = pending.pendingEffects.find((e) => e.type === "DamageAllyToSummon") as { amount: number } | undefined;
  if (dmgAlly) {
    const victim = state.creatures.find((c) => c.currentLife > 0 && sameCoords(c.position, target));
    // Defensive: never let Pampactus pay its summon cost on itself (the pick is chosen while it is
    // off-board, so this cannot happen via the UI, but guard the recursion path regardless).
    if (!victim || victim.instanceId === pending.sourceInstanceId) return { ...state, pendingAction: null };
    const creatures = state.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
    const dofuses = state.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
    const log = [...state.log];
    applyEffects(creatures, dofuses, log, [{ type: "DamageData", Damage: dmgAlly.amount }], {
      casterSide: pending.side, selfInstanceId: pending.sourceInstanceId ?? undefined, targetCell: { ...target },
    });
    const after = resolveDeathsAndWin({ ...state, pendingAction: null }, creatures, dofuses, log, new Set());
    return settleDamageReactions(after, state.log.length, creatures);
  }

  // Dofus revealed by a NÉCROME pick: flip the picked allied Dofus to revealed and
  // grant the second Orbe via the RevealDofus player-state handler.
  const revealDofus = pending.pendingEffects.find((e) => e.type === "RevealDofus");
  if (revealDofus) {
    const after = applyPlayerStateEffect(state, revealDofus, pending.side, target).state;
    // The source's APPARITION was held back until this reveal, fire it now.
    return firePendingApparition({ ...after, pendingAction: null }, pending);
  }

  // Amalia's poupée (and any APPARITION that summons creatures): the player picked
  // a summon cell, place one token there (placement "choose" routes summonOne onto
  // `target`). If the effect summons several (Nomekop's 2 Chachas), re-open the pick
  // for the next one, as long as a free summon cell remains.
  const summonTok = pending.pendingEffects.find((e) => e.type === "SummonToken");
  if (summonTok) {
    const after = applyPlayerStateEffect({ ...state, pendingAction: null }, { ...summonTok, amount: 1 }, pending.side, target).state;
    const remaining = ((summonTok as { amount?: number }).amount ?? 1) - 1;
    if (remaining > 0 && hasAtLeastOneTarget(after, "own_summon_cell", pending.side)) {
      return { ...after, pendingAction: { ...pending, pendingEffects: [{ ...summonTok, amount: remaining }] } };
    }
    return { ...after, pendingAction: null };
  }

  // Trouvaille #1382: collect the chosen cells. The cast cell is already in butinCast.cells; each pick
  // adds one more (picking a cell that is already chosen is ignored). Nothing is placed and no AP is
  // spent until the last cell; then the deferred cost is charged and all the Butins are dropped at
  // once, like a targeting effect.
  if (pending.butinCast) {
    const bc = pending.butinCast;
    if (bc.cells.some((c) => sameCoords(c, target))) return state; // cannot reuse a chosen cell
    const cells = [...bc.cells, target];
    if (cells.length < bc.total) {
      return { ...state, pendingAction: { ...pending, butinCast: { ...bc, cells } } };
    }
    // Final selection, held play (the only path hand plays take now): nothing was committed while
    // picking, so the whole cast is committed in one step through playCard `heldButinCells` (pays AP,
    // discards, logs, places every Butin, fires the ON_PLAY reactions).
    if (pending.heldSpell) {
      const held = getCard(pending.heldSpell.cardId);
      if (!held) return { ...state, pendingAction: null };
      return playCard({ ...state, pendingAction: null }, held, cells[0], { commitHeld: true, heldButinCells: cells });
    }
    // Final selection: charge the cost now, then lay down one Butin per chosen cell.
    const p = state.players[pending.side];
    let result: GameState = { ...state, pendingAction: null, players: { ...state.players, [pending.side]: { ...p, ap: Math.max(0, p.ap - bc.cost) } } };
    for (const cell of cells) {
      result = applyPlayerStateEffect(result, { type: "PlaceButin", count: 1 }, pending.side, cell).state;
    }
    return result;
  }

  // TWO-target swap: `firstTarget` holds the already-picked creature; this
  // click is the second. Swap the stat between them, then clear the pending.
  const swapEff = pending.firstTarget
    ? pending.pendingEffects.find((e) => e.type === "SwapAttack" || e.type === "SwapArmor")
    : undefined;
  if (swapEff && pending.firstTarget) {
    return resolveSwap(state, pending.firstTarget, target, swapEff.type as "SwapAttack" | "SwapArmor");
  }
  if (pending.firstTarget && pending.pendingEffects.some((e) => e.type === "ChangeRow")) {
    return resolveChangeRow(state, pending.firstTarget, target);
  }
  if (pending.firstTarget && pending.pendingEffects.some((e) => e.type === "TeleportToCell")) {
    return resolveTeleportToCell(state, pending.firstTarget, target, pending.side);
  }
  if (pending.firstTarget && pending.pendingEffects.some((e) => e.type === "TeleportToGlyph")) {
    return resolveTeleportToGlyph(state, pending.firstTarget, target, pending.side);
  }
  if (pending.firstTarget && pending.pendingEffects.some((e) => e.type === "SwapTwoDofus")) {
    return resolveSwapTwoDofus(state, pending.firstTarget, target);
  }
  // Punition #189: 1st pick = your Dofus (sacrificed → destroyed), 2nd pick = an enemy Dofus
  // that takes `damage`. Both routed through woundDofus (so a Sinistro/shield reacts, and a
  // Héros Martyr #956 reacts to your sacrificed Dofus). resolveDeathsAndWin settles captures.
  const sacDofus = pending.pendingEffects.find((e) => e.type === "SacrificeDofusForDamage") as { damage?: number } | undefined;
  if (pending.firstTarget && sacDofus) {
    const creatures = state.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
    const dofuses = state.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
    const log = [...state.log];
    const mine = dofuses.find((d) => d.currentLife > 0 && sameCoords(d.position, pending.firstTarget!) && d.owner === pending.side);
    if (mine) { woundDofus(mine, mine.currentLife, log, creatures, dofuses); log.push({ type: "FIGHT_OBJECT_REMOVED", dofusAt: { ...mine.position } }); }
    const foe = dofuses.find((d) => d.currentLife > 0 && sameCoords(d.position, target) && d.owner !== pending.side);
    if (foe && !dofusInvulnerable(foe, creatures)) {
      woundDofus(foe, Math.max(0, (sacDofus.damage ?? 0) | 0), log, creatures, dofuses);
      if (foe.currentLife <= 0) log.push({ type: "FIGHT_OBJECT_REMOVED", dofusAt: { ...foe.position } });
      else log.push({ type: "DAMAGE", targetCell: { ...foe.position }, damage: Math.max(0, (sacDofus.damage ?? 0) | 0) });
    }
    const after = resolveDeathsAndWin({ ...state, creatures, dofuses, log, pendingAction: null }, creatures, dofuses, log, new Set());
    return settleDamageReactions(after, state.log.length, creatures);
  }
  if (pending.firstTarget && pending.pendingEffects.some((e) => e.type === "ProtectDofus")) {
    // Lien de Sang #1495: link the picked ally creature (firstTarget) to the picked
    // allied Dofus (target), that Dofus's damage is then redirected onto the creature
    // (redirectDofusDamage), for as long as the creature is alive.
    const guard = creatureAt(state, pending.firstTarget);
    if (!guard) return { ...state, pendingAction: null };
    return {
      ...state,
      dofuses: state.dofuses.map((d) => (sameCoords(d.position, target) ? { ...d, protectedBy: guard.instanceId } : d)),
      pendingAction: null,
    };
  }
  if (pending.firstTarget && pending.pendingEffects.some((e) => e.type === "SacrificeForDamage")) {
    // Sacrifice #576: the 1st pick (firstTarget) is the sacrificed ally; deal its current AT
    // to the 2nd pick (target, another creature), then the sacrificed creature dies (MORT fires
    // via resolveDeathsAndWin). Damage is dealt before the sacrifice so it reads the live AT.
    const victim = creatureAt(state, pending.firstTarget);
    if (!victim) return { ...state, pendingAction: null };
    const dmg = victim.currentAttack;
    const creatures = state.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
    const dofuses = state.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
    const log = [...state.log];
    // "à une AUTRE invocation", never the sacrificed creature itself (engine-level guard; the UI
    // already excludes firstTarget from validPendingTargets, this defends the resolve path too).
    const dmgTarget = creatures.find((c) => c.currentLife > 0 && c.instanceId !== victim.instanceId && sameCoords(c.position, target));
    if (dmgTarget && dmg > 0) {
      applyEffects(creatures, dofuses, log, [{ type: "DamageData", Damage: dmg }], { casterSide: state.activeSide, targetCell: { ...target } });
    }
    const victimNow = creatures.find((c) => c.instanceId === victim.instanceId);
    if (victimNow) victimNow.currentLife = 0; // sacrifice
    const after = resolveDeathsAndWin({ ...state, pendingAction: null }, creatures, dofuses, log, new Set());
    return settleDamageReactions(after, state.log.length, creatures);
  }
  if (pending.firstTarget && pending.pendingEffects.some((e) => e.type === "LameEmoussee")) {
    // Lame Émoussée #1177: deal `self` to the 1st pick (ally) and `enemy` to the 2nd pick (a
    // wounded enemy, validated by the wounded_enemy_creature filter). Both via the canonical
    // spell-damage path (armour/résistance/bodyguard honoured); deaths/win settled afterwards.
    const eff = pending.pendingEffects.find((e) => e.type === "LameEmoussee") as { self: number; enemy: number };
    const creatures = state.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
    const dofuses = state.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
    const log = [...state.log];
    applyEffects(creatures, dofuses, log, [{ type: "DamageData", Damage: eff.self }], { casterSide: state.activeSide, targetCell: { ...pending.firstTarget } });
    applyEffects(creatures, dofuses, log, [{ type: "DamageData", Damage: eff.enemy }], { casterSide: state.activeSide, targetCell: { ...target } });
    const after = resolveDeathsAndWin({ ...state, pendingAction: null }, creatures, dofuses, log, new Set());
    return settleDamageReactions(after, state.log.length, creatures);
  }
  if (pending.firstTarget && pending.pendingEffects.some((e) => e.type === "DestroyArmorForDamage")) {
    // Pluie de Météorites #1350: destroy the 1st pick (ally)'s armour, deal that amount to the
    // 2nd pick (another creature), then draw. (Cost + draw happen regardless, see the decline path.)
    const eff = pending.pendingEffects.find((e) => e.type === "DestroyArmorForDamage") as { draw?: number };
    const ally = creatureAt(state, pending.firstTarget);
    if (!ally) return { ...state, pendingAction: null };
    const amount = ally.armor;
    const creatures = state.creatures.map((c) => ({ ...c, position: { ...c.position }, properties: new Set(c.properties) }));
    const dofuses = state.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
    const log = [...state.log];
    const allyNow = creatures.find((c) => c.instanceId === ally.instanceId);
    if (allyNow && allyNow.armor > 0) {
      log.push({ type: "ARMOR_GAINED", instanceId: allyNow.instanceId, armorMod: { valueBefore: allyNow.armor, modification: -allyNow.armor, valueAfter: 0 } });
      allyNow.armor = 0;
    }
    // "à une AUTRE invocation", never the armour-source ally itself (engine-level guard).
    const dmgTarget = creatures.find((c) => c.currentLife > 0 && c.instanceId !== ally.instanceId && sameCoords(c.position, target));
    if (amount > 0 && dmgTarget) applyEffects(creatures, dofuses, log, [{ type: "DamageData", Damage: amount }], { casterSide: state.activeSide, targetCell: { ...target } });
    let result = resolveDeathsAndWin({ ...state, pendingAction: null }, creatures, dofuses, log, new Set());
    result = settleDamageReactions(result, state.log.length, creatures);
    for (let i = 0; i < (eff.draw ?? 0) && !result.winner; i++) result = drawCard(result, state.activeSide);
    return result;
  }
  if (pending.firstTarget && pending.pendingEffects.some((e) => e.type === "SwapPosition")) {
    return resolveSwapPosition(state, pending.firstTarget, target);
  }
  // Larve Verte #139: the picked creature teleports to a random free adjacent row.
  if (pending.pendingEffects.some((e) => e.type === "MoveAdjacentRowRandom")) {
    const c = creatureAt(state, target);
    if (!c) return { ...state, pendingAction: null };
    return { ...moveToRandomAdjacentRow(state, c.instanceId), pendingAction: null };
  }

  const creatures = state.creatures.map((c) => ({
    ...c,
    position: { ...c.position },
    properties: new Set(c.properties),
  }));
  const dofuses = state.dofuses.map((d) => ({
    ...d,
    position: { ...d.position },
  }));
  const log: GameEvent[] = [...state.log];

  // A resolved pending effect can force a slide (AttractCreature pick, Chacha Tyran #943,
  // or a triggered PushData pick) → it must interact per crossed cell like the spell/advance
  // paths. Build the tracking + slide hook and settle them after the effect runs.
  const slideTracking: AdvanceTracking = {
    brokeThroughIds: new Set<number>(),
    prismCellKeys: new Set(state.prisms.map((p) => `${p.position.x},${p.position.y}`)),
    collectedPrismKeys: new Set<string>(),
    prismPickups: [],
    seedCells: buildSeedCells(state), consumedSeedKeys: new Set<string>(),
    glyphCells: buildGlyphCells(state), consumedGlyphKeys: new Set<string>(),
    tasDOsCells: buildTasDOsCells(state), consumedTasDOsKeys: new Set<string>(),
    bushCells: buildBushCells(state), consumedBushKeys: new Set<string>(),
    butinCells: buildButinCells(state), consumedButinKeys: new Set<string>(), butinPickups: [],
    giftCells: buildGiftCells(state), consumedGiftKeys: new Set<string>(), giftRng: new Rng((state.rng ^ GIFT_ROLL_SALT) | 0), giftRolls: { ally: 0, enemy: 0 },
    trapCells: buildTrapCells(state), consumedTrapKeys: new Set<string>(), trapPickups: [],
  };
  const slideRng = new Rng(state.rng);
  // Justice #130 (targeted APPARITION charge): record the ally's real end-of-turn PM before
  // applyEffects. handleCharge (run inside applyEffects for the "Charge" effect) overwrites
  // movementLeft with the charge distance, which would otherwise become the budget applyChargeOnSummon
  // saves and "restores", taking away the charged ally's fin-de-tour advance for good (a Chef
  // Grouilleux +1 PM looked lost because Justice's charge had already used a PM). The charge is a bonus
  // move, so the ally keeps its full PM. The same for hasAttacked (handleCharge clears it): a target
  // that had summoning sickness before the charge must keep it after its burst. The charge never wakes
  // a new summon (same rule as castSpell's chargeWasSpent).
  const chargePreTarget = pending.pendingEffects.some((e) => e.type === "Charge")
    ? creatures.find((c) => sameCoords(c.position, target) && c.currentLife > 0)
    : undefined;
  const chargeTargetMv0 = chargePreTarget?.movementLeft;
  const chargeTargetSick0 = chargePreTarget?.hasAttacked;
  applyEffects(creatures, dofuses, log, pending.pendingEffects, {
    casterSide: pending.side,
    targetCell: target,
    sourceInstanceId: pending.sourceInstanceId,
    selfInstanceId: pending.sourceInstanceId,
    diceFloor: state.players[pending.side].diceFloor,
    rng: slideRng, // card-defined effects may be random, seeded stream, banked below (déterminisme)
    onSlideStep: makeSlideStep(creatures, log, slideTracking),
  });

  let after = resolveDeathsAndWin(state, creatures, dofuses, log, new Set());
  // Settle any board-object interactions a forced slide produced (no-op when empty).
  after = removeConsumedSeeds(after, slideTracking.consumedSeedKeys);
  after = removeConsumedGlyphs(after, slideTracking.consumedGlyphKeys);
  after = removeConsumedTasDOs(after, slideTracking.consumedTasDOsKeys);
  after = removeConsumedBushes(after, slideTracking.consumedBushKeys);
  after = removeConsumedButins(after, slideTracking.consumedButinKeys);
  after = removeConsumedGifts(after, slideTracking.consumedGiftKeys);
  after = removeConsumedTraps(after, slideTracking.consumedTrapKeys);
  after = applyTrapPickups(after, slideTracking.trapPickups);
  after = applyButinPickups(after, slideTracking.butinPickups, slideRng);
  after = applyGiftRollReactions(after, slideTracking);
  for (const pk of slideTracking.prismPickups) after = activatePrism(after, pk.at, pk.side, pk.props, undefined, pk.byInstanceId);
  after = { ...after, rng: slideRng.state };
  // Justice #130 ("passez à 3 l'AT d'une invocation, ELLE charge de N cases"): after
  // setting the picked creature's attack, that same creature charges N cells right now
  // (full advance/combat/pickups via applyChargeOnSummon, handleCharge only set the budget).
  const chargeEff = pending.pendingEffects.find((e) => e.type === "Charge") as { cells?: number | "toWall" } | undefined;
  if (chargeEff && !after.winner) {
    const tgt = after.creatures.find((c) => sameCoords(c.position, target) && c.currentLife > 0);
    if (tgt) {
      after = applyChargeOnSummon(after, tgt.instanceId, chargeEff.cells === "toWall" ? BOARD_COLS : Math.max(0, (chargeEff.cells ?? 0) | 0));
      // Restore the charged ally's PM from before the charge: the charge is a bonus, it must not take the
      // ally's normal end-of-turn advance. handleCharge had overwritten movementLeft with the charge
      // distance, so applyChargeOnSummon saved the wrong budget; put the real one back on a survivor. Also
      // restore the summoning sickness state from before the charge: a new target (with summoning
      // sickness) keeps it, a ready one keeps its end-of-turn action (same as castSpell's chargeWasSpent).
      if (chargeTargetMv0 !== undefined) {
        after = { ...after, creatures: after.creatures.map((c) => c.instanceId === tgt.instanceId && c.currentLife > 0 ? { ...c, movementLeft: chargeTargetMv0, hasAttacked: chargeTargetSick0 ?? c.hasAttacked } : c) };
      }
    }
  }
  // A resolved targeted effect can deal damage (Black Wabbit's APPARITION, a
  // damage spell's pick…) → CONTRE_COUP reacts to it too.
  after = fireContreCoup(after, state.log.length);
  after = fireDamageReactions(after, state.log.length, undefined, state.creatures); // bystander ON_DAMAGE reactions (roster: react to a killed ally too)
  return { ...after, pendingAction: null };
}

// Marline's "échange de corps": the creatures on `a` (source) and `b` (picked
// enemy) trade both their positions and their owners. Each then becomes
// summoning-sick on its new side this turn (movementLeft 0, hasAttacked), the
// same convention as TakeControl, so a just-swapped creature cannot act until its
// new owner's next turn. Walls cannot be moved → no-op.
function resolveSwapBody(state: GameState, a: Coords, b: Coords): GameState {
  const ca = creatureAt(state, a);
  const cb = creatureAt(state, b);
  if (!ca || !cb || ca.instanceId === cb.instanceId) {
    return { ...state, pendingAction: null };
  }
  // A position-swap relocates both → INAMOVIBLE / Mur cannot be swapped.
  if (isImmovable(ca.properties) || isImmovable(cb.properties)) return { ...state, pendingAction: null };
  const ownerA = ca.owner, ownerB = cb.owner;
  const creatures = state.creatures.map((c) => {
    if (c.instanceId === ca.instanceId) return { ...c, position: { ...b }, owner: ownerB, movementLeft: 0, hasAttacked: true };
    if (c.instanceId === cb.instanceId) return { ...c, position: { ...a }, owner: ownerA, movementLeft: 0, hasAttacked: true };
    return c;
  });
  return {
    ...state,
    creatures,
    log: [
      ...state.log,
      { type: "FIGHT_OBJECT_MOVED", instanceId: ca.instanceId, from: { ...a }, to: { ...b }, movementType: "TELEPORT" },
      { type: "FIGHT_OBJECT_MOVED", instanceId: cb.instanceId, from: { ...b }, to: { ...a }, movementType: "TELEPORT" },
      { type: "SUMMONING_CHANGED_TEAM", instanceId: ca.instanceId, newOwner: ownerB },
      { type: "SUMMONING_CHANGED_TEAM", instanceId: cb.instanceId, newOwner: ownerA },
    ],
    pendingAction: null,
  };
}

// Swap a stat (AT or AR) between the creatures on cells `a` and `b`. For
// attack we swap both currentAttack and baseAttack so the exchange is
// persistent (matching a stat-altering spell); for armour we swap the pools.
// Same cell / missing creature → no-op. Clears the pending action.
function resolveSwap(state: GameState, a: Coords, b: Coords, kind: "SwapAttack" | "SwapArmor" | "SwapMovement"): GameState {
  const ca = creatureAt(state, a);
  const cb = creatureAt(state, b);
  if (!ca || !cb || ca.instanceId === cb.instanceId) {
    return { ...state, pendingAction: null };
  }
  const log: GameEvent[] = [...state.log];
  const creatures = state.creatures.map((c) => {
    if (c.instanceId === ca.instanceId || c.instanceId === cb.instanceId) {
      const other = c.instanceId === ca.instanceId ? cb : ca;
      if (kind === "SwapAttack") {
        log.push({ type: "ATTACK_GAINED", instanceId: c.instanceId, attackMod: { valueBefore: c.currentAttack, modification: other.currentAttack - c.currentAttack, valueAfter: other.currentAttack } });
        return { ...c, currentAttack: other.currentAttack, baseAttack: other.baseAttack };
      }
      if (kind === "SwapMovement") {
        // "Échangez ses PM" (Chacha Sauvage): swap movement points. No dedicated
        // replay event, so the move is reflected by the resulting stats alone.
        return { ...c, baseMovement: other.baseMovement, movementLeft: other.movementLeft };
      }
      log.push({ type: "ARMOR_GAINED", instanceId: c.instanceId, armorMod: { valueBefore: c.armor, modification: other.armor - c.armor, valueAfter: other.armor } });
      return { ...c, armor: other.armor };
    }
    return c;
  });
  return { ...state, creatures, log, pendingAction: null };
}

// "Échange la position de 2 invocations", the two creatures trade cells.
function resolveSwapPosition(state: GameState, a: Coords, b: Coords): GameState {
  const ca = creatureAt(state, a);
  const cb = creatureAt(state, b);
  if (!ca || !cb || ca.instanceId === cb.instanceId) {
    return { ...state, pendingAction: null };
  }
  // A position-swap relocates both → INAMOVIBLE / Mur cannot be swapped.
  if (isImmovable(ca.properties) || isImmovable(cb.properties)) return { ...state, pendingAction: null };
  const creatures = state.creatures.map((c) => {
    if (c.instanceId === ca.instanceId) return { ...c, position: { ...b } };
    if (c.instanceId === cb.instanceId) return { ...c, position: { ...a } };
    return c;
  });
  return {
    ...state,
    creatures,
    log: [
      ...state.log,
      { type: "FIGHT_OBJECT_MOVED", instanceId: ca.instanceId, from: { ...a }, to: { ...b }, movementType: "TELEPORT" },
      { type: "FIGHT_OBJECT_MOVED", instanceId: cb.instanceId, from: { ...b }, to: { ...a }, movementType: "TELEPORT" },
    ],
    pendingAction: null,
  };
}

// "Faites changer de ligne une invocation", relocate the creature on cell
// `from` to the chosen destination `to`. A row change keeps the column (same
// advance distance) and moves to a different, free row. Invalid pick → no-op.
// Teleport a creature to a random free adjacent row (same column, y ± 1). Used by
// Larve Verte #139 (picked creature) and Nainfants #904 (the killer, via targetKiller).
// Nothing moves if neither adjacent cell is on-board and free. Advances state.rng.
function moveToRandomAdjacentRow(state: GameState, instanceId: number): GameState {
  const c = state.creatures.find((cr) => cr.instanceId === instanceId && cr.currentLife > 0);
  if (!c) return state;
  if (isImmovable(c.properties)) return state; // INAMOVIBLE / Mur, a row-change is a relocation, blocked
  const adj = [{ x: c.position.x, y: c.position.y - 1 }, { x: c.position.x, y: c.position.y + 1 }]
    .filter((cell) => cell.y >= 0 && cell.y < BOARD_ROWS && isCellFree(state, cell));
  if (adj.length === 0) return state;
  const roll = new Rng(state.rng);
  const dest = adj[roll.int(adj.length)];
  // The row change is a relocation that picks up the landing cell's object (seed/piège/butin/glyphe/tas
  // d'os/prisme), a full walk-over. The roll used the rng, so roll.state is committed before
  // relocateThenPickup (which advances rng again for any butin reward roll).
  return relocateThenPickup({ ...state, rng: roll.state }, c.instanceId, dest.x, dest.y);
}

// Bluff #61 "échange la position de 2 de vos dofus": swap the cells of the two picked allied Dofus.
// Each Dofus moves to the other slot with all of its own attributes: its kind (real/fake), its colour
// (Dofus Ivoire stays Ivoire, it does not take the colour of the slot it moves to), its currentLife
// and revealed. So the real Dofus really changes row (with its colour); only the position is
// swapped.
function resolveSwapTwoDofus(state: GameState, a: Coords, b: Coords): GameState {
  const da = state.dofuses.find((d) => d.currentLife > 0 && sameCoords(d.position, a));
  const db = state.dofuses.find((d) => d.currentLife > 0 && sameCoords(d.position, b));
  if (!da || !db || sameCoords(a, b)) return { ...state, pendingAction: null };
  const posA = { ...da.position }, posB = { ...db.position };
  return {
    ...state,
    dofuses: state.dofuses.map((d) =>
      sameCoords(d.position, posA) ? { ...d, position: { ...posB } } :
      sameCoords(d.position, posB) ? { ...d, position: { ...posA } } : d),
    pendingAction: null,
  };
}

// Téléglyphe #1735 "téléportez une invocation sur un glyphe allié": move the picked creature onto a
// cell with one of `side`'s Glyphes, then trigger that glyph. A Féca landing on its owner's glyph
// gains +N AR (N = distinct rows with that owner's glyphes), exactly like stepping on it during
// movement.
function resolveTeleportToGlyph(state: GameState, from: Coords, to: Coords, side: Side): GameState {
  const c = creatureAt(state, from);
  const glyph = (state.glyphs ?? []).find((g) => g.owner === side && sameCoords(g.position, to));
  // INAMOVIBLE / Mur, cannot be teleported onto a glyph by an effect.
  if (!c || isImmovable(c.properties) || !glyph || creatureAt(state, to)) return { ...state, pendingAction: null };
  let creatures = state.creatures.map((cr) => (cr.instanceId === c.instanceId ? { ...cr, position: { ...to } } : cr));
  const log: GameEvent[] = [...state.log, { type: "FIGHT_OBJECT_MOVED", instanceId: c.instanceId, from: { ...from }, to: { ...to }, movementType: "TELEPORT" }];
  // Féca glyph trigger: +1 AR per distinct row carrying one of the glyph owner's glyphes.
  if (getCard(c.cardId)?.god === "Feca" && c.owner === glyph.owner) {
    const ar = new Set((state.glyphs ?? []).filter((g) => g.owner === glyph.owner).map((g) => g.position.y)).size;
    if (ar > 0) {
      creatures = creatures.map((cr) => (cr.instanceId === c.instanceId ? { ...cr, armor: cr.armor + ar } : cr));
      log.push({ type: "ARMOR_GAINED", instanceId: c.instanceId, armorMod: { valueBefore: c.armor, modification: ar, valueAfter: c.armor + ar } });
    }
  }
  return { ...state, creatures: withAuras(creatures), log, pendingAction: null };
}

// Téléportation #119 "téléporte une invocation de votre camp sur une case de votre camp": move the
// picked creature onto the picked destination cell, a cell of the caster's own territory with no
// creature/Dofus (board objects allowed: own_cell_no_unit). The creature then picks up whatever
// object is on that landing cell (butin reward, glyphe/tas d'os, seed, piège, prisme), with the same
// walk-over rules as advancing onto it, through the shared applyWalkOverPickups + the same settle
// pass as a charge.
function resolveTeleportToCell(state: GameState, from: Coords, to: Coords, side: Side): GameState {
  const c = creatureAt(state, from);
  // INAMOVIBLE / Mur, cannot be teleported onto a cell by an effect.
  if (!c || isImmovable(c.properties) || !cellMatchesFilter(state, to, "own_cell_no_unit", side)) {
    return { ...state, pendingAction: null };
  }
  const creatures = state.creatures.map((cr) => ({ ...cr, position: { ...cr.position }, properties: new Set(cr.properties) }));
  const dofuses = state.dofuses.map((d) => ({ ...d, position: { ...d.position } }));
  const moved = creatures.find((cr) => cr.instanceId === c.instanceId)!;
  moved.position = { ...to };
  const log: GameEvent[] = [...state.log, { type: "FIGHT_OBJECT_MOVED", instanceId: c.instanceId, from: { ...from }, to: { ...to }, movementType: "TELEPORT" }];
  const tr: AdvanceTracking = {
    brokeThroughIds: new Set<number>(),
    prismCellKeys: new Set(state.prisms.map((p) => `${p.position.x},${p.position.y}`)),
    collectedPrismKeys: new Set<string>(),
    prismPickups: [],
    seedCells: buildSeedCells(state), consumedSeedKeys: new Set<string>(),
    glyphCells: buildGlyphCells(state), consumedGlyphKeys: new Set<string>(),
    tasDOsCells: buildTasDOsCells(state), consumedTasDOsKeys: new Set<string>(),
    bushCells: buildBushCells(state), consumedBushKeys: new Set<string>(),
    butinCells: buildButinCells(state), consumedButinKeys: new Set<string>(), butinPickups: [],
    giftCells: buildGiftCells(state), consumedGiftKeys: new Set<string>(), giftRng: new Rng((state.rng ^ GIFT_ROLL_SALT) | 0), giftRolls: { ally: 0, enemy: 0 },
    trapCells: buildTrapCells(state), consumedTrapKeys: new Set<string>(), trapPickups: [],
  };
  applyWalkOverPickups(moved, to.x, to.y, creatures, log, tr);
  let result = resolveDeathsAndWin({ ...state, creatures, dofuses, log }, creatures, dofuses, log, tr.brokeThroughIds);
  result = removeConsumedSeeds(result, tr.consumedSeedKeys);
  result = removeConsumedGlyphs(result, tr.consumedGlyphKeys);
  result = removeConsumedTasDOs(result, tr.consumedTasDOsKeys);
  result = removeConsumedBushes(result, tr.consumedBushKeys);
  result = removeConsumedButins(result, tr.consumedButinKeys);
  result = removeConsumedGifts(result, tr.consumedGiftKeys);
  result = removeConsumedTraps(result, tr.consumedTrapKeys);
  result = applyTrapPickups(result, tr.trapPickups);
  const rng = new Rng(result.rng);
  result = applyButinPickups(result, tr.butinPickups, rng);
  result = applyGiftRollReactions(result, tr);
  result = { ...result, rng: rng.state };
  for (const pk of tr.prismPickups) result = activatePrism(result, pk.at, pk.side, pk.props, undefined, pk.byInstanceId);
  return { ...result, creatures: withAuras(result.creatures), pendingAction: null };
}

function resolveChangeRow(state: GameState, from: Coords, to: Coords): GameState {
  const c = creatureAt(state, from);
  // Same column, adjacent row only (one step), and the cell must be free. An
  // INAMOVIBLE (Rooted) / Mur (Statue) creature cannot be relocated by the spell.
  const validDest = !!c && !isImmovable(c.properties) && to.x === from.x && Math.abs(to.y - from.y) === 1 && isCellFree(state, to);
  if (!c || !validDest) {
    return { ...state, pendingAction: null };
  }
  // The row change is a relocation that picks up whatever is on the landing cell (prisme/graine/glyphe/
  // butin/piège/tas d'os), with the same walk-over rules as a teleport (#119). relocateThenPickup moves
  // the creature, logs the TELEPORT move, settles the pickup (deaths/prism reactions) and applies auras
  // again; we only clear the pending action afterwards.
  return { ...relocateThenPickup(state, c.instanceId, to.x, to.y), pendingAction: null };
}

// A free cell where `side` may summon a normal creature, the spawn zone (base
// column + Bastion extension via extraSpawnRange) or one of its own Buissons.
// Mirrors the non-wall / non-loot branch of canPlayCard's Summon validation, so
// "des cases où on peut invoquer une créature" (Amalia's poupée) means exactly the
// cells a hand creature could land on.
function canSummonHere(state: GameState, target: Coords, side: Side): boolean {
  // Same single source of truth as canPlayCard, validSpawnCells. With no card it
  // resolves to the spawn zone (+ Bastion) plus the side's own Buissons, free and
  // off the Dofus base cells. Keeps effect-driven summons (Amalia's poupée) in lock
  // step with hand summons and the UI highlight.
  return validSpawnCells(state, side).some((c) => sameCoords(c, target));
}

function cellMatchesFilter(
  state: GameState,
  target: Coords,
  filter: PendingAction["filter"],
  ownerSide: Side,
  maxAttack?: number,
  zone?: "ownCamp",
  minAttack?: number,
  family?: string,
): boolean {
  const c = state.creatures.find(
    (cr) => cr.position.x === target.x && cr.position.y === target.y && cr.currentLife > 0,
  );
  const d = state.dofuses.find(
    (df) => df.position.x === target.x && df.position.y === target.y && df.currentLife > 0,
  );
  // Attack-capped picks (Moskito ≤3 AT): a creature over the cap never matches.
  if (c && maxAttack != null && c.currentAttack > maxAttack) return false;
  // Attack-floor picks (Pissenlion #1045 "ayant au moins N AT"): under the floor never matches.
  if (c && minAttack != null && c.currentAttack < minAttack) return false;
  // Family-restricted picks (Wa Wabbit #59 "un de vos wabbits"): wrong family never matches.
  if (c && family != null && !(famsOf(c)).includes(family)) return false;
  // Zone-restricted picks (Arakne "dans votre camp"): the cell must be in the
  // picker's own territory.
  if (zone === "ownCamp" && !isAlliedTerritory(target.x, ownerSide)) return false;
  // Inciblable (Untargetable): a creature ability cannot pick an untargetable creature, ally or enemy
  // (inciblable protects from both sides, like the canPlayCard spell check). Razortemps' "destroy the
  // untargetable" is a mass AoeDestroy with a property filter, not a pick, so it is not affected. Only
  // blocks creature-targeting filters (a Dofus/cell pick on a cell that happens to hold an untargetable
  // creature is still fine).
  const untargetable = !!c && c.properties.has("Untargetable");
  switch (filter) {
    case "enemy_creature":
      return !!c && c.owner !== ownerSide && !untargetable;
    case "wounded_enemy_creature":
      return !!c && c.owner !== ownerSide && !untargetable && c.currentLife < c.baseLife; // Lame Émoussée #1177
    case "ally_creature":
      return !!c && c.owner === ownerSide && !untargetable;
    case "any_creature":
      return !!c && !untargetable;
    case "any_summon_but_statue":
      // Fulgurance #14 2nd pick (original SecondaryTarget AnySummonButStatue): any
      // creature except a Mur, the original never offers a Statue for the swap.
      return !!c && !untargetable && !c.properties.has("Statue");
    case "any_dofus":
      return !!d;
    case "ally_unrevealed_dofus":
      // A cell carrying one of the picker's own, still-unrevealed Dofus.
      return !!d && d.owner === ownerSide && !d.revealed;
    case "ally_phorreur_or_unrevealed_dofus":
      // Combined NÉCROME+Phorzerker pick: an allied PHORREUR creature (→ fuse) or the picker's own
      // unrevealed Dofus (→ reveal). A cell holds a creature or a Dofus, never both.
      return (!!c && c.owner === ownerSide && !untargetable && (famsOf(c)).includes("Phorreur"))
        || (!!d && d.owner === ownerSide && !d.revealed);
    case "ally_dofus":
      // A cell carrying one of the picker's own living Dofus (Ush #426).
      return !!d && d.currentLife > 0 && d.owner === ownerSide;
    case "ally_dofus_unlinked":
      // Lien de Sang #1495 2nd pick (original SecondaryTarget
      // AlliedDofusWithoutDamageReflection): one of the picker's own living Dofus not
      // already soaked by a living protector, no silent relink over an active bond.
      return !!d && d.currentLife > 0 && d.owner === ownerSide &&
        !(d.protectedBy != null && state.creatures.some((cr) => cr.instanceId === d.protectedBy && cr.currentLife > 0));
    case "ally_dofus_no_equipment":
      // One of the picker's own living Dofus that has no equipment yet (Diod Dewit #337 Sinistro).
      return !!d && d.currentLife > 0 && d.owner === ownerSide && !dofusHasEquipment(d);
    case "ally_glyph":
      // An empty cell carrying one of the picker's own Glyphes (Téléglyphe #1735).
      return (state.glyphs ?? []).some((g) => g.owner === ownerSide && g.position.x === target.x && g.position.y === target.y) && !c;
    case "enemy_dofus":
      // A cell carrying an enemy living Dofus (Ush #13).
      return !!d && d.currentLife > 0 && d.owner !== ownerSide;
    case "destroyed_ally_dofus": {
      // An empty cell of the picker's own Dofus wall column (Ush #100).
      const wall = ownerSide === "ally" ? BOARD_COLS - 1 : 0;
      return target.x === wall && target.y >= 0 && target.y < BOARD_ROWS && !state.dofuses.some((dd) => dd.currentLife > 0 && dd.position.x === target.x && dd.position.y === target.y);
    }
    case "enemy_unrevealed_dofus":
      // A cell carrying an enemy, still-unrevealed Dofus (Kerubim "un dofus adverse").
      return !!d && d.owner !== ownerSide && !d.revealed;
    case "any_cell":
      return true;
    case "own_seed":
      // A cell carrying one of the picker's own planted seeds (and no creature
      // sits there, seeds and creatures never share a cell).
      return (state.seeds ?? []).some((s) => s.position.x === target.x && s.position.y === target.y && s.owner === ownerSide);
    case "own_empty_camp":
      // An empty cell of the picker's own territory (Melita's glyph placement,
      // Chafer Archer #336's Tas d'Os placement): no creature, Dofus, existing
      // glyph, or existing Tas d'Os (board objects that cannot stack on a placed one).
      return isAlliedTerritory(target.x, ownerSide) && !c && !d &&
        !(state.glyphs ?? []).some((g) => g.position.x === target.x && g.position.y === target.y) &&
        !(state.tasDOs ?? []).some((t) => t.position.x === target.x && t.position.y === target.y);
    case "own_cell_no_unit":
      // A cell of the picker's own territory with no creature and no Dofus. Board objects (Butin / Glyphe /
      // Graine / Tas d'os / Trap) are allowed (Téléportation #119 may drop a creature onto an object cell).
      // Different from own_empty_camp, which also rules out glyphs (that one is for placing a Glyphe, which
      // cannot go on top of another).
      return isAlliedTerritory(target.x, ownerSide) && !c && !d;
    case "own_summon_cell":
      // A free cell where the picker could summon a creature (Amalia's poupée).
      return canSummonHere(state, target, ownerSide);
    case "any_prism":
      // A cell carrying a prism (any side), Patek Tag's "Détruisez un prisme".
      return state.prisms.some((p) => p.position.x === target.x && p.position.y === target.y);
    case "ally_prism":
      // A cell carrying one of the PICKER's own prisms, Kibri #735 "Sacrifiez un de vos prismes".
      return state.prisms.some((p) => p.owner === ownerSide && p.position.x === target.x && p.position.y === target.y);
    case "enemy_prism":
      // A cell carrying one of the OPPONENT's prisms, Malocac #85 "Récupérez un prisme adverse".
      return state.prisms.some((p) => p.owner !== ownerSide && p.position.x === target.x && p.position.y === target.y);
    case "own_prismless_first_col": {
      // An empty cell of the picker's first column (x=8 ally / x=1 enemy) whose prism is
      // missing, Lou #572: the prism of that row reappears there.
      const baseX = ownerSide === "ally" ? 8 : 1;
      return target.x === baseX
        && !state.prisms.some((p) => p.owner === ownerSide && p.position.y === target.y)
        && !prismCellOccupied(state, target);
    }
    case "board_object":
      // A cell carrying a Seed/Trap/Butin/Glyphe/Tas d'os/Cadeau de Nowel (any side), Tournesol #1082.
      return [state.seeds, state.traps, state.butins, state.glyphs, state.tasDOs, state.gifts].some((arr) => (arr ?? []).some((o) => o.position.x === target.x && o.position.y === target.y));
  }
}

// Enumerate all cells matching the pending filter, used by the UI to
// highlight legal targets while a pendingAction is active.
export function validPendingTargets(state: GameState): Coords[] {
  const pending = state.pendingAction;
  if (!pending) return [];
  const out: Coords[] = [];
  // ChangeRow: destination = a free cell in the same column, on an adjacent
  // row only (one step up or down, never further).
  if (pending.firstTarget && pending.pendingEffects.some((e) => e.type === "ChangeRow")) {
    const { x: fx, y: fy } = pending.firstTarget;
    for (const y of [fy - 1, fy + 1]) {
      if (y >= 0 && y < BOARD_ROWS && isCellFree(state, { x: fx, y })) out.push({ x: fx, y });
    }
    return out;
  }
  // The source cannot be a target of its own optional creature trigger, but an
  // "any_cell" trigger (Tikoko) can highlight the source's own cell/column.
  const source = state.creatures.find((c) => c.instanceId === pending.sourceInstanceId);
  for (let y = 0; y < BOARD_ROWS; y++) {
    for (let x = 0; x < BOARD_COLS; x++) {
      // For a two-target swap, the second pick cannot be the first creature.
      if (pending.firstTarget && pending.firstTarget.x === x && pending.firstTarget.y === y) continue;
      // Trouvaille butinCast: a cell already chosen for a Butin cannot be re-picked, those
      // cells stay empty until the final placement, so the raw filter would still offer them
      // (re-picking is a no-op that would stall a search; exclude them here).
      if (pending.butinCast && pending.butinCast.cells.some((c) => c.x === x && c.y === y)) continue;
      if (pending.optional && pending.filter !== "any_cell" && source && source.position.x === x && source.position.y === y) continue;
      if (cellMatchesFilter(state, { x, y }, pending.filter, pending.side, pending.maxAttack, pending.zone, pending.minAttack, pending.family)) {
        out.push({ x, y });
      }
    }
  }
  return out;
}
