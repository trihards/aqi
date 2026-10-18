import { CATS, category, POLLUTANTS, scalePos } from './aqi.js';
import {
  fetchModel, fetchField, fetchMonitors, PLACES, nearest, fieldValueAt, indexAtOrBefore,
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

const S = {
  place: store.get('aqi.place') || { kind: 'preset', ...PLACES[0] },
  model: null, dayParts: [], modelStatus: 'loading', modelError: null, modelStart: Date.now(),
  monitors: { status: 'loading', list: [], error: null, data: null },
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
const tzOf = () => S.model?.tz || 'America/Los_Angeles';
const hourLabel = ms => fmt({ weekday: 'short', hour: 'numeric' }, tzOf()).format(ms);
const clock = ms => fmt({ hour: 'numeric', minute: '2-digit' }, tzOf()).format(ms);
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
  if (p.kind === 'preset' || p.kind === 'monitor') return p.name;
  const n = nearest(PLACES, p.lat, p.lon);
  if (p.kind === 'gps') return 'Current location';
  return n && n.km < 25 ? `Near ${n.item.name}` : 'Map point';
}
function placeKind(p) {
  if (p.kind === 'monitor') return 'AirNow monitor';
  if (p.kind === 'preset') return 'Place';
  const n = nearest(PLACES, p.lat, p.lon);
  const near = n && n.km < 25 ? ` · ${km(n.km)} from ${n.item.name}` : '';
  return p.kind === 'gps' ? `Device location${near}` : `${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}`;
}

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
  const monFresh = !!(mon && mon.aqi != null && mon.ts != null && Date.now() - mon.ts < MONITOR_FRESH_MS);
  const isNow = !mi || mi.selIdx === mi.nowIdx;
  const r = { p, mi, mon, monKm, monFresh, isNow };
  if (mi) {
    const s = mi.m.series, i = mi.selIdx;
    r.t = mi.m.times[i] * 1000;
    r.modelAqi = s.us_aqi[i];
    r.phase = i > mi.nowIdx ? 'forecast' : 'estimate';
    r.modelDominant = dominantAt(s, i);
    const back = s.us_aqi[i - 3], fwd = s.us_aqi[i + 6];
    if (r.modelAqi != null && back != null) r.trend = Math.round(r.modelAqi - back);
    if (r.modelAqi != null && fwd != null && i + 6 <= mi.hi) r.ahead = fwd;
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
  if (k) return 'CAMS model via Open-Meteo · ~40 km cell';
  return '';
}

function freshText(r) {
  const pr = r.primary;
  if (!pr) return '';
  if (pr.kind === 'measured') return `Observed ${clock(pr.ts)} · ${rel(pr.ts)}`;
  if (pr.kind === 'forecast') return `Forecast for ${hourLabel(pr.ts)} · ${rel(pr.ts)}`;
  if (r.isNow) return `Model hour ${clock(pr.ts)} · data fetched ${rel(S.model.fetchedAt)}`;
  return `Model estimate for ${hourLabel(pr.ts)} · ${rel(pr.ts)}`;
}

function trendHTML(r) {
  if (r.trend == null) return `<p class="ro-trend muted">Trend unavailable for this hour</p>`;
  const d = r.trend;
  const [g, w] = Math.abs(d) < 3 ? ['▬', 'Steady'] : d > 0 ? ['▲', 'Rising'] : ['▼', 'Falling'];
  const mag = Math.abs(d) < 3 ? `${d >= 0 ? '+' : '−'}${Math.abs(d)}` : `${d > 0 ? '+' : '−'}${Math.abs(d)}`;
  return `<p class="ro-trend"><span class="tr-g" aria-hidden="true">${g}</span>${w}, ${mag} over the past 3 h <span class="src">model</span></p>`;
}

function notesHTML(r) {
  const out = [];
  const pr = r.primary;
  if (pr?.kind === 'measured' && r.modelAqi != null) {
    out.push(`Model estimate for this ~40 km cell: ${n0(r.modelAqi)} (${category(r.modelAqi).label}).`);
  }
  if (r.ahead != null && pr && pr.kind !== 'forecast') {
    out.push(`Six hours later: ${n0(r.ahead)} (${category(r.ahead).label}), forecast.`);
  }
  if (S.modelStatus === 'error') {
    out.push(`Model data unavailable (${esc(S.modelError)}), so trend, timeline and forecast are missing. <button class="btn btn-retry sm" type="button" data-retry="model">Retry</button>`);
  }
  if (S.monitors.status === 'ok') {
    if (r.p.kind === 'monitor' && !r.monFresh) out.push('This monitor has no reading from the last 3 hours.');
    else if (!r.mon && r.p.kind !== 'monitor') out.push(`No reporting AirNow monitor within ${MONITOR_RADIUS_KM} km.`);
    else if (r.mon && !r.monFresh) out.push(`Nearest monitor (${esc(r.mon.name)}) has no reading from the last 3 hours.`);
    else if (!r.isNow && r.mon) out.push('Monitor readings exist for the latest hour only.');
  } else if (S.monitors.status === 'error') {
    out.push('Monitor feed unavailable; showing model values only.');
  }
  return out.map(t => `<p class="ro-note">${t}</p>`).join('');
}

function readoutHTML(r, variant) {
  const full = variant === 'full';
  if (!r.primary) {
    if (S.modelStatus === 'error') {
      return `<div class="ro ro-empty"><p class="ro-msg">Model data unavailable: ${esc(S.modelError)}.</p>
        <button class="btn btn-retry" type="button" data-retry="model">Retry</button></div>`;
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
  const pr = r.primary, cat = category(pr.aqi);
  const dom = pr.dominant ? ` · <span class="nowrap">dominant ${polLabel(pr.dominant)}</span>` : '';
  return `<div class="ro${full ? '' : ' ro-compact'}">
    <div class="ro-src">${badge(pr.kind)}<span class="ro-srctext">${sourceText(r)}</span></div>
    <div class="ro-main">
      <span class="ro-num" aria-label="US AQI ${Math.round(pr.aqi)}">${Math.round(pr.aqi)}</span>
      <div class="ro-side">
        <span class="ro-cat"><i class="sw" style="--c:${cat.hex}"></i>${cat.label}</span>
        <span class="ro-unit">US AQI${dom}</span>
      </div>
    </div>
    ${trendHTML(r)}
    <p class="ro-fresh">${freshText(r)}</p>
    ${full ? meterHTML(pr.aqi) + notesHTML(r) : ''}
  </div>`;
}

function tlReadoutHTML(r) {
  if (!r.mi) {
    return S.modelStatus === 'error'
      ? `<span class="muted">Timeline unavailable: model data did not load.</span> <button class="btn btn-retry sm" type="button" data-retry="model">Retry</button>`
      : '<span class="muted">Loading timeline…</span>';
  }
  const v = r.modelAqi;
  const cat = category(v);
  const meas = r.isNow && r.monFresh
    ? `<span class="tlr-meas">Measured ${n0(r.mon.aqi)}</span>` : '';
  return `<span class="tlr-time">${hourLabel(r.t)}</span>
    <span class="tlr-val">${v == null ? '—' : `<b>${Math.round(v)}</b> ${cat.short}`}</span>
    ${badge(r.phase)}${meas}`;
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
    ? `Loaded. Model grid point ${m.lat.toFixed(2)}, ${m.lon.toFixed(2)}; fetched ${rel(m.fetchedAt)}.`
    : S.modelStatus === 'error' ? `Unavailable: ${esc(S.modelError)}.` : 'Loading…';
  const monStatus = M.status === 'ok'
    ? `${M.list.length} Bay Area sites in the latest feed; fetched ${rel(M.data.fetchedAt)}.`
    : M.status === 'error' ? `Unavailable: ${esc(M.error)}. <button class="btn btn-retry sm" type="button" data-retry="monitors">Retry</button>` : 'Loading…';
  const inspector = M.data
    ? `<details class="inspect"><summary>Monitor feed fields</summary>
        <p class="fine">Fields matched automatically. Report anything marked unmatched.</p>
        <pre>${esc(Object.entries(M.data.mapping).map(([k, v]) => `${k.padEnd(8)} ${v ?? 'unmatched'}`).join('\n'))}\n\n${esc(M.data.fields.map(f => `${f.name}  ${f.type.replace('esriFieldType', '')}`).join('\n'))}${M.list[0] ? `\n\nsample time: ${esc(M.list[0].rawTime)}` : ''}</pre></details>`
    : '';
  return `<dl class="src-list">
    <dt>Model estimates and forecast</dt>
    <dd>Copernicus Atmosphere Monitoring Service (CAMS) global forecast, served by
      <a href="https://open-meteo.com/en/docs/air-quality-api" target="_blank" rel="noopener">Open-Meteo</a> (CC BY 4.0).
      About 40 km resolution. Past hours are model values, not observations. US AQI values are calculated by Open-Meteo from modeled concentrations.
      <span class="status">${modelStatus}</span></dd>
    <dt>Monitor observations</dt>
    <dd>U.S. EPA <a href="https://www.airnow.gov/" target="_blank" rel="noopener">AirNow</a>, via EPA's public
      “AirNow Current Monitor Data” feed. Latest hour only. AirNow data are preliminary and not fully verified; official records come from EPA AQS.
      <span class="status">${monStatus}</span>${inspector}</dd>
    <dt>How readings are chosen</dt>
    <dd>“Measured” is shown when the selected monitor, or one within ${MONITOR_RADIUS_KM} km, reported in the last 3 hours.
      Otherwise the reading is the model estimate for the grid cell. Trend is the change in modeled AQI over the previous 3 hours.
      The air quality map draws each model cell at its native size without smoothing, so nearby towns often share a value.</dd>
    <dt>Map</dt>
    <dd>Base map: Esri Gray Canvas (Esri, HERE, Garmin, © OpenStreetMap contributors). Falls back to OpenStreetMap tiles if Esri is unreachable.</dd>
  </dl>`;
}

// ---- rendering: explorer ------------------------------------------------------
function fieldIndex() {
  const f = S.field.data;
  if (!f?.times?.length) return -1;
  const t = S.selT ?? Date.now() / 1000;
  if (t < f.times[0] || t > f.times[f.times.length - 1] + 3600) return -1;
  return indexAtOrBefore(f.times, t);
}

function legendHTML(r) {
  if (S.mode === 'locations') {
    const M = S.monitors;
    const status = M.status === 'loading' ? '<p class="lg-note">Loading monitors…</p>'
      : M.status === 'error' ? `<p class="lg-note">Monitor feed unavailable. <button class="btn btn-retry sm" type="button" data-retry="monitors">Retry</button></p>`
      : !r.isNow ? '<p class="lg-note">Monitors show their latest hour only; place estimates follow the selected hour.</p>' : '';
    return `<p class="lg-row"><span class="lg-key lg-mon" aria-hidden="true"></span>Monitor, measured
      <span class="lg-key lg-est" aria-hidden="true"></span>Model estimate</p>${S.hint ? `<p class="lg-note">${S.hint}</p>` : ''}${status}`;
  }
  const F = S.field;
  const keys = CATS.slice(0, 5).map(c => `<span class="lg-cat"><i class="sw" style="--c:${c.hex}"></i>${c.short}</span>`).join('');
  const status = F.status === 'loading' ? '<p class="lg-note">Loading model field…</p>'
    : F.status === 'error' ? `<p class="lg-note">Model field unavailable: ${esc(F.error)}. <button class="btn btn-retry sm" type="button" data-retry="field">Retry</button></p>`
    : fieldIndex() < 0 ? '<p class="lg-note">The regional field covers 2 days back to 4 days ahead. Pick an hour in that range.</p>' : '';
  return `<p class="lg-row">CAMS model · ~40 km cells · shown as-is, not interpolated</p><p class="lg-row lg-cats">${keys}</p>${status}`;
}

// ---- wiring -------------------------------------------------------------------
const tlHome = new Timeline($('#tlHome'), { onSelect: selectIdx, height: 176 });
const tlSheet = new Timeline($('#tlSheet'), { onSelect: selectIdx, height: 150 });
const explorer = new Explorer($('#map'), { onSelect: p => setPlace(p) });
let preview = null;
try { preview = new Preview($('#previewMap')); } catch {}

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
      measured: r.monFresh ? { aqi: r.mon.aqi } : null,
      label: i => hourLabel(m.times[i] * 1000),
    };
    tlHome.set(d);
    tlSheet.set(d);
  } else { tlHome.set(null); tlSheet.set(null); }
  document.querySelectorAll('[data-now]').forEach(b => { b.disabled = r.isNow; });

  if (!$('#explorer').hidden) {
    const fIdx = fieldIndex();
    explorer.draw({
      field: S.field.data, fieldIdx: fIdx, monitors: S.monitors.list, isNow: r.isNow, place: S.place,
      // A named place sitting on top of a reporting monitor adds clutter, not information.
      places: PLACES
        .filter(p => !nearest(S.monitors.list, p.lat, p.lon, 4, m => m.aqi != null))
        .map(p => ({ ...p, value: fIdx < 0 ? null : fieldValueAt(S.field.data, p.lat, p.lon, fIdx) })),
    });
    $('#exLegend').innerHTML = legendHTML(r);
    const et = $('#exTime');
    et.hidden = r.isNow || !r.mi;
    if (!et.hidden) et.innerHTML = `${hourLabel(r.t)} · ${r.phase === 'forecast' ? 'forecast' : 'model'} <span class="ex-time-reset">Back to now</span>`;
  }
  preview?.draw({ monitors: S.monitors.list, place: S.place });
}

