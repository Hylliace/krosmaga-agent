// Worker for the AI's thinking. The DetMCTS search (up to 6×120 = 720
// simulations per decision, ~3-4 s) used to run on the main thread and froze the
// UI. This module worker hosts the whole value-agent stack instead: it registers
// the card catalog (sent once by the client), lazy-loads the net bundle through
// browserAgent (fetch works in workers, and the WASM conv backend compiles here too,
// off the main thread), and answers `decide` messages with the chosen action.
//
// GameState is safe for structured clone by design: state.rng is a plain uint32
// (mulberry32) and the creature.properties Sets survive the clone. The agent's
// exploration rng is rebuilt from a per-decision seed sent by the client.
import { registerCards } from "../engine/cardRegistry";
import type { Card } from "../data/types";
import type { GameState } from "../engine/state";
import type { Action } from "./actions";
import type { Agent } from "./agents/Agent";
import { Rng } from "../engine/rng";
import { loadValueAgent, type AiStrength } from "./browserAgent";

type InMsg =
  | { type: "init"; cards: Card[] }
  | { type: "decide"; id: number; state: GameState; legal: Action[]; strength: AiStrength; seed: number };
type OutMsg =
  | { type: "ready" }
  | { type: "action"; id: number; action: Action }
  | { type: "error"; id: number; message: string };

const agents = new Map<AiStrength, Promise<Agent>>();
const post = (m: OutMsg) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  if (msg.type === "init") {
    try {
      registerCards(msg.cards);
      post({ type: "ready" });
    } catch (err) {
      post({ type: "error", id: -1, message: String(err) });
    }
    return;
  }
  if (msg.type === "decide") {
    try {
      let p = agents.get(msg.strength);
      if (!p) {
        p = loadValueAgent(msg.strength);
        agents.set(msg.strength, p);
      }
      const agent = await p;
      const action = agent.chooseAction(msg.state, msg.legal, new Rng(msg.seed | 0));
      post({ type: "action", id: msg.id, action });
    } catch (err) {
      post({ type: "error", id: msg.id, message: String(err) });
    }
  }
};
