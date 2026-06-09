import { callLLM } from "../api/next-movie/llm";

export interface CategorySuper {
  id: string;
  label: string;
  leaves: string[];
}

export interface CategoryDimension {
  id: string;
  label: string;
  supers: CategorySuper[];
}

export interface CategoryTree {
  dimensions: CategoryDimension[];
}

export interface CategoryPath {
  dimension: string;
  super: string;
  leaf?: string | null;
}

function stripMarkdownJsonFence(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function slugId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function normalizePath(raw: unknown): CategoryPath | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const dimension = typeof o.dimension === "string" ? slugId(o.dimension) : "";
  const superId = typeof o.super === "string" ? slugId(o.super) : "";
  if (!dimension || !superId) return null;
  const leaf =
    typeof o.leaf === "string" && o.leaf.trim() ? o.leaf.trim().toLowerCase() : null;
  return { dimension, super: superId, leaf };
}

export function normalizeCategoryTree(raw: unknown): CategoryTree | null {
  if (!raw || typeof raw !== "object") return null;
  const dims = (raw as { dimensions?: unknown }).dimensions;
  if (!Array.isArray(dims)) return null;

  const dimensions: CategoryDimension[] = [];
  for (const d of dims) {
    if (!d || typeof d !== "object") continue;
    const dim = d as Record<string, unknown>;
    const id = typeof dim.id === "string" ? slugId(dim.id) : "";
    const label = typeof dim.label === "string" ? dim.label.trim() : "";
    const supersRaw = dim.supers;
    if (!id || !label || !Array.isArray(supersRaw)) continue;

    const supers: CategorySuper[] = [];
    for (const s of supersRaw) {
      if (!s || typeof s !== "object") continue;
      const sup = s as Record<string, unknown>;
      const supId = typeof sup.id === "string" ? slugId(sup.id) : "";
      const supLabel = typeof sup.label === "string" ? sup.label.trim() : "";
      const leavesRaw = sup.leaves;
      if (!supId || !supLabel || !Array.isArray(leavesRaw)) continue;
      const leaves = leavesRaw
        .filter((l): l is string => typeof l === "string" && !!l.trim())
        .map((l) => l.trim().toLowerCase());
      if (!leaves.length) continue;
      supers.push({ id: supId, label: supLabel, leaves });
    }
    if (!supers.length) continue;
    dimensions.push({ id, label, supers });
  }

  return dimensions.length ? { dimensions } : null;
}

/** When channel constraints are set: require tree paths for tagging, not 20Q exploration. */
export function buildChannelTreeTaggingSection(tree: CategoryTree): string {
  return `${formatTreeForPrompt(tree)}

CHANNEL TAGGING (constraints are fixed — do NOT wander outside the channel):
Tag every pick with category_paths from this tree. Choose titles that genuinely fit the channel AND the tree paths.`;
}

export function formatTreeForPrompt(tree: CategoryTree): string {
  const lines: string[] = ["SESSION CATEGORY TREE (tag every pick with category_paths from this taxonomy):"];
  for (const dim of tree.dimensions) {
    lines.push(`\n${dim.label} [${dim.id}]:`);
    for (const sup of dim.supers) {
      lines.push(`  · ${sup.label} [${dim.id}/${sup.id}] — leaves: ${sup.leaves.join(", ")}`);
    }
  }
  return lines.join("\n");
}

export function superKey(p: CategoryPath): string {
  return `${p.dimension}:${p.super}`;
}

export function leafKey(p: CategoryPath): string {
  return p.leaf ? `${p.dimension}:${p.super}:${p.leaf}` : superKey(p);
}

