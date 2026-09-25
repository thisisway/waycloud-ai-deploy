import { afterAll, describe, expect, it } from "vitest";
import { migrate, openPostgres } from "../../apps/mcp-service/src/db/index.js";
import { claimNextJob, createDeploy } from "../../apps/mcp-service/src/deploys.js";
import { PLANS } from "../../apps/mcp-service/src/plans.js";
import { createSession, findSession } from "../../apps/mcp-service/src/sessions.js";
import { DEFAULT_SETTINGS } from "../../apps/mcp-service/src/settings.js";
import { memoryStorage } from "../helpers.js";

// The unit tests run on PGlite; this one exercises the production driver (postgres.js) and only
// runs when a real database is available:
//   docker run -d --rm -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:17
//   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres pnpm test
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("postgres.js driver against a real Postgres", () => {
  const db = openPostgres(url ?? "postgres://unused");
  afterAll(async () => db.close());

  it("migrates in a real transaction, twice, and serves sessions", async () => {
    await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    expect((await migrate(db)).length).toBeGreaterThan(0);
    expect(await migrate(db)).toEqual([]);
    const { token } = await createSession(db);
    expect(await findSession(db, token)).not.toBeNull();
  });

  it("rolls back a failed migration transaction", async () => {
    await expect(
      db.tx(async (t) => {
        await t.exec("CREATE TABLE tx_probe (id int)");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.query("SELECT to_regclass('tx_probe') AS t")).toEqual([{ t: null }]);
  });

  // Regression: postgres.js used to store a JSON *string* in jsonb columns, so the deploy agent received a job
  // with no hash or size. PGlite (used by the other tests) never showed it, only a real Postgres does.
  it("jsonb columns round-trip as objects: the deploy job carries its hash and size", async () => {
    await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(db);
    const { token } = await createSession(db);
    const sessionId = (await findSession(db, token))!.id;
    await db.query("INSERT INTO servers (id, label, agent_secret_hash) VALUES ('s1', 's1', 'x')");
    await db.query("INSERT INTO subscriptions (whmcs_service_id, session_id, server_id, domain, plan_pid) VALUES (1, $1, 's1', 'a.sites.test', 223)", [sessionId]);
    const [up] = await db.query<{ id: string }>("INSERT INTO uploads (session_id, storage_key, source) VALUES ($1, 'k', 'inline') RETURNING id", [sessionId]);
    const ctx = { db, plans: async () => PLANS, storage: memoryStorage(), settings: DEFAULT_SETTINGS };

    await createDeploy(ctx, { whmcs_service_id: 1 }, up!.id, { zip: new Uint8Array(321), sha256: "ab".repeat(32) }, { spa: true, phpVersion: "8.3" });
    const [raw] = await db.query<{ t: string }>("SELECT jsonb_typeof(params) AS t FROM deploys");
    expect(raw!.t).toBe("object"); // NOT "string"
    expect(await claimNextJob(db, "s1")).toMatchObject({ domain: "a.sites.test", sha256: "ab".repeat(32), size_bytes: 321, php_version: "8.3", spa: true, keep_snapshots: 5 });

    await db.query("INSERT INTO projects (session_id, detected_type, analysis) VALUES ($1, 'estatico', $2::text::jsonb)", [sessionId, JSON.stringify({ a: 1 })]);
    expect((await db.query<{ t: string }>("SELECT jsonb_typeof(analysis) AS t FROM projects"))[0]!.t).toBe("object");
  });
});
