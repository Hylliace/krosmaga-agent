// Compatibility gate between the encoder and the served model.
//
// PLANES3 comes from the observation registry: each entry added to the registry
// creates two planes and shifts everything after it, so a network trained before
// can no longer read the input. The four entries of the Pandawa god (Saoul / SAOUL /
// Pandawa / Tonneau) took the encoding from 20442 to 20842 columns, and the search
// crashed at its first leaf, for every god. These tests lock the two invariants that
// were missing.
import { describe, it, expect, beforeAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { cards, mkCreature, scenario } from "../../engine/testkit";
import { BOARD_ROWS, BOARD_COLS } from "../../engine/board";
import { buildCardIndex2, encodingLength2 } from "../encode2";
import { encode3, encodingLength3, PLANES3, N_GLOBALS3, N_V3, vocabSizeOf3 } from "../encode3";
import { PLANES3_V1, N_PLANES3_V1 } from "./planesV1";
import { projectToV1, projectToLayout, encodingLengthV1 } from "./legacyLayout";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "../../..");
const PLANE_SIZE = BOARD_ROWS * BOARD_COLS;

let cardIndex: Map<number, number>;
beforeAll(() => {
  cards();
  const vocab = JSON.parse(fs.readFileSync(path.resolve(APP_ROOT, "src/ai/vocab.json"), "utf-8")) as { ids: number[] };
  cardIndex = buildCardIndex2(vocab.ids);
});

describe("frozen V1 layout (the deployed network)", () => {
  it("has 215 planes", () => {
    expect(N_PLANES3_V1).toBe(215);
    expect(PLANES3_V1.length).toBe(215);
  });

  it("gate: the model served to the browser declares a supported layout", () => {
    // This is the test that would have caught the crash: it fails as soon as an
    // entry added to the registry makes the deployed model unreadable.
    const manifestPath = path.resolve(APP_ROOT, "public/ai/value.manifest.json");
    if (!fs.existsSync(manifestPath)) return; // bundle not built, nothing to check
    const man = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as { enc_len: number };
    const supported = [encodingLength3(cardIndex), encodingLengthV1(cardIndex), encodingLength2(cardIndex)];
    expect(supported).toContain(man.enc_len);
  });

  it("the frozen layout matches the served model exactly", () => {
    const manifestPath = path.resolve(APP_ROOT, "public/ai/value.manifest.json");
    if (!fs.existsSync(manifestPath)) return;
    const man = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as { enc_len: number; n_planes?: number };
    if (man.enc_len !== encodingLengthV1(cardIndex)) return; // model already migrated
    expect(man.n_planes).toBe(N_PLANES3_V1);
  });
});

describe("projection onto the training layout", () => {
  function mkState() {
    const a = mkCreature(1, "ally", { x: 6, y: 2 }, { currentAttack: 3, currentLife: 4, baseMovement: 2 });
    const e = mkCreature(2, "enemy", { x: 3, y: 2 }, { currentAttack: 2, currentLife: 5, baseMovement: 2 });
    return scenario([a, e], 757);
  }

  it("length is the one of the frozen layout", () => {
    const x = encode3(mkState(), "ally", { cardIndex, belief: null });
    expect(projectToV1(x, cardIndex).length).toBe(encodingLengthV1(cardIndex));
  });

  it("each plane of the target is copied unchanged, and so is the tail", () => {
    const s = mkState();
    const x = encode3(s, "ally", { cardIndex, belief: null });
    const y = projectToV1(x, cardIndex);
    const srcIdx = new Map(PLANES3.map((n, i) => [n, i]));
    for (let i = 0; i < PLANES3_V1.length; i++) {
      const from = srcIdx.get(PLANES3_V1[i])!;
      const a = Array.from(x.subarray(from * PLANE_SIZE, (from + 1) * PLANE_SIZE));
      const b = Array.from(y.subarray(i * PLANE_SIZE, (i + 1) * PLANE_SIZE));
      expect(b).toEqual(a);
    }
    const vocabSize = vocabSizeOf3(cardIndex);
    const tail = N_GLOBALS3 + N_V3 * vocabSize;
    expect(Array.from(y.subarray(PLANES3_V1.length * PLANE_SIZE))).toEqual(
      Array.from(x.subarray(PLANES3.length * PLANE_SIZE, PLANES3.length * PLANE_SIZE + tail)),
    );
  });

  it("outside Pandawa, the planes added to the registry are zero, so nothing is lost", () => {
    const x = encode3(mkState(), "ally", { cardIndex, belief: null });
    const keep = new Set(PLANES3_V1);
    const srcIdx = new Map(PLANES3.map((n, i) => [n, i]));
    for (const name of PLANES3) {
      if (keep.has(name)) continue;
      const i = srcIdx.get(name)!;
      const bloc = Array.from(x.subarray(i * PLANE_SIZE, (i + 1) * PLANE_SIZE));
      expect(bloc.every((v) => v === 0)).toBe(true);
    }
  });

  it("fails loudly if a plane of the target is missing from the encoder", () => {
    const x = encode3(mkState(), "ally", { cardIndex, belief: null });
    expect(() => projectToLayout(x, ["missing_plane", ...PLANES3_V1], vocabSizeOf3(cardIndex))).toThrow(/missing/);
  });
});
