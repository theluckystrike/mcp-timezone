/**
 * Time zone arithmetic on Intl alone. No dependencies, no tz database shipped: the
 * ICU data inside Node is the source of truth, so DST rules stay correct as Node is
 * updated rather than going stale in a bundled table.
 */
import { FIXED_ABBREV, RAW_PLACES } from "./zones.js";

/* ------------------------------------------------------------ zone validity */

/**
 * Node's Intl.supportedValuesOf("timeZone") returns the CANONICAL (mostly pre-2022)
 * ids: it lists Asia/Calcutta, not Asia/Kolkata, and Europe/Kiev, not Europe/Kyiv,
 * although Intl.DateTimeFormat accepts both. Checking membership alone would reject
 * the modern spelling users type, so a zone is valid when DateTimeFormat accepts it
 * AND the id it resolves to is in the supported list.
 */
const SUPPORTED = new Set<string>(Intl.supportedValuesOf("timeZone"));

export function isValidZone(zone: string): boolean {
  if (zone === "UTC") return true;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch { return false; }
  // Etc/GMT+N fixed offsets are accepted by ICU but are absent from supportedValuesOf
  // entirely; they are the only ids allowed through on the DateTimeFormat check alone.
  if (/^Etc\//.test(zone)) return true;
  return SUPPORTED.has(resolved) || SUPPORTED.has(zone);
}

/** Every IANA id this Node build knows, plus the modern spellings in the place table. */
export function allZones(): string[] {
  const s = new Set<string>(SUPPORTED);
  for (const z of Object.values(RAW_PLACES)) if (isValidZone(z)) s.add(z);
  s.add("UTC");
  return [...s].sort();
}

/* --------------------------------------------------------------- place table */

export interface PlaceTable { byName: Map<string, string>; dropped: string[] }

/** Verified at startup: an entry naming a zone this build cannot resolve is dropped. */
export function buildPlaceTable(): PlaceTable {
  const byName = new Map<string, string>();
  const dropped: string[] = [];
  for (const [name, zone] of Object.entries(RAW_PLACES)) {
    if (isValidZone(zone)) byName.set(name, zone);
    else dropped.push(`${name} -> ${zone}`);
  }
  return { byName, dropped };
}

const TABLE = buildPlaceTable();
export const PLACE_COUNT = TABLE.byName.size;
export const DROPPED_PLACES = TABLE.dropped;

function norm(s: string): string {
  return String(s).trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,'`]/g, "")
    .replace(/\s+/g, " ");
}

/** Levenshtein, capped: only used to build a suggestion list. */
function dist(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 4) return 99;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

export interface ZoneHit { zone: string; matched: string; note?: string }
/** A caller-supplied name is echoed back, so it is truncated: a 1 MB argument must not become a 1 MB error. */
export function clip(s: string, n = 80): string {
  const t = String(s ?? "");
  return t.length <= n ? t : `${t.slice(0, n)}... (${t.length} characters)`;
}

export class UnknownZoneError extends Error {
  constructor(public input: string, public suggestions: string[]) {
    super(
      `unknown time zone or place: "${clip(input)}"` +
      (suggestions.length ? `. Did you mean: ${suggestions.join(", ")}?` : ". Pass an IANA zone such as Europe/Warsaw, or a city name such as Warsaw.")
    );
  }
}

/** "Warsaw", "poland", "Europe/Warsaw", "PST", "UTC+2" -> an IANA zone. */
export function resolveZone(input: string): ZoneHit {
  const raw = String(input ?? "").trim();
  if (!raw) throw new UnknownZoneError(raw, []);
  /**
   * An IANA id is taken as-is, but only when it LOOKS like one (Region/City, or an
   * exact entry of the supported list). ICU also accepts legacy country aliases such
   * as "Poland", "Japan" and "Turkey"; letting those through here would return the
   * word the user typed instead of a real zone id, so the place table answers them.
   */
  if ((raw.includes("/") || SUPPORTED.has(raw) || raw.toUpperCase() === "UTC") && isValidZone(raw)) {
    return { zone: raw.toUpperCase() === "UTC" ? "UTC" : raw, matched: raw };
  }

  const n = norm(raw);
  // V4-6: a fixed abbreviation resolves to a fixed offset, never to a DST-observing zone.
  const fx = FIXED_ABBREV[n];
  if (fx && isValidZone(fx.zone)) return { zone: fx.zone, matched: raw, note: fx.note };

  const direct = TABLE.byName.get(n);
  if (direct) return { zone: direct, matched: raw };

  // "Europe/warsaw" typed in the wrong case, or with a space for the underscore
  const asId = raw.replace(/\s+/g, "_");
  const ci = allZones().find(z => z.toLowerCase() === asId.toLowerCase());
  if (ci) return { zone: ci, matched: raw };

  // fixed offsets: UTC+2, GMT-05:30
  const off = /^(?:utc|gmt)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i.exec(n.replace(/\s+/g, ""));
  if (off) {
    const sign = off[1] === "-" ? "+" : "-";   // Etc/GMT signs are inverted
    const h = Number(off[2]);
    if (!off[3] && h <= 14) {
      const z = `Etc/GMT${sign}${h}`;
      if (isValidZone(z)) return {
        zone: z, matched: raw,
        note: `${raw.toUpperCase().replace(/\s+/g, "")} is a fixed offset, read as ${z}: it never follows daylight saving. Pass a place name if you want its clock changes.`,
      };
    }
    if (off[3]) {
      throw new Error(
        `"${clip(raw)}" is a fixed offset with minutes, and IANA has no zone for it. ` +
        `Name the place instead (UTC+05:30 is India, so pass "India" or "Asia/Kolkata"), ` +
        `or use a whole-hour offset such as UTC+5.`,
      );
    }
    throw new UnknownZoneError(raw, []);
  }

  const cand: { name: string; d: number }[] = [];
  for (const name of TABLE.byName.keys()) {
    if (name.startsWith(n) || n.startsWith(name) || name.includes(n)) cand.push({ name, d: 0 });
    else { const d = dist(n, name); if (d <= 2) cand.push({ name, d }); }
  }
  cand.sort((a, b) => a.d - b.d || a.name.length - b.name.length);
  const seen = new Set<string>();
  const sug: string[] = [];
  for (const c of cand) {
    const z = TABLE.byName.get(c.name)!;
    const label = `${c.name} (${z})`;
    if (seen.has(z)) continue;
    seen.add(z); sug.push(label);
    if (sug.length >= 6) break;
  }
  if (sug.length === 1 && cand[0] && cand[0].d === 0 && cand[0].name === n) {
    return { zone: TABLE.byName.get(cand[0].name)!, matched: raw };
  }
  if (!sug.length) {
    for (const z of allZones()) {
      if (z.toLowerCase().includes(n.replace(/\s/g, "_"))) { sug.push(z); if (sug.length >= 6) break; }
    }
  }
  throw new UnknownZoneError(raw, sug);
}

/* ------------------------------------------------------------- wall clock */

export interface Wall { y: number; m: number; d: number; h: number; mi: number; s: number }

const FMT = new Map<string, Intl.DateTimeFormat>();
function parts(zone: string): Intl.DateTimeFormat {
  let f = FMT.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    FMT.set(zone, f);
  }
  return f;
}

