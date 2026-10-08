# #178 — локальная реализация и проверка

## Версия и полномочия

- Задача: [#178](https://github.com/MilevskyYakov/tg-task-kanban/issues/178), родительский выпуск [#175](https://github.com/MilevskyYakov/tg-task-kanban/issues/175).
- База: `58924f41b3b5f22ee5a4e3bab6a603d0262c5cde`. Task-ветка: `MilevskyYakov/issue-178`; рабочее дерево `/Users/milevsky.yakov/orca/workspaces/tg-task-kanban/mcp-5`.
- На этапе реализации пользователь разрешил #178 и локальные проверки. После исправления P1 и завершения проверок отдельно разрешены commit, push task-ветки и создание PR как подготовка к единому выпуску #175. Merge, production, изменение действующего ключа и переключение клиента не разрешены и не выполнялись. Другие worktrees не изменялись. Никаких обращений к реальному Telegram для тестовых уведомлений.
- После первого полного прогона пользователь отдельно разрешил загрузить штатный Chromium Playwright в локальный тестовый кеш и повторить общий UI gate. Это разрешение не расширяло scope до соседних UI-исправлений или выпуска.
- После отчёта об оставшемся branding-блокере пользователь дал команду «Го дальше». Продолжение ограничено локальными UI-блокерами приёмки: исправлением общего CSS, готовности scroll-test fixture и измерителя длительности состояния. Логика прокрутки и тайминги создания в приложении не менялись. На этом этапе разрешения на публикацию или production ещё не было.
- Проверки выполнены до фиксации commit. Точные SHA-256 изменённых файлов кода и конфигурации находятся в `artifacts/issue-178/code-snapshot.json`; `.md` и генерируемый `artifacts/` намеренно не входят в кодовый manifest. Перед commit содержимое повторно сверено с проверенным snapshot. Действительность результатов ограничена этим кодом, а не любыми последующими правками. Точная публикуемая ревизия указывается в PR.
- SHA-256 текущего кодового manifest после исправления P1: `d374dc920651b3fecfc0bbe35b941dbd75efee098ef0c6f2cec5c3a07c11e243`. Предыдущая версия сохранена в `code-snapshot-before-access-version.json` (`0cfb7c68564d18d3711544f7a4f6c3813c8853d0d3408b5fa903e5d6134a0b6a`). После ревью изменились только `apps/api/src/mcp.ts`, `apps/api/test/mcp-lifecycle.test.ts`, `apps/web/src/mcp-connections.tsx`, `apps/web/visual/mcp.spec.ts`; изменения документов не входят в кодовый manifest. Прежние snapshots `code-snapshot-before-branding.json`, `code-snapshot-branding-fixed.json`, `code-snapshot-scroll-fixed.json` сохранены для истории.

## Результат

**Блокер P1 закрыт после отдельного согласия пользователя; общий UI gate новой версии PASS.** Устаревшая selected-форма больше не может восстановить потерянный grant обычным переименованием или одновременно с добавлением другой доски. Новый edit проверяет `expectedAccessVersion` фактически показанного состава доступа, а UI не выставляет безусловное подтверждение расширения. Конфликт сохраняет черновик и требует открытия текущих настроек. Триггер, схема БД, ключи и порядок блокировок не менялись.

Новая версия прошла **74/74 unit/DB/API**, lint/typecheck/build, миграционную проверку на отдельной пустой БД, **4/4 MCP UI** и **288/288 полного UI-прогона**, без ошибок и пропусков. Snapshot сверён до и после прогона, `git diff --check` PASS. Сводка: `artifacts/issue-178/verified-access-result.json`. Прежние 286/286 и `verified-local-result.json` относятся к snapshot до исправления P1 и сохранены только для истории.

Обычное редактирование сохраняет ключ и ID подключения. Selected остаётся значением по умолчанию; all включается явно с предупреждением о личных и будущих досках. Потеря membership запоминается в БД, а не при очередном MCP-запросе. Перевыпуск — отдельная versioned/idempotent операция с одноразовым секретом. Receipt и lifecycle audit не содержат ключей или данных задач.

Контракт: [issue-82-mcp-contract.md](issue-82-mcp-contract.md). Инструкция пользователю и оператору: [issue-178-update.md](issue-178-update.md).

## Исправление P1 после self-review

Историческое воспроизведение и отчёт: `artifacts/issue-178/review.md`, `review-membership-probe.ts`, `review-membership-probe.log`. Probe относится к старому контракту edit и утверждал наличие дефекта; проверкой исправления служат штатные тесты ниже.

Причина: membership loss удаляет grant, но не увеличивает connection revision. Cached `selected.boards` продолжал включать доску после rejoin, а каждое сохранение отправляло `confirmExpansion: true`. Поэтому UI мог показывать «Добавятся: Нет», а сервер восстанавливал доступ.

Минимальное исправление использует существующие hash/canonical, DTO и `VERSION_CONFLICT`: `accessVersion` вычисляется из отсортированных ID эффективных досок; edit требует исходный `expectedAccessVersion` и сравнивает его после connection/member locks. При несовпадении никакая часть edit не применяется. Сверка обязательна и для подтверждённого расширения другой доски. Названия не входят в отпечаток; переименование доски сохраняет версию доступа. Receipt replay остаётся раньше проверки и не выдаёт права повторно. Миграция и membership trigger не меняются, обратного connection lock нет.

Проверки:

- RED: добавленный API regression на старом коде получил `200 !== 409` (`access-regression-red.log`).
- API: устаревший selected draft при rename-only и при добавлении другой доски; stale all, неверная/отсутствующая access version, необходимость отдельного `confirmExpansion` даже со свежей версией; разрешённое явное восстановление, прежний ключ и неизменность версии доступа после rename. Трёхсторонняя гонка tool/edit/member deletion сохраняет проверку отсутствия deadlock; edit теперь безопасно возвращает `VERSION_CONFLICT`, поскольку состав доступа изменился во время ожидания.
- Реальный UI/API/DB на 320/390 px: membership удаляется и восстанавливается **после открытия подтверждения**; rename-only и намеренное добавление другой доски отклоняются. Имя, revision, ключ и grants не изменены; черновик остаётся. После явного открытия текущих настроек пользователь заново отмечает доску и видит её в «Добавятся»; восстановление проходит. Оба новых и оба прежних MCP-сценария прошли: `access-ui-targeted.log`, 4/4.
- `npm run test`, `npm run lint`, `npm run typecheck`, `npm run build`: exit 0, `access-{test,lint,typecheck,build}.log`, `access-static-results.json`. Tests: 45 unit + 29 DB/API, без ошибок/пропусков.
- `MCP_MIGRATION_DATABASE_URL=<отдельная пустая локальная БД> npm exec -- tsx apps/api/test/mcp-migration.ts`: exit 0, `access-migration.log`, БД `tasca_issue178_access_migration`. Прежний ключ, selected grants и повторное применение runner проверены; данные синтетические.
- Полный `npm run test:visual`: **288 passed, 0 failed, 0 skipped**, exit 0, 935.74 s, штатный Chromium/FFmpeg, изолированный порт 63823. Лог `full-visual-access-version.log`, результат `visual-access-version-result.json`. После завершения listener отсутствует. Проверенные новые логи не содержат полного формата MCP-секрета. Генерируемые input-performance данные сохранены в `input-perf-access-version.jsonl`; tracked historical artifact восстановлен после сохранения копии.
- Повторное self-review: сверены связь DTO с показанным diff, обязательность проверки при `confirmExpansion: true`, порядок receipt replay и member locks, сохранность legacy create/rotate/revoke и отсутствие новой миграции. Это self-review автора, не независимое ревью.

Все evidence находятся в `artifacts/issue-178/`. Новых зависимостей, внешних сервисов и обращений к реальному клиенту нет.

## Проверка модели до реализации

Проверены `connectionForKey`, все ветки `runTool`, management routes, grants FK, удаление membership в `pair-boards.ts`/`db.ts`, существующие board/advisory locks и UI secret/lost/uncertain.

- Tool удерживает `FOR SHARE` подключения до commit, затем проверяет режим, эффективный grant, текущее membership и board state. Management использует `FOR UPDATE` того же подключения. Ранее допущенная операция может завершиться до подтверждения изменения; новая запрещённая операция после барьера не проходит.
- Membership deletion держит board/member, но не должна затем ждать connection. Поэтому триггер пишет независимый журнал потерь `(board_id,user_id)`, не перебирает подключения и не блокирует их. Каскад удаляет явные grants. При удалении самой доски/пользователя триггер не пытается сохранить ссылку на уже удалённый объект.
- All разрешает действующее membership с явным grant либо без истории потери membership. Создание all или явное включение all подтверждает текущий состав; обычное редактирование уже включённого all не восстанавливает исключения. Автоматическое будущее rejoin после прежней потери требует явного восстановления.
- `expectedVersion` не даёт молча затереть параллельное изменение. Стабильный `requestId` различает повтор, иной payload и новый intent; receipt коммитится вместе с правами/хешем. Старый create fingerprint сохранён для совместимости.
- UI хранит неизвестный intent до проверки, запрещает менять его payload, показывает diff до отправки и оставляет конфликтующий черновик до явного открытия текущих настроек. Потерянный rotation не запускает скрытый новый перевыпуск.

## Окружение

Node `v22.22.3`, npm `10.9.8`, PostgreSQL `14.23 (Homebrew)`, Playwright `1.59.1`, установленный Chrome в изолированном временном профиле. Зависимости восстановлены из существующего lockfile через `npm ci --include=dev --ignore-scripts --no-audit --no-fund`; новых зависимостей нет.

Тестовая БД: локальная `tasca_issue178_test`, Unix socket `/tmp`. Проверка старой схемы: отдельные новые пустые `tasca_issue178_migration_test` и итоговая `tasca_issue178_migration_final`. Только синтетические users, boards, sessions, keys. Миграционные fixtures оставлены локально; они не содержат пользовательского ключа. API/DB проверки используют реальные транзакции и HTTP/SDK, уведомления заглушены.

Первый полный прогон использовал `PLAYWRIGHT_CHANNEL=chrome`, порт из `visual-result.json` и локальную ссылку `artifacts/issue-178/browsers/ffmpeg-1011/ffmpeg-mac` на системный ffmpeg (`8.1.2`, encoder libvpx VP8).

Итоговый повтор после отдельного разрешения использовал штатные **Chromium / Chrome Headless Shell `147.0.7727.15` (Playwright revision `1217`) и FFmpeg `1011`**. Они установлены командой `PLAYWRIGHT_BROWSERS_PATH="$PWD/artifacts/issue-178/playwright-browsers" npm exec -- playwright install chromium`; лог — `chromium-install.log`. Глобальный кеш, профили и npm dependencies не менялись. В дочернем процессе `PLAYWRIGHT_CHANNEL` удалён, `PLAYWRIGHT_BROWSERS_PATH` указывает на новый task-local каталог, свободный порт `61141` записан в `visual-chromium-result.json`. Перед общей проверкой малый MCP/video smoke прошёл **4/4**, `chromium-smoke.log`.

Оба прогона используют mocked Telegram, `reducedMotion: reduce`, кроме штатных motion-сценариев. Это не физическое устройство и не настоящий Telegram WebView. Личный профиль браузера не использовался.

Финальная проверка после локальных исправлений использовала те же штатные Chromium/FFmpeg и явную передачу окружения, порт `62499`. Полный `npm run test:visual` завершился с exit 0 за **857.13 s** (`visual-chromium-observer-result.json`). После завершения listener на этом порту отсутствует. Snapshot сверён по SHA-256 до и после прогона.

## Штатные gates до исправления P1 (история)

Все пути ниже относительно корня worktree, evidence игнорируется Git.

| Проверка | Результат | Evidence |
|---|---|---|
| `DATABASE_URL="$TEST_DATABASE_URL" npm run migrate` | PASS на отдельной локальной БД | `artifacts/issue-178/migrate.log` |
| `npm run test` | PASS: 45 unit + 29 DB/API, 0 failures, 0 skipped | `artifacts/issue-178/test-final.log` |
| `npm run lint` | PASS после CSS-исправления, штатный alias typecheck | `artifacts/issue-178/lint-branding.log`, `static-branding-results.json` |
| `npm run typecheck` | PASS после CSS-исправления | `artifacts/issue-178/typecheck-branding.log`, `static-branding-results.json` |
| `npm run build` | PASS после CSS-исправления: API tsc и web tsc/Vite | `artifacts/issue-178/build-branding.log`, `static-branding-results.json` |
| `npm run test:visual` | **PASS: 286/286, 0 failed, 0 skipped**, exit 0, штатный Chromium | `artifacts/issue-178/full-visual-chromium-observer.log`, `visual-chromium-observer-result.json` |
| `git diff --check` | PASS на текущем snapshot и после оформления отчёта | `artifacts/issue-178/diff-check.log` |
| `MCP_MIGRATION_DATABASE_URL="<пустая локальная БД>" npm exec -- tsx apps/api/test/mcp-migration.ts` | PASS итоговой версии; реальный HTTP/SDK со старым ключом | `artifacts/issue-178/migration-final.log` |

`apps/api/test/mcp-lifecycle.test.ts` включён в штатный `test:isolation`, а не оставлен необязательным скриптом. Проверка миграции отдельно отказывается запускаться на непустой БД; создаёт старую схему с данными, применяет 016 и повторяет весь runner. Сравнивает исходные connection/grants/tasks/write receipts и проверяет прежний ключ, отсутствие новых разрешений и legacy create retry.

## Матрица критериев #178

| Критерий | Проверяемое покрытие |
|---|---|
| Добавить доску без смены ключа | Lifecycle HTTP/SDK: та же connection/key hash, доска появляется в `list_boards`, write доступен после подтверждения |
| Исключить доску, запретить прямой вызов | Lifecycle: list скрывает ID, прямые known-ID calls запрещены; прежний `mcp.test.ts` сохраняет общую tool/tenant матрицу |
| All и новые доски, read/write | Новые pair-доски появляются без edit; отдельно проверены чтение и запрет записи при read; all с нулём досок, selected с пустым списком |
| Rename не меняет доступ | Синтетическое переименование в Reels сохраняет ID, grant и единственную запись; live-причина случая Якова не исследована и не объявляется найденной |
| Downgrade и кэш tools | `tools/list` обновляется; старый SDK клиент напрямую вызывает write-tool и получает `READ_ONLY`; чтение сохраняется |
| Membership loss/rejoin, board state, revoked | `removePairMember` и прямой DB DELETE/INSERT без промежуточного MCP-вызова; all не оживает после rename; draft/frozen/archived запрещают writes; старая selected-матрица остаётся обязательной |
| Rotation | ID/settings/task/receipt сохранены; новый ключ работает, старый получает `AUTH_REQUIRED`; запись в полёте завершается до барьера |
| Параллельные lifecycle intents | Гонки edit/edit, edit/rotate, rotate/rotate, edit/revoke, rotate/revoke: один победитель, версия не теряется. Тот же requestId повторяется; другой payload конфликтует |
| Неизвестный результат и rollback | API fault injection перед event INSERT откатывает edit и rotation целиком. UI теряет ответ до и после сервера: прежний intent повторяется, успешный rotation не повторяется скрыто; отдельное подтверждение recovery |
| Legacy миграция | Пустая disposable БД, старая схема/данные, selected по умолчанию, прежние hash/grants/tasks/receipts, отсутствие расширения и повторное применение всех миграций |
| UI состояния и доступность | `mcp.spec.ts`: list/details/create/edit/secret/lost, режимы и дата, подтверждение diff, отмена, конфликтующий черновик, readback, offline/error/loading/empty, 320/390 px, 200% текста, keyboard/focus, 44 px controls |
| Только owner/app session | Чужая сессия, MCP Bearer без app session, отсутствующий/чужой Origin, non-JSON не дают management; names потерянных досок не возвращаются без актуального membership |
| Hash-only и audit | Проверка DB key_hash, отсутствия plaintext в JSON состояния и lifecycle events, сохранности задач/receipts; screenshot helper скрывает `.mcp-key`, traces/video/автоматические failure screenshots выключены |
| Реальные блокировки | `pg_blocking_pids` подтверждает ожидание; downgrade/removal/rotate/revoke ждут tool transaction. Трёхсторонняя гонка board-holder + tool connection lock + edit выполняет membership deletion без reverse-lock deadlock |
| Контракт/безопасное обновление | Старое правило неизменяемости заменено. Документированы ошибки, receipt/version, exceptions all, порядок миграции/релиза, ограничения rollback и безопасная настройка клиента |

## Просмотренные артефакты

`artifacts/visual-evidence/issue178/` содержит целевые screenshot-состояния. Вручную просмотрены `edit-auto-320.png`, а после полного прогона — `edit-confirmation-390.png`, `rotation-uncertain-320.png`, `secret-390.png`: читаемые названия/предупреждения, видимые подтверждение/отмена и честное uncertain-состояние. Одноразовый секрет скрыт в артефакте. Геометрия/overflow/focus дополнительно проверяются assertions, а не только картинкой. Full-page снимки могут содержать свободное место после короткой формы; это не заменяет отдельную device-проверку клавиатуры.

После CSS-исправления просмотрены `artifacts/visual-evidence/tasca-loading-320.png` и `tasca-auth-error-320.png`: skeleton внутри экрана, сообщение об ошибке не обрезано, общий левый отступ соответствует макету. Скриншоты показывают установившееся состояние; отсутствие мгновенного смещения проверяет отдельный синхронный regression assertion.

Текстовый evidence проверяется `artifacts/issue-178/snapshot.py`: выводит только количество совпадений полного формата MCP-секрета и пути при ошибке, не значения. На проверенном наборе совпадений нет.

## Неуспешные подготовительные прогоны

- Первое `npm ci` унаследовало omit-dev, поэтому `tsx` отсутствовал. Это исправлено установкой **существующих** devDependencies с `--include=dev`; manifest/lockfile не расширены.
- Bundled Chromium отсутствовал. Использован установленный Chrome через явный `PLAYWRIGHT_CHANNEL`, без установки браузера и без личного профиля.
- Первая фоновая visual-команда не получила экспортированный foreground `TEST_DATABASE_URL`; корректно упала на gate. В финальном runner окружение передаётся явно.
- Следующий полный visual-прогон и цепочка lint/build были прерваны при timeout общей оболочки. Их частичный вывод не считается PASS. `npm run test` успел завершиться и перейти к lint: итоговые TAP summaries — 45/45 и 29/29. Остальные gates перенесены в отдельный отслеживаемый runner без короткого foreground timeout.
- После прерывания остался Vite на 4188, поэтому первый новый runner прошёл lint/typecheck/build, но visual корректно остановился на проверке занятого порта. По PID/cwd подтверждён именно собственный процесс mcp-5; он остановлен. Браузерный gate отдельно запущен на проверенном свободном порту 56139 без `reuseExistingServer` и без ослабления tests/assertions.
- Полный набор, в отличие от MCP-сценариев, записывает видео. На двух `create.spec.ts` motion-тестах обнаружен отсутствующий `ffmpeg-1011/ffmpeg-mac`; неполный прогон остановлен. Новые пакеты не устанавливались: подключён существующий системный ffmpeg через task-local registry path. Video не отключалось.
- В малом smoke с рабочим video-helper один motion-замер 320 px показал 109.9 ms при требовании ≥280 ms. Перед повтором общего набора проведено сравнение: неизменённый `HEAD` из `git archive` (только тот же browser-channel selector в test config) и candidate, одинаковый Chrome/ffmpeg, обе ширины с `--repeat-each=3`. Получено **6/6 baseline и 6/6 candidate**; `motion-baseline.log` / `motion-candidate.log`. Это фиксирует наблюдавшуюся нестабильность первого замера, а не доказывает её отсутствие на любом устройстве. Production-код создания, assertions, пороги и таймауты не изменялись.

## Допроверка UI и границы приёмки

### Исправление причины branding-сбоя

Инструментирование прежней проверки поймало `scrollWidth=328` при `innerWidth=320`: у `body` оставался margin `8px`, хотя CSS объявляет `0`. `body.getAnimations()` показал запущенные `CSSTransition` с `currentTime=0`, в том числе переходы margin из `8px` в `0px`. Inline-стиля у body не было. Доказательства: `branding-probe-order.log` (15 passed / 5 failed) и `branding-transitions.log`.

Причина — глобальное правило reduced motion задавало всем элементам `transition-duration: .01ms !important`. Вместе с начальным `transition-property: all` оно не только сокращало существующие переходы, но и создавало новые, в том числе для сброса браузерного margin. Минимальная правка в `apps/web/src/style.css`: `transition: none !important` вместо ненулевой длительности. Такой паттерн уже используется в `landing.css`. Обработчиков `transitionend` в приложении нет; обычный режим движения не затронут.

В существующий `branding.spec.ts` добавлено синхронное воспроизведение сброса browser margin без ожидания кадра: установить `8px`, завершить возникшие переходы, снять inline margin и сразу проверить `0px` и отсутствие overflow. На старом CSS оба сценария упали с `Expected: "0px" / Received: "8px"` (`branding-regression-red.log`); после правки обе ширины по десять повторов прошли **20/20** (`branding-regression-green.log`). Исходные overflow assertions, таймауты и сценарии сохранены. Диагностический обход DOM удалён из теста, новых зависимостей нет.

Полный прогон после CSS-исправления завершился **285 passed / 1 failed**, 984.3 s (`full-visual-chromium-fixed.log`, `visual-chromium-fixed-result.json`). Branding и MCP прошли; упал только `scroll-restore.spec.ts`, 320 px. Диагностика этого сбоя приведена ниже. API/DB-код и его 74 успешно проверенных теста не менялись, что подтверждено прежним manifest; lint/typecheck/build повторены после CSS-правки.

### Исправление готовности scroll-test fixture

Контролируемая задержка ответа шрифта на 2000 ms воспроизвела причину: после готовности списка шрифт ещё `loading`; тест выставлял `scrollY=1200`; `page.screenshot()` ожидал загрузку шрифта, и font swap с browser scroll anchoring менял позицию на `1106`. Приложение затем правильно сохраняло и восстанавливало именно `1106`, но assertion сравнивал с прежним заданием `1200` (ошибка 94 px). Лог `scroll-font-probe.log` содержит все четыре замера и исходное падение.

В общем `openList()` ожидание `document.fonts.ready` перенесено после появления 30 строк, вместо ожидания на ещё пустом skeleton. Исправление покрывает list, kanban и backlog. С тем же медленным шрифтом замеры после прокрутки, screenshot и возврата стали `1200` (`scroll-font-fixed-probe.log`, PASS). Затем весь `scroll-restore.spec.ts --repeat-each=3` прошёл **21/21** (`scroll-font-regression-green.log`). Искусственная сетевая задержка оставлена в двух сценариях возврата как regression coverage; она не заменяет readiness-ожидание. Целевые позиции, tolerance 60 px, таймауты и остальные assertions не изменены; production-логика прокрутки не тронута. Временное логирование удалено.

Общий прогон после этих двух правок завершился **285 passed / 1 failed**, 810.71 s: branding и scroll прошли, остался `record real creation motion 390` с покадровым замером 273.1 ms при нижней границе 280 ms (`full-visual-chromium-final.log`, `visual-chromium-final-result.json`). Все прежние логи сохранены.

### Точный замер длительности состояния создания

Контракт #171 задаёт ориентир около 300 ms после подтверждения сервера, отдельную видеопроверку движения и device/HITL gates. Приложение по-прежнему использует прежний таймер 300 ms; `main.tsx` не менялся. Старый измеритель опрашивал DOM через `requestAnimationFrame`, поэтому начало и конец состояния регистрировались только на ближайших доступных отсчётах. Само значение 273.1 ms не доказывало сокращение production-таймера.

В task-local копии исходной базы добавлен параллельный `MutationObserver`, без изменения приложения. Сохранены 16 обычных пар наблюдений (`motion-dom-probe.log`, `motion-dom-probe-failure.log`) и два калибровочных случая с намеренным пропуском первых 80 ms **только измерителем**, не приложением или видеозаписью. Калибровка дала frame/DOM `226.3/302.8 ms` и `225.3/302.9 ms`: старый assertion упал на обеих ширинах при корректной длительности DOM-состояния (`motion-sampling-calibration.log`). Все 18 наблюдений собраны в `motion-measurement-probes.json`; искусственные случаи явно различаются именем лога.

В `create.spec.ts` покадровый опрос заменён наблюдением за `data-create-state` и заменой DOM через `MutationObserver`. Порог **280 ≤ confirmationMs < 1000 ms**, оба viewport, `no-preference`, haptic assertions и запись видео сохранены. В JSON добавлен `timing: "dom-state"`: это длительность состояния DOM, **не гарантия времени физического показа кадра** и не замена просмотру движения. Старые frame-замеры нельзя сравнивать с новыми как одну метрику. Приложение, таймеры и reduced-motion сценарии не изменялись. Обе ширины по пять повторов прошли **10/10** (`motion-observer-green.log`).

Итоговый общий прогон после исправления измерителя: **286/286 PASS**, без пропусков (`full-visual-chromium-observer.log`, `visual-chromium-observer-result.json`). Копии итоговых motion JSON/video сохранены в `artifacts/issue-178/motion-observer-{320,390}.{json,webm}`, input performance — `input-perf-observer.jsonl`. Размеры и SHA-256 копий записаны в `verified-local-result.json`; генерируемый tracked `artifacts/evidence/input-perf.jsonl` возвращён к исходному содержимому после сохранения evidence.

### История прежних блокеров общего UI gate

**Первый полный прогон на штатном Chromium, до исправлений: 285 passed, 1 failed, 532.19 s.** Остался `branding.spec.ts:8`, 320 px: assertion `document.documentElement.scrollWidth <= innerWidth` на `branding.spec.ts:33`, вызванный из строки 46 на экране «Загрузка приложения». MCP и остальные сценарии прошли. Между первым Chrome-прогоном и этим Chromium-прогоном приложение, tests/assertions и пороги не менялись; менялось только тестовое окружение.

Дополнительное сравнение на исходной базе `58924f41b3b5f22ee5a4e3bab6a603d0262c5cde` с тем же штатным Chromium: `branding.spec.ts --repeat-each=3` дал **5 passed / 1 failed из 6**, с тем же overflow на 320 px и той же строкой вызова 46. Лог — `chromium-branding-baseline.log`. Сбой воспроизводился без изменений #178; на том этапе причина ещё не была установлена, и общая приёмка оставалась заблокированной. Причина и её исправление теперь описаны выше.

Для истории: первый полный прогон завершился, а не был остановлен после первого сбоя: **281/286 passed, 5 failed, 1525.97 s** на установленном Chrome. Все пять сбоев — в сценариях, исходники которых в #178 не менялись:

1. `backlog.spec.ts:14`, 390 px — общий timeout 30 s при ожидании loading-состояния.
2. `backlog.spec.ts:14`, 320 px — общий timeout 30 s на reload.
3. `branding.spec.ts:8`, 320 px — временный horizontal overflow по assertion `scrollWidth <= innerWidth`.
4. `publications.spec.ts:12`, `invalid` — readback ещё `Europe/Moscow` вместо ожидаемого `UTC` после фиксированного ожидания.
5. `scroll-restore.spec.ts:121`, 320 px — `scrollY=1106` при ожидании `>=1190`.

Контрольные сравнения на неизменённой базе и candidate, без правки assertions/порогов:

- `backlog.spec.ts branding.spec.ts`: **4/4 baseline, 4/4 candidate**, `unrelated-baseline.log` / `unrelated-candidate.log`.
- `publications.spec.ts scroll-restore.spec.ts -g 'publication autosave through real API/DB: invalid$|list 320x844: back returns to the original scroll position$'`: baseline **1 passed / 1 failed** (scroll restore), candidate **2/2 passed**, `remaining-baseline.log` / `remaining-candidate.log`.

Эти ранние контрольные прогоны подтверждали нестабильность проверок/окружения, включая воспроизведение scroll-сбоя на старом коде, но сами по себе не устанавливали причину каждого сбоя. Отдельные успешные повторы **не заменяют** общий gate. В дальнейшем исправлены доказанные причины branding и scroll-readiness, а не ослаблены assertions; подробности выше.

Локальная реализация не закрывает родительский выпуск. Перед release #175 обязательны единый интегрированный snapshot и повтор затронутых gates:

- #176: дополнительная chat-доска и все пути удаления общего членства; текущий триггер покрывает удаление строк memberships, но будущие изменения ещё не интегрированы.
- #177: последовательная интеграция общего `mcp.ts`, tool schemas и тестов.
- #182: визуальная приёмка итоговых MCP/settings-экранов.
- Отдельно разрешённые Telegram/device, реальный клиент с тестовым подключением, backup/restore и runtime release/rollback.

Итоговый статус: **code-complete / app-tested локально; сценарии MCP проверены через API/DB/SDK и UI; общий автоматический visual gate PASS; device-tested/production-published — нет**. Код передаётся на review через отдельно разрешённый PR, не на автоматический выпуск. Интеграция #175, реальный клиент и device/HITL-проверки остаются отдельными gates. Merge/deploy не выполнялись; действующий пользовательский ключ не менялся. Issue/Project/Хаб и состояние личной Kanban-карточки не изменялись.

## Передача в общий выпуск #175

- На момент подготовки PR удалённая `main` всё ещё указывает на базу `58924f41b3b5f22ee5a4e3bab6a603d0262c5cde`; существующего PR/task-ветки #178 на origin не найдено. GitHub repo hooks, Actions workflows и deployments вернули пустые списки. Это не доказывает отсутствие внешнего сервиса, самостоятельно следящего за Git; runtime-автоматика на сервере не инспектировалась.
- PR ссылается на #178 и #175 без автоматического закрытия задач. Никакого auto-merge и отдельного production-деплоя. Перед merge обязателен отдельный допуск и проверка внешних автодеплоев согласно #175.
- Порядок интеграции, сверка номера миграции, совместимость API/web, резервное копирование, ограничения rollback и smoke описаны в `docs/issue-178-update.md`. Итоговый общий snapshot и его проверки принадлежат выпуску #175; готовность одного PR их не заменяет.
