"""
Testes da regra de negocio (classificacao/inconsistencia) e do mock de CNPJ.

Rodar da raiz do projeto:
    pytest
"""
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

from brasilapi_mock import consultar_cnpj_mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA_PATH = os.path.join(ROOT, "sql", "schema.sql")
QUERIES_PATH = os.path.join(ROOT, "sql", "queries.sql")


@pytest.fixture
def conn():
    """Banco SQLite em memoria com um cenario minimo e controlado (nao usa
    o dataset sintetico grande, para os testes serem rapidos e legiveis)."""
    connection = sqlite3.connect(":memory:")
    connection.execute("PRAGMA foreign_keys = ON")
    with open(SCHEMA_PATH, encoding="utf-8") as f:
        connection.executescript(f.read())

    connection.executemany(
        "INSERT INTO gestores (gestor_id, nome, vertical) VALUES (?, ?, ?)",
        [(1, "Gestor Teste", "Comercio e Servicos")],
    )
    connection.executemany(
        "INSERT INTO planos (plano_id, nome, regra, porte_elegivel) VALUES (?, ?, ?, ?)",
        [
            (1, "Plano A - Crescimento", "DIAG_2ASSESSORIA", "MEI|ME|EPP"),
            (4, "Plano D - Sustentabilidade", "QUALQUER_SOLUCAO", "ME|EPP"),
        ],
    )
    connection.executemany(
        "INSERT INTO plano_porte (plano_id, porte) VALUES (?, ?)",
        [(1, "MEI"), (1, "ME"), (1, "EPP"), (4, "ME"), (4, "EPP")],
    )
    connection.executemany(
        "INSERT INTO centros_custo (centro_custo_id, codigo, plano_id) VALUES (?, ?, ?)",
        [(1, "CC-1001", 1), (7, "CC-4001", 4)],
    )
    connection.executemany(
        "INSERT INTO produtos (produto_id, nome, tipo) VALUES (?, ?, ?)",
        [
            (101, "Diagnostico Momento Empresarial", "DIAGNOSTICO"),
            (201, "Assessoria de Negocios", "ASSESSORIA"),
            (401, "Solucao Sustentabilidade Basica", "SUSTENTABILIDADE"),
        ],
    )
    connection.executemany(
        "INSERT INTO clientes (cliente_id, razao_social, cnpj, porte, gestor_id, data_cadastro) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        [
            # 1: cumpriu a regra (1 diag valido + 2 assessorias validas)
            (1, "Cliente Completo Ltda", "10000001000101", "ME", 1, "2025-01-01"),
            # 2: teria cumprido, mas uma assessoria foi marcada invalida -> inconsistente
            (2, "Cliente Inconsistente Ltda", "10000002000102", "ME", 1, "2025-01-01"),
            # 3: sem nenhum atendimento -> "Sem atendimento"
            (3, "Cliente Sem Atendimento Ltda", "10000003000103", "MEI", 1, "2025-01-01"),
        ],
    )
    with open(QUERIES_PATH, encoding="utf-8") as f:
        connection.executescript(f.read())
    connection.commit()
    yield connection
    connection.close()


def _lancar_atendimento(connection, atendimento_id, cliente_id, centro_custo_id, produto_id, valido):
    connection.execute(
        "INSERT INTO atendimentos (atendimento_id, cliente_id, centro_custo_id, produto_id, "
        "data_atendimento, frequencia, atendimento_valido) VALUES (?, ?, ?, ?, '2025-03-01', 1, ?)",
        (atendimento_id, cliente_id, centro_custo_id, produto_id, valido),
    )


def test_cliente_com_um_diagnostico_e_duas_assessorias_validas_e_concluinte(conn):
    _lancar_atendimento(conn, 1, 1, 1, 101, 1)  # diagnostico valido
    _lancar_atendimento(conn, 2, 1, 1, 201, 1)  # assessoria valida
    _lancar_atendimento(conn, 3, 1, 1, 201, 1)  # assessoria valida
    conn.commit()

    status, pj = conn.execute(
        "SELECT status, pj_distinto_oficial FROM v_dados_cliente WHERE cliente_id = 1"
    ).fetchone()
    assert status == "Concluinte"
    assert pj == 1


def test_cliente_com_assessoria_invalida_fica_inconsistente_nao_concluinte(conn):
    _lancar_atendimento(conn, 1, 2, 1, 101, 1)  # diagnostico valido
    _lancar_atendimento(conn, 2, 2, 1, 201, 1)  # assessoria valida
    _lancar_atendimento(conn, 3, 2, 1, 201, 0)  # assessoria INVALIDA
    conn.commit()

    row = conn.execute(
        "SELECT status, pj_distinto_oficial, qtd_planos_inconsistentes FROM v_dados_cliente WHERE cliente_id = 2"
    ).fetchone()
    status, pj, inconsistencias = row
    assert status == "Participante"
    assert pj == 0
    assert inconsistencias == 1


def test_cliente_sem_atendimento_fica_marcado_corretamente(conn):
    status, pj = conn.execute(
        "SELECT status, pj_distinto_oficial FROM v_dados_cliente WHERE cliente_id = 3"
    ).fetchone()
    assert status == "Sem atendimento"
    assert pj == 0


def test_regra_qualquer_solucao_basta_uma_sustentabilidade_valida(conn):
    conn.execute(
        "INSERT INTO clientes (cliente_id, razao_social, cnpj, porte, gestor_id, data_cadastro) "
        "VALUES (4, 'Cliente Sustentabilidade Ltda', '10000004000104', 'ME', 1, '2025-01-01')"
    )
    _lancar_atendimento(conn, 1, 4, 7, 401, 1)
    conn.commit()

    status, pj = conn.execute(
        "SELECT status, pj_distinto_oficial FROM v_dados_cliente WHERE cliente_id = 4"
    ).fetchone()
    assert status == "Concluinte"
    assert pj == 1


def test_controle_por_gestor_agrega_corretamente(conn):
    # Neste cenario, so o cliente 1 recebe atendimento; clientes 2 e 3 ficam
    # sem nenhum lancamento e por isso os dois contam como "Sem atendimento".
    _lancar_atendimento(conn, 1, 1, 1, 101, 1)
    _lancar_atendimento(conn, 2, 1, 1, 201, 1)
    _lancar_atendimento(conn, 3, 1, 1, 201, 1)
    conn.commit()

    row = conn.execute(
        "SELECT clientes_na_carteira, pj_distintos, clientes_sem_atendimento FROM v_controle_gestor WHERE gestor_id = 1"
    ).fetchone()
    clientes_na_carteira, pj_distintos, sem_atendimento = row
    assert clientes_na_carteira == 3
    assert pj_distintos == 1
    assert sem_atendimento == 2


def test_mock_cnpj_e_deterministico_para_o_mesmo_cnpj():
    r1 = consultar_cnpj_mock("10000001000101", "Empresa Teste")
    r2 = consultar_cnpj_mock("10000001000101", "Empresa Teste")
    assert r1["municipio"] == r2["municipio"]
    assert r1["descricao_situacao_cadastral"] == r2["descricao_situacao_cadastral"]


def test_mock_cnpj_retorna_formato_esperado():
    resp = consultar_cnpj_mock("10000001000101", "Empresa Teste")
    campos_esperados = {"cnpj", "razao_social", "municipio", "uf", "descricao_situacao_cadastral",
                         "data_situacao_cadastral", "fonte"}
    assert campos_esperados.issubset(resp.keys())
    assert resp["uf"] == "SP"
