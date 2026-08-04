// Re-encode raw self-play shards into binary f32 value-net samples.
//
//   npx tsx src/ai/cli/encodeRaw.ts --in dataset/games.0.jsonl --out dataset/enc/games.0 --heldout-fold 0
//
// Output (parallel arrays, aligned by row):
//   <out>.x.f32   Float32  nRows × encLen   (encode2 inputs)
//   <out>.y.f32   Float32  nRows            (label ∈ {+1,-1})
//   <out>.idx.u32 Uint32   nRows            (game ordinal: group by game to avoid
//                                            train/val leakage and intra-turn correlation)
//   <out>.meta.json
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { cards } from "../../engine/testkit";
import { loadCorpus } from "../corpus/loader";
import { buildCorpusBelief } from "../belief/corpus";
import { trainDecks } from "../corpus/splits";
import { buildCardIndex2, encodingLength2 } from "../encode2";
import { encodingLength3, N_PLANES3, N_GLOBALS3, N_V3 } from "../encode3";
import { encodeRawGame } from "../selfplay/encodeRaw";
import type { RawGame } from "../selfplay/recordRaw";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const IN = arg("--in", "dataset/games.0.jsonl");
const OUT = arg("--out", "dataset/enc/games.0");
const HELDOUT = parseInt(arg("--heldout-fold", "0"), 10); // -1 = all decks (must match generation)
const STRIDE = parseInt(arg("--stride", "1"), 10);
const ENC = arg("--enc", "v2") as "v2" | "v3"; // v3 = complete-observation encoder
// Reduced-world: belief restricted to the same deck whitelist as generation.
const DECK_FILTER = arg("--deck-filter", "");
// Mixed value label λ: y = (1-λ)·z + λ·rv (needs --record-pi raws). 0 = pure z.
const MIX_VALUE = parseFloat(arg("--mix-value", "0"));
const PERFECT_INFO = process.argv.includes("--perfect-info");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.resolve(HERE, "../../../decks-corpus");
const VOCAB = path.resolve(HERE, "../vocab.json");

async function main(): Promise<void> {
  const pool = cards();
  const vocab = JSON.parse(fs.readFileSync(VOCAB, "utf-8")) as { ids: number[] };
  const cardIndex = buildCardIndex2(vocab.ids);
  const encLen = ENC === "v3" ? encodingLength3(cardIndex) : encodingLength2(cardIndex);

  const { decks } = loadCorpus(path.join(CORPUS, "decks.json"), path.join(CORPUS, "weights.json"), {
    isKnownCard: (id) => pool.has(id),
  });
  let train = decks;
  if (HELDOUT >= 0) {
    const splits = JSON.parse(fs.readFileSync(path.join(CORPUS, "splits.json"), "utf-8"));
    train = trainDecks(decks, splits, HELDOUT);
  }
  if (DECK_FILTER) {
    const prefixes = DECK_FILTER.split(",").map((s) => s.trim()).filter(Boolean);
    train = decks.filter((d) => prefixes.some((p) => (d.deckId ?? "").startsWith(p)));
  }
  const corpusMap = buildCorpusBelief(train);
  console.log(`vocab ${vocab.ids.length} ids, encLen ${encLen}; belief on ${train.length} train decks (fold ${HELDOUT}${DECK_FILTER ? ", deck-filter" : ""}${MIX_VALUE > 0 ? `, mix-value ${MIX_VALUE}` : ""})`);

  fs.mkdirSync(path.dirname(path.resolve(`${OUT}.x.f32`)) || ".", { recursive: true });
  const xWs = fs.createWriteStream(`${OUT}.x.f32`);
  const yWs = fs.createWriteStream(`${OUT}.y.f32`);
  const idxWs = fs.createWriteStream(`${OUT}.idx.u32`);

  let nGames = 0, nRows = 0, dDraw = 0, dMismatch = 0, gameOrd = 0;
  const t0 = Date.now();

  const ORIGINAL_RANDOM = Math.random;
  Math.random = () => { throw new Error("Math.random() called inside seeded replay"); };
  try {
    const rl = readline.createInterface({ input: fs.createReadStream(IN), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      const raw = JSON.parse(line) as RawGame;
      const ord = gameOrd++;
      const r = encodeRawGame(raw, { cardIndex, corpusMap, stride: STRIDE, encoder: ENC, mixValue: MIX_VALUE, perfectInfo: PERFECT_INFO });
      if (r.dropped === "draw") { dDraw++; continue; }
      if (r.dropped === "result-mismatch") { dMismatch++; continue; }
      nGames++;
      for (const s of r.samples) {
        xWs.write(Buffer.from(s.x.buffer, s.x.byteOffset, s.x.byteLength));
        const yb = Buffer.alloc(4); yb.writeFloatLE(s.y, 0); yWs.write(yb);
        const ib = Buffer.alloc(4); ib.writeUInt32LE(ord, 0); idxWs.write(ib);
        nRows++;
      }
      if (gameOrd % 200 === 0) process.stdout.write(`  ${gameOrd} games -> ${nRows} rows (${dMismatch} mismatch)\r`);
    }
  } finally { Math.random = ORIGINAL_RANDOM; }

  await Promise.all([endWs(xWs), endWs(yWs), endWs(idxWs)]);

  const engineSha = (() => { try { return execSync("git rev-parse HEAD").toString().trim(); } catch { return "unknown"; } })();
  const meta = {
    schema: ENC === "v3" ? "enc-v3" : "enc-v2", encLen, vocabSize: cardIndex.size + 1,
    // v3: the layout travels with the shard so data.py/model.py size themselves
    // from it (v2 shards omit these and fall back to the frozen 43/91/4).
    ...(ENC === "v3" ? { nPlanes: N_PLANES3, nGlobals: N_GLOBALS3, nV: N_V3 } : {}),
    stride: STRIDE, heldOutFold: HELDOUT,
    engineSha, createdAt: new Date().toISOString(),
    counts: { games: nGames, rows: nRows, dropped: { draws: dDraw, mismatch: dMismatch } },
    in: IN,
  };
  fs.writeFileSync(`${OUT}.meta.json`, JSON.stringify(meta, null, 2));
  console.log(`\ndone: ${nRows} rows from ${nGames} games (${dDraw} draws, ${dMismatch} mismatch dropped) in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${OUT}.x.f32`);
  if (dMismatch > 0) console.warn(`WARNING: ${dMismatch} replay mismatches — engine drift vs the generation sha; re-generate or re-check determinism.`);
}

function endWs(ws: fs.WriteStream): Promise<void> {
  return new Promise((res) => ws.end(res));
}

main();
