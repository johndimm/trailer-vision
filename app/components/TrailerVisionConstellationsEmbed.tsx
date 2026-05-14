"use client";

import { lazy, Suspense, useEffect, useState } from "react";
import { SOUNDINGS_CONSTELLATIONS_HANDOFF_KEY } from "@johndimm/constellations/sessionHandoff";
import type { GraphNode } from "@johndimm/constellations/types";
import { useRouter } from "next/navigation";

const ConstellationsApp = lazy(() =>
  import("@johndimm/constellations/host").then((m) => ({ default: m.App }))
);

function Inner({
  nowPlayingKey,
  autoExpandMatchTitles,
  externalSearch,
  onNewChannelFromNode,
}: {
  nowPlayingKey: string | null;
  autoExpandMatchTitles: string[];
  externalSearch: { term: string; id: string | number } | null;
  onNewChannelFromNode?: (node: GraphNode) => void;
}) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { setHydrated(true); }, []);

  if (!hydrated) {
    return (
      <div className="flex h-[min(75vh,900px)] min-h-[320px] w-full items-center justify-center bg-slate-950 text-sm text-slate-400">
        Loading graph…
      </div>
    );
  }

  return (
    <div className="relative h-[min(75vh,900px)] w-full min-h-[480px] overflow-hidden">
      <ConstellationsApp
        embedded
        hideHeader
        hideControlPanel
        showExtensionWhenPanelHidden={false}
        hideSidebar
        externalSearch={externalSearch}
        onExternalSearchConsumed={() => {}}
        autoExpandMatchTitles={autoExpandMatchTitles}
        nowPlayingKey={nowPlayingKey}
        onNewChannelFromNode={onNewChannelFromNode}
      />
    </div>
  );
}

export default function TrailerVisionConstellationsEmbed({
  nowPlayingKey,
  autoExpandMatchTitles,
  externalSearch,
  onNewChannelFromNode,
}: {
  nowPlayingKey: string | null;
  autoExpandMatchTitles: string[];
  externalSearch: { term: string; id: string | number } | null;
  onNewChannelFromNode?: (node: GraphNode) => void;
}) {
  const router = useRouter();

  const goFull = () => {
    try {
      const fn = (window as any).__soundingsConstellationsGetHandoff;
      if (typeof fn === "function") {
        const payload = fn();
        if (payload && typeof payload === "object" && (payload as any).v === 1) {
          const g = (payload as any).graph;
          if (g?.nodes?.length) {
            sessionStorage.setItem(SOUNDINGS_CONSTELLATIONS_HANDOFF_KEY, JSON.stringify(payload));
          }
        }
      }
    } catch { /* ignore */ }
    router.push("/constellations");
  };

  return (
    <div id="trailer-vision-constellations" className="w-full shrink-0">
      <div className="mx-auto w-full max-w-[800px] px-4 pb-4 pt-3">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold tracking-tight text-zinc-300">Graph</h2>
          <button
            type="button"
            onClick={goFull}
            className="text-xs text-emerald-400/90 underline decoration-emerald-500/30 hover:text-emerald-300 bg-transparent border-0 p-0 cursor-pointer"
          >
            Open full screen
          </button>
        </div>
        <Suspense
          fallback={
            <div className="flex h-[min(75vh,900px)] min-h-[320px] w-full items-center justify-center bg-slate-950 text-sm text-slate-400">
              Loading graph…
            </div>
          }
        >
          <Inner
            nowPlayingKey={nowPlayingKey}
            autoExpandMatchTitles={autoExpandMatchTitles}
            externalSearch={externalSearch}
            onNewChannelFromNode={onNewChannelFromNode}
          />
        </Suspense>
      </div>
    </div>
  );
}
