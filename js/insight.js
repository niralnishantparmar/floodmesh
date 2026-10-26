import { loadTerrain, loadWeather, loadAlerts, loadRoads, rasterizeRoads, cellSizeM } from './sources.js';
import {
  buildTerrainModel, liveRisk, weatherFactor, colorize, recommendSites, riskLevel, quantile, percentRank,
  SQM_PER_ACRE, FT_PER_M,
} from './risk.js';
import { MIN_RISK_ZOOM } from './config.js';

const MAX_CELLS_ACROSS = 520;
const WEATHER_REFRESH_MS = 15 * 60000;
const WEATHER_MOVE_KM = 15;

function padBounds(b, frac) {
  const dLat = (b.north - b.south) * frac;
  const dLng = (b.east - b.west) * frac;
  return { south: b.south - dLat, north: b.north + dLat, west: b.west - dLng, east: b.east + dLng };
}

function contains(outer, inner) {
  return outer.south <= inner.south && outer.north >= inner.north && outer.west <= inner.west && outer.east >= inner.east;
}

function widthM(b) {
  const lat = (b.north + b.south) / 2;
  return (b.east - b.west) * 111320 * Math.cos((lat * Math.PI) / 180);
}

function km(a, b) {
  const dLat = (a[0] - b[0]) * 111.32;
  const dLng = (a[1] - b[1]) * 111.32 * Math.cos((a[0] * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

export function terrainZoomFor(b) {
  const lat = (b.north + b.south) / 2;
  const span = widthM(b);
  for (let z = 14; z >= 10; z -= 1) {
    if (span / cellSizeM(lat, z, 2) <= MAX_CELLS_ACROSS) return z;
  }
  return 10;
}

export class RiskEngine {
  constructor({ onUpdate }) {
    this.onUpdate = onUpdate;
    this.status = 'idle';
    this.grid = null;
    this.model = null;
    this.region = null;
    this.weather = null;
    this.weatherAt = null;
    this.alerts = [];
    this.roads = null;
    this.roadHit = null;
    this.mode = 'heavy';
    this.replayRain = null;
    this.obsPoints = [];
    this.obsCells = [];
    this.obsKey = '';
    this.lastKey = '';
    this.liveNow = null;
    this.liveNowKey = '';
    this.token = 0;
    this.canvas = null;
  }

  get ready() {
    return this.status === 'ready' && this.model !== null;
  }

  get resolutionFt() {
    return this.model ? this.model.cellM * FT_PER_M : null;
  }

  async analyzeView(view, zoom) {
    this.maybeRefreshWeather([(view.north + view.south) / 2, (view.east + view.west) / 2]);
    if (zoom < MIN_RISK_ZOOM) {
      this.token += 1;
      this.status = 'zoom';
      this.onUpdate('status');
      return;
    }
    const padded = padBounds(view, 0.3);
    const tz = terrainZoomFor(padded);
    if (this.ready && this.region && this.region.tz === tz && contains(this.region.bounds, view)) return;
    this.token += 1;
    const token = this.token;
    this.status = 'loading';
    this.onUpdate('status');
    try {
      const { grid, elev } = await loadTerrain([[padded.south, padded.west], [padded.north, padded.east]], { zoom: tz, factor: 2 });
      if (token !== this.token) return;
      const model = buildTerrainModel(elev, grid.w, grid.h, grid.cellM);
      if (token !== this.token) return;
      this.grid = grid;
      this.model = model;
      this.region = { bounds: padded, tz };
      this.roads = null;
      this.roadHit = null;
      this.canvas = null;
      this.status = 'ready';
      this.lastKey = '';
      this.liveNow = null;
      this.setObservations(this.obsPoints);
      this.onUpdate('terrain');
      if (tz >= 13 && widthM(padded) < 9000) this.loadRoadData(token);
    } catch (err) {
      if (token !== this.token) return;
      console.warn('Elevation data unavailable', err);
      this.status = 'failed';
      this.onUpdate('status');
    }
  }

  async loadRoadData(token) {
    try {
      const roads = await loadRoads(this.grid.bounds);
      if (token !== this.token) return;
      this.roads = roads;
      this.roadHit = rasterizeRoads(roads, this.grid);
      this.onUpdate('roads');
    } catch (err) {
      console.warn('Road data unavailable', err);
    }
  }

  maybeRefreshWeather(center) {
    const stale = !this.weatherAt || Date.now() - this.weatherAt.time > WEATHER_REFRESH_MS;
    const moved = !this.weatherAt || km(center, this.weatherAt.center) > WEATHER_MOVE_KM;
    if (!stale && !moved) return;
    this.weatherAt = { center, time: Date.now() };
    this.refreshWeather(center);
  }

  async refreshWeather(center) {
    const [weather, alerts] = await Promise.allSettled([loadWeather(center[0], center[1]), loadAlerts(center[0], center[1])]);
    this.weather = weather.status === 'fulfilled' ? weather.value : { error: true };
    this.alerts = alerts.status === 'fulfilled' ? alerts.value : [];
    this.lastKey = '';
    this.liveNow = null;
    this.onUpdate('weather');
  }

  rainNow() {
    if (this.replayRain != null) return this.replayRain;
    const w = this.weather;
    if (!w || w.error) return 0;
    return w.rain6In / 6;
  }

  setMode(mode) {
    this.mode = mode;
    this.lastKey = '';
  }

  setObservations(points) {
    this.obsPoints = points;
    if (!this.grid) return;
    const cells = [];
    for (const p of points) {
      const c = this.grid.toCell(p.lat, p.lng);
      if (c) cells.push({ i: c.i, j: c.j, strength: p.strength });
    }
    const key = cells.map((c) => `${c.i},${c.j},${c.strength.toFixed(2)}`).join(';');
    if (key !== this.obsKey) {
      this.obsKey = key;
      this.obsCells = cells;
      this.liveNow = null;
    }
  }

  nowFactor() {
    return weatherFactor(this.rainNow());
  }

  getLiveNow() {
    if (!this.model) return null;
    const key = `${this.nowFactor().toFixed(3)}|${this.obsKey}`;
    if (!this.liveNow || this.liveNowKey !== key) {
      this.liveNow = liveRisk(this.model, this.nowFactor(), this.obsCells);
      this.liveNowKey = key;
    }
    return this.liveNow;
  }

  render() {
    if (!this.ready) return null;
    const factor = this.mode === 'heavy' ? 1 : this.nowFactor();
    const key = `${this.token}|${this.mode}|${(Math.round(factor * 50) / 50).toFixed(2)}|${this.obsKey}`;
    if (key === this.lastKey) return null;
    this.lastKey = key;
    const values = this.mode === 'heavy' ? liveRisk(this.model, 1, this.obsCells) : this.getLiveNow();
    const { w, h } = this.model;
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.canvas.getContext('2d').putImageData(new ImageData(colorize(values), w, h), 0, 0);
    return { url: this.canvas.toDataURL('image/png'), bounds: this.grid.bounds };
  }

  roadMask() {
    if (!this.roadHit) return null;
    const mask = new Uint8Array(this.roadHit.length);
    for (let i = 0; i < mask.length; i += 1) mask[i] = this.roadHit[i] >= 0 ? 1 : 0;
    return mask;
  }

  roadNameAt(i, j) {
    if (!this.roadHit || !this.roads) return '';
    const { w, h } = this.grid;
    for (let r = 0; r <= 2; r += 1) {
      for (let dy = -r; dy <= r; dy += 1) {
        for (let dx = -r; dx <= r; dx += 1) {
          const x = i + dx;
          const y = j + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const k = this.roadHit[y * w + x];
          if (k >= 0 && this.roads[k].name) return this.roads[k].name;
        }
      }
    }
    return '';
  }

  viewMask(view) {
    const { w, h } = this.grid;
    const a = this.grid.toCell(Math.min(view.north, this.grid.bounds[1][0] - 1e-9), Math.max(view.west, this.grid.bounds[0][1] + 1e-9)) || { i: 0, j: 0 };
    const b = this.grid.toCell(Math.max(view.south, this.grid.bounds[0][0] + 1e-9), Math.min(view.east, this.grid.bounds[1][1] - 1e-9)) || { i: w - 1, j: h - 1 };
    const roads = this.roadMask();
    const mask = new Uint8Array(w * h);
    for (let j = a.j; j <= b.j; j += 1) {
      for (let i = a.i; i <= b.i; i += 1) {
        const k = j * w + i;
        mask[k] = roads ? roads[k] : 1;
      }
    }
    return mask;
  }

  sites(view, existingSensors) {
    if (!this.ready) return [];
    const existing = existingSensors
      .map((s) => (s.lat != null ? this.grid.toCell(s.lat, s.lng) : null))
      .filter(Boolean);
    return recommendSites(this.model, { mask: this.viewMask(view), existing, count: 5 })
      .map((p) => {
        const [lat, lng] = this.grid.toLatLng(p.i, p.j);
        return { lat, lng, score: p.score, road: this.roadNameAt(p.i, p.j) };
      })
      .map((s) => ({ ...s, ...this.analyze(s.lat, s.lng) }));
  }

  analyze(lat, lng) {
    if (!this.ready) return null;
    const c = this.grid.toCell(lat, lng);
    if (!c) return { outside: true };
    const m = this.model;
    const k = c.j * m.w + c.i;
    const live = this.getLiveNow();
    const near = this.obsCells.filter((o) => Math.abs(o.i - c.i) < 40 && Math.abs(o.j - c.j) < 40);
    const heavy = liveRisk(m, 1, near);
    const mask = this.roadMask();
    const onRoad = Boolean(mask && mask[k]);
    return {
      outside: false,
      elevFt: m.elev[k] * FT_PER_M,
      localFt: -m.tpiLocal[k] * FT_PER_M,
      broadFt: -m.tpiBroad[k] * FT_PER_M,
      localRadiusFt: m.rLocalM * FT_PER_M,
      broadRadiusFt: m.rBroadM * FT_PER_M,
      acres: (m.acc[k] * m.cellM * m.cellM) / SQM_PER_ACRE,
      pondFt: m.pond[k] * FT_PER_M,
      rank: percentRank(m.rank, k, onRoad ? mask : null),
      rankAgainstRoads: onRoad,
      now: live[k],
      heavy: heavy[k],
      levelNow: riskLevel(live[k]),
      levelHeavy: riskLevel(heavy[k]),
      resolutionFt: m.cellM * FT_PER_M,
    };
  }

  areaLevel(view) {
    const live = this.getLiveNow();
    if (!live || !this.grid) return null;
    const a = this.grid.toCell(view.north, view.west) || { i: 0, j: 0 };
    const b = this.grid.toCell(view.south, view.east) || { i: this.grid.w - 1, j: this.grid.h - 1 };
    const inView = new Uint8Array(live.length);
    const roads = this.roadMask();
    for (let j = Math.max(0, a.j); j <= Math.min(this.grid.h - 1, b.j); j += 1) {
      for (let i = Math.max(0, a.i); i <= Math.min(this.grid.w - 1, b.i); i += 1) {
        const k = j * this.grid.w + i;
        inView[k] = roads ? roads[k] : 1;
      }
    }
    const v = quantile(live, 0.98, inView);
    return { value: v, level: riskLevel(v) };
  }
}
