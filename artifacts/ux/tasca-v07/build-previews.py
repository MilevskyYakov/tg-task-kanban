"""Package actual Pen exports and create local review sheets without publishing."""
import hashlib
import json
import shutil
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).parent.resolve()
WORKING = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "tasca-brand-v07.pen"
EXPORTS = ROOT / "exports"
FONT = ImageFont.truetype(str(ROOT / "assets/fonts/Manrope-variable.ttf"), 22)
FONT.set_variation_by_axes([500])
BRAND = {"avatar": "iYcGz", "welcome": "M00YXB", "desktop": "Q8IKSO", "mobile": "xkj3i", "narrow": "sWXAC"}
APP = ["uGdN2", "eSknl", "v9yVPT", "t7WE3H", "NRrRL"]


def walk(node):
    yield node
    for child in node.get("children", []):
        yield from walk(child)


def image(path):
    return Image.open(path).convert("RGBA")


def place(canvas, item, x, y, width):
    item = item.resize((width, round(item.height * width / item.width)), Image.Resampling.LANCZOS)
    canvas.paste(item, (x, y), item)
    return item.height


def label(canvas, x, y, content, color="#183C2C"):
    ImageDraw.Draw(canvas).text((x, y), content, font=FONT, fill=color)


if __name__ == "__main__":
    document = json.loads(WORKING.read_text())
    keep = set(APP + list(BRAND.values()))
    document["children"] = [n for n in document["children"] if n["id"] in keep]
    assert {n["id"] for n in document["children"]} == keep
    for root in document["children"]:
        for node in walk(root):
            fill = node.get("fill")
            if isinstance(fill, dict) and fill.get("type") == "image":
                assert fill["url"] == "assets/app-preview.png" or fill["url"].endswith("/assets/app-preview.png")
                fill["url"] = "assets/app-preview.png"
    (ROOT / "tasca-brand-v07.pen").write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n")
    shutil.copy2(EXPORTS / "iYcGz.png", ROOT / "assets/bot-avatar-512.png")
    shutil.copy2(EXPORTS / "M00YXB.png", ROOT / "assets/group-welcome.png")

    avatar = image(EXPORTS / "iYcGz.png")
    mask = Image.new("L", avatar.size)
    ImageDraw.Draw(mask).ellipse((0, 0, avatar.width - 1, avatar.height - 1), fill=255)
    avatar.putalpha(mask)
    sizes = Image.new("RGB", (860, 310), "#EDF0EA")
    label(sizes, 24, 20, "Круглый кроп · фактический размер")
    x = 24
    for size in (32, 40, 64, 128, 512):
        small = avatar.resize((size, size), Image.Resampling.LANCZOS)
        small.save(EXPORTS / f"avatar-circle-{size}.png")
        if size <= 128:
            sizes.paste(small, (x, 76), small)
            label(sizes, x, 224, f"{size} px")
            x += size + 56
    sizes.save(EXPORTS / "avatar-size-check.png")

    for key, width in (("mobile", 390), ("narrow", 320)):
        full = image(EXPORTS / f"{BRAND[key]}.png")
        assert full.width == width and full.height >= 844
        full.crop((0, 0, width, 844)).save(EXPORTS / f"landing-firstfold-{width}.png")
    welcome = image(EXPORTS / "M00YXB.png")
    welcome.resize((320, round(welcome.height * 320 / welcome.width)), Image.Resampling.LANCZOS).save(EXPORTS / "welcome-telegram-320.png")

    overview = Image.new("RGB", (1600, 1780), "#EDF0EA")
    label(overview, 36, 24, "Таска / Бот и лендинг · v0.7")
    label(overview, 36, 76, "Аватар бота")
    place(overview, avatar, 50, 120, 256)
    label(overview, 36, 424, "32 / 40 / 64 px")
    for x, size in ((40, 32), (120, 40), (210, 64)):
        preview = image(EXPORTS / f"avatar-circle-{size}.png")
        overview.paste(preview, (x, 470), preview)
    label(overview, 400, 76, "Приветственная картинка")
    place(overview, welcome, 400, 120, 1160)
    label(overview, 36, 820, "Лендинг · desktop")
    place(overview, image(EXPORTS / "Q8IKSO.png"), 36, 870, 1116)
    label(overview, 1220, 820, "Mobile · 390")
    place(overview, image(EXPORTS / "xkj3i.png"), 1220, 870, 294)
    overview.save(EXPORTS / "brand-overview.png")

    logos = Image.new("RGB", (1440, 580), "#EDF0EA")
    for row, (slug, word) in enumerate((("tasca-ru", "Таска"), ("tasca-latin", "Tasca"))):
        for column, variant in enumerate(("green", "black", "white")):
            x, y = column * 480, row * 290
            if variant == "white":
                ImageDraw.Draw(logos).rectangle((x, y, x + 480, y + 290), fill="#183C2C")
            label(logos, x + 24, y + 20, f"{word} / {variant}", "#FFFFFF" if variant == "white" else "#183C2C")
            place(logos, image(ROOT / "assets/wordmarks" / f"{slug}-{variant}.png"), x + 24, y + 112, 432)
    logos.save(EXPORTS / "wordmarks.png")
    inventory = {}
    for path in sorted((ROOT / "assets").rglob("*")):
        if path.is_file() and path.name != ".DS_Store":
            content = path.read_bytes()
            inventory[str(path.relative_to(ROOT))] = {"bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
    manifest = {"source": "tasca-brand-v07.pen", "brand_nodes": BRAND, "accepted_app_nodes": APP, "assets": inventory}
    (ROOT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(f"Packaged {len(keep)} roots, {len(inventory)} assets; generated review sheets and first-fold crops.")
    print(ROOT / "tasca-brand-v07.pen")
    print(EXPORTS / "brand-overview.png")