/** The wall-clock reading in `zone` at instant `date`. */
export function wallIn(date: Date, zone: string): Wall {
  const p = parts(zone).formatToParts(date);
  const g = (t: string) => Number(p.find(x => x.type === t)!.value);
  return { y: g("year"), m: g("month"), d: g("day"), h: g("hour"), mi: g("minute"), s: g("second") };
}

/** UTC offset of `zone` at instant `date`, in minutes east of UTC (Asia/Kolkata -> 330). */
export function offsetMinutes(date: Date, zone: string): number {
  const w = wallIn(date, zone);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

export function offsetLabel(mins: number): string {
  const sign = mins < 0 ? "-" : "+";
  const a = Math.abs(mins);
  return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

/* ------------------------------------------------- strict wall validation */

/** Date.UTC maps years 0-99 onto 1900-1999; this keeps the literal year. */
export function utcFromWall(w: Wall): number {
  const t = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s ?? 0);
  if (w.y >= 0 && w.y <= 99) { const d = new Date(t); d.setUTCFullYear(w.y); return d.getTime(); }
  return t;
}

/**
 * V4-4: every field in range AND the UTC round-trip equal to the input. Date.UTC alone
 * rolls 2026-02-30 forward to 2026-03-02 without a word, so one typo silently books a
 * meeting on a different day and every downstream answer is wrong but well-formed.
 */
export function assertValidWall(w: Wall, what = "date"): Wall {
  const fields: [string, number, number, number][] = [
    ["year", w.y, 1, 9999], ["month", w.m, 1, 12], ["day", w.d, 1, 31],
    ["hour", w.h, 0, 23], ["minute", w.mi, 0, 59], ["second", w.s ?? 0, 0, 59],
  ];
  for (const [name, v, lo, hi] of fields) {
    if (!Number.isInteger(v) || v < lo || v > hi) {
      throw new Error(`${what} has an out-of-range ${name}: ${clip(String(v))} (allowed ${lo}-${hi})`);
    }
  }
  const d = new Date(utcFromWall(w));
  const same = !Number.isNaN(d.getTime())
    && d.getUTCFullYear() === w.y && d.getUTCMonth() + 1 === w.m && d.getUTCDate() === w.d
    && d.getUTCHours() === w.h && d.getUTCMinutes() === w.mi && d.getUTCSeconds() === (w.s ?? 0);
  if (!same) {
    const inMonth = new Date(Date.UTC(w.y, w.m, 0)).getUTCDate();
    throw new Error(
      `${what} "${w.y}-${P2(w.m)}-${P2(w.d)}" is not a real calendar date: ` +
      `${w.y}-${P2(w.m)} has ${inMonth} days. Dates are never rolled forward.`,
    );
  }
  return w;
}

/** A strict YYYY-MM-DD: "2026-02-30" is refused, never normalised to 2026-03-02. */
export function parseIsoDateStrict(s: string, what = "date"): Wall {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? "").trim());
  if (!m) throw new Error(`${what} must be a calendar date written YYYY-MM-DD, got "${clip(String(s ?? ""))}"`);
  return assertValidWall({ y: Number(m[1]), m: Number(m[2]), d: Number(m[3]), h: 0, mi: 0, s: 0 }, what);
}

