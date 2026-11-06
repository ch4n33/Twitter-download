import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import { loadSettings, saveSettings, SETTINGS_KEY } from '../../src/platform/settings-store';

afterEach(() => vi.unstubAllGlobals());

describe('settings persistence', () => {
  it('uses the same defaults and validation as the planner', async () => {
    const data: Record<string, unknown> = {};
    const set = vi.fn(async (value: Record<string, unknown>) => { Object.assign(data, value); });
    vi.stubGlobal('chrome', { storage: { local: { get: async () => data, set } } });
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
    await saveSettings({ ...DEFAULT_SETTINGS, subdirectory: 'pictures', grouping: 'author' });
    expect((await loadSettings()).subdirectory).toBe('pictures');
    expect(data[SETTINGS_KEY]).toMatchObject({ grouping: 'author' });
    await expect(saveSettings({ ...DEFAULT_SETTINGS, subdirectory: 'pictures/nested' })).rejects.toThrow();
    expect(set).toHaveBeenCalledTimes(1);
  });
  it('does not silently load corrupted persisted paths', async () => {
    vi.stubGlobal('chrome', { storage: { local: { get: async () => ({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, subdirectory: '..' } }) } } });
    await expect(loadSettings()).rejects.toThrow();
  });
});
