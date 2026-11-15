// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerCoreHandlers } from '../../main/ipcHandlers';
import { createPathValidator } from '../../main/pathValidator';
import { DEFAULT_SETTINGS } from '../../types/settings';

const roots: string[] = [];
const PDF = Buffer.from('%PDF-1.7\nSYNTHETIC ORIGINAL\n%%EOF\n');
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-pdf-import-'));
  roots.push(root);
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const validators = createPathValidator();
  const frame = { url: 'file:///synthetic/index.html' };
  const sender = { mainFrame: frame, isDestroyed: () => false };
  const event = { sender, senderFrame: frame };
  registerCoreHandlers({
    ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler) },
    app: { getPath: () => root }, temporaryRoot: () => root,
    pageUrl: frame.url,
    mainWindowProvider: () => ({ isDestroyed: () => false, webContents: sender }),
    pathValidator: validators,
    dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
    settingsManager: { readSettings: () => DEFAULT_SETTINGS },
    pythonProcessManager: { send: vi.fn() },
    logger: { log: vi.fn(), initialize: vi.fn() },
  } as unknown as Parameters<typeof registerCoreHandlers>[0]);
  const call = (payload: unknown, owner: unknown = event) =>
    Promise.resolve().then(() => handlers.get('file:saveDragged')?.(owner, payload));
  return { root, validators, call, event };
}

describe('Dropped PDF import boundary', () => {
  it('copies a disk-backed PDF to a private identity without granting its source', async () => {
    const h = harness(), source = path.join(h.root, '中文 # + original.pdf');
    fs.writeFileSync(source, PDF);
    const saved = await h.call({ kind: 'path', fileName: '中文 # + original.pdf', sourcePath: source, size: PDF.length });
    expect(typeof saved).toBe('string');
    expect(saved).not.toBe(source);
    expect(fs.readFileSync(saved as string)).toEqual(PDF);
    expect(fs.readFileSync(source)).toEqual(PDF);
    expect(h.validators.isResolvedPathAllowed(source)).toBe(false);
    expect(h.validators.isResolvedPathAllowed(saved as string)).toBe(true);
  });

  it('keeps bounded in-memory File compatibility using typed bytes', async () => {
    const h = harness();
    const saved = await h.call({ kind: 'bytes', fileName: 'virtual.pdf', bytes: new Uint8Array(PDF) });
    expect(typeof saved).toBe('string');
    expect(fs.readFileSync(saved as string)).toEqual(PDF);
  });

  it.each([undefined, null, [], 'not-a-payload'])('rejects malformed payloads consistently: %s', async payload => {
    const h = harness();
    await expect(h.call(payload)).resolves.toBeNull();
    expect(h.validators.allowedPaths.size).toBe(0);
  });

  it('rejects legacy numeric arrays instead of coercing their elements', async () => {
    const h = harness();
    await expect(h.call({ fileName: 'coerced.pdf', buffer: [...PDF, -1, 256, 0.5, null, '1'] })).resolves.toBeNull();
    expect(h.validators.allowedPaths.size).toBe(0);
  });

  it('rejects an overlong name before normalization', async () => {
    const h = harness();
    await expect(h.call({ fileName: 'x'.repeat(1025) + '.pdf', buffer: [...PDF] })).resolves.toBeNull();
    expect(h.validators.allowedPaths.size).toBe(0);
  });

  it.each(['query', 'fragment', 'subframe'])('rejects the wrong trusted-document representation: %s', async variant => {
    const h = harness();
    if (variant === 'query') h.event.senderFrame.url += '?other';
    if (variant === 'fragment') h.event.senderFrame.url += '#other';
    if (variant === 'subframe') h.event.senderFrame = { url: 'file:///synthetic/index.html' };
    await expect(h.call({ kind: 'bytes', fileName: 'valid.pdf', bytes: new Uint8Array(PDF) })).resolves.toBeNull();
    expect(h.validators.allowedPaths.size).toBe(0);
  });

  it('rejects another sender even with an otherwise valid legacy PDF payload', async () => {
    const h = harness();
    await expect(h.call({ fileName: 'spoof.pdf', buffer: [...PDF] }, {
      sender: { mainFrame: h.event.senderFrame }, senderFrame: h.event.senderFrame,
    })).resolves.toBeNull();
    expect(h.validators.allowedPaths.size).toBe(0);
  });
});
