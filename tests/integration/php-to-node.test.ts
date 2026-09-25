import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../apps/mcp-service/src/db/index.js";
import { TOOLS } from "../../apps/mcp-service/src/mcp/tools/index.js";
import type { ToolContext } from "../../apps/mcp-service/src/mcp/tools/define.js";
import { buildApp } from "../../apps/mcp-service/src/server.js";
import { findSession } from "../../apps/mcp-service/src/sessions.js";
import { testCtx } from "../helpers.js";

// The REAL PHP addon (Checkout + McpNotifier + curl) sending signed webhooks to the REAL Node receiver.
// Needs Docker; opt in with:  PHP_E2E=1 pnpm test
const enabled = process.env.PHP_E2E === "1";
const SECRET = "0123456789abcdef0123456789abcdef";

describe.skipIf(!enabled)("PHP addon -> Node webhook receiver (real code both sides)", () => {
  let ctx: ToolContext;
  let db: Db;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;
  let port: number;

  beforeAll(async () => {
    ({ ctx, db, close } = await testCtx());
    app = buildApp(ctx, { webhookSecret: SECRET });
    await app.listen({ port: 0, host: "0.0.0.0" });
    port = (app.server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await app.close();
    await close();
  });

  it("a whole purchase: the outbox holds events while the service is down, then delivers them in order", async () => {
    const token = ((await TOOLS.find((t) => t.name === "iniciar_sessao")!.handler(ctx, {} as never)).dados as { sessao_id: string }).sessao_id;
    const uuid = (await findSession(db, token))!.id;

    // Async on purpose: the receiver lives in THIS process, a synchronous spawn would freeze it and nothing could answer.
    const r = await promisify(execFile)(
      "docker",
      ["run", "--rm", "-v", `${process.cwd()}:/app`, "-w", "/app", "-e", `ADDON_HMAC_SECRET=${SECRET}`, "-e", `SESSION_ID=${uuid}`, "-e", `MCP_URL=http://host.docker.internal:${port}`, "php:8.1-cli", "php", "tests/php/notify.php"],
      { encoding: "utf8" },
    );
    const out = JSON.parse(r.stdout) as { http_statuses: number[] };
    // statuses: 3 failed attempts against the unreachable URL (0), then 3 deliveries (200)
    expect(out.http_statuses).toEqual([0, 0, 0, 200, 200, 200]);
    expect(out).toMatchObject({ submit_ok: true, pending_after_failure: 3, sent_on_retry: 3, pending_after_retry: 0 });

    // The Node side applied them: order active, subscription recorded, events in the order they happened.
    const status = await TOOLS.find((t) => t.name === "status_pedido")!.handler(ctx, { sessao_id: token } as never);
    expect(status).toMatchObject({ ok: true, codigo: "PEDIDO_ATIVO", dados: { status: "ativo" } });
    const [order] = await db.query("SELECT status, whmcs_order_id, whmcs_invoice_id, whmcs_service_id, plan_pid, cycle FROM orders WHERE session_id = $1", [uuid]);
    expect(order).toEqual({ status: "active", whmcs_order_id: 500, whmcs_invoice_id: 1500, whmcs_service_id: 2500, plan_pid: 173, cycle: "monthly" });
    const [sub] = await db.query<{ domain: string; server_id: string }>("SELECT domain, server_id FROM subscriptions WHERE session_id = $1", [uuid]);
    expect(sub!.server_id).toBe("whmcs-18");
    expect(sub!.domain).toMatch(/^[a-z2-7]{10}\.sites\.waypreview\.com\.br$/);
    const actions = (await db.query<{ action: string }>("SELECT action FROM audit_log WHERE correlation_id = $1 ORDER BY id", [uuid])).map((a) => a.action);
    expect(actions).toEqual(["order.created", "order.paid", "service.active"]);
  }, 90_000);
});
