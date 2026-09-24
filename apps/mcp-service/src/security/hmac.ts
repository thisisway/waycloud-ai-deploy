import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/index.js";

export interface Signature {
  ts: number;
  nonce: string;
  signature: string;
}

const mac = (secret: string, ts: number, nonce: string, body: string) =>
  createHmac("sha256", secret).update(`${ts}.${nonce}.${body}`).digest("hex");

export function sign(secret: string, body: string, ts = Math.floor(Date.now() / 1000), nonce = randomBytes(16).toString("hex")): Signature {
  return { ts, nonce, signature: mac(secret, ts, nonce, body) };
}

export type VerifyResult = "ok" | "expired" | "bad_signature" | "replay";

// Order matters: timestamp window first, then the signature, and only a VALID signature burns a
// nonce (so an attacker cannot fill the nonce table with junk).
export async function verify(db: Db, secret: string, sig: Signature, body: string, nowSec = Math.floor(Date.now() / 1000), windowSec = 300): Promise<VerifyResult> {
  if (!Number.isFinite(sig.ts) || Math.abs(nowSec - sig.ts) > windowSec) return "expired";
  const expected = Buffer.from(mac(secret, sig.ts, sig.nonce, body), "hex");
  const given = Buffer.from(sig.signature, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return "bad_signature";
  const inserted = await db.query("INSERT INTO webhook_nonces (nonce) VALUES ($1) ON CONFLICT DO NOTHING RETURNING nonce", [sig.nonce]);
  return inserted.length === 0 ? "replay" : "ok";
}

// Nonces older than twice the window can no longer be replayed (their timestamp is rejected anyway).
export const purgeNonces = (db: Db, windowSec = 300) =>
  db.query("DELETE FROM webhook_nonces WHERE seen_at < now() - make_interval(secs => $1)", [windowSec * 2]);
