"""
Service HTTP pour les agents Elle.

Expose chaque agent sur son propre endpoint de chat, avec un contrat
volontairement simple :

    POST /agents/blog/chat
    POST /agents/notes-cours/chat
    POST /agents/creation-cours/chat
    POST /agents/projet/chat

    Requête  : {"message": "...", "session_id": "optionnel",
                "attachments": [{"kind":"image","name":"...","url":"..."} |
                                {"kind":"text","name":"...","content":"..."}],
                "history": [{"role":"user"|"assistant","content":"..."}]}
    Réponse  : {"reply": "...", "session_id": "...", "tool_calls": [...],
                "doc": {"title","kick","blocks","sources"} | null,
                "choice": {"question","options":[{"text","why"}]} | null}

attachments (voir attachments.py) : images déjà hébergées (URL réelle,
uploadée côté client via /admin/upload — même mécanisme que la couverture
d'un article dans l'éditeur classique) et fichiers texte/Markdown déjà lus
côté client. Aucun contenu binaire ne transite par ce service : une image
n'est jamais "vue" par le modèle, seulement référencée par son URL exacte,
ce qui évite de dépendre d'un support de la vision uniforme entre les 5
fournisseurs configurables. Un fichier texte joint devient un extrait de
contexte que l'agent peut citer dans "sources" avec "url":"".

session_id est à renvoyer tel quel au tour suivant pour continuer la
même conversation (ADK garde l'historique côté serveur, pas besoin de
renvoyer tous les messages précédents à chaque appel) — SAUF quand
`history` est fourni (voir juste en dessous), auquel cas session_id
fourni par le client est ignoré et une nouvelle session est créée.

history : n'est utilisé QUE pour le cas « message modifié » (édition d'un
message déjà envoyé, depuis l'Atelier). Le client renvoie alors les tours
précédant celui édité (tels qu'affichés côté client), et le serveur :
1) crée une session neuve, 2) y rejoue cet historique via
session_service.append_event() (AUCUN appel au modèle pour ces tours
passés — on réinjecte directement le texte déjà connu), 3) traite le
nouveau message (édité) normalement dans cette session fraîche. Le
session_id de la réponse remplace alors celui que le client utilisait.
Limite assumée : les pièces jointes de tours antérieurs à celui édité ne
sont pas rejouées avec leur préambule complet, seul le texte affiché
côté client l'est — cas rare (éditer un message qui suit un tour avec
pièce jointe), acceptable en l'état.

doc alimente le Canevas : c'est un aperçu structuré (mêmes blocs que
l'éditeur d'Elle) extrait du texte de la réponse par canvas_contract.py.
Il vaut null pour un tour purement conversationnel — le Canevas garde
alors simplement son dernier état côté client. doc N'EST JAMAIS ce qui
est persisté : la sauvegarde reste le rôle de l'outil MCP create_draft,
appelé par l'agent lui-même sur demande explicite de la personne (voir
CHANGES.md, section "Canevas vs create_draft").

choice alimente un quiz de cadrage optionnel (pour l'instant utilisé par
agent_projet, étape Cadrage) : une question fermée à 2-4 options, extraite
par choice_contract.py. Il vaut null la plupart du temps. Ce n'est jamais
un QCM strict côté modèle — la personne peut toujours répondre en texte
libre au tour suivant plutôt que de choisir une option ; côté Atelier, les
options disparaissent une fois qu'une réponse (cliquée ou libre) est
envoyée. Voir CHANGES.md pour la discussion sur une éventuelle
généralisation aux autres agents.

Arrêt d'un message en cours : si la personne annule côté client (bouton
Stop → AbortController.abort()), la connexion HTTP se ferme. FastAPI le
détecte via request.is_disconnected() ; la génération en cours côté
modèle est alors annulée pour de vrai (asyncio.Task.cancel()), pas
seulement ignorée côté client — un message arrêté ne finira donc pas par
appeler create_draft en arrière-plan après coup.

Lancement :
    uvicorn main:app --host 0.0.0.0 --port 8001
"""
import asyncio  # noqa: E402
import json
import os
import uuid
from contextlib import asynccontextmanager

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, HTTPException, Request  # noqa: E402
from pydantic import BaseModel  # noqa: E402
from google.adk.events.event import Event  # noqa: E402
from google.adk.runners import Runner  # noqa: E402
from google.adk.sessions import InMemorySessionService  # noqa: E402
from google.genai import types  # noqa: E402

