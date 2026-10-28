import { CATS, category } from './aqi.js';

const NS = 'http://www.w3.org/2000/svg';
let uid = 0;

// Hourly AQI timeline: modeled past (solid), model forecast (dashed, hatched ground), a selection
// cursor, and the latest measured reading as a filled dot at its own report time. The series is the
// model's alone; the measurement is never spliced into it.
// The whole plot is the hit area; tap or drag horizontally to select an hour.
export class Timeline {
  constructor(root, { onSelect, height = 168 }) {
    this.root = root;
    this.onSelect = onSelect;
    this.h = height;
    this.id = `tl${++uid}`;
    this.d = null;
    this.svg = document.createElementNS(NS, 'svg');
    this.svg.setAttribute('class', 'tl-svg');
    this.svg.setAttribute('role', 'slider');
    this.svg.setAttribute('tabindex', '0');
    this.svg.setAttribute('aria-label', 'Timeline hour');
    root.appendChild(this.svg);
    new ResizeObserver(() => this.render()).observe(root);
    this.bind();
  }

  set(d) { this.d = d; this.render(); }

  bind() {
    const s = this.svg;
    let start = null, scrubbing = false;
    s.addEventListener('pointerdown', e => {
      start = { x: e.clientX, y: e.clientY, id: e.pointerId };
      scrubbing = e.pointerType === 'mouse';
      if (scrubbing) { s.setPointerCapture(e.pointerId); this.pick(e.clientX); }
    });
    s.addEventListener('pointermove', e => {
      if (!start || e.pointerId !== start.id) return;
      if (!scrubbing && Math.abs(e.clientX - start.x) > 6 && Math.abs(e.clientX - start.x) > Math.abs(e.clientY - start.y)) {
        scrubbing = true;
        try { s.setPointerCapture(e.pointerId); } catch {}
      }
      if (scrubbing) this.pick(e.clientX);
    });
    s.addEventListener('pointerup', e => {
      if (start && !scrubbing && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 10) this.pick(e.clientX);
      start = null; scrubbing = false;
    });
    s.addEventListener('pointercancel', () => { start = null; scrubbing = false; });
    s.addEventListener('keydown', e => {
      if (!this.d) return;
      const { selIdx, lo, hi, nowIdx } = this.d;
      const step = e.shiftKey ? 6 : 1;
      const map = { ArrowLeft: selIdx - step, ArrowRight: selIdx + step, Home: lo, End: hi, PageUp: selIdx - 24, PageDown: selIdx + 24, n: nowIdx };
      if (!(e.key in map)) return;
      e.preventDefault();
      this.onSelect(Math.max(lo, Math.min(hi, map[e.key])));
    });
  }

