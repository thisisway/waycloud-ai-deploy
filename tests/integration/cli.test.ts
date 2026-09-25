import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM without type declarations
import { main } from "../../packages/cli/src/cli.mjs";
import { syncAgentTokens } from "../../apps/mcp-service/src/agent.js";
import { TOOL_NAMES } from "../../packages/shared/src/index.js";
import { findSession } from "../../apps/mcp-service/src/sessions.js";
import { buildApp } from "../../apps/mcp-service/src/server.js";
import { testCtx } from "../helpers.js";

type T = Awaited<ReturnType<typeof testCtx>>;
let base: string;
let stop: () => Promise<void>;
let db: T["db"];
let storage: T["storage"];

beforeAll(async () => {
  const t = await testCtx();
  ({ db, storage } = t);
  await syncAgentTokens(db, `whmcs-18:${"a1".repeat(32)}`); // the subscription below points at this server
  t.ctx.fetchFn = (async () => new Response("<html></html>", { status: 200 })) as typeof fetch; // verificar_site
  const app = buildApp(t.ctx);
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

  // Stand-in for R2: the pre-signed URL points here, and a PUT lands in the in-memory storage.
  const put: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const u = new URL(req.url!, base);
      const size = Number(u.searchParams.get("size"));
      if (req.method !== "PUT" || body.length !== size) return void res.writeHead(403).end(); // like R2: the signed content-length
      storage.objects.set(decodeURIComponent(u.pathname.slice(5)), new Uint8Array(body));
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((r) => put.listen(0, "127.0.0.1", r));
  const putPort = (put.address() as { port: number }).port;
  storage.presignPut = async (key, size) => `http://127.0.0.1:${putPort}/put/${encodeURIComponent(key)}?size=${size}`;

  stop = async () => {
    put.close();
    await app.close();
    await t.close();
  };
});
afterAll(() => stop());

const dirs: string[] = [];
const site = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "wc-cli-e2e-"));
  dirs.push(dir);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function run(args: string[], sleepFn: () => Promise<void> = async () => {}) {
  const lines: string[] = [];
  const sink = { log: (m: string) => lines.push(m), error: (m: string) => lines.push(m) };
  const code = await main(args, { WAYCLOUD_URL: `${base}/mcp` }, sink, { sleepFn });
  return { code: code as number, text: lines.join("\n") };
}

describe("llms.txt", () => {
  it("is served by the service and documents every tool", async () => {
    const r = await fetch(`${base}/llms.txt`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/plain");
    const text = await r.text();
    for (const tool of TOOL_NAMES) expect(text, tool).toContain(`\`${tool}\``);
    expect(text).toContain("npx waycloud deploy");
  });
});

describe("waycloud CLI against the real service", () => {
  it("help and unknown commands", async () => {
    expect(await run([])).toMatchObject({ code: 0 });
    expect((await run(["--help"])).text).toContain("Uso: waycloud");
    expect(await run(["banana"])).toMatchObject({ code: 2 });
    expect(await run(["logs"])).toMatchObject({ code: 2 });
    expect(await run(["rollback"])).toMatchObject({ code: 2 });
  });

  it("plans lists the catalog in pt-BR", async () => {
    const r = await run(["plans"]);
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/173 +Speed BR/);
    expect(r.text).toMatch(/R\$/);
  });

  it("deploy without a paid plan: uploads, creates the preview and points to checkout; secrets never leave", async () => {
    const dir = site({ "index.html": "<html><body><h1>oi</h1></body></html>", ".env": "SEGREDO=1", "node_modules/x/i.js": "x", ".gitignore": "ignorado.html\n", "ignorado.html": "x" });
    const r = await run(["deploy", dir]);
    expect(r.code, r.text).toBe(0);
    expect(r.text).toContain("Prévia grátis (temporária): https://");
    expect(r.text).toContain("waycloud checkout --plano");
    const zips = [...storage.objects.values()].filter((b) => b[0] === 0x50 && b[1] === 0x4b); // "PK"
    expect(zips.some((z) => Object.keys(unzipSync(z)).sort().join() === ".gitignore,index.html")).toBe(true);
    expect(existsSync(join(dir, ".waycloud", "session.json"))).toBe(true);
  });

  it("checkout asks for a plan, and a service error is shown, not thrown", async () => {
    const dir = site({ "index.html": "x" });
    expect(await run(["checkout", dir])).toMatchObject({ code: 2 });
    const r = await run(["checkout", dir, "--plano", "223", "--ciclo", "anual"]);
    expect(r.text.length).toBeGreaterThan(0); // no addon is wired in this test: the fixed pt-BR message comes back
  });

  it("status without a session", async () => {
    expect(await run(["status", site({ "index.html": "x" })])).toMatchObject({ code: 1 });
  });

  it("deploy with an active plan publishes, follows the deploy and verifies the site; status repeats it", async () => {
    const dir = site({ "index.html": "<h1>pago</h1>" });
    expect((await run(["deploy", dir])).code).toBe(0); // creates the session
    const { sessao_id } = JSON.parse(readFileSync(join(dir, ".waycloud", "session.json"), "utf8"));
    const uuid = (await findSession(db, sessao_id))!.id;
    await db.query("INSERT INTO orders (session_id, status, whmcs_service_id) VALUES ($1, 'active', 7001)", [uuid]);
    await db.query("INSERT INTO subscriptions (whmcs_service_id, session_id, server_id, domain, plan_pid) VALUES (7001, $1, 'whmcs-18', 'cli.sites.test', 223)", [uuid]);

    let polls = 0;
    const r = await run(["deploy", dir], async () => {
      polls++;
      await db.query("UPDATE deploys SET status = 'published', ssl = true WHERE subscription_id = 7001"); // what the agent would report
    });
    expect(r.code, r.text).toBe(0);
    expect(polls).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(join(dir, ".waycloud", "session.json"), "utf8")).deploy_id).toMatch(/^[0-9a-f-]{36}$/);

    const s = await run(["status", dir]);
    expect(s.code, s.text).toBe(0);
  });

  it("reports an unreachable service instead of crashing", async () => {
    const lines: string[] = [];
    const code = await main(["plans"], { WAYCLOUD_URL: "http://127.0.0.1:9/mcp" }, { log: (m: string) => lines.push(m), error: (m: string) => lines.push(m) });
    expect(code).toBe(1);
    expect(lines.join("")).toContain("Não consegui falar com a Way Cloud");
  });
});
