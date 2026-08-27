// Projection of a current v3 vector onto a frozen training layout.
//
// The v3 vector is [planes (N x 50)][globals (111)][V-vectors (11 x vocab)].
// Only the list of planes comes from the observation registry, so it grows with
// it, while the globals and the V-vectors are fixed. Rebuilding the layout of an
// older model means copying its planes again, in its order, and then copying the
// globals and V-vectors as they are. The result is exact to the byte as long as the
// registry only grows by additions.
//
// See planesV1.ts for the crash that led to this module.
import { BOARD_ROWS, BOARD_COLS } from "../../engine/board";
import { PLANES3, N_GLOBALS3, N_V3, vocabSizeOf3 } from "../encode3";
import { PLANES3_V1, N_PLANES3_V1 } from "./planesV1";

const PLANE_SIZE = BOARD_ROWS * BOARD_COLS;

/** Length of the vector for the frozen V1 layout (the one of the deployed network). */
export function encodingLengthV1(cardIndex: Map<number, number>): number {
  return N_PLANES3_V1 * PLANE_SIZE + N_GLOBALS3 + N_V3 * vocabSizeOf3(cardIndex);
}

/** Index of the current planes, built once. */
const SRC_IDX = new Map(PLANES3.map((n, i) => [n, i]));

// Tail (globals + V-vectors) as it was in the V1 layout. The projection copies it
// in one block, which is only valid as long as the tail has not moved.
// A real trap: GLOBALS3 comes from ENC_GODS3, a hard-coded list of gods that does
// not contain Pandawa. Adding that god to it would take the globals from 111 to 113
// and shift the tail without changing the number of planes, so nothing would catch
// it. Hence these two frozen numbers and the assertion below.
export const N_GLOBALS3_V1 = 111;
export const N_V3_V1 = 11;

/** Known training layouts, keyed by number of planes, which is what the manifest
 *  of a model declares (n_planes). A future network trained on a wider layout is
 *  added here with its own frozen list. */
export const LAYOUTS: ReadonlyMap<number, readonly string[]> = new Map([
  [N_PLANES3_V1, PLANES3_V1],
]);

/** Projects a current v3 encoding onto the `target` layout.
 *  Throws if a plane of the target has gone from the current layout: failing loudly
 *  is better than silently feeding a network misaligned inputs. */
export function projectToLayout(x: Float32Array, target: readonly string[], vocabSize: number): Float32Array {
  if (N_GLOBALS3 !== N_GLOBALS3_V1 || N_V3 !== N_V3_V1) {
    throw new Error(
      `projectToLayout: the tail of the encoding changed (globals ${N_GLOBALS3} vs ${N_GLOBALS3_V1}, V ${N_V3} vs ${N_V3_V1}). ` +
      `The projection only copies the tail in one block if it stayed the same, so a new layout has to be frozen and the network trained again.`,
    );
  }
  const srcPlanes = PLANES3.length;
  const expected = srcPlanes * PLANE_SIZE + N_GLOBALS3 + N_V3 * vocabSize;
  if (x.length !== expected) {
    throw new Error(`projectToLayout: source vector of ${x.length} columns, ${expected} expected`);
  }
  const out = new Float32Array(target.length * PLANE_SIZE + N_GLOBALS3 + N_V3 * vocabSize);
  for (let i = 0; i < target.length; i++) {
    const src = SRC_IDX.get(target[i]);
    if (src === undefined) {
      throw new Error(`projectToLayout: the plane "${target[i]}" of the target layout is missing from the current encoder, the registry must only grow by additions`);
    }
    out.set(x.subarray(src * PLANE_SIZE, (src + 1) * PLANE_SIZE), i * PLANE_SIZE);
  }
  // globals + V-vectors: unchanged, copied as they are.
  const srcTail = srcPlanes * PLANE_SIZE;
  const dstTail = target.length * PLANE_SIZE;
  out.set(x.subarray(srcTail, srcTail + N_GLOBALS3 + N_V3 * vocabSize), dstTail);
  return out;
}

/** Shortcut: projection onto the layout of the deployed network. */
export function projectToV1(x: Float32Array, cardIndex: Map<number, number>): Float32Array {
  return projectToLayout(x, PLANES3_V1, vocabSizeOf3(cardIndex));
}
