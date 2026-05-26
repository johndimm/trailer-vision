import type { MovieChannel as Channel } from "./movieChannel";

export const ALL_CHANNEL_ID = "all";

export function createAllChannel(): Channel {
  return {
    id: ALL_CHANNEL_ID,
    name: "All",
    mediums: [],
    genres: [],
    timePeriods: [],
    language: "",
    artists: "",
    freeText: "",
    popularity: 50,
  };
}

/** Always includes the All channel; never returns an empty list. */
export function normalizeChannelList(channels: readonly Channel[] | null | undefined): Channel[] {
  const list = Array.isArray(channels) ? [...channels] : [];
  const all = list.find((c) => c.id === ALL_CHANNEL_ID);
  const rest = list.filter((c) => c.id !== ALL_CHANNEL_ID);
  return [all ?? createAllChannel(), ...rest];
}

export function ensureAllChannel(channels: Channel[]): Channel[] {
  return normalizeChannelList(channels);
}

/** Delete every channel whose id is in `ids` (All is never deleted). */
export function deleteChannelsByIds(channels: Channel[], ids: Iterable<string>): Channel[] {
  const drop = new Set(ids);
  drop.delete(ALL_CHANNEL_ID);
  if (drop.size === 0) return normalizeChannelList(channels);
  const remaining = channels.filter((c) => !drop.has(c.id));
  return normalizeChannelList(remaining);
}

export function countCustomChannels(channels: readonly { id: string }[]): number {
  return channels.filter((c) => c.id !== ALL_CHANNEL_ID).length;
}

const SESSION_HYDRATED_KEY = "movie-recs-channels-session-hydrated";

/** Alpha sort on full reload or first read in this tab session; preserve order on in-app navigation. */
export function hydrateChannelsOnLoad<T extends { id: string; name: string }>(
  channels: T[],
  allChannel: T,
  normalize: (c: T) => T,
): T[] {
  let chs = channels.map(normalize);
  if (!chs.some((c) => c.id === ALL_CHANNEL_ID)) {
    chs = [allChannel, ...chs];
  }
  const nav =
    typeof performance !== "undefined"
      ? (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)
      : undefined;
  const isReload = nav?.type === "reload";
  let sessionHydrated = false;
  try {
    sessionHydrated = sessionStorage.getItem(SESSION_HYDRATED_KEY) === "1";
  } catch {
    /* ignore */
  }
  if (isReload || !sessionHydrated) {
    chs = sortChannelsAlpha(chs);
    try {
      sessionStorage.setItem(SESSION_HYDRATED_KEY, "1");
    } catch {
      /* ignore */
    }
  }
  return chs;
}

export function sortChannelsAlpha<T extends { id: string; name: string }>(channels: T[]): T[] {
  const all = channels.find((c) => c.id === ALL_CHANNEL_ID);
  const rest = [...channels.filter((c) => c.id !== ALL_CHANNEL_ID)].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
  return all ? [all, ...rest] : rest;
}

/** New channels go right below All; existing order is preserved until the next full load. */
export function insertChannelAfterAll<T extends { id: string }>(
  channels: T[],
  newChannel: T,
): T[] {
  const all = channels.find((c) => c.id === ALL_CHANNEL_ID);
  const custom = channels.filter((c) => c.id !== ALL_CHANNEL_ID);
  return all ? [all, newChannel, ...custom] : [newChannel, ...custom];
}
