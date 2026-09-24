import { erro, ok } from "@waycloud/shared";
import { analyzeProject } from "../../detect/detect.js";
import { newSlug, previewUrl, removePreview, writePreview } from "../../previews.js";
import { findSession } from "../../sessions.js";
import { prepareUpload, selectUpload } from "../../uploads.js";
import { defineTool } from "./define.js";

const text = (b: Uint8Array | undefined) => (b ? Buffer.from(b).toString("utf8").slice(0, 200_000) : undefined);

export default defineTool(
  "criar_previa",
  "Use depois de enviar os arquivos (obter_url_upload + PUT do .zip, ou enviar_arquivos) para publicar uma prévia GRÁTIS e temporária de sites estáticos ou SPAs já compiladas, e receber a URL e a data de expiração. Sites PHP não têm prévia. Mostre a URL ao cliente.",
  async (ctx, a) => {
    const session = await findSession(ctx.db, a.sessao_id);
    if (!session) return erro("SESSAO_INVALIDA");

    const upload = await selectUpload(ctx, session.id, a.upload_id);
    if (!upload) return erro("UPLOAD_NAO_ENCONTRADO");
    const prepared = await prepareUpload(ctx, session.id, upload);
    if (!prepared.ok) return erro(prepared.codigo);
    const files = prepared.files;

    const { analise, folder } = analyzeProject(
      { arquivos: [...files].map(([caminho, b]) => ({ caminho, tamanho: b.length })), package_json: text(files.get("package.json")), composer_json: text(files.get("composer.json")) },
      await ctx.plans(),
    );
    if (analise.tipo === "php") return erro("PREVIA_INDISPONIVEL_PHP");
    if (analise.avisos.some((v) => v.codigo === "PASTA_BUILD_AUSENTE")) return erro("PASTA_BUILD_AUSENTE");
    if (!analise.suportado || folder === null) return erro("PROJETO_NAO_SUPORTADO");

    const [{ n }] = await ctx.db.query<{ n: string }>("SELECT count(*)::text AS n FROM previews WHERE session_id = $1 AND status = 'active'", [session.id]) as [{ n: string }];
    if (Number(n) >= ctx.settings.maxActivePreviews) return erro("LIMITE_EXCEDIDO");

    const prefix = folder === "." ? "" : `${folder}/`;
    const site = new Map<string, Uint8Array>();
    for (const [path, data] of files) if (path.startsWith(prefix)) site.set(path.slice(prefix.length), data);

    let slug = "";
    let expiresAt: Date | undefined;
    for (let attempt = 0; attempt < 5 && !expiresAt; attempt++) {
      slug = newSlug();
      const [row] = await ctx.db.query<{ expires_at: Date }>(
        "INSERT INTO previews (session_id, upload_id, slug, url, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5)) ON CONFLICT (slug) DO NOTHING RETURNING expires_at",
        [session.id, upload.id, slug, previewUrl(ctx.settings.previewUrlTemplate, slug), ctx.settings.previewTtlHours],
      );
      expiresAt = row?.expires_at;
    }
    if (!expiresAt) throw new Error("could not allocate a preview slug");

    try {
      await writePreview(ctx.settings.previewRoot, slug, site, analise.tipo === "spa");
    } catch (e) {
      await removePreview(ctx.settings.previewRoot, slug);
      await ctx.db.query("UPDATE previews SET status = 'failed' WHERE slug = $1", [slug]);
      throw e;
    }
    return ok("PREVIA_CRIADA", { url: previewUrl(ctx.settings.previewUrlTemplate, slug), expira_em: expiresAt.toISOString() });
  },
);
