import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "elle-agents"))
from attachments import Attachment, build_attachment_preamble  # noqa: E402


def test_empty_attachments_gives_empty_preamble():
    assert build_attachment_preamble([]) == ""


def test_image_attachment_mentions_exact_url():
    preamble = build_attachment_preamble([Attachment(kind="image", name="photo.jpg", url="/uploads/abc123.jpg")])
    assert "/uploads/abc123.jpg" in preamble
    assert "photo.jpg" in preamble
    assert "image" in preamble  # mentionne bien le type de bloc à utiliser


def test_image_attachment_without_url_is_ignored():
    # Pas d'URL = pas encore uploadée : on ignore plutôt que de laisser
    # l'agent halluciner une URL.
    preamble = build_attachment_preamble([Attachment(kind="image", name="photo.jpg", url=None)])
    assert preamble == ""


def test_text_attachment_includes_full_content():
    preamble = build_attachment_preamble([Attachment(kind="text", name="notes.md", content="# Idée\nContenu utile.")])
    assert "notes.md" in preamble
    assert "# Idée" in preamble
    assert "Contenu utile." in preamble
    assert 'url":""' in preamble  # rappel explicite du format source sans URL


def test_text_attachment_empty_content_is_ignored():
    preamble = build_attachment_preamble([Attachment(kind="text", name="vide.md", content="   ")])
    assert preamble == ""


def test_unknown_kind_is_ignored_not_fatal():
    preamble = build_attachment_preamble([Attachment(kind="video", name="clip.mp4")])
    assert preamble == ""


def test_mixed_attachments_all_included():
    atts = [
        Attachment(kind="image", name="cover.jpg", url="/uploads/cover.jpg"),
        Attachment(kind="text", name="brief.md", content="Points clés du brief."),
    ]
    preamble = build_attachment_preamble(atts)
    assert "/uploads/cover.jpg" in preamble
    assert "Points clés du brief." in preamble
    # une seule pièce jointe par ligne, dans l'ordre fourni
    assert preamble.index("cover.jpg") < preamble.index("brief.md")


def test_preamble_ends_with_blank_line_before_message():
    preamble = build_attachment_preamble([Attachment(kind="text", name="x.md", content="y")])
    assert preamble.endswith("\n\n")
