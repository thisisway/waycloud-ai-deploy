import { erro, ok } from "@waycloud/shared";
import { findSession } from "../../sessions.js";
import { defineTool } from "./define.js";

const MAX_BODY = 1024 * 1024;
const MAX_LINKS = 25;
const TIMEOUT_MS = 8000;

// The host is ALWAYS the subscription's domain from our own database, never anything the AI or the project
// supplies, and redirects are followed only within that host (no SSRF).
async function get(f: typeof fetch, url: URL, host: string, hops = 3): Promise<{ status: number; body: string; ms: number; url: URL } | null> {
  const t0 = Date.now();
  for (let i = 0; i <= hops; i++) {
    let res: Response;
    try {
      res = await f(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": "WayCloud-Verifier/1.0" } });
    } catch {
      return null;
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      const next = new URL(res.headers.get("location")!, url);
      if (next.hostname !== host) return { status: res.status, body: "", ms: Date.now() - t0, url }; // do not leave the site
      url = next;
      continue;
    }
    const body = (await res.text()).slice(0, MAX_BODY);
    return { status: res.status, body, ms: Date.now() - t0, url };
  }
  return null;
}

function internalLinks(html: string, base: URL): URL[] {
  const out = new Map<string, URL>();
  for (const m of html.matchAll(/\s(?:href|src)\s*=\s*["']([^"'#\s][^"']*)["']/gi)) {
    const raw = m[1]!;
    if (/^(mailto:|tel:|javascript:|data:|sms:)/i.test(raw)) continue;
    try {
      const u = new URL(raw, base);
      if (u.hostname === base.hostname && (u.protocol === "https:" || u.protocol === "http:")) {
        u.hash = "";
        out.set(u.href, u);
      }
    } catch {
      /* not a URL */
    }
    if (out.size >= MAX_LINKS) break;
  }
  return [...out.values()];
}

export default defineTool(
  "verificar_site",
  "Use depois que o deploy estiver publicado: confere se o site responde (HTTP), se o HTTPS funciona, quanto tempo leva para responder e se há links internos quebrados, e devolve um relatório curto para mostrar ao cliente.",
  async (ctx, a) => {
    const session = await findSession(ctx.db, a.sessao_id);
    if (!session) return erro("SESSAO_INVALIDA");
    const [sub] = await ctx.db.query<{ domain: string }>("SELECT domain FROM subscriptions WHERE session_id = $1", [session.id]);
    const [deploy] = await ctx.db.query<{ id: string }>("SELECT d.id FROM deploys d JOIN subscriptions s ON s.whmcs_service_id = d.subscription_id WHERE s.session_id = $1 AND d.status = 'published' ORDER BY d.finished_at DESC LIMIT 1", [session.id]);
    if (!sub || !deploy) return erro("DEPLOY_NAO_ENCONTRADO");

    const f = ctx.fetchFn ?? fetch;
    let sslOk = true;
    let main = await get(f, new URL(`https://${sub.domain}/`), sub.domain);
    if (!main) {
      sslOk = false; // HTTPS did not answer (or the certificate is not valid yet): see whether plain HTTP does
      main = await get(f, new URL(`http://${sub.domain}/`), sub.domain);
    }
    const status = main?.status ?? 0;
    let broken = 0;
    if (main && status >= 200 && status < 400 && /<[a-z]/i.test(main.body)) {
      const links = internalLinks(main.body, main.url);
      const results = await Promise.all(links.map((l) => get(f, l, sub.domain, 2)));
      broken = results.filter((r) => !r || r.status >= 400).length;
    }
    const ms = main?.ms ?? 0;
    await ctx.db.query("INSERT INTO verifications (deploy_id, http_status, ssl_ok, broken_links, ttfb_ms) VALUES ($1, $2, $3, $4, $5)", [deploy.id, status, sslOk, broken, ms]);

    const good = status >= 200 && status < 400 && sslOk && broken === 0;
    return ok(good ? "SITE_VERIFICADO" : "SITE_COM_PROBLEMAS", { http_status: status, ssl_ok: sslOk, tempo_resposta_ms: ms, links_quebrados: broken });
  },
);
