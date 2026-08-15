import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { useTelegramEnvironment } from './environment';
import { isSettingsNavigation, type NavigationState } from './navigation';

export type IconName = 'tasks' | 'plus' | 'settings' | 'close' | 'chevron' | 'alert' | 'sun' | 'clock' | 'noDeadline';

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
    noDeadline: <path d="M5 12h14"/>
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

export function ChoiceSheet({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const sheet = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheet.current?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')?.focus();
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
  return <div className="sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section ref={sheet} className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={handleKeyDown}><header><h2 id={titleId}>{title}</h2><IconButton label="Закрыть" onClick={onClose}><Icon name="close"/></IconButton></header>{children}</section></div>;
}

export const Sheet = ChoiceSheet;

export function ActionRow({ label, value, icon, ...props }: { label: string; value: ReactNode; icon?: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className="action-row" type="button" {...props}>{icon && <span className="action-row-icon">{icon}</span>}<span className="action-row-copy"><span>{label}</span><strong>{value}</strong></span><Icon name="chevron"/></button>;
}

export function Disclosure({ label, children, defaultOpen = false }: { label: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  return <section className="disclosure"><button type="button" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen((value) => !value)}><span>{label}</span><Icon name="chevron"/></button>{open && <div id={contentId}>{children}</div>}</section>;
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

export function CreateScreen({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return <section className="create-screen"><header><IconButton label="Закрыть" onClick={onClose}><Icon name="close"/></IconButton><h1>Новая задача</h1></header>{children}</section>;
}