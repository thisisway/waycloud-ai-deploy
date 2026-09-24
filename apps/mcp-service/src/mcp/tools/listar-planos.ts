import { erro, ok } from "@waycloud/shared";
import { PlansUnavailable } from "../../plans.js";
import { defineTool } from "./define.js";

export default defineTool(
  "listar_planos",
  "Use para mostrar ao cliente os planos de hospedagem da Way Cloud com preço (em centavos de real, mensal e anual), disco, domínios e para que tipo de site servem.",
  async (ctx) => {
    try {
      const plans = await ctx.plans();
      return ok("PLANOS_LISTADOS", {
        planos: plans.map((p) => ({
          pid: p.pid,
          nome: p.name,
          disco_gb: p.diskGb,
          dominios: p.domains,
          preco_mensal_centavos: p.monthlyCents,
          preco_anual_centavos: p.annualCents,
          indicado_para: p.blurb,
        })),
      });
    } catch (e) {
      if (e instanceof PlansUnavailable) return erro("PLANOS_INDISPONIVEIS");
      throw e;
    }
  },
);
