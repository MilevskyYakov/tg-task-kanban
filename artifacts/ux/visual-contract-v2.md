# Telegram Task Kanban — visual contract v2

Статус: final design handoff для Issue #52  
Канон: `artifacts/ux/task-list-visual-directions.pen` + этот contract  
Принцип: композиция финальных roots переносится 1:1; contract заменяет только явно перечисленные foundation-детали.

## 1. Визуальное направление

**Editorial utility**: типографика, сетка и функциональная иерархия важнее декоративных эффектов.

- Только светлая белая тема.
- Основной фон: белый; мягкие оттенки используются для секций и selected states, не для каждого элемента.
- Строки задач лёгкие, без тяжёлых карточек и лишних теней.
- Faux-3D остаётся только у главного task glyph и редких функциональных маркеров.
- Синий — primary/action; coral — urgency/error; зелёный — today/success; violet — neutral/no-deadline. Цвет всегда дублируется текстом, иконкой или формой.
- Никаких browser-default select/disclosure surfaces в visual target.

## 2. Typography

| Роль | Семейство | Правило |
|---|---|---|
| Display | Newsreader | Только крупные editorial-заголовки |
| UI | Inter | Controls, task titles, body, navigation |
| Metadata | IBM Plex Mono | Даты, counters, compact labels |

Все семейства поставляются локальными `.woff2`. Fallback: `Georgia`, `system-ui`, `ui-monospace`. Удалить из финальной реализации случайные `Geist`, `Geist Mono`, `Funnel Sans`.

## 3. Layout и shell

- Reference viewport: 390×844; boundary: 320×844. Existing PNG exports are
  780×1688 raster files representing the 390×844 logical viewport at 2×.
- Горизонтальные поля: 18 px на 390; 12 px на 320; плюс Telegram safe areas.
- Header прокручивается вместе с экраном. Sticky остаются только surfaces, где потеря действия опасна: create submit и comment composer.
- Bottom navigation: плоская белая панель на всю ширину, тонкий верхний divider, safe-area padding. Не floating card, без внешнего border/radius/shadow.
- Навигация: `Задачи / центральный круглый + / Настройки`; labels сохраняются.
- Центральный `+`: 58–64 px, выступает над divider; один заметный primary action.
- На 390 px видно 4–5 полезных task rows; task row 64–76 px; action row 52–56 px; tap target минимум 44×44 px.

## 4. Base controls

### Action row

Иконка или semantic marker слева, label/value по центру, chevron справа. Вся строка — одна кнопка 52–56 px. Disabled state сохраняет label и объяснимое значение, не исчезает.

### Choice sheet

Action row открывает bottom sheet. Внутри: title, optional search, radio/check rows, selected checkmark, explicit close. Sheet учитывает keyboard, safe area, focus trap, Escape и возврат focus.

### Disclosure

Тот же chevron поворачивается на 180°. Summary имеет 44 px target и `aria-expanded`. Раскрытый блок визуально принадлежит trigger; стандартный marker скрыт.

### Native date/time

Сохраняются native `date`/`time`, но получают единый Inter skin, 52–56 px height, border, padding, focus и disabled states.

### Icons

Один тонкий rounded line language. Локальные SVG; Lucide path допустим как source, но runtime dependency не нужна. Unicode glyph (`⌄`, `☼`, `◷`, `—`) не используется как UI-icon.

## 5. Канонические экраны

| Экран | Root | Export | 1:1 composition | Contract delta |
|---|---|---|---|---|
| Задачи по срокам | `xlomj` | `exports/xlomj.png` | Header, board selector, tabs/view switch, search/filter, deadline sections, task rows | typography, flat bottom bar, proper filter count, SVG icons |
| Новая задача | `lZNQ6` | `exports/lZNQ6.png` | Fullscreen title, primary title field, ordered fields, collapsed additional, fixed submit | action rows/sheets, styled native date/time, typography |
| Детали задачи | `irWr4` | `exports/irWr4.png` | Top bar, title/status/progress, Main/Content/Discussion, composer | choice sheets instead of raw selects; standard glyph language |
| Канбан | `hOXuP` | `exports/hOXuP.png` | One active column, status tabs, cards, bottom nav | explicit status action; flat bottom bar; no duplicate hidden list controls |
| Настройки | `mP9O3` | `exports/mP9O3.png` | Three root entries and child navigation | lighter surfaces, restrained 3D, action-row controls in children |

Roots `bi8Au`, `VzzNo`, `p8fpt` and any unnamed comparisons are historical only.

