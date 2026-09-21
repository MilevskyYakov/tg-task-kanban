# #100 — production smoke расширенного MCP из Hermes

Дата: 2026-09-22. Родитель: [#95](https://github.com/MilevskyYakov/tg-task-kanban/issues/95). Канон задачи: [#100](https://github.com/MilevskyYakov/tg-task-kanban/issues/100).

## Кандидат и деплой

- Предыдущий known-good: `e2f2ccf` (зафиксирован до pull), новый production SHA: `2a1d55d` — кандидат блоков #96–#99 (`MilevskyYakov/issue-98` #111, `MilevskyYakov/mcp-4` #110) поверх #97/#103/#108.
- Деплой строго по [release-runbook](release-runbook.md): backup `task-20260921T192031Z.dump` (260K), restore smoke в одноразовую БД `task_restore_smoke` (boards count OK, БД удалена), `git pull --ff-only`, `docker compose build`, миграции 007–014 applied (013 receipts, 014 вложения уже в кандидате; новых миграций #99 нет — receipts переиспользуют 013), `up -d app`.
- `/health` локальный и `https://task.kairos-ai.ru/health` — `{"status":"ok"}`, контейнер healthy. Restart gate: `docker compose restart app` → health OK, логи за 10 минут без ошибок и секретов.
- Гейты на итоговом main (`2a1d55d`) до деплоя: typecheck OK, build OK, unit 32/32, isolation 13/13 (тестовая PostgreSQL, миграции 001–014).

## Ключ

- Старый отозванный ключ #82 не восстанавливался. Фаза 2 выполнена в минимальном виде: владелец подключил Hermes к уже активному полноправному подключению (`write`, все разрешённые ему доски), созданному ранее в приложении. Новый ключ `Hermes_new` (2026-09-21) в Hermes не переносился как избыточный; остаточные подключения (`Hermes1`, `Hermes_new`, `КОДЕКС`, `Владик`) подлежат отзыву владельцем после smoke.
- Discovery Hermes: 20 tools (было 11 write/5 read на момент #82). Новые: `get_task_collaboration`, `add_task_comment`, `add_checklist_item`, `update_checklist_item`, `delete_checklist_item`, `add_task_attachment`, `list_recurrences`, `create_recurrence`, `update_recurrence`.

## Фактический production smoke (2026-09-22)

Синтетика на личной доске владельца, маркер `[SMOKE100]`, боевые карточки не читались и не менялись; поисковые запросы — точные уникальные названия.

| Проверка | Результат |
|---|---|
| `list_boards` | 4 разрешённые доски, пользователь и режим `write` прочитаны; `nextCursor: null` |
| `create_project` (#97) | `[SMOKE100] Проект` создан; повтор с тем же requestId → `replayed: true`, тот же id |
| `create_task` со всеми полями (#96) | Заголовок, описание, projectId, `urgent`, deadline date+timezone — прочитаны обратно через `get_task` точно |
| `update_task` статус | `todo` → `in_progress`, версия `1` → `2` |
| Устаревший expectedVersion | `VERSION_CONFLICT` 409, без перезаписи |
| `add_task_comment` (#98) | Комментарий создан; requestId-повтор → `replayed: true`, в БД один экземпляр |
| `add_checklist_item` + `update_checklist_item` (#98) | Пункт добавлен, отмечен выполненным, `completedByUserId` — владелец подключения |
| `add_task_attachment` (#98) | Ссылка-вложение добавлена, URL прочитан обратно |
| `get_task_collaboration` (#98) | Комментарии/чек-лист/вложения/timeline (`created`, `updated`, `checklist_added`, `checklist_updated`); telegram-идентификаторов в DTO нет |
| `create_recurrence` weekly (#99) | `wd=[3]`, 09:30 Europe/Moscow, `nextOccurrenceAt=2026-10-07T06:30Z`; requestId-повтор → та же серия |
| Пауза / возобновление (#99) | `paused=true` → `next=null`; `paused=false` → `next` пересчитан |
| Архив серии (#99) | Исчезла из активного `list_recurrences`, видна с `showArchived: true` |
| `archive_task` / restore (#96) | Архив и восстановление OK, `archived` флаг прочитан обратно |
| `update_project` архив / restore (#97) | Архив и восстановление OK; задача проекта осталась доступной |
| Тот же requestId, другое действие | `REQUEST_CONFLICT` |
| Поиск по точному названию | Ровно 1 карточка, без посторонних |

Запросы выполнялись через MCP endpoint production (`/mcp`) из текущей сессии Hermes. Каждая запись прочитана обратно отдельным чтением; ключи, chat IDs и тексты боевых задач в отчёт не включены.

## UI-сверка

Проект `[SMOKE100] Проект` владелец подтвердил в приложении. Архивные карточку и серию владелец в UI не открывал; их состояние подтверждено независимым read-only SQL readback на сервере (обе записи `archived = true`) и MCP-чтением. Это граница доказательства, не дефект.

## Состояние после smoke и cleanup

Карточка, проект и серия заархивированы средствами самого MCP (архив — контрактная операция, удаления нет). Активных smoke-сущностей 0; ничего обходным путём не удалялось.

Не проверялось в production: уведомления исполнителям (синтетические карточки без боевых пользователей), Telegram-файлы во вложениях (по контракту вне MCP), read-only подключение (локально доказано isolation-тестами), отзыв ключа из той же сессии (отложено владельцем: активные подключения `Hermes1`, `Hermes_new`, `КОДЕКС`, `Владик` подлежат ручному отзыву).

## Итог

#100 выполнен: деплой по runbook, перевод ключа, полный production smoke #96–#99 из Hermes, docs обновлены ([контракт](issue-82-mcp-contract.md), [инструкция](../README.md)). После закрытия #100 закрывается родитель #95.
