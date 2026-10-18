# AQI Observatory

Mobile-first air-quality prototype for the San Francisco Bay Area. Static site in `web/`: plain HTML/CSS/ES modules, no build step, no keys, no backend.

## Data

| Source | Used for | Nature |
| --- | --- | --- |
| [Open-Meteo Air Quality](https://open-meteo.com/en/docs/air-quality-api) (CAMS global, ~40 km) | Timeline (3 days back, ~5 ahead), pollutant breakdown, regional field | Model. Past hours are model values, not observations. CC BY 4.0 |
| EPA AirNow, via EPA's public ArcGIS feed "Air Now Current Monitor Data Public" | Monitor markers, "Measured" readings | Observed, latest hour only, preliminary |
| Esri Light/Dark Gray Canvas (keyless; OSM fallback) | Map tiles | Esri, HERE, Garmin, © OpenStreetMap contributors |

OpenAQ was evaluated and not used: its API does not allow browser (CORS) requests and needs a key, so it would require a proxy. The AirNow REST API needs a key too.

## Run locally

    npx http-server web -p 8080 -c-1

## Test

    npm install
    npm test        # Playwright smoke test with synthetic API fixtures; screenshots go to test-output/

## Deploy

`.github/workflows/pages.yml` publishes the repo to GitHub Pages on every push to `main`; the root `index.html` redirects to `web/`. Live at https://trihards.github.io/aqi/
