// Preencher com o link de embed do Power BI ("Publicar na Web") quando disponivel.
// Ver powerbi/modelo_de_dados_e_dax.md -> secao "Publicar na Web".
const POWERBI_EMBED_URL = "";

const fmtInt = (n) => new Intl.NumberFormat("pt-BR").format(n);
const fmtPct = (n) => (n === null || n === undefined ? "--" : `${n.toString().replace(".", ",")}%`);
const prefersReducedMotion = () =>
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

async function carregarJSON(caminho) {
  const resp = await fetch(caminho);
  if (!resp.ok) throw new Error(`Falha ao carregar ${caminho}: ${resp.status}`);
  return resp.json();
}

/* ============================================================================
   ANIMACAO: reveal-on-scroll + count-up + crescimento de barras.
   Puramente apresentacao -- nao interfere nos dados/calculo, so anima a
   entrada de valores ja calculados pelas funcoes de montagem abaixo.
   ============================================================================ */
function fmtNumberBR(n, decimals) {
  return n.toLocaleString("pt-BR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function countUp(el, endValue, { decimals = 0, suffix = "", duration = 1000 } = {}) {
  if (prefersReducedMotion()) {
    el.textContent = fmtNumberBR(endValue, decimals) + suffix;
    return;
  }
  const start = performance.now();
  function tick(now) {
    const p = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = fmtNumberBR(endValue * eased, decimals) + suffix;
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function isRevealed(el) {
  const container = el.closest("[data-reveal]");
  return !!container && container.classList.contains("is-visible");
}

function activateCountUp(el) {
  if (el.dataset.animated === "1") return;
  el.dataset.animated = "1";
  const target = Number(el.dataset.countup);
  if (Number.isNaN(target)) return;
  countUp(el, target, { decimals: Number(el.dataset.decimals || 0), suffix: el.dataset.suffix || "" });
}

function setCountTarget(el, value, { decimals = 0, suffix = "" } = {}) {
  if (!el) return;
  if (value === null || value === undefined) { el.textContent = "--"; return; }
  el.dataset.countup = String(value);
  el.dataset.decimals = String(decimals);
  el.dataset.suffix = suffix;
  el.dataset.animated = "";
  if (isRevealed(el)) activateCountUp(el);
}

function growBarsWithin(container) {
  container.querySelectorAll(".bar-fill[data-final], .stacked-seg[data-final]").forEach((el) => {
    if (prefersReducedMotion()) { el.style.width = el.dataset.final; return; }
    requestAnimationFrame(() => { el.style.width = el.dataset.final; });
  });
}

function activateAnimations(container) {
  container.querySelectorAll("[data-countup]").forEach(activateCountUp);
  growBarsWithin(container);
}

function initReveal() {
  const els = document.querySelectorAll("[data-reveal]");
  if (!("IntersectionObserver" in window) || prefersReducedMotion()) {
    els.forEach((el) => { el.classList.add("is-visible"); activateAnimations(el); });
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-visible");
      activateAnimations(entry.target);
      io.unobserve(entry.target);
    });
  }, { threshold: 0.15 });
  els.forEach((el) => io.observe(el));
}

