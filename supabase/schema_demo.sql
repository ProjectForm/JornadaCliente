-- ============================================================================
-- SANDBOX DE DEMONSTRACAO (site publicado) -- Fase 4: o sandbox passa a ser
-- um mini-sistema de BI ao vivo e completo, com o MESMO principio de "fonte
-- unica de verdade" do dataset sintetico principal (sql/queries.sql):
--
--   demo_clientes + demo_atendimentos  (fatos, editaveis via RPC)
--        -> v_demo_classificacao_cc     (regra de negocio, 1 lugar so)
--        -> v_demo_cliente_metrics      (agregacao por cliente)
--        -> v_demo_clientes_completo    (view unica que o frontend le)
--
-- A regra de conclusao replica fielmente sql/queries.sql (v_classificacao_plano/
-- v_inconsistencia_plano), só que por Centro de Custo em vez de Plano:
--   - Centro de custo "geral": concluinte = >=1 diagnostico valido E >=2
--     assessorias validas (mesma regra DIAG_2ASSESSORIA da planilha original).
--   - Centro de custo Sustentabilidade/Sebraetec (is_sebraetec=true):
--     concluinte = >=1 atendimento Sebraetec valido (regra QUALQUER_SOLUCAO).
--   - inconsistente = "seria concluinte se os atendimentos fossem validos,
--     mas nao é" (mesmo conceito de v_inconsistencia_plano) -- calculado,
--     nunca setado manualmente.
--   - PJ Distinto do cliente = concluinte em pelo menos 1 centro de custo
--     (um cliente pode ser concluinte em mais de um).
--
-- Este calculo mora SÓ nesta view -- nenhum arquivo JS reimplementa a regra.
--
-- ETAPA 2.5 -- UNIFICACAO DE BASE: este banco DEIXOU de ser separado do
-- dataset sintetico principal. Os mesmos 2500 clientes gerados por
-- generate_synthetic_data.py/etl_pipeline.py sao a carga inicial deste banco
-- (ver supabase/seed_unificacao_2500_clientes.sql) -- Dashboard (web/assets/app.js)
-- e Cadastro (web/assets/supabase-demo.js) leem AMBOS de v_demo_clientes_completo,
-- ao vivo. Sem teto de clientes ativos e sem limpeza automatica (eram
-- salvaguardas de sandbox descartavel, incompativeis com ser a base real) --
-- ver docs/AUDITORIA_E_VERSIONAMENTO.md para a decisao e as implicacoes de
-- seguranca.
--
-- Como aplicar: Dashboard do Supabase -> SQL Editor -> New query -> colar
-- este arquivo inteiro -> Run. ATENCAO: isto reseta a base (DROP TABLE) --
-- todo o conteudo atual (incluindo os 2500 clientes, se ja tiverem sido
-- carregados) sera apagado; rode o seed de novo depois.
--
-- Este arquivo e o schema "do zero" (reset completo). Se a base ja estiver
-- rodando com dados que voce quer preservar, use em vez disso
-- supabase/schema_demo_v2_operacao.sql + supabase/schema_demo_v3_unificacao.sql,
-- que aplicam exatamente as mesmas mudancas de forma aditiva (sem apagar
-- nada). Os arquivos convergem para o mesmo schema final.
-- ============================================================================

create extension if not exists pgcrypto;

drop view if exists v_demo_clientes_completo;
drop view if exists v_demo_cliente_metrics;
drop view if exists v_demo_classificacao_cc;
drop table if exists demo_clientes_versoes;
drop table if exists demo_log;
drop table if exists demo_atendimentos;
drop table if exists demo_clientes;
drop table if exists demo_centros_custo;
drop table if exists demo_gestores;

-- ============================================================================
-- DIMENSOES
-- ============================================================================
create table demo_gestores (
  gestor_id int primary key,
  nome text not null,
  vertical text not null
);

