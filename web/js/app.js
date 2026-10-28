import { CATS, category, POLLUTANTS, scalePos } from './aqi.js';
import {
  fetchModel, fetchField, fetchMonitors, searchPlaces, PLACES, DOMAINS, nearest, fieldValueAt, indexAtOrBefore,
  domainFor, fieldSpec, fieldHolds, fieldCovers, cachedModel, viewBounds, inBayArea, airnowCovers, monitorBox, boxHolds, omPause,
} from './data.js';
import { Timeline } from './timeline.js';
import { Explorer, Preview } from './map.js';

const $ = s => document.querySelector(s);
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const MONITOR_RADIUS_KM = 10;
const MONITOR_FRESH_MS = 3 * 3600e3;
const MONITOR_SKEW_MS = 10 * 60e3;   // a report stamped later than this ahead of the clock is not trusted
const RECENT_MAX = 5;

const validPlace = p => !!p && typeof p.kind === 'string' && Number.isFinite(p.lat) && Number.isFinite(p.lon)
  && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
const savedPlace = store.get('aqi.place');

const S = {
  place: validPlace(savedPlace) ? savedPlace : { kind: 'preset', ...PLACES[0] },
  recent: (Array.isArray(store.get('aqi.recent')) ? store.get('aqi.recent') : []).filter(validPlace).slice(0, RECENT_MAX),
  model: null, dayParts: [], modelStatus: 'loading', modelError: null, modelStart: Date.now(),
  monitors: { status: 'loading', list: [], error: null, data: null, bbox: null },
  search: { q: '', status: 'idle', results: [], error: null },
  field: { status: 'idle', data: null, error: null },
  selT: null,          // selected hour (epoch s); null = follow "now"
  mode: 'locations',
  sheet: 'compact',
  hint: null,
};

// ---- formatting ---------------------------------------------------------------
const fmtCache = new Map();
const fmt = (opts, tz) => {
  const k = JSON.stringify(opts) + tz;
  if (!fmtCache.has(k)) fmtCache.set(k, new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz }));
  return fmtCache.get(k);
};
// Times are shown in the selected location's zone. When that differs from the phone's
// own zone, the zone is named so a 3 PM in Paris is not read as 3 PM at home.
const deviceTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; } })();
const tzOf = () => S.model?.tz || S.place.tz
  || (inBayArea(S.place.lat, S.place.lon) ? 'America/Los_Angeles' : deviceTz) || 'UTC';
const zone = ms => {
  const tz = tzOf();
  if (tz === deviceTz) return '';
  const z = fmt({ hour: 'numeric', timeZoneName: 'short' }, tz).formatToParts(ms).find(x => x.type === 'timeZoneName');
  return z ? ` ${z.value}` : '';
};
const hourLabel = ms => fmt({ weekday: 'short', hour: 'numeric' }, tzOf()).format(ms) + zone(ms);
const clock = ms => fmt({ hour: 'numeric', minute: '2-digit' }, tzOf()).format(ms) + zone(ms);
const hourOnly = ms => fmt({ hour: 'numeric' }, tzOf()).format(ms) + zone(ms);
function rel(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  const a = Math.abs(m);
  let s;
  if (a < 1) return 'just now';
  if (a < 60) s = `${a} min`;
  else if (a < 48 * 60) { const h = Math.floor(a / 60), r = a % 60; s = `${h} h${r && h < 6 ? ` ${r} min` : ''}`; }
  else s = `${Math.round(a / 1440)} days`;
  return m >= 0 ? `${s} ago` : `in ${s}`;
}
const km = d => (d < 1 ? `${Math.round(d * 1000)} m` : `${d.toFixed(1)} km`);
const n0 = v => (v == null ? '—' : Math.round(v));
const n1 = v => (v == null ? '—' : v < 10 ? v.toFixed(1) : Math.round(v));
const polLabel = key => POLLUTANTS.find(p => p.key === key)?.label ?? key;

function dayPartsFor(m) {
  const f = fmt({ weekday: 'short', day: 'numeric', hour: 'numeric', hourCycle: 'h23' }, m.tz);
  return m.times.map(t => {
    const p = Object.fromEntries(f.formatToParts(t * 1000).map(x => [x.type, x.value]));
    return { hour: +p.hour % 24, wd: p.weekday.toUpperCase(), day: p.day };
  });
}

function placeLabel(p) {
  if (p.kind === 'preset' || p.kind === 'monitor' || p.kind === 'search') return p.name;
  const n = nearest(PLACES, p.lat, p.lon);
  if (p.kind === 'gps') return 'Current location';
  return n && n.km < 25 ? `Near ${n.item.name}` : 'Map point';
}
function placeKind(p) {
  if (p.kind === 'monitor') return 'AirNow monitor';
  if (p.kind === 'preset') return 'Place';
  if (p.kind === 'search') return p.region || 'Place';
  const n = nearest(PLACES, p.lat, p.lon);
  const near = n && n.km < 25 ? ` · ${km(n.km)} from ${n.item.name}` : '';
  return p.kind === 'gps' ? `Device location${near}` : `${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}`;
}

// Header suffix: "Bay Area" there, otherwise the country when known. The scale stays US AQI everywhere.
function regionLabel(p) {
  if (inBayArea(p.lat, p.lon)) return 'Bay Area';
  return p.country || 'EPA scale';
}

// The CAMS domain behind the current reading; before the model loads, the one it will use.
const modelDomain = () => DOMAINS[S.model?.domain] || domainFor(S.place.lat, S.place.lon);
const modelName = () => (modelDomain().id === 'cams_europe' ? 'CAMS Europe model' : 'CAMS model');

// ---- derived state -------------------------------------------------------------
function modelInfo() {
  const m = S.model;
  if (!m) return null;
  const v = m.series.us_aqi;
  const lo = v.findIndex(x => x != null);
  if (lo < 0) return null;
  let hi = v.length - 1;
  while (hi > lo && v[hi] == null) hi--;
  const clamp = i => Math.max(lo, Math.min(hi, i));
  const nowIdx = clamp(indexAtOrBefore(m.times, Date.now() / 1000));
  const selIdx = S.selT == null ? nowIdx : clamp(indexAtOrBefore(m.times, S.selT));
  return { m, lo, hi, nowIdx, selIdx };
}

