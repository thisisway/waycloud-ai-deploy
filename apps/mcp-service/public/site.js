import { Api, brl, checkForm, ensureSession, maskDoc, maskPhone, postJson, sendZip, signup } from "./flow.js";
import { startRibbons } from "./ribbons.js";

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
const MAX_BYTES = 100 * 1024 * 1024; // keep in sync with MAX_WEB_ZIP_BYTES in web.ts
const SECTIONS = ["s-upload", "s-preview", "s-plans", "s-signup", "s-wait", "s-deploy", "s-domain"];
const STEP_NAMES = ["Enviar", "Prévia", "Contratar", "No ar", "Domínio"];
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
  $("prog-label").textContent = step > 5 ? "Tudo pronto" : `Etapa ${step} de 5 · ${STEP_NAMES[step - 1]}`;
  document.querySelectorAll(".segs i").forEach((bar, i) => bar.classList.toggle("on", i < step));
  $("restart").hidden = !state.sessao_id;
}
const showAlert = (msg) => {
  $("alert-text").textContent = msg;
  $("alert").hidden = false;
  $("alert").scrollIntoView({ block: "nearest", behavior: "smooth" });
};
const clearAlert = () => ($("alert").hidden = true);

// ---- 1. upload + preview ------------------------------------------------------------------
const fmtSize = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
function fileState(kind, label) {
  const el = $("file-state");
  el.className = `fstate ${kind}`;
  el.textContent = label;
}

