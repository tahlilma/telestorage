import { afterAll, beforeAll, describe, expect, it } from "vitest";

type Nodes = typeof import("@/server/nodes");
let nodes: Nodes;
let sql: typeof import("@/server/db").sql;
let tx: typeof import("@/server/db").tx;
let db: typeof import("@/server/db").db;
let runFsck: typeof import("@/server/fsck").runFsck;
let idempotent: typeof import("@/server/idempotency").idempotent;
let events: typeof import("@/server/events").events;

beforeAll(async () => {
  nodes = await import("@/server/nodes");
  ({ sql, db, tx } = await import("@/server/db"));
  ({ runFsck } = await import("@/server/fsck"));
  ({ idempotent } = await import("@/server/idempotency"));
  ({ events } = await import("@/server/events"));
});

afterAll(() => {
  db().close();
});

/** Deterministic PRNG so a failing fuzz run can be replayed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fakeBlob(id: string) {
  sql("INSERT INTO blobs (id, size, part_size, part_count, driver, created_at) VALUES (?, 10, 524288, 0, 'local', ?)").run(id, Date.now());
}

describe("tree invariants under random operations", () => {
  it("never needs repair after thousands of random create/move/copy/trash/restore/delete operations", () => {
    for (const seed of [1, 2, 3]) {
      const r = rng(seed);
      const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
      const live = () => sql("SELECT id FROM nodes WHERE in_trash = 0 AND kind = 'folder'").pluck().all() as string[];
      const anyLive = () => sql("SELECT id FROM nodes WHERE in_trash = 0 AND id <> 'root'").pluck().all() as string[];
      // Copies are limited to files and leaf folders so the tree can't grow exponentially.
      const copyable = () =>
        sql("SELECT id FROM nodes n WHERE in_trash = 0 AND id <> 'root' AND (kind = 'file' OR NOT EXISTS (SELECT 1 FROM nodes c WHERE c.parent_id = n.id))")
          .pluck()
          .all() as string[];
      const trashed = () => sql("SELECT id FROM nodes WHERE trashed_at IS NOT NULL").pluck().all() as string[];
      for (let step = 0; step < 700; step++) {
        const op = r();
        try {
          if (op < 0.3) nodes.createFolder(pick(live()), `f${step % 5}`);
          else if (op < 0.4) {
            const blob = `b${seed}x${step}`;
            fakeBlob(blob);
            const parentId = pick(live());
            // Names repeat on purpose (step % 7): uploads into a folder that has the name must stay unique.
            tx(() => nodes.placeUpload({ parentId, name: `file${step % 7}.txt`, size: 10, mime: "text/plain", blobId: blob, sha256: null, policy: "keep" }));
          } else if (op < 0.55 && anyLive().length) nodes.move([pick(anyLive())], pick(live()));
          else if (op < 0.62 && copyable().length) nodes.copy([pick(copyable())], pick(live()));
          else if (op < 0.75 && anyLive().length) nodes.trash([pick(anyLive())]);
          else if (op < 0.85 && trashed().length) nodes.restore([pick(trashed())]);
          else if (op < 0.93 && trashed().length) nodes.deleteForever([pick(trashed())]);
          else if (anyLive().length) nodes.rename(pick(anyLive()), `renamed ${step % 3}`);
        } catch (e) {
          // Refused operations (cycles, trashed targets) are fine — they must just never corrupt state.
          expect((e as { status?: number }).status).toBeGreaterThanOrEqual(400);
        }
      }
      const report = runFsck({ repair: false });
      const bad = report.checks.filter((c) => c.status !== "ok" && c.name !== "Unreferenced content");
      expect(bad, JSON.stringify(bad)).toEqual([]);
      // Whatever happened, no folder ends up with two live items of one kind under one name.
      const dupes = sql(
        "SELECT parent_id, kind, lower(name) AS n, COUNT(*) AS c FROM nodes WHERE in_trash = 0 GROUP BY parent_id, kind, lower(name) HAVING c > 1",
      ).all();
      expect(dupes).toEqual([]);
    }
  });

  it("refuses to create cycles even when moves are interleaved", () => {
    const a = nodes.createFolder("root", "A");
    const b = nodes.createFolder(a.id, "B");
    const c = nodes.createFolder(b.id, "C");
    expect(() => nodes.move([a.id], c.id)).toThrow(/into itself/);
    expect(() => nodes.move([a.id], a.id)).toThrow(/into itself/);
    nodes.move([c.id], "root");
    nodes.move([a.id], c.id); // legal now
    expect(nodes.breadcrumbs(b.id).map((x) => x.name)).toEqual(["My files", "C", "A", "B"]);
  });
});

describe("fsck repairs", () => {
  it("re-attaches orphans, fixes trash flags, scraps unreferenced blobs and rebuilds the search index", () => {
    const parent = nodes.createFolder("root", "doomed");
    const child = nodes.createFolder(parent.id, "orphan-to-be");
    fakeBlob("lonely");
    db().pragma("foreign_keys = OFF");
    sql("DELETE FROM nodes WHERE id = ?").run(parent.id); // orphan the child
    db().pragma("foreign_keys = ON");
    const flagged = nodes.createFolder("root", "wrong flag");
    sql("UPDATE nodes SET in_trash = 1 WHERE id = ?").run(flagged.id); // visible item marked trashed
    sql("INSERT INTO nodes_fts(nodes_fts, rowid, name) VALUES ('delete', (SELECT rid FROM nodes WHERE id = ?), 'wrong flag')").run(flagged.id);

    const first = runFsck({ repair: true });
    const byName = Object.fromEntries(first.checks.map((c) => [c.name, c]));
    expect(byName["Tree structure"].status).toBe("repaired");
    expect(byName["Trash flags"].status).toBe("repaired");
    expect(byName["Unreferenced content"].status).toBe("repaired");
    expect(byName["Search index"].status).toBe("repaired");
    expect(nodes.getNode(child.id)?.parentId).toBe("root");
    expect(sql("SELECT in_trash FROM nodes WHERE id = ?").pluck().get(flagged.id)).toBe(0);
    expect(nodes.search("wrong flag").some((n) => n.id === flagged.id)).toBe(true);

    const second = runFsck({ repair: true });
    expect(second.checks.filter((c) => c.status !== "ok")).toEqual([]);
    expect(second.ok).toBe(true);
  });
});

describe("idempotency", () => {
  it("executes once per key and replays the stored response", async () => {
    let runs = 0;
    const handler = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 20));
      return Response.json({ n: runs }, { status: 201 });
    };
    const req = () => new Request("http://x/", { method: "POST", headers: { "idempotency-key": "key-0123456789" } });
    const [a, b] = await Promise.all([idempotent(req(), "t", handler), idempotent(req(), "t", handler)]);
    const c = await idempotent(req(), "t", handler);
    expect(runs).toBe(1);
    expect(await a.json()).toEqual({ n: 1 });
    expect(await b.json()).toEqual({ n: 1 });
    expect(await c.json()).toEqual({ n: 1 });
    expect(c.status).toBe(201);
    expect(c.headers.get("idempotent-replayed")).toBe("true");
    const other = await idempotent(new Request("http://x/", { method: "POST", headers: { "idempotency-key": "another-key-123" } }), "t", handler);
    expect(await other.json()).toEqual({ n: 2 });
  });
});

describe("change feed", () => {
  it("emits precise events for mutations", () => {
    const seen: import("@/lib/types").ChangeEvent[] = [];
    const off = events.subscribe((e) => seen.push(e));
    const f = nodes.createFolder("root", "evented");
    nodes.trash([f.id]);
    off();
    expect(seen.map((e) => e.reason)).toEqual(["create", "trash"]);
    expect(seen[0].parents).toEqual(["root"]);
    expect(seen[1].removed).toEqual([f.id]);
    expect(seen[1].rev).toBe(seen[0].rev + 1);
  });
});
