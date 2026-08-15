# Telegram Task Kanban — implementation map после design Issue #52

Все Issues ниже меняют только frontend presentation. Backend contracts и функциональный результат merged Issues #27–#36 сохраняются. Production deploy запрещён до финального release gate.

## Порядок

0. Закрыть design artifact gap: final `.pen` roots и 320 px exports (#60).
1. Foundation и visual harness.
2. Главный экран задач.
3. Новая задача.
4. Детали задачи.
5. Мобильный канбан.
6. Настройки.
7. Cross-screen stabilization и release gate.

Foundation зависит от #60 и final closeout #52. Экранные Issues 2–6 зависят от 1,
но после него могут выполняться независимо в отдельных ветках. Issue 7 зависит от 2–6.

## Issue A — Зафиксировать light-only foundation и visual harness

**Destination:** общий shell и primitives воспроизводят `visual-contract-v2.md`, а screenshot evidence сравним между PR.

**Scope:**
- vendored `.woff2` для Newsreader, Inter, IBM Plex Mono;
- primitive/semantic/component CSS tokens;
- light-only environment policy без dark overrides;
- плоская full-width bottom navigation и safe areas;
- SVG icon language, TaskGlyph, ActionRow, ChoiceSheet, Disclosure, styled native date/time;
- deterministic mocked Telegram fixture и screenshot scripts для 390×844/320×844.

**Non-goals:** экранная перекомпоновка, API/DB, production deploy.

**Acceptance:** font requests локальные; no horizontal overflow; keyboard/focus/escape/return-focus работают; visual fixture создаёт стабильные screenshots; unit/typecheck/build проходят.

## Issue B — Довести «Задачи» и выбор/фильтры до `xlomj`

**Destination:** default task list визуально повторяет `xlomj` с contract deltas.

**Scope:** header/board selector; grouping + view row; search/filter row; filter count; board/filter sheets; deadline/project sections; light task row anatomy; loading/empty/error/offline; 320 wrapping.

**Non-goals:** create/details/kanban/settings; filter semantics/API changes.

**Acceptance:** composition matches references at both viewports; 4–5 useful rows at 390; filter count never detached; task row has no description/raw status select; same task set across groupings; checks pass.

## Issue C — Довести «Новая задача» до `lZNQ6`

**Destination:** fullscreen create reproduces root and uses approved controls.

**Scope:** title hierarchy; board/project/assignee/priority choice sheets; styled date/time; Additional disclosure; fixed submit with keyboard/safe area; loading/error/success/disabled states.

**Non-goals:** create API contract, new fields, recurrence redesign.

**Acceptance:** required validation unchanged; failed request preserves input; context board behavior unchanged; 320/390 screenshots match; keyboard does not cover active field/submit; checks pass.

## Issue D — Довести детали и collaboration до `irWr4`

**Destination:** details reproduce root without browser-default selectors.

**Scope:** top bar/title/status/progress; Main action rows and sheets; Content/checklist; Discussion/attachments; fixed composer; overflow menu; loading/error/blocker/completed states.

**Non-goals:** collaboration API, blocker model, attachment transport.

**Acceptance:** all current actions remain reachable; status/fields use sheets; destructive action separated; failed action keeps screen/input; back restores context; keyboard and 320/390 evidence pass.

## Issue E — Довести мобильный канбан до `hOXuP`

**Destination:** one-column kanban reproduces root and uses explicit status action.

**Scope:** status tabs/counts; active-column header; task cards; swipe arbitration; status sheet; empty/loading/error; 320/390 states.

**Non-goals:** desktop four-column board, drag-and-drop, status API.

**Acceptance:** exactly one column visible 320–430; vertical scroll wins; status change explicit; optimistic rollback unchanged; no duplicate list controls; screenshots/checks pass.

## Issue F — Довести настройки до `mP9O3`

**Destination:** root and child settings share approved visual system.

**Scope:** three-entry root; restrained functional glyphs; Workspace/Automation/Account child groups; action rows, sheets, disclosures, styled native inputs; loading/empty/error/permission states.

**Non-goals:** settings capabilities/API/permissions changes.

**Acceptance:** root contains only three entries; every existing capability reachable within 2–3 transitions; no raw browser-default disclosure/select; 320/390 evidence and checks pass.

## Issue G — Cross-screen visual acceptance и единый production release gate

**Destination:** one release candidate passes full matrix before one production rollout.

**Scope:** screenshot matrix review; 200% text zoom; focus/reduced motion; iOS/Android Telegram smoke; create/edit/complete/block/unblock; deep link; backup/rollback/deploy gate; owner visual approval.

**Non-goals:** new features, backend refactor, incremental production rollout of unfinished slices.

**Acceptance:** all prior PRs merged; test/lint/typecheck/build green; screenshots approved; real Telegram device smoke passed; owner explicitly says GO; rollback ready; production deployed once; health and smoke pass.