function dominantAt(s, i) {
  let best = null, bv = -1;
  for (const p of POLLUTANTS) {
    const v = s[p.aqiKey]?.[i];
    if (v != null && v > bv) { bv = v; best = p.key; }
  }
  return best;
}

function vm() {
  const mi = modelInfo();
  const p = S.place;
  const mons = S.monitors.list;
  let mon = null, monKm = null;
  if (p.kind === 'monitor') { mon = mons.find(x => x.id === p.id) || null; monKm = 0; }
  else {
    const n = nearest(mons, p.lat, p.lon, MONITOR_RADIUS_KM, x => x.aqi != null);
    if (n) { mon = n.item; monKm = n.km; }
  }
  const monTsOk = !!(mon && mon.ts != null && mon.ts <= Date.now() + MONITOR_SKEW_MS);
  const monFresh = !!(mon && mon.aqi != null && monTsOk && Date.now() - mon.ts < MONITOR_FRESH_MS);
  const isNow = !mi || mi.selIdx === mi.nowIdx;
  const r = { p, mi, mon, monKm, monTsOk, monFresh, isNow };
  if (mi) {
    const s = mi.m.series, i = mi.selIdx;
    r.t = mi.m.times[i] * 1000;
    r.modelAqi = s.us_aqi[i];
    r.phase = i > mi.nowIdx ? 'forecast' : 'estimate';
    r.modelDominant = dominantAt(s, i);
    const back = s.us_aqi[i - 3];
    if (r.modelAqi != null && back != null) r.trend = Math.round(r.modelAqi - back);
    // The observation is compared with the model hour it falls in, not with "now", and placed on
    // the timeline at its own time (fractional hour index).
    if (monFresh) {
      const ts = mon.ts / 1000, k = indexAtOrBefore(mi.m.times, ts);
      r.obsPos = k < 0 ? (ts - mi.m.times[0]) / 3600 : k + (ts - mi.m.times[k]) / 3600;
      r.obsInRange = r.obsPos >= mi.lo && r.obsPos <= mi.hi;
      const v = k >= mi.lo && k <= mi.hi ? s.us_aqi[k] : null;
      if (v != null) r.obsModel = { aqi: v, t: mi.m.times[k] * 1000 };
    }
  }
  if (isNow && monFresh) r.primary = { aqi: mon.aqi, kind: 'measured', ts: mon.ts, dominant: mon.dominant };
  else if (r.modelAqi != null) r.primary = { aqi: r.modelAqi, kind: r.phase, ts: r.t, dominant: r.modelDominant };
  return r;
}

// ---- rendering: readout --------------------------------------------------------
const KIND = {
  measured: { badge: 'Measured', cls: 'b-meas' },
  estimate: { badge: 'Model estimate', cls: 'b-est' },
  forecast: { badge: 'Forecast', cls: 'b-fc' },
};
const badge = k => `<span class="badge ${KIND[k].cls}">${KIND[k].badge}</span>`;

function meterHTML(aqi) {
  const pos = scalePos(aqi);
  const segs = CATS.map(c => `<span class="m-seg" style="--c:${c.hex}"></span>`).join('');
  const ticks = [0, 50, 100, 150, 200, 300, 500]
    .map((t, i) => `<span class="m-tick" style="left:${(i / 6) * 100}%">${t}</span>`).join('');
  const ptr = pos == null ? '' : `<span class="m-ptr" style="left:${(pos * 100).toFixed(2)}%"></span>`;
  return `<div class="meter" role="img" aria-label="${aqi == null ? 'No value' : `AQI ${Math.round(aqi)} on the EPA scale`}">
    <div class="m-track">${segs}${ptr}</div><div class="m-ticks">${ticks}</div></div>`;
}

function sourceText(r) {
  const k = r.primary?.kind;
  if (k === 'measured' && r.p.kind === 'monitor') return 'AirNow · latest hourly report';
  if (k === 'measured') return `AirNow monitor · ${esc(r.mon.name)}${r.monKm > 0.2 ? ` · ${km(r.monKm)} away` : ''}`;
  if (k) return `${modelName()} via Open-Meteo · ${modelDomain().km} cell`;
  return '';
}

function freshText(r) {
  const pr = r.primary;
  if (!pr) return '';
  if (pr.kind === 'measured') return `Reported ${clock(pr.ts)} · ${rel(pr.ts)}`;
  if (pr.kind === 'forecast') return `Forecast for ${hourLabel(pr.ts)} · ${rel(pr.ts)}`;
  if (r.isNow) return `Model hour ${clock(pr.ts)} · data fetched ${rel(S.model.fetchedAt)}`;
  return `Model estimate for ${hourLabel(pr.ts)} · ${rel(pr.ts)}`;
}

function trendHTML(r) {
  if (r.trend == null) return `<p class="ro-trend muted">Model trend unavailable for this hour</p>`;
  const d = r.trend;
  const [g, w] = Math.abs(d) < 3 ? ['▬', 'Steady'] : d > 0 ? ['▲', 'Rising'] : ['▼', 'Falling'];
  const mag = Math.abs(d) < 3 ? `${d >= 0 ? '+' : '−'}${Math.abs(d)}` : `${d > 0 ? '+' : '−'}${Math.abs(d)}`;
  return `<p class="ro-trend"><span class="tr-g" aria-hidden="true">${g}</span>Model trend: ${w.toLowerCase()}, ${mag} over the past 3 h</p>`;
}

// Wording for an Open-Meteo usage pause (HTTP 429). Times are relative, so no zone is involved.
function pauseText(p) {
  const s = Math.max(0, Math.ceil((p.until - Date.now()) / 1000));
  const when = s < 60 ? 'in under a minute' : s < 5400 ? `in about ${Math.ceil(s / 60)} min` : `in about ${Math.round(s / 3600)} h`;
  if (p.kind === 'concurrent') return `Open-Meteo is busy with this device’s other requests. Try again ${when}.`;
  const lim = { minute: 'per-minute', hour: 'hourly', day: 'daily' }[p.kind];
  return `Open-Meteo’s free ${lim ? `${lim} ` : ''}usage limit was reached, so new model data are paused. Try again ${when}.`;
}
// Retry is offered only once a pause has run out; nothing retries on its own.
const retryBtn = (what, sm = true) => (omPause() ? '' : `<button class="btn btn-retry${sm ? ' sm' : ''}" type="button" data-retry="${what}">Retry</button>`);
const modelFailText = () => (S.modelPause ? pauseText(S.modelPause) : `Model data unavailable (${esc(S.modelError)}).`);

