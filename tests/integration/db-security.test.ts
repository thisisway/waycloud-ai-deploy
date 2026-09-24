import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, type Db } from "../../apps/mcp-service/src/db/index.js";
import { purgeNonces, sign, verify } from "../../apps/mcp-service/src/security/hmac.js";
import { hashToken, newToken } from "../../apps/mcp-service/src/security/tokens.js";
import { createSession, findSession } from "../../apps/mcp-service/src/sessions.js";
import { testDb } from "../helpers.js";

let db: Db;
beforeAll(async () => void (db = await testDb()));
afterAll(async () => db.close());

describe("migrations", () => {
  it("are idempotent and create the core tables", async () => {
    expect(await migrate(db)).toEqual([]); // already applied by testDb()
    const rows = await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    const names = rows.map((r) => r.table_name);
    for (const t of ["sessions", "projects", "uploads", "previews", "orders", "subscriptions", "deploys", "releases", "webhook_nonces", "audit_log"]) expect(names).toContain(t);
  });
});

describe("sessions and tokens", () => {
  it("tokens have at least 128 bits and only the hash is stored", async () => {
    const t = newToken();
    expect(Buffer.from(t, "base64url").length).toBeGreaterThanOrEqual(16);
    const { token } = await createSession(db);
    const rows = await db.query<{ token_hash: string }>("SELECT token_hash FROM sessions");
    expect(rows.map((r) => r.token_hash)).toContain(hashToken(token));
    expect(rows.map((r) => r.token_hash)).not.toContain(token);
  });

  it("finds an active session, not an unknown or expired one", async () => {
    const { token, expiresAt } = await createSession(db);
    expect(await findSession(db, token)).toMatchObject({ expires_at: expiresAt });
    expect(await findSession(db, newToken())).toBeNull();
    const expired = await createSession(db, { ttlHours: -1 });
    expect(await findSession(db, expired.token)).toBeNull();
  });

  it("default lifetime is 72 hours", async () => {
    const { expiresAt } = await createSession(db);
    const hours = (expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(71.9);
    expect(hours).toBeLessThan(72.1);
  });
});

describe("HMAC webhooks", () => {
  const secret = "test-secret";
  const body = JSON.stringify({ event: "invoice.paid", service_id: 1 });

  it("accepts a valid signature once, then rejects the replay", async () => {
    const sig = sign(secret, body);
    expect(await verify(db, secret, sig, body)).toBe("ok");
    expect(await verify(db, secret, sig, body)).toBe("replay");
  });

  it("rejects a tampered body and a wrong secret, without burning the nonce", async () => {
    const sig = sign(secret, body);
    expect(await verify(db, secret, sig, body + " ")).toBe("bad_signature");
    expect(await verify(db, "other", sig, body)).toBe("bad_signature");
    expect(await verify(db, secret, sig, body)).toBe("ok"); // nonce was still free
  });

  it("rejects stale and future timestamps (5 minute window)", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await verify(db, secret, sign(secret, body, now - 301), body, now)).toBe("expired");
    expect(await verify(db, secret, sign(secret, body, now + 301), body, now)).toBe("expired");
    expect(await verify(db, secret, sign(secret, body, now - 299), body, now)).toBe("ok");
  });

  it("rejects malformed signatures", async () => {
    const sig = sign(secret, body);
    expect(await verify(db, secret, { ...sig, signature: "zz" }, body)).toBe("bad_signature");
  });

  it("purges old nonces", async () => {
    await db.query("INSERT INTO webhook_nonces (nonce, seen_at) VALUES ('old', now() - interval '1 hour')");
    await purgeNonces(db);
    const rows = await db.query("SELECT 1 FROM webhook_nonces WHERE nonce = 'old'");
    expect(rows).toHaveLength(0);
  });
});
