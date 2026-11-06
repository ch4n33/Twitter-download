import type {
  PathTarget,
  PhotoAsset,
  PlanningContext,
  PostSnapshot,
  Result,
  Settings,
  StaticImageExtension,
} from './types';
import { validateFolderName, validateSettings } from './settings';

export { validateFolderName } from './settings';

const IMAGE_EXTENSIONS: readonly StaticImageExtension[] = ['jpg', 'jpeg', 'png', 'webp', 'avif'];

function failure<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message } };
}

function success<T>(value: T): Result<T> {
  return { ok: true, value };
}

function isSupportedExtension(value: unknown): value is StaticImageExtension {
  return typeof value === 'string' && IMAGE_EXTENSIONS.includes(value as StaticImageExtension);
}

function safeComponent(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && validateFolderName(value).ok;
}

function safeHandle(authorHandle: string | null): string | null {
  if (typeof authorHandle !== 'string' || authorHandle.length === 0) return null;
  const handle = authorHandle.startsWith('@') ? authorHandle.slice(1) : authorHandle;
  return safeComponent(handle) ? handle : null;
}

function localDateFolder(now: Date): Result<string> {
  if (!now || typeof now.getTime !== 'function' || !Number.isFinite(now.getTime())) {
    return failure('invalid_planning_date', '다운로드 날짜를 확인할 수 없어요.');
  }
  const year = now.getFullYear();
  if (year < 0 || year > 9999) {
    return failure('invalid_planning_date', '다운로드 날짜를 폴더 이름으로 만들 수 없어요.');
  }
  const folder = `${String(year).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return success(folder);
}

function originalFilename(photo: PhotoAsset): Result<{ filename: string; warnings: string[] }> {
  if (typeof photo.originalFilename !== 'string' || photo.originalFilename.length === 0) {
    return failure('original_filename_unavailable', '원본 파일 이름을 확인할 수 없어요.');
  }
  if (!isSupportedExtension(photo.extension)) {
    return failure('unsupported_image_extension', '지원하지 않는 이미지 형식이에요.');
  }

  const originalName = photo.originalFilename;
  const nameValidation = validateFolderName(originalName);
  if (!nameValidation.ok) {
    return failure('invalid_original_filename', '원본 파일 이름에 사용할 수 없는 문자가 있어요.');
  }

  const dotIndex = originalName.lastIndexOf('.');
  const hasExtension = dotIndex > 0 && dotIndex < originalName.length - 1;
  const currentExtension = hasExtension ? originalName.slice(dotIndex + 1).toLowerCase() : '';
  if (currentExtension === photo.extension) {
    return success({ filename: originalName, warnings: [] });
  }

  const stem = hasExtension ? originalName.slice(0, dotIndex) : originalName;
  if (stem.length === 0) {
    return failure('invalid_original_filename', '원본 파일 이름을 확인할 수 없어요.');
  }
  const filename = `${stem}.${photo.extension}`;
  if (!safeComponent(filename)) {
    return failure('invalid_original_filename', '원본 파일 이름을 안전한 경로로 만들 수 없어요.');
  }

  return success({
    filename,
    warnings: [hasExtension
      ? `확인된 이미지 형식(.${photo.extension})에 맞춰 파일 확장자를 사용합니다.`
      : `확인된 이미지 형식(.${photo.extension})의 확장자를 파일 이름에 붙였습니다.`],
  });
}

function postFilename(post: PostSnapshot, photo: PhotoAsset): Result<{ filename: string; warnings: string[] }> {
  const handle = safeHandle(post.authorHandle);
  const postId = safeComponent(post.postId) ? post.postId : null;
  if (handle !== null && postId !== null && isSupportedExtension(photo.extension)) {
    const filename = `${handle}-${postId}-${photo.index}.${photo.extension}`;
    if (safeComponent(filename)) return success({ filename, warnings: [] });
  }

  const fallback = originalFilename(photo);
  if (!fallback.ok) return fallback;
  return success({
    filename: fallback.value.filename,
    warnings: [
      '작성자 핸들이나 게시물 ID를 확인하지 못해 원본 파일명으로 저장합니다.',
      ...fallback.value.warnings,
    ],
  });
}

function canonicalPhoto(post: PostSnapshot, photo: PhotoAsset): Result<PhotoAsset> {
  if (!post || typeof post !== 'object' || !Array.isArray(post.photos) || !photo || typeof photo.key !== 'string') {
    return failure('invalid_photo', '저장할 사진 정보를 확인해 주세요.');
  }
  const matches = post.photos.filter(candidate => candidate?.key === photo.key);
  if (matches.length !== 1 || matches[0].index !== photo.index) {
    return failure('photo_not_in_post', '선택한 사진이 해당 게시물에 포함되어 있지 않아요.');
  }
  const matched = matches[0];
  if (!Number.isInteger(matched.index) || matched.index < 1 || !isSupportedExtension(matched.extension)) {
    return failure('invalid_photo', '사진 순번이나 이미지 형식을 확인해 주세요.');
  }
  return success(matched);
}

export function buildRelativePath(
  post: PostSnapshot,
  photo: PhotoAsset,
  settings: Settings,
  context: PlanningContext,
): Result<PathTarget> {
  const settingsResult = validateSettings(settings);
  if (!settingsResult.ok) return settingsResult;
  const validatedSettings = settingsResult.value;

  const photoResult = canonicalPhoto(post, photo);
  if (!photoResult.ok) return photoResult;
  const canonical = photoResult.value;
  const warnings: string[] = [];
  const parts: string[] = [];

  if (validatedSettings.subdirectory !== '') parts.push(validatedSettings.subdirectory);

  if (validatedSettings.grouping === 'date') {
    const date = localDateFolder(context.now);
    if (!date.ok) return date;
    parts.push(date.value);
  } else if (validatedSettings.grouping === 'author') {
    const handle = safeHandle(post.authorHandle);
    if (handle === null) {
      return failure('author_handle_unavailable', '작성자 핸들을 확인할 수 없어 작성자 폴더를 만들 수 없어요.');
    }
    const authorFolder = `@${handle}`;
    if (!safeComponent(authorFolder)) {
      return failure('invalid_author_handle', '작성자 핸들을 안전한 폴더 이름으로 만들 수 없어요.');
    }
    parts.push(authorFolder);
  }

  const filename = validatedSettings.filename === 'post'
    ? postFilename(post, canonical)
    : originalFilename(canonical);
  if (!filename.ok) return filename;
  parts.push(filename.value.filename);
  warnings.push(...filename.value.warnings);

  return success({ relativePath: parts.join('/'), warnings });
}
