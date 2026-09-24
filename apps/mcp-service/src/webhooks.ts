import { z } from "zod";
import type { Db } from "./db/index.js";
import { verify } from "./security/hmac.js";

// Receiver of the events the WHMCS addon sends (order.created, order.paid, service.active, service.failed).
// Payloads carry ids only. Processing is idempotent (retries repeat the addon's outbox id), runs in one
// transaction, and tolerates events arriving out of order.

const uuid = z.string().uuid();
const base = z.object({ session_id: uuid, checkout_id: z.number().int(), plan_pid: z.number().int(), cycle: z.enum(["monthly", "annually"]) });

const schemas = {
  "order.created": base.extend({ whmcs_order_id: z.number().int(), whmcs_invoice_id: z.number().int(), whmcs_service_id: z.number().int() }),
  "order.paid": base.extend({ whmcs_invoice_id: z.number().int() }),
  "service.active": base.extend({ whmcs_service_id: z.number().int(), domain: z.string().min(3).max(253), whmcs_server_id: z.number().int() }),
  "service.failed": base.extend({ whmcs_service_id: z.number().int(), reason_code: z.string().max(60) }),
} as const;

const envelope = z.object({ id: z.number().int().positive(), event: z.enum(["order.created", "order.paid", "service.active", "service.failed"]), data: z.record(z.unknown()) });

export type OrderStatus = "awaiting_payment" | "paid" | "active" | "failed";
// active and failed are final: a late or repeated event never moves an order backwards or out of them.
const RANK: Record<OrderStatus, number> = { awaiting_payment: 0, paid: 1, active: 2, failed: 2 };

export type WebhookResult =
  | { status: 200; body: { ok: true; duplicate?: true; ignored?: "unknown_session" } }
  | { status: 400 | 401 | 500; body: { error: string } };

export interface SignedRequest {
  ts: number;
  nonce: string;
  signature: string;
}

export async function handleWhmcsWebhook(db: Db, secret: string, sig: SignedRequest, rawBody: string): Promise<WebhookResult> {
  const verdict = await verify(db, secret, sig, rawBody);
  if (verdict !== "ok") return { status: 401, body: { error: "unauthorized" } }; // never say why

  let parsed: z.infer<typeof envelope>;
  try {
    parsed = envelope.parse(JSON.parse(rawBody));
  } catch {
    return { status: 400, body: { error: "invalid_body" } };
  }
  const data = schemas[parsed.event].safeParse(parsed.data);
  if (!data.success) return { status: 400, body: { error: "invalid_data" } };

  try {
    let result: WebhookResult = { status: 200, body: { ok: true } };
    await db.tx(async (t) => {
      const seen = await t.query("INSERT INTO webhook_events (whmcs_event_id, event) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING whmcs_event_id", [parsed.id, parsed.event]);
      if (seen.length === 0) {
        result = { status: 200, body: { ok: true, duplicate: true } };
        return;
      }
      const applied = await apply(t, parsed.event, data.data as never);
      if (!applied) result = { status: 200, body: { ok: true, ignored: "unknown_session" } };
      await t.query("INSERT INTO audit_log (correlation_id, actor, action, meta) VALUES ($1, 'whmcs', $2, $3::jsonb)", [data.data.session_id, parsed.event, JSON.stringify({ event_id: parsed.id, applied })]);
    });
    return result;
  } catch (e) {
    console.error(JSON.stringify({ msg: "webhook failed", event: parsed.event, error: e instanceof Error ? e.message : "unknown" }));
    return { status: 500, body: { error: "processing_failed" } }; // the transaction rolled back: the addon retries with the same id
  }
}

type Data<E extends keyof typeof schemas> = z.infer<(typeof schemas)[E]>;

/** Returns false when the session is unknown (expired and purged): the event is acknowledged, not retried forever. */
async function apply(t: Db, event: keyof typeof schemas, data: Data<keyof typeof schemas>): Promise<boolean> {
  const [session] = await t.query("SELECT id FROM sessions WHERE id = $1", [data.session_id]);
  if (!session) return false;

  const target: OrderStatus = event === "order.created" ? "awaiting_payment" : event === "order.paid" ? "paid" : event === "service.active" ? "active" : "failed";
  const d = data as Partial<Data<"order.created"> & Data<"service.active">>;
  const ids = { order: d.whmcs_order_id ?? null, invoice: d.whmcs_invoice_id ?? null, service: d.whmcs_service_id ?? null };

  const [current] = await t.query<{ status: OrderStatus }>("SELECT status FROM orders WHERE session_id = $1 FOR UPDATE", [data.session_id]);
  if (!current) {
    await t.query(
      "INSERT INTO orders (session_id, whmcs_order_id, whmcs_invoice_id, whmcs_service_id, status, checkout_id, plan_pid, cycle) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [data.session_id, ids.order, ids.invoice, ids.service, target, String(data.checkout_id), data.plan_pid, data.cycle],
    );
  } else {
    const status = RANK[target] > RANK[current.status] ? target : current.status;
    await t.query(
      `UPDATE orders SET status = $2, updated_at = now(),
         whmcs_order_id = COALESCE($3, whmcs_order_id), whmcs_invoice_id = COALESCE($4, whmcs_invoice_id), whmcs_service_id = COALESCE($5, whmcs_service_id),
         checkout_id = COALESCE(checkout_id, $6), plan_pid = COALESCE(plan_pid, $7), cycle = COALESCE(cycle, $8)
       WHERE session_id = $1`,
      [data.session_id, status, ids.order, ids.invoice, ids.service, String(data.checkout_id), data.plan_pid, data.cycle],
    );
  }

  if (event === "service.active") {
    const a = data as Data<"service.active">;
    const serverId = `whmcs-${a.whmcs_server_id}`;
    // The deploy agent registers its secret later (M5); until then the server is only a reference.
    await t.query("INSERT INTO servers (id, label, agent_secret_hash) VALUES ($1, $2, '') ON CONFLICT DO NOTHING", [serverId, `WHMCS server ${a.whmcs_server_id}`]);
    await t.query(
      `INSERT INTO subscriptions (whmcs_service_id, session_id, server_id, domain, plan_pid) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (whmcs_service_id) DO UPDATE SET domain = EXCLUDED.domain, server_id = EXCLUDED.server_id`,
      [a.whmcs_service_id, a.session_id, serverId, a.domain, a.plan_pid],
    );
  }
  return true;
}
