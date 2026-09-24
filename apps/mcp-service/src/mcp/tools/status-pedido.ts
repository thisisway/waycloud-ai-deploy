import { erro, ok, type MensagemCodigo } from "@waycloud/shared";
import { findSession } from "../../sessions.js";
import type { OrderStatus } from "../../webhooks.js";
import { defineTool } from "./define.js";

const VIEW: Record<OrderStatus | "none", { status: "sem_pedido" | "aguardando_pagamento" | "pago" | "ativo" | "falhou"; codigo: MensagemCodigo; wait: number }> = {
  none: { status: "sem_pedido", codigo: "SEM_PEDIDO", wait: 0 },
  awaiting_payment: { status: "aguardando_pagamento", codigo: "PEDIDO_AGUARDANDO", wait: 30 },
  paid: { status: "pago", codigo: "PEDIDO_PAGO", wait: 5 },
  active: { status: "ativo", codigo: "PEDIDO_ATIVO", wait: 0 },
  failed: { status: "falhou", codigo: "PEDIDO_FALHOU", wait: 0 },
};

export default defineTool(
  "status_pedido",
  "Use depois de entregar o link de pagamento, para saber em que pé está o pedido: aguardando_pagamento, pago (criando a hospedagem), ativo (pode publicar), falhou ou sem_pedido. A resposta diz de quantos em quantos segundos consultar de novo (0 = não precisa mais). Não consulte mais rápido que isso.",
  async (ctx, a) => {
    const session = await findSession(ctx.db, a.sessao_id);
    if (!session) return erro("SESSAO_INVALIDA");
    const [order] = await ctx.db.query<{ status: OrderStatus }>("SELECT status FROM orders WHERE session_id = $1", [session.id]);
    const v = VIEW[order?.status ?? "none"];
    return ok(v.codigo, { status: v.status, intervalo_sugerido_segundos: v.wait });
  },
);
