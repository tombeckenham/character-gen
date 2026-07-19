import { createDecipheriv, createHash } from "node:crypto";
import { hostname, userInfo } from "node:os";

// genmedia stores its fal key encrypted at rest as `iv:tag:ciphertext` (three
// base64 parts), decryptable only with a machine-derived key. Reading that
// value raw yields ciphertext that fal rejects with 401, so we mirror
// genmedia's scheme here to recover the plaintext. A real fal key is
// `<id>:<secret>` — two parts — and passes through untouched.
//
// This intentionally couples to genmedia's on-disk format (already coupled via
// the config path + `apiKey` field). If genmedia ever changes the scheme,
// decryption fails and `decodeGenmediaApiKey` returns null so the caller falls
// through to the next key source instead of surfacing a broken key.

/** Mirrors genmedia's `deriveMachineKey`: sha256 of host:user:genmedia. */
function deriveMachineKey(): Buffer {
  const identity = `${hostname()}:${userInfo().username}:genmedia`;
  return createHash("sha256").update(identity).digest();
}

/** True when `value` has genmedia's three-part encrypted envelope shape. */
function looksEncrypted(value: string): boolean {
  return value.split(":").length === 3;
}

/**
 * Decodes a value read from genmedia's `config.json` `apiKey` field into a
 * usable plaintext fal key:
 *   - a plaintext key (not the encrypted envelope) is returned as-is
 *   - an encrypted envelope is decrypted with the machine-derived key
 *   - anything that fails to decrypt returns null (caller skips this source)
 */
export function decodeGenmediaApiKey(value: string): string | null {
  if (!looksEncrypted(value)) return value;
  try {
    const [iv, tag, encrypted] = value.split(":").map((p) => Buffer.from(p, "base64"));
    if (!iv || !tag || !encrypted) return null;
    const decipher = createDecipheriv("aes-256-gcm", deriveMachineKey(), iv);
    decipher.setAuthTag(tag);
    const plaintext = decipher.update(encrypted).toString("utf8") + decipher.final("utf8");
    return plaintext.length > 0 ? plaintext : null;
  } catch {
    return null;
  }
}
