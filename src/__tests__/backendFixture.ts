import { EventEmitter } from 'events';
import { BACKEND_CONTRACT } from '../main/backendContract';

// Existing lifecycle tests use an already-ready OS worker. Startup failures
// and requests queued before readiness are exercised separately.
export function readyBackendOutput(): EventEmitter {
  const stream = new EventEmitter();
  const on = stream.on.bind(stream);
  stream.on = (event, listener) => {
    const result = on(event, listener);
    if (event === 'data') listener(Buffer.from(JSON.stringify({ type: 'ready', ...BACKEND_CONTRACT,
      sourceSha256: BACKEND_CONTRACT.sourceSha256 ?? 'a'.repeat(64) }) + '\n'));
    return result;
  };
  return stream;
}