function normalizeLeafToken(leaf: string): string {
  return leaf.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function leavesAlign(targetLeaf: string, filmLeaf: string): boolean {
  const a = normalizeLeafToken(targetLeaf);
  const b = normalizeLeafToken(filmLeaf);
  return a === b || a.includes(b) || b.includes(a);
}

function yearMatchesEraSuper(superId: string, year: number): boolean {
  const m = superId.match(/(\d{4})/);
  if (!m) return false;
  const decade = parseInt(m[1]!, 10);
  return year >= decade && year < decade + 10;
}

function scoreTargetPathAgainstFilm(
  target: CategoryPath,
  filmPaths: CategoryPath[],
  filmYear?: number | null,
): { stars: number; reason: string } {
  let bestStars = 1;
  let bestReason = `No overlap on dimension ${target.dimension}`;

  for (const film of filmPaths) {
    if (target.dimension !== film.dimension) continue;

    if (target.super === film.super) {
      if (target.leaf && film.leaf) {
        if (leavesAlign(target.leaf, film.leaf)) {
          return {
            stars: 5,
            reason: `Exact leaf: ${target.dimension}/${target.super}/${target.leaf}`,
          };
        }
        const eraYearOk =
          target.dimension === "era" &&
          filmYear != null &&
          yearMatchesEraSuper(target.super, filmYear);
        if (eraYearOk && bestStars < 4) {
          bestStars = 4;
          bestReason = `Same era super ${target.super} (release year ${filmYear} fits; leaf tag "${film.leaf}" vs target "${target.leaf}")`;
        } else if (bestStars < 3) {
          bestStars = 3;
          bestReason = `Same super, different leaf: target "${target.leaf}", got "${film.leaf}" (${target.dimension}/${target.super})`;
        }
      } else if (target.leaf && !film.leaf) {
        if (bestStars < 3) {
          bestStars = 3;
          bestReason = `Same super but missing leaf tag (target "${target.leaf}" on ${target.dimension}/${target.super})`;
        }
      } else if (bestStars < 4) {
        bestStars = 4;
        bestReason = `Same super-category: ${target.dimension}/${target.super}`;
      }
    } else if (
      target.dimension === "era" &&
      filmYear != null &&
      yearMatchesEraSuper(target.super, filmYear) &&
      bestStars < 4
    ) {
      bestStars = 4;
      bestReason = `Release year ${filmYear} fits target era ${target.super} (tagged under sibling super ${film.super})`;
    } else if (bestStars < 2) {
      bestStars = 2;
      bestReason = `Sibling super on ${target.dimension}: target ${target.super}, got ${film.super}`;
    }
  }

  return { stars: bestStars, reason: bestReason };
}

/**
 * Hierarchical fit for taste-test oracle.
 * Compound preferences average per-dimension path scores (era AND genre both matter).
 * Leaf-specific targets need exact or aligned leaf match for 5★.
 */
export function hierarchicalStarScore(
  targetPaths: CategoryPath[],
  filmPaths: CategoryPath[],
  filmYear?: number | null,
  opts?: { discoveryMode?: boolean },
): { stars: number; reason: string } {
  if (!targetPaths.length || !filmPaths.length) {
    return { stars: 3, reason: "Missing tree paths — neutral score" };
  }

  const perTarget = targetPaths.map((t) => scoreTargetPathAgainstFilm(t, filmPaths, filmYear));

  if (targetPaths.length > 1) {
    const scores = perTarget.map((p) => p.stars);
    const combined = opts?.discoveryMode
      ? Math.max(...scores)
      : scores.reduce((sum, s) => sum + s, 0) / scores.length;
    const stars = Math.max(1, Math.min(5, Math.round(combined)));
    const reason = perTarget.map((p) => p.reason).join(" | ");
    return { stars, reason };
  }

  return perTarget[0]!;
}

/** Does category/tags read as fitting the target preference (channel-hint oracle boost). */
export function preferenceDisplayFitScore(
  preference: string,
  targetPaths: CategoryPath[],
  item: { categories?: string[]; categoryPaths?: CategoryPath[]; year?: number | null },
): { stars: number; reason: string } {
  const targetLeaves = targetPaths.map((p) => p.leaf).filter((l): l is string => !!l);
  const hayParts = [
    ...(item.categories ?? []).map((c) => c.toLowerCase()),
    ...(item.categoryPaths ?? []).flatMap((p) => [p.super, p.leaf ?? ""].map((x) => x.toLowerCase())),
  ];
  const hay = normalizeLeafToken(hayParts.join(" "));
  const prefNorm = normalizeLeafToken(preference);

  let leafHits = 0;
  for (const leaf of targetLeaves) {
    const n = normalizeLeafToken(leaf);
    if (n && (hay.includes(n) || prefNorm.includes(n) || n.includes(prefNorm))) leafHits++;
  }

  if (leafHits >= 2) {
    return { stars: 5, reason: `Category/tags match preference leaves (${targetLeaves.join(", ")})` };
  }
  if (leafHits === 1) {
    return { stars: 4, reason: `Partial leaf match for "${preference}"` };
  }

  const eraTarget = targetPaths.find((p) => p.dimension === "era");
  if (
    eraTarget &&
    item.year != null &&
    yearMatchesEraSuper(eraTarget.super, item.year) &&
    hay.includes(normalizeLeafToken(targetLeaves[0] ?? preference))
  ) {
    return { stars: 4, reason: `Era + style match (${item.year}, ${preference})` };
  }

  if (prefNorm.length >= 4 && hay.includes(prefNorm)) {
    return { stars: 4, reason: "Category contains preference phrase" };
  }

  return { stars: 1, reason: "Category/tags do not read as matching preference" };
}

/** Best of tree fit and display fit — channel hints should score what viewers actually get. */
export function tasteTestStarScore(
  preference: string,
  targetPaths: CategoryPath[],
  item: { categories?: string[]; categoryPaths?: CategoryPath[]; year?: number | null },
  opts?: { channelHint?: boolean; discoveryMode?: boolean },
): { stars: number; reason: string } {
  const paths = item.categoryPaths ?? [];
  const tree =
    paths.length > 0
      ? hierarchicalStarScore(targetPaths, paths, item.year, {
          discoveryMode: opts?.discoveryMode === true,
        })
      : { stars: 3, reason: "No category_paths — neutral tree score" };

  if (!opts?.channelHint) return tree;

  const display = preferenceDisplayFitScore(preference, targetPaths, item);
  const stars = Math.max(tree.stars, display.stars);
  const reason =
    stars === tree.stars
      ? tree.reason
      : stars === display.stars
        ? display.reason
        : `${display.reason} (tree: ${tree.stars}★)`;
  return { stars, reason };
}

function untriedSupersForDimension(
  dim: CategoryDimension,
  tried: Set<string>,
): CategorySuper[] {
  const untried = dim.supers.filter((s) => !tried.has(`${dim.id}:${s.id}`));
  return untried.length ? untried : dim.supers;
}

export interface ExplorationSlot {
  slot: number;
  dimension: string;
  dimensionLabel: string;
  super: string;
  superLabel: string;
  /** Exact leaf this slot must tag — narrows niche discovery (e.g. era + genre combos). */
  requiredLeaf: string;
  leaves: string[];
}

function leafBridgeCount(tree: CategoryTree, leaf: string): number {
  return findSupersForLeaf(tree, leaf).length;
}

function pickSuperAndLeaf(
  dim: CategoryDimension,
  pool: CategorySuper[],
  slotIndex: number,
  tree: CategoryTree,
): { super: CategorySuper; leaf: string } | null {
  if (!pool.length) return null;

  const ranked = [...pool].sort((a, b) => {
    const aBridge = Math.max(...a.leaves.map((l) => leafBridgeCount(tree, l)), 0);
    const bBridge = Math.max(...b.leaves.map((l) => leafBridgeCount(tree, l)), 0);
    if (bBridge !== aBridge) return bBridge - aBridge;
    return 0;
  });

  const pick = ranked[slotIndex % ranked.length] ?? ranked[0]!;
  const rankedLeaves = [...pick.leaves].sort(
    (a, b) => leafBridgeCount(tree, b) - leafBridgeCount(tree, a),
  );
  const leaf = rankedLeaves[slotIndex % rankedLeaves.length] ?? rankedLeaves[0] ?? pick.leaves[0];
  if (!leaf) return null;
  return { super: pick, leaf };
}

export function buildRoundOneSlots(
  tree: CategoryTree,
  batchCount: number,
  triedSuperKeys: string[],
): ExplorationSlot[] {
  const tried = new Set(triedSuperKeys);
  const dims = tree.dimensions;
  if (!dims.length) return [];

  const slots: ExplorationSlot[] = [];
  for (let i = 0; i < batchCount; i++) {
    const dim = dims[i % dims.length]!;
    const pool = untriedSupersForDimension(dim, tried);
    const picked = pickSuperAndLeaf(dim, pool, i, tree);
    if (!picked) continue;
    slots.push({
      slot: i + 1,
      dimension: dim.id,
      dimensionLabel: dim.label,
      super: picked.super.id,
      superLabel: picked.super.label,
      requiredLeaf: picked.leaf,
      leaves: picked.super.leaves,
    });
  }
  return slots;
}

export function formatRoundOneSlotRequirements(slots: ExplorationSlot[]): string {
  if (!slots.length) return "";

  const lines = slots.map(
    (s) =>
      `Item ${s.slot}: category_paths MUST include {"dimension":"${s.dimension}","super":"${s.super}","leaf":"${s.requiredLeaf}"} — choose a real, well-known film that genuinely fits ${s.dimensionLabel} → ${s.superLabel} → ${s.requiredLeaf}`,
  );

  return `MANDATORY ROUND-1 SLOT ASSIGNMENTS (${slots.length} items — one film per slot, in order):
${lines.join("\n")}

CRITICAL: items[0] fulfills slot 1, items[1] slot 2, etc. Each film's category_paths must include its slot's dimension+super+leaf exactly as listed.
Also add 1–2 extra category_paths when they genuinely fit (era + genre + region together helps niche discovery).
Do NOT assign two films to the same super-category in this batch.`;
}

/** True when each item's paths include the required dimension+super for its slot. */
export function validateBatchAgainstSlots(
  items: Array<{ categoryPaths?: CategoryPath[] }>,
  slots: ExplorationSlot[],
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const n = Math.min(items.length, slots.length);

  for (let i = 0; i < n; i++) {
    const slot = slots[i]!;
    const paths = items[i]?.categoryPaths ?? [];
    const match = paths.some(
      (p) =>
        p.dimension === slot.dimension &&
        p.super === slot.super &&
        p.leaf === slot.requiredLeaf,
    );
    if (!match) {
      failures.push(
        `Item ${i + 1} "${(items[i] as { title?: string }).title ?? "?"}" missing required path ${slot.dimension}/${slot.super}/${slot.requiredLeaf}`,
      );
    }
  }

  if (items.length < slots.length) {
    failures.push(`Expected ${slots.length} items but got ${items.length}`);
  }

  return { ok: failures.length === 0, failures };
}

export function formatSlotValidationFeedback(failures: string[], slots: ExplorationSlot[]): string {
  return `YOUR PREVIOUS RESPONSE VIOLATED ROUND-1 SLOT RULES:
${failures.map((f) => `- ${f}`).join("\n")}

Regenerate the full batch. ${formatRoundOneSlotRequirements(slots)}`;
}

/** Leaves that appear in 2+ dimensions — compound tastes often converge on these. */
function multiDimensionLeaves(tree: CategoryTree): Map<string, CategoryPath[]> {
  const byLeaf = new Map<string, CategoryPath[]>();
  for (const dim of tree.dimensions) {
    for (const sup of dim.supers) {
      for (const leaf of sup.leaves) {
        const k = leaf.toLowerCase();
        const path = { dimension: dim.id, super: sup.id, leaf };
        if (!byLeaf.has(k)) byLeaf.set(k, []);
        byLeaf.get(k)!.push(path);
      }
    }
  }
  return new Map([...byLeaf.entries()].filter(([, paths]) => paths.length >= 2));
}

function preferenceTokens(preference: string): string[] {
  return preference
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 4);
}

