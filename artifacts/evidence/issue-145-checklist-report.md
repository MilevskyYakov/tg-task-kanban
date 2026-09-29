# #145 — подтверждение завершения с незакрытым чек-листом

## Ревизия и границы

- Issue: https://github.com/MilevskyYakov/tg-task-kanban/issues/145; parent #140 не закрывается этой работой.
- База: `e761631dadc6c6b79e2634eb415323936a90aabd`; ветка `MilevskyYakov/issue-145`.
- На момент завершения реализации результат находился в рабочем дереве, без commit/PR/merge/deploy. Точный проверенный исходный код и web build зафиксированы в `issue-145-source-manifest.json` рядом с отчётом. Последующий разрешённый `/taskfinish` фиксирует commit/PR/merge в GitHub trail #145.
- SHA-256 исходного manifest: `7e8381d2563d187f93a47be70dc370b1073909f84424a285ccb6c25dcaa5fd02`.
- После `git fetch origin` база совпадала с `origin/main`, checkout был чистым. Worktree #134 больше не присутствовал, открытых PR не было; чужие worktree и их файлы не менялись.
- Разрешены реализация #145 и отдельная подготовка локальных зависимостей/тестовой PostgreSQL. Хаб, Telegram/Kanban, parent, другие Issues и production не менялись.

## Исправление

1. `ApiError.incompleteChecklist` различает checklist-ответ по статусу 409 и валидному положительному целому счётчику, а не по тексту сообщения. Остальные 409 остаются отдельными ошибками.
2. Карточка открывает существующий доступный `Sheet`: количество незавершённых пунктов, «Отмена», «Завершить». Очередь приостановлена до решения; online/blur/выход не выполняют скрытое подтверждение.
3. Согласие отправляет `confirmIncompleteChecklist: true` только для одной попытки и показанной версии. Rebase, retry и reload не наследуют согласие. Отказ/Escape возвращают серверную status/blocker-группу, сохраняя независимые изменения и не уничтожая невалидный локальный ввод.
4. Изменение чек-листа в общих DB helpers обновляет задачу внутри того же board lock и транзакции. Уже существующий trigger увеличивает `revision`. Новый пункт, смена текста/отметки или удаление инвалидируют устаревшее подтверждение REST/MCP; новой миграции нет.
5. Соседний completion flow списка/канбана использует ту же типизированную причину ошибки и передаёт `expectedVersion`. Серверные проверки прав, доски и версии не ослаблены.
6. Recovery потерянного успешного ответа учитывает серверную очистку blocker-полей при выходе из `waiting`. Старые скрытые значения не создают ложный конфликт, если оба статуса уже не `waiting`; различающиеся статусы по-прежнему конфликтуют.
7. Публичные request/response schemas, права checklist/status и семантика MCP receipts сохранены. Подтверждение не отмечает пункты выполненными. Уточнение ревизии добавлено в существующий `docs/issue-82-mcp-contract.md`.

## Окружение и воспроизведение

Установлены объявленные lockfile-зависимости командой `npm ci --include=dev` — exit 0. Новые библиотеки не добавлялись, manifests/lockfile не изменены. Окружение: Node.js 22.22.3, npm 10.9.8, Playwright 1.59.1, установленный Chromium и PostgreSQL 14.23. БД `issue145_test` — отдельный cluster в `artifacts/evidence/issue-145-runtime/pgdata`, TCP только `127.0.0.1:5499`, без production URL. Существующие миграции применены: `DATABASE_URL="$TEST_DATABASE_URL" npm run migrate` — exit 0.

Первый запуск PostgreSQL не прошёл из-за ограничения macOS на длину Unix socket path; повторный запуск отключил Unix socket (`-k ''`), сохранив loopback TCP. Данные и логи не размещались в OS temp.

После итоговой проверки cluster штатно остановлен: `pg_ctl ... -m fast -w stop` сообщил `server stopped`; последующий `pg_ctl ... status` — `no server running`. Слушателей 5499, 4173 и 4175 нет. Тестовые данные и логи оставлены в task workspace.

