"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { applyFactoryBootstrap, hasNoChannelsPersisted } from "../lib/factoryChannels";
import { NEW_CHANNEL_PREFILL_KEY } from "../lib/channelFromPrompt";
import { ConfirmDialog } from "../components/ConfirmDialog";
import ChannelEditorForm from "../components/ChannelEditorForm";
import type { ChannelEditorValues } from "../components/ChannelEditorForm";
import {
  countCustomChannels,
  createAllChannel,
  deleteChannelsByIds,
  hydrateChannelsOnLoad,
  insertChannelAfterAll,
  normalizeChannelList,
} from "../lib/channelBulkActions";
import { clearChannelPersistedData, clearChannelsPersistedData } from "../lib/storageKeys";
import {
  TRAILER_CHANNEL_EDITOR_CONFIG,
  channelToEditorValues,
  editorValuesToChannel,
  emptyTrailerEditorValues,
  prefillToEditorValues,
} from "../lib/channelEditorConfig";
import type { ChannelMedium, MovieChannel as Channel } from "../lib/movieChannel";

export type { ChannelMedium, Channel };

const VALID_MEDIUMS = new Set<ChannelMedium>(["movie", "tv"]);

/** Ensure persisted channels (pre–mediums field) get a valid `mediums` array; drop legacy `region`. */
export function normalizeChannel(c: Channel & { region?: string }): Channel {
  const { region: _r, ...rest } = c;
  const raw = (c as { mediums?: unknown }).mediums;
  const mediums = Array.isArray(raw)
    ? raw.filter((x): x is ChannelMedium => typeof x === "string" && VALID_MEDIUMS.has(x as ChannelMedium))
    : [];
  return { ...rest, mediums };
}

export const CHANNELS_KEY = "movie-recs-channels";
export const ACTIVE_CHANNEL_KEY = "movie-recs-active-channel";

export const ALL_CHANNEL: Channel = createAllChannel();

// ── Main page ──────────────────────────────────────────────────────────────────

