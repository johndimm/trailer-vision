import Link from 'next/link';

const GARDEN_URL = 'https://johndimm.vercel.app';
const GITHUB_URL = 'https://github.com/johndimm/trailer-vision';

export const metadata = {
  title: 'About · Trailer Vision',
  description: 'TikTok-style, trailer-first movie and TV discovery',
};

const wrap: React.CSSProperties = { minHeight: '100vh', background: '#000', color: '#e5e5e5', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' };
const bar: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderBottom: '1px solid #202024' };
const iconBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid #2a2a2e', background: '#151517', color: '#a1a1aa', borderRadius: 10, padding: '8px 12px', fontSize: 13, textDecoration: 'none' };
const main: React.CSSProperties = { maxWidth: 680, margin: '0 auto', padding: '56px 24px' };
const tag: React.CSSProperties = { border: '1px solid #26262a', background: '#141416', color: '#c4c4c8', borderRadius: 8, padding: '6px 12px', fontSize: 13 };

export default function About() {
  return (
    <div style={wrap}>
      <div style={bar}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <a href={GARDEN_URL} title="All apps — John Dimm" style={iconBtn} aria-label="All apps">🏠</a>
          <span style={{ fontSize: 17, fontWeight: 600, color: '#fff' }}>Trailer Vision</span>
        </div>
        <Link href="/" style={iconBtn}>Open app ↗</Link>
      </div>
      <main style={main}>
        <h1 style={{ fontSize: 34, fontWeight: 700, color: '#fff', margin: 0 }}>Trailer Vision</h1>
        <p style={{ fontSize: 18, color: '#a1a1aa', marginTop: 10 }}>TikTok-style, trailer-first movie and TV discovery</p>
        <div style={{ marginTop: 28, fontSize: 15.5, lineHeight: 1.6, color: '#d4d4d8', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p>Trailer Vision is TikTok-style, trailer-first discovery for movies and TV. Trailers autoplay one after another; you rate titles with a tap (red stars for things you have seen, blue for unseen interest) and a language model learns your taste by content similarity rather than collaborative filtering, serving the next batch from a per-channel queue. An Auto toggle plus Fullscreen lets you watch hands-free.</p>
          <p>Channels act as independent &ldquo;taste islands,&rdquo; each with its own filters for genre, era, language, format, and streaming service (Netflix, Prime, Apple TV+, Disney+, HBO Max, Hulu, Paramount+, Peacock). A search box drops results straight into the queue, a Coming Soon channel pulls upcoming titles from TMDB, and an embedded Constellations graph maps the cast, directors, and related films. Everything lives in your browser — no accounts, no server database, no ads.</p>
        </div>
        <div style={{ marginTop: 30 }}>
          <h2 style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#71717a' }}>Built with</h2>
          <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {['React / Next.js', 'TMDB', 'LLM'].map((t) => (<span key={t} style={tag}>{t}</span>))}
          </div>
        </div>
        <div style={{ marginTop: 36, paddingTop: 22, borderTop: '1px solid #202024', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 20, fontSize: 14 }}>
          <Link href="/" style={{ background: '#f4f4f5', color: '#18181b', fontWeight: 600, borderRadius: 10, padding: '10px 18px', textDecoration: 'none' }}>Open Trailer Vision ↗</Link>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" style={{ color: '#a1a1aa', textDecoration: 'none' }}>GitHub</a>
          <a href={GARDEN_URL} style={{ marginLeft: 'auto', color: '#71717a', textDecoration: 'none' }}>← All apps</a>
        </div>
      </main>
    </div>
  );
}
