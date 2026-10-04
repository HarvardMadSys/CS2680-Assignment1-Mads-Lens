/**
 * A patrol route: a path that branches and rejoins, with a marker moving
 * along it. The same shape the outline draws for a run that delegates —
 * the mark is the product, so the mark is the trajectory.
 */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg
      className="logo"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label="AIPatrol"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* the route: down, fork, rejoin, down */}
      <path d="M12 2.5v3.2" />
      <path d="M6 9.4a3.7 3.7 0 0 1 3.7-3.7h4.6A3.7 3.7 0 0 1 18 9.4" />
      <path d="M6 9.4v5.2" />
      <path d="M18 9.4v5.2" />
      <path d="M6 14.6a3.7 3.7 0 0 0 3.7 3.7h4.6a3.7 3.7 0 0 0 3.7-3.7" />
      <path d="M12 18.3v3.2" />

      {/* the patrol: a marker part-way along the left branch */}
      <circle cx="6" cy="12" r="2.1" fill="currentColor" stroke="none" />
    </svg>
  );
}
