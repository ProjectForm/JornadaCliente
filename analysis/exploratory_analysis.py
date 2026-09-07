"""
Analise exploratoria em Pandas - camada complementar as views SQL.

Enquanto sql/queries.sql resolve a REGRA DE NEGOCIO (classificacao/validacao),
este script foca em ANALISE: cruza os relatorios ja calculados para responder
perguntas que um gestor faria, e gera graficos para o dashboard/portfolio.

Fica de proposito como um passo SEPARADO do etl_pipeline.py: o pipeline
existe para reprocessar a base a cada atualizacao (rapido, deterministico);
esta analise existe para explorar o resultado (pode mudar com mais frequencia,
sem precisar reprocessar o banco inteiro).

Uso:
    python etl_pipeline.py              # gera data/faturamento.db e os CSVs
    python analysis/exploratory_analysis.py
"""
import os
import sqlite3

import matplotlib
matplotlib.use("Agg")  # roda sem display (CI, servidor, etc.)
import matplotlib.pyplot as plt
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(ROOT, "data", "faturamento.db")
OUT_DIR = os.path.join(ROOT, "data", "reports")


def carregar_dados(conn):
    dados_cliente = pd.read_sql("SELECT * FROM v_dados_cliente", conn)
    controle_gestor = pd.read_sql("SELECT * FROM v_controle_gestor", conn)
    controle_vertical = pd.read_sql("SELECT * FROM v_controle_vertical", conn)
    return dados_cliente, controle_gestor, controle_vertical


def resumo_geral(dados_cliente: pd.DataFrame) -> pd.Series:
    """Visao rapida em uma linha: volume, taxa de sucesso, saude da base."""
    total = len(dados_cliente)
    resumo = pd.Series({
        "total_clientes": total,
        "pj_distintos": int(dados_cliente["pj_distinto_oficial"].sum()),
        "pct_pj_distintos": round(100 * dados_cliente["pj_distinto_oficial"].mean(), 1),
        "total_inconsistencias": int(dados_cliente["qtd_planos_inconsistentes"].sum()),
        "clientes_sem_atendimento": int((dados_cliente["status"] == "Sem atendimento").sum()),
        "pct_respondentes_pesquisa": round(100 * dados_cliente["respondeu"].fillna(0).mean(), 1),
    })
    return resumo


def top_gestores_por_inconsistencia(controle_gestor: pd.DataFrame, n: int = 5) -> pd.DataFrame:
    """Gestores com mais inconsistencias -- prioridade de acao (dado que o
    gestor precisaria corrigir lancamentos invalidos com o cliente)."""
    return (
        controle_gestor
        .sort_values("total_inconsistencias", ascending=False)
        .head(n)[["gestor", "vertical", "clientes_na_carteira", "total_inconsistencias", "pj_distintos"]]
    )


def correlacao_resposta_x_faturamento(dados_cliente: pd.DataFrame) -> pd.DataFrame:
    """Clientes que responderam a pesquisa relataram, em media, quanto de
    aumento de faturamento -- comparando quem eh PJ Distinto vs quem nao eh."""
    respondentes = dados_cliente[dados_cliente["respondeu"] == 1].copy()
    return (
        respondentes
        .groupby("pj_distinto_oficial")["aumento_faturamento_pct"]
        .agg(["count", "mean", "median"])
        .rename(index={0: "Nao PJ Distinto", 1: "PJ Distinto"})
        .round(1)
    )


def grafico_pj_distintos_por_vertical(controle_vertical: pd.DataFrame, path: str):
    fig, ax = plt.subplots(figsize=(9, 5))
    dados = controle_vertical.sort_values("pj_distintos", ascending=True)
    ax.barh(dados["vertical"], dados["pj_distintos"], color="#1F3B4D")
    ax.set_xlabel("PJ Distintos")
    ax.set_title("PJ Distintos por Vertical")
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)


def grafico_distribuicao_aumento_faturamento(dados_cliente: pd.DataFrame, path: str):
    respondentes = dados_cliente[dados_cliente["respondeu"] == 1]
    fig, ax = plt.subplots(figsize=(9, 5))
    ax.hist(respondentes["aumento_faturamento_pct"].dropna(), bins=30, color="#2E86AB")
    ax.axvline(respondentes["aumento_faturamento_pct"].mean(), color="#C0392B", linestyle="--",
               label=f"Media: {respondentes['aumento_faturamento_pct'].mean():.1f}%")
    ax.set_xlabel("Aumento de faturamento reportado (%)")
    ax.set_ylabel("Numero de clientes")
    ax.set_title("Distribuicao do aumento de faturamento (clientes respondentes)")
    ax.legend()
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)


def main():
    if not os.path.exists(DB_PATH):
        raise SystemExit("Banco nao encontrado. Rode primeiro: python etl_pipeline.py")

    os.makedirs(OUT_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    try:
        dados_cliente, controle_gestor, controle_vertical = carregar_dados(conn)
    finally:
        conn.close()

    print("=== Resumo geral ===")
    print(resumo_geral(dados_cliente).to_string())

    print("\n=== Top 5 gestores por inconsistencia ===")
    print(top_gestores_por_inconsistencia(controle_gestor).to_string(index=False))

    print("\n=== Aumento de faturamento reportado: PJ Distinto vs demais ===")
    print(correlacao_resposta_x_faturamento(dados_cliente).to_string())

    grafico_pj_distintos_por_vertical(controle_vertical, os.path.join(OUT_DIR, "pj_distintos_por_vertical.png"))
    grafico_distribuicao_aumento_faturamento(dados_cliente, os.path.join(OUT_DIR, "distribuicao_aumento_faturamento.png"))
    print(f"\nGraficos salvos em {OUT_DIR}/")


if __name__ == "__main__":
    main()
