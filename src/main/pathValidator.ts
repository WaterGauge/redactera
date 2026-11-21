import path from 'path';

const DEFAULT_DRAGGED_FILES_FOLDER = 'pdf-desensitization';
const DEFAULT_DRAGGED_FILE_MAX_NAME_LENGTH = 128;

export interface WriteTarget {
  readonly filePath: string;
  readonly realParent: string;
}

export interface PathValidator {
  allowedPaths: Set<string>;
  resolveUserPath(filePath: string): string | null;
  addAllowedPath(filePath: string): string | null;
  setWriteTarget(target: WriteTarget): void;
  clearWriteTarget(): void;
  claimWriteTarget(filePath: string | null): WriteTarget | null;
  isResolvedPathAllowed(resolvedPath: string | null): boolean;
  isPathInsideDirectory(filePath: string, directory: string): boolean;
  resolvePdfSafePathFromRequest(requestUrl: string): string | null;
  sanitizeDraggedFileName(fileName: string): string;
  getDraggedFilesDirectory(tempRoot: string): string;
}

export function resolveUserPath(filePath: string): string | null {
  if (typeof filePath !== 'string') {
    return null;
  }

  if (!filePath.trim() || filePath.includes('\0')) {
    return null;
  }

  return path.resolve(filePath);
}

export function isPathInsideDirectory(filePath: string, directory: string): boolean {
  const resolvedFilePath = path.resolve(filePath);
  const resolvedDirectory = path.resolve(directory);
  const relativePath = path.relative(resolvedDirectory, resolvedFilePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

export function resolvePdfSafePathFromRequest(requestUrl: string): string | null {
  if (!requestUrl.startsWith('pdf-safe://')) {
    return null;
  }

  try {
    // A viewer page fragment is client-side navigation, never part of the
    // authorized filename. Literal filename hashes remain percent-encoded.
    const encodedPath = requestUrl.slice('pdf-safe://'.length).split('#', 1)[0];
    return resolveUserPath(decodeURIComponent(encodedPath));
  } catch {
    return null;
  }
}

function normalizeDraggedSegment(segment: string): string {
  return segment
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/[._-]{2,}/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
}

export function sanitizeDraggedFileName(
  fileName: string,
  maxNameLength = DEFAULT_DRAGGED_FILE_MAX_NAME_LENGTH
): string {
  const normalized = typeof fileName === 'string' ? fileName.normalize('NFKC') : '';
  const rawSegments = normalized
    .replace(/[\\/]+/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..');

  const rawLastSegment = rawSegments.pop() ?? 'dragged';
  const safeSegments = rawSegments.map(normalizeDraggedSegment).filter(Boolean);
  const normalizedLastSegment = rawLastSegment
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
  const parsedLastSegment = path.posix.parse(normalizedLastSegment);
  const stemParts = [...safeSegments, normalizeDraggedSegment(parsedLastSegment.name)].filter(Boolean);
  const joinedStem = stemParts.join('_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  const maxStemLength = Math.max(1, maxNameLength - 4);
  const trimmedStem = (joinedStem || 'dragged').slice(0, maxStemLength).replace(/^_+|_+$/g, '');
  return `${trimmedStem || 'dragged'}.pdf`;
}

export function createPathValidator(options?: {
  draggedFilesFolder?: string;
  draggedFileMaxNameLength?: number;
}): PathValidator {
  const allowedPaths = new Set<string>();
  let writeTarget: WriteTarget | null = null;
  const draggedFilesFolder = options?.draggedFilesFolder ?? DEFAULT_DRAGGED_FILES_FOLDER;
  const draggedFileMaxNameLength = options?.draggedFileMaxNameLength ?? DEFAULT_DRAGGED_FILE_MAX_NAME_LENGTH;

  const addAllowedPath = (filePath: string): string | null => {
    const resolvedPath = resolveUserPath(filePath);
    if (!resolvedPath) {
      return null;
    }

    allowedPaths.add(resolvedPath);
    return resolvedPath;
  };


  return {
    allowedPaths,
    resolveUserPath,
    addAllowedPath,
    setWriteTarget(target: WriteTarget): void {
      writeTarget = { ...target };
    },
    clearWriteTarget(): void {
      writeTarget = null;
    },
    claimWriteTarget(filePath: string | null): WriteTarget | null {
      if (!filePath || !writeTarget || resolveUserPath(filePath) !== writeTarget.filePath) return null;
      const claimed = writeTarget;
      writeTarget = null;
      return claimed;
    },
    isResolvedPathAllowed(resolvedPath: string | null): boolean {
      return !!resolvedPath && allowedPaths.has(resolvedPath);
    },
    isPathInsideDirectory,
    resolvePdfSafePathFromRequest,
    sanitizeDraggedFileName(fileName: string): string {
      return sanitizeDraggedFileName(fileName, draggedFileMaxNameLength);
    },
    getDraggedFilesDirectory(tempRoot: string): string {
      return path.resolve(tempRoot, draggedFilesFolder);
    },
  };
}
