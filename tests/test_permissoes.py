"""
Testes da regra de permissao (gestor dono ou parceiro de vertical), soft
delete e log de auditoria.

Rodar da raiz do projeto:
    pytest
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

from permissoes import exige_permissao, pode_editar


def _add_gestor(conn, gestor_id, nome, vertical):
    conn.execute(
        "INSERT INTO gestores (gestor_id, nome, vertical) VALUES (?, ?, ?)",
        (gestor_id, nome, vertical),
    )


def test_dono_pode_editar_proprio_cliente(conn):
    # cliente_id=1 pertence ao gestor_id=1 (fixture padrao)
    assert pode_editar(conn, 1, 1) is True


def test_parceiro_de_vertical_pode_editar(conn):
    _add_gestor(conn, 2, "Colega Vertical", "Comercio e Servicos")  # mesma vertical do gestor 1
    conn.commit()
    assert pode_editar(conn, 2, 1) is True


def test_gestor_de_outra_vertical_nao_pode_editar(conn):
    _add_gestor(conn, 3, "Gestor Outra Vertical", "Tecnologia e Inovacao")
    conn.commit()
    assert pode_editar(conn, 3, 1) is False
    with pytest.raises(PermissionError):
        exige_permissao(conn, 3, 1)


def test_editar_cliente_grava_log_e_atualiza_dado(conn):
    from adicionar_cliente import editar_cliente

    editar_cliente(1, 1, conn=conn, exportar_bi=False, razao_social="Novo Nome Ltda")

    razao = conn.execute("SELECT razao_social FROM clientes WHERE cliente_id = 1").fetchone()[0]
    assert razao == "Novo Nome Ltda"

    log = conn.execute(
        "SELECT tabela, registro_id, operacao, campo, valor_novo, gestor_id_operador "
        "FROM log_alteracoes WHERE tabela = 'clientes' AND registro_id = 1 AND campo = 'razao_social'"
    ).fetchone()
    assert log == ("clientes", 1, "UPDATE", "razao_social", "Novo Nome Ltda", 1)


def test_editar_cliente_de_outra_vertical_levanta_permission_error(conn):
    _add_gestor(conn, 3, "Gestor Outra Vertical", "Tecnologia e Inovacao")
    conn.commit()
    from adicionar_cliente import editar_cliente

    with pytest.raises(PermissionError):
        editar_cliente(1, 3, conn=conn, exportar_bi=False, razao_social="Nao devia mudar")


def test_excluir_cliente_soft_delete_some_do_dashboard(conn):
    from adicionar_cliente import excluir_cliente

    excluir_cliente(1, 1, conn=conn, exportar_bi=False)

    ativo = conn.execute("SELECT ativo FROM clientes WHERE cliente_id = 1").fetchone()[0]
    assert ativo == 0

    row = conn.execute("SELECT 1 FROM v_dados_cliente WHERE cliente_id = 1").fetchone()
    assert row is None

    log = conn.execute(
        "SELECT operacao FROM log_alteracoes WHERE tabela = 'clientes' AND registro_id = 1 AND operacao = 'DELETE'"
    ).fetchone()
    assert log is not None


def test_excluir_atendimento_deixa_de_contar_na_regra(conn):
    from adicionar_cliente import excluir_atendimento

    conn.execute(
        "INSERT INTO atendimentos (atendimento_id, cliente_id, centro_custo_id, produto_id, "
        "data_atendimento, frequencia, atendimento_valido) VALUES (1, 1, 1, 101, '2025-03-01', 1, 1)"
    )
    conn.execute(
        "INSERT INTO atendimentos (atendimento_id, cliente_id, centro_custo_id, produto_id, "
        "data_atendimento, frequencia, atendimento_valido) VALUES (2, 1, 1, 201, '2025-03-01', 1, 1)"
    )
    conn.execute(
        "INSERT INTO atendimentos (atendimento_id, cliente_id, centro_custo_id, produto_id, "
        "data_atendimento, frequencia, atendimento_valido) VALUES (3, 1, 1, 201, '2025-03-01', 1, 1)"
    )
    conn.commit()

    status = conn.execute("SELECT status FROM v_dados_cliente WHERE cliente_id = 1").fetchone()[0]
    assert status == "Concluinte"

    excluir_atendimento(3, 1, conn=conn, exportar_bi=False)  # remove uma das duas assessorias validas

    status = conn.execute("SELECT status FROM v_dados_cliente WHERE cliente_id = 1").fetchone()[0]
    assert status == "Participante"


def test_reatribuir_gestor_grava_log(conn):
    from adicionar_cliente import reatribuir_gestor

    _add_gestor(conn, 2, "Colega Vertical", "Comercio e Servicos")
    conn.commit()

    reatribuir_gestor(1, 1, 2, conn=conn, exportar_bi=False)

    gestor_id = conn.execute("SELECT gestor_id FROM clientes WHERE cliente_id = 1").fetchone()[0]
    assert gestor_id == 2

    log = conn.execute(
        "SELECT valor_antigo, valor_novo FROM log_alteracoes "
        "WHERE tabela = 'clientes' AND registro_id = 1 AND campo = 'gestor_id'"
    ).fetchone()
    assert log == ("1", "2")


def test_adicionar_cliente_grava_log_insert(conn):
    from adicionar_cliente import adicionar_cliente

    novo_id = adicionar_cliente("Cliente Novo Ltda", "10000099000199", "ME", 1, conn=conn, exportar_bi=False)

    log = conn.execute(
        "SELECT operacao FROM log_alteracoes WHERE tabela = 'clientes' AND registro_id = ?", (novo_id,)
    ).fetchone()
    assert log == ("INSERT",)
