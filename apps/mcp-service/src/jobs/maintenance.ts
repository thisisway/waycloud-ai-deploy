import { removePreview } from "../previews.js";
import type { ToolContext } from "../mcp/tools/define.js";
import { packageKey, rawKey } from "../uploads.js";

// Removes expired previews from disk and marks them. Files first, row second: if the removal
// throws, the row stays 'active' and the next run retries.
export async function expirePreviews(ctx: ToolContext): Promise<number> {
  const rows = await ctx.db.query<{ id: string; slug: string }>("SELECT id, slug FROM previews WHERE status = 'active' AND expires_at < now()");
  for (const r of rows) {
    await removePreview(ctx.settings.previewRoot, r.slug);
    await ctx.db.query("UPDATE previews SET status = 'expired', removed_at = now() WHERE id = $1", [r.id]);
  }
  return rows.length;
}

// Uploads of sessions that never became an order are deleted after `days` (LGPD: no data kept without purpose).
export async function cleanupStaleUploads(ctx: ToolContext, days = 7): Promise<number> {
  const rows = await ctx.db.query<{ id: string; session_id: string }>(
    `SELECT u.id, u.session_id FROM uploads u
      LEFT JOIN orders o ON o.session_id = u.session_id
     WHERE o.session_id IS NULL AND u.scan_status <> 'expired' AND u.created_at < now() - make_interval(days => $1)`,
    [days],
  );
  for (const r of rows) {
    await ctx.storage.remove(rawKey(r.session_id, r.id));
    await ctx.storage.remove(packageKey(r.session_id, r.id));
    await ctx.db.query("UPDATE uploads SET scan_status = 'expired' WHERE id = $1", [r.id]);
  }
  return rows.length;
}

// Sessions (and, by cascade, their projects, uploads and previews) that never ordered are erased after `days` past expiry.
export async function purgeOldSessions(ctx: ToolContext, days = 30): Promise<number> {
  const rows = await ctx.db.query(
    "DELETE FROM sessions s WHERE s.expires_at < now() - make_interval(days => $1) AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.session_id = s.id) RETURNING s.id",
    [days],
  );
  return rows.length;
}

export async function runMaintenance(ctx: ToolContext) {
  return { previews: await expirePreviews(ctx), uploads: await cleanupStaleUploads(ctx), sessions: await purgeOldSessions(ctx) };
}

// ponytail: single-instance timer. With more than one replica, add a lock (pg_try_advisory_lock) or move to BullMQ.
export function startMaintenance(ctx: ToolContext, everyMs = 10 * 60_000, log: (o: object) => void = () => {}): () => void {
  const tick = () => runMaintenance(ctx).then((r) => (r.previews || r.uploads || r.sessions) && log({ msg: "maintenance", ...r })).catch((e: unknown) => log({ msg: "maintenance failed", error: String(e) }));
  const timer = setInterval(tick, everyMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
