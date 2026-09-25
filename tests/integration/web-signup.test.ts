import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AddonError, httpAddonClient, type AddonClient, type SignupResult } from "../../apps/mcp-service/src/addon.js";
import { TOOLS } from "../../apps/mcp-service/src/mcp/tools/index.js";
import type { ToolContext } from "../../apps/mcp-service/src/mcp/tools/define.js";
import { buildApp } from "../../apps/mcp-service/src/server.js";
import { RateLimit } from "../../apps/mcp-service/src/web.js";
import { findSession } from "../../apps/mcp-service/src/sessions.js";
import { testCtx } from "../helpers.js";

type Req = Parameters<AddonClient["registerCheckout"]>[0];
let base: ReturnType<typeof testCtx> extends Promise<infer T> ? T : never;
let ctx: ToolContext;
let app: ReturnType<typeof buildApp>;
let calls: Req[] = [];
let answer: () => Promise<SignupResult>;

const REDIRECT = "https://app.test/sso/abc";
const success = async (): Promise<SignupResult> => ({ ok: true, errors: {}, redirect: REDIRECT, checkoutId: 77, fallbackUrl: null });
const form = { nome: "Maria da Silva", email: "maria@example.com", doc_tipo: "CPF", doc_numero: "529.982.247-25", telefone: "(11) 99999-8888", aceite: true, website: "" };

beforeAll(async () => {
  base = await testCtx();
  const addon: AddonClient = {
    registerCheckout: async (r) => {
      calls.push(r);
      return answer();
    },
    createCheckout: async () => {
      throw new Error("unused");
    },
    plans: async () => [],
  };
  ctx = { ...base.ctx, addon };
  app = buildApp(ctx);
});
afterAll(async () => {
  await app.close();
  await base.close();
});
beforeEach(() => {
  calls = [];
  answer = success;
});

const newSession = async () => ((await TOOLS.find((t) => t.name === "iniciar_sessao")!.handler(ctx, {} as never)).dados as { sessao_id: string }).sessao_id;
const post = async (body: object) => app.inject({ method: "POST", url: "/web/checkout", payload: body, headers: { "x-real-ip": `10.0.0.${Math.floor(Math.random() * 250)}` } });
const valid = async (extra: object = {}) => ({ sessao_id: await newSession(), plano_pid: 173, ciclo: "mensal", ...form, ...extra });

