"""Analyze structure: categorize MonoBehaviours by their m_Script ref."""
import json
from collections import Counter, defaultdict

from paths import EXTRACTED, require

with open(require(EXTRACTED / "cards" / "all_cards.json", "raw card dump"), encoding="utf-8") as f:
    cards = json.load(f)

script_counts = Counter()
by_script = defaultdict(list)
for c in cards:
    script_pid = c.get("m_Script", {}).get("m_PathID", 0)
    script_counts[script_pid] += 1
    by_script[script_pid].append(c)

print(f"Total objects: {len(cards)}")
print(f"Distinct m_Script (= distinct MonoBehaviour types): {len(script_counts)}")
for spid, count in script_counts.most_common():
    print(f"  Script PathID {spid}: {count} objects")

for spid, items in by_script.items():
    print(f"\n=== Sample for Script {spid} ===")
    sample = items[0]
    for k, v in sample.items():
        v_str = str(v)[:80]
        print(f"  {k}: {v_str}")
