# Повторы: локальная приёмка #148

Родитель: #140. База реализации — `c0d5ca61570af5a75ada99d0c7b31e96c29cb7bb`; ветка `MilevskyYakov/issue-148`. Точный проверенный snapshot закреплён в [source/build manifest](issue-148-source-manifest.json): 111 файлов apps/manifests, не менявшихся во время итоговых проверок. Исторические результаты #129/#147 не используются как текущий PASS. Фактические commit/PR/merge и статус закрытия фиксируются в итоговом комментарии Issue #148; этот отчёт не подтверждает deploy.

## Реализация

- Постоянный `future` удалён из модели черновика. Обычный autosave всегда вызывает instance-only PATCH. Команда «Применить к будущим повторам» доступна только для связанной с шаблоном задачи на редактируемой доске.
- Перед командой завершается очередь autosave. Невалидный или несохранённый ввод, конфликт и незавершённое подтверждение checklist не позволяют открыть применение к серии. Диалог показывает конкретные значения названия, описания, проекта, исполнителя и приоритета. Статус, блокер, срок и уже созданные экземпляры не переносятся.
- Подтверждение привязано к показанной версии задачи. На время диалога очередь приостановлена; повторный запуск защищён single-flight. После применения следующая обычная правка снова меняет только экземпляр.
- `updateTaskAndFuture` использует существующий `withBoardLock` и transaction-capable `updateTask`/`updateRecurrence`. Запись экземпляра, revision, audit и notification outbox откатываются вместе с шаблоном при отказе прав, `null` или исключении второй записи. Для задачи без доступного шаблона нет ложного успеха.
- В шаблон передаются только пять разрешённых полей, а не весь request body. Дополнительные поля не позволяют изменить расписание, паузу или архив через task PATCH. Content-only изменение через общий `updateRecurrence` сохраняет `next_occurrence_at`; scheduler и уже созданные экземпляры не переписываются.
- Успех серии объявляется только после успешного ответа её команды. При потерянном ответе чтение задачи восстанавливает revision, но не выдаётся за подтверждение шаблона. Повтор остаётся отдельным явным действием; online event не повторяет команду. Ответ старого backend с `seriesUpdateFailed` также считается ошибкой применения, а не успехом.

Новых библиотек, миграций, endpoint, очередей или универсального state framework нет. Публичный путь `PATCH .../tasks/:id?scope=future` сохранён; ошибочный частичный HTTP 200 заменён атомарным отказом.

## Среда и границы

Node.js 22.22.3, npm 10.9.8, PostgreSQL 14.23 (Homebrew). Зависимости установлены разрешённым `npm ci --include=dev`, lockfile не изменён. Отдельный локальный кластер PostgreSQL на `127.0.0.1:5499`, рабочая тестовая БД `issue148_utf8`, locale `en_US.UTF-8`; штатные миграции применены только здесь. Данные синтетические. Telegram launch/auth мокируются; browser PATCH/GET выполняются через реальные Fastify handlers (`app.inject`) и PostgreSQL. Реальный Telegram и production не использовались.

DB failure injection выполняется триггером PostgreSQL внутри отдельной уникальной схемы. Схема изолирует fixture от scheduler ticks соседних параллельных тестов и удаляется после проверки. Временные trigger/function также удаляются. Уведомления проверяются по реальному outbox без внешней доставки.

Полные локальные логи, JSON reports, runner и кластер находятся в `artifacts/evidence/issue-148-runtime/` (ignored). Скриншоты — `artifacts/visual-evidence/issue148-future*.png`. Это task evidence, не новый локальный tracker. Секреты, cookie и реальные пользовательские тексты не записывались в отчёт.

После проверок временная PostgreSQL остановлена, статус остановки проверен. Тестовых схем `future_%` не осталось; данные кластера и evidence сохранены в task workspace, чужие процессы и worktrees не изменялись.

## Команды и результаты

Итоговые результаты на неизменяемом snapshot собраны через `issue-148-runtime/verify.py` и `shard.py`. Команды и реальные exit status находятся в `final-gates.json` и `browser-shard-{1,2,3}-exit.json`, сводка — в source/build manifest.

