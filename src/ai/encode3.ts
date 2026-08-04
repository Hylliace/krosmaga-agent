// v3: the encoder with the complete observation, built from a field-by-field
// review of GameState. The contract goes both ways:
//
//   - everything a player can see (or derive with certainty from public events)
//     is in the input: full stats (range/resistance/vulnerability/poison), all 24
//     properties, all 15 trigger types, the 37 families the rules read, card
//     identity (board V-vectors), the contents of both discards, banished piles,
//     both players' AP, Dofus reveals/equipment/protections, every kind of ground
//     object on its own plane, temporary control/stat reversions, dice floors,
//     delivered traps, effective cost per figurine, one-shot spent flags.
//   - nothing hidden leaks: the opponent's hand and deck contents only come in
//     through the belief channel; an unrevealed opponent Dofus keeps the uniform
//     posterior (revealed or destroyed ones switch to exact planes); the order of
//     my own deck and the rng never come in. encode3.test.ts checks both directions.
//
// encode2.ts stays as it is: the deployed value2 model reads the v2 layout. The
// overall structure is the same (planes | globals | V×vocab), so the Python model
// and TsValueModel only need new sizes, not a new architecture.
import type { GameState, PlayerState } from "../engine/state";
import type { Side } from "../engine/board";
import { BOARD_COLS, BOARD_ROWS } from "../engine/board";
import { DOFUS_LIFE, creatureCost } from "../engine/rules";
import { getCard, famsOf } from "../engine/cardRegistry";
import type { BeliefState } from "./belief/state";
import { queryHand } from "./belief/state";
import { PROPERTIES3, TRIGGER_TYPES3, FAMILIES3 } from "./enc/registry3";

// ── Board feature planes (each BOARD_ROWS × BOARD_COLS), in this fixed order. ──
const CORE = ["creature", "attack", "life", "armor", "movement", "movement_left", "ready", "base_attack", "base_life"] as const;
const COMBAT = ["range", "resistance", "vulnerability", "movement_poison"] as const;
const FLAGS = ["silenced", "guarded", "oneshot_spent", "temp_control", "temp_stat", "cost"] as const;

export const PLANES3: readonly string[] = [
  ...CORE.map((n) => `my_${n}`),
  ...CORE.map((n) => `foe_${n}`),
  ...COMBAT.map((n) => `my_${n}`),
  ...COMBAT.map((n) => `foe_${n}`),
  ...FLAGS.map((n) => `my_${n}`),
  ...FLAGS.map((n) => `foe_${n}`),
  ...PROPERTIES3.map((p) => `my_prop_${p}`),
  ...PROPERTIES3.map((p) => `foe_prop_${p}`),
  ...TRIGGER_TYPES3.map((t) => `my_trig_${t}`),
  ...TRIGGER_TYPES3.map((t) => `foe_trig_${t}`),
  ...FAMILIES3.map((f) => `my_fam_${f}`),
  ...FAMILIES3.map((f) => `foe_fam_${f}`),
  // Dofus. my_*: I know my own natures. foe_*: only revealed/destroyed are
  // exact; the rest carry the uniform leak-free posterior.
  "my_dofus_hp", "my_dofus_real", "my_dofus_fake", "my_dofus_revealed",
  "foe_dofus_hp", "foe_dofus_real_belief", "foe_dofus_revealed_real", "foe_dofus_revealed_fake",
  // Shared Dofus overlays (cells are side-disjoint, so one plane serves both).
  "dofus_protected", "dofus_shielded", "dofus_invulnerable", "dofus_invuln_turns",
  "dofus_equip_sinistro", "dofus_equip_necro", "dofus_equip_necro_left",
  // Prisms by kind (owner is positional: they sit on the base columns).
  "prism_ap", "prism_draw", "prism_fleau",
  // Ground objects, one plane per type (a Buisson is a spawn point, a Glyphe a
  // rune, a Butin an open pickup, ground_other erased all of that in v2),
  // owner-signed +1 mine / −1 foe.
  "ground_seed", "ground_trap", "ground_trap_damage", "ground_tasdos",
  "ground_bush", "ground_glyph", "ground_butin",
];
export const N_PLANES3 = PLANES3.length;
const PLANE_SIZE = BOARD_ROWS * BOARD_COLS;
const PLANE_IDX = new Map(PLANES3.map((n, i) => [n, i]));

