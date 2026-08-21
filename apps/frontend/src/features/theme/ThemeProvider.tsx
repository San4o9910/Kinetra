import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import {
  applyThemePreference,
  normalizeThemePreference,
  readStoredThemePreference,
  resolveThemePreference,
  systemPrefersDark,
  THEME_STORAGE_KEY,
  writeStoredThemePreference,
  type ThemePreference,
} from './model';
import { ThemeContext, type ThemeContextValue } from './theme-context';

export const ThemeProvider = ({ children }: { readonly children: ReactNode }): ReactNode => {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredThemePreference);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);
  const resolvedTheme = resolveThemePreference(preference, systemDark);

  const setPreference = useCallback((nextPreference: ThemePreference): void => {
    setSystemDark(systemPrefersDark());
    setPreferenceState(nextPreference);
  }, []);

  useLayoutEffect(() => {
    applyThemePreference(preference, systemDark);
    writeStoredThemePreference(preference);
  }, [preference, systemDark]);

  useEffect(() => {
    if (preference !== 'system' || typeof window.matchMedia !== 'function') {
      return;
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const updateFromSystem = (event?: MediaQueryListEvent): void =>
      setSystemDark(event?.matches ?? media.matches);
    updateFromSystem();
    media.addEventListener('change', updateFromSystem);
    return () => media.removeEventListener('change', updateFromSystem);
  }, [preference]);

  useEffect(() => {
    const syncAcrossTabs = (event: StorageEvent): void => {
      if (event.key !== THEME_STORAGE_KEY) {
        return;
      }

      setSystemDark(systemPrefersDark());
      setPreferenceState(normalizeThemePreference(event.newValue));
    };

    window.addEventListener('storage', syncAcrossTabs);
    return () => window.removeEventListener('storage', syncAcrossTabs);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolvedTheme, setPreference }),
    [preference, resolvedTheme, setPreference],
  );

  return (
    <ThemeContext.Provider value={value}>
      <React.Fragment>{children}</React.Fragment>
    </ThemeContext.Provider>
  );
};
