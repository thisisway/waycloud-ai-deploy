import { z } from "zod";
import { sign } from "./security/hmac.js";

// Signed client of the WHMCS addon (modules/addons/waycloud_ai/api.php). The MCP service holds no
// WHMCS API credentials: it only shares an HMAC secret with the addon.

export class AddonError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
  }
}

export interface AddonPlan {
  type: "static" | "php" | "wordpress";
  pid: number;
  name: string;
  monthlyCents: number;
  annualCents: number;
}

/** The sign-up form fields, exactly as the addon expects them (it validates them and answers in pt-BR). */
export interface SignupForm {
  nome: string;
  email: string;
  doc_tipo: "CPF" | "CNPJ";
  doc_numero: string;
  telefone: string;
  aceite: boolean;
  website: string;
}

export interface SignupResult {
  ok: boolean;
  /** Field name -> message for the customer (fixed texts written by the addon). */
  errors: Record<string, string>;
  /** Logged-in WHMCS invoice URL, on the same host as the addon. */
  redirect: string | null;
  checkoutId: number | null;
  /** For a customer who already has an account: the WHMCS page that can attach the order to it. */
  fallbackUrl: string | null;
}

export interface PixCharge {
  copyPaste: string;
  /** data:image/png;base64,... exactly as the gateway produced it */
  qrImage: string;
  amountCents: number;
  expiresAt: string;
}

export interface DomainOffer {
  domain: string;
  /** null: the lookup could not tell */
  available: boolean | null;
  priceCents: number;
}

export type DomainOrderStatus = "awaiting_payment" | "registering" | "registered" | "failed" | "canceled";

export interface Address {
  cep: string;
  logradouro: string;
  numero: string;
  complemento: string;
  bairro: string;
  cidade: string;
  uf: string;
}

export interface DomainOrderResult {
  ok: boolean;
  errors: Record<string, string>;
  orderId: number | null;
  invoiceId: number | null;
  redirect: string | null;
  priceCents: number | null;
}

export interface AddonClient {
  /** Tells WHMCS the service now lives on the customer's own domain. */
  updateServiceDomain(req: { serviceId: number; domain: string }): Promise<void>;
  registerCheckout(req: { sessionId: string; pid: number; cycle: "monthly" | "annually"; form: SignupForm }): Promise<SignupResult>;
  /** The Pix of the checkout's invoice (only for the session that made it); null when there is none to show. */
  pixCharge(req: { sessionId: string; checkoutId: number }): Promise<PixCharge | null>;
  domainSearch(domains: string[]): Promise<DomainOffer[]>;
  domainOrder(req: { sessionId: string; checkoutId: number; domain: string; address: Address }): Promise<DomainOrderResult>;
  domainOrderStatus(req: { sessionId: string; checkoutId: number; orderId: number }): Promise<{ status: DomainOrderStatus; domain: string | null }>;
  domainOrderPix(req: { sessionId: string; checkoutId: number; orderId: number }): Promise<PixCharge | null>;
  domainOrderCancel(req: { sessionId: string; checkoutId: number; orderId: number }): Promise<boolean>;
  createCheckout(req: { sessionId: string; pid: number; cycle: "monthly" | "annually" }): Promise<{ checkoutId: number; url: string; expiresAt: string }>;
  plans(): Promise<AddonPlan[]>;
}

const checkoutResponse = z.object({ checkout_id: z.number().int(), checkout_url: z.string().url(), expires_at: z.string() });
const signupResponse = z.object({
  ok: z.boolean(),
  errors: z.union([z.record(z.string()), z.array(z.never())]), // PHP encodes an empty map as []
  redirect: z.string().url().nullable(),
  checkout_id: z.number().int().nullable(),
  fallback_url: z.string().url().nullable(),
});
const pixResponse = z.object({ ok: z.boolean(), copy_paste: z.string().optional(), qr_image: z.string().optional(), amount_cents: z.number().int().optional(), expires_at: z.string().optional() });
const domainSearchResponse = z.object({ results: z.array(z.object({ domain: z.string(), available: z.boolean().nullable(), price_cents: z.number().int() })) });
const domainOrderResponse = z.object({
  ok: z.boolean(),
  errors: z.union([z.record(z.string()), z.array(z.never())]),
  order_id: z.number().int().nullable(),
  invoice_id: z.number().int().nullable(),
  redirect: z.string().url().nullable(),
  price_cents: z.number().int().nullable(),
});
const domainStatusResponse = z.object({ status: z.enum(["awaiting_payment", "registering", "registered", "failed", "canceled"]), domain: z.string().nullable() });
const plansResponse = z.object({
  plans: z.array(z.object({ type: z.enum(["static", "php", "wordpress"]), pid: z.number().int(), name: z.string(), monthly_cents: z.number().int(), annual_cents: z.number().int() })),
});

