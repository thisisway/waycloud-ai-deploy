import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { packProject, PackError } from "./pack.mjs";

// Production endpoint of the MCP service; override with WAYCLOUD_URL (e.g. for a local stack).
const DEFAULT_URL = "https://web-way-waycloud-ai-mcp.fzd763.easypanel.host/mcp";

const HELP = `Way Cloud - publique seu site direto do terminal

Uso: waycloud <comando> [pasta] [opções]

Comandos:
  deploy [pasta]     Compacta o projeto, cria uma prévia grátis e, com plano ativo, publica o site
  plans              Lista os planos e preços
  checkout           Gera o link de pagamento (--plano <pid> [--ciclo mensal|anual])
  status             Mostra o pedido, o último deploy e verifica o site
  logs, rollback     Chegam na próxima fase

Respeita .gitignore e .waycloudignore (mesma sintaxe) e nunca envia .env, .git nem node_modules.
Variável opcional: WAYCLOUD_URL (endereço do serviço MCP).`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const brl = (centavos) => (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export class Api {
  constructor(url, fetchFn = fetch) {
    this.url = url;
    this.fetch = fetchFn;
    this.id = 0;
  }

  /** Calls an MCP tool over stateless Streamable HTTP and returns the Way Cloud envelope. */
  async tool(name, args = {}) {
    const res = await this.fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method: "tools/call", params: { name, arguments: args } }),
    });
    const raw = await res.text();
    // The answer is a JSON body or a single SSE event, depending on the server.
    const json = raw.trimStart().startsWith("{") ? raw : raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop();
    const env = json ? JSON.parse(json)?.result?.structuredContent : undefined;
    if (!env) throw new Error(`resposta inesperada do serviço (HTTP ${res.status})`);
    return env;
  }
}

const stateFile = (dir) => join(dir, ".waycloud", "session.json");
const loadState = (dir) => {
  try {
    return JSON.parse(readFileSync(stateFile(dir), "utf8"));
  } catch {
    return {};
  }
};
const saveState = (dir, state) => {
  mkdirSync(join(dir, ".waycloud"), { recursive: true });
  writeFileSync(stateFile(dir), JSON.stringify(state, null, 2));
};

// The session id lives in <project>/.waycloud/session.json so that deploy, checkout and status share one order.
async function ensureSession(api, dir) {
  const state = loadState(dir);
  if (state.sessao_id && state.expira_em && Date.parse(state.expira_em) > Date.now() + 60_000) return state;
  const r = await api.tool("iniciar_sessao");
  if (!r.ok) throw new Error(r.mensagem_para_usuario);
  const next = { sessao_id: r.dados.sessao_id, expira_em: r.dados.expira_em };
  saveState(dir, next);
  return next;
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) opts[argv[i].slice(2)] = argv[++i] ?? "";
    else opts._.push(argv[i]);
  }
  return opts;
}

const fail = (out, env) => {
  out.error(env.mensagem_para_usuario);
  return 1;
};

/** Polls status_deploy until it settles, then checks the live site. */
async function follow(api, sessao_id, deploy_id, out, sleepFn) {
  let last = "";
  for (let i = 0; i < 120; i++) {
    const s = await api.tool("status_deploy", { sessao_id, deploy_id });
    if (!s.ok) return fail(out, s);
    if (s.mensagem_para_usuario !== last) out.log(s.mensagem_para_usuario);
    last = s.mensagem_para_usuario;
    if (s.dados.intervalo_sugerido_segundos === 0) {
      if (s.dados.status !== "publicado") return 1;
      const v = await api.tool("verificar_site", { sessao_id });
      out.log(v.mensagem_para_usuario);
      return v.ok ? 0 : 1;
    }
    await sleepFn(Math.max(2, s.dados.intervalo_sugerido_segundos) * 1000);
  }
  out.error("O deploy está demorando mais que o normal. Rode waycloud status daqui a pouco.");
  return 1;
}

