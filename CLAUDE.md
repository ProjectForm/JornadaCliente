# Contexto do projeto para o Claude Code

## O que é isto

Portfólio técnico do Juan (candidatura para vagas de Analista de Dados / BI /
Automação). É a reconstrução pública — com **dados 100% sintéticos** — de um
sistema de acompanhamento de carteira de clientes que ele desenvolveu
profissionalmente em Excel/VBA/Power Query no trabalho. Aqui o mesmo problema
de negócio é resolvido com SQL + Python + Pandas + Power BI, especificamente
para demonstrar competência nessas ferramentas (SQL e Python/Pandas foram
identificadas como as maiores lacunas técnicas do candidato numa pesquisa de
mercado feita antes de começar este projeto).

**Nunca adicionar dados reais de clientes, CNPJs reais ou qualquer informação
do empregador real neste repositório** — o valor do projeto depende de ele
ser 100% público e sintético.

## Arquitetura (4 camadas — ver README.md para detalhes)

1. `generate_synthetic_data.py` — gera `data/raw/*.csv` (dados fictícios, `random.seed(42)`, reprodutível)
2. `sql/schema.sql` — schema relacional (SQLite)
3. `sql/queries.sql` — views que implementam a regra de negócio (classificação/inconsistência)
4. `brasilapi_mock.py` — mock local de enriquecimento via API (simula BrasilAPI)
5. `etl_pipeline.py` — orquestra tudo: cria schema → carrega CSVs → enriquece via API mock → cria views → exporta `data/reports/*.csv`
6. `analysis/exploratory_analysis.py` — camada de análise em Pandas (separada do pipeline de propósito — ver docstring do arquivo)
7. `adicionar_cliente.py` — CLI para simular inclusão manual de cliente/atendimento e recálculo incremental
8. `powerbi/modelo_de_dados_e_dax.md` — documentação do modelo de dados e medidas DAX (não há .pbix no repo — Power BI Desktop não roda neste ambiente)
9. `tests/test_pipeline.py` — pytest cobrindo a regra de negócio (classificação/inconsistência) e o mock de CNPJ

## Fluxo de trabalho

```bash
pip install -r requirements.txt
python generate_synthetic_data.py
python etl_pipeline.py
python analysis/exploratory_analysis.py
pytest
```

Sempre que mexer em `sql/queries.sql` ou `generate_synthetic_data.py`, rode
`pytest` antes de considerar terminado — os testes usam um banco em memória
com um cenário mínimo controlado (não o dataset sintético grande), então são
rápidos e é ali que a regra de negócio é validada.

## Convenções

- Nomes de tabelas/colunas em português (reflete a terminologia real do
  domínio de negócio: "gestor", "porte", "atendimento", "concluinte" etc.) —
  manter em português mesmo em código novo, por consistência.
- Docstrings e comentários de código em português; README e mensagens
  voltadas a quem lê o repositório são bilíngues (PT + EN).
- Todo dado é gerado por script com seed fixa — qualquer mudança no gerador
  deve manter reprodutibilidade (não usar `random` sem seed).

## Ideias de próximos passos (não fazer nada disto sem o Juan pedir)

- Adicionar um notebook Jupyter em `analysis/` com a mesma exploração de
  `exploratory_analysis.py`, mas em formato mais visual/narrativo para o README.
- Adicionar GitHub Actions rodando `pytest` a cada push (mostra maturidade de CI).
- Trocar SQLite por Postgres via Docker Compose, se o objetivo for mostrar
  competência com um banco mais "de produção".
- Adicionar um diagrama ER (ex.: gerado com `dbdiagram.io` ou `mermaid`) no README.
