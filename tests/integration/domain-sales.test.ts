import { strToU8 } from "fflate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { syncAgentTokens } from "../../apps/mcp-service/src/agent.js";
import type { AddonClient, DomainOrderResult, DomainOrderStatus } from "../../apps/mcp-service/src/addon.js";
import type { Db } from "../../apps/mcp-service/src/db/index.js";
import { advanceOpenPurchases, candidates } from "../../apps/mcp-service/src/domain-sales.js";
import type { Resolver } from "../../apps/mcp-service/src/domains.js";
import { TOOLS } from "../../apps/mcp-service/src/mcp/tools/index.js";
import type { ToolContext } from "../../apps/mcp-service/src/mcp/tools/define.js";
import { buildApp } from "../../apps/mcp-service/src/server.js";
import { findSession } from "../../apps/mcp-service/src/sessions.js";
import { testCtx } from "../helpers.js";

const PREVIEW = "https://{slug}.preview.test";
const ADDRESS = { cep: "01310-100", logradouro: "Avenida Paulista", numero: "1000", complemento: "", bairro: "Bela Vista", cidade: "São Paulo", uf: "SP" };
const QR = "data:image/png;base64,iVBORw0KGgo=";
const noDns: Resolver = { resolve4: async () => Promise.reject(new Error("x")), resolveNs: async () => Promise.reject(new Error("x")), resolveMx: async () => Promise.reject(new Error("x")) };

let ctx: ToolContext;
let db: Db;
let app: ReturnType<typeof buildApp>;
let close: () => Promise<void>;
let whmcsStatus: DomainOrderStatus;
let orderAnswer: () => Promise<DomainOrderResult>;
let seen: { orders: unknown[]; cancels: number };
let nextService = 9100;
let nextOrder = 500;

const okOrder = async (): Promise<DomainOrderResult> => ({ ok: true, errors: {}, orderId: nextOrder++, invoiceId: 900, redirect: "https://app.test/sso/x", priceCents: 5000 });

beforeAll(async () => {
  const t = await testCtx();
  ({ db, close } = t);
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  const addon: AddonClient = {
    plans: async () => [],
    createCheckout: unused,
    registerCheckout: unused,
    updateServiceDomain: async () => {},
    pixCharge: async () => null,
    cardCharge: unused,
    domainSearch: async (names) => names.map((d) => ({ domain: d, available: !d.startsWith("ocupado"), priceCents: d.endsWith(".com.br") ? 5000 : 7900 })),
    domainOrder: async (r) => {
      seen.orders.push(r);
      return orderAnswer();
    },
    domainOrderStatus: async (r) => ({ status: whmcsStatus, domain: `${r.orderId}` }),
    domainOrderPix: async () => ({ copyPaste: "000201PIX", qrImage: QR, amountCents: 5000, expiresAt: "2026-09-29 12:00:00" }),
    domainOrderCancel: async () => (seen.cancels++, true),
  };
  ctx = { ...t.ctx, addon, resolver: noDns };
  app = buildApp(ctx);
  await syncAgentTokens(db, `whmcs-18:${"a1".repeat(32)}`);
});
afterAll(async () => {
  await app.close();
  await close();
});
beforeEach(() => {
  whmcsStatus = "awaiting_payment";
  orderAnswer = okOrder;
  seen = { orders: [], cancels: 0 };
});

const call = (name: string, args: unknown) => TOOLS.find((t) => t.name === name)!.handler(ctx, args as never);
const post = (path: string, sessao_id: string, extra: object = {}) => app.inject({ method: "POST", url: `/web/domain${path}`, payload: { sessao_id, ...extra } });
const buy = (sessao_id: string, dominio = "meusite.com.br", endereco: object = ADDRESS) => post("/buy", sessao_id, { dominio, endereco });

