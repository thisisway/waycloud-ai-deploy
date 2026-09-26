import { strToU8 } from "fflate";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddonClient } from "../../apps/mcp-service/src/addon.js";
import { syncAgentTokens } from "../../apps/mcp-service/src/agent.js";
import type { Db } from "../../apps/mcp-service/src/db/index.js";
import { checkDns, checkDueDomains, isReserved, normalizeDomain, type Resolver } from "../../apps/mcp-service/src/domains.js";
import { TOOLS } from "../../apps/mcp-service/src/mcp/tools/index.js";
import type { ToolContext } from "../../apps/mcp-service/src/mcp/tools/define.js";
import { buildApp } from "../../apps/mcp-service/src/server.js";
import { findSession } from "../../apps/mcp-service/src/sessions.js";
import { testCtx } from "../helpers.js";

const TOKEN_A = "a1".repeat(32);
const TOKEN_B = "b2".repeat(32);
const TARGET = "hospedagem.waycloud.com.br";
const OURS = ["177.11.55.71"];

/** DNS as a table: host -> A records. Anything else does not resolve. */
const dnsMap = new Map<string, string[]>([[TARGET, OURS]]);
const nsMap = new Map<string, string[]>();
const NS = ["ns1.waycloud.com.br", "ns2.waycloud.com.br"];
const resolver: Resolver = {
  resolve4: async (h) => { const v = dnsMap.get(h); if (!v) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); return v; },
  resolveNs: async (h) => { const v = nsMap.get(h); if (!v) throw Object.assign(new Error("ENODATA"), { code: "ENODATA" }); return v; },
};
const pointToUs = (d: string, www = false) => (dnsMap.set(d, OURS), www && dnsMap.set(`www.${d}`, OURS));

let ctx: ToolContext;
let db: Db;
let app: ReturnType<typeof buildApp>;
let close: () => Promise<void>;
let synced: { serviceId: number; domain: string }[] = [];
let syncFails = 0;

beforeAll(async () => {
  const t = await testCtx();
  ({ db, close } = t);
  const addon = {
    plans: async () => [], createCheckout: async () => { throw new Error("unused"); }, registerCheckout: async () => { throw new Error("unused"); },
    updateServiceDomain: async (r) => { if (syncFails > 0) { syncFails--; throw Object.assign(new Error("x"), { code: "unreachable" }); } synced.push(r); },
  } as AddonClient;
  ctx = { ...t.ctx, addon, resolver };
  app = buildApp(ctx);
  await syncAgentTokens(db, `whmcs-18:${TOKEN_A},whmcs-19:${TOKEN_B}`);
});
afterAll(async () => {
  await app.close();
  await close();
});

const call = (name: string, args: unknown) => TOOLS.find((t) => t.name === name)!.handler(ctx, args as never);
let nextService = 7000;

/** A paid session whose site is live on the provisional domain. */
async function liveSite(server = "whmcs-18") {
  const token = ((await call("iniciar_sessao", {})).dados as { sessao_id: string }).sessao_id;
  const uuid = (await findSession(db, token))!.id;
  const service = nextService++;
  const domain = `s${service}.sites.test`;
  await db.query("INSERT INTO orders (session_id, status, whmcs_service_id) VALUES ($1, 'active', $2)", [uuid, service]);
  await db.query("INSERT INTO subscriptions (whmcs_service_id, session_id, server_id, domain, plan_pid) VALUES ($1, $2, $3, $4, 223)", [service, uuid, server, domain]);
  await call("enviar_arquivos", { sessao_id: token, arquivos: [{ caminho: "index.html", conteudo_base64: Buffer.from(strToU8("<h1>oi</h1>")).toString("base64") }] });
  const dep = await call("publicar", { sessao_id: token });
  await db.query("UPDATE deploys SET status = 'published', ssl = true WHERE id = $1", [(dep.dados as { deploy_id: string }).deploy_id]);
  return { token, uuid, service, domain, deployId: (dep.dados as { deploy_id: string }).deploy_id };
}
const post = (url: string, payload: object, headers: Record<string, string> = {}) => app.inject({ method: "POST", url, payload, headers });
const web = (path: string, sessao_id: string, extra: object = {}) => post(`/web/domain${path}`, { sessao_id, ...extra });
const agent = (path: string, token = TOKEN_A, payload: object = {}) => post(`/agent/v1${path}`, payload, { authorization: `Bearer ${token}` });
const statusOf = async (uuid: string) => (await db.query<{ status: string; ssl: boolean | null; whmcs_synced: boolean }>("SELECT status, ssl, whmcs_synced FROM domain_changes c JOIN subscriptions s ON s.whmcs_service_id = c.subscription_id WHERE s.session_id = $1 ORDER BY c.created_at DESC LIMIT 1", [uuid]))[0];

