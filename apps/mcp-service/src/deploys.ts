import { randomUUID } from "node:crypto";
import { strToU8 } from "fflate";
import type { Db } from "./db/index.js";
import type { ToolContext } from "./mcp/tools/define.js";
import { packZip } from "./scan/pack.js";

// Deploy queue. The database is the queue; the agent on the Plesk server claims one row at a time.
// Statuses: queued -> sending -> validating -> published | failed | rolled_back

export const KEEP_SNAPSHOTS = 5;
export type DeployStatus = "queued" | "sending" | "validating" | "published" | "failed" | "rolled_back";
export const ACTIVE_STATUSES: DeployStatus[] = ["queued", "sending", "validating"];

// History-API fallback for single-page apps (Apache/LiteSpeed). Added only when the project has no .htaccess of its own.
export const SPA_HTACCESS = `RewriteEngine On
RewriteBase /
RewriteRule ^index\\.html$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.html [L]
`;

export const deployKey = (subscriptionId: number | string, deployId: string) => `deploys/${subscriptionId}/${deployId}.zip`;

/** The zip the agent extracts straight into the docroot: only the site folder, prefix stripped. */
export function buildSitePackage(files: Map<string, Uint8Array>, folder: string, spa: boolean) {
  const prefix = folder === "." ? "" : `${folder}/`;
  const site = new Map<string, Uint8Array>();
  for (const [path, data] of files) if (path.startsWith(prefix)) site.set(path.slice(prefix.length), data);
  if (spa && !site.has(".htaccess")) site.set(".htaccess", strToU8(SPA_HTACCESS));
  return { ...packZip(site), files: site.size };
}

export interface DeployParams {
  spa: boolean;
  php_version: string | null;
  sha256: string;
  size_bytes: number;
  keep: number;
}

export async function createDeploy(ctx: ToolContext, sub: { whmcs_service_id: number }, uploadId: string, pkg: { zip: Uint8Array; sha256: string }, opts: { spa: boolean; phpVersion: string | null }): Promise<string> {
  const id = randomUUID();
  const key = deployKey(sub.whmcs_service_id, id);
  await ctx.storage.put(key, pkg.zip);
  const params: DeployParams = { spa: opts.spa, php_version: opts.phpVersion, sha256: pkg.sha256, size_bytes: pkg.zip.length, keep: KEEP_SNAPSHOTS };
  await ctx.db.query("INSERT INTO deploys (id, subscription_id, upload_id, status, params, package_key) VALUES ($1, $2, $3, 'queued', $4::jsonb, $5)", [id, sub.whmcs_service_id, uploadId, JSON.stringify(params), key]);
  return id;
}

export interface AgentJob {
  job_id: string;
  domain: string;
  sha256: string;
  size_bytes: number;
  php_version: string | null;
  spa: boolean;
  keep_snapshots: number;
}

/** Hands the oldest queued deploy of this server to its agent (FOR UPDATE SKIP LOCKED: two pollers never get the same one). */
export async function claimNextJob(db: Db, serverId: string): Promise<AgentJob | null> {
  const [row] = await db.query<{ id: string; params: DeployParams; domain: string }>(
    `UPDATE deploys d SET status = 'sending', step = 'claimed', claimed_at = now(), started_at = COALESCE(started_at, now())
      FROM subscriptions s
     WHERE s.whmcs_service_id = d.subscription_id
       AND d.id = (SELECT d2.id FROM deploys d2 JOIN subscriptions s2 ON s2.whmcs_service_id = d2.subscription_id
                    WHERE s2.server_id = $1 AND d2.status = 'queued' ORDER BY d2.created_at LIMIT 1 FOR UPDATE OF d2 SKIP LOCKED)
    RETURNING d.id, d.params, s.domain`,
    [serverId],
  );
  if (!row) return null;
  return { job_id: row.id, domain: row.domain, sha256: row.params.sha256, size_bytes: row.params.size_bytes, php_version: row.params.php_version, spa: row.params.spa, keep_snapshots: row.params.keep };
}

export interface AgentReport {
  status: "validating" | "published" | "failed" | "rolled_back";
  step?: string;
  error_code?: string;
  ssl?: boolean;
}

// What the agent may report from each state. Terminal states are final.
const NEXT: Record<string, AgentReport["status"][]> = {
  sending: ["validating", "failed"],
  validating: ["published", "failed", "rolled_back"],
};

export type ReportResult = "ok" | "not_found" | "bad_transition";

export async function reportJob(db: Db, serverId: string, deployId: string, r: AgentReport): Promise<ReportResult> {
  const [row] = await db.query<{ status: string }>(
    "SELECT d.status FROM deploys d JOIN subscriptions s ON s.whmcs_service_id = d.subscription_id WHERE d.id = $1 AND s.server_id = $2",
    [deployId, serverId],
  );
  if (!row) return "not_found"; // also covers jobs that belong to another server
  if (!NEXT[row.status]?.includes(r.status)) return "bad_transition";
  const terminal = r.status !== "validating";
  const [changed] = await db.query(
    `UPDATE deploys SET status = $3, step = COALESCE($4, step), error_code = $5, ssl = COALESCE($6, ssl), finished_at = CASE WHEN $7 THEN now() ELSE finished_at END
      WHERE id = $1 AND status = $2 RETURNING id`,
    [deployId, row.status, r.status, r.step ?? null, r.error_code ?? null, r.ssl ?? null, terminal],
  );
  return changed ? "ok" : "bad_transition"; // lost a race with another report
}

/** Agent stopped answering: nothing stays "in progress" forever. */
export async function failStaleDeploys(db: Db): Promise<number> {
  const stuck = await db.query("UPDATE deploys SET status = 'failed', error_code = 'agent_timeout', finished_at = now() WHERE status IN ('sending', 'validating') AND claimed_at < now() - interval '15 minutes' RETURNING id");
  const waiting = await db.query("UPDATE deploys SET status = 'failed', error_code = 'agent_unavailable', finished_at = now() WHERE status = 'queued' AND created_at < now() - interval '30 minutes' RETURNING id");
  return stuck.length + waiting.length;
}
