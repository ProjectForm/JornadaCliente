// Cadastro -- banco Postgres real (Supabase). Schema/RLS/funcoes/regra de
// negocio: supabase/schema_demo.sql (schema completo) e
// supabase/schema_demo_v2_operacao.sql (migracao aditiva da Etapa 2 --
// historico, versionamento, restauracao, reatribuicao de gestor). NENHUMA
// regra de permissao ou de classificacao (Concluinte/Inconsistente/
// Prioritario) mora neste arquivo -- a view v_demo_clientes_completo (e as
// views que ela usa) SAO a fonte unica de verdade: este arquivo so le o que
// elas ja calcularam e apresenta. Apos qualquer escrita via RPC, TUDO e
// recarregado da mesma fonte (recarregarSandboxEAtualizarTudo) -- nao existe
// recalculo paralelo em JS, nem F5 manual necessario.
//
// ETAPA 2 -- mudanca de arquitetura na tabela de clientes: em vez de carregar
// todos os clientes uma vez e filtrar/ordenar/paginar em JS, a TABELA usa uma
// consulta dedicada contra a view (filtros/busca/ordenacao/paginacao=
// .eq/.in/.ilike/.order/.range do PostgREST) -- o resultado exportado ou
// mostrado e sempre o resultado real da consulta, nunca um reordenamento
// visual.
//
// ETAPA 2.5 -- UNIFICACAO DE BASE: esta e a MESMA base que o Dashboard le
// (assets/app.js) -- ja nao ha teto de clientes ativos nem autolimpeza (ver
// docs/AUDITORIA_E_VERSIONAMENTO.md). KPIs/ranking aqui no Cadastro
// continuam agregando sobre a lista completa carregada uma vez
// (carregarSandboxCompleto()) -- com 2500+ clientes isso ja nao e tao barato
// quanto era com o teto de 200; se a base crescer muito mais, o proximo
// passo natural e mover essa agregacao para uma funcao SQL (ver nota em
// docs/AUDITORIA_E_VERSIONAMENTO.md).
//
// SUPABASE_URL/SUPABASE_ANON_KEY e o cliente `sb` sao declarados em
// assets/app.js (que carrega primeiro) -- reaproveitados aqui, nao
// recriados. A anon key e destinada a ficar publica no cliente -- a
// seguranca mora nas policies de RLS e nas funcoes SECURITY DEFINER do banco.

const CNPJ_LEN = 14;
const RAZAO_MAX = 80;
const STATUS_VALORES = ["Concluinte", "Participante", "Sem atendimento"];
const CADASTRO_POR_PAGINA = 20;

const OPCOES_ORDENACAO = [
  { value: "criado_em", label: "Data de inclusao" },
  { value: "atualizado_em", label: "Ultima atualizacao" },
  { value: "razao_social", label: "Razao social" },
  { value: "cnpj", label: "CNPJ" },
  { value: "gestor", label: "Gestor" },
  { value: "status", label: "Status" },
  { value: "prioritario", label: "Prioridade" },
  { value: "aumento_faturamento_pct", label: "% aumento de faturamento" },
];

const ROTULOS_CAMPO = {
  razao_social: "Razao social", porte: "Porte", gestor_id: "Gestor", municipio: "Municipio",
  cpf: "CPF", celular: "Celular", email: "E-mail", whatsapp_atualizado: "WhatsApp atualizado",
  email_atualizado: "E-mail atualizado", ali: "Indicacao de ALI", observacoes: "Observacoes",
  termo: "Termo", data_termo: "Data do termo", respondeu: "Respondeu pesquisa", data_pesquisa: "Data da pesquisa",
  aumento_faturamento_pct: "% aumento de faturamento", aumento_informado_pct: "% aumento informado",
  diagnostico_rae: "Diagnostico RAE", assessoramento_rae: "Assessoramento RAE", ot_final: "OT final",
};

const CRITERIOS_RANKING = {
  clientes: { label: "Mais clientes", calc: (r) => r.total, fmt: (v) => fmtInt(v) },
  pj_distintos: { label: "Mais PJ Distintos", calc: (r) => r.pj_distintos, fmt: (v) => fmtInt(v) },
  pct_conclusao: { label: "Maior % de conclusao", calc: (r) => (r.total ? r.pj_distintos / r.total : 0), fmt: (v) => fmtPct(arred1(v * 100)) },
  respondentes: { label: "Mais respondentes", calc: (r) => r.respondentes, fmt: (v) => fmtInt(v) },
  aumento_medio: { label: "Maior aumento medio", calc: (r) => (r.media_aumento === null ? -Infinity : r.media_aumento), fmt: (v) => (v === -Infinity ? "sem dados" : fmtPct(v)) },
  inconsistencias: { label: "Mais inconsistencias", calc: (r) => r.inconsistentes, fmt: (v) => fmtInt(v) },
};

// `sb` ja existe (declarado e criado em assets/app.js, que carrega primeiro).
let gestoresPorId = new Map();
let centrosCustoPorId = new Map();
let sandboxClientes = []; // lista COMPLETA de clientes ativos -- alimenta KPIs, ranking, dedup, datalists
let sandboxLogs = [];
let connState = "connecting";
let clienteEmEdicao = null;
let clienteParaExcluir = null;
let clienteParaAtendimento = null;
let clienteHistoricoAtual = null;
let versoesHistoricoAtual = [];
let focoAntesDoModal = null;
let ultimaSincronizacao = null;
let criterioRanking = "pj_distintos";
let highlightFirstLog = false;

// Estado da TABELA do Cadastro -- fonte unica dos filtros/busca/ordenacao/
// paginacao; toda mudanca aqui dispara uma nova consulta ao banco (ver
// atualizarTabelaCadastro()), nunca um filtro em memoria.
const cadastroFiltros = {
  vertical: new Set(), status: new Set(), porte: new Set(),
  gestorId: null, municipio: null,
  prioritario: null, inconsistente: null, respondeu: null,
};
let cadastroBusca = "";
let cadastroOrdenarPor = "criado_em";
let cadastroOrdemAsc = false;
let cadastroPagina = 1;
let cadastroTabela = { linhas: [], total: 0 };

const $ = (id) => document.getElementById(id);

function arred1(n) { return Math.round(n * 10) / 10; }

function debounce(fn, wait) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); };
}

/* ============================================================================
   CHAMADAS AO BANCO -- nenhuma logica de permissao/classificacao aqui, so a
   chamada e a leitura da view/RPC que ja fazem esse trabalho.
   ============================================================================ */
async function carregarSandboxCompleto() {
  const [gestoresRes, ccRes, clientes, logsRes] = await Promise.all([
    sb.from("demo_gestores").select("*").order("nome"),
    sb.from("demo_centros_custo").select("*").order("id"),
    // .select("*") sem paginacao truncaria silenciosamente no teto de linhas
    // do PostgREST agora que a base e a mesma do Dashboard (2500+ clientes,
    // nao mais ate 200) -- ver buscarTudoPaginado em assets/app.js.
    buscarTudoPaginado(() => sb.from("v_demo_clientes_completo").select("*").order("criado_em", { ascending: false })),
    sb.from("demo_log").select("*").order("criado_em", { ascending: false }).limit(30),
  ]);
  if (gestoresRes.error) throw gestoresRes.error;
  if (ccRes.error) throw ccRes.error;
  if (logsRes.error) throw logsRes.error;

  gestoresPorId = new Map(gestoresRes.data.map((g) => [g.gestor_id, g]));
  centrosCustoPorId = new Map(ccRes.data.map((c) => [c.id, c]));
  sandboxClientes = clientes;
  sandboxLogs = logsRes.data;

  const select = $("demo-gestor-atual");
  const valorAtual = select.value;
  select.innerHTML = gestoresRes.data.map((g) => `<option value="${g.gestor_id}">${g.nome} (${g.vertical})</option>`).join("");
  if (valorAtual && gestoresPorId.has(Number(valorAtual))) select.value = valorAtual;
  atualizarOperador();

  popularFiltrosDinamicos();
}

async function carregarClassificacaoCC(clienteId) {
  const { data, error } = await sb.from("v_demo_classificacao_cc").select("*").eq("cliente_id", clienteId);
  if (error) throw error;
  return data;
}

async function incluirClienteDemo({ gestorId, razaoSocial, cnpj, porte, extra }) {
  const { data, error } = await sb.rpc("demo_incluir_cliente", {
    p_gestor_id: gestorId, p_razao_social: razaoSocial, p_cnpj: cnpj, p_porte: porte, p_extra: extra || {},
  });
  if (error) throw error;
  return data;
}

async function editarClienteDemo({ clienteId, operadorId, campos }) {
  const { error } = await sb.rpc("demo_editar_cliente", { p_cliente_id: clienteId, p_gestor_operador_id: operadorId, p_campos: campos });
  if (error) throw error;
}

async function excluirClienteDemo({ clienteId, operadorId }) {
  const { error } = await sb.rpc("demo_excluir_cliente", { p_cliente_id: clienteId, p_gestor_operador_id: operadorId });
  if (error) throw error;
}

async function definirAtendimentoDemo(params) {
  const { error } = await sb.rpc("demo_definir_atendimento", {
    p_cliente_id: params.clienteId, p_centro_custo_id: params.centroCustoId, p_operador_id: params.operadorId,
    p_diagnosticos_total: params.diagnosticosTotal, p_diagnosticos_validos: params.diagnosticosValidos,
    p_assessorias_total: params.assessoriasTotal, p_assessorias_validos: params.assessoriasValidos,
    p_sebraetec_total: params.sebraetecTotal, p_sebraetec_validos: params.sebraetecValidos,
  });
  if (error) throw error;
}

async function reatribuirGestorDemo({ clienteId, operadorId, novoGestorId }) {
  const { error } = await sb.rpc("demo_reatribuir_gestor", {
    p_cliente_id: clienteId, p_gestor_operador_id: operadorId, p_novo_gestor_id: novoGestorId,
  });
  if (error) throw error;
}

