import { newChannelFromGraphNode } from "@johndimm/constellations/host";
import type { GraphNode } from "@johndimm/constellations/types";
import { NEW_CHANNEL_PREFILL_KEY } from "./channelFromPrompt";

/** Queue new-channel form prefill from a Constellations node, then open `/channels?new=1`. */
export function queueNewChannelFromGraphNode(
  node: GraphNode,
  navigate: (path: string) => void,
) {
  newChannelFromGraphNode(node, {
    sessionStorageKey: NEW_CHANNEL_PREFILL_KEY,
    navigate,
    path: "/channels?new=1",
    logLabel: "trailer-vision",
  });
}
