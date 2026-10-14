"use client";
import { Check, ChevronRight, Copy, CopyPlus, ExternalLink, Flame, Inbox, Lock, Replace, Share2, SkipForward } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { encode } from "uqr";
import { formatBytes, formatDate, plural } from "@/lib/format";
import type { DriveNode, Share, ShareOptions } from "@/lib/types";
import { copyNodes, createFolder, createRequest, createShare, deleteForever, deleteShare, emptyTrash, moveNodes, renameNode, sendShareLink, shareUrl, updateShare } from "../actions";
import { ApiError, copyText } from "../api";
import { useFolderTree, useShares } from "../queries";
import { enqueueUploads } from "../upload/engine";
import { useUi, type DialogState } from "../store";
import { ColorDialog, VersionsDialog } from "./FeatureDialogs";
import { FolderGlyph } from "./NodeVisual";
import { expiryText, ItemStack, shareName } from "./SharedView";
import { Badge, Button, cn, Kbd, Modal, Spinner, Switch, TextField } from "./ui";

export function Dialogs() {
  const dialog = useUi((s) => s.dialog);
  const close = () => useUi.getState().closeDialog();
  return (
    <>
      <ConflictDialog />
      {dialog ? <DialogSwitch dialog={dialog} close={close} /> : null}
    </>
  );
}

function DialogSwitch({ dialog, close }: { dialog: DialogState; close: () => void }) {
  switch (dialog.type) {
    case "versions":
      return <VersionsDialog node={dialog.node} onClose={close} />;
    case "color":
      return <ColorDialog nodes={dialog.nodes} onClose={close} />;
    case "request":
      return <RequestDialog folder={dialog.folder} onClose={close} />;
    case "editRequest":
      return <EditShareDialog share={dialog.share} onClose={close} />;
    case "newFolder":
    case "rename":
      return <NameDialog dialog={dialog} onClose={close} />;
    case "move":
    case "copy":
      return <MoveDialog nodes={dialog.nodes} mode={dialog.type} onClose={close} />;
    case "receive":
      return <MoveDialog nodes={[]} mode="upload" files={dialog.files} onClose={close} />;
    case "share":
      return <ShareDialog nodes={dialog.nodes} onClose={close} />;
    case "editShare":
      return <EditShareDialog share={dialog.share} onClose={close} />;
    case "deleteForever":
      return (
        <ConfirmDelete
          title={dialog.nodes.length === 1 ? `Delete “${dialog.nodes[0].name}” forever?` : `Delete ${dialog.nodes.length} items forever?`}
          text={`${dialog.nodes.length === 1 ? "It" : "They"} disappear from your files now and from the Telegram channel within seconds. Copies that share the same bytes keep them. This can't be undone.`}
          action="Delete forever"
          onClose={close}
          onConfirm={() => void deleteForever(dialog.nodes)}
        />
      );
    case "emptyTrash":
      return (
        <ConfirmDelete
          title="Empty the trash?"
          text="Everything in the trash is deleted forever and removed from the Telegram channel. This can't be undone."
          action="Empty trash"
          onClose={close}
          onConfirm={() => void emptyTrash()}
        />
      );
    case "shortcuts":
      return <ShortcutsDialog onClose={close} />;
  }
}

function ConfirmDelete({ title, text, action, onClose, onConfirm }: { title: string; text: string; action: string; onClose: () => void; onConfirm: () => void }) {
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      kicker="Can't be undone"
      title={title}
      description={text}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep
          </Button>
          <Button
            variant="danger"
            autoFocus
            data-testid="confirm-delete"
            onClick={() => {
              onClose();
              onConfirm();
            }}
          >
            <Flame className="size-4" /> {action}
          </Button>
        </>
      }
    />
  );
}

