import { randomUUID } from "node:crypto";
import { erro, ok } from "@waycloud/shared";
import { findSession } from "../../sessions.js";
import { countUploadsToday, packageKey, rawKey } from "../../uploads.js";
import { defineTool } from "./define.js";

export default defineTool(
  "obter_url_upload",
  "Use para enviar o projeto inteiro como um único .zip (sem node_modules). Informe o tamanho exato do arquivo em bytes. Retorna uma URL pré-assinada de upload (PUT, validade de 15 minutos) que só aceita um corpo com exatamente esse tamanho. Depois do envio, chame criar_previa.",
  async (ctx, a) => {
    const session = await findSession(ctx.db, a.sessao_id);
    if (!session) return erro("SESSAO_INVALIDA");
    if ((await countUploadsToday(ctx, session.id)) >= ctx.settings.maxUploadsPerDay) return erro("LIMITE_EXCEDIDO");

    const uploadId = randomUUID();
    await ctx.db.query("INSERT INTO uploads (id, session_id, storage_key, source, scan_status) VALUES ($1, $2, $3, 'presigned', 'awaiting_upload')", [uploadId, session.id, packageKey(session.id, uploadId)]);
    const ttl = ctx.settings.uploadUrlTtlSeconds;
    const url = await ctx.storage.presignPut(rawKey(session.id, uploadId), a.tamanho_bytes, ttl);
    return ok("UPLOAD_PRONTO", { upload_id: uploadId, url, metodo: "PUT" as const, expira_em: new Date(Date.now() + ttl * 1000).toISOString(), tamanho_maximo_bytes: a.tamanho_bytes });
  },
);
