"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ALL_CHANNEL, ACTIVE_CHANNEL_KEY, CHANNELS_KEY } from "../channels/page";
import {
  clearAllPrefetchQueueKeys,
  isPrefetchQueueStorageKey,
  listPrefetchQueueStorageKeys,
} from "../lib/storageKeys";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { mergeFactoryChannelsAndQueues } from "../lib/factoryChannels";
import { normalizeChannelList } from "../lib/channelBulkActions";

export const SETTINGS_KEY = "movie-recs-settings";

export const CHANNEL_EXPORT_KEYS = [CHANNELS_KEY, ACTIVE_CHANNEL_KEY] as const;

export type TrailerVisionExportV1 = {
  version: 1;
  exportedAt: string;
  options: { channels: boolean; queue: boolean; history: boolean };
  data: Record<string, unknown>;
};

export interface AppSettings {
  mediaType: "both" | "movie" | "tv";
  displayMode: "trailers" | "posters";
  llm: string;
  userRequest: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  mediaType: "both",
  displayMode: "trailers",
  llm: "deepseek",
  userRequest: "",
};

const LLM_OPTIONS: { value: string; label: string; sub: string }[] = [
  { value: "anthropic", label: "Claude", sub: "Anthropic" },
  { value: "openai", label: "GPT-4o", sub: "OpenAI" },
  { value: "deepseek", label: "DeepSeek", sub: "DeepSeek" },
  { value: "gemini", label: "Gemini", sub: "Google" },
];

const DATA_KEYS = [
  "movie-recs-history",
  "movie-recs-skipped",
  "movie-recs-passed",
  "movie-recs-notseen",
  "movie-recs-unseen-interest-log",
  "movie-recs-watchlist",
  "movie-recs-not-interested",
  "movie-recs-taste-summary",
  "movie-recs-llm-session-id",
  "movie-recs-llm-history-synced",
];

export const HISTORY_EXPORT_KEYS = [...DATA_KEYS] as const;

const IMPORT_BASE_KEYS = new Set<string>([...CHANNEL_EXPORT_KEYS, ...HISTORY_EXPORT_KEYS]);

function importKeyAllowed(k: string): boolean {
  return IMPORT_BASE_KEYS.has(k) || isPrefetchQueueStorageKey(k);
}

export function loadSettings(): AppSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const s = localStorage.getItem(SETTINGS_KEY);
    return s ? { ...DEFAULT_SETTINGS, ...JSON.parse(s) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function writeSettings(patch: Partial<AppSettings>) {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const existing = raw ? JSON.parse(raw) : DEFAULT_SETTINGS;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...existing, ...patch }));
  } catch {
    /* ignore */
  }
}

function pillClass(selected: boolean): string {
  return selected
    ? "bg-black text-white border-black"
    : "bg-white text-zinc-600 border-zinc-300 hover:border-zinc-500 hover:text-black";
}

