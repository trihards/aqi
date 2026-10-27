// Layout/interaction smoke test. External APIs are mocked with SYNTHETIC fixtures
// (shape-compatible, values invented) because the test sandbox has no network.
// Usage: node tests/smoke.mjs [outDir]
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(new URL('../web', import.meta.url).pathname);
const OUT = process.argv[2] || 'test-output';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

const server = createServer(async (req, res) => {
  const p = join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
  try { res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(await readFile(p)); }
  catch { res.writeHead(404); res.end(); }
}).listen(0);
const BASE = `http://localhost:${server.address().port}/`;

// ---- synthetic fixtures ----
const H = 3600, now = Math.floor(Date.now() / 1000 / H) * H;
function series(past, ahead, seed, nullHead = 24, nullTail = 12) {
  const t0 = now - past * 24 * H, n = (past + ahead) * 24;
  const time = [], v = [];
  for (let i = 0; i < n; i++) {
    time.push(t0 + i * H);
    const k = (time[i] - now) / H + seed; // keyed to the clock, so point and field series agree for a cell
    v.push(i < nullHead || i >= n - nullTail ? null : Math.round(45 + 25 * Math.sin(k / 9) + 12 * Math.sin(k / 3.1)));
  }
  return { time, v };
}
// Rough zone lookup for the synthetic cities (timezone=auto in the real API).
const tzFor = (lat, lon) => (lon > -11 && lon < 2 && lat > 49.5) ? 'Europe/London' : lon < -115 ? 'America/Los_Angeles' : lon < -100 ? 'America/Denver' : lon < -85 ? 'America/Chicago'
  : lon < -50 ? 'America/New_York' : lon < 45 ? 'Europe/Paris' : 'Asia/Tokyo';
function omPoint(lat, lon, past, ahead, seed, vars, constant) {
  const s = series(past, ahead, seed);
  if (constant != null) s.v = s.v.map(x => (x == null ? null : constant));
  const hourly = { time: s.time };
  for (const k of vars) hourly[k] = s.v.map(x => (x == null ? null : k.startsWith('us_aqi_') ? Math.round(x * (k.includes('pm2_5') ? 0.95 : k.includes('ozone') ? 0.7 : 0.25)) : k.startsWith('us_aqi') ? x : +(x / 4).toFixed(1)));
  return { latitude: lat, longitude: lon, timezone: tzFor(lat, lon), utc_offset_seconds: 0, hourly, hourly_units: { pm2_5: 'μg/m³' } };
}
const inEurope = (la, lo) => la >= 30 && la < 72 && lo >= -25 && lo < 45;
// Seed per native cell, so a point request and the field cell containing it return the same values.
const cellSeed = (la, lo, domain) => {
  const st = domain === 'cams_europe' ? 0.1 : 0.4, off = domain === 'cams_europe' ? 0.05 : 0;
  const sn = x => Math.round((x - off) / st) * st + off;
  return Math.round((sn(la) + sn(lo)) * 70) / 10;
};
// slow: [{ lat, lon, delay, value }] — responses near that point arrive late with a constant AQI.
function openMeteo(url, failModel, slow = []) {
  const q = new URL(url).searchParams;
  const lats = q.get('latitude').split(',').map(Number), lons = q.get('longitude').split(',').map(Number);
  const vars = q.get('hourly').split(',');
  const past = +q.get('past_days'), ahead = +q.get('forecast_days');
  const domain = q.get('domains') || 'auto';
  const hit = slow.find(x => Math.abs(x.lat - lats[0]) < 1.5 && Math.abs(x.lon - lons[0]) < 1.5);
  const delay = hit?.delay || 0;
  // Like the real API, a Europe-only request outside that domain is rejected.
  if (domain === 'cams_europe' && lats.some((la, i) => !inEurope(la, lons[i]))) {
    return { status: 400, delay, body: { error: true, reason: 'No data is available for this location' } };
  }
  if (lats.length === 1) {
    if (failModel) return { status: 500, body: { error: true, reason: 'Synthetic failure' } };
    return { status: 200, delay, body: omPoint(lats[0], lons[0], past, ahead, cellSeed(lats[0], lons[0], domain), vars, hit?.value) };
  }
  return { status: 200, delay, body: lats.map((la, i) => omPoint(la, lons[i], past, ahead, cellSeed(la, lons[i], domain), vars, hit?.value)) };
}
// Synthetic geocoder results (shape of Open-Meteo's /v1/search; values approximate).
const g = (id, name, latitude, longitude, admin1, admin2, country, country_code, timezone) =>
  ({ id, name, latitude, longitude, admin1, admin2, country, country_code, timezone, feature_code: 'PPL' });
