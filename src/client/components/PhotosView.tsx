"use client";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Image as ImageIcon, Play, Star, Upload } from "lucide-react";
import { ContextMenu } from "radix-ui";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PhotoItem } from "@/lib/types";
import { categoryOf } from "../files";
import { isTouchDevice, useIsMobile } from "../hooks";
import { openPicker } from "../pickers";
import { usePhotos } from "../queries";
import { useUi } from "../store";
import { EmptyBoxArt } from "./Brand";
import { Empty, PageTitle, useTitle } from "./DriveView";
import { NodeMenuItems } from "./menus";
import { NodeThumb } from "./NodeVisual";
import { Button, cn, Tabs } from "./ui";

/**
 * Photos: every image and video in the drive on one timeline, newest moment
 * first, grouped by month, laid out in justified rows (each row fills the
 * width at roughly the target height, like a photo book). Rows are
 * virtualized, so a library of 100 000 photos scrolls like one of 100.
 */

type Kind = "all" | "photos" | "videos";

type Row =
  | { type: "month"; key: string; label: string; count: number; height: number }
  | { type: "photos"; key: string; height: number; items: { item: PhotoItem; width: number }[] };

const GAP = 4;
const HEADER = 56;
const monthFmt = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

/** Greedy justified rows: add photos until the row, scaled to the width, would drop below the target height. */
function justify(items: PhotoItem[], width: number, target: number): Row[] {
  const rows: Row[] = [];
  let current: PhotoItem[] = [];
  let ratios = 0;
  const flush = (last: boolean) => {
    if (!current.length) return;
    const gaps = GAP * (current.length - 1);
    let height = (width - gaps) / ratios;
    if (last && height > target * 1.25) height = target; // a short last row keeps its natural height
    const r = current.map((item) => ({ item, width: (item.ratio && item.ratio > 0 ? item.ratio : 1) * height }));
    rows.push({ type: "photos", key: `p-${current[0].id}`, height: Math.round(height), items: r });
    current = [];
    ratios = 0;
  };
  for (const item of items) {
    const ratio = Math.min(3, Math.max(0.33, item.ratio && item.ratio > 0 ? item.ratio : 1));
    current.push({ ...item, ratio });
    ratios += ratio;
    if ((width - GAP * (current.length - 1)) / ratios <= target) flush(false);
  }
  flush(true);
  return rows;
}

