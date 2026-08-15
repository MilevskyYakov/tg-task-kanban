import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { useTelegramEnvironment } from './environment';
import { isSettingsNavigation, type NavigationState } from './navigation';

export type IconName = 'tasks' | 'plus' | 'settings' | 'close' | 'chevron' | 'alert' | 'sun' | 'clock' | 'noDeadline' | 'project' | 'assignee' | 'calendar' | 'board' | 'sliders' | 'back' | 'more' | 'attach' | 'send' | 'priority';

export function Icon({ name }: { name: IconName }) {
  const paths = {
    tasks: <><path d="M8 6h11M8 12h11M8 18h11"/><path d="m3 6 1 1 2-2m-3 7 1 1 2-2m-3 7 1 1 2-2"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    chevron: <path d="m8 10 4 4 4-4"/>,
    alert: <><path d="M12 3 2.8 20h18.4Z"/><path d="M12 9v5m0 3h.01"/></>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    noDeadline: <path d="M5 12h14"/>,
    project: <><path d="M3 7h7l2 2h9v10H3z"/><path d="M3 7V5h7l2 2"/></>,
    assignee: <><circle cx="12" cy="8" r="4"/><path d="M5 21a7 7 0 0 1 14 0"/></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4m8-4v4M3 10h18"/><circle cx="15.5" cy="15.5" r="2.5"/></>,
    board: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    sliders: <><path d="M4 7h6m4 0h6M4 17h2m4 0h10"/><circle cx="12" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></>,
    back: <path d="m15 18-6-6 6-6"/>,
    more: <><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></>,
    attach: <path d="m20.5 11.5-8.4 8.4a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 1 1-2.8-2.8l8.5-8.5"/>,
    send: <><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></>,
    priority: <><path d="M5 21V4"/><path d="M5 5h11l-2 4 2 4H5"/></>
  };
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

export function AppShell({ children, message, navigation, navigate, hideNavigation = false }: { children: ReactNode; message: string; navigation: NavigationState; navigate: (next: NavigationState) => void; hideNavigation?: boolean }) {
  return <main className={`app-shell${hideNavigation ? ' fullscreen' : ''}`}>
    <EnvironmentStatus/>
    <div className="app-content">{children}</div>
    {message && <p className="app-message" role="status">{message}</p>}
    {!hideNavigation && <BottomNavigation navigation={navigation} navigate={navigate}/>}
  </main>;
}

export function EnvironmentStatus() {
  const online = useTelegramEnvironment();
  return online ? null : <p className="offline-banner" role="status">Нет сети. Загруженные данные доступны; изменения могут не сохраниться.</p>;
}

export function Skeleton({ label = 'Загрузка' }: { label?: string }) {
  return <div className="skeleton" role="status" aria-label={label}><span/><span/><span/><span/></div>;
}

function BottomNavigation({ navigation, navigate }: { navigation: NavigationState; navigate: (next: NavigationState) => void }) {
  return <nav className="bottom-navigation" aria-label="Основная навигация">
    <button className={navigation.screen === 'tasks' ? 'active' : ''} aria-current={navigation.screen === 'tasks' ? 'page' : undefined} onClick={() => navigate({ screen: 'tasks' })}><Icon name="tasks"/><span>Задачи</span></button>
    <button className="create" aria-label="Создать задачу" onClick={() => navigate({ screen: 'create' })}><Icon name="plus"/></button>
    <button className={isSettingsNavigation(navigation) ? 'active' : ''} aria-current={isSettingsNavigation(navigation) ? 'page' : undefined} onClick={() => navigate({ screen: 'settings' })}><Icon name="settings"/><span>Настройки</span></button>
  </nav>;
}

export function IconButton({ label, children, ...props }: { label: string; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className="icon-button" aria-label={label} {...props}>{children}</button>;
}

export function TaskGlyph() {
  return <span className="task-glyph" aria-hidden="true"><span/><span/><svg viewBox="0 0 32 32"><defs><radialGradient id="task-glyph-gradient" cx="35%" cy="28%"><stop stopColor="#8ec5ff"/><stop offset=".62" stopColor="#2f79ed"/><stop offset="1" stopColor="#1452b8"/></radialGradient></defs><circle cx="16" cy="16" r="15" fill="url(#task-glyph-gradient)"/><path d="m9.5 16 4.5 4.5 8.5-9" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg></span>;
}

export function SectionHeader({ children, count, tone = 'upcoming' }: { children: ReactNode; count: number; tone?: 'overdue' | 'today' | 'upcoming' | 'none' }) {
  return <header className="section-header" data-tone={tone}><span>{children}</span><strong aria-label={`${count} задач`}>{count}</strong></header>;
}

export function resolveFocusIndex(current: number, count: number, shift: boolean): number | null {
  if (count === 0) return null;
  if (shift && current === 0) return count - 1;
  if (!shift && current === count - 1) return 0;
  return null;
}

export function resolveChoiceIndex(current: number, count: number, key: string): number | null {
  if (count === 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowDown' || key === 'ArrowRight') return (current + 1) % count;
  if (key === 'ArrowUp' || key === 'ArrowLeft') return (current - 1 + count) % count;
  return null;
}

export function ChoiceSheet({ title, children, onClose, className = '' }: { title: string; children: ReactNode; onClose: () => void; className?: string }) {
  const sheet = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (sheet.current?.querySelector<HTMLElement>('[aria-checked="true"]')
      ?? sheet.current?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'))?.focus();
    return () => previousFocus.current?.focus();
  }, []);
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { onClose(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...(sheet.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])') ?? [])];
    const current = focusable.indexOf(document.activeElement as HTMLElement);
    const next = resolveFocusIndex(current, focusable.length, event.shiftKey);
    if (next !== null) { event.preventDefault(); focusable[next]?.focus(); }
  };
  return <div className="sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section ref={sheet} className={`sheet ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={handleKeyDown}><header><h2 id={titleId}>{title}</h2>{!className.includes('task-sheet') && <IconButton label="Закрыть" onClick={onClose}><Icon name="close"/></IconButton>}</header>{children}</section></div>;
}

export const Sheet = ChoiceSheet;

export function ActionRow({ label, value, icon, ...props }: { label: string; value: ReactNode; icon?: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className="action-row" type="button" {...props}>{icon && <span className="action-row-icon">{icon}</span>}<span className="action-row-copy"><span>{label}</span><strong>{value}</strong></span><Icon name="chevron"/></button>;
}

export function ChoiceRow({ label, detail, selected, kind = 'radio', onKeyDown, ...props }: { label: string; detail?: string; selected: boolean; kind?: 'radio' | 'check' } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`choice-row${selected ? ' selected' : ''}`} type="button" role={kind === 'radio' ? 'radio' : 'checkbox'} aria-checked={selected} tabIndex={kind === 'radio' && !selected ? -1 : undefined} onKeyDown={(event) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || kind !== 'radio') return;
    const choices = [...(event.currentTarget.closest('[role=radiogroup]')?.querySelectorAll<HTMLButtonElement>('[role=radio]:not([disabled])') ?? [])];
    const next = resolveChoiceIndex(choices.indexOf(event.currentTarget), choices.length, event.key);
    if (next === null) return;
    event.preventDefault(); choices[next]?.focus(); choices[next]?.click();
  }} {...props}><span className="choice-marker" aria-hidden="true"/><span><strong>{label}</strong>{detail && <small>{detail}</small>}</span></button>;
}