const GEO = {
  springfield: [
    g(1, 'Springfield', 39.80, -89.64, 'Illinois', 'Sangamon', 'United States', 'US', 'America/Chicago'),
    g(2, 'Springfield', 37.21, -93.29, 'Missouri', 'Greene', 'United States', 'US', 'America/Chicago'),
    g(3, 'Springfield', 42.10, -72.59, 'Massachusetts', 'Hampden', 'United States', 'US', 'America/New_York'),
    g(4, 'Springfield', 39.92, -83.81, 'Ohio', 'Clark', 'United States', 'US', 'America/New_York'),
    g(5, 'Springfield', 40.43, -82.80, 'Ohio', 'Knox', 'United States', 'US', 'America/New_York'),
  ],
  paris: [
    g(10, 'Paris', 48.8534, 2.3488, 'Île-de-France', 'Paris', 'France', 'FR', 'Europe/Paris'),
    g(11, 'Paris', 33.6609, -95.5555, 'Texas', 'Lamar', 'United States', 'US', 'America/Chicago'),
  ],
  'new york': [g(20, 'New York', 40.71427, -74.00597, 'New York', null, 'United States', 'US', 'America/New_York')],
  denver: [g(30, 'Denver', 39.73915, -104.9847, 'Colorado', 'Denver', 'United States', 'US', 'America/Denver')],
  tokyo: [g(40, 'Tokyo', 35.6895, 139.69171, 'Tokyo', null, 'Japan', 'JP', 'Asia/Tokyo')],
  llanfair: [g(50, 'Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch', 53.2214, -4.2049, 'Wales', 'Anglesey', 'United Kingdom', 'GB', 'Europe/London')],
};
function geocode(url, failGeo) {
  if (failGeo) return { status: 500, body: { error: true, reason: 'Synthetic failure' } };
  const name = new URL(url).searchParams.get('name').toLowerCase();
  const key = Object.keys(GEO).find(k => k.startsWith(name) || name.startsWith(k));
  return { status: 200, body: key ? { results: GEO[key], generationtime_ms: 0.4 } : { generationtime_ms: 0.4 } };
}
const MON = [
  ['San Francisco', 37.7658, -122.3978, 41, 22], ['Oakland West', 37.8148, -122.2825, 58, 30],
  ['San Rafael', 37.9722, -122.5189, 33, 18], ['San Jose Jackson', 37.3486, -121.8949, 72, 40],
  ['Napa Valley College', 38.2786, -122.2753, 28, null], ['Livermore', 37.6875, -121.7842, null, 51],
  ['Manhattan Synthetic', 40.7360, -73.9890, 64, 35],
];
// Honours the query envelope, so each region only sees its own monitors.
const arcgis = url => {
  const [w, s, e, n] = new URL(url).searchParams.get('geometry').split(',').map(Number);
  const mon = MON.filter(([, la, lo]) => lo >= w && lo <= e && la >= s && la <= n);
  return arcgisBody(mon);
};
const arcgisBody = MON => ({
  fields: [
    { name: 'OBJECTID', type: 'esriFieldTypeOID' }, { name: 'SiteName', type: 'esriFieldTypeString' },
    { name: 'AQSID', type: 'esriFieldTypeString' }, { name: 'AgencyName', type: 'esriFieldTypeString' },
    { name: 'PM25_AQI', type: 'esriFieldTypeInteger' }, { name: 'OZONE_AQI', type: 'esriFieldTypeInteger' },
    { name: 'PM25', type: 'esriFieldTypeDouble' }, { name: 'OZONE', type: 'esriFieldTypeDouble' },
    { name: 'LocalTimeString', type: 'esriFieldTypeString' },
  ],
  features: MON.map(([n, lat, lon, pm, o3], i) => ({
    attributes: { OBJECTID: i, SiteName: n, AQSID: `06000${i}`, AgencyName: 'Synthetic', PM25_AQI: pm ?? -999, OZONE_AQI: o3 ?? -999, PM25: pm ? pm / 4 : -999, OZONE: o3 ? o3 / 2 : -999, LocalTimeString: new Date((now - 1800) * 1000).toISOString() },
    geometry: { x: lon, y: lat },
  })),
});
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64');

