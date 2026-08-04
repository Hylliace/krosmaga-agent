// Encoder v2. Replaces encode.ts (15 planes / 16 globals / 1 hand vector) with a
// richer state tensor, with a single perspective and fair information, that the
// value/policy net reads. Three invariants checked in CI (encode2.test.ts):
//
// 1. One perspective. Always encoded from `me`'s point of view, with the board
//    mirrored so my base is on the right (x high) and I move toward x=0
//    (me=enemy gives x → BOARD_COLS-1-x). The net learns one perspective.
//
// 2. Fair information, no leak. We only read what `me` can observe: my full
//    board, hand and deck, the opponent's board, public pile sizes and god, all
//    Dofus HP, the real/fake status of my own Dofus. The contents of the
//    opponent's hand and deck are never read: the opponent channel comes from the
//    belief (a posterior built from public information), so shuffling the
//    opponent's hidden cards leaves the encoding bit-identical.
//
// 3. Frozen vocab. The 4 V-vectors are indexed by vocab.json, with a reserved OOV
//    column so an id outside the vocab is counted instead of quietly zeroed.
//
// Layout = [43 planes × 5×10] ++ [91 globals] ++ [4 × vocabSize V-vectors].
// TS only (no Python copy, Python reads the layout).
import type { GameState, PlayerState } from "../engine/state";
import type { Side } from "../engine/board";
import { BOARD_COLS, BOARD_ROWS } from "../engine/board";
import type { God } from "../data/types";
import { DOFUS_LIFE } from "../engine/rules";
import { getCard } from "../engine/cardRegistry";
import type { BeliefState } from "./belief/state";
import { queryHand } from "./belief/state";

// ── Board feature planes (each BOARD_ROWS × BOARD_COLS), in this fixed order. ──
// 6 my-core + 6 foe-core + 10 my-keyword + 10 foe-keyword + 5 dofus + 3 prism + 3 ground = 43.
export const KEYWORDS = [
  "FirstStrike",
  "Shield",
  "Statue",
  "Rooted",
  "Untargetable",
  "Stunned",
  "PierceArmor",
  "Invulnerable",
  "NoSummoningSickness",
  "ProtectsOwnDofus",
] as const;

export const PLANES2 = [
  // my creatures (core)
  "my_creature",
  "my_attack",
  "my_life",
  "my_armor",
  "my_movement",
  "my_ready",
  // foe creatures (core), foe_ready added vs v1
  "foe_creature",
  "foe_attack",
  "foe_life",
  "foe_armor",
  "foe_movement",
  "foe_ready",
  // my keywords (10)
  ...KEYWORDS.map((k) => `my_kw_${k}`),
  // foe keywords (10)
  ...KEYWORDS.map((k) => `foe_kw_${k}`),
  // dofus
  "my_dofus_hp",
  "my_dofus_real", // I know my own
  "my_dofus_fake", // I know my own
  "foe_dofus_hp",
  "foe_dofus_real_belief", // P(this living foe dofus is real), uniform over unrevealed (leak-free)
  // prisms by kind
  "prism_ap",
  "prism_draw",
  "prism_fleau",
  // ground objects (owner-signed: +1 mine / −1 foe)
  "ground_seed",
  "ground_trap",
  "ground_other", // butin / tas d'os / glyphe / buisson
] as const;
export const N_PLANES2 = PLANES2.length; // 43
const PLANE_SIZE = BOARD_ROWS * BOARD_COLS;

// The 10 deck-identity gods, in a fixed order (matches corpus/loader DECK_GODS).
export const ENC_GODS: readonly God[] = [
  "Iop", "Cra", "Eniripsa", "Ecaflip", "Enutrof", "Sram", "Xelor", "Sacrieur", "Feca", "Sadida",
] as const;

// Archetype tag vocabulary (12 weights.json tags + "other"), fixed order.
export const ENC_TAGS = [
  "compétitif", "midrange", "agro", "combo", "contrôle", "tempo",
  "ping", "meule", "défausse", "smorc", "guide", "fun", "other",
] as const;

