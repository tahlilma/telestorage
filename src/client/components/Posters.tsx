"use client";
import { memo, type CSSProperties, type ReactNode } from "react";
import type { DriveNode } from "@/lib/types";
import { categoryOf, typeCode, type FileCategory } from "../files";
import { cn } from "./ui";

/**
 * Bauhaus posters for files without a thumbnail: each type gets its own
 * composition of circles, triangles, bars and grids in the palette, and a hash
 * of the name picks one of a few variants, so a folder of documents reads
 * like a set of prints rather than one tile repeated. Shapes drift a little
 * on hover.
 */

const O = "#f2652a"; // orange
const B = "#2f5da8"; // blue
const Y = "#f2b33d"; // yellow
const R = "#d23b20"; // red
const G = "#1e7a4c"; // green
const V = "#6b4fd8"; // violet
const K = "#111111"; // ink
const C = "#efeae1"; // cream

const BG: Record<FileCategory, string> = {
  folder: K,
  image: O,
  video: K,
  audio: B,
  pdf: R,
  doc: B,
  sheet: G,
  slides: Y,
  archive: Y,
  code: K,
  text: "var(--surface-2)",
  font: V,
  other: "var(--surface-2)",
};

const drift = "transition-transform duration-700 ease-out [transform-box:fill-box]";

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Text lines as bars. */
const lines = (x: number, y: number, w: number, n: number, color: string, gap = 7, last = 0.55) =>
  Array.from({ length: n }, (_, i) => <rect key={i} x={x} y={y + i * gap} width={i === n - 1 ? w * last : w} height={3} fill={color} />);

