"""Build the card effects spec sheet.

For every card with effects (~461: bindata effects, triggers, or Spell/Aoe),
emit one row:
  { id, name, god, type, cost, target, secondaryCost, description,
    source: "bindata" | "description",
    status: "extracted" | "drafted" | "manual",
    effects: [ { when, type, ...params } ] }

- cards with bindata effects: effects copied from the extracted data
  (attached to their trigger when there is one), source=bindata, status=extracted.
- Spell/Aoe with no effects: a first draft parsed from the French description.
  Matched patterns give status=drafted, the rest status=manual (effects left
  empty, with the raw text, to be written by hand).

Outputs:
  notes/card_effects_spec.json   (machine-readable)
  notes/card_effects_spec.md     (review document, grouped by status)
"""
import sys, json, glob, re
sys.stdout.reconfigure(encoding="utf-8")
from pathlib import Path

from paths import CARD_POOL_GLOB

allc = {}
for f in glob.glob(CARD_POOL_GLOB):
    d = json.loads(Path(f).read_text(encoding="utf-8"))
    for c in (d if isinstance(d, list) else d.get("cards", d)):
        allc[c["id"]] = c

# raw bindata for secondary costs (AllAPConsumption etc.)
def secondary_cost(cid):
    p = ROOT / "notes/card_bindata" / f"{cid}.json"
    if not p.exists(): return None
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None
    sc = raw.get("SecondaryCosts") or []
    if not sc: return None
    return [(s.get("$type","").split(",")[0].split(".")[-1]) for s in sc]

def clean(s):
    # The bindata uses both literal newlines and the escape "\\n" / "\\_" / "|_"
    # as line-break / glue markers, normalise them all to a single space so the
    # parsers see plain prose (e.g. "APPARITION :\nInfligez 2 dégâts").
    return (s or "").replace("|_", " ").replace("\\_", " ").replace("\\n", " ") \
        .replace("<b>", "").replace("</b>", "").replace("\n", " ").strip()

# --- French keyword → SummonProperty (for "Confère X") -----------------------
KW_PROP = {
    "inamovible": "Rooted", "vuln": "Vulnerable", "bouclier": "Shield",
    "initiative": "FirstStrike", "provocation": "Taunt", "invisib": "Invisibility",
    "soin": "Heal", "perce-armure": "PierceArmor", "berserk": "Berserk",
}
# Keywords whose grant the engine actually honours (so granting them does
# something). Others (Furtif / Provocation …) stay stub until the mechanic lands.
PROP_GRANT = {
    "inciblable": "Untargetable", "bouclier": "Shield",
    "initiative": "FirstStrike", "inamovible": "Rooted",
}
PROP_RE = r"(inciblable|bouclier|initiative|inamovible)"

NUM = r"(\d+|1d6|\d*d\d+|@\w+@)"
def num(s):
    s = s.strip()
    if s.startswith("@"): return {"dyn": s.strip("@")}
    if "d" in s: return {"dice": s}
    return int(s)

# Dynamic-value phrases → a symbolic value token.
def dyn_of(clause):
    if "cartes en main" in clause or "en main" in clause: return {"dyn": "handSize"}
    if "ses pv" in clause or "pv restants" in clause: return {"dyn": "life"}
    if "invocation" in clause and "ligne" in clause: return {"dyn": "summonsInRow"}
    return {"dyn": "?"}