// Secondary model reading under a measurement: the same layout at a smaller size, for the hour the
// observation falls in, so the two compare directly. Never combined with the measurement.
function modelRowHTML(r, full) {
  if (r.primary?.kind !== 'measured' || !r.obsModel) return '';
  const v = r.obsModel.aqi, c = category(v);
  const head = `<span class="badge b-est">Model estimate</span>`;
  if (!full) {   // one line in the compact sheet
    return `<p class="ro-model ro-model-c">${head} <span class="ro-model-t"><b>${n0(v)}</b>
      <i class="sw" style="--c:${c.hex}"></i>${c.short} <span class="ro-model-src">· ${hourOnly(r.obsModel.t)} hour</span></span></p>`;
  }
  return `<div class="ro-model">
    <div class="ro-src">${head} <span class="ro-srctext">${DOMAINS[modelDomain().id].name} · ${modelDomain().km} cell</span></div>
    <div class="ro-model-main">
      <span class="ro-model-num" aria-label="US AQI ${Math.round(v)}">${Math.round(v)}</span>
      <div class="ro-side"><span class="ro-model-cat"><i class="sw" style="--c:${c.hex}"></i>${c.label}</span>
        <span class="ro-fresh">Model hour ${clock(r.obsModel.t)}</span></div>
    </div>
    ${trendHTML(r)}
  </div>`;
}

function notesHTML(r) {
  const out = [];
  const pr = r.primary;
  if (S.modelStatus === 'error') {
    out.push(`${modelFailText()} Trend, timeline and forecast are missing. ${retryBtn('model')}`);
  }
  if (S.monitors.status === 'ok') {
    const why = r.mon && !r.monTsOk ? (r.mon.ts == null ? 'has no usable report time' : 'has a report time ahead of the clock')
      : 'has no reading from the last 3 hours';
    if (r.p.kind === 'monitor' && !r.monFresh) out.push(`This monitor ${why}, so its value is not shown as current.`);
    else if (!r.mon && r.p.kind !== 'monitor') out.push(`No reporting AirNow monitor within ${MONITOR_RADIUS_KM} km.`);
    else if (r.mon && !r.monFresh) out.push(`Nearest monitor (${esc(r.mon.name)}) ${why}, so its value is not shown as current.`);
    else if (!r.isNow && r.mon) out.push('Monitor readings exist for the latest hour only.');
  } else if (S.monitors.status === 'error') {
    out.push('Monitor feed unavailable; showing model values only.');
  } else if (S.monitors.status === 'none') {
    out.push('AirNow monitors are only checked in North America, so readings here are model estimates, not measurements.');
  }
  return out.map(t => `<p class="ro-note">${t}</p>`).join('');
}

function readoutHTML(r, variant) {
  const full = variant === 'full';
  if (!r.primary) {
    if (S.modelStatus === 'error') {
      return `<div class="ro ro-empty"><p class="ro-msg">${modelFailText()}</p>${retryBtn('model', false)}</div>`;
    }
    const slow = Date.now() - S.modelStart > 5000;
    const msg = S.modelStatus === 'loading'
      ? (slow ? 'Still loading. The model service can take a few seconds.' : 'Loading…')
      : 'No value for this hour.';
    return `<div class="ro ro-empty${full ? '' : ' ro-compact'}">
      <div class="ro-src"><span class="badge b-none">No reading</span></div>
      <div class="ro-main"><span class="ro-num is-blank">—</span>
      <div class="ro-side"><span class="ro-msg">${msg}</span></div></div>
      ${full ? meterHTML(null) : ''}</div>`;
  }
  const pr = r.primary, cat = category(pr.aqi), model = modelRowHTML(r, full);
  const dom = pr.dominant ? ` · <span class="nowrap">dominant ${polLabel(pr.dominant)}</span>` : '';
  return `<div class="ro${full ? '' : ' ro-compact'}">
    <div class="ro-src">${badge(pr.kind)} <span class="ro-srctext">${sourceText(r)}</span></div>
    <div class="ro-main">
      <span class="ro-num" aria-label="US AQI ${Math.round(pr.aqi)}">${Math.round(pr.aqi)}</span>
      <div class="ro-side">
        <span class="ro-cat"><i class="sw" style="--c:${cat.hex}"></i>${cat.label}</span>
        <span class="ro-unit">US AQI${dom}</span>
      </div>
    </div>
    <p class="ro-fresh">${freshText(r)}</p>
    ${model ? '' : trendHTML(r)}
    ${full ? meterHTML(pr.aqi) : ''}
    ${model}
    ${full ? notesHTML(r) : ''}
  </div>`;
}

function tlReadoutHTML(r) {
  if (!r.mi) {
    return S.modelStatus === 'error'
      ? `<span class="muted">Timeline unavailable: ${S.modelPause ? 'model data are paused by the usage limit' : 'model data did not load'}.</span> ${retryBtn('model')}`
      : '<span class="muted">Loading timeline…</span>';
  }
  const v = r.modelAqi;
  const cat = category(v);
  return `<span class="tlr-time">${hourLabel(r.t)}</span>
    <span class="tlr-val">${v == null ? '—' : `<b>${Math.round(v)}</b> ${cat.short}`}</span>
    ${badge(r.phase)}`;
}

