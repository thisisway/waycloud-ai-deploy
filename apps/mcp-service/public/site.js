import { Api, brl, ensureSession, sendZip } from "./flow.js";

const $ = (id) => document.getElementById(id);
const api = new Api("");
const KEY = "waycloud_web";
const store = {
  get: () => {
    try {
      return JSON.parse(localStorage.getItem(KEY));
    } catch {
      return null;
    }
  },
  set: (v) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(v));
    } catch {
      /* private mode: the page still works, it just cannot resume after a reload */
    }
  },
};
let state = store.get() ?? {};
const save = (patch) => {
  state = { ...state, ...patch };
  store.set(state);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_BYTES = 50 * 1024 * 1024;
const SECTIONS = ["s-upload", "s-preview", "s-plans", "s-wait", "s-deploy"];
let cycle = "mensal";
let run = 0; // bumped to stop a polling loop that is no longer wanted

function view(step, ...ids) {
  for (const id of SECTIONS) $(id).hidden = !ids.includes(id);
  document.querySelectorAll(".steps li").forEach((li) => li.classList.toggle("on", Number(li.dataset.step) <= step));
  $("restart").hidden = !state.sessao_id;
}
const showAlert = (msg) => {
  $("alert").textContent = msg;
  $("alert").hidden = false;
};
const clearAlert = () => ($("alert").hidden = true);
const text = (tag, content, cls) => {
  const el = document.createElement(tag);
  el.textContent = content;
  if (cls) el.className = cls;
  return el;
};

// ---- 1. upload + preview ------------------------------------------------------------------
async function handleFile(file) {
  clearAlert();
  if (!file) return;
  if (!/\.zip$/i.test(file.name)) return showAlert("Envie o site em um arquivo .zip.");
  if (file.size > MAX_BYTES) return showAlert("O arquivo passou de 50 MB. Envie só a pasta do site, sem node_modules.");
  const status = $("upload-status");
  try {
    status.textContent = "Enviando o seu site...";
    state = await ensureSession(api, store);
    const sent = await sendZip(api, state.sessao_id, new Uint8Array(await file.arrayBuffer()));
    if (!sent.ok) throw new Error(sent.mensagem);
    save({ upload_id: sent.upload_id });

    status.textContent = "Criando a prévia...";
    const pv = await api.tool("criar_previa", { sessao_id: state.sessao_id, upload_id: sent.upload_id });
    if (pv.ok) save({ stage: "plans", tipo: "web", preview_url: pv.dados.url, preview_msg: pv.mensagem_para_usuario });
    else if (pv.codigo === "PREVIA_INDISPONIVEL_PHP") save({ stage: "plans", tipo: "php", preview_url: null, preview_msg: pv.mensagem_para_usuario });
    else throw new Error(pv.mensagem_para_usuario);
    status.textContent = "";
    await showPlans();
  } catch (e) {
    status.textContent = "";
    showAlert(e instanceof Error ? e.message : "Algo deu errado. Tente de novo.");
  }
}

function renderPreview() {
  $("preview-msg").textContent = state.preview_msg ?? "";
  const link = $("preview-link");
  link.hidden = !state.preview_url;
  if (state.preview_url) link.href = state.preview_url;
  $("preview-note").textContent = state.preview_url ? "A prévia fica no ar por 24 horas e não aparece no Google." : "";
}

// ---- 2. plans + checkout ------------------------------------------------------------------
async function showPlans() {
  renderPreview();
  const r = await api.tool("listar_planos");
  if (!r.ok) throw new Error(r.mensagem_para_usuario);
  const fits = (p) => !p.tipos.length || (state.tipo === "php" ? p.tipos.includes("php") : p.tipos.some((t) => t !== "php"));
  const list = $("plans");
  list.replaceChildren(
    ...r.dados.planos.filter(fits).map((p) => {
      const card = document.createElement("article");
      card.className = "plan";
      const monthly = cycle === "mensal";
      const price = monthly ? p.preco_mensal_centavos : p.preco_anual_centavos;
      const btn = text("button", "Contratar", "btn");
      btn.type = "button";
      btn.addEventListener("click", () => checkout(p.pid, btn));
      card.append(text("h3", p.nome), text("p", brl(price), "price"), text("p", monthly ? "por mês" : "por ano", "muted"), text("p", `${p.disco_gb} GB de disco · ${p.dominios} domínio(s)`), text("p", p.indicado_para, "muted"), btn);
      return card;
    }),
  );
  view(3, "s-preview", "s-plans");
}

async function checkout(pid, btn) {
  clearAlert();
  btn.disabled = true;
  try {
    const r = await api.tool("criar_checkout", { sessao_id: state.sessao_id, plano_pid: pid, ciclo: cycle });
    if (!r.ok) throw new Error(r.mensagem_para_usuario);
    save({ stage: "waiting", checkout_url: r.dados.url_checkout });
    window.open(r.dados.url_checkout, "_blank", "noopener");
    showWaiting();
  } catch (e) {
    showAlert(e instanceof Error ? e.message : "Não consegui gerar o link de pagamento.");
  } finally {
    btn.disabled = false;
  }
}

// ---- 3. payment -> publish ----------------------------------------------------------------
function showWaiting() {
  $("checkout-link").href = state.checkout_url;
  view(3, "s-wait");
  void waitPayment();
}

async function waitPayment() {
  const me = ++run;
  const first = $("wait-msg").textContent;
  while (me === run) {
    let r;
    try {
      r = await api.tool("status_pedido", { sessao_id: state.sessao_id });
    } catch {
      await sleep(5000); // a network blip: try again
      continue;
    }
    const st = r.dados?.status;
    if (st === "ativo") return void publish();
    if (st === "falhou" || !r.ok) return showAlert(r.mensagem_para_usuario);
    $("wait-msg").textContent = st === "sem_pedido" ? first : r.mensagem_para_usuario;
    await sleep(Math.max(3, r.dados?.intervalo_sugerido_segundos ?? 5) * 1000);
  }
}

async function publish() {
  clearAlert();
  view(4, "s-deploy");
  $("deploy-msg").textContent = "Publicando o seu site...";
  try {
    if (!state.deploy_id) {
      const r = await api.tool("publicar", { sessao_id: state.sessao_id, upload_id: state.upload_id });
      if (!r.ok) throw new Error(r.mensagem_para_usuario);
      save({ stage: "deploy", deploy_id: r.dados.deploy_id });
    }
    await follow();
  } catch (e) {
    showAlert(e instanceof Error ? e.message : "Não consegui publicar agora.");
  }
}

async function follow() {
  const me = ++run;
  while (me === run) {
    const s = await api.tool("status_deploy", { sessao_id: state.sessao_id, deploy_id: state.deploy_id });
    if (!s.ok) return showAlert(s.mensagem_para_usuario);
    $("deploy-msg").textContent = s.mensagem_para_usuario;
    if (s.dados.intervalo_sugerido_segundos === 0) {
      $("deploy-bar").hidden = true;
      if (s.dados.status !== "publicado") return showAlert(s.mensagem_para_usuario);
      const v = await api.tool("verificar_site", { sessao_id: state.sessao_id });
      save({ stage: "done", site_url: s.dados.url });
      return showDone(v.mensagem_para_usuario);
    }
    await sleep(Math.max(2, s.dados.intervalo_sugerido_segundos) * 1000);
  }
}

function showDone(note) {
  view(4, "s-deploy");
  $("deploy-bar").hidden = true;
  const link = $("site-link");
  link.href = state.site_url;
  link.textContent = `Abrir ${state.site_url.replace(/^https?:\/\//, "")}`;
  $("deploy-done").hidden = false;
  $("deploy-note").textContent = note ?? "";
}

// ---- wiring -------------------------------------------------------------------------------
const drop = $("drop");
const input = $("file");
input.addEventListener("change", () => handleFile(input.files[0]));
drop.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), input.click()));
for (const ev of ["dragenter", "dragover"]) drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.add("over")));
for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => (e.preventDefault(), handleFile(e.dataTransfer?.files?.[0])));

