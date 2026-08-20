import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "elle-agents"))
import canvas_contract as cc  # noqa: E402


def _wrap(payload_json: str) -> str:
    return "Voici un aperçu :\n```json\n" + payload_json + "\n```\nDites-moi si ça vous convient."


def test_extract_canvas_happy_path_strips_json_and_parses_doc():
    payload = '{"title": "Minimalisme numérique", "kick": "Carnet", "blocks": [{"type": "heading", "level": 2, "text": "Intro"}], "sources": []}'
    text = _wrap(payload)

    display, doc = cc.extract_canvas(text)

    assert "```json" not in display
    assert "Voici un aperçu" in display
    assert "Dites-moi si ça vous convient." in display
    assert doc is not None
    assert doc.title == "Minimalisme numérique"
    assert doc.kick == "Carnet"
    assert len(doc.blocks) == 1
    assert doc.blocks[0].type == "heading"


def test_extract_canvas_no_json_block_returns_none_and_original_text():
    text = "3 idées de titres : le minimalisme, le slow tech, la déconnexion."
    display, doc = cc.extract_canvas(text)
    assert display == text
    assert doc is None


def test_extract_canvas_empty_text():
    display, doc = cc.extract_canvas("")
    assert display == ""
    assert doc is None


def test_extract_canvas_malformed_json_is_ignored_not_raised():
    text = _wrap('{"title": "Cassé", "blocks": [}')  # JSON invalide
    display, doc = cc.extract_canvas(text)
    assert doc is None  # aucune mise à jour du Canevas ce tour-ci — pas de crash
    # Le bloc cassé est quand même retiré : un JSON brut n'a rien à faire
    # dans une bulle de chat, même invalide.
    assert "```json" not in display
    assert "Voici un aperçu" in display
    assert "Dites-moi si ça vous convient." in display


def test_extract_canvas_missing_required_field_is_ignored():
    # Pas de "title" : ne correspond pas au contrat, doit être ignoré plutôt
    # que planter toute la réponse pour un champ manquant.
    payload = '{"kick": "Carnet", "blocks": []}'
    display, doc = cc.extract_canvas(_wrap(payload))
    assert doc is None


def test_extract_canvas_unknown_block_fields_pass_through():
    """Même tolérance que safeParse() côté Node : un bloc avec des champs
    qu'on ne connaît pas encore ne doit pas faire échouer le parsing."""
    payload = '{"title": "T", "blocks": [{"type": "formula", "mode": "inline", "tex": "E=mc^2"}]}'
    display, doc = cc.extract_canvas(_wrap(payload))
    assert doc is not None
    assert doc.blocks[0].model_dump()["tex"] == "E=mc^2"


def test_extract_canvas_parses_sources():
    payload = (
        '{"title": "T", "blocks": [], "sources": '
        '[{"title": "Article X", "url": "https://example.com/x"}]}'
    )
    display, doc = cc.extract_canvas(_wrap(payload))
    assert doc is not None
    assert len(doc.sources) == 1
    assert doc.sources[0].url == "https://example.com/x"


def test_extract_canvas_uses_last_json_block_when_several_present():
    """Si le modèle a maladroitement laissé un premier brouillon de JSON
    avant de se corriger, on prend le DERNIER bloc — le plus à jour."""
    text = (
        "Premier essai :\n```json\n"
        '{"title": "Ancien", "blocks": []}'
        "\n```\nEn fait, corrigeons ça :\n```json\n"
        '{"title": "Nouveau", "blocks": []}'
        "\n```"
    )
    display, doc = cc.extract_canvas(text)
    assert doc is not None
    assert doc.title == "Nouveau"
    assert "```json" not in display


def test_doc_contract_model_dump_matches_elle_block_shape():
    """Vérifie que la sérialisation renvoyée à main.py (model_dump) a bien
    la forme attendue par le Canevas côté client : mêmes clés que les blocs
    de server.js/app.js (type, level, text, lang, code, tex, mode, url,
    caption), pas de renommage introduit par pydantic."""
    payload = (
        '{"title": "T", "kick": "K", "blocks": ['
        '{"type": "code", "lang": "python", "code": "print(1)"}'
        '], "sources": []}'
    )
    _, doc = cc.extract_canvas(_wrap(payload))
    dumped = doc.model_dump()
    assert dumped["blocks"][0] == {"type": "code", "lang": "python", "code": "print(1)"}


def test_extract_block_revision_happy_path():
    text = (
        "C'est fait, j'ai ajouté un exemple.\n```json\n"
        '{"block": {"id": "b3", "type": "text", "text": "Texte révisé avec un exemple concret."}}'
        "\n```"
    )
    block = cc.extract_block_revision(text, expected_id="b3", expected_type="text")
    assert block is not None
    assert block.text == "Texte révisé avec un exemple concret."


def test_extract_block_revision_no_json_returns_none():
    assert cc.extract_block_revision("Une réponse purement conversationnelle.") is None


def test_extract_block_revision_rejects_wrong_id():
    text = '```json\n{"block": {"id": "AUTRE", "type": "text", "text": "x"}}\n```'
    assert cc.extract_block_revision(text, expected_id="b3", expected_type="text") is None


def test_extract_block_revision_rejects_wrong_type():
    text = '```json\n{"block": {"id": "b3", "type": "heading", "level": 2, "text": "x"}}\n```'
    assert cc.extract_block_revision(text, expected_id="b3", expected_type="text") is None


def test_extract_block_revision_malformed_json_returns_none():
    text = '```json\n{"block": {"id": "b3", "type": "text"\n```'  # JSON tronqué
    assert cc.extract_block_revision(text, expected_id="b3", expected_type="text") is None


def test_extract_block_revision_missing_type_returns_none():
    text = '```json\n{"block": {"id": "b3", "text": "x"}}\n```'  # pas de "type"
    assert cc.extract_block_revision(text, expected_id="b3") is None


def test_extract_block_revision_preserves_extra_fields_like_ul_items():
    text = '```json\n{"block": {"id": "b4", "type": "text", "text": "a\\nb\\nc"}}\n```'
    block = cc.extract_block_revision(text, expected_id="b4", expected_type="text")
    assert block.model_dump()["text"] == "a\nb\nc"


def test_extract_block_revision_uses_last_valid_json_block():
    text = (
        '```json\n{"block": {"id": "b3", "type": "text", "text": "brouillon"}}\n```\n'
        'en fait :\n```json\n{"block": {"id": "b3", "type": "text", "text": "final"}}\n```'
    )
    block = cc.extract_block_revision(text, expected_id="b3", expected_type="text")
    assert block.text == "final"
