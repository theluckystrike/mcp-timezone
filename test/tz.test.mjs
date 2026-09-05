import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tz = await import(join(here, "..", "dist", "tz.js"));

const at = (s) => new Date(s);

test("DST: Europe/Warsaw and America/New_York are out of step on 2026-03-15", () => {
  // Warsaw switches 2026-03-29, New York 2026-03-08, so on 15 March Warsaw is still on
  // CET (+01:00) while New York is already on EDT (-04:00): 5 hours apart, not the
  // usual 6.
  const d = at("2026-03-15T12:00:00Z");
  assert.equal(tz.offsetMinutes(d, "Europe/Warsaw"), 60);
  assert.equal(tz.offsetMinutes(d, "America/New_York"), -240);
  assert.equal((60 - -240) / 60, 5);
});

test("DST: on 2026-11-01 the gap is 5 hours again, the other way round", () => {
  // Warsaw went back on 2026-10-25; New York goes back on 2026-11-01 at 06:00 UTC.
  const before = at("2026-11-01T04:00:00Z");
  const after = at("2026-11-01T12:00:00Z");
  assert.equal(tz.offsetMinutes(before, "Europe/Warsaw"), 60);
  assert.equal(tz.offsetMinutes(before, "America/New_York"), -240);
  assert.equal(tz.offsetMinutes(after, "Europe/Warsaw"), 60);
  assert.equal(tz.offsetMinutes(after, "America/New_York"), -300);
});

test("dst_changes finds both transitions to the minute", () => {
  const w = tz.dstChanges("Europe/Warsaw", 2026).map(c => c.atUtc.toISOString());
  assert.deepEqual(w, ["2026-03-29T01:00:00.000Z", "2026-10-25T01:00:00.000Z"]);
  const n = tz.dstChanges("America/New_York", 2026).map(c => c.atUtc.toISOString());
  assert.deepEqual(n, ["2026-03-08T07:00:00.000Z", "2026-11-01T06:00:00.000Z"]);
  const none = tz.dstChanges("Asia/Kolkata", 2026);
  assert.equal(none.length, 0);
});

test("Asia/Kolkata keeps its half-hour offset through conversion", () => {
  assert.equal(tz.offsetMinutes(at("2026-09-10T12:00:00Z"), "Asia/Kolkata"), 330);
  assert.equal(tz.offsetLabel(330), "UTC+05:30");
  const start = tz.parseTimeIn("2026-09-10 15:00", "Europe/Warsaw");
  assert.equal(start.toISOString(), "2026-09-10T13:00:00.000Z");
  const w = tz.wallIn(start, "Asia/Kolkata");
  assert.equal(tz.timeKey(w), "18:30");
  // Kathmandu is +05:45, the quarter-hour case
  assert.equal(tz.offsetMinutes(at("2026-09-10T12:00:00Z"), "Asia/Kathmandu"), 345);
});

test("zonedToUtc round-trips across a spring-forward gap", () => {
  // 02:30 on 2026-03-29 does not exist in Warsaw; the result must be a real instant
  // and must not silently land an hour before the jump.
  const d = tz.zonedToUtc({ y: 2026, m: 3, d: 29, h: 2, mi: 30, s: 0 }, "Europe/Warsaw");
  assert.ok(!Number.isNaN(d.getTime()));
  assert.equal(d.toISOString(), "2026-03-29T01:30:00.000Z");
  assert.equal(tz.timeKey(tz.wallIn(d, "Europe/Warsaw")), "03:30");
  // a normal time round-trips exactly
  const n = tz.zonedToUtc({ y: 2026, m: 7, d: 1, h: 9, mi: 15, s: 0 }, "Europe/Warsaw");
  assert.equal(tz.timeKey(tz.wallIn(n, "Europe/Warsaw")), "09:15");
});

