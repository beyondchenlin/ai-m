import { createHash } from "node:crypto";

export function canonicalize(value: unknown): string {
  let nodes = 0;
  const encode = (item: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > 10_000 || depth > 64) throw new TypeError("JSON value exceeds canonicalization limits");
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError("Canonical JSON numbers must be finite");
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index += 1) {
        if (!(index in item)) throw new TypeError("Canonical JSON arrays cannot be sparse");
      }
      return `[${item.map((entry) => encode(entry, depth + 1)).join(",")}]`;
    }
    const prototype = typeof item === "object" && item !== null ? Object.getPrototypeOf(item) : undefined;
    if (typeof item !== "object" || item === null || (prototype !== Object.prototype && prototype !== null)) {
      throw new TypeError("Canonicalization accepts plain JSON values only");
    }
    const entries = Object.entries(item as Record<string, unknown>)
      // Match JSON object semantics for optional internal fields. Arrays and
      // external request values still reject undefined above.
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${encode(entry, depth + 1)}`);
    return `{${entries.join(",")}}`;
  };
  return encode(value, 0);
}

export function sha256(value: unknown): string {
  const data = typeof value === "string" ? value : canonicalize(value);
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}
