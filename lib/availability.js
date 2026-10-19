// Deterministic availability generator for the prototype.
//
// Both the search-results page (suggested times) and the full clinic
// availability page are derived from a single hourly model so they always
// agree: the FULL availability for a day is every hourly slot within the
// clinic's opening hours, and the SUGGESTED times shown on the results page
// are a deterministic subset of those same hours. This guarantees that for
// any day shown on both pages, the full page includes the suggested options
// (plus additional ones).
const DAY_MS = 24 * 60 * 60 * 1000;

// Hours considered "standard" — anything outside this range is "fringe"
// (early morning before 9am, or late afternoon/evening from 5pm onwards).
const STANDARD_START = 9;
const STANDARD_END = 17;

function hashStringToSeed(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function() {
    var t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
}

// Parse a free-text opening hours string into integer open/close hours (24h).
// Falls back to 9am-5pm when the string can't be understood (e.g. walk-in).
function parseOpeningHours(openingHours) {
  const m = /(\d{1,2})(?::\d{2})?\s*(am|pm)\b.*?(\d{1,2})(?::\d{2})?\s*(am|pm)\b/i.exec(openingHours || '');
  if (!m) return { open: 9, close: 17 };
  let open = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[2])) open += 12;
  let close = parseInt(m[3], 10) % 12;
  if (/pm/i.test(m[4])) close += 12;
  if (close <= open) return { open: 9, close: 17 };
  return { open, close };
}

// Format an integer hour (0-23) as a 12-hour label per NHS style, e.g. 9 -> "9am", 0 -> "midnight", 12 -> "midday".
function formatHour(h) {
  if (h === 0 || h === 24) return 'midnight';
  if (h === 12) return 'midday';
  const period = h < 12 ? 'am' : 'pm';
  const hour = h % 12;
  return `${hour}${period}`;
}

const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Calendar metadata for the day that is `dayOffset` days from today.
function dayMeta(dayOffset) {
  const d = new Date(Date.now() + dayOffset * DAY_MS);
  return {
    index: dayOffset,
    weekday: WEEKDAYS_SHORT[d.getDay()],
    day: d.getDate(),
    month: MONTHS_LONG[d.getMonth()],
    monthYear: `${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`,
    dateLabel: `${WEEKDAYS_LONG[d.getDay()]} ${d.getDate()} ${MONTHS_LONG[d.getMonth()]}`,
    iso: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  };
}

// Every bookable hour for a clinic on any day (the full availability set).
function fullDayHours(open, close) {
  const hours = [];
  for (let h = open; h < close; h++) hours.push(h);
  return hours;
}

// Remove the very first and last hour from a pool — applied to the closest
// clinic so it never shows the next available earliest or latest time.
function stripFirstAndLast(hours) {
  if (hours.length <= 2) return hours;
  return hours.slice(1, -1);
}

// Deterministic subset of the full hours, used for the "suggested" times.
// Always a subset of fullDayHours(open, close), so the full availability
// page is guaranteed to contain every suggested option for the same day.
//
// clinicIndex: position in the results list (0 = closest to postcode).
// Availability lead-time rules:
//   All clinics: no same-day slots (dayOffset 0 always empty).
//   Closest clinic (index 0): no next-day slots either (dayOffset 1 also empty).
// Day profile rules (dayOffset 1–4 for non-closest; 2–4 for closest):
//   first available → fewer than 6 slots, standard hours only
//   +1 → 6 slots, 0–1 fringe
//   +2 → 6 slots, 2–3 fringe
//   +3 → 6 slots, 4–5 fringe
// Closest clinic additionally never shows the opening or closing hour.
function suggestedHoursForDay(key, clinicId, open, close, dayOffset, clinicIndex) {
  let all = fullDayHours(open, close);
  if (!all.length) return [];

  if (clinicIndex === 0) all = stripFirstAndLast(all);
  if (!all.length) return [];

  // No same-day availability for any clinic.
  if (dayOffset === 0) return [];
  // Closest clinic requires at least 2 days lead time.
  if (dayOffset === 1 && clinicIndex === 0) return [];

  const rng = mulberry32(hashStringToSeed(`${key || 'DEFAULT'}|${clinicId}|${dayOffset}`));

  // First available day: fewer than 6 slots, standard hours only.
  // For non-closest clinics this is dayOffset 1; for closest it is dayOffset 2.
  const firstAvailable = clinicIndex === 0 ? 2 : 1;
  if (dayOffset === firstAvailable) {
    const standard = all.filter(h => h >= 11 && h <= 14);
    const pool = (standard.length ? standard : all).slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const count = 2 + Math.floor(rng() * 4); // 2, 3, 4, or 5
    return pool.slice(0, Math.min(count, pool.length)).sort((a, b) => a - b);
  }

  const standard = all.filter(h => h >= STANDARD_START && h < STANDARD_END);
  // Evening hours only appear from 3 days past firstAvailable — in earlier days
  // fringe is early-morning only so extended-hours clinics don't show evening too soon.
  const fringeThreshold = firstAvailable + 3;
  const fringe = dayOffset < fringeThreshold
    ? all.filter(h => h < STANDARD_START)
    : all.filter(h => h < STANDARD_START || h >= STANDARD_END);

  // Pick a target fringe count for this day, then fill the rest from standard.
  const relDay = dayOffset - firstAvailable;
  let targetFringe;
  if (relDay === 1) {
    targetFringe = 0;
  } else if (dayOffset === 2) {
    targetFringe = Math.floor(rng() * 2); // 0 or 1
  } else if (relDay === 2) {
    targetFringe = 2 + Math.floor(rng() * 2); // 2 or 3
  } else {
    targetFringe = 4 + Math.floor(rng() * 2); // 4 or 5
  }

  const pickedFringe = Math.min(targetFringe, fringe.length);
  const pickedStandard = Math.min(6 - pickedFringe, standard.length);

  const sf = fringe.slice();
  for (let i = sf.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [sf[i], sf[j]] = [sf[j], sf[i]];
  }

  const ss = standard.slice();
  for (let i = ss.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [ss[i], ss[j]] = [ss[j], ss[i]];
  }

  return [
    ...sf.slice(0, pickedFringe),
    ...ss.slice(0, pickedStandard)
  ].sort((a, b) => a - b);
}

