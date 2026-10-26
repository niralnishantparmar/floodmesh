import { STATUS, REPORT_KINDS, escapeHtml, fmtAge, fmtIn } from './logic.js';
import { CARTO_KEY, COLORS } from './config.js';
import { femaTileLayer } from './sources.js';

const REPORT_SVG = `<svg viewBox="0 0 20 18" width="20" height="18" aria-hidden="true">
  <path d="M10 1.2 19 16.8H1z" fill="#c25e1a" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/>
  <path d="M10 6.5v4.6" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>
  <circle cx="10" cy="13.7" r="1.05" fill="#fff"/></svg>`;

const REPORT_ICON = L.divIcon({ className: 'report-icon', html: REPORT_SVG, iconSize: [20, 18], iconAnchor: [10, 16], popupAnchor: [0, -14] });

const PIN_ICON = L.divIcon({
  className: 'pin-icon',
  html: `<svg viewBox="0 0 24 34" width="24" height="34" aria-hidden="true">
    <path d="M12 1C6 1 1.5 5.6 1.5 11.4 1.5 19.3 12 33 12 33s10.5-13.7 10.5-21.6C22.5 5.6 18 1 12 1z" fill="#17212b" stroke="#fff" stroke-width="1.6"/>
    <circle cx="12" cy="11.5" r="3.6" fill="#fff"/></svg>`,
  iconSize: [24, 34],
  iconAnchor: [12, 33],
});

