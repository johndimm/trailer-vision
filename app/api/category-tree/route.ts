import {
  generateCategoryTree,
  normalizeCategoryTree,
  resolveTreeForPreference,
  type CategoryPath,
  type CategoryTree,
} from "../../lib/categoryTree";

export async function POST(request: Request) {
  const raw = (await request.json()) as {
    llm?: string;
    preference?: string;
    /** Reuse a client-held tree instead of regenerating */
    tree?: unknown;
    /** Hints for batch tree generation (taste-test-all) */
    anchorPreferences?: string[];
  };

  const llm = raw.llm ?? "deepseek";
  const preference = raw.preference?.trim();

  try {
    let tree: CategoryTree;
    if (raw.tree) {
      const normalized = normalizeCategoryTree(raw.tree);
      if (!normalized) {
        return Response.json({ error: "invalid tree payload" }, { status: 400 });
      }
      tree = normalized;
    } else if (preference) {
      tree = await generateCategoryTree(llm, { anchorPreference: preference });
    } else if (raw.anchorPreferences?.length) {
      tree = await generateCategoryTree(llm, { anchorPreferences: raw.anchorPreferences });
    } else {
      tree = await generateCategoryTree(llm);
    }

    let targetPaths: CategoryPath[] | undefined;
    if (preference) {
      const resolved = await resolveTreeForPreference(tree, preference, llm);
      tree = resolved.tree;
      targetPaths = resolved.targetPaths;
    }

    return Response.json({ tree, targetPaths });
  } catch (err) {
    console.error("[category-tree]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "category tree failed" },
      { status: 500 },
    );
  }
}
