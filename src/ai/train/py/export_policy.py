"""Export a trained PolicyNet to the portable TS format (like export.py, with two
heads). Writes <out>.weights.f32 / .manifest.json / .ref.json (what/where logits
used as the reference by the TS parity test)."""
from __future__ import annotations

import argparse
import json

import numpy as np
import torch

from policy_model import PolicyNet
from policy_data import load_policy_shards
from data import discover_prefixes


def export_policy(model: PolicyNet, out: str, ref_inputs: np.ndarray):
    model.eval()
    tensors, blobs, offset = [], [], 0
    for key, t in model.state_dict().items():
        if "num_batches_tracked" in key:
            continue
        arr = t.detach().cpu().numpy().astype("<f4").ravel()
        tensors.append({"key": key, "shape": list(t.shape), "offset": offset, "count": int(arr.size)})
        blobs.append(arr); offset += arr.size
    np.concatenate(blobs).tofile(out + ".weights.f32")
    json.dump({
        "schema": "policynet-ts-v1", "enc_len": model.enc_len, "vocab_size": model.vocab_size,
        "v_len": model.v_len, "channels": model.stem[0].out_channels, "blocks": len(model.tower),
        "bn_eps": 1e-5, "what_size": model.what_size, "where_size": model.where_size, "tensors": tensors,
    }, open(out + ".manifest.json", "w", encoding="utf-8"))
    with torch.no_grad():
        lw, lp = model(torch.from_numpy(ref_inputs.astype("<f4")))
    json.dump({
        "inputs": ref_inputs.astype(float).tolist(),
        "what_logits": lw.cpu().numpy().astype(float).tolist(),
        "where_logits": lp.cpu().numpy().astype(float).tolist(),
    }, open(out + ".ref.json", "w", encoding="utf-8"))
    print(f"exported {len(tensors)} tensors + {ref_inputs.shape[0]} ref pairs -> {out}.*")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pt", required=True)
    ap.add_argument("--manifest", help="policy.json (arch); defaults to <pt>.json sibling")
    ap.add_argument("--out", required=True)
    ap.add_argument("--ref-from", required=True)
    ap.add_argument("--ref-rows", type=int, default=16)
    args = ap.parse_args()

    man = json.load(open(args.manifest or args.pt.replace(".pt", ".json"), encoding="utf-8"))
    model = PolicyNet(man["enc_len"], man["vocab_size"], man["what_size"], man["where_size"],
                      channels=man.get("channels", 48), blocks=man.get("blocks", 2))
    model.load_state_dict(torch.load(args.pt, map_location="cpu"))
    d = load_policy_shards(discover_prefixes(args.ref_from))
    idx = np.random.default_rng(0).choice(len(d.z), size=args.ref_rows, replace=False)
    export_policy(model, args.out, np.asarray(d.x[idx]))


if __name__ == "__main__":
    main()
