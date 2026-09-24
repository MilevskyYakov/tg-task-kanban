# Issue #129 — единое автосохранение (implementation evidence)

Ветка: `MilevskyYakov/issue-129`. Ревизия: поверх актуального main `e91b82e`.

## Изменённые поверхности (все edit-поверхности Issue, не только карточка)

| Поверхность | Было | Стало |
|---|---|---|
| Карточка задачи (task-details.tsx) | локальный черновик + submit-кнопки «Сохранить изменения» | autosave-диффы: поле-за-полем, версионный PATCH (`expectedVersion`), статусы «Ожидает отправки / Сохраняется… / Сохранено / Не сохранено», flush на blur/«Готово»/«Назад», конфликт-шина (обе версии, выбор, «решить позже») |
| Название доски (workspace settings) | форма с кнопкой «Сохранить» | blur-autosave, оптимистичное обновление списка досок |
| Названия проектов (workspace settings) | форма с кнопкой «Сохранить» на каждый проект | blur-autosave; «В архив» осталась явным действием |
| Публикации в чат (automation settings) | поля + кнопка «Сохранить» | debounced autosave с валидацией (invalid не отправляется); «Предпросмотр» остался |
| Фильтры задач | уже автосохранение | сохранено без изменений |
| Чек-лист | уже сохранение по действию/blur | сохранено без изменений |
| Команды/вложения | явная отправка | сохранена (явные операции не автосейвятся) |

## Root-фиксы по Issue

- `waitCheckAt` больше не хранится пустой строкой в черновике: дата берётся из задачи; правка названия ожидающей задачи отправляет только `title` (unit-тест «title edit of a waiting task must not clear waitCheckAt»).
- PATCH отправляет только изменённые поля — чужие поля не перетираются.
- `main.tsx` не делает полный `loadBoard` после каждого сохранения: берёт подтверждённый серверный объект как новый baseline (и как источник `version`).
- `expectedVersion` проверяется атомарно внутри `FOR UPDATE`-транзакции `updateTask`; 409 отдаёт текущий серверный объект → UI показывает конфликт, не перезаписывает молча.
- `updateTaskAndFuture` при частичном отказе серии возвращает `seriesUpdateFailed: true` → честное сообщение «серию изменить не удалось», без ложного полного успеха.
- `writeStorage` возвращает boolean (основа для honest-предупреждения о недоступном storage; full-предупреждение и offline-resume UI — на следующем шаге, storage-слой готов).
- Повторяющаяся задача: автосохранение трогает только экземпляр; «применить к серии» — отдельный чекбокс в меню, `scope=future`.

## Гейты (реальные прогоны)

- `npm run test:unit` — 33/33 pass (включая новые тесты диффов taskPatch).
- `npm run test:isolation` (TEST_DATABASE_URL=postgres://task@localhost:5499/task, локальный PostgreSQL 14 с миграциями 001–015) — 13/13 pass (включая новый тест expectedVersion в task-lifecycle).
- `npm run typecheck` — exit 0.
- `npm run build` — exit 0 (vite, 45 modules).
- `git diff --check` — чисто.
- Visual `details.spec.ts` — 21/21 pass (390/320, редактор описания, autosave без кнопки, flush на выход, failed-save → resend по `online`, конфликт версий, GitHub issue, дедлайны во всех режимах, 200% текст, 320×520 композер, desktop 1280).
- Visual полный (82 теста): 73 pass. 9 падений воспроизводятся на чистом main без моих правок (проверено `git stash`): foundation×2 — жёстко зашитый порт 4173 в тесте при PLAYWRIGHT_PORT=4199; input-perf×5 — тесты производительности, роняющие счётчик событий на этой машине; mcp×2 — тайминги против реального API. Все 9 — environment/test-harness, не продукт; на CI-порте 4173 foundation зелёные.
- Ввод: p50=16ms, longtask=0ms (create title, queue=50) — регрессия #123 не затронута.

## Фактические скриншоты (artifacts/visual-evidence/)

- `details-390x844.png` / `details-320x844.png` — чтение: нет кнопки «Сохранить», композиция #124 цела (проверено осмотром).
- `details-390x844-edit.png` / `details-320x844-edit.png` — редактор описания: «Готово» закрывает и сохраняет, кнопки «Сохранить изменения» нет.
- `details-1280x900.png`, `details-320x520-keyboard.png` — desktop и клавиатура.

## Не сделано (честно)

- Draft persistence при закрытии WebView (offline-resume UI) — storage-слой в Autosave есть, подключение в main-экранах карточки/настроек не завершено. Тест «storage unavailable/quota» не написан.
- Визуальный тест на offline-reopen сценарий из acceptance (строка 97) не написан.
- Реальный Telegram device smoke (iOS/Android/Desktop) не выполнялся — нет device/account доступа (HITL gap по Issue п.5). Требуется versioned checklist при merge.
- 9 pre-existing visual-падений harness-типа (см. выше) чинить не стал — вне скоупа, воспроизводятся на main.

## Как проверял локально

- Postgres: `initdb ~/orca/pg-test-issue129`, порт 5499, `DATABASE_URL=... npm run migrate` (001–015 применились).
- Dev-сервер вручную (vite, порт 4310) + playwright-core смок: PATCH содержит только `title` + `expectedVersion`, статус «Сохранено».
