"""
Regra de permissao: um gestor pode editar/excluir/reatribuir um cliente se
ele proprio for o gestor responsavel OU se estiver na mesma vertical do
gestor responsavel (ex.: Cris, Simone e Gui Tresso, parceiros de vertical,
podem mexer nas linhas uns dos outros).
"""
import sqlite3


def pode_editar(conn: sqlite3.Connection, gestor_operador_id: int, cliente_id: int) -> bool:
    row = conn.execute(
        """
        SELECT go.vertical, gc.vertical
        FROM clientes c
        JOIN gestores gc ON gc.gestor_id = c.gestor_id
        JOIN gestores go ON go.gestor_id = ?
        WHERE c.cliente_id = ?
        """,
        (gestor_operador_id, cliente_id),
    ).fetchone()
    if row is None:
        raise ValueError(f"Cliente #{cliente_id} ou gestor operador #{gestor_operador_id} nao encontrado")
    vertical_operador, vertical_responsavel = row
    return vertical_operador == vertical_responsavel


def exige_permissao(conn: sqlite3.Connection, gestor_operador_id: int, cliente_id: int) -> None:
    if not pode_editar(conn, gestor_operador_id, cliente_id):
        raise PermissionError(
            f"Gestor #{gestor_operador_id} nao tem permissao sobre o cliente #{cliente_id} "
            "(gestor responsavel esta em outra vertical)"
        )
