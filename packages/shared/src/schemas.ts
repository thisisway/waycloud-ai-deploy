import { z } from "zod";
import { AVISOS } from "./messages.pt-br.js";

export const TIPOS_PROJETO = ["estatico", "spa", "php", "wordpress", "node", "desconhecido"] as const;
export type TipoProjeto = (typeof TIPOS_PROJETO)[number];

export const CICLOS = ["mensal", "anual"] as const;

// ---- shared pieces --------------------------------------------------------------------------
export const sessaoId = z.string().min(20).max(128).regex(/^[A-Za-z0-9_-]+$/);
const caminho = z.string().min(1).max(300);
const isoDate = z.string();

export const manifesto = z
  .object({
    arquivos: z.array(z.object({ caminho, tamanho: z.number().int().min(0) }).strict()).max(10_000),
    package_json: z.string().max(200_000).optional(),
    composer_json: z.string().max(200_000).optional(),
  })
  .strict();
export type Manifesto = z.infer<typeof manifesto>;

const planoResumo = z.object({ pid: z.number().int(), nome: z.string() }).strict();
const aviso = z.object({ codigo: z.enum(Object.keys(AVISOS) as [keyof typeof AVISOS]), mensagem: z.string() }).strict();

// ---- tool inputs (Phase 1) -------------------------------------------------------------------
export const entradas = {
  iniciar_sessao: z.object({}).strict(),
  analisar_projeto: z.object({ sessao_id: sessaoId, manifesto }).strict(),
  listar_planos: z.object({}).strict(),
  obter_url_upload: z.object({ sessao_id: sessaoId, tamanho_bytes: z.number().int().min(1).max(50 * 1024 * 1024) }).strict(),
  enviar_arquivos: z
    .object({
      sessao_id: sessaoId,
      arquivos: z.array(z.object({ caminho, conteudo_base64: z.string().max(7_000_000) }).strict()).min(1).max(200),
    })
    .strict(),
  criar_previa: z.object({ sessao_id: sessaoId, upload_id: z.string().uuid().optional() }).strict(),
  criar_checkout: z.object({ sessao_id: sessaoId, plano_pid: z.number().int(), ciclo: z.enum(CICLOS) }).strict(),
  status_pedido: z.object({ sessao_id: sessaoId }).strict(),
  publicar: z.object({ sessao_id: sessaoId, upload_id: z.string().uuid().optional() }).strict(),
  status_deploy: z.object({ sessao_id: sessaoId, deploy_id: z.string().uuid() }).strict(),
  verificar_site: z.object({ sessao_id: sessaoId }).strict(),
} as const;

// ---- tool outputs: the `dados` field of the envelope -------------------------------------------
export const saidas = {
  iniciar_sessao: z.object({ sessao_id: sessaoId, expira_em: isoDate, fluxo: z.array(z.string()) }).strict(),
  analisar_projeto: z
    .object({
      tipo: z.enum(TIPOS_PROJETO),
      suportado: z.boolean(),
      pasta_publicar: z.string().nullable(),
      versao_php: z.string().nullable(),
      precisa_banco: z.boolean(),
      precisa_email: z.boolean(),
      precisa_variaveis_ambiente: z.boolean(),
      quantidade_arquivos: z.number().int(),
      tamanho_total_bytes: z.number().int(),
      plano_recomendado: planoResumo.nullable(),
      alternativas: z.array(planoResumo),
      avisos: z.array(aviso),
    })
    .strict(),
  listar_planos: z
    .object({
      planos: z.array(
        z
          .object({
            pid: z.number().int(),
            nome: z.string(),
            disco_gb: z.number(),
            dominios: z.number().int(),
            preco_mensal_centavos: z.number().int(),
            preco_anual_centavos: z.number().int(),
            indicado_para: z.string(),
          })
          .strict(),
      ),
    })
    .strict(),
  obter_url_upload: z
    .object({ upload_id: z.string().uuid(), url: z.string(), metodo: z.literal("PUT"), expira_em: isoDate, tamanho_maximo_bytes: z.number().int() })
    .strict(),
  enviar_arquivos: z
    .object({ upload_id: z.string().uuid(), arquivos_recebidos: z.number().int(), tamanho_total_bytes: z.number().int(), avisos: z.array(aviso) })
    .strict(),
  criar_previa: z.object({ url: z.string(), expira_em: isoDate }).strict(),
  criar_checkout: z.object({ url_checkout: z.string(), expira_em: isoDate }).strict(),
  status_pedido: z
    .object({
      status: z.enum(["sem_pedido", "aguardando_pagamento", "pago", "provisionando", "ativo", "falhou"]),
      intervalo_sugerido_segundos: z.number().int(),
    })
    .strict(),
  publicar: z.object({ deploy_id: z.string().uuid() }).strict(),
  status_deploy: z
    .object({ status: z.enum(["na_fila", "enviando", "validando", "publicado", "falhou", "revertido"]), url: z.string().nullable(), https_ativo: z.boolean().nullable(), intervalo_sugerido_segundos: z.number().int() })
    .strict(),
  verificar_site: z
    .object({ http_status: z.number().int(), ssl_ok: z.boolean(), tempo_resposta_ms: z.number().int(), links_quebrados: z.number().int() })
    .strict(),
} as const;

export type ToolName = keyof typeof entradas;
export const TOOL_NAMES = Object.keys(entradas) as ToolName[];
export type Analise = z.infer<(typeof saidas)["analisar_projeto"]>;
export type Aviso = z.infer<typeof aviso>;
