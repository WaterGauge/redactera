export const PDF_IMPORT_LIMITS = {
  fileBytes: 512 * 1024 * 1024,
  virtualBytes: 16 * 1024 * 1024,
  sessionBytes: 2 * 1024 * 1024 * 1024,
  concurrent: 2,
  retainedFiles: 128,
  nameLength: 1024,
  pathLength: 32768,
  deadlineMs: 30_000,
} as const;

export const PDF_IMPORT_ERRORS = {
  fileSize: 'PDF import exceeds file size limit',
  virtualSize: 'Virtual PDF import exceeds size limit',
  sessionSize: 'PDF import exceeds session storage limit',
  busy: 'PDF imports already in progress',
} as const;

export type DroppedPdf = { kind: 'path'; fileName: string; sourcePath: string; size: number } |
  { kind: 'bytes'; fileName: string; bytes: Uint8Array };
