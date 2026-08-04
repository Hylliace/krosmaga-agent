// Generate policy+value training samples by DetMCTS self-play. At each decision
// (except the mulligan) the input is encode2(current state, mover) and the π target
// is the pooled MCTS visit marginals (what/where), so the policy learns the search
// distribution itself, not a re-encoded heuristic. The value label z=±1 comes from
// the game outcome (mover's view). The action actually played is sampled ∝ visits
// (temperature 1) for more varied states.
//
//   npx tsx src/ai/cli/genPolicyData.ts --games 300 --worlds 4 --sims 40 --out data/policy/games.0
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { cards } from "../../engine/testkit";
import { Rng } from "../../engine/rng";
import { loadCorpus } from "../corpus/loader";
import { CorpusSampler } from "../corpus/sample";
import { trainDecks } from "../corpus/splits";
import { buildCorpusBelief } from "../belief/corpus";
import { buildCardIndex2, encode2, encodingLength2 } from "../encode2";
import { policyTargets, whatSize, WHERE_SIZE } from "../policy";
import { DeterminizedMctsAgent, type DetMctsOptions } from "../agents/DeterminizedMctsAgent";
import { actingSide, legalActions, applyAction, type Action } from "../actions";
import { createInitialState } from "../../engine/rules";
import type { Side } from "../../engine/board";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const GAMES = parseInt(arg("--games", "200"), 10);
const WORLDS = parseInt(arg("--worlds", "4"), 10);
const SIMS = parseInt(arg("--sims", "40"), 10);
const MAXBRANCH = parseInt(arg("--maxBranch", "10"), 10);
const FOLD = parseInt(arg("--fold", "0"), 10);
const SEED = parseInt(arg("--seed", "1"), 10);
const OUT = arg("--out", "data/policy/games.0");
// Stronger teacher: when set, the self-play teacher uses the value net at the
// leaves (a much stronger search than the heuristic) and optionally the current
// policy as a PUCT prior. The policy then imitates a stronger expert (ExIt).
const VALUE_MODEL = arg("--value-model", "");
const POLICY_MODEL = arg("--policy-model", "");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.resolve(HERE, "../../../decks-corpus");
const VOCAB = path.resolve(HERE, "../vocab.json");

function sampleByVisits(stats: { action: Action; visits: number }[], rng: Rng): Action {
  let total = 0;
  for (const s of stats) total += s.visits;
  if (total <= 0) return stats[rng.int(stats.length)].action;
  let t = rng.next() * total;
  for (const s of stats) { t -= s.visits; if (t < 0) return s.action; }
  return stats[stats.length - 1].action;
}

