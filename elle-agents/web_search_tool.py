"""
web_search_tool.py — Outil de recherche web partagé par les trois agents
Elle, utilisable quel que soit le fournisseur de modèle sous-jacent
(Anthropic, Gemini, Groq, Ollama, DeepSeek...), du moment que ce modèle
supporte le tool calling — c'est le cas des quatre modèles évoqués :
Nemotron-3-Super (taggé "tools" sur Ollama), Qwen3-Coder (famille Qwen3,
fiable pour le tool calling), DeepSeek-V3.1 (tool calling amélioré par
post-entraînement d'après sa fiche modèle), et DeepSeek via l'API directe.

Backend : l'API de recherche web HÉBERGÉE par Ollama
(https://ollama.com/api/web_search et /api/web_fetch) — un service séparé
de l'inférence elle-même. Nécessite un compte Ollama et sa propre clé
(OLLAMA_API_KEY), distincte de OLLAMA_API_BASE qui pointe vers votre
instance locale. Cette clé est nécessaire même si ELLE_MODEL_PROVIDER
n'est pas "ollama" : c'est un service de recherche indépendant du
fournisseur de modèle choisi.

Pourquoi pas de "citations" comme chez Anthropic : ici, le module SAIT
exactement quelles URLs il a renvoyées pour une recherche donnée — il n'y
a rien à extraire a posteriori de la réponse du modèle. C'est le code
appelant (l'agent, ou main.py) qui décide quoi faire de ces résultats
(les citer dans sa réponse, les proposer comme bibliographie...).
"""

from __future__ import annotations

import os
from typing import Callable, Optional

import requests

OLLAMA_WEB_SEARCH_URL = "https://ollama.com/api/web_search"
OLLAMA_WEB_FETCH_URL = "https://ollama.com/api/web_fetch"
DEFAULT_TIMEOUT_SECONDS = 20


class WebSearchError(Exception):
    """Erreur métier (clé absente, réponse inattendue...) — sûre à faire remonter à l'agent."""


def _default_post(url: str, headers: dict, json_body: dict) -> dict:
    r = requests.post(url, headers=headers, json=json_body, timeout=DEFAULT_TIMEOUT_SECONDS)
    r.raise_for_status()
    return r.json()


def _auth_headers() -> dict:
    key = os.environ.get("OLLAMA_API_KEY", "").strip()
    if not key:
        raise WebSearchError(
            "OLLAMA_API_KEY n'est pas défini — nécessaire pour la recherche web "
            "(compte Ollama, distinct de OLLAMA_API_BASE utilisé pour l'inférence locale)."
        )
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def parse_search_response(data: dict, max_results: int = 5) -> list[dict]:
    if not isinstance(data, dict) or not isinstance(data.get("results"), list):
        raise WebSearchError("Réponse de recherche web inattendue (pas de champ 'results').")
    out = []
    for r in data["results"][:max_results]:
        if not isinstance(r, dict) or not r.get("url"):
            continue
        out.append({"title": r.get("title") or r["url"], "url": r["url"], "content": r.get("content", "")})
    return out


def parse_fetch_response(data: dict) -> dict:
    if not isinstance(data, dict) or "content" not in data:
        raise WebSearchError("Réponse de récupération de page inattendue (pas de champ 'content').")
    return {"title": data.get("title", ""), "content": data.get("content", ""), "links": data.get("links", [])}


def make_web_search_tool(post_fn: Optional[Callable] = None, max_results: int = 5):
    """Fabrique la fonction-outil `web_search(query)` à passer directement
    dans `tools=[...]` d'un LlmAgent ADK — ADK génère sa déclaration à
    partir des annotations et de la docstring, comme pour tout autre outil.

    `post_fn` est injectable pour les tests (voir tests-python/) ; en usage
    réel, laissez la valeur par défaut (appel HTTP réel via `requests`).
    """
    poster = post_fn or _default_post

    def web_search(query: str) -> dict:
        """Recherche sur le web et renvoie jusqu'à quelques résultats (titre,
        URL, extrait). À utiliser pour vérifier un fait récent, un chiffre ou
        une référence précise avant de l'inclure dans un brouillon — pas
        systématiquement pour chaque échange.

        Args:
            query: la requête de recherche, en langage naturel.
        """
        try:
            data = poster(OLLAMA_WEB_SEARCH_URL, _auth_headers(), {"query": query})
        except WebSearchError:
            raise
        except Exception as e:
            raise WebSearchError(f"Recherche web impossible : {e}") from e
        return {"query": query, "results": parse_search_response(data, max_results=max_results)}

    return web_search


def make_web_fetch_tool(post_fn: Optional[Callable] = None):
    """Fabrique la fonction-outil `web_fetch(url)` — récupère le contenu
    d'une page précise, typiquement une URL obtenue via web_search dont on
    veut le détail avant de citer un chiffre exact."""
    poster = post_fn or _default_post

    def web_fetch(url: str) -> dict:
        """Récupère le contenu texte d'une page web à partir de son URL
        exacte (par exemple une page trouvée via web_search).

        Args:
            url: l'URL complète de la page à récupérer.
        """
        try:
            data = poster(OLLAMA_WEB_FETCH_URL, _auth_headers(), {"url": url})
        except WebSearchError:
            raise
        except Exception as e:
            raise WebSearchError(f"Récupération de page impossible : {e}") from e
        return parse_fetch_response(data)

    return web_fetch
