// v3: the completeness and leak checks for encode3, built from a field-by-field list of what a
// player can observe. Two directions:
//
//   Completeness: for every public field of the GameState, changing it must change the encoding.
//   Without this check the earlier encoders had blind spots (10/23 properties, no range, no
//   triggers, no identity, ground objects lumped together...). One `it` per field, so a failure
//   names the exact blind field.
//
//   Leak parity (extended): changing anything the observer cannot see (the opponent's hidden
//   hand/deck contents, my own deck's order, the nature of an unrevealed enemy Dofus, the rng, the
//   event log) must leave the encoding the same to the bit.
//
// Plus the v2 invariants carried over: exact length, mirror to the player's own perspective.
import { describe, it, expect, beforeAll } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { cards, mkCreature } from "../engine/testkit";
import { createInitialState } from "../engine/rules";
import type { GameState } from "../engine/state";
import { BOARD_COLS } from "../engine/board";
import { loadCorpus } from "./corpus/loader";
import { buildCorpusBelief } from "./belief/corpus";
import { buildBeliefFromState } from "./belief/determinizeBelief";
import { PROPERTIES3, TRIGGER_TYPES3, FAMILIES3 } from "./enc/registry3";
import {
  encode3,
  encodingLength3,
  N_PLANES3,
  N_GLOBALS3,
  N_V3,
  type EncodeCtx3,
} from "./encode3";
import { buildCardIndex2 } from "./encode2";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "../..");
const DECKS = path.resolve(APP_ROOT, "decks-corpus/decks.json");
const WEIGHTS = path.resolve(APP_ROOT, "decks-corpus/weights.json");

let cardIndex: Map<number, number>;
let corpusMap: Map<string, ReturnType<typeof buildCorpusBelief> extends Map<infer _, infer V> ? V : never>;
let ids: number[]; // some real card ids to fill zones with

beforeAll(() => {
  cards();
  ids = [...cards().keys()].sort((a, b) => a - b);
  cardIndex = buildCardIndex2(ids);
  const { decks } = loadCorpus(DECKS, WEIGHTS, { isKnownCard: (id) => cards().has(id) });
  corpusMap = buildCorpusBelief(decks) as typeof corpusMap;
});

// A rich mid-match base state touching every zone, so each mutation below has
// something to move away from.
function makeState(): GameState {
  // Fixed seed: expectDiff/expectSame compare two independent constructions, so
  // the base must be bit-identical between calls (the Dofus layout draw is
  // seeded). Without this, every expectDiff would pass spuriously.
  const s = createInitialState({ ally: [], enemy: [] }, { seed: 42 });
  return {
    ...s,
    mulligan: null,
    turn: 6,
    activeSide: "ally",
    firstSide: "ally",
    creatures: [
      mkCreature(1, "ally", { x: 7, y: 2 }, { cardId: ids[0], currentAttack: 3, currentLife: 4, baseLife: 6, movementLeft: 2 }),
      mkCreature(2, "ally", { x: 6, y: 4 }, { cardId: ids[1] }),
      mkCreature(3, "enemy", { x: 2, y: 1 }, { cardId: ids[2], currentAttack: 5, currentLife: 2, movementLeft: 1 }),
      // cardId 9999 = unknown card → famsOf() is empty: the family-loop below
      // sets familyOverride=[f] on this one so every family flips 0→1.
      mkCreature(4, "ally", { x: 5, y: 0 }),
    ],
    seeds: [{ position: { x: 6, y: 0 }, owner: "ally" }],
    traps: [{ position: { x: 5, y: 3 }, owner: "ally", cardId: 101, damage: 2 }],
    tasDOs: [{ position: { x: 6, y: 1 }, owner: "enemy" }],
    bushes: [{ position: { x: 3, y: 3 }, owner: "enemy" }],
    glyphs: [{ position: { x: 7, y: 4 }, owner: "ally" }],
    butins: [{ position: { x: 4, y: 2 }, owner: "enemy" }],
    players: {
      ...s.players,
      ally: {
        ...s.players.ally,
        god: "Iop",
        hand: ids.slice(10, 13),
        handCostMods: [0, 0, 0],
        deck: ids.slice(20, 26),
        deckCostMods: [0, 0, 0, 0, 0, 0],
        discard: ids.slice(30, 32),
        ap: 4,
        maxAp: 6,
        apReserve: 1,
      },
      enemy: {
        ...s.players.enemy,
        god: "Cra",
        hand: ids.slice(40, 43),
        handCostMods: [0, 0, 0],
        deck: ids.slice(50, 55),
        discard: ids.slice(60, 62),
        ap: 3,
        maxAp: 6,
        apReserve: 2,
      },
    },
  };
}

