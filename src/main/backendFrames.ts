import { TextDecoder } from 'node:util';

// Wire bytes, not UTF-16 code units. A CR in CRLF counts toward the frame.
export const BACKEND_FRAME_BYTES = 128 * 1024 * 1024;
export const BACKEND_RESPONSE_BYTES = 256 * 1024 * 1024;
export const BACKEND_RESPONSE_LIMIT_ERROR = 'Backend response exceeds IPC byte limit';
export const BACKEND_RESPONSE_ENCODING_ERROR = 'Backend response has invalid UTF-8';

export interface BackendFrameLimits {
  frameBytes: number;
  responseBytes: number;
}

/** A bounded, incremental LF-delimited UTF-8 reader for one worker generation. */
export class BackendFrames {
  private buffer: Buffer | undefined;
  private used = 0;
  private received = 0;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly frameBytes: number;
  private readonly responseBytes: number;

  constructor(limits: BackendFrameLimits = { frameBytes: BACKEND_FRAME_BYTES, responseBytes: BACKEND_RESPONSE_BYTES }) {
    if (!Number.isSafeInteger(limits.frameBytes) || limits.frameBytes <= 0 || limits.frameBytes > BACKEND_FRAME_BYTES ||
        !Number.isSafeInteger(limits.responseBytes) || limits.responseBytes <= limits.frameBytes || limits.responseBytes > BACKEND_RESPONSE_BYTES) {
      throw new Error('Invalid backend frame limits');
    }
    this.frameBytes = limits.frameBytes;
    this.responseBytes = limits.responseBytes;
  }

  /** Begin a new request without forgetting bytes of an incomplete frame. */
  beginResponse(): void { this.received = this.used; }

  clear(): void { this.buffer = undefined; this.used = 0; this.received = 0; }

  /** False from the consumer stops processing the remainder of this chunk. */
  feed(chunk: Buffer, consume: (line: string) => boolean): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const length = end - offset;
      const wireLength = length + (newline === -1 ? 0 : 1);
      if (length > this.frameBytes - this.used || wireLength > this.responseBytes - this.received) {
        this.clear();
        throw new Error(BACKEND_RESPONSE_LIMIT_ERROR);
      }
      this.received += wireLength;
      if (newline !== -1 && this.used === 0) {
        // Complete frames need no intermediate buffer.
        if (!consume(this.decode(chunk.subarray(offset, end)))) return;
      } else {
        if (length) {
          const required = this.used + length;
          if (!this.buffer || this.buffer.length < required) {
            const next = Buffer.allocUnsafe(Math.min(this.frameBytes, Math.max(required, 4096, (this.buffer?.length ?? 0) * 2)));
            this.buffer?.copy(next, 0, 0, this.used);
            this.buffer = next;
          }
          chunk.copy(this.buffer, this.used, offset, end);
          this.used = required;
        }
        if (newline !== -1) {
          const frame = this.buffer?.subarray(0, this.used) ?? Buffer.alloc(0);
          this.buffer = undefined;
          this.used = 0;
          if (!consume(this.decode(frame))) return;
        }
      }
      offset = end + 1;
    }
  }

  private decode(frame: Buffer): string {
    try { return this.decoder.decode(frame); }
    catch { this.clear(); throw new Error(BACKEND_RESPONSE_ENCODING_ERROR); }
  }
}
