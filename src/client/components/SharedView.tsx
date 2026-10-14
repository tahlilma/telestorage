"use client";
import { Copy, Download, ExternalLink, Eye, EyeOff, FileInput, Hourglass, Inbox, Lock, Pencil, Power } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { formatAgo, formatBytes, formatFullDate, plural } from "@/lib/format";
import type { Share, ShareItem } from "@/lib/types";
import { deleteShare, sendShareLink, shareUrl } from "../actions";
import { useShares } from "../queries";
import { useUi } from "../store";
import { EmptyBoxArt, EmptyLinkArt } from "./Brand";
import { Empty, PageTitle, useTitle } from "./DriveView";
import { NodeThumb, TypeIcon } from "./NodeVisual";
import { Badge, Button, cn, Tabs } from "./ui";

export function shareName(s: Pick<Share, "title" | "items">) {
  const live = s.items.filter((i) => !i.inTrash);
  return s.title ?? (live.length === 1 ? live[0].name : plural(live.length || s.items.length, "item"));
}

export function expiryText(s: Pick<Share, "expiresAt" | "status">) {
  if (s.status === "expired" || (s.expiresAt !== null && s.expiresAt <= Date.now())) return "Expired";
  if (s.expiresAt === null) return "Never expires";
  const ms = s.expiresAt - Date.now();
  const h = ms / 3_600_000;
  return h < 1 ? `Expires in ${Math.max(1, Math.round(ms / 60_000))} min` : h < 48 ? `Expires in ${Math.round(h)} h` : `Expires ${formatFullDate(s.expiresAt)}`;
}

const STATUS_TEXT: Record<Share["status"], string> = {
  active: "Active",
  expired: "Expired",
  exhausted: "Download limit reached",
  unavailable: "Files are gone",
};

/** Up to three stacked previews of what a link holds. */
export function ItemStack({ items, className }: { items: ShareItem[]; className?: string }) {
  const shown = items.slice(0, 3);
  return (
    <div className={cn("relative size-14 shrink-0", className)}>
      {shown.map((it, i) => {
        const node = { ...it, parentId: null, starred: false, trashedAt: null, createdAt: 0, updatedAt: 0 };
        const style = { transform: `translate(${i * 5}px, ${i * -5}px)`, zIndex: 3 - i };
        return (
          <div key={it.id} className="absolute inset-0 border border-line-strong bg-surface" style={style}>
            {it.kind === "file" && it.hasThumb ? <NodeThumb node={node} className="size-full" /> : <TypeIcon node={node} className="size-full" />}
          </div>
        );
      })}
    </div>
  );
}

