# Архив проекта: локальная приёмка #149

Родитель: #140. База — `fa8b4bee3d6f693fbefb2ea19634c309a3bc19a0`, ветка `MilevskyYakov/issue-149`. Проверенный source/build snapshot фиксируется в [manifest](issue-149-source-manifest.json); исторические результаты #129–148 не подменяют текущую проверку. Фактические commit/PR/merge и закрытие фиксируются в итоговом комментарии Issue #149; этот отчёт не подтверждает deploy.

## Изменения

- `updateTask` и `updateRecurrence` сохраняют прежнюю связь с архивным проектом, но не разрешают новое назначение в него. SQL по-прежнему проверяет `board_id`; исключение из требования active действует только для текущего `project_id` заблокированной строки. UUID сравниваются PostgreSQL, поэтому допустимое uppercase-представление того же UUID не считается новым назначением.
- Создание задач/серий не изменено: архивные и чужие проекты недоступны. `projectId: null` снимает связь, активный проект той же доски заменяет её. Права, optimistic version guard, assignee membership, tenant isolation, board locks и транзакции остаются прежними.
- Обе загрузки карточки — deep link и открытие из списка — запрашивают проекты с `archived=true`. Название исторического проекта отображается в карточке и подтверждении применения к серии; список новых назначений по-прежнему исключает архивные проекты.
- Добавлены шесть API/DB/MCP regression-сценариев и два browser/API/DB-сценария. API regression включён в штатный `npm run test:isolation`. Уточнён существующий MCP-контракт.

Production-код изменён в четырёх строках. Новых библиотек, миграций, endpoint, переносов связей или массовых обновлений нет.

## Среда

Node.js 22.22.3, npm 10.9.8, PostgreSQL 14.23 (Homebrew). Разрешённый `npm ci --include=dev` завершился с exit 0; lockfile не изменён. Отдельный кластер в `artifacts/evidence/issue-149-runtime/postgres`, база `issue149`, UTF-8 / `en_US.UTF-8`, TCP только `127.0.0.1:5499`, Unix sockets отключены. Штатные миграции применены только к этой тестовой БД. Docker, production и чужие worktrees не использовались.

Данные синтетические. REST проверен через настоящие Fastify handlers (`app.inject`) и PostgreSQL; MCP — настоящим SDK Client через loopback HTTP. Browser использует Chromium, mock Telegram launch/auth и реальные API/DB handlers, а не mock PATCH success. Новые проверки не отправляют Telegram-уведомления; сохранность outbox проверяется чтением БД.

Логи, runner, JSON reports и тестовый кластер находятся в ignored `artifacts/evidence/issue-149-runtime/`. Это evidence задачи, не второй task tracker. Исходные секреты, cookie, initData и реальные пользовательские тексты в отчёт не включены.

После итоговых проверок тестовая PostgreSQL остановлена через `pg_ctl -m fast -w stop` (exit 0); закрытие порта 5499 подтверждено отдельной TCP-проверкой. Данные кластера и evidence сохранены в workspace. Чужие процессы не останавливались.

## Воспроизведение и результаты

1. До изменения production-кода: `node --import tsx --test apps/api/test/project-archive.test.ts` — exit 1, **0/6 PASS**. Обе канонические операции возвращали `null`; REST возвращал 403 вместо 200; MCP возвращал `ACTION_FORBIDDEN` для задачи и `NOT_FOUND` для серии. Лог: `baseline.log`. Первые failing assertions проверяют переименование задачи и паузу серии без `projectId`. Позже тест дополнен проверками MCP receipt replay.
2. После изменения DB-проверок тот же regression — exit 0, **6/6 PASS**, лог `regression.log`. Итоговая версия с replay дополнительно включена в полный gate ниже.
3. Первый browser regression обнаружил реальную потерю названия проекта в карточке: оба callers загружали только активные проекты. После исправления загрузок и корректировки harness — exit 0, **2/2 PASS**, `browser-regression-pass.log`.
4. Итоговый `npm run test` — exit 0: **42 unit + 25 API/DB/isolation**, skipped/cancelled/fail 0. Лог `verified-test.log`.
5. `node --import tsx --test apps/api/test/issue-url.test.ts` — exit 0, **1/1 PASS**, лог `verified-issue-url.log`.
6. `npm run lint`, `npm run typecheck`, `npm run build` — каждый exit 0. Логи `verified-{lint,typecheck,build}.log`.
7. Полный production browser gate — **230/230 PASS** (shards: 78, 140, 12), каждый exit 0; skipped/flaky/unexpected 0. Проверены все 230 уникальных test IDs: объединение shards точно совпадает с полным discovery, пропусков и дублей нет. На протяжении каждого shard неизменны все 113 source/manifests файлов. JSON reports: `verified-browser-{1,2,3}.json`, команды и exit receipts: `browser-exits.json`. Сводка и hashes находятся в source/build manifest.
8. `git diff --check` — exit 0; повторяется при сборе manifest.

