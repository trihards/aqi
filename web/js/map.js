import { catHex } from './aqi.js';

const L = window.L;
const dark = matchMedia('(prefers-color-scheme: dark)');
const tileUrl = () =>
  `https://{s}.basemaps.cartocdn.com/${dark.matches ? 'dark_all' : 'light_all'}/{z}/{x}/{y}{r}.png`;
const ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · © <a href="https://carto.com/attributions">CARTO</a>';
export const BAY_BOUNDS = [[37.15, -122.85], [38.55, -121.65]];

function baseMap(el, opts) {
  const map = L.map(el, { zoomSnap: 0.5, attributionControl: false, ...opts });
  const tiles = L.tileLayer(tileUrl(), { subdomains: 'abcd', maxZoom: 14, minZoom: 6, detectRetina: true }).addTo(map);
  dark.addEventListener('change', () => tiles.setUrl(tileUrl()));
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
  constructor(el, { onSelect }) {
    this.el = el;
    this.onSelect = onSelect;
    this.mode = 'locations';
    this.map = null;
    this.hitTargets = [];
  }

  ensure() {
    if (this.map) return;
    this.map = baseMap(this.el, { zoomControl: false, tapTolerance: 20 });
    L.control.attribution({ position: 'topright', prefix: false }).addAttribution(ATTR).addTo(this.map);
    L.control.zoom({ position: 'topright' }).addTo(this.map);
    this.map.fitBounds(BAY_BOUNDS);
    this.layers = {
      field: L.layerGroup(), fieldLabels: L.layerGroup(),
      monitors: L.layerGroup(), places: L.layerGroup(), sel: L.layerGroup().addTo(this.map),
    };
    this.map.on('click', e => this.handleTap(e));
    this.map.on('zoomend', () => this.syncLabels());
  }

  show() { this.ensure(); requestAnimationFrame(() => this.map.invalidateSize()); }

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
    const { field, fieldIdx, monitors, places, place, isNow } = v;
    const Ls = this.layers;
    Object.values(Ls).forEach(l => l.clearLayers());
    this.hitTargets = [];

    const show = (layer, on) => (on ? layer.addTo(this.map) : layer.remove());
    show(Ls.field, this.mode === 'field');
    show(Ls.fieldLabels, this.mode === 'field');
    show(Ls.monitors, this.mode === 'locations');
    show(Ls.places, this.mode === 'locations');

    if (this.mode === 'field' && field?.cells && fieldIdx >= 0) {
      const h = field.step / 2;
      for (const c of field.cells) {
        const a = c.aqi[fieldIdx];
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
        const pl = { kind: 'preset', name: p.name, lat: p.lat, lon: p.lon };
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

  syncLabels() {
    if (!this.map || this.mode !== 'field') return;
    const on = this.map.getZoom() >= 8;
    if (on) this.layers.fieldLabels.addTo(this.map); else this.layers.fieldLabels.remove();
  }
}

// Small non-interactive preview on the home console.
export class Preview {
  constructor(el) {
    this.map = baseMap(el, {
      zoomControl: false, dragging: false, touchZoom: false, scrollWheelZoom: false,
      doubleClickZoom: false, boxZoom: false, keyboard: false, tap: false,
    });
    this.map.fitBounds(BAY_BOUNDS);
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
  invalidate() { this.map.invalidateSize(); this.map.fitBounds(BAY_BOUNDS); }
}
