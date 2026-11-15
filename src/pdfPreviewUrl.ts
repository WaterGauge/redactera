export function createPdfPreviewUrl(filePath: string, page?: number): string {
  const base = `pdf-safe://${encodeURIComponent(filePath)}`;
  return Number.isSafeInteger(page) && (page ?? 0) > 0 ? `${base}#page=${page}` : base;
}
