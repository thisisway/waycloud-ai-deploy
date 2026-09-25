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
  type: "static" | "php";
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

export interface AddonClient {
  registerCheckout(req: { sessionId: string; pid: number; cycle: "monthly" | "annually"; form: SignupForm }): Promise<SignupResult>;
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
const plansResponse = z.object({
  plans: z.array(z.object({ type: z.enum(["static", "php"]), pid: z.number().int(), name: z.string(), monthly_cents: z.number().int(), annual_cents: z.number().int() })),
});

export interface AddonConfig {
  url: string;
  secret: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export function httpAddonClient(cfg: AddonConfig): AddonClient {
  const doFetch = cfg.fetchFn ?? fetch;

  async function call(payload: object): Promise<unknown> {
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
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 10_000),
      });
    } catch {
      throw new AddonError("unreachable", 0);
    }
    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) throw new AddonError(typeof (json as { error?: unknown }).error === "string" ? (json as { error: string }).error : `http_${res.status}`, res.status);
    return json;
  }

  return {
    async registerCheckout(r) {
      const parsed = signupResponse.safeParse(await call({ action: "register_checkout", session_id: r.sessionId, pid: r.pid, cycle: r.cycle, form: r.form }));
      if (!parsed.success) throw new AddonError("bad_response", 200);
      const d = parsed.data;
      // Both links are opened by the customer: they must live on the WHMCS we called, never somewhere else.
      for (const url of [d.redirect, d.fallback_url]) if (url && new URL(url).host !== new URL(cfg.url).host) throw new AddonError("unexpected_host", 200);
      return { ok: d.ok, errors: Array.isArray(d.errors) ? {} : d.errors, redirect: d.redirect, checkoutId: d.checkout_id, fallbackUrl: d.fallback_url };
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