# Ordered (pattern, builder). Applied per clause (we split on et/,/./\n) so a number in one clause
# cannot be taken by another clause's rule (this happened with #29).
RULES = [
    # --- draw / hand / deck ---
    (rf"piochez? {NUM} cartes?", lambda m: {"type": "DrawCards", "amount": num(m.group(1))}),
    (r"piochez? jusqu'[àa] avoir (\d+)", lambda m: {"type": "DrawUpTo", "amount": int(m.group(1))}),
    (r"place[zr]? dans (?:votre|la) main les? (\d+|le|la|premiers?|premi[èe]re) (.+?) de (?:votre|la|sa) pioche",
        lambda m: {"type": "TutorFromDeck", "card": m.group(2).strip(), "amount": (int(m.group(1)) if m.group(1).isdigit() else 1)}),
    (r"place.* (?:sur|sous) (?:la|sa|votre) pioche", lambda m: {"type": "ReturnToDeck"}),
    (r"remonte[zr]?.* (?:dans|main)", lambda m: {"type": "ReturnToHand"}),
    (rf"ajoutez? {NUM} (.+?) [àa] (?:votre|la) main", lambda m: {"type": "AddCardToHand", "amount": num(m.group(1)), "card": m.group(2).strip()}),
    # --- damage / heal ---
    (rf"inflige[zr]?.* {NUM} d[ée]g[âa]ts?", lambda m: {"type": "Damage", "amount": num(m.group(1))}),
    (r"soigne.* pv manquants", lambda m: {"type": "HealFull"}),
    (rf"soigne[zr]?.* {NUM} pv", lambda m: {"type": "Heal", "amount": num(m.group(1))}),
    (rf"fait chuter [àa] (\d+) les pv", lambda m: {"type": "SetLife", "value": int(m.group(1))}),
    (r"[ée]change la position", lambda m: {"type": "SwapPosition"}),
    # --- attack stat ---
    (rf"\+ ?{NUM} at\b", lambda m: {"type": "BoostAttack", "amount": num(m.group(1))}),
    (rf"augmente.*\bat\b.* de {NUM}", lambda m: {"type": "BoostAttack", "amount": num(m.group(1))}),
    (rf"gagne.* {NUM} at\b", lambda m: {"type": "BoostAttack", "amount": num(m.group(1))}),
    (r"gagne autant d'at", lambda m, c: {"type": "BoostAttack", "amount": dyn_of(c)}),
    # "Réduit de N l'AT des invocations adverses", a negative attack buff on
    # the enemy side. Emit a plain BoostAttack(-N); the merge detects the
    # "adverses" scope and routes it through the same AoE stat path.
    (rf"r[ée]duit de {NUM} l'at des invocations adverses", lambda m: {"type": "BoostAttack", "amount": -num_int(m.group(1))}),
    (rf"passe.*\bat\b.* [àa] (\d+)", lambda m: {"type": "SetAttack", "value": int(m.group(1))}),
    (rf"fait chuter.* [àa] (\d+) l'at", lambda m: {"type": "SetAttack", "value": int(m.group(1))}),
    (r"change l'at .* [ée]gale? [àa] ses pv", lambda m: {"type": "SetAttack", "value": {"dyn": "life"}}),
    (r"[ée]changez? (?:l')?at de 2", lambda m: {"type": "SwapAttack"}),
    (r"[ée]changez? son at", lambda m: {"type": "SwapAttack"}),
    (r"double son at", lambda m: {"type": "MultiplyAttack", "factor": 2}),
    # --- armor stat ---
    (rf"\+ ?{NUM} ar\b", lambda m: {"type": "BoostArmor", "amount": num(m.group(1))}),
    (rf"gagne.* {NUM} ar\b", lambda m: {"type": "BoostArmor", "amount": num(m.group(1))}),
    (rf"conf[èe]re {NUM} ar", lambda m: {"type": "BoostArmor", "amount": num(m.group(1))}),
    (r"[ée]changez? (?:l')?ar de 2", lambda m: {"type": "SwapArmor"}),
    (rf"\+ ?{NUM} pv", lambda m: {"type": "BoostLife", "amount": num(m.group(1))}),
    # --- range ---
    (rf"augmente de {NUM} (?:la )?port[ée]e", lambda m: {"type": "BoostRange", "amount": num(m.group(1))}),
    (rf"augmente.* port[ée]e.* de {NUM}", lambda m: {"type": "BoostRange", "amount": num(m.group(1))}),
    (rf"diminue de {NUM} (?:la )?port[ée]e", lambda m: {"type": "BoostRange", "amount": -num_int(m.group(1))}),
    (r"supprime.* port[ée]e", lambda m: {"type": "SetRange", "min": 0, "max": 0}),
    # --- movement / charge ---
    (rf"charge[zr]?.* (?:de|sur) {NUM} cases?", lambda m: {"type": "Charge", "cells": num(m.group(1))}),
    (rf"chargent de {NUM} cases?", lambda m: {"type": "ChargeAllies", "cells": num(m.group(1))}),
    (r"charge.* jusqu'au dofus", lambda m: {"type": "Charge", "cells": "toWall"}),
    (r"d[ée]clenche une attaque", lambda m: {"type": "TriggerAttack"}),
    (rf"passe.* [àa] (\d+) les pm", lambda m: {"type": "SetMovement", "value": int(m.group(1))}),
    # --- cost ---
    (rf"r[ée]duit de {NUM} pa le co[ûu]t", lambda m: {"type": "AddCostModifier", "amount": -num_int(m.group(1))}),
    (rf"co[ûu]tent {NUM} pa de moins", lambda m: {"type": "AddCostModifier", "amount": -num_int(m.group(1))}),
    (r"co[ûu]tent 0 pa", lambda m: {"type": "SetCostModifier", "value": 0}),
    # --- PA reserve (Xelor / Enutrof) ---
    (r"vole.* pa de la r[ée]serve advers", lambda m: {"type": "StealReserve"}),
    (r"transf[èe]re.* pa.* r[ée]serve", lambda m: {"type": "TransferApToReserve"}),
    (r"d[ée]pense.* r[ée]serve.* double", lambda m: {"type": "SpendReserveDouble"}),
    (rf"(\d+) pa.* r[ée]serve", lambda m, c: {"type": "AddReserve", "amount": int(m.group(1)), "side": ("enemy" if "advers" in c else "caster")}),
    # --- board / misc ---
    (r"d[ée]tru(?:it|isez|ire)", lambda m: {"type": "Destroy"}),
    (rf"t[ée]l[ée]porte[zr]?.* de {NUM} cases?", lambda m: {"type": "Teleport", "cells": num(m.group(1))}),
    (r"t[ée]l[ée]porte", lambda m: {"type": "Teleport"}),
    (r"repouss", lambda m: {"type": "Push"}),
    (r"silence", lambda m: {"type": "Silence"}),
    (r"change(?:r)? de ligne", lambda m: {"type": "ChangeRow"}),
    (r"votre tour se termine", lambda m: {"type": "EndTurn"}),
    (r"prenez le contr[ôo]le", lambda m: {"type": "TakeControl"}),
    (r"(?:fait .* apparaitre|r[ée]apparaitre).* prismes", lambda m: {"type": "RespawnPrisms"}),
    (rf"posez? {NUM} (.+?) (?:alli[ée]s? )?dans", lambda m: {"type": "SummonToken", "amount": num(m.group(1)), "token": m.group(2).strip()}),
    # "Invoque des Lapinos sur vos cases de départ" → token = the noun right
    # after the quantifier (des/un/2/…), not the greedy tail. `amount` is left
    # to the merge (it caps at the free start cells for the "des" / fill case).
    (r"invoque(?:nt)?(?: des| de| d'| un| une| deux| trois| \d+)+ (.+?)(?: sur| dans| autour|\.|$)", lambda m: {"type": "SummonToken", "token": m.group(1).strip()}),
    (r"transforme.* en (.+?)(?:\.|$)", lambda m: {"type": "Transform", "into": m.group(1).strip()}),
    # "Confère vulnérabilité : N", a flat +N damage-taken debuff (valued).
    # Must come before the generic "confère <kw>" rule below.
    (r"vuln[ée]rabilit[ée]\D*(\d+)", lambda m: {"type": "Vulnerability", "amount": num_int(m.group(1))}),
    # Property grants the engine honours. Scoped ("à vos invocations") first,
    # then the single-target form. "puis"/conditional combos are rejected by the
    # merge's single-target check.
    (rf"(?:donne|donnez|conf[èe]re)\s+(?:un |une )?{PROP_RE}\b[^.]*vos invocations", lambda m: {"type": "SetProperty", "property": PROP_GRANT[m.group(1)], "scope": "allies"}),
    (rf"(?:donne|donnez|conf[èe]re)\s+(?:un |une )?{PROP_RE}\b", lambda m: {"type": "SetProperty", "property": PROP_GRANT[m.group(1)]}),
]

