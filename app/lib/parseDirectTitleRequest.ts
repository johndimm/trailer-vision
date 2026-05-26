export type DirectTitleRequest = {
  title: string;
  year: number | null;
  type: "movie" | "tv";
};

const TV_HINT = /\b(tv\s*(series|show)?|series|miniseries|show)\b/i;
const MOVIE_HINT = /\b(movies?|films?|features?)\b/i;

function inferType(text: string, mediaType: "movie" | "tv" | "both"): "movie" | "tv" {
  if (TV_HINT.test(text) && !MOVIE_HINT.test(text)) return "tv";
  if (MOVIE_HINT.test(text) && !TV_HINT.test(text)) return "movie";
  if (mediaType === "tv") return "tv";
  return "movie";
}

function cleanTitle(raw: string): string {
  return raw.replace(/^[\s"'“]+|[\s"'”]+$/g, "").replace(/^(the|a|an)\s+/i, "").trim();
}

/** True when the whole prompt names one title (e.g. "Fjord 2026 movie"), not a taste paragraph. */
export function parseDirectTitleRequest(
  text: string,
  mediaType: "movie" | "tv" | "both" = "both",
): DirectTitleRequest | null {
  const t = text.trim();
  if (!t || t.length > 100) return null;
  if (t.includes("\n")) return null;
  if (/[,;|]/.test(t)) return null;
  if (/\b(similar|like|films about|movies about|recommend|channel for)\b/i.test(t)) return null;

  const year = (s: string) => {
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : null;
  };

  let m = t.match(/^(.+?)\s+(19|20\d{2})\s+(movies?|films?|features?|tv\s*(?:series|show)?|series|miniseries|shows?)\s*$/i);
  if (m) {
    const title = cleanTitle(m[1]!);
    if (!title) return null;
    return { title, year: year(m[2]!), type: inferType(m[3]!, mediaType) };
  }

  m = t.match(/^(.+?)\s*\((19|20\d{2})\)\s*$/);
  if (m) {
    const title = cleanTitle(m[1]!);
    if (!title) return null;
    return { title, year: year(m[2]!), type: inferType(t, mediaType) };
  }

  m = t.match(/^(.+?)\s+(19|20\d{2})\s*$/);
  if (m) {
    const title = cleanTitle(m[1]!);
    if (!title || title.split(/\s+/).length > 8) return null;
    return { title, year: year(m[2]!), type: inferType(t, mediaType) };
  }

  m = t.match(/^(19|20\d{2})\s+(.+?)\s+(movies?|films?|features?|tv\s*(?:series|show)?|series|miniseries|shows?)\s*$/i);
  if (m) {
    const title = cleanTitle(m[2]!);
    if (!title) return null;
    return { title, year: year(m[1]!), type: inferType(m[3]!, mediaType) };
  }

  return null;
}

export function directTitlePromptFromRequest(input: {
  userRequest?: string | null;
  activeChannel?: { freeText?: string } | null;
}): string | null {
  const channelText = input.activeChannel?.freeText?.trim();
  const userText = input.userRequest?.trim();
  if (channelText && parseDirectTitleRequest(channelText)) return channelText;
  if (userText && parseDirectTitleRequest(userText)) return userText;
  return null;
}

/** Wording for LLM constraints — avoids echoing the raw prompt into title fields. */
export function directTitleConstraintLine(
  parsed: DirectTitleRequest,
): string {
  const kind = parsed.type === "tv" ? "TV series" : "film";
  const yearBit = parsed.year ? ` (${parsed.year})` : "";
  return `DIRECT TITLE REQUEST: the ${kind} "${parsed.title}"${yearBit}. If the user has already seen it, suggest similar ${parsed.type === "tv" ? "series" : "films"} instead. Each JSON "title" field must be the exact official release name only — never repeat this channel description, never use colons or prefixes.`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Prefixes the LLM may wrongly prepend to title fields (longest first). */
export function llmTitlePrefixCandidates(input: {
  activeChannel?: { name?: string; freeText?: string } | null;
  userRequest?: string | null;
  mediaType?: "movie" | "tv" | "both";
}): string[] {
  const out: string[] = [];
  const channelText = input.activeChannel?.freeText?.trim();
  const userText = input.userRequest?.trim();
  const channelName = input.activeChannel?.name?.trim();
  const mediaType = input.mediaType ?? "both";

  if (channelText) out.push(channelText);
  if (userText && userText !== channelText) out.push(userText);
  if (channelName) out.push(channelName);

  for (const text of [channelText, userText]) {
    if (!text) continue;
    const parsed = parseDirectTitleRequest(text, mediaType);
    if (!parsed) continue;
    const { title, year, type } = parsed;
    const typeWord = type === "tv" ? "tv series" : "movie";
    if (year) {
      out.push(`${title} ${year} ${typeWord}`);
      out.push(`${title} ${year} film`);
      out.push(`${title} ${year}`);
    }
    out.push(title);
  }

  return [...new Set(out.filter(Boolean))].sort((a, b) => b.length - a.length);
}

/** Strip channel prompt / label prefixes mistakenly included in LLM title output. */
export function sanitizeLlmMovieTitle(title: string, prefixes: string[]): string {
  let t = title.trim();
  for (const prefix of prefixes) {
    const p = prefix.trim();
    if (!p) continue;
    const colonPattern = new RegExp(`^${escapeRegex(p)}\\s*[:\\-—–]\\s*`, "i");
    if (colonPattern.test(t)) {
      t = t.replace(colonPattern, "").trim();
    }
  }
  return t;
}
