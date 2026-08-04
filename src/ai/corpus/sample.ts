// Weighted match-up sampler. Draws (ally deck, enemy deck) pairs from the corpus
// for self-play. Two regimes, mixed by `alpha`:
//   - proportional (alpha=0): each side ~ deck weight, like the real meta.
//   - god-normalized (alpha=1): each side's god drawn uniformly (so rare gods like
//     Xelor/Sadida are covered), then a deck of that god ~ weight.
// Turn order follows the Krosmaga rule: the cheaper deck (costAP) plays first.
import type { DeckEntry } from "./loader";
import type { God } from "../../data/types";
import type { Side } from "../../engine/board";
import type { Rng } from "../../engine/rng";

export interface Matchup {
  ally: DeckEntry;
  enemy: DeckEntry;
  firstSide: Side; // cheaper costAP plays first; tie -> ally
  wA: number;
  wB: number;
  wCost: number; // sqrt(wA*wB), importance weight to re-weight god-normalized draws back to meta
}

export interface SamplerOptions {
  // 0 = pure proportional, 1 = pure god-normalized, in between = mix (per-draw coin).
  alpha?: number;
  allowMirror?: boolean; // same deckId both sides allowed (default true)
}

/** O(1) weighted sampling, Vose's alias method. */
export class AliasSampler {
  private readonly prob: number[];
  private readonly alias: number[];
  constructor(weights: number[]) {
    const n = weights.length;
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    const scaled = weights.map((w) => (w * n) / sum);
    const small: number[] = [];
    const large: number[] = [];
    scaled.forEach((p, i) => (p < 1 ? small : large).push(i));
    this.prob = new Array(n).fill(1);
    this.alias = new Array(n).fill(0);
    while (small.length && large.length) {
      const s = small.pop()!;
      const l = large.pop()!;
      this.prob[s] = scaled[s];
      this.alias[s] = l;
      scaled[l] = scaled[l] + scaled[s] - 1;
      (scaled[l] < 1 ? small : large).push(l);
    }
    // leftovers (numerical) keep prob 1
  }
  sample(rng: Rng): number {
    const i = rng.int(this.prob.length);
    return rng.next() < this.prob[i] ? i : this.alias[i];
  }
}

export class CorpusSampler {
  private readonly decks: DeckEntry[];
  private readonly overall: AliasSampler;
  private readonly byGod = new Map<God, { decks: DeckEntry[]; alias: AliasSampler }>();
  private readonly gods: God[];

  constructor(decks: DeckEntry[]) {
    if (decks.length === 0) throw new Error("CorpusSampler: empty deck set");
    this.decks = decks;
    this.overall = new AliasSampler(decks.map((d) => d.weight));
    const grouped = new Map<God, DeckEntry[]>();
    for (const d of decks) {
      if (!grouped.has(d.god)) grouped.set(d.god, []);
      grouped.get(d.god)!.push(d);
    }
    for (const [g, ds] of grouped) this.byGod.set(g, { decks: ds, alias: new AliasSampler(ds.map((d) => d.weight)) });
    this.gods = [...this.byGod.keys()];
  }

  private drawDeck(rng: Rng, godNormalized: boolean): DeckEntry {
    if (!godNormalized) return this.decks[this.overall.sample(rng)];
    const g = this.gods[rng.int(this.gods.length)];
    const v = this.byGod.get(g)!;
    return v.decks[v.alias.sample(rng)];
  }

  matchup(rng: Rng, opts: SamplerOptions = {}): Matchup {
    const alpha = opts.alpha ?? 0;
    const godNorm = alpha >= 1 ? true : alpha <= 0 ? false : rng.next() < alpha;
    const ally = this.drawDeck(rng, godNorm);
    let enemy = this.drawDeck(rng, godNorm);
    if (opts.allowMirror === false) {
      let guard = 0;
      while (enemy.deckId === ally.deckId && guard++ < 30) enemy = this.drawDeck(rng, godNorm);
    }
    const firstSide: Side = ally.costAP <= enemy.costAP ? "ally" : "enemy";
    return {
      ally,
      enemy,
      firstSide,
      wA: ally.weight,
      wB: enemy.weight,
      wCost: Math.sqrt(ally.weight * enemy.weight),
    };
  }
}
