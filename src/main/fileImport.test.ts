// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDroppedPdfImporter } from './fileImport';
import { createPathValidator } from './pathValidator';
import { PDF_IMPORT_ERRORS } from '../types/fileImport';

const PDF = Buffer.from('%PDF-1.7\nSYNTHETIC ORIGINAL\n%%EOF\n');
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });

function harness(options: Partial<Parameters<typeof createDroppedPdfImporter>[0]> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-copy-'));
  roots.push(root);
  const validators = createPathValidator();
  const importer = createDroppedPdfImporter({ temporaryRoot: () => root, pathValidator: validators, ...options });
  const bytes = (content = PDF) => ({ kind: 'bytes', fileName: 'same.pdf', bytes: new Uint8Array(content) });
  const source = path.join(root, 'source.pdf');
  fs.writeFileSync(source, PDF);
  const disk = () => ({ kind: 'path', fileName: 'same.pdf', sourcePath: source, size: PDF.length });
  return { root, source, validators, importer, bytes, disk,
    leftovers: () => fs.existsSync(path.join(root, 'pdf-desensitization')) ? fs.readdirSync(path.join(root, 'pdf-desensitization')) : [] };
}
function savedPath(value: unknown): string {
  expect(typeof value).toBe('string');
  if (typeof value !== 'string') throw new Error('Import did not produce a private file');
  return value;
}
const withOpen = (open: typeof fs.promises.open) => ({ promises: { ...fs.promises, open } });