export function PhotosView() {
  useTitle("Photos");
  const { data, isPending, fetchNextPage, hasNextPage, isFetchingNextPage } = usePhotos();
  const [kind, setKind] = useState<Kind>("all");
  const mobile = useIsMobile();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [menuNode, setMenuNode] = useState<PhotoItem | null>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth - (mobile ? 24 : 48)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [mobile]);

  const all = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  const items = useMemo(
    () => (kind === "all" ? all : all.filter((p) => (kind === "videos" ? categoryOf(p) === "video" : categoryOf(p) === "image"))),
    [all, kind],
  );

  // Months, then justified rows inside each.
  const rows = useMemo(() => {
    if (width <= 0) return [] as Row[];
    const target = mobile ? 132 : 220;
    const out: Row[] = [];
    let i = 0;
    while (i < items.length) {
      const d = new Date(items[i].at);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      let j = i;
      while (j < items.length) {
        const e = new Date(items[j].at);
        if (e.getFullYear() !== d.getFullYear() || e.getMonth() !== d.getMonth()) break;
        j++;
      }
      out.push({ type: "month", key: `m-${key}`, label: monthFmt.format(d), count: j - i, height: HEADER });
      out.push(...justify(items.slice(i, j), width, target));
      i = j;
    }
    return out;
  }, [items, width, mobile]);

  // TanStack Virtual returns fresh functions each render: the React Compiler skips this component, as intended.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => rows[i].height + (rows[i].type === "photos" ? GAP : 0),
    getItemKey: (i) => rows[i].key,
    overscan: 6,
  });

  // Row heights change with the width (and as photos arrive): measure again.
  useEffect(() => {
    virtual.measure();
  }, [rows, virtual]);

  // Keep pages coming as the end gets close.
  const last = virtual.getVirtualItems().at(-1);
  useEffect(() => {
    if (last && last.index >= rows.length - 8 && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [last, rows.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const open = (item: PhotoItem) => {
    useUi.getState().setVisible(items);
    useUi.getState().openPreview(item.id);
  };

  const photos = all.filter((p) => categoryOf(p) === "image").length;
  const videos = all.length - photos;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-end justify-between gap-3 px-3 pb-3 pt-4 md:px-6 md:pt-6">
        <PageTitle
          title="Photos"
          sub={all.length ? `${photos.toLocaleString()} photo${photos === 1 ? "" : "s"} · ${videos.toLocaleString()} video${videos === 1 ? "" : "s"}${hasNextPage ? "+" : ""} · newest first, by when they were taken` : undefined}
        />
        <Tabs
          layoutId="photos-tabs"
          value={kind}
          onChange={setKind}
          options={[
            { value: "all", label: "All" },
            { value: "photos", label: "Photos" },
            { value: "videos", label: "Videos" },
          ]}
        />
      </div>
      <ContextMenu.Root modal={false} onOpenChange={(o) => !o && setMenuNode(null)}>
        <ContextMenu.Trigger asChild disabled={isTouchDevice()}>
          <div
            ref={scrollRef}
            className="relative min-h-0 flex-1 overflow-y-auto px-3 pb-24 md:px-6"
            data-testid="photos"
            onContextMenuCapture={(e) => {
              const id = (e.target as HTMLElement).closest<HTMLElement>("[data-photo-id]")?.dataset.photoId;
              setMenuNode(items.find((p) => p.id === id) ?? null);
            }}
          >
            {isPending ? (
              <div className="grid grid-cols-3 gap-1 md:grid-cols-6">
                {Array.from({ length: 18 }, (_, i) => (
                  <div key={i} className="skeleton aspect-square" />
                ))}
              </div>
            ) : !items.length ? (
              <div className="flex min-h-full items-center justify-center py-16">
                <Empty
                  art={<EmptyBoxArt />}
                  title={kind === "videos" ? "No videos yet" : "No photos yet"}
                  text="Every photo and video you upload, in any folder, shows up here — sorted by when it was taken."
                  action={
                    <Button size="lg" onClick={() => openPicker("files", "root")}>
                      <Upload className="size-4" /> Upload photos
                    </Button>
                  }
                />
              </div>
            ) : (
              <div className="relative w-full" style={{ height: virtual.getTotalSize() }}>
                {virtual.getVirtualItems().map((v) => {
                  const row = rows[v.index];
                  return (
                    <div key={v.key} className="absolute inset-x-0" style={{ transform: `translateY(${v.start}px)`, height: row.height }}>
                      {row.type === "month" ? (
                        <div className="flex h-full items-end gap-3 pb-2.5">
                          <h2 className="text-[19px] font-semibold tracking-[-0.02em] text-ink">{row.label}</h2>
                          <span className="pb-0.5 text-[13px] text-ink-3 tabular">{row.count.toLocaleString()}</span>
                          <span className="mb-2 h-px flex-1 bg-line" />
                        </div>
                      ) : (
                        <div className="flex h-full" style={{ gap: GAP }}>
                          {row.items.map(({ item, width: w }) => (
                            <Tile key={item.id} item={item} width={w} onOpen={open} />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="menu-surface" collisionPadding={8}>
            {menuNode ? <NodeMenuItems parts={ContextMenu} nodes={[menuNode]} inTrash={false} /> : <ContextMenu.Item className="menu-item" disabled>Right-click a photo</ContextMenu.Item>}
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </div>
  );
}

function Tile({ item, width, onOpen }: { item: PhotoItem; width: number; onOpen: (p: PhotoItem) => void }) {
  const video = categoryOf(item) === "video";
  return (
    <button
      data-photo-id={item.id}
      onClick={() => onOpen(item)}
      className="group relative h-full shrink-0 overflow-hidden bg-surface-3 outline-offset-2"
      style={{ width }}
      aria-label={`Open ${item.name}`}
    >
      {item.hasThumb ? (
        <NodeThumb node={item} className="size-full transition-transform duration-500 ease-out group-hover:scale-[1.04]" />
      ) : (
        <span className="flex size-full items-center justify-center text-ink-3">
          <ImageIcon className="size-6" />
        </span>
      )}
      {/* A soft scrim so the badges stay readable on bright photos. */}
      <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/35 via-transparent to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
      {video ? (
        <span className="absolute bottom-1.5 left-1.5 flex size-6 items-center justify-center bg-[#111] text-[#efeae1]">
          <Play className="ml-px size-3 fill-current" />
        </span>
      ) : null}
      {item.starred ? (
        <span className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center bg-accent text-on-accent">
          <Star className="size-3.5 fill-current" />
        </span>
      ) : null}
      <span className={cn("pointer-events-none absolute inset-x-1.5 bottom-1.5 truncate text-left text-[11.5px] font-medium text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100", video && "pl-8")}>
        {item.name}
      </span>
    </button>
  );
}