function buildCompoundLeafDrillDown(
  tree: CategoryTree,
  history: Array<{ userRating: number; categoryPaths?: CategoryPath[]; categories?: string[] }>,
): string {
  const compound = multiDimensionLeaves(tree);
  if (!compound.size) return "";

  const warmHay = new Set<string>();
  for (const entry of history) {
    if (entry.userRating < 3) continue;
    for (const p of entry.categoryPaths ?? []) {
      if (p.leaf) warmHay.add(p.leaf.toLowerCase());
      warmHay.add(p.super.toLowerCase());
    }
    for (const c of entry.categories ?? []) {
      warmHay.add(c.toLowerCase());
    }
  }
  if (!warmHay.size) return "";

  const hints: string[] = [];
  for (const [leaf, paths] of compound) {
    const tokens = leaf.split(/\s+/).filter((t) => t.length >= 4);
    const overlap = tokens.filter((t) => [...warmHay].some((h) => h.includes(t) || t.includes(h)));
    if (overlap.length < 2) continue;
    const pathStr = paths
      .map((p) => `{"dimension":"${p.dimension}","super":"${p.super}","leaf":"${p.leaf}"}`)
      .join(", ");
    hints.push(
      `Compound leaf "${leaf}" spans ${paths.length} dimensions — warm signals overlap on [${overlap.join(", ")}]. Next picks should tag ALL of: ${pathStr}`,
    );
  }

  if (!hints.length) return "";
  return `COMPOUND LEAF TARGETS (cross-dimension convergence — prioritize these over adjacent sibling leaves):
${hints.slice(0, 3).join("\n")}
`;
}

