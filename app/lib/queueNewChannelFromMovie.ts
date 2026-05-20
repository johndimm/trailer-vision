import { NEW_CHANNEL_PREFILL_KEY } from "./channelFromPrompt";
import { movieToChannelSeeds, type MovieChannelSeedInput } from "./movieToChannelSeeds";

/** Queue new-channel form prefill from a movie/show, then open `/channels?new=1`. */
export function queueNewChannelFromMovie(
  movie: MovieChannelSeedInput,
  navigate: (path: string) => void,
) {
  const seeds = movieToChannelSeeds(movie);
  try {
    sessionStorage.setItem(
      NEW_CHANNEL_PREFILL_KEY,
      JSON.stringify({ v: 1, ...seeds }),
    );
  } catch (e) {
    console.warn("[trailer-vision] could not queue new channel from movie", e);
  }
  navigate("/channels?new=1");
}
