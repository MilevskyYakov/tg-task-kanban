# Настройки: итоговая локальная приёмка #147

Родитель: #140. Первичная реализация уже находится в main через PR #158, base commit `6970e60521e3d1849efa5dafe2743f20806b0361`. Этот follow-up исправляет два воспроизведённых дефекта общей settings-очереди; зависимости, API/DB-контракты и дизайн не меняет.

Проверенный snapshot состоит из 110 файлов apps/manifests, с точными SHA-256 в [source/build manifest](issue-147-source-manifest.json). Исходники не менялись во время итоговой серии и повторного полного browser gate. Commit публикации и merge receipt фиксируются в PR/Issue: хеш документа не включён в его собственный manifest.

## Результат и root cause

- Reconnect во время незавершённого отказа больше не теряется из-за последующего `queue(null)`: один pending retry переносится за завершение single-flight. Перед повтором заново читаются сервер и текущие права. После 401/403/404 или конфликта автоматического replay нет.
- Повреждённый или недоступный при восстановлении storage оставляет предупреждение после фонового reread и повторного открытия формы. Предупреждение о восстановлении снимается только явным новым редактированием; новый отказ записи storage всё равно показывает warning.
- Изменён общий `SettingsEdit`, через который проходят названия доски, проекта и обе формы расписания. Не добавлены библиотеки или новый offline framework.

До исправлений целевые regression на доске воспроизвели два отказа: reconnect during failure и corrupt storage/reopen. Guard reconnect during denial уже проходил и сохранён как security regression. Сохранены `root-cause-baseline.json/.log`. После исправлений расширенная выборка по всем трём поверхностям и исходным offline/user-isolation сценариям дала 22/22 production и 22/22 development, без retries/skips/flaky.

## Итоговые команды и результаты

Тестовая среда: Node.js 22.22.3, npm 10.9.8, отдельная PostgreSQL 14.23 на localhost:5499, синтетическая БД `issue147_closeout`. Штатные миграции применены; production URL не использовался. Settings tests читают реальные Fastify handlers через app.inject и PostgreSQL. Telegram launch/auth и сетевые отказы синтетические; mock успешного PATCH не заменяет API/DB readback.

- `TEST_DATABASE_URL=<isolated-local-db> npm run test`: exit 0, 42 unit + 18 API/DB/isolation, skipped 0.
- `node --import tsx --test apps/api/test/issue-url.test.ts`: exit 0, 1/1.
- `npm run lint`, `npm run typecheck`, `npm run build`, `git diff --check`: exit 0.
- `NODE_ENV=development npm run screenshots -w @task/web -- settings-autosave.spec.ts publications.spec.ts --reporter=line,json`: exit 0, 85/85, skipped/flaky 0. React StrictMode остаётся включённым.
- `NODE_ENV=production npm run test:visual -- -- --reporter=line,json`: полный итоговый report 216/216, skipped/flaky 0. Background adapter вернул null вместо exit status; завершённый JSON, все результаты и идентичность snapshot отдельно проверены командой-verifier с exit 0. Не выдумывается отсутствующий npm exit status.
- Детерминированная инъекция повреждённого storage при загрузке нового документа: три поверхности × пять повторов, exit 0, 15/15 development.
- Дополнительный визуальный осмотр полного warning после обычной прокрутки: exit 0, 3/3 production. Временная копия native spec сохранена как `issue-147-runtime/warning-centered.spec.ts`, из test directory убрана; production source не менялся.

Команды, exit status, timestamps, JSON stats, source/build/log/screenshot hashes находятся в manifest. Полные локальные файлы лежат в `artifacts/evidence/issue-147-runtime/`; секреты и реальные пользовательские тексты в них не переносились.

### Диагностированные отказы, не скрытые повтором

1. В первом полном development прогоне единственный corrupt-storage тест был нестабилен: незавершённый старый reread мог перезаписать искусственно повреждённое значение до reload. Test injection перенесена в `addInitScript` нового документа, без ослабления assert. После этого 15/15 повторов и полная 85/85 матрица прошли.
2. Следующий полный production прогон дал 215/216: неизменённый `scroll-restore.spec.ts` не смог подготовить scroll 1200 до открытия карточки (ожидалось >=1190, получено 1106). Его отдельные пять повторов прошли 5/5; затем полный повтор на неизменённом snapshot прошёл 216/216. Scroll-код, пороги и retries не менялись. Root cause единичного scroll-сбоя не установлен; отсутствие флейков во всех будущих прогонах не заявляется. Оба полных report и отдельная проверка сохранены.