/** A paid session with a live site and its AI checkout (which owns the WHMCS client). */
async function liveSite(withCheckout = true) {
  const token = ((await call("iniciar_sessao", {})).dados as { sessao_id: string }).sessao_id;
  const uuid = (await findSession(db, token))!.id;
  const service = nextService++;
  await db.query("INSERT INTO orders (session_id, status, whmcs_service_id) VALUES ($1, 'active', $2)", [uuid, service]);
  await db.query("INSERT INTO subscriptions (whmcs_service_id, session_id, server_id, domain, plan_pid) VALUES ($1, $2, 'whmcs-18', $3, 223)", [service, uuid, `s${service}.sites.test`]);
  await call("enviar_arquivos", { sessao_id: token, arquivos: [{ caminho: "index.html", conteudo_base64: Buffer.from(strToU8("<h1>oi</h1>")).toString("base64") }] });
  const dep = await call("publicar", { sessao_id: token });
  await db.query("UPDATE deploys SET status = 'published', ssl = true WHERE id = $1", [(dep.dados as { deploy_id: string }).deploy_id]);
  if (withCheckout) await db.query("INSERT INTO checkout_refs (session_id, checkout_id, pid, cycle) VALUES ($1, '77', 223, 'mensal')", [uuid]);
  return { token, uuid };
}

describe("what to look up", () => {
  it("a bare name gets the usual endings; a full domain is taken as typed; ours and junk are refused", () => {
    expect(candidates("MinhaLoja", PREVIEW)).toEqual(["minhaloja.com.br", "minhaloja.com", "minhaloja.net", "minhaloja.app.br"]);
    expect(candidates("https://www.Loja.com.br/x", PREVIEW)).toEqual(["loja.com.br"]);
    expect(candidates("waycloud.com.br", PREVIEW)).toEqual([]);
    expect(candidates("preview", PREVIEW)).toEqual(["preview.com.br", "preview.com", "preview.net", "preview.app.br"]);
    for (const junk of ["a", "-x", "x y", "meu_site", "192.168.0.1", ""]) expect(candidates(junk, PREVIEW), junk).toEqual([]);
  });
});

describe("POST /web/domain/search", () => {
  it("answers with availability and the yearly price of each candidate", async () => {
    const { token } = await liveSite();
    const r = await post("/search", token, { nome: "ocupado" });
    expect(r.statusCode).toBe(200);
    expect(r.json().resultados[0]).toEqual({ dominio: "ocupado.com.br", disponivel: false, valor_centavos: 5000 });
    expect(r.json().resultados).toHaveLength(4);
  });
  it("refuses junk and unknown sessions", async () => {
    const { token } = await liveSite();
    expect((await post("/search", token, { nome: "a b" })).statusCode).toBe(422);
    expect((await post("/search", "6f1c2d3e-0000-4000-8000-0123456789ab", { nome: "loja" })).statusCode).toBe(401);
  });
});

describe("POST /web/domain/buy", () => {
  it("orders through the addon with the internal session id and the checkout, returns the Pix and keeps no address", async () => {
    const { token, uuid } = await liveSite();
    const r = await buy(token, "Loja-Bonita.com.br");
    expect([r.statusCode, r.json().ok, r.json().dominio, r.json().valor_centavos, r.json().pix?.copia_cola, r.json().pix?.qr, r.json().fatura_url]).toEqual([200, true, "loja-bonita.com.br", 5000, "000201PIX", QR, "https://app.test/sso/x"]);
    expect(seen.orders).toEqual([{ sessionId: uuid, checkoutId: 77, domain: "loja-bonita.com.br", address: { ...ADDRESS } }]);
    const tables = await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    let dump = "";
    for (const { table_name } of tables) dump += JSON.stringify(await db.query(`SELECT * FROM "${table_name}"`));
    for (const secret of ["Avenida Paulista", "Bela Vista", "01310-100", "01310100"]) expect(dump, secret).not.toContain(secret);
  });

  it("one purchase at a time per session, and nobody else can take the same domain meanwhile", async () => {
    const a = await liveSite();
    const b = await liveSite();
    expect((await buy(a.token, "unico.com.br")).statusCode).toBe(200);
    expect((await buy(a.token, "outro.com.br")).json().codigo).toBe("COMPRA_EM_ANDAMENTO");
    expect((await buy(b.token, "unico.com.br")).json().codigo).toBe("DOMINIO_EM_USO");
  });

  it("needs a paid plan; refuses reserved and invalid domains", async () => {
    const { token } = await liveSite(false);
    expect((await buy(token)).json().codigo).toBe("SEM_PLANO_ATIVO");
    const ok = await liveSite();
    expect((await buy(ok.token, "app.waycloud.com.br")).json().codigo).toBe("DOMINIO_INVALIDO");
    expect((await buy(ok.token, "nao é domínio")).statusCode).toBe(422);
    expect((await post("/buy", ok.token, { dominio: "x.com.br", endereco: { ...ADDRESS, extra: "x" } })).statusCode).toBe(400);
  });

  it("passes on the addon's field errors (known fields only) and creates nothing", async () => {
    const { token, uuid } = await liveSite();
    orderAnswer = async () => ({ ok: false, errors: { cep: "Informe o CEP com 8 números.", evil: "<script>" }, orderId: null, invoiceId: null, redirect: null, priceCents: null });
    const r = await buy(token);
    expect([r.statusCode, r.json().errors]).toEqual([422, { cep: "Informe o CEP com 8 números." }]);
    expect(await db.query("SELECT 1 FROM domain_purchases WHERE session_id = $1", [uuid])).toHaveLength(0);
  });
});

