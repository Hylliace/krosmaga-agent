"""Train the policy net on the genPolicyData shards.

  python src/ai/train/py/train_policy.py --in "data/policy/games.*" --out data/models/policy --device cuda

Loss = soft cross-entropy of the (what, where) heads against the MCTS visit
marginals (not weighted). Metrics: top-1 agreement (argmax logits == argmax
target) and the soft CE, on a held-out split by game. Exports <out>.pt + <out>.json.
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np
import torch
import torch.nn.functional as F

from policy_data import load_policy_shards, split_by_game
from data import discover_prefixes
from policy_model import PolicyNet, count_params


def soft_ce(logits, target):
    return -(target * F.log_softmax(logits, dim=1)).sum(dim=1).mean()


def evaluate(model, x, what, where, idx, device, batch=4096):
    model.eval()
    ce_w = ce_p = top_w = top_p = 0.0
    n = 0
    with torch.no_grad():
        for s in range(0, len(idx), batch):
            b = idx[s:s + batch]
            xb = torch.from_numpy(np.asarray(x[b])).to(device)
            tw = torch.from_numpy(what[b]).to(device)
            tp = torch.from_numpy(where[b]).to(device)
            lw, lp = model(xb)
            ce_w += soft_ce(lw, tw).item() * len(b)
            ce_p += soft_ce(lp, tp).item() * len(b)
            top_w += (lw.argmax(1) == tw.argmax(1)).sum().item()
            top_p += (lp.argmax(1) == tp.argmax(1)).sum().item()
            n += len(b)
    return ce_w / n, ce_p / n, top_w / n, top_p / n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", default="data/models/policy")
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch", type=int, default=1024)
    ap.add_argument("--lr", type=float, default=5e-4)
    ap.add_argument("--wd", type=float, default=3e-3)
    ap.add_argument("--dropout", type=float, default=0.4)
    ap.add_argument("--val", type=float, default=0.15)
    ap.add_argument("--patience", type=int, default=6)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    prefixes = discover_prefixes(args.inp)
    d = load_policy_shards(prefixes)
    print(f"shards {len(prefixes)} | rows {len(d.z)} | encLen {d.enc_len} | whatSize {d.what_size}")
    tr, va = split_by_game(d.game, args.val, seed=args.seed)
    print(f"train {len(tr)} / val {len(va)} (games {len(np.unique(d.game[tr]))}/{len(np.unique(d.game[va]))})")

    dev = args.device
    vocab_size = (d.enc_len - (50 * 43 + 91)) // 4
    model = PolicyNet(d.enc_len, vocab_size, d.what_size, d.where_size, dropout=args.dropout).to(dev)
    print(f"params {count_params(model):,} (vocab {vocab_size})")
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.wd)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)

    best = 1e9; best_ep = -1; stale = 0
    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    for ep in range(args.epochs):
        model.train()
        perm = np.random.default_rng(args.seed + ep).permutation(tr)
        tot = 0.0
        for s in range(0, len(perm), args.batch):
            b = perm[s:s + args.batch]
            xb = torch.from_numpy(np.asarray(d.x[b])).to(dev)
            tw = torch.from_numpy(d.what[b]).to(dev)
            tp = torch.from_numpy(d.where[b]).to(dev)
            lw, lp = model(xb)
            loss = soft_ce(lw, tw) + soft_ce(lp, tp)
            opt.zero_grad(); loss.backward(); opt.step()
            tot += loss.item() * len(b)
        sched.step()
        cw, cp, twacc, tpacc = evaluate(model, d.x, d.what, d.where, va, dev)
        vloss = cw + cp
        print(f"ep {ep:2d} | train {tot/len(tr):.4f} | val ce_what {cw:.4f} ce_where {cp:.4f} | top1 what {twacc*100:.1f}% where {tpacc*100:.1f}%")
        if vloss < best:
            best = vloss; best_ep = ep; stale = 0
            torch.save(model.state_dict(), args.out + ".pt")
        else:
            stale += 1
            if stale >= args.patience:
                print(f"early stop (best val ce {best:.4f} @ ep {best_ep})"); break

    cw, cp, twacc, tpacc = evaluate(model, d.x, d.what, d.where, va, dev)
    json.dump({
        "schema": "policynet-v1", "enc_len": d.enc_len, "vocab_size": vocab_size,
        "what_size": d.what_size, "where_size": d.where_size, "params": count_params(model),
        "rows": int(len(d.z)), "shards": prefixes,
        "val": {"ce_what": cw, "ce_where": cp, "top1_what": twacc, "top1_where": tpacc, "best_ep": best_ep},
        "hparams": {"lr": args.lr, "wd": args.wd, "dropout": args.dropout, "epochs": args.epochs},
    }, open(args.out + ".json", "w", encoding="utf-8"), indent=2)
    print(f"saved -> {args.out}.pt (best val ce {best:.4f} @ ep {best_ep})")


if __name__ == "__main__":
    main()
