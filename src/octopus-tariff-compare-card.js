// Octopus Tariff Compare card for Home Assistant: what your own metered usage would have cost on every Octopus Energy import tariff
// available in your region, as a running difference against the tariff you are on now.
//
// The whole history (default: the last year) is costed once per tariff as a running total. The brush chart under the main chart
// picks the period; since every line is a running total, a period's figures are differences within that data, so moving the brush
// never refetches anything.
import ApexCharts from 'apexcharts';
import {FUELS, curKey, families, fuelCost, merge, thin, detectEntities, newCache} from './octopus.js';
import {agreementStarts} from './agreements.js';

const VERSION = '0.1.0';
const COLORS = {VAR: '#607d8b', SILVER: '#4caf50', AGILE: '#ff9800', 'OE-FIX-12M': '#e91e63', 'OE-FIX-18M': '#9c27b0'};
const EXTRA = ['#2196f3', '#00bcd4', '#795548', '#cddc39', '#ff5722', '#3f51b5', '#009688', '#ffc107', '#8bc34a', '#f44336', '#673ab7'];
const MAX_POINTS = 1000;  // per line in the main chart; lines are running totals, so thinning keeps their shape
const REFRESH_MS = 15 * 60e3;
const DAY = 864e5;
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
    this._timer = setInterval(() => this._refresh(), REFRESH_MS);
    if (this._hass && this._data && !this._main) this._redraw();
  }

  disconnectedCallback() {
    clearInterval(this._timer);
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
      .main .apexcharts-legend-series[rel="1"] { cursor: default; }
      .main .apexcharts-legend-text { font-variant-numeric: tabular-nums; }
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

  // ---- data: cost the whole history once per tariff ----
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
      const a0 = startOfDay(Date.now() - this._config.history_days * DAY), b0 = Date.now();
      const mode = fuels.join('+');
      const cur = Object.fromEntries(fuels.map((f) => { const a = hass.states[ents[f].rate]?.attributes || {}; return [f, curKey(a.tariff || a.tariff_code)]; }));
      const a = hass.states[ents[fuels[0]].rate]?.attributes || {};
      const [fams, starts] = await Promise.all([families((a.tariff || a.tariff_code || '').slice(-1)), agreementStarts(hass)]);
      // Fixes are priced as if taken when the current agreement for that fuel began.
      const signup = Object.fromEntries(fuels.map((f) => { const x = hass.states[ents[f].rate]?.attributes || {}; return [f, starts[x.tariff || x.tariff_code] ?? null]; }));
      const cache = newCache();
      const total = async (K) => {
        const parts = await Promise.all(fuels.map((f) => fuelCost(cache, hass, a0, b0, f, ents[f], K, signup[f])));
        return parts.some((p) => !p) ? null : parts.reduce(merge);
      };
      const labelOf = (k) => (fams.find((f) => f.key === k) || {}).label || k;
      const colour = (k) => COLORS[k] || EXTRA[Math.max(0, fams.findIndex((f) => f.key === k)) % EXTRA.length];
      const same = fuels.every((f) => cur[f] === cur[fuels[0]]);
      const lines = [{key: 'CURRENT', label: same ? labelOf(cur[fuels[0]]) : fuels.map((f) => `${labelOf(cur[f])} ${f}`).join(' + '), colour: colour(cur[fuels[0]])}];
      for (const f of fams) {
        if (fuels.every((fu) => f.fuels.includes(fu[0])) && !(same && f.key === cur[fuels[0]])) lines.push({key: f.key, label: f.label, colour: colour(f.key)});
      }
      // Every tariff is costed in parallel. On a first load or a fuel change, the chart appears as soon as the current tariff (the
      // baseline every line is drawn against) is ready, and each other line joins as soon as its own prices are in; the legend
      // lists the rest as pending. A periodic refresh keeps showing the previous figures and swaps them in once all are done.
      const progressive = this._data?.mode !== mode;
      const pending = lines.map((l) => total(l.key).then((cum) => { l.cum = cum; return cum; }));
      const base = await pending[0];
      if (token !== this._token) return;
      if (!base) throw new Error('no consumption statistics found for your meter');
      const show = () => {
        if (token !== this._token) return;
        this._data = {mode, start: base[0][0], end: base[base.length - 1][0], lines: lines.filter((l) => l.cum !== null)};
        this._status('');
        this._redraw();
      };
      if (progressive) {
        show();
        for (const p of pending.slice(1)) p.then(show, () => {});
      }
      await Promise.all(pending);
      show();
    } catch (err) {
      if (token === this._token) this._status('Could not load: ' + (err.message || err), true);
    }
  }

  // Lines for period [a, b]: running difference vs the current tariff from a, thinned; totals over the period.
  _view(a, b) {
    const {lines} = this._data, base = lines[0].cum;
    const i0 = idxAt(base, a), i1 = idxAt(base, b);
    return lines.map((l) => {
      if (!l.cum) return {...l, points: [], total: null};  // still loading
      const c = l.cum, pts = [];
      for (let j = i0; j <= i1; j++) pts.push([c[j][0], Math.round(((c[j][1] - c[i0][1]) - (base[j][1] - base[i0][1])) * 100) / 100]);
      return {...l, points: thin(pts, MAX_POINTS), total: c[i1][1] - c[i0][1]};
    });
  }

  // Daily cost on the current tariff, for the brush chart, running to the latest data. Partial first and last
  // days are scaled to a per-day rate so they are comparable with whole days.
  _daily() {
    const {start, end} = this._data, base = this._data.lines[0].cum, out = [];
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
      const hidden = w.globals.collapsedSeriesIndices.includes(i), want = i === 0 || vis.has(l.key);
      if (want === hidden) this._main.toggleSeries(l.label);
    });
  }

  // Draws are serialised: a draw requested while one is running happens once it finishes (coalescing any number of requests).
  _redraw() {
    if (this._drawing) { this._drawAgain = true; return; }
    this._drawing = (async () => {
      try { do { this._drawAgain = false; await this._draw(); } while (this._drawAgain); } finally { this._drawing = null; }
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
        y: {formatter: (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + '£' + Math.abs(v).toFixed(2)}},
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

  // Brush moved or resized: re-base the lines on the new period start and update the totals (throttled to one frame).
  // The period is read from the selection rectangle itself: apexcharts' resize events report the size from before the change.
  _onBrush(s) {
    if (!this._data) return;
    this._pendingSel = s?.xaxis;
    if (this._frame) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = null;
      const [a, b] = this._brushRange();
      if (!(a < b)) return;
      this._setPeriod(a, b);
      this._viewLines = this._view(a, b);
      this._main.updateOptions({...this._mainSeriesOptions(this._viewLines), xaxis: {min: a, max: b}}, false, false)
        .then(() => this._applyVisibility());
    });
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
    if (!d || i <= 0 || i >= this._viewLines.length) return;  // the current tariff always stays visible
    const l = this._viewLines[i], vis = this._visibleKeys(d.mode);
    vis.has(l.key) ? vis.delete(l.key) : vis.add(l.key);
    this._state.visible = {...(this._state.visible || {}), [d.mode]: [...vis]};
    this._save();
    this._main.toggleSeries(l.label);
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
