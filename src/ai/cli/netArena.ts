// Arena check. Pits the value-net DetMCTS against the heuristic DetMCTS with the
// same search budget and belief determinization, so the only difference is the
// leaf evaluator (net vs heuristic). Plays held-out matchups (opponent decks the net
// never trained on), alternating sides, and reports the net win rate with a Wilson
// 95% interval. To be promoted, the lower bound has to be above 50% (ideally the
// point estimate above 55%).
//
//   npx tsx src/ai/cli/netArena.ts --games 80 --worlds 2 --sims 20 --model data/models/value
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { cards } from "../../engine/testkit";
import { Rng } from "../../engine/rng";
import { loadCorpus } from "../corpus/loader";
import { CorpusSampler } from "../corpus/sample";
import { trainDecks, heldOutDecks } from "../corpus/splits";
import { buildCorpusBelief } from "../belief/corpus";
import { buildCardIndex2 } from "../encode2";
import { loadTsValueModel } from "../net/loadTsValueModel";
import { netLeafEvalFactory } from "../agents/netLeaf";
import { DeterminizedMctsAgent } from "../agents/DeterminizedMctsAgent";
import { recordGameRaw, type RawMatchup } from "../selfplay/recordRaw";
import * as fs from "node:fs";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const GAMES = parseInt(arg("--games", "80"), 10);
const WORLDS = parseInt(arg("--worlds", "2"), 10);
const SIMS = parseInt(arg("--sims", "20"), 10);
const MAXBRANCH = parseInt(arg("--maxBranch", "8"), 10);
const FOLD = parseInt(arg("--fold", "0"), 10);
const MODEL = arg("--model", "data/models/value");
const MODEL_B = arg("--model-b", ""); // if set: A = value(MODEL) vs B = value(MODEL_B) head-to-head
const POLICY = arg("--policy", ""); // if set: A = value+policy-prior, B = value-only (isolates the policy)
const PI_BAR = process.argv.includes("--pi-bar"); // A = value-only search + π̄ root selection (Grill), B = value-only most-visited
const PI_BAR_C = parseFloat(arg("--pi-bar-c", "1.5"));
const SEED = parseInt(arg("--seed", "1"), 10);
// --self: same model both sides, side A on the A-budget (worlds/sims/maxBranch),
// side B on the B-budget below. Measures the TEACHER-STUDENT amplification gap,
// does a deeper search (A) beat a shallower one (B) with the identical evaluator?
// A wide margin = real headroom to distill (justifies a deeper-teacher wave).
const SELF = process.argv.includes("--self");
const WORLDS_B = parseInt(arg("--worlds-b", String(WORLDS)), 10);
const SIMS_B = parseInt(arg("--sims-b", String(SIMS)), 10);
const MAXBRANCH_B = parseInt(arg("--maxBranch-b", String(MAXBRANCH)), 10);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.resolve(HERE, "../../../decks-corpus");
const VOCAB = path.resolve(HERE, "../vocab.json");

function wilson(wins: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96, p = wins / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}

