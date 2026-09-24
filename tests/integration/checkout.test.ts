import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { envelopeSchema, saidas, type Envelope } from "../../packages/shared/src/index.js";
import { AddonError, httpAddonClient, type AddonClient } from "../../apps/mcp-service/src/addon.js";
import { TOOLS } from "../../apps/mcp-service/src/mcp/tools/index.js";
import type { ToolContext } from "../../apps/mcp-service/src/mcp/tools/define.js";
import { verify } from "../../apps/mcp-service/src/security/hmac.js";
import { testCtx } from "../helpers.js";

const SECRET = "0123456789abcdef0123456789abcdef";

let ctx: ToolContext;
let close: () => Promise<void>;
let calls: { sessionId: string; pid: number; cycle: string }[] = [];
let behavior: () => Promise<{ checkoutId: number; url: string; expiresAt: string }>;
const okReply = async () => ({ checkoutId: 41, url: "https://app.test/index.php?m=waycloud_ai&t=TOKEN", expiresAt: "2026-09-26T12:00:00.000Z" });

beforeAll(async () => {
  const t = await testCtx();
  close = t.close;
  const addon: AddonClient = {
    createCheckout: async (r) => {
      calls.push(r);
      return behavior();
    },
    plans: async () => [],
  };
  ctx = { ...t.ctx, addon };
});
afterAll(async () => close());

const call = (name: string, args: unknown, c: ToolContext = ctx) => TOOLS.find((t) => t.name === name)!.handler(c, args as never);
const newSession = async () => ((await call("iniciar_sessao", {})).dados as { sessao_id: string }).sessao_id;

describe("criar_checkout", () => {
  it("returns only the link and its expiry, and records the reference", async () => {
    calls = [];
    behavior = okReply;
    const sessao_id = await newSession();
    const r = await call("criar_checkout", { sessao_id, plano_pid: 173, ciclo: "anual" });
    envelopeSchema(saidas.criar_checkout).parse(r);
    expect(r).toMatchObject({ ok: true, codigo: "CHECKOUT_CRIADO", dados: { url_checkout: "https://app.test/index.php?m=waycloud_ai&t=TOKEN" } });
    expect(Object.keys(r.dados as object).sort()).toEqual(["expira_em", "url_checkout"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ pid: 173, cycle: "annually" }); // ciclo is translated for WHMCS
    // the addon receives the internal session uuid, never the bearer token the AI holds
    expect(calls[0]!.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0]!.sessionId).not.toBe(sessao_id);
    const refs = await ctx.db.query<{ checkout_id: string; pid: number; cycle: string }>("SELECT checkout_id, pid, cycle FROM checkout_refs WHERE checkout_id = '41'");
    expect(refs).toEqual([{ checkout_id: "41", pid: 173, cycle: "anual" }]);
  });

  it("monthly maps to WHMCS 'monthly'", async () => {
    calls = [];
    behavior = okReply;
    await call("criar_checkout", { sessao_id: await newSession(), plano_pid: 174, ciclo: "mensal" });
    expect(calls[0]).toMatchObject({ pid: 174, cycle: "monthly" });
  });

  it("refuses unknown sessions and unknown plans before calling the addon", async () => {
    calls = [];
    behavior = okReply;
    expect(await call("criar_checkout", { sessao_id: "z".repeat(43), plano_pid: 173, ciclo: "mensal" })).toMatchObject({ ok: false, codigo: "SESSAO_INVALIDA" });
    expect(await call("criar_checkout", { sessao_id: await newSession(), plano_pid: 99999, ciclo: "mensal" })).toMatchObject({ ok: false, codigo: "PLANO_INVALIDO" });
    expect(calls).toHaveLength(0);
  });

  it("without an addon configured it says the checkout is unavailable", async () => {
    const { addon: _unused, ...withoutAddon } = ctx;
    expect(await call("criar_checkout", { sessao_id: await newSession(), plano_pid: 173, ciclo: "mensal" }, withoutAddon)).toMatchObject({ ok: false, codigo: "CHECKOUT_INDISPONIVEL" });
  });

  it("maps addon failures to friendly messages and never leaks the cause", async () => {
    const sessao_id = await newSession();
    behavior = async () => {
      throw new AddonError("invalid_plan", 422);
    };
    expect(await call("criar_checkout", { sessao_id, plano_pid: 173, ciclo: "mensal" })).toMatchObject({ codigo: "PLANO_INVALIDO" });
    for (const err of [new AddonError("unreachable", 0), new AddonError("unauthorized", 401), new AddonError("http_500", 500), new Error("connect ECONNREFUSED 10.0.0.5:443 secret-host")]) {
      behavior = async () => {
        throw err;
      };
      const r = await call("criar_checkout", { sessao_id, plano_pid: 173, ciclo: "mensal" });
      expect(r).toMatchObject({ ok: false, codigo: "CHECKOUT_INDISPONIVEL" });
      expect(JSON.stringify(r)).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|secret-host|unauthorized|http_500/);
    }
  });
});

