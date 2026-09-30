# #140 — исправления после локальной приёмки

## Вердикт и границы

Два согласованных дефекта исправлены и проверены локально: согласие на уведомление больше не переносится на другое назначение; React StrictMode больше не останавливает действующую очередь автосохранения карточки. Аналогичный перенос согласия устранён в форме создания задачи.

Полное принятие #140 не заявляется. Остаются dependency advisories, непроверенные deploy/live MCP/Telegram devices и нестабильность одного performance-сценария в полном development-прогоне. Ни один из этих пунктов не скрыт успешными целевыми повторами.

- Дата проверки: 2026-09-30.
- Репозиторий: `MilevskyYakov/tg-task-kanban`.
- Ветка: `MilevskyYakov/issue-140-acceptance-fixes`.
- Base и проверенный remote main: `9b7b31746321c2bc8e3473bf5dac8aa95b7ed071`.
- Изменения не закоммичены, не опубликованы и не слиты. GitHub и Хаб не изменялись.
- SHA-256 рабочего diff: `a809759dc3029c6a14a2e9b47a14c85d8e855553a4a3d65cc5f243ba0ba62e42`.
- Финальные хеши 100 входных файлов, хеши сборки и результаты: `issue-140-acceptance-fixes-verification.json` рядом с отчётом.
- Raw evidence и исполняемые локальные runners: `artifacts/evidence/issue-150-runtime/issue-140-fixes/` (ignored; не опубликованы).

## Исправления

### F1. Согласие привязано к назначению

`apps/web/src/task-details.tsx:260`: общий путь принятия подтверждённого состояния сервера очищает уже использованное или отвергнутое согласие. Согласие для более нового назначения, выбранного во время предыдущего запроса, сохраняется.

`apps/web/src/task-details.tsx:459` и `apps/web/src/main.tsx:674`: смена исполнителя сбрасывает галочку. Повтор запроса того же назначения после ошибки не теряет явное согласие; независимые последующие правки не отправляют `notifyAssignee`.

Добавлены семь native Playwright-регрессий в существующие `details.spec.ts` и `create.spec.ts`: успешный ответ, ошибка до commit, потерянный ответ после commit, новое назначение при pending response, оба решения version conflict и смена исполнителя при создании. Baseline на исходном приложении воспроизводит обе проверенные ошибки переноса согласия; candidate проходит проверки. Реальные Telegram-уведомления не отправлялись.

### F2. Жизненный цикл автосохранения в StrictMode

`apps/web/src/task-details.tsx:358`: переиспользован подход отложенного disposal из settings edits. StrictMode setup/cleanup probe может отменить остановку только той же очереди. Cleanup другой задачи не отменяется. Общий `Autosave.stop()` и семантика сохранения не изменены.

Первичный результат проверен через существующий сценарий редактирования карточки, восстановление draft после reload и реальные API/DB-записи. Дополнительно прошли сценарии ошибок, конфликтов, reconnect, read-only и изоляции аккаунтов.

## Проверки и честный учёт повторов

| Проверка | Результат |
|---|---|
| Unit | 42 PASS, без skips |
| API/DB | 26 PASS, без skips |
| Issue URL | 1 PASS |
| Lint, typecheck, build | PASS; lint/typecheck повторены после изменения harness |
| Production browser, полный discovery | 237/237 PASS, без skips и автоматических retries |
| Первичный development browser | 233/237 PASS; четыре неуспеха сохранены в исходных отчётах |
| Целевые регрессии development | 8/8 PASS |
| Исправленные API/DB и MCP harness, production | 3/3 PASS |
| Исправленные API/DB и MCP harness, development | 3/3 PASS |
| Изолированный performance-контроль baseline/candidate | По одному PASS, исходный лимит 180 секунд сохранён |
| Diff/manifest/dependency scope | PASS; runtime application sources не менялись после полного прогона |

После объединения полного набора с явно учтёнными целевыми повторами каждый из 237 сценариев имеет положительный результат в обоих режимах. Это **не** означает чистый единичный полный development-прогон и **не** доказывает его стабильность.

После полного прогона менялись только два test harness:

1. `details.spec.ts:379`: длинный сценарий содержит несколько reload и последовательные debounced DB writes. Первичный прогон исчерпал общий бюджет 30 секунд на последнем сохранении. Бюджет всего сценария поднят до 60 секунд; отдельные проверки сохранения и их пятисекундный лимит не ослаблены. Development-повтор прошёл за 30 877 мс, production — за 26 952 мс.
2. `mcp.spec.ts:34,76`: synthetic list failure теперь действует до явного шага восстановления перед кнопкой «Повторить». Раньше StrictMode probe расходовал одноразовый сбой первым GET, а второй GET успешно загружал список, поэтому ожидаемая ошибка исчезала. Код приложения MCP не изменялся; оба viewport прошли повтор в обоих режимах.

