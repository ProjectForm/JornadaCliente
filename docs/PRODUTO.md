# Planilha de Controle — Jornada do Cliente

> Documento de produto do site publicado (`web/`). Descreve o que a aplicação
> é, para quem, o problema que resolve e as decisões de UX tomadas na Etapa 1
> de evolução (posicionamento de produto). Para a arquitetura técnica completa
> do repositório (pipeline SQL/Python, CLI, Power BI), ver o `README.md` na
> raiz — este documento cobre especificamente a camada de produto web.

## 1. Nome

**Planilha de Controle — Jornada do Cliente.** Dentro da aplicação, a área de
operação (inclusão/edição/consulta de clientes) chama-se **Cadastro**. Os
termos "sandbox", "demo", "mock" e "portfolio" foram removidos da experiência
do usuário — a aplicação se apresenta como um produto, não como um protótipo
ou peça de portfólio (a natureza de case técnico continua documentada no
`README.md` e no código, que são materiais externos/de apresentação, não
parte da experiência do produto).

## 2. Propósito

Centralizar o acompanhamento da carteira de clientes de uma organização com
múltiplas verticais de atendimento, substituindo controles paralelos em
planilha por uma única fonte operacional — do cadastro do cliente até a
decisão do gestor.

## 3. O problema

O processo original não é "ter muita planilha": é que **várias
pessoas/verticais podem responder à mesma pergunta operacional usando
processos separados — e chegar a respostas diferentes.**

Contexto de referência (case):

- 9 verticais de atendimento, cada uma com gestores e controles próprios;
- extrações e conferências manuais recorrentes (múltiplas vezes por semana,
  por vertical);
- risco de clientes cadastrados em duplicidade entre verticais;
- dificuldade em saber, de forma confiável, quais clientes já "entraram"
  (cumpriram a regra de negócio de conclusão) e quais têm inconsistência de
  lançamento;
- controles paralelos criados ad-hoc por cada vertical para compensar a falta
  de uma fonte única.

Isso gera trabalho repetido, conferência redundante, risco de duplicidade e
perda de rastreabilidade sobre qual número é o correto.

## 4. Público

Gestores de carteira em organizações com múltiplas verticais/equipes de
atendimento (o case de referência é o SEBRAE, unidade ER Rio Preto) —
qualquer estrutura em que times distintos precisem enxergar a mesma base de
clientes sob a mesma regra de negócio.

## 5. Proposta de valor

Quatro pilares comunicados já na primeira dobra:

- **Centralização** — uma única base, em vez de um controle por vertical.
- **Visibilidade** — todos os gestores acompanham a mesma informação.
- **Validação** — erros e inconsistências de lançamento ficam evidentes
  (não são "escondidos" por uma fórmula de planilha divergente).
- **Decisão** — o gestor age sem precisar cruzar várias planilhas.

## 6. Impacto (estimativa, não medição auditada)

Apresentado na primeira dobra como ordem de grandeza, com o cálculo completo
disponível em um `<details>` (premissas transparentes, não escondidas):

- 9 verticais × (3 extrações/semana × 3 min + 30 min de conferência) =
  39 min/vertical/semana → **≈304 horas/ano** de esforço recorrente
  potencialmente evitado.
- 9 verticais × ~2 dias (16h) de desenvolvimento de dashboard próprio =
  **≈144 horas** de esforço pontual potencialmente evitado no primeiro ano.
- Total estimado no primeiro ano: **≈448 horas**.

Estas são premissas do case (tempos de referência do processo manual
descrito acima), não uma medição histórica auditada — o texto ao lado do
número deixa isso explícito em toda ocorrência, para não sugerir uma
economia comprovada.

## 7. Arquitetura da aplicação web (`web/`)

- `index.html` — página única, com a landing (hero/narrativa de produto), o
  dashboard consolidado (KPIs, gráficos, ranking de gestores) e o
  **Cadastro** (`#cadastro`) — desde a Etapa 2.5, os dois leem e escrevem a
  **mesma base real** (Supabase/Postgres), ao vivo.
- `assets/app.js` — Dashboard: consulta `v_demo_clientes_completo` e
  `demo_log` ao vivo (via Supabase), agrega e renderiza KPIs/gráficos/
  tabela/ranking, aplica os filtros globais. Não escreve nada — só lê.
- `assets/supabase-demo.js` — Cadastro: todas as chamadas de escrita ao
  Supabase (RPCs de incluir/editar/excluir/reatribuir/restaurar/definir
  atendimento). Nenhuma regra de permissão ou de classificação de cliente
  mora neste arquivo — a fonte de verdade é o banco (ver
  `supabase/schema_demo*.sql`), este arquivo só lê e apresenta.
- `assets/style.css` — design system único (tokens de cor/tipografia/raio),
  reaproveitado por ambas as camadas acima.

