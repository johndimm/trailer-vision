/**
 * Lock height to the viewport below the site nav (h-11). Without this, min-h-screen fallbacks
 * or unbounded flex children can make the page taller than 100dvh.
 */
export default function ConstellationsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[calc(100dvh-2.75rem)] max-h-[calc(100dvh-2.75rem)] w-full min-h-0 flex-col overflow-hidden">
      {children}
    </div>
  );
}
