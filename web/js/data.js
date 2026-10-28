// Data access. Everything runs in the browser; no keys, no backend.
//   Model:    Open-Meteo Air Quality API (CAMS global ~40 km; CAMS Europe ~10 km). CORS-enabled, CC BY 4.0.
//   Places:   Open-Meteo Geocoding API (GeoNames). CORS-enabled, CC BY 4.0.
//   Monitors: U.S. EPA AirNow latest-hour site data, published by EPA as a public
//             ArcGIS Online feature service (CORS-enabled, keyless).

const OM_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const AIRNOW_URL =
  'https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/Air%20Now%20Current%20Monitor%20Data%20Public/FeatureServer/0/query';

// CAMS grids as Open-Meteo stores them (open-meteo/open-meteo, Sources/App/Cams/CamsDomain.swift):
//   cams_global  0.4° regular grid, cell centres on multiples of 0.4°, 121 forecast hours.
//   cams_europe  0.1° grid, centres 30.05–71.95°N and 24.95°W–44.95°E (x.x5), 97 forecast hours.
// Requests name the domain explicitly and use cell_selection=nearest, so the point reading and
// the map field come from the same cells. The lat/lon Open-Meteo echoes back belongs to an
// auxiliary grid, so cell positions are computed here instead of read from the response.
// rows/cols: field half-size in cells (global 7×9 cells, Europe 9×11); view: map half-height in degrees.
export const DOMAINS = {
  cams_global: { id: 'cams_global', name: 'CAMS global', step: 0.4, lat0: -90, lon0: -180, nLat: 451, nLon: 900, wrap: true,
    km: '~40 km', rows: 3, cols: 4, view: 0.7 },
  cams_europe: { id: 'cams_europe', name: 'CAMS Europe', step: 0.1, lat0: 30.05, lon0: -24.95, nLat: 420, nLon: 700, wrap: false,
    km: '~10 km', rows: 4, cols: 5, view: 0.35 },
};
export const domainFor = (lat, lon) =>
  (lat >= 30 && lat < 72 && lon >= -25 && lon < 45 ? DOMAINS.cams_europe : DOMAINS.cams_global);

const normLon = lon => ((((lon + 180) % 360) + 360) % 360) - 180;
const clampIdx = (i, n) => Math.max(0, Math.min(n - 1, i));

// Native model cell containing a point: { domain, i, j, lat, lon } (centre, degrees).
export function modelCell(lat, lon) {
  const d = domainFor(lat, lon);
  const i = clampIdx(Math.round((lat - d.lat0) / d.step), d.nLat);
  let j = Math.round((normLon(lon) - d.lon0) / d.step);
  j = d.wrap ? ((j % d.nLon) + d.nLon) % d.nLon : clampIdx(j, d.nLon);
  return { domain: d, i, j, lat: +(d.lat0 + i * d.step).toFixed(2), lon: +normLon(d.lon0 + j * d.step).toFixed(2) };
}

// Block of native cells around a point. `lon` is kept continuous with the point for drawing
// across the antimeridian; `qlon` is the normalised value sent to the API.
export function fieldSpec(lat, lon) {
  const c = modelCell(lat, lon), d = c.domain;
  const base = c.lon + 360 * Math.round((lon - c.lon) / 360);
  const cells = [];
  for (let i = c.i - d.rows; i <= c.i + d.rows; i++) {
    if (i < 0 || i >= d.nLat) continue;
    for (let dj = -d.cols; dj <= d.cols; dj++) {
      const j = c.j + dj;
      if (!d.wrap && (j < 0 || j >= d.nLon)) continue;
      const la = +(d.lat0 + i * d.step).toFixed(2);
      const lo = +(base + dj * d.step).toFixed(2);
      const jj = d.wrap ? ((j % d.nLon) + d.nLon) % d.nLon : j;
      cells.push({ ck: `${i},${jj}`, lat: la, lon: lo, qlat: la, qlon: +normLon(lo).toFixed(2) });
    }
  }
  return { domain: d.id, step: d.step, key: `${d.id}:${c.i},${c.j}`, ci: c.i, cj: c.j, cells };
}