function initHeaderScroll() {
  const header = document.getElementById("site-header");
  if (!header) return;
  const onScroll = () => header.classList.toggle("is-scrolled", window.scrollY > 8);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

initReveal();
initHeaderScroll();

/* ============================================================================
   ESTADO DO DASHBOARD -- fonte unica de verdade: os 2500 clientes ja
   carregados (web/data/clientes.json). KPIs/graficos/ranking/tabela sao
   recalculados em JS a partir do subconjunto filtrado -- nenhuma logica de
   negocio nova, so agregacao (soma/media/contagem) de campos que as views
   SQL do pipeline ja calcularam por cliente.
   ============================================================================ */
const PORTE_ORDEM = ["MEI", "ME", "EPP", "MEDIA", "GRANDE"];
const CLIENTES_POR_PAGINA = 25;

const dashState = {
  todos: [],
  filtros: { vertical: new Set(), status: new Set(), porte: new Set(), gestor: null },
};

const tabelaState = { filtrados: [], pagina: 1 };

function round1(n) { return Math.round(n * 10) / 10; }

function converterClientesColunar(payload) {
  const { colunas, linhas } = payload;
  return linhas.map((linha) => Object.fromEntries(colunas.map((col, i) => [col, linha[i]])));
}

function normalizarCliente(c) {
  return {
    ...c,
    pj_distinto_oficial: Number(c.pj_distinto_oficial) || 0,
    qtd_planos_inconsistentes: Number(c.qtd_planos_inconsistentes) || 0,
    respondeu: Number(c.respondeu) || 0,
    aumento_faturamento_pct: c.aumento_faturamento_pct === "" || c.aumento_faturamento_pct == null
      ? null : Number(c.aumento_faturamento_pct),
  };
}

/* ============================================================================
   AGREGACAO -- funcoes puras sobre um array de clientes ja filtrado
   ============================================================================ */
function agregarResumo(clientes) {
  const total = clientes.length;
  const pj = clientes.reduce((s, c) => s + c.pj_distinto_oficial, 0);
  const inconsist = clientes.reduce((s, c) => s + c.qtd_planos_inconsistentes, 0);
  const respondentes = clientes.filter((c) => c.respondeu === 1);
  const aumentos = respondentes.map((c) => c.aumento_faturamento_pct).filter((v) => v !== null);
  const statusContagem = {};
  clientes.forEach((c) => { statusContagem[c.status] = (statusContagem[c.status] || 0) + 1; });

  return {
    total_clientes: total,
    pj_distintos: pj,
    pct_pj_distintos: total ? round1((100 * pj) / total) : 0,
    total_inconsistencias: inconsist,
    pct_respondentes: total ? round1((100 * respondentes.length) / total) : 0,
    media_aumento_faturamento_pct: aumentos.length ? round1(aumentos.reduce((a, b) => a + b, 0) / aumentos.length) : null,
    status_contagem: statusContagem,
  };
}

function agregarPorVertical(clientes) {
  const grupos = new Map();
  clientes.forEach((c) => {
    if (!grupos.has(c.vertical)) grupos.set(c.vertical, []);
    grupos.get(c.vertical).push(c);
  });
  return [...grupos.entries()].map(([vertical, lista]) => {
    const r = agregarResumo(lista);
    return {
      vertical, clientes_na_carteira: r.total_clientes, pj_distintos: r.pj_distintos,
      total_inconsistencias: r.total_inconsistencias, pct_respondeu: r.pct_respondentes,
    };
  });
}

function agregarPorGestor(clientes) {
  const grupos = new Map();
  clientes.forEach((c) => {
    if (!grupos.has(c.gestor)) grupos.set(c.gestor, { vertical: c.vertical, lista: [] });
    grupos.get(c.gestor).lista.push(c);
  });
  return [...grupos.entries()].map(([gestor, { vertical, lista }]) => {
    const r = agregarResumo(lista);
    return {
      gestor, vertical, clientes_na_carteira: r.total_clientes, pj_distintos: r.pj_distintos,
      total_inconsistencias: r.total_inconsistencias, pct_respondeu: r.pct_respondentes,
    };
  });
}

function agregarFaturamentoPorPorte(clientes) {
  return PORTE_ORDEM.map((porte) => {
    const grupo = clientes.filter((c) => c.porte === porte);
    const aumentos = grupo.filter((c) => c.respondeu === 1 && c.aumento_faturamento_pct !== null).map((c) => c.aumento_faturamento_pct);
    return {
      porte,
      clientes: grupo.length,
      media_aumento: aumentos.length ? round1(aumentos.reduce((a, b) => a + b, 0) / aumentos.length) : null,
    };
  }).filter((d) => d.clientes > 0);
}

/* ============================================================================
   KPIs
   ============================================================================ */
function montarKPIs(resumo) {
  setCountTarget(document.getElementById("kpi-total-clientes"), resumo.total_clientes);
  setCountTarget(document.getElementById("kpi-pj-distintos"), resumo.pj_distintos);

  const secundarios = [
    ["% PJ Distintos", resumo.pct_pj_distintos, 1, "%"],
    ["Inconsistencias", resumo.total_inconsistencias, 0, ""],
    ["% Respondentes da pesquisa", resumo.pct_respondentes, 1, "%"],
    ["Aumento medio de faturamento", resumo.media_aumento_faturamento_pct, 1, "%"],
  ];
  const row = document.getElementById("kpi-row");
  row.innerHTML = secundarios.map(([label], i) => `
    <div class="stat-tile">
      <span class="stat-label">${label}</span>
      <span class="stat-value" id="kpi-sec-${i}">0</span>
    </div>
  `).join("");
  secundarios.forEach(([, value, decimals, suffix], i) => {
    setCountTarget(document.getElementById(`kpi-sec-${i}`), value, { decimals, suffix });
  });
}

/* ============================================================================
   GRAFICO: PJ Distintos por vertical (clicavel -> filtra por vertical)
   ============================================================================ */
function montarBarChartVertical(dados) {
  const chart = document.getElementById("chart-vertical");
  const tableWrap = document.getElementById("table-vertical");

  if (!dados.length) {
    chart.innerHTML = `<p class="empty-state">Nenhum cliente para os filtros selecionados.</p>`;
    tableWrap.innerHTML = "";
    return;
  }

  const ordenado = [...dados].sort((a, b) => b.pj_distintos - a.pj_distintos);
  const max = Math.max(...ordenado.map((d) => d.pj_distintos), 1);

  chart.innerHTML = ordenado.map((d) => `
    <div class="bar-row" data-vertical="${d.vertical}" tabindex="0" role="button" aria-pressed="false" title="Filtrar por ${d.vertical}">
      <span class="bar-label">${d.vertical}</span>
      <div class="bar-track"><div class="bar-fill" data-final="${(d.pj_distintos / max) * 100}%" style="width:0%"></div></div>
      <span class="bar-value">${fmtInt(d.pj_distintos)}</span>
    </div>
  `).join("");

  tableWrap.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Vertical</th><th class="num">Clientes</th><th class="num">PJ Distintos</th><th class="num">Inconsistencias</th><th class="num">% Respondentes</th></tr></thead>
      <tbody>
        ${ordenado.map((d) => `
          <tr>
            <td>${d.vertical}</td>
            <td class="num">${fmtInt(d.clientes_na_carteira)}</td>
            <td class="num">${fmtInt(d.pj_distintos)}</td>
            <td class="num">${fmtInt(d.total_inconsistencias)}</td>
            <td class="num">${fmtPct(d.pct_respondeu)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  if (isRevealed(chart)) growBarsWithin(chart.closest("[data-reveal]"));
}

/* ============================================================================
   GRAFICO: status
   ============================================================================ */
function montarStatusChart(resumo) {
  const ordem = [
    { chave: "Concluinte", cor: "var(--good)" },
    { chave: "Participante", cor: "var(--ink-2)" },
    { chave: "Sem atendimento", cor: "var(--warn)" },
  ];
  const total = Object.values(resumo.status_contagem).reduce((a, b) => a + b, 0);
  const track = document.getElementById("chart-status");
  const legend = document.getElementById("legend-status");

  if (!total) {
    track.innerHTML = `<p class="empty-state">Nenhum cliente para os filtros selecionados.</p>`;
    legend.innerHTML = "";
    return;
  }

  track.innerHTML = `<div class="stacked-track">${
    ordem.map((o) => {
      const qtd = resumo.status_contagem[o.chave] || 0;
      const pct = (qtd / total) * 100;
      if (pct === 0) return "";
      return `<div class="stacked-seg" data-final="${pct}%" style="width:0%;background:${o.cor}" title="${o.chave}: ${qtd}"></div>`;
    }).join("")
  }</div>`;

  legend.innerHTML = ordem.map((o) => {
    const qtd = resumo.status_contagem[o.chave] || 0;
    const pct = ((qtd / total) * 100).toFixed(1).replace(".", ",");
    return `<li><span class="swatch" style="background:${o.cor}"></span>${o.chave} &middot; ${fmtInt(qtd)} (${pct}%)</li>`;
  }).join("");

  if (isRevealed(track)) growBarsWithin(track.closest("[data-reveal]"));
}

/* ============================================================================
   GRAFICO: aumento medio de faturamento por porte
   ============================================================================ */
function montarFaturamentoPorte(dados) {
  const card = document.getElementById("chart-faturamento");
  if (!dados.length) {
    card.innerHTML = `<p class="empty-state">Nenhum cliente para os filtros selecionados.</p>`;
    return;
  }
  const max = Math.max(...dados.map((d) => d.media_aumento || 0), 1);
  card.innerHTML = dados.map((d) => `
    <div class="bar-row">
      <span class="bar-label">${d.porte}</span>
      <div class="bar-track"><div class="bar-fill" data-final="${d.media_aumento ? (d.media_aumento / max) * 100 : 0}%" style="width:0%"></div></div>
      <span class="bar-value">${d.media_aumento !== null ? fmtPct(d.media_aumento) : "sem dados"}</span>
    </div>
  `).join("");
  if (isRevealed(card)) growBarsWithin(card.closest("[data-reveal]"));
}

/* ============================================================================
   RANKING DE GESTORES (podio top-3 + tabela completa, clicavel -> drill-down)
   ============================================================================ */
function montarPodioGestores(dados) {
  const podium = document.getElementById("podium-gestores");
  const top3 = dados.slice(0, 3);
  podium.innerHTML = top3.map((g, i) => `
    <div class="podium-card rank-${i + 1}" data-gestor="${g.gestor}" tabindex="0" role="button" title="Filtrar pela carteira de ${g.gestor}">
      <p class="podium-rank"><span class="n">${i + 1}&ordm;</span> lugar</p>
      <p class="podium-name">${g.gestor}</p>
      <p class="podium-vertical">${g.vertical}</p>
      <p class="podium-value">${fmtInt(g.pj_distintos)}</p>
      <p class="podium-value-label">PJ Distintos</p>
    </div>
  `).join("");
}

function montarTabelaGestores(dados) {
  const podium = document.getElementById("podium-gestores");
  const tbody = document.querySelector("#table-gestores tbody");

  if (!dados.length) {
    podium.innerHTML = `<p class="empty-state">Nenhum gestor para os filtros selecionados.</p>`;
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--ink-3)">Nenhum gestor para os filtros selecionados.</td></tr>`;
    return;
  }

  const ordenado = [...dados].sort((a, b) => b.pj_distintos - a.pj_distintos);
  const max = Math.max(...ordenado.map((d) => d.pj_distintos), 1);

  montarPodioGestores(ordenado);

  tbody.innerHTML = ordenado.map((g) => `
    <tr data-gestor="${g.gestor}" tabindex="0" title="Filtrar pela carteira de ${g.gestor}">
      <td>${g.gestor}</td>
      <td>${g.vertical}</td>
      <td class="num">${fmtInt(g.clientes_na_carteira)}</td>
      <td class="num">${fmtInt(g.pj_distintos)}</td>
      <td class="mini-bar-cell"><div class="mini-bar-track"><div class="mini-bar-fill" style="width:${(g.pj_distintos / max) * 100}%"></div></div></td>
      <td class="num">${fmtInt(g.total_inconsistencias)}</td>
      <td class="num">${fmtPct(g.pct_respondeu)}</td>
    </tr>
  `).join("");
}

/* ============================================================================
   AUDITORIA (timeline) -- trilha do pipeline principal, nao reage a filtros
   (e um log de sistema, nao uma visao de carteira)
   ============================================================================ */
function montarLog(logAlteracoes) {
  const container = document.getElementById("table-log");
  const emptyState = document.getElementById("log-empty");

  if (!logAlteracoes.length) {
    container.hidden = true;
    emptyState.hidden = false;
    return;
  }
  container.hidden = false;
  emptyState.hidden = true;

  const rotulo = { INSERT: "incluiu", UPDATE: "editou", DELETE: "excluiu" };
  const classeDot = { INSERT: "insert", UPDATE: "update", DELETE: "delete" };

  container.innerHTML = logAlteracoes.map((l) => {
    const acao = rotulo[l.operacao] || l.operacao;
    const detalhe = l.campo
      ? ` &middot; <strong>${l.campo}</strong>${l.valor_antigo ? `: ${l.valor_antigo} &rarr; ${l.valor_novo}` : ""}`
      : "";
    return `
      <div class="timeline-item">
        <span class="timeline-when">${l.timestamp}</span>
        <span class="timeline-dot-col"><span class="timeline-dot ${classeDot[l.operacao] || ""}"></span></span>
        <span class="timeline-body">
          Gestor <strong>#${l.gestor_id_operador}</strong> ${acao} o registro <strong>#${l.registro_id}</strong> em <strong>${l.tabela}</strong>${detalhe}
        </span>
      </div>
    `;
  }).join("");
}

/* ============================================================================
   BASE DE CLIENTES (tabela paginada) -- alimentada pelo subconjunto ja
   filtrado globalmente + a busca de texto local desta secao
   ============================================================================ */
function renderizarTabelaClientes() {
  const { filtrados, pagina } = tabelaState;
  const totalPaginas = Math.max(1, Math.ceil(filtrados.length / CLIENTES_POR_PAGINA));
  const inicio = (pagina - 1) * CLIENTES_POR_PAGINA;
  const pageRows = filtrados.slice(inicio, inicio + CLIENTES_POR_PAGINA);

  const tbody = document.querySelector("#table-clientes tbody");
  tbody.innerHTML = pageRows.map((c) => `
    <tr data-cliente-id="${c.cliente_id}" tabindex="0" title="Ver detalhe do cliente">
      <td>${c.razao_social}${c.pj_distinto_oficial === 1 ? ' <span title="PJ Distinto" style="color:var(--good)">&#10003;</span>' : ""}</td>
      <td>${c.cnpj}</td>
      <td>${c.porte}</td>
      <td>${c.municipio || "--"}</td>
      <td>${c.gestor}</td>
      <td>${c.vertical}</td>
      <td>${c.status}</td>
    </tr>
  `).join("") || `<tr><td colspan="7" style="color:var(--ink-3)">Nenhum cliente encontrado com esses filtros.</td></tr>`;

  const pager = document.getElementById("clientes-pager");
  pager.innerHTML = `
    <button id="pg-prev" ${pagina <= 1 ? "disabled" : ""}>&larr; Anterior</button>
    <span>Pagina ${pagina} de ${totalPaginas} &middot; ${filtrados.length} clientes</span>
    <button id="pg-next" ${pagina >= totalPaginas ? "disabled" : ""}>Proxima &rarr;</button>
  `;
  document.getElementById("pg-prev")?.addEventListener("click", () => { tabelaState.pagina--; renderizarTabelaClientes(); });
  document.getElementById("pg-next")?.addEventListener("click", () => { tabelaState.pagina++; renderizarTabelaClientes(); });
}

function aplicarBuscaEExibirTabela(clientesFiltrados) {
  const busca = document.getElementById("clientes-busca").value.trim().toLowerCase();
  tabelaState.filtrados = busca
    ? clientesFiltrados.filter((c) => c.razao_social.toLowerCase().includes(busca) || c.cnpj.includes(busca))
    : clientesFiltrados;
  tabelaState.pagina = 1;
  renderizarTabelaClientes();
}

/* ============================================================================
   PAINEL DE DETALHE DO CLIENTE (drill-down) -- overlay independente do
   sandbox (nenhum acoplamento com assets/supabase-demo.js)
   ============================================================================ */
let painelFocoAnterior = null;

function slugStatus(status) {
  return String(status).toLowerCase().replace(/[^a-z]+/g, "-");
}

function campoDetalhe(dt, dd) {
  const div = document.createElement("div");
  div.className = "panel-field";
  const t = document.createElement("dt");
  t.textContent = dt;
  const d = document.createElement("dd");
  d.textContent = dd;
  div.append(t, d);
  return div;
}

function abrirPainelCliente(cliente) {
  painelFocoAnterior = document.activeElement;

  document.getElementById("panel-cliente-title").textContent = cliente.razao_social;
  document.getElementById("panel-cliente-cnpj").textContent = cliente.cnpj;

  const badges = document.getElementById("panel-cliente-badges");
  badges.innerHTML = "";
  const badgeStatus = document.createElement("span");
  badgeStatus.className = `badge badge-status-${slugStatus(cliente.status)}`;
  badgeStatus.textContent = cliente.status;
  badges.appendChild(badgeStatus);
  if (cliente.pj_distinto_oficial === 1) {
    const b = document.createElement("span");
    b.className = "badge badge-insert";
    b.textContent = "PJ Distinto";
    badges.appendChild(b);
  }

  const campos = document.getElementById("panel-cliente-fields");
  campos.innerHTML = "";
  campos.append(
    campoDetalhe("Porte", cliente.porte),
    campoDetalhe("Municipio", cliente.municipio || "--"),
    campoDetalhe("Gestor", cliente.gestor),
    campoDetalhe("Vertical", cliente.vertical),
    campoDetalhe("Inconsistencias", fmtInt(cliente.qtd_planos_inconsistentes)),
    campoDetalhe("Respondeu a pesquisa", cliente.respondeu === 1 ? "Sim" : "Nao"),
    campoDetalhe("Aumento de faturamento", cliente.aumento_faturamento_pct !== null ? fmtPct(cliente.aumento_faturamento_pct) : "--"),
  );

  const overlay = document.getElementById("panel-overlay");
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add("is-open"));
  document.addEventListener("keydown", onPanelKeydown);
  document.getElementById("panel-close").focus();
}

function fecharPainelCliente() {
  const overlay = document.getElementById("panel-overlay");
  if (overlay.hidden) return;
  overlay.classList.remove("is-open");
  document.removeEventListener("keydown", onPanelKeydown);
  setTimeout(() => { overlay.hidden = true; }, 300);
  painelFocoAnterior?.focus?.();
}

function onPanelKeydown(e) {
  if (e.key === "Escape") fecharPainelCliente();
}

/* ============================================================================
   FILTROS GLOBAIS -- vertical/status/porte (multi-selecao via chips) e
   gestor (selecao unica, semantica de drill-down)
   ============================================================================ */
function clientesFiltradosAtuais() {
  const { vertical, status, porte, gestor } = dashState.filtros;
  return dashState.todos.filter((c) => {
    if (vertical.size && !vertical.has(c.vertical)) return false;
    if (status.size && !status.has(c.status)) return false;
    if (porte.size && !porte.has(c.porte)) return false;
    if (gestor && c.gestor !== gestor) return false;
    return true;
  });
}

function aplicarFiltrosGlobais() {
  renderTudo(clientesFiltradosAtuais());
}

function renderTudo(filtrados) {
  const resumo = agregarResumo(filtrados);
  montarKPIs(resumo);
  montarBarChartVertical(agregarPorVertical(filtrados));
  montarStatusChart(resumo);
  montarFaturamentoPorte(agregarFaturamentoPorPorte(filtrados));
  montarTabelaGestores(agregarPorGestor(filtrados));
  aplicarBuscaEExibirTabela(filtrados);
  atualizarFilterBarUI(filtrados.length);
}

function atualizarFilterBarUI(totalFiltrado) {
  const { vertical, status, porte, gestor } = dashState.filtros;
  document.querySelectorAll("#chips-vertical .chip").forEach((el) => el.classList.toggle("is-active", vertical.has(el.dataset.value)));
  document.querySelectorAll("#chips-status .chip").forEach((el) => el.classList.toggle("is-active", status.has(el.dataset.value)));
  document.querySelectorAll("#chips-porte .chip").forEach((el) => el.classList.toggle("is-active", porte.has(el.dataset.value)));
  document.querySelectorAll("#chart-vertical .bar-row").forEach((el) => el.classList.toggle("is-active", vertical.has(el.dataset.vertical)));
  document.querySelectorAll("#table-gestores tbody tr[data-gestor]").forEach((el) => el.classList.toggle("is-active", gestor === el.dataset.gestor));
  document.querySelectorAll("#podium-gestores .podium-card[data-gestor]").forEach((el) => el.classList.toggle("is-active", gestor === el.dataset.gestor));

  const algumAtivo = !!(vertical.size || status.size || porte.size || gestor);
  document.getElementById("filter-clear").hidden = !algumAtivo;

  const total = dashState.todos.length;
  document.getElementById("filter-result-count").textContent = algumAtivo
    ? `${fmtInt(totalFiltrado)} de ${fmtInt(total)} clientes`
    : `${fmtInt(total)} clientes`;

  document.querySelectorAll(".filtro-indicator").forEach((el) => {
    el.hidden = !algumAtivo;
    if (algumAtivo) el.querySelector(".filtro-indicator-text").textContent = `filtrado: ${fmtInt(totalFiltrado)} de ${fmtInt(total)}`;
  });
}

function toggleFiltroSet(chave, valor) {
  const set = dashState.filtros[chave];
  if (set.has(valor)) set.delete(valor); else set.add(valor);
  aplicarFiltrosGlobais();
}

function definirFiltroGestor(valor) {
  dashState.filtros.gestor = dashState.filtros.gestor === valor ? null : valor;
  const select = document.getElementById("filter-gestor");
  if (select) select.value = dashState.filtros.gestor || "";
  aplicarFiltrosGlobais();
}

function limparFiltros() {
  dashState.filtros = { vertical: new Set(), status: new Set(), porte: new Set(), gestor: null };
  document.getElementById("filter-gestor").value = "";
  document.getElementById("clientes-busca").value = "";
  aplicarFiltrosGlobais();
}

function construirChips(containerId, valores, chave) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  valores.forEach((valor) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.dataset.value = valor;
    chip.textContent = valor;
    chip.addEventListener("click", () => toggleFiltroSet(chave, valor));
    container.appendChild(chip);
  });
}

