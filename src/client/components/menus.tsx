"use client";
import {
  ClipboardPaste,
  Copy,
  Download,
  Eye,
  FileUp,
  Flame,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderUp,
  History,
  Inbox,
  Info,
  Link2,
  Palette,
  Pencil,
  RotateCcw,
  Scissors,
  Share2,
  Star,
  StarOff,
  Trash2,
} from "lucide-react";
import { Dialog } from "radix-ui";
import type { ComponentType, ReactNode } from "react";
import type { DriveNode } from "@/lib/types";
import { copyNodes, downloadNodes, paste, quickLink, restoreNodes, setStarred, trashNodes } from "../actions";
import { openPicker, pickNewVersion } from "../pickers";
import { navigate } from "../router";
import { usePrefs, useUi } from "../store";
import { NodeThumb, TypeIcon } from "./NodeVisual";

interface MenuParts {
  Item: ComponentType<{ onSelect?: (e: Event) => void; className?: string; disabled?: boolean; children?: ReactNode }>;
  Separator: ComponentType<{ className?: string }>;
}

export function openNode(node: DriveNode) {
  if (node.kind === "folder") navigate({ name: "folder", id: node.id });
  else useUi.getState().openPreview(node.id);
}

export function NodeMenuItems({ parts, nodes, inTrash }: { parts: MenuParts; nodes: DriveNode[]; inTrash: boolean }) {
  const { Item, Separator } = parts;
  const ui = useUi.getState();
  const single = nodes.length === 1 ? nodes[0] : null;

  if (inTrash) {
    return (
      <>
        <Item className="menu-item" onSelect={() => void restoreNodes(nodes)}>
          <RotateCcw /> Restore
        </Item>
        <Separator className="menu-sep" />
        <Item className="menu-item danger" onSelect={() => ui.openDialog({ type: "deleteForever", nodes })}>
          <Flame /> Delete forever
          <span className="menu-shortcut">Del</span>
        </Item>
      </>
    );
  }

  const allStarred = nodes.every((n) => n.starred);
  return (
    <>
      {single ? (
        <Item className="menu-item" onSelect={() => openNode(single)}>
          {single.kind === "folder" ? <FolderOpen /> : <Eye />} {single.kind === "folder" ? "Open" : "Preview"}
          <span className="menu-shortcut">Enter</span>
        </Item>
      ) : null}
      <Item className="menu-item" onSelect={() => ui.openDialog({ type: "share", nodes })}>
        <Share2 /> Share{nodes.length > 1 ? ` ${nodes.length} items` : ""}…
      </Item>
      <Item className="menu-item" onSelect={() => void quickLink(nodes)}>
        <Link2 /> Copy link
      </Item>
      <Item className="menu-item" onSelect={() => void downloadNodes(nodes)}>
        <Download /> {single?.kind === "file" ? "Download" : "Download as ZIP"}
        <span className="menu-shortcut">Ctrl D</span>
      </Item>
      <Separator className="menu-sep" />
      {single ? (
        <Item className="menu-item" onSelect={() => ui.openDialog({ type: "rename", node: single })}>
          <Pencil /> Rename
          <span className="menu-shortcut">F2</span>
        </Item>
      ) : null}
      {single?.kind === "file" ? (
        <>
          <Item className="menu-item" onSelect={() => ui.openDialog({ type: "versions", node: single })}>
            <History /> Version history{single.versionCount ? ` (${single.versionCount})` : ""}
          </Item>
          <Item className="menu-item" onSelect={() => pickNewVersion(single)}>
            <FileUp /> Upload new version…
          </Item>
        </>
      ) : null}
      {nodes.every((n) => n.kind === "folder") ? (
        <Item className="menu-item" onSelect={() => ui.openDialog({ type: "color", nodes })}>
          <Palette /> Colour…
        </Item>
      ) : null}
      {single?.kind === "folder" ? (
        <Item className="menu-item" onSelect={() => ui.openDialog({ type: "request", folder: single })}>
          <Inbox /> Request files…
        </Item>
      ) : null}
      <Item className="menu-item" onSelect={() => ui.openDialog({ type: "move", nodes })}>
        <FolderInput /> Move to…
      </Item>
      <Item className="menu-item" onSelect={() => void copyNodes(nodes, nodes[0].parentId ?? "root")}>
        <Copy /> Make a copy
      </Item>
      <Item className="menu-item" onSelect={() => ui.setClipboard({ op: "cut", nodes })}>
        <Scissors /> Cut
        <span className="menu-shortcut">Ctrl X</span>
      </Item>
      <Item className="menu-item" onSelect={() => void setStarred(nodes, !allStarred)}>
        {allStarred ? <StarOff /> : <Star />} {allStarred ? "Remove star" : "Star"}
        <span className="menu-shortcut">S</span>
      </Item>
      <Item
        className="menu-item"
        onSelect={() => {
          if (!usePrefs.getState().detailsOpen) usePrefs.getState().toggleDetails();
        }}
      >
        <Info /> Details
        <span className="menu-shortcut">I</span>
      </Item>
      <Separator className="menu-sep" />
      <Item className="menu-item danger" onSelect={() => void trashNodes(nodes)}>
        <Trash2 /> Move to trash
        <span className="menu-shortcut">Del</span>
      </Item>
      <Item className="menu-item danger" onSelect={() => ui.openDialog({ type: "deleteForever", nodes })}>
        <Flame /> Delete forever…
        <span className="menu-shortcut">⇧ Del</span>
      </Item>
    </>
  );
}