function gaugeIcon(key, fillPct, selected) {
  const size = selected ? 34 : 26;
  return L.divIcon({
    className: 'gauge-wrap',
    html: `<div class="gauge gauge-${key}${selected ? ' selected' : ''}" style="--c:${STATUS[key].color};--fill:${fillPct}%"><span></span></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function siteIcon(rank) {
  return L.divIcon({ className: 'site-wrap', html: `<div class="site-marker">${rank}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
}

export class MapView {
  constructor(elementId, { center, zoom, onSelect, onMapClick, onSiteSelect, onRiskMode, onViewChange, popupContent }) {
    this.onSelect = onSelect;
    this.onSiteSelect = onSiteSelect;
    this.onRiskMode = onRiskMode;
    this.popupContent = popupContent;
    this.map = L.map(elementId, { zoomControl: false, attributionControl: true }).setView(center, zoom);
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);
    const osm = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
    if (CARTO_KEY) {
      L.tileLayer(`https://basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png?key=${encodeURIComponent(CARTO_KEY)}`, {
        maxZoom: 20,
        attribution: `${osm} &copy; <a href="https://carto.com/attributions">CARTO</a>`,
      }).addTo(this.map);
    } else {
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, className: 'tiles-muted', attribution: osm }).addTo(this.map);
    }
    this.map.createPane('fema').style.zIndex = 340;
    const riskPane = this.map.createPane('risk');
    riskPane.style.zIndex = 350;
    riskPane.style.pointerEvents = 'none';

    this.layers = { risk: true, fema: false, reports: true, sites: true };
    this.riskOverlay = null;
    this.femaLayer = null;
    this.sensorMarkers = new Map();
    this.sensorIconKey = new Map();
    this.reportGroup = L.layerGroup().addTo(this.map);
    this.reportMarkers = new Map();
    this.siteGroup = L.layerGroup().addTo(this.map);
    this.pin = null;

    this.map.on('click', (e) => onMapClick && onMapClick(e.latlng));
    this.map.on('moveend', () => onViewChange && onViewChange(this.view(), this.map.getZoom()));
    this.addNotice();
    this.addLayerControl();
    this.addLegend();
  }

  view() {
    const b = this.map.getBounds();
    return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
  }

  zoom() {
    return this.map.getZoom();
  }

  contains(lat, lng) {
    return this.map.getBounds().contains([lat, lng]);
  }

  addNotice() {
    const ctl = L.control({ position: 'topleft' });
    ctl.onAdd = () => {
      const div = L.DomUtil.create('div', 'map-notice');
      div.hidden = true;
      L.DomEvent.disableClickPropagation(div);
      return div;
    };
    ctl.addTo(this.map);
    this.notice = ctl.getContainer();
  }

  setNotice(text, action) {
    this.notice.hidden = !text;
    this.notice.innerHTML = text ? `<span>${escapeHtml(text)}</span>${action ? `<button type="button">${escapeHtml(action.label)}</button>` : ''}` : '';
    if (action) this.notice.querySelector('button').onclick = action.run;
  }

  addLayerControl() {
    const ctl = L.control({ position: 'topright' });
    ctl.onAdd = () => {
      const div = L.DomUtil.create('div', 'map-box layer-box');
      div.innerHTML = `
        <div class="box-title">Layers</div>
        <label><input type="checkbox" data-layer="risk" checked> Flood risk</label>
        <label><input type="checkbox" data-layer="fema"> FEMA flood zones</label>
        <label><input type="checkbox" data-layer="reports" checked> Reports</label>
        <label><input type="checkbox" data-layer="sites" checked> Suggested sensor sites</label>`;
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      div.addEventListener('change', (e) => {
        const name = e.target.dataset.layer;
        if (name) this.setLayer(name, e.target.checked);
      });
      return div;
    };
    ctl.addTo(this.map);
    this.layerBox = ctl.getContainer();
  }

  addLegend() {
    const ctl = L.control({ position: 'bottomleft' });
    ctl.onAdd = () => {
      const div = L.DomUtil.create('div', 'map-box legend');
      div.innerHTML = `
        <div class="legend-head">
          <div class="mode" role="group" aria-label="Scenario">
            <button type="button" data-mode="heavy" class="on">In a heavy storm</button>
            <button type="button" data-mode="now">Right now</button>
          </div>
        </div>
        <p class="legend-caption" data-caption>Shaded areas are where water collects first when it rains hard.</p>
        <div class="ramp"></div>
        <div class="ramp-labels"><span>Low</span><span>Moderate</span><span>High</span><span>Severe</span></div>
        <div class="legend-keys">
          <span><i class="key-dot" style="--c:${COLORS.low}"></i>Sensor, normal</span>
          <span><i class="key-dot" style="--c:${COLORS.severe}"></i>Sensor, flooding</span>
          <span><i class="key-tri">${REPORT_SVG}</i>Report</span>
          <span><i class="key-site">1</i>Suggested site</span>
        </div>`;
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      div.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-mode]');
        if (!btn) return;
        this.setRiskMode(btn.dataset.mode);
        if (this.onRiskMode) this.onRiskMode(btn.dataset.mode);
      });
      return div;
    };
    ctl.addTo(this.map);
    this.legend = ctl.getContainer();
  }

  setRiskMode(mode) {
    this.legend.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    this.legend.querySelector('[data-caption]').textContent = mode === 'heavy'
      ? 'Shaded areas are where water collects first when it rains hard.'
      : 'Shading reflects the current forecast plus live sensor readings and reports.';
  }

  setLayer(name, on) {
    this.layers[name] = on;
    const box = this.layerBox.querySelector(`[data-layer="${name}"]`);
    if (box) box.checked = on;
    if (name === 'risk' && this.riskOverlay) {
      if (on) this.riskOverlay.addTo(this.map); else this.riskOverlay.remove();
    }
    if (name === 'fema') {
      if (on) {
        if (!this.femaLayer) {
          this.femaLayer = femaTileLayer();
          this.femaLayer.options.pane = 'fema';
        }
        this.femaLayer.addTo(this.map);
      } else if (this.femaLayer) {
        this.femaLayer.remove();
      }
    }
    if (name === 'reports') {
      if (on) this.reportGroup.addTo(this.map); else this.reportGroup.remove();
    }
    if (name === 'sites') {
      if (on) this.siteGroup.addTo(this.map); else this.siteGroup.remove();
    }
  }

  setRiskImage(url, bounds) {
    if (!url) {
      if (this.riskOverlay) {
        this.riskOverlay.remove();
        this.riskOverlay = null;
      }
      return;
    }
    if (this.riskOverlay) {
      this.riskOverlay.setUrl(url);
      this.riskOverlay.setBounds(L.latLngBounds(bounds));
    } else {
      this.riskOverlay = L.imageOverlay(url, bounds, { pane: 'risk', interactive: false, className: 'risk-overlay' });
      if (this.layers.risk) this.riskOverlay.addTo(this.map);
    }
  }

  setSensors(sensors, evals, selectedId) {
    const keep = new Set();
    for (const s of sensors) {
      if (s.lat == null || s.lng == null) continue;
      keep.add(s.id);
      const ev = evals.get(s.id);
      const key = ev ? ev.key : 'nodata';
      const fill = ev && ev.water != null ? Math.round(Math.min(100, (ev.water / s.alert_depth_cm) * 100)) : 0;
      const selected = s.id === selectedId;
      const iconKey = `${key}|${fill}|${selected}`;
      let marker = this.sensorMarkers.get(s.id);
      if (!marker) {
        marker = L.marker([s.lat, s.lng], { icon: gaugeIcon(key, fill, selected), riseOnHover: true, title: s.name }).addTo(this.map);
        marker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          this.onSelect(s.id);
        });
        this.sensorMarkers.set(s.id, marker);
      } else if (this.sensorIconKey.get(s.id) !== iconKey) {
        marker.setIcon(gaugeIcon(key, fill, selected));
      }
      this.sensorIconKey.set(s.id, iconKey);
      marker.setLatLng([s.lat, s.lng]);
      marker.setZIndexOffset(selected ? 1000 : 0);
      const tip = `${escapeHtml(s.name)}: ${STATUS[key].label}${ev && ev.water != null && key !== 'offline' ? `, ${fmtIn(ev.water)}` : ''}`;
      if (!marker.getTooltip()) marker.bindTooltip(tip, { direction: 'top', offset: [0, -14] });
      else marker.setTooltipContent(tip);
    }
    for (const [id, marker] of this.sensorMarkers) {
      if (!keep.has(id)) {
        marker.remove();
        this.sensorMarkers.delete(id);
        this.sensorIconKey.delete(id);
      }
    }
  }

  setReports(reports) {
    const keep = new Set();
    for (const r of reports) {
      keep.add(r.id);
      if (this.reportMarkers.has(r.id)) continue;
      const marker = L.marker([r.lat, r.lng], { icon: REPORT_ICON, keyboard: false }).addTo(this.reportGroup);
      marker.bindPopup(() => this.popupContent(r), { className: 'report-popup', maxWidth: 260 });
      marker.on('click', (e) => L.DomEvent.stopPropagation(e));
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
    if (!this.layers.reports) this.setLayer('reports', true);
    this.map.panTo(marker.getLatLng());
    marker.openPopup();
  }

  closePopups() {
    this.map.closePopup();
  }

  setSites(sites) {
    this.siteGroup.clearLayers();
    sites.forEach((site, k) => {
      const m = L.marker([site.lat, site.lng], { icon: siteIcon(k + 1), keyboard: false, title: `Suggested site ${k + 1}` });
      m.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        if (this.onSiteSelect) this.onSiteSelect(k);
      });
      m.addTo(this.siteGroup);
    });
  }

  setPin(latlng, draggable, onDrag) {
    if (!this.pin) {
      this.pin = L.marker(latlng, { icon: PIN_ICON, draggable, autoPan: true, zIndexOffset: 2000 }).addTo(this.map);
    } else {
      this.pin.setLatLng(latlng);
      if (draggable) this.pin.dragging.enable(); else this.pin.dragging.disable();
    }
    this.pin.off('dragend');
    if (onDrag) this.pin.on('dragend', (e) => onDrag(e.target.getLatLng()));
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

  goTo(latlng, zoom) {
    this.map.setView(latlng, zoom ?? this.map.getZoom());
  }

  fitBounds(bounds, maxZoom = 16) {
    this.map.fitBounds(L.latLngBounds(bounds), { padding: [40, 40], maxZoom });
  }

  panTo(latlng) {
    this.map.panTo(latlng);
  }

  resize() {
    this.map.invalidateSize();
  }
}

export function reportAge(r) {
  return fmtAge((Date.now() - Date.parse(r.created_at)) / 1000);
}

export { REPORT_KINDS };
