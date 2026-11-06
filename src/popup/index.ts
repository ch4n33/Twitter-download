import { DEFAULT_SETTINGS } from '../core/settings';
import type { Settings } from '../core/types';
import { loadSettings, saveSettings } from '../platform/settings-store';
import { createSettingsForm } from './settings-form';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '저장 중 문제가 생겼어요.';
}

function settingsKey(settings: Settings): string {
  return JSON.stringify(settings);
}

export function initializePopup(document: Document): void {
  const form = createSettingsForm(document);
  if (!form) return;

  let loading = true;
  let writeRevision = 0;
  let lastSavedKey: string | null = null;
  let lastSubmittedKey: string | null = null;
  form.setDisabled(true);
  form.setStatus('설정을 불러오는 중…');

  form.onChange(result => {
    if (loading) return;
    if (!result.ok) {
      writeRevision += 1;
      lastSubmittedKey = null;
      form.setStatus('입력값을 확인해 주세요.', true);
      return;
    }

    const settings = result.value;
    const key = settingsKey(settings);
    if (key === lastSubmittedKey) return;

    const revision = ++writeRevision;
    lastSubmittedKey = key;
    form.setStatus('저장 중…');
    void saveSettings(settings)
      .then(saved => {
        if (revision !== writeRevision) return;
        lastSavedKey = settingsKey(saved);
        lastSubmittedKey = lastSavedKey;
        form.setStatus('설정이 저장됐어요.');
      })
      .catch(error => {
        if (revision !== writeRevision) return;
        lastSubmittedKey = null;
        form.setStatus(`저장하지 못했어요. ${errorMessage(error)}`, true);
      });
  });

  void loadSettings()
    .then(settings => {
      form.setSettings(settings);
      lastSavedKey = settingsKey(settings);
      lastSubmittedKey = lastSavedKey;
      form.setStatus('변경 사항은 자동 저장돼요.');
    })
    .catch(error => {
      form.setSettings({ ...DEFAULT_SETTINGS });
      lastSavedKey = null;
      lastSubmittedKey = null;
      form.setStatus(`설정을 불러오지 못했어요. ${errorMessage(error)}`, true);
    })
    .finally(() => {
      loading = false;
      form.setDisabled(false);
      const result = form.readSettings();
      if (!result.ok) form.setStatus('입력값을 확인해 주세요.', true);
    });
}

if (typeof document !== 'undefined') initializePopup(document);
