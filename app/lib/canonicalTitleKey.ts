/**
 * Collapse common spellings so the same film is not treated as distinct in history, queues, and lists
 * (e.g. Se7en vs Seven; US "The Bicycle Thief" vs international "The Bicycle Thieves").
 */
export function canonicalTitleKey(title: string): string {
  if (!title || typeof title !== "string") return "";
  const s = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^(the|a|an)\s+/, "")   // strip leading articles before collapsing punctuation
    .replace(/[^a-z0-9]+/g, "");
  if (s === "se7en" || s === "seven") return "seven";
  // Ladri di biciclette (1948)
  if (
    s === "thebicyclethief" ||
    s === "thebicyclethieves" ||
    s === "bicyclethief" ||
    s === "bicyclethieves" ||
    s === "ladridibiciclette"
  ) {
    return "bicyclethieves";
  }
  return s;
}
