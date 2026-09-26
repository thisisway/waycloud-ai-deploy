import { promises as dns } from "node:dns";
import type { Db } from "./db/index.js";
import type { ToolContext } from "./mcp/tools/define.js";
import { previewBaseHost } from "./preview-serve.js";

// The customer's own domain becomes the site's main domain (the provisional <slug>.sites... one goes away).
// Flow: request -> waiting_dns (we check the customer's DNS) -> ready (the deploy agent switches it on the Plesk server)
// -> switching -> active (with or without HTTPS yet: the agent keeps retrying the certificate).

export type DomainStatus = "waiting_dns" | "ready" | "switching" | "active" | "failed" | "expired" | "cancelled";

export interface DomainRow {
  id: string;
  subscription_id: string | number;
  domain: string;
  status: DomainStatus;
  method: Method;
  include_www: boolean;
  ssl: boolean | null;
  error_code: string | null;
  created_at: Date;
}

// ---- validation ---------------------------------------------------------------------------------

const LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_RE = new RegExp(`^${LABEL}(\\.${LABEL})+$`);

/** What the customer typed -> a bare, lowercase host name (no scheme, path, port, "www." or trailing dot), or null. */
export function normalizeDomain(input: string): string | null {
  let d = input.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0]!.replace(/:\d+$/, "").replace(/\.$/, "");
  d = d.replace(/^www\./, ""); // the site lives on the bare domain; www is added when it points to us
  if (d.length > 253 || !DOMAIN_RE.test(d)) return null;
  if (/^\d+(\.\d+)+$/.test(d)) return null; // an IP address is not a domain
  const tld = d.slice(d.lastIndexOf(".") + 1);
  return /^[a-z]{2,24}$/.test(tld) || /^xn--[a-z0-9-]{2,20}$/.test(tld) ? d : null;
}

/** Domains that are ours (previews, provisional sites, the customer area): nobody may claim them. */
export function isReserved(domain: string, previewTemplate: string): boolean {
  const ours = [previewBaseHost(previewTemplate), "waycloud.com.br", "waypreview.com.br", "localhost"];
  return ours.some((o) => domain === o || domain.endsWith(`.${o}`));
}

// ---- DNS ------------------------------------------------------------------------------------------

export interface Resolver {
  resolve4(host: string): Promise<string[]>;
  resolveNs(host: string): Promise<string[]>;
  resolveMx(host: string): Promise<string[]>;
}
export const systemResolver: Resolver = { resolve4: (h) => dns.resolve4(h), resolveNs: (h) => dns.resolveNs(h), resolveMx: async (h) => (await dns.resolveMx(h)).map((m) => m.exchange) };

const safeResolve = async (r: Resolver, host: string): Promise<string[]> => {
  try {
    return (await r.resolve4(host)).sort();
  } catch {
    return []; // NXDOMAIN, no A record, timeout: all mean "not there yet"
  }
};
const safeNs = async (r: Resolver, host: string): Promise<string[]> => {
  try {
    return (await r.resolveNs(host)).map((n) => n.toLowerCase().replace(/\.$/, ""));
  } catch {
    return [];
  }
};

/** Where the customer must point the DNS: the target name and the IP(s) it resolves to today. */
export async function dnsTarget(r: Resolver, targetHost: string): Promise<{ host: string; ips: string[] }> {
  return { host: targetHost, ips: await safeResolve(r, targetHost) };
}

/**
 * The domain is ours to serve in one of two ways:
 *  - "records": ALL its A records are ours (a leftover record elsewhere would split the visitors);
 *  - "ns": its nameservers are ours (and only ours): the Plesk DNS zone is created when the site moves to the domain.
 */
