/**
 * "Bring your own model" support. The user's custom endpoint config travels through the
 * whole LLM pipeline encoded inside the `llm` string (which every API route already forwards
 * to callLLM), so no route needs a new parameter. The config targets any OpenAI-compatible
 * /chat/completions endpoint (OpenRouter, Together, Groq, a local Ollama / LM Studio server…).
 */
export type CustomModelConfig = {
  baseUrl: string;
  model: string;
  apiKey: string;
};

const PREFIX = "custom:";

export function isCustomLlm(llm: string | null | undefined): boolean {
  return typeof llm === "string" && llm.startsWith(PREFIX);
}

function toBase64(s: string): string {
  return typeof btoa === "function" ? btoa(s) : Buffer.from(s, "utf8").toString("base64");
}

function fromBase64(s: string): string {
  return typeof atob === "function" ? atob(s) : Buffer.from(s, "base64").toString("utf8");
}

/** Encode config into an `llm` string. Payload is ASCII (URLs, model ids, keys), so base64 is safe. */
export function encodeCustomLlm(cfg: CustomModelConfig): string {
  const json = JSON.stringify({
    baseUrl: cfg.baseUrl.trim(),
    model: cfg.model.trim(),
    apiKey: cfg.apiKey.trim(),
  });
  return PREFIX + toBase64(json);
}

/** Decode an `llm` string; returns null unless it's a complete custom config (base URL + model). */
export function decodeCustomLlm(llm: string | null | undefined): CustomModelConfig | null {
  if (!isCustomLlm(llm)) return null;
  try {
    const json = fromBase64((llm as string).slice(PREFIX.length));
    const o = JSON.parse(json) as Partial<CustomModelConfig>;
    if (!o.baseUrl?.trim() || !o.model?.trim()) return null;
    return { baseUrl: o.baseUrl.trim(), model: o.model.trim(), apiKey: o.apiKey?.trim() ?? "" };
  } catch {
    return null;
  }
}
