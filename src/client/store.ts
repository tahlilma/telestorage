"use client";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ConflictPolicy, DriveNode, Share } from "@/lib/types";

export type SortKey = "name" | "updatedAt" | "size" | "type";
export type TypeFilter = "all" | "folder" | "image" | "video" | "audio" | "document" | "archive";
export type DialogState =
  | { type: "newFolder"; parentId: string }
  | { type: "rename"; node: DriveNode }
  | { type: "move" | "copy"; nodes: DriveNode[] }
  | { type: "share"; nodes: DriveNode[] }
  | { type: "editShare"; share: Share }
  | { type: "deleteForever"; nodes: DriveNode[] }
  | { type: "emptyTrash" }
  | { type: "shortcuts" }
  | { type: "versions"; node: DriveNode }
  | { type: "color"; nodes: DriveNode[] }
  | { type: "request"; folder: DriveNode }
  | { type: "receive"; files: File[] }
  | { type: "editRequest"; share: Share };

/** Files of an upload whose names are already taken; the upload waits for the answer. */
export interface ConflictPrompt {
  folderName: string;
  items: { path: string; size: number; existingSize: number; existingAt: number }[];
  resolve: (policy: ConflictPolicy | null) => void;
}

interface PrefsState {
  viewMode: "grid" | "list";
  sort: { key: SortKey; dir: "asc" | "desc" };
  theme: "system" | "light" | "dark";
  detailsOpen: boolean;
  /** Newest activity the user has seen (drives the bell's dot). */
  activitySeenAt: number;
  markActivitySeen: (at: number) => void;
  setViewMode: (m: "grid" | "list") => void;
  setSort: (key: SortKey) => void;
  setTheme: (t: "system" | "light" | "dark") => void;
  toggleDetails: () => void;
}

export const usePrefs = create<PrefsState>()(
  persist(
    (set, get) => ({
      viewMode: "grid",
      sort: { key: "name", dir: "asc" },
      theme: "system",
      detailsOpen: false,
      activitySeenAt: 0,
      markActivitySeen: (at) => set({ activitySeenAt: Math.max(get().activitySeenAt, at) }),
      setViewMode: (viewMode) => set({ viewMode }),
      setSort: (key) => {
        const cur = get().sort;
        set({ sort: { key, dir: cur.key === key && cur.dir === "asc" ? "desc" : key === "name" || key === "type" ? "asc" : "desc" } });
      },
      setTheme: (theme) => {
        set({ theme });
        applyTheme(theme);
      },
      toggleDetails: () => set({ detailsOpen: !get().detailsOpen }),
    }),
    { name: "ts-prefs", partialize: (s) => ({ viewMode: s.viewMode, sort: s.sort, theme: s.theme, detailsOpen: s.detailsOpen, activitySeenAt: s.activitySeenAt }) },
  ),
);

export function applyTheme(theme: "system" | "light" | "dark") {
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

interface UiState {
  selection: Set<string>;
  anchor: string | null;
  /** The items currently on screen in display order (for shift-select, preview paging, select all). */
  visible: DriveNode[];
  preview: { id: string } | null;
  dialog: DialogState | null;
  clipboard: { op: "cut" | "copy"; nodes: DriveNode[] } | null;
  mobileNavOpen: boolean;
  /** Touch: long-press started selecting; taps now toggle instead of opening. */
  selecting: boolean;
  conflict: ConflictPrompt | null;
  /** Phone: the bottom sheet with an item's actions. */
  actions: { nodes: DriveNode[]; inTrash: boolean } | null;
  openActions: (nodes: DriveNode[], inTrash: boolean) => void;
  closeActions: () => void;
  askConflict: (c: Omit<ConflictPrompt, "resolve">) => Promise<ConflictPolicy | null>;
  typeFilter: TypeFilter;
  /** A node to select and scroll to once it appears in a listing ("locate" from the departures board). */
  reveal: { id: string; until: number } | null;
  revealNode: (id: string | null) => void;
  setTypeFilter: (f: TypeFilter) => void;
  setVisible: (nodes: DriveNode[]) => void;
  select: (id: string, mode: "single" | "toggle" | "range") => void;
  setSelection: (ids: Iterable<string>) => void;
  clearSelection: () => void;
  openPreview: (id: string) => void;
  closePreview: () => void;
  openDialog: (d: DialogState) => void;
  closeDialog: () => void;
  setClipboard: (c: UiState["clipboard"]) => void;
  setMobileNav: (open: boolean) => void;
  /** Touch: enter selection mode with this item selected. */
  startSelecting: (id: string) => void;
  /** The command palette (Ctrl/⌘ K). */
  paletteOpen: boolean;
  setPalette: (open: boolean) => void;
}

export const useUi = create<UiState>()((set, get) => ({
  selection: new Set(),
  anchor: null,
  visible: [],
  preview: null,
  dialog: null,
  clipboard: null,
  mobileNavOpen: false,
  selecting: false,
  conflict: null,
  actions: null,
  paletteOpen: false,
  setPalette: (paletteOpen) => set({ paletteOpen }),
  openActions: (nodes, inTrash) => set({ actions: { nodes, inTrash } }),
  closeActions: () => set({ actions: null }),
  askConflict: (c) =>
    new Promise((resolve) => {
      get().conflict?.resolve(null); // a newer prompt supersedes an unanswered one
      set({
        conflict: {
          ...c,
          resolve: (policy) => {
            set({ conflict: null });
            resolve(policy);
          },
        },
      });
    }),
  typeFilter: "all",
  reveal: null,
  revealNode: (id) => set({ reveal: id ? { id, until: Date.now() + 10_000 } : null }),
  setTypeFilter: (typeFilter) => set({ typeFilter, selection: new Set(), anchor: null }),
  setVisible: (visible) => {
    const ids = new Set(visible.map((n) => n.id));
    const sel = get().selection;
    // Drop selected ids that left the view.
    const kept = [...sel].filter((id) => ids.has(id));
    set(kept.length === sel.size ? { visible } : { visible, selection: new Set(kept) });
  },
  select: (id, mode) => {
    const { selection, anchor, visible } = get();
    if (mode === "single") return set({ selection: new Set([id]), anchor: id });
    if (mode === "toggle") {
      const next = new Set(selection);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return set({ selection: next, anchor: id, selecting: get().selecting && next.size > 0 });
    }
    const order = visible.map((n) => n.id);
    const a = anchor ? order.indexOf(anchor) : -1;
    const b = order.indexOf(id);
    if (a < 0 || b < 0) return set({ selection: new Set([id]), anchor: id });
    const [lo, hi] = a < b ? [a, b] : [b, a];
    set({ selection: new Set(order.slice(lo, hi + 1)) });
  },
  setSelection: (ids) => {
    const selection = new Set(ids);
    set({ selection, selecting: get().selecting && selection.size > 0 });
  },
  clearSelection: () => (get().selection.size || get().selecting ? set({ selection: new Set(), anchor: null, selecting: false }) : undefined),
  openPreview: (id) => set({ preview: { id } }),
  closePreview: () => set({ preview: null }),
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),
  setClipboard: (clipboard) => set({ clipboard }),
  setMobileNav: (mobileNavOpen) => set({ mobileNavOpen }),
  startSelecting: (id) => set({ selecting: true, selection: new Set([...get().selection, id]), anchor: id }),
}));

export function selectedNodes(): DriveNode[] {
  const { selection, visible } = useUi.getState();
  return visible.filter((n) => selection.has(n.id));
}