export default function ChannelsPage() {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  /** Initial values for the “new channel” form (from home prefill or blank). */
  const [newChannelFormInitial, setNewChannelFormInitial] = useState<ChannelEditorValues>(
    emptyTrailerEditorValues()
  );
  const [newChannelFormKey, setNewChannelFormKey] = useState(0);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      try {
        if (hasNoChannelsPersisted()) {
          applyFactoryBootstrap();
        }
        const s = localStorage.getItem(CHANNELS_KEY);
        let chs: Channel[] = s ? (JSON.parse(s) as Channel[]).map(normalizeChannel) : [];
        chs = hydrateChannelsOnLoad(chs, ALL_CHANNEL, normalizeChannel);
        localStorage.setItem(CHANNELS_KEY, JSON.stringify(chs));
        setChannels(chs);
        const activeId = localStorage.getItem(ACTIVE_CHANNEL_KEY);
        const initialId = activeId && chs.find((c) => c.id === activeId) ? activeId : chs[0].id;
        setSelectedId(initialId);
      } catch {}
    });
  }, []);

  /** Open "new channel" when linked from the main page (`/channels?new=1`).
   *  Pre-select a channel when linked with `?select=<id>`. */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const newParam = params.get("new");
    const selectParam = params.get("select");
    window.history.replaceState({}, "", "/channels");
    if (newParam === "1" || newParam === "true") {
      queueMicrotask(() => {
        let next = emptyTrailerEditorValues();
        try {
          const raw = sessionStorage.getItem(NEW_CHANNEL_PREFILL_KEY);
          if (raw) {
            next = prefillToEditorValues(JSON.parse(raw) as unknown);
            sessionStorage.removeItem(NEW_CHANNEL_PREFILL_KEY);
          }
        } catch {
          /* ignore */
        }
        setNewChannelFormInitial(next);
        setNewChannelFormKey((k) => k + 1);
        setShowNew(true);
      });
    } else if (selectParam) {
      queueMicrotask(() => {
        setSelectedId(selectParam);
        setShowNew(false);
      });
    }
  }, []);

  const saveChannels = (chs: Channel[]) => {
    const normalized = normalizeChannelList(chs).map(normalizeChannel);
    localStorage.setItem(CHANNELS_KEY, JSON.stringify(normalized));
    setChannels(normalized);
  };

  const createChannel = (values: ChannelEditorValues) => {
    const ch = editorValuesToChannel(crypto.randomUUID(), values);
    const next = insertChannelAfterAll(channels, ch);
    saveChannels(next);
    localStorage.setItem(ACTIVE_CHANNEL_KEY, ch.id);
    setNewChannelFormInitial(emptyTrailerEditorValues());
    router.push("/");
  };

  const updateChannel = (id: string, values: ChannelEditorValues) => {
    saveChannels(channels.map((c) => (c.id === id ? editorValuesToChannel(id, values) : c)));
    localStorage.setItem(ACTIVE_CHANNEL_KEY, id);
    router.push("/");
  };

  const confirmDeleteChannel = () => {
    const id = pendingDeleteId;
    if (!id) return;
    const active = localStorage.getItem(ACTIVE_CHANNEL_KEY);
    if (active === id) localStorage.removeItem(ACTIVE_CHANNEL_KEY);
    clearChannelPersistedData(id);
    const next = channels.filter((c) => c.id !== id);
    saveChannels(next);
    setSelectedId(next.length > 0 ? next[0].id : null);
    setPendingDeleteId(null);
  };

  const deleteSelected = () => {
    const ids = [...checkedIds];
    clearChannelsPersistedData(ids);
    const active = localStorage.getItem(ACTIVE_CHANNEL_KEY);
    if (active && checkedIds.has(active)) localStorage.removeItem(ACTIVE_CHANNEL_KEY);
    const next = deleteChannelsByIds(channels, ids);
    saveChannels(next);
    setCheckedIds(new Set());
    if (selectedId && checkedIds.has(selectedId)) {
      setSelectedId(next[0]?.id ?? null);
    }
    setBulkDeleteConfirm(false);
  };

  const toggleChecked = (id: string, on: boolean) => {
    if (id === "all") return;
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const selectAllCustom = () => {
    setCheckedIds(new Set(channels.filter((c) => c.id !== "all").map((c) => c.id)));
  };

  const clearSelection = () => setCheckedIds(new Set());

  /** Sidebar / picker: switch channel + keep app active channel in sync with the player. */
  const selectChannel = (id: string) => {
    setSelectedId(id);
    setShowNew(false);
    try {
      localStorage.setItem(ACTIVE_CHANNEL_KEY, id);
    } catch {
      /* ignore */
    }
  };

  const selected = channels.find((c) => c.id === selectedId) ?? null;
  const pendingDeleteChannel = pendingDeleteId ? channels.find((c) => c.id === pendingDeleteId) : null;
  const customCount = countCustomChannels(channels);
  const hasCustomChannels = customCount > 0;
  const selectedDeleteCount = checkedIds.size;
  const deletableIds = channels.filter((c) => c.id !== "all").map((c) => c.id);
  const allCustomSelected =
    deletableIds.length > 0 && deletableIds.every((id) => checkedIds.has(id));

  const reloadChannelsFromStorage = useCallback(() => {
    try {
      const s = localStorage.getItem(CHANNELS_KEY);
      let chs: Channel[] = s ? (JSON.parse(s) as Channel[]).map(normalizeChannel) : [];
      chs = hydrateChannelsOnLoad(chs, ALL_CHANNEL, normalizeChannel);
      localStorage.setItem(CHANNELS_KEY, JSON.stringify(chs));
      setChannels(chs);
      const activeId = localStorage.getItem(ACTIVE_CHANNEL_KEY);
      const initialId = activeId && chs.find((c) => c.id === activeId) ? activeId : chs[0]?.id ?? null;
      setSelectedId(initialId);
    } catch {
      /* ignore */
    }
  }, []);

  const loadStarterChannels = useCallback(() => {
    applyFactoryBootstrap();
    setShowNew(false);
    reloadChannelsFromStorage();
  }, [reloadChannelsFromStorage]);

  const openNewChannelForm = useCallback(() => {
    setNewChannelFormInitial(emptyTrailerEditorValues());
    setNewChannelFormKey((k) => k + 1);
    setShowNew(true);
  }, []);

  const channelListRow = (ch: Channel) => {
    const isActive = selectedId === ch.id && !showNew;
    const canCheck = ch.id !== "all";
    const isChecked = checkedIds.has(ch.id);
    return (
      <div
        key={ch.id}
        className={`flex items-center gap-2 ${
          isActive ? "bg-zinc-100" : "hover:bg-zinc-50"
        } rounded-lg transition-colors`}
      >
        {canCheck ? (
          <input
            type="checkbox"
            checked={isChecked}
            onChange={(e) => toggleChecked(ch.id, e.target.checked)}
            className="ml-2 h-4 w-4 shrink-0 rounded border-zinc-300 text-indigo-600 focus:ring-indigo-500"
            aria-label={`Select ${ch.name} for deletion`}
          />
        ) : (
          <span className="ml-2 w-4 shrink-0" aria-hidden />
        )}
        <button
          type="button"
          onClick={() => selectChannel(ch.id)}
          className={`min-w-0 flex-1 text-left py-2.5 pr-3 text-sm font-medium transition-colors ${
            isActive ? "text-zinc-900" : "text-zinc-600 hover:text-zinc-900"
          }`}
        >
          <span className="block truncate">{ch.name}</span>
        </button>
      </div>
    );
  };

  const bulkActionsBar = (className = "") => (
    <div className={`flex flex-col gap-2 ${className}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <button
          type="button"
          onClick={selectAllCustom}
          disabled={deletableIds.length === 0 || allCustomSelected}
          className="text-zinc-500 hover:text-zinc-800 disabled:opacity-40 disabled:hover:text-zinc-500"
        >
          Select all
        </button>
        <button
          type="button"
          onClick={clearSelection}
          disabled={selectedDeleteCount === 0}
          className="text-zinc-500 hover:text-zinc-800 disabled:opacity-40 disabled:hover:text-zinc-500"
        >
          Clear
        </button>
      </div>
      <button
        type="button"
        onClick={() => selectedDeleteCount > 0 && setBulkDeleteConfirm(true)}
        disabled={selectedDeleteCount === 0}
        className="w-full text-left text-xs text-red-600 hover:text-red-700 disabled:opacity-40 disabled:hover:text-red-600 transition-colors"
      >
        Delete selected{selectedDeleteCount > 0 ? ` (${selectedDeleteCount})` : ""}…
      </button>
    </div>
  );

  return (
    <>
    <ConfirmDialog
      open={bulkDeleteConfirm}
      title="Delete selected channels?"
      tone="danger"
      confirmLabel={`Delete ${selectedDeleteCount}`}
      cancelLabel="Cancel"
      onCancel={() => setBulkDeleteConfirm(false)}
      onConfirm={deleteSelected}
    >
      <>
        Removes {selectedDeleteCount} channel{selectedDeleteCount !== 1 ? "s" : ""} and their prefetch
        queues. The <span className="font-medium text-zinc-800">All</span> channel cannot be deleted.
        <ul className="mt-3 max-h-40 overflow-y-auto space-y-1 text-sm text-zinc-600">
          {channels
            .filter((c) => checkedIds.has(c.id))
            .map((c) => (
              <li key={c.id} className="truncate">
                {c.name}
              </li>
            ))}
        </ul>
      </>
    </ConfirmDialog>
    <ConfirmDialog
      open={pendingDeleteId !== null}
      title="Delete channel"
      tone="danger"
      confirmLabel="Delete"
      cancelLabel="Cancel"
      onCancel={() => setPendingDeleteId(null)}
      onConfirm={confirmDeleteChannel}
    >
      {pendingDeleteChannel ? (
        <>
          Delete <span className="font-medium text-zinc-800">&quot;{pendingDeleteChannel.name}&quot;</span>? This
          cannot be undone.
        </>
      ) : (
        "Delete this channel? This cannot be undone."
      )}
    </ConfirmDialog>
    <div className="min-h-screen bg-zinc-50">
      {/* ── Empty state: no custom channels yet ── */}
      {mounted && !hasCustomChannels && !showNew && (
        <div className="mx-auto flex min-h-[calc(100dvh-2.75rem)] max-w-2xl flex-col justify-center px-4 py-12 sm:px-6">
          <div className="mb-8 text-center">
            <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-800 transition-colors">
              ← Player
            </Link>
            <h1 className="mt-4 text-2xl font-bold tracking-tight text-zinc-900 sm:text-3xl">Channels</h1>
            <p className="mt-2 text-sm leading-relaxed text-zinc-500">
              Channels are taste filters — genres, eras, directors — each with its own queue and history.
              Start from scratch or load bundled examples.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <button
              type="button"
              onClick={openNewChannelForm}
              className="group flex flex-col rounded-2xl border border-zinc-200 bg-white p-6 text-left shadow-sm transition-all hover:border-indigo-300 hover:shadow-md"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600 text-xl font-light text-white transition-colors group-hover:bg-indigo-500">
                +
              </span>
              <span className="mt-4 text-base font-semibold text-zinc-900">Create a channel</span>
              <span className="mt-1.5 text-sm leading-relaxed text-zinc-500">
                Define genres, time periods, and a free-text prompt for the AI.
              </span>
            </button>

            <button
              type="button"
              onClick={loadStarterChannels}
              className="group flex flex-col rounded-2xl border border-zinc-200 bg-white p-6 text-left shadow-sm transition-all hover:border-zinc-300 hover:shadow-md"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 text-lg text-zinc-600 transition-colors group-hover:border-zinc-300 group-hover:bg-zinc-100">
                ✦
              </span>
              <span className="mt-4 text-base font-semibold text-zinc-900">Load starter channels</span>
              <span className="mt-1.5 text-sm leading-relaxed text-zinc-500">
                Bundled examples (sci-fi, classics, etc.) you can edit or delete anytime.
              </span>
            </button>
          </div>
        </div>
      )}

      {/* ── New channel form (empty state) ── */}
      {mounted && !hasCustomChannels && showNew && (
        <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6 sm:py-10">
          <div className="mb-6 flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                setNewChannelFormInitial(emptyTrailerEditorValues());
                setShowNew(false);
              }}
              className="text-sm font-medium text-indigo-600 hover:text-indigo-800 transition-colors"
            >
              ← Back
            </button>
            <h1 className="text-lg font-bold text-zinc-900">New channel</h1>
          </div>
          <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm sm:p-6">
            <ChannelEditorForm
              key={`new-channel-${newChannelFormKey}`}
              initial={newChannelFormInitial}
              config={TRAILER_CHANNEL_EDITOR_CONFIG}
              onSave={createChannel}
              onCancel={() => {
                setNewChannelFormInitial(emptyTrailerEditorValues());
                setShowNew(false);
              }}
            />
          </div>
        </div>
      )}

      {/* ── Channel list + editor (has custom channels) ── */}
      {hasCustomChannels && (
      <div className="max-w-4xl mx-auto flex h-[calc(100dvh-2.75rem)] sm:h-[calc(100vh-2.75rem)] flex-col sm:flex-row min-h-0">

        {/* Mobile: compact channel picker — full-width select + new (sidebar hidden on small screens) */}
        <div className="shrink-0 border-b border-zinc-200 bg-white sm:hidden">
          {showNew ? (
            <div className="flex items-center gap-3 px-3 py-2.5">
              <button
                type="button"
                onClick={() => {
                  setNewChannelFormInitial(emptyTrailerEditorValues());
                  setShowNew(false);
                }}
                className="text-sm font-medium text-indigo-600 hover:text-indigo-800"
              >
                ← Back
              </button>
              <span className="text-sm font-semibold text-zinc-800">New channel</span>
            </div>
          ) : (
            <div className="space-y-2 px-3 py-2.5">
              <div className="max-h-40 overflow-y-auto">{channels.map((ch) => channelListRow(ch))}</div>
              {customCount > 0 && bulkActionsBar("pt-2 border-t border-zinc-100")}
              <div className="flex items-center gap-2 pt-1">
              <label htmlFor="channel-select-mobile" className="sr-only">
                Channel
              </label>
              <select
                id="channel-select-mobile"
                className="min-w-0 flex-1 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm font-medium text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 disabled:opacity-50"
                value={selectedId ?? ""}
                disabled={channels.length === 0}
                onChange={(e) => {
                  selectChannel(e.target.value);
                }}
              >
                {channels.length === 0 ? (
                  <option value="">No channels</option>
                ) : (
                  channels.map((ch) => (
                    <option key={ch.id} value={ch.id}>
                      {ch.name}
                    </option>
                  ))
                )}
              </select>
              <button
                type="button"
                onClick={openNewChannelForm}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dashed border-zinc-300 bg-white text-lg font-light leading-none text-zinc-500 transition-colors hover:border-indigo-400 hover:bg-indigo-50 hover:text-indigo-600"
                title="New channel"
                aria-label="New channel"
              >
                +
              </button>
              </div>
            </div>
          )}
        </div>

        {/* ── Left sidebar: channel list (tablet/desktop only) ── */}
        <div className="hidden w-44 shrink-0 flex-col border-r border-zinc-200 bg-white sm:flex">
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100">
            <span className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Channels</span>
            <button
              onClick={openNewChannelForm}
              className="text-zinc-400 hover:text-indigo-600 transition-colors text-lg leading-none"
              title="New channel"
            >+</button>
          </div>
          <div className="flex-1 overflow-y-auto py-1 min-h-0 px-1">
            {channels.map((ch) => channelListRow(ch))}
            {channels.length === 0 && (
              <p className="px-4 py-3 text-xs text-zinc-400">No channels yet.</p>
            )}
          </div>
          {customCount > 0 && (
            <div className="border-t border-zinc-100 p-3">{bulkActionsBar()}</div>
          )}
        </div>

        {/* ── Main panel ── */}
        <div className="min-h-0 flex-1 overflow-y-auto">

          {showNew && (
            <div className="p-4 sm:p-6">
              <p className="text-sm font-semibold text-zinc-700 mb-0">New channel</p>
              <ChannelEditorForm
                key={`new-channel-${newChannelFormKey}`}
                initial={newChannelFormInitial}
                config={TRAILER_CHANNEL_EDITOR_CONFIG}
                onSave={createChannel}
                onCancel={() => {
                  setNewChannelFormInitial(emptyTrailerEditorValues());
                  setShowNew(false);
                }}
              />
            </div>
          )}

          {!showNew && selected && (
            <div className="p-4 sm:p-6 space-y-6">
              {selected.id !== "all" && (
                <div>
                  <div className="flex justify-end mb-2">
                    <button
                      onClick={() => setPendingDeleteId(selected.id)}
                      className="text-xs text-zinc-400 hover:text-red-500 transition-colors"
                    >
                      Delete channel
                    </button>
                  </div>
                  <ChannelEditorForm
                    key={selected.id}
                    initial={channelToEditorValues(selected)}
                    config={TRAILER_CHANNEL_EDITOR_CONFIG}
                    onSave={(values) => updateChannel(selected.id, values)}
                  />
                </div>
              )}
            </div>
          )}

          {!showNew && !selected && (
            <div className="p-10 text-center text-zinc-400 text-sm">
              Select a channel to edit.
            </div>
          )}

        </div>
      </div>
      )}
    </div>
    </>
  );
}
