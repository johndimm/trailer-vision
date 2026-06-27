export async function GET() {
  const llms: { id: string; label: string }[] = [];

  // Only DeepSeek is offered as a hosted model; users who want Claude, GPT-4o, or
  // anything else can Bring Your Own Model (any OpenAI-compatible endpoint) in Settings.
  if (process.env.DEEPSEEK_API_KEY)   llms.push({ id: "deepseek",   label: "DeepSeek" });

  return Response.json({ llms });
}
