# Issue #144 — независимые частичные правки и blocker-группа

## Проверенная ревизия

- Задача: https://github.com/MilevskyYakov/tg-task-kanban/issues/144.
- Ветка: `MilevskyYakov/issue-144`.
- Базовый commit: `f5979178439ced2848df3c5ecde177b7eb7ad532`.
- На момент первичного отчёта результат был локальным незакоммиченным diff поверх указанного commit. Последующий closeout описан ниже; фактические commit/PR/merge фиксируются в GitHub trail #144.
- Проверки итогового кода завершены 2026-09-29. Время фиксации evidence: `2026-09-29T11:41:12Z`.
- Точный source artifact: `artifacts/visual-evidence/issue-144/source.patch`, получен через `git diff --binary -- apps`; размер 66346 bytes, SHA-256 `ca45269c9141676d98ce18cf5292ca669c6aeb6bee251f108acc16d3ce4346c1`.
- Artifact содержит исходники и тесты, но не этот отчёт. После проверки production/test code не менялся.

Папка `artifacts/visual-evidence/` исключена из Git. Полный локальный путь к evidence: `/Users/milevsky.yakov/orca/workspaces/tg-task-kanban/issue-144/artifacts/visual-evidence/issue-144/`. При публикации PR следует приложить этот отчёт и указать итоговый commit; локальные ignored artifacts сами в PR не попадут.

## Окружение и границы

Node.js `v22.22.3`, npm `10.9.8`, PostgreSQL `14.23` (Homebrew), Playwright `1.59.1`, установленный Chromium. Новые зависимости не добавлены, manifests и lockfile не изменены. После разрешения пользователя выполнены `npm ci` и `npm ci --include=dev`: второй вызов установил dev-зависимости, которые пропускались настройкой окружения.

Создан отдельный PostgreSQL cluster внутри task workspace, слушавший только localhost:5499. Миграции применены только к выделенной тестовой БД. Использовались синтетические пользователи, доски, задачи и тестовые токены; production URL, реальные аккаунты и тексты не использовались. URL с реквизитами не включён в отчёт. `TEST_DATABASE_URL` в командах ниже означает только эту изолированную БД.

После всех проверок cluster остановлен: `pg_ctl ... -m fast -w stop` — exit 0; `pg_ctl ... status` — exit 3, `no server running`. Слушатели 5499 и 4173 отсутствуют. Данные и логи оставлены в workspace, не в OS temp.

## Reproduction на baseline

`reproduction.log` фиксирует вызовы настоящих builder и validator до изменения кода:

1. `issueUrl = owner/` вместе с валидным названием: builder выбрасывал ошибку ссылки и не возвращал независимый title PATCH.
2. Смена внешней причины у waiting-задачи: PATCH содержал `blockerTaskId`, `waitReason`, `waitCheckAt`, но не `status`; validator возвращал `blocker fields require waiting status`.
3. Та же правка причины включала преобразованный в полночь `waitCheckAt`, хотя пользователь дату не менял.

Исправленный baseline test run на отдельной UTF-8 БД: 39 unit tests (web и API) и 13 API/DB tests, без skipped. Это baseline, не доказательство исправления.

## Изменения

- `taskPatch` возвращает `{ patch, errors }`. Невалидные название, issue-ссылка и deadline-группа не подавляют независимые валидные поля. Status/blocker/reason/check date остаются одной группой.
- Ошибки показаны рядом с соответствующим вводом. Для текстовых полей и даты проверки добавлены `aria-invalid` и связь с текстом ошибки. Невалидный восстановленный deadline больше не обрушает компонент при построении label.
- Partial acknowledgement подтверждает только отправленные валидные группы. Невалидный соседний ввод остаётся в draft/localStorage после успешного ответа, восстановления потерянного ответа и разрешения version conflict.
- Пока есть локальная ошибка, UI не показывает «Сохранено» для всей карточки. Возврат невалидного значения к серверному без дополнительного PATCH снимает pending-состояние.
- Сохранён draft при возврате к исходному значению во время незавершённого запроса: ранняя очистка storage не теряет намерение пользователя.
- REST PATCH явно разрешает отложенную cross-field проверку blocker-группы. Под DB lock текущие и переданные значения проверяются существующим `taskInput`; отдельная копия canonical validator не введена.
- Для MCP и recurrence templates строгая предварительная валидация по умолчанию сохранена, включая `INVALID_ARGUMENT` для входа в waiting без блокера/причины. MCP adapter не переписан.
- Нетронутый `waitCheckAt` не включается в PATCH при смене причины/блокера. Выход из waiting очищает группу; самостоятельная правка title не отправляет чужие поля.

## Итоговые проверки

