import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { envelopeSchema, saidas, type ToolName } from "../../packages/shared/src/index.js";
import type { Db } from "../../apps/mcp-service/src/db/index.js";
import { TOOLS } from "../../apps/mcp-service/src/mcp/tools/index.js";
import type { ToolContext } from "../../apps/mcp-service/src/mcp/tools/define.js";
import { sign } from "../../apps/mcp-service/src/security/hmac.js";
import { buildApp } from "../../apps/mcp-service/src/server.js";
import { findSession } from "../../apps/mcp-service/src/sessions.js";
import { handleWhmcsWebhook } from "../../apps/mcp-service/src/webhooks.js";
import { testCtx } from "../helpers.js";

const SECRET = "0123456789abcdef0123456789abcdef";
let ctx: ToolContext;
let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ ctx, db, close } = await testCtx());
});
afterAll(async () => close());

const call = (name: ToolName, args: unknown) => TOOLS.find((t) => t.name === name)!.handler(ctx, args as never);

let nextEventId = 1000;
/** A fresh AI session: its bearer token (what the AI holds) and the internal uuid (what WHMCS knows). */
async function session() {
  const token = ((await call("iniciar_sessao", {})).dados as { sessao_id: string }).sessao_id;
  return { token, uuid: (await findSession(db, token))!.id };
}
const base = (uuid: string) => ({ session_id: uuid, checkout_id: 7, plan_pid: 223, cycle: "monthly" });
const events = {
  created: (uuid: string) => ["order.created", { ...base(uuid), whmcs_order_id: 500, whmcs_invoice_id: 1500, whmcs_service_id: 2500 }] as const,
  paid: (uuid: string) => ["order.paid", { ...base(uuid), whmcs_invoice_id: 1500 }] as const,
  active: (uuid: string, service = 2500) => ["service.active", { ...base(uuid), whmcs_service_id: service, domain: "abcdefghij.sites.wayleads.com.br", whmcs_server_id: 18 }] as const,
  failed: (uuid: string) => ["service.failed", { ...base(uuid), whmcs_service_id: 2500, reason_code: "provisioning_failed" }] as const,
};
const deliver = (ev: readonly [string, object], id = nextEventId++, secret = SECRET) => {
  const body = JSON.stringify({ id, event: ev[0], data: ev[1] });
  const s = sign(secret, body);
  return handleWhmcsWebhook(db, SECRET, { ts: s.ts, nonce: s.nonce, signature: secret === SECRET ? s.signature : sign(secret, body).signature }, body);
};
const orderOf = async (uuid: string) => (await db.query<Record<string, unknown>>("SELECT status, whmcs_order_id, whmcs_invoice_id, whmcs_service_id, plan_pid, cycle FROM orders WHERE session_id = $1", [uuid]))[0];
const statusOf = async (token: string) => {
  const r = await call("status_pedido", { sessao_id: token });
  envelopeSchema(saidas.status_pedido).parse(r);
  return r;
};

