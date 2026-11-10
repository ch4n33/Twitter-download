import { validateSettings } from '../core/settings';
import { buildRelativePath } from '../core/paths';
import type { PhotoAsset, PostSnapshot, Result, Settings } from '../core/types';

export interface SettingsForm {
  readSettings(): Result<Settings>;
  setSettings(settings: Settings): void;
  setDisabled(disabled: boolean): void;
  setStatus(message: string, error?: boolean): void;
  onChange(listener: (settings: Result<Settings>) => void): void;
}

const EXAMPLE_PHOTO: PhotoAsset = {
  key: 'settings-preview-image-1',
  kind: 'image',
  index: 1,
  originalFilename: 'HWaP4JDbYAA8eTG.jpeg',
  extension: 'jpeg',
  displayedUrl: 'https://example.invalid/media/HWaP4JDbYAA8eTG?size=small',
  originalUrl: 'https://example.invalid/media/HWaP4JDbYAA8eTG?size=original',
};

const EXAMPLE_POST: PostSnapshot = {
  key: 'settings-preview-post',
  postId: '2118530055324254686',
  authorHandle: 'sample_photo',
  photos: [EXAMPLE_PHOTO],
  expectedPhotoCount: 1,
  completeness: 'complete',
};

function getCheckedValue<T extends string>(document: Document, name: string): T | null {
  const checked = document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`);
  return checked ? checked.value as T : null;
}

function setStatusElement(element: HTMLElement, message: string, error = false): void {
  element.textContent = message;
  element.classList.toggle('is-error', error);
}

export function createSettingsForm(document: Document): SettingsForm | null {
  const form = document.querySelector<HTMLFormElement>('#settings-form');
  const folderInput = document.querySelector<HTMLInputElement>('#subdirectory');
  const folderError = document.querySelector<HTMLElement>('#subdirectory-error');
  const pathPreview = document.querySelector<HTMLElement>('#path-preview');
  const qualityPreview = document.querySelector<HTMLElement>('#quality-preview');
  const saveStatus = document.querySelector<HTMLElement>('#save-status');
  const sizeInput = document.querySelector<HTMLInputElement>('#original-size');
  const gifOutputInput = document.querySelector<HTMLInputElement>('#save-gif');
  if (!form || !folderInput || !folderError || !pathPreview || !qualityPreview || !saveStatus || !sizeInput || !gifOutputInput) return null;
  const popupForm = form;
  const subdirectoryInput = folderInput;
  const subdirectoryError = folderError;
  const previewPath = pathPreview;
  const previewQuality = qualityPreview;
  const persistenceStatus = saveStatus;
  const originalSizeInput = sizeInput;
  const saveGifAsGifInput = gifOutputInput;

  const listeners: Array<(settings: Result<Settings>) => void> = [];
  let composingText = false;

  function collectSettings(): unknown {
    return {
      version: 1,
      subdirectory: subdirectoryInput.value,
      grouping: getCheckedValue<Settings['grouping']>(document, 'grouping'),
      filename: getCheckedValue<Settings['filename']>(document, 'filename'),
      originalSize: originalSizeInput.checked,
      saveGifAsGif: saveGifAsGifInput.checked,
    };
  }

  function render(): Result<Settings> {
    const validation = validateSettings(collectSettings());
    if (!validation.ok) {
      const folderInvalid = validation.error.code === 'invalid_folder_name';
      subdirectoryError.textContent = folderInvalid ? validation.error.message : '';
      subdirectoryError.hidden = !folderInvalid;
      subdirectoryInput.setAttribute('aria-invalid', folderInvalid ? 'true' : 'false');
      previewPath.textContent = '유효한 경로를 입력하면 미리볼 수 있어요.';
      previewQuality.textContent = originalSizeInput.checked
        ? '이미지 크기: 원본 크기'
        : '이미지 크기: 타임라인 표시 크기';
      return validation;
    }

    subdirectoryError.textContent = '';
    subdirectoryError.hidden = true;
    subdirectoryInput.setAttribute('aria-invalid', 'false');
    const path = buildRelativePath(EXAMPLE_POST, EXAMPLE_PHOTO, validation.value, { now: new Date() });
    if (!path.ok) {
      previewPath.textContent = path.error.message;
      previewQuality.textContent = originalSizeInput.checked
        ? '이미지 크기: 원본 크기'
        : '이미지 크기: 타임라인 표시 크기';
      return path;
    }

    previewPath.textContent = `~/Download/${path.value.relativePath}`;
    previewQuality.textContent = originalSizeInput.checked
      ? '이미지 크기: 원본 크기'
      : '이미지 크기: 타임라인 표시 크기';
    return validation;
  }

  function emitChange(): void {
    const result = render();
    if (!composingText) for (const listener of listeners) listener(result);
  }

  function setSettings(settings: Settings): void {
    subdirectoryInput.value = settings.subdirectory;
    const grouping = document.querySelector<HTMLInputElement>(`input[name="grouping"][value="${settings.grouping}"]`);
    const filename = document.querySelector<HTMLInputElement>(`input[name="filename"][value="${settings.filename}"]`);
    if (grouping) grouping.checked = true;
    if (filename) filename.checked = true;
    originalSizeInput.checked = settings.originalSize;
    saveGifAsGifInput.checked = settings.saveGifAsGif;
    render();
  }

  function setDisabled(disabled: boolean): void {
    for (const input of Array.from(popupForm.querySelectorAll<HTMLInputElement>('input'))) input.disabled = disabled;
  }

  subdirectoryInput.addEventListener('compositionstart', () => { composingText = true; });
  subdirectoryInput.addEventListener('compositionend', () => {
    composingText = false;
    emitChange();
  });
  subdirectoryInput.addEventListener('input', emitChange);
  popupForm.addEventListener('change', emitChange);
  popupForm.addEventListener('submit', event => event.preventDefault());
  render();

  return {
    readSettings: render,
    setSettings,
    setDisabled,
    setStatus: (message, error) => setStatusElement(persistenceStatus, message, error),
    onChange: listener => listeners.push(listener),
  };
}
