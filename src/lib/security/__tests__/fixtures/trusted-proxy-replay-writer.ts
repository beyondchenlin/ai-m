import { verifyTrustedProxyRequest } from "../../trusted-proxy-auth";
import { getSqlite } from "@/lib/db";

process.send?.({ ready: true });
process.once("message", async (message: unknown) => {
  try {
    const input = message as { url: string; method: string; body: string; headers: Record<string, string>; nowMs: number };
    const userId = await verifyTrustedProxyRequest(new Request(input.url, {
      method: input.method,
      body: input.body,
      headers: input.headers,
    }), { nowMs: input.nowMs });
    await new Promise<void>((resolve, reject) => {
      process.send?.({ status: "accepted", userId }, (error) => error ? reject(error) : resolve());
    });
  } catch (error) {
    await new Promise<void>((resolve, reject) => {
      process.send?.({
        status: "rejected",
        code: error instanceof Error ? error.message : String(error),
      }, (sendError) => sendError ? reject(sendError) : resolve());
    });
  } finally {
    getSqlite().close();
    process.disconnect?.();
  }
});
