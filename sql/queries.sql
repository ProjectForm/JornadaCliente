-- ============================================================================
-- CAMADA DE CLASSIFICACAO/VALIDACAO
-- Estas views substituem, em SQL, o que hoje esta escrito nas colunas H..AJ
-- da aba "Dados" da planilha original.
-- ============================================================================

DROP VIEW IF EXISTS v_contagem_base;
CREATE VIEW v_contagem_base AS
SELECT
    a.cliente_id,
    cc.plano_id,
    SUM(CASE WHEN p.tipo = 'DIAGNOSTICO'      AND a.atendimento_valido = 1 THEN 1 ELSE 0 END) AS diag_validos,
    SUM(CASE WHEN p.tipo = 'DIAGNOSTICO'                                   THEN 1 ELSE 0 END) AS diag_todos,
    SUM(CASE WHEN p.tipo = 'ASSESSORIA'       AND a.atendimento_valido = 1 THEN 1 ELSE 0 END) AS assessoria_validos,
    SUM(CASE WHEN p.tipo = 'ASSESSORIA'                                   THEN 1 ELSE 0 END) AS assessoria_todos,
    SUM(CASE WHEN p.tipo = 'SUSTENTABILIDADE' AND a.atendimento_valido = 1 THEN 1 ELSE 0 END) AS sustent_validos,
    SUM(CASE WHEN p.tipo = 'SUSTENTABILIDADE'                             THEN 1 ELSE 0 END) AS sustent_todos
FROM atendimentos a
JOIN produtos p        ON p.produto_id = a.produto_id
JOIN centros_custo cc  ON cc.centro_custo_id = a.centro_custo_id
GROUP BY a.cliente_id, cc.plano_id;

DROP VIEW IF EXISTS v_classificacao_plano;
CREATE VIEW v_classificacao_plano AS
SELECT
    c.cliente_id,
    c.porte,
    c.gestor_id,
    pl.plano_id,
    pl.nome AS plano_nome,
    pl.regra,
    COALESCE(b.diag_validos, 0)       AS diag_validos,
    COALESCE(b.diag_todos, 0)         AS diag_todos,
    COALESCE(b.assessoria_validos, 0) AS assessoria_validos,
    COALESCE(b.assessoria_todos, 0)   AS assessoria_todos,
    COALESCE(b.sustent_validos, 0)    AS sustent_validos,
    COALESCE(b.sustent_todos, 0)      AS sustent_todos,
    CASE
        WHEN pl.regra = 'DIAG_2ASSESSORIA' AND COALESCE(b.diag_validos, 0) >= 1
                                            AND COALESCE(b.assessoria_validos, 0) >= 2 THEN 1
        WHEN pl.regra = 'QUALQUER_SOLUCAO' AND COALESCE(b.sustent_validos, 0) >= 1 THEN 1
        ELSE 0
    END AS concluinte,
    CASE
        WHEN pl.regra = 'DIAG_2ASSESSORIA' AND COALESCE(b.diag_todos, 0) >= 1
                                            AND COALESCE(b.assessoria_todos, 0) >= 2 THEN 1
        WHEN pl.regra = 'QUALQUER_SOLUCAO' AND COALESCE(b.sustent_todos, 0) >= 1 THEN 1
        ELSE 0
    END AS concluiria_se_valido
FROM clientes c
JOIN plano_porte pp ON pp.porte = c.porte
JOIN planos pl      ON pl.plano_id = pp.plano_id
LEFT JOIN v_contagem_base b ON b.cliente_id = c.cliente_id AND b.plano_id = pl.plano_id;

DROP VIEW IF EXISTS v_inconsistencia_plano;
CREATE VIEW v_inconsistencia_plano AS
SELECT
    *,
    CASE WHEN concluiria_se_valido = 1 AND concluinte = 0 THEN 1 ELSE 0 END AS inconsistente
FROM v_classificacao_plano;