export async function checkDns(r: Resolver, domain: string, targetHost: string, nameservers: string[]): Promise<{ ok: boolean; www: boolean; via?: "records" | "ns" }> {
  const [ours, ns] = await Promise.all([safeResolve(r, targetHost), safeNs(r, domain)]);
  if (ours.length) {
    const pointsToUs = (ips: string[]) => ips.length > 0 && ips.every((ip) => ours.includes(ip));
    const [main, www] = await Promise.all([safeResolve(r, domain), safeResolve(r, `www.${domain}`)]);
    if (pointsToUs(main)) return { ok: true, www: pointsToUs(www), via: "records" };
  }
  const mine = nameservers.map((n) => n.toLowerCase());
  if (ns.length > 0 && ns.every((n) => mine.includes(n))) return { ok: true, www: true, via: "ns" }; // our zone has the www record too
  return { ok: false, www: false };
}

export type Method = "ns" | "records";

export interface DomainInspection {
  existe: boolean; // has nameservers or an address today
  tem_email: boolean;
  provedor: "way" | "cloudflare" | "outro" | null; // who answers for its DNS today
  recomendado: Method;
  motivo: string;
}

const safeMx = async (r: Resolver, host: string): Promise<string[]> => {
  try {
    return await r.resolveMx(host);
  } catch {
    return [];
  }
};

/**
 * Looks at the domain's DNS as it is today and recommends the safest way to point it to us. Read-only: nothing is created.
 * Moving the nameservers takes the WHOLE DNS zone (e-mail included) to us, so it is only recommended for domains that look unused.
 */
export async function inspectDomain(r: Resolver, domain: string, nameservers: string[]): Promise<DomainInspection> {
  const [ns, a, mx] = await Promise.all([safeNs(r, domain), safeResolve(r, domain), safeMx(r, domain)]);
  const mine = nameservers.map((n) => n.toLowerCase());
  const delegated = ns.length > 0 && ns.every((n) => mine.includes(n));
  const provedor: DomainInspection["provedor"] = delegated ? "way" : ns.some((n) => n.endsWith(".ns.cloudflare.com")) ? "cloudflare" : ns.length ? "outro" : null;
  const base = { existe: ns.length > 0 || a.length > 0, tem_email: mx.length > 0, provedor };
  if (delegated) return { ...base, recomendado: "ns", motivo: "Os nameservers deste domínio já apontam para a Way Cloud." };
  if (mx.length) return { ...base, recomendado: "records", motivo: "Este domínio já tem e-mail configurado. Trocar os nameservers poderia derrubá-lo; criar 2 registros mantém todo o resto como está." };
  if (provedor === "cloudflare") return { ...base, recomendado: "records", motivo: "Você usa o Cloudflare: basta criar 2 registros lá, e o resto do seu DNS continua como está." };
  if (a.length) return { ...base, recomendado: "records", motivo: "Este domínio já tem um site em outro lugar. Criar 2 registros mantém o resto do DNS como está." };
  return { ...base, recomendado: "ns", motivo: "Este domínio parece novo (sem site nem e-mail). Apontar os nameservers para a Way Cloud deixa tudo automático." };
}

// ---- requests -----------------------------------------------------------------------------------------

const BACKOFF_SECONDS = [30, 60, 120, 300, 600, 1800, 3600];
const GIVE_UP_DAYS = 7;

export type RequestResult =
  | { ok: true; row: DomainRow }
  | { ok: false; codigo: "DOMINIO_INVALIDO" | "DOMINIO_RESERVADO" | "DOMINIO_EM_USO" | "SEM_SITE_PUBLICADO" | "SEM_PLANO_ATIVO" };