// True when the point's native cell is part of the loaded field, so the field can be reused as is.
export function fieldHolds(field, lat, lon) {
  if (!field?.cells?.length) return false;
  const c = modelCell(lat, lon), d = c.domain;
  if (d.id !== field.domain) return false;
  const ck = `${c.i},${c.j}`;
  return field.cells.some(x => x.ck === ck);
}

// Map framing around a point; same aspect as the original Bay Area view.
export function viewBounds(lat, lon) {
  const h = domainFor(lat, lon).view;
  const w = (h * 0.676) / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  return [[lat - h, lon - w], [lat + h, lon + w]];
}

export const BAY_BOX = [-123.3, 36.9, -121.2, 38.9]; // lon/lat, Bay Area + margin
export const inBayArea = (lat, lon) => lon >= BAY_BOX[0] && lon <= BAY_BOX[2] && lat >= BAY_BOX[1] && lat <= BAY_BOX[3];

// The AirNow feed is queried only in North America (US, Canada, Mexico and nearby).
// Elsewhere the app does not ask, and says monitors are not available rather than failing.
const AIRNOW_REGION = [-170, 14, -50, 72];
export const airnowCovers = (lat, lon) =>
  lon >= AIRNOW_REGION[0] && lon <= AIRNOW_REGION[2] && lat >= AIRNOW_REGION[1] && lat <= AIRNOW_REGION[3];
// Monitor query box: ±1° lat, ±1.25° lon around a 0.5° snapped centre (keeps cache keys stable).
export function monitorBox(lat, lon) {
  const la = Math.round(lat * 2) / 2, lo = Math.round(lon * 2) / 2;
  return [lo - 1.25, la - 1, lo + 1.25, la + 1];
}
export const boxHolds = (b, lat, lon, m = 0.4) =>
  !!b && lon >= b[0] + m && lon <= b[2] - m && lat >= b[1] + m && lat <= b[3] - m;

export const PLACES = [
  { name: 'San Francisco', lat: 37.7749, lon: -122.4194 },
  { name: 'Oakland',       lat: 37.8044, lon: -122.2712 },
  { name: 'Berkeley',      lat: 37.8715, lon: -122.2730 },
  { name: 'Richmond',      lat: 37.9358, lon: -122.3478 },
  { name: 'San Rafael',    lat: 37.9735, lon: -122.5311 },
  { name: 'Novato',        lat: 38.1074, lon: -122.5697 },
  { name: 'Santa Rosa',    lat: 38.4404, lon: -122.7141 },
  { name: 'Napa',          lat: 38.2975, lon: -122.2869 },
  { name: 'Vallejo',       lat: 38.1041, lon: -122.2566 },
  { name: 'Concord',       lat: 37.9780, lon: -122.0311 },
  { name: 'Livermore',     lat: 37.6819, lon: -121.7680 },
  { name: 'Fremont',       lat: 37.5485, lon: -121.9886 },
  { name: 'Palo Alto',     lat: 37.4419, lon: -122.1430 },
  { name: 'San Jose',      lat: 37.3382, lon: -121.8863 },
  { name: 'Half Moon Bay', lat: 37.4636, lon: -122.4286 },
];

// Open-Meteo usage, as its server counts it (open-meteo/open-meteo, ForecastApiResult.calculateQueryWeight
// and RateLimiter): each location in a request costs max(1, variables/10 × max(1, days/14)) calls, so a
// 63-cell field costs 63 and a 13-variable point series 1.3. Free limits are 600 calls a minute, 5,000 an
// hour and 10,000 a day per IP, and failed requests are charged 1 each. A limit answers HTTP 429 with a
// reason and a Retry-After header (exposed to browsers by CORS).
export class ApiError extends Error {
  constructor(message, { status = 0, reason = '', retryAfter = null } = {}) {
    super(message);
    this.status = status; this.reason = reason; this.retryAfter = retryAfter;
  }
}

