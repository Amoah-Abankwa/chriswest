/** Detects the real type from the first bytes. The filename and browser-supplied type are not trusted. */
export type DetectedType = { mime: string; ext: string };

const startsWith = (buf: Buffer, bytes: number[], offset = 0) => bytes.every((b, i) => buf[offset + i] === b);

export function detectFileType(buf: Buffer): DetectedType | null {
  if (buf.length < 12) return null;
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { mime: 'application/pdf', ext: 'pdf' }; // %PDF-
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', ext: 'png' };
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', ext: 'jpg' };
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

/** ASCII fallback plus RFC 5987 encoding for Content-Disposition. */
export function contentDisposition(originalName: string) {
  const ascii = originalName.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100) || 'document';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(originalName.slice(0, 200))}`;
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
