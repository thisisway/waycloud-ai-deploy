import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import postgres from "postgres";

// Two implementations exist on purpose: postgres.js in production, PGlite (embedded Postgres) in
// tests. `tx` is a real driver transaction: postgres.js refuses BEGIN/COMMIT sent through a pool.
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  tx(work: (db: Db) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

type AnySql = postgres.Sql | postgres.TransactionSql;

const wrap = (sql: AnySql): Db => ({
  query: async <T>(text: string, params: unknown[] = []) => (await sql.unsafe(text, params as never[])) as unknown as T[],
  exec: async (text) => void (await sql.unsafe(text)),
  tx: async (work) => void (await (sql as postgres.Sql).begin(async (t) => void (await work(wrap(t))))),
  close: () => (sql as postgres.Sql).end(),
});

export const openPostgres = (url: string): Db => wrap(postgres(url, { max: 10, onnotice: () => {} }));

const MIGRATIONS_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "migrations");

export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const done = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name));
  const applied: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    const body = readFileSync(join(dir, file), "utf8");
    await db.tx(async (t) => {
      await t.exec(body);
      await t.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    });
    applied.push(file);
  }
  return applied;
}
