// In-place mutation tracer. The stateHash of checkDeterminism only covers part of
// GameState, so an aliasing bug in a field it does not hash (deck contents, cost
// mods, board objects, pendingAction...) can get through while still corrupting an
// MCTS agent's probe. This tool finds the exact field:
//   before each ply  : snap = structuredClone(state)   (a frozen "before" copy)
//   apply             : next = applyAction(state, act)
//   after             : deepDiff(state, snap)           (state should == snap)
// The first path that differs is the mutated field; it is logged with the action
// that caused it. Runs over the corpus (heuristic self-play) so every god's effects fire.
//
//   npx tsx src/ai/cli/findMutation.ts --reps 2 --max 25
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { cards } from "../../engine/testkit";
import { createInitialState } from "../../engine/rules";
import { Rng } from "../../engine/rng";
import { HeuristicAgent } from "../agents/HeuristicAgent";
import { actingSide, legalActions, applyAction, type Action } from "../actions";
import type { GameState } from "../../engine/state";
import type { Side } from "../../engine/board";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const REPS = parseInt(arg("--reps", "2"), 10);
const MAX = parseInt(arg("--max", "25"), 10); // stop after this many distinct findings

cards();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DECKS_PATH = path.resolve(HERE, "../../../decks-corpus/decks.json");
const corpus = JSON.parse(fs.readFileSync(DECKS_PATH, "utf-8")) as Array<{ god: string; cards: Array<{ id: number; count: number }> }>;
const byGod = new Map<string, number[][]>();
for (const d of corpus) {
  const g = (d.god || "").toUpperCase();
  if (g === "FECA") continue;
  const expanded = d.cards.flatMap((c) => Array(c.count).fill(c.id) as number[]);
  if (expanded.length !== 45) continue;
  if (!byGod.has(g)) byGod.set(g, []);
  byGod.get(g)!.push(expanded);
}
const reps: { god: string; deck: number[] }[] = [];
for (const [g, decks] of byGod) for (const deck of decks.slice(0, REPS)) reps.push({ god: g, deck });
console.log(`corpus reps: ${reps.length} decks across ${byGod.size} gods (${REPS}/god)`);

// First structural difference between `a` (live "after") and `b` (snapshot
// "before"). Handles plain objects, arrays, and Sets. Returns the dotted path
// + both values, or null if identical.
type Diff = { path: string; a: unknown; b: unknown };
function deepDiff(a: unknown, b: unknown, p = ""): Diff | null {
  if (a === b) return null;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return { path: p, a, b };
  const aSet = a instanceof Set, bSet = b instanceof Set;
  if (aSet || bSet) {
    if (!aSet || !bSet) return { path: p, a: aSet ? "Set" : typeof a, b: bSet ? "Set" : typeof b };
    if ((a as Set<unknown>).size !== (b as Set<unknown>).size) return { path: `${p}.size`, a: (a as Set<unknown>).size, b: (b as Set<unknown>).size };
    for (const v of a as Set<unknown>) if (!(b as Set<unknown>).has(v)) return { path: `${p}{has ${String(v)}}`, a: "present", b: "absent" };
    return null;
  }
  const aArr = Array.isArray(a), bArr = Array.isArray(b);
  if (aArr !== bArr) return { path: p, a: aArr ? "array" : typeof a, b: bArr ? "array" : typeof b };
  if (aArr) {
    if ((a as unknown[]).length !== (b as unknown[]).length) return { path: `${p}.length`, a: (a as unknown[]).length, b: (b as unknown[]).length };
    for (let i = 0; i < (a as unknown[]).length; i++) { const d = deepDiff((a as unknown[])[i], (b as unknown[])[i], `${p}[${i}]`); if (d) return d; }
    return null;
  }
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  for (const k of keys) { const d = deepDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], p ? `${p}.${k}` : k); if (d) return d; }
  return null;
}

function describe(act: Action): string {
  if (act.kind === "play") return `play#${act.cardId}@${act.target.x},${act.target.y}`;
  if (act.kind === "resolve") return `resolve@${act.target.x},${act.target.y}`;
  if (act.kind === "mulligan") return `mulligan[${act.returnIndices.join("")}]`;
  return act.kind;
}

// Collapse a concrete path to a shape key so [3]/[7] etc. count as one finding.
const shape = (p: string) => p.replace(/\[\d+\]/g, "[]").replace(/\{has [^}]+\}/g, "{}");

const findings = new Map<string, { path: string; act: string; pending: string | null; god: string; seed: number; before: unknown; after: unknown }>();

function report(diff: Diff | null, actDesc: string, pending: string | null, side: Side, godA: string, godB: string, seed: number): void {
  if (!diff) return;
  const god = side === "ally" ? godA : godB;
  const isPlay = actDesc.startsWith("play#");
  const key = shape(diff.path) + " | " + (isPlay ? actDesc.split("@")[0] : actDesc.replace(/\(.*\)/, ""));
  if (findings.has(key)) return;
  findings.set(key, { path: diff.path, act: actDesc, pending, god, seed, before: diff.b, after: diff.a });
  console.log(`\n  [MUT] ${diff.path}`);
  console.log(`        via=${actDesc} mover=${side}(${god})${pending ? ` pending="${pending}"` : ""} seed=${seed}`);
  console.log(`        before=${JSON.stringify(diff.b)?.slice(0, 140)}  ->  after=${JSON.stringify(diff.a)?.slice(0, 140)}`);
}

function scan(deckA: number[], deckB: number[], godA: string, godB: string, seed: number): boolean {
  let state = createInitialState({ ally: deckA, enemy: deckB }, { seed });
  const rng = new Rng((seed ^ 0x9e3779b9) | 0);
  const a = new HeuristicAgent(), b = new HeuristicAgent();
  let plies = 0;
  while (state.winner === null && state.turn <= 200) {
    const side: Side = actingSide(state);
    const legal = legalActions(state);
    if (legal.length === 0) break;
    const pa = state.pendingAction;
    const pendingSummary = pa ? `${pa.prompt ?? "pending"}${pa.summonAfter ? ` +summon#${pa.summonAfter.cardId}` : ""}` : null;
    // (1) Did the agent's internal probing (chooseAction → applyAction lookahead)
    //     mutate the live state? This is the seed-15 suspect.
    const snapChoose = structuredClone(state) as GameState;
    const act = (side === "ally" ? a : b).chooseAction(state, legal, rng);
    report(deepDiff(state, snapChoose), `chooseAction(${legal.length} legal)`, pendingSummary, side, godA, godB, seed);
    // (2) Did the chosen applyAction mutate its input?
    const snap = structuredClone(state) as GameState;
    const next = applyAction(state, act);
    report(deepDiff(state, snap), describe(act), pendingSummary, side, godA, godB, seed);
    if (findings.size >= MAX) return true;
    state = next;
    if (++plies > 1500) break;
  }
  return false;
}

let seed = 15;
outer: for (let i = 0; i < reps.length; i++) {
  for (let j = 0; j < reps.length; j++) {
    seed++;
    if (scan(reps[i].deck, reps[j].deck, reps[i].god, reps[j].god, seed)) break outer;
  }
  process.stderr.write(`\r  scanning ${i + 1}/${reps.length} (distinct findings: ${findings.size})    `);
}

console.log(`\n\n=== ${findings.size} distinct mutation shape(s) ===`);
for (const f of findings.values()) console.log(`  ${f.path}\n    via ${f.act}${f.pending ? ` (pending: ${f.pending})` : ""}  [${f.god}, seed ${f.seed}]`);
if (findings.size === 0) console.log("  none — applyAction is pure across the scanned corpus.");