Все следующие результаты относятся к source artifact выше, а не к историческому evidence #129/#140. Каждая команда завершилась с exit 0, кроме отдельно указанного информационного dependency audit.

| Команда | Фактический результат | Лог в `artifacts/visual-evidence/issue-144/` |
| --- | --- | --- |
| `DATABASE_URL="$TEST_DATABASE_URL" npm run migrate` | Миграции применены к тестовой БД до проверок | `migrate.log` |
| `npm run test` | 41/41 unit (web и API), 15/15 API/DB; fail 0, skipped 0 | `final-test.log` |
| `node --import tsx --test apps/api/test/issue-url.test.ts` | 1/1, fail 0, skipped 0 | `final-issue-url.log` |
| `npm run lint` | PASS | `final-lint.log` |
| `npm run typecheck` | PASS | `final-typecheck.log` |
| `npm run build` | PASS | `final-build.log` |
| `NODE_ENV=production PLAYWRIGHT_PORT=4173 PERF_PHASE=issue-144-final PERF_EVIDENCE_DIR="$PWD/artifacts/visual-evidence/issue-144/perf" npm run test:visual` | 118/118, 3.6 min; без skipped; production React | `final-browser-verified.log` |
| `git diff --check` | PASS | Проверено через terminal |

SHA-256 итоговых полных логов:

- `final-test.log`: `6f04124c3a8a581fed09ad54ae7bf6bc58b4cb8fa9106db24c3d48d095e8d53a`.
- `final-browser-verified.log`: `dcb8e6bc0ffd5c79872e476c44c36dc2cf7e535ccc08aeb659ac010573c16886`.

### Проверенные сценарии

| Требование | Проверка / фактический результат |
| --- | --- |
| Неполная ссылка не блокирует название/описание | Builder regression и browser с реальным API/DB: валидные значения сохранены, серверная ссылка осталась прежней, `owner/` сохранился после reload. |
| Пустое название не блокирует независимую правку | Реальный API/DB: описание сохранено, последнее серверное название не заменено пустым; пустой локальный ввод восстановлен после reload с ошибкой. |
| Невалидная deadline-группа не блокирует title | Builder regression и browser с восстановленным некорректным datetime: title отправляется отдельно, deadline-поля не отправляются, ошибка видима. |
| Сохранность draft при partial acknowledgement | Synthetic browser scenarios: success, потерянный ответ, конфликт с выбором локальной и серверной версии; ошибки и невалидная ссылка остаются локально. Отдельная проверка возврата title к базе во время in-flight запроса. |
| Редактирование существующей waiting-задачи | Реальные REST/API/DB tests проверяют внешнюю причину, замену задачи-блокера, дату проверки, сохранение omitted-полей и очистку группы. Browser проходит внешний блокер, task blocker и возврат к внешней причине. |
| Вход/выход waiting | Некорректная группа остаётся локально; независимый title сохраняется. После заполнения причины waiting сохраняется; выход очищает blocker/reason/check date в БД. |
| Неизменённые даты и чужие поля | Проверки точного `wait_check_at` с миллисекундами, timestamp deadline и date-only deadline/timezone, issue URL; смена причины не округляет timestamp. |
| REST/MCP parity и безопасность | Итоговые blocker/MCP/deadline/isolation suites: same-board, self/cycle, активный блокер, read-only/frozen/archived и tenant isolation; уведомления, replay/idempotency и optimistic concurrency также проходят существующие API/browser regressions. |
| Локальные даты и режимы срока | Builder/deadline/API suites, включая date-only, datetime, очистку, локальный календарь и DST, проходят на итоговом коде. |
| Геометрия UI | Ошибки сняты на 390×844, 320×844, 320×520, 1280×900 и 320×844 с текстом 200%; browser assertions не находят горизонтального overflow. Визуально просмотрены ошибка title на 320×520 и ошибка ссылки при 200% текста. |

Browser tests используют synthetic Telegram bridge. Сценарии с реальным backend запускают настоящий `buildApp`/Fastify и PostgreSQL через `app.inject`, а затем читают сохранённые значения из backend/БД; это не mock PATCH persistence. Synthetic lost-response/conflict tests дополняют, но не заменяют существующие реальные concurrency tests полного browser gate.

Скриншоты расположены уровнем выше каталога логов: `artifacts/visual-evidence/issue-144-invalid-title.png`, `issue-144-invalid-link-<width>x<height>-<textSize>.png`. Полный browser gate также создаёт штатное evidence соседних тестов. В `perf/input-perf.jsonl` итоговому запуску соответствуют только 6 строк с `phase = issue-144-final`; предыдущие строки являются результатами диагностических прогонов. Это локальные Chromium measurements, не измерения реального телефона.