До правок реализации запущен новый browser/API/DB regression:

```sh
NODE_ENV=production PLAYWRIGHT_PORT=4175 npm run screenshots -w @task/web -- completion.spec.ts --grep 'API/DB: accept' --timeout 15000
```

Exit 1: настоящий PATCH вернул 409, ожидаемый диалог «Завершить задачу?» отсутствовал. Это текущая репродукция, не заимствованный результат аудита #140. После #143 baseline уже различал version conflict; оставалась необработанная checklist-ошибка.

Расширенный промежуточный прогон — 12/13 PASS, exit 1: lost-response после `waiting → done` дал ложный конфликт из-за очищенных сервером blocker-полей. Исправлена общая семантика сравнения неактивных полей, добавлен unit regression. Первоначальный полный background-run остановился до выполнения тестов из-за неунаследованного `TEST_DATABASE_URL`; повторный запуск передал переменную явно. Ни один из этих прогонов не засчитан как итоговый PASS.

Полный прогон на порту 4175: 129/131 PASS, exit 1. Оба отказа — MCP connection UI: `mcp.spec.ts` задаёт `publicUrl` и `Host` с портом 4173, но передаёт фактический Origin браузера. Сервер корректно ответил 403 на Origin 4175. Штатный 4173 проверен свободным; весь gate повторён на нём. Тесты, серверная Origin-защита и конфигурация приложения ради зелёного результата не менялись.

## Итоговые автоматические проверки

Все данные синтетические. Browser использует настоящий Fastify через `app.inject` и изолированную PostgreSQL; Telegram launch/auth подменены. Отдельные `details.spec.ts` проверки управляют mock PATCH для точного порядка ответов. Они не заменяют DB gate.

| Команда | Exit | Фактический результат |
|---|---:|---|
| `npm run test` | 0 | 42 unit + 16 API/DB/isolation; skipped 0 |
| `node --import tsx --test apps/api/test/issue-url.test.ts` | 0 | 1/1 |
| `npm run lint` | 0 | штатный TypeScript gate |
| `npm run typecheck` | 0 | API + web |
| `npm run build` | 0 | web + API |
| `git diff --check` | 0 | без whitespace errors |
| `NODE_ENV=production PLAYWRIGHT_PORT=4173 npm run test:visual` с явным `TEST_DATABASE_URL` | 0 | 131/131, 4.4 минуты; без skipped |

`PERF_PHASE=issue-145-final-4173` и абсолютный `PERF_EVIDENCE_DIR` направляют итоговые метрики в task workspace. Логи находятся в `artifacts/evidence/issue-145-runtime/`: `reproduction.log`, `completion.log`, `completion-expanded.log`, `tests-final.log`, `issue-url-final.log`, `lint-final.log`, `typecheck-final.log`, `build-final.log`, `browser-final.log`, `browser-final-db.log`, `browser-final-4173.log`. Runtime-папка локально исключена из Git; отчёт и source manifest предназначены для последующей разрешённой публикации.

После полного browser-run SHA-256 всех исходников и build-файлов из manifest повторно совпали. Повторный `git fetch origin` подтвердил `HEAD...origin/main = 0/0`; новых изменений базы для интеграции нет. После последующих правок evidence выполнен `git diff --check`.

### Покрытие критериев

