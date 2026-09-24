import { erro, ok } from "@waycloud/shared";
import { ACTIVE_STATUSES, buildSitePackage, createDeploy } from "../../deploys.js";
import { analyzeProject } from "../../detect/detect.js";
import { PlansUnavailable } from "../../plans.js";
import { findSession } from "../../sessions.js";
import { prepareUpload, selectUpload } from "../../uploads.js";
import { defineTool } from "./define.js";

const text = (b: Uint8Array | undefined) => (b ? Buffer.from(b).toString("utf8").slice(0, 200_000) : undefined);

export default defineTool(
  "publicar",
  "Use SÓ depois que status_pedido estiver 'ativo': publica os arquivos enviados na hospedagem definitiva do cliente, com HTTPS. Sem upload_id usa o envio mais recente. A troca é atômica: se algo falhar, o site anterior continua no ar. Depois consulte status_deploy até o site ser publicado.",
  async (ctx, a) => {
    const session = await findSession(ctx.db, a.sessao_id);
    if (!session) return erro("SESSAO_INVALIDA");

    const [order] = await ctx.db.query<{ status: string }>("SELECT status FROM orders WHERE session_id = $1", [session.id]);
    const [sub] = await ctx.db.query<{ whmcs_service_id: number }>("SELECT whmcs_service_id FROM subscriptions WHERE session_id = $1", [session.id]);
    if (order?.status !== "active" || !sub) return erro("PEDIDO_NAO_ATIVO");

    const running = await ctx.db.query("SELECT 1 FROM deploys WHERE subscription_id = $1 AND status = ANY($2)", [sub.whmcs_service_id, ACTIVE_STATUSES]);
    if (running.length) return erro("DEPLOY_EM_ANDAMENTO");

    const upload = await selectUpload(ctx, session.id, a.upload_id);
    if (!upload) return erro("UPLOAD_NAO_ENCONTRADO");
    const prepared = await prepareUpload(ctx, session.id, upload);
    if (!prepared.ok) return erro(prepared.codigo);

    let analysis;
    try {
      analysis = analyzeProject(
        { arquivos: [...prepared.files].map(([caminho, b]) => ({ caminho, tamanho: b.length })), package_json: text(prepared.files.get("package.json")), composer_json: text(prepared.files.get("composer.json")) },
        await ctx.plans(),
      );
    } catch (e) {
      if (e instanceof PlansUnavailable) return erro("PLANOS_INDISPONIVEIS");
      throw e;
    }
    const { analise, folder } = analysis;
    if (analise.avisos.some((v) => v.codigo === "PASTA_BUILD_AUSENTE")) return erro("PASTA_BUILD_AUSENTE");
    if (!analise.suportado || folder === null) return erro("PROJETO_NAO_SUPORTADO");

    const pkg = buildSitePackage(prepared.files, folder, analise.tipo === "spa");
    const deployId = await createDeploy(ctx, sub, upload.id, pkg, { spa: analise.tipo === "spa", phpVersion: analise.versao_php });
    await ctx.db.query("INSERT INTO audit_log (correlation_id, actor, action, meta) VALUES ($1, 'session', 'deploy.queued', $2::jsonb)", [session.id, JSON.stringify({ deploy_id: deployId, type: analise.tipo })]);
    return ok("DEPLOY_INICIADO", { deploy_id: deployId });
  },
);
