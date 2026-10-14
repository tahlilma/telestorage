"use client";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Check, Download, EllipsisVertical, Link2, Share2, Star, UploadCloud } from "lucide-react";
import { ContextMenu, DropdownMenu } from "radix-ui";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatBytes, formatDate } from "@/lib/format";
import type { DriveNode } from "@/lib/types";
import { downloadNodes, moveNodes, quickLink } from "../actions";
import { collectDrop, hasFiles, hasNodes, NODE_MIME, readNodeIds, setDragBadge } from "../dnd";
import { categoryOf, fileUrl, folderTone, previewKind, warmFile, type FileCategory } from "../files";
import { isTouchDevice } from "../hooks";
import { prefetchFolder } from "../queries";
import { usePrefs, useUi, type SortKey, type TypeFilter } from "../store";
import { enqueueUploads } from "../upload/engine";
import { BackgroundMenuItems, NodeMenuItems, openNode } from "./menus";
import { FolderGlyph, NodeThumb, TypeIcon, TypeTag } from "./NodeVisual";
import { cn, IconButton } from "./ui";

const FILTER_CATEGORIES: Record<Exclude<TypeFilter, "all">, FileCategory[]> = {
  folder: ["folder"],
  image: ["image"],
  video: ["video"],
  audio: ["audio"],
  document: ["pdf", "doc", "sheet", "slides", "text", "code"],
  archive: ["archive"],
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function sortNodes(items: DriveNode[], key: SortKey, dir: "asc" | "desc"): DriveNode[] {
  const sign = dir === "asc" ? 1 : -1;
  const cmp = (a: DriveNode, b: DriveNode) => {
    let r = 0;
    if (key === "updatedAt") r = a.updatedAt - b.updatedAt;
    else if (key === "size") r = a.size - b.size;
    else if (key === "type") r = collator.compare(categoryOf(a), categoryOf(b));
    return (r || collator.compare(a.name, b.name)) * sign;
  };
  // Folders always come first.
  return [...items].sort((a, b) => (a.kind === b.kind ? cmp(a, b) : a.kind === "folder" ? -1 : 1));
}

const itemCount = (n: number | null | undefined) => `${(n ?? 0).toLocaleString()} item${n === 1 ? "" : "s"}`;
const folderMeta = (n: DriveNode) => (n.childCount ? `${itemCount(n.childCount)}${n.folderSize ? ` · ${formatBytes(n.folderSize)}` : ""}` : "Empty");

const PAD = 20;
const GAP = 16;
const FOLDER_H = 76;
const LABEL_H = 48;
const ROW_H = 58;
const LIST_HEAD = 44;
/** Pointer-downs on these must never start a rubber-band selection (or have their click stolen). */
const INTERACTIVE = "button, a, input, select, textarea, label, summary, [role='button'], [role='menuitem'], [data-stop], [data-node-id]";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Placed extends Rect {
  node: DriveNode;
}
interface Label extends Rect {
  text: string;
  count: number;
}

interface Props {
  items: DriveNode[] | undefined;
  loading: boolean;
  /** Folder that new uploads / background actions target (null for virtual views). */
  folderId: string | null;
  folderName?: string;
  inTrash?: boolean;
  /** Keep server order (recent, search relevance) instead of applying the sort. */
  keepOrder?: boolean;
  empty: ReactNode;
}

/**
 * The file grid/list. Items are absolutely positioned from a computed layout
 * and virtualized by scroll position, so when something is added, removed,
 * sorted or filtered every card glides to its new place (CSS transforms),
 * new cards pop in and removed ones fade out where they were.
 */
export function FileBrowser({ items, loading, folderId, folderName = "My files", inTrash = false, keepOrder = false, empty }: Props) {
  const qc = useQueryClient();
  const viewMode = usePrefs((s) => s.viewMode);
  const sort = usePrefs((s) => s.sort);
  const selection = useUi((s) => s.selection);
  const selecting = useUi((s) => s.selecting);
  const clipboard = useUi((s) => s.clipboard);
  const setVisible = useUi((s) => s.setVisible);
  const typeFilter = useUi((s) => s.typeFilter);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 900 });
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<"nodes" | "background">("background");
  const [rect, setRect] = useState<Rect | null>(null);
  const suppressClick = useRef(false);

  const sorted = useMemo(() => {
    if (!items) return [];
    const cats = typeFilter === "all" ? null : FILTER_CATEGORIES[typeFilter];
    const filtered = cats ? items.filter((n) => cats.includes(categoryOf(n))) : items;
    return keepOrder ? filtered : sortNodes(filtered, sort.key, sort.dir);
  }, [items, keepOrder, sort.key, sort.dir, typeFilter]);

  useEffect(() => setVisible(sorted), [sorted, setVisible]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      setWidth(e.contentRect.width);
      setViewport((v) => ({ ...v, height: e.contentRect.height }));
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    setViewport({ top: el.scrollTop, height: el.clientHeight });
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setViewport({ top: el.scrollTop, height: el.clientHeight });
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  const cutIds = useMemo(() => new Set(clipboard?.op === "cut" ? clipboard.nodes.map((n) => n.id) : []), [clipboard]);

  // ---- layout -----------------------------------------------------------------
  const layout = useMemo(() => {
    const placed: Placed[] = [];
    const labels: Label[] = [];
    if (width < 1) return { placed, labels, height: 0 };
    if (viewMode === "list") {
      sorted.forEach((node, i) => placed.push({ node, x: 0, y: LIST_HEAD + i * ROW_H, w: width, h: ROW_H }));
      return { placed, labels, height: LIST_HEAD + sorted.length * ROW_H + 120 };
    }
    const pad = width < 640 ? 12 : PAD;
    const gap = width < 640 ? 10 : GAP;
    const inner = width - pad * 2;
    const min = width < 640 ? 150 : 210;
    const cols = Math.max(1, Math.floor((inner + gap) / (min + gap)));
    const w = (inner - gap * (cols - 1)) / cols;
    const folders = sorted.filter((n) => n.kind === "folder");
    const files = sorted.filter((n) => n.kind === "file");
    let y = 4;
    if (folders.length) {
      // Folder cards are rows (icon, name, details), so they need more width than
      // file tiles: on a phone that means one full-width row per folder.
      const fcols = Math.max(1, Math.floor((inner + gap) / (230 + gap)));
      const fw = (inner - gap * (fcols - 1)) / fcols;
      labels.push({ text: "Folders", count: folders.length, x: pad, y, w: inner, h: LABEL_H });
      y += LABEL_H;
      folders.forEach((node, i) => placed.push({ node, x: pad + (i % fcols) * (fw + gap), y: y + Math.floor(i / fcols) * (FOLDER_H + gap), w: fw, h: FOLDER_H }));
      y += Math.ceil(folders.length / fcols) * (FOLDER_H + gap);
    }
    if (files.length) {
      const fileH = Math.round(w * 0.72 + 64);
      labels.push({ text: "Files", count: files.length, x: pad, y, w: inner, h: LABEL_H });
      y += LABEL_H;
      files.forEach((node, i) => placed.push({ node, x: pad + (i % cols) * (w + gap), y: y + Math.floor(i / cols) * (fileH + gap), w, h: fileH }));
      y += Math.ceil(files.length / cols) * (fileH + gap);
    }
    return { placed, labels, height: y + 120 };
  }, [sorted, viewMode, width]);

  // ---- enter / exit animation bookkeeping ---------------------------------------
  // Ids this view has already shown. Items check it when they mount (their
  // effects run before ours), so only genuinely new items animate in — not
  // ones that merely scroll into the rendered window.
  const known = useRef<Set<string> | null>(null);
  useLayoutEffect(() => {
    if (!items) return;
    known.current ??= new Set();
    for (const p of layout.placed) known.current.add(p.node.id);
  }, [layout, items]);

  // Removed items stay a moment as fading "ghosts" where they were. Derived
  // during render, so there is never a frame where they simply vanish.
  const [prevLayout, setPrevLayout] = useState(layout);
  const [ghosts, setGhosts] = useState<Placed[]>([]);
  if (prevLayout !== layout) {
    setPrevLayout(layout);
    if (prevLayout.placed.length && layout.placed.length + 400 > prevLayout.placed.length) {
      const ids = new Set(layout.placed.map((p) => p.node.id));
      const gone = prevLayout.placed.filter((p) => !ids.has(p.node.id) && p.y + p.h > viewport.top - 100 && p.y < viewport.top + viewport.height + 100);
      if (gone.length) setGhosts((g) => [...g, ...gone]);
    }
  }
  useEffect(() => {
    if (!ghosts.length) return;
    const t = setTimeout(() => setGhosts([]), 240);
    return () => clearTimeout(t);
  }, [ghosts]);

  const placedRef = useRef(layout.placed);
  useEffect(() => {
    placedRef.current = layout.placed;
  }, [layout]);

  const overscan = 600;
  const visibleItems = layout.placed.filter((p) => p.y + p.h > viewport.top - overscan && p.y < viewport.top + viewport.height + overscan);

  // "Locate": select an item once it shows up here and scroll it into view.
  const reveal = useUi((s) => s.reveal);
  useEffect(() => {
    if (!reveal) return;
    if (Date.now() > reveal.until) return void useUi.getState().revealNode(null);
    const hit = layout.placed.find((p) => p.node.id === reveal.id);
    if (!hit) return;
    // Deferred past this commit's effects: navigating to a folder clears the selection.
    const t = setTimeout(() => {
      useUi.getState().revealNode(null);
      useUi.getState().select(reveal.id, "single");
      scrollRef.current?.scrollTo({ top: Math.max(0, hit.y - viewport.height / 2 + hit.h / 2), behavior: "smooth" });
    }, 0);
    return () => clearTimeout(t);
  }, [reveal, layout, viewport.height]);

  // ---- delegated interaction -------------------------------------------------
  const nodeFromEvent = (target: EventTarget | null): DriveNode | null => {
    const el = (target as HTMLElement | null)?.closest<HTMLElement>("[data-node-id]");
    if (!el) return null;
    return useUi.getState().visible.find((n) => n.id === el.dataset.nodeId) ?? null;
  };

  const onClick = (e: React.MouseEvent) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    const target = e.target as HTMLElement;
    if (target.closest("[data-stop]")) return;
    const node = nodeFromEvent(target);
    const ui = useUi.getState();
    if (!node) {
      // Clicks on controls (e.g. the empty-state buttons) are theirs alone.
      if (!target.closest(INTERACTIVE)) ui.clearSelection();
      return;
    }
    if (target.closest("[data-check]")) return ui.select(node.id, "toggle");
    if (isTouchDevice()) {
      if (ui.selecting) ui.select(node.id, "toggle");
      else openNode(node);
      return;
    }
    if (e.metaKey || e.ctrlKey) ui.select(node.id, "toggle");
    else if (e.shiftKey) ui.select(node.id, "range");
    else ui.select(node.id, "single");
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (isTouchDevice() || (e.target as HTMLElement).closest("[data-stop], [data-check]")) return;
    const node = nodeFromEvent(e.target);
    if (node && !inTrash) openNode(node);
  };

  // Long-press starts selecting on touch screens.
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const cancelPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };

  /**
   * Rubber-band selection. Deliberately NO pointer capture on pointer-down:
   * capturing redirects the following click to this container, which would
   * swallow clicks on buttons inside it. The band engages only after the
   * pointer has actually moved.
   */
  const onPointerDown = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    if (e.pointerType === "touch") {
      const node = nodeFromEvent(target);
      if (!node || target.closest("[data-stop]")) return;
      pressStart.current = { x: e.clientX, y: e.clientY };
      pressTimer.current = setTimeout(() => {
        useUi.getState().startSelecting(node.id);
        navigator.vibrate?.(12);
        suppressClick.current = true;
      }, 420);
      return;
    }
    if (e.button !== 0 || target.closest(INTERACTIVE)) return;
    const el = scrollRef.current!;
    const box = el.getBoundingClientRect();
    if (e.clientX > box.right - 14) return; // scrollbar
    const x0 = e.clientX - box.left;
    const y0 = e.clientY - box.top + el.scrollTop;
    const base = e.ctrlKey || e.metaKey || e.shiftKey ? new Set(useUi.getState().selection) : new Set<string>();
    let engaged = false;

    const move = (ev: PointerEvent) => {
      const b = el.getBoundingClientRect();
      const x1 = ev.clientX - b.left;
      const y1 = ev.clientY - b.top + el.scrollTop;
      if (!engaged) {
        if (Math.hypot(x1 - x0, y1 - y0) < 6) return;
        engaged = true;
      }
      if (ev.clientY > b.bottom - 40) el.scrollTop += 18;
      else if (ev.clientY < b.top + 40) el.scrollTop -= 18;
      const r = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      setRect(r);
      // Hit-test against the layout (covers items outside the rendered window too).
      const hit = new Set(base);
      for (const p of placedRef.current) {
        if (p.x < r.x + r.w && p.x + p.w > r.x && p.y < r.y + r.h && p.y + p.h > r.y) hit.add(p.node.id);
      }
      useUi.getState().setSelection(hit);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (engaged) suppressClick.current = true;
      setRect(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  // ---- drag & drop -----------------------------------------------------------
  const dragIds = useRef<Set<string>>(new Set());
  const onDragStart = (e: React.DragEvent) => {
    const node = nodeFromEvent(e.target);
    if (!node || inTrash) return e.preventDefault();
    const ui = useUi.getState();
    if (!ui.selection.has(node.id)) ui.select(node.id, "single");
    const ids = [...useUi.getState().selection];
    dragIds.current = new Set(ids);
    e.dataTransfer.setData(NODE_MIME, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = "move";
    setDragBadge(e.dataTransfer, ids.length === 1 ? node.name : `${ids.length} items`);
  };

  const onDragOver = (e: React.DragEvent) => {
    const files = hasFiles(e.dataTransfer);
    const nodes = hasNodes(e.dataTransfer);
    if (!files && !nodes) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-folder-id]");
    const target = el?.dataset.folderId ?? null;
    if (nodes && (!target || dragIds.current.has(target))) {
      setDropTarget(null);
      return;
    }
    if (files && !target && !folderId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = nodes ? "move" : "copy";
    setDropTarget(target ?? "__self");
  };

  const onDrop = async (e: React.DragEvent) => {
    const target = dropTarget === "__self" ? folderId : dropTarget;
    setDropTarget(null);
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    const targetName = target === folderId ? folderName : (useUi.getState().visible.find((n) => n.id === target)?.name ?? folderName);
    if (hasNodes(e.dataTransfer)) {
      const ids = new Set(readNodeIds(e.dataTransfer));
      const nodes = useUi.getState().visible.filter((n) => ids.has(n.id));
      void moveNodes(nodes, target, targetName);
      return;
    }
    const { entries, dirs } = await collectDrop(e.dataTransfer);
    void enqueueUploads(entries, target, dirs, targetName);
  };

  // ---- hover-intent prefetch ------------------------------------------------
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onPointerOver = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      const node = nodeFromEvent(e.target);
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      if (!node) return;
      hoverTimer.current = setTimeout(
        () => {
          if (node.kind === "folder") void prefetchFolder(qc, node.id);
          else if (previewKind(node) === "image" && node.size < 20 * 1024 * 1024) new Image().src = fileUrl(node);
          else warmFile(node); // video, audio, PDFs, big images: the server pre-pulls the first blocks
        },
        node.kind === "folder" ? 80 : 300,
      );
    },
    [qc],
  );

  const showSkeleton = loading && !items;
  const isEmpty = !showSkeleton && sorted.length === 0;
  const selectedNodes = sorted.filter((n) => selection.has(n.id));
  const animate = "transition-transform duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)]";

  const renderItem = (p: Placed, ghost = false) => {
    const n = p.node;
    const common = { node: n, selected: !ghost && selection.has(n.id), cut: cutIds.has(n.id), inTrash, selecting, ghost };
    return (
      <Slot key={ghost ? `ghost-${n.id}` : n.id} p={p} ghost={ghost} known={known} className={animate}>
        {viewMode === "list" ? (
          <ListRow {...common} dropping={dropTarget === n.id} />
        ) : n.kind === "folder" ? (
          <FolderCard {...common} dropping={dropTarget === n.id} />
        ) : (
          <FileCard {...common} />
        )}
      </Slot>
    );
  };

  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild disabled={isTouchDevice()}>
        <div
          ref={scrollRef}
          role="grid"
          aria-multiselectable
          aria-label="Files"
          data-testid="file-browser"
          className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden outline-none"
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          onPointerDown={onPointerDown}
          onPointerMove={(e) => {
            if (e.pointerType === "touch" && pressStart.current && Math.hypot(e.clientX - pressStart.current.x, e.clientY - pressStart.current.y) > 8) cancelPress();
          }}
          onPointerUp={cancelPress}
          onPointerCancel={cancelPress}
          onPointerOver={onPointerOver}
          onDragStart={onDragStart}
          onDragEnd={() => {
            dragIds.current = new Set();
            setDropTarget(null);
          }}
          onDragOver={onDragOver}
          onDragLeave={(e) => {
            if (!scrollRef.current?.contains(e.relatedTarget as Node)) setDropTarget(null);
          }}
          onDrop={onDrop}
          onContextMenuCapture={(e) => {
            const node = nodeFromEvent(e.target);
            const ui = useUi.getState();
            if (node) {
              if (!ui.selection.has(node.id)) ui.select(node.id, "single");
              setMenuFor("nodes");
            } else {
              ui.clearSelection();
              setMenuFor("background");
            }
          }}
        >
          {showSkeleton ? <Skeleton mode={viewMode} /> : null}
          {isEmpty ? (
            <div className="flex min-h-full items-center justify-center p-8" data-stop>
              {empty}
            </div>
          ) : null}

          {!isEmpty && !showSkeleton ? (
            <div className="relative w-full" style={{ height: layout.height }}>
              {viewMode === "list" ? <ListHeader showSort={!keepOrder} /> : null}
              {layout.labels.map((l) => (
                <div key={l.text} className={cn("absolute flex items-end gap-2 pb-3", animate)} style={{ transform: `translate3d(${l.x}px, ${l.y}px, 0)`, width: l.w, height: l.h }}>
                  <span className="label text-ink">{l.text}</span>
                  <span className="text-[12px] font-medium text-ink-3 tabular">{l.count}</span>
                  <span className="mb-[6px] ml-2 h-px flex-1 bg-line" />
                </div>
              ))}
              {visibleItems.map((p) => renderItem(p))}
              {ghosts.map((p) => renderItem(p, true))}
            </div>
          ) : null}

          {rect ? (
            <div className="pointer-events-none absolute z-10 border-2 border-accent bg-accent/10" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} />
          ) : null}

          {dropTarget === "__self" ? (
            <>
              <div className="pointer-events-none fixed inset-0 z-10 m-3 border-[3px] border-dashed border-accent bg-accent/5 animate-fade-in" />
              <div className="pointer-events-none sticky bottom-6 left-0 z-20 flex justify-center">
                <div className="flex items-center gap-3 bg-invert px-5 py-3.5 text-[14.5px] font-semibold text-on-invert shadow-hard animate-pop-in">
                  <UploadCloud className="size-5 text-accent" /> Drop to upload to “{folderName}”
                </div>
              </div>
            </>
          ) : null}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu-surface" collisionPadding={8}>
          {menuFor === "nodes" && selectedNodes.length ? (
            <NodeMenuItems parts={ContextMenu} nodes={selectedNodes} inTrash={inTrash} />
          ) : folderId && !inTrash ? (
            <BackgroundMenuItems parts={ContextMenu} folderId={folderId} folderName={folderName} />
          ) : (
            <ContextMenu.Item className="menu-item" disabled>
              Nothing to do here
            </ContextMenu.Item>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** Positions an item; animates it in when it is new to this view, out when it is a ghost. */
function Slot({ p, ghost, known, className, children }: { p: Placed; ghost: boolean; known: React.RefObject<Set<string> | null>; className: string; children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el || typeof el.animate !== "function" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (ghost) {
      el.animate([{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(0.9)" }], { duration: 220, easing: "ease-in", fill: "forwards" });
    } else if (known.current && !known.current.has(p.node.id)) {
      el.animate([{ opacity: 0, transform: "scale(0.92)" }, { opacity: 1, transform: "none" }], { duration: 360, easing: "cubic-bezier(0.3, 1.3, 0.4, 1)" });
    }
    // Mount only: later renders never re-trigger the entrance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div
      className={cn("absolute left-0 top-0", ghost ? "pointer-events-none" : className)}
      style={{ transform: `translate3d(${p.x}px, ${p.y}px, 0)`, width: p.w, height: p.h }}
    >
      <div ref={inner} className="size-full">
        {children}
      </div>
    </div>
  );
}

function MoreButton({ node, inTrash, className }: { node: DriveNode; inTrash: boolean; className?: string }) {
  const selection = useUi((s) => s.selection);
  const visible = useUi((s) => s.visible);
  const nodes = selection.has(node.id) ? visible.filter((n) => selection.has(n.id)) : [node];
  const trigger = (
    <button
      data-stop
      aria-label={`More actions for ${node.name}`}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (!isTouchDevice() && !useUi.getState().selection.has(node.id)) useUi.getState().select(node.id, "single");
      }}
      onClick={(e) => {
        if (!isTouchDevice()) return;
        e.stopPropagation();
        useUi.getState().openActions(nodes, inTrash);
      }}
      className={cn("ml-auto flex size-8 shrink-0 items-center justify-center text-ink-3 transition hover:bg-surface-3 hover:text-ink data-[state=open]:bg-invert data-[state=open]:text-on-invert", className)}
    >
      <EllipsisVertical className="size-[17px]" />
    </button>
  );
  if (isTouchDevice()) return trigger;
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu-surface" align="end" sideOffset={4} collisionPadding={8}>
          <NodeMenuItems parts={DropdownMenu} nodes={nodes} inTrash={inTrash} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

interface ItemProps {
  node: DriveNode;
  selected: boolean;
  cut: boolean;
  dropping?: boolean;
  inTrash: boolean;
  selecting: boolean;
  ghost: boolean;
}

/** Square checkbox shown on hover, in selection mode, or when selected. */
function Check_({ selected, always }: { selected: boolean; always: boolean }) {
  return (
    <span
      data-check
      role="checkbox"
      aria-checked={selected}
      aria-label="Select"
      className={cn(
        "flex size-[22px] shrink-0 items-center justify-center border-[1.5px] transition-[opacity,background-color] duration-150",
        selected ? "border-accent bg-accent text-on-accent opacity-100" : "border-line-strong/50 bg-surface/90 text-transparent",
        !selected && (always ? "opacity-100" : "opacity-0 group-hover:opacity-100"),
      )}
    >
      <Check className="size-3.5" strokeWidth={3} />
    </span>
  );
}

function Badges({ node }: { node: DriveNode }) {
  return (
    <>
      {node.starred ? <Star className="size-3.5 shrink-0 fill-accent text-accent" aria-label="Starred" /> : null}
      {node.shareCount ? <Link2 className="size-3.5 shrink-0 text-ink-2" aria-label="Shared by link" /> : null}
    </>
  );
}

const FolderCard = memo(function FolderCard({ node, selected, cut, dropping, inTrash, selecting, ghost }: ItemProps) {
  return (
    <div
      data-node-id={ghost ? undefined : node.id}
      data-folder-id={inTrash || ghost ? undefined : node.id}
      draggable={!inTrash && !isTouchDevice()}
      aria-selected={selected}
      role="gridcell"
      className={cn(
        "lift group relative flex size-full select-none items-center gap-3 border bg-surface pl-3 pr-1.5",
        selected ? "border-accent bg-selected shadow-[inset_0_0_0_1px_var(--accent)]" : "border-line",
        dropping && "border-accent bg-accent-soft shadow-hard",
        cut && "opacity-50",
      )}
    >
      <div className="relative">
        <div
          className={cn("flex size-12 shrink-0 items-center justify-center transition-colors", selected ? "bg-accent text-on-accent" : "bg-invert text-on-invert")}
          // A coloured folder keeps its colour when selected (the border and fill already say "selected").
          style={node.color ? { background: folderTone(node).bg, color: folderTone(node).fg } : undefined}
        >
          <FolderGlyph className="size-6" />
        </div>
        <span className="absolute -left-1.5 -top-1.5">
          <Check_ selected={selected} always={selecting} />
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[15px] font-semibold">{node.name}</span>
          <Badges node={node} />
        </div>
        <div className="mt-0.5 text-[12.5px] text-ink-3 tabular">{folderMeta(node)}</div>
      </div>
      <MoreButton node={node} inTrash={inTrash} />
    </div>
  );
});

const FileCard = memo(function FileCard({ node, selected, cut, inTrash, selecting, ghost }: ItemProps) {
  return (
    <div
      data-node-id={ghost ? undefined : node.id}
      draggable={!inTrash && !isTouchDevice()}
      aria-selected={selected}
      role="gridcell"
      className={cn(
        "lift group relative flex size-full select-none flex-col overflow-hidden border bg-surface",
        selected ? "border-accent bg-selected shadow-[inset_0_0_0_1px_var(--accent)]" : "border-line",
        cut && "opacity-50",
      )}
    >
      <div className="relative min-h-0 flex-1 p-1.5 pb-0">
        <NodeThumb node={node} className="size-full" />
        <span className="absolute left-3 top-3">
          <Check_ selected={selected} always={selecting} />
        </span>
      </div>
      <div className="flex h-[58px] shrink-0 items-center gap-2 pl-3 pr-1">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[14px] font-semibold">{node.name}</span>
            <Badges node={node} />
          </div>
          {/* The date only when the card is wide enough to show it whole. */}
          <div className="@container mt-0.5 flex items-center gap-1.5 text-[12px] text-ink-3 tabular">
            <TypeTag node={node} className="h-[16px] min-w-0 shrink-0 px-1 text-[9.5px]" />
            <span className="min-w-0 truncate">
              {formatBytes(node.size)}
              <span className="hidden @[11rem]:inline"> · {formatDate(node.updatedAt)}</span>
            </span>
          </div>
        </div>
        <MoreButton node={node} inTrash={inTrash} />
      </div>
    </div>
  );
});

const ListRow = memo(function ListRow({ node, selected, cut, dropping, inTrash, selecting, ghost }: ItemProps) {
  const isFolder = node.kind === "folder";
  return (
    <div
      data-node-id={ghost ? undefined : node.id}
      data-folder-id={isFolder && !inTrash && !ghost ? node.id : undefined}
      draggable={!inTrash && !isTouchDevice()}
      aria-selected={selected}
      role="row"
      className={cn(
        "group mx-2 grid h-[54px] select-none grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-line px-3 transition-colors duration-100 md:grid-cols-[minmax(0,1fr)_150px_110px_120px]",
        selected ? "bg-selected shadow-[inset_3px_0_0_var(--accent)]" : "hover:bg-surface-2",
        dropping && "bg-accent-soft shadow-[inset_0_0_0_2px_var(--accent)]",
        cut && "opacity-50",
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="relative">
          {isFolder ? (
            <span className="flex size-9 items-center justify-center bg-invert text-on-invert" style={node.color ? { background: folderTone(node).bg, color: folderTone(node).fg } : undefined}>
              <FolderGlyph className="size-5" />
            </span>
          ) : node.hasThumb ? (
            <NodeThumb node={node} className="size-9" />
          ) : (
            <TypeIcon node={node} />
          )}
          <span className={cn("absolute inset-0 flex items-center justify-center", !(selected || selecting) && "opacity-0 group-hover:opacity-100")}>
            <Check_ selected={selected} always />
          </span>
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[14.5px] font-semibold">{node.name}</span>
            <Badges node={node} />
          </div>
          <div className="text-[12px] text-ink-3 tabular md:hidden">
            {formatDate(node.updatedAt)}
            {isFolder ? ` · ${itemCount(node.childCount)}` : ` · ${formatBytes(node.size)}`}
          </div>
        </div>
      </div>
      <div className="hidden text-[13px] text-ink-2 tabular md:block">{formatDate(node.updatedAt)}</div>
      <div className="hidden text-[13px] text-ink-2 tabular md:block">{isFolder ? itemCount(node.childCount) : formatBytes(node.size)}</div>
      <div className="flex items-center justify-end gap-0.5">
        {!inTrash ? (
          <div className="hidden items-center opacity-0 transition-opacity group-hover:opacity-100 md:flex">
            <IconButton data-stop label="Share" className="size-8 [&_svg]:size-[16px]" onClick={() => useUi.getState().openDialog({ type: "share", nodes: [node] })}>
              <Share2 />
            </IconButton>
            <IconButton data-stop label="Copy link" className="size-8 [&_svg]:size-[16px]" onClick={() => void quickLink([node])}>
              <Link2 />
            </IconButton>
            <IconButton data-stop label="Download" className="size-8 [&_svg]:size-[16px]" onClick={() => void downloadNodes([node])}>
              <Download />
            </IconButton>
          </div>
        ) : null}
        <MoreButton node={node} inTrash={inTrash} />
      </div>
    </div>
  );
});

function SortColumn({ k, showSort, children, className }: { k: SortKey; showSort: boolean; children: ReactNode; className?: string }) {
  const sort = usePrefs((s) => s.sort);
  const setSort = usePrefs((s) => s.setSort);
  return (
    <button
      data-stop
      disabled={!showSort}
      onClick={() => setSort(k)}
      className={cn("label flex items-center gap-1 text-left text-ink-3 hover:text-ink disabled:hover:text-ink-3", className)}
    >
      {children}
      {showSort && sort.key === k ? sort.dir === "asc" ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" /> : null}
    </button>
  );
}

function ListHeader({ showSort }: { showSort: boolean }) {
  return (
    <div className="sticky top-0 z-[5] mx-2 grid h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b-[1.5px] border-line-strong bg-surface px-3 md:grid-cols-[minmax(0,1fr)_150px_110px_120px]">
      <SortColumn k="name" showSort={showSort} className="pl-12">
        Name
      </SortColumn>
      <SortColumn k="updatedAt" showSort={showSort} className="hidden md:flex">
        Modified
      </SortColumn>
      <SortColumn k="size" showSort={showSort} className="hidden md:flex">
        Size
      </SortColumn>
      <span />
    </div>
  );
}

function Skeleton({ mode }: { mode: "grid" | "list" }) {
  if (mode === "list") {
    return (
      <div className="space-y-1 p-3">
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} className="flex h-12 items-center gap-4 px-3">
            <div className="skeleton size-9" />
            <div className="skeleton h-3.5" style={{ width: `${30 + ((i * 37) % 40)}%` }} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 p-3 md:grid-cols-[repeat(auto-fill,minmax(210px,1fr))] md:gap-4 md:p-5">
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} className="border border-line bg-surface p-1.5" style={{ animationDelay: `${i * 40}ms` }}>
          <div className="skeleton aspect-[4/3]" />
          <div className="mt-2.5 space-y-2 px-1.5 pb-2">
            <div className="skeleton h-3 w-3/4" />
            <div className="skeleton h-2.5 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}
