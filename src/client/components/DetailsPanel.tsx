"use client";
import { Check, Copy, History, Link2, Lock, Share2, ShieldAlert, ShieldCheck, ShieldQuestion, Upload, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { formatAgo, formatBytes, formatFullDate, plural } from "@/lib/format";
import { PIECE_SIZE } from "@/lib/protocol";
import { sendShareLink } from "../actions";
import { copyText } from "../api";
import { CATEGORY, categoryOf } from "../files";
import { pickNewVersion } from "../pickers";
import { useNodeDetails, useShares, type NodeDetails } from "../queries";
import type { DriveRoute } from "../router";
import { usePrefs, useUi } from "../store";
import { FolderPreview, NodeThumb, TypeTag } from "./NodeVisual";
import { expiryText } from "./SharedView";
import { Button, cn, IconButton, Spinner } from "./ui";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="py-2.5">
      <dt className="text-[12.5px] text-ink-3">{label}</dt>
      <dd className="mt-0.5 break-words text-[14px] text-ink">{children}</dd>
    </div>
  );
}

const DRIVER = { telegram: "Telegram channel", local: "Local disk", sim: "Simulated bots" } as const;

function Integrity({ storage }: { storage: NonNullable<NodeDetails["storage"]> }) {
  const state = {
    verified: {
      icon: <ShieldCheck className="size-4" />,
      tone: "bg-success-soft text-success",
      title: "Verified",
      text: storage.verifiedAt ? `Read back from storage ${formatAgo(storage.verifiedAt)} — every checksum matched.` : "Every checksum matched.",
    },
    pending: {
      icon: <ShieldQuestion className="size-4" />,
      tone: "bg-sky-soft text-sky",
      title: "Checksummed",
      text: "SHA-256 recorded at upload and verified on assembly. It's re-read from storage in the background.",
    },
    corrupt: {
      icon: <ShieldAlert className="size-4" />,
      tone: "bg-danger-soft text-danger",
      title: "Damaged copy detected",
      text: "Stored bytes no longer match their checksums. Reads refuse corrupt data; upload the original again to repair it.",
    },
    legacy: {
      icon: <ShieldQuestion className="size-4" />,
      tone: "bg-surface-3 text-ink-2",
      title: "No checksum on record",
      text: "Uploaded before checksums existed. Upload it again to add one.",
    },
  }[storage.integrity];
  return (
    <div className={cn("p-3", state.tone)} data-testid="integrity-badge" data-state={storage.integrity}>
      <div className="flex items-center gap-2 text-[14px] font-semibold">
        {state.icon} {state.title}
      </div>
      <p className="mt-1 text-[12.5px] leading-snug opacity-90">{state.text}</p>
    </div>
  );
}

function Hash({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        if (await copyText(value)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }
      }}
      className="group flex w-full items-start gap-2 bg-surface-2 p-2 text-left hover:bg-surface-3"
      aria-label="Copy SHA-256"
    >
      <span className="min-w-0 flex-1 break-all font-mono text-[11px] leading-relaxed text-ink-2">{value}</span>
      {copied ? <Check className="mt-0.5 size-3.5 shrink-0 text-success" /> : <Copy className="mt-0.5 size-3.5 shrink-0 text-ink-3 group-hover:text-ink" />}
    </button>
  );
}

