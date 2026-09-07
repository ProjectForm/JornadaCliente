// Sandbox publico de demonstracao (banco Postgres real, Supabase).
// Schema/RLS/funcoes: supabase/schema_demo.sql no repositorio.
//
// A anon key abaixo e destinada a ficar publica no cliente -- a seguranca
// mora nas policies de RLS e nas funcoes SECURITY DEFINER do banco (ver
// schema_demo.sql), nao em esconder esta chave.
const SUPABASE_URL = "https://mmzotwqobbpuahjhulom.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_3n7XKPYyCEZSKybccTYF5g_hfwdllVX";

let sb = null;
let gestoresPorId = new Map();

function celula(texto) {
  const td = document.createElement("td");
  td.textContent = texto;
  return td;
}

function mostrarFeedback(mensagem, tipo) {
  const el = document.getElementById("demo-feedback");
  el.textContent = mensagem;
  el.className = `demo-feedback ${tipo}`;
  el.hidden = false;
  clearTimeout(mostrarFeedback._t);
  mostrarFeedback._t = setTimeout(() => { el.hidden = true; }, 6000);
}

async function carregarGestoresDemo() {
  const { data, error } = await sb.from("demo_gestores").select("*").order("nome");
  if (error) throw error;
  gestoresPorId = new Map(data.map((g) => [g.gestor_id, g]));

  const select = document.getElementById("demo-gestor-atual");
  select.innerHTML = data.map((g) => `<option value="${g.gestor_id}">${g.nome} (${g.vertical})</option>`).join("");
}

function renderizarDemoClientes(clientes) {
  const tbody = document.querySelector("#table-demo-clientes tbody");
  const emptyState = document.getElementById("demo-clientes-empty");
  tbody.innerHTML = "";

  if (!clientes.length) {
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;

  clientes.forEach((c) => {
    const gestor = gestoresPorId.get(c.gestor_id);
    const tr = document.createElement("tr");
    tr.appendChild(celula(c.razao_social));
    tr.appendChild(celula(c.porte));
    tr.appendChild(celula(gestor ? gestor.nome : `#${c.gestor_id}`));
    tr.appendChild(celula(gestor ? gestor.vertical : "--"));

    const tdActions = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "row-actions";
    const btnEdit = document.createElement("button");
    btnEdit.type = "button";
    btnEdit.className = "btn-icon";
    btnEdit.textContent = "Editar";
    btnEdit.addEventListener("click", () => editarClienteDemo(c));
    const btnDel = document.createElement("button");
    btnDel.type = "button";
    btnDel.className = "btn-icon danger";
    btnDel.textContent = "Excluir";
    btnDel.addEventListener("click", () => excluirClienteDemo(c));
    wrap.append(btnEdit, btnDel);
    tdActions.appendChild(wrap);
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  });
}

function renderizarDemoLog(logs) {
  const tbody = document.querySelector("#table-demo-log tbody");
  const table = document.getElementById("table-demo-log");
  const emptyState = document.getElementById("demo-log-empty");
  tbody.innerHTML = "";

  if (!logs.length) {
    table.hidden = true;
    emptyState.hidden = false;
    return;
  }
  table.hidden = false;
  emptyState.hidden = true;

  logs.forEach((l) => {
    const gestor = gestoresPorId.get(l.gestor_operador_id);
    const tr = document.createElement("tr");
    tr.appendChild(celula(new Date(l.criado_em).toLocaleString("pt-BR")));
    tr.appendChild(celula(l.operacao));
    tr.appendChild(celula(l.campo || "--"));
    tr.appendChild(celula(l.valor_antigo ? `${l.valor_antigo} -> ${l.valor_novo}` : "--"));
    tr.appendChild(celula(gestor ? gestor.nome : `#${l.gestor_operador_id}`));
    tbody.appendChild(tr);
  });
}

async function recarregarDemo() {
  const [{ data: clientes, error: e1 }, { data: logs, error: e2 }] = await Promise.all([
    sb.from("demo_clientes").select("*").eq("ativo", true).order("criado_em", { ascending: false }),
    sb.from("demo_log").select("*").order("criado_em", { ascending: false }).limit(20),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  renderizarDemoClientes(clientes);
  renderizarDemoLog(logs);
}

async function editarClienteDemo(cliente) {
  const operadorId = Number(document.getElementById("demo-gestor-atual").value);
  const novoValor = prompt(`Nova razao social para "${cliente.razao_social}":`, cliente.razao_social);
  if (novoValor === null || !novoValor.trim() || novoValor === cliente.razao_social) return;

  const { error } = await sb.rpc("demo_editar_cliente", {
    p_cliente_id: cliente.id,
    p_gestor_operador_id: operadorId,
    p_campo: "razao_social",
    p_novo_valor: novoValor,
  });
  mostrarFeedback(error ? `Bloqueado: ${error.message}` : "Cliente atualizado.", error ? "erro" : "ok");
  await recarregarDemo();
}

async function excluirClienteDemo(cliente) {
  const operadorId = Number(document.getElementById("demo-gestor-atual").value);
  if (!confirm(`Excluir "${cliente.razao_social}" do sandbox?`)) return;

  const { error } = await sb.rpc("demo_excluir_cliente", {
    p_cliente_id: cliente.id,
    p_gestor_operador_id: operadorId,
  });
  mostrarFeedback(error ? `Bloqueado: ${error.message}` : "Cliente excluido.", error ? "erro" : "ok");
  await recarregarDemo();
}

function initFormularioInclusao() {
  document.getElementById("demo-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const { error } = await sb.rpc("demo_incluir_cliente", {
        p_gestor_id: Number(document.getElementById("demo-gestor-atual").value),
        p_razao_social: document.getElementById("demo-razao-social").value,
        p_cnpj: document.getElementById("demo-cnpj").value,
        p_porte: document.getElementById("demo-porte").value,
      });
      if (error) {
        mostrarFeedback(`Erro: ${error.message}`, "erro");
      } else {
        mostrarFeedback("Cliente incluido no sandbox!", "ok");
        document.getElementById("demo-razao-social").value = "";
        document.getElementById("demo-cnpj").value = "";
      }
      await recarregarDemo();
    } finally {
      btn.disabled = false;
    }
  });
}

async function initDemo() {
  if (typeof supabase === "undefined") {
    mostrarFeedback("Biblioteca do Supabase nao carregou (bloqueada por rede/adblock?).", "erro");
    return;
  }
  sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  try {
    await carregarGestoresDemo();
    await recarregarDemo();
    initFormularioInclusao();
  } catch (err) {
    console.error(err);
    mostrarFeedback(`Nao foi possivel conectar ao sandbox: ${err.message}`, "erro");
  }
}

initDemo();
