// Pure read-only queries over a GameState. Split from rules.ts because
// these do not modify state, they just answer "what is here?" and "where can
// this happen?". The UI uses them to highlight cells; the engine uses them
// internally to validate moves.

import {
  BOARD_COLS,
  BOARD_ROWS,
  type Coords,
  type Side,
  dofusSideAt,
  isSpawnCell,
  isAlliedTerritory,
  sameCoords,
} from "./board";
import type { GameState, CreatureInstance, DofusInstance, SeedInstance } from "./state";
import type { Card } from "../data/types";
import { getCard } from "./cardRegistry";

// Is this card a "Mur" (the Statue keyword)? Walls carry it either as a static
// SummonProperty (card.properties) or as a SetPropertyData effect (the usual
// place innate keywords live). Walls bypass the spawn zone and may be placed
// anywhere in the allied territory.
export function isWallCard(card: Card): boolean {
  if (card.properties?.includes("Statue")) return true;
  return card.effects.some(
    (e) => e.type === "SetPropertyData" && (e as { PropertyType?: string }).PropertyType === "Statue",
  );
}

// Is there a creature on this cell? Returns the instance if yes.
export function creatureAt(state: GameState, at: Coords): CreatureInstance | null {
  return state.creatures.find((c) => sameCoords(c.position, at)) ?? null;
}

// Is there a Dofus base on this cell? Returns it if yes.
export function dofusAt(state: GameState, at: Coords): DofusInstance | null {
  return state.dofuses.find((d) => sameCoords(d.position, at)) ?? null;
}

// Is this cell free (no creature, no Dofus)? Dofuses block movement and
// spawning in the original game, so we treat them as occupied for both.
export function isCellFree(state: GameState, at: Coords): boolean {
  return creatureAt(state, at) === null && dofusAt(state, at) === null;
}

// Performance cache: validSpawnCells took ~9% of the search time (V8 profile). legalActions
// computes it again for every card and canPlayCard checks it again for every placement, on the
// same state. States are immutable at the action level (copy-on-write), so the result is memoized
// by state identity (WeakMap) and by a signature of the only card traits that change it (wall /
// castTarget Loot / summonOnTasDOs). Same result to the bit, checked by replaying a full
// generation byte for byte. Callers never mutate the returned array (read only: some/filter/map).
const spawnCellsCache = new WeakMap<GameState, Map<string, Coords[]>>();

// All cells where `side` can legally summon a creature right now.
// Base spawn zones are the 2 columns adjacent to the side's Dofus column,
// plus any extraSpawnRange granted by Bastion-type effects.
export function validSpawnCells(state: GameState, side: Side, card?: Card): Coords[] {
  const extra = state.players[side].extraSpawnRange;
  const isWall = card ? isWallCard(card) : false;
  const sig = `${side}|${isWall ? 1 : 0}${(card?.castTarget ?? "").includes("Loot") ? 1 : 0}${card?.summonOnTasDOs ? 1 : 0}`;
  let bySig = spawnCellsCache.get(state);
  if (bySig) {
    const hit = bySig.get(sig);
    // Defensive copy. Before the cache, each call returned a new array, so a caller could sort or
    // filter it in place with no consequence. Returning the memoized instance would turn any
    // caller's mutation into a corrupted cache for every later call. What the cache saves is the
    // double loop over the board, not copying about fifteen cells, so the gain is kept and the
    // contract restored.
    if (hit) return hit.slice();
  } else {
    bySig = new Map();
    spawnCellsCache.set(state, bySig);
  }
  const out: Coords[] = [];
  for (let y = 0; y < BOARD_ROWS; y++) {
    for (let x = 0; x < BOARD_COLS; x++) {
      // Dofus cell? Even if x is in spawn zone, the Dofus base itself is not
      // a spawnable cell.
      if (dofusSideAt(x, y)) continue;
      if (!isCellFree(state, { x, y })) continue;
      // Walls: anywhere in the allied territory. Others: spawn zone (+ Bastion).
      let ok = isWall
        ? isAlliedTerritory(x, side)
        : isSpawnCell(x, side) || inExtendedSpawn(x, side, extra);
      // A Buisson (#240, ActAsSpawnPoint) owned by this side is also a legal
      // spawn cell, "vous pouvez invoquer un allié sur un buisson". Consumed
      // when summoned on (see summonCreature).
      if (!ok && (state.bushes ?? []).some((b) => b.owner === side && b.position.x === x && b.position.y === y)) {
        ok = true;
      }
      // Samson Deur (castTarget "…OrAlliedLoot") may also be summoned onto an
      // allied Butin (picked up on summon). Only cards whose castTarget allows it.
      if (!ok && (card?.castTarget ?? "").includes("Loot") &&
          (state.butins ?? []).some((b) => b.owner === side && b.position.x === x && b.position.y === y)) {
        ok = true;
      }
      // Chafer Faucheur #742 (summonOnTasDOs): an allied Tas d'Os is a legal spawn cell anywhere, even
      // in the enemy camp. Used up and buffed on summon (see summonCreature).
      if (!ok && card?.summonOnTasDOs &&
          (state.tasDOs ?? []).some((t) => t.owner === side && t.position.x === x && t.position.y === y)) {
        ok = true;
      }
      if (ok) out.push({ x, y });
    }
  }
  bySig.set(sig, out);
  return out.slice(); // same here: the memoized instance never leaves the function
}