const enc = (s: GameState) => encode3(s, "ally", { cardIndex });
const diff = (a: Float32Array, b: Float32Array) => {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
  return false;
};

/** Completeness: the mutation must change the encoding. */
function expectDiff(mutate: (s: GameState) => GameState | void): void {
  const base = makeState();
  const a = enc(base);
  const m = makeState();
  const r = mutate(m);
  const b = enc(r ?? m);
  expect(diff(a, b), "mutation should change the encoding but did not (blind field)").toBe(true);
}

/** Leak: the mutation must not change the encoding (belief-aware context). */
function expectSame(mutate: (s: GameState) => GameState | void): void {
  const ctxOf = (s: GameState): EncodeCtx3 => ({
    cardIndex,
    belief: buildBeliefFromState(s, "ally", corpusMap as never),
    myTags: ["agro"],
  });
  const base = makeState();
  const a = encode3(base, "ally", ctxOf(base));
  const m = makeState();
  const r = mutate(m) ?? m;
  const b = encode3(r, "ally", ctxOf(r));
  expect(diff(a, b), "mutation of HIDDEN info changed the encoding (leak)").toBe(false);
}

const c1 = (s: GameState) => s.creatures[0]; // mine
const c3 = (s: GameState) => s.creatures[2]; // foe's

describe("encode3, layout", () => {
  it("output length matches encodingLength3 (planes + globals + V-vectors)", () => {
    const s = makeState();
    const v = enc(s);
    expect(v.length).toBe(encodingLength3(cardIndex));
    expect(v.length).toBe(N_PLANES3 * 50 + N_GLOBALS3 + N_V3 * (cardIndex.size + 1));
  });
});

