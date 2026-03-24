import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Get encryption key from env. Falls back to no-op if not configured.
 * In production, set TOKEN_ENCRYPTION_KEY to a 32-byte hex string (64 chars).
 */
function getEncryptionKey(): Buffer | null {
  const key = process.env.TOKEN_ENCRYPTION_KEY;
  if (!key) return null;
  return Buffer.from(key, "hex");
}

/**
 * Encrypt a string. Returns base64-encoded ciphertext (iv + tag + encrypted).
 * If TOKEN_ENCRYPTION_KEY is not set, returns the plaintext (backward-compatible).
 */
export function encryptToken(plaintext: string): string {
  const key = getEncryptionKey();
  if (!key) return plaintext;

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // iv (12) + tag (16) + ciphertext
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/**
 * Decrypt a string. If it doesn't look like an encrypted value, returns as-is
 * (backward-compatible with plaintext tokens).
 */
export function decryptToken(stored: string): string {
  const key = getEncryptionKey();
  if (!key) return stored;

  // If it doesn't look like base64-encoded encrypted data, treat as plaintext
  try {
    const buf = Buffer.from(stored, "base64");
    if (buf.length < IV_LENGTH + TAG_LENGTH + 1) return stored;

    const iv = buf.subarray(0, IV_LENGTH);
    const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = buf.subarray(IV_LENGTH + TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final("utf8");
  } catch {
    // If decryption fails, assume it's a plaintext token from before encryption was enabled
    return stored;
  }
}
