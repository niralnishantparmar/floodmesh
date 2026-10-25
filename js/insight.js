import { loadTerrain, loadWeather, loadRoads, rasterizeRoads } from './sources.js';
import {
  buildTerrainModel, liveRisk, weatherFactor, colorize, recommendSites, riskLevel, quantile, percentRank,
  SQM_PER_ACRE, FT_PER_M,
} from './risk.js';

// Owns everything behind the risk heatmap. Each source loads on its own, and the
// app gets a callback whenever something new is ready.
export class RiskEngine {
  constructor({ bounds, center, onUpdate }) {
    this.bounds = bounds;
    this.center = center;
    this.onUpdate = onUpdate;
    this.terrainStatus = 'loading';
    this.grid = null;
    this.model = null;
    this.weather = null;
    this.roads = null;
    this.roadHit = null;
    this.mode = 'heavy';
    this.replayRain = null;
    this.obsCells = [];
    this.obsKey = '';
    this.lastKey = '';
    this.liveNow = null;
    this.canvas = null;
  }

  async init() {
    try {
      const { grid, elev } = await loadTerrain(this.bounds);
      this.grid = grid;
      this.model = buildTerrainModel(elev, grid.w, grid.h, grid.cellM);
      this.terrainStatus = 'ready';
    } catch (err) {
      console.warn('Elevation data unavailable', err);
      this.terrainStatus = 'failed';
    }
    this.onUpdate('terrain');
    this.refreshWeather();
    if (this.grid) this.loadRoadData();
  }

  async refreshWeather() {
    try {
      this.weather = await loadWeather(this.center[0], this.center[1]);
    } catch (err) {
      console.warn('Weather unavailable', err);
      this.weather = { error: true };
    }
    this.lastKey = '';
    this.onUpdate('weather');
  }

  async loadRoadData() {
    try {
      this.roads = await loadRoads(this.grid.bounds);
      this.roadHit = rasterizeRoads(this.roads, this.grid);
    } catch (err) {
      console.warn('Road data unavailable; sensor sites will not be limited to roads', err);
    }
    this.onUpdate('roads');
  }

  get ready() {
    return this.model !== null;
  }

  // Rain intensity in inches per hour that drives the "right now" view.
  rainNow() {
    if (this.replayRain != null) return this.replayRain;
    const w = this.weather;
    if (!w || w.error || w.rain6In == null) return 0;
    return w.rain6In / 6;
  }

  setMode(mode) {
    this.mode = mode;
    this.lastKey = '';
  }

  // points: [{ lat, lng, strength }]
  setObservations(points) {
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

  // Returns a new heatmap image only when something visible changed.
  render() {
    if (!this.model) return null;
    const factor = this.mode === 'heavy' ? 1 : this.nowFactor();
    const key = `${this.mode}|${(Math.round(factor * 50) / 50).toFixed(2)}|${this.obsKey}`;
    if (key === this.lastKey) return null;
    this.lastKey = key;
    const values = this.mode === 'heavy' ? liveRisk(this.model, 1, this.obsCells) : this.getLiveNow();
    const { w, h } = this.model;
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const ctx = this.canvas.getContext('2d');
    ctx.putImageData(new ImageData(colorize(values), w, h), 0, 0);
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

  // Ranked places that most need a sensor, skipping areas existing sensors already cover.
  sites(existingSensors) {
    if (!this.model) return [];
    const mask = this.roadMask();
    const existing = existingSensors
      .map((s) => (s.lat != null ? this.grid.toCell(s.lat, s.lng) : null))
      .filter(Boolean);
    return recommendSites(this.model, { mask, existing, count: 5 }).map((p) => {
      const [lat, lng] = this.grid.toLatLng(p.i, p.j);
      return { lat, lng, i: p.i, j: p.j, score: p.score, road: this.roadNameAt(p.i, p.j), ...this.analyze(lat, lng) };
    });
  }

  analyze(lat, lng) {
    if (!this.model) return null;
    const c = this.grid.toCell(lat, lng);
    if (!c) return { outside: true };
    const m = this.model;
    const k = c.j * m.w + c.i;
    const live = this.getLiveNow();
    const heavy = liveRisk(m, 1, this.obsCells.filter((o) => Math.abs(o.i - c.i) < 40 && Math.abs(o.j - c.j) < 40));
    const mask = this.roadMask();
    return {
      outside: false,
      elevFt: m.elev[k] * FT_PER_M,
      localFt: -m.tpiLocal[k] * FT_PER_M,
      broadFt: -m.tpiBroad[k] * FT_PER_M,
      localRadiusFt: m.rLocalM * FT_PER_M,
      broadRadiusFt: m.rBroadM * FT_PER_M,
      acres: (m.acc[k] * m.cellM * m.cellM) / SQM_PER_ACRE,
      pondFt: m.pond[k] * FT_PER_M,
      terrain: m.score[k],
      rank: percentRank(m.rank, k, mask && mask[k] ? mask : null),
      rankAgainstRoads: Boolean(mask && mask[k]),
      now: live[k],
      heavy: heavy[k],
      levelNow: riskLevel(live[k]),
      levelHeavy: riskLevel(heavy[k]),
    };
  }

  // One risk level for the whole area: the value 98% of road spots stay under.
  areaLevel() {
    const live = this.getLiveNow();
    if (!live) return null;
    const v = quantile(live, 0.98, this.roadMask());
    return { value: v, level: riskLevel(v) };
  }
}
