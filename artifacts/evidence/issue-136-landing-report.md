# #136 — адаптивный лендинг Таски

## Подготовленный результат

Лендинг реализован в состоянии `outside` существующего приложения. Mini App сохраняет свой путь авторизации. Использованы принятые светлый опал, Manrope, Таска и «Дела под рукой». Показаны реальные сценарии: личная доска, доска на двоих, группа; обучение из трёх шагов. Изображение приложения — актуальный локальный screenshot с синтетическими данными, не production.

CTA получает фактический `BOT_USERNAME` через `/api/bot-entry` с `Cache-Control: no-store`. Новый бот не включён в defaults. При ошибке конфигурации нет выдуманной рабочей ссылки: показаны ошибка и повтор. Для недоступного Telegram есть инструкция и имя бота. Невалидный внешний URL отвергается.

Title/description, favicon, Open Graph и изображение ссылки подготовлены. OG image указывает на действующий `task.kairos-ai.ru`; этот старый origin должен сохраняться при переезде. Новый canonical не активирован. Маршруты API, webhook, health, MCP, включая неизвестные пути и `/api`, возвращают JSON, а не HTML лендинга.

## Проверка

База `98fb9fc` (PR #165); точные хэши исходников/ресурсов и browser-статистика в `issue-136-verification.json`.

- `npm run test`: unit и isolation PASS (26 isolation tests); PostgreSQL UTF-8 на loopback, только синтетические данные.
- `npm run lint`, `npm run typecheck`, `NODE_ENV=production npm run build`: PASS.
- `npm run test:public-entry` после build: PASS, реальный Fastify + PostgreSQL + собранные assets; GET/POST/auth/неизвестные API и MCP проверены без redirect.
- Полная Playwright-матрица: **243 PASS**, 0 failed/skipped/flaky, три shard: 85 + 146 + 12. Команда каждого: `NODE_ENV=production npm run screenshots -w @task/web -- --reporter=json --shard=N/3`, `PLAYWRIGHT_PORT=4173`, изолированная `TEST_DATABASE_URL`.
- Первый shard предшествует единственной последующей HTML-правке: абсолютному URL OG image. Build и затронутые landing/branding сценарии повторены во втором shard на итоговом HTML; runtime-код первого shard не менялся.
- Размеры 1440×1000, 390×844, 320×844, 320×520; основной CTA в первом viewport. Keyboard skip link, touch target ≥44px, отсутствие горизонтального overflow при 200% тексте, fallback font и отключённом backdrop-filter.
- Контраст главного CTA `#FFFFFF` / `#1C664B`: **6.88:1** (расчёт WCAG).
- Ошибки JS, загрузка preview, отказ Telegram SDK, недоступная/враждебная конфигурация CTA проверены. Имитация Telegram SDK не является проверкой устройства.
- Production build: JS 384.65 kB / gzip 113.04 kB, CSS 76.27 kB / gzip 14.34 kB. Screenshot WebP 25 618 bytes, favicon 5 391 bytes, OG PNG 397 583 bytes (не загружается лендингом). Новых зависимостей/аналитики нет.

Снимки mobile/desktop — `artifacts/evidence/issue-136/`. Сырые результаты — локально в `artifacts/evidence/tasca-preparation-runtime/136-*`, не включены в Git.

## Открытые gates

Production не обновлялся. Реальная цепочка «внешний браузер → Telegram → первый вход», кэш превью Telegram, physical-device приёмка и финальные адреса остаются в #138/#140/#164. #136 не закрывать только по локальной приёмке. Публикация: включить эту ревизию в единый финальный пакет, без отдельного промежуточного deploy.
