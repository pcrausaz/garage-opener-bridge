/** Milliseconds until the next occurrence of HH:MM in the given IANA time zone. */
export function msUntilNext(hhmm: string, tz: string, now: number = Date.now()): number {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const parts = (t: number) => {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const o: Record<string, number> = {};
    for (const p of f.formatToParts(new Date(t))) if (p.type !== "literal") o[p.type] = Number(p.value);
    return o as { year: number; month: number; day: number; hour: number; minute: number; second: number };
  };
  const p = parts(now);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offset = asUtc - Math.floor(now / 1000) * 1000; // tz offset at `now`
  let candidate = Date.UTC(p.year, p.month - 1, p.day, h, m, 0) - offset;
  if (candidate <= now) candidate += 86_400_000;
  // re-derive offset for the candidate day (DST changes)
  const q = parts(candidate);
  if (q.hour !== h || q.minute !== m) {
    const off2 = Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute, 0) - candidate;
    candidate = Date.UTC(q.year, q.month - 1, q.day, h, m, 0) - off2;
    if (candidate <= now) candidate += 86_400_000;
  }
  return candidate - now;
}
