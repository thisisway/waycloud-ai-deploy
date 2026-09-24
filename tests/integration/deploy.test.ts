import { readFileSync } from "node:fs";
import { strToU8, unzipSync, zipSync } from "fflate";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { envelopeSchema, saidas, type Envelope, type ToolName } from "../../packages/shared/src/index.js";
import { syncAgentTokens } from "../../apps/mcp-service/src/agent.js";
import type { Db } from "../../apps/mcp-service/src/db/index.js";
import { failStaleDeploys } from "../../apps/mcp-service/src/deploys.js";
import { TOOLS } from "../../apps/mcp-service/src/mcp/tools/index.js";
import type { ToolContext } from "../../apps/mcp-service/src/mcp/tools/define.js";
import { buildApp } from "../../apps/mcp-service/src/server.js";
import { findSession } from "../../apps/mcp-service/src/sessions.js";
import { rawKey } from "../../apps/mcp-service/src/uploads.js";
import { testCtx, type MemoryStorage } from "../helpers.js";

const TOKEN_A = "a1".repeat(32);
const TOKEN_B = "b2".repeat(32);
let ctx: ToolContext;
let db: Db;
let storage: MemoryStorage;
let close: () => Promise<void>;
let app: ReturnType<typeof buildApp>;
let fetchImpl: (u: URL) => Response | Promise<Response>;
let fetched: string[] = [];

beforeAll(async () => {
  ({ ctx, db, storage, close } = await testCtx());
  ctx.fetchFn = (async (input: URL | string) => {
    const u = new URL(String(input));
    fetched.push(u.href);
    return fetchImpl(u);
  }) as typeof fetch;
  app = buildApp(ctx);
  await syncAgentTokens(db, `whmcs-18:${TOKEN_A},whmcs-19:${TOKEN_B}`);
});
afterAll(async () => {
  await app.close();
  await close();
});

const call = (name: ToolName, args: unknown) => TOOLS.find((t) => t.name === name)!.handler(ctx, args as never);
const b64 = (s: string) => Buffer.from(strToU8(s)).toString("base64");
const inline = (files: Record<string, string>) => Object.entries(files).map(([caminho, c]) => ({ caminho, conteudo_base64: b64(c) }));
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

let nextService = 5000;
/** A paid session: order active + subscription on the given server. */
async function paidSession(server = "whmcs-18", domain = `s${nextService}.sites.test`) {
  const token = ((await call("iniciar_sessao", {})).dados as { sessao_id: string }).sessao_id;
  const uuid = (await findSession(db, token))!.id;
  const service = nextService++;
  await db.query("INSERT INTO orders (session_id, status, whmcs_service_id) VALUES ($1, 'active', $2)", [uuid, service]);
  await db.query("INSERT INTO subscriptions (whmcs_service_id, session_id, server_id, domain, plan_pid) VALUES ($1, $2, $3, $4, 223)", [service, uuid, server, domain]);
  return { token, uuid, service, domain };
}
const upload = (token: string, files: Record<string, string>) => call("enviar_arquivos", { sessao_id: token, arquivos: inline(files) });
const publish = async (token: string, files: Record<string, string>) => {
  await upload(token, files);
  return call("publicar", { sessao_id: token });
};
const deployId = (r: Envelope) => (r.dados as { deploy_id: string }).deploy_id;
const job = (t = TOKEN_A) => app.inject({ method: "POST", url: "/agent/v1/jobs/next", headers: auth(t) });
const report = (id: string, body: object, t = TOKEN_A) => app.inject({ method: "POST", url: `/agent/v1/jobs/${id}/report`, headers: auth(t), payload: body });
const statusOf = async (token: string, id: string) => {
  const r = await call("status_deploy", { sessao_id: token, deploy_id: id });
  envelopeSchema(saidas.status_deploy).parse(r);
  return r;
};
const STATIC = { "index.html": "<h1>oi</h1>", "css/a.css": "b{}" };
// Tests that use the agent claim from the server's queue: start each of them with an empty one.
const drainQueue = () => db.query("UPDATE deploys SET status = 'failed', error_code = 'test_cleanup' WHERE status IN ('queued', 'sending', 'validating')");

