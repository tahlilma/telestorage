import type { CSSProperties } from "react";
import { cn } from "./ui";

/** The mark: an orange paper plane (Telegram) folded on a solid storage tile. */
export function Mark({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg viewBox="0 0 40 40" className={cn("size-9 shrink-0", className)} style={style} aria-hidden>
      <rect width="40" height="40" fill="var(--invert)" />
      <path d="M7 20.5 33 8 26 32 19.5 24.5Z" fill="var(--accent)" />
      <path d="M19.5 24.5 33 8 22.5 27.5Z" fill="var(--on-invert)" />
    </svg>
  );
}

export function Logo({ compact, className }: { compact?: boolean; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <Mark />
      {!compact ? <span className="text-[21px] font-semibold leading-none tracking-[-0.03em] text-ink">telestorage</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Geometric tiles (the brand strip). Each is a square block, 1×1.
// ---------------------------------------------------------------------------

type TileProps = { className?: string; style?: CSSProperties };
const tile = (className?: string) => cn("block aspect-square h-full shrink-0", className);

export function TriTile({ className, style }: TileProps) {
  return (
    <svg viewBox="0 0 96 96" className={tile(className)} style={style} aria-hidden>
      <rect width="96" height="96" fill="var(--canvas)" />
      <path d="M0 0 96 96H0Z" fill="var(--accent)" />
      <path d="M0 0h96L48 48Z" fill="var(--invert)" />
    </svg>
  );
}

export function DotsTile({ className, style }: TileProps) {
  return (
    <svg viewBox="0 0 96 96" className={tile(className)} style={style} aria-hidden>
      <rect width="96" height="96" fill="var(--invert)" />
      {[24, 48, 72].flatMap((y, row) =>
        [24, 48, 72].map((x, col) => (
          <circle
            key={`${x}-${y}`}
            cx={x}
            cy={y}
            r="7"
            fill="var(--canvas)"
            className="svg-anim"
            style={{ animation: `pulse-dot 3.6s ease-in-out ${(row + col) * 0.22}s infinite` }}
          />
        )),
      )}
    </svg>
  );
}

export function ArchTile({ className, style }: TileProps) {
  return (
    <svg viewBox="0 0 96 96" className={tile(className)} style={style} aria-hidden>
      <rect width="96" height="96" fill="var(--canvas)" />
      <path d="M0 96A96 96 0 0 1 96 0V96Z" fill="var(--invert)" />
    </svg>
  );
}

export function StarTile({ className, style }: TileProps) {
  return (
    <svg viewBox="0 0 96 96" className={tile(className)} style={style} aria-hidden>
      <rect width="96" height="96" fill="var(--invert)" />
      <path d="M48 6C52 34 62 44 90 48 62 52 52 62 48 90 44 62 34 52 6 48 34 44 44 34 48 6Z" fill="var(--canvas)" className="svg-anim" style={{ animation: "turn 28s linear infinite" }} />
    </svg>
  );
}

export function SunTile({ className, style }: TileProps) {
  return (
    <svg viewBox="0 0 96 96" className={tile(className)} style={style} aria-hidden>
      <rect width="96" height="96" fill="var(--accent)" />
      <circle cx="48" cy="96" r="48" fill="var(--invert)" className="svg-anim" style={{ animation: "bob 7s ease-in-out infinite" }} />
    </svg>
  );
}

/** The all-seeing sunburst — it watches over your files. */
export function EyeTile({ className, style }: TileProps) {
  return (
    <svg viewBox="0 0 96 96" className={tile(className)} style={style} aria-hidden>
      <rect width="96" height="96" fill="var(--canvas)" />
      <g stroke="var(--ink)" strokeWidth="9" strokeLinecap="round" className="svg-anim" style={{ animation: "turn 60s linear infinite" }}>
        {[0, 30, 60, 90, 120, 150].map((a) => (
          <line key={a} x1="48" y1="10" x2="48" y2="86" transform={`rotate(${a} 48 48)`} />
        ))}
      </g>
      <g className="svg-anim" style={{ animation: "blink-eye 6s ease-in-out infinite" }}>
        <ellipse cx="48" cy="48" rx="20" ry="12" fill="var(--canvas)" stroke="var(--ink)" strokeWidth="4" />
        <circle cx="48" cy="48" r="6" fill="var(--ink)" className="svg-anim" style={{ animation: "look 9s ease-in-out infinite" }} />
      </g>
    </svg>
  );
}

export function SlopeTile({ className, style }: TileProps) {
  return (
    <svg viewBox="0 0 96 96" className={tile(className)} style={style} aria-hidden>
      <rect width="96" height="96" fill="var(--invert)" />
      <path d="M0 0h96v96Z" fill="var(--canvas)" />
      <circle cx="66" cy="30" r="14" fill="var(--accent)" className="svg-anim" style={{ animation: "bob 5s ease-in-out -2s infinite" }} />
    </svg>
  );
}

const STRIP = [TriTile, DotsTile, ArchTile, StarTile, SunTile, EyeTile, SlopeTile];

/** A row of tiles; tiles enter one after another. */
export function GeoStrip({ className, count = STRIP.length, animate = true }: { className?: string; count?: number; animate?: boolean }) {
  return (
    <div className={cn("flex h-16 overflow-hidden", className)} aria-hidden>
      {Array.from({ length: count }, (_, i) => {
        const T = STRIP[i % STRIP.length];
        return <T key={i} className={animate ? "animate-rise" : undefined} style={animate ? { animationDelay: `${i * 55}ms` } : undefined} />;
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty-state scenes: an open box, a few geometric "files" and the eye.
// ---------------------------------------------------------------------------

const scene = "h-36 w-auto";

export function EmptyBoxArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 240 150" className={cn(scene, className)} aria-hidden>
      <g className="animate-float" style={{ transformOrigin: "60px 40px" }}>
        <rect x="44" y="18" width="34" height="42" fill="var(--surface)" stroke="var(--ink)" strokeWidth="3" />
        <path d="M51 32h20M51 41h14" stroke="var(--ink)" strokeWidth="3" />
      </g>
      <g className="animate-float" style={{ transformOrigin: "178px 32px", animationDelay: "-2.3s" }}>
        <rect x="160" y="14" width="36" height="36" fill="var(--accent)" />
        <circle cx="185" cy="25" r="5" fill="var(--canvas)" />
        <path d="M160 50 174 34 188 50Z" fill="var(--invert)" />
      </g>
      <path d="M58 82h124v62H58Z" fill="var(--invert)" />
      <path d="M58 82 38 104h82l20-22Z" fill="var(--surface)" stroke="var(--ink)" strokeWidth="3" strokeLinejoin="round" />
      <path d="M182 82l20 22h-82l-20-22Z" fill="var(--accent)" stroke="var(--ink)" strokeWidth="3" strokeLinejoin="round" />
      <path d="M78 118h40M78 130h26" stroke="var(--on-invert)" strokeWidth="5" />
    </svg>
  );
}

export function EmptyStarArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 240 150" className={cn(scene, className)} aria-hidden>
      <rect x="62" y="24" width="116" height="116" fill="var(--invert)" />
      <path d="M120 34c5 32 17 44 49 49-32 5-44 17-49 49-5-32-17-44-49-49 32-5 44-17 49-49Z" fill="var(--accent)" className="animate-spin-slow" style={{ transformOrigin: "120px 83px" }} />
      <circle cx="40" cy="120" r="14" fill="var(--accent)" />
      <path d="M190 24h30v30Z" fill="var(--ink)" />
    </svg>
  );
}

export function EmptyClockArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 240 150" className={cn(scene, className)} aria-hidden>
      <path d="M70 140A70 70 0 0 1 140 70v70Z" fill="var(--invert)" />
      <circle cx="160" cy="62" r="44" fill="var(--surface)" stroke="var(--ink)" strokeWidth="4" />
      <path d="M160 34v28l18 12" stroke="var(--accent)" strokeWidth="6" strokeLinecap="square" fill="none" />
      <rect x="28" y="22" width="26" height="26" fill="var(--accent)" />
    </svg>
  );
}

export function EmptyTrashArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 240 150" className={cn(scene, className)} aria-hidden>
      <path d="M86 50h68l-8 92H94Z" fill="var(--invert)" />
      <path d="M74 36h92v14H74Z" fill="var(--accent)" />
      <path d="M104 64v62M120 64v62M136 64v62" stroke="var(--on-invert)" strokeWidth="5" />
      <circle cx="196" cy="40" r="14" fill="none" stroke="var(--ink)" strokeWidth="4" />
      <path d="M30 120h30v22H30Z" fill="var(--surface)" stroke="var(--ink)" strokeWidth="3" />
    </svg>
  );
}