Штатный browser runner: `npm run screenshots -w @task/web -- --shard=N/3 --reporter=line,json`, N=1,2,3. `browser-gate.py` явно задаёт изолированную `TEST_DATABASE_URL`, `NODE_ENV=production`, JSON output и отдельный `PERF_EVIDENCE_DIR`. Source hashes проверяются до и после каждого shard. `collect-evidence.py` проверяет exit status, отсутствие skipped/flaky/unexpected, уникальность ID и совпадение объединения shards с полным `--list`.

## Критерии приёмки

| Критерий | Текущее доказательство |
| --- | --- |
| Задача архивного проекта переименовывается и меняет status без принудительной смены проекта | DB/REST/MCP: title edit, done, reopen member-ом; DB readback. Browser 390/320 px: autosave, reload, открытие из списка, завершение |
| Связанная серия редактируется, ставится на паузу и архивируется | DB/REST/MCP: pause, archive, restore/resume, schedule/content edits; creator/assignee разрешены, посторонний member отклонён. Browser: реальный PATCH паузы и повторное чтение |
| Новые назначения в архивный проект запрещены | Через каждый transport: create task/recurrence отклонён; перевод из активного проекта и из `null` в архивный отклонён; число строк не меняется |
| Исторические связь и название сохранены; снятие/смена допустимы | Omitted/same/uppercase UUID, raw DB, REST projects и MCP readback; browser показывает имя, но не предлагает архивный проект для назначения; active/null работают |
| REST/MCP сохраняют version/access/read-only поведение | Stale version, outsider, cross-board target/project, чужой assignee, draft/frozen/archived board, archived task, read-only MCP; snapshot row/audit/outbox/receipts до и после отказа совпадает |
| Повторы и sibling callers не ломаются | `scope=future` сохраняет архивный проект задачи и шаблона; browser проверяет явное применение. MCP replay сохраняет точный snapshot без дублирования эффектов. Полный API suite включает lifecycle, isolation, checklist, blockers, deadlines, backlog, publications, settings, recurrence rollback и MCP |
| Автоматическая и внешняя приёмка разделены | Локальные синтетические DB/API/MCP/browser проверки не являются Telegram-device или production smoke |

## Диагностированные неуспешные прогоны

- Первый запуск PostgreSQL не смог создать Unix socket: путь workspace превышал 103 bytes. Кластер успешно запущен на loopback TCP с отключёнными Unix sockets; production настройки не менялись.
- В browser harness задача без assignee отсутствовала в default «Мои задачи» после закрытия deep link. Fixture исправлена назначением синтетическому владельцу; product filters не менялись. На 320 px открытое меню перекрывало status control; сценарий теперь явно закрывает меню перед выбором статуса. Таймауты не увеличивались, force-click не применялся.
- Монолитный полный browser run прерван лимитом инструмента 420 секунд на шаге 211/230, без завершённого report и exit status. Это **не PASS**. Дополнительно root npm-wrapper поглотил reporter argument без второго `--`; итоговые shards вызывают workspace script напрямую.
- Один параллельный terminal и первый background runner не унаследовали `TEST_DATABASE_URL`. Unit-часть прошла, isolation не стартовал; browser discovery отказал до выполнения тестов. Итоговые команды и runner передают окружение явно; эти setup failures не объявляются product failures.
- Прерванный browser run добавил текущие performance-измерения в исторический tracked `input-perf.jsonl`. Копия сохранена в runtime, исторический файл восстановлен; итоговый runner пишет measurements в отдельную task-папку.
- `npm ci` сообщил четыре advisory (2 moderate, 2 high) при неизменённом lockfile. Dependency remediation не входит в #149; отсутствие уязвимостей не заявляется.

## Непроверенная граница и closeout

- Telegram iOS/Android/Desktop, реальные аккаунты, provider/live delivery, production и deploy не проверялись. Browser emulation и SDK loopback не заменяют эти gates.
- Известный по parent #140 development StrictMode baseline не исправлялся; текущая browser-приёмка использует `NODE_ENV=production`. Development StrictMode PASS не заявляется.
- Для device smoke использовать точный source/build manifest: архивировать синтетический проект с задачей и серией; открыть задачу из списка и deep link, проверить имя; изменить title/status и перечитать; явно применить к серии; поставить серию на паузу; проверить снятие/смену проекта и отсутствие архивного проекта в новых назначениях. Повторить на iOS/Android/Desktop, включая клавиатуру и восстановление сети. Этот checklist остаётся непроверенным.
- После локальной реализации пользователь вызвал `/taskfinish`, разрешив commit/PR/merge и closeout #149 с обновлением parent #140. Перед публикацией повторно сверены все source/build/evidence hashes; свежий `origin/main` совпадает с базой проверок. Неизменённые suites не перезапускаются ради повторения результата.
- Deploy не разрешён. #150 не запускается; parent #140 остаётся открытым. Для Хаба выбран `weekly`: прогресс программы и evidence остаются в GitHub без отдельного журнала и без заявления о production-доступности. Хаб, Telegram/Kanban и план дня не изменяются.