async function main(): Promise<void> {
  const pool = cards();
  const vocab = JSON.parse(fs.readFileSync(VOCAB, "utf-8")) as { ids: number[] };
  const cardIndex = buildCardIndex2(vocab.ids);
  const encLen = encodingLength2(cardIndex);
  const WS = whatSize(cardIndex);
  const { decks } = loadCorpus(path.join(CORPUS, "decks.json"), path.join(CORPUS, "weights.json"), { isKnownCard: (id) => pool.has(id) });
  const splits = JSON.parse(fs.readFileSync(path.join(CORPUS, "splits.json"), "utf-8"));
  const train = trainDecks(decks, splits, FOLD);
  const corpusMap = buildCorpusBelief(train);
  // Teacher: heuristic-leaf DetMCTS by default; value-net leaf (+ optional policy
  // prior) when models are given (ExIt: imitate a stronger expert).
  const agentOpts: DetMctsOptions = { worlds: WORLDS, simulations: SIMS, maxBranch: MAXBRANCH, belief: corpusMap };
  if (VALUE_MODEL) {
    const { loadTsValueModel } = await import("../net/loadTsValueModel");
    const { netLeafEvalFactory } = await import("../agents/netLeaf");
    agentOpts.makeLeafEval = netLeafEvalFactory(loadTsValueModel(VALUE_MODEL), cardIndex, corpusMap);
  }
  if (POLICY_MODEL) {
    const { loadTsPolicyModel } = await import("../net/loadTsPolicyModel");
    const { netPriorFactory } = await import("../agents/netPrior");
    agentOpts.makePriorFn = netPriorFactory(loadTsPolicyModel(POLICY_MODEL), cardIndex);
  }
  const agent = new DeterminizedMctsAgent(agentOpts);
  console.log(`teacher: ${VALUE_MODEL ? "value-leaf" : "heuristic-leaf"}${POLICY_MODEL ? "+policy-prior" : ""}`);
  const sampler = new CorpusSampler(train);
  const sampleRng = new Rng((SEED ^ 0x90a1) | 0);
  console.log(`policy gen: ${GAMES} games, DetMCTS(${WORLDS}x${SIMS}), encLen ${encLen}, whatSize ${WS}`);

  fs.mkdirSync(path.dirname(path.resolve(`${OUT}.x.f32`)) || ".", { recursive: true });
  const xWs = fs.createWriteStream(`${OUT}.x.f32`);
  const whatWs = fs.createWriteStream(`${OUT}.what.f32`);
  const whereWs = fs.createWriteStream(`${OUT}.where.f32`);
  const zWs = fs.createWriteStream(`${OUT}.z.f32`);
  const idxWs = fs.createWriteStream(`${OUT}.idx.u32`);

  let rows = 0, played = 0, draws = 0, stuck = 0, gameOrd = 0;
  const t0 = Date.now();
  const ORIGINAL_RANDOM = Math.random;
  Math.random = () => { throw new Error("Math.random() in seeded policy gen"); };
  try {
    for (let i = 0; i < GAMES; i++) {
      const m = sampler.matchup(sampleRng, { alpha: 1 });
      const agentRng = new Rng(((SEED + i) ^ 0x9e3779b9) | 0);
      let state = createInitialState({ ally: m.ally.cards, enemy: m.enemy.cards }, { seed: SEED + i, firstSide: m.firstSide, gods: { ally: m.ally.god, enemy: m.enemy.god } });
      const decisions: { side: Side; x: Float32Array; what: Float32Array; where: Float32Array }[] = [];
      let plies = 0, dead = false;
      while (state.winner === null && state.turn <= 200) {
        const legal = legalActions(state);
        if (legal.length === 0) break;
        let action: Action;
        if (state.mulligan) {
          action = agent.chooseAction(state, legal, agentRng); // not recorded
        } else if (legal.length === 1) {
          action = legal[0];
        } else {
          const side = actingSide(state);
          const stats = agent.aggregatedStats(state, agentRng);
          const { what, where } = policyTargets(stats, cardIndex);
          decisions.push({ side, x: encode2(state, side, { cardIndex, belief: null }), what, where });
          action = sampleByVisits(stats, agentRng);
        }
        state = applyAction(state, action);
        if (++plies > 1500) { dead = true; break; }
      }
      if (dead) { stuck++; continue; }
      const winner = state.winner;
      if (winner === null) { draws++; continue; }
      const ord = gameOrd++;
      played++;
      for (const d of decisions) {
        const z = winner === d.side ? 1 : -1;
        xWs.write(Buffer.from(d.x.buffer, d.x.byteOffset, d.x.byteLength));
        whatWs.write(Buffer.from(d.what.buffer, d.what.byteOffset, d.what.byteLength));
        whereWs.write(Buffer.from(d.where.buffer, d.where.byteOffset, d.where.byteLength));
        const zb = Buffer.alloc(4); zb.writeFloatLE(z, 0); zWs.write(zb);
        const ib = Buffer.alloc(4); ib.writeUInt32LE(ord, 0); idxWs.write(ib);
        rows++;
      }
      if (i % 20 === 0) process.stdout.write(`  ${i}/${GAMES} | ${played} games, ${rows} rows, ${draws} draws, ${stuck} stuck | ${((Date.now() - t0) / 1000 / (i + 1)).toFixed(1)}s/game\r`);
    }
  } finally { Math.random = ORIGINAL_RANDOM; }

  for (const ws of [xWs, whatWs, whereWs, zWs, idxWs]) ws.end();
  const engineSha = (() => { try { return execSync("git rev-parse HEAD").toString().trim(); } catch { return "unknown"; } })();
  fs.writeFileSync(`${OUT}.meta.json`, JSON.stringify({
    schema: "policy-v1", encLen, whatSize: WS, whereSize: WHERE_SIZE, worlds: WORLDS, sims: SIMS,
    heldOutFold: FOLD, engineSha, createdAt: new Date().toISOString(),
    counts: { games: played, rows, draws, stuck },
  }, null, 2));
  console.log(`\ndone: ${rows} rows from ${played} games (${draws} draws, ${stuck} stuck) in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${OUT}.x.f32`);
}

main();
