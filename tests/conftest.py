"""
Fixture compartilhada: banco SQLite em memoria com um cenario minimo e
controlado (nao usa o dataset sintetico grande), para os testes serem
rapidos e legiveis. Descoberta automaticamente pelo pytest para qualquer
arquivo de teste dentro de tests/.
"""
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA_PATH = os.path.join(ROOT, "sql", "schema.sql")
QUERIES_PATH = os.path.join(ROOT, "sql", "queries.sql")


@pytest.fixture
def conn():
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
