
/**
 * Genre/style words must never appear as artist quick-pick toggles
 * (from LLM mistakes or legacy channel data).
 */

const STYLE_TERMS_BLOCKLIST = new Set<string>([
  'chillwave',
  'chamber music',
  'cool jazz',
  'motown',
  'hip hop',
  'hip-hop',
  'pop',
  'rock',
  'r&b',
  'rb',
  'electronic',
  'jazz',
  'classical',
  'country',
  'folk',
  'metal',
  'soul',
  'blues',
  'reggae',
  'latin',
  'punk',
  'house',
  'techno',
  'ambient',
  'downtempo',
  'trip hop',
  'trip-hop',
  'nu jazz',
  'nu-jazz',
  'french touch',
  'synthwave',
  'vaporwave',
  'shoegaze',
  'post-punk',
  'indie',
  'alternative',
  'soundtrack',
  'instrumental',
  'vocal',
  'acoustic',
  'obscure',
  'mainstream',
  'upbeat',
  'mellow',
  'chill',
  'chillout',
  'lounge',
  'baroque',
  'romantic',
  'renaissance',
  'medieval',
  'quartets',
  'trios',
  'piano',
  'detroit',
  'underground',
])

function normalizeStyleKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function isGenreOrStyleTerm(name: string): boolean {
  return STYLE_TERMS_BLOCKLIST.has(normalizeStyleKey(name))
}

/** Drop genre/style tokens mistakenly stored in channel.artists (e.g. "Chillwave"). */
export function sanitizeSelectedArtists(names: string[]): string[] {
  return names.filter(n => typeof n === 'string' && n.trim() && !isGenreOrStyleTerm(n))
}

function pushArtistHint(out: string[], seen: Set<string>, raw: string) {
  const t = raw.trim().replace(/\s+/g, ' ')
  if (t.length < 2 || t.length > 80 || isGenreOrStyleTerm(t)) return
  const k = t.toLowerCase()
  if (seen.has(k)) return
  seen.add(k)
  out.push(t)
}

/** Artist names implied by channel title + notes (before / alongside LLM suggestions). */
export function extractArtistHintsFromChannel(input: {
  name?: string
  notes?: string
  genreText?: string
}): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  pushArtistHint(out, seen, input.name ?? '')

  const notes = [input.notes, input.genreText].filter(Boolean).join('\n').trim()
  if (!notes) return out

  for (const m of notes.matchAll(/"([^"]{2,80})"|'([^']{2,80})'/g)) {
    pushArtistHint(out, seen, m[1] ?? m[2] ?? '')
  }

  const listLine = notes.match(
    /(?:^|\n)\s*(?:artists?|bands?|acts?|focus(?:\s+on)?)\s*[:—–-]\s*([^\n.]+)/im
  )
  if (listLine?.[1]) {
    for (const part of listLine[1].split(/[,;]/)) pushArtistHint(out, seen, part)
  }

  // "only Angine de poitrine", "all Angine de poitrine", etc.
  for (const m of notes.matchAll(
    /\b(?:only|just|all|mostly|mainly)\s+([A-ZÀ-ÿ][\w'’.-]*(?:\s+[A-Za-zÀ-ÿ][\w'’.-]*){0,5})/g
  )) {
    pushArtistHint(out, seen, m[1] ?? '')
  }

  return out
}

export function mergeArtistHintLists(...lists: string[][]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    for (const name of list) pushArtistHint(out, seen, name)
  }
  return out
}

const GENERIC_CHANNEL_NAMES = new Set(['new channel', 'all', 'untitled'])

/** Channel title when it looks like a real act (not a genre label or generic name). */
export function channelNameAsArtistHint(name?: string): string | undefined {
  const out: string[] = []
  const seen = new Set<string>()
  pushArtistHint(out, seen, name ?? '')
  return out[0]
}

/** When the channel title equals a known artist name, return that canonical spelling. */
export function findArtistMatchingChannelName(
  channelName: string,
  candidates: string[]
): string | undefined {
  const key = normalizeStyleKey(channelName)
  if (!key || GENERIC_CHANNEL_NAMES.has(key) || isGenreOrStyleTerm(channelName)) return undefined
  for (const candidate of candidates) {
    if (normalizeStyleKey(candidate) === key) return candidate
  }
  return undefined
}

/** Include channel-title artist matches in the saved config artists list. */
export function mergeChannelNameArtistMatch(
  channelName: string,
  selectedArtists: string[],
  candidateArtists: string[]
): string[] {
  const match = findArtistMatchingChannelName(channelName, candidateArtists)
  if (!match) return selectedArtists
  return mergeArtistHintLists(selectedArtists, [match])
}
