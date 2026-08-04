"""Catalog all $type values and field names in the card JSON files.

This gives us the complete grammar of the card effect system:
- Every effect type (DamageData, HealData, SummonData, ...)
- Every value type (ConstIntegerValue, RandomIntegerValue, ...)
- Every trigger type if any (OnPlay, OnDeath, OnEndTurn, ...)
- Every target type
"""
import sys, json, re
from pathlib import Path
from collections import Counter, defaultdict
sys.stdout.reconfigure(encoding="utf-8")

from paths import NOTES, require

CARD_DIR = require(NOTES / "card_bindata", "card bindata dump")

types = Counter()
field_names_by_type = defaultdict(set)

def walk(obj, parent_type=None):
    if isinstance(obj, dict):
        t = obj.get("$type")
        if t:
            # strip the assembly suffix
            short_t = t.split(",")[0].strip()
            types[short_t] += 1
            parent_type = short_t
        for k, v in obj.items():
            if k != "$type" and parent_type:
                field_names_by_type[parent_type].add(k)
            walk(v, parent_type)
    elif isinstance(obj, list):
        for item in obj:
            walk(item, parent_type)

# Scan all card JSON files
files = sorted(CARD_DIR.glob("*.json"))
print(f"Scanning {len(files)} card JSON files...")
for f in files:
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
        walk(data)
    except Exception as e:
        print(f"  err {f.name}: {e}")

# Group types by category
print(f"\n=== {len(types)} distinct $type values found ===\n")

# Categorise types
categories = defaultdict(list)
for t, n in types.most_common():
    short = t.replace("com.ankama.omg.data.", "")
    # Categorise
    if short.endswith("CardData"):
        cat = "Card root"
    elif "Value" in short:
        cat = "Value providers (Const, Random, Conditional, ...)"
    elif "Data" in short and "Effect" not in short:
        cat = "Effect data"
    elif "Trigger" in short:
        cat = "Triggers"
    elif "Target" in short:
        cat = "Targets / selectors"
    elif "Condition" in short:
        cat = "Conditions"
    else:
        cat = "Other"
    categories[cat].append((short, n))

for cat, items in categories.items():
    print(f"\n--- {cat} ({len(items)}) ---")
    for short, n in items:
        print(f"  {short:50s}  {n:>5d}")

# For each effect-like type, show its fields (so we know the schema)
print(f"\n\n=== Schema (fields) for each effect type ===")
effect_types = [t for t in types if "Data" in t and not t.endswith("CardData") and "ConstInteger" not in t]
for t in sorted(effect_types):
    short = t.replace("com.ankama.omg.data.", "")
    fields = sorted(field_names_by_type.get(t, set()))
    if fields:
        print(f"  {short}:")
        for f in fields:
            print(f"      {f}")
