// Sandbox publico de demonstracao (banco Postgres real, Supabase).
// Schema/RLS/funcoes: supabase/schema_demo.sql no repositorio -- NENHUMA
// regra de permissao mora neste arquivo. O banco e a autoridade: as funcoes
// RPC (demo_incluir_cliente/demo_editar_cliente/demo_excluir_cliente) fazem
// a checagem de vertical e o soft delete; este arquivo so chama essas
// funcoes e apresenta o resultado (sucesso, bloqueio ou erro).
//
// A anon key abaixo e destinada a ficar publica no cliente -- a seguranca
// mora nas policies de RLS e nas funcoes SECURITY DEFINER do banco.
const SUPABASE_URL = "https://mmzotwqobbpuahjhulom.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_3n7XKPYyCEZSKybccTYF5g_hfwdllVX";

const CNPJ_LEN = 14;
const RAZAO_MAX = 80;

let sb = null;
let gestoresPorId = new Map();
let connState = "connecting";
let clienteEmEdicao = null;
let clienteParaExcluir = null;
let focoAntesDoModal = null;

const $ = (id) => document.getElementById(id);

/* ============================================================================
   CHAMADAS AO BANCO (nada de logica de permissao aqui -- so a chamada RPC)
   ============================================================================ */
async function carregarGestoresDemo() {
  const { data, error } = await sb.from("demo_gestores").select("*").order("nome");
  if (error) throw error;
  gestoresPorId = new Map(data.map((g) => [g.gestor_id, g]));
  const select = $("demo-gestor-atual");
  select.innerHTML = data.map((g) => `<option value="${g.gestor_id}">${g.nome} (${g.vertical})</option>`).join("");
  atualizarOperador();
}

async function carregarClientesDemo() {
  const { data, error } = await sb.from("demo_clientes").select("*").eq("ativo", true).order("criado_em", { ascending: false });
  if (error) throw error;
  return data;
}

async function carregarLogDemo() {
  const { data, error } = await sb.from("demo_log").select("*").order("criado_em", { ascending: false }).limit(20);
  if (error) throw error;
  return data;
}

async function incluirClienteDemo({ gestorId, razaoSocial, cnpj, porte }) {
  const { data, error } = await sb.rpc("demo_incluir_cliente", {
    p_gestor_id: gestorId, p_razao_social: razaoSocial, p_cnpj: cnpj, p_porte: porte,
  });
  if (error) throw error;
  return data;
}

async function editarClienteDemo({ clienteId, operadorId, campo, novoValor }) {
  const { error } = await sb.rpc("demo_editar_cliente", {
    p_cliente_id: clienteId, p_gestor_operador_id: operadorId, p_campo: campo, p_novo_valor: novoValor,
  });
  if (error) throw error;
}

async function excluirClienteDemo({ clienteId, operadorId }) {
  const { error } = await sb.rpc("demo_excluir_cliente", { p_cliente_id: clienteId, p_gestor_operador_id: operadorId });
  if (error) throw error;
}

/* ============================================================================
   UTILIDADES
   ============================================================================ */
function celula(texto) {
  const td = document.createElement("td");
  td.textContent = texto;
  return td;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str ?? "");
  return div.innerHTML;
}

function somenteDigitos(v) {
  return (v || "").replace(/\D/g, "");
}

function formatarCNPJ(digitsRaw) {
  const d = digitsRaw.slice(0, CNPJ_LEN);
  if (d.length <= 2) return d;
  if (d.length <= 5) return `${d.slice(0, 2)}.${d.slice(2)}`;
  if (d.length <= 8) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5)}`;
  if (d.length <= 12) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8)}`;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

function setFieldError(inputId, errorId, msg) {
  $(errorId).textContent = msg || "";
  $(inputId).classList.toggle("is-invalid", !!msg);
}

function setButtonState(btn, state, opts = {}) {
  const spinner = btn.querySelector(".btn-spinner");
  const label = btn.querySelector(".btn-label");
  btn.classList.remove("is-loading", "is-success");
  if (state === "loading") {
    spinner.hidden = false;
    label.textContent = opts.loadingLabel || "Salvando...";
    btn.classList.add("is-loading");
    btn.disabled = true;
  } else if (state === "success") {
    spinner.hidden = true;
    label.textContent = opts.successLabel || "Feito";
    btn.classList.add("is-success");
    btn.disabled = true;
  } else {
    spinner.hidden = true;
    label.textContent = opts.defaultLabel || btn.dataset.defaultLabel || label.textContent;
    btn.disabled = false;
  }
}

