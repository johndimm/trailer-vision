/** What kinds of titles this channel should surface (empty = no extra format filter). */
export type ChannelMedium = "movie" | "tv";

export interface MovieChannel {
  id: string;
  name: string;
  mediums: ChannelMedium[];
  genres: string[];
  timePeriods: string[];
  language: string;
  artists: string;
  freeText: string;
  popularity: number;
}
