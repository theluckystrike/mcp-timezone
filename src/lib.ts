/**
 * The time-zone and .ics engine, as a stable public API for other servers in this repo.
 *
 * `src/index.ts` is the MCP server (tools, licensing, storage). Everything below it --
 * zone resolution on ICU data, wall-clock arithmetic, the DST gap/fold resolver, the
 * RFC 5545 writer and the corrupt-data quarantine store -- is generic and is
 * re-exported here so a sibling server (servers/calendar) can read and write calendar
 * files without a second copy of the code.
 *
 * Nothing in this module touches the filesystem, the network or the licence store at
 * import time.
 *
 * Stability: the names below are the contract. `src/*.js` deep imports are not.
 */

/* --------------------------------------------------------- zone resolution */
export type { PlaceTable, ZoneHit } from "./tz.js";
export {
  DROPPED_PLACES, PLACE_COUNT, UnknownZoneError,
  allZones, buildPlaceTable, clip, isValidZone, resolveZone,
} from "./tz.js";

/* ---------------------------------------------------- wall-clock arithmetic */
export type { FoldPolicy, GapPolicy, Wall, WallPolicy, WallResolved } from "./tz.js";
export {
  assertValidWall, dateKey, describe, hhmmToMinutes, instantsFor, offsetLabel, offsetMinutes,
  parseIsoDateStrict, resolveWall, timeKey, utcFromWall, wallIn, weekdayIn, zoneAbbrev, zonedToUtc,
} from "./tz.js";

/* ------------------------------------------------------------- time parsing */
export type { ParsedTime } from "./tz.js";
export { parseTimeIn, parseTimeInDetailed } from "./tz.js";

/* ------------------------------------------------------------ DST and spans */
export type { DstChange } from "./tz.js";
export { MAX_BUSINESS_DAY_SPAN, businessDays, dstChanges } from "./tz.js";

/* ---------------------------------------------------- overlaps and meetings */
export type { LocalOverlap, NearMiss, NearMissLocal, Participant, Slot, WorkWindow } from "./tz.js";
export { findNearMissSlots, findSlots, overlapOnDate, overlapOnLocalDate } from "./tz.js";

/* --------------------------------------------------------- the .ics writer */
export type { AttendeeInput, IcsInput, IcsResult } from "./tz.js";
export { calendarAddress, icsCreate, icsCreateDetailed, icsStamp } from "./tz.js";

/* --------------------------------------------- corrupt-data quarantine store */
export { CorruptDataError, markerBody, markerPath, readJsonFile } from "./jsonstore.js";