describe("following the purchase", () => {
  it("awaiting payment -> registering -> registered: the site is pointed at the domain by the nameserver method", async () => {
    const { token, uuid } = await liveSite();
    await buy(token, "registrado.com.br");
    const status = async () => (await post("/buy/status", token)).json();
    expect(await status()).toMatchObject({ status: "awaiting_payment", dominio: "registrado.com.br" });
    whmcsStatus = "registering";
    expect((await status()).status).toBe("registering");
    whmcsStatus = "registered";
    expect(await status()).toMatchObject({ status: "registered", mensagem: expect.stringContaining("registrado") });
    const [change] = await db.query<{ domain: string; method: string }>("SELECT c.domain, c.method FROM domain_changes c JOIN subscriptions s ON s.whmcs_service_id = c.subscription_id WHERE s.session_id = $1", [uuid]);
    expect(change).toEqual({ domain: "registrado.com.br", method: "ns" });
    const view = (await post("/status", token)).json();
    expect([view.dominio, view.comprado]).toEqual(["registrado.com.br", true]);
  });

  it("a failed registration is reported for the team to finish; the customer is told we are on it", async () => {
    const { token } = await liveSite();
    await buy(token, "falhou.com.br");
    whmcsStatus = "failed";
    expect(await (await post("/buy/status", token)).json()).toMatchObject({ status: "failed", mensagem: expect.stringContaining("equipe") });
  });

  it("nothing to show before any purchase", async () => {
    const { token } = await liveSite();
    expect((await post("/buy/status", token)).json()).toEqual({ ok: true, status: "none" });
  });
});

describe("giving up", () => {
  it("cancelling before paying cancels the WHMCS order and frees the domain", async () => {
    const { token } = await liveSite();
    await buy(token, "desisti.com.br");
    expect((await post("/buy/cancel", token)).json()).toEqual({ ok: true, cancelado: true });
    expect(seen.cancels).toBe(1);
    expect((await post("/buy/status", token)).json()).toMatchObject({ status: "none" });
    const other = await liveSite();
    expect((await buy(other.token, "desisti.com.br")).statusCode).toBe(200);
  });

  it("a purchase paid a second ago is not cancelled", async () => {
    const { token } = await liveSite();
    await buy(token, "pago.com.br");
    whmcsStatus = "registering";
    expect((await post("/buy/cancel", token)).json()).toEqual({ ok: true, cancelado: false });
    expect(seen.cancels).toBe(0);
  });

  it("an unpaid order abandoned for three days is cancelled by the timer", async () => {
    const { token, uuid } = await liveSite();
    await buy(token, "abandonado.com.br");
    await db.query("UPDATE domain_purchases SET created_at = now() - interval '4 days' WHERE session_id = $1", [uuid]);
    await advanceOpenPurchases(ctx);
    expect(seen.cancels).toBe(1);
    expect((await db.query<{ status: string }>("SELECT status FROM domain_purchases WHERE session_id = $1", [uuid]))[0]!.status).toBe("canceled");
  });
});

describe("POST /web/domain/buy/pix", () => {
  it("gives the Pix of the purchase in progress (page reopened) and nothing once it is paid", async () => {
    const { token } = await liveSite();
    await buy(token, "reaberta.com.br");
    expect((await post("/buy/pix", token)).json()).toMatchObject({ ok: true, copia_cola: "000201PIX", qr: QR, valor_centavos: 5000 });
    whmcsStatus = "registering";
    await post("/buy/status", token); // moves the purchase on
    expect((await post("/buy/pix", token)).json()).toEqual({ ok: false });
  });
  it("answers ok:false when there is no purchase", async () => {
    const { token } = await liveSite();
    expect((await post("/buy/pix", token)).json()).toEqual({ ok: false });
  });
});
