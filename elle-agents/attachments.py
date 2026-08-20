"""
attachments.py — Pièces jointes du chat Canevas : images à illustrer un
contenu, fichiers texte/Markdown pour enrichir la bibliographie.

Choix volontaire : AUCUN contenu binaire n'est envoyé au modèle.

- Une image jointe est déjà hébergée côté client AVANT l'appel ici (upload
  via /admin/upload, exactement comme la couverture d'un article dans
  l'éditeur classique — voir app.js, fonction uploadFile()). Ce module ne
  reçoit que son URL déjà réelle, jamais les octets de l'image.
- Un fichier texte/Markdown est déjà lu côté client (FileReader) et arrive
  ici comme texte brut.

Pourquoi pas de vision : les 5 fournisseurs configurables (Ollama local,
Anthropic, Gemini, Groq, DeepSeek) n'ont pas tous un support fiable et
uniforme des images en entrée via LiteLLM/ADK, et le besoin réel (illustrer
un article, citer un fichier) ne nécessite pas que le modèle "voie" l'image
— seulement qu'il connaisse son URL exacte pour la référencer dans un bloc
"image" du Canevas (voir canvas_contract.py).
"""

from __future__ import annotations

from pydantic import BaseModel


class Attachment(BaseModel):
    kind: str  # "image" | "text"
    name: str
    url: str | None = None       # kind="image" : URL déjà hébergée (/uploads/...)
    content: str | None = None    # kind="text" : contenu déjà lu côté client


def build_attachment_preamble(attachments: list[Attachment]) -> str:
    """Construit un texte à préfixer au message de la personne, décrivant
    les pièces jointes de façon actionnable pour l'agent. Chaîne vide s'il
    n'y a rien d'utilisable (pas d'attachments, ou champs requis manquants
    pour leur type — un attachment mal formé est simplement ignoré plutôt
    que de faire échouer tout le message)."""
    lines: list[str] = []
    for a in attachments or []:
        if a.kind == "image" and a.url:
            lines.append(
                f'- Image jointe "{a.name}", déjà hébergée à l\'URL exacte : {a.url} '
                f'— utilise cette URL telle quelle si tu l\'insères comme illustration '
                f'(bloc "image"), n\'en invente jamais une autre.'
            )
        elif a.kind == "text" and a.content is not None and a.content.strip():
            lines.append(
                f'- Fichier joint "{a.name}" (matière pour le contenu ; si tu t\'en '
                f'sers, cite-le dans "sources" avec "url":"") :\n---\n{a.content.strip()}\n---'
            )
    if not lines:
        return ""
    return "Pièces jointes fournies pour ce message :\n" + "\n".join(lines) + "\n\n"
