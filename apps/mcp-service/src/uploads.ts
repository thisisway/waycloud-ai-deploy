import type { AvisoCodigo, MensagemCodigo } from "@waycloud/shared";
import type { ToolContext } from "./mcp/tools/define.js";
import { ArchiveError, readZip } from "./scan/archive.js";
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

/** The upload a tool should act on: the one named by the AI (must belong to the session) or the latest usable one. */
export async function selectUpload(ctx: ToolContext, sessionId: string, uploadId?: string): Promise<UploadRow | undefined> {
  const [row] = uploadId
    ? await ctx.db.query<UploadRow>("SELECT id, session_id, scan_status FROM uploads WHERE id = $1 AND session_id = $2", [uploadId, sessionId])
    : await ctx.db.query<UploadRow>("SELECT id, session_id, scan_status FROM uploads WHERE session_id = $1 AND scan_status IN ('awaiting_upload', 'clean') ORDER BY created_at DESC LIMIT 1", [sessionId]);
  return row;
}

export type Prepared = { ok: false; codigo: MensagemCodigo } | { ok: true; files: Map<string, Uint8Array> };

/**
 * Turns an upload into its clean files: a raw .zip (from the pre-signed URL) is read, scanned and stored as
 * a normalized package; an already clean package is just loaded. Failures are fixed messages.
 */
export async function prepareUpload(ctx: ToolContext, sessionId: string, upload: UploadRow): Promise<Prepared> {
  if (upload.scan_status === "blocked") return { ok: false, codigo: "ARQUIVOS_REPROVADOS" };
  if (upload.scan_status === "clean") {
    const pkg = await ctx.storage.get(packageKey(sessionId, upload.id));
    return pkg ? { ok: true, files: readZip(pkg) } : { ok: false, codigo: "UPLOAD_NAO_ENCONTRADO" };
  }
  if (upload.scan_status !== "awaiting_upload") return { ok: false, codigo: "UPLOAD_NAO_ENCONTRADO" };

  const raw = await ctx.storage.get(rawKey(sessionId, upload.id));
  if (!raw) return { ok: false, codigo: "UPLOAD_NAO_ENCONTRADO" };
  let entries: Map<string, Uint8Array>;
  try {
    entries = readZip(raw);
  } catch (e) {
    if (!(e instanceof ArchiveError)) throw e;
    await ctx.db.query("UPDATE uploads SET scan_status = 'invalid' WHERE id = $1", [upload.id]);
    await ctx.storage.remove(rawKey(sessionId, upload.id));
    return { ok: false, codigo: "ARQUIVO_INVALIDO" };
  }
  const stored = await storePackage(ctx, sessionId, upload.id, entries);
  await ctx.storage.remove(rawKey(sessionId, upload.id));
  return stored.ok ? { ok: true, files: stored.files } : { ok: false, codigo: "ARQUIVOS_REPROVADOS" };
}
