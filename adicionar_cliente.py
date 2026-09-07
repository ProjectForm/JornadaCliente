"""
Interface simples para o GESTOR incluir um novo cliente diretamente no
sistema, sem precisar esperar a proxima exportacao completa do BI.

Uso interativo:
    python adicionar_cliente.py

Uso programatico:
    from adicionar_cliente import adicionar_cliente
    adicionar_cliente(razao_social="Comercial Exemplo Ltda", cnpj="12345678000199",
                       porte="ME", gestor_id=3)
"""
import sqlite3
import time
import os

from brasilapi_mock import consultar_cnpj_mock
from etl_pipeline import DB_PATH, criar_views


def adicionar_cliente(razao_social: str, cnpj: str, porte: str, gestor_id: int) -> int:
    if porte not in ("MEI", "ME", "EPP", "MEDIA", "GRANDE"):
        raise ValueError(f"Porte invalido: {porte}")

    conn = sqlite3.connect(DB_PATH)
    try:
        cur = conn.execute("SELECT MAX(cliente_id) FROM clientes")
        novo_id = (cur.fetchone()[0] or 0) + 1

        conn.execute(
            "INSERT INTO clientes (cliente_id, razao_social, cnpj, porte, gestor_id, data_cadastro) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (novo_id, razao_social, cnpj, porte, gestor_id, time.strftime("%Y-%m-%d")),
        )

        resp = consultar_cnpj_mock(cnpj, razao_social)
        conn.execute(
            "UPDATE clientes SET municipio = ?, razao_social_api = ?, api_consultado_em = ? WHERE cliente_id = ?",
            (resp["municipio"], resp["razao_social"], time.strftime("%Y-%m-%d %H:%M:%S"), novo_id),
        )
        conn.commit()

        criar_views(conn)
        conn.commit()

        status = conn.execute(
            "SELECT status, pj_distinto_oficial FROM v_dados_cliente WHERE cliente_id = ?", (novo_id,)
        ).fetchone()
        print(f"Cliente #{novo_id} incluido. Status atual: {status[0]} | PJ Distinto: {bool(status[1])}")
        print("(sem atendimentos lancados ainda -- status inicial sempre 'Sem atendimento')")
        return novo_id
    finally:
        conn.close()


def adicionar_atendimento(cliente_id: int, centro_custo_id: int, produto_id: int, valido: int = 1):
    conn = sqlite3.connect(DB_PATH)
    try:
        cur = conn.execute("SELECT MAX(atendimento_id) FROM atendimentos")
        novo_id = (cur.fetchone()[0] or 0) + 1
        conn.execute(
            "INSERT INTO atendimentos (atendimento_id, cliente_id, centro_custo_id, produto_id, "
            "data_atendimento, frequencia, atendimento_valido) VALUES (?, ?, ?, ?, ?, 1, ?)",
            (novo_id, cliente_id, centro_custo_id, produto_id, time.strftime("%Y-%m-%d"), valido),
        )
        conn.commit()
        criar_views(conn)
        conn.commit()
        status = conn.execute(
            "SELECT status, pj_distinto_oficial, qtd_planos_inconsistentes FROM v_dados_cliente WHERE cliente_id = ?",
            (cliente_id,),
        ).fetchone()
        print(f"Atendimento #{novo_id} lancado para o cliente #{cliente_id}.")
        print(f"Status recalculado -> status={status[0]} pj_distinto={bool(status[1])} inconsistencias={status[2]}")
    finally:
        conn.close()


def _menu_interativo():
    if not os.path.exists(DB_PATH):
        print("Banco nao encontrado. Rode primeiro: python etl_pipeline.py")
        return
    print("=== Incluir novo cliente ===")
    razao_social = input("Razao social: ").strip()
    cnpj = input("CNPJ (14 digitos): ").strip()
    porte = input("Porte (MEI/ME/EPP/MEDIA/GRANDE): ").strip().upper()
    gestor_id = int(input("ID do gestor responsavel: ").strip())
    adicionar_cliente(razao_social, cnpj, porte, gestor_id)


if __name__ == "__main__":
    _menu_interativo()
