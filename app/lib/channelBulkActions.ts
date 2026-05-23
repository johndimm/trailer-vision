import type { MovieChannel as Channel } from "./movieChannel";

export const ALL_CHANNEL_ID = "all";

export function ensureAllChannel(channels: Channel[]): Channel[] {
  const all = channels.find((c) => c.id === ALL_CHANNEL_ID);
  const rest = channels.filter((c) => c.id !== ALL_CHANNEL_ID);
  if (all) return [all, ...rest];
  return rest;
}

/** Delete every channel whose id is in `ids` (All is never deleted). */
export function deleteChannelsByIds(channels: Channel[], ids: Iterable<string>): Channel[] {
  const drop = new Set(ids);
  drop.delete(ALL_CHANNEL_ID);
  if (drop.size === 0) return ensureAllChannel(channels);
  const remaining = channels.filter((c) => !drop.has(c.id));
  if (remaining.length === 0) {
    const allOnly = channels.find((c) => c.id === ALL_CHANNEL_ID);
    return allOnly ? [allOnly] : [];
  }
  return ensureAllChannel(remaining);
}

export function countCustomChannels(channels: readonly { id: string }[]): number {
  return channels.filter((c) => c.id !== ALL_CHANNEL_ID).length;
}

export function sortChannelsAlpha(channels: Channel[]): Channel[] {
  const all = channels.find((c) => c.id === ALL_CHANNEL_ID);
  const rest = [...channels.filter((c) => c.id !== ALL_CHANNEL_ID)].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
  return all ? [all, ...rest] : rest;
}
