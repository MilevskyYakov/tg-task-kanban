export type NavigationState =
  | { screen: 'tasks' }
  | { screen: 'board'; boardId: string }
  | { screen: 'create' }
  | { screen: 'settings' };

export const initialNavigation = (): NavigationState => ({ screen: 'tasks' });
