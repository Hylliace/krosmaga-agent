// Dataset generator: runs many heuristic self-play games and streams the
// (encoded position, outcome) samples to a JSONL file, the training set of the
// value net. Run with tsx:
//
//   npx tsx src/ai/cli/genDataset.ts --games 2000 --out data/value.jsonl
//
// Writes <out> (one JSON object per line: {"v": ±1/0, "x": [floats]}) plus
// <out>.meta.json describing the encoding layout so the Python side can read it.
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { cards } from "../../engine/testkit"; // loads + registers the disk card pool
import { HeuristicAgent } from "../agents/HeuristicAgent";
import { recordGame } from "../selfplay/record";
import { buildCardIndex, encodingLength, N_PLANES, N_GLOBALS, PLANES, GLOBALS } from "../encode";
import { BOARD_ROWS, BOARD_COLS } from "../../engine/board";

// Default self-play deck, derived from whatever pool is on disk rather than
// shipped as a curated list: the 15 cheapest summons, three copies each (45 is
// the legal deck size). Sorted by id so the same extraction always yields the
// same deck, self-play data must stay reproducible. Pass `--deck <file.json>`
// (an array of 45 card ids) to play a real decklist instead.
function defaultDeck(): number[] {
  const summons = [...cards().values()]
    .filter((c) => c.cardType === "Summon")
    .sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0) || a.id - b.id)
    .slice(0, 15);
  if (summons.length < 15) throw new Error("card pool too small to build a default deck");
  return summons.flatMap((c) => [c.id, c.id, c.id]);
}

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const games = parseInt(arg("--games", "200"), 10);
const out = arg("--out", "data/value.jsonl");
const seed0 = parseInt(arg("--seed", "1"), 10);

cards(); // populate the registry
const deckFile = arg("--deck", "");
const deck: number[] = deckFile ? JSON.parse(fs.readFileSync(deckFile, "utf-8")) : defaultDeck();
const cardIndex = buildCardIndex(deck);

fs.mkdirSync(path.dirname(path.resolve(out)) || ".", { recursive: true });
const ws = fs.createWriteStream(out);
const round = (v: number) => Math.round(v * 1e4) / 1e4; // shrink the file a bit

// Non-terminating games (engine/card bugs) are discarded and logged here so they
// can be debugged: each line replays from its seed and names the looping cycle.
const stuckPath = out.replace(/\.jsonl$/, "") + ".stuck.jsonl";
const stuckWs = fs.createWriteStream(stuckPath);

// Non-deterministic games (a Math.random fired in seeded sim) are discarded here.
const ndPath = out.replace(/\.jsonl$/, "") + ".nondeterm.jsonl";
const ndWs = fs.createWriteStream(ndPath);

let nSamples = 0;
let aborted = 0;
let draws = 0;
let nonDeterm = 0;
const t0 = Date.now();

// Determinism guard: patch Math.random to throw for the whole seeded simulation.
// Any hit means an engine path did not use the seeded GameState.rng; that game is
// dropped and logged (so coverage grows with real data, on top of the separate
// checkDeterminism check). The agent RNG is the seeded Rng class, never
// Math.random, so this cannot give false positives here.
const ORIGINAL_RANDOM = Math.random;
Math.random = () => { throw new Error("Math.random() called inside seeded simulation"); };
try {
  for (let g = 0; g < games; g++) {
    let samples;
    try {
      samples = recordGame(new HeuristicAgent(), new HeuristicAgent(), {
        decks: { ally: deck, enemy: deck },
        seed: seed0 + g,
        cardIndex,
        maxTurns: 200,
        maxPlies: 1500,
        onStuck: (info) => {
          aborted++;
          stuckWs.write(JSON.stringify(info) + "\n");
          console.warn(`\n[STUCK] seed=${info.seed} turn=${info.turn} ${info.side} plies=${info.plies} pending=${info.pending ?? "-"} -> DISCARDED`);
        },
        onDraw: () => { draws++; },
      });
    } catch (e) {
      if (e instanceof Error && e.message.includes("Math.random")) {
        nonDeterm++;
        ndWs.write(JSON.stringify({ seed: seed0 + g }) + "\n");
        console.warn(`\n[NON-DETERM] seed=${seed0 + g} hit Math.random in sim -> DISCARDED`);
        continue;
      }
      Math.random = ORIGINAL_RANDOM;
      throw e;
    }
    for (const s of samples) {
      ws.write(JSON.stringify({ v: s.value, x: Array.from(s.enc, round) }) + "\n");
      nSamples++;
    }
    if (g % 100 === 0) process.stdout.write(`  ${g}/${games} games, ${nSamples} samples, ${aborted} stuck, ${draws} draws\r`);
  }
} finally {
  Math.random = ORIGINAL_RANDOM;
}
ws.end();
stuckWs.end();
ndWs.end();

const engineSha = (() => { try { return execSync("git rev-parse HEAD").toString().trim(); } catch { return "unknown"; } })();

const meta = {
  encodingLength: encodingLength(cardIndex.size),
  board: { planes: N_PLANES, rows: BOARD_ROWS, cols: BOARD_COLS, names: PLANES },
  globals: { count: N_GLOBALS, names: GLOBALS },
  vocab: [...cardIndex.keys()], // card ids, in encoding order, for the hand multi-hot
  deck,
  games,
  samples: nSamples,
  // Version stamp: an engine or code change invalidates old shards.
  engineSha,
  createdAt: new Date().toISOString(),
  discarded: { stuck: aborted, draws, nonDeterministic: nonDeterm },
};
fs.writeFileSync(out.replace(/\.jsonl$/, "") + ".meta.json", JSON.stringify(meta, null, 2));

console.log(
  `\ndone: ${games} games → ${nSamples} samples → ${out} ` +
    `(${(Date.now() - t0) / 1000}s, enc length ${meta.encodingLength})`,
);
console.log(`discarded: ${aborted} stuck, ${draws} draws, ${nonDeterm} non-deterministic`);
if (aborted > 0) console.warn(`WARNING: stuck games -> ${stuckPath}`);
if (nonDeterm > 0) console.warn(`WARNING: NON-DETERMINISTIC games (Math.random in sim) -> ${ndPath} — engine bug, report.`);
