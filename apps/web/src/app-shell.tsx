import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { NavigationState } from './navigation';

type IconName = 'tasks' | 'plus' | 'settings' | 'close';

function Icon({ name }: { name: IconName }) {
  const paths = {
    tasks: <><path d="M8 6h11M8 12h11M8 18h11"/><path d="m3 6 1 1 2-2m-3 7 1 1 2-2m-3 7 1 1 2-2"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
    close: <path d="m6 6 12 12M18 6 6 18"/>
  };
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

export function AppShell({ children, message, navigation, navigate }: { children: ReactNode; message: string; navigation: NavigationState; navigate: (next: NavigationState) => void }) {
  return <main className="app-shell">
    <div className="app-content">{children}</div>
    {message && <p className="app-message" role="status">{message}</p>}
    <BottomNavigation navigation={navigation} navigate={navigate}/>
  </main>;
}

function BottomNavigation({ navigation, navigate }: { navigation: NavigationState; navigate: (next: NavigationState) => void }) {
  return <nav className="bottom-navigation" aria-label="Основная навигация">
    <button className={navigation.screen === 'tasks' ? 'active' : ''} aria-current={navigation.screen === 'tasks' ? 'page' : undefined} onClick={() => navigate({ screen: 'tasks' })}><Icon name="tasks"/><span>Задачи</span></button>
    <button className="create" aria-label="Создать задачу" onClick={() => navigate({ screen: 'create' })}><Icon name="plus"/></button>
    <button className={navigation.screen === 'settings' ? 'active' : ''} aria-current={navigation.screen === 'settings' ? 'page' : undefined} onClick={() => navigate({ screen: 'settings' })}><Icon name="settings"/><span>Настройки</span></button>
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

export function Sheet({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title"><header><h2 id="sheet-title">{title}</h2><IconButton label="Закрыть" onClick={onClose}><Icon name="close"/></IconButton></header>{children}</section>;
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
  return <><header className="page-header"><div className="title-row"><h1>Задачи</h1><TaskGlyph/></div><button className="board-selector" onClick={onSelectBoard}>{boardName} <span aria-hidden="true">⌄</span></button></header>{children}</>;
}

export function SettingsScreen({ children }: { children: ReactNode }) {
  return <><header><p className="eyebrow">НАСТРОЙКИ</p><h1>Рабочие пространства</h1></header>{children}</>;
}

export function CreateScreen({ children }: { children: ReactNode }) {
  return <><header><p className="eyebrow">НОВАЯ ЗАДАЧА</p><h1>Выберите доску</h1></header>{children}</>;
}