DROP VIEW IF EXISTS v_cliente_resumo;
CREATE VIEW v_cliente_resumo AS
SELECT
    cliente_id,
    SUM(concluinte)      AS qtd_planos_concluidos,
    SUM(inconsistente)   AS qtd_planos_inconsistentes,
    GROUP_CONCAT(CASE WHEN concluinte = 1 THEN plano_nome END, '; ')    AS planos_concluidos,
    GROUP_CONCAT(CASE WHEN inconsistente = 1 THEN plano_nome END, '; ') AS planos_inconsistentes,
    MAX(concluinte)                                    AS pj_distinto_oficial,
    MAX(CASE WHEN concluinte = 1 OR inconsistente = 1
             THEN 1 ELSE 0 END)                         AS elegivel_azul
FROM v_inconsistencia_plano
GROUP BY cliente_id;

DROP VIEW IF EXISTS v_cliente_status;
CREATE VIEW v_cliente_status AS
SELECT
    c.cliente_id,
    CASE
        WHEN COALESCE(r.qtd_planos_concluidos, 0) >= 1 THEN 'Concluinte'
        WHEN NOT EXISTS (SELECT 1 FROM atendimentos a WHERE a.cliente_id = c.cliente_id) THEN 'Sem atendimento'
        ELSE 'Participante'
    END AS status
FROM clientes c
LEFT JOIN v_cliente_resumo r ON r.cliente_id = c.cliente_id;

DROP VIEW IF EXISTS v_dados_cliente;
CREATE VIEW v_dados_cliente AS
SELECT
    c.cliente_id,
    c.razao_social,
    c.cnpj,
    c.porte,
    c.municipio,
    c.gestor_id,
    g.nome     AS gestor,
    g.vertical AS vertical,
    s.status,
    COALESCE(r.qtd_planos_concluidos, 0)    AS qtd_planos_concluidos,
    COALESCE(r.qtd_planos_inconsistentes,0) AS qtd_planos_inconsistentes,
    r.planos_concluidos,
    r.planos_inconsistentes,
    COALESCE(r.pj_distinto_oficial, 0) AS pj_distinto_oficial,
    COALESCE(r.elegivel_azul, 0)       AS elegivel_azul,
    pf.respondeu,
    pf.aumento_faturamento_pct
FROM clientes c
JOIN gestores g              ON g.gestor_id = c.gestor_id
JOIN v_cliente_status s      ON s.cliente_id = c.cliente_id
LEFT JOIN v_cliente_resumo r ON r.cliente_id = c.cliente_id
LEFT JOIN pesquisa_faturamento pf ON pf.cliente_id = c.cliente_id;

DROP VIEW IF EXISTS v_controle_gestor;
CREATE VIEW v_controle_gestor AS
SELECT
    g.gestor_id,
    g.nome     AS gestor,
    g.vertical AS vertical,
    COUNT(d.cliente_id)                                            AS clientes_na_carteira,
    SUM(d.pj_distinto_oficial)                                      AS pj_distintos,
    SUM(d.qtd_planos_inconsistentes)                                AS total_inconsistencias,
    SUM(CASE WHEN d.status = 'Sem atendimento' THEN 1 ELSE 0 END)   AS clientes_sem_atendimento,
    SUM(d.respondeu)                                                AS respondeu_pesquisa,
    ROUND(100.0 * SUM(d.respondeu) / COUNT(d.cliente_id), 1)        AS pct_respondeu,
    ROUND(AVG(CASE WHEN d.respondeu = 1 THEN d.aumento_faturamento_pct END), 1) AS media_aumento_faturamento_pct
FROM v_dados_cliente d
JOIN gestores g ON g.gestor_id = d.gestor_id
GROUP BY g.gestor_id, g.nome, g.vertical
ORDER BY g.vertical, g.nome;

DROP VIEW IF EXISTS v_controle_vertical;
CREATE VIEW v_controle_vertical AS
SELECT
    vertical,
    COUNT(cliente_id)                                          AS clientes_na_carteira,
    SUM(pj_distinto_oficial)                                    AS pj_distintos,
    SUM(qtd_planos_inconsistentes)                              AS total_inconsistencias,
    SUM(respondeu)                                              AS respondeu_pesquisa,
    ROUND(100.0 * SUM(respondeu) / COUNT(cliente_id), 1)        AS pct_respondeu,
    ROUND(AVG(CASE WHEN respondeu = 1 THEN aumento_faturamento_pct END), 1) AS media_aumento_faturamento_pct
FROM v_dados_cliente
GROUP BY vertical
ORDER BY vertical;
