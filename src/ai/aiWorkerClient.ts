// Main-thread client for the AI thinking worker (see aiWorker.ts). Singleton:
// one worker for the whole session, initialized with the card catalog once.
// Every failure path resolves to `null` so the caller can fall back to the
// synchronous in-thread agent (old browsers, serialization surprises...).
import type { Card } from "../data/types";
import type { GameState } from "../engine/state";
import type { Action } from "./actions";
import type { AiStrength } from "./browserAgent";

let worker: Worker | null = null;
let readyPromise: Promise<boolean> | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (a: Action | null) => void }>();

/** Spin up the worker (idempotent). Resolves false if workers are unavailable
 *  or init failed, callers then stay on the synchronous path. */
export function initAiWorker(cards: Card[]): Promise<boolean> {
  if (readyPromise) return readyPromise;
  readyPromise = new Promise<boolean>((resolve) => {
    try {
      worker = new Worker(new URL("./aiWorker.ts", import.meta.url), { type: "module" });
      const timeout = setTimeout(() => { resolve(false); }, 15000);
      worker.onmessage = (e: MessageEvent) => {
        const m = e.data as { type: string; id?: number; action?: Action; message?: string };
        if (m.type === "ready") { clearTimeout(timeout); resolve(true); return; }
        if (m.type === "action" && m.id !== undefined) {
          pending.get(m.id)?.resolve(m.action ?? null);
          pending.delete(m.id);
        } else if (m.type === "error") {
          if (m.id !== undefined && m.id >= 0) { pending.get(m.id)?.resolve(null); pending.delete(m.id); }
          console.warn("[AI worker]", m.message);
        }
      };
      worker.onerror = (err) => {
        console.warn("[AI worker] crashed — fallback to in-thread AI", err.message);
        clearTimeout(timeout);
        for (const p of pending.values()) p.resolve(null);
        pending.clear();
        worker = null;
        resolve(false);
      };
      worker.postMessage({ type: "init", cards });
    } catch (err) {
      console.warn("[AI worker] unavailable — in-thread AI", err);
      resolve(false);
    }
  });
  return readyPromise;
}

/** Ask the worker for a decision. Resolves null on any failure (caller falls
 *  back to the synchronous agent). */
export function workerDecide(state: GameState, legal: Action[], strength: AiStrength, seed: number): Promise<Action | null> {
  if (!worker) return Promise.resolve(null);
  const id = seq++;
  return new Promise<Action | null>((resolve) => {
    pending.set(id, { resolve });
    try {
      worker!.postMessage({ type: "decide", id, state, legal, strength, seed });
    } catch (err) {
      // DataCloneError etc., this state cannot cross threads; sync fallback.
      console.warn("[AI worker] postMessage failed — sync fallback", err);
      pending.delete(id);
      resolve(null);
    }
  });
}
