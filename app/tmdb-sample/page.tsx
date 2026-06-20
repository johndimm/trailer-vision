import Link from "next/link";

const MOVIE_EXAMPLE = {
  id: 1087388,
  title: "Thunderbolts*",
  original_title: "Thunderbolts*",
  original_language: "en",
  overview:
    "After finding themselves ensnared in a death trap, a group of Marvel's most complex antiheroes must embark on a dangerous mission that will force them to confront the darkest corners of their pasts.",
  poster_path: "/m9EtP1WJG4MGFksFOtBbFGmRIqS.jpg",
  backdrop_path: "/fAMzIbpSNXFh1P8qFEFz7WDNXZC.jpg",
  release_date: "2025-05-01",
  genre_ids: [28, 12, 878],
  popularity: 4231.8,
  vote_average: 7.4,
  vote_count: 892,
  adult: false,
  video: false,
};

const TV_EXAMPLE = {
  id: 209867,
  name: "The Last of Us",
  original_name: "The Last of Us",
  original_language: "en",
  overview:
    "Twenty years after modern civilization has been destroyed, Joel, a hardened survivor, is hired to smuggle Ellie, a 14-year-old girl, out of an oppressive quarantine zone.",
  poster_path: "/uKvVjHNqB5VmOrdxqAt2F7J78ED.jpg",
  backdrop_path: "/mABONFe5kSgno1yCFMOFRtNOIHG.jpg",
  first_air_date: "2023-01-15",
  genre_ids: [18, 10759, 10765],
  origin_country: ["US"],
  popularity: 3201.5,
  vote_average: 8.5,
  vote_count: 4120,
};

const MOVIE_CREDITS_EXAMPLE = {
  id: 1087388,
  cast: [
    { id: 1136406, name: "Florence Pugh", character: "Yelena Belova", order: 0 },
    { id: 1327, name: "Sebastian Stan", character: "Bucky Barnes", order: 1 },
    { id: 1394417, name: "David Harbour", character: "Alexei Shostakov / Red Guardian", order: 2 },
    { id: 1213831, name: "Wyatt Russell", character: "John Walker / U.S. Agent", order: 3 },
    { id: 2143059, name: "Hannah John-Kamen", character: "Ava Starr / Ghost", order: 4 },
  ],
  crew: [
    { id: 7291, name: "Jake Schreier", job: "Director", department: "Directing" },
    { id: 78746, name: "Eric Pearson", job: "Screenplay", department: "Writing" },
    { id: 2241380, name: "Lee Sung Jin", job: "Story", department: "Writing" },
    { id: 2309, name: "Kevin Feige", job: "Producer", department: "Production" },
  ],
};

const TV_CREDITS_EXAMPLE = {
  id: 209867,
  cast: [
    { id: 2963, name: "Pedro Pascal", character: "Joel Miller", order: 0 },
    { id: 2273952, name: "Bella Ramsey", character: "Ellie Williams", order: 1 },
    { id: 2737060, name: "Anna Torv", character: "Tess", order: 2 },
  ],
  crew: [
    { id: 1252772, name: "Craig Mazin", job: "Executive Producer", department: "Production" },
    { id: 1252773, name: "Neil Druckmann", job: "Executive Producer", department: "Production" },
  ],
};

const TV_DETAILS_EXAMPLE = {
  id: 209867,
  name: "The Last of Us",
  created_by: [
    { id: 1252772, name: "Craig Mazin", credit_id: "6255994e4e63970042f34df5", gender: 2 },
    { id: 1252773, name: "Neil Druckmann", credit_id: "6255994e4e63970042f34df6", gender: 2 },
  ],
  episode_run_time: [55],
  first_air_date: "2023-01-15",
  number_of_episodes: 9,
  number_of_seasons: 1,
  status: "Returning Series",
  networks: [{ id: 49, name: "HBO" }],
  origin_country: ["US"],
  original_language: "en",
};

function Json({ data }: { data: unknown }) {
  return (
    <pre className="bg-zinc-900 text-green-300 rounded-xl p-4 overflow-x-auto text-xs leading-relaxed whitespace-pre-wrap">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-5 sm:p-6 space-y-4">
      <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">{title}</h2>
      {children}
    </section>
  );
}

