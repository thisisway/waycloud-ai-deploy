import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../apps/mcp-service/src/server.js";
import { testCtx } from "../helpers.js";

let close: () => Promise<void>;
let app: ReturnType<typeof buildApp>;
let client: Client;
let base: string;

beforeAll(async () => {
  const t = await testCtx();
  close = t.close;
  app = buildApp(t.ctx);
  base = await app.listen({ port: 0, host: "127.0.0.1" });
  client = new Client({ name: "test-ai", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
});
afterAll(async () => {
  await client.close();
  await app.close();
  await close();
});

describe("MCP over Streamable HTTP (real protocol, stateless)", () => {
  it("health check", async () => {
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true });
  });

  it("lists the 11 tools with input and output schemas", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(11);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema, t.name).toBeDefined();
    }
  });

  it("runs the flow through the protocol", async () => {
    const start = await client.callTool({ name: "iniciar_sessao", arguments: {} });
    const env = start.structuredContent as { ok: boolean; dados: { sessao_id: string } };
    expect(env.ok).toBe(true);

    const r = await client.callTool({
      name: "analisar_projeto",
      arguments: { sessao_id: env.dados.sessao_id, manifesto: { arquivos: [{ caminho: "index.html", tamanho: 500 }] } },
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ codigo: "PROJETO_ANALISADO", dados: { tipo: "estatico" } });
  });

  it("business errors come back as tool errors with a user message", async () => {
    const r = await client.callTool({ name: "analisar_projeto", arguments: { sessao_id: "y".repeat(43), manifesto: { arquivos: [] } } });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ ok: false, codigo: "SESSAO_INVALIDA" });
  });

  it("invalid arguments are rejected by the schema", async () => {
    const r = await client.callTool({ name: "analisar_projeto", arguments: { sessao_id: "curto" } }).catch((e: unknown) => e);
    const failed = r instanceof Error || (r as { isError?: boolean }).isError === true;
    expect(failed).toBe(true);
  });

  it("GET /mcp is not allowed in stateless mode", async () => {
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
  });
});
