/**
 * Override the parent constellations layout for the settings page —
 * the settings page needs to scroll freely, not be height-constrained.
 */
export default function ConstellationsSettingsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
