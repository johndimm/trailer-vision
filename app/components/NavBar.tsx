"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Player" },
  { href: "/channels", label: "Channels" },
  { href: "/history", label: "History" },
  { href: "/watchlist", label: "Watchlist" },
  { href: "/constellations", label: "Graph" },
  { href: "/settings", label: "Settings" },
  { href: "/help", label: "Help" },
];

export default function NavBar({ hubUrl }: { hubUrl?: string }) {
  const pathname = usePathname();

  return (
    <nav className="sticky top-0 z-40 w-full min-w-0 shrink-0 border-b border-zinc-800 bg-black/90 backdrop-blur-sm">
      <div className="mx-auto flex h-11 min-w-0 max-w-[min(100%,90rem)] items-center px-3 sm:px-4 lg:px-8">
        <div className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex w-max min-h-11 items-center gap-1 pr-1">
            <a
              href={hubUrl || "http://127.0.0.1:8000"}
              className="font-bold text-zinc-100 mr-2 shrink-0 text-sm tracking-tight hidden sm:inline hover:text-zinc-300 transition-colors"
            >
              Trailer Vision
            </a>
            {LINKS.map(({ href, label }) => {
              const active = pathname === href;
              return (
                <Link
                  key={href}
                  href={href}
                  className={`shrink-0 px-2.5 py-1 sm:px-3 rounded-lg text-sm font-medium transition-colors ${
                    active
                      ? "bg-zinc-700 text-white"
                      : "text-zinc-400 hover:text-white hover:bg-zinc-800"
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
