import type { ChangeEvent } from "@/lib/types";
import { events } from "@/server/events";
import { route } from "@/server/http";

/**
 * Live change feed (Server-Sent Events). One elected tab per browser holds
 * this stream and relays to the others over BroadcastChannel. A heartbeat
 * every 15 s keeps proxies/tunnels (Cloudflare drops idle streams at 100 s)
 * from closing it; `hello` carries the server's boot id so clients can tell
 * when they must resynchronise from scratch, and the build id so tabs still
 * running an older client after an update know to reload.
 */
export const GET = route(async (req) => {
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      const send = (event: string, data: unknown, id?: string) => write(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      write("retry: 2000\n\n");
      send("hello", { boot: events.boot, rev: events.rev, build: process.env.NEXT_PUBLIC_BUILD_ID ?? null });
      const unsubscribe = events.subscribe((e: ChangeEvent) => send("change", e, `${e.boot}:${e.rev}`));
      const heartbeat = setInterval(() => write(`: ${Date.now()}\n\n`), 15_000);
      heartbeat.unref?.();

      let untrack = () => {};
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        untrack();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      untrack = events.trackStream(() => cleanup());
      req.signal.addEventListener("abort", () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
});
