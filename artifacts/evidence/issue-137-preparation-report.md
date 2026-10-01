# #137 — локальная подготовка адресов, rollback и restore

## Результат и границы

Подготовлены `PUBLIC_URL_ALIASES` (по умолчанию пуст), проверка допустимых origins и bot username, точные Host/Origin-проверки MCP. Текущие `PUBLIC_URL` и `BOT_USERNAME` не меняются. Между разрешёнными host не разрешается cross-origin управление ключами. CORS/wildcard/redirect не добавлены.

`docs/tasca-cutover-runbook.md` содержит old/new таблицу всех входов, разделение Telegram identity, процедуры GO/NO-GO/rollback/наблюдения, внешние поля, доступы и вопросы владельцу. README и общий release-runbook связаны с ним. Промежуточный deploy не выполняется.

Эта ветка содержит проверенную интеграцию с PR #166 (лендинг, `15e4e2d`) поверх main `98fb9fc` (бот, PR #165). PR подготовки адресов должен рассматриваться **после** #166; публичные defaults остаются прежними. Закрытие #137/#138/#140/#131 по этому локальному результату не разрешено.

## Реальная репетиция

`npm run test:cutover` с отдельной loopback PostgreSQL и `ROLLBACK_APP_MODULE`, указывающим на собранный настоящий код `98fb9fc`:

- Старая версия, затем кандидат на двух HTTP-origin, затем возврат к старой версии на той же БД.
- Реальные HTTP proxy/Fastify/PostgreSQL и Streamable HTTP MCP SDK; прежний ключ, права, user IDs и сессии. GET/POST/webhook проходят без redirect. Проверены неверные Host/Origin, чужие права и подпись другого бота.
- Задача создана через новый MCP endpoint после переключения. После возврата старого кода доступны обе задачи; действующий MCP-ключ и запрет постороннему сохранены.
- После rollback сделан dump и restore в другую локальную БД. Все **20 public tables** совпали по количествам и полным row fingerprints; задача после переключения сохранена. Dump: **66 799 bytes**, SHA-256 `135e2d113d5e4fd7b0d100b71817f475315463d7052d80da04fcf6e0bbe73ab1`.
- Локальная PostgreSQL **14.23 UTF-8** не заменяет production PostgreSQL 17 restore smoke. Результат не доказывает TLS, Telegram-device или новую bot identity. После отката на старый код проверен прежний origin; старый код не поддерживает aliases нового MCP-host.

Репетиционный тест сохраняет синтетические строки для restore; два первых неуспешных запуска остановились на ошибках тестового ожидания `isError` и отсутствовавшем `update_id`, до полного переключения. Исправлены проверки/валидный no-op payload, итоговый тест PASS. Restore включает все синтетические строки; дополнительно точно проверена единственная задача `After cutover`. Боевые токены и Telegram-сообщения не использовались.

## Итоговые локальные gates

Точный source manifest (122 файла), browser inventories и статистика — `issue-137-verification.json`.

- `npm run test`: **43 unit + 26 isolation**, 0 skipped/failed.
- `npm run lint`, `npm run typecheck`, production `npm run build`: PASS.
- `npm run test:public-entry`: PASS; маршруты и production assets.
- `node --import tsx --test apps/api/test/issue-url.test.ts`: 1 PASS.
- `npm run test:cutover`: 1 PASS.
- Полная browser-матрица: **243/243 production + 243/243 development**, одинаковые inventories, 0 skipped/flaky/retries/failures. Сохранены tests всех children #140, добавлены сценарии лендинга. Три shard в каждом режиме: 85 + 146 + 12.
- Команда: `NODE_ENV=<production|development> PLAYWRIGHT_PORT=4193 npm run screenshots -w @task/web -- --reporter=json --shard=N/3`, с отдельной `TEST_DATABASE_URL` и применёнными миграциями.
- MCP browser harness больше не привязан к порту 4173: API Origin, отображаемые адреса, clipboard и команды используют Playwright baseURL. Предварительный targeted run на 4193: 2 PASS; затем обе полные матрицы на том же порту.
- `npm audit`: 0 vulnerabilities; `git diff --check`: PASS. Lockfile и зависимости не менялись.

Источники: `issue-137-restore-verification.json`, `issue-137-external-readonly.json`, локальные сырые логи `artifacts/evidence/tasca-preparation-runtime/137-*`. Начальные неподтверждённые/неполные запуски не использованы как PASS.

## Открыто перед выпуском

1. #164: сравнить/выбрать bot identity. Новый token нельзя молча подставить вместо прежнего; Telegram-ссылки, DM, права чатов, `file_id`, дедупликация и расписания требуют отдельного решения.
2. Внешний TLS нового домена не проходит; доступ DNS/proxy/hosting и оператор не подтверждены.
3. Main Mini App/avatar, точные старые внешние fields, production runtime SHA и production backup/restore не проверены.
4. Telegram iOS/Android/Desktop, live MCP/client, реальная разрешённая доставка, restart и 24-часовое наблюдение остаются gates #140/#138.
5. Срок сохранения старых входов и точный пакет внешних изменений подтверждает владелец. Предложение — минимум 90 дней, без автоматического отключения.

Production DNS/TLS/proxy/token/username/webhook/menu/Mini App/MCP не изменялись. Хаб, Kanban и сообщения пользователям не менялись.