export async function requestDomain(ctx: ToolContext, sessionId: string, input: string, method: Method = "records"): Promise<RequestResult> {
  const domain = normalizeDomain(input);
  if (!domain) return { ok: false, codigo: "DOMINIO_INVALIDO" };
  if (isReserved(domain, ctx.settings.previewUrlTemplate)) return { ok: false, codigo: "DOMINIO_RESERVADO" };

  const [sub] = await ctx.db.query<{ whmcs_service_id: string | number }>(
    "SELECT s.whmcs_service_id FROM subscriptions s JOIN orders o ON o.session_id = s.session_id AND o.status = 'active' WHERE s.session_id = $1",
    [sessionId],
  );
  if (!sub) return { ok: false, codigo: "SEM_PLANO_ATIVO" };
  const [live] = await ctx.db.query("SELECT 1 FROM deploys WHERE subscription_id = $1 AND status = 'published' LIMIT 1", [sub.whmcs_service_id]);
  if (!live) return { ok: false, codigo: "SEM_SITE_PUBLICADO" };

  // Somebody else's site (or another request) already holds this domain.
  const [taken] = await ctx.db.query("SELECT 1 FROM subscriptions WHERE domain = $1 AND whmcs_service_id <> $2 UNION ALL SELECT 1 FROM domain_changes WHERE domain = $1 AND status IN ('waiting_dns', 'ready', 'switching', 'active') AND subscription_id <> $2", [domain, sub.whmcs_service_id]);
  if (taken) return { ok: false, codigo: "DOMINIO_EM_USO" };

  let row: DomainRow | undefined;
  await ctx.db.tx(async (tx) => {
    // A new request replaces one still waiting; a switch already in progress is left alone.
    await tx.query("UPDATE domain_changes SET status = 'cancelled', updated_at = now() WHERE subscription_id = $1 AND status = 'waiting_dns'", [sub.whmcs_service_id]);
    [row] = await tx.query<DomainRow>("INSERT INTO domain_changes (subscription_id, domain, method) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING *", [sub.whmcs_service_id, domain, method]);
  });
  if (!row) return { ok: false, codigo: "DOMINIO_EM_USO" }; // an open switch, or the same domain raced us
  await checkOne(ctx, row.id, ctx.resolver ?? systemResolver); // the DNS may already be right
  const [fresh] = await ctx.db.query<DomainRow>("SELECT * FROM domain_changes WHERE id = $1", [row.id]);
  return { ok: true, row: fresh! };
}

/** Checks one waiting request now; moves it to `ready` when the DNS is ours, or schedules the next check. */
export async function checkOne(ctx: ToolContext, id: string, resolver: Resolver): Promise<void> {
  const [row] = await ctx.db.query<{ id: string; domain: string; attempts: number; created_at: Date }>("SELECT id, domain, attempts, created_at FROM domain_changes WHERE id = $1 AND status = 'waiting_dns'", [id]);
  if (!row) return;
  const r = await checkDns(resolver, row.domain, ctx.settings.siteTargetHost, ctx.settings.nameservers);
  if (r.ok) {
    await ctx.db.query("UPDATE domain_changes SET status = 'ready', include_www = $2, dns_mode = $3, next_check_at = now(), updated_at = now() WHERE id = $1 AND status = 'waiting_dns'", [id, r.www, r.via ?? "records"]);
    return;
  }
  const wait = BACKOFF_SECONDS[Math.min(row.attempts, BACKOFF_SECONDS.length - 1)]!;
  await ctx.db.query("UPDATE domain_changes SET attempts = attempts + 1, next_check_at = now() + make_interval(secs => $2), updated_at = now() WHERE id = $1 AND status = 'waiting_dns'", [id, wait]);
}

/** Maintenance: the DNS checks that are due, and requests that waited for too long. */
export async function checkDueDomains(ctx: ToolContext, resolver: Resolver = ctx.resolver ?? systemResolver): Promise<number> {
  await ctx.db.query("UPDATE domain_changes SET status = 'expired', updated_at = now() WHERE status = 'waiting_dns' AND created_at < now() - make_interval(days => $1)", [GIVE_UP_DAYS]);
  const due = await ctx.db.query<{ id: string }>("SELECT id FROM domain_changes WHERE status = 'waiting_dns' AND next_check_at <= now() ORDER BY next_check_at LIMIT 50");
  for (const d of due) await checkOne(ctx, d.id, resolver);
  return due.length;
}

