"""
choice_contract.py — Contrat JSON structuré pour les questions à choix.

Pensé pour l'étape de Cadrage d'agent_projet (mais volontairement
agent-agnostique — voir CHANGES.md pour la discussion sur une éventuelle
généralisation aux autres agents), ce module gère un DEUXIÈME type de bloc
structuré, distinct du ```json``` du Canevas :

    ```choice
    {"question": "...", "options": [{"text": "...", "why": "..."}]}
    ```

- "question" : la question posée à la personne.
- "options" : 2 à 4 réponses plausibles, chacune avec un "text" (le libellé
  du bouton) et un "why" (l'explication affichée avec le bouton — pourquoi
  ce choix, ce qu'il implique). Le "why" aide à choisir sans deviner, sans
  pour autant obliger à lire un paragraphe avant de répondre.

Ce n'est PAS un QCM fermé : la personne peut toujours répondre en texte
libre plutôt qu'en cliquant une option (voir instruction de l'agent). Côté
Atelier, les boutons disparaissent une fois une réponse envoyée (donnée ou
cliquée) — remplacés par la réponse retenue, comme le reste de la
conversation. Ce module ne fait qu'extraire/valider le bloc ; il ne décide
jamais du rendu, qui reste un composant front-end (non couvert par ce dépôt,
voir CHANGES.md).

Bloc distinct du ```json``` du Canevas (balise ```choice``` propre) : les
deux peuvent coexister dans un même message sans ambiguïté de parsing — par
exemple le Canevas montrant le cadrage accumulé jusqu'ici, pendant que le
bloc ```choice``` pose la question suivante.
"""
from __future__ import annotations

import json
import re

from pydantic import BaseModel, Field, ValidationError

# DOTALL pour les mêmes raisons que canvas_contract.py : le JSON peut
# s'étaler sur plusieurs lignes. Non-greedy + ancrage sur ``` final pour
# capturer chaque bloc séparément s'il y en a plusieurs dans un message.
_CHOICE_BLOCK_RE = re.compile(r"```choice\s*(\{.*?\})\s*```", re.DOTALL)


class ChoiceOption(BaseModel):
    text: str
    why: str = ""


class ChoiceQuestion(BaseModel):
    question: str
    # 2 à 4 options : moins n'est pas vraiment un choix, plus redevient une
    # liste à lire plutôt qu'un quiz rapide à trancher.
    options: list[ChoiceOption] = Field(min_length=2, max_length=4)


def extract_choice(text: str) -> tuple[str, ChoiceQuestion | None]:
    """Cherche tous les blocs ```choice ... ``` du texte. Renvoie
    (texte_affiché, choice) avec exactement la même philosophie de
    tolérance que extract_canvas() dans canvas_contract.py :

    - texte_affiché : le texte original sans AUCUN bloc ```choice```, qu'il
      soit valide ou non — un JSON brut n'a rien à faire dans une bulle de
      chat, même mal formé.
    - choice : le contenu du DERNIER bloc qui valide le contrat (question +
      2 à 4 options), ou None si aucun bloc valide n'est trouvé — cas
      normal pour un tour qui ne pose pas de question fermée.

    À appeler APRÈS extract_canvas() sur le texte déjà débarrassé du bloc
    ```json``` du Canevas (voir main.py) : les deux balises étant
    différentes, l'ordre n'a pas d'incidence sur le parsing lui-même, mais
    ça garde un seul point d'entrée séquentiel dans main.py.
    """
    if not text:
        return text, None

    matches = list(_CHOICE_BLOCK_RE.finditer(text))
    if not matches:
        return text, None

    choice: ChoiceQuestion | None = None
    for m in matches:
        try:
            payload = json.loads(m.group(1))
            choice = ChoiceQuestion.model_validate(payload)
        except (json.JSONDecodeError, ValidationError):
            continue  # on garde le dernier bloc valide trouvé, s'il y en a un

    display = _CHOICE_BLOCK_RE.sub("", text).strip()
    return display, choice
