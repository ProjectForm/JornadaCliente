"""
CLI do gestor: incluir cliente/atendimento diretamente no sistema, editar
dados cadastrais, reatribuir gestor responsavel e excluir cliente/atendimento
-- sem precisar esperar a proxima exportacao completa do BI.

Regra de permissao (ver permissoes.py): um gestor so pode editar/excluir/
reatribuir um cliente se ele mesmo for o gestor responsavel, ou se o gestor
responsavel estiver na mesma vertical dele (parceiros de vertical podem
mexer nas linhas uns dos outros). Toda alteracao fica registrada em
log_alteracoes. Toda operacao de escrita recria as views e reexporta os
CSVs de data/reports/, para que o Power BI reflita a mudanca no proximo
refresh.

Cada funcao aceita um `conn` opcional (usado pelos testes, com um banco
em memoria) -- quando omitido, abre e fecha uma conexao com o banco real
do projeto (etl_pipeline.DB_PATH), que e o caso de uso do CLI interativo.

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
from etl_pipeline import DB_PATH, criar_views, exportar_relatorios
from permissoes import exige_permissao

PORTES_VALIDOS = ("MEI", "ME", "EPP", "MEDIA", "GRANDE")
CAMPOS_EDITAVEIS_CLIENTE = ("razao_social", "porte", "municipio")


def _conectar(conn):
    """Se conn for None, abre uma conexao nova com o banco do projeto (uso do
    CLI); caso contrario, reusa a conexao recebida (uso em testes, banco em
    memoria). Retorna (connection, deve_fechar)."""
    if conn is not None:
        return conn, False
    return sqlite3.connect(DB_PATH), True


def _sync_bi(conn: sqlite3.Connection, exportar: bool = True) -> None:
    """Recria as views de classificacao e, por padrao, reexporta os CSVs que
    o Power BI le (data/reports/*.csv). exportar=False evita esse efeito
    colateral em disco quando quem esta escrevendo e um teste."""
    criar_views(conn)
    if exportar:
        exportar_relatorios(conn)


def _registrar_log(conn, tabela, registro_id, operacao, gestor_operador_id,
                    campo=None, valor_antigo=None, valor_novo=None) -> None:
    novo_id = (conn.execute("SELECT MAX(log_id) FROM log_alteracoes").fetchone()[0] or 0) + 1
    conn.execute(
        "INSERT INTO log_alteracoes (log_id, tabela, registro_id, operacao, campo, valor_antigo, "
        "valor_novo, gestor_id_operador, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (novo_id, tabela, registro_id, operacao, campo, valor_antigo, valor_novo,
         gestor_operador_id, time.strftime("%Y-%m-%d %H:%M:%S")),
    )


def adicionar_cliente(razao_social: str, cnpj: str, porte: str, gestor_id: int,
                       conn=None, exportar_bi: bool = True) -> int:
    """Inclui um cliente novo, atribuido ao proprio gestor que esta incluindo."""
    if porte not in PORTES_VALIDOS:
        raise ValueError(f"Porte invalido: {porte}")

    connection, deve_fechar = _conectar(conn)
    try:
        cur = connection.execute("SELECT MAX(cliente_id) FROM clientes")
        novo_id = (cur.fetchone()[0] or 0) + 1

        connection.execute(
            "INSERT INTO clientes (cliente_id, razao_social, cnpj, porte, gestor_id, data_cadastro) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (novo_id, razao_social, cnpj, porte, gestor_id, time.strftime("%Y-%m-%d")),
        )

        resp = consultar_cnpj_mock(cnpj, razao_social)
        connection.execute(
            "UPDATE clientes SET municipio = ?, razao_social_api = ?, api_consultado_em = ? WHERE cliente_id = ?",
            (resp["municipio"], resp["razao_social"], time.strftime("%Y-%m-%d %H:%M:%S"), novo_id),
        )
        _registrar_log(connection, "clientes", novo_id, "INSERT", gestor_id)
        connection.commit()

        _sync_bi(connection, exportar=exportar_bi)
        connection.commit()

        status = connection.execute(
            "SELECT status, pj_distinto_oficial FROM v_dados_cliente WHERE cliente_id = ?", (novo_id,)
        ).fetchone()
        print(f"Cliente #{novo_id} incluido. Status atual: {status[0]} | PJ Distinto: {bool(status[1])}")
        print("(sem atendimentos lancados ainda -- status inicial sempre 'Sem atendimento')")
        return novo_id
    finally:
        if deve_fechar:
            connection.close()


def adicionar_atendimento(cliente_id: int, centro_custo_id: int, produto_id: int,
                           gestor_operador_id: int, valido: int = 1,
                           conn=None, exportar_bi: bool = True) -> None:
    connection, deve_fechar = _conectar(conn)
    try:
        exige_permissao(connection, gestor_operador_id, cliente_id)

        cur = connection.execute("SELECT MAX(atendimento_id) FROM atendimentos")
        novo_id = (cur.fetchone()[0] or 0) + 1
        connection.execute(
            "INSERT INTO atendimentos (atendimento_id, cliente_id, centro_custo_id, produto_id, "
            "data_atendimento, frequencia, atendimento_valido) VALUES (?, ?, ?, ?, ?, 1, ?)",
            (novo_id, cliente_id, centro_custo_id, produto_id, time.strftime("%Y-%m-%d"), valido),
        )
        _registrar_log(connection, "atendimentos", novo_id, "INSERT", gestor_operador_id)
        connection.commit()

        _sync_bi(connection, exportar=exportar_bi)
        connection.commit()

        status = connection.execute(
            "SELECT status, pj_distinto_oficial, qtd_planos_inconsistentes FROM v_dados_cliente WHERE cliente_id = ?",
            (cliente_id,),
        ).fetchone()
        print(f"Atendimento #{novo_id} lancado para o cliente #{cliente_id}.")
        print(f"Status recalculado -> status={status[0]} pj_distinto={bool(status[1])} inconsistencias={status[2]}")
    finally:
        if deve_fechar:
            connection.close()


def editar_cliente(cliente_id: int, gestor_operador_id: int, conn=None,
                    exportar_bi: bool = True, **campos) -> None:
    """Edita dados cadastrais do cliente. Campos aceitos: razao_social, porte, municipio."""
    campos_invalidos = set(campos) - set(CAMPOS_EDITAVEIS_CLIENTE)
    if campos_invalidos:
        raise ValueError(f"Campos nao editaveis: {sorted(campos_invalidos)}")
    if not campos:
        raise ValueError("Nenhum campo informado para edicao")
    if "porte" in campos and campos["porte"] not in PORTES_VALIDOS:
        raise ValueError(f"Porte invalido: {campos['porte']}")

    connection, deve_fechar = _conectar(conn)
    try:
        exige_permissao(connection, gestor_operador_id, cliente_id)

        nomes_campos = list(campos.keys())
        atual = connection.execute(
            f"SELECT {', '.join(nomes_campos)} FROM clientes WHERE cliente_id = ?", (cliente_id,)
        ).fetchone()
        if atual is None:
            raise ValueError(f"Cliente #{cliente_id} nao encontrado")

        campos_alterados = []
        for campo, valor_antigo in zip(nomes_campos, atual):
            valor_novo = campos[campo]
            if valor_novo == valor_antigo:
                continue
            connection.execute(f"UPDATE clientes SET {campo} = ? WHERE cliente_id = ?", (valor_novo, cliente_id))
            _registrar_log(connection, "clientes", cliente_id, "UPDATE", gestor_operador_id,
                            campo=campo, valor_antigo=str(valor_antigo), valor_novo=str(valor_novo))
            campos_alterados.append(campo)
        connection.commit()

        if not campos_alterados:
            print(f"Cliente #{cliente_id}: nenhum valor mudou.")
            return

        _sync_bi(connection, exportar=exportar_bi)
        connection.commit()
        print(f"Cliente #{cliente_id} atualizado ({', '.join(campos_alterados)}).")
    finally:
        if deve_fechar:
            connection.close()


def reatribuir_gestor(cliente_id: int, gestor_operador_id: int, novo_gestor_id: int,
                       conn=None, exportar_bi: bool = True) -> None:
    connection, deve_fechar = _conectar(conn)
    try:
        exige_permissao(connection, gestor_operador_id, cliente_id)

        if connection.execute("SELECT 1 FROM gestores WHERE gestor_id = ?", (novo_gestor_id,)).fetchone() is None:
            raise ValueError(f"Gestor #{novo_gestor_id} nao encontrado")

        atual = connection.execute("SELECT gestor_id FROM clientes WHERE cliente_id = ?", (cliente_id,)).fetchone()
        if atual is None:
            raise ValueError(f"Cliente #{cliente_id} nao encontrado")
        gestor_antigo_id = atual[0]

        if gestor_antigo_id == novo_gestor_id:
            print("Cliente ja esta com esse gestor responsavel.")
            return

        connection.execute("UPDATE clientes SET gestor_id = ? WHERE cliente_id = ?", (novo_gestor_id, cliente_id))
        _registrar_log(connection, "clientes", cliente_id, "UPDATE", gestor_operador_id,
                        campo="gestor_id", valor_antigo=str(gestor_antigo_id), valor_novo=str(novo_gestor_id))
        connection.commit()

        _sync_bi(connection, exportar=exportar_bi)
        connection.commit()
        print(f"Cliente #{cliente_id} reatribuido: gestor #{gestor_antigo_id} -> #{novo_gestor_id}.")
    finally:
        if deve_fechar:
            connection.close()


def excluir_cliente(cliente_id: int, gestor_operador_id: int, conn=None,
                     exportar_bi: bool = True) -> None:
    connection, deve_fechar = _conectar(conn)
    try:
        exige_permissao(connection, gestor_operador_id, cliente_id)

        atual = connection.execute("SELECT ativo FROM clientes WHERE cliente_id = ?", (cliente_id,)).fetchone()
        if atual is None:
            raise ValueError(f"Cliente #{cliente_id} nao encontrado")
        if atual[0] == 0:
            print(f"Cliente #{cliente_id} ja estava excluido.")
            return

        connection.execute("UPDATE clientes SET ativo = 0 WHERE cliente_id = ?", (cliente_id,))
        _registrar_log(connection, "clientes", cliente_id, "DELETE", gestor_operador_id)
        connection.commit()

        _sync_bi(connection, exportar=exportar_bi)
        connection.commit()
        print(f"Cliente #{cliente_id} excluido (soft delete -- some do dashboard, historico preservado).")
    finally:
        if deve_fechar:
            connection.close()


def excluir_atendimento(atendimento_id: int, gestor_operador_id: int, conn=None,
                         exportar_bi: bool = True) -> None:
    connection, deve_fechar = _conectar(conn)
    try:
        row = connection.execute(
            "SELECT cliente_id, ativo FROM atendimentos WHERE atendimento_id = ?", (atendimento_id,)
        ).fetchone()
        if row is None:
            raise ValueError(f"Atendimento #{atendimento_id} nao encontrado")
        cliente_id, ativo = row

        exige_permissao(connection, gestor_operador_id, cliente_id)

        if ativo == 0:
            print(f"Atendimento #{atendimento_id} ja estava excluido.")
            return

        connection.execute("UPDATE atendimentos SET ativo = 0 WHERE atendimento_id = ?", (atendimento_id,))
        _registrar_log(connection, "atendimentos", atendimento_id, "DELETE", gestor_operador_id)
        connection.commit()

        _sync_bi(connection, exportar=exportar_bi)
        connection.commit()
        print(f"Atendimento #{atendimento_id} excluido (soft delete).")
    finally:
        if deve_fechar:
            connection.close()


def login_gestor(conn: sqlite3.Connection):
    """Simula a identidade do gestor logado: escolha por ID, sem senha."""
    print("\nGestores cadastrados:")
    for gestor_id, nome, vertical in conn.execute("SELECT gestor_id, nome, vertical FROM gestores ORDER BY gestor_id"):
        print(f"  {gestor_id:>3} | {nome:<20} | {vertical}")
    gestor_id = int(input("Seu ID de gestor: ").strip())
    row = conn.execute("SELECT nome, vertical FROM gestores WHERE gestor_id = ?", (gestor_id,)).fetchone()
    if row is None:
        raise ValueError(f"Gestor #{gestor_id} nao encontrado")
    nome, vertical = row
    print(f"Logado como {nome} ({vertical}).")
    return gestor_id, nome, vertical


def _menu_interativo():
    if not os.path.exists(DB_PATH):
        print("Banco nao encontrado. Rode primeiro: python etl_pipeline.py")
        return

    conn = sqlite3.connect(DB_PATH)
    try:
        gestor_id, nome, vertical = login_gestor(conn)
    finally:
        conn.close()

    while True:
        print("\n=== Sistema do Gestor - Carteira de Clientes ===")
        print(f"(logado como {nome} - {vertical})")
        print("1) Incluir cliente")
        print("2) Lancar atendimento")
        print("3) Editar dados cadastrais de cliente")
        print("4) Reatribuir gestor responsavel")
        print("5) Excluir cliente")
        print("6) Excluir atendimento")
        print("7) Listar meus clientes e parceiros de vertical")
        print("0) Sair")
        opcao = input("Opcao: ").strip()

        try:
            if opcao == "1":
                razao_social = input("Razao social: ").strip()
                cnpj = input("CNPJ (14 digitos): ").strip()
                porte = input("Porte (MEI/ME/EPP/MEDIA/GRANDE): ").strip().upper()
                adicionar_cliente(razao_social, cnpj, porte, gestor_id)
            elif opcao == "2":
                cliente_id = int(input("ID do cliente: ").strip())
                centro_custo_id = int(input("ID do centro de custo: ").strip())
                produto_id = int(input("ID do produto: ").strip())
                adicionar_atendimento(cliente_id, centro_custo_id, produto_id, gestor_id)
            elif opcao == "3":
                cliente_id = int(input("ID do cliente: ").strip())
                print("Deixe em branco para nao alterar o campo.")
                campos = {}
                nova_razao = input("Nova razao social: ").strip()
                if nova_razao:
                    campos["razao_social"] = nova_razao
                novo_porte = input("Novo porte (MEI/ME/EPP/MEDIA/GRANDE): ").strip().upper()
                if novo_porte:
                    campos["porte"] = novo_porte
                novo_municipio = input("Novo municipio: ").strip()
                if novo_municipio:
                    campos["municipio"] = novo_municipio
                if campos:
                    editar_cliente(cliente_id, gestor_id, **campos)
                else:
                    print("Nada informado.")
            elif opcao == "4":
                cliente_id = int(input("ID do cliente: ").strip())
                novo_gestor_id = int(input("ID do novo gestor responsavel: ").strip())
                reatribuir_gestor(cliente_id, gestor_id, novo_gestor_id)
            elif opcao == "5":
                cliente_id = int(input("ID do cliente: ").strip())
                excluir_cliente(cliente_id, gestor_id)
            elif opcao == "6":
                atendimento_id = int(input("ID do atendimento: ").strip())
                excluir_atendimento(atendimento_id, gestor_id)
            elif opcao == "7":
                conn = sqlite3.connect(DB_PATH)
                try:
                    linhas = conn.execute(
                        "SELECT cliente_id, razao_social, gestor, status FROM v_dados_cliente "
                        "WHERE vertical = ? ORDER BY gestor, razao_social",
                        (vertical,),
                    ).fetchall()
                finally:
                    conn.close()
                print(f"\nClientes da vertical '{vertical}':")
                for cid, razao, gestor_nome, status in linhas:
                    print(f"  #{cid:<5} {razao:<35} gestor={gestor_nome:<15} status={status}")
            elif opcao == "0":
                print("Ate mais.")
                break
            else:
                print("Opcao invalida.")
        except (ValueError, PermissionError) as e:
            print(f"Erro: {e}")


if __name__ == "__main__":
    _menu_interativo()