// The 10 deck-identity gods + archetype tags: unchanged from v2.
export const ENC_GODS3 = [
  "Iop", "Cra", "Eniripsa", "Ecaflip", "Enutrof", "Sram", "Xelor", "Sacrieur", "Feca", "Sadida",
] as const;
export const ENC_TAGS3 = [
  "compétitif", "midrange", "agro", "combo", "contrôle", "tempo",
  "ping", "meule", "défausse", "smorc", "guide", "fun", "other",
] as const;

// ── Global scalars, in this fixed order. ──
function buildGlobalNames(): string[] {
  const base20 = [
    "my_ap", "my_max_ap", "foe_ap", "foe_max_ap",
    "my_reserve", "foe_reserve",
    "my_hand_size", "foe_hand_size", "my_deck_size", "foe_deck_size",
    "my_discard_size", "foe_discard_size", "my_banished_size", "foe_banished_size",
    "turn", "my_is_first",
    "my_reals_left", "foe_reals_left", "my_spawn_range", "foe_spawn_range",
  ];
  const resource6 = [
    "my_seed_reserve", "foe_seed_reserve",
    "my_hand_min_cost", "my_hand_sum_cost",
    "my_godcost_reduction", "foe_godcost_reduction",
  ];
  const status15 = [
    "my_dice_floor", "foe_dice_floor",
    "my_discard_pays_cost", "foe_discard_pays_cost",
    "my_next_discount", "foe_next_discount",
    "my_coin_forced", "foe_coin_forced",
    "foe_temp_surcharge",
    "my_traps_count", "my_traps_min_counter", "my_traps_penalty",
    "foe_traps_count", "foe_traps_min_counter", "foe_traps_penalty",
  ];
  const god20 = [...ENC_GODS3.map((g) => `my_god_${g}`), ...ENC_GODS3.map((g) => `foe_god_${g}`)];
  const myTags13 = ENC_TAGS3.map((t) => `my_tag_${t}`);
  const foeTags13 = ENC_TAGS3.map((t) => `foe_tag_belief_${t}`);
  const belief4 = ["foe_belief_topmass", "foe_belief_entropy", "foe_hidden_pool", "foe_gen_mass"];
  const lane15 = [
    ...Array.from({ length: BOARD_ROWS }, (_, r) => `my_lane_power_${r}`),
    ...Array.from({ length: BOARD_ROWS }, (_, r) => `foe_lane_power_${r}`),
    ...Array.from({ length: BOARD_ROWS }, (_, r) => `lane_balance_${r}`),
  ];
  const reserved5 = ["reserved_0", "reserved_1", "reserved_2", "reserved_3", "reserved_4"];
  return [...base20, ...resource6, ...status15, ...god20, ...myTags13, ...foeTags13, ...belief4, ...lane15, ...reserved5];
}
export const GLOBALS3 = buildGlobalNames();
export const N_GLOBALS3 = GLOBALS3.length;
const GLOBAL_IDX = new Map(GLOBALS3.map((n, i) => [n, i]));

// ── V-vectors (× vocab+OOV), in this fixed order. ──
// hand / hand_cost / deck / deck_costmod are mine (I know them). Discards and
// banished piles are public for both sides. board = card identity of living
// creatures (an identity channel without positions). foe_belief is unchanged.
export const V_NAMES3 = [
  "my_hand", "my_hand_cost", "my_deck", "my_deck_costmod",
  "my_discard", "foe_discard", "my_banished", "foe_banished",
  "my_board", "foe_board", "foe_belief",
] as const;
export const N_V3 = V_NAMES3.length;

const REAL_PER_SIDE = 3;

/** vocabSize including the reserved OOV column (last index). */
export function vocabSizeOf3(cardIndex: Map<number, number>): number {
  return cardIndex.size + 1;
}
export function encodingLength3(cardIndex: Map<number, number>): number {
  return N_PLANES3 * PLANE_SIZE + N_GLOBALS3 + N_V3 * vocabSizeOf3(cardIndex);
}

