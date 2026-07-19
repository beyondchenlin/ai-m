import { createHash } from "node:crypto";

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError("Canonical JSON strings cannot contain lone surrogates");
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError("Canonical JSON strings cannot contain lone surrogates");
    }
  }
}

export function canonicalize(value: unknown): string {
  let nodes = 0;
  const ancestors = new WeakSet<object>();
  const encode = (item: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > 10_000 || depth > 64) throw new TypeError("JSON value exceeds canonicalization limits");
    if (item === null || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "string") {
      assertUnicodeScalarString(item);
      return JSON.stringify(item);
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError("Canonical JSON numbers must be finite");
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      if (ancestors.has(item)) throw new TypeError("Canonical JSON values cannot contain cycles");
      ancestors.add(item);
      try {
        for (let index = 0; index < item.length; index += 1) {
          if (!(index in item)) throw new TypeError("Canonical JSON arrays cannot be sparse");
        }
        return `[${item.map((entry) => encode(entry, depth + 1)).join(",")}]`;
      } finally {
        ancestors.delete(item);
      }
    }
    const prototype = typeof item === "object" && item !== null ? Object.getPrototypeOf(item) : undefined;
    if (typeof item !== "object" || item === null || (prototype !== Object.prototype && prototype !== null)) {
      throw new TypeError("Canonicalization accepts plain JSON values only");
    }
    if (ancestors.has(item)) throw new TypeError("Canonical JSON values cannot contain cycles");
    ancestors.add(item);
    try {
      const entries = Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => {
          assertUnicodeScalarString(key);
          return `${JSON.stringify(key)}:${encode(entry, depth + 1)}`;
        });
      return `{${entries.join(",")}}`;
    } finally {
      ancestors.delete(item);
    }
  };
  return encode(value, 0);
}

export function sha256Bytes(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function sha256Canonical(value: unknown): string {
  return sha256Bytes(canonicalize(value));
}