def num_int(s):
    try: return int(s)
    except Exception: return 1

def parse_description(desc):
    d = clean(desc).lower().replace("’", "'")
    # Heure de Gloire: "Dépense vos PA restants pour donner à une invocation +N
    # AT et +N AR par PA utilisé." This pattern is matched on the whole
    # description, because the per-clause split below would read it as a flat
    # +1 AT / +1 AR. The amount depends on the AP spent and the AP is consumed,
    # both handled by the engine; here we only record which stats it buffs.
    if re.search(r"d[ée]pense[^.]*\bpa\b[^.]*par[^.]*\bpa\b", d):
        stats = []
        if re.search(r"\bat\b", d): stats.append("attack")
        if re.search(r"\bar\b", d): stats.append("armor")
        if stats:
            return [{"type": "SpendApAsBuff", "stats": stats}]
    # split into clauses so a rule only sees its own numbers
    clauses = re.split(r"\bet\b|,|\.|/| ou ", d)
    found = []
    for clause in clauses:
        clause = clause.strip()
        if not clause: continue
        for entry in RULES:
            pat, build = entry
            m = re.search(pat, clause)
            if not m: continue
            try:
                e = build(m, clause) if build.__code__.co_argcount == 2 else build(m)
                found.append(e)
            except Exception:
                pass
            break  # one effect per clause
    seen = set(); uniq = []
    for e in found:
        k = json.dumps(e, sort_keys=True, ensure_ascii=False)
        if k not in seen: seen.add(k); uniq.append(e)
    return uniq

def bindata_effects_with_triggers(c):
    """Attach the card's flat effects to a trigger when one exists, else ON_CAST."""
    effs = c.get("effects") or []
    trigs = c.get("triggers") or []
    when = "ON_CAST"
    if trigs:
        when = trigs[0].get("trigger", "ON_CAST")
    out = []
    for e in effs:
        row = {"when": when}
        row.update({k: v for k, v in e.items()})
        out.append(row)
    return out

