// @vitest-environment node
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDF_IMPORT_ERRORS, PDF_IMPORT_LIMITS } from '../../types/fileImport';

const bridge = vi.hoisted(() => ({
  api: {} as Record<string, unknown>,
  paths: new WeakMap<object, string>(),
  invoke: vi.fn(),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: Record<string, unknown>) => { bridge.api = api; } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), removeListener: vi.fn() },
  webUtils: { getPathForFile: (file: unknown) => {
    if (!(file instanceof File)) throw new TypeError('not a File');
    return bridge.paths.get(file) ?? '';
  } },
}));
beforeAll(async () => { await import('../../preload'); });

const PDF = '%PDF-1.7\nSYNTHETIC\n%%EOF';
const importFile = (file: unknown) => (bridge.api.importDroppedFile as (file: unknown) => Promise<string | null>)(file);
beforeEach(() => { bridge.invoke.mockReset().mockResolvedValue('/owned/import.pdf'); bridge.paths = new WeakMap(); });

describe('File-only preload import', () => {
  it('keeps native paths inside preload and avoids reading disk Files into memory', async () => {
    const file = new File([PDF], 'source.pdf');
    bridge.paths.set(file, '/synthetic/native.pdf');
    const read = vi.spyOn(Blob.prototype, 'arrayBuffer');
    try {
      await expect(importFile(file)).resolves.toBe('/owned/import.pdf');
      expect(bridge.invoke).toHaveBeenCalledWith('file:saveDragged', {
        kind: 'path', fileName: 'source.pdf', sourcePath: '/synthetic/native.pdf', size: Buffer.byteLength(PDF),
      });
      expect(read).not.toHaveBeenCalled();
      expect(bridge.api.getPathForFile).toBeUndefined();
      expect(bridge.api.saveDraggedFile).toBeUndefined();
    } finally { read.mockRestore(); }
  });

  it('sends typed bytes for a genuine virtual File without inferring authority from its name', async () => {
    const file = new File([PDF], '/synthetic/secret.pdf');
    await importFile(file);
    const payload = bridge.invoke.mock.calls[0][1];
    expect(payload.kind).toBe('bytes');
    expect(payload.bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(payload.bytes).toString()).toBe(PDF);
    expect(payload).not.toHaveProperty('sourcePath');
  });

  it('rejects plain objects, raw paths and Blobs without invoking Main', async () => {
    for (const fake of ['/synthetic/secret.pdf', { name: 'fake.pdf', path: '/synthetic/secret.pdf', size: 16 }, new Blob([PDF]), null]) {
      await expect(importFile(fake)).resolves.toBeNull();
    }
    expect(bridge.invoke).not.toHaveBeenCalled();
  });

  it('uses native File/Blob metadata rather than overridden properties', async () => {
    const file = new File([PDF], 'source.pdf');
    Object.defineProperties(file, { name: { value: 'forged.pdf' }, size: { value: 1 } });
    await importFile(file);
    expect(bridge.invoke.mock.calls[0][1].fileName).toBe('source.pdf');
    expect(bridge.invoke.mock.calls[0][1].bytes.byteLength).toBe(Buffer.byteLength(PDF));
  });

  it('rejects an oversized virtual File before reading it or crossing IPC', async () => {
    const file = new File([new Uint8Array(PDF_IMPORT_LIMITS.virtualBytes + 1)], 'big.pdf');
    const read = vi.spyOn(Blob.prototype, 'arrayBuffer');
    try {
      await expect(importFile(file)).rejects.toThrow(PDF_IMPORT_ERRORS.virtualSize);
      expect(read).not.toHaveBeenCalled();
      expect(bridge.invoke).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  });

  it('caps pending bridge imports and releases the slots on resolution', async () => {
    const resolve: Array<(value: string) => void> = [];
    bridge.invoke.mockImplementation(() => new Promise<string>(done => resolve.push(done)));
    const file = new File([PDF], 'disk.pdf');
    bridge.paths.set(file, '/synthetic/disk.pdf');
    const a = importFile(file), b = importFile(file);
    await expect(importFile(file)).rejects.toThrow(PDF_IMPORT_ERRORS.busy);
    resolve.forEach(done => done('/owned/copy.pdf'));
    await Promise.all([a, b]);
    bridge.invoke.mockResolvedValue('/owned/next.pdf');
    await expect(importFile(file)).resolves.toBe('/owned/next.pdf');
  });
});
