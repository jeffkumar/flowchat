import crypto from "node:crypto";

type EncryptedPayloadV1 = {
  v: 1;
  iv: string;
  tag: string;
  data: string;
};

function base64UrlEncode(buffer: Buffer) {
  return buffer
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlDecode(input: string) {
  const padded =
    input.length % 4 === 0 ? input : input.padEnd(input.length + (4 - (input.length % 4)), "=");
  const base64 = padded.replaceAll("-", "+").replaceAll("_", "/");
  return Buffer.from(base64, "base64");
}

function getEncryptionKey() {
  const raw = process.env.INTEGRATIONS_TOKEN_ENCRYPTION_KEY;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("INTEGRATIONS_TOKEN_ENCRYPTION_KEY is not set");
  }

  const key = base64UrlDecode(raw);
  if (key.length !== 32) {
    throw new Error("INTEGRATIONS_TOKEN_ENCRYPTION_KEY must be a 32-byte base64url string");
  }

  return key;
}

export function encryptSecret(plaintext: string) {
  const iv = crypto.randomBytes(12);
  const key = getEncryptionKey();

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload: EncryptedPayloadV1 = {
    v: 1,
    iv: base64UrlEncode(iv),
    tag: base64UrlEncode(tag),
    data: base64UrlEncode(encrypted),
  };

  return JSON.stringify(payload);
}

export function decryptSecret(ciphertext: string) {
  const parsed = JSON.parse(ciphertext) as Partial<EncryptedPayloadV1> | null;
  if (
    !parsed ||
    parsed.v !== 1 ||
    typeof parsed.iv !== "string" ||
    typeof parsed.tag !== "string" ||
    typeof parsed.data !== "string"
  ) {
    throw new Error("Invalid encrypted payload");
  }

  const key = getEncryptionKey();
  const iv = base64UrlDecode(parsed.iv);
  const tag = base64UrlDecode(parsed.tag);
  const data = base64UrlDecode(parsed.data);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}