from agent_blog.agent import root_agent as blog_agent  # noqa: E402
from agent_notes_cours.agent import root_agent as notes_cours_agent  # noqa: E402
from agent_creation_cours.agent import root_agent as creation_cours_agent  # noqa: E402
from agent_projet.agent import root_agent as projet_agent  # noqa: E402
from canvas_contract import extract_canvas, extract_block_revision  # noqa: E402
from choice_contract import extract_choice  # noqa: E402
from attachments import Attachment, build_attachment_preamble  # noqa: E402

APP_USER_ID = "libert"  # instance mono-utilisateur : un seul user_id fixe suffit

session_service = InMemorySessionService()

AGENTS = {
    "blog": {"agent": blog_agent, "app_name": "elle_agent_blog"},
    "notes-cours": {"agent": notes_cours_agent, "app_name": "elle_agent_notes_cours"},
    "creation-cours": {"agent": creation_cours_agent, "app_name": "elle_agent_creation_cours"},
    "projet": {"agent": projet_agent, "app_name": "elle_agent_projet"},
}
RUNNERS = {
    key: Runner(agent=cfg["agent"], app_name=cfg["app_name"], session_service=session_service)
    for key, cfg in AGENTS.items()
}


class HistoryTurn(BaseModel):
    role: str  # "user" | "assistant"
    content: str


class ChatRequest(BaseModel):
    message: str = ""
    session_id: str | None = None
    # Images déjà hébergées (URL réelle, uploadée côté client via
    # /admin/upload) et fichiers texte/Markdown déjà lus côté client — voir
    # attachments.py pour le détail et pourquoi aucun contenu binaire ne
    # transite par ici.
    attachments: list[Attachment] = []
    # Fourni uniquement pour un message modifié : les tours précédant celui
    # édité, à rejouer dans une session neuve (voir docstring du module).
    # Ignore session_id si présent.
    history: list[HistoryTurn] = []


class ChatResponse(BaseModel):
    reply: str
    session_id: str
    tool_calls: list[dict] = []
    # Aperçu structuré pour le Canevas (title/kick/blocks/sources), extrait
    # du texte de la réponse. None quand ce tour n'en contenait pas — le
    # Canevas garde alors son dernier état côté client, il ne se vide pas.
    doc: dict | None = None
    # Question de cadrage à choix (question/options[text,why]), extraite du
    # texte de la réponse. None la plupart du temps — pas un QCM strict :
    # la personne peut toujours répondre librement plutôt que de choisir
    # une option (voir choice_contract.py).
    choice: dict | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    provider = os.environ.get("ELLE_MODEL_PROVIDER", "ollama")
    print(f"[elle-agents] agents chargés : {', '.join(AGENTS.keys())}")
    print(f"[elle-agents] fournisseur de modèle : {provider}")
    yield


app = FastAPI(title="Elle — service agents", lifespan=lifespan)


@app.get("/health")
async def health():
    return {"ok": True, "agents": list(AGENTS.keys())}


async def _replay_history(app_name: str, session_id: str, agent_key: str, history: list[HistoryTurn]) -> None:
    """Rejoue un historique déjà connu dans une session neuve, SANS appeler
    le modèle : injecte directement les tours passés via append_event()
    (API publique d'ADK — voir docstring du module pour la limite assumée
    sur les pièces jointes de tours antérieurs)."""
    session = await session_service.create_session(app_name=app_name, user_id=APP_USER_ID, session_id=session_id)
    for turn in history:
        role = "user" if turn.role == "user" else "model"
        author = "user" if role == "user" else agent_key
        event = Event(author=author, content=types.Content(role=role, parts=[types.Part(text=turn.content)]))
        await session_service.append_event(session, event)


async def _watch_disconnect(request: Request, interval: float = 0.4) -> None:
    """Boucle jusqu'à détecter une déconnexion client réelle (bouton Stop
    → AbortController côté navigateur). N'est jamais "gagnant" tant que le
    client reste connecté."""
    while True:
        if await request.is_disconnected():
            return
        await asyncio.sleep(interval)