test("overlap math: Warsaw and New York share 2 hours of a 09:00-17:00 day", () => {
  const o = tz.overlapOnDate(
    [{ zone: "Europe/Warsaw", startMin: 540, endMin: 1020 },
     { zone: "America/New_York", startMin: 540, endMin: 1020 }],
    at("2026-09-10T12:00:00Z"),
  );
  assert.deepEqual(o, { startMin: 780, endMin: 900 });   // 13:00-15:00 UTC
  assert.equal((o.endMin - o.startMin) / 60, 2);
});

test("overlap math: on 2026-03-15 the same pair share 3 hours, not 2", () => {
  // the DST gap is one hour narrower that week, so the overlap is one hour wider
  const o = tz.overlapOnDate(
    [{ zone: "Europe/Warsaw", startMin: 540, endMin: 1020 },
     { zone: "America/New_York", startMin: 540, endMin: 1020 }],
    at("2026-03-16T12:00:00Z"),
  );
  assert.equal((o.endMin - o.startMin) / 60, 3);
});

test("overlap is null when the working days cannot meet", () => {
  const o = tz.overlapOnDate(
    [{ zone: "America/Los_Angeles", startMin: 540, endMin: 1020 },
     { zone: "Asia/Tokyo", startMin: 540, endMin: 1020 }],
    at("2026-09-10T12:00:00Z"),
  );
  assert.equal(o, null);
});

test("slot ranking puts the fairest slot first and every slot fits every window", () => {
  const parts = [
    { name: "A", zone: "Europe/Warsaw", startMin: 540, endMin: 1020 },
    { name: "B", zone: "Europe/London", startMin: 540, endMin: 1020 },
    { name: "C", zone: "America/New_York", startMin: 540, endMin: 1020 },
  ];
  const slots = tz.findSlots(parts, 60, 5, at("2026-09-07T00:00:00Z"));
  assert.ok(slots.length > 0, "expected slots for Warsaw/London/New York");
  for (const s of slots) {
    for (const p of parts) {
      const w = tz.wallIn(s.startUtc, p.zone);
      const startMin = w.h * 60 + w.mi;
      assert.ok(startMin >= p.startMin, `${p.name} starts before working hours`);
      assert.ok(startMin + 60 <= p.endMin, `${p.name} ends after working hours`);
    }
    assert.ok(["Sat", "Sun"].indexOf(tz.weekdayIn(s.startUtc, parts[0].zone)) === -1);
  }
  for (let i = 1; i < slots.length; i++) {
    assert.ok(slots[i].fairness >= slots[i - 1].fairness, "slots are not sorted by fairness");
  }
  // fairness is the WORST participant's distance from 13:00 local, not the mean
  const best = slots[0];
  const worstDev = Math.max(...best.local.map(l => {
    const [h, m] = l.start.split(":").map(Number);
    return Math.abs((h * 60 + m + 30) - 780) / 60;
  }));
  assert.equal(best.fairness, Math.round(worstDev * 100) / 100);
});

test("an impossible trio returns no slots rather than a bad one", () => {
  const parts = [
    { name: "A", zone: "America/New_York", startMin: 540, endMin: 1020 },
    { name: "B", zone: "Asia/Kolkata", startMin: 540, endMin: 1020 },
  ];
  assert.equal(tz.findSlots(parts, 60, 5, at("2026-09-07T00:00:00Z")).length, 0);
});

test("business_days excludes weekends and the holidays given", () => {
  const r = tz.businessDays("2026-09-01", "2026-09-30", "Europe/Warsaw", ["2026-09-15"]);
  assert.equal(r.total, 30);
  assert.equal(r.weekendCount, 8);
  assert.equal(r.holidayCount, 1);
  assert.equal(r.days.length, 21);
  assert.ok(!r.days.includes("2026-09-15"));
  const one = tz.businessDays("2026-09-07", "2026-09-07", "UTC");
  assert.deepEqual(one.days, ["2026-09-07"]);
});

