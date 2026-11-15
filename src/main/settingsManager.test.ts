import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { createSettingsManager } from './settingsManager';
import { DEFAULT_SETTINGS, type AppSettings } from '../types/settings';

function createValidSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
  };
}

describe('settingsManager', () => {
  it('reads, decrypts, and validates encrypted settings', () => {
    const encrypted = {
      ...createValidSettings(),
      paddle_token: Buffer.from('token').toString('base64'),
      baidu_api_key: Buffer.from('api').toString('base64'),
      baidu_secret_key: Buffer.from('secret').toString('base64'),
      _encrypted: true,
    };

    const manager = createSettingsManager({
      platform: 'darwin',
      app: { getPath: vi.fn(() => '/tmp/userData') } as any,
      safeStorage: {
        isEncryptionAvailable: vi.fn(() => true),
        encryptString: vi.fn(),
        decryptString: vi.fn((value: Buffer) => `dec:${value.toString()}`),
      } as any,
      fsImpl: {
        readFileSync: vi.fn(() => JSON.stringify(encrypted)),
        writeFileSync: vi.fn(),
      } as any,
    });

    const result = manager.readSettings();

    expect(result.paddle_token).toBe('dec:token');
    expect(result.baidu_api_key).toBe('dec:api');
    expect(result.baidu_secret_key).toBe('dec:secret');
    expect(result).not.toHaveProperty('_encrypted');
    expect(result.credential_storage_status).toBe('available');
  });

  it('falls back to defaults when settings file is invalid or unreadable', () => {
    const managerInvalid = createSettingsManager({
      platform: 'darwin',
      app: { getPath: vi.fn(() => '/tmp/userData') } as any,
      safeStorage: {
        isEncryptionAvailable: vi.fn(() => false),
        encryptString: vi.fn(),
        decryptString: vi.fn(),
      } as any,
      fsImpl: {
        readFileSync: vi.fn(() => JSON.stringify({ ...createValidSettings(), export_dpi: 999 })),
        writeFileSync: vi.fn(),
      } as any,
    });

    const managerReadError = createSettingsManager({
      platform: 'darwin',
      app: { getPath: vi.fn(() => '/tmp/userData') } as any,
      safeStorage: {
        isEncryptionAvailable: vi.fn(() => false),
        encryptString: vi.fn(),
        decryptString: vi.fn(),
      } as any,
      fsImpl: {
        readFileSync: vi.fn(() => {
          throw new Error('boom');
        }),
        writeFileSync: vi.fn(),
      } as any,
    });

    expect(managerInvalid.readSettings()).toMatchObject({ ...DEFAULT_SETTINGS, credential_storage_status: 'read-error' });
    expect(managerReadError.readSettings()).toMatchObject({ ...DEFAULT_SETTINGS, credential_storage_status: 'read-error' });
  });

  it('writes encrypted settings when safeStorage is available', () => {
    const writeFileSync = vi.fn();
    const manager = createSettingsManager({
      platform: 'darwin',
      app: { getPath: vi.fn(() => '/tmp/userData') } as any,
      safeStorage: {
        isEncryptionAvailable: vi.fn(() => true),
        encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`)),
        decryptString: vi.fn(),
      } as any,
      fsImpl: {
        readFileSync: vi.fn(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }),
        writeFileSync,
        openSync: vi.fn(() => 42), fsyncSync: vi.fn(), closeSync: vi.fn(), renameSync: vi.fn(), unlinkSync: vi.fn(),
      } as any,
    });

    manager.writeSettings(
      createValidSettings({
        paddle_token: 'token-plain',
        baidu_api_key: 'key-plain',
        baidu_secret_key: 'secret-plain',
      })
    );

    const savedJson = writeFileSync.mock.calls[0]?.[1] as string;
    const saved = JSON.parse(savedJson) as AppSettings & { _encrypted?: boolean };
    expect(saved.paddle_token).toBe(Buffer.from('enc:token-plain').toString('base64'));
    expect(saved.baidu_api_key).toBe(Buffer.from('enc:key-plain').toString('base64'));
    expect(saved.baidu_secret_key).toBe(Buffer.from('enc:secret-plain').toString('base64'));
    expect(saved._encrypted).toBe(true);
  });

  it('rejects invalid settings and refuses plaintext persistence when encryption is unavailable', () => {
    const writeFileSync = vi.fn();
    const manager = createSettingsManager({
      platform: 'darwin',
      app: { getPath: vi.fn(() => '/tmp/userData') } as any,
      safeStorage: {
        isEncryptionAvailable: vi.fn(() => false),
        encryptString: vi.fn(),
        decryptString: vi.fn(),
      } as any,
      fsImpl: {
        readFileSync: vi.fn(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }),
        writeFileSync,
      } as any,
    });

    expect(() => manager.writeSettings({} as AppSettings)).toThrow('Invalid settings format');

    expect(() => manager.writeSettings(createValidSettings({ paddle_token: 'raw-token' }))).toThrow('系统安全存储不可用');
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('validates Baidu keys through HTTP response/error/timeout handling', async () => {
    const createHttpsStub = () => {
      const requestEvents: Record<string, (...args: any[]) => void> = {};
      let responseHandler: ((response: EventEmitter) => void) | null = null;
      const request = {
        on: vi.fn((event: string, handler: (...args: any[]) => void) => {
          requestEvents[event] = handler;
          return request;
        }),
        setTimeout: vi.fn((_timeout: number, handler: () => void) => {
          requestEvents.timeout = handler;
          return request;
        }),
        destroy: vi.fn(),
        end: vi.fn(),
      };

      return {
        httpsImpl: {
          request: vi.fn((_url: string, _options: unknown, handler: (response: EventEmitter) => void) => {
            responseHandler = handler;
            return request;
          }),
        },
        requestEvents,
        request,
        triggerResponse(body: string) {
          const response = new EventEmitter();
          responseHandler?.(response);
          response.emit('data', body);
          response.emit('end');
        },
      };
    };

    const successStub = createHttpsStub();
    const managerSuccess = createSettingsManager({
      platform: 'darwin',
      app: { getPath: vi.fn(() => '/tmp/userData') } as any,
      safeStorage: {
        isEncryptionAvailable: vi.fn(() => false),
        encryptString: vi.fn(),
        decryptString: vi.fn(),
      } as any,
      httpsImpl: successStub.httpsImpl as any,
    });
    const successPromise = managerSuccess.validateBaiduKeys('api key', 'secret/key');
    successStub.triggerResponse(JSON.stringify({ access_token: 'token' }));
    await expect(successPromise).resolves.toBe(true);
    expect(successStub.httpsImpl.request).toHaveBeenCalledWith(
      'https://aip.baidubce.com/oauth/2.0/token',
      expect.objectContaining({ method: 'POST' }),
      expect.any(Function)
    );
    expect(Object.fromEntries(new URLSearchParams(successStub.request.end.mock.calls[0][0]))).toEqual({
      grant_type: 'client_credentials', client_id: 'api key', client_secret: 'secret/key',
    });

    const parseFailureStub = createHttpsStub();
    const managerParseFailure = createSettingsManager({
      platform: 'darwin',
      app: { getPath: vi.fn(() => '/tmp/userData') } as any,
      safeStorage: {
        isEncryptionAvailable: vi.fn(() => false),
        encryptString: vi.fn(),
        decryptString: vi.fn(),
      } as any,
      httpsImpl: parseFailureStub.httpsImpl as any,
    });
    const parseFailurePromise = managerParseFailure.validateBaiduKeys('api', 'secret');
    parseFailureStub.triggerResponse('not-json');
    await expect(parseFailurePromise).resolves.toBe(false);

    const errorStub = createHttpsStub();
    const managerError = createSettingsManager({
      platform: 'darwin',
      app: { getPath: vi.fn(() => '/tmp/userData') } as any,
      safeStorage: {
        isEncryptionAvailable: vi.fn(() => false),
        encryptString: vi.fn(),
        decryptString: vi.fn(),
      } as any,
      httpsImpl: errorStub.httpsImpl as any,
    });
    const errorPromise = managerError.validateBaiduKeys('api', 'secret');
    errorStub.requestEvents.error?.(new Error('network'));
    await expect(errorPromise).resolves.toBe(false);

    const timeoutStub = createHttpsStub();
    const managerTimeout = createSettingsManager({
      platform: 'darwin',
      app: { getPath: vi.fn(() => '/tmp/userData') } as any,
      safeStorage: {
        isEncryptionAvailable: vi.fn(() => false),
        encryptString: vi.fn(),
        decryptString: vi.fn(),
      } as any,
      httpsImpl: timeoutStub.httpsImpl as any,
    });
    const timeoutPromise = managerTimeout.validateBaiduKeys('api', 'secret');
    timeoutStub.requestEvents.timeout?.();
    await expect(timeoutPromise).resolves.toBe(false);
    expect(timeoutStub.request.destroy).toHaveBeenCalled();
  });
});