// ── Global scalars (91), in this fixed order. ──
function buildGlobalNames(): string[] {
  const base16 = [
    "my_ap", "my_max_ap", "my_reserve", "foe_reserve",
    "my_hand_size", "foe_hand_size", "my_deck_size", "foe_deck_size",
    "my_discard_size", "foe_discard_size", "turn", "my_is_first",
    "my_reals_left", "foe_reals_left", "my_spawn_range", "foe_spawn_range",
  ];
  const resource5 = [
    "my_seed_reserve", "foe_seed_reserve",
    "my_hand_min_cost", "my_hand_sum_cost", "my_godcost_reduction",
  ];
  const god20 = [
    ...ENC_GODS.map((g) => `my_god_${g}`),
    ...ENC_GODS.map((g) => `foe_god_${g}`),
  ];
  const myTags13 = ENC_TAGS.map((t) => `my_tag_${t}`);
  const foeTags13 = ENC_TAGS.map((t) => `foe_tag_belief_${t}`);
  const belief4 = ["foe_belief_topmass", "foe_belief_entropy", "foe_hidden_pool", "foe_gen_mass"];
  const lane15 = [
    ...Array.from({ length: BOARD_ROWS }, (_, r) => `my_lane_power_${r}`),
    ...Array.from({ length: BOARD_ROWS }, (_, r) => `foe_lane_power_${r}`),
    ...Array.from({ length: BOARD_ROWS }, (_, r) => `lane_balance_${r}`),
  ];
  const second5 = ["reserved_0", "reserved_1", "reserved_2", "reserved_3", "reserved_4"];
  return [...base16, ...resource5, ...god20, ...myTags13, ...foeTags13, ...belief4, ...lane15, ...second5];
}
export const GLOBALS2 = buildGlobalNames();
export const N_GLOBALS2 = GLOBALS2.length; // 91

const REAL_PER_SIDE = 3;
const N_V = 4; // V-vectors: hand multihot, hand cost, deck remaining, foe belief

/** vocabSize including the reserved OOV column (last index). */
export function vocabSizeOf(cardIndex: Map<number, number>): number {
  return cardIndex.size + 1;
}
/** Total encoding length for a given (OOV-exclusive) vocab index map. */
export function encodingLength2(cardIndex: Map<number, number>): number {
  return N_PLANES2 * PLANE_SIZE + N_GLOBALS2 + N_V * vocabSizeOf(cardIndex);
}
/** Stable id→column map (ascending). The OOV column is `cardIndex.size`. */
export function buildCardIndex2(cardIds: Iterable<number>): Map<number, number> {
  const ids = [...new Set(cardIds)].sort((a, b) => a - b);
  const m = new Map<number, number>();
  ids.forEach((id, i) => m.set(id, i));
  return m;
}

export interface EncodeCtx2 {
  /** Frozen vocab id→column (from vocab.json via buildCardIndex2). */
  cardIndex: Map<number, number>;
  /** Opponent belief. Drives the foe_belief V-vector, the belief globals and the foe
   *  tags. Built from the public state only (buildBeliefFromState), never from the
   *  true opponent hand. */
  belief?: BeliefState | null;
  /** My deck's archetype tags (known, I built my deck). */
  myTags?: readonly string[];
  /** Inferred foe archetype tag probabilities, length ENC_TAGS.length (13). Optional. */
  foeTagBelief?: ArrayLike<number>;
}

