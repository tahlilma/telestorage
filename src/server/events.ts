import "server-only";
import crypto from "node:crypto";
import type { ChangeEvent } from "@/lib/types";
import { sql } from "./db";
import { metrics } from "./metrics";

/**
 * In-process change feed. Every mutation emits an event; /api/events streams
 * them to connected browsers (one elected tab per browser relays to the rest)
 * so every open window and device stays in sync without polling.
 */
class EventBus {
  /** Identifies this server process (and index): a different boot id means events were missed. */
  boot = crypto.randomBytes(6).toString("hex");
  rev = 0;
  private listeners = new Set<(e: ChangeEvent) => void>();
  private streams = new Set<() => void>();

  /** Registers an open live stream so it can be closed when clients must resync. */
  trackStream(close: () => void) {
    this.streams.add(close);
    return () => this.streams.delete(close);
  }

  /**
   * The index was swapped for a newer one: everything a client knows may be
   * stale. Closing the streams makes every tab reconnect, see a new boot id
   * and refetch from scratch.
   */
  resetClients() {
    this.boot = crypto.randomBytes(6).toString("hex");
    for (const close of [...this.streams]) close();
  }

  emit(e: Omit<ChangeEvent, "rev" | "at" | "boot">) {
    const event: ChangeEvent = { ...e, rev: ++this.rev, at: Date.now(), boot: this.boot };
    metrics.inc("events.emitted");
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        /* a broken subscriber must never break a mutation */
      }
    }
  }

  subscribe(fn: (e: ChangeEvent) => void) {
    this.listeners.add(fn);
    metrics.gauges.liveClients = this.listeners.size;
    return () => {
      this.listeners.delete(fn);
      metrics.gauges.liveClients = this.listeners.size;
    };
  }
}

const g = globalThis as unknown as { __tsEvents?: EventBus };
export const events: EventBus = (g.__tsEvents ??= new EventBus());

/** Parent folders of the given nodes (as they are right now). */
export function parentsOf(ids: readonly string[]): string[] {
  if (!ids.length) return [];
  return (
    sql("SELECT DISTINCT parent_id FROM nodes WHERE id IN (SELECT value FROM json_each(?)) AND parent_id IS NOT NULL")
      .pluck()
      .all(JSON.stringify(ids)) as string[]
  ).filter(Boolean);
}

export function emitNodes(reason: ChangeEvent["reason"], opts: { parents?: Iterable<string | null>; ids?: Iterable<string>; removed?: Iterable<string> }) {
  const uniq = (it?: Iterable<string | null>) => [...new Set([...(it ?? [])].filter((x): x is string => Boolean(x)))];
  events.emit({ type: "nodes", reason, parents: uniq(opts.parents), ids: uniq(opts.ids), removed: uniq(opts.removed) });
}
