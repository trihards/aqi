# AQI Observatory

Mobile-first air-quality prototype. Started in the San Francisco Bay Area (still the default, with shortcuts); any city worldwide can be searched, picked on the map, or taken from GPS. Static site in `web/`: plain HTML/CSS/ES modules, no build step, no keys, no backend.

## Data

| Source | Used for | Nature |
| --- | --- | --- |
| [Open-Meteo Air Quality](https://open-meteo.com/en/docs/air-quality-api), CAMS Europe (`domains=cams_europe`) | Inside 30–72°N, 25°W–45°E: timeline (3 days back, ~4 ahead), pollutants, map field | Model, 0.1° cells (~10 km). CC BY 4.0 |
| Open-Meteo Air Quality, CAMS global (`domains=cams_global`) | Everywhere else: same, ~5 days ahead | Model, 0.4° cells (~40 km). CC BY 4.0 |
| [Open-Meteo Geocoding](https://open-meteo.com/en/docs/geocoding-api) | Place search | GeoNames. CC BY 4.0 |
| EPA AirNow, via EPA's public ArcGIS feed "Air Now Current Monitor Data Public" | Monitor markers, "Measured" readings; queried only in North America, ±1° around the place | Observed, latest hour only, preliminary |
| Esri Light/Dark Gray Canvas (keyless; OSM fallback) | Map tiles | Esri, HERE, Garmin, © OpenStreetMap contributors |

Model grids were checked against Open-Meteo's source (`Sources/App/Cams/CamsDomain.swift`): CAMS global cell centres sit on multiples of 0.4°, CAMS Europe centres on x.x5° within the European domain. The app names the domain and uses `cell_selection=nearest`, and computes cell positions itself, because the coordinates Open-Meteo echoes back come from an auxiliary grid. The map field is a block of native cells around the selected place (7×9 global, 9×11 Europe), fetched in one multi-coordinate call. All values are US AQI (EPA scale), including outside the US.

### Requests and limits

Open-Meteo counts each location in a request as at least one call (`max(1, variables/10 × max(1, days/14))` per location, from its `calculateQueryWeight`), with free limits of 600 calls a minute, 5,000 an hour and 10,000 a day per IP; failed requests count as 1. A 63-cell field therefore costs 63 calls, a point series 1.3. To stay well inside that:

- Map cells are cached one by one per domain (20 min). A tap inside the loaded field reuses it; a tap outside requests only the cells the new block lacks, never a cell already held. Domains are never mixed.
- The Locations view loads no field unless several named places nearby (the Bay Area shortcuts) have no cached value; the selection and recent places use their own point series.
- Point series are cached per CAMS cell and time zone when the zone is known (search results, the Bay Area); map taps and GPS ask Open-Meteo for the zone and are cached by coordinates (~100 m). Superseded requests are aborted.
- On HTTP 429 the app reads `Retry-After` (falling back to the window named in the message), sends no Open-Meteo air-quality request until it passes, and does not retry by itself; Retry reappears afterwards.

### Observed and modeled

The timeline is model-only. A fresh AirNow observation is the primary reading (AQI, category, monitor, distance, report time); the model estimate for the hour the observation falls in sits beneath it, one size down, with its source, cell size, model hour and trend. The two are never averaged. Without a fresh observation only the model reading is shown. A "Measured vs model" disclosure in the Reading header explains the difference in a few lines, with Sources & method for detail. The measured dot sits at the observation's own report time; it is left off when that time is outside the plotted model range, missing, or ahead of the clock.

OpenAQ was evaluated and not used: its API does not allow browser (CORS) requests and needs a key, so it would require a proxy. The AirNow REST API needs a key too.

## Run locally

    npx http-server web -p 8080 -c-1

## Test

    npm install
    npm test        # Playwright smoke test with synthetic API fixtures; screenshots go to test-output/

If the pinned Playwright's browser isn't installed, point the test at an existing Chromium: `PW_CHROMIUM=/path/to/chromium npm test`.

## Deploy

`.github/workflows/pages.yml` publishes the repo to GitHub Pages on every push to `main`; the root `index.html` redirects to `web/`. Live at https://trihards.github.io/aqi/
