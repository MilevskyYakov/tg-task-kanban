# Release runbook

Live cutover выполняется только после явного подтверждения владельца.

## 1. Подготовка

Требования: VPS с Docker Compose, HTTPS reverse proxy для `task.kairos-ai.ru`, доступ к BotFather и production `.env` вне Git.

```bash
install -d -m 700 /opt/tg-task-kanban/backups
cd /opt/tg-task-kanban
cp .env.example .env
chmod 600 .env
```

Заполнить `.env`. `POSTGRES_PASSWORD` и пароль внутри `DATABASE_URL` должны совпадать; использовать URL-safe значение. Сгенерировать секреты локально:

```bash
openssl rand -hex 32
```

Проверить без вывода значений:

```bash
test -s .env
git status --short
```

## 2. Backup и restore smoke

Перед миграцией:

```bash
cd /opt/tg-task-kanban
docker compose up -d db
docker compose exec -T db pg_dump -U task -d task -Fc > "backups/task-$(date -u +%Y%m%dT%H%M%SZ).dump"
test -s "$(ls -t backups/task-*.dump | head -1)"
```

Проверить последний backup в одноразовой БД, не затрагивая production:

```bash
backup="$(ls -t backups/task-*.dump | head -1)"
docker compose exec -T db createdb -U task task_restore_smoke
docker compose exec -T db pg_restore -U task -d task_restore_smoke --clean --if-exists < "$backup"
docker compose exec -T db psql -U task -d task_restore_smoke -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM boards;'
docker compose exec -T db dropdb -U task task_restore_smoke
```

## 3. Deploy и миграции

```bash
cd /opt/tg-task-kanban
git fetch --prune origin
git checkout main
git pull --ff-only
docker compose build
docker compose up -d db
docker compose run --rm app node apps/api/dist/migrate.js
docker compose up -d app
docker compose ps
curl --fail http://127.0.0.1:2240/health
curl --fail https://task.kairos-ai.ru/health
```

Миграции повторяемые; rollback кода не откатывает схему. Перед первой миграцией каждой версии backup обязателен.

## 4. Bot menu и webhook

В BotFather задать Menu Button URL: `https://task.kairos-ai.ru`. После явного подтверждения владельца:

```bash
set -a; . ./.env; set +a
curl --fail -X POST "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
  -H 'content-type: application/json' \
  -d "{\"url\":\"$PUBLIC_URL/api/telegram/webhook\",\"secret_token\":\"$WEBHOOK_SECRET\",\"allowed_updates\":[\"message\",\"my_chat_member\"]}"
curl --fail "https://api.telegram.org/bot$BOT_TOKEN/getWebhookInfo"
```

Не копировать ответы API в Issue: они могут содержать адреса и диагностические данные.

## 5. Smoke и диагностика

```bash
curl --fail https://task.kairos-ai.ru/health
docker compose logs --since=15m app
docker compose exec -T db psql -U task -d task -c \
  "SELECT status, attempts, next_attempt_at, left(coalesce(last_error, ''), 160) AS error FROM publication_runs WHERE status <> 'sent' ORDER BY next_attempt_at LIMIT 20;"
```

Логи не должны содержать tokens, cookie, `initData`, chat IDs или тексты задач. Telegram delivery failures проверять по `publication_runs.last_error`; наружу передавать только обезличенный тип ошибки и время.

## 6. Rollback

Если health или smoke не проходит:

```bash
cd /opt/tg-task-kanban
git checkout <previous-known-good-commit>
docker compose build app
docker compose up -d app
curl --fail http://127.0.0.1:2240/health
```

Если миграция повредила данные: остановить app, восстановить проверенный backup в новую БД, переключить `DATABASE_URL`, запустить app и повторить smoke. Не восстанавливать поверх production БД.

## 7. Restart gate

```bash
docker compose restart app
curl --fail http://127.0.0.1:2240/health
```

После restart проверить одну recurrence и один scheduled report: появились ровно один раз. Дедупликация хранится в БД; несколько процессов используют блокировки очереди.