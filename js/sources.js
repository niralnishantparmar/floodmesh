
const TILE = 256;
const EARTH_M = 40075016.686;

async function fetchWithTimeout(url, options = {}, ms = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

const lngToPx = (lng, z) => ((lng + 180) / 360) * TILE * 2 ** z;
const latToPx = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z;
};
const pxToLng = (px, z) => (px / (TILE * 2 ** z)) * 360 - 180;
const pxToLat = (py, z) => {
  const n = Math.PI * (1 - (2 * py) / (TILE * 2 ** z));
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
};

export function makeGrid(bounds, zoom, factor) {
  const [[south, west], [north, east]] = bounds;
  const originPx = Math.floor(lngToPx(west, zoom));
  const originPy = Math.floor(latToPx(north, zoom));
  const w = Math.floor((Math.ceil(lngToPx(east, zoom)) - originPx) / factor);
  const h = Math.floor((Math.ceil(latToPx(south, zoom)) - originPy) / factor);
  const latMid = (north + south) / 2;
  const cellM = ((EARTH_M * Math.cos((latMid * Math.PI) / 180)) / (TILE * 2 ** zoom)) * factor;
  return {
    zoom, factor, originPx, originPy, w, h, cellM,
    bounds: [
      [pxToLat(originPy + h * factor, zoom), pxToLng(originPx, zoom)],
      [pxToLat(originPy, zoom), pxToLng(originPx + w * factor, zoom)],
    ],
    toCell(lat, lng) {
      const i = Math.floor((lngToPx(lng, zoom) - originPx) / factor);
      const j = Math.floor((latToPx(lat, zoom) - originPy) / factor);
      return i >= 0 && j >= 0 && i < w && j < h ? { i, j } : null;
    },
    toLatLng(i, j) {
      return [pxToLat(originPy + (j + 0.5) * factor, zoom), pxToLng(originPx + (i + 0.5) * factor, zoom)];
    },
  };
}

const terrainUrl = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${url}`));
    img.src = url;
  });
}

export async function loadTerrain(bounds, { zoom = 14, factor = 2 } = {}) {
  const grid = makeGrid(bounds, zoom, factor);
  const tx0 = Math.floor(grid.originPx / TILE);
  const ty0 = Math.floor(grid.originPy / TILE);
  const tx1 = Math.floor((grid.originPx + grid.w * factor - 1) / TILE);
  const ty1 = Math.floor((grid.originPy + grid.h * factor - 1) / TILE);
  const mw = (tx1 - tx0 + 1) * TILE;
  const mh = (ty1 - ty0 + 1) * TILE;
  const canvas = document.createElement('canvas');
  canvas.width = mw;
  canvas.height = mh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty += 1) {
    for (let tx = tx0; tx <= tx1; tx += 1) {
      jobs.push(loadImage(terrainUrl(zoom, tx, ty)).then((img) => ctx.drawImage(img, (tx - tx0) * TILE, (ty - ty0) * TILE)));
    }
  }
  await Promise.all(jobs);
  const data = ctx.getImageData(0, 0, mw, mh).data;
  const offX = grid.originPx - tx0 * TILE;
  const offY = grid.originPy - ty0 * TILE;
  const elev = new Float32Array(grid.w * grid.h);
  for (let j = 0; j < grid.h; j += 1) {
    for (let i = 0; i < grid.w; i += 1) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy += 1) {
        for (let dx = 0; dx < factor; dx += 1) {
          const k = ((offY + j * factor + dy) * mw + (offX + i * factor + dx)) * 4;
          sum += data[k] * 256 + data[k + 1] + data[k + 2] / 256 - 32768;
        }
      }
      elev[j * grid.w + i] = sum / (factor * factor);
    }
  }
  return { grid, elev };
}

const NWS = 'https://api.weather.gov';
const nwsHeaders = { Accept: 'application/geo+json' };

export function sumPrecip(values, hours, now = Date.now()) {
  const end = now + hours * 3600e3;
  let mm = 0;
  for (const v of values || []) {
    if (v.value == null) continue;
    const [startIso, dur] = v.validTime.split('/');
    const start = Date.parse(startIso);
    const m = /P(?:(\d+)D)?T?(?:(\d+)H)?/.exec(dur);
    const days = Number(m && m[1]) || 0;
    const hrs = Number(m && m[2]) || 0;
    const span = (days * 24 + hrs) * 3600e3 || 3600e3;
    const overlap = Math.max(0, Math.min(end, start + span) - Math.max(now, start));
    mm += v.value * (overlap / span);
  }
  return mm;
}

export async function loadWeather(lat, lng) {
  const at = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const point = await (await fetchWithTimeout(`${NWS}/points/${at}`, { headers: nwsHeaders })).json();
  const props = point.properties;
  const [hourly, grid, alerts] = await Promise.allSettled([
    fetchWithTimeout(props.forecastHourly, { headers: nwsHeaders }).then((r) => r.json()),
    fetchWithTimeout(props.forecastGridData, { headers: nwsHeaders }).then((r) => r.json()),
    fetchWithTimeout(`${NWS}/alerts/active?point=${at}`, { headers: nwsHeaders }).then((r) => r.json()),
  ]);
  const out = { summary: null, tempF: null, rainChance: null, rain6In: null, rain24In: null, alerts: [], updated: Date.now() };
  if (hourly.status === 'fulfilled') {
    const periods = hourly.value.properties?.periods || [];
    const now = periods[0];
    if (now) {
      out.summary = now.shortForecast;
      out.tempF = now.temperatureUnit === 'C' ? Math.round((now.temperature * 9) / 5 + 32) : now.temperature;
    }
    const chances = periods.slice(0, 6).map((p) => p.probabilityOfPrecipitation?.value ?? 0);
    out.rainChance = chances.length ? Math.max(...chances) : null;
  }
  if (grid.status === 'fulfilled') {
    const qpf = grid.value.properties?.quantitativePrecipitation?.values;
    if (qpf) {
      out.rain6In = sumPrecip(qpf, 6) / 25.4;
      out.rain24In = sumPrecip(qpf, 24) / 25.4;
    }
  }
  if (alerts.status === 'fulfilled') {
    out.alerts = (alerts.value.features || []).map((f) => ({ event: f.properties.event, headline: f.properties.headline }));
  }
  return out;
}

export async function loadHourlyRain(lat, lng) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}`
    + '&hourly=precipitation&past_days=1&forecast_days=1&timezone=GMT';
  const json = await (await fetchWithTimeout(url, {}, 10000)).json();
  return json.hourly.time.map((t, k) => ({ t: Date.parse(`${t}:00Z`), mm: json.hourly.precipitation[k] ?? 0 }));
}