describe("encode3, completeness gate (every public field must reach the input)", () => {
  // --- creature stats ---
  it("creature.currentAttack", () => expectDiff((s) => void (c1(s).currentAttack += 1)));
  it("creature.currentLife", () => expectDiff((s) => void (c1(s).currentLife += 1)));
  it("creature.armor", () => expectDiff((s) => void (c1(s).armor += 1)));
  it("creature.baseAttack", () => expectDiff((s) => void (c1(s).baseAttack += 1)));
  it("creature.baseLife (wounded state)", () => expectDiff((s) => void (c1(s).baseLife += 1)));
  it("creature.baseMovement", () => expectDiff((s) => void (c1(s).baseMovement += 1)));
  it("creature.movementLeft", () => expectDiff((s) => void (c1(s).movementLeft -= 1)));
  it("creature.hasAttacked (ready)", () => expectDiff((s) => void (c1(s).hasAttacked = true)));
  it("creature.range (shooter)", () => expectDiff((s) => void (c1(s).range = 3)));
  it("creature.resistance", () => expectDiff((s) => void (c1(s).resistance = 2)));
  it("creature.vulnerability", () => expectDiff((s) => void (c1(s).vulnerability = 2)));
  it("creature.movementPoison", () => expectDiff((s) => void (c1(s).movementPoison = 1)));
  it("creature.silenced", () => expectDiff((s) => void (c1(s).silenced = true)));
  it("creature.protectedByGuard (living guard)", () => expectDiff((s) => void (c1(s).protectedByGuard = 2)));
  it("creature.strikeSpent (one-shot spent)", () => expectDiff((s) => void (c1(s).strikeSpent = true)));
  it("creature.playedCostMod", () => expectDiff((s) => void (c1(s).playedCostMod = 2)));
  it("creature.costOverride", () => expectDiff((s) => void (c1(s).costOverride = 9)));
  it("creature.cardId (identity, a vanilla 4/4 vs a MORT-bomb 4/4)", () =>
    expectDiff((s) => void (c1(s).cardId = ids[5])));
  it("foe creature stats too (foe_ planes)", () => expectDiff((s) => void (c3(s).range = 2)));

  // --- every property, every trigger type, every rule-read family ---
  for (const p of PROPERTIES3) {
    it(`creature.properties: ${p}`, () => expectDiff((s) => void c1(s).properties.add(p)));
  }
  for (const t of TRIGGER_TYPES3) {
    it(`creature.triggers: ${t}`, () => expectDiff((s) => void c1(s).triggers.push({ trigger: t, effects: [] })));
  }
  for (const f of FAMILIES3) {
    it(`creature family: ${f}`, () => expectDiff((s) => void (s.creatures[3].familyOverride = [f])));
  }

  // --- temporary reversions (public: the card text says "jusqu'à ...") ---
  it("pendingReversions: temp control (Fiole de Psykoz is not a permanent steal)", () =>
    expectDiff((s) => void (s.pendingReversions = [{ kind: "control", expireSide: "ally", instanceId: 1, originalOwner: "enemy" }])));
  it("pendingReversions: temp STAT (Sénilité reverts)", () =>
    expectDiff((s) => void (s.pendingReversions = [{ kind: "stat", expireSide: "ally", field: "attack", amount: 2, instanceIds: [1] }])));

  // --- Dofus ---
  it("my dofus damage", () => expectDiff((s) => void (s.dofuses[0].currentLife -= 2)));
  it("my dofus revealed (opponent now KNOWS its nature)", () =>
    expectDiff((s) => void (s.dofuses.find((d) => d.owner === "ally")!.revealed = true)));
  it("foe dofus revealed alive (exact real/fake replaces the posterior)", () =>
    expectDiff((s) => void (s.dofuses.find((d) => d.owner === "enemy")!.revealed = true)));
  it("foe dofus destroyed (nature revealed by destruction)", () =>
    expectDiff((s) => void (s.dofuses.find((d) => d.owner === "enemy")!.currentLife = 0)));
  it("dofus protectedBy (Lien de Sang)", () =>
    expectDiff((s) => void (s.dofuses.find((d) => d.owner === "ally")!.protectedBy = 1)));
  it("dofus shielded (Pissenlit Maléfique)", () =>
    expectDiff((s) => void (s.dofuses.find((d) => d.owner === "ally")!.shielded = true)));
  it("dofus invulnerableTurns (Orbe Doré)", () =>
    expectDiff((s) => void (s.dofuses.find((d) => d.owner === "ally")!.invulnerableTurns = 1)));
  it("dofus invulnerableBy (Artheon, living source)", () =>
    expectDiff((s) => void (s.dofuses.find((d) => d.owner === "ally")!.invulnerableBy = 1)));
  it("dofus sinistroAttached", () =>
    expectDiff((s) => void (s.dofuses.find((d) => d.owner === "ally")!.sinistroAttached = true)));
  it("dofus necronomigoreCounter", () =>
    expectDiff((s) => void (s.dofuses.find((d) => d.owner === "ally")!.necronomigoreCounter = 3)));

  // --- players: mine ---
  it("my ap", () => expectDiff((s) => void (s.players.ally.ap -= 1)));
  it("my maxAp", () => expectDiff((s) => void (s.players.ally.maxAp -= 1)));
  it("my apReserve", () => expectDiff((s) => void (s.players.ally.apReserve += 1)));
  it("my hand content (same size)", () => expectDiff((s) => void (s.players.ally.hand = [ids[70], ...s.players.ally.hand.slice(1)])));
  it("my handCostMods", () => expectDiff((s) => void (s.players.ally.handCostMods = [-1, 0, 0])));
  it("my handCostTempMods", () => expectDiff((s) => void (s.players.ally.handCostTempMods = [2, 0, 0])));
  it("my deck multiset (same size)", () => expectDiff((s) => void (s.players.ally.deck = [ids[71], ...s.players.ally.deck.slice(1)])));
  it("my deckCostMods (HORDE reductions in deck)", () => expectDiff((s) => void (s.players.ally.deckCostMods = [-1, 0, 0, 0, 0, 0])));
  it("my discard content (same size, recursion fuel)", () =>
    expectDiff((s) => void (s.players.ally.discard = [ids[72], s.players.ally.discard[1]])));
  it("my banished", () => expectDiff((s) => void (s.players.ally.banished = [ids[73]])));
  it("my seedReserve", () => expectDiff((s) => void (s.players.ally.seedReserve = 2)));
  it("my extraSpawnRange", () => expectDiff((s) => void (s.players.ally.extraSpawnRange = 1)));
  it("my diceFloor (Dé Pipé)", () => expectDiff((s) => void (s.players.ally.diceFloor = 3)));
  it("my activeTraps (delivered Sram trap)", () =>
    expectDiff((s) => void (s.players.ally.activeTraps = [{ cardId: 681, counter: 2, penalty: 2 }])));
  it("my discardPaysCost (Repos Éternel)", () => expectDiff((s) => void (s.players.ally.discardPaysCost = true)));
  it("my nextCardDiscount (La Folle)", () => expectDiff((s) => void (s.players.ally.nextCardDiscount = 2)));
  it("my coinForcedPile (Trucage)", () => expectDiff((s) => void (s.players.ally.coinForcedPile = true)));
  it("my godCostReductions (Nouvelle Vague)", () => expectDiff((s) => void (s.players.ally.godCostReductions = { Feca: 1 })));

  // --- players: foe (public subset) ---
  it("foe ap (HUD-visible)", () => expectDiff((s) => void (s.players.enemy.ap -= 1)));
  it("foe maxAp", () => expectDiff((s) => void (s.players.enemy.maxAp -= 1)));
  it("foe apReserve", () => expectDiff((s) => void (s.players.enemy.apReserve += 1)));
  it("foe hand size", () => expectDiff((s) => void (s.players.enemy.hand = [...s.players.enemy.hand, ids[45]])));
  it("foe discard content (same size, everything he played)", () =>
    expectDiff((s) => void (s.players.enemy.discard = [ids[74], s.players.enemy.discard[1]])));
  it("foe banished", () => expectDiff((s) => void (s.players.enemy.banished = [ids[75]])));
  it("foe temp surcharge (Ralentissement window)", () =>
    expectDiff((s) => void (s.players.enemy.handCostTempMods = [2, 2, 2])));
  it("foe godCostReductions", () => expectDiff((s) => void (s.players.enemy.godCostReductions = { Cra: 1 })));
  it("foe diceFloor", () => expectDiff((s) => void (s.players.enemy.diceFloor = 3)));
  it("foe activeTraps (trap I delivered)", () =>
    expectDiff((s) => void (s.players.enemy.activeTraps = [{ cardId: 681, counter: 1, penalty: 2 }])));
  it("foe discardPaysCost", () => expectDiff((s) => void (s.players.enemy.discardPaysCost = true)));
  it("foe nextCardDiscount", () => expectDiff((s) => void (s.players.enemy.nextCardDiscount = 1)));
  it("foe coinForcedPile", () => expectDiff((s) => void (s.players.enemy.coinForcedPile = true)));
  it("foe god", () => expectDiff((s) => void (s.players.enemy.god = "Sram")));

  // --- board objects, each on its own plane ---
  it("seed", () => expectDiff((s) => void (s.seeds = [])));
  it("trap presence", () => expectDiff((s) => void (s.traps = [])));
  it("trap damage value", () => expectDiff((s) => void (s.traps![0].damage = 4)));
  it("tas d'os", () => expectDiff((s) => void (s.tasDOs = [])));
  it("bush (a spawn point, not 'other')", () => expectDiff((s) => void (s.bushes = [])));
  it("glyph", () => expectDiff((s) => void (s.glyphs = [])));
  it("butin", () => expectDiff((s) => void (s.butins = [])));
  it("bush vs glyph are DISTINGUISHABLE (v2 lumped them into ground_other)", () => {
    const a = makeState();
    a.bushes = [{ position: { x: 4, y: 4 }, owner: "ally" }];
    const b = makeState();
    b.glyphs = [...(b.glyphs ?? []), { position: { x: 4, y: 4 }, owner: "ally" }];
    expect(diff(enc(a), enc(b))).toBe(true);
  });
  it("prism kind", () => expectDiff((s) => void (s.prisms[0].kind = s.prisms[0].kind === "ap" ? "draw" : "ap")));
  it("ground object owner (signed)", () => expectDiff((s) => void (s.seeds![0].owner = "enemy")));

  // --- game globals ---
  it("turn", () => expectDiff((s) => void (s.turn += 1)));
  it("firstSide", () => expectDiff((s) => void (s.firstSide = "enemy")));
});