async function handleFile(file) {
  clearAlert();
  if (!file) return;
  if (!/\.zip$/i.test(file.name)) return showAlert("Envie o site em um arquivo .zip.");
  if (file.size > MAX_BYTES) return showAlert("O arquivo passou de 100 MB. Envie só a pasta do site, sem node_modules.");
  const status = $("upload-status");
  $("drop").classList.add("busy");
  $("file-name").textContent = file.name;
  $("file-size").textContent = fmtSize(file.size);
  $("files").hidden = false;
  fileState("load", "Enviando");
  try {
    status.textContent = "Enviando o seu site...";
    state = await ensureSession(api, store);
    const sent = await sendZip(api, state.sessao_id, new Uint8Array(await file.arrayBuffer()));
    if (!sent.ok) throw new Error(sent.mensagem);
    fileState("ok", "Enviado");
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
    fileState("err", "Falhou");
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
  if (state.preview_url) {
    link.href = state.preview_url;
    link.replaceChildren(document.createTextNode(state.preview_url.replace(/^https?:\/\//, "")), icon("external"));
  }
  $("preview-note").textContent = state.preview_url ? "Fica no ar por 24 horas e não aparece no Google." : "";
}

// ---- 2. plans + checkout ------------------------------------------------------------------
function planCard(p, best) {
  const monthly = cycle === "mensal";
  const price = monthly ? p.preco_mensal_centavos : p.preco_anual_centavos;
  const card = document.createElement("article");
  card.className = best ? "plan best" : "plan";

  const info = document.createElement("div");
  if (best) info.append(text("p", "Indicado para o seu site", "plan-fit"));
  const domains = `${p.dominios} ${p.dominios === 1 ? "domínio" : "domínios"}`;
  info.append(text("h3", p.nome), text("p", `${p.disco_gb} GB de disco · ${domains} · HTTPS incluso`, "plan-specs"), text("p", p.indicado_para, "plan-for"));

  const buy = document.createElement("div");
  buy.className = "plan-buy";
  const priceEl = text("p", brl(price), "plan-price");
  priceEl.append(text("small", monthly ? " /mês" : " /ano"));
  buy.append(priceEl);
  const yearFull = p.preco_mensal_centavos * 12;
  if (!monthly && p.preco_anual_centavos < yearFull) {
    buy.append(text("p", `${brl(Math.round(p.preco_anual_centavos / 12))} por mês, ${Math.round((1 - p.preco_anual_centavos / yearFull) * 100)}% menos`, "plan-save"));
  }
  const btn = text("button", "Contratar", best ? "btn" : "btn line");
  btn.type = "button";
  btn.addEventListener("click", () => openSignup(p));
  buy.append(btn);

  card.append(info, buy);
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

// ---- 2b. sign-up (the customer's data goes to /web/checkout; nothing personal is kept in the browser) -----------------
let chosen = null;
const FIELD_OF = { nome: "nome", email: "email", doc_numero: "doc", telefone: "tel", aceite: "aceite", _form: "form" };
const showFieldError = (key, msg) => {
  const p = $(`e-${key}`);
  p.textContent = msg ?? "";
  p.hidden = !msg;
  const input = { nome: "f-nome", email: "f-email", doc: "f-doc", tel: "f-tel", aceite: "f-aceite" }[key];
  if (input) $(input).setAttribute("aria-invalid", msg ? "true" : "false");
};
const clearFieldErrors = () => Object.values(FIELD_OF).forEach((k) => showFieldError(k, ""));

function openSignup(plan) {
  clearAlert();
  clearFieldErrors();
  $("signup-fallback").hidden = true;
  const monthly = cycle === "mensal";
  chosen = { pid: plan.pid };
  $("signup-plan").textContent = `${plan.nome} · ${brl(monthly ? plan.preco_mensal_centavos : plan.preco_anual_centavos)} ${monthly ? "por mês" : "por ano"}`;
  view(3, "s-preview", "s-signup");
  $("f-nome").focus();
}

async function submitSignup(event) {
  event.preventDefault();
  clearAlert();
  clearFieldErrors();
  $("signup-fallback").hidden = true;
  const f = $("signup");
  const values = { nome: f.nome.value, email: f.email.value, doc_tipo: f.doc_tipo.value, doc_numero: f.doc_numero.value, telefone: f.telefone.value, aceite: f.aceite.checked };
  const local = checkForm(values);
  if (Object.keys(local).length) {
    for (const [k, msg] of Object.entries(local)) showFieldError(FIELD_OF[k], msg);
    const first = ["nome", "email", "doc_numero", "telefone", "aceite"].find((k) => local[k]);
    $({ nome: "f-nome", email: "f-email", doc_numero: "f-doc", telefone: "f-tel", aceite: "f-aceite" }[first]).focus();
    return;
  }
  const button = $("signup-submit");
  button.disabled = true;
  button.textContent = "Enviando...";
  const r = await signup(api, { sessao_id: state.sessao_id, plano_pid: chosen.pid, ciclo: cycle, ...values, nome: values.nome.trim(), email: values.email.trim(), website: f.website.value });
  if (r.ok) {
    save({ stage: "waiting", checkout_url: r.redirect });
    location.assign(r.redirect); // the payment page; the visitor comes back here and this page carries on by itself
    return;
  }
  button.disabled = false;
  button.textContent = "Continuar para o pagamento";
  for (const [k, msg] of Object.entries(r.errors)) if (FIELD_OF[k]) showFieldError(FIELD_OF[k], msg);
  if (r.fallbackUrl) {
    $("fallback-link").href = r.fallbackUrl;
    $("signup-fallback").hidden = false;
  }
  if (r.status === 429) showAlert("Muitas tentativas. Aguarde alguns minutos e tente de novo.");
  else if (r.status === 401) showAlert("A sua sessão expirou. Clique em \"Começar de novo\" e envie o arquivo outra vez.");
  else if (!Object.keys(r.errors).length) showAlert(r.mensagem ?? "Não consegui concluir o cadastro agora. Tente de novo em instantes.");
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
  $("timeline").hidden = false;
  $("next-domain").hidden = true;
  $("deploy-title").textContent = "Publicando o seu site";
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
      const secure = s.dados.https_ativo === true;
      // Without the certificate yet the site is up over HTTP: no point running the check that would flag the missing padlock.
      const v = secure ? await api.tool("verificar_site", { sessao_id: state.sessao_id }) : null;
      save({ stage: "done", site_url: s.dados.url, https: secure });
      showDone(v?.mensagem_para_usuario);
      return secure ? undefined : waitHttps();
    }
    await sleep(Math.max(2, s.dados.intervalo_sugerido_segundos) * 1000);
  }
}

const HTTPS_PENDING_NOTE = "Estamos ativando o HTTPS do seu site. Em alguns minutos o endereço passa a abrir com cadeado, e esta página avisa quando estiver pronto.";

/** The certificate can take a few minutes after the site is live: keep checking, for up to 30 minutes. */
async function waitHttps() {
  const me = ++run;
  for (let i = 0; i < 60 && me === run; i++) {
    await sleep(30_000);
    let s;
    try {
      s = await api.tool("status_deploy", { sessao_id: state.sessao_id, deploy_id: state.deploy_id });
    } catch {
      continue; // a network blip
    }
    if (s.ok && s.dados?.https_ativo === true) {
      const v = await api.tool("verificar_site", { sessao_id: state.sessao_id });
      save({ site_url: s.dados.url, https: true });
      return showDone(v.mensagem_para_usuario);
    }
  }
  $("deploy-note").textContent = "O HTTPS está demorando mais que o normal. O seu site já abre; se o cadeado não aparecer em algumas horas, fale com a gente pelo chat.";
}

function showDone(note) {
  view(4, "s-deploy");
  $("timeline").hidden = true; // the checklist is for while it is publishing; afterwards only the result matters
  $("deploy-title").textContent = "Seu site está no ar!";
  $("site-link").className = "btn big";
  $("deploy-msg").textContent = "";
  const link = $("site-link");
  link.href = state.site_url;
  link.replaceChildren(document.createTextNode(`Abrir ${state.site_url.replace(/^https?:\/\//, "")}`), icon("external"));
  $("deploy-done").hidden = false;
  $("deploy-note").textContent = state.https === false ? HTTPS_PENDING_NOTE : (note ?? "");
  showNextDomain();
  void domainStatus(true); // an earlier request (or one in progress) opens the domain step right away
}

// ---- 5. the domain step --------------------------------------------------------------------------------------------
let domainRun = 0;
let inspection = null; // what the DNS looked like when the customer typed the domain (drives the recommendation)
const PANES = ["dp-choose", "dp-enter", "dp-wait", "dp-done"];
const pane = (id) => PANES.forEach((p) => ($(p).hidden = p !== id));

function showNextDomain() {
  const later = state.domain_later === true;
  $("next-domain").hidden = false;
  $("next-domain").classList.toggle("compact", later);
  $("domain-resume").hidden = !later;
}

function openDomainStep(start = "dp-choose") {
  clearAlert();
  view(5, "s-domain");
  $("domain-site").href = state.site_url ?? "#";
  pane(start);
  if (start === "dp-enter") $("f-dominio").focus();
}

function copyButton(value) {
  const copy = text("button", "Copiar", "text-btn");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(value);
      copy.textContent = "Copiado!";
      setTimeout(() => (copy.textContent = "Copiar"), 2000);
    } catch {
      showAlert("Não consegui copiar. Selecione o valor e copie manualmente.");
    }
  });
  return copy;
}

