"use client";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import dynamic from "next/dynamic";
import { Tooltip } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import { downloadNodes, paste, setStarred, trashNodes } from "../actions";
import { entriesFromInput } from "../dnd";
import { useIsMobile } from "../hooks";
import { folderNameOf, openPicker, pickerTarget, registerPickers } from "../pickers";
import { QueryProvider } from "../query-client";
import { restoringDone, useRestoring } from "../restoring";
import { handleArrivals } from "../share-target";
import { isListRoute, routeHref, useRoute, type DriveRoute } from "../router";
import { applyTheme, selectedNodes, usePrefs, useUi } from "../store";
import { enqueueUploads, restoreInterrupted } from "../upload/engine";
import { BottomNav, searchInputRef, Sidebar, TopBar } from "./Chrome";
import { CommandPalette } from "./CommandPalette";
import { DetailsPanel } from "./DetailsPanel";
import { Dialogs } from "./Dialogs";
import { DriveView } from "./DriveView";
import { HomeView } from "./HomeView";
import { ActionSheet, openNode } from "./menus";
import { Preview } from "./Preview";
import { SharedView } from "./SharedView";
import { Spinner } from "./ui";
import { UploadPanel } from "./UploadPanel";

const PhotosView = dynamic(() => import("./PhotosView").then((m) => m.PhotosView), { ssr: false });
const StorageView = dynamic(() => import("./StorageView").then((m) => m.StorageView), { ssr: false });

// System status (charts, SSE) is code-split: the drive never pays for it.
const Dashboard = dynamic(() => import("./Dashboard").then((m) => m.Dashboard), {
  ssr: false,
  loading: () => (
    <div className="flex flex-1 items-center justify-center">
      <Spinner className="size-7" />
    </div>
  ),
});

export function DriveApp() {
  return (
    <QueryProvider>
      <Tooltip.Provider delayDuration={400} skipDelayDuration={200}>
        <Shell />
        <Toasts />
        <RestoringScreen />
      </Tooltip.Provider>
    </QueryProvider>
  );
}

/**
 * Shown while the server brings its index back from Telegram (it started on
 * an empty disk, as free hosts do after a restart). Polls until it's back,
 * then refreshes everything.
 */
