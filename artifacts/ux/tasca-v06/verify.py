"""Check the exported Pen study, not runtime behavior or owner acceptance."""
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).parent
MANIFEST = json.loads((ROOT / "manifest.json").read_text())
NODES = {
    node["id"]: node
    for node in json.loads((ROOT / MANIFEST["source"]).read_text())["children"]
}


def walk(node):
    yield node
    for child in node.get("children", []):
        yield from walk(child)


def texts(node_id):
    return [n["content"] for n in walk(NODES[node_id]) if n.get("type") == "text"]


def named(node_id, name):
    matches = [n for n in walk(NODES[node_id]) if n.get("name") == name]
    assert len(matches) == 1, (node_id, name, len(matches))
    return matches[0]


def luminance(rgb):
    values = [channel / 255 for channel in rgb[:3]]
    linear = [value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in values]
    return sum(value * weight for value, weight in zip(linear, (0.2126, 0.7152, 0.0722)))


def contrast(a, b):
    low, high = sorted((luminance(a), luminance(b)))
    return (high + 0.05) / (low + 0.05)


if __name__ == "__main__":
    assert set(MANIFEST["screens"]) == {"create", "details", "kanban", "settings"}
    ids = [MANIFEST["accepted_list"]]
    for key, screen in MANIFEST["screens"].items():
        wide, narrow = screen["wide"], screen["narrow"]
        assert NODES[wide]["width"] == 390
        assert NODES[narrow]["width"] == 320
        wide_text = texts(wide)
        narrow_text = texts(narrow)
        if key == "kanban":
            wide_text = [text.replace("Свайпните для смены статуса", "Одна активная колонка") for text in wide_text]
        assert sorted(wide_text) == sorted(narrow_text), key
        ids.extend((wide, narrow))
    ids.extend(MANIFEST["states"].values())
    assert len(ids) == len(set(ids))
    for node_id in ids:
        assert NODES[node_id]["height"] == 844
        assert not NODES[node_id].get("placeholder", False)
        image = Image.open(ROOT / "exports" / f"{node_id}.png")
        assert image.size == (NODES[node_id]["width"] * 2 + 2, 1690), node_id
        for node in walk(NODES[node_id]):
            assert node.get("name"), node_id
            if node.get("type") == "text":
                expected = "Inter" if node["name"] == "Имя приложения" else "Manrope"
                assert node["fontFamily"] == expected, (node_id, node["name"])

    create = MANIFEST["screens"]["create"]["wide"]
    details = MANIFEST["screens"]["details"]["wide"]
    kanban = MANIFEST["screens"]["kanban"]["wide"]
    settings = MANIFEST["screens"]["settings"]["wide"]
    assert {"Создать задачу", "Создать и добавить ещё", "Дополнительно", "К выполнению"} <= set(texts(create))
    assert {"Сохранено", "Скопировать", "Изменить", "Чек-лист", "Обсуждение", "Добавить GitHub issue"} <= set(texts(details))
    assert "Сохранить изменения" not in texts(details)
    for name in ("Добавить ссылку", "Прикрепить изображение", "Отправить комментарий — неактивно"):
        assert named(details, name)["width"] == 44
    progress = named(details, "Шкала чек-листа")
    assert progress.get("layout", "horizontal") == "horizontal"
    assert len(progress["children"]) == 2
    assert all(child["width"] == "fill_container" for child in progress["children"])
    assert "2 из 4 шагов" in texts(details)
    for state in ("details_scrolled", "details_scrolled_narrow"):
        assert sorted(texts(MANIFEST["states"][state])) == sorted(texts(details))
    assert {"Новая", "В работе", "Блокер", "Готово"} <= set(texts(kanban))
    assert len([n for n in walk(NODES[kanban]) if n.get("name", "").startswith("Единственная активная колонка")]) == 1
    assert len([n for n in walk(NODES[settings]) if n.get("name", "").endswith(" — раздел")]) == 3
    error = MANIFEST["states"]["create_uncertain"]
    for name in ("Название задачи", "Значение Проект", "Значение Исполнитель", "Дата срока", "Время срока", "Значение Статус", "Значение Доска"):
        assert named(error, name)["content"] == named(create, name)["content"], name
    assert named(error, "Основные поля создания")["opacity"] == 0.6
    sheet = MANIFEST["states"]["status_sheet"]
    for status in ("Новая", "В работе", "Блокер", "Готово"):
        assert named(sheet, f"Выбрать {status}")["height"] == 52
    assert "Закрыть" in texts(sheet)

    # Pen bounds captured after the last typography change. Sample the background
    # strip 2 logical pixels above each label, not antialiased foreground pixels.
    spots = [
        ("eSknl", "Подпись Исполнитель", 58, 350, 77),
        ("v9yVPT", "Проект", 44, 320, 42),
        ("v9yVPT", "Срок", 44, 386, 29),
        ("NRrRL", "Рабочее пространство — описание", 32, 255, 326),
        ("NRrRL", "Автоматизация — описание", 32, 420, 326),
        ("t7WE3H", "Метаданные Согласовать обложку", 44, 442, 266),
    ]
    for node_id, name, x, y, width in spots:
        image = Image.open(ROOT / "exports" / f"{node_id}.png").convert("RGB")
        color = named(node_id, name)["fill"]
        foreground = tuple(int(color[index:index + 2], 16) for index in (1, 3, 5))
        values = [contrast(foreground, image.getpixel((px, int((y - 2) * 2 + 1)))) for px in range(int(x * 2 + 1), int((x + width) * 2 + 1))]
        minimum = min(values)
        assert minimum >= 4.5, (node_id, name, minimum)
        print(f"CONTRAST {node_id} {name}: {minimum:.2f}:1")
    for foreground, background in (((255, 255, 255), (23, 100, 71)), ((135, 61, 46), (242, 226, 215))):
        value = contrast(foreground, background)
        assert value >= 4.5, value
        print(f"CONTRAST solid pair: {value:.2f}:1")
    print(f"PASS: {len(MANIFEST['screens'])} new screen types, {len(ids)} exports including accepted list and states; content, controls, fonts and contrast spot checks.")
