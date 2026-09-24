import { z } from "zod";
import { MENSAGENS, type MensagemCodigo } from "./messages.pt-br.js";

// Every tool answers with this envelope: a fixed message for the user and a hint for the AI.
export interface Envelope<T = unknown> {
  ok: boolean;
  codigo: string;
  mensagem_para_usuario: string;
  proximo_passo: string;
  dados?: T;
}

export const envelopeSchema = <D extends z.ZodTypeAny>(dados: D) =>
  z.object({ ok: z.boolean(), codigo: z.string(), mensagem_para_usuario: z.string(), proximo_passo: z.string(), dados: dados.optional() }).strict();

export function ok<T>(codigo: MensagemCodigo, dados: T): Envelope<T> {
  const m = MENSAGENS[codigo];
  return { ok: true, codigo, mensagem_para_usuario: m.mensagem, proximo_passo: m.proximo, dados };
}

export function erro(codigo: MensagemCodigo): Envelope<never> {
  const m = MENSAGENS[codigo];
  return { ok: false, codigo, mensagem_para_usuario: m.mensagem, proximo_passo: m.proximo };
}
