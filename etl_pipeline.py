"""
Pipeline de automacao - substitui o trabalho manual de classificar clientes
um a um contra as regras de negocio (equivalente as formulas das colunas
H..AJ da aba Dados no Excel original).

Etapas:
  1. Cria o banco SQLite a partir de sql/schema.sql
  2. Carrega os CSVs sinteticos (camada BASE)
  3. Popula plano_porte (elegibilidade por porte)
  4. Enriquece clientes via mock da API de CNPJ (camada de automacao)
  5. Cria as views de classificacao (sql/queries.sql)
  6. Gera os relatorios finais e mede o tempo total
"""
import csv
import os
import sqlite3
import time

from brasilapi_mock import consultar_cnpj_mock

ROOT = os.path.dirname(__file__)
DB_PATH = os.path.join(ROOT, "data", "faturamento.db")
RAW_DIR = os.path.join(ROOT, "data", "raw")
SCHEMA_PATH = os.path.join(ROOT, "sql", "schema.sql")
QUERIES_PATH = os.path.join(ROOT, "sql", "queries.sql")
REPORT_DIR = os.path.join(ROOT, "data", "reports")


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}")


def criar_schema(conn):
    with open(SCHEMA_PATH, encoding="utf-8") as f:
        conn.executescript(f.read())


def carregar_csv(conn, tabela, arquivo, colunas):
    path = os.path.join(RAW_DIR, arquivo)
    with open(path, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = [tuple(row[c] if row[c] != "" else None for c in colunas) for row in reader]
    placeholders = ",".join(["?"] * len(colunas))
    conn.executemany(f"INSERT INTO {tabela} ({','.join(colunas)}) VALUES ({placeholders})", rows)
    return len(rows)


def popular_plano_porte(conn):
    cur = conn.execute("SELECT plano_id, porte_elegivel FROM planos")
    inserts = []
    for plano_id, porte_elegivel in cur.fetchall():
        for porte in porte_elegivel.split("|"):
            inserts.append((plano_id, porte))
    conn.executemany("INSERT INTO plano_porte (plano_id, porte) VALUES (?, ?)", inserts)
    return len(inserts)


def enriquecer_via_api_cnpj(conn):
    """Consulta o mock da BrasilAPI e grava municipio/razao social/timestamp."""
    clientes = conn.execute("SELECT cliente_id, cnpj, razao_social FROM clientes").fetchall()
    agora = time.strftime("%Y-%m-%d %H:%M:%S")
    atualizacoes = []
    for cliente_id, cnpj, razao_social in clientes:
        resp = consultar_cnpj_mock(cnpj, razao_social)
        atualizacoes.append((resp["municipio"], resp["razao_social"], agora, cliente_id))
    conn.executemany(
        "UPDATE clientes SET municipio = ?, razao_social_api = ?, api_consultado_em = ? WHERE cliente_id = ?",
        atualizacoes,
    )
    return len(atualizacoes)


def criar_views(conn):
    with open(QUERIES_PATH, encoding="utf-8") as f:
        conn.executescript(f.read())


def exportar_relatorios(conn):
    os.makedirs(REPORT_DIR, exist_ok=True)
    exports = {
        "dados_cliente.csv": "SELECT * FROM v_dados_cliente",
        "controle_gestor.csv": "SELECT * FROM v_controle_gestor",
        "controle_vertical.csv": "SELECT * FROM v_controle_vertical",
    }
    for filename, query in exports.items():
        cur = conn.execute(query)
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
        with open(os.path.join(REPORT_DIR, filename), "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(cols)
            w.writerows(rows)
    return exports


def main():
    t0 = time.perf_counter()
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    conn = sqlite3.connect(DB_PATH)

    log("1/6 Criando schema...")
    criar_schema(conn)

    log("2/6 Carregando dados brutos (camada BASE)...")
    n_gestores = carregar_csv(conn, "gestores", "gestores.csv", ["gestor_id", "nome", "vertical"])
    n_planos = carregar_csv(conn, "planos", "planos.csv", ["plano_id", "nome", "regra", "porte_elegivel"])
    n_cc = carregar_csv(conn, "centros_custo", "centros_custo.csv", ["centro_custo_id", "codigo", "plano_id"])
    n_prod = carregar_csv(conn, "produtos", "produtos.csv", ["produto_id", "nome", "tipo"])
    n_cli = carregar_csv(conn, "clientes", "clientes.csv",
                          ["cliente_id", "razao_social", "cnpj", "porte", "gestor_id", "data_cadastro"])
    n_atend = carregar_csv(conn, "atendimentos", "atendimentos.csv",
                            ["atendimento_id", "cliente_id", "centro_custo_id", "produto_id",
                             "data_atendimento", "frequencia", "atendimento_valido"])
    n_pesq = carregar_csv(conn, "pesquisa_faturamento", "pesquisa_faturamento.csv",
                           ["cliente_id", "respondeu", "aumento_faturamento_pct", "data_resposta"])
    conn.commit()
    log(f"    gestores={n_gestores} planos={n_planos} centros_custo={n_cc} produtos={n_prod} "
        f"clientes={n_cli} atendimentos={n_atend} pesquisas={n_pesq}")

    log("3/6 Populando elegibilidade de porte por plano...")
    n_pp = popular_plano_porte(conn)
    conn.commit()
    log(f"    plano_porte={n_pp} combinacoes")

    log("4/6 Enriquecendo clientes via API de CNPJ (mock local da BrasilAPI)...")
    t_api = time.perf_counter()
    n_api = enriquecer_via_api_cnpj(conn)
    conn.commit()
    log(f"    {n_api} clientes consultados em {time.perf_counter() - t_api:.2f}s")

    log("5/6 Criando views de classificacao/validacao (regras de negocio em SQL)...")
    criar_views(conn)

    log("6/6 Exportando relatorios finais (dados_cliente, controle_gestor, controle_vertical)...")
    exports = exportar_relatorios(conn)

    total = time.perf_counter() - t0

    print("\n" + "=" * 70)
    print("RESUMO DA EXECUCAO")
    print("=" * 70)
    cur = conn.execute("SELECT COUNT(*), SUM(pj_distinto_oficial), SUM(qtd_planos_inconsistentes) FROM v_dados_cliente")
    total_clientes, total_pj, total_inconsist = cur.fetchone()
    print(f"Clientes processados:      {total_clientes}")
    print(f"PJ Distintos calculados:   {total_pj}")
    print(f"Inconsistencias detectadas:{total_inconsist}")
    print(f"Arquivos gerados:          {list(exports.keys())}  (em data/reports/)")
    print(f"Banco SQLite:              {DB_PATH}")
    print(f"\nTEMPO TOTAL DO PIPELINE:   {total:.2f} segundos")
    print("(o equivalente manual estimado para este volume seria de ~156 horas)")
    conn.close()


if __name__ == "__main__":
    main()