function LinkCard({ share, delay }: { share: Share; delay: number }) {
  const [confirm, setConfirm] = useState(false);
  const active = share.status === "active";
  const live = share.items.filter((i) => !i.inTrash);
  const request = share.kind === "request";
  const url = shareUrl(share.id, share.kind);
  return (
    <li
      className={cn("lift border border-line bg-surface p-4 animate-rise", !active && "opacity-75")}
      style={{ animationDelay: `${delay}ms` }}
      data-testid={request ? "request-row-owner" : "share-row"}
    >
      <div className="flex items-start gap-4">
        {request ? (
          <span className="flex size-14 shrink-0 items-center justify-center bg-accent text-on-accent">
            <Inbox className="size-6" />
          </span>
        ) : (
          <ItemStack items={share.items} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-[16px] font-semibold text-ink">{shareName(share)}</h3>
            <Badge tone={active ? "success" : "danger"}>{STATUS_TEXT[share.status]}</Badge>
            {share.hasPassword ? (
              <Badge tone="ink">
                <Lock className="size-3" /> Password
              </Badge>
            ) : null}
            {request ? (
              <Badge tone="neutral">
                <FileInput className="size-3" /> Upload only
              </Badge>
            ) : !share.allowDownload ? (
              <Badge tone="neutral">
                <EyeOff className="size-3" /> View only
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 truncate text-[13px] text-ink-3">
            {request ? <>Files land in “{live[0]?.name ?? share.items[0]?.name}”</> : live.length > 1 ? live.map((i) => i.name).join(", ") : live[0]?.name}
            {share.items.length !== live.length ? ` · ${share.items.length - live.length} in trash` : ""}
          </p>
          {share.note ? <p className="mt-1.5 line-clamp-2 border-l-2 border-accent pl-2 text-[13.5px] text-ink-2">{share.note}</p> : null}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-ink-3 tabular">
            {request ? (
              <span className="inline-flex items-center gap-1 font-medium text-ink" data-testid="request-received">
                <Inbox className="size-3.5" /> {share.received.toLocaleString()} file{share.received === 1 ? "" : "s"} received
                {share.receivedBytes ? ` · ${formatBytes(share.receivedBytes)}` : ""}
              </span>
            ) : (
              <>
                <span className="inline-flex items-center gap-1">
                  <Eye className="size-3.5" /> {share.views.toLocaleString()} view{share.views === 1 ? "" : "s"}
                </span>
                <span className="inline-flex items-center gap-1">
                  <Download className="size-3.5" /> {share.downloads.toLocaleString()}
                  {share.maxDownloads ? ` / ${share.maxDownloads}` : ""} download{share.downloads === 1 ? "" : "s"}
                </span>
              </>
            )}
            <span className="inline-flex items-center gap-1">
              <Hourglass className="size-3.5" /> {expiryText(share)}
            </span>
            <span>{share.lastAccessAt ? `Last opened ${formatAgo(share.lastAccessAt)}` : `Created ${formatAgo(share.createdAt)}`}</span>
          </div>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <Button
          size="sm"
          disabled={!active}
          onClick={async () => {
            const r = await sendShareLink(share, shareName(share));
            if (r === "copied") toast.success("Link copied");
            else if (r === "failed") toast("Copying was blocked", { description: url });
          }}
        >
          <Copy className="size-3.5" /> Copy link
        </Button>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className={cn("inline-flex h-9 items-center gap-2 border-[1.5px] border-line-strong px-3 text-[13.5px] font-medium text-ink hover:bg-invert hover:text-on-invert", !active && "pointer-events-none opacity-45")}
        >
          <ExternalLink className="size-3.5" /> Open
        </a>
        <Button size="sm" variant="ghost" onClick={() => useUi.getState().openDialog({ type: "editShare", share })}>
          <Pencil className="size-3.5" /> Edit
        </Button>
        <Button
          size="sm"
          variant={confirm ? "danger" : "ghost"}
          className="ml-auto"
          onClick={async () => {
            if (!confirm) {
              setConfirm(true);
              setTimeout(() => setConfirm(false), 3500);
              return;
            }
            await deleteShare(share.id).catch(() => toast.error("Could not turn the link off"));
            toast("Link turned off", { description: "Anyone opening it now sees that it's gone." });
          }}
        >
          <Power className="size-3.5" /> {confirm ? "Turn off?" : "Turn off"}
        </Button>
      </div>
    </li>
  );
}

export function SharedView() {
  const { data, isPending } = useShares();
  const [tab, setTab] = useState<"active" | "requests" | "inactive">("active");
  useTitle("Shared links");
  const shares = data?.shares ?? [];
  const active = shares.filter((s) => s.status === "active" && s.kind !== "request");
  const requests = shares.filter((s) => s.status === "active" && s.kind === "request");
  const inactive = shares.filter((s) => s.status !== "active");
  const list = tab === "active" ? active : tab === "requests" ? requests : inactive;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[980px] px-3 pb-16 pt-4 md:px-6 md:pt-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <PageTitle title="Shared links" sub="Everything you've shared, and who opened it" />
          <Tabs
            layoutId="shared-tabs"
            value={tab}
            onChange={setTab}
            options={[
              { value: "active", label: "Links", count: active.length },
              { value: "requests", label: "File requests", count: requests.length },
              { value: "inactive", label: "Inactive", count: inactive.length },
            ]}
          />
        </div>
        <div className="mt-6">
          {isPending ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="skeleton h-36" />
              ))}
            </div>
          ) : list.length ? (
            <ul className="space-y-3" key={tab}>
              {list.map((s, i) => (
                <LinkCard key={s.id} share={s} delay={i * 40} />
              ))}
            </ul>
          ) : (
            <div className="flex justify-center py-12">
              <Empty
                art={tab === "requests" ? <EmptyBoxArt /> : <EmptyLinkArt />}
                title={tab === "active" ? "No active links" : tab === "requests" ? "No file requests" : "Nothing inactive"}
                text={
                  tab === "active"
                    ? "Share any file or folder — or several at once — from its ⋮ menu. Links can expire, need a password, or stop after a number of downloads."
                    : tab === "requests"
                      ? "Want files from someone? Open a folder's ⋮ menu and choose “Request files…”. They upload through a link and never see what's in the folder."
                      : "Expired links, links that reached their download limit, and links to deleted files land here."
                }
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
