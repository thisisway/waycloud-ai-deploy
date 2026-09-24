import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpAddonClient } from "../../apps/mcp-service/src/addon.js";
import { sign } from "../../apps/mcp-service/src/security/hmac.js";

// Node service <-> the REAL PHP addon code (Api + Checkout + Hmac) served by php:8.1-cli.
// Needs Docker; opt in with:  PHP_E2E=1 pnpm test
const enabled = process.env.PHP_E2E === "1";
const SECRET = "0123456789abcdef0123456789abcdef";
const PORT = 18081;
const URL_ = `http://127.0.0.1:${PORT}/modules/addons/waycloud_ai/api.php`;
const SESSION = "6f1c2d3e-0000-4000-8000-0123456789ab";
let container = "";

async function postSigned(body: string, secret = SECRET, headers: Record<string, string> = {}) {
  const s = sign(secret, body);
  return fetch(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", "x-waycloud-timestamp": String(s.ts), "x-waycloud-nonce": s.nonce, "x-waycloud-signature": s.signature, ...headers },
    body,
  });
}

describe.skipIf(!enabled)("Node <-> PHP addon (real code)", () => {
  beforeAll(async () => {
    const r = spawnSync("docker", ["run", "-d", "--rm", "-p", `${PORT}:8080`, "-v", `${process.cwd()}:/app`, "-w", "/app", "-e", `ADDON_HMAC_SECRET=${SECRET}`, "php:8.1-cli", "php", "-S", "0.0.0.0:8080", "tests/php/server.php"], { encoding: "utf8" });
    container = r.stdout.trim();
    if (!container) throw new Error(`could not start php container: ${r.stderr}`);
    for (let i = 0; i < 40; i++) {
      try {
        if ((await postSigned('{"action":"ping"}')).status === 200) return;
      } catch {
        /* not up yet */
      }
      await new Promise((res) => setTimeout(res, 500));
    }
    throw new Error("php container did not become ready");
  }, 60_000);
  afterAll(() => {
    if (container) spawnSync("docker", ["rm", "-f", container]);
  });

  it("ping with a valid signature, including a non-ASCII body (UTF-8 signs identically)", async () => {
    const r = await postSigned('{"action":"ping","nota":"ação e coração"}');
    expect([r.status, await r.json()]).toEqual([200, { ok: true }]);
  });

  it("the Node client gets a real checkout link from the PHP Checkout service", async () => {
    const r = await httpAddonClient({ url: URL_, secret: SECRET }).createCheckout({ sessionId: SESSION, pid: 173, cycle: "annually" });
    expect(r.checkoutId).toBe(1);
    expect(r.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${PORT}/index\\.php\\?m=waycloud_ai&t=[A-Za-z0-9_-]{43}$`));
    expect(new Date(r.expiresAt).getTime() - Date.now()).toBeGreaterThan(47 * 3_600_000); // 48h default
  });

  it("refuses unknown plans and cycles with 422 and a stable code", async () => {
    const c = httpAddonClient({ url: URL_, secret: SECRET });
    await expect(c.createCheckout({ sessionId: SESSION, pid: 1, cycle: "monthly" })).rejects.toMatchObject({ code: "invalid_plan", status: 422 });
    await expect(c.createCheckout({ sessionId: "nope", pid: 173, cycle: "monthly" })).rejects.toMatchObject({ code: "invalid_session", status: 422 });
  });

  it("returns the plans configured in the addon", async () => {
    const r = await postSigned('{"action":"plans"}');
    const { plans } = (await r.json()) as { plans: { type: string; pid: number; name: string; monthly_cents: number }[] };
    expect(plans.map((p) => [p.type, p.pid])).toEqual([["static", 173], ["php", 174]]);
  });

  it("rejects a wrong secret, a tampered body and a replay, all with the same opaque 401", async () => {
    const wrong = await postSigned('{"action":"ping"}', "another-secret-another-secret-1234");
    expect([wrong.status, await wrong.json()]).toEqual([401, { error: "unauthorized" }]);

    const body = '{"action":"ping"}';
    const s = sign(SECRET, body);
    const h = { "content-type": "application/json", "x-waycloud-timestamp": String(s.ts), "x-waycloud-nonce": s.nonce, "x-waycloud-signature": s.signature };
    expect((await fetch(URL_, { method: "POST", headers: h, body: body + " " })).status).toBe(401);
    expect((await fetch(URL_, { method: "POST", headers: h, body })).status).toBe(200);
    const replay = await fetch(URL_, { method: "POST", headers: h, body });
    expect([replay.status, await replay.json()]).toEqual([401, { error: "unauthorized" }]);
  });

  it("rejects a stale timestamp and non-POST methods", async () => {
    const body = '{"action":"ping"}';
    const old = sign(SECRET, body, Math.floor(Date.now() / 1000) - 400);
    const r = await fetch(URL_, { method: "POST", headers: { "x-waycloud-timestamp": String(old.ts), "x-waycloud-nonce": old.nonce, "x-waycloud-signature": old.signature }, body });
    expect(r.status).toBe(401);
    expect((await fetch(URL_)).status).toBe(405);
  });
});
