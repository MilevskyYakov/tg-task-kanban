# #146 — сохранение выключения публикаций

## Ревизия и границы

- Issue: https://github.com/MilevskyYakov/tg-task-kanban/issues/146; parent #140 остаётся отдельной программой.
- База: `d76ebe2b7107be3f20da9c42b73bd0de3096ed41`; task-ветка `MilevskyYakov/issue-146`.
- Реализация и локальная подготовка окружения выполнены после команды пользователя. На момент завершения реализации результат находился в рабочем дереве, без commit/PR/merge/deploy. Последующий разрешённый `/taskfinish` фиксирует repository closeout в GitHub trail #146; deploy и следующая задача в него не входят. Хаб и Telegram/Kanban не меняются.
- Перед правками checkout был чистым, `HEAD` совпадал со свежим `origin/main`; открытых PR и worktree #134 не обнаружено. Повторный fetch после правок также дал `HEAD...origin/main = 0/0`. Другой worktree не изменялся.
- Точный candidate фиксируется соседним `issue-146-source-manifest.json`: SHA-256 исходников, тестов, web/API build и локальных логов. Manifest не включает секреты или пользовательские данные.
- SHA-256 manifest: `3a0990c7c0fb8bc9ec9fedeee1ca1d80d746de699034551a3b58abe66c6cc442`; зафиксированы 107 source-файлов.

## Исправление

1. `enabled` больше не является условием валидности расписания. Выключение и включение отправляют настоящий PUT; подтверждённое значение читается через GET и после reload.
2. Публикации используют существующий `Autosave`, а не независимые таймеры запросов. Очередь изолирована по user/board/kind; запросы одного расписания выполняются последовательно. Ответ старого запроса не заменяет более новый ввод или расписание другой доски.
3. Переключение enabled сохраняется без текстового debounce; поля используют 700 ms. Невалидная правка приостанавливает очередь, в том числе отменяет ожидающую отправку ранее валидного значения. Проверяются дни, время, IANA timezone и выбранные статусы. `0` больше не отфильтровывается в якобы валидный список дней.
4. Рядом с переключателем отображаются «Ожидает отправки», «Сохраняется…», «Сохранено», «Не сохранено». Ошибка API видна отдельно; ручной повтор отправляет последнее значение. Checkbox отражает намерение пользователя, не выдавая его за подтверждение сервера.
5. Собственный API regression обнаружил отсутствие серверной проверки read-only доски в PUT публикаций: frozen-доска принимала изменение с HTTP 200. Теперь маршрут отвергает неактивную доску, а `updateSchedule` повторно проверяет её состояние в SQL. Текущие права администратора Telegram и membership isolation сохранены. Предпросмотр остаётся отдельным явным read-only действием.
6. `queueDuePublications` и delivery policy не менялись. Реальный DB regression подтверждает отсутствие новых runs после выключения, сохранность существующих runs и возобновление с прежней дедупликацией после включения.

## Окружение и воспроизведение

- Node.js 22.22.3, npm 10.9.8, PostgreSQL 14.23 (Homebrew), штатные Playwright/Chromium.
- `npm ci --include=dev` — exit 0. Использованы объявленные lockfile-зависимости; новые пакеты не добавлялись, manifests/lockfile не менялись.
- Отдельный cluster: `artifacts/evidence/issue-146-runtime/pgdata`; TCP только `127.0.0.1:5499`, Unix socket отключён. Итоговая БД: `issue146_test_utf8`, UTF8, `en_US.UTF-8`. Production URL не использовался.
- Миграции применены только к тестовой БД: `DATABASE_URL="$TEST_DATABASE_URL" npm run migrate` — exit 0.
- До изменения реализации новый browser/API/DB тест `publications.spec.ts --grep 'API/DB: daily'` воспроизвёл проблему: после выключения ожидался один PUT, получено ноль; exit 1 (`reproduction.log`).
- Новый API/DB regression до read-only исправления получил HTTP 200 вместо 403 для frozen-доски (`publications-db-first.log`). Это текущая репродукция, не историческое evidence.
- Первичная подготовка БД с `--no-locale` дала SQL_ASCII; существующий тест с кириллическим title упал на `tasks_title_check`. После явного UTF8 локаль C всё ещё не меняла регистр кириллицы: `lower('Проект') = 'Проект'`; MCP deduplication regression корректно упал. Создана отдельная БД с UTF8 и `en_US.UTF-8`, где `lower('Проект') = 'проект'`. После этого штатный `npm run test` прошёл. Код, ограничения и тестовые ожидания ради этих ошибок окружения не ослаблялись.

## Проверки

Все данные синтетические. Browser маршрутизирует реальные PUT/GET через Fastify `app.inject` в PostgreSQL. Telegram launch/auth и `getChatMember` подменены; реальных сообщений и запросов к Telegram нет. Ошибка 500 и задержка запроса задаются тестом, чтобы проверить порядок событий; успешные ответы и readback приходят из настоящего backend/БД.

Итоговый повтор выполнен штатными командами из `issue-146-runtime/verify.py`; exit status и команды записаны в `issue-146-runtime/final/verification.json`. Все семь команд завершились exit 0 на одном source candidate:

| Команда | Exit | Результат |
|---|---:|---|
| `npm run test` с `TEST_DATABASE_URL` | 0 | 42 unit + 17 API/DB/isolation, skipped 0 |
| `node --import tsx --test apps/api/test/issue-url.test.ts` | 0 | 1/1 |
| `npm run lint` | 0 | штатный TypeScript gate |
| `npm run typecheck` | 0 | API + web |
| `npm run build` | 0 | web + API |
| `git diff --check` | 0 | без whitespace errors |
| `NODE_ENV=production PLAYWRIGHT_PORT=4173 npm run test:visual` с `TEST_DATABASE_URL` | 0 | 140/140, включая 9 новых publication browser/API/DB сценариев |

