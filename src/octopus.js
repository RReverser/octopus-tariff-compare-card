// Octopus Energy cost engine: prices your metered usage (Home Assistant long-term statistics) on any Octopus import tariff using the
// public Octopus products API. No API key needed.
import {API, getJSON, cachedList} from './api.js';

export {API};
export const FUELS = ['electricity', 'gas'];
export const keyOf = (code) => code.replace(/-\d\d-\d\d-\d\d$/, '');
// Product key of a tariff code such as E-1R-VAR-22-11-01-H (fuel prefix, product code, region letter).
export const curKey = (tariff) => keyOf((tariff || '').split('-').slice(2, -1).join('-'));

// Octopus Tracker is not listed by the products API, so its product versions are pinned here.
export const TRACKER = [
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

const DAY = 864e5;
// Octopus-brand household import products on sale at time t (default: now). The API filters by brand, business and prepay (a page
// holds them all: it has no page_size for this list, and its pages are followed anyway); there is no filter for direction, and the
// flags are checked here too.
const imports = async (t) => {
  const url = API + '?brand=OCTOPUS_ENERGY&is_business=false&is_prepay=false' + (t === undefined ? '' : '&available_at=' + new Date(t).toISOString());
  return (await cachedList(url)).filter((p) => p.direction === 'IMPORT' && !p.is_prepay && !p.is_business);
};
const latest = (arr) => arr.sort((x, y) => Date.parse(y.available_from) - Date.parse(x.available_from))[0];
const shortName = (dn) => dn.replace(/\bOctopus\b/g, '').replace(/\bImport\b/g, '').replace(/\s+/g, ' ').trim() || dn;

// Tariffs on sale, from the product list alone (one request), plus Tracker: [{key, code (newest version), label, name (full display
// name)}], sorted by label. Which fuels a tariff offers in your region is only in each product's own record, so that is looked up
// per tariff when it is first priced (productFuels).
const fetchFamilies = async () => {
  const newest = new Map();
  for (const p of await imports()) {
    const k = keyOf(p.code), prev = newest.get(k);
    if (!prev || Date.parse(p.available_from) > Date.parse(prev.available_from)) newest.set(k, p);
  }
  const fams = [...newest.values()].map((p) => ({key: keyOf(p.code), code: p.code, label: shortName(p.display_name || p.code), name: p.display_name || p.code}));
  if (!newest.has('SILVER')) fams.push({key: 'SILVER', code: TRACKER[TRACKER.length - 1][0], label: 'Tracker', name: 'Octopus Tracker'});
  const seen = {};
  for (const f of fams) seen[f.label] = (seen[f.label] || 0) + 1;
  for (const f of fams) if (seen[f.label] > 1) f.label += ' (' + f.key + ')';
  return fams.sort((a, b) => a.label.localeCompare(b.label));
};

// Fuels each product version offers in a region ('e', 'g', 'eg', or '' for none), from its record: any single-register tariff for the
// region counts (payment keys vary by product: direct_debit_monthly, or 'varying' on Flexible), except free ones (explicit zero unit
// rate and standing charge: Octopus Zero / Zero Bills, only for registered Zero homes). Time-of-use products such as Go 12M Fixed
// report null for these summary fields, so only an explicit 0 and 0 excludes. Kept in localStorage per region and product version
// (a new version is looked up again); versions no longer in the tariff list are dropped from it when the list is stored.
const FUEL_KEY = 'octopus-tariff-compare-card:fuels:';
const fuelMaps = {};
const fuelMap = (reg) => fuelMaps[reg] || (fuelMaps[reg] = (() => {
  try { const m = JSON.parse(localStorage.getItem(FUEL_KEY + reg)); return m && typeof m === 'object' ? m : {}; } catch { return {}; }
})());
const fuelSave = (reg) => { try { localStorage.setItem(FUEL_KEY + reg, JSON.stringify(fuelMap(reg))); } catch { /* storage unavailable */ } };
// Known fuels of a product version in a region, or undefined if not looked up yet.
export const knownFuels = (reg, code) => fuelMap(reg)[code];
const fuelReqs = {};
export const productFuels = (reg, code) => {
  const k = knownFuels(reg, code);
  if (k !== undefined) return Promise.resolve(k);
  return fuelReqs[reg + code] || (fuelReqs[reg + code] = getJSON(API + code + '/').then((d) => {
    const has = (t) => Object.values(t?.['_' + reg] || {}).some((x) => !(x.standard_unit_rate_inc_vat === 0 && x.standing_charge_inc_vat === 0));
    const fuels = (has(d.single_register_electricity_tariffs) ? 'e' : '') + (has(d.single_register_gas_tariffs) ? 'g' : '');
    fuelMap(reg)[code] = fuels;
    fuelSave(reg);
    return fuels;
  }).finally(() => { delete fuelReqs[reg + code]; }));
};

// The tariff list changes rarely, so it is kept in localStorage per region. Younger than a day: used as is. Older: used straight
// away while a fresh copy is fetched in the background (stale-while-revalidate); if that differs, listeners registered with
// onFamiliesChanged are called.
const FAM_KEY = 'octopus-tariff-compare-card:tariffs:', FAM_TTL = DAY;
const famRead = (reg) => {
  try {
    localStorage.removeItem('octopus-tariff-compare-card:families:' + reg);  // the previous version's format
    const c = JSON.parse(localStorage.getItem(FAM_KEY + reg));
    return c && Array.isArray(c.fams) && c.fams.every((f) => f && f.key && f.code) ? c : null;
  } catch { return null; }
};
const famWrite = (reg, fams) => {
  try { localStorage.setItem(FAM_KEY + reg, JSON.stringify({t: Date.now(), fams})); } catch { /* storage unavailable */ }
  const m = fuelMap(reg), codes = new Set(fams.map((f) => f.code));
  for (const code of Object.keys(m)) if (!codes.has(code)) delete m[code];
  fuelSave(reg);
};
const famListeners = new Set();
export const onFamiliesChanged = (fn) => { famListeners.add(fn); return () => famListeners.delete(fn); };
const famCache = {};
const revalidate = (reg, old) => fetchFamilies().then((fams) => {
  famWrite(reg, fams);
  if (JSON.stringify(fams) === JSON.stringify(old)) return;
  famCache[reg] = Promise.resolve(fams);
  for (const fn of famListeners) fn(reg);
}, (e) => console.warn('octopus-tariff-compare-card: could not refresh the tariff list', e));
export const families = (reg) => famCache[reg] || (famCache[reg] = (async () => {
  const c = famRead(reg);
  if (c) {
    if (!(Date.now() - c.t < FAM_TTL)) revalidate(reg, c.fams);
    return c.fams;
  }
  const fams = await fetchFamilies();
  famWrite(reg, fams);
  return fams;
})().catch((e) => { delete famCache[reg]; throw e; }));

const at = (arr, t) => {
  let lo = 0, hi = arr.length - 1, r = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid][0] <= t) { r = arr[mid]; lo = mid + 1; } else hi = mid - 1; }
  return r && t < r[1] ? r[2] : null;
};

