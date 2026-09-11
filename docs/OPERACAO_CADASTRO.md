# Operação do Cadastro — Etapa 2

> Documenta a camada operacional do Cadastro (`web/index.html` seção
> `#cadastro` + `web/assets/supabase-demo.js`) depois da Etapa 2: filtros,
> busca, ordenação, exportação, prioridade, histórico, versionamento,
> restauração, snapshots, duplicidade, segurança e permissões. Para o
> posicionamento de produto (nome, proposta de valor), ver `docs/PRODUTO.md`.
> Para a arquitetura de auditoria/versionamento em detalhe, ver
> `docs/AUDITORIA_E_VERSIONAMENTO.md`.

## ⚠️ Passo obrigatório antes de tudo: rodar as migrações no Supabase

Esta etapa criou `supabase/schema_demo_v2_operacao.sql` — uma migração **aditiva**
(não apaga clientes/gestores/atendimentos/log existentes) que precisa ser
rodada manualmente no projeto Supabase real:

1. Dashboard do Supabase → SQL Editor → New query.
2. Colar o conteúdo inteiro de `supabase/schema_demo_v2_operacao.sql`.
3. Run.

**Etapa 2.5 (unificação de base — ver `docs/AUDITORIA_E_VERSIONAMENTO.md`):**
depois da migração acima, rode também, nesta ordem, `supabase/schema_demo_v3_unificacao.sql`
e `supabase/seed_unificacao_2500_clientes.sql` (gerado por
`supabase/gerar_seed_unificacao.py`) — sem eles, o Dashboard não encontra os
2.500 clientes sintéticos na base do Cadastro, e as duas telas ficam
mostrando bases diferentes de novo.

Sem isso, o Cadastro publicado continua funcionando (inclusão/edição/exclusão
básicas), mas **histórico por cliente, versionamento, restauração e
reatribuição de gestor não vão existir no banco ainda**, e a coluna
`prioritario` da view continuará com o significado antigo (flag manual) até a
migração rodar. Não tenho acesso de execução a este projeto Supabase a partir
deste ambiente — só quem tem a senha/dashboard do projeto pode rodar isso.

## 1. Filtros

Área "Filtros do Cadastro", com os mesmos padrões visuais dos filtros do
Dashboard (chips + contagem + limpar):

| Campo | Componente | Por quê |
|---|---|---|
| Vertical | chips (multi-seleção) | poucos valores (9 verticais) |
| Status | chips (multi-seleção) | 3 valores fixos (Concluinte/Participante/Sem atendimento) |
| Porte | chips (multi-seleção) | 5 valores fixos (MEI/ME/EPP/MEDIA/GRANDE) |
| Prioritário / Inconsistente / Respondeu pesquisa | chips (toggle simples) | booleanos — "filtrar só quem é" |
| Gestor | campo de texto com `<datalist>` | pode crescer (16+ gestores) |
| Município | campo de texto com `<datalist>` | texto livre, muitos valores possíveis |

Município e Gestor não usam um componente de combobox customizado — o
`<input list="...">` nativo do HTML5 já dá busca/autocomplete no navegador
sem precisar de biblioteca extra (`datalist` populado dinamicamente a partir
dos gestores/municípios que já existem na base carregada).

Todos os filtros são combináveis e ficam num único objeto de estado
(`cadastroFiltros` em `supabase-demo.js`) — qualquer mudança dispara **uma
única** função (`aplicarFiltrosCadastro` → `atualizarTabelaCadastro`) que
refaz a consulta ao banco já com todos os filtros ativos aplicados juntos
(`.in()`/`.eq()` combinados na mesma query), nunca requisições paralelas por
filtro.

### Filtros ativos

Abaixo da grade de filtros aparece uma linha "Filtros ativos:" com um chip
removível por filtro ativo (inclusive a busca de texto, se houver) e um botão
"Limpar filtros" que zera tudo de uma vez.

### Persistência

Os filtros **não são persistidos** entre recarregamentos de página
(`localStorage`/`sessionStorage`) — decisão deliberada, não uma lacuna. Como
o site é uma página única (não há navegação real entre páginas, só rolagem
até âncoras como `#dashboard`/`#cadastro`), o estado dos filtros já
**sobrevive naturalmente** enquanto o usuário navega dentro da mesma aba
(nada recarrega o JS). Persistir em storage só teria efeito ao fechar/reabrir
a aba, cenário em que resetar os filtros é o comportamento menos surpreendente
(evita o usuário reabrir o site depois de dias e ver a base "filtrada" sem
lembrar por quê).

