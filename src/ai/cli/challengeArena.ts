// Challenger arena: plays any agent against the champion, in paired mode.
//
// The module passed with --agent must export makeChallenger(ctx) -> Agent
// (see agents/ChallengerAgent.example.ts). The champion is the value network + PIMC at
// the budget --worlds x --sims (default 2x80, where the search saturates). Each matchup
// is played twice, same decks, same seed, seats swapped; the output can be read by
// cli/pairedVerdict.ts (verdict by pair, the only valid analysis). --record writes the
// games in the raw format (raw-v1 jsonl): they can be encoded again for training, or
// converted to replays (cli/rawToReplay.ts).
//
//   npx tsx src/ai/cli/challengeArena.ts --agent src/ai/agents/MyAgent.ts --games 100 --seed 910000
//   npx tsx src/ai/cli/pairedVerdict.ts data/arena_ab/challenger_*.log
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cards } from "../../engine/testkit";
import { Rng } from "../../engine/rng";
import { loadCorpus } from "../corpus/loader";
import { CorpusSampler } from "../corpus/sample";
import { trainDecks, heldOutDecks } from "../corpus/splits";
import { buildCorpusBelief, type CorpusBelief } from "../belief/corpus";
import { buildCardIndex2 } from "../encode2";
import { loadTsValueModel } from "../net/loadTsValueModel";
import type { TsValueModel } from "../net/TsValueModel";
import { makeValueAgent } from "../agents/valueAgent";
import type { Agent } from "../agents/Agent";
import type { God } from "../../data/types";
import { recordGameRaw, type RawMatchup } from "../selfplay/recordRaw";

/** What the arena gives the challenger: the same material as the champion. */
export interface ChallengerContext {
  model: TsValueModel;               // the champion value network (reuse it or not)
  cardIndex: Map<number, number>;    // frozen vocabulary: card id -> column
  corpusMap: Map<God, CorpusBelief>; // belief tables (training decks)
}

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const AGENT = arg("--agent", "");
const GAMES = parseInt(arg("--games", "40"), 10);
const WORLDS = parseInt(arg("--worlds", "2"), 10);
const SIMS = parseInt(arg("--sims", "80"), 10);
const MAXBRANCH = parseInt(arg("--maxBranch", "12"), 10);
const FOLD = parseInt(arg("--fold", "0"), 10);
const MODEL = arg("--model", "data/models/value5");
const SEED = parseInt(arg("--seed", "1"), 10);
const DECK_FILTER = arg("--deck-filter", "");
const RECORD = arg("--record", "");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../../..");
const CORPUS = path.resolve(APP, "decks-corpus");

function wilson(w: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96, p = w / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}

async function main(): Promise<void> {
  if (!AGENT) {
    console.error("usage: challengeArena --agent <module exporting makeChallenger(ctx)> [--games N] [--seed S] [--record out.jsonl]");
    process.exit(2);
  }
  const pool = cards();
  const vocab = JSON.parse(fs.readFileSync(path.resolve(APP, "src/ai/vocab.json"), "utf-8")) as { ids: number[] };
  const cardIndex = buildCardIndex2(vocab.ids);
  const { decks } = loadCorpus(path.join(CORPUS, "decks.json"), path.join(CORPUS, "weights.json"), { isKnownCard: (id) => pool.has(id) });
  const splits = JSON.parse(fs.readFileSync(path.join(CORPUS, "splits.json"), "utf-8"));
  const corpusMap = buildCorpusBelief(trainDecks(decks, splits, FOLD));
  const world = DECK_FILTER
    ? decks.filter((d) => DECK_FILTER.split(",").some((p) => (d.deckId ?? "").startsWith(p.trim())))
    : heldOutDecks(decks, splits, FOLD);
  const model = loadTsValueModel(path.resolve(APP, MODEL));

  const mod = (await import(pathToFileURL(path.resolve(APP, AGENT)).href)) as { makeChallenger?: (ctx: ChallengerContext) => Agent };
  if (typeof mod.makeChallenger !== "function") throw new Error(`${AGENT}: the module must export makeChallenger(ctx)`);
  const challenger = mod.makeChallenger({ model, cardIndex, corpusMap });
  const champion = makeValueAgent(model, cardIndex, corpusMap, { worlds: WORLDS, simulations: SIMS, maxBranch: MAXBRANCH });
  const monde = DECK_FILTER ? "filtered decks" : `fold ${FOLD} held out`;
  console.log(`${world.length} decks (${monde}); A = ${challenger.name} vs B = champion ${MODEL} DetMCTS(${WORLDS}x${SIMS}); ${GAMES} paired games (${GAMES >> 1} deals x2)`);

  const sampler = new CorpusSampler(world);
  const sampleRng = new Rng((SEED ^ 0x51ed) | 0);
  const fd = RECORD ? fs.openSync(path.resolve(APP, RECORD), "a") : -1;
  let wins = 0, decided = 0, draws = 0, errors = 0;
  let pairM: ReturnType<typeof sampler.matchup> | null = null;
  const t0 = Date.now();
  for (let i = 0; i < GAMES; i++) {
    const m = i % 2 === 0 ? (pairM = sampler.matchup(sampleRng, { alpha: 1 })) : pairM!;
    const gameSeed = SEED + (i >> 1);
    const aIsAlly = i % 2 === 0;
    const mu: RawMatchup = {
      a: { id: m.ally.deckId, god: m.ally.god, author: m.ally.author, tags: m.ally.tags },
      e: { id: m.enemy.deckId, god: m.enemy.god, author: m.enemy.author, tags: m.enemy.tags },
    };
    let raw;
    try {
      raw = recordGameRaw(aIsAlly ? challenger : champion, aIsAlly ? champion : challenger, {
        decks: { ally: m.ally.cards, enemy: m.enemy.cards }, seed: gameSeed, firstSide: m.firstSide,
        gods: { ally: m.ally.god, enemy: m.enemy.god }, maxTurns: 200, maxPlies: 1500, mu,
      });
    } catch (e) {
      errors++;
      console.warn(`\n[ERROR] seed=${gameSeed} ${m.ally.god} vs ${m.enemy.god}: ${e instanceof Error ? e.message.split("\n")[0] : e} -> SKIPPED`);
      continue;
    }
    if (raw && fd >= 0) fs.writeSync(fd, JSON.stringify({ ...raw, challengerSide: aIsAlly ? "ally" : "enemy" }) + "\n");
    if (!raw || raw.res.w === 0) { draws++; continue; }
    decided++;
    if ((raw.res.w === 1) === aIsAlly) wins++;
    process.stdout.write(`  game ${i + 1}/${GAMES} | A ${wins}/${decided} = ${((100 * wins) / decided).toFixed(1)}% | ${draws} draws | ${((Date.now() - t0) / 1000 / (i + 1)).toFixed(1)}s/game\r`);
  }
  if (fd >= 0) fs.closeSync(fd);
  const [lo, hi] = wilson(wins, decided);
  console.log(`\n\nRESULT: A ${wins}/${decided} decided = ${decided ? ((100 * wins) / decided).toFixed(1) : "0.0"}% (Wilson95 [${(lo * 100).toFixed(1)}%, ${(hi * 100).toFixed(1)}%]), ${draws} draws, ${errors} errors`);
  console.log("The marginal rate is only indicative: read the verdict by pair -> npx tsx src/ai/cli/pairedVerdict.ts <this log>");
}
main().catch((e) => { console.error(e); process.exit(1); });
