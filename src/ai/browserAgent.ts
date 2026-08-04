// Browser loader for the in-game value-net AI. Fetches the served bundle
// (public/ai/*) and builds a value-net DetMCTS agent, with no fs and no native
// dependencies. Two strengths trade speed for strength. Cost per decision ≈
// worlds×sims × ~5 ms (1.7 ms wasm-SIMD net forward + ~3.4 ms engine simulation);
// a card that opens a targeting pick costs a second full decision.
//   - "normale": 2×40 search, measured at 62.5% against the older "forte" (2×20)
//                with value5 on general decks, ~0.4 s per decision. The best
//                trade-off for interactive play, and the default.
//   - "forte"  : 6×120 search, the strongest level (≈90% against 2×20 in-world),
//                ~3-4 s per decision. Opt-in for players who accept the wait.
// The heuristic agent stays the instant "facile" level (built directly, nothing to load).
import type { Agent } from "./agents/Agent";
import { buildCardIndex2 } from "./encode2";
import { buildCorpusBelief } from "./belief/corpus";
import type { DeckEntry } from "./corpus/loader";
import { TsValueModel } from "./net/TsValueModel";
import type { NnManifest } from "./net/nnOps";
import { makeValueAgent } from "./agents/valueAgent";

export type AiStrength = "normale" | "forte";

const BUDGETS: Record<AiStrength, { worlds: number; simulations: number; maxBranch: number }> = {
  normale: { worlds: 2, simulations: 40, maxBranch: 8 },
  // maxBranch 12 for forte. Arena results: 2x40 = 51.0% (a draw), 6x120 = 51.5%
  // [41.8;61.1] over 99 games (also a draw). Kept anyway: it costs nearly nothing at
  // the same number of simulations, and it matches the teacher that generated the gen4
  // corpus (also at 12), so the deployed forte plays like the teacher of its data.
  forte: { worlds: 6, simulations: 120, maxBranch: 12 },
};

const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
const url = (f: string) => `${base}ai/${f}`;

// Load the model + vocab + belief corpus once (shared across strengths + matches).
let loaded: Promise<{ model: TsValueModel; cardIndex: Map<number, number>; corpusMap: ReturnType<typeof buildCorpusBelief> }> | null = null;

function loadCore() {
  if (loaded) return loaded;
  loaded = (async () => {
    const [manifest, weightsBuf, vocab, decks] = await Promise.all([
      fetch(url("value.manifest.json")).then((r) => r.json() as Promise<NnManifest>),
      fetch(url("value.weights.f32")).then((r) => r.arrayBuffer()),
      fetch(url("vocab.json")).then((r) => r.json() as Promise<{ ids: number[] }>),
      fetch(url("train_decks.json")).then((r) => r.json() as Promise<Array<Pick<DeckEntry, "deckId" | "god" | "cards">>>),
    ]);
    const model = new TsValueModel(manifest, new Float32Array(weightsBuf));
    const cardIndex = buildCardIndex2(vocab.ids);
    // buildCorpusBelief only reads {god, cards, deckId} (+ getCard, already registered).
    const corpusMap = buildCorpusBelief(decks as DeckEntry[]);
    return { model, cardIndex, corpusMap };
  })();
  return loaded;
}

/** Build the value-net AI agent at the given strength (loads the bundle on first
 *  call, then reuses it). Throws if the bundle cannot be fetched. */
export async function loadValueAgent(strength: AiStrength): Promise<Agent> {
  const { model, cardIndex, corpusMap } = await loadCore();
  const b = BUDGETS[strength];
  // Trace de vérité pour vérifier quel niveau joue réellement (F12 > Console).
  console.info(`[AI] agent "${strength}" prêt — recherche ${b.worlds}×${b.simulations} (${b.worlds * b.simulations} simulations/décision)`);
  return makeValueAgent(model, cardIndex, corpusMap, b);
}