export function BackgroundMenuItems({ parts, folderId, folderName }: { parts: MenuParts; folderId: string; folderName?: string }) {
  const { Item, Separator } = parts;
  const ui = useUi.getState();
  return (
    <>
      <Item className="menu-item" onSelect={() => openPicker("files", folderId, folderName)}>
        <FileUp /> Upload files
        <span className="menu-shortcut">⇧ U</span>
      </Item>
      <Item className="menu-item" onSelect={() => openPicker("folder", folderId, folderName)}>
        <FolderUp /> Upload a folder
      </Item>
      <Separator className="menu-sep" />
      <Item className="menu-item" onSelect={() => ui.openDialog({ type: "newFolder", parentId: folderId })}>
        <FolderPlus /> New folder
        <span className="menu-shortcut">⇧ N</span>
      </Item>
      {ui.clipboard ? (
        <>
          <Separator className="menu-sep" />
          <Item className="menu-item" onSelect={() => void paste(folderId)}>
            <ClipboardPaste /> Paste {ui.clipboard.nodes.length} item{ui.clipboard.nodes.length === 1 ? "" : "s"}
            <span className="menu-shortcut">Ctrl V</span>
          </Item>
        </>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Phone: the same actions as a bottom sheet
// ---------------------------------------------------------------------------

function SheetItem({ onSelect, className, disabled, children }: { onSelect?: (e: Event) => void; className?: string; disabled?: boolean; children?: ReactNode }) {
  return (
    <button
      disabled={disabled}
      className={`${className ?? ""} h-12 w-full text-left text-[15.5px] [&_.menu-shortcut]:hidden`}
      onClick={(e) => {
        useUi.getState().closeActions();
        onSelect?.(e.nativeEvent);
      }}
    >
      {children}
    </button>
  );
}

const sheetParts: MenuParts = { Item: SheetItem, Separator: ({ className }) => <div className={className} /> };

export function ActionSheet() {
  const actions = useUi((s) => s.actions);
  const close = () => useUi.getState().closeActions();
  const single = actions?.nodes.length === 1 ? actions.nodes[0] : null;
  return (
    <Dialog.Root open={!!actions} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[#0b0b0b]/45 animate-fade-in" />
        <Dialog.Content className="fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-y-auto border-t-[1.5px] border-line-strong bg-surface px-2 pb-3 outline-none animate-slide-up safe-bottom" data-testid="action-sheet">
          <div className="flex items-center gap-3 border-b border-line px-3 py-3.5">
            {single ? (
              single.kind === "file" && single.hasThumb ? <NodeThumb node={single} className="size-11 shrink-0" /> : <TypeIcon node={single} className="size-11" />
            ) : (
              <span className="flex size-11 items-center justify-center bg-invert text-[15px] font-semibold text-on-invert">{actions?.nodes.length}</span>
            )}
            <div className="min-w-0">
              <Dialog.Title className="truncate text-[16px] font-semibold text-ink">{single ? single.name : `${actions?.nodes.length} items`}</Dialog.Title>
              <Dialog.Description className="text-[13px] text-ink-3">{actions?.inTrash ? "In the trash" : "Choose an action"}</Dialog.Description>
            </div>
          </div>
          <div className="pt-1">{actions ? <NodeMenuItems parts={sheetParts} nodes={actions.nodes} inTrash={actions.inTrash} /> : null}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
