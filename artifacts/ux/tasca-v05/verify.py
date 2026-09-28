"""Check that the typography study preserves C5 content and visual surfaces."""
import json
from pathlib import Path

ROOT = Path(__file__).parent
NODES = {
    node["id"]: node
    for node in json.loads((ROOT / "tasca-concept-v05.pen").read_text())["children"]
}
FONTS = ("Inter", "Onest", "Manrope")
WIDE = ("AzCfH", "eIuyC", "uGdN2")
NARROW = ("vbGPH", "cRdcU", "avFkF")


def walk(node):
    yield node
    for child in node.get("children", []):
        yield from walk(child)


def without_typography(node, root=False):
    ignored = {"id", "children"}
    if root:
        ignored |= {"x", "y", "name", "placeholder"}
    if node.get("type") == "text":
        ignored |= {"fontFamily", "fontSize", "fontWeight", "letterSpacing", "lineHeight"}
    return (
        {key: value for key, value in node.items() if key not in ignored},
        [without_typography(child) for child in node.get("children", [])],
    )


if __name__ == "__main__":
    original = NODES["DdOtC"]
    expected_text = sorted(n["content"] for n in walk(original) if n.get("type") == "text")
    for node_id in WIDE:
        assert without_typography(NODES[node_id], True) == without_typography(original, True), node_id
    for node_id, font in zip(WIDE + NARROW, FONTS * 2):
        texts = [n for n in walk(NODES[node_id]) if n.get("type") == "text"]
        assert sorted(n["content"] for n in texts) == expected_text, node_id
        assert all(
            n["fontFamily"] == ("Inter" if n["name"] == "Имя приложения" else font)
            for n in texts
        ), node_id
        assert (ROOT / "exports" / f"{node_id}.png").is_file(), node_id
    print("PASS: 3 typography-only variants; all 6 screens preserve content and font assignments.")
