// Policy v2 extraction: soft targets from the recorded search (RawGame.pis).
// Unlike v1 (one-hot of the played move), v2 rebuilds the full pooled visit
// distribution the 2x160 search produced at each decision ("these two moves were
// close" vs "this one was far better" is the signal v1 did not have). Replays each
// game up to the pi decision, encode2s the state, and turns the recorded
// [action,visits] list into what/where marginals with policyTargets.
//   npx tsx src/ai/cli/rawToPolicyV2.ts --in data/rw1/games.0.jsonl --out data/policy_v2/desk_0
// For campaign games, run it from the frozen code tree that generated them (same engine).
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { cards } from "../../engine/testkit";
import { createInitialState } from "../../engine/rules";
import { buildCardIndex2, encode2, encodingLength2 } from "../encode2";
import { policyTargets, whatSize, WHERE_SIZE } from "../policy";
import { actingSide, applyAction } from "../actions";
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

  let rows = 0, games = 0, skipped = 0, noPi = 0, ord = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(IN), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let raw: RawGame;
    try { raw = JSON.parse(line) as RawGame; } catch { continue; }
    if (raw.v !== "raw-v1" || raw.res.w === 0) continue;
    if (!raw.pis || raw.pis.length === 0) { noPi++; continue; }
    const byIdx = new Map(raw.pis.map((p) => [p.i, p]));
    const gods = raw.mu?.a.god && raw.mu?.e.god ? { ally: raw.mu.a.god, enemy: raw.mu.e.god } : undefined;
    let state = createInitialState({ ally: raw.decks.a, enemy: raw.decks.e }, { seed: raw.seed, firstSide: raw.first, gods });
    const rec: { side: Side; x: Float32Array; what: Float32Array; where: Float32Array }[] = [];
    let ok = true;
    try {
      for (let k = 0; k < raw.acts.length; k++) {
        const pi = byIdx.get(k);
        if (pi && !state.mulligan) {
          const side = actingSide(state);
          const stats = pi.s.map(([ra, v]) => ({ action: decodeAction(ra), visits: v }));
          const { what, where } = policyTargets(stats, cardIndex);
          rec.push({ side, x: encode2(state, side, { cardIndex, belief: null }), what, where });
        }
        state = applyAction(state, decodeAction(raw.acts[k]));
      }
    } catch { ok = false; }
    const w = state.winner === null ? 0 : state.winner === "ally" ? 1 : -1;
    if (!ok || w !== raw.res.w || state.turn !== raw.res.turns) { skipped++; continue; }
    const g = ord++;
    games++;
    for (const d of rec) {
      const z = (raw.res.w === 1) === (d.side === "ally") ? 1 : -1;
      xWs.write(Buffer.from(d.x.buffer, d.x.byteOffset, d.x.byteLength));
      whatWs.write(Buffer.from(d.what.buffer, d.what.byteOffset, d.what.byteLength));
      whereWs.write(Buffer.from(d.where.buffer, d.where.byteOffset, d.where.byteLength));
      const zb = Buffer.alloc(4); zb.writeFloatLE(z, 0); zWs.write(zb);
      const ib = Buffer.alloc(4); ib.writeUInt32LE(g, 0); idxWs.write(ib);
      rows++;
    }
  }
  await Promise.all([xWs, whatWs, whereWs, zWs, idxWs].map((ws) => new Promise((res) => ws.end(res))));
  fs.writeFileSync(`${OUT}.meta.json`, JSON.stringify({
    schema: "policy-v1", encLen, whatSize: WS, whereSize: WHERE_SIZE,
    source: "raw-extraction-SOFT", in: IN, counts: { games, rows, skipped, noPi },
  }, null, 2));
  console.log(`done: ${rows} rows from ${games} games (${skipped} skipped, ${noPi} no-pi) -> ${OUT}.x.f32`);
}

main();
