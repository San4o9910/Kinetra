export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'kinetra.theme.v1';

export const themeOptions: readonly {
  readonly value: ThemePreference;
  readonly label: string;
  readonly description: string;
}[] = [
  { value: 'system', label: 'Системная', description: 'Как на устройстве' },
  { value: 'light', label: 'Светлая', description: 'Светлый интерфейс' },
  { value: 'dark', label: 'Тёмная', description: 'Тёмный интерфейс' },
];

export const normalizeThemePreference = (value: unknown): ThemePreference =>
  value === 'light' || value === 'dark' || value === 'system' ? value : 'system';

export const resolveThemePreference = (
  preference: ThemePreference,
  systemDark: boolean,
): ResolvedTheme => (preference === 'system' ? (systemDark ? 'dark' : 'light') : preference);

export const readStoredThemePreference = (): ThemePreference => {
  if (typeof window === 'undefined') {
    return 'system';
  }

  try {
    return normalizeThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
};

export const writeStoredThemePreference = (preference: ThemePreference): void => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Theme still applies for this page when storage is unavailable.
  }
};

export const systemPrefersDark = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches;

export const applyThemePreference = (
  preference: ThemePreference,
  systemDark: boolean,
): ResolvedTheme => {
  const resolved = resolveThemePreference(preference, systemDark);

  if (typeof document === 'undefined') {
    return resolved;
  }

  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = resolved;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', resolved === 'dark' ? '#080909' : '#F4F6F2');

  return resolved;
};
