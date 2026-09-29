// A fake of the parts of the Octopus products API the card uses, serving tests/fake/world.mjs. Lists are paginated like the real
// API (newest first, `count`, `next` with a `page` parameter), with a smaller page size cap so the tests exercise pagination.
import {PRODUCTS, product, entries, REGION, NOW} from './world.mjs';

const BASE = 'https://api.octopus.energy/v1/products/';
const MAX_PAGE = 500;

const page = (url, all) => {
  const size = Math.min(+(url.searchParams.get('page_size') || 100), MAX_PAGE), n = +(url.searchParams.get('page') || 1);
  const results = all.slice((n - 1) * size, n * size);
  let next = null;
  if (n * size < all.length) { const u = new URL(url); u.searchParams.set('page', n + 1); next = u.href; }
  return {count: all.length, next, previous: null, results};
};

const summary = (p, fuel) => {
  const f = p[fuel];
  if (!f) return {};
  const unit = entries(p, f.unit, NOW, NOW + 1)[0]?.value_inc_vat ?? null, standing = entries(p, f.standing, NOW, NOW + 1)[0]?.value_inc_vat ?? null;
  return {['_' + REGION]: {direct_debit_monthly: {code: `${fuel === 'gas' ? 'G' : 'E'}-1R-${p.code}-${REGION}`,
    standard_unit_rate_inc_vat: p[fuel].unit.tou ? null : unit, standing_charge_inc_vat: standing}}};
};

// {status, json} for a GET of `href`, or null if it is not an API URL this fake knows.
export const handle = (href) => {
  const url = new URL(href);
  if (!url.href.startsWith(BASE)) return null;
  const path = url.pathname.slice('/v1/products/'.length).split('/').filter(Boolean);
  if (!path.length) {
    const at = url.searchParams.has('available_at') ? Date.parse(url.searchParams.get('available_at')) : NOW;
    const list = PRODUCTS.filter((p) => !p.unlisted && p.from <= at && (p.to == null || at < p.to))
      .map((p) => ({code: p.code, direction: 'IMPORT', full_name: p.name, display_name: p.name, is_variable: p.variable, is_green: false,
        is_tracker: false, is_prepay: false, is_business: false, is_restricted: false, term: p.term ?? null, brand: 'OCTOPUS_ENERGY',
        available_from: new Date(p.from).toISOString(), available_to: p.to == null ? null : new Date(p.to).toISOString()}));
    return {status: 200, json: page(url, list)};
  }
  const p = product(path[0]);
  if (!p) return {status: 404, json: {detail: 'No EnergyProduct matches the given query.'}};
  if (path.length === 1) {
    return {status: 200, json: {code: p.code, display_name: p.name, full_name: p.name, is_variable: p.variable, term: p.term ?? null,
      available_from: new Date(p.from).toISOString(), available_to: p.to == null ? null : new Date(p.to).toISOString(),
      single_register_electricity_tariffs: summary(p, 'electricity'), single_register_gas_tariffs: summary(p, 'gas')}};
  }
  // /{code}/{electricity|gas}-tariffs/{tariff code}/{standard-unit-rates|standing-charges}/
  const fuel = path[1] === 'gas-tariffs' ? 'gas' : 'electricity', list = path[3];
  if (!p[fuel] || path[2] !== `${fuel === 'gas' ? 'G' : 'E'}-1R-${p.code}-${REGION}`) return {status: 404, json: {detail: 'Not found.'}};
  const spec = list === 'standard-unit-rates' ? p[fuel].unit : list === 'standing-charges' ? p[fuel].standing : null;
  if (!spec) return {status: 404, json: {detail: 'Not found.'}};
  const a = url.searchParams.has('period_from') ? Date.parse(url.searchParams.get('period_from')) : -Infinity;
  const b = url.searchParams.has('period_to') ? Date.parse(url.searchParams.get('period_to')) : Infinity;
  return {status: 200, json: page(url, entries(p, spec, a, b))};
};
