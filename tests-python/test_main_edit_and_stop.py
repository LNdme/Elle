"""
test_main_edit_and_stop.py — Vérifie deux fonctionnalités du chat :

1. « Message modifié » : rejoue un historique fourni dans une session
   neuve via l'API PUBLIQUE session_service.append_event() (pas de
   manipulation d'attributs internes) — vérifié en relisant ensuite la
   session réelle depuis session_service, pas seulement en supposant que
   l'appel a été fait.
2. « Arrêt d'un message en cours » : simule un client qui se déconnecte
   (Stop côté navigateur) pendant qu'un faux Runner tourne délibérément
   longtemps ; vérifie que la requête se termine vite (pas d'attente du
   Runner) ET que la tâche du Runner est réellement annulée (pas laissée
   tourner en arrière-plan).
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
from google.adk.events.event import Event  # noqa: E402
from google.genai import types  # noqa: E402

import main  # noqa: E402


def text_event(text: str) -> Event:
    return Event(author="agent", content=types.Content(role="model", parts=[types.Part(text=text)]))


class FakeRunner:
    def __init__(self, events):
        self._events = events
        self.captured_session_id = None

    async def run_async(self, *, user_id, session_id, new_message):
        self.captured_session_id = session_id
        for e in self._events:
            yield e


class NeverDisconnectingRequest:
    async def is_disconnected(self):
        return False


class DisconnectsImmediatelyRequest:
    async def is_disconnected(self):
        return True


class SlowFakeRunner:
    """Simule un modèle qui met du temps à répondre — sert à vérifier que
    l'annulation ne fait PAS attendre cette lenteur, et que la tâche est
    réellement interrompue (pas seulement ignorée)."""
    def __init__(self):
        self.was_cancelled = False
        self.completed = False

    async def run_async(self, *, user_id, session_id, new_message):
        try:
            await asyncio.sleep(5)
            self.completed = True
            yield text_event("trop tard")
        except asyncio.CancelledError:
            self.was_cancelled = True
            raise


@pytest.mark.asyncio
async def test_history_replay_creates_real_replayable_session(monkeypatch):
    fake = FakeRunner([text_event("Bien reçu, je continue.")])
    monkeypatch.setitem(main.RUNNERS, "blog", fake)

    req = main.ChatRequest(
        message="En fait, écris plutôt sur le thé",
        history=[
            main.HistoryTurn(role="user", content="Écris un article sur le café"),
            main.HistoryTurn(role="assistant", content="Voici un brouillon sur le café."),
        ],
    )
    resp = await main._run_chat("blog", req, NeverDisconnectingRequest())

    assert resp.reply == "Bien reçu, je continue."
    new_session_id = resp.session_id

    # la session rejouée existe réellement et contient bien les 2 tours
    # d'historique injectés via append_event — pas juste "on suppose que
    # ça a marché" : on relit depuis le vrai session_service.
    session = await main.session_service.get_session(
        app_name=main.AGENTS["blog"]["app_name"], user_id=main.APP_USER_ID, session_id=new_session_id
    )
    assert session is not None
    texts = [e.content.parts[0].text for e in session.events if e.content and e.content.parts]
    assert "Écris un article sur le café" in texts
    assert "Voici un brouillon sur le café." in texts


@pytest.mark.asyncio
async def test_history_replay_ignores_client_provided_session_id(monkeypatch):
    fake = FakeRunner([text_event("ok")])
    monkeypatch.setitem(main.RUNNERS, "blog", fake)

    req = main.ChatRequest(
        message="x", session_id="ancienne-session-a-ignorer",
        history=[main.HistoryTurn(role="user", content="premier message")],
    )
    resp = await main._run_chat("blog", req, NeverDisconnectingRequest())
    assert resp.session_id != "ancienne-session-a-ignorer"


@pytest.mark.asyncio
async def test_stop_cancels_slow_runner_without_waiting(monkeypatch):
    slow = SlowFakeRunner()
    monkeypatch.setitem(main.RUNNERS, "blog", slow)

    req = main.ChatRequest(message="Rédige quelque chose de long")
    start = time.monotonic()
    with pytest.raises(Exception) as exc_info:
        await main._run_chat("blog", req, DisconnectsImmediatelyRequest())
    elapsed = time.monotonic() - start

    assert elapsed < 2.0, f"a attendu {elapsed:.1f}s — l'annulation n'a pas coupé court au Runner lent"
    assert getattr(exc_info.value, "status_code", None) == 499
    # laisse le temps à la CancelledError de se propager dans la tâche annulée
    await asyncio.sleep(0.05)
    assert slow.was_cancelled, "le Runner lent n'a pas reçu l'annulation — il continuerait en arrière-plan"
    assert not slow.completed, "le Runner lent est allé jusqu'au bout malgré la déconnexion"


@pytest.mark.asyncio
async def test_normal_request_is_not_affected_by_disconnect_watcher(monkeypatch):
    """S'assure que le mécanisme d'annulation ne casse pas le cas normal :
    un client qui reste connecté doit recevoir sa réponse normalement."""
    fake = FakeRunner([text_event("Réponse normale.")])
    monkeypatch.setitem(main.RUNNERS, "blog", fake)
    req = main.ChatRequest(message="x")
    resp = await main._run_chat("blog", req, NeverDisconnectingRequest())
    assert resp.reply == "Réponse normale."
