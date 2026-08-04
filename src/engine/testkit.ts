// Shared test helpers for the engine spec files, written once so every *.test.ts imports these
// instead of building the same scaffolding again.
//
// These are test-only utilities (never imported by app code): they read the real card pool from disk
// and build minimal GameStates / creatures so a test can cast a spell and check the result.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Card } from "../data/types";
import type { CreatureInstance, GameState } from "./state";
import type { Coords, Side } from "./board";
import { createInitialState } from "./rules";
import { registerCards } from "./cardRegistry";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(HERE, "../../public/data");

let _cards: Map<number, Card> | null = null;

/** The real game card pool, keyed by id (lazy-loaded + cached). */
export function cards(): Map<number, Card> {
  if (_cards) return _cards;
  const m = new Map<number, Card>();
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!/^cards_.*\.json$/.test(f)) continue;
    const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf-8"));
    const list: Card[] = Array.isArray(d) ? d : (d.cards ?? []);
    for (const c of list) m.set(c.id, c);
  }
  _cards = m;
  registerCards(m.values()); // so Transform/token effects can resolve in tests
  return m;
}

/** Fetch one card by id, throwing a clear error if it is missing. */
export function card(id: number): Card {
  const c = cards().get(id);
  if (!c) throw new Error(`card #${id} not found in pool`);
  return c;
}

/** Build a creature with sane defaults; override any field via `o`. */
export function mkCreature(
  id: number,
  owner: Side,
  pos: Coords,
  o: Partial<CreatureInstance> = {},
): CreatureInstance {
  return {
    instanceId: id,
    cardId: 9999,
    owner,
    position: { ...pos },
    currentLife: 5,
    currentAttack: 2,
    movementLeft: 0,
    baseLife: 5,
    baseAttack: 2,
    baseMovement: 2,
    printedAttack: 2,
    printedLife: 5,
    printedMovement: 2,
    armor: 0,
    resistance: 0,
    vulnerability: 0,
    movementPoison: 0,
    auraAttack: 0,
    auraMovement: 0,
    auraRange: 0,
    auraResistance: 0,
    range: 0,
    // A board creature on its owner's turn is ready by default (startTurn resets hasAttacked=false).
    // Tests that want a creature with summoning sickness / static / that already acted set
    // hasAttacked:true explicitly (like the real summon state: movementLeft:0 + hasAttacked:true). Before
    // the summoning sickness engage fix this defaulted to true, which hid the bug in combat tests.
    hasAttacked: false,
    properties: new Set(),
    silenced: false,
    triggers: [],
    ...o,
  };
}

/** A fresh match with the given creatures on the board and `spellIds` in the
 *  active (ally) player's hand at full AP. */
export function scenario(creatures: CreatureInstance[], ...spellIds: number[]): GameState {
  const s = createInitialState({ ally: [], enemy: [] });
  return {
    ...s,
    // Skip the pre-game redraw: scenarios start mid-match at turn 1.
    mulligan: null,
    turn: 1,
    activeSide: "ally",
    creatures,
    nextInstanceId: 1000,
    players: {
      ...s.players,
      ally: { ...s.players.ally, hand: [...spellIds], handCostMods: spellIds.map(() => 0), ap: 10, maxAp: 10 },
    },
  };
}

export const byId = (s: GameState, id: number): CreatureInstance | undefined =>
  s.creatures.find((c) => c.instanceId === id);
