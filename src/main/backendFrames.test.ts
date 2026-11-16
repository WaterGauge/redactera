import { describe, expect, it } from 'vitest';
import { BackendFrames, BACKEND_FRAME_BYTES, BACKEND_RESPONSE_BYTES, BACKEND_RESPONSE_LIMIT_ERROR, BACKEND_RESPONSE_ENCODING_ERROR } from './backendFrames';

const reader = () => new BackendFrames({ frameBytes: 16, responseBytes: 40 });
function collect(frames: BackendFrames, chunks: Buffer[]): string[] {
  const lines: string[] = [];
  for (const chunk of chunks) frames.feed(chunk, line => { lines.push(line); return true; });
  return lines;
}

describe('bounded backend wire framing', () => {
  it('reassembles every possible byte split in multibyte UTF-8 and CRLF', () => {
    const wire = Buffer.from('中😀文\r\nnext\n');
    for (let split = 0; split <= wire.length; split++) {
      expect(collect(reader(), [wire.subarray(0, split), wire.subarray(split)])).toEqual(['中😀文\r', 'next']);
    }
    expect(collect(reader(), Array.from(wire, byte => Buffer.from([byte])))).toEqual(['中😀文\r', 'next']);
  });
  it('accepts an exact-limit frame including a separately delivered LF', () => {
    expect(collect(reader(), [Buffer.alloc(16, 97), Buffer.from('\n')])).toEqual(['a'.repeat(16)]);
  });
  it.each([Buffer.alloc(17, 97), Buffer.from('a'.repeat(17) + '\nok\n')])('rejects oversized complete or unterminated frames before consumption', chunk => {
    const r = reader(), lines: string[] = [];
    expect(() => r.feed(chunk, line => { lines.push(line); return true; })).toThrow(BACKEND_RESPONSE_LIMIT_ERROR);
    expect(lines).toEqual([]);
  });
  it('rejects an oversized frame spanning chunks and releases old data', () => {
    const r = reader(); expect(collect(r, [Buffer.alloc(16, 97)])).toEqual([]);
    expect(() => collect(r, [Buffer.from('a\nok\n')])).toThrow(BACKEND_RESPONSE_LIMIT_ERROR);
    expect(collect(r, [Buffer.from('new\n')])).toEqual(['new']);
  });
  it('counts actual wire bytes including delimiters and rejected or empty messages', () => {
    const r = reader(); expect(collect(r, [Buffer.from('a\n'.repeat(20))])).toHaveLength(20);
    expect(() => collect(r, [Buffer.from('\n')])).toThrow(BACKEND_RESPONSE_LIMIT_ERROR);
  });
  it('restarts aggregate accounting without forgetting an incomplete frame', () => {
    const r = reader(); collect(r, [Buffer.from('a\n'.repeat(12) + 'b'.repeat(16))]);
    r.beginResponse(); expect(collect(r, [Buffer.from('\n' + 'a\n'.repeat(11))])).toHaveLength(12);
    expect(() => collect(r, [Buffer.from('x\n')])).toThrow(BACKEND_RESPONSE_LIMIT_ERROR);
  });
  it('does not silently replace malformed UTF-8', () => {
    const r = reader(); expect(collect(r, [Buffer.from([0xe4])])).toEqual([]);
    expect(() => collect(r, [Buffer.from([0x61, 0x0a])])).toThrow(BACKEND_RESPONSE_ENCODING_ERROR);
  });
  it('stops consuming immediately when the callback retires the generation', () => {
    const r = reader(), lines: string[] = [];
    r.feed(Buffer.from('first\n' + 'x'.repeat(30)), line => { lines.push(line); return false; });
    expect(lines).toEqual(['first']);
  });
  it('clears a partial frame on teardown', () => {
    const r = reader(); collect(r, [Buffer.from('old')]); r.clear();
    expect(collect(r, [Buffer.from('new\n')])).toEqual(['new']);
  });
  it('rejects invalid or widened injected limits', () => {
    for (const limits of [{ frameBytes: 0, responseBytes: 40 }, { frameBytes: 16, responseBytes: 16 }, { frameBytes: BACKEND_FRAME_BYTES + 1, responseBytes: BACKEND_RESPONSE_BYTES }, { frameBytes: 16, responseBytes: Infinity }]) {
      expect(() => new BackendFrames(limits)).toThrow('Invalid backend frame limits');
    }
  });
});