- Согласие, отказ, Escape, обычное завершение, редактирование уже done: реальные browser/API/DB сценарии в `completion.spec.ts`, повторное чтение PostgreSQL и reload UI.
- Независимое описание сохраняется при отказе; исходный `waiting` и внешняя причина остаются. Дополнительные mock-response сценарии проверяют свежий текст, набранный во время задержанного failed PATCH.
- Новый checklist item и независимая новая версия в открытом диалоге: старое согласие получает 409, повторный запрос идёт без согласия, диалог показывается заново. Изменение самого статуса открывает обычный конфликт и требует явного выбора.
- Reload открытого диалога не восстанавливает согласие. Потерянный успешный ответ проверяется чтением backend, без повторного завершения или отметки пунктов.
- Выход до debounce не прячет диалог. Online event не отправляет задачу до решения. Focus trap, безопасный начальный фокус на «Отмена» и Escape проверены.
- `task-collaboration.test.ts`: изменения/переключения/удаление пункта обновляют ревизию; stale approval отклоняется; пустой checklist не требует согласия; чужой пользователь, frozen/archived board и archived task не получают право записи; denied mutation не меняет ревизию; два writer одной версии дают 200/409.
- `mcp.test.ts`: CHECKLIST_CONFIRMATION_REQUIRED, VERSION_CONFLICT после checklist mutation, успешное новое согласие, идемпотентный replay и текстовое изменение done без повторного согласия. Остальной MCP/isolation suite не исключался.
- Read-only UI, сохранность drafts/conflicts, blur/exit, описание/GitHub link, ввод/прокрутка и соседние сценарии входят в полный штатный browser gate.

## Визуальное evidence

Скриншоты: `artifacts/visual-evidence/issue145-completion-{width}x{height}-{textSize}.png`:

- 390×844 / 100%;
- 320×844 / 100%;
- 320×520 / 100%;
- 1280×900 / 100%;
- 320×844 / 200% текста.

Проверены отсутствие горизонтального overflow, достижимость кнопки завершения и клавиатурный фокус. Скриншоты короткого viewport, 200% и desktop осмотрены: диалог и оба решения читаемы, отдельного перекрытия composer поверх диалога нет. При 200% заголовок переносится внутри слова; контент и действия доступны через существующую прокручиваемую Sheet.

## Ограничения и внешняя приёмка

- Browser gate использует **production React в локальном Vite server**, не production deployment. Development StrictMode не объявлен PASS: ранее выявленный baseline-дефект lifecycle Autosave (`stop()` при пробном effect cleanup, отчёт #144) в эту задачу не включён и здесь не исправлялся.
- `npm audit --omit=dev` — exit 1, одна moderate уязвимость существующего `undici@7.29.0`: GHSA-3wwx-pv8p-q78v (WebSocket permessage-deflate DoS). Зависимости этой задачей не обновлялись, `npm audit fix` не запускался. Это отдельное ограничение baseline, не зелёный security gate.
- Реальные Telegram iOS/Android/Desktop, реальные аккаунты, live delivery и production не проверялись. Это не device/provider PASS.
- На точном build из source manifest остаются HITL-шаги: согласие/отказ в каждом Telegram-клиенте; закрытие/reopen с ожидающим подтверждения черновиком; потеря/возврат сети; клавиатура и фокус в коротком WebView. Выполнять только после отдельного разрешения на device/account доступ.
- До команды `/taskfinish` commit, публикация evidence в Issue/PR, merge, закрытие #145, изменение parent #140 и deploy не выполнялись. Команда разрешила repository closeout; deploy/device-доступ и следующая задача не входят в неё.

## Проверка при `/taskfinish`

На неизменном candidate повторно проверены source/build hashes и свежий `origin/main`; новых коммитов базы не обнаружено. Повторные `npm run test:unit` (42/42), `npm run lint`, `npm run typecheck`, `npm run build` и `git diff --check` завершились exit 0. Полные 16 API/DB + 1 issue-url и 131 browser результатов выше относятся к тому же исходному candidate, а не к старому baseline. Новые логи: `closeout-unit.log`, `closeout-lint.log`, `closeout-typecheck.log`, `closeout-build.log`.

Хаб-fate: `repo-only` в силу явной границы #145/#140; technical closeout записывается в Issue/PR и parent, без изменения Хаба, Telegram/Kanban и плана дня. Постоянный `main` содержит чужой untracked `artifacts/ux/task-details-approved-comparison.png`; файл и checkout оставлены без изменений. Orca-worktree #145 сохраняет свою task-ветку; его итоговый статус проверяется после merge.