function pollutantsHTML(r) {
  if (!r.mi) return `<p class="muted pad">Pollutant detail loads with the model data.</p>`;
  const s = r.mi.m.series, i = r.mi.selIdx, units = r.mi.m.units;
  const showMon = r.isNow && r.monFresh && Object.values(r.mon.pollutantAqi).some(v => v != null);
  const dom = r.modelDominant;
  const rows = POLLUTANTS.map(p => {
    const c = s[p.key]?.[i], a = s[p.aqiKey]?.[i];
    const cat = category(a);
    const mon = showMon ? r.mon.pollutantAqi[p.key] : undefined;
    return `<tr${p.key === dom ? ' class="is-dom"' : ''}>
      <th scope="row"><span class="pl">${p.label}</span><span class="pn">${p.name}</span></th>
      <td class="num">${n1(c)}</td>
      <td class="num">${a == null ? '—' : `<span class="aqi-cell"><i class="sw" style="--c:${cat.hex}"></i>${Math.round(a)}</span>`}</td>
      ${showMon ? `<td class="num">${mon == null ? '<span class="muted" title="Not reported">—</span>' : Math.round(mon)}</td>` : ''}
    </tr>`;
  }).join('');
  const unit = esc(units.pm2_5 || 'µg/m³');
  return `<div class="tbl-wrap"><table class="pol">
    <thead><tr><th scope="col">Pollutant</th><th scope="col" class="num">${unit}</th><th scope="col" class="num">AQI</th>
    ${showMon ? '<th scope="col" class="num">Monitor</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>
    <p class="fine">◆ marks the dominant pollutant. Concentration and AQI columns are CAMS model estimates for ${hourLabel(r.t)}. All concentrations, including ozone, are in ${unit}.
    ${showMon ? 'Monitor column: AirNow sub-index for the latest hour; — means the site does not measure it.' : ''}</p>`;
}

function sourcesHTML() {
  const M = S.monitors, m = S.model;
  const modelStatus = S.modelStatus === 'ok'
    ? `Loaded. ${DOMAINS[m.domain].name} cell centred at ${m.cellLat.toFixed(2)}, ${m.cellLon.toFixed(2)}; fetched ${rel(m.fetchedAt)}.`
    : S.modelStatus === 'error' ? (S.modelPause ? 'Paused by the usage limit.' : `Unavailable: ${esc(S.modelError)}.`) : 'Loading…';
  const monStatus = M.status === 'ok'
    ? `${M.list.length} site${M.list.length === 1 ? '' : 's'} within about 100 km in the latest feed; fetched ${rel(M.data.fetchedAt)}.`
    : M.status === 'none' ? 'Not checked here. This app queries AirNow only in North America.'
    : M.status === 'error' ? `Unavailable: ${esc(M.error)}. <button class="btn btn-retry sm" type="button" data-retry="monitors">Retry</button>` : 'Loading…';
  const inspector = M.data
    ? `<details class="inspect"><summary>Monitor feed fields</summary>
        <p class="fine">Fields matched automatically. Report anything marked unmatched.</p>
        <pre>${esc(Object.entries(M.data.mapping).map(([k, v]) => `${k.padEnd(8)} ${v ?? 'unmatched'}`).join('\n'))}\n\n${esc(M.data.fields.map(f => `${f.name}  ${f.type.replace('esriFieldType', '')}`).join('\n'))}${M.list[0] ? `\n\nsample time: ${esc(M.list[0].rawTime)}` : ''}</pre></details>`
    : '';
  return `<dl class="src-list">
    <dt>Model estimates and forecast</dt>
    <dd>Copernicus Atmosphere Monitoring Service (CAMS) forecasts, served by
      <a href="https://open-meteo.com/en/docs/air-quality-api" target="_blank" rel="noopener">Open-Meteo</a> (CC BY 4.0).
      In Europe (30–72°N, 25°W–45°E) the CAMS European ensemble: 0.1° cells, about 10 km, forecast about 4 days ahead.
      Elsewhere the CAMS global model: 0.4° cells, about 40 km, forecast about 5 days ahead. This location uses ${modelDomain().name}.
      Past hours are model values, not observations. US AQI values are calculated by Open-Meteo from modeled concentrations.
      <span class="status">${modelStatus}</span></dd>
    <dt>Monitor observations</dt>
    <dd>U.S. EPA <a href="https://www.airnow.gov/" target="_blank" rel="noopener">AirNow</a>, via EPA's public
      “AirNow Current Monitor Data” feed. Latest hour only. AirNow data are preliminary and not fully verified; official records come from EPA AQS.
      <span class="status">${monStatus}</span>${inspector}</dd>
    <dt>How readings are chosen</dt>
    <dd>“Measured” is shown when the selected monitor, or one within ${MONITOR_RADIUS_KM} km, reported in the last 3 hours.
      Otherwise the reading is the model estimate for the grid cell. Outside North America every reading is a model estimate.
      When both exist, the measurement is shown first and the model estimate for the same hour beneath it; they are never averaged.
      They often differ: a monitor samples one spot, while a model cell averages a wide area and can miss local sources such as
      traffic or smoke. A difference does not show which is right. The timeline is model-only; the dot marks the measurement at
      its own report time. Model trend is the change in modeled AQI over the previous 3 hours.
      The air quality map draws each model cell at its native size without smoothing, so nearby towns often share a value.</dd>
    <dt>Requests</dt>
    <dd>Open-Meteo’s free service counts each map cell as a request. The air quality map keeps the cells it has loaded and fetches
      only cells it does not have, and the Locations view loads no map cells unless named places nearby need them.
      If Open-Meteo’s usage limit is reached, the app waits for the time it gives and does not retry on its own.
      ${omPause() ? `<span class="status">${pauseText(omPause())}</span>` : ''}</dd>
    <dt>US AQI everywhere</dt>
    <dd>All values use the U.S. EPA Air Quality Index, including outside the United States. Local agencies may publish a different index
      (for example the European Air Quality Index), so their numbers will not match.</dd>
    <dt>Times</dt>
    <dd>Shown in the selected location’s time zone (${esc(tzOf())}).</dd>
    <dt>Map</dt>
    <dd>Base map: Esri Gray Canvas (Esri, HERE, Garmin, © OpenStreetMap contributors). Falls back to OpenStreetMap tiles if Esri is unreachable.</dd>
    <dt>Place search</dt>
    <dd><a href="https://open-meteo.com/en/docs/geocoding-api" target="_blank" rel="noopener">Open-Meteo Geocoding</a>, based on GeoNames (CC BY 4.0).</dd>
    <dt>Privacy</dt>
    <dd>Your chosen location and recent searches are saved only in this browser. To get readings, the location’s coordinates
      (rounded to about 100 m) are sent to Open-Meteo; in North America, a box roughly 200 km across that contains it is also sent to EPA’s AirNow feed.
      Searches send the text you type to Open-Meteo. Map tiles for the area on screen come from Esri, or OpenStreetMap as a fallback.</dd>
  </dl>`;
}