describe("encode3, LEAK-PARITY gate (hidden info must not reach the input)", () => {
  it("permuting the foe's hidden hand contents (same size)", () =>
    expectSame((s) => void (s.players.enemy.hand = ids.slice(80, 83))));
  it("permuting the foe's hidden deck contents (same size)", () =>
    expectSame((s) => void (s.players.enemy.deck = ids.slice(90, 95))));
  it("reordering my own deck (multiset unchanged, mods follow their cards)", () =>
    expectSame((s) => {
      s.players.ally.deck = [...s.players.ally.deck].reverse();
      s.players.ally.deckCostMods = [...(s.players.ally.deckCostMods ?? [])].reverse();
    }));
  it("flipping the kind of an unrevealed living foe Dofus", () =>
    expectSame((s) => {
      const d = s.dofuses.find((x) => x.owner === "enemy" && x.currentLife > 0 && !x.revealed)!;
      d.kind = d.kind === "real" ? "fake" : "real";
    }));
  it("mutating the rng seed", () => expectSame((s) => void (s.rng = (s.rng + 12345) >>> 0)));
  it("appending to the event log", () =>
    expectSame((s) => void (s.log = [...s.log, { type: "TURN_STARTED", side: "ally", turn: 99 } as never])));
  it("nextInstanceId", () => expectSame((s) => void (s.nextInstanceId += 50)));
});

