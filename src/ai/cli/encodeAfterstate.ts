// DMC afterstate encoder CLI. Re-encodes raw self-play shards into afterstate
// value samples (encodeAfterstate.ts), the training set for the DMC Q-net.
//
//   npx tsx src/ai/cli/encodeAfterstate.ts --in data/rw1/games.0.jsonl --out data/enc_after/g0 --stride 2
//
// Output matches encodeRaw (train.py reads it unchanged):
//   <out>.x.f32 / <out>.y.f32 / <out>.idx.u32 / <out>.meta.json
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { cards } from "../../engine/testkit";
import { buildCardIndex2, encodingLength2 } from "../encode2";
import { encodeAfterstateGame } from "../selfplay/encodeAfterstate";
import type { RawGame } from "../selfplay/recordRaw";
import { loadCorpus } from "../corpus/loader";
import { buildCorpusBelief } from "../belief/corpus";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const IN = arg("--in", "data/rw1/games.0.jsonl");
const OUT = arg("--out", "data/enc_after/g0");
const STRIDE = parseInt(arg("--stride", "1"), 10);
const DECK_FILTER = arg("--deck-filter", ""); // keep only games whose both decks match a whitelisted prefix
const BELIEF = process.argv.includes("--belief"); // fill foe channels from belief (for SEARCH-LEAF use, not greedy)

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VOCAB = path.resolve(HERE, "../vocab.json");
const CORPUS = path.resolve(HERE, "../../../decks-corpus");

function deckOk(raw: RawGame, prefixes: string[]): boolean {
  if (prefixes.length === 0) return true;
  const a = raw.mu?.a.id ?? "", e = raw.mu?.e.id ?? "";
  const hit = (id: string) => prefixes.some((p) => id.startsWith(p));
  return hit(a) && hit(e);
}

async function main(): Promise<void> {
  cards(); // register card definitions into the global registry (applyAction needs them)
  const vocab = JSON.parse(fs.readFileSync(VOCAB, "utf-8")) as { ids: number[] };
  const cardIndex = buildCardIndex2(vocab.ids);
  const encLen = encodingLength2(cardIndex);
  const prefixes = DECK_FILTER.split(",").map((s) => s.trim()).filter(Boolean);
  // belief tables (only when --belief): restrict to the whitelisted world.
  let corpusMap;
  if (BELIEF) {
    const pool = cards();
    const { decks } = loadCorpus(path.join(CORPUS, "decks.json"), path.join(CORPUS, "weights.json"), { isKnownCard: (id) => pool.has(id) });
    const world = prefixes.length ? decks.filter((d) => prefixes.some((p) => (d.deckId ?? "").startsWith(p))) : decks;
    corpusMap = buildCorpusBelief(world);
  }
  console.log(`afterstate encode: encLen ${encLen}, stride ${STRIDE}${prefixes.length ? `, deck-filter ${prefixes.length}` : ""}${BELIEF ? ", belief ON" : ""}`);

  fs.mkdirSync(path.dirname(path.resolve(`${OUT}.x.f32`)) || ".", { recursive: true });
  const xWs = fs.createWriteStream(`${OUT}.x.f32`);
  const yWs = fs.createWriteStream(`${OUT}.y.f32`);
  const idxWs = fs.createWriteStream(`${OUT}.idx.u32`);

  let nGames = 0, nRows = 0, dDraw = 0, dMismatch = 0, dDeck = 0, gameOrd = 0;
  const t0 = Date.now();
  const ORIGINAL_RANDOM = Math.random;
  Math.random = () => { throw new Error("Math.random() called inside seeded replay"); };
  try {
    const rl = readline.createInterface({ input: fs.createReadStream(IN), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      const raw = JSON.parse(line) as RawGame;
      if (!deckOk(raw, prefixes)) { dDeck++; continue; }
      const ord = gameOrd++;
      const r = encodeAfterstateGame(raw, { cardIndex, stride: STRIDE, corpusMap });
      if (r.dropped === "draw") { dDraw++; continue; }
      if (r.dropped === "result-mismatch") { dMismatch++; continue; }
      nGames++;
      for (const s of r.samples) {
        xWs.write(Buffer.from(s.x.buffer, s.x.byteOffset, s.x.byteLength));
        const yb = Buffer.alloc(4); yb.writeFloatLE(s.y, 0); yWs.write(yb);
        const ib = Buffer.alloc(4); ib.writeUInt32LE(ord, 0); idxWs.write(ib);
        nRows++;
      }
      if (gameOrd % 200 === 0) process.stdout.write(`  ${gameOrd} games -> ${nRows} rows (${dMismatch} mismatch, ${dDeck} off-world)\r`);
    }
  } finally { Math.random = ORIGINAL_RANDOM; }

  await Promise.all([endWs(xWs), endWs(yWs), endWs(idxWs)]);
  const meta = {
    schema: "enc-v2", encLen, vocabSize: cardIndex.size + 1, stride: STRIDE, heldOutFold: -1,
    kind: "afterstate-dmc", createdAt: new Date().toISOString(),
    counts: { games: nGames, rows: nRows, dropped: { draws: dDraw, mismatch: dMismatch, offWorld: dDeck } }, in: IN,
  };
  fs.writeFileSync(`${OUT}.meta.json`, JSON.stringify(meta, null, 2));
  console.log(`\ndone: ${nRows} rows from ${nGames} games (${dDraw} draws, ${dMismatch} mismatch, ${dDeck} off-world) in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${OUT}.x.f32`);
}
function endWs(ws: fs.WriteStream): Promise<void> { return new Promise((res) => ws.end(res)); }
main();