## Ошибки окружения и ограничения

- Первоначальный cluster с locale `C` ломал кириллическую проверку поиска MCP. Для проверок создана отдельная БД с `en_US.UTF-8`; итоговые tests проходят. Приложение ради этого не менялось.
- Полный browser run на порту 4179 не прошёл MCP connection tests: их fixture фиксирует allowed origin `http://127.0.0.1:4173`, UI показал «Недопустимый источник запроса». Повторный полный run на штатном 4173 прошёл. Это не скрыто повторением одного упавшего теста: итоговый лог содержит полный запуск 118 tests.
- Background shell не наследовал `TEST_DATABASE_URL`; такой диагностический run не считается gate. Финальный run выполнен с доступной тестовой БД и без skipped tests.
- `npm audit --omit=dev --json` — exit 1: одна moderate advisory для `undici`, без high/critical. Лог: `final-audit.json`. Зависимости не обновлялись в рамках #144.
- Проверки accessibility ограничены автоматикой и просмотром скриншотов; реальный screen reader не проверялся.

## Отдельный внешний checklist — НЕ ПРОВЕРЕНО

Проверять на сборке из указанного source artifact либо из будущего commit с идентичным diff; commit/build после публикации нужно явно записать.

- [ ] Реальный Telegram iOS: неполная ссылка + title/description, уход/возврат, клавиатура, локальная ошибка и waiting-группа.
- [ ] Реальный Telegram Android: те же сценарии и сохранность локального ввода после перезапуска.
- [ ] Реальный Telegram Desktop: те же сценарии, конфликт двух редакторов и восстановление связи.
- [ ] Реальное устройство со screen reader и увеличенным текстом.
- [ ] Live provider delivery/production smoke, только после отдельного разрешения.

Эти пункты не являются PASS и не заменяются browser с synthetic Telegram. На момент первичного отчёта merge/deploy, закрытие #144/#140, изменение Хаба/Telegram/Kanban и запуск следующей задачи не выполнялись.

## Closeout по `/taskfinish`

Свежий `origin/main` перед closeout совпал с базовым commit выше. Source diff повторно сравнен побайтно с `source.patch`: идентичен. Dev dependencies доступны; для unit/lint/typecheck/build снят унаследованный `NODE_ENV=production`. Повторены `npm run test` (41 unit + 15 API/DB, без skipped), отдельный issue-url test (1/1), lint, typecheck и build — exit 0. Логи: `closeout-test.log`, `closeout-issue-url.log`, `closeout-lint.log`, `closeout-typecheck.log`, `closeout-build.log`.

### Отдельный baseline-дефект development React — FAIL, не регрессия #144

Полный browser run с удалённым `NODE_ENV` выявил неработающий autosave в development React StrictMode. Effect cleanup вызывает `autosave.stop()` при пробном effect unmount, а повторный setup не активирует controller. Результат: title не отправляется, save-state остаётся `idle`. Такой же effect уже есть на `origin/main`, `autosave.ts` в #144 не менялся.

Для независимого reproduction исходники `origin/main` извлечены через `git archive` в task-owned ignored каталог `artifacts/visual-evidence/issue-144/baseline`, без правок существующего checkout. Команда `env -u NODE_ENV PLAYWRIGHT_PORT=4173 npm run screenshots --prefix artifacts/visual-evidence/issue-144/baseline/apps/web -- details.spec.ts --grep 'details autosaves a title edit' --timeout 15000` завершилась exit 1: 1 failed, пустой save-state вместо `/Сохранено|Не сохранено/i`. Лог: `baseline-development-browser.log`. Общий development run — незавершённый FAIL (`closeout-browser.log`): внешний terminal timeout остановил его после уже зарегистрированных ошибок. Он не засчитан в PASS.

Повторный полный browser run с **явным `NODE_ENV=production`**, `PLAYWRIGHT_PORT=4173` и той же изолированной БД прошёл exit 0: **118/118**, без skipped. Лог: `closeout-production-browser.log`; performance phase: `issue-144-closeout-production`. Это production React в штатном Vite test server, а не deployment и не device smoke. Этот результат подтверждает scope #144, но не исправляет и не маскирует development StrictMode defect. Тесты, StrictMode и checks ради зелёного статуса не изменялись. Независимый дефект передаётся в parent trail, без расширения #144.

Тестовая PostgreSQL после повторных проверок остановлена. Судьба записи: `repo-only`, поскольку #144 и #140 явно запрещают изменение Хаба/Telegram/Kanban, а deployment не выполняется. Parent #140 остаётся открытым; после закрытия #144 первый пакет завершён, следующий кандидат — #145 только по отдельной команде.
