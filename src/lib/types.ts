export type NodeKind = "folder" | "file";

export interface DriveNode {
  id: string;
  parentId: string | null;
  kind: NodeKind;
  name: string;
  size: number;
  mime: string | null;
  blobId: string | null;
  hasThumb: boolean;
  starred: boolean;
  trashedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** Live children (folders only). */
  childCount?: number | null;
  /** Bytes of the files directly inside (folders only). */
  folderSize?: number | null;
  /** Blob ids of up to three recent image/video thumbnails inside (folders only). */
  previews?: string[] | null;
  /** Active share links that include this item. */
  shareCount?: number;
  /** Folder colour (a palette name, see FOLDER_COLORS), or null for the default. */
  color?: FolderColor | null;
  /** Photos and videos: when it was taken (from its metadata), if known. */
  takenAt?: number | null;
  /** Files: how many earlier versions are kept. */
  versionCount?: number | null;
}

/** The Bauhaus palette folders can wear. */
export const FOLDER_COLORS = ["orange", "blue", "yellow", "red", "green", "violet", "ink"] as const;
export type FolderColor = (typeof FOLDER_COLORS)[number];

/** A photo or video on the timeline: `at` is when it was taken (else uploaded), `ratio` its width ÷ height. */
export type PhotoItem = DriveNode & { ratio: number | null; at: number };

export interface PhotosPage {
  items: PhotoItem[];
  /** Cursor for the next page, or null at the end. */
  next: string | null;
}

/** Where the space goes (Storage page). */
export interface StorageInsights {
  largest: DriveNode[];
  versions: { count: number; bytes: number };
  trash: { count: number; bytes: number };
  live: { count: number; bytes: number };
  /** Bytes actually stored (unique contents, including versions and trash). */
  stored: number;
  photosByYear: { year: number; count: number; bytes: number }[];
  byType: { type: string; bytes: number; count: number }[];
  capacity: Capacity;
  driver: "telegram" | "local" | "sim";
  parts: number;
}

/** An earlier content of a file, kept when it was replaced. */
export interface FileVersion {
  id: string;
  size: number;
  mime: string | null;
  /** When this content was uploaded. */
  createdAt: number;
  /** When a newer upload replaced it. */
  replacedAt: number;
}

export interface Crumb {
  id: string;
  name: string;
}

export interface FolderListing {
  folder: DriveNode;
  path: Crumb[];
  items: DriveNode[];
}

export type DriveView = "recent" | "starred" | "trash" | "search";

export interface ViewListing {
  items: DriveNode[];
}

export interface UploadInit {
  id: string;
  partSize: number;
  pieceSize: number;
  chunkSize: number;
  partCount: number;
  /**
   * How many parts the client should send at once. Parts are finished (and
   * become durable Telegram posts) one after another instead of all at the
   * end, so a huge upload survives interruptions with little lost.
   */
  partsInFlight?: number;
}

export interface ShareItem {
  id: string;
  name: string;
  kind: NodeKind;
  size: number;
  mime: string | null;
  blobId: string | null;
  hasThumb: boolean;
  inTrash: boolean;
}

/** A share link, as its owner sees it. */
export interface Share {
  id: string;
  title: string | null;
  note: string | null;
  hasPassword: boolean;
  allowDownload: boolean;
  maxDownloads: number | null;
  createdAt: number;
  expiresAt: number | null;
  downloads: number;
  views: number;
  lastAccessAt: number | null;
  /** active, or why the link no longer works. */
  status: "active" | "expired" | "exhausted" | "unavailable";
  items: ShareItem[];
  /** "share": people can see and download. "request": people can only upload into the folder. */
  kind: "share" | "request";
  /** File requests: largest file accepted (null = any size). */
  maxBytes: number | null;
  /** File requests: files and bytes received so far. */
  received: number;
  receivedBytes: number;
}

