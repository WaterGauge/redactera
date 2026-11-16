import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerIpcHandlers, updateConstants } from './ipcHandlers';

type Handler = (...args: unknown[]) => unknown;
const pageUrl = (page: number) => `${updateConstants.GITHUB_RELEASES_API_URL}?per_page=100&page=${page}`;
const nextLink = (page: number) => `<https://api.github.com/repositories/123/releases?per_page=100&page=${page}>; rel="next"`;
const release = (tag_name: string, draft = false, prerelease = false) => ({ tag_name, draft, prerelease, body: tag_name });
const json = (data: unknown, headers: Record<string, string> = {}, status = 200) => new Response(JSON.stringify(data), { status, headers });

function harness() {
  const handlers = new Map<string, Handler>();
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetcher);
  registerIpcHandlers({
    ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
    app: { getVersion: () => '2.0.0' }, shell: { openExternal: vi.fn() }, registerCoreHandlers: vi.fn(),
  } as unknown as Parameters<typeof registerIpcHandlers>[0]);
  const handler = handlers.get('updates:check');
  if (!handler) throw new Error('Update handler was not registered');
  const check = (includePrerelease = false) => handler({}, { includePrerelease });
  return { fetcher, check };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function failed(code = 'UPDATE_CHECK_FAILED') {
  return { updateAvailable: false, currentVersion: '2.0.0', latestVersion: '2.0.0', error: { code } };
}

describe('bounded release pagination and rate-limit recovery', () => {
  it.each([false, true])('chooses across pages, including old-date newer tags (prerelease=%s)', async includePrerelease => {
    const h = harness();
    h.fetcher.mockResolvedValueOnce(json([release('v2.1.0'), release('v3.0.0-rc.1')], { link: nextLink(2) }))
      .mockResolvedValueOnce(json([release('v9.0.0', true), release('v2.2.0'), release('v8.0.0', false, true)]));
    expect(await h.check(includePrerelease)).toMatchObject({ updateAvailable: true, latestVersion: includePrerelease ? '8.0.0' : '2.2.0' });
    expect(h.fetcher.mock.calls.map(call => call[0])).toEqual([pageUrl(1), pageUrl(2)]);
    expect(h.fetcher.mock.calls[0][1]?.signal).toBe(h.fetcher.mock.calls[1][1]?.signal);
    expect(h.fetcher.mock.calls[1][1]?.redirect).toBe('error');
  });
  it.each(['HTTP', 'network', 'malformed'])('does not return a partial update result after later %s failure', async kind => {
    const h = harness(); h.fetcher.mockResolvedValueOnce(json([release('v2.1.0')], { link: nextLink(2) }));
    if (kind === 'network') h.fetcher.mockRejectedValueOnce(new Error('offline'));
    else h.fetcher.mockResolvedValueOnce(kind === 'HTTP' ? json({}, {}, 503) : json([null]));
    expect(await h.check()).toMatchObject(failed()); expect(h.fetcher).toHaveBeenCalledTimes(2);
    h.fetcher.mockResolvedValueOnce(json([release('v2.2.0')]));
    expect(await h.check()).toMatchObject({ updateAvailable: true, latestVersion: '2.2.0' });
  });
  it.each([
    '<https://example.com/releases?page=2>; rel="next"',
    '<https://api.github.com/repos/Other/repo/releases?page=2>; rel="next"',
    nextLink(1), nextLink(2) + ', ' + nextLink(2), 'malformed',
    '<https://api.github.com/repositories/123/releases?per_page=30&page=2>; rel="next"',
  ])('rejects invalid next metadata without another fetch: %s', async link => {
    const h = harness(); h.fetcher.mockResolvedValueOnce(json([], { link }));
    expect(await h.check()).toMatchObject(failed()); expect(h.fetcher).toHaveBeenCalledOnce();
  });
  it('rejects a still-incomplete scan at its page bound', async () => {
    const h = harness();
    for (let page = 1; page <= 20; page++) h.fetcher.mockResolvedValueOnce(json([], { link: nextLink(page + 1) }));
    expect(await h.check()).toMatchObject(failed()); expect(h.fetcher).toHaveBeenCalledTimes(20);
  });
  it('shares a single deadline across pages and releases the check lock on timeout', async () => {
    vi.useFakeTimers(); const h = harness();
    h.fetcher.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(json([], { link: nextLink(2) })), 8000)))
      .mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      }));
    const pending = h.check(); await vi.advanceTimersByTimeAsync(8000);
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000); expect(await pending).toMatchObject(failed('UPDATE_CHECK_TIMEOUT'));
    h.fetcher.mockResolvedValueOnce(json([])); expect(await h.check()).toMatchObject({ updateAvailable: false, latestVersion: '2.0.0' });
  });
  it.each([
    [429, { 'retry-after': '120' }, {}, 120000],
    [403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000090' }, {}, 90000],
    [403, {}, { message: 'You have exceeded a secondary rate limit.' }, 60000],
  ] as const)('honors rate limits without automatic or premature retries (%s)', async (status, headers, body, wait) => {
    vi.useFakeTimers(); vi.setSystemTime(1800000000000); const h = harness();
    h.fetcher.mockResolvedValueOnce(json(body, headers, status));
    expect(await h.check()).toMatchObject(failed('UPDATE_CHECK_RATE_LIMITED'));
    await vi.advanceTimersByTimeAsync(wait - 1);
    expect(await h.check(true)).toMatchObject(failed('UPDATE_CHECK_RATE_LIMITED')); expect(h.fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); h.fetcher.mockResolvedValueOnce(json([release('v2.0.1')]));
    expect(await h.check()).toMatchObject({ updateAvailable: true, latestVersion: '2.0.1' }); expect(h.fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not treat an ordinary 403 as a rate limit', async () => {
    const h = harness(); h.fetcher.mockResolvedValueOnce(json({ message: 'Forbidden' }, {}, 403));
    expect(await h.check()).toMatchObject(failed()); h.fetcher.mockResolvedValueOnce(json([]));
    expect(await h.check()).toMatchObject({ updateAvailable: false }); expect(h.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([true, false])('respects exhausted quota on a successful page (has next=%s)', async next => {
    const h = harness(); h.fetcher.mockResolvedValueOnce(json([release('v2.0.1')], {
      'x-ratelimit-remaining': '0', ...(next ? { link: nextLink(2) } : {}),
    }));
    expect(await h.check()).toMatchObject(next ? failed('UPDATE_CHECK_RATE_LIMITED') : { updateAvailable: true, latestVersion: '2.0.1' });
    expect(await h.check()).toMatchObject(failed('UPDATE_CHECK_RATE_LIMITED')); expect(h.fetcher).toHaveBeenCalledOnce();
  });
  it('serializes simultaneous update checks rather than issuing extra API calls', async () => {
    const h = harness(); let complete!: (response: Response) => void;
    h.fetcher.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const first = h.check(); expect(await h.check(true)).toMatchObject(failed('UPDATE_CHECK_BUSY'));
    expect(h.fetcher).toHaveBeenCalledOnce(); complete(json([release('v2.1.0')]));
    expect(await first).toMatchObject({ updateAvailable: true });
    h.fetcher.mockResolvedValueOnce(json([release('v2.2.0-rc.1')]));
    expect(await h.check(true)).toMatchObject({ updateAvailable: true, latestVersion: '2.2.0-rc.1' });
  });
});
