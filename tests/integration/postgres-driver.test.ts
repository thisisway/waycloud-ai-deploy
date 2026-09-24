import { afterAll, describe, expect, it } from "vitest";
import { migrate, openPostgres } from "../../apps/mcp-service/src/db/index.js";
import { createSession, findSession } from "../../apps/mcp-service/src/sessions.js";

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
});