export function EmptyLinkArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 240 150" className={cn(scene, className)} aria-hidden>
      <rect x="40" y="46" width="78" height="56" fill="var(--invert)" />
      <rect x="122" y="46" width="78" height="56" fill="var(--accent)" />
      <path d="M96 74h48" stroke="var(--surface)" strokeWidth="10" />
      <circle cx="120" cy="22" r="10" fill="var(--ink)" />
      <path d="M20 130h200" stroke="var(--ink)" strokeWidth="3" strokeDasharray="8 8" />
    </svg>
  );
}

export function EmptySearchArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 240 150" className={cn(scene, className)} aria-hidden>
      <circle cx="106" cy="66" r="42" fill="var(--surface)" stroke="var(--ink)" strokeWidth="6" />
      <path d="M137 97 172 132" stroke="var(--invert)" strokeWidth="16" />
      <ellipse cx="106" cy="66" rx="20" ry="12" fill="none" stroke="var(--ink)" strokeWidth="4" />
      <circle cx="106" cy="66" r="6" fill="var(--accent)" />
      <path d="M190 30h30v30Z" fill="var(--accent)" />
    </svg>
  );
}

export function LostSignalArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 240 150" className={cn(scene, className)} aria-hidden>
      <path d="M50 140A70 70 0 0 1 190 140Z" fill="var(--invert)" />
      <path d="M86 140a34 34 0 0 1 68 0Z" fill="var(--accent)" />
      <path d="M150 30 184 64M184 30 150 64" stroke="var(--ink)" strokeWidth="7" />
    </svg>
  );
}

/** Folder glyph: a tab on a solid block. */
export function FolderGlyph({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-6 shrink-0", className)} style={style} aria-hidden>
      <path d="M2 5h8l2 2.5h10V20H2Z" fill="currentColor" />
      <path d="M2 9.5h20" stroke="var(--canvas)" strokeWidth="1.5" opacity="0.5" />
    </svg>
  );
}
