"""Collect local #134 evidence after the visual suite; requires existing Pillow."""
from pathlib import Path
import hashlib
import json
import re
import shutil
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SOURCE = ROOT / 'artifacts/visual-evidence'
RUNTIME = HERE / 'runtime'
RUNTIME.mkdir(exist_ok=True)

screenshots = sorted(SOURCE.rglob('*.png'))
for source in screenshots:
    target = RUNTIME / source.relative_to(SOURCE)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def montage(names, target, width, rows=1):
    columns = len(names) // rows
    image = Image.new('RGB', (width * columns, 872 * rows), '#EDF0EA')
    draw = ImageDraw.Draw(image)
    for index, name in enumerate(names):
        x, y = (index % columns) * width, (index // columns) * 872
        source = Image.open(name).convert('RGB')
        # Preserve the screenshots' aspect ratio; only trim the viewport below 844 px.
        if source.width != width:
            source = source.resize((width, round(source.height * width / source.width)))
        image.paste(source.crop((0, 0, width, min(844, source.height))), (x, y + 28))
        draw.text((x + 8, y + 8), name.name, fill='#183C2C')
    image.save(HERE / target)


for width in (390, 320):
    names = [f'{surface}-{width}x844.png' for surface in ('tasks', 'kanban', 'create', 'details', 'settings')]
    montage([RUNTIME / name for name in names], f'runtime-overview-{width}.png', width)
    if width == 390:
        montage([HERE / 'baseline-screens' / name for name in names] + [RUNTIME / name for name in names], 'before-after-390.png', width, 2)

montage([RUNTIME / name for name in (
    'tasca-outside-320.png', 'entry-help-320.png', 'tasks-filter-sheet-320x844.png', 'issue82/create-320.png',
    'tasca-auth-error-320.png', 'tasca-denied-320.png', 'pair-archived-member.png', 'create-320x520-keyboard.png'
)], 'state-overview-320.png', 320, 2)


def luminance(rgb):
    channels = [value / 255 for value in rgb]
    return sum((value / 12.92 if value <= .04045 else ((value + .055) / 1.055) ** 2.4) * weight for value, weight in zip(channels, (.2126, .7152, .0722)))


def contrast(foreground, background):
    values = sorted((luminance(foreground), luminance(background)))
    return round((values[1] + .05) / (values[0] + .05), 3)


contrasts = []
for width in (390, 320):
    pixels = Image.open(RUNTIME / f'tasca-material-{width}.png').convert('RGB')
    darkest = min(set(pixels.getdata()), key=luminance)
    for name, foreground in [('primary', (24, 60, 44)), ('secondary', (53, 75, 56))]:
        ratio = contrast(foreground, darkest)
        assert ratio >= 4.5, (width, name, darkest, ratio)
        contrasts.append({'width': width, 'text': name, 'darkest_material_rgb': darkest, 'minimum_ratio': ratio})
contrasts.append({'text': 'white action', 'ratio': contrast((255, 255, 255), (23, 100, 71))})

assets = []
for runtime, source in (
    ('fonts/manrope-variable.ttf', 'fonts/Manrope-variable.ttf'),
    ('fonts/OFL-Manrope.txt', 'fonts/Manrope-OFL.txt'),
    ('brand/tasca-ru-green.svg', 'wordmarks/tasca-ru-green.svg')
):
    path = ROOT / 'apps/web/public' / runtime
    assert path.read_bytes() == (ROOT / 'artifacts/ux/tasca-v07/assets' / source).read_bytes()
    assets.append({'path': str(path.relative_to(ROOT)), 'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})

ansi = re.compile(r'\x1b\[[0-9;]*[A-Za-z]')
visual_log = ansi.sub('', (HERE / 'visual-final.log').read_text())
assert not re.search(r'^\s*\d+ failed', visual_log, re.M)
visual_match = re.search(r'^\s*(\d+) passed', visual_log, re.M)
assert visual_match, 'Missing visual suite total'
visual_passed = int(visual_match[1])
unit_log = (HERE / 'tests.log').read_text()
test_totals = [int(value) for value in re.findall(r'^# tests (\d+)', unit_log, re.M)]
assert re.findall(r'^# fail (\d+)', unit_log, re.M) == ['0', '0']
report = {
    'visual_passed': visual_passed,
    'unit_and_isolation': test_totals,
    'runtime_screenshots': len(screenshots),
    'contrast_scope': 'Darkest composited pixel of the list material, ink hidden, widths 390/320. Not a complete WCAG or device audit.',
    'contrasts': contrasts,
    'assets': assets,
    'screenshots': [{'path': str(path.relative_to(SOURCE)), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()} for path in screenshots]
}
(HERE / 'verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({key: value for key, value in report.items() if key != 'screenshots'}, ensure_ascii=False, indent=2))