// ---- rendering: explorer ------------------------------------------------------
// Hour shown on the map field (epoch s), or null when the field does not cover it.
function fieldTime() {
  const t = S.selT ?? Date.now() / 1000;
  return fieldCovers(S.field.data, t) ? t : null;
}

function legendHTML(r) {
  if (S.mode === 'locations') {
    const M = S.monitors;
    const status = M.status === 'loading' ? '<p class="lg-note">Loading monitors…</p>'
      : M.status === 'error' ? `<p class="lg-note">Monitor feed unavailable. <button class="btn btn-retry sm" type="button" data-retry="monitors">Retry</button></p>`
      : !r.isNow ? '<p class="lg-note">Monitors show their latest hour only; place estimates follow the selected hour.</p>' : '';
    if (M.status === 'none') {
      return `<p class="lg-row"><span class="lg-key lg-est lg-first" aria-hidden="true"></span>Model estimate</p>${S.hint ? `<p class="lg-note">${S.hint}</p>` : ''}
        <p class="lg-note">No AirNow monitors outside North America.</p>`;
    }
    return `<p class="lg-row"><span class="lg-key lg-mon" aria-hidden="true"></span>Monitor, measured
      <span class="lg-key lg-est" aria-hidden="true"></span>Model estimate</p>${S.hint ? `<p class="lg-note">${S.hint}</p>` : ''}${status}`;
  }
  const F = S.field;
  const keys = CATS.slice(0, 5).map(c => `<span class="lg-cat"><i class="sw" style="--c:${c.hex}"></i>${c.short}</span>`).join('');
  const status = F.status === 'loading' ? '<p class="lg-note">Loading model field…</p>'
    : F.status === 'error' ? `<p class="lg-note">${F.pause ? pauseText(F.pause) : `Model field unavailable: ${esc(F.error)}.`}${F.data ? ' Cells already loaded stay on the map.' : ''} ${retryBtn('field')}</p>`
    : F.data && fieldTime() == null ? '<p class="lg-note">The regional field covers 2 days back to 4 days ahead. Pick an hour in that range.</p>' : '';
  const d = DOMAINS[F.data?.domain] || domainFor(S.place.lat, S.place.lon);
  return `<p class="lg-row">${d.id === 'cams_europe' ? 'CAMS Europe model' : 'CAMS model'} · ${d.km} cells · shown as-is, not interpolated</p><p class="lg-row lg-cats">${keys}</p>${status}`;
}

// ---- wiring -------------------------------------------------------------------
const tlHome = new Timeline($('#tlHome'), { onSelect: selectIdx, height: 176 });
const tlSheet = new Timeline($('#tlSheet'), { onSelect: selectIdx, height: 150 });
const explorer = new Explorer($('#map'), { onSelect: p => setPlace(p), bounds: viewBounds(S.place.lat, S.place.lon) });
let preview = null;
try { preview = new Preview($('#previewMap'), viewBounds(S.place.lat, S.place.lon)); } catch {}

// Model-estimate markers for the map: Bay Area shortcuts, recent searches and the selected
// place, limited to the model field around the selection so nothing from a previous region lingers.
function placeMarkers(fT) {
  const spec = fieldHolds(S.field.data, S.place.lat, S.place.lon) ? S.field.data : fieldSpec(S.place.lat, S.place.lon);
  const h = spec.step / 2;
  const lats = spec.cells.map(c => c.lat), lons = spec.cells.map(c => c.lon);
  const box = [Math.min(...lats) - h, Math.min(...lons) - h, Math.max(...lats) + h, Math.max(...lons) + h];
  const inside = p => p.lat >= box[0] && p.lat <= box[2] && p.lon >= box[1] && p.lon <= box[3];
  const cand = [
    ...PLACES.map(p => ({ ...p, place: { kind: 'preset', ...p } })),
    ...S.recent.map(p => ({ name: p.name, lat: p.lat, lon: p.lon, place: p })),
  ];
  if (S.place.kind !== 'monitor') cand.unshift({ name: placeLabel(S.place), lat: S.place.lat, lon: S.place.lon, place: S.place });
  const out = [];
  const mi = modelInfo(), own = mi ? mi.m.series.us_aqi[mi.selIdx] ?? null : null;
  for (const p of cand) {
    if (!inside(p) || out.some(o => o.lat === p.lat && o.lon === p.lon) || nearest(out, p.lat, p.lon, 1)) continue;
    // A named place sitting on top of a reporting monitor adds clutter, not information.
    if (nearest(S.monitors.list, p.lat, p.lon, 4, m => m.aqi != null)) continue;
    out.push({ ...p, value: p.place === S.place ? own : fieldValueAt(S.field.data, p.lat, p.lon, fT) ?? heldValue(p.place) });
  }
  return out;
}

// A named place's own point series, if one is already cached, read at the selected hour.
function heldValue(pl) {
  const m = cachedModel(pl.lat, pl.lon, knownTz(pl));
  if (!m) return null;
  const k = indexAtOrBefore(m.times, S.selT ?? Date.now() / 1000);
  return k >= 0 ? m.series.us_aqi[k] ?? null : null;
}

// The Locations view loads field cells only to label several named places (the Bay Area shortcuts)
// that have no cached point series; the selection and recent places read their own series.
function fieldNeeded() {
  if (S.mode === 'field') return true;
  const spec = fieldSpec(S.place.lat, S.place.lon), h = spec.step / 2;
  const lats = spec.cells.map(c => c.lat), lons = spec.cells.map(c => c.lon);
  const [s0, w0, n1_, e0] = [Math.min(...lats) - h, Math.min(...lons) - h, Math.max(...lats) + h, Math.max(...lons) + h];
  const unlabelled = [...PLACES.map(p => ({ kind: 'preset', ...p })), ...S.recent].filter(p => !(p.lat === S.place.lat && p.lon === S.place.lon)
    && p.lat >= s0 && p.lat <= n1_ && p.lon >= w0 && p.lon <= e0 && !cachedModel(p.lat, p.lon, knownTz(p)));
  return unlabelled.length >= 2;
}
const maybeLoadField = () => { if (S.field.status === 'idle' && fieldNeeded()) loadField(); };

