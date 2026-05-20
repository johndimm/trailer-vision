'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

export type ChannelEditorValues = {
  name: string
  /** Primary “what you want” text (Soundings: notes, Trailer: freeText). */
  freeText: string
  genres: string[]
  timePeriods: string[]
  regions: string[]
  language: string
  mediums: string[]
  artists: string[]
  popularity: number
}

export type ChannelEditorConfig = {
  freeTextTitle: string
  freeTextHelp: string
  nameLabel: string
  nameHelp: string
  namePlaceholder: string
  freeTextPlaceholder: string
  refineHelp: string
  artistsLabel: string
  artistsEmptyHint: string
  artistsNeedInputHint: string
  genreOptions: string[]
  timePeriodOptions: string[]
  showRegions?: boolean
  regionOptions?: string[]
  showLanguage?: boolean
  languageOptions?: string[]
  showMediums?: boolean
  mediumOptions?: { id: string; label: string; hint: string }[]
  readLlm: () => string
  buildSuggestBody: (form: ChannelEditorValues, llm: string) => Record<string, unknown>
  getStaticArtistOptions?: (form: ChannelEditorValues) => string[]
}

const ARTIST_SUGGEST_DEBOUNCE_MS = 600
const ARTIST_SUGGEST_CACHE_KEY = 'channel-editor-artist-suggestions-v1'
const artistSuggestMemCache = new Map<string, string[]>()