function Sharing({ nodeId, name }: { nodeId: string; name: string }) {
  const { data } = useShares(nodeId);
  const active = (data?.shares ?? []).filter((s) => s.status === "active");
  const node = useUi((s) => s.visible.find((n) => n.id === nodeId));
  return (
    <div>
      <div className="mb-2 mt-5 flex items-center justify-between">
        <span className="label text-ink-3">Sharing</span>
        <span className="text-[12.5px] text-ink-3">{active.length ? `${active.length} active link${active.length === 1 ? "" : "s"}` : "Private"}</span>
      </div>
      {active.length ? (
        <ul className="mb-3 divide-y divide-line border border-line">
          {active.map((s) => (
            <li key={s.id} className="flex items-center gap-2 px-3 py-2">
              <Link2 className="size-4 shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
                  {expiryText(s)}
                  {s.hasPassword ? <Lock className="size-3 text-ink-3" /> : null}
                </div>
                <div className="text-[12px] text-ink-3 tabular">
                  {plural(s.views, "view")} · {plural(s.downloads, "download")}
                </div>
              </div>
              <IconButton
                label="Copy link"
                className="size-8 [&_svg]:size-4"
                onClick={async () => {
                  const r = await sendShareLink(s, name);
                  if (r === "copied") toast.success("Link copied");
                }}
              >
                <Copy />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : null}
      <Button variant="outline" size="sm" className="w-full" disabled={!node} onClick={() => node && useUi.getState().openDialog({ type: "share", nodes: [node] })}>
        <Share2 className="size-4" /> {active.length ? "New link…" : "Share…"}
      </Button>
    </div>
  );
}

export function DetailsPanel({ route }: { route: DriveRoute | null }) {
  const selection = useUi((s) => s.selection);
  const toggle = usePrefs((s) => s.toggleDetails);
  const selectedId = selection.size === 1 ? [...selection][0] : null;
  const fallbackId = route?.name === "folder" && route.id !== "root" ? route.id : null;
  const id = selectedId ?? fallbackId;
  const { data, isPending } = useNodeDetails(id);
  const node = data?.node;
  const storage = data?.storage;

  return (
    <aside className="hidden w-[340px] shrink-0 flex-col overflow-hidden border-l border-line bg-surface lg:flex animate-fade-in" aria-label="Details">
      <div className="flex h-16 shrink-0 items-center gap-3 border-b border-line pl-5 pr-2">
        <div className="min-w-0 flex-1">
          <div className="label text-accent">Details</div>
          <h2 className="truncate text-[15.5px] font-semibold text-ink">{node?.name ?? (selection.size > 1 ? `${selection.size} items selected` : "Nothing selected")}</h2>
        </div>
        <IconButton label="Close details" onClick={toggle}>
          <X />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-4">
        {!id ? (
          <p className="pt-10 text-center text-[14px] text-ink-3">{selection.size > 1 ? "Select a single item to see its details." : "Select a file or folder to see its details."}</p>
        ) : isPending || !node ? (
          <div className="flex justify-center pt-10">
            <Spinner />
          </div>
        ) : (
          <div key={node.id} className="animate-fade-in">
            {node.kind === "file" ? <NodeThumb node={node} className="mb-4 aspect-[4/3] w-full border border-line" /> : <FolderPreview node={node} className="mb-4 aspect-[16/10] w-full border border-line" />}
            <dl className="divide-y divide-line">
              <Field label="Type">
                <span className="flex items-center gap-2">
                  {node.kind === "file" ? <TypeTag node={node} /> : null}
                  {CATEGORY[categoryOf(node)].label}
                  {node.mime ? <span className="truncate text-[12px] text-ink-3">{node.mime}</span> : null}
                </span>
              </Field>
              {node.kind === "file" ? (
                <Field label="Size">
                  {formatBytes(node.size)} <span className="text-[12px] text-ink-3 tabular">{node.size.toLocaleString()} bytes</span>
                </Field>
              ) : (
                <Field label="Contents">
                  {`${node.childCount ?? 0} item${node.childCount === 1 ? "" : "s"}`}
                  {node.folderSize ? ` · ${formatBytes(node.folderSize)}` : ""}
                </Field>
              )}
              <Field label="Location">{data.path.slice(0, -1).map((c) => (c.id === "root" ? "My files" : c.name)).join(" / ") || "—"}</Field>
              {node.takenAt ? <Field label="Taken">{formatFullDate(node.takenAt)}</Field> : null}
              <Field label="Modified">{formatFullDate(node.updatedAt)}</Field>
              <Field label="Created">{formatFullDate(node.createdAt)}</Field>
            </dl>
            {node.kind === "file" && node.trashedAt === null ? (
              <div className="mt-6">
                <div className="mb-2 flex items-center justify-between">
                  <span className="label text-ink-3">Versions</span>
                  <span className="text-[12px] text-ink-3 tabular">{node.versionCount ? `${node.versionCount} earlier` : "Only this one"}</span>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" className="flex-1" onClick={() => useUi.getState().openDialog({ type: "versions", node })} data-testid="details-versions">
                    <History className="size-3.5" /> History
                  </Button>
                  <Button size="sm" variant="ghost" className="flex-1" onClick={() => pickNewVersion(node)}>
                    <Upload className="size-3.5" /> New version
                  </Button>
                </div>
              </div>
            ) : null}
            {node.trashedAt === null ? <Sharing nodeId={node.id} name={node.name} /> : null}
            {storage ? (
              <>
                <div className="label mb-2 mt-6 text-ink-3">Storage</div>
                <Integrity storage={storage} />
                <dl className="mt-1 divide-y divide-line">
                  <Field label="Stored on">
                    {DRIVER[storage.driver] ?? storage.driver} · {storage.parts} part{storage.parts === 1 ? "" : "s"}
                    {storage.parts > 1 ? ` × ${formatBytes(storage.partSize)}` : ""}
                  </Field>
                  <Field label="Encryption">
                    {storage.encrypted ? (
                      <span className="inline-flex items-center gap-1.5 text-success">
                        <Lock className="size-3.5" /> AES-256-CTR at rest
                      </span>
                    ) : (
                      "Not encrypted"
                    )}
                  </Field>
                  {storage.pieceChecksums ? <Field label="Piece checksums">SHA-256 for every {formatBytes(PIECE_SIZE)} piece — each read is verified</Field> : null}
                  {storage.sha256 ? (
                    <Field label="SHA-256">
                      <Hash value={storage.sha256} />
                    </Field>
                  ) : null}
                </dl>
              </>
            ) : null}
          </div>
        )}
      </div>
    </aside>
  );
}
