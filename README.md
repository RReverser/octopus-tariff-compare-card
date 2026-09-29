# Octopus Tariff Compare card

A Home Assistant card that prices your own metered usage on every Octopus Energy import tariff available in your region, and shows how each one compares with the tariff you are on now.

- **Main chart:** running cost difference against your current tariff (dashed line). Above zero means that tariff would have cost more.
- **Legend:** the total cost of the selected period on each tariff. Click an entry to show or hide that tariff; your current tariff always stays shown. Hover an entry for the tariff's full name and product code, and what it was priced from: the product versions used, or for a fixed tariff the date it is taken as signed up and, for each term, the fix used and the date it went on sale.
- **Lower chart:** your daily cost on the current tariff. Drag or resize the selection to pick the period.
- **Electricity / Gas buttons:** compare either fuel, or both together (sum). The legend keeps the same tariffs for every choice: a tariff that does not supply the selected fuel, or cannot be priced for your usage period, shows N/A instead of a price (hover it for the reason) and cannot be shown.

The period, fuel selection and shown tariffs are remembered per browser.

## Requirements

- The [Octopus Energy](https://github.com/BottlecapDave/HomeAssistant-OctopusEnergy) integration, with consumption sensors for your meter:
  - electricity: `sensor.octopus_energy_electricity_<meter>_current_rate` and `..._current_total_consumption`
  - gas: `sensor.octopus_energy_gas_<meter>_current_rate` and `..._current_total_consumption_kwh`

  The `current_total_consumption` sensors come from an Octopus Home Mini. Other consumption sensors can be used via the config options below, as long as Home Assistant keeps long-term statistics for them.
- Only the recorded history can be costed: the card goes back as far as the consumption statistics do, up to `history_days`.

No Octopus API key is needed: prices come from the public Octopus products API.

## Installation

### HACS

1. HACS → ⋮ → Custom repositories → add `https://github.com/RReverser/octopus-tariff-compare-card`, type **Dashboard**.
2. Install **Octopus Tariff Compare**, then reload the browser.

### Manual

1. Download `dist/octopus-tariff-compare-card.js` into `/config/www/`.
2. Settings → Dashboards → ⋮ → Resources → add `/local/octopus-tariff-compare-card.js` as a JavaScript module.

## Configuration

```yaml
type: custom:octopus-tariff-compare-card
```

Everything is optional:

| Option | Default | Description |
| --- | --- | --- |
| `title` | `Octopus tariff comparison` | Card title. |
| `default_visible` | `[OE-FIX-12M, OE-FIX-18M, SILVER]` | Tariffs shown until you change the selection in the legend, by product code without its date (for example `AGILE`, `VAR`, `SILVER` for Tracker). |
| `default_days` | `30` | Initial period: the last N days. |
| `default_fuel` | `electricity` | Initial fuel: `electricity` or `gas`. |
| `history_days` | `365` | How far back to cost your usage. |
| `height` | `380` | Main chart height in pixels. |
| `brush_height` | `110` | Lower chart height in pixels. |
| `electricity` | auto-detected | `{rate: <current_rate sensor>, consumption: <consumption sensor>}`. |
| `gas` | auto-detected | As above, for gas (consumption in kWh). |
| `storage_key` | `default` | Key for the per-browser state; give each card its own if you have more than one. |

## How costs are worked out

- Consumption is read from Home Assistant's long-term statistics: hourly, plus 5-minute data for the most recent part.
- Each tariff's unit rates and standing charges come from the Octopus products API for your region, direct debit, inc. VAT.
  - Variable tariffs follow their published price history, version by version.
  - Fixed tariffs are priced as if you had signed up when your current supply agreement started, and renewed at the end of every term: each term uses the fix that was on sale when it began, with that product's own published prices (including its time-of-use slots). The agreement start comes from the Octopus Energy integration's diagnostics, which only admin users can read; building them makes the integration query your Octopus account, so the card keeps just the agreement start dates in the browser for a day. A fix with no product on sale at one of those dates is left out.
  - Without that date (a non-admin user), fixed tariffs use the price you could sign up for today across the whole period. Time-of-use fixes (such as Cosy or Go fixed) then repeat today's published daily pattern of slots on every day, by local time.
  - Your current tariff uses its own published prices.
- The standing charge is spread evenly over time.
- Prices are requested per calendar month. Months that have ended are cached by the browser beyond the API's 5-minute limit, so they are not downloaded again on later visits.
- The results are estimates from published prices and your recorded usage; your bills may differ, for example from meter reading timing or rounding.

## Known limitations

- Octopus Tracker is not listed by the products API, so its past versions are pinned in the card (`src/octopus.js`). A new Tracker version released after this card version will not be picked up until the list is updated.
- Only single-rate (single register) meters are supported.
- Export tariffs are not compared.

## Building

```sh
npm install
npm run build      # dist/octopus-tariff-compare-card.js, with ApexCharts bundled
npm run build:dev  # build/…dev.js, loading ApexCharts from jsDelivr (small file for quick testing)
```

ApexCharts is pinned to 4.7.0, the last MIT-licensed release.

## License

MIT