# Effect types written by the merge (authored from descriptions). They are not
# real bindata: merge_authored_effects.py writes them back into the card files.
# Treating them as bindata here would copy the resolved form (e.g. Transform
# tokenId) into the spec and lose the original name the merge needs, and the
# pipeline would stop being idempotent. So a card whose effects are all
# authored types is parsed again from its description.
AUTHORED_TYPES = {
    "Heal", "Destroy", "BoostAttack", "BoostArmor", "Charge", "SetMovement",
    "SetAttack", "DrawCards", "DrawUpTo", "EndTurn", "Teleport", "TakeControl",
    "ReturnToHand", "ReturnToDeck", "Silence", "TriggerAttack", "BoostRange",
    "RespawnPrisms", "AddCostModifier", "SwapAttack", "SwapArmor", "ChangeRow",
    "SwapPosition", "HealFull", "SetLife", "SetRange", "MultiplyAttack",
    "AddReserve", "TransferApToReserve", "StealReserve", "SpendReserveDouble",
    "Transform", "SummonToken", "AddCardToHand", "Vulnerability",
    "BoostMovement", "ChiefAura", "AoeDamage", "TutorFromDeck",
}

# --- Trigger-block parsing -------------------------------------------------
# A triggered summon's description is a sequence of "HEADER : body" blocks
# (APPARITION : ... MORT : ...). We split on the headers and parse each body
# in its own trigger context. For now we only write self effects ("Gagne +N AT",
# "Se soigne de N PV", "S'inflige N dégâts"): they apply to the source creature
# with no targeting question, so they are always faithful. Blocks with dynamic
# values (1d6 / @x@ / "autant") or conditions (si / ou / autre / family) are
# skipped for now.
TRIGGER_HEADERS = [
    (r"APPARITION", "APPARITION"),
    (r"MORT", "MORT"),
    (r"COUP DE GR[ÂA]CE", "COUP_DE_GRACE"),
    (r"CONTRE[ -]?COUP", "CONTRE_COUP"),
    (r"FIN DE TOUR", "FIN_DE_TOUR"),
    (r"D[ÉE]BUT DE TOUR", "DEBUT_DE_TOUR"),
    (r"RALLIEMENT", "RALLIEMENT"),
]
TRIG_DYNAMIC = ("1d6", "d6", "@", "autant", "moiti")
TRIG_CONDITIONAL = (" si ", " ou ", " pour ", " par ", "autre", "ayant", "tous", "toutes", "vos ",
                    "chaque", "famille", "membre", "rangée", "rangee", "ligne", "aux invocation",
                    "premièr", "premier", "dernièr", "dernier", "devant", "derrière", "derriere")
