import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "elle-agents"))
import choice_contract as cc  # noqa: E402


def _wrap(payload_json: str) -> str:
    return "Une précision avant de continuer :\n```choice\n" + payload_json + "\n```\nOu réponds librement si aucune option ne te convient."


def test_extract_choice_happy_path_strips_block_and_parses_question():
    payload = (
        '{"question": "Qui souffre le plus de ce problème ?", "options": '
        '[{"text": "Les indépendants", "why": "Pas d\'équipe pour absorber la charge"}, '
        '{"text": "Les PME", "why": "Budget limité mais besoin réel"}]}'
    )
    text = _wrap(payload)

    display, choice = cc.extract_choice(text)

    assert "```choice" not in display
    assert "Une précision avant de continuer" in display
    assert "Ou réponds librement" in display
    assert choice is not None
    assert choice.question == "Qui souffre le plus de ce problème ?"
    assert len(choice.options) == 2
    assert choice.options[0].text == "Les indépendants"
    assert "équipe" in choice.options[0].why


def test_extract_choice_no_block_returns_none_and_original_text():
    text = "Peux-tu m'en dire plus sur le contexte ?"
    display, choice = cc.extract_choice(text)
    assert display == text
    assert choice is None


def test_extract_choice_empty_text():
    display, choice = cc.extract_choice("")
    assert display == ""
    assert choice is None


def test_extract_choice_malformed_json_is_ignored_not_raised():
    text = _wrap('{"question": "Cassé", "options": [}')  # JSON invalide
    display, choice = cc.extract_choice(text)
    assert choice is None  # pas de quiz ce tour-ci — pas de crash
    assert "```choice" not in display
    assert "Une précision avant de continuer" in display


def test_extract_choice_requires_at_least_two_options():
    # Une seule option : ne correspond pas au contrat (2 à 4 attendues),
    # doit être ignoré plutôt que d'afficher un "choix" à une seule branche.
    payload = '{"question": "Q ?", "options": [{"text": "Seule option"}]}'
    display, choice = cc.extract_choice(_wrap(payload))
    assert choice is None
    assert "```choice" not in display


def test_extract_choice_rejects_more_than_four_options():
    options = ", ".join(f'{{"text": "Option {i}"}}' for i in range(5))
    payload = f'{{"question": "Q ?", "options": [{options}]}}'
    display, choice = cc.extract_choice(_wrap(payload))
    assert choice is None


def test_extract_choice_why_defaults_to_empty_string():
    payload = '{"question": "Q ?", "options": [{"text": "A"}, {"text": "B"}]}'
    _, choice = cc.extract_choice(_wrap(payload))
    assert choice is not None
    assert choice.options[0].why == ""


def test_extract_choice_missing_question_is_ignored():
    payload = '{"options": [{"text": "A"}, {"text": "B"}]}'
    display, choice = cc.extract_choice(_wrap(payload))
    assert choice is None


def test_extract_choice_uses_last_block_when_several_present():
    text = (
        "Premier essai :\n```choice\n"
        '{"question": "Ancienne question ?", "options": [{"text": "A"}, {"text": "B"}]}'
        "\n```\nEn fait :\n```choice\n"
        '{"question": "Nouvelle question ?", "options": [{"text": "C"}, {"text": "D"}]}'
        "\n```"
    )
    display, choice = cc.extract_choice(text)
    assert choice is not None
    assert choice.question == "Nouvelle question ?"
    assert "```choice" not in display


def test_choice_and_canvas_blocks_coexist_in_same_message():
    """Les deux balises étant distinctes (```json vs ```choice), elles
    doivent pouvoir être extraites indépendamment du même message, dans
    l'ordre utilisé par main.py (canvas d'abord, puis choice)."""
    import canvas_contract as cv

    text = (
        "Voici où on en est :\n```json\n"
        '{"title": "Projet X", "kick": "Cadrage", "blocks": []}'
        "\n```\nEt une question pour avancer :\n```choice\n"
        '{"question": "Q ?", "options": [{"text": "A"}, {"text": "B"}]}'
        "\n```"
    )
    display_after_canvas, doc = cv.extract_canvas(text)
    display_final, choice = cc.extract_choice(display_after_canvas)

    assert doc is not None
    assert doc.title == "Projet X"
    assert choice is not None
    assert choice.question == "Q ?"
    assert "```json" not in display_final
    assert "```choice" not in display_final
    assert "Voici où on en est" in display_final
    assert "Et une question pour avancer" in display_final