test("ics: UTC DTSTART with Z, CRLF endings, UID present, escaping", () => {
  const text = tz.icsCreate({
    title: "Kickoff; with, Acme",
    startUtc: at("2026-09-10T13:00:00Z"),
    durationMinutes: 45,
    attendees: ["maria@acme.com"],
    description: "Line one\nline two",
    now: at("2026-09-01T00:00:00Z"),
  });
  assert.ok(text.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(text.endsWith("END:VCALENDAR\r\n"));
  assert.equal(text.split("\r\n").length - 1, text.split("\n").length - 1, "every LF must be part of a CRLF");
  const lines = text.split("\r\n");
  assert.ok(lines.includes("VERSION:2.0"));
  assert.ok(lines.includes("DTSTART:20260910T130000Z"), text);
  assert.ok(lines.includes("DTEND:20260910T134500Z"), text);
  assert.ok(lines.includes("DTSTAMP:20260901T000000Z"));
  const uid = lines.find(l => l.startsWith("UID:"));
  assert.ok(uid && uid.length > 5, "UID missing");
  assert.ok(lines.some(l => l === "SUMMARY:Kickoff\\; with\\, Acme"), text);
  assert.ok(lines.some(l => l.startsWith("DESCRIPTION:") && l.includes("\\n")));
  assert.ok(lines.some(l => l.includes("mailto:maria@acme.com")));
  assert.equal(lines.filter(l => l === "BEGIN:VEVENT").length, 1);
  assert.equal(lines.filter(l => l === "END:VEVENT").length, 1);
  assert.ok(!text.includes("VTIMEZONE"), "UTC times must need no VTIMEZONE block");
  for (const l of lines) assert.ok(Buffer.byteLength(l, "utf8") <= 75, `line over 75 octets: ${l}`);
});

test("ics folds a long summary at 75 octets with a leading-space continuation", () => {
  const text = tz.icsCreate({
    title: "x".repeat(200), startUtc: at("2026-09-10T13:00:00Z"), durationMinutes: 30,
  });
  const lines = text.split("\r\n");
  const cont = lines.filter(l => l.startsWith(" "));
  assert.ok(cont.length >= 2, "expected folded continuation lines");
  for (const l of lines) assert.ok(Buffer.byteLength(l, "utf8") <= 75);
});

test("place table: every entry resolves, cities and countries both work", () => {
  assert.equal(tz.DROPPED_PLACES.length, 0, `dropped: ${tz.DROPPED_PLACES.join(", ")}`);
  assert.ok(tz.PLACE_COUNT >= 300, `only ${tz.PLACE_COUNT} places`);
  assert.equal(tz.resolveZone("Warsaw").zone, "Europe/Warsaw");
  assert.equal(tz.resolveZone("poland").zone, "Europe/Warsaw");
  assert.equal(tz.resolveZone("New York").zone, "America/New_York");
  assert.equal(tz.resolveZone("india").zone, "Asia/Kolkata");
  assert.equal(tz.resolveZone("Asia/Kolkata").zone, "Asia/Kolkata");
  assert.equal(tz.resolveZone("PST").zone, "Etc/GMT+8");            // V4-6: fixed offset, never a DST zone
  assert.match(tz.resolveZone("PST").note, /fixed offset \(UTC-08:00\)/);
  assert.equal(tz.resolveZone("PT").zone, "America/Los_Angeles");   // the region shorthand keeps DST
  assert.equal(tz.resolveZone("UTC+2").zone, "Etc/GMT-2");   // Etc signs are inverted
  assert.equal(tz.offsetMinutes(at("2026-09-10T12:00:00Z"), "Etc/GMT-2"), 120);
});

test("an unknown place returns suggestions, never a silent wrong zone", () => {
  assert.throws(() => tz.resolveZone("Warsawa"), (e) => {
    assert.ok(e instanceof tz.UnknownZoneError);
    assert.match(e.message, /Did you mean/);
    assert.ok(e.suggestions.some(s => s.includes("Europe/Warsaw")));
    return true;
  });
  assert.throws(() => tz.resolveZone("Atlantis"), /unknown time zone or place/);
});

test("parseTimeIn: wall time, ISO with Z, and relative phrases", () => {
  assert.equal(tz.parseTimeIn("2026-09-10 15:00", "Europe/Warsaw").toISOString(), "2026-09-10T13:00:00.000Z");
  assert.equal(tz.parseTimeIn("2026-09-10T15:00", "Europe/Warsaw").toISOString(), "2026-09-10T13:00:00.000Z");
  // an explicit offset wins over from_zone
  assert.equal(tz.parseTimeIn("2026-09-10T15:00:00Z", "Europe/Warsaw").toISOString(), "2026-09-10T15:00:00.000Z");
  assert.equal(tz.parseTimeIn("2026-09-10T15:00:00+05:30", "Europe/Warsaw").toISOString(), "2026-09-10T09:30:00.000Z");
  const now = at("2026-09-10T08:00:00Z");
  assert.equal(tz.parseTimeIn("3pm tomorrow", "Europe/Warsaw", now).toISOString(), "2026-09-11T13:00:00.000Z");
  assert.equal(tz.parseTimeIn("tomorrow 3pm", "Europe/Warsaw", now).toISOString(), "2026-09-11T13:00:00.000Z");
  assert.equal(tz.parseTimeIn("3pm", "Europe/Warsaw", now).toISOString(), "2026-09-10T13:00:00.000Z");
  assert.equal(tz.parseTimeIn("09:30", "Asia/Kolkata", now).toISOString(), "2026-09-10T04:00:00.000Z");
  assert.throws(() => tz.parseTimeIn("sometime soonish", "UTC"), /not a valid time/);
});

/* ------------------------------------------------------- Codex v4 fixes */

test("V4-4: wall-clock fields are range-checked and must round-trip", () => {
  assert.throws(() => tz.assertValidWall({ y: 2026, m: 2, d: 30, h: 9, mi: 0, s: 0 }), /not a real calendar date/);
  assert.throws(() => tz.assertValidWall({ y: 2026, m: 13, d: 1, h: 0, mi: 0, s: 0 }), /out-of-range month/);
  assert.throws(() => tz.assertValidWall({ y: 2026, m: 1, d: 0, h: 0, mi: 0, s: 0 }), /out-of-range day/);
  assert.throws(() => tz.assertValidWall({ y: 2026, m: 1, d: 1, h: 24, mi: 0, s: 0 }), /out-of-range hour/);
  assert.throws(() => tz.assertValidWall({ y: 2026, m: 1, d: 1, h: 0, mi: 60, s: 0 }), /out-of-range minute/);
  assert.throws(() => tz.assertValidWall({ y: 2026, m: 1, d: 1, h: 0, mi: 0, s: 60 }), /out-of-range second/);
  assert.throws(() => tz.assertValidWall({ y: 2026, m: 1, d: 1.5, h: 0, mi: 0, s: 0 }), /out-of-range day/);
  // 2024 is a leap year, 2026 is not
  assert.ok(tz.assertValidWall({ y: 2024, m: 2, d: 29, h: 0, mi: 0, s: 0 }));
  assert.throws(() => tz.assertValidWall({ y: 2026, m: 2, d: 29, h: 0, mi: 0, s: 0 }), /has 28 days/);
  assert.throws(() => tz.parseIsoDateStrict("2026-02-30"), /not a real calendar date/);
  assert.throws(() => tz.parseIsoDateStrict("2026-2-3"), /YYYY-MM-DD/);
  assert.equal(tz.dateKey(tz.parseIsoDateStrict("2026-09-10")), "2026-09-10");
  // the whole point: no silent roll-forward into March
  assert.throws(() => tz.parseTimeIn("2026-02-30 09:00", "Europe/Warsaw"), /not a real calendar date/);
});

test("V4-5: a gap is refused with both neighbours, a fold returns the first occurrence", () => {
  const gapWall = { y: 2026, m: 3, d: 29, h: 2, mi: 30, s: 0 };
  assert.equal(tz.instantsFor(gapWall, "Europe/Warsaw").length, 0);
  assert.throws(() => tz.resolveWall(gapWall, "Europe/Warsaw"), (e) => {
    assert.match(e.message, /does not exist in Europe\/Warsaw/);
    assert.match(e.message, /2026-03-29 01:30 and 2026-03-29 03:30/);
    assert.match(e.message, /gap:"backward"/);
    assert.match(e.message, /gap:"forward"/);
    return true;
  });
  assert.equal(tz.resolveWall(gapWall, "Europe/Warsaw", { gap: "forward" }).date.toISOString(), "2026-03-29T01:30:00.000Z");
  assert.equal(tz.resolveWall(gapWall, "Europe/Warsaw", { gap: "backward" }).date.toISOString(), "2026-03-29T00:30:00.000Z");
  assert.equal(tz.resolveWall(gapWall, "Europe/Warsaw", { gap: "forward" }).kind, "gap");

  const foldWall = { y: 2026, m: 10, d: 25, h: 2, mi: 30, s: 0 };
  assert.equal(tz.instantsFor(foldWall, "Europe/Warsaw").length, 2);
  const first = tz.resolveWall(foldWall, "Europe/Warsaw");
  assert.equal(first.kind, "fold");
  assert.equal(first.date.toISOString(), "2026-10-25T00:30:00.000Z");
  assert.match(first.note, /used the first occurrence/);
  assert.match(first.note, /fold:"second"/);
  const second = tz.resolveWall(foldWall, "Europe/Warsaw", { fold: "second" });
  assert.equal(second.date.toISOString(), "2026-10-25T01:30:00.000Z");
  assert.match(second.note, /used the second occurrence/);
  // an ordinary time has exactly one instant and no note
  const plain = tz.resolveWall({ y: 2026, m: 7, d: 1, h: 9, mi: 15, s: 0 }, "Europe/Warsaw");
  assert.equal(plain.kind, "unique");
  assert.equal(plain.note, undefined);
});

test("V4-6: fixed abbreviations are fixed offsets all year", () => {
  const est = tz.resolveZone("EST");
  assert.equal(est.zone, "Etc/GMT+5");
  assert.equal(tz.offsetMinutes(at("2026-07-01T12:00:00Z"), est.zone), -300);
  assert.equal(tz.offsetMinutes(at("2026-01-01T12:00:00Z"), est.zone), -300);
  assert.equal(tz.parseTimeIn("2026-07-01 09:00", est.zone).toISOString(), "2026-07-01T14:00:00.000Z");
  assert.equal(tz.resolveZone("CET").zone, "Etc/GMT-1");
  assert.equal(tz.resolveZone("cest").zone, "Etc/GMT-2");
  assert.equal(tz.resolveZone("JST").zone, "Etc/GMT-9");
  assert.equal(tz.resolveZone("IST").zone, "Asia/Kolkata");     // +05:30 has no Etc zone; Kolkata never shifts
  assert.match(tz.resolveZone("IST").note, /Irish Standard Time/);
  assert.match(tz.resolveZone("GMT+2").note, /never follows daylight saving/);
  for (const a of ["EST", "EDT", "PST", "PDT", "CET", "CEST", "BST", "JST", "AEST", "MSK"]) {
    const z = tz.resolveZone(a).zone;
    assert.equal(tz.dstChanges(z, 2026).length, 0, `${a} -> ${z} must not observe DST`);
  }
});

test("V4-7: overlap boundaries are built from the local calendar date in each zone", () => {
  // Auckland (+12) evening meets Los Angeles (-7) early morning on the SAME local date
  const o = tz.overlapOnLocalDate(
    [{ zone: "Pacific/Auckland", startMin: 19 * 60, endMin: 23 * 60 },
     { zone: "America/Los_Angeles", startMin: 0, endMin: 6 * 60 }],
    "2026-09-10",
  );
  assert.equal(o.startUtc.toISOString(), "2026-09-10T07:00:00.000Z");
  assert.equal(o.endUtc.toISOString(), "2026-09-10T11:00:00.000Z");
  // both ends read as the requested date in both zones, not the day before
  for (const z of ["Pacific/Auckland", "America/Los_Angeles"]) {
    assert.equal(tz.dateKey(tz.wallIn(o.startUtc, z)), "2026-09-10", z);
    assert.equal(tz.dateKey(tz.wallIn(new Date(o.endUtc.getTime() - 60000), z)), "2026-09-10", z);
  }
  // Warsaw and New York on 2026-09-10: 13:00-15:00 UTC on that date, not 2026-09-09
  const wny = tz.overlapOnLocalDate(
    [{ zone: "Europe/Warsaw", startMin: 540, endMin: 1020 },
     { zone: "America/New_York", startMin: 540, endMin: 1020 }],
    "2026-09-10",
  );
  assert.equal(wny.startUtc.toISOString(), "2026-09-10T13:00:00.000Z");
  assert.equal(wny.endUtc.toISOString(), "2026-09-10T15:00:00.000Z");
  // a 09:00-17:00 day cannot meet across Auckland and Los Angeles
  assert.equal(tz.overlapOnLocalDate(
    [{ zone: "Pacific/Auckland", startMin: 540, endMin: 1020 },
     { zone: "America/Los_Angeles", startMin: 540, endMin: 1020 }], "2026-09-10"), null);
  assert.throws(() => tz.overlapOnLocalDate([{ zone: "UTC", startMin: 540, endMin: 1020 }], "2026-02-30"), /not a real calendar date/);
});

test("V4-8: no slot starts before the supplied lower-bound instant", () => {
  const parts = [{ name: "A", zone: "UTC", startMin: 540, endMin: 1020 }];
  const bound = at("2026-09-07T16:00:00Z");
  const slots = tz.findSlots(parts, 60, 1, bound);
  assert.ok(slots.length > 0, "expected slots after 16:00 UTC");
  for (const s of slots) assert.ok(s.startUtc.getTime() >= bound.getTime(), s.startUtc.toISOString());
  assert.ok(!slots.some(s => s.startUtc.toISOString() === "2026-09-07T12:30:00.000Z"), "a past slot was ranked");
  assert.equal(slots[0].startUtc.toISOString(), "2026-09-07T16:00:00.000Z");
  // midnight bound: the whole day is still searched
  assert.ok(tz.findSlots(parts, 60, 1, at("2026-09-07T00:00:00Z")).length > slots.length);
});

test("V4-9: attendees are calendar addresses, CN is a quoted parameter", () => {
  assert.throws(() => tz.calendarAddress("a@example.com\r\nORGANIZER:mailto:x@example.com"), /line break/);
  assert.throws(() => tz.calendarAddress("Tom"), /not a calendar address/);
  assert.throws(() => tz.calendarAddress("a@b"), /not a calendar address/);
  assert.deepEqual(tz.calendarAddress("mailto:Maria@acme.com"), { uri: "mailto:Maria@acme.com", cn: "Maria" });
  assert.deepEqual(tz.calendarAddress(" sara@example.com "), { uri: "mailto:sara@example.com", cn: "sara" });
  const text = tz.icsCreate({
    title: "Kickoff", startUtc: at("2026-09-10T13:00:00Z"), durationMinutes: 30,
    attendees: [{ name: "Maria Nowak", email: "maria@acme.com" }],
  });
  assert.ok(text.includes('ATTENDEE;CN="Maria Nowak";RSVP=TRUE:mailto:maria@acme.com'), text);
  // a control character anywhere is refused, not escaped away
  for (const field of ["title", "location", "description"]) {
    assert.throws(() => tz.icsCreate({
      title: "t", startUtc: at("2026-09-10T13:00:00Z"), durationMinutes: 30, [field]: "a\u0000b",
    }), /control character/, field);
  }
  assert.throws(() => tz.icsCreate({
    title: "t\r\nX-EVIL:1", startUtc: at("2026-09-10T13:00:00Z"), durationMinutes: 30,
  }), /line break/);
  // a name that cannot be a CN parameter value is refused rather than written raw
  assert.throws(() => tz.icsCreate({
    title: "t", startUtc: at("2026-09-10T13:00:00Z"), durationMinutes: 30,
    attendees: [{ name: 'He said "hi"', email: "x@acme.com" }],
  }), /double quote/);
});

test("D-R27: names without an email go in DESCRIPTION, ORGANIZER is emitted when given", () => {
  const r = tz.icsCreateDetailed({
    title: "Kickoff", startUtc: at("2026-09-10T13:00:00Z"), durationMinutes: 30,
    attendees: ["sara@example.com", "Tom", { name: "Ana" }],
    organizerEmail: "me@example.com", organizerName: "Mike",
  });
  const unfolded = r.text.replace(/\r\n /g, "");
  assert.deepEqual(r.invited, ["sara@example.com"]);
  assert.deepEqual(r.listedOnly, ["Tom", "Ana"]);
  assert.equal(r.organizer, "me@example.com");
  assert.ok(unfolded.includes('ORGANIZER;CN="Mike":mailto:me@example.com'), r.text);
  assert.ok(unfolded.includes('ATTENDEE;CN="sara";RSVP=TRUE:mailto:sara@example.com'), r.text);
  assert.ok(!/invalid:nomail/.test(r.text), r.text);
  // RFC 5545 TEXT escaping: the separating comma is written "\,"
  assert.match(unfolded, /DESCRIPTION:Also attending \(no email address was given[^\r\n]*\): Tom\\, Ana/);
  // no organizer_email: no ORGANIZER line at all, and the caller can see that
  const none = tz.icsCreateDetailed({ title: "x", startUtc: at("2026-09-10T13:00:00Z"), durationMinutes: 30 });
  assert.equal(none.organizer, undefined);
  assert.ok(!/ORGANIZER/.test(none.text));
  assert.throws(() => tz.icsCreateDetailed({
    title: "x", startUtc: at("2026-09-10T13:00:00Z"), durationMinutes: 30, attendees: [{}],
  }), /neither a name nor an email/);
});

test("D-R30: near-miss slots rank by minutes outside hours and name the hours that fit", () => {
  const parts = [
    { name: "Ana", zone: "America/Los_Angeles", startMin: 540, endMin: 1020 },
    { name: "Kenji", zone: "Asia/Tokyo", startMin: 540, endMin: 1020 },
  ];
  const first = at("2026-09-07T00:00:00Z");
  assert.equal(tz.findSlots(parts, 60, 3, first).length, 0, "this pair must not overlap at all");
  const near = tz.findNearMissSlots(parts, 60, 3, first, 30, 3);
  assert.equal(near.length, 3);
  assert.ok(near[0].outsideMinutes > 0);
  for (let i = 1; i < near.length; i++) assert.ok(near[i].outsideMinutes >= near[i - 1].outsideMinutes);
  for (const n of near) {
    assert.equal(n.local.length, 2);
    assert.equal(n.outsideMinutes, n.local.reduce((a, l) => a + l.outsideMinutes, 0));
    for (const l of n.local) {
      assert.match(l.start, /^\d\d:\d\d$/);
      assert.match(l.needStart, /^\d\d:\d\d$/);
      assert.match(l.needEnd, /^\d\d:\d\d$/);
    }
    assert.ok(n.startUtc.getTime() >= first.getTime());
  }
  // the suggested hours really do make it fit
  const widened = parts.map((p, i) => ({
    ...p,
    startMin: Number(near[0].local[i].needStart.slice(0, 2)) * 60 + Number(near[0].local[i].needStart.slice(3)),
    endMin: Number(near[0].local[i].needEnd.slice(0, 2)) * 60 + Number(near[0].local[i].needEnd.slice(3)),
  }));
  const fixed = tz.findSlots(widened, 60, 3, first);
  assert.ok(fixed.some(s => s.startUtc.getTime() === near[0].startUtc.getTime()),
    `widening to the named hours must make ${near[0].startUtc.toISOString()} fit`);
});