export interface EncodeCtx3 {
  /** Frozen vocab id→column (same vocab.json / buildCardIndex2 as v2). */
  cardIndex: Map<number, number>;
  /** Opponent belief, built from the public state only. */
  belief?: BeliefState | null;
  /** Oracle test: fill the opponent channels from the true hidden state (opponent
   *  hand and real/fake Dofus) instead of the belief posterior. Only for training:
   *  it measures whether an evaluator with perfect information beats the imperfect
   *  one, i.e. whether the belief is the bottleneck or the position is just hard to
   *  call even with full information. */
  perfectInfo?: boolean;
  /** My deck's archetype tags (known, I built my deck). */
  myTags?: readonly string[];
  /** Inferred foe archetype tag probabilities (13). Optional. */
  foeTagBelief?: ArrayLike<number>;
}

export function encode3(state: GameState, me: Side, ctx: EncodeCtx3): Float32Array {
  const foe: Side = me === "ally" ? "enemy" : "ally";
  const vocabSize = vocabSizeOf3(ctx.cardIndex);
  const oov = ctx.cardIndex.size;
  const out = new Float32Array(encodingLength3(ctx.cardIndex));

  const cx = (x: number) => (me === "ally" ? x : BOARD_COLS - 1 - x);
  const at = (plane: number, y: number, x: number) => plane * PLANE_SIZE + y * BOARD_COLS + x;
  const set = (name: string, y: number, x: number, v: number) => {
    out[at(PLANE_IDX.get(name)!, y, x)] = v;
  };

  const myLanePower = new Float64Array(BOARD_ROWS);
  const foeLanePower = new Float64Array(BOARD_ROWS);

  // Temporary reversions → per-creature bits (public: the granting card's text
  // says "jusqu'à ..." / "tant que ..."). A creature under temp control is not
  // a permanent capture, v2 encoded it as one.
  const tempControl = new Set<number>();
  const tempStat = new Set<number>();
  for (const r of state.pendingReversions ?? []) {
    if (r.kind === "control") tempControl.add(r.instanceId);
    else for (const id of r.instanceIds) tempStat.add(id);
  }
  const living = new Set(state.creatures.filter((c) => c.currentLife > 0).map((c) => c.instanceId));

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
    set(`${pre}_movement_left`, y, x, c.movementLeft / 6);
    set(`${pre}_ready`, y, x, c.movementLeft > 0 && !c.hasAttacked ? 1 : 0);
    set(`${pre}_base_attack`, y, x, c.baseAttack / 10);
    set(`${pre}_base_life`, y, x, c.baseLife / 10);
    set(`${pre}_range`, y, x, c.range / 3);
    set(`${pre}_resistance`, y, x, c.resistance / 5);
    set(`${pre}_vulnerability`, y, x, c.vulnerability / 5);
    set(`${pre}_movement_poison`, y, x, c.movementPoison / 3);
    if (c.silenced) set(`${pre}_silenced`, y, x, 1);
    if (c.protectedByGuard !== undefined && living.has(c.protectedByGuard)) set(`${pre}_guarded`, y, x, 1);
    if (c.strikeSpent) set(`${pre}_oneshot_spent`, y, x, 1);
    if (tempControl.has(c.instanceId)) set(`${pre}_temp_control`, y, x, 1);
    if (tempStat.has(c.instanceId)) set(`${pre}_temp_stat`, y, x, 1);
    set(`${pre}_cost`, y, x, (creatureCost(c) + (c.playedCostMod ?? 0)) / 10);
    for (const p of PROPERTIES3) if (c.properties.has(p)) set(`${pre}_prop_${p}`, y, x, 1);
    // Instance-snapshotted triggers (silence strips them → reflected here).
    for (const t of c.triggers) set(`${pre}_trig_${t.trigger}`, y, x, 1);
    for (const f of famsOf(c)) if (PLANE_IDX.has(`${pre}_fam_${f}`)) set(`${pre}_fam_${f}`, y, x, 1);
    const power = c.currentAttack + c.currentLife / 2;
    if (mine) myLanePower[y] += power;
    else foeLanePower[y] += power;
  }

  // --- Dofus ---
  // Foe posterior over unrevealed living Dofus only: destroyed and alive-revealed
  // natures are public and get exact planes (v2 kept the uniform posterior even
  // after a reveal, the judge "forgot" displayed information).
  const foeDofus = state.dofuses.filter((d) => d.owner === foe);
  const isPublicKind = (d: (typeof foeDofus)[number]) => d.currentLife <= 0 || !!d.revealed;
  const foeKnownReals = foeDofus.filter((d) => isPublicKind(d) && d.kind === "real").length;
  const foeUnrevealedAlive = foeDofus.filter((d) => d.currentLife > 0 && !d.revealed);
  const foeUnknownReals = Math.max(0, REAL_PER_SIDE - foeKnownReals);
  const pFoeReal = foeUnrevealedAlive.length > 0 ? foeUnknownReals / foeUnrevealedAlive.length : 0;
  // Reals the foe still holds = 3 − captured reals. Destruction reveals the
  // nature, so this count is public. (Counting `kind` over living foe Dofus
  // would peek at hidden natures, the leak gate caught exactly that.)
  const foeRealsLeftPublic = REAL_PER_SIDE - foeDofus.filter((d) => d.currentLife <= 0 && d.kind === "real").length;

  for (const d of state.dofuses) {
    const x = cx(d.position.x);
    const y = d.position.y;
    if (d.owner === me) {
      set("my_dofus_hp", y, x, Math.max(0, d.currentLife) / DOFUS_LIFE);
      set(d.kind === "real" ? "my_dofus_real" : "my_dofus_fake", y, x, 1);
      if (d.currentLife <= 0 || d.revealed) set("my_dofus_revealed", y, x, 1);
    } else {
      set("foe_dofus_hp", y, x, Math.max(0, d.currentLife) / DOFUS_LIFE);
      if (isPublicKind(d)) set(d.kind === "real" ? "foe_dofus_revealed_real" : "foe_dofus_revealed_fake", y, x, 1);
      else set("foe_dofus_real_belief", y, x, ctx.perfectInfo ? (d.kind === "real" ? 1 : 0) : pFoeReal);
    }
    if (d.currentLife > 0) {
      if (d.protectedBy !== undefined && living.has(d.protectedBy)) set("dofus_protected", y, x, 1);
      if (d.shielded) set("dofus_shielded", y, x, 1);
      const invulnNow = (d.invulnerableBy !== undefined && living.has(d.invulnerableBy)) || (d.invulnerableTurns ?? 0) > 0;
      if (invulnNow) set("dofus_invulnerable", y, x, 1);
      if ((d.invulnerableTurns ?? 0) > 0) set("dofus_invuln_turns", y, x, (d.invulnerableTurns ?? 0) / 3);
      if (d.sinistroAttached) set("dofus_equip_sinistro", y, x, 1);
      if (d.necronomigoreCounter !== undefined) {
        set("dofus_equip_necro", y, x, 1);
        set("dofus_equip_necro_left", y, x, d.necronomigoreCounter / 6);
      }
    }
  }

  // --- Prisms (by kind; owner is positional) ---
  for (const p of state.prisms) {
    const name = p.kind === "ap" ? "prism_ap" : p.kind === "draw" ? "prism_draw" : "prism_fleau";
    set(name, p.position.y, cx(p.position.x), 1);
  }

  // --- Ground objects (one plane per type, owner-signed) ---
  const ground = (name: string, y: number, x: number, owner: Side, v = 1) =>
    set(name, y, cx(x), owner === me ? v : -v);
  for (const s of state.seeds ?? []) ground("ground_seed", s.position.y, s.position.x, s.owner);
  for (const t of state.traps ?? []) {
    ground("ground_trap", t.position.y, t.position.x, t.owner);
    ground("ground_trap_damage", t.position.y, t.position.x, t.owner, t.damage / 5);
  }
  for (const o of state.tasDOs ?? []) ground("ground_tasdos", o.position.y, o.position.x, o.owner);
  for (const o of state.bushes ?? []) ground("ground_bush", o.position.y, o.position.x, o.owner);
  for (const o of state.glyphs ?? []) ground("ground_glyph", o.position.y, o.position.x, o.owner);
  for (const o of state.butins ?? []) ground("ground_butin", o.position.y, o.position.x, o.owner);

  // --- Globals ---
  const gBase = N_PLANES3 * PLANE_SIZE;
  const g = (name: string, v: number) => {
    out[gBase + GLOBAL_IDX.get(name)!] = v;
  };
  const mp = state.players[me];
  const fp = state.players[foe];
  const myReals = state.dofuses.filter((d) => d.owner === me && d.kind === "real" && d.currentLife > 0).length;

  g("my_ap", mp.ap / 10);
  g("my_max_ap", mp.maxAp / 10);
  g("foe_ap", fp.ap / 10);
  g("foe_max_ap", fp.maxAp / 10);
  g("my_reserve", mp.apReserve / 10);
  g("foe_reserve", fp.apReserve / 10);
  g("my_hand_size", mp.hand.length / 10);
  g("foe_hand_size", fp.hand.length / 10);
  g("my_deck_size", mp.deck.length / 30);
  g("foe_deck_size", fp.deck.length / 30);
  g("my_discard_size", mp.discard.length / 30);
  g("foe_discard_size", fp.discard.length / 30);
  g("my_banished_size", (mp.banished ?? []).length / 30);
  g("foe_banished_size", (fp.banished ?? []).length / 30);
  g("turn", state.turn / 30);
  g("my_is_first", (state.firstSide ?? (state.mulligan ? state.mulligan.first : state.activeSide)) === me ? 1 : 0);
  g("my_reals_left", myReals / REAL_PER_SIDE);
  g("foe_reals_left", foeRealsLeftPublic / REAL_PER_SIDE);
  g("my_spawn_range", mp.extraSpawnRange / 3);
  g("foe_spawn_range", fp.extraSpawnRange / 3);

  g("my_seed_reserve", (mp.seedReserve ?? 0) / 10);
  g("foe_seed_reserve", (fp.seedReserve ?? 0) / 10);
  const handCosts = effectiveHandCosts3(mp);
  g("my_hand_min_cost", (handCosts.length ? Math.min(...handCosts) : 0) / 10);
  g("my_hand_sum_cost", handCosts.reduce((a, b) => a + b, 0) / 30);
  g("my_godcost_reduction", totalGodCostReduction3(mp) / 10);
  g("foe_godcost_reduction", totalGodCostReduction3(fp) / 10);

  g("my_dice_floor", (mp.diceFloor ?? 0) / 6);
  g("foe_dice_floor", (fp.diceFloor ?? 0) / 6);
  g("my_discard_pays_cost", mp.discardPaysCost ? 1 : 0);
  g("foe_discard_pays_cost", fp.discardPaysCost ? 1 : 0);
  g("my_next_discount", (mp.nextCardDiscount ?? 0) / 10);
  g("foe_next_discount", (fp.nextCardDiscount ?? 0) / 10);
  g("my_coin_forced", mp.coinForcedPile ? 1 : 0);
  g("foe_coin_forced", fp.coinForcedPile ? 1 : 0);
  // The opponent has to be seen as cost-modified. The Ralentissement surcharge window
  // is public (cast and expiry rule); its size is given by the card text.
  g("foe_temp_surcharge", Math.max(0, ...(fp.handCostTempMods ?? [0])) / 10);
  const trapStats = (p: PlayerState) => {
    const traps = p.activeTraps ?? [];
    return {
      count: traps.length / 3,
      minCounter: traps.length ? Math.min(...traps.map((t) => t.counter)) / 3 : 0,
      penalty: traps.length ? Math.max(...traps.map((t) => t.penalty)) / 5 : 0,
    };
  };
  const mt = trapStats(mp);
  const ft = trapStats(fp);
  g("my_traps_count", mt.count);
  g("my_traps_min_counter", mt.minCounter);
  g("my_traps_penalty", mt.penalty);
  g("foe_traps_count", ft.count);
  g("foe_traps_min_counter", ft.minCounter);
  g("foe_traps_penalty", ft.penalty);

  if (mp.god && mp.god !== "None" && GLOBAL_IDX.has(`my_god_${mp.god}`)) g(`my_god_${mp.god}`, 1);
  if (fp.god && fp.god !== "None" && GLOBAL_IDX.has(`foe_god_${fp.god}`)) g(`foe_god_${fp.god}`, 1);

  if (ctx.myTags) {
    const tagSet = new Set(ctx.myTags);
    let matched = false;
    for (const t of ENC_TAGS3) {
      if (t !== "other" && tagSet.has(t)) {
        g(`my_tag_${t}`, 1);
        matched = true;
      }
    }
    if (!matched) g("my_tag_other", 1);
  }
  if (ctx.foeTagBelief) {
    for (let i = 0; i < ENC_TAGS3.length; i++) g(`foe_tag_belief_${ENC_TAGS3[i]}`, ctx.foeTagBelief[i] ?? 0);
  }

  // --- V-vectors ---
  const vBase = gBase + N_GLOBALS3;
  const vAt = (v: number) => vBase + v * vocabSize;
  const col = (id: number) => ctx.cardIndex.get(id) ?? oov;
  const V = Object.fromEntries(V_NAMES3.map((n, i) => [n, vAt(i)])) as Record<(typeof V_NAMES3)[number], number>;

  mp.hand.forEach((id, i) => {
    out[V.my_hand + col(id)] += 1;
    out[V.my_hand_cost + col(id)] += handCosts[i] / 10;
  });
  mp.deck.forEach((id, i) => {
    out[V.my_deck + col(id)] += 1;
    out[V.my_deck_costmod + col(id)] += (mp.deckCostMods?.[i] ?? 0) / 10;
  });
  for (const id of mp.discard) out[V.my_discard + col(id)] += 1;
  for (const id of fp.discard) out[V.foe_discard + col(id)] += 1;
  for (const id of mp.banished ?? []) out[V.my_banished + col(id)] += 1;
  for (const id of fp.banished ?? []) out[V.foe_banished + col(id)] += 1;
  for (const c of state.creatures) {
    if (c.currentLife <= 0) continue;
    out[(c.owner === me ? V.my_board : V.foe_board) + col(c.cardId)] += 1;
  }

  if (ctx.perfectInfo) {
    // Oracle: encode the true foe hand (exact counts) into the belief channel,
    // as a degenerate posterior (topmass 1, entropy 0).
    const foeHand = state.players[foe].hand;
    for (const id of foeHand) out[V.foe_belief + col(id)] += 1;
    g("foe_belief_topmass", foeHand.length > 0 ? 1 : 0);
    g("foe_belief_entropy", 0);
    g("foe_hidden_pool", Math.min(1, (foeHand.length + state.players[foe].deck.length) / 45));
    g("foe_gen_mass", 0);
  } else if (ctx.belief) {
    const b = ctx.belief;
    const ph = queryHand(b);
    let topmass = 0,
      entropy = 0;
    for (let i = 0; i < b.corpus.cards.length; i++) {
      const p = ph[i];
      if (!(p > 0)) continue;
      out[V.foe_belief + col(b.corpus.cards[i])] += p;
      if (p > topmass) topmass = p;
      const q = Math.min(1, p);
      if (q > 0 && q < 1) entropy += -(q * Math.log(q) + (1 - q) * Math.log(1 - q));
    }
    g("foe_belief_topmass", topmass);
    g("foe_belief_entropy", entropy / Math.max(1, b.corpus.cards.length));
    g("foe_hidden_pool", Math.min(1, (b.handSize + b.deckSize) / 45));
    g("foe_gen_mass", b.postGen ?? 0);
  }

  for (let r = 0; r < BOARD_ROWS; r++) {
    g(`my_lane_power_${r}`, myLanePower[r] / 30);
    g(`foe_lane_power_${r}`, foeLanePower[r] / 30);
    g(`lane_balance_${r}`, Math.max(-1, Math.min(1, (myLanePower[r] - foeLanePower[r]) / 30)));
  }

  return out;
}

function effectiveHandCosts3(p: PlayerState): number[] {
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

function totalGodCostReduction3(p: PlayerState): number {
  let s = 0;
  for (const v of Object.values(p.godCostReductions ?? {})) s += v;
  return s;
}
