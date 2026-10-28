import { catHex } from './aqi.js';
import { cellAt } from './data.js';

const L = window.L;
const dark = matchMedia('(prefers-color-scheme: dark)');

// Basemap: Esri Light/Dark Gray Canvas (keyless raster, retiring Dec 2029), with
// its separate label layer on top. CARTO's raster tiles began requiring a key in
// Sept 2026. If Esri tiles fail repeatedly we drop to OpenStreetMap's standard tiles.
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';
const esriUrl = part => `${ESRI}/World_${dark.matches ? 'Dark' : 'Light'}_Gray_${part}/MapServer/tile/{z}/{y}/{x}`;
const ESRI_ATTR = 'Esri, HERE, Garmin, © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, and the GIS user community';
const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

function baseMap(el, opts, attribution) {
  const map = L.map(el, { zoomSnap: 0.5, attributionControl: false, ...opts });
  const tileOpts = { maxZoom: 14, maxNativeZoom: 16, minZoom: 6 };
  const base = L.tileLayer(esriUrl('Base'), tileOpts).addTo(map);
  // Labels sit above model cells (overlayPane, 400) and below markers (600).
  map.createPane('labels');
  map.getPane('labels').style.zIndex = 450;
  map.getPane('labels').style.pointerEvents = 'none';
  const labels = L.tileLayer(esriUrl('Reference'), { ...tileOpts, pane: 'labels' }).addTo(map);
  attribution?.addAttribution(ESRI_ATTR);
  let errors = 0, fellBack = false;
  base.on('tileerror', () => {
    if (fellBack || ++errors < 3) return;
    fellBack = true;
    labels.remove();
    base.setUrl(OSM_URL);
    attribution?.removeAttribution(ESRI_ATTR).addAttribution(OSM_ATTR);
  });
  base.on('tileload', () => { if (!fellBack) errors = 0; });
  dark.addEventListener('change', () => {
    if (fellBack) return;
    base.setUrl(esriUrl('Base'));
    labels.setUrl(esriUrl('Reference'));
  });
  return map;
}

const tok = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888';
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const num = v => (v == null ? '–' : Math.round(v));

function icon(cls, v, title) {
  return L.divIcon({
    className: 'mk-wrap',
    iconSize: [44, 44],
    iconAnchor: [22, 22],
    html: `<div class="mk ${cls}" style="--c:${catHex(v)}" title="${esc(title)}"><span>${num(v)}</span></div>`,
  });
}

// Full-screen geographic explorer. Two modes share one map:
//   locations: AirNow monitors (solid) + model estimates at named places (hollow)
//   field:     CAMS model cells drawn at native size, not interpolated
export class Explorer {
  constructor(el, { onSelect, bounds }) {
    this.el = el;
    this.onSelect = onSelect;
    this.mode = 'locations';
    this.map = null;
    this.hitTargets = [];
    this.pending = bounds;
  }

  ensure() {
    if (this.map) return;
    const attr = L.control.attribution({ position: 'topright', prefix: false });
    this.map = baseMap(this.el, { zoomControl: false, tapTolerance: 20 }, attr);
    attr.addTo(this.map);
    L.control.zoom({ position: 'topright' }).addTo(this.map);
    this.map.fitBounds(this.pending);
    this.layers = {
      field: L.layerGroup(), fieldLabels: L.layerGroup(),
      monitors: L.layerGroup(), places: L.layerGroup(), sel: L.layerGroup().addTo(this.map),
    };
    this.map.on('click', e => this.handleTap(e));
    this.map.on('zoomend', () => this.syncLabels());
  }

  show() {
    this.ensure();
    this.visible = true;
    requestAnimationFrame(() => {
      this.map.invalidateSize();
      if (this.pending) { this.map.fitBounds(this.pending); this.pending = null; }
    });
  }
  hide() { this.visible = false; }

  // Frame a new location. A hidden map has no size, so framing waits for show().
  focus(bounds) {
    this.pending = bounds;
    if (this.map && this.visible) { this.map.fitBounds(bounds); this.pending = null; }
  }

  // Forgiving selection: a tap within 32 px of any marker selects that marker.
  handleTap(e) {
    const p = e.containerPoint;
    let best = null, bestD = 32;
    for (const t of this.hitTargets) {
      const d = p.distanceTo(this.map.latLngToContainerPoint([t.lat, t.lon]));
      if (d < bestD) { best = t; bestD = d; }
    }
    if (best) this.onSelect(best.place);
    else this.onSelect({ kind: 'point', lat: +e.latlng.lat.toFixed(4), lon: +e.latlng.lng.toFixed(4) });
  }