# Verbs / nouns for actions we do not author as trigger effects yet. If a block
# mentions any, we skip the whole block rather than author a partial (and thus
# misleading) subset of what the card actually does.
TRIG_UNMODELLED = (
    "invoque", "place", "transforme", "détruis", "detruis", "pioche", "prisme",
    "dofus", "glyphe", "repousse", "déplace", "deplace", "échange", "echange",
    "résistance", "resistance", "portée", "portee",
    "provocation", "remonte", "remontez", "charge", "vol", "tas d'os",
)
# A number that may be prefixed by "+" / spaces, and is not part of a dice
# expression (so "1d6" never half-matches as "1" or "6"). `SEP` bridges the
# verb and the number ("gagne +1 at", "soigne de 2 pv", …).
DNUM = r"(?<![d\d])(\d+)(?![d\d])"
SEP = r".*?\+?\s*"
TRIGGER_SELF_RULES = [
    (rf"gagne{SEP}{DNUM}\s*at\b", lambda m: {"type": "BoostAttackData", "Boost": int(m.group(1))}),
    (rf"gagne{SEP}{DNUM}\s*pv\b", lambda m: {"type": "BoostLifeData", "Boost": int(m.group(1))}),
    (rf"se soigne{SEP}{DNUM}\s*pv", lambda m: {"type": "HealSelfData", "Heal": int(m.group(1))}),
    (rf"regagne{SEP}{DNUM}\s*pv", lambda m: {"type": "HealSelfData", "Heal": int(m.group(1))}),
    (rf"s'inflige{SEP}{DNUM}\s*d[ée]g[âa]ts?", lambda m: {"type": "SelfDamageData", "Damage": int(m.group(1))}),
    (rf"gagne\w*\s+(?:un |une )?{PROP_RE}\b", lambda m: {"type": "SetProperty", "property": PROP_GRANT[m.group(1)], "self": True}),
]
# Targeted trigger effects: the block names a creature ("... à une invocation"),
# so the player picks one when the trigger fires (the engine's pendingAction
# path). They use the managed authored types, which applyEffects runs the same
# way as for spells.
# In a block that already names "une invocation", the picked creature gets
# every buff clause, including bare "+1 AR" / "soignée de 2 PV" fragments left
# by the clause split. The engine applies all pending target effects to the
# chosen creature, so "Donnez +1 AT et +1 AR à une invocation" is faithful as
# long as both clauses are captured.
TRIGGER_TARGET_RULES = [
    (rf"\+?\s*{DNUM}\s*ar\b", lambda m: {"type": "BoostArmor", "amount": int(m.group(1))}),
    (rf"\+?\s*{DNUM}\s*at\b", lambda m: {"type": "BoostAttack", "amount": int(m.group(1))}),
    (rf"\+?\s*{DNUM}\s*pm\b", lambda m: {"type": "BoostMovement", "amount": int(m.group(1))}),
    (rf"soign\w*{SEP}{DNUM}\s*pv", lambda m: {"type": "Heal", "amount": int(m.group(1))}),
    (rf"inflige[zr]?{SEP}{DNUM}\s*d[ée]g[âa]t", lambda m: {"type": "DamageData", "Damage": int(m.group(1))}),
    (rf"(?:donne|donnez|conf[èe]re)\s+(?:un |une )?{PROP_RE}\b", lambda m: {"type": "SetProperty", "property": PROP_GRANT[m.group(1)]}),
]
# Player-state trigger clauses (touch hand / deck, not a board creature). They
# do not need the "à une invocation" gate. AddCardToHand keeps the card name for
# the merge to resolve to an id (skips the card if it cannot).
TRIGGER_PLAYER_RULES = [
    (rf"pioche[zr]?\s+{DNUM}\s+carte", lambda m: {"type": "DrawCards", "amount": int(m.group(1))}),
    (rf"ajoute[zr]?\s+{DNUM}\s+(.+?)\s+[àa]\s+(?:votre|la)\s+main", lambda m: {"type": "AddCardToHand", "amount": int(m.group(1)), "card": m.group(2).strip()}),
    (rf"ajoute[zr]?\s+une?\s+(.+?)\s+[àa]\s+(?:votre|la)\s+main", lambda m: {"type": "AddCardToHand", "amount": 1, "card": m.group(1).strip()}),
    # "Place dans votre main la dernière invocation partie dans votre défausse"
    # (Prince Belimberbe) → recover the most-recent Summon from the discard.
    (r"place[zr]?\s+dans\s+(?:votre|la)\s+main\s+la\s+derni[èe]re?\s+invocation\b.*\bd[ée]fausse",
     lambda m: {"type": "RecoverFromDiscard", "summon": True, "which": "last"}),
]

def _aoe_damage(low):
    """A concrete area-damage burst: 'inflige N dégâts aux invocations
    (adverses) (autour de lui / de sa ligne)'. Returns the effect dict, or None
    if it is not a clean, modellable AoE-damage block. Centered on the source."""
    m = re.search(r"inflige[zr]?\s+(\d+)\s+d[ée]g[âa]t\w*\s+(?:aux|à toutes les|a toutes les)\s+invocation", low)
    if not m:
        return None
    # Dynamic value, conditional rider, or a territory restriction we cannot map
    # to around/row → skip (territory "camp", "ou", "si", "pour", "par", dice).
    if any(k in low for k in ("1d6", "d6", "@", "autant", "moiti", " ou ", " si ", " pour ", " par ", "camp")):
        return None
    # A second action in the same block → cannot author faithfully.
    if any(v in low for v in ("invoque", "pioche", "transforme", "détru", "detru",
                              "place ", "remonte", "soigne", "gagne", "ajoute", "vol")):
        return None
    amount = int(m.group(1))
    if "advers" in low or "ennemi" in low:
        scope = "enemies"
    elif "alli" in low:
        scope = "allies"
    else:
        scope = "all"
    if "autour" in low:
        shape = "around"
    elif "sa ligne" in low or "sa rangée" in low or "sa rangee" in low:
        shape = "row"
    elif "ligne" in low or "rangée" in low or "rangee" in low:
        return None  # an ambiguous / non-self line → not modellable
    else:
        shape = None
    eff = {"type": "AoeDamage", "amount": amount, "scope": scope}
    if shape:
        eff["shape"] = shape
    return eff

def _draw_filtered(low):
    """'Piochez N cartes. Si ce n'est pas une invocation/sort elle est
    défaussée' (Abigaël) → draw N, keep only the matching type."""
    m = re.search(r"pioche[zr]?\s+(\d+)\s+carte", low)
    if not m or "défauss" not in low and "defauss" not in low:
        return None
    if "1d6" in low or "@" in low:
        return None
    if "n'est pas une invocation" in low or "pas une invocation" in low:
        keep = "summon"
    elif "n'est pas un sort" in low or "pas un sort" in low:
        keep = "spell"
    else:
        return None
    return {"type": "DrawFiltered", "amount": int(m.group(1)), "keep": keep}

