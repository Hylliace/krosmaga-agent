// Pinpoint the exact engine call sites that fall back to Math.random (the
// rng-threading gap). Records weighted self-play under a Math.random tripwire
// that throws with A stack; we collect the distinct top engine frames so we know
// precisely which effect path failed to thread state.rng.
//   npx tsx src/ai/cli/traceRandom.ts --games 800
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { cards } from "../../engine/testkit";
import { Rng } from "../../engine/rng";
import { HeuristicAgent } from "../agents/HeuristicAgent";
import { loadCorpus } from "../corpus/loader";
import { CorpusSampler } from "../corpus/sample";
import { recordGameRaw } from "../selfplay/recordRaw";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const GAMES = parseInt(arg("--games", "800"), 10);

cards();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.resolve(HERE, "../../../decks-corpus");
const { decks } = loadCorpus(path.join(CORPUS, "decks.json"), path.join(CORPUS, "weights.json"), { isKnownCard: () => true });
const sampler = new CorpusSampler(decks);
const rng = new Rng(20260629);

const ORIGINAL_RANDOM = Math.random;
const sites = new Map<string, { count: number; example: string; seed: number; mu: string }>();

// First engine frame (rules.ts / effects.ts …) in a stack, the actual culprit.
function engineFrame(stack: string): string {
  const lines = stack.split("\n");
  for (const l of lines) {
    const m = l.match(/\\engine\\([a-zA-Z]+\.ts):(\d+):(\d+)/) || l.match(/\/engine\/([a-zA-Z]+\.ts):(\d+):(\d+)/);
    if (m) return `${m[1]}:${m[2]}`;
  }
  // fall back to first app frame
  for (const l of lines) { const m = l.match(/src[\\/](.+?):(\d+):\d+/); if (m) return `${m[1]}:${m[2]}`; }
  return "unknown";
}

let nd = 0;
for (let i = 0; i < GAMES; i++) {
  const m = sampler.matchup(rng, { alpha: 1 });
  const seed = 1_000_000 + i;
  Math.random = () => { throw new Error("TRIP"); };
  try {
    recordGameRaw(new HeuristicAgent(), new HeuristicAgent(), {
      decks: { ally: m.ally.cards, enemy: m.enemy.cards }, seed, firstSide: m.firstSide,
      gods: { ally: m.ally.god, enemy: m.enemy.god }, maxTurns: 200, maxPlies: 1500,
    });
  } catch (e) {
    Math.random = ORIGINAL_RANDOM;
    if (e instanceof Error && e.message === "TRIP") {
      nd++;
      const frame = engineFrame(e.stack ?? "");
      const muStr = `${m.ally.god} vs ${m.enemy.god}`;
      const cur = sites.get(frame);
      if (cur) cur.count++;
      else sites.set(frame, { count: 1, example: (e.stack ?? "").split("\n").slice(1, 6).join("\n"), seed, mu: muStr });
      continue;
    }
    throw e;
  }
  Math.random = ORIGINAL_RANDOM;
  if (i % 100 === 0) process.stderr.write(`\r  ${i}/${GAMES} (nondeterm=${nd})    `);
}

console.log(`\n=== ${nd}/${GAMES} games hit Math.random; ${sites.size} distinct engine site(s) ===\n`);
for (const [frame, info] of [...sites].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  ${frame}   x${info.count}   (e.g. ${info.mu}, seed ${info.seed})`);
  console.log(info.example.split("\n").map((l) => "      " + l.trim()).join("\n"));
  console.log("");
}
