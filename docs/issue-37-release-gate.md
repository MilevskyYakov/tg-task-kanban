# Issue #37 — release gate нового Telegram UX

Version: 2026-08-14  
Release candidate base: `b6963a4` (`origin/main` после закрытия #27–#36)  
Статус: **candidate deployed, GO заблокирован**, пока не пройдены Telegram device smoke и webhook delivery.

Этот файл хранит только обезличенный release evidence. Не добавлять tokens, cookie, `initData`, chat IDs, production identifiers или тексты задач.

## 1. Automated gate

- [x] Все зависимости #27–#36 закрыты merged PR.
- [x] Чистая установка: `npm ci --include=dev` — 0 vulnerabilities.
- [x] `TEST_DATABASE_URL=... npm run test` — unit 26/26, isolation 8/8.
- [x] `npm run lint` — проходит; script является alias для typecheck.
- [x] `npm run typecheck` — проходит.
- [x] `npm run build` — проходит.
- [x] Миграции `001`–`007` применяются с нуля на PostgreSQL 14.
- [x] Local browser smoke с mocked Telegram WebApp contract: list, create, details, kanban и settings на 390 × 844; settings на 320 × 844; horizontal document overflow отсутствует.
- [x] Публичный `/health` отвечает `200 {"status":"ok"}`; это проверка текущего deployment, не release candidate.

## 2. Telegram device smoke

Проверять candidate после deploy по `docs/release-runbook.md`. Для каждого устройства записать модель, ОС, версию Telegram, дату и `pass/fail`; без пользовательских данных.

### iOS Telegram, 390 × 844 или ближайшее устройство

- [ ] Onboarding открывает экран задач.
- [ ] Запуск из рабочего чата временно выбирает связанную доску; обычный запуск возвращает сохранённую доску.
- [ ] Список переключает «По срокам / По проектам»; поиск и фильтры сохраняются.
- [ ] Центральный `+` открывает полноэкранное создание; ошибка API не стирает введённые данные.
- [ ] Детали открываются полноэкранно; edit, checklist, comment и attachment работают.
- [ ] Kanban показывает одну колонку; tabs, swipe и явная смена статуса работают.
- [ ] Create, edit, complete, block и unblock завершаются без потери контекста.
- [ ] Settings открывает «Рабочее пространство / Автоматизация / Аккаунт» и дочерние экраны.
- [ ] Publication task link открывает нужную задачу; Back возвращает контекст доски.
- [ ] Light/dark theme меняется без перезапуска; safe areas, VoiceOver и keyboard focus проходят checklist #36.

### Android Telegram, 320 px или ближайшее узкое устройство

- [ ] Onboarding открывает экран задач.
- [ ] Запуск из рабочего чата временно выбирает связанную доску; обычный запуск возвращает сохранённую доску.
- [ ] Список переключает «По срокам / По проектам»; поиск и фильтры сохраняются.
- [ ] Центральный `+` открывает полноэкранное создание; ошибка API не стирает введённые данные.
- [ ] Детали открываются полноэкранно; edit, checklist, comment и attachment работают.
- [ ] Kanban показывает одну колонку; tabs, swipe и явная смена статуса работают.
- [ ] Create, edit, complete, block и unblock завершаются без потери контекста.
- [ ] Settings открывает «Рабочее пространство / Автоматизация / Аккаунт» и дочерние экраны.
- [ ] Publication task link открывает нужную задачу; Back возвращает контекст доски.
- [ ] Light/dark theme меняется без перезапуска; safe areas, TalkBack и keyboard focus проходят checklist #36.

## 3. Rollback readiness

Старый pilot UI: `745b8994853f4281d57e56f601d55b13c6d0e4db`.

- [x] Commit существует и собирается из clean detached worktree командой `npm ci --include=dev && npm run build`.
- [x] После pilot UI добавлена только миграция `007_task_blockers.sql`; она создаёт additive таблицу и не требует schema rollback для возврата старого кода.
- [x] Перед deploy записан фактический previous-known-good production SHA: `745b8994853f4281d57e56f601d55b13c6d0e4db`.
- [x] Создан production backup и пройден restore smoke в отдельную БД; восстановлены 4 доски.
- [ ] Проверена команда code rollback из `docs/release-runbook.md` с фактическим previous-known-good SHA.

`745b899` — аварийный old-UI fallback, не замена записи фактически развёрнутого SHA перед cutover.

## 4. Production gate

Live cutover выполняется только после явного подтверждения владельца.

- [x] Владелец подтвердил cutover.
- [x] Deploy candidate `b6963a48aa45a14ce8212e2a156ecf22c3f8620e` и миграции завершены без ошибок.
- [x] Internal и public health возвращают `200`.
- [ ] Telegram smoke выше пройден на iOS и Android.
- [x] Логи за последние 15 минут не содержат secrets или новых ошибок.
- [x] При restart не появились дополнительные recurrence tasks или publication runs.
- [ ] Telegram webhook принимает реальные updates: endpoint и secret проходят synthetic `200`, но Telegram `getWebhookInfo` пока сообщает `Connection timed out` и 2 pending updates.
- [ ] Итог: `GO / ROLLBACK`.

## 5. Закрытие

После `GO`: приложить в PR только команды, агрегированные результаты и обезличенное device evidence; merge PR; отметить #37 в #23 и закрыть umbrella #23. При любом незакрытом checkbox release gate остаётся открытым.