function dnsRow(tipo, nome, valor, extra) {
  const row = document.createElement("div");
  row.className = "dns-row";
  const value = document.createElement("div");
  value.className = "val";
  value.append(...(nome ? [text("small", `Nome: ${nome}`)] : []), text("code", valor), ...(extra ? [text("small", extra)] : []));
  row.append(text("b", tipo), value, copyButton(valor));
  return row;
}

const step = (t) => text("li", t);
const rowsBox = (rows) => {
  const box = document.createElement("div");
  box.className = "dns";
  box.append(...rows);
  return box;
};

/** Only the chosen way is shown, as numbered steps. */
function renderInstructions(d) {
  const box = $("dp-instr");
  if (d.metodo === "ns") {
    const list = document.createElement("ol");
    list.append(step("Entre no painel de onde o domínio está registrado (Registro.br, GoDaddy, Hostinger...)."), step("Procure a opção de servidores DNS (nameservers)."));
    const third = step("Troque os nameservers atuais por estes dois:");
    third.append(rowsBox(d.dns.nameservers.map((ns, i) => dnsRow(`NS ${i + 1}`, null, ns))));
    list.append(third, step("Salve. A propagação pode levar de alguns minutos a algumas horas."));
    box.replaceChildren(text("h4", "Aponte os nameservers para a Way Cloud"), list, text("p", "Atenção: isso leva o DNS inteiro do domínio para a Way Cloud, inclusive o e-mail.", "warn"));
  } else {
    const [a, cname] = d.dns.registros;
    const list = document.createElement("ol");
    list.append(step("Entre no painel do seu DNS (Cloudflare, Registro.br, GoDaddy...)."));
    const second = step("Crie estes dois registros:");
    second.append(rowsBox([dnsRow(a.tipo, a.nome, a.valor, a.alternativa), dnsRow(cname.tipo, cname.nome, cname.valor)]));
    list.append(second, step("No Cloudflare, deixe a nuvem cinza (só DNS), senão o certificado não sai."), step("Salve. A propagação pode levar de alguns minutos a algumas horas."));
    box.replaceChildren(text("h4", "Crie os registros no seu DNS"), list);
  }
  $("dp-switch").textContent = d.metodo === "ns" ? "Prefiro criar registros no meu DNS" : "Prefiro apontar os nameservers para a Way Cloud";
  $("dp-switch").dataset.to = d.metodo === "ns" ? "records" : "ns";
}

