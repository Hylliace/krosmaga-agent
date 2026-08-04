"""Inject authored effects (from the workspace's card_effects_spec.json) into the
card data the engine loads (see pipeline/paths.py for where that is).

A card only gets an authored effect when the engine can run it faithfully, so we
only inject when all of these hold:

  1. cardType == "Spell": top-level effects[] is the spell-cast path. Summons
     run their effects from a trigger (APPARITION / MORT), not from effects[],
     so injecting there would do nothing.
  2. every effect type of the spec is implemented. A spell that mixes "Heal"
     and "DrawCards" stays empty until DrawCards has an executor, because
     shipping only the heal would misrepresent the card.
  3. single target, creature target: the Heal/Destroy executors hit exactly one
     creature on the clicked cell. AoE ("les invocations", "autour"), mass
     conditions ("toutes les invocations ayant ..."), and non-creature targets
     (Dofus / prisme / AR / Glyphe) are rejected.

The script is idempotent: the authored type names (MANAGED_TYPES) never appear
in extracted bindata (which uses DamageData / SetPropertyData / ...). So each run
first strips every managed-type effect, then injects again with the current
filters. Tightening a filter or shrinking implemented removes what an older run
wrote, with no need to regenerate the pool. Grow implemented (and MANAGED_TYPES)
as executors are added, then run it again.
"""
import sys, json, glob, re
sys.stdout.reconfigure(encoding="utf-8")
from pathlib import Path

from paths import CARD_POOL_GLOB

# Authored types this script manages (strips and may inject again). Bindata
# extraction never produces them, so stripping them only undoes our own
# earlier injections.
MANAGED_TYPES = {"Heal", "Destroy", "BoostAttack", "BoostArmor", "Charge", "SetMovement", "BoostMovement", "SetAttack", "DrawCards", "DrawUpTo", "EndTurn", "Teleport", "TakeControl", "ReturnToHand", "ReturnToDeck", "Silence", "TriggerAttack", "BoostRange", "RespawnPrisms", "AddCostModifier", "SwapAttack", "SwapArmor", "ChangeRow", "SwapPosition", "HealFull", "SetLife", "SetRange", "MultiplyAttack", "AddReserve", "TransferApToReserve", "StealReserve", "SpendReserveDouble", "Transform", "SummonToken", "AddCardToHand", "AddRandomFamilyCards", "ControlAround", "Vulnerability", "ChiefAura", "ConditionalFirstStrike", "ConditionalStatBoost", "SpendApAsBuff", "SetProperty", "ChargeAllies", "TransformAll", "AoeDestroy", "CoinFlip", "ForceCoinPile", "SetDiceFloor", "SetDofusLife", "SetDiscardPaysCost", "TriggerRally", "RetreatAllies", "RecycleHand", "AddSeeds", "TransformAllSeeds", "TransformSeed", "DamageInFront", "PlaceSeedsInFront", "SeedStepDamage", "ConditionalSeedProperty", "TransformIntoSeed", "TransformIntoBush", "TransformSeedToBush", "CardCostAura", "SelfCostReduction", "FreeIfReserve", "CrossDraw", "StealTopDraw", "MillDeck", "StealDiscard", "WoundedStatBoost", "WoundedProperty", "WoundedResistance", "BanishDiscard", "CostPerDiscard", "BounceBelowPv", "SelfCharge", "ChangeRowSelf", "DestroyAllEnemyPrisms", "DestroyArmor", "Sacrifice", "StampCostReduction", "RecycleFamily", "DestroyDofus", "DestroyBoardObject", "TransformObjectsToTraps", "SwapDofus", "MoveRowDofus", "ShuffleDofus", "BounceClosestOnRow", "BounceColumn", "SacrificeForReserve", "TeleportToCell", "TeleportToGlyph", "SwapTwoDofus", "NoOp", "HandCostOnEvent", "RecoverSelfOnFamilyDeath", "AllyFamilyDeathSeed", "ActivatedTrapAura", "RollReaction", "RecycleGodDrawAny", "LethalMeleeIfFamily", "RecoverToHandOnDofusKill", "NullifyFamilyMovePowers", "CostPerGlyph", "DestroyOwnGlyphs", "BuffFamilyOnBounce", "ReduceFirstEnemyAtOnAllyHeal", "DamageDofusOnRowOnHeal", "BuffSelfOnOverflowDiscard", "DamageEnemiesOnOverflowDiscard", "SpendApAsDamage", "DrawSummonFreeElseDiscard", "SpellDamageReductionAura", "SpendReserveCharge", "DrainAp", "RecoverFromDiscard", "AttractCreature", "MoveAdjacentRowRandom", "CopyFamilyFromTarget", "TutorCopyOfTarget", "ConditionalArmorWhileAlly", "EnemyHandSurcharge", "BanishAllDiscards", "ProtectDofus", "AttachSinistro", "SpawnButinsOnStartCells", "DamageDofusOnRowOnButinPickup", "DamageAllyToSummon", "SacrificeForDamage", "LameEmoussee", "DestroyArmorForDamage", "DamageDofusPerArmoredAlly", "DamageAllByOwnAttack", "DamageEnemiesByFamilyCount", "DamageEnemiesByReserve", "SacrificePoupesque", "DamageEnemiesByEnemyCount", "DamageRowByOwnCost", "DamageAdjacentFront", "DropButinStartRow"}
# Effect-type names that an earlier authoring run could have injected but which no
# longer exist in the engine (renamed/generalised). Stripped on every run so an
# incrementally-built (gitignored) data file does not keep dead entries.
OBSOLETE_TYPES = {"GlyphCostAura"}
# Subset of MANAGED_TYPES whose single-target executor is live in effects.ts.
IMPLEMENTED = {"Heal", "Destroy", "BoostAttack", "BoostArmor", "Charge", "SetMovement", "BoostMovement", "SetAttack", "DrawCards", "DrawUpTo", "EndTurn", "Teleport", "TakeControl", "ReturnToHand", "ReturnToDeck", "Silence", "TriggerAttack", "BoostRange", "RespawnPrisms", "AddCostModifier", "SwapAttack", "SwapArmor", "ChangeRow", "SwapPosition", "HealFull", "SetLife", "SetRange", "MultiplyAttack", "AddReserve", "TransferApToReserve", "StealReserve", "SpendReserveDouble", "Transform", "SummonToken", "AddCardToHand", "Vulnerability", "SpendApAsBuff", "SetProperty", "StampCostReduction", "RecycleFamily"}
# Effects that act on the player (hand/deck/turn/prisms), not a board creature,
# so they do not require the "une invocation" targeting phrase in the description.
PLAYER_TYPES = {"DrawCards", "DrawUpTo", "EndTurn", "RespawnPrisms", "AddReserve", "TransferApToReserve", "StealReserve", "SpendReserveDouble"}
# Trigger (APPARITION / MORT / …) authoring. The spec already filters trigger
# blocks to faithful effects (self synths + simple targeted buffs); here we just
# inject them into the matching trigger slot. Self synth types are bindata-ish
# (not managed), so we tag every injected trigger effect with `_authored` and
# strip by that flag, keeping the pipeline idempotent without touching real
# bindata trigger effects (the 35 extracted ones).
TRIGGER_KINDS = {"APPARITION", "MORT", "COUP_DE_GRACE", "CONTRE_COUP", "FIN_DE_TOUR", "DEBUT_DE_TOUR", "RALLIEMENT"}
TRIGGER_OK_TYPES = {"BoostAttackData", "BoostLifeData", "HealSelfData", "SelfDamageData", "Heal", "BoostAttack", "BoostColumnAttack", "BoostArmor", "DamageData", "DrawCards", "AddCardToHand", "AoeDamage", "SummonToken", "Transform", "TutorFromDeck", "BoostMovement", "SetProperty", "SetAttack", "SetLife", "ChargeAllies", "DrawFiltered", "TransformAll", "RecoverFromDiscard", "AttractCreature", "MoveAdjacentRowRandom", "CopyFamilyFromTarget", "TutorCopyOfTarget", "AoeDestroy", "StampCostReduction", "RecycleFamily"}
# Effects that hit the whole board at once (no per-creature pick). Like player
# effects they skip the "une invocation" requirement, but reject board-SHAPE
# riders so only genuinely all-board cards qualify.
GLOBAL_TYPES = {"Silence"}
# Effects that take two creature picks (swap a stat between them). Need the
# "2 invocations" phrasing rather than the single-target "une invocation".
TWO_TARGET_TYPES = {"SwapAttack", "SwapArmor", "SwapPosition"}

# Reject markers, split by what they signal so each effect category uses the
# right subset:
#   ALL_MARKERS, "all / your / their invocations": means a mass effect. Fatal
#                  for a single-target spell, but fine for a global one (Silence
#                  literally hits all invocations).
#   Shape, a specific board pattern we do not resolve (line, row, around,
#                  per-each). Rejected everywhere.
#   Noncreature, aimed at a Dofus / prism / Glyphe / armour, not a creature.
#   Riders, conditional / cost / temporary / choice / discard riders we
#                  do not model. Rejected everywhere.
ALL_MARKERS = ["les invocation", "vos invocation", "leurs invocation", "toutes", "tous les", "camp"]
SHAPE = ["autour", "chaque", "adjacent", "à côté", "a côté", "rangée", "rangee", "ligne", "case ciblée", "case cible"]
NONCREATURE = ["dofus", "prisme", "glyphe"]
# Armour-DESTRUCTION phrasing ("Détruisez l'AR d'une invocation"). Rejected
# for single-target creature spells, but allowed for SwapArmor (which legit
# says "Échangez l'AR").
ARMOR_WORDS = ["l'ar", "l'armure"]
# Cost mentions, reject everywhere except for the AddCostModifier effect,
# whose whole purpose is to change a cost.
COST_MARKERS = ["coût", "cout"]
RIDERS = [
    " ou ", "adversaire", "chacune", "chacun", " par ",
    "meurt", "meure", "fin de son tour", "fin de tour", "à la fin", "a la fin",
    "jusqu'au", "jusqu au", "bannit", "défausse", "defausse",
]
# Temporary-duration markers: a stat change that reverts ("jusqu'à votre
# prochain tour", "ce tour") is not modelled yet, so the stat-AoE branches
# reject it. This is not a global rule: player effects like DrawUpTo
# ("pioche jusqu'à avoir N") and SpendReserveDouble ("... ce tour") use these
# words without being temporary buffs.
TEMP_MARKERS = ["jusqu'à", "jusqu a", "prochain tour", "ce tour", "ce tour-ci", "temporairement"]
# Single-target creature spells: every category is fatal.
REJECT = ALL_MARKERS + SHAPE + NONCREATURE + ARMOR_WORDS + RIDERS + COST_MARKERS
# Global board spells (Silence): mass-targeting is the point, so only the
# shape / non-creature / rider / cost markers reject.
GLOBAL_REJECT = SHAPE + NONCREATURE + ARMOR_WORDS + RIDERS + COST_MARKERS
# Player spells (draw / end turn): they name no creature, so only riders +
# cost-riders apply.
PLAYER_REJECT = RIDERS + COST_MARKERS
# AddCostModifier: cost is the effect, so cost markers are allowed; but it
# must be HAND-scoped (we model "cartes de votre main" only, not the deck /
# class-filtered variants), and the usual shape/non-creature/riders still bite.
COSTMOD_REJECT = SHAPE + NONCREATURE + ARMOR_WORDS + RIDERS
# Two-target swaps ("Échangez l'AT/AR de 2 invocations"): allow the armour
# wording, but reject board shapes / non-creature / riders / cost.
TWO_TARGET_REJECT = SHAPE + NONCREATURE + RIDERS + COST_MARKERS
# ChangeRow ("Faites changer de ligne une invocation"): the words "ligne"
# (shape) and "camp" (ALL_MARKERS) are part of the effect/location, not a mass
# pattern, so we do not reject on them here; only non-creature / riders / cost.
CHANGEROW_REJECT = NONCREATURE + ARMOR_WORDS + RIDERS + COST_MARKERS
# Stat effects that support a side-wide AoE scope ("vos invocations" etc.).
SCOPED_STAT_TYPES = {"Heal", "BoostAttack", "BoostArmor", "BoostMovement", "SetMovement", "SetAttack", "BoostRange", "SetLife", "HealFull", "Vulnerability"}


def detect_scope(s):
    # Which side a mass stat effect hits, from the (stripped) description.
    # Order matters: an enemy/ally qualifier wins over the bare "les invocations".
    if "invocations advers" in s or "invocations ennemi" in s:
        return "enemies"
    if "votre camp" in s or "dans votre camp" in s:
        return "allies_camp"  # only your creatures still in your territory
    if "vos invocation" in s or "invocations allié" in s or "invocations allie" in s:
        return "allies"
    if "toutes les invocation" in s or "les invocations" in s or "des invocations" in s:
        return "all"
    return None


def detect_shape(s):
    # Geometric zone around the clicked cell.
    if "ligne et la rangée" in s or "ligne et rangée" in s or "ligne et la rangee" in s:
        return "cross"
    if "rangée" in s or "rangee" in s:
        return "row"
    if "autour" in s:
        return "around"
    return None


# Effects onto which the merge stamps scope / shape.
STAMPABLE = SCOPED_STAT_TYPES | {"Silence"}
# Positive signal, a single creature target is named explicitly. Covers both
# "une invocation" (buff/heal phrasing) and "l'invocation ciblée" (Charge etc.).
REQUIRE_ANY = [
    "une invocation", "une créature", "une creature",
    "l'invocation ciblée", "l'invocation ciblee", "invocation alliée ciblée",
    "invocation alliee ciblee",
]


def strip_markup(desc: str) -> str:
    # Drop <b>..</b> tags and the localisation glue (\_ , |_) so substring
    # matching sees plain French. Lower-cased for case-insensitive checks.
    s = re.sub(r"</?[a-zA-Z][^>]*>", " ", desc or "")
    s = s.replace("\\_", " ").replace("|_", " ").replace("\\n", " ").replace("\n", " ")
    # Normalise curly apostrophes (U+2019 / U+2018) to a straight ' so our
    # markers ("l'invocation ciblée") match regardless of which the card uses.
    s = s.replace("’", "'").replace("‘", "'")
    s = re.sub(r"\s+", " ", s).strip().lower()
    return s


def is_faithful_single_target(desc: str) -> bool:
    s = strip_markup(desc)
    if not any(p in s for p in REQUIRE_ANY):
        return False
    if any(p in s for p in REJECT):
        return False
    return True


def parse_silence_push(c):
    """Single-target silence spell, e.g. Fiole de Frayeur #537 "Inflige silence à
    une invocation et la repousse de N cases". The card's bindata Effects are
    empty, so the silence only exists in the description; build_card_pool already
    created the PushData (it survives the managed-type strip). We put a
    single-target Silence before the push, so the creature on the target cell is
    silenced first and then pushed. Mass ("les invocations"), shaped ("ligne",
    "rangée") and global silences go through the generic AoE / GLOBAL_TYPES path
    instead. Returns the new effect list, or None if the card is not a
    single-target silence spell."""
    if c.get("cardType") != "Spell":
        return None
    s = strip_markup(c.get("description", ""))
    if "silence" not in s:
        return None
    if not any(p in s for p in REQUIRE_ANY):
        return None  # no single-creature target named
    if any(p in s for p in ALL_MARKERS + SHAPE + NONCREATURE):
        return None  # mass / shaped / non-creature → handled by another branch
    # Keep whatever non-Silence effects build_card_pool already synthesised
    # (PushData for #537); Silence goes first.
    existing = [e for e in (c.get("effects") or []) if e.get("type") != "Silence"]
    return [{"type": "Silence", "single": True}] + existing


def _concrete_int(a) -> bool:
    if isinstance(a, bool):
        return False
    if isinstance(a, int):
        return True
    return isinstance(a, dict) and isinstance(a.get("const"), int)


def _is_dice(a) -> bool:
    # A dice value the engine can roll: { "dice": "NdM" } or the bindata
    # { "type": "TriggeringDiceValue" } (1d6). resolveDynamicValue handles both.
    if not isinstance(a, dict):
        return False
    return isinstance(a.get("dice"), str) or a.get("type") == "TriggeringDiceValue"


# Effect types whose executor resolves a DynamicValue via resolveDynamicValue
# (so a dice amount/cells is fine, rolled at resolve time from the seeded RNG).
DICE_OK_TYPES = {"Heal", "BoostAttack", "BoostArmor", "BoostMovement", "BoostRange", "Teleport", "AoeDamage"}


def has_concrete_amount(effect: dict) -> bool:
    # Every numeric parameter the executors read (amount / value / cells) must be
    # a concrete integer, unless the effect's executor resolves dynamics, in
    # which case a dice value (1d6) is fine (rolled at resolve time). A missing
    # required param still disqualifies.
    t = effect.get("type")
    dice_ok = t in DICE_OK_TYPES
    def ok_num(a) -> bool:
        return _concrete_int(a) or (dice_ok and _is_dice(a))
    if "amount" in effect and not ok_num(effect["amount"]):
        return False
    if "value" in effect and not _concrete_int(effect["value"]):
        return False
    if "cells" in effect:
        c = effect["cells"]
        if not (ok_num(c) or c == "toWall"):
            return False
    # Teleport carries its jump distance in `cells`, require it present and
    # concrete or a dice value (Bond du Félin "de 1d6 cases").
    if t == "Teleport" and not ok_num(effect.get("cells")):
        return False
    return True


spec = {r["id"]: r for r in json.loads((ROOT / "notes/card_effects_spec.json").read_text(encoding="utf-8"))}

# PHORZERKER capacity carriers (Enutrof summons). The bindata encodes the fusion as a
# secondary target on the Phorreur: SecondaryTarget contains an "AlliedPhorreur…" CastTarget,
# 119 (AlliedPhorreur), 120 (…OrAlliedAoePrism), 128 (…OrAnyAoePrism). That set is exactly the
# 23 cards carrying CardCapacity.Phorzerker, so we read it straight from notes/card_bindata.
_PHORREUR_SECONDARY_TARGETS = {119, 120, 128}
PHORZERKER_IDS = set()
for _bf in glob.glob(str(ROOT / "notes/card_bindata/*.json")):
    try:
        _bd = json.loads(Path(_bf).read_text(encoding="utf-8"))
    except (ValueError, OSError):
        continue
    if set(_bd.get("SecondaryTarget") or []) & _PHORREUR_SECONDARY_TARGETS:
        PHORZERKER_IDS.add(int(_bd["Id"]))
# Championne Périmée #634 / Champion Croulant #899 are Enutrof NÉCROME cards whose
# bindata secondary target is AlliedDofus (the NÉCROME reveal), so the
# AlliedPhorreur detection above misses them, but they do fuse with a Phorreur.
# Flag them so the engine offers the combined Phorreur/Dofus secondary pick
# (a Phorreur fuses, a Dofus reveals for a second Orbe).
PHORZERKER_IDS |= {634, 899}

# Token cards: cards that cannot be put in a deck and only appear in play
# (summoned creatures like Gélatine #194 / Lait de Bambou #506, board objects
# Bombe #101 / Tas d'Os #691 / Butin #789 / Glyphe #827, and the Fléau #757).
# Read from the bindata `IsToken` boolean, which is reliable: all of
# #757/#101/#691/#789/#827 and the summoned tokens have IsToken=true, regular
# cards have IsToken=false. The engine reads the stamped `isToken` flag
# (Card.isToken / rules.ts isToken()) to send a token to the hidden tokenDiscard
# zone instead of the normal discard, whatever the way it leaves play.
TOKEN_IDS = set()
for _bf in glob.glob(str(ROOT / "notes/card_bindata/*.json")):
    try:
        _bd = json.loads(Path(_bf).read_text(encoding="utf-8"))
    except (ValueError, OSError):
        continue
    if _bd.get("IsToken") is True:
        TOKEN_IDS.add(int(_bd["Id"]))

# Cards retired from the live game (old or reworked versions) are stamped
# `removed` and skipped entirely. The list comes from a manual export of
# obsolete cards (notes/removed_cards.json).
_removed_path = ROOT / "notes/removed_cards.json"
REMOVED_IDS = set(json.loads(_removed_path.read_text(encoding="utf-8")).get("removed", [])) if _removed_path.exists() else set()

# --- Token name resolution (for Transform "transforme … en X") --------------
# Build a normalized Summon-name -> id index from the whole pool so a parsed
# token name ("chacha noir allié") can be mapped to the real token card's id.
import unicodedata

def norm_name(s: str) -> str:
    s = s.lower()
    s = "".join(ch for ch in unicodedata.normalize("NFD", s) if unicodedata.category(ch) != "Mn")
    s = re.sub(r"\b(alli[ée]+s?|adverses?|ennemies?|ennemis?)\b", " ", s)
    s = re.sub(r"[^a-z ]", " ", s)  # drop digits / punctuation
    # crude singularize: trailing 's' on each word (chachas noirs -> chacha noir)
    words = [w[:-1] if (len(w) > 3 and w.endswith("s")) else w for w in s.split()]
    return " ".join(words).strip()

summon_name_index = {}   # Summon-only (for tokens placed on the board)
card_name_index = {}      # All cards (for "Ajoute <carte> à votre main")
for _f in glob.glob(CARD_POOL_GLOB):
    _d = json.loads(Path(_f).read_text(encoding="utf-8"))
    for _c in (_d if isinstance(_d, list) else _d.get("cards", _d)):
        nm = norm_name(_c.get("name", ""))
        # card_name_index covers every card (incl. cost-0 "food"/token cards the
        # pool builder flags as isDevCard, like Blanquette), AddCardToHand may
        # name any of them.
        card_name_index.setdefault(nm, _c["id"])
        if _c.get("cardType") == "Summon" and not _c.get("isDevCard"):
            summon_name_index.setdefault(nm, _c["id"])

def resolve_transform(into: str):
    """name -> (tokenId, asOwner) or None if no Summon matches."""
    if not into:
        return None
    tid = summon_name_index.get(norm_name(into))
    if tid is None:
        return None
    as_owner = "caster" if re.search(r"alli[ée]", into.lower()) else "keep"
    return tid, as_owner


def resolve_token(name: str):
    """A TOKEN name ("bébés phorreurs armurés", "lapinos") -> Summon card id, or
    None. Summon-only because tokens get placed on the board."""
    return summon_name_index.get(norm_name(name)) if name else None


def resolve_card(name: str):
    """ANY card name ("blanquette", "poêle", "bébés phorreurs armurés") -> id,
    for AddCardToHand (which can add a Spell ingredient as well as a Summon)."""
    return card_name_index.get(norm_name(name)) if name else None


# CHEF aura ("CHEF : +N AT/PM à vos autres X"), a continuous aura on a Summon,
# stored as ChiefAura effects in effects[] and recomputed live by the engine.
CHEF_STAT = {"at": "attack", "pm": "movement"}
def parse_chief_aura(desc: str):
    """Return a list of ChiefAura effects, or None if the card's CHEF clause
    is not a clean stat aura we can resolve (property auras like Joris' or cards
    with extra continuous clauses are skipped)."""
    s = strip_markup(desc)
    if "chef" not in s:
        return None
    # Extra continuous clauses we do not model alongside the aura → skip whole.
    if any(k in s for k in ("lune", "inciblable", "1d6")):
        return None
    # An @placeholder@ (RÉSISTANCE: @resistance@ / PORTÉE: @range@) before the
    # CHEF clause is just the card's own keyword, harmless (Craqueleur Royal
    # #68). Only an "@" inside the CHEF clause itself is something we cannot
    # model and skips the card.
    if "@" in s[s.index("chef"):]:
        return None
    # A "change de ligne" rider is skipped, unless it is the reactive ENTERS_PLAY
    # one (Truche Royale #801), which parse_enters_play_react models on its own
    # trigger, freeing the CHEF clause to parse here too.
    if "change de ligne" in s and not parse_enters_play_react({"description": desc}):
        return None
    # A "tant que/qu'" continuous clause usually cannot be modelled next to the
    # aura → skip, unless it is a cost aura (Piou Royal "le coût de vos pious est
    # réduit…"), which parse_cost_auras handles independently, leaving the CHEF
    # clause free to parse here too.
    if ("tant que" in s or "tant qu'" in s) and not parse_cost_auras(desc):
        return None
    m = re.search(r"chef\s*:?\s*(.+?)\s+(?:à|a)\s+vos\s+(?:autres\s+)?(\w+)", s)
    if not m:
        return None
    stat_part, fam = m.group(1), m.group(2)
    # Honesty invariant: if the clause buffs a stat we do not model as a CHEF
    # aura (portée, résistance, Héroïne Stridulante #887 "+1 AT et +1 portée"),
    # skip the whole card rather than half-author just the AT part. (The
    # resistance-only phrasing is handled by parse_chief_resistance_aura.)
    if re.search(r"port[ée]e|r[ée]sistance|armure|initiative", stat_part):
        return None
    sel = None
    if fam not in ("invocation", "invocations", "créature", "creature"):
        sel = map_tutor_filter(fam)
        if sel is None or "family" not in sel:
            return None  # family does not resolve → honest skip
    effs = []
    for amt, stat in re.findall(r"\+?\s*(\d+)\s*(at|pm)\b", stat_part):
        e = {"type": "ChiefAura", "stat": CHEF_STAT[stat], "amount": int(amt)}
        if sel:
            e["family"] = sel["family"]
        effs.append(e)
    return effs or None


def parse_chief_resistance_aura(desc: str):
    """Craqueboule Or #26: "CHEF : Augmente de N la résistance de vos autres
    Craqueleurs.", a continuous RESISTANCE aura ("de vos", not the "+N AT à
    vos" shape parse_chief_aura handles). Emits ChiefAura {stat:"resistance"};
    withAuras projects it through auraResistance onto the other family members.
    Returns a list or None."""
    s = strip_markup(desc)
    m = re.search(r"chef\s*:?\s*augmente de\s+(\d+)\s+la r[ée]sistance de vos\s+(?:autres\s+)?(\w+)", s)
    if not m:
        return None
    amt, fam = int(m.group(1)), m.group(2)
    e = {"type": "ChiefAura", "stat": "resistance", "amount": amt, "_authored": True}
    if fam not in ("invocation", "invocations", "créature", "creature", "créatures", "creatures"):
        sel = map_tutor_filter(fam)
        if sel is None or "family" not in sel:
            return None  # family does not resolve → honest skip
        e["family"] = sel["family"]
    return [e]


# CHEF property aura ("CHEF : Donne <keyword> à vos autres invocations", Dan Lemil #718 perce armure,
# Joris #307 inciblable). The bindata flattens the granted keyword into a self SetPropertyData
# (summonCreature would then put it on the chief itself, which is wrong: the chief gives it to the
# others, not to itself). Turn it into a ChiefPropertyAura that the engine applies to the chief's
# other allies, and drop the self copy. Idempotent: detected again from the description, so it works
# whether the card still has the SetPropertyData (fresh build) or already the ChiefPropertyAura
# (second run). Returns True if it changed effects[].
CHIEF_PROP_KEYWORDS = {"perce armure": "PierceArmor", "inciblable": "Untargetable"}
def apply_chief_property_aura(c) -> bool:
    if c.get("cardType") != "Summon":
        return False
    s = strip_markup(c.get("description", ""))
    if "chef" not in s or "vos autres invocation" not in s:
        return False
    prop = next((p for kw, p in CHIEF_PROP_KEYWORDS.items() if kw in s), None)
    if prop is None:
        return False
    before = c.get("effects") or []
    effs = [e for e in before if not (e.get("type") == "SetPropertyData" and e.get("PropertyType") == prop)]
    if not any(e.get("type") == "ChiefPropertyAura" and e.get("property") == prop for e in effs):
        effs.append({"type": "ChiefPropertyAura", "property": prop, "_authored": True})
    if effs != before:
        c["effects"] = effs
        return True
    return False


def parse_apparition_armor(c) -> int | None:
    """Scaraboss #607 "APPARITION : Gagne +N AR", a self armour buff on summon.
    build_card_pool's _parse_trigger_body synthesises +AT / +PV / heal / self-dmg
    but not +AR, so the APPARITION trigger is left empty. Returns N (the armour
    gained) when the APPARITION clause grants it, else None."""
    s = strip_markup(c.get("description", ""))
    m = re.search(
        r"apparition\s*:?\s*(.*?)(?:\b(?:chef|mort|fin d\w+ tour|contre[- ]coup|"
        r"coup de gr[âa]ce|d[ée]but d\w+ tour|ralliement)\b|$)", s, re.S)
    if not m:
        return None
    # Flat "+N AR" only, not a per-X scaled buff ("+1 AR par invocation adverse",
    # Championne Sanglante #1250, which is a variable amount, not trivial).
    a = re.search(r"gagne\s+\+(\d+)\s*ar\b(?!\s+(?:par\b|pour\b|autant\b))", m.group(1))
    return int(a.group(1)) if a else None


def parse_apparition_self_damage(c) -> int | None:
    """Luc Ossit #769 "APPARITION : S'inflige @damage@.", a self-damage on summon
    whose amount is the @damage[:idx]@ placeholder (the card's DamageData). The
    literal-number trigger parser misses "@damage@", so the APPARITION slot is empty.
    Resolve @damage@ against effects[idx].Damage and return it, or None."""
    if c.get("cardType") != "Summon":
        return None
    s = strip_markup(c.get("description", ""))
    m = re.search(
        r"apparition\s*:?\s*(.*?)(?:\b(?:chef|mort|fin d\w+ tour|contre[- ]coup|"
        r"coup de gr[âa]ce|d[ée]but d\w+ tour|ralliement)\b|$)", s, re.S)
    clause = m.group(1) if m else s
    dm = re.search(r"s['’]inflige\s+@damage(?::(\d+))?@", clause)
    if not dm:
        return None
    idx = int(dm.group(1)) if dm.group(1) else 0
    effs = c.get("effects") or []
    val = effs[idx].get("Damage") if idx < len(effs) else None
    return val if isinstance(val, int) else None


def parse_apparition_reserve_damage(c):
    """Instantina #371: APPARITION "Infligez X dégâts ou Y dégâts si vous avez au moins N PA dans
    votre réserve." → a single targeted DamageData whose amount is a reserve-THRESHOLD value
    {ifReserveAtLeast:N, then:Y, else:X}, resolveCounts picks Y when the owner's apReserve ≥ N,
    else X (the literal-number trigger parser cannot model the "ou … si" branch, so the APPARITION
    slot is left empty and the two flat bindata DamageData stay inert). Returns the effect or None."""
    if c.get("cardType") != "Summon":
        return None
    s = strip_markup(c.get("description", ""))
    m = re.search(
        r"apparition\s*:?\s*inflige[z]?\s+(\d+)\s*d[ée]g[âa]ts?\s+ou\s+(\d+)\s*d[ée]g[âa]ts?\s+si\s+vous\s+avez\s+au\s+moins\s+(\d+)\s*pa\s+dans\s+votre\s+r[ée]serve",
        s)
    if not m:
        return None
    low, high, thr = int(m.group(1)), int(m.group(2)), int(m.group(3))
    return {"type": "DamageData", "Damage": {"ifReserveAtLeast": thr, "then": high, "else": low}, "_authored": True}


def parse_board_attack_aura(desc: str):
    """Passive board-wide stat aura that is NOT a CHEF clause, "Tant qu'il est
    en jeu, les autres invocations gagnent +N AT" (Héros Impartial #1132). The
    wording "LES autres invocations" (vs "VOS autres") means both camps, so we
    emit a ChiefAura carrying allCamps:true (the engine projects it onto every
    other living creature regardless of owner). Returns a list or None."""
    s = strip_markup(desc)
    if "chef" in s:
        return None  # CHEF clauses are owned by parse_chief_aura
    m = re.search(r"les\s+autres\s+invocations\s+gagnent\s+(.+)", s)
    if not m:
        return None
    effs = []
    for amt, stat in re.findall(r"\+?\s*(\d+)\s*(at|pm)\b", m.group(1)):
        effs.append({"type": "ChiefAura", "stat": CHEF_STAT[stat],
                     "amount": int(amt), "allCamps": True})
    return effs or None


def parse_enemy_attack_debuff(desc: str):
    """Echo (Fratrie): "Tant qu'elle est en jeu, l'AT des invocations adverses est
    réduite de N." → a ChiefAura {stat:attack, amount:-N, enemy:true}, continuous,
    projected onto every enemy creature by withAuras (floored at 0). List or None."""
    s = strip_markup(desc)
    m = re.search(r"l'?\s*at\s+des\s+invocations\s+adverses\s+est\s+r[ée]duite?\s+de\s+(\d+)", s)
    if not m:
        return None
    return [{"type": "ChiefAura", "stat": "attack", "amount": -int(m.group(1)), "enemy": True, "_authored": True}]


WOUNDED_STAT = {"at": "attack", "pm": "movement", "portée": "range", "portee": "range"}
def parse_wounded_self_buff(desc: str):
    """Sacrieur BLESSÉ keyword: "BLESSÉ : +N AT/PM/portée [et initiative]
    [et résistance N]", continuous self buffs that are only active while the
    creature is wounded (withAuras checks currentLife < baseLife and removes them
    on a full heal). Emits WoundedStatBoost for each stat, WoundedProperty:FirstStrike
    for "initiative", and WoundedResistance for "résistance N" (none of them are
    baked in at summon, withAuras handles them). A clause with a continuous
    property we do not model yet is skipped as a whole, so a card is never half
    authored. Returns a list or None."""
    s = strip_markup(desc)
    m = re.match(r"\s*bless\w*\s*:?\s*(.+)", s)
    if not m:
        return None
    clause = m.group(1)
    # Un-modelled continuous properties → defer the whole card (no half-author).
    if any(k in clause for k in ("inciblable", "bouclier", "soin", "soigne",
                                 "vol de vie", "perce")):
        return None
    effs = []
    for amt, stat in re.findall(r"\+?\s*(\d+)\s*(at|pm|portée|portee)\b", clause):
        effs.append({"type": "WoundedStatBoost", "stat": WOUNDED_STAT[stat], "amount": int(amt)})
    if "initiative" in clause:
        effs.append({"type": "WoundedProperty", "property": "FirstStrike"})
    mr = re.search(r"r[ée]sistance\s*(\d+)", clause)
    if mr:
        effs.append({"type": "WoundedResistance", "amount": int(mr.group(1))})
    return effs or None


def parse_conditional_first_strike(desc: str):
    """Tristepin: "Gagne initiative si un (autre) membre allié de la <famille>
    est en jeu." → a continuous ConditionalFirstStrike effect (the engine
    grants/revokes FirstStrike while a living ally of that family is on board).
    Returns the effect dict, or None if it is not this conditional pattern."""
    s = strip_markup(desc)
    if "initiative" not in s or " si " not in s:
        return None
    # Only the board-presence condition ("... est en jeu"); other "si" riders
    # (life thresholds, dice…) are not this passive.
    if "est en jeu" not in s:
        return None
    tail = s.split("initiative", 1)[1]
    sel = None
    for ph, key in TUTOR_SPECIAL.items():  # "confrérie du tofu" → BrotherhoodOfTheTofu
        if ph in tail:
            sel = key
            break
    if sel is None:
        m = re.search(r"membre\s+(?:alli[ée]e?\s+)?(?:de la\s+|du\s+)?(.+?)\s+est en jeu", tail)
        if m:
            mapped = map_tutor_filter(m.group(1))
            if mapped and "family" in mapped:
                sel = mapped["family"]
    if sel is None:
        return None
    return {"type": "ConditionalFirstStrike", "family": sel}


def parse_conditional_stat_boost(desc: str):
    """Evangelyne: "Gagne +N AT/portée si un (autre) membre allié de la
    <famille> est en jeu." gives a continuous ConditionalStatBoost (the engine
    adds or removes +N attack or range while a living ally of that family is on
    the board).

    Marcassinet: "Gagne +N PM tant que vous avez une <Carte> en jeu." gives the
    same continuous boost, but the condition is a specific allied card in play
    (cardId) instead of a family, and the stat can be movement (PM).

    Returns the effect dict, or None if neither pattern matches."""
    s = strip_markup(desc)
    # Pattern B, Marcassinet: condition on a specific allied card in play.
    mb = re.search(
        r"gagne\s*\+?\s*(\d+)\s*(at|pm|port[ée]e)\b.*?"
        r"tant que vous avez une?\s+(.+?)\s+en jeu",
        s,
    )
    if mb:
        cid = resolve_token(mb.group(3).strip())
        if cid is not None:
            stat = {"at": "attack", "pm": "movement"}.get(mb.group(2), "range")
            return {"type": "ConditionalStatBoost", "stat": stat, "amount": int(mb.group(1)), "cardId": cid}
    # Pattern A, Evangelyne: condition on a family member in play.
    if " si " not in s or "est en jeu" not in s:
        return None
    m = re.search(r"gagne\s*\+?\s*(\d+)\s*(at|port[ée]e)\b", s)
    if not m:
        return None
    amount = int(m.group(1))
    stat = "attack" if m.group(2) == "at" else "range"
    # Resolve the family exactly like the conditional FirstStrike does.
    tail = s.split("est en jeu", 1)[0]
    sel = None
    for ph, key in TUTOR_SPECIAL.items():  # "confrérie du tofu" → BrotherhoodOfTheTofu
        if ph in tail:
            sel = key
            break
    if sel is None:
        m2 = re.search(r"membre\s+(?:alli[ée]e?\s+)?(?:de la\s+|du\s+)?(.+?)\s*$", tail)
        if m2:
            mapped = map_tutor_filter(m2.group(1).strip())
            if mapped and "family" in mapped:
                sel = mapped["family"]
    if sel is None:
        return None
    return {"type": "ConditionalStatBoost", "stat": stat, "amount": amount, "family": sel}


COST_AURA_SCOPE = {
    "glyphe": "glyph", "glyphes": "glyph",
    "invocation": "summon", "invocations": "summon",
    "sort": "spell", "sorts": "spell",
}


def parse_cost_auras(desc: str):
    """Continuous CardCostAura passives stored in a Summon's effects[] (only read
    by effectiveCost, never applied to the creature). Captures every
    "vos <Glyphes|invocations|sorts> coûtent N PA de (moins|plus)" clause in the
    text: Alchimiste Armurée has one glyph clause (-N), Felida has a summon clause
    (-N) and a spell clause (+N). Returns a list of effect dicts with a signed
    amount (moins: negative, cheaper; plus: positive, more expensive), or None if
    no clause matches. Like the other continuous auras it is managed, so the strip
    removes any older copy before injecting again."""
    s = strip_markup(desc)
    out = []

    def _aura(word, signed):
        """Classify a 'vos <word>' cost target → a type scope (glyphes/invocations/
        sorts) or a family (Chacha Lait 'vos chachas', Piou Royal 'vos pious')."""
        scope = COST_AURA_SCOPE.get(word)
        if scope:
            return {"type": "CardCostAura", "scope": scope, "amount": signed, "_authored": True}
        sel = map_tutor_filter(word.rstrip("s"))
        if sel and "family" in sel:
            return {"type": "CardCostAura", "family": sel["family"], "amount": signed, "_authored": True}
        return None

    # "vos <type|famille> coûtent N PA de (moins|plus)" (Chacha Lait #1565, Felida…)
    for m in re.finditer(r"vos\s+(\w+)\s+co[uû]tent\s+(\d+)\s*pa\s+de\s+(moins|plus)", s):
        amt = int(m.group(2))
        eff = _aura(m.group(1), -amt if m.group(3) == "moins" else amt)
        if eff:
            out.append(eff)
    # "le coût de vos <type|famille> est (réduit|augmenté) de N PA" (Piou Royal #542).
    for m in re.finditer(r"co[uû]t\s+de\s+vos\s+(\w+)\s+est\s+(r[ée]duit|augment\w+)\s+de\s+(\d+)\s*pa", s):
        amt = int(m.group(3))
        eff = _aura(m.group(1), -amt if m.group(2)[0] == "r" else amt)
        if eff:
            out.append(eff)
    # "le coût des <type> ADVERSES est (réduit|augmenté) de N PA" (Maître Joris #117):
    # a cost aura on the enemy side (it changes the opponent's matching cards).
    for m in re.finditer(r"co[uû]t\s+des\s+(\w+)\s+adverses?\s+est\s+(r[ée]duit|augment\w+)\s+de\s+(\d+)\s*pa", s):
        amt = int(m.group(3))
        eff = _aura(m.group(1), -amt if m.group(2)[0] == "r" else amt)
        if eff:
            eff["enemy"] = True
            out.append(eff)
    # "le coût de vos <type|famille> est de N PA" (Nox #287) → a SET-cost aura
    # (matching cards cost exactly N while the source lives).
    for m in re.finditer(r"co[uû]t\s+de\s+vos\s+(\w+)\s+est\s+de\s+(\d+)\s*pa", s):
        eff = _aura(m.group(1), 0)
        if eff:
            del eff["amount"]
            eff["setTo"] = int(m.group(2))
            out.append(eff)
    # Tolot #651, "vos Butins sont gratuits" → a free butin cost aura (effectiveCost
    # zeroes any butin card while this creature lives).
    if re.search(r"vos\s+butins?\s+sont\s+gratuits?", s):
        out.append({"type": "CardCostAura", "scope": "butin", "free": True, "_authored": True})
    return out or None


def parse_mass_heal(desc: str):
    """ "<trigger> : Soigne de N PV vos (autres) invocations" gives a scoped Heal
    {amount:N, scope:"allies"[, excludeSelf if "autres"]}, applied to the owner's
    creatures when the trigger fires. The trigger kind is detected separately
    (FIN_DE_TOUR for La Gonflable #5), so other mass-heal summons with the same
    wording can reuse this. Returns the effect dict or None. The effect is
    _authored, so the trigger strip removes any older copy. Cards whose heal uses
    an unsupported trigger ("à la fin des déplacements", "quand vous lancez un
    sort") still parse here but are not injected, since detect_trigger_kind
    returns None for them."""
    s = strip_markup(desc)
    # "Soigne vos Dofus de N" (Grougaloragran #409) → scoped dofus heal (all your Dofus).
    md = re.search(r"soigne\s+(?:de\s+(\d+)\s*pv\s+)?vos\s+dofus(?:\s+de\s+(\d+)\s*pv)?", s)
    if md:
        amt = int(md.group(1) or md.group(2) or 0)
        if amt > 0:
            return {"type": "Heal", "amount": amt, "scope": "allies", "dofus": True, "_authored": True}
    # "Soigne vos <famille> de N PV" (Cawotte #133 → Wabbit), a FAMILY-scoped ally heal,
    # distinct from the "vos invocations" mass heal below. map_tutor_filter resolves the French
    # family word (singularised/aliased) to its canonical family tag; the engine's Heal honours
    # `family` via familyOf(). Excludes the generic words so they fall through to their own branches.
    mf = re.search(r"soigne\s+vos\s+(\w+)\s+de\s+(\d+)\s*pv", s)
    if mf and mf.group(1) not in ("invocations", "invocation", "dofus", "autres"):
        sel = map_tutor_filter(mf.group(1))
        if sel and sel.get("family"):
            return {"type": "Heal", "amount": int(mf.group(2)), "scope": "allies", "family": sel["family"], "_authored": True}
    # "Soigne vos (autres) invocations de N PV", both word orders ("soigne de N PV
    # vos invocations" La Gonflable #5 / "soigne vos invocations de N PV" Cochon #148).
    m = re.search(r"soigne\s+de\s+(\d+)\s*pv\s+vos\s+(autres\s+)?invocations", s)
    if m:
        amt, autres = int(m.group(1)), bool(m.group(2))
    else:
        m = re.search(r"soigne\s+vos\s+(autres\s+)?invocations\s+de\s+(\d+)\s*pv", s)
        if not m:
            return None
        amt, autres = int(m.group(2)), bool(m.group(1))
    eff = {"type": "Heal", "amount": amt, "scope": "allies", "_authored": True}
    if autres:
        eff["excludeSelf"] = True
    return eff


def parse_heal_dofus(desc: str):
    """Dollie Praan #650 (APPARITION): "Soignez un Dofus de N PV." → a single-
    target Heal with dofus:true (effectTargetFilter → any_dofus pick; the apply
    heals the picked Dofus, capped at its départ). Does not match #491's "une
    invocation OU un Dofus" (that phrasing has no "soigne un dofus de"). _authored
    so 1b strips any prior copy → idempotent. Returns the effect dict or None."""
    s = strip_markup(desc)
    m = re.search(r"soignez?\s+un\s+dofus\s+de\s+(\d+)\s*pv", s)
    if not m:
        return None
    return {"type": "Heal", "amount": int(m.group(1)), "dofus": True, "_authored": True}


def parse_heal_creature_or_dofus(desc: str):
    """Mot Reconstituant #491: "Soigne une invocation ou un Dofus de N PV." → a
    flat single-target Heal (castTarget SummonOrDofus lets the click land on a
    creature or a Dofus; the apply heals whichever sits on the cell). Returns the
    effect dict or None."""
    s = strip_markup(desc)
    m = re.search(r"soigne\s+une\s+invocation\s+ou\s+un\s+dofus\s+de\s+(\d+)\s*pv", s)
    if not m:
        return None
    return {"type": "Heal", "amount": int(m.group(1))}


def parse_tutor_family(desc: str):
    """Spell family-tutor (Appel à la Baston: "Place dans votre main les 3
    premiers Iops de votre pioche."). → a TutorFromDeck from the top, filtered by
    family. Rejects cost / glyph / trap sub-filters we do not model."""
    s = strip_markup(desc)
    m = re.search(
        r"place\s+dans\s+votre\s+main\s+les?\s+(\d+)?\s*"
        r"(?:premiers?|prochaines?|prochains?)\s+(.+?)\s+de\s+votre\s+pioche",
        s,
    )
    if not m:
        return None
    if re.search(r"co[uû]tant|pi[èe]ge|glyphe", s):
        return None
    sel = map_tutor_filter(m.group(2).strip())
    if not (sel and "family" in sel):
        return None
    amount = int(m.group(1)) if m.group(1) else 1
    return {"type": "TutorFromDeck", "from": "top", "amount": amount, **sel}


def parse_tutor_glyph(desc: str):
    """Malory #645: "Place dans votre main le prochain Glyphe de votre pioche." →
    a TutorFromDeck from the top filtered to Glyphe cards (glyph:True = cards
    carrying the PlaceGlyph effect)."""
    s = strip_markup(desc)
    m = re.search(
        r"place\s+dans\s+votre\s+main\s+les?\s+(\d+)?\s*"
        r"(?:premiers?|prochaines?|prochains?)\s+glyphes?\s+de\s+votre\s+pioche",
        s,
    )
    if not m:
        return None
    amount = int(m.group(1)) if m.group(1) else 1
    return {"type": "TutorFromDeck", "from": "top", "amount": amount, "glyph": True}


def parse_tutor_named_card(desc: str):
    """Brute Impie #1174: "Place dans votre main la première <CardName> de votre
    pioche." → TutorFromDeck {from:top, amount:1, cardId:<resolved>}. Resolves the
    captured token as a card name via card_name_index; returns None when it is not a
    real card (e.g. "Sacrieur" is a family → parse_tutor_family handles it instead).
    Returns the effect dict or None."""
    s = strip_markup(desc)
    m = re.search(
        r"place\s+dans\s+votre\s+main\s+(?:la\s+premi[èe]re|le\s+premier|les?\s+premiers?)\s+(.+?)\s+de\s+votre\s+pioche",
        s,
    )
    if not m:
        return None
    cid = card_name_index.get(norm_name(m.group(1).strip()))
    if cid is None:
        return None
    return {"type": "TutorFromDeck", "from": "top", "amount": 1, "cardId": cid, "_authored": True}


def parse_temp_control(desc: str):
    """Temporary control (Fiole de Psykoz: "Prenez le contrôle d'une invocation
    adverse ayant 3 AT jusqu'au tour de votre adversaire."). → a TakeControl with
    `duration`; the engine reverts ownership at the expiry turn. The exact-AT
    restriction comes from the card's castTarget (…SummonEqual3AT)."""
    s = strip_markup(desc)
    if "contr" not in s or "le" not in s:
        return None
    if not re.search(r"pren\w*\s+le\s+contr[ôo]le\s+d['\s]*une\s+invocation\s+adverse", s):
        return None
    if re.search(r"jusqu['\s]*(?:au\s+tour\s+(?:de\s+votre\s+adversaire|adverse))", s):
        return {"type": "TakeControl", "duration": "opponentNextTurn"}
    if re.search(r"jusqu['\s]*[àa]\s+votre\s+prochain\s+tour", s):
        return {"type": "TakeControl", "duration": "ownNextTurn"}
    return None


def parse_temp_stat(desc: str):
    """Temporary mass stat change (Sénilité: "Réduit de 2 l'AT des invocations
    adverses jusqu'à votre prochain tour.") gives a scoped stat effect with a
    `duration`; the engine applies it now and reverts it when it expires. Only the
    simple "réduit/augmente de N l'AT/AR/PM des invocations <camp> jusqu'à ..."
    form (mass, one stat). Returns the effect or None."""
    s = strip_markup(desc)
    md = re.search(r"jusqu['\s]*[àa]\s+votre\s+prochain\s+tour", s)
    mo = re.search(r"jusqu['\s]*(?:au\s+tour\s+(?:de\s+votre\s+adversaire|adverse))", s)
    if not (md or mo):
        return None
    duration = "ownNextTurn" if md else "opponentNextTurn"
    m = re.search(r"(r[ée]duit|augmente)\s+de\s+(\d+)\s+l['\s]*(at|ar|pm)\b", s)
    if not m:
        return None
    sign = -1 if m.group(1).startswith("r") else 1
    amount = sign * int(m.group(2))
    etype = {"at": "BoostAttack", "ar": "BoostArmor", "pm": "BoostMovement"}[m.group(3)]
    # Scope: which side's invocations.
    if "invocations advers" in s or "invocations ennemi" in s:
        scope = "enemies"
    elif "vos invocation" in s or "invocations alli" in s:
        scope = "allies"
    elif "toutes les invocation" in s or "les invocations" in s:
        scope = "all"
    else:
        return None
    return {"type": etype, "amount": amount, "scope": scope, "duration": duration}


def parse_trucage(desc: str):
    """Trucage: "Durant ce tour vos lancers de pièce tombent toujours sur Pile."
    gives a ForceCoinPile player-state effect (sets the forced-coin flag)."""
    s = strip_markup(desc)
    if re.search(r"lancers?\s+de\s+pi[èe]ce\s+tombent.*pile", s):
        return {"type": "ForceCoinPile"}
    return None


def parse_dice_floor(desc: str):
    """Dé Pipé #535: "Durant ce tour vos jets de dé ne peuvent être inférieurs à N."
    gives a SetDiceFloor {floor:N} player-state effect (minimum dice roll for this
    turn). Same idea as Trucage, for dice."""
    s = strip_markup(desc)
    m = re.search(r"jets?\s+de\s+d[ée]\s+ne\s+peuvent\s+[êe]tre\s+inf[ée]rieurs?\s+[àa]\s+(\d+)", s)
    if not m:
        return None
    return {"type": "SetDiceFloor", "floor": int(m.group(1))}


def parse_add_chacha_noir(card: dict):
    """Dé du Chacha #514: "Ajoutez 1d6 Chacha(s) Noir(s) à votre main." →
    AddCardToHand {cardId:<Chacha Noir #135>, amount:{dice:"NdM"}}, N copies are
    rolled at resolve time. Resolves "Chacha Noir" via card_name_index. Returns the
    effect or None."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"ajoutez?\s+(\d*d\d+)\s+chacha.*noir.*[àa]\s+votre\s+main", s)
    if not m:
        return None
    cid = card_name_index.get(norm_name("chacha noir"))
    if cid is None:
        return None
    return {"type": "AddCardToHand", "cardId": cid, "amount": {"dice": m.group(1)}, "_authored": True}


def parse_coinflip_charge_retreat(desc: str):
    """Tout ou Rien: "Vos invocations chargent de N cases OU reculent de M cases."
    gives a CoinFlip: Pile = mass charge (positive), Face = mass retreat (negative)."""
    s = strip_markup(desc)
    m = re.search(
        r"vos\s+invocations?\s+chargent\s+de\s+(\d+)\s*cases?\s+ou\s+reculent\s+de\s+(\d+)\s*cases?",
        s,
    )
    if not m:
        return None
    return {
        "type": "CoinFlip",
        "pile": [{"type": "ChargeAllies", "cells": int(m.group(1))}],
        "face": [{"type": "RetreatAllies", "cells": int(m.group(2))}],
    }


def parse_coinflip(card: dict):
    """A real "A OU B" is a coin flip (pile/face), not a player choice. Pile is the
    first (positive) branch, Face the second. The CoinFlip is built from the two
    effects of the spec, only when both branches were captured cleanly and both
    are implemented. Other meanings of "ou" are rejected ("ou moins", placement
    "à côté ou derrière", "dé ou pièce", conditional "ou ... si ...")."""
    s = strip_markup(card.get("description", ""))
    if not re.search(r"\bou\b", s):
        return None
    if re.search(r"ou\s+moins|[àa]\s+c[ôo]t[ée]|derri[èe]re|adjacent|d[ée]\s+ou|pile\s+ou\s+face|\bsi\b", s):
        return None
    sp = spec.get(card["id"])
    if not sp:
        return None
    effs = sp.get("effects", [])
    if len(effs) != 2:
        return None
    branches = [{k: v for k, v in e.items() if k != "when"} for e in effs]
    for b in branches:
        if b.get("type") not in IMPLEMENTED:
            return None
        if not has_concrete_amount(b):
            return None
    return {"type": "CoinFlip", "pile": [branches[0]], "face": [branches[1]]}


def parse_coinflip_endturn_draw(card: dict):
    """ "Fin du tour : piochez une carte ou pas d'effet" (Arty Romi #731) gives a
    FIN_DE_TOUR CoinFlip {pile: draw 1 (positive), face: nothing}."""
    s = strip_markup(card.get("description", ""))
    if not re.search(r"piochez\s+une?\s+carte\s+ou\s+pas\s+d.effet", s):
        return None
    return {"type": "CoinFlip", "_authored": True,
            "pile": [{"type": "DrawCards", "amount": 1, "_authored": True}], "face": []}


def parse_trigger_draw(card: dict):
    """ "<trigger> : piochez N carte(s)", a simple self-draw on a creature trigger
    (Phorreur d'Elite #583 DÉBUT DE TOUR, Rabet #484 CONTRE COUP) → DrawCards N on the
    detected slot. Rejects the qualified draws (filtered / conditional / each-player /
    steal-from-opponent / discard-recover / copy) which need their own handling."""
    s = strip_markup(card.get("description", ""))
    # Reject the qualified draws: each-player, opponent-deck (advers), coin-flip
    # ("ou"), conditional ("si"), filtered/recover, copy.
    if re.search(r"chaque joueur|advers|\bou\b|\bsi\b|sinon|gardez|coffre|tofu|moon|krosmique|infinite|d[ée]fauss|copie", s):
        return None
    m = re.search(r"piochez\s+(\d+|une?)\s+cartes?", s)
    if not m:
        return None
    n = 1 if m.group(1) in ("un", "une") else int(m.group(1))
    return {"type": "DrawCards", "amount": n, "_authored": True}


def parse_each_player_draw(card: dict):
    """ "<trigger> : chaque joueur pioche N carte(s)" (Larve Bleue #213) → both sides
    draw from their own deck: [DrawCards N, DrawCards N side:enemy] on the slot.
    Rejects the OPPONENT-deck variant (#408/#545 "de la pioche adverse / chez son
    adversaire" = a CrossDraw, handled elsewhere)."""
    s = strip_markup(card.get("description", ""))
    if "advers" in s:
        return None
    m = re.search(r"chaque joueur pioche\s+(\d+|une?)\s+cartes?", s)
    if not m:
        return None
    n = 1 if m.group(1) in ("un", "une") else int(m.group(1))
    return [{"type": "DrawCards", "amount": n, "_authored": True},
            {"type": "DrawCards", "amount": n, "side": "enemy", "_authored": True}]


def parse_trigger_change_row(card: dict):
    """ "<trigger> : change de ligne", the creature itself teleports to a free cell
    of its column (Bwork Chevaucheur #502 COUP DE GRÂCE) → ChangeRowSelf on the slot.
    The clause must start with "change de ligne" right after the trigger colon, which
    rejects "<un sujet> change de ligne" (e.g. #904 "l'invocation qui détruit … change
    de ligne" = the KILLER moves, not self)."""
    s = strip_markup(card.get("description", ""))
    if not re.search(r":\s*change\s+de\s+ligne", s):
        return None
    return {"type": "ChangeRowSelf", "_authored": True}


def parse_add_tasdos_to_hand(card: dict):
    """ "<trigger> : ajoute un tas d'os à votre main" (Chafer Lancier #197) gives
    AddCardToHand {cardId:691 (the Tas d'Os card), amount:N} on the detected slot."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"ajoute[zr]?\s+(\d+|un)\s+tas\s+d.os\s+(?:dans\s+)?(?:[àa]\s+)?(?:votre\s+|la\s+)?main", s)
    if not m:
        return None
    n = 1 if m.group(1) == "un" else int(m.group(1))
    return {"type": "AddCardToHand", "cardId": 691, "amount": n, "_authored": True}


def parse_transform_tasdos(card: dict):
    """ "<trigger> : transforme(z) un / tous les tas d'os allié(s) en chafer(s)
    décrépit(s)" (Chafer Fantassin #738 for one, Roi Chafer #147 for all) gives
    TransformTasDOs {all} on the detected slot."""
    s = strip_markup(card.get("description", ""))
    m = re.search(
        r"transforme[zr]?\s+(un|tous?\s+les)\s+tas\s+d.os\s+alli[ée]s?\s+en\s+"
        r"chafers?\s+d[ée]cr[ée]pits?", s)
    if not m:
        return None
    return {"type": "TransformTasDOs", "all": m.group(1).startswith("tou"), "_authored": True}


def parse_consume_tasdos_buff(card: dict):
    """ "<trigger> : détruisez un tas d'os allié POUR gagner/donner <+N stats>"
    (Chafer d'Elite #223 "gagner" = scope self, Chafer Hallebardier #626 "donner ...
    à vos autres chafers" = scope chafers) gives ConsumeTasDOsBuff {scope,
    attack/armor/movement}."""
    s = strip_markup(card.get("description", ""))
    if not re.search(r"d[ée]trui[sz]e?z?\s+un\s+tas\s+d.os\s+alli", s):
        return None
    m = re.search(r"pour\s+(gagner|donner)\s+([^.]+)", s)
    if not m:
        return None
    scope = "self" if m.group(1) == "gagner" else "chafers"
    eff = {"type": "ConsumeTasDOsBuff", "scope": scope, "_authored": True}
    for amt, stat in re.findall(r"\+?\s*(\d+)\s*(at|ar|pm)\b", m.group(2)):
        eff[{"at": "attack", "ar": "armor", "pm": "movement"}[stat]] = int(amt)
    if not any(k in eff for k in ("attack", "armor", "movement")):
        return None
    return eff


def parse_place_tasdos_apparition(card: dict):
    """ "APPARITION : Placez un tas d'os allié dans votre camp" (Chafer Archer #336)
    gives PlaceTasDOs on the APPARITION slot. The effect needs a target
    (effectRequiresTarget is true for PlaceTasDOs), so runTrigger opens an
    own_empty_camp pick (an empty cell of your camp; placing it on a prism destroys
    the prism). The ShooterRangeData from the bindata (in effects[]) is kept as it
    is. Not the same as parse_place_tasdos, which puts PlaceTasDOs in effects[] for
    card #691."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"place[zr]?\s+un\s+tas\s+d.os\s+alli[ée]s?\s+dans\s+votre\s+camp", s):
        return {"type": "PlaceTasDOs", "_authored": True}
    return None


def parse_teleport_on_family_death(card: dict):
    """ "se téléporte de N cases quand un <famille> allié meurt" (Chaferfu #401)
    gives a MORT_ALLIEE trigger {filter:{family}} carrying Teleport {cells:N}
    (Teleport jumps N cells forward, already handled by the engine). Returns the
    trigger dict."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"se\s+t[ée]l[ée]porte\s+de\s+(\d+)\s+cases?\s+quand\s+un\s+(\w+)\s+alli[ée]\s+meur[ts]", s)
    if not m:
        return None
    fam = map_tutor_filter(m.group(2))
    if not (fam and "family" in fam):
        return None
    return {"trigger": "MORT_ALLIEE", "filter": {"family": fam["family"]},
            "effects": [{"type": "Teleport", "cells": int(m.group(1)), "_authored": True}]}


def parse_filtered_draw_family(card: dict):
    """ "Piochez N cartes. Si ce n'est pas un <famille> elle est défaussée" (Tofoune
    #106) / "Gardez les <famille>, les autres défaussées" (Tofu Céleste #415) give
    DrawFiltered {amount:N, keepFamily}."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"piochez\s+(\d+|une?)\s+cartes?", s)
    if not m:
        return None
    fm = re.search(r"si\s+ce\s+n.est\s+pas\s+un[e]?\s+(\w+)", s) or re.search(r"gardez\s+les\s+(\w+)", s)
    if not fm:
        return None
    fam = map_tutor_filter(_deaccent(fm.group(1)).rstrip("s"))
    if not (fam and "family" in fam):
        return None
    n = 1 if m.group(1) in ("un", "une") else int(m.group(1))
    return {"type": "DrawFiltered", "amount": n, "keepFamily": fam["family"], "_authored": True}


def parse_replace_with_token(card: dict):
    """ "Remplace vos <X> par des <Y>" (Chacha Or #224: black chachas become gold
    chachas) gives TransformAll {fromCardId:<X>, tokenId:<Y>, scope:allies} (on the
    Summon's APPARITION). Both names have to resolve to specific cards."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"remplace\s+vos\s+(.+?)\s+par\s+des\s+(.+?)\s*\.?\s*$", s)
    if not m:
        return None
    src = resolve_token(m.group(1).strip())
    dst = resolve_token(m.group(2).strip())
    if src is None or dst is None:
        return None
    return {"type": "TransformAll", "fromCardId": src, "tokenId": dst, "scope": "allies", "_authored": True}


def parse_damage_cap(card: dict):
    """ "Ne subit jamais plus de 1 dégât à la fois" (Rupuce #242) gives the innate
    property SetPropertyData {PropertyType:"DamageCap1"}: every hit taken is capped
    at 1 HP (read in applyDamageToCreature[FromSpell])."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"ne\s+subit\s+jamais\s+plus\s+de\s+1\s+d[ée]g[âa]t", s):
        return {"type": "SetPropertyData", "PropertyType": "DamageCap1", "_authored": True}
    return None


def parse_trigger_steal_draw(card: dict):
    """ "<trigger> : piochez N carte(s) chez (votre|son) adversaire" (Bébé Phorreur
    Corrompu #1289) gives StealTopDraw {amount:N, noRedraw:true} on the detected
    slot. It is a plain steal: you take the top of the enemy deck and the opponent
    does not draw again."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"piochez\s+(\d+|une?)\s+cartes?\s+chez\s+(?:votre|son)\s+adversaire", s)
    if not m:
        return None
    n = 1 if m.group(1) in ("un", "une") else int(m.group(1))
    return {"type": "StealTopDraw", "amount": n, "noRedraw": True, "_authored": True}


def parse_ramasser_prisme(card: dict):
    """ "Ramassez/récupère(z) un / tous les prisme(s) [<qualificatif>]": Lou
    "ramassez un prisme" / Malocac "récupérez un prisme adverse" / Comte Harebourg
    "récupère tous les prismes PA en jeu" give RamasserPrisme {all?, side?, kind?}."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"(?:ramasse[zr]?|r[ée]cup[éèe]re[zr]?)\s+(tous\s+les|un|une)\s+prismes?(\s+\w+)?", s)
    if not m:
        return None
    eff = {"type": "RamasserPrisme", "_authored": True}
    if m.group(1).startswith("tous"):
        eff["all"] = True
    q = (m.group(2) or "").strip()
    if "advers" in q:
        eff["side"] = "enemy"
    elif "alli" in q:
        eff["side"] = "ally"
    elif q == "pa":
        eff["kind"] = "ap"
    elif q in ("fleau", "fléau"):
        eff["kind"] = "fleau"
    elif q == "pioche":
        eff["kind"] = "draw"
    # Lou 2★ #521 "Ramassez un prisme" (single, no side/kind) → let the player choose which
    # prism (a targeted APPARITION pick), instead of auto-collecting the nearest.
    if not eff.get("all") and not eff.get("side") and not eff.get("kind"):
        eff["choose"] = True
    return eff


def parse_respawn_prisms(card: dict):
    """ "Fait à nouveau apparaître / réapparaître ..." one or more prisms (Lou #65
    "tous les prismes" gives both, Lou #572 "un prisme allié" gives one, Bouftou
    Male #36 "le prisme allié de sa ligne" gives line) gives RespawnPrisms {scope}.
    ("vos prismes" alone defaults to the caster's side, handled elsewhere and not
    matched here.)"""
    s = strip_markup(card.get("description", ""))
    if "prisme" not in s or not re.search(r"apparait|appara[îi]t|r[ée]apparait", s):
        return None
    if re.search(r"prisme\s+alli[ée]\s+de\s+sa\s+ligne", s):
        return {"type": "RespawnPrisms", "scope": "line", "_authored": True}
    if re.search(r"tous\s+les\s+prismes", s):
        return {"type": "RespawnPrisms", "scope": "both", "_authored": True}
    if re.search(r"un\s+prisme\s+alli", s):
        return {"type": "RespawnPrisms", "scope": "one", "_authored": True}
    return None


def parse_sacrifice_prism_buff(card: dict):
    """ "Sacrifiez un de vos prismes POUR donner/gagner <+N stats> à vos autres
    invocations" (Kibri #735) → SacrificePrismBuff {attack/armor/movement}."""
    s = strip_markup(card.get("description", ""))
    if not re.search(r"sacrifie[zr]?\s+un\s+de\s+vos\s+prismes\s+pour", s):
        return None
    m = re.search(r"pour\s+(?:gagner|donner)\s+([^.]+)", s)
    if not m:
        return None
    eff = {"type": "SacrificePrismBuff", "_authored": True}
    for amt, stat in re.findall(r"\+?\s*(\d+)\s*(at|ar|pm)\b", m.group(1)):
        eff[{"at": "attack", "ar": "armor", "pm": "movement"}[stat]] = int(amt)
    if not any(k in eff for k in ("attack", "armor", "movement")):
        return None
    return eff


def parse_reveal_dofuses(card: dict):
    """ "Dévoile(z) [tous] les dofus [de sa ligne] / un dofus [adverse]" gives
    RevealDofuses {scope, side}. Sang Méprise #211 (all), Salbatroce #480 (line),
    Kerubim l'Aventurier #333 / Démasqué #1234 (one [enemy])."""
    s = strip_markup(card.get("description", ""))
    if not re.search(r"d[ée]voile", s):
        return None
    if re.search(r"dofus\s+de\s+sa\s+ligne", s):
        return {"type": "RevealDofuses", "scope": "line", "_authored": True}
    if re.search(r"tous\s+les\s+dofus", s):
        return {"type": "RevealDofuses", "scope": "all", "_authored": True}
    m = re.search(r"un\s+dofus(\s+adverse)?", s)
    if m:
        eff = {"type": "RevealDofuses", "scope": "one", "_authored": True}
        if m.group(1):
            eff["side"] = "enemy"
        return eff
    return None


def parse_destroy_prism_row(card: dict):
    """ "Détruit/détruisez le prisme adverse de sa ligne" (Kerubim le Brocanteur #378)
    gives DestroyPrismOnRow {side:enemy}."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"d[ée]trui\w*\s+le\s+prisme\s+adverse\s+de\s+sa\s+ligne", s):
        return {"type": "DestroyPrismOnRow", "side": "enemy", "_authored": True}
    return None


def parse_attract_prisms(card: dict):
    """ "Attire (tous les) prismes adverses vers votre/ton camp" (Attirance #125,
    Sacrieur) gives AttractPrisms {side:enemy}."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"attire\s+(?:tous\s+les\s+)?prismes\s+adverses?\s+vers\s+(?:votre|ton)\s+camp", s):
        return {"type": "AttractPrisms", "side": "enemy", "_authored": True}
    return None


def parse_summon_near(card: dict):
    """ "Invoque N <token> à côté ou derrière lui" (Abraknyde #516 araknes, Abraknyde
    Ancestral #455 corbacs) gives SummonToken {tokenId, amount:N, placement:"near"}.
    Each token runs its own APPARITION (so a Corbac charges on its own). The token
    comes from summon_name_index."""
    # "à côté OU derrière lui" (Abraknyde) is not the same as "à côté DE lui" (Moogrr
    # Céleste #1263 / Gary Bûhl #759), which are `choose` placements handled already.
    s = strip_markup(card.get("description", ""))
    m = re.search(r"invoque\s+(\d+|une?)\s+(.+?)\s+[àa]\s+c[oôö]t[ée]\s+ou\s+derri[èe]re", s)
    if not m:
        return None
    tid = summon_name_index.get(norm_name(m.group(2).strip()))
    if tid is None:
        return None
    n = 1 if m.group(1) in ("un", "une") else int(m.group(1))
    return {"type": "SummonToken", "tokenId": tid, "amount": n, "placement": "near", "_authored": True}


def parse_summon_and_charge(card: dict):
    """Khan Karkass #510 (two effects): "invoque 3 fans autour de lui. vos fans
    chargent" gives [SummonToken {tokenId, placement:"frontAndSides"}, ChargeAllies
    {family}]: one fan in front, one on the left and one on the right (an occupied
    cell is skipped), then the whole family charges, new fans included. Returns the
    list of the 2 effects (managed)."""
    s = strip_markup(card.get("description", ""))
    sm = re.search(r"invoque\s+(\d+|une?)\s+(.+?)\s+autour\s+de\s+lui", s)
    cm = re.search(r"vos\s+(\w+?)s?\s+chargent", s)
    if not (sm and cm):
        return None
    tid = summon_name_index.get(norm_name(sm.group(2).strip()))
    if tid is None:
        return None
    fam = map_tutor_filter(cm.group(1))
    if not (fam and "family" in fam):
        return None
    # A single effect: summon the 3 fans, then the family charges. A separate charge
    # in runTrigger would run before the summon, so it is attached to the
    # SummonToken with thenChargeFamily.
    return {"type": "SummonToken", "tokenId": tid, "amount": 3, "placement": "frontAndSides", "thenChargeFamily": fam["family"], "_authored": True}


def parse_drain_ap(card: dict):
    """ "Dépense N PA" with nothing in return (Cactana #587, DÉBUT DU TOUR) gives
    DrainAp {amount:N} (removes N from the caster's AP pool). Rejects "... de votre
    réserve" (Missiz Frizz #474, Synchroniseur #714), "... pour <X>" and "... PA
    restants" (SpendApAsBuff), which are other mechanics."""
    s = strip_markup(card.get("description", ""))
    if "réserve" in s or "reserve" in s or "pour" in s or "restant" in s or "tous" in s:
        return None
    m = re.search(r"d[ée]pense\w*\s+(\d+)\s*pa\b", s)
    if not m:
        return None
    return {"type": "DrainAp", "amount": int(m.group(1)), "_authored": True}


def parse_summon_front(card: dict):
    """ "Invoque un <token> à N cases devant lui [si c'est possible]" (Pissenlit
    Diabolique #1595) gives SummonToken {tokenId, amount:1, placement:"front",
    frontDistance:N} (exactly N cells forward; nothing if the cell is taken or off
    the board)."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"invoque\s+une?\s+(.+?)\s+[àa]\s+(\d+)\s+cases?\s+devant\s+lui", s)
    if not m:
        return None
    tid = summon_name_index.get(norm_name(m.group(1).strip()))
    if tid is None:
        return None
    return {"type": "SummonToken", "tokenId": tid, "amount": 1, "placement": "front", "frontDistance": int(m.group(2)), "_authored": True}


def parse_contrecoup_silence_attacker(card: dict):
    """CONTRE COUP aimed at "l'invocation qui lui inflige des dégâts" (the attacker,
    resolved by fireContreCoup): Belgodass #756 "réduit au silence" gives Silence
    {single, targetAttacker}; Polter #399 "transforme en buisson" gives
    TransformIntoBush {targetAttacker}."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"r[ée]dui\w*\s+au\s+silence\s+l['’]invocation\s+qui\s+lui\s+inflige", s):
        return {"type": "Silence", "single": True, "targetAttacker": True, "_authored": True}
    if re.search(r"transforme\s+en\s+buisson\s+l['’]invocation\s+qui\s+lui\s+inflige", s):
        return {"type": "TransformIntoBush", "targetAttacker": True, "_authored": True}
    # Anathar #316: "tant qu'il est en vie, prend le contrôle de son adversaire"
    # (the attacker, in the CONTRE COUP context). Control goes back when Anathar dies.
    if re.search(r"prend\s+le\s+contr[ôo]le\s+de\s+son\s+adversaire", s) and re.search(r"tant\s+qu", s):
        return {"type": "TakeControl", "targetAttacker": True, "whileSourceAlive": True, "_authored": True}
    return None


def parse_mort_transform_killer(card: dict):
    """MORT effects aimed at the killer ("l'invocation qui le tue / qui a détruit ...",
    resolved by the MORT loop). Bouftou Citrouille #780 "se transforme en <token>"
    gives Transform {tokenId, targetKiller}; Bellaphone #356 "remonte dans votre
    main" gives ReturnToHand {toSide:caster, targetKiller}. The trigger is forced to
    MORT (there is no "mort" keyword in the text)."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"l['’]invocation\s+qui\s+le\s+tue\s+se\s+transforme\s+en\s+(.+?)(?:\.|$)", s)
    if m:
        inner = m.group(1).strip()
        tid = summon_name_index.get(norm_name(inner))
        if tid is None and norm_name(inner) == norm_name(card.get("name", "")):
            tid = card.get("id")
        if tid is not None:
            return {"type": "Transform", "tokenId": tid, "targetKiller": True, "_authored": True}
    if re.search(r"remonte\s+dans\s+votre\s+main\s+l['’]invocation\s+qui\s+a\s+d[ée]truit", s):
        return {"type": "ReturnToHand", "toSide": "caster", "targetKiller": True, "_authored": True}
    # Nainfants #904: "l'invocation qui détruit les nainfants change de ligne
    # aléatoirement": the killer moves to a random adjacent row (MoveAdjacentRowRandom).
    if re.search(r"l['’]invocation\s+qui\s+(?:le\s+tue|d[ée]truit\s+.+?)\s+change\s+de\s+ligne\s+al[ée]atoire", s):
        return {"type": "MoveAdjacentRowRandom", "targetKiller": True, "_authored": True}
    return None


def parse_enemy_recover(card: dict):
    """Phorrerstein #1414: "votre adversaire récupère la dernière carte partie dans
    sa défausse [. elle coûte N PA de plus]" gives RecoverFromDiscard {which:"last",
    forSide:"enemy"[, costDelta:N]} (the opponent gets it back in their own hand,
    with the extra cost)."""
    s = strip_markup(card.get("description", ""))
    if not re.search(r"votre\s+adversaire\s+r[ée]cup[èe]re\s+la\s+derni[èe]re\s+carte\s+parties?\s+dans\s+sa\s+d[ée]fausse", s):
        return None
    eff = {"type": "RecoverFromDiscard", "which": "last", "forSide": "enemy", "_authored": True}
    cm = re.search(r"elle\s+co[ûu]te\s+(\d+)\s+pa\s+de\s+plus", s)
    if cm:
        eff["costDelta"] = int(cm.group(1))
    return eff


def parse_buff_others_per_family(card: dict):
    """Wo Wabbit #290: "donne à vos autres <fam1> +N AT et +M AR par <fam2> allié en
    jeu" gives [BoostAttack, BoostArmor] {scope:allies, family:fam1, excludeSelf,
    amount:{count:{scope:allies, family:fam2}, per:N}}. Returns the list."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"donne\s+[àa]\s+vos\s+autres\s+(\w+?)s?\s+(.+?)\s+par\s+(\w+?)s?\s+alli", s)
    if not m:
        return None
    fam1 = map_tutor_filter(_deaccent(m.group(1)))
    fam2 = map_tutor_filter(_deaccent(m.group(3)))
    if not (fam1 and "family" in fam1 and fam2 and "family" in fam2):
        return None
    effs = []
    for amt, stat in re.findall(r"\+?(\d+)\s*(at|ar)\b", m.group(2)):
        et = {"at": "BoostAttack", "ar": "BoostArmor"}[stat]
        effs.append({"type": et, "scope": "allies", "family": fam1["family"], "excludeSelf": True,
                     "amount": {"count": {"scope": "allies", "family": fam2["family"]}, "per": int(amt)}, "_authored": True})
    return effs or None


def parse_recover_infinite(card: dict):
    """Get Infinite cards back from the discard (Infinite is a rarity).
    Indie #454 "récupère une carte infinite aléatoire ... [elle coûte N PA de moins]"
    gives RecoverFromDiscard {which:random, rarity:Infinite [, costDelta:-N]} (to the
    hand); Indie #305 "récupère les cartes infinite ... et les place sur votre
    pioche" gives RecoverFromDiscard {all, rarity:Infinite, toDeck:true} (to the deck)."""
    s = strip_markup(card.get("description", ""))
    # #305: every Infinite card of the discard goes on top of the deck
    if re.search(r"r[ée]cup[èe]re\s+les\s+cartes\s+infinite\s+de\s+votre\s+d[ée]fausse", s) and re.search(r"place\w*.*pioche", s):
        return {"type": "RecoverFromDiscard", "all": True, "rarity": "Infinite", "toDeck": True, "_authored": True}
    # #454 : UNE Infinite aléatoire → main
    if re.search(r"r[ée]cup[èe]re\s+une\s+carte\s+infinite\s+al[ée]atoire\s+de\s+votre\s+d[ée]fausse", s):
        eff = {"type": "RecoverFromDiscard", "which": "random", "rarity": "Infinite", "_authored": True}
        cm = re.search(r"elle\s+co[ûu]te\s+(\d+)\s+pa\s+de\s+moins", s)
        if cm:
            eff["costDelta"] = -int(cm.group(1))
        return eff
    return None


def parse_tutor_infinite(card: dict):
    """Indie #509: "place dans votre main la dernière carte infinite de votre PIOCHE
    [. elle coûte N PA de moins]" gives TutorFromDeck {from:bottom, amount:1,
    rarity:Infinite [, costMod:-N]}. The source is the deck, unlike #454/#305 which
    take from the discard. "la DERNIÈRE" means we start from the end of the deck."""
    s = strip_markup(card.get("description", ""))
    if not re.search(r"place\s+dans\s+votre\s+main\s+la\s+derni[èe]re\s+carte\s+infinite\s+de\s+votre\s+pioche", s):
        return None
    eff = {"type": "TutorFromDeck", "from": "bottom", "amount": 1, "rarity": "Infinite", "_authored": True}
    cm = re.search(r"(?:elle|il)\s+co[ûu]te\s+(\d+)\s+pa\s+de\s+moins", s)
    if cm:
        eff["costMod"] = -int(cm.group(1))
    return eff


def parse_tutor_by_god(card: dict):
    """Many de Brakmar #227: "place dans votre main la prochaine carte <dieu> de votre
    pioche [coûtant N pa]" gives TutorFromDeck {from:top, amount:1, god:<God> [, cost:N]}.
    <dieu> has to be a known class (Xelor, Iop, ...), otherwise it is ignored (it is
    not a rarity or a family)."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"place\s+dans\s+votre\s+main\s+la\s+prochaine\s+carte\s+(\w+)\s+de\s+votre\s+pioche(?:\s+co[ûu]tant\s+(\d+)\s+pa)?", s)
    if not m:
        return None
    god = god_by_lower.get(_deaccent(m.group(1).lower()))
    if not god:
        return None
    eff = {"type": "TutorFromDeck", "from": "top", "amount": 1, "god": god, "_authored": True}
    if m.group(2):
        eff["cost"] = int(m.group(2))
    return eff


def parse_add_random_family(card: dict):
    """Maloboss #470: "ajoute N autres <famille> à votre main" gives AddRandomFamilyCards
    {family, amount:N, excludeName:<card name>}. Draws N different Summons of the
    family ("pas deux fois le même"), leaving out the card itself by name ("autres",
    "pas un autre Maloboss")."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"ajoute\w*\s+(\d+)\s+autres?\s+(\w+?)s?\s+[àa]\s+votre\s+main", s)
    if not m:
        return None
    fam = map_tutor_filter(_deaccent(m.group(2)))
    if not (fam and "family" in fam):
        return None
    return {"type": "AddRandomFamilyCards", "family": fam["family"], "amount": int(m.group(1)),
            "excludeName": card.get("name", ""), "_authored": True}


def parse_attract_creature(card: dict):
    """Chacha Tyran #943: "attire une invocation de N cases" gives a targeted
    AttractCreature {distance:N} (the target slides N cells toward the dofus of the
    caster's camp, stopped by any obstacle)."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"attire\s+une?\s+invocation\s+de\s+(\d+)\s+cases?", s)
    if not m:
        return None
    return {"type": "AttractCreature", "distance": int(m.group(1)), "_authored": True}


def parse_hand_cost_on_event(card: dict):
    """ "Tant qu'elle est en main, son coût est réduit de N PA quand <événement>" gives
    HandCostOnEvent {event, amount:N} (top level). Events: "une invocation ennemie
    meurt" (Impératrice #1300, enemyDeath), "une invocation meurt" (Nonne #1643,
    anyDeath), "un allié ramasse un butin" (Golgor #1349, allyButinPickup)."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"tant\s+qu['’]\w+\s+est\s+en\s+main,?\s+son\s+co[ûu]t\s+est\s+r[ée]duit\s+de\s+(\d+)\s+pa\s+quand\s+(.+)", s)
    if not m:
        return None
    body = m.group(2)
    if re.search(r"une\s+invocation\s+ennemie\s+meurt", body):
        event = "enemyDeath"
    elif re.search(r"une\s+invocation\s+meurt", body):
        event = "anyDeath"
    elif re.search(r"un\s+alli[ée]\s+ramasse\s+un\s+butin", body):
        event = "allyButinPickup"
    else:
        return None
    return {"type": "HandCostOnEvent", "event": event, "amount": int(m.group(1)), "_authored": True}


def parse_noop_junk(card: dict):
    """Poils de Jiji #281: "jouez cette carte pour vous en débarasser" gives NoOp (a
    junk spell with no effect, only played to get rid of it)."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"jouez\s+cette\s+carte\s+pour\s+vous\s+en\s+d[ée]bar", s):
        return {"type": "NoOp", "_authored": True}
    return None


def parse_krosmic_draw(card: dict):
    """Sigrun #917: "piochez une carte krosmique quand votre adversaire joue une carte
    krosmique" gives an ON_PLAY trigger {filter:{side:enemy, rarity:Krosmic}} with a
    TutorFromDeck {rarity:Krosmic} (draws a Krosmic card when the opponent plays one)."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"piochez\s+une\s+carte\s+krosmique\s+quand\s+votre\s+adversaire\s+joue\s+une\s+carte\s+krosmique", s):
        return {
            "trigger": "ON_PLAY",
            "filter": {"side": "enemy", "rarity": "Krosmic"},
            "effects": [{"type": "TutorFromDeck", "from": "top", "amount": 1, "rarity": "Krosmic", "_authored": True}],
            "_authored": True,
        }
    return None


def parse_spell_damage_reduction(card: dict):
    """#110 (Protecteur): "tant qu'il est en jeu, réduit de N les dégâts des sorts
    adverses" gives SpellDamageReductionAura {amount:N} (a passive top-level aura,
    read by applyDamageToCreatureFromSpell)."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"tant\s+qu['’]il\s+est\s+en\s+jeu,?\s+r[ée]duit\s+de\s+(\d+)\s+les\s+d[ée]g[âa]ts\s+des\s+sorts\s+adverses", s)
    if not m:
        return None
    return {"type": "SpellDamageReductionAura", "amount": int(m.group(1)), "_authored": True}


def parse_base_glyph(card: dict):
    """Glyphe #827 (the basic Féca Glyphe card, castTarget EmptyAlliedCells): "confère
    au Féca qui marche dessus autant d'AR que de lignes comprenant au moins un glyphe
    allié. Les invocations adverses détruisent les glyphes sur lesquels elles marchent."
    gives PlaceGlyph (places a glyph; the Féca armour and the destruction by enemies
    are handled by the existing step-on-glyph logic)."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"conf[èe]re\s+au\s+f[ée]ca\s+qui\s+marche\s+dessus", s):
        return {"type": "PlaceGlyph", "_authored": True}
    return None


def parse_recover_on_family_death(card: dict):
    """Rat Tiboiseur #339: "revient de votre défausse dans votre main quand un de vos
    <famille> meurt" gives RecoverSelfOnFamilyDeath {family} (a passive top-level
    marker, read when deaths are resolved)."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"revient\s+de\s+votre\s+d[ée]fausse\s+dans\s+votre\s+main\s+quand\s+un\s+de\s+vos\s+(\w+?)s?\s+meurt", s)
    if not m:
        return None
    fam = family_by_lower.get(m.group(1).lower())
    if not fam:
        return None
    return {"type": "RecoverSelfOnFamilyDeath", "family": fam, "_authored": True}


FRATRIE_TRANSFORM = {603: 751, 751: 603}  # Sipho ↔ Sipho Transformé (paire toggle)


def parse_fratrie_transform(card: dict):
    """Sipho #603 / Sipho Transformé #751: "FRATRIE : quand un membre de la fratrie des
    Oubliés est joué, il se transforme / il retrouve sa forme originelle". The
    "fratrie des Oubliés" is the "Fratrie" family. Gives ON_PLAY {filter:{family:Fratrie}}
    with a Transform to the other form (toggles #603 and #751). The ON_PLAY family
    filter ignores the card itself being played (fireOnPlayReactions does not make
    the played card react)."""
    cid = card.get("id")
    if cid not in FRATRIE_TRANSFORM:
        return None
    s = strip_markup(card.get("description", ""))
    if re.search(r"membre\s+de\s+la\s+fratrie\s+des\s+oubli[ée]s\s+est\s+jou[ée]", s):
        return {
            "trigger": "ON_PLAY",
            "filter": {"family": "Fratrie"},
            "effects": [{"type": "Transform", "tokenId": FRATRIE_TRANSFORM[cid], "asOwner": "keep", "self": True, "_authored": True}],
            "_authored": True,
        }
    return None


def parse_buff_on_overflow(card: dict):
    """Nain Patraque #965: "gagne +N AT et +M AR quand une carte est défaussée car la
    main d'un des joueurs est pleine" gives BuffSelfOnOverflowDiscard {attack:N, armor:M}."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"gagne\s+\+(\d+)\s+at\s+et\s+\+(\d+)\s+ar\s+quand\s+une\s+carte\s+est\s+d[ée]fauss[ée]e\s+car\s+la\s+main\s+d['’]un\s+des\s+joueurs\s+est\s+pleine", s)
    if not m:
        return None
    return {"type": "BuffSelfOnOverflowDiscard", "attack": int(m.group(1)), "armor": int(m.group(2)), "_authored": True}


def parse_damage_on_overflow(card: dict):
    """Crasslek #355: "inflige N dégât(s) aux invocations adverses quand une carte est
    défaussée car la main d'un des joueurs est pleine" gives
    DamageEnemiesOnOverflowDiscard {amount:N}."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"inflige\s+(\d+)\s+d[ée]g[âa]ts?\s+aux\s+invocations\s+adverses\s+quand\s+une\s+carte\s+est\s+d[ée]fauss[ée]e\s+car\s+la\s+main\s+d['’]un\s+des\s+joueurs\s+est\s+pleine", s)
    if not m:
        return None
    return {"type": "DamageEnemiesOnOverflowDiscard", "amount": int(m.group(1)), "_authored": True}


def parse_spend_ap_damage(card: dict):
    """Désynchronisation #377: "dépense vos PA restants pour infliger l'équivalent
    en dégâts" gives SpendApAsDamage (resolved in castSpell: the target takes damage
    equal to the caster's remaining AP, then AP goes to 0; canPlayCard makes it
    unplayable at 0 AP)."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"d[ée]pense\s+vos\s+pa\s+restants\s+pour\s+infliger\s+l'[ée]quivalent\s+en\s+d[ée]g[âa]ts", s):
        return {"type": "SpendApAsDamage", "_authored": True}
    return None


def parse_spend_ap_self_buff(card: dict):
    """Radoris Montrouge #489: "APPARITION : dépense vos PA. Gagne +1 AT et +1 AR par PA
    utilisé." gives SpendApAsBuff {stats:[attack,armor]} on the APPARITION, applied to
    the source itself (like Heure de Gloire #296, but here the creature gets the buff).
    summonCreature spends the owner's remaining AP and buffs the creature by that
    amount. This replaces the wrong bindata (a flat BoostAttackData {Boost:1}).
    Returns the effect list (to replace the APPARITION slot) or None."""
    if card.get("cardType") != "Summon":
        return None
    s = strip_markup(card.get("description", ""))
    if re.search(r"d[ée]pense\s+vos\s+pa\b.*gagne\s+\+?1\s+at\s+et\s+\+?1\s+ar\s+par\s+pa\s+utilis", s):
        return [{"type": "SpendApAsBuff", "stats": ["attack", "armor"], "_authored": True}]
    return None


def parse_ronces_agressives(card: dict):
    """Ronces Agressives #439: "inflige N aux invocations adverses d'une ligne" has to be
    castable on any cell, with no creature under the cursor (the clicked cell only
    picks the line, like Tremblement de Terre / Mot Protecteur). The bindata DamageData
    is single-target and `hasDamage` in canPlayCard requires a creature on the cell,
    so it is replaced by an AoeDamage on the enemies of the clicked cell's row
    (ligne = same y). AoeDamage is not a DamageData, so hasDamage becomes false and
    empty cells are allowed. The damage value comes from the bindata DamageData (the
    description has an @damage@ placeholder, not a number). Returns the effect or None."""
    if card.get("cardType") not in ("Spell", "Aoe"):
        return None
    s = strip_markup(card.get("description", ""))
    if not re.search(r"inflige\b.*aux?\s+invocations?\s+adverses?\s+d['’]une\s+ligne", s):
        return None
    effs = card.get("effects") or []
    # Damage value: from the bindata DamageData, or (idempotent re-runs) from the AoeDamage
    # this parser already wrote.
    dmg = next((e.get("Damage") for e in effs if e.get("type") == "DamageData"), None)
    if dmg is None:
        dmg = next((e.get("amount") for e in effs if e.get("type") == "AoeDamage"), None)
    if dmg is None:
        return None
    out = [{"type": "AoeDamage", "amount": dmg, "scope": "enemies", "shape": "row", "_authored": True}]
    # "ajoute une graine à votre réserve de graines" always happens on cast (Ronces
    # Agressives always adds a seed when played), so this is just AddSeeds 1.
    if re.search(r"ajoute\s+une\s+graine\s+[àa]\s+votre\s+r[ée]serve\s+de\s+graines", s):
        out.append({"type": "AddSeeds", "amount": 1, "_authored": True})
    return out


def parse_pelle_sismique(card: dict):
    """Pelle Sismique #1104: "Ciblez une case pour déterrer un Butin allié après avoir infligé
    @damage@ aux invocations ADVERSES de la ligne." The bindata is a single-target
    DamageData, so it hits whatever is on the clicked cell, your own allies included,
    and requires a creature under the cursor. It is replaced by an AoeDamage on the
    enemies of the targeted row (allies are never hit, and since AoeDamage is not a
    DamageData the spell can be cast on any cell), plus a PlaceButin on the cast cell
    ("déterrer un Butin allié"). The damage is read from the DamageData, or from the
    AoeDamage already written when the script runs again. Returns the effect list or None."""
    if card.get("cardType") not in ("Spell", "Aoe"):
        return None
    s = strip_markup(card.get("description", ""))
    if "invocations adverses de la ligne" not in s or "butin" not in s:
        return None
    effs = card.get("effects") or []
    dmg = next((e.get("Damage") for e in effs if e.get("type") == "DamageData"), None)
    if dmg is None:
        dmg = next((e.get("amount") for e in effs if e.get("type") == "AoeDamage"), None)
    if not isinstance(dmg, int):
        return None
    return [
        {"type": "AoeDamage", "amount": dmg, "scope": "enemies", "shape": "row", "_authored": True},
        {"type": "PlaceButin", "count": 1, "_authored": True},
    ]


def parse_aoe_damage_around_cell(card: dict):
    """Tremblement de Terre #231: "inflige N aux invocations autour de la case ciblée" gives an
    AoeDamage {scope:all, shape:around} on the 3x3 around the clicked cell, castable on
    any cell with no creature under the cursor (the clicked cell only picks the area,
    like Mot Protecteur / Ronces Agressives). It hits both sides (no "adverses").
    Replaces the broken single-target bindata DamageData (AoeDamage is not a
    DamageData, so hasDamage becomes false and empty cells are allowed). The
    "autour DU GLYPHE" variant has its own parser. Returns the effect list or None."""
    if card.get("cardType") not in ("Spell", "Aoe"):
        return None
    s = strip_markup(card.get("description", ""))
    if "glyphe" in s or not re.search(r"inflige\b.*aux?\s+invocations?\s+autour\s+de\s+la\s+case\s+cibl[ée]e", s):
        return None
    effs = card.get("effects") or []
    dmg = next((e.get("Damage") for e in effs if e.get("type") == "DamageData"), None)
    if dmg is None:
        dmg = next((e.get("amount") for e in effs if e.get("type") == "AoeDamage"), None)
    if dmg is None:
        return None
    return [{"type": "AoeDamage", "amount": dmg, "scope": "all", "shape": "around", "_authored": True}]


def parse_aoe_cross_cell(card: dict):
    """Epée Céleste #631: "inflige X sur la ligne et la rangée de la case ciblée" gives
    AoeDamage {amount:X, scope:all, shape:cross}, the + through the clicked cell (its
    row and its column), on both sides (no "adverses"). castTarget is Cell, so it can
    be cast on any cell with no creature under the cursor (the clicked cell only picks
    the centre of the cross; a plain DamageData would require a creature). Replaces the
    single-target bindata (AoeDamage is not a DamageData, so empty cells are allowed).
    Idempotent: X is read from the DamageData or from an AoeDamage already written.
    Returns the effect list or None."""
    if card.get("cardType") not in ("Spell", "Aoe"):
        return None
    s = strip_markup(card.get("description", ""))
    if not re.search(r"inflige\b.*sur\s+la\s+ligne\s+et\s+(?:la\s+)?rang[ée]e\s+de\s+la\s+case\s+cibl[ée]e", s):
        return None
    effs = card.get("effects") or []
    dmg = next((e.get("Damage") for e in effs if e.get("type") == "DamageData"), None)
    if dmg is None:
        dmg = next((e.get("amount") for e in effs if e.get("type") == "AoeDamage"), None)
    if dmg is None:
        return None
    return [{"type": "AoeDamage", "amount": dmg, "scope": "all", "shape": "cross", "_authored": True}]


def parse_sacrier_foot(card: dict):
    """Pied du Sacrieur #271: "inflige X à une invocation et Y aux autres", the bindata is a
    DamageData whose Damage is a {type:SacrierFoot, PrimaryDamage:X, OtherDamage:Y} object the
    engine cannot read (it expects a number → 0/NaN damage). Convert to a single-target
    DamageData {X} on the clicked creature + an AoeDamage {Y, scope:all, excludeTargetCreature}
    on every other living creature (both sides, no side in the text). Idempotent: re-reads X/Y
    from the SacrierFoot bindata or from an already-converted pair. Returns the effects or None."""
    effs = card.get("effects") or []
    primary = other = None
    for e in effs:
        if e.get("type") == "DamageData" and isinstance(e.get("Damage"), dict) and e["Damage"].get("type") == "SacrierFoot":
            primary = int(e["Damage"].get("PrimaryDamage", 0))
            other = int(e["Damage"].get("OtherDamage", 0))
    if primary is None and any(e.get("type") == "AoeDamage" and e.get("excludeTargetCreature") for e in effs):
        primary = next((int(e.get("Damage", 0)) for e in effs if e.get("type") == "DamageData" and not isinstance(e.get("Damage"), dict)), None)
        other = next((int(e.get("amount", 0)) for e in effs if e.get("type") == "AoeDamage" and e.get("excludeTargetCreature")), None)
    if primary is None or other is None:
        return None
    return [
        {"type": "DamageData", "Damage": primary, "_authored": True},
        {"type": "AoeDamage", "amount": other, "scope": "all", "excludeTargetCreature": True, "_authored": True},
    ]


def parse_seed_on_kill(card: dict):
    """Ronce #384: "ajoute une graine à votre réserve de graines SI l'invocation meurt" →
    SeedReserveOnKill {amount:1} (conditional, castSpell banks a seed only if the picked
    creature died from the cast). Distinct from Ronces Agressives #439's unconditional
    AddSeeds. Appended to the card's existing damage effect. Returns the effect or None."""
    if card.get("cardType") not in ("Spell", "Aoe"):
        return None
    s = strip_markup(card.get("description", ""))
    if not re.search(r"ajoute\s+une\s+graine\s+[àa]\s+votre\s+r[ée]serve\s+de\s+graines\s+si\s+l['’]invocation\s+meurt", s):
        return None
    return {"type": "SeedReserveOnKill", "amount": 1, "_authored": True}


def parse_draw_on_kill(card: dict):
    """Flèche d'Immolation #351: "inflige X, si l'invocation meurt piochez N carte(s)" →
    DrawOnKill {amount:N} (conditional, castSpell draws only if the picked creature died from
    the cast). Twin of parse_seed_on_kill; appended to the card's existing damage effect.
    Returns the effect or None."""
    if card.get("cardType") not in ("Spell", "Aoe"):
        return None
    s = strip_markup(card.get("description", ""))
    m = re.search(r"si\s+l['’]invocation\s+meurt\s+piochez\s+(une|\d+)\s*cartes?", s)
    if not m:
        return None
    return {"type": "DrawOnKill", "amount": 1 if m.group(1) == "une" else int(m.group(1)), "_authored": True}


def parse_recover_on_kill(card: dict):
    """Flèche Chercheuse #38: "Inflige X, si l'invocation est détruite récupérez ce
    sort. Il coûte N PA de plus." gives RecoverOnKill {costDelta:N}. It is conditional:
    castSpell returns the spell to the hand, with a growing extra cost, only if the
    picked creature died from the cast. Same idea as parse_draw_on_kill. Returns the
    effect or None."""
    if card.get("cardType") not in ("Spell", "Aoe"):
        return None
    s = strip_markup(card.get("description", ""))
    if not re.search(r"si\s+l['’]invocation\s+est\s+d[ée]truite\s+r[ée]cup[ée]rez\s+ce\s+sort", s):
        return None
    m = re.search(r"co[ûu]te\s+(\d+)\s*pa\s+de\s+plus", s)  # the "+N PA de plus" surcharge (default 1)
    return {"type": "RecoverOnKill", "costDelta": int(m.group(1)) if m else 1, "_authored": True}


def parse_scatter_dofus(card: dict):
    """Craps #10: "Inflige N OU M dégâts répartis entre les Dofus adverses." A coin flip
    picks N (pile, positive) or M (face), then the points are dealt one by one to
    random enemy Dofus (ScatterDamageDofus). Replaces the broken bindata effects (a
    flat list of 1-damage hits). Returns the new effect list, or None. It is detected
    from the description again on each run, so it is idempotent."""
    if card.get("cardType") not in ("Spell", "Aoe"):
        return None
    s = strip_markup(card.get("description", ""))
    m = re.search(r"inflige\s+(\d+)\s+ou\s+(\d+)\s*d[ée]g[âa]ts?\s+r[ée]partis?\s+entre\s+les\s+dofus\s+advers", s)
    if not m:
        return None
    hi, lo = int(m.group(1)), int(m.group(2))
    return [{
        "type": "CoinFlip",
        "pile": [{"type": "ScatterDamageDofus", "amount": hi, "_authored": True}],
        "face": [{"type": "ScatterDamageDofus", "amount": lo, "_authored": True}],
        "_authored": True,
    }]


def parse_then_heal(card: dict):
    """Empathie #1532: "Confère bouclier à une invocation blessée PUIS la soigne de
    N PV." The bindata only has the Shield (SetPropertyData); the heal is missing.
    We add a single-target Heal {amount:N} on the same picked creature (a Heal with no
    scope lands on ctx.targetCell, the wounded creature targeted by the cast).
    Returns N or None."""
    if card.get("cardType") not in ("Spell", "Aoe"):
        return None
    s = strip_markup(card.get("description", ""))
    m = re.search(r"puis\s+(?:la|le|l['’]|les)\s*soigne\s+de\s+(\d+)\s*pv", s)
    return int(m.group(1)) if m else None


def parse_criblage(card: dict):
    """Criblage #519: "inflige à un dofus autant de dégâts que de <famille> alliés en jeu". The
    bindata Damage is a {NumberOfSummonValue, FamilyFilter, ...} object the engine cannot
    read (it would deal NaN to the Dofus). It is converted to a DamageData whose Damage
    is a count {family:<card's god>, scope:allies, per:1}: resolveCounts turns it into the
    number of allied creatures of that family, dealt to the targeted enemy Dofus
    (castTarget OpponentDofus). The counted family is the card's own god (Criblage is Cra,
    so it counts "crâs alliés"). Idempotent. Returns the effects or None."""
    if card.get("cardType") != "Spell":
        return None
    s = strip_markup(card.get("description", ""))
    if not re.search(r"inflige\s+[àa]\s+un\s+dofus\s+autant\s+de\s+d[ée]g[âa]ts\s+que\s+de\s+\w+\s+alli[ée]s?\s+en\s+jeu", s):
        return None
    fam = card.get("god")
    if not fam:
        return None
    return [{"type": "DamageData", "Damage": {"count": {"family": fam, "scope": "allies"}, "per": 1}, "_authored": True}]


def parse_bain_de_sang(card: dict):
    """Bain de Sang #1316: "L'invocation ciblée subit autant de dégâts que d'invocations blessées en
    jeu puis charge d'autant de cases." The bindata Damage is a NumberOfSummonValue{WoundedOnly}
    the engine cannot read (it gives 0 damage), and the charge is missing. Replaced by a
    count-based DamageData (number of wounded creatures, both sides) plus a targeted
    Charge of the same count. resolveCounts resolves both `Damage` and `cells` on the
    board at cast time, so N is the same. Returns the effects or None."""
    if card.get("cardType") != "Spell":
        return None
    s = strip_markup(card.get("description", ""))
    if not re.search(r"autant\s+de\s+d[ée]g[âa]ts\s+que\s+d['’]invocations\s+bless[ée]es?\s+en\s+jeu", s) or "charge" not in s:
        return None
    cnt = {"count": {"scope": "all", "wounded": True}, "per": 1}
    return [
        {"type": "DamageData", "Damage": dict(cnt), "_authored": True},
        {"type": "Charge", "cells": dict(cnt), "_authored": True},
    ]


def parse_fleche_criblante(card: dict):
    """Flèche Criblante #8: "inflige X à une invocation et Y au Dofus adverse". The bindata has two
    single-target DamageData [X, Y], both aimed at the cast cell, so the creature takes
    X+Y and the Dofus nothing. We keep the first one (X to the targeted creature) and
    turn the second into DamageDofusOnTargetRow {amount:Y}, the enemy Dofus on the
    targeted creature's own row ("la ligne de l'invocation ciblée"). Idempotent: the
    Dofus amount is read from the second bindata DamageData or from a
    DamageDofusOnTargetRow already converted. Returns the effects or None."""
    if card.get("cardType") != "Spell":
        return None
    s = strip_markup(card.get("description", ""))
    if not re.search(r"[àa]\s+une\s+invocation\s+et\s+.*au\s+dofus\s+adverse", s, re.IGNORECASE):
        return None
    effs = card.get("effects") or []
    dmgs = [e for e in effs if e.get("type") == "DamageData"]
    if not dmgs:
        return None
    if len(dmgs) >= 2 and isinstance(dmgs[1].get("Damage"), int):
        dofus_amt = dmgs[1]["Damage"]                       # bindata pair → second DamageData is the dofus one
    else:
        conv = next((e for e in effs if e.get("type") == "DamageDofusOnTargetRow"), None)
        if conv is None or not isinstance(conv.get("amount"), int):
            return None                                      # nothing to convert / cannot read amount
        dofus_amt = conv["amount"]                           # already converted → idempotent re-read
    return [dmgs[0], {"type": "DamageDofusOnTargetRow", "amount": int(dofus_amt), "_authored": True}]


def parse_damage_dofus_on_heal(card: dict):
    """Malox Makugen #76: "inflige N dégât au dofus adverse de sa ligne quand une invocation est
    soignée" gives a passive DamageDofusOnRowOnHeal {amount:N} on card.effects (like
    Dargone's ReduceFirstEnemyAtOnAllyHeal: applyHealReactions scans LIFE_HEALED events).
    Replaces the unused bindata DamageData. Returns the effect list or None."""
    if card.get("cardType") != "Summon":
        return None
    s = strip_markup(card.get("description", ""))
    m = re.search(r"inflige\s+(\d+)\s*d[ée]g[âa]ts?\s+au\s+dofus\s+adverse\s+de\s+sa\s+ligne\s+quand\s+une\s+invocation\s+est\s+soign[ée]", s)
    if not m:
        return None
    return [{"type": "DamageDofusOnRowOnHeal", "amount": int(m.group(1)), "_authored": True}]


def parse_damage_dofus_on_butin_pickup(card: dict):
    """Ratchet #589: "Inflige @damage@ au Dofus adverse de sa ligne quand vous ramassez un Butin."
    → a passive DamageDofusOnRowOnButinPickup {amount:N} on card.effects (like Malox's heal version
, applyButinReward, the chokepoint of every Butin pickup, fires it on the picker's Ratchets).
    The @damage@ amount comes from the stranded bindata DamageData; replaces it. Returns the
    effects list or None. Idempotent: re-reads the amount from a prior marker if DamageData is gone."""
    if card.get("cardType") != "Summon":
        return None
    s = strip_markup(card.get("description", ""))
    if not re.search(r"au\s+dofus\s+adverse\s+de\s+sa\s+ligne\s+quand\s+vous\s+ramassez\s+un\s+butin", s, re.I):
        return None
    amt = 1
    for e in card.get("effects", []):
        if e.get("type") == "DamageData" and isinstance(e.get("Damage"), int):
            amt = e["Damage"]; break
        if e.get("type") == "DamageDofusOnRowOnButinPickup" and isinstance(e.get("amount"), int):
            amt = e["amount"]; break
    return [{"type": "DamageDofusOnRowOnButinPickup", "amount": amt, "_authored": True}]


def parse_attach_sinistro(card: dict):
    """Sinistro #215: a Xelor spell placed on an allied Dofus (castTarget AlliedDofusWithoutEquipement)
    that becomes an equipment firing each FIN DU TOUR. The bindata is [SinistroData, DamageData{1},
    SetPropertyData{EquipementAttached}], the DamageData{1} would wound your own Dofus on placement
    (castTarget has "Dofus" → dofusTargetable). Replace all three with a single AttachSinistro marker;
    the engine attaches it (no damage), fires it at end of turn, and breaks it when the host is wounded.
    Matched by id (#215, the only AttachSinistro card). Returns the effects list or None."""
    if card.get("id") != 215:
        return None
    return [{"type": "AttachSinistro", "_authored": True}]


def parse_damage_enemies_on_ally_heal(card: dict):
    """Pacificatrice Enjouée #1519: "inflige N dégât aux invocations adverses quand une
    invocation alliée est soignée" gives a passive DamageEnemiesOnAllyHeal {amount:N} on
    card.effects (like Dargone/Malox: applyHealReactions scans the LIFE_HEALED events of
    an ally and hits every enemy creature). Replaces the unused bindata DamageData.
    Returns the effect list or None."""
    if card.get("cardType") != "Summon":
        return None
    s = strip_markup(card.get("description", ""))
    m = re.search(r"inflige\s+(\d+)\s*d[ée]g[âa]ts?\s+aux\s+invocations?\s+adverses?\s+quand\s+une\s+invocation\s+alli[ée]e?\s+est\s+soign[ée]", s)
    if not m:
        return None
    return [{"type": "DamageEnemiesOnAllyHeal", "amount": int(m.group(1)), "_authored": True}]


def parse_coup_de_sang(card: dict):
    """Coup de Sang #570: "confère à une invocation autant d'AT qu'elle a de PV". The bindata
    SetAttack {toLife} sets the attack to the life, but "confère" means add. We add the
    `add` flag, so the target's current life is added to its attack (AT += PV) instead
    of replacing it. Not the same as Acide Sandoz "AT égale à ses PV restants", which
    really sets it. Replaces card.effects. Returns the effect list or None."""
    if card.get("cardType") != "Spell":
        return None
    s = strip_markup(card.get("description", ""))
    if not re.search(r"conf[èe]re\s+.*autant\s+d['’]\s*at\s+qu['’]\s*elle\s+a\s+de\s+pv", s):
        return None
    return [{"type": "SetAttack", "toLife": True, "add": True, "_authored": True}]


def parse_arty_strip_self_sickness(card: dict):
    """Arty #834: "ralliement annule le mal d'invocation des invocations qui LE RALLIENT". The
    bindata puts SetPropertyData NoSummoningSickness on Arty itself (so Arty could act at
    once). But the cancel is for the creatures that rally to it (handled by applyRally,
    keyed by card id), not for Arty, which has summoning sickness like any creature. We
    drop the NoSummoningSickness self property. Returns the filtered effects, or None if
    there is nothing to drop."""
    s = strip_markup(card.get("description", ""))
    if not re.search(r"annule\s+le\s+mal\s+d['’]invocation\s+des\s+invocations\s+qui\s+le\s+rallient", s):
        return None
    effs = card.get("effects") or []
    filtered = [e for e in effs if not (e.get("type") == "SetPropertyData" and e.get("PropertyType") == "NoSummoningSickness")]
    return filtered if len(filtered) != len(effs) else None


def parse_artheon(card: dict) -> bool:
    """Artheon #1424: "ralliement APPARITION : ciblez un dofus, il est invulnérable tant que cette
    invocation est en jeu". The bindata bakes SetPropertyData Invulnerable on Artheon itself (wrong
, that property belongs to the targeted Dofus, not Artheon) and leaves the APPARITION empty.
    True when the desc matches; the wiring fires MakeDofusInvulnerable from the APPARITION (a
    targeted any_dofus pick, held off the board by the deferred-summon machinery) and drops the
    mis-baked Invulnerable self-property."""
    s = strip_markup(card.get("description", ""))
    return bool(re.search(r"ciblez\s+un\s+dofus.*invuln[ée]rable\s+tant\s+que\s+cette\s+invocation\s+est\s+en\s+jeu", s))


def parse_grougaloragran(card: dict) -> bool:
    """Grougaloragran #397: "Tant qu'il est en jeu, vos Dofus sont invulnérables." Same mistake as
    Artheon: the bindata puts SetPropertyData Invulnerable on Grougal itself (a 9 AP 6/6 that
    cannot die), but the invulnerability belongs to all of the owner's Dofus, passively
    (no pick, unlike Artheon). We turn the self Invulnerable into an innate
    ProtectsOwnDofus property: summonCreature sets it through the SetPropertyData path,
    and dofusInvulnerable treats every Dofus of the same owner as invulnerable while a
    creature with it is alive (an aura that ends when it dies). Not the same as Orbe Doré
    #594 ("invulnérable à vos Dofus pour 1 tour", temporary) or the [DBG] card. Only
    matches the passive "tant qu'il est en jeu ... vos Dofus sont invulnérables" wording."""
    s = strip_markup(card.get("description", ""))
    return bool(re.search(r"tant qu['’]il est en jeu.{0,30}vos\s+dofus\s+sont\s+invuln[ée]rables?", s))


def parse_conditional_self_property(card: dict):
    """Cogneur Nimbos #905: "APPARITION : gagne <propriété> si une invocation adverse se trouve devant
    lui". The bindata sets the property statically (always on). We make it depend on
    enemyAheadOnRow: the static SetPropertyData is dropped and a ConditionalSelfProperty
    {property, condition} is added, which the engine grants at summon only when a living
    enemy is ahead on its row. Returns the rebuilt effects, or None."""
    s = strip_markup(card.get("description", ""))
    if not re.search(r"gagne\s+\w+.*\bsi\s+une?\s+invocation\s+adverse\s+(?:se\s+trouve\s+|est\s+)?devant\s+(?:lui|elle)", s):
        return None
    effs = card.get("effects") or []
    prop = next((e.get("PropertyType") for e in effs if e.get("type") == "SetPropertyData" and e.get("PropertyType")), None)
    if not prop:
        return None
    out = [e for e in effs if not (e.get("type") == "SetPropertyData" and e.get("PropertyType") == prop)]
    out.append({"type": "ConditionalSelfProperty", "property": prop, "condition": {"kind": "enemyAheadOnRow"}, "_authored": True})
    return out


def parse_damage_own_dofus_to_summon(card: dict):
    """Padgref Démouelle #222: "infligez N dégât à un de vos dofus pour l'invoquer". The
    summon's APPARITION picks one of your own Dofus and deals N to it (a summon cost paid
    by yourself). The deferred-summon code keeps the creature off the board until the
    Dofus is chosen. Returns N (the wiring then builds a DamageDofus {amount:N,
    side:"ally"} on the APPARITION and drops the unused single-target bindata
    DamageData), or None."""
    if card.get("cardType") != "Summon":
        return None
    s = strip_markup(card.get("description", ""))
    m = re.search(r"infligez?\s+(\d+)\s+d[ée]g[âa]ts?\s+à\s+un\s+de\s+vos\s+dofus\s+pour\s+l['’]invoquer", s)
    return int(m.group(1)) if m else None


def parse_damage_ally_to_summon(card: dict):
    """Pampactus #218: "Infligez N dégât à une invocation alliée pour l'invoquer". The summon's
    APPARITION picks an allied creature and deals N to it (a summon cost). Like Padgref,
    but on a creature instead of a Dofus. Returns N (giving DamageAllyToSummon
    {amount:N} on the APPARITION and dropping the unused single-target bindata
    DamageData), or None."""
    if card.get("cardType") != "Summon":
        return None
    s = strip_markup(card.get("description", ""))
    m = re.search(r"infligez?\s+(\d+)\s+d[ée]g[âa]ts?\s+à\s+une\s+invocation\s+alli[ée]e\s+pour\s+l['’]invoquer", s)
    return int(m.group(1)) if m else None


def parse_sacrifice_for_damage(card: dict):
    """Sacrifice #576: "Sacrifiez une de vos invocations pour infliger autant de dégâts qu'elle a
    d'AT à une autre invocation" → a two-step SacrificeForDamage spell (the bindata DamageData
    carries a PrimaryTargetCurrentAttackValue we cannot model as a flat amount). Returns the effects
    list or None."""
    if card.get("cardType") != "Spell":
        return None
    s = strip_markup(card.get("description", ""))
    if not re.search(r"sacrifiez?\s+une\s+de\s+vos\s+invocations\s+pour\s+infliger\s+autant\s+de\s+d[ée]g[âa]ts?", s, re.I):
        return None
    return [{"type": "SacrificeForDamage", "_authored": True}]


def parse_lame_emoussee(card: dict):
    """Lame Émoussée #1177: "Inflige N dégât à une invocation alliée pour infliger M dégâts à une
    invocation adverse blessée" → a two-step LameEmoussee {self:N, enemy:M} spell (the bindata is
    two stranded DamageData the flat path cannot pair to two targets). Returns effects or None."""
    if card.get("cardType") != "Spell":
        return None
    s = strip_markup(card.get("description", ""))
    m = re.search(r"inflige\s+(\d+)\s+d[ée]g[âa]ts?\s+à\s+une\s+invocation\s+alli[ée]e\s+pour\s+infliger\s+(\d+)\s+d[ée]g[âa]ts?\s+à\s+une\s+invocation\s+adverse\s+bless[ée]e", s, re.I)
    if not m:
        return None
    return [{"type": "LameEmoussee", "self": int(m.group(1)), "enemy": int(m.group(2)), "_authored": True}]


def parse_destroy_armor_for_damage(card: dict):
    """Pluie de Météorites #1350: "Détruisez l'AR d'une invocation alliée pour infliger autant de
    dégâts à une autre invocation. Piochez une carte." → a two-step DestroyArmorForDamage spell
    (the bindata DamageData{PrimaryTargetCurrentArmorValue} cannot be modelled as a flat amount).
    Returns the effects list or None."""
    if card.get("cardType") != "Spell":
        return None
    s = strip_markup(card.get("description", ""))
    if not re.search(r"d[ée]truisez?\s+l['’]?\s*ar\s+d['’]une\s+invocation\s+alli[ée]e\s+pour\s+infliger\s+autant\s+de\s+d[ée]g[âa]ts?", s, re.I):
        return None
    eff = {"type": "DestroyArmorForDamage", "_authored": True}
    if re.search(r"piochez?\s+une\s+carte", s, re.I):
        eff["draw"] = 1
    return [eff]


def parse_attaque_naturelle(card: dict):
    """Attaque Naturelle #1012: "Vos invocations avec de l'AR infligent @damage@ au Dofus adverse
    de leur ligne." → a global DamageDofusPerArmoredAlly {amount:N} (each armoured ally hits the
    enemy Dofus on its row). N = the bindata DamageData (the @damage@). Returns effects or None."""
    if card.get("cardType") != "Spell":
        return None
    s = strip_markup(card.get("description", ""))
    if not re.search(r"vos\s+invocations\s+avec\s+de\s+l['’]?\s*ar\s+infligent.*au\s+dofus\s+adverse\s+de\s+leur\s+ligne", s, re.I):
        return None
    amt = 1
    for e in card.get("effects", []):
        if e.get("type") == "DamageData" and isinstance(e.get("Damage"), int):
            amt = e["Damage"]; break
        if e.get("type") == "DamageDofusPerArmoredAlly" and isinstance(e.get("amount"), int):
            amt = e["amount"]; break
    return [{"type": "DamageDofusPerArmoredAlly", "amount": amt, "_authored": True}]


def parse_sacrifice_veritable(card: dict):
    """Sacrifice Véritable #861: "Inflige aux invocations en jeu autant de dégâts qu'elles ont d'AT"
    (DamageData{TargetCurrentAttackValue}) → DamageAllByOwnAttack. Returns effects or None."""
    if card.get("cardType") != "Spell":
        return None
    s = strip_markup(card.get("description", ""))
    if not re.search(r"inflige\s+aux\s+invocations\s+en\s+jeu\s+autant\s+de\s+d[ée]g[âa]ts?\s+qu['’]elles?\s+ont", s, re.I):
        return None
    return [{"type": "DamageAllByOwnAttack", "_authored": True}]


def parse_tofu_explosif(card: dict):
    """Tofu Explosif #155 (MORT): "Inflige aux invocations adverses autant de dégâts que de Tofus
    alliés en jeu" (DamageData{NumberOfSummonWithDyingValue, fam Tofu}) → DamageEnemiesByFamilyCount."""
    if card.get("cardType") != "Summon":
        return None
    s = strip_markup(card.get("description", ""))
    if not re.search(r"inflige\s+aux\s+invocations\s+adverses\s+autant\s+de\s+d[ée]g[âa]ts?\s+que\s+de\s+tofus\s+alli[ée]s", s, re.I):
        return None
    return [{"type": "DamageEnemiesByFamilyCount", "family": "Tofu", "per": 1, "excludeSelf": True, "_authored": True}]


def parse_nox(card: dict):
    """Nox #353 (MORT): "Inflige aux invocations adverses autant de dégâts que vous avez de PA dans
    votre réserve. Dépense tous les PA de votre réserve." → DamageEnemiesByReserve."""
    if card.get("cardType") != "Summon":
        return None
    s = strip_markup(card.get("description", ""))
    if not re.search(r"inflige\s+aux\s+invocations\s+adverses\s+autant\s+de\s+d[ée]g[âa]ts?\s+que\s+vous\s+avez\s+de\s+pa\s+dans\s+votre\s+r[ée]serve", s, re.I):
        return None
    return [{"type": "DamageEnemiesByReserve", "per": 1, "_authored": True}]


def parse_sacrifice_poupesque(card: dict):
    """Sacrifice Poupesque #89 (Sadida, global): "Sur chaque ligne, inflige à la 1ère invocation ou
    Dofus adverse des dégâts égaux à N fois le nombre de vos poupées sur la ligne puis les détruit."
    (DamageData{NumberOfSummonInTargetRowValue}) → SacrificePoupesque {family:"Doll", per:N}."""
    if card.get("cardType") != "Spell":
        return None
    s = strip_markup(card.get("description", ""))
    if not re.search(r"sur\s+chaque\s+ligne.*1[èe]re\s+invocation\s+ou\s+dofus\s+adverse.*poup[ée]es", s, re.I):
        return None
    m = re.search(r"(\d+)\s+fois\s+le\s+nombre\s+de\s+vos\s+poup[ée]es", s, re.I)
    return [{"type": "SacrificePoupesque", "family": "Doll", "per": int(m.group(1)) if m else 2, "_authored": True}]


def parse_dargone(card: dict):
    """Dargone #1291: "chaque fois qu'un allié est soigné, réduit de N l'AT de la
    première invocation adverse de sa ligne ayant au moins M AT" gives
    ReduceFirstEnemyAtOnAllyHeal {amount:N, minAt:M}."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"chaque\s+fois\s+qu['’]un\s+alli[ée]\s+est\s+soign[ée].*r[ée]duit\s+de\s+(\d+)\s+l['’\s]*at\s+de\s+la\s+premi[èe]re\s+invocation\s+adverse.*ayant\s+au\s+moins\s+(\d+)\s+at", s)
    if not m:
        return None
    return {"type": "ReduceFirstEnemyAtOnAllyHeal", "amount": int(m.group(1)), "minAt": int(m.group(2)), "_authored": True}


def parse_buff_family_on_bounce(card: dict):
    """Araknoplasme #416: "donne +N AT et +M AR à vos <famille> quand une invocation sur
    le terrain remonte en main" gives BuffFamilyOnBounce {family, attack:N, armor:M}."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"donne\s+\+(\d+)\s+at\s+et\s+\+(\d+)\s+ar\s+[àa]\s+vos\s+(\w+?)s?\s+quand\s+une\s+invocation\s+sur\s+le\s+terrain\s+remonte\s+dans\s+la\s+main", s)
    if not m:
        return None
    fam = family_by_lower.get(m.group(3).lower())
    if not fam:
        return None
    return {"type": "BuffFamilyOnBounce", "family": fam, "attack": int(m.group(1)), "armor": int(m.group(2)), "_authored": True}


def parse_encablure(card: dict):
    """Encablure #1100: "les invocations adverses coûtent N PA de plus si vous avez au
    moins M PA dans votre réserve" gives CardCostAura {enemy, scope:summon, amount:N,
    requireReserve:M} (a cost aura that depends on the caster's reserve)."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"les\s+invocations\s+adverses\s+co[ûu]tent\s+(\d+)\s+pa\s+de\s+plus\s+si\s+vous\s+avez\s+au\s+moins\s+(\d+)\s+pa\s+dans\s+votre\s+r[ée]serve", s)
    if not m:
        return None
    return {"type": "CardCostAura", "enemy": True, "scope": "summon", "amount": int(m.group(1)), "requireReserve": int(m.group(2)), "_authored": True}


def parse_retour_baton(card: dict):
    """Retour Du Bâton #1640 (castTarget AnyDofus): "coûte N PA de moins par glyphe allié
    en jeu. Détruit un dofus et vos glyphes" gives [CostPerGlyph {per:N}, DestroyDofus,
    DestroyOwnGlyphs]. DestroyDofus hits the chosen dofus, DestroyOwnGlyphs removes the
    caster's glyphs, and CostPerGlyph lowers the cost (read by effectiveCost)."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"co[ûu]te\s+(\d+)\s+pa\s+de\s+moins\s+par\s+glyphe\s+alli[ée].*d[ée]truit\s+un\s+dofus\s+et\s+vos\s+glyphes", s)
    if not m:
        return None
    return [
        {"type": "CostPerGlyph", "per": int(m.group(1)), "_authored": True},
        {"type": "DestroyDofus", "_authored": True},
        {"type": "DestroyOwnGlyphs", "_authored": True},
    ]


def parse_nullify_family_move(card: dict):
    """Roi des Truches #282: "annule les compétences de changement de ligne et de
    propriétaire de vos <famille>" gives NullifyFamilyMovePowers {family} (a passive
    marker read by the ChangeRowSelf and GiveSelfToOpponent handlers)."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"annule\s+les\s+comp[ée]tences\s+de\s+changement\s+de\s+ligne\s+et\s+de\s+propri[ée]taire\s+de\s+vos\s+(\w+?)s?\b", s)
    if not m:
        return None
    fam = family_by_lower.get(m.group(1).lower())
    if not fam:
        return None
    return {"type": "NullifyFamilyMovePowers", "family": fam, "_authored": True}


def parse_recover_on_dofus_kill(card: dict):
    """Héros Félin #1156: "remonte dans votre main s'il détruit un dofus. Il coûte
    désormais N PA" gives RecoverToHandOnDofusKill {cost:N} (a passive marker read when
    deaths are resolved: after breaking through, it goes back to its owner's hand at
    cost N)."""
    s = strip_markup(card.get("description", ""))
    if not re.search(r"remonte\s+dans\s+votre\s+main\s+s['’]il\s+d[ée]truit\s+un\s+dofus", s):
        return None
    m = re.search(r"co[ûu]te\s+d[ée]sormais\s+(\d+)\s+pa", s)
    return {"type": "RecoverToHandOnDofusKill", "cost": int(m.group(1)) if m else 0, "_authored": True}


def parse_lethal_melee(card: dict):
    """Masse #207: "les invocations qu'il blesse meurent si vous avez un autre <famille>
    en jeu" gives LethalMeleeIfFamily {family} (a passive top-level marker, read during
    melee combat)."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"les\s+invocations\s+qu['’]il\s+blesse\s+meurent\s+si\s+vous\s+avez\s+un\s+autre\s+(\w+)\s+en\s+jeu", s)
    if not m:
        return None
    fam = family_by_lower.get(m.group(1).lower())
    if not fam:
        return None
    return {"type": "LethalMeleeIfFamily", "family": fam, "_authored": True}


def parse_shooter_second_attack(card: dict):
    """Cléophée #28/#755/#845: "attaque une deuxième fois après un combat si un autre
    membre allié de la Confrérie du Tofu est en jeu" gives ShooterSecondAttack {family}
    (a passive top-level marker, read during the advance phase; it sits next to the
    ShooterRangeData of the PORTÉE). The "Confrérie du Tofu" family is
    BrotherhoodOfTheTofu."""
    s = strip_markup(card.get("description", ""))
    m = re.search(
        r"attaque\s+une\s+deuxi[èe]me\s+fois\s+apr[èe]s\s+un\s+combat\s+si\s+un\s+autre\s+membre\s+alli[ée]\s+de\s+la\s+(.+?)\s+est\s+en\s+jeu",
        s,
    )
    if not m:
        return None
    fam = TUTOR_SPECIAL.get(m.group(1).strip().lower()) or family_by_lower.get(m.group(1).strip().lower())
    if not fam:
        return None
    return {"type": "ShooterSecondAttack", "family": fam, "_authored": True}


def parse_escompte(card: dict):
    """Escompte #1629 : « place les cartes <god> de votre main dans votre pioche, celle-ci
    comprise. Piochez autant de cartes » → RecycleGodDrawAny {god} (god = celui de la carte
, « cartes srams » = god Sram)."""
    s = strip_markup(card.get("description", ""))
    if not re.search(r"place\s+les\s+cartes\s+\w+?s?\s+de\s+votre\s+main\s+dans\s+votre\s+pioche.*piochez\s+autant", s):
        return None
    god = card.get("god")
    if not god or god == "None":
        return None
    return {"type": "RecycleGodDrawAny", "god": god, "_authored": True}


def parse_roll_reaction(card: dict):
    """Cards that react to each allied dice or coin roll: Sentinelle Affûtée #1606
    "gagne +N AT et +M AR" (board buff); Atout Caché #1201 "coûte N PA de moins"
    (back in hand). Gives RollReaction {attack?, armor?, handCost?}."""
    s = strip_markup(card.get("description", ""))
    if not re.search(r"[àa]\s+chaque\s+lancer\s+de\s+d[ée]\s+ou\s+de\s+pi[èe]ce", s):
        return None
    out = {}
    mb = re.search(r"gagne\s+\+(\d+)\s+at\s+et\s+\+(\d+)\s+ar", s)
    if mb:
        out["attack"] = int(mb.group(1))
        out["armor"] = int(mb.group(2))
    mc = re.search(r"co[ûu]te\s+(\d+)\s+pa\s+de\s+moins", s)
    if mc:
        out["handCost"] = -int(mc.group(1))
    if not out:
        return None
    return {"type": "RollReaction", **out, "_authored": True}


def parse_activated_trap_aura(card: dict):
    """Héroïne Perfide #1254: "tant qu'elle est en jeu, les pièges activés de la main
    adverse coûtent N PA de plus et infligent M dégât supplémentaire" gives
    ActivatedTrapAura {costTax:N, damageBonus:M} (a passive marker read by effectiveCost
    and when a trap goes off)."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"pi[èe]ges\s+activ[ée]s\s+de\s+la\s+main\s+adverse\s+co[ûu]tent\s+(\d+)\s+pa\s+de\s+plus\s+et\s+infligent\s+(\d+)\s+d[ée]g[âa]t", s)
    if not m:
        return None
    return {"type": "ActivatedTrapAura", "costTax": int(m.group(1)), "damageBonus": int(m.group(2)), "_authored": True}


def parse_family_death_seed(card: dict):
    """Nenufar #821: "tant qu'elle est en jeu, vos autres <famille> se transforment en
    graines quand ils meurent" gives AllyFamilyDeathSeed {family} (a passive top-level
    marker, read when deaths are resolved; it puts a Graine on the dead creature's cell)."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"tant\s+qu['’]elle\s+est\s+en\s+jeu,?\s+vos\s+autres\s+(\w+?)s?\s+se\s+transforment\s+en\s+graines?\s+quand\s+ils?\s+meurent", s)
    if not m:
        return None
    fam = family_by_lower.get(m.group(1).lower())
    if not fam:
        return None
    return {"type": "AllyFamilyDeathSeed", "family": fam, "_authored": True}


def parse_horloge_sinistro(card: dict):
    """Horloge #442: "récupère un sort Sinistro de votre défausse" ("sort Sinistro" means
    card #215 only) gives RecoverFromDiscard {cardId:215} (one copy of #215 goes from the
    caster's discard to the hand)."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"r[ée]cup[èe]re\s+un\s+sort\s+sinistro\s+de\s+votre\s+d[ée]fausse", s):
        return {"type": "RecoverFromDiscard", "cardId": 215, "_authored": True}
    return None


def parse_chasseur_draw(card: dict):
    """Chasseur #245: "piochez 1 carte. elle coûte 0 PA si c'est une invocation, sinon
    défaussez-la" gives DrawSummonFreeElseDiscard (draws the top card; a Summon goes to
    the hand at cost 0, anything else to the discard)."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"piochez\s+1\s+carte.*co[ûu]te\s+0\s+pa\s+si\s+c['’]est\s+une\s+invocation.*sinon\s+d[ée]faussez", s):
        return {"type": "DrawSummonFreeElseDiscard", "_authored": True}
    return None


def parse_enfouissement(card: dict):
    """Enfouissement #684: "ciblez une invocation, quand elle meurt elle se place sur
    la pioche de son propriétaire" gives SetProperty {property: DeckOnDeath}: the target
    is marked and, when it dies, goes to the bottom of its owner's deck instead of the
    discard."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"ciblez\s+une\s+invocation.*quand\s+elle\s+meurt\s+elle\s+se\s+place\s+sur\s+la\s+pioche\s+de\s+son\s+propri[ée]taire", s):
        return {"type": "SetProperty", "property": "DeckOnDeath", "_authored": True}
    return None


def parse_swap_two_dofus(card: dict):
    """Bluff #61: "échange la position de 2 de vos dofus" gives SwapTwoDofus (two steps:
    the first pick is an allied dofus via castTarget AlliedDofus, the second pick is
    another allied dofus)."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"[ée]change\w*\s+la\s+position\s+de\s+2\s+de\s+vos\s+dofus", s):
        return {"type": "SwapTwoDofus", "_authored": True}
    return None


def parse_teleglyphe(card: dict):
    """Téléglyphe #1735: "téléportez une invocation sur un glyphe allié" gives TeleportToGlyph
    (two steps: pick a creature [castTarget AnySummon], then an allied glyph cell). The
    teleport triggers the glyph, so a Féca gains armour there."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"t[ée]l[ée]portez\s+une\s+invocation\s+sur\s+un\s+glyphe\s+alli[ée]", s):
        return {"type": "TeleportToGlyph", "_authored": True}
    return None


def parse_teleport_to_cell(card: dict):
    """Ralenti #119: "téléporte une invocation située dans votre camp sur une case de
    votre camp" gives TeleportToCell (two steps: pick an allied creature, then a cell of
    the camp)."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"t[ée]l[ée]porte\s+une\s+invocation\s+situ[ée]e\s+dans\s+votre\s+camp\s+sur\s+une\s+case\s+de\s+votre\s+camp", s):
        return {"type": "TeleportToCell", "_authored": True}
    return None


def parse_add_reserve(card: dict):
    """ "Ajoute N PA à votre réserve" (Brûlure Temporelle #93, on top of its @damage@) gives
    AddReserve {amount:N, side:"caster"}. Most cards that fill the reserve have the effect
    in their bindata; the reserve clause of #93 only exists in the description. Rejects
    "... à la réserve adverse" (enemy side, not handled). Returns the effect or None."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"ajoute\s+(\d+)\s*pa\s+[àa]\s+votre\s+r[ée]serve", s)
    if not m:
        return None
    return {"type": "AddReserve", "amount": int(m.group(1)), "side": "caster", "_authored": True}


def parse_sacrifice_for_reserve(card: dict):
    """Cycle du Temps #1460: "sacrifiez une de vos invocations pour ajouter son coût de
    PA à votre réserve" gives SacrificeForReserve (pick an allied creature; it is
    destroyed and its printed cost is added to the reserve)."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"sacrifiez\s+une\s+de\s+vos\s+invocations\s+pour\s+ajouter\s+son\s+co[ûu]t\s+de\s+pa\s+[àa]\s+votre\s+r[ée]serve", s):
        return {"type": "SacrificeForReserve", "_authored": True}
    return None


def parse_bounce_column(card: dict):
    """#1269: "remonte les invocations d'une rangée dans la main de leur propriétaire"
    gives BounceColumn (targeted: every creature of the targeted column goes back to
    its owner's hand)."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"remonte\s+les\s+invocations\s+d['’]une\s+rang[ée]e\s+dans\s+la\s+main\s+de\s+leur\s+propri[ée]taire", s):
        return {"type": "BounceColumn", "_authored": True}
    return None


def parse_spend_reserve_charge(card: dict):
    """Sablier du Xélor #376: "dépense tous les PA de votre réserve. vos invocations
    chargent d'autant de cases" gives SpendReserveCharge (empties the reserve and all
    your creatures charge by the amount spent)."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"d[ée]pense\s+tous\s+les\s+pa\s+de\s+votre\s+r[ée]serve.*invocations\s+chargent\s+d['’]autant", s):
        return {"type": "SpendReserveCharge", "_authored": True}
    return None


def parse_bounce_closest_row(card: dict):
    """Championne du Blasphème #1451: "remonte dans la main de son propriétaire la
    première invocation de sa ligne si vous êtes en sous nombre" gives BounceClosestOnRow
    {requireCondition: outnumbered} (the closest creature on the row goes back to hand)."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"remonte\s+dans\s+la\s+main\s+de\s+son\s+propri[ée]taire\s+la\s+premi[èe]re\s+invocation\s+de\s+sa\s+ligne", s):
        eff = {"type": "BounceClosestOnRow", "_authored": True}
        if re.search(r"si\s+vous\s+[êe]tes\s+en\s+sous[\s-]*nombre", s):
            eff["requireCondition"] = {"kind": "outnumbered"}
        return eff
    return None


def parse_tutor_copy_target(card: dict):
    """Wabbit en Chocolat #733: "place dans votre main une copie de la cible si elle se
    trouve dans votre pioche" gives TutorCopyOfTarget (targeted: draws a copy of the
    targeted card from the deck)."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"place\s+dans\s+votre\s+main\s+une\s+copie\s+de\s+la\s+cible\s+si\s+elle\s+se\s+trouve\s+dans\s+votre\s+pioche", s):
        return {"type": "TutorCopyOfTarget", "_authored": True}
    return None


def parse_copy_family(card: dict):
    """Pupuce #441: "APPARITION : devient de la famille de l'invocation ciblée" gives
    CopyFamilyFromTarget (targeted: the source replaces its families with the target's)."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"devient\s+de\s+la\s+famille\s+de\s+l['’]invocation\s+cibl[ée]e", s):
        return {"type": "CopyFamilyFromTarget", "_authored": True}
    return None


def parse_shuffle_dofus(card: dict):
    """Guy #274: "échange aléatoirement les positions des dofus pour chaque joueur"
    gives ShuffleDofus (for each camp, a random permutation of the living dofus positions)."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"[ée]change\w*\s+al[ée]atoirement\s+les\s+positions\s+des\s+dofus", s):
        return {"type": "ShuffleDofus", "_authored": True}
    return None


def parse_move_row_dofus(card: dict):
    """Ush #100: "déplacez le dofus allié de sa ligne sur la position d'un dofus allié
    détruit" gives MoveRowDofus (targeted: the allied dofus on the source's row moves to
    the clicked cell, where an allied dofus was destroyed)."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"d[ée]placez\s+le\s+dofus\s+alli[ée]\s+de\s+sa\s+ligne\s+sur\s+la\s+position\s+d['’]un\s+dofus\s+alli[ée]\s+d[ée]truit", s):
        return {"type": "MoveRowDofus", "_authored": True}
    return None


def parse_swap_dofus(card: dict):
    """Ush #426 (allied) / #13 (enemy): "échangez la position du dofus <allié|adverse>
    de sa ligne avec celle d'un autre dofus <allié|adverse>" gives SwapDofus {side}
    (targeted: the Dofus of camp `side` on the source's row swaps cells with the
    targeted Dofus)."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"[ée]changez\s+la\s+position\s+du\s+dofus\s+alli[ée]\s+de\s+sa\s+ligne\s+avec\s+celle\s+d['’]un\s+autre\s+dofus\s+alli[ée]", s):
        return {"type": "SwapDofus", "side": "ally", "_authored": True}
    if re.search(r"[ée]changez\s+la\s+position\s+du\s+dofus\s+adverse\s+de\s+sa\s+ligne\s+avec\s+celle\s+d['’]un\s+autre\s+dofus\s+adverse", s):
        return {"type": "SwapDofus", "side": "enemy", "_authored": True}
    return None


def parse_objects_to_bombs(card: dict):
    """Kaotika #612: "transforme les graines, les butins, les glyphes et les tas d'os
    en bombes alliées" gives TransformObjectsToTraps {cardId:101 (Bombe), damage:2}."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"transforme\s+les\s+graines.*butins.*glyphes.*tas\s+d['’]os\s+en\s+bombes", s):
        return {"type": "TransformObjectsToTraps", "cardId": 101, "damage": 2, "_authored": True}
    return None


def parse_place_bombe(card: dict):
    """Remington Smisse #178/#334 (MORT): "Dépose N Bombe(s) sur sa case" (#178, count 1,
    placement self) / "Dépose 2 Bombes autour de lui" (#334, count 2, placement around)
    give PlaceBombe {count, placement}. A MORT player-state effect: it places Bombe traps
    (cardId 101, 2 damage) belonging to the source's camp. Returns the effect dict or None."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"d[ée]pose\s+(\d+)\s+bombes?\s+(sur\s+sa\s+case|autour\s+de\s+lui)", s)
    if not m:
        return None
    count = int(m.group(1))
    placement = "around" if "autour" in m.group(2) else "self"
    return {"type": "PlaceBombe", "count": count, "placement": placement, "_authored": True}


def parse_destroy_board_object(card: dict):
    """Tournesol Sauvage #1082: "détruisez une graine, une bombe, un butin, un glyphe
    ou un tas d'os en jeu" gives DestroyBoardObject (targeted: removes the targeted
    board object)."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"d[ée]truisez\s+une\s+graine.*butin.*glyphe.*tas\s+d['’]os", s):
        return {"type": "DestroyBoardObject", "_authored": True}
    return None


def parse_setattack_charge(card: dict):
    """Justice #130: "passez à N l'AT d'une invocation, elle charge de M cases" gives a
    targeted [SetAttack {value:N}, Charge {cells:M}] (the picked creature has its AT set
    to N, then charges M cells; resolvePendingAction runs the charge at once)."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"passez?\s+[àa]\s+(\d+)\s+l['’\s]*at\s+d['’]une\s+invocation.*?charge\s+de\s+(\d+)\s+cases?", s)
    if not m:
        return None
    return [{"type": "SetAttack", "value": int(m.group(1)), "_authored": True},
            {"type": "Charge", "cells": int(m.group(2)), "_authored": True}]


def parse_move_adjacent_row(card: dict):
    """Larve Verte #139: "déplacez une invocation [ayant N AT ou moins] sur une ligne
    adjacente aléatoirement" gives a targeted MoveAdjacentRowRandom {maxAttack:N} (the
    pick is filtered by maxAttack; the engine moves the target to a random free
    adjacent row)."""
    s = strip_markup(card.get("description", ""))
    if not re.search(r"d[ée]place\w*\s+une\s+invocation.*ligne\s+adjacente.*al[ée]atoire", s):
        return None
    eff = {"type": "MoveAdjacentRowRandom", "_authored": True}
    m = re.search(r"ayant\s+(\d+)\s+at\s+ou\s+moins", s)
    if m:
        eff["maxAttack"] = int(m.group(1))
    return eff


def parse_spend_reserve_buff(card: dict):
    """Synchroniseur #714: "dépense N PA de votre réserve pour donner +A AT et +B AR à
    vos autres <dieu>" gives [AddReserve {-N}, BoostAttack/BoostArmor {scope:allies, god,
    excludeSelf}], all of them guarded by requireCondition reserveAtLeast:N (otherwise
    nothing happens)."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"d[ée]pense\w*\s+(\d+)\s+pa\s+de\s+votre\s+r[ée]serve\s+pour\s+donner\s+(.+?)\s+[àa]\s+vos\s+autres\s+(\w+?)s?\b", s)
    if not m:
        return None
    god = god_by_lower.get(_deaccent(m.group(3).lower()))
    if not god:
        return None
    n = int(m.group(1))
    cond = {"kind": "reserveAtLeast", "value": n}
    effs = [{"type": "AddReserve", "amount": -n, "requireCondition": dict(cond), "_authored": True}]
    for amt, stat in re.findall(r"\+?(\d+)\s*(at|ar)\b", m.group(2)):
        et = {"at": "BoostAttack", "ar": "BoostArmor"}[stat]
        effs.append({"type": et, "scope": "allies", "god": god, "excludeSelf": True,
                     "amount": int(amt), "requireCondition": dict(cond), "_authored": True})
    return effs if len(effs) > 1 else None


def parse_control_around(card: dict):
    """Miranda #107: "prenez le contrôle des invocations adverses autour d'elle tant
    qu'elle est en jeu" gives ControlAround (AoE on the 8 cells around, reverted when
    the source leaves)."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"pren\w+\s+le\s+contr[ôo]le\s+des\s+invocations\s+adverses\s+autour\s+d['’]elle", s):
        return {"type": "ControlAround", "_authored": True}
    return None


def parse_coupdegrace_defect(card: dict):
    """Truche Foldingue #434: "COUP DE GRÂCE : 50% de chances de changer de
    propriétaire" gives CoinFlip {pile:[GiveSelfToOpponent], face:[]} on COUP_DE_GRACE
    (50%: the Truche moves to the enemy camp for good)."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"50\s*%\s+de\s+chances?\s+de\s+changer\s+de\s+propri[ée]taire", s):
        return {"type": "CoinFlip", "pile": [{"type": "GiveSelfToOpponent", "_authored": True}], "face": [], "_authored": True}
    return None


def parse_discard_random_hand(card: dict):
    """ "Défausse(z) N carte(s) aléatoire(s) de votre/sa main" (Phorzerker #357) →
    DiscardRandomHand {amount:N}."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"d[ée]fauss\w*\s+(\d+|une?)\s+cartes?\s+al[ée]atoires?\s+de\s+(?:votre|sa)\s+main", s)
    if not m:
        return None
    n = 1 if m.group(1) in ("un", "une") else int(m.group(1))
    return {"type": "DiscardRandomHand", "amount": n, "_authored": True}


def parse_grab_butin(card: dict):
    """ "Ramassez N butin(s)" (Snouffle #225) gives GrabButin {amount:N}. ("ramasse TOUS
    les butins" is Bernalette/GrabAllButins, not matched here since "tous" is not a number.)"""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"ramasse[zr]?\s+(\d+|une?)\s+butins?", s)
    if not m:
        return None
    n = 1 if m.group(1) in ("un", "une") else int(m.group(1))
    return {"type": "GrabButin", "amount": n, "_authored": True}


def parse_conditional_draw_handsize(card: dict):
    """ "Piochez N carte(s) si vous avez moins de M cartes en main" (Kamasutar #92) gives
    DrawCards {amount:N, condition:{kind:"handBelow", value:M}} (the condition is checked
    when the trigger fires, by dropUnmetConditions, after the card has left the hand)."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"piochez\s+(\d+|une?)\s+cartes?\s+si\s+vous\s+avez\s+moins\s+de\s+(\d+)\s+cartes?\s+en\s+main", s)
    if not m:
        return None
    n = 1 if m.group(1) in ("un", "une") else int(m.group(1))
    return {"type": "DrawCards", "amount": n, "requireCondition": {"kind": "handBelow", "value": int(m.group(2))}, "_authored": True}


def parse_return_own_to_hand(card: dict):
    """ "Remontez une de vos invocations dans votre main" (Arakne Albinos #260) gives
    ReturnToHand {pickSide:"ally"} (the pick is limited to the caster's camp)."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"remonte[zr]?\s+une?\s+de\s+vos\s+invocations?\s+dans\s+votre\s+main", s):
        return {"type": "ReturnToHand", "pickSide": "ally", "_authored": True}
    return None


def parse_place_token_camp(card: dict):
    """ "Placez un(e) <token> dans votre camp" (Gwand Pa Wabbit #143: cawotte, a wall)
    gives SummonToken {tokenId, amount:1, placement:"campChoose"} (the player picks a
    free cell of their camp). Only matches when <token> resolves to a summonable token."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"place[zr]?\s+une?\s+(.+?)\s+dans\s+votre\s+camp", s)
    if not m:
        return None
    tid = summon_name_index.get(norm_name(m.group(1).strip()))
    if tid is None:
        return None
    return {"type": "SummonToken", "tokenId": tid, "amount": 1, "placement": "campChoose", "_authored": True}


def parse_sacrifice_dofus_draw(card: dict):
    """ "Sacrifiez un de vos dofus pour piocher N cartes" (Refus de Mort #248) gives
    [DestroyDofus (the targeted dofus, castTarget AlliedDofusWithoutInvulnerable),
    DrawCards N]. Spell."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"sacrifiez\s+un\s+de\s+vos\s+dofus\s+pour\s+piocher\s+(\d+|une?)\s+cartes?", s)
    if not m:
        return None
    n = 1 if m.group(1) in ("un", "une") else int(m.group(1))
    return [{"type": "DestroyDofus", "_authored": True}, {"type": "DrawCards", "amount": n, "_authored": True}]


def parse_reactive_charge(card: dict):
    """ "<reactive trigger> : charge de N case(s)" (Coppa le Copain #1048, MORT ADVERSE)
    gives ChargeSelf {cells:N} on that trigger. Leaves out APPARITION (which uses the
    SelfCharge marker) and the "charge ... quand ..." cases already handled (ON_PLAY Lilotte)."""
    s = strip_markup(card.get("description", ""))
    k = detect_trigger_kind(s)
    if not k or k == "APPARITION":
        return None
    m = re.search(r"charge\s+de\s+(\d+)\s+cases?", s)
    if not m:
        return None
    return {"type": "ChargeSelf", "cells": int(m.group(1)), "_authored": True}


def parse_steal_reserve_amount(card: dict):
    """ "Vole N PA de la réserve adverse [et l'ajoute à la vôtre]" (Noxine #392) gives
    StealReserve {amount:N}. ("vole TOUS les PA" is StealReserve with no amount, not
    matched here since "tous" is not a number.)"""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"vole\s+(\d+)\s*pa\s+de\s+la\s+r[ée]serve\s+adverse", s)
    if not m:
        return None
    return {"type": "StealReserve", "amount": int(m.group(1)), "_authored": True}


def parse_self_count_others(card: dict):
    """ "Gagne autant d'AT/AR/PM que vous avez d'AUTRES <famille> alliés en jeu"
    (Scarabruni #297) gives a self Boost{stat} {amount:{count:{scope:allies, family,
    excludeSelf:true}, per:1}}. The trigger is detected where the effect is injected."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"gagne\s+autant\s+d.{0,2}\s*(at|ar|pm)\b\s+que\s+vous\s+avez\s+d['’]autres\s+(\w+?)s?\s+alli", s)
    if not m:
        return None
    sel = map_tutor_filter(_deaccent(m.group(2)))
    if not (sel and "family" in sel):
        return None
    et = {"at": "BoostAttack", "ar": "BoostArmor", "pm": "BoostMovement"}[m.group(1)]
    return {"type": et, "amount": {"count": {"scope": "allies", "family": sel["family"], "excludeSelf": True}, "per": 1}, "self": True, "_authored": True}


def parse_self_count_hand(card: dict):
    """Mitaine #551: "gagne autant d'AT/AR/PM que vous avez de cartes en main" gives a
    self Boost{stat} {amount:{type:"HandSizeValue", per:1}} (resolved against the
    caster's hand size when the trigger fires)."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"gagne\s+autant\s+d.{0,2}\s*(at|ar|pm)\b\s+que\s+(?:vous\s+avez\s+de\s+)?cartes?\s+en\s+main", s)
    if not m:
        return None
    et = {"at": "BoostAttack", "ar": "BoostArmor", "pm": "BoostMovement"}[m.group(1)]
    return {"type": et, "amount": {"type": "HandSizeValue", "per": 1}, "self": True, "_authored": True}


def parse_set_movement_count(card: dict):
    """Maine Cooyne #1579: "change ses PM pour qu'ils soient égaux au nombre de
    <famille> alliés en jeu" gives SetMovement {self:true, value:{count:{scope:allies,
    family}}} (the caster's PM is set to the number of allies of that family)."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"change\s+ses\s+pm\s+pour\s+qu['’]ils\s+soient\s+[ée]gaux\s+au\s+nombre\s+de\s+(\w+?)s?\s+alli[ée]s?\s+en\s+jeu", s)
    if not m:
        return None
    sel = map_tutor_filter(_deaccent(m.group(1)))
    if not (sel and "family" in sel):
        return None
    return {"type": "SetMovement", "self": True, "value": {"count": {"scope": "allies", "family": sel["family"]}}, "_authored": True}


def parse_transform_family_pick(card: dict):
    """ "Transformez un de vos <famille> en <token>" (Wa Wabbit #59, wabbits into Wobot;
    #770, enutrofs into Phorzerker) gives a targeted Transform {tokenId, pickFamily}
    (pick an ally of that family)."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"transform\w+\s+un\s+de\s+vos\s+(\w+?)s?\s+en\s+(.+?)(?:\.|$)", s)
    if not m:
        return None
    fam = map_tutor_filter(_deaccent(m.group(1)))
    if not (fam and "family" in fam):
        return None
    inner = m.group(2).strip()
    tid = summon_name_index.get(norm_name(inner)) or summon_name_index.get(norm_name(inner.split()[0]))
    if tid is None:
        return None
    return {"type": "Transform", "tokenId": tid, "pickFamily": fam["family"], "_authored": True}


def parse_reserve_if_family(card: dict):
    """ "Ajoute N PA à votre réserve si vous avez un autre <famille> en jeu"
    (Scoreur #554) gives AddReserve {amount:N, side:caster, requireCondition:
    {allyFamilyInPlay, family, excludeSelf}}."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"ajoute\s+(\d+)\s*pa\s+[àa]\s+votre\s+r[ée]serve\s+si\s+vous\s+avez\s+un\s+autre\s+(\w+?)\s+en\s+jeu", s)
    if not m:
        return None
    sel = map_tutor_filter(_deaccent(m.group(2)))
    if not (sel and "family" in sel):
        return None
    return {"type": "AddReserve", "amount": int(m.group(1)), "side": "caster",
            "requireCondition": {"kind": "allyFamilyInPlay", "family": sel["family"], "excludeSelf": True}, "_authored": True}


def parse_silence_others(card: dict):
    """ "Réduit au silence les AUTRES invocations" (Phaeris #597) gives a mass Silence
    (scope all by default) that spares the source: Silence {excludeSelf:true}."""
    s = strip_markup(card.get("description", ""))
    # "de sa ligne/rangée" (Frondeur Nimbos #1168) is a shaped silence (the source's
    # row), not a global one, so it is left out here.
    if re.search(r"ligne|rang[ée]e", s):
        return None
    if re.search(r"(?:r[ée]dui\w*\s+au\s+)?silence\s+les\s+autres\s+invocations", s):
        return {"type": "Silence", "excludeSelf": True, "_authored": True}
    return None


def parse_reduce_attack_pick(card: dict):
    """ "Réduisez de N l'AT d'une invocation ayant au moins M AT" (Pissenlion #1045)
    gives a targeted BoostAttack {amount:-N, minAttack:M} (pick a creature with at
    least M AT)."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"r[ée]dui\w*\s+de\s+(\d+)\s+l['’\s]*at\s+d['’]une\s+invocation\s+ayant\s+au\s+moins\s+(\d+)\s+at", s)
    if not m:
        return None
    return {"type": "BoostAttack", "amount": -int(m.group(1)), "minAttack": int(m.group(2)), "_authored": True}


def parse_banish_each_discard(card: dict):
    """ "Bannit les N dernières cartes parties dans la défausse de chaque joueur"
    (Phorreur Ancestral #1498) gives BanishOwnDiscard {count:N, eachPlayer:true}."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"bannit\s+(?:la\s+derni[èe]re\s+carte|les\s+(\d+)\s+derni[èe]res\s+cartes)\s+parties?\s+dans\s+la\s+d[ée]fausse\s+de\s+chaque\s+joueur", s)
    if not m:
        return None
    n = 1 if m.group(1) is None else int(m.group(1))
    return {"type": "BanishOwnDiscard", "count": n, "eachPlayer": True, "_authored": True}


def parse_buff_suicide(desc: str):
    """Mort Proche: "Confère +N AT et +M AR à une invocation. Elle meurt à la fin
    de son tour." gives a single-target buff plus a DiesAtEndOfTurn property (the
    engine kills the creature at the end of its owner's turn, after it acted with the
    buff). Returns the effect list, or None."""
    s = strip_markup(desc)
    if not re.search(r"meur\w*\s+a\s+la\s+fin\s+de\s+son\s+tour", s.replace("à", "a")):
        return None
    if not any(p in s for p in ("une invocation", "une créature", "une creature")):
        return None
    effs = []
    mat = re.search(r"\+\s*(\d+)\s*at\b", s)
    mar = re.search(r"\+\s*(\d+)\s*ar\b", s)
    if mat:
        effs.append({"type": "BoostAttack", "amount": int(mat.group(1))})
    if mar:
        effs.append({"type": "BoostArmor", "amount": int(mar.group(1))})
    if not effs:
        return None
    effs.append({"type": "SetProperty", "property": "DiesAtEndOfTurn"})
    return effs


def _parse_count_group(grp: str):
    """A '<group> en jeu' phrase → a CountSpec dict, or None.
    'invocation alliée avec portée' / '<famille> allié' / 'invocation adverse' /
    'invocation alliée blessée' …"""
    g = grp.strip()
    # Side: explicit "adverse/ennemi" → enemies, "allié(e)" → allies, otherwise
    # no qualifier ("invocation blessée en jeu") = both camps, like the engine's
    # "les invocations" convention.
    if "advers" in g or "ennemi" in g:
        scope = "enemies"
    elif "alli" in g or re.search(r"\b(vos|tes)\b", g):
        scope = "allies"  # "vos/tes invocations …" = your side
    else:
        scope = "all"
    spec = {"scope": scope}
    if "port" in g:
        spec["withRange"] = True
        return spec
    if "bless" in g:
        spec["wounded"] = True
        return spec
    if re.search(r"invocations?\s+(?:alli|advers|ennemi)", g):
        return spec  # plain "invocations alliées / adverses"
    # "[autre] membre[s] allié[s] de la <famille>" (Ruel Stroud, Confrérie du Tofu).
    # The family comes after "de la", so the generic "<famille> allié" pattern below
    # would grab "autre membre" by mistake. "autre(s)" sets excludeSelf (it does
    # nothing when read from the hand, but it keeps the meaning of the text).
    mb = re.search(r"(autres?\s+)?membres?\s+alli[ée]e?s?\s+de\s+la\s+(.+)", g)
    if mb:
        sel = map_tutor_filter(mb.group(2).strip())
        if sel and "family" in sel:
            spec["family"] = sel["family"]
            if mb.group(1):
                spec["excludeSelf"] = True
            return spec
    m = re.search(r"(.+?)\s+(?:alli[ée]e?s?|adverses?|ennemies?)\b", g)  # "<famille> allié"
    if m:
        sel = map_tutor_filter(m.group(1).strip())
        if sel and "family" in sel:
            spec["family"] = sel["family"]
            return spec
    return None


def parse_draw_per_count(desc: str):
    """ "Piochez N carte(s) pour chacune de / par <groupe>." gives a player-state
    DrawCards whose amount is a {count} CountSpec, resolved at cast against the
    matching creatures (Sang Tatoué #350 "1 carte pour chacune de vos invocations
    blessées": one draw per wounded ally). Returns the effect dict or None.
    Rejects the conditional "ou ... si" draws (handled elsewhere)."""
    s = strip_markup(desc)
    if "pioch" not in s:
        return None
    if re.search(r"\bou\b|\bsi\b", s):
        return None
    m = re.search(r"pioch\w+\s+(\d+)\s*cartes?\s+(?:pour\s+ch\w+\s+(?:de\s+)?|par\s+)(.+)", s)
    if not m:
        return None
    spec = _parse_count_group(m.group(2))
    if spec is None:
        return None
    return {"type": "DrawCards", "amount": {"count": dict(spec), "per": int(m.group(1))}, "_authored": True}


def parse_self_heal_full(desc: str):
    """ "<trigger> : Soigne ses blessures." (Alargix #494, DÉBUT DU TOUR) → a self
    HealFull on the detected trigger slot (restore the source to its max life). No
    scope/target → runTrigger applies it to the source's own cell. Returns the
    effect dict or None."""
    s = strip_markup(desc)
    if re.search(r"soigne\s+ses\s+blessures", s):
        return {"type": "HealFull", "_authored": True}
    return None


def parse_wounded_ally_buff(desc: str):
    """Oracle Offensé #1061: "Donne +N AR/AT aux invocations alliées blessées
    [et +M AT/AR si ce sont des <Famille>]." gives scoped stat buffs on wounded allies
    only (the optional second clause is also filtered to a family, the wounded members
    of that family). Returns a list of effects, or None (also when the family clause is
    present but cannot be resolved, so nothing is half authored)."""
    s = strip_markup(desc)
    if "bless" not in s or "invocations alli" not in s:
        return None
    STAT = {"ar": "BoostArmor", "at": "BoostAttack"}
    m = re.search(r"\+?(\d+)\s*(ar|at)\s+aux\s+invocations\s+alli[ée]e?s?\s+bless[ée]e?s?", s)
    if not m:
        return None
    out = [{"type": STAT[m.group(2)], "amount": int(m.group(1)),
            "scope": "allies", "wounded": True, "_authored": True}]
    if "si ce sont" in s:
        m2 = re.search(r"et\s+\+?(\d+)\s*(ar|at)\s+si\s+ce\s+sont\s+des?\s+(\w+)", s)
        if not m2:
            return None
        sel = map_tutor_filter(m2.group(3))
        if not (sel and "family" in sel):
            return None
        out.append({"type": STAT[m2.group(2)], "amount": int(m2.group(1)),
                    "scope": "allies", "wounded": True, "family": sel["family"], "_authored": True})
    return out


def parse_wounded_buff_charge(desc: str):
    """La Gerbouille #547: "Confère +N AT à vos invocations blessées puis elles
    chargent de M cases." → [BoostAttack allies wounded +N, ChargeAllies wounded
    cells M] (the same wounded ally set is buffed then charges). Returns the list
    or None."""
    s = strip_markup(desc)
    if "bless" not in s or "charg" not in s:
        return None
    m = re.search(
        r"conf[èe]re\s+\+?(\d+)\s*at\s+[àa]\s+vos\s+invocations\s+bless[ée]e?s?\s+"
        r"puis\s+elles?\s+chargent\s+de\s+(\d+)", s)
    if not m:
        return None
    return [
        {"type": "BoostAttack", "amount": int(m.group(1)), "scope": "allies", "wounded": True, "_authored": True},
        {"type": "ChargeAllies", "cells": int(m.group(2)), "wounded": True, "_authored": True},
    ]


def parse_self_cost_reduction(desc: str):
    """ "Coûte N PA de moins par <groupe> en jeu" (Raku Kapi #960 "par invocation
    alliée blessée") gives a SelfCostReduction marker (read by effectiveCost, never
    applied). Returns the effect dict or None."""
    s = strip_markup(desc)
    m = re.search(r"co[uû]te\s+(\d+)\s*pa\s+de\s+moins\s+par\s+(.+?)\s+en\s+jeu", s)
    if not m:
        return None
    spec = _parse_count_group(m.group(2))
    if spec is None:
        return None
    return {"type": "SelfCostReduction", "amount": {"count": dict(spec), "per": int(m.group(1))}, "_authored": True}


def parse_cross_draw(desc: str):
    """ "Chaque joueur pioche N carte(s) (chez son adversaire | de la pioche
    adverse)" (Echaenge #545, Bowne Piauch #408) → a CrossDraw {amount:N} (both
    players draw off the other player's deck). Returns the effect dict or None."""
    s = strip_markup(desc)
    if "chaque joueur pioche" not in s:
        return None
    if not re.search(r"chez\s+son\s+adversaire|de\s+la\s+pioche\s+advers", s):
        return None
    m = re.search(r"chaque\s+joueur\s+pioche\s+(\d+)", s)
    n = int(m.group(1)) if m else 1
    return {"type": "CrossDraw", "amount": n, "_authored": True}


def parse_steal_top_draw(desc: str):
    """ "Piochez N carte(s) chez votre adversaire, votre adversaire pioche N
    carte(s)" (Escroc #1022) → a StealTopDraw {amount:N}: you take the top of the
    opponent's deck, then the opponent draws off their own. Returns the dict or
    None."""
    s = strip_markup(desc)
    if not re.search(r"piochez?\s+\d+\s*cartes?\s+chez\s+votre\s+adversaire", s):
        return None
    if "votre adversaire pioche" not in s:
        return None
    m = re.search(r"piochez?\s+(\d+)", s)
    return {"type": "StealTopDraw", "amount": int(m.group(1)) if m else 1, "_authored": True}


def parse_mill_deck(desc: str):
    """ "Chaque joueur défausse <les N premières cartes / autant de cartes qu'il a
    d'invocations en jeu> de sa pioche" gives a MillDeck (top of the deck to the
    discard, each player on their own deck). Rituel Sram #251 is a fixed N, Gredin
    #1165 is perCreature. Returns the effect dict or None. The caster-only and
    family-filtered variant (Funérailles "Défausse 3 Srams de votre pioche") is
    handled elsewhere."""
    s = strip_markup(desc)
    if "chaque joueur" not in s or "pioche" not in s or not re.search(r"d[ée]fausse", s):
        return None
    if re.search(r"autant\s+de\s+cartes.*qu'il\s+a\s+d.invocations?\s+en\s+jeu", s):
        return {"type": "MillDeck", "perCreature": True, "both": True, "_authored": True}
    m = re.search(r"d[ée]fausse\s+les\s+(\d+)\s+premi[èe]res\s+cartes?\s+de\s+sa\s+pioche", s)
    if m:
        return {"type": "MillDeck", "amount": int(m.group(1)), "both": True, "_authored": True}
    return None


def parse_mill_deck_self(desc: str):
    """Caster-only deck mill (not "chaque joueur"): "Défausse les N premières cartes
    de votre pioche" (Pierre Tombale #512) gives MillDeck {amount:N}; "Défausse N <fam>
    de votre pioche" (Funérailles #930) gives MillDeck {amount:N, family:<fam>}.
    Returns the effect dict or None."""
    s = strip_markup(desc)
    if "votre pioche" not in s or not re.search(r"d[ée]fausse", s):
        return None
    # Leave out combo cards whose other half is not modelled yet: Second Souffle #1237
    # "Récupère les 2 dernières ... et défausse les 4 premières". Milling alone would be
    # wrong (getting cards back from the discard is the point), so it is not half authored.
    if re.search(r"r[ée]cup[èe]re", s):
        return None
    m = re.search(r"d[ée]fausse\s+les\s+(\d+)\s+premi[èe]res\s+cartes?\s+de\s+votre\s+pioche", s)
    if m:
        return {"type": "MillDeck", "amount": int(m.group(1)), "_authored": True}
    m = re.search(r"d[ée]fausse\s+(\d+)\s+(\w+?)s?\s+de\s+votre\s+pioche", s)
    if m:
        sel = map_tutor_filter(m.group(2))
        if sel and "family" in sel:
            return {"type": "MillDeck", "amount": int(m.group(1)), "family": sel["family"], "_authored": True}
    return None


def parse_recover_and_mill(card: dict):
    """Second Souffle #1237 (two-part spell): "récupère les N dernières cartes parties
    dans votre défausse ET défausse les M premières cartes de votre pioche" gives
    [RecoverFromDiscard {count:N, which:"last"}, MillDeck {amount:M}]. The spell does
    not count itself (castSpell takes it out of the discard during its recover). Both
    types are managed, so they are stripped and injected again on each run."""
    s = strip_markup(card.get("description", ""))
    rm = re.search(r"r[ée]cup[èe]re\s+les\s+(\d+)\s+derni[èe]res\s+cartes?\s+parties?\s+dans\s+votre\s+d[ée]fausse", s)
    mm = re.search(r"d[ée]fausse\s+les\s+(\d+)\s+premi[èe]res\s+cartes?\s+de\s+votre\s+pioche", s)
    if not (rm and mm):
        return None
    return [{"type": "RecoverFromDiscard", "count": int(rm.group(1)), "which": "last", "_authored": True},
            {"type": "MillDeck", "amount": int(mm.group(1)), "_authored": True}]


def parse_steal_discard(desc: str):
    """ "Déplace les cartes de la défausse de votre adversaire dans la votre"
    (Fosscheur #217) → a StealDiscard (the opponent's whole discard joins yours).
    Returns the effect dict or None."""
    s = strip_markup(desc)
    if re.search(r"d[ée]place\s+les\s+cartes\s+de\s+la\s+d[ée]fausse\s+de\s+votre\s+adversaire\s+dans\s+la\s+v[ôo]tre", s):
        return {"type": "StealDiscard", "_authored": True}
    return None


def parse_free_if_reserve(desc: str):
    """ "Se pose gratuitement si vous avez au moins N PA dans votre réserve"
    (Dente le Remonteur #436) gives a FreeIfReserve {value:N} marker read by
    effectiveCost (cost 0 while apReserve >= N; never applied). Returns the effect
    dict or None."""
    s = strip_markup(desc)
    m = re.search(
        r"se\s+pose\s+gratuitement\s+si\s+vous\s+avez\s+au\s+moins\s+(\d+)\s*pa\s+dans\s+votre\s+r[ée]serve",
        s,
    )
    if not m:
        return None
    return {"type": "FreeIfReserve", "value": int(m.group(1)), "_authored": True}


def parse_dynamic_count_buff(desc: str):
    """Single-target spell buff scaled by a board count (Marquage "+1 AT par
    invocation alliée avec portée en jeu"; Force de l'Âge "+1 AT et +1 AR par
    Enutrof allié en jeu"). Gives BoostAttack/BoostArmor whose amount is a {count}."""
    s = strip_markup(desc)
    if "en jeu" not in s or "par" not in s:
        return None
    if re.search(r"\bou\b|\bsi\b|graine|glyphe|co[uû]t", s):
        return None
    m = re.search(r"conf[èe]re\s+[àa]\s+une\s+invocation\s+(.+?)\s+par\s+(.+?)\s+en\s+jeu", s)
    if not m:
        return None
    spec = _parse_count_group(m.group(2))
    if spec is None:
        return None
    effs = []
    for amt, stat in re.findall(r"\+?\s*(\d+)\s*(at|ar)\b", m.group(1)):
        et = {"at": "BoostAttack", "ar": "BoostArmor"}[stat]
        effs.append({"type": et, "amount": {"count": dict(spec), "per": int(amt)}})
    return effs or None


def parse_self_count_buff(desc: str):
    """Self buff on a trigger, scaled by a board count (Scaramel "Gagne +2 AR par
    Scara allié en jeu"; Protecteur Nimbos "par invocation alliée"; Championne
    Sanglante "par invocation adverse"). Gives a self BoostX with a {count} amount.
    Rejects the MORT ADVERSE and mass ("vos autres") variants, not authored here."""
    s = strip_markup(desc)
    if "en jeu" not in s or "par" not in s:
        return None
    if re.search(r"\bou\b|\bsi\b|graine|autres|mort\s+advers|donne\b|\bà vos\b", s):
        return None
    m = re.search(r"gagne\s+(.+?)\s+par\s+(.+?)\s+en\s+jeu", s)
    if not m:
        return None
    spec = _parse_count_group(m.group(2))
    if spec is None:
        return None
    effs = []
    for amt, stat in re.findall(r"\+?\s*(\d+)\s*(at|ar|pm)\b", m.group(1)):
        et = {"at": "BoostAttack", "ar": "BoostArmor", "pm": "BoostMovement"}[stat]
        cnt = dict(spec)
        # "Gagne +N par <X> allié en jeu" (no "autre") does not count the source itself.
        # This holds for every ally-scope self count this parser produces: Protecteur Nimbos
        # #1490 (allies), Tofu Dominant #177 (Tofu), Scaramel #364 (Scara), Chauve Souris
        # Dodue #433 (Goule). Counts marked with "autre" come from other parsers
        # (parse_boost_self_per_family / parse_self_count_others), and this one rejects
        # "autres", so nothing is handled twice. An enemy-scope count (Championne Sanglante
        # "par invocation adverse") never includes the allied source.
        if cnt.get("scope") == "allies":
            cnt["excludeSelf"] = True
        effs.append({"type": et, "amount": {"count": cnt, "per": int(amt)}, "self": True, "_authored": True})
    return effs or None


def parse_recycle_hand(desc: str):
    """Martingale: "Place votre main sous votre pioche. Piochez autant de cartes."
    → a RecycleHand player-state effect (hand to deck bottom, draw that many)."""
    s = strip_markup(desc)
    if re.search(r"place\s+votre\s+main\s+sous\s+votre\s+pioche", s) and "piochez" in s:
        return {"type": "RecycleHand"}
    return None


def parse_add_seeds(desc: str):
    """Cards that add seeds to the reserve give an AddSeeds player-state effect
    ("Ajoute N Graine(s) à votre réserve de graines"). Only the plain adders:
      - Sac De Graines #74 (spell, +2), Klore Ofil #1 (APPARITION +1),
        Sylvine Folherbe #430 (APPARITION +5), Grine Piz #462 (CONTRE COUP +1)
      - Révolte Naturelle #1684: "Ajoute autant de Graines ... que d'invocations
        adverses en jeu" gives a dynamic {count} amount (scope enemies).

    Rejects descriptions that also deal damage or have a condition (Ronces
    Agressives #439 "Inflige ...", Ronce #384 "... si l'invocation meurt"), so their
    damage is not silently dropped. The DÉBUT DU TOUR adder (Arbre #1232) is left
    out by the trigger-kind check at the call site (no start-of-turn trigger yet)."""
    s = strip_markup(desc)
    if not re.search(r"r[ée]serve de graines", s):
        return None
    # Compound (damage / conditional) riders → not a pure adder; defer.
    if "inflige" in s or "@damage@" in s or " si " in s:
        return None
    # Dynamic: "ajoute autant de graines … que <groupe> en jeu".
    if "autant de graines" in s:
        m = re.search(r"que\s+(.+?)\s+en\s+jeu", s)
        if not m:
            return None
        spec = _parse_count_group(m.group(1))
        if spec is None:
            return None
        return {"type": "AddSeeds", "amount": {"count": dict(spec)}}
    # Fixed: "ajoute (une|N) graine(s) à votre réserve de graines".
    m = re.search(r"ajoute\s+(une|un|\d+)\s+graines?\s+[àa]\s+votre\s+r[ée]serve\s+de\s+graines", s)
    if not m:
        return None
    amt = 1 if m.group(1) in ("une", "un") else int(m.group(1))
    return {"type": "AddSeeds", "amount": amt}


# Seed-transform token aliases: the description names the token by its
# in-game label ("Poupées Folles", "Arbre"), which differs from the actual
# Summon card name ("La Folle", "Arbre"). Map the FR phrase → card id.
# (Buisson is a board object, not a creature, deferred, so not listed here.)
SEED_TOKEN_ALIAS = {
    "poupees sacrifiees": 373, "poupee sacrifiee": 373,  # La Sacrifiée #373
    "poupees folles": 481, "poupee folle": 481,          # La Folle #481
    "poupees gonflables": 5, "poupee gonflable": 5,      # La Gonflable #5
    "arbres": 1232, "arbre": 1232,                       # Arbre #1232
}


def _seed_token_id(phrase: str):
    """Resolve a transform target phrase ("Poupées Folles", "Arbre") → token id."""
    p = _deaccent(phrase).strip()
    for key, cid in SEED_TOKEN_ALIAS.items():
        if key in p:
            return cid
    return None


def parse_transform_seed(desc: str):
    """Single seed transform gives a TransformSeed effect (the player picks one of
    their planted seeds and it becomes the token on its cell). Covers:
      - spell: "Transforme une Graine alliée en Arbre" (Botanique #984)
      - APPARITION: "Transformez une de vos Graines en Poupée X" (Li Crounch
        #129, Dodu #318, Canar #402)
    Buisson (a board object) is not in SEED_TOKEN_ALIAS, so it returns None for now.
    The mass form ("Transforme VOS Graines ...") is handled by parse_transform_seeds_mass."""
    s = strip_markup(desc)
    m = re.search(
        r"transforme[z]?\s+une\s+(?:de\s+vos\s+)?graines?\s+(?:alli\w+\s+)?en\s+(.+?)\.?\s*$",
        s,
    )
    if not m:
        return None
    tok = _seed_token_id(m.group(1))
    if tok is None:
        return None
    return {"type": "TransformSeed", "tokenId": tok}


def parse_transform_into_seed(desc: str):
    """Savoir Sadida #176: "Transforme une invocation en Graine alliée." →
    TransformIntoSeed (the targeted creature, any side, castTarget AnySummon, is
    removed and replaced by one of the caster's seeds on its cell). The reverse of
    the seed→creature transforms; distinct phrasing ("une invocation en graine")."""
    s = strip_markup(desc)
    if re.search(r"transforme\s+une\s+invocation\s+en\s+graine", s):
        return {"type": "TransformIntoSeed"}
    return None


def parse_transform_into_butin(desc: str):
    """Main de Nidas #1135: "Transforme une invocation en Butin allié." →
    TransformIntoButin (the targeted creature, any side, castTarget AnySummon, is
    removed and replaced by one of the caster's Butins on its cell)."""
    s = strip_markup(desc)
    if re.search(r"transforme\s+une\s+invocation\s+en\s+butin", s):
        return {"type": "TransformIntoButin"}
    return None


def parse_forbank(desc: str):
    """Forbank #653: "Déterre un Butin allié sur la case devant lui à la fin des
    déplacements de vos invocations." gives a PlaceButinInFront effect fired at FIN DU
    TOUR ("fin des déplacements": creatures move at the end of the turn).
    Returns the effect dict or None."""
    s = strip_markup(desc)
    if re.search(r"d[ée]terre\s+un\s+butin\s+alli[ée]\s+sur\s+la\s+case\s+devant\s+lui", s):
        return {"type": "PlaceButinInFront", "_authored": True}
    return None


def parse_post_advance_summon(card: dict):
    """Brâm Barbemonde #833: "invoque une unité de nainfants devant lui après le
    déplacement de toutes vos invocations" gives POST_ADVANCE {SummonToken {tokenId:904
    (Nainfant), placement:front}} (summons a Nainfant in front of the source after the
    advance)."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"invoque\s+une\s+unit[ée]\s+de\s+nainfants?\s+devant\s+lui\s+apr[èe]s\s+le\s+d[ée]placement\s+de\s+toutes\s+vos\s+invocations", s):
        return {"trigger": "POST_ADVANCE", "effects": [{"type": "SummonToken", "tokenId": 904, "placement": "front", "amount": 1, "_authored": True}], "_authored": True}
    return None


def parse_grokokolantha(card: dict):
    """Grokokolantha #9: "place dans votre main la première créature de Moon de votre
    pioche quand une de vos créatures de Moon meurt" ("Moon" is the KOKOKO family)
    gives MORT_ALLIEE {filter:{family:Kokoko}} with TutorFromDeck {family:Kokoko,
    summon, from:top} (draws the first Kokoko creature when an allied Kokoko dies)."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"place\s+dans\s+votre\s+main\s+la\s+premi[èe]re\s+cr[ée]ature\s+de\s+moon\s+de\s+votre\s+pioche\s+quand\s+une\s+de\s+vos\s+cr[ée]atures\s+de\s+moon\s+meurt", s):
        return {
            "trigger": "MORT_ALLIEE",
            "filter": {"family": "Kokoko"},
            "effects": [{"type": "TutorFromDeck", "from": "top", "amount": 1, "summon": True, "family": "Kokoko", "_authored": True}],
            "_authored": True,
        }
    return None


def parse_teleport_behind(desc: str):
    """Azraoël #183 / Lame Ourduvis #206 / Ejipe #546 (Sram): "Se téléporte
    derrière son adversaire après avoir subi des dégâts lors d'un combat." → a
    TeleportBehindAttacker self-effect fired on CONTRE_COUP ("après avoir subi des
    dégâts"). The engine reads the attacker from the last DAMAGE in the log and
    drops the creature behind it. Returns the effect dict or None."""
    s = strip_markup(desc)
    if re.search(r"se\s+t[ée]l[ée]porte\s+derri[èe]re\s+son\s+adversaire", s):
        return {"type": "TeleportBehindAttacker", "_authored": True}
    return None


def parse_transform_seed_to_bush(desc: str):
    """Buisson #214 (spell) / Selk Ator #108 (APPARITION): "Transforme une Graine
    alliée en Buisson." → TransformSeedToBush (pick one of your seeds; it becomes a
    Buisson board object, a spawn point, on its cell). Buisson is not a creature
    token (so parse_transform_seed returns None for it), hence this dedicated path."""
    s = strip_markup(desc)
    if re.search(r"transforme[z]?\s+une\s+(?:de\s+vos\s+)?graines?\s+(?:alli\w+\s+)?en\s+buisson", s):
        return {"type": "TransformSeedToBush"}
    return None


def parse_transform_seeds_mass(desc: str):
    """Mass seed-transform spell ("Transforme vos Graines en Poupées Folles /
    Sacrifiées", Graines de Folie #162 / Graines de Sacrifice #394) → a
    TransformAllSeeds effect (every caster seed becomes the token on its cell).
    Buisson (board object) is not in SEED_TOKEN_ALIAS, so those stay deferred."""
    s = strip_markup(desc)
    m = re.search(r"transforme\s+vos\s+graines?\s+en\s+(.+?)\.?\s*$", s)
    if not m:
        return None
    tok = _seed_token_id(m.group(1))
    if tok is None:
        return None
    return {"type": "TransformAllSeeds", "tokenId": tok}


def parse_transform_butins_mass(desc: str):
    """Corruption #1371: "Transforme vos Butins en <token>" (Bébés Phorreurs
    Armurés) → a TransformAllButins effect (every caster butin becomes the token
    on its cell). Token resolved via resolve_token; None if it does not resolve."""
    s = strip_markup(desc)
    m = re.search(r"transforme\s+vos\s+butins?\s+en\s+(.+?)\.?\s*$", s)
    if not m:
        return None
    tok = resolve_token(m.group(1))
    if tok is None:
        return None
    return {"type": "TransformAllButins", "tokenId": tok}


def parse_bounce_glyphs(desc: str):
    """Remaniement #1443: "Vos Glyphes remontent dans votre main." → a BounceGlyphs
    player-state effect: remove every caster glyph from the board and add that
    many base Glyphe (#827) cards to hand. Returns the effect dict or None."""
    s = strip_markup(desc)
    if re.search(r"vos\s+glyphes?\s+remontent\s+dans\s+votre\s+main", s):
        return {"type": "BounceGlyphs"}
    return None


def parse_grant_initiative_allies(desc: str):
    """Cervelle de Iop #683: "Confère initiative à vos invocations." → SetProperty
    {property:FirstStrike, scope:allies}. Replaces the no-scope SetPropertyData
    bindata, which on this AlliedGod cast would target nothing (and would wrongly
    make validateSpellTarget demand a creature). Returns the effect or None."""
    s = strip_markup(desc)
    if re.search(r"conf[èe]re\s+initiative\s+[àa]\s+vos\s+invocations", s):
        return {"type": "SetProperty", "property": "FirstStrike", "scope": "allies", "_authored": True}
    return None


def parse_grant_shield_allies(desc: str):
    """Maître Féca #1676: "confère bouclier à vos invocations [et à vos dofus]" gives SetProperty
    {property:Shield, scope:allies}, a Shield on all your creatures. Like Cervelle de Iop
    #683 it replaces the no-scope SetPropertyData bindata, so this AlliedGod spell can be
    cast on any cell (canPlayCard's `hasSetProperty` only looks at the bindata
    `SetPropertyData`, not at the authored scoped `SetProperty`). The "et à vos dofus" part
    (a Shield on a Dofus) needs another mechanism that does not exist yet, since Dofus
    have no properties. Returns the effect or None."""
    s = strip_markup(desc)
    if re.search(r"conf[èe]re\s+bouclier\s+[àa]\s+vos\s+invocations", s):
        return {"type": "SetProperty", "property": "Shield", "scope": "allies", "_authored": True}
    return None


def parse_outnumbered_self_buff(card: dict):
    """Zorine #668: "gagne +N AT et initiative si vous êtes en sous nombre" gives a continuous
    conditional self buff, only active while outnumbered (strictly fewer allied creatures
    than the opponent): [ConditionalStatBoost {stat:attack, amount:N, condition:
    outnumbered}, ConditionalFirstStrike {condition:outnumbered}]. withAuras recomputes both
    auras on each board change, so the buff disappears as soon as you are no longer
    outnumbered. Replaces the wrong bindata (a SetPropertyData FirstStrike with no
    condition). Returns the effect list or None."""
    if card.get("cardType") != "Summon":
        return None
    s = strip_markup(card.get("description", ""))
    m = re.search(r"gagne\s+\+?(\d+)\s*at\s+et\s+initiative\s+si\s+vous\s+[êe]tes\s+en\s+sous[\s-]?nombre", s)
    if not m:
        return None
    return [
        {"type": "ConditionalStatBoost", "stat": "attack", "amount": int(m.group(1)), "condition": "outnumbered", "_authored": True},
        {"type": "ConditionalFirstStrike", "condition": "outnumbered", "_authored": True},
    ]


def parse_poum_ondacie(card: dict):
    """Poum Ondacié #781: "APPARITION : gagne +N AT par invocation en jeu qui possède de l'AR
    ou un bouclier" gives a count-based self BoostAttack on the APPARITION: +N per living
    creature (both sides, there is no "vos") that has AR > 0 or a Shield property.
    Resolved by resolveCounts at summon. Replaces the wrong flat bindata
    BoostAttackData {Boost:1}. Returns N or None."""
    if card.get("cardType") != "Summon":
        return None
    s = strip_markup(card.get("description", ""))
    m = re.search(r"gagne\s+\+?(\d+)\s*at\s+par\s+invocation\s+en\s+jeu\s+qui\s+poss[èe]de\s+de\s+l['’]\s*ar\s+ou\s+un\s+bouclier", s)
    return int(m.group(1)) if m else None


def parse_aoe_all_enemies(card: dict):
    """ "Inflige[z] @damage@ aux invocations adverses[ d'une ligne / d'une rangée]."
    (Rocknocerok #50 = all enemies; Éventrail #232 / Ronces = the clicked row "ligne";
    Incision #1417 / Creusée #783 = the clicked column "rangée") gives AoeDamage
    {amount, scope:enemies[, shape:row|column]}. The amount comes from the bindata
    DamageData (the text shows @damage@). Replaces the broken single-target bindata
    (no scope, so it does nothing on an AlliedGod / AnyRow / AnyColumn cast). Rejects
    riders modelled elsewhere (dans votre camp #688, ayant N AT #1531, de leur ligne,
    autour, puis) and any extra sentence: the "Ajoute une Graine" of Ronces #439 makes
    the anchored match fail, so that card is handled later. Returns the effect list
    or None."""
    s = strip_markup(card.get("description", ""))
    if "aux invocations adverses" not in s:
        return None
    if re.search(r"dans\s+votre\s+camp|ayant|de\s+leur\s+ligne|autour|au\s+moins|chaque|puis", s):
        return None
    m = re.search(r"inflige[z]?\s+@?\w*@?\s*aux\s+invocations?\s+adverses?(\s+d'une\s+ligne|\s+d'une\s+rang[ée]e)?\s*\.?\s*$", s)
    if not m:
        return None
    amt = None
    for e in (card.get("effects") or []):
        if e.get("type") == "DamageData":
            d = e.get("Damage")
            amt = d if isinstance(d, int) else (d.get("const") if isinstance(d, dict) else None)
            break
    if amt is None:
        return None
    eff = {"type": "AoeDamage", "amount": int(amt), "scope": "enemies", "_authored": True}
    g = m.group(1)
    if g:
        eff["shape"] = "column" if "rang" in g else "row"  # ligne→row, rangée→column
    return [eff]


def parse_aoe_push_enemies(card: dict):
    """Peur #396 ("Repousse les invocations adverses de N cases.") and Flèche
    Tempête #84 ("Inflige @damage@ et repousse de N cases les invocations
    adverses.") give [AoeDamage if "inflige", scope:enemies] + AoePush {distance,
    scope:enemies}. The distance comes from the bindata PushData, the amount from
    DamageData. Replaces the broken single-target bindata. Requires "LES invocations
    adverses" (mass); a single "UNE invocation adverse" (e.g. Rafale #532) is not
    matched. Returns the effect list or None."""
    s = strip_markup(card.get("description", ""))
    if "les invocations adverses" not in s or "repousse" not in s:
        return None
    if re.search(r"autour|de\s+sa\s+ligne|dans\s+votre\s+camp|ayant|au\s+moins|d'une\s+ligne|d'une\s+rang", s):
        return None
    effs = []
    if "inflige" in s:
        amt = None
        for e in (card.get("effects") or []):
            if e.get("type") == "DamageData":
                d = e.get("Damage")
                amt = d if isinstance(d, int) else (d.get("const") if isinstance(d, dict) else None)
                break
        if amt is not None:
            effs.append({"type": "AoeDamage", "amount": int(amt), "scope": "enemies", "_authored": True})
    dist = None
    for e in (card.get("effects") or []):
        if e.get("type") == "PushData":
            d = e.get("Distance")
            dist = d if isinstance(d, int) else (d.get("const") if isinstance(d, dict) else None)
            break
    if dist is None:
        return None
    effs.append({"type": "AoePush", "distance": int(dist), "scope": "enemies", "_authored": True})
    return effs


def parse_apparition_push_enemy_row(card: dict):
    """Championne Embrocheuse #1023: "APPARITION : repousse les invocations adverses de sa
    ligne de N cases" gives an AoePush on the APPARITION that pushes every enemy creature
    on the Championne's own row (shape "row" = same y as the source) N cells toward its
    owner's wall, that is toward the enemy Dofus. Replaces the broken single-target
    bindata PushData. Returns N (the push distance) or None."""
    if card.get("cardType") != "Summon":
        return None
    s = strip_markup(card.get("description", ""))
    m = re.search(r"repousse\s+les\s+invocations?\s+adverses?\s+de\s+sa\s+ligne\s+de\s+(\d+)\s+cases?", s)
    return int(m.group(1)) if m else None


def parse_apparition_push_all_enemies(card: dict):
    """Kokoko #157: "APPARITION : repousse de N case(s) les invocations adverses" (no "de sa ligne")
    gives an AoePush {distance:N, scope:enemies} that pushes every enemy creature N cells
    (not a single-target pick). Replaces the broken single-target bindata PushData.
    Returns N or None."""
    if card.get("cardType") != "Summon":
        return None
    s = strip_markup(card.get("description", ""))
    if "de sa ligne" in s:  # that is Championne Embrocheuse's row-push, handled by parse_apparition_push_enemy_row
        return None
    m = re.search(r"repousse\s+de\s+(\d+)\s+cases?\s+les\s+invocations?\s+adverses?", s)
    return int(m.group(1)) if m else None


def parse_boost_self_per_family(card: dict):
    """Roi des Bouftous #60: "APPARITION : Gagne +A AT et +B AR par autre <famille> allié en jeu" →
    self count-buffs [BoostAttack {self, count}, BoostArmor {self, count}] where the count is the
    number of allied <famille> creatures (excludeSelf when "autre"), each multiplied by A / B. Replaces
    the flat bindata BoostAttackData on the APPARITION. Returns the effects list or None."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"gagne\s+\+?(\d+)\s+at\s+et\s+\+?(\d+)\s+ar\s+par\s+(autre\s+)?(\w+?)\s+alli[ée]e?s?\s+en\s+jeu", s)
    if not m:
        return None
    sel = map_tutor_filter(m.group(4))
    if not sel or "family" not in sel:
        return None
    base = {"scope": "allies", "family": sel["family"]}
    if m.group(3):  # "autre <famille>" → do not count the Roi itself
        base["excludeSelf"] = True
    out = []
    if int(m.group(1)) > 0:
        out.append({"type": "BoostAttack", "self": True, "amount": {"count": dict(base), "per": int(m.group(1))}, "_authored": True})
    if int(m.group(2)) > 0:
        out.append({"type": "BoostArmor", "self": True, "amount": {"count": dict(base), "per": int(m.group(2))}, "_authored": True})
    return out or None


def parse_boost_self_if_family(card: dict):
    """Tiwabbit Kiafin #477: "APPARITION : Gagne +A AT et +B AR si vous avez une <famille> en jeu" →
    self [BoostAttack, BoostArmor] each carrying requireCondition allyFamilyInPlay (the whole buff is
    cancelled unless an ally of <famille> is in play). Replaces the flat bindata BoostAttackData on the
    APPARITION. "une autre <famille>" (or the card itself being of that family) → excludeSelf. Returns
    the effects list or None."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"gagne\s+\+?(\d+)\s+at\s+et\s+\+?(\d+)\s+ar\s+si\s+vous\s+avez\s+une?\s+(autre\s+)?(\w+?)\s+en\s+jeu", s)
    if not m:
        return None
    sel = map_tutor_filter(m.group(4))
    if not sel or "family" not in sel:
        return None
    cond = {"kind": "allyFamilyInPlay", "family": sel["family"]}
    if m.group(3) or sel["family"] in (card.get("families") or []):
        cond["excludeSelf"] = True
    out = []
    if int(m.group(1)) > 0:
        out.append({"type": "BoostAttack", "self": True, "amount": int(m.group(1)), "requireCondition": dict(cond), "_authored": True})
    if int(m.group(2)) > 0:
        out.append({"type": "BoostArmor", "self": True, "amount": int(m.group(2)), "requireCondition": dict(cond), "_authored": True})
    return out or None


def parse_attract_first_ahead(card: dict):
    """Katar #458 (APPARITION "attire ... devant lui puis charge"), #265/#324 (DÉBUT DU TOUR):
    "Attire la première invocation adverse [située] devant lui [puis charge]" gives
    AttractFirstAhead (automatic: pulls the first enemy on its row until it is right in
    front of the source), plus ChargeSelf when it says "puis charge". Returns
    (trigger_kind, effects). The wiring replaces the whole slot, so the result does not
    depend on the order. None if there is no match."""
    s = strip_markup(card.get("description", ""))
    if not re.search(r"attire\s+la\s+premi[èe]re\s+invocation\s+adverse\s+(?:situ[ée]e?\s+)?devant\s+(?:lui|elle)", s):
        return None
    k = detect_trigger_kind(s)
    if not k:
        return None
    effs = [{"type": "AttractFirstAhead", "_authored": True}]
    if re.search(r"puis\s+charge", s):
        effs.append({"type": "ChargeSelf", "_authored": True})
    return (k, effs)


def parse_aoe_all_creatures(card: dict):
    """Sang Brûlant #538: "Inflige @damage@ aux invocations." (no "adverses" → hits
    both camps, a sacrificial Sacrieur spell) → AoeDamage {amount, scope:all}.
    amount from the bindata DamageData. Replaces the broken single-target bindata.
    Returns the effect list or None."""
    s = strip_markup(card.get("description", ""))
    if not re.search(r"inflige[z]?\s+@?\w*@?\s*aux\s+invocations\s*\.?\s*$", s):
        return None
    amt = None
    for e in (card.get("effects") or []):
        if e.get("type") == "DamageData":
            d = e.get("Damage")
            amt = d if isinstance(d, int) else (d.get("const") if isinstance(d, dict) else None)
            break
    if amt is None:
        return None
    return [{"type": "AoeDamage", "amount": int(amt), "scope": "all", "_authored": True}]


def parse_grant_buff_untargetable_allies(card: dict):
    """Maître des Ombres #22: "Confère à vos invocations +N AT et inciblable." gives
    [BoostAttack {amount:N, scope:allies}, SetProperty {Untargetable, scope:allies}].
    Replaces the no-scope SetPropertyData bindata (broken on the AlliedGod cast).
    Returns the effect list or None."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"conf[èe]re\s+[àa]\s+vos\s+invocations\s+\+?(\d+)\s*at\s+et\s+inciblable", s)
    if not m:
        return None
    n = int(m.group(1))
    return [{"type": "BoostAttack", "amount": n, "scope": "allies", "_authored": True},
            {"type": "SetProperty", "property": "Untargetable", "scope": "allies", "_authored": True}]


def parse_aoe_damage_enemy_dofuses(card: dict):
    """Harcèlement #136: "Inflige @damage@ à tous les Dofus adverses." gives
    AoeDamageDofus {amount} (every enemy Dofus loses N). The amount comes from the
    bindata. Replaces the broken single-target bindata. Returns the effect list or None."""
    s = strip_markup(card.get("description", ""))
    if not re.search(r"inflige[z]?\s+@?\w*@?\s*[àa]\s+tous\s+les\s+dofus\s+advers", s):
        return None
    amt = None
    for e in (card.get("effects") or []):
        if e.get("type") == "DamageData":
            d = e.get("Damage")
            amt = d if isinstance(d, int) else (d.get("const") if isinstance(d, dict) else None)
            break
    if amt is None:
        return None
    return [{"type": "AoeDamageDofus", "amount": int(amt), "_authored": True}]


def parse_dice_damage_reveal_dofus(card: dict):
    """Dé du Chateux #459: "Inflige 1d6 dégâts. Dévoile le Dofus adverse de la ligne
    sur N ou moins." gives [DamageData {1d6}, RevealEnemyDofusLine {maxRoll:N}]. The
    reveal only happens when the same 1d6 roll (stored in ctx.diceRoll by the damage)
    is <= N. Returns the effect list or None."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"d[ée]voile\s+le\s+dofus\s+adverse\s+de\s+la\s+ligne\s+sur\s+(\d+)\s+ou\s+moins", s)
    if not m:
        return None
    return [{"type": "DamageData", "Damage": {"type": "TriggeringDiceValue"}},
            {"type": "RevealEnemyDofusLine", "maxRoll": int(m.group(1)), "_authored": True}]


def parse_dice_damage_recover(card: dict):
    """Dé Ecaflip #342: "Inflige 1d6 dégât(s). Récupérez ce sort sur N ou moins." gives
    [DamageData {1d6}, RecoverSelfOnLowRoll {maxRoll:N}]: castSpell returns the spell to
    the hand when the same roll is <= N. Returns the effect list or None."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"r[ée]cup[ée]rez\s+ce\s+sort\s+sur\s+(\d+)\s+ou\s+moins", s)
    if not m:
        return None
    return [{"type": "DamageData", "Damage": {"type": "TriggeringDiceValue"}},
            {"type": "RecoverSelfOnLowRoll", "maxRoll": int(m.group(1)), "_authored": True}]


def parse_aoe_dice_chacha(card: dict):
    """Dé Rebondissant #573: "Inflige 1d6 dégâts aux invocations adverses. Coûte 1
    PA de moins par Chacha allié en jeu." gives [AoeDamage {amount:{dice:1d6},
    scope:enemies}, SelfCostReduction {count:allied Chacha, per:1}]. The broken
    single-target dice bindata is replaced by the AoE; the cost part is a marker read
    by effectiveCost. Returns the effect list or None."""
    s = strip_markup(card.get("description", ""))
    if "aux invocations adverses" not in s:
        return None
    m = re.search(r"co[uû]te\s+(\d+)\s*pa\s+de\s+moins\s+par\s+chacha\s+alli[ée]", s)
    if not m:
        return None
    return [{"type": "AoeDamage", "amount": {"dice": "1d6"}, "scope": "enemies", "_authored": True},
            {"type": "SelfCostReduction", "amount": {"count": {"scope": "allies", "family": "Chacha"}, "per": int(m.group(1))}, "_authored": True}]


def parse_self_seed_buff(desc: str):
    """ "Gagne autant d'AT/AR que de Graines alliées en jeu" (Larch #990) → a self
    BoostX whose amount is a NumberOfSeedsValue (the engine resolves it against the
    board at the trigger). TeamFilter 0 = Own ("alliées" = the caster's seeds)."""
    s = strip_markup(desc)
    m = re.search(
        r"gagne\s+autant\s+d.{0,2}\s*(at|ar|pm)\b\s+que\s+de\s+graines?\s+(alli\w+|advers\w+|ennemi\w+)?",
        s,
    )
    if not m:
        return None
    et = {"at": "BoostAttack", "ar": "BoostArmor", "pm": "BoostMovement"}[m.group(1)]
    camp = m.group(2) or ""
    tf = 1 if ("advers" in camp or "ennemi" in camp) else 0  # "alliées"/none → Own(0)
    return {"type": et, "amount": {"type": "NumberOfSeedsValue", "TeamFilter": tf,
            "ValuePerSeed": 1, "FixedValue": 0}, "self": True, "_authored": True}


def parse_self_reserve_buff(desc: str):
    """ "Gagne autant d'AT/AR/PM que de PA dans votre réserve" (Casey Io #586) → a
    self BoostX whose amount is a ReserveValue (resolved against the caster's AP
    reserve at the trigger). Returns the effect dict or None."""
    s = strip_markup(desc)
    m = re.search(
        r"gagne\s+autant\s+d.{0,2}\s*(at|ar|pm)\b\s+que\s+de\s+pa\s+dans\s+votre\s+r[ée]serve",
        s,
    )
    if not m:
        return None
    et = {"at": "BoostAttack", "ar": "BoostArmor", "pm": "BoostMovement"}[m.group(1)]
    return {"type": et, "amount": {"type": "ReserveValue"}, "self": True, "_authored": True}


def parse_wounded_armor_grant(desc: str):
    """Saizan Zen #522: "Donnez +N AR à une invocation ou +M AR si elle est
    blessée." gives a targeted BoostArmor (any_creature pick) whose amount depends on
    wounds: the engine gives N normally, or M (woundedAmount) when the picked target is
    wounded at resolve time. Injected on the APPARITION trigger. Returns the effect
    dict or None."""
    s = strip_markup(desc)
    m = re.search(
        r"donnez?\s+\+?(\d+)\s*ar\s+[àa]\s+une\s+invocation\s+ou\s+\+?(\d+)\s*ar\s+si\s+elle\s+est\s+bless",
        s,
    )
    if not m:
        return None
    return {"type": "BoostArmor", "amount": int(m.group(1)),
            "woundedAmount": int(m.group(2)), "_authored": True}


def parse_double_family_buff(desc: str):
    """Will Skass #264: "Vos <Fam1> et vos autres <Fam2> gagnent +N AT/AR." →
    [BoostX allies family F1, BoostX allies family F2 excludeSelf] (the second
    clause carries "autres" → the source, of family F2, is skipped). Both families
    must resolve, else None (no partial authoring). In this game Chachas are not
    tagged Ecaflip, so the two family sets are disjoint, no double-buff."""
    s = strip_markup(desc)
    m = re.search(r"vos\s+(\w+)\s+et\s+vos\s+autres\s+(\w+)\s+gagnent\s+\+?(\d+)\s*(at|ar)\b", s)
    if not m:
        return None
    f1 = map_tutor_filter(m.group(1))
    f2 = map_tutor_filter(m.group(2))
    if not (f1 and "family" in f1 and f2 and "family" in f2):
        return None
    et = {"at": "BoostAttack", "ar": "BoostArmor"}[m.group(4)]
    amt = int(m.group(3))
    return [
        {"type": et, "amount": amt, "scope": "allies", "family": f1["family"], "_authored": True},
        {"type": et, "amount": amt, "scope": "allies", "family": f2["family"], "excludeSelf": True, "_authored": True},
    ]


def parse_other_allies_flat_buff(desc: str):
    """ "<trigger> : Vos autres <invocations|famille> gagnent +N AT[ et +N AR]" →
    BoostAttack/BoostArmor {scope:allies, excludeSelf, family?}, placed on the slot
    that detect_trigger_kind returns. A recurring family/ally stat buff that fires
    on its trigger, e.g. Chacha Serval #1354 (FIN DU TOUR: other Chachas +1 AT/+1
    AR) and Scarafeuille Céleste #864 (FIN DU TOUR: other invocations +1 AR). Reuses
    the Set-2 family-scoped boost executors; only the trigger slot is new. Rejects
    the two-clause "vos X et vos autres Y" form (parse_will_skass) and the
    count-scaled "par … en jeu" form (parse_self_count_buff / dynamic parsers)."""
    s = strip_markup(desc)
    if "et vos autres" in s:
        return None
    if "par" in s and "en jeu" in s:
        return None
    m = re.search(r"vos\s+autres\s+(invocations|\w+)\s+gagnent\s+(.+)", s)
    if not m:
        return None
    noun, clause = m.group(1), m.group(2)
    pairs = re.findall(r"\+?\s*(\d+)\s*(at|ar)\b", clause)
    if not pairs:
        return None
    family = None
    if noun != "invocations":
        fam = map_tutor_filter(noun)
        if not (fam and "family" in fam):
            return None  # an unresolved noun → do not half-author
        family = fam["family"]
    effs = []
    for amt, stat in pairs:
        eff = {"type": {"at": "BoostAttack", "ar": "BoostArmor"}[stat],
               "amount": int(amt), "scope": "allies", "excludeSelf": True, "_authored": True}
        if family:
            eff["family"] = family
        effs.append(eff)
    return effs or None


def parse_charge_other_allies(desc: str):
    """ "<trigger> : Vos autres <invocations|famille> chargent [de N cases]" gives a
    ChargeAllies {excludeSelf, family?, cells?} on the slot from detect_trigger_kind.
    With "de N cases" it is an extra N-cell move (like Jice #283); without it, a full
    charge (each ally moves its whole PM; chargeAllies does this when `cells` is
    missing). Gligli Ancestral #196 (DÉBUT DU TOUR, 2 cells), Gelée Citron #203
    (APPARITION, Gelées, full). Rejects buff, choice, reverse, wounded, count and
    reactive riders, which need their own pass."""
    s = strip_markup(desc)
    m = re.search(r"vos\s+autres\s+(invocations|\w+)\s+chargent(?:\s+de\s+(\d+)\s*cases?)?", s)
    if not m:
        return None
    if re.search(r"\bou\b|reculent|bless|\+\s*\d|gagnent|\bpar\b.*en\s+jeu|quand", s):
        return None
    noun = m.group(1)
    eff = {"type": "ChargeAllies", "excludeSelf": True, "_authored": True}
    if m.group(2):
        eff["cells"] = int(m.group(2))
    if noun != "invocations":
        fam = map_tutor_filter(noun)
        if not (fam and "family" in fam):
            return None  # unresolved noun → do not half-author
        eff["family"] = fam["family"]
    return eff


def parse_add_reserve_trigger(desc: str):
    """ "Ajoute N PA à votre réserve [quand il subit des dégâts / si elle est vide]"
    on a trigger gives AddReserve {amount:N, side:caster[, requireCondition
    reserveEmpty]}. The caller detects the trigger kind (CONTRE_COUP for "quand il
    subit des dégâts", otherwise detect_trigger_kind, e.g. FIN_DE_TOUR for Lomega
    #1512). Returns the effect dict or None. Only for "votre réserve" (the caster's);
    the "réserve adverse" variant is not handled here."""
    s = strip_markup(desc)
    m = re.search(r"ajoute\s+(\d+)\s*pa\s+[àa]\s+votre\s+r[ée]serve", s)
    if not m:
        return None
    # Reject MORT ADVERSE (a separate "enemy dies" trigger that detect_trigger_kind would
    # read as MORT). NÉCROME is not rejected: the keyword is handled in the engine, so a
    # Nécrome's own reserve text has to be authored (Maître Egreneur #665). The modelled
    # conditions are "si elle est vide" (reserveEmpty) and "si vous êtes en sous nombre"
    # (outnumbered); any other " si ..." rider is skipped.
    if re.search(r"mort\s+advers", s):
        return None
    outnum = bool(re.search(r"si\s+vous\s+[êe]tes\s+en\s+sous\s+nombre", s))
    if " si " in s and not (re.search(r"si\s+elle\s+est\s+vide", s) or outnum):
        return None
    eff = {"type": "AddReserve", "amount": int(m.group(1)), "side": "caster", "_authored": True}
    if re.search(r"si\s+elle\s+est\s+vide", s):
        eff["requireCondition"] = {"kind": "reserveEmpty"}  # Lomega
    elif outnum:
        eff["requireCondition"] = {"kind": "outnumbered"}  # Maître Egreneur #665
    return eff


def parse_set_enemy_movement(desc: str):
    """Championne Périmée #634: "Passe à N les PM des invocations adverses." gives a
    scoped SetMovement (value N, scope enemies), the usual model for "Passe à N les PM"
    (see Vitalité Ancestrale #1203, scope all). Every enemy creature's movement is set
    to N (a debuff against fast enemies). Returns the effect or None."""
    s = strip_markup(desc)
    m = re.search(r"passe\s+[àa]\s+(\d+)\s+les\s+pm\s+des\s+invocations?\s+(?:adverses?|ennemies?)", s)
    if not m:
        return None
    return {"type": "SetMovement", "value": int(m.group(1)), "scope": "enemies", "_authored": True}


def parse_aoe_enemies_then_self(card: dict):
    """Disciple de l'Agonie #1163: "FIN DU TOUR : Inflige @damage@ aux invocations
    adverses puis à lui-même." → [AoeDamage {amount, scope:enemies}, SelfDamageData
    {Damage:amount}] on the FIN_DE_TOUR slot. The amount is read from the card's
    bindata DamageData (the @damage@ token). Returns the effect list or None."""
    s = strip_markup(card.get("description", ""))
    if not re.search(r"aux\s+invocations?\s+adverses?\s+puis\s+[àa]\s+lui", s):
        return None
    amt = None
    for e in (card.get("effects") or []):
        if e.get("type") == "DamageData":
            d = e.get("Damage")
            amt = d if isinstance(d, int) else (d.get("const") if isinstance(d, dict) else None)
            break
    if amt is None:
        return None
    return [
        {"type": "AoeDamage", "amount": int(amt), "scope": "enemies", "_authored": True},
        {"type": "SelfDamageData", "Damage": int(amt), "_authored": True},
    ]


def parse_banish_discard(card: dict):
    """Sram "Bannit (la dernière carte | les N dernières cartes) partie(s) dans
    votre défausse pour ‹effet›." gives a BanishDiscard {count:N} cost marker (added to
    effects[]; the ‹effet› part is the card's own effect: DamageData for Premier Sang #48 /
    Assoiffé #435, or just the summon for Ogivol #127 / Amsrad #173). Returns the dict
    or None."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"bannit\s+(?:la\s+derni[èe]re\s+carte|les\s+(\d+)\s+derni[èe]res\s+cartes)\s+parties?\s+dans\s+votre\s+d[ée]fausse\s+pour\s+(.+)", s)
    if not m:
        return None
    # Only author when the ‹effet› payload is modelled: "infliger @damage@" (the
    # DamageData bindata), "être invoqué" (just the summon), "chuter à N l'AT d'une
    # invocation" (SetAttack #657), "faire charger une invocation" (Charge #794),
    # "chuter les PV d'un Dofus à N" (SetDofusLife #151) or "invoquer une invocation
    # aléatoire coûtant N PA" (SummonToken #1067). (parse_banish_payload authors the
    # non-bindata ones.)
    if not re.search(r"infliger|[êe]tre\s+invoqu|chuter\s+[àa]\s+\d+\s+l['’\s]*at|faire\s+charger|chuter\s+les\s+pv\s+d['’]un\s+dofus|invoquer\s+une\s+invocation\s+al[ée]atoire", m.group(2)):
        return None
    return {"type": "BanishDiscard", "count": int(m.group(1)) if m.group(1) else 1, "_authored": True}


def parse_banish_payload(card: dict):
    """Author the ‹effet› payload for "Bannit N … pour <X>" spells whose X has no
    bindata: Affaiblissement #657 "faire chuter à 1 l'AT d'une invocation" →
    SetAttack{value:1}; Sournoiserie #794 "faire charger une invocation de N cases"
    → Charge{cells:N}. Damage payloads use the DamageData bindata; summons need
    none. Returns a (possibly empty) list of effects to author before the
    BanishDiscard cost."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"chuter\s+[àa]\s+(\d+)\s+l['’\s]*at\s+d['’]une\s+invocation", s)
    if m:
        return [{"type": "SetAttack", "value": int(m.group(1)), "_authored": True}]
    m = re.search(r"faire\s+charger\s+une\s+invocation\s+de\s+(\d+)\s+cases?", s)
    if m:
        return [{"type": "Charge", "cells": int(m.group(1)), "_authored": True}]
    m = re.search(r"chuter\s+les\s+pv\s+d['’]un\s+dofus\s+[àa]\s+(\d+)", s)  # Sanction #151
    if m:
        return [{"type": "SetDofusLife", "value": int(m.group(1)), "_authored": True}]
    m = re.search(r"invoquer\s+une\s+invocation\s+al[ée]atoire\s+co[uû]tant\s+(\d+)\s*pa", s)  # Échange d'Âmes #1067
    if m:
        return [{"type": "SummonToken", "cost": int(m.group(1)), "amount": 1, "placement": "target", "_authored": True}]
    return []


def parse_cost_per_discard(card: dict):
    """Oscar Nak #198: "Coûte N PA de moins par carte dans votre défausse." gives
    CostPerDiscard {per:N} (a cost marker read by effectiveCost, never applied).
    Returns the dict or None."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"co[uû]te\s+(\d+)\s*pa\s+de\s+moins\s+par\s+carte\s+dans\s+votre\s+d[ée]fausse", s)
    if not m:
        return None
    return {"type": "CostPerDiscard", "per": int(m.group(1)), "_authored": True}


def parse_recover_self_to_hand(desc: str):
    """Baron Sramedi #243: "MORT : Remonte dans votre main si vous avez au moins N
    cartes dans votre défausse." gives a RecoverSelfToHand {condition: discardAtLeast N}
    marker (injected on the MORT trigger, read by resolveDeathsAndWin). Returns the
    effect dict or None."""
    s = strip_markup(desc)
    has_remonte = bool(re.search(r"remonte\s+dans\s+votre\s+main", s))
    has_retourne = bool(re.search(r"retourne\s+dans\s+votre\s+main", s))
    if not (has_remonte or has_retourne):
        return None
    # Shava Shavien #367: "remonte dans votre main OU dans celle de votre adversaire"
    # is a 50/50 coin flip (pile = your hand, face = the opponent's).
    if re.search(r"remonte\s+dans\s+votre\s+main\s+ou\s+dans\s+celle\s+de\s+votre\s+adversaire", s):
        return {"type": "RecoverSelfToHand", "coinToEnemy": True, "_authored": True}
    # Polter Tofu #358: "retourne dans votre main. il coûte 1 PA de plus" is an extra
    # cost that adds up (costDelta) on each return (resolveDeathsAndWin accumulates it).
    cm = re.search(r"co[ûu]te\s+(\d+)\s*pa\s+de\s+plus", s)
    if cm:
        return {"type": "RecoverSelfToHand", "costDelta": int(cm.group(1)), "_authored": True}
    # Without an extra cost, only "remonte" is modelled (with conditions). "retourne"
    # without an extra cost is a different mechanism and is left out.
    if not has_remonte:
        return None
    # Two modelled MORT-recover conditions: Baron Sramedi #243 (discard size) and
    # Julith Jurgen #488 (no Dofus destroyed). Other "remonte dans votre main" cards
    # use different mechanics (coins "… ou dans celle de l'adversaire" #367/#964,
    # low-PV #420/#161, recovering another creature #356) → still left out.
    m = re.search(r"au\s+moins\s+(\d+)\s+cartes?\s+dans\s+votre\s+d[ée]fausse", s)
    if m:
        return {"type": "RecoverSelfToHand", "condition": {"kind": "discardAtLeast", "value": int(m.group(1))}, "_authored": True}
    if re.search(r"tant\s+qu['’]?\s*aucun\s+de\s+vos\s+dofus.*n['’]?\s*a\s+[ée]t[ée]\s+d[ée]truit", s):
        return {"type": "RecoverSelfToHand", "condition": {"kind": "noDofusDestroyed"}, "_authored": True}
    return None


def parse_mort_recover_reserve(card: dict):
    """Missiz Frizz #474: "MORT : dépense N PA de votre réserve pour remonter dans
    votre main" gives [RecoverSelfToHand {condition:reserveAtLeast:N}, AddReserve {-N,
    requireCondition:reserveAtLeast:N}]. The creature goes back to the hand (not the
    discard) if the reserve is at least N, and N AP are spent."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"d[ée]pense\w*\s+(\d+)\s+pa\s+de\s+votre\s+r[ée]serve\s+pour\s+remonter\s+dans\s+votre\s+main", s)
    if not m:
        return None
    n = int(m.group(1))
    cond = {"kind": "reserveAtLeast", "value": n}
    return [{"type": "RecoverSelfToHand", "condition": dict(cond), "_authored": True},
            {"type": "AddReserve", "amount": -n, "requireCondition": dict(cond), "_authored": True}]


def parse_discount_next_card(desc: str):
    """La Folle #481 / Emma Cabre #963: "Réduit de N PA le coût de (votre|la)
    prochaine carte [jouée / que vous jouez]." → DiscountNextCard {amount:N}.
    Returns the dict or None."""
    s = strip_markup(desc)
    m = re.search(r"r[ée]duit\s+de\s+(\d+)\s*pa\s+le\s+co[uû]t\s+de\s+(?:votre|la)\s+prochaine\s+carte", s)
    if not m:
        return None
    return {"type": "DiscountNextCard", "amount": int(m.group(1)), "_authored": True}


def parse_discard_pays_cost(card: dict):
    """Repos Éternel #20: "Durant ce tour, ne dépensez pas de PA pour jouer vos
    cartes. À la place bannissez des cartes de votre défausse." gives SetDiscardPaysCost
    (a player-state flag for the turn). Returns the effect dict or None."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"ne\s+d[ée]pensez\s+pas\s+de\s+pa", s) and re.search(r"bannissez\s+des\s+cartes\s+de\s+votre\s+d[ée]fausse", s):
        return {"type": "SetDiscardPaysCost", "_authored": True}
    return None


def parse_give_active_trap(card: dict):
    """Piège Mortel #624 / Troublant #712 / Explosif #945: "Place un piège <X> activé
    dans la main de votre adversaire." gives GiveActiveTrap {trapCardId:<X Activé id>,
    counter:1, penalty:1} (1 turn, 1 damage to every Dofus of the holder). The matching
    Activé card is found with card_name_index. Returns the dict or None."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"place\s+un\s+(.+?)\s+dans\s+la\s+main\s+de\s+votre\s+adversaire", s)
    if not m:
        return None
    tid = card_name_index.get(norm_name(m.group(1).strip()))
    if tid is None:
        return None
    return {"type": "GiveActiveTrap", "trapCardId": tid, "counter": 1, "penalty": 1, "_authored": True}


def parse_active_trap_play(card: dict):
    """An "Activé" trap (spellType == "ActiveTrap"): replace its bindata (the
    CreateCardCounterData counter + the Dofus-penalty DamageData) with only the play
    effect the holder suffers if they play it, the counter/penalty are handled
    engine-side via the activeTrap entry. Returns the effect list or None.
      - "inflige N à vos invocations" → AoeDamage {scope:allies} (N = the DamageData
        before the counter), Piège Explosif Activé #671
      - "détruisez une de vos invocations" → Destroy (single allied target), #681
      - "piochez N cartes" → DrawCards {amount:N}, #950"""
    if card.get("spellType") != "ActiveTrap":
        return None
    s = strip_markup(card.get("description", ""))
    if "inflige" in s and re.search(r"[àa]\s+vos\s+invocations", s):
        dmg = None
        for e in (card.get("effects") or []):
            if e.get("type") == "CreateCardCounterData":
                break
            if e.get("type") == "DamageData" and isinstance(e.get("Damage"), int):
                dmg = e["Damage"]
        if dmg is not None:
            return [{"type": "AoeDamage", "amount": dmg, "scope": "allies", "_authored": True}]
    if re.search(r"d[ée]truisez\s+une\s+de\s+vos\s+invocations", s):
        return [{"type": "Destroy", "_authored": True}]
    m = re.search(r"piochez\s+(\d+)\s+cartes?", s)
    if m:
        return [{"type": "DrawCards", "amount": int(m.group(1)), "_authored": True}]
    return None


def parse_bombe_trap(card: dict):
    """Bombe #101, the only Sram board trap kept (the rest are flagged off). cardType
    Aoe, "Inflige @damage@", placed in your camp. → PlaceTrap {cardId, damage}
    (replaces the DamageData bindata; an enemy walking on it takes `damage`, an ally
    picks the card up). Matched narrowly by name so the flagged traps stay untouched.
    Returns the effect dict or None."""
    if card.get("cardType") != "Aoe" or (card.get("name") or "").strip().lower() != "bombe":
        return None
    dmg = next((e.get("Damage") for e in (card.get("effects") or []) if e.get("type") == "DamageData" and isinstance(e.get("Damage"), int)), None)
    if dmg is None:
        return None
    return {"type": "PlaceTrap", "cardId": card["id"], "damage": int(dmg), "_authored": True}


def parse_trigger_rally(card: dict):
    """Ralliement #1014 (the spell): "Permet à l'invocation ciblée de rallier une
    autre invocation possédant la compétence ralliement." gives TriggerRally (the cast
    target rallies now). Returns the effect dict or None."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"permet\s+[àa]\s+l['’]invocation\s+cibl[ée]e\s+de\s+rallier", s):
        return {"type": "TriggerRally", "_authored": True}
    return None


def parse_grant_armor_target(card: dict):
    """ "[APPARITION :] Confère/Donne +N armure à une [autre] invocation [alliée]"
    (Piou Rouge #52, Piou Bleu #568) gives BoostArmor {amount:N} (single target, like
    the similar "+N AR à une invocation" cards). The spec missed them because they
    write "armure" instead of "AR". "aux autres invocations" (plural, AoE) is not
    matched here. Returns the effect dict or None."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"(?:conf[èe]re|donne[zr]?)\s+\+?(\d+)\s+armure\s+[àa]\s+une\s+(?:autre\s+)?invocation", s)
    if not m:
        return None
    return {"type": "BoostArmor", "amount": int(m.group(1)), "_authored": True}


def parse_conditional_stat_family(card: dict):
    """ "Gagne +N (AT | portée | PM) tant que vous avez un(e) autre <famille> en jeu"
    (Bouftou #385 etc.) → ConditionalStatBoost {stat, amount, family}, continuous,
    recomputed by withAuras (which already excludes self). AR ("armure") is deferred
    (armor is a consumable pool, not a continuous stat); "une autre invocation"
    (no family) too. Returns the effect dict or None."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"gagne\s+\+?(\d+)\s+(at|port[ée]e|pm)\s+(?:tant\s+que|si)\s+vous\s+avez\s+une?\s+autre\s+(\w+?)\s+en\s+jeu", s)
    if not m:
        return None
    stat = {"at": "attack", "portee": "range", "portée": "range", "pm": "movement"}.get(m.group(2))
    if stat is None:
        return None
    sel = map_tutor_filter(m.group(3))
    if not sel or "family" not in sel:
        return None
    return {"type": "ConditionalStatBoost", "stat": stat, "amount": int(m.group(1)), "family": sel["family"], "_authored": True}


def parse_conditional_stat_condition(card: dict):
    """ "Gagne +N AT/PM/portée tant que/si <board condition>" gives a continuous
    ConditionalStatBoost whose condition withAuras checks against the live creatures
    (not a family or card in play):
      - "dans votre camp"                           -> inOwnCamp       (Exécuteur #1425)
      - "une invocation adverse ... devant elle"    -> enemyAheadOnRow (Canne Jalman #969)
      - "[au moins] une autre invocation ... blessée" -> woundedInPlay  (Requinou #11)
    AR ("ar") is not handled yet (armour is a pool that gets used up). Returns the
    dict or None."""
    s = strip_markup(card.get("description", ""))
    # "tant que <X>" but also the elided "tant qu'une / tant qu'il / tant qu'au".
    m = re.search(r"gagne\s+\+?(\d+)\s+(at|ar|pm|port[ée]e)\s+(?:tant\s+qu(?:e\s+|')|si\s+)(.+)", s)
    if not m:
        return None
    stat = {"at": "attack", "pm": "movement", "portee": "range", "portée": "range"}.get(m.group(2))
    if stat is None:
        return None  # AR deferred (consumable pool)
    clause = m.group(3)
    if re.search(r"dans\s+votre\s+camp", clause):
        cond = "inOwnCamp"
    elif re.search(r"invocation\s+adverse\s+.*devant", clause):
        cond = "enemyAheadOnRow"
    elif re.search(r"une\s+autre\s+invocation\s+est\s+bless", clause):
        cond = "woundedInPlay"
    else:
        return None
    return {"type": "ConditionalStatBoost", "stat": stat, "amount": int(m.group(1)), "condition": cond, "_authored": True}


def parse_conditional_armor(card: dict):
    """ "Gagne +N AR tant que vous avez un(e) [autre] <famille | carte> en jeu"
    (Rat Devil #387 with a Rat Dechant #91; Boufton Noir #559 with another Gobbal).
    Unlike ConditionalStatBoost (AT/PM/portée, recomputed all the time), AR is a pool
    that gets used up, so this works on transitions: the engine gives +N once when the
    condition becomes true and removes it (down to 0) when it becomes false. The
    subject resolves to a family (map_tutor_filter, e.g. "bouftou" to Gobbal, the card
    itself excluded by instanceId) or else to a specific card (card_name_index, e.g.
    "rat dechant" to #91). Only the passive "tant que" wording: the one-shot
    "APPARITION : gagne +1 AR SI ..." (Sono Sino #321) is a summon trigger handled
    elsewhere, and matching it here would give the bonus twice. Returns dict or None."""
    s = strip_markup(card.get("description", ""))
    if "apparition" in s:
        return None
    m = re.search(r"gagne\s+\+?(\d+)\s+ar\s+tant\s+que\s+vous\s+avez\s+une?\s+(?:autre\s+)?(.+?)\s+en\s+jeu", s)
    if not m:
        return None
    eff = {"type": "ConditionalArmorWhileAlly", "amount": int(m.group(1)), "_authored": True}
    subj = m.group(2).strip()
    sel = map_tutor_filter(subj)
    if sel and "family" in sel:
        eff["family"] = sel["family"]
        return eff
    cid = card_name_index.get(norm_name(subj))
    if cid is not None:
        eff["cardId"] = cid
        return eff
    return None


def parse_enemy_hand_surcharge(card: dict):
    """ Ralentissement #188: "Augmente de N PA le coût des cartes de la main adverse
    courante pendant 1 tour." gives EnemyHandSurcharge {amount:N}, a temporary +N on the
    opponent's current hand that ends at the end of their next turn (stored in
    PlayerState.handCostTempMods, cleared in endTurn). The "courante / pendant 1 tour"
    duration is built into the engine, so only the surcharge clause is matched.
    Returns the effect dict or None."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"augmente\s+de\s+(\d+)\s+pa\s+le\s+co[ûu]t\s+des\s+cartes\s+de\s+la\s+main\s+adverse", s)
    if not m:
        return None
    return {"type": "EnemyHandSurcharge", "amount": int(m.group(1)), "_authored": True}


def parse_banish_all_discards(card: dict):
    """ Nécro Phorreur #1221: "Tant qu'il est en jeu, les cartes défaussées sont bannies
    à la place." gives a BanishAllDiscards marker (passive while in play).
    resolveDeathsAndWin moves both players' discards into `banished` while a living
    carrier is on the board. Not the same as BanishDiscard (the Sram cost "bannit les N
    dernières cartes parties dans la défausse ..."). Returns the effect dict or None."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"cartes\s+d[ée]fauss\w+\s+sont\s+bannies", s):
        return {"type": "BanishAllDiscards", "_authored": True}
    return None


def parse_protect_dofus(card: dict):
    """ Lien de Sang #1495: "Choisissez une invocation alliée pour qu'elle protège un
    dofus. Elle subira les dégâts à sa place." gives ProtectDofus, a two-step spell
    (first pick an allied creature, then an allied dofus) that links the creature to
    the dofus, so the dofus damage goes to the creature. Returns the effect dict or None."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"prot[èe]ge\s+un\s+dofus", s) and re.search(r"subira\s+les\s+d[ée]g[âa]ts\s+[àa]\s+sa\s+place", s):
        return {"type": "ProtectDofus", "_authored": True}
    return None


def parse_guard_creature(card: dict):
    """ Garde du corps (Silas #320, Bould Erdash #300): the bare keyword "garde du corps"
    → an APPARITION that picks an ally creature to protect (GuardCreature). The bodyguard
    then receives that creature's damage in its place. Returns the effect dict or None."""
    if card.get("cardType") != "Summon":
        return None
    s = strip_markup(card.get("description", "")).strip().lower()
    if re.match(r"garde\s+du\s+corps\b", s):
        return {"type": "GuardCreature", "_authored": True}
    return None


def parse_transform_target(card: dict):
    """ "[APPARITION :] Transformez une invocation en <token>" (Magmog #44) →
    Transform {tokenId, asOwner:"keep"} (targeted, the player picks a creature, which
    keeps its owner). Resolves <token> via summon_name_index. Returns dict or None."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"transforme[zr]?\s+une\s+invocation\s+en\s+(.+?)\.?$", s)
    if not m:
        return None
    tid = summon_name_index.get(norm_name(m.group(1).strip()))
    if tid is None:
        return None
    return {"type": "Transform", "tokenId": tid, "asOwner": "keep", "_authored": True}


def parse_grant_armor_other_allies(card: dict):
    """ "[…] Donne/Confère +N (AR|armure) aux autres invocations alliées" (Bump
    #792/#927/#1823) → BoostArmor {amount:N, scope:"allies", excludeSelf} (AoE, no
    pick). Returns the effect dict or None."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"(?:conf[èe]re|donne[zr]?)\s+\+?(\d+)\s+(?:ar|armure)\s+aux\s+autres\s+invocations\s+alli[ée]es", s)
    if not m:
        return None
    return {"type": "BoostArmor", "amount": int(m.group(1)), "scope": "allies", "excludeSelf": True, "_authored": True}


def parse_heal_other_allies(card: dict):
    """ "Soigne vos autres <invocations | famille> de N PV" → Heal {amount:N,
    scope:allies, excludeSelf, family?}. Boufette #32 (vos autres bouftous), etc.
    Returns the effect dict or None (unknown family word → defer)."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"soigne\s+vos\s+autres\s+(\w+?)\s+de\s+(\d+)\s+pv", s)
    if not m:
        return None
    word = m.group(1)
    eff = {"type": "Heal", "amount": int(m.group(2)), "scope": "allies", "excludeSelf": True, "_authored": True}
    if word not in ("invocations", "invocation"):
        sel = map_tutor_filter(word)
        if not sel or "family" not in sel:
            return None
        eff["family"] = sel["family"]
    return eff


def parse_self_charge(card: dict):
    """ "APPARITION : charge de N cases." (Corbac #56, Moogrron #191, Tofu Noir #244,
    Piou Vert #375, fixed N only) → SelfCharge {cells:N} marker (read by
    summonCreature). Conditional / dynamic charges ("… si …", "… par …", "d'autant …")
    are deferred. Returns the dict or None."""
    s = strip_markup(card.get("description", "")).strip()
    # Purpuce #34: "charge jusqu'au dofus adverse [puis meurt]." → toWall (+ thenDie).
    m = re.match(r"apparition\s*:\s*charge\s+jusqu['’\s]*au\s+dofus\s+adverse(\s+puis\s+meur\w*)?\s*\.?\s*$", s)
    if m:
        eff = {"type": "SelfCharge", "cells": "toWall", "_authored": True}
        if m.group(1):
            eff["thenDie"] = True
        return eff
    # Fixed N: "charge de N cases."
    m = re.match(r"apparition\s*:\s*charge\s+de\s+(\d+)\s+cases?\s*\.?\s*$", s)
    if m:
        return {"type": "SelfCharge", "cells": int(m.group(1)), "_authored": True}
    # Dynamic count: "charge d'autant de cases que vous avez de[s]/d'[autres] <fam> en jeu"
    m = re.match(r"apparition\s*:\s*charge\s+d['’]autant\s+de\s+cases?\s+que\s+vous\s+avez\s+(?:de\s+|des\s+|d['’])(autres\s+)?(\w+?)\s+en\s+jeu\s*\.?\s*$", s)
    if m:
        sel = map_tutor_filter(m.group(2))
        if not sel or "family" not in sel:
            return None
        cs = {"scope": "allies", "family": sel["family"]}
        if m.group(1):
            cs["excludeSelf"] = True
        return {"type": "SelfCharge", "cells": {"count": cs, "per": 1}, "_authored": True}
    # "charge d'autant de cases qu'il y a d'invocations adverses en jeu"
    if re.match(r"apparition\s*:\s*charge\s+d['’]autant\s+de\s+cases?\s+qu['’]il\s+y\s+a\s+d['’]invocations\s+adverses\s+en\s+jeu", s):
        return {"type": "SelfCharge", "cells": {"count": {"scope": "enemies"}, "per": 1}, "_authored": True}
    # "charge de N cases par <fam> alliée en jeu"
    m = re.match(r"apparition\s*:\s*charge\s+de\s+(\d+)\s+cases?\s+par\s+(\w+?)\s+alli[ée]e?s?\s+en\s+jeu", s)
    if m:
        sel = map_tutor_filter(m.group(2))
        if not sel or "family" not in sel:
            return None
        return {"type": "SelfCharge", "cells": {"count": {"scope": "allies", "family": sel["family"]}, "per": int(m.group(1))}, "_authored": True}
    # Conditional: "charge de N cases si vous avez une <fam> en jeu". excludeSelf when
    # the card itself belongs to that family (a Moogrr needs another moogrr).
    m = re.match(r"apparition\s*:\s*charge\s+de\s+(\d+)\s+cases?\s+si\s+vous\s+avez\s+une?\s+(\w+?)\s+en\s+jeu", s)
    if m:
        sel = map_tutor_filter(m.group(2))
        if not sel or "family" not in sel:
            return None
        cond = {"kind": "allyFamilyInPlay", "family": sel["family"]}
        if sel["family"] in (card.get("families") or []):
            cond["excludeSelf"] = True
        return {"type": "SelfCharge", "cells": int(m.group(1)), "condition": cond, "_authored": True}
    # Conditional: "charge de N cases si une invocation adverse se trouve devant lui"
    m = re.match(r"apparition\s*:\s*charge\s+de\s+(\d+)\s+cases?\s+si\s+une\s+invocation\s+adverse\s+se\s+trouve\s+devant\s+lui", s)
    if m:
        return {"type": "SelfCharge", "cells": int(m.group(1)), "condition": {"kind": "enemyAheadOnRow"}, "_authored": True}
    return None


def parse_apparition_dice_charge(card: dict):
    """Defhi Croquets #319: "APPARITION : Charge de 1d6 case(s)." → a ChargeSelf
    {cells:{dice:"NdM"}} on the APPARITION trigger. The creature advances a random
    NdM cells the instant it lands; runTrigger rolls the die from the seeded RNG,
    firing the Ecaflip roll reactions like any dice card, and resolves the cells.
    Distinct from parse_self_charge's fixed-N SelfCharge marker: a dice charge must
    roll through the trigger path. Returns the effect dict or None."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"apparition\s*:\s*charge\s+de\s+(\d*d\d+)\s+cases?", s)
    if not m:
        return None
    return {"type": "ChargeSelf", "cells": {"dice": m.group(1)}, "_authored": True}


def parse_bounce_below_pv(card: dict):
    """Arakne Spectrale #420 / Grougaloragran #161: "Remonte dans votre main s'il
    [tombe à N PV ou moins / lui reste N PV]." → BounceBelowPv {threshold}, a marker
    fireContreCoup reads (reduced to ≤ threshold but alive → back to hand). Requires
    a PV threshold so the other "remonte dans votre main" cards (coins #367/#964,
    Dofus #488, another-creature #356) stay out. Returns the dict or None."""
    s = strip_markup(card.get("description", ""))
    if "remonte dans votre main" not in s:
        return None
    m = re.search(r"tombe\s+[àa]\s+(\d+)\s+pv\s+ou\s+moins", s) or re.search(r"s['’]?il\s+lui\s+reste\s+(\d+)\s+pv", s)
    if not m:
        return None
    return {"type": "BounceBelowPv", "threshold": int(m.group(1)), "_authored": True}


def parse_ralliement_keyword(card: dict):
    """Féca RALLIEMENT keyword: a Summon whose description STARTS with "ralliement"
    carries the keyword → SetPropertyData {PropertyType:"Ralliement"} so
    summonCreature seeds the property (applyRally reads it). The spell #1014
    "Ralliement" ("permet à l'invocation … de rallier") and reaction texts ("quand
    une invocation la rallie") do not start with the bare keyword, so they are left
    out. Returns the dict or None."""
    if card.get("cardType") != "Summon":
        return None
    s = strip_markup(card.get("description", "")).strip()
    # "ralliement" appears as a keyword word in the leading keyword prefix, possibly
    # after other keywords ("fratrie ralliement …", "nécrome ralliement …"), not only
    # as the very first word. Limited to the first 3 words so a deep "… compétence
    # ralliement" (the spell #1014, a Spell anyway) never matches.
    if not re.match(r"(?:\w+\s+){0,2}ralliement\b", s):
        return None
    return {"type": "SetPropertyData", "PropertyType": "Ralliement", "_authored": True}


def parse_banish_own_discard(desc: str):
    """Emma Cabre #963: "Bannit N carte(s) de votre défausse" (the effect, not the
    "bannit les N dernières ... parties ... pour <X>" play cost) gives BanishOwnDiscard
    {count:N}, which banishes the N most recent cards of the discard. Returns the dict
    or None."""
    s = strip_markup(desc)
    if "parties" in s or re.search(r"d[ée]fausse\s+pour", s):  # that is the play-cost pattern
        return None
    m = re.search(r"bannit\s+(\d+)\s+cartes?\s+de\s+votre\s+d[ée]fausse", s)
    if not m:
        return None
    return {"type": "BanishOwnDiscard", "count": int(m.group(1)), "_authored": True}


def parse_recover_family_discard(card: dict):
    """Armée des Ombres #539: "Récupère les <famille>s de votre défausse." →
    RecoverFromDiscard {family, all:true} (pulls every matching card from the
    discard back to hand). Resolves <famille> via map_tutor_filter. Returns the
    dict or None."""
    s = strip_markup(card.get("description", ""))
    # "récupère LES <famille> de votre défausse" → toutes (all)
    m = re.search(r"r[ée]cup[èe]re\s+les\s+(\w+?)s?\s+de\s+votre\s+d[ée]fausse", s)
    if m:
        sel = map_tutor_filter(m.group(1))
        if sel and "family" in sel:
            return {"type": "RecoverFromDiscard", "family": sel["family"], "all": True, "_authored": True}
    # "récupère(z) UN(E) <famille> ALÉATOIRE de votre défausse": a random one
    # (Bébé Phorreur d'Argent #1336 for Phorreur, Roi Gelax #113 for Gelée/Jelly).
    m = re.search(r"r[ée]cup[éèe]re[zr]?\s+une?\s+(\w+?)\s+al[ée]atoire\s+de\s+votre\s+d[ée]fausse", s)
    if m:
        sel = map_tutor_filter(m.group(1))
        if sel and "family" in sel:
            return {"type": "RecoverFromDiscard", "family": sel["family"], "which": "random", "_authored": True}
    return None


def parse_recover_discard_trigger(card: dict):
    """APPARITION creatures that recover from their own discard:
      - "récupère le dernier sort parti dans votre défausse" (Bakara #418)
            -> RecoverFromDiscard {spell, which:last}
      - "récupère 1 carte aléatoire de votre défausse" (Phorreur Domestique #255)
            -> RecoverFromDiscard {which:random}
    The 2-spell variant (#262 "les 2 derniers sorts") and the both-discards variant
    (#303 "la défausse de chaque joueur") are not handled yet."""
    s = strip_markup(card.get("description", ""))
    # #303: "le dernier sort parti dans la défausse de chaque joueur" (both discards).
    # Checked before #418: they do not overlap, but this one is more specific.
    if re.search(r"r[ée]cup[èe]re\s+le\s+dernier\s+sort\s+parti\s+dans\s+la\s+d[ée]fausse\s+de\s+chaque\s+joueur", s):
        return {"type": "RecoverFromDiscard", "spell": True, "eachPlayer": True, "which": "last", "_authored": True}
    # #262: "les N derniers sorts partis dans votre défausse".
    m = re.search(r"r[ée]cup[èe]re\s+les\s+(\d+)\s+derniers?\s+sorts?\s+partis?\s+dans\s+votre\s+d[ée]fausse", s)
    if m:
        return {"type": "RecoverFromDiscard", "spell": True, "count": int(m.group(1)), "_authored": True}
    # #418 / Sphincter Cell #18: "le dernier <X> parti dans votre défausse".
    # X="sort" gives a spell filter, otherwise a family ("le dernier rat" gives {family:Rat}).
    m = re.search(r"r[ée]cup[èe]re\s+le\s+dernier\s+(\w+)\s+parti\s+dans\s+votre\s+d[ée]fausse", s)
    if m:
        if m.group(1) == "sort":
            return {"type": "RecoverFromDiscard", "spell": True, "which": "last", "_authored": True}
        sel = map_tutor_filter(m.group(1))
        if sel and "family" in sel:
            return {"type": "RecoverFromDiscard", "family": sel["family"], "which": "last", "_authored": True}
    # #255: "1 carte aléatoire de votre défausse" (no type filter).
    if re.search(r"r[ée]cup[èe]re\s+1\s+carte\s+al[ée]atoire\s+de\s+votre\s+d[ée]fausse", s):
        return {"type": "RecoverFromDiscard", "which": "random", "_authored": True}
    # Fripon #73: "1 carte aléatoire de la défausse ADVERSE" → from the opponent's
    # discard into the caster's hand.
    if re.search(r"r[ée]cup[èe]re\s+1\s+carte\s+al[ée]atoire\s+de\s+la\s+d[ée]fausse\s+adverse", s):
        return {"type": "RecoverFromDiscard", "which": "random", "fromEnemy": True, "_authored": True}
    return None


def parse_tutor_family_trigger(card: dict):
    """ "<trigger> : Place dans votre main le premier/la prochaine <famille> de
    votre pioche [si votre défausse n'est pas vide]" (Sufod #273) → a TutorFromDeck
    {family, from:top} on the detected trigger, optionally gated by a
    requireCondition (discardAtLeast). Rejects the cost-set rider (#227 "coûtant N
    PA", deferred). Returns the effect dict or None."""
    s = strip_markup(card.get("description", ""))
    # The verb is "place dans votre main" (Sufod #273) or "pioche" (Clustus #174
    # "pioche les 2 premiers coffres"), with an optional count "les N premiers".
    m = re.search(
        r"(?:place\s+dans\s+votre\s+main|pioche)\s+(?:le|la|les?)\s+(\d+)?\s*(?:premiers?|prochaines?|prochains?)\s+(?:carte\s+)?(.+?)\s+de\s+votre\s+pioche",
        s,
    )
    if not m or re.search(r"co[uû]tant", s):
        return None
    sel = map_tutor_filter(m.group(2).strip())
    if not (sel and "family" in sel):
        return None
    amount = int(m.group(1)) if m.group(1) else 1
    eff = {"type": "TutorFromDeck", "from": "top", "amount": amount, **sel, "_authored": True}
    if re.search(r"si\s+votre\s+d[ée]fausse\s+n'?est\s+pas\s+vide", s):
        eff["requireCondition"] = {"kind": "discardAtLeast", "value": 1}
    return eff


def parse_coup_de_grace_bounce(card: dict):
    """Qilby #496/#275/#235: "COUP DE GRÂCE : remonte l'invocation adverse dans
    votre main." → a BounceKilledToHand marker (the killed enemy goes to the
    killer's hand, handled by fireCoupDeGrace which knows the victim). Only the
    COUP_DE_GRACE wording, the trigger gate is applied at the injection site."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"remonte\s+l'invocation\s+adverse\s+dans\s+votre\s+main", s):
        return {"type": "BounceKilledToHand", "_authored": True}
    return None


def parse_damage_dofus_on_row(card: dict):
    """ "<trigger> : inflige N dégât au dofus adverse [de sa ligne]" gives DamageDofusOnRow {amount:N}
    (hits the enemy Dofus on the source's own row, "celui de sa ligne"). Jèms Blond #340
    (COUP_DE_GRACE), Merkator #412 (CONTRE_COUP), Lumino #325 (FIN_DE_TOUR, only with an
    "autre <famille> en jeu" condition). The injection site gets the trigger kind from
    detect_trigger_kind and puts the effect (and requireCondition) on that slot.
    Returns N or None."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"inflige\s+(\d+)\s*d[ée]g[âa]ts?\s+au\s+dofus\s+adverse", s)
    return int(m.group(1)) if m else None


def parse_enemy_draws(card: dict):
    """ "<trigger> : [piochez N cartes, ] votre adversaire pioche M cartes"
    (Maskemane #424, Phorreur #168, Megathon #159, Slek #269) → a list of DrawCards.
    The enemy-draw clause ("(votre) adversaire pioche M") → DrawCards {side:enemy};
    a self-draw ("piochez N") that precedes it (Slek) is prepended. Returns the
    list in text order, or None if there is no enemy-draw clause. The trigger kind
    is detected separately at the injection site."""
    s = strip_markup(card.get("description", ""))
    em = re.search(r"(?:votre\s+)?adversaire\s+pioche\s+(\d+)\s*cartes?", s)
    if not em:
        return None
    out = []
    sm = re.search(r"piochez\s+(\d+)\s*cartes?", s)
    if sm and sm.start() < em.start():
        out.append({"type": "DrawCards", "amount": int(sm.group(1)), "_authored": True})
    out.append({"type": "DrawCards", "amount": int(em.group(1)), "side": "enemy", "_authored": True})
    return out


def parse_ally_death(card: dict):
    """ "<effet> quand un[e] [<famille>] allié[e] / de vos <famille|invocations>
    meurt" gives effects on a MORT_ALLIEE trigger (fired by resolveDeathsAndWin when a
    creature of the same side dies; an optional `filter:{family}` limits it to deaths
    of that family: Bébé Phorreur #1478 "un Phorreur allié", Tofukaz #167 "un de vos
    tofus"). The effect clause comes before "quand":
      - "gagne +N AT [et +M AR/PM]"                 -> self BoostAttack/Armor/Movement
      - "soigne vos autres invocations de N PV"     -> Heal {scope:allies[, excludeSelf]}
      - "piochez N carte(s)" (Necrom l'Ancien #411) -> DrawCards
    Returns {"effects":[...], "filter":{family}|None} or None."""
    s = strip_markup(card.get("description", ""))
    # "meurt" and "est/sont détruit(e)(s)" are synonyms for the same MORT_ALLIEE
    # event (Phorreur Royal #1356 uses the latter).
    qm = re.search(r"quand\s+(.+?)\s+(?:meur\w*|(?:est|sont)\s+d[ée]truit\w*)", s)
    if not qm:
        return None
    subj = qm.group(1)
    if "alli" not in subj and "de vos" not in subj:
        return None  # must be an allied death (not a bare "quand une invocation meurt")
    # Optional family: the noun after "un[e] [de vos]", generic "invocation" = none.
    family = None
    fm = re.search(r"un[e]?\s+(?:de\s+vos\s+)?(\w+?)s?\s+(?:alli[ée]e?\s+)?$", subj.strip() + " ")
    if fm and fm.group(1) not in ("invocation",):
        sel = map_tutor_filter(fm.group(1))
        if sel and "family" in sel:
            family = sel["family"]
    head = s[:qm.start()]
    effs = []
    gm = re.search(r"gagne\s+(.+)", head)
    if gm:
        for amt, stat in re.findall(r"\+?\s*(\d+)\s*(at|ar|pm)\b", gm.group(1)):
            et = {"at": "BoostAttack", "ar": "BoostArmor", "pm": "BoostMovement"}[stat]
            effs.append({"type": et, "amount": int(amt), "self": True, "_authored": True})
    hm = re.search(r"soigne\s+vos\s+(autres\s+)?invocations\s+de\s+(\d+)\s*pv", head)
    if hm:
        eff = {"type": "Heal", "amount": int(hm.group(2)), "scope": "allies", "_authored": True}
        if hm.group(1):
            eff["excludeSelf"] = True
        effs.append(eff)
    dm = re.search(r"piochez\s+(une|\d+)\s*cartes?", head)
    if dm:
        effs.append({"type": "DrawCards", "amount": 1 if dm.group(1) == "une" else int(dm.group(1)), "_authored": True})
    # "ajoute un <card> à votre main" → AddCardToHand (Wabbit GM #150 "un Wabbit Tados").
    am = re.search(r"ajoute\s+(?:un|une|1)\s+(.+?)\s+[àa]\s+votre\s+main", head)
    if am:
        cid = resolve_card(am.group(1).strip())
        if cid:
            effs.append({"type": "AddCardToHand", "cardId": cid, "amount": 1, "_authored": True})
    # "récupérez une carte aléatoire de votre défausse" → RecoverFromDiscard
    # {which:random} (Phorreur Royal #1356).
    if re.search(r"r[ée]cup[ée]r\w*\s+une\s+carte\s+al[ée]atoire\s+de\s+votre\s+d[ée]fausse", head):
        effs.append({"type": "RecoverFromDiscard", "which": "random", "_authored": True})
    if not effs:
        return None
    return {"effects": effs, "filter": {"family": family} if family else None}


def parse_enters_play_react(card: dict):
    """ "gagne +N AT [et +M AR/PM] quand <filtre> entre en jeu" (Welsh #278,
    Gzenah #421, Gelée Framboise #437) gives self stat boosts on an ENTERS_PLAY trigger
    with a `filter` {side, family?}. <filtre>:
      - "une invocation adverse"      -> {side:enemy}
      - "un/une <famille> allié(e)"   -> {side:ally, family}
    Returns {"effects":[...], "filter":{...}} or None. The row-changing Truches
    ("change de ligne ..."), Moogrr (#548 "une AUTRE de vos moogrrs", no "allié" and a
    charge rider) and the cards that buff the newcomer (#289/#500 "gagnent") do not
    match (no clean self buff with a filter)."""
    s = strip_markup(card.get("description", ""))
    # "entre en jeu" and "est invoqué(e)(s)" are synonyms for the same ENTERS_PLAY
    # event (Tofu Ventripotent #94 uses the latter).
    m = re.search(r"quand\s+(.+?)\s+(?:entre\s+en\s+jeu|(?:est|sont)\s+invoqu\w*)", s)
    if not m:
        return None
    who = m.group(1)
    filt = None
    if re.search(r"invocation\s+adverse", who):
        filt = {"side": "enemy"}
    else:
        # "un/une <famille> allié(e)"  or  "un/une [autre] de vos <famille>"
        # (Tofu #94 "un de vos tofus", Moogrr #548 "une autre de vos moogrrs").
        fm = re.search(r"(?:un|une)\s+(.+?)\s+alli[ée]e?\b", who)
        if not fm:
            fm = re.search(r"(?:un|une)\s+(?:autre\s+)?de\s+vos\s+(\w+)", who)
        if fm:
            sel = map_tutor_filter(fm.group(1).strip())
            if sel and "family" in sel:
                filt = {"side": "ally", "family": sel["family"]}
    if filt is None:
        return None
    # The effect clause sits before "quand". "change de ligne" → ChangeRowSelf;
    # "gagne +N AT/AR/PM" → self boosts; "puis charge [de N cases]" → ChargeSelf
    # (Moogrr #548 "gagne +1 AT puis charge de 1 case"). A CHEF clause's "+N à vos
    # autres truches" (#801) carries no "gagne", so it is left to parse_chief_aura.
    head = s[:m.start()]
    effs = []
    if re.search(r"change\s+de\s+ligne", head):
        effs.append({"type": "ChangeRowSelf", "_authored": True})
    gm = re.search(r"\bgagne\s+([^.]+)", head)
    if gm:
        for amt, stat in re.findall(r"\+?\s*(\d+)\s*(at|ar|pm)\b", gm.group(1)):
            et = {"at": "BoostAttack", "ar": "BoostArmor", "pm": "BoostMovement"}[stat]
            effs.append({"type": et, "amount": int(amt), "self": True, "_authored": True})
    cm = re.search(r"\bcharge(?:\s+de\s+(\d+)\s*cases?)?", head)
    if cm:
        ce = {"type": "ChargeSelf", "_authored": True}
        if cm.group(1):
            ce["cells"] = int(cm.group(1))
        effs.append(ce)
    if not effs:
        return None
    return {"effects": effs, "filter": filt}


def parse_enters_play_damage(card: dict):
    """Julith Jurgen #432: "Inflige N dégât(s) aux invocations adverses qui entrent
    en jeu." is a continuous reaction: each enemy creature that enters play takes N.
    Modelled as an ENTERS_PLAY trigger {entrant:True, filter:{side:"enemy"},
    effects:[DamageData{N}]}: the effects target the creature that enters (`entrant`
    path), not the one reacting. It stacks on its own (with 2 Julith the newcomer
    takes 2, each Julith firing its own reaction).

    Only matches "inflige N dégât(s) aux invocations adverses qui entrent en jeu": the
    other Julith Jurgen (#352 "quand un Dofus allié subit des dégâts", #488 MORT) do
    not contain "qui entrent en jeu" and return None.
    Returns {"effects":[DamageData{N}], "filter":{side:"enemy"}} or None."""
    s = strip_markup(card.get("description", ""))
    m = re.search(
        r"inflige\s+(\d+)\s*d[ée]g[âa]ts?\s+aux\s+invocations\s+adverses\s+qui\s+entrent\s+en\s+jeu",
        s,
    )
    if not m:
        return None
    n = int(m.group(1))
    return {"effects": [{"type": "DamageData", "Damage": n}], "filter": {"side": "enemy"}}


def parse_enters_play_entrant(card: dict):
    """Grany #289 / Shin Larve #500: "vos [autres] <famille> gagnent +N (AT|AR) [et
    chargent] quand ils/elles entrent en jeu" gives an ENTERS_PLAY trigger {entrant:True,
    filter:{side:ally, family}, effects:[buffs (+ Charge)]}. The bonus is permanent and
    goes to the creature of the family that enters, not to the lord itself."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"vos\s+(?:autres\s+)?(\w+?)s?\s+gagnent\s+(.+?)\s+quand\s+(?:ils|elles)\s+entrent\s+en\s+jeu", s)
    if not m:
        return None
    fam = family_by_lower.get(m.group(1).lower())
    if not fam:
        return None
    body = m.group(2)
    effs = []
    for amt, stat in re.findall(r"\+?\s*(\d+)\s*(at|ar)\b", body):
        effs.append({"type": "BoostAttack" if stat == "at" else "BoostArmor", "amount": int(amt), "_authored": True})
    if re.search(r"chargent?\b", body):
        effs.append({"type": "Charge", "cells": 1, "_authored": True})
    if not effs:
        return None
    return {"trigger": "ENTERS_PLAY", "entrant": True, "filter": {"side": "ally", "family": fam}, "effects": effs, "_authored": True}


def parse_kriss_boufballe(card: dict):
    """Kriss La Krass #341/#967/#611: "APPARITION : ajoutez 1 Boufballe à la main de
    votre adversaire. Jouez gratuitement vos Boufballes" gives an APPARITION
    AddCardToHand {cardId:1137, side:enemy} and a passive CardCostAura {free, cardId:1137}
    (Boufballe #1137 costs 0 AP while Kriss is in play). Returns {apparition, aura} or None."""
    s = strip_markup(card.get("description", ""))
    if not re.search(r"ajoutez\s+1\s+boufballe\s+[àa]\s+la\s+main\s+de\s+votre\s+adversaire", s):
        return None
    if not re.search(r"jouez\s+gratuitement\s+vos\s+boufballes", s):
        return None
    return {
        "apparition": {"type": "AddCardToHand", "cardId": 1137, "amount": 1, "side": "enemy", "_authored": True},
        "aura": {"type": "CardCostAura", "free": True, "cardId": 1137, "_authored": True},
    }


def parse_damage_reaction(card: dict):
    """ "<charge [de N cases] | gagne +N AT/AR/PM> quand|lorsqu' <X> subit des
    dégâts / est blessé(e)" gives an ON_DAMAGE trigger with a `filter` on the damaged
    entity and a self effect. <X>:
      - "un <famille> allié"                          -> {side:ally, family}
      - "[une autre] de vos invocations [ou ... Dofus]" -> {side:ally, excludeSelf[, includeDofus]}
      - "une autre invocation"                        -> {excludeSelf} (any side, not itself)
    Chacha Teigne #732, Requin Lancier #33, Jet le Pied Volant #158. Self damage
    ("quand IL subit des dégâts") gives no filter, so None (that is CONTRE_COUP)."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"(?:quand|lorsqu')\s*(.+?)\s+(?:subit\s+des\s+d[ée]g[âa]ts|(?:est|sont)\s+bless\w+)", s)
    if not m:
        return None
    who, head = m.group(1), s[:m.start()]
    filt = None
    fm = re.search(r"(?:un|une)\s+(\w+)\s+alli[ée]e?\b", who)
    if fm:
        sel = map_tutor_filter(fm.group(1))
        if sel and "family" in sel:
            filt = {"side": "ally", "family": sel["family"]}
    if filt is None and re.search(r"de\s+vos\s+invocations?", who):
        filt = {"side": "ally", "excludeSelf": True}
        if "dofus" in who:
            filt["includeDofus"] = True
    if filt is None and re.search(r"autre\s+invocation", who):
        filt = {"excludeSelf": True}
    if filt is None:
        return None
    effs = []
    gm = re.search(r"\bgagne\s+([^.]*)", head)
    if gm:
        for amt, stat in re.findall(r"\+?\s*(\d+)\s*(at|ar|pm)\b", gm.group(1)):
            et = {"at": "BoostAttack", "ar": "BoostArmor", "pm": "BoostMovement"}[stat]
            effs.append({"type": et, "amount": int(amt), "self": True, "_authored": True})
    cm = re.search(r"\bcharge(?:\s+de\s+(\d+)\s*cases?)?", head)
    if cm:
        ce = {"type": "ChargeSelf", "_authored": True}
        if cm.group(1):
            ce["cells"] = int(cm.group(1))
        effs.append(ce)
    if not effs:
        return None
    return {"effects": effs, "filter": filt}


def parse_draw_reaction(card: dict):
    """ "gagne +N AT/AR/PM quand vous piochez [une carte]" → self stat boost(s) on
    an ON_DRAW trigger (fired by drawCard for the owner). Phorreur Furieux #951."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"(.+?)\s+quand\s+vous\s+piochez", s)
    if not m:
        return None
    gm = re.search(r"gagne\s+(.+)", m.group(1))
    if not gm:
        return None
    effs = []
    for amt, stat in re.findall(r"\+?\s*(\d+)\s*(at|ar|pm)\b", gm.group(1)):
        et = {"at": "BoostAttack", "ar": "BoostArmor", "pm": "BoostMovement"}[stat]
        effs.append({"type": et, "amount": int(amt), "self": True, "_authored": True})
    return {"effects": effs} if effs else None


def parse_stamp_cost_reduction(card: dict):
    """ "Tous vos/tes <sorts|invocations|cartes> [de votre jeu] coûtent N PA de moins
    jusqu'à ce qu'ils soient défaussés" → StampCostReduction {scope, amount} on the
    detected trigger (HORDE APPARITION). Wagnar #737 (sorts), Vampyro #779
    (invocations), #697 (toutes les cartes). Reuses the HORDE per-card cost-mod
    model (the "jusqu'à défausse" persistence is inherent to that model)."""
    s = strip_markup(card.get("description", ""))
    m = re.search(
        r"tou(?:s|te|tes)\s+(?:vos|tes|les)\s+(sorts?|invocations?|cartes?)\s+"
        r"(?:de\s+votre\s+jeu\s+)?co[uû]tent\s+(\d+)\s*pa\s+de\s+moins", s)
    if m:
        scope = {"sort": "spell", "invocation": "summon", "carte": "all"}.get(m.group(1).rstrip("s"))
        if scope:
            return {"type": "StampCostReduction", "scope": scope, "amount": int(m.group(2)), "_authored": True}
    # "les cartes <classe> de votre jeu coûtent N PA de moins" (Nouvelle Vague #1213,
    # a one-shot Spell): stamped by god/class ("fécas" is the Feca class).
    mf = re.search(r"les\s+cartes\s+(\w+)\s+(?:de\s+votre\s+(?:jeu|main)\s+)?co[uû]tent\s+(\d+)\s*pa\s+de\s+moins", s)
    if mf:
        god = _deaccent(mf.group(1)).rstrip("s").capitalize()  # "fécas" → "Feca"
        GODS = {"Iop", "Cra", "Ecaflip", "Eniripsa", "Enutrof", "Sram", "Xelor", "Sacrieur", "Feca", "Sadida"}
        if god in GODS:
            return {"type": "StampCostReduction", "god": god, "amount": int(mf.group(2)), "_authored": True}
    return None


def parse_self_death(card: dict):
    """ "<trigger> : meurt", the creature kills itself (Goule Ash #823: HORDE
    CONTRE COUP : meurt) → SetLife {value:0, self:true} on the detected trigger (the
    creature drops to 0 PV and dies; a HORDE death also fires the HORDE discount).
    Matches only when the whole clause is "meurt", never the "quand X meurt"
    condition (mid-sentence) nor a "… puis meurt" rider."""
    s = strip_markup(card.get("description", ""))
    if not re.search(r":\s*meur[ts]\s*\.?\s*$", s):
        return None
    return {"type": "SetLife", "value": 0, "self": True, "_authored": True}


def parse_recycle_family(card: dict):
    """ "Place les <famille> de votre main sous votre pioche. Piochez autant de
    <famille>" (Goule Taka #871) → RecycleFamily {family} on the detected trigger
    (HORDE APPARITION)."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"place\s+les\s+(\w+)\s+de\s+votre\s+main\s+sous\s+votre\s+pioche", s)
    if not m or "piochez autant" not in s:
        return None
    fam = map_tutor_filter(m.group(1))
    if not (fam and "family" in fam):
        return None
    return {"type": "RecycleFamily", "family": fam["family"], "_authored": True}


def parse_on_play_react(card: dict):
    """ "<effet> quand vous jouez/lancez un sort / une invocation / une carte"
    (Crapaud Mufle #238, Angèle #1257, Piou aux Oeufs d'Or #446) → effects on an
    ON_PLAY trigger carrying a `filter.cardType` (spell/summon, or none = any card).
    The effect clause sits before "quand": "gagne +N AT/AR/PM" → self boosts ;
    "soigne vos autres invocations de N PV" → Heal {scope:allies[, excludeSelf]} ;
    "piochez N carte(s)" → DrawCards. (A "charge …" rider, Lilotte #444, falls
    through.) Returns {"effects":[...], "filter":{cardType?}} or None."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"(?:quand|si)\s+(vous|votre\s+adversaire)\s+(?:jouez|joue|lancez|lance)\s+(un\s+sort|une\s+invocation|une\s+carte)", s)
    if not m:
        return None
    what = m.group(2)
    filt = {"cardType": "spell"} if "sort" in what else {"cardType": "summon"} if "invocation" in what else {}
    # "quand votre adversaire joue …" (Miss Nuit #382) → filtre côté adverse.
    if "adversaire" in m.group(1):
        filt["side"] = "enemy"
    head = s[:m.start()]
    effs = []
    # "ajoute N PA à votre réserve" (Miss Nuit #382) → AddReserve {side:caster}.
    rm = re.search(r"ajoute\s+(une|\d+)\s*pa\s+[àa]\s+votre\s+r[ée]serve", head)
    if rm:
        effs.append({"type": "AddReserve", "amount": 1 if rm.group(1) == "une" else int(rm.group(1)), "side": "caster", "_authored": True})
    # "meurt si vous jouez un sort" (Tama Hok #878): the creature kills itself when
    # you play a matching card → SetLife {value:0, self} (it drops to 0 PV).
    if head.strip().rstrip(".") in ("meurt", "meurs"):
        effs.append({"type": "SetLife", "value": 0, "self": True, "_authored": True})
    gm = re.search(r"gagne\s+(.+)", head)
    if gm and "charge" not in gm.group(1):
        for amt, stat in re.findall(r"\+?\s*(\d+)\s*(at|ar|pm)\b", gm.group(1)):
            et = {"at": "BoostAttack", "ar": "BoostArmor", "pm": "BoostMovement"}[stat]
            effs.append({"type": et, "amount": int(amt), "self": True, "_authored": True})
    hm = re.search(r"soigne\s+vos\s+(autres\s+)?invocations\s+de\s+(\d+)\s*pv", head)
    if hm:
        e = {"type": "Heal", "amount": int(hm.group(2)), "scope": "allies", "_authored": True}
        if hm.group(1):
            e["excludeSelf"] = True
        effs.append(e)
    # Plain draw only: "piochez N carte(s)" with nothing after it (rejects "une carte
    # krosmique" from Sigrun #917, a filtered draw handled separately).
    dm = re.search(r"piochez\s+(une|\d+)\s*cartes?(?!\s+\w)", head)
    if dm:
        effs.append({"type": "DrawCards", "amount": 1 if dm.group(1) == "une" else int(dm.group(1)), "_authored": True})
    # "s'inflige N dégât(s)" (Ertan Knapz #1854), the creature damages itself each time you
    # play a matching card → SelfDamageData (handleSelfDamage hits ctx.selfInstanceId).
    sd = re.search(r"s['’]inflige\s+(\d+)\s*d[ée]g[âa]ts?", head)
    if sd:
        effs.append({"type": "SelfDamageData", "Damage": int(sd.group(1)), "_authored": True})
    # "inflige @damage@ à la première invocation [ou dofus] adverse de sa ligne" (Emma Zone
    # #1866) → DamageInFront (scan the row, first enemy creature; hitDofus when "ou dofus").
    # Amount from the bindata DamageData (the @damage@ marker is not a number in the text).
    fm = re.search(r"inflige\s+.*?[àa]\s+la\s+première\s+invocation\s+(ou\s+dofus\s+)?adverse\s+de\s+sa\s+ligne", head)
    if fm:
        dmg = next((e.get("Damage") for e in (card.get("effects") or []) if e.get("type") == "DamageData" and isinstance(e.get("Damage"), (int, float))), 1)
        eff = {"type": "DamageInFront", "amount": dmg, "_authored": True}
        if fm.group(1):
            eff["hitDofus"] = True
        effs.append(eff)
    if not effs:
        return None
    return {"effects": effs, "filter": filt}


def parse_summon_column(card: dict):
    """ "APPARITION : invoque un <token> sur chaque case de sa rangée" (Bébé
    Phorreur Armuré via Héroïne Séculaire #1245, Corbac via Corbeau Noir #205) gives
    SummonToken {tokenId, amount:1, placement:"column"}. "rangée" is the vertical column
    (same x), not the horizontal lane ("ligne"): one copy on every empty cell of the
    source's column. Each token runs its own APPARITION when summoned, so a token with
    an innate "Charge de 1" (Corbac) moves by itself; "vos corbacs chargent" is that
    innate charge and needs no extra effect. The token comes from summon_name_index."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"invoque\s+un\s+(.+?)\s+sur\s+chaque\s+case\s+de\s+sa\s+rang[ée]e", s)
    if not m:
        return None
    tid = summon_name_index.get(norm_name(m.group(1).strip()))
    if tid is None:
        return None
    return {"type": "SummonToken", "tokenId": tid, "amount": 1, "placement": "column", "_authored": True}


# Token names that the game prints differently from the token card's own name.
# "Poupée Gonflable" is the card La Gonflable (#5), "Poupée Folle" is La Folle (#481).
SUMMON_NAME_ALIAS = {"poupee gonflable": 5, "poupee folle": 481, "poil": 281, "poil de jiji": 281}


def parse_summon_named_token(card: dict):
    """ "APPARITION : Invoquez une <token>" (Amalia #362 "poupée gonflable" → La
    Gonflable #5 ; #368 "poupée folle" → La Folle #481) → SummonToken {tokenId,
    amount:1, placement:"near"} (one token next to the source). The "sur chaque case
    de sa rangée" column variant is parse_summon_column's job. Token resolved via an alias
    map then the summon_name_index. Returns the effect dict or None."""
    s = strip_markup(card.get("description", ""))
    if "sur chaque case" in s or "rang" in s:
        return None
    m = re.search(r"invoquez\s+une?\s+(.+?)\s*\.?\s*$", s)
    if not m:
        return None
    name = norm_name(m.group(1).strip())
    tid = SUMMON_NAME_ALIAS.get(name) or summon_name_index.get(name)
    if tid is None:
        return None
    # placement "choose": the player picks a valid summon cell (Amalia chooses where
    # her poupée lands), unlike the auto-placed "near"/"row" variants.
    return {"type": "SummonToken", "tokenId": tid, "amount": 1, "placement": "choose", "_authored": True}


def parse_summon_on_survive(card: dict):
    """ "Invoque un <token> / une autre <famille> aléatoire à côté de / autour de
    lui s'il survit à des dégâts" (Boo #513 gives another Boo; Empereur Gelax #422 a
    random Jelly) gives SummonToken {..., placement:"near"} fired on CONTRE_COUP
    (surviving combat damage is the contre-coup trigger). The caller forces the
    CONTRE_COUP slot since "survit à des dégâts" is not a detected keyword. Returns the
    effect dict or None."""
    s = strip_markup(card.get("description", ""))
    if "survit" not in s or "d" not in s:  # cheap guard; full check below
        return None
    if not re.search(r"survit\s+[àa]\s+des\s+d[ée]g", s):
        return None
    m = re.search(r"invoque\s+une?\s+(.+?)\s+([àa]\s+c[oô]t[ée]\s+de\s+lui|autour\s+de\s+lui)", s)
    if not m:
        return None
    inner = m.group(1).strip()
    # "à côté de lui" → one lateral cell (beside, RNG of the free laterals) ;
    # "autour de lui" → any nearby free cell (near).
    placement = "near" if "autour" in m.group(2) else "beside"
    fm = re.search(r"autre\s+(\w+)\s+al[ée]atoire", inner)
    if fm:
        sel = map_tutor_filter(fm.group(1))
        if not (sel and "family" in sel):
            return None
        # "une AUTRE <famille>" → exclude the source's own card from the pool.
        return {"type": "SummonToken", "family": sel["family"], "amount": 1, "placement": placement, "excludeSelf": True, "_authored": True}
    tid = SUMMON_NAME_ALIAS.get(norm_name(inner)) or summon_name_index.get(norm_name(inner))
    if tid is None:
        return None
    return {"type": "SummonToken", "tokenId": tid, "amount": 1, "placement": placement, "_authored": True}


def parse_add_to_hand_on_survive(card: dict):
    """ "Ajoute un <nom> à votre main s'il survit à des dégâts" (Tsu Tsu Mikaze #1509,
    a copy of itself) gives AddCardToHand {cardId} on CONTRE_COUP (surviving the damage
    is the contre-coup). The caller forces the CONTRE_COUP slot."""
    s = strip_markup(card.get("description", ""))
    if not re.search(r"survit\s+[àa]\s+des\s+d[ée]g", s):
        return None
    m = re.search(r"ajoute\s+une?\s+(.+?)\s+[àa]\s+votre\s+main", s)
    if not m:
        return None
    inner = m.group(1).strip()
    tid = SUMMON_NAME_ALIAS.get(norm_name(inner)) or summon_name_index.get(norm_name(inner))
    if tid is None and norm_name(inner) == norm_name(card.get("name", "")):
        tid = card.get("id")  # "un tsu tsu mikaze" is a copy of the card itself
    if tid is None:
        return None
    return {"type": "AddCardToHand", "cardId": tid, "amount": 1, "_authored": True}


def parse_add_to_enemy_hand(card: dict):
    """ "Ajoute N <nom> dans la main adverse / à la main de votre adversaire" (Jiji
    #465 "ajoute 2 poils dans la main adverse") gives AddCardToHand {cardId, amount,
    side:"enemy"}. Rejects two-part cards (Kriss La Krass #341/#967 also say "jouez
    gratuitement vos boufballes", a second effect not handled here)."""
    s = strip_markup(card.get("description", ""))
    if "gratuitement" in s:
        return None
    m = re.search(r"ajoute\w*\s+(\d+|une?)\s+(.+?)\s+(?:dans\s+la\s+main\s+adverse|[àa]\s+la\s+main\s+de\s+votre\s+adversaire)", s)
    if not m:
        return None
    n = 1 if m.group(1) in ("un", "une") else int(m.group(1))
    inner = m.group(2).strip()
    tid = SUMMON_NAME_ALIAS.get(norm_name(inner)) or summon_name_index.get(norm_name(inner))
    if tid is None:
        return None
    return {"type": "AddCardToHand", "cardId": tid, "amount": n, "side": "enemy", "_authored": True}


def parse_fill_hand(card: dict):
    """ "Remplit de <token> la main des deux joueurs" (Kabrok #473, with Corbacs) gives
    two AddCardToHand {fill:true} (one per camp) that fill each hand up to the maximum.
    Returns the effect list (or None)."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"remplit\s+de\s+(\w+?)s?\s+la\s+main\s+des\s+deux\s+joueurs", s)
    if not m:
        return None
    tid = SUMMON_NAME_ALIAS.get(norm_name(m.group(1))) or summon_name_index.get(norm_name(m.group(1)))
    if tid is None:
        return None
    return [{"type": "AddCardToHand", "cardId": tid, "amount": 0, "fill": True, "side": "caster", "_authored": True},
            {"type": "AddCardToHand", "cardId": tid, "amount": 0, "fill": True, "side": "enemy", "_authored": True}]


def parse_charge_on_play(card: dict):
    """ "Charge de N cases quand vous jouez une carte / quand votre adversaire joue
    une invocation" (Lilotte #444, #569) → a reactive ChargeSelf {cells:N} on an
    ON_PLAY trigger. The trigger's filter encodes whose play and which card type.
    Other "charge … quand …" events (Chacha damage #732, prism #579) are deferred.
    Returns {"effect": …, "filter": {…}} or None."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"charge\s+de\s+(\d+)\s+cases?\s+quand\s+(.+)", s)
    if not m:
        return None
    eff = {"type": "ChargeSelf", "cells": int(m.group(1)), "_authored": True}
    when = m.group(2)
    if re.search(r"vous\s+jouez\s+une\s+carte", when):
        return {"effect": eff, "filter": {}}                              # own play, any card
    if re.search(r"vous\s+jouez\s+une\s+invocation", when):
        return {"effect": eff, "filter": {"cardType": "summon"}}          # own summon
    if re.search(r"adversaire\s+joue\s+une\s+invocation", when):
        return {"effect": eff, "filter": {"side": "enemy", "cardType": "summon"}}
    if re.search(r"adversaire\s+joue\s+une\s+carte", when):
        return {"effect": eff, "filter": {"side": "enemy"}}
    return None


def parse_charge_on_prism(card: dict):
    """ Lilotte #579: "Charge de N cases quand un prisme est ramassé ou détruit." → a
    reactive ChargeSelf {cells:N} on an ON_PRISM trigger (fired by fireOnPrismReactions at
    every prism pickup / destruction). Distinct from the ON_PLAY Lilottes #444/#569.
    Returns the ChargeSelf effect dict or None."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"charge\s+de\s+(\d+)\s+cases?\s+quand\s+un\s+prisme\s+est\s+ramass", s)
    if not m:
        return None
    return {"type": "ChargeSelf", "cells": int(m.group(1)), "_authored": True}


def parse_destroy_fleau_opponent_hand(desc: str):
    """Horlogère Gousset #1687: "MORT : Détruit un fléau dans la main adverse." →
    DestroyCardInOpponentHand {cardId:757} (the Fléau spell). Returns the effect
    dict or None."""
    s = strip_markup(desc)
    if re.search(r"d[ée]truit\s+un\s+fl[ée]au\s+dans\s+la\s+main\s+advers", s):
        return {"type": "DestroyCardInOpponentHand", "cardId": 757, "_authored": True}
    return None


def parse_aoe_enemies_own_camp(desc: str):
    """Apôtre Nécrosé #688: "Inflige N dégâts aux invocations adverses dans votre
    camp." → AoeDamage {amount:N, scope:enemies, zone:ownCamp} (only enemy
    creatures standing in the caster's territory). Returns the effect or None."""
    s = strip_markup(desc)
    m = re.search(r"inflige\s+(\d+)\s+d[ée]g[âa]ts?\s+aux\s+invocations?\s+(?:adverses?|ennemies?)\s+dans\s+votre\s+camp", s)
    if not m:
        return None
    return {"type": "AoeDamage", "amount": int(m.group(1)), "scope": "enemies", "zone": "ownCamp", "_authored": True}


def parse_aoe_enemies_min_attack(card: dict):
    """Gardienne Inflexible #1531: "Inflige @damage@ aux invocations adverses ayant
    au moins N AT." → AoeDamage {amount, scope:enemies, minAttack:N} (only enemy
    creatures with currentAttack ≥ N). amount from the bindata DamageData. Returns
    the effect or None."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"aux\s+invocations?\s+(?:adverses?|ennemies?)\s+ayant\s+au\s+moins\s+(\d+)\s*at", s)
    if not m:
        return None
    amt = None
    for e in (card.get("effects") or []):
        if e.get("type") == "DamageData":
            d = e.get("Damage")
            amt = d if isinstance(d, int) else (d.get("const") if isinstance(d, dict) else None)
            break
    if amt is None:
        return None
    return {"type": "AoeDamage", "amount": int(amt), "scope": "enemies", "minAttack": int(m.group(1)), "_authored": True}


def parse_self_damage_coinflip(desc: str):
    """Griffeur Tonkino #628: "S'inflige 1 OU 2 dégâts." gives a CoinFlip whose two
    branches are SelfDamageData (Pile = the first amount, Face = the second). The "OU"
    is a real coin flip, not a player choice: both outcomes hurt the source, so a
    player would always pick the smaller one, and the "ou" only makes sense as a
    gamble. The amounts are read from the text. Returns the effect or None."""
    s = strip_markup(desc)
    m = re.search(r"s'inflige\s+(\d+)\s+ou\s+(\d+)\s+d[ée]g[âa]ts?", s)
    if not m:
        return None
    return {"type": "CoinFlip",
            "pile": [{"type": "SelfDamageData", "Damage": int(m.group(1))}],
            "face": [{"type": "SelfDamageData", "Damage": int(m.group(2))}],
            "_authored": True}


def parse_glyph_damage(card: dict):
    """Glyphe Enflammé #1285: GLYPHE spell "Quand il est joué, ce sort inflige
    @damage@ aux invocations autour du Glyphe." gives [AoeDamage amount scope all
    shape around, PlaceGlyph]: damages the 3x3 around the targeted cell (both camps),
    then leaves a Glyphe there. The amount is read from the bindata DamageData (the
    text has @damage@). Replaces the unused single DamageData. Other GLYPHE effects
    around the glyph (destroy/stun/push) are separate parsers."""
    s = strip_markup(card.get("description", ""))
    if "glyphe" not in s:
        return None
    if not re.search(r"inflige\s+@?damage@?.*aux\s+invocations?\s+autour\s+du\s+glyphe", s):
        return None
    amt = None
    for e in (card.get("effects") or []):
        if e.get("type") == "DamageData":
            d = e.get("Damage")
            if isinstance(d, int):
                amt = d
            elif isinstance(d, dict) and isinstance(d.get("const"), int):
                amt = d["const"]
    if amt is None:
        return None
    return [
        {"type": "AoeDamage", "amount": amt, "scope": "all", "shape": "around"},
        {"type": "PlaceGlyph"},
    ]


def parse_glyph_destroy(card: dict):
    """Glyphe de Mort #937: GLYPHE spell "Quand il est joué, ce sort détruit les
    invocations autour du Glyphe." gives [AoeDestroy scope all shape around,
    PlaceGlyph]: destroys every creature in the 3x3 around the targeted cell (both
    camps), then leaves a Glyphe there."""
    s = strip_markup(card.get("description", ""))
    if "glyphe" not in s:
        return None
    if not re.search(r"d[ée]truit\s+les\s+invocations?\s+autour\s+du\s+glyphe", s):
        return None
    return [
        {"type": "AoeDestroy", "scope": "all", "shape": "around"},
        {"type": "PlaceGlyph"},
    ]


def parse_glyph_push(card: dict):
    """Glyphe de Retraite #736: GLYPHE spell "Quand il est placé, ce Glyphe
    repousse de N cases les invocations autour de lui." → [AoePush distance N scope
    all shape around, PlaceGlyph]. Distance read from the bindata PushData (or the
    text). Replaces the stranded single-target PushData."""
    s = strip_markup(card.get("description", ""))
    if "glyphe" not in s:
        return None
    if not re.search(r"repousse\s+de\s+\d+\s+cases?\s+les\s+invocations?\s+autour", s):
        return None
    dist = None
    for e in (card.get("effects") or []):
        if e.get("type") == "PushData" and isinstance(e.get("Distance"), int):
            dist = e["Distance"]
    if dist is None:
        m = re.search(r"repousse\s+de\s+(\d+)\s+cases", s)
        dist = int(m.group(1)) if m else None
    if dist is None:
        return None
    return [
        {"type": "AoePush", "distance": int(dist), "scope": "all", "shape": "around"},
        {"type": "PlaceGlyph"},
    ]


def parse_glyph_stun(card: dict):
    """Glyphe de Léthargie #854: GLYPHE spell "Quand il est joué, ce sort assomme
    les invocations autour du Glyphe." → [SetProperty Stunned scope all shape
    around, PlaceGlyph]: stuns every creature in the 3×3 around the targeted cell
    (both camps), then drops a Glyphe."""
    s = strip_markup(card.get("description", ""))
    if "glyphe" not in s:
        return None
    if not re.search(r"assomme\s+les\s+invocations?\s+autour\s+du\s+glyphe", s):
        return None
    return [
        {"type": "SetProperty", "property": "Stunned", "scope": "all", "shape": "around"},
        {"type": "PlaceGlyph"},
    ]


def parse_pollinisation(card: dict):
    """Pollinisation #58: "Inflige @damage@ aux invocations adverses, une Graine
    alliée est placée sur les cases de celles qui meurent." gives [AoeDamage scope
    enemies amount N, PlantSeedOnEnemyDeaths]. The damage value is in the bindata
    DamageData (the text only has a @damage@ placeholder), so it is read from there.
    Replaces the unused single-target DamageData (no scope, broken for an AlliedGod
    self cast)."""
    s = strip_markup(card.get("description", ""))
    if "aux invocations adverses" not in s or "graine" not in s or "meurent" not in s:
        return None
    amt = None
    for e in (card.get("effects") or []):
        if e.get("type") == "DamageData":
            d = e.get("Damage")
            if isinstance(d, int):
                amt = d
            elif isinstance(d, dict) and isinstance(d.get("const"), int):
                amt = d["const"]
    if amt is None:  # already converted (no raw DamageData), fall through, the
        return None  #   existing AoeDamage effects persist via the kept-check.
    return [
        {"type": "AoeDamage", "amount": amt, "scope": "enemies"},
        {"type": "PlantSeedOnEnemyDeaths"},
    ]


def parse_conditional_seed_property(desc: str):
    """Kolo Kolko #27: "Gagne initiative et inciblable tant que vous avez une
    Graine en jeu." gives ConditionalSeedProperty {properties} (initiative becomes
    FirstStrike, inciblable becomes Untargetable). The caller replaces the
    unconditional bindata SetPropertyData for these keywords (otherwise summonCreature
    would make them innate and withAuras could not remove them when the seed is gone)."""
    s = strip_markup(desc)
    if not re.search(r"tant\s+que\s+vous\s+avez\s+une\s+graine\s+en\s+jeu", s):
        return None
    if "gagne" not in s:
        return None
    props = []
    if "initiative" in s:
        props.append("FirstStrike")
    if "inciblable" in s:
        props.append("Untargetable")
    if not props:
        return None
    return {"type": "ConditionalSeedProperty", "properties": props}


def parse_seed_step_damage(desc: str):
    """Soldat Cornouiller #1560: "Tant qu'elle est en jeu vos Graines infligent N
    dégâts aux invocations adverses qui marchent dessus." → a continuous
    SeedStepDamage {amount} in effects[] (the engine reads it from the seed
    owner's living creatures when an enemy walks onto a seed)."""
    s = strip_markup(desc)
    m = re.search(
        r"vos\s+graines?\s+infligent\s+(\d+)\s*d[ée]g[âa]ts?\s+aux\s+invocations?\s+advers\w+\s+qui\s+marchent\s+dessus",
        s,
    )
    if not m:
        return None
    return {"type": "SeedStepDamage", "amount": int(m.group(1))}


def parse_place_seeds_in_front(desc: str):
    """Rôdeur Sylvestre #907: "Fait apparaître N Graines sur les cases de la
    rangée devant lui" gives PlaceSeedsInFront {count}. The seeds land on the N cells
    straight ahead on the source's row (occupied cells are skipped). _authored."""
    s = strip_markup(desc)
    m = re.search(
        r"fait\s+appara[îi]tre\s+(\d+)\s+graines?\s+sur\s+les\s+cases\s+.*devant\s+lui",
        s,
    )
    if not m:
        return None
    return {"type": "PlaceSeedsInFront", "count": int(m.group(1)), "_authored": True}


def parse_glyph_draw(desc: str):
    """Glyphe de Renouveau #924: GLYPHE spell "Quand il est joué, ce sort fait
    piocher 1 carte par invocation autour du Glyphe." → [DrawPerCreatureAround,
    PlaceGlyph] (authored-empty card → section 2)."""
    s = strip_markup(desc)
    if "glyphe" not in s:
        return None
    if not re.search(r"piocher\s+\d+\s+cartes?\s+par\s+invocation\s+autour\s+du\s+glyphe", s):
        return None
    return [{"type": "DrawPerCreatureAround"}, {"type": "PlaceGlyph"}]


def parse_glyph_armor_attack(desc: str):
    """Glyphe Agressif #1577: GLYPHE spell "Quand il est joué, ce sort confère aux
    invocations autour du Glyphe autant d'AT qu'elles ont d'AR." → [AddArmorToAttack
    scope all shape around, PlaceGlyph]."""
    s = strip_markup(desc)
    if not re.search(
        r"conf[èe]re\s+aux\s+invocations?\s+autour\s+du\s+glyphe\s+autant\s+d.{0,2}\s*at\b.*\bd.{0,2}\s*ar\b",
        s,
    ):
        return None
    return [{"type": "AddArmorToAttack", "scope": "all", "shape": "around"}, {"type": "PlaceGlyph"}]


def parse_invoke_glyph(desc: str):
    """Melita #1813: "APPARITION : Invoquez un Glyphe dans votre camp." → a
    PlaceGlyph effect on the APPARITION slot. It needs a target (effectRequiresTarget
    is true for PlaceGlyph), so runTrigger opens an own_empty_camp pick."""
    s = strip_markup(desc)
    if re.search(r"invoquez?\s+un\s+glyphe\s+dans\s+votre\s+camp", s):
        return {"type": "PlaceGlyph", "_authored": True}
    return None


def parse_destroy_prism(desc: str):
    """Patek Tag #363: "APPARITION : Détruisez un prisme." → a DestroyPrism effect
    on the APPARITION slot. It needs a target (effectRequiresTarget true), so
    runTrigger opens an any_prism pick."""
    s = strip_markup(desc)
    if re.search(r"d[ée]truis\w*\s+un\s+prisme", s):
        return {"type": "DestroyPrism", "_authored": True}
    return None


def parse_destroy_all_enemy_prisms(desc: str):
    """Comte Harebourg #349: "APPARITION : Détruit tous les prismes adverses." → a
    DestroyAllEnemyPrisms player-state effect (no pick) on the APPARITION slot;
    removes every prism owned by the opponent. Returns the effect dict or None."""
    s = strip_markup(desc)
    if re.search(r"d[ée]truit\s+tous\s+les\s+prismes\s+adverses", s):
        return {"type": "DestroyAllEnemyPrisms", "_authored": True}
    return None


def parse_transform_prism_to_butin(desc: str):
    """Erik Rak #720: "APPARITION : Transformez un Prisme en Butin." → a
    TransformPrismToButin effect on the APPARITION slot (pick any_prism → it becomes
    a caster Butin). Returns the effect dict or None."""
    s = strip_markup(desc)
    if re.search(r"transform\w+\s+un\s+prisme\s+en\s+butin", s):
        return {"type": "TransformPrismToButin", "_authored": True}
    return None


def parse_transform_prism_to_bombe(desc: str):
    """Remington Smisse #80: "APPARITION : Transformez un prisme en Bombe." → a
    TransformPrismToBombe effect on the APPARITION slot (pick any_prism → it becomes a
    Bombe trap, cardId 101/damage 2, owned by the SOURCE's side). Cloned from Erik Rak's
    TransformPrismToButin. Returns the effect dict or None."""
    s = strip_markup(desc)
    if re.search(r"transform\w+\s+un\s+prisme\s+en\s+bombe", s):
        return {"type": "TransformPrismToBombe", "_authored": True}
    return None


def parse_destroy_dofus(desc: str):
    """Garde Temps #493: "Détruit un Dofus." gives a flat DestroyDofus effect (the spell
    targets a Dofus via castTarget AnyDofus, so the click is the Dofus). Rejects the
    riders not modelled here (cost reduction / glyphes, see Retour du Bâton)."""
    s = strip_markup(desc)
    if not re.search(r"d[ée]trui\w*\s+un\s+dofus", s):
        return None
    if re.search(r"glyphe|co[uû]te", s):  # Retour du Bâton: "Détruit un Dofus et vos Glyphes" + cost
        return None
    return {"type": "DestroyDofus"}


def parse_draw_cheaper(desc: str):
    """Pioche Antique #1252: "Piochez N carte(s). Elle(s) coûte(nt) M PA de moins."
    → DrawCards {amount:N, costMod:-M} (the drawn card's hand slot is stamped
    cheaper). Returns the effect dict or None."""
    s = strip_markup(desc)
    m = re.search(
        r"piochez?\s+(\d+)\s*cartes?\.?\s+elles?\s+co[uû]te(?:nt)?\s+(\d+)\s*pa\s+de\s+moins",
        s,
    )
    if not m:
        return None
    return {"type": "DrawCards", "amount": int(m.group(1)), "costMod": -int(m.group(2)), "_authored": True}


def parse_place_butin(card: dict):
    """Butin token #789 (model butin_token, joué → pose un Butin) → [PlaceButin] ;
    Trouvaille #1382 ("Posez N Butins … dans votre camp") → [PlaceButin {count:N}].
    Returns the effect list or None."""
    if (card.get("model") or "") == "butin_token":
        return [{"type": "PlaceButin"}]
    s = strip_markup(card.get("description", ""))
    m = re.search(r"posez\s+(\d+)\s+butins?", s)
    if m:
        return [{"type": "PlaceButin", "count": int(m.group(1))}]
    return None


def parse_place_tasdos(card: dict):
    """Tas d'Os card #691 (model tas_dos: when played it places a Tas d'Os on the
    targeted cell of your camp and destroys a prism there) gives [PlaceTasDOs]. Its
    description explains the rules of the tas d'os (handled by the engine), not the
    placing effect, hence the model check."""
    if (card.get("model") or "") == "tas_dos":
        return [{"type": "PlaceTasDOs"}]
    return None


def parse_grab_all_butins(desc: str):
    """Bernalette Chichi #776: "APPARITION : Ramasse tous les Butins en jeu et gagne
    +1 AT par Butin ramassé." → a GrabAllButins effect (removes every butin, one
    reward per butin to the caster, +1 AT/butin to the source). Returns the effect
    or None."""
    s = strip_markup(desc)
    if re.search(r"ramasse\s+tous\s+les\s+butins?\s+en\s+jeu", s):
        return {"type": "GrabAllButins", "_authored": True}
    return None


def parse_crail(card: dict):
    """Crail #820: "APPARITION : Vos Glyphes infligent N dégâts aux invocations
    adverses de leur ligne." gives DamageEnemiesOnGlyphLines {amount} on the APPARITION
    slot. The amount is read from the bindata DamageData (the flat effect is unused)."""
    s = strip_markup(card.get("description", ""))
    if not re.search(
        r"vos\s+glyphes?\s+infligent\s+\d+\s+d[ée]g[âa]ts?\s+aux\s+invocations?\s+advers\w+\s+de\s+leur\s+ligne",
        s,
    ):
        return None
    amt = None
    for e in (card.get("effects") or []):
        if e.get("type") == "DamageData" and isinstance(e.get("Damage"), int):
            amt = e["Damage"]
    if amt is None:
        m = re.search(r"infligent\s+(\d+)\s+d[ée]g", s)
        amt = int(m.group(1)) if m else None
    if amt is None:
        return None
    return {"type": "DamageEnemiesOnGlyphLines", "amount": int(amt), "_authored": True}


def parse_conditional_orb(desc: str):
    """Bourreau Anonyme #655: "APPARITION : Ajoute N <carte> à votre main si vous
    avez au moins K Glyphes en jeu." → AddCardToHand {cardId, amount,
    requireCondition glyphInPlay{value:K}} (dropped at the trigger when the caster
    has fewer than K glyphs). Injected on the APPARITION slot."""
    s = strip_markup(desc)
    m = re.search(
        r"ajoute\s+(\d+)\s+(.+?)\s+[àa]\s+votre\s+main\s+si\s+vous\s+avez\s+au\s+moins\s+(\d+)\s+glyphes?\s+en\s+jeu",
        s,
    )
    if not m:
        return None
    cid = resolve_card(m.group(2).strip())
    if cid is None:
        return None
    return {"type": "AddCardToHand", "cardId": cid, "amount": int(m.group(1)),
            "requireCondition": {"kind": "glyphInPlay", "value": int(m.group(3))}, "_authored": True}


def parse_damage_in_front_seeds(desc: str):
    """Héros Chataîgneur #920: "Inflige à la première invocation adverse devant
    lui autant de dégâts que de Graines alliées en jeu" gives a DamageInFront effect
    whose amount is a NumberOfSeedsValue (own seeds). Allied creatures do not block
    (they are skipped) and the first enemy ahead on the row is hit at any distance.
    Injected on the APPARITION slot."""
    s = strip_markup(desc)
    if not re.search(r"premi[èe]re\s+invocation\s+advers\w+\s+devant\s+lui", s):
        return None
    if not re.search(r"autant\s+de\s+d[ée]g[âa]ts?\s+que\s+de\s+graines?\s+alli", s):
        return None
    return {"type": "DamageInFront",
            "amount": {"type": "NumberOfSeedsValue", "TeamFilter": 0,
                       "ValuePerSeed": 1, "FixedValue": 0},
            "_authored": True}


def parse_pm_from_enemy_in_line(desc: str):
    """Leanor #1224: "APPARITION : Augmente ses PM de la valeur de PM du premier
    adversaire de sa ligne." → a BoostMovementFromEnemyInLine effect (same row scan
    as DamageInFront: skip allies, take the first enemy ahead). Injected on the
    APPARITION slot."""
    s = strip_markup(desc)
    if re.search(r"augmente\s+ses\s+pm\s+de\s+la\s+valeur\s+de\s+pm\s+du\s+premier\s+adversaire\s+de\s+sa\s+ligne", s):
        return {"type": "BoostMovementFromEnemyInLine", "_authored": True}
    return None


def parse_conditional_self_buff(desc: str):
    """ "<trigger> : Gagne <+N AT et/ou +M AR> si <condition>" gives self BoostX effects
    guarded by requireCondition (dropped at resolution when the condition fails). The
    caller replaces the trigger slot (the bindata only has the +AT, without the
    condition, and it would be counted twice otherwise). Handled conditions:
      - "si vous avez une Graine en jeu"        (Orma #295)       -> seedInPlay
      - "si un Glyphe allié est en jeu"          (Jade #1024)      -> glyphInPlay
      - "si une invocation alliée est blessée"   (Laghertha #1432) -> woundedAllyInPlay
      - "si vous avez un autre <Famille> en jeu" (Sono Sino #321)  -> allyFamilyInPlay
    The buff amounts can be AT only, AR only, or both."""
    s = strip_markup(desc)
    if re.search(r"si\s+vous\s+avez\s+une\s+graine\s+en\s+jeu", s):
        cond, cond_re = {"kind": "seedInPlay"}, r"si\s+vous\s+avez\s+une\s+graine\s+en\s+jeu"
    elif re.search(r"si\s+un\s+glyphe\s+alli[ée]\w*\s+est\s+en\s+jeu", s):
        cond, cond_re = {"kind": "glyphInPlay"}, r"si\s+un\s+glyphe\s+alli[ée]\w*\s+est\s+en\s+jeu"
    elif re.search(r"si\s+une\s+invocation\s+alli[ée]\w*\s+est\s+bless[ée]\w*", s):
        cond, cond_re = {"kind": "woundedAllyInPlay"}, r"si\s+une\s+invocation\s+alli[ée]\w*\s+est\s+bless[ée]\w*"
    elif re.search(r"si\s+vous\s+avez\s+un\s+autre\s+\w+(?:\s+alli[ée]\w*)?\s+en\s+jeu", s):
        fam_m = re.search(r"si\s+vous\s+avez\s+un\s+autre\s+(\w+)", s)
        sel = map_tutor_filter(fam_m.group(1)) if fam_m else None
        if not (sel and "family" in sel):
            return None
        cond = {"kind": "allyFamilyInPlay", "family": sel["family"], "excludeSelf": True}
        cond_re = r"si\s+vous\s+avez\s+un\s+autre\s+\w+(?:\s+alli[ée]\w*)?\s+en\s+jeu"
    elif re.search(r"s'il\s+y\s+a\s+au\s+moins\s+\d+\s*pa\s+dans\s+votre\s+r[ée]serve", s):
        rm = re.search(r"au\s+moins\s+(\d+)\s*pa\s+dans\s+votre\s+r[ée]serve", s)
        cond = {"kind": "reserveAtLeast", "value": int(rm.group(1))}  # Radox #858
        cond_re = r"s'il\s+y\s+a\s+au\s+moins\s+\d+\s*pa\s+dans\s+votre\s+r[ée]serve"
    else:
        return None
    m = re.search(r"gagne\s+(.+?)\s+" + cond_re, s)
    if not m:
        return None
    STAT = {"at": "BoostAttack", "ar": "BoostArmor"}
    effs = [{"type": STAT[stat], "amount": int(amt), "self": True,
             "requireCondition": dict(cond), "_authored": True}
            for amt, stat in re.findall(r"\+?\s*(\d+)\s*(at|ar)\b", m.group(1))]
    return effs or None


def parse_conditional_mass_buff(desc: str):
    """Murmures Sauvages #299: "Confère +N AT à vos invocations ou +N AT et +M AR
    si vous avez une Graine en jeu." gives [BoostAttack allies +N, BoostArmor allies
    +M requireCondition seedInPlay]. The +AT always applies; the +AR depends on the
    seed condition (dropped at resolution when the caster has no seed)."""
    s = strip_markup(desc)
    m = re.search(
        r"conf[èe]re\s+\+?(\d+)\s*at\s+[àa]\s+vos\s+invocations?\s+ou\s+\+?(\d+)\s*"
        r"at\s+et\s+\+?(\d+)\s*ar\s+si\s+vous\s+avez\s+une\s+graine\s+en\s+jeu",
        s,
    )
    if not m:
        return None
    at_base, at_alt, ar = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if at_base != at_alt:
        return None  # the conditional branch also raises AT, not modeled here
    return [
        {"type": "BoostAttack", "amount": at_base, "scope": "allies"},
        {"type": "BoostArmor", "amount": ar, "scope": "allies",
         "requireCondition": {"kind": "seedInPlay"}},
    ]


def parse_buff_and_charge(desc: str):
    """Dressage: "Confère à vos invocations +N AT, elles chargent de M cases." →
    a mass +AT buff (scope allies) followed by a mass charge, both executors
    already exist. Returns the two-effect list, or None."""
    s = strip_markup(desc)
    m = re.search(
        r"conf[èe]re\s+[àa]\s+vos\s+invocations?\s+\+?\s*(\d+)\s*at\b.*?chargent\s+de\s+(\d+)\s*cases?",
        s,
    )
    if not m:
        return None
    # Only the clean +AT form (no AR / choice / condition riders).
    if re.search(r"\bar\b|\bou\b|\bsi\b|bless", s):
        return None
    return [
        {"type": "BoostAttack", "amount": int(m.group(1)), "scope": "allies"},
        {"type": "ChargeAllies", "cells": int(m.group(2))},
    ]


def parse_charge_allies(desc: str):
    """Mass-charge spell (Intimidation: "Vos invocations chargent de N cases.")
    → a ChargeAllies effect; the engine already advances every ally by N PM
    (rules.ts chargeAllies). Only the clean form, we bail on buff / choice /
    reverse / "autres" riders (Dressage, Tout ou Rien, Gligli…), which need a
    dedicated combo/trigger pass."""
    s = strip_markup(desc)
    if not re.search(r"vos\s+invocations?\s+chargent\s+de\s+\d+\s*cases?", s):
        return None
    if re.search(r"conf[èe]re|\+\s*\d|reculent|\bou\b|puis|bless|autres", s):
        return None
    m = re.search(r"chargent\s+de\s+(\d+)\s*cases?", s)
    return {"type": "ChargeAllies", "cells": int(m.group(1))}


def parse_conditional_draw(desc: str):
    """Conditional draw spell (Sarcophage: "Piochez 1 carte ou 2 cartes si vous
    avez au moins 5 PA dans votre réserve.") gives a DrawCards effect with a `bonus`
    and a player-state `condition`. The engine draws `amount`, plus `bonus` more when
    the condition holds at cast. Variants: reserve threshold, sous-nombre, and
    "au moins 1 Graine en jeu" (Engrais #164, the seedInPlay condition).

    Sous-nombre rule: you are outnumbered when you control strictly fewer creatures
    than the opponent (a tie does not count). A creature that was just summoned
    counts, since the check happens once it is on the board, which is how
    conditionMet/`outnumbered` works."""
    s = strip_markup(desc)
    # Variant A, reserve threshold.
    m = re.search(
        r"piochez\s+(\d+)\s+cartes?\s+ou\s+(\d+)\s+cartes?\s+si\s+vous\s+avez\s+"
        r"au\s+moins\s+(\d+)\s*pa\s+dans\s+votre\s+r[ée]serve",
        s,
    )
    if m:
        base, total, value = int(m.group(1)), int(m.group(2)), int(m.group(3))
        bonus = max(0, total - base)
        if bonus <= 0:
            return None
        return {"type": "DrawCards", "amount": base, "bonus": bonus,
                "condition": {"kind": "reserveAtLeast", "value": value}}
    # Variant B, outnumbered (sous-nombre).
    m = re.search(
        r"piochez\s+(\d+)\s+cartes?\s+ou\s+(\d+)\s+cartes?\s+si\s+vous\s+"
        r"[êe]tes\s+en\s+sous.?nombre",
        s,
    )
    if m:
        base, total = int(m.group(1)), int(m.group(2))
        bonus = max(0, total - base)
        if bonus <= 0:
            return None
        return {"type": "DrawCards", "amount": base, "bonus": bonus,
                "condition": {"kind": "outnumbered"}}
    # Variant C, at least one Graine on the board (Engrais #164). "au moins 1
    # Graine en jeu" → the seedInPlay condition (caster owns ≥1 board seed).
    m = re.search(
        r"piochez\s+(\d+)\s+cartes?\s+ou\s+(\d+)\s+cartes?\s+si\s+vous\s+avez\s+"
        r"au\s+moins\s+\d+\s+graines?\s+en\s+jeu",
        s,
    )
    if m:
        base, total = int(m.group(1)), int(m.group(2))
        bonus = max(0, total - base)
        if bonus <= 0:
            return None
        return {"type": "DrawCards", "amount": base, "bonus": bonus,
                "condition": {"kind": "seedInPlay"}}
    return None


def parse_transform_all_spell(desc: str):
    """Mass-transform spell (Transchamation: "Transforme vos invocations en
    Chachas Noirs.") → a TransformAll effect on the caster's whole side. Only the
    "vos invocations" form (board-object sources like "vos Graines / Butins" are
    a different system); the token name must resolve to a real Summon card."""
    s = strip_markup(desc)
    m = re.search(r"transforme\s+vos\s+invocations?\s+en\s+(.+?)\.?\s*$", s)
    if not m:
        return None
    tok = resolve_token(m.group(1).strip())
    if tok is None:
        return None
    return {"type": "TransformAll", "tokenId": tok, "scope": "allies"}


def parse_mass_bounce(desc: str):
    """Mass bounce spell (Art Du Fourrage: "Remonte toutes les invocations dans la
    main de leur propriétaire.") gives a scoped ReturnToHand on both sides. The explicit
    "toutes" is required, so the row-scoped Trêve (#1269, "d'une rangée") and the
    Glyph-only Remaniement (#1443) are left out, they need other systems."""
    s = strip_markup(desc)
    if re.search(r"remonte\s+toutes\s+les\s+invocations?\s+dans\s+la\s+main", s):
        return {"type": "ReturnToHand", "scope": "all"}
    return None


def parse_targeted_bounce(desc: str):
    """Targeted bounce to the owner's hand, filtered by an attack cap (Adamaï:
    "Remontez dans la main de son propriétaire une invocation ayant N AT ou
    moins") gives a ReturnToHand with maxAttack (the engine asks for a creature with
    at most N AT and sends it to its owner's hand). Only the "son propriétaire"
    variant: the bounces that steal ("votre main" Zaldior, "main adverse" Arakne)
    move the card to the other side's hand and need their own effect."""
    s = strip_markup(desc)
    # Destination: the OWNER's hand ("de son propriétaire", Adamaï), a steal into
    # the caster's hand ("dans votre main", Zaldior), or a push to the foe's hand
    # ("dans la main adverse", Arakne Brodeuse).
    if (re.search(r"remont\w+\s+dans la main de son propri[ée]taire\s+une invocation", s)
            or re.search(r"remont\w+\s+une\s+invocation\s+dans\s+la\s+main\s+de\s+son\s+propri[ée]taire", s)):
        # Adamaï #347: the words come in the order "une invocation ... dans la main de son propriétaire".
        eff = {"type": "ReturnToHand", "_authored": True}
    elif re.search(r"remont\w+\s+dans votre main\s+une invocation", s):
        eff = {"type": "ReturnToHand", "toSide": "caster", "_authored": True}
    elif re.search(r"remont\w+\s+dans la main adverse\s+une invocation", s):
        eff = {"type": "ReturnToHand", "toSide": "opponent", "_authored": True}
    else:
        return None
    # Zone rider "située dans votre camp" → a ownCamp pick restriction (modelled).
    if re.search(r"situ[ée]e?\s+dans votre camp", s):
        eff["zone"] = "ownCamp"
    # Other positional riders we still do not model (rangée/ligne/devant/adjacent).
    if re.search(r"rang[ée]e|ligne|devant|derri[èe]re|adjacent", s):
        return None
    m = re.search(r"ayant\s+(\d+)\s*at\s+ou\s+moins", s)
    if m:
        eff["maxAttack"] = int(m.group(1))
    return eff


def parse_aoe_destroy(desc: str):
    """Mass destroy filtered by a stat ceiling: "Détruit [toutes] les invocations
    ayant N AT/PV ou moins" (Colère de Iop, Plante Kanniboul, Duelliste Spectral).
    Hits both sides ("les/toutes les invocations"). An optional "si vous êtes en
    sous-nombre" rider becomes an outnumbered condition. Returns the effect or None."""
    s = strip_markup(desc)
    m = re.search(
        r"d[ée]trui(?:t|sez|re)\s+(?:toutes\s+)?les\s+invocations?\s+ayant\s+"
        r"(\d+)\s*(at|pv)\s+ou\s+moins",
        s,
    )
    if not m:
        return None
    n, stat = int(m.group(1)), m.group(2)
    eff = {"type": "AoeDestroy", "scope": "all"}
    eff["maxAttack" if stat == "at" else "maxLife"] = n
    if re.search(r"si\s+vous\s+[êe]tes\s+en\s+sous.?nombre", s):
        eff["condition"] = {"kind": "outnumbered"}
    return eff


# French rarity word → data rarity value (Krosmaga tiers).
RARITY_FR = {
    "commune": "Common", "communes": "Common",
    "peu commune": "Silver", "peu communes": "Silver",
    "rare": "Gold", "rares": "Gold",
}


def parse_aoe_destroy_rarity(desc: str):
    """Toxine (Fratrie): "Détruit les invocations communes/peu communes/rares en
    jeu." gives a mass AoeDestroy filtered by rarity, on both camps (scope:all).
    Returns the effect dict or None."""
    s = strip_markup(desc)
    m = re.search(r"d[ée]truit\s+les\s+invocations\s+(peu\s+communes?|communes?|rares?)\s+en\s+jeu", s)
    if not m:
        return None
    rar = RARITY_FR.get(m.group(1).strip())
    if not rar:
        return None
    return {"type": "AoeDestroy", "scope": "all", "rarity": rar, "_authored": True}


def parse_aoe_destroy_property(desc: str):
    """Razortemps #566: "Détruit les invocations inciblables." → a mass AoeDestroy
    filtered by a property (scope:all, both camps). Currently only "inciblable" →
    Untargetable. Returns the effect dict or None."""
    s = strip_markup(desc)
    if re.search(r"d[ée]truit\s+les\s+invocations\s+inciblables", s):
        return {"type": "AoeDestroy", "scope": "all", "property": "Untargetable", "_authored": True}
    return None


def parse_destroy_armor(desc: str):
    """Larve Orange #116: "APPARITION : Détruisez l'AR d'une invocation." → a
    targeted DestroyArmor (the picked creature's armour pool is wiped). Returns the
    effect dict or None."""
    s = strip_markup(desc)
    if re.search(r"d[ée]truis\w*\s+l'?\s*ar\s+d'une\s+invocation", s):
        return {"type": "DestroyArmor", "_authored": True}
    return None


def parse_sacrifice(card: dict):
    """ "APPARITION : Sacrifiez une de vos invocations pour gagner +N AT et +M AR"
    (Tartanque #154) or "Sacrifiez un <famille> allié pour gagner son AT et ses PM"
    (Tofu Mutant #301) → a Sacrifice effect (pick one of your creatures → it dies,
    the source gains the buff). Rejects "un de vos prismes" (#735, deferred, buffs
    allies, not self). Returns the effect dict or None."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"sacrifiez\s+une\s+de\s+vos\s+invocations\s+pour\s+gagner\s+(.+)", s)
    if m:
        tail = m.group(1)
        at = re.search(r"\+?(\d+)\s*at", tail)
        ar = re.search(r"\+?(\d+)\s*ar", tail)
        if not (at or ar):
            return None
        eff = {"type": "Sacrifice", "_authored": True}
        if at:
            eff["gainAttack"] = int(at.group(1))
        if ar:
            eff["gainArmor"] = int(ar.group(1))
        return eff
    m = re.search(r"sacrifiez\s+un\s+(\w+)\s+alli[ée]\s+pour\s+gagner\s+son\s+at\s+et\s+ses\s+pm", s)
    if m:
        sel = map_tutor_filter(m.group(1))
        if sel and "family" in sel:
            return {"type": "Sacrifice", "family": sel["family"], "gainFromVictim": True, "_authored": True}
    return None


def parse_set_attack_others(card: dict):
    """ "Change l'AT des autres invocations pour qu'elle soit égale à la sienne /
    à leurs PV" (Moon #1747 APPARITION, Foul Moon #929 / Darkli Moon #602 FIN DU
    TOUR) gives a mass SetAttack {scope:all, excludeSelf} whose new value is the
    source's attack (`fromSource`) or each creature's own life (`toLife`). "les
    autres invocations" means both camps. Returns the effect dict or None."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"change\s+l'?\s*at\s+des\s+autres\s+invocations.+?[ée]gale?\s+[àa]\s+(.+)", s)
    if not m:
        return None
    tail = m.group(1)
    eff = {"type": "SetAttack", "scope": "all", "excludeSelf": True, "_authored": True}
    if re.search(r"la\s+sienne", tail):
        eff["fromSource"] = True
    elif re.search(r"leurs?\s+pv", tail):
        eff["toLife"] = True
    else:
        return None
    return eff


# Map a trigger keyword in a card's description to the engine trigger type, so a
# description-authored trigger effect lands in the right slot.
TRIGGER_KEYWORDS = [
    ("debut du tour", "DEBUT_DE_TOUR"), ("début du tour", "DEBUT_DE_TOUR"),
    ("fin du tour", "FIN_DE_TOUR"), ("fin de tour", "FIN_DE_TOUR"),
    ("mort adverse", "MORT_ADVERSE"),  # checked before "mort" (substring), the reactive enemy-death trigger
    ("mort", "MORT"), ("apparition", "APPARITION"),
    ("coup de grace", "COUP_DE_GRACE"), ("coup de grâce", "COUP_DE_GRACE"),
    ("contre coup", "CONTRE_COUP"),
]

def detect_trigger_kind(desc: str):
    s = strip_markup(desc)
    for kw, kind in TRIGGER_KEYWORDS:
        if kw in s:
            return kind
    return None


def parse_coinflip_addcard(desc: str):
    """Coin-flip "add card" trigger (Felinor "Ajoute un Dé Ecaflip OU un Dé du
    Chateux à votre main"; Rémus "... un Trucage OU un Dé pipé ...") gives a CoinFlip
    whose two branches each add a card; both names have to resolve. Pile is the first."""
    s = strip_markup(desc)
    m = re.search(r"ajoute\s+un\s+(.+?)\s+ou\s+un\s+(.+?)\s+[àa]\s+votre\s+main", s)
    if not m:
        return None
    a = resolve_card(m.group(1).strip())
    b = resolve_card(m.group(2).strip())
    if a is None or b is None:
        return None
    return {
        "type": "CoinFlip", "_authored": True,
        "pile": [{"type": "AddCardToHand", "cardId": a, "amount": 1}],
        "face": [{"type": "AddCardToHand", "cardId": b, "amount": 1}],
    }


def parse_coinflip_stay_bounce(desc: str):
    """Elo Baine: "APPARITION : Reste en jeu OU remonte dans votre main." → a
    CoinFlip whose Pile (positive) = stay (no effect) and Face (negative) = the
    source bounces back to its owner's hand (self ReturnToHand)."""
    s = strip_markup(desc)
    if not re.search(r"reste\s+en\s+jeu\s+ou\s+remonte\s+dans\s+votre\s+main", s):
        return None
    return {
        "type": "CoinFlip", "_authored": True,
        "pile": [],
        "face": [{"type": "ReturnToHand", "self": True}],
    }


def parse_coinflip_self(desc: str):
    """Coin-flip self trigger (Chatar / Recrue Indomptée: "Gagne +N AT/AR OU
    s'inflige M dégâts"). → a CoinFlip: Pile = a self stat buff (positive), Face
    = self-damage (negative). Returns the effect or None."""
    s = strip_markup(desc)
    m = re.search(
        r"gagne\s*\+?\s*(\d+)\s*(at|ar|pm)\b.*?ou\s+s['\s]*inflige\s+(\d+)\s*d[ée]g[aâ]ts?",
        s,
    )
    if not m:
        return None
    amt, stat, dmg = int(m.group(1)), m.group(2), int(m.group(3))
    etype = {"at": "BoostAttack", "ar": "BoostArmor", "pm": "BoostMovement"}[stat]
    return {
        "type": "CoinFlip", "_authored": True,
        "pile": [{"type": etype, "amount": amt, "self": True}],
        "face": [{"type": "SelfDamageData", "Damage": dmg}],
    }


def parse_self_stat_buff(desc: str):
    """Unconditional immediate self-buff on APPARITION: "APPARITION : Gagne N
    AT/AR/PM" (N concrete or 1d6, e.g. Karla Blondie / Takana). Returns a
    self-targeted BoostAttack/BoostArmor/BoostMovement effect, or None. Rejects
    the conditional / reactive / dynamic-count variants (si / tant que / quand /
    par / autre / adverse / "en jeu"), those need the aura / reactive / count
    systems, not a one-shot self-buff."""
    s = strip_markup(desc)
    if "apparition" not in s:
        return None
    tail = s.split("apparition", 1)[1]
    # Reject conditional / reactive / dynamic-count / choice variants. "\bou\b"
    # is critical: "Gagne +2 AT OU s'inflige 2 dégâts" (Chatar) is a player
    # choice, authoring only the buff branch would misrepresent the card.
    if re.search(r"\bsi\b|tant que|tant qu'|quand|chaque|\bpar\b|autre|advers|en jeu|\bou\b|inflige|d[ée]g[aâ]ts", tail):
        return None
    m = re.search(r"gagne\s*\+?\s*(\d+|1d6)\s*(at|ar|pm)\b", tail)
    if not m:
        return None
    amt_raw, stat = m.group(1), m.group(2)
    amount = {"dice": "1d6"} if amt_raw == "1d6" else int(amt_raw)
    etype = {"at": "BoostAttack", "ar": "BoostArmor", "pm": "BoostMovement"}[stat]
    return {"type": etype, "amount": amount, "self": True, "_authored": True}


def parse_self_buff_heal(desc: str):
    """ "<trigger> : Gagne +N AT [et +M AR/PM] [et se soigne de K PV]" / "Se soigne
    de K PV" → self BoostAttack/BoostArmor/BoostMovement/Heal effects on the
    detected trigger slot. Covers the COUP DE GRÂCE self-buff/heal cards that the
    APPARITION-only parse_self_stat_buff misses (Klaus #716 = +1 AT & heal 2 ; Tsar
    Tsu Tsu #138 = +2 AT +2 AR ; Mulou Garou #199 = heal 2). Returns a list or None.
    Rejects conditional / reactive / count / choice riders."""
    s = strip_markup(desc)
    if re.search(r"\bsi\b|tant que|tant qu'|quand|chaque|\bpar\b|autre|advers|en jeu|\bou\b|inflige", s):
        return None
    effs = []
    gm = re.search(r"gagne\s+(.+?)(?:\s+et\s+se\s+soigne|\.|$)", s)
    if gm:
        for amt, stat in re.findall(r"\+?\s*(\d+)\s*(at|ar|pm)\b", gm.group(1)):
            et = {"at": "BoostAttack", "ar": "BoostArmor", "pm": "BoostMovement"}[stat]
            effs.append({"type": et, "amount": int(amt), "self": True, "_authored": True})
    hm = re.search(r"se\s+soigne\s+de\s+(\d+)\s*pv", s)
    if hm:
        effs.append({"type": "Heal", "amount": int(hm.group(1)), "self": True, "_authored": True})
    return effs or None


def parse_camp_silence(desc: str):
    """Phaeris: "APPARITION : Réduit au silence les invocations présentes dans le
    camp adverse." → a mass Silence scoped to the enemy's territory."""
    s = strip_markup(desc)
    if not re.search(r"r[ée]dui\w*\s+au\s+silence\s+les\s+invocations.*camp\s+adverse", s):
        return None
    return {"type": "Silence", "scope": "enemy_camp", "_authored": True}


def parse_silence_line(card: dict):
    """Phaeris #1750: "APPARITION : Réduit au silence les invocations d'une ligne."
    gives a mass Silence anchored on a picked line, `shape:"row"` ("ligne", same y) or
    `shape:"column"` ("rangée", same x). The pick gives the anchor cell.
    Returns the effect dict or None."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"r[ée]dui\w*\s+au\s+silence\s+les\s+invocations\s+d'une\s+(ligne|rang[ée]e)", s)
    if not m:
        return None
    shape = "row" if m.group(1).startswith("ligne") else "column"
    return {"type": "Silence", "scope": "all", "shape": shape, "_authored": True}


def parse_column_attack_debuff(card: dict):
    """Grokoko #531: "APPARITION : Réduit de N l'AT des invocations d'une rangée
    ayant au moins M AT." gives BoostColumnAttack {amount:-N} (negative means a debuff)
    on a picked column, optionally limited to creatures with at least M AT
    (minAttack). Returns the effect dict or None."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"r[ée]duit\s+de\s+(\d+)\s+l'?\s*at\s+des\s+invocations\s+d'une\s+rang[ée]e", s)
    if not m:
        return None
    eff = {"type": "BoostColumnAttack", "amount": -int(m.group(1)), "_authored": True}
    mm = re.search(r"ayant\s+au\s+moins\s+(\d+)\s*at", s)
    if mm:
        eff["minAttack"] = int(mm.group(1))
    return eff


def parse_target_silence(card: dict):
    """ "APPARITION : Réduisez UNE invocation au silence." (Justice #209, Grinch
    #252) gives a single-target Silence {single:true} (one picked creature, any side).
    The pattern is anchored at the end, so the two-part "... son AT passe à 3" (#67)
    does not match here. The mass "les invocations ... camp adverse" (Phaeris) is
    parse_camp_silence."""
    s = strip_markup(card.get("description", ""))
    if re.search(r"r[ée]dui\w*\s+une\s+invocation\s+au\s+silence\s*\.?\s*$", s):
        return {"type": "Silence", "single": True, "_authored": True}
    return None


def parse_silence_setattack(card: dict):
    """ "Réduisez une invocation au silence, son AT passe à N" (Justice #67) gives
    [Silence {single}, SetAttack {value:N}] on the same picked target. Both effects
    need a pick, so they share one pendingAction (the filter comes from the first one,
    a single Silence, so any creature) and apply in order: the silence resets the AT
    to the printed value, then SetAttack sets it to N."""
    s = strip_markup(card.get("description", ""))
    m = re.search(r"r[ée]dui\w*\s+une\s+invocation\s+au\s+silence\s*,?\s*son\s+at\s+passe\s+[àa]\s+(\d+)", s)
    if not m:
        return None
    return [
        {"type": "Silence", "single": True, "_authored": True},
        {"type": "SetAttack", "value": int(m.group(1)), "_authored": True},
    ]


def parse_camp_mass_bounce(desc: str):
    """Veuve Noire: "APPARITION : Remonte les autres invocations situées dans
    votre camp dans la main de leur propriétaire." → a mass ReturnToHand scoped
    to the caster's territory, excluding the source ("les autres")."""
    s = strip_markup(desc)
    if not re.search(r"remont\w+\s+les\s+autres\s+invocations\s+situ[ée]es?\s+dans\s+votre\s+camp", s):
        return None
    return {"type": "ReturnToHand", "scope": "own_camp", "excludeSelf": True, "_authored": True}


def parse_destroy_in_front(desc: str):
    """Gloutoblop: "APPARITION : Détruit la première créature devant lui si elle
    possède N AT ou moins." gives a DestroyInFront effect (kills the closest creature
    ahead on the source's row, only if its attack is at most N). Returns the effect or
    None."""
    s = strip_markup(desc)
    if not re.search(r"d[ée]trui\w*\s+la\s+premi[èe]re\s+cr[ée]ature\s+devant", s):
        return None
    eff = {"type": "DestroyInFront", "_authored": True}
    m = re.search(r"poss[èe]de\s+(\d+)\s*at\s+ou\s+moins", s)
    if m:
        eff["maxAttack"] = int(m.group(1))
    return eff


def parse_swap_body(desc: str):
    """Marline: "APPARITION : Échangez son corps avec une invocation adverse ayant
    N AT ou moins." → a SwapBody effect (source & picked enemy trade position and
    side). Returns the effect, or None."""
    s = strip_markup(desc)
    if not re.search(r"[eé]changez\s+son\s+corps\s+avec\s+une\s+invocation\s+adverse", s):
        return None
    eff = {"type": "SwapBody", "_authored": True}
    m = re.search(r"ayant\s+(\d+)\s*at\s+ou\s+moins", s)
    if m:
        eff["maxAttack"] = int(m.group(1))
    return eff


def parse_swap_source_position(desc: str):
    """Moskito: "APPARITION : Échangez sa position avec une de vos invocations
    ayant N AT ou moins." → a targeted SwapSourcePosition effect on the
    APPARITION trigger (source swaps cells with a picked allied creature whose
    attack ≤ N). Returns the effect dict, or None if it is not this pattern."""
    s = strip_markup(desc)
    if not re.search(r"[eé]changez\s+sa\s+position", s):
        return None
    eff = {"type": "SwapSourcePosition", "_authored": True}
    m = re.search(r"ayant\s+(\d+)\s*at\s+ou\s+moins", s)
    if m:
        eff["maxAttack"] = int(m.group(1))
    return eff


def parse_swap_source_attack(desc: str):
    """Asprogik Mils #525: "APPARITION : Échangez son AT avec une autre
    invocation." → a targeted SwapSourceAttack on the APPARITION trigger (the
    source trades its attack with a picked creature, any side; the pick rejects the
    source itself). Returns the effect dict or None."""
    s = strip_markup(desc)
    if re.search(r"[eé]changez\s+son\s+at\s+avec\s+une\s+autre\s+invocation", s):
        return {"type": "SwapSourceAttack", "_authored": True}
    return None


def parse_swap_source_movement(desc: str):
    """Chacha Sauvage #1276: "APPARITION : Échangez ses PM avec une autre
    invocation." → a targeted SwapSourceMovement on the APPARITION trigger (the
    source trades its movement with a picked creature; the pick rejects the source
    itself). Returns the effect dict or None."""
    s = strip_markup(desc)
    if re.search(r"[eé]changez\s+ses\s+pm\s+avec\s+une\s+autre\s+invocation", s):
        return {"type": "SwapSourceMovement", "_authored": True}
    return None


def has_charge_keyword(desc: str) -> bool:
    """The standalone "Charge" KEYWORD (Tristepin's "APPARITION : Charge") =
    NoSummoningSickness: the creature may act the turn it is summoned (it advances
    its PM that turn). Distinct from a "charge de N cases" / "charge jusqu'au
    dofus" EFFECT, so we exclude those (and the plural "chargent")."""
    s = strip_markup(desc)
    if re.search(r"chargent", s):
        return False
    return bool(re.search(r"\bcharge\b(?!\s*(?:de|d'|sur|jusqu))", s))


# Trigger keyword (lower-cased, stripped form) → canonical trigger, used to attach
# the bare "Charge" keyword to the right trigger section.
_KW_TRIG_RE = re.compile(
    r"\b(apparition|mort|coup de gr[aâ]ce|contre[ -]?coup|fin d[ue] tour|d[ée]but d[ue] tour|ralliement)\s*:"
)


def _canon_trigger(grp: str) -> str:
    g = grp.strip()
    if g.startswith("apparition"): return "APPARITION"
    if g.startswith("mort"):       return "MORT"
    if g.startswith("coup"):       return "COUP_DE_GRACE"
    if g.startswith("contre"):     return "CONTRE_COUP"
    if g.startswith("fin"):        return "FIN_DE_TOUR"
    if "but" in g:                 return "DEBUT_DE_TOUR"
    if g.startswith("ralliement"): return "RALLIEMENT"
    return "APPARITION"


def charge_keyword_trigger(desc: str):
    """WHICH trigger the bare "Charge" KEYWORD belongs to. Tristepin's "APPARITION :
    Charge" → APPARITION (act the turn it lands); Goultard #187 "COUP DE GRÂCE :
    Charge" → COUP_DE_GRACE (charge again after a killing blow). Returns the canonical
    trigger name (default APPARITION when no trigger precedes the keyword), or None when
    there is no bare-Charge keyword (so "chargent" / "charge de N" stay excluded, exactly
    like has_charge_keyword)."""
    s = strip_markup(desc)
    if re.search(r"chargent", s):
        return None
    cm = re.search(r"\bcharge\b(?!\s*(?:de|d'|sur|jusqu))", s)
    if not cm:
        return None
    cpos = cm.start()
    best, bpos = "APPARITION", -1
    for tm in _KW_TRIG_RE.finditer(s):
        if bpos < tm.start() < cpos:
            bpos = tm.start()
            best = _canon_trigger(tm.group(1))
    return best


def charge_keyword_triggers(desc: str):
    """EVERY trigger carrying a bare "Charge" KEYWORD (not "charge de N"/"chargent").
    Tristepin "APPARITION : Charge" → ["APPARITION"]; Goultard #187 "COUP DE GRÂCE :
    Charge" → ["COUP_DE_GRACE"]; Milkar #46 "APPARITION : Charge\nCOUP DE GRÂCE :
    Charge" → ["APPARITION", "COUP_DE_GRACE"] (a bare Charge under each trigger).
    Generalises charge_keyword_trigger (which only saw the first keyword): each bare
    Charge occurrence binds to its nearest preceding trigger keyword (default
    APPARITION). Order preserved, deduped. Empty when there is no bare-Charge keyword."""
    s = strip_markup(desc)
    if re.search(r"chargent", s):
        return []
    out, seen = [], set()
    for cm in re.finditer(r"\bcharge\b(?!\s*(?:de|d'|sur|jusqu))", s):
        cpos = cm.start()
        best, bpos = "APPARITION", -1
        for tm in _KW_TRIG_RE.finditer(s):
            if bpos < tm.start() < cpos:
                bpos = tm.start()
                best = _canon_trigger(tm.group(1))
        if best not in seen:
            seen.add(best)
            out.append(best)
    return out


# Summons with an empty trigger whose APPARITION/MORT action was left in the flat
# effects[] (doing nothing at summon). id -> (trigger, authored effect). See the
# matching effect-type comments in src/data/types.ts.
_FACILES_INJECT = {
    112:  ("APPARITION", {"type": "AoeDamage", "amount": 1, "scope": "all", "zone": "enemyCamp"}),       # Deserboss, 1 dmg to every creature in the enemy half
    600:  ("APPARITION", {"type": "DamageEnemiesByEnemyCount", "target": "all",     "countZone": "ownCamp"}),  # Dathura, all enemies, amount = enemies in your camp
    721:  ("APPARITION", {"type": "DamageEnemiesByEnemyCount", "target": "ownCamp", "countZone": "board"}),    # Dathura, enemies in your camp, amount = enemies in play
    909:  ("APPARITION", {"type": "DamageEnemiesByEnemyCount", "target": "front",   "countZone": "board"}),    # Dathura, first enemy ahead, amount = enemies in play
    818:  ("APPARITION", {"type": "DamageRowByOwnCost"}),                                                 # Gargoule, its AP cost to the rest of its row (friendly fire)
    932:  ("APPARITION", {"type": "DamageAdjacentFront", "hitDofus": True}),                              # Pisti Yeul, its AT to the single cell in front (creature or Dofus)
    304:  ("MORT",       {"type": "SummonToken", "tokenId": 482, "amount": 1, "placement": "self"}),      # Goultard, transforms into Dark Vlad #482 on its cell
    456:  ("MORT",       {"type": "SummonToken", "tokenId": 201, "amount": 1, "placement": "self"}),      # Grand Craqueleur Chuchoté: 1 Chuchoteur Arbalétrier #201 on the cell where it died
    404:  ("APPARITION", {"type": "SetProperty", "property": "Stunned"}),                                 # Rose Démoniaque, stun any picked summon for 1 turn
    711:  ("MORT",       {"type": "DropButinStartRow"}),                                                  # Coffre Tirelire
    1320: ("MORT",       {"type": "DropButinStartRow"}),                                                  # Coffre Fort
    1634: ("MORT",       {"type": "DropButinStartRow"}),                                                  # Petit Coffre
    1275: ("MORT",       {"type": "DropButinStartRow"}),                                                  # Coffre à Grosse Serrure
}


# Family index for TutorFromDeck: lowercased family key -> canonical key.
family_by_lower = {}
god_by_lower = {}  # "xelor" -> "Xelor" (classe/dieu), pour les tutors « carte <dieu> »
for _f in glob.glob(CARD_POOL_GLOB):
    _d = json.loads(Path(_f).read_text(encoding="utf-8"))
    for _c in (_d if isinstance(_d, list) else _d.get("cards", _d)):
        for _fa in (_c.get("families") or []):
            family_by_lower[_fa.lower()] = _fa
        _g = _c.get("god")
        if _g and _g != "None":
            god_by_lower[_g.lower()] = _g  # dieux sans accent (Xelor, Iop…) → .lower() suffit
# A few descriptive phrases that do not equal a family key 1:1.
TUTOR_SPECIAL = {
    "confrérie du tofu": "BrotherhoodOfTheTofu", "confrerie du tofu": "BrotherhoodOfTheTofu",
    "fratrie des oubliés": "Fratrie", "fratrie des oublies": "Fratrie",
}

# French family nouns (as they appear in card text) -> canonical family key.
# The families[] field stores canonical/English keys ("Jelly", "Gobbal") while
# descriptions read "vos autres Gelées / Bouftous". Without this bridge a
# family-scoped buff ("MORT : donne +1 AT à vos autres Gelées") cannot resolve
# its family and the card stays empty. Keyed by de-accented singular; the
# lookup also tries the plural's singular form. Extend as new families surface.
FR_FAMILY_ALIAS = {
    "gelee": "Jelly", "bouftou": "Gobbal", "boufton": "Gobbal",
    "coffre": "Chest", "craqueboule": "Crackler", "craqueleur": "Crackler",
}

def _deaccent(s: str) -> str:
    return "".join(
        ch for ch in unicodedata.normalize("NFD", s.lower())
        if unicodedata.category(ch) != "Mn"
    )

def map_tutor_filter(ph: str):
    """Map a raw tutor filter phrase to a TutorFromDeck selector, or None when
    we cannot model it faithfully (card-name / rarity / glyph / trap filters)."""
    p = ph.strip().lower()
    if p in ("invocation", "invocations", "créature", "creature", "créatures", "creatures"):
        return {"summon": True}
    if p in ("sort", "sorts"):
        return {"spell": True}
    # Strip descriptive prefixes: "carte xélor", "membre de la fratrie …".
    core = re.sub(r"^(carte|membre de la|membre du|cr[ée]ature de)\s+", "", p).strip()
    if core in TUTOR_SPECIAL:
        return {"family": TUTOR_SPECIAL[core]}
    # French-noun alias bridge (Gelées -> Jelly, Bouftous -> Gobbal …), tried
    # de-accented as-is and singularised, before the canonical-key lookup.
    da = _deaccent(core)
    da_sing = da[:-1] if (len(da) > 3 and da.endswith("s")) else da
    if da in FR_FAMILY_ALIAS:
        return {"family": FR_FAMILY_ALIAS[da]}
    if da_sing in FR_FAMILY_ALIAS:
        return {"family": FR_FAMILY_ALIAS[da_sing]}
    fam = family_by_lower.get(core) or family_by_lower.get(core.rstrip("s"))
    if fam:
        return {"family": fam}
    return None

patched = 0
patched_triggers = 0
patched_chief = 0
stripped_only = 0
for f in glob.glob(CARD_POOL_GLOB):
    d = json.loads(Path(f).read_text(encoding="utf-8"))
    cards = d if isinstance(d, list) else d.get("cards", d)
    changed = False
    for c in cards:
        # 0) retired cards (notes/removed_cards.json), old/reworked versions not
        #    in the live game. Stamp `removed` and skip all authoring: no point
        #    coding cards that cannot be played. The flag lets the pool/deck/UI
        #    exclude them; the raw card data is otherwise untouched.
        if c["id"] in REMOVED_IDS:
            if not c.get("removed"):
                c["removed"] = True
                changed = True
            continue
        if c.get("removed"):  # un-marked since last run → clear the stale flag
            del c["removed"]
            changed = True

        # 0b) HORDE keyword: the card carries the "HORDE" mention (all on Goule
        #     cards) → set a `horde` flag the engine reads for the death-triggered
        #     PA discount. Detected from the description; idempotent (re-derived
        #     each run, stale flag cleared if the mention is gone).
        is_horde = "horde" in strip_markup(c.get("description", ""))
        if is_horde and not c.get("horde"):
            c["horde"] = True
            changed = True
        elif not is_horde and c.get("horde"):
            del c["horde"]
            changed = True

        # 0b¹) token flag, set `isToken` on every non-deckable token card (bindata
        #      IsToken). The engine routes a token to the inaccessible tokenDiscard
        #      (never the recoverable pile) on every leaving path. Idempotent: re-derived
        #      from TOKEN_IDS each run, stale flag cleared if it ever drops out.
        is_token = c["id"] in TOKEN_IDS
        if is_token and not c.get("isToken"):
            c["isToken"] = True
            changed = True
        elif not is_token and c.get("isToken"):
            del c["isToken"]
            changed = True

        # Prism tokens ("Prisme de Pioche / Fléau / de PA") are internal dev cards (the
        # prism objects, not playable cards). The isDevCard flag in the source data is
        # inconsistent (PA is flagged, Pioche/Fléau are not), so it is made consistent here.
        if re.match(r"prisme\s+(de\s+pioche|fl[ée]au|de\s+pa)\b", (c.get("name", "") or "").lower()) and not c.get("isDevCard"):
            c["isDevCard"] = True
            changed = True

        # 0c) TAS D'OS keyword, set when the description starts with "tas d'os …"
        # (the keyword prefix, like HORDE), meaning the creature leaves a Tas d'Os on
        # its death cell. Not a mere mention ("… un tas d'os …" mid-text = an effect
        # that targets one, e.g. #691/#1082). Idempotent (re-derived each run).
        is_tasdos = bool(re.match(r"tas\s+d.os\b", strip_markup(c.get("description", "")).strip()))
        if is_tasdos and not c.get("tasDOs"):
            c["tasDOs"] = True
            changed = True

        # 0c²) PHORZERKER capacity (Enutrof), set a `phorzerker` flag the engine reads to offer
        #      the Phorreur-fusion pick at APPARITION. Derived from the bindata SecondaryTarget
        #      (PHORZERKER_IDS); idempotent, stale flag cleared if it ever drops out of the set.
        is_phorzerker = c["id"] in PHORZERKER_IDS
        if is_phorzerker and not c.get("phorzerker"):
            c["phorzerker"] = True
            changed = True
        elif not is_phorzerker and c.get("phorzerker"):
            del c["phorzerker"]
            changed = True
        elif not is_tasdos and c.get("tasDOs"):
            del c["tasDOs"]
            changed = True

        # "peut être invoqué sur un tas d'os allié" (Chafer Faucheur #742) sets the
        # summonOnTasDOs flag: an allied tas d'os becomes a valid summon cell for this card
        # anywhere on the board (even in the enemy camp). Idempotent.
        is_sot = bool(re.search(r"peut\s+[êe]tre\s+invoqu[ée]\s+sur\s+un\s+tas\s+d.os", strip_markup(c.get("description", ""))))
        if is_sot and not c.get("summonOnTasDOs"):
            c["summonOnTasDOs"] = True
            changed = True
        elif not is_sot and c.get("summonOnTasDOs"):
            del c["summonOnTasDOs"]
            changed = True

        # 1) Strip any previously-injected managed effects (self-correct). Also
        #    drop obsolete effect types, names a past run injected that no longer
        #    exist (e.g. GlyphCostAura, generalised into CardCostAura), so stale
        #    copies in an incrementally-built data file get cleaned out.
        existing = c.get("effects") or []
        kept = [e for e in existing if e.get("type") not in MANAGED_TYPES and e.get("type") not in OBSOLETE_TYPES]
        if len(kept) != len(existing):
            c["effects"] = kept
            changed = True
            stripped_only += 1

        # 1a³) PERCE ARMURE (Flèche Perçante #294): the description keyword marks the
        #      card's DamageData as armour-piercing (ignores Armure, not Résistance).
        #      The bindata DamageData has no such field, so we flag it from the text.
        #      DamageData is not managed → survives the strip; we just (re)set the flag,
        #      idempotently. Annotation only, does not `continue`.
        if "perce armure" in strip_markup(c.get("description", "")):
            for e in (c.get("effects") or []):
                if e.get("type") == "DamageData" and not e.get("pierceArmor"):
                    e["pierceArmor"] = True
                    changed = True

        # Single-target silence spell (Fiole de Frayeur #537, silence + push).
        # Silence is managed, so it was stripped above and is put back here, in front of
        # the PushData created by build_card_pool.
        sp_push = parse_silence_push(c)
        if sp_push is not None:
            c["effects"] = sp_push
            changed = True
            continue

        # BanishDiscard cost (Sram "Bannit les N dernières cartes parties dans votre
        # défausse pour ..."): the marker is added to effects[] next to the payload bindata
        # (DamageData or nothing). It is managed, so it was stripped above and is added
        # again here. Works for Spells and Summons.
        bd = parse_banish_discard(c)
        if bd and not any(e.get("type") == "BanishDiscard" for e in (c.get("effects") or [])):
            # Author the non-bindata payload (SetAttack #657 / Charge #794) before
            # the BanishDiscard cost; bindata payloads (DamageData #48/#435) and
            # summons (#127/#173) keep their own effects[] (payload = []).
            payload = parse_banish_payload(c)
            c["effects"] = (c.get("effects") or []) + payload + [bd]
            changed = True

        # Second Souffle #1237, a two-part spell "récupère les N dernières ... ET défausse
        # les M premières ...": [RecoverFromDiscard{last,count}, MillDeck]. Both types are
        # managed, so they were stripped above and are injected again here.
        ram = parse_recover_and_mill(c)
        if ram and not (c.get("effects") or []):
            c["effects"] = ram
            changed = True

        # 1a³) Caster-only flat deck mill (Funérailles #930 "Défausse 3 Srams de
        #      votre pioche"), Spells with no trigger keyword and no bindata. The
        #      trigger variant (Pierre Tombale #512 APPARITION) is injected in the
        #      trigger block. Managed → stripped above → re-set → idempotent.
        mds_flat = parse_mill_deck_self(c.get("description", ""))
        if mds_flat and not detect_trigger_kind(strip_markup(c.get("description", ""))) and not (c.get("effects") or []):
            c["effects"] = [mds_flat]
            changed = True

        # CostPerDiscard marker (Oscar Nak #198 "Coûte N PA de moins par carte dans votre
        # défausse"), added to effects[] (managed, so idempotent).
        cpd = parse_cost_per_discard(c)
        if cpd and not any(e.get("type") == "CostPerDiscard" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [cpd]
            changed = True

        # 1a⁵) RALLIEMENT keyword (Féca), append SetPropertyData{Ralliement} so the
        #      summon seeds the property (applyRally drives the movement). Dedup on
        #      PropertyType (SetPropertyData is not managed → not stripped).
        rk = parse_ralliement_keyword(c)
        if rk and not any(e.get("type") == "SetPropertyData" and e.get("PropertyType") == "Ralliement" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [rk]
            changed = True

        # "Ne subit jamais plus de 1 dégât à la fois" (Rupuce #242): add the innate
        # SetPropertyData{DamageCap1} (deduplicated on PropertyType, not managed).
        dcp = parse_damage_cap(c)
        if dcp and not any(e.get("type") == "SetPropertyData" and e.get("PropertyType") == "DamageCap1" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [dcp]
            changed = True

        # 1a⁶) Low-PV bounce (Arakne #420 / Grougaloragran #161), append BounceBelowPv
        #      marker (managed → stripped above → re-appended → idempotent).
        bpv = parse_bounce_below_pv(c)
        if bpv and not any(e.get("type") == "BounceBelowPv" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [bpv]
            changed = True

        # "Gagne +N (AT|portée|PM) tant que vous avez un autre <famille> en jeu"
        # (Bouftou #385 ...): add ConditionalStatBoost (managed, so idempotent).
        csf = parse_conditional_stat_family(c)
        if csf and not any(e.get("type") == "ConditionalStatBoost" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [csf]
            changed = True

        # "Dépense tous les PA de votre réserve. Vos invocations chargent d'autant"
        # (Sablier du Xélor #376): add SpendReserveCharge (managed, so idempotent).
        src = parse_spend_reserve_charge(c)
        if src and not any(e.get("type") == "SpendReserveCharge" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [src]
            changed = True

        # "Remonte les invocations d'une rangée dans la main de leur propriétaire"
        # (#1269): add BounceColumn (managed, so idempotent).
        bcol = parse_bounce_column(c)
        if bcol and not any(e.get("type") == "BounceColumn" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [bcol]
            changed = True

        # "Sacrifiez une de vos invocations pour ajouter son coût de PA à votre
        # réserve" (Cycle du Temps #1460): add SacrificeForReserve (idempotent).
        sfr = parse_sacrifice_for_reserve(c)
        if sfr and not any(e.get("type") == "SacrificeForReserve" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [sfr]
            changed = True

        # "Téléporte une invocation située dans votre camp sur une case de votre
        # camp" (Ralenti #119): add TeleportToCell (two steps, idempotent).
        ttc = parse_teleport_to_cell(c)
        if ttc and not any(e.get("type") == "TeleportToCell" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [ttc]
            changed = True

        # "Téléportez une invocation sur un glyphe allié" (Téléglyphe #1735):
        # add TeleportToGlyph (two steps, idempotent).
        tgl = parse_teleglyphe(c)
        if tgl and not any(e.get("type") == "TeleportToGlyph" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [tgl]
            changed = True

        # 1a¹⁴) "Échange la position de 2 de vos dofus" (Bluff #61), append SwapTwoDofus
        #       (twoStep, idempotent).
        s2d = parse_swap_two_dofus(c)
        if s2d and not any(e.get("type") == "SwapTwoDofus" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [s2d]
            changed = True

        # "Ciblez une invocation, quand elle meurt elle se place sur la pioche..."
        # (Enfouissement #684): add SetProperty {DeckOnDeath} (idempotent).
        enf = parse_enfouissement(c)
        if enf and not any(e.get("type") == "SetProperty" and e.get("property") == "DeckOnDeath" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [enf]
            changed = True

        # "Piochez 1 carte. Elle coûte 0 PA si c'est une invocation, sinon
        # défaussez-la" (Chasseur #245): add DrawSummonFreeElseDiscard.
        cha = parse_chasseur_draw(c)
        if cha and not any(e.get("type") == "DrawSummonFreeElseDiscard" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [cha]
            changed = True

        # 1a¹⁸) "Récupère un sort Sinistro de votre défausse" (Horloge #442, Sinistro=#215)
        #       → append RecoverFromDiscard {cardId:215} (idempotent).
        hsi = parse_horloge_sinistro(c)
        if hsi and not any(e.get("type") == "RecoverFromDiscard" and e.get("cardId") == 215 for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [hsi]
            changed = True

        # "Revient de votre défausse dans votre main quand un de vos <famille>
        # meurt" (Rat Tiboiseur #339): add RecoverSelfOnFamilyDeath (idempotent).
        rfd = parse_recover_on_family_death(c)
        if rfd and not any(e.get("type") == "RecoverSelfOnFamilyDeath" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [rfd]
            changed = True

        # "Tant qu'elle est en jeu, vos autres <famille> se transforment en graines
        # quand ils meurent" (Nenufar #821): add AllyFamilyDeathSeed (idempotent).
        afs = parse_family_death_seed(c)
        if afs and not any(e.get("type") == "AllyFamilyDeathSeed" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [afs]
            changed = True

        # "Les pièges activés de la main adverse coûtent N PA de plus et infligent
        # M dégât" (Héroïne Perfide #1254): add ActivatedTrapAura (idempotent).
        ata = parse_activated_trap_aura(c)
        if ata and not any(e.get("type") == "ActivatedTrapAura" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [ata]
            changed = True

        # +AT/+AR on the board or -AP in hand on each allied dice or coin roll
        # (Sentinelle #1606, Atout Caché #1201): add RollReaction.
        rrx = parse_roll_reaction(c)
        if rrx and not any(e.get("type") == "RollReaction" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [rrx]
            changed = True

        # 1a²⁵) "Place les cartes <god> de votre main dans votre pioche, celle-ci comprise.
        #       Piochez autant de cartes" (Escompte #1629), append RecycleGodDrawAny.
        esc = parse_escompte(c)
        if esc and not any(e.get("type") == "RecycleGodDrawAny" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [esc]
            changed = True

        # "Les invocations qu'il blesse meurent si vous avez un autre <famille> en
        # jeu" (Masse #207): add LethalMeleeIfFamily (idempotent).
        lmf = parse_lethal_melee(c)
        if lmf and not any(e.get("type") == "LethalMeleeIfFamily" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [lmf]
            changed = True

        # "Remonte dans votre main s'il détruit un dofus. Il coûte désormais N PA"
        # (Héros Félin #1156): add RecoverToHandOnDofusKill (idempotent).
        rdk = parse_recover_on_dofus_kill(c)
        if rdk and not any(e.get("type") == "RecoverToHandOnDofusKill" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [rdk]
            changed = True

        # "Annule les compétences de changement de ligne et de propriétaire de vos
        # <famille>" (Roi des Truches #282): add NullifyFamilyMovePowers.
        nfm = parse_nullify_family_move(c)
        if nfm and not any(e.get("type") == "NullifyFamilyMovePowers" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [nfm]
            changed = True

        # "Coûte N PA de moins par glyphe allié. Détruit un dofus et vos glyphes"
        # (Retour Du Bâton #1640): add [CostPerGlyph, DestroyDofus, DestroyOwnGlyphs]
        # (idempotent).
        rb = parse_retour_baton(c)
        if rb:
            for eff in rb:
                if not any(e.get("type") == eff["type"] for e in (c.get("effects") or [])):
                    c["effects"] = (c.get("effects") or []) + [eff]
                    changed = True

        # "Les invocations adverses coûtent N PA de plus si vous avez au moins M PA en
        # réserve" (Encablure #1100): add CardCostAura {enemy, requireReserve}.
        enc = parse_encablure(c)
        if enc and not any(e.get("type") == "CardCostAura" and e.get("requireReserve") is not None for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [enc]
            changed = True

        # +AT/+AR to your <famille> when a creature on the board goes back to hand
        # (Araknoplasme #416): add BuffFamilyOnBounce (idempotent).
        bfb = parse_buff_family_on_bounce(c)
        if bfb and not any(e.get("type") == "BuffFamilyOnBounce" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [bfb]
            changed = True

        # "Chaque fois qu'un allié est soigné, réduit de N l'AT de la première
        # invocation adverse de sa ligne ayant au moins M AT" (Dargone #1291): add
        # ReduceFirstEnemyAtOnAllyHeal (idempotent).
        dar = parse_dargone(c)
        if dar and not any(e.get("type") == "ReduceFirstEnemyAtOnAllyHeal" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [dar]
            changed = True

        # +AT/+AR when a card is discarded because a hand is full (Nain Patraque #965):
        # add BuffSelfOnOverflowDiscard.
        bod = parse_buff_on_overflow(c)
        if bod and not any(e.get("type") == "BuffSelfOnOverflowDiscard" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [bod]
            changed = True

        # "Inflige N dégât(s) aux invocations adverses quand une carte est défaussée car
        # la main d'un des joueurs est pleine" (Crasslek #355): replaces the bindata
        # DamageData (TriggeringOverdrawValue, never implemented, so the card played like
        # a vanilla one) with the DamageEnemiesOnOverflowDiscard marker. Idempotent
        # through the equality check.
        dod = parse_damage_on_overflow(c)
        if dod and c.get("effects") != [dod]:
            c["effects"] = [dod]
            changed = True

        # "Dépense vos PA restants pour infliger l'équivalent en dégâts"
        # (Désynchronisation #377): replaces the bindata DamageData (LastAPUsed, never
        # implemented: 0 damage and the AP was not spent) with SpendApAsDamage (resolved in
        # castSpell). Idempotent through the equality check.
        sad = parse_spend_ap_damage(c)
        if sad and c.get("effects") != [sad]:
            c["effects"] = [sad]
            changed = True

        # Ronces Agressives #439, override the single-target bindata DamageData (which
        # forces a creature under the cursor) with a row-scoped AoeDamage, so the spell is
        # castable on any cell and hits the enemy invocations on the clicked line.
        ron = parse_ronces_agressives(c)
        if ron and c.get("effects") != ron:
            c["effects"] = ron
            changed = True

        # Pelle Sismique #1104, override the single-target DamageData (which hits any creature on
        # the clicked cell, allies included) with a row-scoped enemies AoeDamage + a PlaceButin on
        # the cast cell. Idempotent via equality.
        psm = parse_pelle_sismique(c)
        if psm and c.get("effects") != psm:
            c["effects"] = psm
            changed = True

        # Tremblement de Terre #231, override the single-target bindata DamageData with an
        # around-cell AoeDamage (scope:all), so it is castable on any cell and hits the 3×3.
        tre = parse_aoe_damage_around_cell(c)
        if tre and c.get("effects") != tre:
            c["effects"] = tre
            changed = True

        # Epée Céleste #631, replace the single-target DamageData with a cross AoeDamage
        # (line + column of the clicked cell), so it is castable on any cell.
        crx = parse_aoe_cross_cell(c)
        if crx and c.get("effects") != crx:
            c["effects"] = crx
            changed = True

        # Pied du Sacrieur #271, replace the unreadable SacrierFoot DamageData with a
        # single-target DamageData {primary} + AoeDamage {other, excludeTargetCreature}.
        sf = parse_sacrier_foot(c)
        if sf and c.get("effects") != sf:
            c["effects"] = sf
            changed = True

        # Criblage #519, replace the unreadable NumberOfSummonValue DamageData with a
        # count-based DamageData (# of allied <god> creatures, dealt to the enemy Dofus).
        crb = parse_criblage(c)
        if crb and c.get("effects") != crb:
            c["effects"] = crb
            changed = True

        # Bain de Sang #1316, replace the unreadable NumberOfSummonValue{WoundedOnly} DamageData
        # with a count-based DamageData (# wounded, both sides) + a targeted Charge of the same count.
        bds = parse_bain_de_sang(c)
        if bds and c.get("effects") != bds:
            c["effects"] = bds
            changed = True

        # Flèche Criblante #8: the second DamageData {Y} hit the cast cell again (so the
        # creature took X+Y and the Dofus nothing). Replace it with DamageDofusOnTargetRow
        # {Y}: the enemy Dofus on the targeted creature's row.
        flc = parse_fleche_criblante(c)
        if flc and c.get("effects") != flc:
            c["effects"] = flc
            changed = True

        # Malox Makugen #76, replace the stranded DamageData with a passive
        # DamageDofusOnRowOnHeal (dofus of its row hit each time a creature is healed).
        ddh = parse_damage_dofus_on_heal(c)
        if ddh and c.get("effects") != ddh:
            c["effects"] = ddh
            changed = True

        # Pacificatrice Enjouée #1519, replace the stranded DamageData with a passive
        # DamageEnemiesOnAllyHeal (every enemy creature hit each time an ally is healed).
        deh = parse_damage_enemies_on_ally_heal(c)
        if deh and c.get("effects") != deh:
            c["effects"] = deh
            changed = True

        # Ratchet #589, replace the stranded DamageData with a passive
        # DamageDofusOnRowOnButinPickup (enemy Dofus of its row hit each time its owner
        # picks up a Butin). applyButinReward fires it; @damage@ reads the marker's amount.
        ddbp = parse_damage_dofus_on_butin_pickup(c)
        if ddbp and c.get("effects") != ddbp:
            c["effects"] = ddbp
            changed = True

        # Sacrifice #576, replace the bindata DamageData{PrimaryTargetCurrentAttackValue} (a
        # two-target value the flat-effect path cannot model) with a two-step SacrificeForDamage
        # spell: 1st pick = ally to sacrifice, 2nd pick = creature hit for the sacrificed AT.
        sfd = parse_sacrifice_for_damage(c)
        if sfd and c.get("effects") != sfd:
            c["effects"] = sfd
            changed = True

        # Lame Émoussée #1177, replace the two stranded DamageData (1 + 5) with a two-step
        # LameEmoussee: 1st pick = ally hit for `self`, 2nd pick = a wounded enemy hit for `enemy`.
        lem = parse_lame_emoussee(c)
        if lem and c.get("effects") != lem:
            c["effects"] = lem
            changed = True

        # Pluie de Météorites #1350, replace the DamageData{PrimaryTargetCurrentArmorValue} with a
        # two-step DestroyArmorForDamage: 1st pick = ally (armour destroyed), 2nd pick = another
        # creature hit for that armour, then draw. 2nd pick optional but always required to finish.
        dafd = parse_destroy_armor_for_damage(c)
        if dafd and c.get("effects") != dafd:
            c["effects"] = dafd
            changed = True

        # Attaque Naturelle #1012, replace the stranded single-target DamageData{1} with a global
        # DamageDofusPerArmoredAlly (each armoured ally hits the enemy Dofus on its row).
        atn = parse_attaque_naturelle(c)
        if atn and c.get("effects") != atn:
            c["effects"] = atn
            changed = True

        # Sacrifice Véritable #861, replace DamageData{TargetCurrentAttackValue} (unresolved value)
        # with DamageAllByOwnAttack (every creature takes its own AT).
        sv = parse_sacrifice_veritable(c)
        if sv and c.get("effects") != sv:
            c["effects"] = sv
            changed = True

        # Sacrifice Poupesque #89, replace DamageData{NumberOfSummonInTargetRowValue} with the
        # per-row SacrificePoupesque effect (damage the front enemy of each row by 2×poupées, then
        # destroy your poupées).
        sp = parse_sacrifice_poupesque(c)
        if sp and c.get("effects") != sp:
            c["effects"] = sp
            changed = True

        # Pacte de Sang #476, "Inflige @damage@ aux invocations alliées puis leur confère +1 AT."
        # Global (AlliedGod) self-AoE: damage all your creatures by 1, then +1 AT to the survivors.
        # The bindata only kept the single DamageData{1}; author the scoped AoE pair (order matters).
        if c["id"] == 476:
            pacte = [{"type": "AoeDamage", "amount": 1, "scope": "allies", "_authored": True},
                     {"type": "BoostAttack", "amount": 1, "scope": "allies", "_authored": True}]
            if c.get("effects") != pacte:
                c["effects"] = pacte
                changed = True

        # Sinistro #215, replace the bindata [SinistroData, DamageData{1}, SetPropertyData
        # {EquipementAttached}] with a single AttachSinistro (placement must not damage the host
        # Dofus, castTarget contains "Dofus" so dofusTargetable is true; the engine then fires the
        # totem at FIN_DE_TOUR and breaks it if the host is wounded). Idempotent via equality.
        ats = parse_attach_sinistro(c)
        if ats and c.get("effects") != ats:
            c["effects"] = ats
            changed = True

        # Arty #834, drop the NoSummoningSickness self-property (Arty is summoning-sick like any
        # creature; the cancel is for its RALLIERS, applied by applyRally keyed on the card id).
        arty = parse_arty_strip_self_sickness(c)
        if arty is not None and c.get("effects") != arty:
            c["effects"] = arty
            changed = True

        # (Coup de Sang #570's SetAttack `add` flag is set in the second pass below, SetAttack
        # is implemented and re-injected here, which would strip the flag if set in this pass.)

        # Zorine #668, replace the unconditional bindata FirstStrike with a continuous
        # outnumbered-gated self-buff (+N AT + initiative only while strictly fewer allies
        # than the foe). ConditionalStatBoost/FirstStrike are managed → survive the strip.
        onb = parse_outnumbered_self_buff(c)
        if onb and c.get("effects") != onb:
            c["effects"] = onb
            changed = True

        # Ronce #384, append SeedReserveOnKill (a seed banked only if the picked creature
        # dies). Not managed, so it survives the card.effects strip; appended idempotently.
        sok = parse_seed_on_kill(c)
        if sok and not any(e.get("type") == "SeedReserveOnKill" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [sok]
            changed = True

        # Flèche d'Immolation #351, append DrawOnKill (draw if the spell's target dies),
        # alongside the existing damage. Guarded so it stays idempotent across reruns.
        dok = parse_draw_on_kill(c)
        if dok and not any(e.get("type") == "DrawOnKill" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [dok]
            changed = True

        # Flèche Chercheuse #38, append RecoverOnKill (return the spell to hand with a
        # +N PA surcharge if the spell's target dies). Idempotent like DrawOnKill.
        rok = parse_recover_on_kill(c)
        if rok and not any(e.get("type") == "RecoverOnKill" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [rok]
            changed = True

        # Craps #10, replace the broken bindata effects with a CoinFlip → ScatterDamageDofus
        # ("6 OU 3 dégâts répartis entre les Dofus adverses"). Re-detected from the description.
        scat = parse_scatter_dofus(c)
        if scat is not None and c.get("effects") != scat:
            c["effects"] = scat
            changed = True
            continue

        # Empathie #1532, append a single-target Heal alongside the bindata Shield
        # ("Confère bouclier … PUIS la soigne de N PV"). Heal is managed → stripped on
        # rerun, re-appended here → idempotent.
        heal_n = parse_then_heal(c)
        if heal_n is not None and not any(e.get("type") == "Heal" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [{"type": "Heal", "amount": heal_n, "_authored": True}]
            changed = True

        # 1a³⁴) "Gagne +N AR tant que vous avez un [autre] <famille|carte> en jeu"
        #       (Rat Devil #387 → Rat Dechant #91 ; Boufton Noir #559 → autre Gobbal),
        #       append ConditionalArmorWhileAlly (transition-based, managed → idempotent).
        caw = parse_conditional_armor(c)
        if caw and not any(e.get("type") == "ConditionalArmorWhileAlly" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [caw]
            changed = True

        # "Augmente de N PA le coût des cartes de la main adverse courante pendant 1 tour"
        # (Ralentissement #188): add EnemyHandSurcharge (temporary, managed, so idempotent).
        ehs = parse_enemy_hand_surcharge(c)
        if ehs and not any(e.get("type") == "EnemyHandSurcharge" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [ehs]
            changed = True

        # "Tant qu'il est en jeu, les cartes défaussées sont bannies à la place"
        # (Nécro Phorreur #1221): add BanishAllDiscards (passive marker, managed, so
        # idempotent).
        bad = parse_banish_all_discards(c)
        if bad and not any(e.get("type") == "BanishAllDiscards" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [bad]
            changed = True

        # "Choisissez une invocation alliée pour qu'elle protège un dofus. Elle subira
        # les dégâts à sa place." (Lien de Sang #1495): add ProtectDofus (two-step spell,
        # managed, so idempotent).
        pdf = parse_protect_dofus(c)
        if pdf and not any(e.get("type") == "ProtectDofus" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [pdf]
            changed = True

        # Basic Glyphe #827 (Féca), "confère au Féca qui marche dessus ...": add
        # PlaceGlyph (the rest is the step-on-glyph logic). Idempotent.
        bgl = parse_base_glyph(c)
        if bgl and not any(e.get("type") == "PlaceGlyph" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [bgl]
            changed = True

        # "Tant qu'il est en jeu, réduit de N les dégâts des sorts adverses" (#110):
        # add SpellDamageReductionAura (passive, idempotent).
        sdr = parse_spell_damage_reduction(c)
        if sdr and not any(e.get("type") == "SpellDamageReductionAura" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [sdr]
            changed = True

        # "Jouez cette carte pour vous en débarasser" (Poils de Jiji #281): add NoOp
        # (a junk card with no effect, made playable; idempotent).
        nop = parse_noop_junk(c)
        if nop and not any(e.get("type") == "NoOp" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [nop]
            changed = True

        # 1a¹²ᵇ) "Ajoute N PA à votre réserve" (Brûlure Temporelle #93, alongside its @damage@)
        #        append AddReserve {N, caster}. Most reserve adders carry it in bindata; #93's
        #        clause is description-only. Guarded `not any(AddReserve)` so a bindata adder
        #        (Exactitude #662) is not doubled; managed → stripped+re-added → idempotent.
        addres = parse_add_reserve(c)
        if addres and not any(e.get("type") == "AddReserve" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [addres]
            changed = True

        # "Tant qu'elle est en main, son coût est réduit de N PA quand une invocation
        # [ennemie] meurt" (Nonne #1643, Impératrice Galantine #1300): add
        # HandCostOnEvent (top level, read when deaths are resolved).
        hce = parse_hand_cost_on_event(c)
        if hce and not any(e.get("type") == "HandCostOnEvent" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [hce]
            changed = True

        # 1a⁷ᵇ) Continuous ConditionalStatBoost with a board condition (Requinou,
        #       Canne Jalman, Exécuteur), append (managed → idempotent).
        csc = parse_conditional_stat_condition(c)
        if csc and not any(e.get("type") == "ConditionalStatBoost" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [csc]
            changed = True

        # 1a⁸) "APPARITION : charge de N cases" (Corbac #56 …), append SelfCharge
        #      marker (read by summonCreature; managed → idempotent).
        scg = parse_self_charge(c)
        if scg and not any(e.get("type") == "SelfCharge" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [scg]
            changed = True

        # 1b) Trigger authoring (independent of the flat-effect spell path
        #     below). For each trigger slot: drop our previously-authored
        #     effects, and, if the slot is then empty (no real bindata),
        #     inject the spec's faithful effects for that trigger type.
        sp_t = spec.get(c["id"])
        if c.get("triggers"):
            # Always strip our previously-authored trigger effects first, for
            # every card, so a tightened filter cleanly removes what a looser
            # past run wrote (idempotent), even for bindata cards we will not
            # re-inject into.
            for trig in c["triggers"]:
                all_e = trig.get("effects") or []
                cur = [e for e in all_e if not e.get("_authored")]
                if len(cur) != len(all_e):
                    trig["effects"] = cur
                    changed = True
            # Scaraboss #607 "APPARITION : Gagne +N AR", synth a self armour buff
            # into the APPARITION slot (build_effects_spec captures Scarabrute #1453's
            # but misses Scaraboss's multi-clause one). Reuse the working BoostArmor
            # {self} effect (a self-APPARITION sets ctx.targetCell to the creature's
            # own cell, so a scope-less BoostArmor lands on it). _authored → stripped
            # above on rerun, re-added here → idempotent; guarded so a card that
            # already carries a BoostArmor is not doubled.
            armor_n = parse_apparition_armor(c)
            if armor_n is not None:
                for trig in c["triggers"]:
                    if trig.get("trigger") == "APPARITION" and not any(e.get("type") == "BoostArmor" for e in (trig.get("effects") or [])):
                        trig["effects"] = (trig.get("effects") or []) + [{"type": "BoostArmor", "amount": armor_n, "self": True, "_authored": True}]
                        changed = True
            # Luc Ossit #769 "APPARITION : S'inflige @damage@", synth a SelfDamageData
            # into the APPARITION slot (the @damage@ placeholder is not a literal the
            # trigger parser catches). _authored → stripped/re-added → idempotent.
            selfdmg_n = parse_apparition_self_damage(c)
            if selfdmg_n is not None:
                for trig in c["triggers"]:
                    if trig.get("trigger") == "APPARITION" and not any(e.get("type") == "SelfDamageData" for e in (trig.get("effects") or [])):
                        trig["effects"] = (trig.get("effects") or []) + [{"type": "SelfDamageData", "Damage": selfdmg_n, "_authored": True}]
                        changed = True
            # Instantina #371 "APPARITION : Infligez X dégâts ou Y si réserve >= N": put a single
            # targeted DamageData with a reserve-threshold amount in the APPARITION slot (the
            # trigger parser cannot read the "ou ... si" branch). _authored, so idempotent.
            resdmg = parse_apparition_reserve_damage(c)
            if resdmg is not None:
                for trig in c["triggers"]:
                    if trig.get("trigger") == "APPARITION" and not any(e.get("type") == "DamageData" for e in (trig.get("effects") or [])):
                        trig["effects"] = (trig.get("effects") or []) + [resdmg]
                        changed = True
            # Diod Dewit #337 "APPARITION : Placez un Sinistro sur un Dofus", inject a targeted
            # AttachSinistro into the APPARITION slot (opens an allied-Dofus pick; its targeted
            # APPARITION routes through the deferred-summon path, holding Diod Dewit off-board until
            # the Dofus is chosen). _authored → 1b strips/re-adds → idempotent. The stranded
            # card-level bindata ([SinistroData, DamageData, SetPropertyData]) is dropped below so
            # Diod Dewit stays a clean 1/4/3, its Sinistro lives in the APPARITION, not innately.
            if c["id"] == 337:
                for trig in c["triggers"]:
                    if trig.get("trigger") == "APPARITION" and not any(e.get("type") == "AttachSinistro" for e in (trig.get("effects") or [])):
                        trig["effects"] = (trig.get("effects") or []) + [{"type": "AttachSinistro", "_authored": True}]
                        changed = True
                if c.get("effects"):
                    c["effects"] = []
                    changed = True
            # Dwanlaposh #802 "APPARITION : Fait apparaître un Butin allié sur vos cases de
            # départ. Gagne +1 AT et +1 AR pour chaque prisme remplacé." The description parser
            # of build_card_pool only finds "+1 AT" (BoostAttackData) and misses the Butin spawn
            # and the +1 AR, so the whole APPARITION slot is replaced by a single
            # SpawnButinsOnStartCells marker (the executor places the Butins on every free start
            # cell and buffs itself for each prism replaced). It is _authored, so it is stripped
            # and added again on each run; the slot is set rather than appended, so the extra
            # BoostAttackData goes away.
            if c["id"] == 802:
                for trig in c["triggers"]:
                    if trig.get("trigger") == "APPARITION":
                        trig["effects"] = [{"type": "SpawnButinsOnStartCells", "attackPerPrism": 1, "armorPerPrism": 1, "_authored": True}]
                        changed = True
                if c.get("effects"):
                    c["effects"] = []
                    changed = True
            # Moumoune #989 "CONTRE COUP : Se transforme en Phorzerker 6/6." The spec parser only
            # gives a plain Transform into token #800 (printed 5/5, cost 3). The CONTRE_COUP slot is
            # replaced by a Transform with the stats and cost changed: AT/PV parsed from the "6/6"
            # in the text, and the cost in play set to Moumoune's own cost (a Phorzerker keeps the
            # cost of the Énutrof it came from). Set before the spec injection below (which only
            # fills empty trigger slots); _authored, so it is stripped and added again each run.
            if c["id"] == 989:
                m989 = re.search(r"phorzerker\s+(\d+)\s*/\s*(\d+)", strip_markup(c.get("description", "")), re.I)
                at989, pv989 = (int(m989.group(1)), int(m989.group(2))) if m989 else (6, 6)
                for trig in c["triggers"]:
                    if trig.get("trigger") == "CONTRE_COUP":
                        trig["effects"] = [{"type": "Transform", "tokenId": 800, "asOwner": "keep", "self": True,
                                            "attack": at989, "life": pv989, "cost": c.get("cost", 6), "_authored": True}]
                        changed = True
            # "Faciles" batch (see _FACILES_INJECT): wire each stranded APPARITION/MORT
            # action onto its trigger slot. _authored → 1b strips/re-adds → idempotent;
            # guarded so a card already carrying the effect is not doubled.
            if c["id"] in _FACILES_INJECT:
                fk_trig, fk_eff = _FACILES_INJECT[c["id"]]
                for trig in c["triggers"]:
                    if trig.get("trigger") == fk_trig and not any(e.get("type") == fk_eff["type"] for e in (trig.get("effects") or [])):
                        trig["effects"] = (trig.get("effects") or []) + [dict(fk_eff, _authored=True)]
                        changed = True
            # Remington Smisse #178/#334 "MORT : Dépose N Bombe(s) sur sa case / autour de
            # lui" gives PlaceBombe {count, placement} on the MORT slot (Bombe traps owned by
            # the source's camp). The ShooterRangeData stays in effects[] (bindata, not
            # _authored, so the trigger strip keeps it). _authored, so idempotent.
            pb = parse_place_bombe(c)
            if pb is not None:
                for trig in c["triggers"]:
                    if trig.get("trigger") == "MORT" and not any(e.get("type") == "PlaceBombe" for e in (trig.get("effects") or [])):
                        trig["effects"] = (trig.get("effects") or []) + [pb]
                        changed = True
            # Remington Smisse #80 "APPARITION : Transformez un prisme en Bombe" gives
            # TransformPrismToBombe (pick any_prism, it becomes a Bombe trap of the source's camp)
            # on the APPARITION slot. ShooterRangeData stays in effects[]. _authored, so idempotent.
            ptb = parse_transform_prism_to_bombe(c.get("description", ""))
            if ptb is not None:
                for trig in c["triggers"]:
                    if trig.get("trigger") == "APPARITION" and not any(e.get("type") == "TransformPrismToBombe" for e in (trig.get("effects") or [])):
                        trig["effects"] = (trig.get("effects") or []) + [ptb]
                        changed = True
            # Inject from `trigger_effects`, the spec's per-trigger-block
            # PARSER output (always strict: single-target, concrete, no AoE /
            # dynamic). This is independent of the card's flat-effect source, so
            # bindata summons whose APPARITION action is stranded in flat
            # effects[] get it wired into the (empty) trigger slot.
            if sp_t and sp_t.get("trigger_effects"):
                by_when = {}
                for e in sp_t["trigger_effects"]:
                    w = e.get("when")
                    if w in TRIGGER_KINDS:
                        by_when.setdefault(w, []).append(e)
                for trig in c["triggers"]:
                    if trig.get("effects"):
                        continue  # real bindata effects → leave untouched
                    cand = by_when.get(trig.get("trigger"), [])
                    if not cand or not all(e.get("type") in TRIGGER_OK_TYPES for e in cand):
                        continue
                    # Every numeric field must be a plain int (no dynamic objects).
                    if not all(
                        isinstance(e.get(k), int)
                        for e in cand
                        for k in ("amount", "Damage", "Boost", "Heal")
                        if k in e
                    ):
                        continue
                    # Resolve AddCardToHand card name → id; skip the whole
                    # trigger if any name does not resolve (no partial cards).
                    built = []
                    ok = True
                    for e in cand:
                        ej = {k: v for k, v in e.items() if k != "when"}
                        # Family-buff: resolve the raw French family word to a key.
                        if "familyRaw" in ej:
                            sel = map_tutor_filter(ej.pop("familyRaw"))
                            if sel is None or "family" not in sel:
                                ok = False
                                break
                            ej["family"] = sel["family"]
                        if e.get("type") == "AddCardToHand":
                            cid = resolve_card(e.get("card", ""))
                            if cid is None:
                                ok = False
                                break
                            ej = {"type": "AddCardToHand", "cardId": cid, "amount": int(e.get("amount") or 0)}
                        elif e.get("type") == "SummonToken":
                            tok = e.get("token", "")
                            tid = resolve_token(tok)
                            if tid is not None:
                                ej = {"type": "SummonToken", "tokenId": tid,
                                      "amount": int(e.get("amount") or 0), "placement": e.get("placement", "near")}
                            else:
                                # No single token by that name → maybe it names a
                                # family ("2 Chachas" = a random Chacha each).
                                sel = map_tutor_filter(tok)
                                if not (sel and "family" in sel):
                                    ok = False
                                    break
                                ej = {"type": "SummonToken", "family": sel["family"],
                                      "amount": int(e.get("amount") or 0), "placement": e.get("placement", "near")}
                        elif e.get("type") == "Transform":
                            tid = resolve_token(e.get("into", ""))
                            if tid is None:
                                ok = False
                                break
                            ej = {"type": "Transform", "tokenId": tid, "asOwner": "keep", "self": True}
                        elif e.get("type") == "TransformAll":
                            into = e.get("into", "")
                            # "en invocations aléatoires coûtant N PA" (Otomaï):
                            # each target becomes a random Summon of that cost.
                            mcost = re.search(r"al[ée]atoires?\s+co[uû]tant\s+(\d+)\s*pa", strip_markup(into))
                            if mcost:
                                new = {"type": "TransformAll", "randomCost": int(mcost.group(1))}
                            else:
                                tid = resolve_token(into)
                                if tid is None:
                                    ok = False
                                    break
                                new = {"type": "TransformAll", "tokenId": tid}
                            for k in ("scope", "excludeSelf"):
                                if k in e:
                                    new[k] = e[k]
                            if "family" in ej:  # resolved by the familyRaw block above
                                new["family"] = ej["family"]
                            ej = new
                        elif e.get("type") == "TutorFromDeck":
                            sel = map_tutor_filter(e.get("filter", ""))
                            if sel is None:
                                ok = False
                                break
                            ej = {"type": "TutorFromDeck", "from": e.get("from", "top"),
                                  "amount": int(e.get("amount") or 1), **sel}
                            if e.get("costMod"):
                                ej["costMod"] = int(e["costMod"])
                        ej["_authored"] = True
                        built.append(ej)
                    if not ok:
                        continue
                    trig["effects"] = built
                    changed = True
                    patched_triggers += 1

        # 1c) CHEF aura, a continuous buff stored as ChiefAura effect(s) in the
        #     Summon's effects[]. The flat strip above already removed any prior
        #     ChiefAura (it is managed), so we just append the freshly parsed one.
        if c.get("cardType") == "Summon":
            chief = parse_chief_aura(c.get("description", "")) \
                or parse_chief_resistance_aura(c.get("description", "")) \
                or parse_board_attack_aura(c.get("description", "")) \
                or parse_enemy_attack_debuff(c.get("description", ""))
            if chief:
                effs = list(c.get("effects") or [])
                # Craqueboule Or #26: the bindata flattens the CHEF résistance
                # aura into a second BoostResistanceData next to the innate
                # RÉSISTANCE keyword, summonCreature would bake both onto the
                # chief itself (résistance 2). Drop the flattened copy: one
                # matching entry per resistance aura, and only while a duplicate
                # remains (≥2) → idempotent across reruns.
                for a in chief:
                    if a.get("stat") == "resistance":
                        dups = [i for i, e in enumerate(effs)
                                if e.get("type") == "BoostResistanceData"
                                and (e.get("Boost") == a["amount"] or (isinstance(e.get("Boost"), dict) and e["Boost"].get("const") == a["amount"]))]
                        if len(dups) >= 2:
                            del effs[dups[-1]]
                c["effects"] = effs + chief
                kept = c["effects"]  # keep the "bindata card" branch consistent
                changed = True
                patched_chief += 1
            # CHEF property aura (Dan Lemil #718 perce armure, Joris #307 inciblable):
            # convert the self SetPropertyData into a ChiefPropertyAura granted to other allies.
            if apply_chief_property_aura(c):
                kept = c["effects"]
                changed = True
            # BLESSÉ keyword, continuous self stat buff while wounded (managed,
            # so the flat strip dropped any prior copy → idempotent).
            wb = parse_wounded_self_buff(c.get("description", ""))
            if wb:
                c["effects"] = (c.get("effects") or []) + wb
                kept = c["effects"]
                changed = True
            # Soldat Cornouiller #1560, a continuous SeedStepDamage aura stored
            # in effects[] (managed, so the strip above dropped any prior copy →
            # idempotent). The engine reads it from the seed owner's creatures.
            ssd_aura = parse_seed_step_damage(c.get("description", ""))
            if ssd_aura:
                c["effects"] = (c.get("effects") or []) + [ssd_aura]
                kept = c["effects"]
                changed = True
            # Kolo Kolko #27, replace the unconditional bindata SetPropertyData
            # (initiative/inciblable) by a continuous ConditionalSeedProperty that
            # withAuras toggles on seedInPlay. Drop only the matching SetPropertyData
            # keywords; keep any other effects. Idempotent via equality + managed.
            csp = parse_conditional_seed_property(c.get("description", ""))
            if csp:
                cond_props = set(csp["properties"])
                rest = [
                    e for e in (c.get("effects") or [])
                    if not (e.get("type") == "SetPropertyData" and e.get("PropertyType") in cond_props)
                ]
                new_effects = rest + [csp]
                if c.get("effects") != new_effects:
                    c["effects"] = new_effects
                    kept = c["effects"]
                    changed = True
            # Conditional FirstStrike (Tristepin), same idea: a continuous
            # keyword stored in effects[], recomputed live by the engine. Also
            # managed, so the strip above already dropped any prior copy.
            cfs = parse_conditional_first_strike(c.get("description", ""))
            if cfs:
                c["effects"] = (c.get("effects") or []) + [cfs]
                kept = c["effects"]
                changed = True
            # Conditional stat boost (Evangelyne "+2 AT / +2 portée si un autre
            # membre de la Confrérie du Tofu est en jeu"): continuous, stored in
            # effects[] and recomputed by withAuras. Managed, so the strip above
            # already removed any older copy.
            csb = parse_conditional_stat_boost(c.get("description", ""))
            if csb:
                c["effects"] = (c.get("effects") or []) + [csb]
                kept = c["effects"]
                changed = True
            # Continuous cost-auras, CardCostAura passives stored in effects[],
            # read by effectiveCost from the owner's living creatures when pricing
            # a card of the matching scope. Alchimiste Armurée #819 (glyph −1),
            # Felida #216 (summon −1, spell +1). Managed, so the strip above
            # dropped any prior copy → idempotent.
            cost_auras = parse_cost_auras(c.get("description", ""))
            if cost_auras:
                c["effects"] = (c.get("effects") or []) + cost_auras
                kept = c["effects"]
                changed = True
            # Raku Kapi #960 "Coûte N PA de moins par invocation alliée blessée en
            # jeu", a SelfCostReduction marker in effects[] read live by
            # effectiveCost (never applied to the creature). Managed → the strip
            # drops any prior copy → idempotent.
            scr = parse_self_cost_reduction(c.get("description", ""))
            if scr:
                c["effects"] = (c.get("effects") or []) + [scr]
                kept = c["effects"]
                changed = True
            # Dente le Remonteur #436 "Se pose gratuitement si vous avez au moins N
            # PA dans votre réserve": a FreeIfReserve marker read by effectiveCost
            # (never applied). Managed, so stripped on each run.
            fir = parse_free_if_reserve(c.get("description", ""))
            if fir:
                c["effects"] = (c.get("effects") or []) + [fir]
                kept = c["effects"]
                changed = True
            # The bare "Charge" keyword → a ChargeSelf effect on each trigger it sits
            # under: "APPARITION : Charge" (Tristepin) charges the instant it lands;
            # "COUP DE GRÂCE : Charge" (Goultard #187) charges again after a killing
            # blow; Milkar #46 carries both ("APPARITION : Charge\nCOUP DE GRÂCE :
            # Charge") → a ChargeSelf on each trigger. Attaching to the right triggers
            # (not always APPARITION) keeps #187 from wrongly losing its summoning
            # sickness. _authored so 1b strips any prior copy → idempotent.
            ck_trigs = charge_keyword_triggers(c.get("description", ""))
            if ck_trigs:
                trigs = c.get("triggers") or []
                for ck_trig in ck_trigs:
                    slot = next((t for t in trigs if t.get("trigger") == ck_trig), None)
                    if slot is None:
                        slot = {"trigger": ck_trig, "effects": []}
                        trigs = trigs + [slot]
                        c["triggers"] = trigs
                    if not any(e.get("type") == "ChargeSelf" for e in (slot.get("effects") or [])):
                        slot["effects"] = (slot.get("effects") or []) + [{"type": "ChargeSelf", "_authored": True}]
                        changed = True
                # The creature may act the turn it lands only if a bare Charge sits under
                # APPARITION (Tristepin, Milkar #46). A purely reactive Charge (Goultard
                # #187 "COUP DE GRÂCE : Charge") must stay summoning-sick: drop any stale
                # NoSummoningSickness from properties[] (a leftover from an older keyword
                # pass, the raw bindata never carries it). Idempotent.
                if "APPARITION" not in ck_trigs and "NoSummoningSickness" in (c.get("properties") or []):
                    c["properties"] = [p for p in c["properties"] if p != "NoSummoningSickness"]
                    changed = True
            # "APPARITION : Charge de 1d6 case(s)" (Defhi Croquets #319) → a ChargeSelf
            # with a dice cells on the APPARITION trigger. Separate from the keyword
            # "Charge" above (full PM) and from parse_self_charge's fixed-N SelfCharge
            # marker: the die is rolled in runTrigger so it fires the Ecaflip roll
            # reactions. _authored → 1b strips any prior copy → idempotent.
            dch = parse_apparition_dice_charge(c)
            if dch:
                trigs = c.get("triggers") or []
                app = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if app is None:
                    app = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [app]
                    c["triggers"] = trigs
                if not any(e.get("type") == "ChargeSelf" for e in (app.get("effects") or [])):
                    app["effects"] = (app.get("effects") or []) + [dch]
                    changed = True
            # "APPARITION : Échangez sa position avec une de vos invocations
            # ayant N AT ou moins" (Moskito) gives a targeted SwapSourcePosition on
            # the APPARITION trigger. _authored, so the trigger strip removes older copies.
            ssp = parse_swap_source_position(c.get("description", ""))
            if ssp:
                trigs = c.get("triggers") or []
                app = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if app is None:
                    app = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [app]
                    c["triggers"] = trigs
                if not any(e.get("type") == "SwapSourcePosition" for e in (app.get("effects") or [])):
                    app["effects"] = (app.get("effects") or []) + [ssp]
                    changed = True
            # "APPARITION : Échangez son AT avec une autre invocation" (Asprogik
            # Mils #525) → a targeted SwapSourceAttack on the APPARITION trigger.
            # _authored so 1b strips any prior copy → idempotent.
            ssa = parse_swap_source_attack(c.get("description", ""))
            if ssa:
                trigs = c.get("triggers") or []
                app = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if app is None:
                    app = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [app]
                    c["triggers"] = trigs
                if not any(e.get("type") == "SwapSourceAttack" for e in (app.get("effects") or [])):
                    app["effects"] = (app.get("effects") or []) + [ssa]
                    changed = True
            # "APPARITION : Échangez ses PM avec une autre invocation" (Chacha
            # Sauvage #1276) → a targeted SwapSourceMovement on the APPARITION trigger.
            ssm = parse_swap_source_movement(c.get("description", ""))
            if ssm:
                trigs = c.get("triggers") or []
                app = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if app is None:
                    app = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [app]
                    c["triggers"] = trigs
                if not any(e.get("type") == "SwapSourceMovement" for e in (app.get("effects") or [])):
                    app["effects"] = (app.get("effects") or []) + [ssm]
                    changed = True
            # "APPARITION : Donnez +N AR à une invocation ou +M si elle est
            # blessée" (Saizan Zen #522) gives a targeted BoostArmor whose amount
            # depends on wounds, on the APPARITION trigger. _authored, so the
            # trigger strip removes older copies.
            wag = parse_wounded_armor_grant(c.get("description", ""))
            if wag:
                trigs = c.get("triggers") or []
                app = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if app is None:
                    app = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [app]
                    c["triggers"] = trigs
                if not any(e.get("type") == "BoostArmor" for e in (app.get("effects") or [])):
                    app["effects"] = (app.get("effects") or []) + [wag]
                    changed = True
            # "APPARITION : Soignez un Dofus de N PV" (Dollie Praan #650) → a
            # targeted Heal {dofus:true} on the APPARITION trigger (pick any_dofus).
            # _authored so 1b strips any prior copy → idempotent.
            hd = parse_heal_dofus(c.get("description", ""))
            if hd:
                trigs = c.get("triggers") or []
                app = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if app is None:
                    app = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [app]
                    c["triggers"] = trigs
                if not any(e.get("type") == "Heal" and e.get("dofus") for e in (app.get("effects") or [])):
                    app["effects"] = (app.get("effects") or []) + [hd]
                    changed = True
            # Radoris Montrouge #489: "APPARITION : dépense vos PA. Gagne +1 AT/+1 AR par PA
            # utilisé." → replace the APPARITION slot's effects with SpendApAsBuff (overrides
            # the wrong flat BoostAttackData bindata). summonCreature applies it to the source
            # (spend remaining AP → +1 AT/+1 AR per AP). SpendApAsBuff is managed + _authored
            # → the 1b trigger-strip drops the prior copy → idempotent.
            sasb = parse_spend_ap_self_buff(c)
            if sasb:
                trigs = c.get("triggers") or []
                app = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if app is None:
                    app = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [app]
                    c["triggers"] = trigs
                if app.get("effects") != sasb:
                    app["effects"] = sasb
                    changed = True
            # Padgref Démouelle #222 "infligez N dégât à un de vos dofus pour l'invoquer":
            # a DamageDofus pick on the APPARITION (the creature is kept off the board by the
            # deferred-summon code), and the unused single-target bindata DamageData is dropped.
            # Has to run after the trigger strip (the effect is _authored, so writing it earlier
            # would get it stripped), which is why it sits with the other APPARITION authors.
            pad = parse_damage_own_dofus_to_summon(c)
            if pad is not None:
                padeff = [{"type": "DamageDofus", "amount": pad, "side": "ally", "_authored": True}]
                trigs = c.get("triggers") or []
                app = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if app is None:
                    app = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [app]
                    c["triggers"] = trigs
                if app.get("effects") != padeff:
                    app["effects"] = padeff
                    changed = True
                if any(e.get("type") == "DamageData" for e in (c.get("effects") or [])):
                    c["effects"] = [e for e in (c.get("effects") or []) if e.get("type") != "DamageData"]
                    changed = True
            # Pampactus #218 "Infligez 1 dégât à une invocation alliée pour l'invoquer": a
            # DamageAllyToSummon pick on the APPARITION (kept off the board by the deferred-summon
            # code), and the unused single-target bindata DamageData is dropped. Same shape as Padgref.
            pamp = parse_damage_ally_to_summon(c)
            if pamp is not None:
                pampeff = [{"type": "DamageAllyToSummon", "amount": pamp, "_authored": True}]
                trigs = c.get("triggers") or []
                app = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if app is None:
                    app = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [app]
                    c["triggers"] = trigs
                if app.get("effects") != pampeff:
                    app["effects"] = pampeff
                    changed = True
                if any(e.get("type") == "DamageData" for e in (c.get("effects") or [])):
                    c["effects"] = [e for e in (c.get("effects") or []) if e.get("type") != "DamageData"]
                    changed = True
            # Tofu Explosif #155 / Nox #353, inject the authored MORT effect into the (empty) MORT
            # slot and drop the stranded DamageData{<unresolved value>} from effects[].
            for _mortparse in (parse_tofu_explosif, parse_nox):
                morteff = _mortparse(c)
                if morteff is None:
                    continue
                trigs = c.get("triggers") or []
                mt = next((t for t in trigs if t.get("trigger") == "MORT"), None)
                if mt is None:
                    mt = {"trigger": "MORT", "effects": []}
                    trigs = trigs + [mt]
                    c["triggers"] = trigs
                if mt.get("effects") != morteff:
                    mt["effects"] = morteff
                    changed = True
                if any(e.get("type") == "DamageData" for e in (c.get("effects") or [])):
                    c["effects"] = [e for e in (c.get("effects") or []) if e.get("type") != "DamageData"]
                    changed = True
                break
            # Artheon #1424 "ciblez un dofus, il est invulnérable tant que cette invocation est en
            # jeu": a MakeDofusInvulnerable pick on the APPARITION (any_dofus; kept off the board by
            # the deferred-summon code), and the Invulnerable self property is dropped (the bindata
            # put it on Artheon, but it belongs to the picked Dofus, through invulnerableBy).
            if parse_artheon(c):
                arteff = [{"type": "MakeDofusInvulnerable", "_authored": True}]
                trigs = c.get("triggers") or []
                app = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if app is None:
                    app = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [app]
                    c["triggers"] = trigs
                if app.get("effects") != arteff:
                    app["effects"] = arteff
                    changed = True
                if any(e.get("type") == "SetPropertyData" and e.get("PropertyType") == "Invulnerable" for e in (c.get("effects") or [])):
                    c["effects"] = [e for e in (c.get("effects") or []) if not (e.get("type") == "SetPropertyData" and e.get("PropertyType") == "Invulnerable")]
                    changed = True
            # Grougaloragran #397, "Tant qu'il est en jeu, vos Dofus sont invulnérables." Same mis-bake
            # as Artheon: SetPropertyData Invulnerable was stamped on Grougal itself (unkillable 6/6).
            # Rewrite that self-property into an innate ProtectsOwnDofus, a passive aura over all own
            # Dofus (no pick): while Grougal lives, dofusInvulnerable treats every same-owner Dofus as
            # invulnerable, and Grougal himself becomes killable again. Idempotent.
            if parse_grougaloragran(c):
                effs = [e for e in (c.get("effects") or []) if not (e.get("type") == "SetPropertyData" and e.get("PropertyType") == "Invulnerable")]
                if not any(e.get("type") == "SetPropertyData" and e.get("PropertyType") == "ProtectsOwnDofus" for e in effs):
                    effs = effs + [{"type": "SetPropertyData", "PropertyType": "ProtectsOwnDofus", "_authored": True}]
                if effs != (c.get("effects") or []):
                    c["effects"] = effs
                    changed = True
            # Excarnus #523, "Vos autres Bouftous remontent dans votre main quand ils meurent."
            # The bindata bakes SetPropertyData ReturnToHandOnDeath on Excarnus itself (so only he
            # would return). Rewrite it into a flat ReturnFamilyToHandAura {family:"Gobbal"} marker
            # (read by returnsViaFamilyAura at death resolution): every other allied Bouftou returns
            # to hand while a living Excarnus of a different instance is in play (2 Excarnus cover
            # each other). Not a self-property → Excarnus alone goes to the discard. Idempotent.
            if c.get("id") == 523:
                effs = [e for e in (c.get("effects") or []) if not (e.get("type") == "SetPropertyData" and e.get("PropertyType") == "ReturnToHandOnDeath")]
                if not any(e.get("type") == "ReturnFamilyToHandAura" for e in effs):
                    effs = effs + [{"type": "ReturnFamilyToHandAura", "family": "Gobbal", "_authored": True}]
                if effs != (c.get("effects") or []):
                    c["effects"] = effs
                    changed = True
            # Goule Dorak #893, "HORDE / APPARITION : Bannit les Goules de votre défausse. Gagne
            # +1 AT et +1 AR par Goule bannie." The bindata stub was a flat BoostAttackData {Boost:1}
            # (always +1 AT, no banish, no AR). Replace the APPARITION effects with a single
            # BanishFamilyDiscardBuffSelf {family:"Goule", per:1}: count the Goules in the caster's
            # normal discard, +N AT and +N AR (permanent) to the source, then banish them. Idempotent.
            if c.get("id") == 893:
                want = [{"type": "BanishFamilyDiscardBuffSelf", "family": "Goule", "per": 1, "_authored": True}]
                for t in (c.get("triggers") or []):
                    if t.get("trigger") == "APPARITION" and t.get("effects") != want:
                        t["effects"] = want
                        changed = True
            # Cogneur Nimbos #905 "APPARITION : gagne <propriété> si une invocation adverse devant
            # lui": the bindata set the property statically (always on). It is made conditional on
            # enemyAheadOnRow (the static SetPropertyData becomes a ConditionalSelfProperty granted
            # at summon when the condition holds).
            csp = parse_conditional_self_property(c)
            if csp is not None and c.get("effects") != csp:
                c["effects"] = csp
                changed = True
            # Championne Embrocheuse #1023, "APPARITION : repousse les invocations adverses
            # de sa ligne de N cases" → AoePush scope:enemies shape:row on the APPARITION
            # (push the enemies on its line toward the enemy Dofus). Replaces the broken
            # single-target bindata PushData on the trigger and on card.effects (the
            # ShooterRangeData stays, it is the nécrome range). Must run after the 1b strip.
            emb = parse_apparition_push_enemy_row(c)
            if emb is not None:
                embeff = [{"type": "AoePush", "distance": emb, "scope": "enemies", "shape": "row", "_authored": True}]
                trigs = c.get("triggers") or []
                app = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if app is None:
                    app = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [app]
                    c["triggers"] = trigs
                if app.get("effects") != embeff:
                    app["effects"] = embeff
                    changed = True
                if any(e.get("type") == "PushData" for e in (c.get("effects") or [])):
                    c["effects"] = [e for e in (c.get("effects") or []) if e.get("type") != "PushData"]
                    changed = True
            # Kokoko #157 "APPARITION : repousse de N case les invocations adverses" (all of them,
            # no pick) gives AoePush {scope:enemies} (no shape means every enemy). Replaces the
            # single-target PushData on the trigger and on card.effects.
            kok = parse_apparition_push_all_enemies(c)
            if kok is not None:
                kokeff = [{"type": "AoePush", "distance": kok, "scope": "enemies", "_authored": True}]
                trigs = c.get("triggers") or []
                app = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if app is None:
                    app = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [app]
                    c["triggers"] = trigs
                if app.get("effects") != kokeff:
                    app["effects"] = kokeff
                    changed = True
                if any(e.get("type") == "PushData" for e in (c.get("effects") or [])):
                    c["effects"] = [e for e in (c.get("effects") or []) if e.get("type") != "PushData"]
                    changed = True
            # Roi des Bouftous #60 "APPARITION : Gagne +1 AT et +1 AR par autre Bouftou allié" gives
            # a count-based self BoostAttack + BoostArmor (resolved at summon), replacing the flat
            # BoostAttackData bindata on the APPARITION.
            rdb = parse_boost_self_per_family(c)
            if rdb is not None:
                trigs = c.get("triggers") or []
                app = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if app is None:
                    app = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [app]
                    c["triggers"] = trigs
                if app.get("effects") != rdb:
                    app["effects"] = rdb
                    changed = True
            # Tiwabbit Kiafin #477 "APPARITION : Gagne +1 AT et +1 AR si vous avez une Cawotte en
            # jeu" gives a self BoostAttack + BoostArmor with requireCondition allyFamilyInPlay,
            # replacing the flat BoostAttackData on the APPARITION.
            tki = parse_boost_self_if_family(c)
            if tki is not None:
                trigs = c.get("triggers") or []
                app = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if app is None:
                    app = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [app]
                    c["triggers"] = trigs
                if app.get("effects") != tki:
                    app["effects"] = tki
                    changed = True
            # Katar #458/#265/#324 "Attire la première invocation adverse devant lui [puis charge]"
            # replaces the detected slot with [AttractFirstAhead (, ChargeSelf)] (the full list, so
            # it is idempotent and does not depend on the order of a generic ChargeSelf wiring).
            afa = parse_attract_first_ahead(c)
            if afa is not None:
                kind, afaeff = afa
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == kind), None)
                if slot is None:
                    slot = {"trigger": kind, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if slot.get("effects") != afaeff:
                    slot["effects"] = afaeff
                    changed = True
            # Poum Ondacié #781 "APPARITION : gagne +N AT par invocation en jeu qui possède
            # de l'AR ou un bouclier" gives a count-based self BoostAttack (resolved at summon),
            # replacing the flat bindata BoostAttackData. Has to run after the trigger strip.
            poum = parse_poum_ondacie(c)
            if poum is not None:
                poumeff = [{"type": "BoostAttack", "self": True, "amount": {"count": {"scope": "all", "withArmorOrShield": True}, "per": poum}, "_authored": True}]
                trigs = c.get("triggers") or []
                app = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if app is None:
                    app = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [app]
                    c["triggers"] = trigs
                if app.get("effects") != poumeff:
                    app["effects"] = poumeff
                    changed = True
            # "APPARITION : Gagne N AT/AR/PM" (Karla Blondie, Takana) → a
            # self-targeted stat buff on the APPARITION trigger. effectRequiresTarget
            # returns false for a self stat-buff, so runTrigger applies it
            # immediately to the source (targetCell = its own cell), resolving any
            # 1d6 from the RNG. _authored so 1b strips any prior copy → idempotent.
            # "APPARITION : Gagne +N AT/AR/PM par X en jeu" (count-scaled self buff).
            scb = parse_self_count_buff(c.get("description", ""))
            scbk = detect_trigger_kind(c.get("description", "")) if scb else None
            if scb and scbk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == scbk), None)
                if slot is None:
                    slot = {"trigger": scbk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                # The bindata bakes the same buff as a flat <Stat>Data, the count was lost
                # in extraction (Tofu Dominant #177 / Chauve Souris Dodue #433 "+1 AT par
                # <famille> allié" → a flat BoostAttackData{Boost:1} that always adds +1,
                # even with 0 of that family). The authored count buff replaces it, so strip
                # the matching raw flat to avoid the double buff. (Not in MANAGED_TYPES → it
                # would not be stripped otherwise.)
                raw_of = {"BoostAttack": "BoostAttackData", "BoostArmor": "BoostArmorData", "BoostMovement": "BoostMovementData"}
                strip_types = {raw_of[e["type"]] for e in scb if e.get("type") in raw_of}
                pruned = [e for e in (slot.get("effects") or []) if e.get("type") not in strip_types]
                if pruned != (slot.get("effects") or []):
                    slot["effects"] = pruned
                    changed = True
                if not any(e.get("self") and (e.get("amount", {}).get("count") if isinstance(e.get("amount"), dict) else False) for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + scb
                    changed = True
            # "<TRIGGER> : Vos autres <invocations|famille> gagnent +N AT[ et +N AR]"
            # (Chacha Serval #1354 FIN DU TOUR; Scarafeuille Céleste #864) → recurring
            # family/ally flat stat buff on the detected slot (reuses Set-2 scoped
            # boost executors). _authored → stripped+re-injected each run → idempotent.
            oab = parse_other_allies_flat_buff(c.get("description", ""))
            oabk = detect_trigger_kind(c.get("description", "")) if oab else None
            if oab and oabk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == oabk), None)
                if slot is None:
                    slot = {"trigger": oabk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("scope") == "allies" and e.get("excludeSelf") and isinstance(e.get("amount"), int)
                           and e.get("type") in ("BoostAttack", "BoostArmor") for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + oab
                    changed = True
            # "<TRIGGER> : Vos autres <invocations|famille> chargent [de N cases]"
            # (Gligli Ancestral #196 DÉBUT DU TOUR; Gelée Citron #203 APPARITION, full charge)
            # gives ChargeAllies on the detected slot. Cards written by hand in the spec
            # (Jice #283) are skipped to avoid a duplicate; the dedup check covers re-runs.
            coa = parse_charge_other_allies(c.get("description", ""))
            coak = detect_trigger_kind(c.get("description", "")) if coa else None
            if coa and coak and not spec.get(c["id"], {}).get("effects"):
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == coak), None)
                if slot is None:
                    slot = {"trigger": coak, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "ChargeAllies" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [coa]
                    changed = True
            # "<TRIGGER> : Gagne autant d'AT/AR que de Graines alliées en jeu"
            # (Larch #990) → a self BoostX with a NumberOfSeedsValue amount on the
            # matching trigger slot (resolved against the board at the trigger).
            ssd = parse_self_seed_buff(c.get("description", ""))
            ssdk = detect_trigger_kind(c.get("description", "")) if ssd else None
            if ssd and ssdk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == ssdk), None)
                if slot is None:
                    slot = {"trigger": ssdk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(isinstance(e.get("amount"), dict) and e.get("amount", {}).get("type") == "NumberOfSeedsValue" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [ssd]
                    changed = True
            # "<TRIGGER> : Gagne autant d'AT/AR que de PA dans votre réserve" (Casey
            # Io #586) → a self BoostX with a ReserveValue amount on the matching
            # trigger slot (resolved against the caster's reserve at the trigger).
            srb = parse_self_reserve_buff(c.get("description", ""))
            srbk = detect_trigger_kind(c.get("description", "")) if srb else None
            if srb and srbk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == srbk), None)
                if slot is None:
                    slot = {"trigger": srbk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(isinstance(e.get("amount"), dict) and e.get("amount", {}).get("type") == "ReserveValue" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [srb]
                    changed = True
            # "Ajoute N PA à votre réserve [quand il subit des dégâts / si elle est
            # vide]" (Momie #360 on CONTRE_COUP; Lomega #1512 on FIN_DE_TOUR with the
            # reserveEmpty condition) gives AddReserve on the detected slot (created if
            # missing). AddReserve is player-state and _authored, so idempotent.
            arb = parse_add_reserve_trigger(c.get("description", ""))
            if arb:
                s_low = strip_markup(c.get("description", ""))
                arbk = "CONTRE_COUP" if "subit des d" in s_low else detect_trigger_kind(s_low)
                if arbk:
                    trigs = c.get("triggers") or []
                    slot = next((t for t in trigs if t.get("trigger") == arbk), None)
                    if slot is None:
                        slot = {"trigger": arbk, "effects": []}
                        trigs = trigs + [slot]
                        c["triggers"] = trigs
                    if not any(e.get("type") == "AddReserve" for e in (slot.get("effects") or [])):
                        slot["effects"] = (slot.get("effects") or []) + [arb]
                        changed = True
            # "<TRIGGER> : Passe à N les PM des invocations adverses" (Championne
            # Périmée #634) gives a scoped SetMovement {value:N, scope:enemies} on the
            # detected trigger slot. SetMovement is managed and _authored, so idempotent.
            sem = parse_set_enemy_movement(c.get("description", ""))
            semk = detect_trigger_kind(c.get("description", "")) if sem else None
            if sem and semk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == semk), None)
                if slot is None:
                    slot = {"trigger": semk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "SetMovement" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [sem]
                    changed = True
            # Caster-only deck mill: "Défausse les N premières cartes / N <fam> de
            # votre pioche" (Pierre Tombale #512, MUR APPARITION; Funérailles #930, flat
            # Spell) gives MillDeck. With a trigger keyword it goes on that slot, otherwise
            # it is flat (a Spell with no bindata). MillDeck is managed and _authored, so
            # idempotent.
            mds = parse_mill_deck_self(c.get("description", ""))
            mdsk = detect_trigger_kind(c.get("description", "")) if mds else None
            if mds and mdsk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == mdsk), None)
                if slot is None:
                    slot = {"trigger": mdsk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "MillDeck" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [mds]
                    changed = True
            # "APPARITION : Confère +N armure à une invocation" (Piou Rouge #52 /
            # Bleu #568) gives a single-target BoostArmor on the APPARITION slot (the
            # spec missed the "armure" wording). _authored, so idempotent.
            gat2 = parse_grant_armor_target(c) or parse_grant_armor_other_allies(c)
            if gat2 and detect_trigger_kind(strip_markup(c.get("description", ""))) == "APPARITION":
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if slot is None:
                    slot = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "BoostArmor" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [gat2]
                    changed = True
            # "APPARITION : Transformez une invocation en <token>" (Magmog #44) →
            # Transform {tokenId, asOwner:keep} on the detected trigger (targeted).
            # _authored → 1b strips → idempotent.
            tft = parse_transform_target(c)
            tftk = detect_trigger_kind(strip_markup(c.get("description", ""))) if tft else None
            if tft and tftk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == tftk), None)
                if slot is None:
                    slot = {"trigger": tftk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "Transform" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [tft]
                    changed = True
            # "APPARITION : Réduisez une invocation au silence" (Justice #209,
            # Grinch #252) gives a single-target Silence {single:true} on the detected
            # trigger (any side). _authored, so idempotent. The two-part #67
            # ("... son AT passe à 3") is excluded by the end anchor in the parser.
            tsil = parse_target_silence(c)
            tsilk = detect_trigger_kind(strip_markup(c.get("description", ""))) if tsil else None
            if tsil and tsilk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == tsilk), None)
                if slot is None:
                    slot = {"trigger": tsilk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "Silence" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [tsil]
                    changed = True
            # "APPARITION : Réduisez une invocation au silence, son AT passe à N"
            # (Justice #67) gives [Silence {single}, SetAttack {value:N}] on the same
            # picked target. Both are _authored and managed, so idempotent.
            ssa = parse_silence_setattack(c)
            ssak = detect_trigger_kind(strip_markup(c.get("description", ""))) if ssa else None
            if ssa and ssak:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == ssak), None)
                if slot is None:
                    slot = {"trigger": ssak, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "Silence" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + ssa
                    changed = True
            # "MORT adverse : <effet>" (#639 …) → effects on a MORT_ADVERSE trigger
            # slot. The engine fires it once per enemy death for each living
            # opposite-side creature carrying it. We strip the "mort adverse :"
            # prefix first so "adverse" is not read as a rider. This set covers the
            # self-heal body ("se soigne de N PV") → Heal {self}; the other bodies
            # (charge / +PA réserve / count-buff) are deferred. _authored → 1b
            # strips → idempotent.
            if detect_trigger_kind(strip_markup(c.get("description", ""))) == "MORT_ADVERSE":
                ma_body = re.sub(r"^.*?mort\s+adverse\s*:?\s*", "", strip_markup(c.get("description", "")))
                ma_effs = []
                ma_h = re.search(r"se\s+soigne\s+de\s+(\d+)\s*pv", ma_body)
                if ma_h:
                    ma_effs.append({"type": "Heal", "amount": int(ma_h.group(1)), "self": True, "_authored": True})
                # "ajoute N PA à votre réserve" (Empereur Gemene #1271) → player-state
                # AddReserve, deferred by the engine's mortPlayerEffects path.
                ma_r = re.search(r"ajoute\s+(\d+)\s*pa\s+[àa]\s+votre\s+r[ée]serve", ma_body)
                if ma_r:
                    ma_effs.append({"type": "AddReserve", "amount": int(ma_r.group(1)), "side": "caster", "_authored": True})
                # "gagne +N AT [et +M AR] par <groupe> en jeu" (Disciple Cochonnet
                # #616: +1 AT/+1 AR par cochon allié) → self stat boosts whose amount
                # is a live count, resolved by the engine's resolveCounts each time.
                ma_b = re.search(r"gagne\s+\+?(\d+)\s*at(?:\s+et\s+\+?(\d+)\s*ar)?\s+par\s+(.+?)\s+en\s+jeu", ma_body)
                if ma_b:
                    grp = _parse_count_group(ma_b.group(3))
                    if grp is not None:
                        ma_effs.append({"type": "BoostAttack", "self": True, "amount": {"count": dict(grp), "per": int(ma_b.group(1))}, "_authored": True})
                        if ma_b.group(2):
                            ma_effs.append({"type": "BoostArmor", "self": True, "amount": {"count": dict(grp), "per": int(ma_b.group(2))}, "_authored": True})
                # Flat "gagne +N AT [et +M AR]" (Chevalier de Parme #1969: +1 AT on each enemy
                # death), a fixed self stat boost, distinct from the "par <groupe> en jeu"
                # count buff above (the `$` anchor rejects the count form, which has "par …").
                ma_flat = re.search(r"gagne\s+\+?(\d+)\s*at(?:\s+et\s+\+?(\d+)\s*ar)?\s*\.?\s*$", ma_body)
                if ma_flat and not ma_b:
                    ma_effs.append({"type": "BoostAttack", "amount": int(ma_flat.group(1)), "self": True, "_authored": True})
                    if ma_flat.group(2):
                        ma_effs.append({"type": "BoostArmor", "amount": int(ma_flat.group(2)), "self": True, "_authored": True})
                # "inflige N dégâts à la première invocation adverse [de sa ligne] devant lui"
                # (Guerrier Boudeur #1108) → DamageInFront (scan the reactor's row forward, skip
                # allies, hit the first enemy). One of the 4 cards whose MORT_ADVERSE fires even
                # when the reactor itself dies (engine MA_FIRES_ON_OWN_DEATH, rule 8). NB: the
                # merge↔data desync means this only takes effect once the pool is regenerated.
                ma_dif = re.search(r"inflige\s+(\d+)\s*d[ée]g[âa]ts?\s+[àa]\s+la\s+premi[èe]re\s+invocation\s+advers\w+.*devant\s+lui", ma_body)
                if ma_dif:
                    ma_effs.append({"type": "DamageInFront", "amount": int(ma_dif.group(1)), "_authored": True})
                if ma_effs:
                    trigs = c.get("triggers") or []
                    slot = next((t for t in trigs if t.get("trigger") == "MORT_ADVERSE"), None)
                    if slot is None:
                        slot = {"trigger": "MORT_ADVERSE", "effects": []}
                        trigs = trigs + [slot]
                        c["triggers"] = trigs
                    if not (slot.get("effects") or []):
                        slot["effects"] = ma_effs
                        changed = True
            # "APPARITION : récupère le dernier sort / 1 carte aléatoire de votre
            # défausse" (Bakara #418, Phorreur Domestique #255) gives RecoverFromDiscard
            # on the detected trigger. It is not managed, so the check below (no
            # RecoverFromDiscard on the slot yet) keeps it idempotent.
            rdt = parse_recover_discard_trigger(c)
            rdtk = detect_trigger_kind(strip_markup(c.get("description", ""))) if rdt else None
            if rdt and rdtk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == rdtk), None)
                if slot is None:
                    slot = {"trigger": rdtk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "RecoverFromDiscard" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [rdt]
                    changed = True
            # "<trigger> : Place dans votre main le premier <famille> de votre pioche
            # [si votre défausse n'est pas vide]" (Sufod #273) gives TutorFromDeck on the
            # detected trigger, optionally with a condition. Not managed, so the check
            # keeps it idempotent.
            tft2 = parse_tutor_family_trigger(c)
            tft2k = detect_trigger_kind(strip_markup(c.get("description", ""))) if tft2 else None
            if tft2 and tft2k:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == tft2k), None)
                if slot is None:
                    slot = {"trigger": tft2k, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "TutorFromDeck" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [tft2]
                    changed = True
            # "COUP DE GRÂCE : remonte l'invocation adverse dans votre main" (Qilby)
            # → BounceKilledToHand on the COUP_DE_GRACE trigger. Gated to that trigger
            # kind. Not managed → the guard below keeps it idempotent.
            cdgb = parse_coup_de_grace_bounce(c)
            if cdgb and detect_trigger_kind(strip_markup(c.get("description", ""))) == "COUP_DE_GRACE":
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "COUP_DE_GRACE"), None)
                if slot is None:
                    slot = {"trigger": "COUP_DE_GRACE", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "BounceKilledToHand" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [cdgb]
                    changed = True
            # "<TRIGGER> : inflige N dégât au dofus adverse [de sa ligne]" gives DamageDofusOnRow on
            # the detected trigger (Jèms Blond #340 COUP_DE_GRACE, Merkator #412 CONTRE_COUP,
            # Lumino #325 FIN_DE_TOUR with the "autre <famille> en jeu" condition). With a
            # condition and a duplicate check.
            ddr = parse_damage_dofus_on_row(c)
            ddr_tk = detect_trigger_kind(strip_markup(c.get("description", "")))
            if ddr is not None and ddr_tk in ("COUP_DE_GRACE", "CONTRE_COUP", "FIN_DE_TOUR"):
                ddr_eff = {"type": "DamageDofusOnRow", "amount": ddr, "_authored": True}
                # "… si vous avez un autre <famille> en jeu" (Lumino) → requireCondition.
                ddr_fam = re.search(r"si\s+vous\s+avez\s+un\s+autre\s+(\w+)", strip_markup(c.get("description", "")))
                if ddr_fam:
                    ddr_sel = map_tutor_filter(ddr_fam.group(1))
                    if ddr_sel and "family" in ddr_sel:
                        ddr_eff["requireCondition"] = {"kind": "allyFamilyInPlay", "family": ddr_sel["family"], "excludeSelf": True}
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == ddr_tk), None)
                if slot is None:
                    slot = {"trigger": ddr_tk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "DamageDofusOnRow" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [ddr_eff]
                    changed = True
            # "<TRIGGER> : [piochez N,] votre adversaire pioche M cartes" (Maskemane
            # #424 APPARITION, Phorreur #168 MORT, Megathon #159 CONTRE_COUP, Slek
            # #269 APPARITION) → DrawCards list on the detected trigger. DrawCards is
            # managed → 1b strips → idempotent.
            edraws = parse_enemy_draws(c)
            edk = detect_trigger_kind(strip_markup(c.get("description", ""))) if edraws else None
            if edraws and edk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == edk), None)
                if slot is None:
                    slot = {"trigger": edk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "DrawCards" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + edraws
                    changed = True
            # "<effet> quand une invocation alliée meurt" (Gros Nambourg #345 ...) gives
            # effects on a MORT_ALLIEE trigger (there is no text prefix, so detect_trigger_kind
            # cannot see it; parse_ally_death finds the clause inside the text). Managed
            # effects, so idempotent.
            # Grokokolantha #9: "place la 1re créature de Moon (Kokoko) de la pioche quand une
            # de vos créatures de Moon meurt" gives MORT_ALLIEE {family:Kokoko} with
            # TutorFromDeck {family:Kokoko}. Runs before parse_ally_death so it wins.
            grok = parse_grokokolantha(c)
            if grok:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "MORT_ALLIEE"), None)
                if slot is None:
                    slot = {"trigger": "MORT_ALLIEE", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                slot["filter"] = grok["filter"]
                if not (slot.get("effects") or []):
                    slot["effects"] = grok["effects"]
                    changed = True
            adeath = parse_ally_death(c)
            if adeath:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "MORT_ALLIEE"), None)
                if slot is None:
                    slot = {"trigger": "MORT_ALLIEE", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if adeath["filter"]:
                    slot["filter"] = adeath["filter"]
                elif "filter" in slot:
                    del slot["filter"]
                if not (slot.get("effects") or []):
                    slot["effects"] = adeath["effects"]
                    changed = True
            # "gagne +N quand une <X> entre en jeu" (Welsh #278, Gzenah #421 ...) gives
            # self boosts on an ENTERS_PLAY trigger with a side/family filter (fired by
            # summonCreature). Managed effects, so idempotent; the `filter` (not an effect)
            # is set again on every run.
            epr = parse_enters_play_react(c)
            if epr:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "ENTERS_PLAY"), None)
                if slot is None:
                    slot = {"trigger": "ENTERS_PLAY", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                slot["filter"] = epr["filter"]
                if not (slot.get("effects") or []):
                    slot["effects"] = epr["effects"]
                    changed = True
            # "Vos <famille> gagnent +N quand ILS entrent en jeu" (Grany #289, Shin
            # Larve #500) → ENTERS_PLAY {entrant:True} : buff permanent à l'ENTRANT (et
            # non au lord). Managed effects → 1b strips → idempotent ; filter+entrant
            # re-set chaque run.
            epe = parse_enters_play_entrant(c)
            if epe:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "ENTERS_PLAY"), None)
                if slot is None:
                    slot = {"trigger": "ENTERS_PLAY", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                slot["filter"] = epe["filter"]
                slot["entrant"] = True
                if not (slot.get("effects") or []):
                    slot["effects"] = epe["effects"]
                    changed = True
            # Julith Jurgen #432 "inflige N dégât(s) aux invocations adverses qui entrent en
            # jeu" gives ENTERS_PLAY {entrant:True, filter:{side:"enemy"}, effects:[DamageData{N}]}:
            # the creature entering takes N (`entrant` path). DamageData is not a managed type,
            # so it survives the strip; it is only injected when the slot is empty, which keeps
            # it idempotent. The bindata DamageData in effects[] is removed in the second loop
            # (otherwise it would stay there with no trigger).
            epd = parse_enters_play_damage(c)
            if epd:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "ENTERS_PLAY"), None)
                if slot is None:
                    slot = {"trigger": "ENTERS_PLAY", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                slot["filter"] = epd["filter"]
                slot["entrant"] = True
                if not (slot.get("effects") or []):
                    slot["effects"] = epd["effects"]
                    changed = True
            # Kriss La Krass (#341/#967/#611): the APPARITION adds 1 Boufballe to the enemy hand,
            # plus a passive "Boufballes are free while Kriss is in play". Managed
            # (AddCardToHand + CardCostAura), so idempotent.
            kb = parse_kriss_boufballe(c)
            if kb:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if slot is None:
                    slot = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [kb["apparition"]]
                    changed = True
                if not any(e.get("type") == "CardCostAura" for e in (c.get("effects") or [])):
                    c["effects"] = (c.get("effects") or []) + [kb["aura"]]
                    changed = True
            # "<charge/gagne +N> quand un <X> subit des dégâts" (Chacha Teigne #732,
            # Requin Lancier #33, Jet #158) gives self effects on an ON_DAMAGE trigger with a
            # filter on the damaged entity (fired by fireDamageReactions). Managed effects, so
            # idempotent; the filter is set again on each run.
            dmr = parse_damage_reaction(c)
            if dmr:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "ON_DAMAGE"), None)
                if slot is None:
                    slot = {"trigger": "ON_DAMAGE", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                slot["filter"] = dmr["filter"]
                if not (slot.get("effects") or []):
                    slot["effects"] = dmr["effects"]
                    changed = True
            # "gagne +N quand vous piochez une carte" (Phorreur Furieux #951) → self
            # boosts on an ON_DRAW trigger (fired by drawCard for the owner). No filter.
            dwr = parse_draw_reaction(c)
            if dwr:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "ON_DRAW"), None)
                if slot is None:
                    slot = {"trigger": "ON_DRAW", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = dwr["effects"]
                    changed = True
            # "Tous vos <sorts|invocations|cartes> coûtent N PA de moins jusqu'à
            # défausse" (Wagnar #737, Vampyro #779/#697) gives StampCostReduction on the
            # detected slot (HORDE APPARITION). Managed, so stripped and injected again.
            scr = parse_stamp_cost_reduction(c)
            scrk = detect_trigger_kind(c.get("description", "")) if scr else None
            if scr and scrk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == scrk), None)
                if slot is None:
                    slot = {"trigger": scrk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "StampCostReduction" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [scr]
                    changed = True
            # "<TRIGGER> : meurt" (Goule Ash #823 CONTRE COUP) → SetLife {value:0,
            # self} on the detected slot, the creature drops to 0 PV and dies.
            sdr = parse_self_death(c)
            sdrk = detect_trigger_kind(c.get("description", "")) if sdr else None
            if sdr and sdrk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == sdrk), None)
                if slot is None:
                    slot = {"trigger": sdrk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "SetLife" and e.get("self") for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [sdr]
                    changed = True
            # "Place les <famille> de votre main sous votre pioche. Piochez autant"
            # (Goule Taka #871) → RecycleFamily on the detected slot (HORDE APPARITION).
            rfr = parse_recycle_family(c)
            rfrk = detect_trigger_kind(c.get("description", "")) if rfr else None
            if rfr and rfrk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == rfrk), None)
                if slot is None:
                    slot = {"trigger": rfrk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "RecycleFamily" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [rfr]
                    changed = True
            # "Fin du tour : piochez une carte ou pas d'effet" (Arty Romi #731) →
            # a CoinFlip on the FIN_DE_TOUR slot (pile draws, face does nothing).
            cfe = parse_coinflip_endturn_draw(c)
            cfek = detect_trigger_kind(c.get("description", "")) if cfe else None
            if cfe and cfek:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == cfek), None)
                if slot is None:
                    slot = {"trigger": cfek, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "CoinFlip" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [cfe]
                    changed = True
            # "<TRIGGER> : piochez N carte(s)" simple self-draw (Phorreur d'Elite #583
            # DÉBUT DE TOUR, Rabet #484 CONTRE COUP) + "chaque joueur pioche N" (Larve
            # Bleue #213 APPARITION) → DrawCards on the detected slot.
            epd = parse_each_player_draw(c)
            tdr = parse_trigger_draw(c)
            draw_effs = epd if epd else ([tdr] if tdr else None)
            drawk = detect_trigger_kind(c.get("description", "")) if draw_effs else None
            if draw_effs and drawk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == drawk), None)
                if slot is None:
                    slot = {"trigger": drawk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):  # only fill an empty slot (never pollute CoinFlip/bindata)
                    slot["effects"] = draw_effs
                    changed = True
            # "<TRIGGER> : change de ligne" (Bwork Chevaucheur #502 COUP DE GRÂCE) →
            # ChangeRowSelf on the detected slot (only if empty).
            crs = parse_trigger_change_row(c)
            crsk = detect_trigger_kind(c.get("description", "")) if crs else None
            if crs and crsk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == crsk), None)
                if slot is None:
                    slot = {"trigger": crsk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [crs]
                    changed = True
            # "<TRIGGER> : ajoute un tas d'os à votre main" (Chafer Lancier #197) gives
            # AddCardToHand {cardId:691} on the detected slot (when the slot is empty).
            ath = parse_add_tasdos_to_hand(c)
            athk = detect_trigger_kind(c.get("description", "")) if ath else None
            if ath and athk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == athk), None)
                if slot is None:
                    slot = {"trigger": athk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [ath]
                    changed = True
            # "<TRIGGER> : transforme un/tous les tas d'os allié(s) en chafer décrépit"
            # (Chafer Fantassin #738, Roi Chafer #147) gives TransformTasDOs on the slot.
            ttd = parse_transform_tasdos(c)
            ttdk = detect_trigger_kind(c.get("description", "")) if ttd else None
            if ttd and ttdk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == ttdk), None)
                if slot is None:
                    slot = {"trigger": ttdk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [ttd]
                    changed = True
            # "<TRIGGER> : détruisez un tas d'os allié pour gagner/donner <stats>"
            # (Chafer d'Elite #223 on itself, Chafer Hallebardier #626 on chafers), on the slot.
            ctb = parse_consume_tasdos_buff(c)
            ctbk = detect_trigger_kind(c.get("description", "")) if ctb else None
            if ctb and ctbk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == ctbk), None)
                if slot is None:
                    slot = {"trigger": ctbk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [ctb]
                    changed = True
            # "se téléporte de N cases quand un <famille> allié meurt" (Chaferfu #401)
            # gives a MORT_ALLIEE trigger {filter:{family}} with Teleport {cells:N}.
            tfd = parse_teleport_on_family_death(c)
            if tfd:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "MORT_ALLIEE"), None)
                if slot is None:
                    slot = {"trigger": "MORT_ALLIEE", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["filter"] = tfd["filter"]
                    slot["effects"] = tfd["effects"]
                    changed = True
            # "Piochez N. Gardez les <famille> / si pas un <famille> défaussée"
            # (Tofoune #106, Tofu Céleste #415) gives DrawFiltered {keepFamily} on the slot.
            fdf = parse_filtered_draw_family(c)
            fdfk = detect_trigger_kind(c.get("description", "")) if fdf else None
            if fdf and fdfk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == fdfk), None)
                if slot is None:
                    slot = {"trigger": fdfk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [fdf]
                    changed = True
            # "Remplace vos <X> par des <Y>" (Chacha Or #224) gives TransformAll {fromCardId}
            # on the Summon's APPARITION (there is no trigger keyword in the text).
            rwt = parse_replace_with_token(c)
            if rwt and c.get("cardType") == "Summon":
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if slot is None:
                    slot = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [rwt]
                    changed = True
            # "<TRIGGER> : piochez N carte(s) chez votre adversaire" (Bébé Phorreur
            # Corrompu #1289) gives StealTopDraw {noRedraw} on the detected slot.
            tsd = parse_trigger_steal_draw(c)
            tsdk = detect_trigger_kind(c.get("description", "")) if tsd else None
            if tsd and tsdk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == tsdk), None)
                if slot is None:
                    slot = {"trigger": tsdk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [tsd]
                    changed = True
            # "Ramassez/récupère un/tous les prisme(s)" (Lou, Malocac, Comte Harebourg)
            # gives RamasserPrisme on the detected slot (APPARITION).
            rmp = parse_ramasser_prisme(c)
            rmpk = detect_trigger_kind(c.get("description", "")) if rmp else None
            if rmp and rmpk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == rmpk), None)
                if slot is None:
                    slot = {"trigger": rmpk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [rmp]
                    changed = True
            # Prism respawn (Lou #65 all, #572 one allied, Bouftou Male #36 row) gives
            # RespawnPrisms {scope} on the detected slot.
            rsp = parse_respawn_prisms(c)
            rspk = detect_trigger_kind(c.get("description", "")) if rsp else None
            if rsp and rspk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == rspk), None)
                if slot is None:
                    slot = {"trigger": rspk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [rsp]
                    changed = True
            # "Sacrifiez un de vos prismes pour donner +N à vos autres invocations"
            # (Kibri #735) gives SacrificePrismBuff on the detected slot.
            spb = parse_sacrifice_prism_buff(c)
            spbk = detect_trigger_kind(c.get("description", "")) if spb else None
            if spb and spbk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == spbk), None)
                if slot is None:
                    slot = {"trigger": spbk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [spb]
                    changed = True
            # Destroying the prism of the row and revealing (Kerubim le Brocanteur #378), or
            # revealing on a trigger (Salbatroce #480 row, Kerubim l'Aventurier #333 one enemy),
            # gives [DestroyPrismOnRow?, RevealDofuses?] on the detected slot.
            pr_effs = [x for x in (parse_destroy_prism_row(c), parse_reveal_dofuses(c)) if x]
            pr_k = detect_trigger_kind(c.get("description", "")) if pr_effs else None
            if pr_effs and pr_k:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == pr_k), None)
                if slot is None:
                    slot = {"trigger": pr_k, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = pr_effs
                    changed = True
            # "récupère un <famille> aléatoire / les <famille> de votre défausse" on a Summon
            # trigger (Bébé Phorreur d'Argent #1336 MORT, Roi Gelax #113 FIN DU TOUR) gives
            # RecoverFromDiscard on the detected slot. (The spell version, Armée des Ombres
            # #539, goes through the Spell chain.)
            rfdt = parse_recover_family_discard(c)
            rfdtk = detect_trigger_kind(c.get("description", "")) if rfdt else None
            if rfdt and rfdtk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == rfdtk), None)
                if slot is None:
                    slot = {"trigger": rfdtk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [rfdt]
                    changed = True
            # "Invoque N <token> à côté ou derrière lui" (Abraknyde #516/#455) gives
            # SummonToken {placement:near} on the detected slot (MORT).
            smn = parse_summon_near(c)
            smnk = detect_trigger_kind(c.get("description", "")) if smn else None
            if smn and smnk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == smnk), None)
                if slot is None:
                    slot = {"trigger": smnk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [smn]
                    changed = True
            # "Défausse N carte(s) aléatoire(s) de votre main" (Phorzerker #357) gives
            # DiscardRandomHand on the detected slot (APPARITION).
            drh = parse_discard_random_hand(c)
            drhk = detect_trigger_kind(c.get("description", "")) if drh else None
            if drh and drhk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == drhk), None)
                if slot is None:
                    slot = {"trigger": drhk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [drh]
                    changed = True
            # "Ramassez N butin(s)" (Snouffle #225) gives GrabButin on the detected slot.
            gbt = parse_grab_butin(c)
            gbtk = detect_trigger_kind(c.get("description", "")) if gbt else None
            if gbt and gbtk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == gbtk), None)
                if slot is None:
                    slot = {"trigger": gbtk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [gbt]
                    changed = True
            # "Piochez N si vous avez moins de M cartes en main" (Kamasutar #92) gives
            # DrawCards {condition:handBelow} on the detected slot.
            cdh = parse_conditional_draw_handsize(c)
            cdhk = detect_trigger_kind(c.get("description", "")) if cdh else None
            if cdh and cdhk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == cdhk), None)
                if slot is None:
                    slot = {"trigger": cdhk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [cdh]
                    changed = True
            # "Remontez une de vos invocations dans votre main" (Arakne Albinos #260) gives
            # ReturnToHand {pickSide:ally} on the detected slot.
            rth = parse_return_own_to_hand(c)
            rthk = detect_trigger_kind(c.get("description", "")) if rth else None
            if rth and rthk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == rthk), None)
                if slot is None:
                    slot = {"trigger": rthk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [rth]
                    changed = True
            # "Placez un <token> dans votre camp" (Gwand Pa Wabbit #143) gives SummonToken
            # {placement:campChoose} on the detected slot.
            ptc = parse_place_token_camp(c)
            ptck = detect_trigger_kind(c.get("description", "")) if ptc else None
            if ptc and ptck:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == ptck), None)
                if slot is None:
                    slot = {"trigger": ptck, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [ptc]
                    changed = True
            # "<reactive trigger> : charge de N cases" (Coppa le Copain #1048 MORT
            # ADVERSE) gives ChargeSelf {cells} on the detected slot (not APPARITION).
            rcg = parse_reactive_charge(c)
            rcgk = detect_trigger_kind(c.get("description", "")) if rcg else None
            if rcg and rcgk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == rcgk), None)
                if slot is None:
                    slot = {"trigger": rcgk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [rcg]
                    changed = True
            # "Vole N PA de la réserve adverse" (Noxine #392) → StealReserve {amount}.
            srv = parse_steal_reserve_amount(c)
            srvk = detect_trigger_kind(c.get("description", "")) if srv else None
            if srv and srvk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == srvk), None)
                if slot is None:
                    slot = {"trigger": srvk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [srv]
                    changed = True
            # "Gagne autant d'AT/AR/PM que d'autres <famille> alliés" (Scarabruni #297)
            # gives a self Boost{stat} {count, excludeSelf} on the detected slot.
            sco = parse_self_count_others(c)
            scok = detect_trigger_kind(c.get("description", "")) if sco else None
            if sco and scok:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == scok), None)
                if slot is None:
                    slot = {"trigger": scok, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [sco]
                    changed = True
            # "Gagne autant d'AT/AR/PM que vous avez de cartes en main" (Mitaine #551)
            # gives a self Boost{stat} {amount:HandSizeValue} on the detected slot.
            sch = parse_self_count_hand(c)
            schk = detect_trigger_kind(c.get("description", "")) if sch else None
            if sch and schk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == schk), None)
                if slot is None:
                    slot = {"trigger": schk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [sch]
                    changed = True
            # "Change ses PM pour qu'ils soient égaux au nombre de <famille> alliés"
            # (Maine Cooyne #1579) gives SetMovement {self, value:count} on the detected slot.
            smc = parse_set_movement_count(c)
            smck = detect_trigger_kind(c.get("description", "")) if smc else None
            if smc and smck:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == smck), None)
                if slot is None:
                    slot = {"trigger": smck, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [smc]
                    changed = True
            # "Transformez un de vos <famille> en <token>" (Wa Wabbit #59, #770) gives a
            # targeted Transform {pickFamily} on the detected slot.
            tfp = parse_transform_family_pick(c)
            tfpk = detect_trigger_kind(c.get("description", "")) if tfp else None
            if tfp and tfpk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == tfpk), None)
                if slot is None:
                    slot = {"trigger": tfpk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [tfp]
                    changed = True
            # "Ajoute N PA à votre réserve si vous avez un autre <famille>" (Scoreur
            # #554) gives AddReserve {requireCondition:allyFamilyInPlay} on the detected slot.
            rif = parse_reserve_if_family(c)
            rifk = detect_trigger_kind(c.get("description", "")) if rif else None
            if rif and rifk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == rifk), None)
                if slot is None:
                    slot = {"trigger": rifk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [rif]
                    changed = True
            # "Réduit au silence les autres invocations" (Phaeris #597) gives Silence
            # {excludeSelf} on the detected slot.
            sil = parse_silence_others(c)
            silk = detect_trigger_kind(c.get("description", "")) if sil else None
            if sil and silk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == silk), None)
                if slot is None:
                    slot = {"trigger": silk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [sil]
                    changed = True
            # "Réduisez de N l'AT d'une invocation ayant au moins M AT" (Pissenlion
            # #1045) gives a targeted BoostAttack {amount:-N, minAttack:M} on the detected slot.
            rap = parse_reduce_attack_pick(c)
            rapk = detect_trigger_kind(c.get("description", "")) if rap else None
            if rap and rapk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == rapk), None)
                if slot is None:
                    slot = {"trigger": rapk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [rap]
                    changed = True
            # "Bannit les N dernières cartes de la défausse de chaque joueur" (Phorreur
            # Ancestral #1498) gives BanishOwnDiscard {eachPlayer} on the detected slot.
            bed = parse_banish_each_discard(c)
            bedk = detect_trigger_kind(c.get("description", "")) if bed else None
            if bed and bedk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == bedk), None)
                if slot is None:
                    slot = {"trigger": bedk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [bed]
                    changed = True
            # "<effet> quand vous jouez un sort/une invocation/une carte" (Crapaud
            # Mufle #238, Angèle #1257, Piou aux Oeufs d'Or #446) gives effects on an
            # ON_PLAY trigger with a cardType filter (fired by playCard). Managed
            # effects, so idempotent; the filter is set again on each run.
            opr = parse_on_play_react(c)
            if opr:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "ON_PLAY"), None)
                if slot is None:
                    slot = {"trigger": "ON_PLAY", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                slot["filter"] = opr["filter"]
                if not (slot.get("effects") or []):
                    slot["effects"] = opr["effects"]
                    changed = True
            # "Piochez une carte krosmique quand votre adversaire joue une carte
            # krosmique" (Sigrun #917) → ON_PLAY {filter:{side:enemy, rarity:Krosmic}}
            # + TutorFromDeck {rarity:Krosmic}. Managed effects → 1b strips → idempotent.
            kdr = parse_krosmic_draw(c)
            if kdr:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "ON_PLAY"), None)
                if slot is None:
                    slot = {"trigger": "ON_PLAY", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                slot["filter"] = kdr["filter"]
                if not (slot.get("effects") or []):
                    slot["effects"] = kdr["effects"]
                    changed = True
            # Sipho #603 / Sipho Transformé #751: "FRATRIE : quand un membre de la fratrie
            # des Oubliés (the Fratrie family) est joué, il se transforme / retrouve sa forme"
            # gives ON_PLAY {filter:{family:Fratrie}} with a Transform (toggle).
            frt = parse_fratrie_transform(c)
            if frt:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "ON_PLAY"), None)
                if slot is None:
                    slot = {"trigger": "ON_PLAY", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                slot["filter"] = frt["filter"]
                if not (slot.get("effects") or []):
                    slot["effects"] = frt["effects"]
                    changed = True
            # "Charge de N cases quand vous jouez … / quand l'adversaire joue …"
            # (Lilotte #444/#569) → a reactive ChargeSelf on an ON_PLAY slot whose
            # filter encodes whose play / which card type. Not managed → the guard
            # keeps it idempotent.
            cop = parse_charge_on_play(c)
            if cop:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "ON_PLAY"), None)
                if slot is None:
                    slot = {"trigger": "ON_PLAY", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if cop["filter"]:
                    slot["filter"] = cop["filter"]
                if not any(e.get("type") == "ChargeSelf" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [cop["effect"]]
                    changed = True
            # Lilotte #579: "Charge de N cases quand un prisme est ramassé ou détruit" gives a
            # reactive ChargeSelf on an ON_PRISM slot (fired by fireOnPrismReactions).
            # Not managed, so the ChargeSelf check keeps it idempotent.
            cpr = parse_charge_on_prism(c)
            if cpr:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "ON_PRISM"), None)
                if slot is None:
                    slot = {"trigger": "ON_PRISM", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "ChargeSelf" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [cpr]
                    changed = True
            # Garde du corps (Silas #320, Bould Erdash #300): the bare "garde du corps"
            # keyword → an APPARITION that picks an ally creature to protect (GuardCreature).
            # The guard keeps it idempotent (not managed, it lives on a trigger slot).
            gcr = parse_guard_creature(c)
            if gcr:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if slot is None:
                    slot = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "GuardCreature" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [gcr]
                    changed = True
            # "APPARITION : invoque un <token> sur chaque case de sa rangée"
            # (Héroïne Séculaire #1245, Corbeau Noir #205) gives SummonToken {placement:"column"}
            # on the detected trigger ("rangée" is the vertical column). Managed, so idempotent.
            srow = parse_summon_column(c) or parse_summon_named_token(c)
            srowk = detect_trigger_kind(strip_markup(c.get("description", ""))) if srow else None
            if srow and srowk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == srowk), None)
                if slot is None:
                    slot = {"trigger": srowk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "SummonToken" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [srow]
                    changed = True
            # "Invoque ... s'il survit à des dégâts" (Boo #513, Empereur Gelax #422) gives
            # SummonToken on CONTRE_COUP (forced, since "survit à des dégâts" is not a detected
            # keyword). SummonToken is managed, so idempotent.
            sos = parse_summon_on_survive(c)
            if sos:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "CONTRE_COUP"), None)
                if slot is None:
                    slot = {"trigger": "CONTRE_COUP", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "SummonToken" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [sos]
                    changed = True
            # "Ajoute un <nom> à votre main s'il survit à des dégâts" (Tsu Tsu Mikaze
            # #1509) gives AddCardToHand on the forced CONTRE_COUP slot.
            aths = parse_add_to_hand_on_survive(c)
            if aths:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "CONTRE_COUP"), None)
                if slot is None:
                    slot = {"trigger": "CONTRE_COUP", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "AddCardToHand" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [aths]
                    changed = True
            # "Ajoute N <nom> dans la main adverse" (Jiji #465) gives AddCardToHand
            # {side:"enemy"} on the detected slot.
            ateh = parse_add_to_enemy_hand(c)
            atehk = detect_trigger_kind(c.get("description", "")) if ateh else None
            if ateh and atehk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == atehk), None)
                if slot is None:
                    slot = {"trigger": atehk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [ateh]
                    changed = True
            # "Remplit de <token> la main des deux joueurs" (Kabrok #473) gives 2
            # AddCardToHand {fill} (caster and enemy) on the detected slot.
            fih = parse_fill_hand(c)
            fihk = detect_trigger_kind(c.get("description", "")) if fih else None
            if fih and fihk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == fihk), None)
                if slot is None:
                    slot = {"trigger": fihk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = fih
                    changed = True
            # "Dépense N PA" with nothing in return (Cactana #587 DÉBUT DU TOUR) gives DrainAp
            # on the detected slot.
            dap = parse_drain_ap(c)
            dapk = detect_trigger_kind(c.get("description", "")) if dap else None
            if dap and dapk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == dapk), None)
                if slot is None:
                    slot = {"trigger": dapk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [dap]
                    changed = True
            # "Invoque N <token> autour de lui. Vos <famille> chargent" (Khan Karkass
            # #510) gives [SummonToken {frontAndSides}, ChargeAllies] on the detected slot.
            sac = parse_summon_and_charge(c)
            sack = detect_trigger_kind(c.get("description", "")) if sac else None
            if sac and sack:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == sack), None)
                if slot is None:
                    slot = {"trigger": sack, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [sac]
                    changed = True
            # "Invoque un <token> à N cases devant lui" (Pissenlit Diabolique #1595)
            # gives SummonToken {placement:"front", frontDistance} on the detected slot.
            sfr = parse_summon_front(c)
            sfrk = detect_trigger_kind(c.get("description", "")) if sfr else None
            if sfr and sfrk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == sfrk), None)
                if slot is None:
                    slot = {"trigger": sfrk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "SummonToken" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [sfr]
                    changed = True
            # "CONTRE COUP : réduit au silence l'invocation qui lui inflige des dégâts"
            # (Belgodass #756) gives Silence {single, targetAttacker} on the CONTRE_COUP slot.
            csa = parse_contrecoup_silence_attacker(c)
            csak = detect_trigger_kind(c.get("description", "")) if csa else None
            if csa and csak:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == csak), None)
                if slot is None:
                    slot = {"trigger": csak, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [csa]
                    changed = True
            # "L'invocation qui le tue se transforme en <token>" (Bouftou Citrouille
            # #780) gives Transform {targetKiller} on the forced MORT slot (no keyword).
            mtk = parse_mort_transform_killer(c)
            if mtk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "MORT"), None)
                if slot is None:
                    slot = {"trigger": "MORT", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == mtk["type"] for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [mtk]
                    changed = True
            # "Votre adversaire récupère la dernière carte de sa défausse" (Phorrerstein
            # #1414) gives RecoverFromDiscard {forSide:enemy, costDelta} on the detected slot.
            enr = parse_enemy_recover(c)
            enrk = detect_trigger_kind(c.get("description", "")) if enr else None
            if enr and enrk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == enrk), None)
                if slot is None:
                    slot = {"trigger": enrk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [enr]
                    changed = True
            # "Donne à vos autres <fam1> +N AT/AR par <fam2> allié" (Wo Wabbit #290) gives
            # [BoostAttack, BoostArmor] {scope, count} on the detected slot.
            bof = parse_buff_others_per_family(c)
            bofk = detect_trigger_kind(c.get("description", "")) if bof else None
            if bof and bofk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == bofk), None)
                if slot is None:
                    slot = {"trigger": bofk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = bof
                    changed = True
            # "Récupère une carte Infinite aléatoire de votre défausse" (Indie #454) gives
            # RecoverFromDiscard {rarity:Infinite} on the detected slot (MORT).
            rinf = parse_recover_infinite(c)
            rinfk = detect_trigger_kind(c.get("description", "")) if rinf else None
            if rinf and rinfk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == rinfk), None)
                if slot is None:
                    slot = {"trigger": rinfk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [rinf]
                    changed = True
            # "Place dans votre main la dernière carte Infinite de votre pioche" (Indie
            # #509) gives TutorFromDeck {rarity:Infinite} on the detected slot (MORT).
            tinf = parse_tutor_infinite(c)
            tinfk = detect_trigger_kind(c.get("description", "")) if tinf else None
            if tinf and tinfk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == tinfk), None)
                if slot is None:
                    slot = {"trigger": tinfk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [tinf]
                    changed = True
            # "Place dans votre main la prochaine carte <dieu> de votre pioche [coûtant N]"
            # (Many de Brakmar #227) gives TutorFromDeck {god, cost} on the detected slot.
            tgod = parse_tutor_by_god(c)
            tgodk = detect_trigger_kind(c.get("description", "")) if tgod else None
            if tgod and tgodk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == tgodk), None)
                if slot is None:
                    slot = {"trigger": tgodk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [tgod]
                    changed = True
            # "Ajoute N autres <famille> à votre main" (Maloboss #470) gives
            # AddRandomFamilyCards {family, excludeName} on the detected slot.
            arf = parse_add_random_family(c)
            arfk = detect_trigger_kind(c.get("description", "")) if arf else None
            if arf and arfk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == arfk), None)
                if slot is None:
                    slot = {"trigger": arfk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [arf]
                    changed = True
            # "Attire une invocation de N cases" (Chacha Tyran #943) gives a targeted
            # AttractCreature on the detected slot.
            atc = parse_attract_creature(c)
            atck = detect_trigger_kind(c.get("description", "")) if atc else None
            if atc and atck:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == atck), None)
                if slot is None:
                    slot = {"trigger": atck, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [atc]
                    changed = True
            # "Déplacez une invocation ... sur une ligne adjacente aléatoirement" (Larve
            # Verte #139) gives a targeted MoveAdjacentRowRandom on the detected slot.
            marr = parse_move_adjacent_row(c)
            marrk = detect_trigger_kind(c.get("description", "")) if marr else None
            if marr and marrk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == marrk), None)
                if slot is None:
                    slot = {"trigger": marrk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [marr]
                    changed = True
            # "Devient de la famille de l'invocation ciblée" (Pupuce #441) gives a targeted
            # CopyFamilyFromTarget on the detected slot.
            cpf = parse_copy_family(c)
            cpfk = detect_trigger_kind(c.get("description", "")) if cpf else None
            if cpf and cpfk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == cpfk), None)
                if slot is None:
                    slot = {"trigger": cpfk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [cpf]
                    changed = True
            # "Place dans votre main une copie de la cible si elle se trouve dans votre
            # pioche" (Wabbit en Chocolat #733) gives TutorCopyOfTarget on the detected slot.
            tct = parse_tutor_copy_target(c)
            tctk = detect_trigger_kind(c.get("description", "")) if tct else None
            if tct and tctk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == tctk), None)
                if slot is None:
                    slot = {"trigger": tctk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [tct]
                    changed = True
            # "Remonte ... la première invocation de sa ligne si vous êtes en sous nombre"
            # (Championne du Blasphème #1451) gives BounceClosestOnRow on the detected slot.
            bcr = parse_bounce_closest_row(c)
            bcrk = detect_trigger_kind(c.get("description", "")) if bcr else None
            if bcr and bcrk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == bcrk), None)
                if slot is None:
                    slot = {"trigger": bcrk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [bcr]
                    changed = True
            # "Passez à N l'AT d'une invocation, elle charge de M cases" (Justice #130)
            # gives a targeted [SetAttack, Charge] on the detected slot.
            sac = parse_setattack_charge(c)
            sack = detect_trigger_kind(c.get("description", "")) if sac else None
            if sac and sack:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == sack), None)
                if slot is None:
                    slot = {"trigger": sack, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = sac
                    changed = True
            # "Détruisez une graine, une bombe, un butin, un glyphe ou un tas d'os en jeu"
            # (Tournesol Sauvage #1082) gives a targeted DestroyBoardObject on the detected slot.
            dbo = parse_destroy_board_object(c)
            dbok = detect_trigger_kind(c.get("description", "")) if dbo else None
            if dbo and dbok:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == dbok), None)
                if slot is None:
                    slot = {"trigger": dbok, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [dbo]
                    changed = True
            # "Transforme les graines, butins, glyphes et tas d'os en bombes alliées"
            # (Kaotika #612) gives TransformObjectsToTraps on the detected slot.
            otb = parse_objects_to_bombs(c)
            otbk = detect_trigger_kind(c.get("description", "")) if otb else None
            if otb and otbk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == otbk), None)
                if slot is None:
                    slot = {"trigger": otbk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [otb]
                    changed = True
            # "Échangez la position du dofus <allié|adverse> de sa ligne avec celle d'un
            # autre dofus" (Ush #426/#13) gives SwapDofus {side} on the detected slot.
            swd = parse_swap_dofus(c)
            swdk = detect_trigger_kind(c.get("description", "")) if swd else None
            if swd and swdk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == swdk), None)
                if slot is None:
                    slot = {"trigger": swdk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [swd]
                    changed = True
            # "Déplacez le dofus allié de sa ligne sur la position d'un dofus allié
            # détruit" (Ush #100) gives MoveRowDofus on the detected slot.
            mrd = parse_move_row_dofus(c)
            mrdk = detect_trigger_kind(c.get("description", "")) if mrd else None
            if mrd and mrdk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == mrdk), None)
                if slot is None:
                    slot = {"trigger": mrdk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [mrd]
                    changed = True
            # "Échange aléatoirement les positions des dofus pour chaque joueur" (Guy
            # #274) gives ShuffleDofus on the detected slot (MORT).
            shd = parse_shuffle_dofus(c)
            shdk = detect_trigger_kind(c.get("description", "")) if shd else None
            if shd and shdk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == shdk), None)
                if slot is None:
                    slot = {"trigger": shdk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [shd]
                    changed = True
            # "Dépense N PA de réserve pour donner +X à vos autres <dieu>" (Synchroniseur
            # #714) gives [AddReserve -N, BoostAttack/Armor scoped by god] on the detected slot.
            srb = parse_spend_reserve_buff(c)
            srbk = detect_trigger_kind(c.get("description", "")) if srb else None
            if srb and srbk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == srbk), None)
                if slot is None:
                    slot = {"trigger": srbk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = srb
                    changed = True
            # "Prenez le contrôle des invocations adverses autour d'elle tant qu'elle est
            # en jeu" (Miranda #107) gives ControlAround on the detected slot.
            cta = parse_control_around(c)
            ctak = detect_trigger_kind(c.get("description", "")) if cta else None
            if cta and ctak:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == ctak), None)
                if slot is None:
                    slot = {"trigger": ctak, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [cta]
                    changed = True
            # "COUP DE GRÂCE : 50% de chances de changer de propriétaire" (Truche #434)
            # gives CoinFlip {GiveSelfToOpponent} on the detected slot (COUP_DE_GRACE).
            cdg = parse_coupdegrace_defect(c)
            cdgk = detect_trigger_kind(c.get("description", "")) if cdg else None
            if cdg and cdgk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == cdgk), None)
                if slot is None:
                    slot = {"trigger": cdgk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = [cdg]
                    changed = True
            # "APPARITION : Soigne vos autres <invocations|famille> de N PV"
            # (Boufette #32 ...) gives Heal {scope:allies, family?, excludeSelf} on the
            # APPARITION slot. _authored, so idempotent. Only on APPARITION (the simple
            # trigger; "à la fin des déplacements" #71 is handled elsewhere).
            hoa = parse_heal_other_allies(c)
            if hoa and detect_trigger_kind(strip_markup(c.get("description", ""))) == "APPARITION":
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if slot is None:
                    slot = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "Heal" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [hoa]
                    changed = True
            # "MORT : Remonte dans votre main si vous avez au moins N cartes dans
            # votre défausse" (Baron Sramedi #243) gives RecoverSelfToHand on the MORT
            # slot (read by resolveDeathsAndWin). _authored, so idempotent.
            rsh = parse_recover_self_to_hand(c.get("description", ""))
            if rsh and detect_trigger_kind(strip_markup(c.get("description", ""))) == "MORT":
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "MORT"), None)
                if slot is None:
                    slot = {"trigger": "MORT", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "RecoverSelfToHand" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [rsh]
                    changed = True
            # "MORT : dépense N PA de réserve pour remonter dans votre main" (Missiz Frizz
            # #474) gives [RecoverSelfToHand {reserveAtLeast}, AddReserve -N] on the MORT slot.
            # Checked per type: RecoverSelfToHand is not managed (it stays) but AddReserve is
            # (stripped, then injected again), so the result is idempotent.
            mrr = parse_mort_recover_reserve(c)
            if mrr and detect_trigger_kind(strip_markup(c.get("description", ""))) == "MORT":
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "MORT"), None)
                if slot is None:
                    slot = {"trigger": "MORT", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                for eff in mrr:
                    if not any(e.get("type") == eff["type"] for e in (slot.get("effects") or [])):
                        slot["effects"] = (slot.get("effects") or []) + [eff]
                        changed = True
            # "FIN DU TOUR : Inflige @damage@ aux invocations adverses puis à
            # lui-même" (Disciple de l'Agonie #1163) gives [AoeDamage enemies,
            # SelfDamageData] on the detected trigger slot. _authored, so idempotent.
            ats = parse_aoe_enemies_then_self(c)
            atsk = detect_trigger_kind(c.get("description", "")) if ats else None
            if ats and atsk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == atsk), None)
                if slot is None:
                    slot = {"trigger": atsk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "AoeDamage" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + ats
                    changed = True
            # "MORT : Détruit un fléau dans la main adverse" (Horlogère Gousset
            # #1687) gives DestroyCardInOpponentHand {cardId:757} on the detected
            # trigger slot. _authored, so idempotent.
            dfo = parse_destroy_fleau_opponent_hand(c.get("description", ""))
            dfok = detect_trigger_kind(c.get("description", "")) if dfo else None
            if dfo and dfok:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == dfok), None)
                if slot is None:
                    slot = {"trigger": dfok, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "DestroyCardInOpponentHand" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [dfo]
                    changed = True
            # "APPARITION : Inflige N dégâts aux invocations adverses dans votre
            # camp" (Apôtre Nécrosé #688) gives AoeDamage {scope:enemies, zone:ownCamp}
            # on the detected trigger slot. _authored, so idempotent.
            aoc = parse_aoe_enemies_own_camp(c.get("description", ""))
            aock = detect_trigger_kind(c.get("description", "")) if aoc else None
            if aoc and aock:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == aock), None)
                if slot is None:
                    slot = {"trigger": aock, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "AoeDamage" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [aoc]
                    changed = True
            # "APPARITION : Inflige N dégâts aux invocations adverses ayant au moins
            # N AT" (Gardienne Inflexible #1531) gives AoeDamage {scope:enemies,
            # minAttack} on the detected trigger slot. _authored, so idempotent.
            ama = parse_aoe_enemies_min_attack(c)
            amak = detect_trigger_kind(c.get("description", "")) if ama else None
            if ama and amak:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == amak), None)
                if slot is None:
                    slot = {"trigger": amak, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "AoeDamage" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [ama]
                    changed = True
            # "DÉBUT DU TOUR : S'inflige 1 OU 2 dégâts" (Griffeur Tonkino #628) gives a
            # CoinFlip of two SelfDamageData branches on the detected trigger slot.
            # _authored, so idempotent.
            sdc = parse_self_damage_coinflip(c.get("description", ""))
            sdck = detect_trigger_kind(c.get("description", "")) if sdc else None
            if sdc and sdck:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == sdck), None)
                if slot is None:
                    slot = {"trigger": sdck, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "CoinFlip" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [sdc]
                    changed = True
            # "<TRIGGER> : Gagne +N AT [et +M AR] si vous avez une Graine en jeu"
            # (Orma #295) → conditional self buffs (requireCondition seedInPlay).
            # Replace the slot: the bindata only has the +AT (unconditional) and
            # would double with our conditional +AT. _authored → 1b strips on the
            # next run, then we re-replace → idempotent (regeneration-safe via the
            # description match even if the raw bindata is restored).
            csb = parse_conditional_self_buff(c.get("description", ""))
            csbk = detect_trigger_kind(c.get("description", "")) if csb else None
            if csb and csbk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == csbk), None)
                if slot is None:
                    slot = {"trigger": csbk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if slot.get("effects") != csb:
                    slot["effects"] = csb
                    changed = True
            # "<TRIGGER> : Soigne de N PV vos (autres) invocations" (La Gonflable
            # #5, FIN DU TOUR) → a scoped Heal on the detected trigger slot. Heal
            # is managed + _authored so the trigger strip in 1b drops the prior
            # copy each run → idempotent.
            mh = parse_mass_heal(c.get("description", ""))
            mhk = detect_trigger_kind(c.get("description", "")) if mh else None
            if mh and mhk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == mhk), None)
                if slot is None:
                    slot = {"trigger": mhk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "Heal" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [mh]
                    changed = True
            # "Soigne ... vos autres invocations à la fin de tous les déplacements"
            # (Ben Debouche #71, Lapino #258 "de sa ligne") gives a mass Heal on
            # POST_ADVANCE (fired after the advance phase; FIN_DE_TOUR fires before it).
            # "de sa ligne" gives shape:"row".
            sdesc = strip_markup(c.get("description", ""))
            if re.search(r"fin de (?:tous les |ses )?d[ée]placements", sdesc):
                mhd = parse_mass_heal(c.get("description", ""))
                if mhd:
                    if re.search(r"de sa ligne", sdesc):
                        mhd = {**mhd, "shape": "row"}
                    trigs = c.get("triggers") or []
                    slot = next((t for t in trigs if t.get("trigger") == "POST_ADVANCE"), None)
                    if slot is None:
                        slot = {"trigger": "POST_ADVANCE", "effects": []}
                        trigs = trigs + [slot]
                        c["triggers"] = trigs
                    if not any(e.get("type") == "Heal" for e in (slot.get("effects") or [])):
                        slot["effects"] = (slot.get("effects") or []) + [mhd]
                        changed = True
            # Forbank #653 "Déterre un Butin allié sur la case devant lui à la fin
            # des déplacements" gives PlaceButinInFront on POST_ADVANCE (after the advance).
            fb = parse_forbank(c.get("description", ""))
            if fb:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "POST_ADVANCE"), None)
                if slot is None:
                    slot = {"trigger": "POST_ADVANCE", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "PlaceButinInFront" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [fb]
                    changed = True
            # Brâm Barbemonde #833 "invoque une unité de nainfants devant lui après le
            # déplacement de toutes vos invocations" gives SummonToken {front} on POST_ADVANCE.
            pas = parse_post_advance_summon(c)
            if pas:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "POST_ADVANCE"), None)
                if slot is None:
                    slot = {"trigger": "POST_ADVANCE", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not (slot.get("effects") or []):
                    slot["effects"] = pas["effects"]
                    changed = True
            # "Se téléporte derrière son adversaire après avoir subi des dégâts"
            # (Sram #183/#206/#546) gives a TeleportBehindAttacker self effect on the
            # CONTRE_COUP slot (created if missing). _authored, so idempotent.
            tba = parse_teleport_behind(c.get("description", ""))
            if tba:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "CONTRE_COUP"), None)
                if slot is None:
                    slot = {"trigger": "CONTRE_COUP", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "TeleportBehindAttacker" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [tba]
                    changed = True
            # "<TRIGGER> : Soigne ses blessures" (Alargix #494, DÉBUT DU TOUR) → a
            # self HealFull on the detected trigger slot (created if missing).
            # HealFull managed + _authored → 1b strips → idempotent.
            shf = parse_self_heal_full(c.get("description", ""))
            shfk = detect_trigger_kind(c.get("description", "")) if shf else None
            if shf and shfk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == shfk), None)
                if slot is None:
                    slot = {"trigger": shfk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "HealFull" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [shf]
                    changed = True
            # "APPARITION : Donne +N AR/AT aux invocations alliées blessées [et +M
            # si ce sont des <Famille>]" (Oracle Offensé #1061) gives scoped buffs on
            # wounded allies on the detected slot. _authored, so idempotent.
            wab = parse_wounded_ally_buff(c.get("description", ""))
            wabk = detect_trigger_kind(c.get("description", "")) if wab else None
            if wab and wabk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == wabk), None)
                if slot is None:
                    slot = {"trigger": wabk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("wounded") for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + wab
                    changed = True
            # "<TRIGGER> : Vos <Fam1> et vos autres <Fam2> gagnent +N AT/AR" (Will
            # Skass #264) gives two BoostX scoped by family on the detected slot.
            dfb = parse_double_family_buff(c.get("description", ""))
            dfbk = detect_trigger_kind(c.get("description", "")) if dfb else None
            if dfb and dfbk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == dfbk), None)
                if slot is None:
                    slot = {"trigger": dfbk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("family") for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + dfb
                    changed = True
            # "APPARITION : Invoquez un Glyphe dans votre camp" (Melita #1813) gives
            # PlaceGlyph on the APPARITION slot (own_empty_camp pick when it fires).
            ig = parse_invoke_glyph(c.get("description", ""))
            if ig and detect_trigger_kind(c.get("description", "")) == "APPARITION":
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if slot is None:
                    slot = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "PlaceGlyph" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [ig]
                    changed = True
            # "APPARITION : Détruisez un prisme" (Patek Tag #363) gives DestroyPrism on
            # the APPARITION slot (any_prism pick when it fires).
            dp2 = parse_destroy_prism(c.get("description", ""))
            if dp2 and detect_trigger_kind(c.get("description", "")) == "APPARITION":
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if slot is None:
                    slot = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "DestroyPrism" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [dp2]
                    changed = True
            # "APPARITION : Ramasse tous les Butins en jeu et gagne +1 AT par Butin"
            # (Bernalette #776) gives GrabAllButins. It replaces the slot: the unused bindata
            # (BoostAttackData +1, the "+1 AT" read as a flat bonus) would otherwise double
            # the +AT per butin that GrabAllButins already applies. Idempotent (stripped and
            # replaced again on each run) and safe when the pool is regenerated.
            gab = parse_grab_all_butins(c.get("description", ""))
            if gab and detect_trigger_kind(c.get("description", "")) == "APPARITION":
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if slot is None:
                    slot = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if slot.get("effects") != [gab]:
                    slot["effects"] = [gab]
                    changed = True
            # "APPARITION : Transformez un Prisme en Butin" (Erik Rak #720) gives
            # TransformPrismToButin on the APPARITION slot (any_prism pick).
            tpb = parse_transform_prism_to_butin(c.get("description", ""))
            if tpb and detect_trigger_kind(c.get("description", "")) == "APPARITION":
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if slot is None:
                    slot = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "TransformPrismToButin" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [tpb]
                    changed = True
            # "<TRIGGER> : Chaque joueur pioche N carte(s) chez son adversaire"
            # (Bowne Piauch #408, APPARITION) gives CrossDraw on the detected slot.
            cdt = parse_cross_draw(c.get("description", ""))
            cdtk = detect_trigger_kind(c.get("description", "")) if cdt else None
            if cdt and cdtk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == cdtk), None)
                if slot is None:
                    slot = {"trigger": cdtk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "CrossDraw" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [cdt]
                    changed = True
            # "APPARITION : Place dans votre main le prochain Glyphe de votre
            # pioche" (Malory #645) gives TutorFromDeck {glyph} on the APPARITION slot.
            tg = parse_tutor_glyph(c.get("description", ""))
            if tg and detect_trigger_kind(c.get("description", "")) == "APPARITION":
                tg = {**tg, "_authored": True}
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if slot is None:
                    slot = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "TutorFromDeck" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [tg]
                    changed = True
            # "<trigger> : Place dans votre main la première <CardName> de votre
            # pioche" (Brute Impie #1174, COUP DE GRÂCE, for Championne du Blasphème
            # #1451) gives TutorFromDeck {cardId} on the detected trigger slot.
            # _authored, so idempotent.
            tnc = parse_tutor_named_card(c.get("description", ""))
            tnck = detect_trigger_kind(c.get("description", "")) if tnc else None
            if tnc and tnck:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == tnck), None)
                if slot is None:
                    slot = {"trigger": tnck, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "TutorFromDeck" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [tnc]
                    changed = True
            # "APPARITION : Vos Glyphes infligent N dégâts aux invocations adverses
            # de leur ligne" (Crail #820) → DamageEnemiesOnGlyphLines on APPARITION.
            crail = parse_crail(c)
            if crail and detect_trigger_kind(c.get("description", "")) == "APPARITION":
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if slot is None:
                    slot = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "DamageEnemiesOnGlyphLines" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [crail]
                    changed = True
            # "APPARITION : Ajoute N <carte> à votre main si vous avez au moins K
            # Glyphes en jeu" (Bourreau Anonyme #655) → AddCardToHand gated by
            # requireCondition glyphInPlay, on the APPARITION slot.
            orb = parse_conditional_orb(c.get("description", ""))
            orbk = detect_trigger_kind(c.get("description", "")) if orb else None
            if orb and orbk == "APPARITION":
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if slot is None:
                    slot = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "AddCardToHand" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [orb]
                    changed = True
            # "APPARITION : Inflige à la première invocation adverse devant lui
            # autant de dégâts que de Graines alliées en jeu" (Héros Chataîgneur
            # #920) → a DamageInFront (NumberOfSeedsValue) on the APPARITION slot.
            dif = parse_damage_in_front_seeds(c.get("description", ""))
            difk = detect_trigger_kind(c.get("description", "")) if dif else None
            if dif and difk == "APPARITION":
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if slot is None:
                    slot = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "DamageInFront" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [dif]
                    changed = True
            # "APPARITION : Augmente ses PM de la valeur de PM du premier adversaire
            # de sa ligne" (Leanor #1224) → BoostMovementFromEnemyInLine on APPARITION.
            pmf = parse_pm_from_enemy_in_line(c.get("description", ""))
            if pmf and detect_trigger_kind(c.get("description", "")) == "APPARITION":
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if slot is None:
                    slot = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "BoostMovementFromEnemyInLine" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [pmf]
                    changed = True
            # "APPARITION : Fait apparaître N Graines sur les cases de la rangée
            # devant lui" (Rôdeur Sylvestre #907) → PlaceSeedsInFront on APPARITION.
            psf = parse_place_seeds_in_front(c.get("description", ""))
            psfk = detect_trigger_kind(c.get("description", "")) if psf else None
            if psf and psfk == "APPARITION":
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if slot is None:
                    slot = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "PlaceSeedsInFront" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [psf]
                    changed = True
            ssb = parse_self_stat_buff(c.get("description", ""))
            if ssb:
                trigs = c.get("triggers") or []
                app = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if app is None:
                    app = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [app]
                    c["triggers"] = trigs
                if not any(e.get("type") == ssb["type"] and e.get("self") for e in (app.get("effects") or [])):
                    app["effects"] = (app.get("effects") or []) + [ssb]
                    changed = True
            # "<TRIGGER> : Gagne +N AT [et +M AR] [et se soigne de K PV]" / "Se
            # soigne de K PV" (Klaus #716 COUP DE GRÂCE, Tsar Tsu Tsu #138, Mulou
            # Garou #199) → self buff/heal on the detected trigger slot. Runs after
            # the APPARITION-only parse_self_stat_buff; the guard skips any slot
            # already carrying a self buff/heal, so there is no double-injection.
            sbh = parse_self_buff_heal(c.get("description", ""))
            sbhk = detect_trigger_kind(c.get("description", "")) if sbh else None
            if sbh and sbhk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == sbhk), None)
                if slot is None:
                    slot = {"trigger": sbhk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                existing = slot.get("effects") or []
                # Skip if another parser already authored a self buff/heal here
                # (parse_self_stat_buff for APPARITION single-buffs, the conditional
                # / count self-buffs), avoids double-injection. Otherwise replace
                # the slot: the stranded bindata (BoostAttackData / HealSelfData)
                # encodes the same buff and would double it if kept (the engine
                # processes it), exactly like parse_conditional_self_buff. Idempotent
                # (1b strips our _authored each run → re-replace) + regen-safe.
                already_authored_self = any(e.get("_authored") and e.get("self") for e in existing)
                if not already_authored_self and existing != sbh:
                    slot["effects"] = sbh
                    changed = True
            # "<TRIGGER> : Détruit les invocations ayant N AT/PV ou moins" (Plante
            # Kanniboul on DÉBUT DU TOUR, Duelliste Spectral on APPARITION with sous-nombre)
            # gives a mass AoeDestroy on the matching trigger slot. _authored.
            adt = parse_aoe_destroy(c.get("description", "")) or parse_aoe_destroy_rarity(c.get("description", "")) or parse_aoe_destroy_property(c.get("description", ""))
            tk = detect_trigger_kind(c.get("description", "")) if adt else None
            if adt and tk:
                adt = {**adt, "_authored": True}
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == tk), None)
                if slot is None:
                    slot = {"trigger": tk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "AoeDestroy" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [adt]
                    changed = True
            # "APPARITION : Détruit tous les prismes adverses" (Comte Harebourg #349)
            # gives DestroyAllEnemyPrisms on the detected trigger. Managed, so idempotent.
            dep = parse_destroy_all_enemy_prisms(c.get("description", ""))
            depk = detect_trigger_kind(c.get("description", "")) if dep else None
            if dep and depk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == depk), None)
                if slot is None:
                    slot = {"trigger": depk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "DestroyAllEnemyPrisms" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [dep]
                    changed = True
            # "APPARITION : Détruisez l'AR d'une invocation" (Larve Orange #116) →
            # a targeted DestroyArmor on the detected trigger. Managed → idempotent.
            dar = parse_destroy_armor(c.get("description", ""))
            dark = detect_trigger_kind(c.get("description", "")) if dar else None
            if dar and dark:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == dark), None)
                if slot is None:
                    slot = {"trigger": dark, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "DestroyArmor" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [dar]
                    changed = True
            # "<trigger> : Change l'AT des autres invocations pour qu'elle soit égale
            # à la sienne / leurs PV" (Moon #1747 APPARITION, Foul/Darkli Moon FIN DU
            # TOUR) gives a mass SetAttack on the detected trigger. Managed, so idempotent.
            sao = parse_set_attack_others(c)
            saok = detect_trigger_kind(c.get("description", "")) if sao else None
            if sao and saok:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == saok), None)
                if slot is None:
                    slot = {"trigger": saok, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "SetAttack" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [sao]
                    changed = True
            # "<TRIGGER> : Sacrifiez une de vos invocations pour gagner ..." (Tartanque
            # #154, Tofu Mutant #301) gives a Sacrifice on the detected trigger (needs a
            # pick). Managed, so idempotent.
            sacf = parse_sacrifice(c)
            sacfk = detect_trigger_kind(c.get("description", "")) if sacf else None
            if sacf and sacfk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == sacfk), None)
                if slot is None:
                    slot = {"trigger": sacfk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "Sacrifice" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [sacf]
                    changed = True
            # "<TRIGGER> : Ajoute N Graine(s) à votre réserve de graines"
            # (Klore Ofil #1 APPARITION +1, Sylvine Folherbe #430 APPARITION +5,
            # Grine Piz #462 CONTRE COUP +1) gives an AddSeeds player-state effect on
            # the matching trigger slot. Only APPARITION / CONTRE_COUP fire for now: the
            # DÉBUT DU TOUR adder (Arbre #1232) has no engine trigger yet, so it is
            # skipped. _authored, so idempotent.
            asd = parse_add_seeds(c.get("description", ""))
            ask = detect_trigger_kind(c.get("description", "")) if asd else None
            if asd and ask in ("APPARITION", "CONTRE_COUP", "DEBUT_DE_TOUR"):  # Arbre #1232 (DÉBUT DU TOUR), le moteur fire bien DEBUT_DE_TOUR
                asd = {**asd, "_authored": True}
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == ask), None)
                if slot is None:
                    slot = {"trigger": ask, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "AddSeeds" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [asd]
                    changed = True
            # "APPARITION : Transformez une de vos Graines en <token>" (Li Crounch
            # #129, Dodu #318, Canar #402) → a TransformSeed pick on the APPARITION
            # slot. The player picks one of their seeds (own_seed filter) at
            # resolution. _authored → 1b strips any prior copy. Buisson (object) →
            # parser returns None, so Selk Ator #108 stays deferred.
            tss = parse_transform_seed(c.get("description", ""))
            tssk = detect_trigger_kind(c.get("description", "")) if tss else None
            if tss and tssk == "APPARITION":
                tss = {**tss, "_authored": True}
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if slot is None:
                    slot = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "TransformSeed" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [tss]
                    changed = True
            # "APPARITION : Transformez une Graine alliée en Buisson" (Selk Ator
            # #108) → a TransformSeedToBush pick on the APPARITION slot (own_seed).
            tb = parse_transform_seed_to_bush(c.get("description", ""))
            tbk = detect_trigger_kind(c.get("description", "")) if tb else None
            if tb and tbk == "APPARITION":
                tb = {**tb, "_authored": True}
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if slot is None:
                    slot = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "TransformSeedToBush" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [tb]
                    changed = True
            # "APPARITION : Remontez dans la main de son propriétaire une invocation
            # ayant N AT ou moins" (Adamaï) gives a targeted ReturnToHand (maxAttack
            # filter) on the APPARITION trigger. resolvePendingAction sends the picked
            # creature back to its owner's hand. _authored, so idempotent.
            tb = parse_targeted_bounce(c.get("description", ""))
            if tb:
                trigs = c.get("triggers") or []
                app = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if app is None:
                    app = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [app]
                    c["triggers"] = trigs
                if not any(e.get("type") == "ReturnToHand" for e in (app.get("effects") or [])):
                    app["effects"] = (app.get("effects") or []) + [tb]
                    changed = True
            # "APPARITION : Échangez son corps avec une invocation adverse ayant N
            # AT ou moins" (Marline) → a SwapBody on the APPARITION trigger
            # (position + side swap with the picked enemy). _authored.
            sb = parse_swap_body(c.get("description", ""))
            if sb:
                trigs = c.get("triggers") or []
                app = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if app is None:
                    app = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [app]
                    c["triggers"] = trigs
                if not any(e.get("type") == "SwapBody" for e in (app.get("effects") or [])):
                    app["effects"] = (app.get("effects") or []) + [sb]
                    changed = True
            # "APPARITION : Détruit la première créature devant lui si elle possède
            # N AT ou moins" (Gloutoblop) → a DestroyInFront on APPARITION. _authored.
            dif = parse_destroy_in_front(c.get("description", ""))
            if dif:
                trigs = c.get("triggers") or []
                app = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if app is None:
                    app = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [app]
                    c["triggers"] = trigs
                if not any(e.get("type") == "DestroyInFront" for e in (app.get("effects") or [])):
                    app["effects"] = (app.get("effects") or []) + [dif]
                    changed = True
            # Coin-flip "stay OR self-bounce" (Elo Baine) → CoinFlip on the trigger.
            csb2 = parse_coinflip_stay_bounce(c.get("description", ""))
            csbk = detect_trigger_kind(c.get("description", "")) if csb2 else None
            if csb2 and csbk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == csbk), None)
                if slot is None:
                    slot = {"trigger": csbk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "CoinFlip" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [csb2]
                    changed = True
            # Coin-flip self trigger (Chatar / Recrue: "Gagne +N AT/AR OU s'inflige
            # M dégâts") → a CoinFlip (self buff / self damage) on the trigger slot.
            cfs = parse_coinflip_self(c.get("description", ""))
            cfsk = detect_trigger_kind(c.get("description", "")) if cfs else None
            if cfs and cfsk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == cfsk), None)
                if slot is None:
                    slot = {"trigger": cfsk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                # Replace the slot: the bindata encodes the "A OU B" as two effects in a row (both firing, which is
                # wrong). The CoinFlip is the whole APPARITION. Detected from the description, so idempotent even
                # after a fresh card-pool rebuild brings the bindata back.
                if slot.get("effects") != [cfs]:
                    slot["effects"] = [cfs]
                    changed = True
            # Coin-flip "add card A OU card B" on a trigger (Felinor APPARITION,
            # Rémus FIN DU TOUR) → a CoinFlip in the matching trigger slot.
            cfa = parse_coinflip_addcard(c.get("description", ""))
            cfk = detect_trigger_kind(c.get("description", "")) if cfa else None
            if cfa and cfk:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == cfk), None)
                if slot is None:
                    slot = {"trigger": cfk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == "CoinFlip" for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [cfa]
                    changed = True
            # Camp-scoped mass effects on APPARITION: Phaeris (Silence du camp
            # adverse) and Veuve Noire (bounce des autres invocations de votre
            # camp). Both are scope/positional → no pick. _authored.
            for cm in (parse_camp_silence(c.get("description", "")),
                       parse_camp_mass_bounce(c.get("description", ""))):
                if not cm:
                    continue
                trigs = c.get("triggers") or []
                app = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if app is None:
                    app = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [app]
                    c["triggers"] = trigs
                if not any(e.get("type") == cm["type"] and e.get("scope") == cm["scope"] for e in (app.get("effects") or [])):
                    app["effects"] = (app.get("effects") or []) + [cm]
                    changed = True
            # Line/column debuffs that need a pick to choose the line (Phaeris #1750
            # "silence d'une ligne" → Silence shape:row ; Grokoko #531 "-1 AT d'une
            # rangée ayant ≥N AT" → BoostColumnAttack amount:-1). Injected on the
            # detected trigger. Silence is managed (stripped + re-injected each run);
            # BoostColumnAttack stays NON-managed (the bindata Tikoko relies on it)
            # so the guard below keeps it idempotent.
            for ld in (parse_silence_line(c), parse_column_attack_debuff(c)):
                if not ld:
                    continue
                ldk = detect_trigger_kind(strip_markup(c.get("description", "")))
                if not ldk:
                    continue
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == ldk), None)
                if slot is None:
                    slot = {"trigger": ldk, "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                if not any(e.get("type") == ld["type"] for e in (slot.get("effects") or [])):
                    slot["effects"] = (slot.get("effects") or []) + [ld]
                    changed = True

        # 1d) Pollinisation #58 override, runs even on a "bindata" card (its
        #     stranded DamageData has no scope and is broken for an AlliedGod
        #     self-cast). The description reveals an AoE to all enemies + a
        #     seed-on-death rider, so replace the effects. Idempotent via the
        #     equality check (no need to mark AoeDamage managed); regen-safe
        #     because it re-detects from the description.
        pol = parse_pollinisation(c)
        if pol and c.get("cardType") == "Spell":
            if c.get("effects") != pol:
                c["effects"] = pol
                changed = True
                patched += 1
            continue

        # 1e) Glyphe Enflammé #1285 override, its bindata DamageData is single-
        #     target (no scope) and broken for the EmptyAlliedCells cast; the
        #     description shows an AoE-around + a placed Glyphe. Replace (idempotent
        #     via equality; AoeDamage/PlaceGlyph deliberately not managed so they
        #     persist via the kept-check on the next run). Regen-safe.
        gd = parse_glyph_damage(c)
        if gd and c.get("cardType") == "Spell":
            if c.get("effects") != gd:
                c["effects"] = gd
                changed = True
                patched += 1
            continue

        # 1f) Glyphe de Mort #937 override, authored-empty, but AoeDestroy is
        #     managed (stripped each run), so route through an override (re-produces
        #     the full effects, restoring the stripped AoeDestroy). Idempotent.
        gm = parse_glyph_destroy(c)
        if gm and c.get("cardType") == "Spell":
            if c.get("effects") != gm:
                c["effects"] = gm
                changed = True
                patched += 1
            continue

        # 1g) Glyphe de Léthargie #854 override, bindata SetPropertyData (single
        #     target) replaced by an AoE-around Stun + a placed Glyphe. SetProperty
        #     is managed → override re-produces it each run (idempotent).
        gs = parse_glyph_stun(c)
        if gs and c.get("cardType") == "Spell":
            if c.get("effects") != gs:
                c["effects"] = gs
                changed = True
                patched += 1
            continue

        # 1g²) Cervelle de Iop #683 override, bindata SetPropertyData FirstStrike
        #      has no scope, so on this AlliedGod cast it would target nothing and
        #      wrongly make validateSpellTarget demand a creature. Replace it with a
        #      scoped SetProperty (FirstStrike to all allies). SetProperty is managed
        #      → the override re-produces it each run (idempotent via equality).
        gia = parse_grant_initiative_allies(c.get("description", ""))
        if gia and c.get("cardType") == "Spell":
            if c.get("effects") != [gia]:
                c["effects"] = [gia]
                changed = True
                patched += 1
            continue

        gsa = parse_grant_shield_allies(c.get("description", ""))
        if gsa and c.get("cardType") == "Spell":
            if c.get("effects") != [gsa]:
                c["effects"] = [gsa]
                changed = True
                patched += 1
            continue

        # 1g³) Rocknocerok #50 / Éventrail #232 override, "Inflige @damage@ aux
        #      invocations adverses[ d'une ligne]". Bindata DamageData is single-
        #      target (no scope) → broken on the AlliedGod / AnyRow cast. Replace
        #      with a scoped AoeDamage (enemies[, shape:row]). AoeDamage not managed
        #      → persists via the equality check; regen-safe (re-detects).
        aae = parse_aoe_all_enemies(c)
        if aae and c.get("cardType") == "Spell":
            if c.get("effects") != aae:
                c["effects"] = aae
                changed = True
                patched += 1
            continue

        # Peur #396 / Flèche Tempête #84: "[Inflige @damage@ et] repousse de N cases
        # les invocations adverses". The bindata DamageData/PushData are single-target
        # (no scope), which breaks the AlliedGod cast. Replaced by [AoeDamage?, AoePush]
        # scope:enemies. Not managed, so it stays through the equality check.
        ape = parse_aoe_push_enemies(c)
        if ape and c.get("cardType") == "Spell":
            if c.get("effects") != ape:
                c["effects"] = ape
                changed = True
                patched += 1
            continue

        # 1g⁵) Sang Brûlant #538 override, "Inflige @damage@ aux invocations" (both
        #      camps). Bindata DamageData single-target (no scope) → broken on the
        #      AlliedGod cast. Replace with AoeDamage scope:all.
        aac = parse_aoe_all_creatures(c)
        if aac and c.get("cardType") == "Spell":
            if c.get("effects") != aac:
                c["effects"] = aac
                changed = True
                patched += 1
            continue

        # Maître des Ombres #22: "Confère à vos invocations +N AT et inciblable". The
        # bindata SetPropertyData Untargetable has no scope, which breaks the AlliedGod
        # cast (and the +N AT was missing). Replaced by a scoped BoostAttack and
        # SetProperty Untargetable (both on allies).
        gbu = parse_grant_buff_untargetable_allies(c)
        if gbu and c.get("cardType") == "Spell":
            if c.get("effects") != gbu:
                c["effects"] = gbu
                changed = True
                patched += 1
            continue

        # Harcèlement #136: "Inflige @damage@ à tous les Dofus adverses". The bindata
        # DamageData is single-target, which breaks the AlliedGod cast. Replaced by
        # AoeDamageDofus (hits every enemy Dofus).
        ade = parse_aoe_damage_enemy_dofuses(c)
        if ade and c.get("cardType") == "Spell":
            if c.get("effects") != ade:
                c["effects"] = ade
                changed = True
                patched += 1
            continue

        # Dé du Chateux #459: "Inflige 1d6. Dévoile le Dofus adverse de la ligne sur N
        # ou moins." Replaced by [DamageData{1d6}, RevealEnemyDofusLine] so the reveal
        # uses the same roll.
        ddr = parse_dice_damage_reveal_dofus(c)
        if ddr and c.get("cardType") == "Spell":
            if c.get("effects") != ddr:
                c["effects"] = ddr
                changed = True
                patched += 1
            continue

        # Dé Ecaflip #342: "Inflige 1d6. Récupérez ce sort sur N ou moins." Replaced by
        # [DamageData{1d6}, RecoverSelfOnLowRoll] so the spell goes back to the hand when
        # the same roll is at most N.
        ddrec = parse_dice_damage_recover(c)
        if ddrec and c.get("cardType") == "Spell":
            if c.get("effects") != ddrec:
                c["effects"] = ddrec
                changed = True
                patched += 1
            continue

        # Dé Rebondissant #573: "Inflige 1d6 aux invocations adverses. Coûte 1 PA de
        # moins par Chacha allié." The broken single-target dice bindata is replaced by
        # [AoeDamage{1d6,enemies}, SelfCostReduction{Chacha allies}].
        adc = parse_aoe_dice_chacha(c)
        if adc and c.get("cardType") == "Spell":
            if c.get("effects") != adc:
                c["effects"] = adc
                changed = True
                patched += 1
            continue

        # Repos Éternel #20: "ne dépensez pas de PA ... à la place bannissez". The
        # SetPropertyData bindata is replaced by SetDiscardPaysCost.
        dpc = parse_discard_pays_cost(c)
        if dpc and c.get("cardType") in ("Spell", "Aoe"):
            if c.get("effects") != [dpc]:
                c["effects"] = [dpc]
                changed = True
                patched += 1
            continue

        # 1g¹²) Bombe #101 override, replace the single-target DamageData bindata
        #       with a PlaceTrap (lay a board trap instead of dealing damage now).
        bmb = parse_bombe_trap(c)
        if bmb:
            if c.get("effects") != [bmb]:
                c["effects"] = [bmb]
                changed = True
                patched += 1
            continue

        # Trap placers #624/#712/#945: "Place un piège <X> activé dans la main de votre
        # adversaire" gives GiveActiveTrap (with the matching Activé card id).
        gat = parse_give_active_trap(c)
        if gat:
            if c.get("effects") != [gat]:
                c["effects"] = [gat]
                changed = True
                patched += 1
            continue

        # 1g¹⁴) "Activé" trap #671/#681/#950 override, replace the counter+penalty
        #       bindata with just the play effect (counter handled engine-side).
        atp = parse_active_trap_play(c)
        if atp is not None:
            if c.get("effects") != atp:
                c["effects"] = atp
                changed = True
                patched += 1
            continue

        # 1h) Glyphe de Retraite #736 override, bindata PushData (single target)
        #     replaced by an AoE-around push + a placed Glyphe. AoePush/PlaceGlyph
        #     not managed → idempotent via the equality check + kept-check.
        gp = parse_glyph_push(c)
        if gp and c.get("cardType") == "Spell":
            if c.get("effects") != gp:
                c["effects"] = gp
                changed = True
                patched += 1
            continue

        # 1i) Sang Tatoué #350 override, "Piochez N pour chacune de vos invocations
        #     blessées." A player-state DrawCards whose amount is a {count} CountSpec
        #     (resolved at cast against the wounded allies via resolveCounts). The
        #     dynamic amount is ineligible for the concrete section-2 path, and
        #     DrawCards is managed (stripped each run) → re-produce here. Idempotent
        #     via equality; regen-safe (re-detected from the description).
        dpc = parse_draw_per_count(c.get("description", ""))
        if dpc and c.get("cardType") in ("Spell", "Aoe"):
            if c.get("effects") != [dpc]:
                c["effects"] = [dpc]
                changed = True
                patched += 1
            continue

        # 1j) La Gerbouille #547 override, "Confère +N AT à vos invocations
        #     blessées puis elles chargent de M cases." A scoped wounded BoostAttack
        #     followed by a scoped wounded ChargeAllies (both managed → stripped
        #     each run, re-produced here). The sequential "puis" order is preserved
        #     by castSpell (board effects apply the buff, then the charge handler
        #     advances the same wounded set). Idempotent via equality.
        wbc = parse_wounded_buff_charge(c.get("description", ""))
        if wbc and c.get("cardType") in ("Spell", "Aoe"):
            if c.get("effects") != wbc:
                c["effects"] = wbc
                changed = True
                patched += 1
            continue

        # 1k) Echaenge #545 override, "Chaque joueur pioche 1 carte chez son
        #     adversaire." A player-state CrossDraw (both draw off the other deck).
        #     CrossDraw is managed (stripped each run) → re-produce here. Idempotent
        #     via equality; regen-safe (re-detected from the description).
        cd = parse_cross_draw(c.get("description", ""))
        if cd and c.get("cardType") in ("Spell", "Aoe"):
            if c.get("effects") != [cd]:
                c["effects"] = [cd]
                changed = True
                patched += 1
            continue

        # 1l) Escroc #1022 override, "Piochez 1 carte chez votre adversaire, votre
        #     adversaire pioche 1 carte." A player-state StealTopDraw (you take their
        #     top, they draw their own). Managed → re-produce each run. Idempotent.
        std = parse_steal_top_draw(c.get("description", ""))
        if std and c.get("cardType") in ("Spell", "Aoe"):
            if c.get("effects") != [std]:
                c["effects"] = [std]
                changed = True
                patched += 1
            continue

        # 1m) Mill, "Chaque joueur défausse <N premières / autant qu'invocations>
        #     cartes de sa pioche" (Rituel Sram #251, Gredin #1165). Player-state
        #     MillDeck; managed → re-produce each run. Idempotent via equality.
        mill = parse_mill_deck(c.get("description", ""))
        if mill and c.get("cardType") in ("Spell", "Aoe"):
            if c.get("effects") != [mill]:
                c["effects"] = [mill]
                changed = True
                patched += 1
            continue

        # Fosscheur #217: "Déplace les cartes de la défausse de votre adversaire dans la
        # votre." A player-state StealDiscard. Managed, so produced again on each run.
        # Idempotent through the equality check.
        sd2 = parse_steal_discard(c.get("description", ""))
        if sd2 and c.get("cardType") in ("Spell", "Aoe"):
            if c.get("effects") != [sd2]:
                c["effects"] = [sd2]
                changed = True
                patched += 1
            continue

        # 1o) Garde Temps #493 override, "Détruit un Dofus." A flat DestroyDofus
        #     (spell castTarget AnyDofus → the click is the Dofus). Not managed →
        #     persists via the kept-check; idempotent via equality. Regen-safe.
        dd2 = parse_destroy_dofus(c.get("description", ""))
        if dd2 and c.get("cardType") in ("Spell", "Aoe"):
            if c.get("effects") != [dd2]:
                c["effects"] = [dd2]
                changed = True
                patched += 1
            continue

        # 1p) Butin placement, token #789 (model butin_token) + Trouvaille #1382
        #     ("Posez N Butins dans votre camp"). PlaceButin (player-state, posé au
        #     cast). Not managed → persists via kept-check; idempotent via equality.
        pb = parse_place_butin(c)
        if pb and c.get("cardType") in ("Spell", "Aoe"):
            if c.get("effects") != pb:
                c["effects"] = pb
                changed = True
                patched += 1
            continue

        # Tas d'Os placement: card #691 (model tas_dos) gives PlaceTasDOs (player state,
        # placed at cast; it destroys a prism on the cell). Not managed, so it stays
        # through the kept check; idempotent through the equality check.
        pt = parse_place_tasdos(c)
        if pt and c.get("cardType") in ("Spell", "Aoe"):
            if c.get("effects") != pt:
                c["effects"] = pt
                changed = True
                patched += 1
            continue

        # 1q) Pioche Antique #1252 override, "Piochez 1 carte. Elle coûte 1 PA de
        #     moins." A player-state DrawCards {costMod:-1}. DrawCards is managed →
        #     re-produce each run. Idempotent via equality.
        dc2 = parse_draw_cheaper(c.get("description", ""))
        if dc2 and c.get("cardType") in ("Spell", "Aoe"):
            if c.get("effects") != [dc2]:
                c["effects"] = [dc2]
                changed = True
                patched += 1
            continue

        # 1r) Summon on-summon abilities authored on APPARITION POST-1b (so they
        #     survive 1b's _authored strip and re-inject each run = idempotent),
        #     for cards with no reliable trigger keyword / no triggers array:
        #     La Folle #481 (DiscountNextCard), Emma Cabre #963 (BanishOwnDiscard
        #     "bannit la dernière carte" + DiscountNextCard, in text order).
        if c.get("cardType") == "Summon":
            appar = []
            bod = parse_banish_own_discard(c.get("description", ""))
            if bod:
                appar.append(bod)
            dnc = parse_discount_next_card(c.get("description", ""))
            if dnc:
                appar.append(dnc)
            if appar:
                trigs = c.get("triggers") or []
                slot = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
                if slot is None:
                    slot = {"trigger": "APPARITION", "effects": []}
                    trigs = trigs + [slot]
                    c["triggers"] = trigs
                for eff in appar:
                    if not any(e.get("type") == eff["type"] for e in (slot.get("effects") or [])):
                        slot["effects"] = (slot.get("effects") or []) + [eff]
                        changed = True

        # 2) Only authored-empty Spell cards are injection candidates. If kept
        #    still has effects, it is a bindata card, leave it alone.
        if kept:
            continue
        if c.get("cardType") != "Spell":
            continue
        # Description-based spell effects that do not rely on a spec entry.
        bs = parse_buff_suicide(c.get("description", ""))
        if bs:
            c["effects"] = bs
            changed = True
            patched += 1
            continue
        ts = parse_temp_stat(c.get("description", ""))
        if ts:
            c["effects"] = [ts]
            changed = True
            patched += 1
            continue
        tc = parse_temp_control(c.get("description", ""))
        if tc:
            c["effects"] = [tc]
            changed = True
            patched += 1
            continue
        tf = parse_tutor_family(c.get("description", ""))
        if tf:
            c["effects"] = [tf]
            changed = True
            patched += 1
            continue
        tr = parse_trucage(c.get("description", ""))
        if tr:
            c["effects"] = [tr]
            changed = True
            patched += 1
            continue
        df = parse_dice_floor(c.get("description", ""))  # Dé Pipé (plancher de dé)
        if df:
            c["effects"] = [df]
            changed = True
            patched += 1
            continue
        trly = parse_trigger_rally(c)  # Ralliement #1014 (sort : fait rallier la cible)
        if trly:
            c["effects"] = [trly]
            changed = True
            patched += 1
            continue
        acn = parse_add_chacha_noir(c)  # Dé du Chacha (ajoute 1d6 Chacha Noir en main)
        if acn:
            c["effects"] = [acn]
            changed = True
            patched += 1
            continue
        rfd = parse_recover_family_discard(c)  # Armée des Ombres (gets back every Sram from the discard)
        if rfd:
            c["effects"] = [rfd]
            changed = True
            patched += 1
            continue
        ccr = parse_coinflip_charge_retreat(c.get("description", ""))
        if ccr:
            c["effects"] = [ccr]
            changed = True
            patched += 1
            continue
        cf = parse_coinflip(c)
        if cf:
            c["effects"] = [cf]
            changed = True
            patched += 1
            continue
        # Nouvelle Vague #1213 (Spell), "les cartes <famille> coûtent N de moins", gives a
        # one-shot StampCostReduction {family}. Wagnar/Vampyro are Summons, handled on the
        # APPARITION elsewhere; here only a family Spell reaches this chain.
        scrs = parse_stamp_cost_reduction(c)
        if scrs:
            c["effects"] = [scrs]
            changed = True
            patched += 1
            continue
        # Reveal from a spell (Sang Méprise #211 "tous les dofus", Démasqué #1234 "un
        # dofus") gives RevealDofuses (one-shot). The Summon versions are on the APPARITION.
        rvd = parse_reveal_dofuses(c)
        if rvd:
            c["effects"] = [rvd]
            changed = True
            patched += 1
            continue
        # Attirance (Sacrieur) : attire les prismes adverses vers ton camp (SORT).
        atp = parse_attract_prisms(c)
        if atp:
            c["effects"] = [atp]
            changed = True
            patched += 1
            continue
        # "Sacrifiez un de vos dofus pour piocher N cartes" (Refus de Mort #248).
        sdd = parse_sacrifice_dofus_draw(c)
        if sdd:
            c["effects"] = sdd
            changed = True
            patched += 1
            continue
        rh = parse_recycle_hand(c.get("description", ""))
        if rh:
            c["effects"] = [rh]
            changed = True
            patched += 1
            continue
        # Seed-reserve adder spells: Sac De Graines #74 (+2), Révolte Naturelle
        # #1684 (dynamic = enemy creatures in play). Trigger-based adders (Klore
        # Ofil, Grine Piz, …) are Summons handled in the 1c trigger path above.
        asd = parse_add_seeds(c.get("description", ""))
        if asd:
            c["effects"] = [asd]
            changed = True
            patched += 1
            continue
        bc = parse_buff_and_charge(c.get("description", ""))
        if bc:
            c["effects"] = bc
            changed = True
            patched += 1
            continue
        dcb = parse_dynamic_count_buff(c.get("description", ""))
        if dcb:
            c["effects"] = dcb
            changed = True
            patched += 1
            continue
        ca = parse_charge_allies(c.get("description", ""))
        if ca:
            c["effects"] = [ca]
            changed = True
            patched += 1
            continue
        cd = parse_conditional_draw(c.get("description", ""))
        if cd:
            c["effects"] = [cd]
            changed = True
            patched += 1
            continue
        gdr = parse_glyph_draw(c.get("description", ""))  # Glyphe de Renouveau #924
        if gdr:
            c["effects"] = gdr
            changed = True
            patched += 1
            continue
        gaa = parse_glyph_armor_attack(c.get("description", ""))  # Glyphe Agressif #1577
        if gaa:
            c["effects"] = gaa
            changed = True
            patched += 1
            continue
        cmb = parse_conditional_mass_buff(c.get("description", ""))
        if cmb:
            c["effects"] = cmb
            changed = True
            patched += 1
            continue
        tsm = parse_transform_seeds_mass(c.get("description", ""))
        if tsm:
            c["effects"] = [tsm]
            changed = True
            patched += 1
            continue
        tbm = parse_transform_butins_mass(c.get("description", ""))  # Corruption (vos Butins → token)
        if tbm:
            c["effects"] = [tbm]
            changed = True
            patched += 1
            continue
        bg = parse_bounce_glyphs(c.get("description", ""))  # Remaniement (vos Glyphes → main)
        if bg:
            c["effects"] = [bg]
            changed = True
            patched += 1
            continue
        hcod = parse_heal_creature_or_dofus(c.get("description", ""))  # Mot Reconstituant (invocation ou Dofus)
        if hcod:
            c["effects"] = [hcod]
            changed = True
            patched += 1
            continue
        tss = parse_transform_seed(c.get("description", ""))  # single, spell (Botanique)
        if tss:
            c["effects"] = [tss]
            changed = True
            patched += 1
            continue
        tis = parse_transform_into_seed(c.get("description", ""))  # Savoir Sadida (invocation → graine)
        if tis:
            c["effects"] = [tis]
            changed = True
            patched += 1
            continue
        tib = parse_transform_into_butin(c.get("description", ""))  # Main de Nidas (invocation → Butin)
        if tib:
            c["effects"] = [tib]
            changed = True
            patched += 1
            continue
        tb = parse_transform_seed_to_bush(c.get("description", ""))  # Buisson sort #214 (graine → buisson)
        if tb:
            c["effects"] = [tb]
            changed = True
            patched += 1
            continue
        ta = parse_transform_all_spell(c.get("description", ""))
        if ta:
            c["effects"] = [ta]
            changed = True
            patched += 1
            continue
        mb = parse_mass_bounce(c.get("description", ""))
        if mb:
            c["effects"] = [mb]
            changed = True
            patched += 1
            continue
        ad = parse_aoe_destroy(c.get("description", ""))
        if ad:
            c["effects"] = [ad]
            changed = True
            patched += 1
            continue
        sp = spec.get(c["id"])
        if not sp:
            continue

        sp_effects = sp.get("effects", [])
        if not sp_effects:
            continue
        # 3) No partial cards: every effect type must be implemented.
        if not all(e.get("type") in IMPLEMENTED for e in sp_effects):
            continue
        # 3b) Every amount must be a concrete integer (no dice / dynamic).
        if not all(has_concrete_amount(e) for e in sp_effects):
            continue
        # 4) Targeting check. Player-state effects (DrawCards / EndTurn) do not
        #    aim at a creature, so they skip the "une invocation" requirement,
        #    but the reject markers still apply (catches conditional / or /
        #    opponent riders). Cards that do touch a creature still require the
        #    explicit single-target phrasing.
        types = {e.get("type") for e in sp_effects}
        s = strip_markup(c.get("description", ""))
        aoe_scope = None  # set by the AoE branch; stamped onto stat effects below
        aoe_shape = None  # set by the spatial-AoE branch
        transform_tok = None  # (tokenId, asOwner) set by the Transform branch
        addcard_tok = None    # (cardId, amount) set by the AddCardToHand branch
        summon_tok = None     # (tokenId, amount) set by the SummonToken branch
        if (
            detect_shape(s)
            and all(e.get("type") in STAMPABLE or e.get("type") in PLAYER_TYPES for e in sp_effects)
            and any(e.get("type") in STAMPABLE for e in sp_effects)
        ):
            # Spatial AoE, a stat/Silence effect over a geometric zone (row /
            # cross / around the clicked cell). Reject non-creature / riders /
            # cost / wounded-sub-filter; the side qualifier defaults to "all".
            if any(p in s for p in NONCREATURE + ARMOR_WORDS + RIDERS + COST_MARKERS + TEMP_MARKERS + ["blessé", "puis"]):
                continue
            aoe_shape = detect_shape(s)
            aoe_scope = detect_scope(s) or "all"
        elif types == {"AddCostModifier"}:
            # Only the hand-scoped reducer ("cartes de votre main"); the deck /
            # class-filtered variant ("votre jeu", "Fécas") is not modelled.
            if "votre main" not in s:
                continue
            if any(p in s for p in COSTMOD_REJECT):
                continue
        elif types == {"SpendApAsBuff"}:
            # Heure de Gloire: "Dépense vos PA ... pour donner à une invocation ...", a
            # single-target creature buff (the cost words are the effect, so they are
            # allowed; only mass or non-creature wordings are rejected).
            if not any(p in s for p in REQUIRE_ANY):
                continue
            if any(p in s for p in ["vos invocation", "les invocation", "toutes"] + NONCREATURE):
                continue
        elif types <= PLAYER_TYPES:
            if any(p in s for p in PLAYER_REJECT):
                continue
        elif types <= GLOBAL_TYPES:
            if any(p in s for p in GLOBAL_REJECT):
                continue
        elif types <= TWO_TARGET_TYPES:
            if "SwapPosition" in types:
                if "position" not in s:
                    continue
            elif "2 invocation" not in s and "deux invocation" not in s:
                continue
            if any(p in s for p in TWO_TARGET_REJECT):
                continue
        elif types == {"Transform"}:
            # "Transforme une invocation en X." Single-target only (reject the
            # mass "transforme vos invocations …" variants), and the token name
            # must resolve to a real Summon card. We can only run it once both
            # hold; otherwise leave the card empty.
            #
            # Also accept the family-restricted phrasing "Transforme un de vos
            # <famille> en X" (Transphorzerker "un de vos Enutrofs"), the family
            # + side restriction is enforced at cast time by the card's castTarget
            # ("Allied<Family>Summon"), so the effect itself stays a plain
            # single-target Transform.
            single = any(p in s for p in REQUIRE_ANY) or bool(re.search(r"\bun de (?:vos|tes)\b", s))
            if not single:
                continue
            if any(p in s for p in ["vos invocation", "les invocation", "toutes"]):
                continue
            transform_tok = resolve_transform(sp_effects[0].get("into", ""))
            if transform_tok is None:
                continue
        elif types == {"AddCardToHand"}:
            # "Ajoute N <carte> à votre main." Needs a concrete count (handled
            # by has_concrete_amount → drops the 1d6 variant) and a card name
            # that resolves to a real card. No board target.
            cid = resolve_card(sp_effects[0].get("card", ""))
            amt = sp_effects[0].get("amount")
            if cid is None or not isinstance(amt, int) or amt <= 0:
                continue
            addcard_tok = (cid, amt)
        elif types == {"SummonToken"}:
            # "Invoque N <token> sur vos cases de départ" / "Posez N <token>
            # dans votre camp." The token name must resolve. The count is the
            # parsed `amount`; when the text just says "des" (no number) we fill
            # the start column, the engine caps it at the free spawn cells.
            tid = resolve_token(sp_effects[0].get("token", ""))
            if tid is None:
                continue
            amt = sp_effects[0].get("amount")
            summon_tok = (tid, amt if isinstance(amt, int) and amt > 0 else 5)
        elif types == {"ChangeRow"}:
            if not any(p in s for p in REQUIRE_ANY):
                continue
            if any(p in s for p in CHANGEROW_REJECT):
                continue
        elif types == {"SetProperty"}:
            # Property grant: "Confère <mot-clé> à une invocation" (single) or
            # "… à vos invocations" (scope=allies, stamped by the parser).
            if sp_effects[0].get("scope"):
                if "vos invocation" not in s:
                    continue
                if any(p in s for p in SHAPE + RIDERS + COST_MARKERS):
                    continue
            else:
                if not any(p in s for p in REQUIRE_ANY):
                    continue
                if any(p in s for p in NONCREATURE + RIDERS + COST_MARKERS + ["puis"]):
                    continue
        elif (
            all(e.get("type") in SCOPED_STAT_TYPES or e.get("type") in PLAYER_TYPES for e in sp_effects)
            and any(e.get("type") in SCOPED_STAT_TYPES for e in sp_effects)
            and detect_scope(s)
        ):
            # Mass buff / heal / debuff hitting a whole side ("vos invocations",
            # "invocations adverses", "toutes les invocations"). Spatial AoE
            # (rangée / autour / ligne) needs geometry we do not model yet → skip;
            # riders / cost still bite.
            if any(p in s for p in SHAPE):
                continue
            # "blessé(es)" = a wounded-only sub-filter, "puis" = a sequential
            # rider, both mean the parser under-captured the card. Plus the
            # usual riders / cost.
            if any(p in s for p in RIDERS + COST_MARKERS + TEMP_MARKERS + ["blessé", "puis"]):
                continue
            aoe_scope = detect_scope(s)
        elif types == {"Charge"}:
            # Single-target creature charge: "L'invocation ciblée charge de N cases" or
            # "... charge jusqu'au Dofus adverse" (toWall). The target wording is required,
            # but "dofus" / "jusqu'au" are not rejected here: they name where the charge
            # goes, not a rider that disqualifies the card (the generic
            # is_faithful_single_target rejects both, which wrongly dropped Autorité).
            # Only riders that are really unsupported disqualify it.
            if not any(p in s for p in REQUIRE_ANY):
                continue
            if any(p in s for p in [" ou ", "chacun", "chacune", " par ", "meurt", "meure", "défausse", "defausse", "bannit"] + COST_MARKERS):
                continue
        elif not is_faithful_single_target(c.get("description", "")):
            continue

        injected = []
        for e in sp_effects:
            ej = {k: v for k, v in e.items() if k != "when"}
            if e.get("type") == "Transform" and transform_tok:
                ej = {"type": "Transform", "tokenId": transform_tok[0], "asOwner": transform_tok[1]}
            if e.get("type") == "AddCardToHand" and addcard_tok:
                ej = {"type": "AddCardToHand", "cardId": addcard_tok[0], "amount": addcard_tok[1]}
            if e.get("type") == "SummonToken" and summon_tok:
                ej = {"type": "SummonToken", "tokenId": summon_tok[0], "amount": summon_tok[1]}
            if e.get("type") in STAMPABLE:
                if aoe_scope:
                    ej["scope"] = aoe_scope
                if aoe_shape:
                    ej["shape"] = aoe_shape
            injected.append(ej)
        if injected:
            c["effects"] = injected
            changed = True
            patched += 1

    # Final pass (whatever the source): an APPARITION that summons creatures lets the
    # player place each one on a valid summon cell (same logic as Amalia), so automatic
    # placements (near / spawn / unset) become "choose". Row / beside / target keep
    # their explicit placement.
    for c in cards:
        for t in (c.get("triggers") or []):
            if t.get("trigger") != "APPARITION":
                continue
            for e in (t.get("effects") or []):
                if e.get("type") == "SummonToken" and e.get("placement") in (None, "near", "spawn"):
                    # "à côté de lui" (Nomekop #563, Gary Bûhl #759, Moogrr Céleste #1263)
                    # auto-places on the adjacent cells, not a player pick.
                    if re.search(r"[àa]\s+c[ôo]t[ée]\s+de\s+lui", strip_markup(c.get("description", ""))):
                        e["placement"] = "sides"
                    else:
                        e["placement"] = "choose"
                    changed = True
        # Drop empty end-of-turn / post-advance slots (e.g. a FIN_DE_TOUR slot whose
        # effect moved to POST_ADVANCE), an empty managed slot does nothing.
        trigs = c.get("triggers")
        if trigs:
            kept = [t for t in trigs if t.get("effects") or t.get("trigger") not in ("FIN_DE_TOUR", "POST_ADVANCE")]
            if len(kept) != len(trigs):
                c["triggers"] = kept
                changed = True
        # Julith Jurgen #432: the reaction "inflige N dégât(s) aux invocations adverses qui
        # entrent en jeu" now lives on the ENTERS_PLAY {entrant} trigger (first loop). The
        # bindata DamageData{N} left in effects[] (with no trigger) is removed here, in the
        # second loop, otherwise it would hit the summon cell when Julith appears. Since
        # DamageData is not managed it is removed explicitly, and only for this card (the
        # parser acts as the check), so the other Julith (#352/#488) are left alone.
        # Idempotent.
        if parse_enters_play_damage(c):
            effs = c.get("effects") or []
            kept = [e for e in effs if e.get("type") != "DamageData"]
            if len(kept) != len(effs):
                c["effects"] = kept
                changed = True
        # Coup de Sang #570 "confère autant d'AT qu'elle a de PV" → the SetAttack {toLife}
        # injected above must add (not set). Done here, post-injection, so the flag survives.
        if parse_coup_de_sang(c):
            for e in (c.get("effects") or []):
                if e.get("type") == "SetAttack" and e.get("toLife") and not e.get("add"):
                    e["add"] = True
                    changed = True
        # Lou 1★ #572 "Faites réapparaître un prisme allié" → the player chooses which
        # first-column (x=8) row gets its prism back (a targeted APPARITION pick), instead
        # of the auto scope:"one" respawn of the nearest missing row. The first loop
        # (re)injects RespawnPrisms{scope:"one"}; here we convert it to {choose:true}.
        # Idempotent: scope:"one" → choose:true each run; an already-converted effect is
        # left as-is (no scope to rewrite).
        if c.get("id") == 572:
            for t in (c.get("triggers") or []):
                if t.get("trigger") != "APPARITION":
                    continue
                for e in (t.get("effects") or []):
                    if e.get("type") == "RespawnPrisms" and e.get("scope") == "one":
                        e.pop("scope", None)
                        e["choose"] = True
                        changed = True
        # Chafer Archer #336 "APPARITION : Placez un tas d'os allié dans votre camp" gives
        # PlaceTasDOs on the APPARITION slot (own_empty_camp pick when it fires). Written here,
        # in the second loop, after the bindata strip and injection of the first loop, so the
        # ShooterRangeData (PORTÉE) that stays in effects[] is kept. Idempotent: PlaceTasDOs
        # is only added if the APPARITION slot does not have it yet.
        ptd = parse_place_tasdos_apparition(c)
        if ptd and detect_trigger_kind(c.get("description", "")) == "APPARITION":
            trigs = c.get("triggers") or []
            slot = next((t for t in trigs if t.get("trigger") == "APPARITION"), None)
            if slot is None:
                slot = {"trigger": "APPARITION", "effects": []}
                trigs = trigs + [slot]
                c["triggers"] = trigs
            if not any(e.get("type") == "PlaceTasDOs" for e in (slot.get("effects") or [])):
                slot["effects"] = (slot.get("effects") or []) + [ptd]
                changed = True

        # Cléophée #28/#755/#845 "attaque une deuxième fois après un combat si un autre
        # membre allié de la Confrérie du Tofu est en jeu": add ShooterSecondAttack {family}
        # to effects[]. Written here, in the second loop, after the bindata strip and
        # injection of the first loop, so the ShooterRangeData (PORTÉE) in effects[] is kept
        # (same precaution as for Chafer Archer #336 above). Idempotent: the marker is only
        # added if effects[] does not have it yet.
        ssa = parse_shooter_second_attack(c)
        if ssa and not any(e.get("type") == "ShooterSecondAttack" for e in (c.get("effects") or [])):
            c["effects"] = (c.get("effects") or []) + [ssa]
            changed = True

    if changed:
        Path(f).write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")

print(f"injected effects into {patched} cards (IMPLEMENTED={sorted(IMPLEMENTED)})")
print(f"injected authored effects into {patched_triggers} trigger slots")
print(f"injected CHEF auras into {patched_chief} summons")
print(f"(stripped stale managed effects from {stripped_only} card-slots before re-injecting)")
