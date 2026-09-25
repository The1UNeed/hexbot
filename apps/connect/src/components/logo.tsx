/** The Hexbot mark from the site (apps/site/src/components/Logo.astro): a rounded hexagon with two pill eyes. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg aria-hidden="true" className="hexface" viewBox="0 0 100 100" width={size} height={size}>
      <g fill="currentColor">
        <path d="M44 6a12 12 0 0 1 12 0l30 17a12 12 0 0 1 6 10v34a12 12 0 0 1-6 10L56 94a12 12 0 0 1-12 0L14 77a12 12 0 0 1-6-10V33a12 12 0 0 1 6-10Z" />
        <rect x="24.3" y="32.7" width="15.5" height="34.8" rx="7.75" fill="var(--paper)" />
        <rect x="60.2" y="32.7" width="15.5" height="34.8" rx="7.75" fill="var(--paper)" />
      </g>
    </svg>
  );
}
