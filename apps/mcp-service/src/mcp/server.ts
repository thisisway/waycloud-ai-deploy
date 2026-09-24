import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { entradas, envelopeSchema, saidas } from "@waycloud/shared";
import { TOOLS } from "./tools/index.js";
import type { ToolContext } from "./tools/define.js";

export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "waycloud", version: "0.1.0" });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: entradas[tool.name].shape, outputSchema: envelopeSchema(saidas[tool.name]).shape },
      async (args: unknown) => {
        const env = await tool.handler(ctx, args as never);
        return { content: [{ type: "text" as const, text: JSON.stringify(env) }], structuredContent: env as unknown as Record<string, unknown>, isError: !env.ok };
      },
    );
  }
  return server;
}