function construirFiltroBar(clientes) {
  const verticais = [...new Set(clientes.map((c) => c.vertical))].sort();
  const statusValores = [...new Set(clientes.map((c) => c.status))];
  const portes = PORTE_ORDEM.filter((p) => clientes.some((c) => c.porte === p));
  const gestores = [...new Set(clientes.map((c) => c.gestor))].sort();

  construirChips("chips-vertical", verticais, "vertical");
  construirChips("chips-status", statusValores, "status");
  construirChips("chips-porte", portes, "porte");

  const select = document.getElementById("filter-gestor");
  select.innerHTML = '<option value="">Todos os gestores</option>' +
    gestores.map((g) => `<option value="${g}">${g}</option>`).join("");
  select.disabled = false;
}

/* ============================================================================
   WIRING (uma unica vez) -- delegacao de clique nos containers persistentes
   (o innerHTML interno e recriado a cada filtro, mas os containers em si
   nunca sao substituidos, entao o listener nao precisa ser re-anexado)
   ============================================================================ */
function wireInteracoesDashboard() {
  document.getElementById("filter-clear").addEventListener("click", limparFiltros);
  document.getElementById("filter-gestor").addEventListener("change", (e) => {
    dashState.filtros.gestor = e.target.value || null;
    aplicarFiltrosGlobais();
  });
  document.querySelectorAll("[data-clear-filtros]").forEach((btn) => btn.addEventListener("click", limparFiltros));
  document.getElementById("clientes-busca").addEventListener("input", () => aplicarBuscaEExibirTabela(clientesFiltradosAtuais()));

  document.getElementById("chart-vertical").addEventListener("click", (e) => {
    const row = e.target.closest(".bar-row[data-vertical]");
    if (row) toggleFiltroSet("vertical", row.dataset.vertical);
  });
  document.getElementById("chart-vertical").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest(".bar-row[data-vertical]");
    if (row) { e.preventDefault(); toggleFiltroSet("vertical", row.dataset.vertical); }
  });

  document.getElementById("table-gestores").addEventListener("click", (e) => {
    const row = e.target.closest("tr[data-gestor]");
    if (row) definirFiltroGestor(row.dataset.gestor);
  });
  document.getElementById("table-gestores").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest("tr[data-gestor]");
    if (row) { e.preventDefault(); definirFiltroGestor(row.dataset.gestor); }
  });

  document.getElementById("podium-gestores").addEventListener("click", (e) => {
    const card = e.target.closest(".podium-card[data-gestor]");
    if (card) definirFiltroGestor(card.dataset.gestor);
  });
  document.getElementById("podium-gestores").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest(".podium-card[data-gestor]");
    if (card) { e.preventDefault(); definirFiltroGestor(card.dataset.gestor); }
  });

  document.getElementById("table-clientes").addEventListener("click", (e) => {
    const row = e.target.closest("tr[data-cliente-id]");
    if (!row) return;
    const cliente = dashState.todos.find((c) => String(c.cliente_id) === row.dataset.clienteId);
    if (cliente) abrirPainelCliente(cliente);
  });
  document.getElementById("table-clientes").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest("tr[data-cliente-id]");
    if (!row) return;
    e.preventDefault();
    const cliente = dashState.todos.find((c) => String(c.cliente_id) === row.dataset.clienteId);
    if (cliente) abrirPainelCliente(cliente);
  });

  document.getElementById("panel-close").addEventListener("click", fecharPainelCliente);
  document.getElementById("panel-overlay").addEventListener("click", (e) => {
    if (e.target === document.getElementById("panel-overlay")) fecharPainelCliente();
  });

  const toggleBtn = document.querySelector('.table-toggle[data-target="table-vertical"]');
  toggleBtn.addEventListener("click", (e) => {
    const tableWrap = document.getElementById("table-vertical");
    const hidden = tableWrap.hasAttribute("hidden");
    if (hidden) { tableWrap.removeAttribute("hidden"); e.target.textContent = "Ver como grafico"; }
    else { tableWrap.setAttribute("hidden", ""); e.target.textContent = "Ver como tabela"; }
  });
}

