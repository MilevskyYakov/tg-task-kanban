# Таска

Задачи для себя и команды в Telegram. Действующий вход — `@kairostask_bot`; новый бот и адреса не включаются автоматически при обновлении кода.

## Локальный запуск

Требования: Node.js 22+, Docker.

```bash
cp .env.example .env
# Заполнить BOT_TOKEN, POSTGRES_PASSWORD, DATABASE_URL, SESSION_SECRET и WEBHOOK_SECRET
docker compose up -d db
npm install
DATABASE_URL=postgres://task:***@localhost:5432/task npm run migrate
npm run dev
```

Web shell собирается командой `npm run build`; API слушает `127.0.0.1:2240`. В production приложение доступно через `https://task.kairos-ai.ru`.

## Проверки

```bash
npm run lint
npm run typecheck
npm run test:unit
TEST_DATABASE_URL=postgres://task:task@localhost:5432/task npm run test:isolation
npm run build
DATABASE_URL=postgres://task:task@localhost:5432/task npm run migrate
```

Интеграционный тест изоляции обязателен и падает без `TEST_DATABASE_URL`. Для полного browser/API/DB gate также запустите `npm run test:visual` с этой переменной. Используйте только отдельную тестовую PostgreSQL, заранее применив к ней миграции (`DATABASE_URL="$TEST_DATABASE_URL" npm run migrate`); не направляйте тесты или тестовые миграции в production.

Бэклог и быстрое добавление (#78): общая очередь `todo` без исполнителя, атомарное «Взять себе», серия задач с сохранением доски/проекта и вставка списка с безопасным повтором. Локальная проверка и границы: [`docs/issue-78-verification.md`](docs/issue-78-verification.md).

Направления чата (#176): несколько досок, подтверждённый общий состав, отдельный выбор досок для дневной и недельной сводок, доставка по частям без автоматического повтора при неизвестном результате. Проверки и граница миграции: [`docs/issue-176-verification.md`](docs/issue-176-verification.md). После миграции 017 прежний runtime несовместим; простой возврат старого image запрещён.

В списке «Доски чата» администратор может получить общую ссылку для уже подключённой группы и самостоятельно разместить её в Telegram. Ссылка не выдаёт доступ, не заменяет старые адресные ссылки и не вызывает отправку сообщения ботом.

Полный production runbook, backup/restore и pilot gate: [`docs/release-runbook.md`](docs/release-runbook.md) и [`docs/pilot-checklist.md`](docs/pilot-checklist.md). Release gate нового Telegram UX: [`docs/issue-37-release-gate.md`](docs/issue-37-release-gate.md).

Подготовка ребрендинга: [профиль и обучение бота](docs/tasca-bot-content.md), [адреса, совместимость и финальный cutover](docs/tasca-cutover-runbook.md). `PUBLIC_URL_ALIASES` по умолчанию пуст; после отдельного разрешения позволяет сохранить точные старые MCP origins без redirects. Шаблон `.env.example` не переключает действующие адреса. Для проверки маршрутов собранного лендинга: `npm run build`, затем `npm run test:public-entry` с изолированной `TEST_DATABASE_URL`.

## Telegram webhook

После production deploy зарегистрировать webhook с тем же `WEBHOOK_SECRET`:

```bash
curl --fail -X POST "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
  -H 'content-type: application/json' \
  -d "{\"url\":\"https://task.kairos-ai.ru/api/telegram/webhook\",\"secret_token\":\"$WEBHOOK_SECRET\",\"allowed_updates\":[\"message\",\"my_chat_member\",\"callback_query\"]}"
```

`/start` предлагает пошаговое обучение в личном чате и прямые входы в личные задачи, доску на двоих и доску для группы. `/help` повторно запускает обучение; «Помощь» в настройках приложения сохраняет инструкции Mini App. Для кнопок обучения webhook должен принимать `callback_query`; после изменения проверить `getWebhookInfo`. Применение webhook остаётся частью отдельно разрешённого deploy.

Боту нужны права читать состав чата для серверной проверки актуального статуса администратора. При первом подключении новой группы бот отправляет одно фото с подписью «Таска · {Название доски}», краткой инструкцией и кнопкой «Открыть задачи». Пользователь закрепляет сообщение сам. Новый общий `startapp`-токен ведёт на первичную настройку для администратора; для участника с доступом одна доска открывается сразу, несколько — через выбор доски этого чата. Адресные ссылки не выдают права: для нового участника нужно явное принятие приглашения. Старые адресные ссылки продолжают открывать свою доску, если доступ уже есть. Повторы webhook и повторная активация не меняют успешную ссылку; старые закрепы не мигрируют. Неопределённый результат отправки требует ручной проверки, а не автоматической повторной рассылки. Историческая проверка входа и Telegram device gate: [`docs/issue-80-verification.md`](docs/issue-80-verification.md); изменения поведения — в проверке #176.

## Production deploy

На сервере `/opt/tg-task-kanban`: создать `.env` по `.env.example`, добавить `POSTGRES_PASSWORD`, затем:

```bash
git pull --ff-only
docker compose build
docker compose up -d db
docker compose run --rm app node apps/api/dist/migrate.js
docker compose up -d
curl --fail http://127.0.0.1:2240/health
```

Секреты, `initData` и cookie не логируются. PostgreSQL не публикуется наружу.

## Подключение AI-клиента (MCP)

Задачи доступны из MCP-клиентов (Hermes и других) через `https://task.kairos-ai.ru/mcp` с персональным ключом. Ключ создаётся в приложении: **Аккаунт → Подключения → Добавить подключение** — выбрать название, свои доски и режим (только чтение или чтение и изменение). Полный ключ показывается один раз.

Подключение Hermes:

```bash
hermes mcp add task_kanban --url 'https://task.kairos-ai.ru/mcp' --auth header
```

Ключ сохраняется в `~/.hermes/.env` как `MCP_TASK_KANBAN_API_KEY`. Доступ отключается отзывом подключения в приложении в любой момент. Контракт инструментов, идемпотентность и границы: [`docs/issue-82-mcp-contract.md`](docs/issue-82-mcp-contract.md); поверхность включает карточки (полное редактирование, claim, архив, комментарии, чек-лист, вложения-ссылки), проекты и повторяющиеся задачи (создание, пауза, архив серии).
