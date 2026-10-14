import "server-only";
import crypto from "node:crypto";

/**
 * AES-256-CTR keyed per deployment with a random 128-bit IV per blob.
 * CTR is a stream cipher whose keystream at byte N depends only on N, so any
 * 16-byte-aligned range can be decrypted independently — required for HTTP
 * range requests and parallel block fetches. Encryption runs on AES-NI at
 * multiple GB/s, far above Telegram throughput.
 */
export function newIv(): Buffer {
  return crypto.randomBytes(16);
}

/**
 * IV advanced by `byteOffset / 16` blocks. Full 128-bit big-endian addition,
 * matching how OpenSSL increments the CTR counter block.
 */
function ivAt(base: Buffer, byteOffset: number): Buffer {
  if (byteOffset % 16 !== 0) throw new Error("CTR offset must be 16-byte aligned");
  const iv = Buffer.from(base);
  let add = BigInt(byteOffset / 16);
  let carry = 0n;
  for (let i = 15; i >= 0; i--) {
    const sum = BigInt(iv[i]) + (add & 0xffn) + carry;
    iv[i] = Number(sum & 0xffn);
    carry = sum >> 8n;
    add >>= 8n;
  }
  return iv;
}

/** Encrypts or decrypts (CTR is symmetric) `data` located at `byteOffset` within the blob. */
export function ctrTransform(key: Buffer, baseIv: Buffer, byteOffset: number, data: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-256-ctr", key, ivAt(baseIv, byteOffset));
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

/** Whole-buffer authenticated encryption, used for database backups. */
export function sealGcm(key: Buffer, plain: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from("TSB1"), iv, cipher.getAuthTag(), body]);
}

export const isSealed = (data: Buffer) => data.length >= 32 && data.subarray(0, 4).toString("latin1") === "TSB1";

/** Opens what sealGcm produced; throws if the key is wrong or the bytes were altered. */
export function openGcm(key: Buffer, sealed: Buffer): Buffer {
  if (!isSealed(sealed)) throw new Error("Not a sealed Telestorage buffer");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, sealed.subarray(4, 16));
  decipher.setAuthTag(sealed.subarray(16, 32));
  return Buffer.concat([decipher.update(sealed.subarray(32)), decipher.final()]);
}

/** A 256-bit key for one purpose, derived from a secret (HKDF-SHA256). */
export function deriveKey(secret: string | Buffer, purpose: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", secret, Buffer.alloc(0), `telestorage/${purpose}`, 32));
}
