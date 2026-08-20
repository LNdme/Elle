"""
test_main_remark.py — Vérifie /agents/{key}/remark : révision ciblée d'un
seul bloc du Canevas, avec le même mécanisme d'annulation que /chat.
"""
import asyncio
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("ELLE_MODEL_PROVIDER", "anthropic")
os.environ.setdefault("ANTHROPIC_API_KEY", "sk-ant-fake-for-import-only")
os.environ.setdefault("ELLE_MCP_URL", "http://localhost:3001/mcp")

sys.path.insert(0, str(Path(__file__).parent.parent / "elle-agents"))

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from google.adk.events.event import Event  # noqa: E402
from google.genai import types  # noqa: E402

import main  # noqa: E402


def text_event(text: str) -> Event:
    return Event(author="agent", content=types.Content(role="model", parts=[types.Part(text=text)]))


class FakeRunner:
    def __init__(self, events):
        self._events = events
        self.captured_message_text = None

    async def run_async(self, *, user_id, session_id, new_message):
        self.captured_message_text = new_message.parts[0].text
        for e in self._events:
            yield e


class NeverDisconnectingRequest:
    async def is_disconnected(self):
        return False


class DisconnectsImmediatelyRequest:
    async def is_disconnected(self):
        return True


class SlowFakeRunner:
    def __init__(self):
        self.was_cancelled = False

    async def run_async(self, *, user_id, session_id, new_message):
        try:
            await asyncio.sleep(5)
            yield text_event("trop tard")
        except asyncio.CancelledError:
            self.was_cancelled = True
            raise


@pytest.mark.asyncio
async def test_remark_happy_path_revises_only_target_block(monkeypatch):
    reply = (
        "Fait.\n```json\n"
        '{"block": {"id": "b2", "type": "text", "text": "Texte révisé avec un exemple concret."}}'
        "\n```"
    )
    fake = FakeRunner([text_event(reply)])
    monkeypatch.setitem(main.RUNNERS, "blog", fake)

    req = main.RemarkRequest(
        target_block={"id": "b2", "type": "text", "text": "Ancien texte."},
        remark="ajoute un exemple concret",
    )
    resp = await main._run_remark("blog", req, NeverDisconnectingRequest())

    assert resp.block["id"] == "b2"
    assert "révisé" in resp.block["text"]
    # le bloc cible et la remarque doivent bien atteindre le message envoyé au modèle
    assert "Ancien texte." in fake.captured_message_text
    assert "ajoute un exemple concret" in fake.captured_message_text


@pytest.mark.asyncio
async def test_remark_rejects_missing_target_block_fields():
    req = main.RemarkRequest(target_block={"text": "sans id ni type"}, remark="x")
    with pytest.raises(HTTPException) as exc:
        await main._run_remark("blog", req, NeverDisconnectingRequest())
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_remark_rejects_empty_remark(monkeypatch):
    fake = FakeRunner([text_event("peu importe")])
    monkeypatch.setitem(main.RUNNERS, "blog", fake)
    req = main.RemarkRequest(target_block={"id": "b2", "type": "text"}, remark="   ")
    with pytest.raises(HTTPException) as exc:
        await main._run_remark("blog", req, NeverDisconnectingRequest())
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_remark_returns_502_if_agent_drifts_to_wrong_id(monkeypatch):
    reply = '```json\n{"block": {"id": "AUTRE", "type": "text", "text": "x"}}\n```'
    fake = FakeRunner([text_event(reply)])
    monkeypatch.setitem(main.RUNNERS, "blog", fake)
    req = main.RemarkRequest(target_block={"id": "b2", "type": "text"}, remark="x")
    with pytest.raises(HTTPException) as exc:
        await main._run_remark("blog", req, NeverDisconnectingRequest())
    assert exc.value.status_code == 502


@pytest.mark.asyncio
async def test_remark_returns_502_if_agent_replies_without_json(monkeypatch):
    fake = FakeRunner([text_event("Je ne sais pas trop quoi changer ici.")])
    monkeypatch.setitem(main.RUNNERS, "blog", fake)
    req = main.RemarkRequest(target_block={"id": "b2", "type": "text"}, remark="x")
    with pytest.raises(HTTPException) as exc:
        await main._run_remark("blog", req, NeverDisconnectingRequest())
    assert exc.value.status_code == 502


@pytest.mark.asyncio
async def test_remark_can_be_cancelled_like_chat(monkeypatch):
    slow = SlowFakeRunner()
    monkeypatch.setitem(main.RUNNERS, "blog", slow)
    req = main.RemarkRequest(target_block={"id": "b2", "type": "text"}, remark="x")

    start = time.monotonic()
    with pytest.raises(HTTPException) as exc:
        await main._run_remark("blog", req, DisconnectsImmediatelyRequest())
    elapsed = time.monotonic() - start

    assert elapsed < 2.0
    assert exc.value.status_code == 499
    await asyncio.sleep(0.05)
    assert slow.was_cancelled
