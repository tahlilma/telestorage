"use client";
import { useSyncExternalStore } from "react";

/**
 * A tiny client-side router for the app views. Navigation is a pushState
 * plus a synchronous store update — no server round-trip, no RSC fetch — so
 * switching folders is bounded only by React's render time. Every URL also
 * maps to a real Next route, so reloads and deep links work.
 */
export type DriveRoute =
  | { name: "home" }
  | { name: "folder"; id: string }
  | { name: "recent" }
  | { name: "starred" }
  | { name: "shared" }
  | { name: "trash" }
  | { name: "search"; q: string }
  | { name: "photos" }
  | { name: "storage" }
  | { name: "system" };

/** Views that list files (everything except home, shared links and system). */
export type ListRoute = Extract<DriveRoute, { name: "folder" | "recent" | "starred" | "trash" | "search" }>;
export const isListRoute = (r: DriveRoute | null): r is ListRoute =>
  !!r && (r.name === "folder" || r.name === "recent" || r.name === "starred" || r.name === "trash" || r.name === "search");

const listeners = new Set<() => void>();
let cachedHref = "";
let cachedRoute: DriveRoute = { name: "home" };

function notify() {
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("popstate", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("popstate", cb);
  };
}

export function parseRoute(pathname: string, search: string): DriveRoute {
  const parts = pathname.split("/").filter(Boolean);
  switch (parts[0]) {
    case "files":
      return { name: "folder", id: "root" };
    case "folder":
      return { name: "folder", id: parts[1] || "root" };
    case "recent":
      return { name: "recent" };
    case "starred":
      return { name: "starred" };
    case "shared":
      return { name: "shared" };
    case "trash":
      return { name: "trash" };
    case "search":
      return { name: "search", q: new URLSearchParams(search).get("q") ?? "" };
    case "photos":
      return { name: "photos" };
    case "storage":
      return { name: "storage" };
    case "system":
    case "dashboard":
      return { name: "system" };
    default:
      return { name: "home" };
  }
}

function snapshot(): DriveRoute {
  const href = location.pathname + location.search;
  if (href !== cachedHref) {
    cachedHref = href;
    cachedRoute = parseRoute(location.pathname, location.search);
  }
  return cachedRoute;
}

/** Current route; `null` during SSR/prerender so the static shell renders a skeleton. */
export function useRoute(): DriveRoute | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

export function routeHref(route: DriveRoute): string {
  switch (route.name) {
    case "home":
      return "/";
    case "folder":
      return route.id === "root" ? "/files" : `/folder/${route.id}`;
    case "search":
      return `/search?q=${encodeURIComponent(route.q)}`;
    default:
      return `/${route.name}`;
  }
}

export function navigate(to: DriveRoute | string, opts: { replace?: boolean } = {}) {
  const href = typeof to === "string" ? to : routeHref(to);
  if (href === location.pathname + location.search) return;
  if (opts.replace) history.replaceState(null, "", href);
  else history.pushState(null, "", href);
  notify();
}

export function sameRoute(a: DriveRoute | null, b: DriveRoute): boolean {
  return !!a && routeHref(a) === routeHref(b);
}
