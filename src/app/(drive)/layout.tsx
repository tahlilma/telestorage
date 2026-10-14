import { DriveApp } from "@/client/components/DriveApp";

/**
 * Every drive URL (/, /folder/:id, /recent, /starred, /trash, /search, /dashboard)
 * shares this layout, so the whole drive is one prerendered static shell that
 * the CDN/service worker can serve instantly. Data is fetched client-side.
 */
export default function DriveLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      {children}
      <DriveApp />
    </>
  );
}