// Metered usage over [a0, b0) from HA statistics: [[start, end, kWh], ...]. 5-minute rows where the recorder still keeps them,
// hourly before that. The oldest kept 5-minute row reports the whole meter total as its change, so 5-minute data starts at the next
// full hour after it.
export const consumption = async (hass, id, a0, b0) => {
  const q = (period) => hass.callWS({type: 'recorder/statistics_during_period', start_time: new Date(a0).toISOString(),
    end_time: new Date(b0).toISOString(), statistic_ids: [id], period, types: ['change']});
  const [h, m] = await Promise.all([q('hour'), q('5minute')]);
  const raw5 = m[id] || [];
  const i5 = raw5.findIndex((x, i) => i > 0 && x.start % 36e5 === 0);
  const five = i5 < 0 ? [] : raw5.slice(i5);
  const firstFive = five.length ? five[0].start : Infinity;
  return [...(h[id] || []).filter((x) => x.end <= firstFive), ...five]
    .map((x) => [x.start, x.end, x.change || 0]).sort((x, y) => x[0] - y[0]);
};

const iso = (t) => new Date(t).toISOString();
// Calendar months (UTC) overlapping [a, b): [[monthStart, nextMonthStart], ...].
export const months = (a, b) => {
  const out = [];
  const d = new Date(a);
  for (let m = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); m < b;) {
    const n = new Date(m); const next = Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1);
    out.push([m, next]); m = next;
  }
  return out;
};
const localMidnight = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const minutesOfDay = (t) => { const d = new Date(t); return d.getHours() * 60 + d.getMinutes(); };