/* ------------------------------------------------------------- DST policy */

export type GapPolicy = "forward" | "backward";
export type FoldPolicy = "first" | "second";
export interface WallPolicy { gap?: GapPolicy; fold?: FoldPolicy }
export interface WallResolved { date: Date; kind: "unique" | "gap" | "fold"; note?: string }

function sameWall(a: Wall, b: Wall): boolean {
  return a.y === b.y && a.m === b.m && a.d === b.d && a.h === b.h && a.mi === b.mi && (a.s ?? 0) === (b.s ?? 0);
}

/**
 * Every UTC instant whose wall reading in `zone` is exactly `w`: zero inside a
 * spring-forward gap, two inside an autumn fold, one on every other day. Candidate
 * offsets are taken a day either side of the target, which brackets any transition.
 */
export function instantsFor(w: Wall, zone: string): Date[] {
  const target = utcFromWall(w);
  const offs = [
    offsetMinutes(new Date(target - 86400000), zone),
    offsetMinutes(new Date(target), zone),
    offsetMinutes(new Date(target + 86400000), zone),
  ];
  const out: Date[] = [];
  const seen = new Set<number>();
  for (const off of offs) {
    const t = target - off * 60000;
    if (seen.has(t)) continue;
    seen.add(t);
    if (sameWall(wallIn(new Date(t), zone), w)) out.push(new Date(t));
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

/**
 * V4-5: an explicit DST policy. A wall time in a spring-forward gap is refused with the
 * two valid neighbours named, unless the caller passes gap "forward" or "backward". A
 * wall time in an autumn fold returns the FIRST occurrence and says so; fold "second"
 * selects the other. Silence here is what moves a meeting by an hour once a year.
 */
export function resolveWall(w: Wall, zone: string, policy: WallPolicy = {}, what = "time"): WallResolved {
  assertValidWall(w, what);
  const hits = instantsFor(w, zone);
  const label = `${w.y}-${P2(w.m)}-${P2(w.d)} ${P2(w.h)}:${P2(w.mi)}`;
  if (hits.length === 1) return { date: hits[0], kind: "unique" };
  if (hits.length === 0) {
    const target = utcFromWall(w);
    const before = offsetMinutes(new Date(target - 86400000), zone);
    const after = offsetMinutes(new Date(target + 86400000), zone);
    const earlier = new Date(target - after * 60000);   // the last reading before the jump
    const later = new Date(target - before * 60000);    // the first reading after it
    const say = (d: Date) => `${dateKey(wallIn(d, zone))} ${timeKey(wallIn(d, zone))}`;
    if (policy.gap === "forward" || policy.gap === "backward") {
      const pick = policy.gap === "forward" ? later : earlier;
      return {
        date: pick, kind: "gap",
        note: `${label} does not exist in ${zone} (clocks jump ${offsetLabel(before)} -> ${offsetLabel(after)}); ` +
          `gap:"${policy.gap}" moved it to ${say(pick)}.`,
      };
    }
    throw new Error(
      `${label} does not exist in ${zone}: that night the clocks jump from ${offsetLabel(before)} to ${offsetLabel(after)}. ` +
      `The valid times either side are ${say(earlier)} and ${say(later)}. Pick one, ` +
      `or pass gap:"backward" for the first or gap:"forward" for the second.`,
    );
  }
  const second = policy.fold === "second";
  const pick = second ? hits[hits.length - 1] : hits[0];
  return {
    date: pick, kind: "fold",
    note: `${label} happens twice in ${zone} (the clocks go back); used the ${second ? "second" : "first"} occurrence, ` +
      `${zoneAbbrev(pick, zone)} ${offsetLabel(offsetMinutes(pick, zone))}` +
      (second ? "." : `. Pass fold:"second" for the later one.`),
  };
}

/**
 * Wall clock in a zone -> the UTC instant. Internal callers (slot grids, overlap
 * boundaries) walk a calendar and cannot stop on a gap, so the default policy here is
 * gap "forward"; caller-supplied times go through resolveWall with no default, which
 * refuses instead.
 */
export function zonedToUtc(w: Wall, zone: string, policy: WallPolicy = { gap: "forward" }): Date {
  return resolveWall(w, zone, policy).date;
}

const P2 = (n: number) => String(n).padStart(2, "0");
export function dateKey(w: Wall): string { return `${w.y}-${P2(w.m)}-${P2(w.d)}`; }
export function timeKey(w: Wall): string { return `${P2(w.h)}:${P2(w.mi)}`; }

const WEEKDAY = new Map<string, Intl.DateTimeFormat>();
export function weekdayIn(date: Date, zone: string): string {
  let f = WEEKDAY.get(zone);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short" }); WEEKDAY.set(zone, f); }
  return f.format(date);
}
export function zoneAbbrev(date: Date, zone: string): string {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" });
  const p = f.formatToParts(date).find(x => x.type === "timeZoneName");
  return p ? p.value : offsetLabel(offsetMinutes(date, zone));
}

/** "2026-09-10 15:00 Fri (CEST, UTC+02:00)" */
export function describe(date: Date, zone: string): string {
  const w = wallIn(date, zone);
  const off = offsetMinutes(date, zone);
  return `${dateKey(w)} ${timeKey(w)} ${weekdayIn(date, zone)} (${zoneAbbrev(date, zone)}, ${offsetLabel(off)})`;
}

/* ------------------------------------------------------------ time parsing */

export function hhmmToMinutes(s: string, what = "time"): number {
  const m = /^(\d{1,2}):?(\d{2})?$/.exec(String(s).trim());
  if (!m) throw new Error(`${what} must look like "09:00" or "17:30", got "${s}"`);
  const h = Number(m[1]), mi = Number(m[2] ?? 0);
  if (h > 24 || mi > 59 || h * 60 + mi > 24 * 60) throw new Error(`${what} is out of range: "${clip(s)}"`);
  return h * 60 + mi;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function clockPart(s: string): { h: number; mi: number } | undefined {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(s.trim());
  if (!m) return undefined;
  let h = Number(m[1]);
  const mi = Number(m[2] ?? 0);
  const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || mi > 59) return undefined;
  return { h, mi };
}

/**
 * Parse a user time expressed in `zone`. Accepted:
 *   "2026-09-10 15:00", "2026-09-10T15:00", "2026-09-10"        (wall time in `zone`)
 *   "2026-09-10T15:00:00Z", "...+02:00"                          (absolute, zone ignored)
 *   "3pm", "15:00", "3pm tomorrow", "tomorrow 3pm", "monday 9am" (relative to today in `zone`)
 *   "now"
 * Returns the UTC instant.
 */
export interface ParsedTime { date: Date; resolution?: WallResolved }

export function parseTimeIn(input: string, zone: string, now = new Date(), policy: WallPolicy = {}): Date {
  return parseTimeInDetailed(input, zone, now, policy).date;
}

/** The same parse, with the DST resolution (gap or fold) the caller has to be told about. */
export function parseTimeInDetailed(input: string, zone: string, now = new Date(), policy: WallPolicy = {}): ParsedTime {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("time is required");
  const low = raw.toLowerCase();
  if (low === "now") return { date: new Date(now.getTime()) };

  // absolute: has an explicit offset or Z
  if (/(?:z|[+-]\d{2}:?\d{2})$/i.test(raw) && /\d{4}-\d{2}-\d{2}/.test(raw)) {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) throw new Error(`not a valid time: "${clip(input)}"`);
    return { date: d };
  }

  // ISO-ish date, optionally with a time
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?)?$/i.exec(raw);
  if (iso) {
    let h = Number(iso[4] ?? 0);
    const ap = iso[7]?.toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    const r = resolveWall({
      y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]),
      h, mi: Number(iso[5] ?? 0), s: Number(iso[6] ?? 0),
    }, zone, policy, "time");
    return { date: r.date, resolution: r };
  }

  // "10 sep 2026 3pm" / "sep 10 3pm"
  const md = /^(?:(\d{1,2})\s+([a-z]{3,9})|([a-z]{3,9})\s+(\d{1,2}))(?:\s+(\d{4}))?(?:\s+(.+))?$/i.exec(raw);
  if (md) {
    const monTxt = (md[2] ?? md[3]).slice(0, 3).toLowerCase();
    const mon = MONTH_NAMES.indexOf(monTxt);
    if (mon >= 0) {
      const day = Number(md[1] ?? md[4]);
      const today = wallIn(now, zone);
      const year = md[5] ? Number(md[5]) : today.y;
      const c = md[6] ? clockPart(md[6]) : { h: 9, mi: 0 };
      if (c) {
        const r = resolveWall({ y: year, m: mon + 1, d: day, h: c.h, mi: c.mi, s: 0 }, zone, policy, "time");
        return { date: r.date, resolution: r };
      }
    }
  }

  // relative words + a clock, in either order
  const words = low.split(/\s+/).filter(Boolean);
  const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  let dayShift: number | undefined;
  let clock: { h: number; mi: number } | undefined;
  const leftovers: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "today" || w === "tonight") { dayShift = 0; continue; }
    if (w === "tomorrow") { dayShift = 1; continue; }
    if (w === "yesterday") { dayShift = -1; continue; }
    if (w === "next" && words[i + 1]) continue;
    if (w === "at" || w === "on" || w === "this") continue;
    const di = DAYS.findIndex(d => d === w || d.slice(0, 3) === w);
    if (di >= 0) {
      const todayIdx = DAYS.indexOf(new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" }).format(now).toLowerCase());
      let delta = (di - todayIdx + 7) % 7;
      if (delta === 0 && low.includes("next")) delta = 7;
      if (low.includes("next") && delta < 7) delta += (delta === 0 ? 7 : 0);
      dayShift = delta;
      continue;
    }
    const c = clockPart(w);
    if (c) { clock = c; continue; }
    leftovers.push(w);
  }
  if (leftovers.length === 0 && (clock || dayShift !== undefined)) {
    const today = wallIn(now, zone);
    const base = Date.UTC(today.y, today.m - 1, today.d + (dayShift ?? 0));
    const b = new Date(base);
    const r = resolveWall({
      y: b.getUTCFullYear(), m: b.getUTCMonth() + 1, d: b.getUTCDate(),
      h: clock?.h ?? 9, mi: clock?.mi ?? 0, s: 0,
    }, zone, policy, "time");
    return { date: r.date, resolution: r };
  }

  const fallback = new Date(raw);
  if (!Number.isNaN(fallback.getTime())) return { date: fallback };
  throw new Error(
    `not a valid time: "${clip(input)}". Use "2026-09-10 15:00", an ISO timestamp, or a phrase like "3pm tomorrow".`,
  );
}