async def _consume_run(runner, session_id: str, content: types.Content) -> tuple[str, list[dict]]:
    reply_text = ""
    tool_calls: list[dict] = []
    async for event in runner.run_async(user_id=APP_USER_ID, session_id=session_id, new_message=content):
        try:
            if event.content and event.content.parts:
                for part in event.content.parts:
                    fr = getattr(part, "function_response", None)
                    if fr is not None and getattr(fr, "name", None) == "create_draft":
                        tool_calls.append({"name": fr.name, "result": fr.response})
        except Exception:
            pass
        if event.is_final_response() and event.content and event.content.parts:
            reply_text = "".join(p.text for p in event.content.parts if getattr(p, "text", None))
    return reply_text, tool_calls


async def _run_chat(agent_key: str, req: ChatRequest, request: Request) -> ChatResponse:
    if agent_key not in AGENTS:
        raise HTTPException(status_code=404, detail=f"Agent inconnu : {agent_key}")
    if not (req.message and req.message.strip()) and not req.attachments:
        raise HTTPException(status_code=400, detail="Le champ 'message' est requis (ou au moins une pièce jointe).")

    app_name = AGENTS[agent_key]["app_name"]

    if req.history:
        # Message modifié : session_id fourni par le client (s'il y en a
        # un) est délibérément ignoré, on repart d'une session neuve.
        session_id = str(uuid.uuid4())
        await _replay_history(app_name, session_id, agent_key, req.history)
    else:
        session_id = req.session_id or str(uuid.uuid4())
        existing = await session_service.get_session(app_name=app_name, user_id=APP_USER_ID, session_id=session_id)
        if existing is None:
            await session_service.create_session(app_name=app_name, user_id=APP_USER_ID, session_id=session_id)

    runner = RUNNERS[agent_key]
    preamble = build_attachment_preamble(req.attachments)
    message_text = (req.message or "").strip() or "Utilise le(s) fichier(s) joint(s)."
    content = types.Content(role="user", parts=[types.Part(text=preamble + message_text)])

    consume_task = asyncio.ensure_future(_consume_run(runner, session_id, content))
    watch_task = asyncio.ensure_future(_watch_disconnect(request))
    try:
        done, _pending = await asyncio.wait({consume_task, watch_task}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        pass

    if consume_task in done:
        watch_task.cancel()
        try:
            reply_text, tool_calls = consume_task.result()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Erreur modèle : {e}")
    else:
        # Le client s'est déconnecté (Stop) avant la fin : on annule pour de
        # vrai la génération en cours, elle ne continuera pas en tâche de
        # fond ni ne pourra appeler create_draft après coup.
        consume_task.cancel()
        try:
            await consume_task
        except (asyncio.CancelledError, Exception):
            pass
        raise HTTPException(status_code=499, detail="Message interrompu par la personne.")

    # Le bloc ```json (s'il existe) alimente le Canevas ; il est retiré du
    # texte affiché dans la bulle de chat, qui reste purement conversationnel.
    display_text, doc = extract_canvas(reply_text)
    # Le bloc ```choice (s'il existe) alimente un quiz de cadrage optionnel ;
    # même traitement, sur le texte déjà débarrassé du bloc du Canevas.
    display_text, choice = extract_choice(display_text)

    return ChatResponse(
        reply=display_text or "(réponse vide)",
        session_id=session_id,
        tool_calls=tool_calls,
        doc=doc.model_dump() if doc else None,
        choice=choice.model_dump() if choice else None,
    )


@app.post("/agents/blog/chat", response_model=ChatResponse)
async def chat_blog(req: ChatRequest, request: Request):
    return await _run_chat("blog", req, request)


@app.post("/agents/notes-cours/chat", response_model=ChatResponse)
async def chat_notes_cours(req: ChatRequest, request: Request):
    return await _run_chat("notes-cours", req, request)


@app.post("/agents/creation-cours/chat", response_model=ChatResponse)
async def chat_creation_cours(req: ChatRequest, request: Request):
    return await _run_chat("creation-cours", req, request)


@app.post("/agents/projet/chat", response_model=ChatResponse)
async def chat_projet(req: ChatRequest, request: Request):
    return await _run_chat("projet", req, request)


class RemarkRequest(BaseModel):
    # Le bloc tel qu'affiché côté client au moment de la remarque — id et
    # type sont requis (voir validation dans _run_remark), le reste des
    # champs passe tel quel et sert de contexte à l'agent.
    target_block: dict
    remark: str
    session_id: str | None = None


class RemarkResponse(BaseModel):
    block: dict
    session_id: str


async def _run_remark(agent_key: str, req: RemarkRequest, request: Request) -> RemarkResponse:
    """Remarque ciblée sur UN SEUL bloc du Canevas (icônes ✎/💬 au survol
    d'un passage, côté Atelier). Contrairement à /chat, la réponse attendue
    n'est PAS le contrat {title,kick,blocks,sources} mais {"block": {...}}
    — voir canvas_contract.extract_block_revision. Réutilise la même
    session que la conversation en cours (le contexte du brouillon reste
    utile pour une révision cohérente), et le même mécanisme d'annulation
    que _run_chat."""
    if agent_key not in AGENTS:
        raise HTTPException(status_code=404, detail=f"Agent inconnu : {agent_key}")
    target = req.target_block or {}
    if not target.get("id") or not target.get("type"):
        raise HTTPException(status_code=400, detail="target_block invalide : 'id' et 'type' sont requis.")
    if not req.remark or not req.remark.strip():
        raise HTTPException(status_code=400, detail="Le champ 'remark' est requis.")

    app_name = AGENTS[agent_key]["app_name"]
    session_id = req.session_id or str(uuid.uuid4())
    existing = await session_service.get_session(app_name=app_name, user_id=APP_USER_ID, session_id=session_id)
    if existing is None:
        await session_service.create_session(app_name=app_name, user_id=APP_USER_ID, session_id=session_id)

    runner = RUNNERS[agent_key]
    user_text = (
        "[Remarque ciblée sur un passage précis du Canevas — pas tout le document]\n"
        f"Bloc actuel : {json.dumps(target, ensure_ascii=False)}\n\n"
        f"Remarque : {req.remark.strip()}\n\n"
        "Réponds UNIQUEMENT avec un bloc ```json contenant la révision de CE bloc, sous cette forme exacte :\n"
        '```json\n{"block": {"id": "<même id>", "type": "<même type>", ...champs mis à jour}}\n```\n'
        "Garde impérativement le même id et le même type que le bloc fourni. "
        "N'ajoute rien d'autre avant ou après ce bloc — pas de phrase d'introduction."
    )
    content = types.Content(role="user", parts=[types.Part(text=user_text)])

    consume_task = asyncio.ensure_future(_consume_run(runner, session_id, content))
    watch_task = asyncio.ensure_future(_watch_disconnect(request))
    done, _pending = await asyncio.wait({consume_task, watch_task}, return_when=asyncio.FIRST_COMPLETED)

    if consume_task in done:
        watch_task.cancel()
        try:
            reply_text, _tool_calls = consume_task.result()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Erreur modèle : {e}")
    else:
        consume_task.cancel()
        try:
            await consume_task
        except (asyncio.CancelledError, Exception):
            pass
        raise HTTPException(status_code=499, detail="Remarque annulée par la personne.")

    block = extract_block_revision(reply_text, expected_id=target["id"], expected_type=target["type"])
    if block is None:
        raise HTTPException(
            status_code=502,
            detail="L'agent n'a pas renvoyé de révision valide pour ce bloc (id/type incohérents ou format inattendu).",
        )
    return RemarkResponse(block=block.model_dump(), session_id=session_id)


@app.post("/agents/blog/remark", response_model=RemarkResponse)
async def remark_blog(req: RemarkRequest, request: Request):
    return await _run_remark("blog", req, request)


@app.post("/agents/notes-cours/remark", response_model=RemarkResponse)
async def remark_notes_cours(req: RemarkRequest, request: Request):
    return await _run_remark("notes-cours", req, request)


@app.post("/agents/creation-cours/remark", response_model=RemarkResponse)
async def remark_creation_cours(req: RemarkRequest, request: Request):
    return await _run_remark("creation-cours", req, request)


@app.post("/agents/projet/remark", response_model=RemarkResponse)
async def remark_projet(req: RemarkRequest, request: Request):
    return await _run_remark("projet", req, request)