function composition(cat: FileCategory, v: number): ReactNode {
  switch (cat) {
    case "image":
      return v === 0 ? (
        <>
          <circle cx="88" cy="26" r="16" fill={C} className={cn(drift, "group-hover:-translate-y-1")} />
          <path d="M0 90 44 38 88 90Z" fill={K} />
          <path d="M50 90 80 58 120 90Z" fill={Y} />
        </>
      ) : (
        <>
          <path d="M0 0h60v60A60 60 0 0 1 0 0Z" fill={Y} />
          <circle cx="86" cy="58" r="22" fill={C} className={cn(drift, "group-hover:-translate-x-1")} />
          <rect x="18" y="66" width="34" height="8" fill={K} />
        </>
      );
    case "video":
      return v === 0 ? (
        <>
          <circle cx="60" cy="45" r="27" fill={O} className={cn(drift, "group-hover:scale-105")} style={{ transformOrigin: "center" }} />
          <path d="M53 33v24l20-12Z" fill={C} />
          {Array.from({ length: 8 }, (_, i) => (
            <rect key={i} x={6 + i * 15} y="4" width="8" height="6" fill={C} opacity="0.5" />
          ))}
          {Array.from({ length: 8 }, (_, i) => (
            <rect key={`b${i}`} x={6 + i * 15} y="80" width="8" height="6" fill={C} opacity="0.5" />
          ))}
        </>
      ) : (
        <>
          <path d="M0 90V30a60 60 0 0 1 60 60Z" fill={B} />
          <path d="M70 18v42l34-21Z" fill={O} className={cn(drift, "group-hover:translate-x-1")} />
          <circle cx="98" cy="74" r="8" fill={Y} />
        </>
      );
    case "audio":
      return v === 0 ? (
        <>
          {[44, 34, 24, 14].map((r, i) => (
            <circle key={r} cx="0" cy="90" r={r * 2} fill="none" stroke={i % 2 ? Y : C} strokeWidth="6" />
          ))}
          <circle cx="92" cy="28" r="12" fill={O} className={cn(drift, "group-hover:-translate-y-1")} />
        </>
      ) : (
        <>
          {[18, 34, 26, 48, 30, 40, 22, 14].map((h, i) => (
            <rect key={i} x={14 + i * 12} y={68 - h} width="7" height={h} fill={i % 3 === 0 ? Y : C} className={cn(drift, "group-hover:scale-y-110")} style={{ transformOrigin: "bottom" }} />
          ))}
          <rect x="10" y="72" width="100" height="4" fill={K} />
        </>
      );
    case "pdf":
      return (
        <>
          <path d="M30 10h44l16 16v58H30Z" fill={C} className={cn(drift, "group-hover:-translate-y-1")} />
          <path d="M74 10v16h16Z" fill={K} opacity="0.25" />
          {lines(38, 34, 42, v === 0 ? 5 : 4, K)}
          {v === 1 ? <circle cx="98" cy="72" r="14" fill={Y} /> : <rect x="94" y="62" width="20" height="20" fill={K} />}
        </>
      );
    case "doc":
      return v === 0 ? (
        <>
          <rect x="28" y="12" width="64" height="70" fill={C} className={cn(drift, "group-hover:-translate-y-1")} />
          {lines(36, 24, 48, 6, B)}
          <path d="M120 0v40A40 40 0 0 1 80 0Z" fill={Y} />
        </>
      ) : (
        <>
          <path d="M0 90V40a50 50 0 0 1 50 50Z" fill={Y} />
          {lines(48, 22, 56, 6, C, 8)}
          <rect x="48" y="12" width="20" height="4" fill={O} />
        </>
      );
    case "sheet":
      return (
        <>
          {Array.from({ length: 4 * 5 }, (_, i) => {
            const x = 16 + (i % 5) * 18;
            const y = 14 + Math.floor(i / 5) * 16;
            const fill = (i * 7 + v) % 6 === 0 ? Y : (i * 3 + v) % 5 === 0 ? O : C;
            return <rect key={i} x={x} y={y} width="15" height="13" fill={fill} opacity={fill === C ? 0.85 : 1} />;
          })}
        </>
      );
    case "slides":
      return v === 0 ? (
        <>
          <rect x="16" y="14" width="88" height="54" fill={K} className={cn(drift, "group-hover:-translate-y-1")} />
          <circle cx="44" cy="41" r="14" fill={O} />
          {lines(66, 32, 28, 3, C)}
          <rect x="56" y="70" width="8" height="12" fill={K} />
        </>
      ) : (
        <>
          {[30, 48, 22, 60].map((h, i) => (
            <rect key={i} x={18 + i * 22} y={78 - h} width="16" height={h} fill={i === 3 ? O : K} />
          ))}
          <circle cx="98" cy="20" r="10" fill={C} />
        </>
      );
    case "archive":
      return (
        <>
          {Array.from({ length: 6 }, (_, i) => (
            <rect key={i} x={0} y={i * 15} width="120" height="7" fill={K} opacity={0.12} />
          ))}
          <rect x="52" y="0" width="16" height="90" fill={K} />
          {Array.from({ length: 9 }, (_, i) => (
            <rect key={`z${i}`} x={i % 2 ? 60 : 52} y={4 + i * 9} width="8" height="5" fill={Y} />
          ))}
          <rect x="49" y="58" width="22" height="16" fill={v ? O : C} className={cn(drift, "group-hover:translate-y-1")} />
        </>
      );
    case "code":
      return (
        <>
          <path d="M42 22 18 45l24 23" stroke={O} strokeWidth="9" fill="none" className={cn(drift, "group-hover:-translate-x-1")} />
          <path d="M78 22l24 23-24 23" stroke={C} strokeWidth="9" fill="none" className={cn(drift, "group-hover:translate-x-1")} />
          <path d="M66 16 54 74" stroke={Y} strokeWidth="6" />
        </>
      );
    case "text":
      return (
        <>
          {lines(20, 20, 70, 7, "var(--ink)", 8, 0.4)}
          <rect x="92" y="14" width="16" height="16" fill={O} className={cn(drift, "group-hover:rotate-12")} />
        </>
      );
    case "font":
      return (
        <>
          <text x="14" y="72" fontSize="64" fontWeight="700" fill={C} fontFamily="var(--font-ui)">
            Aa
          </text>
          <circle cx="100" cy="24" r="10" fill={Y} className={cn(drift, "group-hover:translate-y-1")} />
        </>
      );
    case "folder":
      return <path d="M24 26h28l8 8h36v38H24Z" fill={C} />;
    default:
      return (
        <>
          {Array.from({ length: 5 * 4 }, (_, i) => (
            <circle key={i} cx={16 + (i % 5) * 12} cy={18 + Math.floor(i / 5) * 12} r="2.2" fill="var(--ink)" opacity="0.35" />
          ))}
          <circle cx="86" cy="40" r="18" fill="var(--ink)" className={cn(drift, "group-hover:-translate-y-1")} />
          <path d="M70 84 92 54l22 30Z" fill={O} />
        </>
      );
  }
}

export const Poster = memo(function Poster({ node, className, style }: { node: Pick<DriveNode, "kind" | "name" | "mime">; className?: string; style?: CSSProperties }) {
  const cat = categoryOf(node);
  const variant = hash(node.name) % 2;
  const paper = cat === "text" || cat === "other";
  return (
    <div className={cn("@container relative overflow-hidden", className)} style={{ background: BG[cat], ...style }} aria-hidden>
      <svg viewBox="0 0 120 90" preserveAspectRatio="xMidYMid slice" className="absolute inset-0 size-full">
        {composition(cat, variant)}
      </svg>
      <span
        className="absolute bottom-2 left-2 hidden px-1.5 py-0.5 text-[10.5px] font-semibold tracking-[0.06em] @[6rem]:block"
        style={paper ? { background: "var(--invert)", color: "var(--on-invert)" } : { background: K, color: C }}
      >
        {typeCode(node)}
      </span>
    </div>
  );
});
