import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";

// Envelope encryption, native Node crypto only (no new dependency, mirrors the WebCrypto
// approach already designed for the PDF archive): a fresh random Data Encryption Key (DEK) per
// backup, itself wrapped by a long-lived Key-Encrypting Key (KEK). The KEK never touches the
// backup artifact -- only the wrapped DEK does.

const ALG = "aes-256-gcm";

export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function aesGcmEncrypt(keyBytes, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, keyBytes, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, ciphertext, tag };
}

function aesGcmDecrypt(keyBytes, { iv, ciphertext, tag }) {
  const decipher = createDecipheriv(ALG, keyBytes, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Encrypts `plaintext` with a fresh random DEK, wraps the DEK with `kekBytes` (32 bytes).
 * Returns everything needed to decrypt later, EXCEPT the KEK itself.
 */
export function envelopeEncrypt(kekBytes, plaintext) {
  if (kekBytes.length !== 32) throw new Error("KEK must be 32 bytes (AES-256)");
  const dek = randomBytes(32);
  const dataEnc = aesGcmEncrypt(dek, plaintext);
  const dekEnc = aesGcmEncrypt(kekBytes, dek);
  return {
    ciphertext: dataEnc.ciphertext,
    dataIv: dataEnc.iv.toString("base64"),
    dataTag: dataEnc.tag.toString("base64"),
    wrappedDek: dekEnc.ciphertext.toString("base64"),
    dekIv: dekEnc.iv.toString("base64"),
    dekTag: dekEnc.tag.toString("base64"),
    plaintextSha256: sha256Hex(plaintext),
  };
}

export function envelopeDecrypt(kekBytes, envelope) {
  if (kekBytes.length !== 32) throw new Error("KEK must be 32 bytes (AES-256)");
  const dek = aesGcmDecrypt(kekBytes, {
    iv: Buffer.from(envelope.dekIv, "base64"),
    ciphertext: Buffer.from(envelope.wrappedDek, "base64"),
    tag: Buffer.from(envelope.dekTag, "base64"),
  });
  const plaintext = aesGcmDecrypt(dek, {
    iv: Buffer.from(envelope.dataIv, "base64"),
    ciphertext: envelope.ciphertext,
    tag: Buffer.from(envelope.dataTag, "base64"),
  });
  const actualHash = sha256Hex(plaintext);
  if (envelope.plaintextSha256 && actualHash !== envelope.plaintextSha256) {
    throw new Error(
      `Decrypted content hash mismatch: expected ${envelope.plaintextSha256}, got ${actualHash}`
    );
  }
  return plaintext;
}