/* ============================================================================
   TOAST
   ============================================================================ */
function toast(mensagem, tipo = "success") {
  const stack = $("toast-stack");
  const el = document.createElement("div");
  el.className = `toast ${tipo}`;
  el.setAttribute("role", "status");

  const icone = document.createElement("span");
  icone.className = "toast-icon";
  icone.setAttribute("aria-hidden", "true");
  icone.textContent = { success: "✓", error: "!", blocked: "⦸" }[tipo] || "";

  const msg = document.createElement("span");
  msg.className = "toast-msg";
  msg.textContent = mensagem;

  const fechar = document.createElement("button");
  fechar.type = "button";
  fechar.className = "toast-close";
  fechar.setAttribute("aria-label", "Fechar notificacao");
  fechar.textContent = "×";

  el.append(icone, msg, fechar);
  stack.appendChild(el);
  requestAnimationFrame(() => el.classList.add("is-visible"));

  const remover = () => {
    el.classList.remove("is-visible");
    setTimeout(() => el.remove(), 250);
  };
  const timer = setTimeout(remover, 4500);
  fechar.addEventListener("click", () => { clearTimeout(timer); remover(); });
}

/* ============================================================================
   TRATAMENTO DE ERRO -- classifica a mensagem que o banco ja manda; nunca
   reimplementa a regra de permissao, so decide qual UI mostrar.
   ============================================================================ */
function tratarErroOperacao(err) {
  console.error(err);
  const msg = String(err?.message || "");

  if (/failed to fetch|networkerror|load failed/i.test(msg) || !msg) {
    toast("Nao foi possivel conectar ao sandbox.", "error");
    return;
  }
  if (msg.includes("nao tem permissao")) {
    fecharModal();
    setTimeout(() => abrirModalBloqueado(), 260);
    return;
  }
  if (msg.toLowerCase().includes("sandbox cheio")) {
    toast(msg, "error");
    return;
  }
  toast("Nao foi possivel salvar neste momento.", "error");
}

/* ============================================================================
   STATUS DE CONEXAO
   ============================================================================ */
function setConnStatus(state) {
  connState = state;
  const el = $("conn-status");
  el.dataset.state = state;
  el.querySelector(".conn-text").textContent = {
    connecting: "Conectando...",
    online: "Sandbox online",
    offline: "Sandbox indisponivel",
  }[state] || state;
  $("conn-banner").hidden = state !== "offline";
  atualizarValidacaoInclusao();
}

function mostrarSkeletonListas() {
  document.querySelector("#table-demo-clientes tbody").innerHTML =
    `<tr><td colspan="5" style="color:var(--ink-3)">Carregando clientes do sandbox...</td></tr>`;
  $("demo-clientes-empty").hidden = true;
  $("table-demo-log").innerHTML =
    `<div class="timeline-item"><span class="timeline-when">&nbsp;</span><span class="timeline-dot-col"><span class="timeline-dot"></span></span><span class="timeline-body" style="color:var(--ink-3)">Carregando auditoria...</span></div>`;
  $("demo-log-empty").hidden = true;
}

function mostrarIndisponivel() {
  document.querySelector("#table-demo-clientes tbody").innerHTML =
    `<tr><td colspan="5" style="color:var(--ink-3)">Sem conexao com o sandbox no momento.</td></tr>`;
  $("table-demo-log").innerHTML =
    `<div class="timeline-item"><span class="timeline-when">&nbsp;</span><span class="timeline-dot-col"><span class="timeline-dot"></span></span><span class="timeline-body" style="color:var(--ink-3)">Sem conexao com o sandbox no momento.</span></div>`;
}

async function tentarConectar() {
  setConnStatus("connecting");
  mostrarSkeletonListas();
  try {
    await carregarGestoresDemo();
    await recarregarListas();
    setConnStatus("online");
  } catch (err) {
    console.error(err);
    mostrarIndisponivel();
    setConnStatus("offline");
  }
}

/* ============================================================================
   OPERADOR SIMULADO
   ============================================================================ */
function atualizarOperador() {
  const gestor = gestoresPorId.get(Number($("demo-gestor-atual").value));
  $("operator-name").textContent = gestor ? gestor.nome : "—";
  $("operator-vertical").textContent = gestor ? gestor.vertical : "";
}

/* ============================================================================
   RENDER: clientes do sandbox e auditoria (timeline)
   ============================================================================ */
