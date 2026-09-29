// A fake world for the tests: Octopus products with known prices, and a Home Assistant install with known usage. The same
// definitions drive the fake Octopus API (tests/fake/octopus-api.mjs), the fake Home Assistant in the page (tests/page.html), and
// the independent reference costs the tests compare the card's figures with (tests/fake/reference.mjs).
//
// All times are ms since the epoch. "Local" means Europe/London, the time zone the tests run the browser (and Node) in.

export const DAY = 864e5, HOUR = 36e5;
export const NOW = Date.parse('2026-09-29T12:00:00Z');
export const REGION = 'H';

const iso = (t) => new Date(t).toISOString();
const d = (s) => Date.parse(s);

// Local wall-clock pieces of t (Europe/London), without depending on the process time zone.
const fmt = new Intl.DateTimeFormat('en-GB', {timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
export const local = (t) => {
  const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return {y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute};
};
// Start of the local day containing t.
export const localDayStart = (t) => {
  const {h, mi} = local(t);
  let s = t - (h * 60 + mi) * 6e4;
  s -= s % 6e4;
  // Around a clock change the wall-clock arithmetic can be an hour out: step until local midnight.
  while (local(s).h !== 0 || local(s).mi !== 0) s += local(s).h >= 12 ? HOUR : -HOUR;
  return s;
};
const nextLocalDay = (t) => localDayStart(localDayStart(t) + 36 * HOUR);

// ---------- products ----------
// unit / standing price specs (pence inc VAT):
//   {segs: [[from, to|null, value, payment?]]}        flat prices over periods (payment: 'DIRECT_DEBIT' | 'NON_DIRECT_DEBIT' | null)
//   {halfHourly: (slotStart) => value}                a price per UTC half hour (Agile style)
//   {tou: [[startMin, endMin, value]]}                the same local-time pattern every local day (Cosy style)
//   {daily: (localDayStart) => value}                 one price per local day (Tracker style)
// Unit rates that change by time are published up to the end of the next local day after NOW.
const flat = (v, from) => ({segs: [[from, null, v]]});

const fix = (code, name, from, to, e, g) => ({
  code, name, variable: false, term: 12, from, to,
  electricity: {unit: flat(e[0], from), standing: flat(e[1], from)},
  gas: g && {unit: flat(g[0], from), standing: flat(g[1], from)},
});

const TRACKER_DATES = [
  ['SILVER-FLEX-22-11-25', '2022-11-25T00:00:00Z', '2023-12-11T12:00:00Z'],
  ['SILVER-23-12-06', '2023-12-11T12:00:00Z', '2024-04-03T00:00:00+01:00'],
  ['SILVER-24-04-03', '2024-04-03T00:00:00+01:00', '2024-07-01T00:00:00+01:00'],
  ['SILVER-24-07-01', '2024-07-01T00:00:00+01:00', '2024-10-01T00:00:00+01:00'],
  ['SILVER-24-10-01', '2024-10-01T00:00:00+01:00', '2024-12-31T00:00:00Z'],
  ['SILVER-24-12-31', '2024-12-31T00:00:00Z', '2025-04-11T00:00:00+01:00'],
  ['SILVER-25-04-11', '2025-04-11T00:00:00+01:00', '2025-04-15T00:00:00+01:00'],
  ['SILVER-25-04-15', '2025-04-15T00:00:00+01:00', '2025-09-02T00:00:00+01:00'],
  ['SILVER-25-09-02', '2025-09-02T00:00:00+01:00', '2026-04-01T00:00:00+01:00'],
  ['SILVER-26-04-01', '2026-04-01T00:00:00+01:00', null],
];
export const TRACKER = TRACKER_DATES.map(([code, from, to]) => [code, d(from), to ? d(to) : null]);

export const PRODUCTS = [
  {code: 'VAR-22-11-01', name: 'Flexible Octopus', variable: true, from: d('2022-11-01T00:00:00Z'),
    electricity: {unit: {segs: [[d('2022-11-01T00:00:00Z'), d('2026-04-01T00:00:00+01:00'), 24.5], [d('2026-04-01T00:00:00+01:00'), null, 22]]},
      standing: {segs: [[d('2022-11-01T00:00:00Z'), d('2026-04-01T00:00:00+01:00'), 50, 'DIRECT_DEBIT'],
        [d('2022-11-01T00:00:00Z'), d('2026-04-01T00:00:00+01:00'), 70, 'NON_DIRECT_DEBIT'],
        [d('2026-04-01T00:00:00+01:00'), null, 52, 'DIRECT_DEBIT'], [d('2026-04-01T00:00:00+01:00'), null, 72, 'NON_DIRECT_DEBIT']]}},
    gas: {unit: {segs: [[d('2022-11-01T00:00:00Z'), d('2026-04-01T00:00:00+01:00'), 6.2], [d('2026-04-01T00:00:00+01:00'), null, 5.6]]},
      standing: flat(31, d('2022-11-01T00:00:00Z'))}},
  {code: 'AGILE-24-01-01', name: 'Agile Octopus', variable: true, from: d('2024-01-01T00:00:00Z'),
    electricity: {unit: {halfHourly: (t) => 10 + ((t / 18e5) % 48) / 2}, standing: flat(45, d('2024-01-01T00:00:00Z'))}},
  {code: 'COSY-FIX-12M-26-03-23', name: 'Cosy Octopus 12M Fixed', variable: false, term: 12, from: d('2026-03-23T00:00:00Z'),
    electricity: {unit: {tou: [[0, 240, 12], [240, 780, 25], [780, 960, 12], [960, 1140, 35], [1140, 1320, 25], [1320, 1440, 12]]},
      standing: flat(48, d('2026-03-23T00:00:00Z'))}},
  fix('OE-FIX-12M-24-01-01', 'Octopus 12M Fixed', d('2024-01-01T00:00:00Z'), d('2025-02-01T00:00:00Z'), [20, 40], [5, 25]),
  fix('OE-FIX-12M-25-02-01', 'Octopus 12M Fixed', d('2025-02-01T00:00:00Z'), d('2025-09-01T00:00:00Z'), [21, 41], [5.2, 26]),
  fix('OE-FIX-12M-25-09-01', 'Octopus 12M Fixed', d('2025-09-01T00:00:00Z'), d('2026-05-20T16:30:00Z'), [22, 42], [5.4, 27]),
  fix('OE-FIX-12M-26-05-18', 'Octopus 12M Fixed', d('2026-05-20T16:30:00Z'), null, [23, 43], [5.6, 28]),
  // Only on sale from August 2026: after the user's agreement began, so it cannot be priced from their sign-up date.
  fix('OE-FIX-18M-26-08-01', 'Octopus 18M Fixed', d('2026-08-01T00:00:00Z'), null, [19, 39], [4.9, 24]),
  // Tracker: not in the products list (as on the real API), only reachable by code.
  ...TRACKER.map(([code, from, to], i) => ({code, name: 'Octopus Tracker', variable: true, from, to, unlisted: true,
    electricity: {unit: {daily: (day) => 18 + i / 2 + (local(day).d % 7)}, standing: flat(40 + i, from)},
    gas: {unit: {daily: (day) => 5 + i / 10 + (local(day).d % 3) / 10}, standing: flat(28, from)}})),
];
export const product = (code) => PRODUCTS.find((p) => p.code === code);

// Price entries a spec publishes overlapping [a, b), newest first, as the API returns them.
const PUBLISHED_UNTIL = nextLocalDay(nextLocalDay(NOW));
export const entries = (p, spec, a, b) => {
  const out = [];
  const add = (f, t, v, pm = null) => out.push({value_exc_vat: +(v / 1.05).toFixed(4), value_inc_vat: v, valid_from: iso(f), valid_to: t === null ? null : iso(t), payment_method: pm});
  const lo = Math.max(a, p.from), hi = Math.min(b, p.to ?? Infinity, PUBLISHED_UNTIL);
  if (spec.segs) {
    for (const [f, t, v, pm] of spec.segs) if (f < b && (t === null || t > a)) add(f, t, v, pm);
  } else if (spec.halfHourly) {
    for (let s = Math.floor(lo / 18e5) * 18e5; s < hi; s += 18e5) add(s, s + 18e5, spec.halfHourly(s));
  } else if (spec.tou) {
    for (let day = localDayStart(lo); day < hi; day = nextLocalDay(day)) {
      for (const [m0, m1, v] of spec.tou) {
        const s = day + m0 * 6e4, e = m1 === 1440 ? nextLocalDay(day) : day + m1 * 6e4;  // no clock changes inside the test periods' slots
        if (s < hi && e > lo) add(s, e, v);
      }
    }
  } else if (spec.daily) {
    for (let day = localDayStart(lo); day < hi; day = nextLocalDay(day)) add(day, nextLocalDay(day), spec.daily(day));
  }
  return out.sort((x, y) => Date.parse(y.valid_from) - Date.parse(x.valid_from));
};

// Price in force at t (direct debit), straight from the spec, for the reference costs.
// Flat (segs) prices of a fix go on being published after the fix stops being sold, as on the real API.
export const priceAt = (p, spec, t) => {
  if (!spec.segs && (t < p.from || t >= (p.to ?? Infinity))) return null;
  if (spec.segs) {
    const s = spec.segs.find(([f, e, , pm]) => f <= t && (e === null || t < e) && (!pm || pm === 'DIRECT_DEBIT'));
    return s ? s[2] : null;
  }
  if (spec.halfHourly) return spec.halfHourly(Math.floor(t / 18e5) * 18e5);
  if (spec.tou) { const {h, mi} = local(t), m = h * 60 + mi; return spec.tou.find(([a, b]) => a <= m && m < b)[2]; }
  if (spec.daily) return spec.daily(localDayStart(t));
  return null;
};

// ---------- Home Assistant ----------
// Usage per hour (kWh) by fuel; 5-minute readings are a twelfth of the hour's.
export const kwhPerHour = (fuel, t) => {
  const h = new Date(t).getUTCHours();
  return fuel === 'gas' ? 0.8 + (h >= 6 && h < 9 ? 0.4 : 0) : 0.3 + (h >= 16 && h < 20 ? 0.5 : 0);
};
const FIVE_MIN_DAYS = 10;
const FIVE = 3e5;
export const TOTAL_REGISTER = 12345.678;  // the oldest 5-minute row reports the meter's whole register as its change, as HA does

// Recorder statistics as HA returns them: hourly rows for completed hours since `historyStart`, and 5-minute rows for the last
// FIVE_MIN_DAYS days (the first of which carries the meter total).
export const statistics = (fuel, historyStart, period, start, end) => {
  const rows = [];
  if (period === 'hour') {
    for (let s = Math.ceil(historyStart / HOUR) * HOUR; s + HOUR <= NOW; s += HOUR) rows.push({start: s, end: s + HOUR, change: kwhPerHour(fuel, s)});
  } else {
    const first = Math.ceil((NOW - FIVE_MIN_DAYS * DAY + 7 * 6e4) / FIVE) * FIVE;  // deliberately not on the hour
    for (let s = first; s + FIVE <= NOW; s += FIVE) rows.push({start: s, end: s + FIVE, change: s === first ? TOTAL_REGISTER : kwhPerHour(fuel, s) / 12});
  }
  return rows.filter((r) => r.start >= start && r.start < end);
};

// The readings the card should end up using: hourly rows until the first whole-hour 5-minute row, 5-minute rows after.
export const readings = (fuel, historyStart, from) => {
  const five = statistics(fuel, historyStart, '5minute', from, NOW);
  const i = five.findIndex((r, j) => j > 0 && r.start % HOUR === 0);
  const f5 = five.slice(i);
  return [...statistics(fuel, historyStart, 'hour', from, NOW).filter((r) => r.end <= f5[0].start), ...f5].map((r) => [r.start, r.end, r.change]);
};

// Scenarios: how much history there is, whether the user is an admin (can read the agreements), which fuels they have.
export const SIGNUP = d('2026-05-26T23:00:00Z');
export const SCENARIOS = {
  short: {days: 10, admin: true, fuels: ['electricity', 'gas']},
  long: {days: 730, admin: true, fuels: ['electricity', 'gas'], config: {history_days: 730}},
  nonadmin: {days: 10, admin: false, fuels: ['electricity', 'gas']},
  electricityOnly: {days: 10, admin: true, fuels: ['electricity']},
};
export const historyStart = (s) => NOW - s.days * DAY;
export const TARIFF = {electricity: `E-1R-VAR-22-11-01-${REGION}`, gas: `G-1R-VAR-22-11-01-${REGION}`};