document.querySelectorAll(".cycle button").forEach((b) =>
  b.addEventListener("click", () => {
    cycle = b.dataset.cycle;
    document.querySelectorAll(".cycle button").forEach((x) => x.classList.toggle("on", x === b));
    void showPlans().catch((e) => showAlert(e.message));
  }),
);
$("restart").addEventListener("click", () => {
  run++;
  store.set({});
  location.reload();
});
document.querySelectorAll("[data-copy]").forEach((b) =>
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($(b.dataset.copy).textContent);
      const label = b.textContent;
      b.textContent = "Copiado!";
      setTimeout(() => (b.textContent = label), 2000);
    } catch {
      showAlert("Não consegui copiar. Selecione o texto e copie manualmente.");
    }
  }),
);

$("mcp-url").textContent = `${location.origin}/mcp`;
$("cli-prompt").textContent = `Publique este site na Way Cloud. Leia ${location.origin}/llms.txt e siga as instruções.`;

// Resume where the visitor left off (for instance after paying in the other tab).
try {
  if (state.stage === "plans") await showPlans();
  else if (state.stage === "waiting" && state.checkout_url) showWaiting();
  else if (state.stage === "deploy" && state.deploy_id) (view(4, "s-deploy"), void follow());
  else if (state.stage === "done" && state.site_url) showDone();
  else view(1, "s-upload");
} catch (e) {
  view(1, "s-upload");
  showAlert(e instanceof Error ? e.message : "Algo deu errado.");
}
