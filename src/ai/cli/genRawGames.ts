// Sharded raw self-play generator. Samples weighted match-ups from the corpus train
// decks (the chosen held-out fold is excluded, so nothing leaks), plays heuristic
// self-play under the determinism guard, and writes raw games (they can be encoded
// again later), stuck/draw logs and a version-stamped manifest.
//
//   npx tsx src/ai/cli/genRawGames.ts --games 5000 --shard 0 --heldout-fold 0 --out dataset/games
//
// Output: <out>.<shard>.jsonl  (+ .stuck.jsonl, .draw.jsonl, .nondeterm.jsonl, .meta.json)
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { cards } from "../../engine/testkit";
import { Rng } from "../../engine/rng";
import { HeuristicAgent } from "../agents/HeuristicAgent";
import type { Agent } from "../agents/Agent";
import { loadCorpus } from "../corpus/loader";
import { CorpusSampler } from "../corpus/sample";
import { trainDecks } from "../corpus/splits";
import { buildCorpusBelief } from "../belief/corpus";
import { buildCardIndex2 } from "../encode2";
import { loadTsValueModel } from "../net/loadTsValueModel";
import { makeValueAgent } from "../agents/valueAgent";
import { QAgent } from "../agents/QAgent";
import { recordGameRaw, type RawMatchup } from "../selfplay/recordRaw";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const GAMES = parseInt(arg("--games", "1000"), 10);
const SHARD = parseInt(arg("--shard", "0"), 10);
const SEED_BASE = parseInt(arg("--seed", "1"), 10);
const HELDOUT = parseInt(arg("--heldout-fold", "0"), 10); // -1 = use all decks (no held-out)
const ALPHA = parseFloat(arg("--alpha", "1")); // 1 = god-normalized (cover all match-ups)
const OUT = arg("--out", "dataset/games");
// On-policy iteration: when set, self-play uses the value-net DetMCTS (the strong
// agent) instead of the heuristic → games of much higher quality, so re-encoding +
// retraining the value net learns position value under strong play (raises the
// ceiling past heuristic-imitation). Slow (~15s/game vs ~0.4s).
const VALUE_MODEL = arg("--value-model", "");
// DMC self-play: QAgent (afterstate-greedy over the DMC net, SEARCH-FREE, ~15x
// faster than value-MCTS) with epsilon-greedy exploration. Generates the next
// iteration's training games (encodeAfterstate → train dmc_f{n+1}).
const Q_MODEL = arg("--q-model", "");
const EPSILON = parseFloat(arg("--epsilon", "0.1"));
const WORLDS = parseInt(arg("--worlds", "2"), 10);
const SIMS = parseInt(arg("--sims", "20"), 10);
const MAXBRANCH = parseInt(arg("--maxBranch", "8"), 10);
// Opening temperature (wave 3+): sample the root action ∝ visits^(1/T) while
// turn <= N, diversifies self-play lines; 0 = off (greedy, pre-wave-3 behavior).
const EXPLORE_TURNS = parseInt(arg("--explore-turns", "0"), 10);
const EXPLORE_TEMP = parseFloat(arg("--explore-temp", "1"));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.resolve(HERE, "../../../decks-corpus");
const VOCAB = path.resolve(HERE, "../vocab.json");

// Reduced-world campaign: restrict the corpus to an explicit deckId whitelist
// (comma-separated prefixes). The belief tables and the sampler then only use that
// small world, which gives dense coverage of each situation.
const DECK_FILTER = arg("--deck-filter", "");
// v2 recording: store the pooled visit distribution + root value per searched
// decision inside each RawGame (soft policy targets + mixed value labels).
const RECORD_PI = process.argv.includes("--record-pi");

const pool = cards();
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
  if (train.length !== prefixes.length) {
    console.warn(`deck-filter: ${prefixes.length} ids demandes, ${train.length} decks trouves`);
  }
}
console.log(`corpus: ${decks.length} decks; training on ${train.length} (held-out fold ${HELDOUT}${DECK_FILTER ? ", deck-filter actif" : ""}); alpha=${ALPHA}`);

// Self-play agent: heuristic (fast) by default; value-net DetMCTS (on-policy) when
// a model is given. Stateless across decisions, so one instance serves both sides.
let selfPlayAgent: Agent | null = null;
if (VALUE_MODEL) {
  const vocab = JSON.parse(fs.readFileSync(VOCAB, "utf-8")) as { ids: number[] };
  const cardIndex = buildCardIndex2(vocab.ids);
  const corpusMap = buildCorpusBelief(train);
  const model = loadTsValueModel(VALUE_MODEL);
  selfPlayAgent = makeValueAgent(model, cardIndex, corpusMap, {
    worlds: WORLDS, simulations: SIMS, maxBranch: MAXBRANCH,
    explore: EXPLORE_TURNS > 0 ? { turns: EXPLORE_TURNS, temperature: EXPLORE_TEMP } : undefined,
  });
  console.log(`self-play teacher: value-MCTS DetMCTS(${WORLDS}x${SIMS}) from ${VALUE_MODEL}` +
    (EXPLORE_TURNS > 0 ? ` + explore(turns<=${EXPLORE_TURNS}, T=${EXPLORE_TEMP})` : ""));
}
if (Q_MODEL) {
  const vocab = JSON.parse(fs.readFileSync(VOCAB, "utf-8")) as { ids: number[] };
  const cardIndex = buildCardIndex2(vocab.ids);
  const f = loadTsValueModel(Q_MODEL);
  selfPlayAgent = new QAgent(f, cardIndex, EPSILON);
  console.log(`self-play: QAgent afterstate-greedy(eps=${EPSILON}) from ${Q_MODEL}`);
}
const agentTag = Q_MODEL ? `q-eps${EPSILON}` : VALUE_MODEL ? "value-mcts" : "heuristic";
const mkAgent = (): Agent => selfPlayAgent ?? new HeuristicAgent();

