import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { erro, ok } from "@waycloud/shared";
import type { ToolContext } from "./mcp/tools/define.js";
import { findSession } from "./sessions.js";
import { rawKey } from "./uploads.js";

// The public page (drop a .zip, see the preview, pick a plan, pay, publish) and the one endpoint it needs
// besides /mcp: a same-origin upload, so the browser never talks to the object storage (no CORS to manage).

const PAGES: Record<string, { file: string; type: string; immutable?: boolean }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/site.css": { file: "site.css", type: "text/css; charset=utf-8" },
  "/site.js": { file: "site.js", type: "text/javascript; charset=utf-8" },
  "/flow.js": { file: "flow.js", type: "text/javascript; charset=utf-8" },
  "/fonts/plus-jakarta-sans-v12-latin.woff2": { file: "fonts/plus-jakarta-sans-v12-latin.woff2", type: "font/woff2", immutable: true }, // self-hosted: no request to Google
};
const HEADERS = {
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-cache",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_WEB_ZIP_BYTES = 50 * 1024 * 1024; // same cap as the pre-signed upload

export function registerWeb(app: FastifyInstance, ctx: ToolContext) {
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
}