/** The latest request of this session's site (any status), or undefined. */
export async function latestDomainRequest(db: Db, sessionId: string): Promise<DomainRow | undefined> {
  const [row] = await db.query<DomainRow>(
    "SELECT c.* FROM domain_changes c JOIN subscriptions s ON s.whmcs_service_id = c.subscription_id WHERE s.session_id = $1 ORDER BY c.created_at DESC LIMIT 1",
    [sessionId],
  );
  return row;
}

export async function cancelDomainRequest(db: Db, sessionId: string): Promise<boolean> {
  const rows = await db.query(
    "UPDATE domain_changes c SET status = 'cancelled', updated_at = now() FROM subscriptions s WHERE s.whmcs_service_id = c.subscription_id AND s.session_id = $1 AND c.status = 'waiting_dns' RETURNING c.id",
    [sessionId],
  );
  return rows.length > 0;
}

// ---- what the customer sees ---------------------------------------------------------------------------------

export const TEXTO_STATUS: Record<DomainStatus, string> = {
  waiting_dns: "Aguardando o DNS do seu domínio. Pode levar de alguns minutos a algumas horas para propagar, e você não precisa ficar nesta página: assim que responder, a gente continua sozinho.",
  ready: "O DNS já está certo. Estamos configurando o seu domínio no servidor.",
  switching: "Configurando o seu domínio no servidor e ativando o HTTPS.",
  active: "Pronto! O seu domínio é o endereço principal do site.",
  failed: "Não consegui ativar o domínio. Fale com a gente pelo chat que a gente resolve.",
  expired: "O DNS não apontou para a Way Cloud a tempo e o pedido expirou. Confira os registros e conecte o domínio de novo.",
  cancelled: "Pedido cancelado.",
};

export const TEXTO_ERRO = {
  DOMINIO_INVALIDO: "Esse domínio não parece válido. Digite algo como meusite.com.br.",
  DOMINIO_RESERVADO: "Esse endereço pertence à Way Cloud e não pode ser usado aqui. Digite o seu próprio domínio.",
  DOMINIO_EM_USO: "Esse domínio já está em uso em outro site. Se ele é seu, fale com a gente pelo chat.",
  SEM_SITE_PUBLICADO: "Publique o site primeiro: o domínio só pode ser conectado a um site que já está no ar.",
  SEM_PLANO_ATIVO: "Não encontrei um plano ativo nesta sessão. Conclua a contratação primeiro.",
} as const;

/** The DNS records the customer must create (values are ours: never taken from what they typed). */
export function dnsInstructions(domain: string, target: { host: string; ips: string[] }, nameservers: string[]) {
  const ip = target.ips[0] ?? null;
  return {
    alvo: target.host,
    ip,
    nameservers,
    registros: [
      { tipo: "A", nome: domain, valor: ip ?? target.host, alternativa: `ou CNAME/ALIAS para ${target.host}, se o seu provedor de DNS aceitar no domínio principal` },
      { tipo: "CNAME", nome: `www.${domain}`, valor: target.host, alternativa: null },
    ],
  };
}

// ---- deploy agent ------------------------------------------------------------------------------------------------

export interface DomainJob {
  job_id: string;
  domain: string;
  old_domain: string;
  include_www: boolean;
  dns_mode: "records" | "ns";
}

