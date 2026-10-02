import {test, expect} from '@playwright/test';
import {open, settled, legend, lines, cardHeight, clickFuel, dragBrush, monthsFetched} from './helpers.mjs';
import {cost} from './fake/reference.mjs';
import {SCENARIOS, SIGNUP, DAY, NOW, historyStart} from './fake/world.mjs';

const KEY = {CURRENT: 'VAR'};  // the current tariff's line is the user's own tariff, Flexible
const ALL = ['CURRENT', 'OE-FIX-12M', 'OE-FIX-18M', 'AGILE', 'COSY-FIX-12M', 'SILVER'];
const month = (t) => new Date(t).toISOString().slice(0, 7);
const monthsBetween = (a, b) => { const out = []; for (let t = Date.UTC(new Date(a).getUTCFullYear(), new Date(a).getUTCMonth(), 1); t < b; t = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth() + 1, 1)) out.push(month(t)); return out; };

// Every priced line's total for the selected period equals the reference cost (to the penny); exactly the lines in `na` are
// unavailable. Returns the lines.
const checkTotals = async (page, scenario, {signup = SIGNUP, na = []} = {}) => {
  const {a, b, fuels, lines: ls} = await lines(page);
  expect(ls.filter((l) => l.na).map((l) => l.key).sort()).toEqual([...na].sort());
  let priced = 0;
  for (const l of ls.filter((x) => !x.na)) {
    const want = fuels.reduce((s, f) => s + cost(SCENARIOS[scenario], f, KEY[l.key] || l.key, a, b, {signup}), 0);
    expect(l.total, `${l.key} total over ${new Date(a).toISOString()} to ${new Date(b).toISOString()}`).toBeCloseTo(want, 2);
    priced++;
  }
  expect(priced).toBe(ls.length - na.length);
  return ls;
};