- `npm run test`: exit 0; 42 unit и 19 API/DB/isolation, без skipped.
- `node --import tsx --test apps/api/test/issue-url.test.ts`: exit 0; 1/1.
- `npm run lint`, `npm run typecheck`, `npm run build`: exit 0.
- Целевая production browser matrix `future.spec.ts`: 12/12 после исправления первого варианта UI/test harness. Её окончательная версия дополнительно включена в полный прогон ниже.
- Полный production browser gate на штатном порту 4173: `npm run test:visual -- -- --shard=N/3 --reporter=line,json`, последовательно N=1,2,3; все три exit 0. Результат 78 + 138 + 12 = **228/228**, skipped/flaky/unexpected 0. Объединение test IDs совпадает со всеми 228 ID монолитного прогона, дубликатов и пропусков нет. Это полный набор тестов, а не выбранная положительная подвыборка.
- `git diff --check`: exit 0, включая окончательную проверку при сборе manifest.
- `npm audit --json`: exit 1, четыре baseline advisory (2 high: `brace-expansion`, `undici`; 2 moderate: `fast-uri`, `ip-address`). Dependencies/lockfile не менялись, исправление advisory не входит в #148.

## Сопоставление критериев

| Критерий | Проверка |
| --- | --- |
| После серии следующая правка instance-only; постоянного future-mode нет | `future.spec.ts`: success/cancel/lost response/failure/version race/pending save; проверка query scope и неизменности перечитанного template после следующего title PATCH |
| Понятен состав переноса; без template команда не предлагается | Диалог с пятью значениями и явной границей; `plain`, `invalid draft`, `failed autosave`; backend дополнительно откатывает попытку без template |
| Экземпляр, шаблон и будущий occurrence сохранены, прошлые не меняются | Реальные DB/API readback и scheduler tick в `recurrence-db.test.ts`; browser success также читает task/template и новый occurrence |
| Отказ прав, null/exception и lost response не показывают полный успех | PostgreSQL BEFORE UPDATE trigger возвращает NULL или RAISE EXCEPTION; snapshot task/template/revision/audit/outbox до и после совпадает. Browser lost response/failure/denied/version race не показывает подтверждение серии и не делает replay на online |
| Права, expectedVersion и уведомления без дублей | Template creator/member denial, outsider/cross-board, stale replay 409 без побочных эффектов, повтор с актуальной версией, outbox содержит одну запись после повторов назначения |
| Read-only, archived и sibling paths | DB frozen/archived board, archived task; browser frozen/read-only и отсутствие команды при archived deep link 404; штатные lifecycle/isolation/MCP suites |
| Автоматическая и внешняя приёмка разделены | Browser/API/DB — локальные синтетические проверки. Telegram iOS/Android/Desktop и реальная доставка не проверены |

## Визуальная проверка

Диалог проверен на 390×844, 320×844, 320×520, desktop 1280×900 и при 200% текста. Проверяются отсутствие горизонтального overflow, доступность кнопки после прокрутки, начальный фокус, keyboard trap, Escape и возврат фокуса к команде. Сохранены отдельные screenshots верхней части с объяснением и нижней части с действиями.

При ручном осмотре первый длинный заголовок некрасиво разрывал слова при 200%; заменён на короткий «Будущие повторы», без изменения названия команды и смысла подтверждения. Верхнее объяснение и кнопки читаемы; длинный диалог прокручивается. Focus первоначально смещался к кнопкам внизу: вводный текст теперь получает начальный фокус. Открывающая команда сохраняет фокус во время ожидания autosave (`aria-disabled` и проверка single-flight вместо потери фокуса из-за native disabled).

## Диагностированные неуспешные прогоны

1. Baseline на неизменённом production code: DB regression получил HTTP 200 вместо 403 при отказе прав шаблона; browser regression не нашёл отдельную команду. Логи `baseline-db.log`, `baseline-browser.log`.
2. Первый candidate browser: 9/12. Реальный дефект возврата фокуса исправлен; два неверных ожидания harness исправлены по фактическому контракту: порядок alert и archived deep link 404. Следующая целевая матрица прошла 12/12.
3. Первый полный `npm run test`: locale `C` не выполняла casefold кириллицы в существующем MCP project dedupe test. Создана тестовая БД с `en_US.UTF-8`; SQL-проверка `lower('ПРОЕКТ') = lower('проект')` вернула true. Другой отказ обнаружил пересечение нового DB snapshot с глобальным scheduler соседнего теста; fixture перенесена в отдельную схему. После обеих коррекций полный test gate прошёл.
4. Первый background browser запуск не унаследовал shell export `TEST_DATABASE_URL` и завершился до тестов. Повторный runner передаёт параметры окружения явно; это не application failure.
5. Foreground полный browser запуск прерван лимитом инструмента 420 секунд во время теста 172/228. Финальный JSON/exit status отсутствуют, PASS не заявляется. На том же snapshot полный прогон повторён в фоне с отдельным receipt exit status.
6. Монолитный background прогон завершился с exit 1, 226/228. Два MCP browser tests используют hardcoded `http://127.0.0.1:4173` для Origin/Host; запуск на 4188 корректно блокировал создание подключения. Защита и тесты не ослаблялись. Итоговые shards выполнены на штатном 4173; оба MCP-сценария прошли.
7. При продолжении сессии локальная PostgreSQL уже не слушала 5499; первый shard получил 15 `ECONNREFUSED`. Кластер из task workspace восстановлен, добавлен fail-fast `pg_isready` перед каждым shard. После восстановления все три shards прошли. Причина остановки процесса не установлена; это не объявляется product failure.
8. При подготовке дополнительного input comparison anchored `--grep '^details title'` не совпал с полным Playwright test title: `No tests found`. Исправлена только CLI-маска, затем baseline и candidate дали по 6/6.

