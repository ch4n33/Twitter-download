// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import type { Settings } from '../../src/core/types';

const settingsStore = vi.hoisted(() => ({
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
}));

vi.mock('../../src/platform/settings-store', () => settingsStore);

const popupMarkup = readFileSync(resolve(process.cwd(), 'src/popup/popup.html'), 'utf8');

async function flushPopupWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

function input(id: string): HTMLInputElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`Missing input #${id}`);
  return element;
}

function text(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element;
}

async function mountPopup(initialSettings: Settings = { ...DEFAULT_SETTINGS }): Promise<void> {
  document.open();
  document.write(popupMarkup);
  document.close();
  settingsStore.loadSettings.mockResolvedValue(initialSettings);
  settingsStore.saveSettings.mockImplementation(async (value: Settings) => value);
  vi.resetModules();
  await import('../../src/popup/index');
  await flushPopupWork();
}

describe('settings popup', () => {
  beforeEach(() => {
    settingsStore.loadSettings.mockReset();
    settingsStore.saveSettings.mockReset();
  });

  it('loads persisted settings and previews the same composed path and quality choice', async () => {
    const saved: Settings = {
      version: 1,
      subdirectory: 'archive',
      grouping: 'author',
      filename: 'post',
      originalSize: false,
      saveGifAsGif: true,
    };
    await mountPopup(saved);

    expect(input('subdirectory').value).toBe('archive');
    expect(input('group-author').checked).toBe(true);
    expect(input('filename-post').checked).toBe(true);
    expect(input('original-size').checked).toBe(false);
    expect(input('save-gif').checked).toBe(true);
    expect(text('gif-output-help').textContent).toBe('끄면 MP4로 저장합니다. GIF 변환은 시간이 걸리고 파일이 커질 수 있어요.');
    expect(text('path-preview').textContent).toBe('~/Download/archive/@sample_photo/sample_photo-2118530055324254686-1.jpeg');
    expect(text('quality-preview').textContent).toBe('이미지 크기: 타임라인 표시 크기');
    expect(text('save-status').textContent).toContain('자동 저장');
  });

  it('updates the preview locally and saves valid edits through the settings store', async () => {
    await mountPopup();

    const folder = input('subdirectory');
    folder.value = 'media';
    folder.dispatchEvent(new Event('input', { bubbles: true }));
    input('group-date').checked = true;
    input('group-date').dispatchEvent(new Event('change', { bubbles: true }));
    input('filename-post').checked = true;
    input('filename-post').dispatchEvent(new Event('change', { bubbles: true }));
    input('original-size').checked = false;
    input('original-size').dispatchEvent(new Event('change', { bubbles: true }));
    input('save-gif').checked = false;
    input('save-gif').dispatchEvent(new Event('change', { bubbles: true }));
    await flushPopupWork();

    expect(text('path-preview').textContent).toMatch(/^~\/Download\/media\/\d{4}-\d{2}-\d{2}\/sample_photo-2118530055324254686-1\.jpeg$/);
    expect(text('quality-preview').textContent).toBe('이미지 크기: 타임라인 표시 크기');
    expect(settingsStore.saveSettings).toHaveBeenCalled();
    expect(settingsStore.saveSettings.mock.calls.at(-1)?.[0]).toEqual({
      version: 1,
      subdirectory: 'media',
      grouping: 'date',
      filename: 'post',
      originalSize: false,
      saveGifAsGif: false,
    });
    expect(text('save-status').textContent).toBe('설정이 저장됐어요.');
  });

  it('autosaves the GIF MP4 preference and restores it with other settings', async () => {
    const initial: Settings = {
      ...DEFAULT_SETTINGS,
      subdirectory: 'archive',
      filename: 'post',
      originalSize: false,
    };
    await mountPopup(initial);

    input('save-gif').checked = false;
    input('save-gif').dispatchEvent(new Event('change', { bubbles: true }));
    await flushPopupWork();

    const saved = settingsStore.saveSettings.mock.calls.at(-1)?.[0] as Settings;
    expect(saved.saveGifAsGif).toBe(false);
    expect(saved).toMatchObject({ subdirectory: 'archive', filename: 'post', originalSize: false });

    await mountPopup(saved);
    expect(input('save-gif').checked).toBe(false);
    expect(input('subdirectory').value).toBe('archive');
    expect(input('original-size').checked).toBe(false);
  });

  it('shows invalid folder errors and never saves the invalid value', async () => {
    await mountPopup();
    settingsStore.saveSettings.mockClear();

    const folder = input('subdirectory');
    folder.value = 'media/photos';
    folder.dispatchEvent(new Event('input', { bubbles: true }));

    expect(folder.getAttribute('aria-invalid')).toBe('true');
    expect(text('subdirectory-error').hidden).toBe(false);
    expect(text('subdirectory-error').textContent).toContain('폴더 한 단계');
    expect(text('path-preview').textContent).toBe('유효한 경로를 입력하면 미리볼 수 있어요.');
    expect(text('save-status').textContent).toBe('입력값을 확인해 주세요.');
    await flushPopupWork();
    expect(settingsStore.saveSettings).not.toHaveBeenCalled();
  });

  it('keeps the UI interactive after a storage error and reports a failed save', async () => {
    await mountPopup();
    settingsStore.saveSettings.mockRejectedValueOnce(new Error('storage unavailable'));

    const folder = input('subdirectory');
    folder.value = 'saved';
    folder.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPopupWork();

    expect(text('save-status').textContent).toContain('저장하지 못했어요. storage unavailable');
    expect(text('save-status').classList.contains('is-error')).toBe(true);
    expect(text('path-preview').textContent).toBe('~/Download/saved/HWaP4JDbYAA8eTG.jpeg');
  });

  it('starts saving the latest valid edit without waiting for an earlier storage promise', async () => {
    await mountPopup();
    const resolveSave: Array<() => void> = [];
    settingsStore.saveSettings.mockImplementation((value: Settings) => new Promise(resolve => {
      resolveSave.push(() => resolve(value));
    }));

    const folder = input('subdirectory');
    folder.value = 'first';
    folder.dispatchEvent(new Event('input', { bubbles: true }));
    folder.value = 'latest';
    folder.dispatchEvent(new Event('input', { bubbles: true }));

    expect(settingsStore.saveSettings).toHaveBeenCalledTimes(2);
    expect(settingsStore.saveSettings.mock.calls[1]?.[0]).toMatchObject({ subdirectory: 'latest' });
    resolveSave[1]();
    await flushPopupWork();
    expect(text('save-status').textContent).toBe('설정이 저장됐어요.');
    resolveSave[0]();
    await flushPopupWork();
    expect(text('save-status').textContent).toBe('설정이 저장됐어요.');
  });

  it('does not overwrite corrupted stored settings on initial load', async () => {
    document.open();
    document.write(popupMarkup);
    document.close();
    settingsStore.loadSettings.mockRejectedValue(new Error('invalid stored settings'));
    settingsStore.saveSettings.mockImplementation(async (value: Settings) => value);
    vi.resetModules();
    await import('../../src/popup/index');
    await flushPopupWork();

    expect(text('save-status').textContent).toContain('설정을 불러오지 못했어요. invalid stored settings');
    expect(settingsStore.saveSettings).not.toHaveBeenCalled();
    expect(input('subdirectory').disabled).toBe(false);
  });
});
