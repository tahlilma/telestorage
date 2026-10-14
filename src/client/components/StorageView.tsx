"use client";
import { ArrowRight, Copy, History, Image as ImageIcon, MoreHorizontal, Trash2, Upload } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { formatBytes } from "@/lib/format";
import type { DriveNode, StorageInsights } from "@/lib/types";
import { openPicker } from "../pickers";
import { useStorageInsights } from "../queries";
import { navigate } from "../router";
import { useUi } from "../store";
import { LimitsTable, roomLeftText } from "./Capacity";
import { PageTitle, useTitle } from "./DriveView";
import { NodeMenuItems } from "./menus";
import { NodeThumb, TypeIcon } from "./NodeVisual";
import { Button, cn, Spinner } from "./ui";

/** Bauhaus colours for the space-by-type bar. */
const TYPE_COLOR: Record<string, string> = {
  Videos: "#2f5da8",
  Images: "#f2652a",
  Documents: "#f2b33d",
  Audio: "#6b4fd8",
  Archives: "#1e7a4c",
  Other: "var(--ink-3)",
};

/** Where the space goes: by type, the biggest files, versions and trash — and how much room is left. */
export function StorageView() {
  useTitle("Storage");
  const { data, isPending } = useStorageInsights();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="storage-page">
      <div className="mx-auto max-w-[1100px] space-y-6 px-3 pb-20 pt-4 md:px-6 md:pt-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <PageTitle title="Storage" sub="Where your space goes, and how much room is left" />
          <Button variant="outline" size="sm" onClick={() => navigate({ name: "system" })}>
            System status <ArrowRight className="size-3.5" />
          </Button>
        </div>
        {isPending || !data ? (
          <div className="flex justify-center py-20">
            <Spinner className="size-7" />
          </div>
        ) : (
          <>
            <Overview data={data} />
            <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
              <Biggest files={data.largest} />
              <div className="space-y-4">
                <Extras data={data} />
                {data.photosByYear.length ? <PhotoYears years={data.photosByYear} /> : null}
              </div>
            </div>
            <section className="border-[1.5px] border-line-strong bg-surface p-5">
              <div className="label text-accent">Capacity</div>
              <h2 className="mt-1 text-[20px] font-semibold tracking-[-0.02em] text-ink">How much fits</h2>
              <div className="mt-3">
                <LimitsTable cap={data.capacity} bots={Math.max(1, Math.round((data.capacity.postsPerMinute ?? 20) / 20))} simulated={data.driver === "sim"} />
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function Overview({ data }: { data: StorageInsights }) {
  const total = data.byType.reduce((n, t) => n + t.bytes, 0);
  return (
    <section className="overflow-hidden border-[1.5px] border-line-strong bg-surface">
      <div className="grid gap-6 p-5 md:grid-cols-[1fr_auto] md:p-7">
        <div>
          <div className="label text-ink-3">In use</div>
          <div className="mt-1 text-[clamp(40px,6vw,64px)] font-semibold leading-none tracking-[-0.04em] text-ink tabular animate-rise">{formatBytes(data.live.bytes)}</div>
          <div className="mt-2 text-[14px] text-ink-2 tabular">
            {data.live.count.toLocaleString()} file{data.live.count === 1 ? "" : "s"} · {formatBytes(data.stored)} actually stored (duplicates once, versions and trash included)
          </div>
        </div>
        <div className="flex items-start md:justify-end">
          <span className="inline-flex items-center bg-accent px-3 py-1.5 text-[14px] font-semibold text-on-accent tabular">{roomLeftText(data.capacity)}</span>
        </div>
      </div>
      {/* Space by type: a Bauhaus bar of solid blocks. */}
      <div className="flex h-12 w-full border-t-[1.5px] border-line-strong" role="img" aria-label="Space by type">
        {total > 0 ? (
          data.byType.map((t, i) => (
            <div
              key={t.type}
              className="h-full origin-left animate-[grow_700ms_var(--ease-out)_both]"
              style={{ width: `${(t.bytes / total) * 100}%`, background: TYPE_COLOR[t.type] ?? "var(--ink-3)", animationDelay: `${i * 70}ms` }}
              title={`${t.type}: ${formatBytes(t.bytes)}`}
            />
          ))
        ) : (
          <div className="flex h-full w-full items-center justify-between gap-4 bg-surface-2 px-5">
            <span className="min-w-0 text-[13px] leading-snug text-ink-3">Nothing stored yet. This bar splits by file type as you upload.</span>
            <span className="hidden shrink-0 gap-1 sm:flex" aria-hidden>
              {Object.entries(TYPE_COLOR)
                .filter(([type]) => type !== "Other")
                .map(([type, color]) => (
                  <span key={type} className="size-3" style={{ background: color }} />
                ))}
            </span>
          </div>
        )}
      </div>
      {/* Flex, not grid: every row stretches to full width, so an odd count leaves no empty cell. */}
      <ul className="flex flex-wrap gap-px bg-line">
        {data.byType.map((t) => (
          <li key={t.type} className="min-w-[150px] flex-1 bg-surface px-4 py-3">
            <div className="flex items-center gap-2 text-[13px] text-ink-2">
              <span className="size-3" style={{ background: TYPE_COLOR[t.type] ?? "var(--ink-3)" }} /> {t.type}
            </div>
            <div className="mt-1 text-[17px] font-semibold text-ink tabular">{formatBytes(t.bytes)}</div>
            <div className="text-[12px] text-ink-3 tabular">
              {t.count.toLocaleString()} file{t.count === 1 ? "" : "s"}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Biggest({ files }: { files: DriveNode[] }) {
  const max = files[0]?.size || 1;
  return (
    <section className="border-[1.5px] border-line-strong bg-surface" data-testid="biggest-files">
      <div className="flex items-center justify-between border-b border-line px-5 py-4">
        <div>
          <div className="label text-accent">Biggest files</div>
          <h2 className="mt-0.5 text-[18px] font-semibold tracking-[-0.02em] text-ink">What takes the most room</h2>
        </div>
      </div>
      {files.length ? (
        <ol>
          {files.slice(0, 25).map((f, i) => (
            <li key={f.id} className="group relative flex items-center gap-3 border-b border-line px-5 py-2.5 last:border-b-0">
              <span className="w-5 text-right text-[12px] text-ink-3 tabular">{i + 1}</span>
              <button
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                onClick={() => {
                  useUi.getState().revealNode(f.id);
                  navigate({ name: "folder", id: f.parentId ?? "root" });
                }}
              >
                {f.hasThumb ? <NodeThumb node={f} className="size-9 shrink-0" /> : <TypeIcon node={f} className="size-9 shrink-0" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-ink">{f.name}</span>
                  <span className="mt-1 block h-1.5 bg-surface-3">
                    <span className="block h-full bg-invert" style={{ width: `${Math.max(1, (f.size / max) * 100)}%` }} />
                  </span>
                </span>
              </button>
              <span className="w-20 text-right text-[13.5px] font-semibold text-ink tabular">{formatBytes(f.size)}</span>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button aria-label={`More actions for ${f.name}`} className="flex size-8 items-center justify-center text-ink-3 hover:bg-surface-3 hover:text-ink data-[state=open]:bg-invert data-[state=open]:text-on-invert">
                    <MoreHorizontal className="size-4" />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content className="menu-surface" align="end" collisionPadding={8}>
                    <NodeMenuItems parts={DropdownMenu} nodes={[f]} inTrash={false} />
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </li>
          ))}
        </ol>
      ) : (
        <div className="flex flex-col items-center gap-3 px-5 py-12 text-center">
          <p className="text-[14px] text-ink-3">No files yet. The largest ones will be listed here.</p>
          <Button variant="outline" size="sm" onClick={() => openPicker("files", "root")}>
            <Upload className="size-3.5" /> Upload files
          </Button>
        </div>
      )}
    </section>
  );
}

function Extras({ data }: { data: StorageInsights }) {
  const saved = Math.max(0, data.live.bytes + data.versions.bytes + data.trash.bytes - data.stored);
  const card = "border-[1.5px] border-line-strong bg-surface p-4";
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-1">
      <div className={card}>
        <div className="flex items-center gap-2 text-[13px] text-ink-2">
          <History className="size-4" /> Earlier versions
        </div>
        <div className="mt-1 text-[22px] font-semibold text-ink tabular">{formatBytes(data.versions.bytes)}</div>
        <div className="text-[12.5px] text-ink-3 tabular">{data.versions.count.toLocaleString()} kept</div>
      </div>
      <div className={card}>
        <div className="flex items-center gap-2 text-[13px] text-ink-2">
          <Trash2 className="size-4" /> In the trash
        </div>
        <div className="mt-1 text-[22px] font-semibold text-ink tabular">{formatBytes(data.trash.bytes)}</div>
        <div className="flex items-center justify-between gap-2 text-[12.5px] text-ink-3 tabular">
          {data.trash.count.toLocaleString()} file{data.trash.count === 1 ? "" : "s"}
          {data.trash.count ? (
            <button className="font-semibold text-danger hover:underline" onClick={() => useUi.getState().openDialog({ type: "emptyTrash" })}>
              Empty
            </button>
          ) : null}
        </div>
      </div>
      <div className={cn(card, "col-span-2 lg:col-span-1")}>
        <div className="flex items-center gap-2 text-[13px] text-ink-2">
          <Copy className="size-4" /> Saved by storing duplicates once
        </div>
        <div className="mt-1 text-[22px] font-semibold text-ink tabular">{formatBytes(saved)}</div>
        <div className="text-[12.5px] text-ink-3 tabular">{saved > 0 ? `${Math.round((saved / (saved + data.stored)) * 100)}% less than keeping every copy` : "Identical files are stored once"}</div>
      </div>
    </div>
  );
}

function PhotoYears({ years }: { years: StorageInsights["photosByYear"] }) {
  const max = Math.max(...years.map((y) => y.count), 1);
  return (
    <section className="border-[1.5px] border-line-strong bg-surface p-4">
      <button className="flex w-full items-center justify-between text-left" onClick={() => navigate({ name: "photos" })}>
        <span className="flex items-center gap-2 text-[13px] text-ink-2">
          <ImageIcon className="size-4" /> Photos & videos by year
        </span>
        <ArrowRight className="size-4 text-ink-3" />
      </button>
      <ul className="mt-3 space-y-1.5">
        {years.slice(0, 8).map((y) => (
          <li key={y.year} className="grid grid-cols-[44px_1fr_auto] items-center gap-2 text-[12.5px] tabular">
            <span className="font-semibold text-ink">{y.year}</span>
            <span className="h-3 bg-surface-3">
              <span className="block h-full bg-accent" style={{ width: `${(y.count / max) * 100}%` }} />
            </span>
            <span className="text-ink-3">{y.count.toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
