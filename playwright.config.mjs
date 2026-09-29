import {defineConfig} from '@playwright/test';

// The card and the reference costs work in local time: run both the browser and Node in the UK time zone.
process.env.TZ = 'Europe/London';

export default defineConfig({
  testDir: 'tests',
  testMatch: '*.spec.mjs',
  timeout: 60e3,
  expect: {timeout: 20e3},
  fullyParallel: true,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {browserName: 'chromium', timezoneId: 'Europe/London', locale: 'en-GB', viewport: {width: 1280, height: 1000}},
});