describe("encode3, perspective-canonical", () => {
  it("enemy view == ally view of the x-mirrored state", () => {
    const s = makeState();
    const mir = (x: number) => BOARD_COLS - 1 - x;
    const other = (o: "ally" | "enemy") => (o === "ally" ? "enemy" : "ally");
    const m: GameState = {
      ...s,
      firstSide: "enemy",
      activeSide: "enemy",
      creatures: s.creatures.map((c) => ({ ...c, owner: other(c.owner), position: { x: mir(c.position.x), y: c.position.y } })),
      dofuses: s.dofuses.map((d) => ({ ...d, owner: other(d.owner), position: { x: mir(d.position.x), y: d.position.y } })),
      prisms: s.prisms.map((p) => ({ ...p, owner: other(p.owner), position: { x: mir(p.position.x), y: p.position.y } })),
      seeds: s.seeds!.map((o) => ({ ...o, owner: other(o.owner), position: { x: mir(o.position.x), y: o.position.y } })),
      traps: s.traps!.map((o) => ({ ...o, owner: other(o.owner), position: { x: mir(o.position.x), y: o.position.y } })),
      tasDOs: s.tasDOs!.map((o) => ({ ...o, owner: other(o.owner), position: { x: mir(o.position.x), y: o.position.y } })),
      bushes: s.bushes!.map((o) => ({ ...o, owner: other(o.owner), position: { x: mir(o.position.x), y: o.position.y } })),
      glyphs: s.glyphs!.map((o) => ({ ...o, owner: other(o.owner), position: { x: mir(o.position.x), y: o.position.y } })),
      butins: s.butins!.map((o) => ({ ...o, owner: other(o.owner), position: { x: mir(o.position.x), y: o.position.y } })),
      players: { ally: { ...s.players.enemy, side: "ally" }, enemy: { ...s.players.ally, side: "enemy" } },
    };
    const enemyView = encode3(s, "enemy", { cardIndex });
    const allyView = encode3(m, "ally", { cardIndex });
    expect(Array.from(allyView)).toEqual(Array.from(enemyView));
  });
});