async function getJSON(url, timeoutMs = 15000, signal) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  const relay = () => ctl.abort();
  if (signal?.aborted) ctl.abort(); else signal?.addEventListener('abort', relay);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) {
      let reason = '';
      try { reason = (await res.json()).reason || ''; } catch {}
      const ra = parseFloat(res.headers.get('retry-after'));
      throw new ApiError(`HTTP ${res.status}${reason ? ' · ' + reason : ''}`,
        { status: res.status, reason, retryAfter: Number.isFinite(ra) && ra >= 0 ? ra : null });
    }
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError' && timedOut) throw new Error(`No response after ${timeoutMs / 1000} s`);
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relay);
  }
}

// After a 429 the air-quality API is left alone until the provider's Retry-After has passed
// (or, without one, the end of the window its message names). Nothing retries by itself;
// requests made meanwhile fail at once without reaching the network, since errors are charged too.
let pause = null;
export const omPause = () => (pause && Date.now() < pause.until ? pause : null);
function pauseFrom(e) {
  const r = e.reason || '';
  const kind = /minutely/i.test(r) ? 'minute' : /hourly/i.test(r) ? 'hour' : /daily/i.test(r) ? 'day'
    : /concurrent/i.test(r) ? 'concurrent' : 'other';
  const fallback = { minute: 60, hour: 3600, day: 86400, concurrent: 5, other: 60 }[kind];
  pause = { kind, reason: r, until: Date.now() + 1000 * (e.retryAfter ?? fallback) };
  return pause;
}
async function omJSON(url, timeoutMs, signal) {
  const p = omPause();
  if (p) throw Object.assign(new Error('Open-Meteo usage limit reached'), { pause: p });
  try { return await getJSON(url, timeoutMs, signal); }
  catch (e) {
    if (e.status === 429) e.pause = pauseFrom(e);
    throw e;
  }
}

// sessionStorage survives reloads; the in-memory copy keeps repeated reads (map markers on every
// timeline scrub) from re-parsing JSON.
const mem = new Map();
function readCache(key, maxAgeMs) {
  let hit = mem.get(key);
  if (!hit) try { hit = JSON.parse(sessionStorage.getItem(key) || 'null'); if (hit) mem.set(key, hit); } catch {}
  return hit && Date.now() - hit.fetchedAt < maxAgeMs ? hit : null;
}
function writeCache(key, v) { mem.set(key, v); try { sessionStorage.setItem(key, JSON.stringify(v)); } catch {} }

function cached(key, maxAgeMs, load) {
  const hit = readCache(key, maxAgeMs);
  if (hit) return Promise.resolve(hit);
  return load().then(v => { writeCache(key, v); return v; });
}

const HOURLY = [
  'us_aqi', 'us_aqi_pm2_5', 'us_aqi_pm10', 'us_aqi_ozone', 'us_aqi_nitrogen_dioxide',
  'us_aqi_carbon_monoxide', 'us_aqi_sulphur_dioxide',
  'pm2_5', 'pm10', 'ozone', 'nitrogen_dioxide', 'carbon_monoxide', 'sulphur_dioxide',
];
const MODEL_TTL = 10 * 60e3;