## 6. Screen rules

### Задачи

- Board selector stays right of title.
- Grouping tabs and list/kanban icon switch share one row.
- Search and filter trigger share next row. Count is inside filter trigger, never detached or clipped.
- Deadline order: Просрочено / Сегодня / Ближайшие / Без срока.
- Task row contains completion, title, project or board, deadline, assignee, urgency, blocker, checklist progress. No description/actions/status select.
- Project grouping reuses the same row and changes grouping only.

### Новая задача

- Title remains visual focus. Board is required only without active context.
- Project, assignee, board and priority use action rows + choice sheets.
- Date/time use styled native controls.
- `Дополнительно` is one disclosure for description, priority, notification and recurrence-related secondary fields.
- API error does not clear input; submit state is explicit.

### Детали задачи

- Status is an explicit choice sheet, not raw select.
- Main fields use action rows. Content and Discussion remain separate editorial sections.
- `•••` contains archive/history/recurrence; destructive action is visually separated.
- Comment composer stays fixed; keyboard must not cover it.

### Канбан

- Exactly one full-width status column at 320–430 px.
- Status tabs switch column; swipe is optional acceleration, not the only control.
- Card status change is explicit and uses choice sheet. No mobile drag-and-drop.
- Vertical scroll wins over horizontal swipe.

### Настройки

- Root contains only Workspace / Automation / Account.
- Root cards remain recognizable but lose decorative 3D not tied to function.
- Child settings use section groups, action rows, disclosures and styled native inputs; no raw technical values on root.

## 7. Cross-screen states

Every screen defines: loading, empty, error, offline, disabled, keyboard-open. Task surfaces additionally define urgent, blocker and completed. Error keeps user input and offers retry where safe. Offline banner does not cover header or action. Completed tasks stay hidden by default.

## 8. Responsive rules

### 390×844

Match canonical export composition and hierarchy. Bottom action/nav must not cover last content row.

### 320×844

- Header wraps board selector below title only when both no longer fit.
- Grouping labels may reduce gap but not font below 14 px.
- Filter text may hide; icon and count remain.
- Action rows stack label/value only when needed.
- No horizontal document overflow; status tabs and chips may scroll inside their own rails.
- Settings root stays single-column; create deadline date/time may wrap to two rows.

### Text zoom

At 200%, controls grow vertically and content wraps. No fixed-height clipping. Icon-only buttons keep accessible labels.

## 9. Visual acceptance matrix

| Surface | 390 root / @2x export | Critical 320 root / @2x export | State evidence | Approved target |
|---|---|---|---|---|
| Tasks deadline | `xlomj` / `exports/xlomj.png` (780×1688) | `t320Def` / `exports/t320Def.png` (640×1688) | default list, search, active-filter count | root + contract |
| Board sheet | `xlomj` shell | `t320Brd` / `exports/t320Brd.png` (640×1688) | selected radio, explicit close, safe area | base controls |
| Filter sheet | `xlomj` shell | `t320Flt` / `exports/t320Flt.png` (640×1688) | checked/unchecked rows, reset, apply | base controls |
| Create | `lZNQ6` / `exports/lZNQ6.png` (780×1688) | `c320Key` / `exports/c320Key.png` (640×1688) | keyboard open, submit remains visible | root + contract |
| Details | `irWr4` / `exports/irWr4.png` (780×1688) | `d320Cmp` / `exports/d320Cmp.png` (640×1688) | status action and fixed composer | root + contract |
| Kanban | `hOXuP` / `exports/hOXuP.png` (780×1688) | `k320One` / `exports/k320One.png` (640×1688) | exactly one status column | root + contract |
| Settings root | `mP9O3` / `exports/mP9O3.png` (780×1688) | `s320Root` / `exports/s320Root.png` (640×1688) | three lightweight root entries | root + contract |

Loading, empty, error/offline, disabled and 200% text-zoom behavior remain normative
state rules for implementation evidence. This design package adds critical 320 layout
evidence without multiplying every content-state permutation into separate roots.

## 10. Implementation guardrails

- Functional behavior from merged Issues #27–#36 remains. Visual work must not reopen API/DB/product architecture.
- No new router, state manager or icon dependency.
- Shared primitives are allowed only where two or more approved screens use identical anatomy.
- Each PR includes visual evidence at 390×844 and 320×844, plus a reference to its root/export and this contract.
- Production stays on previous-known-good until all implementation slices merge and one final release gate passes owner visual smoke.
