"""
Mock local da BrasilAPI (https://brasilapi.com.br/api/cnpj/v1/{cnpj}).

Por que um mock:
  - Os CNPJs deste case sao 100% ficticios (gerados por script), entao uma
    chamada real a BrasilAPI so retornaria "CNPJ nao encontrado" para todos.
  - Este modulo replica o FORMATO exato da resposta real da BrasilAPI, para
    que o restante do pipeline (etl_pipeline.py) seja identico ao que seria
    usado em producao com a API real -- troque `consultar_cnpj_mock` por
    uma chamada `requests.get(...)` real e o resto do codigo nao muda.
"""
import hashlib
import random
import time

MUNICIPIOS = [
    "SAO JOSE DO RIO PRETO", "RIBEIRAO PRETO", "CAMPINAS", "SOROCABA",
    "BAURU", "PRESIDENTE PRUDENTE", "ARACATUBA", "SAO CARLOS", "FRANCA",
    "MARILIA",
]

SITUACOES = ["ATIVA", "ATIVA", "ATIVA", "ATIVA", "BAIXADA"]

def _seed_from_cnpj(cnpj: str) -> int:
    return int(hashlib.md5(cnpj.encode()).hexdigest(), 16) % (2**32)

def consultar_cnpj_mock(cnpj: str, razao_social_cadastrada: str, latencia_ms: int = 0) -> dict:
    """Simula a resposta da BrasilAPI para um CNPJ ficticio."""
    if latencia_ms:
        time.sleep(latencia_ms / 1000)

    rnd = random.Random(_seed_from_cnpj(cnpj))
    municipio = rnd.choice(MUNICIPIOS)
    situacao = rnd.choice(SITUACOES)

    return {
        "cnpj": cnpj,
        "razao_social": razao_social_cadastrada,
        "municipio": municipio,
        "uf": "SP",
        "descricao_situacao_cadastral": situacao,
        "data_situacao_cadastral": "2024-01-01",
        "fonte": "MOCK_LOCAL_BRASILAPI",
    }

def consultar_cnpj_real_com_fallback(cnpj: str, razao_social_cadastrada: str):
    """Exemplo de como isso ficaria em producao com a API real (desativado
    neste case: os CNPJs sao ficticios e so retornariam 404)."""
    # import requests
    # try:
    #     resp = requests.get(f"https://brasilapi.com.br/api/cnpj/v1/{cnpj}", timeout=5)
    #     if resp.status_code == 200:
    #         data = resp.json()
    #         return {
    #             "cnpj": cnpj,
    #             "razao_social": data.get("razao_social", razao_social_cadastrada),
    #             "municipio": data.get("municipio"),
    #             "uf": data.get("uf"),
    #             "descricao_situacao_cadastral": data.get("descricao_situacao_cadastral"),
    #             "fonte": "BRASILAPI_REAL",
    #         }
    # except Exception:
    #     pass
    return consultar_cnpj_mock(cnpj, razao_social_cadastrada)
