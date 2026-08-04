import { describe, it, expect } from "vitest";
import { scenario, mkCreature } from "../engine/testkit";
import { BOARD_COLS, BOARD_ROWS } from "../engine/board";
import {
  encode,
  encodingLength,
  buildCardIndex,
  PLANES,
  N_PLANES,
  GLOBALS,
} from "./encode";

const PLANE_SIZE = BOARD_ROWS * BOARD_COLS;
const planeAt = (enc: Float32Array, plane: (typeof PLANES)[number], y: number, x: number) =>
  enc[PLANES.indexOf(plane) * PLANE_SIZE + y * BOARD_COLS + x];
const HAND_BASE = N_PLANES * PLANE_SIZE + GLOBALS.length;

const idx = buildCardIndex([101, 205, 300]);

describe("encode (neural-net input)", () => {
  it("produces the documented length", () => {
    const enc = encode(scenario([]), "ally", idx);
    expect(enc.length).toBe(encodingLength(idx.size));
  });

  it("is deterministic", () => {
    const s = scenario([mkCreature(1, "ally", { x: 6, y: 2 }, { currentAttack: 3 })]);
    expect(Array.from(encode(s, "ally", idx))).toEqual(Array.from(encode(s, "ally", idx)));
  });

  it("places a creature in the right plane/cell, oriented per perspective", () => {
    const s = scenario([mkCreature(1, "ally", { x: 7, y: 2 }, { currentAttack: 3, currentLife: 4 })]);
    // From ALLY's view: it is mine, canonical x stays 7.
    const ea = encode(s, "ally", idx);
    expect(planeAt(ea, "my_creature", 2, 7)).toBe(1);
    expect(planeAt(ea, "my_attack", 2, 7)).toBeCloseTo(0.3, 5);
    expect(planeAt(ea, "foe_creature", 2, 7)).toBe(0);
    // From ENEMY's view: the same creature is the foe, mirrored x = 9-7 = 2.
    const ee = encode(s, "enemy", idx);
    expect(planeAt(ee, "foe_creature", 2, BOARD_COLS - 1 - 7)).toBe(1);
    expect(planeAt(ee, "foe_attack", 2, BOARD_COLS - 1 - 7)).toBeCloseTo(0.3, 5);
    expect(planeAt(ee, "my_creature", 2, BOARD_COLS - 1 - 7)).toBe(0);
  });

  it("encodes my hand as a multi-hot count, and never the opponent's", () => {
    let s = scenario([]);
    s = {
      ...s,
      players: {
        ...s.players,
        ally: { ...s.players.ally, hand: [101, 101, 205], handCostMods: [0, 0, 0] },
        enemy: { ...s.players.enemy, hand: [300, 300, 300, 300], handCostMods: [0, 0, 0, 0] },
      },
    };
    const enc = encode(s, "ally", idx);
    expect(enc[HAND_BASE + idx.get(101)!]).toBe(2);
    expect(enc[HAND_BASE + idx.get(205)!]).toBe(1);
    // The opponent holds four #300, but my hand multi-hot must not see them.
    expect(enc[HAND_BASE + idx.get(300)!]).toBe(0);
  });

  it("encodes my own Dofus' real/fake but not the enemy's", () => {
    const s = scenario([]);
    const enc = encode(s, "ally", idx);
    // Exactly 3 of my Dofus cells are flagged real (I know my own).
    let myReals = 0;
    for (let y = 0; y < BOARD_ROWS; y++)
      for (let x = 0; x < BOARD_COLS; x++) myReals += planeAt(enc, "my_dofus_real", y, x);
    expect(myReals).toBe(3);
    // There is no "foe_dofus_real" plane at all, the enemy's nature is hidden.
    expect((PLANES as readonly string[]).includes("foe_dofus_real")).toBe(false);
  });
});
