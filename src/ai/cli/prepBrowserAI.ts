// Prepare the browser-servable bundle for the in-game value-net AI: copy the model
// weights + manifest + vocab into public/ai/, and write the TRAIN-fold decklists
// (minimal fields) so the browser can rebuild the belief corpus (buildCorpusBelief
// is pure + browser-safe; it only needs {god, cards, deckId}).
//
//   npx tsx src/ai/cli/prepBrowserAI.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { cards } from "../../engine/testkit";
import { loadCorpus } from "../corpus/loader";
import { trainDecks } from "../corpus/splits";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../../..");
const CORPUS = path.resolve(APP, "decks-corpus");
const MODELS = path.resolve(APP, "data/models");
const OUT = path.resolve(APP, "public/ai");
const FOLD = 0;

function main(): void {
  fs.mkdirSync(OUT, { recursive: true });

  // 1. model weights + manifest + vocab
  for (const f of ["value.weights.f32", "value.manifest.json"]) {
    fs.copyFileSync(path.join(MODELS, f), path.join(OUT, f));
  }
  fs.copyFileSync(path.resolve(HERE, "../vocab.json"), path.join(OUT, "vocab.json"));

  // 2. train-fold decklists for the belief corpus (minimal fields)
  const pool = cards();
  const { decks } = loadCorpus(path.join(CORPUS, "decks.json"), path.join(CORPUS, "weights.json"), { isKnownCard: (id) => pool.has(id) });
  const splits = JSON.parse(fs.readFileSync(path.join(CORPUS, "splits.json"), "utf-8"));
  const train = trainDecks(decks, splits, FOLD);
  const slim = train.map((d) => ({ deckId: d.deckId, god: d.god, cards: d.cards }));
  fs.writeFileSync(path.join(OUT, "train_decks.json"), JSON.stringify(slim));

  const wbytes = fs.statSync(path.join(OUT, "value.weights.f32")).size;
  console.log(`browser AI bundle -> ${OUT}`);
  console.log(`  value.weights.f32 ${(wbytes / 1e6).toFixed(2)} MB, vocab + manifest, ${train.length} train decks`);
}

main();
