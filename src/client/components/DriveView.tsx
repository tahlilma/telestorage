"use client";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronLeft, ChevronRight, Download, Flame, FolderInput, FolderPlus, FolderUp, Info, LayoutGrid, Link2, List, RotateCcw, Share2, Trash2, Upload, X } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useEffect, useState, type ReactNode } from "react";
import type { Crumb } from "@/lib/types";
import { downloadNodes, moveNodes, quickLink, restoreNodes, trashNodes } from "../actions";
import { collectDrop, hasFiles, hasNodes, readNodeIds } from "../dnd";
import { openPicker } from "../pickers";
import { prefetchFolder, useFolder, useSearch, useSystemSummary, useView } from "../queries";
import { navigate, type ListRoute } from "../router";
import { usePrefs, useUi, type TypeFilter } from "../store";
import { enqueueUploads } from "../upload/engine";
import { EmptyBoxArt, EmptyClockArt, EmptySearchArt, EmptyStarArt, EmptyTrashArt, LostSignalArt } from "./Brand";
import { FileBrowser } from "./FileBrowser";
import { BackgroundMenuItems, NodeMenuItems } from "./menus";
import { Button, cn, IconButton } from "./ui";

export function DriveView({ route }: { route: ListRoute }) {
  if (route.name === "folder") return <FolderView id={route.id} />;
  if (route.name === "search") return <SearchView q={route.q} />;
  return <VirtualView view={route.name} />;
}

