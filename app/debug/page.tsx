"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

const DEBUG_KEY = "__debug_full_prompt";

interface DebugPrompt {
  systemPrompt: string | null;
  systemPromptContext: string | null;
  userMessage: string | null;
}

const SECTIONS: { key: keyof DebugPrompt; label: string; color: string }[] = [
  { key: "systemPrompt",        label: "System Prompt",         color: "text-sky-400 border-sky-700 bg-sky-950/40" },
  { key: "systemPromptContext", label: "System Prompt Context", color: "text-violet-400 border-violet-700 bg-violet-950/40" },
  { key: "userMessage",         label: "User Message",          color: "text-amber-400 border-amber-700 bg-amber-950/40" },
];

function Section({ label, color, text }: { label: string; color: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <div className="flex flex-col gap-2">
      <div className={`flex items-center justify-between rounded-t-lg border-b px-4 py-2 ${color}`}>
        <span className="text-sm font-bold uppercase tracking-widest">{label}</span>
        <button
          type="button"
          onClick={copy}
          className="rounded px-2 py-0.5 text-xs font-medium opacity-70 hover:opacity-100 transition-opacity"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <pre className="rounded-b-lg border border-t-0 border-zinc-800 bg-zinc-900 px-4 py-3 text-xs font-mono leading-relaxed text-zinc-200 whitespace-pre-wrap break-words overflow-auto">
        {text}
      </pre>
    </div>
  );
}

export default function DebugPage() {
  const [data, setData] = useState<DebugPrompt | null>(null);
  const [mounted, setMounted] = useState(false);

  const [isLegacy, setIsLegacy] = useState(false);

  const load = () => {
    const raw = localStorage.getItem(DEBUG_KEY);
    if (!raw) { setData(null); setIsLegacy(false); return; }
    try {
      const parsed = JSON.parse(raw) as DebugPrompt;
      if (parsed && typeof parsed === "object" && ("systemPrompt" in parsed || "userMessage" in parsed)) {
        setData(parsed);
        setIsLegacy(false);
      } else {
        // Parsed as something unexpected — treat as legacy
        setData({ systemPrompt: null, systemPromptContext: null, userMessage: raw });
        setIsLegacy(true);
      }
    } catch {
      // Old flat-string format
      setData({ systemPrompt: null, systemPromptContext: null, userMessage: raw });
      setIsLegacy(true);
    }
  };

  useEffect(() => {
    setMounted(true);
    load();
  }, []);

  const copyAll = () => {
    if (!data) return;
    const text = SECTIONS
      .map(s => data[s.key] ? `=== ${s.label.toUpperCase()} ===\n${data[s.key]}` : null)
      .filter(Boolean)
      .join("\n\n");
    navigator.clipboard.writeText(text);
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 px-4 py-6 sm:px-8">
      <div className="mx-auto max-w-5xl flex flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-zinc-100">LLM Prompt Debug</h1>
            <p className="mt-1 text-sm text-zinc-400">
              Full prompt sent on the last /api/next-movie call. Go to the player, let a card load, then come back here.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={load}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-200 hover:bg-zinc-700 transition-colors"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={copyAll}
              disabled={!data}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-200 hover:bg-zinc-700 transition-colors disabled:opacity-40"
            >
              Copy all
            </button>
            <Link
              href="/"
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Back to player
            </Link>
          </div>
        </div>

        {isLegacy && (
          <div className="rounded-lg border border-amber-700/50 bg-amber-950/40 px-4 py-3 text-sm text-amber-300">
            Stale data in old format — go to the player, let a card load, then click Refresh.
          </div>
        )}
        {!mounted ? null : !data ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-8 text-center text-zinc-500">
            No prompt captured yet. Go to the player, wait for a movie to load, then come back here.
          </div>
        ) : (
          SECTIONS.map(s =>
            data[s.key] ? (
              <Section key={s.key} label={s.label} color={s.color} text={data[s.key]!} />
            ) : null
          )
        )}
      </div>
    </div>
  );
}
