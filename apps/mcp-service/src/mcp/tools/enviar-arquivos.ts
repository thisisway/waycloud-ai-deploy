import { randomUUID } from "node:crypto";
import { AVISOS, erro, ok } from "@waycloud/shared";
import { normalizePath } from "../../security/sanitize.js";
import { findSession } from "../../sessions.js";
import { countUploadsToday, packageKey, storePackage } from "../../uploads.js";
import { defineTool } from "./define.js";

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export default defineTool(
  "enviar_arquivos",
  "Use SÓ para sites pequenos criados no próprio chat (até 5 MB no total, máximo 200 arquivos): envie cada arquivo com o caminho relativo e o conteúdo em base64. Para projetos maiores, use obter_url_upload.",
  async (ctx, a) => {
    const session = await findSession(ctx.db, a.sessao_id);
    if (!session) return erro("SESSAO_INVALIDA");

    const files = new Map<string, Uint8Array>();
    let total = 0;
    for (const f of a.arquivos) {
      const path = normalizePath(f.caminho);
      if (!path || !BASE64.test(f.conteudo_base64)) return erro("ARQUIVOS_INVALIDOS");
      const bytes = Buffer.from(f.conteudo_base64, "base64");
      total += bytes.length;
      if (total > ctx.settings.maxInlineBytes) return erro("ARQUIVOS_MUITO_GRANDES");
      files.set(path, bytes);
    }
    if ((await countUploadsToday(ctx, session.id)) >= ctx.settings.maxUploadsPerDay) return erro("LIMITE_EXCEDIDO");

    const uploadId = randomUUID();
    await ctx.db.query("INSERT INTO uploads (id, session_id, storage_key, source, scan_status) VALUES ($1, $2, $3, 'inline', 'pending')", [uploadId, session.id, packageKey(session.id, uploadId)]);
    const stored = await storePackage(ctx, session.id, uploadId, files);
    if (!stored.ok) return erro("ARQUIVOS_REPROVADOS");
    return ok("ARQUIVOS_RECEBIDOS", {
      upload_id: uploadId,
      arquivos_recebidos: stored.files.size,
      tamanho_total_bytes: stored.totalBytes,
      avisos: stored.warnings.map((codigo) => ({ codigo, mensagem: AVISOS[codigo] })),
    });
  },
);
