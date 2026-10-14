"use client";
import { formatBytes } from "@/lib/format";
import type { Capacity } from "@/lib/types";

/**
 * Storage limits as they really are. Telegram has no storage quota; what
 * bounds this drive is the channel's post numbers (32-bit, never reused) times
 * the size of one post, how fast bots may post, and for one file, JavaScript's
 * exact-integer range. In local-disk mode it's simply the disk.
 */

const big = (n: number) => n.toLocaleString();

/** Compact block for the sidebar's storage card. */
export function RoomLeft({ cap }: { cap: Capacity }) {
  if (cap.kind === "disk") {
    const total = cap.totalBytes ?? 0;
    const free = cap.freeBytes ?? 0;
    const used = total ? Math.min(1, (total - free) / total) : 0;
    return (
      <div className="mt-3" data-testid="room-left">
        <div className="h-2 bg-surface-3" aria-hidden>
          <div className="h-full bg-accent" style={{ width: `${Math.max(1, used * 100)}%` }} />
        </div>
        <div className="mt-1.5 flex justify-between gap-2 text-[12px] text-ink-3 tabular">
          <span>This disk</span>
          <span>
            {formatBytes(free)} free of {formatBytes(total)}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="mt-3 border-t border-line pt-3" data-testid="room-left">
      <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
        <span className="text-ink-3">Room left</span>
        <span className="font-semibold text-ink tabular">≈ {formatBytes(cap.freeBytes ?? 0)}</span>
      </div>
      <div className="mt-1 text-[11.5px] leading-snug text-ink-3 tabular">
        {big(cap.postsUsed ?? 0)} of {big(cap.postLimit ?? 0)} posts used · {formatBytes(cap.partSize)} per post
      </div>
    </div>
  );
}

/** One line for headlines: "≈ 1.0 EB left" / "79 GB free". */
export function roomLeftText(cap: Capacity): string {
  return cap.kind === "disk" ? `${formatBytes(cap.freeBytes ?? 0)} free on disk` : `≈ ${formatBytes(cap.freeBytes ?? 0)} room left`;
}

/** The full picture, for System status. */
export function LimitsTable({ cap, bots, simulated = false }: { cap: Capacity; bots: number; simulated?: boolean }) {
  const rows: [string, string, string][] =
    cap.kind === "telegram"
      ? [
          ["Telegram quota", "None published", "Telegram publishes no storage cap for a channel or an account."],
          [
            "Posts in this channel",
            `${big(cap.postsUsed ?? 0)} of ${big(cap.postLimit ?? 0)}`,
            "Post numbers are 32-bit and never reused, so a channel can never get past post 2,147,483,647 (counting everything ever posted there, deleted or not).",
          ],
          ["Size of one post", formatBytes(cap.partSize), `TG_PART_SIZE_MB. Telegram lets a bot post up to ${formatBytes(cap.maxPartSize)}; bigger files are split into several posts.`],
          ["Room left", `≈ ${formatBytes(cap.freeBytes ?? 0)}`, "Posts left × size of one post. Small files use a whole post each, so many small files fill it sooner."],
          [
            "Most files per minute",
            big(cap.postsPerMinute ?? 0),
            `${bots} bot${bots === 1 ? "" : "s"} × TG_COMMITS_PER_MINUTE. Telegram throttles bots that post more than about 20 messages a minute to one chat. Matters for thousands of small files, not for big ones.`,
          ],
          ["Largest single file", formatBytes(cap.maxFileSize), "2^53 − 1 bytes: the largest exact byte offset in JavaScript. In practice: your upload speed and patience."],
        ]
      : [
          simulated
            ? ["Storage", "Simulated bots", "Test mode: the simulator keeps its posts in DATA_DIR on this computer's disk."]
            : ["Storage", "This computer's disk", "Telegram isn't configured, so files are kept in DATA_DIR on disk."],
          ["Free space", formatBytes(cap.freeBytes ?? 0), `of ${formatBytes(cap.totalBytes ?? 0)} on the disk holding DATA_DIR.`],
          ["Size of one part", formatBytes(cap.partSize), "Files are split the same way they would be for Telegram."],
          [
            "Largest single file",
            formatBytes(Math.min(cap.maxFileSize, cap.freeBytes ?? cap.maxFileSize)),
            `The free space, here. The file format itself goes up to ${formatBytes(cap.maxFileSize)} (2^53 − 1 bytes).`,
          ],
        ];
  return (
    <dl className="divide-y divide-line" data-testid="limits">
      {rows.map(([label, value, note]) => (
        <div key={label} className="grid gap-x-4 gap-y-0.5 py-2.5 sm:grid-cols-[180px_160px_1fr] sm:items-baseline">
          <dt className="text-[13px] text-ink-3">{label}</dt>
          <dd className="text-[15px] font-semibold text-ink tabular">{value}</dd>
          <dd className="text-[12.5px] leading-snug text-ink-3">{note}</dd>
        </div>
      ))}
    </dl>
  );
}
