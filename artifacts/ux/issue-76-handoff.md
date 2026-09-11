# UX-handoff #76: согласованные макеты и решения

Родитель программы: [#75](https://github.com/MilevskyYakov/tg-task-kanban/issues/75). Дизайн-этап: [#76](https://github.com/MilevskyYakov/tg-task-kanban/issues/76).

Это индекс принятого дизайна, а не второй задачник. Scope, реализация и статусы работ принадлежат GitHub Issues #77–#83. Файл `.pen` остаётся единственным каноном композиции; `visual-contract-v2.md` — каноном визуальной системы. Этот handoff уточняет только перечисленные новые сценарии и последние решения владельца, которые имеют приоритет над историческим backlog.

## Статус и границы

- Владелец принял пакет создания/бэклога («DВсе хорошо принято»), пакет парной доски («Окей, норм») и групповой пакет («ок»).
- Затем отдельно приняты изображение и формат одного сообщения: изображение сверху, согласованный текст подписью, кнопка «Открыть задачи».
- Предложенная переделка блокеров отклонена: «Не обязательно, уже в целом норм сделано там все». Новый экран установки блокера из канбана/деталей не рисуется и не реализуется в этом цикле. Это не отменяет уже принятую возможность задать начальный статус «Блокер» при создании в #77.
- Публикация решений, commit и PR разрешены отдельным «Да». Изменения кода приложения, merge, закрытие Issues и deploy этим не разрешены.
- Физические Telegram-устройства, реальная отправка ботом, работа API/DB и доступ из MCP этим дизайном не проверены.

## Создание и бэклог: #77–#78

### #77 — срок и начальный статус

- Срок: «Без срока», «Только дата», «Дата и время». Отсутствие срока не получает скрытую дату. Только дата означает выбранный день целиком, а не просрочку с начала дня.
- Доступны `todo` («К выполнению»), `in_progress`, `waiting` («Блокер») и `done`, с сохранением действующих прав. Недопустимое завершение задачи другого исполнителя не становится разрешённым при создании.
- Начальный «Блокер» требует задачи той же доски либо внешней причины. Это принятые экраны создания `blocker320` / `blockerTask390`, не заказ на переделку существующих блокеров в #81.
- Ошибка сохраняет форму; ожидание сервера и запрет повторного нажатия видимы; очистка происходит только после подтверждённого успеха.
- Семантика часового пояса date-only и совместимость старых точных timestamps должны быть проверены по текущей модели перед реализацией #77. Макеты не определяют часовой пояс сервера и не разрешают переинтерпретировать старые полуночные сроки.

### #78 — сбор и разбор

- Бэклог содержит только неархивные задачи `todo` без исполнителя. Новый статус не создаётся. Вход заметен независимо от фильтра «Мои».
- Неназначенные «В работе», «Блокер» и «Готово» сохраняют статусы и доступны через «Все» с соответствующими фильтрами; архив остаётся отдельно.
- «Взять себе» атомарно назначает текущего участника и оставляет `todo`. При конкуренции второй участник видит актуальный результат, а не перезаписывает исполнителя.
- «Создать и добавить ещё» сохраняет **только доску и проект**. Название/описание, исполнитель и срок очищаются; статус — «К выполнению», приоритет — обычный. Дополнительные параметры возвращаются к обычным значениям новой задачи, а не наследуются случайно. Повторение и уведомления не переносятся скрыто.
- Вставка списка: отдельная задача из каждой непустой строки, без исполнителя и срока, в выбранной доске/проекте. До отправки есть предпросмотр и исправление невалидных строк. Сознательно одинаковые названия не запрещаются.
- При частичном результате показывается, что сохранено; текст остальных строк остаётся. Повтор отправляет только неподтверждённые элементы и не создаёт дубли уже сохранённых задач.

Обзоры:
- [Создание](exports/issue-76/review-01-create.png).
- [Срок, статус и список](exports/issue-76/review-02-fields-and-list.png).
- [Бэклог и взятие себе](exports/issue-76/review-03-backlog.png).

## Парная доска и общий вход: #79–#80

- Создатель-владелец и один приглашённый участник работают без Telegram-группы. Личная доска не превращается в общую. Групповые публикации не появляются в парной доске.
- Владелец управляет приглашением, отзывом ссылки и отзывом доступа; приглашённый может выйти. Отзыв не равен удалению данных.
- При выходе или отзыве доступа второго участника доска, задачи и история остаются у владельца. С **всех** задач ушедшего участника снимается только исполнитель: статусы, сроки, авторство, содержание и история сохраняются. Нет автоматического переназначения и ограничения только незавершёнными задачами.
- Новый участник перед принятием приглашения явно видит предупреждение, что получит доступ ко всей прежней истории доски.
- Вместо ухода владельца — архив доски: обоим текущим участникам доступ только для чтения; восстановление доступно владельцу. Архив не возвращает доступ ранее отозванному участнику. Передача владения и удаление данных не добавляются.
- Общий вход предлагает личные задачи, доску на двоих и доску для группы. Приглашение и групповой deep link ведут в соответствующий контекст без повторного общего приветствия. Помощь доступна отдельно.

Обзоры:
- [Вход и создание](exports/issue-76-pair/review-01-entry.png).
- [Приглашение](exports/issue-76-pair/review-02-invite.png).
- [Доступ и архив](exports/issue-76-pair/review-03-access.png).

## Группа и постоянное сообщение: #80

При подключении бот один раз отправляет **сразу правильное постоянное сообщение**. Пользователь закрепляет его и дальше входит через ту же кнопку. Первичная настройка при необходимости находится за этой кнопкой; повторный вход ведёт сразу к задачам доски.

Конечный формат одного сообщения:

1. Изображение `assets/group-welcome.png` сверху.
2. Подпись, без замены текста картинкой:

   **Задачи команды · {Название доски}**

   Добавляйте задачи, берите их в работу и отслеживайте выполнение.

3. Кнопка **«Открыть задачи»**.

Одна общая иллюстрация используется для всех досок. Она не содержит названия группы, текста и водяных знаков. В макетах «Студия» — демонстрационное название, не фиксированное имя доски.

**Исключено:** `/refresh_board`, обновление/миграция старых закрепов, обязательное редактирование setup-сообщения после активации, массовые рассылки, автоматическое закрепление и дополнительные права ради него. Повторная активация не должна создавать поток сообщений. Это не исключает обработку ошибок первоначальной отправки и защиту от повторной обработки события.

Обзоры:
- [Подключение и первое открытие](exports/issue-76-group/review-01-connect.png).
- [Повторный вход и ошибки](exports/issue-76-group/review-02-return.png).

**Граница визуального evidence:** `Mt93Z` / `a8ltz` и соответствующий обзор показывают принятый текстовый вариант сообщения до добавления иллюстрации. Картинка принята отдельно позднее и пока не встроена в эти roots/PNG. Конечный формат выше имеет приоритет; нельзя реализовать текстовый вариант без изображения по старому PNG. Совмещённый макет сообщения с изображением не экспортировался, Telegram smoke не выполнялся.

## Второстепенные экраны: #81

Предложенный дополнительный пакет не выбран. Блокеры оставляются как есть; общего редизайна настроек, деталей и других второстепенных экранов не заказывается. Изменения, необходимые для уже согласованных #77–#80, остаются у этих Issues. Не выдавать отказ от переделки за устранение обнаруженного browser prompt и не придумывать новые дефекты без проверки.

## Проверка и ограничения

- Новые roots и PNG сверяются по индексу ниже. Ширины макетов — 390/320 px; PNG экспортированы в масштабе 2× (780×1688 / 640×1688).
- Старые roots относительно базового commit сохранены без изменений. Метаданные новых roots отмечены `approved`; название `REVIEW` сохранено для стабильности идентификаторов.
- В пакетах есть клавиатура, пустые состояния, ожидание, ошибки, отказы в доступе, успех и возврат; это выборочные состояния сценариев, а не полный декартов набор.
- Статические макеты не доказывают focus trap, Escape/return focus, 200% text sizing, работу экранного диктора, Telegram iOS/Android, API, права и безопасный retry. Эти проверки выполняются при реализации и в #83.
- #82 (MCP) остаётся отдельным design/security prerequisite. Подключение и права MCP в этом пакете не спроектированы и не реализованы.
- Следующий implementation slice — #77 после принятия PR и отдельной команды. Публикация handoff не запускает реализацию автоматически.

## Индекс roots и экспортов

Всего 73 новых экранов: создание/бэклог — 30, парная доска/общий вход — 28, группа — 15.

| Ключ сценария | Root | PNG |
|---|---|---|
| `create390` | `Sdz9h` | [Sdz9h.png](exports/issue-76/Sdz9h.png) |
| `create320` | `cB3S3` | [cB3S3.png](exports/issue-76/cB3S3.png) |
| `repeat320` | `zHwrT` | [zHwrT.png](exports/issue-76/zHwrT.png) |
| `createError390` | `yTIZh` | [yTIZh.png](exports/issue-76/yTIZh.png) |
| `createEmpty320` | `uTv4e` | [uTv4e.png](exports/issue-76/uTv4e.png) |
| `createPending390` | `WmPFO` | [WmPFO.png](exports/issue-76/WmPFO.png) |
| `date390` | `o0vJF` | [o0vJF.png](exports/issue-76/o0vJF.png) |
| `time320` | `W7qlq` | [W7qlq.png](exports/issue-76/W7qlq.png) |
| `status390` | `JSfCt` | [JSfCt.png](exports/issue-76/JSfCt.png) |
| `blocker320` | `NDMgo` | [NDMgo.png](exports/issue-76/NDMgo.png) |
| `blockerTask390` | `yStWf` | [yStWf.png](exports/issue-76/yStWf.png) |
| `doneDenied320` | `uGULp` | [uGULp.png](exports/issue-76/uGULp.png) |
| `bulkInput390` | `AXayo` | [AXayo.png](exports/issue-76/AXayo.png) |
| `bulkInput320` | `odeg0` | [odeg0.png](exports/issue-76/odeg0.png) |
| `bulkPreview390` | `Dbuh3` | [Dbuh3.png](exports/issue-76/Dbuh3.png) |
| `bulkInvalid320` | `NtS1L` | [NtS1L.png](exports/issue-76/NtS1L.png) |
| `bulkPartial320` | `lPLU0` | [lPLU0.png](exports/issue-76/lPLU0.png) |
| `bulkSuccess390` | `XIzTW` | [XIzTW.png](exports/issue-76/XIzTW.png) |
| `backlog390` | `s6q7KC` | [s6q7KC.png](exports/issue-76/s6q7KC.png) |
| `backlog320` | `MYJcO` | [MYJcO.png](exports/issue-76/MYJcO.png) |
| `backlogEmpty320` | `A40bTY` | [A40bTY.png](exports/issue-76/A40bTY.png) |
| `backlogLoading320` | `ANQdZ` | [ANQdZ.png](exports/issue-76/ANQdZ.png) |
| `backlogError320` | `c056uD` | [c056uD.png](exports/issue-76/c056uD.png) |
| `claim390` | `bWQgu` | [bWQgu.png](exports/issue-76/bWQgu.png) |
| `claimSuccess320` | `chZN9` | [chZN9.png](exports/issue-76/chZN9.png) |
| `claimConflict320` | `z0t2J` | [z0t2J.png](exports/issue-76/z0t2J.png) |
| `createFull320` | `gGLc5` | [gGLc5.png](exports/issue-76/gGLc5.png) |
| `additional320` | `DSXUE` | [DSXUE.png](exports/issue-76/DSXUE.png) |
| `allUnassigned390` | `PsEb9` | [PsEb9.png](exports/issue-76/PsEb9.png) |
| `afterCreate390` | `nraEi` | [nraEi.png](exports/issue-76/nraEi.png) |
| `pair_entry390` | `bqIas` | [bqIas.png](exports/issue-76-pair/bqIas.png) |
| `pair_entry320` | `L0WVM` | [L0WVM.png](exports/issue-76-pair/L0WVM.png) |
| `pair_help390` | `npSQr` | [npSQr.png](exports/issue-76-pair/npSQr.png) |
| `pair_create390` | `N1036` | [N1036.png](exports/issue-76-pair/N1036.png) |
| `pair_createKeyboard320` | `a7c7nj` | [a7c7nj.png](exports/issue-76-pair/a7c7nj.png) |
| `pair_createError320` | `IKMHt` | [IKMHt.png](exports/issue-76-pair/IKMHt.png) |
| `pair_createPending320` | `s4PAd` | [s4PAd.png](exports/issue-76-pair/s4PAd.png) |
| `pair_inviteOwner390` | `IrPrV` | [IrPrV.png](exports/issue-76-pair/IrPrV.png) |
| `pair_inviteCopied320` | `q4HZw` | [q4HZw.png](exports/issue-76-pair/q4HZw.png) |
| `pair_inviteAccept390` | `ZTphs` | [ZTphs.png](exports/issue-76-pair/ZTphs.png) |
| `pair_inviteAccept320` | `NEjho` | [NEjho.png](exports/issue-76-pair/NEjho.png) |
| `pair_inviteInvalid320` | `e6Yf6Z` | [e6Yf6Z.png](exports/issue-76-pair/e6Yf6Z.png) |
| `pair_inviteFull320` | `ebrDo` | [ebrDo.png](exports/issue-76-pair/ebrDo.png) |
| `pair_joined390` | `c5Jz5` | [c5Jz5.png](exports/issue-76-pair/c5Jz5.png) |
| `pair_accessOwner390` | `cmayM` | [cmayM.png](exports/issue-76-pair/cmayM.png) |
| `pair_accessMember320` | `W2nECZ` | [W2nECZ.png](exports/issue-76-pair/W2nECZ.png) |
| `pair_revoke320` | `kxuK3` | [kxuK3.png](exports/issue-76-pair/kxuK3.png) |
| `pair_leave320` | `G6GU1` | [G6GU1.png](exports/issue-76-pair/G6GU1.png) |
| `pair_revokeSuccess390` | `w8PuI` | [w8PuI.png](exports/issue-76-pair/w8PuI.png) |
| `pair_replace390` | `Tdtvn` | [Tdtvn.png](exports/issue-76-pair/Tdtvn.png) |
| `pair_left320` | `M4LG89` | [M4LG89.png](exports/issue-76-pair/M4LG89.png) |
| `pair_archive390` | `wdq7f` | [wdq7f.png](exports/issue-76-pair/wdq7f.png) |
| `pair_archivedOwner390` | `pN9RU` | [pN9RU.png](exports/issue-76-pair/pN9RU.png) |
| `pair_archivedMember320` | `e7mo7` | [e7mo7.png](exports/issue-76-pair/e7mo7.png) |
| `pair_restoreError320` | `FW3dp` | [FW3dp.png](exports/issue-76-pair/FW3dp.png) |
| `pair_archiveError320` | `kqFwC` | [kqFwC.png](exports/issue-76-pair/kqFwC.png) |
| `pair_linkRevoke320` | `fM2TZ` | [fM2TZ.png](exports/issue-76-pair/fM2TZ.png) |
| `pair_linkRevoked390` | `oWrP0` | [oWrP0.png](exports/issue-76-pair/oWrP0.png) |
| `group_guide390` | `o0rLp` | [o0rLp.png](exports/issue-76-group/o0rLp.png) |
| `group_guide320` | `J3685Y` | [J3685Y.png](exports/issue-76-group/J3685Y.png) |
| `group_picker320` | `eGWeX` | [eGWeX.png](exports/issue-76-group/eGWeX.png) |
| `group_message390` | `Mt93Z` | [Mt93Z.png](exports/issue-76-group/Mt93Z.png) |
| `group_pinned320` | `a8ltz` | [a8ltz.png](exports/issue-76-group/a8ltz.png) |
| `group_setup390` | `L5Quf` | [L5Quf.png](exports/issue-76-group/L5Quf.png) |
| `group_setupPending320` | `enKbF` | [enKbF.png](exports/issue-76-group/enKbF.png) |
| `group_setupError320` | `gd5t8` | [gd5t8.png](exports/issue-76-group/gd5t8.png) |
| `group_wait320` | `ZGBtf` | [ZGBtf.png](exports/issue-76-group/ZGBtf.png) |
| `group_empty390` | `sEwFq` | [sEwFq.png](exports/issue-76-group/sEwFq.png) |
| `group_loading320` | `vvHVw` | [vvHVw.png](exports/issue-76-group/vvHVw.png) |
| `group_error320` | `T549Er` | [T549Er.png](exports/issue-76-group/T549Er.png) |
| `group_frozen390` | `Lrv10` | [Lrv10.png](exports/issue-76-group/Lrv10.png) |
| `group_return390` | `GW4vT` | [GW4vT.png](exports/issue-76-group/GW4vT.png) |
| `group_return320` | `NLWVz` | [NLWVz.png](exports/issue-76-group/NLWVz.png) |

## Файл иллюстрации

- [group-welcome.png](assets/group-welcome.png) — PNG 1672×941, 894491 байт.
- SHA-256: `60913eb886a11733ed4a0765043b148f462d82e6eeb11f1d0611e96a150494c0`.
- Самостоятельный сгенерированный asset, не screenshot приложения и не результат работы Telegram API.
