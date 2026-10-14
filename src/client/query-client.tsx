"use client";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { del, get, set } from "idb-keyval";
import type { ReactNode } from "react";
import { bindQueryClient } from "./actions";
import { ApiError } from "./api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      gcTime: 24 * 60 * 60 * 1000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 3,
    },
  },
});
bindQueryClient(queryClient);

/**
 * Listings are persisted to IndexedDB, so a cold start (or an offline visit)
 * paints the last-known folder instantly, then revalidates in the background.
 */
const persister =
  typeof window !== "undefined"
    ? createAsyncStoragePersister({
        storage: { getItem: (k) => get<string>(k).then((v) => v ?? null), setItem: (k, v) => set(k, v), removeItem: (k) => del(k) },
        key: "ts-query-cache",
        throttleTime: 1500,
      })
    : undefined;

const PERSISTED = new Set(["folder", "view", "folders", "session", "system", "home"]);

export function QueryProvider({ children }: { children: ReactNode }) {
  if (!persister) return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: 7 * 24 * 60 * 60 * 1000,
        buster: "v3",
        dehydrateOptions: {
          shouldDehydrateQuery: (q) => q.state.status === "success" && PERSISTED.has(String(q.queryKey[0])),
        },
      }}
    >
      {children}
    </PersistQueryClientProvider>
  );
}
