# Auditoria e versionamento — arquitetura (Etapa 2)

> Como o histórico, o versionamento, a restauração e a reatribuição de gestor
> foram implementados no Cadastro, e por quê. Ver `supabase/schema_demo_v2_operacao.sql`
> (migração aditiva — rodar no SQL Editor do Supabase) e a seção correspondente
> em `supabase/schema_demo.sql` (schema completo "do zero", já com as mesmas
> mudanças incorporadas).

## 1. O que já existia (Etapa 1) e foi reaproveitado

`demo_log` já existia desde a Fase 4/Etapa 1: uma linha por operação
(`INSERT`/`UPDATE`/`DELETE`/`ATENDIMENTO`/`IMPORT`), com `campo`,
`valor_antigo`, `valor_novo` e `gestor_operador_id`. Isso **já era**, na
prática, um log de auditoria por campo — só não tinha uma tela que o
mostrasse filtrado por cliente (só o feed global "Atividade recente", as
últimas 30 mudanças de todo o Cadastro). A Etapa 2 não recriou esse
mecanismo: só adicionou a tela "Histórico" por cliente, que consulta
`demo_log` filtrado por `cliente_id` (índice novo:
`idx_demo_log_cliente_criado`).

## 2. O que é novo: versionamento

Log de campo-a-campo (o que já existia) responde "o que mudou". Não responde
sozinho "como era o registro inteiro antes" sem reconstruir a partir de uma
sequência de diffs — frágil (um campo faltando na cadeia quebra a
reconstrução) e caro de calcular a cada consulta.

**Decisão de arquitetura**: uma tabela de **snapshots completos**
(`demo_clientes_versoes`), não um log de diffs reprocessado:

```sql
create table demo_clientes_versoes (
  id bigint generated always as identity primary key,
  cliente_id uuid not null references demo_clientes(id) on delete cascade,
  versao int not null,
  operacao text not null check (operacao in ('INSERT','UPDATE','RESTORE')),
  gestor_operador_id int not null references demo_gestores(gestor_id),
  snapshot jsonb not null,       -- to_jsonb(demo_clientes) inteiro, pos-mudanca
  criado_em timestamptz not null default now(),
  unique (cliente_id, versao)
);
```

Por que **não** duplicar a base inteira a cada mudança (SCD "manual" numa
tabela paralela idêntica à `demo_clientes`): o `jsonb` guarda só o que já
existe na linha no momento da escrita — sem precisar manter uma segunda
tabela com o mesmo schema sincronizado a cada `ALTER TABLE` futuro em
`demo_clientes`. Cada versão é uma linha pequena e autocontida; reconstruir o
estado de um cliente numa versão específica é `select snapshot from
demo_clientes_versoes where cliente_id = ? and versao = ?` — sem joins, sem
replay de diffs.

**Quando uma versão é criada**: dentro das próprias funções RPC (não um
trigger separado), logo depois da escrita que a gerou — mesmo padrão de
"gravar o log" que já existia:

| Evento | Versão criada? | Por quê |
|---|---|---|
| `demo_incluir_cliente` | Sim (versão 1) | estado inicial do registro |
| `demo_editar_cliente` | Sim, se `p_campos` não for vazio | evita versão "vazia" quando nada mudou |
| `demo_definir_atendimento` | **Não** | `status`/`pj_distinto` são calculados na view, não armazenados em `demo_clientes` — versionar o snapshot não mudaria nada; o `demo_log` (`ATENDIMENTO`, com as contagens antes/depois) já é a trilha correta para isso |
| `demo_excluir_cliente` | **Não** nesta etapa | ver limitação #6 abaixo |
| `demo_reatribuir_gestor` (novo) | Sim | mudança de gestor é uma das mais importantes de auditar (pedido explícito) |
| `demo_restaurar_versao_cliente` (novo) | Sim (operação `RESTORE`) | a própria restauração é uma versão nova |

