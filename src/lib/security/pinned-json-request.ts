import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { ModelDiscoveryTarget } from "./model-discovery-policy";
import { UpstreamResponseError } from "./request-validation";

export interface PinnedJsonResponse {
  status: number;
  body: unknown;
}

interface RequestOptions {
  headers?: Record<string, string>;
  maxBytes?: number;
  timeoutMs?: number;
}

function requestOne(
  target: ModelDiscoveryTarget,
  address: ModelDiscoveryTarget["addresses"][number],
  options: RequestOptions,
): Promise<PinnedJsonResponse> {
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 15_000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const absoluteTimer = setTimeout(() => request?.destroy(new Error("Upstream request exceeded its total time limit")), timeoutMs);
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(absoluteTimer);
      reject(error);
    };
    const requestOptions: https.RequestOptions = {
      protocol: target.url.protocol,
      hostname: target.hostname,
      port: target.url.port || (target.url.protocol === "https:" ? 443 : 80),
      path: `${target.url.pathname}${target.url.search}`,
      method: "GET",
      headers: { Accept: "application/json", ...(options.headers ?? {}) },
      servername: target.url.protocol === "https:" && net.isIP(target.hostname) === 0 ? target.hostname : undefined,
      lookup: (_hostname, lookupOptions, callback) => {
        if (typeof lookupOptions === "object" && lookupOptions.all) {
          callback(null, [{ address: address.address, family: address.family }]);
        } else {
          callback(null, address.address, address.family);
        }
      },
    };
    const onResponse = (response: http.IncomingMessage) => {
      const status = response.statusCode ?? 502;
      const contentLength = response.headers["content-length"];
      if (contentLength) {
        const parsed = Number(Array.isArray(contentLength) ? contentLength[0] : contentLength);
        if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxBytes) {
          response.destroy();
          finishReject(new UpstreamResponseError("Upstream response is too large"));
          return;
        }
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer | Uint8Array | string) => {
        if (settled) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.byteLength;
        if (total > maxBytes) {
          response.destroy();
          finishReject(new UpstreamResponseError("Upstream response is too large"));
          return;
        }
        chunks.push(bytes);
      });
      response.once("error", (error) => finishReject(error instanceof Error ? error : new Error("Upstream response failed")));
      response.once("end", () => {
        if (settled) return;
        let body: unknown;
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
          body = JSON.parse(text) as unknown;
        } catch {
          finishReject(new UpstreamResponseError("Upstream response is not valid UTF-8 JSON"));
          return;
        }
        settled = true;
        clearTimeout(absoluteTimer);
        resolve({ status, body });
      });
    };
    const request = target.url.protocol === "https:"
      ? https.request(requestOptions, onResponse)
      : http.request(requestOptions, onResponse);
    request.setTimeout(timeoutMs, () => request.destroy(new Error("Upstream request timed out")));
    request.once("error", (error) => finishReject(error instanceof Error ? error : new Error("Upstream request failed")));
    request.end();
  });
}

/**
 * Fetch JSON while pinning the validated DNS answer for the actual socket.
 * This closes the DNS-rebinding gap between policy evaluation and connection.
 */
export async function requestPinnedJson(
  target: ModelDiscoveryTarget,
  options: RequestOptions = {},
): Promise<PinnedJsonResponse> {
  let lastError: Error | null = null;
  for (const address of target.addresses) {
    try {
      return await requestOne(target, address, options);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Upstream request failed");
    }
  }
  if (lastError instanceof UpstreamResponseError) throw lastError;
  throw new UpstreamResponseError("Model discovery upstream request failed");
}
