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
```

## 4. Como rodar

```bash
python -m venv .venv && source .venv/bin/activate   # opcional
pip install -r requirements.txt
python generate_synthetic_data.py
python etl_pipeline.py
python analysis/exploratory_analysis.py   # opcional — gera gráficos com Pandas/Matplotlib
python adicionar_cliente.py               # opcional — inclusão manual de cliente
pytest                                    # roda os testes da regra de negócio
```

## 5. Resultado

Ver "RESUMO DA EXECUCAO" impresso pelo `etl_pipeline.py` — os números variam
levemente a cada ajuste no gerador, mas com a seed fixa (`random.seed(42)`)
a saída é **100% reprodutível**: qualquer pessoa que rodar este repositório
localmente vai reproduzir exatamente os mesmos números impressos no terminal.

## 6. Stack

Python (stdlib: `sqlite3`, `csv`) para o pipeline · SQL (views) para a lógica
de negócio · Pandas/Matplotlib para análise exploratória · Power BI (DAX) para
o dashboard final · pytest para validar a regra de classificação.

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

Run:
```bash
pip install -r requirements.txt
python generate_synthetic_data.py
python etl_pipeline.py
python analysis/exploratory_analysis.py
pytest
```

Result: what used to require manually cross-checking a spreadsheet against a
raw export — a process that would take roughly 156 manual hours per refresh
cycle at this volume — now runs in well under a second, deterministically,
with an audit trail (SQL views) instead of hidden spreadsheet formulas.
