# Modelo de Dados e Power BI

> **Opcional, não uma dependência.** O produto funciona por conta própria
> (site + Supabase + pipeline SQL/Python) sem depender do Power BI. Esta
> camada é uma demonstração adicional de competência com a ferramenta —
> pode ser incorporada (embed no site) quando fizer sentido, mas nada aqui
> é pré-requisito para o funcionamento do Cadastro/Dashboard.

## Problema que resolve

Com várias verticais, cada uma controlando sua carteira do jeito próprio,
não dá para responder com confiança "quantos clientes já concluíram?" ou
"quantos têm lançamento inconsistente?" sem cruzar planilhas manualmente.
O Power BI é a camada final de leitura: um relatório único, alimentado
pela mesma regra de negócio para todo mundo, em vez de cada gestor
recalcular por conta própria.

## Passo a passo (como foi feito)

1. **Regra de negócio em SQL** (`sql/queries.sql`) — views que classificam
   cada cliente (concluinte / inconsistente / sem atendimento) a partir dos
   planos e centros de custo lançados. A lógica mora aqui, não em DAX.
2. **ETL em Python** (`etl_pipeline.py`) roda essas views contra o SQLite
   (`data/faturamento.db`) e exporta 4 CSVs prontos em `data/reports/`:
   `dados_cliente.csv`, `controle_gestor.csv`, `controle_vertical.csv`,
   `log_alteracoes.csv`.
3. **Power BI Desktop** conecta nesses 4 CSVs (Obter Dados → Texto/CSV) e
   na tabela `gestores` direto do SQLite (via script Python ou ODBC — ver
   seção "Conexão" abaixo), porque ela não passa pelo export de CSV.
4. **Modelo**: tabela `Clientes` (de `v_dados_cliente`) relacionada a
   `Gestores` (1 gestor → N clientes), mais as tabelas agregadas por
   gestor/vertical e o log de auditoria. As medidas DAX só somam/contam
   campos que a view já calculou (`Total Clientes`, `PJ Distintos`,
   `% PJ Distintos`, `Total Inconsistências`, `% Respondentes`, `Média de
   Aumento de Faturamento`) — nenhuma regra de classificação é refeita em
   DAX.
5. **Visuais** montados sobre essas medidas (cartões de KPI, matriz
   Gestor × Vertical, gráfico por vertical, página de auditoria).
6. **Publicar na Web** (manual, Arquivo → Publicar → Publicar na Web) para
   gerar o link de embed usado no site (`web/assets/app.js`,
   `POWERBI_EMBED_URL`).

## O que foi usado

- **SQLite** como banco de origem (`data/faturamento.db`).
- **SQL** (views) para a regra de negócio.
- **Python + Pandas** para o ETL (`etl_pipeline.py`) e para conectar tabelas
  que não passam por CSV (`pd.read_sql` direto no SQLite).
- **Power BI Desktop + DAX** para modelo, relacionamentos e medidas.
- **`powerbi/pbi_query.ps1`** (PowerShell, script próprio deste repo): com o
  Power BI Desktop aberto, ele sobe um motor Analysis Services local
  (`msmdsrv.exe`); o script autodetecta processo/porta/catálogo e roda DAX
  ou DMVs contra o modelo aberto no momento, sem precisar descobrir nada
  manualmente nem sair do terminal:
  ```powershell
  powershell -File powerbi\pbi_query.ps1                          # lista tabelas do modelo
  powershell -File powerbi\pbi_query.ps1 -Query "EVALUATE Clientes"
  ```
  Só funciona com o Desktop aberto na mesma máquina.

## Conexão (Power BI Desktop → SQLite)

Sem conector nativo para SQLite, duas formas:
1. ODBC ("SQLite ODBC Driver" + DSN apontando pro `faturamento.db`).
2. Script Python dentro do Power BI (recomendado):
   ```python
   import sqlite3, pandas as pd
   conn = sqlite3.connect(r"C:\caminho\data\faturamento.db")
   gestores = pd.read_sql("SELECT * FROM gestores", conn)
   ```

Para atualizar depois de mudanças na base: rodar `python etl_pipeline.py`
(ou `adicionar_cliente.py`, que já reexporta os CSVs sozinho) e clicar
"Atualizar" no Power BI.
