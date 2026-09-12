# #82 — локальная реализация и проверка

Ветка реализации: `MilevskyYakov/mcp`. Первоначальный этап выполнялся без деплоя и подключения к реальным задачам. Результаты ниже относятся к этому локальному этапу.

## Разрешение production-проверки

После локальных gates владелец отказался от отдельного тестового стенда и явно разрешил commit/PR/merge, backup/restore, миграцию и production deploy. Проверка ограничена специально созданными задачами. Рабочие задачи, действующий webhook и секреты не изменяются; destructive/fault-injection test suites не направляются на production. Полноценный Hermes smoke требует входа владельца и локального переноса ключа, не передачи в чат. Фактический результат релиза записывается в GitHub #82 после readback.

Для безопасной сборки добавлен `.dockerignore`: production `.env`, backups, Git metadata и локальные generated artifacts не передаются в Docker build context.

## Реализовано

- «Настройки / Аккаунт / Подключения»: имя, явный выбор досок, просмотр либо изменение, адрес сервера и однократный ключ. По умолчанию только чтение, доски не выбраны.
- Hash-only ключ без срока действия, управление только через web-сессию с проверкой Origin. Отзыв подтверждается повторным GET. Потерянный ответ создания не выдаёт второй ключ: прежний requestId возвращает metadata для отзыва.
- Stateless Streamable HTTP `/mcp`, SDK `@modelcontextprotocol/sdk` 1.30.0, семь инструментов согласованного контракта. Входные JSON schemas сохраняют необязательность полей с default. Read-only не получает write tools и не может вызвать их напрямую.
- Grant пересекается с действующим membership; его удаление атомарно удаляет grant. Возвращение участника и появление новых досок не расширяют прежний доступ.
- Общие `createTask`/`updateTask` принимают существующую транзакцию. Task, audit и receipt фиксируются вместе; повторы не перезаписывают последующее изменение из UI. DB revision меняется при UPDATE независимо от вызывающего пути.
- Проверка незавершённого чек-листа перенесена в общий transaction-aware путь после проверки прав и под board lock. Уведомления о снятии блокера используют существующий intent/dispatch; ошибка доставки не отменяет commit.
- 64 KiB body limit, bounded pagination, лимиты запросов, Origin/Host, no-store, отдельные безопасные diagnostic events. Ключ не хранится в browser storage и не попадает в query/path logs.

## Выполненные gates

Стенд: отдельный временный PostgreSQL 14.23 (Homebrew), UTF8; только синтетические пользователи и задачи. Миграция `012_mcp.sql` применена к новой тестовой БД. Production URL и credentials не использовались.

| Команда | Результат |
|---|---|
| `npm run test` с TEST_DATABASE_URL | 32 unit + 13 DB/integration, все прошли |
| `npm run test:visual` с TEST_DATABASE_URL | 51 браузерный тест, все прошли |
| `npm run lint` | прошёл; в этом проекте alias typecheck |
| `npm run typecheck` | прошёл |
| `npm run build` | web и API собраны |
| `npm audit --omit=dev` | 0 уязвимостей |
| `git diff --check` | прошёл |

`apps/api/test/mcp.test.ts` включён в корневой `test:isolation`, а не оставлен отдельным непрогоняемым файлом.

### MCP / DB

Настоящий SDK Client выполнял initialize, tools/list и calls по loopback HTTP, без подмены MCP transport. Проверены:

- read/write списки инструментов, actor isolation, чужая и невыбранная доска, новая доска после выдачи ключа;
- session/Bearer separation, CSRF, недопустимый Host, неверный protocol header, invalid JSON, 413 и 429 с Retry-After;
- одинаковые concurrent create intentions: одна задача и один created audit; другой payload с прежним requestId отвергается;
- сохранённый update receipt после последующего UI update, optimistic version conflict;
- date-only deadline, строгие ID, права завершения, цикл блокеров, Unicode description chunks и их version guard;
- keyset pagination с одинаковыми microsecond timestamps, изменение фильтров с прежним cursor;
- fault injection при INSERT receipt: task/audit откатываются вместе, после снятия fault повтор создаёт одну задачу;
- checklist mutation под удерживаемым board lock одновременно с MCP completion: незавершённый новый пункт требует подтверждения;
- настоящий MCP write ожидает board lock, удерживая connection lock; revoke ожидает его commit. После подтверждённого revoke ключ получает 401;
- membership removal запрещает task и receipt; rejoin не оживляет grant;
- ошибка Telegram delivery (явно подменённый внешний HTTP): задача сохранена, warning возвращается и при replay; notification intent и попытка не дублируются.

Скан финальных test/browser/build logs на полный формат plaintext MCP-ключа: 0 совпадений. После cleanup в тестовой БД осталось 0 MCP-подключений.

### UI

`apps/web/visual/mcp.spec.ts` использует настоящие API handlers и PostgreSQL; Telegram bootstrap подменён синтетической сессией. Проверены 390/320 px, пустой и загруженный список, отказ GET, выбор досок с отменой draft, radio defaults, pending/double submit, offline, таймаут до и после commit, потерянный ключ, повтор отзыва после потери ответа, clipboard failure/success, очистка секрета при известном истечении сессии, Tab/Shift+Tab/Escape и возврат focus. На 320 проверены короткий viewport и масштаб текста 200%.

22 runtime PNG находятся в `artifacts/visual-evidence/issue82/` (каталог исключён из Git существующим правилом). Secret block закрыт маской; trace/video/автоматические failure screenshots для этого suite отключены. Форма и выдача ключа сопоставлены с сохранёнными PNG UX-пакета; исправлены radio placement, chevron и лишний нижний отступ.

## Границы результата

Это проверенная локальная реализация, не закрытие всей #82 и не production-readiness:

- Полноценная пользовательская сессия Hermes с Telegram-входом не запускалась. SDK smoke не называется Hermes E2E. Точный порядок отдельной проверки остаётся в разделе 9 MCP-контракта; нужен согласованный тестовый аккаунт и перенос ключа владельцем в настройки клиента, не в чат.
- TLS/ingress, реальная Telegram-доставка, iOS/Android WebView и физическая клавиатура не проверены. Синтетический short viewport не заменяет device gate #83.
- Исходный `.pen` из предыдущего этапа всё ещё не подтверждён как сохранённый. Существующие PNG/PDF использованы как reference; редактор и чужие worktrees этим этапом не изменялись.
- In-memory rate limiter ограничен одним API-процессом. Перед несколькими экземплярами требуется общий ingress/limiter. SQL statement timeout — 10 s, lock timeout — 5 s.

## Повтор проверки

Создайте отдельную тестовую PostgreSQL БД с UTF8 (`initdb --encoding=UTF8 --locale=C` для временного кластера), задайте TEST_DATABASE_URL только для неё. Выполните `DATABASE_URL="$TEST_DATABASE_URL" npm run migrate`, затем перечисленные gates. Не направляйте эти тесты на пользовательскую/production БД: они создают и удаляют fixtures и временно добавляют fault-injection constraint.

Следующий внешний этап разрешён владельцем: production deploy после проверенного backup, затем пользовательский smoke Hermes/Telegram на специально созданных задачах. Локальные результаты не объявляют этот внешний этап выполненным.
