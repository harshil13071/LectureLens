export type AppTheme = 'dark' | 'light';

export const APP_THEME_STORAGE_KEY = 'lecturelens-theme-v1';

export function parseAppTheme(value: unknown): AppTheme {
  return value === 'light' ? 'light' : 'dark';
}
