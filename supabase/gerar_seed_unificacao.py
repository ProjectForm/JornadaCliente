"""
Gera supabase/seed_unificacao_2500_clientes.sql a partir dos dados JA
CALCULADOS pelo pipeline principal (data/reports/dados_cliente.csv, produzido
por etl_pipeline.py + sql/queries.sql -- rode `python etl_pipeline.py` antes
se esse arquivo nao existir ou estiver desatualizado) + data/raw/clientes.csv
(para a data de cadastro original).

Isto e uma migracao de dados ONE-SHOT (ETAPA 2.5 -- unificacao de base): os
2500 clientes sinteticos do case tecnico passam a ser a carga inicial do
Cadastro (Supabase), para que Dashboard e Cadastro leiam da MESMA base daqui
pra frente. Nao mexe nos dados reais do pipeline (so LE os CSVs ja gerados).

Como os gestores do dataset estatico (generate_synthetic_data.py) sao
IDENTICOS aos gestores do Cadastro (demo_gestores em supabase/schema_demo.sql
-- mesmos 16 nomes, mesmos gestor_id, mesmas verticais, na mesma ordem), o
mapeamento de gestor e direto (gestor_id -> gestor_id), sem tabela de
conversao.

O Cadastro (demo_atendimentos) usa um modelo mais simples que o pipeline
original (por Centro de Custo, nao por Plano) -- ver
supabase/schema_demo.sql. Este script SINTETIZA, para cada cliente, o menor
conjunto de linhas de demo_atendimentos que reproduz EXATAMENTE o mesmo
status (Concluinte/Participante/Sem atendimento) e a mesma presenca de
inconsistencia que o pipeline original ja calculou -- confirmado por analise
do dataset atual: nenhum cliente tem mais de 1 plano concluido nem mais de 1
plano inconsistente ao mesmo tempo, e os dois nunca coexistem no mesmo
cliente. Isso cobre os 4 casos reais do dataset (405 Concluinte, 20
Participante-com-inconsistencia, 1785 Participante, 290 Sem atendimento).
Nao tenta reproduzir QUAL plano/produto originou o atendimento (o Cadastro
nao tem esse conceito) -- so o resultado agregado que aparece no
Dashboard/KPIs.

Roda local, so le CSVs -- nao precisa de credencial nem toca no Supabase.
O arquivo gerado deve ser colado no SQL Editor do Supabase e rodado, depois
de supabase/schema_demo_v2_operacao.sql e supabase/schema_demo_v3_unificacao.sql.
"""
import csv
import os
import uuid

BASE = os.path.dirname(__file__)
RAIZ = os.path.dirname(BASE)
DADOS_CLIENTE = os.path.join(RAIZ, "data", "reports", "dados_cliente.csv")
CLIENTES_RAW = os.path.join(RAIZ, "data", "raw", "clientes.csv")
SAIDA = os.path.join(BASE, "seed_unificacao_2500_clientes.sql")

LOTE = 250  # linhas por INSERT ... VALUES (mantem cada statement num tamanho razoavel)


def sql_str(v):
    if v is None or v == "":
        return "null"
    return "'" + str(v).replace("'", "''") + "'"


def sql_bool(v):
    return "true" if str(v) == "1" else "false"


def sql_num(v):
    return v if v not in (None, "") else "null"


def carregar():
    with open(DADOS_CLIENTE, encoding="utf-8") as f:
        dados = {r["cliente_id"]: r for r in csv.DictReader(f)}
    with open(CLIENTES_RAW, encoding="utf-8") as f:
        raw = {r["cliente_id"]: r for r in csv.DictReader(f)}
    linhas = []
    for cid, d in dados.items():
        r = raw.get(cid, {})
        linhas.append({**d, "data_cadastro": r.get("data_cadastro", "2025-01-01")})
    return linhas


def montar_lotes(itens, tamanho):
    for i in range(0, len(itens), tamanho):
        yield itens[i : i + tamanho]