insert into demo_gestores (gestor_id, nome, vertical) values
  (1, 'Ana Souza', 'Comercio e Servicos'),
  (2, 'Bruno Lima', 'Tecnologia e Inovacao'),
  (3, 'Carla Dias', 'Turismo e Agronegocio'),
  (4, 'Diego Alves', 'Atendimento ao Cliente'),
  (5, 'Elisa Rocha', 'Empreendedorismo Cultural'),
  (6, 'Fabio Nunes', 'Consultoria Especializada'),
  (7, 'Giovana Melo', 'Sustentabilidade'),
  (8, 'Hugo Ramos', 'Comercio e Servicos'),
  (9, 'Iara Costa', 'Tecnologia e Inovacao'),
  (10, 'Joao Pedro', 'Turismo e Agronegocio'),
  (11, 'Karina Reis', 'Atendimento ao Cliente'),
  (12, 'Lucas Barros', 'Empreendedorismo Cultural'),
  (13, 'Mariana Teles', 'Consultoria Especializada'),
  (14, 'Nicolas Vieira', 'Sustentabilidade'),
  (15, 'Olivia Prado', 'Comercio e Servicos'),
  (16, 'Paulo Cezar', 'Tecnologia e Inovacao');

create table demo_centros_custo (
  id int primary key,
  nome text not null,
  is_sebraetec boolean not null default false
);

insert into demo_centros_custo (id, nome, is_sebraetec) values
  (1, 'Carteira Geral', false),
  (2, 'Projeto Setorial', false),
  (3, 'Consultoria Avancada', false),
  (4, 'Sustentabilidade / Sebraetec', true);

