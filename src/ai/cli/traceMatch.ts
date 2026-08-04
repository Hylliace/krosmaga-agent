// Match tracer: plays one game (model A vs model B, same DetMCTS budget) and logs
// every decision: the candidate actions the search considered (pooled root visits
// across worlds), the chosen one, and how both nets evaluate the position, to see
// how the two nets think and where they disagree.
//
//   npx tsx src/ai/cli/traceMatch.ts --model data/models/value6s1 --model-b data/models/value5 \
//     --worlds 2 --sims 20 --fold 0 --seed 7 --out data/arena_v6/trace7.json
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { cards } from "../../engine/testkit";
import { Rng } from "../../engine/rng";
import { createInitialState } from "../../engine/rules";
import { loadCorpus } from "../corpus/loader";
import { CorpusSampler } from "../corpus/sample";
import { trainDecks, heldOutDecks } from "../corpus/splits";
import { buildCorpusBelief } from "../belief/corpus";
import { buildCardIndex2 } from "../encode2";
import { loadTsValueModel } from "../net/loadTsValueModel";
import { netLeafEvalFactory } from "../agents/netLeaf";
import { DeterminizedMctsAgent } from "../agents/DeterminizedMctsAgent";
import { actingSide, legalActions, applyAction, type Action } from "../actions";
import { mulliganV1 } from "../mulligan";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const WORLDS = parseInt(arg("--worlds", "2"), 10);
const SIMS = parseInt(arg("--sims", "20"), 10);
const MAXBRANCH = parseInt(arg("--maxBranch", "8"), 10);
const FOLD = parseInt(arg("--fold", "0"), 10);
const MODEL = arg("--model", "data/models/value6s1");
const MODEL_B = arg("--model-b", "data/models/value5");
const SEED = parseInt(arg("--seed", "1"), 10);
const OUT = arg("--out", "data/arena_v6/trace.json");
// When set, also write the game as a GameRecording (krosmaga.replay), which can be
// watched directly in the in-game "Relecture" tab.
const REPLAY_OUT = arg("--replay-out", "");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.resolve(HERE, "../../../decks-corpus");
const VOCAB = path.resolve(HERE, "../vocab.json");

function describe(a: Action, name: (id: number) => string): string {
  switch (a.kind) {
    case "play": return `joue ${name(a.cardId)} en (${a.target.x},${a.target.y})`;
    case "resolve": return `cible (${a.target.x},${a.target.y})`;
    case "cancel": return "annule";
    case "reserve": return "PA en reserve";
    case "endTurn": return "fin de tour";
    case "mulligan": return `mulligan [${a.returnIndices.join(",")}]`;
  }
}

