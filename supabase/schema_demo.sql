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
-- Este banco continua SEPARADO do dataset sintetico principal (2500
-- clientes, gerado por generate_synthetic_data.py/etl_pipeline.py). O
-- sandbox agora e a "fonte de verdade" apenas do seu proprio universo de
-- demonstracao (ate 200 clientes ativos), nao do portfolio de 2500.
--
-- Como aplicar: Dashboard do Supabase -> SQL Editor -> New query -> colar
-- este arquivo inteiro -> Run. ATENCAO: isto reseta o sandbox (DROP TABLE) --
-- os clientes de teste incluidos ate agora serao apagados. E esperado, ja
-- que e um ambiente de demonstracao, nao dado real.
-- ============================================================================

create extension if not exists pgcrypto;

drop view if exists v_demo_clientes_completo;
drop view if exists v_demo_cliente_metrics;
drop view if exists v_demo_classificacao_cc;
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
  operacao text not null check (operacao in ('INSERT','UPDATE','DELETE','ATENDIMENTO','IMPORT')),
  campo text,
  valor_antigo text,
  valor_novo text,
  gestor_operador_id int not null,
  criado_em timestamptz not null default now()
);

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

-- View unica que o frontend le -- "fonte de verdade" do dashboard do sandbox.
create view v_demo_clientes_completo as
select
  c.id, c.razao_social, c.cnpj, c.porte, c.gestor_id,
  g.nome as gestor, g.vertical,
  c.municipio, c.cpf, c.celular, c.email, c.whatsapp_atualizado, c.email_atualizado,
  c.ali, c.prioritario, c.observacoes, c.termo, c.data_termo,
  c.respondeu, c.data_pesquisa, c.aumento_faturamento_pct, c.aumento_informado_pct,
  c.diagnostico_rae, c.assessoramento_rae, c.ot_final,
  c.criado_em, c.atualizado_em,
  m.pj_distinto, m.qtd_cc_concluinte, m.inconsistente_geral, m.qtd_inconsistencias, m.status
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

create policy demo_gestores_select on demo_gestores for select using (true);
create policy demo_centros_custo_select on demo_centros_custo for select using (true);
create policy demo_clientes_select on demo_clientes for select using (true);
create policy demo_atendimentos_select on demo_atendimentos for select using (true);
create policy demo_log_select on demo_log for select using (true);

grant select on demo_gestores, demo_centros_custo, demo_clientes, demo_atendimentos, demo_log,
  v_demo_classificacao_cc, v_demo_inconsistencia_cc, v_demo_cliente_metrics, v_demo_clientes_completo
  to anon, authenticated;
revoke insert, update, delete on demo_clientes, demo_atendimentos, demo_log, demo_gestores, demo_centros_custo
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
  v_total int;
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

  select count(*) into v_total from demo_clientes where ativo = true;
  if v_total >= 200 then
    raise exception 'Sandbox cheio no momento (limite de demonstracao). Tente novamente mais tarde.';
  end if;

  insert into demo_clientes (
    razao_social, cnpj, porte, gestor_id,
    municipio, ali, prioritario, observacoes, respondeu,
    aumento_faturamento_pct, aumento_informado_pct
  ) values (
    left(trim(p_razao_social), 80), left(trim(p_cnpj), 20), p_porte, p_gestor_id,
    nullif(p_extra->>'municipio', ''),
    coalesce((p_extra->>'ali')::boolean, false),
    coalesce((p_extra->>'prioritario')::boolean, false),
    nullif(p_extra->>'observacoes', ''),
    coalesce((p_extra->>'respondeu')::boolean, false),
    (p_extra->>'aumento_faturamento_pct')::numeric,
    (p_extra->>'aumento_informado_pct')::numeric
  )
  returning id into v_id;

  insert into demo_log (cliente_id, operacao, gestor_operador_id)
  values (v_id, 'INSERT', p_gestor_id);

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
    'whatsapp_atualizado','email_atualizado','ali','prioritario','observacoes',
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
        when v_chave in ('whatsapp_atualizado','email_atualizado','ali','prioritario','termo','respondeu') then 'boolean'
        when v_chave in ('data_termo','data_pesquisa') then 'date'
        when v_chave in ('aumento_faturamento_pct','aumento_informado_pct') then 'numeric'
        else 'text'
      end
    ) using p_campos, p_cliente_id;

    insert into demo_log (cliente_id, operacao, campo, valor_antigo, valor_novo, gestor_operador_id)
    values (p_cliente_id, 'UPDATE', v_chave, v_valor_antigo, v_valor_novo, p_gestor_operador_id);
  end loop;
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

-- Autolimpeza diaria (opcional). Se a extensao pg_cron nao estiver
-- disponivel no seu projeto, estas duas ultimas instrucoes vao falhar --
-- pode ignorar o erro, o resto do script ja funciona sem isso.
create extension if not exists pg_cron with schema extensions;
select cron.schedule(
  'limpar_sandbox_demo',
  '0 3 * * *',
  $$delete from demo_clientes where criado_em < now() - interval '24 hours';
    delete from demo_log where criado_em < now() - interval '24 hours';$$
);