function renderizarDemoClientes(clientes, highlightId) {
  const tbody = document.querySelector("#table-demo-clientes tbody");
  const emptyState = $("demo-clientes-empty");
  tbody.innerHTML = "";

  if (!clientes.length) { emptyState.hidden = false; return; }
  emptyState.hidden = true;

  clientes.forEach((c) => {
    const gestor = gestoresPorId.get(c.gestor_id);
    const tr = document.createElement("tr");
    tr.dataset.id = c.id;
    tr.appendChild(celula(c.razao_social));
    tr.appendChild(celula(c.porte));
    tr.appendChild(celula(gestor ? gestor.nome : `#${c.gestor_id}`));
    tr.appendChild(celula(gestor ? gestor.vertical : "--"));

    const tdActions = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "row-actions";
    const btnEdit = document.createElement("button");
    btnEdit.type = "button"; btnEdit.className = "btn-icon"; btnEdit.textContent = "Editar";
    btnEdit.addEventListener("click", () => abrirModalEditar(c));
    const btnDel = document.createElement("button");
    btnDel.type = "button"; btnDel.className = "btn-icon danger"; btnDel.textContent = "Excluir";
    btnDel.addEventListener("click", () => abrirModalExcluir(c));
    wrap.append(btnEdit, btnDel);
    tdActions.appendChild(wrap);
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  });

  if (highlightId) {
    const row = tbody.querySelector(`tr[data-id="${highlightId}"]`);
    if (row) { row.classList.add("is-new"); setTimeout(() => row.classList.remove("is-new"), 1000); }
  }
}

function renderizarDemoLog(logs, highlightFirst) {
  const container = $("table-demo-log");
  const emptyState = $("demo-log-empty");
  container.innerHTML = "";

  if (!logs.length) { emptyState.hidden = false; return; }
  emptyState.hidden = true;

  const rotulo = { INSERT: "incluiu", UPDATE: "editou", DELETE: "excluiu" };
  const classeDot = { INSERT: "insert", UPDATE: "update", DELETE: "delete" };

  logs.forEach((l, i) => {
    const gestor = gestoresPorId.get(l.gestor_operador_id);
    const nomeGestor = gestor ? escapeHtml(gestor.nome) : `Gestor #${l.gestor_operador_id}`;
    const detalhe = l.campo
      ? `<div class="timeline-meta">${escapeHtml(l.campo)}${l.valor_antigo ? `: ${escapeHtml(l.valor_antigo)} &rarr; ${escapeHtml(l.valor_novo)}` : ""}</div>`
      : "";
    const item = document.createElement("div");
    item.className = "timeline-item";
    item.innerHTML = `
      <span class="timeline-when">${new Date(l.criado_em).toLocaleString("pt-BR")}</span>
      <span class="timeline-dot-col"><span class="timeline-dot ${classeDot[l.operacao] || ""}"></span></span>
      <span class="timeline-body"><strong>${nomeGestor}</strong> ${rotulo[l.operacao] || l.operacao} um cliente${detalhe}</span>
    `;
    if (highlightFirst && i === 0) item.classList.add("is-new");
    container.appendChild(item);
  });
}

async function recarregarListas({ highlightClienteId, highlightLog } = {}) {
  const [clientes, logs] = await Promise.all([carregarClientesDemo(), carregarLogDemo()]);
  renderizarDemoClientes(clientes, highlightClienteId);
  renderizarDemoLog(logs, highlightLog);
}

/* ============================================================================
   VALIDACAO -- inclusao
   ============================================================================ */
function atualizarValidacaoInclusao() {
  const btn = $("demo-submit");
  if (btn.classList.contains("is-loading") || btn.classList.contains("is-success")) return true;

  const razao = $("demo-razao-social").value.trim();
  const cnpjDigits = somenteDigitos($("demo-cnpj").value);
  let ok = true;

  if (!razao) { setFieldError("demo-razao-social", "erro-razao-social", "Informe a razao social."); ok = false; }
  else if (razao.length > RAZAO_MAX) { setFieldError("demo-razao-social", "erro-razao-social", `Maximo de ${RAZAO_MAX} caracteres.`); ok = false; }
  else { setFieldError("demo-razao-social", "erro-razao-social", ""); }

  if (!cnpjDigits) { setFieldError("demo-cnpj", "erro-cnpj", "Informe o CNPJ."); ok = false; }
  else if (cnpjDigits.length !== CNPJ_LEN) { setFieldError("demo-cnpj", "erro-cnpj", "CNPJ invalido (14 digitos)."); ok = false; }
  else { setFieldError("demo-cnpj", "erro-cnpj", ""); }

  btn.disabled = !ok || connState !== "online";
  return ok;
}

