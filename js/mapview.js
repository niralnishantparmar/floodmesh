import { STATUS, REPORT_KINDS, escapeHtml, fmtAge } from './logic.js';

const REPORT_ICON = L.divIcon({
  className: 'report-icon',
  html: `<svg viewBox="0 0 24 22" width="24" height="22" aria-hidden="true">
    <path d="M12 1.5 23 20.5H1z" fill="#e08a00" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M12 8v6" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>
    <circle cx="12" cy="17.2" r="1.3" fill="#fff"/></svg>`,
  iconSize: [24, 22],
  iconAnchor: [12, 20],
  popupAnchor: [0, -18],
});

const PIN_ICON = L.divIcon({
  className: 'pin-icon',
  html: `<svg viewBox="0 0 28 40" width="28" height="40" aria-hidden="true">
    <path d="M14 1C7 1 1.5 6.4 1.5 13.3 1.5 22.6 14 39 14 39s12.5-16.4 12.5-25.7C26.5 6.4 21 1 14 1z" fill="#0e2a3f" stroke="#fff" stroke-width="2"/>
    <circle cx="14" cy="13.5" r="4.6" fill="#fff"/></svg>`,
  iconSize: [28, 40],
  iconAnchor: [14, 39],
});

function reportPopup(r) {
  const age = fmtAge((Date.now() - Date.parse(r.created_at)) / 1000);
  const note = r.note ? `<p>${escapeHtml(r.note)}</p>` : '';
  return `<div class="report-popup"><strong>${escapeHtml(REPORT_KINDS[r.kind] || 'Report')}</strong>${note}<span>Reported ${age}. Unverified community report.</span></div>`;
}

export class MapView {
  constructor(elementId, { center, zoom, onSelect, onMapClick }) {
    this.onSelect = onSelect;
    this.map = L.map(elementId, { zoomControl: false }).setView(center, zoom);
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom: 20,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(this.map);

    this.sensorMarkers = new Map();
    this.reportMarkers = new Map();
    this.pin = null;
    this.map.on('click', (e) => onMapClick && onMapClick(e.latlng));
  }

  setSensors(sensors, evals, selectedId) {
    const keep = new Set();
    for (const s of sensors) {
      if (s.lat == null || s.lng == null) continue;
      keep.add(s.id);
      const ev = evals.get(s.id);
      const color = STATUS[ev ? ev.key : 'nodata'].color;
      const selected = s.id === selectedId;
      let marker = this.sensorMarkers.get(s.id);
      if (!marker) {
        marker = L.circleMarker([s.lat, s.lng], {
          radius: 9,
          weight: 3,
          color: '#ffffff',
          fillColor: color,
          fillOpacity: 1,
          bubblingMouseEvents: false,
        }).addTo(this.map);
        marker.on('click', () => this.onSelect(s.id));
        marker.bindTooltip(escapeHtml(s.name), { direction: 'top', offset: [0, -10] });
        this.sensorMarkers.set(s.id, marker);
      }
      marker.setLatLng([s.lat, s.lng]);
      marker.setStyle({ fillColor: color, weight: selected ? 4 : 3 });
      marker.setRadius(selected ? 13 : 9);
      if (selected) marker.bringToFront();
    }
    for (const [id, marker] of this.sensorMarkers) {
      if (!keep.has(id)) {
        marker.remove();
        this.sensorMarkers.delete(id);
      }
    }
  }

  setReports(reports) {
    const keep = new Set();
    for (const r of reports) {
      keep.add(r.id);
      if (this.reportMarkers.has(r.id)) continue;
      const marker = L.marker([r.lat, r.lng], { icon: REPORT_ICON, keyboard: false }).addTo(this.map);
      marker.bindPopup(() => reportPopup(r));
      this.reportMarkers.set(r.id, marker);
    }
    for (const [id, marker] of this.reportMarkers) {
      if (!keep.has(id)) {
        marker.remove();
        this.reportMarkers.delete(id);
      }
    }
  }

  openReport(id) {
    const marker = this.reportMarkers.get(id);
    if (!marker) return;
    this.map.panTo(marker.getLatLng());
    marker.openPopup();
  }

  setPin(latlng, draggable) {
    if (this.pin) {
      this.pin.setLatLng(latlng);
    } else {
      this.pin = L.marker(latlng, { icon: PIN_ICON, draggable, autoPan: true }).addTo(this.map);
    }
    return this.pin;
  }

  getPin() {
    return this.pin ? this.pin.getLatLng() : null;
  }

  clearPin() {
    if (this.pin) {
      this.pin.remove();
      this.pin = null;
    }
  }

  center() {
    return this.map.getCenter();
  }

  focus(latlng) {
    this.map.panTo(latlng);
  }

  fit(points) {
    if (!points.length) return;
    this.map.fitBounds(L.latLngBounds(points), { padding: [70, 70], maxZoom: 17 });
  }

  resize() {
    this.map.invalidateSize();
  }
}
