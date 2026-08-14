import type { ReactNode } from 'react';
import type { NavigationState } from './navigation';

export function AppShell({ children, message, navigation, navigate }: { children: ReactNode; message: string; navigation: NavigationState; navigate: (next: NavigationState) => void }) {
  return <main className="app-shell">
    <div className="app-content">{children}</div>
    {message && <p className="app-message" role="status">{message}</p>}
    <BottomNavigation navigation={navigation} navigate={navigate}/>
  </main>;
}

function BottomNavigation({ navigation, navigate }: { navigation: NavigationState; navigate: (next: NavigationState) => void }) {
  return <nav className="bottom-navigation" aria-label="Основная навигация">
    <button className={navigation.screen === 'tasks' ? 'active' : ''} onClick={() => navigate({ screen: 'tasks' })}>Задачи</button>
    <button className="create" aria-label="Создать задачу" onClick={() => navigate({ screen: 'create' })}>+</button>
    <button className={navigation.screen === 'settings' ? 'active' : ''} onClick={() => navigate({ screen: 'settings' })}>Настройки</button>
  </nav>;
}

export function TasksScreen({ children }: { children: ReactNode }) {
  return <><header><p className="eyebrow">ВСЕ МОИ ЗАДАЧИ</p><h1>Моя работа</h1></header>{children}</>;
}

export function SettingsScreen({ children }: { children: ReactNode }) {
  return <><header><p className="eyebrow">НАСТРОЙКИ</p><h1>Рабочие пространства</h1></header>{children}</>;
}

export function CreateScreen({ children }: { children: ReactNode }) {
  return <><header><p className="eyebrow">НОВАЯ ЗАДАЧА</p><h1>Выберите доску</h1></header>{children}</>;
}