// Prices of a fixed tariff over [a, b), as [[start, end, price], ...]: what signing up today would get you, for the whole window.
// A flat fix has one open-ended price. Time-of-use fixes (Cosy, Go) publish their slots day by day a few days ahead, so the latest
// fully published day's pattern is repeated on every day of the window, by local time of day.
export const fixedPrices = (list, a, b) => {
  const now = Date.now();
  // Flat: the open-ended price in force now (or, for a product not yet started, its first price).
  const open = list.filter((x) => !x.valid_to).sort((x, y) => Date.parse(x.valid_from) - Date.parse(y.valid_from));
  const cur = open.filter((x) => Date.parse(x.valid_from) <= now).pop() || open[0];
  if (cur) return [[a, b, cur.value_inc_vat]];
  const slots = list.filter((x) => x.valid_to).map((x) => [Date.parse(x.valid_from), Date.parse(x.valid_to), x.value_inc_vat]);
  const days = [...new Set(slots.map(([f]) => localMidnight(f)))].sort((x, y) => y - x);
  for (const d0 of days) {
    const d1 = localMidnight(d0 + 36 * 36e5);  // next local midnight, also across a clock change
    const part = slots.filter(([f, t]) => f < d1 && t > d0).map(([f, t, v]) => [Math.max(f, d0), Math.min(t, d1), v]).sort((x, y) => x[0] - y[0]);
    let covered = d0;
    for (const [f, t] of part) { if (f > covered) break; covered = Math.max(covered, t); }
    if (covered < d1) continue;  // this day is not fully published yet
    const pattern = part.map(([f, t, v]) => [minutesOfDay(f), t >= d1 ? 1440 : minutesOfDay(t), v]);
    const out = [];
    for (let day = localMidnight(a); day < b; day = localMidnight(day + 36 * 36e5)) {
      const dt = new Date(day);
      for (const [m0, m1, v] of pattern) {
        const s = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), 0, m0).getTime();
        const e = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), 0, m1).getTime();
        if (Math.max(s, a) < Math.min(e, b)) out.push([Math.max(s, a), Math.min(e, b), v]);
      }
    }
    return out;
  }
  return [];
};

const addMonths = (t, n) => { const d = new Date(t); d.setMonth(d.getMonth() + n); return d.getTime(); };
// Local calendar date, e.g. "27 May 2026".
export const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, {day: 'numeric', month: 'short', year: 'numeric'});

// Tooltip lines: readable dates first, the product code on its own line.
const onSale = (f, t) => `On sale ${t ? `${f ? fmtDate(f) : '?'} to ${fmtDate(t)}` : `since ${f ? fmtDate(f) : '?'}`}`;
const saleBasis = (vs) => vs.map(([code, f, t]) => `${onSale(f, t)}\nCode: ${code}`);

