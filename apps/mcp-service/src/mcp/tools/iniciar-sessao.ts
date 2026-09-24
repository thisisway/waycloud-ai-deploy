import { ok } from "@waycloud/shared";
import { createSession } from "../../sessions.js";
import { defineTool } from "./define.js";

const FLUXO = [
  "1. Analise o projeto (analisar_projeto).",
  "2. Mostre os planos ao cliente (listar_planos).",
  "3. Envie os arquivos (obter_url_upload ou enviar_arquivos).",
  "4. Crie a prévia grátis (criar_previa).",
  "5. Gere o link de pagamento (criar_checkout) e entregue ao cliente. Nunca peça dados pessoais ou de pagamento no chat.",
  "6. Acompanhe o pedido (status_pedido) até ficar ativo.",
  "7. Publique o site (publicar) e confira o resultado (verificar_site).",
];

export default defineTool(
  "iniciar_sessao",
  "Use SEMPRE primeiro, quando o cliente pedir para publicar ou hospedar um site na Way Cloud. Cria uma sessão anônima e devolve o sessao_id que as outras ferramentas exigem, junto com o passo a passo do fluxo.",
  async (ctx) => {
    const { token, expiresAt } = await createSession(ctx.db);
    return ok("SESSAO_CRIADA", { sessao_id: token, expira_em: expiresAt.toISOString(), fluxo: FLUXO });
  },
);
