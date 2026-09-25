// Talks to the Way Cloud service from the browser (and from tests): no DOM in here.

export class Api {
  /** `base` is "" in the browser (same origin); `fetchFn` is injectable for tests. */
  constructor(base = "", fetchFn = (...args) => fetch(...args)) {
    this.base = base;
    this.fetch = fetchFn;
    this.id = 0;
  }

  /** Calls an MCP tool over stateless Streamable HTTP and returns the Way Cloud envelope. */
  async tool(name, args = {}) {
    const res = await this.fetch(`${this.base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method: "tools/call", params: { name, arguments: args } }),
    });
    const raw = await res.text();
    const json = raw.trimStart().startsWith("{") ? raw : raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop();
    const env = json ? JSON.parse(json)?.result?.structuredContent : undefined;
    if (!env) throw new Error(`Resposta inesperada do serviço (HTTP ${res.status}).`);
    return env;
  }
}

export const brl = (centavos) => (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/** Reuses the saved session while it is valid, or starts a new one. `store` = { get(), set(value) }. */
export async function ensureSession(api, store) {
  const saved = store.get();
  if (saved?.sessao_id && saved.expira_em && Date.parse(saved.expira_em) > Date.now() + 60_000) return saved;
  const r = await api.tool("iniciar_sessao");
  if (!r.ok) throw new Error(r.mensagem_para_usuario);
  const fresh = { sessao_id: r.dados.sessao_id, expira_em: r.dados.expira_em };
  store.set(fresh);
  return fresh;
}

/** Sends a .zip (Uint8Array) through the service. Resolves to { ok, upload_id } or { ok: false, mensagem }. */
export async function sendZip(api, sessaoId, bytes) {
  const up = await api.tool("obter_url_upload", { sessao_id: sessaoId, tamanho_bytes: bytes.length });
  if (!up.ok) return { ok: false, mensagem: up.mensagem_para_usuario };
  const res = await api.fetch(`${api.base}/web/upload/${up.dados.upload_id}`, {
    method: "PUT",
    headers: { "content-type": "application/zip", "x-sessao-id": sessaoId },
    body: bytes,
  });
  const env = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, mensagem: env?.mensagem_para_usuario ?? `O envio falhou (HTTP ${res.status}). Tente de novo.` };
  return { ok: true, upload_id: up.dados.upload_id };
}