// Which product versions price tariff K over [m0, m1), for one fuel: {vers: [[code, from, to]], fixed, basis} or {why}.
// t: {K, curProd, signup, dataStart}. K = 'CURRENT' (or the current tariff's key): the current tariff's own published rates. Other
// variable tariffs: the product versions on sale over the time, each with its published rates. Fixed tariffs, when signup (ms) is
// known: signed up then (or a whole number of terms earlier, for history before it) and renewed every term, each term on the fix
// that was on sale when it began, with that product's own published prices. Without signup: today's price of the latest fix.
const plan = async (t, m0, m1) => {
  const {K, curProd, signup, dataStart} = t;
  if (K === 'CURRENT' || K === keyOf(curProd)) {
    return {vers: [[curProd, null, null]], basis: [`Your tariff${signup !== null ? ' since ' + fmtDate(signup) : ''}\nCode: ${curProd}`]};
  }
  const overlaps = ([, f, e]) => (!f || Date.parse(f) < m1) && (!e || Date.parse(e) > m0);
  if (K === 'SILVER') return {vers: TRACKER, basis: saleBasis(TRACKER.filter(overlaps))};
  const now = latest((await imports()).filter((p) => keyOf(p.code) === K));
  if (!now) return {why: 'not on sale any more'};
  if (!now.is_variable && signup !== null) {
    // Renewal terms on the sign-up date's grid. The term covering the start of your recorded usage is the presumed sign-up.
    const term = now.term || 12;
    const align = (x) => { let p = signup; while (p > x) p = addMonths(p, -term); while (addMonths(p, term) <= x) p = addMonths(p, term); return p; };
    const first = align(dataStart);
    const when = (p) => fmtDate(p) + (p === signup ? " (your current agreement's start)" : '');
    const vers = [], basis = [];
    for (let p = align(m0); p < m1; p = addMonths(p, term)) {
      const kind = p <= first ? 'sign-up' : 'renewal';
      const prod = latest((await imports(p)).filter((x) => keyOf(x.code) === K && !x.is_variable));
      // No such fix was on sale when this term would have begun: the line would be incomplete, so leave it out.
      if (!prod) return {why: `Wasn't on sale on ${fmtDate(p)} (${p === signup ? "your current agreement's start" : 'presumed ' + kind})`};
      vers.push([prod.code, iso(p), iso(addMonths(p, term))]);
      basis.push(`Presumed ${kind}: ${when(p)}\n${onSale(prod.available_from)}\nCode: ${prod.code}`);
    }
    return {vers, basis};
  }
  if (!now.is_variable) {
    return {vers: [[now.code, null, null]], fixed: true,
      basis: [`Sign-up date unknown: current prices used throughout\n${onSale(now.available_from)}\nCode: ${now.code}`]};
  }
  // Variable: the version on sale a day before the month, then each one that replaced it.
  const vers = [], sale = [];
  let x = m0 - DAY;
  for (let i = 0; i < 24 && x < m1; i++) {
    const p = latest((await imports(x)).filter((y) => keyOf(y.code) === K || y.display_name === now.display_name));
    if (!p) { const nf = Date.parse(now.available_from); if (nf > x) { x = nf; continue; } break; }
    const pt = p.available_to ? Date.parse(p.available_to) : null;
    vers.push([p.code, iso(x), pt ? p.available_to : null]);
    sale.push([p.code, p.available_from, p.available_to]);
    if (!pt || pt <= x) break;
    x = pt;
  }
  return vers.length ? {vers, basis: saleBasis(sale)} : {why: 'no version on sale over this period'};
};

