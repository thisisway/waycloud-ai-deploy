import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ToolContext } from "./mcp/tools/define.js";
import { readZip } from "./scan/archive.js";
import { newSlugRe, SPA_MARKER, writePreview } from "./previews.js";
import { previewSiteFromFiles } from "./preview-site.js";
import { packageKey } from "./uploads.js";

// Serves previews straight from the service, by Host: <slug>.<preview domain>. Untrusted customer files, so:
// each slug is its own origin, dotfiles and symlinks are never served, paths cannot leave the preview folder,
// and every page is marked noindex. A redeploy wipes the disk: the folder is rebuilt from the stored package.

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".pdf": "application/pdf", ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wasm": "application/wasm", ".webmanifest": "application/manifest+json",
};
const MAX_INJECT = 5 * 1024 * 1024;
const BANNER =
  '<div style="position:fixed;bottom:0;left:0;right:0;z-index:2147483647;background:#0b3d91;color:#fff;font:13px/1.4 system-ui,sans-serif;padding:6px 12px;text-align:center;opacity:.95">Prévia Way Cloud · temporária</div>';
const HEADERS = { "x-robots-tag": "noindex, nofollow, noarchive", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" };

/** Base domain of the previews, from the URL template (https://{slug}.waypreview.com.br -> waypreview.com.br). */
export const previewBaseHost = (template: string) => new URL(template.replace("{slug}", "x")).hostname.replace(/^x\./, "");

const notFound = (reply: FastifyReply) =>
  reply
    .code(404)
    .headers({ ...HEADERS, "content-type": "text/html; charset=utf-8" })
    .send("<!doctype html><meta charset=utf-8><title>Prévia não encontrada</title><body style=\"font:16px system-ui;text-align:center;margin:20vh 1rem\"><h1>Prévia não encontrada</h1><p>Ela pode ter expirado. Peça um novo link ao assistente que criou o site.</p>");

async function isFile(path: string) {
  try {
    const s = await lstat(path); // lstat: a symlink is never followed
    return s.isFile();
  } catch {
    return false;
  }
}

/** Resolves a URL path inside the preview folder, or null when it must not be served. */
async function resolveFile(dir: string, urlPath: string, spa: boolean): Promise<string | null> {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  } catch {
    return null;
  }
  if (rel.includes("\0") || rel.includes("\\")) return null;
  const parts = rel.split("/").filter(Boolean);
  if (parts.some((p) => p === ".." || p.startsWith("."))) return null; // no traversal, no dotfiles
  const base = resolve(dir);
  const candidates = rel.endsWith("/") || parts.length === 0 ? [join(base, ...parts, "index.html")] : [join(base, ...parts), join(base, ...parts, "index.html")];
  for (const c of candidates) if (c.startsWith(base + sep) && (await isFile(c))) return c;
  // History-API fallback for SPAs, only for navigations (paths without a file extension)
  if (spa && !extname(parts.at(-1) ?? "") && (await isFile(join(base, "index.html")))) return join(base, "index.html");
  return null;
}

export function registerPreviewHost(app: FastifyInstance, ctx: ToolContext) {
  const base = previewBaseHost(ctx.settings.previewUrlTemplate);
  const slugHost = newSlugRe(base);
  const building = new Map<string, Promise<boolean>>();
  const known = new Map<string, { until: number; row: { session_id: string; upload_id: string } | null }>(); // 30 s lookup cache

  async function lookup(slug: string) {
    const hit = known.get(slug);
    if (hit && hit.until > Date.now()) return hit.row;
    const [row] = await ctx.db.query<{ session_id: string; upload_id: string }>("SELECT session_id, upload_id FROM previews WHERE slug = $1 AND status = 'active' AND expires_at > now()", [slug]);
    known.set(slug, { until: Date.now() + 30_000, row: row ?? null });
    return row ?? null;
  }

  /** Makes sure the folder exists, rebuilding it from the stored package when a redeploy wiped it. */
  function ensureFolder(slug: string, row: { session_id: string; upload_id: string }): Promise<boolean> {
    const running = building.get(slug);
    if (running) return running;
    const dir = join(ctx.settings.previewRoot, slug);
    const job = (async () => {
      try {
        if ((await lstat(dir)).isDirectory()) return true;
      } catch {
        /* missing: rebuild */
      }
      const pkg = await ctx.storage.get(packageKey(row.session_id, row.upload_id));
      if (!pkg) return false;
      const site = previewSiteFromFiles(readZip(pkg), await ctx.plans());
      if (!site.ok) return false;
      await writePreview(ctx.settings.previewRoot, slug, site.site, site.spa);
      return true;
    })().finally(() => building.delete(slug));
    building.set(slug, job); // concurrent requests for the same slug share one rebuild
    return job;
  }

  async function serve(req: FastifyRequest, reply: FastifyReply, slug: string) {
    if (req.method !== "GET" && req.method !== "HEAD") return reply.code(405).headers({ ...HEADERS, allow: "GET, HEAD" }).send();
    const row = await lookup(slug);
    if (!row) return notFound(reply);
    let ready: boolean;
    try {
      ready = await ensureFolder(slug, row);
    } catch {
      ready = false;
    }
    if (!ready) return notFound(reply);

    const dir = join(ctx.settings.previewRoot, slug);
    const spa = await isFile(join(dir, SPA_MARKER));
    const file = await resolveFile(dir, req.url, spa);
    if (!file) return notFound(reply);

    const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    reply.headers({ ...HEADERS, "content-type": type });
    if (req.method === "HEAD") return reply.send();
    if (type.startsWith("text/html")) {
      const html = await readFile(file);
      if (html.length <= MAX_INJECT) {
        const s = html.toString("utf8");
        const i = s.toLowerCase().lastIndexOf("</body>");
        return reply.send(i >= 0 ? s.slice(0, i) + BANNER + s.slice(i) : s + BANNER);
      }
      return reply.send(html);
    }
    return reply.send(createReadStream(file));
  }

  // Runs before routing: on a preview host EVERYTHING is a preview request (/mcp, /agent and friends do not exist there).
  app.addHook("onRequest", async (req, reply) => {
    // Behind Cloudflare the Host is rewritten to the service's own domain (Easypanel has no wildcard certificate),
    // and a transform rule hands over the original one in X-Preview-Host. Someone forging it only reaches public previews.
    const host = String(req.headers["x-preview-host"] ?? req.headers.host ?? "").split(":")[0]!.toLowerCase();
    if (host === base) return; // the bare preview domain is the public site (page, /mcp, /llms): normal routing
    if (!host.endsWith(`.${base}`)) return;
    const m = slugHost.exec(host);
    await (m ? serve(req, reply, m[1]!) : notFound(reply));
    return reply;
  });
}
