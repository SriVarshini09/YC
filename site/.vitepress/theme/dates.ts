// "Today"-relative dates for the landing page. The page is built once per deploy, so the build date is only
// the first render: Home.vue moves `today` to the visitor's date when it mounts.

/** Today's date (UTC) as YYYY-MM-DD. */
export const isoDay = (now: number = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** Whole days from `today` to `date` (both YYYY-MM-DD). */
export const daysUntil = (date: string, today: string) => Math.ceil((Date.parse(date) - Date.parse(today)) / 86400000);

export const inDays = (date: string, today: string) => {
  const n = daysUntil(date, today);
  return n === 1 ? "tomorrow" : `in ${n} days`;
};

/** From tomorrow on, soonest first: changes that take effect today are no longer "coming up". */
export const aheadOf = <T extends { effectiveDate: string }>(sorted: T[], today: string) => sorted.filter((a) => daysUntil(a.effectiveDate, today) >= 1);