## Сопоставление acceptance

| Критерий #147 | Реальное evidence |
| --- | --- |
| Debounce текста без blur; готовый выбор сразу; честные состояния | success/raw-input и publications regression; один partial PATCH; ожидаемый серверный readback |
| Каждая поверхность переживает navigation, board switch, reload до debounce/in-flight, offline/reopen | real API/DB matrix board/project/publication; восстановление latest draft и GET |
| Изоляция user/board/object, позднего ответа и очередей | user isolation, late response, reload in flight; max concurrent writes = 1; reconnect during failure |
| Независимые поля и явный same-field conflict | independent fields, local/server/offline/stale choice conflict; server field-level expected guard |
| Invalid draft, quota/corrupt storage, 401/403/404, frozen/archived, отозванные права | invalid/quota/corrupt/access matrix; reconnect during denial не обходит 403; API/DB isolation |
| Регрессия выключения F и только явные операции | publications suite; unintendedActions пуст; архив/создание/активация не запускаются вводом |
| Повторные формы, focus/caret, скорость ввода и текущий UI | общие NameSetting/PublicationSetting в owning/sibling callers; raw input/caret assertions; 390×844, 320×844, 320×520, desktop и 200% primary-field bounds/screenshots |
| Соседние permissions/read-only/isolation и итоговый snapshot | 18 API/DB/isolation, full production browser gate, 110 source hashes без изменений во время проверки |
| Локальные и внешние gates разделены | перечисленные ниже device/provider/deploy шаги остаются НЕ ПРОВЕРЕНЫ; parent не закрывается |

### Ввод и визуальный осмотр

Метрика — input event до следующего requestAnimationFrame, не server latency и не обещание device performance. Последний полный production прогон:

- `board`: 12 событий; p50 0.40 мс, max 0.70 мс.
- `project`: 14 событий; p50 0.40 мс, max 0.70 мс.
- `publication`: 10 событий; p50 3.40 мс, max 7.60 мс.

Фокус и caret проверены тестами; typing отправляет один field-scoped запрос после паузы. Отдельный штатный input-perf gate охватил create title/details title/comment при queue=50/600; longtaskMs=0 во всех шести выборках. Для create-title queue=600 p50=15 мс, max=17 мс; остальные значения записаны в manifest. Это текущие synthetic measurements, не сравнительный baseline/candidate benchmark.

Осмотрены реальные screenshots конфликтов, сохранённого reconnect и повреждённого storage. Полный warning читаем после обычной прокрутки на всех трёх поверхностях; в исходном publication screenshot warning частично попадал под нижнюю навигацию, поэтому сохранён отдельный centered screenshot. На 320×520 читаемы конфликтные значения и обе кнопки. Проверки primary-field bounds не означают полный визуальный PASS всех вложенных controls при 200%: ранее существующая тесная геометрия публикаций не исправлялась и не объявляется принятой device-проверкой.

## Остаточные риски и внешняя граница

- `npm audit` и `npm audit --omit=dev`: ранее получен exit 1, 4 baseline advisories (2 high: undici/brace-expansion; 2 moderate: fast-uri/ip-address). Dependencies/lockfile не менялись. Это не исправлено и не объявлено PASS.
- Общий baseline StrictMode TaskDetails из parent #140 не исправлялся: PASS относится к полной settings/publications development matrix, а не всему приложению в development.
- Telegram iOS/Android/Desktop smoke, реальные account/device/provider запросы, live delivery и production deploy не выполнялись.
- Для внешней приёмки использовать source/build hashes этого manifest и commit follow-up PR: проверить быстрый ввод, закрытие/reopen до debounce и offline, reconnect, переключение доски/аккаунта, отказ прав, повреждённый storage, оба решения конфликта, выключение расписания и читаемость warning/controls при 200%. Каждый device отмечается отдельно только после реального выполнения.
- #140 остаётся OPEN; #148 — следующий кандидат по отдельной команде, не запускался. #129/#98 и другие worktrees не изменялись.
- Хаб fate: `repo-only` по явному запрету Issue #147 на изменения Хаба, Telegram/Kanban и плана дня. Полные ignored evidence и task branch остаются на месте; cleanup/deploy не выполняются автоматически.
