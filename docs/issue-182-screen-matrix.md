# #182 — матрица настроек и вложенных экранов

## Статус и границы

Владелец принял v2 и фактический UI, затем отдельно принял исправления четырёх замечаний: публикации, детали MCP, помощь MCP и фокус заголовка. Реализация и автоматические проверки завершены на объединённом кандидате #176/#178/#182. Это не приёмка общего релиза #175 и не device PASS.

S — Настройки; W — Рабочее пространство; A — Автоматизация; C — Аккаунт; M — C / Подключения. Пути ниже — переходы пользователя, не URL. Для каждой строки есть фактический React-рендер. Колонка состояний задаёт проверочный охват, но не обещает отдельного изображения каждой комбинации.

Reference — имя принятого образца или пояснение исходной инвентаризации. Исходные line numbers в инвентаризации исторические; актуальные точки входа: `main.tsx`, `SettingsScreen`, `NameSetting`, `PublicationSetting`, `McpConnections`, `PairScreen`/`PairBoard`/`PairInvite`, `EntryGuide`/`GroupSetup`, `chat-boards.tsx`.

Рендеры лежат локально в `artifacts/visual-evidence/`; пути намеренно даны текстом, поскольку изображения не публикуются как исходники. Полная галерея — `issue-182-implementation/index.html`, четыре исправления — `issue-182-implementation/review.html`. В `supplementary/` и `review/` API синтетический. Остальные сценарии используют harness, описанный в [отчёте](issue-182-verification.md); Telegram во всех браузерных проверках тестовый.