def _transform_all(low):
    """'Transforme les autres / vos invocations en X' (Marcassin Or) → a mass
    transform. Keeps the raw token name + family for the merge to resolve."""
    m = re.search(r"transforme\w*\s+(les|vos)\s+(autres\s+)?(\w+)\s+en\s+(.+?)(?:\.|,|$)", low)
    if not m:
        return None
    if any(k in low for k in ("1d6", "@", " si ", " ou ", " par ", "pour")):
        return None
    which, autres, fam, into = m.group(1), m.group(2), m.group(3), m.group(4).strip()
    eff = {"type": "TransformAll", "into": into}
    if which == "vos":
        eff["scope"] = "allies"
        if autres:
            eff["excludeSelf"] = True
    else:  # "les autres invocations", every other creature, both sides
        eff["scope"] = "all"
        eff["excludeSelf"] = True
    if fam not in ("invocation", "invocations", "créature", "creature", "créatures", "creatures"):
        eff["familyRaw"] = fam
    return eff

def _charge_allies(low):
    """'Vos (autres) invocations/X chargent de N cases' → scoped charge. Keeps a
    raw family word for the merge to resolve; excludeSelf for 'autres'."""
    m = re.search(r"vos\s+(autres\s+)?(\w+)\s+chargent\s+de\s+(\d+)", low)
    if not m:
        return None
    # Reject dynamic / conditional / "reculent" choice, and blocks that also do
    # an action we do not model (invoke / transform / …), no partial cards.
    if any(k in low for k in ("1d6", "@", " si ", " ou ", " par ", "reculent",
                              "invoque", "place ", "transforme", "détru", "detru",
                              "pioche", "chaque")):
        return None
    eff = {"type": "ChargeAllies", "cells": int(m.group(3))}
    if m.group(1):
        eff["excludeSelf"] = True
    fam = m.group(2)
    if fam not in ("invocation", "invocations", "créature", "creature"):
        eff["familyRaw"] = fam
    return eff

def _summon_token(low):
    """A trigger token-summon: 'Invoque N X (à côté de lui)'. Returns the effect
    (with the token name for the merge to resolve) or None. Placement is always
    "near" the source; special placements (sur chaque case / dans votre camp)
    and non-creature tokens (glyphe / prisme / dofus) are skipped."""
    m = re.search(r"invoque[zr]?\s+(un|une|deux|\d+)\s+(.+?)(?:\s+(?:à côté|a côté|près|devant|derrière|dans|sur)\b|\.|,|$)", low)
    if not m:
        return None
    if any(k in low for k in ("1d6", "@", "autant", " si ", " ou ", " par ", "chaque",
                              "camp", "glyphe", "prisme", "dofus", "bombe")):
        return None
    amount = {"un": 1, "une": 1, "deux": 2}.get(m.group(1))
    if amount is None:
        try:
            amount = int(m.group(1))
        except ValueError:
            return None
    name = m.group(2).strip()
    if not name:
        return None
    return {"type": "SummonToken", "amount": amount, "token": name, "placement": "near"}

def _tutor(low):
    """'Place dans votre main le prochain/dernier X de votre pioche', fetch a
    card matching a filter from the deck. Returns {type, from, amount, filter}
    with the raw filter phrase (the merge maps it to a family / type or skips)."""
    m = re.search(
        r"place\w*\s+(?:dans votre main\s+)?(?:le|la|les|l'|l’)\s*(\d+)?\s*"
        r"(prochaine?s?|premi[èe]re?s?|derni[èe]re?s?)\s+(.+?)\s+de votre pioche", low)
    if not m:
        return None
    if any(k in low for k in ("1d6", "@", "autant", " si ", " ou ")):
        return None
    amount = int(m.group(1)) if m.group(1) else 1
    frm = "bottom" if m.group(2).startswith("derni") else "top"
    eff = {"type": "TutorFromDeck", "from": frm, "amount": amount, "filter": m.group(3).strip()}
    # "… il coûte N PA de moins" (Jahash), discount the tutored card in hand.
    cm = re.search(r"co[ûu]te[nt]?\s+(\d+)\s*pa\s+de\s+moins", low)
    if cm:
        eff["costMod"] = -int(cm.group(1))
    return eff