const NFHL = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer';
const NFHL_ZONES = 28;

export function femaTileLayer() {
  const Layer = L.TileLayer.extend({
    getTileUrl(coords) {
      const size = this.getTileSize();
      const nw = this._map.unproject(coords.scaleBy(size), coords.z);
      const se = this._map.unproject(coords.scaleBy(size).add(size), coords.z);
      const a = L.CRS.EPSG3857.project(nw);
      const b = L.CRS.EPSG3857.project(se);
      const bbox = [a.x, b.y, b.x, a.y].join(',');
      return `${NFHL}/export?bbox=${bbox}&bboxSR=3857&imageSR=3857&size=${size.x},${size.y}`
        + `&layers=show:${NFHL_ZONES}&format=png32&transparent=true&f=image`;
    },
  });
  return new Layer('', { opacity: 0.5, minZoom: 12, maxZoom: 20, attribution: 'Flood zones: FEMA' });
}

export async function femaZoneAt(lat, lng) {
  const url = `${NFHL}/${NFHL_ZONES}/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326`
    + '&spatialRel=esriSpatialRelIntersects&outFields=FLD_ZONE,ZONE_SUBTY,SFHA_TF&returnGeometry=false&f=json';
  const json = await (await fetchWithTimeout(url, {}, 9000)).json();
  if (json.error) throw new Error(json.error.message || 'FEMA query failed');
  const a = json.features && json.features[0] && json.features[0].attributes;
  if (!a) return { zone: null };
  return { zone: a.FLD_ZONE, subtype: a.ZONE_SUBTY || '', sfha: a.SFHA_TF === 'T' };
}

export function describeZone(z) {
  if (!z || !z.zone) return 'Outside FEMA-mapped flood zones';
  if (z.sfha || /^A|^V/.test(z.zone)) return `Zone ${z.zone}: 1% annual chance flood area (FEMA high risk)`;
  if (z.zone === 'X' && /0\.2/.test(z.subtype)) return 'Zone X (shaded): 0.2% annual chance flood area';
  if (z.zone === 'X') return 'Zone X: minimal flood hazard on FEMA maps';
  if (z.zone === 'D') return 'Zone D: flood hazard not determined';
  return `Zone ${z.zone}`;
}

const ROAD_TYPES = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|primary_link|secondary_link|tertiary_link';

export async function loadRoads(bounds) {
  const [[s, w], [n, e]] = bounds;
  const query = `[out:json][timeout:25];way["highway"~"^(${ROAD_TYPES})$"](${s},${w},${n},${e});out geom;`;
  const res = await fetchWithTimeout('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`,
  }, 25000);
  const json = await res.json();
  return (json.elements || [])
    .filter((el) => el.type === 'way' && Array.isArray(el.geometry))
    .map((el) => ({ name: (el.tags && el.tags.name) || '', points: el.geometry.map((p) => [p.lat, p.lon]) }));
}

export function rasterizeRoads(roads, grid) {
  const { w, h } = grid;
  const hit = new Int32Array(w * h).fill(-1);
  const mark = (x, y, r) => { if (x >= 0 && y >= 0 && x < w && y < h) hit[y * w + x] = r; };
  roads.forEach((road, r) => {
    let prev = null;
    for (const [lat, lng] of road.points) {
      const i = Math.floor((lngToPx(lng, grid.zoom) - grid.originPx) / grid.factor);
      const j = Math.floor((latToPx(lat, grid.zoom) - grid.originPy) / grid.factor);
      if (prev) {
        let [x0, y0] = prev;
        const dx = Math.abs(i - x0);
        const dy = -Math.abs(j - y0);
        const sx = x0 < i ? 1 : -1;
        const sy = y0 < j ? 1 : -1;
        let err = dx + dy;
        for (let guard = 0; guard < 100000; guard += 1) {
          mark(x0, y0, r);
          if (x0 === i && y0 === j) break;
          const e2 = 2 * err;
          if (e2 >= dy) { err += dy; x0 += sx; }
          if (e2 <= dx) { err += dx; y0 += sy; }
        }
      }
      prev = [i, j];
    }
  });
  const wide = Int32Array.from(hit);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (hit[y * w + x] < 0) continue;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && wide[ny * w + nx] < 0) wide[ny * w + nx] = hit[y * w + x];
        }
      }
    }
  }
  return wide;
}
