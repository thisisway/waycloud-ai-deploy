import type { AvisoCodigo } from "@waycloud/shared";
import type { ToolContext } from "./mcp/tools/define.js";
import { packZip } from "./scan/pack.js";
import { scan, type FindingCode } from "./scan/scan.js";

// R2 lifecycle rule (uploads/ -> delete after 7 days) is the safety net; the maintenance job is the primary cleanup.
export const rawKey = (sessionId: string, uploadId: string) => `uploads/raw/${sessionId}/${uploadId}.zip`;
export const packageKey = (sessionId: string, uploadId: string) => `uploads/packages/${sessionId}/${uploadId}.zip`;

export interface UploadRow {
  id: string;
  session_id: string;
  scan_status: string;
}

const WARNING_OF: Partial<Record<FindingCode, AvisoCodigo>> = {
  ENV_REMOVED: "ENV_EXCLUIDO",
  JUNK_REMOVED: "ARQUIVOS_DESNECESSARIOS_REMOVIDOS",
  BAD_PATH: "CAMINHO_INVALIDO",
};

export type StoreResult = { ok: false } | { ok: true; files: Map<string, Uint8Array>; totalBytes: number; warnings: AvisoCodigo[] };

// Scans the files and, when approved, stores the clean, normalized package the deploy agent will receive.
// Finding details stay in the database (scan_report); the AI only ever sees fixed messages.
export async function storePackage(ctx: ToolContext, sessionId: string, uploadId: string, input: Map<string, Uint8Array>): Promise<StoreResult> {
  const result = scan(input);
  const report = JSON.stringify(result.findings);
  if (!result.approved) {
    await ctx.db.query("UPDATE uploads SET scan_status = 'blocked', scan_report = $2::jsonb WHERE id = $1", [uploadId, report]);
    return { ok: false };
  }
  const packed = packZip(result.files);
  await ctx.storage.put(packageKey(sessionId, uploadId), packed.zip);
  await ctx.db.query("UPDATE uploads SET scan_status = 'clean', sha256 = $2, size_bytes = $3, scan_report = $4::jsonb WHERE id = $1", [uploadId, packed.sha256, packed.zip.length, report]);
  const warnings = [...new Set(result.findings.flatMap((f) => WARNING_OF[f.code] ?? []))];
  return { ok: true, files: result.files, totalBytes: [...result.files.values()].reduce((n, b) => n + b.length, 0), warnings };
}

export async function countUploadsToday(ctx: ToolContext, sessionId: string): Promise<number> {
  const [row] = await ctx.db.query<{ n: string }>("SELECT count(*)::text AS n FROM uploads WHERE session_id = $1 AND created_at > now() - interval '1 day'", [sessionId]);
  return Number(row!.n);
}