def _family_buff(low):
    """'Donne +N AT/AR à vos autres <X>' / 'Vos autres <X> gagnent +N AT et +N
    AR', a side-wide buff narrowed to a family and excluding the source. Returns
    a list of stat effects (with the raw family word for the merge), or None.
    Multi-family ('vos Chachas ET vos autres Ecaflips') and +PM (no add-movement
    effect yet) are skipped."""
    if " et vos " in low or any(k in low for k in (
            "1d6", "@", "autant", " si ", " ou ", " par ", " pour ",
            "sacrifi", "détruis", "detruis", "tas d'os")):
        return None  # dynamic / conditional / cost-gated → not a flat buff
    m = re.search(r"donne\w*\s+(.+?)\s+(?:à|a)\s+vos\s+(autres\s+)?(\w+)", low)
    if m:
        stat_part, excl, fam = m.group(1), bool(m.group(2)), m.group(3)
    else:
        m = re.search(r"vos\s+(autres\s+)?(\w+)\s+gagnent\s+(.+)", low)
        if not m:
            return None
        excl, fam, stat_part = bool(m.group(1)), m.group(2), m.group(3)
    STAT_T = {"at": "BoostAttack", "ar": "BoostArmor", "pm": "BoostMovement"}
    effs = []
    for amt, stat in re.findall(r"\+?\s*(\d+)\s*(at|ar|pm)\b", stat_part):
        effs.append({
            "type": STAT_T[stat],
            "amount": int(amt), "scope": "allies", "excludeSelf": excl,
        })
    if not effs:
        return None
    if fam not in ("invocation", "invocations", "créature", "creature", "créatures", "creatures"):
        for e in effs:
            e["familyRaw"] = fam
    return effs

def _targeted_damage(low):
    """Bare imperative damage: 'Infligez N dégât(s)' with no AoE / positional /
    dynamic qualifier, the player picks a creature (Black Wabbit). The '… à une
    invocation' phrasing is also fine here (still a single pick). Returns a
    DamageData, or None."""
    m = re.search(r"\binfligez\s+(\d+)\s+d[ée]g[âa]t", low)
    if not m:
        return None
    if any(k in low for k in ("1d6", "@", "autant", "aux invocation", "à toutes",
                              "a toutes", "autour", "ligne", "rangée", "rangee",
                              "première", "premier", "dernièr", "dernier", "devant",
                              "derrière", "derriere", " si ", " ou ", " par ",
                              "camp", "dofus", "prisme", "glyphe")):
        return None
    return {"type": "DamageData", "Damage": int(m.group(1))}

def parse_triggered(desc):
    """Split a triggered description into (trigger-type → effects) and parse
    each block with the self rules. Returns a flat list of {when, ...effect}."""
    d = clean(desc)
    U = d.upper()
    hits = []
    for pat, ttype in TRIGGER_HEADERS:
        for m in re.finditer(pat, U):
            hits.append((m.start(), m.end(), ttype))
    hits.sort()
    out = []
    for i, (s, e, ttype) in enumerate(hits):
        end = hits[i + 1][0] if i + 1 < len(hits) else len(d)
        body = re.sub(r"^[\s:_·-]+", "", d[e:end]).strip()
        low = " " + body.lower() + " "
        # AoE-damage special case first (it legitimately says "aux invocations"
        # / "de sa ligne", which the generic reject below would drop).
        aoe = _aoe_damage(low)
        if aoe is not None:
            out.append({"when": ttype, **aoe})
            continue
        tdmg = _targeted_damage(low)
        if tdmg is not None:
            out.append({"when": ttype, **tdmg})
            continue
        df = _draw_filtered(low)
        if df is not None:
            out.append({"when": ttype, **df})
            continue
        chg = _charge_allies(low)
        if chg is not None:
            out.append({"when": ttype, **chg})
            continue
        txa = _transform_all(low)
        if txa is not None:
            out.append({"when": ttype, **txa})
            continue
        tok = _summon_token(low)
        if tok is not None:
            out.append({"when": ttype, **tok})
            continue
        tut = _tutor(low)
        if tut is not None:
            out.append({"when": ttype, **tut})
            continue
        fb = _family_buff(low)
        if fb is not None:
            out.extend({"when": ttype, **e} for e in fb)
            continue
        # Self-transform ("Se transforme en X"). Excluded on MORT, where the
        # creature is already dying and handleTransform (needs life > 0) cannot
        # act, that is a resurrection we do not model yet.
        if ttype != "MORT":
            mt = re.search(r"se transforme en (.+?)(?:\s+\d+\s*/\s*\d+|\.|,|$)", low)
            if mt and not any(k in low for k in ("1d6", "@", "autant", " si ", " ou ", " par ")):
                out.append({"when": ttype, "type": "Transform", "into": mt.group(1).strip(), "self": True})
                continue
        if any(k in low for k in TRIG_DYNAMIC + TRIG_CONDITIONAL + TRIG_UNMODELLED):
            continue  # not faithfully modellable yet
        targeted = "invocation" in low  # "… à une invocation" → needs a pick
        for clause in re.split(r"\bet\b|,|\.|/| ou ", body.lower()):
            clause = clause.strip()
            if not clause:
                continue
            matched = False
            for pat, build in TRIGGER_SELF_RULES + TRIGGER_PLAYER_RULES:
                m = re.search(pat, clause)
                if m:
                    out.append({"when": ttype, **build(m)}); matched = True; break
            if matched or not targeted:
                continue
            for pat, build in TRIGGER_TARGET_RULES:
                m = re.search(pat, clause)
                if m:
                    out.append({"when": ttype, **build(m)}); break
    # de-dup
    seen = set(); uniq = []
    for e in out:
        k = json.dumps(e, sort_keys=True)
        if k not in seen:
            seen.add(k); uniq.append(e)
    return uniq

