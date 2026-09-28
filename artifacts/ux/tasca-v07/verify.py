"""Check local design artifacts; does not test runtime UX or owner acceptance."""
import hashlib
import json
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).parent
manifest = json.loads((ROOT / "manifest.json").read_text())
document = json.loads((ROOT / manifest["source"]).read_text())
roots = {node["id"]: node for node in document["children"]}
expected = set(manifest["brand_nodes"].values()) | set(manifest["accepted_app_nodes"])
assert set(roots) == expected and len(roots) == 10
previous = json.loads((ROOT.parent / "tasca-v06/tasca-concept-v06.pen").read_text())
previous_roots = {node["id"]: node for node in previous["children"]}
for node_id in manifest["accepted_app_nodes"]:
    assert roots[node_id] == previous_roots[node_id], f"Accepted UI changed: {node_id}"
print("PASS: 10 roots; 5 accepted app screens unchanged")


def walk(node):
    yield node
    for child in node.get("children", []):
        yield from walk(child)


images = []
for node_id in manifest["brand_nodes"].values():
    for node in walk(roots[node_id]):
        assert not node.get("placeholder")
        if node["type"] == "text":
            assert node["fontFamily"] in ("Manrope", "Golos Text")
        fill = node.get("fill")
        if isinstance(fill, dict) and fill.get("type") == "image":
            assert fill["url"] == "assets/app-preview.png"
            assert (ROOT / fill["url"]).is_file()
            images.append(fill["url"])
        if node["type"] == "frame" and node.get("name") == "Открыть в Telegram":
            assert node["height"] >= 44
assert len(images) == 3
assert (ROOT / images[0]).read_bytes() == (ROOT.parent / "tasca-v06/exports/uGdN2.png").read_bytes()
for node_id, size in {"iYcGz": (512, 512), "M00YXB": (1672, 941), "Q8IKSO": (1440, 1000), "xkj3i": (390, 1174), "sWXAC": (320, 1030)}.items():
    assert Image.open(ROOT / "exports" / f"{node_id}.png").size == size
for width, node_id in ((390, "xkj3i"), (320, "sWXAC")):
    crop = Image.open(ROOT / "exports" / f"landing-firstfold-{width}.png").convert("RGBA")
    full = Image.open(ROOT / "exports" / f"{node_id}.png").convert("RGBA")
    assert crop.size == (width, 844) and crop.tobytes() == full.crop((0, 0, width, 844)).tobytes()
a = Image.open(ROOT / "exports/Q8IKSO.png").convert("RGBA")
b = Image.open(ROOT / "exports/portable-check/Q8IKSO.png").convert("RGBA")
assert a.size == b.size and a.tobytes() == b.tobytes(), "Portable Pen render differs"
print("PASS: export dimensions, mobile first-fold crops, relative image paths; portable render identical")

namespace = {"s": "http://www.w3.org/2000/svg"}
variants = {"green": (24, 60, 44), "black": (0, 0, 0), "white": (255, 255, 255)}
for slug, word in (("tasca-ru", "Таска"), ("tasca-latin", "Tasca")):
    paths, masks = [], []
    for variant, color in variants.items():
        base = ROOT / "assets/wordmarks" / f"{slug}-{variant}"
        svg = ET.parse(base.with_suffix(".svg")).getroot()
        assert svg.attrib["aria-label"] == word
        title = svg.find("s:title", namespace)
        assert title is not None and title.text == word
        assert svg.find(".//s:text", namespace) is None
        assert svg.find(".//s:image", namespace) is None
        shape = svg.findall(".//s:path", namespace)
        assert len(shape) == 1 and shape[0].attrib["fill"].upper() == "#" + "".join(f"{value:02X}" for value in color)
        paths.append(shape[0].attrib["d"])
        png = Image.open(base.with_suffix(".png")).convert("RGBA")
        alpha = png.getchannel("A")
        assert png.width == 1200 and alpha.getextrema() == (0, 255)
        left, top, right, bottom = alpha.getbbox()
        assert left > 0 and top > 0 and right < png.width and bottom < png.height
        # Catch device-RGB conversion changing the specified SVG/PNG brand color.
        opaque = Counter(pixel[:3] for pixel in png.getdata() if pixel[3] == 255)
        assert set(opaque) == {color}, (base.name, opaque.most_common(2))
        masks.append(alpha.tobytes())
    assert len(set(paths)) == 1 and len(set(masks)) == 1
print("PASS: 6 outlined SVG + 6 transparent PNG; exact sRGB; matching variant geometry")

for size in (32, 40, 64, 128, 512):
    avatar = Image.open(ROOT / "exports" / f"avatar-circle-{size}.png").convert("RGBA")
    assert avatar.size == (size, size)
    assert avatar.getpixel((0, 0))[3] == 0 and avatar.getpixel((size // 2, size // 2))[3] == 255
for family in ("GolosText", "Manrope"):
    assert "SIL OPEN FONT LICENSE" in (ROOT / f"assets/fonts/{family}-OFL.txt").read_text()
    assert (ROOT / f"assets/fonts/{family}-variable.ttf").read_bytes()[:4] == b"\x00\x01\x00\x00"
assert len(manifest["assets"]) == 19
for name, expected in manifest["assets"].items():
    data = (ROOT / name).read_bytes()
    assert len(data) == expected["bytes"] and hashlib.sha256(data).hexdigest() == expected["sha256"]
print("PASS: circular exports, 2 font licenses and 19 asset checksums")


def luminance(color):
    channels = [int(color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in channels]
    return sum(value * factor for value, factor in zip(linear, (0.2126, 0.7152, 0.0722)))


for foreground, background in (("#183C2C", "#EDF0EA"), ("#354B38", "#EDF0EA"), ("#FFFFFF", "#1C664B"), ("#183C2C", "#96BD95")):
    values = sorted((luminance(foreground), luminance(background)))
    ratio = (values[1] + 0.05) / (values[0] + 0.05)
    assert ratio >= 4.5, (foreground, background, ratio)
    print(f"PASS: contrast {foreground}/{background} = {ratio:.2f}:1")
print("Static artifact checks passed; visual review and owner acceptance remain separate.")
