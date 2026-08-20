import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "elle-agents"))
import web_search_tool as wst


# ---- fixtures : formes réelles documentées de l'API ollama.com ----

SEARCH_RESPONSE = {
    "results": [
        {"title": "Ollama", "url": "https://ollama.com/", "content": "Cloud models are now available in Ollama..."},
        {"title": "What is Ollama?", "url": "https://www.hostinger.com/tutorials/what-is-ollama", "content": "Ollama is an open-source tool..."},
        {"title": "Ollama Explained", "url": "https://www.geeksforgeeks.org/ollama-explained", "content": "..."},
    ]
}
FETCH_RESPONSE = {
    "title": "Ollama",
    "content": "Cloud models are now available in Ollama...",
    "links": ["https://ollama.com/", "https://ollama.com/models"],
}


def test_parse_search_response_happy_path():
    results = wst.parse_search_response(SEARCH_RESPONSE)
    assert len(results) == 3
    assert results[0]["url"] == "https://ollama.com/"
    assert results[0]["title"] == "Ollama"


def test_parse_search_response_respects_max_results():
    results = wst.parse_search_response(SEARCH_RESPONSE, max_results=1)
    assert len(results) == 1


def test_parse_search_response_rejects_unexpected_shape():
    with pytest.raises(wst.WebSearchError, match="inattendue"):
        wst.parse_search_response({"unexpected": "shape"})


def test_parse_search_response_skips_entries_without_url():
    data = {"results": [{"title": "Sans URL"}, {"title": "Avec URL", "url": "https://x.example"}]}
    results = wst.parse_search_response(data)
    assert len(results) == 1
    assert results[0]["url"] == "https://x.example"


def test_parse_fetch_response_happy_path():
    result = wst.parse_fetch_response(FETCH_RESPONSE)
    assert result["title"] == "Ollama"
    assert "Cloud models" in result["content"]
    assert len(result["links"]) == 2


def test_parse_fetch_response_rejects_unexpected_shape():
    with pytest.raises(wst.WebSearchError, match="inattendue"):
        wst.parse_fetch_response({"no_content_field": True})


def test_web_search_tool_missing_api_key(monkeypatch):
    monkeypatch.delenv("OLLAMA_API_KEY", raising=False)
    tool = wst.make_web_search_tool(post_fn=lambda *a, **k: SEARCH_RESPONSE)
    with pytest.raises(wst.WebSearchError, match="OLLAMA_API_KEY"):
        tool("qu'est-ce qu'Ollama ?")


def test_web_search_tool_happy_path_with_injected_transport(monkeypatch):
    monkeypatch.setenv("OLLAMA_API_KEY", "test-key-123")
    captured = {}

    def fake_post(url, headers, json_body):
        captured["url"] = url
        captured["headers"] = headers
        captured["json_body"] = json_body
        return SEARCH_RESPONSE

    tool = wst.make_web_search_tool(post_fn=fake_post)
    result = tool("qu'est-ce qu'Ollama ?")

    assert captured["url"] == wst.OLLAMA_WEB_SEARCH_URL
    assert captured["headers"]["Authorization"] == "Bearer test-key-123"
    assert captured["json_body"] == {"query": "qu'est-ce qu'Ollama ?"}
    assert result["query"] == "qu'est-ce qu'Ollama ?"
    assert len(result["results"]) == 3


def test_web_search_tool_wraps_transport_errors(monkeypatch):
    monkeypatch.setenv("OLLAMA_API_KEY", "test-key-123")

    def failing_post(url, headers, json_body):
        raise ConnectionError("DNS resolution failed")

    tool = wst.make_web_search_tool(post_fn=failing_post)
    with pytest.raises(wst.WebSearchError, match="Recherche web impossible"):
        tool("x")


def test_web_fetch_tool_happy_path(monkeypatch):
    monkeypatch.setenv("OLLAMA_API_KEY", "test-key-123")
    captured = {}

    def fake_post(url, headers, json_body):
        captured["url"] = url
        captured["json_body"] = json_body
        return FETCH_RESPONSE

    tool = wst.make_web_fetch_tool(post_fn=fake_post)
    result = tool("https://ollama.com")

    assert captured["url"] == wst.OLLAMA_WEB_FETCH_URL
    assert captured["json_body"] == {"url": "https://ollama.com"}
    assert result["title"] == "Ollama"


def test_web_fetch_tool_missing_api_key(monkeypatch):
    monkeypatch.delenv("OLLAMA_API_KEY", raising=False)
    tool = wst.make_web_fetch_tool(post_fn=lambda *a, **k: FETCH_RESPONSE)
    with pytest.raises(wst.WebSearchError, match="OLLAMA_API_KEY"):
        tool("https://ollama.com")


def test_tools_have_adk_friendly_signatures():
    """ADK dérive la déclaration d'outil de la docstring + des annotations :
    on vérifie qu'elles sont présentes (régression si on oublie de documenter),
    et surtout qu'ADK arrive réellement à construire un agent avec ces outils
    (voir test_tools_integrate_with_real_adk_agent ci-dessous pour la
    vérification qui compte vraiment)."""
    search_tool = wst.make_web_search_tool(post_fn=lambda *a, **k: SEARCH_RESPONSE)
    fetch_tool = wst.make_web_fetch_tool(post_fn=lambda *a, **k: FETCH_RESPONSE)
    assert search_tool.__doc__ and "query" in search_tool.__doc__
    assert fetch_tool.__doc__ and "url" in fetch_tool.__doc__
    # web_search_tool.py utilise `from __future__ import annotations` (PEP 563) :
    # les annotations sont donc stockées comme chaînes ("str"), pas comme les
    # objets de type eux-mêmes — ADK les résout via typing.get_type_hints(),
    # ce que le test suivant vérifie pour de vrai plutôt que de le supposer.
    assert search_tool.__annotations__.get("query") == "str"
    assert fetch_tool.__annotations__.get("url") == "str"


def test_tools_integrate_with_real_adk_agent():
    """Le vrai test qui compte : ADK doit pouvoir construire un FunctionTool
    à partir de ces fonctions sans lever d'erreur, y compris avec les
    annotations en chaînes issues de `from __future__ import annotations`."""
    from google.adk.tools.function_tool import FunctionTool

    search_tool = wst.make_web_search_tool(post_fn=lambda *a, **k: SEARCH_RESPONSE)
    fetch_tool = wst.make_web_fetch_tool(post_fn=lambda *a, **k: FETCH_RESPONSE)

    wrapped_search = FunctionTool(search_tool)
    wrapped_fetch = FunctionTool(fetch_tool)

    decl_search = wrapped_search._get_declaration()
    decl_fetch = wrapped_fetch._get_declaration()
    assert decl_search.name == "web_search"
    assert decl_fetch.name == "web_fetch"
    # Cette version d'ADK a la fonctionnalité expérimentale
    # JSON_SCHEMA_FOR_FUNC_DECL active par défaut : le schéma vit dans
    # parameters_json_schema, pas dans le champ "parameters" historique.
    assert "query" in decl_search.parameters_json_schema["properties"]
    assert "query" in decl_search.parameters_json_schema["required"]
    assert "url" in decl_fetch.parameters_json_schema["properties"]
    assert "url" in decl_fetch.parameters_json_schema["required"]
