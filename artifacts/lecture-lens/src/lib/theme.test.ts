import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_THEME_STORAGE_KEY, parseAppTheme } from './theme';

test('theme preference accepts only light and defaults all invalid or absent values to dark', () => {
  assert.equal(APP_THEME_STORAGE_KEY, 'lecturelens-theme-v1');
  assert.equal(parseAppTheme('light'), 'light');
  assert.equal(parseAppTheme('dark'), 'dark');
  for (const invalid of [null, undefined, '', 'system', 'contrast', 4, {}]) {
    assert.equal(parseAppTheme(invalid), 'dark');
  }
});
