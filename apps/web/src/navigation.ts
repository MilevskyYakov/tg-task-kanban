export type NavigationState =
  | { screen: 'tasks' }
  | { screen: 'board'; boardId: string }
  | { screen: 'create' }
  | { screen: 'settings' }
  | { screen: 'settings-workspace'; boardId?: string }
  | { screen: 'settings-automation'; boardId?: string }
  | { screen: 'settings-account' };

export const settingsSections = [
  { id: 'workspace', title: 'Рабочее пространство', description: 'Доски, проекты и участники' },
  { id: 'automation', title: 'Автоматизация', description: 'Повторения и уведомления' },
  { id: 'account', title: 'Аккаунт', description: 'Профиль и личные параметры' }
] as const;

export const isSettingsNavigation = (navigation: NavigationState) => navigation.screen.startsWith('settings');

export const countLabel = (count: number, one: string, few: string, many: string) => `${count} ${count % 10 === 1 && count % 100 !== 11 ? one : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? few : many}`;

export const initialNavigation = (): NavigationState => ({ screen: 'tasks' });
