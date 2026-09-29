// The brush on a touch screen. apexcharts replaces the selection's end handles while one is being dragged; touch events keep going
// to the replaced handle, so the card passes them on (see the touchstart listener in the card).
import {test, expect} from '@playwright/test';
import {open, settled, lines, monthsFetched} from './helpers.mjs';
import {DAY} from './fake/world.mjs';

test.use({viewport: {width: 412, height: 900}, hasTouch: true, isMobile: true});

const rect = (page) => page.evaluate(() => { const r = window.card.shadowRoot.querySelector('.brush .apexcharts-selection-rect'); return {x: +r.getAttribute('x'), w: +r.getAttribute('width')}; });
const centre = (page, sel) => page.evaluate((s) => { const b = window.card.shadowRoot.querySelector(s).getBoundingClientRect(); return {x: b.x + b.width / 2, y: b.y + b.height / 2}; }, sel);

// Touches at `from` and slides by dx in small steps, as a finger would.
const swipe = async (page, from, dx) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: from.x, y: from.y, id: 1}]});
  const steps = Math.ceil(Math.abs(dx) / 5);
  for (let i = 1; i <= steps; i++) await cdp.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x: from.x + dx * i / steps, y: from.y, id: 1}]});
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
  await settled(page);
};

test('an end of the selection follows the finger all the way, and the new months load when let go', async ({page}) => {
  const {api} = await open(page, 'long');
  const before = await rect(page);
  await swipe(page, await centre(page, '.brush .svg_select_handle_l'), -100);
  const after = await rect(page);
  expect(before.x - after.x).toBeCloseTo(100, 0);
  expect(after.w - before.w).toBeCloseTo(100, 0);
  expect(await page.evaluate(() => window.card._dragging)).toBe(false);
  const {a, b} = await lines(page);
  expect(b - a).toBeGreaterThan(60 * DAY);
  // The period's totals are all in (settled), including months it now reaches back to.
  expect(monthsFetched(api, 'AGILE')[0] <= new Date(a).toISOString().slice(0, 7)).toBe(true);
  // The other end too, and it stops at the end of the data.
  await swipe(page, await centre(page, '.brush .svg_select_handle_r'), 300);
  const p = await lines(page);
  expect(p.b).toBe(p.end);
});

test('the whole selection can be slid with a finger', async ({page}) => {
  await open(page, 'long');
  const before = await rect(page);
  await swipe(page, await centre(page, '.brush .apexcharts-selection-rect'), -150);
  const after = await rect(page);
  expect(before.x - after.x).toBeCloseTo(150, 0);
  expect(after.w).toBeCloseTo(before.w, 0);
});
