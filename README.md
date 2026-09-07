# Painel de Acompanhamento de Carteira — reconstrução técnica (dados fictícios)

> 🇧🇷 Português abaixo. 🇺🇸 English version further down.
> **Todos os dados neste repositório são 100% sintéticos**, gerados por script
> (`generate_synthetic_data.py`), sem qualquer vínculo com dados reais de
> clientes, empresas ou órgãos. Este projeto é uma reconstrução pública, com
> arquitetura genérica, de um sistema de acompanhamento de carteira que eu
> desenvolvi profissionalmente em Excel — aqui reimplementado com
> Python + SQL para demonstrar as mesmas decisões de modelagem em outra pilha
> de tecnologia.

## 1. O problema

Uma organização com múltiplos gestores de carteira precisa saber, a cada
atualização de uma base de atendimentos (milhares de linhas, uma por
atendimento), quais clientes já cumpriram uma regra de negócio de "conclusão"
(um diagnóstico + duas assessorias válidas, **ou** uma solução específica para
um segmento de porte diferente) — e quais pareceriam ter cumprido, se não
fosse um lançamento marcado como inválido por erro de digitação/integração.

## 2. Por que reconstruir em SQL + Python

1. **Auditabilidade** — a regra real mora espalhada em fórmulas de 300+ caracteres.
2. **Escalabilidade** — XLOOKUP/COUNTIFS contra 100 mil linhas, multiplicado por milhares de clientes, degrada o Excel.
3. **Manutenção de regra** — mudar uma regra exige confiar que milhares de fórmulas recalculam certo.

## 3. Arquitetura (4 camadas)

```
generate_synthetic_data.py   →  data/raw/*.csv        (1. BASE — dados brutos fictícios)
sql/schema.sql                →  estrutura do banco     (2. REGRAS — planos, produtos, centros de custo)
brasilapi_mock.py             →  enriquecimento          (automação — mock de API de CNPJ)
etl_pipeline.py                →  data/faturamento.db    (orquestra tudo)
sql/queries.sql                →  views de classificação (3. TRATAMENTO — regras de negócio em SQL)
data/reports/*.csv             →  saída consolidada       (4. DASHBOARD — pronta para o Power BI)
analysis/exploratory_analysis.py → data/reports/*.png    (análise exploratória em Pandas)
powerbi/modelo_de_dados_e_dax.md → modelo + medidas DAX  (camada de visualização)
adicionar_cliente.py + permissoes.py → log_alteracoes    (CLI do gestor: inclusão/edição/exclusão com permissão por vertical)
```

## 4. Inclusão/edição pelo gestor, com permissão por vertical

Além do pipeline automático, `adicionar_cliente.py` é um CLI que o próprio
gestor usa para mexer na carteira sem esperar a próxima carga completa:

- **Incluir** cliente/atendimento — sempre atribuído ao gestor que está logado.
- **Editar** dados cadastrais, **reatribuir** o gestor responsável e **excluir**
  cliente/atendimento (soft delete — o registro some do dashboard, mas o
  histórico é preservado).
- **Permissão por vertical**: um gestor só mexe em clientes que são dele, ou
  de um colega da mesma vertical (ex.: se Cris, Simone e Gui Tresso são da
  mesma vertical, qualquer um deles pode editar a carteira dos outros dois —
  ver `permissoes.py`). Fora da vertical, a operação é bloqueada com erro.
- **Auditoria**: toda inclusão/edição/exclusão grava uma linha em
  `log_alteracoes` (quem, quando, campo alterado, valor antigo → novo).
- **Reflexo no BI**: cada operação de escrita já recria as views e reexporta
  os CSVs de `data/reports/` (inclusive `log_alteracoes.csv`), então o Power
  BI só precisa de um "Atualizar" para refletir a mudança.

```bash
python adicionar_cliente.py   # menu interativo: login por ID de gestor, depois incluir/editar/excluir
```

## 5. Demo publicada (site + sandbox ao vivo)