function findSupersForLeaf(
  tree: CategoryTree,
  leaf: string,
): Array<{ dimension: string; super: string; superLabel: string; dimLabel: string }> {
  const key = leaf.trim().toLowerCase();
  const out: Array<{ dimension: string; super: string; superLabel: string; dimLabel: string }> = [];
  for (const dim of tree.dimensions) {
    for (const sup of dim.supers) {
      if (sup.leaves.some((l) => l.toLowerCase() === key)) {
        out.push({ dimension: dim.id, super: sup.id, superLabel: sup.label, dimLabel: dim.label });
      }
    }
  }
  return out;
}

function buildLeafNearMissSection(
  tree: CategoryTree,
  history: Array<{ userRating: number; categoryPaths?: CategoryPath[] }>,
  tried: Set<string>,
): string {
  const leafRatings = new Map<string, number[]>();

  for (const entry of history) {
    if (entry.userRating < 2 || entry.userRating > 4) continue;
    for (const p of entry.categoryPaths ?? []) {
      if (!p.leaf) continue;
      const k = p.leaf.toLowerCase();
      if (!leafRatings.has(k)) leafRatings.set(k, []);
      leafRatings.get(k)!.push(entry.userRating);
    }
  }

  const hints: string[] = [];
  for (const [leaf, ratings] of leafRatings) {
    const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
    if (avg < 2 || avg > 3) continue;

    const supers = findSupersForLeaf(tree, leaf).filter((s) => !tried.has(`${s.dimension}:${s.super}`));
    if (!supers.length) continue;

    hints.push(
      `Leaf "${leaf}" got ~${avg.toFixed(1)}★ (warm signal) — try untried supers that share this leaf: ${supers.map((s) => `${s.dimLabel}/${s.superLabel} [${s.dimension}/${s.super}]`).join("; ")}`,
    );
  }

  const withinSuper: string[] = [];
  for (const entry of history) {
    if (entry.userRating < 2 || entry.userRating > 4) continue;
    for (const p of entry.categoryPaths ?? []) {
      if (!p.leaf) continue;
      const dim = tree.dimensions.find((d) => d.id === p.dimension);
      const sup = dim?.supers.find((s) => s.id === p.super);
      if (!dim || !sup) continue;
      const siblingLeaves = sup.leaves.filter((l) => l !== p.leaf);
      if (!siblingLeaves.length) continue;
      withinSuper.push(
        `Super ${dim.label}/${sup.label} [${p.dimension}/${p.super}] showed ~${entry.userRating}★ with leaf "${p.leaf}" — try sibling leaves: ${siblingLeaves.join(", ")}`,
      );
    }
  }

  const lines = [...hints, ...withinSuper.slice(0, 5)];
  if (!lines.length) return "";
  return `LEAF NEAR-MISS DRILL-DOWN (warm leaf signals — explore same leaf in other supers AND sibling leaves within a warm super):
${lines.join("\n")}
`;
}