Первый полный browser-прогон также прошёл 140/140. После переноса screenshots на состояние с видимым «Сохранено» и добавления screenshot ошибки весь gate повторён на итоговой UTF8/en_US.UTF-8 БД: снова 140/140, exit 0. Итоговые логи находятся в `issue-146-runtime/final/`, их SHA-256 включены в manifest. Исторические результаты #129/#140 не использовались как текущий PASS.

После проверки cluster штатно остановлен: `pg_ctl ... -m fast -w stop` — `server stopped`; последующий status — `no server running`. Слушателей тестовых портов 5499/4173 не обнаружено. Runtime-данные, логи и скриншоты сохранены в task workspace и исключены из Git; отчёт и manifest остаются вместе с source diff.

### Покрытие acceptance

- Daily и weekly: `false` отправляется, сохраняется через API/DB, переживает GET/reload; обратное включение работает.
- Задержанный первый PUT и быстрые переключения: максимум один одновременный PUT одного расписания; последнее значение остаётся на сервере. Ошибка старого запроса не теряет более новое намерение, ручной повтор отправляет его.
- До ответа PUT нет статуса «Сохранено»; GET показывает старое состояние. При 500/403 видны ошибка и «Не сохранено», ложного подтверждения выключения нет.
- Невалидные дни/время/timezone и пустые статусы не отправляются. Невалидная правка отменяет ещё не отправленный валидный draft; invalid draft во время in-flight PUT остаётся видимым и не получает ложный saved.
- Смена доски во время запроса не меняет UI или серверное расписание другой команды.
- API проверяет bool/дни/время/timezone/statuses; отсутствие session, member без прав, outsider, другая доска и отозванные Telegram admin rights не дают запись.
- Frozen/archived/draft отвергаются REST и SQL helper. Browser проверяет отзыв write-доступа после открытия и отсутствие редактора после reload frozen-доски.
- Scheduler после подтверждённого выключения не создаёт runs ни daily, ни weekly на следующую подходящую дату; существующие runs остаются неизменными. Другая доска продолжает планироваться. После включения работают catch-up и дедупликация.
- Предпросмотр, timezone/render/deep links, delivery retry/lease и pair-board restrictions проверяются собственным publications test и штатным полным suite.

## Визуальное evidence и ограничения

Скриншоты: `artifacts/visual-evidence/issue146-publication-{width}x{height}-{textSize}.png` для 390×844, 320×844, 320×520, 1280×900 и 320×844/200%; ошибка — `issue146-publication-error.png`.

Переключатель доступен после scroll; тест проверяет document horizontal overflow. Скриншоты ошибки, короткого viewport и 200% осмотрены: «Не сохранено»/ошибка API и «Сохранено» читаются рядом с переключателем. Кнопка повтора на screenshot ниже нижней панели; её доступность через scroll подтверждена реальным кликом и успешным PUT/GET в browser-тесте. Осмотр при 200% выявляет ограничение существующей формы: правый край некоторых полей/кнопки добавления повтора обрезается, хотя document overflow check проходит из-за clipping. Полный визуальный PASS для формы при 200% не заявляется; CSS/layout этой задачей не менялись.

Внешние gates и границы:

- Full browser gate использует production React на локальном Vite server, не production deployment. Общий development StrictMode baseline из #144 этим результатом не объявляется исправленным.
- `npm audit --omit=dev` — exit 1: существующий `undici@7.29.0`, одна moderate уязвимость GHSA-3wwx-pv8p-q78v. `npm audit fix` не запускался; security audit не объявлен зелёным.
- Durable drafts после закрытия WebView, replay/conflicts настроек и общая интеграция settings остаются отдельным scope #147. Эта задача использует один существующий autosave controller на расписание, но не заявляет завершённой программу #140.
- Реальные Telegram iOS/Android/Desktop, live provider/delivery, реальные аккаунты и production не проверялись. На build из manifest остаются device-шаги: выключить daily/weekly, дождаться подтверждения, reopen, включить обратно; проверить быстрые переключения, сетевую ошибку и ручной повтор, frozen-доступ, клавиатуру/scroll и увеличение текста. Выполнять только по отдельному разрешению; synthetic browser не является device PASS.
- До отдельной команды `/taskfinish` repository closeout и публикация evidence в GitHub не выполнялись. Merge не является deploy и не закрывает общий parent #140.

## Проверка при `/taskfinish`

На неизменном candidate повторно проверены все source/build/log/screenshot hashes из manifest: расхождений нет. Свежий `origin/main` совпадал с базой, новых коммитов для интеграции не было. Повторные `npm run test:unit` (42/42), `npm run lint`, `npm run typecheck`, `npm run build` и `git diff --check` завершились exit 0. Полные 17 API/DB + 1 issue-url и 140 browser результатов выше относятся к тем же исходникам. Логи повторов: `issue-146-runtime/closeout-{unit,lint,typecheck,build}.log`.

Хаб-fate: `repo-only` — #146/#140 явно ограничивают writeback репозиторием, deployed product state не меняется. Разрешённый closeout публикует evidence в Issue/PR, отмечает #146 в parent и оставляет #140 открытым. Следующий кандидат — #147 по отдельной команде, без автоматического запуска.

Постоянный checkout `main` содержит чужой untracked `artifacts/ux/task-details-approved-comparison.png`; файл и checkout не изменяются. Активный Orca-worktree сохраняет task-ветку; статус `completed` устанавливается только после проверки merge и закрытия Issue. Тестовый PostgreSQL уже остановлен; production/device gates и ограничения выше остаются явными.
