/**
 * Run dual-mode taste discovery tests for a batch of preferences.
 * Each profile: All channel (discovery) then Channel hint (answer given).
 *
 * Usage:
 *   npx tsx scripts/taste-test-all.ts [base-url] [max-rounds] [count]
 */

import { runTasteTestDual } from "./taste-test";

const BASE_URL = process.argv[2] ?? "http://localhost:3000";
const MAX_ROUNDS = Number(process.argv[3] ?? 20);
const COUNT = Number(process.argv[4] ?? 7);
const LLM = "deepseek";

async function fetchTestCategories(): Promise<string[]> {
  const res = await fetch(`${BASE_URL}/api/taste-test-categories`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ count: COUNT, llm: LLM }),
  });
  if (!res.ok) {
    throw new Error(`taste-test-categories HTTP ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { categories?: string[] };
  const categories = data.categories ?? [];
  if (!categories.length) {
    throw new Error("taste-test-categories returned empty list");
  }
  return categories;
}

async function main() {
  console.log(`Trailer taste tests — server: ${BASE_URL}, max ${MAX_ROUNDS} rounds/phase`);
  console.log(`Fetching ${COUNT} test profiles from LLM…\n`);

  const categories = await fetchTestCategories();
  console.log("Profiles:");
  for (const c of categories) console.log(`  · ${c}`);
  console.log("");

  type Summary = {
    preference: string;
    allConverged: boolean;
    allRound: number | null;
    allRatings: number;
    channelConverged: boolean;
    channelRound: number | null;
    channelRatings: number;
  };

  const summaries: Summary[] = [];

  for (let i = 0; i < categories.length; i++) {
    const preference = categories[i]!;
    console.log(`\n${"#".repeat(72)}`);
    console.log(`Test ${i + 1}/${categories.length}: "${preference}"`);
    console.log("#".repeat(72));

    const result = await runTasteTestDual({
      preference,
      baseUrl: BASE_URL,
      maxRounds: MAX_ROUNDS,
      llm: LLM,
    });
    summaries.push({
      preference,
      allConverged: result.all.converged,
      allRound: result.all.convergeRound,
      allRatings: result.all.totalRated,
      channelConverged: result.channel.converged,
      channelRound: result.channel.convergeRound,
      channelRatings: result.channel.totalRated,
    });
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log("SUMMARY — convergence time (round / ratings)");
  console.log("=".repeat(72));
  console.log("Preference".padEnd(36) + "All channel".padEnd(22) + "Channel hint");
  console.log("-".repeat(72));

  let allOk = 0;
  let chOk = 0;
  let allRounds = 0;
  let chRounds = 0;
  let allCount = 0;
  let chCount = 0;

  for (const s of summaries) {
    const allStr = s.allConverged
      ? `✓ r${s.allRound} (${s.allRatings}★)`
      : `✗ — (${s.allRatings}★)`;
    const chStr = s.channelConverged
      ? `✓ r${s.channelRound} (${s.channelRatings}★)`
      : `✗ — (${s.channelRatings}★)`;
    console.log(s.preference.slice(0, 35).padEnd(36) + allStr.padEnd(22) + chStr);
    if (s.allConverged) {
      allOk++;
      if (s.allRound != null) {
        allRounds += s.allRound;
        allCount++;
      }
    }
    if (s.channelConverged) {
      chOk++;
      if (s.channelRound != null) {
        chRounds += s.channelRound;
        chCount++;
      }
    }
  }

  console.log("-".repeat(72));
  console.log(
    `All channel:  ${allOk}/${summaries.length} converged` +
      (allCount ? `, avg round ${(allRounds / allCount).toFixed(1)}` : ""),
  );
  console.log(
    `Channel hint: ${chOk}/${summaries.length} converged` +
      (chCount ? `, avg round ${(chRounds / chCount).toFixed(1)}` : ""),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
