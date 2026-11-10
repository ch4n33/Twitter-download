import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, validateSettings } from '../../src/core/settings';

describe('settings', () => {
  it('exports frozen v1 defaults with image quality and GIF output enabled', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      version: 1,
      subdirectory: '',
      grouping: 'none',
      filename: 'original',
      originalSize: true,
      saveGifAsGif: true,
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
      saveGifAsGif: false,
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
        saveGifAsGif: false,
      },
    });
  });

  it('defaults only a missing additive GIF output field to true', () => {
    const { saveGifAsGif: _saveGifAsGif, ...legacySettings } = DEFAULT_SETTINGS;
    expect(validateSettings({ ...legacySettings, subdirectory: 'archive' })).toEqual({
      ok: true,
      value: { ...DEFAULT_SETTINGS, subdirectory: 'archive' },
    });
  });

  it.each([
    [null, 'invalid_settings'],
    [{ ...DEFAULT_SETTINGS, version: 2 }, 'unsupported_settings_version'],
    [{ ...DEFAULT_SETTINGS, grouping: 'week' }, 'invalid_grouping'],
    [{ ...DEFAULT_SETTINGS, filename: 'timestamp' }, 'invalid_filename_mode'],
    [{ ...DEFAULT_SETTINGS, originalSize: 'true' }, 'invalid_image_size'],
    [{ ...DEFAULT_SETTINGS, saveGifAsGif: undefined }, 'invalid_gif_output'],
    [{ ...DEFAULT_SETTINGS, saveGifAsGif: 'true' }, 'invalid_gif_output'],
    [{ ...DEFAULT_SETTINGS, saveGifAsGif: null }, 'invalid_gif_output'],
    [{ ...DEFAULT_SETTINGS, subdirectory: 'nested/folder' }, 'invalid_folder_name'],
  ])('rejects invalid settings with a stable code: %j', (value, code) => {
    const result = validateSettings(value);
    expect(result).toMatchObject({ ok: false, error: { code } });
  });
});
