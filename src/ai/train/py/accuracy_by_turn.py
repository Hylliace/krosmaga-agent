"""Does the position predict the outcome, and from which turn on?

One view of this game is that a position barely decides the win: victory comes
from attrition, and how you play your cards is what matters. That can be tested:
value5's accuracy per turn bucket over the 95k encoded positions. A flat ~55%
until late would support it (and point to a policy net); a rise early on means the
positional signal exists and the value net just needs to read it better.

  python src/ai/train/py/accuracy_by_turn.py --in "data/enc_v6/*" --manifest data/models/value5.manifest.json --pt data/models/value5.pt
"""
import argparse
import json

import numpy as np
import torch

from data import discover_prefixes, load_shards, PLANE_SIZE
from model import ValueNet

TURN_GLOBAL_IDX = 14  # index of "turn" in GLOBALS3 (value = state.turn / 30)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--pt", required=True)
    ap.add_argument("--batch", type=int, default=4096)
    args = ap.parse_args()

    man = json.load(open(args.manifest, encoding="utf-8"))
    data = load_shards(discover_prefixes(args.inp))
    model = ValueNet(man["enc_len"], man["vocab_size"], channels=man["channels"], blocks=man["blocks"],
                     n_planes=data.n_planes, n_globals=data.n_globals, n_v=data.n_v)
    model.load_state_dict(torch.load(args.pt, map_location="cpu"))
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    model.to(dev).eval()

    # data.x is a lazy multi-shard view: gather via integer-index batches only.
    g_base = data.n_planes * PLANE_SIZE
    n = len(data.y)
    turns = np.empty(n, dtype=int)
    preds = np.empty(n, dtype=np.float32)
    with torch.no_grad():
        for i in range(0, n, args.batch):
            idx = np.arange(i, min(i + args.batch, n))
            xb_np = data.x[idx]
            turns[idx] = np.rint(xb_np[:, g_base + TURN_GLOBAL_IDX] * 30).astype(int)
            xb = torch.from_numpy(xb_np).to(dev)
            preds[idx] = model(xb).squeeze(-1).float().cpu().numpy()

    y01 = (data.y > 0).astype(np.float32)   # win for side-to-move
    p01 = (preds + 1) / 2                    # model output (-1,1) -> probability
    correct = ((preds > 0) == (data.y > 0)).astype(np.float32)

    print(f"rows={len(data.y)}  global acc={correct.mean()*100:.1f}%  brier={np.mean((p01-y01)**2):.4f}")
    print(f"{'tours':>8} | {'n':>6} | {'acc':>6} | {'brier':>6} | {'p moyen (ecart au 50/50)':>26}")
    buckets = [(1, 3), (4, 6), (7, 9), (10, 12), (13, 15), (16, 18), (19, 22), (23, 27), (28, 60)]
    for lo, hi in buckets:
        m = (turns >= lo) & (turns <= hi)
        if m.sum() == 0:
            continue
        spread = np.abs(p01[m] - 0.5).mean()
        print(f"{lo:>4}-{hi:<3} | {int(m.sum()):>6} | {correct[m].mean()*100:>5.1f}% | {np.mean((p01[m]-y01[m])**2):.4f} | +/-{spread*100:>4.1f} pts")


if __name__ == "__main__":
    main()