describe("domain names", () => {
  it.each([
    ["Meusite.com.br", "meusite.com.br"],
    ["https://www.MeuSite.com.br/pagina?x=1", "meusite.com.br"],
    ["  loja.meusite.com  ", "loja.meusite.com"],
    ["meusite.com.br.", "meusite.com.br"],
    ["exemplo.com:8080", "exemplo.com"],
    ["xn--caf-dma.com", "xn--caf-dma.com"],
  ])("accepts %j as %j", (input, out) => expect(normalizeDomain(input)).toBe(out));

  it.each(["", "localhost", "meusite", "192.168.0.1", "a b.com", "-x.com", "x-.com", "x..com", "meu_site.com", "*.meusite.com", "a.b", "exemplo.c0m", `${"a".repeat(64)}.com`, "http://", "ex ample.com"])("refuses %j", (input) => expect(normalizeDomain(input)).toBeNull());

  it("reserves what is ours", () => {
    for (const d of ["waypreview.com.br", "x.sites.waypreview.com.br", "app.waycloud.com.br", "waycloud.com.br", "abc.preview.test", "preview.test"]) expect(isReserved(d, "https://{slug}.preview.test"), d).toBe(true);
    for (const d of ["meusite.com.br", "notwaycloud.com.br", "waycloud.com.br.evil.com"]) expect(isReserved(d, "https://{slug}.preview.test"), d).toBe(false);
  });
});

describe("DNS check", () => {
  it("approves only when EVERY record is ours; www is reported on its own", async () => {
    dnsMap.set("ok.test", OURS);
    dnsMap.set("mixed.test", [...OURS, "203.0.113.9"]); // a leftover record would split the visitors
    dnsMap.set("elsewhere.test", ["203.0.113.9"]);
    dnsMap.set("www.ok.test", OURS);
    expect(await checkDns(resolver, "ok.test", TARGET, NS)).toEqual({ ok: true, www: true, via: "records" });
    expect(await checkDns(resolver, "mixed.test", TARGET, NS)).toEqual({ ok: false, www: false });
    expect(await checkDns(resolver, "elsewhere.test", TARGET, NS)).toEqual({ ok: false, www: false });
    expect(await checkDns(resolver, "missing.test", TARGET, NS)).toEqual({ ok: false, www: false });
  });

  it("never approves anything while our own target does not resolve", async () => {
    dnsMap.set("orphan.test", OURS);
    expect(await checkDns({ resolve4: async (h) => (h === TARGET ? Promise.reject(new Error("down")) : OURS), resolveNs: async () => Promise.reject(new Error("x")) }, "orphan.test", TARGET, NS)).toEqual({ ok: false, www: false });
  });

  it("nameservers: approved when they are ours (case and trailing dot ignored), and only ours", async () => {
    nsMap.set("delegado.test", ["NS1.waycloud.com.br.", "ns2.waycloud.com.br"]);
    nsMap.set("um.test", ["ns1.waycloud.com.br"]);
    nsMap.set("misto.test", ["ns1.waycloud.com.br", "ns.cloudflare.com"]);
    nsMap.set("cloudflare.test", ["ana.ns.cloudflare.com", "bob.ns.cloudflare.com"]);
    expect(await checkDns(resolver, "delegado.test", TARGET, NS)).toEqual({ ok: true, www: true, via: "ns" });
    expect(await checkDns(resolver, "um.test", TARGET, NS)).toMatchObject({ ok: true, via: "ns" });
    expect(await checkDns(resolver, "misto.test", TARGET, NS)).toEqual({ ok: false, www: false }); // a foreign nameserver would answer for some visitors
    expect(await checkDns(resolver, "cloudflare.test", TARGET, NS)).toEqual({ ok: false, www: false });
  });

  it("nameserver delegation works even while our A target does not resolve", async () => {
    const noTarget: Resolver = { resolve4: async () => Promise.reject(new Error("down")), resolveNs: async (h) => (h === "delegado.test" ? NS : Promise.reject(new Error("x"))) };
    expect(await checkDns(noTarget, "delegado.test", TARGET, NS)).toMatchObject({ ok: true, via: "ns" });
  });
});