| ID | Экран / путь | Проверяемые состояния | Reference | Представитель фактического UI |
|---|---|---|---|---|
| S01 | S / первый экран | Счётчики загружены/не загружены, длинное имя | —, первый экран не переделывается | `issue182-root-390-844-100.png` |
| W01 | S / W / список досок | Personal/chat/pair; active/frozen/archived; пустой/длинный список | workspace — только общий язык карточек | `issue182-workspace-list-390-844-100.png` |
| W02 | W / доска / название | Owner/admin редактирует; member читает; архив/заморозка блокируют поля | workspace | `issue147-board-choice-race-conflict-390x844-100.png` |
| W03 | W / доска / проекты | Список активных, пустой, длинные названия; название; архив | workspace | `issue147-project-choice-race-conflict-390x844-100.png` |
| W04 | W / доска / новый проект | Пустое/валидное/слишком длинное имя, pending, ошибка, повторный submit | workspace | `issue182-workspace-390-844-100.png` |
| W05 | W / доска / участники | Имена, username/без username, длинный список | workspace | `issue182-workspace-390-844-100.png` |
| A01 | S / A / список досок | Те же варианты досок; без создания Pair | — | `issue182-automation-list-390-844-100.png` |
| A02 | A / доска / форма повтора | daily/weekdays/weekly/monthly, название, время, timezone, start/end, ошибки создания и сохранённый ввод | recurrence | `issue-182-implementation/supplementary/A02-Ежемесячно-390-100.png` |
| A03 | A / повтор / Период | Радиовыбор четырёх частот, возврат фокуса, Escape | selector — общий стиль, не тот же тип выбора | `issue182-selector-Период-390-844-100.png` |
| A04 | A / повтор / Проект | Без проекта; только неархивные проекты; длинный список | — | `issue182-selector-Проект-390-844-100.png` |
| A05 | A / повтор / Исполнитель | Без ответственного; участники | — | `issue182-selector-Исполнитель-390-844-100.png` |
| A06 | A / повтор / Приоритет | normal/urgent в базе; финальная модель #177 ещё не интегрирована | recurrence | `issue182-selector-Приоритет-390-844-100.png` |
| A07 | A / существующие повторы | Активный/приостановленный; пустой список; ошибка pause/resume | recurrence | `issue182-automation-390-844-100.png` |
| A08 | A / Публикации в чат | Disclosure закрыт/открыт; только active chat; незагруженные/недоступные schedules | publication — проектирование #176 | `issue-182-implementation/review/publication-panel-390-100.png` |
| A09 | A / публикации / План дня | Enabled; weekdays 1–7; time; timezone; статусы; все Feedback-состояния | publication | `issue146-publication-390x844-100.png` |
| A10 | A / публикации / Недельная сводка | Независимые поля дневной и недельной сводки; самостоятельное состояние сохранения | publication | `issue-182-implementation/supplementary/A11-preview-390-100.png` |
| A11 | A / публикации / Предпросмотр | Успех с многострочным текстом, ошибка, невалидные поля блокируют кнопку | — | `issue-182-implementation/supplementary/A11-preview-390-100.png` |
| A12 | A / Уведомления | Информационный блок, не новые глобальные параметры | recurrence | `issue182-automation-390-844-100.png` |
| C01 | S / C / профиль и параметры | Профиль; haptic on/off, ошибка localStorage; длинные данные | account | `issue182-account-390-844-100.png` |
| C02 | C / Группировка задач | По срокам/проектам; выбор, закрытие, фокус | — | `issue182-selector-Группировка задач-390-844-100.png` |
| C03 | C / Обычная доска | Все доски и доступные доски; изменения сохраняются локально | — | `issue182-selector-Обычная доска-390-844-100.png` |
| M01 | M / список подключений | loading/empty/error/retry/pagination; active/revoked; lost membership; auto/selected в #178 | — | `issue-182-implementation/supplementary/M01-list-error-390-100.png` |
| M02 | M / Новое подключение | Имя, доски, режим, invalid, loading boards, offline, pending, uncertain retry | mcp-edit — общие поля, не создание | `issue178/create-390.png` |
| M03 | M / создание или редактирование / Доступные доски | Поиск, несколько выбранных, пустой результат, загрузка/ошибка/retry; неактивная доска; применить/отмена | selector | `issue178/boards-390.png` |
| M04 | M / Ключ создан | Однократный показ, копирование ключа/адреса; отказ clipboard, выход без копирования; pagehide; 401/revoked | mcp-secret, только DEMO | `issue178/clipboard-error-390.png` |
| M05 | M / Ключ не получен | Ключ создан, но ответ потерян; явный перевыпуск или отзыв доступа | — | `issue178/lost-390.png` |
| M06 | M / подключение / детали | Active/revoked; read/write; нет досок; неактивные доски; lost/rejoin exclusion; срок/адрес/ключ скрыт | — | `issue-182-implementation/review/connection-390-100.png` |
| M07 | M / Выйти без сохранения? | Создание; #178 редактирование; остаться/закрыть | — | `issue-182-implementation/supplementary/M07-leave-draft-390-100-part2.png` |
| M08 | M / Закрыть без сохранения ключа? | Подключение остаётся активным; однократный показ, остаться/закрыть | — | `issue-182-implementation/supplementary/M08-leave-secret-390-100-part2.png` |
| M09 | M / Выйти без проверки результата? | Неопределённый исход создания/сохранения/rotation; предупреждение и явное закрытие | — | `issue-182-implementation/supplementary/M09-leave-uncertain-390-100-part2.png` |
| M10 | M / Отозвать доступ? | Warning про задачи и уже прочитанные данные; pending/offline; ошибка readback/повтор; отмена | pair-archive — только общая типографика предупреждений | `issue178/revoke-390.png` |
| M11 | M / Войдите снова через Telegram | Истёкшая сессия; секрет очищен, навигация скрыта | — | `issue-182-implementation/supplementary/M11-expired-390-100.png` |
| H01 | M / помощь / Общая настройка | Адрес, авторизация, проверка; clipboard успех/ошибка; длинный URL | mcp-help | `issue-182-implementation/review/help-390-100.png` |
| H02 | M / помощь / Hermes | Команды подключения/проверки, вопросы терминала, запрет ключа в чат | — | `issue178/help-390.png` |
| H03 | M / помощь / Claude Code | Регистрация, скрытый ввод, запуск, /mcp, окружение; ограничения shell | — | `issue178/help-claude-390.png` |
| H04 | M / помощь / Codex CLI | Регистрация с env-var, запуск, /mcp, ограничения окружения | — | `issue178/help-codex-390.png` |
| H05 | M / помощь / Claude.ai / Desktop | Beta Request headers; OAuth-only не подходит; риск общего ключа организации | — | `issue178/help-claude-app-390.png` |
| P01 | W / Создать доску на двоих | Пустое имя, pending, ошибка, идемпотентный retry | — | `pair-create-390.png` |
| P02 | W / Pair / Доступ | Owner/member; второй участник есть/нет; загрузка и ошибка участников | — | `issue182-pair-access-390-844-100.png` |
| P03 | Pair / Приглашение | До создания ссылки/ссылка создана; copy/share; ошибка | — | `issue182-pair-invite-390-844-100.png` |
| P04 | Pair / Новый участник | Участник удалён/место свободно; вся прежняя история видна новому | — | `issue182-pair-replace-390-844-100.png` |
| P05 | Pair / Отозвать доступ | Конкретный участник, задачи без исполнителя; stale participant, pending/error/cancel | — | `issue182-pair-revoke-390-844-100.png` |
| P06 | Pair / Выйти из доски | Member, warning про историю и исполнителей, потерянный ответ/retry/cancel | — | `issue-182-implementation/supplementary/P06-leave-390-100.png` |
| P07 | Pair / Архив доски | Подтверждение, pending, неизвестный результат и «Проверить состояние» | pair-archive | `issue182-pair-archive-390-844-100.png` |
| P08 | Pair / Доска в архиве | Owner восстанавливает/member нет; читать задачи; ошибка восстановления | — | `issue182-pair-archived-390-844-100.png` |
| P09 | Pair / Отозвать ссылку | Уже вступивший не теряет доступ; pending/error/cancel | — | `issue182-pair-link-revoke-390-844-100.png` |
| P10 | Pair / Приглашение больше не действует | Создать новое приглашение; история видна | — | `issue182-pair-link-revoked-390-844-100.png` |
| P11 | Pair / Доступ отозван | Итог удаления участника; прежние задачи/история; повторное приглашение | — | `issue182-pair-removed-390-844-100.png` |
| P12 | Pair / Доступ закрыт | Итог выхода; к моим задачам | — | `issue-182-implementation/supplementary/P12-left-390-100.png` |
| P13 | Вход по приглашению Pair | Preview/loading/error, full, unavailable, уже вступил; согласие на историю | —, соседняя поверхность того же компонента | `pair-accept-390.png` |
| E01 | S / Помощь / Как начать | Общая помощь, три пути; пояснение autosave и серий | — | `entry-help-390.png` |
| E02 | Помощь / Личные задачи | Инструкция и переход к личной доске | — | `issue-182-implementation/supplementary/E02-personal-guide-390-100.png` |
| E03 | Помощь / Доска на двоих | Инструкция и переход к Pair create | — | `entry-pair-guide-390.png` |
| E04 | Помощь / Доска для группы | Загрузка bot-entry, ошибка/retry, внешняя кнопка Telegram | —, внешний переход не выполнялся | `entry-group-guide-390.png` |
| E05 | W или A / неактивная chat-доска / Первый запуск | Admin форма; member ждёт admin; loading/error; неизвестный результат активации | — | `entry-group-setup-390.png` |
| E06 | W или A / замороженная chat-доска | Перехватывается GroupSetup, не обычным editor; проверка состояния/возврат в группу | — | `entry-group-frozen-390.png` |
| E07 | Потеря доступа к открытой доске | Общий экран «Доступ закрыт» и возврат | — | `issue176-access-revoked-390.png` |
| N01 | M / Редактировать подключение (#178) | Name, selected/all, read/write; ключ прежний; empty selected допустим; stale/conflict, offline, pending, uncertain | mcp-edit | `issue178/edit-auto-390.png` |
| N02 | M / Подтвердить настройки доступа? (#178) | Добавятся/исключатся/итог; повышение до write; auto включая личные/будущие; cancel/pending | mcp-confirm | `issue178/edit-confirmation-390.png` |
| N03 | M / Перевыпустить ключ? (#178) | Старый ключ перестаёт работать; однократный показ; конфигурация прежняя; pending/unknown/check/cancel/conflict | — | `issue178/rotated-secret-390.png` |
| N04 | Чат / список досок / Добавить доску (#176) | Admin; название; подтверждение существующего состава перед второй доской; изменившийся состав; pending/unknown/error | — | `issue176-confirmation-390.png` |
| N05 | A / общие публикации чата / выбор досок (#176) | Отдельный состав каждого расписания; новая доска не включается сама; пустой выбор означает отсутствие отправки | publication | `issue176-empty-summary-390.png` |
| N06 | A / конфликт прежних расписаний (#176) | Прежний режим сохранён до явного выбора; переход заблокирован без сброса настроек | — | `issue-182-implementation/supplementary/N06-schedule-conflict-390-100-part2.png` |
| N07 | A / результат длинной публикации (#176) | Подтверждённый отказ и неизвестный исход; без скрытого повтора | — | `issue-182-implementation/supplementary/N07-unknown-delivery-390-100.png` |
| N08 | Приглашения общего чата (#176) | Предупреждение о доступе ко всем доскам; общий состав; не Pair | — | `issue-182-implementation/supplementary/N08-shared-access-390-100-part2.png` |

## Сквозные проверки

- Имена и публикации: autosave, pending/saving/saved, validation/network/storage errors, reload/offline/recovery, обе стороны конфликта, повторный конфликт, поздние ответы, смена доски, 401/403/404, отзыв членства, frozen/archived.
- MCP: edit сохраняет ключ; rotation, неопределённые результаты, requestId/версии, clipboard, lost membership/rejoin, revoked, предупреждения расширения доступа и безопасный выход. Действующий пользовательский ключ не использовался.
- Селекторы и диалоги: доступные имена, выбранное состояние, Tab/Shift+Tab/Escape, возврат фокуса, ограничения закрытия при pending.
- 320/390 px, 200% текста, уменьшенный viewport, длинные значения, light-only, зоны касания, отсутствие горизонтального overflow. Квадрат программного фокуса заголовка убран без отключения клавиатурного фокуса кнопок.

Новая модель оценки #177 и фильтры #181 не внедрялись в этой ветке. При их объединении в #175 нужно проверить окончательные варианты настроек повторов и личных параметров; все 65 строк и затронутые состояния сверяются снова с итоговым кодом. Реальный Telegram, iOS/Android и скринридеры остаются gates общего релиза, а не результатом этих рендеров.
