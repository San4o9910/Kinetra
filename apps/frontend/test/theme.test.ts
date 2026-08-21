import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  normalizeThemePreference,
  resolveThemePreference,
  THEME_STORAGE_KEY,
  themeOptions,
} from '../src/features/theme/model.js';

test('theme preference accepts exactly system, light and dark', () => {
  assert.equal(THEME_STORAGE_KEY, 'kinetra.theme.v1');
  assert.deepEqual(
    themeOptions.map(({ value }) => value),
    ['system', 'light', 'dark'],
  );
  assert.equal(normalizeThemePreference('system'), 'system');
  assert.equal(normalizeThemePreference('light'), 'light');
  assert.equal(normalizeThemePreference('dark'), 'dark');
  assert.equal(normalizeThemePreference('sepia'), 'system');
  assert.equal(normalizeThemePreference(null), 'system');
});

test('system preference resolves from the current operating-system theme', () => {
  assert.equal(resolveThemePreference('system', true), 'dark');
  assert.equal(resolveThemePreference('system', false), 'light');
  assert.equal(resolveThemePreference('dark', false), 'dark');
  assert.equal(resolveThemePreference('light', true), 'light');
});