/** Options accepted when creating or editing a link. */
export interface ShareOptions {
  title?: string | null;
  note?: string | null;
  /** A new password; null removes it; omitted leaves it unchanged. */
  password?: string | null;
  allowDownload?: boolean;
  maxDownloads?: number | null;
  /** Absolute expiry (ms since epoch); null = never. */
  expiresAt?: number | null;
  /** File requests: largest file accepted, in bytes (null = any size). */
  maxBytes?: number | null;
}

/** What happened to an upload's file name when it landed. */
export type UploadOutcome = "created" | "renamed" | "replaced" | "identical" | "skipped";
export type ConflictPolicy = "keep" | "replace" | "skip";

export type ActivityKind =
  | "upload"
  | "duplicate"
  | "folder"
  | "rename"
  | "move"
  | "copy"
  | "trash"
  | "restore"
  | "delete"
  | "purge"
  | "share"
  | "unshare"
  | "share_view"
  | "share_download"
  | "version"
  | "color"
  | "request"
  | "received";

export interface Activity {
  id: number;
  at: number;
  kind: ActivityKind;
  count: number;
  name: string | null;
  nodeId: string | null;
  parentId: string | null;
  parentName: string | null;
  shareId: string | null;
  nodeAlive: boolean;
  detail: Record<string, unknown> | null;
}

export interface HomeData {
  stats: { files: number; folders: number; bytes: number; shares: number };
  recentFiles: DriveNode[];
  folders: { recent: DriveNode[]; starred: DriveNode[]; shared: DriveNode[] };
  activity: Activity[];
}

export type BatchOp =
  | { op: "move"; ids: string[]; targetId: string }
  | { op: "copy"; ids: string[]; targetId: string }
  | { op: "trash"; ids: string[] }
  | { op: "restore"; ids: string[] }
  | { op: "delete"; ids: string[] }
  | { op: "star"; ids: string[]; starred: boolean }
  | { op: "color"; ids: string[]; color: FolderColor | null }
  | { op: "emptyTrash" };

export interface BotStatus {
  index: number;
  username: string;
  id: string;
  dcId: number;
  connections: number;
  connected: number;
  inflight: number;
  requests: number;
  bytesUp: number;
  bytesDown: number;
  errors: number;
  floodWaitUntil: number;
  lastError: string | null;
  lastErrorAt: number | null;
  state: "connecting" | "ready" | "error";
  /** Parts currently pinned to this bot by in-progress uploads. */
  assignedParts: number;
  /** Commit (sendMedia) tokens available in the bot's rate limiter. */
  commitTokens: number;
  endpoints: EndpointStatus[];
}

/** One MTProto connection (or simulated connection) inside a bot. */
export interface EndpointStatus {
  conn: number;
  connected: boolean;
  active: number;
  queued: number;
  readLatencyMs: number;
  writeLatencyMs: number;
  breaker: "closed" | "open" | "half-open";
  /** Requests served per priority class: [interactive, normal, background]. */
  served: [number, number, number];
}

export interface LatencyStats {
  count: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  mean: number;
}

/**
 * How much room there really is. Telegram sets no storage quota per account;
 * the hard ceilings are the channel's post numbers and the size of one post.
 */
export interface Capacity {
  /** "telegram": a channel. "disk": local-disk or simulator mode, limited by the disk. */
  kind: "telegram" | "disk";
  /** Bytes per stored part (one Telegram post each), from TG_PART_SIZE_MB. */
  partSize: number;
  /** Largest document a bot may post: 4 000 × 512 KiB = 2 000 MiB. */
  maxPartSize: number;
  /** Largest single file: 2^53 − 1 bytes (exact byte offsets in JavaScript). */
  maxFileSize: number;
  /** Highest post number seen in the channel (ids are 32-bit and never reused). */
  postsUsed: number | null;
  /** 2^31 − 1. */
  postLimit: number | null;
  /** Posts this drive can make per minute (bots × TG_COMMITS_PER_MINUTE). Each file needs at least one. */
  postsPerMinute: number | null;
  /** Telegram: posts left × part size. Disk: free space on the disk holding DATA_DIR. */
  freeBytes: number | null;
  /** Disk only: size of that disk. */
  totalBytes: number | null;
}