Por que uma função RPC explícita por evento, e não um trigger `AFTER
UPDATE`: as funções já fazem toda a checagem de permissão e já sabem
exatamente qual `gestor_operador_id` fez a mudança (um trigger de banco não
tem acesso nativo a "quem é o usuário simulado que chamou a RPC" sem um
truque de variável de sessão) — manter a gravação da versão no mesmo lugar
onde o `demo_log` já é gravado evita introduzir um segundo mecanismo
(trigger) que precisaria da mesma informação por um caminho diferente.

## 3. Restauração

RPC `demo_restaurar_versao_cliente(p_versao_id, p_gestor_operador_id)`:

1. Busca a versão pelo `id` → tem o `cliente_id` e o `snapshot` (jsonb).
2. Mesma checagem de permissão por vertical das outras funções (o operador
   precisa estar na vertical do gestor **atual** do cliente).
3. Reaplica, campo a campo, só os campos de negócio editáveis (a mesma lista
   de `demo_editar_cliente`, mais `gestor_id`) que **realmente diferem** do
   estado atual — e só esses geram uma linha em `demo_log` (operação
   `RESTORE`), para não poluir o histórico com "mudanças" de campos que já
   estavam iguais.
4. Cria uma **versão nova** com o estado pós-restauração. **Nunca apaga**
   nem sobrescreve as versões anteriores — restaurar é sempre andar para a
   frente no histórico, nunca literalmente "voltar no tempo" apagando o que
   veio depois.

Na interface, antes de confirmar, o gestor vê um comparativo campo a campo
**Atual vs. Nessa versão** (só os campos que diferem) — nunca uma
restauração "às cegas".

## 4. Reatribuição de gestor

Esta funcionalidade **já existia no CLI original** (`adicionar_cliente.py::reatribuir_gestor`,
mencionado em `CLAUDE.md`), mas nunca tinha sido trazida para o Cadastro
(Supabase) — não é uma invenção desta etapa, é fechar uma lacuna entre as
duas superfícies do sistema. A nova RPC `demo_reatribuir_gestor` replica
exatamente a regra do CLI (`permissoes.py`): quem tem permissão sobre o
gestor **atual** do cliente pode reatribuí-lo a **qualquer** gestor
existente, inclusive de outra vertical (o CLI nunca restringiu o gestor de
destino — só quem pode fazer a reatribuição). Na interface, o campo "Gestor
responsável" do modal de edição virou um campo de texto com busca
(`<datalist>`) em vez de texto somente-leitura.

## 5. Decisão de negócio: "cliente prioritário"

O pedido original desta etapa definia "cliente prioritário" como "possui
informação de aumento de faturamento". Ao analisar o banco, encontrei um
conflito real: já existia um campo `prioritario` **manual**, marcado
livremente pelo gestor (checkbox no formulário), sem relação nenhuma com
aumento de faturamento — e já estava em uso (KPI, filtro/drill-down,
ranking). Implementar a regra nova por cima do campo antigo, com o mesmo
nome, teria dois significados incompatíveis coexistindo silenciosamente.

Parei e perguntei. A resposta, resumida: **"prioritário" deve ser sempre
calculado automaticamente — nunca um flag do gestor, porque o gestor não
sabe com certeza se o cliente já completou a regra de conclusão. Quando o
cliente prioritário completa a regra de negócio, ele deixa de ser
prioritário e passa a ser concluinte.**

Regra final implementada (calculada na view, nunca setada manualmente —
mesmo padrão de `pj_distinto`/`inconsistente_geral`):

```sql
(c.respondeu and c.aumento_faturamento_pct is not null
 and not coalesce(m.pj_distinto, false)) as prioritario
```

Ou seja: respondeu a pesquisa **e** informou aumento de faturamento **e**
ainda não é Concluinte. Um cliente prioritário que completa a regra de
conclusão automaticamente deixa de aparecer como prioritário (vira
Concluinte) — sem nenhuma ação manual, exatamente como pedido.