/* ----------------------------------------------------------------- overlap */

export interface WorkWindow { zone: string; startMin: number; endMin: number }

/**
 * The daily window, in UTC minutes from 00:00 UTC, during which every zone is inside
 * its working hours. Computed on a concrete date because DST moves the answer: the
 * London/New York overlap is one hour wider in the two weeks the two are out of step.
 */
export function overlapOnDate(windows: WorkWindow[], dayUtc: Date): { startMin: number; endMin: number } | null {
  let lo = -24 * 60, hi = 48 * 60;
  for (const w of windows) {
    const off = offsetMinutes(dayUtc, w.zone);
    const s = w.startMin - off, e = w.endMin - off;
    lo = Math.max(lo, s); hi = Math.min(hi, e);
  }
  if (hi <= lo) return null;
  return { startMin: lo, endMin: hi };
}

/** The wall clock `minutes` after local midnight on `base` (1440 lands on the next day). */
function wallAtMinutes(base: Wall, minutes: number): Wall {
  const d = new Date(Date.UTC(base.y, base.m - 1, base.d) + minutes * 60000);
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(), s: 0,
  };
}

export interface LocalOverlap { startUtc: Date; endUtc: Date }

/**
 * V4-7: the overlap of working windows that all sit on the SAME LOCAL CALENDAR DATE.
 * Each boundary is built from that local date in its own zone and only then converted
 * to UTC. The old minutes-from-UTC-midnight form answered for whichever UTC day
 * contained local midnight, which for every positive offset is the day before.
 */
