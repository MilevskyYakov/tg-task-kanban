# Подготовка к деплою #100 (сделано агентом, деплой НЕ выполнялся)

Дата подготовки: 2026-09-22. Кандидат и все числа зафиксированы реальными прогонами в этой сессии.

## 1. Состояние кандидата

Блоки #96–#99 кодом готовы, НО единый кандидат ещё не собран: PR не слиты.

| PR | Блок | Состояние |
|---|---|---|
| #101, #104, #106 | #96, #97, #103 | в `main` (слиты) |
| **#111** `MilevskyYakov/issue-98` | #98 контекст карточки | OPEN, **CONFLICTING** с `main` (mcp.ts, mcp.test.ts, db.ts) |
| **#110** `MilevskyYakov/mcp-4` | #99 повторения | OPEN, CLEAN, MERGEABLE, rebased на `cfe8fa7` |
| #107 `MilevskyYakov/rich` | #102 (вне блоков) | OPEN |

Известный конфликт #111 — не только docs: обе ветки меняли `apps/api/src/mcp.ts`, `apps/api/src/db.ts`, `apps/api/test/mcp.test.ts`, `package.json`. Worktree `…/mcp-3` (ветка `MilevskyYakov/issue-98`) находится **посреди незавершённого merge** (UU: mcp.ts, mcp.test.ts; в индексе — идемпотентно-защищённые копии миграций 013/014). Merge не доделывать и не откатывать без владельца — это чужой in-progress rebase.

Порядок кандидата: `taskfinish` → merge #111 (после разрешения конфликта) → merge #110 → свежий `main` = кандидат для runbook.

## 2. Гейты на кандидате (последний реальный прогон, ветка mcp-4 @ adb5514)

- `npm run typecheck` — 0 ошибок
- `npm run build` — success
- `npm run test:unit` — 32/32
- `npm run test:isolation` — 13/13 (отдельная тестовая PostgreSQL `yakov_mcp_recurrence_test`, миграции 001–014)

⚠️ Окружение: в shell `NODE_ENV=production` — plain `npm ci` ставит без devDeps и typecheck падает (`@types/pg` и др.). Ставить: `NODE_ENV=development npm ci --include=dev`. После финального merge повторить все 4 гейта на итоговом `main`.

## 3. Что добавится на сервере (runbook §3 без изменений + факты)

- Новых миграций в #99/#110 **нет** (receipts переиспользуют 013). Миграции кандидата = те, что уже на production (001–012) **+ 013** (в `main` со времён #97) **+ 014** (`main`, #108) + возможные из #111 при merge. Backup до первой миграции версии обязателен (runbook §2).
- MCP tools: было 11 (write) / 5 (read), станет 14 / 6. Новые: `list_recurrences` (read), `create_recurrence`, `update_recurrence` (write). Из #96/#97 уже в коде: полное редактирование карточек, claim, archive_task, create/update_project — деплоятся тем же кандидатом, если #96/#97 ещё не были в последнем production-релизе (последний известный production SHA: `08656edd…`, #82).
- `/health`, порты, compose, webhook — без изменений.

## 4. Фазы #100 после GO (по issue + runbook, без отступлений)

1. Deploy: previous-known-good SHA = записать `git rev-parse HEAD` на сервере **до** `git pull`; backup + restore smoke (runbook §2); `git pull --ff-only`; `docker compose build`; `docker compose run --rm app node apps/api/dist/migrate.js`; `up -d app`; `/health` локальный и `https://task.kairos-ai.ru/health`.
2. Ключ: старый отозван сознательно (#82). Новый ключ создаёт **владелец** в приложении, настраивает в Hermes, переподключение — владелец.
3. Production smoke из Hermes (синтетика, точные уникальные названия, боевые карточки не трогать):
   - `list_boards`, `list_recurrences` (пусто/не-боевое), `list_projects`;
   - проект: `create_project` → повтор requestId → `replayed: true` → rename → archive → restore;
   - карточка: `create_task` (все поля, `notifyAssignee: true` только на владельца) → `get_task` readback → `update_task` (версии, `VERSION_CONFLICT` при старой версии) → comment/checklist/attachment (#98 tools) → archive → restore;
   - повторение: `create_recurrence` (weekly, точный день/время/таймзону) → readback полей → `update_recurrence paused:true` (`nextOccurrenceAt=null`) → `paused:false` (пересчитан) → `archived:true`; изменить карточку-экземпляр → серия не изменилась; изменить серию → карточка не изменилась;
   - повторы requestId каждого мутационного вызова → `replayed: true`, без дублей;
   - по завершении: тестовую серию заархивировать, синтетику оставить завершённой (удаления нет).
4. Docs: обновить `docs/issue-82-mcp-contract.md` (таблица tools: +6 инструментов, семантика повторений, новый write-набор #96/#97), пользовательскую инструкцию в `apps/web/src/mcp-connections.tsx` (help не перечисляет инструменты — проверить, достаточно ли общего текста), отчёт по образцу `issue-82-verification.md` + `issue-82-production-smoke.md`.

## 5. Rollback

По runbook §6: `git checkout <previous-known-good>`, `build app`, `up -d app`, `/health`. Миграции 013/014 обратно не откатывать (runbook: rollback кода не откатывает схему; 013 совместима со старым кодом по полям, 014 только добавляет nullable-колонку/check).

## 6. Открытые вопросы владельцу (блокируют только старт, не подготовку)

1. Merge-порядок: #111 сначала (после чужого in-progress merge — кто доделывает?), затем #110. Подтвердить, что #107 (rich) в этот кандидат не входит.
2. GO на запуск фаз — отдельно, после зелёных гейтов на итоговом `main`.
