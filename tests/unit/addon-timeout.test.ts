import { describe, expect, it } from "vitest";
import { httpAddonClient } from "../../apps/mcp-service/src/addon.js";

// registerCheckout and domainOrder make WHMCS create a client/order in the same call: WHMCS's own synchronous mail
// sending on those (observed up to ~70s) must not be mistaken for a dead addon. They get a long floor regardless of
// the configured default, other calls keep it (so a genuinely unreachable addon still fails fast for them).

const SECRET = "0123456789abcdef0123456789abcdef";
const URL_ = "https://addon.test/api.php";

/** A fetchFn that answers `body` after `delayMs`, but rejects immediately once its signal aborts. */
function slowFetch(delayMs: number, body: unknown): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const t = setTimeout(() => resolve(new Response(JSON.stringify(body), { status: 200 })), delayMs);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      });
    })) as typeof fetch;
}

describe("addon call timeouts", () => {
  it("registerCheckout waits past a short configured timeout (WHMCS's own slow mail sending is normal for it)", async () => {
    const addon = httpAddonClient({
      url: URL_,
      secret: SECRET,
      timeoutMs: 50, // far too short for a normal call: proves the override, not this value, was used
      fetchFn: slowFetch(200, { ok: true, errors: [], redirect: "https://addon.test/sso/x", checkout_id: 1, fallback_url: null }),
    });
    const r = await addon.registerCheckout({ sessionId: "s", pid: 1, cycle: "monthly", form: { nome: "A", email: "a@b.com", doc_tipo: "CPF", doc_numero: "1", telefone: "1", aceite: true, website: "" } });
    expect(r.ok).toBe(true);
  });

  it("domainOrder also gets the long floor", async () => {
    const addon = httpAddonClient({
      url: URL_,
      secret: SECRET,
      timeoutMs: 50,
      fetchFn: slowFetch(200, { ok: true, errors: [], order_id: 1, invoice_id: 2, redirect: null, price_cents: 5000 }),
    });
    const r = await addon.domainOrder({ sessionId: "s", checkoutId: 1, domain: "x.com.br", address: { cep: "1", logradouro: "1", numero: "1", complemento: "", bairro: "1", cidade: "1", uf: "SP" } });
    expect(r.ok).toBe(true);
  });

  it("a call that does not create a client or order keeps the short configured timeout (a dead addon still fails fast)", async () => {
    const addon = httpAddonClient({ url: URL_, secret: SECRET, timeoutMs: 50, fetchFn: slowFetch(200, { plans: [] }) });
    await expect(addon.plans()).rejects.toMatchObject({ code: "unreachable" });
  });
});