  setMode(mode) { this.mode = mode; this.draw(this.last); }

  draw(v) {
    this.last = v;
    if (!this.map || !v) return;
    const { field, fieldT, monitors, places, place, isNow } = v;
    const Ls = this.layers;
    Object.values(Ls).forEach(l => l.clearLayers());
    this.hitTargets = [];

    const show = (layer, on) => (on ? layer.addTo(this.map) : layer.remove());
    show(Ls.field, this.mode === 'field');
    show(Ls.fieldLabels, this.mode === 'field');
    show(Ls.monitors, this.mode === 'locations');
    show(Ls.places, this.mode === 'locations');

    if (this.mode === 'field' && field?.cells && fieldT != null) {
      const h = field.step / 2;
      for (const c of field.cells) {
        const a = cellAt(c, fieldT);
        L.rectangle([[c.lat - h, c.lon - h], [c.lat + h, c.lon + h]], {
          interactive: false, weight: 1,
          color: a == null ? tok('--ink-3') : catHex(a), opacity: 0.55,
          dashArray: a == null ? '3 4' : null,
          fillColor: a == null ? 'transparent' : catHex(a), fillOpacity: a == null ? 0 : 0.34,
        }).addTo(Ls.field);
        L.marker([c.lat, c.lon], {
          interactive: false, keyboard: false,
          icon: L.divIcon({ className: 'cell-label', iconSize: [40, 20], iconAnchor: [20, 10], html: num(a) }),
        }).addTo(Ls.fieldLabels);
      }
      this.syncLabels();
    }

    if (this.mode === 'locations') {
      for (const p of places) {
        const pl = p.place || { kind: 'preset', name: p.name, lat: p.lat, lon: p.lon };
        L.marker([p.lat, p.lon], { icon: icon('mk-est', p.value, `${p.name}: model estimate`), keyboard: false, interactive: false })
          .addTo(Ls.places);
        this.hitTargets.push({ lat: p.lat, lon: p.lon, place: pl });
      }
      for (const m of monitors) {
        const pl = { kind: 'monitor', id: m.id, name: m.name, lat: m.lat, lon: m.lon };
        L.marker([m.lat, m.lon], {
          icon: icon(`mk-mon${isNow ? '' : ' mk-dim'}`, m.aqi, `${m.name}: AirNow monitor`), keyboard: false, interactive: false,
        }).addTo(Ls.monitors);
        this.hitTargets.push({ lat: m.lat, lon: m.lon, place: pl });
      }
    }

    if (place) {
      L.marker([place.lat, place.lon], {
        interactive: false, keyboard: false, zIndexOffset: 1000,
        icon: L.divIcon({ className: 'mk-wrap', iconSize: [56, 56], iconAnchor: [28, 28], html: '<div class="mk-sel"></div>' }),
      }).addTo(Ls.sel);
    }
  }

  // Cell values are labelled only when a cell is wide enough on screen to hold one.
  syncLabels() {
    if (!this.map || this.mode !== 'field') return;
    const step = this.last?.field?.step ?? 0.4;
    const c = this.map.getCenter();
    const a = this.map.latLngToContainerPoint(c), b = this.map.latLngToContainerPoint([c.lat, c.lng + step]);
    const on = Math.abs(b.x - a.x) >= 34;
    if (on) this.layers.fieldLabels.addTo(this.map); else this.layers.fieldLabels.remove();
  }
}

// Small non-interactive preview on the home console.
export class Preview {
  constructor(el, bounds) {
    this.map = baseMap(el, {
      zoomControl: false, dragging: false, touchZoom: false, scrollWheelZoom: false,
      doubleClickZoom: false, boxZoom: false, keyboard: false, tap: false,
    });
    this.bounds = bounds;
    this.map.fitBounds(bounds);
    this.layer = L.layerGroup().addTo(this.map);
  }
  draw({ monitors, place }) {
    this.layer.clearLayers();
    for (const m of monitors) {
      L.circleMarker([m.lat, m.lon], { radius: 4, weight: 1, color: tok('--ink'), fillColor: catHex(m.aqi), fillOpacity: 1, interactive: false })
        .addTo(this.layer);
    }
    if (place) {
      L.circleMarker([place.lat, place.lon], { radius: 9, weight: 3, color: tok('--accent'), fill: false, interactive: false }).addTo(this.layer);
    }
  }
  focus(bounds) { this.bounds = bounds; this.map.fitBounds(bounds); }
  invalidate() { this.map.invalidateSize(); this.map.fitBounds(this.bounds); }
}
