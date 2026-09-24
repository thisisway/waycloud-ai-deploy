import { erro, ok } from "@waycloud/shared";
import { AddonError } from "../../addon.js";
import { PlansUnavailable } from "../../plans.js";
import { findSession } from "../../sessions.js";
import { defineTool } from "./define.js";

export default defineTool(
  "criar_checkout",
  "Use quando o cliente aprovar a prévia e escolher o plano (plano_pid de listar_planos) e o ciclo (mensal ou anual). Gera um link único de cadastro rápido e pagamento (Pix ou cartão) que o CLIENTE abre no navegador. Entregue o link e nunca peça CPF, senha, telefone ou dados de pagamento no chat.",
  async (ctx, a) => {
    const session = await findSession(ctx.db, a.sessao_id);
    if (!session) return erro("SESSAO_INVALIDA");
    let plans;
    try {
      plans = await ctx.plans();
    } catch (e) {
      if (e instanceof PlansUnavailable) return erro("PLANOS_INDISPONIVEIS");
      throw e;
    }
    if (!plans.some((p) => p.pid === a.plano_pid)) return erro("PLANO_INVALIDO");
    if (!ctx.addon) return erro("CHECKOUT_INDISPONIVEL");

    try {
      // The addon gets the internal session id (never the bearer token the AI holds).
      const r = await ctx.addon.createCheckout({ sessionId: session.id, pid: a.plano_pid, cycle: a.ciclo === "anual" ? "annually" : "monthly" });
      await ctx.db.query("INSERT INTO checkout_refs (session_id, checkout_id, pid, cycle) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [session.id, String(r.checkoutId), a.plano_pid, a.ciclo]);
      return ok("CHECKOUT_CRIADO", { url_checkout: r.url, expira_em: r.expiresAt });
    } catch (e) {
      if (e instanceof AddonError && e.status === 422) return erro("PLANO_INVALIDO");
      console.error(JSON.stringify({ msg: "checkout failed", error: e instanceof AddonError ? e.code : "unexpected" }));
      return erro("CHECKOUT_INDISPONIVEL");
    }
  },
);
