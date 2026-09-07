"""
Gera os JSONs estaticos que alimentam o site em web/ (dashboard publicado no
Vercel). Le data/reports/*.csv (ja produzidos por etl_pipeline.py) e nao
recalcula nenhuma regra de negocio -- so agrega/serializa o que as views SQL
ja resolveram.

Exporta tambem a base de clientes inteira (clientes.json) para a tabela
navegavel (busca/filtro/paginacao) do site -- so os campos usados na tela,
para manter o arquivo leve. O drill-through com todas as colunas e o
historico de planos fica a cargo do relatorio Power BI publicado.

Uso:
    python etl_pipeline.py       # gera data/reports/*.csv
    python export_web_data.py    # gera web/data/*.json a partir deles
"""
import csv
import json
import os

ROOT = os.path.dirname(__file__)
REPORT_DIR = os.path.join(ROOT, "data", "reports")
WEB_DATA_DIR = os.path.join(ROOT, "web", "data")


def _ler_csv(nome):
    path = os.path.join(REPORT_DIR, nome)
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _num(valor, tipo=float):
    if valor is None or valor == "":
        return None
    return tipo(valor)


def gerar_resumo(dados_cliente):
    total_clientes = len(dados_cliente)
    pj_distintos = sum(int(c["pj_distinto_oficial"]) for c in dados_cliente)
    total_inconsistencias = sum(int(c["qtd_planos_inconsistentes"]) for c in dados_cliente)
    respondeu = sum(int(c["respondeu"]) for c in dados_cliente if c["respondeu"] != "")
    aumentos = [float(c["aumento_faturamento_pct"]) for c in dados_cliente
                if c["respondeu"] == "1" and c["aumento_faturamento_pct"] not in ("", None)]

    status_contagem = {}
    for c in dados_cliente:
        status_contagem[c["status"]] = status_contagem.get(c["status"], 0) + 1

    return {
        "total_clientes": total_clientes,
        "pj_distintos": pj_distintos,
        "pct_pj_distintos": round(100 * pj_distintos / total_clientes, 1) if total_clientes else 0,
        "total_inconsistencias": total_inconsistencias,
        "respondeu_pesquisa": respondeu,
        "pct_respondentes": round(100 * respondeu / total_clientes, 1) if total_clientes else 0,
        "media_aumento_faturamento_pct": round(sum(aumentos) / len(aumentos), 1) if aumentos else None,
        "status_contagem": status_contagem,
    }


CAMPOS_CLIENTE_WEB = (
    "cliente_id", "razao_social", "cnpj", "porte", "municipio",
    "gestor", "vertical", "status", "pj_distinto_oficial",
)


def gerar_clientes(dados_cliente):
    return [{campo: c[campo] for campo in CAMPOS_CLIENTE_WEB} for c in dados_cliente]


def main():
    os.makedirs(WEB_DATA_DIR, exist_ok=True)

    dados_cliente = _ler_csv("dados_cliente.csv")
    controle_vertical = _ler_csv("controle_vertical.csv")
    controle_gestor = _ler_csv("controle_gestor.csv")
    log_alteracoes = _ler_csv("log_alteracoes.csv")

    exports = {
        "resumo.json": gerar_resumo(dados_cliente),
        "controle_vertical.json": controle_vertical,
        "controle_gestor.json": controle_gestor,
        "log_alteracoes.json": list(reversed(log_alteracoes))[:20],  # mais recentes primeiro
        "clientes.json": gerar_clientes(dados_cliente),
    }

    for nome, conteudo in exports.items():
        with open(os.path.join(WEB_DATA_DIR, nome), "w", encoding="utf-8") as f:
            json.dump(conteudo, f, ensure_ascii=False, indent=2)
        print(f"  web/data/{nome}")

    print("OK - dados do site gerados em web/data/")


if __name__ == "__main__":
    main()
