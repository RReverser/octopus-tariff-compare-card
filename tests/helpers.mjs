// Test helpers: serve the repo and the fake Octopus API to the page, and read the card's state.
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {expect} from '@playwright/test';
import {handle} from './fake/octopus-api.mjs';
import {NOW} from './fake/world.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = {html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json'};

// Opens the test page for a scenario. `state`: the card's stored per-browser state to start from. `hold(url)`: API responses to hold
// back until `release()` is called (the page is then returned before it has settled). Returns {api, release}: api lists every
// Octopus API URL the page requested, in order.
export const open = async (page, scenario, {state, hold} = {}) => {
  const api = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  await page.clock.setFixedTime(NOW);
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('http://card.test/')) {
      const path = new URL(url).pathname;
      try {
        const body = await readFile(ROOT + path.slice(1));
        return route.fulfill({status: 200, body, contentType: TYPES[path.split('.').pop()] || 'application/octet-stream'});
      } catch { return route.fulfill({status: 404, body: 'not found'}); }
    }
    const r = handle(url);
    if (r) {
      api.push(url);
      if (hold?.(url)) await gate;
      return route.fulfill({status: r.status, contentType: 'application/json', body: JSON.stringify(r.json),
        headers: {'access-control-allow-origin': '*', 'cache-control': 'max-age=300'}});
    }
    return route.abort();  // nothing else may be fetched
  });
  if (state) {
    await page.addInitScript((s) => localStorage.setItem('octopus-tariff-compare-card:default', JSON.stringify(s)), state);
  }
  const errors = [];
  page.on('pageerror', (e) => errors.push(e));
  await page.goto(`http://card.test/tests/page.html?scenario=${scenario}`);
  if (hold) return {api, release, errors};
  await settled(page);
  expect(errors).toEqual([]);
  return {api, release, errors};
};

// Waits until the card has drawn and every line for the selected period is either priced or marked unavailable (polling, bounded
// by the expect timeout).
export const settled = async (page) => {
  await expect.poll(() => page.evaluate(() => {
    const c = window.card;
    if (!c?._data || !c._main || c._drawing || c._updating) return 'drawing';
    const [a, b] = c._period(), v = c._view(a, b);
    const waiting = v.filter((l) => !l.na && l.total == null).map((l) => l.key);
    return waiting.length ? 'waiting for ' + waiting.join(', ') : 'ok';
  })).toBe('ok');
};

// Legend entries as shown: text, tooltip, unavailable, still loading, hidden, width, cursor.
export const legend = (page) => page.evaluate(() => [...window.card.shadowRoot.querySelectorAll('.main .apexcharts-legend-series')].map((e) => ({
  text: e.textContent.replace(/\s+/g, ' ').trim(), title: e.title, na: e.classList.contains('na'), loading: e.classList.contains('loading'),
  hidden: e.classList.contains('apexcharts-inactive-legend'), width: Math.round(e.getBoundingClientRect().width),
  cursor: getComputedStyle(e.querySelector('.apexcharts-legend-text')).cursor})));

// Lines of the selected period: key, total (GBP, null while loading or unavailable), na.
export const lines = (page) => page.evaluate(() => {
  const c = window.card, [a, b] = c._period();
  return {a, b, start: c._data.start, end: c._data.end, fuels: c._data.fuels,
    lines: c._view(a, b).map((l) => ({key: l.key, label: l.label, total: l.total, na: l.na || null, tip: l.tip}))};
});

export const cardHeight = (page) => page.evaluate(() => Math.round(window.card.shadowRoot.querySelector('ha-card').getBoundingClientRect().height));

export const clickFuel = async (page, fuel) => {
  const mode = await page.evaluate((f) => { const c = window.card; c.shadowRoot.querySelector(`[data-fuel=${f}]`).click(); return c._fuels().join('+'); }, fuel);
  await expect.poll(() => page.evaluate(() => window.card._data.mode)).toBe(mode);
  await settled(page);
};

// Drags the brush selection by dx pixels (negative: left).
export const dragBrush = async (page, dx) => {
  const rect = page.locator('.brush .apexcharts-selection-rect');
  const box = await rect.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, {steps: 12});
  await page.mouse.up();
  await settled(page);
};

// Calendar months (UTC, 'YYYY-MM') of the unit-rate lists requested for a product code.
export const monthsFetched = (api, codePrefix) => [...new Set(api.filter((u) => u.includes('/standard-unit-rates/') && new URL(u).pathname.split('/')[3].startsWith(codePrefix))
  .map((u) => new URL(u).searchParams.get('period_from')?.slice(0, 7)).filter(Boolean))].sort();
