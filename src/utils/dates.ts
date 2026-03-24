/**
 * Convert an ISO date string to a Unix timestamp in seconds.
 * Returns 0 if the input is undefined.
 */
export function toUnixSeconds(isoDate: string | undefined, fallback: number = 0): number {
  if (!isoDate) return fallback;
  return new Date(isoDate).getTime() / 1000;
}
