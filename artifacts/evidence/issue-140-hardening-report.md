# #140 — зависимости и performance: итоговая локальная проверка

## Результат

Локальный пакет завершён. Четыре npm advisory entries устранены обновлением пяти записей lockfile. Причина лишней работы при вводе воспроизведена отдельной регрессией и исправлена: невидимые списки больше не создают карточки и не форматируют их дедлайны.

На итоговых исходниках полный browser-набор прошёл **238/238 в NODE_ENV=production и 238/238 в NODE_ENV=development**, без skips, failures и retries. Результаты не собраны из успешных повторов отдельных упавших тестов: все шесть исходных shards этого этапа завершились exit 0. Предыдущие исправления согласия на уведомления и StrictMode autosave сохранены и входят в эти прогоны.

Этот отчёт обновляет локальный статус advisory/performance из `issue-140-acceptance-fixes-report.md`. Предыдущие отчёты остаются историческими snapshots, а не текущим списком блокеров.

## Версия и границы

- Проверено 2026-09-30; завершение агрегации 14:55 UTC.
- Ветка: `MilevskyYakov/issue-140-acceptance-fixes`.
- Base и remote main при завершении: `9b7b31746321c2bc8e3473bf5dac8aa95b7ed071`.
- SHA-256 рабочего diff: `d53be68fdb6071ebe592eeaa1b56bd8eee00c65507ed2776c437fdeb024d44e9`.
- Хеши 100 входных файлов и сборки: `issue-140-hardening-verification.json` рядом с отчётом.
- Новые изменения этого этапа: `package-lock.json`, `apps/web/src/main.tsx`, `apps/web/visual/input-perf.spec.ts`; предыдущие изменения не отменены.
- Raw evidence и runners: `artifacts/evidence/issue-150-runtime/issue-140-hardening/` (ignored, локально).
- Node 22.22.3 / npm 10.9.8; Node runtime не обновлялся. Commit, push, PR, merge, deploy и внешняя синхронизация не выполнялись.

## Зависимости

Выполнены `npm update undici brace-expansion fast-uri ip-address --package-lock-only --ignore-scripts --no-audit` и `npm ci --include=dev --no-audit`. Diff lockfile проверен программно: изменились только следующие записи, без новых packages, major bumps, правок manifests или unrelated refresh.

| Package | До | После |
|---|---|---|
| undici | 7.29.0 | 7.30.0 |
| brace-expansion | 5.0.9 | 5.0.12 |
| fast-uri под ajv | 3.1.7 | 3.1.8 |
| fast-uri | 4.1.4 | 4.2.1 |
| ip-address | 10.7.0 | 10.7.2 |

Установленные версии сверены с lockfile. Повторный `npm audit --json`: **0 vulnerabilities**, включая high/moderate. Это результат аудита npm dependency graph, не аудит всех компонентов Node или production environment.

## Performance: причина и минимальное исправление

`apps/web/src/main.tsx:534,556,568,602`: четыре списка строились до выбора отображаемого экрана. В форме создания они не попадали в DOM, но их `.map(...)` уже создавал элементы и вызывал `formatTaskDeadline`. StrictMode дополнительно увеличивал эту работу.

Регрессия `create typing does not format deadlines from hidden task lists` использует существующую fixture с 600 задачами и считает реальные вызовы `Date.prototype.toLocaleString` после открытия формы. Baseline: **1200** вызовов на одно изменение названия вместо ожидаемого нуля. Candidate: **0**, введённое значение сохраняется.

Списки стали локальными функциями и вызываются только в местах фактического отображения. Новых компонентов, зависимостей, caches, state или изменения DOM-разметки не добавлено. Проверка текущего файла против сохранённого pre-change snapshot подтвердила, что application delta этого этапа состоит только из отложенных объявлений и их вызовов. Связанные list/kanban/backlog paths проверены полным browser-набором.

Исходные параметры performance-сценария сохранены: 600 задач, 40 последовательностей кириллического ввода, исходный лимит 180 секунд и прежние assertions. Измеряется **input-to-next-frame**, не время физической отрисовки на реальном устройстве.

| Прогон create-title queue=600 | Events | p50 | Max | Long-task time |
|---|---:|---:|---:|---:|
| Целевой development, повтор 1 | 279 | 3 мс | 38 мс | 0 мс |
| Целевой development, повтор 2 | 279 | 3 мс | 40 мс | 0 мс |
| Целевой development, повтор 3 | 279 | 4 мс | 41 мс | 0 мс |
| Полная production-матрица | 279 | 3 мс | 9 мс | 0 мс |
| Полная development-матрица | 279 | 3 мс | 36 мс | 0 мс |

Три целевых повтора включают и новую детерминированную регрессию: суммарно 6/6 PASS. В отличие от предыдущего этапа, чистая полная development-матрица подтверждена на итоговой версии. Это локальный Chromium evidence, не гарантия задержки на всех устройствах.

## Проверки итоговой версии

- Unit: **42 PASS**; API/DB: **26 PASS**; issue URL: **1 PASS**. Без skips.
- Migrations, lint, typecheck, build, diff-check: PASS.
- Browser discovery: **238 уникальных сценариев**; каждый выполнен ровно один раз в каждой полной матрице. Production **238/238**, development **238/238**, без retries/skips/flaky.
- Dependency smoke: настоящий собранный API отдаёт HTML и оба build assets; `/health` обращается к изолированной PostgreSQL; unauthenticated API возвращает 401.
- Proxy smoke: native Node fetch через установленный `ProxyAgent`, локальный HTTP CONNECT proxy и локальный origin. GET/POST прошли; отказ proxy не привёл к обходу proxy и прямому запросу. Реальные Telegram endpoints и production proxy не использовались; production TLS не проверялся.
- `summarize.py` сверил inventory/discovery, все 16 стадий, source/diff hashes, установленные версии и audit. Все результаты относятся к неизменившимся application/test sources во время полного прогона.
- Изолированная PostgreSQL остановлена; порты 5499 и 4173 проверены закрытыми. Proxy/origin smoke закрывает свои listeners и dispatcher в `finally`.

## Что остаётся у #140

Локальные advisory/performance-блокеры этого пакета закрыты. Саму #140 пока не закрывать: изменения ещё не опубликованы/слиты, затем нужны отдельно разрешённые deploy, live MCP и Telegram iOS/Android/Desktop-проверки на фактически выложенном artifact. Физические устройства этим пакетом не проверялись.

Обновление npm undici не обновляет встроенный Node fetch; подбор/проверка production Node patch release остаётся отдельной runtime-границей. Отчёт не заявляет полную безопасность production runtime на основании `npm audit=0`.
