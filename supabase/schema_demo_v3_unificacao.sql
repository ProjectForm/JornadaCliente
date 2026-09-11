-- ============================================================================
-- ETAPA 2.5 -- UNIFICACAO DE BASE: o Cadastro deixa de ser um sandbox
-- descartavel e passa a ser a MESMA base que o Dashboard le (ao vivo). Isso
-- exige remover as duas salvaguardas que so faziam sentido para um sandbox
-- publico pequeno e efemero:
--
--   1) o teto de 200 clientes ativos em demo_incluir_cliente (o Dashboard
--      sozinho ja tem 2.500 clientes na carga inicial -- ver
--      supabase/seed_unificacao_2500_clientes.sql);
--   2) a limpeza automatica diaria (pg_cron apagava tudo com mais de 24h --
--      apagaria a base "oficial" todo dia).
--
-- ATENCAO -- IMPLICACAO DE SEGURANCA (decisao tomada em conversa com o Juan,
-- ver docs/AUDITORIA_E_VERSIONAMENTO.md): sem essas duas salvaguardas, e sem
-- autenticacao real, o Cadastro publicado passa a ser uma base
-- PERMANENTEMENTE editavel por qualquer visitante do site, sem reset
-- automatico. O historico/versionamento da Etapa 2 ajuda a AUDITAR e
-- REVERTER uma alteracao indevida (RPC demo_restaurar_versao_cliente), mas
-- nao IMPEDE a alteracao em si -- a unica protecao de escrita continua
-- sendo a regra de permissao por vertical (mesma de sempre).
--
-- Como aplicar: Dashboard do Supabase -> SQL Editor -> New query -> colar
-- este arquivo inteiro -> Run. Nao apaga nenhum dado.
--
-- Pre-requisito: supabase/schema_demo.sql e supabase/schema_demo_v2_operacao.sql
-- ja aplicados.
-- ============================================================================

-- 1) Remove o teto de 200 clientes ativos (mesma assinatura, grants preservados)
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

grant execute on function demo_incluir_cliente(int, text, text, text, jsonb) to anon, authenticated;

-- 2) Desliga a limpeza automatica diaria (nao reagenda com outro nome -- so
--    remove). Se pg_cron nao estiver disponivel neste projeto, isto vai
--    falhar -- pode ignorar o erro (nao ha nada para desligar).
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'limpar_sandbox_demo';
exception when others then
  null;
end $$;