function NameDialog({ dialog, onClose }: { dialog: Extract<DialogState, { type: "newFolder" | "rename" }>; onClose: () => void }) {
  const initial = dialog.type === "rename" ? dialog.node.name : "New folder";
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Select the base name, leaving the extension untouched.
    const dot = dialog.type === "rename" && dialog.node.kind === "file" ? initial.lastIndexOf(".") : -1;
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [dialog, initial]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    if (dialog.type === "rename") {
      if (trimmed !== dialog.node.name) {
        const clash = await renameNode(dialog.node, trimmed);
        if (clash) {
          setError(clash);
          setBusy(false);
          return;
        }
      }
    } else {
      await createFolder(dialog.parentId, trimmed);
    }
    onClose();
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      kicker={dialog.type === "rename" ? "Rename" : "New folder"}
      title={dialog.type === "rename" ? `Rename “${dialog.node.name}”` : "Create a folder"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!name.trim() || busy} data-testid="name-submit">
            {dialog.type === "rename" ? "Rename" : "Create"}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          ref={ref}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          maxLength={255}
          aria-label="Name"
          label="Name"
          error={error}
        />
      </form>
    </Modal>
  );
}

/** Picks a folder: to move or copy items there — or, for files shared from another app, to upload them there. */
function MoveDialog({ nodes, mode, files = [], onClose }: { nodes: DriveNode[]; mode: "move" | "copy" | "upload"; files?: File[]; onClose: () => void }) {
  const [folderId, setFolderId] = useState(nodes[0]?.parentId ?? "root");
  const [selected, setSelected] = useState<string | null>(null);
  const { data, isPending } = useFolderTree(folderId);
  const moving = new Set(nodes.map((n) => n.id));
  const target = selected ?? folderId;
  const label = (c: { id: string; name: string }) => (c.id === "root" ? "My files" : c.name);
  const targetName = selected ? data?.items.find((f) => f.id === selected)?.name : data ? label(data.folder) : undefined;
  const unchanged = mode === "move" && nodes.every((n) => n.parentId === target);
  const open = (id: string) => {
    setFolderId(id);
    setSelected(null);
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      width="max-w-lg"
      kicker={mode === "upload" ? "Save to Telestorage" : mode === "move" ? "Move" : "Copy"}
      title={
        mode === "upload"
          ? files.length === 1
            ? `“${files[0].name}”`
            : `${files.length} shared files`
          : nodes.length === 1
            ? `“${nodes[0].name}”`
            : `${nodes.length} items`
      }
      description={mode === "upload" ? "Pick the folder they should go into." : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={unchanged || moving.has(target)}
            data-testid="move-confirm"
            onClick={() => {
              onClose();
              if (mode === "upload") void enqueueUploads(files.map((file) => ({ file })), target, [], targetName ?? "My files");
              else if (mode === "move") void moveNodes(nodes, target, targetName);
              else void copyNodes(nodes, target);
            }}
          >
            {mode === "upload" ? "Upload" : mode === "move" ? "Move" : "Copy"} to {targetName ? `“${targetName.length > 22 ? `${targetName.slice(0, 21)}…` : targetName}”` : "here"}
          </Button>
        </>
      }
    >
      <div className="mb-2 flex flex-wrap items-center gap-0.5 text-[14px]">
        {(data?.path ?? []).map((c, i, arr) => (
          <span key={c.id} className="flex items-center">
            <button onClick={() => open(c.id)} className={cn("px-1.5 py-1 hover:bg-surface-3", i === arr.length - 1 ? "font-semibold text-ink" : "text-ink-2")}>
              {label(c)}
            </button>
            {i < arr.length - 1 ? <ChevronRight className="size-4 text-ink-3" /> : null}
          </span>
        ))}
      </div>
      <div className="h-72 overflow-y-auto border-[1.5px] border-line-strong bg-surface">
        {isPending ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : data?.items.length ? (
          data.items.map((f) => {
            const disabled = moving.has(f.id);
            return (
              <div key={f.id} className={cn("group flex h-12 w-full items-center border-b border-line text-[14.5px] last:border-b-0", selected === f.id ? "bg-invert text-on-invert" : "hover:bg-surface-2", disabled && "opacity-40")}>
                <button disabled={disabled} onClick={() => setSelected(f.id === selected ? null : f.id)} onDoubleClick={() => open(f.id)} className="flex h-full min-w-0 flex-1 items-center gap-3 px-3 text-left">
                  <FolderGlyph className="size-5" />
                  <span className="min-w-0 flex-1 truncate font-medium">{f.name}</span>
                </button>
                {!disabled ? (
                  <button aria-label={`Open ${f.name}`} onClick={() => open(f.id)} className="mr-1 flex size-9 items-center justify-center opacity-70 hover:opacity-100">
                    <ChevronRight className="size-4" />
                  </button>
                ) : null}
              </div>
            );
          })
        ) : (
          <div className="flex h-full items-center justify-center text-[14px] text-ink-3">No folders inside</div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

type Expiry = "never" | "1d" | "7d" | "30d" | "custom";
const EXPIRY: { value: Expiry; label: string; hours?: number }[] = [
  { value: "never", label: "Never" },
  { value: "1d", label: "1 day", hours: 24 },
  { value: "7d", label: "7 days", hours: 24 * 7 },
  { value: "30d", label: "30 days", hours: 24 * 30 },
  { value: "custom", label: "Pick a date" },
];

interface LinkForm {
  title: string;
  expiry: Expiry;
  customAt: string;
  passwordOn: boolean;
  password: string;
  allowDownload: boolean;
  limitOn: boolean;
  limit: string;
  note: string;
  /** File requests: cap the size of each file. */
  sizeOn: boolean;
  sizeMb: string;
}

const toLocalInput = (ms: number) => {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

function formFromShare(s: Share | null): LinkForm {
  return {
    title: s?.title ?? "",
    expiry: s?.expiresAt ? "custom" : "never",
    customAt: s?.expiresAt ? toLocalInput(s.expiresAt) : toLocalInput(Date.now() + 7 * 86_400_000),
    passwordOn: !!s?.hasPassword,
    password: "",
    allowDownload: s?.allowDownload ?? true,
    limitOn: !!s?.maxDownloads,
    limit: String(s?.maxDownloads ?? 10),
    note: s?.note ?? "",
    sizeOn: !!s?.maxBytes,
    sizeMb: String(s?.maxBytes ? Math.round(s.maxBytes / 1048576) : 1024),
  };
}

/** Turns the form into API options; `existing` keeps an unchanged password. */
function formToOptions(f: LinkForm, existing: Share | null, kind: Share["kind"] = "share"): ShareOptions | string {
  const opts: ShareOptions = { title: f.title.trim() || null, note: f.note.trim() || null };
  if (kind === "share") opts.allowDownload = f.allowDownload;
  const preset = EXPIRY.find((e) => e.value === f.expiry);
  if (f.expiry === "never") opts.expiresAt = null;
  else if (f.expiry === "custom") {
    const at = new Date(f.customAt).getTime();
    if (!Number.isFinite(at) || at <= Date.now()) return "Pick an expiry date in the future";
    opts.expiresAt = at;
  } else opts.expiresAt = Date.now() + (preset?.hours ?? 0) * 3_600_000;
  if (f.passwordOn) {
    if (f.password) {
      if (f.password.length < 4) return "Use at least 4 characters for the password";
      opts.password = f.password;
    } else if (!existing?.hasPassword) return "Type a password, or turn the password off";
  } else if (existing?.hasPassword || !existing) opts.password = null;
  if (kind === "request") {
    if (f.sizeOn) {
      const mb = Number(f.sizeMb);
      if (!Number.isFinite(mb) || mb <= 0) return "The size limit must be a number of MB";
      opts.maxBytes = Math.round(mb * 1048576);
    } else opts.maxBytes = null;
    return opts;
  }
  if (f.limitOn) {
    const n = Number(f.limit);
    if (!Number.isInteger(n) || n < 1) return "The download limit must be a whole number from 1";
    opts.maxDownloads = n;
  } else opts.maxDownloads = null;
  return opts;
}

function LinkOptions({
  form,
  set,
  bundle,
  existing,
  kind = "share",
}: {
  form: LinkForm;
  set: (p: Partial<LinkForm>) => void;
  bundle: boolean;
  existing: Share | null;
  kind?: Share["kind"];
}) {
  const [minAt] = useState(() => toLocalInput(Date.now() + 60_000));
  return (
    <div className="space-y-5">
      {kind === "request" ? (
        <TextField label="What are you asking for? (shown to people)" placeholder="e.g. Photos from the wedding" value={form.title} maxLength={120} onChange={(e) => set({ title: e.target.value })} />
      ) : bundle || existing ? (
        <TextField label="Link name (shown to visitors)" placeholder={bundle ? "e.g. Holiday photos" : "Uses the item's name"} value={form.title} maxLength={120} onChange={(e) => set({ title: e.target.value })} />
      ) : null}
      <div>
        <div className="mb-1.5 text-[13px] font-medium text-ink-2">Expires</div>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Expires">
          {EXPIRY.map((e) => (
            <button
              key={e.value}
              role="radio"
              aria-checked={form.expiry === e.value}
              onClick={() => set({ expiry: e.value })}
              className={cn("h-9 border px-3 text-[13.5px] font-medium transition-colors", form.expiry === e.value ? "border-line-strong bg-invert text-on-invert" : "border-line bg-surface text-ink-2 hover:border-line-strong")}
            >
              {e.label}
            </button>
          ))}
        </div>
        {form.expiry === "custom" ? (
          <input
            type="datetime-local"
            aria-label="Expiry date"
            value={form.customAt}
            min={minAt}
            onChange={(e) => set({ customAt: e.target.value })}
            className="mt-2 h-11 w-full border-[1.5px] border-line-strong bg-surface px-3 text-[15px] text-ink outline-none focus:shadow-hard-sm"
          />
        ) : null}
      </div>
      <div className="space-y-4 border-t border-line pt-4">
        <Switch checked={form.passwordOn} onChange={(v) => set({ passwordOn: v })} label="Require a password" description="Visitors type it once per device." />
        {form.passwordOn ? (
          <TextField
            type="text"
            autoComplete="off"
            aria-label="Link password"
            placeholder={existing?.hasPassword ? "Leave empty to keep the current password" : "At least 4 characters"}
            value={form.password}
            onChange={(e) => set({ password: e.target.value })}
          />
        ) : null}
        {kind === "request" ? (
          <>
            <Switch checked={form.sizeOn} onChange={(v) => set({ sizeOn: v })} label="Limit file size" description="Bigger files are refused before a byte is sent." />
            {form.sizeOn ? (
              <TextField type="number" min={1} inputMode="numeric" aria-label="Largest file in MB" hint="MB per file" value={form.sizeMb} onChange={(e) => set({ sizeMb: e.target.value })} />
            ) : null}
          </>
        ) : (
          <>
            <Switch checked={form.allowDownload} onChange={(v) => set({ allowDownload: v })} label="Allow downloads" description="Off: visitors can look at files in the browser, without download buttons." />
            <Switch checked={form.limitOn} onChange={(v) => set({ limitOn: v })} label="Limit downloads" description="The link stops working after this many downloads." />
            {form.limitOn ? <TextField type="number" min={1} inputMode="numeric" aria-label="Download limit" value={form.limit} onChange={(e) => set({ limit: e.target.value })} /> : null}
          </>
        )}
      </div>
      <div className="border-t border-line pt-4">
        <label htmlFor="share-note" className="mb-1.5 block text-[13px] font-medium text-ink-2">
          Note to visitors (optional)
        </label>
        <textarea
          id="share-note"
          value={form.note}
          maxLength={1000}
          rows={2}
          placeholder={kind === "request" ? "e.g. Anything from Saturday — thanks!" : "Shown at the top of the shared page"}
          onChange={(e) => set({ note: e.target.value })}
          className="w-full resize-none border-[1.5px] border-line-strong bg-surface px-3 py-2.5 text-[15px] text-ink outline-none placeholder:text-ink-3 focus:shadow-hard-sm"
        />
      </div>
    </div>
  );
}

/** QR code as crisp SVG modules; always dark on light so every scanner reads it. */
function QrCode({ text, className }: { text: string; className?: string }) {
  const { d, size } = useMemo(() => {
    const qr = encode(text, { ecc: "M", border: 1 });
    let path = "";
    qr.data.forEach((row, y) =>
      row.forEach((on, x) => {
        if (on) path += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { d: path, size: qr.size };
  }, [text]);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className={className} shapeRendering="crispEdges" role="img" aria-label="QR code of the link" data-testid="share-qr">
      <rect width={size} height={size} fill="#ffffff" />
      <path d={d} fill="#111111" />
    </svg>
  );
}

function LinkResult({ share, onDone, onAnother }: { share: Share; onDone: () => void; onAnother?: () => void }) {
  const [copied, setCopied] = useState(false);
  const url = shareUrl(share.id, share.kind);
  const name = shareName(share);
  const request = share.kind === "request";
  const copy = async () => {
    if (await copyText(url)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } else toast("Copying was blocked by the browser", { description: url });
  };
  return (
    <div className="animate-pop-in" data-testid="share-result">
      <div className="flex flex-col gap-4 border-[1.5px] border-line-strong bg-surface-2 p-4 sm:flex-row sm:items-center">
        <QrCode text={url} className="size-28 shrink-0 self-center border border-line" />
        <div className="min-w-0 flex-1">
          <div className="label text-accent">{request ? "Request ready" : "Link ready"}</div>
          <div className="mt-1 truncate text-[16px] font-semibold text-ink">{name}</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge tone="neutral">{expiryText(share)}</Badge>
            {share.hasPassword ? (
              <Badge tone="ink">
                <Lock className="size-3" /> Password
              </Badge>
            ) : null}
            {request ? <Badge tone="neutral">Upload only</Badge> : !share.allowDownload ? <Badge tone="neutral">View only</Badge> : null}
            {share.maxBytes ? <Badge tone="neutral">Up to {formatBytes(share.maxBytes)} per file</Badge> : null}
            {share.maxDownloads ? <Badge tone="neutral">Max {plural(share.maxDownloads, "download")}</Badge> : null}
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 border-[1.5px] border-line-strong bg-surface p-1.5 pl-3">
        <span className="min-w-0 flex-1 truncate text-[14px] text-ink" data-testid="share-url">
          {url}
        </span>
        <a href={url} target="_blank" rel="noreferrer" aria-label="Open link" className="flex size-9 items-center justify-center text-ink-2 hover:bg-surface-3 hover:text-ink">
          <ExternalLink className="size-4" />
        </a>
        <Button size="sm" onClick={() => void copy()} data-testid="copy-link">
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2 max-sm:[&>*]:flex-1">
        {onAnother ? (
          <Button variant="ghost" onClick={onAnother}>
            New link
          </Button>
        ) : null}
        {typeof navigator !== "undefined" && typeof navigator.share === "function" ? (
          <Button variant="outline" onClick={() => void sendShareLink(share, name)}>
            <Share2 className="size-4" /> Send…
          </Button>
        ) : null}
        <Button onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

function ShareDialog({ nodes, onClose }: { nodes: DriveNode[]; onClose: () => void }) {
  const single = nodes.length === 1 ? nodes[0] : null;
  const { data } = useShares(single?.id);
  const existing = single ? (data?.shares ?? []).filter((s) => s.items.length === 1 && s.status === "active") : [];
  const [form, setForm] = useState<LinkForm>(() => ({ ...formFromShare(null), title: "" }));
  const [created, setCreated] = useState<Share | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<LinkForm>) => {
    setForm((f) => ({ ...f, ...p }));
    setError(null);
  };
  const items = nodes.map((n) => ({ id: n.id, name: n.name, kind: n.kind, size: n.size, mime: n.mime, blobId: n.blobId, hasThumb: n.hasThumb, inTrash: false }));

  const create = async () => {
    const opts = formToOptions(form, null);
    if (typeof opts === "string") return setError(opts);
    setBusy(true);
    try {
      setCreated(await createShare(nodes.map((n) => n.id), opts));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not create the link");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      width="max-w-lg"
      kicker="Share"
      title={
        <span className="flex items-center gap-3">
          <ItemStack items={items} className="size-11" />
          <span className="min-w-0 truncate">{single ? single.name : `${nodes.length} items`}</span>
        </span>
      }
      description={created ? undefined : "Anyone with the link can open it — no account needed. You can change or turn it off any time."}
    >
      {created ? (
        <LinkResult share={created} onDone={onClose} onAnother={() => setCreated(null)} />
      ) : (
        <>
          {existing.length ? (
            <div className="mb-6">
              <div className="label mb-2 text-ink-3">Already shared</div>
              <ul className="divide-y divide-line border border-line">
                {existing.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-medium text-ink">{expiryText(s)}</div>
                      <div className="text-[12.5px] text-ink-3 tabular">
                        {plural(s.views, "view")} · {plural(s.downloads, "download")}
                        {s.hasPassword ? " · password" : ""}
                        {!s.allowDownload ? " · view only" : ""}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        const r = await sendShareLink(s, single?.name ?? "Shared");
                        if (r === "copied") toast.success("Link copied");
                      }}
                    >
                      <Copy className="size-3.5" /> Copy
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => useUi.getState().openDialog({ type: "editShare", share: s })}>
                      Edit
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="label mb-3 text-ink-3">{existing.length ? "New link" : "Link settings"}</div>
          <LinkOptions form={form} set={set} bundle={nodes.length > 1} existing={null} />
          {error ? <p className="mt-4 text-[13.5px] font-medium text-danger">{error}</p> : null}
          <div className="mt-6 flex flex-wrap justify-end gap-2 max-sm:[&>*]:flex-1">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => void create()} disabled={busy} data-testid="create-link">
              {busy ? <Spinner className="size-4 text-on-invert" /> : <Share2 className="size-4" />} Create link
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

/**
 * A file request: a link people use to send you files. They land in `folder`;
 * the visitor sees only your title and note, never the folder or its files.
 */
function RequestDialog({ folder, onClose }: { folder: DriveNode; onClose: () => void }) {
  const [form, setForm] = useState<LinkForm>(() => ({ ...formFromShare(null), title: `Files for ${folder.name}` }));
  const [created, setCreated] = useState<Share | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<LinkForm>) => {
    setForm((f) => ({ ...f, ...p }));
    setError(null);
  };
  const create = async () => {
    const opts = formToOptions(form, null, "request");
    if (typeof opts === "string") return setError(opts);
    setBusy(true);
    try {
      setCreated(await createRequest(folder, opts));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not create the request");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      width="max-w-lg"
      kicker="Request files"
      title={
        <span className="flex items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center bg-accent text-on-accent">
            <Inbox className="size-5" />
          </span>
          <span className="min-w-0 truncate">Into “{folder.name}”</span>
        </span>
      }
      description={created ? undefined : "Anyone with the link can upload files into this folder — no account needed. They can't see what's in it, or what anyone else sent."}
    >
      {created ? (
        <LinkResult share={created} onDone={onClose} />
      ) : (
        <>
          <LinkOptions form={form} set={set} bundle={false} existing={null} kind="request" />
          {error ? <p className="mt-4 text-[13.5px] font-medium text-danger">{error}</p> : null}
          <div className="mt-6 flex flex-wrap justify-end gap-2 max-sm:[&>*]:flex-1">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => void create()} disabled={busy} data-testid="create-request">
              {busy ? <Spinner className="size-4 text-on-invert" /> : <Inbox className="size-4" />} Create request
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

function EditShareDialog({ share, onClose }: { share: Share; onClose: () => void }) {
  const [form, setForm] = useState<LinkForm>(() => formFromShare(share));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Share | null>(null);
  const set = (p: Partial<LinkForm>) => {
    setForm((f) => ({ ...f, ...p }));
    setError(null);
  };
  const save = async () => {
    const opts = formToOptions(form, share, share.kind);
    if (typeof opts === "string") return setError(opts);
    setBusy(true);
    try {
      setSaved(await updateShare(share.id, opts));
      toast.success("Link updated");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save the link");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      width="max-w-lg"
      kicker={share.kind === "request" ? "Edit file request" : "Edit link"}
      title={shareName(share)}
      description={
        share.kind === "request"
          ? `${plural(share.received, "file")} received (${formatBytes(share.receivedBytes)}) · created ${formatDate(share.createdAt)}`
          : `${plural(share.views, "view")} · ${plural(share.downloads, "download")} · created ${formatDate(share.createdAt)}`
      }
    >
      {saved ? (
        <LinkResult share={saved} onDone={onClose} />
      ) : (
        <>
          <LinkOptions form={form} set={set} bundle={share.items.length > 1} existing={share} kind={share.kind} />
          {error ? <p className="mt-4 text-[13.5px] font-medium text-danger">{error}</p> : null}
          <div className="mt-6 flex flex-wrap items-center justify-end gap-2 max-sm:[&>*]:flex-1">
            <Button
              variant="ghost"
              className="mr-auto text-danger hover:text-danger"
              onClick={async () => {
                await deleteShare(share.id).catch(() => toast.error("Could not turn the link off"));
                toast("Link turned off");
                onClose();
              }}
            >
              Turn off link
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={busy}>
              {busy ? <Spinner className="size-4 text-on-invert" /> : null} Save
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Duplicate names during an upload
// ---------------------------------------------------------------------------

const POLICIES = [
  { value: "keep", icon: CopyPlus, title: "Keep both", text: "Upload them with a number added: “photo (1).jpg”." },
  { value: "replace", icon: Replace, title: "Replace", text: "Saves them as new versions — the old ones stay in each file's version history." },
  { value: "skip", icon: SkipForward, title: "Skip", text: "Leave the existing files alone; upload only the new ones." },
] as const;

function ConflictDialog() {
  const conflict = useUi((s) => s.conflict);
  const [choice, setChoice] = useState<"keep" | "replace" | "skip">("keep");
  if (!conflict) return null;
  const n = conflict.items.length;
  const sameSize = conflict.items.filter((i) => i.size === i.existingSize).length;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && conflict.resolve(null)}
      width="max-w-lg"
      kicker="Already there"
      title={n === 1 ? `“${conflict.items[0].path.split("/").pop()}” already exists` : `${n} files already exist`}
      description={`In “${conflict.folderName}”. ${sameSize ? "If a file turns out to be exactly the same, nothing new is uploaded whichever you pick." : "Other files upload normally."}`}
      footer={
        <>
          <Button variant="ghost" onClick={() => conflict.resolve(null)}>
            Cancel upload
          </Button>
          <Button onClick={() => conflict.resolve(choice)} data-testid="conflict-continue" autoFocus>
            Continue
          </Button>
        </>
      }
    >
      <ul className="max-h-40 divide-y divide-line overflow-y-auto border border-line" data-testid="conflict-list">
        {conflict.items.slice(0, 50).map((i) => (
          <li key={i.path} className="flex items-center gap-3 px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{i.path}</span>
            <span className="shrink-0 text-[12px] text-ink-3 tabular">
              {i.size === i.existingSize ? "same size" : `${formatBytes(i.existingSize)} → ${formatBytes(i.size)}`}
            </span>
          </li>
        ))}
        {n > 50 ? <li className="px-3 py-2 text-[12.5px] text-ink-3">+ {n - 50} more</li> : null}
      </ul>
      <div className="mt-4 space-y-2" role="radiogroup" aria-label="What to do">
        {POLICIES.map((p) => {
          const Icon = p.icon;
          const on = choice === p.value;
          return (
            <button
              key={p.value}
              role="radio"
              aria-checked={on}
              data-testid={`conflict-${p.value}`}
              onClick={() => setChoice(p.value)}
              className={cn("flex w-full items-start gap-3 border-[1.5px] p-3 text-left transition-[background-color,border-color,box-shadow]", on ? "border-line-strong bg-surface-2 shadow-hard-sm" : "border-line hover:border-line-strong")}
            >
              <span className={cn("flex size-9 shrink-0 items-center justify-center", on ? "bg-accent text-on-accent" : "bg-surface-3 text-ink-2")}>
                <Icon className="size-[18px]" />
              </span>
              <span>
                <span className="block text-[15px] font-semibold text-ink">{p.title}</span>
                <span className="block text-[13px] text-ink-3">{p.text}</span>
              </span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

const SHORTCUTS: [string, string[]][] = [
  ["Search", ["/"]],
  ["Upload files", ["Shift", "U"]],
  ["New folder", ["Shift", "N"]],
  ["Select all", ["Ctrl", "A"]],
  ["Open / preview", ["Enter"]],
  ["Rename", ["F2"]],
  ["Move to trash", ["Del"]],
  ["Delete forever", ["Shift", "Del"]],
  ["Star", ["S"]],
  ["Cut / copy / paste", ["Ctrl", "X / C / V"]],
  ["Download", ["Ctrl", "D"]],
  ["Grid / list", ["V"]],
  ["Details panel", ["I"]],
  ["Clear selection / close", ["Esc"]],
  ["Previous / next in preview", ["←", "→"]],
];

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} kicker="Keyboard" title="Shortcuts" width="max-w-xl">
      <div className="grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
        {SHORTCUTS.map(([label, keys]) => (
          <div key={label} className="flex items-center justify-between gap-3 text-[14px]">
            <span className="text-ink-2">{label}</span>
            <span className="flex gap-1">
              {keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </span>
          </div>
        ))}
      </div>
    </Modal>
  );
}
