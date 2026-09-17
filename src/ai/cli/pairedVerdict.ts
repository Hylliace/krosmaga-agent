// Verdict of a paired arena (netArena --paired): analysis by pair.
//
// In paired mode, each matchup is played twice (same decks, same seed, seats
// swapped). The marginal win rate ignores the pairing and gains no power; the
// signal is in the discordant pairs: those where A wins both games (n2) against
// those where B wins both (n0). The split pairs (1-1) say nothing about the
// difference in strength. Exact two-sided binomial test on n2 out of n2+n0
// (McNemar). The share of informative pairs also says how much the change matters.
//
//   npx tsx src/ai/cli/pairedVerdict.ts data/arena_ab/myAB_*.log
import * as fs from "node:fs";

function perGame(txt: string): Map<number, 0 | 1> {
  const out = new Map<number, 0 | 1>();
  let pw = 0, pd = 0;
  for (const m of txt.matchAll(/game (\d+)\/\d+ \| (?:net|A) (\d+)\/(\d+) =/g)) {
    const gi = +m[1], w = +m[2], d = +m[3];
    if (d !== pd + 1) { pw = w; pd = d; continue; } // draw or error: the game does not count
    out.set(gi, w === pw + 1 ? 1 : 0);
    pw = w; pd = d;
  }
  return out;
}

/** P(X <= k), then two-sided, binomial(n, 1/2), in logs to avoid overflow. */
function binomTwoSided(k: number, n: number): number {
  if (n === 0) return 1;
  const lo = Math.min(k, n - k);
  let p = 0;
  for (let i = 0; i <= lo; i++) p += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, 2 * p);
}
function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

const files = process.argv.slice(2);
if (files.length === 0) { console.error("usage: pairedVerdict <netArena --paired log>..."); process.exit(2); }
let n2 = 0, n0 = 0, n1 = 0, W = 0, N = 0;
for (const f of files) {
  const txt = fs.readFileSync(f, "utf-8");
  const res = /RESULT: (?:net|A) (\d+)\/(\d+) decided/.exec(txt);
  if (res) { W += +res[1]; N += +res[2]; }
  const pairs = new Map<number, number[]>();
  for (const [gi, r] of perGame(txt)) (pairs.get((gi - 1) >> 1) ?? pairs.set((gi - 1) >> 1, []).get((gi - 1) >> 1)!).push(r);
  for (const v of pairs.values()) {
    if (v.length !== 2) continue;
    const s = v[0] + v[1];
    if (s === 2) n2++; else if (s === 0) n0++; else n1++;
  }
}
const n = n2 + n0;
const p = binomTwoSided(n2, n);
console.log(`${files.length} file(s) | marginal A ${W}/${N} = ${N ? (100 * W / N).toFixed(1) : "-"}% (for information only)`);
console.log(`pairs: ${n2 + n0 + n1} complete, of which ${n} discordant (${n2 + n0 + n1 ? (100 * n / (n2 + n0 + n1)).toFixed(0) : "-"}% informative)`);
console.log(`  A wins both: ${n2}   B wins both: ${n0}   split: ${n1}`);
if (n === 0) console.log("VERDICT: no discordant pair, the two agents played the same way (equal agents or too few games).");
else console.log(`VERDICT: A wins ${(100 * n2 / n).toFixed(1)}% of the discordant pairs, p = ${p.toFixed(4)} ${p < 0.05 ? "(significant)" : "(not significant)"}`);