// Suggested times for the search-results page.
// Returns pages (up to 10 days) for days that have at least one slot.
// clinicIndex: 0 = closest clinic (applies the NEVER rule for first/last hour).
function generateTimes(postcodeKey, clinicId, openingHours, clinicIndex) {
  const { open, close } = parseOpeningHours(openingHours);
  const pages = [];
  for (let p = 0; p < 10; p++) {
    const meta = dayMeta(p);
    const hours = suggestedHoursForDay(postcodeKey, clinicId, open, close, p, clinicIndex);
    if (hours.length > 0) {
      pages.push({ dateLabel: meta.dateLabel, slots: hours.map(formatHour) });
    }
  }
  return pages;
}

// Full availability for the clinic detail page.
// Returns `numDays` day objects, each with calendar metadata and slots
// grouped into morning / afternoon / evening. Each slot is a start-finish
// range, e.g. { start: "9am", finish: "10am", label: "9am - 10am" }.
// clinicIndex: position in the results list (0 = closest). Drives the NEVER
// rule (strips opening/closing hour for index 0) and same-day availability
// (index >= 2 has no day-0 slots, matching the results page behaviour).
function generateFullAvailability(postcodeKey, clinicId, openingHours, numDays, clinicIndex) {
  numDays = numDays || 14;
  const { open, close } = parseOpeningHours(openingHours);
  const allHoursUnstripped = fullDayHours(open, close);
  let allDayHours = allHoursUnstripped.slice();
  if (clinicIndex === 0) allDayHours = stripFirstAndLast(allDayHours);

  const firstAvailable = clinicIndex === 0 ? 2 : 1;
  const days = [];
  for (let p = 0; p < numDays; p++) {
    const meta = dayMeta(p);
    // Days up to firstAvailable: routed through suggestedHoursForDay so
    //   lead-time and < 6 slot rules match the results page exactly.
    // Days firstAvailable+1 to 3: morning only (10am–11am), no early morning or lunchtime.
    // Days 4–5: standard daytime from 10am (no early morning).
    // Day 6+: full hours including early morning, with ~40% of days also getting 1–2 evening slots.
    let dayHours;
    if (p <= firstAvailable) {
      dayHours = suggestedHoursForDay(postcodeKey, clinicId, open, close, p, clinicIndex);
    } else if (p <= 3 || p < 6) {
      // Mostly from 10am, but each clinic/day gets its own earliest start (the
      // odd 8am or 9am) so the "Earliest appointment" order differs from "Closest".
      const rng = mulberry32(hashStringToSeed(`${postcodeKey}|${clinicId}|start|${p}`));
      const start = [8, 9, 10, 10, 11][Math.floor(rng() * 5)];
      const end = p <= 3 ? 12 : STANDARD_END;
      dayHours = allDayHours.filter(h => h >= start && h < end);
      if (!dayHours.length) dayHours = allDayHours.filter(h => h >= 10 && h < end);
    } else {
      const standardHours = allDayHours.filter(h => h < STANDARD_END);
      const eveningAvail = allHoursUnstripped.filter(h => h >= STANDARD_END);
      if (eveningAvail.length) {
        const rng = mulberry32(hashStringToSeed(`${postcodeKey}|${clinicId}|eve|${p}`));
        if (rng() <= 0.4) {
          const numEvening = rng() < 0.5 ? 1 : Math.min(2, eveningAvail.length);
          dayHours = [...standardHours, ...eveningAvail.slice(0, numEvening)];
        } else {
          dayHours = standardHours;
        }
      } else {
        dayHours = standardHours;
      }
    }
    const morning = [];
    const afternoon = [];
    const evening = [];
    dayHours.forEach((h) => {
      const slot = {
        start: formatHour(h),
        finish: formatHour(h + 1),
        label: `${formatHour(h)} - ${formatHour(h + 1)}`
      };
      if (h < 12) morning.push(slot);
      else if (h < 17) afternoon.push(slot);
      else evening.push(slot);
    });
    days.push({
      index: meta.index,
      weekday: meta.weekday,
      day: meta.day,
      month: meta.month,
      monthYear: meta.monthYear,
      dateLabel: meta.dateLabel,
      iso: meta.iso,
      morning,
      afternoon,
      evening,
      hasSlots: morning.length + afternoon.length + evening.length > 0
    });
  }
  return days;
}

module.exports = { generateTimes, generateFullAvailability, parseOpeningHours };
