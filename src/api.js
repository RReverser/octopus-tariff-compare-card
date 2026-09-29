// Octopus products API access: a cap on concurrent requests, parallel pagination, and caching.
//
// Caching: every list is kept in memory for the page's lifetime. Lists that can no longer change (prices for a month that has
// ended) are also requested with cache: 'force-cache', so the browser's HTTP cache serves them across reloads even after the API's
// 5-minute max-age runs out. Unlike Cache Storage, this also works on plain-http Home Assistant installs.

export const API = 'https://api.octopus.energy/v1/products/';

// At most MAX_INFLIGHT requests at a time: the first load fans out over every tariff, month and page.
const MAX_INFLIGHT = 6;
let inflight = 0;
const waiting = [];
const acquire = () => (inflight < MAX_INFLIGHT ? (inflight++, Promise.resolve()) : new Promise((r) => waiting.push(r)));
// A freed slot passes straight to the newest waiter: when the brush moves on, the months it is on now are fetched before any it
// passed over earlier.
const release = () => { const next = waiting.pop(); if (next) next(); else inflight--; };

// One page as JSON. immutable: the page cannot change any more, so any cached copy is used, however old.
export const getJSON = async (url, immutable = false) => {
  await acquire();
  try {
    const r = await fetch(url, immutable ? {cache: 'force-cache'} : undefined);
    if (!r.ok) throw new Error(`Octopus API ${r.status} for ${url}`);
    return await r.json();
  } finally { release(); }
};

// Every result of a paginated list. The first page gives the total, then all remaining pages are requested together.
export const fetchAll = async (url, immutable = false) => {
  const first = await getJSON(url, immutable);
  const res = [...(first.results || [])];
  if (!first.next || !res.length) return res;
  const pages = Math.ceil(first.count / res.length), next = new URL(first.next);
  const rest = await Promise.all(Array.from({length: Math.max(0, pages - 1)}, (_, i) => {
    next.searchParams.set('page', i + 2);
    return getJSON(next.href, immutable);
  }));
  for (const j of rest) res.push(...(j.results || []));
  // The list grew while it was being read (or reported no count): follow the remaining links one by one.
  for (let u = rest.length ? rest[rest.length - 1].next : first.next; u;) { const j = await getJSON(u, immutable); res.push(...(j.results || [])); u = j.next; }
  return res;
};

// Lists by URL: for the page's lifetime if immutable, else for as long as the API allows caching them (5 minutes), so a refresh
// sees newly published prices. A failed fetch is forgotten so the next refresh retries it.
const FRESH_MS = 5 * 60e3;
const memo = {};
export const cachedList = (url, immutable = false) => {
  const m = memo[url];
  if (m && (immutable || Date.now() - m.t < FRESH_MS)) return m.p;
  const p = fetchAll(url, immutable).catch((e) => { if (memo[url]?.p === p) delete memo[url]; throw e; });
  memo[url] = {p, t: Date.now()};
  return p;
};
