import { TOOL_NAMES } from "@waycloud/shared";
import analisarProjeto from "./analisar-projeto.js";
import criarCheckout from "./criar-checkout.js";
import criarPrevia from "./criar-previa.js";
import enviarArquivos from "./enviar-arquivos.js";
import type { ToolDef } from "./define.js";
import iniciarSessao from "./iniciar-sessao.js";
import listarPlanos from "./listar-planos.js";
import obterUrlUpload from "./obter-url-upload.js";
import pending from "./pending.js";
import statusPedido from "./status-pedido.js";

export const TOOLS: ToolDef[] = [iniciarSessao, analisarProjeto, listarPlanos, obterUrlUpload, enviarArquivos, criarPrevia, criarCheckout, statusPedido, ...pending];

// Fails at import time if a tool from the shared schemas has no implementation (or vice versa).
const missing = TOOL_NAMES.filter((n) => !TOOLS.some((t) => t.name === n));
if (missing.length || TOOLS.length !== TOOL_NAMES.length) throw new Error(`Tool registry out of sync: ${missing.join(", ")}`);
