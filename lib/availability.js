// Deterministic availability generator for the prototype.
//
// Rules (universal - the same for every clinic and postcode):
//  - Every clinic has a capacity of 60 slots a day: 8am to 6pm in 10 minute
//    steps (8am, 8.10am ... 5.50pm). No clinic ever shows more than 60.
//  - "Popular" times are 9am and earlier and 5pm and later. They are picked
//    far less often than other times, and weekends have fewer slots overall.
//  - The clinic with the soonest popular time is never the closest clinic.
//  - The first date is mixed between clinics, and the closest clinic never has
//    the earliest date.
//  - Every clinic's first available date is 2 or 3 days from today (never
//    today or tomorrow). That first date counts as "day 1" below.
//  - How many of the 60 slots appear on a day depends on how many days it is
//    from the clinic's first date (see DAY_RANGES), so availability grows the
//    further ahead you look.
//
// Both the results page and the clinic page read from generateFullAvailability
// so they always agree. The same inputs always give the same times.
const DAY_MS = 24 * 60 * 60 * 1000;

const SLOT_STEP = 10;
const FIRST_SLOT = 8 * 60;  // 8am
const LAST_SLOT = 17 * 60 + 50; // 5.50pm
const CAPACITY = 60;

// Popular = 9am and earlier, or 5pm and later
const POPULAR_UNTIL = 9 * 60;
const POPULAR_FROM = 17 * 60;

// Share of capacity [min, max] in percent, indexed by day number
// (1 = the clinic's first available date)
const DAY_RANGES = {
  1: [5, 10],
  2: [10, 15],
  3: [15, 20],
  4: [20, 25],
  5: [25, 40],
  6: [30, 55],
  7: [50, 75],
  8: [60, 80],
  9: [75, 85],
  10: [90, 95]
};
const DEFAULT_RANGE = [95, 100]; // day 11 and beyond

const WEEKEND_FACTOR = 0.5;      // weekends have about half the slots
const POPULAR_WEIGHT = 0.3;      // chance weight of a popular time (others = 1)
const WEEKEND_POPULAR_WEIGHT = 0.15;

// The closest clinic gets no popular times in its first days, and the clinic
// with the earliest date is guaranteed one inside the same window, so the
// soonest popular time is never at the closest clinic.
const CLOSEST_NO_POPULAR_UNTIL_DAY = 4;

// First available date, in days from today, handed out across a postcode's
// clinics: 2 or 3 only (never tomorrow, never later than 3 days away).
// Results lists have 5 clinics: three start on day 2 and two on day 3.
const FIRST_DAYS = [2, 2, 2, 3, 3];
const EARLIEST_FIRST_DAY = 2;

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

// Kept for callers that pass a clinic's opening hours; slots no longer depend
// on them (every clinic uses the universal 8am-6pm model).
function parseOpeningHours() {
  return { open: 8, close: 18 };
}

// Minutes after midnight -> "8am", "8.10am", "midday", "12.10pm", "5pm", "5.10pm"
function formatTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 12 && m === 0) return 'midday';
  const period = h < 12 ? 'am' : 'pm';
  const hour = h % 12 || 12;
  return m ? `${hour}.${String(m).padStart(2, '0')}${period}` : `${hour}${period}`;
}

function isPopular(mins) {
  return mins <= POPULAR_UNTIL || mins >= POPULAR_FROM;
}

const ALL_SLOTS = [];
for (let t = FIRST_SLOT; t <= LAST_SLOT; t += SLOT_STEP) ALL_SLOTS.push(t);

const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Calendar metadata for the day that is `dayOffset` days from today.
function dayMeta(dayOffset) {
  const d = new Date(Date.now() + dayOffset * DAY_MS);
  return {
    index: dayOffset,
    dow: d.getDay(),
    weekday: WEEKDAYS_SHORT[d.getDay()],
    day: d.getDate(),
    month: MONTHS_LONG[d.getMonth()],
    monthYear: `${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`,
    dateLabel: `${WEEKDAYS_LONG[d.getDay()]} ${d.getDate()} ${MONTHS_LONG[d.getMonth()]}`,
    iso: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  };
}

