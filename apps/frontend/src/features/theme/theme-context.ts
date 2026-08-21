import { createContext, useContext } from 'react';

import type { ResolvedTheme, ThemePreference } from './model';

export interface ThemeContextValue {
  readonly preference: ThemePreference;
  readonly resolvedTheme: ResolvedTheme;
  readonly setPreference: (preference: ThemePreference) => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export const useTheme = (): ThemeContextValue => {
  const value = useContext(ThemeContext);

  if (value === null) {
    throw new Error('useTheme must be used inside ThemeProvider.');
  }

  return value;
};
