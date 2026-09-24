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

export interface AddonClient {
  createCheckout(req: { sessionId: string; pid: number; cycle: "monthly" | "annually" }): Promise<{ checkoutId: number; url: string; expiresAt: string }>;
  plans(): Promise<AddonPlan[]>;
}

const checkoutResponse = z.object({ checkout_id: z.number().int(), checkout_url: z.string().url(), expires_at: z.string() });
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
