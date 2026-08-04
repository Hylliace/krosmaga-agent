// The production AI: value-net DetMCTS with belief determinization and no policy
// prior. The learned policy made play worse in this setting (strong value,
// heuristic candidate pruning, modest simulations), with a weak teacher and with a
// strong one. So only the judge is shipped: the value net at the leaves and the
// heuristic-pruned PIMC search. This is the agent the arena and any deployment
// should use.
import { DeterminizedMctsAgent } from "./DeterminizedMctsAgent";
import { netLeafEvalFactory } from "./netLeaf";
import type { TsValueModel } from "../net/TsValueModel";
import type { CorpusBelief } from "../belief/corpus";
import type { God } from "../../data/types";

export interface ValueAgentOpts {
  worlds?: number;
  simulations?: number;
  maxBranch?: number;
  // Self-play generation only: opening temperature (see DetMctsOptions.explore).
  explore?: { turns: number; temperature?: number };
}

export function makeValueAgent(
  model: TsValueModel,
  cardIndex: Map<number, number>,
  corpusMap: Map<God, CorpusBelief>,
  opts: ValueAgentOpts = {},
): DeterminizedMctsAgent {
  return new DeterminizedMctsAgent({
    worlds: opts.worlds ?? 2,
    simulations: opts.simulations ?? 40,
    maxBranch: opts.maxBranch ?? 8,
    belief: corpusMap,
    makeLeafEval: netLeafEvalFactory(model, cardIndex, corpusMap),
    explore: opts.explore,
    // No makePriorFn, the policy prior is parked.
  });
}
