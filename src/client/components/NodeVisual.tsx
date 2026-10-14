"use client";
import { memo, useState, type CSSProperties } from "react";
import type { DriveNode } from "@/lib/types";
import { blobThumbUrl, CATEGORY, categoryOf, folderTone, thumbUrl, typeCode, type FileCategory } from "../files";
import { FolderGlyph } from "./Brand";
import { Poster } from "./Posters";
import { cn } from "./ui";

export { FolderGlyph };

type NodeLike = Pick<DriveNode, "kind" | "name" | "mime">;

/** Square type chip: PNG, MP4, PDF… in the type's block colour. */
export const TypeTag = memo(function TypeTag({ node, className }: { node: NodeLike; className?: string }) {
  const c = CATEGORY[categoryOf(node)];
  return (
    <span
      className={cn("inline-flex h-[20px] min-w-[38px] shrink-0 items-center justify-center px-1.5 text-[10.5px] font-semibold tracking-[0.04em]", className)}
      style={{ background: c.bg, color: c.fg }}
    >
      {typeCode(node)}
    </span>
  );
});

/** The geometric glyph drawn on a type tile, in the tile's ink. */
function Glyph({ cat, fg }: { cat: FileCategory; fg: string }) {
  switch (cat) {
    case "image":
      return (
        <>
          <path d="M4 20 10.5 11l4.5 6 2.5-3L22 20Z" fill={fg} />
          <circle cx="17.5" cy="7.5" r="2.5" fill={fg} />
        </>
      );
    case "video":
      return <path d="M8 5.5v13l11-6.5Z" fill={fg} />;
    case "audio":
      return (
        <>
          <circle cx="12" cy="12" r="7.5" fill="none" stroke={fg} strokeWidth="2" />
          <circle cx="12" cy="12" r="2.5" fill={fg} />
        </>
      );
    case "pdf":
    case "doc":
    case "text":
      return <path d="M6 6.5h12M6 10.5h12M6 14.5h12M6 18.5h7" stroke={fg} strokeWidth="2" />;
    case "sheet":
      return <path d="M5 5h14v14H5ZM5 10h14M5 14.5h14M10 5v14" stroke={fg} strokeWidth="1.8" fill="none" />;
    case "slides":
      return <path d="M5 18V12h3.5v6ZM10.25 18V7h3.5v11ZM15.5 18v-8.5H19V18Z" fill={fg} />;
    case "archive":
      return <path d="M5 6h14v12H5ZM10 6v3h4V6M10 12h4" stroke={fg} strokeWidth="1.8" fill="none" />;
    case "code":
      return <path d="m9 7-5 5 5 5M15 7l5 5-5 5" stroke={fg} strokeWidth="2.2" fill="none" />;
    case "font":
      return <path d="M5 19 10 5h1.5l5 14M7 14.5h7.5" stroke={fg} strokeWidth="2" fill="none" />;
    case "folder":
      return <path d="M3 6h7l2 2.5h9V19H3Z" fill={fg} />;
    default:
      return <circle cx="12" cy="12" r="4" fill={fg} />;
  }
}

/** A square tile in the type's colour with its glyph. */
export const TypeIcon = memo(function TypeIcon({ node, className, style }: { node: NodeLike; className?: string; style?: CSSProperties }) {
  const cat = categoryOf(node);
  const c = CATEGORY[cat];
  return (
    <svg viewBox="0 0 24 24" className={cn("size-9 shrink-0", className)} style={{ background: c.bg, ...style }} aria-hidden>
      <Glyph cat={cat} fg={c.fg} />
    </svg>
  );
});

/** Small inline icon for lists. */
export const NodeIcon = TypeIcon;

/** Files without a thumbnail get a Bauhaus poster of their type (see Posters.tsx). */
function Placeholder({ node, className, style }: { node: DriveNode; className?: string; style?: CSSProperties }) {
  return <Poster node={node} className={className} style={style} />;
}

/** Thumbnail with a soft fade-in; files without one show their geometric type tile. */
export const NodeThumb = memo(function NodeThumb({
  node,
  className,
  style,
  src,
}: {
  node: DriveNode;
  className?: string;
  style?: CSSProperties;
  /** Override URL (public share pages use a token-scoped thumbnail route). */
  src?: string | null;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const url = src !== undefined ? src : node.hasThumb ? thumbUrl(node) : null;
  const cat = categoryOf(node);
  if (!url || failed) return <Placeholder node={node} className={className} style={style} />;
  return (
    <div className={cn("relative overflow-hidden bg-surface-2", !loaded && "skeleton", className)} style={style}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        className={cn("size-full object-cover transition-[opacity,transform] duration-500 ease-out", loaded ? "scale-100 opacity-100" : "scale-[1.04] opacity-0")}
      />
      {cat === "video" ? (
        <div className="pointer-events-none absolute bottom-2 left-2 flex size-7 items-center justify-center bg-[#111]">
          <svg viewBox="0 0 24 24" className="ml-0.5 size-3.5 fill-[#efeae1]" aria-hidden>
            <path d="M8 5v14l11-7z" />
          </svg>
        </div>
      ) : null}
    </div>
  );
});

/** Folder card art: up to three recent thumbnails, or a solid folder block. */
export function FolderPreview({ node, className }: { node: DriveNode; className?: string }) {
  const previews = node.previews ?? [];
  if (!previews.length) {
    return (
      <div className={cn("relative flex items-center justify-center overflow-hidden bg-surface-2 dots", className)}>
        <FolderGlyph className="size-14 text-ink" style={node.color ? { color: folderTone(node).bg } : undefined} />
      </div>
    );
  }
  return (
    <div className={cn("grid gap-0.5 overflow-hidden bg-line", previews.length === 1 ? "grid-cols-1" : "grid-cols-2", className)}>
      {previews.slice(0, 3).map((b, i) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={b}
          src={blobThumbUrl(b)}
          alt=""
          loading="lazy"
          draggable={false}
          className={cn("size-full min-h-0 object-cover", previews.length === 3 && i === 0 && "row-span-2")}
        />
      ))}
    </div>
  );
}
