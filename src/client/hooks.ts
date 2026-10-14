"use client";
import { useSyncExternalStore } from "react";

/** Live `matchMedia` result; false during SSR. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => matchMedia(query).matches,
    () => false,
  );
}

/** Phone-sized layout (bottom navigation, sheets instead of dialogs). */
export const useIsMobile = () => useMediaQuery("(max-width: 767px)");

export const isTouchDevice = () => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

/** Smooth theme/route swaps where the browser supports view transitions. */
export function withViewTransition(fn: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (doc.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) doc.startViewTransition(fn);
  else fn();
}