## 2. Busca

Campo único, busca por **razão social, CNPJ (com ou sem pontuação) e nome do
gestor**, com `ilike` (case-insensitive, parcial) direto na view do banco —
não é um filtro em JavaScript sobre uma lista já carregada. Debounce de
300&nbsp;ms para não disparar uma consulta a cada tecla.

## 3. Ordenação

Seletor "Ordenar por" com estas opções (todas colunas reais da view
`v_demo_clientes_completo`, portanto ordenadas **no banco**, via
`.order()` do PostgREST — nunca um `.sort()` em JS sobre o resultado):

Data de inclusão · Última atualização · Razão social · CNPJ · Gestor ·
Status · Prioridade · % aumento de faturamento

Mais um botão de alternância Ascendente/Descendente. A sequência real é
**Filtros → Ordenação → Resultado → Exportação**: a mesma função
(`construirQueryCadastro`) monta filtros + busca; ordenação e paginação são
aplicadas em cima dela; a exportação reaproveita exatamente essa mesma
consulta (sem o `.range()`, para trazer todas as linhas do resultado, não só
a página visível).

## 4. Paginação

20 clientes por página (`CADASTRO_POR_PAGINA`), via `.range()` do PostgREST —
a tabela nunca carrega mais linhas do que a página atual. Compatível com
filtro/busca/ordenação: mudar qualquer um deles volta para a página 1.

## 5. Exportação (XLSX)

Botão "Exportar XLSX" acima da tabela do Cadastro:

1. Busca **todos** os registros que atendem aos filtros/busca/ordenação
   atuais (sem paginação).
2. Mostra uma confirmação com a contagem real: *"145 clientes serão
   exportados... Continuar?"* — nunca um número estimado.
3. Gera o arquivo com uma linha de cabeçalho documentando filtros aplicados,
   ordenação e total exportado (mesma prática já usada na exportação da Base
   de clientes do Dashboard).

## 6. Cliente prioritário

**Decisão de negócio tomada em conversa com o Juan durante esta etapa**
(havia uma contradição entre o pedido original — "prioritário = tem aumento
de faturamento informado" — e um campo manual `prioritario` que já existia,
marcado livremente pelo gestor). A regra final, validada:

> **Prioritário = respondeu a pesquisa E informou aumento de faturamento E
> ainda NÃO é Concluinte.** Assim que o cliente completa a regra de
> conclusão, ele deixa de ser "prioritário" e passa a ser "Concluinte" — os
> dois são estados mutuamente exclusivos ao longo da jornada.

100% calculado na view (`v_demo_clientes_completo.prioritario`), nunca
marcado manualmente — mesmo padrão de `pj_distinto`/`inconsistente_geral`. O
campo manual antigo **continua existindo no banco** (não apagamos dado —
`demo_clientes.prioritario`), mas foi renomeado na view para
`sinalizacao_manual` e **saiu da interface** (checkbox removido do formulário
de inclusão e do modal de edição) — ver `docs/AUDITORIA_E_VERSIONAMENTO.md`
para o detalhamento completo da decisão.

Já disponível como componente operacional:
- **Filtrar** — chip "Prioritário" na área de filtros, ou clicar no KPI
  "Prioritários".
- **Contar** — KPI "Prioritários" no topo do Cadastro.
- **Ordenar** — opção "Prioridade" no seletor de ordenação.
- **Visualizar** — coluna "Prioridade" na tabela (badge).
- **Exportar** — coluna "Prioritario" (Sim/Não) no XLSX exportado.

## 7. Indicadores do Cadastro

Total de clientes · PJ Distinto · Inconsistentes · Prioritários ·
Respondentes · Aumento médio · Gestores ativos (novo). Todos calculados sobre
a base **completa** de clientes ativos (não a página filtrada da tabela) —
mesmo princípio de sempre: KPI é sobre o todo, a tabela é o que está sendo
olhado agora. A contagem "N de M clientes" (acima da tabela e no cabeçalho da
barra de filtros) mostra o contexto filtrado ao lado do total, exatamente
como pedido.

## 8. Detecção de duplicidade

