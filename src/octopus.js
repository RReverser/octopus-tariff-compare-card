// Octopus Energy cost engine: prices your metered usage (Home Assistant long-term statistics) on any Octopus import tariff using the
// public Octopus products API. No API key needed.

export const API = 'https://api.octopus.energy/v1/products/';
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

const fetchAll = async (url) => {
  const res = [];
  while (url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Octopus API ${r.status} for ${url}`);
    const j = await r.json();
    res.push(...(j.results || []));
    url = j.next;
  }
  return res;
};

const lists = {};
// Rate lists by URL for the page's lifetime: request windows are rounded to whole UTC days, so re-costing the same history later
// (a periodic refresh) re-uses them instead of fetching again.
const rates = {};
const fetchRates = (url) => rates[url] || (rates[url] = fetchAll(url).catch((e) => { delete rates[url]; throw e; }));
const DAY = 864e5;
const imports = async (t) => {
  const url = API + '?brand=OCTOPUS_ENERGY&is_business=false&page_size=100' + (t === undefined ? '' : '&available_at=' + new Date(t).toISOString());
  return (await (lists[url] || (lists[url] = fetchAll(url).catch((e) => { delete lists[url]; throw e; }))))
    .filter((p) => p.direction === 'IMPORT' && !p.is_prepay && !p.is_business);
};
const latest = (arr) => arr.sort((x, y) => Date.parse(y.available_from) - Date.parse(x.available_from))[0];
const shortName = (dn) => dn.replace(/\bOctopus\b/g, '').replace(/\bImport\b/g, '').replace(/\s+/g, ' ').trim() || dn;

// Tariffs on sale in a region (single-register, any payment option, not free), plus Tracker:
// [{key, label, fuels: 'e' | 'g' | 'eg'}], sorted by label.
const famCache = {};
export const families = (reg) => famCache[reg] || (famCache[reg] = (async () => {
  const newest = new Map();
  for (const p of await imports()) {
    const k = keyOf(p.code), prev = newest.get(k);
    if (!prev || Date.parse(p.available_from) > Date.parse(prev.available_from)) newest.set(k, p);
  }
  const codes = [...[...newest.values()].map((p) => p.code), ...(newest.has('SILVER') ? [] : [TRACKER[TRACKER.length - 1][0]])];
  const fams = await Promise.all(codes.map(async (code) => {
    const d = await (await fetch(API + code + '/')).json();
    // Payment keys vary by product (direct_debit_monthly, or 'varying' on Flexible): any tariff for the region counts, except free
    // ones (explicit zero unit rate and standing charge: Octopus Zero / Zero Bills, only for registered Zero homes). Time-of-use
    // products such as Go 12M Fixed report null for these summary fields, so only an explicit 0 and 0 excludes.
    const has = (t) => Object.values(t?.['_' + reg] || {}).some((x) => !(x.standard_unit_rate_inc_vat === 0 && x.standing_charge_inc_vat === 0));
    const e = has(d.single_register_electricity_tariffs), g = has(d.single_register_gas_tariffs);
    return {key: keyOf(code), label: shortName(d.display_name || code), fuels: (e ? 'e' : '') + (g ? 'g' : '')};
  }));
  const fl = fams.filter((f) => f.fuels), seen = {};
  for (const f of fl) seen[f.label] = (seen[f.label] || 0) + 1;
  for (const f of fl) if (seen[f.label] > 1) f.label += ' (' + f.key + ')';
  return fl.sort((a, b) => a.label.localeCompare(b.label));
})().catch((e) => { delete famCache[reg]; throw e; }));

const at = (arr, t) => {
  let lo = 0, hi = arr.length - 1, r = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid][0] <= t) { r = arr[mid]; lo = mid + 1; } else hi = mid - 1; }
  return r && t < r[1] ? r[2] : null;
};

// Per-refresh cache: consumption per meter and window, cost per fuel, window and tariff.
export const newCache = () => ({});

// Metered usage over [a0, b0) from HA statistics: [[start, end, kWh], ...]. 5-minute rows where the recorder still keeps them,
// hourly before that. The oldest kept 5-minute row reports the whole meter total as its change, so 5-minute data starts at the next
// full hour after it.
const consumption = (cache, hass, id, a0, b0) => {
  const k = 'cons:' + id + ':' + a0 + '-' + b0;
  return cache[k] || (cache[k] = (async () => {
    const q = (period) => hass.callWS({type: 'recorder/statistics_during_period', start_time: new Date(a0).toISOString(),
      end_time: new Date(b0).toISOString(), statistic_ids: [id], period, types: ['change']});
    const [h, m] = await Promise.all([q('hour'), q('5minute')]);
    const raw5 = m[id] || [];
    const i5 = raw5.findIndex((x, i) => i > 0 && x.start % 36e5 === 0);
    const five = i5 < 0 ? [] : raw5.slice(i5);
    const firstFive = five.length ? five[0].start : Infinity;
    return [...(h[id] || []).filter((x) => x.end <= firstFive), ...five]
      .map((x) => [x.start, x.end, x.change || 0]).sort((x, y) => x[0] - y[0]);
  })());
};

// Cumulative cost (GBP) of one fuel on tariff K over [a0, b0): [[t, total], ...] on that fuel's consumption timestamps, or null when
// K has no prices for this fuel in the region. Unit rates x usage, plus the daily standing charge accrued smoothly (per reading, in
// proportion to its length); inc VAT, direct debit. K = 'CURRENT' (or the current tariff's key): the current tariff's own published
// rates. Other variable tariffs: the product versions on sale over the window, each with its published rates. Fixed tariffs:
// today's price of the latest fix, applied to the whole window.
export const fuelCost = (cache, hass, a0, b0, fuel, {rate, consumption: total}, K) => {
  const ck = 'cost:' + fuel + ':' + a0 + '-' + b0 + ':' + K;
  return cache[ck] || (cache[ck] = (async () => {
    const attrs = hass.states[rate]?.attributes || {};
    const tariff = attrs.tariff || attrs.tariff_code || '';
    const reg = tariff.slice(-1), curProd = tariff.split('-').slice(2, -1).join('-');
    const cons = await consumption(cache, hass, total, a0, b0);
    if (!cons.length) return null;
    const c0 = cons[0][0], c1 = cons[cons.length - 1][1];
    let vers, fixed = false;
    if (K === 'CURRENT' || K === keyOf(curProd)) vers = [[curProd, null, null]];
    else if (K === 'SILVER') vers = TRACKER;
    else {
      const now = latest((await imports()).filter((p) => keyOf(p.code) === K));
      if (!now) return null;
      if (!now.is_variable) { vers = [[now.code, null, null]]; fixed = true; } else {
        vers = [];
        let t = c0 - 864e5;
        for (let i = 0; i < 24 && t < c1; i++) {
          const p = latest((await imports(t)).filter((x) => keyOf(x.code) === K || x.display_name === now.display_name));
          if (!p) { const nf = Date.parse(now.available_from); if (nf > t) { t = nf; continue; } break; }
          const pt = p.available_to ? Date.parse(p.available_to) : null;
          vers.push([p.code, new Date(t).toISOString(), pt ? p.available_to : null]);
          if (!pt || pt <= t) break;
          t = pt;
        }
        if (!vers.length) return null;
      }
    }
    const kind = fuel === 'gas' ? 'gas-tariffs' : 'electricity-tariffs', pfx = fuel === 'gas' ? 'G-1R-' : 'E-1R-';
    const units = [], stand = [];
    for (const [prod, f, t] of vers) {
      const a = Math.max(Math.floor(c0 / DAY) * DAY - DAY, f ? Date.parse(f) : -Infinity);
      const b = Math.min(Math.ceil(c1 / DAY) * DAY + DAY, t ? Date.parse(t) : Infinity);
      if (!(a < b)) continue;
      const base = `${API}${prod}/${kind}/${pfx}${prod}-${reg}/`;
      const qs = fixed ? '?page_size=1500' : `?period_from=${new Date(a).toISOString()}&period_to=${new Date(b).toISOString()}&page_size=1500`;
      let u, s;
      try { [u, s] = await Promise.all([fetchRates(base + 'standard-unit-rates/' + qs), fetchRates(base + 'standing-charges/' + qs)]); } catch { continue; }
      for (const [arr, dst] of [[u, units], [s, stand]]) for (const x of arr) {
        if (x.payment_method && x.payment_method !== 'DIRECT_DEBIT') continue;
        if (fixed) {
          const nf = Date.parse(x.valid_from), nt = x.valid_to ? Date.parse(x.valid_to) : Infinity;
          if (nf <= Date.now() && Date.now() < nt) dst.push([a, b, x.value_inc_vat]);
          continue;
        }
        const vs = Math.max(a, Date.parse(x.valid_from)), ve = Math.min(b, x.valid_to ? Date.parse(x.valid_to) : b);
        if (vs < ve) dst.push([vs, ve, x.value_inc_vat]);
      }
    }
    if (!units.length) return null;
    units.sort((x, y) => x[0] - y[0]); stand.sort((x, y) => x[0] - y[0]);
    const out = [[c0, 0]];
    let pence = 0, missing = false;
    for (const [s, e, kwh] of cons) {
      const sc = at(stand, (s + e) / 2);
      if (sc === null) missing = true; else pence += sc * (e - s) / 864e5;
      const n = Math.max(1, Math.round((e - s) / 18e5));
      for (let i = 0; i < n; i++) { const r = at(units, s + (i + 0.5) * (e - s) / n); if (r === null) missing = true; else pence += r * kwh / n; }
      out.push([e, pence / 100]);
    }
    if (missing) console.warn(`octopus-tariff-compare-card: ${fuel} ${K} has gaps in published prices for this window`);
    return out;
  })());
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