/* ============================================================================
   ESTADO DE ERRO GLOBAL
   ============================================================================ */
function mostrarErroCarregamento(err) {
  const msg = `Nao foi possivel carregar os dados (${err.message}).`;
  document.getElementById("filter-bar").dataset.state = "error";
  document.getElementById("filter-result-count").textContent = "Erro ao carregar dados";
  document.getElementById("kpi-row").innerHTML = `<p style="color:var(--ink-3)">${msg}</p>`;
  document.getElementById("chart-vertical").innerHTML = `<p class="empty-state">${msg}</p>`;
  document.getElementById("chart-status").innerHTML = `<p class="empty-state">${msg}</p>`;
  document.getElementById("chart-faturamento").innerHTML = `<p class="empty-state">${msg}</p>`;
  document.getElementById("podium-gestores").innerHTML = `<p class="empty-state">${msg}</p>`;
  document.querySelector("#table-clientes tbody").innerHTML = `<tr><td colspan="7" style="color:var(--ink-3)">${msg}</td></tr>`;
}

/* ============================================================================
   POWER BI
   ============================================================================ */
function montarPowerBI() {
  const container = document.getElementById("powerbi-embed");
  const tags = document.getElementById("powerbi-model-tags");
  const tabelasModelo = ["Clientes", "Gestores", "ControlePorGestor", "ControlePorVertical", "Planos", "CentrosCusto", "LogAlteracoes"];

  if (POWERBI_EMBED_URL) {
    container.innerHTML = `<iframe src="${POWERBI_EMBED_URL}" allowfullscreen loading="lazy"></iframe>`;
    tags.hidden = true;
  } else {
    container.innerHTML = `
      <p class="powerbi-placeholder-title">Relat&oacute;rio interativo a caminho</p>
      <p class="powerbi-placeholder-text">
        O modelo de dados e as medidas DAX j&aacute; est&atilde;o prontos e documentados &mdash; as mesmas
        medidas (Total Clientes, PJ Distintos, % Respondentes, Aumento M&eacute;dio de Faturamento) j&aacute;
        est&atilde;o em a&ccedil;&atilde;o no dashboard acima. Falta apenas o passo de publica&ccedil;&atilde;o
        no Power BI Service para o relat&oacute;rio completo (drill-through por cliente, filtros nativos)
        aparecer aqui.
      </p>
      <a href="https://github.com/ProjectForm/JornadaCliente/blob/main/powerbi/modelo_de_dados_e_dax.md" target="_blank" rel="noopener" class="btn btn-ghost">Ver documenta&ccedil;&atilde;o do modelo &rarr;</a>
    `;
    tags.hidden = false;
    tags.innerHTML = tabelasModelo.map((t) => `<li>${t}</li>`).join("");
  }
}

/* ============================================================================
   INIT
   ============================================================================ */
async function init() {
  wireInteracoesDashboard();
  try {
    const [logAlteracoes, clientesPayload] = await Promise.all([
      carregarJSON("data/log_alteracoes.json"),
      carregarJSON("data/clientes.json"),
    ]);
    dashState.todos = converterClientesColunar(clientesPayload).map(normalizarCliente);
    montarLog(logAlteracoes);
    construirFiltroBar(dashState.todos);
    document.getElementById("filter-bar").dataset.state = "ready";
    renderTudo(dashState.todos);
  } catch (err) {
    console.error(err);
    mostrarErroCarregamento(err);
  }
  montarPowerBI();
}

init();