### Ввод и development StrictMode

В итоговом foreground sharded gate метрика `input-to-next-frame` для details title: p50 2 мс, max 9 мс при обеих очередях 50/600; longtaskMs=0. Для create title: p50 3/14 мс, max 9/16 мс; для comment: p50 2 мс, max 9 мс. Все шесть измерений относятся к текущему candidate, а не к прошлому evidence.

Дополнительно один и тот же штатный `input-perf.spec.ts --grep 'details title' --repeat-each=3` запущен последовательно на архиве чистой базы и candidate, с одинаковыми viewport, объёмом очереди, production mode, библиотеками и метрикой. Оба запуска exit 0, по 6 тестов. Медианы p50 трёх запусков для очередей 50/600: baseline 43/46 мс, candidate 36/2 мс; максимумы 107/251 и 110/207 мс соответственно. Разброс велик, поэтому ускорение или стабильный SLA не заявляются. Наблюдение фонового монолитного прогона также дало заметно более высокие задержки; оно сохранено, а не заменено удобной цифрой. Эти measurements не являются Telegram-device benchmark.

Известный development StrictMode дефект перепроверен одним и тем же существующим тестом `details autosaves a title edit` на чистой базе и candidate: оба exit 1 с одинаковым пустым save-state вместо `Сохранено|Не сохранено`. Логи `strictmode-baseline.*`, `strictmode-candidate.*`. Это воспроизведённый baseline, не новый PASS и не исправление #148.

## Непроверенная граница и closeout

- Real Telegram iOS/Android/Desktop, account/device smoke, live delivery, deploy и production migration не выполнялись. Для внешней проверки использовать snapshot/build hashes manifest: открыть повтор, изменить поля, явно применить, изменить название ещё раз, проверить шаблон и следующий occurrence; повторить после потери сети/ответа, отказа прав и конкурентной правки, проверить клавиатуру и 200% текста на каждом устройстве.
- Воспроизведённый baseline TaskDetails/React StrictMode из #140/#147 не исправлялся. Production browser PASS не означает общий development StrictMode PASS.
- После локальной реализации пользователь вызвал `/taskfinish`, разрешив commit/PR/merge и closeout #148 с обновлением parent #140. Deploy не разрешён. #149 и другие задачи не запускались; parent не закрывается по завершении одной части.
- Хаб, Telegram/Kanban и план дня не изменяются по контракту #148/#140. Для Хаба выбран `weekly`: прогресс программы остаётся в GitHub, без второго журнала и без заявления о production-доступности.

### Проверка перед публикацией

Свежий `git fetch --prune origin` подтвердил прежнюю базу `c0d5ca61570af5a75ada99d0c7b31e96c29cb7bb`. Повторно сверены SHA-256 всех 111 source files и всех записанных build/evidence artifacts: расхождений нет. JSON всех трёх shards повторно разобраны: 228 уникальных ID, совпадение с полной матрицей, skipped/flaky/unexpected 0; все сохранённые gate exit status равны 0. Неизменившиеся проверки не перезапускались ради повторения. Изменены только пояснения closeout в отчёте и manifest.

На GitHub при проверке нет branch protection и rulesets, `.github` workflows отсутствуют. Временная PostgreSQL остановлена; порты 4173/4188/5499 не слушают, список Hermes background processes пуст. Активный Orca-worktree и evidence сохраняются. Чужой untracked `artifacts/ux/task-details-approved-comparison.png` в основном checkout не меняется; этот checkout не переключается и не очищается.