function selectIdx(i) {
  const mi = modelInfo();
  if (!mi) return;
  i = Math.max(mi.lo, Math.min(mi.hi, i));
  S.selT = i === mi.nowIdx ? null : mi.m.times[i];
  render();
}

function render() {
  const r = vm();
  const label = placeLabel(S.place);
  $('#plateModel').textContent = `US AQI · ${regionLabel(S.place)}`;
  $('#lgMeas').hidden = !(r.monFresh && r.obsInRange);   // legend entry only when the dot is drawn
  const res = modelDomain().km.replace('~', '');
  document.querySelectorAll('#roInfo [data-res]').forEach(e => { if (e.textContent !== res) e.textContent = res; });
  $('#placeName').textContent = label;
  $('#sheetName').textContent = label;
  $('#sheetKind').textContent = placeKind(S.place);
  $('#readout').innerHTML = readoutHTML(r, 'full');
  $('#sheetReadout').innerHTML = readoutHTML(r, 'compact');
  const tlr = tlReadoutHTML(r);
  $('#tlReadout').innerHTML = tlr;
  $('#tlSheetReadout').innerHTML = tlr;
  const pol = pollutantsHTML(r);
  $('#pollutants').innerHTML = pol;
  $('#sheetPollutants').innerHTML = pol;
  $('#polWhen').textContent = r.mi ? hourLabel(r.t) : '';
  $('#sources').innerHTML = sourcesHTML();

  if (r.mi) {
    const { m, lo, hi, nowIdx, selIdx } = r.mi;
    const d = {
      values: m.series.us_aqi, times: m.times, nowIdx, selIdx, lo, hi, dayParts: S.dayParts,
      measured: r.monFresh ? { aqi: r.mon.aqi, pos: r.obsPos, label: `Measured ${n0(r.mon.aqi)} at ${clock(r.mon.ts)}` } : null,
      label: i => hourLabel(m.times[i] * 1000),
    };
    tlHome.set(d);
    tlSheet.set(d);
  } else { tlHome.set(null); tlSheet.set(null); }
  document.querySelectorAll('[data-now]').forEach(b => { b.disabled = r.isNow; });

  if (!$('#explorer').hidden) {
    const fT = fieldTime();
    explorer.draw({
      field: S.field.data, fieldT: fT, monitors: S.monitors.list, isNow: r.isNow, place: S.place,
      places: placeMarkers(fT),
    });
    $('#exLegend').innerHTML = legendHTML(r);
    const et = $('#exTime');
    et.hidden = r.isNow || !r.mi;
    if (!et.hidden) et.innerHTML = `${hourLabel(r.t)} · ${r.phase === 'forecast' ? 'forecast' : 'model'} <span class="ex-time-reset">Back to now</span>`;
  }
  preview?.draw({ monitors: S.monitors.list, place: S.place });
}

// A pause ends without a retry: the page only re-renders, so Retry buttons come back.
let pauseTimer = 0;
function notePause(p) {
  if (!p) return p;
  clearTimeout(pauseTimer);
  pauseTimer = setTimeout(render, Math.max(0, p.until - Date.now()) + 250);
  return p;
}

// Time zone known before asking: from the search result, or the Bay Area's. Otherwise the model
// request asks Open-Meteo to resolve it (timezone=auto).
const knownTz = p => p.tz || (inBayArea(p.lat, p.lon) ? 'America/Los_Angeles' : null);

let modelToken = 0, modelCtl = null;
async function loadModel() {
  const t = ++modelToken;
  modelCtl?.abort();
  const ctl = modelCtl = new AbortController();
  S.model = null; S.modelStatus = 'loading'; S.modelError = null; S.modelPause = null; S.modelStart = Date.now();
  render();
  setTimeout(() => { if (t === modelToken && S.modelStatus === 'loading') render(); }, 5200);
  try {
    const m = await fetchModel(S.place.lat, S.place.lon, knownTz(S.place), ctl.signal);
    if (t !== modelToken) return;
    S.model = m; S.dayParts = dayPartsFor(m); S.modelStatus = 'ok';
  } catch (e) {
    if (t !== modelToken) return;
    S.modelStatus = 'error'; S.modelError = e.message || 'request failed'; S.modelPause = notePause(e.pause);
  }
  render();
}

// Each loader keeps a token so a slow response for a previous location is dropped, not drawn.
let monToken = 0;
async function loadMonitors() {
  const t = ++monToken;
  const p = S.place;
  if (!airnowCovers(p.lat, p.lon)) {
    S.monitors = { status: 'none', list: [], data: null, error: null, bbox: null };
    render();
    return;
  }
  const bbox = monitorBox(p.lat, p.lon);
  const same = S.monitors.bbox?.join() === bbox.join();
  S.monitors = { status: 'loading', list: same ? S.monitors.list : [], data: same ? S.monitors.data : null, error: null, bbox };
  render();
  try {
    const d = await fetchMonitors(bbox);
    if (t !== monToken) return;
    S.monitors = { status: 'ok', list: d.list, data: d, error: null, bbox };
  } catch (e) {
    if (t !== monToken) return;
    S.monitors = { status: 'error', list: [], data: null, error: e.message || 'request failed', bbox };
  }
  render();
}

// While new cells load, or if they fail, cells already on the map stay drawn: they are still
// correctly placed values for their own area.
let fieldToken = 0, fieldCtl = null;
async function loadField() {
  const t = ++fieldToken;
  fieldCtl?.abort();
  const ctl = fieldCtl = new AbortController();
  const spec = fieldSpec(S.place.lat, S.place.lon);
  const keep = S.field.data?.domain === spec.domain ? S.field.data : null;
  S.field = { status: 'loading', data: keep, error: null };
  render();
  try {
    const d = await fetchField(spec, ctl.signal);
    if (t !== fieldToken) return;
    S.field = { status: 'ok', data: d, error: null };
  } catch (e) {
    if (t !== fieldToken) return;
    S.field = { status: 'error', data: keep, error: e.message || 'request failed', pause: notePause(e.pause) };
  }
  render();
}

function remember(p) {
  S.recent = [p, ...S.recent.filter(x => !(x.name === p.name && x.lat === p.lat && x.lon === p.lon))].slice(0, RECENT_MAX);
  store.set('aqi.recent', S.recent);
  renderRecent();
}

