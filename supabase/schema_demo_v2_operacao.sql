-- ============================================================================
-- CADASTRO -- ETAPA 2: governanca (historico, versionamento, restauracao,
-- reatribuicao de gestor) + suporte a filtros/ordenacao/paginacao no banco.
--
-- Este script e ADITIVO sobre supabase/schema_demo.sql -- ao contrario
-- daquele arquivo, este NAO reseta o Cadastro. Ele so:
--   - cria 1 tabela nova (demo_clientes_versoes);
--   - substitui a view de leitura (view = definicao de consulta, sem dados
--     proprios -- substitui-la nao apaga nada de demo_clientes);
--   - substitui 3 funcoes existentes (mesma assinatura -- grants preservados)
--     para tambem gravar uma versao a cada escrita;
--   - cria 2 funcoes novas (reatribuir gestor, restaurar versao);
--   - cria indices;
--   - alarga 1 check constraint (permite o novo valor 'RESTORE' no log);
--   - corrige o texto "Sandbox cheio" (sobrou da Etapa 1) para "Cadastro cheio".
--
-- Como aplicar: Dashboard do Supabase -> SQL Editor -> New query -> colar
-- este arquivo inteiro -> Run. NAO apaga clientes, gestores, atendimentos
-- ou log existentes.
--
-- Pre-requisito: supabase/schema_demo.sql ja aplicado (senao as tabelas
-- demo_clientes/demo_gestores/demo_log referenciadas abaixo nao existem).
-- ============================================================================

-- ============================================================================
-- 1) REGRA DE "CLIENTE PRIORITARIO" -- decisao de negocio (ver docs/AUDITORIA_E_VERSIONAMENTO.md):
--    passa a ser 100% calculada: respondeu a pesquisa, informou aumento de
--    faturamento, e AINDA NAO e Concluinte (se completar a regra de conclusao,
--    deixa de ser "prioritario" e passa a ser "Concluinte"). Nunca mais uma
--    marcacao manual do gestor -- o campo manual antigo (demo_clientes.prioritario)
--    e preservado no banco (nao apagamos dado), mas passa a ser exposto na
--    view como "sinalizacao_manual" e sai da interface (ver supabase-demo.js).
--
-- drop view (nao apaga dados -- view e so a definicao da consulta) para poder
-- renomear a coluna existente sem violar a regra do Postgres que impede
-- "create or replace view" de mudar o nome de uma coluna ja existente.
-- ============================================================================
drop view if exists v_demo_clientes_completo;

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

grant select on v_demo_clientes_completo to anon, authenticated;

-- ============================================================================
-- 2) VERSIONAMENTO -- snapshot completo do registro a cada escrita relevante
--    em demo_clientes (INSERT/UPDATE/reatribuicao/restauracao). NAO versiona
--    demo_atendimentos (ja tem trilha propria em demo_log com contagens
--    antes/depois -- versionar o snapshot de demo_clientes nao acrescentaria
--    nada, pois status/pj_distinto sao calculados, nao armazenados).
-- ============================================================================
create table if not exists demo_clientes_versoes (
  id bigint generated always as identity primary key,
  cliente_id uuid not null references demo_clientes(id) on delete cascade,
  versao int not null,
  operacao text not null check (operacao in ('INSERT','UPDATE','RESTORE')),
  gestor_operador_id int not null references demo_gestores(gestor_id),
  snapshot jsonb not null,
  criado_em timestamptz not null default now(),
  unique (cliente_id, versao)
);

alter table demo_clientes_versoes enable row level security;
drop policy if exists demo_clientes_versoes_select on demo_clientes_versoes;
create policy demo_clientes_versoes_select on demo_clientes_versoes for select using (true);
grant select on demo_clientes_versoes to anon, authenticated;
revoke insert, update, delete on demo_clientes_versoes from anon, authenticated;

-- ============================================================================
-- 3) demo_log -- alarga o check constraint para aceitar 'RESTORE'
--    (reatribuicao de gestor usa 'UPDATE', igual ao CLI adicionar_cliente.py)
-- ============================================================================
alter table demo_log drop constraint if exists demo_log_operacao_check;
alter table demo_log add constraint demo_log_operacao_check
  check (operacao in ('INSERT','UPDATE','DELETE','ATENDIMENTO','IMPORT','RESTORE'));