export interface SystemSnapshot {
  ts: number;
  driver: "telegram" | "local" | "sim";
  uptimeSec: number;
  node: string;
  platform: string;
  encryption: boolean;
  channel: { id: string; title: string | null } | null;
  bots: BotStatus[];
  storage: {
    files: number;
    folders: number;
    logicalBytes: number;
    physicalBytes: number;
    blobs: number;
    parts: number;
    trashedBytes: number;
    dedupSavedBytes: number;
    dbBytes: number;
    walBytes: number;
    thumbBytes: number;
    shares: number;
    gcPending: number;
    byType: { type: string; bytes: number; count: number }[];
    capacity: Capacity;
  };
  cache: {
    memBytes: number;
    memMax: number;
    memEntries: number;
    diskBytes: number;
    diskMax: number;
    diskEntries: number;
    inflight: number;
  };
  counters: Record<string, number>;
  gauges: { activeStreams: number; activeUploads: number; inflightBlocks: number; liveClients: number; admissionBytes: number; admissionQueued: number };
  latency: Record<string, LatencyStats>;
  process: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
    loadAvg: number[];
    cpus: number;
  };
  backup: {
    /** Automatic backups on (BACKUP_INTERVAL_HOURS isn't 0). */
    enabled: boolean;
    lastAt: number | null;
    lastSize: number | null;
    lastError: string | null;
    /** Changes not in a backup yet. */
    pending: boolean;
    notice: { kind: "diverged" | "foreign" | "unpinned"; message: string; at: number } | null;
    /** When this server brought the index back from Telegram, and how old that backup was. */
    restoredAt: number | null;
    restoredBackupAt: number | null;
    /** This server has handed the drive over (it's stopping, or moving elsewhere). */
    released: boolean;
  };
  admission: { used: number; capacity: number; queued: number; rejected: number };
  integrity: {
    total: number;
    verified: number;
    corrupt: number;
    legacy: number;
    running: boolean;
    enabled: boolean;
    fsck: FsckReport | null;
  };
  trashRetentionDays: number;
  errors: { code: string; count: number }[];
  logs: { ts: number; level: "info" | "warn" | "error"; scope: string; msg: string }[];
}

export interface SeriesFrame {
  tgUp: number;
  tgDown: number;
  served: number;
  received: number;
  cacheHitRatio: number;
  tgRps: number;
  loopLagMs: number;
  rssMb: number;
  heapMb: number;
  cpuPct: number;
  activeStreams: number;
}

/** One entry of the live change feed (GET /api/events). */
export interface ChangeEvent {
  rev: number;
  at: number;
  /** Server process id; a change means events may have been missed. */
  boot: string;
  type: "nodes" | "gc" | "shares" | "activity" | "backup";
  reason?: "create" | "upload" | "rename" | "star" | "move" | "copy" | "trash" | "restore" | "delete" | "thumb" | "purge" | "repair" | "share" | "version" | "color" | "request";
  /** Folders whose listings changed. */
  parents?: string[];
  /** Nodes that changed. */
  ids?: string[];
  /** Nodes that disappeared (trashed or deleted) — views inside them must move away. */
  removed?: string[];
  /** For "gc": storage parts that were just deleted from the channel. */
  parts?: number;
  blobs?: string[];
}

/** Result of the metadata consistency checker. */
export interface FsckReport {
  at: number;
  durationMs: number;
  ok: boolean;
  repaired: number;
  needsGc: boolean;
  checks: { name: string; status: "ok" | "repaired" | "warning" | "error"; count: number; detail: string }[];
}