function buildMultiDimensionRoundOnePlan(
  tree: CategoryTree,
  batchCount: number,
  tried: Set<string>,
): string {
  const slots = buildRoundOneSlots(tree, batchCount, [...tried]);
  return formatRoundOneSlotRequirements(slots);
}

function dimensionWithMostUntriedSupers(
  tree: CategoryTree,
  tried: Set<string>,
): CategoryDimension | null {
  let best: CategoryDimension | null = null;
  let bestCount = -1;
  for (const dim of tree.dimensions) {
    const n = untriedSupersForDimension(dim, tried).length;
    if (n > bestCount) {
      bestCount = n;
      best = dim;
    }
  }
  return best;
}

export function buildTreeExplorationSection(
  tree: CategoryTree,
  history: Array<{ userRating: number; categoryPaths?: CategoryPath[]; categories?: string[] }>,
  batchCount: number,
  triedSuperKeys: string[],
): string {
  const treeBlock = formatTreeForPrompt(tree);
  if (!tree.dimensions.length) return treeBlock;

  const tried = new Set(triedSuperKeys);
  const lovedSupers = new Map<string, number[]>();
  const weakSupers = new Map<string, number[]>();

  for (const entry of history) {
    const paths = entry.categoryPaths ?? [];
    for (const p of paths) {
      const k = superKey(p);
      const leafK = leafKey(p);
      if (entry.userRating >= 4) {
        if (!lovedSupers.has(k)) lovedSupers.set(k, []);
        lovedSupers.get(k)!.push(entry.userRating);
      } else if (entry.userRating >= 3) {
        if (!weakSupers.has(k)) weakSupers.set(k, []);
        weakSupers.get(k)!.push(entry.userRating);
        if (p.leaf) {
          if (!weakSupers.has(leafK)) weakSupers.set(leafK, []);
          weakSupers.get(leafK)!.push(entry.userRating);
        }
      } else if (entry.userRating === 2 && p.leaf) {
        if (!weakSupers.has(leafK)) weakSupers.set(leafK, []);
        weakSupers.get(leafK)!.push(entry.userRating);
      }
    }
  }

  if (history.length === 0) {
    const plan = buildMultiDimensionRoundOnePlan(tree, batchCount, tried);
    return `${treeBlock}

20Q ROUND 1 — MULTI-DIMENSION TOP-LEVEL SAMPLING (no ratings yet):
Spread this batch across DIFFERENT dimensions — not only region. Niche tastes (era + genre combos) must be reachable in round 1.
${plan}
Flat "categories" should echo the leaf labels for display.`;
  }

  const topLoved = [...lovedSupers.entries()]
    .sort((a, b) => {
      const avgA = a[1].reduce((x, y) => x + y, 0) / a[1].length;
      const avgB = b[1].reduce((x, y) => x + y, 0) / b[1].length;
      return avgB - avgA;
    })
    .slice(0, 3)
    .map(([k]) => k);

  const topWeak = [...weakSupers.entries()]
    .sort((a, b) => {
      const avgA = a[1].reduce((x, y) => x + y, 0) / a[1].length;
      const avgB = b[1].reduce((x, y) => x + y, 0) / b[1].length;
      return avgB - avgA;
    })
    .slice(0, 3)
    .map(([k]) => k);

  if (topLoved.length > 0) {
    return `${treeBlock}

20Q DRILL-DOWN — user loves these super-categories: ${topLoved.join(", ")}.
Most picks should explore untried LEAVES within those supers.
Include 1–2 titles from sibling supers (same dimension, different super) to confirm the branch.
Tag every item with category_paths from the tree.`;
  }

  if (topWeak.length > 0) {
    const leafNearMiss = buildLeafNearMissSection(tree, history, tried);
    const compoundDrill = buildCompoundLeafDrillDown(tree, history);
    return `${treeBlock}

20Q WARM-SIGNAL DRILL-DOWN — partial matches on: ${topWeak.join(", ")}.
Double down on those branches — especially untried leaves within the same supers and cross-dimension combos (era + genre).
${compoundDrill}${leafNearMiss}Tag every item with category_paths from the tree.`;
  }

  const nearMiss = [...weakSupers.entries()]
    .sort((a, b) => {
      const avgA = a[1].reduce((x, y) => x + y, 0) / a[1].length;
      const avgB = b[1].reduce((x, y) => x + y, 0) / b[1].length;
      return avgB - avgA;
    })
    .slice(0, 2)
    .map(([k]) => k);

  const focusDim = dimensionWithMostUntriedSupers(tree, tried);
  const freshSupers = focusDim
    ? untriedSupersForDimension(focusDim, tried).map((s) => `${focusDim.label} → ${s.label}`)
    : [];

  const nearMissLine = nearMiss.length
    ? `Partial-signal supers (3★ — explore adjacent leaves): ${nearMiss.join(", ")}.\n`
    : "";

  const leafNearMiss = buildLeafNearMissSection(tree, history, tried);
  const compoundDrill = buildCompoundLeafDrillDown(tree, history);

  return `${treeBlock}

20Q EXPLORATION (${history.length} ratings): No strong loves yet. ${nearMissLine}${compoundDrill}${leafNearMiss}Rotate into less-sampled dimensions — prioritize: ${
    freshSupers.length ? freshSupers.join("; ") : "any fresh supers across all dimensions"
  }.
Each batch should span multiple dimensions when possible. Tag every item with category_paths from the tree.`;
}

