"use client";
import { ArrowRight, FolderPlus, FolderUp, Link2, Play, Star, Upload } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { formatBytes, formatDate } from "@/lib/format";
import type { DriveNode } from "@/lib/types";
import { folderTone } from "../files";
import { openPicker } from "../pickers";
import { useHome, useRecentPhotos, useSystemSummary } from "../queries";
import { navigate } from "../router";
import { useUi } from "../store";
import { ActivityList } from "./ActivityFeed";
import { GeoStrip } from "./Brand";
import { useTitle } from "./DriveView";
import { FolderPreview, NodeThumb, TypeTag } from "./NodeVisual";
import { Button, cn, Tabs } from "./ui";

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** Counts up to a number once, so the stats arrive with a little life. */
function useCountUp(value: number | undefined, ms = 700) {
  const [shown, setShown] = useState(value ?? 0);
  const from = useRef(0);
  useEffect(() => {
    if (value === undefined) return;
    const start = performance.now();
    const a = from.current;
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - (1 - t) ** 3;
      setShown(Math.round(a + (value - a) * eased));
      if (t < 1) frame = requestAnimationFrame(tick);
      else from.current = value;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, ms]);
  return shown;
}

function Stat({ value, label, format }: { value: number | undefined; label: string; format?: (n: number) => string }) {
  const n = useCountUp(value);
  return (
    <div className="border-l-[1.5px] border-line-strong pl-4">
      <div className="text-[30px] font-semibold leading-none tracking-[-0.03em] text-ink tabular">{value === undefined ? "—" : format ? format(n) : n.toLocaleString()}</div>
      <div className="mt-1.5 text-[13px] text-ink-3">{label}</div>
    </div>
  );
}

function QuickAction({ icon, label, hint, onClick, testId, delay }: { icon: ReactNode; label: string; hint: string; onClick: () => void; testId?: string; delay: number }) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className="lift group flex min-h-[112px] flex-col justify-between border border-line bg-surface p-4 text-left animate-rise"
      style={{ animationDelay: `${delay}ms` }}
    >
      <span className="flex size-10 items-center justify-center bg-invert text-on-invert transition-colors group-hover:bg-accent group-hover:text-on-accent [&_svg]:size-5">{icon}</span>
      <span>
        <span className="block text-[15.5px] font-semibold text-ink">{label}</span>
        <span className="block text-[13px] text-ink-3">{hint}</span>
      </span>
    </button>
  );
}

function FolderTile({ node, delay }: { node: DriveNode; delay: number }) {
  return (
    <button
      onClick={() => navigate({ name: "folder", id: node.id })}
      className="lift group relative flex flex-col border border-line bg-surface p-1.5 text-left animate-rise"
      style={{ animationDelay: `${delay}ms` }}
      data-testid="home-folder"
    >
      {node.color ? <span className="absolute inset-x-0 top-0 z-10 h-1" style={{ background: folderTone(node).bg }} aria-hidden /> : null}
      <FolderPreview node={node} className="aspect-[16/10] w-full" />
      <div className="flex items-start gap-2 px-2 pb-1.5 pt-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold text-ink">{node.name}</div>
          <div className="mt-0.5 text-[12.5px] text-ink-3 tabular">
            {node.childCount ? `${node.childCount.toLocaleString()} item${node.childCount === 1 ? "" : "s"}` : "Empty"}
            {node.folderSize ? ` · ${formatBytes(node.folderSize)}` : ""}
          </div>
        </div>
        <span className="flex items-center gap-1 pt-1">
          {node.starred ? <Star className="size-3.5 fill-accent text-accent" /> : null}
          {node.shareCount ? <Link2 className="size-3.5 text-ink-2" /> : null}
        </span>
      </div>
    </button>
  );
}

function FileTile({ node, list, delay }: { node: DriveNode; list: DriveNode[]; delay: number }) {
  return (
    <button
      onClick={() => {
        useUi.getState().setVisible(list);
        useUi.getState().openPreview(node.id);
      }}
      className="lift group flex w-[168px] shrink-0 flex-col border border-line bg-surface p-1.5 text-left animate-rise sm:w-auto"
      style={{ animationDelay: `${delay}ms` }}
    >
      <NodeThumb node={node} className="aspect-[4/3] w-full" />
      <div className="px-1.5 pb-1 pt-2.5">
        <div className="truncate text-[14px] font-semibold text-ink">{node.name}</div>
        <div className="@container mt-1 flex items-center gap-1.5 text-[12px] text-ink-3 tabular">
          <TypeTag node={node} className="h-[16px] min-w-0 shrink-0 px-1 text-[9.5px]" />
          <span className="min-w-0 truncate">
            {formatBytes(node.size)}
            <span className="hidden @[11rem]:inline"> · {formatDate(node.updatedAt)}</span>
          </span>
        </div>
      </div>
    </button>
  );
}

