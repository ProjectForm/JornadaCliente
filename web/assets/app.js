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
   GRAFICO: PJ Distintos por vertical
   ============================================================================ */
function montarBarChartVertical(controleVertical) {
  const dados = [...controleVertical]
    .map((v) => ({ ...v, pj_distintos: Number(v.pj_distintos) }))
    .sort((a, b) => b.pj_distintos - a.pj_distintos);
  const max = Math.max(...dados.map((d) => d.pj_distintos), 1);

  const chart = document.getElementById("chart-vertical");
  chart.innerHTML = dados.map((d) => `
    <div class="bar-row">
      <span class="bar-label">${d.vertical}</span>
      <div class="bar-track"><div class="bar-fill" data-final="${(d.pj_distintos / max) * 100}%" style="width:0%"></div></div>
      <span class="bar-value">${fmtInt(d.pj_distintos)}</span>
    </div>
  `).join("");

  const tableWrap = document.getElementById("table-vertical");
  tableWrap.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Vertical</th><th class="num">Clientes</th><th class="num">PJ Distintos</th><th class="num">Inconsistencias</th><th class="num">% Respondentes</th></tr></thead>
      <tbody>
        ${dados.map((d) => `
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

  document.querySelector('.table-toggle[data-target="table-vertical"]').addEventListener("click", (e) => {
    const hidden = tableWrap.hasAttribute("hidden");
    if (hidden) { tableWrap.removeAttribute("hidden"); e.target.textContent = "Ver como grafico"; }
    else { tableWrap.setAttribute("hidden", ""); e.target.textContent = "Ver como tabela"; }
  });

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
  const total = Object.values(resumo.status_contagem).reduce((a, b) => a + b, 0) || 1;

  const track = document.getElementById("chart-status");
  track.innerHTML = `<div class="stacked-track">${
    ordem.map((o) => {
      const qtd = resumo.status_contagem[o.chave] || 0;
      const pct = (qtd / total) * 100;
      if (pct === 0) return "";
      return `<div class="stacked-seg" data-final="${pct}%" style="width:0%;background:${o.cor}" title="${o.chave}: ${qtd}"></div>`;
    }).join("")
  }</div>`;

  const legend = document.getElementById("legend-status");
  legend.innerHTML = ordem.map((o) => {
    const qtd = resumo.status_contagem[o.chave] || 0;
    const pct = ((qtd / total) * 100).toFixed(1).replace(".", ",");
    return `<li><span class="swatch" style="background:${o.cor}"></span>${o.chave} &middot; ${fmtInt(qtd)} (${pct}%)</li>`;
  }).join("");

  if (isRevealed(track)) growBarsWithin(track.closest("[data-reveal]"));
}

/* ============================================================================
   RANKING DE GESTORES (podio top-3 + tabela completa)
   ============================================================================ */
function montarPodioGestores(dados) {
  const top3 = dados.slice(0, 3);
  const podium = document.getElementById("podium-gestores");
  if (!podium) return;
  podium.innerHTML = top3.map((g, i) => `
    <div class="podium-card rank-${i + 1}">
      <p class="podium-rank"><span class="n">${i + 1}&ordm;</span> lugar</p>
      <p class="podium-name">${g.gestor}</p>
      <p class="podium-vertical">${g.vertical}</p>
      <p class="podium-value">${fmtInt(g.pj_distintos)}</p>
      <p class="podium-value-label">PJ Distintos</p>
    </div>
  `).join("");
}

function montarTabelaGestores(controleGestor) {
  const dados = [...controleGestor]
    .map((g) => ({ ...g, pj_distintos: Number(g.pj_distintos) }))
    .sort((a, b) => b.pj_distintos - a.pj_distintos);
  const max = Math.max(...dados.map((d) => d.pj_distintos), 1);

  montarPodioGestores(dados);

  const tbody = document.querySelector("#table-gestores tbody");
  tbody.innerHTML = dados.map((g) => `
    <tr>
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
   AUDITORIA (timeline)
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

  const rotulo = {
    INSERT: "incluiu",
    UPDATE: "editou",
    DELETE: "excluiu",
  };
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
   BASE DE CLIENTES (busca / filtro / paginacao)
   ============================================================================ */
const CLIENTES_POR_PAGINA = 25;
let clientesEstado = { todos: [], filtrados: [], pagina: 1 };

function montarFiltrosClientes(clientes) {
  const verticais = [...new Set(clientes.map((c) => c.vertical))].sort();
  const gestores = [...new Set(clientes.map((c) => c.gestor))].sort();

  const selVertical = document.getElementById("clientes-filtro-vertical");
  verticais.forEach((v) => selVertical.insertAdjacentHTML("beforeend", `<option value="${v}">${v}</option>`));

  const selGestor = document.getElementById("clientes-filtro-gestor");
  gestores.forEach((g) => selGestor.insertAdjacentHTML("beforeend", `<option value="${g}">${g}</option>`));
}

function aplicarFiltrosClientes() {
  const busca = document.getElementById("clientes-busca").value.trim().toLowerCase();
  const vertical = document.getElementById("clientes-filtro-vertical").value;
  const gestor = document.getElementById("clientes-filtro-gestor").value;
  const status = document.getElementById("clientes-filtro-status").value;

  clientesEstado.filtrados = clientesEstado.todos.filter((c) => {
    if (busca && !c.razao_social.toLowerCase().includes(busca) && !c.cnpj.includes(busca)) return false;
    if (vertical && c.vertical !== vertical) return false;
    if (gestor && c.gestor !== gestor) return false;
    if (status && c.status !== status) return false;
    return true;
  });
  clientesEstado.pagina = 1;
  renderizarTabelaClientes();
}

function renderizarTabelaClientes() {
  const { filtrados, pagina } = clientesEstado;
  const totalPaginas = Math.max(1, Math.ceil(filtrados.length / CLIENTES_POR_PAGINA));
  const inicio = (pagina - 1) * CLIENTES_POR_PAGINA;
  const pageRows = filtrados.slice(inicio, inicio + CLIENTES_POR_PAGINA);

  const tbody = document.querySelector("#table-clientes tbody");
  tbody.innerHTML = pageRows.map((c) => `
    <tr>
      <td>${c.razao_social}${c.pj_distinto_oficial === "1" ? ' <span title="PJ Distinto" style="color:var(--good)">&#10003;</span>' : ""}</td>
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
  document.getElementById("pg-prev")?.addEventListener("click", () => { clientesEstado.pagina--; renderizarTabelaClientes(); });
  document.getElementById("pg-next")?.addEventListener("click", () => { clientesEstado.pagina++; renderizarTabelaClientes(); });
}

function converterClientesColunar(payload) {
  const { colunas, linhas } = payload;
  return linhas.map((linha) => Object.fromEntries(colunas.map((col, i) => [col, linha[i]])));
}

function montarBaseClientes(clientesPayload) {
  const clientes = converterClientesColunar(clientesPayload);
  clientesEstado.todos = clientes;
  clientesEstado.filtrados = clientes;
  montarFiltrosClientes(clientes);
  renderizarTabelaClientes();

  ["clientes-busca"].forEach((id) => document.getElementById(id).addEventListener("input", aplicarFiltrosClientes));
  ["clientes-filtro-vertical", "clientes-filtro-gestor", "clientes-filtro-status"].forEach((id) =>
    document.getElementById(id).addEventListener("change", aplicarFiltrosClientes)
  );
}

/* ============================================================================
   POWER BI
   ============================================================================ */
function montarPowerBI() {
  const container = document.getElementById("powerbi-embed");
  if (POWERBI_EMBED_URL) {
    container.innerHTML = `<iframe src="${POWERBI_EMBED_URL}" allowfullscreen loading="lazy"></iframe>`;
  } else {
    container.innerHTML = `
      <p class="powerbi-placeholder-title">Relat&oacute;rio interativo a caminho</p>
      <p class="powerbi-placeholder-text">
        O modelo de dados e as medidas DAX j&aacute; est&atilde;o prontos e documentados
        &mdash; falta apenas o passo de publica&ccedil;&atilde;o no Power BI Service para o
        relat&oacute;rio completo (drill-down por cliente, filtros interativos) aparecer aqui.
      </p>
      <a href="https://github.com/ProjectForm/JornadaCliente/blob/main/powerbi/modelo_de_dados_e_dax.md" target="_blank" rel="noopener" class="btn btn-ghost">Ver documenta&ccedil;&atilde;o do modelo &rarr;</a>
    `;
  }
}

/* ============================================================================
   INIT
   ============================================================================ */
async function init() {
  try {
    const [resumo, controleVertical, controleGestor, logAlteracoes, clientes] = await Promise.all([
      carregarJSON("data/resumo.json"),
      carregarJSON("data/controle_vertical.json"),
      carregarJSON("data/controle_gestor.json"),
      carregarJSON("data/log_alteracoes.json"),
      carregarJSON("data/clientes.json"),
    ]);
    montarKPIs(resumo);
    montarBarChartVertical(controleVertical);
    montarStatusChart(resumo);
    montarTabelaGestores(controleGestor);
    montarLog(logAlteracoes);
    montarBaseClientes(clientes);
  } catch (err) {
    console.error(err);
    document.getElementById("kpi-row").innerHTML =
      `<p style="color:var(--ink-3)">Nao foi possivel carregar os dados (${err.message}).</p>`;
  }
  montarPowerBI();
}

init();
