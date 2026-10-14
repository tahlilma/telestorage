import { route } from "@/server/http";
import { metrics } from "@/server/metrics";
import { systemSnapshot } from "@/server/stats";
import { storage } from "@/server/storage";

/**
 * Server-Sent Events feed for the dashboard: an `init` frame with five minutes
 * of history, then a `tick` frame every second driven by the metrics clock.
 */
export const GET = route(async (req) => {
  const rt = await storage();
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const stop = () => {
        unsubscribe?.();
        unsubscribe = undefined;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      send("init", { snapshot: systemSnapshot(rt), series: metrics.seriesSnapshot() });
      unsubscribe = metrics.onTick(() => {
        try {
          send("tick", { snapshot: systemSnapshot(rt), sample: metrics.latestSample() });
        } catch {
          stop();
        }
      });
      req.signal.addEventListener("abort", stop);
    },
    cancel() {
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // no-transform stops the compression layer from buffering events.
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
});
