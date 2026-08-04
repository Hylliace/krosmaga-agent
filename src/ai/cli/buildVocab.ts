// Freeze the global card vocabulary (vocab.json). The encoder's 4 V-vectors
// (hand multi-hot, hand cost, deck remaining, opponent belief) are indexed by this
// fixed id-to-column map; freezing it once means TS and any later re-encode agree
// on the layout. A per-deck vocab would quietly zero every hand card that is not in
// the deck, so the frozen vocab has to cover every id that can be in a hand. It is
// the union of:
//   (a) every registered card that is not a token (all deck-eligible spells/summons),
//   (b) the generated reward cards that end up in hand (Pelle/Élixir/Pioche/Fléau),
//   (c) every id that appears in any corpus deck (just in case).
// Anything still outside (a rare bounced token) goes to the reserved OOV slot of
// encode2, and is counted. Run: `npx tsx src/ai/cli/buildVocab.ts`.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Card } from "../../data/types";
import { registerCards } from "../../engine/cardRegistry";
import { isToken } from "../../engine/rules";
import { GENERATED_REWARD } from "../belief/realDeckCard";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "../../..");
const DATA_DIR = path.resolve(APP_ROOT, "public/data");
const CORPUS = path.resolve(APP_ROOT, "decks-corpus/decks.json");
const OUT = path.resolve(HERE, "../vocab.json");

function loadPool(): Card[] {
  const pool: Card[] = [];
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!/^cards_.*\.json$/.test(f)) continue;
    const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf-8"));
    const list: Card[] = Array.isArray(d) ? d : (d.cards ?? []);
    pool.push(...list);
  }
  return pool;
}

function main(): void {
  const pool = loadPool();
  registerCards(pool); // so isToken() can classify

  const ids = new Set<number>();
  let nonToken = 0;
  for (const c of pool) {
    if (!isToken(c.id)) { ids.add(c.id); nonToken++; }
  }
  for (const id of GENERATED_REWARD) ids.add(id);

  const corpus = JSON.parse(fs.readFileSync(CORPUS, "utf-8")) as Array<{
    cards?: Array<{ id: number; count: number }>;
  }>;
  let corpusOnly = 0;
  for (const d of corpus)
    for (const c of d.cards ?? []) {
      if (!ids.has(c.id)) corpusOnly++;
      ids.add(c.id);
    }

  const sorted = [...ids].sort((a, b) => a - b);
  const json = {
    version: 1,
    note: "Frozen global card vocabulary for encode2 (M6). OOV ids route to the reserved last column (index = ids.length).",
    count: sorted.length,
    ids: sorted,
  };
  fs.writeFileSync(OUT, JSON.stringify(json) + "\n");
  // eslint-disable-next-line no-console
  console.log(
    `vocab.json: ${sorted.length} ids (non-token registered ${nonToken}, +rewards, +${corpusOnly} corpus-only) -> ${OUT}`,
  );
}

main();