def gerar():
    linhas = carregar()
    for linha in linhas:
        linha["_uuid"] = str(uuid.uuid4())

    partes = []
    partes.append("-- ============================================================================")
    partes.append("-- SEED -- ETAPA 2.5 (unificacao de base): carga inicial dos 2500 clientes")
    partes.append("-- sinteticos do case tecnico dentro do Cadastro (Supabase). Gerado por")
    partes.append("-- supabase/gerar_seed_unificacao.py a partir de data/reports/dados_cliente.csv")
    partes.append("-- + data/raw/clientes.csv -- NAO editar a mao, regenerar o script se precisar.")
    partes.append("--")
    partes.append("-- Pre-requisito: schema_demo.sql + schema_demo_v2_operacao.sql +")
    partes.append("-- schema_demo_v3_unificacao.sql ja aplicados (sem teto de 200, sem autolimpeza).")
    partes.append("-- Idempotencia: cada linha usa um UUID fixo gerado neste script -- rodar este")
    partes.append("-- arquivo DUAS VEZES criaria clientes duplicados (nao ha protecao de unicidade")
    partes.append("-- de CNPJ no banco, de proposito -- ver docs/OPERACAO_CADASTRO.md). Rode uma vez so.")
    partes.append("-- ============================================================================")
    partes.append("")

    # 1) demo_clientes
    partes.append("-- 1) Clientes (2500 linhas, em lotes de %d)" % LOTE)
    for lote in montar_lotes(linhas, LOTE):
        partes.append(
            "insert into demo_clientes (id, razao_social, cnpj, porte, gestor_id, municipio, "
            "respondeu, aumento_faturamento_pct, criado_em, atualizado_em) values"
        )
        valores = []
        for l in lote:
            dt = f"{l['data_cadastro']}T12:00:00Z"
            valores.append(
                "  (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)"
                % (
                    sql_str(l["_uuid"]),
                    sql_str(l["razao_social"]),
                    sql_str(l["cnpj"]),
                    sql_str(l["porte"]),
                    l["gestor_id"],
                    sql_str(l["municipio"]),
                    sql_bool(l["respondeu"]),
                    sql_num(l["aumento_faturamento_pct"]),
                    sql_str(dt),
                    sql_str(dt),
                )
            )
        partes.append(",\n".join(valores) + ";")
        partes.append("")

    # 2) demo_atendimentos -- so para quem NAO e "Sem atendimento"
    com_atendimento = [l for l in linhas if l["status"] != "Sem atendimento"]
    partes.append(
        "-- 2) Atendimentos sinteticos (%d clientes com pelo menos 1 registro -- "
        "reproduz o mesmo status/PJ Distinto/inconsistencia ja calculados)" % len(com_atendimento)
    )
    for lote in montar_lotes(com_atendimento, LOTE):
        partes.append(
            "insert into demo_atendimentos (cliente_id, centro_custo_id, "
            "diagnosticos_total, diagnosticos_validos, assessorias_total, assessorias_validos) values"
        )
        valores = []
        for l in lote:
            if l["pj_distinto_oficial"] == "1":
                diag_t, diag_v, ass_t, ass_v = 1, 1, 2, 2  # concluinte
            elif l["qtd_planos_inconsistentes"] == "1":
                diag_t, diag_v, ass_t, ass_v = 1, 0, 2, 1  # concluiria_se_valido, mas nao e
            else:
                diag_t, diag_v, ass_t, ass_v = 1, 0, 1, 0  # participante simples, sem atingir o limiar
            valores.append(f"  ({sql_str(l['_uuid'])}, 1, {diag_t}, {diag_v}, {ass_t}, {ass_v})")
        partes.append(",\n".join(valores) + ";")
        partes.append("")

    # 3) demo_log (IMPORT) + 4) demo_clientes_versoes (INSERT, versao 1) --
    #    derivados diretamente das linhas ja inseridas (to_jsonb no banco,
    #    sem risco de o snapshot desalinhar do schema real da tabela).
    todos_ids = ",".join(sql_str(l["_uuid"]) for l in linhas)
    partes.append("-- 3) Log de auditoria (uma entrada IMPORT por cliente, na data de cadastro original)")
    partes.append(
        "insert into demo_log (cliente_id, operacao, gestor_operador_id, criado_em)\n"
        "select id, 'IMPORT', gestor_id, criado_em\n"
        f"from demo_clientes\nwhere id = any(array[{todos_ids}]::uuid[]);"
    )
    partes.append("")
    partes.append("-- 4) Versao 1 (estado inicial) de cada cliente seedado")
    partes.append(
        "insert into demo_clientes_versoes (cliente_id, versao, operacao, gestor_operador_id, snapshot, criado_em)\n"
        "select dc.id, 1, 'INSERT', dc.gestor_id, to_jsonb(dc), dc.criado_em\n"
        f"from demo_clientes dc\nwhere dc.id = any(array[{todos_ids}]::uuid[]);"
    )
    partes.append("")

    with open(SAIDA, "w", encoding="utf-8") as f:
        f.write("\n".join(partes))

    print(f"OK -- {len(linhas)} clientes, {len(com_atendimento)} com atendimento sintetico.")
    print(f"Arquivo gerado: {SAIDA} ({os.path.getsize(SAIDA) / 1024:.0f} KB)")


if __name__ == "__main__":
    gerar()