// The phone is emulated in the Bay Area time zone throughout.
async function page(browser, { width, height, failMonitors, failModel, failTiles, failGeo, slow, modelDelay = 0, dark = false }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: dark ? 'dark' : 'light', timezoneId: 'America/Los_Angeles' });
  const pg = await ctx.newPage();
  const errors = [];
  const tiles = { esri: 0, osm: 0 };
  const reqs = { model: [], field: [], airnow: [], geo: [] };
  pg.on('pageerror', e => errors.push(e.message));
  pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await pg.route(/^https?:\/\/(?!localhost)/, async route => {
    const url = route.request().url();
    if (url.includes('geocoding-api.open-meteo.com')) {
      reqs.geo.push(new URL(url).searchParams.get('name'));
      const r = geocode(url, failGeo);
      return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) });
    }
    if (url.includes('open-meteo.com')) {
      const sp = new URL(url).searchParams;
      const multi = sp.get('latitude').includes(',');
      (multi ? reqs.field : reqs.model).push({
        domain: sp.get('domains'), cellSel: sp.get('cell_selection'),
        lats: sp.get('latitude').split(',').map(Number), lons: sp.get('longitude').split(',').map(Number),
      });
      if (modelDelay && !multi) await new Promise(r => setTimeout(r, modelDelay));
      const r = openMeteo(url, failModel, slow);
      if (r.delay) await new Promise(res => setTimeout(res, r.delay));
      return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) }).catch(() => {});
    }
    if (url.includes('services.arcgis.com')) {
      reqs.airnow.push(new URL(url).searchParams.get('geometry').split(',').map(Number));
      if (failMonitors) return route.fulfill({ status: 503, body: 'down' });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(arcgis(url)) });
    }
    if (url.includes('arcgisonline.com')) { tiles.esri++; if (failTiles) return route.fulfill({ status: 503, body: '' }); }
    if (url.includes('openstreetmap.org')) tiles.osm++;
    if (url.includes('arcgisonline.com') || url.includes('openstreetmap.org')) return route.fulfill({ contentType: 'image/png', body: PNG });
    return route.abort();
  });
  await pg.goto(BASE);
  return { pg, ctx, errors, tiles, reqs };
}

const shot = (pg, name, full = false) => pg.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
const txt = (pg, sel) => pg.$eval(sel, e => e.textContent.replace(/\s+/g, ' ').trim());
const onGrid = (v, step, off) => Math.abs((v - off) / step - Math.round((v - off) / step)) < 1e-6;
const waitModel = pg => pg.waitForFunction(() => document.querySelector('#sources').textContent.includes('cell centred'), null, { timeout: 8000 });
async function search(pg, query) {
  if (!(await pg.$eval('#placeDialog', d => d.open))) await pg.click('#placeBtn');
  await pg.fill('#placeQuery', query);
  await pg.waitForFunction(q => {
    const st = document.querySelector('#searchStatus').dataset.state;
    return (st === 'ok' || st === 'error') && document.querySelector('#placeQuery').value === q;
  }, query, { timeout: 5000 });
}
// Search and pick the first result whose region line matches `region` (or the first result).
async function pick(pg, query, region) {
  await search(pg, query);
  const rows = await pg.$$('#searchResults [data-result]');
  let row = rows[0];
  if (region) for (const r of rows) if ((await r.textContent()).includes(region)) { row = r; break; }
  await row.click();
  await waitModel(pg);
}
// Distance of an element's centre from the centre of a container (px).
const offCentre = (pg, sel, box) => pg.evaluate(([sel, box]) => {
  const els = [...document.querySelectorAll(sel)];
  const a = els[els.length - 1].getBoundingClientRect();
  const b = box ? document.querySelector(box).getBoundingClientRect() : { x: 0, y: 0, width: innerWidth, height: innerHeight };
  return Math.round(Math.hypot(a.x + a.width / 2 - (b.x + b.width / 2), a.y + a.height / 2 - (b.y + b.height / 2)));
}, [sel, box]);
const sheetH = pg => pg.$eval('#sheet', el => el.getBoundingClientRect().height);
const log = (...a) => console.log(...a);