/* ============================================================================
   MODAIS
   ============================================================================ */
function abrirModal(id, { onOpen } = {}) {
  const overlay = $("modal-overlay");
  document.querySelectorAll(".modal-dialog").forEach((d) => { d.hidden = d.id !== id; });
  focoAntesDoModal = document.activeElement;
  overlay.hidden = false;
  if (onOpen) onOpen();
  requestAnimationFrame(() => overlay.classList.add("is-open"));
  document.addEventListener("keydown", onModalKeydown);
  const dialog = $(id);
  (dialog.querySelector("input, select") || dialog.querySelector("button"))?.focus();
}

function fecharModal() {
  const overlay = $("modal-overlay");
  if (overlay.hidden) return;
  overlay.classList.remove("is-open");
  document.removeEventListener("keydown", onModalKeydown);
  setTimeout(() => {
    overlay.hidden = true;
    document.querySelectorAll(".modal-dialog").forEach((d) => { d.hidden = true; });
  }, 250);
  focoAntesDoModal?.focus?.();
  clienteEmEdicao = null;
  clienteParaExcluir = null;
}

function onModalKeydown(e) {
  if (e.key === "Escape") { fecharModal(); return; }
  if (e.key !== "Tab") return;
  const dialog = document.querySelector(".modal-dialog:not([hidden])");
  if (!dialog) return;
  const focaveis = dialog.querySelectorAll('input, select, button, [tabindex]:not([tabindex="-1"])');
  if (!focaveis.length) return;
  const primeiro = focaveis[0];
  const ultimo = focaveis[focaveis.length - 1];
  if (e.shiftKey && document.activeElement === primeiro) { e.preventDefault(); ultimo.focus(); }
  else if (!e.shiftKey && document.activeElement === ultimo) { e.preventDefault(); primeiro.focus(); }
}

function abrirModalBloqueado(mensagem) {
  abrirModal("modal-bloqueado", {
    onOpen: () => {
      $("modal-bloqueado-texto").textContent =
        mensagem || "Este cliente pertence a outra vertical. A regra de permissao impede esta alteracao.";
    },
  });
}

function abrirModalEditar(cliente) {
  clienteEmEdicao = cliente;
  const gestor = gestoresPorId.get(cliente.gestor_id);
  abrirModal("modal-editar", {
    onOpen: () => {
      $("editar-razao-social").value = cliente.razao_social;
      $("editar-porte").value = cliente.porte;
      $("editar-gestor-nome").textContent = gestor ? gestor.nome : `#${cliente.gestor_id}`;
      $("editar-gestor-vertical").textContent = gestor ? gestor.vertical : "--";
      setFieldError("editar-razao-social", "erro-editar-razao-social", "");
      setButtonState($("editar-submit"), "default");
    },
  });
}

function abrirModalExcluir(cliente) {
  clienteParaExcluir = cliente;
  abrirModal("modal-excluir", {
    onOpen: () => {
      $("excluir-nome-cliente").textContent = cliente.razao_social;
      setButtonState($("excluir-confirmar"), "default");
    },
  });
}

/* ============================================================================
   SUBMIT HANDLERS
   ============================================================================ */
async function onSubmitIncluir(e) {
  e.preventDefault();
  if (connState !== "online") { toast("Sandbox indisponivel no momento.", "error"); return; }
  if (!atualizarValidacaoInclusao()) return;

  const btn = $("demo-submit");
  setButtonState(btn, "loading", { loadingLabel: "Salvando..." });

  const gestorId = Number($("demo-gestor-atual").value);
  const razaoSocial = $("demo-razao-social").value.trim();
  const cnpj = somenteDigitos($("demo-cnpj").value);
  const porte = $("demo-porte").value;

  try {
    const novoId = await incluirClienteDemo({ gestorId, razaoSocial, cnpj, porte });
    setButtonState(btn, "success", { successLabel: "Cliente incluido" });
    toast("Cliente incluido no sandbox.", "success");
    $("demo-razao-social").value = "";
    $("demo-cnpj").value = "";
    $("demo-porte").value = "MEI";
    await recarregarListas({ highlightClienteId: novoId, highlightLog: true });
    setTimeout(() => { setButtonState(btn, "default"); atualizarValidacaoInclusao(); }, 1400);
  } catch (err) {
    setButtonState(btn, "default");
    atualizarValidacaoInclusao();
    tratarErroOperacao(err);
  }
}

