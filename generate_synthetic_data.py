"""
Gerador de dataset sintetico - Case "Painel de Acompanhamento de Carteira"
100% dados ficticios, gerados por script, sem qualquer vinculo com dados reais.

Replica a estrutura em 4 camadas do sistema original:
  1) Base        -> atendimentos brutos (1 linha por atendimento)
  2) Regras       -> planos, centros de custo, produtos (tabela de regras de negocio)
  3) Clientes     -> cadastro de clientes + gestor responsavel
  4) (classificacao e dashboard sao calculados depois, na camada SQL/Python)
"""
import csv
import os
import random
from datetime import date, timedelta

random.seed(42)
OUT = os.path.join(os.path.dirname(__file__), "data", "raw")
os.makedirs(OUT, exist_ok=True)

N_CLIENTES = 2500
N_GESTORES = 16

VERTICAIS = [
    "Comercio e Servicos",
    "Tecnologia e Inovacao",
    "Turismo e Agronegocio",
    "Atendimento ao Cliente",
    "Empreendedorismo Cultural",
    "Consultoria Especializada",
    "Sustentabilidade",
]

NOMES_GESTORES = [
    "Ana Souza", "Bruno Lima", "Carla Dias", "Diego Alves", "Elisa Rocha",
    "Fabio Nunes", "Giovana Melo", "Hugo Ramos", "Iara Costa", "Joao Pedro",
    "Karina Reis", "Lucas Barros", "Mariana Teles", "Nicolas Vieira",
    "Olivia Prado", "Paulo Cezar",
]

gestores = []
for i, nome in enumerate(NOMES_GESTORES):
    gestores.append({
        "gestor_id": i + 1,
        "nome": nome,
        "vertical": VERTICAIS[i % len(VERTICAIS)],
    })

PLANOS = [
    {"plano_id": 1, "nome": "Plano A - Crescimento", "porte_elegivel": ["MEI", "ME", "EPP"], "regra": "DIAG_2ASSESSORIA"},
    {"plano_id": 2, "nome": "Plano B - Projetos Especiais", "porte_elegivel": ["MEI", "ME", "EPP"], "regra": "DIAG_2ASSESSORIA"},
    {"plano_id": 3, "nome": "Plano C - Parcerias Corporativas", "porte_elegivel": ["MEI", "ME", "EPP"], "regra": "DIAG_2ASSESSORIA"},
    {"plano_id": 4, "nome": "Plano D - Sustentabilidade", "porte_elegivel": ["ME", "EPP"], "regra": "QUALQUER_SOLUCAO"},
]

CENTROS_CUSTO = [
    {"centro_custo_id": 1, "codigo": "CC-1001", "plano_id": 1},
    {"centro_custo_id": 2, "codigo": "CC-1002", "plano_id": 1},
    {"centro_custo_id": 3, "codigo": "CC-2001", "plano_id": 2},
    {"centro_custo_id": 4, "codigo": "CC-2002", "plano_id": 2},
    {"centro_custo_id": 5, "codigo": "CC-2003", "plano_id": 2},
    {"centro_custo_id": 6, "codigo": "CC-3001", "plano_id": 3},
    {"centro_custo_id": 7, "codigo": "CC-4001", "plano_id": 4},
]

PRODUTOS = [
    {"produto_id": 101, "nome": "Diagnostico Momento Empresarial", "tipo": "DIAGNOSTICO"},
    {"produto_id": 102, "nome": "Diagnostico Estrategia de Crescimento", "tipo": "DIAGNOSTICO"},
    {"produto_id": 201, "nome": "Assessoria de Negocios", "tipo": "ASSESSORIA"},
    {"produto_id": 301, "nome": "Consultoria de Encerramento", "tipo": "OTA"},
    {"produto_id": 302, "nome": "Orientacao Tecnica Geral", "tipo": "OTA"},
    {"produto_id": 401, "nome": "Solucao Sustentabilidade Basica", "tipo": "SUSTENTABILIDADE"},
    {"produto_id": 402, "nome": "Solucao Sustentabilidade Avancada", "tipo": "SUSTENTABILIDADE"},
]

PORTE_PESOS = [("MEI", 0.45), ("ME", 0.35), ("EPP", 0.15), ("MEDIA", 0.04), ("GRANDE", 0.01)]

def sorteia_porte():
    r = random.random()
    acc = 0
    for porte, peso in PORTE_PESOS:
        acc += peso
        if r <= acc:
            return porte
    return "MEI"

def gera_cnpj_fake(seq):
    base = f"{seq:08d}"
    filial = "0001"
    dv = f"{(seq * 7) % 100:02d}"
    return f"{base}{filial}{dv}"