// The first day this clinic has any slots. The days are shuffled per postcode
// (so they differ from postcode to postcode), and the closest clinic (index 0)
// never gets the earliest one (it always starts on day 3).
function firstDayFor(key, clinicIndex) {
  const days = FIRST_DAYS.slice();
  const rng = mulberry32(hashStringToSeed(`${key || 'DEFAULT'}|firstday`));
  for (let i = days.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [days[i], days[j]] = [days[j], days[i]];
  }
  if (days[0] === EARLIEST_FIRST_DAY) {
    const swap = days.findIndex(d => d !== EARLIEST_FIRST_DAY);
    [days[0], days[swap]] = [days[swap], days[0]];
  }
  return days[clinicIndex % days.length];
}

// Slot start times (minutes) for one clinic on one day, sorted.
function slotsForDay(key, clinicId, dayOffset, dow, clinicIndex) {
  const firstDay = firstDayFor(key, clinicIndex);
  if (dayOffset < firstDay) return [];

  const rng = mulberry32(hashStringToSeed(`${key || 'DEFAULT'}|${clinicId}|${dayOffset}`));
  const dayNumber = dayOffset - firstDay + 1;
  const [lo, hi] = DAY_RANGES[dayNumber] || DEFAULT_RANGE;
  const isWeekend = dow === 0 || dow === 6;

  let count = Math.round(CAPACITY * (lo + rng() * (hi - lo)) / 100);
  if (isWeekend) count = Math.round(count * WEEKEND_FACTOR);
  count = Math.max(1, Math.min(CAPACITY, count));

  const closest = clinicIndex === 0;
  const popularWeight = isWeekend ? WEEKEND_POPULAR_WEIGHT : POPULAR_WEIGHT;
  const pool = ALL_SLOTS.filter(t => !(closest && dayOffset <= CLOSEST_NO_POPULAR_UNTIL_DAY && isPopular(t)));

  // Weighted random pick without replacement (popular times are less likely)
  const picked = pool
    .map(t => ({ t, k: Math.pow(rng(), 1 / (isPopular(t) ? popularWeight : 1)) }))
    .sort((a, b) => b.k - a.k)
    .slice(0, count)
    .map(x => x.t);

  // Clinics with the earliest date always have a popular time within the
  // closest clinic's no-popular window, so the soonest popular time is never
  // the closest clinic.
  if (firstDay === EARLIEST_FIRST_DAY) {
    const grng = mulberry32(hashStringToSeed(`${key || 'DEFAULT'}|${clinicId}|popular`));
    const guaranteeDay = firstDay + Math.floor(grng() * (CLOSEST_NO_POPULAR_UNTIL_DAY - firstDay + 1));
    if (dayOffset === guaranteeDay && !picked.some(isPopular)) {
      const popular = ALL_SLOTS.filter(isPopular);
      picked[picked.length - 1] = popular[Math.floor(grng() * popular.length)];
    }
  }

  return Array.from(new Set(picked)).sort((a, b) => a - b);
}

// Full availability for the clinic pages. Returns `numDays` day objects, each
// with calendar metadata and slots grouped into morning / afternoon / evening.
// Each slot is { start: "8.10am", finish: "8.20am", label: "8.10am - 8.20am" }.
// clinicIndex: position in the results list (0 = closest).
function generateFullAvailability(postcodeKey, clinicId, openingHours, numDays, clinicIndex) {
  numDays = numDays || 14;
  const days = [];
  for (let p = 0; p < numDays; p++) {
    const meta = dayMeta(p);
    const times = slotsForDay(postcodeKey, clinicId, p, meta.dow, clinicIndex);
    const morning = [];
    const afternoon = [];
    const evening = [];
    times.forEach((t) => {
      const slot = {
        start: formatTime(t),
        finish: formatTime(t + SLOT_STEP),
        label: `${formatTime(t)} - ${formatTime(t + SLOT_STEP)}`
      };
      if (t < 12 * 60) morning.push(slot);
      else if (t < 17 * 60) afternoon.push(slot);
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
      hasSlots: times.length > 0
    });
  }
  return days;
}

// Suggested times (first 10 days with availability), from the same model.
function generateTimes(postcodeKey, clinicId, openingHours, clinicIndex) {
  return generateFullAvailability(postcodeKey, clinicId, openingHours, 10, clinicIndex)
    .filter(d => d.hasSlots)
    .map(d => ({ dateLabel: d.dateLabel, slots: [...d.morning, ...d.afternoon, ...d.evening].map(s => s.start) }));
}

module.exports = { generateTimes, generateFullAvailability, parseOpeningHours, formatTime, isPopular, CAPACITY };
