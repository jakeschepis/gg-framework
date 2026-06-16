/**
 * Reusable chevron back button. Uses the shared button system (ghost pill) so
 * its radius/sizing matches every other chrome button. Keep it presentational
 * — the caller owns what "back" means.
 */
export function BackButton({
  onClick,
  label = "Back",
}: {
  onClick: () => void;
  label?: string;
}): React.ReactElement {
  return (
    <button className="btn btn-ghost btn-icon" onClick={onClick} aria-label={label} title={label}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M15 18l-6-6 6-6"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
