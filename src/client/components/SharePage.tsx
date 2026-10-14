"use client";
import { ArrowRight, ChevronRight, Download, EyeOff, FolderArchive, Lock, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatBytes, formatDate, formatFullDate } from "@/lib/format";
import type { Crumb, DriveNode } from "@/lib/types";
import { api, ApiError, downloadUrl } from "../api";
import { CATEGORY, categoryOf, previewKind } from "../files";
import { EmptyLinkArt, GeoStrip, Logo, Mark } from "./Brand";
import { FolderGlyph, NodeThumb, TypeIcon, TypeTag } from "./NodeVisual";
import { Button, cn, IconButton, Spinner, TextField } from "./ui";

interface ShareData {
  share: {
    id: string;
    title: string;
    note: string | null;
    expiresAt: number | null;
    allowDownload: boolean;
    hasPassword: boolean;
    downloadsLeft: number | null;
    bundle: boolean;
    itemCount: number;
  };
  current: DriveNode | null;
  path: Crumb[];
  items: DriveNode[];
}

type State = { kind: "loading" } | { kind: "ok"; data: ShareData } | { kind: "locked"; title: string } | { kind: "gone"; message: string; reason?: string };

export function SharePage() {
  const { token } = useParams<{ token: string }>();
  const [folder, setFolder] = useState<string | null>(() => (typeof window === "undefined" ? null : new URLSearchParams(location.search).get("folder")));
  const [state, setState] = useState<State>({ kind: "loading" });
  const [preview, setPreview] = useState<DriveNode | null>(null);
  const visited = useRef(false);

  const base = `/api/public/${token}`;
  const fileUrl = useCallback((n: DriveNode, dl = false) => `${base}/file/${n.id}/${encodeURIComponent(n.name)}${dl ? "?dl=1" : ""}`, [base]);

  /** Fetches the current view; the first successful load counts as a visit. */
  const fetchState = useCallback(async (): Promise<State> => {
    const params = new URLSearchParams();
    if (folder) params.set("folder", folder);
    if (!visited.current) params.set("visit", "1");
    try {
      const data = await api<ShareData>(`${base}${params.size ? `?${params}` : ""}`);
      visited.current = true;
      return { kind: "ok", data };
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { passwordRequired?: boolean; title?: string; reason?: string }) : null;
      if (body?.passwordRequired) return { kind: "locked", title: body.title ?? "Shared files" };
      return { kind: "gone", message: e instanceof ApiError ? e.message : "Could not open this link", reason: body?.reason };
    }
  }, [base, folder]);
  const load = useCallback(() => void fetchState().then(setState), [fetchState]);

  useEffect(() => {
    let cancelled = false;
    void fetchState().then((s) => !cancelled && setState(s));
    return () => {
      cancelled = true;
    };
  }, [fetchState]);

  useEffect(() => {
    const onPop = () => setFolder(new URLSearchParams(location.search).get("folder"));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const openFolder = (id: string | null) => {
    const root = state.kind === "ok" && !state.data.share.bundle ? state.data.path[0]?.id : null;
    const target = id && id !== root ? id : null;
    history.pushState(null, "", target ? `?folder=${target}` : location.pathname);
    setFolder(target);
  };

  if (state.kind === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas">
        <Spinner className="size-8" />
      </div>
    );
  }
  if (state.kind === "gone") return <Gone message={state.message} reason={state.reason} />;
  if (state.kind === "locked") return <Locked token={token} title={state.title} onUnlocked={load} />;

  const { data } = state;
  const { share, current } = data;
  const isFile = current?.kind === "file";
  const zipHref = `${base}/zip${folder ? `?folder=${folder}` : ""}`;

  return (
    <div className="min-h-dvh bg-canvas">
      <header className="sticky top-0 z-20 border-b border-line bg-glass backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 md:px-6">
          <span className="md:hidden">
            <Mark />
          </span>
          <span className="hidden md:block">
            <Logo />
          </span>
          <span className="mx-1 hidden h-6 w-px bg-line md:block" />
          <div className="min-w-0 flex-1">
            <div className="label text-accent">Shared with you</div>
            <div className="truncate text-[15.5px] font-semibold text-ink">{share.title}</div>
          </div>
          {share.allowDownload ? (
            <Button onClick={() => downloadUrl(isFile && current ? fileUrl(current, true) : zipHref)} data-testid="share-download">
              {isFile ? <Download className="size-4" /> : <FolderArchive className="size-4" />}
              <span className="hidden sm:inline">{isFile && current ? `Download · ${formatBytes(current.size)}` : "Download all"}</span>
            </Button>
          ) : null}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-16 pt-6 md:px-6 md:pt-8">
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-3">
          {!share.allowDownload ? (
            <span className="inline-flex items-center gap-1 bg-surface-3 px-2 py-1 font-medium text-ink-2" data-testid="view-only">
              <EyeOff className="size-3.5" /> View only
            </span>
          ) : null}
          {share.hasPassword ? (
            <span className="inline-flex items-center gap-1 bg-surface-3 px-2 py-1 font-medium text-ink-2">
              <Lock className="size-3.5" /> Protected
            </span>
          ) : null}
          <span>{share.expiresAt ? `Available until ${formatFullDate(share.expiresAt)}` : "No expiry"}</span>
          {share.downloadsLeft !== null ? <span>· {share.downloadsLeft} download{share.downloadsLeft === 1 ? "" : "s"} left</span> : null}
        </div>

        {share.note ? (
          <div className="mt-4 border-l-[3px] border-accent bg-surface px-4 py-3 text-[15px] leading-relaxed text-ink animate-rise" data-testid="share-note">
            {share.note}
          </div>
        ) : null}

        {isFile && current ? (
          <div className="mt-6 flex min-h-[60vh] items-center justify-center border border-line bg-surface p-3 animate-rise md:p-6">
            <Viewer node={current} url={fileUrl(current)} />
          </div>
        ) : (
          <>
            <nav className="mt-6 flex flex-wrap items-center text-[24px] font-semibold tracking-[-0.02em] text-ink">
              {data.path.map((c, i) => (
                <span key={c.id || "root"} className="flex items-center">
                  <button onClick={() => openFolder(c.id || null)} className={cn("px-1", i < data.path.length - 1 && "text-ink-3 hover:text-ink")}>
                    {c.name}
                  </button>
                  {i < data.path.length - 1 ? <ChevronRight className="size-5 text-ink-3" /> : null}
                </span>
              ))}
            </nav>
            {data.items.length ? (
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:gap-4 lg:grid-cols-4" key={folder ?? "root"}>
                {data.items.map((n, i) => (
                  <button
                    key={n.id}
                    onClick={() => (n.kind === "folder" ? openFolder(n.id) : setPreview(n))}
                    className="lift group flex flex-col border border-line bg-surface p-1.5 text-left animate-rise"
                    style={{ animationDelay: `${Math.min(i, 16) * 30}ms` }}
                    data-testid="share-item"
                  >
                    {n.kind === "folder" ? (
                      <div className="flex aspect-[4/3] w-full items-center justify-center bg-invert text-on-invert">
                        <FolderGlyph className="size-12" />
                      </div>
                    ) : (
                      <NodeThumb node={n} src={n.hasThumb ? `${base}/thumb/${n.id}` : null} className="aspect-[4/3] w-full" />
                    )}
                    <div className="px-1.5 pb-1 pt-2.5">
                      <div className="truncate text-[14px] font-semibold text-ink">{n.name}</div>
                      <div className="mt-1 flex items-center gap-1.5 text-[12px] text-ink-3 tabular">
                        {n.kind === "file" ? <TypeTag node={n} className="h-[16px] min-w-0 shrink-0 px-1 text-[9.5px]" /> : null}
                        <span className="min-w-0 truncate">
                          {n.kind === "folder" ? `${n.childCount ?? 0} item${n.childCount === 1 ? "" : "s"}` : formatBytes(n.size)} · {formatDate(n.updatedAt)}
                        </span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <p className="mt-10 text-center text-[15px] text-ink-3">This folder is empty.</p>
            )}
          </>
        )}
      </main>

      <AnimatePresence>
        {preview ? (
          <motion.div
            className="fixed inset-0 z-50 flex flex-col bg-[#0b0b0b]/96 text-white"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            role="dialog"
            aria-label={`Preview of ${preview.name}`}
          >
            <div className="flex h-16 items-center gap-3 px-3">
              <IconButton label="Close" className="text-white hover:bg-white/10" onClick={() => setPreview(null)}>
                <X />
              </IconButton>
              <TypeTag node={preview} />
              <span className="min-w-0 flex-1 truncate font-semibold">{preview.name}</span>
              {share.allowDownload ? (
                <IconButton label="Download" className="text-white hover:bg-white/10" onClick={() => downloadUrl(fileUrl(preview, true))}>
                  <Download />
                </IconButton>
              ) : null}
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center p-4" onClick={(e) => e.target === e.currentTarget && setPreview(null)}>
              <Viewer node={preview} url={fileUrl(preview)} dark onDownload={share.allowDownload ? () => downloadUrl(fileUrl(preview, true)) : undefined} />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function Viewer({ node, url, dark, onDownload }: { node: DriveNode; url: string; dark?: boolean; onDownload?: () => void }) {
  const kind = previewKind(node);
  if (kind === "image") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt={node.name} className="max-h-[78vh] max-w-full object-contain" />;
  }
  if (kind === "video") return <video src={url} controls playsInline className="max-h-[78vh] max-w-full bg-black" />;
  if (kind === "audio") return <audio src={url} controls className="w-full max-w-md" />;
  if (kind === "pdf") return <iframe src={url} title={node.name} className="h-[78vh] w-full bg-white" />;
  return (
    <div className="text-center">
      <TypeIcon node={node} className="mx-auto mb-4 size-24" />
      <div className={cn("text-[18px] font-semibold", dark ? "text-white" : "text-ink")}>{node.name}</div>
      <div className={cn("mt-1 text-[14px]", dark ? "text-white/60" : "text-ink-3")}>
        {CATEGORY[categoryOf(node)].label} · {formatBytes(node.size)}
      </div>
      {onDownload ? (
        <Button className="mt-5" onClick={onDownload}>
          <Download className="size-4" /> Download
        </Button>
      ) : null}
    </div>
  );
}

export function Locked({ token, title, onUnlocked }: { token: string; title: string; onUnlocked: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <GeoStrip className="h-12 md:h-16" />
      <div className="flex flex-1 items-center justify-center p-4">
        <form
          className="w-full max-w-[400px] border-[1.5px] border-line-strong bg-surface p-7 shadow-hard animate-pop-in"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!password || busy) return;
            setBusy(true);
            try {
              await api(`/api/public/${token}/unlock`, { method: "POST", json: { password } });
              onUnlocked();
            } catch (err) {
              setError(err instanceof ApiError ? err.message : "Could not unlock");
              setBusy(false);
            }
          }}
          data-testid="share-locked"
        >
          <span className="flex size-12 items-center justify-center bg-invert text-on-invert">
            <Lock className="size-5" />
          </span>
          <div className="label mt-5 text-accent">Password required</div>
          <h1 className="mt-1 text-[24px] font-semibold leading-tight tracking-[-0.02em] text-ink">{title}</h1>
          <p className="mt-1.5 text-[14.5px] text-ink-2">Whoever shared this protected it. Enter the password they gave you.</p>
          <div className="mt-6">
            <TextField
              type="password"
              autoFocus
              aria-label="Link password"
              placeholder="Password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              error={error}
            />
          </div>
          <Button type="submit" size="lg" className="mt-4 w-full" disabled={!password || busy}>
            {busy ? <Spinner className="size-4" /> : null} Open <ArrowRight className="size-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}

export function Gone({ message, reason }: { message: string; reason?: string }) {
  const title = reason === "expired" ? "This link has expired" : reason === "exhausted" ? "Download limit reached" : reason === "unavailable" ? "These files are gone" : "Link not found";
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <GeoStrip className="h-12 md:h-16" />
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center" data-testid="share-gone">
        <EmptyLinkArt className="mb-3" />
        <div className="label text-accent">Shared link</div>
        <h1 className="text-[30px] font-semibold tracking-[-0.03em] text-ink">{title}</h1>
        <p className="max-w-sm text-[15px] text-ink-2">{message}. Ask whoever sent it for a new one.</p>
      </div>
    </div>
  );
}