const COMMANDS = {
  async plans({ api, out }) {
    const r = await api.tool("listar_planos");
    if (!r.ok) return fail(out, r);
    for (const p of r.dados.planos) out.log(`  ${String(p.pid).padStart(4)}  ${p.nome} - ${p.disco_gb} GB, ${p.dominios} domínio(s) - ${brl(p.preco_mensal_centavos)}/mês ou ${brl(p.preco_anual_centavos)}/ano. ${p.indicado_para}`);
    return 0;
  },

  async checkout({ api, dir, opts, out }) {
    const pid = Number(opts.plano);
    if (!Number.isInteger(pid) || pid <= 0) {
      out.error("Informe o plano: waycloud checkout --plano <pid> (veja os pids com: waycloud plans).");
      return 2;
    }
    const state = await ensureSession(api, dir);
    const r = await api.tool("criar_checkout", { sessao_id: state.sessao_id, plano_pid: pid, ciclo: opts.ciclo || "mensal" });
    if (!r.ok) return fail(out, r);
    out.log(r.mensagem_para_usuario);
    out.log(`\nAbra para concluir o cadastro e o pagamento (Pix ou cartão):\n${r.dados.url_checkout}\n\nDepois do pagamento, rode: waycloud deploy`);
    return 0;
  },

  async deploy({ api, dir, out, sleepFn }) {
    let packed;
    try {
      packed = packProject(dir);
    } catch (e) {
      if (!(e instanceof PackError)) throw e;
      out.error(e.message);
      return 1;
    }
    out.log(`Compactado: ${packed.count} arquivos, ${(packed.zip.length / 1024).toFixed(0)} KB.`);

    const state = await ensureSession(api, dir);
    const up = await api.tool("obter_url_upload", { sessao_id: state.sessao_id, tamanho_bytes: packed.zip.length });
    if (!up.ok) return fail(out, up);
    const put = await api.fetch(up.dados.url, { method: "PUT", body: packed.zip });
    if (!put.ok) {
      out.error(`O envio do pacote falhou (HTTP ${put.status}). Tente de novo.`);
      return 1;
    }
    out.log("Pacote enviado.");

    const pv = await api.tool("criar_previa", { sessao_id: state.sessao_id, upload_id: up.dados.upload_id });
    out.log(pv.ok ? `Prévia grátis (temporária): ${pv.dados.url}` : pv.mensagem_para_usuario);

    const ped = await api.tool("status_pedido", { sessao_id: state.sessao_id });
    if (ped.dados?.status !== "ativo") {
      out.log(`\n${ped.mensagem_para_usuario}\nPara publicar de vez: waycloud plans, depois waycloud checkout --plano <pid>. Quando pagar, rode waycloud deploy de novo.`);
      return pv.ok || pv.codigo === "PREVIA_INDISPONIVEL_PHP" ? 0 : 1;
    }

    const pub = await api.tool("publicar", { sessao_id: state.sessao_id, upload_id: up.dados.upload_id });
    if (!pub.ok) return fail(out, pub);
    saveState(dir, { ...state, deploy_id: pub.dados.deploy_id });
    out.log(pub.mensagem_para_usuario);
    return follow(api, state.sessao_id, pub.dados.deploy_id, out, sleepFn);
  },

  async status({ api, dir, out, sleepFn }) {
    const state = loadState(dir);
    if (!state.sessao_id) {
      out.error("Nenhum deploy por aqui ainda. Rode: waycloud deploy");
      return 1;
    }
    const ped = await api.tool("status_pedido", { sessao_id: state.sessao_id });
    out.log(ped.mensagem_para_usuario);
    return state.deploy_id ? follow(api, state.sessao_id, state.deploy_id, out, sleepFn) : 0;
  },

  async logs({ out }) {
    out.error("waycloud logs chega na próxima fase.");
    return 2;
  },

  async rollback({ out }) {
    out.error("waycloud rollback chega na próxima fase. Enquanto isso, um deploy que falha volta sozinho para a versão anterior.");
    return 2;
  },
};

/** Entry point; returns the process exit code. `env`, `out` and the transport are injectable for tests. */
export async function main(argv, env = process.env, out = console, { fetchFn = fetch, sleepFn = sleep } = {}) {
  const opts = parseArgs(argv);
  const name = opts._.shift();
  if (!name || name === "help" || opts.help !== undefined || !Object.hasOwn(COMMANDS, name)) {
    out.log(HELP);
    return name && name !== "help" && !Object.hasOwn(COMMANDS, name) ? 2 : 0;
  }
  const dir = resolve(opts._[0] ?? ".");
  try {
    return await COMMANDS[name]({ api: new Api(env.WAYCLOUD_URL || DEFAULT_URL, fetchFn), dir, opts, out, sleepFn });
  } catch (e) {
    out.error(`Não consegui falar com a Way Cloud: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
}
