// Policy v1 extraction: reuse the existing raw self-play games as policy training
// data, with no generation cost. Each recorded decision (not the mulligan, more
// than 1 legal action) becomes one sample: x = encode2(state, mover), what/where =
// one-hot of the action the 2x160 teacher actually played (the raw games did not
// store the visit distributions; soft targets come in v2), z = final outcome from
// the mover's view. The output has the same format as genPolicyData.ts, so
// train_policy.py / export_policy.py run unchanged.
//
//   npx tsx src/ai/cli/rawToPolicyData.ts --in data/expert8/games.0.jsonl --out data/policy_v1/desktop_0
//
// For campaign games, run it from the frozen code tree that generated them (same engine).
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { cards } from "../../engine/testkit";
import { createInitialState } from "../../engine/rules";
import { buildCardIndex2, encode2, encodingLength2 } from "../encode2";
import { policyTargets, whatSize, WHERE_SIZE } from "../policy";
import { actingSide, legalActions, applyAction } from "../actions";
import { decodeAction, type RawGame } from "../selfplay/recordRaw";
import type { Side } from "../../engine/board";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const IN = arg("--in", "");
const OUT = arg("--out", "");
if (!IN || !OUT) { console.error("usage: --in <games.jsonl> --out <prefix>"); process.exit(1); }

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VOCAB = path.resolve(HERE, "../vocab.json");

async function main(): Promise<void> {
  cards();
  const vocab = JSON.parse(fs.readFileSync(VOCAB, "utf-8")) as { ids: number[] };
  const cardIndex = buildCardIndex2(vocab.ids);
  const encLen = encodingLength2(cardIndex);
  const WS = whatSize(cardIndex);

  fs.mkdirSync(path.dirname(path.resolve(`${OUT}.x.f32`)) || ".", { recursive: true });
  const xWs = fs.createWriteStream(`${OUT}.x.f32`);
  const whatWs = fs.createWriteStream(`${OUT}.what.f32`);
  const whereWs = fs.createWriteStream(`${OUT}.where.f32`);
  const zWs = fs.createWriteStream(`${OUT}.z.f32`);
  const idxWs = fs.createWriteStream(`${OUT}.idx.u32`);

  let rows = 0, games = 0, skipped = 0, ord = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(IN), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let raw: RawGame;
    try { raw = JSON.parse(line) as RawGame; } catch { continue; }
    if (raw.v !== "raw-v1" || raw.res.w === 0) continue;
    const gods = raw.mu?.a.god && raw.mu?.e.god ? { ally: raw.mu.a.god, enemy: raw.mu.e.god } : undefined;
    let state = createInitialState({ ally: raw.decks.a, enemy: raw.decks.e }, { seed: raw.seed, firstSide: raw.first, gods });
    const decisions: { side: Side; x: Float32Array; what: Float32Array; where: Float32Array }[] = [];
    let ok = true;
    try {
      for (const r of raw.acts) {
        const action = decodeAction(r);
        if (!state.mulligan && action.kind !== "mulligan") {
          const legal = legalActions(state);
          if (legal.length > 1) {
            const side = actingSide(state);
            // one-hot: the played action carries all the (virtual) visits
            const { what, where } = policyTargets([{ action, visits: 1 }], cardIndex);
            decisions.push({ side, x: encode2(state, side, { cardIndex, belief: null }), what, where });
          }
        }
        state = applyAction(state, action);
      }
    } catch { ok = false; }
    // replay gate: same winner + turns as recorded, else drop the whole game
    const w = state.winner === null ? 0 : state.winner === "ally" ? 1 : -1;
    if (!ok || w !== raw.res.w || state.turn !== raw.res.turns) { skipped++; continue; }
    const gameOrd = ord++;
    games++;
    for (const d of decisions) {
      const z = (raw.res.w === 1) === (d.side === "ally") ? 1 : -1;
      xWs.write(Buffer.from(d.x.buffer, d.x.byteOffset, d.x.byteLength));
      whatWs.write(Buffer.from(d.what.buffer, d.what.byteOffset, d.what.byteLength));
      whereWs.write(Buffer.from(d.where.buffer, d.where.byteOffset, d.where.byteLength));
      const zb = Buffer.alloc(4); zb.writeFloatLE(z, 0); zWs.write(zb);
      const ib = Buffer.alloc(4); ib.writeUInt32LE(gameOrd, 0); idxWs.write(ib);
      rows++;
    }
  }
  await Promise.all([xWs, whatWs, whereWs, zWs, idxWs].map((ws) => new Promise((res) => ws.end(res))));
  fs.writeFileSync(`${OUT}.meta.json`, JSON.stringify({
    schema: "policy-v1", encLen, whatSize: WS, whereSize: WHERE_SIZE,
    source: "raw-extraction-onehot", in: IN, heldOutFold: 0,
    counts: { games, rows, skipped },
  }, null, 2));
  console.log(`done: ${rows} rows from ${games} games (${skipped} skipped) -> ${OUT}.x.f32`);
}

main();
