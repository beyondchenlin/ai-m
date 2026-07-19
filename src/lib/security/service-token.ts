import { timingSafeEqual } from "node:crypto";

/** Decode one service credential without accepting ambiguous text encodings. */
export function decodeStrongServiceToken(value: string | undefined): Buffer | null {
  const token = value?.trim() ?? "";
  if (/^(?:[0-9a-f]{2}){32,}$/i.test(token)) return Buffer.from(token, "hex");
  if (!/^[A-Za-z0-9_-]{43,}$/.test(token)) return null;
  try {
    const decoded = Buffer.from(token, "base64url");
    if (decoded.length < 32 || decoded.toString("base64url") !== token) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function strongServiceTokenEqual(
  presented: string | undefined,
  configured: string | undefined,
): boolean {
  const actual = decodeStrongServiceToken(presented);
  const expected = decodeStrongServiceToken(configured);
  return Boolean(
    actual
    && expected
    && actual.length === expected.length
    && timingSafeEqual(actual, expected),
  );
}