describe("status_pedido follows the WHMCS events", () => {
  it("no order, unknown session", async () => {
    const s = await session();
    expect(await statusOf(s.token)).toMatchObject({ ok: true, codigo: "SEM_PEDIDO", dados: { status: "sem_pedido", intervalo_sugerido_segundos: 0 } });
    expect(await call("status_pedido", { sessao_id: "z".repeat(43) })).toMatchObject({ ok: false, codigo: "SESSAO_INVALIDA" });
  });

  it("created -> paid -> active, with polling hints and the subscription recorded", async () => {
    const s = await session();
    expect((await deliver(events.created(s.uuid))).status).toBe(200);
    expect(await statusOf(s.token)).toMatchObject({ codigo: "PEDIDO_AGUARDANDO", dados: { status: "aguardando_pagamento", intervalo_sugerido_segundos: 30 } });

    await deliver(events.paid(s.uuid));
    expect(await statusOf(s.token)).toMatchObject({ codigo: "PEDIDO_PAGO", dados: { status: "pago", intervalo_sugerido_segundos: 5 } });

    await deliver(events.active(s.uuid));
    const done = await statusOf(s.token);
    expect(done).toMatchObject({ codigo: "PEDIDO_ATIVO", dados: { status: "ativo", intervalo_sugerido_segundos: 0 } });
    expect(done.proximo_passo).toContain("publicar");

    expect(await orderOf(s.uuid)).toEqual({ status: "active", whmcs_order_id: 500, whmcs_invoice_id: 1500, whmcs_service_id: 2500, plan_pid: 223, cycle: "monthly" });
    const [sub] = await db.query("SELECT whmcs_service_id, server_id, domain, plan_pid FROM subscriptions WHERE session_id = $1", [s.uuid]);
    expect(sub).toEqual({ whmcs_service_id: 2500, server_id: "whmcs-18", domain: "abcdefghij.sites.wayleads.com.br", plan_pid: 223 });
    expect(await db.query("SELECT 1 FROM servers WHERE id = 'whmcs-18'")).toHaveLength(1);
    expect((await db.query("SELECT 1 FROM audit_log WHERE correlation_id = $1", [s.uuid])).length).toBe(3);
  });

  it("a failed provisioning is reported without technical detail", async () => {
    const s = await session();
    await deliver(events.created(s.uuid));
    await deliver(events.paid(s.uuid));
    await deliver(events.failed(s.uuid));
    const r = await statusOf(s.token);
    expect(r).toMatchObject({ codigo: "PEDIDO_FALHOU", dados: { status: "falhou", intervalo_sugerido_segundos: 0 } });
    expect(r.proximo_passo).toMatch(/suporte/i);
    expect(JSON.stringify(r)).not.toMatch(/provisioning_failed|whmcs/i);
  });
});

describe("out-of-order, duplicate and final states", () => {
  it("events that arrive late never move an order backwards, but still fill in the ids", async () => {
    const s = await session();
    await deliver(events.paid(s.uuid)); // created was delayed by a retry
    expect(await orderOf(s.uuid)).toMatchObject({ status: "paid", whmcs_order_id: null, whmcs_invoice_id: 1500 });
    await deliver(events.created(s.uuid));
    expect(await orderOf(s.uuid)).toMatchObject({ status: "paid", whmcs_order_id: 500, whmcs_service_id: 2500 });
    await deliver(events.active(s.uuid));
    await deliver(events.paid(s.uuid)); // a repeated paid after active
    expect(await orderOf(s.uuid)).toMatchObject({ status: "active" });
  });

  it("the same event id is processed once (the addon retries with the same id and a new nonce)", async () => {
    const s = await session();
    const id = nextEventId++;
    expect(await deliver(events.created(s.uuid), id)).toEqual({ status: 200, body: { ok: true } });
    expect(await deliver(events.created(s.uuid), id)).toEqual({ status: 200, body: { ok: true, duplicate: true } });
    expect(await db.query("SELECT 1 FROM webhook_events WHERE whmcs_event_id = $1", [id])).toHaveLength(1);
    expect(await db.query("SELECT 1 FROM audit_log WHERE correlation_id = $1", [s.uuid])).toHaveLength(1);
  });

  it("active and failed are final in both directions", async () => {
    const a = await session();
    await deliver(events.active(a.uuid));
    await deliver(events.failed(a.uuid));
    expect(await orderOf(a.uuid)).toMatchObject({ status: "active" });
    const f = await session();
    await deliver(events.failed(f.uuid));
    await deliver(events.active(f.uuid, 9001));
    expect(await orderOf(f.uuid)).toMatchObject({ status: "failed" });
  });

  it("an unknown or purged session is acknowledged, not retried forever", async () => {
    const id = nextEventId++;
    const r = await deliver(events.created("00000000-0000-4000-8000-000000000000"), id);
    expect(r).toEqual({ status: 200, body: { ok: true, ignored: "unknown_session" } });
    expect(await db.query("SELECT 1 FROM webhook_events WHERE whmcs_event_id = $1", [id])).toHaveLength(1);
  });

  it("a processing failure rolls everything back so the addon's retry can succeed", async () => {
    const s = await session();
    await deliver(events.active(s.uuid, 3001));
    const before = (await db.query("SELECT count(*)::int AS n FROM webhook_events"))[0]!.n as number;
    const id = nextEventId++;
    // a second service for the same session violates subscriptions.session_id UNIQUE: the transaction must abort
    const r = await deliver(events.active(s.uuid, 3002), id);
    expect(r).toEqual({ status: 500, body: { error: "processing_failed" } });
    expect(await db.query("SELECT 1 FROM webhook_events WHERE whmcs_event_id = $1", [id])).toHaveLength(0);
    expect((await db.query("SELECT count(*)::int AS n FROM webhook_events"))[0]!.n).toBe(before);
    expect((await db.query("SELECT whmcs_service_id FROM subscriptions WHERE session_id = $1", [s.uuid]))[0]).toEqual({ whmcs_service_id: 3001 });
  });
});