**O que aconteceu com o campo manual antigo**: preservado no banco por
não-destrutividade (`demo_clientes.prioritario`, dado real de quem já tinha
marcado algo), mas renomeado *só na view* para `sinalizacao_manual` — a
tabela em si não mudou de nome de coluna, só a exposição via API. Saiu da
interface (checkbox removido do formulário de inclusão e do modal de
edição) porque não tem mais um uso definido: era "prioritário" e deixou de
ser. Fica disponível no banco (`sinalizacao_manual` na view) para uma futura
funcionalidade de sinalização manual **distinta**, se um dia fizer sentido de
negócio — mas essa é uma decisão para pedir de novo, não para reintroduzir
sozinho.

## 6. Limitações conhecidas (fora do escopo desta etapa)

- **Restaurar cliente excluído**: `demo_restaurar_versao_cliente` só
  funciona em clientes **ativos**. Um cliente excluído (soft delete,
  `ativo = false`) não pode ser restaurado por essa função nesta etapa —
  "desfazer exclusão" (reativar + restaurar) é uma funcionalidade distinta,
  com implicações de permissão próprias (o cliente pode ter sido excluído
  por alguém que deixou de ter acesso a ele depois), melhor tratada como
  pedido explícito numa próxima etapa do que decidida sozinha aqui.
- **Sem autenticação real**: o "operador simulado" (dropdown) é a mesma
  limitação já documentada na Etapa 1 — o identificador salvo no histórico
  (`gestor_operador_id`) é sempre um ID de gestor válido (nunca texto livre),
  mas não impede escolher "ser" outro gestor no dropdown. Autenticação real
  (Supabase Auth) é uma mudança de arquitetura maior, não implementada aqui.
- **Concorrência na numeração de versão**: `versao` é calculada como
  `max(versao) + 1` dentro da própria função — em uso normal (um operador
  simulado por vez, forms sequenciais) isso nunca colide; em tese, duas
  escritas *simultâneas* no mesmíssimo cliente poderiam gerar o mesmo número
  e uma delas falhar por violar o `unique(cliente_id, versao)` — a
  transação simplesmente falha com um erro claro (o usuário veria "não foi
  possível salvar" e poderia tentar de novo), não um dado corrompido
  silenciosamente. Dado o uso real deste ambiente de demonstração, não
  implementei travamento adicional (`select ... for update`) para esse
  cenário — seria complexidade real para um risco que não existe na prática
  aqui.
- **Snapshot/backup administrativo amplo** (item 20 do pedido original —
  snapshot diário da base inteira, backup administrativo): não implementado.
  A combinação de versionamento por cliente (`demo_clientes_versoes`) +
  autolimpeza diária de 24h (já existente desde a Etapa 1, agora estendida
  para também limpar `demo_clientes_versoes`) cobre a necessidade real deste
  ambiente de demonstração (que é efêmero por design). Um backup
  administrativo formal faria mais sentido quando este deixar de ser um
  ambiente de demonstração com limpeza automática — registrado aqui como
  pendência explícita, não esquecida.
- **Edição/alteração em massa**: não implementada nesta etapa (o pedido
  original já pedia para só "preparar a arquitetura" se não houvesse
  necessidade imediata). A base já está pronta para isso — os RPCs de
  edição/reatribuição aceitam um cliente por vez; estender para múltiplos
  seria repetir a mesma chamada em lote (como a importação XLSX já faz hoje),
  sem precisar de uma RPC nova.

## 7. Trade-off: KPIs/ranking sobre a base completa

A tabela de clientes agora é paginada/filtrada/ordenada **no banco**
(PostgREST), mas os KPIs e o ranking de gestores continuam agregando sobre a
lista completa de clientes ativos, carregada de uma vez. Isso é intencional,
não uma inconsistência: KPIs precisam refletir o **total real** da carteira
(não faria sentido um "Total de clientes" que muda dependendo do filtro da
tabela abaixo dele), e o teto de 200 clientes ativos (regra já existente em
`demo_incluir_cliente`) torna esse carregamento completo barato. Se esse
teto crescer muito no futuro, o próximo passo natural é mover essa agregação
para uma função SQL (`select count(*) ... group by`) em vez de somar em
JavaScript — documentado aqui como o gatilho que justificaria essa mudança,
não implementado agora porque o teto atual não pede por ela.