const sampler = new CorpusSampler(train);
const sampleRng = new Rng((SEED_BASE ^ (SHARD * 0x9e3779b9)) | 0);
const engineSha = (() => { try { return execSync("git rev-parse HEAD").toString().trim(); } catch { return "unknown"; } })();

fs.mkdirSync(path.dirname(path.resolve(`${OUT}.${SHARD}.jsonl`)) || ".", { recursive: true });
// Synchronous fds, not createWriteStream: the generation loop below is pure
// sync CPU for hours, so an async stream never gets an event-loop tick to even
// open its file, every "written" game sat in the stream's memory buffer until
// process end, and a crash/kill lost the whole shard. writeSync lands each
// game on disk the moment it finishes (~1 write / 30s with value-MCTS) and
// makes the .jsonl live-monitorable.
const openW = (suffix: string) => fs.openSync(`${OUT}.${SHARD}${suffix}`, "w");
const gamesFd = openW(".jsonl");
const stuckFd = openW(".stuck.jsonl");
const drawFd = openW(".draw.jsonl");
const ndFd = openW(".nondeterm.jsonl");
const wLine = (fd: number, o: unknown) => fs.writeSync(fd, JSON.stringify(o) + "\n");

let written = 0, stuck = 0, draws = 0, nonDeterm = 0;
const t0 = Date.now();

const ORIGINAL_RANDOM = Math.random;
Math.random = () => { throw new Error("Math.random() called inside seeded simulation"); };
try {
  for (let i = 0; i < GAMES; i++) {
    // The step of 10 keeps the last digit of the base on every game seed, which records
    // where the game was generated: ...1 = desktop, ...2 = laptop, ...3+ = cloud machines.
    const seed = SEED_BASE + SHARD * 10_000_000 + i * 10;
    const m = sampler.matchup(sampleRng, { alpha: ALPHA });
    const mu: RawMatchup = {
      a: { id: m.ally.deckId, god: m.ally.god, author: m.ally.author, tags: m.ally.tags, w: m.wA },
      e: { id: m.enemy.deckId, god: m.enemy.god, author: m.enemy.author, tags: m.enemy.tags, w: m.wB },
      wc: m.wCost,
    };
    let raw;
    try {
      raw = recordGameRaw(mkAgent(), mkAgent(), {
        decks: { ally: m.ally.cards, enemy: m.enemy.cards },
        seed,
        firstSide: m.firstSide,
        gods: { ally: m.ally.god, enemy: m.enemy.god },
        maxTurns: 200,
        maxPlies: 1500,
        mu,
        agents: { a: agentTag, e: agentTag },
        recordSearch: RECORD_PI,
        onStuck: (info) => { stuck++; wLine(stuckFd, info); console.warn(`\n[STUCK] seed=${info.seed} ${info.mu?.a.god} vs ${info.mu?.e.god} pending=${info.pending ?? "-"} -> DISCARDED`); },
      });
    } catch (e) {
      if (e instanceof Error && e.message.includes("Math.random")) { nonDeterm++; wLine(ndFd, { seed, mu }); console.warn(`\n[NON-DETERM] seed=${seed} ${m.ally.god} vs ${m.enemy.god} -> DISCARDED`); continue; }
      Math.random = ORIGINAL_RANDOM; throw e;
    }
    if (raw === null) continue; // stuck (logged)
    if (raw.res.w === 0) { draws++; wLine(drawFd, { seed, turns: raw.res.turns, mu }); continue; } // discard draws
    raw.eng = engineSha;
    wLine(gamesFd, raw);
    written++;
    if (i % 200 === 0) process.stdout.write(`  ${i}/${GAMES} | ${written} games, ${stuck} stuck, ${draws} draws, ${nonDeterm} nd\r`);
  }
} finally { Math.random = ORIGINAL_RANDOM; }

fs.closeSync(gamesFd); fs.closeSync(stuckFd); fs.closeSync(drawFd); fs.closeSync(ndFd);

const meta = {
  schema: "raw-v1", shard: SHARD, seedBase: SEED_BASE, heldOutFold: HELDOUT, alpha: ALPHA,
  engineSha, createdAt: new Date().toISOString(),
  trainDecks: train.length, requested: GAMES,
  teacher: VALUE_MODEL
    ? { model: VALUE_MODEL, worlds: WORLDS, sims: SIMS, maxBranch: MAXBRANCH, exploreTurns: EXPLORE_TURNS, exploreTemp: EXPLORE_TEMP }
    : "heuristic",
  counts: { written, discarded: { stuck, draws, nonDeterm } },
};
fs.writeFileSync(`${OUT}.${SHARD}.meta.json`, JSON.stringify(meta, null, 2));
console.log(`\ndone: ${written} raw games (+${stuck} stuck, ${draws} draws, ${nonDeterm} non-determ discarded) in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${OUT}.${SHARD}.jsonl`);
if (nonDeterm > 0) console.warn(`WARNING: NON-DETERMINISTIC games -> ${OUT}.${SHARD}.nondeterm.jsonl — engine bug, report.`);
