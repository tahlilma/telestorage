"use client";
import { ArrowLeft, ChevronLeft, ChevronRight, Download, Link2, Share2, Star } from "lucide-react";
import { AnimatePresence, motion, type PanInfo } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatBytes } from "@/lib/format";
import type { DriveNode } from "@/lib/types";
import { downloadNodes, invalidateDrive, quickLink, setStarred } from "../actions";
import { CATEGORY, categoryOf, fileUrl, previewKind, thumbUrl } from "../files";
import { useUi } from "../store";
import { isTouchDevice } from "../hooks";
import { thumbFromImage, uploadThumb } from "../upload/thumbs";
import { NodeIcon, NodeThumb, TypeTag } from "./NodeVisual";
import { Button, cn, IconButton, Spinner } from "./ui";

export function Preview() {
  const preview = useUi((s) => s.preview);
  const visible = useUi((s) => s.visible);
  const files = useMemo(() => visible.filter((n) => n.kind === "file"), [visible]);
  const index = preview ? files.findIndex((n) => n.id === preview.id) : -1;
  const node = index >= 0 ? files[index] : null;
  const close = () => useUi.getState().closePreview();
  const [dir, setDir] = useState(0);
  const go = (d: number) => {
    const next = files[index + d];
    if (!next) return;
    setDir(d);
    useUi.getState().openPreview(next.id);
  };
  // Phones: swipe sideways to page, down to close.
  const onSwipe = (_e: unknown, info: PanInfo) => {
    if (Math.abs(info.offset.x) > Math.abs(info.offset.y)) {
      if (info.offset.x < -70 || info.velocity.x < -500) go(1);
      else if (info.offset.x > 70 || info.velocity.x > 500) go(-1);
    } else if (info.offset.y > 110 || info.velocity.y > 700) close();
  };

  useEffect(() => {
    if (!node) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    // Preload neighbouring images so paging feels instant.
    for (const d of [1, -1]) {
      const n = files[index + d];
      if (n && previewKind(n) === "image" && n.size < 30 * 1024 * 1024) new Image().src = fileUrl(n);
    }
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node?.id, index]);

  return (
    <AnimatePresence>
      {node ? (
        <motion.div
          key="preview"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex flex-col bg-[#0b0b0b]/96 text-white backdrop-blur-sm"
          role="dialog"
          aria-label={`Preview of ${node.name}`}
        >
          <div className="flex h-16 shrink-0 items-center gap-3 px-3">
            <IconButton label="Close" className="text-white hover:bg-white/10" onClick={close}>
              <ArrowLeft />
            </IconButton>
            <TypeTag node={node} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] font-semibold">{node.name}</div>
              <div className="text-[12.5px] text-white/60 tabular">
                {CATEGORY[categoryOf(node)].label} · {formatBytes(node.size)}
                {files.length > 1 ? ` · ${index + 1} of ${files.length}` : ""}
              </div>
            </div>
            <IconButton label={node.starred ? "Remove star" : "Star"} className="text-white hover:bg-white/10" onClick={() => void setStarred([node], !node.starred)}>
              <Star className={cn(node.starred && "fill-accent text-accent")} />
            </IconButton>
            <IconButton label="Copy link" className="text-white hover:bg-white/10" onClick={() => void quickLink([node])}>
              <Link2 />
            </IconButton>
            <IconButton label="Share" className="text-white hover:bg-white/10" onClick={() => useUi.getState().openDialog({ type: "share", nodes: [node] })}>
              <Share2 />
            </IconButton>
            <IconButton label="Download" className="text-white hover:bg-white/10" onClick={() => void downloadNodes([node])}>
              <Download />
            </IconButton>
          </div>

          <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-2 pb-4 sm:px-16" onClick={(e) => e.target === e.currentTarget && close()}>
            <AnimatePresence initial={false} custom={dir} mode="popLayout">
              <motion.div
                key={node.id}
                custom={dir}
                variants={{
                  enter: (d: number) => ({ x: d * 80, opacity: 0 }),
                  center: { x: 0, opacity: 1 },
                  exit: (d: number) => ({ x: d * -80, opacity: 0 }),
                }}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ type: "spring", stiffness: 420, damping: 40 }}
                // Swipes only on touch, and never over content that scrolls or scrubs itself.
                drag={isTouchDevice() && (previewKind(node) === "image" || previewKind(node) === "none" || previewKind(node) === "audio")}
                dragSnapToOrigin
                dragElastic={0.25}
                dragConstraints={{ left: 0, right: 0, top: 0, bottom: 0 }}
                onDragEnd={onSwipe}
                className="flex size-full items-center justify-center"
                onClick={(e) => e.target === e.currentTarget && close()}
              >
                <PreviewBody node={node} />
              </motion.div>
            </AnimatePresence>
            {index > 0 ? (
              <button aria-label="Previous" onClick={() => go(-1)} className="absolute left-3 top-1/2 hidden size-12 -translate-y-1/2 items-center justify-center bg-white/10 transition hover:bg-accent hover:text-[#111] sm:flex">
                <ChevronLeft />
              </button>
            ) : null}
            {index < files.length - 1 ? (
              <button aria-label="Next" onClick={() => go(1)} className="absolute right-3 top-1/2 hidden size-12 -translate-y-1/2 items-center justify-center bg-white/10 transition hover:bg-accent hover:text-[#111] sm:flex">
                <ChevronRight />
              </button>
            ) : null}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function PreviewBody({ node }: { node: DriveNode }) {
  const kind = previewKind(node);
  const url = fileUrl(node);
  if (kind === "image") return <ImagePreview node={node} url={url} />;
  if (kind === "video")
    return (
      // Range requests let the browser seek anywhere; the server streams blocks in parallel.
      <video src={url} controls autoPlay playsInline preload="metadata" poster={node.hasThumb ? thumbUrl(node) ?? undefined : undefined} className="max-h-full max-w-full bg-black shadow-2xl" />
    );
  if (kind === "audio")
    return (
      <div className="w-full max-w-md border border-white/15 bg-white/5 p-8 text-center">
        <NodeIcon node={node} className="mx-auto mb-6 size-28" />
        <div className="mb-5 truncate font-medium">{node.name}</div>
        <audio src={url} controls autoPlay className="w-full" />
      </div>
    );
  if (kind === "pdf") return <iframe src={url} title={node.name} className="size-full max-w-5xl bg-white" />;
  if (kind === "text") return <TextPreview url={url} />;
  return (
    <div className="text-center">
      <NodeThumb node={node} src={null} className="mx-auto mb-5 size-36 ring-1 ring-white/10" />
      <p className="mb-5 text-white/70">No preview for this kind of file</p>
      <Button onClick={() => void downloadNodes([node])}>
        <Download className="size-4" /> Download · {formatBytes(node.size)}
      </Button>
    </div>
  );
}

function ImagePreview({ node, url }: { node: DriveNode; url: string }) {
  const [loaded, setLoaded] = useState(false);
  const [zoom, setZoom] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const thumb = node.hasThumb ? thumbUrl(node) : null;
  return (
    <div className={cn("relative flex size-full items-center justify-center", zoom ? "cursor-zoom-out overflow-auto" : "cursor-zoom-in")} onClick={() => setZoom(!zoom)}>
      {thumb && !loaded ? (
        // Blur-up: the cached thumbnail paints instantly while the original streams in.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={thumb} alt="" className="absolute max-h-full max-w-full scale-[1.01] object-contain blur-md" />
      ) : null}
      {!loaded && !thumb ? <Spinner className="absolute size-8 text-white" /> : null}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={imgRef}
        src={url}
        alt={node.name}
        decoding="async"
        onLoad={async () => {
          setLoaded(true);
          // Backfill a thumbnail for images that don't have one yet.
          if (!node.hasThumb && imgRef.current) {
            const t = await thumbFromImage(imgRef.current);
            if (t) await uploadThumb(node.id, t).then(invalidateDrive).catch(() => {});
          }
        }}
        className={cn(
          "relative object-contain shadow-2xl transition-opacity duration-200",
          zoom ? "max-w-none" : "max-h-full max-w-full",
          loaded ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}

function TextPreview({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(url, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setText)
      .catch((e) => !ctrl.signal.aborted && setError(String(e.message ?? e)));
    return () => ctrl.abort();
  }, [url]);
  if (error) return <p className="text-white/70">{error}</p>;
  if (text === null) return <Spinner className="size-8 text-white" />;
  const lines = text.split("\n");
  return (
    <div className="size-full max-w-5xl overflow-auto bg-[#141414] font-mono text-[13px] leading-6 shadow-2xl ring-1 ring-white/10">
      <table className="w-full border-collapse">
        <tbody>
          {lines.slice(0, 20000).map((l, i) => (
            <tr key={i}>
              <td className="w-12 select-none border-r border-white/5 pr-3 text-right align-top text-white/30 tabular">{i + 1}</td>
              <td className="whitespace-pre-wrap break-all pl-4 pr-6 text-white/90">{l || " "}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