/** Hands the oldest ready request of this server to its agent (two pollers never get the same one). */
export async function claimDomainJob(db: Db, serverId: string): Promise<DomainJob | null> {
  const [row] = await db.query<{ id: string; domain: string; old_domain: string; include_www: boolean; dns_mode: string | null }>(
    `UPDATE domain_changes c SET status = 'switching', step = 'claimed', claimed_at = now(), old_domain = s.domain, updated_at = now()
      FROM subscriptions s
     WHERE s.whmcs_service_id = c.subscription_id
       AND c.id = (SELECT c2.id FROM domain_changes c2 JOIN subscriptions s2 ON s2.whmcs_service_id = c2.subscription_id
                    WHERE s2.server_id = $1 AND c2.status = 'ready' ORDER BY c2.created_at LIMIT 1 FOR UPDATE OF c2 SKIP LOCKED)
    RETURNING c.id, c.domain, c.old_domain, c.include_www, c.dns_mode`,
    [serverId],
  );
  return row ? { job_id: row.id, domain: row.domain, old_domain: row.old_domain, include_www: row.include_www, dns_mode: row.dns_mode === "ns" ? "ns" : "records" } : null;
}

export interface DomainReport {
  status: "active" | "failed";
  step?: string;
  error_code?: string;
  ssl?: boolean;
}

/**
 * The switch is final when the agent reports `active`: from then on the site's domain is the customer's (our table, and WHMCS
 * once synced). A later `active` with ssl=true only upgrades the certificate state, like a deploy.
 */
export async function reportDomainJob(db: Db, serverId: string, id: string, r: DomainReport): Promise<"ok" | "not_found" | "bad_transition"> {
  const [row] = await db.query<{ status: DomainStatus; domain: string; subscription_id: string | number }>(
    "SELECT c.status, c.domain, c.subscription_id FROM domain_changes c JOIN subscriptions s ON s.whmcs_service_id = c.subscription_id WHERE c.id = $1 AND s.server_id = $2",
    [id, serverId],
  );
  if (!row) return "not_found";
  if (row.status === "active" && r.status === "active") {
    if (r.ssl !== true) return "bad_transition";
    await db.query("UPDATE domain_changes SET ssl = true, updated_at = now() WHERE id = $1 AND status = 'active'", [id]);
    return "ok";
  }
  if (row.status !== "switching") return "bad_transition";
  await db.tx(async (tx) => {
    await tx.query("UPDATE domain_changes SET status = $2, step = COALESCE($3, step), error_code = $4, ssl = COALESCE($5, ssl), updated_at = now() WHERE id = $1 AND status = 'switching'", [id, r.status, r.step ?? null, r.error_code ?? null, r.ssl ?? null]);
    if (r.status === "active") await tx.query("UPDATE subscriptions SET domain = $2 WHERE whmcs_service_id = $1", [row.subscription_id, row.domain]);
  });
  return "ok";
}

/** WHMCS must know the new domain: its Plesk module finds the subscription by it (suspend, terminate...). Retried until it works. */
export async function syncWhmcsDomains(ctx: ToolContext): Promise<number> {
  if (!ctx.addon) return 0;
  const rows = await ctx.db.query<{ id: string; subscription_id: string | number; domain: string }>("SELECT id, subscription_id, domain FROM domain_changes WHERE status = 'active' AND NOT whmcs_synced LIMIT 20");
  let synced = 0;
  for (const r of rows) {
    try {
      await ctx.addon.updateServiceDomain({ serviceId: Number(r.subscription_id), domain: r.domain });
      await ctx.db.query("UPDATE domain_changes SET whmcs_synced = true, updated_at = now() WHERE id = $1", [r.id]);
      synced++;
    } catch (e) {
      console.error(JSON.stringify({ msg: "whmcs domain sync failed", service: String(r.subscription_id), error: (e as { code?: string }).code ?? "unexpected" }));
    }
  }
  return synced;
}

/** A switch that was claimed and never reported back: the admin looks at it, it is not retried blindly. */
export async function failStaleSwitches(db: Db): Promise<number> {
  const rows = await db.query("UPDATE domain_changes SET status = 'failed', error_code = 'agent_timeout', updated_at = now() WHERE status = 'switching' AND claimed_at < now() - interval '30 minutes' RETURNING id");
  return rows.length;
}
