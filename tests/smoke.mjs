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
    v.push(i < nullHead || i >= n - nullTail ? null : Math.round(45 + 25 * Math.sin((i + seed) / 9) + 12 * Math.sin((i + seed) / 3.1)));
  }
  return { time, v };
}
function omPoint(lat, lon, past, ahead, seed, vars) {
  const s = series(past, ahead, seed);
  const hourly = { time: s.time };
  for (const k of vars) hourly[k] = s.v.map(x => (x == null ? null : k.startsWith('us_aqi_') ? Math.round(x * (k.includes('pm2_5') ? 0.95 : k.includes('ozone') ? 0.7 : 0.25)) : k.startsWith('us_aqi') ? x : +(x / 4).toFixed(1)));
  return { latitude: lat, longitude: lon, timezone: 'America/Los_Angeles', utc_offset_seconds: -25200, hourly, hourly_units: { pm2_5: 'μg/m³' } };
}
function openMeteo(url, failModel) {
  const q = new URL(url).searchParams;
  const lats = q.get('latitude').split(',').map(Number), lons = q.get('longitude').split(',').map(Number);
  const vars = q.get('hourly').split(',');
  const past = +q.get('past_days'), ahead = +q.get('forecast_days');
  if (lats.length === 1) {
    if (failModel) return { status: 500, body: { error: true, reason: 'Synthetic failure' } };
    return { status: 200, body: omPoint(Math.round(lats[0] / 0.4) * 0.4, Math.round(lons[0] / 0.4) * 0.4, past, ahead, lats[0] * 10, vars) };
  }
  return { status: 200, body: lats.map((la, i) => omPoint(la, lons[i], past, ahead, (la + lons[i]) * 7, vars)) };
}
const MON = [
  ['San Francisco', 37.7658, -122.3978, 41, 22], ['Oakland West', 37.8148, -122.2825, 58, 30],
  ['San Rafael', 37.9722, -122.5189, 33, 18], ['San Jose Jackson', 37.3486, -121.8949, 72, 40],
  ['Napa Valley College', 38.2786, -122.2753, 28, null], ['Livermore', 37.6875, -121.7842, null, 51],
];
const arcgis = () => ({
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

async function page(browser, { width, height, failMonitors, failModel, modelDelay = 0, dark = false }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: dark ? 'dark' : 'light' });
  const pg = await ctx.newPage();
  const errors = [];
  pg.on('pageerror', e => errors.push(e.message));
  pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await pg.route(/^https?:\/\/(?!localhost)/, async route => {
    const url = route.request().url();
    if (url.includes('open-meteo.com')) {
      if (modelDelay && !new URL(url).searchParams.get('latitude').includes(',')) await new Promise(r => setTimeout(r, modelDelay));
      const r = openMeteo(url, failModel);
      return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) });
    }
    if (url.includes('services.arcgis.com')) {
      if (failMonitors) return route.fulfill({ status: 503, body: 'down' });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(arcgis()) });
    }
    if (url.includes('cartocdn')) return route.fulfill({ contentType: 'image/png', body: PNG });
    return route.abort();
  });
  await pg.goto(BASE);
  return { pg, ctx, errors };
}

const shot = (pg, name, full = false) => pg.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
const sheetH = pg => pg.$eval('#sheet', el => el.getBoundingClientRect().height);
const log = (...a) => console.log(...a);

const browser = await chromium.launch();
let failures = 0;
const check = (cond, msg) => { log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

{ // main flow, iPhone 14-ish
  const { pg, ctx, errors } = await page(browser, { width: 390, height: 844 });
  await pg.waitForSelector('.ro-num:not(.is-blank)');
  await pg.waitForTimeout(300);
  await shot(pg, '01-home-390', true);
  check(await pg.$eval('.ro .badge', b => b.textContent) === 'Measured', 'home shows measured reading near a monitor');

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
  check((await pg.$$('.leaflet-overlay-pane path')).length > 20, 'air quality mode draws model cells');
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
  const { pg, ctx, errors } = await page(browser, { width: 375, height: 667, failMonitors: true, modelDelay: 7000 });
  await pg.waitForTimeout(5600);
  await shot(pg, '09-slow-loading');
  check(/Still loading/.test(await pg.$eval('#readout', e => e.textContent)), 'slow load shows a still-loading message');
  await pg.waitForSelector('.ro-num:not(.is-blank)', { timeout: 10000 });
  check(/Model estimate/.test(await pg.$eval('#readout .badge', e => e.textContent)), 'without monitors the reading is labelled as a model estimate');
  check(/unavailable/i.test(await pg.$eval('#sources', e => e.textContent)), 'monitor outage is reported in sources');
  await shot(pg, '10-no-monitors', true);
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
