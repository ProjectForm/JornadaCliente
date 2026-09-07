-- ============================================================================
-- SCHEMA: Painel de Acompanhamento de Carteira (reconstrucao com dados ficticios)
-- Motor: SQLite
-- ============================================================================

PRAGMA foreign_keys = ON;

DROP TABLE IF EXISTS gestores;
CREATE TABLE gestores (
    gestor_id   INTEGER PRIMARY KEY,
    nome        TEXT NOT NULL,
    vertical    TEXT NOT NULL
);

DROP TABLE IF EXISTS planos;
CREATE TABLE planos (
    plano_id        INTEGER PRIMARY KEY,
    nome            TEXT NOT NULL,
    regra           TEXT NOT NULL CHECK (regra IN ('DIAG_2ASSESSORIA', 'QUALQUER_SOLUCAO')),
    porte_elegivel  TEXT NOT NULL  -- lista separada por '|', ex: 'MEI|ME|EPP'
);

-- Tabela de apoio: elegibilidade de porte por plano (derivada de planos.porte_elegivel)
DROP TABLE IF EXISTS plano_porte;
CREATE TABLE plano_porte (
    plano_id    INTEGER NOT NULL REFERENCES planos(plano_id),
    porte       TEXT NOT NULL,
    PRIMARY KEY (plano_id, porte)
);

DROP TABLE IF EXISTS centros_custo;
CREATE TABLE centros_custo (
    centro_custo_id INTEGER PRIMARY KEY,
    codigo          TEXT NOT NULL UNIQUE,
    plano_id        INTEGER NOT NULL REFERENCES planos(plano_id)
);

DROP TABLE IF EXISTS produtos;
CREATE TABLE produtos (
    produto_id  INTEGER PRIMARY KEY,
    nome        TEXT NOT NULL,
    tipo        TEXT NOT NULL CHECK (tipo IN ('DIAGNOSTICO', 'ASSESSORIA', 'OTA', 'SUSTENTABILIDADE'))
);

DROP TABLE IF EXISTS clientes;
CREATE TABLE clientes (
    cliente_id      INTEGER PRIMARY KEY,
    razao_social    TEXT NOT NULL,
    cnpj            TEXT NOT NULL UNIQUE,
    porte           TEXT NOT NULL CHECK (porte IN ('MEI', 'ME', 'EPP', 'MEDIA', 'GRANDE')),
    gestor_id       INTEGER NOT NULL REFERENCES gestores(gestor_id),
    data_cadastro   TEXT NOT NULL,
    municipio       TEXT,
    razao_social_api TEXT,
    api_consultado_em TEXT
);

-- BASE: atendimentos brutos (equivalente a exportacao do BI/CRM)
DROP TABLE IF EXISTS atendimentos;
CREATE TABLE atendimentos (
    atendimento_id      INTEGER PRIMARY KEY,
    cliente_id          INTEGER NOT NULL REFERENCES clientes(cliente_id),
    centro_custo_id     INTEGER NOT NULL REFERENCES centros_custo(centro_custo_id),
    produto_id          INTEGER NOT NULL REFERENCES produtos(produto_id),
    data_atendimento    TEXT NOT NULL,
    frequencia          INTEGER NOT NULL DEFAULT 1,
    atendimento_valido  INTEGER NOT NULL CHECK (atendimento_valido IN (0, 1))
);

DROP TABLE IF EXISTS pesquisa_faturamento;
CREATE TABLE pesquisa_faturamento (
    cliente_id                 INTEGER PRIMARY KEY REFERENCES clientes(cliente_id),
    respondeu                  INTEGER NOT NULL CHECK (respondeu IN (0, 1)),
    aumento_faturamento_pct    REAL,
    data_resposta              TEXT
);

CREATE INDEX idx_atend_cliente ON atendimentos(cliente_id);
CREATE INDEX idx_atend_cc ON atendimentos(centro_custo_id);
CREATE INDEX idx_atend_produto ON atendimentos(produto_id);
CREATE INDEX idx_cliente_gestor ON clientes(gestor_id);
CREATE INDEX idx_cc_plano ON centros_custo(plano_id);
