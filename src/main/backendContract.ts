import pkg from '../../package.json';

declare const __BACKEND_SOURCE_SHA256__: string;
export interface BackendContract { protocol: number; appVersion: string; sourceSha256?: string }
export const BACKEND_CONTRACT: BackendContract = {
  protocol: 1,
  appVersion: pkg.version,
  sourceSha256: typeof __BACKEND_SOURCE_SHA256__ === 'undefined' ? undefined : __BACKEND_SOURCE_SHA256__,
};