export function Disclosure({ label, children, defaultOpen = false, icon }: { label: string; children: ReactNode; defaultOpen?: boolean; icon?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  return <section className="disclosure"><button type="button" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen((value) => !value)}>{icon}<span>{label}</span><Icon name="chevron"/></button>{open && <div id={contentId}>{children}</div>}</section>;
}

export function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field-row"><span>{label}</span>{children}</label>;
}

export function Avatar({ initials, label }: { initials: string; label: string }) {
  return <span className="avatar" role="img" aria-label={label}>{initials}</span>;
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'urgent' | 'blocker' }) {
  return <span className="badge" data-tone={tone}>{children}</span>;
}

export function TasksScreen({ children, boardName, onSelectBoard }: { children: ReactNode; boardName: string; onSelectBoard: () => void }) {
  return <><header className="page-header"><div className="title-row"><h1>Задачи</h1><TaskGlyph/></div><button className="board-selector" onClick={onSelectBoard}>{boardName}<Icon name="chevron"/></button></header>{children}</>;
}

export function SettingsScreen({ children, title = 'Настройки', subtitle }: { children: ReactNode; title?: string; subtitle?: string }) {
  return <><header className="settings-header"><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</header>{children}</>;
}

export function CreateScreen({ children, boardName, onClose, onSelectBoard }: { children: ReactNode; boardName: string; onClose: () => void; onSelectBoard: () => void }) {
  return <section className="create-screen"><header><IconButton label="Закрыть" onClick={onClose}><Icon name="close"/></IconButton><h1>Новая задача</h1><button className="create-board-selector" type="button" onClick={onSelectBoard}>{boardName}<Icon name="chevron"/></button></header>{children}</section>;
}