export default function SettingsPage() {
  const router = useRouter();
  const importRef = useRef<HTMLInputElement>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [llmOptions, setLlmOptions] = useState(LLM_OPTIONS);
  const [mounted, setMounted] = useState(false);
  const [exportChannels, setExportChannels] = useState(true);
  const [exportQueue, setExportQueue] = useState(true);
  const [exportHistory, setExportHistory] = useState(true);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [importDialog, setImportDialog] = useState<{ count: number; apply: () => void } | null>(null);
  const [confirm, setConfirm] = useState<"remove-all" | "clear-history" | null>(null);
  const [factoryMergeNote, setFactoryMergeNote] = useState<string | null>(null);

  const refreshFromStorage = useCallback(() => {
    setSettings(loadSettings());
  }, []);

  useEffect(() => {
    refreshFromStorage();
    fetch("/api/config")
      .then((r) => r.json())
      .then((d: { llms?: { id: string; label: string }[] }) => {
        if (Array.isArray(d.llms) && d.llms.length > 0) {
          setLlmOptions(
            d.llms.map((l) => ({
              value: l.id,
              label: l.label,
              sub: LLM_OPTIONS.find((o) => o.value === l.id)?.sub ?? "",
            })),
          );
        }
      })
      .catch(() => {});
    setMounted(true);
    const onFocus = () => refreshFromStorage();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshFromStorage]);

  const patchSettings = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    writeSettings({ [key]: value });
  };

  const runExport = () => {
    const data: Record<string, unknown> = {};
    const keys: string[] = [];
    if (exportChannels) keys.push(...CHANNEL_EXPORT_KEYS);
    if (exportQueue) {
      for (const k of listPrefetchQueueStorageKeys()) {
        if (!keys.includes(k)) keys.push(k);
      }
    }
    if (exportHistory) keys.push(...HISTORY_EXPORT_KEYS);
    for (const k of keys) {
      const raw = localStorage.getItem(k);
      if (raw === null) continue;
      try {
        data[k] = JSON.parse(raw) as unknown;
      } catch {
        data[k] = raw;
      }
    }
    const payload: TrailerVisionExportV1 = {
      version: 1,
      exportedAt: new Date().toISOString(),
      options: { channels: exportChannels, queue: exportQueue, history: exportHistory },
      data,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trailer-vision-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClearHistory = () => {
    DATA_KEYS.forEach((k) => localStorage.removeItem(k));
    clearAllPrefetchQueueKeys();
    setConfirm(null);
    router.push("/");
  };

  const handleRemoveAll = () => {
    DATA_KEYS.forEach((k) => localStorage.removeItem(k));
    clearAllPrefetchQueueKeys();
    localStorage.setItem(CHANNELS_KEY, JSON.stringify(normalizeChannelList([ALL_CHANNEL])));
    localStorage.setItem(ACTIVE_CHANNEL_KEY, "all");
    setConfirm(null);
    router.push("/");
  };

  if (!mounted) {
    return <div className="min-h-screen bg-white text-black flex flex-col" />;
  }

  return (
    <>
      <div className="min-h-screen bg-white text-black flex flex-col">
        <div className="flex-1 p-6 max-w-[800px] mx-auto w-full flex flex-col gap-10">
          {/* AI Model */}
          <section className="flex flex-col gap-3">
            <div>
              <h2 className="text-sm font-semibold">AI Model</h2>
              <p className="text-xs text-zinc-500 mt-0.5">
                The LLM used to suggest titles across all channels.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {llmOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => patchSettings("llm", opt.value)}
                  className={`px-4 py-2 rounded-lg border text-sm transition-colors ${pillClass(settings.llm === opt.value)}`}
                >
                  {opt.label}
                  {opt.sub ? (
                    <span className="ml-1.5 text-xs opacity-60">{opt.sub}</span>
                  ) : null}
                </button>
              ))}
            </div>
          </section>

          {/* Global instructions */}
          <section className="flex flex-col gap-3">
            <div>
              <h2 className="text-sm font-semibold">Global Instructions</h2>
              <p className="text-xs text-zinc-500 mt-0.5">
                Extra guidance sent to the AI on every request, across all channels.
              </p>
            </div>
            <textarea
              value={settings.userRequest}
              onChange={(e) => patchSettings("userRequest", e.target.value)}
              placeholder='e.g. "Only suggest films I can watch with my kids" or "Prioritize films with strong female leads"'
              rows={4}
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-black placeholder-zinc-400 resize-y focus:outline-none focus:border-zinc-500"
            />
          </section>

          {/* Playback preferences (Trailer Vision only) */}
          <section className="flex flex-col gap-3">
            <div>
              <h2 className="text-sm font-semibold">Playback</h2>
              <p className="text-xs text-zinc-500 mt-0.5">What to show in the player.</p>
            </div>
            <div className="flex flex-col gap-3">
              <div>
                <p className="text-xs font-medium text-zinc-600 mb-2">Content type</p>
                <div className="flex flex-wrap gap-2">
                  {(["both", "movie", "tv"] as const).map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => patchSettings("mediaType", opt)}
                      className={`px-4 py-2 rounded-lg border text-sm transition-colors ${pillClass(settings.mediaType === opt)}`}
                    >
                      {opt === "both" ? "Movies & TV" : opt === "movie" ? "Movies" : "TV Series"}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>

          {/* Data backup */}
          <section className="flex flex-col gap-3">
            <div>
              <h2 className="text-sm font-semibold">Data backup</h2>
              <p className="text-xs text-zinc-500 mt-0.5">
                Download or restore your data from a JSON file. Import replaces matching keys in
                this browser.
              </p>
            </div>
            <div className="flex flex-col gap-2 text-sm text-zinc-700">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={exportChannels}
                  onChange={(e) => setExportChannels(e.target.checked)}
                  className="rounded border-zinc-300"
                />
                Channels + active channel
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={exportQueue}
                  onChange={(e) => setExportQueue(e.target.checked)}
                  className="rounded border-zinc-300"
                />
                Prefetch queues (upcoming titles per channel)
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={exportHistory}
                  onChange={(e) => setExportHistory(e.target.checked)}
                  className="rounded border-zinc-300"
                />
                History &amp; related (ratings, watchlist, taste profile, LLM session)
              </label>
            </div>
            <input
              ref={importRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              aria-hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                setImportNotice(null);
                const reader = new FileReader();
                reader.onload = () => {
                  try {
                    const parsed = JSON.parse(reader.result as string) as {
                      version?: number;
                      data?: Record<string, unknown>;
                    };
                    if (parsed.version !== 1 || !parsed.data || typeof parsed.data !== "object") {
                      setImportNotice("Invalid file — expected a Trailer Vision backup (version 1).");
                      return;
                    }
                    const entries = Object.entries(parsed.data).filter(([k]) => importKeyAllowed(k));
                    if (entries.length === 0) {
                      setImportNotice("No recognized keys in that file.");
                      return;
                    }
                    setImportDialog({
                      count: entries.length,
                      apply: () => {
                        for (const [k, v] of entries) {
                          if (v === null || v === undefined) {
                            localStorage.removeItem(k);
                            continue;
                          }
                          localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
                        }
                        setImportDialog(null);
                        router.push("/");
                      },
                    });
                  } catch {
                    setImportNotice("Could not read file.");
                  }
                };
                reader.readAsText(file);
              }}
            />
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={runExport}
                className="px-4 py-2 rounded-lg border border-zinc-300 text-zinc-700 text-sm hover:border-zinc-500 hover:text-black transition-colors"
              >
                Export backup
              </button>
              <button
                type="button"
                onClick={() => importRef.current?.click()}
                className="px-4 py-2 rounded-lg border border-zinc-300 text-zinc-700 text-sm hover:border-zinc-500 hover:text-black transition-colors"
              >
                Import backup
              </button>
            </div>
            {importNotice && <p className="text-xs text-red-600">{importNotice}</p>}
          </section>

          <hr className="border-zinc-200" />

          {/* Clear history */}
          <section className="flex flex-col gap-2">
            <div>
              <h2 className="text-sm font-semibold">Clear history &amp; taste profile</h2>
              <p className="text-xs text-zinc-500 mt-0.5">
                Clears all ratings, watchlist, skipped titles, and the AI taste profile. Channels are kept.
              </p>
            </div>
            <div>
              <button
                type="button"
                onClick={() => setConfirm("clear-history")}
                className="px-4 py-2 rounded-lg border border-red-200 text-red-600 text-sm hover:bg-red-50 transition-colors"
              >
                Clear history &amp; taste profile
              </button>
            </div>
          </section>

          {/* Remove all channels */}
          <section className="flex flex-col gap-2">
            <div>
              <h2 className="text-sm font-semibold">Remove all channels</h2>
              <p className="text-xs text-zinc-500 mt-0.5">
                <strong className="text-zinc-600 font-medium">Deletes</strong> every custom channel,
                all ratings, watchlist, and taste history. You are left with only the{" "}
                <strong className="text-zinc-600 font-medium">All</strong> channel. Nothing else is
                recreated until you add channels.
              </p>
            </div>
            <div>
              <button
                type="button"
                onClick={() => setConfirm("remove-all")}
                className="px-4 py-2 rounded-lg border border-red-200 text-red-600 text-sm hover:bg-red-50 transition-colors"
              >
                Remove all channels
              </button>
            </div>
          </section>

          {/* Factory channels */}
          <section className="flex flex-col gap-2">
            <div>
              <h2 className="text-sm font-semibold">Factory channels</h2>
              <p className="text-xs text-zinc-500 mt-0.5">
                <strong className="text-zinc-600 font-medium">Adds</strong> bundled example channels
                you don&apos;t already have (matched by id). Empty prefetch queues are filled from
                the bundle. Existing channels and queues are never removed or overwritten.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  const { addedChannels, filledPrefetchQueues } = mergeFactoryChannelsAndQueues();
                  const parts: string[] = [];
                  if (addedChannels > 0) {
                    parts.push(`Added ${addedChannels} channel${addedChannels === 1 ? "" : "s"}.`);
                  } else {
                    parts.push("No new channels to add (you already have this set).");
                  }
                  if (filledPrefetchQueues > 0) {
                    parts.push(
                      `Filled ${filledPrefetchQueues} empty prefetch queue${filledPrefetchQueues === 1 ? "" : "s"}.`,
                    );
                  }
                  setFactoryMergeNote(parts.join(" "));
                  setTimeout(() => setFactoryMergeNote(null), 8000);
                }}
                className="px-4 py-2 rounded-lg border border-zinc-300 text-zinc-700 text-sm hover:border-zinc-500 hover:text-black transition-colors"
              >
                Merge factory channels
              </button>
            </div>
            {factoryMergeNote && <p className="text-xs text-zinc-600">{factoryMergeNote}</p>}
          </section>

          <p className="text-xs text-zinc-400">Settings save automatically.</p>
        </div>
      </div>

      <ConfirmDialog
        open={importNotice !== null}
        title="Import"
        showCancel={false}
        confirmLabel="OK"
        onConfirm={() => setImportNotice(null)}
        onCancel={() => setImportNotice(null)}
      >
        {importNotice}
      </ConfirmDialog>

      <ConfirmDialog
        open={importDialog !== null}
        title="Import backup?"
        tone="danger"
        confirmLabel="Replace"
        cancelLabel="Cancel"
        onCancel={() => setImportDialog(null)}
        onConfirm={() => importDialog?.apply()}
      >
        Replace {importDialog?.count ?? 0} saved item(s) in this browser? Your current data for
        those keys will be overwritten.
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm === "clear-history"}
        title="Clear history & taste profile?"
        tone="danger"
        confirmLabel="Clear"
        cancelLabel="Cancel"
        onCancel={() => setConfirm(null)}
        onConfirm={handleClearHistory}
      >
        This clears all ratings, watchlist, skipped titles, and the AI taste profile. Your channels are kept. You cannot undo this.
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm === "remove-all"}
        title="Remove all channels?"
        tone="danger"
        confirmLabel="Delete all"
        cancelLabel="Cancel"
        onCancel={() => setConfirm(null)}
        onConfirm={handleRemoveAll}
      >
        This deletes all custom channels, ratings, watchlist, and taste history. You will keep only
        the <strong className="text-zinc-700">All</strong> channel. You cannot undo this.
      </ConfirmDialog>
    </>
  );
}
