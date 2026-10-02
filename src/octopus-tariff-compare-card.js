// Octopus Tariff Compare card for Home Assistant: what your own metered usage would have cost on every Octopus Energy import tariff
// available in your region, as a running difference against the tariff you are on now.
//
// Costs are worked out per calendar month (UTC), per fuel and tariff, and kept for the page's lifetime. Your current tariff is costed
// over the whole history (default: the last year), for the brush chart under the main chart, which picks the period. Other tariffs
// are costed only for the months the selected period covers: moving the brush to months not seen yet loads them, and each line
// appears once its months are in.
import ApexCharts from 'apexcharts';
import {FUELS, curKey, families, onFamiliesChanged, consumption, months, priceMonth, merge, thin, detectEntities} from './octopus.js';
import {agreementStarts} from './agreements.js';

const VERSION = '0.1.0';
const COLORS = {VAR: '#607d8b', SILVER: '#4caf50', AGILE: '#ff9800', 'OE-FIX-12M': '#e91e63', 'OE-FIX-18M': '#9c27b0'};
const EXTRA = ['#2196f3', '#00bcd4', '#795548', '#cddc39', '#ff5722', '#3f51b5', '#009688', '#ffc107', '#8bc34a', '#f44336', '#673ab7'];
const MAX_POINTS = 1000;  // per line in the main chart; lines are running totals, so thinning keeps their shape
const REFRESH_MS = 15 * 60e3;
const DAY = 864e5, HOUR = 36e5;
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const utcMonth = (t) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
const DEFAULTS = {default_visible: ['OE-FIX-12M', 'OE-FIX-18M', 'SILVER'], default_days: 30, default_fuel: 'electricity',
  history_days: 365, height: 380, brush_height: 110};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
// Index of the last point at or before t (0 if none).
const idxAt = (pts, t) => {
  let lo = 0, hi = pts.length - 1, r = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (pts[mid][0] <= t) { r = mid; lo = mid + 1; } else hi = mid - 1; }
  return r;
};
let seq = 0;

class OctopusTariffCompareCard extends HTMLElement {
  static getStubConfig() { return {}; }

  setConfig(config) {
    this._config = {...DEFAULTS, ...config};
    this._storageKey = 'octopus-tariff-compare-card:' + (config.storage_key || 'default');
    this._state = this._load();
    this._id = this._id || 'octopus-tariff-compare-' + ++seq;
    this._sig = null;
    if (this._hass) { this._renderShell(); this._refresh(); }
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._renderShell();
    const ents = this._entities();
    const sig = JSON.stringify(FUELS.map((f) => { const a = ents[f] && hass.states[ents[f].rate]?.attributes; return a && (a.tariff || a.tariff_code); }));
    if (sig !== this._sig) { this._sig = sig; this._refresh(); }
  }

  connectedCallback() {
    clearInterval(this._timer);
    this._unsubFamilies?.();
    // A background refresh of a day-old tariff list found changes: rebuild the lines from it.
    this._unsubFamilies = onFamiliesChanged(() => this._refresh());
    this._timer = setInterval(() => this._refresh(), REFRESH_MS);
    if (this._hass && this._data && !this._main) this._redraw();
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    this._unsubFamilies?.();
    this._unsubFamilies = null;
    this._destroyCharts();
  }

  getCardSize() { return 10; }
  getGridOptions() { return {columns: 'full', rows: 'auto', min_columns: 6}; }

  // ---- per-browser state (localStorage): fuels, period, shown tariffs ----
  _load() { try { return JSON.parse(localStorage.getItem(this._storageKey)) || {}; } catch { return {}; } }
  _save() { try { localStorage.setItem(this._storageKey, JSON.stringify(this._state)); } catch { /* storage unavailable: state lasts for this page only */ } }

  _entities() {
    const c = this._config, auto = this._hass ? detectEntities(this._hass) : {};
    const pick = (f) => (c[f] ? {rate: c[f].rate, consumption: c[f].consumption} : auto[f]);
    return {electricity: pick('electricity'), gas: pick('gas')};
  }

