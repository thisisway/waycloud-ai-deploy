import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { migrate, type Db } from "../apps/mcp-service/src/db/index.js";
import type { ToolContext } from "../apps/mcp-service/src/mcp/tools/define.js";
import { PLANS } from "../apps/mcp-service/src/plans.js";
import { DEFAULT_SETTINGS } from "../apps/mcp-service/src/settings.js";
import type { Storage } from "../apps/mcp-service/src/storage.js";

type Runner = Pick<PGlite, "query" | "exec">;

const wrap = (pg: Runner, root: PGlite): Db => ({
  query: async <T>(sql: string, params: unknown[] = []) => (await pg.query(sql, params)).rows as T[],
  exec: async (sql) => void (await pg.exec(sql)),
  tx: async (work) => void (await root.transaction(async (t) => void (await work(wrap(t, root))))),
  close: () => root.close(),
});

// Real Postgres semantics (embedded), so tests run the same SQL as production with no server needed.
export async function testDb(): Promise<Db> {
  const pg = new PGlite();
  await pg.waitReady;
  const db = wrap(pg, pg);
  await migrate(db);
  return db;
}

export interface MemoryStorage extends Storage {
  objects: Map<string, Uint8Array>;
  presigned: { key: string; size: number; ttl: number }[];
}

export function memoryStorage(): MemoryStorage {
  const objects = new Map<string, Uint8Array>();
  const presigned: MemoryStorage["presigned"] = [];
  return {
    objects,
    presigned,
    presignPut: async (key, size, ttl) => {
      presigned.push({ key, size, ttl });
      return `https://storage.test/${key}?size=${size}`;
    },
    put: async (key, body) => void objects.set(key, body),
    get: async (key) => objects.get(key) ?? null,
    head: async (key) => objects.get(key)?.length ?? null,
    remove: async (key) => void objects.delete(key),
  };
}

// A full tool context on an embedded Postgres, in-memory object storage and a temp preview folder.
export async function testCtx(overrides: Partial<ToolContext["settings"]> = {}) {
  const db = await testDb();
  const storage = memoryStorage();
  const root = await mkdtemp(join(tmpdir(), "wc-previews-"));
  const ctx: ToolContext = {
    db,
    plans: async () => PLANS,
    storage,
    settings: { ...DEFAULT_SETTINGS, previewRoot: root, previewUrlTemplate: "https://{slug}.preview.test", ...overrides },
  };
  return { ctx, db, storage, root, close: async () => (await db.close(), await rm(root, { recursive: true, force: true })) };
}
