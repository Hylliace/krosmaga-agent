// Frozen v3 layout, version 1 (215 planes), the layout the deployed value network
// was trained and exported with (enc_len 20442).
//
// Why this file exists: PLANES3 comes from the observation registry (properties,
// triggers, families). Each entry added to the registry, for example the four
// entries the Pandawa god needs ("Saoul", "SAOUL", "Pandawa" and "Tonneau"), creates
// two planes (mine and the opponent's) and shifts everything after it. The vector
// then goes from 20442 to 20842 columns, and the served network, trained on the old
// layout, can no longer read it: the search crashed at its first leaf evaluation,
// for every god.
//
// So the training layout of a model is data, not a consequence of the current code,
// and it is frozen here. `projectToLayout` (legacyLayout) rebuilds this vector to the
// byte from the current encoding, as long as the registry only grows by additions
// (nothing removed, nothing renamed).
//
// Never change this list. A future network trained on a wider layout will describe
// it in its own manifest, and this one stays the anchor of the deployed model.
export const PLANES3_V1: readonly string[] = [
  "my_creature", "my_attack", "my_life", "my_armor", "my_movement", "my_movement_left",
  "my_ready", "my_base_attack", "my_base_life", "foe_creature", "foe_attack", "foe_life",
  "foe_armor", "foe_movement", "foe_movement_left", "foe_ready", "foe_base_attack",
  "foe_base_life", "my_range", "my_resistance", "my_vulnerability", "my_movement_poison",
  "foe_range", "foe_resistance", "foe_vulnerability", "foe_movement_poison", "my_silenced",
  "my_guarded", "my_oneshot_spent", "my_temp_control", "my_temp_stat", "my_cost",
  "foe_silenced", "foe_guarded", "foe_oneshot_spent", "foe_temp_control", "foe_temp_stat",
  "foe_cost", "my_prop_CantDie", "my_prop_DamageCap1",
  "my_prop_DamagesInSquareFriendlyFireIncludingDofuses", "my_prop_DamagesOn3CellsSameColumn",
  "my_prop_DeckOnDeath", "my_prop_DiesAtEndOfTurn", "my_prop_DontTriggerPrismsEffects",
  "my_prop_FirstStrike", "my_prop_FullMoon", "my_prop_HealingsDoDamageInstead",
  "my_prop_Invulnerable", "my_prop_MoonGuard", "my_prop_NoMovementPoints",
  "my_prop_NoSummoningSickness", "my_prop_PierceArmor", "my_prop_ProtectsOwnDofus",
  "my_prop_Ralliement", "my_prop_ReturnToHandOnDeath", "my_prop_Rooted", "my_prop_Shield",
  "my_prop_SpellDamageInsensitivity", "my_prop_Statue", "my_prop_Stunned",
  "my_prop_Untargetable", "foe_prop_CantDie", "foe_prop_DamageCap1",
  "foe_prop_DamagesInSquareFriendlyFireIncludingDofuses", "foe_prop_DamagesOn3CellsSameColumn",
  "foe_prop_DeckOnDeath", "foe_prop_DiesAtEndOfTurn", "foe_prop_DontTriggerPrismsEffects",
  "foe_prop_FirstStrike", "foe_prop_FullMoon", "foe_prop_HealingsDoDamageInstead",
  "foe_prop_Invulnerable", "foe_prop_MoonGuard", "foe_prop_NoMovementPoints",
  "foe_prop_NoSummoningSickness", "foe_prop_PierceArmor", "foe_prop_ProtectsOwnDofus",
  "foe_prop_Ralliement", "foe_prop_ReturnToHandOnDeath", "foe_prop_Rooted", "foe_prop_Shield",
  "foe_prop_SpellDamageInsensitivity", "foe_prop_Statue", "foe_prop_Stunned",
  "foe_prop_Untargetable", "my_trig_APPARITION", "my_trig_CONTRE_COUP",
  "my_trig_COUP_DE_GRACE", "my_trig_DEBUT_DE_TOUR", "my_trig_ENTERS_PLAY",
  "my_trig_FIN_DE_TOUR", "my_trig_MORT", "my_trig_MORT_ADVERSE", "my_trig_MORT_ALLIEE",
  "my_trig_ON_DAMAGE", "my_trig_ON_DRAW", "my_trig_ON_PLAY", "my_trig_ON_PRISM",
  "my_trig_POST_ADVANCE", "my_trig_RALLIEMENT", "foe_trig_APPARITION", "foe_trig_CONTRE_COUP",
  "foe_trig_COUP_DE_GRACE", "foe_trig_DEBUT_DE_TOUR", "foe_trig_ENTERS_PLAY",
  "foe_trig_FIN_DE_TOUR", "foe_trig_MORT", "foe_trig_MORT_ADVERSE", "foe_trig_MORT_ALLIEE",
  "foe_trig_ON_DAMAGE", "foe_trig_ON_DRAW", "foe_trig_ON_PLAY", "foe_trig_ON_PRISM",
  "foe_trig_POST_ADVANCE", "foe_trig_RALLIEMENT", "my_fam_Arakne", "my_fam_Bandit",
  "my_fam_BrotherhoodOfTheTofu", "my_fam_Cawotte", "my_fam_Chacha", "my_fam_Chafer",
  "my_fam_Chest", "my_fam_Cochon", "my_fam_Corbac", "my_fam_Cra", "my_fam_Crackler",
  "my_fam_Doll", "my_fam_Ecaflip", "my_fam_Enutrof", "my_fam_Fléau", "my_fam_Fratrie",
  "my_fam_Gligli", "my_fam_Gobbal", "my_fam_Goule", "my_fam_Iop", "my_fam_Jelly",
  "my_fam_Justicier", "my_fam_Kokoko", "my_fam_Larve", "my_fam_Moogrr", "my_fam_Mulou",
  "my_fam_Phorreur", "my_fam_Pichon", "my_fam_Piou", "my_fam_Rat", "my_fam_Sacrieur",
  "my_fam_Sadida", "my_fam_Scara", "my_fam_Sram", "my_fam_Tofu", "my_fam_Truche",
  "my_fam_Wabbit", "foe_fam_Arakne", "foe_fam_Bandit", "foe_fam_BrotherhoodOfTheTofu",
  "foe_fam_Cawotte", "foe_fam_Chacha", "foe_fam_Chafer", "foe_fam_Chest", "foe_fam_Cochon",
  "foe_fam_Corbac", "foe_fam_Cra", "foe_fam_Crackler", "foe_fam_Doll", "foe_fam_Ecaflip",
  "foe_fam_Enutrof", "foe_fam_Fléau", "foe_fam_Fratrie", "foe_fam_Gligli", "foe_fam_Gobbal",
  "foe_fam_Goule", "foe_fam_Iop", "foe_fam_Jelly", "foe_fam_Justicier", "foe_fam_Kokoko",
  "foe_fam_Larve", "foe_fam_Moogrr", "foe_fam_Mulou", "foe_fam_Phorreur", "foe_fam_Pichon",
  "foe_fam_Piou", "foe_fam_Rat", "foe_fam_Sacrieur", "foe_fam_Sadida", "foe_fam_Scara",
  "foe_fam_Sram", "foe_fam_Tofu", "foe_fam_Truche", "foe_fam_Wabbit", "my_dofus_hp",
  "my_dofus_real", "my_dofus_fake", "my_dofus_revealed", "foe_dofus_hp",
  "foe_dofus_real_belief", "foe_dofus_revealed_real", "foe_dofus_revealed_fake",
  "dofus_protected", "dofus_shielded", "dofus_invulnerable", "dofus_invuln_turns",
  "dofus_equip_sinistro", "dofus_equip_necro", "dofus_equip_necro_left", "prism_ap",
  "prism_draw", "prism_fleau", "ground_seed", "ground_trap", "ground_trap_damage",
  "ground_tasdos", "ground_bush", "ground_glyph", "ground_butin"
];

/** Number of planes of this layout (globals and V-vectors unchanged). */
export const N_PLANES3_V1 = PLANES3_V1.length;