// Point series for the native cell holding a place. With nearest-cell selection and a named domain,
// every point in one cell gets the same values, so the cache is keyed by domain, cell and time zone.
// When the zone is not known in advance (map taps, GPS) the request asks for timezone=auto and is
// keyed by its own coordinates; its answer is then also filed under the zone it came back with.
export async function fetchModel(lat, lon, tz, signal) {
  const cell = modelCell(lat, lon), d = cell.domain.id;
  const cellKey = z => `om3:pt:${d}:${cell.i},${cell.j}:${z}`;
  const key = tz ? cellKey(tz) : `om3:pt:${d}:${lat.toFixed(3)},${lon.toFixed(3)}`;
  const hit = readCache(key, MODEL_TTL);
  if (hit) return hit;
  const q = new URLSearchParams({
    latitude: lat.toFixed(3), longitude: lon.toFixed(3), hourly: HOURLY.join(','), domains: d, cell_selection: 'nearest',
    past_days: '3', forecast_days: '5', timezone: tz || 'auto', timeformat: 'unixtime',
  });
  const j = await omJSON(`${OM_URL}?${q}`, 15000, signal);
  if (!j.hourly?.time?.length) throw new Error('Model response had no hourly data');
  const series = {};
  for (const k of HOURLY) series[k] = j.hourly[k] || [];
  const v = {
    domain: d, cellLat: cell.lat, cellLon: cell.lon, tz: j.timezone || tz || 'GMT',
    times: j.hourly.time, series, units: j.hourly_units || {}, fetchedAt: Date.now(),
  };
  writeCache(key, v);
  if (!tz) writeCache(cellKey(v.tz), v);
  return v;
}

// Point series already held for a place (no request): by cell and known zone, else by coordinates.
export function cachedModel(lat, lon, tz) {
  const cell = modelCell(lat, lon), d = cell.domain.id;
  return readCache(tz ? `om3:pt:${d}:${cell.i},${cell.j}:${tz}` : `om3:pt:${d}:${lat.toFixed(3)},${lon.toFixed(3)}`, MODEL_TTL);
}

// Model field: hourly us_aqi per native CAMS cell, drawn as-is, never interpolated. Cells are cached
// one by one per domain (GMT time axis, so no local zone is involved), and a request asks only for the
// cells of the block that are not already held. Moving one column over costs one column, not a block.
const FIELD_TTL = 20 * 60e3, FIELD_MAX = 900;
const cellStores = {};
function cellStore(domain) {
  if (!cellStores[domain]) {
    let m = new Map();
    try { m = new Map(Object.entries(JSON.parse(sessionStorage.getItem(`om3:cells:${domain}`) || '{}'))); } catch {}
    cellStores[domain] = m;
  }
  const m = cellStores[domain], now = Date.now();
  for (const [k, c] of m) if (now - c.fetchedAt >= FIELD_TTL) m.delete(k);
  return m;
}
function saveCells(domain) {
  const m = cellStores[domain];
  while (m.size > FIELD_MAX) m.delete(m.keys().next().value); // oldest first (insertion order)
  try { sessionStorage.setItem(`om3:cells:${domain}`, JSON.stringify(Object.fromEntries(m))); } catch {}
}

// Value of a field cell at an hour (epoch s): the hour at or before t, or null outside its range.
export function cellAt(c, t) {
  if (!c?.aqi || t == null) return null;
  const k = Math.floor((t - c.t0) / 3600);
  return k >= 0 && k < c.aqi.length ? c.aqi[k] ?? null : null;
}
export const fieldCovers = (field, t) =>
  !!field?.cells?.some(c => c.aqi && t >= c.t0 && t < c.t0 + c.aqi.length * 3600);