-- ============================================================================
-- 4) INDICES -- baixo impacto real com o teto de 200 clientes ativos, mas
--    corretos e preparados para o cadastro crescer (item "arquitetura
--    preparada para evolucao"). Nenhum e destrutivo.
-- ============================================================================
create index if not exists idx_demo_clientes_gestor_id on demo_clientes (gestor_id) where ativo;
create index if not exists idx_demo_clientes_cnpj on demo_clientes (cnpj) where ativo;
create index if not exists idx_demo_clientes_razao_lower on demo_clientes (lower(razao_social)) where ativo;
create index if not exists idx_demo_log_cliente_criado on demo_log (cliente_id, criado_em desc);
create index if not exists idx_demo_clientes_versoes_cliente on demo_clientes_versoes (cliente_id, versao desc);

-- ============================================================================
-- 5) demo_incluir_cliente -- mesma assinatura (grants preservados). Muda so:
--    (a) mensagem de limite ("Sandbox cheio" -> "Cadastro cheio", sobra da
--        Etapa 1); (b) nao grava mais o campo manual "prioritario" vindo do
--        formulario (saiu da UI -- ver item 1); (c) grava a versao 1.
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
    raise exception 'Cadastro cheio no momento (limite de demonstracao). Tente novamente mais tarde.';
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

-- ============================================================================
-- 6) demo_editar_cliente -- mesma assinatura. Muda so: (a) 'prioritario'
--    sai da lista de campos editaveis (campo manual descontinuado na UI, ver
--    item 1); (b) ao final, se algo mudou, grava uma nova versao.
-- ============================================================================
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

-- ============================================================================
-- 7) demo_excluir_cliente -- mesma assinatura, sem mudanca de comportamento
--    (mantido aqui so para referencia -- nao precisa recriar, mas o
--    create or replace e idempotente e nao tem custo rodar de novo).
-- ============================================================================
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

-- ============================================================================
-- 8) demo_reatribuir_gestor -- NOVA. Traz para o Cadastro a funcionalidade
--    que ja existia no CLI (adicionar_cliente.py::reatribuir_gestor):
--    quem tem permissao sobre o cliente pode reatribui-lo a QUALQUER gestor
--    existente (inclusive de outra vertical -- mesma regra do CLI, que nao
--    restringe o gestor de destino). So quem reatribui precisa ter permissao
--    sobre o gestor ATUAL do cliente.
-- ============================================================================
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

-- ============================================================================
-- 9) demo_restaurar_versao_cliente -- NOVA. Reaplica os campos de negocio de
--    uma versao anterior sobre o registro atual. NUNCA apaga versoes -- a
--    propria restauracao cria uma versao nova (RESTORE). So funciona em
--    clientes ATIVOS (restaurar um cliente excluido/"desfazer exclusao" fica
--    fora desta etapa -- ver docs/AUDITORIA_E_VERSIONAMENTO.md, limitacoes).
-- ============================================================================
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

grant execute on function demo_incluir_cliente(int, text, text, text, jsonb) to anon, authenticated;
grant execute on function demo_editar_cliente(uuid, int, jsonb) to anon, authenticated;
grant execute on function demo_excluir_cliente(uuid, int) to anon, authenticated;
grant execute on function demo_reatribuir_gestor(uuid, int, int) to anon, authenticated;
grant execute on function demo_restaurar_versao_cliente(bigint, int) to anon, authenticated;

-- ============================================================================
-- 10) Autolimpeza -- estende o job existente para tambem limpar versoes
--     antigas (defesa extra; a FK on delete cascade ja limparia sozinha
--     quando o cliente-pai for apagado, mas isso cobre o caso de a politica
--     de retencao de demo_clientes mudar no futuro sem que alguem lembre de
--     demo_clientes_versoes). Se pg_cron nao estiver disponivel neste
--     projeto Supabase, as instrucoes abaixo vao falhar -- pode ignorar o
--     erro, o resto do script ja rodou e funciona sem isso (igual ao aviso
--     original em schema_demo.sql).
-- ============================================================================
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'limpar_sandbox_demo';
exception when others then
  null;
end $$;

select cron.schedule(
  'limpar_sandbox_demo',
  '0 3 * * *',
  $$delete from demo_clientes_versoes where criado_em < now() - interval '24 hours';
    delete from demo_log where criado_em < now() - interval '24 hours';
    delete from demo_clientes where criado_em < now() - interval '24 hours';$$
);