-- ============================================================================
-- FATOS (editaveis via RPC -- ver mais abaixo)
-- ============================================================================
create table demo_clientes (
  id uuid primary key default gen_random_uuid(),
  razao_social varchar(80) not null,
  cnpj varchar(20) not null,
  porte text not null check (porte in ('MEI','ME','EPP','MEDIA','GRANDE')),
  gestor_id int not null references demo_gestores(gestor_id),

  municipio text,
  cpf varchar(20),
  celular varchar(20),
  email varchar(120),
  whatsapp_atualizado boolean not null default false,
  email_atualizado boolean not null default false,
  ali boolean not null default false,
  prioritario boolean not null default false,
  observacoes text,
  termo boolean not null default false,
  data_termo date,
  respondeu boolean not null default false,
  data_pesquisa date,
  aumento_faturamento_pct numeric(6,2),
  aumento_informado_pct numeric(6,2),
  diagnostico_rae text,
  assessoramento_rae text,
  ot_final text,

  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

create table demo_atendimentos (
  id bigint generated always as identity primary key,
  cliente_id uuid not null references demo_clientes(id) on delete cascade,
  centro_custo_id int not null references demo_centros_custo(id),
  diagnosticos_total int not null default 0,
  diagnosticos_validos int not null default 0,
  assessorias_total int not null default 0,
  assessorias_validos int not null default 0,
  sebraetec_total int not null default 0,
  sebraetec_validos int not null default 0,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (cliente_id, centro_custo_id),
  check (diagnosticos_validos <= diagnosticos_total),
  check (assessorias_validos <= assessorias_total),
  check (sebraetec_validos <= sebraetec_total)
);

create table demo_log (
  id bigint generated always as identity primary key,
  cliente_id uuid not null,
  operacao text not null check (operacao in ('INSERT','UPDATE','DELETE','ATENDIMENTO','IMPORT','RESTORE')),
  campo text,
  valor_antigo text,
  valor_novo text,
  gestor_operador_id int not null,
  criado_em timestamptz not null default now()
);

-- Versionamento -- snapshot completo de demo_clientes a cada escrita relevante
-- (INSERT/UPDATE/reatribuicao/restauracao). Nao versiona demo_atendimentos --
-- ja tem trilha propria em demo_log (contagens antes/depois); status/pj_distinto
-- sao calculados, nao armazenados, entao versionar o snapshot nao acrescentaria
-- nada para esse caso. Ver docs/AUDITORIA_E_VERSIONAMENTO.md.
create table demo_clientes_versoes (
  id bigint generated always as identity primary key,
  cliente_id uuid not null references demo_clientes(id) on delete cascade,
  versao int not null,
  operacao text not null check (operacao in ('INSERT','UPDATE','RESTORE')),
  gestor_operador_id int not null references demo_gestores(gestor_id),
  snapshot jsonb not null,
  criado_em timestamptz not null default now(),
  unique (cliente_id, versao)
);

create index idx_demo_clientes_gestor_id on demo_clientes (gestor_id) where ativo;
create index idx_demo_clientes_cnpj on demo_clientes (cnpj) where ativo;
create index idx_demo_clientes_razao_lower on demo_clientes (lower(razao_social)) where ativo;
create index idx_demo_log_cliente_criado on demo_log (cliente_id, criado_em desc);
create index idx_demo_clientes_versoes_cliente on demo_clientes_versoes (cliente_id, versao desc);

-- ============================================================================
-- CAMADA DE CLASSIFICACAO -- fonte unica da regra de negocio (replica
-- v_classificacao_plano / v_inconsistencia_plano de sql/queries.sql)
-- ============================================================================
create view v_demo_classificacao_cc as
select
  a.cliente_id,
  a.centro_custo_id,
  cc.nome as centro_custo_nome,
  cc.is_sebraetec,
  a.diagnosticos_validos, a.diagnosticos_total,
  a.assessorias_validos, a.assessorias_total,
  a.sebraetec_validos, a.sebraetec_total,
  case
    when cc.is_sebraetec then (a.sebraetec_validos >= 1)
    else (a.diagnosticos_validos >= 1 and a.assessorias_validos >= 2)
  end as concluinte,
  case
    when cc.is_sebraetec then (a.sebraetec_total >= 1)
    else (a.diagnosticos_total >= 1 and a.assessorias_total >= 2)
  end as concluiria_se_valido
from demo_atendimentos a
join demo_centros_custo cc on cc.id = a.centro_custo_id;

create view v_demo_inconsistencia_cc as
select *,
  (concluiria_se_valido and not concluinte) as inconsistente
from v_demo_classificacao_cc;

create view v_demo_cliente_metrics as
select
  c.id as cliente_id,
  coalesce(bool_or(v.concluinte), false) as pj_distinto,
  coalesce(count(*) filter (where v.concluinte), 0) as qtd_cc_concluinte,
  coalesce(bool_or(v.inconsistente), false) as inconsistente_geral,
  coalesce(count(*) filter (where v.inconsistente), 0) as qtd_inconsistencias,
  case
    when coalesce(bool_or(v.concluinte), false) then 'Concluinte'
    when not exists (select 1 from demo_atendimentos a2 where a2.cliente_id = c.id) then 'Sem atendimento'
    else 'Participante'
  end as status
from demo_clientes c
left join v_demo_inconsistencia_cc v on v.cliente_id = c.id
group by c.id;

-- View unica que o frontend le -- "fonte de verdade" do Cadastro.
--
-- "prioritario" (ETAPA 2): passou a ser 100% calculado -- respondeu a
-- pesquisa, informou aumento de faturamento, e AINDA NAO e Concluinte (se
-- completar a regra de conclusao, deixa de ser prioritario e vira
-- Concluinte). O campo manual antigo (marcado livremente pelo gestor) e
-- preservado no banco por nao-destrutividade, mas sai da interface e passa
-- a se chamar "sinalizacao_manual" aqui na view.
create view v_demo_clientes_completo as
select
  c.id, c.razao_social, c.cnpj, c.porte, c.gestor_id,
  g.nome as gestor, g.vertical,
  c.municipio, c.cpf, c.celular, c.email, c.whatsapp_atualizado, c.email_atualizado,
  c.ali, c.observacoes, c.termo, c.data_termo,
  c.respondeu, c.data_pesquisa, c.aumento_faturamento_pct, c.aumento_informado_pct,
  c.diagnostico_rae, c.assessoramento_rae, c.ot_final,
  c.criado_em, c.atualizado_em,
  m.pj_distinto, m.qtd_cc_concluinte, m.inconsistente_geral, m.qtd_inconsistencias, m.status,
  c.prioritario as sinalizacao_manual,
  (c.respondeu and c.aumento_faturamento_pct is not null and not coalesce(m.pj_distinto, false)) as prioritario
from demo_clientes c
join demo_gestores g on g.gestor_id = c.gestor_id
left join v_demo_cliente_metrics m on m.cliente_id = c.id
where c.ativo = true;

-- ============================================================================
-- RLS -- leitura publica das tabelas/views; escrita SÓ via RPC (abaixo)
-- ============================================================================
alter table demo_gestores enable row level security;
alter table demo_centros_custo enable row level security;
alter table demo_clientes enable row level security;
alter table demo_atendimentos enable row level security;
alter table demo_log enable row level security;
alter table demo_clientes_versoes enable row level security;

create policy demo_gestores_select on demo_gestores for select using (true);
create policy demo_centros_custo_select on demo_centros_custo for select using (true);
create policy demo_clientes_select on demo_clientes for select using (true);
create policy demo_atendimentos_select on demo_atendimentos for select using (true);
create policy demo_log_select on demo_log for select using (true);
create policy demo_clientes_versoes_select on demo_clientes_versoes for select using (true);

grant select on demo_gestores, demo_centros_custo, demo_clientes, demo_atendimentos, demo_log,
  demo_clientes_versoes,
  v_demo_classificacao_cc, v_demo_inconsistencia_cc, v_demo_cliente_metrics, v_demo_clientes_completo
  to anon, authenticated;
revoke insert, update, delete on demo_clientes, demo_atendimentos, demo_log, demo_gestores, demo_centros_custo,
  demo_clientes_versoes
  from anon, authenticated;

-- ============================================================================
-- RPCs (SECURITY DEFINER) -- unico caminho de escrita. Mesma checagem de
-- permissao por vertical de sempre (replica permissoes.py).
-- ============================================================================
create or replace function demo_incluir_cliente(
  p_gestor_id int, p_razao_social text, p_cnpj text, p_porte text, p_extra jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from demo_gestores where gestor_id = p_gestor_id) then
    raise exception 'Gestor % nao encontrado', p_gestor_id;
  end if;
  if p_porte not in ('MEI','ME','EPP','MEDIA','GRANDE') then
    raise exception 'Porte invalido: %', p_porte;
  end if;
  if length(trim(p_razao_social)) = 0 then
    raise exception 'Razao social obrigatoria';
  end if;

  insert into demo_clientes (
    razao_social, cnpj, porte, gestor_id,
    municipio, ali, observacoes, respondeu,
    aumento_faturamento_pct, aumento_informado_pct
  ) values (
    left(trim(p_razao_social), 80), left(trim(p_cnpj), 20), p_porte, p_gestor_id,
    nullif(p_extra->>'municipio', ''),
    coalesce((p_extra->>'ali')::boolean, false),
    nullif(p_extra->>'observacoes', ''),
    coalesce((p_extra->>'respondeu')::boolean, false),
    (p_extra->>'aumento_faturamento_pct')::numeric,
    (p_extra->>'aumento_informado_pct')::numeric
  )
  returning id into v_id;

  insert into demo_log (cliente_id, operacao, gestor_operador_id)
  values (v_id, 'INSERT', p_gestor_id);

  insert into demo_clientes_versoes (cliente_id, versao, operacao, gestor_operador_id, snapshot)
  select v_id, 1, 'INSERT', p_gestor_id, to_jsonb(dc)
  from demo_clientes dc where dc.id = v_id;

  return v_id;
end; $$;

create or replace function demo_editar_cliente(
  p_cliente_id uuid, p_gestor_operador_id int, p_campos jsonb
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_vertical_operador text;
  v_vertical_responsavel text;
  v_chave text;
  v_valor_novo text;
  v_valor_antigo text;
  v_permitidos text[] := array[
    'razao_social','porte','municipio','cpf','celular','email',
    'whatsapp_atualizado','email_atualizado','ali','observacoes',
    'termo','data_termo','respondeu','data_pesquisa',
    'aumento_faturamento_pct','aumento_informado_pct',
    'diagnostico_rae','assessoramento_rae','ot_final'
  ];
begin
  select vertical into v_vertical_operador from demo_gestores where gestor_id = p_gestor_operador_id;
  if v_vertical_operador is null then
    raise exception 'Gestor operador % nao encontrado', p_gestor_operador_id;
  end if;

  select g.vertical into v_vertical_responsavel
  from demo_clientes c join demo_gestores g on g.gestor_id = c.gestor_id
  where c.id = p_cliente_id and c.ativo = true;
  if v_vertical_responsavel is null then
    raise exception 'Cliente nao encontrado';
  end if;

  if v_vertical_operador <> v_vertical_responsavel then
    raise exception 'Gestor % (vertical %) nao tem permissao sobre este cliente (vertical %)',
      p_gestor_operador_id, v_vertical_operador, v_vertical_responsavel;
  end if;

  for v_chave in select jsonb_object_keys(p_campos) loop
    if not (v_chave = any(v_permitidos)) then
      raise exception 'Campo nao editavel: %', v_chave;
    end if;

    execute format('select %I::text from demo_clientes where id = $1', v_chave)
      into v_valor_antigo using p_cliente_id;
    v_valor_novo := p_campos->>v_chave;

    if v_chave = 'porte' and v_valor_novo not in ('MEI','ME','EPP','MEDIA','GRANDE') then
      raise exception 'Porte invalido: %', v_valor_novo;
    end if;
    if v_chave = 'razao_social' and length(trim(coalesce(v_valor_novo,''))) = 0 then
      raise exception 'Razao social obrigatoria';
    end if;

    execute format('update demo_clientes set %I = ($1->>%L)::%s, atualizado_em = now() where id = $2',
      v_chave, v_chave,
      case
        when v_chave in ('whatsapp_atualizado','email_atualizado','ali','termo','respondeu') then 'boolean'
        when v_chave in ('data_termo','data_pesquisa') then 'date'
        when v_chave in ('aumento_faturamento_pct','aumento_informado_pct') then 'numeric'
        else 'text'
      end
    ) using p_campos, p_cliente_id;

    insert into demo_log (cliente_id, operacao, campo, valor_antigo, valor_novo, gestor_operador_id)
    values (p_cliente_id, 'UPDATE', v_chave, v_valor_antigo, v_valor_novo, p_gestor_operador_id);
  end loop;

  if p_campos <> '{}'::jsonb then
    insert into demo_clientes_versoes (cliente_id, versao, operacao, gestor_operador_id, snapshot)
    select p_cliente_id,
      coalesce((select max(versao) from demo_clientes_versoes where cliente_id = p_cliente_id), 0) + 1,
      'UPDATE', p_gestor_operador_id, to_jsonb(dc)
    from demo_clientes dc where dc.id = p_cliente_id;
  end if;
end; $$;

-- NOVA (ETAPA 2) -- traz para o Cadastro a funcionalidade que ja existia no
-- CLI (adicionar_cliente.py::reatribuir_gestor): quem tem permissao sobre o
-- cliente pode reatribui-lo a QUALQUER gestor existente, inclusive de outra
-- vertical -- mesma regra do CLI, que nao restringe o gestor de destino.
create or replace function demo_reatribuir_gestor(
  p_cliente_id uuid, p_gestor_operador_id int, p_novo_gestor_id int
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_vertical_operador text;
  v_vertical_responsavel text;
  v_gestor_antigo_id int;
begin
  select vertical into v_vertical_operador from demo_gestores where gestor_id = p_gestor_operador_id;
  if v_vertical_operador is null then
    raise exception 'Gestor operador % nao encontrado', p_gestor_operador_id;
  end if;

  select g.vertical, c.gestor_id into v_vertical_responsavel, v_gestor_antigo_id
  from demo_clientes c join demo_gestores g on g.gestor_id = c.gestor_id
  where c.id = p_cliente_id and c.ativo = true;
  if v_vertical_responsavel is null then
    raise exception 'Cliente nao encontrado';
  end if;

  if v_vertical_operador <> v_vertical_responsavel then
    raise exception 'Gestor % nao tem permissao sobre este cliente (vertical diferente)', p_gestor_operador_id;
  end if;

  if not exists (select 1 from demo_gestores where gestor_id = p_novo_gestor_id) then
    raise exception 'Gestor % nao encontrado', p_novo_gestor_id;
  end if;

  if v_gestor_antigo_id = p_novo_gestor_id then
    return;
  end if;

  update demo_clientes set gestor_id = p_novo_gestor_id, atualizado_em = now() where id = p_cliente_id;

  insert into demo_log (cliente_id, operacao, campo, valor_antigo, valor_novo, gestor_operador_id)
  values (p_cliente_id, 'UPDATE', 'gestor_id', v_gestor_antigo_id::text, p_novo_gestor_id::text, p_gestor_operador_id);

  insert into demo_clientes_versoes (cliente_id, versao, operacao, gestor_operador_id, snapshot)
  select p_cliente_id,
    coalesce((select max(versao) from demo_clientes_versoes where cliente_id = p_cliente_id), 0) + 1,
    'UPDATE', p_gestor_operador_id, to_jsonb(dc)
  from demo_clientes dc where dc.id = p_cliente_id;
end; $$;

-- NOVA (ETAPA 2) -- reaplica os campos de negocio de uma versao anterior
-- sobre o registro atual. NUNCA apaga versoes -- a propria restauracao cria
-- uma versao nova (RESTORE). So funciona em clientes ATIVOS (restaurar um
-- cliente excluido fica fora desta etapa).
create or replace function demo_restaurar_versao_cliente(
  p_versao_id bigint, p_gestor_operador_id int
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_cliente_id uuid;
  v_snapshot jsonb;
  v_vertical_operador text;
  v_vertical_responsavel text;
  v_chave text;
  v_valor_antigo text;
  v_valor_novo text;
  v_restauraveis text[] := array[
    'razao_social','porte','gestor_id','municipio','cpf','celular','email',
    'whatsapp_atualizado','email_atualizado','ali','observacoes',
    'termo','data_termo','respondeu','data_pesquisa',
    'aumento_faturamento_pct','aumento_informado_pct',
    'diagnostico_rae','assessoramento_rae','ot_final'
  ];
begin
  select cliente_id, snapshot into v_cliente_id, v_snapshot
  from demo_clientes_versoes where id = p_versao_id;
  if v_cliente_id is null then
    raise exception 'Versao % nao encontrada', p_versao_id;
  end if;

  select vertical into v_vertical_operador from demo_gestores where gestor_id = p_gestor_operador_id;
  if v_vertical_operador is null then
    raise exception 'Gestor operador % nao encontrado', p_gestor_operador_id;
  end if;

  select g.vertical into v_vertical_responsavel
  from demo_clientes c join demo_gestores g on g.gestor_id = c.gestor_id
  where c.id = v_cliente_id and c.ativo = true;
  if v_vertical_responsavel is null then
    raise exception 'Cliente nao encontrado ou excluido -- restauracao de cliente excluido nao e suportada nesta etapa';
  end if;

  if v_vertical_operador <> v_vertical_responsavel then
    raise exception 'Gestor % nao tem permissao sobre este cliente (vertical diferente)', p_gestor_operador_id;
  end if;

  foreach v_chave in array v_restauraveis loop
    if not (v_snapshot ? v_chave) then
      continue;
    end if;

    execute format('select %I::text from demo_clientes where id = $1', v_chave)
      into v_valor_antigo using v_cliente_id;
    v_valor_novo := v_snapshot->>v_chave;

    if v_valor_antigo is distinct from v_valor_novo then
      execute format('update demo_clientes set %I = ($1->>%L)::%s, atualizado_em = now() where id = $2',
        v_chave, v_chave,
        case
          when v_chave in ('whatsapp_atualizado','email_atualizado','ali','termo','respondeu') then 'boolean'
          when v_chave in ('data_termo','data_pesquisa') then 'date'
          when v_chave in ('aumento_faturamento_pct','aumento_informado_pct') then 'numeric'
          when v_chave = 'gestor_id' then 'int'
          else 'text'
        end
      ) using v_snapshot, v_cliente_id;

      insert into demo_log (cliente_id, operacao, campo, valor_antigo, valor_novo, gestor_operador_id)
      values (v_cliente_id, 'RESTORE', v_chave, v_valor_antigo, v_valor_novo, p_gestor_operador_id);
    end if;
  end loop;

  insert into demo_clientes_versoes (cliente_id, versao, operacao, gestor_operador_id, snapshot)
  select v_cliente_id,
    coalesce((select max(versao) from demo_clientes_versoes where cliente_id = v_cliente_id), 0) + 1,
    'RESTORE', p_gestor_operador_id, to_jsonb(dc)
  from demo_clientes dc where dc.id = v_cliente_id;
end; $$;

create or replace function demo_definir_atendimento(
  p_cliente_id uuid, p_centro_custo_id int, p_operador_id int,
  p_diagnosticos_total int, p_diagnosticos_validos int,
  p_assessorias_total int, p_assessorias_validos int,
  p_sebraetec_total int, p_sebraetec_validos int
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_vertical_operador text;
  v_vertical_responsavel text;
begin
  select vertical into v_vertical_operador from demo_gestores where gestor_id = p_operador_id;
  if v_vertical_operador is null then
    raise exception 'Gestor operador % nao encontrado', p_operador_id;
  end if;

  select g.vertical into v_vertical_responsavel
  from demo_clientes c join demo_gestores g on g.gestor_id = c.gestor_id
  where c.id = p_cliente_id and c.ativo = true;
  if v_vertical_responsavel is null then
    raise exception 'Cliente nao encontrado';
  end if;

  if v_vertical_operador <> v_vertical_responsavel then
    raise exception 'Gestor % nao tem permissao sobre este cliente (vertical diferente)', p_operador_id;
  end if;

  if not exists (select 1 from demo_centros_custo where id = p_centro_custo_id) then
    raise exception 'Centro de custo % nao encontrado', p_centro_custo_id;
  end if;
  if p_diagnosticos_validos > p_diagnosticos_total or p_assessorias_validos > p_assessorias_total
     or p_sebraetec_validos > p_sebraetec_total then
    raise exception 'Quantidade valida nao pode ser maior que o total informado';
  end if;
  if p_diagnosticos_total < 0 or p_assessorias_total < 0 or p_sebraetec_total < 0 then
    raise exception 'Quantidades nao podem ser negativas';
  end if;

  insert into demo_atendimentos (
    cliente_id, centro_custo_id,
    diagnosticos_total, diagnosticos_validos,
    assessorias_total, assessorias_validos,
    sebraetec_total, sebraetec_validos
  ) values (
    p_cliente_id, p_centro_custo_id,
    p_diagnosticos_total, p_diagnosticos_validos,
    p_assessorias_total, p_assessorias_validos,
    p_sebraetec_total, p_sebraetec_validos
  )
  on conflict (cliente_id, centro_custo_id) do update set
    diagnosticos_total = excluded.diagnosticos_total,
    diagnosticos_validos = excluded.diagnosticos_validos,
    assessorias_total = excluded.assessorias_total,
    assessorias_validos = excluded.assessorias_validos,
    sebraetec_total = excluded.sebraetec_total,
    sebraetec_validos = excluded.sebraetec_validos,
    atualizado_em = now();

  update demo_clientes set atualizado_em = now() where id = p_cliente_id;

  insert into demo_log (cliente_id, operacao, campo, valor_antigo, valor_novo, gestor_operador_id)
  values (p_cliente_id, 'ATENDIMENTO',
    (select nome from demo_centros_custo where id = p_centro_custo_id),
    null,
    format('diag %s/%s, assessoria %s/%s, sebraetec %s/%s',
      p_diagnosticos_validos, p_diagnosticos_total, p_assessorias_validos, p_assessorias_total,
      p_sebraetec_validos, p_sebraetec_total),
    p_operador_id);
end; $$;

create or replace function demo_excluir_cliente(
  p_cliente_id uuid, p_gestor_operador_id int
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_vertical_operador text;
  v_vertical_responsavel text;
begin
  select vertical into v_vertical_operador from demo_gestores where gestor_id = p_gestor_operador_id;
  if v_vertical_operador is null then
    raise exception 'Gestor operador % nao encontrado', p_gestor_operador_id;
  end if;

  select g.vertical into v_vertical_responsavel
  from demo_clientes c join demo_gestores g on g.gestor_id = c.gestor_id
  where c.id = p_cliente_id and c.ativo = true;
  if v_vertical_responsavel is null then
    raise exception 'Cliente nao encontrado ou ja excluido';
  end if;

  if v_vertical_operador <> v_vertical_responsavel then
    raise exception 'Gestor % nao tem permissao sobre este cliente (vertical diferente)', p_gestor_operador_id;
  end if;

  update demo_clientes set ativo = false, atualizado_em = now() where id = p_cliente_id;

  insert into demo_log (cliente_id, operacao, gestor_operador_id)
  values (p_cliente_id, 'DELETE', p_gestor_operador_id);
end; $$;

grant execute on function demo_incluir_cliente(int, text, text, text, jsonb) to anon, authenticated;
grant execute on function demo_editar_cliente(uuid, int, jsonb) to anon, authenticated;
grant execute on function demo_definir_atendimento(uuid, int, int, int, int, int, int, int, int) to anon, authenticated;
grant execute on function demo_excluir_cliente(uuid, int) to anon, authenticated;
grant execute on function demo_reatribuir_gestor(uuid, int, int) to anon, authenticated;
grant execute on function demo_restaurar_versao_cliente(bigint, int) to anon, authenticated;

-- Sem autolimpeza automatica e sem teto de clientes ativos (ETAPA 2.5 --
-- unificacao de base, ver supabase/schema_demo_v3_unificacao.sql): o
-- Cadastro deixou de ser um sandbox descartavel e passa a ser a mesma base
-- que o Dashboard le ao vivo (carga inicial: supabase/seed_unificacao_2500_clientes.sql).
-- Isso significa que, sem autenticacao real, a base fica permanentemente
-- editavel por qualquer visitante -- decisao consciente, ver
-- docs/AUDITORIA_E_VERSIONAMENTO.md.