describe("customer flow: request, DNS, agent switch, WHMCS", () => {
  it("waits for the DNS (showing the records), moves to ready when it is right, then the agent switches and the site answers on the new domain", async () => {
    const s = await liveSite();
    const r = await web("", s.token, { dominio: "https://Meusite.com.br/" });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { status: string; dominio: string; dns: { alvo: string; ip: string; nameservers: string[]; registros: { tipo: string; nome: string; valor: string }[] } };
    expect([body.status, body.dominio]).toEqual(["waiting_dns", "meusite.com.br"]);
    expect(body.dns.alvo).toBe(TARGET);
    expect(body.dns.registros[0]).toMatchObject({ tipo: "A", nome: "meusite.com.br", valor: OURS[0] }); // the IP is ours, resolved from the target
    expect(body.dns.registros[1]).toMatchObject({ tipo: "CNAME", nome: "www.meusite.com.br", valor: TARGET });
    expect(body.dns.nameservers).toEqual(NS); // the other way: point the nameservers to us

    expect(((await web("/status", s.token)).json() as { status: string }).status).toBe("waiting_dns"); // still not pointing to us
    expect((await agent("/domain-jobs/next")).statusCode).toBe(204); // nothing for the agent yet

    pointToUs("meusite.com.br", true);
    expect(((await web("/status", s.token)).json() as { status: string }).status).toBe("ready"); // checked as soon as the customer looks

    expect((await agent("/domain-jobs/next", TOKEN_B)).statusCode).toBe(204); // another server's agent gets nothing
    const job = await agent("/domain-jobs/next");
    expect(job.statusCode).toBe(200);
    expect(job.json()).toMatchObject({ domain: "meusite.com.br", old_domain: s.domain, include_www: true, dns_mode: "records" });
    const jobId = (job.json() as { job_id: string }).job_id;
    expect((await agent("/domain-jobs/next")).statusCode).toBe(204); // claimed only once
    expect(((await web("/status", s.token)).json() as { status: string }).status).toBe("switching");

    // The site still answers on the old domain until the agent says the switch is done.
    expect((await db.query<{ domain: string }>("SELECT domain FROM subscriptions WHERE session_id = $1", [s.uuid]))[0]!.domain).toBe(s.domain);
    expect((await agent(`/domain-jobs/${jobId}/report`, TOKEN_A, { status: "active", ssl: false })).statusCode).toBe(200);
    expect((await db.query<{ domain: string }>("SELECT domain FROM subscriptions WHERE session_id = $1", [s.uuid]))[0]!.domain).toBe("meusite.com.br");

    const st = (await web("/status", s.token)).json() as { status: string; https: boolean };
    expect([st.status, st.https]).toEqual(["active", false]);
    const deploy = (await call("status_deploy", { sessao_id: s.token, deploy_id: s.deployId })).dados as { url: string };
    expect(deploy.url).toBe("https://meusite.com.br"); // the deploy's ssl flag was already true

    // WHMCS is told (best effort right after the report; the timer retries)
    await vi.waitFor(async () => expect((await statusOf(s.uuid))!.whmcs_synced).toBe(true));
    expect(synced.at(-1)).toEqual({ serviceId: s.service, domain: "meusite.com.br" });

    // The certificate can arrive later: one upgrade, only to true.
    expect((await agent(`/domain-jobs/${jobId}/report`, TOKEN_A, { status: "active", ssl: false })).statusCode).toBe(409);
    expect((await agent(`/domain-jobs/${jobId}/report`, TOKEN_A, { status: "active" })).statusCode).toBe(409);
    expect((await agent(`/domain-jobs/${jobId}/report`, TOKEN_B, { status: "active", ssl: true })).statusCode).toBe(404);
    expect((await agent(`/domain-jobs/${jobId}/report`, TOKEN_A, { status: "active", ssl: true })).statusCode).toBe(200);
    expect(((await web("/status", s.token)).json() as { https: boolean }).https).toBe(true);
    expect((await agent(`/domain-jobs/${jobId}/report`, TOKEN_A, { status: "failed" })).statusCode).toBe(409); // final
  });

  it("a domain whose nameservers are ours becomes ready without any A record, and the agent is told to use nameserver mode", async () => {
    const s = await liveSite();
    await web("", s.token, { dominio: "novo-ns.test" });
    expect(((await web("/status", s.token)).json() as { status: string }).status).toBe("waiting_dns");
    nsMap.set("novo-ns.test", NS); // the customer changed the nameservers at their registrar; no A record answers yet
    expect(((await web("/status", s.token)).json() as { status: string }).status).toBe("ready");
    const job = (await agent("/domain-jobs/next")).json() as { domain: string; dns_mode: string; include_www: boolean };
    expect(job).toMatchObject({ domain: "novo-ns.test", dns_mode: "ns", include_www: true });
  });

  it("failed switch changes nothing: the site keeps its domain", async () => {
    const s = await liveSite();
    pointToUs("falha.test");
    await web("", s.token, { dominio: "falha.test" });
    await web("/status", s.token);
    const job = (await agent("/domain-jobs/next")).json() as { job_id: string };
    expect((await agent(`/domain-jobs/${job.job_id}/report`, TOKEN_A, { status: "failed", error_code: "rename_failed" })).statusCode).toBe(200);
    expect((await db.query<{ domain: string }>("SELECT domain FROM subscriptions WHERE session_id = $1", [s.uuid]))[0]!.domain).toBe(s.domain);
    expect((await statusOf(s.uuid))!.status).toBe("failed");
    expect(synced.some((x) => x.domain === "falha.test")).toBe(false);
  });

  it("WHMCS being unreachable does not undo the switch; the maintenance timer syncs it later", async () => {
    const s = await liveSite();
    pointToUs("sync.test");
    await web("", s.token, { dominio: "sync.test" });
    const job = (await agent("/domain-jobs/next")).json() as { job_id: string };
    syncFails = 1;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await agent(`/domain-jobs/${job.job_id}/report`, TOKEN_A, { status: "active", ssl: true })).statusCode).toBe(200);
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    errors.mockRestore();
    expect((await statusOf(s.uuid))!.whmcs_synced).toBe(false);
    const { syncWhmcsDomains } = await import("../../apps/mcp-service/src/domains.js");
    expect(await syncWhmcsDomains(ctx)).toBeGreaterThanOrEqual(1);
    expect((await statusOf(s.uuid))!.whmcs_synced).toBe(true);
  });

  it("the request can be cancelled, and a new one replaces one that is still waiting", async () => {
    const s = await liveSite();
    await web("", s.token, { dominio: "primeiro.test" });
    await web("", s.token, { dominio: "segundo.test" });
    expect((await db.query("SELECT c.domain, c.status FROM domain_changes c JOIN subscriptions s ON s.whmcs_service_id = c.subscription_id WHERE s.session_id = $1 ORDER BY c.created_at", [s.uuid]))).toMatchObject([{ domain: "primeiro.test", status: "cancelled" }, { domain: "segundo.test", status: "waiting_dns" }]);
    expect((await web("/cancel", s.token)).json()).toEqual({ ok: true, cancelado: true });
    expect(((await web("/status", s.token)).json() as { status: string }).status).toBe("cancelled");
    expect((await web("", s.token, { dominio: "primeiro.test" })).statusCode).toBe(200); // free again
  });

  it("expires after a week without DNS, and a switch that never reports back is flagged", async () => {
    const s = await liveSite();
    await web("", s.token, { dominio: "velho.test" });
    await db.query("UPDATE domain_changes SET created_at = now() - interval '8 days' WHERE domain = 'velho.test'");
    await checkDueDomains(ctx, resolver);
    expect((await statusOf(s.uuid))!.status).toBe("expired");

    const s2 = await liveSite();
    pointToUs("preso.test");
    await web("", s2.token, { dominio: "preso.test" });
    await agent("/domain-jobs/next");
    await db.query("UPDATE domain_changes SET claimed_at = now() - interval '2 hours' WHERE domain = 'preso.test'");
    const { failStaleSwitches } = await import("../../apps/mcp-service/src/domains.js");
    expect(await failStaleSwitches(db)).toBe(1);
    expect((await statusOf(s2.uuid))!.status).toBe("failed");
  });
});

