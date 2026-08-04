// Converts an AI raw game (seed + actions, "raw-v1" jsonl) into the GameRecording
// JSON that the in-game replay viewer ("Relecture" tab) imports as it is. The
// engine is pure, so the game is played again and committed states are captured
// the same way Match.tsx records a live game (the baseline first, then each
// settled state whose journal grew), and the viewer shows it with the real board,
// animations and turn log.
//
//   npx tsx src/ai/cli/rawToReplay.ts --in data/expert8/games.0.jsonl --index 0 \
//     --out replays/partie.json
//   (--seed 31000001 picks the game by seed instead of --index)
//
// For campaign games, run this from the same engine snapshot the game was generated
// with (each measurement campaign pins its own frozen code tree); otherwise a later
// engine change could make the replay diverge without any warning.
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { cards } from "../../engine/testkit";
import { createInitialState } from "../../engine/rules";
import type { GameState } from "../../engine/state";
import { applyAction } from "../actions";
import { decodeAction, type RawGame } from "../selfplay/recordRaw";

// Register the card catalog before any replay, without this the engine runs on
// an incomplete catalog and the game silently drifts (every AI pipeline entry
// point calls cards() first for the same reason).
cards();

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const IN = arg("--in", "");
const INDEX = parseInt(arg("--index", "0"), 10);
const SEED = arg("--seed", "");
const OUT = arg("--out", "replay.json");
if (!IN) { console.error("usage: --in <games.jsonl> [--index N | --seed S] --out <replay.json>"); process.exit(1); }

function setReplacer(_key: string, value: unknown): unknown {
  return value instanceof Set ? { __set: [...value] } : value;
}

async function main(): Promise<void> {
  // pick the requested game from the jsonl
  let raw: RawGame | null = null;
  let idx = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(IN), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const g = JSON.parse(line) as RawGame;
    if (g.v !== "raw-v1") continue;
    if (SEED ? String(g.seed) === SEED : idx === INDEX) { raw = g; break; }
    idx++;
  }
  if (!raw) { console.error(SEED ? `seed ${SEED} introuvable dans ${IN}` : `index ${INDEX} hors limites dans ${IN}`); process.exit(1); }

  let state = createInitialState(
    { ally: raw.decks.a, enemy: raw.decks.e },
    { seed: raw.seed, firstSide: raw.first, gods: raw.mu?.a.god && raw.mu?.e.god ? { ally: raw.mu.a.god, enemy: raw.mu.e.god } : undefined },
  );
  // Match.tsx recording semantics: baseline always kept; then only settled states
  // (no pendingAction) whose journal grew, pending frames and no-op settles are
  // not steps. This keeps the exact frames the live recorder would have kept.
  const states: GameState[] = [state];
  for (const r of raw.acts) {
    if (state.winner !== null) break;
    const action = decodeAction(r);
    state = applyAction(state, action);
    const last = states[states.length - 1];
    if (!state.pendingAction && state.log.length > last.log.length) states.push(state);
  }
  if (states[states.length - 1] !== state && !state.pendingAction) states.push(state);

  const replayedW = state.winner === null ? 0 : state.winner === "ally" ? 1 : -1;
  if (replayedW !== raw.res.w || state.turn !== raw.res.turns) {
    console.warn(`ATTENTION: rejeu != enregistrement (vainqueur ${replayedW} vs ${raw.res.w}, tours ${state.turn} vs ${raw.res.turns}) — moteur different de la generation ?`);
  }

  const rec = {
    format: "krosmaga.replay" as const,
    version: 1 as const,
    createdAt: Date.now(),
    allyGod: raw.mu?.a.god,
    enemyGod: raw.mu?.e.god,
    states,
  };
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(rec, setReplacer));
  console.log(`replay: ${states.length} etats, seed ${raw.seed}, ${raw.mu?.a.god ?? "?"} vs ${raw.mu?.e.god ?? "?"}, vainqueur=${state.winner}, ${state.turn} tours -> ${OUT}`);
}

main();