describe("httpAddonClient against a real local server", () => {
  let server: Server;
  let url: string;
  let seen: { method?: string; headers: IncomingMessage["headers"]; body: string; verdict: string }[] = [];
  let respond: (req: IncomingMessage, res: ServerResponse, body: string) => void;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", async () => {
        const h = req.headers;
        const verdict = await verify(ctx.db, SECRET, { ts: Number(h["x-waycloud-timestamp"]), nonce: String(h["x-waycloud-nonce"]), signature: String(h["x-waycloud-signature"]) }, body);
        seen.push({ method: req.method, headers: h, body, verdict });
        respond(req, res, body);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/modules/addons/waycloud_ai/api.php`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const req = { sessionId: "6f1c2d3e-0000-4000-8000-0123456789ab", pid: 173, cycle: "monthly" as const };
  const good = () => ({ checkout_id: 7, checkout_url: `${url.replace(/\/modules.*/, "")}/index.php?m=waycloud_ai&t=abc`, expires_at: "2026-09-26T00:00:00Z" });

  it("sends a signed POST that the receiving side verifies, with the documented body", async () => {
    seen = [];
    respond = (_q, res) => json(res, 200, good());
    const r = await httpAddonClient({ url, secret: SECRET }).createCheckout(req);
    expect(r).toMatchObject({ checkoutId: 7, expiresAt: "2026-09-26T00:00:00Z" });
    expect(seen[0]).toMatchObject({ method: "POST", verdict: "ok" });
    expect(JSON.parse(seen[0]!.body)).toEqual({ action: "create_checkout", session_id: req.sessionId, pid: 173, cycle: "monthly" });
    expect(seen[0]!.headers["content-type"]).toBe("application/json");
    expect(String(seen[0]!.headers["x-waycloud-nonce"])).toMatch(/^[0-9a-f]{32}$/);
  });

  it("every request uses a fresh nonce (no replay by construction)", async () => {
    seen = [];
    respond = (_q, res) => json(res, 200, good());
    const c = httpAddonClient({ url, secret: SECRET });
    await c.createCheckout(req);
    await c.createCheckout(req);
    expect(seen.map((s) => s.verdict)).toEqual(["ok", "ok"]);
    expect(seen[0]!.headers["x-waycloud-nonce"]).not.toBe(seen[1]!.headers["x-waycloud-nonce"]);
  });

  it("turns addon answers into AddonError with a stable code and status", async () => {
    const c = httpAddonClient({ url, secret: SECRET });
    respond = (_q, res) => json(res, 401, { error: "unauthorized" });
    await expect(c.createCheckout(req)).rejects.toMatchObject({ code: "unauthorized", status: 401 });
    respond = (_q, res) => json(res, 422, { error: "invalid_plan" });
    await expect(c.createCheckout(req)).rejects.toMatchObject({ code: "invalid_plan", status: 422 });
    respond = (_q, res) => {
      res.writeHead(502);
      res.end("<html>bad gateway</html>");
    };
    await expect(c.createCheckout(req)).rejects.toMatchObject({ code: "http_502", status: 502 });
    respond = (_q, res) => json(res, 200, { unexpected: true });
    await expect(c.createCheckout(req)).rejects.toMatchObject({ code: "bad_response" });
  });

  it("refuses a checkout link that points to another host", async () => {
    respond = (_q, res) => json(res, 200, { ...good(), checkout_url: "https://evil.example/index.php?t=abc" });
    await expect(httpAddonClient({ url, secret: SECRET }).createCheckout(req)).rejects.toMatchObject({ code: "unexpected_host" });
  });

  it("reports an unreachable or hanging addon as 'unreachable'", async () => {
    await expect(httpAddonClient({ url: "http://127.0.0.1:1/api.php", secret: SECRET }).createCheckout(req)).rejects.toMatchObject({ code: "unreachable", status: 0 });
    respond = () => {}; // never answers
    await expect(httpAddonClient({ url, secret: SECRET, timeoutMs: 300 }).createCheckout(req)).rejects.toMatchObject({ code: "unreachable" });
  });

  it("a wrong secret is rejected by the receiving side", async () => {
    seen = [];
    respond = (_q, res) => json(res, 200, good());
    await httpAddonClient({ url, secret: "another-secret-another-secret-1234" }).createCheckout(req);
    expect(seen[0]!.verdict).toBe("bad_signature");
  });
});

// keep the type import used
export type _Env = Envelope;