describe("authentication and validation", () => {
  it("rejects wrong secret, tampered body, replay, stale timestamps and an unconfigured secret, all alike", async () => {
    const s = await session();
    const body = JSON.stringify({ id: nextEventId++, event: "order.created", data: events.created(s.uuid)[1] });
    const good = sign(SECRET, body);
    const opaque = { status: 401, body: { error: "unauthorized" } };
    expect(await handleWhmcsWebhook(db, SECRET, { ...good, signature: sign("other-secret-other-secret-1234567", body).signature }, body)).toEqual(opaque);
    expect(await handleWhmcsWebhook(db, SECRET, good, body + " ")).toEqual(opaque);
    expect(await handleWhmcsWebhook(db, SECRET, sign(SECRET, body, Math.floor(Date.now() / 1000) - 400), body)).toEqual(opaque);
    expect(await handleWhmcsWebhook(db, "", good, body)).toEqual(opaque);
    expect((await handleWhmcsWebhook(db, SECRET, good, body)).status).toBe(200);
    expect(await handleWhmcsWebhook(db, SECRET, good, body)).toEqual(opaque); // same nonce again = replay
    expect(await orderOf(s.uuid)).toMatchObject({ status: "awaiting_payment" });
  });

  it("validated but malformed bodies are 400 and change nothing", async () => {
    const s = await session();
    const send = (raw: string) => {
      const sig = sign(SECRET, raw);
      return handleWhmcsWebhook(db, SECRET, sig, raw);
    };
    expect(await send("not json")).toEqual({ status: 400, body: { error: "invalid_body" } });
    expect(await send(JSON.stringify({ id: 1, event: "order.refunded", data: {} }))).toEqual({ status: 400, body: { error: "invalid_body" } });
    expect(await send(JSON.stringify({ id: nextEventId++, event: "order.paid", data: { session_id: "not-a-uuid" } }))).toEqual({ status: 400, body: { error: "invalid_data" } });
    expect(await send(JSON.stringify({ id: nextEventId++, event: "order.paid", data: { ...events.paid(s.uuid)[1], whmcs_invoice_id: "1500" } }))).toEqual({ status: 400, body: { error: "invalid_data" } });
    expect(await orderOf(s.uuid)).toBeUndefined();
  });
});

describe("HTTP route (raw body) next to the MCP route", () => {
  it("verifies the exact bytes that were signed, including non-ASCII", async () => {
    const app = buildApp(ctx, { webhookSecret: SECRET });
    const s = await session();
    const raw = JSON.stringify({ id: nextEventId++, event: "order.created", data: { ...events.created(s.uuid)[1], nota: "ação e coração" } });
    const sig = sign(SECRET, raw);
    const headers = { "content-type": "application/json", "x-waycloud-timestamp": String(sig.ts), "x-waycloud-nonce": sig.nonce, "x-waycloud-signature": sig.signature };
    const ok = await app.inject({ method: "POST", url: "/webhooks/whmcs", headers, payload: raw });
    expect([ok.statusCode, ok.json()]).toEqual([200, { ok: true }]);
    const replay = await app.inject({ method: "POST", url: "/webhooks/whmcs", headers, payload: raw });
    expect(replay.statusCode).toBe(401);
    // the MCP route in the same app still gets parsed JSON
    const mcp = await app.inject({ method: "POST", url: "/mcp", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(mcp.statusCode).toBe(200);
    await app.close();
  });

  it("without a configured secret the webhook route does not exist", async () => {
    const app = buildApp(ctx);
    expect((await app.inject({ method: "POST", url: "/webhooks/whmcs", payload: "{}" })).statusCode).toBe(404);
    await app.close();
  });
});
