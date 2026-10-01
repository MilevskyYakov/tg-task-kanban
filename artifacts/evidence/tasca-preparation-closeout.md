# Таска — review и интеграционная проверка подготовленного пакета

## Версия и полномочия

Владелец разрешил актуализировать Issues, опубликовать проверенную правку и выполнить review/merge PR #166–167. Это не разрешение на deploy или изменение живого бота.

Проверенный кандидат: `6ebf1ab1cc49a599258e60cc784907c44ba1d12f`. PR #166 слит squash-коммитом `d08a1695965e3402ad1f7283daafb54d1c7e687a`; актуальный main интегрирован в ветку PR #167. Единственный конфликт package.json разрешён сохранением `test:public-entry` и `test:cutover`; после разрешения дерево было идентично дереву до интеграции. Новая проверка выполнена после интеграции. Дальнейшие коммиты evidence не меняют код; итоговый merge должен пройти сверку source hashes.

## Review

Review выполнено локально, без делегирования и без имитации независимого approval. Проверены:

- Лендинг используется только в состоянии outside; API/health/MCP/webhook и Mini App не подменяются HTML. CTA берёт текущий bot username из API, проверяет допустимый Telegram URL и честно показывает недоступность.
- Aliases включаются только явно. Host/Origin привязаны к одному разрешённому origin, управление ключами не становится cross-origin; wildcard, CORS и redirects не добавлены.
- Delivery key включает стабильную bot identity без секретной части токена; защита при concurrent/repeated/unknown результатах сохранена. Legacy-записи не присваиваются новому боту и не удаляются. Исправлен также соседний путь личных команд.
- Прежняя доска, имя, задачи, членство и права сохранены; активная доска не требует повторного запуска. Смена token secret или username того же bot ID не сбрасывает дедупликацию. Принятая картинка v0.7 не менялась.
- Новых зависимостей и миграций схемы нет. Source/asset manifest PR #166 сверён с его head. Готовность серверного сертификата отделена от подключения приложения.

Блокирующих замечаний к согласованной кодовой подготовке не осталось. Это не одобрение промежуточного deploy на старом боте: legacy receipt не содержит identity, новый launch link отзывает прежний, а старый webhook нельзя обрабатывать как события нового бота. Соответствующие live/rollback gates сохранены в runbook и Issues.

## Проверки итогового кода

| Проверка | Результат |
| --- | --- |
| `npm run test` | 70/70 PASS |
| `npm run lint`, `npm run typecheck`, `npm run build` | Все exit 0 |
| `npm run test:public-entry` | 1/1 PASS |
| `node --import tsx --test apps/api/test/issue-url.test.ts` | 1/1 PASS |
| Полная Playwright production-матрица | 243/243 PASS |
| Полная Playwright development-матрица | 243/243 PASS |
| `npm run test:cutover` | 1/1 PASS |
| Dump/restore отдельной локальной БД | 20 таблиц совпали; новая задача сохранена |

Browser inventories совпадают; skipped/flaky/unexpected/retries отсутствуют. Команда для каждого режима: `NODE_ENV=<production|development> PLAYWRIGHT_PORT=4193 npm run screenshots -w @task/web -- --reporter=json`. База — отдельная синтетическая loopback PostgreSQL `tasca_test_164`; боевые секреты не использовались. Для адресного rehearsal использована другая БД `tasca_rehearsal_164_closeout`, настоящий rollback build `98fb9fc`, реальные HTTP/Fastify/PostgreSQL/MCP SDK и тот же синтетический bot token. Данные после переключения и прежний MCP-ключ доступны после отката старого кода.

Первый фоновый запуск не получил TEST_DATABASE_URL и завершился до тестов с KeyError; он не используется как PASS. Повтор запущен с явным синтетическим loopback URL. Неуспешный первоначальный regression #164 отдельно сохранён в его отчёте. Пропуски и неподтверждённые exit codes не заменялись вымышленными результатами.

Dump: 65657 bytes, SHA-256 `9a6b5c4b05decc61759d47d7c4e88528f2379b3ac39ee93a059f3f2ea4b5d1f8`. Локальные database backups и raw logs не публикуются. Машиночитаемый отчёт `tasca-preparation-closeout.json` содержит 124 source hashes, полные browser inventories и таблицы сравнения синтетической БД. Raw evidence: `artifacts/evidence/tasca-preparation-runtime/167-closeout-*`.

## Что этим не завершено

#135/#136/#137/#140/#164/#138 и родитель #131 сохраняют непроверенные внешние критерии. Нужны реальные поля/аватар/Main Mini App/menu/webhook, полный rollback новой Telegram identity с рабочим входом, production PostgreSQL 17 backup/restore, Telegram devices, live MCP/delivery/restart и наблюдение. Старые Telegram-ссылки из переписки исключены владельцем из совместимости; сохранность данных и прежнего HTTP/MCP-origin не исключена. Финальный release/rollback пакет и GO согласуются отдельно.

Merge кода и синхронизация Issues не означают deploy. Хаб/Kanban не меняются; task-ветки, worktree и raw evidence не удаляются.
