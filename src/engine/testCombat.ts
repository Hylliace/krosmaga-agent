// Dev "Test Combat" tab: build any GameState from a setup made by hand so the engine's resolution
// (end-of-turn advance / combat / deaths / triggers) can be tried on situations put together by hand.
//
// This is the counterpart of engine/testkit.ts that is safe in the browser (testkit reads cards from
// disk with node:fs and is test-only): it takes a `getCard` lookup from the pools the app already
// loaded instead. It never fires APPARITION / reactions; pieces are dropped as plain state through
// devPlaceCreature.
import type { GameState, PrismKind } from "./state";
import type { Coords, Side } from "./board";
import type { Card } from "../data/types";
import { createInitialState, devPlaceCreature, withAuras } from "./rules";

// The ground objects the palette can drop. Each is placed with an owner + cell;
// the trap materialises as Bombe #101 (the only board trap wired), the prism as
// an AP prism by default.
export type GroundObjectType = "seed" | "tasdos" | "bush" | "butin" | "trap" | "glyph" | "prism";

export interface PlacedCreature {
  cardId: number;
  owner: Side;
  cell: Coords;
  sick: boolean; // mal d'invocation on/off
  // Manual stat overrides (absent → the card's faithful value).
  overrides?: {
    life?: number;
    attack?: number;
    armor?: number;
    range?: number;
    resistance?: number;
    vulnerability?: number;
  };
  properties?: string[]; // extra keyword properties forced on (Bouclier, Assommé, …)
}

export interface PlacedObject {
  type: GroundObjectType;
  owner: Side;
  cell: Coords;
}

// A complete board situation: what sits where, and whose turn the "Lancer la
// résolution" button ends. This is the persisted / editable unit.
export interface TestSetup {
  creatures: PlacedCreature[];
  objects: PlacedObject[];
  activeSide: Side; // the camp whose end-of-turn the resolution runs
}

export function emptySetup(): TestSetup {
  return { creatures: [], objects: [], activeSide: "ally" };
}

// Bombe #101, the only board trap wired in the engine (state.ts TrapInstance).
const TRAP_CARD_ID = 101;
const TRAP_DAMAGE = 2;

// Build a live GameState from a setup. Both decks are stocked with filler cards
// so the resolution's start-of-turn draw never hits an empty deck and fires the
// fatigue rule (which would damage a Dofus and pollute the test).
export function buildTestState(
  setup: TestSetup,
  getCard: (id: number) => Card | undefined,
  filler: number[],
): GameState {
  const base = createInitialState(
    { ally: filler, enemy: filler },
    { gods: { ally: "Iop", enemy: "Iop" }, shuffle: false, seed: 1 },
  );
  // Start mid-match at turn 1 for the chosen side, skip the mulligan, clear the
  // board, and reset the instance counter well clear of the engine's own range.
  let s: GameState = {
    ...base,
    mulligan: null,
    turn: 1,
    activeSide: setup.activeSide,
    creatures: [],
    nextInstanceId: 1000,
  };

  for (const pc of setup.creatures) {
    const card = getCard(pc.cardId);
    if (!card) continue;
    s = devPlaceCreature(s, card, pc.cell, pc.owner, {
      sick: pc.sick,
      life: pc.overrides?.life,
      attack: pc.overrides?.attack,
      armor: pc.overrides?.armor,
      range: pc.overrides?.range,
      resistance: pc.overrides?.resistance,
      vulnerability: pc.overrides?.vulnerability,
      properties: pc.properties,
    });
  }

  // Ground objects, appended onto the base state's arrays (which already hold
  // the home prisms & Dofus from createInitialState).
  const seeds = [...(s.seeds ?? [])];
  const tasDOs = [...(s.tasDOs ?? [])];
  const bushes = [...(s.bushes ?? [])];
  const butins = [...(s.butins ?? [])];
  const traps = [...(s.traps ?? [])];
  const glyphs = [...(s.glyphs ?? [])];
  const prisms = [...s.prisms];
  for (const o of setup.objects) {
    const at = { ...o.cell };
    switch (o.type) {
      case "seed": seeds.push({ position: at, owner: o.owner }); break;
      case "tasdos": tasDOs.push({ position: at, owner: o.owner }); break;
      case "bush": bushes.push({ position: at, owner: o.owner }); break;
      case "butin": butins.push({ position: at, owner: o.owner }); break;
      case "trap": traps.push({ position: at, owner: o.owner, cardId: TRAP_CARD_ID, damage: TRAP_DAMAGE }); break;
      case "glyph": glyphs.push({ position: at, owner: o.owner }); break;
      case "prism": prisms.push({ position: at, owner: o.owner, kind: "ap" as PrismKind }); break;
    }
  }
  s = { ...s, seeds, tasDOs, bushes, butins, traps, glyphs, prisms };

  // Re-fold auras now that seeds are on the board (a planted seed grants its
  // owner's creatures Inciblable / Initiative, see withAuras seedSides).
  const seedSides = new Set<Side>(seeds.map((x) => x.owner));
  s = { ...s, creatures: withAuras(s.creatures, seedSides) };
  return s;
}
