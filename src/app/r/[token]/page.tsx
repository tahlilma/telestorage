import type { Metadata } from "next";
import { Suspense } from "react";
import { RequestPage } from "@/client/components/RequestPage";

export const metadata: Metadata = { title: "Send files" };

export default function FileRequestPage() {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-canvas" />}>
      <RequestPage />
    </Suspense>
  );
}
