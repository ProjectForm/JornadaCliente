# Modelo de Dados e Medidas DAX — Power BI Desktop

## 1. Conexao
O Power BI Desktop nao tem conector nativo para SQLite. Duas formas de conectar:
1. Via ODBC (driver "SQLite ODBC Driver" + DSN apontando pro faturamento.db).
2. Via Python/Pandas (recomendado): usar o conector "Script Python" do Power BI:
   import sqlite3, pandas as pd
   conn = sqlite3.connect(r"C:\caminho\data\faturamento.db")
   dados_cliente = pd.read_sql("SELECT * FROM v_dados_cliente", conn)
   controle_gestor = pd.read_sql("SELECT * FROM v_controle_gestor", conn)
   controle_vertical = pd.read_sql("SELECT * FROM v_controle_vertical", conn)
   gestores = pd.read_sql("SELECT * FROM gestores", conn)
   log_alteracoes = pd.read_sql("SELECT * FROM log_alteracoes", conn)

Atualizacao: rode `python etl_pipeline.py` apos nova base de atendimentos, ou
use o CLI do gestor (`python adicionar_cliente.py`) para incluir/editar/excluir
clientes direto no banco -- toda operacao de escrita ja reexporta os CSVs em
`data/reports/`. Depois e so clicar "Atualizar" no Power BI (ou apontar
direto pra `data/reports/*.csv`, que e o formato mais simples de conectar).

## 2. Tabelas do modelo
- Clientes <- v_dados_cliente (fato, 1 linha por cliente; ja filtra clientes
  excluidos via soft delete, `ativo = 1`)
- Gestores <- gestores (dimensao)
- ControlePorGestor <- v_controle_gestor (agregado)
- ControlePorVertical <- v_controle_vertical (agregado)
- Planos / CentrosCusto <- planos / centros_custo (dimensoes de regra)
- LogAlteracoes <- log_alteracoes (auditoria: toda inclusao/edicao/exclusao
  feita pelos gestores via CLI, com quem alterou, quando, e valor antigo/novo)

## 3. Relacionamentos
Gestores[gestor_id] 1 -- * Clientes[gestor_id]
Gestores[gestor_id] 1 -- 1 ControlePorGestor[gestor_id]
Gestores[gestor_id] 1 -- * LogAlteracoes[gestor_id_operador]

## 4. Medidas DAX principais
Total Clientes = COUNTROWS(Clientes)
PJ Distintos = SUM(Clientes[pj_distinto_oficial])
% PJ Distintos = DIVIDE([PJ Distintos], [Total Clientes], 0)
Total Inconsistencias = SUM(Clientes[qtd_planos_inconsistentes])
Clientes Sem Atendimento = CALCULATE(COUNTROWS(Clientes), Clientes[status] = "Sem atendimento")
Respondeu Pesquisa = SUM(Clientes[respondeu])
% Respondentes = DIVIDE([Respondeu Pesquisa], [Total Clientes], 0)
Media Aumento Faturamento =
    AVERAGEX(FILTER(Clientes, Clientes[respondeu] = 1), Clientes[aumento_faturamento_pct])
Meta PJ Distintos = 100
Falta para Meta = MAX([Meta PJ Distintos] - [PJ Distintos], 0)
Status Semaforo =
    VAR pct = [% PJ Distintos]
    RETURN SWITCH(TRUE(), pct >= 1, "Meta atingida", pct >= 0.7, "Proximo da meta", "Abaixo da meta")

## 5. Visuais sugeridos
- Cartoes de KPI: Total Clientes, PJ Distintos, % PJ Distintos, Total Inconsistencias, % Respondentes, Media Aumento.
- Matriz Gestor x Vertical com PJ Distintos, Total Inconsistencias, Falta para Meta.
- Grafico de colunas por Vertical: PJ Distintos vs Meta.
- Distribuicao de aumento de faturamento entre quem respondeu.
- Segmentacao por Vertical, Gestor, Status.
- Pagina de detalhe por cliente com drill-through.
- Pagina de auditoria: LogAlteracoes por gestor/vertical/operacao (INSERT/UPDATE/DELETE)
  ao longo do tempo -- mostra quem mexeu em que carteira, incluindo edicoes
  entre gestores parceiros de vertical.

## 6. Por que separar em views SQL em vez de fazer tudo em DAX
A regra de negocio ja esta resolvida nas views (v_classificacao_plano /
v_inconsistencia_plano). Isso evita recriar a logica de contagem condicional
em DAX, que ficaria tao complexa quanto as formulas Excel originais.