export function useTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · Telestorage`;
  }, [title]);
}

function UploadButtons({ folderId, folderName }: { folderId: string; folderName: string }) {
  // Phones get the raised + button in the tab bar instead.
  return (
    <div className="hidden items-center sm:flex">
      <Button onClick={() => openPicker("files", folderId, folderName)} className="pr-4" data-testid="upload-button">
        <Upload className="size-4" strokeWidth={2.5} /> Upload
      </Button>
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <Button aria-label="More upload options" className="border-l border-on-invert/20 px-2.5">
            <ChevronDown className="size-4" strokeWidth={2.5} />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="menu-surface" align="end" sideOffset={6}>
            <DropdownMenu.Item className="menu-item" onSelect={() => openPicker("files", folderId, folderName)}>
              <Upload /> Upload files
            </DropdownMenu.Item>
            <DropdownMenu.Item className="menu-item" onSelect={() => openPicker("folder", folderId, folderName)}>
              <FolderUp /> Upload a folder
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

function FolderView({ id }: { id: string }) {
  const { data, isPending, error } = useFolder(id);
  // Keep the breadcrumb of the previous folder visible while the next one loads.
  const path = data?.path ?? [{ id, name: id === "root" ? "My files" : "…" }];
  const name = id === "root" ? "My files" : (path.at(-1)?.name ?? "My files");
  useTitle(name);
  return (
    <>
      <ViewHeader
        title={<Breadcrumbs path={path} folderId={id} />}
        actions={
          <>
            <Button variant="outline" onClick={() => useUi.getState().openDialog({ type: "newFolder", parentId: id })} className="hidden md:inline-flex">
              <FolderPlus className="size-4" /> New folder
            </Button>
            <UploadButtons folderId={id} folderName={name} />
          </>
        }
      />
      {error ? (
        <ErrorState message={(error as Error).message} />
      ) : (
        <FileBrowser
          items={data?.items}
          loading={isPending}
          folderId={id}
          folderName={name}
          empty={
            <Empty
              art={<EmptyBoxArt />}
              title={id === "root" ? "Your storage is wide open" : "This folder is empty"}
              text="Drop files or whole folders anywhere on this page, paste from the clipboard, or pick them below. Everything goes to your private Telegram channel, any size."
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Button size="lg" onClick={() => openPicker("files", id, name)} data-testid="empty-upload">
                    <Upload className="size-4" strokeWidth={2.5} /> Upload files
                  </Button>
                  <Button size="lg" variant="outline" onClick={() => openPicker("folder", id, name)} data-testid="empty-upload-folder">
                    <FolderUp className="size-4" /> Upload a folder
                  </Button>
                  <Button size="lg" variant="ghost" onClick={() => useUi.getState().openDialog({ type: "newFolder", parentId: id })} data-testid="empty-new-folder">
                    <FolderPlus className="size-4" /> New folder
                  </Button>
                </div>
              }
            />
          }
        />
      )}
    </>
  );
}

const VIEWS = {
  recent: { title: "Recent", sub: "Files you uploaded or opened lately", art: <EmptyClockArt />, emptyTitle: "Nothing recent yet", empty: "Files you upload or open show up here, newest first." },
  starred: { title: "Starred", sub: "Your shortcuts", art: <EmptyStarArt />, emptyTitle: "No starred items", empty: "Star files and folders you use often — press S or use the ⋮ menu." },
  trash: { title: "Trash", sub: "Restorable until deleted forever", art: <EmptyTrashArt />, emptyTitle: "The trash is empty", empty: "Deleted items wait here and can be restored. Deleting forever removes them from Telegram too." },
} as const;

function VirtualView({ view }: { view: "recent" | "starred" | "trash" }) {
  const { data, isPending, error } = useView(view);
  const meta = VIEWS[view];
  useTitle(meta.title);
  return (
    <>
      <ViewHeader
        title={<PageTitle title={meta.title} sub={meta.sub} />}
        actions={
          view === "trash" && data?.items.length ? (
            <Button variant="outline" onClick={() => useUi.getState().openDialog({ type: "emptyTrash" })}>
              <Flame className="size-4 text-danger" /> Empty trash
            </Button>
          ) : null
        }
        note={view === "trash" ? <RetentionNote /> : null}
      />
      {error ? (
        <ErrorState message={(error as Error).message} />
      ) : (
        <FileBrowser
          items={data?.items}
          loading={isPending}
          folderId={null}
          inTrash={view === "trash"}
          keepOrder={view !== "starred"}
          empty={<Empty art={meta.art} title={meta.emptyTitle} text={meta.empty} />}
        />
      )}
    </>
  );
}

function RetentionNote() {
  const days = useSystemSummary().data?.snapshot.trashRetentionDays;
  if (days === undefined) return null;
  return (
    <p className="pt-1 text-[13.5px] text-ink-3">
      {days > 0 ? `Items are deleted for good after ${days} day${days === 1 ? "" : "s"}. ` : "Items stay here until you delete them. "}
      Deleting forever removes them from Telegram right away.
    </p>
  );
}

function SearchView({ q }: { q: string }) {
  const { data, isFetching, error } = useSearch(q);
  useTitle(`“${q}”`);
  return (
    <>
      <ViewHeader
        title={
          <div className="min-w-0">
            <div className="label text-ink-3">Search</div>
            <h1 className="mt-1 flex items-center gap-3 truncate text-[28px] font-semibold leading-tight tracking-[-0.02em] text-ink">
              “{q}”{isFetching ? <span className="size-2.5 shrink-0 animate-blink bg-accent" /> : null}
            </h1>
          </div>
        }
      />
      {error ? (
        <ErrorState message={(error as Error).message} />
      ) : (
        <FileBrowser
          items={data?.items}
          loading={!data && isFetching}
          folderId={null}
          keepOrder
          empty={<Empty art={<EmptySearchArt />} title="No matches" text="Search matches any part of a name — try fewer letters or a file extension like “pdf”." />}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

export function PageTitle({ title, sub }: { title: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <h1 className="truncate text-[28px] font-semibold leading-tight tracking-[-0.02em] text-ink md:text-[32px]">{title}</h1>
      {sub ? <p className="mt-0.5 truncate text-[14px] text-ink-3">{sub}</p> : null}
    </div>
  );
}

function ViewHeader({ title, actions, note }: { title: ReactNode; actions?: ReactNode; note?: ReactNode }) {
  const selection = useUi((s) => s.selection);
  const viewMode = usePrefs((s) => s.viewMode);
  const setViewMode = usePrefs((s) => s.setViewMode);
  const detailsOpen = usePrefs((s) => s.detailsOpen);
  const toggleDetails = usePrefs((s) => s.toggleDetails);

  return (
    <div className="shrink-0 px-3 pt-4 md:px-5 md:pt-6">
      <div className="flex min-h-12 flex-wrap items-center gap-2">
        <div className="min-w-0 flex-[1_1_14rem] overflow-hidden">{title}</div>
        <div className="flex items-center gap-2">
          {actions}
          <div className="flex items-center border-[1.5px] border-line-strong">
            <button
              aria-label="List view"
              aria-pressed={viewMode === "list"}
              onClick={() => setViewMode("list")}
              className={cn("flex size-10 items-center justify-center transition-colors", viewMode === "list" ? "bg-invert text-on-invert" : "text-ink-2 hover:bg-surface-3")}
            >
              <List className="size-[17px]" />
            </button>
            <button
              aria-label="Grid view"
              aria-pressed={viewMode === "grid"}
              onClick={() => setViewMode("grid")}
              className={cn("flex size-10 items-center justify-center transition-colors", viewMode === "grid" ? "bg-invert text-on-invert" : "text-ink-2 hover:bg-surface-3")}
            >
              <LayoutGrid className="size-[17px]" />
            </button>
          </div>
          <IconButton label="Details" active={detailsOpen} onClick={toggleDetails} className="hidden lg:inline-flex">
            <Info />
          </IconButton>
        </div>
      </div>
      {note}
      <div className="mt-3 h-11">{selection.size ? <SelectionBar /> : <FilterChips />}</div>
    </div>
  );
}

const FILTERS: { key: TypeFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "folder", label: "Folders" },
  { key: "image", label: "Images" },
  { key: "video", label: "Videos" },
  { key: "audio", label: "Audio" },
  { key: "document", label: "Documents" },
  { key: "archive", label: "Archives" },
];

function FilterChips() {
  const filter = useUi((s) => s.typeFilter);
  const setFilter = useUi((s) => s.setTypeFilter);
  return (
    <div className="flex h-11 items-center gap-1.5 overflow-x-auto [scrollbar-width:none]" role="toolbar" aria-label="Filter by type">
      {FILTERS.map((f) => (
        <button
          key={f.key}
          onClick={() => setFilter(f.key)}
          aria-pressed={filter === f.key}
          className={cn(
            "h-9 shrink-0 border px-3.5 text-[13.5px] font-medium transition-colors",
            filter === f.key ? "border-line-strong bg-invert text-on-invert" : "border-line bg-surface text-ink-2 hover:border-line-strong hover:text-ink",
          )}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}

function SelectionBar() {
  const selection = useUi((s) => s.selection);
  const visible = useUi((s) => s.visible);
  const nodes = visible.filter((n) => selection.has(n.id));
  const inTrash = nodes.length > 0 && nodes.every((n) => n.trashedAt !== null);
  const ui = useUi.getState();
  const btn = "size-10 text-on-invert/75 hover:bg-on-invert/15 hover:text-on-invert";
  return (
    <div className="flex h-11 items-center gap-0.5 bg-invert pr-1.5 text-on-invert animate-pop-in" data-testid="selection-bar">
      <IconButton label="Clear selection" className={btn} onClick={() => ui.clearSelection()}>
        <X />
      </IconButton>
      <span className="mr-2 text-[14px] font-semibold tabular">{selection.size} selected</span>
      <span className="mx-1 hidden h-5 w-px bg-on-invert/25 sm:block" />
      <div className="ml-auto flex items-center sm:ml-0">
        {inTrash ? (
          <>
            <IconButton label="Restore" className={btn} onClick={() => void restoreNodes(nodes)}>
              <RotateCcw />
            </IconButton>
            <IconButton label="Delete forever" className={btn} onClick={() => ui.openDialog({ type: "deleteForever", nodes })}>
              <Flame />
            </IconButton>
          </>
        ) : (
          <>
            <IconButton label="Share" className={btn} onClick={() => ui.openDialog({ type: "share", nodes })}>
              <Share2 />
            </IconButton>
            <IconButton label="Copy link" className={cn(btn, "max-sm:hidden")} onClick={() => void quickLink(nodes)}>
              <Link2 />
            </IconButton>
            <IconButton label="Download" className={btn} onClick={() => void downloadNodes(nodes)}>
              <Download />
            </IconButton>
            <IconButton label="Move to…" className={cn(btn, "max-sm:hidden")} onClick={() => ui.openDialog({ type: "move", nodes })}>
              <FolderInput />
            </IconButton>
            <IconButton label="Move to trash" className={btn} onClick={() => void trashNodes(nodes)}>
              <Trash2 />
            </IconButton>
            <DropdownMenu.Root modal={false}>
              <DropdownMenu.Trigger asChild>
                <button className="ml-1 flex h-9 items-center gap-1 px-2.5 text-[14px] font-medium text-on-invert/80 hover:bg-on-invert/15 hover:text-on-invert">
                  More <ChevronDown className="size-4" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="menu-surface" align="end" sideOffset={6}>
                  <NodeMenuItems parts={DropdownMenu} nodes={nodes} inTrash={false} />
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </>
        )}
      </div>
    </div>
  );
}

function Breadcrumbs({ path, folderId }: { path: Crumb[]; folderId: string }) {
  const qc = useQueryClient();
  const [over, setOver] = useState<string | null>(null);
  const last = path[path.length - 1];
  const trail = path.slice(0, -1);
  // Long trails collapse to: first › … › parent.
  const shown = trail.length > 3 ? [trail[0], { id: "__more", name: "…" }, ...trail.slice(-1)] : trail;
  const parent = trail.at(-1) ?? null;

  const dropProps = (crumb: Crumb) => ({
    onDragOver: (e: React.DragEvent) => {
      if ((hasNodes(e.dataTransfer) || hasFiles(e.dataTransfer)) && crumb.id !== "__more") {
        e.preventDefault();
        setOver(crumb.id);
      }
    },
    onDragLeave: () => setOver(null),
    onDrop: async (e: React.DragEvent) => {
      setOver(null);
      e.preventDefault();
      if (hasNodes(e.dataTransfer)) {
        const ids = new Set(readNodeIds(e.dataTransfer));
        void moveNodes(useUi.getState().visible.filter((n) => ids.has(n.id)), crumb.id, crumb.id === "root" ? "My files" : crumb.name);
      } else {
        const { entries, dirs } = await collectDrop(e.dataTransfer);
        void enqueueUploads(entries, crumb.id, dirs, crumb.id === "root" ? "My files" : crumb.name);
      }
    },
  });
  const crumbName = (c: Crumb) => (c.id === "root" ? "My files" : c.name);

  return (
    <nav className="min-w-0" aria-label="Breadcrumb">
      {shown.length ? (
        <div className="mb-0.5 hidden min-w-0 items-center gap-0.5 text-[13.5px] text-ink-3 sm:flex">
          {shown.map((c) => (
            <span key={c.id} className="flex min-w-0 shrink items-center">
              {c.id === "__more" ? (
                <span className="px-1">…</span>
              ) : (
                <button
                  {...dropProps(c)}
                  onPointerEnter={() => void prefetchFolder(qc, c.id)}
                  onClick={() => navigate({ name: "folder", id: c.id })}
                  className={cn("max-w-[180px] truncate px-1 py-0.5 font-medium transition-colors hover:bg-surface-3 hover:text-ink", over === c.id && "bg-accent-soft text-ink shadow-[0_0_0_2px_var(--accent)]")}
                >
                  {crumbName(c)}
                </button>
              )}
              <ChevronRight className="size-3.5 shrink-0" />
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex min-w-0 items-center">
        {/* Phones: a back arrow to the parent folder instead of the trail. */}
        {parent ? (
          <button
            {...dropProps(parent)}
            aria-label={`Back to ${crumbName(parent)}`}
            onClick={() => navigate({ name: "folder", id: parent.id })}
            className="-ml-1.5 mr-1 flex size-9 shrink-0 items-center justify-center text-ink-2 hover:bg-surface-3 sm:hidden"
          >
            <ChevronLeft className="size-5" />
          </button>
        ) : null}
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger asChild>
            <button
              {...dropProps(last)}
              aria-label={`${crumbName(last)} — folder actions`}
              data-testid="crumb-menu"
              className={cn("-ml-1 flex min-w-0 items-center gap-1 px-1 transition-colors hover:bg-surface-3", over === last.id && "bg-accent-soft shadow-[0_0_0_2px_var(--accent)]")}
            >
              <h1 className="truncate text-[28px] font-semibold leading-tight tracking-[-0.02em] text-ink md:text-[32px]">{crumbName(last)}</h1>
              <ChevronDown className="size-5 shrink-0 text-ink-3" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="menu-surface" align="start" sideOffset={6}>
              <BackgroundMenuItems parts={DropdownMenu} folderId={folderId} folderName={crumbName(last)} />
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </nav>
  );
}

export function Empty({ art, title, text, action }: { art: ReactNode; title: string; text: string; action?: ReactNode }) {
  return (
    <div className="flex max-w-md flex-col items-center text-center">
      <div className="mb-6 animate-rise">{art}</div>
      <h2 className="text-[24px] font-semibold tracking-[-0.02em] text-ink animate-rise [animation-delay:60ms]">{title}</h2>
      <p className="mt-2 text-[15px] leading-relaxed text-ink-2 animate-rise [animation-delay:120ms]">{text}</p>
      {action ? <div className="mt-7 animate-rise [animation-delay:180ms]">{action}</div> : null}
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <Empty art={<LostSignalArt />} title="Couldn’t load this view" text={message} />
    </div>
  );
}
