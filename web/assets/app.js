// Preencher com o link de embed do Power BI ("Publicar na Web") quando disponivel.
// Ver powerbi/modelo_de_dados_e_dax.md -> secao "Publicar na Web".
const POWERBI_EMBED_URL = "";

const fmtInt = (n) => new Intl.NumberFormat("pt-BR").format(n);
const fmtPct = (n) => (n === null || n === undefined ? "--" : `${n.toString().replace(".", ",")}%`);

async function carregarJSON(caminho) {
  const resp = await fetch(caminho);
  if (!resp.ok) throw new Error(`Falha ao carregar ${caminho}: ${resp.status}`);
  return resp.json();
}

function montarKPIs(resumo) {
  const tiles = [
    ["Total de clientes", fmtInt(resumo.total_clientes)],
    ["PJ Distintos", fmtInt(resumo.pj_distintos)],
    ["% PJ Distintos", fmtPct(resumo.pct_pj_distintos)],
    ["Inconsistencias", fmtInt(resumo.total_inconsistencias)],
    ["% Respondentes da pesquisa", fmtPct(resumo.pct_respondentes)],
    ["Aumento medio de faturamento", resumo.media_aumento_faturamento_pct === null
      ? "--" : `${resumo.media_aumento_faturamento_pct.toString().replace(".", ",")}%`],
  ];
  const row = document.getElementById("kpi-row");
  row.innerHTML = tiles.map(([label, value]) => `
    <div class="stat-tile">
      <span class="stat-label">${label}</span>
      <span class="stat-value">${value}</span>
    </div>
  `).join("");
}

function montarBarChartVertical(controleVertical) {
  const dados = [...controleVertical]
    .map((v) => ({ ...v, pj_distintos: Number(v.pj_distintos) }))
    .sort((a, b) => b.pj_distintos - a.pj_distintos);
  const max = Math.max(...dados.map((d) => d.pj_distintos), 1);

  const chart = document.getElementById("chart-vertical");
  chart.innerHTML = dados.map((d) => `
    <div class="bar-row">
      <span class="bar-label">${d.vertical}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(d.pj_distintos / max) * 100}%"></div></div>
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
}

function montarStatusChart(resumo) {
  const ordem = [
    { chave: "Concluinte", cor: "var(--status-good)" },
    { chave: "Participante", cor: "var(--series-1)" },
    { chave: "Sem atendimento", cor: "var(--status-warning)" },
  ];
  const total = Object.values(resumo.status_contagem).reduce((a, b) => a + b, 0) || 1;

  const track = document.getElementById("chart-status");
  track.innerHTML = `<div class="stacked-track">${
    ordem.map((o) => {
      const qtd = resumo.status_contagem[o.chave] || 0;
      const pct = (qtd / total) * 100;
      if (pct === 0) return "";
      return `<div class="stacked-seg" style="width:${pct}%;background:${o.cor}" title="${o.chave}: ${qtd}"></div>`;
    }).join("")
  }</div>`;

  const legend = document.getElementById("legend-status");
  legend.innerHTML = ordem.map((o) => {
    const qtd = resumo.status_contagem[o.chave] || 0;
    const pct = ((qtd / total) * 100).toFixed(1).replace(".", ",");
    return `<li><span class="swatch" style="background:${o.cor}"></span>${o.chave} &middot; ${fmtInt(qtd)} (${pct}%)</li>`;
  }).join("");
}

function montarTabelaGestores(controleGestor) {
  const dados = [...controleGestor]
    .map((g) => ({ ...g, pj_distintos: Number(g.pj_distintos) }))
    .sort((a, b) => b.pj_distintos - a.pj_distintos);
  const max = Math.max(...dados.map((d) => d.pj_distintos), 1);

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

function montarLog(logAlteracoes) {
  const tbody = document.querySelector("#table-log tbody");
  const emptyState = document.getElementById("log-empty");
  const table = document.getElementById("table-log");

  if (!logAlteracoes.length) {
    table.hidden = true;
    emptyState.hidden = false;
    return;
  }

  const badge = { INSERT: "badge-insert", UPDATE: "badge-update", DELETE: "badge-delete" };
  const simbolo = { INSERT: "+", UPDATE: "~", DELETE: "×" };

  tbody.innerHTML = logAlteracoes.map((l) => `
    <tr>
      <td>${l.timestamp}</td>
      <td><span class="badge ${badge[l.operacao] || ""}">${simbolo[l.operacao] || ""} ${l.operacao}</span></td>
      <td>${l.tabela}</td>
      <td>#${l.registro_id}</td>
      <td>${l.campo || "--"}</td>
      <td>${l.valor_antigo ? `${l.valor_antigo} &rarr; ${l.valor_novo}` : "--"}</td>
      <td>#${l.gestor_id_operador}</td>
    </tr>
  `).join("");
}

function montarPowerBI() {
  const container = document.getElementById("powerbi-embed");
  if (POWERBI_EMBED_URL) {
    container.innerHTML = `<iframe src="${POWERBI_EMBED_URL}" allowfullscreen loading="lazy"></iframe>`;
  } else {
    container.innerHTML = `
      <div class="powerbi-placeholder">
        Relatorio Power BI em preparacao &mdash; o modelo de dados e as medidas DAX ja
        estao documentados em <code>powerbi/modelo_de_dados_e_dax.md</code> no repositorio.
        <br><a href="https://github.com/ProjectForm/JornadaCliente/blob/main/powerbi/modelo_de_dados_e_dax.md" target="_blank" rel="noopener">Ver documentacao do modelo &rarr;</a>
      </div>`;
  }
}

async function init() {
  try {
    const [resumo, controleVertical, controleGestor, logAlteracoes] = await Promise.all([
      carregarJSON("data/resumo.json"),
      carregarJSON("data/controle_vertical.json"),
      carregarJSON("data/controle_gestor.json"),
      carregarJSON("data/log_alteracoes.json"),
    ]);
    montarKPIs(resumo);
    montarBarChartVertical(controleVertical);
    montarStatusChart(resumo);
    montarTabelaGestores(controleGestor);
    montarLog(logAlteracoes);
  } catch (err) {
    console.error(err);
    document.getElementById("kpi-row").innerHTML =
      `<p style="color:var(--text-muted)">Nao foi possivel carregar os dados (${err.message}).</p>`;
  }
  montarPowerBI();
}

init();
