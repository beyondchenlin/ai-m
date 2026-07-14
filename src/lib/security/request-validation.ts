export class RequestValidationError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 413 = 400) {
    super(message);
    this.name = "RequestValidationError";
  }
}

export function assertPlainObject(value: unknown, name = "request body"): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RequestValidationError(`${name} must be an object`);
  }
}

export function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new RequestValidationError(`Unknown field(s): ${unknown.join(", ")}`);
  }
}

export function readRequiredString(
  value: Record<string, unknown>,
  key: string,
  options: { maxLength?: number; pattern?: RegExp } = {},
): string {
  const raw = value[key];
  if (typeof raw !== "string" || !raw.trim()) {
    throw new RequestValidationError(`${key} is required`);
  }
  const result = raw.trim();
  if (options.maxLength && result.length > options.maxLength) {
    throw new RequestValidationError(`${key} exceeds ${options.maxLength} characters`);
  }
  if (options.pattern && !options.pattern.test(result)) {
    throw new RequestValidationError(`${key} has an invalid format`);
  }
  return result;
}

export function readOptionalString(
  value: Record<string, unknown>,
  key: string,
  options: { maxLength?: number } = {},
): string | undefined {
  const raw = value[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new RequestValidationError(`${key} must be a string`);
  const result = raw.trim();
  if (options.maxLength && result.length > options.maxLength) {
    throw new RequestValidationError(`${key} exceeds ${options.maxLength} characters`);
  }
  return result;
}

export function readBoolean(value: Record<string, unknown>, key: string): boolean | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "boolean") throw new RequestValidationError(`${key} must be a boolean`);
  return raw;
}

export function readEnum<T extends string>(
  value: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T {
  const raw = readRequiredString(value, key);
  if (!allowed.includes(raw as T)) {
    throw new RequestValidationError(`${key} must be one of: ${allowed.join(", ")}`);
  }
  return raw as T;
}

export function readRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const raw = value[key];
  if (raw === undefined || raw === null) return undefined;
  assertPlainObject(raw, key);
  return raw;
}


/** Parse a JSON request body without allowing an unbounded allocation. */
export async function readJsonBodyLimited(request: Request, maxBytes = 1024 * 1024): Promise<unknown> {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader) {
    const length = Number(lengthHeader);
    if (!Number.isSafeInteger(length) || length < 0) throw new RequestValidationError("Invalid Content-Length");
    if (length > maxBytes) throw new RequestValidationError("Request body is too large", 413);
  }
  if (!request.body) throw new RequestValidationError("Request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new RequestValidationError("Request body is too large", 413);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new RequestValidationError("Request body must be valid UTF-8 JSON");
  }
}

export class UpstreamResponseError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = "UpstreamResponseError";
  }
}

/** Parse a JSON response without allowing an upstream service to force an unbounded allocation. */
export async function readJsonResponseLimited(
  response: Response,
  maxBytes = 1024 * 1024,
): Promise<unknown> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader) {
    const length = Number(lengthHeader);
    if (!Number.isSafeInteger(length) || length < 0) throw new UpstreamResponseError("Upstream returned an invalid Content-Length");
    if (length > maxBytes) throw new UpstreamResponseError("Upstream response is too large");
  }
  if (!response.body) throw new UpstreamResponseError("Upstream response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new UpstreamResponseError("Upstream response is too large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new UpstreamResponseError("Upstream response is not valid UTF-8 JSON");
  }
}
