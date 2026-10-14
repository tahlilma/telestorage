"use client";
import { Check, Download, History, RotateCcw, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import { formatBytes, formatFullDate } from "@/lib/format";
import { FOLDER_COLORS, type DriveNode, type FolderColor } from "@/lib/types";
import { deleteVersion, restoreVersion, setColor } from "../actions";
import { downloadUrl } from "../api";
import { FOLDER_PALETTE, fileUrl } from "../files";
import { pickNewVersion } from "../pickers";
import { useVersions } from "../queries";
import { FolderGlyph } from "./Brand";
import { Button, cn, Modal, Spinner } from "./ui";

/**
 * Version history of one file: the current content on top, then every kept
 * earlier version. Each can be downloaded; earlier ones restored (what they
 * replace is kept too) or deleted.
 */
export function VersionsDialog({ node, onClose }: { node: DriveNode; onClose: () => void }) {
  const { data, isLoading } = useVersions(node.id);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const versions = data?.versions ?? [];
  const url = (versionId?: string) => `${fileUrl(node, true)}${versionId ? `&v=${encodeURIComponent(versionId)}` : ""}`;

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      kicker="Version history"
      title={node.name}
      description="Uploading over a file keeps the old content here. Restoring is never destructive: the version it replaces is kept too."
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            onClick={() => {
              pickNewVersion(node);
              onClose();
            }}
            data-testid="upload-new-version"
          >
            <Upload className="size-4" /> Upload new version
          </Button>
        </>
      }
    >
      <ol className="relative max-h-[50dvh] overflow-y-auto" data-testid="version-list">
        {/* Timeline spine */}
        <span className="absolute bottom-6 left-[19px] top-6 w-[2px] bg-line" aria-hidden />
        <li className="relative flex items-center gap-4 py-3">
          <span className="relative z-10 flex size-10 shrink-0 items-center justify-center bg-accent text-on-accent">
            <Check className="size-5" strokeWidth={2.5} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[15px] font-semibold text-ink">
              Current version <span className="label bg-accent-soft px-1.5 py-0.5 text-accent">Now</span>
            </div>
            <div className="text-[13px] text-ink-3 tabular">
              {formatBytes(node.size)} · since {formatFullDate(node.updatedAt)}
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => downloadUrl(url())} aria-label="Download current version">
            <Download className="size-4" />
          </Button>
        </li>
        {isLoading ? (
          <li className="flex justify-center py-6">
            <Spinner className="size-6" />
          </li>
        ) : versions.length === 0 ? (
          <li className="relative flex items-center gap-4 py-3 text-[14px] text-ink-3">
            <span className="relative z-10 flex size-10 shrink-0 items-center justify-center border-[1.5px] border-dashed border-line-strong bg-surface">
              <History className="size-4" />
            </span>
            No earlier versions yet. Upload a file with the same name (and pick “Replace”) or use “Upload new version”.
          </li>
        ) : (
          versions.map((v, i) => (
            <li key={v.id} className="group relative flex items-center gap-4 py-3" data-testid="version-row">
              <span className="relative z-10 flex size-10 shrink-0 items-center justify-center border-[1.5px] border-line-strong bg-surface text-[13px] font-semibold text-ink tabular">
                v{versions.length - i}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[14.5px] font-medium text-ink">Uploaded {formatFullDate(v.createdAt)}</div>
                <div className="text-[13px] text-ink-3 tabular">
                  {formatBytes(v.size)} · replaced {formatFullDate(v.replacedAt)}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => downloadUrl(url(v.id))} aria-label={`Download version ${versions.length - i}`}>
                  <Download className="size-4" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={async () => {
                    setBusy(v.id);
                    const ok = await restoreVersion(node, v.id);
                    setBusy(null);
                    if (ok) onClose();
                  }}
                  data-testid="restore-version"
                >
                  {busy === v.id ? <Spinner className="size-3.5" /> : <RotateCcw className="size-3.5" />} Restore
                </Button>
                <Button
                  size="sm"
                  variant={confirm === v.id ? "danger" : "ghost"}
                  aria-label={`Delete version ${versions.length - i}`}
                  onClick={() => {
                    if (confirm !== v.id) {
                      setConfirm(v.id);
                      setTimeout(() => setConfirm((c) => (c === v.id ? null : c)), 3000);
                      return;
                    }
                    setConfirm(null);
                    void deleteVersion(node, v.id);
                  }}
                >
                  <Trash2 className="size-3.5" />
                  {confirm === v.id ? " Delete?" : null}
                </Button>
              </div>
            </li>
          ))
        )}
      </ol>
    </Modal>
  );
}

/** Folder colours: the Bauhaus palette as big square swatches. */
export function ColorDialog({ nodes, onClose }: { nodes: DriveNode[]; onClose: () => void }) {
  const folders = nodes.filter((n) => n.kind === "folder");
  // The colour they all share ("ink" = default), if they share one.
  const current = folders.length && folders.every((f) => (f.color ?? "ink") === (folders[0].color ?? "ink")) ? (folders[0].color ?? "ink") : null;
  const pick = (c: FolderColor) => {
    void setColor(folders, c === "ink" ? null : c);
    onClose();
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      kicker="Colour"
      title={folders.length === 1 ? folders[0].name : `${folders.length} folders`}
      description="A colour makes a folder easy to spot everywhere it appears."
    >
      <div className="grid grid-cols-4 gap-2.5" role="radiogroup" aria-label="Folder colour">
        {FOLDER_COLORS.map((c) => {
          const tone = FOLDER_PALETTE[c];
          const on = current === c;
          return (
            <button
              key={c}
              role="radio"
              aria-checked={on}
              aria-label={tone.label}
              data-testid={`color-${c}`}
              onClick={() => pick(c)}
              className={cn("lift group relative flex aspect-square flex-col items-center justify-center gap-2 border-[1.5px] transition", on ? "border-line-strong" : "border-transparent")}
              style={{ background: tone.bg, color: tone.fg }}
            >
              <FolderGlyph className="size-9 transition-transform duration-200 group-hover:scale-110" />
              <span className="text-[12.5px] font-semibold">{tone.label}</span>
              {on ? (
                <span className="absolute right-1.5 top-1.5 flex size-5 items-center justify-center bg-surface text-ink">
                  <Check className="size-3.5" strokeWidth={3} />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
