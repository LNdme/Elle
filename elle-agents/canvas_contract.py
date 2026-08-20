"""
canvas_contract.py — Contrat JSON structuré pour le Canevas.

En plus de sa réponse conversationnelle habituelle, un agent peut terminer
un message par UN bloc ```json contenant un document structuré :

    {"title": "...", "kick": "...", "blocks": [...], "sources": [...]}

- "blocks" reprend EXACTEMENT la forme utilisée par l'éditeur en blocs
  d'Elle et par l'outil MCP create_draft (heading/text/quote/code/
  formula/image) — voir server.js/blockHtml et app.js/blockHtml. Aucune
  traduction n'est nécessaire entre le Canevas et l'éditeur.
- "kick" correspond au champ "category" d'Elle (l'étiquette au-dessus du
  titre, ex. "Carnet", "Idées"). Peut être vide.
- "sources" est une liste de {"title","url"} — les références réellement
  consultées via web_search/web_fetch ce tour-ci. C'est un enrichissement
  PUREMENT côté Canevas : voir la note dans main.py sur pourquoi ça ne
  nécessite pas de changer le schéma de create_draft.

Ce module ne fait qu'extraire et valider ce bloc depuis le texte libre du
modèle. Il ne décide jamais, à lui seul, d'appeler create_draft — ça reste
le rôle de l'agent (via l'outil MCP), sur demande explicite de la
personne.
"""
from __future__ import annotations

import json
import re

from pydantic import BaseModel, ConfigDict, ValidationError

# DOTALL : le contenu JSON peut s'étaler sur plusieurs lignes.
# Non-greedy sur le corps + ancrage sur ``` final : s'il y a plusieurs
# blocs ```json dans le message, chacun est capturé séparément plutôt que
# du premier ``` au dernier.
_JSON_BLOCK_RE = re.compile(r"```json\s*(\{.*?\})\s*```", re.DOTALL)


class SourceRef(BaseModel):
    title: str
    url: str


class DocBlock(BaseModel):
    """Un bloc Elle. On ne valide que la présence de 'type' ; le reste des
    champs (text, level, lang, code, tex, mode, url, caption...) varie
    selon le type et passe tel quel — même tolérance que safeParse() côté
    serveur Node : mieux vaut un bloc affiché tel quel qu'une exception
    qui casse tout le Canevas pour un champ inattendu."""

    model_config = ConfigDict(extra="allow")
    type: str


class DocContract(BaseModel):
    title: str
    kick: str = ""
    blocks: list[DocBlock] = []
    sources: list[SourceRef] = []


def extract_canvas(text: str) -> tuple[str, DocContract | None]:
    """Cherche tous les blocs ```json ... ``` du texte. Renvoie
    (texte_affiché, doc) :

    - texte_affiché : le texte original SANS AUCUN bloc ```json``` — qu'il
      ait validé le contrat ou non. Le JSON brut ne doit jamais atterrir
      dans la bulle de chat, y compris un brouillon que le modèle a laissé
      avant de se corriger.
    - doc : le contenu du DERNIER bloc qui valide le contrat (title +
      blocks) — le plus à jour si le modèle en a émis plusieurs dans le
      même message. None si aucun bloc valide n'est trouvé, ce qui est le
      cas normal pour une réponse purement conversationnelle (brainstorm,
      question de clarification) : le Canevas garde alors simplement son
      dernier état côté client, il ne se vide pas.

    Un bloc JSON malformé ou qui ne correspond pas au contrat (pas de
    'title', pas de 'blocks') est silencieusement ignoré plutôt que de
    faire échouer toute la réponse : mieux vaut perdre la mise à jour du
    Canevas ce tour-ci que le message de l'agent. Il est quand même retiré
    du texte affiché : un JSON cassé n'a rien à faire dans une bulle de
    chat.
    """
    if not text:
        return text, None

    matches = list(_JSON_BLOCK_RE.finditer(text))
    if not matches:
        return text, None

    doc: DocContract | None = None
    for m in matches:
        try:
            payload = json.loads(m.group(1))
            doc = DocContract.model_validate(payload)
        except (json.JSONDecodeError, ValidationError):
            continue  # on garde le dernier valide trouvé, s'il y en a un

    display = _JSON_BLOCK_RE.sub("", text).strip()
    return display, doc


class BlockRevisionContract(BaseModel):
    """Réponse attendue pour une remarque ciblée sur UN SEUL bloc du
    Canevas (icônes ✎/💬 au survol — voir /agents/{key}/remark dans
    main.py). Même convention ```json que extract_canvas, mais forme
    différente : {"block": {...}} plutôt que {"title","blocks",...}."""

    block: DocBlock


def extract_block_revision(text: str, expected_id: str | None = None, expected_type: str | None = None) -> DocBlock | None:
    """Cherche un bloc ```json {"block": {...}} ``` dans le texte. Renvoie
    le DocBlock validé, ou None si absent/invalide/incohérent.

    Une révision qui change l'id ou le type du bloc ciblé est refusée
    (renvoie None) : mieux vaut ne pas mettre à jour l'aperçu que de le
    remplacer par un bloc qui n'a rien à voir avec celui édité — l'appelant
    (main.py) traite None comme une erreur explicite envoyée au client.
    """
    if not text:
        return None
    matches = list(_JSON_BLOCK_RE.finditer(text))
    if not matches:
        return None

    result: DocBlock | None = None
    for m in matches:
        try:
            payload = json.loads(m.group(1))
            revision = BlockRevisionContract.model_validate(payload)
        except (json.JSONDecodeError, ValidationError):
            continue
        b = revision.block
        if expected_id is not None and b.id != expected_id:  # type: ignore[attr-defined]
            continue
        if expected_type is not None and b.type != expected_type:
            continue
        result = b
    return result