function setDomainStage(n) {
  document.querySelectorAll("#dp-stages li").forEach((li) => {
    const i = Number(li.dataset.stage);
    li.classList.toggle("done", i < n || n === 3);
    li.classList.toggle("cur", i === n && n < 3);
  });
}

/** Renders what the service says about the request. Returns true when nothing is left to wait for. */
function applyDomain(d) {
  if (d.status === "cancelled" || d.status === "none") return true;
  openDomainStep("dp-wait");
  $("dp-domain").textContent = d.dominio;
  $("dp-status").textContent = d.mensagem ?? "";
  $("domain-cancel").hidden = d.status !== "waiting_dns";
  const waiting = d.status === "waiting_dns" && d.dns;
  $("dp-instr").hidden = !waiting;
  $("dp-switch").hidden = !waiting;
  $("dp-reco").hidden = !(waiting && inspection && inspection.recomendado === d.metodo);
  if (!$("dp-reco").hidden) $("dp-reco").textContent = `Recomendado para o seu domínio: ${inspection.motivo}`;
  if (waiting) renderInstructions(d);
  setDomainStage({ waiting_dns: 0, ready: 1, switching: 1, active: d.https ? 3 : 2 }[d.status] ?? 0);
  if (d.status === "active") {
    save({ site_url: `${d.https ? "https" : "http"}://${d.dominio}`, https: d.https });
    if (d.https) {
      pane("dp-done");
      view(6, "s-domain");
      $("dp-done-msg").textContent = "O seu domínio agora é o endereço principal do site. O endereço provisório deixou de funcionar.";
      $("dp-link").href = state.site_url;
      $("dp-link").replaceChildren(document.createTextNode(`Abrir ${d.dominio}`), icon("external"));
      $("site-link").href = state.site_url;
      return true;
    }
    $("dp-status").textContent = `${d.mensagem} Estamos ativando o HTTPS: em alguns minutos o endereço abre com cadeado.`;
  }
  return ["failed", "expired"].includes(d.status);
}

/** Looks at the service until the domain is done (or there is nothing to follow). `first`: only open the step if a request exists. */
async function domainStatus(first = false) {
  const me = ++domainRun;
  for (let i = 0; i < 240 && me === domainRun; i++) {
    const { status, body } = await postJson(api, "/web/domain/status", { sessao_id: state.sessao_id });
    if (status === 200 && body.status && body.status !== "none") {
      if (applyDomain(body)) return;
    } else if (first || body.status === "none") {
      return; // no request: the site screen with its next step stays
    }
    await sleep(body.status === "waiting_dns" ? 15_000 : 5_000);
  }
}

async function requestDomain(dominio, metodo) {
  const { status, body } = await postJson(api, "/web/domain", { sessao_id: state.sessao_id, dominio, metodo });
  if (status === 200 && body.ok) return body;
  throw new Error(body.mensagem ?? body.mensagem_para_usuario ?? (status === 429 ? "Muitas tentativas. Aguarde alguns minutos." : "Não consegui conectar o domínio agora. Tente de novo em instantes."));
}