async function main(): Promise<void> {
  const pool = cards();
  const vocab = JSON.parse(fs.readFileSync(VOCAB, "utf-8")) as { ids: number[] };
  const cardIndex = buildCardIndex2(vocab.ids);
  const { decks } = loadCorpus(path.join(CORPUS, "decks.json"), path.join(CORPUS, "weights.json"), { isKnownCard: (id) => pool.has(id) });
  const splits = JSON.parse(fs.readFileSync(path.join(CORPUS, "splits.json"), "utf-8"));
  const train = trainDecks(decks, splits, FOLD);
  // Reduced-world: with a whitelist, matchups sample from those decks (the world),
  // not the held-out fold (with 9 decks the world is the evaluation domain).
  const DECK_FILTER = arg("--deck-filter", "");
  const held = DECK_FILTER
    ? decks.filter((d) => DECK_FILTER.split(",").some((p) => (d.deckId ?? "").startsWith(p.trim())))
    : heldOutDecks(decks, splits, FOLD);
  const corpusMap = buildCorpusBelief(train); // belief uses train decks (realistic inference)
  const model = loadTsValueModel(MODEL);
  const common = { worlds: WORLDS, simulations: SIMS, maxBranch: MAXBRANCH, belief: corpusMap } as const;
  const valueLeaf = netLeafEvalFactory(model, cardIndex, corpusMap);

  // Two modes. Default: net (value leaf) vs heuristic. With --policy:
  // A = value leaf + policy prior vs B = value leaf only, to isolate the policy.
  let net: DeterminizedMctsAgent, base: DeterminizedMctsAgent, label: string;
  if (SELF) {
    // Same evaluator both sides; the only difference is the search budget.
    // "net" (the win% we report) = side A = the deep budget; "base" = B = shallow.
    // --cheat-a: side A cheats (worlds are the real state). --sh-a: side A runs
    // sequential halving at the root. Both are for measurement only.
    const CHEAT_A = process.argv.includes("--cheat-a");
    const SH_A = process.argv.includes("--sh-a");
    // --oppk-a N: size of the portfolio of opponent policies for side A.
    const OPPK_A = parseInt(arg("--oppk-a", "1"), 10);
    // --best-first-a / --best-first-b: best-first expansion order (MctsOptions.expandBestFirst)
    // for side A / side B. The B flag is there to measure the budget curve again with the
    // change on both sides.
    const BF_A = process.argv.includes("--best-first-a");
    const BF_B = process.argv.includes("--best-first-b");
    // --root-q-a / --root-q-b: root choice by the value of the search after the veto
    // (DetMctsOptions.rootPick = "q"). --c-a / --c-b: UCB1 exploration constant of each
    // side (default 1.4).
    const RQ_A = process.argv.includes("--root-q-a");
    const RQ_B = process.argv.includes("--root-q-b");
    const C_A = parseFloat(arg("--c-a", "1.4"));
    const C_B = parseFloat(arg("--c-b", "1.4"));
    // --root-fair-a / --root-fair-b: honest root layer (the opponent's hand drawn from the
    // belief instead of the real one, DetMctsOptions.rootFair).
    const RF_A = process.argv.includes("--root-fair-a");
    const RF_B = process.argv.includes("--root-fair-b");
    // --root-fair-k-a / --root-fair-k-b N: honest root scored on the mean of N worlds
    // (DetMctsOptions.rootFairK; implies --root-fair-x).
    const RFK_A = parseInt(arg("--root-fair-k-a", "1"), 10);
    const RFK_B = parseInt(arg("--root-fair-k-b", "1"), 10);
    // --root-heur-a / --root-heur-b (ablation): the rule layer alone chooses
    // (DetMctsOptions.rootPick = "heur"). --veto-a / --veto-b N: root veto margin of each side
    // (default EVAL_WEIGHTS.rootVeto); "inf" = no veto.
    const RH_A = process.argv.includes("--root-heur-a");
    const RH_B = process.argv.includes("--root-heur-b");
    const veto = (n: string): number | undefined => { const v = arg(n, ""); return v === "" ? undefined : v === "inf" ? Infinity : parseFloat(v); };
    const VETO_A = veto("--veto-a");
    const VETO_B = veto("--veto-b");
    const pick = (q: boolean, h: boolean) => (h ? "heur" : q ? "q" : "visits") as "heur" | "q" | "visits";
    net = new DeterminizedMctsAgent({ ...common, makeLeafEval: valueLeaf, cheat: CHEAT_A, rootSH: SH_A, oppK: OPPK_A, expandBestFirst: BF_A, rootPick: pick(RQ_A, RH_A), c: C_A, rootFair: RF_A || RFK_A > 1, rootFairK: RFK_A, vetoMargin: VETO_A });
    base = new DeterminizedMctsAgent({ worlds: WORLDS_B, simulations: SIMS_B, maxBranch: MAXBRANCH_B, belief: corpusMap, makeLeafEval: valueLeaf, expandBestFirst: BF_B, rootPick: pick(RQ_B, RH_B), c: C_B, rootFair: RF_B || RFK_B > 1, rootFairK: RFK_B, vetoMargin: VETO_B });
    const tagA = `${CHEAT_A ? " CHEAT" : ""}${SH_A ? " SH" : ""}${OPPK_A > 1 ? ` oppK${OPPK_A}` : ""}${BF_A ? " BF" : ""}${RQ_A ? " rootQ" : ""}${C_A !== 1.4 ? ` c${C_A}` : ""}${RF_A || RFK_A > 1 ? ` fair${RFK_A > 1 ? RFK_A : ""}` : ""}${RH_A ? " rootH" : ""}${VETO_A !== undefined ? ` veto${VETO_A}` : ""}`;
    const tagB = `${BF_B ? " BF" : ""}${RQ_B ? " rootQ" : ""}${C_B !== 1.4 ? ` c${C_B}` : ""}${RF_B || RFK_B > 1 ? ` fair${RFK_B > 1 ? RFK_B : ""}` : ""}${RH_B ? " rootH" : ""}${VETO_B !== undefined ? ` veto${VETO_B}` : ""}`;
    label = `value(${MODEL}) SELF-GAP ${WORLDS}x${SIMS}${tagA} (A) vs ${WORLDS_B}x${SIMS_B}${tagB} (B)`;
  } else if (MODEL_B) {
    const modelB = loadTsValueModel(MODEL_B);
    net = new DeterminizedMctsAgent({ ...common, makeLeafEval: valueLeaf });
    base = new DeterminizedMctsAgent({ ...common, makeLeafEval: netLeafEvalFactory(modelB, cardIndex, corpusMap) });
    label = `value(${MODEL}) vs value(${MODEL_B})`;
  } else if (process.argv.includes("--q-agent")) {
    // DMC: A = QAgent (afterstate-greedy over the DMC net, search-free) vs
    // B = value+search baseline (--model). --q-model = the DMC net f; optional
    // --q-model-b makes B a QAgent too (iteration-vs-iteration head-to-head).
    const { QAgent } = await import("../agents/QAgent");
    const fA = loadTsValueModel(arg("--q-model", "data/models/dmc_f1"));
    net = new QAgent(fA, cardIndex) as unknown as DeterminizedMctsAgent;
    const QMB = arg("--q-model-b", "");
    if (QMB) {
      base = new QAgent(loadTsValueModel(QMB), cardIndex) as unknown as DeterminizedMctsAgent;
      label = `Q(${arg("--q-model", "dmc_f1")}) vs Q(${QMB})`;
    } else {
      base = new DeterminizedMctsAgent({ ...common, makeLeafEval: valueLeaf });
      label = `Q-afterstate(no search) vs value+search`;
    }
  } else if (POLICY && process.argv.includes("--policy-only")) {
    // Search-FREE policy (A) vs value+search (B): the RL-pivot baseline.
    const { loadTsPolicyModel } = await import("../net/loadTsPolicyModel");
    const { PolicyAgent } = await import("../agents/PolicyAgent");
    const policyModel = loadTsPolicyModel(POLICY);
    net = new PolicyAgent(policyModel, cardIndex) as unknown as DeterminizedMctsAgent;
    base = new DeterminizedMctsAgent({ ...common, makeLeafEval: valueLeaf });
    label = `policy-only(no search) vs value+search`;
  } else if (POLICY && PI_BAR) {
    // π̄ act: A runs value-only search then picks the root action by the closed-form
    // regularized policy (Grill et al.); B is plain value-only most-visited.
    const { loadTsPolicyModel } = await import("../net/loadTsPolicyModel");
    const { netPriorFactory } = await import("../agents/netPrior");
    const policyModel = loadTsPolicyModel(POLICY);
    net = new DeterminizedMctsAgent({ ...common, makeLeafEval: valueLeaf, makePriorFn: netPriorFactory(policyModel, cardIndex), piBar: true, piBarC: PI_BAR_C });
    base = new DeterminizedMctsAgent({ ...common, makeLeafEval: valueLeaf });
    label = `value+π̄(c=${PI_BAR_C}) vs value-only`;
  } else if (POLICY) {
    const { loadTsPolicyModel } = await import("../net/loadTsPolicyModel");
    const { netPriorFactory } = await import("../agents/netPrior");
    const policyModel = loadTsPolicyModel(POLICY);
    net = new DeterminizedMctsAgent({ ...common, makeLeafEval: valueLeaf, makePriorFn: netPriorFactory(policyModel, cardIndex) });
    base = new DeterminizedMctsAgent({ ...common, makeLeafEval: valueLeaf });
    label = "value+policy vs value-only";
  } else {
    net = new DeterminizedMctsAgent({ ...common, makeLeafEval: valueLeaf });
    base = new DeterminizedMctsAgent({ ...common });
    label = "net(value) vs heuristic";
  }
  const PAIRED = process.argv.includes("--paired");
  console.log(`held-out ${held.length} decks (fold ${FOLD}); ${label}, DetMCTS(${WORLDS}x${SIMS}), ${GAMES} games${PAIRED ? " (paired: " + (GAMES >> 1) + " deals x2)" : ""}`);

  const sampler = new CorpusSampler(held);
  const sampleRng = new Rng((SEED ^ 0x51ed) | 0);
  let netWins = 0, decided = 0, draws = 0, errors = 0;
  const t0 = Date.now();

  // --paired: duplicate scoring, as in bridge. Without it every game draws a new
  // matchup and a new seed, and the variance of the draw (which deck against which,
  // which hands) is larger than the difference between the two agents. This is why
  // gains of about 5 points over 300 games went away on new seeds. Here every
  // matchup is played twice, with the same decks and the same seed and the agents
  // swapped. A matchup that favors one deck gives one win to each side and counts
  // exactly 50%, so only what the agents do differently from the same position is
  // left in the score. It detects smaller differences with the same number of games.
  let pairM: ReturnType<typeof sampler.matchup> | null = null;
  for (let i = 0; i < GAMES; i++) {
    // Paired: one draw per pair (even i), reused by the mirror game (odd i), and
    // the game seed is the seed of the pair.
    const m = PAIRED ? (i % 2 === 0 ? (pairM = sampler.matchup(sampleRng, { alpha: 1 })) : pairM!) : sampler.matchup(sampleRng, { alpha: 1 });
    const gameSeed = SEED + (PAIRED ? i >> 1 : i);
    const netIsAlly = i % 2 === 0; // alternate sides to cancel first/second bias
    const agentA = netIsAlly ? net : base;
    const agentB = netIsAlly ? base : net;
    const mu: RawMatchup = {
      a: { id: m.ally.deckId, god: m.ally.god, author: m.ally.author, tags: m.ally.tags },
      e: { id: m.enemy.deckId, god: m.enemy.god, author: m.enemy.author, tags: m.enemy.tags },
    };
    let raw;
    try {
      raw = recordGameRaw(agentA, agentB, {
        decks: { ally: m.ally.cards, enemy: m.enemy.cards }, seed: gameSeed, firstSide: m.firstSide,
        gods: { ally: m.ally.god, enemy: m.enemy.god }, maxTurns: 200, maxPlies: 1500, mu,
      });
    } catch (e) {
      // One broken game (engine invariant / netLeaf tripwire) costs one game,
      // not the whole arena. Loud in the log so it still gets investigated.
      errors++;
      console.warn(`\n[ERROR] seed=${gameSeed} ${m.ally.god} vs ${m.enemy.god}: ${e instanceof Error ? e.message.split("\n")[0] : e} -> SKIPPED`);
      continue;
    }
    if (!raw || raw.res.w === 0) { draws++; continue; }
    decided++;
    const netWon = (raw.res.w === 1) === netIsAlly; // w=1 → ally won
    if (netWon) netWins++;
    const wr = netWins / decided;
    process.stdout.write(`  game ${i + 1}/${GAMES} | net ${netWins}/${decided} = ${(wr * 100).toFixed(1)}% | ${draws} draws | ${((Date.now() - t0) / 1000 / (i + 1)).toFixed(1)}s/game\r`);
  }

  const wr = decided ? netWins / decided : 0;
  const [lo, hi] = wilson(netWins, decided);
  console.log(`\n\nRESULT: net ${netWins}/${decided} decided = ${(wr * 100).toFixed(1)}% (Wilson95 [${(lo * 100).toFixed(1)}%, ${(hi * 100).toFixed(1)}%]), ${draws} draws, ${errors} errors`);
  console.log(`gate (>55% point): ${wr > 0.55 ? "PASS" : "not yet"}; (>50% Wilson lower): ${lo > 0.5 ? "PASS" : "not yet"}`);
}

main();