export function overlapOnLocalDate(windows: WorkWindow[], isoDate: string): LocalOverlap | null {
  const base = parseIsoDateStrict(isoDate, "date");
  let lo = -Infinity, hi = Infinity;
  for (const w of windows) {
    const s = zonedToUtc(wallAtMinutes(base, w.startMin), w.zone, { gap: "forward" }).getTime();
    const e = zonedToUtc(wallAtMinutes(base, w.endMin), w.zone, { gap: "forward" }).getTime();
    lo = Math.max(lo, s); hi = Math.min(hi, e);
  }
  if (!(hi > lo)) return null;
  return { startUtc: new Date(lo), endUtc: new Date(hi) };
}

/* ------------------------------------------------------------- DST changes */

export interface DstChange { atUtc: Date; fromOffset: number; toOffset: number }

/** Every offset transition of `zone` in `year`, found by scan then binary search. */
export function dstChanges(zone: string, year: number): DstChange[] {
  const out: DstChange[] = [];
  let cursor = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  let prev = offsetMinutes(new Date(cursor), zone);
  const DAY = 86400000;
  while (cursor < end) {
    const next = Math.min(cursor + DAY, end);
    const off = offsetMinutes(new Date(next), zone);
    if (off !== prev) {
      let lo = cursor, hi = next;
      while (hi - lo > 60000) {
        const mid = lo + Math.floor((hi - lo) / 2 / 60000) * 60000;
        if (mid === lo) break;
        if (offsetMinutes(new Date(mid), zone) === prev) lo = mid; else hi = mid;
      }
      out.push({ atUtc: new Date(hi), fromOffset: prev, toOffset: off });
      prev = off;
    }
    cursor = next;
  }
  return out;
}

/* ----------------------------------------------------------- business days */

/** The day loop is O(days); a 200-year range used to stop silently at the guard and report a short answer. */
export const MAX_BUSINESS_DAY_SPAN = 3700;

