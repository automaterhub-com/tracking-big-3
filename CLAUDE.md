# tracking-big-3

Container shipment tracking service for the three largest ocean carriers: **Maersk**, **CMA-CGM**, and **MSC**. Accepts a BL/booking number and carrier name, returns structured tracking data including ETA, ETD, containers, vessel info, and milestone events.

| Carrier     | Status  |
|-------------|---------|
| Maersk      | Working |
| CMA-CGM     | TODO    |
| MSC         | Working |
| Hapag-Lloyd | Working |

## Usage

### Programmatic

```js
const { track } = require("./index");

const result = await track("maersk", "266412406");

if (result.success) {
  console.log(result.data);       // TrackingResult (see schema below)
} else {
  console.error(result.error);    // string
}
```

**Signature**: `track(carrier: string, reference: string) → Promise<{ success: boolean, data?: TrackingResult, error?: string }>`

### CLI

```bash
node index.js <carrier> <tracking-number>

# Examples
node index.js maersk 266412406
node index.js maeu 265947830      # "maeu" is an alias for "maersk"
```

The CLI prints a human-readable summary and saves the full JSON response to `<carrier>-<reference>.json` in the working directory.

### Carrier Aliases

| Input              | Resolves to |
|--------------------|-------------|
| `maersk`, `maeu`   | maersk      |
| `cmacgm`, `cma-cgm`, `cma` | cmacgm |
| `msc`              | msc         |
| `hapag`, `hapag-lloyd`, `hlcu` | hapag |

## Response Schema

Every carrier normalizer returns this shape (`TrackingResult`). This is the contract — all consumers depend on it.

```js
{
  carrier: "MAERSK" | "CMACGM" | "MSC" | "HAPAG",
  trackingNumber: string,        // BL or booking number as returned by carrier
  lastUpdated: string,           // ISO 8601
  origin: {
    city: string,
    terminal: string | null,
    country: string,
    countryCode: string,         // ISO 3166 alpha-2
  },
  destination: {
    city: string,
    terminal: string | null,
    country: string,
    countryCode: string,
  },
  containers: [{
    containerNumber: string,     // e.g. "MSKU4636948"
    size: string,                // e.g. "45"
    type: string,                // e.g. "DRY"
    isoCode: string | null,      // e.g. "45G1"
    sealNumber: string | null,   // always null for Maersk (not in API response)
    weight: number | null,       // always null for Maersk (not in API response)
    eta: string | null,          // ISO 8601 — ETA at final destination
    etd: string | null,          // ISO 8601 — ETD from origin
    etaLocation: string | null,  // "City, Country"
    latestEvent: {
      activity: string,
      location: string,          // "City, Country"
      time: string,              // ISO 8601
    } | null,
    vessel: string | null,       // current or last vessel name
    voyage: string | null,       // current or last voyage number
    events: [{
      activity: string,          // see activity values below
      location: string,
      terminal: string | null,
      country: string,
      countryCode: string,
      vessel: string | null,
      voyage: string | null,
      time: string,              // ISO 8601
      status: "ACTUAL" | "EXPECTED",
    }],
  }],
}
```

### Event Activity Values (Maersk)

| Activity              | Meaning                             |
|-----------------------|-------------------------------------|
| `GATE-IN`             | Container entered terminal          |
| `GATE-OUT`            | Container left terminal             |
| `LOAD`                | Loaded onto vessel                  |
| `DISCHARG`            | Discharged from vessel              |
| `CONTAINER DEPARTURE` | Departed from origin                |
| `CONTAINER ARRIVAL`   | Arrived at destination              |

Events are sorted chronologically. `status` is `"ACTUAL"` for past events and `"EXPECTED"` for future/scheduled events.

### Field Availability by Carrier

| Field          | Maersk           | CMA-CGM | MSC              | Hapag-Lloyd      |
|----------------|------------------|---------|------------------|------------------|
| `sealNumber`   | Always `null`    | TBD     | Always `null`    | Always `null`    |
| `weight`       | Always `null`    | TBD     | Always `null`    | Always `null`    |
| `isoCode`      | Populated        | TBD     | Always `null`    | Populated        |
| `eta` / `etd`  | Populated        | TBD     | Populated        | Populated        |

## Architecture

```
tracking-big-3/
  index.js              — unified entry: track(carrier, ref) → result; CLI runner
  lib/
    browser.js          — stealth browser factory (playwright-extra + stealth plugin)
    intercept.js        — API response interception helper
  carriers/
    maersk.js           — Maersk scraper + normalizer
    cmacgm.js           — CMA-CGM scraper + normalizer (TODO)
    msc.js              — MSC scraper + normalizer
    hapag.js            — Hapag-Lloyd scraper + normalizer
  .profiles/            — gitignored, cookie persistence per carrier
  package.json
  CLAUDE.md             — this file
```

### Adding a New Carrier

1. Create `carriers/<name>.js` exporting `track<Name>(reference) → { success, data?, error? }`
2. The `data` field must conform to the response schema above
3. Use `createTrackingSession("<name>")` from `lib/browser.js` for the stealth browser
4. Use `interceptApiResponse(page, options)` from `lib/intercept.js` for API capture
5. Register in `index.js`: add to `CARRIERS` map and `ALIASES` map

