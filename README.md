This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Trailer Vision

TikTok-style, trailer-first movie/TV discovery. You rate titles (red stars = seen, blue = unseen
interest) and a language model learns your taste by **content similarity** — not collaborative
filtering — serving the next batch from a per-channel prefetch queue. Trailers autoplay; an **Auto**
toggle + Fullscreen lets you watch hands-free. All data lives in the browser under `movie-recs-*`
localStorage keys — no accounts, no server database, no ads.

### Features
- **Channels** — independent "taste islands", each with its own filters, queue, and ratings.
  Filters include genres, era, language, format (movies / TV), and **streaming service**
  (Netflix, Amazon Prime, Apple TV+, Disney+, HBO Max, Hulu, Paramount+, Peacock). The starter
  pack ships a ready-made channel per major streamer.
- **Search** — a home-screen box that drops results straight into the queue and plays them:
  TMDB title/name lookup first (exact and brand-new titles), LLM fallback for moods and genres
  (`/api/search`).
- **Coming Soon** — a special channel that skips the LLM and pulls new/upcoming titles from TMDB
  (`/api/upcoming`), filterable by streaming service via TMDB watch providers. See raw sample
  payloads at `/tmdb-sample`.
- **Constellations graph** — embedded below the player, mapping cast/director/related films
  (`@johndimm/constellations`), with AI/cache calls proxied through this app's own routes.
- **History as playlist** — select past titles and play them back-to-back.
- **Export / Import** — back up or move all data as JSON from Settings.

### Docs
- In-app **Help** (`/help`), the **App Prompt History + full spec** (`/prompt`, the prompts used
  to build the app with Claude and Cursor), and the
  **Dev Journal** (`/journal`).
- Architecture principles in `ARCHITECTURE.md`; agent/runtime notes in `AGENTS.md`.

### Key env vars
See the full list at the bottom of `/prompt`. Most important: `DEEPSEEK_API_KEY` (default LLM,
plus optional `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`), `TMDB_API_KEY` (posters,
trailers, Coming Soon, Constellations credits), `NEXT_PUBLIC_APP_URL` (same-origin Constellations
proxy base), and `CONSTELLATIONS_EXTERNAL_URL` (upstream graph backend).
