"use client";
import {
  Bell,
  Clock,
  FolderOpen,
  FolderPlus,
  FolderUp,
  HardDrive,
  Home,
  Images,
  Keyboard,
  LogOut,
  Monitor,
  Moon,
  MoreHorizontal,
  Plus,
  Search,
  ShieldOff,
  Activity as Pulse,
  Link2,
  Star,
  Sun,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { motion } from "motion/react";
import { Dialog, DropdownMenu } from "radix-ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { formatBytes, plural } from "@/lib/format";
import type { BotStatus } from "@/lib/types";
import { moveNodes, signOut } from "../actions";
import { collectDrop, hasFiles, hasNodes, readNodeIds } from "../dnd";
import { withViewTransition } from "../hooks";
import { openPicker } from "../pickers";
import { useActivity, useHome, useSearch, useSystemSummary } from "../queries";
import { navigate, sameRoute, type DriveRoute } from "../router";
import { usePrefs, useUi } from "../store";
import { useLive } from "../sync";
import { enqueueUploads } from "../upload/engine";
import { ActivityList } from "./ActivityFeed";
import { Logo, Mark } from "./Brand";
import { RoomLeft } from "./Capacity";
import { openNode } from "./menus";
import { TypeIcon } from "./NodeVisual";
import { cn, IconButton, Kbd, Tooltip } from "./ui";

export { Logo };

interface NavEntry {
  route: DriveRoute;
  label: string;
  icon: ReactNode;
  count?: number;
}

function useNav(): NavEntry[] {
  const { data: home } = useHome();
  return [
    { route: { name: "home" }, label: "Home", icon: <Home /> },
    { route: { name: "folder", id: "root" }, label: "My files", icon: <FolderOpen /> },
    { route: { name: "photos" }, label: "Photos", icon: <Images /> },
    { route: { name: "recent" }, label: "Recent", icon: <Clock /> },
    { route: { name: "starred" }, label: "Starred", icon: <Star /> },
    { route: { name: "shared" }, label: "Shared links", icon: <Link2 />, count: home?.stats.shares || undefined },
    { route: { name: "trash" }, label: "Trash", icon: <Trash2 /> },
  ];
}

/** Upload / folder upload / new folder, from anywhere (non-folder views upload into My files). */
function NewMenuItems({ folderId }: { folderId: string }) {
  return (
    <>
      <DropdownMenu.Item className="menu-item" onSelect={() => openPicker("files", folderId)}>
        <Upload /> Upload files
      </DropdownMenu.Item>
      <DropdownMenu.Item className="menu-item" onSelect={() => openPicker("folder", folderId)}>
        <FolderUp /> Upload a folder
      </DropdownMenu.Item>
      <DropdownMenu.Separator className="menu-sep" />
      <DropdownMenu.Item className="menu-item" onSelect={() => useUi.getState().openDialog({ type: "newFolder", parentId: folderId })}>
        <FolderPlus /> New folder
      </DropdownMenu.Item>
    </>
  );
}

function NavItem({ entry, active, onNavigate }: { entry: NavEntry; active: boolean; onNavigate?: () => void }) {
  const [over, setOver] = useState(false);
  const isFiles = entry.route.name === "folder";
  return (
    <button
      onClick={() => {
        navigate(entry.route);
        onNavigate?.();
      }}
      aria-current={active ? "page" : undefined}
      onDragOver={(e) => {
        if (isFiles && (hasNodes(e.dataTransfer) || hasFiles(e.dataTransfer))) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={async (e) => {
        setOver(false);
        if (!isFiles) return;
        e.preventDefault();
        if (hasNodes(e.dataTransfer)) {
          const ids = new Set(readNodeIds(e.dataTransfer));
          void moveNodes(useUi.getState().visible.filter((n) => ids.has(n.id)), "root", "My files");
        } else {
          const { entries, dirs } = await collectDrop(e.dataTransfer);
          void enqueueUploads(entries, "root", dirs, "My files");
        }
      }}
      className={cn(
        "relative flex h-11 w-full items-center gap-3 px-3.5 text-[15px] font-medium transition-colors [&_svg]:size-[18px]",
        active ? "text-on-invert" : "text-ink-2 hover:bg-surface-3 hover:text-ink",
        over && "bg-accent-soft text-ink shadow-[inset_0_0_0_2px_var(--accent)]",
      )}
    >
      {active ? <motion.span layoutId="nav-active" className="absolute inset-0 bg-invert" transition={{ type: "spring", stiffness: 520, damping: 40 }} /> : null}
      <span className="relative flex items-center gap-3">
        {entry.icon}
        {entry.label}
      </span>
      {entry.count ? <span className={cn("relative ml-auto text-[12.5px] tabular", active ? "text-on-invert/70" : "text-ink-3")}>{entry.count}</span> : null}
    </button>
  );
}

function botTone(b: BotStatus): { color: string; label: string } {
  if (b.state === "error") return { color: "var(--danger)", label: "offline" };
  if (b.state === "connecting") return { color: "var(--ink-3)", label: "connecting" };
  if (b.floodWaitUntil > Date.now()) return { color: "var(--warning)", label: "rate-limited" };
  return { color: "var(--success)", label: "online" };
}

function StorageCard() {
  const { data } = useSystemSummary();
  const s = data?.snapshot;
  return (
    <button onClick={() => navigate({ name: "storage" })} className="lift group w-full border border-line bg-surface p-4 text-left" data-testid="storage-card">
      <div className="flex items-center justify-between">
        <span className="label text-ink-3">Storage</span>
        <span className="text-[12px] font-medium text-ink-3 group-hover:text-accent">Details →</span>
      </div>
      {s ? (
        <>
          <div className="mt-2 text-[26px] font-semibold leading-none tracking-[-0.02em] text-ink tabular">{formatBytes(s.storage.logicalBytes)}</div>
          <div className="mt-1.5 text-[12.5px] text-ink-3 tabular">
            {s.storage.files.toLocaleString()} file{s.storage.files === 1 ? "" : "s"}
            {s.driver === "telegram" ? ` · ${s.storage.parts.toLocaleString()} post${s.storage.parts === 1 ? "" : "s"}` : ""}
          </div>
          {s.storage.capacity ? <RoomLeft cap={s.storage.capacity} /> : null}
          {s.bots.length ? (
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
              {s.bots.map((b) => {
                const t = botTone(b);
                return (
                  <Tooltip key={b.id} label={`${b.username || `bot ${b.id}`}: ${t.label}`} side="top">
                    <span className="flex items-center gap-1.5 text-[12px] text-ink-3">
                      <span className="size-2" style={{ background: t.color }} />
                      bot {b.index + 1}
                    </span>
                  </Tooltip>
                );
              })}
            </div>
          ) : (
            <div className="mt-3 text-[12px] text-ink-3">{s.driver === "local" ? "Local disk (no Telegram configured)" : "Simulated bots (test mode)"}</div>
          )}
        </>
      ) : (
        <div className="skeleton mt-3 h-14" />
      )}
    </button>
  );
}

export function Sidebar({ route }: { route: DriveRoute | null }) {
  const nav = useNav();
  const folderId = route?.name === "folder" ? route.id : "root";
  return (
    <aside className="flex h-full w-[264px] shrink-0 flex-col border-r border-line bg-canvas px-4 pb-4">
      <div className="flex h-[72px] items-center px-1">
        <button onClick={() => navigate({ name: "home" })} aria-label="Telestorage home">
          <Logo />
        </button>
      </div>
      <div className="mb-5 flex gap-2">
        <button
          onClick={() => openPicker("files", folderId)}
          data-testid="sidebar-upload"
          className="flex h-12 flex-1 items-center justify-center gap-2 bg-invert text-[15px] font-semibold text-on-invert transition-[background-color,color,transform] hover:bg-accent hover:text-on-accent active:translate-y-px"
        >
          <Upload className="size-[18px]" strokeWidth={2.4} /> Upload
        </button>
        <DropdownMenu.Root modal={false}>
          <Tooltip label="New folder / upload a folder" side="right">
            <DropdownMenu.Trigger asChild>
              <button aria-label="More: new folder or folder upload" className="flex size-12 items-center justify-center border-[1.5px] border-line-strong text-ink transition hover:bg-invert hover:text-on-invert">
                <Plus className="size-5" />
              </button>
            </DropdownMenu.Trigger>
          </Tooltip>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="menu-surface" align="start" sideOffset={8}>
              <NewMenuItems folderId={folderId} />
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      <nav className="space-y-0.5" aria-label="Sections">
        {nav.map((n) => (
          <NavItem key={n.label} entry={n} active={sameRoute(route, n.route)} />
        ))}
      </nav>
      <div className="mt-auto space-y-3 pt-6">
        <StorageCard />
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export const searchInputRef: { current: HTMLInputElement | null } = { current: null };

function SearchBox({ route, autoFocus, onDone }: { route: DriveRoute | null; autoFocus?: boolean; onDone?: () => void }) {
  const [q, setQ] = useState(route?.name === "search" ? route.q : "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const debounced = useDebounced(q.trim(), 120);
  const { data, isFetching } = useSearch(debounced, open);
  const results = (data?.items ?? []).slice(0, 8);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchInputRef.current = inputRef.current;
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const submit = () => {
    if (!q.trim()) return;
    setOpen(false);
    inputRef.current?.blur();
    navigate({ name: "search", q: q.trim() });
    onDone?.();
  };

  return (
    <div className="relative w-full max-w-[640px]">
      <div className={cn("flex h-11 items-center gap-1 border-[1.5px] border-line-strong bg-surface px-1.5 transition-shadow focus-within:shadow-hard-sm")}>
        <IconButton label="Search" tooltip={false} onClick={submit} className="size-8">
          <Search />
        </IconButton>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(results.length, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter") {
              if (active > 0 && results[active - 1]) {
                const n = results[active - 1];
                setOpen(false);
                inputRef.current?.blur();
                openNode(n);
                onDone?.();
              } else submit();
            } else if (e.key === "Escape") {
              setOpen(false);
              inputRef.current?.blur();
              onDone?.();
            }
          }}
          placeholder="Search your files…"
          className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-3"
          aria-label="Search your files"
          enterKeyHint="search"
        />
        {q ? (
          <IconButton
            label="Clear search"
            tooltip={false}
            className="size-8"
            onClick={() => {
              setQ("");
              inputRef.current?.focus();
            }}
          >
            <X />
          </IconButton>
        ) : (
          <span className="mr-2 hidden sm:block">
            <Kbd>/</Kbd>
          </span>
        )}
      </div>
      {open && debounced && results.length ? (
        <div className="absolute inset-x-0 top-[calc(100%+6px)] z-40 border-[1.5px] border-line-strong bg-surface pb-1 shadow-hard animate-pop-in">
          {results.map((n, i) => (
            <button
              key={n.id}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i + 1)}
              onClick={() => {
                setOpen(false);
                inputRef.current?.blur();
                openNode(n);
                onDone?.();
              }}
              className={cn("flex h-12 w-full items-center gap-3 px-3 text-left text-[14.5px]", active === i + 1 ? "bg-surface-3" : "")}
            >
              <TypeIcon node={n} className="size-7" />
              <span className="truncate font-medium">{n.name}</span>
              <span className="ml-auto shrink-0 text-[12px] text-ink-3 tabular">{n.kind === "folder" ? plural(n.childCount ?? 0, "item") : formatBytes(n.size)}</span>
            </button>
          ))}
          <button onMouseDown={(e) => e.preventDefault()} onClick={submit} className="flex h-11 w-full items-center gap-3 border-t border-line px-3 text-left text-[14px] font-semibold text-accent">
            <Search className="size-4" /> See all results for “{q.trim()}”
            {isFetching ? <span className="ml-auto size-2 animate-blink bg-accent" /> : null}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function LiveDot() {
  const live = useLive((s) => s.live);
  return (
    <Tooltip label={live ? "Live: changes from your other tabs and devices appear instantly" : "Reconnecting…"}>
      <span className="hidden h-9 items-center gap-2 px-2 text-[12.5px] font-medium text-ink-3 lg:inline-flex" data-testid="live-badge">
        <span className={cn("size-2", live ? "animate-blink bg-success" : "bg-ink-3")} />
        {live ? "Live" : "Offline"}
      </span>
    </Tooltip>
  );
}

export function ThemeButton({ className }: { className?: string }) {
  const theme = usePrefs((s) => s.theme);
  const setTheme = usePrefs((s) => s.setTheme);
  const next = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  const name = theme === "system" ? "Auto" : theme === "light" ? "Light" : "Dark";
  return (
    <IconButton label={`Theme: ${name}`} className={className} onClick={() => withViewTransition(() => setTheme(next))}>
      {theme === "system" ? <Monitor /> : theme === "light" ? <Sun /> : <Moon />}
    </IconButton>
  );
}

/** The bell: what happened lately (uploads, deletions, links opened…). */
function ActivityBell() {
  const [open, setOpen] = useState(false);
  const { data } = useActivity(true);
  const seen = usePrefs((s) => s.activitySeenAt);
  const latest = data?.items[0]?.at ?? 0;
  const unread = latest > seen;
  return (
    <DropdownMenu.Root
      modal={false}
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o && latest) usePrefs.getState().markActivitySeen(latest);
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button aria-label={unread ? "Activity (new)" : "Activity"} data-testid="activity-bell" className="relative flex size-10 items-center justify-center text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink data-[state=open]:bg-invert data-[state=open]:text-on-invert">
          <Bell className="size-[19px]" />
          {unread ? <span className="absolute right-2 top-2 size-2.5 border-2 border-canvas bg-accent" /> : null}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu-surface w-[min(400px,calc(100vw-24px))] p-0" align="end" sideOffset={8}>
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <span className="text-[15px] font-semibold text-ink">Activity</span>
            <span className="text-[12px] text-ink-3">Live</span>
          </div>
          <div className="max-h-[min(460px,70dvh)] overflow-y-auto">
            <ActivityList items={data?.items.slice(0, 30)} compact onNavigate={() => setOpen(false)} />
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function AccountMenu() {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button aria-label="Account" className="ml-1 flex size-10 items-center justify-center bg-accent text-[15px] font-semibold text-on-accent transition hover:shadow-hard-sm data-[state=open]:shadow-hard-sm">
          T
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu-surface min-w-[260px]" align="end" sideOffset={8}>
          <div className="px-3 pb-2 pt-1.5">
            <div className="text-[14.5px] font-semibold text-ink">Owner</div>
            <div className="text-[12.5px] text-ink-3">Signed in with your password</div>
          </div>
          <DropdownMenu.Separator className="menu-sep" />
          <DropdownMenu.Item className="menu-item" onSelect={() => navigate({ name: "system" })}>
            <Pulse /> System status
          </DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item" onSelect={() => useUi.getState().openDialog({ type: "shortcuts" })}>
            <Keyboard /> Keyboard shortcuts
            <span className="menu-shortcut">?</span>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="menu-sep" />
          <DropdownMenu.Item className="menu-item" onSelect={() => void signOut()}>
            <LogOut /> Sign out
          </DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item danger" onSelect={() => void signOut(true)}>
            <ShieldOff /> Sign out everywhere
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function TopBar({ route }: { route: DriveRoute | null }) {
  const [searching, setSearching] = useState(false);
  return (
    <header className="flex h-[68px] shrink-0 items-center gap-2 border-b border-line bg-canvas px-3 md:gap-4 md:px-6">
      {/* Phones: mark + expandable search. */}
      <button className="md:hidden" onClick={() => navigate({ name: "home" })} aria-label="Telestorage home">
        <Mark className="size-9" />
      </button>
      <div className="hidden min-w-0 flex-1 md:block">
        <SearchBox key={route?.name === "search" ? route.q : "q"} route={route} />
      </div>
      <div className="flex-1 md:hidden" />
      <div className="flex items-center gap-0.5">
        <IconButton label="Search" className="md:hidden" onClick={() => setSearching(true)}>
          <Search />
        </IconButton>
        <LiveDot />
        <ActivityBell />
        <ThemeButton className="hidden sm:inline-flex" />
        <AccountMenu />
      </div>
      {searching ? (
        <div className="fixed inset-x-0 top-0 z-50 flex h-[68px] items-center gap-2 border-b-[1.5px] border-line-strong bg-canvas px-3 animate-fade-in md:hidden">
          <SearchBox route={route} autoFocus onDone={() => setSearching(false)} />
          <IconButton label="Close search" onClick={() => setSearching(false)}>
            <X />
          </IconButton>
        </div>
      ) : null}
    </header>
  );
}

// ---------------------------------------------------------------------------
// Phones: bottom tab bar with a raised upload button, and the "More" sheet
// ---------------------------------------------------------------------------

export function BottomNav({ route }: { route: DriveRoute | null }) {
  const [more, setMore] = useState(false);
  const folderId = route?.name === "folder" ? route.id : "root";
  const tab = (r: DriveRoute, label: string, icon: ReactNode) => {
    const active = sameRoute(route, r);
    return (
      <button
        onClick={() => navigate(r)}
        aria-current={active ? "page" : undefined}
        className={cn("relative flex flex-1 flex-col items-center justify-center gap-1 text-[11.5px] font-medium [&_svg]:size-[21px]", active ? "text-ink" : "text-ink-3")}
      >
        {active ? <motion.span layoutId="tab-active" className="absolute inset-x-4 top-0 h-[3px] bg-accent" transition={{ type: "spring", stiffness: 520, damping: 40 }} /> : null}
        {icon}
        {label}
      </button>
    );
  };
  const nav = useNav();
  return (
    <>
      <nav className="relative z-30 flex h-16 shrink-0 border-t-[1.5px] border-line-strong bg-canvas safe-bottom md:hidden" aria-label="Sections">
        {tab({ name: "home" }, "Home", <Home />)}
        {tab({ name: "folder", id: "root" }, "Files", <FolderOpen />)}
        <div className="flex flex-1 items-start justify-center">
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <button aria-label="Upload or create" data-testid="fab" className="-mt-5 flex size-14 items-center justify-center bg-accent text-on-accent shadow-hard transition-transform active:translate-x-0.5 active:translate-y-0.5 active:shadow-none">
                <Plus className="size-7" strokeWidth={2.5} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="menu-surface" side="top" align="center" sideOffset={12}>
                <NewMenuItems folderId={folderId} />
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
        {tab({ name: "shared" }, "Shared", <Link2 />)}
        <button onClick={() => setMore(true)} className="flex flex-1 flex-col items-center justify-center gap-1 text-[11.5px] font-medium text-ink-3 [&_svg]:size-[21px]" aria-label="More">
          <MoreHorizontal />
          More
        </button>
      </nav>
      <Dialog.Root open={more} onOpenChange={setMore}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-[#0b0b0b]/45 animate-fade-in md:hidden" />
          <Dialog.Content className="fixed inset-x-0 bottom-0 z-50 border-t-[1.5px] border-line-strong bg-canvas px-3 pb-4 pt-2 outline-none animate-slide-up safe-bottom md:hidden">
            <Dialog.Title className="sr-only">More</Dialog.Title>
            <Dialog.Description className="sr-only">Other sections and settings</Dialog.Description>
            <div className="mx-auto mb-2 h-1.5 w-12 bg-line" />
            <div className="space-y-0.5">
              {nav
                .filter((n) => n.route.name !== "home" && n.route.name !== "shared")
                .map((n) => (
                  <NavItem key={n.label} entry={n} active={sameRoute(route, n.route)} onNavigate={() => setMore(false)} />
                ))}
              <NavItem entry={{ route: { name: "storage" }, label: "Storage", icon: <HardDrive /> }} active={route?.name === "storage"} onNavigate={() => setMore(false)} />
              <NavItem entry={{ route: { name: "system" }, label: "System status", icon: <Pulse /> }} active={route?.name === "system"} onNavigate={() => setMore(false)} />
            </div>
            <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
              <span className="text-[14px] text-ink-2">Theme</span>
              <ThemeButton />
            </div>
            <div className="mt-3">
              <StorageCard />
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
