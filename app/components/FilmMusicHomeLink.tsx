import { Home } from "lucide-react";

type Variant = "playerDark" | "surfaceLight";

const linkClass: Record<Variant, string> = {
  playerDark:
    "border-zinc-700/80 bg-zinc-900/80 text-zinc-400 hover:border-zinc-600 hover:bg-zinc-800 hover:text-white",
  surfaceLight:
    "border-zinc-200 bg-zinc-100 text-zinc-600 hover:border-zinc-300 hover:bg-zinc-200 hover:text-zinc-900",
};

export default function FilmMusicHomeLink({
  variant,
  href = "/",
}: {
  variant: Variant;
  href?: string;
}) {
  return (
    <a
      href={href}
      title="Film & Music — return to hub"
      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors ${linkClass[variant]}`}
      aria-label="Home"
    >
      <Home size={16} strokeWidth={2} aria-hidden />
    </a>
  );
}
