// Reference costs, worked out independently of the card's code from the fake world's price specs: which product applies when, and
// what a reading costs (unit price per half hour x kWh, plus the standing charge per day pro rata).
import {DAY, TRACKER, SIGNUP, product, priceAt, readings, historyStart} from './world.mjs';

const addMonths = (t, n) => { const x = new Date(t); x.setMonth(x.getMonth() + n); return x.getTime(); };  // Node runs in Europe/London

// Product code in force at t for tariff key K. `signup`: the fixed-tariff sign-up date on record (null: unknown, use today's fix).
// `dataStart`: start of the user's recorded usage (the fix's presumed sign-up is the term that covers it).
export const productAt = (K, t, {signup, dataStart}) => {
  if (K === 'VAR') return 'VAR-22-11-01';
  if (K === 'AGILE') return 'AGILE-24-01-01';
  if (K === 'SILVER') return TRACKER.find(([, f, e]) => f <= t && (e === null || t < e))?.[0];
  if (K === 'COSY-FIX-12M') return 'COSY-FIX-12M-26-03-23';
  const onSale = (x) => ({'OE-FIX-12M': ['OE-FIX-12M-24-01-01', 'OE-FIX-12M-25-02-01', 'OE-FIX-12M-25-09-01', 'OE-FIX-12M-26-05-18'],
    'OE-FIX-18M': ['OE-FIX-18M-26-08-01']}[K].map(product).find((p) => p.from <= x && (p.to == null || x < p.to))?.code);
  if (signup === null) return onSale(Date.now());
  // Term containing t on the 12-month grid through the sign-up date.
  let p = signup;
  while (p > t) p = addMonths(p, -12);
  while (addMonths(p, 12) <= t) p = addMonths(p, 12);
  void dataStart;
  return onSale(p);
};

// Cost in GBP of the readings ending in (a, b] for `fuel` on tariff K, or null if any reading has no product.
export const cost = (scenario, fuel, K, a, b, {signup = SIGNUP} = {}) => {
  const rows = readings(fuel, historyStart(scenario), 0);
  const dataStart = rows[0][0];
  let pence = 0;
  for (const [s, e, kwh] of rows) {
    if (!(e > a && e <= b)) continue;
    const code = productAt(K, s, {signup, dataStart});
    const p = code && product(code);
    if (!p?.[fuel]) return null;
    // Unit price: each half hour of the reading at its own price (readings are 5 minutes or an hour, aligned to the clock).
    const halves = Math.max(1, Math.round((e - s) / 18e5));
    for (let i = 0; i < halves; i++) pence += priceAt(p, p[fuel].unit, s + (i + 0.5) * (e - s) / halves) * kwh / halves;
    pence += priceAt(p, p[fuel].standing, (s + e) / 2) * (e - s) / DAY;
  }
  return pence / 100;
};
