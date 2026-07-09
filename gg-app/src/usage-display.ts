export function compactResetLabel(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined) return "—";
  const minutes = Math.ceil((resetsAt - now) / 60_000);
  if (minutes <= 0) return "0m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function fullResetLabel(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined) return "Reset time unavailable";
  const remaining = resetsAt - now;
  if (remaining <= 0) return "Resetting now";
  return `Resets in ${compactResetLabel(resetsAt, now)}`;
}
