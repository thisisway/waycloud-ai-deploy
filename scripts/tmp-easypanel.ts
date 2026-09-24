// Temporary helper: talks to the Easypanel MCP server reading the URL from the local secrets file.
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const FILE = "C:/Users/deryk/waycloud-secrets.env";
const read = () => Object.fromEntries(readFileSync(FILE, "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
let env = read();
const mode = process.argv[2] ?? "help";
const PROJECT = "web-way";
const APP = "waycloud-ai-mcp";

const client = new Client({ name: "tmp-easypanel", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(env.EASYPANEL_MCP_URL!)));
const redact = (s: string) => Object.values(read()).filter((v) => v.length >= 12).reduce((acc, v) => acc.split(v).join("***"), s);
async function call(name: string, args: object) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  return { isError: !!r.isError, text: redact((r.content as { text?: string }[]).map((c) => c.text ?? "").join("")) };
}

if (mode === "search") {
  const r = await call("search_procedures", { query: process.argv[3] ?? "update environment variables of an app service", limit: 5 });
  try {
    for (const m of (JSON.parse(r.text) as { matches: { name: string; description: string; inputSchema: object }[] }).matches) console.log(m.name, "-", m.description, "\n   ", JSON.stringify(m.inputSchema).slice(0, 300));
  } catch {
    console.log("(não consegui interpretar a resposta)");
  }
} else if (mode === "token") {
  if (!env.AGENT_TOKEN_WHMCS_18) {
    appendFileSync(FILE, `\nAGENT_TOKEN_WHMCS_18=${randomBytes(32).toString("hex")}\n`);
    env = read();
  }
  console.log("AGENT_TOKEN_WHMCS_18:", env.AGENT_TOKEN_WHMCS_18!.length, "caracteres");
}
await client.close();
