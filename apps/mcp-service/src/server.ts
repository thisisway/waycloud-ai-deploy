import Fastify from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp/server.js";
import { handleWhmcsWebhook } from "./webhooks.js";
import type { ToolContext } from "./mcp/tools/define.js";

export function buildApp(ctx: ToolContext, opts: { webhookSecret?: string } = {}) {
  const app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 });

  app.get("/healthz", async () => ({ ok: true }));

  // The HMAC covers the exact bytes the addon signed, so this route keeps the body as a raw string.
  // Registered in its own scope: the /mcp route below still gets parsed JSON.
  if (opts.webhookSecret) {
    const secret = opts.webhookSecret;
    void app.register(async (scope) => {
      scope.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
      scope.post("/webhooks/whmcs", async (req, reply) => {
        const h = req.headers;
        const r = await handleWhmcsWebhook(
          ctx.db,
          secret,
          { ts: Number(h["x-waycloud-timestamp"]), nonce: String(h["x-waycloud-nonce"] ?? ""), signature: String(h["x-waycloud-signature"] ?? "") },
          typeof req.body === "string" ? req.body : "",
        );
        return reply.code(r.status).send(r.body);
      });
    });
  }

  // Stateless Streamable HTTP: a fresh MCP server + transport per request. Our own session id
  // travels as the `sessao_id` tool argument, so no server-side MCP session is kept.
  app.post("/mcp", async (req, reply) => {
    const mcp = createMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  const notAllowed = async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.code(405).send({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  return app;
}
