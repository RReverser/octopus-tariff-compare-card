// When the user's current supply agreements started, from the Octopus Energy integration. Home Assistant does not expose
// agreements on any entity: the integration's diagnostics are the only source, and only admin users can read them. Building the
// diagnostics makes the integration call the Octopus API with the user's key, so the result is kept in localStorage for a day.
// Only tariff codes and start dates are stored.

const KEY = 'octopus-tariff-compare-card:agreements';
const TTL = 864e5;
let pending, failed = false;

const read = () => { try { const c = JSON.parse(localStorage.getItem(KEY)); return c && Date.now() - c.t < TTL ? c.starts : null; } catch { return null; } };
const write = (starts) => { try { localStorage.setItem(KEY, JSON.stringify({t: Date.now(), starts})); } catch { /* storage unavailable */ } };

const load = async (hass) => {
  const cached = read();
  if (cached) return cached;
  if (!hass.user?.is_admin || failed) return {};
  const starts = {}, now = Date.now();
  try {
    const entries = (await hass.callWS({type: 'config_entries/get', domain: 'octopus_energy'})).filter((e) => e.state === 'loaded');
    for (const e of entries) {
      const acct = (await hass.callApi('GET', `diagnostics/config_entry/${e.entry_id}`))?.data?.account;
      if (!acct) continue;  // not an account entry (e.g. a cost tracker)
      for (const p of [...(acct.electricity_meter_points || []), ...(acct.gas_meter_points || [])]) {
        for (const a of p.agreements || []) {
          const s = Date.parse(a.start), end = a.end ? Date.parse(a.end) : Infinity;
          if (a.tariff_code && s <= now && now < end) starts[a.tariff_code] = s;
        }
      }
    }
  } catch (e) {
    failed = true;  // not retried until the page is reloaded
    console.warn('octopus-tariff-compare-card: could not read agreements from the Octopus Energy integration', e);
    return {};
  }
  write(starts);
  return starts;
};

// {tariff code: start of its current agreement (ms)}, e.g. {'E-1R-VAR-22-11-01-H': 1779836400000}; {} when unavailable.
export const agreementStarts = (hass) => pending || (pending = load(hass).finally(() => { pending = null; }));
