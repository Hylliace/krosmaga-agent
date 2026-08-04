// Encoder v2 CI check. Tests the three invariants it relies on:
//   (1) the length matches encodingLength2 (planes + globals + 4 V-vectors),
//   (2) fair information: shuffling the contents of the opponent's hidden hand and
//       deck leaves the encoding bit-identical (the opponent channel is the public
//       belief, and the encoder never reads the opponent's hand/deck contents,
//       only their sizes),
//   (3) one perspective: encoding a state from me=enemy equals encoding the
//       x-mirrored state from me=ally.
import { describe, it, expect, beforeAll } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { cards } from "../engine/testkit";
import { createInitialState } from "../engine/rules";
import type { GameState } from "../engine/state";
import { BOARD_COLS } from "../engine/board";
import { loadCorpus } from "./corpus/loader";
import { buildCorpusBelief } from "./belief/corpus";
import { buildBeliefFromState } from "./belief/determinizeBelief";
import { mkCreature } from "../engine/testkit";
import {
  encode2,
  encodingLength2,
  buildCardIndex2,
  N_PLANES2,
  N_GLOBALS2,
  type EncodeCtx2,
} from "./encode2";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "../..");
const DECKS = path.resolve(APP_ROOT, "decks-corpus/decks.json");
const WEIGHTS = path.resolve(APP_ROOT, "decks-corpus/weights.json");

let cardIndex: Map<number, number>;
let corpusMap: Map<string, ReturnType<typeof buildCorpusBelief> extends Map<infer _, infer V> ? V : never>;

beforeAll(() => {
  cards(); // register the real pool so getCard/isToken work
  const ids = [...cards().keys()];
  cardIndex = buildCardIndex2(ids);
  const { decks } = loadCorpus(DECKS, WEIGHTS, { isKnownCard: (id) => cards().has(id) });
  corpusMap = buildCorpusBelief(decks) as typeof corpusMap;
});

// A representative mid-match state: my god Iop, foe god Cra, creatures, prisms,
// hands+decks both sides, foe discard (public, drives the belief).
function makeState(): GameState {
  const s = createInitialState({ ally: [], enemy: [] });
  const foeDiscard = [...corpusGodIds("Cra")].slice(0, 4);
  const myHand = [...corpusGodIds("Iop")].slice(0, 5);
  const myDeck = [...corpusGodIds("Iop")].slice(5, 25);
  const foeHand = [...corpusGodIds("Cra")].slice(4, 9);
  const foeDeck = [...corpusGodIds("Cra")].slice(9, 29);
  return {
    ...s,
    mulligan: null,
    turn: 6,
    activeSide: "ally",
    firstSide: "ally",
    creatures: [
      mkCreature(1, "ally", { x: 8, y: 2 }, { currentAttack: 3, currentLife: 4, movementLeft: 2, properties: new Set(["FirstStrike"]) }),
      mkCreature(2, "enemy", { x: 1, y: 1 }, { currentAttack: 5, currentLife: 2, properties: new Set(["Shield", "Untargetable"]) }),
    ],
    prisms: [
      { position: { x: 8, y: 0 }, owner: "ally", kind: "ap" },
      { position: { x: 1, y: 3 }, owner: "enemy", kind: "fleau" },
    ],
    players: {
      ...s.players,
      ally: { ...s.players.ally, god: "Iop", hand: myHand, handCostMods: myHand.map(() => 0), deck: myDeck, ap: 4, maxAp: 6 },
      enemy: { ...s.players.enemy, god: "Cra", hand: foeHand, handCostMods: foeHand.map(() => 0), deck: foeDeck, discard: foeDiscard },
    },
  };
}

function corpusGodIds(god: string): number[] {
  const cb = corpusMap.get(god as never);
  return cb ? [...cb.cards] : [];
}

function ctxFor(state: GameState): EncodeCtx2 {
  const belief = buildBeliefFromState(state, "ally", corpusMap as never);
  return { cardIndex, belief, myTags: ["agro"], foeTagBelief: new Float32Array(13).fill(0.1) };
}

describe("encode2 encoder", () => {
  it("output length matches encodingLength2", () => {
    const s = makeState();
    const v = encode2(s, "ally", ctxFor(s));
    expect(v.length).toBe(encodingLength2(cardIndex));
    // sanity: planes + globals + 4 V-vectors
    expect(v.length).toBe(N_PLANES2 * 50 + N_GLOBALS2 + 4 * (cardIndex.size + 1));
  });

  it("is INFORMATION-FAIR: permuting the foe's hidden hand+deck does not change the encoding", () => {
    const s = makeState();
    const a = encode2(s, "ally", ctxFor(s));

    // Replace the foe's hidden hand+deck contents with different ids (same sizes,
    // public zones untouched). The belief is rebuilt from public state, so the
    // encoding must be byte-identical.
    const permuted: GameState = {
      ...s,
      players: {
        ...s.players,
        enemy: {
          ...s.players.enemy,
          hand: corpusGodIds("Cra").slice(20, 20 + s.players.enemy.hand.length),
          deck: [...s.players.enemy.deck].reverse(),
        },
      },
    };
    const b = encode2(permuted, "ally", ctxFor(permuted));
    expect(Array.from(b)).toEqual(Array.from(a));
  });

  it("foe belief lights up foe_belief columns (matchup channel present)", () => {
    const s = makeState();
    const ctx = ctxFor(s);
    expect(ctx.belief).not.toBeNull();
    const v = encode2(s, "ally", ctx);
    const vocabSize = cardIndex.size + 1;
    const beliefBase = N_PLANES2 * 50 + N_GLOBALS2 + 3 * vocabSize;
    let mass = 0;
    for (let i = 0; i < vocabSize; i++) mass += v[beliefBase + i];
    expect(mass).toBeGreaterThan(0);
  });

  it("is PERSPECTIVE-CANONICAL: enemy view == ally view of the x-mirrored state", () => {
    const s = makeState();
    // Mirror the board horizontally and swap god/hand/deck/discard so the enemy of
    // `s` becomes the ally of `m`. No belief (it would need its own mirroring path).
    const mir = (x: number) => BOARD_COLS - 1 - x;
    const m: GameState = {
      ...s,
      firstSide: "enemy",
      creatures: s.creatures.map((c) => ({ ...c, owner: other(c.owner), position: { x: mir(c.position.x), y: c.position.y } })),
      dofuses: s.dofuses.map((d) => ({ ...d, owner: other(d.owner), position: { x: mir(d.position.x), y: d.position.y } })),
      prisms: s.prisms.map((p) => ({ ...p, owner: other(p.owner), position: { x: mir(p.position.x), y: p.position.y } })),
      players: { ally: { ...s.players.enemy, side: "ally" }, enemy: { ...s.players.ally, side: "enemy" } },
    };
    const enemyView = encode2(s, "enemy", { cardIndex });
    const allyView = encode2(m, "ally", { cardIndex });
    expect(Array.from(allyView)).toEqual(Array.from(enemyView));
  });
});

const other = (s: "ally" | "enemy"): "ally" | "enemy" => (s === "ally" ? "enemy" : "ally");
