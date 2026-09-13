(function initializeKinetraTheme() {
  'use strict';

  const storageKey = 'kinetra.theme.v1';
  const root = document.documentElement;
  const allowed = new Set(['system', 'light', 'dark']);
  let preference = 'system';

  try {
    const stored = window.localStorage.getItem(storageKey);
    preference = allowed.has(stored) ? stored : 'system';
  } catch {
    preference = 'system';
  }

  const systemDark =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  const resolved = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
  const themeColor = resolved === 'dark' ? '#080909' : '#F4F6F2';

  root.dataset.theme = resolved;
  root.dataset.themePreference = preference;
  root.style.colorScheme = resolved;

  const metaThemeColor = document.querySelector('meta[name="theme-color"]');
  if (metaThemeColor) {
    metaThemeColor.setAttribute('content', themeColor);
  }
})();