async function onSubmitEditar(e) {
  e.preventDefault();
  if (!clienteEmEdicao) return;
  if (connState !== "online") { toast("Sandbox indisponivel no momento.", "error"); return; }

  const novaRazao = $("editar-razao-social").value.trim();
  const novoPorte = $("editar-porte").value;
  if (!novaRazao) { setFieldError("editar-razao-social", "erro-editar-razao-social", "Informe a razao social."); return; }
  if (novaRazao.length > RAZAO_MAX) { setFieldError("editar-razao-social", "erro-editar-razao-social", `Maximo de ${RAZAO_MAX} caracteres.`); return; }
  setFieldError("editar-razao-social", "erro-editar-razao-social", "");

  const mudancas = [];
  if (novaRazao !== clienteEmEdicao.razao_social) mudancas.push(["razao_social", novaRazao]);
  if (novoPorte !== clienteEmEdicao.porte) mudancas.push(["porte", novoPorte]);

  const btn = $("editar-submit");
  if (!mudancas.length) { fecharModal(); return; }

  setButtonState(btn, "loading", { loadingLabel: "Salvando..." });
  const operadorId = Number($("demo-gestor-atual").value);
  const idEditado = clienteEmEdicao.id;

  try {
    for (const [campo, valor] of mudancas) {
      await editarClienteDemo({ clienteId: idEditado, operadorId, campo, novoValor: valor });
    }
    setButtonState(btn, "success", { successLabel: "Salvo" });
    toast("Alteracao salva.", "success");
    setTimeout(async () => {
      fecharModal();
      await recarregarListas({ highlightClienteId: idEditado, highlightLog: true });
    }, 500);
  } catch (err) {
    setButtonState(btn, "default");
    tratarErroOperacao(err);
  }
}

async function onClickExcluir() {
  if (!clienteParaExcluir) return;
  if (connState !== "online") { toast("Sandbox indisponivel no momento.", "error"); return; }

  const btn = $("excluir-confirmar");
  setButtonState(btn, "loading", { loadingLabel: "Excluindo..." });
  const operadorId = Number($("demo-gestor-atual").value);

  try {
    await excluirClienteDemo({ clienteId: clienteParaExcluir.id, operadorId });
    setButtonState(btn, "success", { successLabel: "Excluido" });
    toast("Cliente removido do sandbox.", "success");
    setTimeout(async () => {
      fecharModal();
      await recarregarListas({ highlightLog: true });
    }, 500);
  } catch (err) {
    setButtonState(btn, "default");
    tratarErroOperacao(err);
  }
}

/* ============================================================================
   WIRING ESTATICO -- roda sempre, mesmo se a conexao com o Supabase falhar
   ============================================================================ */
function wireEstatico() {
  $("demo-cnpj").addEventListener("input", () => {
    $("demo-cnpj").value = formatarCNPJ(somenteDigitos($("demo-cnpj").value));
    atualizarValidacaoInclusao();
  });
  $("demo-razao-social").addEventListener("input", atualizarValidacaoInclusao);
  $("demo-gestor-atual").addEventListener("change", atualizarOperador);
  $("demo-form").addEventListener("submit", onSubmitIncluir);

  $("editar-razao-social").addEventListener("input", () => {
    const ok = $("editar-razao-social").value.trim().length > 0;
    setFieldError("editar-razao-social", "erro-editar-razao-social", ok ? "" : "Informe a razao social.");
  });
  $("form-editar").addEventListener("submit", onSubmitEditar);
  $("excluir-confirmar").addEventListener("click", onClickExcluir);

  document.querySelectorAll("[data-modal-close]").forEach((b) => b.addEventListener("click", fecharModal));
  $("modal-overlay").addEventListener("click", (e) => { if (e.target === $("modal-overlay")) fecharModal(); });

  $("conn-retry").addEventListener("click", tentarConectar);

  ["demo-submit", "editar-submit", "excluir-confirmar"].forEach((id) => {
    const btn = $(id);
    btn.dataset.defaultLabel = btn.querySelector(".btn-label").textContent;
  });

  atualizarValidacaoInclusao();
}

function initDemo() {
  wireEstatico();
  if (typeof supabase === "undefined") {
    mostrarIndisponivel();
    setConnStatus("offline");
    toast("Biblioteca do Supabase nao carregou.", "error");
    return;
  }
  sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  tentarConectar();
}

initDemo();
