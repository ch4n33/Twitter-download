import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, validateSettings } from '../../src/core/settings';

describe('settings', () => {
  it('exports frozen v1 defaults with only the confirmed quality default enabled', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      version: 1,
      subdirectory: '',
      grouping: 'none',
      filename: 'original',
      originalSize: true,
    });
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
  });

  it('validates and returns a clean settings value', () => {
    const input = {
      version: 1,
      subdirectory: 'archive-2026',
      grouping: 'author',
      filename: 'post',
      originalSize: false,
      ignoredExtra: 'ignored',
    };

    expect(validateSettings(input)).toEqual({
      ok: true,
      value: {
        version: 1,
        subdirectory: 'archive-2026',
        grouping: 'author',
        filename: 'post',
        originalSize: false,
      },
    });
  });

  it.each([
    [null, 'invalid_settings'],
    [{ ...DEFAULT_SETTINGS, version: 2 }, 'unsupported_settings_version'],
    [{ ...DEFAULT_SETTINGS, grouping: 'week' }, 'invalid_grouping'],
    [{ ...DEFAULT_SETTINGS, filename: 'timestamp' }, 'invalid_filename_mode'],
    [{ ...DEFAULT_SETTINGS, originalSize: 'true' }, 'invalid_image_size'],
    [{ ...DEFAULT_SETTINGS, subdirectory: 'nested/folder' }, 'invalid_folder_name'],
  ])('rejects invalid settings with a stable code: %j', (value, code) => {
    const result = validateSettings(value);
    expect(result).toMatchObject({ ok: false, error: { code } });
  });
});
