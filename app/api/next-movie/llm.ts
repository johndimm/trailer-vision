export type CallLLMOptions = {
  maxTokens?: number;
  /** Semi-stable constraints (channel, media type) — second Claude cache breakpoint. */
  systemPromptContext?: string | null;
};

type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

type OpenAIUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
};

function logCacheUsage(llm: string, usage: unknown) {
  if (!usage || typeof usage !== "object") return;
  if (llm === "claude") {
    const u = usage as AnthropicUsage;
    console.log(
      `[llm] claude tokens in=${u.input_tokens ?? 0} out=${u.output_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0} cache_create=${u.cache_creation_input_tokens ?? 0}`,
    );
    return;
  }
  if (llm === "gpt-4o") {
    const u = usage as OpenAIUsage;
    const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
    if (cached > 0) {
      console.log(
        `[llm] openai tokens prompt=${u.prompt_tokens ?? 0} completion=${u.completion_tokens ?? 0} cached=${cached}`,
      );
    }
  }
}

function fullSystemPrompt(systemPrompt: string, systemPromptContext?: string | null): string {
  const ctx = systemPromptContext?.trim();
  return ctx ? `${systemPrompt}\n\n${ctx}` : systemPrompt;
}

export async function callLLM(
  llm: string,
  systemPrompt: string,
  userMessage: string,
  opts?: CallLLMOptions,
): Promise<string> {
  const maxTokens = opts?.maxTokens ?? 1024;
  const systemPromptContext = opts?.systemPromptContext;

  if (llm === "deepseek") {
    const deepseekMax = Math.min(maxTokens, 8192);
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        max_tokens: deepseekMax,
        messages: [
          { role: "system", content: fullSystemPrompt(systemPrompt, systemPromptContext) },
          { role: "user", content: userMessage },
        ],
      }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(`DeepSeek ${res.status}: ${JSON.stringify(e)}`);
    }
    const d = (await res.json()) as { choices: { message: { content: string } }[] };
    return d.choices?.[0]?.message?.content?.trim() ?? "";
  }

  if (llm === "claude") {
    const systemBlocks: { type: "text"; text: string; cache_control?: { type: "ephemeral" } }[] = [
      { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
    ];
    const ctx = systemPromptContext?.trim();
    if (ctx) {
      systemBlocks.push({ type: "text", text: ctx, cache_control: { type: "ephemeral" } });
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: maxTokens,
        system: systemBlocks,
        messages: [{ role: "user", content: userMessage }],
      }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(`Claude ${res.status}: ${JSON.stringify(e)}`);
    }
    const d = (await res.json()) as {
      content: { type: string; text: string }[];
      usage?: AnthropicUsage;
    };
    logCacheUsage("claude", d.usage);
    return d.content?.[0]?.text?.trim() ?? "";
  }

  if (llm === "gpt-4o") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: fullSystemPrompt(systemPrompt, systemPromptContext) },
          { role: "user", content: userMessage },
        ],
      }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(`OpenAI ${res.status}: ${JSON.stringify(e)}`);
    }
    const d = (await res.json()) as {
      choices: { message: { content: string } }[];
      usage?: OpenAIUsage;
    };
    logCacheUsage("gpt-4o", d.usage);
    return d.choices?.[0]?.message?.content?.trim() ?? "";
  }

  if (llm === "gemini") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: fullSystemPrompt(systemPrompt, systemPromptContext) }] },
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(`Gemini ${res.status}: ${JSON.stringify(e)}`);
    }
    const d = (await res.json()) as { candidates: { content: { parts: { text: string }[] } }[] };
    return d.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
  }

  throw new Error(`Unknown LLM: ${llm}`);
}
