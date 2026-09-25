import { erro, ok } from "@waycloud/shared";
import { PlansUnavailable } from "../../plans.js";
import { detectProject } from "../../detect/detect.js";
import { findSession } from "../../sessions.js";
import { defineTool } from "./define.js";

export default defineTool(
  "analisar_projeto",
  "Use depois de iniciar_sessao, com o manifesto do projeto: lista de arquivos com tamanhos (NUNCA inclua node_modules nem .git) e, se existirem, o texto do package.json e do composer.json. Retorna o tipo do projeto (estático, SPA, PHP...), pasta a publicar, requisitos, plano recomendado e avisos. Não envie o conteúdo dos arquivos.",
  async (ctx, args) => {
    const session = await findSession(ctx.db, args.sessao_id);
    if (!session) return erro("SESSAO_INVALIDA");
    let analise;
    try {
      analise = detectProject(args.manifesto, await ctx.plans());
    } catch (e) {
      if (e instanceof PlansUnavailable) return erro("PLANOS_INDISPONIVEIS");
      throw e;
    }
    await ctx.db.query("INSERT INTO projects (session_id, detected_type, analysis) VALUES ($1, $2, $3::text::jsonb)", [session.id, analise.tipo, JSON.stringify(analise)]);
    return ok(analise.suportado ? "PROJETO_ANALISADO" : "PROJETO_NAO_SUPORTADO", analise);
  },
);