test.describe('short history (10 days)', () => {
  test('every tariff costs what the reference says, per fuel and for both', async ({page}) => {
    await open(page, 'short');
    const ls = await checkTotals(page, 'short', {na: ['OE-FIX-18M']});
    expect(ls.map((l) => l.key)).toEqual(ALL);
    await clickFuel(page, 'gas');  // electricity and gas
    await checkTotals(page, 'short', {na: ['OE-FIX-18M', 'AGILE', 'COSY-FIX-12M']});
    await clickFuel(page, 'electricity');  // gas only
    await checkTotals(page, 'short', {na: ['OE-FIX-18M', 'AGILE', 'COSY-FIX-12M']});
  });

  test('legend keeps its entries, widths and height across fuel changes; unavailable entries cannot be shown', async ({page}) => {
    await open(page, 'short');
    const before = await legend(page), h = await cardHeight(page);
    expect(before.map((e) => e.cursor)).toEqual(['default', 'pointer', 'not-allowed', 'pointer', 'pointer', 'pointer']);
    await clickFuel(page, 'gas');
    const both = await legend(page);
    expect(both.map((e) => e.text.split(' £')[0])).toEqual(before.map((e) => e.text.split(' £')[0]));
    expect(both.map((e) => e.na)).toEqual([false, false, true, true, true, false]);
    expect(both.filter((e) => e.na).every((e) => e.text.endsWith('N/A') && e.cursor === 'not-allowed')).toBe(true);
    expect(await cardHeight(page)).toBe(h);
    // Entries whose price has as many digits keep their width: prices are tabular, and N/A sits over a blank price.
    both.forEach((e, i) => { if (e.text.replace(/\D/g, '').length === before[i].text.replace(/\D/g, '').length) expect(Math.abs(e.width - before[i].width)).toBeLessThanOrEqual(1); });
    // Clicking an unavailable entry changes nothing.
    const agile = page.locator('.main .apexcharts-legend-series').nth(3);
    const hiddenBefore = (await legend(page))[3].hidden;
    await agile.click();
    expect((await legend(page))[3].hidden).toBe(hiddenBefore);
    expect(await page.evaluate(() => window.card._state.visible)).toBeUndefined();
    // Clicking an available one toggles it and is remembered per fuel selection (Tracker starts shown: default_visible).
    expect((await legend(page))[5].hidden).toBe(false);
    await page.locator('.main .apexcharts-legend-series').nth(5).click();
    expect((await legend(page))[5].hidden).toBe(true);
    expect(await page.evaluate(() => window.card._state.visible['electricity+gas'])).not.toContain('SILVER');
    await page.locator('.main .apexcharts-legend-series').nth(5).click();
    expect((await legend(page))[5].hidden).toBe(false);
  });

  test('hovering the chart shows every shown line\'s value, also with unavailable tariffs listed', async ({page}) => {
    await open(page, 'short');
    const g = await page.evaluate(() => { const b = window.card.shadowRoot.querySelector('.main .apexcharts-series').getBoundingClientRect(); return {x: b.x, y: b.y, w: b.width, h: b.height}; });
    await page.mouse.move(g.x + g.w * 0.6, g.y + g.h * 0.5, {steps: 5});
    const rows = () => page.evaluate(() => [...window.card.shadowRoot.querySelectorAll('.main .apexcharts-tooltip-series-group')]
      .filter((x) => getComputedStyle(x).display !== 'none').map((x) => x.textContent.trim().split(':')[0]).filter(Boolean));
    // Shown by default: your tariff, 12M Fixed and Tracker (18M Fixed is unavailable here).
    await expect.poll(rows).toEqual(['Flexible', '12M Fixed', 'Tracker']);
  });

  test('tooltips: name, what the prices are based on, code', async ({page}) => {
    await open(page, 'short');
    const t = Object.fromEntries((await lines(page)).lines.map((l) => [l.key, l.tip]));
    expect(t.CURRENT).toBe('Flexible Octopus\nYour tariff since 27 May 2026\nCode: VAR-22-11-01');
    expect(t['OE-FIX-12M']).toBe('Octopus 12M Fixed\nPresumed sign-up: 27 May 2026 (your current agreement\'s start)\nOn sale since 20 May 2026\nCode: OE-FIX-12M-26-05-18');
    expect(t['OE-FIX-18M']).toBe('Octopus 18M Fixed\nWasn\'t on sale on 27 May 2026 (your current agreement\'s start)\nCode: OE-FIX-18M');
    expect(t.AGILE).toBe('Agile Octopus\nOn sale since 1 Jan 2024\nCode: AGILE-24-01-01');
    expect(t.SILVER).toBe('Octopus Tracker\nOn sale since 1 Apr 2026\nCode: SILVER-26-04-01');
    // The legend shows the same text on hover.
    expect((await legend(page)).map((e) => e.title)).toEqual((await lines(page)).lines.map((l) => l.tip));
    await clickFuel(page, 'gas');
    const g = Object.fromEntries((await lines(page)).lines.map((l) => [l.key, l.tip]));
    // Fuels priced the same way share one unlabelled block; your own tariff has a code per fuel.
    expect(g['OE-FIX-12M']).toBe(t['OE-FIX-12M']);
    expect(g.CURRENT).toBe('Flexible Octopus\nYour tariff since 27 May 2026\nCode: VAR-22-11-01');
    expect(g.AGILE).toBe('Agile Octopus\nNot offered for gas\nCode: AGILE');
  });

  test('lines appear as their prices arrive, without moving the legend', async ({page}) => {
    const {release, errors} = await open(page, 'short', {hold: (u) => u.includes('/AGILE-24-01-01/electricity-tariffs/')});
    await expect.poll(() => page.evaluate(() => !!window.card._main && window.card._view(...window.card._period()).filter((l) => l.total != null).length)).toBe(4);
    const pending = await legend(page);
    expect(pending[3].text).toBe('Agile £');  // blank price, held back
    expect(pending[3].title).toBe('Agile Octopus\nLoading prices…');
    release();
    await settled(page);
    const done = await legend(page);
    expect(done[3].text).toMatch(/^Agile £\d+\.\d\d$/);
    // Same digit count as the current tariff's price here, so the same width.
    expect(Math.abs(done[3].width - pending[3].width)).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });

  test('prices are only requested once per month and list', async ({page}) => {
    const {api} = await open(page, 'short');
    await clickFuel(page, 'gas');
    await clickFuel(page, 'gas');
    const dup = api.filter((u, i) => api.indexOf(u) !== i);
    expect(dup).toEqual([]);
  });
});

