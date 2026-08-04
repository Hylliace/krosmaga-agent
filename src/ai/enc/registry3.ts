// v3: the frozen enumerations the v3 encoder iterates over.
// Three rules:
//
//  1. These lists are snapshots of what the engine and data actually use, never a
//     hand-picked subset (that is how encode2 ended up with 10 of 23 properties
//     and missed things the player could see).
//  2. registry3.sync.test.ts scans the engine sources and the card data again and
//     fails as soon as a list here differs, so adding a property/trigger/family to
//     the game without freezing again (and retraining) fails CI instead of going
//     unnoticed.
//  3. The order is fixed (alphabetical) and is part of the encoding layout:
//     reordering is an encoding change and needs a retrain.
//
// Kept in ai/enc/ (not in engine/ or data/), with the sync test as the only link
// between the two.

/** Every creature `properties` keyword the engine reads/writes (24). Source of
 *  truth: string literals in `properties.has/add/delete(...)` across src/engine
 *  plus `property:` values in the card data (a strict subset). NOTE: the very
 *  first freeze attempt listed 23, the sync gate caught the missing
 *  `NoMovementPoints` immediately, which is the whole point of the gate. */
export const PROPERTIES3 = [
  "CantDie",
  "DamageCap1",
  "DamagesInSquareFriendlyFireIncludingDofuses",
  "DamagesOn3CellsSameColumn",
  "DeckOnDeath",
  "DiesAtEndOfTurn",
  "DontTriggerPrismsEffects",
  "FirstStrike",
  "FullMoon",
  "HealingsDoDamageInstead",
  "Invulnerable",
  "MoonGuard",
  "NoMovementPoints",
  "NoSummoningSickness",
  "PierceArmor",
  "ProtectsOwnDofus",
  "Ralliement",
  "ReturnToHandOnDeath",
  "Rooted",
  "Shield",
  "SpellDamageInsensitivity",
  "Statue",
  "Stunned",
  "Untargetable",
] as const;

/** Every TriggerType member (15), mirrors the union in data/types.ts (the sync
 *  test parses that file's source; first freeze missed RALLIEMENT, caught by
 *  the gate). A creature's snapshotted `triggers` drive the has-<type> planes,
 *  so silence (which strips triggers) is reflected. */
export const TRIGGER_TYPES3 = [
  "APPARITION",
  "CONTRE_COUP",
  "COUP_DE_GRACE",
  "DEBUT_DE_TOUR",
  "ENTERS_PLAY",
  "FIN_DE_TOUR",
  "MORT",
  "MORT_ADVERSE",
  "MORT_ALLIEE",
  "ON_DAMAGE",
  "ON_DRAW",
  "ON_PLAY",
  "ON_PRISM",
  "POST_ADVANCE",
  "RALLIEMENT",
] as const;

/** Every family referenced by a rule (an effect / trigger filter / pending
 *  `family:` field in the card data, the engine's own hardcoded literals,
 *  "Chafer"/"Phorreur", are a subset). 37 as of the freeze. Families no rule
 *  reads are deliberately not here (they would be dead planes); the identity
 *  V-vectors still carry them implicitly. */
export const FAMILIES3 = [
  "Arakne",
  "Bandit",
  "BrotherhoodOfTheTofu",
  "Cawotte",
  "Chacha",
  "Chafer",
  "Chest",
  "Cochon",
  "Corbac",
  "Cra",
  "Crackler",
  "Doll",
  "Ecaflip",
  "Enutrof",
  "Fléau",
  "Fratrie",
  "Gligli",
  "Gobbal",
  "Goule",
  "Iop",
  "Jelly",
  "Justicier",
  "Kokoko",
  "Larve",
  "Moogrr",
  "Mulou",
  "Phorreur",
  "Pichon",
  "Piou",
  "Rat",
  "Sacrieur",
  "Sadida",
  "Scara",
  "Sram",
  "Tofu",
  "Truche",
  "Wabbit",
] as const;
