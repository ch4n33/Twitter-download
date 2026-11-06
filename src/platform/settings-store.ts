import { DEFAULT_SETTINGS, validateSettings } from '../core/settings';
import type { Settings } from '../core/types';

export const SETTINGS_KEY = 'twitterDownload.settings';

export async function loadSettings(): Promise<Settings> {
  const saved = await chrome.storage.local.get(SETTINGS_KEY);
  if (saved[SETTINGS_KEY] === undefined) return { ...DEFAULT_SETTINGS };
  const result = validateSettings(saved[SETTINGS_KEY]);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

export async function saveSettings(value: unknown): Promise<Settings> {
  const result = validateSettings(value);
  if (!result.ok) throw new Error(result.error.message);
  await chrome.storage.local.set({ [SETTINGS_KEY]: result.value });
  return result.value;
}