**Histórico da decisão** (ver `docs/AUDITORIA_E_VERSIONAMENTO.md` para o
detalhamento completo): até a Etapa 2, o dataset de 2.500 clientes
(estático, gerado pelo pipeline SQL/Python) e o Cadastro (Supabase, sandbox
descartável com teto de 200 clientes e limpeza automática de 24h) eram
intencionalmente independentes. Na Etapa 2.5, a pedido explícito, isso
mudou: os 2.500 clientes viraram a carga inicial da base do Cadastro
(`supabase/gerar_seed_unificacao.py`), o Dashboard passou a consultar essa
mesma base ao vivo em vez de um JSON estático, e as salvaguardas de sandbox
descartável (teto de clientes, limpeza automática) foram removidas — com a
implicação de segurança explícita de que, sem autenticação real, a base fica
permanentemente editável por qualquer visitante do site.

## 8. Fluxo principal do usuário

1. Chega pela landing → entende em segundos o que a ferramenta faz (título +
   subtítulo), por que existe (problema operacional) e o que resolve (4
   pilares de valor) — antes de ver qualquer número do dashboard.
2. Vê a ordem de grandeza do impacto potencial (com premissas transparentes,
   não escondidas atrás de um número solto).
3. Clica no único CTA da página, **"Abrir Cadastro"** → cai direto na área
   de operação.
4. No Cadastro: vê indicadores básicos (total de clientes, PJ Distinto,
   inconsistentes, prioritários, respondentes, aumento médio), busca por
   razão social/CNPJ, inclui um cliente pelo formulário, e acompanha a
   atividade recente — tudo atualizado automaticamente após qualquer
   escrita, sem F5.
5. Pode ainda navegar ao Dashboard consolidado (KPIs sobre a carteira
   completa — hoje os 2.500 clientes sintéticos do pipeline mais qualquer
   inclusão feita ao vivo pelo Cadastro —, com filtros globais, drill-down
   por gestor/vertical) e à Base de clientes (mesma base, visão somente
   leitura com busca/paginação).

## 9. Funcionalidades já existentes (não inventadas para o marketing)

- Cadastro: inclusão, edição, exclusão (soft delete) e definição de
  atendimentos por Centro de Custo, com permissão por vertical.
- Busca por razão social/CNPJ na base do Cadastro.
- Ranking de gestores por critério selecionável, com drill-down.
- Exportar/baixar modelo XLSX e importar clientes em lote.
- Indicadores básicos do Cadastro (todos calculados no banco, não
  inventados no front): total, PJ Distinto, inconsistentes, prioritários,
  respondentes, aumento médio de faturamento.
- Dashboard consolidado com filtros globais (vertical/status/porte/gestor),
  exportação XLSX da base filtrada, painel de detalhe por cliente.
- Trilha de auditoria (`log_alteracoes` / `demo_log`) das alterações feitas
  via CLI e via Cadastro.

## 10. Decisões de UX desta etapa

- ~~Uma fonte de verdade por seção, mas duas seções~~ — **superada na Etapa
  2.5**: Dashboard e Cadastro passaram a ler a mesma base ao vivo, a pedido
  explícito (ver `docs/AUDITORIA_E_VERSIONAMENTO.md`). Mantido aqui como
  registro histórico da decisão original da Etapa 1.
- **Um único CTA visualmente dominante** ("Abrir Cadastro", no header e ao
  fim da landing) — o link para o GitHub foi rebaixado a um link de texto
  discreto, para não competir com a ação principal.
- **Impacto com premissas visíveis, não escondidas**: o número grande
  (`≈304h/ano`) vem sempre acompanhado de uma legenda deixando claro que é
  estimativa, com o detalhamento do cálculo disponível sob demanda
  (`<details>`), nunca apresentado como economia comprovada.
- **Área do Cadastro reorganizada, mas sem nova lógica**: adicionamos busca
  por texto e uma nota de "em breve" para filtros avançados/priorização/
  histórico — sem implementar filtros completos, sem tocar em schema ou
  regra de permissão do banco.
- **Identidade institucional discreta**: "SEBRAE · ER Rio Preto" aparece no
  header e no eyebrow da landing, sem virar uma página institucional — a
  prioridade continua sendo produto + usabilidade.

## 11. Pendências conhecidas (fora do escopo desta etapa)

- ~~A mensagem de erro "Sandbox cheio..." ainda existe no lado do banco~~ —
  **corrigida na Etapa 2** (`supabase/schema_demo_v2_operacao.sql`), junto
  com filtros clicáveis, busca/ordenação/paginação reais no banco,
  exportação com confirmação de contagem, detecção de duplicidade,
  histórico e versionamento por cliente, restauração de versão e
  reatribuição de gestor. Ver `docs/OPERACAO_CADASTRO.md` e
  `docs/AUDITORIA_E_VERSIONAMENTO.md`.
- Redesign visual premium, animações avançadas e refinamento final de
  microinterações ficam para a próxima etapa, por decisão explícita de
  escopo (Etapa 2 foi funcionalidade + governança, não design).
