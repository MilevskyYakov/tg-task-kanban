# #150 — ограниченные SQL-страницы MCP collaboration

## Снимок локальной приёмки перед closeout

Этот отчёт фиксирует завершённую локальную приёмку в `MilevskyYakov/mcp-sql-audit` до commit, публикации PR/Issue и merge. Актуальный closeout и merge commit фиксируются в [Issue #150](https://github.com/MilevskyYakov/tg-task-kanban/issues/150); merge не означает deploy. База: `3d54e7a4d91f33eafe6d1a01008f9a834d0634ee`; при начале работы HEAD совпадал со свежим `origin/main`. Точная проверенная версия зафиксирована SHA-256 100 исходных файлов, конфигурации, миграций и контракта в [`issue-150-verification.json`](issue-150-verification.json). Хеши проверены до и после итоговых gates. Исторические отчёты не использовались как текущие PASS.

## Изменение

- `apps/api/src/db.ts`: существующий `taskCollaboration` принимает необязательные границы двух потоков. В режиме страниц каждый SELECT возвращает максимум `limit + 1` строк; события выбираются без `before_data`/`after_data`. Без параметра страницы поведение REST и mutation/replay сохранено.
- `apps/api/src/mcp.ts`: сохранён ID-only cursor `{tag, after}`. Сервер находит одну доступную запись границы, читает `created_at` текстом с точностью PostgreSQL и применяет keyset по `(created_at, id)`. JavaScript Date не участвует в вычислении границы. Лимиты, DTO и ошибки не меняются.
- `apps/api/test/mcp.test.ts`: добавлена проверка через настоящий HTTP/SDK и изолированную PostgreSQL. Наблюдатель SQL вызывает исходный драйвер, не подменяет ответы; проверяет реальные row counts, колонки и LIMIT.
- Дополнен существующий контракт `docs/issue-82-mcp-contract.md`. Новых библиотек, миграций или pagination-framework нет. `package-lock.json` не изменён.

## Окружение и воспроизведение

По отдельному разрешению выполнен `npm ci --include=dev` (exit 0). Node.js 22.22.3, npm 10.9.8, PostgreSQL 14.23 Homebrew. Новый тестовый кластер: `artifacts/evidence/issue-150-runtime/postgres`, БД `issue150`, UTF-8 / `en_US.UTF-8`, только TCP `127.0.0.1:5499`, Unix sockets отключены. Применены существующие штатные миграции через `DATABASE_URL=postgresql://issue150@127.0.0.1:5499/issue150 npm run migrate` (exit 0). Production, реальные пользовательские данные и чужие worktrees не использовались.

До изменения owning implementation запущен новый regression test:

`TEST_DATABASE_URL=postgresql://issue150@127.0.0.1:5499/issue150 node --import tsx --test --test-name-pattern='MCP collaboration SQL pages' apps/api/test/mcp.test.ts`

Ожидание: SQL выбирает не более 38 строк комментариев при `commentLimit=37`. Факт baseline: exit 1, `task_comments: selected 1024 rows for limit 37`. После исправления тот же сценарий прошёл (exit 0). Затем тест дополнен диагностикой и проверкой отзыва grants и включён в итоговую полную API/DB suite.

Логи, PostgreSQL data и воспроизводимый runner `verify.py` сохранены в ignored-каталоге `artifacts/evidence/issue-150-runtime/`; ключевые результаты и хеши логов вынесены в verification JSON. После проверок созданный кластер остановлен через `pg_ctl -m fast -w stop` (exit 0), закрытие TCP 5499 подтверждено отдельной проверкой. Чужие процессы не останавливались.

## Итоговые проверки

Runner явно передавал тестовый URL и `NODE_ENV=production`; команды завершились с exit 0:

| Команда | Фактический результат |
|---|---|
| `npm run test` | 42/42 unit и 26/26 API/DB/isolation; fail/skipped/cancelled 0 |
| `node --import tsx --test apps/api/test/issue-url.test.ts` | 1/1 PASS |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm run screenshots -w @task/web -- details.spec.ts mcp.spec.ts completion.spec.ts project-archive.spec.ts --reporter=line,json` | 65/65: details 51, MCP 2, completion 10, project-archive 2; skipped/flaky/unexpected 0; reporter errors отсутствуют |
| `git diff --check` | PASS |

Browser JSON проверен программно: 65 уникальных случаев, перечисленные результаты совпадают с итоговыми totals. Это релевантные browser regression suites, не полный visual gate приложения. Telegram bridge в browser тестах синтетический; часть сценариев использует реальный локальный API/DB, часть — mocks. Это не device/provider PASS.

## Приёмка и ресурсный предел

1. **Ограниченное чтение.** Первая страница фактически выбрала 38 строк комментариев для лимита 37 и 42 строки событий для лимита 41. Комментарии: `id, body, created_at, author_user_id, author_name`; события: `id, action, created_at, actor_name`. `before_data`/`after_data` не выбирались. Для каждого запроса полного обхода проверены SQL LIMIT, не более `limit + 1` возвращённых строк и не более одной дополнительной записи границы на поток.
2. **Полный readback.** 1024 комментария и 1027 событий прочитаны за 28 запросов; последовательности ID точно совпали с контрольными SQL SELECT в порядке `(created_at, id)`, без дублей и пропусков. Synthetic seed содержит одинаковые timestamps, различия в одну микросекунду и большие before/after descriptions по 8000 символов. Дополнительно реальные `createTask`/`updateTask` создали штатные audit snapshots.
3. **Cursor и limits.** Проверены defaults 50, максимум 100, размер 1, смена лимита, пустые и последние страницы, legacy encoding, разные tags, malformed JSON/UUID, неизвестная/удалённая граница и граница другой задачи. Сохранены `INVALID_CURSOR`, `INVALID_ARGUMENT` и приоритет `NOT_FOUND` для недоступной задачи.
4. **Новые записи.** После уже прочитанной границы новые комментарий и событие доступны продолжению; запись перед границей не вставляется задним числом в продолжение. Это live keyset, не snapshot между страницами. Модель явно описана в контракте.
5. **Безопасность.** Проверены чужая доска, чужая задача, read-only connection, архивная задача, frozen/archived board, отзыв grant и membership между страницами. DTO не раскрывает Telegram file IDs, raw audit fields или MCP audit identifiers. Audit UPDATE по-прежнему отвергается append-only trigger.
6. **Соседние пути.** REST возвращает полную историю с audit snapshots и прежние attachment fields; outsider получает 404. Полные checklist/attachments в MCP сохранены. Существующая API/DB suite проверяет мутации, retries, replay, права, isolation, blockers, deadlines и архив проекта. Browser suites проверяют связанную карточку, завершение, подключения и историческую связь проекта.

## Границы и внешняя приёмка

- Доказан предел выбранных и переданных приложению rows/columns. Численное ускорение, peak RSS и постоянное число просканированных PostgreSQL строк не измерялись и не заявляются. Существующие индексы не менялись.
- REST и mutation/replay продолжают использовать полную collaboration-выборку; эта задача ограничивает именно `get_task_collaboration`. Checklist/attachments не пагинируются по принятому scope.
- `npm ci` сообщил 4 advisory (2 moderate, 2 high) при неизменном lockfile. Dependency remediation не входила в #150; отсутствие уязвимостей не заявляется.
- Production benchmark, реальный Telegram/provider smoke, merge и deploy не выполнялись. Полный UI-suite и development StrictMode не проверялись этим прогоном.
- Для внешнего gate использовать точную исходную версию из `issue-150-verification.json` и отдельно зафиксировать разрешённый deployed commit/build; локальный build без commit не объявляется deployed.

Непроверенный внешний checklist (только после отдельного разрешения):

- [ ] Telegram iOS: открыть карточку, проверить комментарии/историю/чек-лист/вложения и чтение архивной задачи.
- [ ] Telegram Android: повторить тот же сценарий на зафиксированном build.
- [ ] Telegram Desktop: повторить тот же сценарий на зафиксированном build.
- [ ] Разрешённый live MCP/provider: пройти обе последовательности страниц, подтвердить права read-only и отказ после отзыва доступа.

На момент локальной приёмки Issue #150 и parent #140 не закрывались. Последующий `/taskfinish` разрешает repository closeout #150; parent #140 остаётся открытым для общей приёмки. Судьба записи — `repo-only`: изменение внутреннего способа SQL-чтения без изменения пользовательского контракта или production-состояния. Хаб, Telegram/Kanban и план дня не меняются. Следующая задача автоматически не запускается.