// Is there a seed planted on this cell? Returns it if yes.
export function seedAt(state: GameState, at: Coords): SeedInstance | null {
  return (state.seeds ?? []).find((s) => sameCoords(s.position, at)) ?? null;
}

// All cells where `side` can MANUALLY plant a seed right now: an empty cell of
// the side's own territory (cols 5-8 ally / 1-4 enemy), free of any creature,
// Dofus, existing seed, or prism. The reserve / PA affordability checks live in
// plantSeed (the action), not here, this only answers "which cells are legal".
export function validSeedCells(state: GameState, side: Side): Coords[] {
  const out: Coords[] = [];
  // One ground object per cell: a cell that already has any ground object
  // (graine/tas d'os/buisson/glyphe/butin/cadeau/piège) cannot be planted, same as plantSeed's
  // refusal. (Prisms are not ground objects: planting on a prism destroys it, so they do not block.)
  const hasObject = (x: number, y: number): boolean =>
    (state.seeds ?? []).some((o) => o.position.x === x && o.position.y === y) ||
    (state.tasDOs ?? []).some((o) => o.position.x === x && o.position.y === y) ||
    (state.bushes ?? []).some((o) => o.position.x === x && o.position.y === y) ||
    (state.glyphs ?? []).some((o) => o.position.x === x && o.position.y === y) ||
    (state.butins ?? []).some((o) => o.position.x === x && o.position.y === y) ||
    (state.gifts ?? []).some((o) => o.position.x === x && o.position.y === y) ||
    (state.traps ?? []).some((o) => o.position.x === x && o.position.y === y);
  for (let y = 0; y < BOARD_ROWS; y++) {
    for (let x = 0; x < BOARD_COLS; x++) {
      if (!isAlliedTerritory(x, side)) continue;
      if (!isCellFree(state, { x, y })) continue;
      if (hasObject(x, y)) continue;
      out.push({ x, y });
    }
  }
  return out;
}

// Spell damage reduction that a spell cast by `casterSide` would get right now: the sum of the
// `SpellDamageReductionAura` (Joris #110...) of the living creatures of the opposing camp (the one
// with the aura reduces the other side's spells). Only for display (showing the reduced value in
// red on the damage spells in hand); the real reduction is applied cell by cell in
// dealSpellDamageThroughGuard, which this total matches (stacks, floored at 0).
export function spellDamageReductionAgainst(state: GameState, casterSide: Side): number {
  const foe: Side = casterSide === "ally" ? "enemy" : "ally";
  let total = 0;
  for (const c of state.creatures) {
    if (c.currentLife <= 0 || c.owner !== foe) continue;
    const a = (getCard(c.cardId)?.effects ?? []).find((e) => e.type === "SpellDamageReductionAura") as { amount?: number } | undefined;
    if (a) total += a.amount ?? 0;
  }
  return total;
}

function inExtendedSpawn(x: number, side: Side, extra: number): boolean {
  if (extra <= 0) return false;
  if (side === "ally") {
    // Base spawn col is 8 (wall at 9 excluded). Extension adds columns
    // toward the center: extra=1 → also col 7, extra=2 → cols 7 & 6, etc.
    return x >= Math.max(0, 8 - extra);
  }
  // Enemy base spawn col is 1. Extension adds columns toward center.
  return x <= Math.min(BOARD_COLS - 1, 1 + extra);
}
