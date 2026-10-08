# Telegram: исходящий приём вместо входящего webhook

**Граница #176:** если применена миграция `017_chat_directions.sql`, возврат прежнего приложения по историческому image ID запрещён без доказанной совместимости. Транспортный rollback сам по себе не доказывает совместимость схемы и chat lifecycle. См. [проверку #176](issue-176-verification.md); production в рамках #176 не менялся.

Применяется к Таске после явного разрешения владельца на исправление доставки. Не является разрешением на другой deploy. Старый бот, схема БД, nginx и общий исходящий proxy не меняются. Сам приёмник не требует перезапуска app; отдельное исправление исходящего CONNECT применяется в app через управляемый выпуск и один перезапуск.

## Устройство и границы

`ops/telegram-poller.mjs` запускается отдельным контейнером из уже проверенного application image. Он не запускает server.js, расписания или отправку сообщений. Через существующий `TELEGRAM_API_PROXY` получает `getUpdates`, затем передаёт исходный JSON в прежний защищённый `/api/telegram/webhook` по внутренней Docker-сети. Исходящая отправка и дедупликация остаются в единственном приложении.

`ops/telegram-transport.mjs` — общая настройка транспорта app и приёмника. Частично недоступные TCP-соединения раньше удерживали CONNECT до 30 секунд. Теперь только внутренний CONNECT-dispatcher имеет `headersTimeout=1500` мс и не более восьми повторов установления туннеля. Bot API POST в RetryAgent не оборачивается: после отправки данных повтор запрещён, неопределённый исход остаётся `uncertain`. TLS verification не отключается. Проверка `ops/telegram-transport.test.mjs` воспроизводит зависший CONNECT и потерянный ответ после принятого POST: соединение повторяется, сам POST — нет. Общий proxy и его клиенты не перенастраиваются.

Подтверждение Telegram происходит следующим `getUpdates(offset)` только после HTTP 200 и корректного JSON-ответа приложения для всей предыдущей пачки. HTTP 200 с `uncertain` или ошибкой callback сохраняет прежний запрет автоматической повторной отправки. При транспортной ошибке обновления не подтверждаются. После перезапуска последняя неподтверждённая пачка повторяется через существующую DB-дедупликацию. Отдельная БД или файл offset не нужны: подтверждения хранит Telegram. Отрицательные offset и сброс очереди запрещены.

При ошибке авторизации, конфликте потребителей или оставшемся webhook приёмник блокируется без попытки переопределить чужой transport. Health-check становится красным. Нельзя запускать второй poller с тем же токеном. Логи содержат только время, тип события, числовой статус и результат обработки, без Telegram payload, идентификаторов чатов и секретов.

## Перед запуском

1. Проверить актуальные app image, StartedAt, health, Docker network, bot identity и текущие webhook options/menu. Сохранить приватный snapshot для обратной операции. Для текущего пакета эти действия выполняет `poller-bot.py snapshot` в защищённом каталоге evidence; значения credentials не выводятся.
2. Запустить `node ops/telegram-poller.test.mjs`, `npm run test`, `npm run lint`, `npm run typecheck`, `npm run build` с отдельной синтетической БД для integration-тестов. Запуск тестов против production запрещён.
3. Доставить `compose.telegram-poller.yaml`, `ops/telegram-poller.mjs` и `ops/telegram-transport.mjs` в соответствующие пути `/opt/tg-task-kanban`; проверить SHA-256. Не перезаписывать существующий файл неизвестного происхождения. Оба `.mjs` монтируются read-only в `/app/ops/`; user `1000:1000` должен иметь право чтения. Для app общий модуль включается Dockerfile в image.
4. Создать root-only `runtime.env` с **только** `BOT_TOKEN`, `BOT_USERNAME`, `WEBHOOK_SECRET`, `TELEGRAM_API_PROXY` из разрешённой действующей конфигурации. Пароль БД и session secret приёмнику не нужны. Отдельный `deploy.env` задаёт `TASCA_POLLER_IMAGE` (immutable локальный image ID), `TASCA_POLLER_ENV_FILE` (абсолютный путь к runtime.env) и `TASCA_NETWORK` (существующая сеть приложения).

Для пакета #138 управляющие файлы располагаются в `/opt/tg-task-kanban/releases/issue-138-20261002t054608z/poller/`. Переменная `DEPLOY_ENV` ниже указывает на `deploy.env` в этом каталоге.