function csvToArray(csv: string): string[] {
  return csv
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

function toggleCsv(csv: string, val: string): string {
  const items = csvToArray(csv)
  return items.includes(val)
    ? items.filter(x => x !== val).join(', ')
    : [...items, val].join(', ')
}

export function popularityLabel(n: number): string {
  if (n <= 15) return 'Hidden gems only'
  if (n <= 35) return 'Mostly obscure'
  if (n <= 45) return 'Lean obscure'
  if (n <= 55) return 'Balanced'
  if (n <= 65) return 'Lean mainstream'
  if (n <= 85) return 'Mostly mainstream'
  return 'Mainstream only'
}

function stableArtistSuggestKey(form: ChannelEditorValues, llm: string): string {
  return JSON.stringify({
    n: form.name.trim(),
    g: [...form.genres].sort(),
    t: [...form.timePeriods].sort(),
    r: [...form.regions].sort(),
    l: form.language.trim(),
    f: form.freeText.trim(),
    m: llm,
  })
}

function getArtistSuggestCached(key: string): string[] | undefined {
  if (artistSuggestMemCache.has(key)) return artistSuggestMemCache.get(key)!
  try {
    const raw = sessionStorage.getItem(ARTIST_SUGGEST_CACHE_KEY)
    if (!raw) return undefined
    const all = JSON.parse(raw) as Record<string, string[]>
    if (!Object.prototype.hasOwnProperty.call(all, key)) return undefined
    const arr = all[key]
    if (!Array.isArray(arr)) return undefined
    artistSuggestMemCache.set(key, arr)
    return arr
  } catch {
    return undefined
  }
}

function setArtistSuggestCached(key: string, artists: string[]) {
  artistSuggestMemCache.set(key, artists)
  try {
    const raw = sessionStorage.getItem(ARTIST_SUGGEST_CACHE_KEY)
    const all = raw ? (JSON.parse(raw) as Record<string, string[]>) : {}
    all[key] = artists
    sessionStorage.setItem(ARTIST_SUGGEST_CACHE_KEY, JSON.stringify(all))
  } catch {
    /* quota */
  }
}

function ChipRow({
  options,
  selected,
  onToggle,
}: {
  options: string[]
  selected: string[]
  onToggle: (val: string) => void
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {options.map(opt => (
        <button
          key={opt}
          type="button"
          onClick={() => onToggle(opt)}
          className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
            selected.includes(opt)
              ? 'bg-indigo-600 text-white'
              : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  )
}

export default function ChannelEditorForm({
  initial,
  config,
  onSave,
  onCancel,
}: {
  initial: ChannelEditorValues
  config: ChannelEditorConfig
  onSave: (data: ChannelEditorValues) => void
  onCancel?: () => void
}) {
  const [form, setForm] = useState(initial)
  const formRef = useRef(form)
  formRef.current = form
  const [llmSuggestions, setLlmSuggestions] = useState<string[]>([])
  const [loadingSuggestions, setLoadingSuggestions] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    setForm(initial)
  }, [initial])

  const toggleArr = (arr: string[], val: string) =>
    arr.includes(val) ? arr.filter(x => x !== val) : [...arr, val]

  const toggleMedium = (arr: string[], val: string) =>
    arr.includes(val) ? arr.filter(x => x !== val) : [...arr, val]

  const field = <K extends keyof ChannelEditorValues>(k: K, v: ChannelEditorValues[K]) =>
    setForm(f => ({ ...f, [k]: v }))

  const hasSelections =
    form.name.trim() !== '' ||
    form.genres.length > 0 ||
    form.timePeriods.length > 0 ||
    form.regions.length > 0 ||
    form.language.trim() !== '' ||
    form.freeText.trim() !== ''

  const llmChoice = config.readLlm()
  const artistSuggestKey = useMemo(
    () => stableArtistSuggestKey(form, llmChoice),
    [
      form.name,
      form.genres.join(','),
      form.timePeriods.join(','),
      form.regions.join(','),
      form.language,
      form.freeText,
      llmChoice,
    ]
  )

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    abortRef.current?.abort()

    if (!hasSelections) {
      setLlmSuggestions([])
      setLoadingSuggestions(false)
      return
    }

    const cached = getArtistSuggestCached(artistSuggestKey)
    if (cached !== undefined) {
      setLlmSuggestions(cached)
      setLoadingSuggestions(false)
      return
    }

    const scheduleKey = artistSuggestKey
    debounceRef.current = setTimeout(async () => {
      const f = formRef.current
      const llm = config.readLlm()
      const bodyKey = stableArtistSuggestKey(f, llm)
      if (bodyKey !== scheduleKey) return

      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      setLoadingSuggestions(true)
      try {
        const res = await fetch('/api/suggest-artists', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config.buildSuggestBody(f, llm)),
          signal: controller.signal,
        })
        if (controller.signal.aborted) return
        const after = stableArtistSuggestKey(formRef.current, config.readLlm())
        if (after !== bodyKey) return
        if (res.ok) {
          const data = (await res.json()) as { artists?: unknown }
          const artists = Array.isArray(data.artists)
            ? data.artists.filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
            : []
          setArtistSuggestCached(bodyKey, artists)
          setLlmSuggestions(artists)
        }
      } catch (e) {
        if ((e as { name?: string }).name !== 'AbortError') {
          console.error('[ChannelEditorForm suggest-artists]', e)
        }
      }
      if (!controller.signal.aborted) setLoadingSuggestions(false)
    }, ARTIST_SUGGEST_DEBOUNCE_MS)

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
        debounceRef.current = null
      }
    }
  }, [hasSelections, artistSuggestKey, config])

  const staticOptions = config.getStaticArtistOptions?.(form) ?? []
  const artistOptions = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    const push = (name: string) => {
      const k = name.toLowerCase()
      if (seen.has(k)) return
      seen.add(k)
      out.push(name)
    }
    for (const a of llmSuggestions) push(a)
    for (const a of staticOptions) push(a)
    for (const a of form.artists) push(a)
    return out
  }, [llmSuggestions, staticOptions, form.artists])

  const toggleArtist = (name: string) => {
    field(
      'artists',
      form.artists.includes(name) ? form.artists.filter(x => x !== name) : [...form.artists, name]
    )
  }

  return (
    <div className="space-y-4 py-4 border-t border-zinc-100">
      <div className="rounded-2xl border border-indigo-200/60 bg-indigo-50/40 p-3 sm:p-4">
        <label className="text-xs font-bold text-indigo-900/90 uppercase tracking-wider">
          {config.freeTextTitle}
        </label>
        <p className="mt-1 text-xs text-zinc-600 leading-relaxed">{config.freeTextHelp}</p>
        <textarea
          value={form.freeText}
          onChange={e => field('freeText', e.target.value)}
          placeholder={config.freeTextPlaceholder}
          rows={4}
          className="mt-2 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-300 resize-y min-h-[4.5rem]"
        />
        <p className="mt-1.5 text-[11px] text-zinc-500">
          Don&apos;t repeat the channel name here—that belongs in the next field. The name and this
          description are both sent to the model.
        </p>
      </div>

      <div>
        <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
          {config.nameLabel}
        </label>
        <p className="mt-1 text-xs text-zinc-500 leading-relaxed">{config.nameHelp}</p>
        <input
          type="text"
          value={form.name}
          onChange={e => field('name', e.target.value)}
          placeholder={config.namePlaceholder}
          className="mt-1.5 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-300"
        />
      </div>

      <div className="space-y-4 border-t border-zinc-100 pt-4">
        <p className="text-xs text-zinc-500 leading-relaxed">
          <span className="font-semibold text-zinc-600">Refine: </span>
          {config.refineHelp}
        </p>

        {config.showMediums && config.mediumOptions && config.mediumOptions.length > 0 && (
          <div>
            <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
              Medium
            </label>
            <div className="mt-2 flex flex-wrap gap-2">
              {config.mediumOptions.map(({ id, label, hint }) => (
                <button
                  key={id}
                  type="button"
                  title={hint}
                  onClick={() => field('mediums', toggleMedium(form.mediums, id))}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    form.mediums.includes(id)
                      ? 'bg-indigo-600 text-white'
                      : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
            Genres
          </label>
          <ChipRow
            options={config.genreOptions}
            selected={form.genres}
            onToggle={g => field('genres', toggleArr(form.genres, g))}
          />
        </div>

        <div>
          <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
            Time periods
          </label>
          <ChipRow
            options={config.timePeriodOptions}
            selected={form.timePeriods}
            onToggle={t => field('timePeriods', toggleArr(form.timePeriods, t))}
          />
        </div>

        {config.showRegions && config.regionOptions && (
          <div>
            <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
              Region
            </label>
            <ChipRow
              options={config.regionOptions}
              selected={form.regions}
              onToggle={r => field('regions', toggleArr(form.regions, r))}
            />
          </div>
        )}

        {config.showLanguage && config.languageOptions && (
          <div>
            <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
              Language
            </label>
            <ChipRow
              options={config.languageOptions}
              selected={csvToArray(form.language)}
              onToggle={l => field('language', toggleCsv(form.language, l))}
            />
          </div>
        )}

        <div>
          <div className="flex items-center gap-2 mb-1">
            <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
              {config.artistsLabel}
            </label>
            {loadingSuggestions && <span className="text-xs text-zinc-400">updating…</span>}
          </div>
          {artistOptions.length > 0 ? (
            <ChipRow options={artistOptions} selected={form.artists} onToggle={toggleArtist} />
          ) : (
            <p className="mt-1 text-xs text-zinc-400">
              {hasSelections ? config.artistsEmptyHint : config.artistsNeedInputHint}
            </p>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">
              Popularity
            </label>
            <span className="text-xs text-indigo-600 font-medium">
              {popularityLabel(form.popularity)}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-zinc-400 w-20 text-right shrink-0">Hidden gems</span>
            <input
              type="range"
              min={0}
              max={100}
              value={form.popularity}
              onChange={e => field('popularity', Number(e.target.value))}
              className="flex-1 accent-indigo-600"
            />
            <span className="text-xs text-zinc-400 w-20 shrink-0">Mainstream</span>
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-1">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-1.5 rounded-lg border border-zinc-200 text-zinc-600 text-sm font-medium hover:bg-zinc-50 transition-colors"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            if (form.name.trim()) onSave(form)
          }}
          disabled={!form.name.trim()}
          className="px-4 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors disabled:opacity-40"
        >
          Save
        </button>
      </div>
    </div>
  )
}
