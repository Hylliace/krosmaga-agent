// A tiny card lookup the engine can use to materialise token creatures
// (Transform → Chacha Noir, SummonToken → Lapinos, …). The engine works on
// CreatureInstances, not Cards, so anything that needs a token's stats reads
// them from here. The UI registers the full loaded pool once at startup
// (App.tsx); tests register the disk pool (testkit). Empty until registered,
// effects that need a token then no-op rather than throw.
import type { Card } from "../data/types";

let registry: Map<number, Card> = new Map();
// Every family key present in the loaded pool ("Enutrof", "Iop", …). Built once
// at registration so the engine can tell a real family token apart from other
// castTarget modifiers (e.g. "Wounded") in "Allied<Family>Summon" targets.
let familySet: Set<string> = new Set();
// family key -> sorted ids of its non-dev Summon cards. Sorted so a seeded RNG
// indexing into it is reproducible across runs (Nomekop's "2 random Chachas").
let summonsByFamily: Map<string, number[]> = new Map();
// cost -> sorted ids of non-dev Summon cards of that cost ("invocations
// aléatoires coûtant N PA", Otomaï). Same stable-order reproducibility need.
let summonsByCost: Map<number, number[]> = new Map();

// Incremented on every registration. Any cache derived from the card definitions
// (see auraProfileCache in rules.ts) has to be cleared when this counter changes;
// otherwise registering another pool would keep values computed on the old registry.
let generation = 0;

/** Current registry generation. Changes on every registerCards(). */
export function registryGeneration(): number {
  return generation;
}

export function registerCards(cards: Iterable<Card>): void {
  generation++;
  registry = new Map();
  familySet = new Set();
  const byFam = new Map<string, number[]>();
  const byCost = new Map<number, number[]>();
  for (const c of cards) {
    registry.set(c.id, c);
    const isSummon = c.cardType === "Summon" && !(c as { isDevCard?: boolean }).isDevCard;
    for (const f of c.families ?? []) {
      familySet.add(f);
      if (isSummon) (byFam.get(f) ?? byFam.set(f, []).get(f)!).push(c.id);
    }
    if (isSummon && typeof c.cost === "number") {
      (byCost.get(c.cost) ?? byCost.set(c.cost, []).get(c.cost)!).push(c.id);
    }
  }
  for (const ids of byFam.values()) ids.sort((a, b) => a - b);
  for (const ids of byCost.values()) ids.sort((a, b) => a - b);
  summonsByFamily = byFam;
  summonsByCost = byCost;
}

export function getCard(id: number): Card | undefined {
  return registry.get(id);
}

export function isKnownFamily(name: string): boolean {
  return familySet.has(name);
}

/** Sorted ids of the non-dev Summon cards in a family (empty if none / unknown).
 *  Used for "summon a random creature of family X" (Nomekop). */
export function summonsOfFamily(family: string): number[] {
  return summonsByFamily.get(family) ?? [];
}

/** Sorted ids of the non-dev Summon cards of an exact cost (empty if none).
 *  Used for "transform into a random creature costing N PA" (Otomaï). */
export function summonsOfCost(cost: number): number[] {
  return summonsByCost.get(cost) ?? [];
}

/** A board creature's effective families, its per-instance `familyOverride`
 *  (Pupuce #441 "devient de la famille de la cible") if set, else the card's own
 *  families. Use this (not getCard(c.cardId).families) for any board creature. */
export function famsOf(c: { cardId: number; familyOverride?: string[] }): string[] {
  return c.familyOverride ?? getCard(c.cardId)?.families ?? [];
}
