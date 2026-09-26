import type { Address, DomainOrderStatus, PixCharge } from "./addon.js";
import type { Db } from "./db/index.js";
import { isReserved, normalizeDomain, requestDomain } from "./domains.js";
import type { ToolContext } from "./mcp/tools/define.js";

// Buying a domain on the page: search -> order (a WHMCS registration order, paid with the Pix on the page) -> WHMCS registers it
// with Way Cloud's nameservers -> the normal domain flow points the site at it (nameserver method: nothing left for the customer).

/** Endings offered when the customer types only a name. */
export const OFFERED_ENDINGS = ["com.br", "com", "net", "app.br"];

/** The names to look up for what the customer typed: a full domain as it is, a bare name with the usual endings. */
export function candidates(input: string, previewTemplate: string): string[] {
  const typed = input.trim().toLowerCase();
  if (typed.includes(".")) {
    const d = normalizeDomain(typed);
    return d && !isReserved(d, previewTemplate) ? [d] : [];
  }
  const label = typed.replace(/^www$/, "");
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])$/.test(label)) return []; // at least two characters
  return OFFERED_ENDINGS.map((e) => `${label}.${e}`).filter((d) => !isReserved(d, previewTemplate));
}

export interface PurchaseRow {
  id: string;
  session_id: string;
  checkout_id: string;
  domain: string;
  order_id: string | number;
  invoice_id: string | number;
  price_cents: number;
  status: DomainOrderStatus;
}

export const TEXTO_COMPRA: Record<DomainOrderStatus, string> = {
  awaiting_payment: "Aguardando o pagamento do domínio. Assim que for confirmado, a gente registra.",
  registering: "Pagamento confirmado! Estamos registrando o domínio. Costuma levar alguns minutos.",
  registered: "Domínio registrado! Estamos configurando o seu site nele.",
  failed: "O registro do domínio precisa de uma conferência da nossa equipe. Já fomos avisados e entramos em contato em breve; se preferir, fale com a gente pelo chat.",
  canceled: "Pedido do domínio cancelado.",
};

export async function openPurchase(db: Db, sessionId: string): Promise<PurchaseRow | undefined> {
  const [row] = await db.query<PurchaseRow>("SELECT * FROM domain_purchases WHERE session_id = $1 AND status IN ('awaiting_payment', 'registering') ORDER BY created_at DESC LIMIT 1", [sessionId]);
  return row;
}

/** The purchase the page should show: the one in progress, else the latest one that registered or failed. */
export async function currentPurchase(db: Db, sessionId: string): Promise<PurchaseRow | undefined> {
  const [row] = await db.query<PurchaseRow>("SELECT * FROM domain_purchases WHERE session_id = $1 AND status <> 'canceled' ORDER BY (status IN ('awaiting_payment', 'registering')) DESC, created_at DESC LIMIT 1", [sessionId]);
  return row;
}

/** True when this session bought that domain from us (the page then skips the DNS instructions: it is already ours). */
export async function boughtHere(db: Db, sessionId: string, domain: string): Promise<boolean> {
  const [row] = await db.query("SELECT 1 FROM domain_purchases WHERE session_id = $1 AND domain = $2 AND status = 'registered'", [sessionId, domain]);
  return row !== undefined;
}

export type BuyResult =
  | { ok: true; purchase: PurchaseRow; redirect: string | null; pix: PixCharge | null }
  | { ok: false; codigo: "SEM_PLANO_ATIVO" | "COMPRA_EM_ANDAMENTO" | "DOMINIO_INVALIDO" | "DOMINIO_EM_USO" | "INDISPONIVEL"; errors?: Record<string, string> };

/** The checkout (WHMCS client) of the session's active plan. */
async function checkoutOf(ctx: ToolContext, sessionId: string): Promise<number | null> {
  const [row] = await ctx.db.query<{ checkout_id: string }>("SELECT r.checkout_id FROM checkout_refs r JOIN orders o ON o.session_id = r.session_id AND o.status = 'active' WHERE r.session_id = $1 ORDER BY r.created_at DESC LIMIT 1", [sessionId]);
  const id = Number(row?.checkout_id);
  return Number.isInteger(id) ? id : null;
}

