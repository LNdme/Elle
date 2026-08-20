"""
test_main_contract.py — Vérifie le câblage réel de main.py, en particulier
que les pièces jointes atteignent bien le message envoyé au modèle et que
la réponse est correctement construite (doc/choice/tool_calls).

Le Runner réel appellerait un vrai modèle (indisponible dans ce bac à
sable) : on remplace RUNNERS[...] par un faux runner dont run_async() est
un générateur asynchrone produisant de VRAIS objets google.adk.events.Event
(pas des dicts approximatifs) — même technique que
tests-python/test_web_search_tool.py pour FunctionTool.
"""
import os
import sys
from pathlib import Path

os.environ.setdefault("ELLE_MODEL_PROVIDER", "anthropic")
os.environ.setdefault("ANTHROPIC_API_KEY", "sk-ant-fake-for-import-only")
os.environ.setdefault("ELLE_MCP_URL", "http://localhost:3001/mcp")

sys.path.insert(0, str(Path(__file__).parent.parent / "elle-agents"))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from google.adk.events.event import Event  # noqa: E402
from google.genai import types  # noqa: E402

import main  # noqa: E402


class FakeRunner:
    """Capture le Content envoyé, rejoue une séquence d'Event fixée à l'avance."""

    def __init__(self, events):
        self._events = events
        self.captured_content = None

    async def run_async(self, *, user_id, session_id, new_message):
        self.captured_content = new_message
        for e in self._events:
            yield e


def text_event(text: str) -> Event:
    return Event(author="agent", content=types.Content(role="model", parts=[types.Part(text=text)]))


def tool_call_event(name: str, response: dict) -> Event:
    return Event(
        author="agent",
        content=types.Content(role="tool", parts=[types.Part(function_response=types.FunctionResponse(name=name, response=response))]),
    )


@pytest.fixture
def client():
    return TestClient(main.app)


@pytest.fixture
def fake_runner_for_blog(monkeypatch):
    def _install(events):
        fake = FakeRunner(events)
        monkeypatch.setitem(main.RUNNERS, "blog", fake)
        return fake
    return _install


def test_rejects_empty_message_without_attachments(client):
    r = client.post("/agents/blog/chat", json={"message": ""})
    assert r.status_code == 400


def test_accepts_attachments_only_no_message(client, fake_runner_for_blog):
    fake = fake_runner_for_blog([text_event("Bien reçu.")])
    r = client.post("/agents/blog/chat", json={
        "message": "",
        "attachments": [{"kind": "text", "name": "notes.md", "content": "Idée clé."}],
    })
    assert r.status_code == 200
    # le préambule d'attachment doit être injecté dans le message envoyé au modèle
    sent_text = fake.captured_content.parts[0].text
    assert "notes.md" in sent_text
    assert "Idée clé." in sent_text


def test_image_attachment_url_reaches_model_message(client, fake_runner_for_blog):
    fake = fake_runner_for_blog([text_event("Illustration ajoutée.")])
    r = client.post("/agents/blog/chat", json={
        "message": "Insère cette photo en illustration",
        "attachments": [{"kind": "image", "name": "cover.jpg", "url": "/uploads/real-hash.jpg"}],
    })
    assert r.status_code == 200
    sent_text = fake.captured_content.parts[0].text
    assert "/uploads/real-hash.jpg" in sent_text
    assert "cover.jpg" in sent_text
    assert "Insère cette photo" in sent_text  # le message original suit le préambule


def test_doc_and_sources_extracted_end_to_end(client, fake_runner_for_blog):
    reply_with_doc = (
        "Voici un brouillon.\n"
        '```json\n'
        '{"title": "Le filtre papier", "kick": "Article", '
        '"blocks": [{"type": "text", "text": "Un texte."}], '
        '"sources": [{"title": "notes.md", "url": ""}]}\n'
        '```'
    )
    fake_runner_for_blog([text_event(reply_with_doc)])
    r = client.post("/agents/blog/chat", json={"message": "Rédige l'article", "attachments": []})
    assert r.status_code == 200
    data = r.json()
    assert "```json" not in data["reply"]
    assert data["doc"]["title"] == "Le filtre papier"
    assert data["doc"]["sources"][0]["title"] == "notes.md"
    assert data["doc"]["sources"][0]["url"] == ""


def test_tool_calls_captured_from_create_draft_event(client, fake_runner_for_blog):
    events = [
        tool_call_event("create_draft", {"ok": True, "id": 42}),
        text_event("Brouillon créé."),
    ]
    fake_runner_for_blog(events)
    r = client.post("/agents/blog/chat", json={"message": "Crée le brouillon"})
    assert r.status_code == 200
    data = r.json()
    assert len(data["tool_calls"]) == 1
    assert data["tool_calls"][0]["name"] == "create_draft"
    assert data["tool_calls"][0]["result"]["id"] == 42
