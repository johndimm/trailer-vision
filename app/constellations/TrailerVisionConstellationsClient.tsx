"use client";

import {
  FullPageConstellations,
  FullPageConstellationsHostLoading,
  useFullPageConstellationsHost,
} from "@johndimm/constellations/host";
import { takeEmbedHandoffForInitialState } from "@johndimm/constellations/sessionHandoff";
import type { GraphNode } from "@johndimm/constellations/types";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { queueNewChannelFromGraphNode } from "../lib/newChannelFromGraphNode";

export default function TrailerVisionConstellationsClient() {
  const router = useRouter();
  const sp = useSearchParams();
  const [embedHandoff] = useState(() => takeEmbedHandoffForInitialState());
  const qParam = (sp.get("q") ?? "").trim();
  const expandParam = (sp.get("expand") ?? "").trim();

  const { ready, externalSearch, autoExpandTitles, nowPlayingKey } = useFullPageConstellationsHost({
    qParam,
    expandParam,
    skipUrlAndPlayerBridge: Boolean(embedHandoff),
  });

  if (!ready) {
    return <FullPageConstellationsHostLoading surface="in-layout" />;
  }

  return (
    <FullPageConstellations
      layout="below-app-chrome"
      hideHeader
      settingsHref="/constellations/settings"
      closeHref="/"
      externalSearch={externalSearch}
      onExternalSearchConsumed={() => {}}
      autoExpandMatchTitles={autoExpandTitles}
      nowPlayingKey={nowPlayingKey}
      initialSession={embedHandoff}
      onNewChannelFromNode={(node: GraphNode) =>
        queueNewChannelFromGraphNode(node, (path) => router.push(path))
      }
    />
  );
}