export default function TmdbSamplePage() {
  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col items-center py-6 sm:py-10 px-4">
      <div className="w-full max-w-3xl space-y-8">
        <div>
          <Link href="/help" className="text-xs text-indigo-600 hover:underline">← Help</Link>
          <h1 className="text-xl sm:text-2xl font-bold text-zinc-900 mt-1">TMDB Data — Coming Soon</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Typical API responses from TMDB that power the Coming Soon channel. Useful for deciding what filters to expose.
          </p>
        </div>

        <Section title="Endpoints used">
          <ul className="text-sm text-zinc-600 space-y-2 list-disc pl-5 leading-relaxed">
            <li><code className="bg-zinc-100 px-1 rounded text-xs">/movie/upcoming?page=N</code> — theatrical releases in the next few weeks (US-centric by default; add <code className="bg-zinc-100 px-1 rounded text-xs">region=XX</code> to shift)</li>
            <li><code className="bg-zinc-100 px-1 rounded text-xs">/tv/on_the_air?page=N</code> — TV shows airing within the next 7 days</li>
            <li><code className="bg-zinc-100 px-1 rounded text-xs">/movie/{"{id}"}/credits</code> — cast + crew for director and top actors</li>
            <li><code className="bg-zinc-100 px-1 rounded text-xs">/tv/{"{id}"}</code> — series details (created_by for showrunner)</li>
            <li><code className="bg-zinc-100 px-1 rounded text-xs">/tv/{"{id}"}/credits</code> — cast</li>
            <li><code className="bg-zinc-100 px-1 rounded text-xs">/movie/{"{id}"}/videos</code> or <code className="bg-zinc-100 px-1 rounded text-xs">/tv/{"{id}"}/videos</code> — YouTube trailer key</li>
          </ul>
        </Section>

        <Section title="Movie — /movie/upcoming result item">
          <p className="text-xs text-zinc-500">
            Fields we use: <strong>id</strong>, <strong>title</strong>, <strong>original_language</strong>, <strong>overview</strong>, <strong>poster_path</strong>, <strong>release_date</strong>, <strong>genre_ids</strong>.
            Available but unused: <strong>popularity</strong>, <strong>vote_average</strong>, <strong>vote_count</strong>, <strong>backdrop_path</strong>.
            No country/region in the result — filter via the <code className="bg-zinc-100 px-1 rounded text-xs">region</code> query param instead.
          </p>
          <Json data={MOVIE_EXAMPLE} />
        </Section>

        <Section title="TV — /tv/on_the_air result item">
          <p className="text-xs text-zinc-500">
            Note <strong>name</strong> (not title) and <strong>first_air_date</strong> (not release_date).
            <strong className="text-zinc-700"> origin_country</strong> is an array of ISO-3166-1 alpha-2 codes — the only country signal available in TV results.
            Filterable by country here without a separate API call.
          </p>
          <Json data={TV_EXAMPLE} />
        </Section>

        <Section title="Movie credits — /movie/{id}/credits">
          <p className="text-xs text-zinc-500">
            We extract <strong>Director</strong> from crew and top 5 cast by <strong>order</strong>.
          </p>
          <Json data={MOVIE_CREDITS_EXAMPLE} />
        </Section>

        <Section title="TV details — /tv/{id} (for showrunner)">
          <p className="text-xs text-zinc-500">
            <strong>created_by</strong> is used as the equivalent of director for TV shows.
          </p>
          <Json data={TV_DETAILS_EXAMPLE} />
        </Section>

        <Section title="TV credits — /tv/{id}/credits">
          <p className="text-xs text-zinc-500">Top cast by order.</p>
          <Json data={TV_CREDITS_EXAMPLE} />
        </Section>

        <Section title="Filtering notes">
          <ul className="text-sm text-zinc-600 space-y-3 list-disc pl-5 leading-relaxed">
            <li>
              <strong className="text-zinc-800">Language</strong> — both movies and TV have <code className="bg-zinc-100 px-1 rounded text-xs">original_language</code> (ISO 639-1: "en", "fr", etc.). Already wired in.
            </li>
            <li>
              <strong className="text-zinc-800">Genre</strong> — <code className="bg-zinc-100 px-1 rounded text-xs">genre_ids</code> is an array of integer IDs. Movie and TV genre IDs differ for the same genre name (e.g., Action = 28 for movies, 10759 for TV). Already wired in.
            </li>
            <li>
              <strong className="text-zinc-800">Country / region (movies)</strong> — Not in the result payload. TMDB supports a <code className="bg-zinc-100 px-1 rounded text-xs">region=XX</code> query parameter on <code className="bg-zinc-100 px-1 rounded text-xs">/movie/upcoming</code> that filters by theatrical release country. Adding a region chip to the Coming Soon editor and passing it as a query param is straightforward.
            </li>
            <li>
              <strong className="text-zinc-800">Country / region (TV)</strong> — <code className="bg-zinc-100 px-1 rounded text-xs">origin_country</code> is in the result (e.g., <code className="bg-zinc-100 px-1 rounded text-xs">["US"]</code>). Can be filtered client-side after fetch.
            </li>
            <li>
              <strong className="text-zinc-800">Popularity / rating</strong> — <code className="bg-zinc-100 px-1 rounded text-xs">vote_average</code> and <code className="bg-zinc-100 px-1 rounded text-xs">popularity</code> are available. Could filter out obscure titles.
            </li>
          </ul>
        </Section>
      </div>
    </div>
  );
}