function RestoringScreen() {
  const message = useRestoring((s) => s.message);
  const qc = useQueryClient();
  const [detail, setDetail] = useState<string | null>(null);
  useEffect(() => {
    if (!message) return;
    let stopped = false;
    void (async () => {
      while (!stopped) {
        try {
          const h = (await (await fetch("/api/health", { cache: "no-store" })).json()) as { ready?: boolean; restoring?: boolean; message?: string; error?: string | null };
          if (h.ready && !h.restoring) {
            restoringDone();
            void qc.invalidateQueries();
            return;
          }
          if (h.restoring) setDetail([h.message, h.error].filter(Boolean).join(" — ") || null);
          else setDetail("Connecting to Telegram…");
        } catch {
          setDetail("Waiting for the server…");
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();
    return () => {
      stopped = true;
    };
  }, [message, qc]);
  if (!message) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-canvas/95 p-6 backdrop-blur-sm" role="status" aria-live="polite" data-testid="restoring">
      <div className="w-full max-w-[460px] border-[1.5px] border-line-strong bg-surface p-7 shadow-hard">
        <div className="mb-5 flex items-center gap-3">
          <span className="size-6 rounded-full bg-accent" aria-hidden />
          <span className="size-6 bg-ink" aria-hidden />
          <span className="size-0 border-x-[12px] border-b-[22px] border-x-transparent border-b-[var(--series-1)]" aria-hidden />
        </div>
        <h2 className="text-[24px] font-semibold tracking-[-0.02em] text-ink">Restoring your drive</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
          This server started with an empty disk. Your files are safe in Telegram; the index that finds them is coming back from the latest backup in
          your channel.
        </p>
        <p className="mt-4 flex items-center gap-2 text-[13px] text-ink-3">
          <Spinner className="size-4 shrink-0" /> {detail ?? message}
        </p>
      </div>
    </div>
  );
}

function Toasts() {
  const mobile = useIsMobile();
  return (
    <Toaster
      position={mobile ? "top-center" : "bottom-left"}
      offset={mobile ? 12 : 20}
      toastOptions={{
        classNames: {
          toast: "!rounded-none !border-[1.5px] !border-line-strong !bg-invert !text-on-invert !shadow-hard !font-sans !text-[14px]",
          description: "!text-on-invert/70",
          actionButton: "!rounded-none !bg-accent !font-semibold !text-on-accent",
          cancelButton: "!rounded-none !bg-on-invert/15 !text-on-invert",
        },
      }}
    />
  );
}

function useHotkeys(route: DriveRoute | null) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const ui = useUi.getState();
      if (t?.closest("input, textarea, select, [contenteditable='true']") || ui.dialog || ui.preview || ui.conflict || ui.paletteOpen) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const sel = selectedNodes();
      const folderId = route?.name === "folder" ? route.id : null;
      const inTrash = route?.name === "trash";
      // Uploads and new folders from other views land in My files.
      const dropId = folderId ?? "root";
      const canCreate = route !== null && route.name !== "system" && !inTrash;

      if (e.key === "/") {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (mod && key === "a") {
        e.preventDefault();
        ui.setSelection(ui.visible.map((n) => n.id));
      } else if (e.key === "Escape") {
        ui.clearSelection();
        if (ui.clipboard) ui.setClipboard(null);
      } else if ((e.key === "Delete" || (mod && e.key === "Backspace")) && sel.length) {
        e.preventDefault();
        // Shift+Delete skips the trash: deleted from your files and from Telegram.
        if (inTrash || e.shiftKey) ui.openDialog({ type: "deleteForever", nodes: sel });
        else void trashNodes(sel);
      } else if (e.key === "F2" && sel.length === 1 && !inTrash) {
        e.preventDefault();
        ui.openDialog({ type: "rename", node: sel[0] });
      } else if (e.key === "Enter" && sel.length === 1 && !inTrash) {
        openNode(sel[0]);
      } else if (!mod && key === "s" && sel.length && !inTrash) {
        void setStarred(sel, !sel.every((n) => n.starred));
      } else if (mod && key === "c" && sel.length && !window.getSelection()?.toString()) {
        ui.setClipboard({ op: "copy", nodes: sel });
        toast(`${sel.length} item${sel.length === 1 ? "" : "s"} copied — paste in any folder`);
      } else if (mod && key === "x" && sel.length && !inTrash) {
        ui.setClipboard({ op: "cut", nodes: sel });
      } else if (mod && key === "v" && folderId && ui.clipboard) {
        e.preventDefault();
        void paste(folderId);
      } else if (mod && key === "d" && sel.length) {
        e.preventDefault();
        void downloadNodes(sel);
      } else if (!mod && e.shiftKey && key === "n" && canCreate) {
        e.preventDefault();
        ui.openDialog({ type: "newFolder", parentId: dropId });
      } else if (!mod && e.shiftKey && key === "u" && canCreate) {
        e.preventDefault();
        openPicker("files", dropId);
      } else if (!mod && !e.shiftKey && key === "v" && isListRoute(route)) {
        const p = usePrefs.getState();
        p.setViewMode(p.viewMode === "grid" ? "list" : "grid");
      } else if (!mod && key === "i" && isListRoute(route)) {
        usePrefs.getState().toggleDetails();
      } else if (e.key === "?") {
        ui.openDialog({ type: "shortcuts" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [route]);
}

/**
 * The native file pickers. Rendered (visually hidden — not display:none, which
 * some engines refuse to open) and driven by `openPicker()` from any button.
 */
function Pickers() {
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    folderRef.current?.setAttribute("webkitdirectory", "");
    registerPickers(filesRef.current, folderRef.current);
    return () => registerPickers(null, null);
  }, []);
  const onPick = (files: FileList | null, folder: boolean) => {
    if (!files?.length) return;
    const t = pickerTarget();
    void enqueueUploads(folder ? entriesFromInput(files) : Array.from(files, (file) => ({ file })), t.id, [], t.name);
  };
  return (
    <div className="sr-only" aria-hidden>
      <input
        ref={filesRef}
        type="file"
        multiple
        tabIndex={-1}
        data-testid="picker-files"
        onChange={(e) => {
          onPick(e.target.files, false);
          e.target.value = "";
        }}
      />
      <input
        ref={folderRef}
        type="file"
        multiple
        tabIndex={-1}
        data-testid="picker-folder"
        onChange={(e) => {
          onPick(e.target.files, true);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function Content({ route, href }: { route: DriveRoute | null; href: string | null }) {
  if (route === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner className="size-7" />
      </div>
    );
  }
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.div
        key={href}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, transition: { duration: 0.08 } }}
        transition={{ duration: 0.24, ease: [0.2, 0.8, 0.2, 1] }}
      >
        {route.name === "home" ? (
          <HomeView />
        ) : route.name === "shared" ? (
          <SharedView />
        ) : route.name === "system" ? (
          <Dashboard />
        ) : route.name === "photos" ? (
          <PhotosView />
        ) : route.name === "storage" ? (
          <StorageView />
        ) : (
          <DriveView route={route} />
        )}
      </motion.div>
    </AnimatePresence>
  );
}

function Shell() {
  const route = useRoute();
  const detailsOpen = usePrefs((s) => s.detailsOpen);
  const theme = usePrefs((s) => s.theme);
  const href = route ? routeHref(route) : null;
  useHotkeys(route);

  // Leaving a view resets transient selection state.
  useEffect(() => {
    useUi.getState().clearSelection();
    useUi.getState().setMobileNav(false);
    useUi.getState().setTypeFilter("all");
  }, [href]);

  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => applyTheme("system");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [theme]);

  // App-shell caching for instant loads and offline browsing of cached listings.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV === "production") navigator.serviceWorker.register("/sw.js").catch(() => {});
    // Under `next dev`, drop a worker a production run left on this origin (see public/sw-reset.js)
    // with its caches, and load this page again if it came through that worker.
    else
      void (async () => {
        const regs = await navigator.serviceWorker.getRegistrations();
        if (!regs.length) return;
        await Promise.all(regs.map((r) => r.unregister()));
        for (const key of await caches.keys()) if (key.startsWith("telestorage-")) await caches.delete(key);
        if (navigator.serviceWorker.controller) location.reload();
      })().catch(() => {});
  }, []);

  // Uploads a reload or closed tab interrupted: shown so they can be continued.
  // Files shared from another app (phone share sheet) and app shortcuts arrive via the URL.
  useEffect(() => {
    void restoreInterrupted();
    void handleArrivals();
  }, []);

  // Paste images/files straight from the clipboard into the current folder.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (!files.length || route?.name !== "folder" || (e.target as HTMLElement)?.closest("input, textarea")) return;
      e.preventDefault();
      void enqueueUploads(
        files.map((file) => ({ file })),
        route.id,
        [],
        folderNameOf(route.id),
      );
    };
    // Stray drops outside a drop zone must not navigate the tab to the file.
    const block = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    window.addEventListener("paste", onPaste);
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, [route]);

  return (
    <div className="flex h-dvh overflow-hidden bg-canvas">
      <div className="hidden md:block">
        <Sidebar route={route} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar route={route} />
        <main className="flex min-h-0 flex-1">
          <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-canvas">
            <Content route={route} href={href} />
          </section>
          {detailsOpen && isListRoute(route) ? <DetailsPanel route={route} /> : null}
        </main>
        <BottomNav route={route} />
      </div>
      <UploadPanel />
      <Preview />
      <Dialogs />
      <CommandPalette />
      <ActionSheet />
      <Pickers />
    </div>
  );
}
