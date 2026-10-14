"use client";

/**
 * When a photo or video was taken, read from the file itself in the browser
 * (a few hundred KiB at most), so the Photos timeline sorts by the moment the
 * picture was taken rather than the moment it was uploaded.
 *
 *   JPEG, HEIC/HEIF, WebP, TIFF, most RAWs: EXIF DateTimeOriginal (with
 *   OffsetTimeOriginal when present), found by its "Exif\0\0" header.
 *   MP4, MOV, 3GP: the movie header's creation time (UTC, since 1904).
 *
 * Everything is bounds-checked; anything unreadable is simply "unknown".
 */

const HEAD = 1024 * 1024;
const TAIL = 1024 * 1024;
const MIN = Date.UTC(1990, 0, 1);

export async function readTakenAt(file: File): Promise<number | null> {
  try {
    const type = file.type || "";
    const name = file.name.toLowerCase();
    const isVideo = type.startsWith("video/") || /\.(mp4|m4v|mov|3gp|3g2)$/.test(name);
    const isImage = type.startsWith("image/") || /\.(jpe?g|heic|heif|webp|tiff?|dng|cr2|cr3|nef|arw|orf|rw2)$/.test(name);
    if (!isVideo && !isImage) return null;
    const head = new Uint8Array(await file.slice(0, HEAD).arrayBuffer());
    if (isImage) return sane(exifDate(head));
    const fromHead = mvhdDate(head);
    if (fromHead !== null || file.size <= HEAD) return sane(fromHead);
    // Many cameras write the movie header at the end of the file.
    const tail = new Uint8Array(await file.slice(Math.max(HEAD, file.size - TAIL)).arrayBuffer());
    return sane(mvhdDate(tail));
  } catch {
    return null;
  }
}

const sane = (t: number | null) => (t !== null && Number.isFinite(t) && t >= MIN && t <= Date.now() + 86_400_000 ? Math.round(t) : null);

function find(bytes: Uint8Array, pattern: number[], from = 0): number {
  outer: for (let i = from; i <= bytes.length - pattern.length; i++) {
    for (let k = 0; k < pattern.length; k++) if (bytes[i + k] !== pattern[k]) continue outer;
    return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// EXIF
// ---------------------------------------------------------------------------

const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

function exifDate(bytes: Uint8Array): number | null {
  const at = find(bytes, EXIF_HEADER);
  if (at < 0) return null;
  const tiff = at + EXIF_HEADER.length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (tiff + 8 > bytes.length) return null;
  const order = view.getUint16(tiff);
  if (order !== 0x4949 && order !== 0x4d4d) return null;
  const le = order === 0x4949;
  const u16 = (o: number) => view.getUint16(tiff + o, le);
  const u32 = (o: number) => view.getUint32(tiff + o, le);
  if (u16(2) !== 42) return null;

  /** Reads one IFD into tag → (type, count, value-or-offset position). */
  const ifd = (offset: number) => {
    const out = new Map<number, { type: number; count: number; at: number }>();
    if (tiff + offset + 2 > bytes.length) return out;
    const n = u16(offset);
    for (let i = 0; i < n && i < 512; i++) {
      const e = offset + 2 + i * 12;
      if (tiff + e + 12 > bytes.length) break;
      out.set(u16(e), { type: u16(e + 2), count: u32(e + 4), at: e + 8 });
    }
    return out;
  };
  const ascii = (entry: { type: number; count: number; at: number } | undefined): string | null => {
    if (!entry || entry.type !== 2 || entry.count < 2 || entry.count > 64) return null;
    const start = entry.count <= 4 ? entry.at : u32(entry.at);
    if (tiff + start + entry.count > bytes.length) return null;
    let s = "";
    for (let i = 0; i < entry.count - 1; i++) s += String.fromCharCode(bytes[tiff + start + i]);
    return s;
  };

  const ifd0 = ifd(u32(4));
  const exifPtr = ifd0.get(0x8769);
  const sub = exifPtr ? ifd(u32(exifPtr.at)) : new Map();
  const when = ascii(sub.get(0x9003)) ?? ascii(sub.get(0x9004)) ?? ascii(ifd0.get(0x0132));
  const offset = ascii(sub.get(0x9011)) ?? ascii(sub.get(0x9012));
  return parseExifTime(when, offset);
}

/** "2021:06:01 12:34:56" (+ optional "+06:00") → ms since epoch. Without an offset: local time. */
function parseExifTime(when: string | null, offset: string | null): number | null {
  const m = when && /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(when);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (!y || !mo || !d) return null;
  const o = offset && /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (o) return Date.UTC(y, mo - 1, d, h, mi, s) - (o[1] === "-" ? -1 : 1) * (Number(o[2]) * 60 + Number(o[3])) * 60_000;
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

// ---------------------------------------------------------------------------
// MP4 / QuickTime
// ---------------------------------------------------------------------------

const MVHD = [0x6d, 0x76, 0x68, 0x64]; // "mvhd"
const EPOCH_1904 = Date.UTC(1904, 0, 1);

function mvhdDate(bytes: Uint8Array): number | null {
  const at = find(bytes, MVHD);
  if (at < 0 || at + 16 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[at + 4];
  // version 0: 32-bit seconds since 1904; version 1: 64-bit.
  const secs = version === 1 ? Number(view.getBigUint64(at + 8)) : view.getUint32(at + 8);
  return secs > 0 ? EPOCH_1904 + secs * 1000 : null;
}
