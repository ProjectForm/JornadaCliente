"""
Testes da regra de negocio (classificacao/inconsistencia) e do mock de CNPJ.

Rodar da raiz do projeto:
    pytest
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from brasilapi_mock import consultar_cnpj_mock


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
