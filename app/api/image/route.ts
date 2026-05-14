import { NextRequest, NextResponse } from 'next/server'

const WIKI_UA = 'Constellations/1.0 (knowledge graph; +https://www.mediawiki.org/wiki/API:Etiquette)'

async function fetchWikipediaImage(title: string): Promise<{ url: string | null; pageTitle?: string }> {
  const params = new URLSearchParams({
    action: 'query',
    titles: title,
    prop: 'pageimages',
    pithumbsize: '300',
    format: 'json',
    origin: '*',
  })
  const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, {
    headers: { 'User-Agent': WIKI_UA },
  })
  if (!res.ok) return { url: null }
  const data = await res.json()
  const pages = data?.query?.pages ?? {}
  for (const page of Object.values(pages) as any[]) {
    if (page.thumbnail?.source) {
      return { url: page.thumbnail.source, pageTitle: page.title }
    }
  }
  return { url: null }
}

export async function GET(req: NextRequest) {
  const title = (req.nextUrl.searchParams.get('title') ?? '').trim()
  if (!title) return NextResponse.json({ url: null })
  try {
    const result = await fetchWikipediaImage(title)
    return NextResponse.json(result)
  } catch {
    return NextResponse.json({ url: null })
  }
}