describe('Bounded private PDF copies', () => {
  it('handles partial writes without losing or duplicating bytes', async () => {
    const h = harness({ fsImpl: withOpen(async (...args) => {
      const handle = await fs.promises.open(...args);
      if (args[1] === 'wx') {
        const write = handle.write.bind(handle);
        handle.write = ((buffer: Buffer, offset: number, length: number, position: number) =>
          write(buffer, offset, Math.min(length, 7), position)) as typeof handle.write;
      }
      return handle;
    }) });
    const saved = await h.importer(h.disk());
    expect(fs.readFileSync(savedPath(saved))).toEqual(PDF);
    expect(fs.readFileSync(h.source)).toEqual(PDF);
  });

  it('does not replace a newer same-name import when the first write finishes late', async () => {
    let release: (() => void) | undefined;
    let firstOutput = true;
    const h = harness({ fsImpl: withOpen(async (...args) => {
      if (args[1] === 'wx' && firstOutput) {
        firstOutput = false;
        await new Promise<void>(resolve => { release = resolve; });
      }
      return fs.promises.open(...args);
    }) });
    const old = h.importer(h.bytes());
    await vi.waitFor(() => expect(typeof release).toBe('function'));
    const newerBytes = Buffer.from('%PDF-1.7\nNEWER COPY\n%%EOF\n');
    const newer = await h.importer(h.bytes(newerBytes));
    if (!release) throw new Error('First write was not pending');
    release();
    const older = await old;
    expect(older).not.toBe(newer);
    expect(fs.readFileSync(savedPath(newer))).toEqual(newerBytes);
    expect(fs.readFileSync(savedPath(older))).toEqual(PDF);
  });

  it('checks actual source size and reads at most its reserved bytes when it grows', async () => {
    let source = '', written = 0;
    const h = harness({ fsImpl: withOpen(async (...args) => {
      const handle = await fs.promises.open(...args);
      if (args[1] === 'wx') {
        fs.appendFileSync(source, Buffer.alloc(1024 * 1024, 65));
        const write = handle.write.bind(handle);
        handle.write = (async (buffer: Buffer, offset: number, length: number, position: number) => {
          const result = await write(buffer, offset, length, position);
          written += result.bytesWritten;
          return result;
        }) as typeof handle.write;
      }
      return handle;
    }) });
    source = h.source;
    await expect(h.importer(h.disk())).resolves.toBeNull();
    expect(written).toBeLessThanOrEqual(PDF.length);
    expect(h.validators.allowedPaths.size).toBe(0);
    expect(h.leftovers()).toEqual([]);
    expect(fs.statSync(source).size).toBe(PDF.length + 1024 * 1024);
  });

  it('rejects a claimed size mismatch before creating any output', async () => {
    const h = harness();
    await expect(h.importer({ ...h.disk(), size: PDF.length + 1 })).resolves.toBeNull();
    expect(h.leftovers()).toEqual([]);
    expect(h.validators.allowedPaths.size).toBe(0);
  });

  it('cleans failed private output and releases its storage reservation', async () => {
    let fail = true;
    const h = harness({ limits: { sessionBytes: PDF.length }, fsImpl: withOpen(async (...args) => {
      const handle = await fs.promises.open(...args);
      if (args[1] === 'wx' && fail) {
        fail = false;
        handle.write = (async () => { throw new Error('synthetic disk failure'); }) as typeof handle.write;
      }
      return handle;
    }) });
    await expect(h.importer(h.bytes())).resolves.toBeNull();
    expect(h.leftovers()).toEqual([]);
    expect(h.validators.allowedPaths.size).toBe(0);
    expect(typeof await h.importer(h.bytes())).toBe('string');
  });

  it('keeps storage charged when a failed private copy cannot be removed', async () => {
    const h = harness({ limits: { sessionBytes: PDF.length },
      fsImpl: { promises: { ...fs.promises,
        open: async (...args) => {
          const handle = await fs.promises.open(...args);
          if (args[1] === 'wx') handle.write = (async () => { throw new Error('synthetic disk failure'); }) as typeof handle.write;
          return handle;
        },
        rm: async () => { throw new Error('synthetic cleanup failure'); },
      } },
    });
    await expect(h.importer(h.bytes())).resolves.toBeNull();
    expect(h.leftovers()).toHaveLength(1);
    expect(h.validators.allowedPaths.size).toBe(0);
    await expect(h.importer(h.bytes())).rejects.toThrow(PDF_IMPORT_ERRORS.sessionSize);
  });

  it('bounds retained entries even when each accepted file contains only a PDF header', async () => {
    const h = harness();
    const tiny = h.bytes(Buffer.from('%PDF-'));
    for (let count = 0; count < 128; count += 1) expect(typeof await h.importer(tiny)).toBe('string');
    await expect(h.importer(tiny)).rejects.toThrow(PDF_IMPORT_ERRORS.sessionSize);
    expect(h.validators.allowedPaths.size).toBe(128);
  });

  it('counts failed output whose cleanup fails toward the retained-entry cap', async () => {
    const h = harness({ limits: { retainedFiles: 1 },
      fsImpl: { promises: { ...fs.promises,
        open: async (...args) => {
          const handle = await fs.promises.open(...args);
          if (args[1] === 'wx') handle.write = (async () => { throw new Error('synthetic write failure'); }) as typeof handle.write;
          return handle;
        },
        rm: async () => { throw new Error('synthetic retained output'); },
      } },
    });
    await expect(h.importer(h.bytes())).resolves.toBeNull();
    await expect(h.importer(h.bytes())).rejects.toThrow(PDF_IMPORT_ERRORS.sessionSize);
    expect(h.leftovers()).toHaveLength(1);
  });

  it('rejects a small view carrying an oversized underlying allocation', async () => {
    const h = harness({ limits: { virtualBytes: 1024 } });
    const bytes = new Uint8Array(new ArrayBuffer(1025), 0, PDF.length);
    bytes.set(PDF);
    await expect(h.importer({ kind: 'bytes', fileName: 'view.pdf', bytes })).resolves.toBeNull();
    expect(h.validators.allowedPaths.size).toBe(0);
  });

  it('accepts a normal PDF when reads return fewer bytes than requested', async () => {
    const h = harness({ fsImpl: withOpen(async (...args) => {
      const handle = await fs.promises.open(...args);
      if (args[1] !== 'wx') {
        const read = handle.read.bind(handle);
        handle.read = ((buffer: Buffer, offset: number, length: number, position: number) =>
          read(buffer, offset, Math.min(length, 1), position)) as typeof handle.read;
      }
      return handle;
    }) });
    const saved = await h.importer(h.disk());
    expect(fs.readFileSync(savedPath(saved))).toEqual(PDF);
  });

  it('caps concurrent copies before accepting a third output', async () => {
    const releases: Array<() => void> = [];
    const h = harness({ fsImpl: withOpen(async (...args) => {
      if (args[1] === 'wx') await new Promise<void>(resolve => releases.push(resolve));
      return fs.promises.open(...args);
    }) });
    const first = h.importer(h.bytes()), second = h.importer(h.bytes());
    await vi.waitFor(() => expect(releases.length).toBe(2));
    await expect(h.importer(h.bytes())).rejects.toThrow(PDF_IMPORT_ERRORS.busy);
    releases.forEach(resolve => resolve());
    const saved = await Promise.all([first, second]);
    expect(saved.every(value => typeof value === 'string')).toBe(true);
    expect(h.validators.allowedPaths.size).toBe(2);
  });

  it('counts completed copies toward the session budget and accepts the exact boundary', async () => {
    const h = harness({ limits: { sessionBytes: PDF.length * 2, virtualBytes: PDF.length } });
    expect(typeof await h.importer(h.bytes())).toBe('string');
    expect(typeof await h.importer(h.bytes())).toBe('string');
    await expect(h.importer(h.bytes())).rejects.toThrow(PDF_IMPORT_ERRORS.sessionSize);
    expect(h.validators.allowedPaths.size).toBe(2);
  });

  it('enforces native and virtual size caps before reading or allocating output', async () => {
    const h = harness({ limits: { fileBytes: PDF.length - 1, virtualBytes: PDF.length - 1 } });
    await expect(h.importer(h.disk())).rejects.toThrow(PDF_IMPORT_ERRORS.fileSize);
    await expect(h.importer(h.bytes())).rejects.toThrow(PDF_IMPORT_ERRORS.virtualSize);
    expect(h.leftovers()).toEqual([]);
  });

  it('rejects a non-PDF, directory and special payload representations', async () => {
    const h = harness();
    for (const payload of [
      h.bytes(Buffer.from('this contains no PDF header')),
      { ...h.disk(), sourcePath: h.root },
      { ...h.disk(), sourcePath: 'relative.pdf' },
      { ...h.bytes(), bytes: new DataView(new ArrayBuffer(8)) },
      { ...h.bytes(), extra: 'not allowed' },
      { ...h.bytes(), bytes: new Uint8Array(new SharedArrayBuffer(8)) },
    ]) await expect(h.importer(payload)).resolves.toBeNull();
    expect(h.validators.allowedPaths.size).toBe(0);
  });

  it('resolves an explicitly selected filesystem alias but grants neither alias nor target', async () => {
    const h = harness();
    const original = path.join(h.root, 'originals'), alias = path.join(h.root, 'alias');
    fs.mkdirSync(original);
    fs.writeFileSync(path.join(original, 'source.pdf'), PDF);
    fs.symlinkSync(original, alias, 'junction');
    const selected = path.join(alias, 'source.pdf');
    const saved = await h.importer({ ...h.disk(), sourcePath: selected });
    expect(fs.readFileSync(savedPath(saved))).toEqual(PDF);
    expect(h.validators.isResolvedPathAllowed(selected)).toBe(false);
    expect(h.validators.isResolvedPathAllowed(path.join(original, 'source.pdf'))).toBe(false);
  });

  it.each(['owner', 'deadline'])('refuses publication after %s changes during the copy', async kind => {
    let valid = true, clock = 0;
    const h = harness({ now: () => clock, fsImpl: withOpen(async (...args) => {
      const handle = await fs.promises.open(...args);
      if (args[1] === 'wx') {
        if (kind === 'owner') valid = false; else clock = 30_001;
      }
      return handle;
    }) });
    await expect(h.importer(h.bytes(), () => valid)).resolves.toBeNull();
    expect(h.validators.allowedPaths.size).toBe(0);
    expect(h.leftovers()).toEqual([]);
  });
});