// Cost of one fuel's usage in calendar month [m0, m1) (UTC) on tariff K: {rows: [[end, GBP], ...] per consumption reading, basis}
// or {why} when it cannot be worked out. t: {fuel, reg, K, curProd, signup, dataStart}; rows: that month's readings
// [[start, end, kWh]]. Unit rates x usage, plus the daily standing charge accrued in proportion to each reading's length; inc VAT,
// direct debit. basis: tooltip lines saying which products and dates the prices came from.
// Prices are requested per calendar month, so the URLs stay the same from day to day: months that ended over a day ago cannot change
// any more and come from the browser cache.
export const priceMonth = async (t, m0, m1, rows) => {
  const p = await plan(t, m0, m1);
  if (p.why) return p;
  const kind = t.fuel === 'gas' ? 'gas-tariffs' : 'electricity-tariffs', pfx = t.fuel === 'gas' ? 'G-1R-' : 'E-1R-';
  const units = [], stand = [];
  const fetched = await Promise.all(p.vers.map(async ([prod, f, e]) => {
    const a = Math.max(m0, f ? Date.parse(f) : -Infinity), b = Math.min(m1, e ? Date.parse(e) : Infinity);
    if (!(a < b)) return null;
    const base = `${API}${prod}/${kind}/${pfx}${prod}-${t.reg}/`;
    const get = (list) => (p.fixed ? cachedList(base + list + '?page_size=1500')
      : cachedList(`${base}${list}?period_from=${iso(m0)}&period_to=${iso(m1)}&page_size=1500`, m1 < Date.now() - DAY));
    try { return [a, b, ...await Promise.all([get('standard-unit-rates/'), get('standing-charges/')])]; } catch { return null; }
  }));
  for (const l of fetched) {
    if (!l) continue;
    const [a, b, u, sc] = l;
    for (const [arr, dst] of [[u, units], [sc, stand]]) {
      const dd = arr.filter((x) => !x.payment_method || x.payment_method === 'DIRECT_DEBIT');
      if (p.fixed) { dst.push(...fixedPrices(dd, a, b)); continue; }
      for (const x of dd) {
        const vs = Math.max(a, Date.parse(x.valid_from)), ve = Math.min(b, x.valid_to ? Date.parse(x.valid_to) : b);
        if (vs < ve) dst.push([vs, ve, x.value_inc_vat]);
      }
    }
  }
  if (!units.length) return {why: 'no published prices for this period'};
  units.sort((x, y) => x[0] - y[0]); stand.sort((x, y) => x[0] - y[0]);
  const out = [];
  let missing = false;
  for (const [s, e, kwh] of rows) {
    let pence = 0;
    const sc = at(stand, (s + e) / 2);
    if (sc === null) missing = true; else pence += sc * (e - s) / DAY;
    const n = Math.max(1, Math.round((e - s) / 18e5));  // unit rates change every half hour at most
    for (let i = 0; i < n; i++) { const r = at(units, s + (i + 0.5) * (e - s) / n); if (r === null) missing = true; else pence += r * kwh / n; }
    out.push([e, pence / 100]);
  }
  const basis = [...p.basis];
  if (missing) {
    console.warn(`octopus-tariff-compare-card: ${t.fuel} ${t.K} has gaps in published prices in ${iso(m0).slice(0, 7)}`);
    basis.push('some prices are missing for this period and are left out');
  }
  return {rows: out, basis};
};

// Sum of two running totals on the union of their timestamps (each held at its last value between its own points).
export const merge = (A, B) => {
  const ts = [...new Set([...A.map((x) => x[0]), ...B.map((x) => x[0])])].sort((x, y) => x - y);
  let i = 0, j = 0, va = 0, vb = 0;
  return ts.map((t) => {
    while (i < A.length && A[i][0] <= t) va = A[i++][1];
    while (j < B.length && B[j][0] <= t) vb = B[j++][1];
    return [t, va + vb];
  });
};

// Every n-th point (same indices for every line of a chart, so the shared tooltip stays aligned), always keeping the last.
export const thin = (arr, max) => {
  const n = Math.ceil(arr.length / max);
  return n <= 1 ? arr : arr.filter((_, i) => i % n === 0 || i === arr.length - 1);
};

// Octopus Energy integration (BottlecapDave/HomeAssistant-OctopusEnergy) entities: the import meter's current_rate sensor (its
// `tariff` attribute gives the tariff and region) and its lifetime consumption register (needs an Octopus Home Mini).
export const detectEntities = (hass) => {
  const ids = Object.keys(hass.states).filter((id) => id.startsWith('sensor.octopus_energy_')
    && (!hass.entities?.[id]?.platform || hass.entities[id].platform === 'octopus_energy'));
  const find = (fuel, suffix) => {
    for (const rate of ids) {
      if (!new RegExp(`^sensor\\.octopus_energy_${fuel}_.+_current_rate$`).test(rate)) continue;
      const a = hass.states[rate].attributes || {};
      if (a.is_export || /_export_/.test(rate)) continue;
      const total = rate.replace(/_current_rate$/, suffix);
      if (hass.states[total]) return {rate, consumption: total};
    }
    return null;
  };
  return {electricity: find('electricity', '_current_total_consumption'), gas: find('gas', '_current_total_consumption_kwh')};
};
