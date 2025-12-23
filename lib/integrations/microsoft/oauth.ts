import crypto from "node:crypto";

function base64UrlEncode(buffer: Buffer) {
  return buffer
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function sha256Base64Url(input: string) {
  const hash = crypto.createHash("sha256").update(input).digest();
  return base64UrlEncode(hash);
}

export function createPkcePair() {
  const verifier = base64UrlEncode(crypto.randomBytes(32));
  const challenge = sha256Base64Url(verifier);
  return { verifier, challenge };
}

export function createState() {
  return base64UrlEncode(crypto.randomBytes(16));
}

export function decodeJwtPayload<T>(jwt: string): T | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  const payload = parts[1];
  if (typeof payload !== "string" || payload.length === 0) return null;

  const padded =
    payload.length % 4 === 0 ? payload : payload.padEnd(payload.length + (4 - (payload.length % 4)), "=");
  const base64 = padded.replaceAll("-", "+").replaceAll("_", "/");

  try {
    const json = Buffer.from(base64, "base64").toString("utf8");
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}


