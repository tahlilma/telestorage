import type { Metadata } from "next";
import { Suspense } from "react";
import { SharePage } from "@/client/components/SharePage";

export const metadata: Metadata = { title: "Shared with you" };

export default function PublicSharePage() {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-canvas" />}>
      <SharePage />
    </Suspense>
  );
}