async function submitDomain(event) {
  event.preventDefault();
  clearAlert();
  const err = $("e-dominio");
  err.hidden = true;
  $("f-dominio").removeAttribute("aria-invalid");
  const button = $("domain-submit");
  button.disabled = true;
  button.textContent = "Conferindo...";
  try {
    const seen = await postJson(api, "/web/domain/inspect", { sessao_id: state.sessao_id, dominio: $("f-dominio").value });
    if (seen.status !== 200 || !seen.body.ok) throw new Error(seen.body.mensagem ?? seen.body.mensagem_para_usuario ?? "Não consegui olhar esse domínio agora. Tente de novo.");
    inspection = seen.body;
    const asked = await requestDomain(seen.body.dominio, seen.body.recomendado);
    applyDomain(asked);
    void domainStatus();
  } catch (e) {
    err.textContent = e instanceof Error ? e.message : "Algo deu errado. Tente de novo.";
    err.hidden = false;
    $("f-dominio").setAttribute("aria-invalid", "true");
  } finally {
    button.disabled = false;
    button.textContent = "Continuar";
  }
}

async function switchMethod() {
  const to = $("dp-switch").dataset.to;
  const dominio = $("dp-domain").textContent;
  try {
    inspection = inspection ? { ...inspection, recomendado: inspection.recomendado } : null;
    applyDomain(await requestDomain(dominio, to));
  } catch (e) {
    showAlert(e instanceof Error ? e.message : "Não consegui trocar agora.");
  }
}

// ---- wiring -------------------------------------------------------------------------------
const drop = $("drop");
const input = $("file");
input.addEventListener("change", () => handleFile(input.files[0]));
drop.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), input.click()));
for (const ev of ["dragenter", "dragover"]) drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.add("over")));
for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => (e.preventDefault(), handleFile(e.dataTransfer?.files?.[0])));

document.querySelectorAll(".seg-btn").forEach((b) =>
  b.addEventListener("click", () => {
    cycle = b.dataset.cycle;
    document.querySelectorAll(".seg-btn").forEach((x) => {
      x.classList.toggle("on", x === b);
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

startRibbons($("ribbons"));

$("signup").addEventListener("submit", submitSignup);
$("domain-form").addEventListener("submit", submitDomain);
$("domain-start").addEventListener("click", () => openDomainStep());
$("domain-resume").addEventListener("click", () => openDomainStep());
$("domain-later").addEventListener("click", () => (save({ domain_later: true }), showNextDomain()));
$("choice-have").addEventListener("click", () => openDomainStep("dp-enter"));
$("domain-back").addEventListener("click", () => (view(4, "s-deploy"), showNextDomain()));
$("enter-back").addEventListener("click", () => pane("dp-choose"));
$("dp-switch").addEventListener("click", switchMethod);
$("domain-cancel").addEventListener("click", async () => {
  domainRun++;
  await postJson(api, "/web/domain/cancel", { sessao_id: state.sessao_id });
  inspection = null;
  pane("dp-enter");
  $("f-dominio").focus();
});
$("change-plan").addEventListener("click", () => (clearAlert(), view(3, "s-preview", "s-plans")));
$("f-tel").addEventListener("input", (e) => (e.target.value = maskPhone(e.target.value)));
const docInput = () => {
  const cnpj = $("f-tipo").value === "CNPJ";
  $("f-doc").placeholder = cnpj ? "00.000.000/0000-00" : "000.000.000-00";
  $("f-doc").inputMode = cnpj ? "text" : "numeric";
  $("f-doc").value = maskDoc($("f-tipo").value, $("f-doc").value);
};
$("f-tipo").addEventListener("change", docInput);
$("f-doc").addEventListener("input", docInput);

$("mcp-url").textContent = `${location.origin}/mcp`;
$("cli-prompt").textContent = `Quero publicar este site na Way Cloud. Leia ${location.origin}/llms.txt e siga as instruções. Se você não conseguir acessar a internet ou rodar comandos, gere o site completo em um único arquivo .zip (com a pasta compilada, sem node_modules nem .env) e me entregue para eu enviar em ${location.origin}.`;

// Resume where the visitor left off (for instance after paying in the other tab).
try {
  if (state.stage === "plans") await showPlans();
  else if (state.stage === "waiting" && state.checkout_url) showWaiting();
  else if (state.stage === "deploy" && state.deploy_id) (view(4, "s-deploy"), void follow());
  else if (state.stage === "done" && state.site_url) (showDone(), state.https === false && void waitHttps());
  else view(1, "s-upload");
} catch (e) {
  view(1, "s-upload");
  showAlert(e instanceof Error ? e.message : "Algo deu errado.");
}