// PW_CHROMIUM lets the test run against a preinstalled browser when the pinned Playwright's own is absent.
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
let failures = 0;
const check = (cond, msg) => { log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

{ // main flow, iPhone 14-ish (Bay Area regression)
  const { pg, ctx, errors, tiles, reqs } = await page(browser, { width: 390, height: 844 });
  await pg.waitForSelector('.ro-num:not(.is-blank)');
  await pg.waitForTimeout(300);
  await shot(pg, '01-home-390', true);
  check(await pg.$eval('.ro .badge', b => b.textContent) === 'Measured', 'home shows measured reading near a monitor');
  check(await txt(pg, '#plateModel') === 'US AQI · Bay Area', 'Bay Area header label kept');
  check(reqs.model[0]?.domain === 'cams_global' && reqs.model[0]?.cellSel === 'nearest', 'Bay Area model request names the CAMS global domain, nearest cell');
  check(reqs.airnow.length === 1 && reqs.airnow[0][0] < -122.4 && reqs.airnow[0][2] > -122.4, 'AirNow queried around San Francisco');
  check(!/GMT|P[DS]T/.test(await txt(pg, '#readout .ro-fresh')), 'Bay Area times carry no zone suffix on a Bay Area phone');

  // tap the timeline in the forecast region (imperfect tap: a short wobble)
  const box = await (await pg.$('#tlHome svg')).boundingBox();
  await pg.touchscreen.tap(box.x + box.width * 0.8, box.y + box.height * 0.5);
  await pg.waitForTimeout(100);
  check(/Forecast/.test(await pg.$eval('#readout .badge', b => b.textContent)), 'tapping the forecast region switches the readout to forecast');
  await shot(pg, '02-home-forecast', false);
  await pg.click('#tlHome ~ .tl-controls [data-now]');
  check(await pg.$eval('#readout .badge', b => b.textContent) === 'Measured', 'Now button returns to the measured reading');

  await pg.click('#openMap');
  await pg.waitForTimeout(500);
  await shot(pg, '03-map-locations');
  const h0 = await sheetH(pg);

  // tap 18px off a monitor marker centre (forgiving hit area)
  const pt = await pg.evaluate(() => {
    const m = [...document.querySelectorAll('.mk-mon')][1].getBoundingClientRect();
    return { x: m.x + m.width / 2 + 18, y: m.y + m.height / 2 + 12 };
  });
  await pg.touchscreen.tap(pt.x, pt.y);
  await pg.waitForTimeout(300);
  check(await pg.$eval('#sheetKind', e => e.textContent) === 'AirNow monitor', 'off-centre tap selects the nearby monitor');
  check(Math.abs((await sheetH(pg)) - h0) < 1, 'compact sheet height unchanged after selection');

  await pg.click('#sheetToggle');
  await pg.waitForTimeout(400);
  const h1 = await sheetH(pg);
  check(h1 > h0 + 150, `sheet expands via button (${h0}→${h1})`);
  await shot(pg, '04-map-expanded');

  // select a different location while expanded
  const pt2 = await pg.evaluate(() => {
    const m = [...document.querySelectorAll('.mk-est')][0].getBoundingClientRect();
    return { x: m.x + m.width / 2, y: m.y + m.height / 2 };
  });
  if (pt2.y < 844 - h1) {
    await pg.touchscreen.tap(pt2.x, pt2.y);
    await pg.waitForTimeout(300);
    check(Math.abs((await sheetH(pg)) - h1) < 1, 'expanded sheet height unchanged after selecting another place');
  }

  // scrub the sheet timeline: map should follow
  const tb = await (await pg.$('#tlSheet svg')).boundingBox();
  await pg.touchscreen.tap(tb.x + tb.width * 0.75, tb.y + tb.height / 2);
  await pg.waitForTimeout(200);
  check(!(await pg.$eval('#exTime', e => e.hidden)), 'selected time chip appears on the map');

  await pg.click('.seg [data-mode="field"]');
  await pg.waitForTimeout(600);
  check((await pg.$$('#map .leaflet-overlay-pane path')).length > 20, 'air quality mode draws model cells');
  const bf = reqs.field[0];
  check(bf?.domain === 'cams_global' && bf.lats.length === 63 && bf.lats.every(v => onGrid(v, 0.4, 0)) && bf.lons.every(v => onGrid(v, 0.4, 0)),
    `Bay Area field: 63 native 0.4° cells (${bf?.lats.length})`);
  check(bf.lats.some(v => Math.abs(v - 37.6) < 1e-6) && bf.lons.some(v => Math.abs(v + 122.4) < 1e-6), 'Bay Area field includes the selected cell');
  await shot(pg, '05-map-field-expanded');

  // drag the sheet down by its grab bar
  const g = await (await pg.$('#sheetGrab')).boundingBox();
  await pg.mouse.move(g.x + g.width / 2, g.y + 10);
  await pg.mouse.down();
  for (let i = 1; i <= 8; i++) await pg.mouse.move(g.x + g.width / 2, g.y + 10 + i * 40);
  await pg.mouse.up();
  await pg.waitForTimeout(400);
  check(await pg.$eval('#sheet', e => e.dataset.state) === 'compact', 'drag down snaps to compact');
  await shot(pg, '06-map-field-compact');

  await pg.click('#exBack');
  await pg.waitForTimeout(300);
  check(await pg.$eval('#explorer', e => e.hidden), 'back button returns to console');
  check(tiles.esri > 0 && tiles.osm === 0, `basemap uses Esri tiles (esri ${tiles.esri}, osm ${tiles.osm})`);
  check(errors.length === 0, `no console errors (${errors.join(' | ')})`);
  await ctx.close();
}

{ // worldwide search: US cities, Europe, Asia; persistence; recentering (390, light)
  const { pg, ctx, errors, reqs } = await page(browser, { width: 390, height: 844 });
  await waitModel(pg);

  await search(pg, 'Springfield');
  const regions = await pg.$$eval('#searchResults .row-note', ns => ns.map(n => n.textContent));
  check(regions.length === 5 && new Set(regions).size === 5, `same-named places are distinguishable (${regions.join(' | ')})`);
  check(regions.some(r => r.startsWith('Clark')) && regions.some(r => r.startsWith('Knox')), 'county shown when state and country also match');
  await shot(pg, '12-search-springfield-390');
  const rowH = await pg.$$eval('#searchResults .row-btn', bs => Math.min(...bs.map(b => b.offsetHeight)));
  check(rowH >= 44, `result rows are comfortable tap targets (${rowH}px)`);

  // another US city, with a monitor
  await pick(pg, 'New York');
  check(await txt(pg, '#placeName') === 'New York' && await txt(pg, '#plateModel') === 'US AQI · United States', 'New York selected; header names the country');
  check(await txt(pg, '#readout .badge') === 'Measured' && /Manhattan Synthetic/.test(await txt(pg, '#readout')), 'New York shows its AirNow monitor as measured');
  check(/E[DS]T/.test(await txt(pg, '#readout .ro-fresh')), `New York times in Eastern time (${await txt(pg, '#readout .ro-fresh')})`);
  check(!/Bay Area/.test(await txt(pg, 'main')), 'no Bay Area status text outside the Bay Area');

  // a US city without a monitor nearby: model estimate, not a failure
  await pick(pg, 'Denver');
  check(await txt(pg, '#readout .badge') === 'Model estimate', 'Denver without monitors reads as model estimate');
  check(/No reporting AirNow monitor within 10 km/.test(await txt(pg, '#readout')) && !/unavailable/i.test(await txt(pg, '#readout')),
    'missing US monitor coverage is stated, not reported as a feed failure');

  // Europe: comma-qualified search, CAMS Europe 0.1° cells, no AirNow
  const airnowBefore = reqs.airnow.length;
  await search(pg, 'Paris, France');
  check((await pg.$$('#searchResults [data-result]')).length === 1, 'comma qualifier narrows “Paris, France” to one result');
  await pg.click('#searchResults [data-result="0"]');
  await waitModel(pg);
  const pm = reqs.model.at(-1);
  check(pm.domain === 'cams_europe' && pm.cellSel === 'nearest', 'Paris model request uses CAMS Europe');
  check(reqs.airnow.length === airnowBefore, 'AirNow is not queried outside North America');
  check(await txt(pg, '#readout .badge') === 'Model estimate' && !/Measured/.test(await txt(pg, '#readout')), 'Paris reading is a model estimate, never “measured”');
  check(/only checked in North America/.test(await txt(pg, '#readout')) && !/unavailable/i.test(await txt(pg, '#readout')), 'Paris explains missing monitor coverage without calling it a failure');
  check(await pg.$eval('#lgMeas', e => e.hidden), 'timeline legend drops “Measured now” where no monitors exist');
  check(/~10 km cell/.test(await txt(pg, '#readout')), 'Paris readout cites the ~10 km European cell');
  check(await txt(pg, '#plateModel') === 'US AQI · France' && /US AQI/.test(await txt(pg, '#readout .ro-unit')), 'US AQI labelling stays explicit in France');
  check(/GMT\+1/.test(await txt(pg, '#readout .ro-fresh')), `Paris times in Paris time (${await txt(pg, '#readout .ro-fresh')})`);
  check(/Not checked here/.test(await txt(pg, '#sources')) && /CAMS Europe cell centred at 48\.85, 2\.35/.test(await txt(pg, '#sources')), 'sources: AirNow not checked; Paris cell 48.85, 2.35');
  check(await offCentre(pg, '#previewMap .leaflet-overlay-pane path', '#previewMap') < 12, 'nearby preview follows Paris');
  // timeline still scrubs and returns to now
  const tb = await (await pg.$('#tlHome svg')).boundingBox();
  await pg.touchscreen.tap(tb.x + tb.width * 0.8, tb.y + tb.height * 0.5);
  check(/Forecast/.test(await txt(pg, '#readout .badge')), 'Paris timeline: forecast hours selectable');
  await pg.click('#tlHome ~ .tl-controls [data-now]');
  check(await txt(pg, '#readout .badge') === 'Model estimate', 'Paris timeline: Now returns to the current estimate');
  await shot(pg, '13-home-paris-390', true);

  await pg.click('#openMap');
  await pg.waitForTimeout(500);
  check(await offCentre(pg, '.mk-sel') < 12, 'map opens centred on Paris');
  await pg.click('.seg [data-mode="field"]');
  await pg.waitForFunction(() => document.querySelectorAll('#map .leaflet-overlay-pane path').length > 0);
  const ef = reqs.field.at(-1);
  check(ef.domain === 'cams_europe' && ef.lats.length === 99 && ef.lats.every(v => onGrid(v, 0.1, 0.05)) && ef.lons.every(v => onGrid(v, 0.1, 0.05)),
    `Paris field: 99 native 0.1° CAMS Europe cells centred on x.x5 (${ef.lats.slice(0, 3).join(', ')}…)`);
  check((await pg.$$('#map .leaflet-overlay-pane path')).length === 99, 'Paris field draws exactly its own 99 cells');
  check(/CAMS Europe model · ~10 km cells/.test(await txt(pg, '#exLegend')), 'field legend names the European ~10 km grid');
  await shot(pg, '14-map-paris-field');
  await pg.click('.seg [data-mode="locations"]');
  await pg.waitForTimeout(200);
  check(/No AirNow monitors outside North America/.test(await txt(pg, '#exLegend')) && (await pg.$$('.mk-mon')).length === 0, 'Paris locations mode shows no monitor markers');
  await shot(pg, '15-map-paris-locations');
  await pg.click('#exBack');
  await pg.waitForTimeout(300);

  // Asia: CAMS global, and the map recentres from Paris to Tokyo
  await pick(pg, 'Tokyo');
  check(reqs.model.at(-1).domain === 'cams_global' && /GMT\+9/.test(await txt(pg, '#readout .ro-fresh')), 'Tokyo uses CAMS global and Tokyo time');
  check(await txt(pg, '#plateModel') === 'US AQI · Japan' && /~40 km cell/.test(await txt(pg, '#readout')), 'Tokyo header and ~40 km cell');
  await pg.click('#openMap');
  await pg.waitForTimeout(500);
  check(await offCentre(pg, '.mk-sel') < 12, 'map recentres on Tokyo after Paris');
  await pg.click('.seg [data-mode="field"]');
  await pg.waitForFunction(() => document.querySelectorAll('#map .leaflet-overlay-pane path').length === 63, null, { timeout: 5000 }).catch(() => {});
  const tf = reqs.field.at(-1);
  check(tf.domain === 'cams_global' && tf.lats.length === 63 && tf.lats.every(v => onGrid(v, 0.4, 0)), 'Tokyo field: 63 native 0.4° cells');
  check((await pg.$$('#map .leaflet-overlay-pane path')).length === 63, 'no Paris cells left on the Tokyo map');
  await shot(pg, '16-map-tokyo-field');
  await pg.click('#exBack');
  await pg.waitForTimeout(300);

  // remembered across visits
  await pg.reload();
  await waitModel(pg);
  check(await txt(pg, '#placeName') === 'Tokyo' && reqs.model.at(-1).domain === 'cams_global', 'selected place survives a reload');
  await pg.click('#placeBtn');
  check((await pg.$$eval('#recentList .row-main', r => r.map(x => x.textContent))).slice(0, 2).join() === 'Tokyo,Paris', 'recent searches listed, newest first');
  await pg.click('#placeClose');
  check(errors.length === 0, `no console errors (${errors.join(' | ')})`);
  await ctx.close();
}

{ // search failure and empty results; shortcuts still work
  const { pg, ctx, errors } = await page(browser, { width: 390, height: 844, failGeo: true });
  await waitModel(pg);
  await search(pg, 'Paris');
  check(await pg.$eval('#searchStatus', e => e.dataset.state) === 'error' && /Search is unavailable/.test(await txt(pg, '#searchStatus'))
    && !!(await pg.$('#searchStatus [data-retry-search]')), 'search failure shows a message and Retry');
  check(await pg.$eval('#placeDialog', d => d.open), 'dialog stays open on search failure');
  await shot(pg, '17-search-error');
  await pg.click('#placeList [data-place="1"]');
  await waitModel(pg);
  check(await txt(pg, '#placeName') === 'Oakland', 'Bay Area shortcut works while search is down');
  check(errors.length === 0, `no console errors (${errors.join(' | ')})`);
  await ctx.close();
}
{
  const { pg, ctx } = await page(browser, { width: 390, height: 844 });
  await waitModel(pg);
  await search(pg, 'Zzyzxq');
  check(/No places found for “Zzyzxq”/.test(await txt(pg, '#searchStatus')) && (await pg.$$('#searchResults .row-btn')).length === 0, 'empty search result is explained');
  await pg.fill('#placeQuery', 'P');
  await pg.waitForTimeout(450);
  check(/at least 2 letters/.test(await txt(pg, '#searchStatus')), 'one-letter query asks for more');
  await pg.press('#placeQuery', 'Enter');
  check(await pg.$eval('#placeDialog', d => d.open), 'Enter in the search field does not close the chooser');
  await ctx.close();
}

{ // rapid switching: a slow Paris response must not overwrite Tokyo
  const { pg, ctx, errors } = await page(browser, { width: 390, height: 844, slow: [{ lat: 48.85, lon: 2.35, delay: 2500, value: 222 }] });
  await waitModel(pg);
  await search(pg, 'Paris, France');
  await pg.click('#searchResults [data-result="0"]');
  await pg.click('#openMap');
  await pg.click('.seg [data-mode="field"]');      // Paris field request now in flight
  await pg.waitForTimeout(150);
  await pg.click('#exBack');
  await pg.waitForTimeout(150);
  await pick(pg, 'Tokyo');                           // Paris model and field still pending
  await pg.click('#openMap');
  await pg.waitForTimeout(3000);                     // let the slow Paris responses land
  check(await txt(pg, '#placeName') === 'Tokyo' && await txt(pg, '#readout .ro-num') !== '222', 'late Paris model response is ignored');
  check(/cell centred at 35\.60, 139\.60/.test(await txt(pg, '#sources')), 'sources describe the Tokyo cell');
  const cells = await pg.$$eval('.cell-label', ls => ls.map(l => l.textContent));
  check((await pg.$$('#map .leaflet-overlay-pane path')).length === 63 && !cells.includes('222'), 'late Paris field response is not drawn');
  check(await offCentre(pg, '.mk-sel') < 12, 'map is centred on Tokyo after rapid switching');
  check(errors.length === 0, `no console errors (${errors.join(' | ')})`);
  await ctx.close();
}

{ // 320px dark: chooser and a long European name
  const { pg, ctx, errors } = await page(browser, { width: 320, height: 568, dark: true });
  await waitModel(pg);
  await search(pg, 'Springfield');
  const dOver = await pg.$eval('#placeDialog', d => d.scrollWidth - d.clientWidth);
  check(dOver <= 0, `chooser fits 320px (overflow ${dOver})`);
  const top = await pg.$eval('#placeQuery', e => e.getBoundingClientRect().top);
  check(top < 120, `search field sits near the top, clear of the keyboard (${Math.round(top)}px)`);
  await shot(pg, '18-search-320-dark');
  await pick(pg, 'Llanfair');
  const over = await pg.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(over <= 0, `long place name causes no horizontal scroll at 320px (overflow ${over})`);
  await shot(pg, '19-home-wales-320-dark', true);
  await pg.click('#openMap');
  await pg.waitForTimeout(500);
  await shot(pg, '20-map-wales-320-dark');
  check(errors.length === 0, `no console errors (${errors.join(' | ')})`);
  await ctx.close();
}

{ // narrow iPhone SE (1st gen) width, dark
  const { pg, ctx, errors } = await page(browser, { width: 320, height: 568, dark: true });
  await pg.waitForSelector('.ro-num:not(.is-blank)');
  await pg.waitForTimeout(300);
  const overflow = await pg.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(overflow <= 0, `no horizontal scroll at 320px (overflow ${overflow})`);
  await shot(pg, '07-home-320-dark', true);
  await pg.click('#openMap');
  await pg.waitForTimeout(500);
  await shot(pg, '08-map-320-dark');
  const small = await pg.$$eval('button:not([hidden])', bs => bs.filter(b => b.offsetParent && (b.offsetHeight < 40 || b.offsetWidth < 40)).map(b => b.textContent.trim() || b.getAttribute('aria-label')));
  check(small.length === 0, `buttons ≥40px (${small.join(', ')})`);
  check(errors.length === 0, `no console errors (${errors.join(' | ')})`);
  await ctx.close();
}

{ // slow model + monitor outage
  const { pg, ctx, errors, tiles } = await page(browser, { width: 375, height: 667, failMonitors: true, failTiles: true, modelDelay: 7000 });
  await pg.waitForTimeout(5600);
  await shot(pg, '09-slow-loading');
  check(/Still loading/.test(await pg.$eval('#readout', e => e.textContent)), 'slow load shows a still-loading message');
  await pg.waitForSelector('.ro-num:not(.is-blank)', { timeout: 10000 });
  check(/Model estimate/.test(await pg.$eval('#readout .badge', e => e.textContent)), 'without monitors the reading is labelled as a model estimate');
  check(/unavailable/i.test(await pg.$eval('#sources', e => e.textContent)), 'monitor outage is reported in sources');
  await shot(pg, '10-no-monitors', true);
  check(tiles.osm > 0, `basemap falls back to OpenStreetMap when Esri fails (esri ${tiles.esri}, osm ${tiles.osm})`);
  check(errors.length === 0, `no console errors (${errors.join(' | ')})`);
  await ctx.close();
}

{ // model failure
  const { pg, ctx } = await page(browser, { width: 375, height: 667, failModel: true });
  try { await pg.waitForSelector('[data-retry="model"]', { timeout: 8000 }); } catch { await shot(pg, '11-model-error-timeout'); log(await pg.$eval('#readout', e => e.innerHTML)); }
  await shot(pg, '11-model-error');
  check(true, 'model error shows retry');
  await ctx.close();
}

await browser.close();
server.close();
log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
