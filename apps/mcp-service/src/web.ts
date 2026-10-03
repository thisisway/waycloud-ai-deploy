import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CICLOS, erro, ok, sessaoId } from "@waycloud/shared";
import { AddonError, type PixCharge } from "./addon.js";
import { advancePurchase, boughtHere, buyDomain, currentPurchase, cancelPurchase, candidates, openPurchase, TEXTO_COMPRA } from "./domain-sales.js";
import type { ToolContext } from "./mcp/tools/define.js";
import { cancelDomainRequest, checkOne, dnsInstructions, dnsTarget, inspectDomain, latestDomainRequest, normalizeDomain, requestDomain, systemResolver, TEXTO_ERRO, TEXTO_STATUS, type DomainRow } from "./domains.js";
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
  "/device.js": { file: "device.js", type: "text/javascript; charset=utf-8" },
  "/preview-view.html": { file: "preview-view.html", type: "text/html; charset=utf-8" },
  "/preview-view.js": { file: "preview-view.js", type: "text/javascript; charset=utf-8" },
  "/ribbons.js": { file: "ribbons.js", type: "text/javascript; charset=utf-8" },
  "/waycloud-logo.svg": { file: "waycloud-logo.svg", type: "image/svg+xml" },
  "/fonts/plus-jakarta-sans-v12-latin.woff2": { file: "fonts/plus-jakarta-sans-v12-latin.woff2", type: "font/woff2", immutable: true }, // self-hosted: no request to Google
};
// Scripts stay strict (own files + the support chat SDK). Styles allow inline only because the chat widget injects its own.
const CHAT = "https://chatwoot.waycloud.com.br";
/** Where the page may frame the free preview (device view): the preview sites of the configured template, e.g. https://*.waypreview.com.br. */
export function previewFrameSource(previewUrlTemplate: string): string {
  const host = new URL(previewUrlTemplate.replace("{slug}", "x")).host;
  return `https://${host.replace(/^x./, "*.")}`;
}
// The card tab tokenizes directly with Iugu from the browser (api.iugu.com): the card number must never
// reach our own server, so connect-src has to allow that one external host.
const IUGU_API = "https://api.iugu.com";
const headersFor = (previewFrame: string) => ({
  "content-security-policy": `default-src 'none'; script-src 'self' ${CHAT}; style-src 'self' 'unsafe-inline'; font-src 'self' ${CHAT} data:; connect-src 'self' ${CHAT} ${IUGU_API} wss://chatwoot.waycloud.com.br; img-src 'self' data: ${CHAT}; media-src ${CHAT}; frame-src ${CHAT} ${previewFrame}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-cache",
});
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
/** What the page gets of a Pix. The image goes into an <img src>: only a PNG data URL of sane size is passed on. */
function pixBody(pix: PixCharge) {
  const qr = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(pix.qrImage) && pix.qrImage.length < 40_000 ? pix.qrImage : null;
  return { copia_cola: pix.copyPaste.slice(0, 1000), qr, valor_centavos: pix.amountCents, expira_em: pix.expiresAt };
}

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
  const HEADERS = headersFor(previewFrameSource(ctx.settings.previewUrlTemplate));
  const perIp = new RateLimit(10 * 60_000);
  const perSession = new RateLimit(10 * 60_000);
  const overall = new RateLimit(60 * 60_000);
  const pixPerSession = new RateLimit(10 * 60_000);
  const cardPerSession = new RateLimit(10 * 60_000);
  for (const [path, { file, type, immutable }] of Object.entries(PAGES)) {
    let body: Buffer;
    try {
      body = readFileSync(new URL(`../public/${file}`, import.meta.url));
    } catch {
      continue; // a slim image without the page: the service still works
    }
    app.get(path, async (_req, reply) => reply.headers({ ...HEADERS, ...(immutable && { "cache-control": "public, max-age=31536000, immutable" }), "content-type": type }).send(body));
  }

  // Public Iugu account id only (never the secret API key): same-origin, so the strict script-src CSP above
  // (no 'unsafe-inline') does not need weakening just to hand the browser this one public value.
  app.get("/web/config", async (_req, reply) => reply.headers({ ...HEADERS, "content-type": "application/json" }).send({ iugu_account_id: ctx.settings.iuguAccountId ?? null }));

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

  // ---- the customer's own domain (only for a session that has a paid, published site) ----
  const domainBody = z.object({ sessao_id: sessaoId, dominio: z.string().min(3).max(300), metodo: z.enum(["ns", "records"]).default("records") }).strict();
  const inspectBody = z.object({ sessao_id: sessaoId, dominio: z.string().min(3).max(300) }).strict();
  const sessionOnly = z.object({ sessao_id: sessaoId }).strict();
  const domainLimit = new RateLimit(10 * 60_000);
  const view = async (row: DomainRow, sessionId: string) => ({
    ok: true,
    status: row.status,
    dominio: row.domain,
    metodo: row.method,
    https: row.ssl === true,
    mensagem: TEXTO_STATUS[row.status],
    comprado: await boughtHere(ctx.db, sessionId, row.domain), // bought here: its nameservers are ours already, nothing for the customer to do
    // The records to create are ours (target name and its IP): never built from what the browser sent.
    ...(row.status === "waiting_dns" ? { dns: dnsInstructions(row.domain, await dnsTarget(ctx.resolver ?? systemResolver, ctx.settings.siteTargetHost), ctx.settings.nameservers) } : {}),
  });

  app.post("/web/domain", { bodyLimit: 4 * 1024 }, async (req, reply) => {
    const send = (status: number, body: object) => reply.code(status).header("cache-control", "no-store").send(body);
    const b = domainBody.safeParse(req.body);
    if (!b.success) return send(400, erro("ENTRADA_INVALIDA"));
    if (domainLimit.tooMany(b.data.sessao_id, 15)) return send(429, erro("LIMITE_EXCEDIDO"));
    const session = await findSession(ctx.db, b.data.sessao_id);
    if (!session) return send(401, erro("SESSAO_INVALIDA"));
    const r = await requestDomain(ctx, session.id, b.data.dominio, b.data.metodo);
    if (!r.ok) return send(r.codigo === "DOMINIO_EM_USO" ? 409 : 422, { ok: false, codigo: r.codigo, mensagem: TEXTO_ERRO[r.codigo] });
    return send(200, await view(r.row, session.id));
  });

  // Read-only look at the domain's DNS, to recommend the safest way to point it (nothing is created).
  app.post("/web/domain/inspect", { bodyLimit: 4 * 1024 }, async (req, reply) => {
    const send = (status: number, body: object) => reply.code(status).header("cache-control", "no-store").send(body);
    const b = inspectBody.safeParse(req.body);
    if (!b.success) return send(400, erro("ENTRADA_INVALIDA"));
    if (domainLimit.tooMany(`inspect:${b.data.sessao_id}`, 30)) return send(429, erro("LIMITE_EXCEDIDO"));
    const session = await findSession(ctx.db, b.data.sessao_id);
    if (!session) return send(401, erro("SESSAO_INVALIDA"));
    const domain = normalizeDomain(b.data.dominio);
    if (!domain) return send(422, { ok: false, codigo: "DOMINIO_INVALIDO", mensagem: TEXTO_ERRO.DOMINIO_INVALIDO });
    const resolver = ctx.resolver ?? systemResolver;
    return send(200, { ok: true, dominio: domain, ...(await inspectDomain(resolver, domain, ctx.settings.nameservers)), dns: dnsInstructions(domain, await dnsTarget(resolver, ctx.settings.siteTargetHost), ctx.settings.nameservers) });
  });

  app.post("/web/domain/status", { bodyLimit: 2 * 1024 }, async (req, reply) => {
    const send = (status: number, body: object) => reply.code(status).header("cache-control", "no-store").send(body);
    const b = sessionOnly.safeParse(req.body);
    if (!b.success) return send(400, erro("ENTRADA_INVALIDA"));
    if (domainLimit.tooMany(`status:${b.data.sessao_id}`, 120)) return send(429, erro("LIMITE_EXCEDIDO"));
    const session = await findSession(ctx.db, b.data.sessao_id);
    if (!session) return send(401, erro("SESSAO_INVALIDA"));
    let row = await latestDomainRequest(ctx.db, session.id);
    if (!row) return send(200, { ok: true, status: "none" });
    if (row.status === "waiting_dns") {
      await checkOne(ctx, row.id, ctx.resolver ?? systemResolver); // the visitor is looking: do not make them wait for the timer
      row = (await latestDomainRequest(ctx.db, session.id))!;
    }
    return send(200, await view(row, session.id));
  });

  // ---- buying a domain from us (needs the paid site: the WHMCS client comes from its checkout) ----
  const searchBody = z.object({ sessao_id: sessaoId, nome: z.string().min(2).max(120) }).strict();
  const addressBody = z.object({ cep: z.string().max(12), logradouro: z.string().max(100), numero: z.string().max(12), complemento: z.string().max(60).default(""), bairro: z.string().max(80), cidade: z.string().max(80), uf: z.string().max(2) }).strict();
  const buyBody = z.object({ sessao_id: sessaoId, dominio: z.string().min(3).max(253), endereco: addressBody }).strict();
  const BUY_FIELDS = new Set(["dominio", "cep", "logradouro", "numero", "complemento", "bairro", "cidade", "uf", "_form"]);
  const BUY_ERRO = {
    SEM_PLANO_ATIVO: [409, "Conclua a contratação do plano antes de registrar um domínio."],
    COMPRA_EM_ANDAMENTO: [409, "Você já tem um domínio em andamento. Conclua ou cancele o pedido atual."],
    DOMINIO_INVALIDO: [422, "Esse domínio não parece válido. Digite algo como meusite.com.br."],
    DOMINIO_EM_USO: [409, "Esse domínio não está disponível."],
    INDISPONIVEL: [422, "Não foi possível criar o pedido do domínio. Confira os dados e tente de novo."],
  } as const;

  app.post("/web/domain/search", { bodyLimit: 2 * 1024 }, async (req, reply) => {
    const send = (status: number, body: object) => reply.code(status).header("cache-control", "no-store").send(body);
    const b = searchBody.safeParse(req.body);
    if (!b.success) return send(400, erro("ENTRADA_INVALIDA"));
    if (domainLimit.tooMany(`search:${b.data.sessao_id}`, 40)) return send(429, erro("LIMITE_EXCEDIDO"));
    const session = await findSession(ctx.db, b.data.sessao_id);
    if (!session) return send(401, erro("SESSAO_INVALIDA"));
    const names = candidates(b.data.nome, ctx.settings.previewUrlTemplate);
    if (!names.length) return send(422, { ok: false, codigo: "DOMINIO_INVALIDO", mensagem: TEXTO_ERRO.DOMINIO_INVALIDO });
    if (!ctx.addon) return send(503, erro("CHECKOUT_INDISPONIVEL"));
    try {
      const offers = await ctx.addon.domainSearch(names);
      return send(200, { ok: true, resultados: offers.map((o) => ({ dominio: o.domain, disponivel: o.available, valor_centavos: o.priceCents })) });
    } catch {
      return send(503, erro("CHECKOUT_INDISPONIVEL"));
    }
  });

  app.post("/web/domain/buy", { bodyLimit: 4 * 1024 }, async (req, reply) => {
    const send = (status: number, body: object) => reply.code(status).header("cache-control", "no-store").send(body);
    const b = buyBody.safeParse(req.body);
    if (!b.success) return send(400, erro("ENTRADA_INVALIDA"));
    if (domainLimit.tooMany(`buy:${b.data.sessao_id}`, 8)) return send(429, erro("LIMITE_EXCEDIDO"));
    const session = await findSession(ctx.db, b.data.sessao_id);
    if (!session) return send(401, erro("SESSAO_INVALIDA"));
    try {
      const r = await buyDomain(ctx, session.id, b.data.dominio, b.data.endereco);
      if (!r.ok) {
        const [status, mensagem] = BUY_ERRO[r.codigo];
        const errors = Object.fromEntries(Object.entries(r.errors ?? {}).filter(([k]) => BUY_FIELDS.has(k)).map(([k, v]) => [k, v.slice(0, 200)]));
        return send(status, { ok: false, codigo: r.codigo, mensagem, errors });
      }
      return send(200, { ok: true, dominio: r.purchase.domain, valor_centavos: r.purchase.price_cents, pix: r.pix ? pixBody(r.pix) : null, fatura_url: r.redirect });
    } catch (e) {
      console.error(JSON.stringify({ msg: "domain purchase failed", error: e instanceof AddonError ? e.code : "unexpected" })); // never the address
      return send(502, erro("CHECKOUT_INDISPONIVEL"));
    }
  });

  app.post("/web/domain/buy/status", { bodyLimit: 2 * 1024 }, async (req, reply) => {
    const send = (status: number, body: object) => reply.code(status).header("cache-control", "no-store").send(body);
    const b = sessionOnly.safeParse(req.body);
    if (!b.success) return send(400, erro("ENTRADA_INVALIDA"));
    if (domainLimit.tooMany(`buystatus:${b.data.sessao_id}`, 240)) return send(429, erro("LIMITE_EXCEDIDO"));
    const session = await findSession(ctx.db, b.data.sessao_id);
    if (!session) return send(401, erro("SESSAO_INVALIDA"));
    const p = await currentPurchase(ctx.db, session.id);
    if (!p) return send(200, { ok: true, status: "none" });
    const status = await advancePurchase(ctx, p); // the visitor is looking: do not make them wait for the timer
    return send(200, { ok: true, status, dominio: p.domain, valor_centavos: p.price_cents, mensagem: TEXTO_COMPRA[status] });
  });

  // The Pix of the purchase in progress (the page was reopened before paying).
  app.post("/web/domain/buy/pix", { bodyLimit: 2 * 1024 }, async (req, reply) => {
    const send = (status: number, body: object) => reply.code(status).header("cache-control", "no-store").send(body);
    const b = sessionOnly.safeParse(req.body);
    if (!b.success) return send(400, erro("ENTRADA_INVALIDA"));
    if (domainLimit.tooMany(`buypix:${b.data.sessao_id}`, 30)) return send(429, erro("LIMITE_EXCEDIDO"));
    const session = await findSession(ctx.db, b.data.sessao_id);
    if (!session) return send(401, erro("SESSAO_INVALIDA"));
    const p = await openPurchase(ctx.db, session.id);
    if (!p || p.status !== "awaiting_payment" || !ctx.addon) return send(200, { ok: false });
    const pix = await ctx.addon.domainOrderPix({ sessionId: session.id, checkoutId: Number(p.checkout_id), orderId: Number(p.order_id) }).catch(() => null);
    return send(200, pix ? { ok: true, ...pixBody(pix) } : { ok: false });
  });

  app.post("/web/domain/buy/cancel", { bodyLimit: 2 * 1024 }, async (req, reply) => {
    const send = (status: number, body: object) => reply.code(status).header("cache-control", "no-store").send(body);
    const b = sessionOnly.safeParse(req.body);
    if (!b.success) return send(400, erro("ENTRADA_INVALIDA"));
    const session = await findSession(ctx.db, b.data.sessao_id);
    if (!session) return send(401, erro("SESSAO_INVALIDA"));
    return send(200, { ok: true, cancelado: await cancelPurchase(ctx, session.id) });
  });

  app.post("/web/domain/cancel", { bodyLimit: 2 * 1024 }, async (req, reply) => {
    const send = (status: number, body: object) => reply.code(status).header("cache-control", "no-store").send(body);
    const b = sessionOnly.safeParse(req.body);
    if (!b.success) return send(400, erro("ENTRADA_INVALIDA"));
    const session = await findSession(ctx.db, b.data.sessao_id);
    if (!session) return send(401, erro("SESSAO_INVALIDA"));
    return send(200, { ok: true, cancelado: await cancelDomainRequest(ctx.db, session.id) });
  });

  // The Pix of the invoice, so the page shows the QR code itself. Only the session that signed up can ask, and only for its last checkout.
  app.post("/web/pix", { bodyLimit: 2 * 1024 }, async (req, reply) => {
    const send = (status: number, body: object) => reply.code(status).header("cache-control", "no-store").send(body);
    const b = sessionOnly.safeParse(req.body);
    if (!b.success) return send(400, erro("ENTRADA_INVALIDA"));
    if (pixPerSession.tooMany(b.data.sessao_id, 30)) return send(429, erro("LIMITE_EXCEDIDO"));
    const session = await findSession(ctx.db, b.data.sessao_id);
    if (!session) return send(401, erro("SESSAO_INVALIDA"));
    if (!ctx.addon) return send(200, { ok: false });
    const ref = await ctx.db.query<{ checkout_id: string }>("SELECT checkout_id FROM checkout_refs WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1", [session.id]);
    const checkoutId = Number(ref[0]?.checkout_id);
    if (!Number.isInteger(checkoutId)) return send(200, { ok: false });
    try {
      const pix = await ctx.addon.pixCharge({ sessionId: session.id, checkoutId });
      if (!pix) return send(200, { ok: false });
      return send(200, { ok: true, ...pixBody(pix) });
    } catch {
      return send(200, { ok: false }); // the page falls back to the invoice link
    }
  });

  // Charges a card already tokenized in the browser (Iugu token, never the card number) against the session's
  // last checkout. Same ownership rule as /web/pix: only the session that signed up can charge its own invoice.
  const cardBody = z.object({ sessao_id: sessaoId, token: z.string().min(1).max(200), months: z.number().int().min(1).max(24) }).strict();
  app.post("/web/card", { bodyLimit: 2 * 1024 }, async (req, reply) => {
    const send = (status: number, body: object) => reply.code(status).header("cache-control", "no-store").send(body);
    const b = cardBody.safeParse(req.body);
    if (!b.success) return send(400, erro("ENTRADA_INVALIDA"));
    if (cardPerSession.tooMany(b.data.sessao_id, 10)) return send(429, erro("LIMITE_EXCEDIDO"));
    const session = await findSession(ctx.db, b.data.sessao_id);
    if (!session) return send(401, erro("SESSAO_INVALIDA"));
    if (!ctx.addon) return send(200, { ok: false, message: "Pagamento por cartão indisponível no momento. Tente com Pix." });
    const ref = await ctx.db.query<{ checkout_id: string }>("SELECT checkout_id FROM checkout_refs WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1", [session.id]);
    const checkoutId = Number(ref[0]?.checkout_id);
    if (!Number.isInteger(checkoutId)) return send(200, { ok: false, message: "Não encontramos seu pedido. Atualize a página e tente de novo." });
    try {
      const r = await ctx.addon.cardCharge({ sessionId: session.id, checkoutId, token: b.data.token, months: b.data.months });
      return send(200, r);
    } catch {
      return send(200, { ok: false, message: "Não foi possível processar o cartão agora. Tente de novo ou pague com Pix." });
    }
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
