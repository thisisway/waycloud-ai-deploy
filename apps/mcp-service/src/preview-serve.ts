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

// Wayline's own comment on this endpoint: the token in the URL is not a strong secret, it's meant to be
// pasted into public landing pages. Posting straight from the visitor's browser needs no server-side secret.
const WAYLINE_FORM_URL = "https://app.wayline.com.br/api/forms/t3YvyJK_eVPTbOjyhTbkpjgW";

const gatePage = (slug: string) => `<!doctype html>
<html lang="pt-br"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Prévia do site</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#eef4ff;
    font-family:'Plus Jakarta Sans',Inter,-apple-system,'Segoe UI',sans-serif;padding:24px}
  .card{max-width:380px;width:100%;background:#fff;border:1px solid #e0e6f7;border-radius:14px;padding:28px 24px;text-align:center}
  h1{margin:0 0 6px;color:#0b1023;font-size:19px;font-weight:800}
  p{color:#5b6785;font-size:13px;margin:0 0 20px;line-height:1.5}
  label{display:block;text-align:left;font-size:12px;font-weight:700;color:#0b1023;margin:14px 0 6px}
  input{width:100%;padding:11px 12px;border:1px solid #cbd4ea;border-radius:10px;font-size:14px;font-family:inherit}
  button{width:100%;margin-top:18px;padding:13px;background:#1d66ff;color:#fff;border:none;border-radius:10px;
    cursor:pointer;font-size:14.5px;font-weight:700;font-family:inherit}
  button:disabled{opacity:.6;cursor:default}
  #err{color:#8f1c14;font-size:12.5px;margin-top:10px;display:none}
  #ok{display:none;flex-direction:column;align-items:center}
  #ok svg{margin-bottom:12px}
  #ok h1{color:#0e7a42}
  .ok-circle{stroke-dasharray:190;stroke-dashoffset:190;animation:ok-circle .5s ease-out forwards}
  .ok-check{stroke-dasharray:34;stroke-dashoffset:34;animation:ok-check .35s .45s ease-out forwards}
  @keyframes ok-circle{to{stroke-dashoffset:0}}
  @keyframes ok-check{to{stroke-dashoffset:0}}
</style></head>
<body>
  <div class="card">
    <form id="f">
      <h1>Quase lá</h1>
      <p>Informe seu nome e WhatsApp pra ver a prévia do site.</p>
      <label for="nome">Nome</label>
      <input id="nome" autocomplete="name" required>
      <label for="whatsapp">WhatsApp</label>
      <input id="whatsapp" autocomplete="tel" inputmode="numeric" placeholder="(11) 91234-5678" required>
      <button type="submit">Ver o site</button>
      <div id="err">Confira o WhatsApp informado.</div>
    </form>
    <div id="ok">
      <svg width="60" height="60" viewBox="0 0 64 64" aria-hidden="true">
        <circle class="ok-circle" cx="32" cy="32" r="28" fill="none" stroke="#0e7a42" stroke-width="4"/>
        <path class="ok-check" d="M19 33l9 9 20-20" fill="none" stroke="#0e7a42" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <h1>Liberado!</h1>
      <p>Carregando o site...</p>
    </div>
  </div>
  <script>
    document.getElementById("whatsapp").addEventListener("input", function (e) {
      var d = e.target.value.replace(/\\D/g, "").slice(0, 11);
      e.target.value = d.length <= 10 ? d.replace(/(\\d{2})(\\d{4})(\\d{0,4})/, "($1) $2-$3").trim() : d.replace(/(\\d{2})(\\d{5})(\\d{0,4})/, "($1) $2-$3").trim();
    });
    document.getElementById("f").addEventListener("submit", function (e) {
      e.preventDefault();
      var nome = document.getElementById("nome").value.trim();
      var whatsapp = document.getElementById("whatsapp").value.replace(/\\D/g, "");
      if (nome.length < 2 || whatsapp.length < 10) { document.getElementById("err").style.display = "block"; return; }
      var btn = e.target.querySelector("button"); btn.disabled = true; btn.textContent = "Enviando...";
      fetch(${JSON.stringify(WAYLINE_FORM_URL)}, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: nome, phone: whatsapp }) }).catch(function () {});
      fetch("/__unlock?nome=" + encodeURIComponent(nome) + "&whatsapp=" + encodeURIComponent(whatsapp))
        .then(function (r) {
          if (!r.ok) return Promise.reject();
          document.getElementById("f").style.display = "none";
          document.getElementById("ok").style.display = "flex";
          setTimeout(function () { location.reload(); }, 1200);
        })
        .catch(function () { document.getElementById("err").style.display = "block"; btn.disabled = false; btn.textContent = "Ver o site"; });
    });
  </script>
</body></html>`;

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
  type Row = { session_id: string; upload_id: string; unlocked_at: string | null };
  const known = new Map<string, { until: number; row: Row | null }>(); // 30 s lookup cache

  async function lookup(slug: string) {
    const hit = known.get(slug);
    if (hit && hit.until > Date.now()) return hit.row;
    const [row] = await ctx.db.query<Row>("SELECT session_id, upload_id, unlocked_at FROM previews WHERE slug = $1 AND status = 'active' AND expires_at > now()", [slug]);
    known.set(slug, { until: Date.now() + 30_000, row: row ?? null });
    return row ?? null;
  }

  /** GET /__unlock?nome=...&whatsapp=... — the first visitor who fills the lead form unlocks this slug for good. */
  async function unlock(req: FastifyRequest, reply: FastifyReply, slug: string) {
    const row = await lookup(slug);
    if (!row) return notFound(reply);
    const q = new URL(req.url, "http://x").searchParams;
    const nome = (q.get("nome") ?? "").trim();
    const whatsapp = (q.get("whatsapp") ?? "").replace(/\D/g, "");
    if (nome.length < 2 || whatsapp.length < 10 || whatsapp.length > 11) {
      return reply.code(400).headers({ ...HEADERS, "content-type": "application/json" }).send(JSON.stringify({ error: "dados_invalidos" }));
    }
    await ctx.db.query("UPDATE previews SET unlocked_at = now() WHERE slug = $1 AND unlocked_at IS NULL", [slug]);
    known.delete(slug); // the 30s cache must not keep showing the gate right after a successful unlock
    return reply.headers({ ...HEADERS, "content-type": "application/json" }).send(JSON.stringify({ ok: true }));
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
    if (!row.unlocked_at) return reply.headers({ ...HEADERS, "content-type": "text/html; charset=utf-8" }).send(gatePage(slug));
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
    if (!m) {
      await notFound(reply);
      return reply;
    }
    const isUnlock = req.method === "GET" && new URL(req.url, "http://x").pathname === "/__unlock";
    await (isUnlock ? unlock(req, reply, m[1]!) : serve(req, reply, m[1]!));
    return reply;
  });
}