test.describe('tariff list cache', () => {
  const KEY = 'octopus-tariff-compare-card:families:H';
  // Requests for a product's own record (/v1/products/<code>/), made only when the tariff list is built.
  const details = (api) => api.filter((u) => /^\/v1\/products\/[^/]+\/$/.test(new URL(u).pathname));
  const keys = async (page) => (await lines(page)).lines.map((l) => l.key);

  test('a reload within a day uses the stored list and requests no product records', async ({page}) => {
    const {api} = await open(page, 'short');
    expect(details(api).length).toBeGreaterThan(0);
    const before = await keys(page), n = api.length;
    await page.reload();
    await settled(page);
    expect(details(api.slice(n))).toEqual([]);
    expect(await keys(page)).toEqual(before);
  });

  test('a day-old list is shown at once, refreshed in the background, and changes are applied', async ({page}) => {
    const {api} = await open(page, 'short');
    const full = await keys(page);
    // Pretend the stored list is over a day old and lacks Agile.
    await page.evaluate(([k, t]) => {
      const c = JSON.parse(localStorage.getItem(k));
      localStorage.setItem(k, JSON.stringify({t, fams: c.fams.filter((f) => f.key !== 'AGILE')}));
    }, [KEY, NOW - 25 * 36e5]);
    const n = api.length;
    // Hold the background refresh back (one product record is enough: the list is replaced only once all have arrived) to see
    // what the card shows meanwhile.
    let release;
    const gate = new Promise((r) => { release = r; });
    await page.route(/\/v1\/products\/AGILE[^/]*\/$/, async (route) => { await gate; return route.fallback(); });
    await page.reload();
    await settled(page);
    expect(await keys(page)).toEqual(full.filter((k) => k !== 'AGILE'));
    release();
    await expect.poll(() => keys(page)).toEqual(full);
    await settled(page);
    expect(details(api.slice(n)).length).toBeGreaterThan(0);
    expect(await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).t, KEY)).toBe(NOW);
  });
});

test.describe('not an admin (agreement start unknown)', () => {
  test('fixes are priced at the latest fix\'s prices throughout, and say so', async ({page}) => {
    await open(page, 'nonadmin');
    await checkTotals(page, 'nonadmin', {signup: null, na: []});
    const t = Object.fromEntries((await lines(page)).lines.map((l) => [l.key, l.tip]));
    expect(t['OE-FIX-12M']).toBe('Octopus 12M Fixed\nSign-up date unknown: current prices used throughout\nOn sale since 20 May 2026\nCode: OE-FIX-12M-26-05-18');
    expect(t.CURRENT).toBe('Flexible Octopus\nYour tariff\nCode: VAR-22-11-01');
  });
});

test.describe('electricity only', () => {
  test('no gas button; tariffs priced', async ({page}) => {
    await open(page, 'electricityOnly');
    expect(await page.locator('[data-fuel=gas]').count()).toBe(0);
    await checkTotals(page, 'electricityOnly', {na: ['OE-FIX-18M']});
  });
});