export interface AddonConfig {
  url: string;
  secret: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

// registerCheckout and domainOrder make WHMCS create a client and/or an order in the same request: WHMCS's own
// synchronous mail sending on those calls (its mandatory e-mail verification, the admin order notification...) has been
// observed taking from a few seconds up to ~70s, depending on the mail relay, well past what a signup should need.
// A short timeout there does not make it faster, it just tells the customer "failed" while WHMCS finishes the order anyway,
// producing duplicate signups. ponytail: this bound, not a fix for the slow mail; the real fix is deferring those sends
// server-side (WHMCS "EnableEmailVerification" is a site-wide setting, not ours to flip without asking).
const SLOW_TIMEOUT_MS = 55_000;

export function httpAddonClient(cfg: AddonConfig): AddonClient {
  const doFetch = cfg.fetchFn ?? fetch;

  async function call(payload: object, timeoutMs = cfg.timeoutMs ?? 10_000): Promise<unknown> {
    const body = JSON.stringify(payload);
    const sig = sign(cfg.secret, body);
    let res: Response;
    try {
      res = await doFetch(cfg.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-waycloud-timestamp": String(sig.ts),
          "x-waycloud-nonce": sig.nonce,
          "x-waycloud-signature": sig.signature,
          "user-agent": "WayCloud-MCP/1.0", // the Cloudflare bot rule blocks requests without a User-Agent
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new AddonError("unreachable", 0);
    }
    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) throw new AddonError(typeof (json as { error?: unknown }).error === "string" ? (json as { error: string }).error : `http_${res.status}`, res.status);
    return json;
  }

  return {
    async updateServiceDomain(r) {
      const parsed = z.object({ ok: z.literal(true) }).safeParse(await call({ action: "update_service_domain", service_id: r.serviceId, domain: r.domain }));
      if (!parsed.success) throw new AddonError("bad_response", 200);
    },

    async registerCheckout(r) {
      const parsed = signupResponse.safeParse(await call({ action: "register_checkout", session_id: r.sessionId, pid: r.pid, cycle: r.cycle, form: r.form }, Math.max(cfg.timeoutMs ?? 0, SLOW_TIMEOUT_MS)));
      if (!parsed.success) throw new AddonError("bad_response", 200);
      const d = parsed.data;
      // Both links are opened by the customer: they must live on the WHMCS we called, never somewhere else.
      for (const url of [d.redirect, d.fallback_url]) if (url && new URL(url).host !== new URL(cfg.url).host) throw new AddonError("unexpected_host", 200);
      return { ok: d.ok, errors: Array.isArray(d.errors) ? {} : d.errors, redirect: d.redirect, checkoutId: d.checkout_id, fallbackUrl: d.fallback_url };
    },

    async pixCharge(r) {
      const parsed = pixResponse.safeParse(await call({ action: "pix_charge", session_id: r.sessionId, checkout_id: r.checkoutId }));
      if (!parsed.success) throw new AddonError("bad_response", 200);
      const d = parsed.data;
      if (!d.ok || !d.copy_paste || d.amount_cents === undefined) return null;
      return { copyPaste: d.copy_paste, qrImage: d.qr_image ?? "", amountCents: d.amount_cents, expiresAt: d.expires_at ?? "" };
    },

    async domainSearch(domains) {
      const parsed = domainSearchResponse.safeParse(await call({ action: "domain_search", domains }));
      if (!parsed.success) throw new AddonError("bad_response", 200);
      return parsed.data.results.map((d) => ({ domain: d.domain, available: d.available, priceCents: d.price_cents }));
    },

    async domainOrder(r) {
      const parsed = domainOrderResponse.safeParse(await call({ action: "domain_order", session_id: r.sessionId, checkout_id: r.checkoutId, domain: r.domain, address: r.address }, Math.max(cfg.timeoutMs ?? 0, SLOW_TIMEOUT_MS)));
      if (!parsed.success) throw new AddonError("bad_response", 200);
      const d = parsed.data;
      if (d.redirect && new URL(d.redirect).host !== new URL(cfg.url).host) throw new AddonError("unexpected_host", 200); // the customer opens it
      return { ok: d.ok, errors: Array.isArray(d.errors) ? {} : d.errors, orderId: d.order_id, invoiceId: d.invoice_id, redirect: d.redirect, priceCents: d.price_cents };
    },

    async domainOrderStatus(r) {
      const parsed = domainStatusResponse.safeParse(await call({ action: "domain_order_status", session_id: r.sessionId, checkout_id: r.checkoutId, order_id: r.orderId }));
      if (!parsed.success) throw new AddonError("bad_response", 200);
      return parsed.data;
    },

    async domainOrderPix(r) {
      const parsed = pixResponse.safeParse(await call({ action: "domain_order_pix", session_id: r.sessionId, checkout_id: r.checkoutId, order_id: r.orderId }));
      if (!parsed.success) throw new AddonError("bad_response", 200);
      const d = parsed.data;
      if (!d.ok || !d.copy_paste || d.amount_cents === undefined) return null;
      return { copyPaste: d.copy_paste, qrImage: d.qr_image ?? "", amountCents: d.amount_cents, expiresAt: d.expires_at ?? "" };
    },

    async domainOrderCancel(r) {
      const parsed = z.object({ ok: z.boolean() }).safeParse(await call({ action: "domain_order_cancel", session_id: r.sessionId, checkout_id: r.checkoutId, order_id: r.orderId }));
      if (!parsed.success) throw new AddonError("bad_response", 200);
      return parsed.data.ok;
    },

    async createCheckout(r) {
      const parsed = checkoutResponse.safeParse(await call({ action: "create_checkout", session_id: r.sessionId, pid: r.pid, cycle: r.cycle }));
      if (!parsed.success) throw new AddonError("bad_response", 200);
      // The customer opens this link: it must live on the same WHMCS we called, never somewhere else.
      if (new URL(parsed.data.checkout_url).host !== new URL(cfg.url).host) throw new AddonError("unexpected_host", 200);
      return { checkoutId: parsed.data.checkout_id, url: parsed.data.checkout_url, expiresAt: parsed.data.expires_at };
    },

    async plans() {
      const parsed = plansResponse.safeParse(await call({ action: "plans" }));
      if (!parsed.success) throw new AddonError("bad_response", 200);
      return parsed.data.plans.map((p) => ({ type: p.type, pid: p.pid, name: p.name, monthlyCents: p.monthly_cents, annualCents: p.annual_cents }));
    },
  };
}
