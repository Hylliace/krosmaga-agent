// Board geometry, the same as the original game.
//
// This module is pure logic: no React, no CSS, no browser APIs. It answers "where
// on the board is this cell?" and "whose side does this column belong to?".
//
// Orientation convention: a fixed camera where the ally plays on the right (column
// 9) and the enemy on the left (column 0). The original game can flip this per
// player; that is a rendering concern, not a rules concern, so it stays out of the
// engine.

// The Krosmaga board is 10 columns × 5 rows.
export const BOARD_COLS = 10;
export const BOARD_ROWS = 5;

export type Side = "ally" | "enemy";

export interface Coords {
  x: number; // 0..9, column
  y: number; // 0..4, row
}

// Which side does a given column belong to?
// Mirror of the original's IsInSide without the reversed flag.
export function sideForColumn(x: number): Side {
  return x >= BOARD_COLS / 2 ? "ally" : "enemy";
}

// Cells on which a given side can spawn a creature by default, a single
// column directly in front of the Dofus wall. Bastion-type effects (built-
// in mini-Bastion = breaking a fake Dofus, dedicated Bastion cards later)
// expand the zone one column at a time toward the center via per-player
// "extraSpawnRange".
//
// Ally wall is at x=9 → base spawn col is 8.
// Enemy wall is at x=0 → base spawn col is 1.
export function isSpawnCell(x: number, side: Side): boolean {
  if (side === "ally") return x === 8;
  return x === 1;
}

// ── Immobility: two distinct concepts (do not conflate them) ──
//
// INAMOVIBLE (`Rooted`): the creature cannot be relocated by an effect, push,
// attract, teleport, row-change, position-swap, bounce-to-hand. But it still
// moves forward and attacks normally (it keeps its PM). A Mur (Statue) is also
// inamovible. Used at every forced-displacement site.
export function isImmovable(props: Set<string>): boolean {
  return props.has("Statue") || props.has("Rooted");
}

// Cannot advance: the creature never moves forward on its own, a Mur (Statue,
// 0 PM forever even if granted PM) or a 0-PM unit (NoMovementPoints). `Rooted`
// is not here: an inamovible creature walks forward / charges normally. Used at
// every self-movement site (advance, charge, summon-PM, mass-charge).
export function cannotAdvance(props: Set<string>): boolean {
  return props.has("Statue") || props.has("NoMovementPoints");
}

// A side's own half of the board (not counting its Dofus wall column). Walls (the
// "Mur" / Statue keyword) ignore the normal spawn zone and can be placed on any free
// cell of the allied territory.
//   Ally half  = cols 5..8 (between the midline and the wall at x=9).
//   Enemy half = cols 1..4 (between the wall at x=0 and the midline).
export function isAlliedTerritory(x: number, side: Side): boolean {
  const mid = BOARD_COLS / 2; // 5
  if (side === "ally") return x >= mid && x <= BOARD_COLS - 2;
  return x >= 1 && x <= mid - 1;
}

// Same as isSpawnCell, but extended by `extra` columns toward the center.
// Used both by validation (queries.validSpawnCells) and by the renderer
// (Board.tsx draws a spawn indicator on every cell where the column-side
// could legally summon, including extensions). Single source of truth so
// the visuals never drift from the rules.
export function isInSpawnZone(x: number, side: Side, extra: number): boolean {
  if (side === "ally") return x >= 8 - extra && x <= 8;
  return x >= 1 && x <= 1 + extra;
}

// Dofus positions on the base column. Every row (0..4) hosts a Dofus,
// each side has 5 in total. Of those 5:
//   - 3 are real (rows 0, 2, 4): capturing 2 of an opponent's 3 real
//     Dofus wins the match
//   - 2 are fake (rows 1, 3): destroying one grants +1 spawn column to
//     the attacker's side
//
// Layout (top→bottom): real / fake / real / fake / real. This is the MVP
// default, eventually the player will pick the row positions at deck-
// build time (as in the original game).
//
// "Krosmoglob" (mentioned in the player-facing UI) is not a Dofus on the
// board, it is the trophy zone where captured enemy Dofus accumulate.
export const DOFUS_ROWS: readonly number[] = [0, 1, 2, 3, 4] as const;
export const REAL_DOFUS_ROWS: readonly number[] = [0, 2, 4] as const;

// How many of the opponent's real Dofus you need to capture to win.
// In Krosmaga it is 2 (out of the 3 the opponent placed).
export const REAL_DOFUS_TO_WIN = 2;

// Convenience: is this (x, y) a Dofus base cell? Returns the side if yes.
// Every cell of column 0 (enemy) and column 9 (ally) hosts a Dofus.
export function dofusSideAt(x: number, y: number): Side | null {
  if (!DOFUS_ROWS.includes(y)) return null;
  if (x === 0) return "enemy";
  if (x === BOARD_COLS - 1) return "ally";
  return null;
}

// Is this row a real Dofus (= one whose capture counts toward victory)?
// The other rows host fake Dofus.
export function isRealDofusRow(y: number): boolean {
  return REAL_DOFUS_ROWS.includes(y);
}

// Is (x, y) inside the board?
export function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < BOARD_COLS && y >= 0 && y < BOARD_ROWS;
}

// Manhattan distance, the default movement metric in Krosmaga (no diagonals).
export function manhattan(a: Coords, b: Coords): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

// Cheap equality for Coords, handy throughout the engine.
export function sameCoords(a: Coords, b: Coords): boolean {
  return a.x === b.x && a.y === b.y;
}
