"use client";
import {
  Clock,
  CornerDownLeft,
  FolderOpen,
  FolderPlus,
  FolderUp,
  HardDrive,
  Home,
  Images,
  Keyboard,
  LayoutGrid,
  Link2,
  LogOut,
  Moon,
  Activity as Pulse,
  Search,
  Star,
  Trash2,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DriveNode } from "@/lib/types";
import { signOut } from "../actions";
import { openPicker } from "../pickers";
import { useSearch } from "../queries";
import { navigate, useRoute } from "../router";
import { usePrefs, useUi } from "../store";
import { FolderGlyph, NodeThumb, TypeIcon } from "./NodeVisual";
import { cn, Kbd } from "./ui";

/**
 * Command palette (Ctrl/⌘ K): go anywhere, do anything, or find any file —
 * without leaving the keyboard. Commands match fuzzily (initials work: "nf"
 * finds "New folder"); files come from the full-text index as you type.
 */

interface Command {
  id: string;
  group: "Go to" | "Actions";
  label: string;
  icon: LucideIcon;
  keywords?: string;
  shortcut?: string[];
  run: () => void;
}

/** Subsequence score: consecutive matches and word starts count more. -1 = no match. */
function score(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  if (t.startsWith(q)) return 1000 - t.length;
  if (t.includes(q)) return 500 - t.indexOf(q);
  let s = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    const wordStart = found === 0 || /[\s/_.-]/.test(t[found - 1]);
    streak = found === ti ? streak + 1 : 0;
    s += 10 + streak * 5 + (wordStart ? 15 : 0) - (found - ti);
    ti = found + 1;
  }
  return s;
}

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPalette);

  // Ctrl/⌘ K anywhere (even while typing in a field) toggles the palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        useUi.getState().setPalette(!useUi.getState().paletteOpen);
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[#0b0b0b]/40 animate-fade-in" />
        <Dialog.Content
          className="fixed inset-x-2 top-2 z-50 mx-auto max-w-[640px] border-[1.5px] border-line-strong bg-surface shadow-hard outline-none animate-pop-in md:top-[12vh]"
          aria-describedby={undefined}
          data-testid="command-palette"
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          {open ? <Palette onClose={() => setOpen(false)} /> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type Result = { key: string; group: string; label: ReactNode; text: string; icon: ReactNode; hint?: ReactNode; run: () => void };

function Palette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const route = useRoute();
  const folderId = route?.name === "folder" ? route.id : "root";
  const { data: found } = useSearch(q.trim(), q.trim().length >= 2);

  const commands = useMemo<Command[]>(() => {
    const go = (r: Parameters<typeof navigate>[0]) => () => navigate(r);
    const prefs = usePrefs.getState();
    return [
      { id: "home", group: "Go to", label: "Home", icon: Home, run: go({ name: "home" }) },
      { id: "files", group: "Go to", label: "My files", icon: FolderOpen, keywords: "drive root", run: go({ name: "folder", id: "root" }) },
      { id: "photos", group: "Go to", label: "Photos", icon: Images, keywords: "pictures videos gallery timeline", run: go({ name: "photos" }) },
      { id: "recent", group: "Go to", label: "Recent", icon: Clock, run: go({ name: "recent" }) },
      { id: "starred", group: "Go to", label: "Starred", icon: Star, keywords: "favorites", run: go({ name: "starred" }) },
      { id: "shared", group: "Go to", label: "Shared links", icon: Link2, keywords: "share requests", run: go({ name: "shared" }) },
      { id: "storage", group: "Go to", label: "Storage", icon: HardDrive, keywords: "space usage biggest largest quota", run: go({ name: "storage" }) },
      { id: "trash", group: "Go to", label: "Trash", icon: Trash2, keywords: "bin deleted", run: go({ name: "trash" }) },
      { id: "system", group: "Go to", label: "System status", icon: Pulse, keywords: "dashboard bots health stats", run: go({ name: "system" }) },
      { id: "upload", group: "Actions", label: "Upload files", icon: Upload, shortcut: ["⇧", "U"], run: () => openPicker("files", folderId) },
      { id: "upload-folder", group: "Actions", label: "Upload a folder", icon: FolderUp, run: () => openPicker("folder", folderId) },
      { id: "new-folder", group: "Actions", label: "New folder", icon: FolderPlus, shortcut: ["⇧", "N"], run: () => useUi.getState().openDialog({ type: "newFolder", parentId: folderId }) },
      {
        id: "theme",
        group: "Actions",
        label: "Switch theme",
        icon: Moon,
        keywords: "dark light mode",
        run: () => prefs.setTheme(prefs.theme === "dark" ? "light" : prefs.theme === "light" ? "system" : "dark"),
      },
      { id: "view", group: "Actions", label: "Grid or list view", icon: LayoutGrid, keywords: "layout", shortcut: ["V"], run: () => prefs.setViewMode(prefs.viewMode === "grid" ? "list" : "grid") },
      { id: "shortcuts", group: "Actions", label: "Keyboard shortcuts", icon: Keyboard, shortcut: ["?"], run: () => useUi.getState().openDialog({ type: "shortcuts" }) },
      { id: "signout", group: "Actions", label: "Sign out", icon: LogOut, keywords: "log out", run: () => void signOut() },
    ];
  }, [folderId]);

  const results = useMemo<Result[]>(() => {
    const query = q.trim();
    const cmd = commands
      .map((c) => ({ c, s: Math.max(score(query, c.label), score(query, c.keywords ?? "") - 50) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => (query ? b.s - a.s : 0))
      .slice(0, query ? 6 : commands.length)
      .map(
        ({ c }): Result => ({
          key: c.id,
          group: c.group,
          label: c.label,
          text: c.label,
          icon: <c.icon className="size-[18px]" />,
          hint: c.shortcut ? (
            <span className="flex gap-1">
              {c.shortcut.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </span>
          ) : null,
          run: c.run,
        }),
      );
    const items = (found?.items ?? []).slice(0, 8).map(
      (n): Result => ({
        key: `n-${n.id}`,
        group: n.kind === "folder" ? "Folders" : "Files",
        label: n.name,
        text: n.name,
        icon: n.kind === "folder" ? <FolderGlyph className="size-[18px]" /> : n.hasThumb ? <NodeThumb node={n} className="size-7" /> : <TypeIcon node={n} className="size-7" />,
        hint: <span className="text-[12px] text-ink-3">{n.kind === "folder" ? "Open folder" : "Preview"}</span>,
        run: () => openNodeFromPalette(n, found?.items ?? []),
      }),
    );
    // Files first when a search is under way; commands first otherwise.
    return query.length >= 2 ? [...items, ...cmd] : cmd;
  }, [q, commands, found]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (r: Result | undefined) => {
    if (!r) return;
    onClose();
    // After the dialog closes, so dialogs/pickers it opens aren't swallowed.
    setTimeout(r.run, 0);
  };

  let lastGroup = "";
  return (
    <div
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActive((a) => Math.min(results.length - 1, a + 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setActive((a) => Math.max(0, a - 1));
        } else if (e.key === "Enter") {
          e.preventDefault();
          run(results[active]);
        }
      }}
    >
      <div className="flex items-center gap-3 border-b-[1.5px] border-line-strong px-4">
        <Search className="size-5 shrink-0 text-ink-3" />
        <input
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          placeholder="Search files, go to a page, or run a command…"
          aria-label="Command"
          className="h-14 min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-ink-3"
          data-testid="palette-input"
        />
        <Kbd>Esc</Kbd>
      </div>
      <div ref={listRef} className="max-h-[min(60dvh,460px)] overflow-y-auto p-1.5" role="listbox" aria-label="Results">
        {results.length ? (
          results.map((r, i) => {
            const header = r.group !== lastGroup ? r.group : null;
            lastGroup = r.group;
            return (
              <div key={r.key}>
                {header ? <div className="label px-2.5 pb-1 pt-2.5 text-ink-3">{header}</div> : null}
                <button
                  role="option"
                  aria-selected={i === active}
                  data-index={i}
                  data-testid="palette-item"
                  onMouseMove={() => setActive(i)}
                  onClick={() => run(r)}
                  className={cn("flex h-11 w-full items-center gap-3 px-2.5 text-left text-[14.5px] transition-colors", i === active ? "bg-invert text-on-invert" : "text-ink")}
                >
                  <span className={cn("flex size-7 shrink-0 items-center justify-center overflow-hidden", i === active ? "text-on-invert" : "text-ink-2")}>{r.icon}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{r.label}</span>
                  {i === active ? <CornerDownLeft className="size-4 opacity-70" /> : r.hint}
                </button>
              </div>
            );
          })
        ) : (
          <p className="px-3 py-8 text-center text-[14px] text-ink-3">Nothing matches “{q}”.</p>
        )}
      </div>
    </div>
  );
}

function openNodeFromPalette(n: DriveNode, list: DriveNode[]) {
  if (n.kind === "folder") return navigate({ name: "folder", id: n.id });
  useUi.getState().setVisible(list.filter((x) => x.kind === "file"));
  useUi.getState().openPreview(n.id);
}
