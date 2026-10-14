"use client";
import { keepPreviousData, useInfiniteQuery, useQuery, type QueryClient } from "@tanstack/react-query";
import type { Activity, Crumb, DriveNode, FileVersion, FolderListing, HomeData, PhotosPage, Share, StorageInsights, SystemSnapshot, ViewListing } from "@/lib/types";
import { get } from "./api";

export const qk = {
  folder: (id: string) => ["folder", id] as const,
  folders: (id: string) => ["folders", id] as const,
  view: (v: "recent" | "starred" | "trash") => ["view", v] as const,
  search: (q: string) => ["search", q] as const,
  node: (id: string) => ["node", id] as const,
  shares: (nodeId?: string) => ["shares", nodeId ?? "all"] as const,
  home: ["home"] as const,
  activity: ["activity"] as const,
  session: ["session"] as const,
  system: ["system"] as const,
  versions: (id: string) => ["versions", id] as const,
  photos: ["photos"] as const,
  storage: ["storage"] as const,
};

/** Query families that hold node listings and must be patched/invalidated on mutations. */
export const LISTING_KEYS = new Set(["folder", "folders", "view", "search", "node", "home", "photos", "storage"]);

const fetchFolder = (id: string, signal?: AbortSignal) => get<FolderListing>(`/api/nodes?parent=${encodeURIComponent(id)}`, signal);

export function useFolder(id: string | null) {
  return useQuery({
    queryKey: qk.folder(id ?? "root"),
    queryFn: ({ signal }) => fetchFolder(id ?? "root", signal),
    enabled: id !== null,
  });
}

/** Folders-only listing used by the move/copy picker. */
export function useFolderTree(id: string) {
  return useQuery({
    queryKey: qk.folders(id),
    queryFn: ({ signal }) => get<FolderListing>(`/api/nodes?parent=${encodeURIComponent(id)}&folders=1`, signal),
  });
}

export function useView(view: "recent" | "starred" | "trash" | null) {
  return useQuery({
    queryKey: qk.view(view ?? "recent"),
    queryFn: ({ signal }) => get<ViewListing>(`/api/nodes?view=${view}`, signal),
    enabled: view !== null,
  });
}

export function useSearch(q: string, enabled = true) {
  return useQuery({
    queryKey: qk.search(q),
    queryFn: ({ signal }) => get<ViewListing>(`/api/nodes?view=search&q=${encodeURIComponent(q)}`, signal),
    enabled: enabled && q.trim().length > 0,
    placeholderData: keepPreviousData,
    staleTime: 5_000,
  });
}

export interface NodeDetails {
  node: DriveNode;
  path: Crumb[];
  storage: {
    parts: number;
    partSize: number;
    driver: "telegram" | "local" | "sim";
    encrypted: boolean;
    /** Whole-file SHA-256 recorded at upload (null for files uploaded before checksums existed). */
    sha256: string | null;
    integrity: "verified" | "pending" | "corrupt" | "legacy";
    /** Last time the scrubber read the stored bytes back and matched every checksum. */
    verifiedAt: number | null;
    pieceChecksums: boolean;
  } | null;
}

export function useNodeDetails(id: string | null) {
  return useQuery({
    queryKey: qk.node(id ?? ""),
    queryFn: ({ signal }) => get<NodeDetails>(`/api/nodes/${id}`, signal),
    enabled: !!id,
  });
}

export function useShares(nodeId?: string) {
  return useQuery({
    queryKey: qk.shares(nodeId),
    queryFn: ({ signal }) => get<{ shares: Share[] }>(`/api/shares${nodeId ? `?nodeId=${nodeId}` : ""}`, signal),
  });
}

/** The photo timeline, 600 at a time. */
export function usePhotos() {
  return useInfiniteQuery({
    queryKey: qk.photos,
    queryFn: ({ signal, pageParam }) => get<PhotosPage>(`/api/photos${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ""}`, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
  });
}

/** The newest few photos, for the home screen. */
export function useRecentPhotos() {
  return useQuery({ queryKey: ["photos", "recent"], queryFn: ({ signal }) => get<PhotosPage>("/api/photos?limit=14", signal), staleTime: 15_000 });
}

export function useStorageInsights() {
  return useQuery({ queryKey: qk.storage, queryFn: ({ signal }) => get<StorageInsights>("/api/storage", signal), staleTime: 10_000 });
}

export function useVersions(nodeId: string) {
  return useQuery({
    queryKey: qk.versions(nodeId),
    queryFn: ({ signal }) => get<{ versions: FileVersion[] }>(`/api/nodes/${nodeId}/versions`, signal),
  });
}

export function useHome() {
  return useQuery({ queryKey: qk.home, queryFn: ({ signal }) => get<HomeData>("/api/home", signal), staleTime: 15_000 });
}

export function useActivity(enabled = true) {
  return useQuery({
    queryKey: qk.activity,
    queryFn: ({ signal }) => get<{ items: Activity[] }>("/api/activity?limit=60", signal),
    enabled,
    staleTime: 10_000,
  });
}

export interface SessionInfo {
  authenticated: boolean;
  method: "password" | null;
  providers: { password: boolean; totp: boolean };
}

export function useSession() {
  return useQuery({ queryKey: qk.session, queryFn: () => get<SessionInfo>("/api/auth/session"), staleTime: 60_000 });
}

export function useSystemSummary() {
  return useQuery({
    queryKey: qk.system,
    queryFn: () => get<{ snapshot: SystemSnapshot }>("/api/system"),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/** Hover-intent prefetch: by the time the user clicks a folder its contents are usually cached. */
export function prefetchFolder(qc: QueryClient, id: string) {
  return qc.prefetchQuery({ queryKey: qk.folder(id), queryFn: ({ signal }) => fetchFolder(id, signal), staleTime: 15_000 });
}
