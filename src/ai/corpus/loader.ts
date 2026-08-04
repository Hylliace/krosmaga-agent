// Corpus loader. Reads decks-corpus/decks.json + weights.json and produces a
// weighted DeckEntry[] for self-play sampling. Node only (fs); used by the dataset
// generator and the deck tournament, not in the browser.
//
// Deck weight rule: the weight of a deck is the max of its tag multipliers, times
// its author multiplier, clamped to [floor, cap]. It is not the product of the
// tags, only the single strongest tag counts.
import * as fs from "node:fs";
import type { God } from "../../data/types";

export interface WeightsConfig {
  excludeGods?: string[];
  floor: number;
  cap: number;
  tagMultipliers: Record<string, number>;
  authorMultipliers: Record<string, number>;
}

export interface DeckEntry {
  deckId: string;
  name: string;
  god: God;            // normalized to the engine's God casing (ENUTROF -> "Enutrof")
  author: string;
  tags: string[];
  costAP: number;      // total deck PA cost, decides turn order (cheaper plays first)
  cards: number[];     // expanded card-id list, length 45
  weight: number;      // sampling + cost weight
}

// The 10 deck-identity gods (None/Rushu are not deck identities).
const DECK_GODS: readonly God[] = [
  "Iop", "Cra", "Eniripsa", "Ecaflip", "Enutrof", "Sram", "Xelor", "Sacrieur", "Feca", "Sadida",
];

/** Map a raw corpus god ("ENUTROF") to the engine God casing ("Enutrof"); "None" if unknown. */
export function normalizeGod(raw: string): God {
  if (!raw) return "None";
  const g = raw[0].toUpperCase() + raw.slice(1).toLowerCase();
  return (DECK_GODS as readonly string[]).includes(g) ? (g as God) : "None";
}

/** Deck weight = max(present tag multipliers) * author multiplier, clamped. */
export function deckWeight(tags: string[], author: string, w: WeightsConfig): number {
  const present = tags.map((t) => w.tagMultipliers[t]).filter((v): v is number => typeof v === "number");
  const tagFactor = present.length ? Math.max(...present) : 1;
  const authorFactor = w.authorMultipliers[author] ?? 1;
  return Math.max(w.floor, Math.min(w.cap, tagFactor * authorFactor));
}

export interface LoadOptions {
  // Validate every card id is known to the engine; decks with unknown ids are
  // skipped (they would crash replay). Pass `(id) => cards().has(id)` from the
  // caller (the loader stays engine-registry-agnostic).
  isKnownCard?: (id: number) => boolean;
  warn?: (msg: string) => void;
}

interface RawDeck {
  deckId: string;
  name?: string;
  god?: string;
  author?: string;
  tags?: string[];
  costAP?: number;
  cards?: Array<{ id: number; count: number }>;
}

/** Load + weight the corpus. Excludes weights.excludeGods (FECA), validates each
 *  deck (45 cards, all ids known if a validator is given, no duplicate deckId). */
export function loadCorpus(
  decksPath: string,
  weightsPath: string,
  opts: LoadOptions = {},
): { decks: DeckEntry[]; weights: WeightsConfig } {
  const weights = JSON.parse(fs.readFileSync(weightsPath, "utf-8")) as WeightsConfig;
  const exclude = new Set((weights.excludeGods ?? []).map((g) => g.toUpperCase()));
  const raw = JSON.parse(fs.readFileSync(decksPath, "utf-8")) as RawDeck[];

  const decks: DeckEntry[] = [];
  const seen = new Set<string>();
  for (const d of raw) {
    if (exclude.has((d.god ?? "").toUpperCase())) continue;
    if (seen.has(d.deckId)) { opts.warn?.(`duplicate deckId ${d.deckId} -> skipped`); continue; }
    const cards = (d.cards ?? []).flatMap((c) => Array(c.count).fill(c.id) as number[]);
    if (cards.length !== 45) { opts.warn?.(`deck ${d.deckId} (${d.name}) has ${cards.length} cards != 45 -> skipped`); continue; }
    if (opts.isKnownCard) {
      const missing = [...new Set(cards)].filter((id) => !opts.isKnownCard!(id));
      if (missing.length) { opts.warn?.(`deck ${d.deckId} (${d.name}) has unknown ids ${missing.slice(0, 5).join(",")} -> skipped`); continue; }
    }
    seen.add(d.deckId);
    const tags = d.tags ?? [];
    const author = d.author ?? "?";
    decks.push({
      deckId: d.deckId,
      name: d.name ?? "",
      god: normalizeGod(d.god ?? ""),
      author,
      tags,
      costAP: d.costAP ?? 0,
      cards,
      weight: deckWeight(tags, author, weights),
    });
  }
  return { decks, weights };
}