describe("publicar", () => {
  it("only when the order is active", async () => {
    const t = ((await call("iniciar_sessao", {})).dados as { sessao_id: string }).sessao_id;
    await upload(t, STATIC);
    expect(await call("publicar", { sessao_id: t })).toMatchObject({ ok: false, codigo: "PEDIDO_NAO_ATIVO" });
    const uuid = (await findSession(db, t))!.id;
    for (const status of ["awaiting_payment", "paid", "failed"]) {
      await db.query("INSERT INTO orders (session_id, status) VALUES ($1, $2) ON CONFLICT (session_id) DO UPDATE SET status = EXCLUDED.status", [uuid, status]);
      expect(await call("publicar", { sessao_id: t })).toMatchObject({ codigo: "PEDIDO_NAO_ATIVO" });
    }
    expect(await call("publicar", { sessao_id: "z".repeat(43) })).toMatchObject({ codigo: "SESSAO_INVALIDA" });
  });

  it("queues a deploy whose package holds only the site, with a matching hash", async () => {
    const s = await paidSession();
    const r = await publish(s.token, STATIC);
    envelopeSchema(saidas.publicar).parse(r);
    expect(r).toMatchObject({ ok: true, codigo: "DEPLOY_INICIADO" });
    const [d] = await db.query<{ status: string; params: { sha256: string; size_bytes: number; spa: boolean; php_version: string | null; keep: number }; package_key: string }>("SELECT status, params, package_key FROM deploys WHERE id = $1", [deployId(r)]);
    expect(d!.status).toBe("queued");
    const zip = storage.objects.get(d!.package_key)!;
    expect(createHash("sha256").update(zip).digest("hex")).toBe(d!.params.sha256);
    expect(d!.params).toMatchObject({ size_bytes: zip.length, spa: false, php_version: null, keep: 5 });
    expect(Object.keys(unzipSync(zip)).sort()).toEqual(["css/a.css", "index.html"]);
    expect(await statusOf(s.token, deployId(r))).toMatchObject({ codigo: "DEPLOY_NA_FILA", dados: { status: "na_fila", url: null, https_ativo: null, intervalo_sugerido_segundos: 5 } });
  });

  it("refuses a second deploy while one is in progress", async () => {
    const s = await paidSession();
    await publish(s.token, STATIC);
    expect(await call("publicar", { sessao_id: s.token })).toMatchObject({ ok: false, codigo: "DEPLOY_EM_ANDAMENTO" });
  });

  it("SPA: publishes only the build folder and adds the history fallback, unless the project brings its own", async () => {
    const s = await paidSession();
    const spa = { "package.json": JSON.stringify({ devDependencies: { vite: "5" } }), "index.html": "src", "src/main.ts": "secret", "dist/index.html": "<div id=root>", "dist/assets/a.js": "1" };
    const r = await publish(s.token, spa);
    const [d] = await db.query<{ params: { spa: boolean }; package_key: string }>("SELECT params, package_key FROM deploys WHERE id = $1", [deployId(r)]);
    expect(d!.params.spa).toBe(true);
    const files = unzipSync(storage.objects.get(d!.package_key)!);
    expect(Object.keys(files).sort()).toEqual([".htaccess", "assets/a.js", "index.html"]);
    expect(Buffer.from(files["index.html"]!).toString()).toBe("<div id=root>");
    expect(Buffer.from(files[".htaccess"]!).toString()).toContain("RewriteRule . /index.html [L]");

    const own = await paidSession();
    const r2 = await publish(own.token, { ...spa, "dist/.htaccess": "# mine" });
    const [d2] = await db.query<{ package_key: string }>("SELECT package_key FROM deploys WHERE id = $1", [deployId(r2)]);
    expect(Buffer.from(unzipSync(storage.objects.get(d2!.package_key)!)[".htaccess"]!).toString()).toBe("# mine");
  });

  it("PHP: carries the PHP version and no SPA fallback", async () => {
    const s = await paidSession();
    const r = await publish(s.token, { "index.php": "<?php echo 1;", "composer.json": JSON.stringify({ require: { php: "^8.1" } }) });
    const [d] = await db.query<{ params: { spa: boolean; php_version: string } }>("SELECT params FROM deploys WHERE id = $1", [deployId(r)]);
    expect(d!.params).toMatchObject({ spa: false, php_version: "8.3" });
  });

  it("refuses what cannot be published, with fixed messages", async () => {
    const s1 = await paidSession();
    expect(await publish(s1.token, { "wp-config.php": "<?php", "index.php": "<?php" })).toMatchObject({ codigo: "PROJETO_NAO_SUPORTADO" });
    const s2 = await paidSession();
    expect(await publish(s2.token, { "package.json": JSON.stringify({ devDependencies: { vite: "5" } }), "index.html": "x" })).toMatchObject({ codigo: "PASTA_BUILD_AUSENTE" });
    const s3 = await paidSession();
    expect(await call("publicar", { sessao_id: s3.token })).toMatchObject({ codigo: "UPLOAD_NAO_ENCONTRADO" });
    const s4 = await paidSession();
    const other = await paidSession();
    const up = ((await upload(other.token, STATIC)).dados as { upload_id: string }).upload_id;
    expect(await call("publicar", { sessao_id: s4.token, upload_id: up })).toMatchObject({ codigo: "UPLOAD_NAO_ENCONTRADO" });
    const s5 = await paidSession();
    const blocked = await upload(s5.token, { "index.html": "x", "a.exe": "MZ" });
    expect(blocked.ok).toBe(false);
    expect(await call("publicar", { sessao_id: s5.token })).toMatchObject({ codigo: "UPLOAD_NAO_ENCONTRADO" });
  });

  it("works from a pre-signed raw upload too", async () => {
    const s = await paidSession();
    const up = (await call("obter_url_upload", { sessao_id: s.token, tamanho_bytes: 500 })).dados as { upload_id: string };
    storage.objects.set(rawKey(s.uuid, up.upload_id), zipSync({ "site/index.html": strToU8("<h1>zip</h1>") }));
    const r = await call("publicar", { sessao_id: s.token, upload_id: up.upload_id });
    expect(r).toMatchObject({ ok: true, codigo: "DEPLOY_INICIADO" });
  });
});