No formulário de inclusão, com debounce (~450&nbsp;ms):

- **CNPJ** (quando completa 14 dígitos): consulta exata contra a view. Se
  encontrar, mostra um aviso "bloqueio" visual (vermelho) — **"Este cliente
  já está cadastrado"** com gestor/vertical/status/data — mas não impede o
  envio; quem decide se é de fato duplicidade é o gestor.
- **Razão social** (3+ caracteres, se o CNPJ não bateu): consulta
  case-insensitive exata. Se encontrar, mostra um aviso "atenção" (amarelo)
  — **"Cliente potencialmente duplicado"**.

Nenhuma restrição (`UNIQUE`) foi adicionada no banco para CNPJ — de propósito,
porque o pedido explícito era "não impedir automaticamente, mostrar para
revisão".

## 9. Histórico e versões (por cliente)

Botão "Histórico" em cada linha da tabela (e "Ver histórico e versões" dentro
do modal de edição) abre um modal com duas abas:

- **Linha do tempo** — todas as entradas de `demo_log` daquele cliente
  (quem, quando, o quê, antes → depois), mais completo que o feed global
  "Atividade recente" (que só mostra as últimas 30 mudanças de todo o
  Cadastro).
- **Versões** — lista de `demo_clientes_versoes` daquele cliente (mais
  recente primeiro, marcado "atual"). Clicar em "Restaurar esta versão" abre
  um comparativo campo a campo (**Atual** vs. **Nessa versão**, só dos campos
  que realmente diferem) com **Cancelar**/**Restaurar esta versão**.

Restaurar chama a RPC `demo_restaurar_versao_cliente`, que:
- Reaplica os campos de negócio da versão escolhida sobre o registro atual.
- Grava cada campo alterado em `demo_log` (operação `RESTORE`).
- Cria uma **versão nova** (nunca apaga as antigas).

Ver `docs/AUDITORIA_E_VERSIONAMENTO.md` para a arquitetura completa.

## 10. Segurança e permissões

Nada mudou na segurança de base — continua tudo em RLS + funções
`SECURITY DEFINER` do Supabase (nenhuma escrita direta de tabela é permitida
para `anon`/`authenticated`; `INSERT`/`UPDATE`/`DELETE` só acontecem dentro
das funções, que revalidam a permissão por vertical a cada chamada, nunca
confiando em nada que o frontend mandou sobre "quem pode"). As duas funções
novas (`demo_reatribuir_gestor`, `demo_restaurar_versao_cliente`) seguem
exatamente o mesmo padrão de checagem das funções existentes.

**Limitação conhecida e documentada**: este ambiente não tem autenticação
real (não há login) — o "operador logado" é uma simulação por dropdown, desde
a Etapa 1. Isso significa que o identificador salvo no histórico
(`gestor_operador_id`) é confiável **dentro do modelo do Cadastro** (é sempre
um ID de gestor real, nunca um texto livre digitado), mas não impede alguém
de escolher "ser" outro gestor no dropdown. Implementar autenticação real
(Supabase Auth) é uma mudança de arquitetura maior, fora do escopo desta
etapa — ver limitações em `docs/AUDITORIA_E_VERSIONAMENTO.md`.

## 11. Performance

Desde a Etapa 2.5 (unificação de base), a base tem 2.500+ clientes, não mais
até 200 — os índices (`gestor_id`, `cnpj`, `lower(razao_social)`,
`demo_log(cliente_id, criado_em)`, `demo_clientes_versoes(cliente_id,
versao)`) deixaram de ser "preparação para o futuro" e passaram a ter
impacto real agora. Filtro/busca/ordenação acontecem no banco (nunca em
milhares de linhas no navegador, via `.eq/.in/.ilike/.order/.range`); a
tabela principal só carrega a página atual (20 linhas). Todo fetch "sem
filtro" (KPIs/ranking do Cadastro, o Dashboard inteiro, exportação sem
filtro) usa paginação por `.range()` em lotes de 1000 (`buscarTudoPaginado`
em `assets/app.js`) para nunca truncar silenciosamente no teto de linhas do
PostgREST — ver `docs/AUDITORIA_E_VERSIONAMENTO.md` para o trade-off de
KPIs/ranking ainda agregarem em JavaScript sobre a lista completa (em vez de
uma função SQL de agregação), e para quando isso deixa de valer a pena.
