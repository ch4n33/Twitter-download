import { buildRelativePath } from './paths';
import { validateSettings } from './settings';
import type {
  DownloadPlan,
  DownloadSelection,
  DownloadTask,
  PhotoAsset,
  PlanningContext,
  PostSnapshot,
  Result,
  Settings,
} from './types';

function failure<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message } };
}

function success<T>(value: T): Result<T> {
  return { ok: true, value };
}

function validNow(context: PlanningContext): context is PlanningContext {
  return Boolean(context && context.now && typeof context.now.getTime === 'function' && Number.isFinite(context.now.getTime()));
}

function selectedPhotos(post: PostSnapshot, selection: DownloadSelection): Result<PhotoAsset[]> {
  if (!post || typeof post !== 'object' || !Array.isArray(post.photos) || post.photos.length === 0) {
    return failure('photos_unavailable', '게시물 사진 목록을 확인할 수 없어요.');
  }

  const keys = new Set<string>();
  const indices = new Set<number>();
  for (const photo of post.photos) {
    if (!photo || typeof photo.key !== 'string' || photo.key.length === 0
      || !Number.isInteger(photo.index) || photo.index < 1) {
      return failure('invalid_photo_list', '게시물 사진 목록을 확인해 주세요.');
    }
    if (keys.has(photo.key) || indices.has(photo.index)) {
      return failure('ambiguous_photo_list', '게시물 사진의 키나 순번이 중복되어 있어요.');
    }
    keys.add(photo.key);
    indices.add(photo.index);
  }

  if (selection === 'all') {
    const expected = post.expectedPhotoCount;
    const orderedPhotos = [...post.photos].sort((left, right) => left.index - right.index);
    const indicesAreComplete = orderedPhotos.every((photo, offset) => photo.index === offset + 1);
    if (post.completeness !== 'complete' || !Number.isInteger(expected)
      || expected !== post.photos.length || !indicesAreComplete) {
      return failure('incomplete_photo_list', '전체 사진 목록을 확인하지 못해 모두 저장할 수 없어요.');
    }
    return success(orderedPhotos);
  }

  if (!selection || typeof selection !== 'object' || !Array.isArray(selection.photoKeys)
    || selection.photoKeys.length === 0 || selection.photoKeys.some(key => typeof key !== 'string' || key.length === 0)) {
    return failure('invalid_selection', '저장할 사진을 확인해 주세요.');
  }
  const requested = new Set(selection.photoKeys);
  if (requested.size !== selection.photoKeys.length) {
    return failure('duplicate_selection', '같은 사진이 여러 번 선택되어 있어요.');
  }
  const selected = post.photos.filter(photo => requested.has(photo.key));
  if (selected.length !== requested.size) {
    return failure('photo_not_in_post', '선택한 사진이 게시물에 포함되어 있지 않아요.');
  }
  return success(selected.sort((left, right) => left.index - right.index));
}

export function createDownloadPlan(
  post: PostSnapshot,
  selection: DownloadSelection,
  settings: Settings,
  context: PlanningContext,
): Result<DownloadPlan> {
  if (!validNow(context)) {
    return failure('invalid_planning_date', '다운로드 날짜를 확인할 수 없어요.');
  }
  if (typeof post?.key !== 'string' || post.key.length === 0) {
    return failure('invalid_post', '게시물 정보를 확인해 주세요.');
  }

  const validatedSettings = validateSettings(settings);
  if (!validatedSettings.ok) return validatedSettings;
  const safeSettings = validatedSettings.value;

  const photosResult = selectedPhotos(post, selection);
  if (!photosResult.ok) return photosResult;

  const tasks: DownloadTask[] = [];
  const warnings = new Set<string>();
  for (const photo of photosResult.value) {
    const url = safeSettings.originalSize ? photo.originalUrl : photo.displayedUrl;
    if (typeof url !== 'string' || url.length === 0) {
      return safeSettings.originalSize
        ? failure('original_image_unavailable', '원본 크기 이미지를 확인할 수 없어요. 작은 이미지로 대체하지 않았어요.')
        : failure('displayed_image_unavailable', '타임라인 표시 이미지를 확인할 수 없어요.');
    }

    const pathResult = buildRelativePath(post, photo, safeSettings, context);
    if (!pathResult.ok) return pathResult;
    tasks.push({
      photoKey: photo.key,
      index: photo.index,
      url,
      relativePath: pathResult.value.relativePath,
    });
    for (const warning of pathResult.value.warnings) warnings.add(warning);
  }

  return success({
    postKey: post.key,
    createdAt: context.now.toISOString(),
    tasks,
    warnings: [...warnings],
  });
}