RAZOES = [
    "Comercial", "Distribuidora", "Industria", "Servicos", "Confeccoes",
    "Alimentos", "Tecnologia", "Construtora", "Transportes", "Papelaria",
]
SUFIXOS = ["Ltda", "EIRELI", "ME", "S.A.", "e Cia"]

clientes = []
for i in range(1, N_CLIENTES + 1):
    gestor = random.choice(gestores)
    clientes.append({
        "cliente_id": i,
        "razao_social": f"{random.choice(RAZOES)} {random.choice(['Silva','Souza','Oeste','Central','Norte','Litoral'])} {random.choice(SUFIXOS)}",
        "cnpj": gera_cnpj_fake(10_000_000 + i),
        "porte": sorteia_porte(),
        "gestor_id": gestor["gestor_id"],
        "data_cadastro": (date(2025, 1, 1) + timedelta(days=random.randint(0, 500))).isoformat(),
        "ativo": 1,
    })

atendimentos = []
atend_id = 1
for c in clientes:
    n_atend = random.choices([0, 1, 2, 3, 4, 5, 6], weights=[8, 15, 20, 22, 18, 12, 5])[0]
    porte = c["porte"]
    planos_possiveis = [p for p in PLANOS if porte in p["porte_elegivel"]]
    if not planos_possiveis or n_atend == 0:
        continue
    plano_escolhido = random.choice(planos_possiveis)
    ccs = [cc for cc in CENTROS_CUSTO if cc["plano_id"] == plano_escolhido["plano_id"]]
    cc = random.choice(ccs)
    if plano_escolhido["regra"] == "QUALQUER_SOLUCAO":
        pool_produtos = [p for p in PRODUTOS if p["tipo"] == "SUSTENTABILIDADE"]
    else:
        pool_produtos = [p for p in PRODUTOS if p["tipo"] in ("DIAGNOSTICO", "ASSESSORIA", "OTA")]
    for _ in range(n_atend):
        produto = random.choice(pool_produtos)
        valido = 0 if random.random() < 0.08 else 1
        atendimentos.append({
            "atendimento_id": atend_id,
            "cliente_id": c["cliente_id"],
            "centro_custo_id": cc["centro_custo_id"],
            "produto_id": produto["produto_id"],
            "data_atendimento": (date(2025, 2, 1) + timedelta(days=random.randint(0, 400))).isoformat(),
            "frequencia": 1,
            "atendimento_valido": valido,
            "ativo": 1,
        })
        atend_id += 1

pesquisa = []
for c in clientes:
    respondeu = random.random() < 0.38
    if respondeu:
        aumento = round(random.gauss(22, 18), 2)
        aumento = max(-15, min(90, aumento))
    else:
        aumento = None
    pesquisa.append({
        "cliente_id": c["cliente_id"],
        "respondeu": 1 if respondeu else 0,
        "aumento_faturamento_pct": aumento,
        "data_resposta": (date(2025, 6, 1) + timedelta(days=random.randint(0, 120))).isoformat() if respondeu else None,
    })

def write_csv(name, rows, fieldnames):
    path = os.path.join(OUT, name)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)
    print(f"  {name}: {len(rows)} linhas")

print("Gerando dataset sintetico...")
write_csv("gestores.csv", gestores, ["gestor_id", "nome", "vertical"])
write_csv("planos.csv", [{"plano_id": p["plano_id"], "nome": p["nome"], "regra": p["regra"],
                          "porte_elegivel": "|".join(p["porte_elegivel"])} for p in PLANOS],
          ["plano_id", "nome", "regra", "porte_elegivel"])
write_csv("centros_custo.csv", CENTROS_CUSTO, ["centro_custo_id", "codigo", "plano_id"])
write_csv("produtos.csv", PRODUTOS, ["produto_id", "nome", "tipo"])
write_csv("clientes.csv", clientes, ["cliente_id", "razao_social", "cnpj", "porte", "gestor_id", "data_cadastro", "ativo"])
write_csv("atendimentos.csv", atendimentos,
          ["atendimento_id", "cliente_id", "centro_custo_id", "produto_id", "data_atendimento", "frequencia", "atendimento_valido", "ativo"])
write_csv("pesquisa_faturamento.csv", pesquisa, ["cliente_id", "respondeu", "aumento_faturamento_pct", "data_resposta"])

print("\nResumo:")
print(f"  Clientes: {len(clientes)}")
print(f"  Atendimentos: {len(atendimentos)}")
print(f"  Gestores: {len(gestores)}  |  Verticais: {len(VERTICAIS)}")
print("OK - dataset gerado em data/raw/")