let modelToken = 0;
async function loadModel() {
  const t = ++modelToken;
  S.model = null; S.modelStatus = 'loading'; S.modelError = null; S.modelStart = Date.now();
  render();
  setTimeout(() => { if (t === modelToken && S.modelStatus === 'loading') render(); }, 5200);
  try {
    const m = await fetchModel(S.place.lat, S.place.lon);
    if (t !== modelToken) return;
    S.model = m; S.dayParts = dayPartsFor(m); S.modelStatus = 'ok';
  } catch (e) {
    if (t !== modelToken) return;
    S.modelStatus = 'error'; S.modelError = e.message || 'request failed';
  }
  render();
}

async function loadMonitors() {
  S.monitors = { ...S.monitors, status: 'loading', error: null };
  render();
  try {
    const d = await fetchMonitors();
    S.monitors = { status: 'ok', list: d.list, data: d, error: null };
  } catch (e) {
    S.monitors = { status: 'error', list: [], data: null, error: e.message || 'request failed' };
  }
  render();
}

async function loadField() {
  if (S.field.status === 'loading') return;
  S.field = { status: 'loading', data: S.field.data, error: null };
  render();
  try { S.field = { status: 'ok', data: await fetchField(), error: null }; }
  catch (e) { S.field = { status: 'error', data: null, error: e.message || 'request failed' }; }
  render();
}