**[jornada-cliente-dashboard.vercel.app](https://jornada-cliente-dashboard-4ytdsddb7-juans-projects-8d3a43dc.vercel.app)** —
link público, sem precisar rodar nada localmente (`web/`, hospedado no
Vercel):

- **Painel de KPIs** e gráficos (PJ Distintos por vertical, status,
  ranking de gestores) — estáticos, gerados por `export_web_data.py` a partir
  de `data/reports/*.csv`.
- **Base de clientes** navegável (busca, filtro por vertical/gestor/status,
  paginação) com os 2500 clientes sintéticos.
- **Sandbox de inclusão ao vivo** — banco Postgres real (Supabase),
  separado do dataset acima, onde qualquer visitante testa incluir/editar/
  excluir cliente e vê a regra de permissão por vertical bloqueando edição
  entre gestores de verticais diferentes, na prática. Schema, RLS e as
  funções que replicam `permissoes.py` em PL/pgSQL ficam em
  `supabase/schema_demo.sql`.
- **Relatório Power BI** publicado embutido (quando o link de "Publicar na
  Web" estiver preenchido — ver `powerbi/modelo_de_dados_e_dax.md`, seção 7).

## 6. Como rodar

```bash
python -m venv .venv && source .venv/bin/activate   # opcional
pip install -r requirements.txt
python generate_synthetic_data.py
python etl_pipeline.py
python analysis/exploratory_analysis.py   # opcional — gera gráficos com Pandas/Matplotlib
python adicionar_cliente.py               # opcional — inclusão manual de cliente
python export_web_data.py                 # opcional — regenera web/data/*.json (site publicado)
pytest                                    # roda os testes da regra de negócio
```

## 7. Resultado

Ver "RESUMO DA EXECUCAO" impresso pelo `etl_pipeline.py` — os números variam
levemente a cada ajuste no gerador, mas com a seed fixa (`random.seed(42)`)
a saída é **100% reprodutível**: qualquer pessoa que rodar este repositório
localmente vai reproduzir exatamente os mesmos números impressos no terminal.

## 8. Stack

Python (stdlib: `sqlite3`, `csv`) para o pipeline · SQL (views) para a lógica
de negócio · Pandas/Matplotlib para análise exploratória · Power BI (DAX) para
o dashboard final · pytest para validar a regra de classificação · HTML/CSS/JS
+ Supabase (Postgres/RLS) para o site publicado e o sandbox ao vivo.

---
## English version

All data in this repository is 100% synthetic. This project is a public,
generically re-architected reconstruction of a portfolio-tracking system I
built professionally in Excel — reimplemented here with Python + SQL.

**The problem:** an organization with multiple account managers needs to know,
on every refresh of a raw interactions table (thousands of rows), which
clients already met a "completion" business rule (one diagnostic + two valid
advisory sessions, **or** a specific solution for a different company-size
segment) — and which ones would appear to have met it if not for a session
flagged invalid due to a data-entry/integration error.

**Same 4-layer structure:** raw base → business rules → classification
(SQL views) → dashboard (Power BI), plus a Pandas-based exploratory analysis
layer and pytest tests covering the classification rule.

**Manager-driven inclusion/editing, with vertical-based permission:** beyond
the automated pipeline, `adicionar_cliente.py` is a CLI managers use to touch
their portfolio without waiting for the next full load — include a client
(always assigned to the logged-in manager), edit master data, reassign the
responsible manager, or delete a client/interaction (soft delete — the record
disappears from the dashboard but the history is preserved). Permission is
scoped by vertical: a manager can only touch clients that are their own, or a
peer's within the same vertical (see `permissoes.py`); every write is logged
to `log_alteracoes` (who, when, field, old → new value) and immediately
re-exports the CSVs in `data/reports/`, so Power BI only needs a refresh to
reflect the change.

**Live demo:** [jornada-cliente-dashboard.vercel.app](https://jornada-cliente-dashboard-4ytdsddb7-juans-projects-8d3a43dc.vercel.app) —
no local setup needed. KPIs/charts, a searchable/filterable browser over the
2500 synthetic clients, and a live public sandbox (real Postgres via
Supabase, RLS + PL/pgSQL functions mirroring `permissoes.py`) where anyone
can try including/editing a client and see the vertical-permission rule
block a cross-vertical edit in real time (`supabase/schema_demo.sql`).

Run:
```bash
pip install -r requirements.txt
python generate_synthetic_data.py
python etl_pipeline.py
python analysis/exploratory_analysis.py   # optional -- Pandas/Matplotlib charts
python adicionar_cliente.py               # optional -- manager CLI (include/edit/delete)
pytest
```

Result: what used to require manually cross-checking a spreadsheet against a
raw export — a process that would take roughly 156 manual hours per refresh
cycle at this volume — now runs in well under a second, deterministically,
with an audit trail (SQL views) instead of hidden spreadsheet formulas.
