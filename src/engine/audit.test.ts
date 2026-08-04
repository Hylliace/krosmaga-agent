// Structural fidelity audit: catches whole classes of card-wiring bugs mechanically
// instead of relying on a review card by card (which let Malocac #85 through:
// "Récupérez UN prisme adverse" was wired to grab the nearest enemy prism with no
// pick). These tests check each card's description against the real engine
// targeting logic (effectRequiresTarget / effectTargetFilter), so a regression fails
// the suite at once.
//
// When a card really resolves automatically despite a singular-target wording, add it
// to the matching allowlist with a reason, so it is a deliberate choice.
import { describe, it, expect } from "vitest";
import { cards } from "./testkit";
import { effectRequiresTarget, effectTargetFilter } from "./effects";
import type { Effect } from "../data/types";

const strip = (s: string) =>
  (s || "").replace(/<[^>]+>/g, "").replace(/\\_/g, " ").replace(/\\n/g, " ").replace(/\|_/g, " ").toLowerCase();

// Active effects of a card: spells cast via effects[]; summons/triggers act via triggers[].
// (A summon's effects[] active entries are dead bindata, never applied at summon.)
function activeEffects(card: { cardType?: string; effects?: Effect[]; triggers?: { effects: Effect[] }[] }): Effect[] {
  const isSummon = card.cardType === "Summon";
  return [
    ...(isSummon ? [] : (card.effects ?? [])),
    ...((card.triggers ?? []).flatMap((t) => t.effects ?? [])),
  ];
}

// Effect types that act on a single chosen target (so singular text ⇒ they must open a pick).
const SINGLE_CAPABLE = new Set([
  "RamasserPrisme", "RespawnPrisms", "Heal", "BoostAttack", "BoostArmor", "BoostMovement",
  "BoostRange", "Charge", "Silence", "Destroy", "Transform", "Teleport", "SwapBody",
  "DamageDofus", "RevealDofuses", "DestroyPrism", "DestroyArmor", "AttractCreature",
  "SetLife", "TakeControl",
]);

describe("Fidélité structurelle texte ↔ ciblage moteur", () => {
  it("toute carte au texte « un/une/ciblé X » avec un effet mono-cible OUVRE un pick", () => {
    // Allowlist: cards whose singular wording legitimately does not open a pick.
    const ALLOW = new Set<number>([
      700, // Nécronomigore: card not wired yet (the Orbe fusion part is missing)
    ]);
    const offenders: string[] = [];
    for (const [id, c] of cards()) {
      if (ALLOW.has(id)) continue;
      const card = c as unknown as { cardType?: string; effects?: Effect[]; triggers?: { effects: Effect[] }[]; description?: string; name?: string };
      const desc = strip(card.description ?? "");
      const singular =
        /\b(un|une)\s+(invocation|prisme|dofus|glyphe|graine|butin)/.test(desc) || /cibl[ée]/.test(desc);
      if (!singular) continue;
      const effs = activeEffects(card);
      const hasSingleCapable = effs.some(
        (e) => SINGLE_CAPABLE.has(e.type) && !(e as { scope?: unknown }).scope && !(e as { self?: unknown }).self && !(e as { all?: unknown }).all,
      );
      if (!hasSingleCapable) continue;
      const anyPick = effs.some((e) => { try { return effectRequiresTarget(e); } catch { return false; } });
      if (!anyPick) offenders.push(`#${id} ${card.name} — « ${desc.trim().slice(0, 70)} »`);
    }
    expect(offenders, `Cartes au texte mono-cible sans pick (ajouter un choose:true OU à l'allowlist):\n${offenders.join("\n")}`).toEqual([]);
  });

  it("un pick restreint par le texte (« adverse » / « vos ») a le bon filtre de camp", () => {
    // Allowlist: false positives where the text mentions both camps or the side is incidental.
    const ALLOW = new Set<number>([
      700, // Nécronomigore: the text says both "adverse" and "allié" (card not wired yet)
    ]);
    const offenders: string[] = [];
    for (const [id, c] of cards()) {
      if (ALLOW.has(id)) continue;
      const card = c as unknown as { cardType?: string; effects?: Effect[]; triggers?: { effects: Effect[] }[]; description?: string; name?: string };
      const desc = strip(card.description ?? "");
      const saysEnemy = /(adverse|ennemi)/.test(desc);
      const saysAlly = /(vos |votre |alli[ée])/.test(desc);
      if (saysEnemy === saysAlly) continue; // neither, or both → ambiguous, skip
      for (const e of activeEffects(card)) {
        let req = false;
        try { req = effectRequiresTarget(e); } catch { /* not a target effect */ }
        if (!req) continue;
        let f = "";
        try { f = effectTargetFilter(e).filter; } catch { continue; }
        if (saysEnemy && /^ally_/.test(f)) offenders.push(`#${id} ${card.name} — texte 'adverse' mais filtre ${f}`);
        if (saysAlly && /^enemy_/.test(f)) offenders.push(`#${id} ${card.name} — texte 'vos/allié' mais filtre ${f}`);
      }
    }
    expect(offenders, `Filtres de pick incohérents avec le texte:\n${offenders.join("\n")}`).toEqual([]);
  });
});
