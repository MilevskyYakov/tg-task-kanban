# Issue #141 — evidence реализации

Основа реализации: ветка `MilevskyYakov/issue-141`, base `d3ccd5fd08be22d526e735c26e94f3783d2e796a`; implementation commit `084305d288a845a93c06a4d3a2873e259b762511`. Локальный `main` обновлён fast-forward от актуального `origin/main` на base SHA и включает implementation commit. Issue #141 остаётся OPEN; push, PR/Issue update, CI/CD и deploy не выполнялись.

## Изменения

- `apps/web/src/autosave.ts`: одна очередь с ревизиями и одним in-flight запросом; сохраняется последнее намерение, пустой diff отменяет отложенную отправку, старый ответ не очищает новую запись и не сообщает «Сохранено» раньше времени.
- `apps/web/src/task-details.tsx`, `apps/web/src/main.tsx`: rebase на подтверждённый сервером Task и актуальный `expectedVersion`; неоднозначный сетевой/5xx исход сверяется GET одного Task. PATCH остаётся частичным; reload доски на каждый ввод не добавлен.
- `taskPatch`: date-only deadline игнорирует скрытое время, иначе ответ сервера повторно планировал бы ту же правку.
- Регрессии: `apps/web/test/tasks.test.ts`, `apps/web/visual/details.spec.ts`, `apps/api/test/task-lifecycle.test.ts`.

## Acceptance

1. **PASS:** ошибка A не заменяет B; отложенный retry отправляет B.
2. **PASS:** flush A/B/C не допускает параллельных запросов; максимум active = 1.
3. **PASS:** возврат поля к базе отменяет diff; независимое изменение описания сохраняется отдельно.
4. **PASS:** успех старой ревизии оставляет новую запись и статус pending; committed PATCH с потерянным ответом сверяется с сервером, текст не откатывается.
5. **PASS:** существующие проверки blur, «Готово», выхода из карточки, debounce и deadline choice прошли в browser suite.
6. **PASS локально:** committed lost-response probe не повторяет PATCH; актуальный `expectedVersion` проверен при последовательных записях; 401/403/404/422 не запускают авто-retry.
7. **PASS локально:** read-only browser test и tenant/role DB tests прошли. Полный `npm run test` имеет отдельный отказ MCP — см. ниже.
8. **Разделено:** local автоматические результаты приведены отдельно. Device/provider smoke **не выполнялся** и PASS не заявляется.

## Проверки

- `npm ci --include=dev` — exit 0; 250 пакетов проверено, 0 уязвимостей.
- `npm run test:unit` — exit 0; 36/36.
- `npm run screenshots -w @task/web -- details.spec.ts --timeout 15000` — exit 0; 26/26. Browser/API ответы синтетические; это не Telegram/device smoke.
- `TEST_DATABASE_URL` на отдельной loopback PostgreSQL `:5499`, БД `task_kanban_issue141`; миграции применены командой `DATABASE_URL=… npm run migrate` — exit 0.
- `node --import tsx --test apps/api/test/task-lifecycle.test.ts apps/api/test/isolation.test.ts` — exit 0; 2/2. Проверяется сохранённое в DB последнее значение и versioned A/B writes.
- `npm run lint`, `npm run typecheck`, `npm run build`, `git diff --check` — все exit 0. Vite production build обработал 46 модулей; API TypeScript build завершился.
- `TEST_DATABASE_URL=… npm run test` — exit 1: unit 36/36; API/isolation 12/13. Повторный отдельный запуск `apps/api/test/mcp.test.ts` тоже exit 1: `apps/api/test/mcp.test.ts:107`, проверка «same name dedupes to existing project» получила иной ID. MCP-файлы не менялись; дефект оставлен вне #141.

## Артефакты и остаток

- Локальный отчёт: `artifacts/evidence/issue-141-autosave-report.md`.
- Изменено 6 файлов: три источника/теста web и два regression-теста плюс `apps/api/test/task-lifecycle.test.ts`.
- Нужен отдельный follow-up для сбоя MCP idempotency, если он входит в целевой gate; здесь не менялся.
- Реальный Telegram iOS/Android/Desktop smoke и provider/device gates не запускались: нет отдельного разрешения и device/account доступа.
- PostgreSQL остановлена после проверок; синтетический каталог тестового кластера сохранён. Миграции репозитория не менялись.
- Implementation commit: `084305d288a845a93c06a4d3a2873e259b762511`; локальный `main` включает его. Этот отчёт входит в task branch отдельным evidence-коммитом. Issue #141 остаётся OPEN; удалённые push, PR/Issue update, CI/CD и deploy не выполнялись.

## QA — происхождение отказа полного gate

Повторена только падающая MCP-проверка на чистом baseline и candidate: отдельные detached worktree/DB, одинаковые lockfiles (`package-lock.json` SHA-256 `b8f0fb386fcaecf9d859f66c25d1958ffa0e645d9c895fe3f9a0a2ab4b69b2c1`), Node dependencies одинаковой версии (`npm ci --include=dev --offline`, exit 0 в baseline; candidate использует тот же lockfile). PostgreSQL 14.23, loopback `:5499`; обе новые базы получили одинаковые миграции `001`–`015`.

- Base `d3ccd5fd08be22d526e735c26e94f3783d2e796a`, чистый worktree: `TEST_DATABASE_URL=… node --import tsx --test apps/api/test/mcp.test.ts` — exit 1. `apps/api/test/mcp.test.ts:107`: `same name dedupes to existing project`; `ERR_ASSERTION`, `strictEqual`; expected `1bead811-b53c-48af-84b2-e9eba333a386`, actual `ea021b8a-d1ca-47f9-aada-6f870c562dc1`.
- Candidate на том же base SHA с незакоммиченными #141-изменениями: та же команда/lockfile, отдельная чистая DB — exit 1, та же строка и assertion; expected `f312db70-2aa7-4c37-a157-7a99e7eda7b7`, actual `73f3ba74-7994-4bc3-b937-a5f2ffa86875`.

Итог: **подтверждённый baseline blocker, не regression #141**. UUID отличаются, но failing assertion, код ошибки, оператор и стек совпадают. MCP вне scope; не исправлялся. QA worktree и обе одноразовые DB после записи результата удалены, PostgreSQL остановлена.