export async function fetchField(spec, signal) {
  const store = cellStore(spec.domain);
  const missing = spec.cells.filter(c => !store.has(c.ck));
  if (missing.length) {
    const q = new URLSearchParams({
      latitude: missing.map(c => c.qlat).join(','), longitude: missing.map(c => c.qlon).join(','),
      hourly: 'us_aqi', domains: spec.domain, cell_selection: 'nearest',
      past_days: '2', forecast_days: '4', timezone: 'GMT', timeformat: 'unixtime',
    });
    const j = await omJSON(`${OM_URL}?${q}`, 25000, signal);
    const arr = Array.isArray(j) ? j : [j];
    if (arr.length !== missing.length) throw new Error('Model field response did not match the request');
    const got = arr.map(r => ({ t: r?.hourly?.time || [], v: r?.hourly?.us_aqi || [] }));
    if (got.some(({ t }) => t.some((x, i) => i && x - t[i - 1] !== 3600))) throw new Error('Model field response was not hourly');
    const now = Date.now();
    missing.forEach((c, k) => store.set(c.ck, { t0: got[k].t[0] ?? 0, aqi: got[k].v.slice(0, got[k].t.length), fetchedAt: now }));
  }
  // Assembled before saving, so trimming the store to FIELD_MAX can never drop a cell of this block.
  const cells = spec.cells.map(c => ({ ck: c.ck, lat: c.lat, lon: c.lon, ...store.get(c.ck) }));
  if (missing.length) saveCells(spec.domain);
  return {
    cells, step: spec.step, domain: spec.domain, key: spec.key, ci: spec.ci, cj: spec.cj,
    requested: missing.length, fetchedAt: Math.min(...cells.map(c => c.fetchedAt)),
  };
}

// ---- place search ---------------------------------------------------------------
// The geocoder matches names only, so "Paris, France" is searched as "Paris" and the
// part after the comma narrows the results to a matching region or country.
export async function searchPlaces(text, signal) {
  const [name, ...rest] = text.split(',');
  const q = new URLSearchParams({ name: name.trim(), count: '10', language: 'en', format: 'json' });
  const j = await getJSON(`${GEO_URL}?${q}`, 10000, signal);
  let list = (j.results || [])
    .filter(r => Number.isFinite(r.latitude) && Number.isFinite(r.longitude) && r.name)
    .map(r => ({
      id: r.id, name: r.name, lat: r.latitude, lon: r.longitude, tz: r.timezone || null,
      admin1: r.admin1 || null, admin2: r.admin2 || null, country: r.country || null, cc: r.country_code || null,
    }));
  const qual = rest.join(',').trim().toLowerCase();
  if (qual) {
    const hit = list.filter(r => [r.admin1, r.admin2, r.country, r.cc].some(x => x && x.toLowerCase().startsWith(qual)));
    if (hit.length) list = hit;
  }
  return list;
}

// ---- AirNow monitors -----------------------------------------------------------
// The layer's field names aren't documented anywhere we could verify, so fields are
// matched by pattern and the raw schema is kept for the in-app feed inspector.

const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const NUMERIC = /Double|Single|Integer|SmallInteger/;

function mapFields(fields) {
  const find = (test, numeric = false) =>
    fields.find(f => test(norm(f.name), f) && (!numeric || NUMERIC.test(f.type)))?.name;
  const isAqi = n => n.includes('aqi') && !/cat|color|colour|label|desc|level|text/.test(n);
  return {
    name:    find(n => n.includes('sitename')) || find(n => n === 'name' || n === 'site'),
    id:      find(n => /^(aqsid|siteid|intlaqscode|fullaqscode|aqscode)$/.test(n)),
    agency:  find(n => n.includes('agency')),
    pm25Aqi: find(n => n.includes('pm25') && isAqi(n), true),
    o3Aqi:   find(n => /ozone|o3/.test(n) && isAqi(n), true),
    pm10Aqi: find(n => n.includes('pm10') && isAqi(n), true),
    pm25:    find(n => n.includes('pm25') && !n.includes('aqi') && !/unit|cat|flag/.test(n), true),
    o3:      find(n => /ozone|o3/.test(n) && !n.includes('aqi') && !/unit|cat|flag/.test(n), true),
    aqi:     find(n => /^(aqi|overallaqi|aqivalue|maxaqi)$/.test(n), true),
    time:    fields.find(f => f.type === 'esriFieldTypeDate')?.name ||
             find(n => /utc|time|date|hour/.test(n)),
    lat:     find(n => n === 'latitude' || n === 'lat', true),
    lon:     find(n => n === 'longitude' || n === 'lon' || n === 'long', true),
  };
}