  pick(clientX) {
    if (!this.geom) return;
    const { ml, w, lo, hi } = this.geom;
    const r = this.svg.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left - ml) / w));
    const idx = lo + Math.round(f * (hi - lo));
    if (idx !== this.d.selIdx) this.onSelect(idx);
  }

  render() {
    const d = this.d, W = this.root.clientWidth;
    if (!d || !W) { this.svg.innerHTML = ''; return; }
    const H = this.h, ml = 30, mr = 10, mt = 20, mb = 26;
    const { values, times, nowIdx, selIdx, lo, hi, dayParts } = d;
    const w = W - ml - mr, h = H - mt - mb;
    this.geom = { ml, w, lo, hi };
    const span = Math.max(1, hi - lo);
    const x = i => ml + ((i - lo) / span) * w;
    let vmax = 0;
    for (let i = lo; i <= hi; i++) if (values[i] != null) vmax = Math.max(vmax, values[i]);
    // measured.pos is a fractional hour index; outside the plotted range the dot is left out.
    const meas = d.measured?.aqi != null && d.measured.pos != null && d.measured.pos >= lo && d.measured.pos <= hi ? d.measured : null;
    if (meas) vmax = Math.max(vmax, meas.aqi);
    const ymax = Math.max(100, Math.ceil((vmax + 5) / 50) * 50);
    const y = v => mt + h - (Math.min(v, ymax) / ymax) * h;
    const id = this.id;
    const out = [];

    out.push(`<defs><pattern id="${id}h" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" class="tl-hatch"/></pattern></defs>`);

    // Category bands with boundary ticks
    for (const c of CATS) {
      const a = c.lo === 0 ? 0 : c.lo - 1;
      if (a >= ymax) break;
      const b = Math.min(c.hi, ymax);
      out.push(`<rect x="${ml}" y="${y(b)}" width="${w}" height="${y(a) - y(b)}" fill="${c.hex}" class="tl-band"/>`);
    }
    for (const t of [0, 50, 100, 150, 200, 300, 500]) {
      if (t > ymax) break;
      out.push(`<line x1="${ml}" x2="${ml + w}" y1="${y(t)}" y2="${y(t)}" class="tl-grid"/>`);
      out.push(`<text x="${ml - 6}" y="${y(t) + 3.5}" class="tl-ytick" text-anchor="end">${t}</text>`);
    }

    // Forecast ground
    if (nowIdx >= lo && nowIdx < hi) {
      out.push(`<rect x="${x(nowIdx)}" y="${mt}" width="${ml + w - x(nowIdx)}" height="${h}" fill="url(#${id}h)"/>`);
    }

    // Day dividers and labels
    let lastDayX = null;
    for (let i = lo; i <= hi; i++) {
      const p = dayParts[i];
      if (!p || p.hour !== 0) continue;
      out.push(`<line x1="${x(i)}" x2="${x(i)}" y1="${mt}" y2="${mt + h + 6}" class="tl-day"/>`);
      const labelX = x(i) + 3;
      if (labelX < ml + w - 34 && (lastDayX == null || labelX - lastDayX > 40)) {
        out.push(`<text x="${labelX}" y="${H - 8}" class="tl-xtick">${p.wd} ${p.day}</text>`);
        lastDayX = labelX;
      }
    }

    // Series: past solid, forecast dashed, gaps break the line
    const path = (a, b) => {
      let s = '', pen = false;
      for (let i = a; i <= b; i++) {
        const v = values[i];
        if (v == null) { pen = false; continue; }
        s += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      }
      return s;
    };
    const pastEnd = Math.min(nowIdx, hi);
    if (pastEnd >= lo) out.push(`<path d="${path(lo, pastEnd)}" class="tl-line tl-past"/>`);
    if (nowIdx < hi) out.push(`<path d="${path(Math.max(lo, nowIdx), hi)}" class="tl-line tl-fc"/>`);

    // Now marker
    if (nowIdx >= lo && nowIdx <= hi) {
      const nx = x(nowIdx);
      out.push(`<line x1="${nx}" x2="${nx}" y1="${mt - 4}" y2="${mt + h}" class="tl-now"/>`);
      out.push(`<text x="${nx - 4}" y="${mt - 8}" class="tl-label" text-anchor="end">MODEL · PAST</text>`);
      if (nx < ml + w - 60) out.push(`<text x="${nx + 4}" y="${mt - 8}" class="tl-label">FORECAST</text>`);
    }

    // Selection cursor
    if (selIdx >= lo && selIdx <= hi) {
      const sx = x(selIdx), sv = values[selIdx];
      out.push(`<line x1="${sx}" x2="${sx}" y1="${mt}" y2="${mt + h}" class="tl-cursor"/>`);
      if (sv != null) out.push(`<circle cx="${sx}" cy="${y(sv)}" r="5.5" class="tl-cursor-dot"/>`);
      out.push(`<path d="M${sx - 6},${mt + h + 1} L${sx + 6},${mt + h + 1} L${sx},${mt + h - 6} Z" class="tl-cursor-tri"/>`);
    }

    // Drawn last, so a measurement near the selected hour stays visible inside the cursor ring.
    if (meas) {
      out.push(`<circle cx="${x(meas.pos).toFixed(1)}" cy="${y(meas.aqi).toFixed(1)}" r="4.5" class="tl-meas"><title>${meas.label}</title></circle>`);
    }

    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    this.svg.setAttribute('width', W);
    this.svg.setAttribute('height', H);
    this.svg.setAttribute('aria-valuemin', lo);
    this.svg.setAttribute('aria-valuemax', hi);
    this.svg.setAttribute('aria-valuenow', selIdx);
    const sv = values[selIdx], cat = category(sv);
    this.svg.setAttribute('aria-valuetext',
      `${d.label(selIdx)}, ${sv == null ? 'no value' : `AQI ${Math.round(sv)} ${cat.label}`}, ${selIdx > nowIdx ? 'forecast' : 'model estimate'}`);
    this.svg.innerHTML = out.join('');
  }
}
