import {
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  FileVideo,
  Folder,
  File as FileIcon,
  Presentation,
  type LucideIcon,
} from "lucide-react";
import type { DriveNode, FolderColor } from "@/lib/types";

export type FileCategory =
  | "folder"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "doc"
  | "sheet"
  | "slides"
  | "archive"
  | "code"
  | "text"
  | "font"
  | "other";

interface CategoryInfo {
  icon: LucideIcon;
  /** Block colour (CSS) and the ink that reads on it. A Bauhaus set: orange, ink, blue, yellow, red, green. */
  bg: string;
  fg: string;
  label: string;
  /** Short fallback code. */
  code: string;
}

const ORANGE = "#f2652a";
const BLUE = "#2f5da8";
const YELLOW = "#f2b33d";
const RED = "#d23b20";
const GREEN = "#1e7a4c";
const VIOLET = "#6b4fd8";
const INK = "var(--invert)";
const ON_INK = "var(--on-invert)";
const PAPER = "var(--surface-3)";

/** What a folder of each colour looks like (null = the default ink). */
export const FOLDER_PALETTE: Record<FolderColor, { bg: string; fg: string; label: string }> = {
  ink: { bg: INK, fg: ON_INK, label: "Ink" },
  orange: { bg: ORANGE, fg: "#ffffff", label: "Orange" },
  red: { bg: RED, fg: "#ffffff", label: "Red" },
  yellow: { bg: YELLOW, fg: "#111111", label: "Yellow" },
  green: { bg: GREEN, fg: "#ffffff", label: "Green" },
  blue: { bg: BLUE, fg: "#ffffff", label: "Blue" },
  violet: { bg: VIOLET, fg: "#ffffff", label: "Violet" },
};

export const folderTone = (node: Pick<DriveNode, "color">) => FOLDER_PALETTE[node.color ?? "ink"] ?? FOLDER_PALETTE.ink;

export const CATEGORY: Record<FileCategory, CategoryInfo> = {
  folder: { icon: Folder, bg: INK, fg: ON_INK, label: "Folder", code: "DIR" },
  image: { icon: FileImage, bg: ORANGE, fg: "#111111", label: "Image", code: "IMG" },
  video: { icon: FileVideo, bg: INK, fg: ON_INK, label: "Video", code: "VID" },
  audio: { icon: FileAudio, bg: BLUE, fg: "#ffffff", label: "Audio", code: "AUD" },
  pdf: { icon: FileText, bg: RED, fg: "#ffffff", label: "PDF", code: "PDF" },
  doc: { icon: FileText, bg: BLUE, fg: "#ffffff", label: "Document", code: "DOC" },
  sheet: { icon: FileSpreadsheet, bg: GREEN, fg: "#ffffff", label: "Spreadsheet", code: "XLS" },
  slides: { icon: Presentation, bg: YELLOW, fg: "#111111", label: "Presentation", code: "PPT" },
  archive: { icon: FileArchive, bg: YELLOW, fg: "#111111", label: "Archive", code: "ZIP" },
  code: { icon: FileCode2, bg: INK, fg: ON_INK, label: "Code", code: "SRC" },
  text: { icon: FileText, bg: PAPER, fg: "var(--ink)", label: "Text", code: "TXT" },
  font: { icon: FileType2, bg: VIOLET, fg: "#ffffff", label: "Font", code: "FNT" },
  other: { icon: FileIcon, bg: PAPER, fg: "var(--ink)", label: "File", code: "BIN" },
};

/** Short type code for a file: its extension (≤4 chars), else the category code. */
export function typeCode(node: Pick<DriveNode, "kind" | "name" | "mime">): string {
  if (node.kind === "folder") return "DIR";
  const ext = extension(node.name);
  if (ext && ext.length <= 4 && /^[a-z0-9]+$/.test(ext)) return ext.toUpperCase();
  return CATEGORY[categoryOf(node)].code;
}

const EXT: Record<string, FileCategory> = {};
const add = (cat: FileCategory, exts: string) => exts.split(" ").forEach((e) => (EXT[e] = cat));
add("image", "jpg jpeg png gif webp avif bmp svg ico heic heif tif tiff jxl");
add("video", "mp4 m4v mkv webm mov avi wmv flv mpg mpeg 3gp ts m2ts");
add("audio", "mp3 m4a aac flac wav ogg oga opus wma aiff alac");
add("pdf", "pdf");
add("doc", "doc docx odt rtf pages epub");
add("sheet", "xls xlsx ods csv tsv numbers");
add("slides", "ppt pptx odp key");
add("archive", "zip rar 7z tar gz tgz bz2 xz zst iso dmg apk");
add(
  "code",
  "js mjs cjs ts tsx jsx json py rb go rs java kt c h cpp hpp cs php sh bash zsh ps1 swift sql yml yaml toml ini xml html htm css scss vue svelte lua dart r",
);
add("text", "txt md markdown log rst nfo srt vtt env cfg conf");
add("font", "ttf otf woff woff2");

export function extension(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function categoryOf(node: Pick<DriveNode, "kind" | "name" | "mime">): FileCategory {
  if (node.kind === "folder") return "folder";
  const byExt = EXT[extension(node.name)];
  if (byExt) return byExt;
  const mime = node.mime ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("text/")) return "text";
  return "other";
}

export type PreviewKind = "image" | "video" | "audio" | "pdf" | "text" | "none";

const BROWSER_IMAGE = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "svg", "ico"]);
const BROWSER_VIDEO = new Set(["mp4", "m4v", "webm", "mov", "ogv", "mkv"]);
const BROWSER_AUDIO = new Set(["mp3", "m4a", "aac", "flac", "wav", "ogg", "oga", "opus"]);

export function previewKind(node: DriveNode): PreviewKind {
  if (node.kind !== "file") return "none";
  const ext = extension(node.name);
  const cat = categoryOf(node);
  if (cat === "image" && (BROWSER_IMAGE.has(ext) || node.mime?.startsWith("image/"))) return ext === "heic" || ext === "heif" || ext === "tif" || ext === "tiff" ? "none" : "image";
  if (cat === "video" && (BROWSER_VIDEO.has(ext) || node.mime?.startsWith("video/"))) return "video";
  if (cat === "audio" && (BROWSER_AUDIO.has(ext) || node.mime?.startsWith("audio/"))) return "audio";
  if (cat === "pdf") return "pdf";
  if ((cat === "code" || cat === "text" || (cat === "sheet" && (ext === "csv" || ext === "tsv"))) && node.size <= 2 * 1024 * 1024) return "text";
  return "none";
}

export function fileUrl(node: Pick<DriveNode, "id" | "name">, download = false): string {
  return `/api/files/${node.id}/${encodeURIComponent(node.name)}${download ? "?dl=1" : ""}`;
}

/** Files the server was already asked to pre-pull this session (one request per file is plenty). */
const warmed = new Set<string>();

/** Asks the server to pull a file's first blocks from Telegram into its cache, so opening it is instant. */
export function warmFile(node: Pick<DriveNode, "id" | "kind" | "size" | "blobId">) {
  if (node.kind !== "file" || !node.size || !node.blobId || warmed.has(node.blobId)) return;
  warmed.add(node.blobId);
  void fetch(`/api/nodes/${node.id}/warm`, { method: "POST", keepalive: true }).catch(() => warmed.delete(node.blobId!));
}

export function thumbUrl(node: Pick<DriveNode, "blobId">): string | null {
  return node.blobId ? `/api/thumbs/${node.blobId}` : null;
}

export const blobThumbUrl = (blobId: string) => `/api/thumbs/${blobId}`;
