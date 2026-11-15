import fs from 'fs';
import path from 'path';
import type { FileHandle } from 'fs/promises';
import { EXPORT_STAGING_PREFIX, type StagingOwner } from './sessionFiles';
import type { WriteTarget } from './pathValidator';

type FileSystem = Pick<typeof fs, 'promises'>;

export interface FileExportResult {
  cleanupWarning?: { directory: string; error: unknown };
}

async function requireRegularOrAbsent(filePath: string, fsImpl: FileSystem): Promise<void> {
  try {
    if (!(await fsImpl.promises.lstat(filePath)).isFile()) {
      throw new Error('Access denied: destination must be a regular file');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function captureWriteTarget(filePath: string, fsImpl: FileSystem = fs): Promise<WriteTarget> {
  const realParent = await fsImpl.promises.realpath(path.dirname(filePath));
  await requireRegularOrAbsent(path.join(realParent, path.basename(filePath)), fsImpl);
  return { filePath, realParent };
}

async function requireCurrentTarget(target: WriteTarget, fsImpl: FileSystem): Promise<string> {
  if (await fsImpl.promises.realpath(path.dirname(target.filePath)) !== target.realParent) {
    throw new Error('Access denied: destination directory changed');
  }
  const destination = path.join(target.realParent, path.basename(target.filePath));
  await requireRegularOrAbsent(destination, fsImpl);
  return destination;
}

// Publish only a fully written sibling file. No destination link is followed,
// and a failed copy never truncates the user's existing destination.
export async function writeExportFile(
  sourcePath: string, target: WriteTarget, fsImpl: FileSystem = fs, owner?: StagingOwner
): Promise<FileExportResult> {
  let staging: string | undefined;
  let source: FileHandle | undefined;
  let output: FileHandle | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    if (owner?.isManagedPath?.(target.filePath)) throw new Error('Final export belongs to application temporary storage');
    await requireCurrentTarget(target, fsImpl);
    staging = await fsImpl.promises.mkdtemp(path.join(target.realParent, EXPORT_STAGING_PREFIX));
    owner?.registerStaging(staging);
    const stagedFile = path.join(staging, 'output');
    output = await fsImpl.promises.open(stagedFile, 'wx', 0o600);
    source = await fsImpl.promises.open(sourcePath, 'r');
    const buffer = Buffer.allocUnsafe(128 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      let offset = 0;
      while (offset < bytesRead) {
        const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, position + offset);
        if (!bytesWritten) throw new Error('Failed to write export data');
        offset += bytesWritten;
      }
      position += bytesRead;
    }
    await output.sync();
    await output.close();
    output = undefined;
    await source.close();
    source = undefined;
    const destination = await requireCurrentTarget(target, fsImpl);
    if (owner?.isManagedPath?.(target.filePath)) throw new Error('Final export belongs to application temporary storage');
    await fsImpl.promises.rename(stagedFile, destination);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  // Close every opened handle before cleanup without masking the copy error.
  const closed = await Promise.allSettled([output?.close(), source?.close()]);
  let cleanupFailed = false;
  let cleanupError: unknown;
  try {
    if (staging) {
      owner?.beforeStagingCleanup?.(staging);
      await fsImpl.promises.rm(staging, { recursive: true, force: true });
      owner?.releaseStaging(staging);
    }
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }
  if (operationFailed) throw operationError;
  const failed = closed.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  // Publication already succeeded. A leftover empty staging directory must
  // not turn that committed export into a reported write failure.
  return cleanupFailed && staging ? { cleanupWarning: { directory: staging, error: cleanupError } } : {};
}
