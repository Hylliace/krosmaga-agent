"""Train the value net on the encode2 f32 shards.

  python src/ai/train/py/train.py --in "data/enc/games.*" --out data/models/value \
         --epochs 30 --batch 1024 --device cuda

Loss = MSE(tanh, y∈{±1}), not weighted (the deck weight stays in the sampler).
Split by game. Reports Brier + ECE on held-out (weight=1). Exports:
  <out>.pt      torch state_dict
  <out>.json    arch manifest (enc_len, vocab_size, channels, blocks, metrics)
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np
import torch
from torch.utils.data import DataLoader, TensorDataset

from data import load_shards, discover_prefixes, split_by_game
from model import ValueNet, count_params


def brier_ece(p: np.ndarray, t: np.ndarray, bins: int = 15):
    """p = predicted P(win) in [0,1], t = target in {0,1}."""
    brier = float(np.mean((p - t) ** 2))
    edges = np.linspace(0, 1, bins + 1)
    ece = 0.0
    for i in range(bins):
        m = (p >= edges[i]) & (p < edges[i + 1] if i < bins - 1 else p <= edges[i + 1])
        if m.sum() == 0:
            continue
        ece += (m.sum() / len(p)) * abs(p[m].mean() - t[m].mean())
    acc = float(np.mean((p >= 0.5) == (t >= 0.5)))
    return brier, float(ece), acc


def evaluate(model, x, y, idx, device, batch=4096):
    model.eval()
    ps = []
    with torch.no_grad():
        for s in range(0, len(idx), batch):
            b = idx[s:s + batch]
            xb = torch.from_numpy(np.asarray(x[b])).to(device)
            v = model(xb).cpu().numpy()
            ps.append((v + 1) / 2)  # value(−1,1) → prob[0,1]
    p = np.concatenate(ps)
    t = (y[idx] + 1) / 2
    return brier_ece(p, t)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True, help="glob prefix, e.g. data/enc/games.*")
    ap.add_argument("--out", default="data/models/value")
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--batch", type=int, default=1024)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--wd", type=float, default=1e-4)
    ap.add_argument("--val", type=float, default=0.15)
    ap.add_argument("--channels", type=int, default=48)
    ap.add_argument("--blocks", type=int, default=2)
    ap.add_argument("--dropout", type=float, default=0.4)
    ap.add_argument("--patience", type=int, default=5, help="early-stop after N epochs w/o val-brier gain")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    prefixes = discover_prefixes(args.inp)
    data = load_shards(prefixes)
    print(f"shards {len(prefixes)} | rows {len(data.y)} | encLen {data.enc_len} | vocab {data.vocab_size}")
    tr, va = split_by_game(data.game, args.val, seed=args.seed)
    print(f"train {len(tr)} / val {len(va)} (games "
          f"{len(np.unique(data.game[tr]))}/{len(np.unique(data.game[va]))})")

    device = args.device
    model = ValueNet(data.enc_len, data.vocab_size, channels=args.channels, blocks=args.blocks, dropout=args.dropout,
                     n_planes=data.n_planes, n_globals=data.n_globals, n_v=data.n_v).to(device)
    print(f"params {count_params(model):,}")
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.wd)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)

    x_all = data.x  # (N, encLen) in-RAM float32
    y_t = torch.from_numpy(data.y)
    best_brier = 1.0
    best_ep = -1
    stale = 0
    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)

    for ep in range(args.epochs):
        model.train()
        perm = np.random.default_rng(args.seed + ep).permutation(tr)
        tot = 0.0
        for s in range(0, len(perm), args.batch):
            b = perm[s:s + args.batch]
            xb = torch.from_numpy(np.asarray(x_all[b])).to(device)
            yb = y_t[b].to(device)
            v = model(xb)
            loss = torch.mean((v - yb) ** 2)  # MSE, non-weighted
            opt.zero_grad(); loss.backward(); opt.step()
            tot += loss.item() * len(b)
        sched.step()
        vb, vece, vacc = evaluate(model, x_all, data.y, va, device)
        print(f"ep {ep:2d} | train mse {tot/len(tr):.4f} | val brier {vb:.4f} ece {vece:.4f} acc {vacc*100:.1f}%")
        if vb < best_brier:
            best_brier = vb; best_ep = ep; stale = 0
            torch.save(model.state_dict(), args.out + ".pt")
        else:
            stale += 1
            if stale >= args.patience:
                print(f"early stop: no val-brier gain for {args.patience} epochs (best {best_brier:.4f} @ ep {best_ep})")
                break

    tb, tece, tacc = evaluate(model, x_all, data.y, tr, device)
    vb, vece, vacc = evaluate(model, x_all, data.y, va, device)
    manifest = {
        "schema": "valuenet-v1", "enc_len": data.enc_len, "vocab_size": data.vocab_size,
        "n_planes": data.n_planes, "n_globals": data.n_globals, "n_v": data.n_v,
        "channels": args.channels, "blocks": args.blocks, "params": count_params(model),
        "rows": int(len(data.y)), "shards": prefixes,
        "train": {"brier": tb, "ece": tece, "acc": tacc},
        "val": {"brier": vb, "ece": vece, "acc": vacc, "best_brier": best_brier, "best_epoch": best_ep},
        "hparams": {"lr": args.lr, "wd": args.wd, "dropout": args.dropout, "batch": args.batch, "epochs": args.epochs},
    }
    with open(args.out + ".json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"saved -> {args.out}.pt (best val brier {best_brier:.4f})")


if __name__ == "__main__":
    main()
