// Node-only loader for the exported policy model (keeps TsPolicyModel browser-safe).
import * as fs from "node:fs";
import { TsPolicyModel } from "./TsPolicyModel";
import type { NnManifest } from "./nnOps";

export function loadTsPolicyModel(prefix: string): TsPolicyModel {
  const manifest = JSON.parse(fs.readFileSync(`${prefix}.manifest.json`, "utf-8")) as NnManifest;
  const buf = fs.readFileSync(`${prefix}.weights.f32`);
  const weights = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return new TsPolicyModel(manifest, weights);
}