function mergeTreeLeaves(existing: string[], added: string[]): string[] {
  const seen = new Set(existing.map((l) => l.toLowerCase()));
  const out = [...existing];
  for (const leaf of added) {
    const k = leaf.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/** Merge LLM-suggested branches into an existing tree (no hard-coded categories). */
export function mergeTreeAdditions(tree: CategoryTree, additions: CategoryDimension[]): CategoryTree {
  const dimById = new Map(tree.dimensions.map((d) => [d.id, { ...d, supers: [...d.supers] }]));

  for (const addDim of additions) {
    const existing = dimById.get(addDim.id);
    if (!existing) {
      dimById.set(addDim.id, addDim);
      continue;
    }
    const supById = new Map(existing.supers.map((s) => [s.id, { ...s, leaves: [...s.leaves] }]));
    for (const addSup of addDim.supers) {
      const exSup = supById.get(addSup.id);
      if (!exSup) {
        supById.set(addSup.id, addSup);
        continue;
      }
      exSup.leaves = mergeTreeLeaves(exSup.leaves, addSup.leaves);
      supById.set(addSup.id, exSup);
    }
    existing.supers = [...supById.values()];
    dimById.set(addDim.id, existing);
  }

  return { dimensions: [...dimById.values()] };
}

export async function augmentTreeForPreference(
  tree: CategoryTree,
  preference: string,
  llm: string,
): Promise<CategoryTree> {
  const systemPrompt = `You extend a cinema category tree so a specific taste preference has a clear home.

Add or extend dimensions/supers/leaves using lowercase snake_case ids. Do not remove existing content.
Prefer splitting compound tastes across dimensions (e.g. era + genre) when natural.

Reply ONLY with JSON:
{"dimensions":[{"id":"era","label":"Era","supers":[{"id":"1990s","label":"1990s","leaves":["90s teen comedy","90s action"]}]}]}`;

  const userMessage = `Existing tree:
${formatTreeForPrompt(tree)}

Preference that MUST be representable as at least one exact leaf: "${preference}"

Return only NEW or EXTENDED branches needed (merge-friendly). Include era and genre splits when the preference implies them.`;

  const text = await callLLM(llm, systemPrompt, userMessage, { maxTokens: 800 });
  const cleaned = stripMarkdownJsonFence(text);
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return tree;

  const parsed = normalizeCategoryTree(JSON.parse(match[0]));
  if (!parsed) return tree;
  return mergeTreeAdditions(tree, parsed.dimensions);
}

export async function generateCategoryTree(
  llm: string,
  opts?: { anchorPreference?: string; anchorPreferences?: string[] },
): Promise<CategoryTree> {
  const anchors = [
    ...(opts?.anchorPreference?.trim() ? [opts.anchorPreference.trim()] : []),
    ...(opts?.anchorPreferences ?? []).map((p) => p.trim()).filter(Boolean),
  ];

  const systemPrompt = `You design a cinema taxonomy for a 20-questions taste-discovery system.

The tree has 4 dimensions in this order (important for round-1 sampling):
1. era — decades/movements (e.g. 1990s, golden age, contemporary)
2. genre — genre families (e.g. comedy, drama, thriller, documentary)
3. region — cultural/national cinemas
4. tone — mood/spectacle (optional fourth)

Each dimension has 4–6 super-categories. Each super has 3–5 leaf subcategories (specific tags).
Niche combos (e.g. "90s teen comedy") must appear as a leaf under the right era AND/OR genre super.

Use lowercase snake_case for "id" fields. Labels are human-readable. Leaves are short phrases.

Reply ONLY with valid JSON — no markdown:
{"dimensions":[{"id":"era","label":"Era","supers":[{"id":"1990s","label":"1990s","leaves":["teen comedy","action blockbuster"]}]}]}`;

  const anchorNote =
    anchors.length > 0
      ? `\n\nEach of these taste profiles MUST be representable as at least one exact leaf somewhere in the tree (you choose where): ${anchors.map((a) => `"${a}"`).join(", ")}.`
      : "";

  const userMessage = `Generate a diverse cinema category tree for global film/TV taste discovery.
Put era first, then genre, then region. Cover many regions, genres, eras, and tones. At least 4 dimensions, 4+ supers each.${anchorNote}`;

  const text = await callLLM(llm, systemPrompt, userMessage, { maxTokens: 2500 });
  const cleaned = stripMarkdownJsonFence(text);
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("category tree: no JSON object in LLM response");

  const tree = normalizeCategoryTree(JSON.parse(match[0]));
  if (!tree) throw new Error("category tree: invalid structure from LLM");
  return tree;
}

function targetPathsCoverPreference(
  preference: string,
  paths: CategoryPath[],
): boolean {
  const tokens = preferenceTokens(preference);
  if (!tokens.length) return true;
  const hay = normalizeLeafToken(
    paths.flatMap((p) => [p.leaf ?? "", p.super, p.dimension]).join(" "),
  );
  const geoTerms = ["scandinavian", "bollywood", "japanese", "korean", "nordic", "french", "iranian"];
  for (const geo of geoTerms) {
    if (preference.toLowerCase().includes(geo) && !hay.includes(normalizeLeafToken(geo))) {
      return false;
    }
  }
  const matched = tokens.filter((t) => hay.includes(normalizeLeafToken(t)));
  return matched.length >= Math.min(2, tokens.length);
}

export async function resolveTreeForPreference(
  tree: CategoryTree,
  preference: string,
  llm: string,
): Promise<{ tree: CategoryTree; targetPaths: CategoryPath[] }> {
  let working = tree;
  let targetPaths = await mapPreferenceToTreePaths(working, preference, llm);
  if (
    !targetPaths.length ||
    !pathsMatchTreeLeaves(working, targetPaths) ||
    !targetPathsCoverPreference(preference, targetPaths)
  ) {
    working = await augmentTreeForPreference(working, preference, llm);
    targetPaths = await mapPreferenceToTreePaths(working, preference, llm);
  }
  return { tree: working, targetPaths };
}

function pathsMatchTreeLeaves(tree: CategoryTree, paths: CategoryPath[]): boolean {
  if (!paths.length) return false;
  for (const p of paths) {
    const dim = tree.dimensions.find((d) => d.id === p.dimension);
    const sup = dim?.supers.find((s) => s.id === p.super);
    if (!dim || !sup) return false;
    if (p.leaf && !sup.leaves.includes(p.leaf)) return false;
  }
  return true;
}

export async function mapPreferenceToTreePaths(
  tree: CategoryTree,
  preference: string,
  llm: string,
): Promise<CategoryPath[]> {
  const systemPrompt = `You map a viewer's taste preference to paths in a fixed category tree.
Pick 2–4 best-matching paths using ONLY dimension/super/leaf values that exist in the tree.
Cover every salient facet: era, genre, region (for cultural/geographic tastes like Scandinavian, Bollywood, Korean), and tone when relevant.
Every salient word in the preference must appear in at least one chosen leaf (e.g. "Dark Scandinavian Noir" needs region/scandinavian AND genre/noir leaves).
Prefer leaves that appear across multiple dimensions when the tree has them (e.g. "scandinavian noir" on both genre and tone).
Use the tree's id fields for dimension and super; use an exact leaf string from that super's leaves list.

Reply ONLY with JSON:
{"targetPaths":[{"dimension":"region","super":"europe","leaf":"scandinavian cinema"},{"dimension":"genre","super":"thriller_horror","leaf":"scandinavian noir"},{"dimension":"tone","super":"dark","leaf":"scandinavian noir"}]}`;

  const userMessage = `Category tree:
${formatTreeForPrompt(tree)}

Target preference: "${preference}"

Return targetPaths (1–3 entries) for where this preference lives in the tree.`;

  const text = await callLLM(llm, systemPrompt, userMessage, { maxTokens: 400 });
  const cleaned = stripMarkdownJsonFence(text);
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return [];

  const parsed = JSON.parse(match[0]) as { targetPaths?: unknown };
  if (!Array.isArray(parsed.targetPaths)) return [];

  return parsed.targetPaths.map(normalizePath).filter((p): p is CategoryPath => p !== null);
}

export function parseCategoryPathsFromRaw(raw: unknown): CategoryPath[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizePath).filter((p): p is CategoryPath => p !== null);
}

export function pathsToDisplayCategories(paths: CategoryPath[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    const label = p.leaf ?? `${p.super}`;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}
