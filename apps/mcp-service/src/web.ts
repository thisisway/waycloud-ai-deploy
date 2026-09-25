import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CICLOS, erro, ok, sessaoId } from "@waycloud/shared";
import { AddonError } from "./addon.js";
import type { ToolContext } from "./mcp/tools/define.js";
import { PlansUnavailable } from "./plans.js";
import { findSession } from "./sessions.js";
import { rawKey } from "./uploads.js";

// The public page (drop a .zip, see the preview, pick a plan, pay, publish) and the one endpoint it needs
// besides /mcp: a same-origin upload, so the browser never talks to the object storage (no CORS to manage).

const PAGES: Record<string, { file: string; type: string; immutable?: boolean }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/site.css": { file: "site.css", type: "text/css; charset=utf-8" },
  "/site.js": { file: "site.js", type: "text/javascript; charset=utf-8" },
  "/flow.js": { file: "flow.js", type: "text/javascript; charset=utf-8" },
  "/chat.js": { file: "chat.js", type: "text/javascript; charset=utf-8" },
  "/ribbons.js": { file: "ribbons.js", type: "text/javascript; charset=utf-8" },
  "/waycloud-logo.svg": { file: "waycloud-logo.svg", type: "image/svg+xml" },
  "/fonts/plus-jakarta-sans-v12-latin.woff2": { file: "fonts/plus-jakarta-sans-v12-latin.woff2", type: "font/woff2", immutable: true }, // self-hosted: no request to Google
};
// Scripts stay strict (own files + the support chat SDK). Styles allow inline only because the chat widget injects its own.
const CHAT = "https://chatwoot.waycloud.com.br";
const HEADERS = {
  "content-security-policy": `default-src 'none'; script-src 'self' ${CHAT}; style-src 'self' 'unsafe-inline'; font-src 'self' ${CHAT} data:; connect-src 'self' ${CHAT} wss://chatwoot.waycloud.com.br; img-src 'self' data: ${CHAT}; media-src ${CHAT}; frame-src ${CHAT}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-cache",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_WEB_ZIP_BYTES = 100 * 1024 * 1024; // same cap as the pre-signed upload (schemas.ts) and the archive limits

// Sign-up from the public page. Personal data goes browser -> this service -> the WHMCS addon (signed) and nowhere else:
// it is never stored, logged or given to an AI, and the customer sets the password from an e-mail.
const signupBody = z
  .object({
    sessao_id: sessaoId,
    plano_pid: z.number().int(),
    ciclo: z.enum(CICLOS),
    nome: z.string().max(100),
    email: z.string().max(254),
    doc_tipo: z.enum(["CPF", "CNPJ"]),
    doc_numero: z.string().max(30),
    telefone: z.string().max(30),
    aceite: z.boolean(),
    website: z.string().max(200).default(""), // honeypot: real people leave it empty
  })
  .strict();
const FIELDS = new Set(["nome", "email", "doc_numero", "telefone", "aceite", "_form"]);

/** Best-effort abuse limits (memory only: they reset on a restart). Each sign-up can create a WHMCS client and send an e-mail. */
export class RateLimit {
  private hits = new Map<string, number[]>();
  constructor(private windowMs: number, private now: () => number = Date.now) {}
  /** True when `key` already used its `max` in the window; otherwise counts this attempt. */
  tooMany(key: string, max: number): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= max) {
      this.hits.set(key, recent);
      return true;
    }
    this.hits.set(key, [...recent, t]);
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (v.every((x) => t - x >= this.windowMs)) this.hits.delete(k);
    return false;
  }
}

export function registerWeb(app: FastifyInstance, ctx: ToolContext) {
  const perIp = new RateLimit(10 * 60_000);
  const perSession = new RateLimit(10 * 60_000);
  const overall = new RateLimit(60 * 60_000);
  for (const [path, { file, type, immutable }] of Object.entries(PAGES)) {
    let body: Buffer;
    try {
      body = readFileSync(new URL(`../public/${file}`, import.meta.url));
    } catch {
      continue; // a slim image without the page: the service still works
    }
    app.get(path, async (_req, reply) => reply.headers({ ...HEADERS, ...(immutable && { "cache-control": "public, max-age=31536000, immutable" }), "content-type": type }).send(body));
  }

  void app.register(async (scope) => {
    scope.addContentTypeParser(["application/zip", "application/octet-stream"], { parseAs: "buffer", bodyLimit: MAX_WEB_ZIP_BYTES }, (_req, body, done) => done(null, body));
    scope.put<{ Params: { uploadId: string } }>("/web/upload/:uploadId", { bodyLimit: MAX_WEB_ZIP_BYTES }, async (req, reply) => {
      const send = (status: number, env: object) => reply.code(status).header("cache-control", "no-store").send(env);
      const session = await findSession(ctx.db, String(req.headers["x-sessao-id"] ?? ""));
      if (!session) return send(401, erro("SESSAO_INVALIDA"));
      const { uploadId } = req.params;
      const [row] = UUID.test(uploadId)
        ? await ctx.db.query("SELECT id FROM uploads WHERE id = $1 AND session_id = $2 AND source = 'presigned' AND scan_status = 'awaiting_upload'", [uploadId, session.id])
        : [];
      if (!row) return send(404, erro("UPLOAD_NAO_ENCONTRADO"));
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length < 22 || body[0] !== 0x50 || body[1] !== 0x4b) return send(400, erro("ARQUIVO_INVALIDO")); // not a zip; the full validation runs when the preview is created
      await ctx.storage.put(rawKey(session.id, uploadId), body);
      return send(200, ok("ARQUIVOS_RECEBIDOS", { upload_id: uploadId }));
    });
  });

  app.post("/web/checkout", { bodyLimit: 16 * 1024 }, async (req, reply) => {
    const send = (status: number, body: object) => reply.code(status).header("cache-control", "no-store").send(body);
    const parsed = signupBody.safeParse(req.body);
    if (!parsed.success) return send(400, erro("ENTRADA_INVALIDA"));
    const b = parsed.data;

    const ip = String(req.headers["x-real-ip"] ?? req.headers["cf-connecting-ip"] ?? req.ip);
    if (perIp.tooMany(ip, 8) || perSession.tooMany(b.sessao_id, 5) || overall.tooMany("all", 120)) return send(429, erro("LIMITE_EXCEDIDO"));

    const session = await findSession(ctx.db, b.sessao_id);
    if (!session) return send(401, erro("SESSAO_INVALIDA"));
    let plans;
    try {
      plans = await ctx.plans();
    } catch (e) {
      if (e instanceof PlansUnavailable) return send(503, erro("PLANOS_INDISPONIVEIS"));
      throw e;
    }
    if (!plans.some((p) => p.pid === b.plano_pid)) return send(422, erro("PLANO_INVALIDO"));
    if (!ctx.addon) return send(503, erro("CHECKOUT_INDISPONIVEL"));

    try {
      const r = await ctx.addon.registerCheckout({
        sessionId: session.id, // the addon gets the internal id, never the token the browser holds
        pid: b.plano_pid,
        cycle: b.ciclo === "anual" ? "annually" : "monthly",
        form: { nome: b.nome, email: b.email, doc_tipo: b.doc_tipo, doc_numero: b.doc_numero, telefone: b.telefone, aceite: b.aceite, website: b.website },
      });
      if (r.ok && r.redirect) {
        if (r.checkoutId !== null) await ctx.db.query("INSERT INTO checkout_refs (session_id, checkout_id, pid, cycle) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [session.id, String(r.checkoutId), b.plano_pid, b.ciclo]);
        return send(200, { ok: true, redirect: r.redirect });
      }
      const errors = Object.fromEntries(Object.entries(r.errors).filter(([k]) => FIELDS.has(k)).map(([k, v]) => [k, v.slice(0, 200)]));
      return send(422, { ok: false, errors: Object.keys(errors).length ? errors : { _form: "Não foi possível concluir o cadastro agora. Tente novamente em instantes." }, fallback_url: r.fallbackUrl });
    } catch (e) {
      if (e instanceof AddonError && e.status === 422) return send(422, erro("PLANO_INVALIDO"));
      console.error(JSON.stringify({ msg: "web signup failed", error: e instanceof AddonError ? e.code : "unexpected" })); // never the form
      return send(502, erro("CHECKOUT_INDISPONIVEL"));
    }
  });
}
