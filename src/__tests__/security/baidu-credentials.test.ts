// @vitest-environment node
import { EventEmitter } from 'node:events';
import type https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createSettingsManager } from '../../main/settingsManager';

function networkHarness() {
  let respond: ((response: IncomingMessage) => void) | undefined;
  let timeout: (() => void) | undefined;
  const request = Object.assign(new EventEmitter(), {
    end: vi.fn(),
    destroy: vi.fn(),
    setTimeout: vi.fn((_milliseconds: number, callback: () => void) => {
      timeout = callback;
      return request;
    }),
  });
  const network = {
    get: vi.fn((_url: string, callback: (response: IncomingMessage) => void) => {
      respond = callback;
      return request;
    }),
    request: vi.fn((_url: string, _options: https.RequestOptions, callback: (response: IncomingMessage) => void) => {
      respond = callback;
      return request;
    }),
  };
  const manager = createSettingsManager({
    app: { getPath: () => 'unused' },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
    httpsImpl: network as unknown as Pick<typeof https, 'request' | 'get'>,
  });
  return {
    manager, network, request,
    timeout: () => timeout?.(),
    reply: (body: string, statusCode = 200) => {
      const response = Object.assign(new EventEmitter(), { statusCode, headers: { location: 'https://other.invalid/' } });
      respond?.(response as IncomingMessage);
      response.emit('data', Buffer.from(body));
      response.emit('end');
    },
  };
}

describe('Baidu credential transport', () => {
  it.each([
    ['synthetic-api', 'synthetic-secret'],
    ['api +&=?#/%中文', 'secret +&client_id=other\r\n日本語'],
  ])('keeps credentials in a form body with lossless encoding: %s', async (apiKey, secretKey) => {
    const h = networkHarness();
    const pending = h.manager.validateBaiduKeys(apiKey, secretKey);
    h.reply('{"access_token":"synthetic-access-token"}');
    await expect(pending).resolves.toBe(true);
    expect(h.network.get).not.toHaveBeenCalled();
    expect(h.network.request).toHaveBeenCalledTimes(1);
    const [url, options] = h.network.request.mock.calls[0];
    expect(url).toBe('https://aip.baidubce.com/oauth/2.0/token');
    expect(options.method).toBe('POST');
    expect(options.rejectUnauthorized).not.toBe(false);
    const body = h.request.end.mock.calls[0]?.[0] as string;
    expect(typeof body).toBe('string');
    expect(Object.fromEntries(new URLSearchParams(body))).toEqual({
      grant_type: 'client_credentials', client_id: apiKey, client_secret: secretKey,
    });
    expect(options.headers).toEqual({
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    });
    expect(h.request.setTimeout).toHaveBeenCalledWith(10000, expect.any(Function));
  });

  it.each(['not-json', '{}', '{"error":"invalid_client"}'])('preserves invalid-response handling: %s', async body => {
    const h = networkHarness();
    const pending = h.manager.validateBaiduKeys('synthetic-api', 'synthetic-secret');
    h.reply(body);
    await expect(pending).resolves.toBe(false);
  });

  it('does not follow a token endpoint redirect', async () => {
    const h = networkHarness();
    const pending = h.manager.validateBaiduKeys('synthetic-api', 'synthetic-secret');
    h.reply('', 302);
    await expect(pending).resolves.toBe(false);
    expect(h.network.request.mock.calls.length + h.network.get.mock.calls.length).toBe(1);
  });

  it('preserves network-failure and timeout results', async () => {
    const failed = networkHarness();
    const failure = failed.manager.validateBaiduKeys('synthetic-api', 'synthetic-secret');
    failed.request.emit('error', new Error('synthetic network failure'));
    await expect(failure).resolves.toBe(false);

    const stalled = networkHarness();
    const pending = stalled.manager.validateBaiduKeys('synthetic-api', 'synthetic-secret');
    stalled.timeout();
    await expect(pending).resolves.toBe(false);
    expect(stalled.request.destroy).toHaveBeenCalledTimes(1);
  });
});