describe("POST /web/checkout", () => {
  it("forwards the form to the addon with the internal session id and returns only the payment redirect", async () => {
    const body = await valid({ ciclo: "anual" });
    const r = await post(body);
    expect([r.statusCode, r.json()]).toEqual([200, { ok: true, redirect: REDIRECT }]);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(calls).toHaveLength(1);
    const internal = (await findSession(ctx.db, body.sessao_id))!.id;
    expect(calls[0]).toMatchObject({ sessionId: internal, pid: 173, cycle: "annually", form });
    expect(calls[0]!.sessionId).not.toBe(body.sessao_id); // the token the browser holds never reaches WHMCS
    const [ref] = await ctx.db.query<{ checkout_id: string; cycle: string }>("SELECT checkout_id, cycle FROM checkout_refs WHERE session_id = $1", [internal]);
    expect(ref).toMatchObject({ checkout_id: "77", cycle: "anual" });
  });

  it("stores nothing personal: no e-mail, CPF, phone or name in any table", async () => {
    await post(await valid());
    const tables = await ctx.db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    let dump = "";
    for (const { table_name } of tables) dump += JSON.stringify(await ctx.db.query(`SELECT * FROM "${table_name}"`));
    for (const secret of ["maria@example.com", "529.982.247-25", "52998224725", "99999-8888", "Maria da Silva"]) expect(dump, secret).not.toContain(secret);
  });

  it("customer-facing errors from the addon pass through (known fields only), with the WHMCS fallback link", async () => {
    answer = async () => ({ ok: false, errors: { email: "Já existe uma conta com este e-mail.", evil: "<script>", _form: "x".repeat(500) }, redirect: null, checkoutId: null, fallbackUrl: "https://app.test/index.php?m=waycloud_ai&t=abc" });
    const r = await post(await valid());
    expect(r.statusCode).toBe(422);
    const j = r.json() as { ok: boolean; errors: Record<string, string>; fallback_url: string };
    expect(Object.keys(j.errors).sort()).toEqual(["_form", "email"]); // "evil" is dropped
    expect(j.errors._form!.length).toBeLessThanOrEqual(200);
    expect(j.fallback_url).toContain("t=abc");
  });

  it("refuses bad input, an unknown session and an unknown plan", async () => {
    expect((await post({ ...(await valid()), extra: 1 })).statusCode).toBe(400); // strict body
    expect((await post({ ...(await valid()), aceite: "sim" })).statusCode).toBe(400);
    expect((await post({ ...(await valid()), doc_tipo: "RG" })).statusCode).toBe(400);
    expect((await post({ ...(await valid()), sessao_id: "z".repeat(43) })).statusCode).toBe(401);
    expect((await post(await valid({ plano_pid: 999999 }))).statusCode).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it("without the addon configured, checkout is unavailable (not a crash)", async () => {
    const bare = buildApp({ ...ctx, addon: undefined });
    const r = await bare.inject({ method: "POST", url: "/web/checkout", payload: await valid() });
    expect(r.statusCode).toBe(503);
    await bare.close();
  });

  it("a failing addon answers 502 with a fixed message and logs no personal data", async () => {
    answer = async () => {
      throw new AddonError("unreachable", 0);
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await post(await valid());
    expect(r.statusCode).toBe(502);
    expect(JSON.stringify(r.json())).not.toContain("maria");
    const logged = spy.mock.calls.flat().join(" ");
    spy.mockRestore();
    expect(logged).toContain("web signup failed");
    for (const secret of ["maria@example.com", "529.982.247-25", "Maria"]) expect(logged).not.toContain(secret);
  });

  it("limits attempts per session (and the limiter forgets after its window)", async () => {
    const body = await valid();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await post(body)).statusCode);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes.slice(5)).toEqual([429, 429]);

    let t = 0;
    const rl = new RateLimit(1000, () => t);
    expect([rl.tooMany("a", 2), rl.tooMany("a", 2), rl.tooMany("a", 2)]).toEqual([false, false, true]);
    t = 1500;
    expect(rl.tooMany("a", 2)).toBe(false);
  });
});

describe("addon client: the links it returns must live on the WHMCS host", () => {
  const respond = (body: object) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  const req = { sessionId: "s", pid: 173, cycle: "monthly" as const, form: { ...form, doc_tipo: "CPF" as const } };
  const reply = (over: object) => ({ ok: true, errors: [], redirect: "https://app.test/sso/x", checkout_id: 1, fallback_url: null, ...over });

  it("accepts the same host and normalizes PHP's empty array of errors", async () => {
    const c = httpAddonClient({ url: "https://app.test/modules/addons/waycloud_ai/api.php", secret: "s".repeat(40), fetchFn: respond(reply({})) });
    expect(await c.registerCheckout(req)).toMatchObject({ ok: true, errors: {}, redirect: "https://app.test/sso/x", checkoutId: 1 });
  });

  it("refuses a redirect or fallback link on another host", async () => {
    for (const over of [{ redirect: "https://evil.example/pay" }, { ok: false, redirect: null, fallback_url: "https://evil.example/x" }]) {
      const c = httpAddonClient({ url: "https://app.test/modules/addons/waycloud_ai/api.php", secret: "s".repeat(40), fetchFn: respond(reply(over)) });
      await expect(c.registerCheckout(req)).rejects.toMatchObject({ code: "unexpected_host" });
    }
  });
});