```sh
cd /opt/tg-task-kanban
DEPLOY_ENV=/opt/tg-task-kanban/releases/issue-138-20261002t054608z/poller/deploy.env
docker compose --env-file "$DEPLOY_ENV" -p tg-task-kanban-ingress -f compose.telegram-poller.yaml config --quiet
docker compose --env-file "$DEPLOY_ENV" -p tg-task-kanban-ingress -f compose.telegram-poller.yaml run --rm --no-deps telegram-poller node /app/ops/telegram-poller.mjs --probe
```

Probe проверяет настоящие Bot API identity, TLS и доступ к обработчику с секретом. Он не вызывает `getUpdates` и не отправляет сообщения. Пустой JSON должен получить 400, неверный секрет — не приниматься.

## Переключение и проверка

1. Выполнить только `deleteWebhook(drop_pending_updates=false)` для нового бота. Прочитать `getWebhookInfo`: `url` должен стать пустым, очередь сохранена. При неопределённом ответе сначала readback, не повторять mutation вслепую. Для пакета #138 используется `poller-bot.py disable`.
2. Запустить единственный consumer:

```sh
docker compose --env-file "$DEPLOY_ENV" -p tg-task-kanban-ingress -f compose.telegram-poller.yaml up -d --no-build --wait --wait-timeout 100
```

3. Проверить health приёмника, отсутствие retry/blocked, прежний app image/StartedAt, оба публичных HTTPS-origin. Проверить одну новую команду через настоящий пользовательский Telegram-клиент и получение ответа. Пустая очередь и mocked tests не заменяют эту проверку.
4. Проверить перезапуск только приёмника и команду, поступившую во время его остановки: доставка после старта, без дубля. Основной app и БД не перезапускать. Контролировать очередь и ошибки в ограниченном окне наблюдения.

В polling-режиме пустой webhook URL — норма, а `last_error_date` webhook не является текущей проверкой polling. Не вызывать старый `enable-new` при обычной диагностике: он переключит транспорт обратно. Не использовать дополнительный `getUpdates` как диагностический probe работающего consumer.

## Откат только транспорта

1. Остановить `telegram-poller` через тот же Compose project; проверить отсутствие работающего контейнера. Не удалять volume приложения или данные БД.
2. Восстановить `setWebhook` из снятого snapshot: тот же URL, `secret_token`, `allowed_updates`, `max_connections`, явно `drop_pending_updates=false`. Для пакета #138 используется `poller-bot.py restore`; он сначала проверяет остановку consumer.
3. Прочитать обратно точные webhook options и неизменный menu. Проверить обычные HTTPS/health и прежний app runtime. Неподтверждённые обновления остаются у Telegram; существующая дедупликация защищает от повторной обработки уже доставленной пачки.
4. Файлы приёмника можно оставить для повторной диагностики. Возврат к прежнему маршруту не означает устранения его сетевых задержек.

## Дальнейшие deploy

Для горячего исправления 2026-10-03 проверен двухфайловый overlay поверх прежнего image: изменён только `apps/api/dist/server.js`, добавлен `ops/telegram-transport.mjs`. Хеши остальных runtime-файлов, migrations, assets и lockfile совпали; environment до/после перезапуска совпал по приватному digest. Новый app image: `sha256:7fb7c02e6ce70cf7be78c80569d323fe81baddfa43c79af6efb8aa0440f22690`. Основной Compose закреплён на нём. Старый image `sha256:0db53e919752e9b1c3469e63468ffef197b3ad1cca725e240f3e342989519f81` сохранён, он же используется как Node/dependency runtime приёмника с проверенными bind-mounted модулями.

Перед заменой app создан `poller/before-transport.dump`, проверена читаемость архива; данные из него не восстанавливались, миграции не запускались. Прежний Compose сохранён как `poller/compose.before-transport.yaml`. При откате app вернуть этот Compose только после сверки текущего release и защиты от чужих изменений, выполнить `config --quiet` и `up -d --no-deps --no-build --wait app`, затем проверить фактический image, environment и health. DB volume сохраняется. Откат app и откат polling — разные операции: не включать webhook, пока работает consumer. Возврат старого image также возвращает прежнюю уязвимость к зависшему CONNECT.

Приёмник использует отдельный Compose project `tg-task-kanban-ingress`, внешний network приложения и не публикует порты. Обычное обновление app не должно создавать второй scheduler или consumer. При смене bot token/webhook secret обновить ограниченный runtime.env и пересоздать приёмник в управляемом окне; не копировать всю .env приложения. При удалении или переименовании сети сначала остановить приёмник. При обновлении его образа повторить probe и живую приёмку. Docker restart policy восстанавливает контейнер после перезапуска daemon; ошибку доставки нельзя считать исправленной только по состоянию `running`.