function Section({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={className}>
      <div className="mb-3 flex items-end justify-between gap-3">
        <h2 className="text-[20px] font-semibold tracking-[-0.02em] text-ink">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const TYPE_COLOR: Record<string, string> = {
  Videos: "#2f5da8",
  Images: "#f2652a",
  Documents: "#f2b33d",
  Audio: "#6b4fd8",
  Archives: "#1e7a4c",
  Other: "var(--ink-3)",
};

/** The hero's bottom edge: what the space is made of, as solid blocks. Opens Storage. */
function TypeBar() {
  const { data } = useSystemSummary();
  const types = data?.snapshot.storage.byType ?? [];
  const total = types.reduce((n, t) => n + t.bytes, 0);
  if (!total) return null;
  return (
    <button
      onClick={() => navigate({ name: "storage" })}
      className="group flex h-3 w-full border-t-[1.5px] border-line-strong transition-[height] duration-300 hover:h-6"
      aria-label="Space by type — open Storage"
      title={types.map((t) => `${t.type}: ${formatBytes(t.bytes)}`).join(" · ")}
    >
      {types.map((t, i) => (
        <span
          key={t.type}
          className="h-full origin-left animate-[grow_800ms_var(--ease-out)_both]"
          style={{ width: `${(t.bytes / total) * 100}%`, background: TYPE_COLOR[t.type] ?? "var(--ink-3)", animationDelay: `${300 + i * 80}ms` }}
        />
      ))}
    </button>
  );
}

/** A strip of the newest photos, straight into the timeline. */
function RecentPhotos() {
  const { data } = useRecentPhotos();
  const items = data?.items ?? [];
  if (items.length < 3) return null;
  return (
    <section className="animate-rise [animation-delay:120ms]">
      <div className="mb-3 flex items-end justify-between gap-3">
        <h2 className="text-[20px] font-semibold tracking-[-0.02em] text-ink">Recent photos</h2>
        <button onClick={() => navigate({ name: "photos" })} className="flex items-center gap-1 text-[13.5px] font-semibold text-ink-2 hover:text-accent">
          All photos <ArrowRight className="size-4" />
        </button>
      </div>
      <div className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]" data-testid="home-photos">
        {items.map((p, i) => (
          <button
            key={p.id}
            onClick={() => {
              useUi.getState().setVisible(items);
              useUi.getState().openPreview(p.id);
            }}
            className="group relative h-36 shrink-0 overflow-hidden bg-surface-3 animate-rise md:h-44"
            style={{ aspectRatio: String(Math.min(1.8, Math.max(0.6, p.ratio ?? 1))), animationDelay: `${160 + i * 35}ms` }}
            aria-label={`Open ${p.name}`}
          >
            <NodeThumb node={p} className="size-full transition-transform duration-500 group-hover:scale-105" />
            {p.mime?.startsWith("video/") ? (
              <span className="absolute bottom-1.5 left-1.5 flex size-6 items-center justify-center bg-[#111] text-[#efeae1]">
                <Play className="ml-px size-3 fill-current" />
              </span>
            ) : null}
          </button>
        ))}
        {/* Takes up the rest of the row when the photos don't, so the strip ends flush. */}
        <button
          onClick={() => navigate({ name: "photos" })}
          className="group flex h-36 min-w-[132px] flex-1 shrink-0 flex-col justify-between bg-surface-2 p-4 text-left animate-rise hover:bg-surface-3 md:h-44"
          style={{ animationDelay: `${160 + items.length * 35}ms` }}
        >
          <span className="flex size-9 items-center justify-center bg-invert text-on-invert transition-colors group-hover:bg-accent group-hover:text-on-accent">
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </span>
          <span className="text-[14px] font-semibold text-ink">See all photos</span>
        </button>
      </div>
    </section>
  );
}

type FolderTab = "recent" | "starred" | "shared";

export function HomeView() {
  const { data } = useHome();
  const [tab, setTab] = useState<FolderTab>("recent");
  useTitle("Home");
  const folders = data?.folders[tab];
  const empty = data && data.stats.files === 0 && data.stats.folders === 0;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="home">
      <div className="mx-auto max-w-[1280px] space-y-9 px-3 pb-16 pt-4 md:px-6 md:pt-6">
        {/* Hero */}
        <section className="overflow-hidden border-[1.5px] border-line-strong bg-surface">
          <GeoStrip className="h-14 md:h-20" />
          <div className="flex flex-col gap-6 p-5 md:flex-row md:items-end md:justify-between md:p-7">
            <div className="animate-rise [animation-delay:200ms]">
              <h1 className="text-[34px] font-semibold leading-[1.05] tracking-[-0.03em] text-ink md:text-[44px]">
                {greeting()}
              </h1>
              <p className="mt-2 max-w-md text-[15px] text-ink-2">Everything here lives in your private Telegram channel, and opens on any device you sign in from.</p>
              <div className="mt-5 flex flex-wrap gap-2">
                <Button size="lg" onClick={() => openPicker("files", "root")} data-testid="home-upload">
                  <Upload className="size-4" strokeWidth={2.5} /> Upload files
                </Button>
                <Button size="lg" variant="outline" onClick={() => navigate({ name: "folder", id: "root" })}>
                  Open my files <ArrowRight className="size-4" />
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-5 animate-rise [animation-delay:280ms] sm:grid-cols-4 md:grid-cols-2 lg:grid-cols-4">
              <Stat value={data?.stats.bytes} label="Stored" format={(n) => formatBytes(n)} />
              <Stat value={data?.stats.files} label="Files" />
              <Stat value={data?.stats.folders} label="Folders" />
              <Stat value={data?.stats.shares} label="Active links" />
            </div>
          </div>
          <TypeBar />
        </section>

        <RecentPhotos />

        {/* Quick actions */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
          <QuickAction icon={<Upload />} label="Upload files" hint="Or drop them anywhere" onClick={() => openPicker("files", "root")} testId="qa-upload" delay={40} />
          <QuickAction icon={<FolderUp />} label="Upload a folder" hint="Keeps its structure" onClick={() => openPicker("folder", "root")} testId="qa-upload-folder" delay={90} />
          <QuickAction icon={<FolderPlus />} label="New folder" hint="In My files" onClick={() => useUi.getState().openDialog({ type: "newFolder", parentId: "root" })} testId="qa-new-folder" delay={140} />
          <QuickAction icon={<Link2 />} label="Shared links" hint="Manage what you've shared" onClick={() => navigate({ name: "shared" })} testId="qa-shared" delay={190} />
        </div>

        {empty ? null : (
          <div className="grid gap-9 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="min-w-0 space-y-9">
              <Section
                title="Folders"
                action={
                  <Tabs
                    layoutId="home-folder-tabs"
                    value={tab}
                    onChange={setTab}
                    options={[
                      { value: "recent", label: "Recent" },
                      { value: "starred", label: "Starred", count: data?.folders.starred.length || undefined },
                      { value: "shared", label: "Shared", count: data?.folders.shared.length || undefined },
                    ]}
                  />
                }
              >
                {!folders ? (
                  <div className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4">
                    {Array.from({ length: 4 }, (_, i) => (
                      <div key={i} className="skeleton aspect-[16/12]" />
                    ))}
                  </div>
                ) : folders.length ? (
                  <div key={tab} className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4">
                    {folders.map((f, i) => (
                      <FolderTile key={f.id} node={f} delay={i * 45} />
                    ))}
                  </div>
                ) : (
                  <p className="border border-dashed border-line px-4 py-8 text-center text-[14px] text-ink-3">
                    {tab === "starred" ? "Star a folder to keep it here." : tab === "shared" ? "Folders you share by link show up here." : "Your folders will show up here."}
                  </p>
                )}
              </Section>

              <Section
                title="Recent files"
                action={
                  <button onClick={() => navigate({ name: "recent" })} className="flex items-center gap-1 text-[14px] font-semibold text-ink-2 hover:text-accent">
                    See all <ArrowRight className="size-4" />
                  </button>
                }
              >
                {!data ? (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                    {Array.from({ length: 6 }, (_, i) => (
                      <div key={i} className="skeleton aspect-[4/5]" />
                    ))}
                  </div>
                ) : data.recentFiles.length ? (
                  <div className="-mx-3 flex gap-3 overflow-x-auto px-3 pb-2 sm:mx-0 sm:grid sm:grid-cols-3 sm:overflow-visible sm:px-0 lg:grid-cols-6">
                    {data.recentFiles.slice(0, 12).map((n, i) => (
                      <FileTile key={n.id} node={n} list={data.recentFiles} delay={i * 35} />
                    ))}
                  </div>
                ) : (
                  <p className="border border-dashed border-line px-4 py-8 text-center text-[14px] text-ink-3">Upload something and it appears here.</p>
                )}
              </Section>
            </div>

            <Section title="Activity" className="min-w-0">
              <div className={cn("border border-line bg-surface px-2")} data-testid="home-activity">
                <ActivityList items={data?.activity} emptyText="Uploads, deletions and link visits show up here." />
              </div>
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}
