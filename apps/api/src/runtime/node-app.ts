import { isIP } from "node:net";
import { createApp } from "../app";
import type { Bindings } from "../types/bindings";

export function requestClientIp(request: Request, remoteAddress: string, trustedProxyHops: number): string {
  const forwarded = (request.headers.get("x-forwarded-for") || "").split(",").map(ip => ip.trim()).filter(Boolean);
  const candidate = trustedProxyHops > 0 && forwarded.length >= trustedProxyHops
    ? forwarded[forwarded.length - trustedProxyHops] : remoteAddress;
  return isIP(candidate) ? candidate : "unknown";
}

/** Both normal and chat requests run the complete, unchanged HTTP pipeline. */
export function createNodeApp(env: Bindings, trustedProxyHops = 0) {
  const app = createApp();
  const pending = new Set<Promise<unknown>>();
  const context = {
    waitUntil(promise: Promise<unknown>) {
      const task = promise.catch(() => {
        console.error(JSON.stringify({ event: "background_task_failed" }));
      }).finally(() => pending.delete(task));
      pending.add(task);
    },
    passThroughOnException() { throw new Error("passThroughOnException is unavailable on Node"); },
    props: {},
  };
  return {
    fetch(request: Request, remoteAddress = "unknown") {
      const headers = new Headers(request.headers);
      headers.set("x-videoq-client-ip", requestClientIp(request, remoteAddress, trustedProxyHops));
      return app.fetch(new Request(request, { headers }), env, context);
    },
    async drain() { while (pending.size) await Promise.allSettled([...pending]); },
  };
}