function setPlace(p) {
  if (p.kind === 'point' || p.kind === 'gps') p = { ...p, lat: +p.lat.toFixed(3), lon: +p.lon.toFixed(3) };
  S.place = p;
  S.hint = null;
  store.set('aqi.place', p);
  loadModel();
}

// Explorer open/close, with history so the iOS back gesture works.
function openExplorer() {
  $('#explorer').hidden = false;
  $('#home').inert = true;
  document.body.classList.add('ex-open');
  if (history.state?.ex !== 1) history.pushState({ ex: 1 }, '');
  explorer.show();
  if (S.field.status === 'idle') loadField();
  render();
  requestAnimationFrame(() => tlSheet.render());
}
function hideExplorer() {
  $('#explorer').hidden = true;
  $('#home').inert = false;
  document.body.classList.remove('ex-open');
  S.hint = null;
  preview?.invalidate();
  render();
}
$('#openMap').addEventListener('click', openExplorer);
$('#exBack').addEventListener('click', () => (history.state?.ex === 1 ? history.back() : hideExplorer()));
addEventListener('popstate', () => { if (!$('#explorer').hidden) hideExplorer(); });

document.querySelectorAll('.seg [data-mode]').forEach(b => b.addEventListener('click', () => {
  S.mode = b.dataset.mode;
  document.querySelectorAll('.seg [data-mode]').forEach(x => x.setAttribute('aria-checked', String(x === b)));
  explorer.setMode(S.mode);
  if (S.mode === 'field' && S.field.status === 'idle') loadField();
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
$('#placeList').innerHTML = PLACES.map((p, i) => `<button class="row-btn" type="button" data-place="${i}">${p.name}</button>`).join('');
$('#placeBtn').addEventListener('click', () => dlg.showModal());
$('#placeList').addEventListener('click', e => {
  const b = e.target.closest('[data-place]');
  if (!b) return;
  setPlace({ kind: 'preset', ...PLACES[+b.dataset.place] });
  dlg.close();
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
    pos => { note.textContent = 'Stays on this device'; dlg.close(); setPlace({ kind: 'gps', lat: pos.coords.latitude, lon: pos.coords.longitude }); },
    err => { note.textContent = err.code === 1 ? 'Location permission was denied' : 'Could not get a location'; },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
  );
});

// ---- boot ---------------------------------------------------------------------
if (history.state?.ex === 1) history.replaceState(null, '');
loadModel();
loadMonitors();
setInterval(() => {
  if (S.model && Date.now() - S.model.fetchedAt > 15 * 60e3) loadModel();
  if (S.monitors.data && Date.now() - S.monitors.data.fetchedAt > 15 * 60e3) loadMonitors();
  else render();
}, 60e3);
