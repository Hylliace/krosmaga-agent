// Encode a GameState into a flat Float32Array, the input the neural net reads.
// This file is the reference: the Python training side follows this exact layout,
// so any change here has to change both.
//
// Two design choices that matter:
//
// 1. One perspective. We always encode from the point of view of the side being
//    evaluated, `me`, and orient the board so `me`'s base is on the right (x high)
//    and `me` moves toward x=0, like the ally. When me=enemy we mirror
//    x → BOARD_COLS-1-x. So the net learns one perspective ("my stuff vs their
//    stuff") instead of two, which roughly halves what it has to learn.
//
// 2. Fair information. We only encode what `me` can really observe: my full
//    board/hand, the opponent's board and hand size, both discard sizes, all Dofus
//    HP, the real/fake status of my own Dofus (never the opponent's). The contents
//    of the opponent's hand are not encoded (hidden).
import type { GameState } from "../engine/state";
import type { Side } from "../engine/board";
import { BOARD_COLS, BOARD_ROWS } from "../engine/board";
import { DOFUS_LIFE } from "../engine/rules";

// --- Board feature planes (each is BOARD_ROWS × BOARD_COLS), in this order. ---
export const PLANES = [
  "my_creature", // 1 if one of my creatures is here
  "my_attack", // its attack / 10
  "my_life", // its life / 10
  "my_armor", // its armor / 10
  "my_movement", // its PM / 6
  "my_ready", // 1 if it can still move this turn (not summoning-sick / not spent)
  "foe_creature",
  "foe_attack",
  "foe_life",
  "foe_armor",
  "foe_movement",
  "my_dofus_hp", // my Dofus HP / DOFUS_LIFE (on my base column)
  "my_dofus_real", // 1 if my Dofus here is real (I know my own)
  "foe_dofus_hp", // enemy Dofus HP / DOFUS_LIFE (real/fake hidden → not encoded)
  "prism", // 1 if a prism sits here
] as const;
export const N_PLANES = PLANES.length;
const PLANE_SIZE = BOARD_ROWS * BOARD_COLS;

// --- Global scalar features (not spatial), in this order. ---
export const GLOBALS = [
  "my_ap",
  "my_max_ap",
  "my_reserve",
  "foe_reserve",
  "my_hand_size",
  "foe_hand_size",
  "my_deck_size",
  "foe_deck_size",
  "my_discard_size",
  "foe_discard_size",
  "turn",
  "my_is_first",
  "my_reals_left", // reals of mine still alive / 3
  "foe_reals_left", // enemy reals not yet revealed-destroyed / 3
  "my_spawn_range",
  "foe_spawn_range",
] as const;
export const N_GLOBALS = GLOBALS.length;

const REAL_PER_SIDE = 3;

/** Total encoding length given the card-vocabulary size (the hand multi-hot). */
export function encodingLength(vocabSize: number): number {
  return N_PLANES * PLANE_SIZE + N_GLOBALS + vocabSize;
}

/** Stable card-id → index map for the hand multi-hot. Build once from the pool
 *  (sorted by id so TS and Python agree on the ordering). */
export function buildCardIndex(cardIds: Iterable<number>): Map<number, number> {
  const ids = [...new Set(cardIds)].sort((a, b) => a - b);
  const m = new Map<number, number>();
  ids.forEach((id, i) => m.set(id, i));
  return m;
}

export function encode(state: GameState, me: Side, cardIndex: Map<number, number>): Float32Array {
  const foe: Side = me === "ally" ? "enemy" : "ally";
  const out = new Float32Array(encodingLength(cardIndex.size));

  // Canonical x: my base on the right, advancing toward x=0.
  const cx = (x: number) => (me === "ally" ? x : BOARD_COLS - 1 - x);
  const at = (plane: number, y: number, x: number) => plane * PLANE_SIZE + y * BOARD_COLS + x;
  const set = (planeName: (typeof PLANES)[number], y: number, x: number, v: number) => {
    out[at(PLANES.indexOf(planeName), y, x)] = v;
  };

  // --- Creatures ---
  for (const c of state.creatures) {
    if (c.currentLife <= 0) continue;
    const x = cx(c.position.x);
    const y = c.position.y;
    if (c.owner === me) {
      set("my_creature", y, x, 1);
      set("my_attack", y, x, c.currentAttack / 10);
      set("my_life", y, x, c.currentLife / 10);
      set("my_armor", y, x, c.armor / 10);
      set("my_movement", y, x, c.baseMovement / 6);
      set("my_ready", y, x, c.movementLeft > 0 ? 1 : 0);
    } else {
      set("foe_creature", y, x, 1);
      set("foe_attack", y, x, c.currentAttack / 10);
      set("foe_life", y, x, c.currentLife / 10);
      set("foe_armor", y, x, c.armor / 10);
      set("foe_movement", y, x, c.baseMovement / 6);
    }
  }

  // --- Dofus ---
  for (const d of state.dofuses) {
    const x = cx(d.position.x);
    const y = d.position.y;
    if (d.owner === me) {
      set("my_dofus_hp", y, x, d.currentLife / DOFUS_LIFE);
      // I know my own real/fake (only meaningful while alive).
      set("my_dofus_real", y, x, d.kind === "real" && d.currentLife > 0 ? 1 : 0);
    } else {
      // Enemy Dofus: HP is visible, real/fake is hidden (never encoded).
      set("foe_dofus_hp", y, x, d.currentLife / DOFUS_LIFE);
    }
  }

  // --- Prisms ---
  for (const p of state.prisms) {
    set("prism", p.position.y, cx(p.position.x), 1);
  }

  // --- Globals ---
  const g = (name: (typeof GLOBALS)[number], v: number) => {
    out[N_PLANES * PLANE_SIZE + GLOBALS.indexOf(name)] = v;
  };
  const mp = state.players[me];
  const fp = state.players[foe];
  const aliveReals = (s: Side) =>
    state.dofuses.filter((d) => d.owner === s && d.kind === "real" && d.currentLife > 0).length;
  const foeRealsDestroyed = state.dofuses.filter(
    (d) => d.owner === foe && d.kind === "real" && d.currentLife <= 0,
  ).length;
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
  // What I legitimately know about the enemy: how many of their reals I have not
  // yet destroyed (revealed). The hidden part is which ones.
  g("foe_reals_left", (REAL_PER_SIDE - foeRealsDestroyed) / REAL_PER_SIDE);
  g("my_spawn_range", mp.extraSpawnRange / 3);
  g("foe_spawn_range", fp.extraSpawnRange / 3);

  // --- My hand (multi-hot count over the card vocabulary). ---
  const handBase = N_PLANES * PLANE_SIZE + N_GLOBALS;
  for (const id of mp.hand) {
    const idx = cardIndex.get(id);
    if (idx !== undefined) out[handBase + idx] += 1;
  }

  return out;
}