// recenter: frame the map on the new place (chooser selections). Taps on the map leave it where it is.
function setPlace(p, { recenter = false } = {}) {
  if (p.kind === 'point' || p.kind === 'gps') p = { ...p, lat: +p.lat.toFixed(3), lon: +p.lon.toFixed(3) };
  S.place = p;
  S.hint = null;
  store.set('aqi.place', p);
  if (p.kind === 'search') remember(p);
  // A tap inside the loaded field reuses it; outside it, only the missing cells are requested.
  if (!fieldHolds(S.field.data, p.lat, p.lon)) {
    fieldToken++; fieldCtl?.abort();
    S.field = { status: 'idle', data: S.field.data?.domain === domainFor(p.lat, p.lon).id ? S.field.data : null, error: null };
  }
  const M = S.monitors;
  if (!((M.status === 'ok' || M.status === 'loading') && boxHolds(M.bbox, p.lat, p.lon))) loadMonitors();
  const b = viewBounds(p.lat, p.lon);
  preview?.focus(b);
  if (recenter) explorer.focus(b);
  loadModel();
  if (!$('#explorer').hidden) maybeLoadField();
}

// Explorer open/close, with history so the iOS back gesture works.
function openExplorer() {
  $('#explorer').hidden = false;
  $('#home').inert = true;
  document.body.classList.add('ex-open');
  if (history.state?.ex !== 1) history.pushState({ ex: 1 }, '');
  explorer.show();
  maybeLoadField();
  render();
  requestAnimationFrame(() => tlSheet.render());
}
function hideExplorer() {
  $('#explorer').hidden = true;
  explorer.hide();
  $('#home').inert = false;
  document.body.classList.remove('ex-open');
  S.hint = null;
  preview?.invalidate();
  render();
}
// "Measured vs model": a plain disclosure (button + aria-expanded), static markup so re-renders never move focus.
const infoBtn = $('#infoBtn'), info = $('#roInfo');
function setInfo(open, refocus = false) {
  info.hidden = !open;
  infoBtn.setAttribute('aria-expanded', String(open));
  if (refocus) infoBtn.focus();
}
infoBtn.addEventListener('click', () => setInfo(info.hidden));
info.addEventListener('keydown', e => { if (e.key === 'Escape') setInfo(false, true); });
infoBtn.addEventListener('keydown', e => { if (e.key === 'Escape' && !info.hidden) setInfo(false); });
info.querySelector('[data-info-more]').addEventListener('click', e => {
  e.preventDefault();
  const h = $('#lbl-src');
  h.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  h.focus({ preventScroll: true });
});

$('#openMap').addEventListener('click', openExplorer);
$('#exBack').addEventListener('click', () => (history.state?.ex === 1 ? history.back() : hideExplorer()));
addEventListener('popstate', () => { if (!$('#explorer').hidden) hideExplorer(); });

document.querySelectorAll('.seg [data-mode]').forEach(b => b.addEventListener('click', () => {
  S.mode = b.dataset.mode;
  document.querySelectorAll('.seg [data-mode]').forEach(x => x.setAttribute('aria-checked', String(x === b)));
  explorer.setMode(S.mode);
  maybeLoadField();
  render();
}));
$('#exTime').addEventListener('click', () => { S.selT = null; render(); });

document.addEventListener('click', e => {
  const step = e.target.closest('[data-step]');
  if (step) { const mi = modelInfo(); if (mi) selectIdx(mi.selIdx + +step.dataset.step); return; }
  if (e.target.closest('[data-now]')) { S.selT = null; render(); return; }
  const retry = e.target.closest('[data-retry]');
  if (retry) ({ model: loadModel, monitors: loadMonitors, field: loadField })[retry.dataset.retry]();
});

// ---- bottom sheet: two snap heights, tap or drag ------------------------------
const sheet = $('#sheet');
const probe = cls => { const d = document.createElement('div'); d.className = `sheet-probe ${cls}`; document.body.appendChild(d); return d; };
const probeC = probe('sp-c'), probeE = probe('sp-e');

function setSheet(state) {
  S.sheet = state;
  sheet.dataset.state = state;
  sheet.style.height = '';
  const t = $('#sheetToggle');
  t.setAttribute('aria-expanded', String(state === 'expanded'));
  t.querySelector('span').textContent = state === 'expanded' ? 'Less' : 'More';
  if (state === 'expanded') requestAnimationFrame(() => tlSheet.render());
}
$('#sheetToggle').addEventListener('click', () => setSheet(S.sheet === 'expanded' ? 'compact' : 'expanded'));

(() => {
  let drag = null;
  const startTargets = [$('#sheetGrab'), $('.sheet-head')];
  for (const el of startTargets) {
    el.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      drag = { y: e.clientY, h: sheet.offsetHeight, t: performance.now(), moved: false, id: e.pointerId };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dy) < 6) return;
      drag.moved = true;
      sheet.classList.add('dragging');
      const h = Math.max(probeC.offsetHeight * 0.85, Math.min(probeE.offsetHeight * 1.03, drag.h - dy));
      sheet.style.height = `${h}px`;
      drag.last = { dy, t: performance.now() };
    });
    const end = e => {
      if (!drag || e.pointerId !== drag.id) return;
      sheet.classList.remove('dragging');
      if (!drag.moved) { if (e.type === 'pointerup') setSheet(S.sheet === 'expanded' ? 'compact' : 'expanded'); }
      else {
        const h = sheet.offsetHeight, c = probeC.offsetHeight, x = probeE.offsetHeight;
        const v = drag.last ? drag.last.dy / Math.max(1, drag.last.t - drag.t) : 0; // px/ms, +down
        const target = Math.abs(v) > 0.5 ? (v < 0 ? 'expanded' : 'compact') : (h > (c + x) / 2 ? 'expanded' : 'compact');
        setSheet(target);
      }
      drag = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }
})();

// ---- place dialog -------------------------------------------------------------
const dlg = $('#placeDialog');
const q = $('#placeQuery');
const GPS_NOTE = 'Sends coordinates to the air-quality services';
const placeRow = (attr, name, note) =>
  `<button class="row-btn" type="button" ${attr}><span class="row-main">${esc(name)}</span>${note ? `<span class="row-note">${esc(note)}</span>` : ''}</button>`;
