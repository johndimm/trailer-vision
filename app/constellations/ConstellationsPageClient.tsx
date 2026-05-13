"use client";

import { Suspense, lazy } from "react";

const TrailerVisionConstellationsClient = lazy(
  () => import("./TrailerVisionConstellationsClient")
);

const fallback = (
  <div className="flex h-full min-h-0 w-full items-center justify-center bg-slate-950 text-sm text-slate-200">
    Loading…
  </div>
);

export default function ConstellationsPageClient() {
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <Suspense fallback={fallback}>
        <TrailerVisionConstellationsClient />
      </Suspense>
    </div>
  );
}