## Stealth Browser — Hard-Won Constraints

These were discovered through debugging. Do NOT change without re-testing:

1. **Use `chromium.launch()` + `browser.newContext()`** — NOT `launchPersistentContext`. Persistent context changes the TLS/HTTP2 fingerprint, causing Akamai to reject API calls with `ERR_HTTP2_PROTOCOL_ERROR`.

2. **Do NOT use patchright** — same TLS fingerprint issue as `launchPersistentContext`.

3. **Do NOT block `googletagmanager.com`** — Maersk SPA depends on GTM for initialization. Blocking it prevents the tracking API call from ever firing.

4. **Cookie persistence is manual** — save via `context.cookies()` → `.profiles/<carrier>/cookies.json`, restore via `context.addCookies()` on next run. This is handled by `lib/browser.js`.

5. **No custom User-Agent needed** — the stealth plugin + standard Chromium binary handles fingerprint consistency. Setting a stale UA (e.g. Chrome/120 when binary is Chrome/145) is worse than the default.

6. **Retry order**: existing cookies → wait 2-5s + retry → clear cookies + retry → headed mode (if `TRACKER_ALLOW_HEADED=true`).

## Carrier-Specific Notes

### Maersk

- **Status**: Working — validated with BL 266412406 and 265947830
- **API URL pattern**: `https://api.maersk.com/synergy/tracking/<ref>?operator=MAEU`
- **Approach**: Navigate to `maersk.com/tracking/<ref>`, intercept the API response
- **Cookie consent**: `button:has-text("Allow all")`
- **Missing data**: `sealNumber` and `weight` are not in the current API response (may need a container detail endpoint)

### CMA-CGM

- **Status**: TODO
- **Research needed**: Identify tracking page URL structure, API endpoints, anti-bot measures
- **Website**: `www.cma-cgm.com`

### MSC

- **Status**: Working — validated with BL MEDUYK515565
- **API**: `POST https://www.msc.com/api/feature/tools/TrackingInfo` with body `{"trackingNumber":"<ref>","trackingMode":"0"}`
- **Approach**: Navigate to tracking page, dismiss OneTrust cookie consent, fill `#trackingNumber` input, press Enter, intercept POST response
- **Cookie consent**: `#onetrust-accept-btn-handler` ("Accept All")
- **Anti-bot**: None observed — works headless without issues
- **Missing data**: `sealNumber`, `weight`, and `isoCode` not in API response
- **Notes**: Dates are DD/MM/YYYY (converted to ISO 8601). Events use `Order` field for chronological sorting. `country` field contains ISO alpha-2 code (full name not provided by API). All events are status `"ACTUAL"` (MSC doesn't return future/expected events in the same format).

### Hapag-Lloyd

- **Status**: Working — validated with BL HLCUTOR251233330
- **Approach**: HTML scraping of JSF server-rendered pages (no JSON API available)
- **URL**: `https://www.hapag-lloyd.com/en/online-business/track/track-by-booking-solution.html`
- **Cookie consent**: `button:has-text("Select All")`
- **Flow**: Fill BL in `input[name="tracing_by_booking_f:hl16"]` → click `button:has-text("Find")` → parse container table → for each container: select radio via `page.evaluate()` → click Details via `page.evaluate()` → parse event table → click Close
- **Anti-bot**: None observed — works headless
- **Hidden elements**: JSF renders hidden radio buttons and buttons that can't be clicked with standard Playwright selectors. Must use `page.evaluate()` to set `.checked`, dispatch events, and click buttons via `document.querySelector('button[value="Details"]')`.
- **Container list parsing**: Scans all `<tr>` for rows with ISO code pattern (`/^\d{2}[A-Z0-9]{2}$/`), handles variable column offset (radio button column)
- **Event parsing**: Scans all `<tr>` for rows with YYYY-MM-DD date column, uses relative indexing from date position. `isFutureEvent()` marks "vessel arrival"/"vessel departure" as `"EXPECTED"`.
- **Missing data**: `sealNumber` and `weight` not available in the HTML

## Development Workflow

Claude Code assisted project. Typical flow for adding a carrier:

1. Research carrier website (headed browser, network inspection)
2. Identify API endpoints and response structure
3. Build scraper using `lib/browser.js` and `lib/intercept.js`
4. Write normalizer to map raw API data → unified schema
5. Test with real tracking numbers
6. Debug anti-bot issues as they arise

## Environment Variables

| Variable               | Purpose                           | Default         |
|------------------------|-----------------------------------|-----------------|
| `TRACKER_PROXY_URL`    | SOCKS5/HTTP proxy for browser     | none (direct)   |
| `TRACKER_ALLOW_HEADED` | Allow headed mode as last retry   | `false`         |

## Scripts

```bash
npm run track:maersk <number>   # node index.js maersk <number>
npm run track <carrier> <number> # node index.js <carrier> <number>
npm run update:stealth          # update playwright + stealth + reinstall browser binary
```
