# Telegram Task Kanban

Минимальный безопасный фундамент Telegram Mini App для `@kairostask_bot`.

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

Полный production runbook, backup/restore и pilot gate: [`docs/release-runbook.md`](docs/release-runbook.md) и [`docs/pilot-checklist.md`](docs/pilot-checklist.md). Release gate нового Telegram UX: [`docs/issue-37-release-gate.md`](docs/issue-37-release-gate.md).

## Telegram webhook

После production deploy зарегистрировать webhook с тем же `WEBHOOK_SECRET`:

```bash
curl --fail -X POST "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
  -H 'content-type: application/json' \
  -d "{\"url\":\"https://task.kairos-ai.ru/api/telegram/webhook\",\"secret_token\":\"$WEBHOOK_SECRET\",\"allowed_updates\":[\"message\",\"my_chat_member\"]}"
```

`/start` предлагает личные задачи, доску на двоих и доску для группы. `/help` и «Помощь» в настройках приложения повторно открывают инструкции.

Боту нужны права читать состав чата для серверной проверки актуального статуса администратора. При первом подключении новой группы бот отправляет одно фото с подписью «Задачи команды · {Название доски}» и кнопкой «Открыть задачи». Пользователь закрепляет сообщение сам. Его `startapp`-токен ведёт на первичную настройку для администратора, ожидание для участника, затем — прямо к задачам. Повторы webhook и повторная активация не меняют успешную ссылку; старые закрепы не мигрируют. Неопределённый результат отправки требует ручной проверки, а не автоматической повторной рассылки. Проверки, диагностика и Telegram device gate: [`docs/issue-80-verification.md`](docs/issue-80-verification.md).

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