describe("agent diagnostics", () => {
  it("are accepted from an authenticated agent, logged for the maintainer, size-capped and validated", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const id = "0c16991c-4207-42ec-8577-9dd1ccc900ae";
    expect((await agent("/diag", TOKEN_A, { job_id: id, kind: "rename_failed", text: "== plesk.log\nerror: something" })).statusCode).toBe(200);
    const line = JSON.parse(log.mock.calls.flat().find((l) => String(l).includes("agent diag")) as string);
    expect(line).toMatchObject({ msg: "agent diag", server: "whmcs-18", job: id, kind: "rename_failed" });
    expect(line.text).toContain("something");
    log.mockRestore();
    expect((await agent("/diag", TOKEN_A, { job_id: id, kind: "Bad Kind!", text: "x" })).statusCode).toBe(400);
    expect((await agent("/diag", TOKEN_A, { job_id: "nope", kind: "ok", text: "x" })).statusCode).toBe(400);
    expect((await agent("/diag", TOKEN_A, { job_id: id, kind: "ok", text: "x".repeat(20_001) })).statusCode).toBe(400);
    expect((await agent("/diag", TOKEN_A, { job_id: id, kind: "ok", text: "x", extra: 1 })).statusCode).toBe(400);
    expect((await post("/agent/v1/diag", { job_id: id, kind: "ok", text: "x" })).statusCode).toBe(401); // no token
  });
});

