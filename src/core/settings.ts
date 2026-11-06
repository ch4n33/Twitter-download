import type { Result, Settings } from './types';

const WINDOWS_RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const OS_INVALID_CHARACTERS = /[<>:"|?*]/;

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  version: 1,
  subdirectory: '',
  grouping: 'none',
  filename: 'original',
  originalSize: true,
});

function failure<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates one user-entered path component and returns it unchanged. Empty means no component. */
export function validateFolderName(value: string): Result<string> {
  if (typeof value !== 'string') {
    return failure('invalid_folder_name', '하위 폴더 이름은 문자로 입력해 주세요.');
  }
  if (value === '') return { ok: true, value };
  if (value === '.' || value === '..') {
    return failure('invalid_folder_name', '점(.)과 두 점(..)은 폴더 이름으로 사용할 수 없어요.');
  }
  if (value.includes('/') || value.includes('\\')) {
    return failure('invalid_folder_name', '폴더 한 단계만 입력할 수 있어요. 슬래시(/)와 역슬래시(\\)는 사용할 수 없어요.');
  }
  if (CONTROL_CHARACTERS.test(value) || OS_INVALID_CHARACTERS.test(value)) {
    return failure('invalid_folder_name', '운영체제에서 사용할 수 없는 문자가 들어 있어요.');
  }
  if (/[. ]$/.test(value)) {
    return failure('invalid_folder_name', '폴더 이름 끝에는 점이나 공백을 둘 수 없어요.');
  }
  const deviceName = value.split('.')[0].replace(/[ .]+$/g, '');
  if (WINDOWS_RESERVED_NAMES.test(deviceName)) {
    return failure('invalid_folder_name', '운영체제에서 예약한 이름은 사용할 수 없어요.');
  }
  return { ok: true, value };
}

export function validateSettings(value: unknown): Result<Settings> {
  if (!isRecord(value)) {
    return failure('invalid_settings', '다운로드 설정 형식이 올바르지 않아요.');
  }

  if (value.version !== 1) {
    return failure('unsupported_settings_version', '지원하지 않는 다운로드 설정 버전이에요.');
  }

  if (typeof value.subdirectory !== 'string') {
    return failure('invalid_subdirectory', '하위 폴더 이름을 확인해 주세요.');
  }
  const folderResult = validateFolderName(value.subdirectory);
  if (!folderResult.ok) return folderResult;

  if (value.grouping !== 'none' && value.grouping !== 'date' && value.grouping !== 'author') {
    return failure('invalid_grouping', '폴더 분류 설정을 확인해 주세요.');
  }

  if (value.filename !== 'original' && value.filename !== 'post') {
    return failure('invalid_filename_mode', '파일 이름 설정을 확인해 주세요.');
  }

  if (typeof value.originalSize !== 'boolean') {
    return failure('invalid_image_size', '이미지 크기 설정을 확인해 주세요.');
  }

  return {
    ok: true,
    value: {
      version: 1,
      subdirectory: folderResult.value,
      grouping: value.grouping,
      filename: value.filename,
      originalSize: value.originalSize,
    },
  };
}
