"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import FilmMusicHomeLink from "./FilmMusicHomeLink";

const LINKS = [
  { href: "/", label: "Player" },
  { href: "/channels", label: "Channels" },
  { href: "/history", label: "History" },
  { href: "/watchlist", label: "Watchlist" },
  { href: "/constellations", label: "Graph" },
  { href: "/settings", label: "Settings" },
  { href: "/help", label: "Help" },
];

/** Player home and full-screen graph use the dark chrome; utility pages use light chrome. */
function isDarkNav(pathname: string): boolean {
  if (pathname === "/") return true;
  if (pathname.startsWith("/constellations")) return true;
  return false;
}

export default function NavBar({ hubUrl }: { hubUrl?: string }) {
  const pathname = usePathname();
  const homeHref = hubUrl || "http://127.0.0.1:8000";
  const dark = isDarkNav(pathname);

  return (
    <nav
      className={`sticky top-0 z-40 w-full min-w-0 shrink-0 border-b backdrop-blur-sm ${
        dark ? "border-zinc-800 bg-black/90" : "border-zinc-200 bg-white/95"
      }`}
    >
      <div className="mx-auto flex h-11 min-w-0 max-w-[min(100%,90rem)] items-stretch px-3 sm:px-4 lg:px-8">
        <div
          className={`sticky left-0 z-20 flex shrink-0 items-center gap-1.5 self-center border-r py-1 pr-2 sm:pr-3 ${
            dark
              ? "border-zinc-800 bg-black/95 shadow-[6px_0_12px_rgba(0,0,0,0.45)]"
              : "border-zinc-200 bg-white/95 shadow-[6px_0_12px_rgba(0,0,0,0.06)]"
          }`}
        >
          <FilmMusicHomeLink
            variant={dark ? "playerDark" : "surfaceLight"}
            href={homeHref}
          />
          <span
            className={`hidden text-sm font-bold tracking-tight whitespace-nowrap sm:inline ${
              dark ? "text-zinc-100" : "text-zinc-900"
            }`}
          >
            Trailer Vision
          </span>
        </div>
        <div className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex w-max min-h-11 items-center gap-1 pl-2 pr-1">
            {LINKS.map(({ href, label }) => {
              const active = pathname === href;
              return (
                <Link
                  key={href}
                  href={href}
                  className={`shrink-0 rounded-lg px-2.5 py-1 text-sm font-medium transition-colors sm:px-3 ${
                    active
                      ? dark
                        ? "bg-zinc-700 text-white"
                        : "bg-zinc-100 text-zinc-900"
                      : dark
                        ? "text-zinc-400 hover:bg-zinc-800 hover:text-white"
                        : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
                  }`}
                >
                  {label}
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </nav>
  );
}
