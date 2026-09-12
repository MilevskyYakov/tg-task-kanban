# Telegram Mini App accessibility and device checklist

Version: 2026-08-14
Scope: Issue #36

## Automated browser readiness

Checked with a mocked Telegram WebApp contract and representative task data.

- [x] 390 × 844: Tasks, Kanban, Create, Task details, and Settings render without horizontal document overflow.
- [x] 320 × 844: Tasks, Kanban, Create, Task details, and Settings render without horizontal document overflow.
- [x] Telegram light and dark color schemes select the matching application palette.
- [x] System `prefers-color-scheme` is used when Telegram does not provide a color scheme.
- [x] Fallback foreground/background token pairs meet WCAG AA; checked ratios range from 5.52:1 to 15.99:1 for primary and muted text.
- [x] All icon-only buttons on canonical screens have accessible names.
- [x] Task details accessibility tree contains no unnamed buttons, textboxes, comboboxes, checkboxes, or links.
- [x] Keyboard Tab traversal reaches visible controls in task details without a trap.
- [x] Offline status is announced with `role="status"` while loaded data remains visible.
- [x] Loading uses named skeleton status; empty and request error states remain explicit text with retry where applicable.
- [x] Reduced-motion preference disables skeleton and existing interface animation.

Browser screenshot evidence is generated during review and intentionally not committed as product source.

## Physical Telegram device gate

Run before release on current Telegram builds. This remains a device-only release check, not browser evidence.

### iOS Telegram

- [ ] 390 × 844 or nearest available device: top content clears status/header safe area.
- [ ] Bottom navigation, create action, sheets, and comment composer clear home indicator.
- [ ] Light and dark Telegram themes update without reopening Mini App.
- [ ] VoiceOver announces page heading, icon-only controls, task status, fields, errors, and offline status.
- [ ] External keyboard can reach and activate every control; focus remains visible.

### Android Telegram

- [ ] 320 px or nearest narrow device: no clipped controls or horizontal page scroll.
- [ ] Bottom navigation, sheets, and fixed actions clear system gesture/navigation area.
- [ ] Light and dark Telegram themes update without reopening Mini App.
- [ ] TalkBack announces page heading, icon-only controls, task status, fields, errors, and offline status.
- [ ] Hardware keyboard can reach and activate every control; focus remains visible.

## Доска на двоих — #79

Этот раздел относится к текущему light-only контракту #76, а не к историческим theme checks #36 выше. Это локальная проверка реализации, не разрешение на релиз и не evidence физического Telegram.

### Выполнено локально

- `npm run test`: 32 unit-проверки и 11 API/DB-проверок прошли, без пропусков. Использована отдельная PostgreSQL-БД `issue79_utf8` на `127.0.0.1:55479`, кодировка UTF8; миграции применялись только к ней.
- `npm run lint`, `npm run typecheck`, `npm run build`, `git diff --check` прошли. `lint` является alias для typecheck.
- `npm run test:visual`: 43 проверки прошли. Новые сценарии находятся в `apps/web/visual/pair.spec.ts`; screenshots генерируются в игнорируемом `artifacts/visual-evidence/pair-*.png`.
- Проверены создание с безопасным повтором, предупреждение о прежней истории до вступления, вместимость при конкурентном принятии, owner-only управление, отзыв ссылки отдельно от доступа, выход, архив и восстановление.
- Сохранение задач, статусов, сроков, авторства и истории при снятии исполнителя проверено на уровне БД, включая завершённые и архивные задачи. Повтор отзыва не затрагивает заменившего участника; подтверждение UI сохраняет исходного адресата.
- Проверены проекты, задачи, бэклог, чек-лист, комментарии, ссылки-вложения, повторения, личное уведомление и отсутствие групповых публикаций. Архив блокирует изменения и scheduler повторений; ранее отозванный доступ не восстанавливается.
- Две изолированные браузерные сессии прошли создание, приглашение, вступление, комментарий и отзыв через настоящий API/DB. Только Telegram bootstrap/auth подменён тестовым контрактом. Это не два реальных Telegram-аккаунта.
- Экраны создания и принятия просмотрены на 390/320 px, подтверждения и ошибки — на 320 px. Уведомления об ошибках/успехе доступны через `alert`/`status`; переход фокусирует заголовок. Попиксельная автоматическая parity всех roots этим не заявляется.

### Остаётся перед релизом — #83

- [ ] Два реальных Telegram-аккаунта: отправить ссылку из Mini App, принять, открыть именно приглашённую доску без группы.
- [ ] На обоих аккаунтах создать/изменить задачи, добавить комментарий и проверить личное уведомление исполнителю.
- [ ] Отозвать доступ при открытых деталях второго участника; проверить повторный вход и прямую ссылку, сохранность истории у владельца.
- [ ] Проверить выход, замену участника с предупреждением о прежней истории, архив у обеих ролей и восстановление только владельцем.
- [ ] iOS/Android: clipboard/share, soft keyboard, safe areas, VoiceOver/TalkBack, увеличение текста до 200%.
- [ ] Отдельное разрешение владельца на deploy. В рамках #79 deploy не выполнялся.
