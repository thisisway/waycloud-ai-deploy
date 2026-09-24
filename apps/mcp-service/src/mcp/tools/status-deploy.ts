import { erro, ok, type MensagemCodigo } from "@waycloud/shared";
import type { DeployStatus } from "../../deploys.js";
import { findSession } from "../../sessions.js";
import { defineTool } from "./define.js";

const VIEW: Record<DeployStatus, { status: "na_fila" | "enviando" | "validando" | "publicado" | "falhou" | "revertido"; codigo: MensagemCodigo; wait: number }> = {
  queued: { status: "na_fila", codigo: "DEPLOY_NA_FILA", wait: 5 },
  sending: { status: "enviando", codigo: "DEPLOY_ENVIANDO", wait: 5 },
  validating: { status: "validando", codigo: "DEPLOY_VALIDANDO", wait: 5 },
  published: { status: "publicado", codigo: "DEPLOY_PUBLICADO", wait: 0 },
  failed: { status: "falhou", codigo: "DEPLOY_FALHOU", wait: 0 },
  rolled_back: { status: "revertido", codigo: "DEPLOY_REVERTIDO", wait: 0 },
};

export default defineTool(
  "status_deploy",
  "Use depois de publicar, com o deploy_id, para acompanhar a publicação: na_fila, enviando, validando, publicado, falhou ou revertido. A resposta diz de quantos em quantos segundos consultar de novo (0 = terminou). Quando publicado, traz o endereço do site.",
  async (ctx, a) => {
    const session = await findSession(ctx.db, a.sessao_id);
    if (!session) return erro("SESSAO_INVALIDA");
    // A session only ever sees its own deploys.
    const [d] = await ctx.db.query<{ status: DeployStatus; ssl: boolean | null; domain: string }>(
      "SELECT d.status, d.ssl, s.domain FROM deploys d JOIN subscriptions s ON s.whmcs_service_id = d.subscription_id WHERE d.id = $1 AND s.session_id = $2",
      [a.deploy_id, session.id],
    );
    if (!d) return erro("DEPLOY_NAO_ENCONTRADO");
    const v = VIEW[d.status];
    const published = d.status === "published";
    return ok(v.codigo, {
      status: v.status,
      url: published ? `${d.ssl ? "https" : "http"}://${d.domain}` : null,
      https_ativo: published ? !!d.ssl : null,
      intervalo_sugerido_segundos: v.wait,
    });
  },
);