  _fuels() {
    const ents = this._entities(), available = FUELS.filter((f) => ents[f]);
    const fuels = (this._state.fuels || [this._config.default_fuel]).filter((f) => available.includes(f));
    return fuels.length ? fuels : available.slice(0, 1);
  }

  _visibleKeys(mode) { return new Set(this._state.visible?.[mode] || this._config.default_visible); }

  // Selected period [a, b] in ms. Stored as "the last N days" when it ends at the latest data (so it keeps rolling), else as fixed dates.
  _period() {
    const d = this._data, p = this._state.period;
    if (!d) return null;
    const end = d.end;
    let a, b;
    if (p?.days) { b = end; a = Math.max(d.start, end - p.days * DAY); } else if (p?.from) { a = Math.max(d.start, p.from); b = Math.min(end, p.to); }
    if (!(a < b)) { b = end; a = Math.max(d.start, end - this._config.default_days * DAY); }
    return [a, b];
  }

  _setPeriod(a, b) {
    const d = this._data;
    this._state.period = b >= d.end - 3600e3 ? {days: Math.max(1, Math.round((b - a) / DAY))} : {from: Math.round(a), to: Math.round(b)};
    this._save();
  }

  // ---- UI ----
  _renderShell() {
    if (!this._hass || !this._config) return;
    if (!this.shadowRoot) this.attachShadow({mode: 'open'});
    const ents = this._entities(), fuels = this._fuels();
    const chip = (f, label) => ents[f]
      ? `<button class="chip${fuels.includes(f) ? ' on' : ''}" data-fuel="${f}" aria-pressed="${fuels.includes(f)}">${label}</button>` : '';
    this._destroyCharts();
    this.shadowRoot.innerHTML = `<style>
      ha-card { padding: 16px; }
      .head { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: space-between; }
      .title { font-size: 20px; color: var(--primary-text-color); }
      .group { display: flex; gap: 6px; }
      .sub { font-size: 13px; color: var(--secondary-text-color); margin: 6px 0 4px; }
      .chip { font: inherit; font-size: 14px; cursor: pointer; border-radius: 10px; padding: 6px 12px; border: 1px solid var(--divider-color);
        background: none; color: var(--primary-text-color); }
      .chip.on { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
      .status { font-size: 13px; color: var(--secondary-text-color); min-height: 18px; }
      .error { color: var(--error-color); }
      .main { min-height: ${this._config.height}px; }
      .brush { min-height: ${this._config.brush_height}px; }
      /* The first legend entry is your current tariff: dashed, like its line, and always shown. */
      .main .apexcharts-legend-series[rel="1"] .apexcharts-legend-text { text-decoration: underline dashed; text-decoration-thickness: 2px; text-underline-offset: 3px; }
      .main .apexcharts-legend-text { font-variant-numeric: tabular-nums; }
      /* Cursors: clickable entries a pointer, your current tariff (always shown) the default arrow, unavailable ones not-allowed. */
      .main .apexcharts-legend-series, .main .apexcharts-legend-series * { cursor: pointer; }
      .main .apexcharts-legend-series[rel="1"], .main .apexcharts-legend-series[rel="1"] * { cursor: default; }
      .main .apexcharts-legend-series.na, .main .apexcharts-legend-series.na * { cursor: not-allowed; }
      .main .apexcharts-legend-series .price { display: inline-grid; justify-items: start; }
      .main .apexcharts-legend-series .price > * { grid-area: 1 / 1; }
      .main .apexcharts-legend-series .price > .blank { visibility: hidden; }
      /* Bigger ends of the brush selection on touch screens. */
      @media (pointer: coarse) { .brush .svg_select_handle_l, .brush .svg_select_handle_r { r: 10px; } }
      .apexcharts-tooltip { color: #000; }
    </style><ha-card>
      <div class="head"><div class="title">${esc(this._config.title || 'Octopus tariff comparison')}</div>
        <div class="group">${chip('electricity', 'Electricity')}${chip('gas', 'Gas')}</div></div>
      <div class="sub">Your metered usage priced on each tariff: running cost difference vs your current tariff (dashed; + = dearer).
        Legend: total cost for the selected period (click to show or hide). Drag or resize the selection in the lower chart to pick the period.</div>
      <div class="status" id="status"></div>
      <div class="main" id="main"></div>
      <div class="brush" id="brush"></div>
    </ha-card>`;
    this.shadowRoot.querySelectorAll('[data-fuel]').forEach((b) => b.addEventListener('click', () => this._toggleFuel(b.dataset.fuel)));
    const brushEl = this.shadowRoot.getElementById('brush');
    // While the brush is being dragged, only months already loaded are shown: the months it passes over are not fetched, just the
    // ones it is let go on. The end of a touch can arrive only at the touched element (see below), so it is listened for there too.
    brushEl.addEventListener('pointerdown', (e) => {
      this._dragging = true;
      const done = () => {
        if (!this._dragging) return;
        this._dragging = false;
        this._updateMain();
      };
      for (const t of [window, e.target]) for (const type of ['pointerup', 'pointercancel']) t.addEventListener(type, done, {once: true, capture: true});
    });
    // apexcharts 4.7 replaces the selection's resize handles after every step of a resize. With a mouse that does not matter, but
    // touch events keep going to the element the touch started on: once that handle is out of the page, they no longer reach the
    // window, where the resize listens, so a finger could only move an end by one step at a time. They are passed on to the window
    // from the old handle.
    brushEl.addEventListener('touchstart', (e) => {
      const h = e.target;
      if (!h.classList?.contains('svg_select_handle') || typeof TouchEvent === 'undefined') return;
      const pass = (ev) => {
        if (ev.type !== 'touchmove') for (const type of ['touchmove', 'touchend', 'touchcancel']) h.removeEventListener(type, pass);
        if (h.isConnected) return;  // still in the page: the event reaches the window by itself
        dispatchEvent(new TouchEvent(ev.type, {touches: [...ev.touches], targetTouches: [...ev.targetTouches], changedTouches: [...ev.changedTouches], cancelable: true}));
      };
      for (const type of ['touchmove', 'touchend', 'touchcancel']) h.addEventListener(type, pass);
    }, {capture: true});
    if (this._data) this._redraw();
  }