$('#placeList').innerHTML = PLACES.map((p, i) => `<button class="row-btn" type="button" data-place="${i}">${p.name}</button>`).join('');
$('#placeBtn').addEventListener('click', () => { renderSearch(); dlg.showModal(); });
$('#placeClose').addEventListener('click', () => dlg.close());
dlg.addEventListener('close', () => {
  clearTimeout(searchTimer); searchCtl?.abort(); searchSeq++;
  q.value = '';
  S.search = { q: '', status: 'idle', results: [], error: null };
  renderSearch();
});
function choose(p) { setPlace(p, { recenter: true }); dlg.close(); }
$('#placeList').addEventListener('click', e => {
  const b = e.target.closest('[data-place]');
  if (b) choose({ kind: 'preset', ...PLACES[+b.dataset.place] });
});
$('#pickOnMap').addEventListener('click', () => {
  dlg.close();
  S.hint = 'Tap the map to choose a location, or tap a marker.';
  if (S.mode !== 'locations') document.querySelector('.seg [data-mode="locations"]').click();
  openExplorer();
});
$('#useGps').addEventListener('click', () => {
  const note = $('#useGps .row-note');
  if (!navigator.geolocation) { note.textContent = 'Location is not available in this browser'; return; }
  note.textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(
    pos => { note.textContent = GPS_NOTE; choose({ kind: 'gps', lat: pos.coords.latitude, lon: pos.coords.longitude }); },
    err => { note.textContent = err.code === 1 ? 'Location permission was denied' : 'Could not get a location'; },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
  );
});

// Worldwide search (Open-Meteo Geocoding). Debounced; each keystroke cancels the request
// before it, and a sequence number drops any answer that arrives late.
let searchTimer = 0, searchCtl = null, searchSeq = 0;
const searchCache = new Map();
const coordText = (lat, lon) =>
  `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;

// Region line that tells same-named places apart: state/province and country, plus the
// county when two results share both, plus coordinates if even that is not enough.
function regionOf(r, all) {
  const twins = all.filter(x => x !== r && x.name === r.name && x.admin1 === r.admin1 && x.country === r.country);
  const parts = [r.admin1, r.country];
  if (twins.length && r.admin2) parts.unshift(r.admin2);
  if (twins.some(x => x.admin2 === r.admin2)) parts.push(coordText(r.lat, r.lon));
  return parts.filter((x, i, a) => x && x !== r.name && a.indexOf(x) === i).join(', ') || coordText(r.lat, r.lon);
}

async function runSearch() {
  clearTimeout(searchTimer);
  searchCtl?.abort();
  const seq = ++searchSeq;
  const text = q.value.trim();
  if (text.split(',')[0].trim().length < 2) {
    S.search = { q: text, status: text ? 'short' : 'idle', results: [], error: null };
    renderSearch();
    return;
  }
  const key = text.toLowerCase();
  if (searchCache.has(key)) {
    S.search = { q: text, status: 'ok', results: searchCache.get(key), error: null };
    renderSearch();
    return;
  }
  S.search = { q: text, status: 'loading', results: [], error: null };
  renderSearch();
  searchCtl = new AbortController();
  try {
    const list = await searchPlaces(text, searchCtl.signal);
    if (seq !== searchSeq) return;
    const results = list.map((r, _, all) => ({ ...r, region: regionOf(r, all) }));
    searchCache.set(key, results);
    S.search = { q: text, status: 'ok', results, error: null };
  } catch (e) {
    if (seq !== searchSeq) return;
    S.search = { q: text, status: 'error', results: [], error: e.message || 'request failed' };
  }
  renderSearch();
}

function renderSearch() {
  const { q: text, status, results, error } = S.search;
  const st = $('#searchStatus');
  st.dataset.state = status;
  st.innerHTML = status === 'idle' ? 'Any city or town worldwide. Narrow it with a comma: “Paris, France”.'
    : status === 'short' ? 'Type at least 2 letters.'
    : status === 'loading' ? 'Searching…'
    : status === 'error' ? `Search is unavailable right now (${esc(error)}). Current location, the map and Bay Area places still work.
        <button class="btn btn-retry sm" type="button" data-retry-search>Retry</button>`
    : results.length ? `${results.length} place${results.length === 1 ? '' : 's'} found`
    : `No places found for “${esc(text)}”. Check the spelling, or try a larger town nearby.`;
  $('#searchResults').innerHTML = status === 'ok'
    ? results.map((r, i) => placeRow(`data-result="${i}"`, r.name, r.region)).join('') : '';
}

function renderRecent() {
  $('#recentLabel').hidden = !S.recent.length;
  $('#recentList').innerHTML = S.recent.map((p, i) => placeRow(`data-recent="${i}"`, p.name, p.region)).join('');
}
renderRecent();

// Results for the previous text are withdrawn as soon as the text changes, so a tap can't land on a stale row.
q.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const text = q.value.trim();
  if (text.split(',')[0].trim().length >= 2) {
    S.search = { q: text, status: 'loading', results: [], error: null };
    renderSearch();
  }
  searchTimer = setTimeout(runSearch, 300);
});
// Enter / the keyboard's Search key: search now and drop the keyboard so results are visible.
$('#placeForm').addEventListener('submit', e => { e.preventDefault(); runSearch(); q.blur(); });
dlg.addEventListener('click', e => {
  if (e.target.closest('[data-retry-search]')) { searchCache.delete(S.search.q.toLowerCase()); runSearch(); return; }
  const res = e.target.closest('[data-result]');
  if (res) {
    const r = S.search.results[+res.dataset.result];
    if (r) choose({ kind: 'search', id: r.id, name: r.name, region: r.region, country: r.country, tz: r.tz, lat: r.lat, lon: r.lon });
    return;
  }
  const rec = e.target.closest('[data-recent]');
  if (rec) { const p = S.recent[+rec.dataset.recent]; if (p) choose(p); }
});

// ---- boot ---------------------------------------------------------------------
if (history.state?.ex === 1) history.replaceState(null, '');
loadModel();
loadMonitors();
setInterval(() => {
  if (S.model && Date.now() - S.model.fetchedAt > 15 * 60e3 && !omPause()) loadModel();
  if (S.monitors.data && Date.now() - S.monitors.data.fetchedAt > 15 * 60e3) loadMonitors();
  else render();
}, 60e3);
