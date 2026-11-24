/** h:mm of a duration in seconds. */
export function fmtHM(sec: number): string {
  const m = Math.max(0, Math.floor(sec / 60));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}
