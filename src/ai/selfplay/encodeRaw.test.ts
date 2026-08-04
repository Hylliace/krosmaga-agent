// Re-encode check. Tests that a raw game re-encodes into end-of-turn value samples
// of the right shape, that re-encoding is deterministic, and that the drop rules
// (draws and replay mismatch) work.
import { describe, it, expect, beforeAll } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { cards } from "../../engine/testkit";
import { loadCorpus, type DeckEntry } from "../corpus/loader";
import { buildCorpusBelief } from "../belief/corpus";
import { HeuristicAgent } from "../agents/HeuristicAgent";
import { recordGameRaw, type RawGame, type RawMatchup } from "./recordRaw";
import { buildCardIndex2, encodingLength2 } from "../encode2";
import { encodingLength3, GLOBALS3, N_PLANES3, ENC_TAGS3 } from "../encode3";
import { BOARD_ROWS, BOARD_COLS } from "../../engine/board";
import { encodeRawGame } from "./encodeRaw";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "../../..");
const DECKS = path.resolve(APP_ROOT, "decks-corpus/decks.json");
const WEIGHTS = path.resolve(APP_ROOT, "decks-corpus/weights.json");

let cardIndex: Map<number, number>;
let corpusMap: ReturnType<typeof buildCorpusBelief>;
let decisive: RawGame;

beforeAll(() => {
  const pool = cards();
  cardIndex = buildCardIndex2([...pool.keys()]);
  const { decks } = loadCorpus(DECKS, WEIGHTS, { isKnownCard: (id) => pool.has(id) });
  corpusMap = buildCorpusBelief(decks);

  // Two decks of different gods → a representative match-up.
  const byGod = (g: string): DeckEntry => decks.find((d) => d.god === g)!;
  const a = byGod("Iop") ?? decks[0];
  const e = byGod("Cra") ?? decks[1];
  const mu: RawMatchup = {
    a: { id: a.deckId, god: a.god, author: a.author, tags: a.tags },
    e: { id: e.deckId, god: e.god, author: e.author, tags: e.tags },
  };
  // Record until a decisive (non-draw, non-stuck) game.
  for (let seed = 1; seed <= 40 && !decisive; seed++) {
    const g = recordGameRaw(new HeuristicAgent(), new HeuristicAgent(), {
      decks: { ally: a.cards, enemy: e.cards }, seed, firstSide: "ally",
      gods: { ally: a.god, enemy: e.god }, mu,
    });
    if (g && g.res.w !== 0) decisive = g;
  }
}, 60_000);

describe("encodeRawGame re-encode", () => {
  it("produces fin-de-tour samples of the right length, labels ∈ {±1}", () => {
    const r = encodeRawGame(decisive, { cardIndex, corpusMap });
    expect(r.dropped).toBeNull();
    expect(r.samples.length).toBeGreaterThan(0);
    const encLen = encodingLength2(cardIndex);
    for (const s of r.samples) {
      expect(s.x.length).toBe(encLen);
      expect(Math.abs(s.y)).toBe(1);
      // The mover's perspective: y=+1 iff that side is the eventual winner.
      const winnerSide = decisive.res.w === 1 ? "ally" : "enemy";
      expect(s.y).toBe(s.mover === winnerSide ? 1 : -1);
    }
  });

  it("is deterministic: re-encoding yields identical rows", () => {
    const a = encodeRawGame(decisive, { cardIndex, corpusMap });
    const b = encodeRawGame(decisive, { cardIndex, corpusMap });
    expect(b.samples.length).toBe(a.samples.length);
    for (let i = 0; i < a.samples.length; i++)
      expect(Array.from(b.samples[i].x)).toEqual(Array.from(a.samples[i].x));
  });

  it("drops draws and replay mismatches", () => {
    expect(encodeRawGame({ ...decisive, res: { ...decisive.res, w: 0 } }, { cardIndex, corpusMap }).dropped).toBe("draw");
    // Tamper the stored turn count → replay disagrees → whole game dropped.
    const tampered: RawGame = { ...decisive, res: { ...decisive.res, turns: decisive.res.turns + 7 } };
    expect(encodeRawGame(tampered, { cardIndex, corpusMap }).dropped).toBe("result-mismatch");
  });

  it("v3: right length + my_tag_* stay zero (train/inference parity, netLeaf never has tags)", () => {
    const r = encodeRawGame(decisive, { cardIndex, corpusMap, encoder: "v3" });
    expect(r.dropped).toBeNull();
    expect(r.samples.length).toBeGreaterThan(0);
    const encLen3 = encodingLength3(cardIndex);
    const gBase = N_PLANES3 * BOARD_ROWS * BOARD_COLS;
    // Includes my_tag_other: with tags supplied, encode3 always sets one of these.
    const tagIdx = ENC_TAGS3.map((t) => {
      const i = GLOBALS3.indexOf(`my_tag_${t}`);
      expect(i).toBeGreaterThanOrEqual(0);
      return gBase + i;
    });
    for (const s of r.samples) {
      expect(s.x.length).toBe(encLen3);
      for (const i of tagIdx) expect(s.x[i]).toBe(0);
    }
  });

  it("foe_belief channel is zero without a corpus map, populated with one", () => {
    const withBelief = encodeRawGame(decisive, { cardIndex, corpusMap });
    const noBelief = encodeRawGame(decisive, { cardIndex });
    const vocabSize = cardIndex.size + 1;
    const encLen = encodingLength2(cardIndex);
    const beliefBase = encLen - vocabSize; // foe_belief is the last V-vector
    const mass = (x: Float32Array) => { let m = 0; for (let i = beliefBase; i < encLen; i++) m += x[i]; return m; };
    expect(mass(noBelief.samples[0].x)).toBe(0);
    // At least one sampled board has a non-empty foe belief.
    expect(withBelief.samples.some((s) => mass(s.x) > 0)).toBe(true);
  });
});
