import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { decodeGenmediaApiKey } from "./genmedia-key.ts";

/** Mirrors genmedia's on-disk encryption so we can produce real envelopes. */
function encryptLikeGenmedia(plaintext: string): string {
  const key = createHash("sha256").update(`${hostname()}:${userInfo().username}:genmedia`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((b) => b.toString("base64")).join(":");
}

test("a plaintext fal key (id:secret) passes through unchanged", () => {
  assert.equal(decodeGenmediaApiKey("abc123-uuid:deadbeefsecret"), "abc123-uuid:deadbeefsecret");
});

test("a value with no colons passes through unchanged", () => {
  assert.equal(decodeGenmediaApiKey("from-genmedia"), "from-genmedia");
});

test("a genmedia-encrypted envelope round-trips to plaintext", () => {
  const envelope = encryptLikeGenmedia("real-id:real-secret");
  assert.equal(decodeGenmediaApiKey(envelope), "real-id:real-secret");
});

test("an undecryptable three-part envelope returns null", () => {
  // Three base64 parts (looks encrypted) but not a valid GCM envelope.
  const garbage = [randomBytes(12), randomBytes(16), randomBytes(20)]
    .map((b) => b.toString("base64"))
    .join(":");
  assert.equal(decodeGenmediaApiKey(garbage), null);
});