  _toggleFuel(fuel) {
    const on = new Set(this._fuels());
    on.has(fuel) ? on.delete(fuel) : on.add(fuel);
    if (!on.size) return;  // at least one fuel stays on
    this._state.fuels = FUELS.filter((f) => on.has(f));
    this._save();
    const fuels = this._fuels();
    this.shadowRoot.querySelectorAll('[data-fuel]').forEach((b) => { const x = fuels.includes(b.dataset.fuel); b.classList.toggle('on', x); b.setAttribute('aria-pressed', x); });
    this._refresh();
  }

  _status(text, error = false) {
    const el = this.shadowRoot?.getElementById('status');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('error', error);
  }

  // ---- data ----
  // Loads your usage and the tariff list, then your current tariff's cost for every month of the history. Other tariffs are costed
  // on demand by _view. Periodic refreshes (new usage) recompute only months that can still change, and keep showing the previous
  // figures until then.
  async _refresh() {
    if (!this._hass || !this._config || !this.shadowRoot) return;
    const token = (this._token = (this._token || 0) + 1);
    const hass = this._hass, ents = this._entities(), fuels = this._fuels();
    if (!fuels.length) {
      this._status('No Octopus Energy meter found: install the Octopus Energy integration, or set electricity / gas entities in the card config.', true);
      return;
    }
    if (!this._data) this._status('Loading…');  // later refreshes keep showing the chart, so they need no message
    try {
      const now = Date.now(), a0 = startOfDay(now - this._config.history_days * DAY);
      const attrs = (f) => hass.states[ents[f].rate]?.attributes || {};
      const tariff = (f) => attrs(f).tariff || attrs(f).tariff_code || '';
      const cur = Object.fromEntries(fuels.map((f) => [f, curKey(tariff(f))]));
      const [fams, starts, usage] = await Promise.all([families(tariff(fuels[0]).slice(-1)), agreementStarts(hass),
        Promise.all(fuels.map((f) => consumption(hass, ents[f].consumption, a0, now)))]);
      if (usage.some((u) => !u.length)) throw new Error('no consumption statistics found for your meter');
      // Readings by fuel and calendar month (UTC, the months prices are requested in; readings never cross a month boundary).
      const byMonth = {};
      fuels.forEach((f, i) => {
        const m = (byMonth[f] = new Map());
        for (const r of usage[i]) { const k = utcMonth(r[0]); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
      });
      // What pricing a fuel needs besides the tariff: region, current product, and (for fixes) when the current agreement began.
      const ctx = Object.fromEntries(fuels.map((f, i) => [f, {fuel: f, reg: tariff(f).slice(-1), curProd: tariff(f).split('-').slice(2, -1).join('-'),
        signup: starts[tariff(f)] ?? null, dataStart: usage[i][0][0]}]));
      const labelOf = (k) => (fams.find((f) => f.key === k) || {}).label || k;
      const nameOf = (k) => (fams.find((f) => f.key === k) || {}).name || k;
      const colour = (k) => COLORS[k] || EXTRA[Math.max(0, fams.findIndex((f) => f.key === k)) % EXTRA.length];
      const same = fuels.every((f) => cur[f] === cur[fuels[0]]);
      const lines = [{key: 'CURRENT', label: same ? labelOf(cur[fuels[0]]) : fuels.map((f) => `${labelOf(cur[f])} ${f}`).join(' + '), colour: colour(cur[fuels[0]]),
        head: same ? nameOf(cur[fuels[0]]) : fuels.map((f) => `${cap(f)}: ${nameOf(cur[f])}`).join('\n')}];
      // Every tariff offered for any of the user's fuels is listed, whichever fuels are selected, so the legend keeps the same entries
      // when fuels are switched. One that does not supply all the selected fuels is marked unavailable (na) and not costed.
      const avail = FUELS.filter((f) => ents[f]).map((f) => f[0]);
      for (const f of fams) {
        if (!avail.some((c) => f.fuels.includes(c)) || (same && f.key === cur[fuels[0]])) continue;
        const na = fuels.every((fu) => f.fuels.includes(fu[0])) ? null : `Not offered for ${fuels.filter((fu) => !f.fuels.includes(fu[0])).join(' and ')}`;
        lines.push({key: f.key, label: f.label, colour: colour(f.key), na, head: nameOf(f.key)});
      }
      const data = {mode: fuels.join('+'), fuels, lines, ctx, byMonth, gen: (this._gen = (this._gen || 0) + 1),
        start: Math.min(...usage.map((u) => u[0][0])), end: Math.max(...usage.map((u) => u[u.length - 1][1]))};
      // The current tariff over the whole history: the baseline of every line, and the brush chart.
      const all = [];
      for (const f of fuels) for (const [m0, m1] of months(data.start, data.end)) if (byMonth[f].has(m0)) all.push(this._month(data, 'CURRENT', f, m0, m1).p);
      await Promise.all(all);
      if (token !== this._token) return;
      const base = this._cost(data, lines[0], data.start, data.end, false);
      if (!base.cum) throw new Error(base.why ? 'your current tariff: ' + base.why : 'could not price your current tariff');
      this._data = data;
      this._status('');
      this._redraw();
    } catch (err) {
      if (token === this._token) this._status('Could not load: ' + (err.message || err), true);
    }
  }

  // One month's cost of tariff K for one fuel, from the page-lifetime store: {val, p}. val is the result once loaded
  // ({rows, basis} or {why}); p is the pending load. Months that ended over a day ago are loaded once; later months again on every
  // refresh (their val keeps the previous result until then), and so is a month whose load failed.
  _month(data, K, fuel, m0, m1) {
    const c = data.ctx[fuel];
    const key = [fuel, c.reg, c.curProd, c.signup, K, m0].join('|');
    const store = (this._store ||= new Map());
    let e = store.get(key);
    if (!e) store.set(key, (e = {}));
    // Only a newer refresh reloads a month: views of the data being replaced keep using what is there.
    const settled = m1 < Date.now() - DAY && e.val && !e.failed;
    if (e.gen !== undefined && (e.gen >= data.gen || settled)) return e;
    e.gen = data.gen;
    const p = (e.p = priceMonth({...c, K}, m0, m1, data.byMonth[fuel].get(m0) || []).then(
      (v) => ({v, failed: false}), (err) => ({v: {why: 'could not load prices: ' + (err.message || err)}, failed: true})).then(({v, failed}) => {
      if (e.p !== p) return;
      e.val = v; e.failed = failed;
      if (data === this._data) this._dataArrived();
    }));
    return e;
  }

  // Cost of a line over (a, b]: {cum: [[t, GBP running total from a], ...] on the readings' end times, basis: {fuel: [tooltip line]}},
  // {why} if a month cannot be priced, or {pending: true} while months are loading (load: start loading them).
  _cost(data, l, a, b, load = true) {
    const parts = [], basis = {};
    let pending = false, why = null;
    for (const f of data.fuels) {
      const got = [];
      for (const [m0, m1] of months(a - HOUR, b)) {
        if (!data.byMonth[f].has(m0)) continue;
        const e = load ? this._month(data, l.key, f, m0, m1) : this._store?.get([f, data.ctx[f].reg, data.ctx[f].curProd, data.ctx[f].signup, l.key, m0].join('|'));
        if (!e?.val) { pending = true; continue; }
        if (e.val.why) { why ||= e.val.why; continue; }
        got.push(e.val);
      }
      const cum = [[a, 0]];
      let sum = 0;
      for (const v of got) for (const [t, gbp] of v.rows) if (t > a && t <= b) { sum += gbp; cum.push([t, sum]); }
      parts.push(cum);
      basis[f] = [...new Set(got.flatMap((v) => v.basis))];
    }
    if (why) return {why};
    if (pending) return {pending: true};
    return {cum: parts.reduce(merge), basis};
  }

  // Legend tooltip lines after the name: what each fuel was priced from, merged into one unlabelled block when all fuels share it.
  _tipLines(fuels, texts) {
    return texts.every((x) => x === texts[0]) ? [texts[0]] : texts.map((x, i) => `${cap(fuels[i])}: ${x.replace(/\n/g, '\n    ')}`);
  }

  // Lines for period [a, b]: running difference vs the current tariff from a, thinned; totals over the period; tooltip; unavailable
  // (na) with the reason; or still loading (no values, no total).
  // Every line has a point at the same times, with no value (null) where it has none: apexcharts shows a shared tooltip (every line's
  // value at the hovered time) only when all series have the same number of points.
  _view(a, b) {
    const d = this._data, load = !this._dragging;
    const base = this._cost(d, d.lines[0], a, b, load);
    const bc = base.cum || [[a, 0]];
    const blank = thin(bc.map(([t]) => [t, null]), MAX_POINTS);
    return d.lines.map((l, i) => {
      if (l.na) return {...l, points: blank, total: null, tip: `${l.head}\n${l.na}\nCode: ${l.key}`};
      const r = i === 0 ? base : this._cost(d, l, a, b, load);
      if (r.why) return {...l, na: 'Cannot be priced', points: blank, total: null, tip: `${l.head}\n${cap(r.why)}\nCode: ${l.key}`};
      if (!r.cum || !base.cum) return {...l, points: blank, total: null, tip: `${l.head}\nLoading prices…`};
      const pts = bc.map(([t, v]) => [t, Math.round((r.cum[idxAt(r.cum, t)][1] - v) * 100) / 100]);
      const tip = [l.head, ...this._tipLines(d.fuels, d.fuels.map((f) => r.basis[f].map(cap).join('\n')))].join('\n');
      return {...l, points: thin(pts, MAX_POINTS), total: r.cum[r.cum.length - 1][1], tip};
    });
  }

  // Prices for more months arrived: update the main chart once for all that arrive together.
  _dataArrived() {
    if (this._arrivalQueued) return;
    this._arrivalQueued = true;
    queueMicrotask(() => { this._arrivalQueued = false; this._updateMain(); });
  }

  // Daily cost on the current tariff, for the brush chart, running to the latest data. Partial first and last
  // days are scaled to a per-day rate so they are comparable with whole days.
  _daily() {
    const {start, end} = this._data, base = this._cost(this._data, this._data.lines[0], start, end, false).cum, out = [];
    for (let t = startOfDay(start); t < end; t += DAY) {
      const t0 = Math.max(t, start), t1 = Math.min(t + DAY, end);
      const cost = base[idxAt(base, t1)][1] - base[idxAt(base, t0)][1];
      out.push([t0, Math.round((cost * DAY) / (t1 - t0) * 100) / 100]);
    }
    if (out.length) out.push([end, out[out.length - 1][1]]);
    return out;
  }

  _yRange() {
    const vis = this._visibleKeys(this._data.mode);
    let M = 0.01;
    (this._viewLines || []).forEach((l, i) => { if (i === 0 || vis.has(l.key)) for (const [, v] of l.points) M = Math.max(M, Math.abs(v)); });
    return M * 1.05;
  }

  _destroyCharts() {
    this._main?.destroy(); this._brush?.destroy();
    this._main = this._brush = this._chartKeys = null;
  }

  _theme() {
    const css = getComputedStyle(this);
    return {fg: css.getPropertyValue('--primary-text-color').trim() || undefined, grid: css.getPropertyValue('--divider-color').trim() || undefined,
      mode: this._hass.themes?.darkMode ? 'dark' : 'light'};
  }

  _mainSeriesOptions(view) {
    return {
      series: view.map((l) => ({name: l.label, data: l.points})),
      colors: view.map((l) => l.colour),
      stroke: {width: 2, curve: 'straight', dashArray: view.map((_, i) => (i === 0 ? 6 : 0))},
    };
  }

  _applyVisibility() {
    const vis = this._visibleKeys(this._data.mode), w = this._main?.w;
    if (!w) return;
    this._viewLines.forEach((l, i) => {
      const hidden = w.globals.collapsedSeriesIndices.includes(i), want = i === 0 || (vis.has(l.key) && !l.na);
      if (want === hidden) this._main.toggleSeries(l.label);
    });
    this._markLegend();
  }

  // Every entry gets its tooltip (full name, code, what it was priced from). Unavailable tariffs also get "N/A" in place of the price
  // (apexcharts already greys them as hidden series), with the reason in the tooltip. "N/A" is laid over the blank price placeholder, so the entry keeps its width. Clicks on elements inside the legend text are
  // ignored by apexcharts, which is fine here as these entries are not clickable anyway. The legend is rebuilt on every chart
  // update, so this is reapplied each time.
  _markLegend() {
    this.shadowRoot?.querySelectorAll('.main .apexcharts-legend-series').forEach((el) => {
      const l = this._viewLines?.[+el.getAttribute('rel') - 1];
      el.classList.toggle('na', !!l?.na);
      if (l?.tip) el.title = l.tip; else el.removeAttribute('title');
      if (!l?.na) return;
      const text = el.querySelector('.apexcharts-legend-text'), head = l.label + '  ';
      if (!text || text.querySelector('.price') || !text.textContent.startsWith(head)) return;
      const price = document.createElement('span'), blank = document.createElement('span'), na = document.createElement('span');
      price.className = 'price';
      blank.className = 'blank';
      blank.textContent = text.textContent.slice(head.length);
      na.textContent = 'N/A';
      price.append(blank, na);
      text.replaceChildren(head, price);
    });
  }

  // Draws are serialised: a draw requested while one is running happens once it finishes (coalescing any number of requests).
  _redraw() {
    if (this._drawing) { this._drawAgain = true; return; }
    this._drawing = (async () => {
      try { do { this._drawAgain = false; await this._updating; await this._draw(); } while (this._drawAgain); } finally { this._drawing = null; }
    })();
  }

  async _draw() {
    const mainEl = this.shadowRoot?.getElementById('main'), brushEl = this.shadowRoot?.getElementById('brush');
    if (!mainEl || !this._data) return;
    const [a, b] = this._period();
    this._viewLines = this._view(a, b);
    const th = this._theme(), view = this._viewLines;
    const main = {
      chart: {id: this._id, type: 'line', height: this._config.height, background: 'transparent', foreColor: th.fg, fontFamily: 'inherit',
        animations: {enabled: false}, zoom: {enabled: false}, toolbar: {show: false},
        events: {legendClick: (_, i) => this._legendClick(i)}},
      theme: {mode: th.mode},
      ...this._mainSeriesOptions(view),
      markers: {size: 0}, dataLabels: {enabled: false}, grid: {borderColor: th.grid},
      legend: {position: 'top', fontSize: '14px', itemMargin: {horizontal: 10, vertical: 4}, onItemClick: {toggleDataSeries: false},
        // Plain text only: apexcharts ignores clicks whose target is an element inside the legend text.
        // Tariffs still loading keep the width of the current tariff's price (figure space = one digit, punctuation space = '.'),
        // so the legend does not reflow when their prices arrive.
        formatter: (name, o) => {
          const t = this._viewLines[o.seriesIndex]?.total, ref = '£' + (this._viewLines[0]?.total ?? 0).toFixed(2);
          return `${name}  ${t == null ? ref.replace(/\d/g, '\u2007').replace('.', '\u2008') : '£' + t.toFixed(2)}`;
        }},
      xaxis: {type: 'datetime', min: a, max: b, labels: {datetimeUTC: false}},
      yaxis: {min: () => -this._yRange(), max: () => this._yRange(), tickAmount: 6, labels: {formatter: (v) => v.toFixed(2)},
        title: {text: '£ vs current tariff (+ = dearer)'}},
      tooltip: {shared: true, intersect: false, x: {format: 'ddd dd MMM HH:mm'},
        y: {formatter: (v) => (v == null ? '…' : (v > 0 ? '+' : v < 0 ? '−' : '') + '£' + Math.abs(v).toFixed(2))}},
    };
    const brush = {
      chart: {type: 'area', height: this._config.brush_height, background: 'transparent', foreColor: th.fg, fontFamily: 'inherit',
        animations: {enabled: false}, toolbar: {show: false, autoSelected: 'selection'},
        brush: {enabled: true, target: this._id, autoScaleYaxis: false},
        selection: {enabled: true, xaxis: {min: a, max: b}, fill: {opacity: 0.15}},
        events: {selection: (_, s) => this._onBrush(s), brushScrolled: (_, s) => this._onBrush(s),
          mounted: (c) => this._clampResize(c), updated: (c) => this._clampResize(c)}},
      theme: {mode: th.mode},
      series: [{name: 'Daily cost on your current tariff', data: this._daily()}],
      colors: [view[0].colour], stroke: {width: 1}, fill: {type: 'solid', opacity: 0.3}, dataLabels: {enabled: false},
      grid: {borderColor: th.grid}, legend: {show: false},
      xaxis: {type: 'datetime', min: this._data.start, max: this._data.end, labels: {datetimeUTC: false}, tooltip: {enabled: false}},
      yaxis: {tickAmount: 2, labels: {formatter: (v) => '£' + v.toFixed(2)}, title: {text: '£/day'}},
      tooltip: {x: {format: 'ddd dd MMM'}, y: {formatter: (v) => '£' + v.toFixed(2)}},
    };
    // Charts are always updated in place, so switching fuels does not empty them (which would make the page jump). A different set
    // of tariffs (fuel change): apexcharts keeps hidden-series state by index across updates, so that state is cleared first and
    // each series' visibility is passed with the update.
    const keys = view.map((l) => l.key).join();
    if (keys !== this._chartKeys) {
      const vis = this._visibleKeys(this._data.mode);
      main.series.forEach((s, i) => { s.hidden = i > 0 && !vis.has(view[i].key); });
    }
    if (this._main) {
      if (keys !== this._chartKeys) this._main.resetSeries(false, false);
      this._chartKeys = keys;
      await this._main.updateOptions(main, false, false);
      await this._brush.updateOptions(brush, false, false);
    } else {
      this._chartKeys = keys;
      this._main = new ApexCharts(mainEl, main);
      this._brush = new ApexCharts(brushEl, brush);
      await this._main.render();
      await this._brush.render();
    }
    this._applyVisibility();
  }

  // Brush moved or resized: store the new period and update the main chart (throttled to one frame). The period is read from the
  // selection rectangle itself: apexcharts' resize events report the size from before the change.
  _onBrush(s) {
    if (!this._data) return;
    this._pendingSel = s?.xaxis;
    if (this._frame) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = null;
      const [a, b] = this._brushRange();
      if (!(a < b)) return;
      this._setPeriod(a, b);
      this._updateMain();
    });
  }

  // Main chart only (lines, totals, x range) for the stored period; the brush chart is left alone, so a drag in progress is not
  // disturbed. Serialised like _redraw, and folded into a full redraw when one is running.
  _updateMain() {
    if (this._drawing) { this._drawAgain = true; return; }
    if (this._updating) { this._updateAgain = true; return; }
    this._updating = (async () => {
      try {
        do {
          this._updateAgain = false;
          if (!this._main || !this._data) return;
          const [a, b] = this._period();
          this._viewLines = this._view(a, b);
          await this._main.updateOptions({...this._mainSeriesOptions(this._viewLines), xaxis: {min: a, max: b}}, false, false);
          this._applyVisibility();
        } while (this._updateAgain);
      } finally { this._updating = null; }
    })();
  }

  _brushRange() {
    const {start, end} = this._data, g = this._brush?.w.globals, rect = this.shadowRoot?.querySelector('.brush .apexcharts-selection-rect');
    const x = parseFloat(rect?.getAttribute('x')), w = parseFloat(rect?.getAttribute('width'));
    let a, b;
    if (g?.gridWidth > 0 && w > 0 && Number.isFinite(x)) {
      const k = (g.maxX - g.minX) / g.gridWidth;
      [a, b] = [g.minX + x * k, g.minX + (x + w) * k];
    } else ({min: a, max: b} = this._pendingSel || {});
    return [Math.max(start, a), Math.min(end, b)];
  }

  // apexcharts 4.7 keeps a dragged selection inside the chart but not a resized one, so resizing is clamped here (and reported).
  _clampResize(chart) {
    const rect = chart?.zoomPanSelection?.selectionRect;
    if (!rect || rect.otcClamp) return;
    rect.otcClamp = true;
    rect.on('resize.otc', (e) => {
      const {box} = e.detail, gw = chart.w.globals.gridWidth;
      const x0 = Math.max(0, box.x), x1 = Math.min(gw, box.x + box.width);
      e.preventDefault();
      if (x1 - x0 >= 1) rect.size(x1 - x0, box.height).move(x0, box.y);
      this._onBrush(null);  // apexcharts does not reliably report the end of a resize
    });
  }

  _legendClick(i) {
    const d = this._data;
    if (!d || i <= 0 || i >= this._viewLines.length || this._viewLines[i].na) return;  // current tariff: always shown; unavailable: never
    const l = this._viewLines[i], vis = this._visibleKeys(d.mode);
    vis.has(l.key) ? vis.delete(l.key) : vis.add(l.key);
    this._state.visible = {...(this._state.visible || {}), [d.mode]: [...vis]};
    this._save();
    this._main.toggleSeries(l.label);
    this._markLegend();
  }
}

customElements.define('octopus-tariff-compare-card', OctopusTariffCompareCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'octopus-tariff-compare-card', name: 'Octopus Tariff Compare', preview: false,
  description: 'What your metered usage would cost on every Octopus Energy tariff in your region, vs your current one.',
  documentationURL: 'https://github.com/RReverser/octopus-tariff-compare-card',
});
console.info(`%c OCTOPUS-TARIFF-COMPARE-CARD %c ${VERSION} `, 'color: white; background: #5840ff; font-weight: bold', 'color: #5840ff; background: white');
