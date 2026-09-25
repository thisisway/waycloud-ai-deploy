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

// ---- sign-up form (personal data goes to /web/checkout and nowhere else; it is never kept in the browser) ------------

const digits = (s) => String(s).replace(/\D/g, "");

/** "(11) 99999-8888" while typing. */
export function maskPhone(raw) {
  const d = digits(raw).slice(0, 11);
  if (d.length <= 2) return d.length ? `(${d}` : "";
  const head = `(${d.slice(0, 2)}) `;
  return d.length <= 10 ? `${head}${d.slice(2, 6)}${d.length > 6 ? `-${d.slice(6)}` : ""}` : `${head}${d.slice(2, 7)}-${d.slice(7)}`;
}

// Puts a separator after the n-th character, only when more characters follow.
const withSeparators = (chars, cuts) => [...chars].map((c, i) => (cuts[i + 1] && i + 1 < chars.length ? c + cuts[i + 1] : c)).join("");

/** CPF is digits only; the new CNPJ may carry letters. Formats as 000.000.000-00 / 00.000.000/0000-00. */
export function maskDoc(tipo, raw) {
  if (tipo === "CPF") return withSeparators(digits(raw).slice(0, 11), { 3: ".", 6: ".", 9: "-" });
  return withSeparators(String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 14), { 2: ".", 5: ".", 8: "/", 12: "-" });
}

/** Quick checks for instant feedback; the addon repeats them (and validates the CPF/CNPJ check digits). */
export function checkForm(v) {
  const e = {};
  const nome = v.nome.trim();
  if (nome.length < 3 || !nome.includes(" ")) e.nome = "Informe seu nome e sobrenome.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email.trim())) e.email = "Informe um e-mail válido.";
  const doc = String(v.doc_numero).replace(/[^A-Za-z0-9]/g, "");
  if (v.doc_tipo === "CPF" ? !/^\d{11}$/.test(doc) : !/^[A-Za-z0-9]{14}$/.test(doc)) e.doc_numero = "CPF ou CNPJ inválido.";
  const tel = digits(v.telefone).replace(/^55(?=\d{10,11}$)/, "");
  if (tel.length !== 10 && tel.length !== 11) e.telefone = "Informe um telefone com DDD.";
  if (!v.aceite) e.aceite = "Você precisa aceitar os Termos de Serviço e a Política de Privacidade.";
  return e;
}

/**
 * Sends the sign-up. Resolves to { ok: true, redirect } or { ok: false, errors, fallbackUrl, mensagem, status }.
 * `errors` maps field names to messages written by the addon; `mensagem` is a general one (limits, session, outage).
 */
export async function signup(api, payload) {
  let res;
  try {
    res = await api.fetch(`${api.base}/web/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  } catch {
    return { ok: false, errors: {}, status: 0, mensagem: "Não consegui falar com a Way Cloud. Confira a sua conexão e tente de novo." };
  }
  const body = await res.json().catch(() => ({}));
  if (res.ok && body.ok && body.redirect) return { ok: true, redirect: body.redirect };
  return { ok: false, status: res.status, errors: body.errors ?? {}, fallbackUrl: body.fallback_url ?? null, mensagem: body.mensagem_para_usuario ?? null };
}