async function restaurarVersaoDemo({ versaoId, operadorId }) {
  const { error } = await sb.rpc("demo_restaurar_versao_cliente", { p_versao_id: versaoId, p_gestor_operador_id: operadorId });
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

function tempoRelativo(dataIso) {
  const diffMs = Date.now() - new Date(dataIso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "agora mesmo";
  if (min < 60) return `ha ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `ha ${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `ha ${d}d`;
  return new Date(dataIso).toLocaleDateString("pt-BR");
}

function rotularCampo(campo) { return ROTULOS_CAMPO[campo] || campo; }

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
    toast("Nao foi possivel conectar ao Cadastro.", "error");
    return;
  }
  if (msg.includes("nao tem permissao")) {
    fecharModal();
    setTimeout(() => abrirModalBloqueado(), 260);
    return;
  }
  if (msg.toLowerCase().includes("cheio")) {
    toast(msg, "error");
    return;
  }
  toast("Nao foi possivel salvar neste momento.", "error");
}

/* ============================================================================
   STATUS DE CONEXAO / SINCRONIZACAO
   ============================================================================ */
function setConnStatus(state) {
  connState = state;
  const el = $("conn-status");
  el.dataset.state = state;
  el.querySelector(".conn-text").textContent = {
    connecting: "Conectando...",
    online: "Cadastro online",
    offline: "Cadastro indisponivel",
  }[state] || state;
  $("conn-banner").hidden = state !== "offline";
  atualizarValidacaoInclusao();
}

function setSyncStatus(state) {
  const el = $("sandbox-sync-status");
  el.dataset.state = state;
  el.querySelector(".sync-text").textContent = {
    idle: "—",
    updating: "Atualizando...",
    updated: "Dados atualizados",
    error: "Falha ao atualizar",
  }[state] || state;
}

function atualizarUltimaAtualizacaoTexto() {
  const el = $("sandbox-last-sync");
  el.textContent = ultimaSincronizacao ? `Ultima atualizacao: ${ultimaSincronizacao.toLocaleString("pt-BR")}` : "";
}

function mostrarSkeletonListas() {
  $("sandbox-ranking").innerHTML = "";
  document.querySelectorAll(".sandbox-kpi").forEach((el) => el.classList.add("skeleton"));
  document.querySelector("#table-demo-clientes tbody").innerHTML =
    `<tr><td colspan="7" style="color:var(--ink-3)">Carregando clientes do Cadastro...</td></tr>`;
  $("demo-clientes-empty").hidden = true;
  $("table-demo-log").innerHTML =
    `<div class="timeline-item"><span class="timeline-when">&nbsp;</span><span class="timeline-dot-col"><span class="timeline-dot"></span></span><span class="timeline-body" style="color:var(--ink-3)">Carregando atividade...</span></div>`;
  $("demo-log-empty").hidden = true;
}

function mostrarIndisponivel() {
  document.querySelector("#table-demo-clientes tbody").innerHTML =
    `<tr><td colspan="7" style="color:var(--ink-3)">Sem conexao com o Cadastro no momento.</td></tr>`;
  $("table-demo-log").innerHTML =
    `<div class="timeline-item"><span class="timeline-when">&nbsp;</span><span class="timeline-dot-col"><span class="timeline-dot"></span></span><span class="timeline-body" style="color:var(--ink-3)">Sem conexao com o Cadastro no momento.</span></div>`;
  $("sandbox-ranking").innerHTML = `<p class="empty-state">Sem conexao com o Cadastro no momento.</p>`;
  $("cadastro-filter-bar").dataset.state = "error";
  $("cadastro-result-count").textContent = "Erro ao carregar dados";
}

async function tentarConectar() {
  setConnStatus("connecting");
  setSyncStatus("updating");
  mostrarSkeletonListas();
  try {
    await recarregarSandboxEAtualizarTudo();
    setConnStatus("online");
  } catch (err) {
    console.error(err);
    mostrarIndisponivel();
    setConnStatus("offline");
    setSyncStatus("error");
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
   AGREGACAO (KPIs/ranking) -- pura contagem/media sobre campos JA
   classificados pela view do banco. Roda sobre a lista COMPLETA de clientes
   ativos (nunca sobre a pagina filtrada da tabela) -- ver
   docs/AUDITORIA_E_VERSIONAMENTO.md para o trade-off disso com a base
   unificada (2500+ clientes).
   ============================================================================ */
function agregarResumoSandbox(clientes) {
  const total = clientes.length;
  const pj = clientes.filter((c) => c.pj_distinto).length;
  const inconsistentes = clientes.filter((c) => c.inconsistente_geral).length;
  const prioritarios = clientes.filter((c) => c.prioritario).length;
  const aliCount = clientes.filter((c) => c.ali).length;
  const respondentes = clientes.filter((c) => c.respondeu).length;
  const aumentos = clientes.filter((c) => c.respondeu && c.aumento_faturamento_pct !== null).map((c) => c.aumento_faturamento_pct);
  return {
    total, pj_distintos: pj, pct_pj_distintos: total ? arred1((100 * pj) / total) : 0,
    inconsistentes, pct_inconsistentes: total ? arred1((100 * inconsistentes) / total) : 0,
    prioritarios, ali: aliCount, respondentes,
    pct_respondentes: total ? arred1((100 * respondentes) / total) : 0,
    media_aumento: aumentos.length ? arred1(aumentos.reduce((a, b) => a + b, 0) / aumentos.length) : null,
  };
}

function agregarPorGestorSandbox(clientes) {
  const grupos = new Map();
  clientes.forEach((c) => {
    if (!grupos.has(c.gestor_id)) grupos.set(c.gestor_id, { gestor: c.gestor, vertical: c.vertical, lista: [] });
    grupos.get(c.gestor_id).lista.push(c);
  });
  return [...grupos.entries()].map(([gestorId, { gestor, vertical, lista }]) => ({
    gestor_id: gestorId, gestor, vertical, ...agregarResumoSandbox(lista),
  }));
}

/* ============================================================================
   KPIs
   ============================================================================ */
function montarKpisSandbox(resumo) {
  document.querySelectorAll(".sandbox-kpi").forEach((el) => el.classList.remove("skeleton"));
  const valores = {
    total: fmtInt(resumo.total),
    pj_distinto: fmtInt(resumo.pj_distintos),
    inconsistente: fmtInt(resumo.inconsistentes),
    prioritario: fmtInt(resumo.prioritarios),
    respondentes: fmtInt(resumo.respondentes),
    aumento: resumo.media_aumento !== null ? fmtPct(resumo.media_aumento) : "—",
    gestores: fmtInt(new Set(sandboxClientes.map((c) => c.gestor_id)).size),
  };
  Object.entries(valores).forEach(([chave, texto]) => {
    const tile = document.querySelector(`.sandbox-kpi[data-kpi="${chave}"]`);
    if (tile) tile.querySelector(".stat-value").textContent = texto;
  });
}

/* ============================================================================
   RANKING (criterio selecionavel) -- clicar num gestor filtra a tabela
   ============================================================================ */
function montarRankingSandbox(clientesFiltrados) {
  const porGestor = agregarPorGestorSandbox(clientesFiltrados);
  const container = $("sandbox-ranking");
  if (!porGestor.length) {
    container.innerHTML = `<p class="empty-state">Nenhum gestor com clientes no Cadastro ainda.</p>`;
    return;
  }
  const crit = CRITERIOS_RANKING[criterioRanking];
  const ordenado = [...porGestor].sort((a, b) => crit.calc(b) - crit.calc(a)).slice(0, 5);

  container.innerHTML = ordenado.map((g, i) => `
    <div class="ranking-row" data-gestor-id="${g.gestor_id}" tabindex="0" role="button" title="Filtrar a tabela pela carteira de ${g.gestor}">
      <span class="ranking-pos">${i + 1}&ordm;</span>
      <span class="ranking-nome">${g.gestor}<span class="ranking-vertical">${g.vertical}</span></span>
      <span class="ranking-valor">${crit.fmt(crit.calc(g))}</span>
    </div>
  `).join("");
}

/* ============================================================================
   FILTROS DO CADASTRO -- chips (multi-selecao) + datalist (gestor/municipio)
   + toggles (prioritario/inconsistente/respondeu). Estado centralizado em
   cadastroFiltros; toda mudanca chama aplicarFiltrosCadastro(), que refaz a
   consulta ao banco (nunca filtra em memoria).
   ============================================================================ */
function popularFiltrosDinamicos() {
  const verticais = [...new Set([...gestoresPorId.values()].map((g) => g.vertical))].sort();
  construirChipsCadastro("cadastro-chips-vertical", verticais, "vertical");
  construirChipsCadastro("cadastro-chips-status", STATUS_VALORES, "status");
  construirChipsCadastro("cadastro-chips-porte", PORTE_ORDEM, "porte");

  const municipios = [...new Set(sandboxClientes.map((c) => c.municipio).filter(Boolean))].sort();
  $("cadastro-municipios-lista").innerHTML = municipios.map((m) => `<option value="${escapeHtml(m)}">`).join("");
  $("cadastro-gestores-lista").innerHTML = [...gestoresPorId.values()]
    .map((g) => `<option value="${escapeHtml(g.nome)}">`).join("");

  $("cadastro-filter-bar").dataset.state = "ready";
}

function construirChipsCadastro(containerId, valores, chave) {
  const container = $(containerId);
  container.innerHTML = "";
  valores.forEach((valor) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.dataset.value = valor;
    chip.textContent = valor;
    chip.addEventListener("click", () => toggleFiltroSetCadastro(chave, valor));
    container.appendChild(chip);
  });
}

function toggleFiltroSetCadastro(chave, valor) {
  const set = cadastroFiltros[chave];
  if (set.has(valor)) set.delete(valor); else set.add(valor);
  cadastroPagina = 1;
  aplicarFiltrosCadastro();
}

function toggleFiltroExtraCadastro(chave) {
  cadastroFiltros[chave] = cadastroFiltros[chave] === true ? null : true;
  cadastroPagina = 1;
  aplicarFiltrosCadastro();
}

function definirFiltroGestorPorNome(nome) {
  const alvo = nome.trim().toLowerCase();
  const gestor = [...gestoresPorId.values()].find((g) => g.nome.toLowerCase() === alvo);
  cadastroFiltros.gestorId = gestor ? gestor.gestor_id : (alvo ? cadastroFiltros.gestorId : null);
  if (!alvo) cadastroFiltros.gestorId = null;
  cadastroPagina = 1;
  aplicarFiltrosCadastro();
}

function definirFiltroMunicipio(valor) {
  const alvo = valor.trim();
  const municipios = new Set(sandboxClientes.map((c) => c.municipio).filter(Boolean));
  cadastroFiltros.municipio = alvo && municipios.has(alvo) ? alvo : (alvo ? cadastroFiltros.municipio : null);
  if (!alvo) cadastroFiltros.municipio = null;
  cadastroPagina = 1;
  aplicarFiltrosCadastro();
}

function definirFiltroGestorPorId(gestorId) {
  cadastroFiltros.gestorId = cadastroFiltros.gestorId === gestorId ? null : gestorId;
  $("cadastro-filtro-gestor").value = cadastroFiltros.gestorId ? (gestoresPorId.get(cadastroFiltros.gestorId)?.nome || "") : "";
  cadastroPagina = 1;
  aplicarFiltrosCadastro();
  document.getElementById("cadastro-filter-bar").scrollIntoView({ behavior: "smooth", block: "start" });
}

function limparFiltrosCadastro() {
  cadastroFiltros.vertical.clear();
  cadastroFiltros.status.clear();
  cadastroFiltros.porte.clear();
  cadastroFiltros.gestorId = null;
  cadastroFiltros.municipio = null;
  cadastroFiltros.prioritario = null;
  cadastroFiltros.inconsistente = null;
  cadastroFiltros.respondeu = null;
  $("cadastro-filtro-gestor").value = "";
  $("cadastro-filtro-municipio").value = "";
  $("cadastro-busca").value = "";
  cadastroBusca = "";
  cadastroPagina = 1;
  aplicarFiltrosCadastro();
}

function algumFiltroAtivoCadastro() {
  const f = cadastroFiltros;
  return !!(f.vertical.size || f.status.size || f.porte.size || f.gestorId || f.municipio
    || f.prioritario !== null || f.inconsistente !== null || f.respondeu !== null || cadastroBusca);
}

function descreverFiltrosAtivosCadastro() {
  const f = cadastroFiltros;
  const chips = [];
  f.vertical.forEach((v) => chips.push({ tipo: "vertical", valor: v, label: v }));
  f.status.forEach((v) => chips.push({ tipo: "status", valor: v, label: v }));
  f.porte.forEach((v) => chips.push({ tipo: "porte", valor: v, label: v }));
  if (f.gestorId) chips.push({ tipo: "gestorId", label: `Gestor: ${gestoresPorId.get(f.gestorId)?.nome || f.gestorId}` });
  if (f.municipio) chips.push({ tipo: "municipio", label: `Municipio: ${f.municipio}` });
  if (f.prioritario !== null) chips.push({ tipo: "prioritario", label: "Prioritario" });
  if (f.inconsistente !== null) chips.push({ tipo: "inconsistente", label: "Inconsistente" });
  if (f.respondeu !== null) chips.push({ tipo: "respondeu", label: "Respondeu pesquisa" });
  if (cadastroBusca) chips.push({ tipo: "busca", label: `Busca: "${cadastroBusca}"` });
  return chips;
}

function removerFiltroChipCadastro(tipo, valor) {
  if (tipo === "busca") { $("cadastro-busca").value = ""; cadastroBusca = ""; }
  else if (["vertical", "status", "porte"].includes(tipo)) cadastroFiltros[tipo].delete(valor);
  else if (tipo === "gestorId") { cadastroFiltros.gestorId = null; $("cadastro-filtro-gestor").value = ""; }
  else if (tipo === "municipio") { cadastroFiltros.municipio = null; $("cadastro-filtro-municipio").value = ""; }
  else cadastroFiltros[tipo] = null;
  cadastroPagina = 1;
  aplicarFiltrosCadastro();
}

function renderizarFiltrosAtivosCadastro() {
  const chips = descreverFiltrosAtivosCadastro();
  const wrap = $("cadastro-filtros-ativos");
  wrap.hidden = !chips.length;
  $("cadastro-filtros-ativos-lista").innerHTML = chips.map((c) => `
    <span class="chip-removivel" data-tipo="${c.tipo}" data-valor="${escapeHtml(c.valor ?? "")}">
      ${escapeHtml(c.label)}
      <button type="button" aria-label="Remover filtro ${escapeHtml(c.label)}">&times;</button>
    </span>
  `).join("");

  document.querySelectorAll("#cadastro-chips-vertical .chip").forEach((el) => el.classList.toggle("is-active", cadastroFiltros.vertical.has(el.dataset.value)));
  document.querySelectorAll("#cadastro-chips-status .chip").forEach((el) => el.classList.toggle("is-active", cadastroFiltros.status.has(el.dataset.value)));
  document.querySelectorAll("#cadastro-chips-porte .chip").forEach((el) => el.classList.toggle("is-active", cadastroFiltros.porte.has(el.dataset.value)));
  document.querySelectorAll("#cadastro-chips-extra .chip").forEach((el) => el.classList.toggle("is-active", cadastroFiltros[el.dataset.extra] === true));

  $("cadastro-filter-clear").hidden = !algumFiltroAtivoCadastro();
}

function aplicarFiltrosCadastro() {
  renderizarFiltrosAtivosCadastro();
  atualizarTabelaCadastro();
}

/* ============================================================================
   CONSULTA DA TABELA -- filtros + busca + ordenacao + paginacao aplicados no
   banco (PostgREST), nunca em memoria. Reaproveitada tambem pela exportacao
   (sem o .range(), para trazer TODAS as linhas do resultado filtrado).
   ============================================================================ */
function construirQueryCadastro() {
  let query = sb.from("v_demo_clientes_completo").select("*", { count: "exact" });
  const f = cadastroFiltros;
  if (f.vertical.size) query = query.in("vertical", [...f.vertical]);
  if (f.status.size) query = query.in("status", [...f.status]);
  if (f.porte.size) query = query.in("porte", [...f.porte]);
  if (f.gestorId) query = query.eq("gestor_id", f.gestorId);
  if (f.municipio) query = query.eq("municipio", f.municipio);
  if (f.prioritario !== null) query = query.eq("prioritario", f.prioritario);
  if (f.inconsistente !== null) query = query.eq("inconsistente_geral", f.inconsistente);
  if (f.respondeu !== null) query = query.eq("respondeu", f.respondeu);

  const termoOr = construirTermoBuscaCadastro();
  if (termoOr) query = query.or(termoOr);

  return query;
}

function construirTermoBuscaCadastro() {
  if (!cadastroBusca) return null;
  const limpo = cadastroBusca.replace(/[,()%]/g, " ").trim();
  if (!limpo) return null;
  const digitos = somenteDigitos(limpo);
  const partes = [`razao_social.ilike.%${limpo}%`, `gestor.ilike.%${limpo}%`];
  if (digitos) partes.push(`cnpj.ilike.%${digitos}%`);
  return partes.join(",");
}

async function buscarPaginaCadastro() {
  const { data, count, error } = await construirQueryCadastro()
    .order(cadastroOrdenarPor, { ascending: cadastroOrdemAsc, nullsFirst: false })
    .range((cadastroPagina - 1) * CADASTRO_POR_PAGINA, cadastroPagina * CADASTRO_POR_PAGINA - 1);
  if (error) throw error;
  cadastroTabela = { linhas: data || [], total: count || 0 };
}

async function buscarTodosCadastroParaExportacao() {
  // buscarTudoPaginado (assets/app.js) evita truncar silenciosamente no
  // teto de linhas do PostgREST quando a exportacao nao tem filtro (base
  // unificada, 2500+ clientes).
  return buscarTudoPaginado(() =>
    construirQueryCadastro().order(cadastroOrdenarPor, { ascending: cadastroOrdemAsc, nullsFirst: false }));
}

async function atualizarTabelaCadastro() {
  const tbody = document.querySelector("#table-demo-clientes tbody");
  tbody.innerHTML = `<tr><td colspan="7" style="color:var(--ink-3)">Buscando...</td></tr>`;
  try {
    await buscarPaginaCadastro();
    montarClientesSandbox(cadastroTabela.linhas);
    renderizarPaginacaoCadastro();
    renderizarContagemCadastro();
  } catch (err) {
    console.error(err);
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--ink-3)">Nao foi possivel buscar os clientes.</td></tr>`;
    toast("Nao foi possivel aplicar os filtros agora.", "error");
  }
}

function renderizarContagemCadastro() {
  const total = sandboxClientes.length;
  const filtrado = cadastroTabela.total;
  const texto = algumFiltroAtivoCadastro()
    ? `${fmtInt(filtrado)} de ${fmtInt(total)} clientes`
    : `${fmtInt(total)} clientes`;
  $("cadastro-contagem").textContent = texto;
  $("cadastro-result-count").textContent = texto;
}

function renderizarPaginacaoCadastro() {
  const totalPaginas = Math.max(1, Math.ceil(cadastroTabela.total / CADASTRO_POR_PAGINA));
  if (cadastroPagina > totalPaginas) cadastroPagina = totalPaginas;
  const pager = $("cadastro-pager");
  pager.innerHTML = `
    <button id="cadastro-pg-prev" ${cadastroPagina <= 1 ? "disabled" : ""}>&larr; Anterior</button>
    <span>Pagina ${cadastroPagina} de ${totalPaginas} &middot; ${fmtInt(cadastroTabela.total)} clientes</span>
    <button id="cadastro-pg-next" ${cadastroPagina >= totalPaginas ? "disabled" : ""}>Proxima &rarr;</button>
  `;
  $("cadastro-pg-prev")?.addEventListener("click", () => { cadastroPagina--; atualizarTabelaCadastro(); });
  $("cadastro-pg-next")?.addEventListener("click", () => { cadastroPagina++; atualizarTabelaCadastro(); });
}

/* ============================================================================
   EXPORTACAO -- respeita filtros/busca/ordenacao ativos (mesma consulta da
   tabela, sem paginacao), com confirmacao da quantidade real antes de gerar
   o arquivo.
   ============================================================================ */
async function exportarCadastroXLSX() {
  if (typeof XLSX === "undefined") { toast("Biblioteca de exportacao nao carregou.", "error"); return; }
  if (connState !== "online") { toast("Cadastro indisponivel no momento.", "error"); return; }

  const btn = $("cadastro-exportar");
  const textoOriginal = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Buscando...";
  try {
    const linhas = await buscarTodosCadastroParaExportacao();
    btn.disabled = false;
    btn.textContent = textoOriginal;

    const confirmou = window.confirm(`${linhas.length} clientes serao exportados (filtros e ordenacao atuais aplicados). Continuar?`);
    if (!confirmou) return;

    const dados = linhas.map((c) => ({
      "Cliente": c.razao_social, "CNPJ": c.cnpj, "Porte": c.porte, "Gestor": c.gestor, "Vertical": c.vertical,
      "Municipio": c.municipio || "", "Status": c.status, "Prioritario": c.prioritario ? "Sim" : "Nao",
      "Inconsistente": c.inconsistente_geral ? "Sim" : "Nao", "Respondeu pesquisa": c.respondeu ? "Sim" : "Nao",
      "% Aumento de faturamento": c.aumento_faturamento_pct ?? "",
      "Data de inclusao": new Date(c.criado_em).toLocaleString("pt-BR"),
      "Ultima atualizacao": new Date(c.atualizado_em).toLocaleString("pt-BR"),
    }));

    const cabecalho = [
      ["Cadastro -- Jornada do Cliente -- Exportacao"],
      [`Gerado em: ${new Date().toLocaleString("pt-BR")}`],
      [`Filtros aplicados: ${descreverFiltrosAtivosCadastro().map((c) => c.label).join(" | ") || "Nenhum (base completa)"}`],
      [`Ordenado por: ${OPCOES_ORDENACAO.find((o) => o.value === cadastroOrdenarPor)?.label || cadastroOrdenarPor} (${cadastroOrdemAsc ? "ascendente" : "descendente"})`],
      [`Total exportado: ${dados.length}`],
      [],
    ];
    const ws = XLSX.utils.aoa_to_sheet(cabecalho);
    XLSX.utils.sheet_add_json(ws, dados, { origin: `A${cabecalho.length + 1}` });
    ws["!cols"] = [{ wch: 32 }, { wch: 18 }, { wch: 20 }, { wch: 20 }, { wch: 24 }, { wch: 18 }, { wch: 16 }, { wch: 11 }, { wch: 13 }, { wch: 16 }, { wch: 18 }, { wch: 18 }, { wch: 18 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Cadastro");
    const pad = (n) => String(n).padStart(2, "0");
    const d = new Date();
    XLSX.writeFile(wb, `Cadastro_JornadaCliente_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.xlsx`);
    toast(`${dados.length} clientes exportados.`, "success");
  } catch (err) {
    btn.disabled = false;
    btn.textContent = textoOriginal;
    console.error(err);
    toast("Nao foi possivel exportar agora.", "error");
  }
}

/* ============================================================================
   RENDER: tabela de clientes do Cadastro (pagina atual, ja filtrada/ordenada
   no banco) e atividade recente
   ============================================================================ */
function montarClientesSandbox(clientes, highlightId) {
  const tbody = document.querySelector("#table-demo-clientes tbody");
  const emptyState = $("demo-clientes-empty");
  tbody.innerHTML = "";

  if (!clientes.length) { emptyState.hidden = false; return; }
  emptyState.hidden = true;

  clientes.forEach((c) => {
    const tr = document.createElement("tr");
    tr.dataset.id = c.id;
    tr.appendChild(celula(c.razao_social));
    tr.appendChild(celula(c.porte));
    tr.appendChild(celula(c.gestor));
    tr.appendChild(celula(c.vertical));

    const tdStatus = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `badge badge-status-${String(c.status).toLowerCase().replace(/[^a-z]+/g, "-")}`;
    badge.textContent = c.status + (c.inconsistente_geral ? " ⚠" : "");
    tdStatus.appendChild(badge);
    tr.appendChild(tdStatus);

    const tdPrioridade = document.createElement("td");
    if (c.prioritario) {
      const badgePrio = document.createElement("span");
      badgePrio.className = "badge badge-insert";
      badgePrio.textContent = "Prioritario";
      tdPrioridade.appendChild(badgePrio);
    } else {
      tdPrioridade.textContent = "—";
      tdPrioridade.style.color = "var(--ink-3)";
    }
    tr.appendChild(tdPrioridade);

    const tdActions = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "row-actions";
    const btnHist = document.createElement("button");
    btnHist.type = "button"; btnHist.className = "btn-icon"; btnHist.textContent = "Historico";
    btnHist.addEventListener("click", () => abrirModalHistorico(c));
    const btnAtend = document.createElement("button");
    btnAtend.type = "button"; btnAtend.className = "btn-icon"; btnAtend.textContent = "Atendimentos";
    btnAtend.addEventListener("click", () => abrirModalAtendimento(c));
    const btnEdit = document.createElement("button");
    btnEdit.type = "button"; btnEdit.className = "btn-icon"; btnEdit.textContent = "Editar";
    btnEdit.addEventListener("click", () => abrirModalEditar(c));
    const btnDel = document.createElement("button");
    btnDel.type = "button"; btnDel.className = "btn-icon danger"; btnDel.textContent = "Excluir";
    btnDel.addEventListener("click", () => abrirModalExcluir(c));
    wrap.append(btnHist, btnAtend, btnEdit, btnDel);
    tdActions.appendChild(wrap);
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  });

  if (highlightId) {
    const row = tbody.querySelector(`tr[data-id="${highlightId}"]`);
    if (row) { row.classList.add("is-new"); setTimeout(() => row.classList.remove("is-new"), 1000); }
  }
}

function montarLogSandbox(logs) {
  const container = $("table-demo-log");
  const emptyState = $("demo-log-empty");
  container.innerHTML = "";

  if (!logs.length) { emptyState.hidden = false; return; }
  emptyState.hidden = true;

  const rotulo = { INSERT: "incluiu", UPDATE: "editou", DELETE: "excluiu", ATENDIMENTO: "atualizou atendimento de", IMPORT: "importou", RESTORE: "restaurou versao de" };
  const classeDot = { INSERT: "insert", UPDATE: "update", DELETE: "delete", ATENDIMENTO: "update", IMPORT: "insert", RESTORE: "update" };

  logs.forEach((l, i) => {
    const gestor = gestoresPorId.get(l.gestor_operador_id);
    const nomeGestor = gestor ? escapeHtml(gestor.nome) : `Gestor #${l.gestor_operador_id}`;
    const detalhe = l.campo
      ? `<div class="timeline-meta">${escapeHtml(rotularCampo(l.campo))}${l.valor_novo ? `: ${l.valor_antigo ? escapeHtml(l.valor_antigo) + " &rarr; " : ""}${escapeHtml(l.valor_novo)}` : ""}</div>`
      : "";
    const item = document.createElement("div");
    item.className = "timeline-item";
    item.innerHTML = `
      <span class="timeline-when" title="${new Date(l.criado_em).toLocaleString("pt-BR")}">${tempoRelativo(l.criado_em)}</span>
      <span class="timeline-dot-col"><span class="timeline-dot ${classeDot[l.operacao] || ""}"></span></span>
      <span class="timeline-body"><strong>${nomeGestor}</strong> ${rotulo[l.operacao] || l.operacao} um cliente${detalhe}</span>
    `;
    if (highlightFirstLog && i === 0) item.classList.add("is-new");
    container.appendChild(item);
  });
}

/* ============================================================================
   HISTORICO E VERSOES (por cliente) -- ETAPA 2
   ============================================================================ */
async function abrirModalHistorico(cliente) {
  clienteHistoricoAtual = cliente;
  $("historico-cliente-nome").textContent = cliente.razao_social;
  mostrarAbaHistorico("timeline");
  $("historico-timeline").innerHTML = `<p class="empty-state">Carregando...</p>`;
  $("historico-timeline-empty").hidden = true;
  $("historico-versoes-lista").innerHTML = "";
  $("historico-versoes-empty").hidden = true;
  $("historico-restaurar-diff").hidden = true;
  abrirModal("modal-historico");

  try {
    const [logRes, versoesRes] = await Promise.all([
      sb.from("demo_log").select("*").eq("cliente_id", cliente.id).order("criado_em", { ascending: false }),
      sb.from("demo_clientes_versoes").select("*").eq("cliente_id", cliente.id).order("versao", { ascending: false }),
    ]);
    if (logRes.error) throw logRes.error;
    if (versoesRes.error) throw versoesRes.error;
    renderizarHistoricoTimeline(logRes.data || []);
    versoesHistoricoAtual = versoesRes.data || [];
    renderizarHistoricoVersoes(versoesHistoricoAtual);
  } catch (err) {
    console.error(err);
    $("historico-timeline").innerHTML = `<p class="empty-state">Nao foi possivel carregar o historico deste cliente.</p>`;
  }
}

function mostrarAbaHistorico(aba) {
  document.querySelectorAll(".historico-tab").forEach((t) => t.classList.toggle("is-active", t.dataset.historicoTab === aba));
  $("historico-painel-timeline").hidden = aba !== "timeline";
  $("historico-painel-versoes").hidden = aba !== "versoes";
}

function rotularValorCampo(campo, valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  if (campo === "gestor_id") return gestoresPorId.get(Number(valor))?.nome || valor;
  if (["ali", "respondeu", "termo", "whatsapp_atualizado", "email_atualizado"].includes(campo)) {
    return valor === "true" || valor === true ? "Sim" : "Nao";
  }
  return valor;
}

function renderizarHistoricoTimeline(logs) {
  const container = $("historico-timeline");
  const empty = $("historico-timeline-empty");
  if (!logs.length) { container.innerHTML = ""; empty.hidden = false; return; }
  empty.hidden = true;

  const rotuloOp = { INSERT: "incluiu o cliente", UPDATE: "editou", DELETE: "excluiu o cliente", ATENDIMENTO: "atualizou atendimento", IMPORT: "importou o cliente", RESTORE: "restaurou uma versao" };
  const classeDot = { INSERT: "insert", UPDATE: "update", DELETE: "delete", ATENDIMENTO: "update", IMPORT: "insert", RESTORE: "update" };

  container.innerHTML = logs.map((l) => {
    const gestor = gestoresPorId.get(l.gestor_operador_id);
    const nomeGestor = gestor ? escapeHtml(gestor.nome) : `Gestor #${l.gestor_operador_id}`;
    const antigo = rotularValorCampo(l.campo, l.valor_antigo);
    const novo = rotularValorCampo(l.campo, l.valor_novo);
    const detalhe = l.campo
      ? `<div class="timeline-meta">${escapeHtml(rotularCampo(l.campo))}${novo !== null ? `: ${antigo !== null ? escapeHtml(String(antigo)) + " &rarr; " : ""}${escapeHtml(String(novo))}` : ""}</div>`
      : "";
    return `
      <div class="timeline-item">
        <span class="timeline-when" title="${new Date(l.criado_em).toLocaleString("pt-BR")}">${tempoRelativo(l.criado_em)}</span>
        <span class="timeline-dot-col"><span class="timeline-dot ${classeDot[l.operacao] || ""}"></span></span>
        <span class="timeline-body"><strong>${nomeGestor}</strong> ${rotuloOp[l.operacao] || l.operacao}${detalhe}</span>
      </div>`;
  }).join("");
}

function renderizarHistoricoVersoes(versoes) {
  const container = $("historico-versoes-lista");
  const empty = $("historico-versoes-empty");
  $("historico-restaurar-diff").hidden = true;
  if (!versoes.length) { container.innerHTML = ""; empty.hidden = false; return; }
  empty.hidden = true;

  const rotuloOp = { INSERT: "criacao", UPDATE: "edicao", RESTORE: "restauracao" };
  container.innerHTML = versoes.map((v, i) => {
    const gestor = gestoresPorId.get(v.gestor_operador_id);
    return `
      <div class="historico-versao-item ${i === 0 ? "is-atual" : ""}">
        <span class="historico-versao-meta">
          <strong>Versao ${v.versao}</strong>${i === 0 ? '<span class="historico-versao-tag">atual</span>' : ""}
          &middot; ${rotuloOp[v.operacao] || v.operacao} por ${gestor ? escapeHtml(gestor.nome) : `#${v.gestor_operador_id}`}
          &middot; ${new Date(v.criado_em).toLocaleString("pt-BR")}
        </span>
        ${i === 0 ? "" : `<button type="button" class="btn btn-ghost btn-sm" data-restaurar-versao="${v.id}">Restaurar esta versao</button>`}
      </div>`;
  }).join("");
}

function mostrarDiffRestauracao(versaoId) {
  const versao = versoesHistoricoAtual.find((v) => v.id === versaoId);
  if (!versao || !clienteHistoricoAtual) return;
  const atual = clienteHistoricoAtual;
  const snap = versao.snapshot;
  const campos = ["razao_social", "porte", "gestor_id", "municipio", "ali", "observacoes", "respondeu", "aumento_faturamento_pct"];

  const linhas = campos.filter((campo) => {
    const vAtual = campo === "gestor_id" ? atual.gestor_id : atual[campo];
    const vSnap = campo === "gestor_id" ? Number(snap.gestor_id) : snap[campo];
    return String(vAtual ?? "") !== String(vSnap ?? "");
  }).map((campo) => {
    let vAtualFmt = atual[campo];
    let vSnapFmt = snap[campo];
    if (campo === "gestor_id") {
      vAtualFmt = gestoresPorId.get(atual.gestor_id)?.nome || atual.gestor_id;
      vSnapFmt = gestoresPorId.get(Number(snap.gestor_id))?.nome || snap.gestor_id;
    } else if (campo === "ali" || campo === "respondeu") {
      vAtualFmt = vAtualFmt ? "Sim" : "Nao";
      vSnapFmt = vSnapFmt ? "Sim" : "Nao";
    }
    return `<div class="historico-diff-campo">
      <span class="nome">${rotularCampo(campo)}</span>
      <span class="atual">Atual: ${escapeHtml(vAtualFmt ?? "--")}</span>
      <span class="anterior">Nessa versao: ${escapeHtml(vSnapFmt ?? "--")}</span>
    </div>`;
  }).join("");

  $("historico-diff-campos").innerHTML = linhas || `<p class="empty-state">Nenhuma diferenca de campo detectada em relacao ao estado atual.</p>`;
  const diffEl = $("historico-restaurar-diff");
  diffEl.hidden = false;
  diffEl.dataset.versaoId = String(versaoId);
  diffEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function onConfirmarRestauracao() {
  const diffEl = $("historico-restaurar-diff");
  const versaoId = Number(diffEl.dataset.versaoId);
  if (!versaoId || !clienteHistoricoAtual) return;
  if (connState !== "online") { toast("Cadastro indisponivel no momento.", "error"); return; }

  const btn = $("historico-restaurar-confirmar");
  setButtonState(btn, "loading", { loadingLabel: "Restaurando..." });
  const clienteId = clienteHistoricoAtual.id;
  try {
    await restaurarVersaoDemo({ versaoId, operadorId: Number($("demo-gestor-atual").value) });
    setButtonState(btn, "default");
    toast("Versao restaurada -- uma nova versao foi criada no historico.", "success");
    fecharModal();
    await recarregarSandboxEAtualizarTudo({ highlightClienteId: clienteId, highlightLog: true });
  } catch (err) {
    setButtonState(btn, "default");
    tratarErroOperacao(err);
  }
}

/* ============================================================================
   PIPELINE CENTRAL -- unico caminho de atualizacao. Chamado sempre apos
   qualquer escrita com sucesso, e no load inicial. Nunca exige F5: recarrega
   a lista completa (KPIs/ranking/log/datalists) e a pagina atual da tabela.
   ============================================================================ */
async function recarregarSandboxEAtualizarTudo({ highlightClienteId, highlightLog } = {}) {
  setSyncStatus("updating");
  highlightFirstLog = !!highlightLog;
  try {
    await carregarSandboxCompleto();
    montarKpisSandbox(agregarResumoSandbox(sandboxClientes));
    montarRankingSandbox(sandboxClientes);
    montarLogSandbox(sandboxLogs);
    renderizarFiltrosAtivosCadastro();
    await atualizarTabelaCadastro();
    if (highlightClienteId) {
      const row = document.querySelector(`#table-demo-clientes tr[data-id="${highlightClienteId}"]`);
      if (row) { row.classList.add("is-new"); setTimeout(() => row.classList.remove("is-new"), 1000); }
    }
    ultimaSincronizacao = new Date();
    setSyncStatus("updated");
    atualizarUltimaAtualizacaoTexto();
  } catch (err) {
    setSyncStatus("error");
    throw err;
  }
}

/* ============================================================================
   VALIDACAO -- inclusao + deteccao de duplicidade (nao bloqueia, so avisa --
   quem decide se e duplicidade real e o gestor)
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

const verificarDuplicidadeInclusao = debounce(async () => {
  const aviso = $("cadastro-duplicidade-aviso");
  if (connState !== "online") { aviso.hidden = true; return; }

  const cnpjDigits = somenteDigitos($("demo-cnpj").value);
  const razao = $("demo-razao-social").value.trim();

  try {
    if (cnpjDigits.length === CNPJ_LEN) {
      const { data, error } = await sb.from("v_demo_clientes_completo")
        .select("razao_social,gestor,vertical,status,criado_em").eq("cnpj", cnpjDigits).limit(1);
      if (!error && data && data.length) {
        const c = data[0];
        aviso.dataset.nivel = "bloqueio";
        aviso.innerHTML = `<strong>Este cliente ja esta cadastrado.</strong><br>${escapeHtml(c.razao_social)} &mdash; gestor ${escapeHtml(c.gestor)} (${escapeHtml(c.vertical)}), status ${escapeHtml(c.status)}, incluido em ${new Date(c.criado_em).toLocaleDateString("pt-BR")}.`;
        aviso.hidden = false;
        return;
      }
    }
    if (razao.length >= 3) {
      const { data, error } = await sb.from("v_demo_clientes_completo")
        .select("razao_social,gestor,vertical").ilike("razao_social", razao).limit(1);
      if (!error && data && data.length) {
        const c = data[0];
        aviso.dataset.nivel = "aviso";
        aviso.innerHTML = `<strong>Cliente potencialmente duplicado.</strong><br>Ja existe "${escapeHtml(c.razao_social)}" com gestor ${escapeHtml(c.gestor)} (${escapeHtml(c.vertical)}) &mdash; confira antes de continuar.`;
        aviso.hidden = false;
        return;
      }
    }
    aviso.hidden = true;
  } catch (err) {
    console.error(err);
  }
}, 450);

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
  clienteParaAtendimento = null;
  clienteHistoricoAtual = null;
}

function onModalKeydown(e) {
  if (e.key === "Escape") { fecharModal(); return; }
  if (e.key !== "Tab") return;
  const dialog = document.querySelector(".modal-dialog:not([hidden])");
  if (!dialog) return;
  const focaveis = dialog.querySelectorAll('input, select, button, textarea, [tabindex]:not([tabindex="-1"])');
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

function abrirModalInfo(chave) {
  const textos = {
    total: "Total de clientes ativos no Cadastro (excluidos nao contam).",
    pj_distinto: "Clientes concluintes -- >=1 diagnostico valido + 2 assessorias validas, OU >=1 atendimento Sebraetec valido -- em pelo menos um Centro de Custo. Mesma regra de sql/queries.sql, calculada em v_demo_classificacao_cc.",
    inconsistente: "Clientes que seriam concluintes se os atendimentos lancados fossem validos, mas nao sao (dado invalido na fonte). Tratado separado da conclusao -- nunca reduz o PJ Distinto de outro cliente.",
    prioritario: "Calculado (nunca marcado manualmente): respondeu a pesquisa, informou aumento de faturamento, e AINDA NAO e Concluinte. Assim que completar a regra de conclusao, deixa de ser prioritario e passa a ser Concluinte. Ver docs/AUDITORIA_E_VERSIONAMENTO.md.",
    respondentes: "Clientes que responderam a pesquisa de acompanhamento (campo 'respondeu').",
    aumento: "Media do percentual de aumento de faturamento informado, calculada apenas entre quem respondeu a pesquisa.",
    gestores: "Numero de gestores distintos com pelo menos 1 cliente ativo no Cadastro.",
  };
  abrirModal("modal-info", { onOpen: () => { $("modal-info-texto").textContent = textos[chave] || "Sem descricao disponivel."; } });
}

function abrirModalEditar(cliente) {
  clienteEmEdicao = cliente;
  const gestor = gestoresPorId.get(cliente.gestor_id);
  abrirModal("modal-editar", {
    onOpen: () => {
      $("editar-razao-social").value = cliente.razao_social;
      $("editar-porte").value = cliente.porte;
      $("editar-municipio").value = cliente.municipio || "";
      $("editar-ali").checked = !!cliente.ali;
      $("editar-respondeu").checked = !!cliente.respondeu;
      $("editar-aumento").value = cliente.aumento_faturamento_pct ?? "";
      $("editar-aumento-wrap").hidden = !cliente.respondeu;
      $("editar-observacoes").value = cliente.observacoes || "";
      $("editar-gestor-input").value = gestor ? gestor.nome : "";
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

async function abrirModalAtendimento(cliente) {
  clienteParaAtendimento = cliente;
  $("atendimento-cliente-nome").textContent = `${cliente.razao_social} — ${cliente.status}${cliente.inconsistente_geral ? " (com inconsistencia)" : ""}`;
  $("atendimento-lista").innerHTML = `<p class="empty-state">Carregando...</p>`;
  abrirModal("modal-atendimento");
  try {
    const linhas = await carregarClassificacaoCC(cliente.id);
    renderizarListaAtendimento(cliente, linhas);
  } catch (err) {
    $("atendimento-lista").innerHTML = `<p class="empty-state">Nao foi possivel carregar os atendimentos.</p>`;
    console.error(err);
  }
}

function renderizarListaAtendimento(cliente, linhas) {
  const porCC = new Map(linhas.map((l) => [l.centro_custo_id, l]));
  const container = $("atendimento-lista");
  container.innerHTML = "";

  [...centrosCustoPorId.values()].forEach((cc) => {
    const atual = porCC.get(cc.id);
    const row = document.createElement("div");
    row.className = "atendimento-row";
    const statusTxt = atual ? (atual.concluinte ? "Concluinte" : atual.inconsistente ? "Inconsistente" : "Participante") : "Sem atendimento";
    const statusClasse = atual ? (atual.concluinte ? "badge-status-concluinte" : atual.inconsistente ? "badge-status-inconsistente" : "badge-status-participante") : "badge-status-sem-atendimento";

    row.innerHTML = `
      <div class="atendimento-row-head">
        <strong>${escapeHtml(cc.nome)}</strong>
        <span class="badge ${statusClasse}">${statusTxt}</span>
      </div>
      <div class="atendimento-inputs">
        ${cc.is_sebraetec ? `
          <label>Sebraetec validos <input type="number" min="0" max="20" class="at-sebraetec-validos" value="${atual?.sebraetec_validos ?? 0}"></label>
          <label>Sebraetec total <input type="number" min="0" max="20" class="at-sebraetec-total" value="${atual?.sebraetec_total ?? 0}"></label>
        ` : `
          <label>Diagnosticos validos <input type="number" min="0" max="20" class="at-diag-validos" value="${atual?.diagnosticos_validos ?? 0}"></label>
          <label>Diagnosticos total <input type="number" min="0" max="20" class="at-diag-total" value="${atual?.diagnosticos_total ?? 0}"></label>
          <label>Assessorias validas <input type="number" min="0" max="20" class="at-assess-validos" value="${atual?.assessorias_validos ?? 0}"></label>
          <label>Assessorias total <input type="number" min="0" max="20" class="at-assess-total" value="${atual?.assessorias_total ?? 0}"></label>
        `}
      </div>
      <button type="button" class="btn btn-ghost btn-sm at-salvar">
        <span class="btn-spinner" hidden></span><span class="btn-label">Salvar</span>
      </button>
    `;
    const btnSalvar = row.querySelector(".at-salvar");
    btnSalvar.addEventListener("click", () => onSalvarAtendimento(cliente, cc, row, btnSalvar));
    container.appendChild(row);
  });
}

async function onSalvarAtendimento(cliente, cc, row, btn) {
  const num = (sel) => Number(row.querySelector(sel)?.value || 0);
  const params = {
    clienteId: cliente.id, centroCustoId: cc.id, operadorId: Number($("demo-gestor-atual").value),
    diagnosticosTotal: cc.is_sebraetec ? 0 : num(".at-diag-total"),
    diagnosticosValidos: cc.is_sebraetec ? 0 : num(".at-diag-validos"),
    assessoriasTotal: cc.is_sebraetec ? 0 : num(".at-assess-total"),
    assessoriasValidos: cc.is_sebraetec ? 0 : num(".at-assess-validos"),
    sebraetecTotal: cc.is_sebraetec ? num(".at-sebraetec-total") : 0,
    sebraetecValidos: cc.is_sebraetec ? num(".at-sebraetec-validos") : 0,
  };
  setButtonState(btn, "loading", { loadingLabel: "Salvando..." });
  try {
    await definirAtendimentoDemo(params);
    await recarregarSandboxEAtualizarTudo({ highlightClienteId: cliente.id });
    const linhas = await carregarClassificacaoCC(cliente.id);
    renderizarListaAtendimento(cliente, linhas);
    toast("Atendimento atualizado -- classificacao recalculada no banco.", "success");
  } catch (err) {
    setButtonState(btn, "default");
    tratarErroOperacao(err);
  }
}

/* ============================================================================
   SUBMIT HANDLERS
   ============================================================================ */
function coletarExtraInclusao() {
  const respondeu = $("demo-respondeu").checked;
  return {
    municipio: $("demo-municipio").value.trim() || null,
    ali: $("demo-ali").checked,
    observacoes: $("demo-observacoes").value.trim() || null,
    respondeu,
    aumento_faturamento_pct: respondeu && $("demo-aumento").value !== "" ? Number($("demo-aumento").value) : null,
  };
}

async function onSubmitIncluir(e) {
  e.preventDefault();
  if (connState !== "online") { toast("Cadastro indisponivel no momento.", "error"); return; }
  if (!atualizarValidacaoInclusao()) return;

  const btn = $("demo-submit");
  setButtonState(btn, "loading", { loadingLabel: "Salvando..." });

  const gestorId = Number($("demo-gestor-atual").value);
  const razaoSocial = $("demo-razao-social").value.trim();
  const cnpj = somenteDigitos($("demo-cnpj").value);
  const porte = $("demo-porte").value;
  const extra = coletarExtraInclusao();

  try {
    const novoId = await incluirClienteDemo({ gestorId, razaoSocial, cnpj, porte, extra });
    setButtonState(btn, "success", { successLabel: "Cliente incluido" });
    toast("Cliente incluido no Cadastro.", "success");
    $("demo-razao-social").value = "";
    $("demo-cnpj").value = "";
    $("demo-porte").value = "MEI";
    $("demo-municipio").value = "";
    $("demo-ali").checked = false;
    $("demo-respondeu").checked = false;
    $("demo-aumento").value = "";
    $("demo-observacoes").value = "";
    $("demo-aumento-wrap").hidden = true;
    $("cadastro-duplicidade-aviso").hidden = true;
    await recarregarSandboxEAtualizarTudo({ highlightClienteId: novoId, highlightLog: true });
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
  if (connState !== "online") { toast("Cadastro indisponivel no momento.", "error"); return; }

  const novaRazao = $("editar-razao-social").value.trim();
  if (!novaRazao) { setFieldError("editar-razao-social", "erro-editar-razao-social", "Informe a razao social."); return; }
  if (novaRazao.length > RAZAO_MAX) { setFieldError("editar-razao-social", "erro-editar-razao-social", `Maximo de ${RAZAO_MAX} caracteres.`); return; }
  setFieldError("editar-razao-social", "erro-editar-razao-social", "");

  const respondeu = $("editar-respondeu").checked;
  const novosValores = {
    razao_social: novaRazao,
    porte: $("editar-porte").value,
    municipio: $("editar-municipio").value.trim() || null,
    ali: $("editar-ali").checked,
    observacoes: $("editar-observacoes").value.trim() || null,
    respondeu,
    aumento_faturamento_pct: respondeu && $("editar-aumento").value !== "" ? Number($("editar-aumento").value) : null,
  };

  const campos = {};
  Object.entries(novosValores).forEach(([chave, valor]) => {
    const original = clienteEmEdicao[chave] ?? null;
    const comparavel = valor === "" ? null : valor;
    if (String(original) !== String(comparavel)) campos[chave] = comparavel;
  });

  const nomeGestorDigitado = $("editar-gestor-input").value.trim().toLowerCase();
  const novoGestor = [...gestoresPorId.values()].find((g) => g.nome.toLowerCase() === nomeGestorDigitado);
  const reatribuir = novoGestor && novoGestor.gestor_id !== clienteEmEdicao.gestor_id ? novoGestor.gestor_id : null;

  if (!Object.keys(campos).length && !reatribuir) { fecharModal(); return; }

  const btn = $("editar-submit");
  setButtonState(btn, "loading", { loadingLabel: "Salvando..." });
  const operadorId = Number($("demo-gestor-atual").value);
  const idEditado = clienteEmEdicao.id;

  try {
    if (Object.keys(campos).length) await editarClienteDemo({ clienteId: idEditado, operadorId, campos });
    if (reatribuir) await reatribuirGestorDemo({ clienteId: idEditado, operadorId, novoGestorId: reatribuir });
    setButtonState(btn, "success", { successLabel: "Salvo" });
    toast(reatribuir ? "Alteracoes salvas -- gestor reatribuido." : "Alteracao salva.", "success");
    setTimeout(async () => {
      fecharModal();
      await recarregarSandboxEAtualizarTudo({ highlightClienteId: idEditado, highlightLog: true });
    }, 500);
  } catch (err) {
    setButtonState(btn, "default");
    tratarErroOperacao(err);
  }
}

async function onClickExcluir() {
  if (!clienteParaExcluir) return;
  if (connState !== "online") { toast("Cadastro indisponivel no momento.", "error"); return; }

  const btn = $("excluir-confirmar");
  setButtonState(btn, "loading", { loadingLabel: "Excluindo..." });
  const operadorId = Number($("demo-gestor-atual").value);

  try {
    await excluirClienteDemo({ clienteId: clienteParaExcluir.id, operadorId });
    setButtonState(btn, "success", { successLabel: "Excluido" });
    toast("Cliente removido do Cadastro.", "success");
    setTimeout(async () => {
      fecharModal();
      await recarregarSandboxEAtualizarTudo({ highlightLog: true });
    }, 500);
  } catch (err) {
    setButtonState(btn, "default");
    tratarErroOperacao(err);
  }
}

/* ============================================================================
   IMPORTACAO EM MASSA (XLSX) -- reaproveita a MESMA RPC demo_incluir_cliente
   (mesma validacao/limite/permissao de uma inclusao manual), so em lote.
   ============================================================================ */
let importacaoValidada = [];

function baixarModeloXLSX() {
  if (typeof XLSX === "undefined") { toast("Biblioteca de exportacao nao carregou.", "error"); return; }

  const listaGestores = gestoresPorId.size
    ? [...gestoresPorId.values()].map((g) => [`  ${g.nome} (${g.vertical})`])
    : [["  (conecte-se ao Cadastro para ver a lista atualizada de gestores)"]];

  const instrucoes = [
    ["Modelo de importacao -- Cadastro Jornada do Cliente"],
    [],
    ["Preencha a aba 'Clientes' abaixo e depois use o botao 'Importar XLSX' no site."],
    [],
    ["Campos obrigatorios:"],
    ["  Gestor -- nome exato de um dos gestores do Cadastro (lista abaixo)"],
    ["  Razao Social"],
    ["  CNPJ -- 14 digitos (com ou sem pontuacao)"],
    ["  Porte -- MEI, ME, EPP, MEDIA ou GRANDE"],
    [],
    ["Campos opcionais:"],
    ["  Municipio, Observacoes"],
    ["  ALI, Pesquisa respondida -- preencher com Sim ou Nao (em branco = Nao)"],
    ["  % Aumento de faturamento -- numero; so e gravado se 'Pesquisa respondida' = Sim"],
    [],
    ["Gestores disponiveis:"],
    ...listaGestores,
    [],
    ["Campos calculados automaticamente pelo sistema (nao preencher aqui):"],
    ["  Status, PJ Distinto, Inconsistencias -- dependem dos Atendimentos por Centro de Custo,"],
    ["  que sao definidos depois da importacao, cliente por cliente, no botao 'Atendimentos'."],
    ["  Prioridade -- calculada automaticamente (aumento de faturamento informado e ainda nao Concluinte)."],
    [],
    ["Outros campos do cadastro (CPF, Celular, Termo, WhatsApp/E-mail atualizado, Data da"],
    ["pesquisa) existem no sistema mas nao fazem parte deste modelo de importacao em massa --"],
    ["podem ser preenchidos depois, cliente por cliente, no botao 'Editar'."],
  ];
  const wsInstrucoes = XLSX.utils.aoa_to_sheet(instrucoes);
  wsInstrucoes["!cols"] = [{ wch: 92 }];

  const exemplo = [{
    "Gestor": gestoresPorId.size ? [...gestoresPorId.values()][0].nome : "Ana Souza",
    "Razao Social": "Comercial Exemplo Ltda",
    "CNPJ": "12345678000199",
    "Porte": "ME",
    "Municipio": "Sao Paulo",
    "ALI": "Nao",
    "Pesquisa respondida": "Sim",
    "% Aumento de faturamento": 15.5,
    "Observacoes": "",
  }];
  const wsClientes = XLSX.utils.json_to_sheet(exemplo);
  wsClientes["!cols"] = [{ wch: 20 }, { wch: 30 }, { wch: 18 }, { wch: 8 }, { wch: 18 }, { wch: 8 }, { wch: 18 }, { wch: 22 }, { wch: 30 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsInstrucoes, "Instrucoes");
  XLSX.utils.book_append_sheet(wb, wsClientes, "Clientes");
  XLSX.writeFile(wb, "JornadaCliente_Modelo_Importacao.xlsx");
}

function normalizarBooleanoImportacao(v) {
  return ["sim", "s", "true", "1", "yes"].includes(String(v).trim().toLowerCase());
}

function acharColuna(linha, ...nomes) {
  const chaves = Object.keys(linha);
  for (const nome of nomes) {
    const achado = chaves.find((k) => k.trim().toLowerCase() === nome.toLowerCase());
    if (achado !== undefined) return linha[achado];
  }
  return "";
}

function processarImportacao(linhasBrutas) {
  const cnpjsNoArquivo = new Set();
  const cnpjsExistentes = new Set(sandboxClientes.map((c) => somenteDigitos(c.cnpj)));

  const resultado = linhasBrutas.map((linha, i) => {
    const numeroLinha = i + 2;
    const gestorNome = String(acharColuna(linha, "Gestor")).trim();
    const razaoSocial = String(acharColuna(linha, "Razao Social", "Razão Social", "Nome")).trim();
    const cnpjDigits = somenteDigitos(String(acharColuna(linha, "CNPJ")));
    const porte = String(acharColuna(linha, "Porte")).trim().toUpperCase();
    const municipio = String(acharColuna(linha, "Municipio", "Município")).trim();
    const observacoes = String(acharColuna(linha, "Observacoes", "Observações")).trim();
    const ali = normalizarBooleanoImportacao(acharColuna(linha, "ALI"));
    const respondeu = normalizarBooleanoImportacao(acharColuna(linha, "Pesquisa respondida"));
    const aumentoRaw = acharColuna(linha, "% Aumento de faturamento", "% Aumento");
    const aumento = aumentoRaw === "" ? null : Number(aumentoRaw);

    const erros = [];
    const gestor = [...gestoresPorId.values()].find((g) => g.nome.toLowerCase() === gestorNome.toLowerCase());
    if (!gestorNome) erros.push("Gestor obrigatorio");
    else if (!gestor) erros.push(`Gestor "${gestorNome}" nao encontrado`);
    if (!razaoSocial) erros.push("Razao social obrigatoria");
    if (!cnpjDigits || cnpjDigits.length !== CNPJ_LEN) erros.push("CNPJ invalido (14 digitos)");
    if (!["MEI", "ME", "EPP", "MEDIA", "GRANDE"].includes(porte)) erros.push("Porte invalido");

    let duplicado = false;
    if (cnpjDigits && cnpjDigits.length === CNPJ_LEN) {
      if (cnpjsExistentes.has(cnpjDigits) || cnpjsNoArquivo.has(cnpjDigits)) { duplicado = true; erros.push("CNPJ duplicado"); }
      else cnpjsNoArquivo.add(cnpjDigits);
    }

    return {
      linha: numeroLinha, razaoSocial, cnpjDigits, porte, gestorId: gestor?.gestor_id, gestorNome,
      municipio, observacoes, ali, respondeu, aumento,
      valido: erros.length === 0, duplicado, erros,
    };
  });

  importacaoValidada = resultado;
  renderizarPreviewImportacao(resultado);
  abrirModal("modal-importar");
}

function renderizarPreviewImportacao(resultado) {
  const validos = resultado.filter((r) => r.valido);
  const duplicados = resultado.filter((r) => r.duplicado);
  const invalidos = resultado.filter((r) => !r.valido && !r.duplicado);

  $("importar-resumo").innerHTML = `
    <div class="importar-resumo-contagem">
      <span><strong>${validos.length}</strong> validos</span>
      <span><strong>${invalidos.length}</strong> invalidos</span>
      <span><strong>${duplicados.length}</strong> duplicados</span>
      <span>Total no arquivo: <strong>${resultado.length}</strong></span>
    </div>
  `;

  $("importar-erros").innerHTML = resultado.filter((r) => !r.valido).map((r) => `
    <div class="importar-erro-item"><strong>Linha ${r.linha}</strong> &mdash; ${escapeHtml(r.erros.join("; "))}</div>
  `).join("");

  document.querySelector("#importar-preview-tabela tbody").innerHTML = resultado.map((r) => `
    <tr>
      <td>${r.linha}</td>
      <td>${escapeHtml(r.razaoSocial || "--")}</td>
      <td>${escapeHtml(r.cnpjDigits || "--")}</td>
      <td>${escapeHtml(r.gestorNome || "--")}</td>
      <td>${r.valido ? '<span class="badge badge-insert">Valido</span>' : `<span class="badge badge-delete">${r.duplicado ? "Duplicado" : "Invalido"}</span>`}</td>
    </tr>
  `).join("");

  const btn = $("importar-confirmar");
  btn.disabled = validos.length === 0;
  setButtonState(btn, "default", { defaultLabel: `Confirmar importacao (${validos.length})` });
}

async function onArquivoImportacaoSelecionado(e) {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (typeof XLSX === "undefined") { toast("Biblioteca de importacao nao carregou.", "error"); return; }

  try {
    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(buffer, { type: "array" });
    const nomeAba = wb.SheetNames.find((n) => n.toLowerCase().includes("cliente")) || wb.SheetNames[0];
    const linhasBrutas = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { defval: "" });
    if (!linhasBrutas.length) { toast("O arquivo nao tem linhas de clientes.", "error"); return; }
    processarImportacao(linhasBrutas);
  } catch (err) {
    console.error(err);
    toast("Nao foi possivel ler o arquivo XLSX.", "error");
  }
}

async function onConfirmarImportacao() {
  const validos = importacaoValidada.filter((r) => r.valido);
  if (!validos.length) return;
  if (connState !== "online") { toast("Cadastro indisponivel no momento.", "error"); return; }

  const btn = $("importar-confirmar");
  setButtonState(btn, "loading", { loadingLabel: `Importando 0/${validos.length}...` });

  let sucesso = 0, falha = 0;
  const falhas = [];
  for (let i = 0; i < validos.length; i++) {
    const r = validos[i];
    btn.querySelector(".btn-label").textContent = `Importando ${i + 1}/${validos.length}...`;
    try {
      await incluirClienteDemo({
        gestorId: r.gestorId, razaoSocial: r.razaoSocial, cnpj: r.cnpjDigits, porte: r.porte,
        extra: {
          municipio: r.municipio || null, ali: r.ali,
          observacoes: r.observacoes || null, respondeu: r.respondeu,
          aumento_faturamento_pct: r.respondeu ? r.aumento : null,
        },
      });
      sucesso++;
    } catch (err) {
      falha++;
      falhas.push(`Linha ${r.linha}: ${err?.message || "erro desconhecido"}`);
    }
  }

  setButtonState(btn, "default", { defaultLabel: "Confirmar importacao" });
  await recarregarSandboxEAtualizarTudo({ highlightLog: true });
  fecharModal();

  if (falha === 0) toast(`${sucesso} clientes importados com sucesso.`, "success");
  else toast(`${sucesso} importados, ${falha} falharam (${falhas[0]}).`, "error");
}

/* ============================================================================
   WIRING ESTATICO -- roda sempre, mesmo se a conexao com o Supabase falhar
   ============================================================================ */
function wireEstatico() {
  $("demo-cnpj").addEventListener("input", () => {
    $("demo-cnpj").value = formatarCNPJ(somenteDigitos($("demo-cnpj").value));
    atualizarValidacaoInclusao();
    verificarDuplicidadeInclusao();
  });
  $("demo-razao-social").addEventListener("input", () => {
    atualizarValidacaoInclusao();
    verificarDuplicidadeInclusao();
  });
  $("demo-gestor-atual").addEventListener("change", atualizarOperador);
  $("demo-respondeu").addEventListener("change", () => { $("demo-aumento-wrap").hidden = !$("demo-respondeu").checked; });
  $("demo-form").addEventListener("submit", onSubmitIncluir);

  $("editar-razao-social").addEventListener("input", () => {
    const ok = $("editar-razao-social").value.trim().length > 0;
    setFieldError("editar-razao-social", "erro-editar-razao-social", ok ? "" : "Informe a razao social.");
  });
  $("editar-respondeu").addEventListener("change", () => { $("editar-aumento-wrap").hidden = !$("editar-respondeu").checked; });
  $("form-editar").addEventListener("submit", onSubmitEditar);
  $("excluir-confirmar").addEventListener("click", onClickExcluir);
  $("editar-ver-historico").addEventListener("click", () => {
    if (clienteEmEdicao) abrirModalHistorico(clienteEmEdicao);
  });

  document.querySelectorAll("[data-modal-close]").forEach((b) => b.addEventListener("click", fecharModal));
  $("modal-overlay").addEventListener("click", (e) => { if (e.target === $("modal-overlay")) fecharModal(); });

  $("conn-retry").addEventListener("click", tentarConectar);

  $("sandbox-baixar-modelo").addEventListener("click", baixarModeloXLSX);
  $("sandbox-importar-abrir").addEventListener("click", () => $("sandbox-importar-arquivo").click());
  $("sandbox-importar-arquivo").addEventListener("change", onArquivoImportacaoSelecionado);
  $("importar-confirmar").addEventListener("click", onConfirmarImportacao);
  $("cadastro-exportar").addEventListener("click", exportarCadastroXLSX);

  $("sandbox-ranking-criterio").addEventListener("change", (e) => {
    criterioRanking = e.target.value;
    montarRankingSandbox(sandboxClientes);
  });

  $("sandbox-ranking").addEventListener("click", (e) => {
    const row = e.target.closest(".ranking-row[data-gestor-id]");
    if (row) definirFiltroGestorPorId(Number(row.dataset.gestorId));
  });
  $("sandbox-ranking").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest(".ranking-row[data-gestor-id]");
    if (row) { e.preventDefault(); definirFiltroGestorPorId(Number(row.dataset.gestorId)); }
  });

  // Filtros do Cadastro
  $("cadastro-filter-clear").addEventListener("click", limparFiltrosCadastro);
  $("cadastro-chips-extra").addEventListener("click", (e) => {
    const btn = e.target.closest(".chip[data-extra]");
    if (btn) toggleFiltroExtraCadastro(btn.dataset.extra);
  });
  $("cadastro-filtro-gestor").addEventListener("input", debounce((e) => definirFiltroGestorPorNome(e.target.value), 300));
  $("cadastro-filtro-municipio").addEventListener("input", debounce((e) => definirFiltroMunicipio(e.target.value), 300));
  $("cadastro-filtros-ativos-lista").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip-removivel");
    if (chip && e.target.tagName === "BUTTON") removerFiltroChipCadastro(chip.dataset.tipo, chip.dataset.valor);
  });

  $("cadastro-busca").addEventListener("input", debounce((e) => {
    cadastroBusca = e.target.value.trim();
    cadastroPagina = 1;
    aplicarFiltrosCadastro();
  }, 300));

  $("cadastro-ordenar-por").addEventListener("change", (e) => {
    cadastroOrdenarPor = e.target.value;
    cadastroPagina = 1;
    atualizarTabelaCadastro();
  });
  $("cadastro-ordem-toggle").addEventListener("click", (e) => {
    cadastroOrdemAsc = !cadastroOrdemAsc;
    e.target.dataset.asc = String(cadastroOrdemAsc);
    e.target.textContent = cadastroOrdemAsc ? "↑ Ascendente" : "↓ Descendente";
    cadastroPagina = 1;
    atualizarTabelaCadastro();
  });

  // Historico e versoes
  document.querySelectorAll(".historico-tab").forEach((tab) => {
    tab.addEventListener("click", () => mostrarAbaHistorico(tab.dataset.historicoTab));
  });
  $("historico-versoes-lista").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-restaurar-versao]");
    if (btn) mostrarDiffRestauracao(Number(btn.dataset.restaurarVersao));
  });
  $("historico-restaurar-cancelar").addEventListener("click", () => { $("historico-restaurar-diff").hidden = true; });
  $("historico-restaurar-confirmar").addEventListener("click", onConfirmarRestauracao);

  document.querySelectorAll(".sandbox-kpi[data-kpi]").forEach((tile) => {
    const chave = tile.dataset.kpi;
    const acao = {
      pj_distinto: () => { cadastroFiltros.status = new Set(["Concluinte"]); cadastroPagina = 1; aplicarFiltrosCadastro(); },
      inconsistente: () => { cadastroFiltros.inconsistente = true; cadastroPagina = 1; aplicarFiltrosCadastro(); },
      prioritario: () => { cadastroFiltros.prioritario = true; cadastroPagina = 1; aplicarFiltrosCadastro(); },
      respondentes: () => { cadastroFiltros.respondeu = true; cadastroPagina = 1; aplicarFiltrosCadastro(); },
    }[chave];
    if (!acao) return;
    tile.classList.add("is-clickable");
    tile.addEventListener("click", (e) => {
      if (e.target.closest(".kpi-info")) return;
      acao();
      $("cadastro-filter-bar").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  document.querySelectorAll(".kpi-info").forEach((btn) => {
    btn.addEventListener("click", (e) => { e.stopPropagation(); abrirModalInfo(btn.dataset.info); });
  });

  ["demo-submit", "editar-submit", "excluir-confirmar"].forEach((id) => {
    const btn = $(id);
    btn.dataset.defaultLabel = btn.querySelector(".btn-label").textContent;
  });

  atualizarValidacaoInclusao();
}

function initDemo() {
  wireEstatico();
  if (!sb) {
    mostrarIndisponivel();
    setConnStatus("offline");
    setSyncStatus("error");
    toast("Biblioteca do Supabase nao carregou.", "error");
    return;
  }
  tentarConectar();
}

initDemo();