describe("agent API", () => {
  beforeEach(drainQueue);

  it("rejects missing, malformed, unknown and unset tokens", async () => {
    const bad = [{}, auth("nope"), auth("c3".repeat(32)), auth("")];
    for (const headers of bad) expect((await app.inject({ method: "POST", url: "/agent/v1/jobs/next", headers })).statusCode).toBe(401);
    await db.query("INSERT INTO servers (id, label, agent_secret_hash) VALUES ('not-enrolled', 'x', '') ON CONFLICT DO NOTHING"); // the auto-created rows have an empty hash
    expect((await job(hashless())).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/agent/v1/jobs/x/package" })).statusCode).toBe(401);
    function hashless() {
      return "0".repeat(64);
    }
  });

  it("accepts a poll with a JSON content type and no body (what curl sends), and still rejects malformed JSON", async () => {
    const empty = await app.inject({ method: "POST", url: "/agent/v1/jobs/next", headers: { ...auth(TOKEN_A), "content-type": "application/json" } });
    expect(empty.statusCode).toBe(204);
    const bad = await app.inject({ method: "POST", url: "/agent/v1/jobs/whatever/report", headers: { ...auth(TOKEN_A), "content-type": "application/json" }, payload: "{not json" });
    expect(bad.statusCode).toBe(400);
  });

  it("ping verifies a token without claiming any job", async () => {
    const s = await paidSession("whmcs-18");
    const id = deployId(await publish(s.token, STATIC));
    const ok = await app.inject({ method: "GET", url: "/agent/v1/ping", headers: auth(TOKEN_A) });
    expect([ok.statusCode, ok.json()]).toEqual([200, { ok: true, server: "whmcs-18" }]);
    expect((await app.inject({ method: "GET", url: "/agent/v1/ping" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/agent/v1/ping", headers: auth("0".repeat(64)) })).statusCode).toBe(401);
    expect((await db.query<{ status: string }>("SELECT status FROM deploys WHERE id = $1", [id]))[0]!.status).toBe("queued"); // untouched
  });

  it("serves the agent and its installer only to a valid token, byte for byte", async () => {
    for (const file of ["install.sh", "waycloud-agent.sh"]) {
      const url = `/agent/v1/${file}`;
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
      const r = await app.inject({ method: "GET", url, headers: auth(TOKEN_A) });
      expect(r.statusCode).toBe(200);
      expect(r.rawPayload.equals(readFileSync(new URL(`../../agent/${file}`, import.meta.url)))).toBe(true);
    }
  });

  it("204 when there is nothing to do; claims exactly one job, oldest first, only for its own server", async () => {
    const own = await paidSession("whmcs-18");
    const foreign = await paidSession("whmcs-19");
    expect((await job(TOKEN_B)).statusCode).toBe(204); // its queue is empty until the foreign site publishes
    const a = deployId(await publish(own.token, STATIC));
    const b = deployId(await publish(foreign.token, STATIC));

    const [r1, r2] = await Promise.all([job(TOKEN_A), job(TOKEN_A)]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 204]); // two pollers never get the same job
    const got = [r1, r2].find((r) => r.statusCode === 200)!.json();
    expect(got).toMatchObject({ job_id: a, domain: own.domain, php_version: null, spa: false, keep_snapshots: 5 });
    expect(got.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await statusOf(own.token, a)).toMatchObject({ codigo: "DEPLOY_ENVIANDO" });

    const other = (await job(TOKEN_B)).json();
    expect(other.job_id).toBe(b);
    expect(other.domain).toBe(foreign.domain);
    expect((await job(TOKEN_A)).statusCode).toBe(204);
  });

  it("serves the package only to the owning server while the job is being processed", async () => {
    const s = await paidSession("whmcs-18");
    const id = deployId(await publish(s.token, STATIC));
    const url = `/agent/v1/jobs/${id}/package`;
    expect((await app.inject({ method: "GET", url, headers: auth(TOKEN_A) })).statusCode).toBe(404); // still queued
    const claimed = (await job(TOKEN_A)).json();
    expect(claimed.job_id).toBe(id);
    expect((await app.inject({ method: "GET", url, headers: auth(TOKEN_B) })).statusCode).toBe(404); // another server
    const pkg = await app.inject({ method: "GET", url, headers: auth(TOKEN_A) });
    expect([pkg.statusCode, pkg.headers["content-type"]]).toEqual([200, "application/zip"]);
    expect(createHash("sha256").update(pkg.rawPayload).digest("hex")).toBe(claimed.sha256);
    await report(id, { status: "validating" });
    await report(id, { status: "published", ssl: true });
    expect((await app.inject({ method: "GET", url, headers: auth(TOKEN_A) })).statusCode).toBe(404); // finished: gone
  });

  it("enforces the state machine and ownership on reports", async () => {
    const s = await paidSession("whmcs-18");
    const id = deployId(await publish(s.token, STATIC));
    expect((await report(id, { status: "validating" })).statusCode).toBe(409); // not claimed yet
    await job(TOKEN_A);
    expect((await report(id, { status: "published" })).statusCode).toBe(409); // must validate first
    expect((await report(id, { status: "validating" }, TOKEN_B)).statusCode).toBe(404); // someone else's job
    expect((await report("00000000-0000-4000-8000-000000000000", { status: "validating" })).statusCode).toBe(404);
    for (const bad of [{ status: "hacked" }, { status: "failed", error_code: "Bad Code!" }, { status: "failed", extra: 1 }, {}]) expect((await report(id, bad)).statusCode).toBe(400);
    expect((await report("not-a-uuid", { status: "failed" })).statusCode).toBe(400);
    expect((await report(id, { status: "validating", step: "extracting" })).statusCode).toBe(200);
    expect((await report(id, { status: "validating" })).statusCode).toBe(409); // no repeats
    expect((await report(id, { status: "published", ssl: true })).statusCode).toBe(200);
    for (const st of ["failed", "rolled_back", "validating", "published"]) expect((await report(id, { status: st })).statusCode).toBe(409); // terminal is final
  });

  it("published: the URL uses https only when the agent says the certificate is ready", async () => {
    const withSsl = await paidSession("whmcs-18", "ssl.sites.test");
    const a = deployId(await publish(withSsl.token, STATIC));
    await job(TOKEN_A);
    await report(a, { status: "validating" });
    await report(a, { status: "published", ssl: true });
    expect(await statusOf(withSsl.token, a)).toMatchObject({ codigo: "DEPLOY_PUBLICADO", dados: { status: "publicado", url: "https://ssl.sites.test", https_ativo: true, intervalo_sugerido_segundos: 0 } });

    const noSsl = await paidSession("whmcs-18", "nossl.sites.test");
    const b = deployId(await publish(noSsl.token, STATIC));
    await job(TOKEN_A);
    await report(b, { status: "validating" });
    await report(b, { status: "published", ssl: false });
    expect(await statusOf(noSsl.token, b)).toMatchObject({ dados: { url: "http://nossl.sites.test", https_ativo: false } });
  });

  it("failures and rollbacks are told in plain words, never with the agent's error code", async () => {
    const f = await paidSession("whmcs-18");
    const id = deployId(await publish(f.token, STATIC));
    await job(TOKEN_A);
    await report(id, { status: "failed", step: "extract", error_code: "sha256_mismatch" });
    const r = await statusOf(f.token, id);
    expect(r).toMatchObject({ ok: true, codigo: "DEPLOY_FALHOU", dados: { status: "falhou", url: null } });
    expect(JSON.stringify(r)).not.toMatch(/sha256|mismatch|extract/);
    expect(r.mensagem_para_usuario).toContain("anterior continua no ar");

    const rb = await paidSession("whmcs-18");
    const id2 = deployId(await publish(rb.token, STATIC));
    await job(TOKEN_A);
    await report(id2, { status: "validating" });
    await report(id2, { status: "rolled_back", error_code: "local_check_failed" });
    expect(await statusOf(rb.token, id2)).toMatchObject({ codigo: "DEPLOY_REVERTIDO", dados: { status: "revertido", url: null } });
    // a failed deploy frees the site for a new attempt
    expect(await call("publicar", { sessao_id: rb.token })).toMatchObject({ ok: true, codigo: "DEPLOY_INICIADO" });
  });

  it("a session only ever sees its own deploys", async () => {
    const mine = await paidSession();
    const theirs = await paidSession();
    const id = deployId(await publish(theirs.token, STATIC));
    expect(await call("status_deploy", { sessao_id: mine.token, deploy_id: id })).toMatchObject({ ok: false, codigo: "DEPLOY_NAO_ENCONTRADO" });
    expect(await call("status_deploy", { sessao_id: "z".repeat(43), deploy_id: id })).toMatchObject({ codigo: "SESSAO_INVALIDA" });
  });
});

describe("agent tokens and stale jobs", () => {
  it("syncAgentTokens is idempotent, replaces a rotated token and rejects malformed specs", async () => {
    const t1 = "d4".repeat(32);
    const t2 = "e5".repeat(32);
    expect(await syncAgentTokens(db, `rot-1:${t1}`)).toEqual(["rot-1"]);
    expect(await syncAgentTokens(db, `rot-1:${t1}`)).toEqual(["rot-1"]);
    expect((await job(t1)).statusCode).toBe(204);
    await syncAgentTokens(db, `rot-1:${t2}`);
    expect((await job(t1)).statusCode).toBe(401); // the old token is dead
    expect((await job(t2)).statusCode).toBe(204);
    expect(await syncAgentTokens(db, undefined)).toEqual([]);
    for (const bad of ["x", "x:short", `UP:${t1}`, `../x:${t1}`]) await expect(syncAgentTokens(db, bad)).rejects.toThrow(/AGENT_TOKENS/);
  });

  it("jobs whose agent went silent do not stay 'in progress' forever", async () => {
    const claimed = await paidSession();
    const waiting = await paidSession();
    const fresh = await paidSession();
    const a = deployId(await publish(claimed.token, STATIC));
    const b = deployId(await publish(waiting.token, STATIC));
    const c = deployId(await publish(fresh.token, STATIC));
    await db.query("UPDATE deploys SET status = 'sending', claimed_at = now() - interval '20 minutes' WHERE id = $1", [a]);
    await db.query("UPDATE deploys SET created_at = now() - interval '40 minutes' WHERE id = $1", [b]);
    expect(await failStaleDeploys(db)).toBeGreaterThanOrEqual(2);
    const rows = await db.query<{ id: string; status: string; error_code: string | null }>("SELECT id, status, error_code FROM deploys WHERE id = ANY($1)", [[a, b, c]]);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect([by[a]!.status, by[a]!.error_code]).toEqual(["failed", "agent_timeout"]);
    expect([by[b]!.status, by[b]!.error_code]).toEqual(["failed", "agent_unavailable"]);
    expect(by[c]!.status).toBe("queued");
    expect(await statusOf(claimed.token, a)).toMatchObject({ codigo: "DEPLOY_FALHOU" });
  });
});

describe("verificar_site", () => {
  beforeEach(drainQueue);

  const html = (links: string[]) => `<html><body>${links.map((l) => `<a href="${l}">x</a>`).join("")}<img src="/logo.png"></body></html>`;
  const res = (status: number, body = "", headers: Record<string, string> = {}) => new Response(body, { status, headers });

  async function published(domain: string) {
    const s = await paidSession("whmcs-18", domain);
    const id = deployId(await publish(s.token, STATIC));
    await job(TOKEN_A);
    await report(id, { status: "validating" });
    await report(id, { status: "published", ssl: true });
    return s;
  }

  it("needs a published deploy", async () => {
    const s = await paidSession();
    expect(await call("verificar_site", { sessao_id: s.token })).toMatchObject({ ok: false, codigo: "DEPLOY_NAO_ENCONTRADO" });
    expect(await call("verificar_site", { sessao_id: "z".repeat(43) })).toMatchObject({ codigo: "SESSAO_INVALIDA" });
  });

  it("healthy site: 200 over https, internal links fine, and the result is stored", async () => {
    const s = await published("ok.sites.test");
    fetchImpl = (u) => (u.pathname === "/" ? res(200, html(["/a.css", "https://ok.sites.test/b", "mailto:x@y.z", "#top", "https://outside.example/x"])) : res(200, "ok"));
    fetched = [];
    const r = await call("verificar_site", { sessao_id: s.token });
    envelopeSchema(saidas.verificar_site).parse(r);
    expect(r).toMatchObject({ ok: true, codigo: "SITE_VERIFICADO", dados: { http_status: 200, ssl_ok: true, links_quebrados: 0 } });
    expect(fetched).toContain("https://ok.sites.test/a.css");
    expect(fetched).toContain("https://ok.sites.test/logo.png");
    expect(fetched.some((u) => u.includes("outside.example"))).toBe(false); // external links are never fetched
    const [v] = await db.query("SELECT http_status, ssl_ok, broken_links FROM verifications ORDER BY created_at DESC LIMIT 1");
    expect(v).toEqual({ http_status: 200, ssl_ok: true, broken_links: 0 });
  });

  it("counts broken internal links", async () => {
    const s = await published("links.sites.test");
    fetchImpl = (u) => (u.pathname === "/" ? res(200, html(["/ok", "/missing", "/boom"])) : u.pathname === "/boom" ? Promise.reject(new Error("net")) : u.pathname === "/missing" ? res(404) : res(200));
    const r = await call("verificar_site", { sessao_id: s.token });
    expect(r).toMatchObject({ codigo: "SITE_COM_PROBLEMAS", dados: { http_status: 200, ssl_ok: true, links_quebrados: 2 } }); // /missing (404) and /boom (network error); /logo.png is fine
  });

  it("https not ready: falls back to http and reports ssl_ok false", async () => {
    const s = await published("nossl2.sites.test");
    fetchImpl = (u) => (u.protocol === "https:" ? Promise.reject(new Error("cert")) : res(200, "<html>hi</html>"));
    const r = await call("verificar_site", { sessao_id: s.token });
    expect(r).toMatchObject({ codigo: "SITE_COM_PROBLEMAS", dados: { http_status: 200, ssl_ok: false } });
    expect(r.proximo_passo).toMatch(/HTTPS/);
  });

  it("site down: status 0", async () => {
    const s = await published("down.sites.test");
    fetchImpl = () => Promise.reject(new Error("down"));
    expect(await call("verificar_site", { sessao_id: s.token })).toMatchObject({ codigo: "SITE_COM_PROBLEMAS", dados: { http_status: 0, ssl_ok: false, tempo_resposta_ms: 0 } });
  });

  it("never follows a redirect to another host (no SSRF through the customer's site)", async () => {
    const s = await published("ssrf.sites.test");
    fetched = [];
    fetchImpl = () => res(302, "", { location: "http://169.254.169.254/latest/meta-data/" });
    const r = await call("verificar_site", { sessao_id: s.token });
    expect(fetched.every((u) => u.includes("ssrf.sites.test"))).toBe(true);
    expect(r.dados).toMatchObject({ http_status: 302 });
  });

  it("follows same-host redirects (http -> https, www-less paths)", async () => {
    const s = await published("redir.sites.test");
    fetchImpl = (u) => (u.pathname === "/" ? res(301, "", { location: "/home" }) : u.pathname === "/home" ? res(200, "<html>home</html>") : res(200));
    expect(await call("verificar_site", { sessao_id: s.token })).toMatchObject({ codigo: "SITE_VERIFICADO", dados: { http_status: 200 } });
  });
});