async function main(): Promise<void> {
  const pool = cards();
  const cname = (id: number) => pool.get(id)?.name ?? `#${id}`;
  const vocab = JSON.parse(fs.readFileSync(VOCAB, "utf-8")) as { ids: number[] };
  const cardIndex = buildCardIndex2(vocab.ids);
  const { decks } = loadCorpus(path.join(CORPUS, "decks.json"), path.join(CORPUS, "weights.json"), { isKnownCard: (id) => pool.has(id) });
  const splits = JSON.parse(fs.readFileSync(path.join(CORPUS, "splits.json"), "utf-8"));
  const corpusMap = buildCorpusBelief(trainDecks(decks, splits, FOLD));
  const held = heldOutDecks(decks, splits, FOLD);

  const modelA = loadTsValueModel(MODEL);
  const modelB = loadTsValueModel(MODEL_B);
  const leafFacA = netLeafEvalFactory(modelA, cardIndex, corpusMap);
  const leafFacB = netLeafEvalFactory(modelB, cardIndex, corpusMap);
  const common = { worlds: WORLDS, simulations: SIMS, maxBranch: MAXBRANCH, belief: corpusMap } as const;
  const agentA = new DeterminizedMctsAgent({ ...common, makeLeafEval: leafFacA });
  const agentB = new DeterminizedMctsAgent({ ...common, makeLeafEval: leafFacB });

  const sampler = new CorpusSampler(held);
  const sampleRng = new Rng((SEED ^ 0x51ed) | 0);
  const m = sampler.matchup(sampleRng, { alpha: 1 });
  // A = ally (fixed here; the tracer is about reading one game, not fairness stats)
  let state = createInitialState(
    { ally: m.ally.cards, enemy: m.enemy.cards },
    { seed: SEED, firstSide: m.firstSide, gods: { ally: m.ally.god, enemy: m.enemy.god } },
  );
  const agentRng = new Rng((SEED ^ 0x9e3779b9) | 0);

  interface Decision {
    ply: number; turn: number; side: string; agent: string;
    pending: string | null; legal: number;
    evalA: number; evalB: number; // P-ish value in (-1,1) from the ally perspective
    candidates: { desc: string; visits: number }[];
    chosen: string;
  }
  const decisions: Decision[] = [];
  // Committed snapshots for the visual replay, same semantics as Match.tsx's
  // recorder: baseline always, then settled states whose journal grew.
  const snapshots = [state];
  let plies = 0;

  while (state.winner === null && state.turn <= 200 && plies < 1500) {
    const side = actingSide(state);
    const legal = legalActions(state);
    if (legal.length === 0) break;
    const agent = side === "ally" ? agentA : agentB;
    const agentTag = side === "ally" ? "A" : "B";

    let action: Action;
    let candidates: { desc: string; visits: number }[] = [];
    if (state.mulligan) {
      action = { kind: "mulligan", returnIndices: mulliganV1(state, state.mulligan.current) };
    } else if (legal.length === 1) {
      action = legal[0];
    } else {
      const stats = agent.aggregatedStats(state, agentRng);
      stats.sort((a, b) => b.visits - a.visits);
      candidates = stats.slice(0, 10).map((s) => ({ desc: describe(s.action, cname), visits: s.visits }));
      action = stats[0].action;
    }

    // Both nets' read of the current position, always from the ally (=A) side.
    // (netLeaf refuses mulligan states by design, no eval before the game starts.)
    const inMull = state.mulligan != null;
    const evalA = inMull ? 0 : leafFacA(state, "ally")(state, "ally");
    const evalB = inMull ? 0 : leafFacB(state, "ally")(state, "ally");
    decisions.push({
      ply: plies, turn: state.turn, side, agent: agentTag,
      pending: state.pendingAction?.prompt ?? null, legal: legal.length,
      evalA: Math.round(evalA * 1000) / 1000, evalB: Math.round(evalB * 1000) / 1000,
      candidates, chosen: describe(action, cname),
    });
    state = applyAction(state, action);
    const lastSnap = snapshots[snapshots.length - 1];
    if (!state.pendingAction && state.log.length > lastSnap.log.length) snapshots.push(state);
    plies++;
    if (plies % 25 === 0) process.stdout.write(`  ply ${plies}, tour ${state.turn}\r`);
  }

  const out = {
    seed: SEED, worlds: WORLDS, sims: SIMS,
    modelA: MODEL, modelB: MODEL_B,
    matchup: {
      ally: { god: m.ally.god, deck: m.ally.deckId, author: m.ally.author },
      enemy: { god: m.enemy.god, deck: m.enemy.deckId, author: m.enemy.author },
      firstSide: m.firstSide,
    },
    result: { winner: state.winner, turns: state.turn, plies },
    decisions,
  };
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`\ntrace: ${decisions.length} decisions, vainqueur=${state.winner}, tours=${state.turn} -> ${OUT}`);
  if (REPLAY_OUT) {
    const setReplacer = (_k: string, v: unknown) => (v instanceof Set ? { __set: [...v] } : v);
    const rec = {
      format: "krosmaga.replay", version: 1, createdAt: Date.now(),
      allyGod: m.ally.god, enemyGod: m.enemy.god, states: snapshots,
    };
    fs.mkdirSync(path.dirname(path.resolve(REPLAY_OUT)), { recursive: true });
    fs.writeFileSync(REPLAY_OUT, JSON.stringify(rec, setReplacer));
    console.log(`replay visuel: ${snapshots.length} etats -> ${REPLAY_OUT}`);
  }
}

main();