const val = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

function parseTime(raw, fieldName) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') return raw > 1e11 ? raw : raw * 1000;
  let s = String(raw).trim();
  if (/utc|gmt/i.test(fieldName || '') && !/[zZ]|[+-]\d\d:?\d\d$/.test(s) && /\d:\d\d/.test(s)) {
    const t = Date.parse(s.replace(' ', 'T') + 'Z');
    if (!Number.isNaN(t)) return t;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

export function fetchMonitors(bbox) {
  return cached(`airnow:v2:${bbox.join(',')}`, 10 * 60e3, async () => {
    const q = new URLSearchParams({
      where: '1=1', geometry: bbox.join(','), geometryType: 'esriGeometryEnvelope',
      inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: '*',
      outSR: '4326', returnGeometry: 'true', f: 'json',
    });
    const j = await getJSON(`${AIRNOW_URL}?${q}`);
    if (j.error) throw new Error(j.error.message || 'AirNow feed returned an error');
    const fields = (j.fields || []).map(f => ({ name: f.name, type: f.type, alias: f.alias }));
    const F = mapFields(fields);
    const list = [];
    for (const feat of j.features || []) {
      const a = feat.attributes || {};
      const lat = feat.geometry?.y ?? val(a[F.lat]);
      const lon = feat.geometry?.x ?? val(a[F.lon]);
      if (lat == null || lon == null) continue;
      const pAqi = { pm2_5: val(a[F.pm25Aqi]), ozone: val(a[F.o3Aqi]), pm10: val(a[F.pm10Aqi]) };
      const present = Object.entries(pAqi).filter(([, v]) => v != null);
      const top = present.sort((x, y) => y[1] - x[1])[0];
      const aqi = val(a[F.aqi]) ?? top?.[1] ?? null;
      const rawTime = F.time ? a[F.time] : null;
      list.push({
        id: String(a[F.id] ?? `${lat.toFixed(4)},${lon.toFixed(4)}`),
        name: String(a[F.name] ?? 'Unnamed monitor').trim(),
        agency: F.agency ? a[F.agency] : null,
        lat, lon, aqi,
        dominant: top?.[0] ?? null,
        pollutantAqi: pAqi,
        conc: { pm2_5: val(a[F.pm25]), ozone: val(a[F.o3]) },
        ts: parseTime(rawTime, F.time),
        rawTime: rawTime == null ? null : String(rawTime),
      });
    }
    return { list, fields, mapping: F, bbox, fetchedAt: Date.now() };
  });
}

export function distanceKm(aLat, aLon, bLat, bLon) {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (bLat - aLat) * toR, dLon = (bLon - aLon) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toR) * Math.cos(bLat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function nearest(list, lat, lon, maxKm = Infinity, pred = () => true) {
  let best = null, bestD = maxKm;
  for (const x of list) {
    if (!pred(x)) continue;
    const d = distanceKm(lat, lon, x.lat, x.lon);
    if (d <= bestD) { best = x; bestD = d; }
  }
  return best ? { item: best, km: bestD } : null;
}

// Value of the field cell whose centre is closest to a point (within one cell), at hour t (epoch s).
export function fieldValueAt(field, lat, lon, t) {
  if (!field?.cells?.length || t == null) return null;
  const half = field.step / 2 + 1e-6;
  const c = field.cells.find(c => Math.abs(c.lat - lat) <= half && Math.abs(c.lon - lon) <= half);
  return c ? cellAt(c, t) : null;
}

// Index of the last hour at or before t (seconds).
export function indexAtOrBefore(times, t) {
  let idx = -1;
  for (let i = 0; i < times.length; i++) { if (times[i] <= t) idx = i; else break; }
  return idx;
}
