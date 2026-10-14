import "server-only";
import type { Activity, ActivityKind } from "@/lib/types";
import { sql } from "./db";
import { events } from "./events";

/**
 * Activity feed: what happened, newest first. Bursts are coalesced into one
 * row ("Uploaded 240 files to Photos", "Link opened 12 times") so the feed
 * stays readable, and the table is bounded.
 */

const COALESCE_MS: Partial<Record<ActivityKind, number>> = {
  upload: 2 * 60_000,
  duplicate: 2 * 60_000,
  share_view: 30 * 60_000,
  share_download: 30 * 60_000,
  // Files arriving through a file request: one line per burst, per request.
  received: 30 * 60_000,
};
const KEEP = 1000;
let inserts = 0;

export interface ActivityInput {
  kind: ActivityKind;
  name?: string | null;
  nodeId?: string | null;
  parentId?: string | null;
  shareId?: string | null;
  count?: number;
  detail?: Record<string, unknown>;
}

export function logActivity(e: ActivityInput) {
  const now = Date.now();
  const count = Math.max(1, e.count ?? 1);
  const window = COALESCE_MS[e.kind];
  if (window) {
    const byShare = e.kind.startsWith("share_") || e.kind === "received";
    const key = byShare ? "share_id" : "parent_id";
    const value = byShare ? (e.shareId ?? null) : (e.parentId ?? null);
    const merged = sql(
      `UPDATE activity SET count = count + ?, at = ?, name = COALESCE(?, name), node_id = COALESCE(?, node_id)
       WHERE id = (SELECT id FROM activity WHERE kind = ? AND ${key} IS ? AND at > ? ORDER BY at DESC LIMIT 1)`,
    ).run(count, now, e.name ?? null, e.nodeId ?? null, e.kind, value, now - window).changes;
    if (merged) return announce();
  }
  sql("INSERT INTO activity (at, kind, count, name, node_id, parent_id, share_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    now,
    e.kind,
    count,
    e.name ?? null,
    e.nodeId ?? null,
    e.parentId ?? null,
    e.shareId ?? null,
    e.detail ? JSON.stringify(e.detail) : null,
  );
  if (++inserts % 100 === 0) {
    sql("DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY at DESC LIMIT ?)").run(KEEP);
  }
  announce();
}

// One live event per burst of synchronous logging (e.g. a batch delete).
let pending = false;
function announce() {
  if (pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    events.emit({ type: "activity" });
  });
}

export function listActivity(limit = 50): Activity[] {
  const rows = sql(
    `SELECT a.id, a.at, a.kind, a.count, a.name, a.node_id AS nodeId, a.parent_id AS parentId, a.share_id AS shareId, a.detail,
            p.name AS parentName, n.id IS NOT NULL AND n.in_trash = 0 AS nodeAlive
     FROM activity a
     LEFT JOIN nodes p ON p.id = a.parent_id
     LEFT JOIN nodes n ON n.id = a.node_id
     ORDER BY a.at DESC LIMIT ?`,
  ).all(Math.min(200, Math.max(1, limit))) as (Omit<Activity, "detail" | "nodeAlive"> & { detail: string | null; nodeAlive: number })[];
  return rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null, nodeAlive: r.nodeAlive === 1 }));
}