export function businessDays(from: string, to: string, zone: string, holidays: string[] = []): {
  days: string[]; weekendCount: number; holidayCount: number; total: number;
} {
  // V4-10: a date-shaped string is calendar-validated, not trusted. "2026-02-30" used to
  // pass the regex and normalise to 2026-03-02, moving both ends of a payment term.
  const hs = new Set(holidays.map(h => dateKey(parseIsoDateStrict(String(h), "a holiday"))));
  const dated = (v: string, what: string) => {
    const raw = String(v ?? "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? dateKey(parseIsoDateStrict(raw, what))
      : dateKey(wallIn(parseTimeIn(raw, zone), zone));
  };
  const s = dated(from, '"from"');
  const e = dated(to, '"to"');
  if (e < s) throw new Error(`"to" (${e}) is before "from" (${s})`);
  const days: string[] = [];
  let weekendCount = 0, holidayCount = 0, total = 0;
  const [y0, m0, d0] = s.split("-").map(Number);
  const [y1, m1, d1] = e.split("-").map(Number);
  let cur = Date.UTC(y0, m0 - 1, d0);
  const last = Date.UTC(y1, m1 - 1, d1);
  const span = Math.round((last - cur) / 86400000) + 1;
  if (span > MAX_BUSINESS_DAY_SPAN) {
    throw new Error(
      `${from} to ${to} is ${span} calendar days; this tool counts at most ` +
      `${MAX_BUSINESS_DAY_SPAN} (about ${Math.round(MAX_BUSINESS_DAY_SPAN / 365)} years) in one call. Split the range.`,
    );
  }
  let guard = 0;
  while (cur <= last && guard++ <= MAX_BUSINESS_DAY_SPAN) {
    const d = new Date(cur);
    const key = `${d.getUTCFullYear()}-${P2(d.getUTCMonth() + 1)}-${P2(d.getUTCDate())}`;
    const dow = d.getUTCDay();
    total++;
    if (dow === 0 || dow === 6) weekendCount++;
    else if (hs.has(key)) holidayCount++;
    else days.push(key);
    cur += 86400000;
  }
  return { days, weekendCount, holidayCount, total };
}

/* ------------------------------------------------------------------- slots */

export interface Participant { name: string; zone: string; startMin: number; endMin: number }
export interface Slot {
  startUtc: Date; endUtc: Date;
  local: { name: string; zone: string; start: string; end: string; date: string }[];
  fairness: number;   // max deviation, in hours, of any participant's midpoint from 13:00 local
}

/**
 * Every start time on a `stepMinutes` grid where the whole meeting fits inside every
 * participant's working window, ranked by fairness. Fairness is the WORST participant's
 * deviation from 13:00 local, not the average: a slot that is comfortable for two people
 * and 06:00 for the third must not outrank one that is 10:00 for everybody.
 */
export function findSlots(
  participants: Participant[],
  durationMinutes: number,
  days: number,
  firstDayUtc: Date,
  stepMinutes = 30,
): Slot[] {
  const out: Slot[] = [];
  const anchor = participants[0];
  const w0 = wallIn(firstDayUtc, anchor.zone);
  for (let d = 0; d < days; d++) {
    const dayStartWall = new Date(Date.UTC(w0.y, w0.m - 1, w0.d + d));
    const base = zonedToUtc({
      y: dayStartWall.getUTCFullYear(), m: dayStartWall.getUTCMonth() + 1, d: dayStartWall.getUTCDate(),
      h: 0, mi: 0, s: 0,
    }, anchor.zone).getTime();
    for (let t = 0; t < 26 * 60; t += stepMinutes) {
      const startUtc = new Date(base + t * 60000);
      // V4-8: firstDayUtc is a lower-bound INSTANT, not just a date. Dropping its time
      // component ranked meetings that had already started.
      if (startUtc.getTime() < firstDayUtc.getTime()) continue;
      const endUtc = new Date(startUtc.getTime() + durationMinutes * 60000);
      let fits = true;
      let fairness = 0;
      const local: Slot["local"] = [];
      for (const p of participants) {
        const ws = wallIn(startUtc, p.zone), we = wallIn(endUtc, p.zone);
        const sMin = ws.h * 60 + ws.mi;
        const eMin = sMin + durationMinutes;
        if (dateKey(ws) !== dateKey(we) && eMin !== 24 * 60) { fits = false; break; }
        if (sMin < p.startMin || eMin > p.endMin) { fits = false; break; }
        const dow = new Date(startUtc.getTime()).getUTCDay;
        const mid = (sMin + eMin) / 2;
        fairness = Math.max(fairness, Math.abs(mid - 13 * 60) / 60);
        local.push({ name: p.name, zone: p.zone, start: timeKey(ws), end: timeKey(we), date: dateKey(ws) });
        void dow;
      }
      if (!fits) continue;
      // skip weekends in the anchor zone
      const wd = weekdayIn(startUtc, anchor.zone);
      if (wd === "Sat" || wd === "Sun") continue;
      out.push({ startUtc, endUtc, local, fairness: Math.round(fairness * 100) / 100 });
    }
  }
  out.sort((a, b) => a.fairness - b.fairness || a.startUtc.getTime() - b.startUtc.getTime());
  return out;
}

export interface NearMissLocal {
  name: string; zone: string; start: string; end: string; date: string;
  outsideMinutes: number; needStart: string; needEnd: string;
}
export interface NearMiss { startUtc: Date; endUtc: Date; outsideMinutes: number; local: NearMissLocal[] }

const hhmm = (min: number) => `${P2(Math.floor(min / 60) % 24)}:${P2(min % 60)}`;

/**
 * D-R30: when nothing fits, the least-bad times. Ranked by the TOTAL minutes any
 * participant would spend outside their own hours, with the working hours that would
 * make each slot fit. A refusal alone tells the user nothing they can act on.
 */
export function findNearMissSlots(
  participants: Participant[],
  durationMinutes: number,
  days: number,
  firstDayUtc: Date,
  stepMinutes = 30,
  limit = 3,
): NearMiss[] {
  const out: NearMiss[] = [];
  const anchor = participants[0];
  const w0 = wallIn(firstDayUtc, anchor.zone);
  for (let d = 0; d < days; d++) {
    const dayStartWall = new Date(Date.UTC(w0.y, w0.m - 1, w0.d + d));
    const base = zonedToUtc({
      y: dayStartWall.getUTCFullYear(), m: dayStartWall.getUTCMonth() + 1, d: dayStartWall.getUTCDate(),
      h: 0, mi: 0, s: 0,
    }, anchor.zone, { gap: "forward" }).getTime();
    for (let t = 0; t < 26 * 60; t += stepMinutes) {
      const startUtc = new Date(base + t * 60000);
      if (startUtc.getTime() < firstDayUtc.getTime()) continue;
      const endUtc = new Date(startUtc.getTime() + durationMinutes * 60000);
      const wd = weekdayIn(startUtc, anchor.zone);
      if (wd === "Sat" || wd === "Sun") continue;
      let total = 0;
      let usable = true;
      const local: NearMissLocal[] = [];
      for (const p of participants) {
        const ws = wallIn(startUtc, p.zone), we = wallIn(endUtc, p.zone);
        const sMin = ws.h * 60 + ws.mi;
        const eMin = sMin + durationMinutes;
        if (dateKey(ws) !== dateKey(we) && eMin !== 24 * 60) { usable = false; break; }
        const early = Math.max(0, p.startMin - sMin);
        const late = Math.max(0, eMin - p.endMin);
        total += early + late;
        local.push({
          name: p.name, zone: p.zone, start: timeKey(ws), end: timeKey(we), date: dateKey(ws),
          outsideMinutes: early + late,
          needStart: hhmm(Math.min(p.startMin, sMin)), needEnd: hhmm(Math.max(p.endMin, eMin)),
        });
      }
      if (!usable) continue;
      out.push({ startUtc, endUtc, outsideMinutes: total, local });
    }
  }
  out.sort((a, b) => a.outsideMinutes - b.outsideMinutes || a.startUtc.getTime() - b.startUtc.getTime());
  return out.slice(0, limit);
}

/* --------------------------------------------------------------------- ics */

/**
 * V4-9: a content line may not carry a raw control character. CR and LF are the
 * dangerous pair - an attendee holding "\r\nORGANIZER:mailto:x@example.com" injects a
 * whole property - but any C0 code point produces a file the calendar client rejects.
 * Only DESCRIPTION may contain line breaks, and they are escaped to "\n" before folding.
 */
function assertNoControls(v: string, field: string, allowNewlines = false): string {
  const str = String(v ?? "");
  const bad = allowNewlines
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
    : /[\u0000-\u001f\u007f]/;
  const m = bad.exec(str);
  if (m) {
    const cp = `U+${m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
    const what = m[0] === "\r" || m[0] === "\n" ? "a line break" : `a control character (${cp})`;
    throw new Error(`${field} contains ${what}, which would corrupt the calendar file. Remove it and try again.`);
  }
  return str;
}

/** RFC 5545 3.2: a quoted parameter value may contain neither DQUOTE nor CTL. */
function quoteParam(v: string, field: string): string {
  const str = assertNoControls(v, field);
  const bad = /["]/.test(str) ? "a double quote" : /[;:,]/.test(str) ? "one of ; : ," : "";
  if (bad) throw new Error(`${field} contains ${bad}, which cannot appear in a calendar parameter value.`);
  return `"${str}"`;
}

const ICS_EMAIL = /^[^\s@";:,<>\\]+@[^\s@";:,<>\\]+\.[^\s@";:,<>\\]+$/;

/** An attendee is a calendar address: mailto:<addr>. A bare name cannot be invited. */
export function calendarAddress(raw: string): { uri: string; cn: string } {
  const str = assertNoControls(String(raw ?? "").trim(), "an attendee");
  const addr = /^mailto:/i.test(str) ? str.slice(7).trim() : str;
  if (!ICS_EMAIL.test(addr)) {
    throw new Error(
      `attendee "${clip(str)}" is not a calendar address. Pass an email address ` +
      `("maria@acme.com") or a mailto URI ("mailto:maria@acme.com"); a bare name has ` +
      `nowhere to send the invite, so it is refused rather than written as an unroutable one.`,
    );
  }
  return { uri: `mailto:${addr}`, cn: addr.split("@")[0] };
}

function icsEscape(s: string, field = "text", allowNewlines = false): string {
  return assertNoControls(s, field, allowNewlines)
    .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
/** RFC 5545 3.1: fold at 75 octets, continuation lines start with one space. */
function fold(line: string): string[] {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return [line];
  const out: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let len = Math.min(start === 0 ? 75 : 74, bytes.length - start);
    // do not split a UTF-8 sequence
    while (len > 1 && (bytes[start + len] & 0xc0) === 0x80) len--;
    out.push((start === 0 ? "" : " ") + bytes.slice(start, start + len).toString("utf8"));
    start += len;
  }
  return out;
}
export function icsStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export interface AttendeeInput { name?: string; email?: string }
export interface IcsInput {
  title: string; startUtc: Date; durationMinutes: number;
  attendees?: (string | AttendeeInput)[]; description?: string; location?: string; uid?: string;
  organizerEmail?: string; organizerName?: string; now?: Date;
}
export interface IcsResult { text: string; invited: string[]; listedOnly: string[]; organizer?: string }

/**
 * D-R27: an ATTENDEE value must be a CAL-ADDRESS. An entry with an email becomes a real
 * ATTENDEE with a quoted CN; an entry with only a name is NOT written as a fake address
 * (the old "invalid:nomail" form) - it is listed in DESCRIPTION, where a human reads it
 * and no client tries to send to it.
 */
function splitAttendees(list: (string | AttendeeInput)[]): { invited: { uri: string; cn: string }[]; listedOnly: string[] } {
  const invited: { uri: string; cn: string }[] = [];
  const listedOnly: string[] = [];
  for (const a of list) {
    const obj: AttendeeInput = typeof a === "string" ? (a.includes("@") ? { email: a } : { name: a }) : a;
    const email = obj.email ? assertNoControls(String(obj.email).trim(), "an attendee email") : "";
    const name = obj.name ? assertNoControls(String(obj.name).trim(), "an attendee name") : "";
    if (email) {
      const { uri, cn } = calendarAddress(email);
      invited.push({ uri, cn: name || cn });
    } else if (name) {
      if (name.includes("@")) calendarAddress(name);   // a broken address is refused, not silently listed
      listedOnly.push(name);
    } else {
      throw new Error(`an attendee entry has neither a name nor an email address. Pass "maria@acme.com", or {name:"Maria", email:"maria@acme.com"}.`);
    }
  }
  return { invited, listedOnly };
}

/**
 * A VEVENT with UTC DTSTART/DTEND. Writing the instant in UTC removes the need to ship
 * a VTIMEZONE block, which is where hand-rolled .ics files usually go wrong: an
 * inline VTIMEZONE with stale DST rules silently moves the meeting.
 */
export function icsCreate(i: IcsInput): string { return icsCreateDetailed(i).text; }

export function icsCreateDetailed(i: IcsInput): IcsResult {
  const uid = assertNoControls(i.uid ?? `${icsStamp(i.startUtc)}-${Math.random().toString(36).slice(2, 10)}@mcp-timezone`, "uid");
  const end = new Date(i.startUtc.getTime() + i.durationMinutes * 60000);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//theluckystrike//mcp-timezone//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${icsStamp(i.now ?? new Date())}`,
    `DTSTART:${icsStamp(i.startUtc)}`,
    `DTEND:${icsStamp(end)}`,
    `SUMMARY:${icsEscape(i.title, "title")}`,
  ];
  const { invited, listedOnly } = splitAttendees(i.attendees ?? []);
  const organizer = i.organizerEmail ? calendarAddress(i.organizerEmail) : undefined;
  if (organizer) {
    lines.push(`ORGANIZER;CN=${quoteParam(i.organizerName ? assertNoControls(i.organizerName, "organizer name") : organizer.cn, "the organizer name")}:${organizer.uri}`);
  }
  const body = [
    i.description ?? "",
    listedOnly.length ? `Also attending (no email address was given, so they are not invited by the file): ${listedOnly.join(", ")}` : "",
  ].filter(Boolean).join("\n\n");
  if (body) lines.push(`DESCRIPTION:${icsEscape(body, "description", true)}`);
  if (i.location) lines.push(`LOCATION:${icsEscape(i.location, "location")}`);
  for (const { uri, cn } of invited) {
    lines.push(`ATTENDEE;CN=${quoteParam(cn, "an attendee name")};RSVP=TRUE:${uri}`);
  }
  lines.push("END:VEVENT", "END:VCALENDAR");
  return {
    text: lines.flatMap(fold).join("\r\n") + "\r\n",
    invited: invited.map(v => v.uri.slice(7)),
    listedOnly,
    organizer: organizer?.uri.slice(7),
  };
}
