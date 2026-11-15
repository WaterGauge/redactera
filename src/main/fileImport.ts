import fs from 'fs';
import path from 'path';
import type { FileHandle } from 'fs/promises';
import type { PathValidator } from './pathValidator';
import { PDF_IMPORT_ERRORS, PDF_IMPORT_LIMITS, type DroppedPdf } from '../types/fileImport';

export class PdfImportLimitError extends Error {}

type Limits = { [K in keyof typeof PDF_IMPORT_LIMITS]: number };
type FileSystem = Pick<typeof fs, 'promises'>;
type FileState = Awaited<ReturnType<FileHandle['stat']>>;

function sameFile(a: FileState, b: FileState): boolean {
  return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino &&
    a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function parseDrop(payload: unknown, limits: Limits): DroppedPdf | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  const fields = value.kind === 'path' ? ['kind', 'fileName', 'sourcePath', 'size'] :
    value.kind === 'bytes' ? ['kind', 'fileName', 'bytes'] : [];
  if (!fields.length || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key)) ||
      typeof value.fileName !== 'string' || value.fileName.length > limits.nameLength ||
      value.fileName.includes('\0') || !/\.pdf$/i.test(value.fileName)) return null;
  if (value.kind === 'path') {
    if (typeof value.sourcePath !== 'string' || value.sourcePath.length > limits.pathLength ||
        value.sourcePath.includes('\0') || !path.isAbsolute(value.sourcePath) ||
        !Number.isSafeInteger(value.size) || (value.size as number) < 5) return null;
    if ((value.size as number) > limits.fileBytes) throw new PdfImportLimitError(PDF_IMPORT_ERRORS.fileSize);
  } else {
    if (!(value.bytes instanceof Uint8Array) || !(value.bytes.buffer instanceof ArrayBuffer) ||
        value.bytes.byteOffset !== 0 || value.bytes.byteLength !== value.bytes.buffer.byteLength ||
        value.bytes.byteLength < 5) return null;
    if (value.bytes.byteLength > limits.virtualBytes) throw new PdfImportLimitError(PDF_IMPORT_ERRORS.virtualSize);
  }
  return payload as DroppedPdf;
}

function hasPdfHeader(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 1024)).includes('%PDF-');
}

/** Import only into private session storage. Native source handles never become read/deletion grants. */
export function createDroppedPdfImporter(options: {
  temporaryRoot: () => string;
  pathValidator: PathValidator;
  fsImpl?: FileSystem;
  limits?: Partial<Limits>;
  now?: () => number;
}) {
  const fsImpl = options.fsImpl ?? fs;
  const limits: Limits = { ...PDF_IMPORT_LIMITS, ...options.limits };
  const now = options.now ?? (() => performance.now());
  let active = 0, reservedBytes = 0, completedBytes = 0, retainedFiles = 0;

  return async (payload: unknown, canPublish: () => boolean = () => true): Promise<string | null> => {
    let request: DroppedPdf | null;
    try { request = parseDrop(payload, limits); }
    catch (error) { if (error instanceof PdfImportLimitError) throw error; return null; }
    if (!request) return null;
    const size = request.kind === 'path' ? request.size : request.bytes.byteLength;
    if (active >= limits.concurrent) throw new PdfImportLimitError(PDF_IMPORT_ERRORS.busy);
    if (retainedFiles + active >= limits.retainedFiles || size > limits.sessionBytes - reservedBytes - completedBytes) throw new PdfImportLimitError(PDF_IMPORT_ERRORS.sessionSize);
    active += 1; reservedBytes += size;
    const deadline = now() + limits.deadlineMs;
    const check = () => { if (now() > deadline || !canPublish()) throw new Error('PDF import is no longer current'); };
    let source: FileHandle | undefined, output: FileHandle | undefined, directory: string | undefined;
    let initial: FileState | undefined;
    let published = false;
    try {
      check();
      if (request.kind === 'path') {
        // Resolve user-selected aliases once, then reject a changed/special target.
        const canonical = await fsImpl.promises.realpath(request.sourcePath);
        const before = await fsImpl.promises.lstat(canonical);
        if (!before.isFile() || before.size !== size || before.size > limits.fileBytes) throw new Error('Invalid dropped source');
        check();
        source = await fsImpl.promises.open(canonical, fs.constants.O_RDONLY |
          (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
        initial = await source.stat();
        if (!sameFile(before, initial)) throw new Error('Dropped source changed');
        const header = Buffer.alloc(1024);
        const headerSize = Math.min(size, header.length);
        let headerBytes = 0;
        while (headerBytes < headerSize) {
          check();
          const { bytesRead } = await source.read(header, headerBytes, headerSize - headerBytes, headerBytes);
          if (!bytesRead) throw new Error('Dropped source changed');
          headerBytes += bytesRead;
        }
        if (!hasPdfHeader(header.subarray(0, headerBytes))) throw new Error('Invalid dropped PDF');
      } else if (!hasPdfHeader(request.bytes)) throw new Error('Invalid dropped PDF');
      check();

      const root = await fsImpl.promises.realpath(options.temporaryRoot());
      const parent = options.pathValidator.getDraggedFilesDirectory(root);
      await fsImpl.promises.mkdir(parent, { recursive: true, mode: 0o700 });
      const realParent = await fsImpl.promises.realpath(parent);
      if (!options.pathValidator.isPathInsideDirectory(realParent, root)) throw new Error('Invalid import directory');
      directory = await fsImpl.promises.mkdtemp(path.join(realParent, 'import-'));
      const destination = path.join(directory, options.pathValidator.sanitizeDraggedFileName(request.fileName));
      if (!options.pathValidator.isPathInsideDirectory(destination, directory)) throw new Error('Invalid import destination');
      const target = await fsImpl.promises.open(destination, 'wx', 0o600);
      output = target;
      const write = async (bytes: Buffer, length: number, position: number) => {
        let offset = 0;
        while (offset < length) {
          check();
          const { bytesWritten } = await target.write(bytes, offset, length - offset, position + offset);
          if (!bytesWritten) throw new Error('Failed to write imported PDF');
          offset += bytesWritten;
        }
      };
      if (source) {
        const buffer = Buffer.allocUnsafe(128 * 1024);
        let position = 0;
        while (position < size) {
          check();
          const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, size - position), position);
          if (!bytesRead) throw new Error('Dropped source changed');
          check();
          await write(buffer, bytesRead, position);
          position += bytesRead;
        }
        const tail = await source.read(buffer, 0, 1, size);
        if (tail.bytesRead || !initial || !sameFile(initial, await source.stat())) throw new Error('Dropped source changed');
        await source.close(); source = undefined;
      } else if (request.kind === 'bytes') {
        const bytes = Buffer.from(request.bytes.buffer, request.bytes.byteOffset, size);
        await write(bytes, bytes.length, 0);
      }
      check();
      await output.sync();
      await output.close(); output = undefined;
      check();
      options.pathValidator.addAllowedPath(destination);
      published = true;
      return destination;
    } catch (error) {
      if (error instanceof PdfImportLimitError) throw error;
      return null;
    } finally {
      await Promise.allSettled([source?.close(), output?.close()]);
      let retained = published;
      if (directory && !published) {
        try { await fsImpl.promises.rm(directory, { recursive: true, force: true }); }
        catch { retained = true; /* Retained partial data still consumes both budgets. */ }
      }
      if (retained) { completedBytes += size; retainedFiles += 1; }
      reservedBytes -= size; active -= 1;
    }
  };
}