export async function buyDomain(ctx: ToolContext, sessionId: string, input: string, address: Address): Promise<BuyResult> {
  const domain = normalizeDomain(input);
  if (!domain || isReserved(domain, ctx.settings.previewUrlTemplate)) return { ok: false, codigo: "DOMINIO_INVALIDO" };
  const checkoutId = ctx.addon ? await checkoutOf(ctx, sessionId) : null;
  if (!ctx.addon || checkoutId === null) return { ok: false, codigo: "SEM_PLANO_ATIVO" };
  if (await openPurchase(ctx.db, sessionId)) return { ok: false, codigo: "COMPRA_EM_ANDAMENTO" };
  const [taken] = await ctx.db.query("SELECT 1 FROM subscriptions WHERE domain = $1 UNION ALL SELECT 1 FROM domain_purchases WHERE domain = $1 AND status IN ('awaiting_payment', 'registering', 'registered')", [domain]);
  if (taken) return { ok: false, codigo: "DOMINIO_EM_USO" };

  const order = await ctx.addon.domainOrder({ sessionId, checkoutId, domain, address });
  if (!order.ok || order.orderId === null || order.invoiceId === null || order.priceCents === null) return { ok: false, codigo: "INDISPONIVEL", errors: order.errors };
  let purchase: PurchaseRow | undefined;
  try {
    [purchase] = await ctx.db.query<PurchaseRow>(
      "INSERT INTO domain_purchases (session_id, checkout_id, domain, order_id, invoice_id, price_cents) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
      [sessionId, String(checkoutId), domain, order.orderId, order.invoiceId, order.priceCents],
    );
  } catch {
    // Another request won the race for the same session or domain: this order is not needed.
    await ctx.addon.domainOrderCancel({ sessionId, checkoutId, orderId: order.orderId }).catch(() => false);
    return { ok: false, codigo: "COMPRA_EM_ANDAMENTO" };
  }
  const pix = await ctx.addon.domainOrderPix({ sessionId, checkoutId, orderId: order.orderId }).catch(() => null);
  return { ok: true, purchase: purchase!, redirect: order.redirect, pix };
}

async function setStatus(db: Db, id: string, status: DomainOrderStatus): Promise<void> {
  await db.query("UPDATE domain_purchases SET status = $2, updated_at = now() WHERE id = $1 AND status <> $2", [id, status]);
}

/** Looks at WHMCS for one open purchase; when the domain is registered, points the site at it. Returns the current status. */
export async function advancePurchase(ctx: ToolContext, p: PurchaseRow): Promise<DomainOrderStatus> {
  if (!ctx.addon || (p.status !== "awaiting_payment" && p.status !== "registering")) return p.status;
  let seen: DomainOrderStatus;
  try {
    seen = (await ctx.addon.domainOrderStatus({ sessionId: p.session_id, checkoutId: Number(p.checkout_id), orderId: Number(p.order_id) })).status;
  } catch {
    return p.status; // WHMCS unreachable: try again on the next look
  }
  if (seen === p.status) return seen;
  await setStatus(ctx.db, p.id, seen);
  // The nameservers are ours already: the normal flow creates the DNS zone and the certificate by itself.
  if (seen === "registered") await requestDomain(ctx, p.session_id, p.domain, "ns");
  return seen;
}

export async function cancelPurchase(ctx: ToolContext, sessionId: string): Promise<boolean> {
  const p = await openPurchase(ctx.db, sessionId);
  if (!p || !ctx.addon) return false;
  const seen = await advancePurchase(ctx, p); // it may have been paid a second ago: then it is not ours to cancel
  if (seen !== "awaiting_payment") return false;
  const done = await ctx.addon.domainOrderCancel({ sessionId, checkoutId: Number(p.checkout_id), orderId: Number(p.order_id) }).catch(() => false);
  if (done) await setStatus(ctx.db, p.id, "canceled");
  return done;
}

/** Every minute: purchases waiting for payment or registration (the customer may have closed the page). */
export async function advanceOpenPurchases(ctx: ToolContext): Promise<number> {
  // Abandoned before paying (the Pix lasts three days): release the domain and cancel the unpaid order.
  const stale = await ctx.db.query<PurchaseRow>("SELECT * FROM domain_purchases WHERE status = 'awaiting_payment' AND created_at <= now() - interval '3 days'");
  for (const p of stale) {
    if ((await advancePurchase(ctx, p)) !== "awaiting_payment") continue;
    const done = await ctx.addon?.domainOrderCancel({ sessionId: p.session_id, checkoutId: Number(p.checkout_id), orderId: Number(p.order_id) }).catch(() => false);
    if (done) await setStatus(ctx.db, p.id, "canceled");
  }
  const rows = await ctx.db.query<PurchaseRow>("SELECT * FROM domain_purchases WHERE status IN ('awaiting_payment', 'registering') AND created_at > now() - interval '4 days'");
  let moved = 0;
  for (const p of rows) if ((await advancePurchase(ctx, p)) !== p.status) moved++;
  return moved;
}
