-- ============================================================================
-- SANDBOX DE DEMONSTRACAO (site publicado) -- inclusao/edicao/exclusao ao
-- vivo, com a mesma regra de permissao por vertical de permissoes.py.
--
-- Este banco e SEPARADO do dataset sintetico principal do projeto (que vive
-- em data/faturamento.db, local). E alimentado so pelos visitantes do site
-- testando o formulario -- nao afeta os 2500 clientes do portfolio.
--
-- Como aplicar: Dashboard do Supabase -> SQL Editor -> New query -> colar
-- este arquivo inteiro -> Run. Rodar uma unica vez (ou de novo para resetar
-- o sandbox do zero, ja que comeca com DROP TABLE).
-- ============================================================================

create extension if not exists pgcrypto;

drop table if exists demo_log;
drop table if exists demo_clientes;
drop table if exists demo_gestores;

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

create table demo_clientes (
  id uuid primary key default gen_random_uuid(),
  razao_social varchar(80) not null,
  cnpj varchar(20) not null,
  porte text not null check (porte in ('MEI','ME','EPP','MEDIA','GRANDE')),
  gestor_id int not null references demo_gestores(gestor_id),
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);

create table demo_log (
  id bigint generated always as identity primary key,
  cliente_id uuid not null,
  operacao text not null check (operacao in ('INSERT','UPDATE','DELETE')),
  campo text,
  valor_antigo text,
  valor_novo text,
  gestor_operador_id int not null,
  criado_em timestamptz not null default now()
);

alter table demo_gestores enable row level security;
alter table demo_clientes enable row level security;
alter table demo_log enable row level security;

create policy demo_gestores_select on demo_gestores for select using (true);
create policy demo_clientes_select on demo_clientes for select using (true);
create policy demo_log_select on demo_log for select using (true);

-- Nenhuma policy de insert/update/delete para anon/authenticated -- e
-- garantido abaixo tambem via revoke explicito. Toda escrita so acontece
-- atraves das funcoes SECURITY DEFINER (que rodam com o privilegio do dono
-- da funcao, ignorando RLS, mas so depois de validar a regra de permissao).
grant select on demo_gestores, demo_clientes, demo_log to anon, authenticated;
revoke insert, update, delete on demo_clientes, demo_log, demo_gestores from anon, authenticated;

create or replace function demo_incluir_cliente(
  p_gestor_id int, p_razao_social text, p_cnpj text, p_porte text
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

  insert into demo_clientes (razao_social, cnpj, porte, gestor_id)
  values (left(trim(p_razao_social), 80), left(trim(p_cnpj), 20), p_porte, p_gestor_id)
  returning id into v_id;

  insert into demo_log (cliente_id, operacao, gestor_operador_id)
  values (v_id, 'INSERT', p_gestor_id);

  return v_id;
end; $$;

create or replace function demo_editar_cliente(
  p_cliente_id uuid, p_gestor_operador_id int, p_campo text, p_novo_valor text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_vertical_operador text;
  v_vertical_responsavel text;
  v_valor_antigo text;
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

  if p_campo = 'razao_social' then
    select razao_social into v_valor_antigo from demo_clientes where id = p_cliente_id;
    update demo_clientes set razao_social = left(trim(p_novo_valor), 80) where id = p_cliente_id;
  elsif p_campo = 'porte' then
    if p_novo_valor not in ('MEI','ME','EPP','MEDIA','GRANDE') then
      raise exception 'Porte invalido: %', p_novo_valor;
    end if;
    select porte into v_valor_antigo from demo_clientes where id = p_cliente_id;
    update demo_clientes set porte = p_novo_valor where id = p_cliente_id;
  else
    raise exception 'Campo nao editavel: %', p_campo;
  end if;

  insert into demo_log (cliente_id, operacao, campo, valor_antigo, valor_novo, gestor_operador_id)
  values (p_cliente_id, 'UPDATE', p_campo, v_valor_antigo, left(trim(p_novo_valor), 80), p_gestor_operador_id);
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

  update demo_clientes set ativo = false where id = p_cliente_id;

  insert into demo_log (cliente_id, operacao, gestor_operador_id)
  values (p_cliente_id, 'DELETE', p_gestor_operador_id);
end; $$;

grant execute on function demo_incluir_cliente(int, text, text, text) to anon, authenticated;
grant execute on function demo_editar_cliente(uuid, int, text, text) to anon, authenticated;
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
