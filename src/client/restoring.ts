"use client";
import { create } from "zustand";

/**
 * The server is bringing its index back from Telegram (it started on an empty
 * disk). Any API answer saying so switches the app to a progress screen until
 * the server is ready again.
 */
export const useRestoring = create<{ message: string | null }>()(() => ({ message: null }));

export function noteRestoring(message: string) {
  if (useRestoring.getState().message !== message) useRestoring.setState({ message });
}

export function restoringDone() {
  useRestoring.setState({ message: null });
}