Одна техническая попытка повторного прогона не дошла до приложения из-за неверной локальной DB role. Эти результаты сохранены отдельно с `.setup-attempt`; последующие прогоны используют точный URL из основного runner. Они не засчитаны как дефекты приложения или успешные тесты.

## Оставшаяся неопределённость performance

В полном development-прогоне `create title input latency, queue=600` достиг лимита 180 секунд во время `keyboard.type`. Лимит, число строк ввода, размер очереди и assertions performance-теста не менялись.

Изолированные повторы того же сценария прошли и на исходном main, и на candidate. Baseline получен из точных Git blobs двух изменённых application modules и подставлен Vite transform до компиляции; остальные application sources и зависимости совпадают. Полнота экспортированных blobs проверена побайтово. Первичная усечённая попытка экспорта не использовалась в тесте.

| Изолированный development-сценарий | Events | p50 input-to-next-frame | Max | Long-task time |
|---|---:|---:|---:|---:|
| Baseline main | 279 | 47 мс | 1657 мс | 43 185 мс |
| Candidate | 279 | 50 мс | 1395 мс | 128 678 мс |

Один baseline/candidate pair не доказывает эквивалентность производительности. Разница long-task time существенна, причина не установлена. Не заявляются ни исправление performance-проблемы, ни доказанная новая регрессия. Широкая оптимизация формы создания в этот пакет не включена; для закрытия этой границы нужна отдельная контролируемая диагностика нагрузки и повторяемости.

## Dependency advisories

Повторный `npm audit --json`: **4 entries — 2 high, 2 moderate**, все в production dependency graph. Пакеты, manifests и lockfile не менялись; ни один advisory не снят и не объявлен false positive.

- `undici` 7.29.0, high: прямой API dependency, `ProxyAgent` используется при настроенном Telegram proxy. Доступна 7.29.1 вне диапазонов текущего audit. Прямые вызовы WebSocket, RetryAgent/RetryHandler, cache/dump/decompress interceptor и BalancedPool в приложении не найдены; это не доказательство безопасности всей сетевой цепочки.
- `brace-expansion` 5.0.9, high: `@fastify/static / glob / minimatch`. Приложение передаёт фиксированный build root; прямой путь пользовательского ввода к brace pattern не найден. Доступна 5.0.12.
- `fast-uri` 3.1.7 и 4.1.4, moderate: Ajv и инфраструктура JSON schemas. Пользовательские ссылки приложение разбирает native URL/Zod; произвольные schemas не загружает. Доступны исправленные 3.1.8 и 4.1.5; нужны обе major-ветки.
- `ip-address` 10.7.0, moderate: транзитивно через MCP SDK / express-rate-limit. Выбранная интеграция использует Fastify StreamableHTTP transport и собственный limiter, а не Express helper. Доступны 10.7.1 и 10.7.2 вне текущих affected ranges.

У Node 22.22.3 встроен undici 6.24.1. Обновление npm-пакета не обновляет встроенный Node fetch; оценка Node patch release — отдельная runtime-граница.

Источники: `npm-audit.json`, `dependency-paths.json`, `advisory-update-candidates.json` и `advisory-assessment.md` в raw evidence. Production configuration и secrets не читались, exploit-трафик не отправлялся.

Следующий dependency-пакет после согласия: целевое обновление lockfile в разрешённых semver ranges, без `--force`, major bumps и unrelated refresh; затем audit, unit/API/DB/MCP, build/typecheck, static serving и безопасный proxy smoke. Audit=0 до выполнения не обещается.

## Воспроизведение и завершение

Основной runner `verify.py` сохраняет команды каждой стадии в `results.json`; три browser shards запускаются отдельно для `NODE_ENV=production` и `NODE_ENV=development`. `recheck.py` повторяет только изменённые API/DB и MCP harness. Performance-повторы используют существующий `input-perf.spec.ts` с фильтром `create title input latency, queue=600` и отдельными именами evidence phases. `summarize.py` программно сверяет discovery, отсутствие дублей/пропусков, source drift и исходные неуспехи; не подменяет исходные отчёты результатами повторов.

Изолированная PostgreSQL остановлена; порты 5499 и 4173 проверены закрытыми. Runtime/deploy, live MCP и реальные Telegram iOS/Android/Desktop-проверки не выполнялись. Для #140 остаётся статус частичной приёмки, а не готовности к закрытию.
