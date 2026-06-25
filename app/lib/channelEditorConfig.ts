import type { ChannelEditorConfig, ChannelEditorValues } from "@/app/components/ChannelEditorForm";
import { mergeNewChannelFormPrefill } from "@/app/lib/channelFromPrompt";
import type { ChannelMedium, MovieChannel } from "@/app/lib/movieChannel";

const SETTINGS_KEY = "movie-recs-settings";

export const GENRE_OPTIONS = [
  "Action", "Adventure", "Animation", "Comedy", "Crime",
  "Documentary", "Drama", "Fantasy", "Horror", "Musical",
  "Mystery", "Romance", "Sci-Fi", "Thriller", "War", "Western",
];

export const TIME_OPTIONS = [
  "pre-1940s", "1940s", "1950s", "1960s", "1970s",
  "1980s", "1990s", "2000s", "2010s", "2020s",
];

export const STREAMING_OPTIONS = [
  "Netflix", "Amazon Prime", "Apple TV+", "Disney+", "HBO Max",
  "Hulu", "Paramount+", "Peacock",
];

export const MEDIUM_OPTIONS: { id: ChannelMedium; label: string; hint: string }[] = [
  { id: "movie", label: "Movies", hint: "Theatrical feature films" },
  { id: "tv", label: "TV series", hint: "Episodic / ongoing TV series" },
];

export const LANGUAGE_OPTIONS = [
  "English", "French", "Italian", "Spanish", "German", "Japanese",
  "Korean", "Mandarin", "Cantonese", "Hindi", "Portuguese", "Russian",
  "Arabic", "Persian", "Swedish", "Danish", "Norwegian", "Finnish",
  "Polish", "Greek", "Turkish", "Hebrew",
];

function readLlmFromLocalSettings(): string {
  try {
    const s = localStorage.getItem(SETTINGS_KEY);
    if (!s) return "deepseek";
    const o = JSON.parse(s) as { llm?: string };
    return o.llm ?? "deepseek";
  } catch {
    return "deepseek";
  }
}

export const TRAILER_CHANNEL_EDITOR_CONFIG: ChannelEditorConfig = {
  freeTextTitle: "What you want",
  freeTextHelp:
    "Describe the kinds of movies or shows you want in this channel—mood, scope, subgenres, or examples. The app uses this as the main signal to line up the format, genres, time periods, and language in the sections below.",
  nameLabel: "Channel name",
  nameHelp:
    "Short label shown on the home screen. Give it a clear, specific title—no need to paste it again in the description above.",
  namePlaceholder: "e.g. 70s paranoid thrillers, cozy British mysteries",
  freeTextPlaceholder:
    "movie, TV show, actor, director, mood, era, genre…",
  refineHelp:
    "use the checkboxes to match the description, or set them by hand. You can add more in the main text if needed; you don't need to restate the channel name there.",
  artistsLabel: "Directors / Actors",
  artistsEmptyHint:
    "No suggestions yet — add a little more in the description or try genres / era / language.",
  artistsNeedInputHint:
    "Add a title, a description, or a filter in the sections on this form to see director and actor ideas.",
  genreOptions: GENRE_OPTIONS,
  timePeriodOptions: TIME_OPTIONS,
  showStreaming: true,
  streamingOptions: STREAMING_OPTIONS,
  showLanguage: true,
  languageOptions: LANGUAGE_OPTIONS,
  showMediums: true,
  mediumOptions: MEDIUM_OPTIONS,
  readLlm: readLlmFromLocalSettings,
  buildSuggestBody: (form, llm) => ({
    channelName: form.name,
    genres: form.genres,
    timePeriods: form.timePeriods,
    language: form.language,
    freeText: form.freeText,
    llm,
  }),
};

export const COMING_SOON_CHANNEL_EDITOR_CONFIG: ChannelEditorConfig = {
  ...TRAILER_CHANNEL_EDITOR_CONFIG,
  showTimePeriods: false,
  showStreaming: false,
  showArtists: false,
};

export function channelToEditorValues(ch: MovieChannel): ChannelEditorValues {
  const artists = ch.artists
    ? ch.artists
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  return {
    name: ch.name,
    freeText: ch.freeText,
    genres: ch.genres,
    timePeriods: ch.timePeriods,
    streaming: ch.streaming ?? [],
    regions: [],
    language: ch.language,
    mediums: ch.mediums,
    artists,
    popularity: ch.popularity,
  };
}

export function editorValuesToChannel(
  existingId: string,
  values: ChannelEditorValues
): MovieChannel {
  return {
    id: existingId,
    name: values.name.trim(),
    mediums: values.mediums as ChannelMedium[],
    genres: values.genres,
    timePeriods: values.timePeriods,
    streaming: values.streaming,
    language: values.language,
    artists: values.artists.join(", "),
    freeText: values.freeText.trim(),
    popularity: values.popularity,
  };
}

export function prefillToEditorValues(partial: unknown): ChannelEditorValues {
  const m = mergeNewChannelFormPrefill(partial);
  return {
    name: m.name,
    freeText: m.freeText,
    genres: m.genres,
    timePeriods: m.timePeriods,
    streaming: (m as { streaming?: string[] }).streaming ?? [],
    regions: [],
    language: m.language,
    mediums: m.mediums,
    artists: m.artists
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    popularity: m.popularity,
  };
}

export function emptyTrailerEditorValues(): ChannelEditorValues {
  return {
    name: "",
    freeText: "",
    genres: [],
    timePeriods: [],
    streaming: [],
    regions: [],
    language: "",
    mediums: [],
    artists: [],
    popularity: 50,
  };
}
