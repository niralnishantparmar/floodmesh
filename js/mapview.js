import { STATUS, REPORT_KINDS, escapeHtml, fmtAge, fmtIn } from './logic.js';
import { CARTO_KEY } from './config.js';
import { femaTileLayer } from './sources.js';

const REPORT_SVG = `<svg viewBox="0 0 24 22" width="24" height="22" aria-hidden="true">
    <path d="M12 1.5 23 20.5H1z" fill="#e08a00" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M12 8v6" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>
    <circle cx="12" cy="17.2" r="1.3" fill="#fff"/></svg>`;

const REPORT_ICON = L.divIcon({
  className: 'report-icon',
  html: REPORT_SVG,
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

function gaugeIcon(color, fillPct, selected) {
  const size = selected ? 40 : 30;
  return L.divIcon({
    className: 'gauge-wrap',
    html: `<div class="gauge${selected ? ' selected' : ''}" style="--c:${color};--fill:${fillPct}%"><span class="gauge-water"></span></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function siteIcon(rank) {
  return L.divIcon({
    className: 'site-wrap',
    html: `<div class="site-marker"><span>${rank}</span></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function reportPopup(r) {
  const age = fmtAge((Date.now() - Date.parse(r.created_at)) / 1000);
  const note = r.note ? `<p>${escapeHtml(r.note)}</p>` : '';
  return `<div class="report-popup"><strong>${escapeHtml(REPORT_KINDS[r.kind] || 'Report')}</strong>${note}<span>Reported ${age}. Unverified community report.</span></div>`;
}

export class MapView {
  constructor(elementId, { center, zoom, onSelect, onMapClick, onSiteSelect, onRiskMode }) {
    this.onSelect = onSelect;
    this.onSiteSelect = onSiteSelect;
    this.onRiskMode = onRiskMode;
    this.map = L.map(elementId, { zoomControl: false }).setView(center, zoom);
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);

    const osmCredit = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
    if (CARTO_KEY) {
      L.tileLayer(`https://basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png?key=${encodeURIComponent(CARTO_KEY)}`, {
        maxZoom: 20,
        attribution: `${osmCredit} &copy; <a href="https://carto.com/attributions">CARTO</a>`,
      }).addTo(this.map);
    } else {
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, className: 'tiles-muted', attribution: osmCredit }).addTo(this.map);
    }

    this.map.createPane('fema');
    this.map.getPane('fema').style.zIndex = 340;
    this.map.createPane('risk');
    this.map.getPane('risk').style.zIndex = 350;
    this.map.getPane('risk').style.pointerEvents = 'none';

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
    this.addLayerControl();
    this.addLegend();
  }

  // Controls -------------------------------------------------------------

  addLayerControl() {
    const ctl = L.control({ position: 'topright' });
    ctl.onAdd = () => {
      const div = L.DomUtil.create('div', 'map-card layer-card');
      div.innerHTML = `
        <h3>Map layers</h3>
        <label><input type="checkbox" data-layer="risk" checked> Flood risk</label>
        <label><input type="checkbox" data-layer="fema"> FEMA flood zones</label>
        <label><input type="checkbox" data-layer="reports" checked> Community reports</label>
        <label><input type="checkbox" data-layer="sites" checked> Recommended sensor sites</label>`;
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      div.addEventListener('change', (e) => {
        const name = e.target.dataset.layer;
        if (name) this.setLayer(name, e.target.checked);
      });
      return div;
    };
    ctl.addTo(this.map);
    this.layerCard = ctl.getContainer();
  }

  addLegend() {
    const ctl = L.control({ position: 'bottomleft' });
    ctl.onAdd = () => {
      const div = L.DomUtil.create('div', 'map-card legend');
      const statuses = ['normal', 'rising', 'warning', 'flooding', 'offline']
        .map((k) => `<li><span class="dot" style="--c:${STATUS[k].color}"></span>${STATUS[k].label}</li>`).join('');
      div.innerHTML = `
        <button class="legend-toggle" data-legend-toggle aria-expanded="true">Legend</button>
        <div class="legend-body">
          <div class="legend-block" data-risk-legend>
            <h3>Flood risk</h3>
            <div class="mode-switch" role="group" aria-label="Risk scenario">
              <button data-mode="now">Right now</button>
              <button data-mode="heavy" class="active">During heavy rain</button>
            </div>
            <p class="legend-caption" data-caption>Where water collects first in a heavy storm, from elevation and drainage.</p>
            <div class="ramp"></div>
            <div class="ramp-labels"><span>Low</span><span>Moderate</span><span>High</span><span>Severe</span></div>
            <p class="legend-status" hidden></p>
          </div>
          <div class="legend-block">
            <h3>Sensors</h3>
            <ul class="legend-list">${statuses}</ul>
            <p class="legend-note">Blue fill shows how close the water is to the flooding line.</p>
          </div>
          <div class="legend-block legend-extra">
            <div class="legend-row"><span class="legend-sym">${REPORT_SVG}</span>Community report</div>
            <div class="legend-row"><span class="legend-sym"><span class="site-marker small"><span>1</span></span></span>Recommended sensor site</div>
            <div class="legend-row fema-key" hidden><span class="legend-sym swatch"></span>FEMA flood zone</div>
          </div>
        </div>`;
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      div.addEventListener('click', (e) => {
        const mode = e.target.closest('[data-mode]');
        if (mode) {
          this.setRiskMode(mode.dataset.mode);
          if (this.onRiskMode) this.onRiskMode(mode.dataset.mode);
        }
        const toggle = e.target.closest('[data-legend-toggle]');
        if (toggle) {
          const collapsed = div.classList.toggle('collapsed');
          toggle.setAttribute('aria-expanded', String(!collapsed));
        }
      });
      if (window.matchMedia && window.matchMedia('(max-width: 820px)').matches) div.classList.add('collapsed');
      return div;
    };
    ctl.addTo(this.map);
    this.legend = ctl.getContainer();
  }

  setLayer(name, on) {
    this.layers[name] = on;
    const box = this.layerCard.querySelector(`[data-layer="${name}"]`);
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
      this.legend.querySelector('.fema-key').hidden = !on;
    }
    if (name === 'reports') {
      if (on) this.reportGroup.addTo(this.map); else this.reportGroup.remove();
    }
    if (name === 'sites') {
      if (on) this.siteGroup.addTo(this.map); else this.siteGroup.remove();
    }
  }

  setRiskMode(mode) {
    this.legend.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    this.legend.querySelector('[data-caption]').textContent = mode === 'heavy'
      ? 'Where water collects first in a heavy storm, from elevation and drainage.'
      : 'Current conditions: terrain scaled by the rain forecast, plus live sensor readings and reports.';
  }

  // Risk heatmap ---------------------------------------------------------

  setRiskImage(dataUrl, bounds) {
    if (!this.riskOverlay) {
      this.riskOverlay = L.imageOverlay(dataUrl, bounds, { pane: 'risk', interactive: false, className: 'risk-overlay' });
      if (this.layers.risk) this.riskOverlay.addTo(this.map);
    } else {
      this.riskOverlay.setUrl(dataUrl);
    }
  }

  setRiskStatus(text) {
    const note = this.legend.querySelector('.legend-status');
    note.textContent = text || '';
    note.hidden = !text;
  }

  // Sensors --------------------------------------------------------------

  setSensors(sensors, evals, selectedId) {
    const keep = new Set();
    for (const s of sensors) {
      if (s.lat == null || s.lng == null) continue;
      keep.add(s.id);
      const ev = evals.get(s.id);
      const key = ev ? ev.key : 'nodata';
      const color = STATUS[key].color;
      const fill = ev && ev.water != null ? Math.round(Math.min(100, (ev.water / s.alert_depth_cm) * 100)) : 0;
      const selected = s.id === selectedId;
      const iconKey = `${color}|${fill}|${selected}`;
      let marker = this.sensorMarkers.get(s.id);
      if (!marker) {
        marker = L.marker([s.lat, s.lng], { icon: gaugeIcon(color, fill, selected), riseOnHover: true, title: s.name }).addTo(this.map);
        marker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          this.onSelect(s.id);
        });
        this.sensorMarkers.set(s.id, marker);
        this.sensorIconKey.set(s.id, iconKey);
      } else if (this.sensorIconKey.get(s.id) !== iconKey) {
        marker.setIcon(gaugeIcon(color, fill, selected));
        this.sensorIconKey.set(s.id, iconKey);
      }
      marker.setLatLng([s.lat, s.lng]);
      marker.setZIndexOffset(selected ? 1000 : 0);
      const depth = ev && ev.water != null ? `, ${fmtIn(ev.water)}` : '';
      const tip = `${escapeHtml(s.name)}: ${STATUS[key].label}${depth}`;
      if (!marker.getTooltip()) marker.bindTooltip(tip, { direction: 'top', offset: [0, -16] });
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

  // Reports and sites ----------------------------------------------------

  setReports(reports) {
    const keep = new Set();
    for (const r of reports) {
      keep.add(r.id);
      if (this.reportMarkers.has(r.id)) continue;
      const marker = L.marker([r.lat, r.lng], { icon: REPORT_ICON, keyboard: false }).addTo(this.reportGroup);
      marker.bindPopup(() => reportPopup(r));
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

  setSites(sites) {
    this.siteGroup.clearLayers();
    sites.forEach((site, k) => {
      const m = L.marker([site.lat, site.lng], { icon: siteIcon(k + 1), keyboard: false, title: `Recommended site ${k + 1}` });
      m.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        if (this.onSiteSelect) this.onSiteSelect(k);
      });
      m.bindTooltip(`Recommended site ${k + 1}${site.road ? `: ${escapeHtml(site.road)}` : ''}`, { direction: 'top', offset: [0, -14] });
      m.addTo(this.siteGroup);
    });
  }

  // Pins -----------------------------------------------------------------

  setPin(latlng, draggable) {
    if (this.pin) {
      this.pin.setLatLng(latlng);
      if (this.pin.dragging) {
        if (draggable) this.pin.dragging.enable(); else this.pin.dragging.disable();
      }
    } else {
      this.pin = L.marker(latlng, { icon: PIN_ICON, draggable, autoPan: true, zIndexOffset: 2000 }).addTo(this.map);
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

  focus(latlng, zoom) {
    if (zoom) this.map.setView(latlng, zoom);
    else this.map.panTo(latlng);
  }

  fit(points) {
    if (!points.length) return;
    this.map.fitBounds(L.latLngBounds(points), { padding: [90, 90], maxZoom: 16 });
  }

  resize() {
    this.map.invalidateSize();
  }
}