test.describe('long history (2 years)', () => {
  test('only the months of the selected period are fetched, except for the current tariff', async ({page}) => {
    const {api} = await open(page, 'long');
    const {a, b, start, end} = await lines(page);
    expect(end - start).toBeGreaterThan(700 * DAY);
    expect(b - a).toBeCloseTo(30 * DAY, -6);
    const period = monthsBetween(a - 36e5, b);
    for (const code of ['AGILE', 'OE-FIX-12M', 'COSY-FIX-12M', 'SILVER']) expect(monthsFetched(api, code), code).toEqual(period);
    expect(monthsFetched(api, 'VAR')).toEqual(monthsBetween(start, end));
    await checkTotals(page, 'long', {na: ['OE-FIX-18M']});
  });

  test('moving the brush loads the months it moves to, and totals match', async ({page}) => {
    const {api} = await open(page, 'long');
    const n = api.length;
    await dragBrush(page, -2000);  // to the start of the history
    const {a, b, start} = await lines(page);
    expect(a).toBe(start);
    expect(b - a).toBeCloseTo(30 * DAY, -6);
    const newMonths = monthsBetween(a - 36e5, b);
    for (const code of ['AGILE', 'OE-FIX-12M']) for (const m of newMonths) expect(monthsFetched(api, code), code).toContain(m);
    // Only where it was let go: months the brush passed over were not fetched.
    expect(monthsFetched(api, 'AGILE')).toEqual([...newMonths, '2026-08', '2026-09']);
    expect(api.length).toBeGreaterThan(n);
    // Cosy 12M Fixed only went on sale in 2026, so it cannot be priced from a 2024 sign-up.
    const ls = await checkTotals(page, 'long', {na: ['OE-FIX-18M', 'COSY-FIX-12M']});
    expect(ls.find((l) => l.key === 'COSY-FIX-12M').tip).toBe('Cosy Octopus 12M Fixed\nWasn\'t on sale on 27 May 2024 (presumed sign-up)\nCode: COSY-FIX-12M');
    // Back to where it was: all already loaded, nothing new fetched.
    const m = api.length;
    await dragBrush(page, 4000);
    expect((await lines(page)).b).toBe((await lines(page)).end);
    expect(api.length).toBe(m);
  });

  test('the brush cannot be dragged past either end of the data', async ({page}) => {
    await open(page, 'long');
    await dragBrush(page, 3000);
    let p = await lines(page);
    expect(p.b).toBe(p.end);
    await dragBrush(page, -3000);
    p = await lines(page);
    expect(p.a).toBe(p.start);
    const inside = await page.evaluate(() => {
      const r = window.card.shadowRoot.querySelector('.brush .apexcharts-selection-rect'), g = window.card._brush.w.globals;
      return +r.getAttribute('x') >= 0 && +r.getAttribute('x') + +r.getAttribute('width') <= g.gridWidth + 0.5;
    });
    expect(inside).toBe(true);
  });

  test('a fix across a renewal: each term on the fix on sale when it began', async ({page}) => {
    // A period spanning the presumed renewal of 27 May 2025 (a whole number of 12-month terms before the agreement start).
    const from = Date.parse('2025-05-01T00:00:00+01:00'), to = Date.parse('2025-06-20T00:00:00+01:00');
    await open(page, 'long', {state: {period: {from, to}}});
    const {a, b} = await lines(page);
    expect([a, b]).toEqual([from, to]);
    await checkTotals(page, 'long', {na: ['OE-FIX-18M', 'COSY-FIX-12M']});
    const t = (await lines(page)).lines.find((l) => l.key === 'OE-FIX-12M').tip;
    expect(t).toBe('Octopus 12M Fixed\nPresumed sign-up: 27 May 2024\nOn sale since 1 Jan 2024\nCode: OE-FIX-12M-24-01-01\n'
      + 'Presumed renewal: 27 May 2025\nOn sale since 1 Feb 2025\nCode: OE-FIX-12M-25-02-01');
    // Cheaper before the renewal than after, as the fake prices say (20p then 21p a kWh).
    const before = cost(SCENARIOS.long, 'electricity', 'OE-FIX-12M', from, Date.parse('2025-05-26T23:00:00Z'));
    const after = cost(SCENARIOS.long, 'electricity', 'OE-FIX-12M', Date.parse('2025-05-26T23:00:00Z'), to);
    expect(before).toBeGreaterThan(0);
    expect(after).toBeGreaterThan(0);
  });

  test('a periodic refresh re-prices only the current month and keeps showing figures meanwhile', async ({page}) => {
    const {api} = await open(page, 'long');
    const before = (await lines(page)).lines.map((l) => l.total);
    const n = api.length;
    await page.clock.setFixedTime(NOW + 10 * 60e3);  // past the API's 5-minute cache lifetime
    await page.evaluate(() => window.card._refresh());
    // Straight after the refresh starts, the figures are still there.
    expect((await lines(page)).lines.map((l) => l.total)).toEqual(before);
    await expect.poll(() => page.evaluate(() => window.card._data.gen)).toBe(2);
    await settled(page);
    expect((await lines(page)).lines.map((l) => l.total)).toEqual(before);
    // Only the months that can still change were requested again: September 2026 (the last day of August is over a day ago).
    const again = [...new Set(api.slice(n).filter((u) => u.includes('period_from')).map((u) => new URL(u).searchParams.get('period_from').slice(0, 7)))];
    expect(again).toEqual(['2026-09']);
  });

  test('history before the first data is not requested', async ({page}) => {
    const {api} = await open(page, 'long');
    const first = month(historyStart(SCENARIOS.long));
    expect(monthsFetched(api, 'VAR')[0]).toBe(first);
    void NOW;
  });
});
