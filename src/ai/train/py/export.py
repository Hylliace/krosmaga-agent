"""Export a trained ValueNet to a portable format the TS inference reads.

Writes three files at <out>:
  <out>.weights.f32   concatenated float32 tensors (manifest order)
  <out>.manifest.json arch + tensor table (key, shape, offset, count) + bn eps
  <out>.ref.json      a few (input, value) pairs from PyTorch, the reference for the TS parity test

  python src/ai/train/py/export.py --pt data/models/value.pt --out data/models/value \
         --ref-from "data/enc/games.0" --ref-rows 16

Inference uses BN in eval mode (running stats), reproduced as it is in TS, so no
BN folding is needed and parity is exact.
"""
from __future__ import annotations

import argparse
import json

import numpy as np
import torch

from model import ValueNet
from data import load_shard


def export_model(model: ValueNet, out: str, ref_inputs: np.ndarray):
    model.eval()
    sd = model.state_dict()
    tensors, blobs, offset = [], [], 0
    for key, t in sd.items():
        if "num_batches_tracked" in key:
            continue
        arr = t.detach().cpu().numpy().astype("<f4").ravel()
        tensors.append({"key": key, "shape": list(t.shape), "offset": offset, "count": int(arr.size)})
        blobs.append(arr)
        offset += arr.size
    flat = np.concatenate(blobs) if blobs else np.zeros(0, "<f4")
    flat.tofile(out + ".weights.f32")

    manifest = {
        "schema": "valuenet-ts-v1",
        "enc_len": model.enc_len,
        "vocab_size": model.vocab_size,
        "v_len": model.v_len,
        "n_planes": model.n_planes,
        "n_globals": model.n_globals,
        "n_v": model.n_v,
        "channels": model.stem[0].out_channels,
        "blocks": len(model.tower),
        "bn_eps": 1e-5,
        "tensors": tensors,
    }
    with open(out + ".manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f)

    with torch.no_grad():
        xi = torch.from_numpy(ref_inputs.astype("<f4"))
        outs = model(xi).cpu().numpy().astype(float).tolist()
        logits = model.logit(xi).cpu().numpy().astype(float).tolist()
    ref = {"inputs": ref_inputs.astype(float).tolist(), "values": outs, "logits": logits}
    with open(out + ".ref.json", "w", encoding="utf-8") as f:
        json.dump(ref, f)
    print(f"exported {len(tensors)} tensors ({flat.size} floats) + {len(outs)} ref pairs -> {out}.*")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pt", required=True)
    ap.add_argument("--manifest", help="value.json from training (for arch); defaults to <pt>.json sibling")
    ap.add_argument("--out", required=True)
    ap.add_argument("--ref-from", required=True, help="enc prefix to sample reference rows from")
    ap.add_argument("--ref-rows", type=int, default=16)
    args = ap.parse_args()

    man_path = args.manifest or args.pt.replace(".pt", ".json")
    man = json.load(open(man_path, encoding="utf-8"))
    model = ValueNet(man["enc_len"], man["vocab_size"], channels=man["channels"], blocks=man["blocks"],
                     n_planes=man.get("n_planes", 43), n_globals=man.get("n_globals", 91), n_v=man.get("n_v", 4))
    model.load_state_dict(torch.load(args.pt, map_location="cpu"))

    shard = load_shard(args.ref_from, 0)
    idx = np.random.default_rng(0).choice(len(shard.y), size=args.ref_rows, replace=False)
    ref_inputs = np.asarray(shard.x[idx])
    export_model(model, args.out, ref_inputs)


if __name__ == "__main__":
    main()
