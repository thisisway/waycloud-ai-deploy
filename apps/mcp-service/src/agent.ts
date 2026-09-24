import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "./db/index.js";
import { claimNextJob, reportJob } from "./deploys.js";
import type { ToolContext } from "./mcp/tools/define.js";
import { hashToken } from "./security/tokens.js";

// API used by the deploy agent that runs on each Plesk server. Pull model: the agent only makes outbound
// HTTPS calls. One token per server (only its hash is stored); a token can only touch that server's deploys.

const TOKEN = /^[0-9a-f]{64}$/;

/** AGENT_TOKENS="whmcs-18:<64 hex>,other:<64 hex>" -> servers rows (idempotent, runs at startup). */
export async function syncAgentTokens(db: Db, spec: string | undefined): Promise<string[]> {
  const ids: string[] = [];
  for (const entry of (spec ?? "").split(",").map((e) => e.trim()).filter(Boolean)) {
    const [id, token] = entry.split(":");
    if (!id || !token || !/^[a-z0-9_-]{1,40}$/.test(id) || !TOKEN.test(token)) throw new Error("AGENT_TOKENS entries must look like <server-id>:<64 hex chars>");
    await db.query("INSERT INTO servers (id, label, agent_secret_hash) VALUES ($1, $1, $2) ON CONFLICT (id) DO UPDATE SET agent_secret_hash = EXCLUDED.agent_secret_hash", [id, hashToken(token)]);
    ids.push(id);
  }
  return ids;
}

async function authenticate(db: Db, req: FastifyRequest): Promise<string | null> {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(String(req.headers.authorization ?? ""));
  if (!m) return null;
  const wanted = Buffer.from(hashToken(m[1]!));
  const rows = await db.query<{ id: string; agent_secret_hash: string }>("SELECT id, agent_secret_hash FROM servers WHERE active AND agent_secret_hash <> ''");
  const hit = rows.find((r) => r.agent_secret_hash.length === wanted.length && timingSafeEqual(Buffer.from(r.agent_secret_hash), wanted));
  return hit?.id ?? null;
}

const report = z
  .object({ status: z.enum(["validating", "published", "failed", "rolled_back"]), step: z.string().regex(/^[a-z0-9_]{1,40}$/).optional(), error_code: z.string().regex(/^[a-z0-9_]{1,40}$/).optional(), ssl: z.boolean().optional() })
  .strict();

export function registerAgentRoutes(app: FastifyInstance, ctx: ToolContext) {
  void app.register(async (scope) => {
    // The agent's polls have no body: accept an empty JSON body instead of answering 400.
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
      try {
        done(null, body ? JSON.parse(body as string) : {});
      } catch {
        done(Object.assign(new Error("invalid json"), { statusCode: 400 }), undefined);
      }
    });
    scope.addHook("preHandler", async (req, reply) => {
      const serverId = await authenticate(ctx.db, req);
      if (!serverId) return reply.code(401).send({ error: "unauthorized" });
      (req as FastifyRequest & { serverId: string }).serverId = serverId;
    });
    const serverOf = (req: FastifyRequest) => (req as FastifyRequest & { serverId: string }).serverId;

    // Authenticated ping: lets the installer verify a token without claiming a job.
    scope.get("/ping", async (req) => ({ ok: true, server: serverOf(req) }));

    // The repository is private: the installer and the agent are served to whoever holds a valid token.
    const AGENT_DIR = fileURLToPath(new URL("../../../agent/", import.meta.url));
    for (const file of ["install.sh", "waycloud-agent.sh"]) {
      scope.get(`/${file}`, async (_req, reply) => reply.header("content-type", "text/x-shellscript; charset=utf-8").send(await readFile(AGENT_DIR + file)));
    }

    scope.post("/jobs/next", async (req, reply) => {
      const serverId = serverOf(req);
      await ctx.db.query("UPDATE servers SET last_seen_at = now() WHERE id = $1", [serverId]);
      const job = await claimNextJob(ctx.db, serverId);
      return job ? reply.send(job) : reply.code(204).send();
    });

    scope.get<{ Params: { id: string } }>("/jobs/:id/package", async (req, reply) => {
      const [d] = await ctx.db.query<{ package_key: string }>(
        "SELECT d.package_key FROM deploys d JOIN subscriptions s ON s.whmcs_service_id = d.subscription_id WHERE d.id::text = $1 AND s.server_id = $2 AND d.status IN ('sending', 'validating')",
        [req.params.id, serverOf(req)],
      );
      const zip = d ? await ctx.storage.get(d.package_key) : null;
      if (!zip) return reply.code(404).send({ error: "not_found" });
      return reply.header("content-type", "application/zip").send(Buffer.from(zip));
    });

    scope.post<{ Params: { id: string } }>("/jobs/:id/report", async (req, reply) => {
      const body = report.safeParse(req.body);
      if (!body.success || !/^[0-9a-f-]{36}$/.test(req.params.id)) return reply.code(400).send({ error: "invalid_body" });
      const r = await reportJob(ctx.db, serverOf(req), req.params.id, body.data);
      if (r === "not_found") return reply.code(404).send({ error: "not_found" });
      if (r === "bad_transition") return reply.code(409).send({ error: "bad_transition" });
      return reply.send({ ok: true });
    });
  }, { prefix: "/agent/v1" });
}
