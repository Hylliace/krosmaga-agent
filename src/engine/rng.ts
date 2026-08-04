// Seedable pseudo-random generator for the engine.
//
// Why: the AI needs to simulate games, roll out moves, copy a state and replay it the same way.
// That requires every source of chance (deck shuffle, Dofus layout, mulligan redraw, dice,
// random picks) to come from a generator we control, not the global `Math.random`. The
// generator's state (a single uint32) is stored inside GameState, so a game is a pure function
// of (initial seed, action sequence): copy the state, copy the RNG, same future. That is what
// MCTS and self-play need.
//
// Algorithm: mulberry32, tiny, fast, good enough for a card game (not cryptographic). A
// one-integer state is trivial to serialise and copy.

export class Rng {
  private a: number;

  constructor(seed: number) {
    this.a = seed | 0;
  }

  /** Current serialisable state. Store this in GameState to resume later. */
  get state(): number {
    return this.a >>> 0;
  }

  /** Next float in [0, 1). Advances the state. */
  next(): number {
    this.a = (this.a + 0x6d2b79f5) | 0;
    let t = Math.imul(this.a ^ (this.a >>> 15), 1 | this.a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Fisher–Yates shuffle in PLACE; returns the same array for chaining. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

/** A fresh 32-bit seed from Math.random, used by the live game, where we do
 *  want a different shuffle each match. Simulations pass an explicit seed. */
export function randomSeed(): number {
  return (Math.random() * 0x100000000) | 0;
}
