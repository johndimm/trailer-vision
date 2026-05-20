const DEFAULT_NAME_MAX = 40;

export type MovieChannelSeedInput = {
  title: string;
  type: "movie" | "tv";
  year?: number | null;
  director?: string | null;
  actors?: string[];
  plot?: string | null;
};

/** Short tab label from a movie or show title. */
export function movieToChannelName(title: string, maxLen = DEFAULT_NAME_MAX): string {
  const raw = title.replace(/\s+/g, " ").trim() || "New channel";
  if (raw.length <= maxLen) return raw;
  if (maxLen < 2) return "…";
  return raw.slice(0, maxLen - 1) + "…";
}

/** Free-text description for a channel seeded from a title. */
export function movieToChannelNotes(movie: MovieChannelSeedInput): string {
  const t = movie.title.trim();
  const typeLabel = movie.type === "tv" ? "TV series" : "Movie";
  const yearBit = movie.year != null ? `, ${movie.year}` : "";
  const lines = [
    `Channel inspired by: "${t}" (${typeLabel}${yearBit}).`,
    "Find similar movies and shows.",
  ];
  const plot = movie.plot?.trim();
  if (plot) lines.push("", plot.slice(0, 1500));
  return lines.join("\n");
}

function directorAndActors(movie: MovieChannelSeedInput): string {
  const people: string[] = [];
  const dir = movie.director?.trim();
  if (dir) people.push(dir);
  for (const a of movie.actors ?? []) {
    const name = a.trim();
    if (!name) continue;
    if (!people.some((p) => p.toLowerCase() === name.toLowerCase())) people.push(name);
  }
  return people.join(", ");
}

/** Prefill payload for the new-channel form (matches `mergeNewChannelFormPrefill`). */
export function movieToChannelSeeds(movie: MovieChannelSeedInput) {
  return {
    name: movieToChannelName(movie.title),
    freeText: movieToChannelNotes(movie),
    mediums: [movie.type] as ("movie" | "tv")[],
    artists: directorAndActors(movie),
    genres: [] as string[],
    timePeriods: [] as string[],
    language: "",
    popularity: 50,
  };
}
