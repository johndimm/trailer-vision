/** Year from a Wikipedia-style title, e.g. "Django (1966 film)" → 1966 */
export function extractYearFromFilmTitle(title: string): number | null {
  const paren = title.match(/\((\d{4})\s*(?:film|movie|tv)/i);
  if (paren) return parseInt(paren[1], 10);
  const bare = title.match(/\b(18|19|20)\d{2}\b/);
  return bare ? parseInt(bare[0], 10) : null;
}

/**
 * Wikipedia-friendly graph seed for films/TV.
 * "Django" + 1966 → "Django (1966 film)" (avoids Django (2017 film), etc.).
 */
export function filmWorkSearchTerm(
  title: string,
  year?: number | null,
  type?: string | null
): string {
  const t = title.replace(/\s+/g, " ").trim();
  if (!t) return t;
  if (/\(\d{4}\s*(?:film|movie|tv)/i.test(t)) return t;
  const y = year ?? extractYearFromFilmTitle(t);
  if (!y) return t;
  const base = t.replace(/\s*\([^)]*\)\s*$/, "").trim() || t;
  const kind =
    type === "tv" || /\b(tv series|television)\b/i.test(String(type || ""))
      ? "TV series"
      : "film";
  return `${base} (${y} ${kind})`;
}