spec = []
for cid, c in allc.items():
    # Real bindata = effects that are not merge-authored. Authored-only cards
    # fall through to the description parser so their source names survive.
    real_effs = [e for e in (c.get("effects") or []) if e.get("type") not in AUTHORED_TYPES]
    has_eff = bool(real_effs)
    has_trig = bool(c.get("triggers"))
    is_spell = c["cardType"] in ("Spell", "Aoe")
    if not (has_eff or has_trig or is_spell):
        continue  # vanilla summon, no logic
    row = {
        "id": cid, "name": c["name"], "god": c.get("god"), "type": c["cardType"],
        "cost": c.get("cost"), "target": c.get("castTarget"),
        "secondaryCost": secondary_cost(cid),
        "description": clean(c.get("description", "")),
    }
    # Trigger effects are authored straight from the description's trigger
    # blocks, independent of whether the card also has bindata flat effects.
    # (Many bindata summons keep their APPARITION action in flat effects[] with
    # an empty trigger slot, so it never fires, populating trigger_effects
    # faithfully fixes that.) The merge reads this field, never `effects`.
    if has_trig:
        row["trigger_effects"] = parse_triggered(c.get("description", ""))
    if has_eff:
        row["source"] = "bindata"; row["status"] = "extracted"
        row["effects"] = bindata_effects_with_triggers(c)
    elif has_trig:
        # Triggered summon (APPARITION / MORT / …) with no bindata: author each
        # trigger block's self effects, tagged with its trigger type.
        drafted = parse_triggered(c.get("description", ""))
        row["source"] = "description"
        row["effects"] = drafted
        row["status"] = "drafted" if drafted else "manual"
    else:
        drafted = parse_description(c.get("description", ""))
        row["source"] = "description"
        row["effects"] = [{"when": "ON_CAST", **e} for e in drafted]
        row["status"] = "drafted" if drafted else "manual"
    spec.append(row)

spec.sort(key=lambda r: (r["status"] != "manual", r["god"] or "", r["id"]))

(ROOT / "notes/card_effects_spec.json").write_text(
    json.dumps(spec, ensure_ascii=False, indent=1), encoding="utf-8")

# stats
from collections import Counter
st = Counter(r["status"] for r in spec)
typ = Counter(e.get("type") for r in spec for e in r["effects"])
print(f"total effect-bearing cards: {len(spec)}")
print(f"  extracted (bindata): {st['extracted']}")
print(f"  drafted from desc:   {st['drafted']}")
print(f"  MANUAL needed:       {st['manual']}")
print("\neffect-type vocabulary surfaced:")
for k, v in typ.most_common():
    print(f"  {v:4d}  {k}")

# markdown review doc
md = ["# Card effects spec sheet (Plan 1 — for review)\n",
      f"- extracted (bindata, faithful): **{st['extracted']}**",
      f"- drafted from description (review!): **{st['drafted']}**",
      f"- manual authoring needed: **{st['manual']}**\n"]
for status in ("manual", "drafted", "extracted"):
    md.append(f"\n## {status}\n")
    for r in [x for x in spec if x["status"] == status]:
        effs = "; ".join(
            e["type"] + ("(" + json.dumps({k: v for k, v in e.items() if k not in ("when", "type")}, ensure_ascii=False) + ")" if len(e) > 2 else "")
            for e in r["effects"]) or "—"
        sc = f" [coût2: {','.join(r['secondaryCost'])}]" if r["secondaryCost"] else ""
        md.append(f"- **#{r['id']} {r['name']}** ({r['god']}/{r['type']}, {r['cost']}PA, →{r['target']}){sc}")
        md.append(f"    - _{r['description'][:120]}_")
        md.append(f"    - effets: {effs}")
(ROOT / "notes/card_effects_spec.md").write_text("\n".join(md), encoding="utf-8")
print("\nwrote notes/card_effects_spec.json + notes/card_effects_spec.md")
