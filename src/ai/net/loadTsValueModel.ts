// Node-only loader for the exported value model (keeps TsValueModel browser-safe).
import * as fs from "node:fs";
import { TsValueModel, type TsManifest } from "./TsValueModel";

export function loadTsValueModel(prefix: string): TsValueModel {
  const manifest = JSON.parse(fs.readFileSync(`${prefix}.manifest.json`, "utf-8")) as TsManifest;
  const buf = fs.readFileSync(`${prefix}.weights.f32`);
  const weights = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return new TsValueModel(manifest, weights);
}
