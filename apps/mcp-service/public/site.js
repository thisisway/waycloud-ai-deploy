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
const STAGE_OF = { na_fila: 0, enviando: 1, validando: 2, publicado: 3 };
let cycle = "mensal";
let run = 0; // bumped to stop a polling loop that is no longer wanted

const SVG = "http://www.w3.org/2000/svg";
function icon(name) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "ic");
  const use = document.createElementNS(SVG, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}
const text = (tag, content, cls) => {
  const el = document.createElement(tag);
  el.textContent = content;
  if (cls) el.className = cls;
  return el;
};

function view(step, ...ids) {
  for (const id of SECTIONS) $(id).hidden = !ids.includes(id);
  document.querySelectorAll(".stepper li").forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle("done", n < step);
    li.classList.toggle("cur", n === step);
  });
  $("restart").hidden = !state.sessao_id;
}
const showAlert = (msg) => {
  $("alert-text").textContent = msg;
  $("alert").hidden = false;
  $("alert").scrollIntoView({ block: "nearest", behavior: "smooth" });
};
const clearAlert = () => ($("alert").hidden = true);

// ---- 1. upload + preview ------------------------------------------------------------------
async function handleFile(file) {
  clearAlert();
  if (!file) return;
  if (!/\.zip$/i.test(file.name)) return showAlert("Envie o site em um arquivo .zip.");
  if (file.size > MAX_BYTES) return showAlert("O arquivo passou de 50 MB. Envie só a pasta do site, sem node_modules.");
  const status = $("upload-status");
  $("drop").classList.add("busy");
  try {
    status.textContent = "Enviando o seu site...";
    state = await ensureSession(api, store);
    const sent = await sendZip(api, state.sessao_id, new Uint8Array(await file.arrayBuffer()));
    if (!sent.ok) throw new Error(sent.mensagem);
    save({ upload_id: sent.upload_id, deploy_id: null, stage: "upload" });

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
  } finally {
    $("drop").classList.remove("busy");
    $("file").value = ""; // the same file can be chosen again
  }
}

function renderPreview() {
  $("preview-msg").textContent = state.preview_msg ?? "";
  const link = $("preview-link");
  link.hidden = !state.preview_url;
  if (state.preview_url) link.href = state.preview_url;
  $("preview-note").replaceChildren(...(state.preview_url ? [icon("eye"), document.createTextNode("A prévia fica no ar por 24 horas e não aparece no Google.")] : []));
}

// ---- 2. plans + checkout ------------------------------------------------------------------
function planCard(p, best) {
  const monthly = cycle === "mensal";
  const price = monthly ? p.preco_mensal_centavos : p.preco_anual_centavos;
  const card = document.createElement("article");
  card.className = best ? "plan best" : "plan";
  const btn = text("button", "Contratar", `wc-btn ${best ? "btn-primary" : "btn-secondary"}`);
  btn.type = "button";
  btn.addEventListener("click", () => checkout(p.pid, btn));

  const feature = (t) => {
    const li = document.createElement("li");
    li.append(icon("check"), document.createTextNode(t));
    return li;
  };
  const features = document.createElement("ul");
  features.append(feature(`${p.disco_gb} GB de disco`), feature(`${p.dominios} ${p.dominios === 1 ? "domínio" : "domínios"}`), feature("HTTPS incluso"));

  card.append(...(best ? [text("span", "Recomendado", "wc-badge badge-blue")] : []), text("h3", p.nome), text("p", brl(price), "plan-price"), text("p", monthly ? "por mês" : "por ano", "plan-per"));
  const yearFull = p.preco_mensal_centavos * 12;
  if (!monthly && p.preco_anual_centavos < yearFull) {
    card.append(text("p", `${brl(Math.round(p.preco_anual_centavos / 12))} por mês, ${Math.round((1 - p.preco_anual_centavos / yearFull) * 100)}% de economia`, "plan-save"));
  }
  card.append(features, text("p", p.indicado_para, "plan-for"), btn);
  return card;
}

async function showPlans() {
  renderPreview();
  const r = await api.tool("listar_planos");
  if (!r.ok) throw new Error(r.mensagem_para_usuario);
  const fits = (p) => !p.tipos.length || (state.tipo === "php" ? p.tipos.includes("php") : p.tipos.some((t) => t !== "php"));
  const list = r.dados.planos.filter(fits);
  // The plan made for this kind of project (not a generic one) is the recommendation.
  const bestPid = list.find((p) => p.tipos.length)?.pid;
  $("plans").replaceChildren(...list.map((p) => planCard(p, p.pid === bestPid)));
  view(3, "s-preview", "s-plans");
  // The stepper marks "Prévia" as done once the visitor is choosing a plan.
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

function setStage(n) {
  document.querySelectorAll("#timeline li").forEach((li) => {
    const i = Number(li.dataset.stage);
    li.classList.toggle("done", i < n || n === 3);
    li.classList.toggle("cur", i === n && n < 3);
  });
}

async function publish() {
  clearAlert();
  view(4, "s-deploy");
  $("deploy-done").hidden = true;
  setStage(0);
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
    setStage(STAGE_OF[s.dados.status] ?? 0);
    if (s.dados.intervalo_sugerido_segundos === 0) {
      if (s.dados.status !== "publicado") return showAlert(s.mensagem_para_usuario);
      const v = await api.tool("verificar_site", { sessao_id: state.sessao_id });
      save({ stage: "done", site_url: s.dados.url });
      return showDone(v.mensagem_para_usuario);
    }
    await sleep(Math.max(2, s.dados.intervalo_sugerido_segundos) * 1000);
  }
}

function showDone(note) {
  view(5, "s-deploy");
  setStage(3);
  $("deploy-title").textContent = "Seu site está no ar!";
  $("deploy-msg").textContent = "";
  const link = $("site-link");
  link.href = state.site_url;
  link.replaceChildren(document.createTextNode(`Abrir ${state.site_url.replace(/^https?:\/\//, "")}`), icon("external"));
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

document.querySelectorAll(".wc-tab").forEach((b) =>
  b.addEventListener("click", () => {
    cycle = b.dataset.cycle;
    document.querySelectorAll(".wc-tab").forEach((x) => {
      x.classList.toggle("active", x === b);
      x.setAttribute("aria-pressed", String(x === b));
    });
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
    const label = b.querySelector("span");
    try {
      await navigator.clipboard.writeText($(b.dataset.copy).textContent);
      const before = label.textContent;
      label.textContent = "Copiado!";
      setTimeout(() => (label.textContent = before), 2000);
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