export function encode2(state: GameState, me: Side, ctx: EncodeCtx2): Float32Array {
  const foe: Side = me === "ally" ? "enemy" : "ally";
  const vocabSize = vocabSizeOf(ctx.cardIndex);
  const oov = ctx.cardIndex.size; // reserved OOV column
  const out = new Float32Array(encodingLength2(ctx.cardIndex));

  const cx = (x: number) => (me === "ally" ? x : BOARD_COLS - 1 - x);
  const planeIdx = (name: string) => PLANES2.indexOf(name as (typeof PLANES2)[number]);
  const at = (plane: number, y: number, x: number) => plane * PLANE_SIZE + y * BOARD_COLS + x;
  const set = (name: string, y: number, x: number, v: number) => {
    out[at(planeIdx(name), y, x)] = v;
  };

  const myLanePower = new Float64Array(BOARD_ROWS);
  const foeLanePower = new Float64Array(BOARD_ROWS);

  // --- Creatures ---
  for (const c of state.creatures) {
    if (c.currentLife <= 0) continue;
    const x = cx(c.position.x);
    const y = c.position.y;
    const mine = c.owner === me;
    const pre = mine ? "my" : "foe";
    set(`${pre}_creature`, y, x, 1);
    set(`${pre}_attack`, y, x, c.currentAttack / 10);
    set(`${pre}_life`, y, x, c.currentLife / 10);
    set(`${pre}_armor`, y, x, c.armor / 10);
    set(`${pre}_movement`, y, x, c.baseMovement / 6);
    set(`${pre}_ready`, y, x, c.movementLeft > 0 && !c.hasAttacked ? 1 : 0);
    for (const kw of KEYWORDS) if (c.properties.has(kw)) set(`${pre}_kw_${kw}`, y, x, 1);
    const power = c.currentAttack + c.currentLife / 2;
    if (mine) myLanePower[y] += power; else foeLanePower[y] += power;
  }

  // --- Dofus ---
  const foeLivingDofus = state.dofuses.filter((d) => d.owner === foe && d.currentLife > 0);
  const foeRealsRevealedDestroyed = state.dofuses.filter(
    (d) => d.owner === foe && d.kind === "real" && d.currentLife <= 0,
  ).length;
  // Among the foe's still-living Dofus, the (leak-free) uniform posterior that any
  // given one is real: (reals not yet revealed-destroyed) / (living count).
  const foeRealsLiving = Math.max(0, REAL_PER_SIDE - foeRealsRevealedDestroyed);
  const pFoeReal = foeLivingDofus.length > 0 ? foeRealsLiving / foeLivingDofus.length : 0;
  for (const d of state.dofuses) {
    const x = cx(d.position.x);
    const y = d.position.y;
    if (d.owner === me) {
      set("my_dofus_hp", y, x, d.currentLife / DOFUS_LIFE);
      if (d.currentLife > 0) set(d.kind === "real" ? "my_dofus_real" : "my_dofus_fake", y, x, 1);
    } else {
      set("foe_dofus_hp", y, x, d.currentLife / DOFUS_LIFE);
      if (d.currentLife > 0) set("foe_dofus_real_belief", y, x, pFoeReal);
    }
  }

  // --- Prisms (by kind) ---
  for (const p of state.prisms) {
    const name = p.kind === "ap" ? "prism_ap" : p.kind === "draw" ? "prism_draw" : "prism_fleau";
    set(name, p.position.y, cx(p.position.x), 1);
  }

  // --- Ground objects (owner-signed) ---
  const ground = (name: string, y: number, x: number, owner: Side) =>
    set(name, y, cx(x), owner === me ? 1 : -1);
  for (const s of state.seeds ?? []) ground("ground_seed", s.position.y, s.position.x, s.owner);
  for (const t of state.traps ?? []) ground("ground_trap", t.position.y, t.position.x, t.owner);
  for (const o of state.butins ?? []) ground("ground_other", o.position.y, o.position.x, o.owner);
  for (const o of state.tasDOs ?? []) ground("ground_other", o.position.y, o.position.x, o.owner);
  for (const o of state.glyphs ?? []) ground("ground_other", o.position.y, o.position.x, o.owner);
  for (const o of state.bushes ?? []) ground("ground_other", o.position.y, o.position.x, o.owner);

  // --- Globals ---
  const gBase = N_PLANES2 * PLANE_SIZE;
  const g = (name: string, v: number) => {
    out[gBase + GLOBALS2.indexOf(name)] = v;
  };
  const mp = state.players[me];
  const fp = state.players[foe];
  const aliveReals = (s: Side) =>
    state.dofuses.filter((d) => d.owner === s && d.kind === "real" && d.currentLife > 0).length;

  g("my_ap", mp.ap / 10);
  g("my_max_ap", mp.maxAp / 10);
  g("my_reserve", mp.apReserve / 10);
  g("foe_reserve", fp.apReserve / 10);
  g("my_hand_size", mp.hand.length / 10);
  g("foe_hand_size", fp.hand.length / 10);
  g("my_deck_size", mp.deck.length / 30);
  g("foe_deck_size", fp.deck.length / 30);
  g("my_discard_size", mp.discard.length / 30);
  g("foe_discard_size", fp.discard.length / 30);
  g("turn", state.turn / 30);
  g("my_is_first", (state.firstSide ?? (state.mulligan ? state.mulligan.first : state.activeSide)) === me ? 1 : 0);
  g("my_reals_left", aliveReals(me) / REAL_PER_SIDE);
  g("foe_reals_left", foeRealsLiving / REAL_PER_SIDE);
  g("my_spawn_range", mp.extraSpawnRange / 3);
  g("foe_spawn_range", fp.extraSpawnRange / 3);

  // resource5
  g("my_seed_reserve", (mp.seedReserve ?? 0) / 10);
  g("foe_seed_reserve", (fp.seedReserve ?? 0) / 10);
  const handCosts = effectiveHandCosts(mp);
  g("my_hand_min_cost", (handCosts.length ? Math.min(...handCosts) : 0) / 10);
  g("my_hand_sum_cost", handCosts.reduce((a, b) => a + b, 0) / 30);
  g("my_godcost_reduction", totalGodCostReduction(mp) / 10);

  // god one-hot (my god known; foe god public at match start)
  if (mp.god && mp.god !== "None") g(`my_god_${mp.god}`, 1);
  if (fp.god && fp.god !== "None") g(`foe_god_${fp.god}`, 1);

  // my tags (known) / foe tag belief (inferred, optional)
  if (ctx.myTags) {
    const tagSet = new Set(ctx.myTags);
    let matched = false;
    for (const t of ENC_TAGS) if (t !== "other" && tagSet.has(t)) { g(`my_tag_${t}`, 1); matched = true; }
    if (!matched) g("my_tag_other", 1);
  }
  if (ctx.foeTagBelief) {
    for (let i = 0; i < ENC_TAGS.length; i++) g(`foe_tag_belief_${ENC_TAGS[i]}`, ctx.foeTagBelief[i] ?? 0);
  }

  // belief V-vector + belief globals
  const vBase = gBase + N_GLOBALS2;
  const handBase = vBase + 0 * vocabSize;
  const costBase = vBase + 1 * vocabSize;
  const deckBase = vBase + 2 * vocabSize;
  const beliefBase = vBase + 3 * vocabSize;

  const col = (id: number) => ctx.cardIndex.get(id) ?? oov;
  // my hand: multi-hot count + effective-cost
  mp.hand.forEach((id, i) => {
    out[handBase + col(id)] += 1;
    out[costBase + col(id)] += handCosts[i] / 10;
  });
  // my deck-remaining (I know my own deck)
  for (const id of mp.deck) out[deckBase + col(id)] += 1;

  // foe belief: P(card in foe hand) over the corpus universe → vocab columns
  if (ctx.belief) {
    const b = ctx.belief;
    const ph = queryHand(b); // Float64Array over b.corpus.cards
    let topmass = 0, entropy = 0, mass = 0;
    for (let i = 0; i < b.corpus.cards.length; i++) {
      const p = ph[i];
      if (!(p > 0)) continue; // skips 0, negatives, and non-finite (NaN never written)
      out[beliefBase + col(b.corpus.cards[i])] += p;
      if (p > topmass) topmass = p;
      mass += p;
      const q = Math.min(1, p);
      if (q > 0 && q < 1) entropy += -(q * Math.log(q) + (1 - q) * Math.log(1 - q));
    }
    g("foe_belief_topmass", topmass);
    g("foe_belief_entropy", entropy / Math.max(1, b.corpus.cards.length));
    g("foe_hidden_pool", Math.min(1, (b.handSize + b.deckSize) / 45));
    g("foe_gen_mass", b.postGen ?? 0);
  }

  // lane15
  for (let r = 0; r < BOARD_ROWS; r++) {
    const mPow = myLanePower[r] / 30;
    const fPow = foeLanePower[r] / 30;
    g(`my_lane_power_${r}`, mPow);
    g(`foe_lane_power_${r}`, fPow);
    g(`lane_balance_${r}`, Math.max(-1, Math.min(1, (myLanePower[r] - foeLanePower[r]) / 30)));
  }

  return out;
}

function effectiveHandCosts(p: PlayerState): number[] {
  const mods = p.handCostMods ?? [];
  const temp = p.handCostTempMods ?? [];
  const godRed = p.godCostReductions ?? {};
  return p.hand.map((id, i) => {
    const card = getCard(id);
    const base = card?.cost ?? 0;
    const gr = card?.god ? godRed[card.god] ?? 0 : 0;
    return Math.max(0, base + (mods[i] ?? 0) + (temp[i] ?? 0) - gr - (p.nextCardDiscount ?? 0));
  });
}

function totalGodCostReduction(p: PlayerState): number {
  let s = 0;
  for (const v of Object.values(p.godCostReductions ?? {})) s += v;
  return s;
}
