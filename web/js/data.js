// Data access. Everything runs in the browser; no keys, no backend.
//   Model:    Open-Meteo Air Quality API (CAMS global, ~40 km grid). CORS-enabled, CC BY 4.0.
//   Monitors: U.S. EPA AirNow latest-hour site data, published by EPA as a public
//             ArcGIS Online feature service (CORS-enabled, keyless).

const OM_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const AIRNOW_URL =
  'https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/Air%20Now%20Current%20Monitor%20Data%20Public/FeatureServer/0/query';

export const MONITOR_BBOX = [-123.3, 36.9, -121.2, 38.9]; // lon/lat, Bay Area + margin
export const FIELD_STEP = 0.4;                             // degrees; matches CAMS global spacing
const FIELD_LATS = range(36.6, 39.4, FIELD_STEP);
const FIELD_LONS = range(-123.8, -120.6, FIELD_STEP);

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

function range(a, b, step) {
  const out = [];
  for (let v = a; v <= b + 1e-9; v += step) out.push(+v.toFixed(3));
  return out;
}

async function getJSON(url, timeoutMs = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) {
      let reason = '';
      try { reason = (await res.json()).reason || ''; } catch {}
      throw new Error(`HTTP ${res.status}${reason ? ' · ' + reason : ''}`);
    }
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`No response after ${timeoutMs / 1000} s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function cached(key, maxAgeMs, load) {
  try {
    const hit = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (hit && Date.now() - hit.fetchedAt < maxAgeMs) return Promise.resolve(hit);
  } catch {}
  return load().then(v => {
    try { sessionStorage.setItem(key, JSON.stringify(v)); } catch {}
    return v;
  });
}

const HOURLY = [
  'us_aqi', 'us_aqi_pm2_5', 'us_aqi_pm10', 'us_aqi_ozone', 'us_aqi_nitrogen_dioxide',
  'us_aqi_carbon_monoxide', 'us_aqi_sulphur_dioxide',
  'pm2_5', 'pm10', 'ozone', 'nitrogen_dioxide', 'carbon_monoxide', 'sulphur_dioxide',
];

export function fetchModel(lat, lon) {
  const la = lat.toFixed(3), lo = lon.toFixed(3);
  return cached(`om:${la},${lo}`, 10 * 60e3, async () => {
    const q = new URLSearchParams({
      latitude: la, longitude: lo, hourly: HOURLY.join(','),
      past_days: '3', forecast_days: '5', timezone: 'auto', timeformat: 'unixtime',
    });
    const j = await getJSON(`${OM_URL}?${q}`);
    if (!j.hourly?.time?.length) throw new Error('Model response had no hourly data');
    const series = {};
    for (const k of HOURLY) series[k] = j.hourly[k] || [];
    return {
      lat: j.latitude, lon: j.longitude, tz: j.timezone || 'America/Los_Angeles',
      times: j.hourly.time, series, units: j.hourly_units || {}, fetchedAt: Date.now(),
    };
  });
}

// Regional field: one hourly us_aqi series per CAMS grid cell, requested in a single
// multi-coordinate call. Cells are drawn as-is; nothing is interpolated.
export function fetchField() {
  return cached('om:field:v1', 20 * 60e3, async () => {
    const lats = [], lons = [];
    for (const la of FIELD_LATS) for (const lo of FIELD_LONS) { lats.push(la); lons.push(lo); }
    const q = new URLSearchParams({
      latitude: lats.join(','), longitude: lons.join(','), hourly: 'us_aqi',
      past_days: '2', forecast_days: '4', timezone: 'GMT', timeformat: 'unixtime',
    });
    const j = await getJSON(`${OM_URL}?${q}`, 25000);
    const arr = Array.isArray(j) ? j : [j];
    const seen = new Set();
    const cells = [];
    for (const r of arr) {
      const key = `${r.latitude.toFixed(2)},${r.longitude.toFixed(2)}`;
      if (seen.has(key) || !r.hourly) continue;
      seen.add(key);
      cells.push({ lat: r.latitude, lon: r.longitude, aqi: r.hourly.us_aqi || [] });
    }
    return { times: arr[0]?.hourly?.time || [], cells, step: FIELD_STEP, fetchedAt: Date.now() };
  });
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

export function fetchMonitors() {
  return cached('airnow:v1', 10 * 60e3, async () => {
    const q = new URLSearchParams({
      where: '1=1', geometry: MONITOR_BBOX.join(','), geometryType: 'esriGeometryEnvelope',
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
    return { list, fields, mapping: F, fetchedAt: Date.now() };
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

// Value of the field cell whose centre is closest to a point (within one cell).
export function fieldValueAt(field, lat, lon, tIdx) {
  if (!field?.cells?.length || tIdx < 0) return null;
  const half = field.step / 2 + 1e-6;
  const c = field.cells.find(c => Math.abs(c.lat - lat) <= half && Math.abs(c.lon - lon) <= half);
  return c ? c.aqi[tIdx] ?? null : null;
}

// Index of the last hour at or before t (seconds).
export function indexAtOrBefore(times, t) {
  let idx = -1;
  for (let i = 0; i < times.length; i++) { if (times[i] <= t) idx = i; else break; }
  return idx;
}