describe("what is refused", () => {
  it("bad names, our own domains, a domain held by another site, no published site, no paid plan, unknown session", async () => {
    const s = await liveSite();
    const refuse = async (dominio: string, code: string, status: number) => {
      const r = await web("", s.token, { dominio });
      expect([r.statusCode, (r.json() as { codigo: string }).codigo], dominio).toEqual([status, code]);
    };
    await refuse("meusite", "DOMINIO_INVALIDO", 422);
    await refuse("192.168.1.1", "DOMINIO_INVALIDO", 422);
    await refuse("loja.waypreview.com.br", "DOMINIO_RESERVADO", 422);
    await refuse("app.waycloud.com.br", "DOMINIO_RESERVADO", 422);

    const other = await liveSite();
    await web("", other.token, { dominio: "disputado.test" });
    await refuse("disputado.test", "DOMINIO_EM_USO", 409); // someone else is already connecting it
    await refuse(other.domain, "DOMINIO_EM_USO", 409); // another site's provisional domain

    const unpublished = await liveSite();
    await db.query("UPDATE deploys SET status = 'failed' WHERE id = $1", [unpublished.deployId]);
    await refuse2(unpublished.token, "livre.test", "SEM_SITE_PUBLICADO");

    const bare = ((await call("iniciar_sessao", {})).dados as { sessao_id: string }).sessao_id; // never paid
    await refuse2(bare, "livre.test", "SEM_PLANO_ATIVO");

    expect((await web("", "z".repeat(43), { dominio: "livre.test" })).statusCode).toBe(401);
    expect((await web("", s.token, { dominio: "livre.test", extra: 1 })).statusCode).toBe(400); // strict body
    expect((await web("/status", "z".repeat(43))).statusCode).toBe(401);
    expect((await web("/status", s.token)).json()).toEqual({ ok: true, status: "none" });
  });

  it("limits requests per session", async () => {
    const s = await liveSite();
    const codes: number[] = [];
    for (let i = 0; i < 17; i++) codes.push((await web("", s.token, { dominio: "meusite" })).statusCode);
    expect(codes.slice(0, 15).every((c) => c === 422)).toBe(true);
    expect(codes.slice(15)).toEqual([429, 429]);
  });
});

async function refuse2(token: string, dominio: string, code: string) {
  const r = await web("", token, { dominio });
  expect([r.statusCode, (r.json() as { codigo: string }).codigo]).toEqual([422, code]);
}
