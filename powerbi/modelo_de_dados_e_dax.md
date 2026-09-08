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

## 1b. Consultar o modelo aberto via linha de comando (Windows)

Enquanto o Power BI Desktop esta aberto, ele sobe um motor Analysis Services
local (`msmdsrv.exe`) numa porta aleatoria em `127.0.0.1`. `powerbi/pbi_query.ps1`
autodetecta processo, porta e catalogo e roda DAX ou DMVs contra o modelo
aberto no momento, sem precisar descobrir nada manualmente:

```powershell
powershell -File powerbi\pbi_query.ps1                                   # lista tabelas do modelo
powershell -File powerbi\pbi_query.ps1 -Query "EVALUATE Clientes"
powershell -File powerbi\pbi_query.ps1 -Query "SELECT [Name],[Expression] FROM `$SYSTEM.TMSCHEMA_MEASURES"
powershell -File powerbi\pbi_query.ps1 -Query "EVALUATE Clientes" -Csv saida.csv
```

So funciona com o Power BI Desktop aberto na mesma maquina (usa
`Microsoft.PowerBI.AdomdClient.dll`, que vem instalada junto com o Desktop).
`EVALUATE` so responde depois que o modelo tiver pelo menos uma tabela
carregada; DMVs (`$SYSTEM.*`) funcionam mesmo com o modelo vazio.

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

## 7. Publicar na Web (para o link publico em web/)

O site em `web/` (publicado no Vercel) tem uma secao "Relatorio completo no
Power BI" com um iframe vazio ate esse passo ser feito -- e um passo manual,
o Power BI Desktop nao tem API de automacao:

1. Rodar `python etl_pipeline.py` (garante que `data/reports/*.csv` esta atualizado).
2. Abrir o Power BI Desktop, "Obter Dados" > "Texto/CSV", importar os 5 CSVs
   de `data/reports/` (`dados_cliente`, `controle_gestor`, `controle_vertical`,
   `log_alteracoes`) e a tabela `gestores` (via CSV ou ODBC, secao 1).
3. Montar o modelo (secao 2-3) e as medidas DAX (secao 4); montar os visuais
   (secao 5).
4. Arquivo > Publicar > Publicar na Web (nao confundir com "Publicar" comum,
   que exige que quem visualiza tenha login no Power BI). A conta usada
   precisa permitir "Publicar na Web" -- **contas M365 corporativas as vezes
   tem essa opcao desabilitada pelo administrador do tenant** (politica de
   seguranca, ja que o relatorio fica 100% publico na internet). Se a opcao
   nao aparecer ou for bloqueada, criar uma conta Microsoft pessoal gratuita
   (sem custo, sem depender do tenant do trabalho) e publicar por ela --
   como os dados sao 100% sinteticos, nao ha nenhum problema em ficar publico.
5. Copiar o link de embed gerado (formato
   `https://app.powerbi.com/view?r=...`).
6. Colar esse link na constante `POWERBI_EMBED_URL` no topo de
   `web/assets/app.js`, commitar e dar `git push` -- o Vercel redeploya
   automaticamente e o iframe passa a aparecer no site.
